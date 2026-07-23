# usage-monitor：Claude Code用量监控插件

[English README](README.md) · 十秒试用：`npx github:1931840268/claude-usage-monitor all`

一个可直接安装进Claude Code的用量监控插件：查看各模型的token用量与成本、5小时/7天限额窗口的利用率与刷新时间、会话成本排行，并可在底部状态栏实时显示。零依赖，只需Node.js（Claude Code本身就依赖Node，无需额外安装）。

设计参考了ccusage（17k星）、Claude Code Usage Monitor（8.5k星）、ccstatusline、claude-powerline等主流开源工具，并与ccusage的5小时窗口算法保持一致；官方限额数据直接来自Anthropic接口，非估算值。

## 为什么选它（与通用记账CLI的差异）

| 能力 | 本插件 | 传统用量CLI |
| --- | --- | --- |
| 插件原生：斜杠命令、会话钩子、MCP工具随会话即用 | ✓ | 需另开终端 |
| 任务级归因：会话排行显示「你让它干了什么」而非UUID | ✓ | 只有ID |
| ROI效率分析：每$产出动作数、返工率 | ✓ | 无 |
| 上下文肥胖诊断＋个性化省钱建议引擎 | ✓ | 无 |
| 限额规划：未来24h刷新×历史高峰时间轴、触顶预测、异常燃烧哨兵 | ✓ | 部分 |
| 多设备自动同步＋团队视图 | ✓ | 无 |
| 自动日报/周报（周报HTML自动存档） | ✓ | 无 |
| 月度用量分享卡片（SVG） | ✓ | 无 |
| 中文完整体验、纯文字防遮挡模式、零依赖 | ✓ | 英文为主 |

## 功能特性

| 功能 | 说明 |
| --- | --- |
| 今日用量 | 按模型分组的输入/输出/缓存token、成本与占比、分时火花线、较昨日此时对比 |
| 按天/周/月报表 | 用量趋势、日均成本、主力模型、火花线趋势图、星期标注 |
| 5小时窗口 | 本地估算的限额窗口、刷新时间、燃烧率、进度条与消耗预测（与ccusage算法一致） |
| 官方限额 | 5小时/7天/各模型周配额的官方利用率、severity与刷新时间（Pro/Max订阅）；按当前速度的触顶预测 |
| 会话钩子 | 会话启动时自动输出昨日小结＋限额预警（阈值可配，可关闭） |
| MCP服务器 | 用量数据暴露为10个MCP工具，任何MCP客户端可查询（插件启用自动启动） |
| 多设备同步 | 配置`sync_dir`共享目录后自动同步（钩子每6小时），`export`/`import`可手动合并 |
| 团队视图 | `team`命令按设备/成员汇总成本；成员共用同一同步目录即得整队视图 |
| 会话/项目排行 | 按成本排序的会话Top榜（含时长）与项目维度汇总 |
| 缓存效率 | 命中率、缓存读省下的钱、写入溢价、净节省 |
| 工具统计 | 各工具调用频次、占比分布条与错误率（含MCP工具） |
| 限流标注 | 识别官方「usage limit reached」事件，触顶窗口红色🚫标注并显示官方刷新时间 |
| HTML报告 | 一键生成自包含可视化报告（亮暗主题、悬停明细、周对比、星期×小时热力图、项目分布、工具Top 10、缓存节省趋势） |
| 状态栏 | 模型、会话/今日/窗口成本、限额百分比、刷新倒计时、上下文占用、燃烧率、预算警示；段与阈值可配置 |
| 历史仓库 | 每日聚合快照，突破Claude Code约30天日志保留期，月报不丢数据 |
| 窄屏自适应 | 终端宽度不足时自动切换紧凑列，`--compact`/`--wide`可强制 |
| JSON输出 | 所有命令支持`--json`；`limits --check`附机器可读退出码 |

## 安装

从GitHub直接安装（推荐）：

```
claude plugin marketplace add 1931840268/claude-usage-monitor
claude plugin install usage-monitor@usage-monitor-market
```

或克隆到本地后从目录安装（仓库自带marketplace清单，目录本身就是一个插件市场）：

