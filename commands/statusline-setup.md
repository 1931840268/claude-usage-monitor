---
description: 一键配置状态栏：在Claude Code底部实时显示模型、成本、限额窗口与刷新时间
allowed-tools: Bash(node:*), Bash(echo:*), Read, Edit, Write
---

## 上下文

- 本插件根目录（脚本所在位置，写入配置时请把其中的反斜杠全部换成正斜杠）：
!`echo "${CLAUDE_PLUGIN_ROOT}"`

- 状态栏效果预览：
!`echo '{"model":{"display_name":"预览"},"cost":{"total_cost_usd":1.23}}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" statusline`

- 当前用户设置：
!`node -e "const p=require('os').homedir()+'/.claude/settings.json';try{console.log(require('fs').readFileSync(p,'utf8'))}catch{console.log('（settings.json 不存在）')}"`

## 任务

为用户配置Claude Code状态栏，步骤：

1. 读取`~/.claude/settings.json`（不存在则新建，保留已有全部字段）。
2. 若已存在`statusLine`字段，先向用户确认是否覆盖，再继续。
3. 写入以下配置（把`<PLUGIN_ROOT>`替换为上面输出的插件根目录，路径必须用正斜杠`/`，Windows下反斜杠会被Git Bash吞掉）：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"<PLUGIN_ROOT>/scripts/usage.mjs\" statusline",
    "padding": 0,
    "refreshInterval": 10
  }
}
```

4. 告诉用户：重启Claude Code或开新会话后，底部状态栏会显示「模型 | 会话/今日/窗口成本 | 5小时限额百分比与刷新倒计时 | 7天限额 | 上下文占用 | 燃烧率」；`refreshInterval: 10`让倒计时在空闲时也每10秒刷新一次。
5. 提醒：插件更新后安装路径可能变化，若状态栏消失，重新运行本命令即可。
