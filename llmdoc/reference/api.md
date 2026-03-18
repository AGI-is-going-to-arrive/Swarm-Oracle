# REST + WebSocket API 参考

## REST API

Base URL: 后端服务根地址，例如 `http://localhost:18927`

### Scenarios

| 端点 | 方法 | 描述 | 请求体 | 响应 |
|------|------|------|--------|------|
| `POST /api/scenario` | POST | 创建场景并启动后台模拟 | `{"question": "如果...", "num_agents?": 20, "rounds?": 10, "mode?": "blackboard", "hierarchical?": false, "visualization_enabled?": true, "llm_api_key?": "", "llm_base_url?": "", "llm_model?": ""}` | ScenarioResponse（立即返回 `status="simulating"`、`mode`、`hierarchical`、`visualization_enabled`；若 Theater 启用，还会立即带 `scene_theme` 与一条 provisional root branch） |
| `GET /api/scenario/{id}` | GET | 获取场景详情 | — | Scenario 对象（含 `visualization_enabled`、`scene_theme`、`director_state`、`agents[]`、`branches[]`、`messages[]`） |
| `GET /api/scenario/{id}/branches` | GET | 获取分支列表 | — | BranchInfo[] |
| `GET /api/scenario/{id}/agents` | GET | 获取agent列表（含 group_id, group_name） | — | AgentInfo[] |
| `GET /api/scenario/{id}/story` | GET | 获取叙事结果 | — | StoryData |
| `GET /api/scenario/{id}/groups` | GET | 获取分层分组信息 (P3-A) | — | AgentGroupDetail[] |
| `POST /api/scenario/{id}/intervene` | POST | 注入干预 | `{"branch_id": "...", "text": "..."}` | InterventionResponse |
| `POST /api/scenario/{id}/intervene/retrospective` | POST | 回溯干预 | `{"branch_id": "...", "round_number": 2, "text": "..."}` | `{status, new_branch_id, from_round}` |
| `POST /api/scenario/{id}/intervene/batch` | POST | 多点干预 | `{"interventions": [{"branch_id": "...", "text": "..."}]}` | `{status, count, interventions[]}` |

### Scenario Management (P4)

| 端点 | 方法 | 描述 | 请求体 | 响应 |
|------|------|------|--------|------|
| `GET /api/scenarios` | GET | 场景列表（分页+筛选） | `?status=done&limit=20&offset=0` | `{scenarios[], total, limit, offset}` |
| `DELETE /api/scenario/{id}` | DELETE | 删除场景（级联删除所有关联数据） | — | `{status: "deleted", scenario_id}` |
| `GET /api/scenario/{id}/export` | GET | 导出场景 Markdown | — | `text/markdown` |
| `GET /api/scenario/{id}/social/{platform}` | GET | 生成社交媒体文案 (P6) | platform: `xiaohongshu/weibo/zhihu/reddit/x` | `{platform, platform_name, copy}` |
| `GET /api/intervention-templates` | GET | 干预模板列表 (P4-D) | — | `InterventionTemplate[]` |

### Predictions & Leaderboard (P3-B)

| 端点 | 方法 | 描述 | 请求体 | 响应 |
|------|------|------|--------|------|
| `POST /api/scenario/{id}/predict` | POST | 提交预测（模拟完成前） | `{"prediction_text": "...", "confidence?": 0.5, "user_name?": "匿名预言家", "user_id?": "device-or-account-id"}` | PredictionResponse |
| `GET /api/scenario/{id}/predictions` | GET | 列出场景所有预测 | — | PredictionResponse[] |
| `POST /api/scenario/{id}/score-predictions` | POST | 触发 LLM 评分 | — | `{scored, results[]}` |
| `GET /api/leaderboard` | GET | 全局预测排行榜 | `?limit=20` | LeaderboardEntry[] |

> `POST /api/scenario/{id}/predict` 当前会透传并回显 `user_id`；若未提供，后端会退回到 `user_name`，再退回到 `"anonymous"`。

### Director Campaign (Track A)

