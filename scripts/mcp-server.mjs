#!/usr/bin/env node
/**
 * claude-usage-monitor — MCP server (stdio, JSON-RPC 2.0, zero-dependency).
 * Exposes usage statistics as MCP tools by delegating each call to
 * `usage.mjs <cmd> --json` in a child process, so any MCP client
 * (Claude Code, Claude Desktop, ...) can query local Claude Code usage.
 *
 * Protocol: newline-delimited JSON-RPC on stdio; logs go to stderr only.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const USAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'usage.mjs');
// version always mirrors the plugin manifest — never drifts on release
let VERSION = '0.0.0';
try {
  const { readFileSync } = await import('node:fs');
  VERSION = JSON.parse(readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json'),
    'utf8')).version || VERSION;
} catch { /* keep fallback */ }

// name / description / numeric args (mapped to --flags) / usage.mjs subcommand
const TOOLS = [
  { name: 'usage_dashboard', cmd: ['all'], args: [],
    description: 'Claude Code用量整合仪表盘：今日/近7天/近30天成本、本周对比、官方限额、当前5小时窗口、14天趋势、今日模型分布、项目Top（JSON）' },
  { name: 'usage_today', cmd: ['today'], args: [],
    description: '今日按模型的token用量与成本，含较昨日此时对比' },
  { name: 'usage_daily', cmd: ['daily'], args: ['days'],
    description: '按天用量报表（days默认7，本地自然日，含历史快照与已导入设备）' },
  { name: 'usage_blocks', cmd: ['blocks'], args: ['days'],
    description: '5小时限额窗口列表（本地估算，含燃烧率、活动窗口与官方触顶标注；days默认3）' },
  { name: 'usage_limits', cmd: ['limits'], args: [],
    description: 'Anthropic官方限额利用率：5小时/7天窗口、各模型周配额、刷新时间（需订阅凭据）' },
  { name: 'usage_tools', cmd: ['tools'], args: ['days'],
    description: '工具调用频次与错误率统计（days默认7）' },
  { name: 'usage_sessions', cmd: ['sessions'], args: ['top', 'days'],
    description: '会话成本排行（top默认10）' },
  { name: 'usage_projects', cmd: ['projects'], args: ['days', 'top'],
    description: '按项目目录的用量统计（days默认30）' },
  { name: 'usage_cache', cmd: ['cache'], args: ['days'],
    description: '缓存效率：命中率、读省下、写溢价、净节省（days默认30）' },
  { name: 'usage_team', cmd: ['team'], args: ['days'],
    description: '团队视图：本机＋已同步设备/成员的成本汇总（days默认30）' },
  { name: 'usage_hours', cmd: ['hours'], args: ['days'],
    description: '用量热力：星期×小时的成本分布矩阵，找高峰时段（days默认30）' },
  { name: 'usage_doctor', cmd: ['doctor'], args: [],
    description: '插件环境自检：版本一致性、配置合法性、数据源、凭据、钩子、同步目录' },
  { name: 'usage_context', cmd: ['context'], args: ['days'],
    description: '上下文规模分析：各档位请求数与成本占比、百分位（days默认7）' },
  { name: 'usage_advise', cmd: ['advise'], args: ['days'],
    description: '用量优化建议：缓存健康、上下文肥胖、触顶、模型组合、订阅性价比（days默认14）' },
  { name: 'usage_errors', cmd: ['errors'], args: ['days'],
    description: 'API错误分类统计：限流/过载/超时/网络/认证（days默认7）' },
  { name: 'usage_roi', cmd: ['roi'], args: ['days', 'top'],
    description: '效率分析：每会话的每$动作数、编辑量、返工率（days默认7）' },
  { name: 'usage_plan', cmd: ['plan'], args: [],
    description: '未来24小时限额规划：5小时/7天刷新时刻与历史小时负载画像' },
];

function schemaFor(t) {
  const props = {};
  for (const a of t.args) {
    props[a] = { type: 'number', description: a === 'days' ? '统计天数' : '返回条数上限' };
  }
  return { type: 'object', properties: props, additionalProperties: false };
}

function runUsage(args) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(process.execPath, [USAGE, ...args, '--json'],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, out: '', err: String(e) });
    }
    let out = '', err = '';
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 60_000);
    child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, out: '', err: String(e) }); });
  });
}

const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(req) {
  const { id, method, params } = req;
  const reply = result => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }); };
  const fail = (code, message) => { if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message } }); };
  try {
    if (method === 'initialize') {
      reply({
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'usage-monitor', version: VERSION },
      });
    } else if (typeof method === 'string' && method.startsWith('notifications/')) {
      // notifications need no response
    } else if (method === 'ping') {
      reply({});
    } else if (method === 'tools/list') {
      reply({ tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: schemaFor(t) })) });
    } else if (method === 'tools/call') {
      const t = TOOLS.find(x => x.name === params?.name);
      if (!t) return fail(-32602, `unknown tool: ${params?.name}`);
      const args = [...t.cmd];
      for (const a of t.args) {
        const v = Number(params?.arguments?.[a]);
        if (Number.isFinite(v) && v > 0) args.push(`--${a}`, String(Math.floor(v)));
      }
      const r = await runUsage(args);
      if (r.code !== 0 || !r.out.trim()) {
        reply({
          content: [{ type: 'text', text: `usage.mjs执行失败（exit ${r.code}）：${(r.err || '无输出').slice(0, 500)}` }],
          isError: true,
        });
      } else {
        reply({ content: [{ type: 'text', text: r.out.trim() }] });
      }
    } else {
      fail(-32601, `method not found: ${method}`);
    }
  } catch (e) {
    fail(-32603, String(e?.message || e));
  }
}

// exit only after stdin closes AND every in-flight request has been answered
let pending = 0, stdinClosed = false;
const maybeExit = () => { if (stdinClosed && pending === 0) process.exit(0); };

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  line = line.trim();
  if (!line) return;
  let req;
  try { req = JSON.parse(line); } catch { return; } // ignore malformed frames
  pending += 1;
  handle(req)
    .catch(e => console.error('[usage-monitor mcp]', e))
    .finally(() => { pending -= 1; maybeExit(); });
});
rl.on('close', () => { stdinClosed = true; maybeExit(); });
