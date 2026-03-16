# SwarmOracle — 后续优化路线图

> 基于 598 次真实 GPT 5.2 API 调用 + 700 项后端单元测试 + 122 项前端单元测试 + 全量代码审查的实证分析  
> 最后更新: 2026-03-13

---

## 〇、当前项目状态基线

### 已完成模块

| 模块 | 文件 | 测试状态 | 说明 |
|------|------|---------|------|
| 问题解析 | `parser.py` | ✅ 通过 | 自然语言 → 场景设定 + Agent 生成 |
| 模拟引擎 | `simulator.py` | ✅ 通过 | Agent 轮次循环 + 并发 + 分支分裂 |
| 叙事引擎 | `narrator.py` | ✅ 通过 | 原始交互 → 可读故事线 |
| 记忆管理 | `memory.py` | ✅ 通过 | 三层记忆 + tier 过滤 + 上下文构建 |
| Blackboard | `blackboard.py` | ✅ 通过 | 共享黑板 + 200K 安全阀 + 阵营聚合 |
| LLM 客户端 | `llm_client.py` | ✅ 通过 | OpenAI-Compatible + Responses API + 指数退避重试 (P1-3) |
| REST API | `scenarios.py` + `schemas.py` + `helpers.py` + `interventions.py` + `social.py` | ✅ 通过 | 全量 CRUD + 干预 + 社交 (P0-1 拆分) |
| WebSocket | `ws.py` | ✅ 通过 | 实时推送 |
| 前端 | React + TypeScript | ✅ 构建通过 | InputView / BranchTree / ResultView |
| Alembic | `alembic/` | ✅ 通过 | 数据库版本化迁移 (P1-4) |
| Prometheus | `metrics.py` | ✅ 通过 | `/metrics` 请求计数/延迟/活跃模拟 (P3-9) |

**测试统计**: 700 tests passed / 后端主回归 0 failures + 前端 122 tests (Vitest)

### 双模式对比（E2E 实测数据）

| 模式 | 10A×8R prompt tokens | 特点 |
|------|-------------------:|------|
| RAW | 72,385 | tier 过滤硬上限，O(1) 上下文 |
| Blackboard | 138,862 | 全量共享，O(N) 上下文，涌现性最强 |

### 已验证的关键公式

```
per_call_tokens = 1,669 + 64 × num_agents
positions_bytes ≈ 192.4 × agents + 19.0
bytes_per_token ≈ 2.99 (中文)
200K 安全阈值: ~2,474 agents（已实现自动降级）
```

---

## 一、优化项总览

| 优先级 | 优化项 | 类型 | 改动量 | 风险 | 依赖 | 状态 |
|:------:|--------|------|:-----:|:---:|:----:|:----:|
| **P0** | 自定义 Agent 数量/轮次参数化 | 功能 | ~80 行 | 低 | 无 | ✅ 已完成 |
| **P0** | Docker Compose 一键部署 | 运维 | ~60 行 | 低 | 无 | ✅ 已完成 |
| **P1** | Blackboard 模式集成到模拟引擎 | 架构 | ~120 行 | 中 | P0 参数化 | ✅ 已完成 |
| **P1** | Agent 发言流式推送 | UX | ~100 行 | 低 | 无 | ✅ 已完成 |
| **P2** | 向量记忆 L2 层落地 | 功能 | ~200 行 | 中 | 无 | ✅ 已完成 |
| **P2** | 蝴蝶效应干预增强 | 功能 | ~150 行 | 低 | 无 | ✅ 已完成 |
| **P3** | 分层代理架构（千人规模） | 架构 | ~400 行 | 高 | P1 BB 集成 | ✅ 已完成 |
| **P3** | 排行榜 / 竞猜社交层 | 功能 | ~300 行 | 低 | P0 | ✅ 已完成 |
| **P4** | 场景管理（列表/删除/导出） | 功能 | ~200 行 | 低 | 无 | ✅ 已完成 |
| **P4** | 干预模板 | 功能 | ~30 行 | 低 | P2 干预 | ✅ 已完成 |
| **P4** | BYOK（自带 API Key） | 功能 | ~150 行 | 中 | P1 流式 | ✅ 已完成 |
| **P5** | Fork 抑制 + 叙事改进 | 质量 | ~50 行 | 低 | P1 BB | ✅ 已完成 |
| **P6** | 社交媒体文案生成 | 功能 | ~200 行 | 低 | P1 叙事 | ✅ 已完成 |
| **P7** | 前端 UX 增强（侧边栏/卡片/过滤） | UX | ~400 行 | 低 | 无 | ✅ 已完成 |
| **P8** | 代码审查加固 + CSS 兼容 | 质量 | ~200 行 | 低 | 无 | ✅ 已完成 |
| **P9** | 语言检测 + 全局语言切换 | 功能 | ~200 行 | 低 | 无 | ✅ 已完成 |
| **P0-1** | API 层拆分重构 | 架构 | ~200 行 | 低 | 无 | ✅ 已完成 |
| **P0-2** | N+1 查询优化 (LEFT JOIN) | 性能 | ~50 行 | 中 | 无 | ✅ 已完成 |
| **P1-3** | LLM 重试 + 指数退避 | 可靠性 | ~30 行 | 低 | 无 | ✅ 已完成 |
| **P1-4** | Alembic 迁移框架 | 运维 | ~100 行 | 低 | 无 | ✅ 已完成 |
| **P2-6** | 前端测试框架 (Vitest) | 质量 | ~150 行 | 低 | 无 | ✅ 已完成 |
| **P2-7** | 批量 SQL 删除优化 | 性能 | ~30 行 | 低 | 无 | ✅ 已完成 |
| **P2-8** | 单会话概率归一化 | 性能 | ~20 行 | 低 | 无 | ✅ 已完成 |
| **P3-9** | Prometheus 可观测性 | 运维 | ~80 行 | 低 | 无 | ✅ 已完成 |

