# REST + WebSocket API 参考

## REST API

Base URL: 后端服务根地址，例如 `http://localhost:18927`

> 当前 backend 里由路由层主动抛出的业务错误，已统一收口为：
>
> ```json
> {
>   "detail": {
>     "code": "SOME_ERROR_CODE",
>     "message": "Human-readable message"
>   }
> }
> ```
>
> 这条口径当前已覆盖：
> - `campaign`
> - `interventions`
> - `predictions`
> - `social`
> - `scenarios`
> - `debate`
> - `replay-artifact`
>
> FastAPI / Pydantic 自带的 schema 校验 `422` 仍保持框架默认错误体；这里说的是项目自定义业务错误。
>
> 当前未被路由层显式接住的异常，也会统一收口为：
>
> ```json
> {
>   "detail": {
>     "code": "INTERNAL_ERROR",
>     "message": "Internal server error"
>   }
> }
> ```
>
> 也就是说，客户端现在不会再看到原始 Python 异常字符串；详细堆栈只保留在服务端日志里。

### Scenarios

| 端点 | 方法 | 描述 | 请求体 | 响应 |
|------|------|------|--------|------|
| `POST /api/scenario` | POST | 创建场景并启动后台模拟 | `{"question": "如果...", "user_id?": "device-or-account-id", "num_agents?": 20, "rounds?": 10, "mode?": "blackboard", "hierarchical?": false, "visualization_enabled?": true, "temperature?": 0.4, "branch_sensitivity?": 0.7, "fork_prompt_variant?": "b", "fork_detector_active_branch_limit?": 1, "llm_api_key?": "", "llm_base_url?": "", "llm_model?": "", "llm_requests_per_minute?": 10, "llm_tokens_per_minute?": 100000, "disable_user_quota?": true}` | ScenarioResponse（立即返回 `status="simulating"`、`mode`、`hierarchical`、`visualization_enabled`；若 Theater 启用，还会立即带 `scene_theme` 与一条 provisional root branch） |
| `GET /api/scenario/{id}` | GET | 获取场景详情 | — | Scenario 对象（含 `visualization_enabled`、`scene_theme`、`director_state`、`gameplay_state`、`agents[]`、`branches[]`、`messages[]`；当前 `messages[*]` 还会带 `diverge / branch_title`，`branches[*]` 还会带 `fork_round`，顶层还会带 `fork_debug`） |
| `POST /api/scenario/import-replay` | POST | 把 replay 快照导入为真实本地 scenario | `{"scenario": ScenarioSnapshot}` | ScenarioResponse |
| `GET /api/scenario/{id}/branches` | GET | 获取分支列表 | — | BranchInfo[] |
| `GET /api/scenario/{id}/agents` | GET | 获取agent列表（含 group_id, group_name） | — | AgentInfo[] |
| `GET /api/scenario/{id}/story` | GET | 获取叙事结果 | — | StoryData |
| `GET /api/scenario/{id}/groups` | GET | 获取分层分组信息 (P3-A) | — | AgentGroupDetail[] |
| `POST /api/scenario/{id}/intervene` | POST | 注入干预；当前也支持正式玩法卡注入 | `{"branch_id": "...", "text": "...", "card_id?": "human_takeover", "profile_id?": "governance", "directive?": "..."}` | InterventionResponse（标准响应当前会额外带 `pending_count / queued_ahead`；若这次请求走了正式玩法卡分支，还会一并回传更新后的 `gameplay_state`） |
| `POST /api/scenario/{id}/intervene/retrospective` | POST | 回溯干预 | `{"branch_id": "...", "round_number": 2, "text": "..."}` | `{status, new_branch_id, from_round}` |
| `POST /api/scenario/{id}/intervene/batch` | POST | 多点干预 | `{"interventions": [{"branch_id": "...", "text": "..."}]}` | `{status, count, interventions[]}` |

> `POST /api/scenario/{id}/intervene/batch` 当前由 `BatchInterveneRequest` 做输入边界校验：
> - `interventions` 不能为空
> - `interventions` 最多 `50` 条；超过时返回 `422`
> - 当 SQLite-backed pending queue 启用时，`InterventionLog` 与 `PendingIntervention` 会在同一个事务里落库；不会再出现“日志已写但 pending queue 未写”的半提交
>
> `POST /api/scenario/{id}/intervene` 当前新增的正式玩法卡写法：
> - `card_id / profile_id / directive` 都是可选字段；只有带 `card_id` 时，后端才会把这次请求当成正式玩法卡注入处理
> - 一旦走玩法卡分支，后端会按 shared gameplay contract 校验：
>   - `manual_enabled`
>   - `min_round`
>   - `cooldown_rounds`
>   - 当前 `director points`
> - 校验通过后，后端会把这次 usage 直接写进 `Scenario.gameplay_state_json.cards.usage_log`
> - 标准干预响应与 `intervention_applied` 广播当前都会带：
>   - `pending_count`
>   - `queued_ahead`
>
> `POST /api/scenario/{id}/intervene/retrospective` 当前还新增了 fork depth 限制：
> - 当来源分支的 parent 链深度已经达到 `5`
> - 后端会返回 `400 RETROSPECTIVE_FORK_DEPTH_EXCEEDED`
> - 新建回溯分支的初始 `probability` 当前还会带 `0.3` 下限，不再随着连续回溯一路衰减到过低
>
> `POST /api/scenario` 当前也由 `CreateScenarioRequest` 在 schema 层校验 `question`：
> - 空字符串或纯空白：返回 `422`
> - 超过 `1000` 字符：返回 `422`
> - `rounds` 合法范围：`1 <= rounds <= MAX_ROUNDS`；超界时返回 `422`
> - `temperature` 合法范围：`0.0 <= temperature <= 2.0`
> - `branch_sensitivity` 合法范围：`0.0 <= branch_sensitivity <= 1.0`
> - `fork_prompt_variant` 当前支持：`a / b / c / d / e / f`
> - `fork_detector_active_branch_limit` 合法范围：`0 <= value <= MAX_BRANCHES`
> - `llm_requests_per_minute / llm_tokens_per_minute` 合法范围：`>= 0`
> - `disable_user_quota` 只对本地 / self-hosted provider 生效；若本次运行最终走的不是本地 provider，会被忽略

