---
description: 效率分析ROI：每个会话的任务、每$动作数、编辑量与返工率（默认最近7天）
argument-hint: [天数]
allowed-tools: Bash(node:*)
---

## 数据

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" roi --days "$ARGUMENTS"`

## 任务

上面是按会话的效率分析（用户传入的天数参数为「$ARGUMENTS」，为空时默认7天）。请原样展示表格，然后：

1. 点评整体「每$1动作数」水平；
2. 挑出返工率被黄色标注的会话（对同一文件反复编辑），提示可能原因（需求描述不够明确、方案来回推翻、边改边试），给一条改进建议（先让模型出计划再动手、把验收标准一次说清）；
3. 若整体健康，一句话确认即可。
