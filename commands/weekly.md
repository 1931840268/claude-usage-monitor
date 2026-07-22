---
description: 按周用量报表（默认最近8周）
argument-hint: [周数]
allowed-tools: Bash(node:*)
---

## 数据

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" weekly --weeks "$ARGUMENTS"`

## 任务

上面是按周汇总的用量报表（用户传入的周数参数为「$ARGUMENTS」，为空时默认8周）。请原样展示表格，并用一两句中文点评：周均成本、最贵的一周、近期趋势是升还是降。
