---
description: 上下文规模分析：档位分布、成本占比、最肥会话（默认最近7天）
argument-hint: [天数]
allowed-tools: Bash(node:*)
---

## 数据

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" context --days "$ARGUMENTS"`

## 任务

上面是按请求上下文规模（输入＋缓存读＋缓存写）的分析（用户传入的天数参数为「$ARGUMENTS」，为空时默认7天）。请原样展示，然后：

1. 指出成本主要集中在哪个上下文档位，用一句话解释这意味着什么（上下文越大每次请求越贵）；
2. 若≥150k档位成本占比高，结合「最肥会话Top 5」给出具体行动建议（勤开新会话、/clear、避免整本文件反复读入等）；
3. 若分布健康，简单确认即可。
