# REST + WebSocket API 参考

## REST API

Base URL: 后端服务根地址，例如 `http://localhost:18927`

### Scenarios

| 端点 | 方法 | 描述 | 请求体 | 响应 |
|------|------|------|--------|------|
| `POST /api/scenario` | POST | 创建场景并启动后台模拟 | `{"question": "如果...", "num_agents?": 20, "rounds?": 10, "mode?": "blackboard", "hierarchical?": false, "visualization_enabled?": true, "llm_api_key?": "", "llm_base_url?": "", "llm_model?": ""}` | ScenarioResponse（立即返回 `status="simulating"`、`mode`、`hierarchical`、`visualization_enabled`；若 Theater 启用，还会立即带 `scene_theme` 与一条 provisional root branch） |
| `GET /api/scenario/{id}` | GET | 获取场景详情 | — | Scenario 对象（含 `visualization_enabled`、`scene_theme`、`agents[]`、`branches[]`、`messages[]`） |
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
| `POST /api/scenario/{id}/predict` | POST | 提交预测（模拟完成前） | `{"prediction_text": "...", "confidence?": 0.5, "user_name?": "匿名预言家"}` | PredictionResponse |
| `GET /api/scenario/{id}/predictions` | GET | 列出场景所有预测 | — | PredictionResponse[] |
| `POST /api/scenario/{id}/score-predictions` | POST | 触发 LLM 评分 | — | `{scored, results[]}` |
| `GET /api/leaderboard` | GET | 全局预测排行榜 | `?limit=20` | LeaderboardEntry[] |

### Health & Observability

| 端点 | 方法 | 描述 |
|------|------|------|
| `GET /` | GET | 应用信息 |
| `POST /api/health` | POST | 健康检查（含LLM连通性） |
| `POST /api/health/test` | POST | 使用可选 BYOK 参数测试 LLM 连通性 |
| `GET /metrics` | GET | Prometheus 指标端点 (P3-9) — 请求计数/延迟/活跃模拟 |

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