> `POST /api/scenario` 当前新增的 fork runtime 调参字段：
> - `temperature`：影响 agent 发言、fork detector、memory compression、narrator 的采样行为
> - `branch_sensitivity`：覆盖 parser 产出的 `branch_sensitivity`
> - `fork_prompt_variant`：切换 `_detect_fork()` 的 detector prompt
> - `fork_detector_active_branch_limit`：每轮仅允许前 `K` 个 `ACTIVE` 分支继续跑 detector；`null / 0` 表示关闭预算
>
> 这组字段都会进入 `Scenario.parsed_context`，并在 `GET /api/scenario/{id}` 的 `fork_debug.round_checks` 中回显。
>
> `GET /api/scenario/{id}` 当前在读取前会先尝试 reconcile stale 状态：
> - 若场景仍是 `simulating` 或 `narrating`
> - 且对应 runtime lock 已释放、分支都不再 `ACTIVE`
> - 且所有 `COMPLETED` 分支都已经有 `story + insight`
> - 后端会先把场景状态收口为 `done`，再返回响应
>
> 当前 `fork_debug` 除了聚合字段外，还会带 `round_checks[]`：
> - `branch_id / branch_title / round`
> - `active_branch_count / max_branches`
> - `fork_detector_active_branch_limit`
> - `detector_branch_rank / detector_branch_budget_eligible`
> - `sensitivity / temperature / prompt_variant`
> - `diverge_signal_count / diverge_signals / recent_summary_excerpt`
> - `detector_invoked / skip_reason / decision`
> - 若 detector 实际运行，还会带 `detector_result = {should_fork, reason, branches[]}`
> - 若本轮真的建了新分支，还会额外带 `created_branch_count / created_branch_ids / created_branch_titles`
>
> `POST /api/scenario/import-replay` 当前也有导入边界保护：
> - 整个 `scenario` payload 超过 `1_000_000 bytes`：返回 `422`
> - `question` 为空：返回 `422`
> - `question` 超过 `500` 字符：返回 `422`
> - `groups` 最多 `128` 条、`agents` 最多 `256` 条、`branches` 最多 `256` 条、`messages` 最多 `5_000` 条；超出时返回 `413`
> - 导入消息时若缺少 `agent_id`，后端会先按本次导入快照里的 agent name map 回退匹配，而不是反复全表扫描当前 scenario agents
>
> 当前主模式玩法卡的真实写路径已收口为：
> - 前端先把 card directive 生成正式干预请求，再调用 `POST /api/scenario/{id}/intervene`
> - 若请求里带了有效 `card_id / profile_id / directive`，后端会直接做玩法卡校验并写入 `gameplay-state`
> - 因此“玩法卡影响世界线”的直接注入入口仍是 `intervene`，但 authority / 冷却 / director points 现在不再只靠前端本地状态兜底
>
> `intervene / retrospective / batch` 当前不改 REST 形状，但待注入文本已经进入后端共享 pending queue；当多个 worker 共用同一个 SQLite 文件时，请求和模拟不需要落在同一个 worker，干预也能被消费。`batch` 在 SQLite queue 路径下还会把 queue row 和 intervention log 一起原子写入。

> `GET /api/scenario/{id}/groups` 当前会批量加载 group members 与 leader 信息，避免按 group / member 逐条查库。

### Scenario Management (P4)

| 端点 | 方法 | 描述 | 请求体 | 响应 |
|------|------|------|--------|------|
| `GET /api/scenarios` | GET | 场景列表（分页+筛选） | `?status=done&limit=20&offset=0` | `{scenarios[], total, limit, offset}` |
| `DELETE /api/scenario/{id}` | DELETE | 删除场景（级联删除所有关联数据） | — | `{status: "deleted", scenario_id}` |
| `GET /api/scenario/{id}/export` | GET | 导出场景 Markdown；当前会直接作为附件下载，文件名形如 `swarmoracle-<id8>.md` | — | `text/markdown` |
| `GET /api/scenario/{id}/social/{platform}` / `POST /api/scenario/{id}/social/{platform}` | GET / POST | 生成社交媒体文案 (P6)；provider overrides 当前只能走 `POST body`，不能放在 `GET query` 里 | `POST` body 可选 `{"llm_api_key?": "", "llm_base_url?": "", "llm_model?": "", "llm_requests_per_minute?": 10, "llm_tokens_per_minute?": 100000, "user_id?": "..."}` | `{platform, platform_name, copy}` |
| `GET /api/intervention-templates` | GET | 干预模板列表 (P4-D) | — | `InterventionTemplate[]` |

> `DELETE /api/scenario/{id}` 当前除了级联删除 SQL 数据外，还会：
> - 清理该 scenario 残留的 `pending_intervention` 队列项
> - 清理 `ending_room / ending_room_participant / ending_room_thread / ending_room_turn`
> - 通过 shared `VectorStore` 清理该 scenario 对应的 Chroma collection
> - 对受影响用户的 leaderboard row 做重建；若某用户已没有任何 scored prediction，对应 leaderboard row 现在会被直接删除，不再留下空 materialized 行
> - 若该 scenario 已写入 campaign 进度，还会同步删除对应 `ScenarioCampaignLog`
> - 若某个 badge 的 `source_scenario_id` 指向这局 scenario，会把这条来源指针清空
> - 会按删除后的剩余日志重算受影响的 `DirectorProfile / ProfileMastery` 聚合值，不再把这局继续算进累计结果
> - 在所有显式删除步骤后，还会执行一次删除完整性守卫；若仍发现残留的 scenario 关联记录，事务会回滚并返回 `500 / SCENARIO_DELETE_INTEGRITY_FAILED`
>
> `DELETE /api/scenario/{id}` 当前不会因为该 scenario 已经 finalize 到 campaign 就拒删；只要场景状态本身允许删除，后端会先回滚这局的 campaign side effects，再继续删主记录。

> `GET/POST /api/scenario/{id}/social/{platform}` 当前会按 scenario 语言选择 prompt wrapper / context 包装：
> - 英文 scenario 不再收到中文包装文本
> - 当前所有平台都跟随 scenario 语言输出，`reddit / x` 不再单独强制英文
> - 非中英文 scenario 当前会复用英文 scaffold，并额外显式注入目标语言 directive
> - `GET` 仍可直接生成文案，但如果把 `llm_api_key / llm_base_url / llm_model / user_id` 放进 query，后端会返回 `400`；这类 provider overrides 必须改走 `POST body`
> - 响应结构仍是 `{platform, platform_name, copy}`；若模型先返回超大原始文本，后端会先做一次安全缓冲截断，再做平台最终限长截断

> `GET /api/scenario/{id}/export` 当前除了 `content-type: text/markdown`，还会带：
> - `Content-Disposition: attachment; filename="swarmoracle-<id8>.md"`
>
> 也就是说，浏览器不需要再靠前端 `blob:` 下载推断文件名；当前导出链路会直接走标准附件下载。