---

## 二、P0 — 自定义 Agent 数量 / 轮次参数化

### 2.1 目标

用户在创建场景时可自定义 Agent 数量（3-100）、推演轮次（1-40）、模拟模式（RAW / Blackboard），后端根据 `estimate_context_tokens()` 在 WebSocket 中返回预估 token 消耗。

### 2.2 开发方案

#### 修改文件

| 文件 | 改动内容 | 行数 |
|------|---------|:----:|
| `app/api/scenarios.py` | `POST /api/scenario` 新增 `num_agents`, `max_rounds`, `mode` 参数 | ~20 行 |
| `app/services/parser.py` | `parse_question()` 接收 `num_agents` 参数，动态生成指定数量的 Agent | ~15 行 |
| `app/services/simulator.py` | `run_simulation()` 接收 `mode` 参数，按需创建 Blackboard 实例 | ~30 行 |
| `app/config.py` | 新增 `MAX_AGENTS = 100`, `MAX_ROUNDS = 40` 配置 | ~5 行 |
| `app/services/blackboard.py` | `estimate_context_tokens()` 已实现，无需改动 | 0 行 |

#### API 变更

```python
# POST /api/scenario — 新增可选参数
{
    "question": "如果诸葛亮多活10年？",
    "num_agents": 20,      # 可选，默认 20，范围 3-100
    "max_rounds": 12,      # 可选，默认 10，范围 1-40
    "mode": "blackboard"   # 可选，默认 "raw"，可选 "raw" | "blackboard"
}

# 响应增加预估
{
    "id": "xxx",
    "estimated_tokens_per_round": 2949,
    "estimated_total_tokens": 35388,
    "context_safety": "ok"  # "ok" | "aggregated" (>2474 agents)
}
```

#### 前端适配

| 文件 | 改动内容 |
|------|---------|
| `InputView.tsx` | 新增 Agent 数量滑块（3-100）、模式选择下拉菜单 |
| `stores/simulationStore.ts` | 新增 `numAgents`, `mode` 字段 |
| WebSocket 消息 | 新增 `context_estimate` 事件 |

### 2.3 测试方案

| 测试类型 | 文件 | 用例 |
|---------|------|------|
| 单元测试 | `test_api.py` | 参数校验：边界值 (3, 100, 0, 101, -1)、缺省值、非法 mode |
| 单元测试 | `test_parser.py` | `parse_question(num_agents=50)` 生成正确数量的 Agent |
| 单元测试 | `test_simulator.py` | mode="blackboard" 时创建 Blackboard 实例 |
| 集成测试 | `test_api.py` | 完整 POST → GET 流程，验证参数透传 |
| E2E 测试 | `test_e2e_matrix.py` | 已有，验证各参数组合下的 token 消耗 |

### 2.4 Review 检查清单

- [ ] 参数校验：`num_agents` 超范围是否返回 422？
- [ ] 默认值向后兼容：不传参数时行为与现有完全一致？
- [ ] `estimate_context_tokens()` 返回值准确性（±10%）？
- [ ] WebSocket 仍能正常推送？不因新参数而断连？
- [ ] 现有 236 个测试零回归？

---

## 三、P0 — Docker Compose 一键部署

### 3.1 目标

`docker compose up` 一键启动前后端 + 依赖，开发者 clone 后零配置即可运行。

### 3.2 开发方案

| 文件 | 状态 | 说明 |
|------|------|------|
| `backend/Dockerfile` | ✅ 已有 | 614 bytes，需验证 |
| `frontend/Dockerfile` | ❌ 新建 | 多阶段构建：node 构建 → nginx 静态服务 |
| `docker-compose.yml` | ✅ 已有 | 901 bytes，需补充 frontend service |
| `.env.example` | ✅ 已有 | 需补充新增的参数说明 |

#### docker-compose.yml 结构

```yaml
services:
  backend:
    build: ./backend
    ports: ["8000:8000"]
    env_file: .env
    volumes: ["./backend/swarmoracle.db:/app/swarmoracle.db"]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/api/health"]
      interval: 10s

  frontend:
    build: ./frontend
    ports: ["3000:80"]
    depends_on:
      backend:
        condition: service_healthy
```

### 3.3 测试方案

| 测试 | 方法 | 验证点 |
|------|------|-------|
| 构建测试 | `docker compose build` | 两个镜像无报错 |
| 启动测试 | `docker compose up -d` | 两个容器 healthy |
| API 测试 | `curl http://localhost:8000/api/health` | 返回 200 + LLM 连通 |
| 前端测试 | 浏览器访问 `http://localhost:3000` | 页面加载，WebSocket 连通 |
| E2E 测试 | 创建场景 → 推演 → 查看结果 | 完整流程无报错 |

### 3.4 Review 检查清单

- [ ] `.env.example` 包含所有必要配置项且有注释？
- [ ] Docker 镜像大小 < 500MB？
- [ ] `docker compose down -v` 后重新 up 是否正常？
- [ ] 跨平台（amd64/arm64）构建是否正常？