```
git clone https://github.com/1931840268/claude-usage-monitor.git
claude plugin marketplace add ./claude-usage-monitor
claude plugin install usage-monitor@usage-monitor-market
```

也可以在Claude Code会话内用`/plugin marketplace add`与`/plugin install`完成同样的操作。开发调试时可以不安装，直接以插件目录启动：

```
claude --plugin-dir ./claude-usage-monitor
```

注意：Windows下路径请使用正斜杠`/`。

## 命令

安装后在Claude Code里可用以下斜杠命令：

| 命令 | 作用 |
| --- | --- |
| `/usage-monitor:usage` | 整合仪表盘：成本、预算、官方限额、当前窗口、趋势、模型、项目一屏全览 |
| `/usage-monitor:daily [天数]` | 按天报表，默认7天 |
| `/usage-monitor:weekly [周数]` | 按周报表，默认8周（周一起算） |
| `/usage-monitor:monthly [月数]` | 按月报表，默认6个月 |
| `/usage-monitor:blocks [天数]` | 5小时限额窗口，默认3天 |
| `/usage-monitor:models` | 全部历史按模型汇总 |
| `/usage-monitor:sessions [数量]` | 会话成本排行，默认Top 10 |
| `/usage-monitor:projects [天数]` | 按项目统计，默认30天 |
| `/usage-monitor:cache` | 缓存效率与节省金额 |
| `/usage-monitor:tools [天数]` | 工具调用统计，默认7天 |
| `/usage-monitor:hours [天数]` | 星期×小时用量热力，找高峰时段 |
| `/usage-monitor:context [天数]` | 上下文规模分析：成本花在哪个档位、最肥会话 |
| `/usage-monitor:roi [天数]` | 效率分析：任务级成本、每$动作数、返工率 |
| `/usage-monitor:plan` | 未来24小时限额规划（刷新时刻×历史高峰） |
| `/usage-monitor:card` | 生成月度用量分享卡片（SVG） |
| `/usage-monitor:advise` | 个性化省钱建议（缓存/上下文/触顶/模型组合） |
| `/usage-monitor:errors [天数]` | API错误分类诊断（限流/过载/超时/网络） |
| `/usage-monitor:doctor` | 环境自检：版本/配置/数据源/钩子逐项体检 |
| `/usage-monitor:limits` | 官方限额利用率与刷新时间 |
| `/usage-monitor:report [天数]` | 生成HTML可视化报告并打开 |
| `/usage-monitor:sync` | 立即同步：导出本机并合并其他设备（需配置sync_dir） |
| `/usage-monitor:team [天数]` | 团队视图：本机＋已同步设备/成员的成本汇总 |
| `/usage-monitor:statusline-setup` | 一键配置底部状态栏 |

也可以脱离Claude Code直接在终端使用：

```
node scripts/usage.mjs all
node scripts/usage.mjs today
node scripts/usage.mjs blocks --days 3
node scripts/usage.mjs weekly --weeks 12
node scripts/usage.mjs tools --days 7 --top 20
node scripts/usage.mjs report --days 30
node scripts/usage.mjs daily --days 14 --json
node scripts/usage.mjs limits --check; echo $?   # 0正常/10接近/11已达/1失败
node scripts/usage.mjs live --interval 30        # 终端常驻实时仪表盘（Ctrl+C退出）
node scripts/usage.mjs prune --keep 365          # 清理一年前的历史快照
```

时间口径：daily/weekly/monthly按本地自然日统计；blocks/sessions/projects/tools按当前时刻回溯N×24小时。窄终端（低于100列）自动切换紧凑列，`--compact`强制开启、`--wide`强制关闭。

## 状态栏

运行`/usage-monitor:statusline-setup`一键配置，效果示例：

```
Fable 5(xhigh) | 💰 会话$3.21 / 今日$142 / 窗口$139 | 5h 63% 剩2h05m(18:45刷新) | 7d 38% | ctx 42% | 1.2ktok/min
```

各字段含义：当前模型（含effort档位）、本会话/今日/当前5小时窗口成本、官方5小时限额百分比与刷新倒计时（订阅账号；API Key用户自动换成本地估算的窗口进度）、7天限额百分比、上下文窗口占用、当前燃烧率（tokens每分钟，按颜色分级：2000以下暗色正常、2000～5000黄色偏高、5000以上红色很高）。

