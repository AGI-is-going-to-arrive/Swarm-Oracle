# Backend 模块地图

> 文档类型：L0 current-truth
> 作用：描述后端模块分工、authority 与运行时边界。详细实现以源码为准，历史验证流水不再写入本页。

## 技术栈

- FastAPI
- SQLModel + SQLite
- ChromaDB
- Alembic
- OpenAI-compatible LLM
- Prometheus 文本指标

## 模块地图

### 入口与路由

| 模块 | 位置 | 责任 |
|------|------|------|
| App 入口 | `backend/app/main.py` | 挂载所有 router、根信息、`/metrics` |
| Scenarios | `backend/app/api/scenarios.py` | scenario 创建、查询、列表、删除、story、replay artifact |
| Interventions | `backend/app/api/interventions.py` | 即时 / 回溯 / 批量干预、模板 |
| Campaign | `backend/app/api/campaign.py` | director/gameplay authority、profile、mastery、badge、summary |
| Predictions | `backend/app/api/predictions.py` | scenario prediction、评分、leaderboard |
| Debate | `backend/app/api/debate.py` | debate live/result/import-replay/predict |
| Ending Room | `backend/app/api/ending_rooms.py` | ending-room room/result/thread/user-turn 与 WS |
| Scenario WS | `backend/app/api/ws.py` | 主模式 WebSocket |
| Social | `backend/app/api/social.py` | 社交文案与 Markdown 导出 |

### 服务层

| 模块 | 位置 | 责任 |
|------|------|------|
| Simulator | `backend/app/services/simulator.py` | scenario 主循环、fork、narration 编排 |
| Memory | `backend/app/services/memory.py` | L1 压缩、context 组装 |
| LLM Client | `backend/app/services/llm_client.py` | LLM 调用、并发控制、限流、熔断 |
| Vector Store | `backend/app/services/vector_store.py` | Chroma L2 记忆 |
| Ending Room Service | `backend/app/services/ending_room_service.py` | room/thread scope、follow-up、后台生成 |
| Scoring | `backend/app/services/scoring.py` | prediction 评分与 leaderboard 物化 |
| Runtime Lock | `backend/app/services/runtime_lock.py` | SQLite shared lease，防重入 |
| Gameplay Contract | `backend/app/services/gameplay_contract.py` | 读取共享玩法契约 |

### 数据模型

| 模块 | 位置 | 责任 |
|------|------|------|
| Core Models | `backend/app/models/database.py` | `Scenario`、`Branch`、`Round`、`Message`、`ReplayArtifact` 等 |
| Campaign Models | `backend/app/models/campaign.py` | director profile、mastery、badge、campaign log |
| Debate Models | `backend/app/models/debate.py` | debate、turn、prediction、counterplay |
| Ending Room Models | `backend/app/models/ending_room.py` | room、participant、thread、turn |
| Prediction Models | `backend/app/models/predictions.py` | prediction、leaderboard |

## 当前 authority

### 主模式

- `Scenario.director_state_json`
  主模式 director goals、risk/resource、commitment 的 authority。
- `Scenario.gameplay_state_json`
  玩法卡、押注、archive raw 的 authority。
- 这两块都通过 `campaign` 路由读写，并带 `revision` 乐观并发控制。

### Replay

- 短链 replay 通过 `ReplayArtifact` 持久化。
- 前端分享链路优先使用后端 artifact，失败时才回退本地 token。

### Ending Room

- `ending_room` 是独立域。
- room、thread、participant、turn 都在独立表中维护。
- room/thread transcript 与 memory partition 隔离，不与主模式消息链混用。
- `ending_room_turn.question_anchor_ids_json`
  当前已用于显式记录 `quote / verdict / key_moment / phase` 等锚点来源。
- `ending_room_thread.question_anchor_ids_json`
  当前也已成为真实字段，thread create 与后续 replay/read-only 恢复都能保留锚点语义。

## 运行时约束

- 主模式与 Debate 的后台任务都通过 `runtime_lock` 做跨 worker 防重入。
- `VectorStore` 读取默认按 branch 或 allowed-branch scope 收口，不再放宽到整个 scenario。
- `llm_client` 负责：
  - 进程内 semaphore
  - pending/quota 控制
  - circuit breaker
  - 共享 `httpx.AsyncClient`
- Oracle follow-up 的 stream support probe 当前复用 `llm_call_stream()`；`estimated_tokens` 预估已补回，不再因为 probe 自身变量缺失而误触发 fallback。
- 当多个 backend worker 共用同一个 SQLite 文件时：
  - pending/quota 共享计数会生效
  - runtime lock 会跨进程共享

## WebSocket 口径

- 主模式与 Debate 都通过 WS 推送 live 事件。
- 出站事件统一带顶层 `meta`，供前端按 `sequence / event_id` 去重与补拉。
- 空闲期会发送轻量 `heartbeat`，便于更快暴露半断开连接。
- `ending_room` 也有独立 WS 通道，不复用 scenario/debate stream。
- Oracle replay 的自动化状态当前也会显式跟随 active replay thread 的 `interaction_mode`，避免 mobile roundtable readonly 在自动化口径里误报成主桌模式。

## 源码入口建议

- 查接口：`llmdoc/reference/api.md`
- 查配置：`llmdoc/reference/config.md`
- 查 runtime 细节：对应 `backend/app/api/*.py` 与 `backend/app/services/*.py`
- 查 schema 与表结构：`backend/app/models/*.py`
