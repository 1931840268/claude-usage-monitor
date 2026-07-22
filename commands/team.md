---
description: 团队视图：本机与已同步设备/成员的成本汇总（默认最近30天）
argument-hint: [天数]
allowed-tools: Bash(node:*)
---

## 数据

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" team --days "$ARGUMENTS"`

## 任务

上面是团队视图（用户传入的天数参数为「$ARGUMENTS」，为空时默认30天），汇总了本机与所有已同步设备/成员的用量。请原样展示表格，然后用一两句中文提炼要点：

1. 成本最高的设备/成员及其占比；
2. 若某设备的「数据截至」明显滞后（超过3天），提醒该设备可能很久没有同步了；
3. 若只有本机一行，说明配置方法：在~/.claude/usage-monitor.json里设置sync_dir指向共享目录（团队成员共用同一目录），或用/usage-monitor:usage里提到的import命令手动导入。
