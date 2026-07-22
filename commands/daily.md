---
description: 按天用量报表（默认最近7天，可传天数参数）
argument-hint: [天数]
allowed-tools: Bash(node:*)
---

## 数据

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" daily --days "$ARGUMENTS"`

## 任务

上面是按天的用量报表（用户传入的天数参数为「$ARGUMENTS」，为空时默认7天）。请原样展示表格，然后用一两句中文点评趋势：哪天用量最高、平均每天成本、最近是否在上升。
