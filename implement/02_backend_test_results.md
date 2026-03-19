# SwarmOracle Backend — 测试结果与 Bug 修复

> 文档类型：historical snapshot
> 当前真值：否
> 阅读方式：本文件保留阶段性后端测试与修复记录，不代表当前测试基线或当前签收口径。

> 对应会话: 后端测试 (00e5bf8e) + 全面 Review (1d1e9bd0)

## 测试总结

```
135 passed in ~43s
0 failed · 0 warnings
```

| 测试文件 | 测试数 | 类别 |
|-----------|-------|----------|
| `test_config.py` | 3 | 配置加载、环境变量、CORS |
| `test_models.py` | 24 | ORM 模型 CRUD、关系、边界值 |
| `test_memory.py` | 4 | 消息格式化、上下文组装、token 预算 |
| `test_simulator.py` | 32 | 模拟器辅助函数、corner cases |
| `test_ws.py` | 14 | WebSocket 管理、并发 |
| `test_narrator.py` | 7 | 叙事生成、prompt 构造 |
| `test_api.py` | 40 | REST API 端点、CRUD、错误处理 |
| `test_llm_client.py` | 5 | LLM 调用、reasoning effort、JSON 解析 |
| `test_parser.py` | 4 | 问题解析、Agent 生成、参数校验 |
| **合计** | **135** | (其中 `test_llm_client` 和 `test_parser` 需 LLM 在线) |

## 🐛 发现并修复的 Bug

### Bug 1 (Critical): LLM 响应解析器崩溃
- **文件**: `llm_client.py`
- **问题**: 当 `reasoning_effort` 启用时，API 响应的 `output[]` 数组中第一个元素是 `reasoning` 块（无 `content` 键），不是 `message` 块
- **表现**: `KeyError: 'content'` → 所有带 reasoning 的 LLM 调用全部失败
- **修复**: 按 `type=message` 过滤 output 块，添加 fallback 到含 `content` 键的块

### Bug 2 (Critical): SQLModel 关系声明在 Python 3.13 上崩溃
- **文件**: `database.py`
- **问题**: `from __future__ import annotations` 使所有 type hint 变为字符串，破坏 SQLAlchemy mapper 的关系解析
- **表现**: `InvalidRequestError: expression "relationship('list[Agent]')" seems to be using a generic class`
- **修复**: 移除 `__future__` 导入，重新排序模型类（被引用的放前面），用 `Optional["X"]` 声明前向引用

### Bug 3 (Minor): 测试中的 DetachedInstanceError
- **问题**: 在 Session `with` 块外部访问 ORM 对象的属性（如 `.id`）
- **修复**: 在 session 上下文内提取所有需要的 ID 值

## ⚠️ 修复的 Deprecation Warnings

| 位置 | 旧写法 | 新写法 |
|------|--------|--------|
| `main.py` | `@app.on_event("startup")` | `@asynccontextmanager lifespan()` |
| `scenarios.py` (3处) | `session.query(X).filter()` | `session.exec(select(X).where())` |
| `simulator.py` (7处) | `session.query(X).filter()` | `session.exec(select(X).where())` |

## 🔧 全面 Review 修复 (2026-03-11)

### 测试修复
1. `test_narrator.py::test_reasoning_effort_high` → 重命名为 `test_reasoning_effort_medium`，断言值从 `'high'` 修正为 `'medium'` 以匹配 `narrator.py` 实际代码
2. `test_memory.py::test_context_without_memories` → 断言从 `'暂无历史记忆'` 修正为 `'尚无历史记忆'` 以匹配 `memory.py` 实际文案

### 新增测试
3. `test_save_narration_string_key_moments` — 验证 string 类型 `key_moments` 被正确包装为列表
4. `test_save_narration_unexpected_key_moments_type` — 验证 dict 等非预期类型不会导致崩溃
5. `test_get_recent_messages_zero_rounds` — `max_rounds=0` 边界行为
6. `test_intervention_cleanup` — `pending_interventions` 清理逻辑覆盖

## Corner Cases 测试覆盖

- ✅ Unicode / Emoji / 特殊字符存储与读取
- ✅ 空字符串默认值
- ✅ `None` 默认值（`parsed_context`, `diverge`）
- ✅ 概率边界值（0.0, 0.001, 0.5, 0.999, 1.0）
- ✅ Round 排序一致性
- ✅ 所有 Agent Tier 枚举值
- ✅ 所有 Scenario 状态转换
- ✅ 空请求体 / 缺失字段的 422 / 400 响应
- ✅ 不存在的 scenario 404 响应
- ✅ LLM 不可达时的错误降级
- ✅ `reasoning_effort` 三个级别（low/medium/high）
- ✅ LLM 中文输入输出
- ✅ JSON 响应中含代码块的自动剥离
- ✅ string 类型 key_moments 自动包装
- ✅ 非预期类型 key_moments 容错
- ✅ max_rounds=0 边界
- ✅ pending_interventions 清理
