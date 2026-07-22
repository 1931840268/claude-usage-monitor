---
description: 5小时限额窗口列表与当前窗口刷新时间（默认最近3天）
argument-hint: [天数]
allowed-tools: Bash(node:*)
---

## 数据

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" blocks --days "$ARGUMENTS"`

## 任务

上面是本地估算的5小时限额窗口（与Anthropic官方窗口对齐：窗口起点为首次活动整点，持续5小时）。请原样展示表格；如果存在「进行中」的窗口，突出说明它的刷新时间、剩余时长和当前燃烧率，并提示按当前速度到窗口结束大约会再消耗多少token（燃烧率×剩余分钟数）。
