# SwarmOracle — 实时流式输出修复 + UX 改进

> 文档类型：historical snapshot
> 当前真值：否
> 阅读方式：本文件保留单轮功能修复快照，不代表当前产品合同或当前测试口径。

> 对应会话: 当前会话 (1094675f)

---

## 1. 修复流式输出 Bug（不再显示原始 JSON）

**问题**: `agent_speak_delta` 事件会把 LLM 返回的 JSON token 片段直接展示在界面上，导致用户看到乱码。

**方案**: 移除 `agent_speak_delta`，保留 per-agent 即时推送模式：
- 每个 Agent 开始时推送 `agent_speak_start`（前端显示"思考中…"动画）
- Agent 完成后推送 `agent_speak`（前端显示完整消息）

**改动文件**:
- `backend/app/services/simulator.py` — 移除 stream 调用，改用 `llm_call_json`
- `frontend/src/stores/simulationStore.ts` — `streamingAgents` → `thinkingAgents`
- `frontend/src/components/BranchDetailModal.tsx` — 使用 `thinkingAgents` 显示思考状态

---

## 2. 推演轮数用户自选（滑块 3-40）

用户现在可以通过滑块选择 3-40 轮推演，默认 5 轮。界面显示当前值和预估时间。

**改动文件**:
- `frontend/src/pages/InputView.tsx` — 新增滑块 UI（替代原来的 5 个按钮）
- `frontend/src/pages/InputView.css` — 滑块轨道/拇指/值标签样式
- `frontend/src/api/client.ts` — API 传递 `rounds` 参数
- `backend/app/api/scenarios.py` — 后端接收并注入轮数
- `backend/app/config.py` — `MAX_ROUNDS` 从 15 提升到 40

### 滑块 UI 特性
- 范围: 3-40 轮
- 默认值: 5 轮
- 实时显示当前值
- 速度/时间提示: ⚡ 快速 ≈6min / ⏱ 标准 ≈12min / 🔬 详细 ≈24min / 🏔️ 深度 ≈48min
- `aria-label` 无障碍支持

---

## 3. 分支卡片标题增加描述

**问题**: 标题过短（4-5 字），用户难以理解分支走向。

**方案**:
- 提示词中标题长度从"8字以内"放宽到"6-12字"
- 后端 WSEvent 中新增 `description` 字段
- 前端 BranchNode 标题下方显示一行描述文字

**改动文件**:
- `backend/app/services/simulator.py` — 放宽标题 + 传递 description
- `frontend/src/types.ts` — `BranchInfo` + `WSEvent` 新增 description
- `frontend/src/components/BranchNode.tsx` — 渲染描述
- `frontend/src/components/BranchNode.css` — 描述样式
- `frontend/src/components/BranchTree.tsx` — 传递 description 到节点

---

## 验证

- ✅ TypeScript 编译无错误（`npx tsc --noEmit`）
- ✅ 前端页面正常渲染
- ✅ 轮数滑块工作正常（3-40 范围）
- ✅ 不再显示原始 JSON 乱码
