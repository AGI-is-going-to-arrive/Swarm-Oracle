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
    │       ├── scene_selector.py (双签名 → 30 场景语义池；原始题面优先，含 `law_court_variant` / `faith_temple_variant` / `switchboard_forum_variant`)
    │       └── card_events.py (卡牌事件触发 + 可视化映射；卡牌定义由 `services/gameplay_contract.py` 装载 shared contract)
    │
api/campaign.py ──► services/campaign.py (Track A / Phase A1 + A3 daily-status)
    │
api/debate.py ──► services/debate.py / debate_prompts.py / debate_scoring.py (Track D)
    │
api/predictions.py ──► services/scoring.py (P3-B)
    │
api/ws.py ──► WebSocket Manager (内联)
    │
main.py ──► 汇总挂载 scenarios / interventions / social / campaign / predictions / ws routers + `GET /` 根信息端点
    │
models/database.py ──► SQLModel (Scenario, Agent, Branch, Round, Message, InterventionLog)
models/agent_group.py ──► AgentGroup, AgentGroupMember (P3-A)
models/campaign.py ──► DirectorProfile, ProfileMastery, DirectorBadgeUnlock, ScenarioCampaignLog
models/debate.py ──► Debate, DebateTurn, DebatePrediction, DebateCounterplay
models/predictions.py ──► Prediction, Leaderboard (P3-B)
config.py ──► pydantic-settings (Settings singleton；默认 `.env` / SQLite / Chroma 路径都锚到 `backend/` 根目录)
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

### `gameplay_contract.py` (≈15行) — shared gameplay contract 载入器 (**NEW**)
- **职责**: 从 `shared/gameplay_contract.v1.json` 读取后端与前端共用的玩法契约
- **关键API**:
  - `load_gameplay_contract()` → `dict[str, Any]` — `lru_cache(maxsize=1)` 缓存 contract JSON
- **集成点**: `visualization/card_events.py` 启动时据此构建 `CARD_TYPES`，后端测试 `test_gameplay_contract_sync.py` 会校验卡牌 ID 与触发模式和 shared contract 保持一致

### `llm_client.py` (≈270行) — LLM调用封装
- **职责**: httpx异步调用OpenAI兼容API
- **关键函数**:
  - `llm_call(prompt, reasoning_effort, api_key?, base_url?)` → `str`
  - `llm_call_json(prompt, reasoning_effort, api_key?, base_url?)` → `dict`
  - `llm_call_stream(...)` — SSE 流式异步生成器
  - `llm_call_json_stream(...)` — 流式 + JSON 解析
  - `health_check()` — 连通性检查
- **特性**: 支持 Chat Completions 和 Responses API 两种格式
- **指数退避重试** (P1-3): 对 429/5xx 错误自动重试 3 次，退避间隔 1s→2s→4s；当前实现直接复用模块级 `asyncio`，5xx 重试路径不会再触发本地 `UnboundLocalError`
- **JSON 容错**:
  - `_clean_json_text` 会先剥掉 markdown code fence、前后缀和非法控制字符
  - `llm_call_json()` 在常规 `json.loads()` 失败后，会依次尝试：
    - 正则抽取对象 / 数组
    - keyed fallback（恢复轻微损坏的 `story/content/emotion/diverge` 这类键值）
    - `agent_message` 专用 fallback（把带键的坏 JSON 或纯文本尽量恢复成单条 agent 发言）
- **BYOK (P4-E)**: 所有函数接受 `api_key`/`base_url`/`model` 可选覆盖，用户可自带 OpenAI 兼容 API Key；API Key 仅内存传递不持久化
- **容器部署提示**: 如果后端在 Docker 容器内运行而 LLM 服务在宿主机本地，`LLM_RESPONSES_URL` 需要改为 `host.docker.internal` 或其他宿主可达地址；`POST /api/health` 会同步探测 LLM，因此容器健康检查现改用 `GET /`

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
  - `scene_selector.py` — `select_scene(question)` / `select_scene(era=, setting=)` 双签名；当前已扩到 30 个语义场景主题，优先扫描原始 `question`，再回退到 parser 的 `era/setting`，避免泛化词压过更贴题的场景语义；generic / law / faith 已补进 `switchboard_forum_variant / law_court_variant / faith_temple_variant`
  - `card_events.py` (≈120行) — `check_card_trigger()`/`get_card_viz_event()` — 卡牌事件触发 + 冷却 + 加权随机（单候选安全回退）
