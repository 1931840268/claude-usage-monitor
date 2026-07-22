---
description: 全部历史按模型汇总的token用量与成本
allowed-tools: Bash(node:*)
---

## 数据

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" models`

## 任务

上面是全部历史记录按模型汇总的用量。请原样展示表格，并用一两句中文总结：主力模型是哪个、成本占比多少、缓存读命中量级（缓存读省了大量成本，可按缓存读token×0.9×该模型输入单价粗算节省金额）。
