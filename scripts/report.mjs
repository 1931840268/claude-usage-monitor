#!/usr/bin/env node
/**
 * claude-usage-monitor — HTML report generator
 * Builds a self-contained HTML file (hand-written SVG, zero dependencies,
 * light/dark aware) and opens it in the default browser.
 *
 * Usage:  node report.mjs [--days N] [--out path] [--no-open]
 * Or via: node usage.mjs report
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { loadEntries, computeBlocks, localDate, inputPriceOf, newToolSink, prettyProject } from './usage.mjs';

// Categorical palette (validated, light/dark selected separately).
// Slot order is the CVD-safety mechanism — do not reorder.
const SLOTS = [
  { light: '#2a78d6', dark: '#3987e5' }, // blue
  { light: '#008300', dark: '#008300' }, // green
  { light: '#e87ba4', dark: '#d55181' }, // magenta
  { light: '#eda100', dark: '#c98500' }, // yellow
];
const OTHER = { light: '#898781', dark: '#898781' };
// Sequential blue ramp (block-timeline intensity), light-mode steps.
const SEQ = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95'];

const esc = s => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = n => '$' + (n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2));
const tok = n => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B'
  : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
  : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
const shortModel = m => String(m).replace(/^claude-/, '').replace(/-\d{8}$/, '');

/** Aggregate raw entries into everything the report needs. */
export function prepareData(entries, days) {
  const byDay = new Map();          // date -> { total, perModel: Map }
  const byModel = new Map();        // model -> { cost, input, output, cacheRead, cacheWrite, count }
  const byProject = new Map();      // project -> { cost, count }
  const cacheNetByDay = new Map();  // date -> net cache savings USD (read save - write premium)
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0)); // [Mon..Sun][hour] cost
  let totalCost = 0, totalReq = 0, cacheReadTok = 0, cacheSavedUSD = 0;

  for (const e of entries) {
    const d = localDate(e.ts);
    if (!byDay.has(d)) byDay.set(d, { total: 0, perModel: new Map() });
    const day = byDay.get(d);
    day.total += e.cost;
    day.perModel.set(e.model, (day.perModel.get(e.model) || 0) + e.cost);
    const dt = new Date(e.ts);
    heat[(dt.getDay() + 6) % 7][dt.getHours()] += e.cost;

    if (!byModel.has(e.model)) {
      byModel.set(e.model, { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, count: 0 });
    }
    const m = byModel.get(e.model);
    const u = e.usage;
    m.cost += e.cost; m.count += 1;
    m.input += u.input_tokens || 0; m.output += u.output_tokens || 0;
    m.cacheRead += u.cache_read_input_tokens || 0;
    m.cacheWrite += u.cache_creation_input_tokens || 0;
    totalCost += e.cost; totalReq += 1;

    if (!byProject.has(e.project)) byProject.set(e.project, { cost: 0, count: 0 });
    const pr = byProject.get(e.project);
    pr.cost += e.cost; pr.count += 1;

    const cr = u.cache_read_input_tokens || 0;
    cacheReadTok += cr;
    const pin = inputPriceOf(e.model, e.ts); // intro-aware input price
    if (pin != null) {
      cacheSavedUSD += cr * pin * 0.9 / 1e6; // read costs 0.1x instead of 1x
      const cc = u.cache_creation;
      const w5 = cc ? (cc.ephemeral_5m_input_tokens || 0) : (u.cache_creation_input_tokens || 0);
      const w1 = cc ? (cc.ephemeral_1h_input_tokens || 0) : 0;
      const net = (cr * 0.9 - w5 * 0.25 - w1 * 1.0) * pin / 1e6;
      cacheNetByDay.set(d, (cacheNetByDay.get(d) || 0) + net);
    }
  }

  // fill missing days so the bar chart has a continuous axis
  const dates = [];
  const start = new Date(); start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    dates.push(localDate(d.getTime()));
  }

  // model slot assignment: top 4 by cost get categorical slots, rest fold to 其他
  const ranked = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const slotOf = new Map();
  ranked.forEach(([model], i) => { if (i < SLOTS.length) slotOf.set(model, i); });

  const blocks = computeBlocks(entries);
  return {
    byDay, byModel, byProject, cacheNetByDay, heat, dates, ranked, slotOf, blocks,
    totalCost, totalReq, cacheReadTok, cacheSavedUSD,
  };
}

