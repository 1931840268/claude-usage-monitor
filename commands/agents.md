---
description: 子代理成本归因：Task／Workflow代理花了多少钱、各类型占比（默认最近7天）
argument-hint: [天数]
allowed-tools: Bash(node:*)
---

## 数据

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" agents --days "$ARGUMENTS"`

## 任务

上面是子代理（Task工具、Workflow编排产生的agent）成本归因（用户传入的天数参数为「$ARGUMENTS」，为空时默认7天）。请原样展示表格，然后：

1. 一句话点评子代理成本占总成本的比例是否值得关注（经验上超过20%说明多agent用得很重）；
2. 指出最花钱的代理类型，结合其请求数判断是「少量大任务」还是「高频小任务」；
3. 提醒用户可用`usage agents --session <会话id前缀>`下钻单个会话的fan-out成本树；
4. 若近期没有子代理记录，说明该统计只在用过Task/Workflow后才有数据即可。
