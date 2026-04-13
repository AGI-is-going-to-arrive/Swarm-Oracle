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
- 当 `agent_identity` capability 开启时，首页会在主模式启动前先跑 continuity preflight；只有命中 L2 fuzzy candidate 时才弹确认框，用户可选 `复用已有身份` 或 `创建新身份`。
- `SimulationView` 负责 live 推演、Theater、干预、玩法卡、结构化押注与 capture。
- `ResultView` 负责结局对比、`counterfactual compare / resume / faction timeline`、档案、campaign summary、分享、导出与 replay/import。

### Debate Arena

- 独立 debate 域，包含 live/result/replay。
- 已落地结构化押注、counterplay、judge rationale、supporting turns 与 replay import。
- 页面级播报当前仍以 phase cue 为唯一 live region；`SpotlightTurnCard` 的高亮态不再单独挂 `aria-live`，避免同一轮变化被重复播报。
- quick counterplay 当前只在 live 当前 phase 的 bet window 可提交；锁到历史 phase 时不会再发起 quick hedge。
- debate argument map 当前保留 rule-based 抽取，并默认追加每个 turn 一次 fire-and-forget LLM enrichment；上游 provider 慢或失败时会自动回退成纯规则结果。

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
- 代表改选当前支持桌面 `drag-to-seat / keyboard reseat`；移动端保留 `click-to-seat`。
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
- 已新增两种交互模式：
  - `后续三回合 (epilogue)`：在结局讨论后继续 3 回合短叙事推演，不重开主 simulation。
  - `证据投牌 (evidence_card)`：把另一条世界线的摘要卡引入当前房间，由档案官解释差异。
  - 两种模式在 `crossline_gallery` 下不可用。
  - `evidence_card` 的 `cited_branch_id` 会做 scenario 级验证，防止跨场景引用。
- `quote / verdict / key_moment / phase` 当前都走显式 `questionAnchorIds`，不再只靠 prompt 文案表达锚点。
- `EndingChatModal / WorldlineRoundtableView` 当前会在线程 rail 与 transcript header 显式显示当前 thread 的 anchor badge。
- transcript `quote` 动作栏当前在触控设备上不再依赖 hover；粗指针设备会直接显示相关操作。
- Oracle 自动化口径当前会输出：
  - `question_anchor_ids`
  - `thread_question_anchor_ids_json`
  - `anchor_kind / anchor_label`
  - `pending_question_anchor_ids`
  - `current_speaker_turn_key`
  - `current_speaker_participant_id`
  - `pending_drafts`
  - `stream_state`
- Oracle 专项自动化当前分三层：
  - `e2e-ending-room-suite` 负责结果页 picker -> live chamber / one-move-only 的基础 smoke
  - `e2e-ending-room-followup-suite` 负责 ending-room follow-up / readonly replay / reload restore / import
  - `e2e-worldline-roundtable-suite` 负责 roundtable live / readonly replay / reload restore / import
- ending-room 基础 smoke、debate full 与 roundtable desktop replay restore 已完成本轮 post-fix 复验。
- ending-room / roundtable 的 replay 回归当前都已收口到同一条自动化口径：
  - header action 只在各自 header action 区域内定位
  - 复用旧页面前先 revalidate live room
  - readonly replay 必须同时满足 replay URL 与只读 UI 契约
- ending-room replay helper 当前识别 `roomReplay / roomShare / roomLocal`；roundtable 页面继续使用 `roomShare / roomLocal`，并兼容 `share / local` alias。
- roundtable 的 readonly replay 当前会跟随 `active_thread_id` 恢复对应 thread 语义；若落在 `hotseat` follow-up，页面不会再退回成 `archivist_route`。
- mobile roundtable artifact replay readonly 当前也会跟随 active replay thread 恢复 `interaction_mode`，不再在自动化口径里卡成 `archivist_route`。
- roundtable 的 scoped regression 当前已覆盖 Chromium 桌面/移动，以及桌面 Firefox / WebKit；`reseat / keyboard reseat / anchored thread / hotseat / witness_augmented / readonly replay` 口径与 Chromium 对齐。
- Oracle 页面当前按用户正在使用的 UI 语言渲染界面壳，不再强制跟随 `scenario.language` 覆盖全局语言开关。
- Oracle fresh live room 的英文 deterministic copy 当前已补去混句兜底，不再把中文 hinge 直接嵌进英文句子。
- `EndingChatModal` 的 mobile sidebar sheet 当前已补可访问标题/描述；sheet 打开时第一次 `Escape` 只收 sheet，不会直接关外层 chamber。
- 结果页 live ending-room 当前把 English 只读保存入口统一为 `Save local read-only copy`；readonly replay 仍保留 `Import as Local Run`。

## 当前工程边界

- 交付形态仍是 `browser-first Web`。
- `跨平台` 当前以 Chromium 桌面/移动与桌面 Firefox / WebKit 的 scoped regression 为准，不表示原生壳或所有移动浏览器组合已单独交付。
- 主模式 authority 已以后端为准：
  - `director_state_json`
  - `gameplay_state_json`
- `scenarioMeta` 仍存在，但只承担缓存、兼容与 replay 输入职责。
- replay 分享优先走后端 `ReplayArtifact`；当 artifact 不可用且 URL token 也过大时，Oracle replay 会回退为本地只读副本链接。
- Oracle / roundtable replay coverage 当前按 fail-closed 收口：
  - replayCoverageError 或 readonly replay / reload restore / import 关键字段缺失会直接失败
  - 不再以 best-effort `summary.json` 保底通过
- 严格慢路径自动化当前仍在继续收口：
  - ending-room follow-up 的慢流式链路仍可能只落到 fallback 观测，不一定每次都能拿到完整 `turn_start / turn_delta / turn_commit`
  - 但 `full / mobile` 当前已改成目标 `roomId + threadId + interaction_mode` 验真；single-ending anchored fallback 也会补校验 `questionAnchorIds` 与 assistant reply，不再接受旧线程空态或只有 user turn 的假阳性
  - roundtable `full` 当前已补 result -> roundtable 入口重试；如果入口仍卡住，会直接落 `roundtable-entry-stall.json` 并失败

## 当前状态

- 主闭环当前维持 `release-candidate` 级别。
- 本轮新增定向复验已通过：
  - `frontend/output/e2e/review-ending-room-mobile-pass3/summary.json`
- 当前无产品级 active backlog；剩余架构级限制见 `overview/backlog.md`。

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
