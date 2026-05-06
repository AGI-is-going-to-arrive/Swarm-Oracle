# SwarmOracle

> 群体预言机 -- AI "What-If" Prediction Playground
> 一个基于 FastAPI + React + Phaser 的 AI 驱动互动叙事游戏平台。

## 项目愿景

SwarmOracle 允许用户提出 "如果...会怎样" 的假设性问题，由 AI 代理群体模拟多分支叙事推演，支持辩论竞技场、神谕密室、世界线圆桌等多种互动模式，最终生成可分享的预测结果。

## 架构总览

| 层级 | 技术栈 | 端口 |
|------|--------|------|
| 前端 | Vite + React 19 + TypeScript + Phaser 3 + Zustand | 18928 |
| 后端 | FastAPI + SQLModel + Alembic + ChromaDB | 18927 |
| LLM  | MiniMax-M2.5 (可配置任意 OpenAI 兼容 API) | 可配置 |
| 数据库 | SQLite + ChromaDB (向量检索) | 本地文件 |
| 部署 | Docker Compose (backend + frontend) | 18927/18928 |

## 模块结构图

```mermaid
graph TD
    A["SwarmOracle"] --> B["backend"]
    A --> C["frontend"]
    A --> D["video"]

    B --> B1["app/api"]
    B --> B2["app/services"]
    B --> B3["app/models"]
    B --> B4["app/visualization"]
    B --> B5["alembic"]
    B --> B6["tests"]

    C --> C1["src/pages"]
    C --> C2["src/components"]
    C --> C3["src/game"]
    C --> C4["src/lib"]
    C --> C5["src/stores"]
    C --> C6["src/hooks"]
    C --> C7["src/api"]
    C --> C8["src/i18n"]
    C --> C9["scripts"]

    click B "./backend/CLAUDE.md" "查看 backend 模块文档"
    click C "./frontend/CLAUDE.md" "查看 frontend 模块文档"
```

## 模块索引

| 模块 | 路径 | 语言 | 职责 | 文件数 | 测试数 |
|------|------|------|------|--------|--------|
| backend | `backend/` | Python 3.11+ | FastAPI 后端，LLM 编排，模拟引擎，Web 搜索增强 | ~70 | 67+ 文件 / 2328 tests |
| frontend | `frontend/` | TypeScript | React SPA，Phaser 游戏引擎，实时 WS | ~140+ | 163 文件 / 1735 tests |
| video | `video/` | Markdown | 宣传视频脚本与分镜稿 | 10 | -- |

## 运行与开发

### 环境准备

```bash
# 后端
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env  # 配置 LLM_API_KEY 等

# 前端
cd frontend
npm install
```

### 开发服务器

```bash
# 后端 (端口 18927)
cd backend && uvicorn app.main:app --host 0.0.0.0 --port 18927 --reload

# 前端 (端口 18928)
cd frontend && npm run dev
```

### Docker 部署

```bash
docker compose up --build
```

### 数据库迁移

```bash
cd backend && alembic upgrade head
```

## 测试策略

| 层级 | 工具 | 命令 |
|------|------|------|
| 后端单元/集成 | pytest + pytest-asyncio | `cd backend && pytest` |
| 前端单元/组件 | vitest + @testing-library/react | `cd frontend && npm test` |
| 前端 E2E | Playwright + 自定义脚本 | `cd frontend && npm run e2e:full` |
| E2E 子集 | -- | `npm run e2e:ending-room:full` / `npm run e2e:roundtable:full` / `npm run e2e:debate:full` |
| Lint (后端) | ruff | `cd backend && ruff check .` |
| Lint (前端) | eslint | `cd frontend && npm run lint` |
| 构建校验 | tsc + vite | `cd frontend && npm run build` |

## 编码规范

- **后端**: Python, ruff (line-length=100, target py311), select E/F/I/W
- **前端**: TypeScript strict, eslint + react-hooks + react-refresh
- **i18n**: 双语 (zh/en)，通过 `i18next` + `react-i18next`
- **状态管理**: Zustand (前端全局状态)
- **路由**: React Router v7 (前端), FastAPI APIRouter (后端)

## AI 使用指引

