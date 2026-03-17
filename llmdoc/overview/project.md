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
| Gameplay Cards | 10 张玩法卡（文明辩论/间谍渗透/密约交易/人类潜入/时空裂缝/民意浪潮/撤离令/公开听证/资源分诊/禁术仪式）按题目画像动态推荐；玩法卡弹窗现会显示题材 hooks、题材导向文案、三段式题材连锁事件，以及 `风险时钟 / 资源轨道` 两条轻量状态；玩法卡注入仍会被 LLM 当成高优先级、持续生效的导演事件 |
| Shared Gameplay Contract | 玩法卡与题材画像已有共享契约 `shared/gameplay_contract.v1.json`；后端 `card_events.py` 与前端 `gameplayContract.ts` 共用同一份定义，当前已覆盖卡牌规则、modal 输入契约、prompt 语义与 branching bonus，并有同步测试覆盖 |
| Director Points & Cooldowns | 单局 3 点导演点数 + 卡牌冷却，前端本地持久化 |
| Causal Archive | 结果页沉淀玩法记录、下注记录、关键记录与画像摘要；现已包含 `mostUsedCard`、`bettingHit`、`archiveGrade`、`dominantBranchTitle`、`dominantTone`、`directorStyleTag`、`profileResonance`，并会把题材档案前缀写进导出 Markdown 与分享文案 |
| Daily Challenge | 首页每日挑战卡，一键带入题目/轮数/Agent 数/Theater 参数；挑战池现为 12 条，已覆盖治理/帝国/战争/工业/边疆/贸易/法律/信仰/生态/神话/生存/通用；题面与副标题都支持 `zh/en`，首页会把后端 `campaign daily-status` 真值与本地缓存合并显示完成态、已用卡数、下注态与题材回响反馈 |
| Director Campaign (Track A) | 导演生涯最小闭环已落地：后端已有 `director_profile / profile_mastery / director_badge_unlock / scenario_campaign_log` 与 `finalize/profile/mastery/badges/daily-status` API；结果页会在完成后结算并展示本局 campaign 增量、等级与新徽章，首页会读取题材 mastery 与当日 challenge 真值 |
| Debate Arena (Track D) | 已落地独立 Debate domain：`/api/debate` + `/ws/debate/{id}` 后端竖切、首页 `Debate Arena` 入口、`/debate/:id` live 页、`/debate/:id/result` 结果页、结构化押注（`winner / verdict_tone`）、`render_game_to_text()` / `advanceTime(ms)` / `capture_game_screenshot()` 自动化钩子；当前使用 deterministic 5 阶段辩论脚本 + 题材化 deterministic 文案/评分偏置打通 MVP，并在创建后保留短暂 pre-roll 供 live 页下注，`closing / verdict` 阶段会锁单；live/result 页会按 `debate.language` 自动同步 UI 语言，不继续塞胖通用 scenario 引擎 |
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
| Automation QA Hooks | 浏览器自动化钩子 — `render_game_to_text()` 覆盖关键页面，Theater 暴露 `advanceTime(ms)`；Simulation 页面新增 `page.replay_state`、`page.warmup`、`page.controls.capture_mode/can_capture_modal`，并通过 `capture_game_screenshot(panel|canvas|modal)` 提供显式截图模式；Track D 的 Debate live/result 现额外输出 `selected_phase / is_phase_locked / unlocked_phases / active_modal / modal_state / bet_window_open` 等状态摘要；前端同时提供 `e2e:matrix / e2e:variants / e2e:corners / e2e:full` 与 `e2e:debate:*` 一键回归入口，`e2e-suite.mjs` / `e2e-debate-suite.mjs` 都会在输出目录落盘 `browser-launch.json`，记录本次实际采用的浏览器启动 profile；当前固定样本为 15 条，变体样本为 3 条；历史 `scenario_id` 缺失或 `scene_theme` 与当前 `select_scene(question)` 漂移时，suite 会按 theme runtime fallback 重建样本。Track C 主基线工件位于 `frontend/output/e2e/20260317-track-c/{matrix,corners,mobile,variants}/`；本轮 full 主链路工件位于 `frontend/output/e2e/20260318-post-b2-full/`，Track D Debate 最新成功工件位于 `frontend/output/e2e/20260318-post-b2-debate-full/` |
| Semantic Scene Pool | Pixel Theater 现有 33 个语义场景背景；`scene_selector` / `VizSynthesizer` 会优先扫描原始题面，按问题语义选择更贴题的场景，而不是做粗暴轮换；原有法庭 / 信仰 / generic 变体仍保留，Track D 另补 `debate_arena_civic / debate_arena_judicial / debate_arena_forum` 三张辩论专用背景 |
| Theater Replay Director | 完成态 Theater 支持按世界线/轮次筛选回放，并保留重播/跳到最新/倍速控制；compact TimelineBar 直接嵌回 Theater 面板内，显示 `fork/card/bet/result` marker |
| Result Loading Gate | 用户过早打开 `/result/:id` 时，结果页会先 loading，等待 narration 真正完成后再展示，不再把半成品 branch 当最终结果 |
| LLM JSON Hardening | narrator 与 agent 发言链路都补了 JSON 容错：叙事阶段会归一化 `list` payload，agent 阶段会恢复轻微坏 JSON 或纯文本，尽量不丢整条发言 |
| Scenario Bootstrap State | 新建 Theater 场景时，`POST /api/scenario` 立即返回 `simulating`、`scene_theme` 与 provisional root branch，避免首屏完全空壳 |
| Generated Gameplay Art | 使用 Gemini 图像模型生成并接入玩法卡专属 frame、Theater 场景背景、徽章和因果档案装饰面板；Track D 本轮另生成了辩论专用背景、stage banner、verdict panel、score meter、三方 badge 与 quote frame，并为新 PNG 落盘 `.meta.json` provenance |
| Theme Registry & Asset Manifest | 前端已把 33 个 Theater / Debate 场景主题、关键词、题材画像归属，以及玩法 / 辩论 frame / badge 资产统一收进 `themeRegistry.ts`，减少扩主题时的多处手工同步；Track D 的 `DEBATE_UI_ASSETS` 也走同一套 registry |
| Open Source Polish (Phase 4) | 开源准备 — Weather 粒子对象池 + 视口裁剪 + `ASSET_CREDITS` 现已同步到 Debate Arena 新资产；新生成图统一补同名 `.meta.json`（`preset/model/provider/source/source_url/generated_at/output/prompt`） |
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
| pytest + pytest-asyncio | 本轮已验证后端全量回归 **815 passed**；最近定向回归包括 `test_card_events.py / test_gameplay_contract_sync.py` 共 **24 passed**、`test_campaign_service.py / test_campaign_api.py` 共 **9 passed**、`test_predictions.py` 共 **17 passed**；其中 Track B2 shared contract 收口、campaign `daily-status` 时区修复与 prediction 测试 warning 清理都已重新验证 |
| Vitest + jsdom | 本轮已验证前端全量回归 **175 passed**，覆盖状态管理、回放、截图、玩法卡、场景推断和页面自动化摘要；最近已真实执行的定向回归为 `gameplayContract / gameplayCards / GameplayCardsModal / scenarioMeta` 共 **26 passed**；`npm run build`、`e2e:full` 与 `e2e:debate:full` 也已真实跑通 |
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