- **集成点**: `simulator.py` (调用 `assign_sprites_batch`/`assign_position`) → WebSocket (`viz:*` 事件) → 前端 `EventBridge.ts` → Phaser `WorldScene.ts`
- **测试覆盖**: `test_simulator_viz_integration.py` 覆盖 scene reachability、ending type 3级映射、Worker viz 事件和全流程 smoke

### `narrator.py` (≈50行) — 叙事生成
- **职责**: 为已完成的分支生成故事总结和洞察
- **输出**: `{title, story, insight, key_moments[]}`
- **返回值归一化**: narrator 现在会容忍 `llm_call_json()` 返回 `list[dict]` 或字符串列表，优先提取第一条可用叙事，避免再因 `list` 没有 `.get()` 把整局场景打进 `error`

### `campaign.py` (≈330行) — Campaign 进度服务 (**NEW**)
- **职责**: 管理导演 campaign 进度结算、档案积分、题材 mastery 与 badge 解锁
- **关键函数**:
  - `finalize_scenario_campaign(...)` — 对已完成 scenario 做一次性结算；同一 scenario 对同一导演幂等，若绑定到不同导演则抛 `CampaignConflictError`
  - `calculate_campaign_score_delta(...)` — 按 archive grade / profile resonance / bet / daily challenge 规则计算积分增量
  - `get_scenario_campaign_summary(scenario_id)` — 读取单局已落库的 campaign 摘要；供 `ResultView` 在本地档案缺失时回填关键字段
  - `get_campaign_profile_summary(user_id)` — 读取导演总览
  - `list_campaign_mastery_summaries(user_id)` — 按 `campaign_score` 列出题材 mastery
  - `list_campaign_badge_summaries(user_id)` — 列出已解锁 badge
  - `get_daily_challenge_summary(user_id, profile_id, local_date, timezone_offset_minutes)` — 返回指定题材在调用方本地日期上的 daily challenge 完成态
- **数据写入**: 会更新 `DirectorProfile`、`ProfileMastery`，并写入不可变的 `ScenarioCampaignLog`
- **档案摘要**: profile summary 现会带 `last_daily_challenge_completed_at / profile_id / scenario_id`，供首页把后端真值与本地缓存合并显示
- **单局摘要**: scenario summary 会返回 `profile_id / archive_grade / profile_resonance / betting_hit / most_used_card / completed_daily_challenge / campaign_score_delta / finalized_at`
- **时区归一**: `daily-status` 查询现在会把 SQLite round-trip 回来的 naive UTC 时间先按 UTC 归一，再换算调用方本地日期，避免跨时区同日完成态误判
- **时间序列化**: `profile / mastery / badges / daily-status` 响应里的时间字段统一输出带 `+00:00` 的 UTC ISO 字符串
- **空导演容错**: `profile / mastery / badges / daily-status` 读接口现在会给新设备返回空摘要或 `completed=false`，避免首页首次加载就打 404 噪声
- **防护**: 只接受 `ScenarioStatus.DONE` 的场景；对并发 finalize 通过 `IntegrityError` 回退到已存在日志，保持幂等返回

### `debate.py` / `debate_prompts.py` / `debate_scoring.py` — Debate Arena 领域服务 (**NEW**)
- **职责**:
  - `debate.py`：独立 Debate Arena 运行、turn 落库、verdict 结算、prediction 评分、counterplay 显式 payload
  - `debate_prompts.py`：deterministic motion / cast / turn 文案与题材→场景映射
  - `debate_scoring.py`：winner / verdict tone / breakdown / phase delta 规划
