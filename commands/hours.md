---
description: 用量热力：星期×小时高峰分析（默认最近30天）
argument-hint: [天数]
allowed-tools: Bash(node:*)
---

## 数据

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" hours --days "$ARGUMENTS"`

## 任务

上面是星期×小时的用量热力图（用户传入的天数参数为「$ARGUMENTS」，为空时默认30天，字符深浅代表累计成本）。请原样展示，然后用一两句中文提炼：

1. 高峰时段分布规律（哪几天、什么时间段最集中）；
2. 结合5小时限额窗口机制给一条实用建议（如高峰时段前留意限额余量、把重活安排在窗口刚刷新后）。
