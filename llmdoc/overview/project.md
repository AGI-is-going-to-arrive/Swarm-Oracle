# SwarmOracle — 项目概览

> 文档类型：L0 current-truth
> 作用：当前产品范围、能力边界与测试口径真值。逐轮验证流水保留在 `progress.md`。

## 项目定位

AI "What-If" Prediction Playground — 用户提出一个历史/假设性问题，AI agents 实时辩论并探索分支时间线。

## 核心功能

| 功能 | 描述 |
|------|------|
| Multi-Agent Simulation | AI角色带有persona、立场、情绪进行辩论 |
| Branching Timelines | 决策产生平行分支，附概率追踪 |
| Butterfly Effect | 支持实时、回溯与批量干预；前端当前已有统一干预弹窗闭环；标准干预成功响应现会显式返回 queue feedback（`pending_count / queued_ahead`）；当请求明确携带玩法卡身份时，后端也会按 shared gameplay contract 校验 `manual_enabled / min_round / cooldown / director points`，不再只靠前端约束；当多个 backend worker 共用同一个 SQLite 文件时，待注入干预也会先落到共享 pending queue，再由模拟主循环按分支 FIFO 消费；回溯新分支当前还会带 `0.3` 的概率下限，不再因为连续回溯把概率一路衰减到过低 |
| Multi-Ending Comparison | 跨分支比较结局、洞察、关键时刻 |
| Oracle Chambers / 世界线圆桌 | 当前口径是“前端可玩签收版 + 后端 Phase B+ 基座”：结果页每张结局卡会先经过 participant picker，再进入 `进入会客厅 / 只改一步 / 异线旁听席`；前端 `EndingChatModal + endingRoomStore + useEndingRoomWS` 已接入 follow-up thread、`archivist_route / hotseat / all_present`、room/thread scope notice、participant 卡与 Oracle 专属 UI 资产，`crossline_gallery` 也已产品化成只读摘要旁听视图；`WorldlineRoundtableView + worldlineRoundtableStore + useWorldlineRoundtableWS` 现已落地 live roundtable、`改选代表并重开`、`archivist_route / hotseat` 追问、只读 replay，以及 `manual_shortlist / expert_witness` 两条扩展桌型。后端除独立 `ending_room` 域、REST/WS、branch-scoped transcript isolation 外，也已补齐 `selected_agent_ids / selected_representatives / selected_witness / follow-up thread / user-turn / room-thread memory partition / worldline echo / all_present`，并把 Oracle 关键文案链路升级成 `LLM-first + deterministic fallback`，同时补了 room-stable `user participant` 与 SQLite `database is locked` 短重试。最新稳定 `release:signoff` 工件 `frontend/output/e2e/20260330-full-release-signoff-stable/summary.json` 中，`ending_room_followup / roundtable_full / debate_full` 均为 `passed`；本次 session 又额外实测通过了 `crossline_gallery / manual_shortlist / expert_witness` 的专项验证。当前未完全签收的残余主要集中在 replay/share/import 最终专项签收、follow-up 与经典模式的流式一致性、roundtable mobile 一屏体验，以及 `trait_mix / fault_line_first / witness_augmented` 这些后续桌型与选席策略。 |
| Real-time WebSocket | 实时观看 agent 发言流；`scenario / debate` 两条 WS 当前都会在空闲期发送轻量 `heartbeat`，让半断开连接能更快在发送路径上暴露并清理；同场景广播当前也已改成并行发送，单个慢连接不会再拖住其它在线客户端；除 `heartbeat` 外，后端当前还会给所有出站事件统一补顶层 `meta`（`stream_id / sequence / event_id / manager_instance_id / emitted_at`），前端 scenario / debate hook 会按 `sequence/event_id` 做重复丢弃和 gap 补拉；本地排查时还可用 `?wsDebug=1` 或 `sessionStorage['swarmoracle.ws-debug']=1` 打开前端时序日志 |
| Hierarchical Agents (P3-A) | Leader-Worker分层架构，支持千人规模模拟 |
| Prediction Leaderboard (P3-B) | 用户竞猜 + LLM评分 + 排行榜；当前每个 `scenario_id + user_id`（含匿名 `anonymous`）只允许 1 条 prediction；这条约束现在不只靠应用层检查，SQLite 也已补上唯一索引，竞态下仍会稳定返回 `409 PREDICTION_ALREADY_SUBMITTED`；当 `user_name` 留空时，后端会按场景语言回退到匿名预言家 / `Anonymous Predictor`，但匿名 prediction 现在不会再出现在 leaderboard，也不会再影响 leaderboard / win streak 聚合；`GET /api/scenario/{id}/predictions` 未传 `limit` 时当前默认分页 `50`；leaderboard 重算里的 `win_streak` 当前也已改成分批扫描，不再一次性把用户全部已评分 prediction 拉进内存；当删掉某用户最后一条已评分 prediction 时，对应 materialized leaderboard row 现在也会被直接清掉，不再留下 `total_predictions = 0` 的空行；批量评分接口当前也会显式返回 `attempted / scored / failed / all_failed`，能区分“没有待评分 prediction”和“本次全失败”；结果页手动触发评分时，当前也会复用同一份前端会话级 provider policy |
| Structured Betting 2.x | 结构化押注世界线 / 结局倾向 / 题材回响，Theater HUD 可直接打开下注入口；`PredictionModal` 当前会先展示下注摘要（下注类型 / 目标 / 当前轮次 / 当前承诺），若当前没有可下注活跃世界线，也会直接提示改押结局倾向 / 题材回响 |
| Gameplay Cards | 当前共有 14 张玩法卡：10 张原始导演卡 + 4 张反制卡（`审计清算 / 情报反噬 / 民意回摆 / 停火委员会`）；玩法卡会按题目画像动态推荐，弹窗现会显示题材 hooks、题材导向文案、三段式题材连锁事件、profile-specific 打法说明，以及常驻 `风险 / 资源` 轨道；目标分支 / 角色 / 来源分支 / 自动文案当前也已收成 `override + derived` 口径，减少 modal 内部级联重算；正式玩法卡注入现在会把 `card_id / profile_id / directive` 一起带进后端，由后端按 contract 校验通过后再真正落 usage authority；玩法卡注入仍会被 LLM 当成高优先级、持续生效的导演事件 |
| Shared Gameplay Contract | 玩法卡与题材画像已有共享契约 `shared/gameplay_contract.v1.json`；前端 `gameplayContract.ts` 直接消费卡牌规则、modal 输入契约与 prompt 语义，后端 `card_events.py` 当前主要消费 card event 映射与 `branching_bonus`，并有同步测试覆盖；`load_gameplay_contract()` 本身支持按文件 mtime 刷新，但 `interventions.py` 对 manual gameplay card defs 仍采取“进程启动时取一份快照”的设计，所以如果运行中直接改 shared contract，干预 API 仍需要重启 backend 才会吃到新卡牌定义 |
| Director Goals & Worldline Commitment | Theater 局内现有最小导演层：2 个短目标、常驻 `风险 / 资源` 轨道、worldline 承诺，以及结果页中的目标完成度 / 承诺命中或落空结算；这批状态当前已后端化到 `Scenario.director_state_json`，并补上 `revision` 版乐观并发控制：前端写入会带上当前 revision，后端若发现 stale 写入会返回 `409`，页面随后会回读最新 authority，并给出可见反馈，而不是静默覆盖 |
| Gameplay State Authority | 主模式 `cards.usageLog / betting.bets / archive.key_moments / archive.branch_snapshots` 当前都已后端化到 `Scenario.gameplay_state_json`；前端会优先从远端 `gameplay_state` 回填 usage log、下注列表与 archive raw，再基于这些真值重算导演点数、卡牌冷却、`mostUsedCard`、`counterplayCardCount` 与 `lastCounterplayCard`；玩法卡注入成功后，usage 现在直接以后端返回的 `gameplay_state` 为准，不再先靠本地 meta 假写一份导演点数 / cooldown；结果页当前也已改成远端 authority 优先，只有远端缺字段时才回退本地 `scenarioMeta`，而且远端只显式带某个 gameplay 分区时，不会顺手清掉其它本地兼容字段；`SimulationView` 当前也只会在 backend `gameplay_state` 仍为空时才把本地 compat 回写后端，一旦远端 `gameplay_state` 已有有效内容，就不再把 stale local `usageLog / bets` 混回 authority 链路；authority 写路径当前已补齐 `revision` 版乐观并发控制，stale PUT 会得到 `409` 并自动刷新最新 authority；前端比较远端/本地 gameplay authority 时，当前也已改成显式结构化比较，不再靠 `JSON.stringify(normalizeGameplayState(...))` 做等价判断；同时 `scenarioMeta` 的 localStorage / replay 输入也继续压缩：archive 摘要重复字段、usage-derived director/cooldown 与大部分 replay 冗余状态都不再长期保真，写路径还补上了按 `scenarioId` 维度的跨标签写锁与订阅刷新协议，减少同一局多标签页互相覆盖本地缓存；当 replay snapshot 已自带远端 authority 时，`scenario_result_v1 / simulation_view_v1` 现在还会进一步剔除 authority-backed `cards / bets / branchSnapshots`，只保留最小兼容输入 |
| On-Demand Theater Loading | Theater 现在只会在用户真正切进 Pixel Theater 后，按 idle 时机预热 Phaser；`PhaserGameLoader` 本身已在 Theater 动态边界，且当前会跳过隐藏页面、`prefers-reduced-data`、`saveData`、`2g/slow-2g`，以及低内存 / 低并发设备下的无谓预热；Classic 视图下只有在页面可见、设备允许且用户 hover/focus 到 Theater 切换按钮时，才会轻量预取 loader chunk；`BootScene` 当前只预载首屏初始 theme 与 `sprite_default + 初始角色 sprite`，其余缺失 sprite 改由 `WorldScene` 在 agent 真到场时按需补载；后续 `scene_change` 背景与 `EndingScene` 大图继续按需补载；默认前端构建 / 测试链路当前还会通过 alias 将 `phaser` 指向本地精简入口 `frontend/experiments/phaser-custom/entry.mjs`，把 `phaser` chunk 收口到约 `719 kB / 204 kB gzip`；截图链路也继续拆成 screenshot / GIF 两条 runtime，构建产物从单块 `capture-vendor` 收口到 `capture-html / capture-gif` |
| Landing Route Summary Split | 首页当前只读取轻量题材摘要 helper（`label / hooks / badge`），不再直接依赖完整玩法策略表；深层玩法 contract / strategy helper 仍由 `gameplayCards` 与导演层链路在后续路由里消费 |
| Causal Archive | 结果页沉淀玩法记录、下注记录、关键记录、世界线快照与画像摘要；现已包含 `mostUsedCard`、`bettingHit`、`archiveGrade`、`dominantBranchTitle`、`dominantTone`、`directorStyleTag`、`profileResonance`。结果页当前会先读取后端 `director_state`、`gameplay_state` 与 `campaign summary`，并以远端 authority 作为展示基线；只有远端缺字段时，才会回退本地 `scenarioMeta` 的兼容内容；如果远端只回某个 gameplay 分区，也只替换那一块，不会误清空无关的本地兼容字段；当前派生出的 archive/objectives 只保留在内存里用于展示，`displayArchive` 与 `displayBranchSnapshots` 会优先按 story/usages/bets/campaign summary 现算；`result / simulation replay` payload 里的 `scenarioMeta` 也继续精简，读路径会在进入 replay 页面时把 usage-derived 状态补回运行态；本轮又把结果页顶部的 runtime preset 收成单个标签，分享弹窗去掉了上方 context chips，主模式社交文案也不再自动在正文前拼题材档案或神谕档位前缀 |
| Daily Challenge | 首页每日挑战卡，一键带入题目/轮数/Agent 数/Theater 参数；挑战池仍为 12 条，覆盖治理/帝国/战争/工业/边疆/贸易/法律/信仰/生态/神话/生存/通用，但 today / weekly challenge 定义当前已改由后端 `challenge rotation` API 下发；这条 rotation 现在走后端固定顺序，后续只追加 challenge catalog 条目时，不会把既有日期映射整体挪位；前端 localStorage 只保留 `started / completed / usedCards / betPlaced` 这类本地进度，并继续把后端 `campaign daily-status` 真值合并成首页完成态、已用卡数、下注态与题材回响反馈；本地缓存当前会按最近约 `30` 天做懒清理，不再无限累积旧日期桶 |
| Director Campaign (Track A) | 导演生涯最小闭环已落地：后端已有 `director_profile / profile_mastery / director_badge_unlock / scenario_campaign_log` 与 `finalize/profile/mastery/badges/daily-status/weekly-summary/scenario/{id}/summary/director-state` API；结果页会在完成后结算并展示本局 campaign 增量、等级与新徽章；首页现还会显示 `director growth` Lite，总结累计 runs、badge 数和 Top mastery；结果页可直接复制分享 challenge 链接，让别人按同题同参数再打一遍；当 `user_name` 留空时，后端会按场景语言回退到匿名导演 / `Anonymous Director`；若该局已经有 bets，但前端没有带上 `betting_hit`，后端当前会直接拒绝 finalize，而不是静默按“未命中 / 未下注”继续结算；结果页在同一标签页会话里还会缓存同一 `scenario + director + profile` 的 finalize 完整结果，二次进入时不再重复 `POST /finalize` |
| Debate Arena (Track D) | 已落地独立 Debate domain：`/api/debate` + `/ws/debate/{id}` 后端竖切、首页 `Debate Arena` 入口、`/debate/:id` live 页、`/debate/:id/result` 结果页、结构化押注（`winner / verdict_tone`）、`render_game_to_text()` / `advanceTime(ms)` / `capture_game_screenshot()` 自动化钩子；当前终局裁决已升级为 **LLM hybrid**：后端会优先读取 judge analysis 里的 `adjudication` scorecard，与 deterministic plan 混合后生成最终 `winner / verdict_tone / breakdown`，结果 payload 会显式带 `adjudication_mode`；若 LLM 不可用或输出无效，会退回 deterministic fallback；当 hybrid adjudication 没有给出合法 `winner` 时，tie-break 当前会回退到 `base_plan.winner`，不再默认偏某一侧；live / result 顶层现还会返回每阶段 `phase_insights`（`stakes / judge_focus / commentary / confidence_drift`），`debate_verdict` WS 事件也会一起带上这批阶段洞察；结果页会继续返回 `supporting_turns`，分享文案会带 1-2 条关键引文；创建后仍保留短暂 pre-roll 供 live 页下注，但当前只在 `DebateStatus.LIVE + opening/crossfire/rebuttal` 接受新押注，`QUEUED / ERROR / DONE / closing / verdict` 都会拒绝新押注；live 页的下注 modal / quick counterplay 当前也会严格跟随后端 `available_prediction_options`，不再靠前端硬编码目标；`counterplay` 现在除了 `phase_score / explanation`，还会显式改写对应阶段的 `phase_insights.commentary`，并同步进入 replay digest 与 share copy；本 session 又把 replay import 的 `phase_insights` 做成持久化保真，同时把 `winner / verdict_tone / turn sequence / phase_insights` 的关键字段收成显式导入校验，坏快照会直接返回 `422`，而不是静默落库 |
| Portable Replay & Import | 主模式 `ResultView / SimulationView` 与 Debate `DebateResultView` 当前都支持 replay 页面。主模式优先走后端 `ReplayArtifact` 短 `share id`（`/result/replay?share=...`、`/sim/replay?share=...`），失败时再回退到本地 token；Debate 结果页当前使用 `/debate/replay/result?replay=...`。主模式 `scenario_result_v1 / simulation_view_v1` 当前都会先压缩 `scenarioMeta`，当 snapshot 已自带 authority 时还会去掉 authority-backed `cards / bets / branchSnapshots`，并把 `objectives / commitment` 收成更小的 replay 形态；读路径再按 usage/bets 现算回补 usage-derived 状态。三条 replay 页默认都是只读模式，但都支持“导入为本地运行”，把当前快照落成真实本地 scenario / debate 记录；其中 Debate replay import 当前除了保留 `phase_insights`，也会先校验关键枚举和 turn 顺序，再决定是否入库；对完全相同的 Debate replay payload，导入链路当前也已改成幂等返回，不再重复创建本地 debate 记录 |
| Generic Quick Start | 首页 generic 题材现有 3 条 `switchboard_forum` 题库，并会一键带入推荐预设（Theater / 4 rounds / 4 agents / blackboard） |
| Scenario Management (P4-A) | 场景列表/删除/导出 Markdown；结果页当前已把导出链路改成浏览器直接下载后端附件，避免 Chrome 把前端 `blob:` 导出记录成随机 UUID，目标是更稳定地拿到 `.md` 文件名；scenario delete 继续采用应用层 orchestrated delete，而不是数据库级 `ON DELETE CASCADE`，因为这条链路还要同时回滚 campaign 聚合、重算 leaderboard、清空 badge `source_scenario_id` 并 best-effort 清理 vector store；删除主链现在还带有删除后完整性守卫，若仍发现残留引用会直接回滚并返回 `500 SCENARIO_DELETE_INTEGRITY_FAILED` |
| Intervention Templates (P4-D) | 预设干预模板（自然灾害、技术突破等） |
| BYOK (P4-E) | 用户自带 OpenAI 兼容 API Key/URL/Model/RPM/TPM；前端 provider policy 当前按标签页会话保存在 `sessionStorage`，关闭标签页后清空；若浏览器里还留有旧 `localStorage` 记录，前端首次读取时会自动迁移一次；同一份 policy 仍会贯通 `createScenario / createDebate / social copy / scorePredictions`；首页 BYOK 现在会给每个字段补一句人话说明；`Test Connection` 仍会返回 provider probe 摘要，但当请求明确给了较低 `RPM` 时会改走更保守的 configured-budget probe，不再先把 provider 配额打满；用户填了 `RPM / TPM` 后，首页会即时显示预算提醒，并在当前 `agents / rounds` 超预算时直接禁止主模式 `Start Simulation`；若是本地 / 自托管 provider，本轮仍可显式关闭 user-level quota，但不会绕过全局并发闸门 |
| Scenario Runtime Tuning | 主模式当前已把 scenario 级 runtime tuning 正式挂到首页，入口名称为 `神谕档位 / Oracle Profile`，三档分别是 `守望 / 校准 / 裂界`（`Watchful / Calibrated / Riftbound`）；它们只作用于主模式的世界线分岔，不改变 Debate Arena。底层仍映射到 `temperature / branch_sensitivity / fork_prompt_variant / fork_detector_active_branch_limit` 这组 runtime tuning，其中 `fork_detector_active_branch_limit = 0` 当前已作为合法值进入产品链路，表示关闭预算。相关值会进入场景 authority 与 `fork_debug.round_checks`，既能做 fork detector 行为实验，也已经是首页正式起局参数的一部分 |
| Fork Detector Control Room | 前端当前新增独立静态页 `frontend/public/fork-control-room.html`，把控制变量、交互沙盘、实验图表和推荐配置放在同一页里，方便浏览器内直接阅读与分享 |
| Fork Budget Control | 当前 detector 还支持结构级预算开关 `fork_detector_active_branch_limit`。跨题实验结果表明：`k=1` 是目前最稳定的“压 branch 爆炸但不把多结局打没”的配置；`k=2` 也能降噪，但明显弱于 `k=1` |
| Frontend State Split | 首页当前已按 `useInputByokSettings / useInputCampaignState / useSharedChallengePrefill` 三组 hook 收边界；模拟页当前也按 `useSimulationReplayState` 与 `useSimulationViewState` 分开 replay、截图和 director authority 状态；`simulationStore.startSimulation()` 与 `api/client.ts#createScenario()` 现统一走 options 对象，不再靠长位置参数串联 |
| Social Media Copy (P6) | 一键生成小红书/微博/知乎/Reddit/X 平台文案；主模式结果页分享弹窗当前会明确区分生成中 / 已生成 / 可复制状态，生成完成后会给出更直白的“文案已生成 / 可直接复制或切平台”反馈；社交文案请求当前走独立更长超时窗口，避免在正常 LLM 延迟下被前端过早中断；文案 wrapper / prompt 当前会跟随场景语言，英文场景不再混入中文包裹文本；当前语言策略已显式化为“所有平台都跟随场景语言”，`reddit / x` 不再单独强制英文；若浏览器 Clipboard API 不可用，分享弹窗现在会明确提示手动复制，而不再回退到过时的 `execCommand('copy')` 路径；本轮又继续收口主模式分享链路：分享弹窗正文上方不再显示题材 / 神谕 / 钩子 chips，主模式社交文案也不再自动在正文前拼接题材档案、神谕档位或 permalink 前缀，避免把上下文噪声一起塞进用户最终要发的平台文案里 |
| Language Detection (P9) | 输入语言自动检测 + 全链路 LLM prompt 语言指令注入；当前检测覆盖 `Chinese / English / Japanese / Korean / French / German / Spanish / Portuguese / Italian`，生成内容统一跟随输入语言 |
| Language Switcher (P9) | 全局 EN/ZH 切换器；桌面端固定右下角，小屏普通页面会移到右上安全区，Theater 小屏继续贴底部安全区 |
| Collapsible Sidebar (P7) | 可收起Agent面板，磨砂玻璃药丸Toggle，无边框残留 |
| Branch Discussion Cards (P7) | 分支卡片实时显示agent讨论，脉冲动画提示新发言 |
| Agent Message Filter (P7) | 点击agent图标查看该agent全部历史轮次消息 |
| Code Review Hardening (P8) | 防重入锁、模拟超时、级联删除补全、概率归一化、消息上限/dedup、指数退避、CSS 兼容性 |
| Codebase Refactoring (P0-1) | scenarios.py 拆分为 schemas/helpers/interventions/social 四模块，提升可维护性 |
| N+1 Query Optimization (P0-2) | 消息查询使用 LEFT JOIN 替代逐条查询，保留已删除 agent 消息完整性 |
| LLM Retry with Backoff (P1-3) | 429/5xx 自动重试 3 次，指数退避 1s→2s→4s |
| Alembic Migrations (P1-4) | 数据库迁移框架，支持版本化 schema 变更 |
| Prometheus Observability (P3-9) | `/metrics` 当前已在本 session 做过真实验证：若 `prometheus-fastapi-instrumentator` 可用，则暴露完整 Prometheus 指标；若依赖缺失，后端也会回退返回可审计的文本指标，而不是静默 404 |
| Pixel Art Visualization (Phase 1) | 像素风可视化基础设施 — 事件映射 + 精灵分配 + 场景选择 + 卡牌事件 |
| Reasoning Visualization (Phase 2) | 核心推理可视化 — 天气/昼夜系统 + 阵营标记 + 气泡变体 + 粒子特效；后续语义场景池已在此基础上扩到 30 个背景主题，补上 `law_court_variant / faith_temple_variant / switchboard_forum_variant` 三个变体场景；generic 仍保留 `switchboard_forum / 轮值议堂` 主场景 |
| Gamification UI (Phase 3) | 游戏化打磨 — 标题画面 + 6种结局演出 + MiniMap HUD + 竞猜面板 + 排行榜 + 截图/GIF导出 |
| HUD Migration (Phase 5) | 排行榜/竞猜面板迁移至 React 层 — HudOverlay.tsx 浮层渲染，画布无遮挡 |
| Visual Upgrade (3.0 Phase A) | 动态场景 & 角色选择 — WS 广播 viz:scene_init + 前端 VizSynthesizer 关键词匹配 |
| Visual Upgrade (3.0 Phase B) | 美术风格全面升级 — GBC 调色板统一 + 35 素材重生成 + TitleScene 打字机/跳过/扫描线 + WorldScene 视差/打字机气泡/擦除过渡 |
| Visual Upgrade (3.0 Phase C) | UI/UX布局优化 + Theater模式完善 — SimulationView布局重构 + GBC暗色主题 + HUD像素风 + 8个Theater Bug修复（精灵/气泡/漫游/多轮回放） |
| Theater Bubble Bugfix (3.0-D) | 剧场气泡冻结修复 — `visualization_enabled` 参数透传后端 + 增量气泡分发竞态条件修复（fallback synth init）+ Scenario hydration 恢复 Theater 模式 + completed replay 自动跳过 `TitleScene` 回到 `WorldScene` |
| Theater Stability Hardening (3.0-E) | 剧场稳定性加固 — simulator 将数值/文本 stance 统一归一化到可视化坐标，避免中文立场词在 Theater 链路中触发类型错误 |
| Automation QA Hooks | 浏览器自动化钩子 — `render_game_to_text()` 覆盖关键页面，Theater 暴露 `advanceTime(ms)`；InputView 现在会输出 `page.daily_challenge / page.weekly_challenge / page.director_growth`，以及 `byok_requests_per_minute / byok_tokens_per_minute / controls.can_start_simulation` 这组预算相关状态；Simulation 页面输出 `page.replay_state / replay_source / warmup / director / betting`，ResultView 输出 `archive_summary / result_bet_list / result_key_moments / result_branch_snapshots`，DebateResultView 输出 `replay_source` 与 `result.adjudication_mode`。前端提供 `e2e:matrix / e2e:variants / e2e:corners / e2e:cross-browser / e2e:safari / e2e:full` 与 `e2e:debate:*` 入口；主模式 `mobile` 现通过 `scripts/e2e-suite.mjs mobile` 进入签收链路。`corners` 当前包含 deterministic `live_fork_marker`、director/gameplay roundtrip、share context/share retry 等用例；`e2e-suite.mjs` 里的 result preflight、share 等待与 director/gameplay authority roundtrip 也都已收口到更稳定的 automation 条件。`release:signoff` 会落盘带 git `branch / commit / worktree` 绑定信息的 `summary.json`，并把 backend targeted `pytest`、`/metrics`、`tsc / build / perf budgets / assets / corners / mobile / cross-browser / ending_room_followup / roundtable_full / debate:full` 组成默认签收合同；在显式要求时，Debate signoff 还会校验 `adjudication_mode`。CI 当前除了 `debate-signoff-smoke` 之外，还新增了 `release-signoff-fixture`：无 secrets 时，主模式会走隔离 mock LLM（默认 `18318`），Debate 强约束 `deterministic`，不会占用真实 LLM 路径。本 session 除了旧的稳定 `release:signoff` 工件，还额外实跑通过了 `frontend/output/e2e/rpm-tpm-full/summary.json`、`frontend/output/e2e/rpm-tpm-ending-room/` 与 `frontend/output/e2e/rpm-tpm-roundtable/`；当前 checkout 是否已严格签收，仍应以你最后一次实跑的 `summary.json`/工件为准。 |
| Semantic Scene Pool | 当前 registry 共有 33 个主题条目：30 张 Theater 语义背景 + 3 张 Debate 专属背景；`scene_selector` / `VizSynthesizer` 会优先扫描原始题面，按问题语义选择更贴题的场景，而不是做粗暴轮换；原有法庭 / 信仰 / generic 变体仍保留，Track D 另补 `debate_arena_civic / debate_arena_judicial / debate_arena_forum` 三张辩论专用背景 |
| Theater Replay Director | 完成态 Theater 支持按世界线/轮次筛选回放，并保留重播/跳到最新/倍速控制；compact TimelineBar 直接嵌回 Theater 面板内，显示 `fork/card/bet/result` marker |
| Result Loading Gate | 用户过早打开 `/result/:id` 时，结果页会先 loading，等待 narration 真正完成后再展示，不再把半成品 branch 当最终结果 |
| LLM JSON Hardening | narrator 与 agent 发言链路都补了 JSON 容错：叙事阶段会归一化 `list` payload，agent 阶段会恢复轻微坏 JSON 或纯文本，尽量不丢整条发言 |
| LLM Runtime Guard | 当前后端已增加进程内全局 LLM 并发闸门、pending 上限、用户级 pending 配额和 provider 熔断；当多个进程共享同一个 SQLite `DATABASE_URL` 时，pending / quota 计数还会通过 SQLite 轻量占位表共享；这条 reservation 路径当前也已收口到 engine-managed SQLAlchemy connection，不再单独开 raw sqlite3 双连接；用户题面、干预文本、评分输入与分享上下文也会按 `UNTRUSTED DATA` 口径注入，减少坏 JSON 与提示词注入带来的链路抖动；非本地 LLM 端点现在会在配置加载阶段拒绝占位 API key，`llm_call / llm_call_stream` 也已改成复用共享 `AsyncClient`，其中流式路径在首个内容真正产出前支持连接重试 |
| Background Runtime Lock | 主模式 simulation 与 Debate background task 当前都会在同一个 SQLite 文件上申请共享 lease；当多个 backend worker 共享同一个 `DATABASE_URL` 时，同一场景 / 同一辩局不会再被重复启动，worker 异常退出后也会靠 lease 过期回收 |
| Scenario Bootstrap State | 新建 Theater 场景时，`POST /api/scenario` 立即返回 `simulating`、`scene_theme` 与 provisional root branch，避免首屏完全空壳 |
| Generated Gameplay Art | 使用 Gemini 图像模型生成并接入玩法卡专属 frame、Theater 场景背景、徽章和因果档案装饰面板；Track D 本轮另生成了辩论专用背景、stage banner、verdict panel、score meter、三方 badge 与 quote frame；Oracle Chambers 这轮又补了 `oracle_chamber_panel / oracle_chamber_crest / oracle_quote_frame / worldline_roundtable_panel / worldline_roundtable_banner / badge_* / ending_room_participant_frame / ending_room_influence_badge / ending_room_speaker_glow / archivist_emblem / worldline_dossier_divider` 这组专属资产，并已把其中一部分接到 picker / chamber / transcript 上；当前 `frontend/public/assets/ui/generated + frontend/public/assets/scenes` 下 77 张 PNG 都已有同名 `.meta.json` sidecar，其中较新的 Debate / Oracle 资产保留完整生成字段，较早的 legacy 资产则使用诚实回填的 provenance 记录；这里的 backfill 代表 sidecar 补齐，不代表恢复了原始生成时间、模型或 prompt |
| Theme Registry & Asset Manifest | 前端已把 33 个 Theater / Debate 场景主题、关键词、题材画像归属，以及玩法 / 辩论 / Oracle 的 frame / badge / ornament 统一收进 `themeRegistry.ts`，减少扩主题时的多处手工同步；Track D 的 `DEBATE_UI_ASSETS` 与 Oracle 这轮新增的 `ORACLE_UI_ASSETS` 现在都走同一套 registry。本轮又把 7 张原先只在库存里的 sprite（`alchemist / assassin / bard / knight / monk / thief / witch`）接入运行时角色池，并同步收口了前后端 persona/role 映射；当前 `BootScene` 只预载首屏初始 theme 与 `sprite_default + 初始角色 sprite`，其余缺失 sprite 改由 `WorldScene` 在 agent 真到场时按需补载；后续 `scene_change` 背景与 `EndingScene` 大图继续按需补载，旧 `bet_panel / leaderboard / title_screen / minimap_frame` 也不再是 Theater 首次进入硬依赖 |
| Theater Readability Pass | Theater 本轮又做了一轮“上方更薄、中间更大、气泡更清楚”的可读性修复：右栏改为固定窄宽，`game-wrapper` 提前到 replay filters/timeline 前，compact TimelineBar 隐藏二级 stats，bubble 字号/换行宽度/描边/分辨率也一并提高 |
| Open Source Polish (Phase 4) | 开源准备 — Weather 粒子对象池 + ambient mote 对象池 + 视口裁剪 + `ASSET_CREDITS` 现已同步到 Debate Arena 新资产；`generate-ui-assets.mjs` 会继续为新图像写入完整 sidecar，而 `assets:provenance:backfill` / `assets:provenance:check` 则负责把 legacy UI/scenes 资产补成可审计的 sidecar 完整态，但不会伪造原始生成记录 |
| Platform Scope | 当前交付形态是浏览器优先的 Web 应用；主模式现已有 `e2e:cross-browser` 与 `e2e:safari` 正式 smoke 入口，并已实跑 Chromium/Chrome、Firefox、WebKit 与 Safari 的主模式状态回读；桌面/移动浏览器视口也已做响应式与 E2E 复验，但不包含原生 Windows/macOS/Linux/iOS/Android 客户端壳 |
| i18n | 中英文支持 |

