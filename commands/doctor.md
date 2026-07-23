---
description: 环境自检：插件版本/配置/数据源/凭据/钩子/同步目录逐项体检
allowed-tools: Bash(node:*)
---

## 数据

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" doctor`

## 任务

上面是插件环境自检结果。请原样展示，然后：

1. 若全部「正常」，一句话确认环境健康即可；
2. 对每个「注意」或「异常」项，用一两句话解释影响并给出具体修复步骤（如版本不一致→依次执行marketplace update、plugin update、重启会话；配置含未知键→给出正确键名）；
3. 若用户反馈「改动没生效」，重点提醒：斜杠命令使用会话启动时加载的版本，更新插件后必须重启会话。