---

## 四、P1 — Blackboard 模式集成到模拟引擎

### 4.1 目标

`simulator.py` 的 `run_simulation()` 支持 `mode="blackboard"` 参数，使用 Blackboard 替代 RAW 模式的上下文构建。

### 4.2 当前状态

| 组件 | 状态 | 说明 |
|------|------|------|
| `Blackboard` 核心 | ✅ 完成 | `post()`, `get_shared_briefing()`, `fork()`, 200K 安全阀 |
| `format_briefing_for_context()` | ✅ 完成 | 格式化共享简报为 prompt 文本 |
| `build_agent_context()` | ✅ 完成 | 已支持 `shared_briefing` 参数 |
| `simulator.py` 集成 | ❌ 未完成 | 需要在 `_gather_agent_messages()` 中加入 BB 分支 |

### 4.3 开发方案

#### 核心改动：`simulator.py`

```python
# _gather_agent_messages() — 新增 BB 模式分支

if self.mode == "blackboard":
    briefing = self.blackboard.get_shared_briefing()
    shared_text = format_briefing_for_context(briefing)
    # 所有 Agent 使用相同的 shared_text
    for agent in agents:
        ctx = build_agent_context(
            agent=agent, ..., shared_briefing=shared_text
        )
else:
    # 现有 RAW 模式逻辑不变
    for agent in agents:
        recent = format_messages_for_context(messages, tier=agent.tier)
        ctx = build_agent_context(agent=agent, ..., recent_messages=recent)
```

#### 分支管理

```python
# fork 时复制 Blackboard
if self.mode == "blackboard":
    child_bb = parent_bb.fork()
    child_branch.blackboard = child_bb
```

#### 修改文件清单

| 文件 | 改动内容 | 行数 |
|------|---------|:----:|
| `simulator.py` | `_gather_agent_messages()` BB 分支 + BB post 调用 | ~60 行 |
| `simulator.py` | `_detect_fork()` 时 BB.fork() | ~20 行 |
| `simulator.py` | `_compress_round_memory()` 更新 BB global_summary | ~15 行 |
| `simulator.py` | `run_simulation()` 初始化 BB 实例 | ~10 行 |

### 4.4 测试方案

| 测试类型 | 文件 | 用例 |
|---------|------|------|
| 单元测试 | `test_blackboard.py` | 已有 (覆盖 post/briefing/fork/aggregation) |
| 单元测试 | `test_simulator.py` | 新增：`mode="blackboard"` 下的完整模拟流程 |
| 集成测试 | `test_blackboard_bench.py` | 已有 (性能基准) |
| E2E 测试 | `test_e2e_matrix.py` | 已有 (598 次 API 调用验证) |
| 对比测试 | 新增 | 相同输入，RAW vs BB 输出质量对比 |

### 4.5 Review 检查清单

- [ ] RAW 模式零回归：`mode="raw"` 与改动前行为完全一致？
- [ ] BB 模式 `post()` 只在 `asyncio.gather` 返回后批量调用？
- [ ] 分支分裂时 BB `fork()` 正确深拷贝？子分支独立？
- [ ] `_compress_round_memory()` 正确更新 BB 的 `global_summary`？
- [ ] WebSocket 推送事件不受模式切换影响？
- [ ] 200K 安全阀在极端 agent 数下正确触发？

---

## 五、P1 — Agent 发言流式推送（Streaming）

### 5.1 目标

Agent LLM 调用改为流式模式，前端实时显示逐字输出，提升 UX 响应感。

### 5.2 开发方案

| 文件 | 改动内容 | 行数 |
|------|---------|:----:|
| `llm_client.py` | 新增 `llm_call_stream()` 异步生成器 | ~40 行 |
| `simulator.py` | `_gather_agent_messages()` 使用流式调用 | ~30 行 |
| `ws.py` | 新增 `agent_speak_chunk` 事件类型 | ~10 行 |
| 前端 `AgentBubble.tsx` | 逐字渲染动画 | ~20 行 |

#### WebSocket 新增事件

```json
{
    "type": "agent_speak_chunk",
    "data": {
        "agent": "曹操",
        "chunk": "若孔明得",
        "is_final": false
    }
}
```

### 5.3 测试方案

| 测试 | 方法 | 验证点 |
|------|------|-------|
| 单元测试 | mock 流式响应 | chunk 拼接后 = 完整 JSON |
| 延迟测试 | 计时 | 首 token 延迟 < 500ms |
| 并发测试 | 多 agent 同时流式 | 不串流、不丢失 |
| WebSocket 测试 | 模拟客户端 | chunk 事件顺序正确 |

### 5.4 Review 检查清单

- [ ] 非流式模式仍可回退使用？
- [ ] 流式输出的 JSON 解析在 chunk 边界断开时不崩溃？
- [ ] WebSocket 断连后资源正确清理？
- [ ] 并发流式不超过 LLM 服务的 rate limit？

---

## 六、P2 — 向量记忆 L2 层落地 ✅ 已完成

### 6.1 目标

实现架构文档的 L2 层：ChromaDB 向量数据库，支持跨 session 记忆检索。

### 6.2 开发方案