## 架构

```
┌────────────┐           ┌────────────────┐
│  Frontend  │ ◄──WS──►  │    Backend     │
│  React/TS  │ ◄─REST──► │ FastAPI/Python │
│  Vite+Nginx│           │ SQLite+Chroma  │
└────────────┘           └────────┬───────┘
                                  │
                          ┌───────▼───────┐
                          │  LLM Provider │
                          │ (OpenAI-compat)│
                          └───────────────┘
```

## 技术栈

### Backend
| 层 | 技术 | 版本 |
|----|------|------|
| Framework | FastAPI | ≥0.115 |
| ORM | SQLModel (SQLAlchemy + Pydantic) | ≥0.0.22 |
| DB | SQLite (主存储) + ChromaDB (向量存储) | — |
| HTTP | httpx | ≥0.28 |
| WS | websockets | ≥14.0 |
| Config | pydantic-settings | ≥2.7 |
| Python | ≥3.11 | 3.13.12 (当前) |

### Frontend
| 层 | 技术 | 版本 |
|----|------|------|
| Framework | React | 19.2 |
| Build | Vite | 7.3 |
| Language | TypeScript | ~5.9 |
| State | Zustand | 5.0 |
| Routing | React Router DOM | 7.13 |
| Visualization | @xyflow/react + dagre | 12.10 |
| Game Engine | Phaser.js | 3.x |
| Animation | GSAP | 3.14 |
| i18n | i18next + react-i18next | 25.8 / 16.5 |

