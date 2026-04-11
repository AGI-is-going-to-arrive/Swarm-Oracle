# REST + WebSocket API 参考

> 作用：提供当前稳定接口地图与关键约束。字段细节和完整 schema 以 `backend/app/api/*.py`、Pydantic model 与测试为准。

## 通用约定

### Base URL

- REST：后端服务根地址，例如 `http://localhost:18927`
- WebSocket：同主机的 `ws://` 或 `wss://`

### 业务错误形状

项目自定义业务错误统一收口为：

```json
{
  "detail": {
    "code": "SOME_ERROR_CODE",
    "message": "Human-readable message"
  }
}
```

说明：

- 路由层未显式处理的异常，会统一收口为 `INTERNAL_ERROR`。
- FastAPI/Pydantic 原生 `422` 仍保持框架默认形状。

## Scenarios

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/scenario` | 创建 scenario 并启动后台模拟 |
| `GET` | `/api/scenario/{scenario_id}` | 获取 scenario 详情 |
| `GET` | `/api/scenario/{scenario_id}/branches` | 获取 branch 列表 |
| `GET` | `/api/scenario/{scenario_id}/agents` | 获取 agent 列表 |
| `GET` | `/api/scenario/{scenario_id}/groups` | 获取分层分组信息 |
| `GET` | `/api/scenario/{scenario_id}/story` | 获取叙事结果 |
| `GET` | `/api/scenarios` | 分页列出 scenario |
| `DELETE` | `/api/scenario/{scenario_id}` | 级联删除 scenario 与关联数据 |
| `POST` | `/api/scenario/import-replay` | 把 replay 快照导入为本地 scenario |

关键约束：

- `GET /api/scenario/{scenario_id}` 会在读取前尽量收敛 stale `simulating/narrating` 状态。
- `POST /api/scenario` 当前也接受可选 `continuity_overrides`：
  - 前端通常先调用 `POST /api/agents/identities/preflight`
  - `reuse_existing` 需要带 `identity_id`，后端会校验它属于当前 `user_id`
  - `create_new` 会让真正的 identity 解析跳过 L2 fuzzy reuse
- 删除 scenario 时会一并清理 replay、prediction、campaign side effect、ending-room 与向量数据。

## Replay Artifact

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/replay-artifact` | 持久化 replay payload，返回短 `share id` |
| `GET` | `/api/replay-artifact/{artifact_id}` | 读取 replay payload |

说明：

- 主模式与 replay 页面优先使用 artifact 短链。
- 常见业务错误包括：`REPLAY_ARTIFACT_PAYLOAD_INVALID`、`REPLAY_ARTIFACT_PAYLOAD_TOO_LARGE`、`REPLAY_ARTIFACT_NOT_FOUND`。

## Interventions

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/scenario/{scenario_id}/intervene` | 即时干预；也承载正式玩法卡注入 |
| `POST` | `/api/scenario/{scenario_id}/intervene/retrospective` | 回溯干预 |
| `POST` | `/api/scenario/{scenario_id}/intervene/batch` | 批量干预 |
| `GET` | `/api/intervention-templates` | 干预模板列表 |

关键约束：

- 正式玩法卡仍走 `intervene`，但 authority、冷却与 director points 在后端校验并落库。
- `InterveneRequest.text` 和 `RetrospectiveInterveneRequest.text` 上限 2000 字符（strip 后计算），空文本返回 422。
- 当多个 backend worker 共用同一个 SQLite 文件时，待处理干预会进入共享 pending queue。

## Campaign Authority

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/campaign/profile/{user_id}` | profile |
| `GET` | `/api/campaign/profile/{user_id}/mastery` | mastery |
| `GET` | `/api/campaign/profile/{user_id}/badges` | badges |
| `GET` | `/api/campaign/profile/{user_id}/daily-status` | daily status |
| `GET` | `/api/campaign/profile/{user_id}/weekly-summary` | weekly summary |
| `GET/PUT` | `/api/campaign/scenario/{scenario_id}/director-state` | 主模式 director authority |
| `GET/PUT` | `/api/campaign/scenario/{scenario_id}/gameplay-state` | 主模式 gameplay authority |
| `GET` | `/api/campaign/scenario/{scenario_id}/summary` | scenario campaign summary |
| `POST` | `/api/campaign/scenario/{scenario_id}/finalize` | 结算 campaign 结果 |

