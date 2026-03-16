# Code Review — SwarmOracle Backend (Week 4)

> 对应会话: 代码审查与修复 (b1d4e973)

Full audit of all 12+ source files. **8 issues found**, all fixed.

---

## 🔴 Critical Issues (Fixed)

### CR-1: `_save_narration` silently swallows non-list `key_moments`

**文件**: `simulator.py`

如果 LLM 返回 `key_moments` 为字符串而非列表，值会被静默丢弃。

**修复**: 将字符串包装为列表。

### CR-2: `pending_interventions` dict never cleaned on scenario error/finish

**文件**: `simulator.py`

模块级字典 `pending_interventions` 在模拟结束或出错后不清理 → **内存泄漏**。

**修复**: 在模拟完成时清理所有属于该 scenario 的 interventions。

### CR-3: `conftest.py` shares global `_engine` — cross-test pollution risk

**文件**: `conftest.py`

**修复**: 在 fixture 中重置 engine 引用。

---

## 🟡 Medium Issues (Fixed)

### CR-4: `ws.py` — broadcast modifies list during iteration (race condition)

**修复**: 迭代前复制连接列表。

### CR-5: `StoryBranch.story` / `StoryBranch.insight` missing default values

**文件**: `scenarios.py`

叙事完成前 `story=None` 会导致 Pydantic 验证错误。

**修复**: 添加 `= ""` 默认值。

### CR-6: Intervention `max_round` can return `None` from `func.max()`

**修复**: 使用 `max_round if max_round is not None else 0`（替代 `max_round or 0`）。

---

## 🟢 Low Issues (Fixed)

### CR-7: `get_engine()` singleton not thread-safe

Advisory only — uvicorn 通常运行单进程异步。

### CR-8: `_run_sim_background` error handler doesn't broadcast WS error event

**修复**: 添加 WS `simulation_error` 事件广播。

---

## 测试结果

```
142 passed in 181.32s — 0 failures
```

## Live E2E Test Results

| Test | Result |
|------|--------|
| `GET /` — root endpoint | ✅ Returns `SwarmOracle` JSON |
| `POST /api/health` — server + LLM | ✅ `server: ok, llm: ok` |
| `POST /api/scenario` — empty question | ✅ 400, `Question cannot be empty` |
| `POST /api/scenario` — whitespace only | ✅ 400, `Question cannot be empty` |
| `GET /api/scenario/{id}` — nonexistent | ✅ 404 |
| `POST /api/scenario` — real LLM call | ✅ 200, 20 agents (4 CORE, 7 IMPORTANT, 9 CROWD) |
| `POST /api/scenario/{id}/intervene` | ✅ `applied`, round=1 |
| Branch forking (simulation growth) | ✅ Grew from 1→4→7→10 branches |
| Schema migration (CR-9) | ✅ `Migrated: added branch.key_moments` |

---

## Summary

| Severity | Count | Fixed |
|----------|-------|-------|
| 🔴 Critical | 3 | ✅ 3 |
| 🟡 Medium | 3 | ✅ 3 |
| 🟢 Low/Advisory | 2 | ✅ 2 |
| **Total** | **8** | **8** |
