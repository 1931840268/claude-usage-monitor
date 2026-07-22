---
description: 缓存效率分析：命中率与缓存为你节省的成本
allowed-tools: Bash(node:*)
---

## 数据

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" cache`

## 任务

上面是提示缓存（prompt caching）的效率分析。请原样展示表格，并用通俗的中文解释：缓存命中率是多少、缓存大约帮用户省了多少钱（缓存读取按输入价的0.1倍计费，等于省下0.9倍）、如果命中率偏低可能意味着什么（例如频繁切换项目或系统提示变动）。