### 状态栏与预算配置（可选）

在`~/.claude/usage-monitor.json`写入：

```json
{
  "daily_budget_usd": 50,
  "statusline": {
    "segments": ["model", "cost", "budget", "5h", "7d", "ctx", "burn"],
    "separator": " | ",
    "warn_pct": 50,
    "danger_pct": 80
  }
}
```

- `daily_budget_usd`：当日成本达到预算80%时状态栏出现黄色「预算N%」，超过100%变红色「超预算」。
- `statusline.segments`：从model/cost/budget/5h/7d/ctx/burn/eta中挑选要显示的段，顺序即显示顺序；省略或留空显示全部（eta段仅在预计刷新前触顶时出现红色「⚠触顶约HH:MM」）。
- `statusline.separator`：段间分隔符，默认`" | "`。
- `statusline.warn_pct`/`danger_pct`：百分比着色阈值（达到warn变黄、达到danger变红），默认50/80；非法值自动回退。
- `display.ambiguous_wide`：若你的终端是老式CJK控制台（`…◆`等符号占2列）且表格出现错位，设为`true`；现代终端（Windows Terminal/VS Code）保持默认即可。
- `display.emoji`：设为`false`剥离全部装饰emoji（纯文字界面）。适用于emoji字形画得比字符格宽、会压住后面文字的终端；警示信息全部由颜色承担，关掉不损失任何信息。
- `subscription_usd_per_month`：填入订阅月费（如200），仪表盘「本月」行会显示等价API价值是订阅费的多少倍。
- 所有报表命令支持`--csv`输出原始数值CSV（Excel直接用）；配置有拼写疑问随时跑`doctor`自检。

## 会话启动钩子

插件注册了SessionStart钩子（`hooks/hooks.json`），每次新会话启动时自动运行：

- **每日小结**：当天第一次启动会话时，输出昨日的成本、较前日增减、请求数、主力模型与缓存净省各一行。
- **限额预警**：任一官方限额窗口（5小时/7天/各模型周配额）达到阈值时输出预警与刷新时间。

在`~/.claude/usage-monitor.json`中可配置：

```json
{ "hooks": { "session_start": true, "limit_warn_pct": 80 } }
```

`session_start`设为`false`整体关闭；`limit_warn_pct`调整预警阈值（1～100，默认80）。钩子30秒超时、出错静默，不会阻塞会话启动。

## MCP服务器

插件捆绑了一个零依赖的stdio MCP服务器（`.mcp.json`注册，插件启用后自动启动），把用量数据暴露为10个MCP工具：`usage_dashboard`、`usage_today`、`usage_daily`、`usage_blocks`、`usage_limits`、`usage_tools`、`usage_sessions`、`usage_projects`、`usage_cache`、`usage_team`（均返回JSON，支持`days`/`top`数字参数）。在Claude Code里工具名形如`mcp__plugin_usage-monitor_usage__usage_dashboard`；也可以把同样的命令配置到Claude Desktop等其他MCP客户端查询本机用量。

## 多设备自动同步与团队视图

**自动同步（推荐）**：每台机器在`~/.claude/usage-monitor.json`里配置同一个共享目录（同步盘、NAS、网络共享均可）：

```json
{ "sync_dir": "D:/OneDrive/claude-usage-sync", "sync_days": 90 }
```

此后会话启动钩子每6小时自动「导出本机＋合并目录里其他设备的导出文件」（在后台子进程执行，网络盘断连也不会拖慢会话启动），也可随时用`/usage-monitor:sync`（或`node scripts/usage.mjs sync`）立即同步。合并后daily/weekly/monthly报表自动包含所有设备的用量。`sync_days`（可选，1～365，默认90）控制导出视野。

设备身份是「主机名-随机后缀」（首次使用时生成并持久化），克隆机/改名不会互相冲突；`forget <设备名>`可移除某台设备的已导入数据。

**团队视图**：团队成员把`sync_dir`指向同一个共享目录，每人的导出文件自动携带账号邮箱；`/usage-monitor:team`（或`team --days N`）按设备/成员汇总成本、占比、主力模型与数据截至日期。