- 后端核心服务 `ending_room_service` 已拆分为子模块包 (`_utils`, `_participants`, `_threads`, `_content`)，修改时注意 re-export 兼容性
- `frontend/src/stores/worldlineRoundtableStore.ts` 是 `endingRoomStore` 的 re-export，不是 stub
- 大文件注意：`EndingChatModal.tsx` (~1509 行)，`WorldlineRoundtableView.tsx` (~2223 行)
- LLM 客户端支持 BYOK (Bring Your Own Key)，前端通过 `LlmProviderRequestOptions` 传递
- WebSocket 用于实时模拟推送，每个场景最多 50 个连接
- Web 搜索增强：InputView 搜索增强 toggle 默认可见（不再受 `VITE_ENABLE_WEB_SEARCH` 编译期开关控制），推演前自动搜索真实世界背景注入 Agent 提示词（CORE/IMPORTANT/CROWD 三层），结果在 ResultView 展示来源卡片
- Source family 分类搜索：`FEATURE_NEW_SOURCES` 控制，开启后 InputView 展示 4 个领域 checkbox（预测市场/财经资讯/学术文献/深度报道），每个 family 通过 `include_domains` 参数在对应领域网站独立搜索（Tavily/Exa 原生支持，SearXNG 通过 `site:` query 语法，xAI 通过 prompt 注入），结果独立展示在 ResultView 的 source card 中
- InputView 模式选择器（推演模式/可视化模式/推理力度/神谕档位）默认展示在输入区域下方，不再折叠在"高级设置"中；BYOK（自定义 LLM）保留独立折叠区
- `GET /api/capabilities` 是轻量配置端点（无 LLM 调用），前端 mount 时用它检测服务端功能开关
- BYOK 安全：业务入口 (scenario/debate/predictions/social) 统一要求 `base_url` 必须同时带 `api_key`，前移 400 拒绝；`/api/health/test` 是连通性探测，不做前移拒绝，返回 `200 + llm.status=error`。allowlist 校验 hostname + http(s) scheme
- 不可信文本（搜索结果、用户输入）通过 `format_untrusted_text_block()` 包装进 fenced block，三反引号已做转义防 fence-breakout
- WS 认证已从 query string `?token=` 迁移到首帧 auth 协议（`{"type":"auth","token":"..."}` → `{"type":"auth_ok"}`），token 不再出现在 URL 中。前端对 4001/4404 不自动重连
- WS 连接上限 `MAX_WS_PER_SCENARIO=50` 同时计入已认证连接和 pending_auth 连接，防止未认证 socket 绕过限制
- Oracle 角色化词汇 13 种 voice variant（imperial / field / finance / market / faith / industry / frontier / survival / scholar / civic / diplomat / advisor / science），基于 role_hint + bio_hint 子串匹配分类
- campaign / ending-room REST 路由的 session gate 以 router 级 `dependencies` 统一注入，不再逐端点声明
- Phase 3 六大功能增强 (F1-F6)：Agent 身份+跨场景记忆、世界线因果图谱、用户自建 Agent、蝴蝶效应回溯、涌现阵营系统、辩论论证图谱
- 13 个新 ORM 模型分布在 `agent_identity.py`、`graph.py`、`checkpoint.py`，3 个 Alembic 迁移 (014-016)
- 8 个新后端服务：`persona_workshop`、`agent_identity`、`causal_graph`、`replay`、`factions`、`debate_argument_map`、`roundtable_survey`（圆桌问卷 SSE）、`roundtable_analyst`（ReACT 分析师 SSE）
- 2 个新 API router：`/api/agents/*`、`/api/graphs/*`；`/api/capabilities` 当前是 13-key 通用 capability registry（`web_search` + 12 个功能开关）
- 5 个新前端页面：`AgentWorkshopView`、`AgentLibrary`、`CausalReviewView`、`CompareDigestView`、`WorkbenchView`（图谱工作台，Causal/Split/KG 三种布局，compact 自动降级）
- 9 个新前端组件：`AgentAttachPanel`、`ArgumentMap`（已 i18n 化，P2 新增搜索/过滤/拖拽控件）、`CounterfactualPanel`、`FactionTimeline`、`ReturningBadge`（已集成到 ResultView + capability gate）、`FactionForceGraph`（G6 力导向图 + sr-only 回退）、`HookSummaryPanel`（5 hook 状态卡片）、`GraphWorkbenchShell`（工作台分屏容器）、`LayoutSwitcher`（tab 切换栏）
- 2 个新前端 hook：`useScenarioGraph`（共享图谱 fetch + requestId 防竞态）、`useHookSummary`（聚合 hook 状态，需 branchId）
- `simulator.py` 新增 4 个非阻塞 hook：因果图谱、阵营检测+WS 事件发射、检查点写入、身份生命周期（场景结束时写入 growth_event + identity_memory，`asyncio.to_thread` 包装），均受 `FEATURE_*` 环境变量控制
- `debate.py` 新增论证抽取 hook (每 turn 后) + verdict linking (finalize 后)，受 `FEATURE_ARGUMENT_MAP` 控制
- `helpers.py` parse 后自动调 `resolve_identity()` 回填 `agent_identity_id`，自建 Agent 替换 CROWD 槽位并同步 `parsed_context`；自建 Agent 注入需通过 ownership 校验（`user_id is not None` + `identity.user_id == user_id`）
- 当前 Phase 3 / graph-playability 相关 `FEATURE_*` 以 `config.py` 为准：常用项包括 `FEATURE_CUSTOM_AGENTS`、`FEATURE_AGENT_IDENTITY`、`FEATURE_CAUSAL_GRAPH`、`FEATURE_GRAPH_ANALYSIS`、`FEATURE_COUNTERFACTUAL_REPLAY`、`FEATURE_FACTIONS`、`FEATURE_ARGUMENT_MAP`、`FEATURE_REPLAY_TRACE`、`FEATURE_AGENT_CONVERSATION`、`FEATURE_KG_EXPLORER`、`FEATURE_IDENTITY_COMPACTION`、`FEATURE_ROUNDTABLE_SURVEY`、`FEATURE_ROUNDTABLE_ANALYST`。多数默认 `false`，`FEATURE_COUNTERFACTUAL_REPLAY` 默认 `true`；`graph_analysis` capability 还要求 `FEATURE_CAUSAL_GRAPH=true`
- 前端 4 个新页面均通过 `useCapabilityCheck` hook 做 capability gate；当前会复用 `/api/capabilities` 结果，并把 `loading / enabled / error` 暴露给 consumer。capability probe 失败时，前端不再默认伪装成 disabled
- `InputView` 集成 `AgentAttachPanel`，`ResultView` 集成因果图谱链接 + `CounterfactualPanel` + `FactionTimeline`，`DebateResultView` 集成 `ArgumentMap`，均受 capabilities 控制
- ChromaDB 双层 memory：scenario-scoped (不变) + identity-scoped (`identity_{user_id}` collection，200 条 FIFO，写入经 `identity:{user_id}` 粒度串行化锁保护)
- Agent continuity key：SHA-256(role+persona[:30])[:16]，跨场景身份匹配
- 自定义 Agent persona 通过 `format_untrusted_text_block()` 防注入
- `ScenarioResponse` 新增 3 个 additive 字段，`custom_agent_identity_ids` 最多 5 个
- `Scenario.user_id` 在创建时持久化（`scenarios.py`），场景结束 hook 优先读取该列，旧数据兜底从 `parsed_context["user_id"]` 取值
- `EventBridge` 新增 `viz:faction_cluster` / `viz:faction_event` 事件类型，`WorldScene` 消费这两个事件驱动阵营聚拢动画（对象池 + 命名常量 + `spriteH` 一致性 + `prefers-reduced-motion` snap）
- P1-3 Graph 导出：`ExportPanel` 组件（PNG via html2canvas + SVG via clone+inline computed styles+foreignObject），集成到 `CausalReviewView` + `ArgumentMap`
- P1-4 Graph 节点点击：`NodeDetailPanel` 组件（type/round/payload/unit details），`onNodeClick` 绑定到两个 ReactFlow 实例，selectedNode 在 re-fetch 时自动清空
- P1-12 Identity memory compaction：`FEATURE_IDENTITY_COMPACTION` 控制，阈值超过 50 条未压缩文档时异步 LLM 摘要（fire-and-forget），压缩文档带 `source_ids_hash` 幂等指纹，FIFO eviction raw 优先于 compacted，`get_identity_memories` 过滤压缩文档（只参与语义检索不进 timeline），prompt 经 `format_untrusted_text_block` 防注入
- P1-9 resume_from_round：`POST /api/scenario/{id}/resume` 从指定轮次续跑（clone+restore+`run_sim_background`），`Blackboard.export_snapshot()`/`from_snapshot()` 完整状态持久化，checkpoint bug fix（`get_global_summary()` → `export_snapshot()`），agent stance/emotion 仅内存恢复不改 DB，`Branch.replay_kind` 新增 `"resume"` 值，与 counterfactual 共享 3 条分支上限，resume 前先预占 runtime lock，后台任务续租 lease 到结束，避免丢锁和 orphan branch
- Identity compaction 由 `FEATURE_IDENTITY_COMPACTION` 控制，另有 3 个调参变量 (`IDENTITY_COMPACT_THRESHOLD`/`BATCH_SIZE`/`GROUP_SIZE`)
- WorkbenchView 三个 tab（Causal/Split/KG）均不再按 `branchId` 过滤 causal-graph 请求，始终获取全量图谱（与 `CausalReviewView` 默认 "所有分支" 行为一致）；`view=kg` 只要求 `FEATURE_KG_EXPLORER`，不再依赖 `FEATURE_CAUSAL_GRAPH`
- `useHookSummary` hook 接受 `branchId` 参数，faction-timeline 端点必须携带 `branch_id` 查询参数
- `getFactionRelations` 在 `client.ts` 中路径为 `/scenario/{id}/faction-relations`（与其他 graphs router 端点一致，无 `/graphs/` 前缀）
- `FactionForceGraph` 和 `LayoutSwitcher` 均有 `prefers-reduced-motion` guard；`FactionForceGraph` 另有 sr-only 列表回退供屏幕阅读器使用
- `factions.py` 新增 `faction-relations` 端点，查询参数 `branch_id`(必填) / `round_max` / `threshold` / `top_k` 均在 router 层校验
- `graphs.py` faction-timeline 端点会先校验 `branch_id` 是否存在 + 是否属于当前 scenario，缺失或跨 scenario 返回 404 `BRANCH_NOT_FOUND`
- KG 工作台 G6 配置抽到 `frontend/src/lib/kgGraphConfig.ts`（`buildKgG6Options` + `toKgG6Data`），`KGGraphBoard` 和 `KGExplorerView` 都复用同一份工厂；`toKgG6Data` 在 mobile + 节点数 > `KG_DEGRADE_THRESHOLDS.mobileNodes`(200) 时截断并通过 `truncatedFromCount` 把原始数量回传给上层渲染 aria-live 提示
- `useReducedMotion` 抽到 `frontend/src/hooks/useReducedMotion.ts`，`ArgumentMap` 和 `CausalReviewView` 共享同一份实现
- `CausalReviewView` 在 `layoutDagre` 内会按 source/target 配对计算平行边偏移（`buildParallelEdgeIndex`），`reducedMotion` 或 `nodes/edges > PERF_ANIMATION_LIMIT` 时禁用动画；节点点击会聚合相邻边的非空 evidence，作为 `evidenceList` 传给 `NodeDetailPanel`
- `NodeDetailPanel` 现在能渲染边级 evidence（`confidence_tier` 徽章、`source_ref`、`source_round_number`、`detail`），detail 文本按码点（`Array.from`）截断 200，避免劈开 surrogate pair
- `causal_graph.py` SQLModel 列属性访问统一用 `from sqlmodel import col` 包装（`col(Column).in_(...)` / `.desc()`），pyright SQLModel 类型告警全部清零
- P6 KG Mirofish + DAG Editorial：KG 侧 `kgGraphConfig.ts` 新增 `selected`/`streaming` G6 状态 + `{ enter: 'fade' }` 入场动画，`KGGraphBoard.tsx` 用 `graph.setElementState` 替代 JS 层 opacity 操纵实现点击锁定高亮（`lockHighlight`/`clearHighlight`），`shouldDisableAnimation` 控制动画参数；DAG 侧 `CausalReviewView`/`ArgumentMap` 共享 BFS 递归路径高亮（`lib/graphTraversal.ts` → `traceConnectedPath`），dagre 参数调大（CausalReview: 280×120 ranksep=120 nodesep=100，ArgumentMap: 280×120 ranksep=100 nodesep=80），`PERF_ANIMATION_LIMIT=150` 超限跳过动画
- `AnimatedEdge.tsx` 自定义 React Flow 边（`getSmoothStepPath` + SVG `<animateMotion>` 粒子 + `aria-hidden`，仅 `selected && !reducedMotion` 时动画），集成 `EdgeLabelTooltip`（midpoint 渲染 pill label + 300ms hover 展开 detail card + Escape 关闭 + detail card 上 `role="tooltip"` + pill 上 `aria-describedby`）
- `dagEditorialTokens.ts` 定义 6 类 DAG 节点色系（claim/evidence/rebuttal/support/verdict/default，含 light/dark）+ confidence tiers（medium 色 `#a16207` 满足 WCAG AA）+ card 样式常量；当前未接入 `GraphNodeCard`（走 `graphTokens`），预留后续主题切换
- `graphTokens.ts` 新增 `EVIDENCE_TIER_COLORS` 共享常量（CausalReviewView + ArgumentMap 共用，不再各自定义）；另新增 `KG_NODE_TYPE_FILLS` KG 专用暖灰色板（event=#9a8e85, fork=#a87060, stance_shift=#7a8e7a, intervention=#8a7e95, round=#8e8878, verdict=#7a8585），与 DAG 的 `NODE_TYPE_COLORS_HEX` 鲜明色分离
- `lib/graphTraversal.ts` 共享 BFS 函数 `traceConnectedPath`（邻接表 O(V+E)），另导出 `PERF_ANIMATION_LIMIT=150` 供 CausalReviewView + ArgumentMap + CausalGraphBoard 统一引用
- P7 图谱色系双层分离：`NODE_TYPE_COLORS_HEX`（鲜明色：event=#4a90d9, fork=#e74c3c 等）供 DAG/ArgumentMap/CausalReviewView 使用；`KG_NODE_TYPE_FILLS`（暖灰色）供 KG 使用。KG 节点同时编码类型色（fill）+ Agent 色环（stroke），Agent 色环来自 `KG_AGENT_PALETTE`（15 色暖色调）通过 `hashStringToIndex` 分配
- `kgGraphConfig.ts` 新增 `readAgentName()` + `buildKgNodeLabel()` 函数，KG 节点优先显示 "AgentName · R{round}" 而非截断原始 label；`toKgG6Data` 每个节点携带 per-node `fill`/`stroke`/`lineWidth` 样式，`buildKgG6Options` 全局 `node.style` 不再设 fill/stroke（避免覆盖 per-node 值）
- `KGGraphBoard` 图例默认展开 (`showLegend` 初始 `true`)，包含类型色点 + 说明文案 + 交互提示，类型 chips 和图例均使用 `KG_NODE_TYPE_FILLS`
- `CausalGraphBoard` + `KGGraphBoard` 均集成 `NodeConversationSheet`，点击节点可发起 Agent 对话（与 `CausalReviewView` 行为一致）
- `LayoutSwitcher` tab 按钮改用暖色 CSS 变量（`--bg-hover`/`--bg-elevated`/`--text-primary`/`--text-muted`），解决深色背景下按钮不可见问题
- `ReplayView` UI 全面重构：移除全部内联样式改为 BEM CSS class；新增 Agent 头像首字母+色环、情绪 emoji 徽章、fork 分支卡片图标、Pixel Theater 入口链接；`ReplayPlaybackControl` 重写为 SVG 图标按钮；`ReplayTimelineScrubber` 改为简洁数字计数
- 后端 `causal_graph.py` event 节点 label 前缀 agent_name；stance_shift payload_json 含 agent_name 字段；Alembic 025 数据迁移回填旧场景 graph_node 的 agent_name
- `GraphNodeCard.tsx` 新增可选字段 `round`/`confidence`/`sourceCount`/`summary`/`accentColor`，向后兼容
- `FactionForceGraph.tsx` 内联 `usePrefersReducedMotion` 已替换为共享 `useReducedMotion` hook
- `index.css` 新增 `dag-node-in`（250ms bounce-ease 入场）+ `dag-tooltip-in` + 7 个 `dag-empty-*` 空态骨架类 + `@media (prefers-reduced-motion: reduce)` guard
- `ArgumentMap.test.tsx` 拆分为 3 个文件（core 18 + search 13 + integration 32 = 63）解决单文件 OOM，另有 `ArgumentMap.p6.test.tsx` 6 个纯函数测试
- 圆桌优化（做减法+三模式融合）：Hero 区域操作按钮折叠为 "..." 下拉菜单（`HeroActionMenu`），隐藏 theme strip 和 stage note，Archive chips 从 6 减到 2（status + profile）；Phase Nav 新增 "深入探索" pill，点击展开 `PostVerdictPanel` 三 tab 面板（Agent 对话 / 分析师 / 问卷），仅在 verdict 完成后可用
- `PostVerdictPanel.tsx`：三 tab 面板（agent_chat/analyst/survey），`role="tablist"` a11y 完整，受 `useCapabilityCheck('agent_conversation')` gate
- `RoundtableAgentChat.tsx`：参与者选择器 + `NodeConversationSheet` 集成，通过 `nodeType: 'roundtable_participant'` 发起 per-agent 对话
- `roundtable_survey.py`：圆桌问卷服务，SSE 流式返回各参与者回答，`asyncio.Semaphore(3)` 限制并发 LLM 调用，注入 identity memory + 场景上下文
- `roundtable_analyst.py`：ReACT 分析师服务，3 个工具（query_causal_graph / search_identity_memories / search_web_context），最多 5 轮迭代，SSE 流式返回推理过程
- `POST /api/scenario/{id}/survey` 和 `POST /api/scenario/{id}/analyst`：两个新 SSE 端点，在 `ending_rooms.py` 中实现，受 `FEATURE_ROUNDTABLE_SURVEY` / `FEATURE_ROUNDTABLE_ANALYST` gate
- 圆桌硬编码文本已全面替换为 i18n key（`roundtable.*`），涉及阶段名、按钮标签、导出文本等
- `TimelineBar` 推演中闪烁修复：`glowPulse` 动画周期从 2s 改为 3s，最低 opacity 从 0.4 提到 0.7，移除 `thinkingAgents.length` 高频依赖防止 `displayStatus` 快速振荡
- Oracle 文案去模板化：`_content.py` 新增 3-tier fallback 架构（generation-first temp=0.82 → rewrite temp=0.78 → static anchor），`_build_oracle_generation_prompt` 以角色身份+场景问题+对话摘录驱动生成，不再依赖 anchor copy；`_build_character_identity_block` 提取角色名/职位/人设/情绪/立场/分支并经 `sanitize_untrusted_text` 防注入；`_build_factual_guardrail` 从 branch_card 提取轻量事实（worldline_title/key_hinge/outcome_insight/key_moments）替代完整模板文本；四种房间类型（WORLDLINE_ROUNDTABLE/ENDING_CHAMBER/ONE_MOVE_ONLY/CROSSLINE_GALLERY）均已接入 factual_guardrail + scenario_question + transcript_quotes 三项上下文注入
- `_load_scenario_question` + `_load_branch_transcript_excerpts`：两个新 DB 查询函数，分别加载场景原始问题和每条分支最近 5 条对话摘录（`.select_from(Round)` 避免 SQLite 列名歧义）
- `_stream_oracle_copy` 改用 `_build_oracle_generation_prompt`（不再走 rewrite prompt），温度 0.55→0.75，reasoning_effort low→medium
- `_normalize_oracle_generated_content` 字符上限 520→800
- follow-up 路径（`_threads.py`）同步加载 scenario_question + transcript_quotes，传给 stream 和 non-stream 两条路径
- 前端 `EndingChatModal.tsx` + `RoundtableAgentChat.tsx` 改用 `SafeMarkdown`（react-markdown + rehype-sanitize）渲染 Agent 消息 + `TypingIndicator` 三点等待动画