### Replay 分享

| 端点 | 方法 | 描述 | 请求体 | 响应 |
|------|------|------|--------|------|
| `POST /api/replay-artifact` | POST | 持久化 replay payload，返回短 `share id` | `{"kind": "scenario_result_v1|simulation_view_v1", "payload": {...}}` | `{"id", "kind", "created_at"}` |
| `GET /api/replay-artifact/{id}` | GET | 读取 replay payload | — | `{"id", "kind", "payload", "created_at"}` |

> 当前口径：
> - 主模式 `ResultView / SimulationView` 优先使用 `ReplayArtifact` 生成 `/result/replay?share=...` 与 `/sim/replay?share=...`
> - 如果后端短链创建失败，前端会回退到本地 token
> - 当前 share 读路径会先校验 `scenario_result_v1 / simulation_view_v1` payload 结构；若 payload 非法，前端会直接拒绝 hydrate，而不是继续把坏数据灌进页面状态
> - `POST /api/replay-artifact` 与 `GET /api/replay-artifact/{id}` 的业务错误当前也走统一 `detail.code/detail.message`：
>   - `REPLAY_ARTIFACT_KIND_REQUIRED`
>   - `REPLAY_ARTIFACT_PAYLOAD_INVALID`
>   - `REPLAY_ARTIFACT_PAYLOAD_TOO_LARGE`
>   - `REPLAY_ARTIFACT_NOT_FOUND`

### Predictions & Leaderboard (P3-B)

| 端点 | 方法 | 描述 | 请求体 | 响应 |
|------|------|------|--------|------|
| `POST /api/scenario/{id}/predict` | POST | 提交预测（模拟完成前） | `{"prediction_text": "...", "confidence?": 0.5, "user_name?": "匿名预言家", "user_id?": "device-or-account-id"}` | PredictionResponse |
| `GET /api/scenario/{id}/predictions` | GET | 列出场景所有预测 | `?limit=50&offset=0`（均可选；默认 `limit=50`） | PredictionResponse[] |
| `POST /api/scenario/{id}/score-predictions` | POST | 触发 LLM 评分；当前也支持可选 provider policy | `{"llm_api_key?": "", "llm_base_url?": "", "llm_model?": "", "llm_requests_per_minute?": 10, "llm_tokens_per_minute?": 100000, "user_id?": "..."}` | `{attempted, scored, failed, all_failed, results[]}` |
| `GET /api/leaderboard` | GET | 全局预测排行榜 | `?limit=20&offset=0` | LeaderboardEntry[] |

> 这 4 个 endpoint 当前只由专用模块 `app/api/predictions.py` 提供；`scenarios.py` 不再持有 legacy 同名路由。
>
> `POST /api/scenario/{id}/predict` 当前请求体仍接受可选 `user_id`；若 `user_name` 留空，后端会按 scenario / question 语言补匿名昵称（中文场景用 `匿名预言家`，英文场景用 `Anonymous Predictor`），再把 `user_id` 缺省回退到 `"anonymous"`。当前 `PredictionResponse` 不回显 `user_id`。
>
> `POST /api/scenario/{id}/predict` 当前还新增了“单局单用户一条 prediction”约束：
> - 同一 `scenario_id + user_id` 只能提交一次
> - 匿名 `anonymous` 也走同一条规则
> - 重复提交时返回 `409 PREDICTION_ALREADY_SUBMITTED`
> - 这条规则当前不只靠应用层 pre-check；SQLite 也已补上唯一索引，所以高并发竞态下仍会收口到同一个 `409`
>
> `POST /api/scenario/{id}/predict` 当前只在这两种状态开放：
> - `parsing`
> - `simulating`
>
> 进入 `narrating / done / error` 后，后端都会返回 `400` 关闭预测入口。
>
> `POST /api/scenario/{id}/predict` 当前通过 Pydantic 校验 `confidence`：
> - 合法范围：`0.0 <= confidence <= 1.0`
> - 超界时返回 `422`
>
> `GET /api/scenario/{id}/predictions` 当前会先校验 scenario 是否存在：
> - 存在：返回该场景预测列表
> - 不存在：返回 `404 Not Found`
> - 也支持可选 `limit` 与 `offset`
> - 未传 `limit` 时，当前默认分页上限是 `50`
>
> `GET /api/leaderboard` 当前支持：
> - `limit`：`1-100`
> - `offset`：`>= 0`
> - 默认仍按 `avg_score desc` 排序
> - 匿名 `anonymous` 行当前不会再出现在排行榜响应里
>
> `POST /api/scenario/{id}/score-predictions` 当前的内部行为：
> - 单条 prediction 会先原子认领未评分行，再写入分数
> - 并发评分同一 prediction 时，只会有一个请求真正刷新 leaderboard
> - 竞争失败的请求会回读已有分数返回，不会重复覆盖
> - 批量评分响应当前会显式区分：
>   - `attempted = 0`：没有待评分 prediction
>   - `attempted > 0 && all_failed = true`：本次尝试过，但全都没成功
>   - `failed > 0 && scored > 0`：部分成功、部分失败
>
> 这组 predictions 路由当前的业务错误也都走统一 `detail.code/detail.message`；例如：
> - `SCENARIO_NOT_FOUND`
> - `PREDICTIONS_CLOSED`
> - `SCENARIO_NOT_COMPLETED`

### Director Campaign (Track A)

