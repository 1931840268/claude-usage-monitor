---
description: 立即同步：导出本机用量到sync_dir并合并其他设备的导出文件
allowed-tools: Bash(node:*)
---

## 数据

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" sync`

## 任务

上面是用量同步的执行结果。请原样展示，然后：

1. 若同步成功，说明合并了哪些设备，并提示可用/usage-monitor:team查看团队视图；
2. 若提示「尚未配置同步目录」，指导用户在~/.claude/usage-monitor.json中加入`"sync_dir": "<同步盘或网络共享目录>"`，并说明会话启动钩子此后会每6小时自动同步一次；
3. 若有⚠错误行，逐条解释可能原因（文件损坏、目录不可达等）。