- **关键行为**:
  - Debate 不复用通用 `scenario` 链路，而是独立走 `Debate / DebateTurn / DebatePrediction / DebateCounterplay`
  - 当前固定 5 个阶段：`opening / crossfire / rebuttal / closing / verdict`
  - prediction 只支持 `winner` 与 `verdict_tone`
  - `counterplay` 当前已提升成 Debate 域内的显式记录：提交时会同时写 `DebatePrediction + DebateCounterplay`，live snapshot / result payload / WS 会优先读独立 `DebateCounterplay`，仅在缺失时回退到旧的 prediction metadata
  - `debate_prompts.py` 现在不再只是换 profile 标签：`law / governance / trade / faith / ecology / war` 都有各自 deterministic 辩风文案
  - `debate_scoring.py` 会按题材做轻量维度偏置；`war / ecology` 在高风险题面更容易收敛到 `rupture`
  - Track D 的 `profile -> scene_theme` 已改为 Debate 专属背景：`debate_arena_civic / debate_arena_judicial / debate_arena_forum`
  - Debate 结果会自动给已提交的 prediction 打分，不要求另开批量评分接口

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
| `POST /api/scenarios/{id}/intervene/batch` | POST | 多点干预（同时注入多个分支） |

### `social.py` — 社交媒体文案路由 (P6)
| 端点 | 方法 | 描述 |
|------|------|------|
| `GET /api/scenario/{id}/social/{platform}` | GET | 生成社交媒体文案 — 支持小红书/微博/知乎/Reddit/X |

### `campaign.py` — Campaign 路由 (Track A / Phase A1 **NEW**)
| 端点 | 方法 | 描述 |
|------|------|------|
| `GET /api/campaign/scenario/{scenario_id}/summary` | GET | 读取单局 campaign 摘要；若该 scenario 尚未 finalize，则返回 `404` |
| `GET /api/campaign/profile/{user_id}` | GET | 获取导演 campaign 总览 |
| `GET /api/campaign/profile/{user_id}/mastery` | GET | 获取该导演的题材 mastery 列表 |
| `GET /api/campaign/profile/{user_id}/badges` | GET | 获取已解锁 badge 列表 |
| `GET /api/campaign/profile/{user_id}/daily-status` | GET | 获取某个题材在调用方本地日期上的 daily challenge 完成态；内部会先把 SQLite round-trip 的 naive UTC 时间按 UTC 归一后再做本地日期换算 |
| `POST /api/campaign/scenario/{scenario_id}/finalize` | POST | 对已完成 scenario 做 campaign 结算，返回积分增量、profile、mastery 与 badge 结果 |

> 读接口边界已按当前代码更新：若导演档案尚不存在，`profile` 返回空摘要，`mastery / badges` 返回空数组，`daily-status` 返回 `completed = false`；首页不再因为新用户首次进入而打 404。`scenario/{id}/summary` 只在该局已有 campaign log 时返回结果，否则给 `404`。`daily-status` 的 `completed_at` 当前返回 UTC ISO 字符串。

**安全防护**:
- 防重入锁 (`_running_simulations`) 阻止同一场景重复启动
- 总模拟超时 `MAX_ROUNDS × 180s`
- 删除校验拒绝非终态场景（PARSING / NARRATING）

### `predictions.py` — 预测与排行榜路由 (P3-B **NEW**)
| 端点 | 方法 | 描述 |
|------|------|------|
| `POST /api/scenario/{id}/predict` | POST | 提交预测（模拟完成前） |
| `GET /api/scenario/{id}/predictions` | GET | 列出场景所有预测 |
| `POST /api/scenario/{id}/score-predictions` | POST | 触发 LLM 评分 |
| `GET /api/leaderboard` | GET | 全局预测排行榜 |

### `debate.py` — Debate Arena 路由 (Track D **NEW**)
| 端点 | 方法 | 描述 |
|------|------|------|
| `POST /api/debate` | POST | 创建独立 Debate Arena；立即返回 live snapshot，并把后台阶段推进交给独立 debate worker；当前会保留约 `5s` pre-roll 供前端进入 live 页并完成下注 |
| `GET /api/debate/{id}` | GET | 获取 debate live snapshot（participants / score / turns / prediction options）；当前顶层会显式带可选 `counterplay` |
| `GET /api/debate/{id}/result` | GET | 获取 verdict 完整结果（winner / breakdown / replay digest / predictions）；当前顶层也会显式带 `counterplay`；未就绪时返回 `409`，`ERROR` 终态返回 `500` |
| `POST /api/debate/{id}/predict` | POST | 提交结构化押注（`winner` 或 `verdict_tone`）；`closing / verdict` 阶段会拒绝新押注；当 `is_counterplay = true` 时，会同时写入 `DebatePrediction` 与独立 `DebateCounterplay` 记录 |

