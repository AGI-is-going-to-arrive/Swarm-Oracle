# Backend 模块地图

## 模块依赖关系

```
api/scenarios.py ──► api/schemas.py (Pydantic 模型)
    │             ├── api/helpers.py (后台任务/工具函数)
    │             ├── api/interventions.py (干预路由)
    │             └── api/social.py (社交媒体文案路由)
    │
    ├──► services/simulator.py ──► services/memory.py
    │                           ├── services/llm_client.py (含指数退避重试)
    │                           ├── services/parser.py
    │                           ├── services/narrator.py
    │                           ├── services/vector_store.py
    │                           ├── services/scoring.py (P3-B)
    │                           └── services/lang_detect.py (P9)
    │
    ├──► visualization/ ──► 像素化可视化层 (Phase 1+2)
    │       ├── events.py (事件类型枚举 + 工厂，含 WEATHER_CHANGE)
    │       ├── mapper.py (VisualizationMapper — 8 个 map_* 方法)
    │       ├── persona_mapper.py (Agent → Sprite 分配 + 坐标计算)
    │       ├── scene_selector.py (双签名 → 26 场景语义池；原始题面优先)
    │       └── card_events.py (卡牌事件触发 + 可视化映射)
    │
api/predictions.py ──► services/scoring.py (P3-B)
    │
api/ws.py ──► WebSocket Manager (内联)
    │
models/database.py ──► SQLModel (Scenario, Agent, Branch, Round, Message, InterventionLog)
models/agent_group.py ──► AgentGroup, AgentGroupMember (P3-A)
models/predictions.py ──► Prediction, Leaderboard (P3-B)
config.py ──► pydantic-settings (Settings singleton)
alembic/ ──► Alembic 数据库迁移框架
```

## 服务层 (`app/services/`)

### `simulator.py` (≈870行) — 核心模拟引擎
- **职责**: 编排整个模拟流程（解析→生成agent→分轮辩论→分支/剪枝→叙事）
- **关键函数**:
  - `run_simulation(scenario_id, session)` — 主入口，根据 `mode` 条件初始化 `blackboards`；BYOK API Key 纯内存传递，不持久化
  - `_gather_agent_messages(..., blackboard)` — 读共享简报 + batch post
  - `_compress_round_memory(..., blackboard)` — 压缩 + 更新黑板全局态势
  - `_check_fork_conditions()` — 分支检测逻辑
  - `_prune_branches()` — 概率低分支剪枝
  - `_get_recent_messages(engine, branch_id)` — LEFT JOIN 单查询取消息+agent名（P0-2 N+1修复）
  - `_get_messages_in_range(engine, branch_id, start, end)` — LEFT JOIN 范围查询（P0-2 N+1修复）
- **模式**: `blackboard`（默认，每分支一个 Blackboard，fork深拷贝）| `raw`（跳过 Blackboard，Agent 直接读 DB）
- **分层模式** (P3-A): `_gather_hierarchical_messages()` — Leader 代表推演 + Worker 响应合成，千人规模时 LLM 调用量降低 90%+；Worker 合成消息也广播 `viz:bubble_show` 可视化事件
- **Agent JSON 容错**: `_gather_agent_messages()` 现在会通过 `llm_call_json(..., fallback_mode="agent_message")` 恢复轻微损坏的 agent JSON；如果模型至少吐出了 `content/emotion/diverge` 这样的键或纯文本，不会直接让该 agent 丢一整轮发言
- **结局类型 3 级映射**: `ending_type` 按概率分 3 档: `< 0.3` → "negative", `0.3-0.5` → "neutral", `> 0.5` → "positive"
- **可视化 stance 归一化**: `_coerce_stance_value()` 将数值 stance 与中英文立场词（如 `支持/反对/neutral/support`）统一映射到 `[-1, 1]`，避免 Theater 定位阶段因文本 stance 触发类型错误
- **占位根分支复用**: `_get_or_create_root_branch()` 会复用 `POST /api/scenario` 阶段创建的 provisional root branch，避免启动期前端世界线骨架与模拟期真实根分支重复
- **viz_push 辅助函数**: 统一所有 viz 广播调用，含 `viz_mapper is not None` 安全守卫
- **Fork 抑制**: 最后一轮不 fork，保证所有叶子分支都有 Agent 发言
- **分支归一化**: fork 后自动归一化子分支概率使总和为 1.0；使用单数据库会话优化 (P2-8)
- **批量删除**: `delete_scenario` 使用批量 SQL DELETE（P2-7）
- **并发**: `LLM_CONCURRENCY` 限制并发LLM调用
- **语言感知**: 全链路透传 `detected_language` 参数给 memory、narrator、fork 检测、round 压缩，确保输出语言匹配用户输入
- **数据完整性**: LEFT JOIN 保证已删除 Agent 的消息仍可读取（显示 "Unknown"），不会静默丢失

