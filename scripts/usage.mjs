#!/usr/bin/env node
/**
 * claude-usage-monitor — core engine
 * Zero-dependency Node.js (>=18) script that parses Claude Code transcript
 * JSONL files (~/.claude/projects/**\/*.jsonl) and reports token usage, cost,
 * and 5-hour rate-limit block windows.
 *
 * Subcommands: today / daily / weekly / monthly / blocks / models / sessions /
 * projects / cache / limits / report / statusline — all accept --json.
 * Time windows: daily/weekly/monthly count natural local days; blocks/sessions/
 * projects use a rolling N*24h window ending now.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Pricing (USD per million tokens). Cache: 5m write = 1.25x input,
// 1h write = 2x input, cache read = 0.1x input.
// Source: Anthropic pricing, cached 2026-07.
// ---------------------------------------------------------------------------
const PRICING = {
  'claude-fable-5':    { input: 10, output: 50 },
  'claude-mythos-5':   { input: 10, output: 50 },
  'claude-opus-4-8':   { input: 5,  output: 25 },
  'claude-opus-4-7':   { input: 5,  output: 25 },
  'claude-opus-4-6':   { input: 5,  output: 25 },
  'claude-opus-4-5':   { input: 5,  output: 25 },
  'claude-opus-4-1':   { input: 15, output: 75 },
  'claude-opus-4-0':   { input: 15, output: 75 },
  'claude-opus-4':     { input: 15, output: 75 },
  // intro pricing $2/$10 through 2026-08-31, applied per entry timestamp
  'claude-sonnet-5':   { input: 3,  output: 15, intro: { until: '2026-09-01', input: 2, output: 10 } },
  'claude-sonnet-4-6': { input: 3,  output: 15 },
  'claude-sonnet-4-5': { input: 3,  output: 15 },
  'claude-sonnet-4-0': { input: 3,  output: 15 },
  'claude-sonnet-4':   { input: 3,  output: 15 },
  'claude-haiku-4-5':  { input: 1,  output: 5 },
  'claude-3-5-haiku':  { input: 0.8, output: 4 },
  'claude-3-haiku':    { input: 0.25, output: 1.25 },
};
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2.0;
const CACHE_READ = 0.1;

const BLOCK_HOURS = 5;
const BLOCK_MS = BLOCK_HOURS * 60 * 60 * 1000;

// Models we couldn't price (reported as a footnote instead of silently $0).
const unknownModels = new Set();

/** Normalize a raw model id (may carry [1m], -fast, date suffixes) to a pricing key. */
function resolvePricing(model) {
  if (!model) return null;
  const m = String(model).replace(/\[.*?\]$/, '').replace(/-fast$/, '').trim();
  if (PRICING[m]) return { key: m, ...PRICING[m] };
  // longest-prefix match handles dated ids like claude-haiku-4-5-20251001
  let best = null;
  for (const key of Object.keys(PRICING)) {
    if (m.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? { key: best, ...PRICING[best] } : null;
}

/** Intro-aware input price (USD per Mtok) for cache-savings math; null if unpriced. */
function inputPriceOf(model, ts = Date.now()) {
  const p = resolvePricing(model);
  if (!p) return null;
  return p.intro && ts < Date.parse(p.intro.until) ? p.intro.input : p.input;
}

/** Cost in USD for one usage record (ts enables date-scoped intro pricing). */
function costOf(model, u, ts = Date.now()) {
  let p = resolvePricing(model);
  if (!p) unknownModels.add(model);
  if (!p || !u) return 0;
  if (p.intro && ts < Date.parse(p.intro.until)) {
    p = { ...p, input: p.intro.input, output: p.intro.output };
  }
  const inTok = u.input_tokens || 0;
  const outTok = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cc = u.cache_creation || null;
  const w5 = cc ? (cc.ephemeral_5m_input_tokens || 0) : (u.cache_creation_input_tokens || 0);
  const w1 = cc ? (cc.ephemeral_1h_input_tokens || 0) : 0;
  return (
    inTok * p.input +
    outTok * p.output +
    cacheRead * p.input * CACHE_READ +
    w5 * p.input * CACHE_WRITE_5M +
    w1 * p.input * CACHE_WRITE_1H
  ) / 1e6;
}

// ---------------------------------------------------------------------------
// Data discovery & loading
// ---------------------------------------------------------------------------

/** Claude Code config roots (CLAUDE_CONFIG_DIR overrides the defaults, like ccusage). */
function configHomes() {
  if (process.env.CLAUDE_CONFIG_DIR) {
    return process.env.CLAUDE_CONFIG_DIR.split(/[;,]/).map(d => d.trim()).filter(Boolean);
  }
  return [path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.config', 'claude')];
}

/** Transcript roots (<config>/projects), existing dirs only. */
function dataDirs() {
  return [...new Set(configHomes().map(h => path.join(h, 'projects')))].filter(d => {
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  });
}

/** List transcript files, optionally only those modified at/after `sinceMs`. */
function transcriptFiles(sinceMs = 0) {
  const files = [];
  for (const root of dataDirs()) {
    let projects = [];
    try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const proj of projects) {
      if (!proj.isDirectory()) continue;
      const projDir = path.join(root, proj.name);
      let entries = [];
      try { entries = fs.readdirSync(projDir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const full = path.join(projDir, e.name);
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs >= sinceMs) files.push({ file: full, project: proj.name, mtimeMs: st.mtimeMs });
        } catch { /* ignore */ }
      }
    }
  }
  return files;
}

/** Fresh accumulator for tool-call statistics (see loadEntries toolSink). */
function newToolSink() {
  return { byName: new Map(), idName: new Map(), seenIds: new Set(), errSeen: new Set() };
}

/**
 * Collect tool_use / tool_result records into a tool sink.
 * Dedup is per tool_use id (streamed snapshots repeat whole messages).
 * sink.sinceMs bounds what is COUNTED; the id→name map is registered for
 * every line seen so cross-boundary errors still attribute to the real tool.
 */
function collectTools(sink, j, ts = 0) {
  const content = j.message?.content;
  if (!Array.isArray(content)) return;
  const since = sink.sinceMs || 0;
  const recOf = name => {
    let rec = sink.byName.get(name);
    if (!rec) sink.byName.set(name, rec = { count: 0, errors: 0 });
    return rec;
  };
  for (const c of content) {
    if (c?.type === 'tool_use' && c.id && !sink.seenIds.has(c.id)) {
      sink.seenIds.add(c.id);
      const name = c.name || '(未知)';
      sink.idName.set(c.id, name);
      if (ts >= since) {
        recOf(name).count += 1;
        // optional per-session ROI accounting (edit ops + touched files)
        if (sink.perSession) {
          const sid = j.sessionId || '?';
          let ps = sink.perSession.get(sid);
          if (!ps) sink.perSession.set(sid, ps = { ops: 0, edits: 0, files: new Map() });
          ps.ops += 1;
          if ((name === 'Edit' || name === 'Write' || name === 'NotebookEdit')
              && typeof c.input?.file_path === 'string') {
            ps.edits += 1;
            ps.files.set(c.input.file_path, (ps.files.get(c.input.file_path) || 0) + 1);
          }
        }
      }
    } else if (c?.type === 'tool_result' && c.is_error && c.tool_use_id
        && ts >= since && !sink.errSeen.has(c.tool_use_id)) {
      sink.errSeen.add(c.tool_use_id);
      recOf(sink.idName.get(c.tool_use_id) || '(未知)').errors += 1;
    }
  }
}

// Rate-limit notices are written into transcripts as API error messages like
// "Claude AI usage limit reached|1751749200" (epoch seconds after the pipe).
const LIMIT_EVENT_RE = /usage limit reached\|(\d{9,13})/i;

/**
 * Stream-parse transcripts into deduplicated usage entries.
 * Dedup key: message.id + requestId (streamed snapshots repeat both).
 * Returns [{ts, model, usage, cost, sessionId, project}].
 * Optional sinks filled as a side effect while streaming:
 *   toolSink (from newToolSink()) — tool_use/tool_result frequency;
 *   limitEvents (array) — {ts, resetTs} for official rate-limit hits.
 */
async function loadEntries({ sinceMs = 0, toolSink = null, limitEvents = null, apiErrors = null } = {}) {
  const seen = new Set();
  const entries = [];
  for (const { file, project } of transcriptFiles(sinceMs)) {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      // fast pre-filters: only parse lines a consumer actually needs
      const hasUsage = line.includes('"usage"');
      const mayLimit = limitEvents && line.includes('usage limit reached');
      const mayTool = toolSink && line.includes('"tool_'); // tool_use / tool_result
      const mayErr = apiErrors && line.includes('"isApiErrorMessage":true');
      if (!hasUsage && !mayLimit && !mayTool && !mayErr) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      const ts = Date.parse(j.timestamp);
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
      if (mayLimit && j.isApiErrorMessage) {
        const m = LIMIT_EVENT_RE.exec(typeof j.message?.content === 'string'
          ? j.message.content : JSON.stringify(j.message?.content ?? ''));
        if (m) {
          const t = Number(m[1]);
          limitEvents.push({ ts, resetTs: t > 1e12 ? t : t * 1000 });
        }
      }
      if (mayTool) collectTools(toolSink, j, ts);
      if (mayErr && j.isApiErrorMessage) {
        const txt = typeof j.message?.content === 'string'
          ? j.message.content : JSON.stringify(j.message?.content ?? '');
        apiErrors.push({ ts, text: txt.slice(0, 300) });
      }
      if (j.type !== 'assistant' || !j.message || !j.message.usage) continue;
      const u = j.message.usage;
      // dedup (ccusage-compatible): message.id+requestId when both exist,
      // message.id alone otherwise; entries without message.id are never deduped
      // (streamed snapshots repeat message.id, each line has a unique uuid).
      const mid = j.message.id;
      if (mid) {
        const key = j.requestId ? `${mid}:${j.requestId}` : mid;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      const model = j.message.model || 'unknown';
      if (model === '<synthetic>') continue; // internal placeholder rows
      entries.push({
        ts,
        model,
        usage: u,
        cost: typeof j.costUSD === 'number' ? j.costUSD : costOf(model, u, ts),
        sessionId: j.sessionId || path.basename(file, '.jsonl'),
        project,
      });
    }
  }
  entries.sort((a, b) => a.ts - b.ts);
  return entries;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function emptyAgg() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, count: 0 };
}

function addEntry(agg, e) {
  const u = e.usage;
  const cc = u.cache_creation;
  agg.input += u.input_tokens || 0;
  agg.output += u.output_tokens || 0;
  // keep the same field precedence as costOf so tokens and cost agree
  agg.cacheWrite += u.cache_creation_input_tokens
    ?? ((cc?.ephemeral_5m_input_tokens || 0) + (cc?.ephemeral_1h_input_tokens || 0));
  agg.cacheRead += u.cache_read_input_tokens || 0;
  agg.cost += e.cost;
  agg.count += 1;
  return agg;
}

/** Group entries by a key function into { key: agg }. */
function groupBy(entries, keyFn) {
  const map = new Map();
  for (const e of entries) {
    const k = keyFn(e);
    if (!map.has(k)) map.set(k, emptyAgg());
    addEntry(map.get(k), e);
  }
  return map;
}

