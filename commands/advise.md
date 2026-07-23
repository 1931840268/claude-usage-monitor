---
description: 用量优化建议：缓存/上下文/触顶/模型组合/订阅性价比的个性化诊断
allowed-tools: Bash(node:*)
---

## 数据

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" advise`

## 任务

上面是基于用户真实用量数据生成的优化建议（每条附数字依据）。请原样展示，然后：

1. 挑出其中标为「省钱」或「提醒」的条目，各用一两句话展开成可立即执行的操作；
2. 「健康」条目一句话带过；
3. 若用户想深入某一项，指引对应命令（cache/context/hours/blocks/models）。
