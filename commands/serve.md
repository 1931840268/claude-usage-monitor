---
description: 启动本地实时Web仪表盘（127.0.0.1，自动刷新，含限额倒计时与燃烧率）
argument-hint: [端口]
allowed-tools: Bash(node:*)
---

## 任务

在后台启动本地实时Web仪表盘（用户传入的端口参数为「$ARGUMENTS」，为空时默认3737）：

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" serve --port "$ARGUMENTS"
```

要点：

1. 用Bash的run_in_background方式启动上述命令（参数为空时省略`--port`），它是常驻进程；
2. 告诉用户仪表盘地址（`http://127.0.0.1:端口/`）会自动在浏览器打开，页面顶部是实时条（今日成本、燃烧率$/h、官方限额窗口带秒级倒计时），下方是完整HTML报告的8张图表；
3. 说明数据只监听127.0.0.1、不出本机，转写有新内容时页面自动刷新；
4. 停止方式：让用户告诉你之后由你结束该后台任务，或直接关闭终端。