### `blackboard.py` (≈110行) — 共享空间 (**NEW**)
- **职责**: 中央共享黑板，所有 Agent 共读同一份信息
- **关键API**:
  - `post(agent, content, emotion, diverge)` — Agent 写入
  - `get_shared_briefing(max_entries)` — 生成共享简报 dict
  - `update_global_summary(compressed)` — 从压缩输出摄入结构化数据
  - `fork()` → `Blackboard` — 深拷贝，分支独立
  - `set_agent_group(agent_id, group_name)` — 注册 Agent 分组 (P3-A)
  - `get_group_briefing(group_name, max_entries)` — 组内专属简报 (P3-A)
  - `get_leaders_only_briefing(max_entries)` — Leader 跨组摘要 (P3-A)
- **滑动窗口**: activity_log 默认 max 20 entries

### `memory.py` (≈230行) — 记忆管理
- **职责**: L0上下文构建 + 结构化压缩 + 分层上下文 + 黑板格式化
- **关键函数**:
  - `compress_rounds(messages_text)` → `dict` (态势简报)
  - `_validate_compress_result(raw)` — 防御性LLM输出校验
  - `format_messages_for_context(messages, max_recent, tier)` — 按tier差异化消息数量
  - `format_briefing_for_context(briefing)` — 黑板 dict → 中文结构化文本
  - `build_agent_context(..., tier, shared_briefing)` — Blackboard模式替换 messages+memories
  - `_build_crowd_context(...)` — CROWD精简prompt (~800 tokens)
- **Tier映射**: `_TIER_MAX_RECENT` = CORE→8, IMPORTANT→5, CROWD→3
- **输出格式**: `{situation, active_debates, key_quotes, tension_points, consensus}`
- **玩法卡强化**: intervention block 现在明确把玩法卡描述成“高优先级、持续生效的世界线事件”，要求 agent 先回应、再在后续轮次持续体现影响，而不是把它当普通补充说明
- **L2向量记忆**:
  - `store_memory(scenario_id, agent_name, content)` — 写入 ChromaDB（fire-and-forget）
  - `retrieve_relevant_memories(scenario_id, query, top_k)` → 格式化 Top-K 语义相关记忆

### `vector_store.py` (≈170行) — ChromaDB 向量存储 (**NEW**)
- **职责**: L2 层语义记忆检索，跨 session 记忆存储与检索
- **关键API**:
  - `VectorStore.store(scenario_id, agent_name, content, ...)` — 存入 ChromaDB
  - `VectorStore.retrieve(scenario_id, query_text, top_k)` → `list[dict]` — 余弦相似度检索
  - `VectorStore.health_check()` — 连通性检查
- **设计**: 按 scenario_id 分 collection，全局单例，ChromaDB 不可用时静默降级

