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

- 首页创建 scenario，支持 agent/rounds、BYOK、玩法档位、quick starts，以及 opt-in 的搜索增强推演。
- 搜索增强当前在首页有两档入口：
  - `沿用服务器默认`：直接复用服务端默认 provider
  - `自定义覆盖`：当前局单独指定 `provider / API key / base URL`
- 当 `agent_identity` capability 开启时，首页会在主模式启动前先跑 continuity preflight；只有命中 L2 fuzzy candidate 时才弹确认框，用户可选 `复用已有身份` 或 `创建新身份`。
- `SimulationView` 负责 live 推演、Theater、干预、玩法卡、结构化押注与 capture。
- `ResultView` 负责结局对比、`counterfactual compare / resume / faction timeline`、档案、campaign summary、分享、导出与 replay/import；当后端写入 `web_search_context` 时，也会显示真实世界来源卡片。结局详情当前只在展开时挂载，收起时不会再把完整 story / key moments 留在可访问性树里。
- replay 分支链路当前也已补硬化：`counterfactual` 会在 clone 前校验目标 round 里确实有该 agent 的消息；如果 seed 失败，会清理掉刚创建的脏 branch；`resume` 只有在预占 `simulation lock` 成功后才会返回 started。
- graph viz 当前已收口：`CausalReviewView` 会忽略 stale branch 响应；URL 里带不存在的 `branch_id` 时会直接报错，不再伪装成空图；分支 selector 会优先显示 scenario branch 的标题和概率，拿不到元数据时才回退 branch id；多节点但 0 edges 时会直接切到本地化的 event snapshot fallback，不再把它伪装成可交互 DAG；非交互 fallback 只保留一条具名的 a11y 列表；导出失败会显示明确提示；图面 minimap 改为非交互 overlay，移动端不会再挡住节点点击。`NodeDetailPanel` 在切换节点后关闭时会把焦点还给最新 trigger；`Copy Reference` 会先走 clipboard API，失败再回退 `execCommand`。

### Debate Arena

- 独立 debate 域，包含 live/result/replay。
- 已落地结构化押注、counterplay、judge rationale、supporting turns 与 replay import。
- result 页里的 argument map 当前改成按需加载；首屏先给 `Load map`，只有用户点开后才真正挂图。
- 当前 phase 视图会保留更早 phase 的已出现 turns，并以折叠历史卡形式留在当前 live 视图里，不再直接丢掉。
- 页面级播报当前仍以 phase cue 为唯一 live region；`SpotlightTurnCard` 的高亮态不再单独挂 `aria-live`，避免同一轮变化被重复播报。
- quick counterplay 当前只在 live 当前 phase 的 bet window 可提交；锁到历史 phase 时不会再发起 quick hedge。
- debate argument map 当前保留 rule-based 抽取，并默认追加每个 turn 一次 fire-and-forget LLM enrichment；上游 provider 慢或失败时会自动回退成纯规则结果。
- debate argument map 的 enrichment apply / rebuild 当前按串行收口；改写 unit type 后会按最新 claim 状态重建 `rebuts / supports` target。当前同一 turn 有多条对手 claim 时，`rebuttal` 会按句子顺序挂到最后一条 claim，而不是按 hash 顺序乱选；verdict 重算也会同步刷新 verdict 节点元数据，不再只改 unit 状态
- debate argument map 的 fail-soft 当前会显示明确失败文案和 `Retry`，不会再被误判成普通空态。
- Debate 页面壳当前继续跟随用户自己的 UI 语言，不会再因为 `debate.language` 或结果 payload 反向切全局语言；结果页的 mixed-language fallback 已覆盖 `phase commentary / replay quote / prediction score reason` 这些长文案来源，命中时会显示明确 fallback note，并保留原文展示。

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
- ending-room 基础 smoke、`e2e-debate-suite full`、`e2e-ending-room-followup-suite full` 与 roundtable desktop replay restore 已完成本轮 post-fix 复验。
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
- 本轮 graph-viz / replay hardening 定向回归也已通过：
  - backend graph / replay / migration suite `262 passed`
  - backend 相邻 API / service smoke `154 passed`
  - targeted `ruff check` 通过
  - frontend graph suite `114 passed`
  - frontend `typecheck / lint / build / perf budget` 通过
  - frontend 全量 vitest `989 passed`
  - backend 全量 `2039 passed, 2 skipped`
  - production preview 不再出现 `react-vendor` 环导致的首页 / graph 白屏
  - phase3 compare fixture 当前已带真实 `agents / messages`，compare theater 不再空载
  - `phase3-batch-a full` `35/35`，default / `zh-CN` locale 都通过
  - `phase3-batch-b full` `43/43`，default / `zh-CN` locale 都通过
  - graph scoped cross-browser desktop rerun 也已通过：`phase3-batch-a` / `phase3-batch-b` 的 Firefox / WebKit 都通过
  - `e2e-debate-suite full` 通过
  - `e2e-ending-room-followup-suite full` 通过
  - Oracle scoped cross-browser roundtable 的 Firefox / WebKit rerun 通过
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