| 端点 | 方法 | 描述 | 请求体 | 响应 |
|------|------|------|--------|------|
| `POST /api/campaign/scenario/{scenario_id}/finalize` | POST | 结算单局导演生涯进度；同一 `scenario_id` 对同一导演档案重复提交为幂等返回，响应内会带 `already_finalized` | `{"user_id": "...", "user_name?": "匿名导演", "profile_id": "...", "archive_grade?": "C", "profile_resonance?": "offbeat", "betting_hit?": true, "bet_count?": 0, "most_used_card?": "...", "completed_daily_challenge?": false, "objective_completed_count?": 0, "objective_total_count?": 0, "commitment_outcome?": "hit|miss|pending"}` | CampaignFinalizeResponse |
| `GET /api/campaign/scenario/{scenario_id}/summary` | GET | 读取单个 scenario 已落库的 campaign 摘要；供结果页在本地 `scenarioMeta` 缺失时做跨设备兜底 | — | CampaignScenarioSummaryResponse |
| `GET /api/campaign/scenario/{scenario_id}/director-state` | GET | 读取单个 scenario 的导演层权威态；当前只包含 goals / commitment，且响应会带 `revision` | — | ScenarioDirectorStateResponse |
| `PUT /api/campaign/scenario/{scenario_id}/director-state` | PUT | 写入单个 scenario 的导演层权威态；当前只覆盖 goals / commitment，并要求请求体携带当前 `revision` | `{"revision": 0, "objectives": {"generated_for_question?": "...", "generated_for_profile?": "...", "goals": [...]}, "commitment": {"active": true, "branch_id?": "...", "branch_title?": "...", "committed_at_round?": 2, "committed_at?": "...", "outcome?": "pending"}}` | ScenarioDirectorStateResponse |
| `GET /api/campaign/scenario/{scenario_id}/gameplay-state` | GET | 读取单个 scenario 的玩法层权威态；当前已包含 `cards.usage_log / betting.bets / archive.key_moments / archive.branch_snapshots`，且响应会带 `revision` | — | ScenarioGameplayStateResponse |
| `PUT /api/campaign/scenario/{scenario_id}/gameplay-state` | PUT | 写入单个 scenario 的玩法层权威态；当前主要用于主模式整套 gameplay raw state 的跨设备同步，并要求请求体携带当前 `revision` | `{"revision": 0, "cards": {"usage_log": [...]}, "betting": {"bets": [...]}, "archive": {"key_moments": [...], "branch_snapshots": [...]}}` | ScenarioGameplayStateResponse |
| `GET /api/campaign/profile/{user_id}` | GET | 获取导演档案概要 | — | CampaignProfileResponse |
| `GET /api/campaign/profile/{user_id}/mastery` | GET | 获取题材熟练度列表 | — | CampaignMasteryResponse[] |
| `GET /api/campaign/profile/{user_id}/badges` | GET | 获取已解锁徽章 | — | CampaignBadgeResponse[] |
| `GET /api/campaign/challenges/rotation` | GET | 返回首页 challenge 定义轮换；当前会直接给出 `today_challenge + weekly_challenges[]`，供首页决定今日题目和本周赛道 | `?local_date=2026-03-17&weekly_count=3` | `{"local_date", "week_key", "today_challenge", "weekly_challenges[]"}` |
| `GET /api/campaign/profile/{user_id}/daily-status` | GET | 查询指定题材在调用方本地日期上的 daily challenge 完成态；供首页把后端真值与本地缓存合并显示 | `?profile_id=governance&local_date=2026-03-17&timezone_offset_minutes=-480` | CampaignDailyChallengeResponse |
| `GET /api/campaign/profile/{user_id}/weekly-summary` | GET | 查询调用方本地周窗口内的轻量周汇总；供首页的 weekly challenge / director growth Lite 展示 | `?local_date=2026-03-19&timezone_offset_minutes=-480` | `{"user_id", "week_start", "week_end", "timezone_offset_minutes", "total_runs", "completed_daily_challenges", "hit_bets", "campaign_score_delta", "best_archive_grade", "top_profile_id", "profile_runs"}` |

> `POST /api/campaign/scenario/{scenario_id}/finalize` 当前请求体里的 `user_name` 可以留空；若留空，后端会按 scenario 语言补匿名昵称（中文场景用 `匿名导演`，英文场景用 `Anonymous Director`）。

> `POST /api/campaign/scenario/{scenario_id}/finalize` 边界行为（已按当前实现与实测核对）：
> - `200 OK`：首次结算成功，或同一 `scenario_id` 被同一导演档案重复结算；重复结算时 `already_finalized = true`，不会重复累计进度。
> - `404 Not Found`：目标场景不存在，或命中旧日志但关联导演档案不存在。
> - `409 Conflict`：该场景已被另一位导演档案结算。
> - `400 Bad Request`：场景尚未完成，或 `user_id / profile_id / archive_grade / profile_resonance / bet_count` 等请求字段不合法。
> - 另外，若该局 `gameplay_state.betting.bets` 已经有 bet，但请求体仍没带 `betting_hit`，后端也会按 `400 CAMPAIGN_FINALIZE_INVALID` 拒绝这次 finalize，而不是静默猜测下注结果。
> - 上面这些业务错误当前都会通过 `detail.code/detail.message` 返回；例如：
>   - `CAMPAIGN_FINALIZE_NOT_FOUND`
>   - `CAMPAIGN_FINALIZE_STATE_INVALID`
>   - `CAMPAIGN_FINALIZE_CONFLICT`
>   - `CAMPAIGN_FINALIZE_INVALID`
>
> `GET /api/campaign/scenario/{scenario_id}/summary` 的边界行为：
> - `200 OK`：该 scenario 已有 finalized campaign log。
> - `404 Not Found`：该 scenario 还没有 campaign log，或对应摘要不存在。
>
> `GET /api/campaign/profile/{user_id}`、`/mastery`、`/badges`、`/daily-status` 在导演档案不存在时不再返回 `404 Not Found`：
> - `profile` 返回空摘要（`total_runs = 0`）
> - `mastery / badges` 返回空数组
> - `daily-status` 返回 `completed = false`
>
> 首页 current-truth 现在分三层读取 challenge 相关数据：
> - `GET /api/campaign/challenges/rotation`：给出 today / weekly challenge 的定义与轮换结果
> - `GET /api/campaign/profile/{user_id}/daily-status`：给出某个题材在调用方本地日期上的完成态
> - `GET /api/campaign/profile/{user_id}/weekly-summary`：给出本地周窗口内的 runs / score / top profile 聚合态
>
> `GET /api/campaign/challenges/rotation` 的边界行为：
> - `200 OK`：返回 `local_date` 对应的 `today_challenge` 与 `weekly_challenges`
> - `400 Bad Request`：`local_date` 不是合法 `YYYY-MM-DD`
> - `weekly_count` 当前会被后端 clamp 到合法范围，不会因为传大值直接报错
>
> `GET /api/campaign/profile/{user_id}/daily-status` 的边界行为：
> - `200 OK`：返回该题材在调用方本地日期上的完成态；若当日没有完成记录，会返回 `completed = false`，而不是报错。
> - `400 Bad Request`：`profile_id` 为空、`local_date` 非法，或 `timezone_offset_minutes` 无法构造本地时区。
> - campaign log 时间在比对前会先按 UTC 归一；即使 SQLite 把时间读回成 naive datetime，也会按 UTC 解释后再换算调用方本地日期。
>
> `GET /api/campaign/profile/{user_id}/weekly-summary` 的口径：
> - 周窗口按调用方传入的 `local_date + timezone_offset_minutes` 计算；
> - 当前不改 schema，直接基于 `ScenarioCampaignLog.created_at` 做聚合；
> - 返回值适合首页 Lite 展示，不是赛季系统的最终数据结构。
>
> `director-state` / `gameplay-state` 这两组 authority 写接口当前也都走统一业务错误格式；如果 revision 过期，后端会返回 `409` 且带结构化 code，例如：
> - `DIRECTOR_STATE_CONFLICT`
> - `GAMEPLAY_STATE_CONFLICT`

