// Local live dashboard (`usage serve`): a 127.0.0.1-only HTTP server that
// wraps the HTML report in a self-updating page — live bar on top (today cost,
// burn rate, official limit windows with a ticking countdown), the 8 report
// charts below. Data never leaves the machine; Ctrl+C stops it.
//
// Refresh model:
//   server: fs.watch on transcript roots (+30s poll fallback) → debounce →
//           SSE "refresh" to all clients
//   client: on refresh (or every 60s) refetch /data.json for the live bar;
//           full page reload at most once per 90s so charts catch up too
//           (theme survives reload via localStorage).
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import {
  loadEntries, computeBlocks, fetchOfficialUsage, limitEntries, lang, dataDirs,
} from './usage.mjs';
import { renderReportHtml } from './report.mjs';

const L = (zh, en) => (lang() === 'zh' ? zh : en);

/** Lightweight live snapshot for the top bar (one loadEntries over 26h). */
async function liveSnapshot() {
  const now = Date.now();
  const entries = await loadEntries({ sinceMs: now - 26 * 3600000 });
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  let todayCost = 0;
  for (const e of entries) if (e.ts >= day0.getTime()) todayCost += e.cost;
  const blocks = computeBlocks(entries);
  const active = blocks.find(b => b.active) || null;
  let burn = 0, blockCost = 0;
  if (active) {
    blockCost = active.agg.cost;
    burn = active.costPerHour
      ?? blockCost / Math.max(0.05, (now - active.firstTs) / 3600000);
  }
  const official = await fetchOfficialUsage();
  const limits = official.error ? null : limitEntries(official).map(l => ({
    name: l.name, pct: Math.round(l.pct), resetTs: Number.isFinite(l.resetTs) ? l.resetTs : null,
  }));
  return {
    updatedAt: now,
    todayCost: +todayCost.toFixed(2),
    blockCost: +blockCost.toFixed(2),
    burnPerHour: +burn.toFixed(2),
    limits,
  };
}

const LIVE_CSS = `
#livebar { position: sticky; top: 8px; z-index: 40; display: flex; flex-wrap: wrap;
  gap: 8px 22px; align-items: baseline; background: var(--surface);
  border: 1px solid var(--ring); border-radius: 10px; padding: 12px 16px;
  margin-bottom: 18px; box-shadow: 0 4px 14px rgba(0,0,0,0.06); font-size: 13px; }
#livebar .lb-dot { width: 8px; height: 8px; border-radius: 50%; background: #2fa463;
  align-self: center; animation: lbpulse 2s infinite; }
#livebar .lb-dot.stale { background: #c33; animation: none; }
@keyframes lbpulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }
#livebar b { font-size: 16px; }
#livebar .lb-k { color: var(--muted); margin-right: 4px; }
#livebar .lb-pct { font-variant-numeric: tabular-nums; }
#livebar .warn { color: #b58a00; } #livebar .danger { color: #c33; }
#livebar .lb-cd { color: var(--ink2); font-variant-numeric: tabular-nums; }
#livebar .lb-upd { color: var(--muted); font-size: 11px; margin-left: auto; }
`;