### Testing
| 工具 | 覆盖 |
|------|------|
| pytest + pytest-asyncio | Historical full baseline: **815 passed**。当前发布判断以后端 targeted `pytest` 与 `release:signoff` 为准；最新 signoff backend set：**156 passed** |
| Vitest + jsdom | Historical full baseline: **179 passed**。当前发布判断以前端 targeted `vitest` 与 `release:signoff` 为准；最新 targeted frontend set：**112 passed**，且 `tsc` / `build` / assets check 通过 |
| conftest.py | 每测例独立临时 SQLite fixtures（前后显式释放 engine，避免 readonly / disk I/O 冲突） |
| benchmark_compression.py | 压缩质量离线标尺 (3场景 × 4维度) |

- 本 session 还额外实跑了后端回归子集：`269 passed`
- 本次这轮“首页神谕档位正式化 / Result 页与分享弹窗去冗余 / 导出 Markdown 改走后端附件下载”改动，当前已额外实跑通过：
  - `cd frontend && npm test -- --run src/pages/InputView.test.tsx src/i18n/locales.test.ts`：`14 passed`
  - `cd frontend && npm test -- --run src/components/ShareModal.test.tsx src/pages/ResultView.test.tsx src/lib/shareEnvelope.test.ts`：`22 passed`
  - `cd frontend && npx tsc --noEmit -p tsconfig.app.json`：通过
  - `cd backend && .venv/bin/python -m pytest tests/test_api.py -k export_with_branches -q`：`1 passed`
  - `cd backend && .venv/bin/python -m pytest tests/test_api.py tests/test_simulator.py -q`：`179 passed`
  - `cd frontend && node scripts/e2e-suite.mjs corners --url http://127.0.0.1:18928 --output-dir output/e2e/20260324-runtime-preset-corners --headless`：完成并落盘
  - `cd frontend && node scripts/e2e-debate-suite.mjs full --url http://127.0.0.1:18928 --output-dir output/e2e/20260324-runtime-preset-debate --headless`：完成并落盘
