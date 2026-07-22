---
description: 会话成本排行（默认Top 10，可传数量参数）
argument-hint: [数量]
allowed-tools: Bash(node:*)
---

## 数据

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" sessions --top "$ARGUMENTS"`

## 任务

上面是按成本排序的会话排行（用户传入的数量参数为「$ARGUMENTS」，为空时默认10）。请原样展示表格，并指出成本最高的会话属于哪个项目、大概花了多少钱。