/** Local date string YYYY-MM-DD for a timestamp. */
function localDate(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------------------------------------------------------------------------
// 5-hour rate-limit blocks (ccusage-compatible algorithm)
// A block starts at the first activity, floored to the UTC hour, and spans
// 5 hours. A new block begins when an entry falls past the block end, or
// after a gap of more than 5 hours since the previous entry.
// ---------------------------------------------------------------------------
function computeBlocks(entries) {
  const blocks = [];
  let cur = null;
  for (const e of entries) {
    const needNew =
      !cur ||
      e.ts >= cur.startMs + BLOCK_MS ||
      e.ts - cur.lastTs > BLOCK_MS;
    if (needNew) {
      const startMs = Math.floor(e.ts / 3600000) * 3600000; // floor to UTC hour
      cur = {
        startMs,
        endMs: startMs + BLOCK_MS,
        firstTs: e.ts,
        lastTs: e.ts,
        agg: emptyAgg(),
        models: new Map(),
      };
      blocks.push(cur);
    }
    cur.lastTs = e.ts;
    addEntry(cur.agg, e);
    if (!cur.models.has(e.model)) cur.models.set(e.model, emptyAgg());
    addEntry(cur.models.get(e.model), e);
  }
  const now = Date.now();
  for (const b of blocks) {
    b.active = now < b.endMs && now - b.lastTs <= BLOCK_MS;
    // burn rate over first→last entry (ccusage semantics);
    // a single-timestamp block has no meaningful rate
    const spanMin = (b.lastTs - b.firstTs) / 60000;
    if (spanMin >= 0.5) {
      b.tokensPerMin = (b.agg.input + b.agg.output) / spanMin;
      b.costPerHour = b.agg.cost / (spanMin / 60);
    } else {
      b.tokensPerMin = null;
      b.costPerHour = null;
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
// Claude Code renders ANSI in the statusline even though stdout is a pipe,
// so color is forced on there; elsewhere it follows TTY / NO_COLOR / FORCE_COLOR.
let colorEnabled = !process.env.NO_COLOR &&
  (process.stdout.isTTY || !!process.env.FORCE_COLOR);
// Narrow-terminal compact mode: --compact forces on, --wide forces off,
// otherwise auto-detected from the terminal width (columns unknown → wide).
let COMPACT = false;
const paint = code => s => (colorEnabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const C = {
  bold: paint(1), dim: paint(2),
  red: paint(31), green: paint(32), yellow: paint(33),
  magenta: paint(35), cyan: paint(36),
};

const stripAnsi = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');
// CJK/fullwidth chars and emoji occupy 2 terminal columns everywhere.
const WIDE = /[　ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦⏩-⏺☀-➿⬀-⯿\u{1F300}-\u{1FAFF}]/u;
// Ambiguous-width symbols: modern terminals (Windows Terminal / VS Code)
// render them 1 column, legacy CJK consoles render 2. Default 1; set
// {"display": {"ambiguous_wide": true}} in usage-monitor.json for legacy.
const AMBIG = /[◆◇●○◂▮…—]/u;
let _ambigW = null;
const ambigWidth = () => {
  if (_ambigW == null) {
    _ambigW = userConfig().display?.ambiguous_wide === true ? 2 : 1;
  }
  return _ambigW;
};
const dw = s => [...stripAnsi(s)].reduce((w, ch) =>
  w + (/\uFE0F/.test(ch) ? 0 : WIDE.test(ch) ? 2 : AMBIG.test(ch) ? ambigWidth() : 1), 0);

// ---------------------------------------------------------------------------
// Language: --lang > CLAUDE_USAGE_LANG > config display.lang > locale.
// Chinese locales default to zh (existing users unaffected); everything else
// defaults to en so the first npx run reads naturally worldwide.
// ---------------------------------------------------------------------------
let _lang = null;
function lang() {
  if (_lang) return _lang;
  const pick = v => (v === 'zh' || v === 'en' ? v : null);
  const i = process.argv.indexOf('--lang');
  let v = pick(i >= 0 ? process.argv[i + 1] : null)
    || pick(process.env.CLAUDE_USAGE_LANG)
    || pick(userConfig().display?.lang);
  if (!v) {
    let loc = process.env.LC_ALL || process.env.LANG || '';
    if (!loc) { try { loc = Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch { /* keep '' */ } }
    v = /zh|CN\b/i.test(loc) ? 'zh' : 'en';
  }
  return (_lang = v);
}
const L = (zh, en) => (lang() === 'zh' ? zh : en);

// Decorative emoji prefix. Some terminals draw emoji glyphs wider than their
// character cells and they visually cover the following text; setting
// {"display": {"emoji": false}} strips every decorative emoji for a pure-text
// interface. Warning states always rely on color, never on the emoji.
let _emojiOn = null;
function emo(sym) {
  if (_emojiOn == null) _emojiOn = userConfig().display?.emoji !== false;
  return _emojiOn ? sym + ' ' : '';
}
const padEndDW = (s, n) => s + ' '.repeat(Math.max(0, n - dw(s)));

/** Truncate to a display width, keeping the (more informative) tail. */
function fitDW(s, w) {
  if (dw(s) <= w) return s;
  const chars = [...String(s)];
  const tail = [];
  let acc = 1; // room for the leading '…'
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = dw(chars[i]);
    if (acc + cw > w) break;
    acc += cw;
    tail.push(chars[i]);
  }
  return '…' + tail.reverse().join('');
}

/**
 * Friendlier display for escaped project dir names (display only, JSON keeps
 * the raw name): the escaped home prefix becomes ~, runs of dashes (escaped
 * CJK/symbols) collapse to …
 *   C--Users-me-Desktop-----CropMind → ~\Desktop…CropMind
 */
function prettyProject(name) {
  let s = String(name);
  let homeEsc = '';
  try { homeEsc = (os.homedir() || '').replace(/[^A-Za-z0-9]/g, '-'); } catch { /* keep raw */ }
  if (homeEsc && s.startsWith(homeEsc)) s = '~' + s.slice(homeEsc.length);
  s = s.replace(/-{2,}/g, '…').replace(/^~-/, '~\\');
  return s || '~';
}

function fmtTok(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
const fmtUSD = n => {
  const a = Math.abs(n);
  return (n < 0 ? '-$' : '$') + a.toFixed(a >= 100 ? 0 : 2);
};
const shortModel = m => String(m).replace(/^claude-/, '').replace(/-\d{8}$/, '');

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const total = Math.max(1, Math.round(ms / 60000)); // whole minutes, no 1h60m
  const h = Math.floor(total / 60), m = total % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

function fmtLocal(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Render rows as a rounded box-drawing table. First row = header.
 * opts.aligns: per-column 'l'|'r' (default: first column left, rest right).
 * opts.footer: true → separator line before the last row (totals).
 */
function table(rows, opts = {}) {
  const nCol = Math.max(...rows.map(r => r.length));
  const aligns = opts.aligns || Array.from({ length: nCol }, (_, i) => (i === 0 ? 'l' : 'r'));
  const widths = [];
  for (const r of rows) r.forEach((c, i) => {
    widths[i] = Math.max(widths[i] || 0, dw(c));
  });
  const b = C.dim;
  const rule = (l, m, r) => b(l + widths.map(w => '─'.repeat(w + 2)).join(m) + r);
  const line = r => b('│') + widths.map((w, i) => {
    const cell = String(r[i] ?? '');
    const pad = ' '.repeat(Math.max(0, w - dw(cell)));
    return ' ' + (aligns[i] === 'r' ? pad + cell : cell + pad) + ' ';
  }).join(b('│')) + b('│');
  const out = [rule('╭', '┬', '╮'), line(rows[0].map(h => C.bold(h))), rule('├', '┼', '┤')];
  rows.slice(1).forEach((r, i) => {
    if (opts.footer && i === rows.length - 2 && rows.length > 2) out.push(rule('├', '┼', '┤'));
    out.push(line(r));
  });
  out.push(rule('╰', '┴', '╯'));
  return out.join('\n');
}

/** One-line sparkline from a numeric series. */
function sparkline(values) {
  const levels = '▁▂▃▄▅▆▇█';
  const max = Math.max(...values, 1e-9);
  return values.map(v => levels[Math.min(7, Math.floor(v / max * 7.99))]).join('');
}

/** Smooth progress bar (eighth-block resolution) with threshold coloring. */
function progressBar(pct, width = COMPACT ? 12 : 20) {
  const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const color = p >= 90 ? C.red : p >= 70 ? C.yellow : C.green;
  const eighths = Math.round(p / 100 * width * 8);
  const full = Math.min(width, Math.floor(eighths / 8));
  const frac = full < width ? eighths % 8 : 0;
  const FRAC = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
  const bar = '█'.repeat(full) + FRAC[frac];
  return color(bar) + C.dim('░'.repeat(width - full - (frac ? 1 : 0)));
}

function header(title) {
  console.log(C.bold(C.cyan(`◆ ${title}`)) + '\n');
}

/** Dashboard section header: bold title + dim rule to a uniform width. */
function section(title, note = '') {
  const rule = Math.max(4, 46 - dw(title + note));
  console.log('\n' + C.bold(title) + (note ? C.dim(note) : '') + ' ' + C.dim('─'.repeat(rule)));
}

/** Shared footnotes (unpriced models etc.) appended to reports. */
function footnotes() {
  if (unknownModels.size) {
    console.log('\n' + C.yellow(emo('⚠') + L(
      `以下模型不在价格表中，成本按$0计：${[...unknownModels].join('、')}`,
      `Models missing from the price table (counted as $0): ${[...unknownModels].join(', ')}`)));
  }
}

function modelTable(map, { withCount = false } = {}) {
  const head = COMPACT
    ? [L('模型', 'Model'), L('输入', 'In'), L('输出', 'Out'), L('成本', 'Cost'), L('占比', 'Share')]
    : [L('模型', 'Model'), L('输入', 'Input'), L('输出', 'Output'),
      L('缓存写', 'CacheW'), L('缓存读', 'CacheR'), L('成本', 'Cost'), L('占比', 'Share')];
  if (withCount && !COMPACT) head.push(L('请求数', 'Reqs'));
  const rows = [head];
  const sorted = [...map.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const total = emptyAgg();
  for (const [, a] of sorted) {
    for (const k of ['input', 'output', 'cacheWrite', 'cacheRead', 'cost', 'count']) total[k] += a[k];
  }
  for (const [model, a] of sorted) {
    const share = total.cost > 0 ? Math.round(a.cost / total.cost * 100) : 0;
    const row = COMPACT
      ? [shortModel(model), fmtTok(a.input), fmtTok(a.output), fmtUSD(a.cost), C.dim(share + '%')]
      : [shortModel(model), fmtTok(a.input), fmtTok(a.output),
        fmtTok(a.cacheWrite), fmtTok(a.cacheRead), fmtUSD(a.cost), C.dim(share + '%')];
    if (withCount && !COMPACT) row.push(String(a.count));
    rows.push(row);
  }
  const hasFooter = sorted.length > 1;
  if (hasFooter) {
    const totalLbl = C.bold(L('合计', 'Total'));
    const row = COMPACT
      ? [totalLbl, fmtTok(total.input), fmtTok(total.output), C.bold(fmtUSD(total.cost)), '']
      : [totalLbl, fmtTok(total.input), fmtTok(total.output),
        fmtTok(total.cacheWrite), fmtTok(total.cacheRead), C.bold(fmtUSD(total.cost)), ''];
    if (withCount && !COMPACT) row.push(String(total.count));
    rows.push(row);
  }
  return table(rows, { footer: hasFooter });
}

const aggJson = a => ({
  input_tokens: a.input, output_tokens: a.output,
  cache_write_tokens: a.cacheWrite, cache_read_tokens: a.cacheRead,
  cost_usd: +a.cost.toFixed(4), requests: a.count,
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdToday(opts) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const now = Date.now();
  const y0 = start.getTime() - 86400000;
  const entries = await loadEntries({ sinceMs: y0 }); // today + yesterday (for同期对比)
  const todayEntries = entries.filter(e => e.ts >= start.getTime());
  const byModel = groupBy(todayEntries, e => e.model);
  const todayCost = todayEntries.reduce((s, e) => s + e.cost, 0);
  const ySoFar = entries.reduce((s, e) =>
    s + (e.ts >= y0 && e.ts < y0 + (now - start.getTime()) ? e.cost : 0), 0);
  if (opts.json) {
    return out({
      date: localDate(now), yesterday_same_time_usd: +ySoFar.toFixed(2),
      models: mapJson(byModel), total: totalJson(byModel),
    });
  }
  header(L(`今日用量（${localDate(now)}）`, `Today's usage (${localDate(now)})`));
  if (!todayEntries.length) {
    console.log(C.dim(L('今天还没有用量记录。', 'No usage recorded today yet.')));
    return footnotes();
  }
  console.log(modelTable(byModel, { withCount: true }));
  // hourly cost sparkline (midnight → current hour) + same-time-yesterday delta
  const curHour = new Date().getHours();
  const buckets = Array(curHour + 1).fill(0);
  for (const e of todayEntries) {
    const h = new Date(e.ts).getHours();
    if (h < buckets.length) buckets[h] += e.cost; // guard: clock may cross midnight mid-run
  }
  let cmp = '';
  if (ySoFar >= 0.5) {
    const d = Math.round((todayCost - ySoFar) / ySoFar * 100);
    if (d !== 0) {
      cmp = C.dim(L('　较昨日此时', '  vs yesterday ')) + (d > 0 ? C.red(`↑${d}%`) : C.green(`↓${-d}%`));
    }
  }
  console.log(`\n${C.bold(L('分时', 'Hourly'))} ${C.cyan(sparkline(buckets))} ` +
    C.dim(L(`0时→${curHour}时，峰值${fmtUSD(Math.max(...buckets))}`,
      `00:00→${curHour}:00, peak ${fmtUSD(Math.max(...buckets))}`)) + cmp);
  footnotes();
}

async function cmdDaily(opts) {
  const days = posInt(opts.days, 7);
  const byDay = await dayAggregates(days); // live JSONL + history snapshots
  const dates = [...byDay.keys()].sort();
  if (opts.csv) return outCsv(dates.map(d => ({ date: d, ...aggJson(byDay.get(d).agg) })));
  if (opts.json) {
    return out(dates.map(d => ({
      date: d, ...aggJson(byDay.get(d).agg), models: mapJson(byDay.get(d).models),
    })));
  }
  header(`最近${days}天用量`);
  if (!dates.length) return console.log(C.dim('该时间段内没有用量记录。'));
  const rows = [COMPACT
    ? ['日期', '输入', '输出', '成本', '主要模型']
    : ['日期', '输入', '输出', '缓存写', '缓存读', '成本', '主要模型']];
  const total = emptyAgg();
  for (const d of dates) {
    const { agg, models } = byDay.get(d);
    const top = [...models.entries()].sort((a, b) => b[1].cost - a[1].cost)[0];
    const wd = new Date(d + 'T00:00:00').getDay();
    const wdMark = (wd === 0 || wd === 6 ? C.yellow : C.dim)('周' + '日一二三四五六'[wd]);
    const dateCell = `${d} ${wdMark}`;
    const topModel = shortModel(top?.[0] || '');
    rows.push(COMPACT
      ? [dateCell, fmtTok(agg.input), fmtTok(agg.output), fmtUSD(agg.cost), topModel]
      : [dateCell, fmtTok(agg.input), fmtTok(agg.output), fmtTok(agg.cacheWrite),
        fmtTok(agg.cacheRead), fmtUSD(agg.cost), topModel]);
    for (const k of ['input', 'output', 'cacheWrite', 'cacheRead', 'cost']) total[k] += agg[k];
  }
  rows.push(COMPACT
    ? [C.bold('合计'), fmtTok(total.input), fmtTok(total.output), C.bold(fmtUSD(total.cost)), '']
    : [C.bold('合计'), fmtTok(total.input), fmtTok(total.output),
      fmtTok(total.cacheWrite), fmtTok(total.cacheRead), C.bold(fmtUSD(total.cost)), '']);
  console.log(table(rows, {
    footer: true,
    aligns: COMPACT ? ['l', 'r', 'r', 'r', 'l'] : ['l', 'r', 'r', 'r', 'r', 'r', 'l'],
  }));
  // cost trend sparkline over the full requested range (missing days = 0)
  const allDays = [];
  const s = new Date(); s.setHours(0, 0, 0, 0); s.setDate(s.getDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const d = new Date(s); d.setDate(s.getDate() + i);
    allDays.push(byDay.get(localDate(d.getTime()))?.agg.cost || 0);
  }
  console.log(`\n${C.bold('趋势')} ${C.cyan(sparkline(allDays))} ` +
    C.dim(`日均${fmtUSD(total.cost / Math.max(1, dates.length))}`));
  footnotes();
}

async function cmdModels(opts) {
  const days = posInt(opts.days, 0);
  const entries = await loadEntries({ sinceMs: days ? Date.now() - days * 86400000 : 0 });
  const byModel = groupBy(entries, e => e.model);
  if (opts.csv) {
    return outCsv([...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost)
      .map(([m, a]) => ({ model: m, ...aggJson(a) })));
  }
  if (opts.json) return out({ models: mapJson(byModel), total: totalJson(byModel) });
  header(days ? `按模型汇总（最近${days}天）` : '全部历史按模型汇总');
  console.log(entries.length ? modelTable(byModel, { withCount: true }) : C.dim('没有用量记录。'));
  footnotes();
}

/**
 * Best-effort task title for a session: the first real user message
 * (skipping slash-command scaffolding and system reminders), compressed.
 */
async function sessionTitle(file, maxLen = 40) {
  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    let scanned = 0;
    for await (const line of rl) {
      if (++scanned > 120) break;
      if (!line.includes('"type":"user"')) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.type !== 'user' || j.isMeta) continue;
      const c = j.message?.content;
      let text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter(x => x?.type === 'text').map(x => x.text).join(' ') : '';
      if (!text) continue;
      // strip command scaffolding / reminders, keep the human ask
      text = text.replace(/<command-[^>]*>[\s\S]*?<\/command-[^>]*>/g, ' ')
        .replace(/<local-command[\s\S]*?<\/local-command[^>]*>/g, ' ')
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
        .replace(/<[^>]{1,60}>/g, ' ')
        // user text may carry emoji / control chars — they break table cells
        // on emoji-overflow terminals, so titles are always plain text
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{FE0F}\u{200D}\x00-\x1f]/gu, '')
        .replace(/\s+/g, ' ').trim();
      if (!text || text.startsWith('Caveat:')
        || text.startsWith('This session is being continued')) continue;
      rl.close();
      // head-truncate to display width (the ask's beginning carries the intent)
      let outStr = '', acc = 0;
      for (const ch of text) {
        const cw = dw(ch);
        if (acc + cw > maxLen - 1) { outStr += '…'; break; }
        outStr += ch; acc += cw;
      }
      return outStr || null;
    }
  } catch { /* unreadable */ }
  return null;
}

async function cmdSessions(opts) {
  const top = posInt(opts.top, 10);
  const days = posInt(opts.days, 0);
  const sinceMs = days ? Date.now() - days * 86400000 : 0;
  const entries = await loadEntries({ sinceMs });
  const bySession = new Map();
  for (const e of entries) {
    if (!bySession.has(e.sessionId)) {
      bySession.set(e.sessionId, { agg: emptyAgg(), project: e.project, firstTs: e.ts, lastTs: e.ts });
    }
    const s = bySession.get(e.sessionId);
    addEntry(s.agg, e);
    s.lastTs = Math.max(s.lastTs, e.ts);
  }
  const sorted = [...bySession.entries()].sort((a, b) => b[1].agg.cost - a[1].agg.cost).slice(0, top);
  // resolve transcript file per session to extract a human task title
  const fileOf = new Map();
  for (const f of transcriptFiles(sinceMs)) fileOf.set(path.basename(f.file, '.jsonl'), f.file);
  const titleW = COMPACT ? 22 : 34;
  const titles = new Map();
  for (const [id] of sorted) {
    const f = fileOf.get(id);
    titles.set(id, f ? await sessionTitle(f, titleW) : null);
  }
  const flat = () => sorted.map(([id, s]) => ({
    session_id: id, title: titles.get(id) || null, project: s.project,
    start: new Date(s.firstTs).toISOString(), end: new Date(s.lastTs).toISOString(),
    ...aggJson(s.agg),
  }));
  if (opts.csv) return outCsv(flat());
  if (opts.json) return out(flat());
  header(`会话排行 Top ${sorted.length}（按成本）`);
  const rows = [COMPACT
    ? ['日期', '任务', '成本', '时长']
    : ['日期', '任务', '项目', '成本', '时长', '请求数']];
  for (const [id, s] of sorted) {
    const dur = C.dim(fmtDuration(s.lastTs - s.firstTs));
    const title = titles.get(id) || C.dim('（无标题）');
    const proj = fitDW(prettyProject(s.project), 16);
    rows.push(COMPACT
      ? [localDate(s.firstTs), title, fmtUSD(s.agg.cost), dur]
      : [localDate(s.firstTs), title, proj, fmtUSD(s.agg.cost), dur, String(s.agg.count)]);
  }
  console.log(sorted.length
    ? table(rows, { aligns: COMPACT ? ['l', 'l', 'r', 'r'] : ['l', 'l', 'l', 'r', 'r', 'r'] })
    : C.dim('没有会话记录。'));
  footnotes();
}

/**
 * Attach official rate-limit hit events to the block windows they fall in.
 * Lower bound is firstTs (not the floored startMs) so an event from the
 * previous official window can't be pinned onto a fresh block; hits are
 * sorted by time so [length-1] is always the latest one.
 */
function markLimitHits(blocks, limitEvents) {
  const sorted = [...limitEvents].sort((a, b) => a.ts - b.ts);
  for (const b of blocks) {
    b.limitHits = sorted.filter(ev => ev.ts >= b.firstTs && ev.ts < b.endMs);
  }
}

async function cmdBlocks(opts) {
  const days = posInt(opts.days, 3);
  const cutoff = Date.now() - days * 86400000;
  // load one extra window + flooring margin so the oldest block isn't split mid-window
  const limitEvents = [];
  const entries = await loadEntries({ sinceMs: cutoff - BLOCK_MS - 3600000, limitEvents });
  const blocks = computeBlocks(entries).filter(b => b.endMs >= cutoff);
  markLimitHits(blocks, limitEvents);
  const now = Date.now();
  if (opts.json) {
    return out(blocks.map(b => blockJson(b, now)));
  }
  header(L(`5小时限额窗口（最近${days}天）`, `5-hour billing windows (last ${days}d)`));
  if (!blocks.length) return console.log(C.dim(L('没有用量记录。', 'No usage recorded.')));
  const rows = [[L('窗口', 'Window'), L('状态', 'Status'), L('输入', 'Input'), L('输出', 'Output'),
    L('成本', 'Cost'), L('燃烧率', 'Burn'), L('刷新时间', 'Resets')]];
  for (const b of blocks) {
    const label = `${localDate(b.startMs)} ${fmtLocal(b.startMs)}~${fmtLocal(b.endMs)}`;
    const dur = fmtDuration((b.active ? now : b.lastTs) - b.startMs);
    const hit = b.limitHits.length > 0;
    // plain colored text only — emoji inside table cells overflow their
    // measured width on some Windows terminals and break the borders
    const status = hit ? C.red(L(`触顶(${dur})`, `limit hit (${dur})`))
      : b.active ? C.green(L(`进行中(${dur})`, `active (${dur})`)) : C.dim(L(`已结束 ${dur}`, `ended ${dur}`));
    // an official hit carries the authoritative reset time — prefer it
    const hitReset = hit ? b.limitHits[b.limitHits.length - 1].resetTs : NaN;
    const reset = hit && Number.isFinite(hitReset)
      ? C.red(`${fmtLocal(hitReset)}${L('(官方)', ' (official)')}`)
      : b.active
        ? C.yellow(`${fmtLocal(b.endMs)}${L(`(剩${fmtDuration(b.endMs - now)})`, ` (${fmtDuration(b.endMs - now)} left)`)}`)
        : fmtLocal(b.endMs);
    rows.push([label, status, fmtTok(b.agg.input), fmtTok(b.agg.output),
      fmtUSD(b.agg.cost), b.tokensPerMin == null ? C.dim('—') : `${fmtTok(b.tokensPerMin)}/min`, reset]);
  }
  console.log(table(rows, { aligns: ['l', 'l', 'r', 'r', 'r', 'r', 'r'] }));
  const active = blocks.find(b => b.active);
  if (active) {
    const elapsedPct = Math.min(100, Math.round((now - active.startMs) / BLOCK_MS * 100));
    console.log('\n' + C.bold(L('当前窗口 ', 'Current window ')) + progressBar(elapsedPct) +
      L(` 时间已过${elapsedPct}%，${C.yellow(fmtLocal(active.endMs))}刷新`,
        ` ${elapsedPct}% elapsed, resets ${C.yellow(fmtLocal(active.endMs))}`));
    if (active.tokensPerMin != null) {
      const remainMin = Math.max(0, (active.endMs - now) / 60000);
      const projTok = active.agg.input + active.agg.output + active.tokensPerMin * remainMin;
      const projCost = active.agg.cost + (active.costPerHour / 60) * remainMin;
      console.log(C.dim(emo('🔥') + L(
        `燃烧率${fmtTok(active.tokensPerMin)}tok/min　${emo('📊')}按当前速度到刷新时约${fmtTok(projTok)}tok、${fmtUSD(projCost)}`,
        `burn ${fmtTok(active.tokensPerMin)} tok/min  ${emo('📊')}projected by reset: ~${fmtTok(projTok)} tok, ${fmtUSD(projCost)}`)));
    }
    console.log('\n' + C.bold(L('当前窗口模型分布：', 'Current window by model:')));
    console.log(modelTable(active.models));
  }
  footnotes();
}

function blockJson(b, now = Date.now()) {
  return {
    start: new Date(b.startMs).toISOString(),
    end: new Date(b.endMs).toISOString(),
    active: b.active,
    remaining_minutes: b.active ? Math.round((b.endMs - now) / 60000) : 0,
    tokens_per_minute: b.tokensPerMin == null ? null : Math.round(b.tokensPerMin),
    cost_per_hour_usd: b.costPerHour == null ? null : +b.costPerHour.toFixed(2),
    limit_reached: (b.limitHits || []).length > 0,
    limit_resets_at: b.limitHits?.length
      ? new Date(b.limitHits[b.limitHits.length - 1].resetTs).toISOString() : null,
    ...aggJson(b.agg),
    models: mapJson(b.models),
  };
}

const mapJson = map => Object.fromEntries([...map.entries()].map(([k, a]) => [k, aggJson(a)]));

// ---------------------------------------------------------------------------
// CSV output (--csv): flat objects → RFC4180-ish CSV on stdout.
// ---------------------------------------------------------------------------
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function outCsv(rows) {
  if (!rows.length) return console.log('');
  const cols = Object.keys(rows[0]);
  console.log(cols.join(','));
  for (const r of rows) console.log(cols.map(c => csvEscape(r[c])).join(','));
}
function totalJson(map) {
  const t = emptyAgg();
  for (const a of map.values()) for (const k of Object.keys(t)) t[k] += a[k];
  return aggJson(t);
}
const out = o => console.log(JSON.stringify(o, null, 2));

// ---------------------------------------------------------------------------
// Caching plumbing (per user + config-dir set, atomic writes)
// ---------------------------------------------------------------------------
function cacheFile(name) {
  let user = 'u';
  try { user = os.userInfo().username; } catch { /* keep default */ }
  const id = crypto.createHash('md5')
    .update(user + '|' + configHomes().join(',')).digest('hex').slice(0, 8);
  return path.join(os.tmpdir(), `claude-usage-monitor-${name}-${id}.json`);
}

function writeCacheAtomic(file, data) {
  try { writeAtomicThrow(file, JSON.stringify(data)); } catch { /* best effort */ }
}

/** Atomic write that surfaces errors and never leaves a .tmp file behind. */
function writeAtomicThrow(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

/** Parse a cache file; returns a plain object or null (never throws). */
function readJsonObject(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Official quota via the Claude Code OAuth usage endpoint
// (subscription accounts only; API-key users fall back to local estimates).
// ---------------------------------------------------------------------------
const LIMITS_CACHE_TTL_MS = 180_000;

function oauthToken() {
  for (const h of [...configHomes(), path.join(os.homedir(), '.claude')]) {
    try {
      const cred = JSON.parse(fs.readFileSync(path.join(h, '.credentials.json'), 'utf8'));
      const t = cred?.claudeAiOauth?.accessToken;
      if (t) return t;
    } catch { /* try next home */ }
  }
  return null;
}

async function fetchOfficialUsage() {
  const file = cacheFile('limits');
  const now = Date.now();
  const c = readJsonObject(file);
  if (c && typeof c.fetchedAt === 'number') {
    if (c.data && now - c.fetchedAt < LIMITS_CACHE_TTL_MS) return c.data;
    if (c.error && now < (c.retryUntil || 0)) return { error: c.error }; // back off
  }
  const token = oauthToken();
  if (!token) return { error: 'no-credentials' };
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const retryAfter = Math.min(600, Number(res.headers.get('retry-after')) || 30);
      writeCacheAtomic(file, { fetchedAt: now, error: `http-${res.status}`, retryUntil: now + retryAfter * 1000 });
      return { error: `http-${res.status}` };
    }
    const data = await res.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'bad-response' };
    writeCacheAtomic(file, { fetchedAt: now, data });
    return data;
  } catch {
    writeCacheAtomic(file, { fetchedAt: now, error: 'network', retryUntil: now + 30_000 });
    return { error: 'network' };
  }
}

/** resets_at arrives as epoch seconds, epoch ms, or an ISO string. */
function parseResetTs(v) {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') return Date.parse(v);
  return NaN;
}

function limitRow(label, pct, resetsAt, severity) {
  if (!Number.isFinite(pct)) return null;
  const p = Math.max(0, Math.round(pct));
  const color = (severity && severity !== 'normal') || p >= 90 ? C.red
    : p >= 70 ? C.yellow : C.green;
  let reset = '';
  const t = parseResetTs(resetsAt);
  if (Number.isFinite(t)) {
    reset = L(`　${fmtResetAt(t)}刷新（剩${fmtDuration(t - Date.now())}）`,
      `  resets ${fmtResetAt(t)} (${fmtDuration(t - Date.now())} left)`);
  }
  return `${padEndDW(label, 13)} ${progressBar(p)} ${color(String(Math.min(999, p)).padStart(3) + '%')}${reset}`;
}

/** Human name for one entry of the official limits[] array. */
function limitName(l) {
  if (l.kind === 'session') return L('5小时窗口', '5h window');
  if (l.kind === 'weekly_all') return L('7天全部', '7d all');
  if (l.kind === 'weekly_scoped') {
    const scope = l.scope?.model?.display_name || l.scope?.surface || L('专项', 'scoped');
    return L(`7天${scope}`, `7d ${scope}`);
  }
  return String(l.kind || L('窗口', 'window'));
}

/** Normalized official windows: [{name, pct, resetTs, severity, active}]. */
function limitEntries(data) {
  const outArr = [];
  if (Array.isArray(data.limits) && data.limits.length) {
    for (const l of data.limits) {
      if (!Number.isFinite(l?.percent)) continue;
      outArr.push({
        name: limitName(l), pct: l.percent, resetTs: parseResetTs(l.resets_at),
        severity: l.severity ?? null, active: !!l.is_active,
        fiveHour: l.kind === 'session',
      });
    }
  } else {
    for (const [name, w, fiveHour] of [
      ['5小时窗口', data.five_hour, true], ['7天窗口', data.seven_day, false],
      ['7天Sonnet', data.seven_day_sonnet, false], ['7天Opus', data.seven_day_opus, false],
    ]) {
      if (w && typeof w.utilization === 'number') {
        outArr.push({
          name, pct: w.utilization, resetTs: parseResetTs(w.resets_at),
          severity: null, active: false, fiveHour,
        });
      }
    }
  }
  return outArr;
}

/** Rendered official-limit lines (shared by limits and the dashboard). */
function officialLimitLines(data) {
  const lines = [];
  for (const l of limitEntries(data)) {
    const row = limitRow(l.name, l.pct, l.resetTs, l.severity);
    if (row) lines.push(row + (l.active ? C.dim(L('　◂当前计费窗口', '  ◂ current billing window')) : ''));
  }
  return lines;
}

/**
 * Projected time-to-limit for the official 5h window: assumes the observed
 * average pct/min since the window opened continues. Needs ≥15min of window
 * age and ≥10% usage to have any signal.
 */
function fiveHourEtaLine(data, now = Date.now()) {
  const l = limitEntries(data).find(x => x.fiveHour);
  if (!l || !Number.isFinite(l.resetTs) || l.pct >= 100 || l.pct < 10) return null;
  if (now >= l.resetTs) return null; // cached data from an already-reset window
  const elapsedMin = (now - (l.resetTs - BLOCK_MS)) / 60000;
  if (elapsedMin < 15) return null;
  const rate = l.pct / elapsedMin; // pct per minute
  if (!(rate > 0)) return null;
  const etaTs = now + (100 - l.pct) / rate * 60000;
  if (etaTs < l.resetTs) {
    return C.red(emo('⚠') + L(
      `按当前速度约${fmtLocal(etaTs)}触顶（早于${fmtLocal(l.resetTs)}刷新），建议放缓`,
      `At current pace you hit the limit ~${fmtLocal(etaTs)} (before the ${fmtLocal(l.resetTs)} reset) — slow down`));
  }
  const projPct = Math.round(l.pct + rate * (l.resetTs - now) / 60000);
  return C.dim(L(`按当前速度到刷新时约${projPct}%，不会触顶`,
    `At current pace ~${projPct}% by reset — you won't hit the limit`));
}

function fmtResetAt(ts) {
  const today = localDate(Date.now());
  const day = localDate(ts);
  const hm = fmtLocal(ts);
  if (day === today) return L(`今天${hm}`, `today ${hm}`);
  const tomorrow = localDate(Date.now() + 86400000);
  if (day === tomorrow) return L(`明天${hm}`, `tomorrow ${hm}`);
  return `${day.slice(5)} ${hm}`;
}

/**
 * Machine-readable check code for scripts/hooks (limits --check):
 * 0 = normal, 10 = approaching a limit (≥80%), 11 = limit reached (≥100%
 * or the API reports a non-normal blocking severity).
 */
function limitCheckCode(data) {
  const pcts = [];
  let blocked = false;
  if (Array.isArray(data.limits) && data.limits.length) {
    for (const l of data.limits) {
      if (Number.isFinite(l?.percent)) pcts.push(l.percent);
      if (typeof l?.severity === 'string' && /exceed|reject|block/i.test(l.severity)) blocked = true;
    }
  } else {
    for (const w of [data.five_hour, data.seven_day, data.seven_day_sonnet, data.seven_day_opus]) {
      if (w && typeof w.utilization === 'number') pcts.push(w.utilization);
    }
  }
  const max = Math.max(-1, ...pcts);
  if (blocked || max >= 100) return 11;
  if (max >= 80) return 10;
  return 0;
}

async function cmdLimits(opts) {
  const data = await fetchOfficialUsage();
  if (opts.check && data.error) process.exitCode = 1;
  else if (opts.check) process.exitCode = limitCheckCode(data);
  if (opts.json) return out(data);
  if (data.error === 'no-credentials') {
    console.log(C.dim(L('未找到订阅凭据（.credentials.json），此命令仅适用于Pro/Max订阅账号。',
      'No subscription credentials found (.credentials.json) — this command needs a Pro/Max account.')));
    console.log(C.dim(L('API Key用户请改用blocks命令查看本地估算的5小时窗口。',
      'API-key users: run the blocks command for locally estimated 5h windows.')));
    return;
  }
  if (data.error) {
    console.log(C.red(L(`查询官方配额失败（${data.error}），请稍后重试。`,
      `Failed to query official limits (${data.error}) — try again later.`)));
    return;
  }
  header(L('官方限额利用率（Anthropic实时数据）', 'Official rate limits (live from Anthropic)'));
  const lines = officialLimitLines(data);
  console.log(lines.length ? lines.join('\n')
    : C.dim(L('接口未返回任何限额窗口数据。', 'The endpoint returned no limit windows.')));
  const eta = fiveHourEtaLine(data);
  if (eta) console.log(eta);
  const extra = data.extra_usage;
  if (extra && extra.is_enabled) {
    console.log('\n' + C.bold(L('额外用量（超额付费）：', 'Extra usage (overage): ')) +
      L(` 已用${extra.used_credits ?? 0}/${extra.monthly_limit ?? '?'} `,
        ` used ${extra.used_credits ?? 0}/${extra.monthly_limit ?? '?'} `) +
      C.dim(`（${extra.currency || 'USD'}）`));
  }
  if (opts.check) {
    const code = process.exitCode;
    const word = code === 11 ? C.red(L('已达限额', 'limit reached'))
      : code === 10 ? C.yellow(L('接近限额', 'approaching limit')) : C.green(L('正常', 'ok'));
    console.log('\n' + C.dim(L('检查结果：', 'Check: ')) + word + C.dim(L(`（退出码${code}）`, ` (exit ${code})`)));
  }
}

// ---------------------------------------------------------------------------
// Statusline
// Claude Code pipes a JSON payload on stdin (model, workspace, cost,
// context_window, rate_limits, ...). Official rate_limits (Pro/Max) are
// preferred for the 5h window; JSONL parsing supplies today-cost and the
// block cost. A 30s file cache avoids re-parsing transcripts on every refresh.
// ---------------------------------------------------------------------------
const STATUS_CACHE_TTL_MS = 30_000;
// Block boundaries depend on the activity chain since the last >5h gap, so the
// statusline looks back 48h (ccstatusline uses the same bound) — enough unless
// usage continues gap-free for 2+ days, in which case the boundary may drift.
const STATUS_LOOKBACK_MS = 48 * 3600000;

function validStatus(o) {
  if (!o || !Number.isFinite(o.todayCost)) return null;
  if (o.block != null) {
    const b = o.block;
    if (!Number.isFinite(b.startMs) || !Number.isFinite(b.endMs) || !Number.isFinite(b.cost)) return null;
  }
  return o;
}

async function localStatus() {
  const file = cacheFile('status');
  const c = readJsonObject(file);
  if (c && typeof c.at === 'number' && Date.now() - c.at < STATUS_CACHE_TTL_MS) {
    const v = validStatus(c.status);
    if (v) return v;
  }
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const mon = new Date(midnight); mon.setDate(mon.getDate() - (mon.getDay() + 6) % 7);
  const sinceMs = Math.min(mon.getTime(), midnight.getTime(), Date.now() - STATUS_LOOKBACK_MS);
  const entries = await loadEntries({ sinceMs });
  const todayCost = entries.reduce((s, e) => s + (e.ts >= midnight.getTime() ? e.cost : 0), 0);
  const weekCost = entries.reduce((s, e) => s + (e.ts >= mon.getTime() ? e.cost : 0), 0);
  const blocks = computeBlocks(entries);
  const active = blocks.find(b => b.active);
  // personal burn baseline: P90 of this week's window burn rates
  const burns = blocks.map(b => b.tokensPerMin).filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  const burnP90 = burns.length >= 3 ? burns[Math.floor(burns.length * 0.9)] : null;
  const status = {
    todayCost,
    weekCost,
    burnP90,
    block: active
      ? {
          startMs: active.startMs,
          endMs: active.endMs,
          cost: active.agg.cost,
          tokensPerMin: active.tokensPerMin,
        }
      : null,
  };
  writeCacheAtomic(file, { at: Date.now(), status });
  return status;
}

async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  const read = (async () => {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data.trim() ? JSON.parse(data) : {};
  })();
  // Claude Code pipes the payload immediately; guard against an open
  // but silent stdin (e.g. manual invocation) hanging the statusline.
  const timeout = new Promise(res => setTimeout(res, 1000, {}).unref?.());
  try { return await Promise.race([read, timeout]) || {}; }
  catch { return {}; }
  finally { try { process.stdin.destroy(); } catch { /* already closed */ } }
}

/**
 * Optional user config (~/.claude/usage-monitor.json):
 * {
 *   "daily_budget_usd": 50,
 *   "statusline": {
 *     "segments": ["model", "cost", "budget", "5h", "7d", "ctx", "burn"],
 *     "separator": " | ",
 *     "warn_pct": 50, "danger_pct": 80
 *   }
 * }
 */
function userConfig() {
  for (const h of configHomes()) {
    const o = readJsonObject(path.join(h, 'usage-monitor.json'));
    if (o) return o;
  }
  return {};
}

const STATUS_SEGMENTS = ['model', 'cost', 'week', 'budget', '5h', '7d', 'ctx', 'burn', 'eta'];
// week is opt-in (statusline space is precious); everything else is on by default
const DEFAULT_STATUS_SEGMENTS = ['model', 'cost', 'budget', '5h', '7d', 'ctx', 'burn', 'eta'];

/** Validated statusline config with defaults (bad values fall back silently). */
function statuslineConfig() {
  const raw = userConfig().statusline;
  const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let segments = Array.isArray(cfg.segments)
    ? cfg.segments.filter(s => STATUS_SEGMENTS.includes(s)) : [];
  if (!segments.length) segments = DEFAULT_STATUS_SEGMENTS;
  const separator = typeof cfg.separator === 'string' && cfg.separator.length ? cfg.separator : ' | ';
  // only accept actual numbers in [0,100] — Number(null/''/false) would coerce to 0
  const pctOpt = (v, def) =>
    (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : def);
  let warn = pctOpt(cfg.warn_pct, 50), danger = pctOpt(cfg.danger_pct, 80);
  if (warn >= danger) { warn = 50; danger = 80; }
  return { segments, separator, warn, danger };
}

function pctColor(pct, warn = 50, danger = 80) {
  return pct >= danger ? C.red : pct >= warn ? C.yellow : C.green;
}

async function cmdStatusline() {
  colorEnabled = !process.env.NO_COLOR; // Claude Code renders ANSI in the statusline
  try {
    await renderStatusline();
  } catch {
    // never blank the status bar — always print something
    console.log('claude-usage-monitor');
  }
}

async function renderStatusline() {
  const [hook, local] = await Promise.all([readStdinJson(), localStatus()]);
  const cfg = statuslineConfig();
  const col = pct => pctColor(pct, cfg.warn, cfg.danger);

  // each segment renders a string, or null to be skipped
  const SEG = {
    model() {
      let name = hook.model?.display_name || hook.model?.id || '';
      if (!name) return null;
      if (hook.effort?.level) name += C.dim(`(${hook.effort.level})`);
      return C.cyan(name);
    },
    cost() {
      const sessionCost = hook.cost?.total_cost_usd;
      const bits = [];
      if (typeof sessionCost === 'number') bits.push(L(`会话${fmtUSD(sessionCost)}`, `sess ${fmtUSD(sessionCost)}`));
      bits.push(L(`今日${fmtUSD(local.todayCost)}`, `today ${fmtUSD(local.todayCost)}`));
      if (local.block) bits.push(L(`窗口${fmtUSD(local.block.cost)}`, `win ${fmtUSD(local.block.cost)}`));
      return emo('💰') + bits.join(' / ');
    },
    week() {
      if (!Number.isFinite(local.weekCost)) return null;
      return L(`周${fmtUSD(local.weekCost)}`, `wk ${fmtUSD(local.weekCost)}`);
    },
    budget() {
      // daily budget warning (optional, from ~/.claude/usage-monitor.json)
      const budget = Number(userConfig().daily_budget_usd);
      if (!Number.isFinite(budget) || budget <= 0) return null;
      const pct = Math.round(local.todayCost / budget * 100);
      if (pct < 80) return null;
      return col(pct)(L(`${pct >= 100 ? '超预算' : '预算'}${pct}%`,
        `${pct >= 100 ? 'over budget ' : 'budget '}${pct}%`));
    },
    '5h'() {
      // official rate_limits first, local block estimate as fallback
      const fiveH = hook.rate_limits?.five_hour;
      if (fiveH && typeof fiveH.used_percentage === 'number') {
        const pct = Math.round(fiveH.used_percentage);
        let seg = `5h ${col(pct)(pct + '%')}`;
        const t = parseResetTs(fiveH.resets_at);
        if (Number.isFinite(t)) {
          seg += L(` 剩${fmtDuration(t - Date.now())}(${fmtLocal(t)}刷新)`,
            ` ${fmtDuration(t - Date.now())} left (resets ${fmtLocal(t)})`);
        }
        return seg;
      }
      if (local.block) {
        const elapsedPct = Math.min(100, Math.round((Date.now() - local.block.startMs) / BLOCK_MS * 100));
        return L(`5h ${C.dim(`已过${elapsedPct}%`)} 剩${fmtDuration(local.block.endMs - Date.now())}(${fmtLocal(local.block.endMs)}刷新)`,
          `5h ${C.dim(`${elapsedPct}% in`)} ${fmtDuration(local.block.endMs - Date.now())} left (resets ${fmtLocal(local.block.endMs)})`);
      }
      return null;
    },
    '7d'() {
      const week = hook.rate_limits?.seven_day;
      if (!week || typeof week.used_percentage !== 'number') return null;
      const pct = Math.round(week.used_percentage);
      return `7d ${col(pct)(pct + '%')}`;
    },
    ctx() {
      const ctx = hook.context_window;
      if (!ctx || typeof ctx.used_percentage !== 'number') return null;
      const pct = Math.round(ctx.used_percentage);
      return `ctx ${col(pct)(pct + '%')}`;
    },
    burn() {
      if (!local.block || !(local.block.tokensPerMin > 0)) return null;
      const tpm = local.block.tokensPerMin;
      // anomaly sentinel: current burn far above your own P90 baseline
      // (runaway multi-agent loops show up here within a minute)
      if (Number.isFinite(local.burnP90) && tpm >= Math.max(5000, local.burnP90 * 1.5)) {
        return C.red(L(`燃烧异常${fmtTok(tpm)}/min`, `burn anomaly ${fmtTok(tpm)}/min`));
      }
      const paintBy = tpm >= 5000 ? C.red : tpm >= 2000 ? C.yellow : C.dim;
      return paintBy(`${fmtTok(tpm)}tok/min`);
    },
    eta() {
      // warning-only: appears when the 5h window is projected to hit 100%
      // before its reset (same math as fiveHourEtaLine, official data only)
      const fiveH = hook.rate_limits?.five_hour;
      if (!fiveH || typeof fiveH.used_percentage !== 'number') return null;
      const pct = fiveH.used_percentage;
      const t = parseResetTs(fiveH.resets_at);
      const now = Date.now();
      if (!Number.isFinite(t) || now >= t || pct < 10 || pct >= 100) return null;
      const elapsedMin = (now - (t - BLOCK_MS)) / 60000;
      if (elapsedMin < 15) return null;
      const rate = pct / elapsedMin;
      if (!(rate > 0)) return null;
      const etaTs = now + (100 - pct) / rate * 60000;
      return etaTs < t ? C.red(L(`触顶约${fmtLocal(etaTs)}`, `limit ~${fmtLocal(etaTs)}`)) : null;
    },
  };

  const parts = cfg.segments.map(k => SEG[k]()).filter(Boolean);
  console.log(parts.join(C.dim(cfg.separator)));
}

// ---------------------------------------------------------------------------
// SessionStart hook — plain text on stdout (goes into session context, so no
// ANSI), never throws, never blocks startup. Config in usage-monitor.json:
//   { "hooks": { "session_start": true, "limit_warn_pct": 80 } }
// ---------------------------------------------------------------------------
const stateFile = () => path.join(configHomes()[0], 'usage-monitor', 'state.json');

async function cmdHookSessionStart() {
  try {
    const cfgAll = userConfig();
    const cfg = cfgAll.hooks && typeof cfgAll.hooks === 'object' ? cfgAll.hooks : {};
    if (cfg.session_start === false) return;
    const lines = [];
    const now = Date.now();
    const today = localDate(now);

    // 1) once-a-day summary of yesterday (first session of the day only).
    // Compute first, mark the date only after success — a failed run retries
    // on the next session instead of silently losing the day's summary.
    const state = readJsonObject(stateFile()) || {};
    let stateDirty = false;
    if (state.last_summary_date !== today) {
      const mid = new Date(); mid.setHours(0, 0, 0, 0);
      const yd = new Date(mid); yd.setDate(yd.getDate() - 1); // DST-safe boundaries
      const dd = new Date(mid); dd.setDate(dd.getDate() - 2);
      const y0 = yd.getTime(), d0 = dd.getTime();
      const entries = await loadEntries({ sinceMs: d0 });
      let yCost = 0, dCost = 0, yReq = 0, yCacheNet = 0;
      const models = new Map();
      for (const e of entries) {
        if (e.ts >= y0 && e.ts < mid.getTime()) {
          yCost += e.cost; yReq += 1;
          models.set(e.model, (models.get(e.model) || 0) + e.cost);
          const pin = inputPriceOf(e.model, e.ts);
          if (pin != null) {
            const u = e.usage, cc = u.cache_creation;
            const w5 = cc ? (cc.ephemeral_5m_input_tokens || 0) : (u.cache_creation_input_tokens || 0);
            const w1 = cc ? (cc.ephemeral_1h_input_tokens || 0) : 0;
            yCacheNet += ((u.cache_read_input_tokens || 0) * (1 - CACHE_READ)
              - w5 * (CACHE_WRITE_5M - 1) - w1 * (CACHE_WRITE_1H - 1)) * pin / 1e6;
          }
        } else if (e.ts < y0) dCost += e.cost;
      }
      if (yCost > 0.005) {
        const top = [...models.entries()].sort((a, b) => b[1] - a[1])[0];
        const delta = dCost > 0.005
          ? `（较前日${yCost >= dCost ? '↑' : '↓'}${Math.abs(Math.round((yCost - dCost) / dCost * 100))}%）` : '';
        lines.push(`${emo('📊')}昨日（${localDate(y0)}）用量${fmtUSD(yCost)}${delta}，` +
          `${yReq}次请求，主力${shortModel(top[0])}，缓存净省${fmtUSD(yCacheNet)}`);
      }
      state.last_summary_date = today;
      stateDirty = true;
    }

    // 1b) once-a-week summary of last week (first session of the week)
    const wkKey = weekStart(today);
    if (state.last_weekly_key !== wkKey) {
      const monThis = new Date(); monThis.setHours(0, 0, 0, 0);
      monThis.setDate(monThis.getDate() - (monThis.getDay() + 6) % 7);
      const monLast = new Date(monThis); monLast.setDate(monLast.getDate() - 7);
      const monPrev = new Date(monThis); monPrev.setDate(monPrev.getDate() - 14);
      const wkEntries = await loadEntries({ sinceMs: monPrev.getTime() });
      let lastCost = 0, prevCost = 0;
      const byProj = new Map();
      for (const e of wkEntries) {
        if (e.ts >= monLast.getTime() && e.ts < monThis.getTime()) {
          lastCost += e.cost;
          byProj.set(e.project, (byProj.get(e.project) || 0) + e.cost);
        } else if (e.ts >= monPrev.getTime() && e.ts < monLast.getTime()) prevCost += e.cost;
      }
      if (lastCost > 0.005) {
        const top = [...byProj.entries()].sort((a, b) => b[1] - a[1])[0];
        const delta = prevCost > 0.005
          ? `（较前周${lastCost >= prevCost ? '↑' : '↓'}${Math.abs(Math.round((lastCost - prevCost) / prevCost * 100))}%）` : '';
        const end = new Date(monThis); end.setDate(end.getDate() - 1);
        lines.push(`${emo('📈')}上周（${localDate(monLast.getTime())}～${localDate(end.getTime())}）` +
          `用量${fmtUSD(lastCost)}${delta}，最费项目${prettyProject(top[0])}`);
      }
      state.last_weekly_key = wkKey;
      stateDirty = true;
      // archive last week's HTML report in the background (detached child)
      try {
        const outDir = path.join(configHomes()[0], 'usage-monitor', 'weekly');
        fs.mkdirSync(outDir, { recursive: true });
        spawn(process.execPath, [fileURLToPath(import.meta.url), 'report', '--days', '7',
          '--no-open', '--out', path.join(outDir, `weekly-${wkKey}.html`)],
          { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } catch { /* best effort */ }
    }

    // 2) limit warning when any official window is at/over the threshold
    const rawPct = cfg.limit_warn_pct;
    const warnPct = typeof rawPct === 'number' && Number.isFinite(rawPct)
      && rawPct > 0 && rawPct <= 100 ? rawPct : 80;
    const data = await fetchOfficialUsage();
    if (!data.error) {
      for (const l of limitEntries(data)) {
        if (l.pct < warnPct) continue;
        const reset = Number.isFinite(l.resetTs) ? `，${fmtResetAt(l.resetTs)}刷新` : '';
        lines.push(`${emo('⚠️')}${l.name}已用${Math.round(l.pct)}%${reset}，注意放缓或换更省额度的模型`);
      }
    }

    // 3) auto sync via the shared folder, throttled to once per 6h.
    // The sync runs in a detached child process: a hung network drive can
    // stall that child for minutes without ever delaying session startup,
    // and the throttle timestamp is persisted below regardless of outcome.
    if (String(cfgAll.sync_dir || '').trim()) {
      if (!state.device_id) { state.device_id = deviceName(); stateDirty = true; }
      const last = Number(state.last_sync_at) || 0;
      if (now - last >= 6 * 3600000) {
        state.last_sync_at = now;
        stateDirty = true;
        try {
          spawn(process.execPath, [fileURLToPath(import.meta.url), 'sync', '--json'],
            { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        } catch { /* best effort */ }
      }
    }

    if (stateDirty) {
      try {
        fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
        writeCacheAtomic(stateFile(), state);
      } catch { /* best effort */ }
    }
    if (lines.length) console.log(lines.join('\n'));
  } catch { /* a hook must never break session startup */ }
}

// ---------------------------------------------------------------------------
// History warehouse — daily aggregates snapshotted to <config>/usage-monitor/
// history.json so reports survive Claude Code's ~30-day transcript cleanup.
// ---------------------------------------------------------------------------
const historyFile = () => path.join(configHomes()[0], 'usage-monitor', 'history.json');

function saveHistory(entries) {
  try {
    const today = localDate(Date.now());
    const days = {};
    for (const e of entries) {
      const d = localDate(e.ts);
      if (d >= today) continue; // today is still partial
      const day = (days[d] ??= {});
      addEntry(day[e.model] ??= emptyAgg(), e);
    }
    if (!Object.keys(days).length) return;
    const file = historyFile();
    const cur = readJsonObject(file) || {};
    cur.days = { ...(cur.days || {}), ...days }; // live data wins for overlapping days
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeCacheAtomic(file, cur);
  } catch { /* best effort */ }
}

// Stable device identity: hostname + a persisted random suffix, so cloned
// VMs / renamed machines with identical hostnames never collide or double
// count. Generated once and stored in state.json.
let cachedDeviceId = null;
function deviceName() {
  if (cachedDeviceId) return cachedDeviceId;
  let host = 'unknown';
  try { host = os.hostname() || 'unknown'; } catch { /* keep default */ }
  try {
    const state = readJsonObject(stateFile()) || {};
    if (typeof state.device_id === 'string' && state.device_id) {
      return (cachedDeviceId = state.device_id);
    }
    const id = `${host}-${crypto.randomBytes(3).toString('hex')}`;
    state.device_id = id;
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    writeCacheAtomic(stateFile(), state);
    return (cachedDeviceId = id);
  } catch { return (cachedDeviceId = host); }
}

/**
 * Merged per-day aggregates for the last `days` natural days:
 * live JSONL data first, history snapshots fill days already cleaned up,
 * then (unless devices:false) imported other-device data is summed in.
 * Returns Map(date -> { agg, models: Map }).
 */
async function dayAggregates(days, { devices = true } = {}) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const entries = await loadEntries({ sinceMs: start.getTime() });
  const byDay = new Map();
  for (const e of entries) {
    const d = localDate(e.ts);
    if (!byDay.has(d)) byDay.set(d, { agg: emptyAgg(), models: new Map() });
    const rec = byDay.get(d);
    addEntry(rec.agg, e);
    if (!rec.models.has(e.model)) rec.models.set(e.model, emptyAgg());
    addEntry(rec.models.get(e.model), e);
  }
  saveHistory(entries);
  const histRoot = readJsonObject(historyFile()) || {};
  const startStr = localDate(start.getTime());
  for (const [d, models] of Object.entries(histRoot.days || {})) {
    if (d < startStr || byDay.has(d)) continue;
    const rec = { agg: emptyAgg(), models: new Map() };
    for (const [m, a] of Object.entries(models)) {
      if (!a || typeof a !== 'object') continue;
      rec.models.set(m, { ...emptyAgg(), ...a });
      for (const k of Object.keys(rec.agg)) rec.agg[k] += a[k] || 0;
    }
    byDay.set(d, rec);
  }
  if (devices) {
    const todayStr = localDate(Date.now());
    for (const [dev, drec] of Object.entries(histRoot.devices || {})) {
      if (dev === deviceName() || !drec || typeof drec.days !== 'object') continue;
      for (const [d, models] of Object.entries(drec.days)) {
        if (d < startStr || d > todayStr || !models || typeof models !== 'object') continue;
        if (!byDay.has(d)) byDay.set(d, { agg: emptyAgg(), models: new Map() });
        const rec = byDay.get(d); // devices are disjoint usage → sum
        for (const [m, a] of Object.entries(models)) {
          if (!a || typeof a !== 'object') continue;
          if (!rec.models.has(m)) rec.models.set(m, emptyAgg());
          const t = rec.models.get(m);
          for (const k of Object.keys(rec.agg)) {
            const v = Number(a[k]); // defense in depth: finite non-negative only
            if (!Number.isFinite(v) || v <= 0) continue;
            t[k] += v; rec.agg[k] += v;
          }
        }
      }
    }
  }
  return byDay;
}

// ---------------------------------------------------------------------------
// Multi-device: export this machine's daily aggregates to a file; import a
// file from another machine into the history warehouse (devices namespace).
// daily/weekly/monthly then merge all devices' usage.
// ---------------------------------------------------------------------------
/** Account email from ~/.claude.json (best effort, may be null). */
function accountEmail() {
  const candidates = [path.join(os.homedir(), '.claude.json'),
    ...configHomes().map(h => path.join(h, '.claude.json'))];
  for (const f of candidates) {
    const e = readJsonObject(f)?.oauthAccount?.emailAddress;
    if (typeof e === 'string' && e) return e;
  }
  return null;
}

/** Local-only daily aggregates packed for export (today excluded as partial). */
async function buildExportPayload(days) {
  const byDay = await dayAggregates(days, { devices: false });
  const today = localDate(Date.now());
  const daysObj = {};
  for (const [d, rec] of byDay) {
    if (d >= today) continue; // today is still partial
    daysObj[d] = Object.fromEntries([...rec.models].map(([m, a]) => [m, { ...a }]));
  }
  return {
    schema: 1, device: deviceName(), user: accountEmail(),
    exported_at: new Date().toISOString(), days: daysObj,
  };
}

async function cmdExport(opts) {
  const days = posInt(opts.days, 90);
  const payload = await buildExportPayload(days);
  const syncDir = String(userConfig().sync_dir || '').trim();
  const outPath = opts.out ||
    (syncDir ? path.join(syncDir, `export-${deviceName()}.json`)
      : path.join(configHomes()[0], 'usage-monitor', `export-${deviceName()}.json`));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  writeAtomicThrow(outPath, JSON.stringify(payload)); // peers may read mid-write
  const n = Object.keys(payload.days).length;
  if (opts.json) return out({ file: outPath, device: deviceName(), days: n });
  console.log(C.green(`已导出本机（${deviceName()}）${n}天聚合数据 → ${outPath}`));
  console.log(C.dim('把该文件拷到另一台机器后运行：node usage.mjs import <文件路径>'));
}

const EXPORT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AGG_FIELDS = ['input', 'output', 'cacheWrite', 'cacheRead', 'cost', 'count'];

/** Keep only well-formed dates and finite non-negative agg numbers. */
function sanitizeExportDays(days) {
  const clean = {};
  let dropped = 0;
  for (const [d, models] of Object.entries(days)) {
    if (!EXPORT_DATE_RE.test(d) || !models || typeof models !== 'object' || Array.isArray(models)) {
      dropped += 1; continue;
    }
    const cm = {};
    for (const [m, a] of Object.entries(models)) {
      if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
      const ca = {};
      let nonZero = false;
      for (const k of AGG_FIELDS) {
        const v = Number(a[k]);
        ca[k] = Number.isFinite(v) && v >= 0 ? v : 0;
        if (ca[k] > 0) nonZero = true;
      }
      if (nonZero) cm[m] = ca;
    }
    if (Object.keys(cm).length) clean[d] = cm;
    else dropped += 1;
  }
  return { clean, dropped };
}

/** Validate + sanitize + store one export payload into the devices namespace. */
function applyImportPayload(payload) {
  if (!payload || payload.schema !== 1 || typeof payload.device !== 'string'
      || !payload.device || !payload.days || typeof payload.days !== 'object') {
    return { ok: false, error: '不是有效的usage-monitor导出数据' };
  }
  if (payload.device === deviceName()) return { ok: false, error: '来自本机，无需导入', self: true };
  const { clean, dropped } = sanitizeExportDays(payload.days);
  if (!Object.keys(clean).length) return { ok: false, error: '没有任何有效的日期数据' };
  const hf = historyFile();
  const cur = readJsonObject(hf) || {};
  // union-merge with what we already hold for this device: new dates win,
  // dates beyond the export window survive (long manual imports aren't
  // truncated by routine 90-day sync exports)
  const prevDays = cur.devices?.[payload.device]?.days;
  const mergedDays = prevDays && typeof prevDays === 'object' && !Array.isArray(prevDays)
    ? { ...prevDays, ...clean } : clean;
  cur.devices = {
    ...(cur.devices || {}),
    [payload.device]: {
      days: mergedDays,
      user: typeof payload.user === 'string' ? payload.user.slice(0, 120) : null,
      exported_at: payload.exported_at || null,
      imported_at: new Date().toISOString(),
    },
  };
  fs.mkdirSync(path.dirname(hf), { recursive: true });
  writeCacheAtomic(hf, cur);
  return { ok: true, device: payload.device, days: Object.keys(clean).length, dropped };
}

async function cmdImport(opts) {
  const file = opts._[1];
  if (!file) {
    console.log(C.red('用法：node usage.mjs import <导出文件路径>'));
    process.exitCode = 1; return;
  }
  const r = applyImportPayload(readJsonObject(file));
  if (!r.ok) {
    if (r.self) { console.log(C.yellow('该导出文件来自本机，无需导入。')); return; }
    console.log(C.red(`导入失败：${r.error}。`));
    process.exitCode = 1; return;
  }
  if (r.dropped > 0) console.log(C.yellow(`${emo('⚠')}已跳过${r.dropped}个畸形/无效的日期条目。`));
  if (opts.json) return out({ device: r.device, days: r.days, dropped: r.dropped });
  console.log(C.green(`已导入设备「${r.device}」的${r.days}天数据。`));
  console.log(C.dim('daily/weekly/monthly报表现在会合并该设备的用量（重复导入同名设备会整体覆盖）。'));
}

// ---------------------------------------------------------------------------
// Auto sync via a user-chosen shared folder (usage-monitor.json: "sync_dir").
// Export self there, import every other export-*.json found. Point the same
// folder at a network share and it doubles as the team data exchange.
// ---------------------------------------------------------------------------
async function syncNow({ days } = {}) {
  const cfg = userConfig();
  const dir = String(cfg.sync_dir || '').trim();
  if (!dir) return { error: 'no-sync-dir' };
  // export window: explicit --days > sync_days config > 90
  let effDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 0;
  if (!effDays) {
    const c = Number(cfg.sync_days);
    effDays = Number.isFinite(c) && c >= 1 && c <= 365 ? Math.floor(c) : 90;
  }
  const res = { dir, exported: null, imported: [], errors: [] };
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    return { error: `同步目录不可用：${e.message}` };
  }
  try {
    const payload = await buildExportPayload(effDays);
    const f = path.join(dir, `export-${payload.device}.json`);
    writeAtomicThrow(f, JSON.stringify(payload));
    res.exported = f;
  } catch (e) { res.errors.push(`导出失败：${e.message}`); }
  let names = [];
  try {
    names = fs.readdirSync(dir).filter(n => /^export-.+\.json$/i.test(n));
  } catch (e) { res.errors.push(`读取同步目录失败：${e.message}`); }
  for (const n of names) {
    const payload = readJsonObject(path.join(dir, n));
    if (!payload) { res.errors.push(`${n}：无法解析`); continue; }
    if (payload.device === deviceName()) continue; // our own file
    // a fresh machine legitimately exports zero days — skip quietly
    if (payload.days && typeof payload.days === 'object'
        && !Object.keys(payload.days).length) continue;
    const r = applyImportPayload(payload);
    if (r.ok) res.imported.push({ device: r.device, days: r.days });
    else res.errors.push(`${n}：${r.error}`);
  }
  return res;
}

async function cmdSync(opts) {
  const r = await syncNow({ days: opts.days });
  if (opts.json) return out(r);
  if (r.error === 'no-sync-dir') {
    console.log(C.yellow('尚未配置同步目录。在 ~/.claude/usage-monitor.json 中加入：'));
    console.log(C.dim('  { "sync_dir": "D:/OneDrive/claude-usage-sync" }'));
    console.log(C.dim('指向任意同步盘/网络共享目录即可；团队成员共用同一目录即得团队视图（team命令）。'));
    process.exitCode = 1; return;
  }
  if (r.error) {
    console.log(C.red(`同步失败：${r.error}`));
    process.exitCode = 1; return;
  }
  header('用量同步');
  if (r.exported) console.log(C.green(`已导出本机 → ${r.exported}`));
  console.log(r.imported.length
    ? C.green(`已合并${r.imported.length}台设备：` +
      r.imported.map(x => `${x.device}（${x.days}天）`).join('、'))
    : C.dim('同步目录中暂无其他设备的导出文件。'));
  for (const e of r.errors) console.log(C.yellow(`${emo('⚠')}${e}`));
  console.log(C.dim('\n查看按设备/成员汇总：node usage.mjs team'));
}

// ---------------------------------------------------------------------------
// Team view — per-device / per-member cost breakdown (local + imported).
// ---------------------------------------------------------------------------
async function cmdTeam(opts) {
  const days = posInt(opts.days, 30);
  const s = new Date(); s.setHours(0, 0, 0, 0); s.setDate(s.getDate() - (days - 1));
  const startStr = localDate(s.getTime());
  const todayStr = localDate(Date.now());

  const members = []; // {device, user, agg, models: Map, lastDate}
  const localByDay = await dayAggregates(days, { devices: false });
  const local = { device: deviceName(), user: accountEmail() || '', self: true,
    agg: emptyAgg(), models: new Map(), lastDate: todayStr };
  for (const [, rec] of localByDay) {
    for (const f of Object.keys(local.agg)) local.agg[f] += rec.agg[f];
    for (const [m, a] of rec.models) {
      if (!local.models.has(m)) local.models.set(m, emptyAgg());
      const t = local.models.get(m);
      for (const f of Object.keys(a)) t[f] += a[f];
    }
  }
  members.push(local);

  const devs = readJsonObject(historyFile())?.devices || {};
  for (const [dev, drec] of Object.entries(devs)) {
    if (dev === deviceName() || !drec || typeof drec.days !== 'object') continue;
    const m = { device: dev, user: typeof drec.user === 'string' ? drec.user : '',
      self: false, agg: emptyAgg(), models: new Map(), lastDate: '' };
    for (const [d, models] of Object.entries(drec.days)) {
      if (d < startStr || d > todayStr || !models || typeof models !== 'object') continue;
      if (d > m.lastDate) m.lastDate = d;
      for (const [model, a] of Object.entries(models)) {
        if (!a || typeof a !== 'object') continue;
        if (!m.models.has(model)) m.models.set(model, emptyAgg());
        const t = m.models.get(model);
        for (const f of Object.keys(m.agg)) {
          const v = Number(a[f]);
          if (!Number.isFinite(v) || v <= 0) continue;
          t[f] += v; m.agg[f] += v;
        }
      }
    }
    members.push(m);
  }

  members.sort((a, b) => b.agg.cost - a.agg.cost);
  const total = members.reduce((sum, m) => sum + m.agg.cost, 0);
  if (opts.json) {
    return out(members.map(m => ({
      device: m.device, user: m.user || null, is_local: m.self,
      last_data_date: m.lastDate || null, ...aggJson(m.agg), models: mapJson(m.models),
    })));
  }
  header(`团队视图（最近${days}天，本机＋已同步设备）`);
  if (members.length === 1) {
    console.log(C.dim('目前只有本机数据。配置sync_dir并运行sync，或用import导入其他设备/成员的导出文件。'));
  }
  const rows = [COMPACT
    ? ['设备', '成本', '占比', '主力模型']
    : ['设备', '成员', '输出', '成本', '占比', '主力模型', '数据截至']];
  for (const m of members) {
    const top = [...m.models.entries()].sort((a, b) => b[1].cost - a[1].cost)[0];
    const share = total > 0 ? Math.round(m.agg.cost / total * 100) : 0;
    const name = m.self ? `${m.device} ${C.cyan('◂本机')}` : m.device;
    rows.push(COMPACT
      ? [name, fmtUSD(m.agg.cost), C.dim(share + '%'), shortModel(top?.[0] || '')]
      : [name, m.user ? m.user.split('@')[0] : C.dim('—'), fmtTok(m.agg.output),
        fmtUSD(m.agg.cost), C.dim(share + '%'), shortModel(top?.[0] || ''),
        m.self ? C.dim('实时') : (m.lastDate || C.dim('—'))]);
  }
  if (members.length > 1) {
    rows.push(COMPACT
      ? [C.bold('合计'), C.bold(fmtUSD(total)), '', '']
      : [C.bold('合计'), '', '', C.bold(fmtUSD(total)), '', '', '']);
  }
  console.log(table(rows, {
    footer: members.length > 1,
    aligns: COMPACT ? ['l', 'r', 'r', 'l'] : ['l', 'l', 'r', 'r', 'r', 'l', 'r'],
  }));
  if (members.length > 1 && days > 90) {
    console.log('\n' + C.dim('注意：成员数据受各自导出视野限制（默认90天，可配sync_days），' +
      '超出视野的部分通常只有本机有数据，长区间下占比仅供参考。'));
  }
  footnotes();
}

/** Trim old daily snapshots (and imported device days) beyond a keep window. */
async function cmdPrune(opts) {
  const keep = posInt(opts.keep, 365);
  const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - keep);
  const cutoffStr = localDate(cutoff.getTime());
  const hf = historyFile();
  const cur = readJsonObject(hf);
  if (!cur) {
    console.log(C.dim('历史仓库为空，无需清理。'));
    return;
  }
  let removed = 0;
  for (const d of Object.keys(cur.days || {})) {
    if (d < cutoffStr) { delete cur.days[d]; removed += 1; }
  }
  for (const dev of Object.values(cur.devices || {})) {
    if (!dev || typeof dev.days !== 'object') continue;
    for (const d of Object.keys(dev.days)) {
      if (d < cutoffStr) { delete dev.days[d]; removed += 1; }
    }
  }
  if (removed) writeCacheAtomic(hf, cur);
  if (opts.json) return out({ keep_days: keep, removed_day_entries: removed });
  console.log(removed
    ? C.green(`已清理${removed}条早于${cutoffStr}的快照（保留最近${keep}天）。`)
    : C.dim(`没有早于${cutoffStr}的数据，无需清理。`));
}

/** Remove one imported device from the history warehouse. */
async function cmdForget(opts) {
  const dev = opts._[1];
  if (!dev) {
    console.log(C.red('用法：node usage.mjs forget <设备名>　（设备名见team命令）'));
    process.exitCode = 1; return;
  }
  const hf = historyFile();
  const cur = readJsonObject(hf) || {};
  if (!cur.devices || !cur.devices[dev]) {
    console.log(C.yellow(`没有名为「${dev}」的已导入设备。当前已导入：` +
      (Object.keys(cur.devices || {}).join('、') || '（无）')));
    process.exitCode = 1; return;
  }
  delete cur.devices[dev];
  fs.mkdirSync(path.dirname(hf), { recursive: true });
  writeCacheAtomic(hf, cur);
  if (opts.json) return out({ removed: dev });
  console.log(C.green(`已移除设备「${dev}」的数据。`));
  console.log(C.dim('若同步目录中仍留有该设备的export文件，请一并删除，否则下次同步会再次导入。'));
}

// ---------------------------------------------------------------------------
// Weekly / monthly / projects / cache / report commands
// ---------------------------------------------------------------------------

/** Monday-of-week (local) for a YYYY-MM-DD string. */
function weekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const shift = (d.getDay() + 6) % 7; // Mon=0
  d.setDate(d.getDate() - shift);
  return localDate(d.getTime());
}

async function periodReport(opts, { unit, count, keyFn, label }) {
  const days = unit === 'week' ? count * 7 : count * 31;
  const byDay = await dayAggregates(days);
  const byPeriod = new Map();
  for (const [d, rec] of byDay) {
    const k = keyFn(d);
    if (!byPeriod.has(k)) byPeriod.set(k, { agg: emptyAgg(), models: new Map(), days: 0 });
    const p = byPeriod.get(k);
    p.days += 1;
    for (const f of Object.keys(p.agg)) p.agg[f] += rec.agg[f];
    for (const [m, a] of rec.models) {
      if (!p.models.has(m)) p.models.set(m, emptyAgg());
      for (const f of Object.keys(a)) p.models.get(m)[f] += a[f];
    }
  }
  const keys = [...byPeriod.keys()].sort().slice(-count);
  if (opts.csv) {
    return outCsv(keys.map(k => ({
      period: k, days_with_usage: byPeriod.get(k).days, ...aggJson(byPeriod.get(k).agg),
    })));
  }
  if (opts.json) {
    return out(keys.map(k => ({
      period: k, days_with_usage: byPeriod.get(k).days,
      ...aggJson(byPeriod.get(k).agg), models: mapJson(byPeriod.get(k).models),
    })));
  }
  header(label);
  if (!keys.length) return console.log(C.dim('没有用量记录。'));
  const periodHead = unit === 'week' ? '周（起始日）' : '月份';
  const rows = [COMPACT
    ? [periodHead, '输入', '输出', '成本', '日均']
    : [periodHead, '输入', '输出', '缓存写', '缓存读', '成本', '日均', '主要模型']];
  const total = emptyAgg();
  for (const k of keys) {
    const p = byPeriod.get(k);
    const top = [...p.models.entries()].sort((a, b) => b[1].cost - a[1].cost)[0];
    const avg = C.dim(fmtUSD(p.agg.cost / Math.max(1, p.days)));
    rows.push(COMPACT
      ? [k, fmtTok(p.agg.input), fmtTok(p.agg.output), fmtUSD(p.agg.cost), avg]
      : [k, fmtTok(p.agg.input), fmtTok(p.agg.output), fmtTok(p.agg.cacheWrite),
        fmtTok(p.agg.cacheRead), fmtUSD(p.agg.cost), avg, shortModel(top?.[0] || '')]);
    for (const f of ['input', 'output', 'cacheWrite', 'cacheRead', 'cost']) total[f] += p.agg[f];
  }
  rows.push(COMPACT
    ? [C.bold('合计'), fmtTok(total.input), fmtTok(total.output), C.bold(fmtUSD(total.cost)), '']
    : [C.bold('合计'), fmtTok(total.input), fmtTok(total.output),
      fmtTok(total.cacheWrite), fmtTok(total.cacheRead), C.bold(fmtUSD(total.cost)), '', '']);
  console.log(table(rows, {
    footer: true,
    aligns: COMPACT ? ['l', 'r', 'r', 'r', 'r'] : ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'l'],
  }));
  console.log(`\n${C.bold('趋势')} ${C.cyan(sparkline(keys.map(k => byPeriod.get(k).agg.cost)))}`);
  footnotes();
}

const cmdWeekly = opts => periodReport(opts, {
  unit: 'week', count: posInt(opts.weeks, 8), keyFn: weekStart,
  label: `按周用量（最近${posInt(opts.weeks, 8)}周，周一起算）`,
});

const cmdMonthly = opts => periodReport(opts, {
  unit: 'month', count: posInt(opts.months, 6), keyFn: d => d.slice(0, 7),
  label: `按月用量（最近${posInt(opts.months, 6)}个月）`,
});

async function cmdProjects(opts) {
  const days = posInt(opts.days, 30);
  const entries = await loadEntries({ sinceMs: Date.now() - days * 86400000 });
  const byProject = groupBy(entries, e => e.project);
  const sorted = [...byProject.entries()].sort((a, b) => b[1].cost - a[1].cost);
  if (opts.csv) return outCsv(sorted.map(([p, a]) => ({ project: p, ...aggJson(a) })));
  if (opts.json) {
    return out(sorted.map(([p, a]) => ({ project: p, ...aggJson(a) })));
  }
  header(`按项目用量（最近${days}天）`);
  if (!sorted.length) return console.log(C.dim('没有用量记录。'));
  const totalCost = sorted.reduce((s, [, a]) => s + a.cost, 0);
  const rows = [['项目', '输入', '输出', '成本', '占比', '请求数']];
  for (const [proj, a] of sorted.slice(0, posInt(opts.top, 15))) {
    const name = fitDW(prettyProject(proj), 38);
    rows.push([name, fmtTok(a.input), fmtTok(a.output), fmtUSD(a.cost),
      C.dim((totalCost > 0 ? Math.round(a.cost / totalCost * 100) : 0) + '%'), String(a.count)]);
  }
  console.log(table(rows, { aligns: ['l', 'r', 'r', 'r', 'r', 'r'] }));
  footnotes();
}

async function cmdCache(opts) {
  const days = posInt(opts.days, 30);
  const entries = await loadEntries({ sinceMs: Date.now() - days * 86400000 });
  const per = new Map();
  for (const e of entries) {
    const pin = inputPriceOf(e.model, e.ts);
    if (!per.has(e.model)) per.set(e.model, { read: 0, write: 0, fresh: 0, save: 0, prem: 0 });
    const s = per.get(e.model);
    const u = e.usage;
    const cc = u.cache_creation;
    const w5 = cc ? (cc.ephemeral_5m_input_tokens || 0) : (u.cache_creation_input_tokens || 0);
    const w1 = cc ? (cc.ephemeral_1h_input_tokens || 0) : 0;
    s.read += u.cache_read_input_tokens || 0;
    s.write += w5 + w1;
    s.fresh += u.input_tokens || 0;
    if (pin != null) {
      s.save += (u.cache_read_input_tokens || 0) * pin * (1 - CACHE_READ) / 1e6;
      s.prem += (w5 * (CACHE_WRITE_5M - 1) + w1 * (CACHE_WRITE_1H - 1)) * pin / 1e6;
    }
  }
  const sorted = [...per.entries()].sort((a, b) => b[1].save - a[1].save);
  if (opts.json) {
    return out(sorted.map(([m, s]) => ({
      model: m, cache_read_tokens: s.read, cache_write_tokens: s.write,
      uncached_input_tokens: s.fresh,
      hit_rate: +(s.read / Math.max(1, s.read + s.write + s.fresh)).toFixed(4),
      read_savings_usd: +s.save.toFixed(2), write_premium_usd: +s.prem.toFixed(2),
      net_savings_usd: +(s.save - s.prem).toFixed(2),
    })));
  }
  header(`缓存效率（最近${days}天）`);
  if (!sorted.length) return console.log(C.dim('没有用量记录。'));
  const netCell = n => (n >= 0 ? C.green : C.red)(fmtUSD(n));
  const rows = [['模型', '缓存读', '缓存写', '命中率', '读省下', '写溢价', '净节省']];
  let save = 0, prem = 0;
  for (const [m, s] of sorted) {
    const hit = Math.round(s.read / Math.max(1, s.read + s.write + s.fresh) * 100);
    rows.push([shortModel(m), fmtTok(s.read), fmtTok(s.write), hit + '%',
      fmtUSD(s.save), fmtUSD(s.prem), netCell(s.save - s.prem)]);
    save += s.save; prem += s.prem;
  }
  rows.push([C.bold('合计'), '', '', '', fmtUSD(save), fmtUSD(prem), C.bold(netCell(save - prem))]);
  console.log(table(rows, { footer: true }));
  console.log('\n' + C.dim('说明：缓存读取按输入价0.1倍计费（省0.9倍）；写入按5分钟档1.25倍、1小时档2倍（溢价部分）。命中率=缓存读÷全部提示token。'));
  footnotes();
}

// ---------------------------------------------------------------------------
// ROI: what did each dollar buy — actions per $, edit ops, rework rate
// (same file edited repeatedly = churn signal).
// ---------------------------------------------------------------------------
async function cmdRoi(opts) {
  const days = posInt(opts.days, 7);
  const top = posInt(opts.top, 10);
  const sinceMs = Date.now() - days * 86400000;
  const toolSink = newToolSink();
  toolSink.sinceMs = sinceMs;
  toolSink.perSession = new Map();
  const entries = await loadEntries({ sinceMs, toolSink });
  const cost = new Map();
  const meta = new Map();
  for (const e of entries) {
    cost.set(e.sessionId, (cost.get(e.sessionId) || 0) + e.cost);
    if (!meta.has(e.sessionId)) meta.set(e.sessionId, { project: e.project, firstTs: e.ts });
  }
  const rows = [];
  for (const [sid, c] of cost) {
    const ps = toolSink.perSession.get(sid) || { ops: 0, edits: 0, files: new Map() };
    const uniq = ps.files.size;
    rows.push({
      sid, cost: c, ops: ps.ops, edits: ps.edits, uniq,
      rework: ps.edits > 0 ? 1 - uniq / ps.edits : 0,
      opsPerUsd: c > 0.01 ? ps.ops / c : 0,
      ...meta.get(sid),
    });
  }
  rows.sort((a, b) => b.cost - a.cost);
  const shown = rows.slice(0, top);
  if (opts.json || opts.csv) {
    const flat = shown.map(r => ({
      session_id: r.sid, project: r.project, cost_usd: +r.cost.toFixed(2),
      tool_ops: r.ops, edit_ops: r.edits, files_touched: r.uniq,
      rework_rate: +r.rework.toFixed(3), ops_per_usd: +r.opsPerUsd.toFixed(2),
    }));
    return opts.csv ? outCsv(flat) : out(flat);
  }
  header(L(`效率分析ROI（最近${days}天，按成本Top ${shown.length}）`,
    `ROI analysis (last ${days}d, top ${shown.length} by cost)`));
  if (!shown.length) return console.log(C.dim(L('没有会话记录。', 'No sessions recorded.')));
  const fileOf = new Map();
  for (const f of transcriptFiles(sinceMs)) fileOf.set(path.basename(f.file, '.jsonl'), f.file);
  const t = [[L('任务', 'Task'), L('成本', 'Cost'), L('动作', 'Ops'), L('每$动作', 'Ops/$'),
    L('编辑', 'Edits'), L('文件数', 'Files'), L('返工率', 'Rework')]];
  for (const r of shown) {
    const f = fileOf.get(r.sid);
    const title = (f && await sessionTitle(f, 26)) || C.dim(fitDW(prettyProject(r.project), 16));
    const reworkCell = r.edits >= 5 && r.rework >= 0.5
      ? C.yellow(Math.round(r.rework * 100) + '%')
      : C.dim(r.edits ? Math.round(r.rework * 100) + '%' : '—');
    t.push([title, fmtUSD(r.cost), String(r.ops),
      r.opsPerUsd ? r.opsPerUsd.toFixed(1) : C.dim('—'),
      String(r.edits), String(r.uniq), reworkCell]);
  }
  console.log(table(t, { aligns: ['l', 'r', 'r', 'r', 'r', 'r', 'r'] }));
  const totC = rows.reduce((s, r) => s + r.cost, 0);
  const totOps = rows.reduce((s, r) => s + r.ops, 0);
  console.log('\n' + C.dim(L(
    `全部${rows.length}个会话：${fmtUSD(totC)}换来${totOps}次工具动作` +
    `（平均每$1约${(totOps / Math.max(0.01, totC)).toFixed(1)}次）。` +
    '返工率=对同一文件的重复编辑占比，黄色标注值得复盘（需求没说清或方案反复）。',
    `${rows.length} sessions total: ${fmtUSD(totC)} bought ${totOps} tool actions` +
    ` (~${(totOps / Math.max(0.01, totC)).toFixed(1)} per $1). ` +
    'Rework = repeat edits to the same file; yellow rows are worth a retro (unclear asks or churning approaches).')));
}

// ---------------------------------------------------------------------------
// API error diagnostics: classify isApiErrorMessage transcript rows.
// ---------------------------------------------------------------------------
function classifyApiError(text) {
  const t = String(text).toLowerCase();
  if (t.includes('usage limit reached') || /session limit|hit your.*limit|rate.?limit/.test(t)) return '限流';
  if (/overloaded|529/.test(t)) return '过载';
  if (/timeout|timed out|etimedout/.test(t)) return '超时';
  if (/econn|network|fetch failed|socket|eai_again/.test(t)) return '网络';
  if (/internal server|\b5\d\d\b/.test(t)) return '服务端';
  if (/\b40[13]\b|auth|credit|billing/.test(t)) return '认证/账务';
  return '其他';
}

async function cmdErrors(opts) {
  const days = posInt(opts.days, 7);
  const apiErrors = [];
  await loadEntries({ sinceMs: Date.now() - days * 86400000, apiErrors });
  const byType = new Map();
  for (const e of apiErrors) {
    const k = classifyApiError(e.text);
    byType.set(k, (byType.get(k) || 0) + 1);
  }
  const sorted = [...byType.entries()].sort((a, b) => b[1] - a[1]);
  if (opts.json) {
    return out({
      days, total: apiErrors.length,
      by_type: Object.fromEntries(sorted),
      recent: apiErrors.slice(-10).map(e => ({
        time: new Date(e.ts).toISOString(), type: classifyApiError(e.text), text: e.text.slice(0, 120),
      })),
    });
  }
  header(`API错误诊断（最近${days}天）`);
  if (!apiErrors.length) return console.log(C.green('该时间段内没有任何API错误，链路健康。'));
  const rows = [['类型', '次数', '占比']];
  for (const [k, n] of sorted) {
    rows.push([k, String(n), C.dim(Math.round(n / apiErrors.length * 100) + '%')]);
  }
  console.log(table(rows));
  // daily trend sparkline
  const buckets = Array(days).fill(0);
  const start = Date.now() - days * 86400000;
  for (const e of apiErrors) {
    const i = Math.min(days - 1, Math.floor((e.ts - start) / 86400000));
    if (i >= 0) buckets[i] += 1;
  }
  console.log(`\n${C.bold('按天分布')} ${C.cyan(sparkline(buckets))} ` +
    C.dim(`共${apiErrors.length}次，最近一次${fmtResetAt(apiErrors[apiErrors.length - 1].ts)}`));
  console.log('\n' + C.bold('最近5条：'));
  for (const e of apiErrors.slice(-5)) {
    console.log(C.dim(`　${fmtResetAt(e.ts)}　`) + C.yellow(`[${classifyApiError(e.text)}]`) +
      C.dim(` ${e.text.replace(/\s+/g, ' ').slice(0, 70)}`));
  }
}

// ---------------------------------------------------------------------------
// Context-size analysis: prompt size (input + cache read + cache write) per
// request — the dominant cost driver in long agentic sessions.
// ---------------------------------------------------------------------------
const ctxOf = u => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0)
  + (u.cache_creation_input_tokens
    ?? ((u.cache_creation?.ephemeral_5m_input_tokens || 0) + (u.cache_creation?.ephemeral_1h_input_tokens || 0)));

const CTX_BANDS = [
  { name: '<50k', lo: 0, hi: 50_000 },
  { name: '50k~100k', lo: 50_000, hi: 100_000 },
  { name: '100k~150k', lo: 100_000, hi: 150_000 },
  { name: '≥150k', lo: 150_000, hi: Infinity },
];

/** Shared context stats over entries: bands + percentiles + fat sessions. */
function contextStats(entries) {
  const sizes = entries.map(e => ctxOf(e.usage)).sort((a, b) => a - b);
  const pct = q => sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(q * sizes.length))] : 0;
  const bands = CTX_BANDS.map(b => ({ ...b, count: 0, cost: 0 }));
  const bySession = new Map();
  let totalCost = 0;
  for (const e of entries) {
    const c = ctxOf(e.usage);
    totalCost += e.cost;
    const band = bands.find(b => c >= b.lo && c < b.hi);
    if (band) { band.count += 1; band.cost += e.cost; }
    let s = bySession.get(e.sessionId);
    if (!s) bySession.set(e.sessionId, s = { project: e.project, maxCtx: 0, cost: 0, count: 0 });
    s.maxCtx = Math.max(s.maxCtx, c);
    s.cost += e.cost; s.count += 1;
  }
  return {
    n: sizes.length, totalCost,
    avg: sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0,
    p50: pct(0.5), p90: pct(0.9), max: sizes[sizes.length - 1] || 0,
    bands, bySession,
  };
}

