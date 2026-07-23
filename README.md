<div align="center">

# claude-usage-monitor

**The only Claude Code usage plugin that reads your official rate limits — plus per-task attribution, ROI analytics, and a built-in advice engine. Zero dependencies.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-blue.svg)](package.json)
[![GitHub Release](https://img.shields.io/github/v/release/1931840268/claude-usage-monitor)](https://github.com/1931840268/claude-usage-monitor/releases)
[![GitHub Stars](https://img.shields.io/github/stars/1931840268/claude-usage-monitor?style=social)](https://github.com/1931840268/claude-usage-monitor)

[中文文档（完整版）](README_zh.md) · Interface is currently Chinese-first — numbers, bars and charts read universally; English UI is on the roadmap.

<img src="docs/assets/dashboard.png" width="820" alt="all-in-one dashboard" />

</div>

## Why this one?

Every usage tracker can add up your tokens. This one answers the questions the others can't:

| Capability | ccusage | Usage&nbsp;Monitor | **this plugin** |
| --- | :-: | :-: | :-: |
| Reads **official rate limits** from Anthropic's API (no guessing, no P90 estimates) | – | partial | **✓ 5h / 7d / per-model weekly, with reset times** |
| **Per-task attribution** — sessions show *what you asked for*, not UUIDs | – | – | **✓** |
| **ROI analytics** — actions per $, edit ops, rework rate | – | – | **✓** |
| **Advice engine** — cache health, context bloat, model mix, limit hits | – | – | **✓** |
| **24h limit planner** — reset moments × your historical peak hours | – | – | **✓** |
| Plugin-native: slash commands, SessionStart hooks, statusline | – | – | **✓ 21 slash cmds** |
| **MCP tools** — let Claude query (and throttle) its own usage | – | – | **✓ 17 tools** |
| Auto daily / weekly briefings + archived HTML weekly reports | – | – | **✓** |
| Multi-device sync + team view | – | – | **✓** |
| Anomaly burn sentinel (runaway agent loops flagged in ~1 min) | – | – | **✓** |
| Zero-dependency HTML report (8 charts, light/dark) | – | – | **✓** |
| Dependencies | Rust binary | Python pkgs | **0** |

*Your usage report finds you — not the other way around*: the SessionStart hook drops yesterday's summary, weekly recap and limit warnings right into your session.

## Quick start

```bash
# Try it in 10 seconds — no install, works anywhere Node >= 18 lives
npx github:1931840268/claude-usage-monitor all
```

```bash
# Full plugin install (slash commands + hooks + statusline + MCP)
claude plugin marketplace add 1931840268/claude-usage-monitor
claude plugin install usage-monitor@usage-monitor-market
```

Then inside Claude Code: `/usage-monitor:usage` for the dashboard, `/usage-monitor:advise` for personalized savings tips.

## What it looks like

| ROI — what did each dollar buy | 24h limit planner |
| --- | --- |
| <img src="docs/assets/roi.png" alt="roi" /> | <img src="docs/assets/plan.png" alt="plan" /> |

<details>
<summary><b>Zero-dependency HTML report (8 charts, light/dark, theme toggle)</b></summary>
<img src="docs/assets/report.png" alt="html report" />
</details>

<details>
<summary><b>Shareable monthly card (SVG, generated locally)</b></summary>
<img src="docs/assets/card.svg" width="640" alt="monthly card" />
</details>

## Feature map

- **Official truth** — `limits` (real quotas + reset times + exit codes for scripting), `blocks` (ccusage-compatible 5h windows), time-to-limit ETA, rate-limit hit markers.
- **Deep analytics** — `sessions` (task titles), `roi` (rework rate), `context` (context-size cost bands), `hours` (weekday×hour heatmap), `errors` (API failure taxonomy), `tools`, `projects`, `cache`.
- **Decisions, not just numbers** — `advise` engine, `plan` 24h timeline, monthly forecast + subscription-value multiple on the dashboard.
- **Automation** — SessionStart hook: daily brief, weekly recap, archived HTML weekly reports, limit warnings, background multi-device sync; statusline with anomaly burn sentinel.
- **Integrations** — 21 slash commands, 17 MCP tools (`usage_dashboard`, `usage_advise`, `usage_roi`, …), `--json` everywhere, `--csv` exports, `live` terminal dashboard, `card` monthly SVG, `doctor` self-check.
- **Team & fleet** — folder-based auto sync (`sync_dir`), per-device/member `team` view, strict import sanitization.

Full command reference, configuration keys and FAQ: **[中文文档](README_zh.md)**.

## Privacy

Everything runs locally against `~/.claude` transcripts. No telemetry, no uploads; the official-limits call goes only to Anthropic's own endpoint with your existing credentials. Screenshots above use synthetic demo data.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=1931840268/claude-usage-monitor&type=Date)](https://star-history.com/#1931840268/claude-usage-monitor&Date)

## License

[MIT](LICENSE)
