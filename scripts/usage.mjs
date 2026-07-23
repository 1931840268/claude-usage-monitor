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
      sink.idName.set(c.id, c.name || '(未知)');
      if (ts >= since) recOf(c.name || '(未知)').count += 1;
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
async function loadEntries({ sinceMs = 0, toolSink = null, limitEvents = null } = {}) {
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
      if (!hasUsage && !mayLimit && !mayTool) continue;
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
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦⏩-⏺☀-➿⬀-⯿\u{1F300}-\u{1FAFF}]/u;
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
    console.log('\n' + C.yellow(`⚠ 以下模型不在价格表中，成本按$0计：${[...unknownModels].join('、')}`));
  }
}

function modelTable(map, { withCount = false } = {}) {
  const head = COMPACT
    ? ['模型', '输入', '输出', '成本', '占比']
    : ['模型', '输入', '输出', '缓存写', '缓存读', '成本', '占比'];
  if (withCount && !COMPACT) head.push('请求数');
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
    const row = COMPACT
      ? [C.bold('合计'), fmtTok(total.input), fmtTok(total.output), C.bold(fmtUSD(total.cost)), '']
      : [C.bold('合计'), fmtTok(total.input), fmtTok(total.output),
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
  header(`今日用量（${localDate(now)}）`);
  if (!todayEntries.length) {
    console.log(C.dim('今天还没有用量记录。'));
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
      cmp = C.dim('　较昨日此时') + (d > 0 ? C.red(`↑${d}%`) : C.green(`↓${-d}%`));
    }
  }
  console.log(`\n${C.bold('分时')} ${C.cyan(sparkline(buckets))} ` +
    C.dim(`0时→${curHour}时，峰值${fmtUSD(Math.max(...buckets))}`) + cmp);
  footnotes();
}