## 变更记录 (Changelog)

| 日期 | 操作 | 说明 |
|------|------|------|
| 2026-05-06 | 首页 UX 重构 + source family 分类搜索 | 前端：InputView 模式选择器（推演/可视化/推理/档位）从折叠"高级设置"移到输入区默认展示，新增 `.iv-mode-selectors` 卡片容器 + 分隔线排版；web search toggle 去除 `VITE_ENABLE_WEB_SEARCH` 编译期 gate 改为默认可见；source family checkboxes 新增 capability gate（`FEATURE_NEW_SOURCES=false` 时隐藏）+ `.new-source-toggle` 卡片样式（与 web-search-toggle 视觉一致）；BYOK 区独立折叠（去除 `showByok` 二层嵌套）。后端：`web_context.py` 新增 `FAMILY_DOMAIN_FILTERS` 定义四个 family 的域名白名单（polymarket→Polymarket/Metaculus 等，finance→Bloomberg/Reuters 等，academic→arXiv/Scholar 等，news_deep→AP/BBC/NYT 等）；新增 `fetch_family_context()` 异步函数，对每个选中 family 并发发起独立域名过滤搜索（`asyncio.gather`）；四个 provider 函数均新增 `include_domains` 参数（Tavily/Exa 原生 API 参数，SearXNG 通过 `site:` query 语法，xAI 通过 prompt 注入）；`scenarios.py` 调用 `fetch_family_context()` 替代旧的 `build_source_family_context()` 同步投影；`.env` 新增 `FEATURE_NEW_SOURCES=true`。i18n：source family 标签更新为诚实描述域名搜索范围（如"搜索 Bloomberg、Reuters、CNBC 等财经网站"），en/zh parity `1636=1636`；tsc 0 errors，vite build 0 violations |
| 2026-05-06 | Web 搜索集成全栈审计 | 安全：E2E 脚本密钥 redaction（`redactScenarioRequest` 递归脱敏 `web_search_api_key`/`llm_api_key`）+ preflight 数据最小化（`client.ts` `preflightMode` 排除 web search 配置）；后端：`web_context.py` snippet 规范化（`_truncate_snippet(800)` + `_sanitize_url` + isinstance 类型防护 4 个 provider 统一）、provider validator（`config.py` 只允许 tavily\|exa\|xai\|searxng\|native）、TypeError fallback 移除、cache stampede 去重（per-key `asyncio.Lock` + double-check + finally-pop 释放）、`_sanitize_url` 修复 tab 字符泄漏、xAI `_parse_xai_structured_snippets` 参数 shadowing 消除；前端：`InputView.tsx` base URL `new URL()` 校验（仅允许 http/https）+ `webSearchUrlError` 独立 state + a11y（aria-describedby/aria-invalid/aria-controls 条件渲染）、`types.ts` 导出 `WebSearchFamily` 共享类型（消除 InputView/client.ts 重复定义）、`ResultView.tsx` source card 桌面/移动端去重（共享 `sourceCards` 变量）、新建 `useWebSearchConfig.ts` hook 解耦 web search 状态（从 `useInputViewState` 剥离 7 state + 8 setter + capabilities 轮询）；Claude+Codex 两轮对抗式审查修复 2 Critical + 6 Warning；i18n +2 keys（`home.web_search_base_url_invalid`），en/zh parity `1536=1536`；fresh baseline: frontend `165 files / 1750 tests / 0 failed`，backend web_context 61 passed + contract 37 passed，tsc 0 errors，vite build OK |
| 2026-04-30 | Oracle 文案去模板化 | `_content.py` 架构重构为 generation-first 3-tier fallback（纯生成 temp=0.82 → rewrite temp=0.78 → 静态模板），新增 `_build_oracle_generation_prompt`/`_build_character_identity_block`/`_build_factual_guardrail` 三个函数；`__init__.py` 新增 `_load_scenario_question`/`_load_branch_transcript_excerpts` + 四种房间类型全部接入 factual_guardrail；`_threads.py` follow-up 路径同步注入 scenario_question + transcript_quotes；`_stream_oracle_copy` 温度 0.55→0.75 + reasoning_effort low→medium；字符上限 520→800；前端 EndingChatModal + RoundtableAgentChat 改用 SafeMarkdown + TypingIndicator；Codex+Claude 两轮对抗式审查修复 5 个真实 Bug（character identity 字段防注入、follow-up 缺 transcript_quotes、reasoning_effort 重试丢失、agent_emotion 未 sanitize、dead language 参数）；Playwright 实测四种玩法模式（圆桌 13 代表 / 会客厅 / 只改一步 / 其他世界线 12 条异线摘要）+ 玩法卡注入（公开听证 3/3 Agent 首句回应）均验证通过；i18n +1 key（typing_aria），en/zh parity `1532=1532`；backend 89 ending room tests passed，ruff 0 errors |
| 2026-04-29 | 圆桌 UI 审查 + 文案/prompt 改进 | Hero "..." 下拉菜单修复（移除 hero `overflow: hidden` + topline `z-index: 3` + body `overflow: hidden` 分层裁切，修复 dropdown 被截断和遮挡）；各阶段要点 accordion 改为圆角卡片（通过 twMerge 用 `border rounded-2xl` 替换 Tailwind `border-b`，open 状态 accent 边框+阴影）；锚点 pills 去掉 18 字硬截断改为 CSS ellipsis + `title` hover 预览；composer textarea 自动扩展高度（最大 160px，`activateAnchor` 填充后 scrollIntoView）；PostVerdictPanel tab 改为信息卡片风格（label+desc 双行）；RoundtableAgentChat 发送/停止按钮 i18n key 修复；后端 prompt 增强（survey 角色感+引用规则、analyst 同语言回答+证据引用+不确定性说明）；SurveyStreamView/AnalystStreamView 空态提示；i18n +6 new keys，en/zh parity `1531=1531`；fresh baseline: frontend `163 files / 1738 tests / 0 failed`，backend 72 passed，tsc 0 errors |
| 2026-04-28 | 圆桌优化：做减法 + 三模式融合 + 闪烁修复 | Hero 做减法（操作按钮折叠为 "..." 菜单，隐藏 theme strip + stage note，chips 6→2）；PostVerdictPanel 三 tab 探索面板（Agent 对话 / 分析师 / 问卷），Phase Nav "深入探索" pill 入口，仅 verdict 后可用；RoundtableAgentChat 参与者选择 + NodeConversationSheet 集成；后端 2 个新 SSE 服务（roundtable_survey Semaphore 并发 + roundtable_analyst ReACT 3 工具），2 个新端点 + 2 个 feature flag + capabilities 11→13 key；圆桌硬编码文本全面 i18n 化；TimelineBar 推演闪烁修复（glowPulse 2s→3s + opacity 0.4→0.7 + 移除 thinkingAgents 高频依赖）；i18n parity `1416=1416`；fresh baseline: frontend `163 files / 1735 tests / 0 failed`，tsc 0 errors |
| 2026-04-28 | P7 图谱 mirofish 视觉升级 + Replay UI 重构 | ReplayView 全面重构（BEM CSS class 替代内联样式，Agent 头像色环 + 情绪 emoji + fork 卡片图标 + Pixel Theater 入口）；ReplayPlaybackControl SVG 图标按钮重写；ReplayTimelineScrubber 简洁数字计数；KG/DAG 色系双层分离（`NODE_TYPE_COLORS_HEX` 鲜明色给 DAG，新增 `KG_NODE_TYPE_FILLS` 暖灰色给 KG）；KG 节点双层编码（类型 fill + Agent stroke 色环，`KG_AGENT_PALETTE` 15 色暖色调）；KG 节点 label 优先显示 AgentName · R{round}；KG 图例默认展开 + 类型说明 + 交互提示；CausalGraphBoard + KGGraphBoard 集成 NodeConversationSheet（点击节点可发起 Agent 对话）；LayoutSwitcher tab 按钮改用暖色 CSS 变量（修复深色背景不可见）；后端 causal_graph.py event/stance_shift 节点 label 含 agent_name + Alembic 025 回填旧数据；i18n +25 keys，en/zh parity `1555=1555`；index.css +300 行 `.replay-*` CSS；fresh baseline: frontend `163 files / 1735 tests / 0 failed`，tsc 0 errors |
| 2026-04-27 | P6 全量审查 + 10 项代码质量修复 | Codex+Claude 双模型交叉审查，Codex 验证 7 Warning 全部 TRUE + 发现 1 个功能 Bug；10 项修复：`graphTraversal.ts` BFS 重写为邻接表 O(V+E)（原 O(V*E)）+ 导出 `PERF_ANIMATION_LIMIT` 共享常量、`ArgumentMap.tsx` edge sync 补充 `type`/`selected`/`data` 修复 AnimatedEdge 不激活 Bug、`CausalReviewView.tsx` path-trace 依赖改为稳定 edge 结构签名（修复 `flowEdges.length` 隐藏的过时高亮）、`CausalReviewView` + `ArgumentMap` render-phase ref 副作用移入 useEffect（concurrent mode 兼容）、`useReducedMotion.ts` 删除无效 `queueMicrotask`（每次 mount 少一次 re-render）、新建 `hooks/useMediaQueryState.ts` 共享 hook（CausalReviewView + ArgumentMap 各删 ~25 行重复代码）、`KGGraphBoard.tsx` lockHighlight 加 staleness guard（防止节点已删除时 setElementState 报错）、`EdgeLabelTooltip.tsx` 提取 `HOVER_DELAY_MS` 命名常量、`CausalReviewView` + `ArgumentMap` + `CausalGraphBoard` 统一从 `graphTraversal.ts` 导入 `PERF_ANIMATION_LIMIT`；Playwright 浏览器实测 16/20 PASS（4 SKIP 因 LLM 依赖），mobile 375px 无溢出，Console 零 JS 错误；fresh baseline: frontend `159 files, 1677 tests, 0 failed`；tsc 0 errors + lint 0 errors(3 warnings) + build 0 violations |
| 2026-04-27 | P6 Review 修复 + 重复代码消除 | 3 个 a11y Critical 修复：`AnimatedEdge.tsx` SVG circle 加 `aria-hidden`、`EdgeLabelTooltip.tsx` ARIA 结构重构（`role="tooltip"` 移到 detail card、`aria-describedby` 移到 pill span）+ timer 卸载清理、`dagEditorialTokens.ts` medium 色 `#eab308` → `#a16207`（WCAG AA 5.3:1）；4 项代码质量改进：BFS 路径追踪提取到 `lib/graphTraversal.ts`（`traceConnectedPath`，CausalReviewView + ArgumentMap 共用）、`EVIDENCE_TIER_COLORS` 提取到 `graphTokens.ts` 共用、CausalReviewView + ArgumentMap 入场动画 `layoutAppliedRef` 在数据切换时自动重置；Codex 验证 7 个 Warning 真实性（3 TRUE + 1 partial + 3 FALSE），仅修复经验证的真实问题；fresh baseline: frontend `159 files, 1677 tests, 0 failed`；tsc + lint(0 errors) + build(0 violations) 全通过 |
| 2026-04-27 | P6 KG Mirofish + DAG Editorial Redesign | KG 侧：`kgGraphConfig.ts` 新增 `selected`(halo 18px)/`streaming`(lineDash [7,5]) G6 状态 + node `{ enter: 'fade' }` 入场动画；`KGGraphBoard.tsx` 移除 `styledG6Data` JS 层 hover/click dimming，改用 `graph.setElementState` batch API 实现 click-lock 高亮（`lockHighlight`/`clearHighlight`），`shouldDisableAnimation` 透传到动画参数。DAG 侧：`CausalReviewView` + `ArgumentMap` 新增 BFS 递归路径高亮（`traceAncestorsAndDescendants`/`traceArgumentPath`，点击节点高亮全祖先+后代链，孤立节点 opacity 0.2，150ms ease 过渡）；dagre 参数调大（CausalReview NODE_W/H=280×120 ranksep=120 nodesep=100，ArgumentMap 280×120 ranksep=100 nodesep=80）；`PERF_ANIMATION_LIMIT=150` 超限跳过动画；`AnimatedEdge.tsx` 自定义边（SVG `<animateMotion>` 粒子 + `EdgeLabelTooltip` midpoint pill label）；`EdgeLabelTooltip.tsx`（hover 300ms delay + Escape dismiss + `role="tooltip"` + reduced-motion guard）；`dagEditorialTokens.ts` 6 类节点色系（预留未接入）；`GraphNodeCard.tsx` +5 可选字段（round/confidence/sourceCount/summary/accentColor）；`FactionForceGraph.tsx` 内联 hook → 共享 `useReducedMotion`；`index.css` +2 keyframes + 7 empty-state 类 + reduced-motion guard；`ArgumentMap.test.tsx` 拆分 3 文件解决 OOM（18+13+32=63 测试）；i18n +10 keys（`dag.*`），en/zh parity `1331=1331`；fresh baseline: frontend `159 files, 1677 tests, 0 failed`；tsc + lint(0 errors) + build + budgets 全通过；Codex 对抗式审查 0 Critical；Playwright 浏览器实测 6/6 PASS（ResultView deep link / WorkbenchView KG gate / DAG empty state / ArgumentMap / mobile 375px / reduced motion） |
| 2026-04-27 | 工作台全量图谱修复 | `KGGraphBoard` 和 `CausalGraphBoard` 不再将 URL 的 `branch` 参数透传给 `useScenarioGraph`，始终获取全量 causal-graph（之前按 branch_id 过滤只返回 1 个 fork 节点）；与 `CausalReviewView` 默认 "所有分支" 行为一致；真实场景实测 56 节点 · 19 连线完整渲染，Causal/Split/KG 三个 tab 均正常 |
| 2026-04-25 | KG mirofish-style 升级 + Codex review fix | 工厂层 5 项 v2 fix：白边 halo (`NODE_HALO_STROKE` `#f8fafc`/`#0f172a` + `lineWidth=2.5`)、全局 `edge.type='cubic'` 曲线 + per-edge `labelText`/`labelBackground` 关系名 + `endArrow`、`KG_DEGRADE_THRESHOLDS.edgeLabelLimit=200` 护栏、`EDGE_TYPE_LABEL_I18N` 7 类 + `toKgG6Data(opts.t)` i18n 接入、`DEFAULT_KG_LAYOUT` 保守值 (linkDistance 80→120 / nodeStrength=-200 / collide=40) 让图谱有呼吸感；KGGraphBoard 集成：Edge labels toggle (◉/◌, edges<=50 默认开 / >50 默认关 / >200 强制关)、桌面点击优先 `NodeQuickCard` (mobile 直走 `NodeDetailPanel`) 严格互斥、node:dblclick 触发 `focusElement`/`fitCenter` 聚焦；新 `NodeQuickCard.tsx` (role=dialog/aria-modal=false/Escape/auto-focus close button/Math.max(CLAMP_GAP) 双向钳位 ≥0/prefers-reduced-motion)；KGExplorerView 重构走 `buildKgG6Options({layout})` 参数化；i18n +10 keys (`kg_graph_board.*` 5 + `causal.edge_*` 5)，en/zh parity `1335=1335`；测试：`kgGraphConfig.test.ts` 41→54、`KGGraphBoard.test.tsx` 13→24 (跨节点 mutex + dblclick focusElement/fitCenter spy + toggle 边界)、`NodeQuickCard.test.tsx` 新建 13 tests (含负向 clamp + right-edge flip negative)；fresh baseline `frontend 153 files / 1616 tests / 0 failed`，tsc + vite build 通过；Codex 两轮对抗式 review (first-pass 1C/3W/8I + second-pass 测试覆盖加固) → 全修复 (mutex 严格清栈、负向 clamp ≥0、+5 测试)；Playwright DOM 实测 `/workbench/:id?view=kg` 通过 (canvas 1440×761, toggle aria-pressed 切换, 3 tabs)。**Known limitations** (P3 deferred)：Add-S3 平行边 cubic 不自动偏移 (后续可复用 `buildParallelEdgeIndex`)，Add-S4 toggle 走 styledG6Data useMemo 重算而非 G6 `updateEdgeData` (200 节点性能可接受) |
| 2026-04-25 | KG 工作台收口 + 边级 evidence + 类型告警清零 | KGGraphBoard 抽 `frontend/src/lib/kgGraphConfig.ts` 工厂（`buildKgG6Options` + `toKgG6Data` + `computeNodeSize` + `getKGNodeStyle/getKGEdgeStyle`），UI 补完整搜索/类型 chips/缩放控件/小地图/SR fallback 表/移动 200 节点 aria-live 截断提示；KGExplorerView 重构复用同一工厂；`useG6Graph` 新增 5 个事件 handler（onNodeHover/onNodeLeave/onEdgeClick/onEdgeHover/onEdgeLeave）；抽 `useReducedMotion` 共享 hook（ArgumentMap + CausalReviewView 复用）；NodeDetailPanel 新增边级 evidence 渲染（confidence_tier 徽章 + source_ref + source_round_number + detail，detail 按码点截断 200，支持 evidence 单条 / evidenceList 多条）；CausalReviewView 加平行边 offset + reducedMotion 控制 + 节点点击聚合相邻边 evidence；后端 faction-timeline 端点加 branch 存在 + cross-scenario 校验（404 `BRANCH_NOT_FOUND`，+4 测试）；causal_graph.py SQLModel 类型告警全清零（`col()` 包装 10 处 desc/in_ + dict 不变性显式标注 4 处 + Sequence 1 处 + Optional member access assert 3 处），test_causal_graph.py 加 `source_round_number=0` 回归测试 + MockMessage 6 处 None 默认值类型注解；i18n 新增 18 keys（`kg_graph_board.*` 10 + `node_detail.evidence_*` 8），en/zh parity `1308 = 1308`；fresh baseline: backend `2328 passed, 2 skipped` / frontend `152 files, 1577 tests, 0 failed`；tsc + build + ruff + pyright（14 errors → 0）全部通过 |
| 2026-04-25 | P2 深度审查 + 修复 | P2-1 WorkbenchView (Causal/Split/KG 三 tab + compact 降级)、P2-2 FactionForceGraph (G6 力导向图)、P2-3 HookSummaryPanel (5 hook 状态卡片)、P2-4 ArgumentMap 搜索/过滤/拖拽控件、useScenarioGraph + useHookSummary 两个新 hook；4-Gate 并行审查修复 8 P1：getFactionRelations URL 404 修复、useHookSummary branchId 透传、WorkbenchView KG gate 加 causal 依赖、LayoutSwitcher prefers-reduced-motion、FactionForceGraph sr-only 回退、HookSummaryPanel retry aria-label、2 个测试质量修复；后端新增 faction-relations 端点 + 306 行测试；fresh baseline: backend `2320 passed, 0 failed, 2 skipped` / frontend `149 files, 1491 tests, 0 failed`；tsc + build + i18n parity 全部通过；Playwright 浏览器实测 ResultView/WorkbenchView/HookSummaryPanel/i18n/mobile 全通过 |
| 2026-04-25 | P0/P1 完成度评估 + 测试修复 | P0 7/7 全部通过 (Playwright 浏览器实测)；P1 全部完成 (21 fixes + 4 功能增强)；修复 `test_fallback_migrations.py` 2 处断言缺少 P1 evidence 字段；fresh baseline: backend `2304 passed, 0 failed, 2 skipped` / frontend `144 files, 1399 tests, 0 failed`；Graphify 核心图谱能力已全面吸收 (Tier B)；MiroFish 流程可见性+探索连续性已超越，工作台感属 P2-1；P2 readiness: 通过 |
| 2026-04-23 | 前端 gated route 状态面收口 | `useCapabilityCheck` 当前会复用 `/api/capabilities` 请求，并把 probe 失败显式暴露给页面；`ReplayView` capability disabled 不再 silent redirect，改成显式 unavailable surface；`KGExplorerView / CompareDigestView / FactionTimeline` 当前把 `disabled / load failed / empty` 分开显示，不再直接泄漏原始错误，也不再把所有异常压成空态；首页 4 个 source family disabled tooltip 已补齐中英 locale。真实验证：frontend focused regression `64 passed`、frontend full vitest `1349 passed`、`npx tsc --noEmit -p tsconfig.app.json` 通过、`npm run build` 通过，local preview 也已确认 Replay unavailable surface、中文 source tooltip 和结果页新的 FactionTimeline 空态文案 |
| 2026-04-20 | WS / capability graph contract 诊断收口 | `useAgentConversationWS` 改回真实 `/ws/agent-conversation/{thread_id}`；`e2e-ws-contract-suite.mjs` 去掉 import 副作用后，这轮又补了两处真实收口：`case1` 改走绝对 URL + 独立 page，不再把 `/sim` `/debate` 静默 skip；raw probe 先于 live fixture 执行，避免 clean-room 下 `scenario` 被 live fixture 污染成假 `1006`。同时恢复并保留 `e2e:capability-matrix / e2e:ws:contract` 两条诊断 npm script。真实验证为 backend `tests/test_evidence_card_flow.py` `5 passed`、`tests/test_session_auth.py -k 'auth_timeout_closes_4001 or oversized_auth_frame_closes_1009 or pending_blocks_new_connections'` `3 passed`；frontend `node --test scripts/e2e-ws-contract-suite.test.mjs` `18 passed`、定向 vitest `32 passed`、clean-room `e2e:ws:contract` `20 passed / 1 skipped / 0 failed`、clean-room `e2e:capability-matrix` `25 passed / 5 skipped / 0 failed` |
| 2026-04-19 | source-family live contract + merge gate 收口 | quota ledger `Retry-After` 改成真实 rolling 24h 语义；`release-signoff` 的 `new_source_ingestion_live` 步骤现在会显式带 `SWARM_E2E_MODE=live`；`POST /api/scenario` 新增 `web_search_families`，backend 会把 live snippets 投影成 `web_search_context.family_context`，`NEW_SOURCES_POLYMARKET_CONFIGURED_HOST=non-us` 时 `Polymarket` 显式走 geo-gated 口径；ResultView 改成按 `family_context` 渲染四张 source family card；fresh 验证为 backend `2264 passed, 2 skipped`、frontend `1336 passed`、typecheck/build/perf 通过、source-ingestion live `us/non-us` 桌面/移动全通过；llmdoc / implement / progress 已同步 |
| 2026-04-18 | graph-playability-upgrade 6-layer delivery | Layer 1 (BE-1/FE-1) migration 022 `agent_conversation` + @antv/g6 依赖+chunk+capability hook `nestedPath`；Layer 2 (BE-2) scenario delete 服务化 + 级联 Phase 3 表；Layer 3 (BE-3/4/5) POST `/conversation` (sequence reservation + CAS finalize + ownership quota + SSE) / GET `/replay-trace` (cursor 分页 + feature gate) / `/web-context` 4-family providers façade (news_deep/wikidata/polymarket/rsshub + shared token bucket + Retry-After)；Layer 4 (BE-6) capabilities 扩展 `agent_conversation`/`kg_explorer`/`replay_trace` + `web_search.providers` 嵌套 schema；Layer 5 (FE-2/3/4/5/3-seq) `KGExplorerView`+`TimelineGalaxy`+3 lazy 路由 (G6 Canvas hook + 100+ 节点 FPS budget)、`NodeConversationSheet` 流式隔离 + aria-live debounce + WS 重连 + 4 trigger sources (ArgumentMap/CausalReviewView/FactionTimeline/KGExplorerView)、`ReplayView` scrubber + agent queue + URL hash + 键盘快捷键、`ResultActionCard` + 4 source 卡片 + MobileSourceSheet + GlobalOfflineBanner + InputView 4 source toggles；Layer 6 (QA) QA-2 4 脚本 Tier 1 live + release-signoff 注册 (node-conversation/kg-explorer/replay-view/new-source-ingestion) + 4 npm scripts；QA-3 i18n 31 新 keys (19 kg_explorer + 2 timeline_galaxy + 10 replay) 全 en/zh parity；QA-4 根+backend+frontend CLAUDE.md + MEMORY.md 同步 |
| 2026-04-10 | P1-9 resume + P1-12 compaction | P1-12 identity memory compaction (LLM 摘要 + 幂等 hash + FIFO raw-first eviction + format_untrusted_text_block 防注入，15 后端测试)；P1-9 resume_from_round (POST /resume + Blackboard export/from_snapshot + checkpoint bug fix + agent in-memory restore + runtime lock guard，16 后端测试) |
| 2026-04-10 | P1-3 graph export + P1-4 node detail | ExportPanel (PNG html2canvas + SVG foreignObject clone) + NodeDetailPanel (type/round/payload/unit)，集成 CausalReviewView + ArgumentMap，i18n 18 新 keys，38 前端测试 |
| 2026-04-10 | Phase 3 Batch 2 — UX 壳 + 修复 | M-2 factions/causal_graph/checkpoint asyncio.to_thread (4 call sites, 20 tests)；M-4 tween budget 全局 getTweens().length；P1-6 ArgumentMap → @xyflow/react DAG + dagre layout + MiniMap；P1-7 ArgumentStrengthMeter (stacked bar)；P1-1 AgentProfileModal (dialog + identity details + memory/growth)；P1-2 MemoryTimeline (vertical timeline grouped by scenario)；P1-5 LiveArgumentMap (DebateArenaView collapsible sidebar, auto-refresh on turn)；P1-8 TranscriptFactionOverlay (FactionBadge + useFactionOverlay hook + RoundtableTranscriptList/EndingChatModal 集成)；新 growth-events backend endpoint (3 tests)；i18n 21 新 keys (argument.* + agent_profile.*)；57 新前端测试 + 20 新后端测试 |
| 2026-04-09 | P0 接线 + 安全修复 | X-5 ownership 校验 (user_id is not None + match) + Scenario.user_id 持久化；P0-2/P0-3 identity lifecycle hooks (asyncio.to_thread + per-agent 异常隔离)；P0-4 faction WS 事件发射 (viz:faction_cluster/event)；P0-5 Phaser 阵营聚拢动画 (对象池 + spriteH 一致性)；P0-1 ReturningBadge 集成 ResultView + capability gate；X-2 i18n keys 补全 (feature_disabled + argument.* + a11y_label)；M-3 identity memory Chroma 串行化锁 (identity:{user_id})；ArgumentMap TYPE_LABELS i18n 化；16 新测试 (test_p0_wiring.py) |
| 2026-04-09 | Phase 3 接线补全 | 11 个 API endpoint 全部加 server-side FEATURE_* gate + 404 测试；simulator 3 hook 接线 (causal+factions+checkpoint)；debate argument map 抽取+verdict linking；helpers.py 身份解析+自建 Agent 合并+parsed_context 同步；前端 capability gate + useCapabilityCheck hook + InputView/ResultView/DebateResultView 集成 |
| 2026-04-09 | Phase 3 六大功能增强 | F1 Agent身份+记忆、F2 因果图谱、F3 自建Agent、F4 蝴蝶效应回溯、F5 涌现阵营、F6 论证图谱；13 新模型、6 新服务、3 迁移、4 新页面、5 新组件、171 新测试 |
| 2026-04-09 | 遗留项收口 + 文档同步 | m1/m2 WS 异常处理加固、s1 session gate 提升 router 级、s2 CSS token 提取、s3 tween guard 测试、s4/s5 a11y + 死代码清理、llmdoc 10→13 variants 同步 |
| 2026-04-08 | WS pending_auth + Track B2 + E4/E5 | pending_auth 计入连接上限 + auth_ok 发送失败释放；voice variant 10→13 (diplomat/advisor/science) + 关键词扩充 + scholar/civic overlap 修复；Codex+Claude 交叉审查 E4 + 签收 E5 PASS |
| 2026-04-08 | WS 首帧 auth + session gate 测试 | WS 认证从 query string 迁移到首帧 auth 协议，4001/4404 不重连，15 backend + 3 frontend 测试，auth_ok 类型定义 |
| 2026-04-07 | Web 搜索增强 + 安全加固 | web_context 服务、搜索增强 toggle、ResultView 来源卡片、`/api/capabilities`、BYOK 业务入口校验统一、fence-breakout 修复、累计 21 条边界回归测试 |
| 2026-04-02 | 初始生成 | 全仓扫描，生成根级 + 模块级 CLAUDE.md 及 index.json |