| 文件 | 改动内容 | 行数 | 状态 |
|------|---------|:----:|:----:|
| `app/services/vector_store.py` | **新增** ChromaDB 客户端封装（含优雅降级） | ~170 行 | ✅ |
| `memory.py` | `retrieve_relevant_memories()` → ChromaDB 查询 | ~40 行 | ✅ |
| `memory.py` | `store_memory()` → 存入 ChromaDB（fire-and-forget） | ~30 行 | ✅ |
| `simulator.py` | 每轮后调用 `store_memory()` + CORE/IMPORTANT 注入 L2 | ~30 行 | ✅ |
| `memory.py` | `build_agent_context()` 注入 Top-K 记忆 | ~20 行 | ✅ |
| `docker-compose.yml` | ChromaDB 持久化配置 | ~5 行 | ✅ |

#### 记忆检索流程

```
Agent 上下文构建时:
1. 取当前话题 + Agent 人设 → embedding
2. ChromaDB 检索 Top-5 相关记忆片段
3. 注入 L0 即时上下文（~1000 tokens 预算内）
4. LLM 调用
5. 响应写入 ChromaDB（异步后台）
```

### 6.3 测试方案

| 测试 | 方法 |
|------|------|
| 向量存储 | 存 10 条 → 查 3 条 → 验证相关性 |
| 跨 Session | Session A 的记忆在 Session B 中可检索 |
| Token 预算 | 注入后总 tokens ≤ L0 预算 (~2300) |
| ChromaDB 不可用 | 降级为纯 L0/L1 模式，不崩溃 |

### 6.4 Review 检查清单

- [x] ChromaDB 不可用时优雅降级？ → ✅ 已验证（17 tests）
- [x] embedding 模型配置可切换？ → ✅ ChromaDB 内置 default embedding
- [x] 记忆检索延迟 < 100ms？ → ✅ 本地 ChromaDB 实测 <50ms
- [x] docker-compose 正确配置 ChromaDB 持久化？ → ✅ CHROMA_PERSIST_DIR

---

## 七、P2 — 蝴蝶效应干预增强 ✅ 已完成

### 7.1 目标

增强现有干预功能：支持在任意轮次注入自定义事件，观察对后续分支的影响。

### 7.2 当前状态

- `POST /api/scenario/{id}/intervene` ✅ 已实现
- `POST /api/scenario/{id}/intervene/retrospective` ✅ 已实现（P2 新增）
- `POST /api/scenario/{id}/intervene/batch` ✅ 已实现（P2 新增）
- 干预消息注入到指定分支 ✅
- 干预后继续推演 ✅

### 7.3 增强方向

| 功能 | 说明 | 文件 | 状态 |
|------|------|------|:----:|
| 回溯干预 | 回到第 N 轮重新推演 | `scenarios.py` | ✅ |
| 多点干预 | 一次注入多个分支事件 | `scenarios.py` | ✅ |
| 干预模板 | 预设常见干预类型（自然灾害、技术突破等） | 前端 | 未开始 |
| 干预对比 | 同场景对比有干预 vs 无干预的分支 | 前端 | 未开始 |

### 7.4 测试方案

| 测试 | 验证点 |
|------|-------|
| 回溯干预 | 回到 R3 干预后 R4+ 的输出与原始不同 |
| 多点干预 | 每个分支独立干预、互不影响 |
| 并发干预 | 推演进行中的干预不崩溃 |
| 边界情况 | 在最后一轮/已完成的场景中干预 |

---

## 八、P3 — 分层代理架构（千人规模）

### 8.1 目标

实现架构文档决策 4：分组 → 代表推演 → 群众扩散，支持 1000+ Agent。

### 8.2 设计方案

```
1000 Agents
├── 魏国组 (300人) → Leader Agent 代表推演
│   ├── 文臣子组 (100人) → Sub-Leader
│   └── 武将子组 (200人) → Sub-Leader
├── 蜀国组 (400人) → Leader Agent 代表推演
└── 吴国组 (300人) → Leader Agent 代表推演

实际 LLM 调用/轮 = 3 Leaders + 6 Sub-Leaders + Orchestrator ≈ 10-20 calls
```

#### 改动量评估

| 文件 | 改动 | 说明 |
|------|------|------|
| `models/` | 新增 `AgentGroup` 模型 | Agent 分组 + 层级关系 |
| `parser.py` | 生成分组信息 | LLM 自动分组 |
| `simulator.py` | 分组推演逻辑 | Leader 代表 + 群众扩散 |
| `blackboard.py` | 分组 Blackboard | 组内共享 + 跨组摘要 |
| 前端 | 分组可视化 | 树型 Agent 展示 |

### 8.3 风险评估

| 风险 | 等级 | 缓解措施 |
|------|:---:|---------|
| 涌现性损失 | **高** | Leader 摘要保留关键原话 |
| 复杂度爆炸 | **中** | 先支持 2 级（Leader → Worker），不做多级 |
| 测试覆盖 | **高** | 需新增至少 20+ 测试用例 |

### 8.4 前提条件

- P1 Blackboard 集成完成
- P0 参数化完成
- 200K 安全阀验证通过

---

## 九、P3 — 排行榜 / 竞猜社交层

### 9.1 目标

用户在推演开始前预测结局，推演完成后与 AI 结果对比评分。

### 9.2 数据模型

```python
class Prediction:
    user_id: str
    scenario_id: str
    predicted_outcome: str    # 用户预测
    confidence: float         # 自信度 0-1
    actual_match_score: float # AI 评分 0-1（推演完成后填充）
    points_earned: int        # 获得积分

class Leaderboard:
    user_id: str
    total_points: int
    prediction_count: int
    accuracy_rate: float
```

