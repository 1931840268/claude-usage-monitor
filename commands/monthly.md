---
description: 按月用量报表（默认最近6个月，含历史快照数据）
argument-hint: [月数]
allowed-tools: Bash(node:*)
---

## 数据

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" monthly --months "$ARGUMENTS"`

## 任务

上面是按月汇总的用量报表（用户传入的月数参数为「$ARGUMENTS」，为空时默认6个月；早于本地日志保留期的数据来自插件的每日快照仓库）。请原样展示表格，并用一两句中文点评：月均成本与趋势。