### `llm_client.py` (≈270行) — LLM调用封装
- **职责**: httpx异步调用OpenAI兼容API
- **关键函数**:
  - `llm_call(prompt, reasoning_effort, api_key?, base_url?)` → `str`
  - `llm_call_json(prompt, reasoning_effort, api_key?, base_url?)` → `dict`
  - `llm_call_stream(...)` — SSE 流式异步生成器
  - `llm_call_json_stream(...)` — 流式 + JSON 解析
  - `health_check()` — 连通性检查
- **特性**: 支持 Chat Completions 和 Responses API 两种格式
- **指数退避重试** (P1-3): 对 429/5xx 错误自动重试 3 次，退避间隔 1s→2s→4s
- **JSON 容错**:
  - `_clean_json_text` 会先剥掉 markdown code fence、前后缀和非法控制字符
  - `llm_call_json()` 在常规 `json.loads()` 失败后，会依次尝试：
    - 正则抽取对象 / 数组
    - keyed fallback（恢复轻微损坏的 `story/content/emotion/diverge` 这类键值）
    - `agent_message` 专用 fallback（把带键的坏 JSON 或纯文本尽量恢复成单条 agent 发言）
- **BYOK (P4-E)**: 所有函数接受 `api_key`/`base_url`/`model` 可选覆盖，用户可自带 OpenAI 兼容 API Key；API Key 仅内存传递不持久化

### `parser.py` (≈200行) — 问题解析
- **职责**: 将用户问题解析为结构化场景上下文
- **输出**: `{era, setting, question, agents[], total_rounds, fork_sensitivity}`
- **启动策略**: 解析阶段固定使用 `reasoning_effort="low"`，优先缩短 Theater 首次可见世界线前的等待窗口
- **语言检测** (P9): 调用 `lang_detect.detect_language()` 检测输入语言，存入 `result["_language"]` 供下游服务使用
- **分层模式** (P3-A): `PARSE_PROMPT_HIERARCHICAL` 生成 `groups[]` 分组信息，含 fallback 自动分组逻辑
- **BYOK**: 接受 `api_key`/`base_url`/`model` 覆盖并透传到 `llm_call_json`

### `lang_detect.py` (≈70行) — 语言检测 (P9 **NEW**)
- **职责**: 基于字符比例启发式检测用户输入语言，生成 LLM prompt 语言指令
- **关键函数**:
  - `detect_language(text)` → `str` — 返回 "Chinese"/"English"/"Japanese"/"Korean"，字符比例启发式，无外部依赖
  - `get_language_directive(language)` → `str` — 生成 prompt 注入的多语言指令文本
- **覆盖范围**: CJK 统一表意文字、日文假名（平假名+片假名）、韩文谚文
- **防护**: 空输入默认 English；不计入全角Latin/数字避免误判
- **集成点**: `parser.py` (检测)、`simulator.py`/`memory.py`/`narrator.py`/`scoring.py` (指令注入)

### Visualization 模块 (`app/visualization/`) — Phase 1+2 像素化可视化层
- **职责**: 将模拟事件映射为前端 Phaser.js 场景指令，实现像素风可视化
- **模块组成**:
  - `events.py` (≈60行) — `VizEventType` 枚举 (9 种事件类型，含 `WEATHER_CHANGE`) + `make_viz_event()` 工厂函数
  - `mapper.py` (≈300行) — `VisualizationMapper` 类，8 个 `map_*` 方法（agent_speak、stance_move、branch_split、intervention、emotion_change、scene_change、ending、**weather_change**）；stance 参数统一 clamp [-1, 1]
  - `persona_mapper.py` (≈130行) — `assign_sprite()`/`assign_sprites_batch()`/`assign_position()` — 角色→精灵分配 + 坐标计算；total_agents ≤ 0 守卫 + stance clamp [-1, 1]
  - `scene_selector.py` — `select_scene(question)` / `select_scene(era=, setting=)` 双签名；当前已扩到 26 个语义场景主题，优先扫描原始 `question`，再回退到 parser 的 `era/setting`，避免泛化词压过更贴题的场景语义
  - `card_events.py` (≈120行) — `check_card_trigger()`/`get_card_viz_event()` — 卡牌事件触发 + 冷却 + 加权随机（单候选安全回退）
