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
- 单结局结果页当前只保留：
  - `进入会客厅`
  - `只改一步`
  - 不会展示 `发起圆桌` / `异线旁听席`
- `WorldlineRoundtableView` 已支持 live roundtable、改选重开、只读 replay，以及 `manual_shortlist / expert_witness / trait_mix / fault_line_first / witness_augmented`。
- single-ending 当前已补：
  - `继续追问`
  - `另开线程`
  - `复制纪要`
  - `追问洞察`
  - transcript `quote` 级追问 / 开线程
- roundtable 当前已补：
  - `Continue this table / Start anchored thread / Copy roundtable brief`
  - `phase insight` 级追问 / 开线程
  - transcript `quote` 级追问 / 开线程
  - transcript `quote` 级 `点名这位代表 / Hotseat this rep`
- roundtable committed transcript 当前已补长段折叠 / 展开，避免主区直接被长段挤满。
- `quote / verdict / key_moment / phase` 当前都走显式 `questionAnchorIds`，不再只靠 prompt 文案表达锚点。
- `EndingChatModal / WorldlineRoundtableView` 当前会在线程 rail 与 transcript header 显式显示当前 thread 的 anchor badge。
- Oracle 自动化口径当前会输出：
  - `question_anchor_ids`
  - `thread_question_anchor_ids_json`
  - `anchor_kind / anchor_label`
  - `pending_question_anchor_ids`
  - `current_speaker_turn_key`
  - `current_speaker_participant_id`
  - `pending_drafts`
  - `stream_state`
- ending-room / roundtable 的 replay/share/import 已完成专项签收。
- roundtable 的 readonly replay 当前会跟随 `active_thread_id` 恢复对应 thread 语义；若落在 `hotseat` follow-up，页面不会再退回成 `archivist_route`。
- mobile roundtable artifact replay readonly 当前也会跟随 active replay thread 恢复 `interaction_mode`，不再在自动化口径里卡成 `archivist_route`。
- roundtable 的 anchored thread replay / local readonly / reload restore 当前已补过 Firefox / WebKit scoped regression，口径与 Chromium 对齐。
- Oracle 页面当前按用户正在使用的 UI 语言渲染界面壳，不再强制跟随 `scenario.language` 覆盖全局语言开关。
- Oracle fresh live room 的英文 deterministic copy 当前已补去混句兜底，不再把中文 hinge 直接嵌进英文句子。

## 当前工程边界

- 交付形态仍是 `browser-first Web`。
- `跨平台` 仅指桌面/移动浏览器响应式与视口 E2E，不表示原生壳已交付。
- 主模式 authority 已以后端为准：
  - `director_state_json`
  - `gameplay_state_json`
- `scenarioMeta` 仍存在，但只承担缓存、兼容与 replay 输入职责。
- replay 分享优先走后端 `ReplayArtifact`；当 artifact 不可用且 URL token 也过大时，Oracle replay 会回退为本地只读副本链接。

## 当前状态

- 主闭环已达到 `release-candidate` 级别。
- 最近一次稳定总链签收工件位于：
  - `frontend/output/e2e/20260330-full-release-signoff-stable/summary.json`
- 最近一次 Oracle 专项签收工件位于：
  - `frontend/output/e2e/20260331-oracle-signoff-ending-room/summary.json`
  - `frontend/output/e2e/20260331-oracle-signoff-roundtable/summary.json`
- 最近一轮 Oracle 0.3 锚点观测回归工件位于：
  - `frontend/output/e2e/20260331-codex-oracle-anchor-ending-room-mobile-v3/summary.json`
  - `frontend/output/e2e/20260331-codex-oracle-anchor-roundtable-desktop-v8/summary.json`
  - `frontend/output/e2e/20260331-codex-oracle-anchor-roundtable-mobile-v2/summary.json`
- 最近一轮 Oracle 流式 hardening 工件位于：
  - `frontend/output/e2e/20260331-codex-followup-hardening-full/summary.json`
  - `frontend/output/e2e/20260331-codex-roundtable-hardening-desktop-rerun/summary.json`
  - `frontend/output/e2e/20260331-codex-roundtable-hardening-mobile-rerun/summary.json`
  - `frontend/output/e2e/20260331-codex-followup-hardening-mobile-rerun5/summary.json`
- 最近一轮 Oracle 流式观测 rerun 工件位于：
  - `frontend/output/e2e/20260331-codex-followup-stream-lifecycle/summary.json`
  - `frontend/output/e2e/20260331-codex-roundtable-stream-desktop-rerun/summary.json`
  - `frontend/output/e2e/20260331-codex-roundtable-stream-mobile-rerun2/summary.json`
- 最近一轮 roundtable 可读性收口工件位于：
  - `frontend/output/e2e/20260331-codex-roundtable-readability-pass-desktop/summary.json`
- 最近一轮 Oracle roundtable Firefox / WebKit scoped regression 工件位于：
  - `frontend/output/e2e/20260331-codex-oracle-roundtable-cross-browser-scoped/firefox/summary.json`
  - `frontend/output/e2e/20260331-codex-oracle-roundtable-cross-browser-scoped/webkit/summary.json`
- 最近一轮经典模式流式 hardening 工件位于：
  - `frontend/output/e2e/20260331-codex-classic-stream-hardening-rerun3/result.json`
- 当前仍在继续收口的内容：
  - follow-up 与经典模式的更深流式一致性
    - 本轮已补 classic `thinkingAgentCount / thinkingAgents` 观测，以及 Oracle `current_speaker_* / pending_drafts / stream_state`
  - `pretext` 更深的 transcript 运行时稳定化
    - 当前已把 `collapsible_turn_count / collapsed_turn_count` 补进 Oracle transcript layout telemetry
    - `P3 / P4` 仍未启动
  - Oracle 更深的回归与 corner-case hardening
    - `corners` 当前已能稳定落 `result.json`，但尾部仍可能打印一次 teardown warning

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