### 9.3 改动范围

| 文件 | 改动 |
|------|------|
| `models/` | 新增 `Prediction`, `Leaderboard` 模型 |
| `api/predictions.py` | **新增** 预测 CRUD API |
| `api/leaderboard.py` | **新增** 排行榜 API |
| `services/scoring.py` | **新增** LLM 评分逻辑 |
| 前端 `LeaderboardView.tsx` | 排行榜页面 |
| 前端 `PredictionModal.tsx` | 预测输入弹窗 |

---

## 十、开发节奏建议

### Sprint 1（1-2 周）— P0 项

| 任务 | 工时 | 产出 |
|------|:---:|------|
| 自定义 Agent/轮次参数化 | 2 天 | API + 前端滑块 + 测试 |
| Docker Compose | 1 天 | 一键部署 |
| 文档更新 | 0.5 天 | README + .env.example |
| **Review + 回归测试** | 0.5 天 | 236+ tests passing |

### Sprint 2（2-3 周）— P1 项

| 任务 | 工时 | 产出 |
|------|:---:|------|
| BB 模式集成到 simulator | 3 天 | 完整双模式推演 |
| 流式推送 | 2 天 | 逐字 UX |
| E2E 验证 | 1 天 | 双模式 × 多规模 benchmark |
| **Review + 回归测试** | 1 天 | 260+ tests passing |

### Sprint 3（3-4 周）— P2 项 ✅ 已完成

| 任务 | 工时 | 产出 | 状态 |
|------|:---:|------|:----:|
| ChromaDB 向量记忆 | 3 天 | L2 层完整落地（vector_store.py ~170 行） | ✅ |
| 干预增强 | 2 天 | 回溯 + 多点干预 API | ✅ |
| **Review + 回归测试** | 1 天 | **331 tests passing** (含 34 新增) | ✅ |

### Sprint 4 — P3 项 ✅ 已完成

| 任务 | 工时 | 产出 | 状态 |
|------|:---:|------|:----:|
| 分层代理架构 | 5 天 | Leader-Worker 2级分层，千人规模首跑 | ✅ |
| 排行榜/竞猜 | 3 天 | Prediction + Leaderboard + LLM 评分 | ✅ |
| **Review + 回归测试** | 2 天 | **349 tests passing** (含 34 新增) | ✅ |

### Sprint 5 — P4 项 ✅ 已完成

| 任务 | 工时 | 产出 | 状态 |
|------|:---:|------|:----:|
| 场景管理（列表/删除） | 1 天 | GET /scenarios + DELETE /scenario/{id}（级联删除） | ✅ |
| 场景导出 | 0.5 天 | GET /scenario/{id}/export → Markdown | ✅ |
| 干预模板 | 0.5 天 | GET /intervention-templates → 5 个预设模板 | ✅ |
| BYOK（自带 API Key） | 1 天 | 全栈 BYOK（llm_client → parser → simulator → API → 前端 UI） | ✅ |
| **Review + 回归测试** | 0.5 天 | **369 tests passing** (含 20 新增) | ✅ |

### Sprint 6 — P5 项 ✅ 已完成

| 任务 | 工时 | 产出 | 状态 |
|------|:---:|------|:----:|
| Fork 抑制（最后一轮不 fork） | 0.5 天 | 所有叶子分支都有 Agent 发言 | ✅ |
| 分支描述字段 | 0.5 天 | `description` 字段添加到 Branch 模型 | ✅ |
| `simulation_error` WebSocket 事件 | 0.5 天 | 前端错误状态解耦 | ✅ |

### Sprint 7 — P6 + P7 项 ✅ 已完成

| 任务 | 工时 | 产出 | 状态 |
|------|:---:|------|:----:|
| 社交媒体文案生成 | 1 天 | GET /scenario/{id}/social/{platform} → 5 平台 | ✅ |
| 可收起侧边栏 | 1 天 | 磨砂玻璃药丸 Toggle，无边框残留 | ✅ |
| 分支讨论卡片 | 0.5 天 | 实时 agent 发言显示 + 脉冲动画 | ✅ |
| Agent 消息过滤 | 0.5 天 | 点击 agent 图标查看历史全部消息 | ✅ |

### Sprint 8 — P8 项 ✅ 已完成

| 任务 | 工时 | 产出 | 状态 |
|------|:---:|------|:----:|
| 代码审查加固（后端） | 1 天 | 防重入锁、模拟超时、级联删除、概率归一化、hashString 修复 | ✅ |
| 代码审查加固（前端） | 1 天 | 消息上限/dedup、指数退避重连、React key 修复、i18n 补全 | ✅ |
| CSS 兼容性清理 | 0.5 天 | oklch() 回退、inline style 重构、line-clamp 标准化 | ✅ |
| **Review + 回归测试** | 0.5 天 | TypeScript 编译通过，零新增警告 | ✅ |

### Sprint 9 — P9 项 ✅ 已完成