function liveBarHtml() {
  const t = {
    today: L('今日', 'Today'), burn: L('燃烧率', 'Burn'), block: L('窗口已花', 'Window'),
    upd: L('更新于', 'updated'), live: L('实时', 'LIVE'),
  };
  return `
<div id="livebar">
  <span class="lb-dot" id="lb-dot" title="${t.live}"></span>
  <span><span class="lb-k">${t.today}</span><b id="lb-today">—</b></span>
  <span><span class="lb-k">${t.burn}</span><b id="lb-burn">—</b><span class="lb-k">/h</span></span>
  <span><span class="lb-k">${t.block}</span><span id="lb-block">—</span></span>
  <span id="lb-limits"></span>
  <span class="lb-upd" id="lb-upd"></span>
</div>
<script>
(() => {
  const $ = id => document.getElementById(id);
  let snap = null, lastReload = Date.now();
  const usd = v => '$' + (v >= 100 ? Math.round(v) : v.toFixed(2));
  const cd = ms => {
    if (ms <= 0) return '00:00';
    const s = Math.floor(ms / 1000);
    const p = n => String(n).padStart(2, '0');
    return (s >= 3600 ? Math.floor(s / 3600) + ':' : '') + p(Math.floor(s / 60) % 60) + ':' + p(s % 60);
  };
  function paint() {
    if (!snap) return;
    $('lb-today').textContent = usd(snap.todayCost);
    $('lb-burn').textContent = usd(snap.burnPerHour);
    $('lb-block').textContent = usd(snap.blockCost);
    const el = $('lb-limits');
    if (snap.limits && snap.limits.length) {
      el.innerHTML = snap.limits.map(l => {
        const cls = l.pct >= 80 ? 'danger' : l.pct >= 50 ? 'warn' : '';
        const left = l.resetTs ? ' <span class="lb-cd">' + cd(l.resetTs - Date.now()) + '</span>' : '';
        return '<span class="lb-pct ' + cls + '"><span class="lb-k">' + l.name + '</span>' + l.pct + '%' + left + '</span>';
      }).join('　');
    } else el.innerHTML = '';
    const age = Date.now() - snap.updatedAt;
    $('lb-dot').className = 'lb-dot' + (age > 180000 ? ' stale' : '');
    $('lb-upd').textContent = '${L('更新于', 'updated ')}' + new Date(snap.updatedAt).toLocaleTimeString();
  }
  async function pull() {
    try { snap = await (await fetch('/data.json')).json(); paint(); } catch {}
  }
  setInterval(paint, 1000); // countdown ticks client-side
  setInterval(pull, 60000);
  try {
    const es = new EventSource('/events');
    es.onmessage = e => {
      if (e.data !== 'refresh') return;
      pull();
      if (Date.now() - lastReload > 90000) { lastReload = Date.now(); location.reload(); }
    };
  } catch {}
  pull();
})();
</script>`;
}

/** Inject the live bar + CSS into a report HTML string. */
function injectLiveBar(html) {
  // replacer FUNCTIONS, not strings: the injected JS contains sequences like
  // "$'" that String.replace would expand as special replacement patterns
  return html
    .replace('</style>', () => LIVE_CSS + '</style>')
    .replace('<body>', () => '<body>' + liveBarHtml());
}

export async function startServe({ port = 3737, days = 30, open = true } = {}) {
  let html = null, htmlAt = 0, building = null;
  const clients = new Set();

  async function rebuild() {
    if (building) return building;
    building = (async () => {
      try {
        html = injectLiveBar(await renderReportHtml(days));
        htmlAt = Date.now();
      } finally { building = null; }
    })();
    return building;
  }

  // change detection: fs.watch where supported + 30s poll as universal fallback
  let dirtyTimer = null;
  const markDirty = () => {
    if (dirtyTimer) return;
    dirtyTimer = setTimeout(async () => {
      dirtyTimer = null;
      await rebuild().catch(() => {});
      for (const res of clients) { try { res.write('data: refresh\n\n'); } catch { } }
    }, 3000);
  };
  const watchers = [];
  for (const root of dataDirs()) {
    try { watchers.push(fs.watch(root, { recursive: true }, markDirty)); } catch { /* poll covers it */ }
  }
  const poll = setInterval(async () => {
    // cheap staleness check: rebuild at most every 30s when watch missed events
    if (Date.now() - htmlAt > 120000) markDirty();
  }, 30000);
  const heartbeat = setInterval(() => {
    for (const res of clients) { try { res.write(': ping\n\n'); } catch { } }
  }, 25000);

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    try {
      if (url === '/') {
        if (!html || Date.now() - htmlAt > 15000) await rebuild();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }
      if (url === '/data.json') {
        const snap = await liveSnapshot();
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(snap));
      }
      if (url === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive',
        });
        res.write(': hello\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (url === '/favicon.ico' || url === '/favicon.svg') {
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' });
        return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
          '<rect width="16" height="16" rx="3" fill="#2a78d6"/>' +
          '<path d="M3 10.5 6 7l2.5 2L13 4.5" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>');
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      try {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('error: ' + (err?.message || err));
      } catch { }
    }
  });

  await rebuild();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1 only: never expose usage data to the local network
    server.listen(port, '127.0.0.1', resolve);
  });
  const addr = `http://127.0.0.1:${port}/`;
  console.log(L(`实时仪表盘已启动：${addr}（数据不出本机，Ctrl+C停止）`,
    `Live dashboard running at ${addr} (data stays local; Ctrl+C to stop)`));
  if (open) {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', addr]]
      : process.platform === 'darwin' ? ['open', [addr]]
      : ['xdg-open', [addr]];
    try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch { }
  }
  const stop = () => {
    clearInterval(poll); clearInterval(heartbeat);
    for (const w of watchers) { try { w.close(); } catch { } }
    for (const res of clients) { try { res.end(); } catch { } }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return server;
}
