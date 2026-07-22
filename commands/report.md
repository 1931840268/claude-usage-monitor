---
description: 生成可视化HTML用量报告并在浏览器中打开（柱状图、模型分布、窗口时间线）
argument-hint: [天数]
allowed-tools: Bash(node:*)
---

## 执行结果

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" report --days "$ARGUMENTS"`

## 任务

上面是HTML用量报告的生成结果（用户传入的天数参数为「$ARGUMENTS」，为空时默认30天）。报告应已自动在浏览器中打开。请告诉用户：报告文件的路径、包含哪些内容（统计卡片、每日成本堆叠柱状图、模型成本分布、5小时窗口时间线、可展开的数据表），并说明报告支持亮暗两种主题、鼠标悬停可看明细。若生成失败，解释错误原因。