| 端点 | 方法 | 描述 | 请求体 | 响应 |
|------|------|------|--------|------|
| `POST /api/campaign/scenario/{scenario_id}/finalize` | POST | 结算单局导演生涯进度；同一 `scenario_id` 对同一导演档案重复提交为幂等返回，响应内会带 `already_finalized` | `{"user_id": "...", "user_name?": "匿名导演", "profile_id": "...", "archive_grade?": "C", "profile_resonance?": "offbeat", "betting_hit?": true, "bet_count?": 0, "most_used_card?": "...", "completed_daily_challenge?": false, "objective_completed_count?": 0, "objective_total_count?": 0, "commitment_outcome?": "hit|miss|pending"}` | CampaignFinalizeResponse |
| `GET /api/campaign/scenario/{scenario_id}/summary` | GET | 读取单个 scenario 已落库的 campaign 摘要；供结果页在本地 `scenarioMeta` 缺失时做跨设备兜底 | — | CampaignScenarioSummaryResponse |
| `GET /api/campaign/scenario/{scenario_id}/director-state` | GET | 读取单个 scenario 的导演层权威态；当前只包含 goals / commitment | — | ScenarioDirectorStateResponse |
| `PUT /api/campaign/scenario/{scenario_id}/director-state` | PUT | 写入单个 scenario 的导演层权威态；当前只覆盖 goals / commitment | `{"objectives": {"generated_for_question?": "...", "generated_for_profile?": "...", "goals": [...]}, "commitment": {"active": true, "branch_id?": "...", "branch_title?": "...", "committed_at_round?": 2, "committed_at?": "...", "outcome?": "pending"}}` | ScenarioDirectorStateResponse |
| `GET /api/campaign/profile/{user_id}` | GET | 获取导演档案概要 | — | CampaignProfileResponse |
| `GET /api/campaign/profile/{user_id}/mastery` | GET | 获取题材熟练度列表 | — | CampaignMasteryResponse[] |
| `GET /api/campaign/profile/{user_id}/badges` | GET | 获取已解锁徽章 | — | CampaignBadgeResponse[] |
| `GET /api/campaign/profile/{user_id}/daily-status` | GET | 查询指定题材在调用方本地日期上的 daily challenge 完成态；供首页把后端真值与本地缓存合并显示 | `?profile_id=governance&local_date=2026-03-17&timezone_offset_minutes=-480` | CampaignDailyChallengeResponse |

> `POST /api/campaign/scenario/{scenario_id}/finalize` 边界行为（已按当前实现与实测核对）：
> - `200 OK`：首次结算成功，或同一 `scenario_id` 被同一导演档案重复结算；重复结算时 `already_finalized = true`，不会重复累计进度。
> - `404 Not Found`：目标场景不存在，或命中旧日志但关联导演档案不存在。
> - `409 Conflict`：该场景已被另一位导演档案结算。
> - `400 Bad Request`：场景尚未完成，或 `user_id / profile_id / archive_grade / profile_resonance / bet_count` 等请求字段不合法。
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
> `GET /api/campaign/profile/{user_id}/daily-status` 的边界行为：
> - `200 OK`：返回该题材在调用方本地日期上的完成态；若当日没有完成记录，会返回 `completed = false`，而不是报错。
> - `400 Bad Request`：`profile_id` 为空、`local_date` 非法，或 `timezone_offset_minutes` 无法构造本地时区。
> - campaign log 时间在比对前会先按 UTC 归一；即使 SQLite 把时间读回成 naive datetime，也会按 UTC 解释后再换算调用方本地日期。

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
> 当前前端 `SimulationView` / `ResultView` 会优先读取 `director-state`；`ResultView` 同时并行请求 `summary`。当本地 `scenarioMeta.archive` 缺字段时，会用 `summary` 兜底 `archive_grade / profile_resonance / most_used_card / betting_hit / completed_daily_challenge`；当 goals / commitment 缺失时，会以后端 `director-state` 为准。`finalize` 的 `404 / 409` 仍会被识别为边界态，只显示提示文案，不阻断主结果页展示；其他 `finalize` 错误按普通错误展示。

### Health & Observability

| 端点 | 方法 | 描述 |
|------|------|------|
| `GET /` | GET | 应用信息 |
| `POST /api/health` | POST | 健康检查（含LLM连通性） |
| `POST /api/health/test` | POST | 使用可选 BYOK 参数测试 LLM 连通性 |
| `GET /metrics` | GET | Prometheus 指标端点 (P3-9) — 请求计数/延迟/活跃模拟 |

### Debate Arena (Track D)