- 本次文档同步前，还额外实跑通过：
  - `python -m pytest backend/tests/test_api.py -k 'forwards_temperature or forwards_branch_controls or detector_branch_budget' -q`：通过
  - `python -m pytest backend/tests/test_simulator.py -k 'variant_b_uses_alternate_prompt or detector_branch_budget_skips_lower_ranked_active_branch or passes_llm_overrides_into_detector' -q`：通过
  - `python -m pytest backend/tests/test_llm_client.py -k temperature_when_provided -q`：通过
  - `python -m ruff check --ignore E501 backend/app/services/llm_client.py backend/app/services/parser.py backend/app/services/memory.py backend/app/services/narrator.py backend/app/services/simulator.py backend/app/api/schemas.py backend/app/api/helpers.py backend/app/api/scenarios.py backend/tests/test_llm_client.py backend/tests/test_api.py backend/tests/test_simulator.py`：通过
  - `cd frontend && npx tsc --noEmit -p tsconfig.app.json`：通过
  - `cd frontend && node scripts/fork-experiment.mjs --api-url http://127.0.0.1:18927 --question '如果我是马斯克 能登上月球吗？' --temperatures 0,0.4,0.7,1.0 --runs 3 --rounds 5 --num-agents 20 --output-dir output/e2e/musk-factor-matrix`：完成并落盘 `result.json + results.csv`
  - `cd frontend && node scripts/fork-experiment.mjs --api-url http://127.0.0.1:18927 --question '如果我是马斯克 能登上月球吗？' --temperatures 0.4 --branch-sensitivities 0.7 --fork-prompt-variants a,b,c,d,e --runs 2 --rounds 3 --num-agents 20 --output-dir output/e2e/musk-prompt-ablation-matrix-r3`：完成并落盘
  - `cd frontend && node scripts/fork-experiment.mjs --api-url http://127.0.0.1:18927 --question '如果我是马斯克 能登上月球吗？' --question '如果每一项重大决策都必须交给轮值外部评审团重新裁决，会发生什么？' --question '如果互联网从未被发明？' --temperatures 0.4 --branch-sensitivities 0.7 --fork-prompt-variants b --fork-detector-active-branch-limits 0,1,2 --runs 1 --rounds 3 --num-agents 20 --output-dir output/e2e/budget-generalization-matrix`：完成并落盘
  - `python -m pytest tests/test_api.py tests/test_llm_client.py tests/test_runtime_lock.py tests/test_simulator.py -q`：`205 passed in 26.75s`
  - `python -m ruff check --ignore E501 app/api/helpers.py app/api/scenarios.py app/api/schemas.py app/services/llm_client.py app/services/runtime_lock.py app/services/simulator.py tests/test_api.py tests/test_llm_client.py tests/test_runtime_lock.py tests/test_simulator.py`：通过
  - `cd frontend && npm test -- --run src/pages/InputView.test.tsx src/pages/SimulationView.test.tsx src/stores/simulationStore.test.ts src/components/TimelineBar.test.tsx src/components/BranchEdge.test.tsx src/components/GameplayCardsModal.test.tsx src/game/managers/VizSynthesizer.test.ts src/game/scenes/WorldScene.test.ts src/i18n/locales.test.ts`：`112 passed`
  - `cd frontend && npx tsc --noEmit -p tsconfig.app.json`：通过
  - `cd frontend && npm run build`：通过
  - `cd frontend && npm run test:spike:phaser-custom`：`34 passed`
