---
description: API错误诊断：限流/过载/超时/网络分类统计与最近记录（默认最近7天）
argument-hint: [天数]
allowed-tools: Bash(node:*)
---

## 数据

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" errors --days "$ARGUMENTS"`

## 任务

上面是API错误分类统计（用户传入的天数参数为「$ARGUMENTS」，为空时默认7天）。请原样展示，然后：

1. 若无错误，一句话确认链路健康；
2. 若限流类居多，结合刷新机制给建议（错峰、关注/usage-monitor:limits）；
3. 若网络/超时类居多，提示检查代理与网络环境；认证类错误提示重新/login。