**手动方式**：无共享目录时仍可在机器A上`export`（默认90天），把文件拷到机器B后`import <文件路径>`。

安全与语义：导入数据存放在历史仓库的devices命名空间，按天求和合并；导入内容经严格消毒（畸形日期/负数/Infinity清零或跳过）；同名设备重复导入整体覆盖（幂等），导入本机的导出文件会被拒绝；今天的数据不参与导出（未完结），团队视图中本机行始终为实时数据。

## 工作原理

- **数据源一（本地JSONL）**：Claude Code把每次API交互记录在`~/.claude/projects/<项目>/<会话>.jsonl`。本插件流式解析其中带`usage`字段的assistant条目，按`message.id + requestId`去重（流式写盘会产生重复行；与ccusage口径一致），聚合出token与成本。`CLAUDE_CONFIG_DIR`环境变量设置时覆盖默认目录（`~/.claude`与`~/.config/claude`）。
- **历史快照仓库**：运行daily/weekly/monthly时会把已完结日期的聚合结果快照到`~/.claude/usage-monitor/history.json`，本地日志被Claude Code清理（约30天）后，周报/月报自动用快照补齐。
- **数据源二（官方接口）**：订阅账号的凭据存于`~/.claude/.credentials.json`，插件用它查询Anthropic官方用量接口，得到5小时/7天各窗口的真实利用率与刷新时间（结果缓存3分钟）。
- **数据源三（状态栏stdin）**：Claude Code每次刷新状态栏时会通过stdin传入JSON（模型、会话成本、上下文占用、官方限额等），状态栏脚本优先使用这些官方字段。
- **成本计算**：优先使用JSONL里记录的`costUSD`；缺失时按内置价格表计算——缓存写入5分钟档按输入价1.25倍、1小时档按2倍、缓存读取按0.1倍计价。
- **5小时窗口算法**（与ccusage一致）：窗口起点为首次活动时间向下取整到UTC整点，持续5小时；与上一条记录间隔超过5小时或超出窗口时开启新窗口；「进行中」窗口要求当前时间仍在窗口内且最近5小时内有活动。

## 常见问题

- **我用的是API Key，不是订阅**：`/usage-monitor:limits`和状态栏的官方限额段会自动隐藏，其余功能（本地统计、5小时窗口估算）完全可用。
- **成本和官方账单对不上**：本地计算是估算值，未包含Web搜索等按次计费项，也未建模长上下文溢价与fast mode溢价；订阅用户的「成本」仅代表等价API价值，不是实际扣费。Sonnet 5在2026-08-31前按促销价（$2/$10）计算。
- **状态栏不显示**：确认`~/.claude/settings.json`里`statusLine.command`的路径全部是正斜杠；插件更新后缓存路径可能变化，重跑`/usage-monitor:statusline-setup`即可。
- **数据统计从哪天开始**：本地JSONL约保留30天；更早的数据依靠历史快照仓库（首次使用后开始积累）。
- **未识别的模型**：不在内置价格表里的模型按$0计成本，报表末尾会给出黄色提示。
- **经典conhost窗口下热力图错位**：老式控制台的中文点阵字体会把`·░▒▓█`按混合宽度渲染，`hours`热力图的行尾合计可能参差（表格类可用`display.ambiguous_wide`修正）。建议使用Windows Terminal/VS Code终端，渲染完全正常（实测验证）。

## 目录结构

```
claude-usage-monitor/
├─ .claude-plugin/
│  ├─ plugin.json          插件清单
│  └─ marketplace.json     本地插件市场清单
├─ commands/               斜杠命令（15个）
├─ .mcp.json               MCP服务器注册（插件启用自动启动）
├─ hooks/
│  └─ hooks.json           SessionStart钩子注册（昨日小结＋限额预警）
├─ scripts/
│  ├─ usage.mjs            核心引擎（零依赖Node脚本）
│  ├─ report.mjs           HTML报告生成器（手写SVG，零依赖）
│  └─ mcp-server.mjs       MCP服务器（stdio JSON-RPC，零依赖）
├─ README.md
├─ ROADMAP.md              升级路线
└─ CHANGELOG.md
```

## 升级路线

见[ROADMAP.md](ROADMAP.md)。欢迎按需增删功能。