- 本轮这类“WS heartbeat keepalive / Debate LIVE-only prediction / intervention queue async-safe pop”改动，当前还额外实跑通过：
  - `tests/test_debate_api.py + tests/test_debate_service.py + tests/test_ws.py + tests/test_simulator.py + tests/test_intervention.py`：`104 passed in 2.69s`
  - `src/hooks/useDebateWS.test.tsx + src/stores/simulationStore.test.ts`：`22 passed`
  - `npx tsc --noEmit -p tsconfig.app.json`：通过
- 本轮这类“SQLite runtime lock / leaderboard 增量更新 / scenario 删除后 leaderboard 重建 / whitespace question 校验 / vector cache LRU / 分层 leader 缺失回退”改动，当前还额外实跑通过：
  - `tests/test_predictions.py + tests/test_vector_store.py + tests/test_runtime_lock.py + tests/test_debate_service.py + tests/test_debate_api.py + tests/test_api.py + tests/test_simulator.py`：`206 passed in 61.40s`
  - `python -m ruff check --ignore E501 app/api/helpers.py app/api/scenarios.py app/api/schemas.py app/services/debate.py app/services/runtime_lock.py app/services/scoring.py app/services/vector_store.py tests/test_api.py tests/test_debate_service.py tests/test_predictions.py tests/test_runtime_lock.py tests/test_vector_store.py`：通过
