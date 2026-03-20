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
| Butterfly Effect | 支持实时、回溯与批量干预；前端当前已有统一干预弹窗闭环 |
| Multi-Ending Comparison | 跨分支比较结局、洞察、关键时刻 |
| Real-time WebSocket | 实时观看agent发言流 |
| Hierarchical Agents (P3-A) | Leader-Worker分层架构，支持千人规模模拟 |
| Prediction Leaderboard (P3-B) | 用户竞猜 + LLM评分 + 排行榜 |
| Structured Betting 2.x | 结构化押注世界线 / 结局倾向 / 题材回响，Theater HUD 可直接打开下注入口 |
| Gameplay Cards | 当前共有 14 张玩法卡：10 张原始导演卡 + 4 张反制卡（`审计清算 / 情报反噬 / 民意回摆 / 停火委员会`）；玩法卡会按题目画像动态推荐，弹窗现会显示题材 hooks、题材导向文案、三段式题材连锁事件、profile-specific 打法说明，以及常驻 `风险 / 资源` 轨道；玩法卡注入仍会被 LLM 当成高优先级、持续生效的导演事件 |
| Shared Gameplay Contract | 玩法卡与题材画像已有共享契约 `shared/gameplay_contract.v1.json`；前端 `gameplayContract.ts` 直接消费卡牌规则、modal 输入契约与 prompt 语义，后端 `card_events.py` 当前主要消费 card event 映射与 `branching_bonus`，并有同步测试覆盖 |
| Director Goals & Worldline Commitment | Theater 局内现有最小导演层：2 个短目标、常驻 `风险 / 资源` 轨道、worldline 承诺，以及结果页中的目标完成度 / 承诺命中或落空结算；这批状态当前已后端化到 `Scenario.director_state_json`，并补上 `revision` 版乐观并发控制：前端写入会带上当前 revision，后端若发现 stale 写入会返回 `409`，页面随后会回读最新 authority，而不是静默覆盖 |
| Gameplay State Authority | 主模式 `cards.usageLog / betting.bets / archive.key_moments / archive.branch_snapshots` 当前都已后端化到 `Scenario.gameplay_state_json`；前端会优先从远端 `gameplay_state` 回填 usage log、下注列表与 archive raw，再基于这些真值重算导演点数、卡牌冷却、`mostUsedCard`、`counterplayCardCount` 与 `lastCounterplayCard`；结果页当前也已改成远端 authority 优先，只有远端缺字段时才回退本地 `scenarioMeta`，而且远端只显式带某个 gameplay 分区时，不会顺手清掉其它本地兼容字段；`SimulationView` 当前也只会在 backend `gameplay_state` 仍为空时才把本地 compat 回写后端，一旦远端 `gameplay_state` 已有有效内容，就不再把 stale local `usageLog / bets` 混回 authority 链路；authority 写路径当前已补齐 `revision` 版乐观并发控制，stale PUT 会得到 `409` 并自动刷新最新 authority；同时 `scenarioMeta` 的 localStorage / replay 输入也继续压缩：archive 摘要重复字段、usage-derived director/cooldown 与大部分 replay 冗余状态都不再长期保真，读路径按 usage/bets 现算回补；当 replay snapshot 已自带远端 authority 时，`scenario_result_v1 / simulation_view_v1` 现在还会进一步剔除 authority-backed `cards / bets / branchSnapshots`，只保留最小兼容输入 |
| On-Demand Theater Loading | Theater 现在只会在用户真正切进 Pixel Theater 后，按 idle 时机预热 Phaser；`PhaserGameLoader` 本身已在 Theater 动态边界，且当前会跳过隐藏页面、`prefers-reduced-data`、`saveData`、`2g/slow-2g`，以及低内存 / 低并发设备下的无谓预热；Classic 视图下只有在页面可见、设备允许且用户 hover/focus 到 Theater 切换按钮时，才会轻量预取 loader chunk；`BootScene` 当前只预载首屏初始 theme 与 `sprite_default + 初始角色 sprite`，其余缺失 sprite 改由 `WorldScene` 在 agent 真到场时按需补载；后续 `scene_change` 背景与 `EndingScene` 大图继续按需补载；默认前端构建 / 测试链路当前还会通过 alias 将 `phaser` 指向本地精简入口 `frontend/experiments/phaser-custom/entry.cjs`，把 `phaser` chunk 收口到约 `718 kB / 202 kB gzip`；截图链路也继续拆成 screenshot / GIF 两条 runtime，构建产物从单块 `capture-vendor` 收口到 `capture-html / capture-gif` |
| Landing Route Summary Split | 首页当前只读取轻量题材摘要 helper（`label / hooks / badge`），不再直接依赖完整玩法策略表；深层玩法 contract / strategy helper 仍由 `gameplayCards` 与导演层链路在后续路由里消费 |
| Causal Archive | 结果页沉淀玩法记录、下注记录、关键记录、世界线快照与画像摘要；现已包含 `mostUsedCard`、`bettingHit`、`archiveGrade`、`dominantBranchTitle`、`dominantTone`、`directorStyleTag`、`profileResonance`，并会把题材档案前缀写进导出 Markdown 与分享文案；结果页当前会先读取后端 `director_state`、`gameplay_state` 与 `campaign summary`，并以远端 authority 作为展示基线；只有远端缺字段时，才会回退本地 `scenarioMeta` 的兼容内容；如果远端只回某个 gameplay 分区，也只替换那一块，不会误清空无关的本地兼容字段；当前派生出的 archive/objectives 只保留在内存里用于展示，`displayArchive` 与 `displayBranchSnapshots` 会优先按 story/usages/bets/campaign summary 现算；`result / simulation replay` payload 里的 `scenarioMeta` 也继续精简，读路径会在进入 replay 页面时把 usage-derived 状态补回运行态 |
| Daily Challenge | 首页每日挑战卡，一键带入题目/轮数/Agent 数/Theater 参数；挑战池现为 12 条，已覆盖治理/帝国/战争/工业/边疆/贸易/法律/信仰/生态/神话/生存/通用；题面与副标题都支持 `zh/en`，首页会把后端 `campaign daily-status` 真值与本地缓存合并显示完成态、已用卡数、下注态与题材回响反馈；本轮又补了 `weekly challenge` Lite，首页会显示本周 3 个轮换题材与本地周窗口内的轻量周汇总 |
| Director Campaign (Track A) | 导演生涯最小闭环已落地：后端已有 `director_profile / profile_mastery / director_badge_unlock / scenario_campaign_log` 与 `finalize/profile/mastery/badges/daily-status/weekly-summary/scenario/{id}/summary/director-state` API；结果页会在完成后结算并展示本局 campaign 增量、等级与新徽章；首页现还会显示 `director growth` Lite，总结累计 runs、badge 数和 Top mastery；结果页可直接复制分享 challenge 链接，让别人按同题同参数再打一遍 |
| Debate Arena (Track D) | 已落地独立 Debate domain：`/api/debate` + `/ws/debate/{id}` 后端竖切、首页 `Debate Arena` 入口、`/debate/:id` live 页、`/debate/:id/result` 结果页、结构化押注（`winner / verdict_tone`）、`render_game_to_text()` / `advanceTime(ms)` / `capture_game_screenshot()` 自动化钩子；当前终局裁决已升级为 **LLM hybrid**：后端会优先读取 judge analysis 里的 `adjudication` scorecard，与 deterministic plan 混合后生成最终 `winner / verdict_tone / breakdown`，结果 payload 会显式带 `adjudication_mode`；若 LLM 不可用或输出无效，会退回 deterministic fallback；live / result 顶层现还会返回每阶段 `phase_insights`（`stakes / judge_focus / commentary / confidence_drift`），`debate_verdict` WS 事件也会一起带上这批阶段洞察；结果页会继续返回 `supporting_turns`，分享文案会带 1-2 条关键引文；创建后仍保留短暂 pre-roll 供 live 页下注，`closing / verdict` 阶段会锁单；`counterplay` 现在除了 `phase_score / explanation`，还会显式改写对应阶段的 `phase_insights.commentary`，并同步进入 replay digest 与 share copy；本 session 又把 replay import 的 `phase_insights` 做成持久化保真，导入后的 live/result 会优先使用已导入的阶段洞察，而不是只靠后端重算近似版本 |
| Portable Replay & Import | 主模式 `ResultView / SimulationView` 与 Debate `DebateResultView` 当前都支持 replay 页面。主模式优先走后端 `ReplayArtifact` 短 `share id`（`/result/replay?share=...`、`/sim/replay?share=...`），失败时再回退到本地 token；Debate 结果页当前使用 `/debate/replay/result?replay=...`。主模式 `scenario_result_v1 / simulation_view_v1` 当前都会先压缩 `scenarioMeta`，当 snapshot 已自带 authority 时还会去掉 authority-backed `cards / bets / branchSnapshots`，并把 `objectives / commitment` 收成更小的 replay 形态；读路径再按 usage/bets 现算回补 usage-derived 状态。三条 replay 页默认都是只读模式，但都支持“导入为本地运行”，把当前快照落成真实本地 scenario / debate 记录 |
| Generic Quick Start | 首页 generic 题材现有 3 条 `switchboard_forum` 题库，并会一键带入推荐预设（Theater / 4 rounds / 4 agents / blackboard） |
| Scenario Management (P4-A) | 场景列表/删除/导出 Markdown |
| Intervention Templates (P4-D) | 预设干预模板（自然灾害、技术突破等） |
| BYOK (P4-E) | 用户自带 OpenAI 兼容 API Key/URL/Model |
| Social Media Copy (P6) | 一键生成小红书/微博/知乎/Reddit/X 平台文案；主模式结果页分享弹窗当前会明确区分生成中 / 已生成 / 可复制状态，生成完成后会给出更直白的“文案已生成 / 可直接复制或切平台”反馈；社交文案请求当前走独立更长超时窗口，避免在正常 LLM 延迟下被前端过早中断 |
| Language Detection (P9) | 输入语言自动检测 + 全链路 LLM prompt 语言指令注入 |
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
| Automation QA Hooks | 浏览器自动化钩子 — `render_game_to_text()` 覆盖关键页面，Theater 暴露 `advanceTime(ms)`；InputView 现在会输出 `page.daily_challenge / page.weekly_challenge / page.director_growth`，Simulation 页面输出 `page.replay_state / replay_source / warmup / director / betting`，ResultView 输出 `archive_summary / result_bet_list / result_key_moments / result_branch_snapshots`，DebateResultView 输出 `replay_source` 与 `result.adjudication_mode`。前端提供 `e2e:matrix / e2e:variants / e2e:corners / e2e:cross-browser / e2e:safari / e2e:full` 与 `e2e:debate:*` 入口；主模式 `mobile` 现通过 `scripts/e2e-suite.mjs mobile` 进入签收链路。`e2e-suite.mjs` 里的 `director_state_roundtrip / gameplay_state_roundtrip` 当前也已在 PUT 前先回读最新 authority revision，再发起写入，避免固定历史样本因 revision 漂移稳定撞 `409`；share 生成与 share retry 的等待当前也已跟前端更长的社交文案超时窗口对齐，减少正常 LLM 延迟下的假失败。`release:signoff` 会落盘带 git `branch / commit / worktree` 绑定信息的 `summary.json`，并把 backend targeted `pytest`、`/metrics`、`tsc / build / assets / corners / mobile / cross-browser / debate:full` 组成默认签收合同；在显式要求时，Debate signoff 还会校验 `adjudication_mode`。CI 里的 `debate-signoff-smoke` 当前也已收紧为：secrets 可用时真实要求 `llm_hybrid`，否则安全回退 deterministic。当前工作树最近一次通过的 full signoff 工件见 `frontend/output/e2e/p0-p4-postfix/summary.json`（绑定 commit `1f1a0385144d579b1944cac2c2010df9d423b666`，status=`passed`，且要求 `adjudication_mode = llm_hybrid`）；最近一次 clean runtime 基线工件仍为 `frontend/output/e2e/current-head-audit-signoff/summary.json`（绑定 commit `3c96b52f618bc1e1e06d2630ecacb885951948a3`，`dirty=false`）；当前 checkout 是否已严格签收，应以重新实跑的 `summary.json` 为准。 |
| Semantic Scene Pool | 当前 registry 共有 33 个主题条目：30 张 Theater 语义背景 + 3 张 Debate 专属背景；`scene_selector` / `VizSynthesizer` 会优先扫描原始题面，按问题语义选择更贴题的场景，而不是做粗暴轮换；原有法庭 / 信仰 / generic 变体仍保留，Track D 另补 `debate_arena_civic / debate_arena_judicial / debate_arena_forum` 三张辩论专用背景 |
| Theater Replay Director | 完成态 Theater 支持按世界线/轮次筛选回放，并保留重播/跳到最新/倍速控制；compact TimelineBar 直接嵌回 Theater 面板内，显示 `fork/card/bet/result` marker |
| Result Loading Gate | 用户过早打开 `/result/:id` 时，结果页会先 loading，等待 narration 真正完成后再展示，不再把半成品 branch 当最终结果 |
| LLM JSON Hardening | narrator 与 agent 发言链路都补了 JSON 容错：叙事阶段会归一化 `list` payload，agent 阶段会恢复轻微坏 JSON 或纯文本，尽量不丢整条发言 |
| LLM Runtime Guard | 当前后端已增加进程内全局 LLM 并发闸门、pending 上限、用户级 pending 配额和 provider 熔断；用户题面、干预文本、评分输入与分享上下文也会按 `UNTRUSTED DATA` 口径注入，减少坏 JSON 与提示词注入带来的链路抖动 |
| Scenario Bootstrap State | 新建 Theater 场景时，`POST /api/scenario` 立即返回 `simulating`、`scene_theme` 与 provisional root branch，避免首屏完全空壳 |
| Generated Gameplay Art | 使用 Gemini 图像模型生成并接入玩法卡专属 frame、Theater 场景背景、徽章和因果档案装饰面板；Track D 本轮另生成了辩论专用背景、stage banner、verdict panel、score meter、三方 badge 与 quote frame；当前 `frontend/public/assets/ui/generated + frontend/public/assets/scenes` 下 62 张 PNG 都已有同名 `.meta.json` sidecar，其中较新的 Debate 资产保留完整生成字段，较早的 legacy 资产则使用诚实回填的 provenance 记录；这里的 backfill 代表 sidecar 补齐，不代表恢复了原始生成时间、模型或 prompt |
| Theme Registry & Asset Manifest | 前端已把 33 个 Theater / Debate 场景主题、关键词、题材画像归属，以及玩法 / 辩论 frame / badge 资产统一收进 `themeRegistry.ts`，减少扩主题时的多处手工同步；Track D 的 `DEBATE_UI_ASSETS` 也走同一套 registry。本轮又把 7 张原先只在库存里的 sprite（`alchemist / assassin / bard / knight / monk / thief / witch`）接入运行时角色池，并同步收口了前后端 persona/role 映射；当前 `BootScene` 只预载首屏初始 theme 与 `sprite_default + 初始角色 sprite`，其余缺失 sprite 改由 `WorldScene` 在 agent 真到场时按需补载；后续 `scene_change` 背景与 `EndingScene` 大图继续按需补载，旧 `bet_panel / leaderboard / title_screen / minimap_frame` 也不再是 Theater 首次进入硬依赖 |
| Theater Readability Pass | Theater 本轮又做了一轮“上方更薄、中间更大、气泡更清楚”的可读性修复：右栏改为固定窄宽，`game-wrapper` 提前到 replay filters/timeline 前，compact TimelineBar 隐藏二级 stats，bubble 字号/换行宽度/描边/分辨率也一并提高 |
| Open Source Polish (Phase 4) | 开源准备 — Weather 粒子对象池 + 视口裁剪 + `ASSET_CREDITS` 现已同步到 Debate Arena 新资产；`generate-ui-assets.mjs` 会继续为新图像写入完整 sidecar，而 `assets:provenance:backfill` / `assets:provenance:check` 则负责把 legacy UI/scenes 资产补成可审计的 sidecar 完整态，但不会伪造原始生成记录 |
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
| pytest + pytest-asyncio | Historical full baseline: **815 passed**。当前发布判断以后端 targeted `pytest` 与 `release:signoff` 为准；最新 signoff backend set：**86 passed** |
| Vitest + jsdom | Historical full baseline: **179 passed**。当前发布判断以前端 targeted `vitest` 与 `release:signoff` 为准；最新 targeted frontend set：**107 passed**，且 `tsc` / `build` / assets check 通过 |
| conftest.py | 每测例独立临时 SQLite fixtures（前后显式释放 engine，避免 readonly / disk I/O 冲突） |
| benchmark_compression.py | 压缩质量离线标尺 (3场景 × 4维度) |

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