async function cmdContext(opts) {
  const days = posInt(opts.days, 7);
  const entries = await loadEntries({ sinceMs: Date.now() - days * 86400000 });
  const st = contextStats(entries);
  if (opts.json) {
    return out({
      days, requests: st.n,
      avg_tokens: Math.round(st.avg), p50_tokens: st.p50, p90_tokens: st.p90, max_tokens: st.max,
      bands: st.bands.map(b => ({
        band: b.name, requests: b.count,
        cost_usd: +b.cost.toFixed(2),
        cost_share: +(st.totalCost > 0 ? b.cost / st.totalCost : 0).toFixed(3),
      })),
    });
  }
  header(`上下文规模分析（最近${days}天）`);
  if (!st.n) return console.log(C.dim('没有用量记录。'));
  console.log(`请求数${st.n}　平均${fmtTok(st.avg)}　中位${fmtTok(st.p50)}　` +
    `P90 ${fmtTok(st.p90)}　最大${C.bold(fmtTok(st.max))}\n`);
  const rows = [['上下文档位', '请求数', '占比', '成本', '成本占比', '分布']];
  for (const b of st.bands) {
    const cShare = st.totalCost > 0 ? b.cost / st.totalCost : 0;
    const bar = C.cyan('▮'.repeat(Math.max(b.count ? 1 : 0, Math.round(cShare * 14))));
    rows.push([b.name, String(b.count),
      C.dim(Math.round(b.count / st.n * 100) + '%'),
      fmtUSD(b.cost), C.dim(Math.round(cShare * 100) + '%'), bar]);
  }
  console.log(table(rows, { aligns: ['l', 'r', 'r', 'r', 'r', 'l'] }));
  const fat = [...st.bySession.entries()]
    .sort((a, b) => b[1].maxCtx - a[1].maxCtx).slice(0, 5);
  console.log('\n' + C.bold('上下文最大的会话Top 5：'));
  for (const [, s] of fat) {
    console.log(`　${padEndDW(fitDW(prettyProject(s.project), 24), 24)} ` +
      `峰值${fmtTok(s.maxCtx).padStart(7)}　${fmtUSD(s.cost).padStart(7)}　${C.dim(s.count + '次请求')}`);
  }
  const fatShare = st.totalCost > 0 ? st.bands[3].cost / st.totalCost : 0;
  if (fatShare >= 0.25) {
    console.log('\n' + C.yellow(`≥150k上下文的请求花掉了${Math.round(fatShare * 100)}%的成本——` +
      '长会话勤开新会话或/clear、大文件分段读取，可显著省钱。'));
  } else {
    console.log('\n' + C.dim('上下文规模健康，超大上下文成本占比' + Math.round(fatShare * 100) + '%。'));
  }
}