- 本轮这类“backend review fixes / shared pending queue / campaign summary indexes / Chroma write guard”改动，当前还额外实跑通过：
  - `tests/test_predictions.py tests/test_parser.py tests/test_memory.py tests/test_campaign_service.py tests/test_gameplay_contract_sync.py -q`：`106 passed in 101.36s`
  - `tests/test_campaign_api.py -q`：`12 passed in 0.72s`
  - `tests/test_simulator.py -k 'reuses_latest_rolling_briefing_before_current_window or passes_llm_overrides_into_compression' -q`：`2 passed in 0.31s`
  - `tests/test_predictions.py tests/test_campaign_service.py tests/test_campaign_api.py -q`：`60 passed in 1.79s`
  - `tests/test_simulator.py tests/test_intervention.py tests/test_api.py -k 'intervene or pending_intervention or delete_cascade_data or pop_next_pending_intervention_preserves_order or clear_pending_interventions_for_scenario_is_scoped or delete_uses_vector_store_cleanup' -q`：`19 passed in 1.49s`
  - `tests/test_vector_store.py -q`：`21 passed in 3.50s`
  - `tests/test_runtime_lock.py tests/test_vector_store.py tests/test_predictions.py tests/test_campaign_service.py tests/test_campaign_api.py -q`：`84 passed in 4.82s`
  - 对应两组 `ruff check`：通过
