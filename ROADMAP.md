# 升级路线

按优先级排列，逐版本推进。当前版本：v0.6.0。

## 已完成（v0.2.0）

- [x] 燃烧率预测（blocks命令的📊预测行）。
- [x] `weekly`/`monthly`命令。
- [x] 项目维度报表（`projects`）。
- [x] 缓存效率分析（`cache`）。
- [x] HTML可视化报告（`report`，零依赖手写SVG，亮暗主题）。
- [x] 每日预算警示（`daily_budget_usd`）。
- [x] 历史快照仓库（突破约30天日志保留期）。

## 已完成（v0.3.0）

- [x] 解析JSONL中的限流事件，把官方给出的刷新时间标注到对应窗口上（blocks红色🚫＋仪表盘提醒）。
- [x] 状态栏可配置：`statusline`段选择显示哪些段、阈值颜色、分隔符样式。
- [x] 终端宽度自适应：窄终端自动切换紧凑列（`--compact`/`--wide`可强制）。
- [x] 工具调用统计：`tools`命令统计各工具使用频次与错误率。
- [x] HTML报告增强：项目维度图、缓存节省趋势、周对比。
- [x] 机器可读退出码（`limits --check`：0正常/10接近限额/11已限额/1查询失败），提前自v0.4实现。

## 已完成（v0.4.0）

- [x] SessionStart钩子：会话开始时若限额超过阈值自动提醒（阈值可配`hooks.limit_warn_pct`）。
- [x] 每日汇总钩子：当天首次启动时输出昨日用量小结（与限额提醒合并为一个钩子命令）。
- [x] 触顶预测：按窗口内平均速度推算是否会在刷新前达到100%。
- [x] HTML报告：星期×小时热力图、工具调用Top 10。
- [x] `today`分时火花线与较昨日此时对比。

## 已完成（v0.5.0）

- [x] MCP服务器形态：零依赖stdio服务器把用量数据暴露为9个MCP工具，插件启用自动启动。
- [x] 多设备汇总：`export`/`import`把多台机器的按天聚合合并进daily/weekly/monthly。
- [x] 仪表盘本周vs上周行、状态栏`eta`触顶预警段、HTML报告主题切换按钮。

## 已完成（v0.6.0）

- [x] 多设备自动同步：`sync_dir`共享目录＋`sync`命令＋钩子每6小时自动同步。
- [x] 团队视图：`team`命令按设备/成员汇总（成员共用同一sync_dir即整队汇总），MCP加`usage_team`。

## 已完成（v0.6.1）

- [x] 发布到GitHub：https://github.com/1931840268/claude-usage-monitor（MIT协议，发布前经隐私审计）。

## 已完成（v1.1.0）

- [x] 英文UI（P0范围）：all/today/limits/blocks/roi/plan/statusline/help与失败文案全部en/zh双语，`--lang`＞`CLAUDE_USAGE_LANG`＞`display.lang`＞locale自动检测（中文环境默认中文）。

## 已完成（v1.2.0）

- [x] 子代理成本归因：修复subagents/转写漏记（总额自动补齐）＋`agents`命令（类型排行＋`--session`下钻fan-out成本树）。
- [x] 会话小票：SessionEnd钩子自动结算＋`last`命令＋开屏「上次会话」一行摘要。
- [x] 限流黑匣子：StopFailure钩子实录真实中断，errors/limits预测vs现实闭环。
- [x] 预算熔断器：UserPromptSubmit钩子软提醒＋可选`budget_hard_cap`硬拦截（fail-open）。
- [x] serve实时Web仪表盘：127.0.0.1本地驾驶舱，实时条＋秒级倒计时＋SSE自动刷新。

## 进行中

- [ ] 英文UI（P1范围）：advise/errors/doctor/sessions/context等其余命令面英文化。

## 候选池（多agent侦察提案，按优先级）

- [ ] worklog周报生成器：按天分组的人话版工作叙事（活跃时长口径），给导师/老板看的Markdown。
- [ ] wrapped月度/年度故事页：Spotify Wrapped式整屏滚动HTML，模型人设与称号，可分享。
- [ ] subagentStatusLine：官方新接口，agent面板每行显示该子代理实时成本与上下文占用。
- [ ] badges成就系统：streak连续天数、里程碑，开屏解锁播报。
- [ ] live终端驾驶舱升级：alt-screen无闪烁渲染、秒级倒计时、双节拍架构。
- [ ] card英文化＋浏览器端一键转PNG晒图。
- [ ] PreCompact/PostCompact压缩审计：量化auto-compact的隐性重缓存成本。
- [ ] 数据层迁移${CLAUDE_PLUGIN_DATA}：升级/重装不丢账本。
- [ ] plugin.json userConfig：启用插件时官方引导式配置。
- [ ] roi --session文件级churn下钻：从返工率到「哪个文件在反复改」。

## 远期想法

- [ ] 发布npm包（`npx claude-usage-monitor`短命令＋下载量徽章，需npm账号）。
- [ ] 提交到社区插件市场聚合列表（awesome-claude-code须先积累真实用户，走issue表单）。