| 任务 | 工时 | 产出 | 状态 |
|------|:---:|------|:----:|
| 语言检测模块 (`lang_detect.py`) | 0.5 天 | 字符比例启发式检测（中/英/日/韩） + prompt 语言指令生成 | ✅ |
| 全链路语言透传 | 0.5 天 | parser→simulator→memory/narrator/scoring 全部接受 language 参数 | ✅ |
| 全局语言切换器 | 0.5 天 | `LanguageSwitcher` 组件，App.tsx 全局渲染，固定右下角 | ✅ |
| Code Review 修复 | 1 天 | 8 个问题全部修复（CJK 正则、默认值、分母、评分语言、z-index、locale匹配、round摘要 i18n） | ✅ |
| **Review + 回归测试** | 0.5 天 | **394 tests passing** (含 25 新增语言检测测试) | ✅ |

### Sprint 10 — P0-P3 项 ✅ 已完成

| 任务 | 工时 | 产出 | 状态 |
|------|:---:|------|:----:|
| API 层拆分重构 (P0-1) | 1 天 | scenarios.py → schemas/helpers/interventions/social 四模块 | ✅ |
| N+1 查询优化 (P0-2) | 0.5 天 | INNER JOIN → LEFT JOIN，保留已删除 agent 消息 | ✅ |
| LLM 重试 + 指数退避 (P1-3) | 0.5 天 | 429/5xx 自动重试 3 次，1s→2s→4s | ✅ |
| Alembic 迁移框架 (P1-4) | 0.5 天 | alembic.ini + env.py + baseline 迁移 | ✅ |
| BYOK 内存安全 (P1-5) | 0.5 天 | API Key 仅内存传递，不持久化 | ✅ |
| 前端测试框架 (P2-6) | 0.5 天 | Vitest + Testing Library + Zustand store 测试 | ✅ |
| 批量 SQL 删除 (P2-7) | 0.5 天 | 级联删除 batch DELETE 优化 | ✅ |
| 概率归一化 (P2-8) | 0.5 天 | 单数据库会话优化 | ✅ |
| Prometheus 可观测性 (P3-9) | 0.5 天 | `/metrics` 请求计数/延迟/活跃模拟 | ✅ |
| Code Review + Bug 修复 | 1 天 | 5 个 bug 修复（标量访问、LEFT JOIN、导入路径、断言阈值） | ✅ |
| **Review + 回归测试** | 0.5 天 | **410 tests passing** (含 16 新增回归测试) | ✅ |

### Sprint 11 — 像素化可视化 Phase 1 ✅ 已完成

| 任务 | 工时 | 产出 | 状态 |
|------|:---:|------|:----:|
| 事件映射引擎 | 1 天 | `viz_mapper.py` — 推理事件→可视化指令 | ✅ |
| 精灵分配系统 | 0.5 天 | `sprite_assigner.py` — persona→像素精灵 | ✅ |
| 场景选择引擎 | 0.5 天 | `scene_selector.py` — 话题→像素场景 | ✅ |
| 卡牌事件系统 | 0.5 天 | `card_events.py` — 干预→卡牌动画 | ✅ |
| Phaser 集成 | 1 天 | BootScene + WorldScene + EventBridge + PhaserGame | ✅ |
| Bug 修复 | 1 天 | 7 个可视化 Bug 修复 | ✅ |
| **Review + 测试** | 1 天 | **225 新测试**，700 tests passing | ✅ |

### Sprint 11.1 — Phase 1 Code Review 修复 ✅ 已完成

| 任务 | 工时 | 产出 | 状态 |
|------|:---:|------|:----:|
| viz_push 死代码消除 | 0.5 天 | 去除 ws.py 冗余 viz_push 函数 | ✅ |
| ending_type 3级映射 | 0.5 天 | 叙事→ending_type 映射覆盖全场景 | ✅ |
| Worker viz 事件推送 | 0.5 天 | 分层 Worker 发送 viz 事件到前端 | ✅ |
| EventBridge 单测 | 0.5 天 | 13 tests — 生命周期/订阅/错误隔离 | ✅ |
| **Review + 回归测试** | 0.5 天 | 4 问题修复，**22 新测试** | ✅ |

### Sprint 11.2 — Phase 2 推理可视化 + Phase 3 游戏化 ✅ 已完成

| 任务 | 工时 | 产出 | 状态 |
|------|:---:|------|:----:|
| 天气/昼夜系统 (Phase 2) | 1 天 | 雨/雪/雷/沙尘暴粒子特效 + 光照切换 | ✅ |
| 阵营标记 (Phase 2) | 0.5 天 | 阵营旗帜 + 名牌显示 | ✅ |
| 气泡变体 (Phase 2) | 0.5 天 | 10 种情绪样式气泡 | ✅ |
| 粒子特效 (Phase 2) | 0.5 天 | 情绪/事件联动星光/烟雾 | ✅ |
| 标题画面 (Phase 3) | 0.5 天 | TitleScene — 像素风标题 + i18n | ✅ |
| 结局演出 (Phase 3) | 1 天 | EndingScene — 6 种结局 + 电影转场 + 粒子 | ✅ |
| MiniMap HUD (Phase 3) | 0.5 天 | 右下 80×80 小地图 + Agent 位置实时更新 | ✅ |
| BetPanel HUD (Phase 3) | 0.5 天 | 竞猜面板 — 阵营赔率 + 动态投注条 | ✅ |
| Leaderboard HUD (Phase 3) | 0.5 天 | 排行榜 — Top-3 + 称号徽章 (5 级) | ✅ |
| 截图/GIF 导出 (Phase 3) | 0.5 天 | useScreenCapture hook — html2canvas + gif.js (含 fallback) | ✅ |
| i18n 补全 | 0.5 天 | 22 new keys × 2 locales (en/zh) | ✅ |
| **构建验证** | 0.5 天 | `npx tsc --noEmit` **0 errors** | ✅ |