// ---------------------------------------------------------------------------
// SVG builders (hand-written, no dependencies)
// ---------------------------------------------------------------------------

/** Bar with rounded top corners anchored to the baseline. */
function roundTopRect(x, y, w, h, r) {
  if (h <= 0.5) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

const colorVar = i => (i == null ? 'var(--other)' : `var(--s${i + 1})`);

/** Chart 1: stacked daily cost bars (top models + 其他). */
function dailyChart({ byDay, dates, slotOf }) {
  const W = 960, H = 260, padL = 48, padR = 12, padT = 18, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const totals = dates.map(d => byDay.get(d)?.total || 0);
  const maxV = Math.max(1e-6, ...totals);
  const step = plotW / dates.length;
  const barW = Math.max(3, Math.min(40, step - 4));

  // y gridlines at nice intervals
  const ticks = 4;
  let grid = '';
  for (let i = 0; i <= ticks; i++) {
    const v = maxV / ticks * i;
    const y = padT + plotH - (v / maxV) * plotH;
    grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" class="grid"/>`
      + (i > 0 ? `<text x="${padL - 6}" y="${y + 4}" class="axis" text-anchor="end">$${Math.round(v)}</text>` : '');
  }

  let bars = '', labels = '';
  const maxIdx = totals.indexOf(Math.max(...totals));
  dates.forEach((d, i) => {
    const day = byDay.get(d);
    const x = padL + i * step + (step - barW) / 2;
    if (day && day.total > 0) {
      // stack segments in fixed slot order, 其他 last
      const segs = [...day.perModel.entries()]
        .map(([m, c]) => ({ m, c, slot: slotOf.has(m) ? slotOf.get(m) : null }))
        .sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
      let yTop = padT + plotH;
      const hTotal = (day.total / maxV) * plotH;
      segs.forEach((s, si) => {
        const h = (s.c / maxV) * plotH;
        yTop -= h;
        const isTop = si === segs.length - 1;
        const shape = isTop
          ? `<path d="${roundTopRect(x, yTop, barW, h, 3)}" fill="${colorVar(s.slot)}" class="seg" data-tip="${esc(d + '　' + shortModel(s.m) + '　' + usd(s.c))}"/>`
          : `<rect x="${x}" y="${yTop}" width="${barW}" height="${Math.max(0, h)}" fill="${colorVar(s.slot)}" class="seg" data-tip="${esc(d + '　' + shortModel(s.m) + '　' + usd(s.c))}"/>`;
        bars += shape;
      });
      // selective direct labels: peak day and the last (today) bar only
      if (i === maxIdx || i === dates.length - 1) {
        labels += `<text x="${x + barW / 2}" y="${padT + plotH - hTotal - 5}" class="dlabel" text-anchor="middle">${usd(day.total)}</text>`;
      }
    }
    // x labels: every ~5th day + last
    if (i % Math.ceil(dates.length / 6) === 0 || i === dates.length - 1) {
      labels += `<text x="${x + barW / 2}" y="${H - 8}" class="axis" text-anchor="middle">${d.slice(5)}</text>`;
    }
  });

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="按天成本柱状图">
${grid}<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" class="base"/>
${bars}${labels}</svg>`;
}

/** Chart 2: cost by model, horizontal bars with entity colors. */
function modelChart({ ranked, slotOf, totalCost }) {
  const rows = ranked.slice(0, 8);
  const W = 960, rowH = 34, padL = 150, padR = 90, padT = 6;
  const H = padT + rows.length * rowH + 6;
  const plotW = W - padL - padR;
  const maxV = Math.max(1e-6, ...rows.map(([, m]) => m.cost));
  let bars = '';
  rows.forEach(([model, m], i) => {
    const y = padT + i * rowH + 6;
    const w = Math.max(2, (m.cost / maxV) * plotW);
    const slot = slotOf.has(model) ? slotOf.get(model) : null;
    const share = totalCost > 0 ? Math.round(m.cost / totalCost * 100) : 0;
    bars += `<text x="${padL - 8}" y="${y + 15}" class="ylabel" text-anchor="end">${esc(shortModel(model))}</text>
<rect x="${padL}" y="${y}" width="${w}" height="20" rx="3" fill="${colorVar(slot)}" class="seg" data-tip="${esc(shortModel(model) + '　' + usd(m.cost) + '　' + m.count + '次请求　输出' + tok(m.output))}"/>
<text x="${padL + w + 8}" y="${y + 15}" class="dlabel">${usd(m.cost)} <tspan class="muted">${share}%</tspan></text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="模型成本分布">${bars}</svg>`;
}

/** Chart 3: 5h block timeline — one row per day, blocks placed on a 0-24h axis. */
function blocksChart({ blocks }, days = 7) {
  const W = 960, rowH = 30, padL = 64, padR = 12, padT = 22, padB = 6;
  const dayList = [];
  const start = new Date(); start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    dayList.push({ label: localDate(d.getTime()), startMs: d.getTime() });
  }
  const H = padT + dayList.length * rowH + padB;
  const plotW = W - padL - padR;
  const xOf = frac => padL + frac * plotW;

  let axis = '';
  for (let h = 0; h <= 24; h += 6) {
    const x = xOf(h / 24);
    axis += `<line x1="${x}" y1="${padT - 4}" x2="${x}" y2="${H - padB}" class="grid"/>`
      + `<text x="${x}" y="${padT - 8}" class="axis" text-anchor="middle">${h}:00</text>`;
  }

  const maxCost = Math.max(1e-6, ...blocks.map(b => b.agg.cost));
  let rects = '';
  for (const b of blocks) {
    // clip block to each day-row it overlaps
    for (const day of dayList) {
      const dayEnd = day.startMs + 86400000;
      const s = Math.max(b.startMs, day.startMs);
      const e = Math.min(b.active ? Date.now() : Math.min(b.lastTs + 60000, b.endMs), dayEnd);
      if (e <= s) continue;
      const y = padT + dayList.indexOf(day) * rowH + 5;
      const x1 = xOf((s - day.startMs) / 86400000);
      const x2 = xOf((e - day.startMs) / 86400000);
      const level = Math.min(SEQ.length - 1, Math.floor(b.agg.cost / maxCost * (SEQ.length - 0.01)));
      const tip = `${localDate(b.startMs)}　${new Date(b.startMs).toTimeString().slice(0, 5)}~${new Date(b.endMs).toTimeString().slice(0, 5)}　${usd(b.agg.cost)}　${tok(b.agg.input + b.agg.output)}tok` + (b.active ? '　⏳进行中' : '');
      rects += `<rect x="${x1}" y="${y}" width="${Math.max(2, x2 - x1)}" height="18" rx="4" fill="var(--q${level})" class="seg blockseg${b.active ? ' active' : ''}" data-tip="${esc(tip)}"/>`;
    }
  }
  const rows = dayList.map((d, i) =>
    `<text x="${padL - 8}" y="${padT + i * rowH + 19}" class="ylabel" text-anchor="end">${d.label.slice(5)}</text>`).join('');

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="5小时窗口时间线">${axis}${rows}${rects}</svg>`;
}

/** Chart 4: cost by project (top 8), horizontal single-hue bars. */
function projectChart({ byProject, totalCost }) {
  const rows = [...byProject.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 8);
  if (!rows.length) return '';
  const W = 960, rowH = 34, padL = 230, padR = 90, padT = 6;
  const H = padT + rows.length * rowH + 6;
  const plotW = W - padL - padR;
  const maxV = Math.max(1e-6, ...rows.map(([, p]) => p.cost));
  const label = name => {
    const p = prettyProject(name);
    return p.length > 30 ? '…' + p.slice(-29) : p;
  };
  let bars = '';
  rows.forEach(([proj, p], i) => {
    const y = padT + i * rowH + 6;
    const w = Math.max(2, (p.cost / maxV) * plotW);
    const share = totalCost > 0 ? Math.round(p.cost / totalCost * 100) : 0;
    bars += `<text x="${padL - 8}" y="${y + 15}" class="ylabel" text-anchor="end">${esc(label(proj))}</text>
<rect x="${padL}" y="${y}" width="${w}" height="20" rx="3" fill="var(--s1)" class="seg" data-tip="${esc(proj + '　' + usd(p.cost) + '　' + p.count + '次请求')}"/>
<text x="${padL + w + 8}" y="${y + 15}" class="dlabel">${usd(p.cost)} <tspan class="muted">${share}%</tspan></text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="项目成本分布">${bars}</svg>`;
}

/** Chart 5: daily net cache savings (positive above / negative below zero line). */
function cacheTrendChart({ cacheNetByDay, dates }) {
  const W = 960, H = 220, padL = 56, padR = 12, padT = 14, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const vals = dates.map(d => cacheNetByDay.get(d) || 0);
  const maxV = Math.max(1e-6, ...vals), minV = Math.min(0, ...vals);
  const span = maxV - minV;
  const yOf = v => padT + (maxV - v) / span * plotH;
  const zeroY = yOf(0);
  const step = plotW / dates.length;
  const barW = Math.max(3, Math.min(40, step - 4));
  let bars = '', labels = '';
  dates.forEach((d, i) => {
    const v = vals[i];
    if (Math.abs(v) < 1e-6) return;
    const x = padL + i * step + (step - barW) / 2;
    const y = v >= 0 ? yOf(v) : zeroY;
    const h = Math.abs(yOf(v) - zeroY);
    bars += `<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(1, h)}" rx="2" fill="${v >= 0 ? 'var(--s2)' : 'var(--s3)'}" class="seg" data-tip="${esc(d + '　净' + (v >= 0 ? '节省' : '倒贴') + usd(Math.abs(v)))}"/>`;
  });
  dates.forEach((d, i) => {
    if (i % Math.ceil(dates.length / 6) === 0 || i === dates.length - 1) {
      const x = padL + i * step + step / 2;
      labels += `<text x="${x}" y="${H - 8}" class="axis" text-anchor="middle">${d.slice(5)}</text>`;
    }
  });
  // top label only when there is a real positive peak, formatted like the tooltips
  const topLabel = maxV > 0.005 && Math.abs(yOf(maxV) - zeroY) > 12
    ? `<text x="${padL - 6}" y="${yOf(maxV) + 4}" class="axis" text-anchor="end">${usd(maxV)}</text>` : '';
  const grid = `<line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" class="base"/>`
    + topLabel
    + `<text x="${padL - 6}" y="${zeroY + 4}" class="axis" text-anchor="end">$0</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="缓存净节省趋势">${grid}${bars}${labels}</svg>`;
}

/** Monday (local) of the week containing a Date, as a Date at local midnight. */
function mondayOf(d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - (x.getDay() + 6) % 7);
  return x;
}

/** Seven local date strings starting at a Date (DST-safe via setDate). */
function weekDates(mon) {
  const out = [];
  const d = new Date(mon);
  for (let i = 0; i < 7; i++) {
    out.push(localDate(d.getTime()));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/**
 * Chart 6: this calendar week vs last week, grouped bars per weekday.
 * Reads weekByDay (date -> cost), built from a load that always covers both
 * full weeks regardless of the report's --days range.
 */
function weekCompareChart({ weekByDay = new Map(), weekPrevSameUsd }) {
  const thisMon = mondayOf(new Date());
  const lastMon = new Date(thisMon); lastMon.setDate(lastMon.getDate() - 7);
  const curDates = weekDates(thisMon), prevDates = weekDates(lastMon);
  const cur = curDates.map(d => weekByDay.get(d) || 0);
  const prev = prevDates.map(d => weekByDay.get(d) || 0);
  const curTotal = cur.reduce((a, b) => a + b, 0), prevTotal = prev.reduce((a, b) => a + b, 0);
  const W = 960, H = 240, padL = 48, padR = 12, padT = 18, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxV = Math.max(1e-6, ...cur, ...prev);
  const group = plotW / 7, barW = Math.min(34, (group - 16) / 2);
  const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  let bars = '', labels = '';
  for (let i = 0; i < 7; i++) {
    const x0 = padL + i * group + (group - barW * 2 - 4) / 2;
    const pair = [
      { v: prev[i], fill: 'var(--other)', tag: `上周${names[i]}（${prevDates[i]}）` },
      { v: cur[i], fill: 'var(--s1)', tag: `本周${names[i]}（${curDates[i]}）` },
    ];
    pair.forEach((p, k) => {
      if (p.v <= 0) return;
      const h = Math.max(1.5, p.v / maxV * plotH); // tiny but nonzero stays visible
      bars += `<path d="${roundTopRect(x0 + k * (barW + 4), padT + plotH - h, barW, h, 3)}" fill="${p.fill}" class="seg" data-tip="${esc(p.tag + '　' + usd(p.v))}"/>`;
    });
    labels += `<text x="${padL + i * group + group / 2}" y="${H - 8}" class="axis" text-anchor="middle">${names[i]}</text>`;
  }
  const base = `<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" class="base"/>`;
  // fair delta: this week so far vs the same elapsed wall-clock time of last
  // week (computed from raw entries by generateReport — same口径 as cmdAll);
  // fall back to whole elapsed weekdays when the precise value is unavailable
  const todayIdx = (new Date().getDay() + 6) % 7;
  const prevSame = Number.isFinite(weekPrevSameUsd)
    ? weekPrevSameUsd
    : prev.slice(0, todayIdx + 1).reduce((a, b) => a + b, 0);
  const deltaTxt = prevSame > 0.01
    ? `较上周同期${curTotal >= prevSame ? '+' : '−'}${Math.abs(Math.round((curTotal - prevSame) / prevSame * 100))}%`
    : '';
  const legend = `<div class="legend"><span class="li"><span class="sw" style="background:var(--s1)"></span>本周${usd(curTotal)}</span>`
    + `<span class="li"><span class="sw" style="background:var(--other)"></span>上周全周${usd(prevTotal)}</span>`
    + (deltaTxt ? `<span class="li muted2">${esc(deltaTxt)}</span>` : '') + `</div>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="本周与上周成本对比">${base}${bars}${labels}</svg>${legend}`;
}

/** Chart 7: weekday × hour cost heatmap over the report range. */
function heatmapChart({ heat }) {
  const W = 960, padL = 64, padR = 12, padT = 22, padB = 6, rowH = 26;
  const H = padT + 7 * rowH + padB;
  const plotW = W - padL - padR, cellW = plotW / 24;
  const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const maxV = Math.max(1e-6, ...heat.flat());
  let cells = '', axis = '', rows = '';
  for (let h = 0; h <= 24; h += 3) {
    axis += `<text x="${padL + h * cellW}" y="${padT - 8}" class="axis" text-anchor="middle">${h}</text>`;
  }
  for (let d = 0; d < 7; d++) {
    rows += `<text x="${padL - 8}" y="${padT + d * rowH + rowH / 2 + 4}" class="ylabel" text-anchor="end">${names[d]}</text>`;
    for (let h = 0; h < 24; h++) {
      const v = heat[d][h];
      if (v <= 0) continue;
      const level = Math.min(5, Math.floor(v / maxV * 5.99));
      cells += `<rect x="${padL + h * cellW + 1}" y="${padT + d * rowH + 1}" width="${cellW - 2}" height="${rowH - 2}" rx="3" fill="var(--q${level})" class="seg" data-tip="${esc(`${names[d]} ${h}:00～${h + 1}:00　${usd(v)}`)}"/>`;
    }
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="星期与小时用量热力图">${axis}${rows}${cells}</svg>`;
}

/** mcp__server__tool → server:tool (same shortening as the tools command). */
const shortTool = n => String(n).replace(/^mcp__(.+?)__/, '$1:');

/** Chart 8: tool call frequency, top 10 horizontal bars. */
function toolsChart(toolStats) {
  const rows = [...toolStats.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 10);
  if (!rows.length) return '';
  const W = 960, rowH = 30, padL = 190, padR = 130, padT = 6;
  const H = padT + rows.length * rowH + 6;
  const plotW = W - padL - padR;
  const maxV = Math.max(1, ...rows.map(([, s]) => s.count));
  const total = [...toolStats.values()].reduce((s, v) => s + v.count, 0);
  const label = n => n.length > 26 ? '…' + n.slice(-25) : n; // keep the tail (tool name)
  let bars = '';
  rows.forEach(([name, s], i) => {
    const y = padT + i * rowH + 5;
    const w = Math.max(2, (s.count / maxV) * plotW);
    const share = total > 0 ? Math.round(s.count / total * 100) : 0;
    const errTxt = s.errors ? `　${s.errors}次出错` : '';
    bars += `<text x="${padL - 8}" y="${y + 14}" class="ylabel" text-anchor="end">${esc(label(shortTool(name)))}</text>
<rect x="${padL}" y="${y}" width="${w}" height="18" rx="3" fill="var(--s4)" class="seg" data-tip="${esc(shortTool(name) + '　' + s.count + '次调用' + errTxt)}"/>
<text x="${padL + w + 8}" y="${y + 14}" class="dlabel">${s.count} <tspan class="muted">${share}%${s.errors ? '，错' + s.errors : ''}</tspan></text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="工具调用Top 10">${bars}</svg>`;
}

// ---------------------------------------------------------------------------
// Page assembly
// ---------------------------------------------------------------------------

function statTiles(data, entries) {
  const now = Date.now();
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const sum = since => entries.reduce((s, e) => s + (e.ts >= since ? e.cost : 0), 0);
  const tiles = [
    { label: '今日成本', value: usd(sum(midnight.getTime())) },
    { label: '近7天', value: usd(data.cost7d ?? sum(now - 7 * 86400000)) },
    { label: '统计区间合计', value: usd(data.totalCost) },
    { label: '请求总数', value: data.totalReq.toLocaleString('en-US') },
    { label: '缓存节省（约）', value: usd(data.cacheSavedUSD), hint: `缓存读取${tok(data.cacheReadTok)}` },
  ];
  return tiles.map(t => `<div class="tile"><div class="tlabel">${t.label}</div><div class="tvalue">${t.value}</div>${t.hint ? `<div class="thint">${t.hint}</div>` : ''}</div>`).join('');
}

function legendHtml({ ranked, slotOf }) {
  const items = ranked.slice(0, SLOTS.length)
    .map(([m], i) => `<span class="li"><span class="sw" style="background:${colorVar(i)}"></span>${esc(shortModel(m))}</span>`);
  if (ranked.length > SLOTS.length) {
    items.push(`<span class="li"><span class="sw" style="background:var(--other)"></span>其他</span>`);
  }
  return `<div class="legend">${items.join('')}</div>`;
}

function dataTable({ byDay, dates }) {
  const rows = dates.filter(d => byDay.has(d)).map(d => {
    const day = byDay.get(d);
    const models = [...day.perModel.entries()].sort((a, b) => b[1] - a[1])
      .map(([m, c]) => `${esc(shortModel(m))} ${usd(c)}`).join('，');
    return `<tr><td>${d}</td><td class="num">${usd(day.total)}</td><td>${models}</td></tr>`;
  }).join('');
  return `<details><summary>查看数据表</summary>
<table><thead><tr><th>日期</th><th class="num">成本</th><th>按模型</th></tr></thead><tbody>${rows}</tbody></table></details>`;
}

const DARK_VARS = `color-scheme: dark;
    --surface: #1a1a19; --page: #0d0d0d;
    --ink: #ffffff; --ink2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --base: #383835; --ring: rgba(255,255,255,0.10);
    --s1: #3987e5; --s2: #008300; --s3: #d55181; --s4: #c98500;
    --q0: #0d366b; --q1: #104281; --q2: #1c5cab; --q3: #2a78d6; --q4: #5598e7; --q5: #86b6ef;`;

export function buildHtml(data, entries, days) {
  const gen = new Date().toLocaleString('zh-CN', { hour12: false });
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Code用量报告</title>
<style>
:root {
  color-scheme: light;
  --surface: #fcfcfb; --page: #f9f9f7;
  --ink: #0b0b0b; --ink2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --base: #c3c2b7; --ring: rgba(11,11,11,0.10);
  --s1: #2a78d6; --s2: #008300; --s3: #e87ba4; --s4: #eda100; --other: #898781;
  --q0: #cde2fb; --q1: #9ec5f4; --q2: #6da7ec; --q3: #3987e5; --q4: #256abf; --q5: #184f95;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { ${DARK_VARS} }
}
:root[data-theme="dark"] { ${DARK_VARS} }
* { box-sizing: border-box; margin: 0; }
body { background: var(--page); color: var(--ink); font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; padding: 24px; max-width: 1040px; margin: 0 auto; }
h1 { font-size: 20px; margin-bottom: 4px; }
.sub { color: var(--muted); font-size: 12px; margin-bottom: 20px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
.tile { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; padding: 14px 16px; }
.tlabel { color: var(--ink2); font-size: 12px; margin-bottom: 6px; }
.tvalue { font-size: 26px; font-weight: 650; }
.thint { color: var(--muted); font-size: 11px; margin-top: 4px; }
.card { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; padding: 16px 18px; margin-bottom: 18px; }
.card h2 { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
svg { width: 100%; height: auto; display: block; }
.grid { stroke: var(--grid); stroke-width: 1; }
.base { stroke: var(--base); stroke-width: 1; }
.axis { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.ylabel { fill: var(--ink2); font-size: 12px; }
.dlabel { fill: var(--ink2); font-size: 11px; font-variant-numeric: tabular-nums; }
.muted { fill: var(--muted); }
.seg { stroke: var(--surface); stroke-width: 1; cursor: default; }
.seg:hover { opacity: 0.85; }
.blockseg.active { stroke: var(--ink); stroke-width: 1.5; }
.legend { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 10px; font-size: 12px; color: var(--ink2); }
.muted2 { color: var(--muted); }
.li { display: inline-flex; align-items: center; gap: 6px; }
.sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
details { margin-top: 12px; font-size: 13px; }
summary { color: var(--ink2); cursor: pointer; }
table { border-collapse: collapse; width: 100%; margin-top: 8px; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--grid); font-size: 12px; }
.num { text-align: right; }
#tip { position: fixed; pointer-events: none; background: var(--ink); color: var(--page); padding: 6px 10px; border-radius: 6px; font-size: 12px; opacity: 0; transition: opacity 0.08s; z-index: 9; white-space: nowrap; }
footer { color: var(--muted); font-size: 11px; margin-top: 8px; }
#themeBtn { position: fixed; top: 16px; right: 16px; z-index: 10; background: var(--surface); color: var(--ink); border: 1px solid var(--ring); border-radius: 8px; padding: 6px 10px; font-size: 15px; cursor: pointer; line-height: 1; }
#themeBtn:hover { border-color: var(--muted); }
</style></head><body>
<button id="themeBtn" title="切换主题">🌓</button>
<h1>Claude Code用量报告</h1>
<div class="sub">统计区间：最近${days}天　·　生成于${esc(gen)}　·　成本为API等价估算</div>
<div class="tiles">${statTiles(data, entries)}</div>
<div class="card"><h2>每日成本（按模型堆叠）</h2>${dailyChart(data)}${legendHtml(data)}${dataTable(data)}</div>
<div class="card"><h2>本周vs上周（按星期对比）</h2>${weekCompareChart(data)}</div>
<div class="card"><h2>用量热力图（星期×小时，颜色=累计成本）</h2>${heatmapChart(data)}</div>
<div class="card"><h2>模型成本分布</h2>${modelChart(data)}</div>
<div class="card"><h2>项目成本分布（Top 8）</h2>${projectChart(data)}</div>
${data.toolStats && data.toolStats.size ? `<div class="card"><h2>工具调用Top 10</h2>${toolsChart(data.toolStats)}</div>` : ''}
<div class="card"><h2>缓存净节省趋势（读省下−写溢价）</h2>${cacheTrendChart(data)}</div>
<div class="card"><h2>5小时限额窗口（最近7天，颜色深浅=窗口成本）</h2>${blocksChart(data)}</div>
<footer>claude-usage-monitor · 数据来自本地会话记录，未上传任何内容</footer>
<div id="tip"></div>
<script>
// theme toggle: auto → dark → light, persisted
const tbtn = document.getElementById('themeBtn');
const THEME_KEY = 'usage-monitor-theme';
function applyTheme(m) {
  if (m === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', m);
  tbtn.textContent = m === 'dark' ? '🌙' : m === 'light' ? '☀️' : '🌓';
  tbtn.title = '主题：' + (m === 'auto' ? '跟随系统' : m === 'dark' ? '深色' : '浅色') + '（点击切换）';
}
let themeMode = 'auto';
try { themeMode = localStorage.getItem(THEME_KEY) || 'auto'; } catch {}
applyTheme(themeMode);
tbtn.addEventListener('click', () => {
  themeMode = themeMode === 'auto' ? 'dark' : themeMode === 'dark' ? 'light' : 'auto';
  try { localStorage.setItem(THEME_KEY, themeMode); } catch {}
  applyTheme(themeMode);
});

const tip = document.getElementById('tip');
document.addEventListener('pointerover', e => {
  const t = e.target.closest('[data-tip]');
  if (!t) { tip.style.opacity = 0; return; }
  tip.textContent = t.dataset.tip;
  tip.style.opacity = 1;
});
document.addEventListener('pointermove', e => {
  const pad = 14;
  let x = e.clientX + pad, y = e.clientY + pad;
  const r = tip.getBoundingClientRect();
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
});
document.addEventListener('pointerout', e => {
  if (!e.relatedTarget || !e.relatedTarget.closest('[data-tip]')) tip.style.opacity = 0;
});
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function generateReport({ days = 30, out, open = true } = {}) {
  // load enough to cover both the report range and the full last calendar week,
  // so the week-compare chart never sees a truncated "last week"
  const lastMon = mondayOf(new Date()); lastMon.setDate(lastMon.getDate() - 7);
  const now = Date.now();
  const sinceMs = Math.min(now - (days + 1) * 86400000, lastMon.getTime() - 86400000,
    now - 8 * 86400000);
  // DST-safe range start (must agree with the setDate-built chart axes)
  const startD = new Date(); startD.setHours(0, 0, 0, 0);
  startD.setDate(startD.getDate() - (days - 1));
  const rangeStart = startD.getTime();
  const toolSink = newToolSink();
  toolSink.sinceMs = rangeStart; // tool stats honor the report range, not the wider load
  const raw = await loadEntries({ sinceMs, toolSink });
  const entries = raw.filter(e => e.ts >= rangeStart);
  const data = prepareData(entries, days);
  data.toolStats = toolSink.byName;
  // widen two range-independent views: the 近7天 tile and the 7-day block
  // timeline always cover a full week even when --days is smaller
  data.cost7d = raw.reduce((s, e) => s + (e.ts >= now - 7 * 86400000 ? e.cost : 0), 0);
  data.blocks = computeBlocks(raw.filter(e => e.ts >= now - 8 * 86400000));
  // full two-week daily costs for the week-compare chart (independent of --days)
  const weekByDay = new Map();
  for (const e of raw) {
    if (e.ts < lastMon.getTime()) continue;
    const d = localDate(e.ts);
    weekByDay.set(d, (weekByDay.get(d) || 0) + e.cost);
  }
  data.weekByDay = weekByDay;
  // last week up to the same elapsed wall-clock time (same口径 as cmdAll仪表盘)
  const thisMon = mondayOf(new Date());
  const sameCut = lastMon.getTime() + (now - thisMon.getTime());
  data.weekPrevSameUsd = raw.reduce((s, e) =>
    s + (e.ts >= lastMon.getTime() && e.ts < sameCut ? e.cost : 0), 0);
  const html = buildHtml(data, entries, days);
  const outPath = out || path.join(os.tmpdir(), 'claude-usage-report.html');
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`报告已生成：${outPath}`);
  if (open) {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', outPath]]
      : process.platform === 'darwin' ? ['open', [outPath]]
      : ['xdg-open', [outPath]];
    try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); }
    catch { console.log('请手动在浏览器中打开上述文件。'); }
  }
  return outPath;
}

// Run directly: node report.mjs [--days N] [--out path] [--no-open]
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const argv = process.argv.slice(2);
  const opts = { days: 30, open: !argv.includes('--no-open') };
  const di = argv.indexOf('--days'); if (di >= 0) opts.days = Number(argv[di + 1]) || 30;
  const oi = argv.indexOf('--out'); if (oi >= 0) opts.out = argv[oi + 1];
  generateReport(opts).catch(err => { console.error('生成报告失败：', err.message); process.exitCode = 1; });
}