> `CampaignProfileResponse` 当前额外包含：
> - `last_daily_challenge_completed_at`
> - `last_daily_challenge_profile_id`
> - `last_daily_challenge_scenario_id`
>
> `CampaignDailyChallengeResponse` 当前包含：
> - `completed`
> - `scenario_id`
> - `completed_at`（UTC ISO string）
> - `most_used_card`
> - `betting_hit`
> - `profile_resonance`
> - `campaign_score_delta`
>
> `CampaignScenarioSummaryResponse` 当前包含：
> - `scenario_id`
> - `profile_id`
> - `archive_grade`
> - `profile_resonance`
> - `betting_hit`
> - `most_used_card`
> - `completed_daily_challenge`
> - `objective_completed_count`
> - `objective_total_count`
> - `commitment_outcome`
> - `campaign_score_delta`
> - `finalized_at`
>
> `ScenarioDirectorStateResponse` 当前包含：
> - `scenario_id`
> - `revision`
> - `objectives.generated_for_question`
> - `objectives.generated_for_profile`
> - `objectives.goals[]`
> - `objectives.last_updated_at`
> - `commitment.active`
> - `commitment.branch_id`
> - `commitment.branch_title`
> - `commitment.committed_at_round`
> - `commitment.committed_at`
> - `commitment.outcome`
>
> `ScenarioGameplayStateResponse` 当前包含：
> - `scenario_id`
> - `revision`
> - `cards.usage_log[]`
>   - `card_id`
>   - `profile_id`
>   - `branch_id`
>   - `branch_title`
>   - `round`
>   - `cost`
>   - `directive`
>   - `used_at`
> - `betting.bets[]`
>   - `bet_id`
>   - `kind`
>   - `target_id`
>   - `target_label`
>   - `confidence`
>   - `user_name`
>   - `placed_at_round`
>   - `placed_at`
>   - `resolved`
> - `archive.key_moments[]`
> - `archive.branch_snapshots[]`
>   - `branch_id`
>   - `title`
>   - `probability`
>
> 当前前端 `SimulationView` / `ResultView` 会优先读取：
> - `director-state`
> - `gameplay-state`
> - `summary`
>
> 其中：
> - goals / commitment 以后端 `director-state` 为准
> - 主模式 `cards.usageLog / betting.bets / archive.key_moments / archive.branch_snapshots` 以后端 `gameplay-state` 为准
> - `director-state / gameplay-state` 写入当前走乐观并发控制；若请求里的 `revision` 已过期，后端会返回 `409 Conflict`
> - 导演点数、卡牌冷却、`most_used_card`、`counterplay_card_count`、`last_counterplay_card` 会由前端基于远端 `usage_log` 重算
> - `summary` 继续兜底 `archive_grade / profile_resonance / most_used_card / betting_hit / completed_daily_challenge`
>
> 当前仓库里至少有 3 种 `409 Conflict`：
> - `PUT director-state / gameplay-state`：stale `revision`
> - `POST /api/campaign/scenario/{scenario_id}/finalize`：scenario 已归属另一 director profile
> - `GET /api/debate/{id}/result`：verdict 尚未就绪
>
### Health & Observability

| 端点 | 方法 | 描述 |
|------|------|------|
| `GET /` | GET | 应用信息 |
| `POST /api/health` | POST | 健康检查（含LLM连通性） |
| `POST /api/health/test` | POST | 使用可选 BYOK 参数测试 LLM 连通性 |
| `GET /metrics` | GET | Prometheus 指标端点 (P3-9) — 请求计数/延迟/活跃模拟 |

> `POST /api/health/test` 当前请求体为可选 BYOK 字段：
> - `llm_api_key?`
> - `llm_base_url?`
> - `llm_model?`
> - `llm_requests_per_minute?`
> - `llm_tokens_per_minute?`
>
> 当 `llm.status == "ok"` 时，响应当前还会尝试返回可选 `probe`；其字段至少包括：
> - `estimated_parallelism`
> - `tested_parallelism`
> - `recommended`（`agents_min / agents_max / rounds_min / rounds_max`）
> - `local_provider`
> - `allow_disable_user_quota`
>
> 若这次请求明确给了较低的 `llm_requests_per_minute`，backend 当前会改走更保守的 configured-budget probe，不再先用大 fan-out 把 provider 配额打满。

### Debate Arena (Track D)

| 端点 | 方法 | 描述 | 请求体 | 响应 |
|------|------|------|--------|------|
| `POST /api/debate` | POST | 创建独立 Debate Arena，并立即返回 live snapshot | `{"question": "如果...", "profile_hint?": "law", "user_id?": "...", "llm_api_key?": "", "llm_base_url?": "", "llm_model?": "", "llm_requests_per_minute?": 10, "llm_tokens_per_minute?": 100000, "reasoning_effort?": "low"}` | DebateSnapshot |
| `GET /api/debate/{id}` | GET | 获取 Debate live snapshot | — | DebateSnapshot（当前顶层还会带 `phase_insights[]`） |
| `GET /api/debate/{id}/result` | GET | 获取 Debate verdict 结果 | — | DebateResultPayload（当前顶层也会带 `phase_insights[]` 与 `adjudication_mode`） |
| `POST /api/debate/import-replay` | POST | 把 replay 快照导入为真实本地 Debate；当前会保留导入 payload 里的 `phase_insights` 与 `adjudication_mode` | `{"debate": DebateResultPayload}` | DebateSnapshot |
| `POST /api/debate/{id}/predict` | POST | 提交 Debate 结构化押注；当前只在 `DebateStatus.LIVE` 且阶段仍处于 `opening / crossfire / rebuttal` 时接受新押注 | `{"kind": "winner"|"verdict_tone", "target_value": "proposition|opposition|order|balance|rupture", "confidence?": 0.5, "user_id?": "...", "user_name?": "...", "is_counterplay?": true, "counterplay_phase?": "opening|crossfire|rebuttal", "counterplay_variant?": "balanced|reversal"}` | DebatePrediction |