### Sprint 11.3 — Phase 1-3 Code Review 修复 ✅ 已完成

| 任务 | 工时 | 产出 | 状态 |
|------|:---:|------|:----:|
| P0: WorldScene 内存泄漏修复 | 0.5 天 | Phaser SHUTDOWN 生命周期 + 对象销毁 + tweens.killAll | ✅ |
| P1: 事件监听器泄漏修复 | 0.5 天 | SHUTDOWN hook 自动触发 shutdown() 清理 | ✅ |
| P2: scene_selector 关键词优先级 | 0.5 天 | sorted(SCENE_MAP, key=len, reverse=True) longest-first | ✅ |
| P2: 卡牌单候选概率偏差 | 0.5 天 | spacetime_rift 单候选时保留在 pool | ✅ |
| P3: assign_position zero guard | 0.5 天 | total_agents ≤ 0 早返回 + log 警告 | ✅ |
| P3: stance 范围统一 clamp | 0.5 天 | mapper + persona_mapper 统一 clamp [-1,1] | ✅ |
| **回归测试** | 0.5 天 | **212 tests passing**，零回归 | ✅ |

### Sprint 11.4 — Phase 4 开源准备 ✅ 已完成

| 任务 | 工时 | 产出 | 状态 |
|------|:---:|------|:----:|
| Weather 粒子对象池 | 0.5 天 | acquireWeatherDot/releaseWeatherDot — 120 个 Graphics 对象回收复用 | ✅ |
| 视口裁剪 | 0.5 天 | cullAgent — VIEWPORT_MARGIN 40px 外 Agent 隐藏，减少 GPU 绘制调用 | ✅ |
| ASSET_CREDITS 文档 | 0.5 天 | 58 张 AI 生成素材清单（5 类别：角色/场景/特效/UI/结局） | ✅ |
| WorldScene.test.ts | 0.5 天 | 18 断言 — 主题/事件/阵营/气泡/时段/双语/性能常量 | ✅ |
| EndingScene.test.ts | 0.5 天 | 14 断言 — 结局配置/类型映射/resolveEndingId 逻辑 | ✅ |
| **Review + 回归测试** | 0.5 天 | **55 前端 tests passing** + tsc 零错误 + 679 后端 tests passing | ✅ |

---

### Sprint 11.5 — Phase 5 HUD 迁移 ✅ 已完成

| 任务 | 工时 | 产出 | 状态 |
|------|:---:|------|:----:|
| HudOverlay.tsx 新增 | 0.5 天 | React 浮层组件 — 排行榜(画布上方) + 竞猜面板(画布下方), EventBridge 事件监听 | ✅ |
| SimulationView.tsx 改造 | 0.25 天 | PhaserGameLoader 包裹 HudOverlay, 实现外层布局 | ✅ |
| WorldScene.ts HUD 删除 | 0.5 天 | 移除 drawLeaderboard/updateLeaderboard/drawBetPanel/updateBetPanel/renderBetBars/RANK_COLORS + gradient vignette | ✅ |
| game.css HUD 样式 | 0.25 天 | .hud-bar / .hud-bar--top / .hud-bar--bottom, dark premium 主题 | ✅ |
| **浏览器验证** | 0.25 天 | 排行榜/竞猜面板在 canvas 外渲染, 场景无遮挡, 编译零错误 | ✅ |

---

### Sprint 11.6 — 3.0 Phase B 美术风格全面升级 ✅ 已完成

| 任务 | 工时 | 产出 | 状态 |
|------|:---:|------|:----:|
| GBC 调色板统一 (B1) | 0.5 天 | 16 个 CSS custom properties (`--gbc-*`) 替代硬编码色值 | ✅ |
| 角色精灵重生成 (B2) | 1 天 | 18 张角色精灵统一 GBC 像素风 — king/warrior/scholar 等 | ✅ |
| 场景背景重生成 (B2) | 0.5 天 | 11 张场景背景统一大气 GBC 风 — ancient_empire/scifi_base 等 | ✅ |
| 结局画面重生成 (B2) | 0.5 天 | 6 张结局画面更高戏剧性表现力 — peace/war/tyranny 等 | ✅ |
| TitleScene 增强 (B3) | 0.5 天 | 打字机字幕 + 点击跳过 + 微光扫描线动画 | ✅ |
| WorldScene 增强 (B4) | 0.5 天 | 鼠标视差滚动 + 打字机气泡 + 垂直擦除过渡 | ✅ |
| **浏览器验证** | 0.25 天 | TypeScript 零错误 + 75 前端 tests + Pixel Theater 模式渲染正常 | ✅ |

### Sprint 11.7 — 3.0 Phase C UI/UX 布局 + Theater Mode 完善 ✅ 已完成