### `ws.py` — WebSocket路由
- `WS /ws/scenario/{scenario_id}` — 实时事件流
- **事件类型**: `status`, `agent_speak_start`, `agent_speak_delta`, `agent_speak`, `round_summary`, `branch_fork`, `branch_prune`, `narration`, `intervention_applied`, `intervention_injected`, `retrospective_start`, `batch_intervention_applied`, `simulation_done`, `simulation_error`
- `WS /ws/debate/{debate_id}` — Debate Arena 实时事件流
- **事件类型**:
  - `status`
  - `agent_speak`
  - `debate_phase_change`
  - `debate_score_update`
  - `debate_counterplay`
  - `debate_verdict`

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
| `DirectorProfile` | id, user_id, user_name, total_runs, completed_challenges, total_bets, hit_bets, highest_archive_grade | campaign 导演总档案 |
| `ProfileMastery` | id, director_profile_id, profile_id, runs, challenge_completions, signature_hits, aligned_hits, campaign_score, level | belongs_to: DirectorProfile |
| `DirectorBadgeUnlock` | id, director_profile_id, badge_id, unlocked_at, source_profile_id, source_scenario_id | belongs_to: DirectorProfile |
| `ScenarioCampaignLog` | id, scenario_id, director_profile_id, profile_id, archive_grade, profile_resonance, campaign_score_delta | 每局结算不可变日志 |
| `Debate` | id, question, motion, language, profile_id, scene_theme, status, current_phase, winner, verdict_tone | Debate Arena 主体 |
| `DebateTurn` | id, debate_id, sequence, phase, speaker_side, speaker_name, content, score_delta_json | belongs_to: Debate |
| `DebatePrediction` | id, debate_id, kind, target_value, confidence, score, is_counterplay, counterplay_phase, counterplay_variant | belongs_to: Debate |
| `DebateCounterplay` | id, debate_id, prediction_id, kind, target_value, confidence, phase, variant, outcome | belongs_to: Debate |
| `Prediction` | id, scenario_id, user_id, prediction_text, confidence, score | belongs_to: scenario (P3-B) |
| `Leaderboard` | id, user_id, user_name, avg_score, best_score, win_streak | per-user materialized (P3-B) |

## 测试覆盖

仓库内历史后端全量基线仍记录为 **815 passed**。本轮重新复验了 `test_debate_service.py / test_debate_api.py / test_config.py / test_campaign_api.py / test_campaign_service.py / test_predictions.py / test_card_events.py / test_gameplay_contract_sync.py`，结果为 **65 passed**；分别覆盖 Debate API/服务、prediction 评分、shared contract、`campaign scenario summary` 路由与 backend-root 路径归一。需要注意的是：`/metrics`、LLM retry/backoff 与 Alembic 迁移框架当前是“代码存在”，并非本轮已做完备运行验证。

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
- Campaign / shared contract 定向回归：
  - `test_campaign_api.py`
  - `test_campaign_service.py`
  - `test_config.py`
  - `test_gameplay_contract_sync.py`
  - 覆盖 `campaign` router / service 的 finalize 流程、幂等返回、`daily-status` 查询、`scenario summary` 路由、backend-root 路径归一，以及 `card_events.py` 与 `shared/gameplay_contract.v1.json` 的同步约束
- E2E 样本契约回归：
  - `test_e2e_sample_matrix.py`
  - 校验 `frontend/output/e2e/sample_matrix.json` 与 `sample_matrix_variants.json` 的 `scene_theme` 和当前 `select_scene(question)` 保持一致，避免旧样本主题漂移
- 测试夹具：
  - `tests/conftest.py`
  - 每个 pytest case 使用独立临时 SQLite 文件，并在前后显式 `dispose_engine()`，避免共享 `test_swarmoracle.db` 带来的 `readonly database / disk I/O / table already exists`
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