// ---------------------------------------------------------------------------
// Advisor: turn cache/context/limit/model-mix data into actionable tips.
// ---------------------------------------------------------------------------
async function cmdAdvise(opts) {
  const days = posInt(opts.days, 14);
  const now = Date.now();
  const limitEvents = [];
  const entries = await loadEntries({ sinceMs: now - days * 86400000, limitEvents });
  const tips = [];

  if (entries.length) {
    // 1) cache health per model
    let save = 0, prem = 0;
    for (const e of entries) {
      const pin = inputPriceOf(e.model, e.ts);
      if (pin == null) continue;
      const u = e.usage, cc = u.cache_creation;
      const w5 = cc ? (cc.ephemeral_5m_input_tokens || 0) : (u.cache_creation_input_tokens || 0);
      const w1 = cc ? (cc.ephemeral_1h_input_tokens || 0) : 0;
      save += (u.cache_read_input_tokens || 0) * pin * (1 - CACHE_READ) / 1e6;
      prem += (w5 * (CACHE_WRITE_5M - 1) + w1 * (CACHE_WRITE_1H - 1)) * pin / 1e6;
    }
    if (save - prem < 0) {
      tips.push(['省钱', `缓存整体倒贴${fmtUSD(prem - save)}：会话普遍太短、缓存写入没被复用——同一主题尽量在同一会话里连续做。`]);
    } else {
      tips.push(['健康', `缓存净省${fmtUSD(save - prem)}（读省${fmtUSD(save)}－写溢价${fmtUSD(prem)}），复用良好。`]);
    }

    // 2) context fatness
    const st = contextStats(entries);
    const fatShare = st.totalCost > 0 ? st.bands[3].cost / st.totalCost : 0;
    if (fatShare >= 0.25) {
      tips.push(['省钱', `≥150k上下文的请求占了${Math.round(fatShare * 100)}%成本（P90=${fmtTok(st.p90)}）——长会话勤开新会话或/clear，细节见context命令。`]);
    } else {
      tips.push(['健康', `上下文规模合理（P90=${fmtTok(st.p90)}，超大上下文成本占比${Math.round(fatShare * 100)}%）。`]);
    }

    // 3) rate-limit hits
    const hits = limitEvents.length;
    if (hits > 0) {
      tips.push(['提醒', `近${days}天触顶限流${hits}次——参考hours命令的高峰时段错峰，或在窗口刷新后安排重活。`]);
    }

    // 4) model mix
    const byFamily = { opus: 0, sonnet: 0, haiku: 0, other: 0 };
    let total = 0;
    for (const e of entries) {
      total += e.cost;
      const m = e.model;
      if (m.includes('opus') || m.includes('fable') || m.includes('mythos')) byFamily.opus += e.cost;
      else if (m.includes('sonnet')) byFamily.sonnet += e.cost;
      else if (m.includes('haiku')) byFamily.haiku += e.cost;
      else byFamily.other += e.cost;
    }
    const opusShare = total > 0 ? byFamily.opus / total : 0;
    const lightShare = total > 0 ? (byFamily.sonnet + byFamily.haiku) / total : 0;
    if (opusShare >= 0.7 && lightShare < 0.1) {
      tips.push(['可选', `${Math.round(opusShare * 100)}%成本来自旗舰模型——格式化、批量改写等轻任务换Sonnet/Haiku可降约1/3～4/5单价（重推理任务不必换）。`]);
    }
  } else {
    tips.push(['提醒', '该时间段没有用量记录。']);
  }

  // 5) subscription value (calendar month)
  const subUsd = Number(userConfig().subscription_usd_per_month);
  if (Number.isFinite(subUsd) && subUsd > 0) {
    const mStart = new Date(); mStart.setHours(0, 0, 0, 0); mStart.setDate(1);
    const mtdEntries = await loadEntries({ sinceMs: mStart.getTime() });
    const mtd = mtdEntries.reduce((s, e) => s + e.cost, 0);
    const mult = mtd / subUsd;
    tips.push([mult >= 1.5 ? '健康' : '提醒',
      `本月等价API价值${fmtUSD(mtd)}＝订阅费的${mult >= 10 ? Math.round(mult) : mult.toFixed(1)}倍` +
      (mult < 1.5 ? '——用量较低，留意订阅档位是否偏高。' : '，订阅回本充分。')]);
  }

  if (opts.json) return out({ days, tips: tips.map(([level, text]) => ({ level, text })) });
  header(`用量优化建议（基于最近${days}天数据）`);
  const badge = l => l === '省钱' ? C.yellow('省钱') : l === '提醒' ? C.red('提醒')
    : l === '可选' ? C.cyan('可选') : C.green('健康');
  tips.forEach(([level, text], i) => {
    console.log(`${C.dim(String(i + 1) + '.')} ${badge(level)}　${text}`);
  });
  console.log('\n' + C.dim('依据命令：cache（缓存）、context（上下文）、hours（高峰）、blocks（触顶）、models（模型分布）。'));
}