- **集成点**: `simulator.py` (调用 `assign_sprites_batch`/`assign_position`) → WebSocket (`viz:*` 事件) → 前端 `EventBridge.ts` → Phaser `WorldScene.ts`
- **测试覆盖**: `test_simulator_viz_integration.py` 覆盖 scene reachability、ending type 3级映射、Worker viz 事件和全流程 smoke

### `narrator.py` (≈50行) — 叙事生成
- **职责**: 为已完成的分支生成故事总结和洞察
- **输出**: `{title, story, insight, key_moments[]}`
- **返回值归一化**: narrator 现在会容忍 `llm_call_json()` 返回 `list[dict]` 或字符串列表，优先提取第一条可用叙事，避免再因 `list` 没有 `.get()` 把整局场景打进 `error`

### `scoring.py` (≈200行) — 预测评分 (P3-B **NEW**)
- **职责**: LLM 对比用户预测与模拟实际结果，给出 0-100 准确度评分
- **关键函数**:
  - `score_prediction(prediction_id)` — 评估单条预测，自动读取场景 `_language` 匹配输出语言
  - `score_all_for_scenario(scenario_id)` — 批量评分场景所有未评预测
  - `_update_leaderboard(session, user_id, user_name, score)` — 更新排行榜物化视图

## API层 (`app/api/`) — P0-1 拆分

> **重构 (P0-1)**: 原 `scenarios.py` (≈600行) 拆分为 5 个模块：
> - `scenarios.py` — 核心 CRUD 路由
> - `schemas.py` — Pydantic 请求/响应模型
> - `helpers.py` — 后台任务管理、工具函数 (`_background_tasks` set)
> - `interventions.py` — 干预路由（标准/回溯/批量）
> - `social.py` — 社交媒体文案路由 (P6)

### `scenarios.py` — 核心 REST 路由
| 端点 | 方法 | 描述 |
|------|------|------|
| `POST /scenario` | POST | 创建场景（含 `num_agents`, `mode`, `visualization_enabled` 参数），立即返回 `simulating` 占位场景；若启用 Theater，会同步返回 `scene_theme` 与一条 provisional root branch，后台继续 parse + simulate |
| `GET /scenario/{id}` | GET | 获取场景详情；响应包含 `visualization_enabled` 与 `scene_theme`，供前端直开 `/sim/:id` 时恢复 Theater 状态；前端玩法系统（结构化下注/玩法卡/档案/每日挑战）仍复用现有场景与 prediction/intervention API，不要求新增后端 schema |
| `GET /scenario/{id}/branches` | GET | 获取分支列表 |
| `GET /scenario/{id}/agents` | GET | 获取agent列表（含 group_id, group_name） |
| `GET /scenario/{id}/story` | GET | 获取叙事结果；若尚无 completed branches，会回退返回该场景现有 branches，并为根分支补 placeholder title |
| `GET /scenario/{id}/groups` | GET | 获取分层分组信息 (P3-A) |
| `GET /scenarios` | GET | 场景列表（分页+状态筛选，JOIN优化 P0-2）(P4-A) |
| `DELETE /scenario/{id}` | DELETE | 删除场景（批量 SQL DELETE P2-7 + Leaderboard + ChromaDB 清理）(P4-A) |
| `GET /scenario/{id}/export` | GET | 导出场景 Markdown (P4-C) |
| `GET /intervention-templates` | GET | 干预模板列表 (P4-D) |

### `interventions.py` — 干预路由
| 端点 | 方法 | 描述 |
|------|------|------|
| `POST /scenarios/{id}/intervene` | POST | 注入蝴蝶效应干预（文本上限 2000 字符） |
| `POST /scenarios/{id}/intervene/retrospective` | POST | 回溯干预（回到第N轮重新推演） |
| `POST /scenarios/{id}/intervene/batch` | POST | 多点干预（同时注入多个分支） |