关键约束：

- `director-state` 与 `gameplay-state` 的写入都使用 `revision` 乐观并发控制。
- 前端命中 stale 写入时应先回读最新 authority，再决定是否重试。
- `gameplay-state` 采用分区级 authority：
  - 后端只要显式返回 `cards.usage_log`、`betting.bets`、`archive.key_moments`、`archive.branch_snapshots`，即使为空数组，也表示该分区 authoritative empty。
  - 前端不得再用本地缓存把该分区的旧数据补回去。

## Predictions

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/scenario/{scenario_id}/predict` | 提交 prediction |
| `GET` | `/api/scenario/{scenario_id}/predictions` | 列出 scenario predictions |
| `POST` | `/api/scenario/{scenario_id}/score-predictions` | 触发评分 |
| `GET` | `/api/leaderboard` | 获取 leaderboard |

关键约束：

- 同一 `scenario_id + user_id` 只能提交一条 prediction。
- `PredictRequest` 的 `user_id` 和 `user_name` 上限 128 字符。
- `score-predictions` 支持 request-scoped provider policy。

## Social / Export / Health

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET/POST` | `/api/scenario/{scenario_id}/social/{platform}` | 生成社交文案 |
| `GET` | `/api/scenario/{scenario_id}/export` | 导出 Markdown |
| `POST` | `/api/health` | 后端健康检查 |
| `POST` | `/api/health/test` | provider 探测与预算预检 |
| `GET` | `/api/capabilities` | 轻量配置探测（无 LLM 调用），返回 7-key capability registry (web_search + 6 Phase 3 功能开关) |
| `GET` | `/` | 根信息 |
| `GET` | `/metrics` | Prometheus 文本指标 |

关键约束：

- provider overrides 只能通过 `POST body` 传入，不能放在社交文案 `GET query` 中。
- `export` 通过附件下载返回 Markdown 文件。

## Debate

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/debate` | 创建 debate |
| `GET` | `/api/debate/{debate_id}` | live snapshot |
| `GET` | `/api/debate/{debate_id}/result` | result payload |
| `POST` | `/api/debate/{debate_id}/predict` | 提交 counterplay/prediction |
| `POST` | `/api/debate/import-replay` | 导入 replay 为本地 debate |
| `GET` | `/api/debate/{debate_id}/argument-map` | 论证图谱 (Phase 3 F6)，受 `FEATURE_ARGUMENT_MAP` gate |

说明：

- Debate 是独立域，不与主模式复用 scenario authority。
- replay import 会保留 imported `phase_insights` 与 `adjudication_mode`。

## Phase 3 — Agents / Graphs

| 方法 | 路径 | 说明 | 开关 |
|------|------|------|------|
| `GET` | `/api/agents/identities` | Agent 身份列表 | `FEATURE_CUSTOM_AGENTS` 或 `FEATURE_AGENT_IDENTITY` |
| `POST` | `/api/agents/identities/preflight` | 创建 scenario 前预览 continuity 匹配 | `FEATURE_AGENT_IDENTITY` |
| `GET` | `/api/agents/identities/{id}/memory` | 跨场景记忆 | `FEATURE_AGENT_IDENTITY` |
| `POST` | `/api/agents/workshop` | 创建自建 Agent | `FEATURE_CUSTOM_AGENTS` |
| `PUT` | `/api/agents/workshop/{id}` | 更新自建 Agent | `FEATURE_CUSTOM_AGENTS` |
| `DELETE` | `/api/agents/workshop/{id}` | 删除自建 Agent | `FEATURE_CUSTOM_AGENTS` |
| `GET` | `/api/scenario/{id}/causal-graph` | 因果图谱 | `FEATURE_CAUSAL_GRAPH` |
| `POST` | `/api/scenario/{id}/counterfactual` | 创建反事实分支 | `FEATURE_COUNTERFACTUAL_REPLAY` |
| `GET` | `/api/scenario/{id}/compare` | 分支对比 | `FEATURE_COUNTERFACTUAL_REPLAY` |
| `GET` | `/api/scenario/{id}/checkpoints` | 检查点列表 | `FEATURE_COUNTERFACTUAL_REPLAY` |
| `GET` | `/api/scenario/{id}/faction-timeline` | 阵营时间线 | `FEATURE_FACTIONS` |

说明：

- 所有 Phase 3 endpoint 在对应 `FEATURE_*=false` 时返回 404，不执行任何业务逻辑。
- `POST /api/agents/identities/preflight` 当前只返回需要 L3 确认的 `L2 fuzzy candidate`；`L1 exact` 和全新 identity 不会阻断前端启动。
- 前端通过 `GET /api/capabilities` 检测 `enabled` 字段，disabled 时隐藏入口且不发请求。

## Ending Room / Worldline Roundtable

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/scenario/{scenario_id}/ending-room` | 创建或复用 room |
| `GET` | `/api/ending-room/{room_id}` | room snapshot |
| `GET` | `/api/ending-room/{room_id}/result` | room result payload |
| `POST` | `/api/ending-room/{room_id}/thread` | 创建 follow-up thread |
| `GET` | `/api/ending-room/thread/{thread_id}` | 读取 thread snapshot |
| `POST` | `/api/ending-room/{room_id}/user-turn` | room 级追问 |
| `POST` | `/api/ending-room/thread/{thread_id}/user-turn` | thread 级追问 |

