# SwarmOracle Week 1-3 全面 Code Review + 测试

> 对应会话: 代码审查与测试 (b3b62779)

完成对 SwarmOracle 全部后端（Python/FastAPI）和前端（React/TypeScript）代码的严格审查，修复所有发现的 bug 并补全测试覆盖。

## 最终结果

✅ **后端测试**: 108/108 通过 (187.67s)  
✅ **前端 TypeScript 编译**: 0 错误

---

## 修复的 Bug

### 🔴 Critical (3)

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| 1 | `simulator.py` + `simulationStore.ts` | `status` WS 事件后端发 bare string，前端按 `data.status` 读取 | 后端改为 `{"data": {"status": "..."}}` |
| 2 | `simulator.py` + `simulationStore.ts` | `branch_fork` 事件 `children` 传标题当 ID 用 | 后端改传 `{id, title, probability}` 对象数组 |
| 3 | `llm_client.py` | 代码围栏剥离删除所有含 ` ``` ` 的行 | 改为只去掉首尾行 |

### 🟡 Medium (5)

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| 4 | `parser.py` | `assert` 做输入验证（`-O` 时被禁用） | 改为 `raise ValueError` |
| 5 | `simulator.py` | `MAX_BRANCHES` 检查计入已裁剪分支 | 改为只计非 PRUNED 分支 |
| 6 | `simulationStore.ts` | `narration` 事件遗漏 `insight` 字段更新 | 加入 `insight` 更新 |
| 7 | `types.ts` + `simulationStore.ts` + `AgentPanel.tsx` | `msg.agent` 是名字但按 ID 查找 | 新增 `agent_id` 字段并用于查找 |
| 8 | `conftest.py` | 测试间数据库未完全隔离 | `init_db()` 前先 `drop_all()` |

### 🟢 Minor (2)

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| 9 | `scenarios.py` | `create_scenario` 未检查 `_load_scenario_response` 返回 None | 加 None guard + 500 |
| 10 | `simulationStore.ts` | `status` handler 兼容旧格式 | `typeof data === 'string'` 分支 |

---

## 新增测试

| 文件 | 测试数 | 覆盖内容 |
|------|--------|----------|
| `test_simulator.py` | **36** | 全部 DB helper 函数 + corner cases (深分支树、100条消息/轮、长内容、边界概率) |
| `test_narrator.py` | **7** | mock LLM 叙事 (空响应、Unicode、概率格式、reasoning effort) |
| `test_ws.py` | **15** | WSManager 连接/断开/广播/死连接清理/并发 |
| `test_api.py` (增强) | **+7** | 空白问题、错误类型、长 ID、特殊字符 |

**总计: 108 个测试全部通过 ✅**

---

## 修改的文件列表

### 后端
- `backend/app/services/simulator.py` — Bug #1, #2, #5 修复
- `backend/app/services/llm_client.py` — Bug #3 修复
- `backend/app/services/parser.py` — Bug #4 修复
- `backend/app/api/scenarios.py` — Bug #1, #9 修复
- `backend/tests/conftest.py` — Bug #8 修复

### 前端
- `frontend/src/types.ts` — Bug #7 修复
- `frontend/src/stores/simulationStore.ts` — Bug #1, #2, #6, #7, #10 修复
- `frontend/src/components/AgentPanel.tsx` — Bug #7 修复