> Debate 当前已按真实实现固定为 5 个阶段：
> - `opening`
> - `crossfire`
> - `rebuttal`
> - `closing`
> - `verdict`
>
> 当前 Debate 的终局裁决已升级为 `LLM hybrid`：后端会优先读取 judge analysis 里的 `adjudication` scorecard，与 deterministic plan 混合后生成最终 `winner / verdict_tone / breakdown`；如果 `DEBATE_USE_LLM = false`、上游暂时不可用，或 LLM 返回坏结构，会退回 deterministic fallback。当前结果 payload 会显式带 `adjudication_mode`。
>
> 如果某场 Debate 最终没有足够的 turn 可摘出 `best_argument / best_rebuttal`，后端当前也不会回空字符串；会回退成可读的兜底文案，避免结果页出现空洞句子。
>
> Debate 的后台推进当前还会在同一 SQLite 文件下使用 shared runtime lock 做跨 worker 防重入；这是内部执行约束，不改变现有 REST / WebSocket API 形状。
>
> `POST /api/debate/import-replay` 当前除了 payload bytes / turn count 上限，还会额外校验：
> - `result.winner` 必须是 `proposition` 或 `opposition`
> - `result.verdict_tone` 必须是 `order / balance / rupture`
> - `turns[*].sequence` 必须是从 `1` 开始、连续且无重复的正整数；合法输入会先按 `sequence` 排序再导入
> - `phase_insights` 的关键枚举/结构字段若非法（例如坏 `phase`、坏 direction、坏 `confidence_drift` 结构），会返回 `422`
> - 对同一份规范化 replay payload，导入当前是幂等的：若后端已存在同指纹 debate，会直接返回已有 snapshot，而不是重复创建新记录
>
> prediction 只支持两类：
> - `winner`
> - `verdict_tone`
>
> `GET /api/debate/{id}` 的 `available_prediction_options` 当前就是前端下注 UI 的单一契约来源；如果将来后端按房间状态或玩法裁掉某些 target，前端应直接按这份 snapshot 渲染。
>
> `POST /api/debate` 当前会在返回 live snapshot 后保留约 `5s` pre-roll，再启动后台阶段推进；这样前端 live 页能稳定出现下注窗口。
>
> `POST /api/debate/{id}/predict` 当前要求同时满足两层条件：
> - `debate.status == LIVE`
> - `debate.current_phase` 仍处于 `opening / crossfire / rebuttal`
>
> 也就是说，进入 `closing / verdict` 后会返回 `400`；若 Debate 已经处于 `QUEUED / ERROR / DONE`，同样会返回 `400`。当 `is_counterplay = true` 时，当前实现要求同时提供：
> - `counterplay_phase`
> - `counterplay_variant`
>
> 当 `is_counterplay = true` 时，后端当前会先持久化 `DebatePrediction / DebateCounterplay`，再 best-effort 广播 `debate_counterplay`；如果这一步 WebSocket 广播失败，请求仍返回 `200`，不会把已落库的预测回滚成 `500`
>
> `GET /api/debate/{id}` 与 `GET /api/debate/{id}/result` 当前都会在顶层返回可选 `counterplay` 对象：
> - `debate_id`
> - `kind`
> - `target_value`
> - `confidence`
> - `phase`
> - `variant`
> - `outcome`
> - `phase_score`
> - `explanation`
> - `user_name`
> - `created_at`
>
> `GET /api/debate/{id}` 与 `GET /api/debate/{id}/result` 当前还都会在顶层返回 `phase_insights[]`：
> - `phase`
> - `stakes`
> - `judge_focus`
> - `commentary`
> - `pressure_side`
> - `pressure_margin`
> - `turn_count`
> - `confidence_drift.direction`
> - `confidence_drift.phase_margin`
> - `confidence_drift.cumulative_margin`
>
> 当前口径：
> - `phase_insights` 是后端权威阶段洞察，不是前端猜出来的辅助字段
> - 若某阶段有 `counterplay`，后端会把这手对冲是否挂出、命中或未中，直接织进对应阶段的 `phase_insights.commentary`
> - 若 Debate 是通过 `import-replay` 导入，后端会优先回放导入时持久化下来的 `phase_insights`，不再只靠运行时重算近似版本
>
> `GET /api/debate/{id}/result` 在裁决未生成前返回 `409 Conflict`，前端会轮询等待 verdict 落稳；若 Debate 已进入 `ERROR` 终态，则返回 `500`，前端会直接显示终态错误。
> 当前这些 Debate 业务错误也统一走 `detail.code/detail.message`；高频 code 包括：
> - `DEBATE_NOT_FOUND`
> - `DEBATE_RESULT_NOT_READY`
> - `DEBATE_RESULT_ERROR_STATE`
> - `DEBATE_PREDICTIONS_CLOSED`
> - `DEBATE_PREDICTIONS_LOCKED`
> - `DEBATE_PREDICTION_TARGET_VALUE_UNSUPPORTED`
> - 一组 `REPLAY_DEBATE_*` 导入校验 code

> 容器健康检查建议使用 `GET /`，不要直接把 `POST /api/health` 用作 liveness probe。后者会同步探测外部 LLM，可把“服务已启动但上游暂时不可达”误判成容器不健康。

### Oracle Chambers / Worldline Roundtable (Phase C MVP Contract)

> 当前状态：
> - backend 已实现这条线的 `ending_room` 独立数据域、REST 接口与 WebSocket
> - backend 本 session 又补齐了 `selected_agent_ids / selected_representatives / selected_witness / follow-up thread / user-turn / room-thread memory partition / worldline echo / all_present`
> - frontend 当前已把 participant picker、thread UI、follow-up composer 和 `archivist_route / hotseat / all_present` 接进单结局结果页，并补上了 `crossline_gallery`
> - `Worldline Roundtable` 当前已正式接出，并支持：
>   - `representative`
>   - `manual_shortlist`
>   - `expert_witness`
> - 当前未单独签收的残余主要是 replay/share/import 最终专项，以及 `trait_mix / fault_line_first / witness_augmented`

