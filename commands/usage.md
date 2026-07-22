---
description: 整合仪表盘：成本速览、官方限额、当前5小时窗口、趋势、模型分布、项目Top（一屏全览）
allowed-tools: Bash(node:*)
---

## 数据

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" all`

## 任务

上面是Claude Code用量整合仪表盘（一条命令汇总全部关键指标）。请原样展示仪表盘内容，然后用两三句中文提炼要点：

1. 今日/近7天成本与趋势方向；
2. 官方限额里最紧张的窗口（百分比最高的那个）及其刷新时间——超过80%要醒目提醒；
3. 当前5小时窗口按燃烧率预计的最终消耗。

若用户想看某一项的完整明细，提示对应命令：/usage-monitor:daily、blocks、models、sessions、projects、cache、tools、limits、report、team（团队/多设备）、sync（立即同步）。
