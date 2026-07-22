---
description: 工具调用统计：各工具使用频次、分布与错误率（默认最近7天）
argument-hint: [天数]
allowed-tools: Bash(node:*)
---

## 数据

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" tools --days "$ARGUMENTS"`

## 任务

上面是按工具汇总的调用统计（用户传入的天数参数为「$ARGUMENTS」，为空时默认7天）。请原样展示表格，然后用一两句中文提炼要点：

1. 使用最多的前三个工具及其占比；
2. 若某个工具错误率明显偏高（≥10%且调用数不少于10次），醒目指出并提示可能的原因方向。
