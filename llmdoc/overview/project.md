# SwarmOracle — 项目概览

## 项目定位

AI "What-If" Prediction Playground — 用户提出一个历史/假设性问题，AI agents 实时辩论并探索分支时间线。

## 核心功能

| 功能 | 描述 |
|------|------|
| Multi-Agent Simulation | AI角色带有persona、立场、情绪进行辩论 |
| Branching Timelines | 决策产生平行分支，附概率追踪 |
| Butterfly Effect | 实时注入干预改变模拟走向 |
| Multi-Ending Comparison | 跨分支比较结局、洞察、关键时刻 |
| Real-time WebSocket | 实时观看agent发言流 |
| Hierarchical Agents (P3-A) | Leader-Worker分层架构，支持千人规模模拟 |
| Prediction Leaderboard (P3-B) | 用户竞猜 + LLM评分 + 排行榜 |
| Structured Betting 2.x | 结构化押注世界线 / 结局倾向 / 题材回响，Theater HUD 可直接打开下注入口 |
| Gameplay Cards | 当前共有 14 张玩法卡：10 张原始导演卡 + 4 张反制卡（`审计清算 / 情报反噬 / 民意回摆 / 停火委员会`）；玩法卡会按题目画像动态推荐，弹窗现会显示题材 hooks、题材导向文案、三段式题材连锁事件、profile-specific 打法说明，以及常驻 `风险 / 资源` 轨道；玩法卡注入仍会被 LLM 当成高优先级、持续生效的导演事件 |
| Shared Gameplay Contract | 玩法卡与题材画像已有共享契约 `shared/gameplay_contract.v1.json`；前端 `gameplayContract.ts` 直接消费卡牌规则、modal 输入契约与 prompt 语义，后端 `card_events.py` 当前主要消费 card event 映射与 `branching_bonus`，并有同步测试覆盖 |
| Director Goals & Worldline Commitment | Theater 局内现有最小导演层：2 个短目标、常驻 `风险 / 资源` 轨道、worldline 承诺，以及结果页中的目标完成度 / 承诺命中或落空结算；这批状态当前已后端化到 `Scenario.director_state_json` |
| Gameplay State Authority | 主模式 `cards.usageLog / betting.bets / archive.key_moments / archive.branch_snapshots` 当前都已后端化到 `Scenario.gameplay_state_json`；前端会优先从远端 `gameplay_state` 回填 usage log、下注列表与 archive raw，再基于这些真值重算导演点数、卡牌冷却、`mostUsedCard`、`counterplayCardCount` 与 `lastCounterplayCard` |
| Causal Archive | 结果页沉淀玩法记录、下注记录、关键记录、世界线快照与画像摘要；现已包含 `mostUsedCard`、`bettingHit`、`archiveGrade`、`dominantBranchTitle`、`dominantTone`、`directorStyleTag`、`profileResonance`，并会把题材档案前缀写进导出 Markdown 与分享文案；结果页当前会先读取后端 `director_state`、`gameplay_state` 与 `campaign summary`，无本地缓存时仍可回读 bet/archive raw 明细 |
| Daily Challenge | 首页每日挑战卡，一键带入题目/轮数/Agent 数/Theater 参数；挑战池现为 12 条，已覆盖治理/帝国/战争/工业/边疆/贸易/法律/信仰/生态/神话/生存/通用；题面与副标题都支持 `zh/en`，首页会把后端 `campaign daily-status` 真值与本地缓存合并显示完成态、已用卡数、下注态与题材回响反馈；本轮又补了 `weekly challenge` Lite，首页会显示本周 3 个轮换题材与本地周窗口内的轻量周汇总 |
| Director Campaign (Track A) | 导演生涯最小闭环已落地：后端已有 `director_profile / profile_mastery / director_badge_unlock / scenario_campaign_log` 与 `finalize/profile/mastery/badges/daily-status/weekly-summary/scenario/{id}/summary/director-state` API；结果页会在完成后结算并展示本局 campaign 增量、等级与新徽章；首页现还会显示 `director growth` Lite，总结累计 runs、badge 数和 Top mastery；结果页可直接复制分享 challenge 链接，让别人按同题同参数再打一遍 |
| Debate Arena (Track D) | 已落地独立 Debate domain：`/api/debate` + `/ws/debate/{id}` 后端竖切、首页 `Debate Arena` 入口、`/debate/:id` live 页、`/debate/:id/result` 结果页、结构化押注（`winner / verdict_tone`）、`render_game_to_text()` / `advanceTime(ms)` / `capture_game_screenshot()` 自动化钩子；当前胜负 / verdict tone 仍走 deterministic 规划，但回合文案、`judge summary` 与结构化 `judge_rationale` 已升级为 **LLM 优先、deterministic fallback**；结果页现在还会返回 `supporting_turns`，分享文案会带 1-2 条关键引文；创建后仍保留短暂 pre-roll 供 live 页下注，`closing / verdict` 阶段会锁单；live 页现有 `phase cue / feed focus / latest turn 高亮`，结果页的 `counterplay` 也会显式返回 `phase_score / explanation`，并进入 replay digest 与 share copy |
| Generic Quick Start | 首页 generic 题材现有 3 条 `switchboard_forum` 题库，并会一键带入推荐预设（Theater / 4 rounds / 4 agents / blackboard） |
| Scenario Management (P4-A) | 场景列表/删除/导出 Markdown |
| Intervention Templates (P4-D) | 预设干预模板（自然灾害、技术突破等） |
| BYOK (P4-E) | 用户自带 OpenAI 兼容 API Key/URL/Model |
| Social Media Copy (P6) | 一键生成小红书/微博/知乎/Reddit/X 平台文案 |
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
| Prometheus Observability (P3-9) | /metrics 端点暴露请求延迟、计数、活跃模拟等指标 |
| Pixel Art Visualization (Phase 1) | 像素风可视化基础设施 — 事件映射 + 精灵分配 + 场景选择 + 卡牌事件 |
| Reasoning Visualization (Phase 2) | 核心推理可视化 — 天气/昼夜系统 + 阵营标记 + 气泡变体 + 粒子特效；后续语义场景池已在此基础上扩到 30 个背景主题，补上 `law_court_variant / faith_temple_variant / switchboard_forum_variant` 三个变体场景；generic 仍保留 `switchboard_forum / 轮值议堂` 主场景 |
| Gamification UI (Phase 3) | 游戏化打磨 — 标题画面 + 6种结局演出 + MiniMap HUD + 竞猜面板 + 排行榜 + 截图/GIF导出 |
| HUD Migration (Phase 5) | 排行榜/竞猜面板迁移至 React 层 — HudOverlay.tsx 浮层渲染，画布无遮挡 |
| Visual Upgrade (3.0 Phase A) | 动态场景 & 角色选择 — WS 广播 viz:scene_init + 前端 VizSynthesizer 关键词匹配 |
| Visual Upgrade (3.0 Phase B) | 美术风格全面升级 — GBC 调色板统一 + 35 素材重生成 + TitleScene 打字机/跳过/扫描线 + WorldScene 视差/打字机气泡/擦除过渡 |
| Visual Upgrade (3.0 Phase C) | UI/UX布局优化 + Theater模式完善 — SimulationView布局重构 + GBC暗色主题 + HUD像素风 + 8个Theater Bug修复（精灵/气泡/漫游/多轮回放） |
| Theater Bubble Bugfix (3.0-D) | 剧场气泡冻结修复 — `visualization_enabled` 参数透传后端 + 增量气泡分发竞态条件修复（fallback synth init）+ Scenario hydration 恢复 Theater 模式 + completed replay 自动跳过 `TitleScene` 回到 `WorldScene` |
| Theater Stability Hardening (3.0-E) | 剧场稳定性加固 — simulator 将数值/文本 stance 统一归一化到可视化坐标，避免中文立场词在 Theater 链路中触发类型错误 |
| Automation QA Hooks | 浏览器自动化钩子 — `render_game_to_text()` 覆盖关键页面，Theater 暴露 `advanceTime(ms)`；Simulation 页面现输出 `page.replay_state`、`page.warmup`、`page.controls.capture_mode/can_capture_modal/capture_result_kind`、`page.director.objectives / system_tracks / commitment`，以及新的 `page.betting`；ResultView 的 `archive_summary` 现还会输出 `objective_completed_count / objective_total_count / commitment_outcome / risk_value / resource_value`，并新增 `result_bet_list / result_key_moments / result_branch_snapshots` 供 cross-device roundtrip 取证；前端继续提供 `e2e:matrix / e2e:variants / e2e:corners / e2e:cross-browser / e2e:safari / e2e:full` 与 `e2e:debate:*` 一键回归入口，`e2e-suite.mjs` / `e2e-debate-suite.mjs` 都会在输出目录落盘 `browser-launch.json`；`capture-modes` 会额外落盘 `predictionModalBytes / gameplayModalBytes`，`replay` corner case 会等到 `theater_ready = true` 再判定恢复完成；`e2e-suite.mjs` 的截图链路现已补 `timeout + CDP fallback`，`history-delete-last-page` 会在最终截图前等待删除弹窗真正脱离 DOM；`e2e-debate-suite.mjs` 现已支持 `--width / --height / --question / --profile-hint` 覆盖。本轮 cross-device corners 工件为 `frontend/output/e2e/20260319-cross-device-state-corners/`，cross-browser 工件为 `frontend/output/e2e/20260319-cross-device-state-cross-browser/`，Safari 工件为 `frontend/output/e2e/20260319-cross-device-state-safari/`；若要补 Safari panel capture 取证，可看 `frontend/output/e2e/20260319-cross-device-state-safari-panel/` |
| Semantic Scene Pool | 当前 registry 共有 33 个主题条目：30 张 Theater 语义背景 + 3 张 Debate 专属背景；`scene_selector` / `VizSynthesizer` 会优先扫描原始题面，按问题语义选择更贴题的场景，而不是做粗暴轮换；原有法庭 / 信仰 / generic 变体仍保留，Track D 另补 `debate_arena_civic / debate_arena_judicial / debate_arena_forum` 三张辩论专用背景 |
| Theater Replay Director | 完成态 Theater 支持按世界线/轮次筛选回放，并保留重播/跳到最新/倍速控制；compact TimelineBar 直接嵌回 Theater 面板内，显示 `fork/card/bet/result` marker |
| Result Loading Gate | 用户过早打开 `/result/:id` 时，结果页会先 loading，等待 narration 真正完成后再展示，不再把半成品 branch 当最终结果 |
| LLM JSON Hardening | narrator 与 agent 发言链路都补了 JSON 容错：叙事阶段会归一化 `list` payload，agent 阶段会恢复轻微坏 JSON 或纯文本，尽量不丢整条发言 |
| LLM Runtime Guard | 当前后端已增加进程内全局 LLM 并发闸门、pending 上限、用户级 pending 配额和 provider 熔断；用户题面、干预文本、评分输入与分享上下文也会按 `UNTRUSTED DATA` 口径注入，减少坏 JSON 与提示词注入带来的链路抖动 |
| Scenario Bootstrap State | 新建 Theater 场景时，`POST /api/scenario` 立即返回 `simulating`、`scene_theme` 与 provisional root branch，避免首屏完全空壳 |
| Generated Gameplay Art | 使用 Gemini 图像模型生成并接入玩法卡专属 frame、Theater 场景背景、徽章和因果档案装饰面板；Track D 本轮另生成了辩论专用背景、stage banner、verdict panel、score meter、三方 badge 与 quote frame；当前 `frontend/public/assets/ui/generated + frontend/public/assets/scenes` 下 62 张 PNG 都已有同名 `.meta.json` sidecar，其中较新的 Debate 资产保留完整生成字段，较早的 legacy 资产则使用诚实回填的 provenance 记录；这里的 backfill 代表 sidecar 补齐，不代表恢复了原始生成时间、模型或 prompt |
| Theme Registry & Asset Manifest | 前端已把 33 个 Theater / Debate 场景主题、关键词、题材画像归属，以及玩法 / 辩论 frame / badge 资产统一收进 `themeRegistry.ts`，减少扩主题时的多处手工同步；Track D 的 `DEBATE_UI_ASSETS` 也走同一套 registry。本轮又把 7 张原先只在库存里的 sprite（`alchemist / assassin / bard / knight / monk / thief / witch`）接入运行时角色池，并同步收口了前后端 persona/role 映射 |
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
| pytest + pytest-asyncio | 仓库内历史后端全量基线仍记录为 **815 passed**；本轮重新复验了 `test_debate_service.py / test_debate_api.py / test_config.py / test_campaign_api.py / test_campaign_service.py / test_predictions.py / test_card_events.py / test_gameplay_contract_sync.py`，结果为 **65 passed**；后续本次 `gameplay_state` authority + 角色映射收口又补跑了 `test_campaign_api.py / test_campaign_service.py / test_persona_mapper.py`，结果为 **80 passed**；本次 cross-device gameplay state 收口又补跑了 `test_campaign_api.py / test_campaign_service.py`，结果为 **19 passed**；本次 session 又补跑了 `test_llm_client.py / test_api.py` → **87 passed**，`test_debate_service.py / test_debate_api.py` 最新回归 → **12 passed**，以及新增 `weekly-summary` 后的 `test_campaign_service.py / test_campaign_api.py` → **21 passed** |
| Vitest + jsdom | 仓库内历史前端全量基线仍记录为 **179 passed**；本轮重新复验了 `scenarioMeta / archiveSummary / gameplayCards / gameplayContract / SimulationView / ResultView / GameplayCardsModal / DebateArenaView / DebateResultView / DebateBetModal / DebateShareModal / useDebateWS / locales`，结果为 **60 passed**；本次 director-state 后端化又补跑了 `SimulationView / ResultView / scenarioMeta` 定向回归，结果为 **21 passed**；后续本次 `gameplay_state` authority + 玩法/素材分化又补跑了 `scenarioGameplayState / gameplayCards / VizSynthesizer / SimulationView / ResultView`，结果为 **66 passed**；Theater 可读性修复定向回归 `SimulationView / TimelineBar` 结果为 **12 passed**；本次 cross-device gameplay state 收口又补跑了 `scenarioGameplayState / PredictionModal / SimulationView / ResultView` 定向回归，结果为 **26 passed**；本次 session 又补跑了 `llmProviderPolicy / ShareModal / InputView / ResultView` → **11 passed**，`DebateArenaView / DebateResultView / debateShare / debateCounterplay` → **8 passed**，以及 `challengeShare / InputView / ResultView` → **11 passed**；随后围绕 Debate `judge_rationale / supporting_turns / share copy` 又补跑了 `debateShare / DebateShareModal / DebateResultView` → **5 passed**，以及 `DebateArenaView / DebateResultView / debateShare / debateCounterplay / DebateBetModal / DebateShareModal / useDebateWS` → **16 passed**；`npx tsc --noEmit -p tsconfig.app.json`、`npm run build` 均通过，`e2e-suite.mjs corners`、`e2e-suite.mjs cross-browser`、`e2e-suite.mjs safari` 也已重跑通过 |
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