async function cmdDaily(opts) {
  const days = posInt(opts.days, 7);
  const byDay = await dayAggregates(days); // live JSONL + history snapshots
  const dates = [...byDay.keys()].sort();
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
  const entries = await loadEntries();
  const byModel = groupBy(entries, e => e.model);
  if (opts.json) return out({ models: mapJson(byModel), total: totalJson(byModel) });
  header('全部历史按模型汇总');
  console.log(entries.length ? modelTable(byModel, { withCount: true }) : C.dim('没有用量记录。'));
  footnotes();
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
  if (opts.json) {
    return out(sorted.map(([id, s]) => ({
      session_id: id, project: s.project,
      start: new Date(s.firstTs).toISOString(), end: new Date(s.lastTs).toISOString(),
      ...aggJson(s.agg),
    })));
  }
  header(`会话排行 Top ${sorted.length}（按成本）`);
  const projW = COMPACT ? 18 : 30;
  const rows = [COMPACT
    ? ['日期', '项目', '成本', '时长']
    : ['日期', '项目', '输入', '输出', '成本', '时长', '请求数']];
  for (const [, s] of sorted) {
    const dur = C.dim(fmtDuration(s.lastTs - s.firstTs));
    const proj = fitDW(prettyProject(s.project), projW);
    rows.push(COMPACT
      ? [localDate(s.firstTs), proj, fmtUSD(s.agg.cost), dur]
      : [localDate(s.firstTs), proj, fmtTok(s.agg.input),
        fmtTok(s.agg.output), fmtUSD(s.agg.cost), dur, String(s.agg.count)]);
  }
  console.log(sorted.length
    ? table(rows, { aligns: COMPACT ? ['l', 'l', 'r', 'r'] : ['l', 'l', 'r', 'r', 'r', 'r', 'r'] })
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
  header(`5小时限额窗口（最近${days}天）`);
  if (!blocks.length) return console.log(C.dim('没有用量记录。'));
  const rows = [['窗口', '状态', '输入', '输出', '成本', '燃烧率', '刷新时间']];
  for (const b of blocks) {
    const label = `${localDate(b.startMs)} ${fmtLocal(b.startMs)}~${fmtLocal(b.endMs)}`;
    const dur = fmtDuration((b.active ? now : b.lastTs) - b.startMs);
    const hit = b.limitHits.length > 0;
    // plain colored text only — emoji inside table cells overflow their
    // measured width on some Windows terminals and break the borders
    const status = hit ? C.red(`触顶(${dur})`)
      : b.active ? C.green(`进行中(${dur})`) : C.dim(`已结束 ${dur}`);
    // an official hit carries the authoritative reset time — prefer it
    const hitReset = hit ? b.limitHits[b.limitHits.length - 1].resetTs : NaN;
    const reset = hit && Number.isFinite(hitReset)
      ? C.red(`${fmtLocal(hitReset)}(官方)`)
      : b.active
        ? C.yellow(`${fmtLocal(b.endMs)}(剩${fmtDuration(b.endMs - now)})`)
        : fmtLocal(b.endMs);
    rows.push([label, status, fmtTok(b.agg.input), fmtTok(b.agg.output),
      fmtUSD(b.agg.cost), b.tokensPerMin == null ? C.dim('—') : `${fmtTok(b.tokensPerMin)}/min`, reset]);
  }
  console.log(table(rows, { aligns: ['l', 'l', 'r', 'r', 'r', 'r', 'r'] }));
  const active = blocks.find(b => b.active);
  if (active) {
    const elapsedPct = Math.min(100, Math.round((now - active.startMs) / BLOCK_MS * 100));
    console.log('\n' + C.bold('当前窗口 ') + progressBar(elapsedPct) +
      ` 时间已过${elapsedPct}%，${C.yellow(fmtLocal(active.endMs))}刷新`);
    if (active.tokensPerMin != null) {
      const remainMin = Math.max(0, (active.endMs - now) / 60000);
      const projTok = active.agg.input + active.agg.output + active.tokensPerMin * remainMin;
      const projCost = active.agg.cost + (active.costPerHour / 60) * remainMin;
      console.log(C.dim(`${emo('🔥')}燃烧率${fmtTok(active.tokensPerMin)}tok/min　${emo('📊')}按当前速度到刷新时约${fmtTok(projTok)}tok、${fmtUSD(projCost)}`));
    }
    console.log('\n' + C.bold('当前窗口模型分布：'));
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
  if (Number.isFinite(t)) reset = `　${fmtResetAt(t)}刷新（剩${fmtDuration(t - Date.now())}）`;
  return `${padEndDW(label, 13)} ${progressBar(p)} ${color(String(Math.min(999, p)).padStart(3) + '%')}${reset}`;
}

/** Human name for one entry of the official limits[] array. */
function limitName(l) {
  if (l.kind === 'session') return '5小时窗口';
  if (l.kind === 'weekly_all') return '7天全部';
  if (l.kind === 'weekly_scoped') {
    return `7天${l.scope?.model?.display_name || l.scope?.surface || '专项'}`;
  }
  return String(l.kind || '窗口');
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
    if (row) lines.push(row + (l.active ? C.dim('　◂当前计费窗口') : ''));
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
    return C.red(`⚠ 按当前速度约${fmtLocal(etaTs)}触顶（早于${fmtLocal(l.resetTs)}刷新），建议放缓`);
  }
  const projPct = Math.round(l.pct + rate * (l.resetTs - now) / 60000);
  return C.dim(`按当前速度到刷新时约${projPct}%，不会触顶`);
}

function fmtResetAt(ts) {
  const d = new Date(ts);
  const today = localDate(Date.now());
  const day = localDate(ts);
  const hm = fmtLocal(ts);
  if (day === today) return `今天${hm}`;
  const tomorrow = localDate(Date.now() + 86400000);
  if (day === tomorrow) return `明天${hm}`;
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
    console.log(C.dim('未找到订阅凭据（.credentials.json），此命令仅适用于Pro/Max订阅账号。'));
    console.log(C.dim('API Key用户请改用blocks命令查看本地估算的5小时窗口。'));
    return;
  }
  if (data.error) {
    console.log(C.red(`查询官方配额失败（${data.error}），请稍后重试。`));
    return;
  }
  header('官方限额利用率（Anthropic实时数据）');
  const lines = officialLimitLines(data);
  console.log(lines.length ? lines.join('\n') : C.dim('接口未返回任何限额窗口数据。'));
  const eta = fiveHourEtaLine(data);
  if (eta) console.log(eta);
  const extra = data.extra_usage;
  if (extra && extra.is_enabled) {
    console.log('\n' + C.bold('额外用量（超额付费）：') +
      ` 已用${extra.used_credits ?? 0}/${extra.monthly_limit ?? '?'} ` +
      C.dim(`（${extra.currency || 'USD'}）`));
  }
  if (opts.check) {
    const code = process.exitCode;
    const word = code === 11 ? C.red('已达限额') : code === 10 ? C.yellow('接近限额') : C.green('正常');
    console.log('\n' + C.dim('检查结果：') + word + C.dim(`（退出码${code}）`));
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
  const sinceMs = Math.min(midnight.getTime(), Date.now() - STATUS_LOOKBACK_MS);
  const entries = await loadEntries({ sinceMs });
  const todayCost = entries.reduce((s, e) => s + (e.ts >= midnight.getTime() ? e.cost : 0), 0);
  const active = computeBlocks(entries).find(b => b.active);
  const status = {
    todayCost,
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

const STATUS_SEGMENTS = ['model', 'cost', 'budget', '5h', '7d', 'ctx', 'burn', 'eta'];

/** Validated statusline config with defaults (bad values fall back silently). */
function statuslineConfig() {
  const raw = userConfig().statusline;
  const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let segments = Array.isArray(cfg.segments)
    ? cfg.segments.filter(s => STATUS_SEGMENTS.includes(s)) : [];
  if (!segments.length) segments = STATUS_SEGMENTS;
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
      if (typeof sessionCost === 'number') bits.push(`会话${fmtUSD(sessionCost)}`);
      bits.push(`今日${fmtUSD(local.todayCost)}`);
      if (local.block) bits.push(`窗口${fmtUSD(local.block.cost)}`);
      return emo('💰') + bits.join(' / ');
    },
    budget() {
      // daily budget warning (optional, from ~/.claude/usage-monitor.json)
      const budget = Number(userConfig().daily_budget_usd);
      if (!Number.isFinite(budget) || budget <= 0) return null;
      const pct = Math.round(local.todayCost / budget * 100);
      if (pct < 80) return null;
      return col(pct)(`${pct >= 100 ? '超预算' : '预算'}${pct}%`);
    },
    '5h'() {
      // official rate_limits first, local block estimate as fallback
      const fiveH = hook.rate_limits?.five_hour;
      if (fiveH && typeof fiveH.used_percentage === 'number') {
        const pct = Math.round(fiveH.used_percentage);
        let seg = `5h ${col(pct)(pct + '%')}`;
        const t = parseResetTs(fiveH.resets_at);
        if (Number.isFinite(t)) seg += ` 剩${fmtDuration(t - Date.now())}(${fmtLocal(t)}刷新)`;
        return seg;
      }
      if (local.block) {
        const elapsedPct = Math.min(100, Math.round((Date.now() - local.block.startMs) / BLOCK_MS * 100));
        return `5h ${C.dim(`已过${elapsedPct}%`)} 剩${fmtDuration(local.block.endMs - Date.now())}(${fmtLocal(local.block.endMs)}刷新)`;
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
      return etaTs < t ? C.red(`触顶约${fmtLocal(etaTs)}`) : null;
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
  if (r.dropped > 0) console.log(C.yellow(`⚠ 已跳过${r.dropped}个畸形/无效的日期条目。`));
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
  for (const e of r.errors) console.log(C.yellow(`⚠ ${e}`));
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
  if (opts.json) {
    return out(sorted.map(([name, s]) => ({
      tool: name, calls: s.count, errors: s.errors,
      error_rate: +(s.errors / Math.max(1, s.count)).toFixed(4),
    })));
  }
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
    loadEntries({ sinceMs: now - 30 * 86400000, limitEvents }),
    fetchOfficialUsage(),
  ]);

  const sum = since => entries.reduce((s, e) => s + (e.ts >= since ? e.cost : 0), 0);
  const today = sum(midnight.getTime());
  const week = sum(now - 7 * 86400000);
  const month = entries.reduce((s, e) => s + e.cost, 0);
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
      cache_net_savings_30d_usd: +cacheSave.toFixed(2),
      official_limits: official.error ? { error: official.error } : official,
      active_block: active ? blockJson(active, now) : null,
      daily_trend_14d: trend.map(v => +v.toFixed(2)),
      today_models: mapJson(byModelToday),
      top_projects_7d: topProjects.map(([p, a]) => ({ project: p, ...aggJson(a) })),
    });
  }

  const ts = `${localDate(now)} ${fmtLocal(now)}`;
  header(`Claude Code用量仪表盘　${C.dim(ts)}`);

  let vsYesterday = '';
  if (yesterdaySoFar >= 0.5) {
    const deltaPct = Math.round((today - yesterdaySoFar) / yesterdaySoFar * 100);
    if (deltaPct !== 0) {
      const arrow = deltaPct > 0 ? C.red(`↑${deltaPct}%`) : C.green(`↓${-deltaPct}%`);
      vsYesterday = C.dim('（较昨日此时') + arrow + C.dim('）');
    }
  }
  const cacheSeg = cacheSave >= 0
    ? C.green(`缓存净省${fmtUSD(cacheSave)}`)
    : C.red(`缓存倒贴${fmtUSD(-cacheSave)}`);
  console.log(C.bold(emo('💰') + '成本　') + `今日${C.bold(fmtUSD(today))}${vsYesterday}　·　近7天${fmtUSD(week)}` +
    `　·　近30天${fmtUSD(month)}　·　${cacheSeg}`);

  let weekCmp = '';
  if (weekLastSame >= 0.5) {
    const d = Math.round((weekThis - weekLastSame) / weekLastSame * 100);
    if (d !== 0) weekCmp = C.dim('（较上周同期') + (d > 0 ? C.red(`↑${d}%`) : C.green(`↓${-d}%`)) + C.dim('）');
  }
  console.log(C.bold(emo('📅') + '本周　') + `${fmtUSD(weekThis)}${weekCmp}　·　上周全周${fmtUSD(weekLastFull)}`);

  const budget = Number(userConfig().daily_budget_usd);
  if (Number.isFinite(budget) && budget > 0) {
    const pct = Math.round(today / budget * 100);
    console.log(C.bold('🎯 预算　') + progressBar(pct) + ' ' +
      pctColor(pct)(`${pct}%`) + C.dim(`（${fmtUSD(today)}/${fmtUSD(budget)}）`));
  }

  section(emo('📡') + '官方限额', '（订阅实时）');
  if (official.error === 'no-credentials') {
    console.log(C.dim('　未找到订阅凭据，跳过（API Key用户以本地估算为准）。'));
  } else if (official.error) {
    console.log(C.dim(`　查询失败（${official.error}），稍后重试。`));
  } else {
    const lines = officialLimitLines(official);
    console.log(lines.length ? lines.join('\n') : C.dim('　接口未返回限额数据。'));
    const eta = fiveHourEtaLine(official);
    if (eta) console.log(eta);
  }

  section(emo('⏱') + '当前5小时窗口');
  if (active) {
    const elapsedPct = Math.min(100, Math.round((now - active.startMs) / BLOCK_MS * 100));
    const line = `${fmtLocal(active.startMs)}~${fmtLocal(active.endMs)}　` + progressBar(elapsedPct) +
      ` 已过${elapsedPct}%　已花${fmtUSD(active.agg.cost)}　${C.yellow(fmtLocal(active.endMs) + '刷新')}(剩${fmtDuration(active.endMs - now)})`;
    console.log(line);
    if (active.limitHits.length) {
      const hitReset = active.limitHits[active.limitHits.length - 1].resetTs;
      console.log(C.red(emo('🚫') + '本窗口已触顶限流' +
        (Number.isFinite(hitReset) ? `，官方刷新时间${fmtResetAt(hitReset)}` : '')));
    }
    if (active.tokensPerMin != null) {
      const remainMin = Math.max(0, (active.endMs - now) / 60000);
      const projCost = active.agg.cost + (active.costPerHour / 60) * remainMin;
      console.log(C.dim(`${emo('🔥')}${fmtTok(active.tokensPerMin)}tok/min　${emo('📊')}按当前速度到刷新约${fmtUSD(projCost)}`));
    }
  } else {
    console.log(C.dim('　当前没有活动窗口。'));
  }

  console.log('\n' + C.bold(emo('📈') + '近14天 ') + C.cyan(sparkline(trend)) +
    C.dim(` 日均${fmtUSD(trend.reduce((a, b) => a + b, 0) / trendDays)}`));

  section(emo('🤖') + '今日按模型');
  console.log(byModelToday.size ? modelTable(byModelToday, { withCount: true }) : C.dim('　今天还没有用量。'));

  if (topProjects.length) {
    section(emo('📁') + '项目Top 3', '（近7天）');
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
  const num = ['days', 'top', 'weeks', 'months'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { opts.json = true; continue; }
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

const HELP = `claude-usage-monitor — Claude Code 用量统计

用法: node usage.mjs <命令> [选项]

命令:
  all              整合仪表盘（成本+官方限额+当前窗口+趋势+模型+项目）
  today            今日用量（按模型）
  daily            按天报表          --days N（默认7，自然日）
  weekly           按周报表          --weeks N（默认8，周一起算）
  monthly          按月报表          --months N（默认6）
  blocks           5小时限额窗口      --days N（默认3，滚动窗口）
  models           全部历史按模型汇总
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
  --compact        紧凑列（窄终端自动开启，--wide 强制关闭）

说明: daily/weekly/monthly 按本地自然日统计；blocks/sessions/projects 按
      当前时刻回溯 N×24 小时。非法的数字参数回退为默认值。
      状态栏可通过 ~/.claude/usage-monitor.json 的 statusline 段配置
      （segments/separator/warn_pct/danger_pct）。
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
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
    'hook-session-start': cmdHookSessionStart,
  };
  const fn = commands[cmd];
  if (!fn) { console.log(HELP); process.exitCode = cmd === 'help' ? 0 : 1; return; }
  await fn(opts);
}

export { loadEntries, computeBlocks, localDate, resolvePricing, inputPriceOf, newToolSink, prettyProject, PRICING };

// Run only when invoked directly (report.mjs imports this file as a library).
if (process.argv[1] && path.basename(process.argv[1]) === 'usage.mjs') {
  main().catch(err => { console.error('claude-usage-monitor 出错：', err?.message || err); process.exitCode = 1; });
}
