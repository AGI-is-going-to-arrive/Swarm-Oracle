# SwarmOracle — 项目概览

> 文档类型：L0 current-truth
> 作用：描述当前产品范围、交付边界与阅读入口。历史实现流水保留在 `implement/` 与 `progress.md`。

## 项目定位

SwarmOracle 是一个 `AI What-If Prediction Playground`：

- 用户输入一个历史或假设性问题。
- 系统生成多 Agent 推演与分支时间线。
- 前端以 Pixel Theater、结果卡、押注与 replay 形式展示不同世界线。

## 当前产品面

### 主模式

- 首页创建 scenario，支持 agent/rounds、BYOK、玩法档位与 quick starts。
- `SimulationView` 负责 live 推演、Theater、干预、玩法卡、结构化押注与 capture。
- `ResultView` 负责结局对比、档案、campaign summary、分享、导出与 replay/import。

### Debate Arena

- 独立 debate 域，包含 live/result/replay。
- 已落地结构化押注、counterplay、judge rationale、supporting turns 与 replay import。

### Oracle Chambers / 世界线圆桌

- 已进入可玩签收基线。
- 结果页可通过 participant picker 进入：
  - `进入会客厅`
  - `只改一步`
  - `异线旁听席`
- `WorldlineRoundtableView` 已支持 live roundtable、改选重开、只读 replay，以及 `manual_shortlist / expert_witness / trait_mix / fault_line_first / witness_augmented`。
- ending-room / roundtable 的 replay/share/import 已完成专项签收。
- Oracle 页面当前按用户正在使用的 UI 语言渲染界面壳，不再强制跟随 `scenario.language` 覆盖全局语言开关。

## 当前工程边界

- 交付形态仍是 `browser-first Web`。
- `跨平台` 仅指桌面/移动浏览器响应式与视口 E2E，不表示原生壳已交付。
- 主模式 authority 已以后端为准：
  - `director_state_json`
  - `gameplay_state_json`
- `scenarioMeta` 仍存在，但只承担缓存、兼容与 replay 输入职责。
- replay 分享优先走后端 `ReplayArtifact`，失败时才回退本地 token。

## 当前状态

- 主闭环已达到 `release-candidate` 级别。
- 最近一次稳定总链签收工件位于：
  - `frontend/output/e2e/20260330-full-release-signoff-stable/summary.json`
- 当前仍在继续收口的内容：
  - follow-up 与经典模式的流式一致性
  - `pretext` 更深的 transcript 运行时稳定化（`P2+` 尚未启动）
  - Oracle 更深的回归、跨浏览器与 corner-case hardening

## 文档入口

- 产品和仓库入口：仓库根 `README.md`
- 后端真值：`overview/backend.md`
- 前端真值：`overview/frontend.md`
- 开发与签收命令：`guides/development.md`
- 接口与配置：`reference/api.md`、`reference/config.md`
- 实现归档：`implement/README.md`

## 不应再做的事情

- 不要把 `progress.md` 当当前状态说明。
- 不要把 `implement/*.md` 的旧计划段落当待办列表。
- 不要在本页记录 session 级测试流水、逐轮修复清单或历史签收日志。
