---
description: 官方限额利用率：5小时/7天窗口、各模型周配额、刷新时间（需订阅账号）
allowed-tools: Bash(node:*)
---

## 数据

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" limits`

## 任务

上面是从Anthropic官方接口实时查询的限额利用率（Pro/Max订阅账号）。请原样展示进度条，并用中文说明：

1. 各窗口当前用了多少、什么时候刷新；
2. 若某窗口超过80%，给出醒目提醒并建议用户放缓或切换到更省额度的模型；
3. 若显示「未找到订阅凭据」，说明该命令仅适用于订阅账号，API Key用户可用/usage-monitor:blocks查看本地估算窗口。
