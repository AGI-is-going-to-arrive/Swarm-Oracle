# SwarmOracle Week 4 — 实现计划

> 对应会话: 代码审查与修复 (b1d4e973)

Complete remaining frontend features (AgentPanel, ResultView, InterventionModal), wire the "Butterfly Effect" backend, add Docker Compose deployment, documentation, and comprehensive testing.

---

## Backend — Intervention & Story API

### [MODIFY] `database.py`
- 新增 `InterventionLog` model: `id`, `scenario_id`, `branch_id`, `round_number`, `user_input`, `created_at`

### [MODIFY] `scenarios.py`
- **实现** `POST /api/scenario/{id}/intervene`：验证场景/分支状态 → 保存日志 → 注入模拟 → WS 广播
- **新增** `GET /api/scenario/{id}/story`：返回所有已完成分支的故事/洞察/关键时刻
- **新增** `GET /api/scenario/{id}/agents`：返回场景的所有 Agent

### [MODIFY] `simulator.py`
- 在每轮模拟前检查 pending interventions
- 将干预文本作为 "NARRATOR" 系统消息注入

---

## Frontend — AgentPanel 增强

### [MODIFY] `AgentPanel.tsx`
- 确定性像素头像（name → hue/saturation/lightness 5×5 网格）
- 发言气泡样式
- 情绪颜色指示（green=calm, red=angry, blue=sad, yellow=excited）
- 自动滚动到最新消息

---

## Frontend — ResultView

### [NEW] `ResultView.tsx`
- **Header**: 场景问题 + 完成统计
- **Ending Cards Grid**: 每个完成分支的卡片（标题、摘要、概率条、洞察）
- **Story Reader**: 全文故事展开，高亮关键时刻
- **Agent Roster**: 所有参与 Agent 的最终状态

### [NEW] `ResultView.css`
- 卡片网格、概率条、故事排版、响应式设计

---

## Frontend — InterventionModal（蝴蝶效应）

### [NEW] `InterventionModal.tsx`
- 右键或按钮触发的模态框
- 显示分支名称、当前轮次、干预文本输入
- 调用 `intervene()` API，成功后关闭 + GSAP 动画

### [MODIFY] `BranchTree.tsx`
- 活跃分支节点添加 "⚡ Intervene" 按钮

---

## Docker Compose

### [NEW] `backend/Dockerfile`
- Python 3.13-slim base, install deps, expose 8000

### [NEW] `frontend/Dockerfile`
- Node 22-alpine build → nginx serve, expose 80

### [NEW] `docker-compose.yml`
- 服务: `backend` (port 8000), `frontend` (port 80 → proxy to backend)
- Volumes for SQLite DB and ChromaDB persistence

---

## Documentation

### [NEW] `README.md` + `README_CN.md`
- 项目概览、架构图、快速启动、特性列表
