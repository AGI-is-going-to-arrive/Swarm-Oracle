# 上下文优化方案可行性分析

> 基于 SwarmOracle 全量代码审查后的逐行评估

---

## 一、当前代码数据流全图

```
parse_question()
  -> Scenario + Agents 存入 DB
  -> run_simulation()
      +-- 每轮 loop:
      |   +-- _gather_agent_messages()        <- 核心瓶颈所在
      |   |   +-- _get_recent_messages(max_rounds=2)  <- 取最近 2 轮所有消息
      |   |   +-- format_messages_for_context(max_recent=6) <- 最多 6 条
      |   |   +-- build_agent_context()              <- 静态字符串模板
      |   |   +-- llm_call_json() x N agents (并发=5)
      |   |
      |   +-- _compress_round_memory()  (每5轮)  <- compress_rounds() LLM压缩
      |   +-- _detect_fork()                    <- 取最近 3 轮 max_recent=15 条
      |
      +-- narrate_branch() -> 每个分支写故事
```

## 二、核心设计原则

> **所有 Agent 必须看到同一份共享上下文**。不做按角色过滤，保持群体讨论的涌现性。跨领域启发（军事 Agent 受经济观点触发分歧）是项目核心价值。

## 三、逐 Phase 可行性判定

### Phase 1: 结构化压缩 + 全局态势简报 -- OK 完全可行

**改动范围**：仅 [memory.py](file:///Users/yangjunjie/Desktop/test/backend/app/services/memory.py) 的压缩 prompt

#### 当前代码的关键约束：

| 约束点 | 代码位置 | 分析 |
|--------|---------|------|
| `COMPRESS_PROMPT` | `memory.py:11-22` | 当前输出 `summary/key_positions/tension_level/unresolved_issues`，**可直接增强** |
| `compress_rounds` 调用方 | `simulator.py:350` | 只在 `_compress_round_memory` 中调用，**单点入口** |
| 返回值格式 | `memory.py:38-43` | dict 格式，改字段名不影响调用方（调用方只 `str()` 存入 DB） |
| `_save_round_summary` | `simulator.py:501-510` | 接收 `str(summary)` 存入 `Round.compressed_summary`，**与压缩格式解耦** |

#### 具体改动：

```python
# memory.py L11-22 — 仅改 prompt 内容 + 输出字段

# 当前:
COMPRESS_PROMPT = """将以下 Agent 发言压缩为结构化摘要:
...
输出: {summary, key_positions, tension_level, unresolved_issues}
"""

# 改为:
COMPRESS_PROMPT = """将以下讨论压缩为"态势简报"，重点保留分歧和转折信号:
...
输出: {situation, active_debates, key_quotes, tension_points, consensus}
"""
```

#### 为什么零风险：

1. **调用链完全解耦**：`_compress_round_memory()` 拿到 dict 后直接 `str()` 存 DB，不解析字段
2. **下游无依赖**：`compressed_summary` 字段是 Optional[str]，前端不读取此字段
3. **`build_agent_context` 不变**：所有 Agent 仍看到完全相同的上下文（符合涌现性原则）
4. **DB 模型零改动**：`Round.compressed_summary` 仍是 str 类型
5. **现有 142 个测试全部不受影响**

#### 预期效果：

- 压缩信息保真度：5% -> ~40%（关键原话 + 冲突焦点被显式保留）
- 分歧检测质量提升：`tension_points` 可直接与 `_detect_fork` 联动
- 改动量：~30 行（纯 prompt 修改）

---

### Phase 2: Blackboard 共享空间 -- 可行但有 3 个约束需处理

#### 约束 1: `_gather_agent_messages` 的并发模型

```python
# simulator.py:319-320
tasks = [process_agent(a) for a in agents]
results = await asyncio.gather(*tasks)
```

**问题**：当前所有 Agent 并发执行，Blackboard 需要"读->改->写"原子性。
**方案**：用批量写模式（最小改动）。

```python
# 方案: 先并发执行 -> 批量写黑板
results = await asyncio.gather(*tasks)
for msg in results:
    blackboard.post(msg["agent_id"], msg["content"], msg["emotion"])
```

**可行性**：OK，`asyncio.gather` 返回结果后统一写入，无需改并发模型。

#### 约束 2: 分支 (Branch) 上下文隔离

```python
# simulator.py:108 — 当前按 branch 遍历
for branch_info in active_branches:
    branch_id = branch_info["id"]
    # ... 每个 branch 独立处理
```

**问题**：Blackboard 需要 **per-branch** 独立，不能跨分支共享。
**方案**：`blackboards: dict[str, Blackboard]`，key = branch_id。fork 时从 parent 复制。

**可行性**：OK，但需新增 `blackboard.py` (~100 行) + 改 `simulator.py` (~50 行)

#### 约束 3: DB 存储 & 前端兼容

- 当前 `AgentMessage` 表存原始消息，Blackboard 是内存缓存
- WebSocket 推送 `agent_speak` 事件给前端 — Blackboard 摘要是**附加信息**，不替代原始消息
- 前端不需要改 — Blackboard 纯后端优化

**可行性**：OK，Blackboard 是纯运行时内存结构，不影响 DB 和前端

#### Phase 2 总结：

| 维度 | 评估 |
|------|------|
| 新增代码 | `blackboard.py` ~100 行 |
| 改动代码 | `simulator.py` ~50 行, `memory.py` ~20 行 |
| DB 改动 | 无 |
| 前端改动 | 无 |
| 测试影响 | 需新增 `test_blackboard.py`, 现有测试不破坏 |
| 涌现性 | OK — 所有 Agent 共读同一块黑板 |
| **总体可行性** | **可行，建议 Phase 1 验证效果后再做** |

---

### Phase 3: 树型拓扑 -- 当前不建议，组间壁垒会伤害涌现性

#### 技术障碍

| 障碍 | 详情 |
|------|------|
| `run_simulation` 单入口 | 整个推演是一个 async 函数，无分组子循环 |
| Agent 模型无 group 字段 | DB migration + 前端适配 |
| fork 检测基于全局消息 | 需改为 Leader 汇报机制 |

#### 涌现性风险

更重要的是，**组间信息壁垒**会切断跨领域启发。例如：

- 军事组 Agent 无法直接听到经济组的讨论 -> 失去"经济制裁触发军事转向"的涌现
- 只靠 Leader 摘要传递 -> 信息经两层压缩，细节丢失严重

**结论**：当前 <= 30 Agent 规模无需此方案，且代价大于收益。

---

## 四、结论

| Phase | 可行性 | 改动量 | 涌现性 | 建议 |
|-------|--------|--------|--------|------|
| **Phase 1** | 完全可行 | ~30 行 | OK 保持共享 | **立即做** |
| **Phase 2** | 可行需处理约束 | ~170 行 | OK 共读黑板 | Phase 1 后做 |
| **Phase 3** | 需重构 | ~800 行 | 有风险 | 暂不考虑 |

**Phase 1 可立即执行**：只改 `COMPRESS_PROMPT` 和 `compress_rounds` 返回值处理，零架构风险，零 DB 改动，零前端改动。