- 本轮这类“LLM config guard / shared AsyncClient / stream retry / replay import validation / batched message writes”改动，当前还额外实跑通过：
  - `python -m pytest tests/test_config.py tests/test_debate_api.py tests/test_llm_client.py tests/test_simulator.py tests/test_memory.py tests/test_lang_detect.py tests/test_vector_store.py tests/test_runtime_lock.py tests/test_ws.py tests/test_intervention.py tests/test_api.py tests/test_predictions.py -q`：`368 passed in 37.64s`
  - `python -m ruff check --ignore E501 app/config.py app/main.py app/api/debate.py app/services/llm_client.py app/services/simulator.py tests/test_config.py tests/test_debate_api.py tests/test_llm_client.py tests/test_simulator.py`：通过
- 本轮这类“engine-managed SQLite 轻量迁移 / shared AsyncClient 跨 event loop 隔离 / stale client 后台关闭 / Chroma init 超时后接管与重试恢复”改动，当前还额外实跑通过：
  - `python -m pytest tests/test_corner_cases.py -k init_db_reuses_engine_managed_connection_for_sqlite_migrations -q`：`1 passed, 33 deselected in 0.21s`
  - `python -m pytest tests/test_llm_client.py -k 'shared_async_client or event_loop_closed_runtime_error' -q`：`3 passed in 0.32s`
  - `python -m pytest tests/test_vector_store.py -q`：`27 passed in 3.63s`
  - `python -m pytest tests/test_corner_cases.py tests/test_llm_client.py tests/test_vector_store.py -q`：`82 passed in 25.37s`
  - `python -m ruff check --ignore E501 app/models/database.py app/services/llm_client.py app/services/vector_store.py tests/test_corner_cases.py tests/test_llm_client.py tests/test_vector_store.py`：通过