| 任务 | 工时 | 产出 | 状态 |
|------|:---:|------|:----:|
| SimulationView 布局重构 (C1) | 0.5 天 | Theater 画布 65% + Agent 面板 35%、GBC 暗色主题全覆写 | ✅ |
| game.css 像素风增强 (C2) | 0.25 天 | CRT 扫描线 + Power LED + HUD bar 统一 GBC 调 | ✅ |
| HudOverlay 像素化 (C3) | 0.25 天 | rank 翻牌动画 + SVG 阵营方块 + monospace 控件 | ✅ |
| Theater Bug 1-5 修复 | 0.5 天 | 精灵不可见/全相同/灰色背景/小地图/LLM JSON | ✅ |
| Theater Bug 6: 气泡 UUID | 0.25 天 | `synthesizeBubbles()` 改用 `msg.agent_id` (UUID) | ✅ |
| Theater Bug 7: 漫游+堆叠 | 0.5 天 | `startIdleWander()` ±50px + AABB 抗重叠 3 层 35px | ✅ |
| Theater Bug 8: 多轮气泡 | 0.5 天 | 移除 60 消息上限 → 171 条全量回放 + incremental dispatch | ✅ |
| **E2E 浏览器验证** | 0.25 天 | 5 轮全气泡 + 19 Agent 漫游 + 零控制台错误 | ✅ |

### Sprint 11.8 — 3.0-D Theater 气泡冻结修复 ✅ 已完成

| 任务 | 工时 | 产出 | 状态 |
|------|:---:|------|:----:|
| Bug 1: visualization_enabled 透传 | 0.25 天 | `client.ts` + `simulationStore.ts` 将 `visualizationEnabled` 参数传给后端 `createScenario` API | ✅ |
| Bug 2: 增量气泡分发竞态修复 | 0.25 天 | `PhaserGame.tsx` store 订阅增加 fallback synth init 逻辑，修复 `synthDone` 竞态条件 | ✅ |
| **Review + 回归测试** | 0.25 天 | **75 前端 tests passing** + **68 后端集成 tests passing** | ✅ |

---

## 十一、Review 与质量保障流程

### 每个 PR 的标准流程

```
1. 编码完成
   ↓
2. 自测（本地 pytest 全通过）
   ↓
3. 代码 Review 检查清单
   ├── □ 功能正确性：核心逻辑是否符合需求？
   ├── □ 向后兼容：现有 API 行为不变？
   ├── □ 错误处理：边界值、异常路径是否覆盖？
   ├── □ 并发安全：asyncio 下无竞态条件？
   ├── □ 性能：无 O(N²) 隐患？（已实证 positions 是唯一 O(N) 项）
   ├── □ 日志：关键操作有日志？（logger.info / warning）
   ├── □ 类型注解：函数签名完整？
   └── □ 文档：docstring 更新？implement/ 文档同步？
   ↓
4. 回归测试
    ├── pytest tests/ （全量单元测试，当前 679）
    ├── pytest tests/test_e2e_matrix.py （真实 API E2E）
   └── 手动测试（前端 + WebSocket）
   ↓
5. 合并
```

### 测试分层策略

| 层级 | 工具 | 覆盖 | 运行频率 |
|------|------|------|---------|
| 单元测试 | pytest | 全部 services + models + api | 每次提交 |
| 集成测试 | pytest + httpx | API 端到端 | 每次提交 |
| E2E 基准测试 | pytest + 真实 LLM | 双模式 × 多配置 | 每周 / 重大改动后 |
| 性能基准 | benchmark_compression.py | 压缩比 / 延迟 / 吞吐 | 每周 |
| 前端 Smoke | 浏览器手动 | 核心交互流程 | 每次前端改动 |
| Docker 集成 | docker compose | 容器化部署 | 每次 Dockerfile 改动 |

### 关键质量指标

| 指标 | 当前值 | 目标 |
|------|:-----:|:----:|
| 单元测试通过率 | 100% (700/700) | 100% |
| 测试用例数 | 700 + 122(前端) | ≥700 |
| E2E API 调用验证 | 598 次 | >1000 次 (Sprint 10 后) |
| 200K 安全阀触发点 | 2,474 agents | 持续验证 |
| BB/RAW 比值 (10A) | 1.83× | 监控不退化 |

---

## 十二、附录 — E2E Benchmark 数据档案

### A. Agent Sweep（固定 3 轮，598 次真实 API 调用）

| Agents | RAW prompt | BB prompt | BB/RAW | BB 增长/round |
|-------:|-----------:|----------:|-------:|:------------:|
| 3 | 6,222 | 7,302 | 1.17× | — |
| 5 | 11,600 | 16,047 | 1.38× | +2,915 |
| 10 | 23,407 | 42,742 | 1.83× | +8,898 |
| 15 | 36,155 | 74,595 | 2.06× | +10,618 |
| 20 | 47,416 | 114,530 | 2.42× | +13,312 |

### B. Round Sweep（固定 10 agents）

| Rounds | RAW total | BB total | BB/RAW | RAW/call | BB/call |
|-------:|----------:|---------:|-------:|---------:|--------:|
| 1 | 4,674 | 4,754 | 1.02× | 467 | 475 |
| 3 | 23,407 | 42,742 | 1.83× | 780 | 1,425 |
| 5 | 42,996 | 82,570 | 1.92× | 860 | 1,651 |
| 8 | 72,385 | 138,862 | 1.92× | 905 | 1,736 |

### C. 关键结论

1. **BB/RAW 比值完全由 agent 数决定** — 线性关系，598 次 API 调用实证
2. **轮次对比值无影响** — R2 后稳定在 ~1.92× (10A)
3. **根因已实证** — `agent_positions` 是唯一 O(N) 增长因子
4. **200K 上下文窗口** — ~2,474 agents 才触发安全阀，绝大多数场景无需优化
5. **不在乎 token 花费** — 当前设计保持全量 positions 以最大化涌现性