| 端点 | 方法 | 描述 | 请求体 | 响应 |
|------|------|------|--------|------|
| `POST /api/debate` | POST | 创建独立 Debate Arena，并立即返回 live snapshot | `{"question": "如果...", "profile_hint?": "law"}` | DebateSnapshot |
| `GET /api/debate/{id}` | GET | 获取 Debate live snapshot | — | DebateSnapshot |
| `GET /api/debate/{id}/result` | GET | 获取 Debate verdict 结果 | — | DebateResultPayload |
| `POST /api/debate/{id}/predict` | POST | 提交 Debate 结构化押注 | `{"kind": "winner"|"verdict_tone", "target_value": "proposition|opposition|order|balance|rupture", "confidence?": 0.5, "user_id?": "...", "user_name?": "...", "is_counterplay?": true, "counterplay_phase?": "opening|crossfire|rebuttal", "counterplay_variant?": "balanced|reversal"}` | DebatePrediction |

> Debate 当前已按真实实现固定为 5 个阶段：
> - `opening`
> - `crossfire`
> - `rebuttal`
> - `closing`
> - `verdict`
>
> prediction 只支持两类：
> - `winner`
> - `verdict_tone`
>
> `POST /api/debate` 当前会在返回 live snapshot 后保留约 `5s` pre-roll，再启动后台阶段推进；这样前端 live 页能稳定出现下注窗口。
>
> `POST /api/debate/{id}/predict` 只在 `opening / crossfire / rebuttal` 阶段开放；进入 `closing / verdict` 后会返回 `400`。当 `is_counterplay = true` 时，当前实现要求同时提供：
> - `counterplay_phase`
> - `counterplay_variant`
>
> `GET /api/debate/{id}` 与 `GET /api/debate/{id}/result` 当前都会在顶层返回可选 `counterplay` 对象：
> - `debate_id`
> - `kind`
> - `target_value`
> - `confidence`
> - `phase`
> - `variant`
> - `outcome`
> - `user_name`
> - `created_at`
>
> `GET /api/debate/{id}/result` 在裁决未生成前返回 `409 Conflict`，前端会轮询等待 verdict 落稳；若 Debate 已进入 `ERROR` 终态，则返回 `500`，前端会直接显示终态错误。

> 容器健康检查建议使用 `GET /`，不要直接把 `POST /api/health` 用作 liveness probe。后者会同步探测外部 LLM，可把“服务已启动但上游暂时不可达”误判成容器不健康。

## WebSocket API

连接: `ws://localhost:18927/ws/scenario/{scenario_id}`

### 事件类型

| type | data | 方向 | 描述 |
|------|------|------|------|
| `status` | `{status, hierarchical?}` | S→C | 场景状态变更 |
| `agent_speak_start` | `{agent, agent_id, branch, round}` | S→C | agent开始发言（流式） |
| `agent_speak_delta` | `{agent, agent_id, delta, branch, round}` | S→C | agent发言增量token |
| `agent_speak` | AgentMessage | S→C | agent发言完成 |
| `round_summary` | `{branch_id, round, summary}` | S→C | 轮次摘要 |
| `branch_fork` | `{parent, children[], reason}` | S→C | 分支分裂 |
| `branch_prune` | `{branch_id, reason}` | S→C | 分支剪枝 |
| `narration` | `{branch_id, title, story, insight}` | S→C | 叙事完成 |
| `intervention_applied` | `{branch_id, text, round, intervention_id}` | S→C | 干预已应用 |
| `intervention_injected` | `{branch_id, round, text}` | S→C | 干预已注入 |
| `retrospective_start` | `{branch_id, source_branch_id, from_round, text}` | S→C | 回溯干预开始 |
| `batch_intervention_applied` | `{interventions[]}` | S→C | 批量干预已应用 |
| `simulation_done` | — | S→C | 模拟完成 |
| `simulation_error` | `{error}` | S→C | 模拟出错 |

### Debate Arena WebSocket

连接: `ws://localhost:18927/ws/debate/{debate_id}`

| type | data | 方向 | 描述 |
|------|------|------|------|
| `status` | `{status, error?}` | S→C | Debate 状态变更 |
| `agent_speak` | `{id, sequence, phase, speaker_side, speaker_name, content, score_delta, created_at?}` | S→C | 单条阶段发言 |
| `debate_phase_change` | `{phase}` | S→C | 当前阶段切换 |
| `debate_score_update` | `{score: {proposition, opposition}, audience_meter}` | S→C | 势能 / 分数更新 |
| `debate_counterplay` | DebateCounterplayResult | S→C | live counterplay 记录已创建/更新 |
| `debate_verdict` | DebateResultSummary | S→C | 最终 verdict 就绪 |