| 端点 | 方法 | 描述 | 请求体 | 响应 |
|------|------|------|--------|------|
| `POST /api/scenario/{id}/ending-room` | POST | 创建结局会客厅或世界线圆桌房间 | `{"room_type": "ending_chamber|worldline_roundtable|one_move_only|crossline_gallery", "anchor_branch_id?": "branch-id", "selected_branch_ids": ["branch-a", "branch-b"], "selected_agent_ids?": ["agent-a", "agent-b"], "selected_representatives?": [{"branch_id": "branch-a", "agent_id": "agent-a"}], "selected_witness?": {"branch_id": "branch-a", "agent_id": "agent-c"}, "language?": "zh|en"}` | EndingRoomSnapshot |
| `GET /api/ending-room/{room_id}` | GET | 获取房间 live snapshot | — | EndingRoomSnapshot |
| `GET /api/ending-room/{room_id}/result` | GET | 获取房间完成态结果 | — | EndingRoomResultPayload |
| `POST /api/ending-room/{room_id}/thread` | POST | 在现有 room 下创建 follow-up thread | `{"title?": "热座追问", "addressed_agent_ids": ["agent-id"], "interaction_mode": "thread_followup|hotseat|all_present"}` | EndingRoomThreadSnapshot |
| `GET /api/ending-room/thread/{thread_id}` | GET | 获取单条 follow-up thread snapshot | — | EndingRoomThreadSnapshot |
| `POST /api/ending-room/{room_id}/user-turn` | POST | 追加 room 级追问，沿用 default room thread | `{"content": "...", "addressed_agent_ids": ["agent-id"], "question_anchor_ids": ["anchor-id"], "interaction_mode?": "archivist_route|hotseat|all_present"}` | `{room_id, thread_id, memory_partition_id, turns[]}` |
| `POST /api/ending-room/thread/{thread_id}/user-turn` | POST | 追加指定 thread 的追问 | `{"content": "...", "addressed_agent_ids": ["agent-id"], "question_anchor_ids": ["anchor-id"], "interaction_mode?": "thread_followup|hotseat|all_present"}` | `{room_id, thread_id, memory_partition_id, turns[]}` |

> 当前 ending-room WebSocket 可用路径：
> - 主路径：`/api/ws/ending-room/{room_id}`
> - 兼容 alias：`/ws/ending-room/{room_id}`
>
> 前端 fresh dev session 当前默认连接主路径。

> 这条线的统一作用域键固定为：
>
> ```json
> {
>   "scenario_id": "scn_xxx",
>   "anchor_branch_id": "br_xxx",
>   "room_type": "ending_chamber|worldline_roundtable|one_move_only|crossline_gallery",
>   "participant_set_hash": "sha256(...)",
>   "language": "zh|en"
> }
> ```
>
> 所有以下链路都必须按这组 key 分桶：
> - 持久化
> - WebSocket stream
> - replay / import
> - 摘要缓存
> - 向量检索

> 当前 snapshot / thread / turn 的真实字段口径：
> - room snapshot 当前还会带：
>   - `memory_partition_id`
>   - `threads[]`
> - participant 当前还会带：
>   - `worldline_echo_key`
> - thread snapshot 当前会带：
>   - `mode`
>   - `interaction_mode`
>   - `memory_partition_id`
>   - `addressed_agent_ids_json`
> - turn 当前会带：
>   - `thread_id`
>   - `source`
>   - `interaction_mode`
>   - `memory_partition_id`
>   - `addressed_agent_ids_json`
>   - `question_anchor_ids_json`

> 当前已冻结的读取边界：
> - `ending_chamber`：只允许读取当前 `anchor_branch_id` 全文；其他 branch 只允许摘要字段
> - `worldline_roundtable`：每个代表只读自己 branch 全文；`Archivist` 只读多线摘要，不读多线全文
> - `crossline_gallery`：只读摘要与引文，不读全文 transcript

> 当前已冻结的流式策略：
> - 若这条线启用流式输出，只允许 **混合流式**
> - 标准事件链必须是：`turn_start -> turn_delta -> turn_commit`
> - `turn_delta` 只用于 live UI
> - `turn_commit` 才是唯一正式版本；落库 / replay / share / quote extraction 一律以 committed turn 为准

> 当前后端实际口径：
> - `POST /api/scenario/{id}/ending-room`
>   - `ending_chamber / one_move_only` 当前要求：
>     - `anchor_branch_id` 必填
>     - `anchor_branch_id` 必须属于 `selected_branch_ids`
>     - 所选 branch 都必须是 `COMPLETED`
>   - `selected_agent_ids` 当前已启用：
>     - `one_move_only` 最多 `1` 人
>     - `ending_chamber` 最多 `3` 人
>     - 若不在当前 worldline roster 内，会返回 `422 ENDING_ROOM_AGENT_NOT_VISIBLE`
>   - `selected_representatives` 当前已启用：
>     - 只允许用于 `worldline_roundtable`
>     - 必须按 branch 维度提交 `{branch_id, agent_id}`
>     - 所选 agent 必须属于对应 worldline roster
>   - `selected_witness` 当前已启用：
>     - 只允许用于 `worldline_roundtable`
>     - 必须属于当前已选 worldline roster
>     - 不允许和同枝代表是同一个 agent；否则返回 `422 ENDING_ROOM_WITNESS_SELECTION_INVALID`
>   - scenario 自身若还未进入 `DONE`，当前会返回 `409 ENDING_ROOM_SCENARIO_NOT_READY`
>   - 若同 scope room 已存在但上次跑成 `status=error`，当前会先 reset 后再重排后台任务
>   - `crossline_gallery` 会直接返回 `status=done`，不会再调度后台任务
> - `GET /api/ending-room/{room_id}`
>   - 找不到 room：返回 `404 ENDING_ROOM_NOT_FOUND`
> - `GET /api/ending-room/{room_id}/result`
>   - room 还没完成：返回 `409 ENDING_ROOM_RESULT_NOT_READY`
>   - 找不到 room：返回 `404 ENDING_ROOM_NOT_FOUND`
> - `POST /api/ending-room/{room_id}/thread`
>   - room 未完成、只读或 `crossline_gallery`：返回 `409`
>   - `hotseat` 且未给 `addressed_agent_ids`：返回 `422`
>   - `addressed_agent_ids` 不属于当前 room participant set：返回 `422`
> - `GET /api/ending-room/thread/{thread_id}`
>   - 找不到 thread：返回 `404 ENDING_ROOM_THREAD_NOT_FOUND`
> - `POST /api/ending-room/{room_id}/user-turn`
>   - 会先复用或创建 default room thread
>   - 追加的 user turn / assistant follow-up turn 会继续写进 room 级 `memory_partition_id`
>   - 当前已支持：
>     - `archivist_route`
>     - `hotseat`
>     - `all_present`
>   - `addressed_agent_ids` 不属于当前 room participant set：返回 `422 ENDING_ROOM_AGENT_NOT_VISIBLE`
> - `POST /api/ending-room/thread/{thread_id}/user-turn`
>   - 只会写当前 thread 的 `memory_partition_id`
>   - `hotseat` thread 若请求体没再带 `addressed_agent_ids`，当前会沿用 thread 自己的 `addressed_agent_ids_json`
> - 当前单结局结果页前端只会用：
>   - `selected_branch_ids = [anchor_branch_id]`
>   - `room_type = ending_chamber | one_move_only`
>   - 当前会通过 participant picker 传 `selected_agent_ids`
>
> backend 当前会下发的 ending-room WebSocket 事件：
> - `status`
> - `ending_room_phase_change`
> - `ending_room_turn_start`
> - `ending_room_turn_delta`
> - `ending_room_turn_commit`
> - `ending_room_turn_error`
> - `ending_room_result_ready`
> - `heartbeat`
> - room 级 / thread 级 follow-up 还会补发：
>   - `ending_room_thread_created`
>   - `ending_room_scope_notice`
>
> 与 `scenario / debate` 一样：
> - 除 `heartbeat` 外，ending-room WebSocket 当前也统一带顶层 `meta`
> - `meta` 包含：`stream_id / sequence / event_id / manager_instance_id / emitted_at`
> - room 后台运行失败时，当前会显式把 room 持久化成 `status=error`，并广播：
>   - `ending_room_turn_error`
>   - `status = error`
> - 由于 ending-room room 可能在 WS 建连前就已 `done`，前端当前还会在 `onopen` 后主动补拉一次 `GET /api/ending-room/{room_id}` / `.../result`
> - follow-up 目前继续复用 `ending_room_turn_commit` 作为 committed turn 广播，不单独拆新的 follow-up commit 事件