### `social.py` — 社交媒体文案路由 (P6)
| 端点 | 方法 | 描述 |
|------|------|------|
| `GET /scenario/{id}/social/{platform}` | GET | 生成社交媒体文案 — 支持小红书/微博/知乎/Reddit/X |

**安全防护**:
- 防重入锁 (`_running_simulations`) 阻止同一场景重复启动
- 总模拟超时 `MAX_ROUNDS × 180s`
- 删除校验拒绝非终态场景（PARSING / NARRATING）

### `predictions.py` — 预测与排行榜路由 (P3-B **NEW**)
| 端点 | 方法 | 描述 |
|------|------|------|
| `POST /scenario/{id}/predict` | POST | 提交预测（模拟完成前） |
| `GET /scenario/{id}/predictions` | GET | 列出场景所有预测 |
| `POST /scenario/{id}/score-predictions` | POST | 触发 LLM 评分 |
| `GET /leaderboard` | GET | 全局预测排行榜 |

### `ws.py` — WebSocket路由
- `WS /ws/{scenario_id}` — 实时事件流
- **事件类型**: `status`, `agent_speak_start`, `agent_speak_delta`, `agent_speak`, `round_summary`, `branch_fork`, `branch_prune`, `narration`, `intervention_applied`, `intervention_injected`, `retrospective_start`, `batch_intervention_applied`, `simulation_done`, `simulation_error`

## 模型层 (`app/models/`)

### SQLModel 实体
| 模型 | 主要字段 | 关系 |
|------|----------|------|
| `Scenario` | id, question, status, context_json | has_many: agents, branches |
| `Agent` | id, name, role, persona, tier, stance, emotion | belongs_to: scenario |
| `Branch` | id, parent_branch_id, title, description, probability, status | has_many: rounds; self-referential tree |
| `Round` | id, number, compressed_summary | has_many: messages |
| `Message` | id, content, emotion, diverge_score | belongs_to: round, agent |
| `InterventionLog` | id, branch_id, round_number, text | belongs_to: branch |
| `AgentGroup` | id, scenario_id, name, leader_agent_id, member_count | belongs_to: scenario (P3-A) |
| `AgentGroupMember` | id, group_id, agent_id, is_leader | belongs_to: group, agent (P3-A) |
| `Prediction` | id, scenario_id, user_id, prediction_text, confidence, score | belongs_to: scenario (P3-B) |
| `Leaderboard` | id, user_id, user_name, avg_score, best_score, win_streak | per-user materialized (P3-B) |

## 测试覆盖

本轮已验证的场景/可视化定向回归为 **201 passed**。

覆盖重心：

- REST / Story / Scenario 生命周期：
  - `test_api.py`
  - 覆盖创建场景最小占位态、导出、模板、`/story` fallback 等
- 模拟与可视化集成：
  - `test_simulator.py`
  - `test_simulator_viz_integration.py`
  - `test_visualization_mapper.py`
  - `test_visualization_events.py`
  - `test_scene_selector.py`
- 记忆 / 黑板 / 向量存储：
  - `test_memory.py`
  - `test_blackboard.py`
  - `test_blackboard_bench.py`
  - `test_vector_store.py`
- 干预 / 分层代理 / 预测 / 排行榜 / WebSocket：
  - `test_intervention.py`
  - `test_agent_group.py`
  - `test_predictions.py`
  - `test_ws.py`
- 语言、配置、模型与边界回归：
  - `test_lang_detect.py`
  - `test_models.py`
  - `test_config.py`
  - `test_corner_cases.py`
  - `test_token_matrix.py`
  - `test_parser.py`

> **注**: `benchmark_compression.py` 为离线压缩质量标尺，不计入主回归套件。
