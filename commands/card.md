---
description: 生成本月用量分享卡片（SVG，含成本、热力缩略图、订阅倍数）
allowed-tools: Bash(node:*)
---

## 数据

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" card`

## 任务

上面是月度用量卡片的生成结果（SVG已在浏览器打开）。告诉用户文件位置，说明卡片包含本月等价API成本、输出token、最高单日、活跃天数与星期×小时热力缩略图；数据全部本地生成，分享前自行确认内容。