## WebSocket API

连接: `ws://localhost:18927/ws/scenario/{scenario_id}`

> 当前 `scenario` / `debate` 两条 WebSocket receive loop 都会在 `finally` 中执行断链清理：
> - 正常 `WebSocketDisconnect` 会清理连接
> - `receive_text()` 抛出的非正常异常也会清理连接，然后继续向上抛错
> - 空闲期还会发送轻量 `heartbeat`，让半断开连接能更快在发送路径上暴露；客户端收到这类事件后可以直接忽略
> - `scenario` 广播当前已改成并行发送；单个慢连接不会再阻塞同场景其它连接收消息，但发送失败的 dead connection 仍会在同一轮 broadcast 后被清理
>
> 当前 WebSocket 传输层口径：
> - 除 `heartbeat` 外，`scenario / debate` 两条 WS 的所有服务端下行事件现在都会在顶层额外带 `meta`
> - `meta` 当前包含：`stream_id / sequence / event_id / manager_instance_id / emitted_at`
> - 这层 `meta` 不改变原有业务 `data` 形状；不关心传输层顺序的客户端可以继续忽略
> - 前端当前会用 `sequence / event_id` 做重复/旧事件丢弃，以及 gap 触发的补拉 resync
> - `heartbeat` 仍保持轻量 `{type, data.ts}` 形状，不带 `meta`

> `GET /api/scenario/{id}/social/{platform}` / `POST /api/scenario/{id}/social/{platform}` 当前会按 scenario 语言选择 wrapper / instruction：
> - 中文 scenario 继续使用中文 wrapper
> - 英文 scenario 改用英文 wrapper，不再混入中文包裹文本

### 事件类型

| type | data | 方向 | 描述 |
|------|------|------|------|
| `heartbeat` | `{ts}` | S→C | 应用层 keepalive；客户端可忽略 |
| `status` | `{status, hierarchical?}` | S→C | 场景状态变更 |
| `agent_speak_start` | `{agent, agent_id, branch, round}` | S→C | agent开始发言（流式） |
| `agent_speak_delta` | `{agent, agent_id, delta, branch, round}` | S→C | agent发言增量token |
| `agent_speak` | AgentMessage | S→C | agent发言完成 |
| `round_summary` | `{branch_id, round, summary}` | S→C | 轮次摘要 |
| `branch_fork` | `{parent, children[{id, title, description?, fork_round, probability}], reason}` | S→C | 分支分裂；`children[*].fork_round` 当前会直接给出这条新世界线是在第几轮分出来的 |
| `branch_prune` | `{branch_id, reason}` | S→C | 分支剪枝 |
| `narration` | `{branch_id, title, story, insight}` | S→C | 叙事完成 |
| `intervention_applied` | `{branch_id, text, round, intervention_id}` | S→C | 干预已应用 |
| `intervention_injected` | `{branch_id, round, text}` | S→C | 干预已注入 |
| `retrospective_start` | `{branch_id, source_branch_id, from_round, text}` | S→C | 回溯干预开始 |
| `batch_intervention_applied` | `{interventions[]}` | S→C | 批量干预已应用 |
| `simulation_done` | — | S→C | 模拟完成 |
| `simulation_error` | `{error: {code, message}}` | S→C | 模拟出错 |

### Debate Arena WebSocket

连接: `ws://localhost:18927/ws/debate/{debate_id}`

| type | data | 方向 | 描述 |
|------|------|------|------|
| `heartbeat` | `{ts}` | S→C | 应用层 keepalive；客户端可忽略 |
| `status` | `{status, error?}` | S→C | Debate 状态变更；若 `status = error`，`error` 当前是 `{code, message}` |
| `agent_speak` | `{id, sequence, phase, speaker_side, speaker_name, content, score_delta, created_at?}` | S→C | 单条阶段发言 |
| `debate_phase_change` | `{phase}` | S→C | 当前阶段切换 |
| `debate_score_update` | `{score: {proposition, opposition}, audience_meter}` | S→C | 势能 / 分数更新 |
| `debate_counterplay` | DebateCounterplayResult | S→C | live counterplay 记录已创建/更新 |
| `debate_verdict` | DebateVerdictEventPayload | S→C | 最终 verdict 就绪；当前 payload = `DebateResultSummary + phase_insights[]` |

> 非 `heartbeat` 事件的顶层 envelope 示例：
>
> ```json
> {
>   "type": "status",
>   "data": {
>     "status": "simulating"
>   },
>   "meta": {
>     "stream_id": "scenario-123",
>     "sequence": 7,
>     "event_id": "scenario-123:7",
>     "manager_instance_id": "abc123...",
>     "emitted_at": "2026-03-23T00:00:00+00:00"
>   }
> }
> ```

> 当前 WebSocket 错误事件口径：
> - scenario `simulation_error` 会返回结构化 `error` 对象，而不是纯字符串
> - 目前已验证的 code 有：
>   - `SCENARIO_PARSE_FAILED`
>   - `SIMULATION_TIMEOUT`
>   - `SIMULATION_RUNTIME_FAILED`
> - Debate 的 `status = error` 当前也会带结构化 `error` 对象；目前已验证的 code 为：
>   - `DEBATE_RUNTIME_FAILED`