// ---------------------------------------------------------------------------
// Live dashboard: clear + redraw the all-in-one view on an interval.
// ---------------------------------------------------------------------------
async function cmdLive(opts) {
  const sec = Math.max(10, posInt(opts.interval, 30));
  for (;;) {
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); // clear screen + scrollback
    console.log(C.dim(`live模式　每${sec}秒刷新　Ctrl+C退出　` +
      new Date().toLocaleTimeString('zh-CN', { hour12: false })) + '\n');
    try { await cmdAll({}); } catch (e) { console.log(C.red(`刷新失败：${e?.message || e}`)); }
    await new Promise(r => setTimeout(r, sec * 1000));
  }
}

// ---------------------------------------------------------------------------
// Shareable monthly usage card (self-contained SVG, no data leaves the file).
// ---------------------------------------------------------------------------
async function cmdCard(opts) {
  const now = new Date();
  const mStart = new Date(now); mStart.setHours(0, 0, 0, 0); mStart.setDate(1);
  const entries = await loadEntries({ sinceMs: mStart.getTime() });
  const cost = entries.reduce((s, e) => s + e.cost, 0);
  const outTok = entries.reduce((s, e) => s + (e.usage.output_tokens || 0), 0);
  const byDay = new Map();
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const e of entries) {
    const d = localDate(e.ts);
    byDay.set(d, (byDay.get(d) || 0) + e.cost);
    const dt = new Date(e.ts);
    heat[(dt.getDay() + 6) % 7][dt.getHours()] += e.cost;
  }
  const topDay = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
  const subUsd = Number(userConfig().subscription_usd_per_month);
  const mult = Number.isFinite(subUsd) && subUsd > 0 ? cost / subUsd : null;
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const maxH = Math.max(1e-9, ...heat.flat());
  let cells = '';
  heat.forEach((row, d) => row.forEach((v, h) => {
    if (v <= 0) return;
    const op = 0.25 + 0.75 * Math.min(1, v / maxH);
    cells += `<rect x="${370 + h * 10}" y="${210 + d * 12}" width="8" height="10" rx="2" fill="#3987e5" opacity="${op.toFixed(2)}"/>`;
  }));
  const fmt = n => n >= 100 ? '$' + Math.round(n).toLocaleString('en-US') : '$' + n.toFixed(2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 320" font-family="Segoe UI, PingFang SC, Microsoft YaHei, sans-serif">
<rect width="640" height="320" rx="16" fill="#0d1220"/>
<text x="32" y="52" fill="#8ea0c0" font-size="15">Claude Code 用量月卡</text>
<text x="608" y="52" fill="#5a6b8a" font-size="15" text-anchor="end">${ym}</text>
<text x="32" y="118" fill="#ffffff" font-size="46" font-weight="700">${esc(fmt(cost))}</text>
<text x="32" y="146" fill="#8ea0c0" font-size="14">等价API价值${mult != null ? `　·　订阅费的${mult >= 10 ? Math.round(mult) : mult.toFixed(1)}倍` : ''}</text>
<text x="32" y="196" fill="#c8d4e8" font-size="14">输出token　<tspan fill="#ffffff" font-weight="600">${fmtTok(outTok)}</tspan></text>
<text x="32" y="222" fill="#c8d4e8" font-size="14">最高单日　<tspan fill="#ffffff" font-weight="600">${topDay ? esc(topDay[0].slice(5) + ' ' + fmt(topDay[1])) : '—'}</tspan></text>
<text x="32" y="248" fill="#c8d4e8" font-size="14">活跃天数　<tspan fill="#ffffff" font-weight="600">${byDay.size}天</tspan></text>
<text x="370" y="196" fill="#8ea0c0" font-size="12">星期×小时热力</text>
${cells}
<text x="32" y="296" fill="#5a6b8a" font-size="12">github.com/1931840268/claude-usage-monitor</text>
</svg>`;
  const outPath = opts.out ||
    path.join(configHomes()[0], 'usage-monitor', `card-${ym}.svg`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, svg, 'utf8');
  if (opts.json) return out({ file: outPath, month: ym, cost_usd: +cost.toFixed(2) });
  console.log(C.green(`月度用量卡片已生成：${outPath}`));
  if (!opts.noOpen) {
    try {
      spawn('cmd', ['/c', 'start', '', outPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch { console.log(C.dim('请手动打开上述SVG文件查看。')); }
  }
}

// ---------------------------------------------------------------------------
// Plan: next-24h timeline — official reset moments overlaid on your own
// historical hourly load, so heavy work lands right after a refresh.
// ---------------------------------------------------------------------------
async function cmdPlan(opts) {
  const now = Date.now();
  const [entries, official] = await Promise.all([
    loadEntries({ sinceMs: now - 28 * 86400000 }),
    fetchOfficialUsage(),
  ]);
  // hourly cost profile for today's weekday (4 weeks of history)
  const dow = (new Date().getDay() + 6) % 7;
  const prof = Array(24).fill(0);
  for (const e of entries) {
    const d = new Date(e.ts);
    if ((d.getDay() + 6) % 7 === dow) prof[d.getHours()] += e.cost;
  }
  const nz = prof.filter(v => v > 0).sort((a, b) => a - b);
  const p75 = nz.length ? nz[Math.floor(nz.length * 0.75)] : Infinity;

  // upcoming 5h resets (rolling every BLOCK from the official reset moment)
  const lims = limitEntries(official.error ? {} : official);
  const l5 = lims.find(x => x.fiveHour);
  const resets5 = [];
  if (l5 && Number.isFinite(l5.resetTs)) {
    for (let t = l5.resetTs; t < now + 24 * 3600000; t += BLOCK_MS) {
      if (t > now) resets5.push(t);
    }
  }
  const weekly = lims.filter(x => !x.fiveHour && Number.isFinite(x.resetTs)
    && x.resetTs > now && x.resetTs < now + 24 * 3600000);

  if (opts.json) {
    return out({
      now: new Date(now).toISOString(),
      five_hour_resets: resets5.map(t => new Date(t).toISOString()),
      weekly_resets: weekly.map(w => ({ name: w.name, at: new Date(w.resetTs).toISOString() })),
      weekday_hour_profile_usd: prof.map(v => +v.toFixed(2)),
    });
  }
  header(L('未来24小时限额规划', 'Next-24h limit planner'));
  const hour0 = Math.floor(now / 3600000) * 3600000;
  let labels = '', strip = '';
  for (let i = 0; i < 24; i++) {
    const ts = hour0 + i * 3600000;
    const h = new Date(ts).getHours();
    labels += i % 3 === 0 ? String(h).padStart(2, '0') + ' ' : '';
    const hasReset = resets5.some(t => t >= ts && t < ts + 3600000);
    const busy = prof[h] >= p75 && prof[h] > 0;
    strip += hasReset ? C.yellow('R') : busy ? C.cyan('▓') : prof[h] > 0 ? '░' : C.dim('·');
  }
  // both prefixes are 7 display columns so the scale aligns with the strip
  console.log(C.dim(L('时刻   ', 'Hour   ')) + C.dim(labels));
  console.log(L('时间轴 ', 'Axis   ') + strip +
    C.dim(L('　（R=5小时窗口刷新　▓=你的历史高峰时段）', '  (R = 5h reset  ▓ = your historical peak hours)')));
  console.log('');
  if (l5) {
    const pctTxt = Number.isFinite(l5.pct)
      ? L(`当前已用${Math.round(l5.pct)}%，`, `${Math.round(l5.pct)}% used, `) : '';
    console.log(L('5小时窗口：', '5h window: ') + pctTxt + (resets5.length
      ? L(`下次刷新${C.yellow(fmtResetAt(resets5[0]))}（剩${fmtDuration(resets5[0] - now)}）`,
        `next reset ${C.yellow(fmtResetAt(resets5[0]))} (${fmtDuration(resets5[0] - now)} left)`)
      : C.dim(L('刷新时间未知', 'reset time unknown'))));
  } else {
    console.log(C.dim(L('未获取到官方5小时窗口（API Key用户可参考blocks的本地估算）。',
      'No official 5h window data (API-key users: see blocks for local estimates).')));
  }
  for (const w of weekly) {
    console.log(L(`${w.name}：已用${Math.round(w.pct)}%，${C.yellow(fmtResetAt(w.resetTs))}刷新（未来24小时内）`,
      `${w.name}: ${Math.round(w.pct)}% used, resets ${C.yellow(fmtResetAt(w.resetTs))} (within 24h)`));
  }
  const peaks = prof.map((v, h) => [h, v]).filter(([, v]) => v >= p75 && v > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => `${h}:00`);
  if (peaks.length) {
    const wd = L(`周${'一二三四五六日'[dow]}`, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][dow]);
    console.log(L(`今天（${wd}）的历史高峰时段：${peaks.join('、')}`,
      `Your historical peak hours on ${wd}: ${peaks.join(', ')}`));
  }
  if (l5 && Number.isFinite(l5.pct) && l5.pct >= 60 && resets5.length) {
    console.log('\n' + C.yellow(L(
      `建议：额度已用${Math.round(l5.pct)}%，重活安排到${fmtLocal(resets5[0])}刷新之后；刷新前适合做规划、审阅等轻交互。`,
      `Tip: ${Math.round(l5.pct)}% used — schedule heavy work after the ${fmtLocal(resets5[0])} reset; use the remaining window for planning and review.`)));
  } else if (peaks.length && resets5.length) {
    console.log('\n' + C.dim(L(
      `建议：在刷新点（${resets5.slice(0, 2).map(fmtLocal).join('、')}）之后开始高强度任务，让整个5小时窗口都落在你的高产时段里。`,
      `Tip: start heavy tasks right after a reset (${resets5.slice(0, 2).map(fmtLocal).join(', ')}) so the whole 5h window lands in your productive hours.`)));
  }
}

// ---------------------------------------------------------------------------
// Terminal heatmap: weekday × hour cost intensity over the last N days.
// ---------------------------------------------------------------------------
async function cmdHours(opts) {
  const days = posInt(opts.days, 30);
  const entries = await loadEntries({ sinceMs: Date.now() - days * 86400000 });
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const e of entries) {
    const d = new Date(e.ts);
    heat[(d.getDay() + 6) % 7][d.getHours()] += e.cost;
  }
  if (opts.json) return out({ days, rows: '一二三四五六日', heat: heat.map(r => r.map(v => +v.toFixed(2))) });
  header(`用量热力（星期×小时，最近${days}天，字符深浅=累计成本）`);
  if (!entries.length) return console.log(C.dim('没有用量记录。'));
  const maxV = Math.max(1e-9, ...heat.flat());
  const RAMP = [' ', '·', '░', '▒', '▓', '█'];
  // hour scale: a mark every 6 hours across 24 one-char cells
  let scale = '';
  for (let h = 0; h < 24; h++) scale += h % 6 === 0 ? String(h / 6 === 0 ? 0 : h).padEnd(1) : ' ';
  console.log('　　　0     6     12    18      合计');
  const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  let peak = { v: 0, d: 0, h: 0 };
  heat.forEach((row, d) => {
    let cells = '';
    row.forEach((v, h) => {
      const lv = v <= 0 ? 0 : Math.max(1, Math.ceil(v / maxV * 5));
      const ch = RAMP[lv];
      cells += lv >= 4 ? C.cyan(ch) : lv >= 2 ? ch : C.dim(ch === ' ' ? '·' : ch);
      if (v > peak.v) peak = { v, d, h };
    });
    const rowTotal = row.reduce((a, b) => a + b, 0);
    const label = (d >= 5 ? C.yellow : C.dim)(names[d]);
    console.log(`${label}　${cells}　${C.dim(fmtUSD(rowTotal).padStart(6))}`);
  });
  console.log('\n' + C.dim(`高峰时段：${names[peak.d]} ${peak.h}:00～${peak.h + 1}:00（累计${fmtUSD(peak.v)}）`));
}

// ---------------------------------------------------------------------------
// Environment self-check: catches the classic "why didn't it take effect"
// cases (stale installed version, config typos, missing data sources...).
// ---------------------------------------------------------------------------
async function cmdDoctor(opts) {
  const checks = [];
  const add = (status, name, detail) => checks.push({ status, name, detail });

  // Node version
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add(nodeMajor >= 18 ? 'ok' : 'fail', 'Node版本',
    `v${process.versions.node}${nodeMajor >= 18 ? '' : '（需要>=18）'}`);

  // source vs installed plugin version
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  let srcVer = null;
  try {
    srcVer = JSON.parse(fs.readFileSync(path.join(selfDir, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  } catch { /* not in a plugin tree */ }
  const cacheRoot = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'usage-monitor-market', 'usage-monitor');
  let installed = [];
  try { installed = fs.readdirSync(cacheRoot).sort(); } catch { /* not installed */ }
  const latest = installed[installed.length - 1] || null;
  const runningFromCache = selfDir.includes(path.join('plugins', 'cache'));
  if (!latest) {
    add('warn', '插件安装', '未在插件缓存中找到，可能以--plugin-dir方式运行');
  } else if (srcVer && srcVer !== latest) {
    add('warn', '版本一致性', `源码${srcVer}≠已安装${latest}——改动后需要marketplace update＋plugin update`);
  } else {
    add('ok', '版本', `已安装${latest}${runningFromCache ? '（当前即已安装副本）' : '（当前运行桌面源码）'}`);
  }
  add('warn', '生效提醒', '斜杠命令用的是会话启动时加载的版本——刚更新过插件必须重启会话才生效');

  // transcripts
  const files = transcriptFiles(0);
  if (files.length) {
    const newest = Math.max(...files.map(f => f.mtimeMs));
    add('ok', '本地数据源', `${files.length}个会话记录文件，最新${fmtResetAt(newest)}`);
  } else {
    add('fail', '本地数据源', '找不到任何JSONL会话记录（检查CLAUDE_CONFIG_DIR）');
  }

  // credentials + official endpoint
  if (oauthToken()) {
    const data = await fetchOfficialUsage();
    add(data.error ? 'warn' : 'ok', '官方限额接口',
      data.error ? `查询失败（${data.error}），稍后自动重试` : '连通正常（订阅凭据有效）');
  } else {
    add('warn', '订阅凭据', '未找到.credentials.json——limits/预警不可用（API Key用户属正常）');
  }

  // config validation incl. unknown-key typo detection
  const KNOWN_TOP = ['daily_budget_usd', 'statusline', 'hooks', 'sync_dir', 'sync_days',
    'display', 'subscription_usd_per_month'];
  let cfgFound = false;
  for (const h of configHomes()) {
    const f = path.join(h, 'usage-monitor.json');
    if (!fs.existsSync(f)) continue;
    cfgFound = true;
    const o = readJsonObject(f);
    if (!o) { add('fail', '配置文件', `${f} 不是合法JSON`); continue; }
    const unknown = Object.keys(o).filter(k => !KNOWN_TOP.includes(k));
    add(unknown.length ? 'warn' : 'ok', '配置文件',
      unknown.length ? `${f} 含未知键（拼写错误？）：${unknown.join('、')}` : `${f} 合法`);
    break;
  }
  if (!cfgFound) add('ok', '配置文件', '未创建（全部使用默认值，正常）');

  // statusline wiring
  const settings = readJsonObject(path.join(configHomes()[0], 'settings.json'));
  const slCmd = settings?.statusLine?.command || '';
  add(slCmd.includes('usage.mjs') ? 'ok' : 'warn', '状态栏',
    slCmd.includes('usage.mjs') ? '已配置' : '未配置（可运行statusline-setup）');

  // hooks + mcp in installed copy
  if (latest) {
    const base = path.join(cacheRoot, latest);
    add(fs.existsSync(path.join(base, 'hooks', 'hooks.json')) ? 'ok' : 'warn',
      '会话钩子', fs.existsSync(path.join(base, 'hooks', 'hooks.json')) ? '已注册（昨日小结＋限额预警）' : '安装副本中缺hooks.json');
    add(fs.existsSync(path.join(base, '.mcp.json')) ? 'ok' : 'warn',
      'MCP服务器', fs.existsSync(path.join(base, '.mcp.json')) ? '已注册（usage_*系列工具）' : '安装副本中缺.mcp.json');
  }

  // history warehouse & devices
  const hist = readJsonObject(historyFile());
  const histDays = Object.keys(hist?.days || {}).length;
  const devs = Object.keys(hist?.devices || {});
  add('ok', '历史仓库', `${histDays}天快照${devs.length ? `，已导入设备：${devs.join('、')}` : '，无导入设备'}`);

  // sync dir (probed in a killable child so a dead network drive can't hang us)
  const syncDir = String(userConfig().sync_dir || '').trim();
  if (syncDir) {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath,
      ['-e', `require('fs').statSync(${JSON.stringify(syncDir)})`],
      { timeout: 3000, windowsHide: true });
    add(r.status === 0 ? 'ok' : 'warn', '同步目录',
      r.status === 0 ? `${syncDir} 可达` : `${syncDir} 3秒内不可达（网络盘离线？钩子已用后台子进程，不影响启动）`);
  } else {
    add('ok', '同步目录', '未配置（单机使用，正常）');
  }

  if (opts.json) return out({ checks });
  header('环境自检（doctor）');
  const badge = s => s === 'ok' ? C.green('正常') : s === 'warn' ? C.yellow('注意') : C.red('异常');
  for (const c of checks) {
    console.log(`${badge(c.status)}　${padEndDW(c.name, 12)} ${C.dim(c.detail)}`);
  }
  const n = { ok: 0, warn: 0, fail: 0 };
  checks.forEach(c => n[c.status]++);
  console.log('\n' + C.dim(`共${checks.length}项：`) + C.green(`${n.ok}正常`) +
    C.dim('、') + C.yellow(`${n.warn}注意`) + C.dim('、') + C.red(`${n.fail}异常`));
}

/** mcp__server__tool → server:tool; keep built-in tool names as-is. */
const shortTool = n => String(n).replace(/^mcp__(.+?)__/, '$1:');

async function cmdTools(opts) {
  const days = posInt(opts.days, 7);
  const toolSink = newToolSink();
  const windowStart = Date.now() - days * 86400000;
  // load 1h extra so a tool_use just before the window still names its error
  toolSink.sinceMs = windowStart;
  await loadEntries({ sinceMs: windowStart - 3600000, toolSink });
  const sorted = [...toolSink.byName.entries()].sort((a, b) => b[1].count - a[1].count);
  const flatTools = () => sorted.map(([name, s]) => ({
    tool: name, calls: s.count, errors: s.errors,
    error_rate: +(s.errors / Math.max(1, s.count)).toFixed(4),
  }));
  if (opts.csv) return outCsv(flatTools());
  if (opts.json) return out(flatTools());
  header(`工具调用统计（最近${days}天）`);
  if (!sorted.length) return console.log(C.dim('该时间段内没有工具调用记录。'));
  const totalCalls = sorted.reduce((s, [, v]) => s + v.count, 0);
  const totalErr = sorted.reduce((s, [, v]) => s + v.errors, 0);
  const maxCount = sorted[0][1].count;
  const top = sorted.slice(0, posInt(opts.top, 20));
  const barW = COMPACT ? 8 : 14;
  const rows = [COMPACT
    ? ['工具', '调用', '占比', '出错']
    : ['工具', '调用', '分布', '占比', '出错', '错误率']];
  for (const [name, s] of top) {
    const share = Math.round(s.count / Math.max(1, totalCalls) * 100);
    const bar = C.cyan('▮'.repeat(Math.max(1, Math.round(s.count / maxCount * barW))));
    const errCell = s.errors ? C.red(String(s.errors)) : C.dim('0');
    const row = COMPACT
      ? [shortTool(name), String(s.count), C.dim(share + '%'), errCell]
      : [shortTool(name), String(s.count), bar, C.dim(share + '%'), errCell,
        s.errors ? C.red(Math.round(s.errors / Math.max(1, s.count) * 100) + '%') : C.dim('—')];
    rows.push(row);
  }
  const aligns = COMPACT ? ['l', 'r', 'r', 'r'] : ['l', 'r', 'l', 'r', 'r', 'r'];
  console.log(table(rows, { aligns }));
  const restNote = sorted.length > top.length
    ? `（另有${sorted.length - top.length}个工具未列出，用--top调整）` : '';
  console.log('\n' + C.dim(`共${sorted.length}种工具、${totalCalls}次调用、` +
    `${totalErr}次出错（整体错误率${Math.round(totalErr / Math.max(1, totalCalls) * 100)}%）${restNote}`));
}

async function cmdReport(opts) {
  const { generateReport } = await import('./report.mjs');
  await generateReport({
    days: posInt(opts.days, 30),
    out: opts.out,
    open: !opts.noOpen,
  });
}

// ---------------------------------------------------------------------------
// All-in-one dashboard: one data pass + one limits fetch, every key metric.
// ---------------------------------------------------------------------------
async function cmdAll(opts) {
  const now = Date.now();
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const limitEvents = [];
  const [entries, official] = await Promise.all([
    loadEntries({ sinceMs: now - 32 * 86400000, limitEvents }), // 32d covers any full calendar month
    fetchOfficialUsage(),
  ]);

  const sum = since => entries.reduce((s, e) => s + (e.ts >= since ? e.cost : 0), 0);
  const today = sum(midnight.getTime());
  const week = sum(now - 7 * 86400000);
  const month = sum(now - 30 * 86400000);
  // calendar month-to-date + linear projection to month end
  const mStart = new Date(); mStart.setHours(0, 0, 0, 0); mStart.setDate(1);
  const mtd = sum(mStart.getTime());
  const elapsedDays = Math.max(1 / 24, (now - mStart.getTime()) / 86400000);
  const daysInMonth = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 0).getDate();
  const projMonth = mtd / elapsedDays * daysInMonth;
  const subUsd = Number(userConfig().subscription_usd_per_month);
  const subOk = Number.isFinite(subUsd) && subUsd > 0;
  // same-time-yesterday comparison (partial day vs partial day, fair)
  const y0 = midnight.getTime() - 86400000;
  const y1 = y0 + (now - midnight.getTime());
  const yesterdaySoFar = entries.reduce((s, e) => s + (e.ts >= y0 && e.ts < y1 ? e.cost : 0), 0);
  // this calendar week (Mon start) vs last week, DST-safe boundaries
  const monThisD = new Date(); monThisD.setHours(0, 0, 0, 0);
  monThisD.setDate(monThisD.getDate() - (monThisD.getDay() + 6) % 7);
  const monLastD = new Date(monThisD); monLastD.setDate(monLastD.getDate() - 7);
  const monThis = monThisD.getTime(), monLast = monLastD.getTime();
  const weekThis = entries.reduce((s, e) => s + (e.ts >= monThis ? e.cost : 0), 0);
  const weekLastSame = entries.reduce((s, e) =>
    s + (e.ts >= monLast && e.ts < monLast + (now - monThis) ? e.cost : 0), 0);
  const weekLastFull = entries.reduce((s, e) =>
    s + (e.ts >= monLast && e.ts < monThis ? e.cost : 0), 0);

  // cache net savings over the loaded 30 days
  let cacheSave = 0;
  for (const e of entries) {
    const pin = inputPriceOf(e.model, e.ts);
    if (pin == null) continue;
    const u = e.usage;
    const cc = u.cache_creation;
    const w5 = cc ? (cc.ephemeral_5m_input_tokens || 0) : (u.cache_creation_input_tokens || 0);
    const w1 = cc ? (cc.ephemeral_1h_input_tokens || 0) : 0;
    cacheSave += ((u.cache_read_input_tokens || 0) * (1 - CACHE_READ)
      - w5 * (CACHE_WRITE_5M - 1) - w1 * (CACHE_WRITE_1H - 1)) * pin / 1e6;
  }

  // active 5h block from the recent chain (48h + margin, same as statusline)
  const active = computeBlocks(entries.filter(e => e.ts >= now - STATUS_LOOKBACK_MS - 6 * 3600000))
    .find(b => b.active);
  if (active) markLimitHits([active], limitEvents);

  const byModelToday = groupBy(entries.filter(e => e.ts >= midnight.getTime()), e => e.model);
  const byProject7d = groupBy(entries.filter(e => e.ts >= now - 7 * 86400000), e => e.project);
  const topProjects = [...byProject7d.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 3);
  const proj7dTotal = [...byProject7d.values()].reduce((s, a) => s + a.cost, 0);

  const trendDays = 14;
  const trend = [];
  for (let i = trendDays - 1; i >= 0; i--) {
    const d0 = new Date(midnight); d0.setDate(d0.getDate() - i);
    const d1 = new Date(d0); d1.setDate(d1.getDate() + 1);
    trend.push(entries.reduce((s, e) => s + (e.ts >= d0.getTime() && e.ts < d1.getTime() ? e.cost : 0), 0));
  }

  if (opts.json) {
    return out({
      generated_at: new Date(now).toISOString(),
      cost: {
        today_usd: +today.toFixed(2),
        yesterday_same_time_usd: +yesterdaySoFar.toFixed(2),
        last_7d_usd: +week.toFixed(2), last_30d_usd: +month.toFixed(2),
      },
      week: {
        this_week_usd: +weekThis.toFixed(2),
        last_week_same_elapsed_usd: +weekLastSame.toFixed(2),
        last_week_usd: +weekLastFull.toFixed(2),
      },
      month: {
        month_to_date_usd: +mtd.toFixed(2),
        projected_month_usd: +projMonth.toFixed(2),
        subscription_multiple: subOk ? +(mtd / subUsd).toFixed(1) : null,
      },
      cache_net_savings_30d_usd: +cacheSave.toFixed(2),
      official_limits: official.error ? { error: official.error } : official,
      active_block: active ? blockJson(active, now) : null,
      daily_trend_14d: trend.map(v => +v.toFixed(2)),
      today_models: mapJson(byModelToday),
      top_projects_7d: topProjects.map(([p, a]) => ({ project: p, ...aggJson(a) })),
    });
  }

  const ts = `${localDate(now)} ${fmtLocal(now)}`;
  header(L(`Claude Code用量仪表盘　${C.dim(ts)}`, `Claude Code Usage Dashboard  ${C.dim(ts)}`));

  let vsYesterday = '';
  if (yesterdaySoFar >= 0.5) {
    const deltaPct = Math.round((today - yesterdaySoFar) / yesterdaySoFar * 100);
    if (deltaPct !== 0) {
      const arrow = deltaPct > 0 ? C.red(`↑${deltaPct}%`) : C.green(`↓${-deltaPct}%`);
      vsYesterday = C.dim(L('（较昨日此时', ' (vs yesterday ')) + arrow + C.dim(L('）', ')'));
    }
  }
  const cacheSeg = cacheSave >= 0
    ? C.green(L(`缓存净省${fmtUSD(cacheSave)}`, `cache saved ${fmtUSD(cacheSave)}`))
    : C.red(L(`缓存倒贴${fmtUSD(-cacheSave)}`, `cache overhead ${fmtUSD(-cacheSave)}`));
  console.log(C.bold(emo('💰') + L('成本　', 'Cost   ')) +
    L(`今日${C.bold(fmtUSD(today))}${vsYesterday}　·　近7天${fmtUSD(week)}　·　近30天${fmtUSD(month)}　·　${cacheSeg}`,
      `today ${C.bold(fmtUSD(today))}${vsYesterday} · 7d ${fmtUSD(week)} · 30d ${fmtUSD(month)} · ${cacheSeg}`));

  let weekCmp = '';
  if (weekLastSame >= 0.5) {
    const d = Math.round((weekThis - weekLastSame) / weekLastSame * 100);
    if (d !== 0) {
      weekCmp = C.dim(L('（较上周同期', ' (vs last wk ')) +
        (d > 0 ? C.red(`↑${d}%`) : C.green(`↓${-d}%`)) + C.dim(L('）', ')'));
    }
  }
  console.log(C.bold(emo('📅') + L('本周　', 'Week   ')) +
    L(`${fmtUSD(weekThis)}${weekCmp}　·　上周全周${fmtUSD(weekLastFull)}`,
      `${fmtUSD(weekThis)}${weekCmp} · last full week ${fmtUSD(weekLastFull)}`));

  let monthLine = C.bold(emo('📆') + L('本月　', 'Month  ')) +
    L(`${fmtUSD(mtd)}（${new Date().getDate()}日）　·　按日均预计月底${fmtUSD(projMonth)}`,
      `${fmtUSD(mtd)} (day ${new Date().getDate()}) · projected ${fmtUSD(projMonth)} by month end`);
  if (subOk) {
    const mult = mtd / subUsd;
    const multTxt = mult >= 10 ? Math.round(mult) : mult.toFixed(1);
    monthLine += L('　·　', ' · ') + C.green(L(`等价API价值为订阅费的${multTxt}倍`,
      `${multTxt}x your subscription in API value`));
  }
  console.log(monthLine);

  const budget = Number(userConfig().daily_budget_usd);
  if (Number.isFinite(budget) && budget > 0) {
    const pct = Math.round(today / budget * 100);
    console.log(C.bold(emo('🎯') + L('预算　', 'Budget ')) + progressBar(pct) + ' ' +
      pctColor(pct)(`${pct}%`) + C.dim(`（${fmtUSD(today)}/${fmtUSD(budget)}）`));
  }

  section(emo('📡') + L('官方限额', 'Official rate limits'), L('（订阅实时）', ' (live, from Anthropic)'));
  if (official.error === 'no-credentials') {
    console.log(C.dim(L('　未找到订阅凭据，跳过（API Key用户以本地估算为准）。',
      '  No subscription credentials — skipped (API-key users rely on local estimates).')));
  } else if (official.error) {
    console.log(C.dim(L(`　查询失败（${official.error}），稍后重试。`, `  Query failed (${official.error}) — retrying later.`)));
  } else {
    const lines = officialLimitLines(official);
    console.log(lines.length ? lines.join('\n') : C.dim(L('　接口未返回限额数据。', '  No limit data returned.')));
    const eta = fiveHourEtaLine(official);
    if (eta) console.log(eta);
  }

  section(emo('⏱') + L('当前5小时窗口', 'Current 5h window'));
  if (active) {
    const elapsedPct = Math.min(100, Math.round((now - active.startMs) / BLOCK_MS * 100));
    const line = `${fmtLocal(active.startMs)}~${fmtLocal(active.endMs)}　` + progressBar(elapsedPct) +
      L(` 已过${elapsedPct}%　已花${fmtUSD(active.agg.cost)}　${C.yellow(fmtLocal(active.endMs) + '刷新')}(剩${fmtDuration(active.endMs - now)})`,
        ` ${elapsedPct}% elapsed · spent ${fmtUSD(active.agg.cost)} · ${C.yellow('resets ' + fmtLocal(active.endMs))} (${fmtDuration(active.endMs - now)} left)`);
    console.log(line);
    if (active.limitHits.length) {
      const hitReset = active.limitHits[active.limitHits.length - 1].resetTs;
      console.log(C.red(emo('🚫') + L('本窗口已触顶限流', 'Rate limit hit in this window') +
        (Number.isFinite(hitReset) ? L(`，官方刷新时间${fmtResetAt(hitReset)}`, ` — official reset ${fmtResetAt(hitReset)}`) : '')));
    }
    if (active.tokensPerMin != null) {
      const remainMin = Math.max(0, (active.endMs - now) / 60000);
      const projCost = active.agg.cost + (active.costPerHour / 60) * remainMin;
      console.log(C.dim(emo('🔥') + L(`${fmtTok(active.tokensPerMin)}tok/min　${emo('📊')}按当前速度到刷新约${fmtUSD(projCost)}`,
        `${fmtTok(active.tokensPerMin)} tok/min  ${emo('📊')}projected ${fmtUSD(projCost)} by reset`)));
    }
  } else {
    console.log(C.dim(L('　当前没有活动窗口。', '  No active window right now.')));
  }

  console.log('\n' + C.bold(emo('📈') + L('近14天 ', 'Last 14d ')) + C.cyan(sparkline(trend)) +
    C.dim(L(` 日均${fmtUSD(trend.reduce((a, b) => a + b, 0) / trendDays)}`,
      ` avg ${fmtUSD(trend.reduce((a, b) => a + b, 0) / trendDays)}/day`)));

  section(emo('🤖') + L('今日按模型', 'Today by model'));
  console.log(byModelToday.size ? modelTable(byModelToday, { withCount: true })
    : C.dim(L('　今天还没有用量。', '  No usage today yet.')));

  if (topProjects.length) {
    section(emo('📁') + L('项目Top 3', 'Top 3 projects'), L('（近7天）', ' (last 7d)'));
    const nameW = COMPACT ? 20 : 30;
    for (const [proj, a] of topProjects) {
      const share = proj7dTotal > 0 ? Math.round(a.cost / proj7dTotal * 100) : 0;
      const name = fitDW(prettyProject(proj), nameW);
      const bar = C.cyan('▮'.repeat(Math.max(1, Math.round(share / 100 * 12))));
      console.log(`　${padEndDW(name, nameW)} ${fmtUSD(a.cost).padStart(7)} ` +
        `${C.dim(String(share).padStart(3) + '%')} ${bar}`);
    }
  }
  footnotes();
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { _: [] };
  const num = ['days', 'top', 'weeks', 'months', 'interval', 'keep'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--csv') { opts.csv = true; continue; }
    if (a === '--lang' || a.startsWith('--lang=')) {
      const v = a.includes('=') ? a.split('=')[1] : argv[++i];
      if (v === 'en' || v === 'zh') opts.lang = v;
      continue;
    }
    if (a === '--lang') { i += 1; continue; } // consumed by lang() at module level
    if (a === '--no-open') { opts.noOpen = true; continue; }
    if (a === '--compact') { opts.compact = true; continue; }
    if (a === '--wide') { opts.wide = true; continue; }
    if (a === '--check') { opts.check = true; continue; }
    if (a === '--out') { opts.out = argv[++i]; continue; }
    const m = a.match(/^--([a-z]+)(?:=(.*))?$/);
    if (m && num.includes(m[1])) {
      opts[m[1]] = Number(m[2] !== undefined ? m[2] : argv[++i]);
      continue;
    }
    opts._.push(a);
  }
  return opts;
}

/** Positive integer option with a default (NaN/0/negative → default). */
const posInt = (v, def) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : def);

const HELP_EN = `claude-usage-monitor — usage analytics for Claude Code

Usage: node usage.mjs <command> [options]   (or: npx claude-usage-monitor <command>)

Commands:
  all              all-in-one dashboard (cost + official limits + window + trends)
  today            today's usage by model, hourly sparkline
  daily            per-day report            --days N (default 7)
  weekly / monthly per-week / per-month reports
  blocks           5-hour billing windows    --days N (default 3)
  models           usage by model            --days N (omit = all history)
  sessions         top sessions with task titles   --top N --days N
  roi              efficiency: actions per $, rework rate   --days N
  plan             next-24h limit planner (resets × your peak hours)
  hours            weekday × hour heatmap    --days N (default 30)
  context          context-size cost analysis --days N (default 7)
  advise           personalized savings advice
  errors           API error taxonomy        --days N (default 7)
  projects / cache / tools / team / card / live / doctor / prune
  limits           official rate limits (Pro/Max)   --check adds exit codes
  report           self-contained HTML report --days N --out path --no-open
  export / import / sync / forget            multi-device sync
  statusline       Claude Code statusline output

Options:
  --json           machine-readable JSON     --csv  CSV export
  --lang en|zh     output language (auto-detected from locale by default)
  --compact        narrow-terminal columns (--wide to force off)

Note: most detailed docs are in README_zh.md; core commands above are fully
localized. Language auto-detection: zh locales get Chinese, others English.
`;

const HELP = `claude-usage-monitor — Claude Code 用量统计

用法: node usage.mjs <命令> [选项]

命令:
  all              整合仪表盘（成本+官方限额+当前窗口+趋势+模型+项目）
  today            今日用量（按模型）
  daily            按天报表          --days N（默认7，自然日）
  weekly           按周报表          --weeks N（默认8，周一起算）
  monthly          按月报表          --months N（默认6）
  blocks           5小时限额窗口      --days N（默认3，滚动窗口）
  models           按模型汇总          --days N（省略=全部历史）
  hours            用量热力：星期×小时高峰分析  --days N（默认30）
  context          上下文规模分析：档位分布/成本占比/最肥会话  --days N（默认7）
  roi              效率分析：每$动作数/编辑数/返工率  --days N（默认7）--top N
  plan             未来24小时限额规划（刷新时刻×历史高峰时间轴）
  card             生成月度用量分享卡片（SVG）  --out 路径 --no-open
  advise           用量优化建议（缓存/上下文/触顶/模型组合/订阅性价比）
  errors           API错误诊断：限流/过载/超时/网络分类统计  --days N（默认7）
  live             实时仪表盘（终端常驻，--interval 秒，默认30，Ctrl+C退出）
  doctor           环境自检：版本/配置/数据源/钩子/同步逐项体检
  prune            清理历史仓库  --keep N（保留最近N天，默认365）
  sessions         会话成本排行       --top N（默认10）--days N
  projects         按项目统计         --days N（默认30）--top N
  cache            缓存效率与节省      --days N（默认30）
  tools            工具调用统计       --days N（默认7）--top N（默认20）
  limits           官方限额利用率（5小时/7天窗口，需订阅账号）
                   --check 附加退出码：0正常/10接近(≥80%)/11已达/1查询失败
  report           生成HTML可视化报告  --days N（默认30）--out 路径 --no-open
  export           导出本机按天聚合数据  --days N（默认90）--out 路径
  import <文件>    导入另一台机器的导出文件（daily/weekly/monthly自动合并）
  sync             经sync_dir同步目录自动导出并合并其他设备（需配置sync_dir）
  team             团队视图：本机＋已同步设备/成员的成本汇总  --days N（默认30）
  forget <设备名>  移除某台已导入设备的数据
  statusline       状态栏输出（由 Claude Code statusLine 调用）
  hook-session-start  会话启动钩子：昨日小结＋限额预警（由插件钩子调用）

选项:
  --json           输出 JSON（供程序读取）
  --csv            输出 CSV（daily/weekly/monthly/models/sessions/projects/tools）
  --compact        紧凑列（窄终端自动开启，--wide 强制关闭）

说明: daily/weekly/monthly 按本地自然日统计；blocks/sessions/projects 按
      当前时刻回溯 N×24 小时。非法的数字参数回退为默认值。
      状态栏可通过 ~/.claude/usage-monitor.json 的 statusline 段配置
      （segments/separator/warn_pct/danger_pct）。
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.lang) _lang = opts.lang;
  const cmd = opts._[0] || 'today';
  COMPACT = !!opts.compact ||
    (!opts.wide && Number.isFinite(process.stdout.columns) && process.stdout.columns < 100);
  const commands = {
    all: cmdAll, dashboard: cmdAll,
    today: cmdToday, daily: cmdDaily, weekly: cmdWeekly, monthly: cmdMonthly,
    blocks: cmdBlocks, models: cmdModels, sessions: cmdSessions,
    projects: cmdProjects, cache: cmdCache, tools: cmdTools, limits: cmdLimits,
    report: cmdReport, statusline: cmdStatusline,
    export: cmdExport, import: cmdImport, sync: cmdSync, team: cmdTeam, forget: cmdForget,
    hours: cmdHours, doctor: cmdDoctor,
    context: cmdContext, advise: cmdAdvise, errors: cmdErrors,
    roi: cmdRoi, plan: cmdPlan, card: cmdCard,
    live: cmdLive, prune: cmdPrune,
    'hook-session-start': cmdHookSessionStart,
  };
  const fn = commands[cmd];
  if (!fn) { console.log(L(HELP, HELP_EN)); process.exitCode = cmd === 'help' ? 0 : 1; return; }
  await fn(opts);
}

export { loadEntries, computeBlocks, localDate, resolvePricing, inputPriceOf, newToolSink, prettyProject, PRICING };

// Run only when invoked directly (report.mjs imports this file as a library).
if (process.argv[1] && path.basename(process.argv[1]) === 'usage.mjs') {
  main().catch(err => {
    console.error(L('claude-usage-monitor 出错：', 'claude-usage-monitor error: '), err?.message || err);
    process.exitCode = 1;
  });
}