- 本 session 这轮“WS 广播并行发送 / replay & scenarioMeta 加固 / ShareModal 复制提示 / ambient mote 池化 / GameplayCardsModal 联动收敛 / daily challenge 后端 rotation”改动，当前还额外实跑通过：
  - `cd backend && source .venv/bin/activate && python -m pytest tests/test_ws.py -q`：`21 passed in 0.96s`
  - `cd backend && source .venv/bin/activate && python -m pytest tests/test_campaign_api.py -q`：`14 passed in 0.88s`
  - `cd backend && source .venv/bin/activate && python -m ruff check --ignore E501 app/api/campaign.py app/services/daily_challenges.py tests/test_campaign_api.py`：通过
  - `cd frontend && npm test -- --run src/hooks/useScreenCapture.test.ts src/lib/simulationReplay.test.ts src/pages/SimulationView.test.tsx`：`28 passed in 0.999s`
  - `cd frontend && npm test -- --run src/lib/scenarioMeta.test.ts src/pages/SimulationView.test.tsx src/pages/ResultView.test.tsx src/lib/scenarioReplay.test.ts`：`47 passed in 1.03s`
  - `cd frontend && npm test -- --run src/pages/InputView.test.tsx src/lib/dailyChallenge.test.ts src/game/scenes/WorldScene.test.ts src/components/GameplayCardsModal.test.tsx`：`34 passed in 0.66s`
  - `cd frontend && npm test -- --run src/components/ShareModal.test.tsx src/components/BranchTree.test.tsx`：`5 passed in 0.60s`
  - `cd frontend && npx tsc --noEmit -p tsconfig.app.json`：通过
- 本 session 这轮“frontend Input/Simulation hook 拆分 + `startSimulation(options)` + Simulation i18n 收口 / backend vector-store per-scenario write lock”改动，当前还额外实跑通过：
  - `cd frontend && npm test -- --run src/lib/directorIdentity.test.ts src/lib/debateCounterplay.test.ts src/lib/scenarioMeta.test.ts src/lib/dailyChallenge.test.ts src/lib/llmProviderPolicy.test.ts src/pages/InputView.test.tsx src/pages/SimulationView.test.tsx src/stores/simulationStore.test.ts src/hooks/useSimulationWS.test.tsx`：`81 passed in 1.57s`
  - `cd frontend && npx tsc --noEmit -p tsconfig.app.json`：通过
  - `cd backend && source ../.venv/bin/activate && python -m pytest tests/test_runtime_lock.py tests/test_vector_store.py -q`：`38 passed in 4.86s`
  - `cd backend && source ../.venv/bin/activate && python -m ruff check --ignore E501 app/services/runtime_lock.py app/services/vector_store.py tests/test_runtime_lock.py tests/test_vector_store.py`：通过

## 目录结构

```
.
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI 入口
│   │   ├── config.py            # pydantic-settings 配置
│   │   ├── api/
│   │   │   ├── scenarios.py     # 核心 CRUD 路由
│   │   │   ├── schemas.py      # Pydantic 请求/响应模型 (P0-1)
│   │   │   ├── helpers.py      # 后台任务/工具函数 (P0-1)
│   │   │   ├── interventions.py # 干预路由 (P0-1)
│   │   │   ├── social.py       # 社交媒体文案路由 (P0-1)
│   │   │   ├── predictions.py   # 预测/排行榜 API (P3-B)
│   │   │   ├── debate.py        # Debate Arena 路由 (Track D)
│   │   │   └── ws.py            # WebSocket 路由
│   │   ├── models/
│   │   │   ├── __init__.py      # init_db, model re-exports
│   │   │   ├── database.py      # SQLModel 模型定义
│   │   │   ├── agent_group.py   # 分层分组模型 (P3-A)
│   │   │   ├── debate.py        # Debate Arena 模型 (Track D)
│   │   │   └── predictions.py   # 预测/排行榜模型 (P3-B)
│   │   └── services/
│   │       ├── simulator.py     # 核心模拟引擎
│   │       ├── memory.py        # 记忆压缩 + 上下文构建
│   │       ├── llm_client.py    # LLM 调用封装
│   │       ├── parser.py        # 问题解析
│   │       ├── narrator.py      # 叙事生成
│   │       ├── daily_challenges.py # 每日/每周挑战定义与轮换
│   │       ├── runtime_lock.py  # SQLite 跨 worker 运行锁
│   │       ├── vector_store.py  # ChromaDB 向量记忆 L2
│   │       ├── debate.py        # Debate Arena 运行与结算 (Track D)
│   │       ├── debate_prompts.py # Debate 文案/场景映射 (Track D)
│   │       ├── debate_scoring.py # Debate 评分与 verdict 规划 (Track D)
│   │       ├── scoring.py       # 预测评分 (P3-B)
│   │       └── lang_detect.py   # 语言检测 + 指令生成 (P9)
│   ├── visualization/          # 像素化可视化映射层 (Phase 1)
│   │   ├── events.py          # VizEventType 枚举 + make_viz_event 工厂
│   │   ├── mapper.py          # VisualizationMapper (8 个 map_* 方法); stance clamp [-1,1]
│   │   ├── persona_mapper.py  # Agent → Sprite 分配 + 坐标计算; zero guard + stance clamp
│   │   ├── scene_selector.py  # 关键词 → 场景主题匹配 (longest-first)
│   │   └── card_events.py     # 卡牌事件触发 + 可视化映射 (单候选安全)
│   ├── tests/                   # 700 tests
│   ├── alembic/                 # 数据库迁移 (P1-4)
│   │   ├── env.py
│   │   ├── script.py.mako
│   │   └── versions/
│   ├── alembic.ini
│   └── pyproject.toml
├── frontend/
│   ├── src/
│   │   ├── App.tsx              # 路由入口
│   │   ├── main.tsx             # ReactDOM 挂载
│   │   ├── types.ts             # 全局类型定义
│   │   ├── pages/               # 7 页面 (含 DebateArenaView, DebateResultView)
│   │   ├── components/          # UI 组件 + Debate 组件
│   │   ├── stores/              # simulationStore / debateStore (Zustand)
│   │   ├── hooks/               # useSimulationWS / useDebateWS
│   │   ├── api/                 # HTTP 客户端
│   │   ├── i18n/                # 国际化
│   │   ├── animations/          # GSAP 动画
│   │   └── game/                # Phaser.js 像素化可视化 (Phase 1)
│   │       ├── PhaserGame.tsx   # Phaser 游戏 React 组件
│   │       ├── PhaserGameLoader.tsx # 懒加载器
│   │       ├── EventBridge.ts   # WebSocket → Phaser 事件桥接
│   │       ├── EventBridge.test.ts # EventBridge 单元测试 (13 tests)
│   │       ├── HudOverlay.tsx   # React HUD 浮层（排行榜 + 竞猜面板）
│   │       └── scenes/          # BootScene.ts, TitleScene.ts, WorldScene.ts, EndingScene.ts
│   └── package.json
├── docker-compose.yml
└── .env.example
```

## 许可证

AGPL-3.0-only
