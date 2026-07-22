---
description: 按项目统计用量与成本（默认最近30天）
argument-hint: [天数]
allowed-tools: Bash(node:*)
---

## 数据

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" projects --days "$ARGUMENTS"`

## 任务

上面是按项目目录汇总的用量报表（用户传入的天数参数为「$ARGUMENTS」，为空时默认30天）。请原样展示表格，并指出成本最高的项目及其占比。项目名是工作目录转义后的形式，可适当还原成更易读的路径说明。