关键约束：

- `ending_room` 是独立域，room/thread memory partition 隔离。
- `crossline_gallery` 是只读摘要视图，不会开启可写 follow-up。
- 请求体列表字段有大小上限（`selected_branch_ids / selected_agent_ids` ≤ 50，`addressed_agent_ids / question_anchor_ids` ≤ 20），超出会返回 Pydantic 422。
- 用户追问 `content` 上限 5000 字符，线程 `title` 上限 500 字符。
- `POST /api/ending-room/{room_id}/thread`
  当前也接受 `question_anchor_ids`，用于显式记录 thread 是由哪个 `quote / verdict / key_moment / phase` 发起。
- `POST /api/ending-room/{room_id}/user-turn` 与 `POST /api/ending-room/thread/{thread_id}/user-turn`
  当前都接受 `question_anchor_ids`。
  当前还接受可选字段 `cited_branch_id`（引用另一条世界线）和 `cited_refs_json`（引用元数据，上限 4 KB）。
  当 `cited_branch_id` 存在时，后端会验证它属于同一 scenario，验证失败则静默忽略。
  当 `interaction_mode` 未指定但 `cited_branch_id` 存在时，自动使用 `evidence_card` 模式。
- `EndingRoomInteractionMode` 当前支持：
  `auto_recap / archivist_route / hotseat / all_present / thread_followup / epilogue / evidence_card`。
  - `epilogue`：后续三回合短叙事推演。
  - `evidence_card`：引入另一条世界线的摘要卡。
  - `epilogue` 与 `evidence_card` 在 `crossline_gallery` 下不可用。
- `GET /api/ending-room/thread/{thread_id}` 与 room/result snapshot 里的 turn 数据
  当前都会回显：
  - `question_anchor_ids_json`
  - 便于 replay/read-only 恢复与自动化验证锚点语义。

## WebSocket

| 协议 | 路径 | 说明 |
|------|------|------|
| `WS` | `/ws/scenario/{scenario_id}` | 主模式 live 事件 |
| `WS` | `/ws/debate/{debate_id}` | Debate live 事件 |
| `WS` | `/ws/ending-room/{room_id}` | Ending room / roundtable 事件 |
| `WS` | `/api/ws/ending-room/{room_id}` | ending-room WS alias |

说明：

- scenario / debate live 事件都会带 `meta`，前端按 `sequence / event_id` 去重。
- 空闲期会发送轻量 `heartbeat`。
- `X-Session-Token` 只用于 REST。
- 当 `SESSION_SECRET` 非空时，ending-room / scenario / debate 的 WS 都继续走首帧 auth 协议，不依赖 HTTP-style dependency 注入。

## 源码入口

- `CreateScenarioRequest.user_id` 上限 128 字符。
- `CreateReplayArtifactRequest.kind` 上限 64 字符，不能为空。
- `/docs`、`/redoc`、`/openapi.json` 默认不暴露，需设置 `EXPOSE_API_DOCS=true`。
- 路由：`backend/app/api/*.py`
- schema：`backend/app/api/schemas.py`
- 运行时逻辑：`backend/app/services/*.py`
