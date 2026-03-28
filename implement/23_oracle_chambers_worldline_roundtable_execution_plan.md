# SwarmOracle — 神谕会客厅 / 世界线圆桌 详细设计与实施任务单

> 文档类型：active archive
> 当前真值：是，直到实现落地并并入 `README.md` / `llmdoc/*`
> 阅读方式：本文件按“可直接开工”的执行手册编写，覆盖命名、范围、分阶段开发、测试、review、i18n、跨平台、视觉一致性与素材补齐。
> 当前时间：2026-03-29

---

## 0. 一句话结论

这条扩展线应该被做成 **SwarmOracle 结果页之后的可玩复盘层**，而不是另起一个通用群聊产品。

最小正确闭环是：

`推演结束 -> 结果页每个结局卡进入“结局会客厅” -> 只读取当前世界线全文 -> 可继续围绕该结局复盘`

第二阶段再做：

`多结局完成 -> 发起“世界线圆桌” -> 每条结局只派代表发言 -> 档案官总结`

绝不允许把这条线做成：

- 泛化的多 Agent 聊天平台
- 读写原始 simulation transcript 的第二套入口
- 默认可查看所有世界线全文的“跨线记忆池”
- 为了玩法扩展而破坏现有 `What-If -> Simulation -> Result -> Archive` 主闭环

---

## 1. 产品定位与命名

### 1.1 命名冻结

推荐采用以下命名，不再临时改词：

| 语义层 | 中文 | 英文 | 内部 ID | 说明 |
|---|---|---|---|---|
| 功能总名 | 神谕会客厅 | Oracle Chambers | `oracle_chambers` | 总玩法名 |
| 单结局房间 | 结局会客厅 | Ending Chamber | `ending_chamber` | 结果页单条结局入口 |
| 多结局复盘 | 世界线圆桌 | Worldline Roundtable | `worldline_roundtable` | 多结局代表同台 |
| 轻玩法 1 | 只改一步 | One Move Only | `one_move_only` | 只给单步修正建议 |
| 轻玩法 2 | 异线旁听席 | Crossline Gallery | `crossline_gallery` | 只看异线摘要 |
| 主持角色 | 档案官 | Archivist | `archivist` | 统一主持/总结角色 |

### 1.2 命名原则

- 优先保留 SwarmOracle 现有语域：`Oracle / Archive / Theater / Director / Worldline`
- 避免泛 IM 语义：`聊天室 / 群聊 / room chat / discussion group`
- 避免二次混淆 Debate Arena：不使用 `辩论室 / debate room`
- 保持大众可理解：用户看到名字就知道是“结局之后的复盘玩法”

### 1.3 UX 文案建议

结果页按钮首版推荐：

```yaml
ending_chamber:
  zh:
    primary: 进入会客厅
    secondary: 为什么走到这里
  en:
    primary: Enter Chamber
    secondary: Why This Ending

worldline_roundtable:
  zh:
    primary: 发起圆桌
    secondary: 多结局复盘
  en:
    primary: Start Roundtable
    secondary: Compare Endings

one_move_only:
  zh: 只改一步
  en: One Move Only

crossline_gallery:
  zh: 异线旁听席
  en: Crossline Gallery
```

---

## 2. 设计边界

### 2.1 必须满足的核心边界

1. 原始 simulation transcript 不可变。
2. 结局后讨论是新域，不写回 `Round / AgentMessage`。
3. 单结局会客厅默认只可读当前 `branch_id` 全文。
4. 世界线圆桌默认只允许：
   - 当前代表读取自己世界线全文
   - 他线只读取 `story / insight / key_moments / summary`
5. 除非用户明确发起跨线玩法，否则绝不允许读取其他世界线历史全文。
6. 中英双语必须同时成立，不能做成“中文 UI + 英文生成”或反过来。
7. 新玩法必须沿用当前视觉语言，不单独长出第二套品牌。
8. 若启用流式输出，必须使用“混合流式”，禁止把裸 token 流直接作为正式 transcript。

### 2.2 技术边界

统一作用域键：

```json
{
  "scenario_id": "scn_xxx",
  "anchor_branch_id": "br_xxx",
  "room_type": "ending_chamber | worldline_roundtable | one_move_only | crossline_gallery",
  "participant_set_hash": "sha256(sorted participants + role slots + branch scope)",
  "language": "zh | en"
}
```

所有以下链路都必须按该 key 分桶：

- 持久化
- WS stream
- replay
- import
- 摘要缓存
- 向量检索

### 2.3 与现有域的关系

- 复用主模式：
  - `Scenario`
  - `Branch`
  - `Branch.story / insight / key_moments`
  - 结果页、档案、回放、分享
- 复用 Debate Arena：
  - `phase_insights` 结构
  - `supporting_turns` 结构
  - live/result 展示壳
- 不复用 Debate 的领域语义：
  - `proposition / opposition / judge`
  - `winner / verdict_tone`
  - `prediction / counterplay`

---

## 3. 分阶段开发计划

## 3.1 Phase A — 设计冻结与基础契约

> 状态更新（2026-03-29）：
> - 设计冻结已完成
> - `llmdoc/reference/api.md` 已补 Phase A draft contract
> - `frontend/src/types.ts` 已补公共类型骨架
> - `frontend/src/i18n/locales/{zh,en}.json` 已补命名空间骨架
> - 若下次继续执行，可直接从 Phase B 开始

### 目标

冻结命名、数据模型、权限边界、i18n key、QA 口径。

### 任务

- 新增 `ending room` 域契约文档到 `llmdoc/reference/api.md` 草案。
- 冻结前端公共类型：
  - `EndingRoom`
  - `EndingRoomParticipant`
  - `EndingRoomTurn`
  - `EndingRoomResult`
- 冻结前端 i18n key 命名空间：
  - `ending_room.*`
  - `roundtable.*`
- 在 `progress.md` 顶部保留原始用户需求，并开始记录每轮实现和测试结果。

### 验收

- 团队对命名和玩法边界无分歧
- room scope key 固定
- 不再改 `MVP` 范围

---

## 3.2 Phase B — 后端新域与世界线隔离

### 目标

建立 post-ending 独立数据域，并修正当前 L2 检索的跨世界线污染风险。

### 新增文件

```text
backend/app/models/ending_room.py
backend/app/api/ending_rooms.py
backend/app/services/ending_room_service.py
backend/tests/test_ending_room_service.py
backend/tests/test_ending_room_api.py
backend/tests/test_ending_room_ws.py
```

### 修改文件

```text
backend/app/models/__init__.py
backend/app/models/database.py
backend/app/main.py
backend/app/api/ws.py
backend/app/services/vector_store.py
backend/app/api/scenarios.py
backend/tests/test_vector_store.py
```

### 数据模型建议

```text
ending_room
  id
  scenario_id
  anchor_branch_id nullable
  room_type
  participant_set_hash
  title
  language
  status           # draft/live/done/error
  phase            # opening/crossfire/rebuttal/closing/verdict
  config_json
  result_json
  created_at
  updated_at

ending_room_participant
  id
  room_id
  source_branch_id nullable
  source_agent_id nullable
  role_slot        # agent/representative/archivist/critic/observer
  display_name
  persona_snapshot_json
  visibility_scope_json

ending_room_turn
  id
  room_id
  sequence
  phase
  participant_id
  content
  emotion
  cited_branch_id nullable
  cited_refs_json
  created_at
```

### 服务层要求

- `create_ending_room(...)`
- `load_ending_room_snapshot(...)`
- `load_ending_room_result_payload(...)`
- `run_ending_room_background(...)`
- `build_branch_scope_context(...)`
- `build_roundtable_scope_context(...)`

### 混合流式输出策略

`结局会客厅 / 世界线圆桌` 技术上允许流式输出，但首版只允许 **混合流式**，不允许将裸 token 流直接写入正式数据。

标准链路固定为：

```text
turn_start
-> turn_delta (仅 live UI 使用，节流后的片段流)
-> turn_commit (唯一正式版本，落库 / replay / share / 引文提取都只认它)
```

推荐事件形状：

```yaml
ending_room_turn_start:
  room_id:
  turn_id:
  participant_id:
  phase:
  sequence:

ending_room_turn_delta:
  room_id:
  turn_id:
  participant_id:
  delta:
  chunk_index:

ending_room_turn_commit:
  room_id:
  turn_id:
  participant_id:
  content:
  emotion:
  phase:
  sequence:

ending_room_turn_error:
  room_id:
  turn_id:
  participant_id:
  message:
```

实现约束：

- 复用现有 `llm_call_stream()` 能力，但只接入新 room 域，不反改主模式全链路
- `turn_delta` 只服务 live 文本增长，不参与权威状态、摘要、回放、分享
- `turn_commit` 才能进入：
  - transcript
  - replay
  - import
  - result payload
  - `supporting_turns / phase_insights / quote extraction`
- `turn_delta` 必须节流，建议按 `50-120ms` 或按句号/换行批次 flush
- 断线重连后只恢复 committed turn；未 commit draft 允许丢失，不做强恢复
- 首版流式开关建议：
  - `ending_chamber`：开启
  - `worldline_roundtable`：开启
  - `one_move_only`：可关闭，直接短回复
  - `crossline_gallery`：关闭，保持只读摘要

### 权限与隔离要求

- `ending_chamber`
  - 当前 branch 全文可读
  - 其他 branch 全文不可读
  - 可引用他线摘要，但只能通过摘要字段注入
- `worldline_roundtable`
  - 每个代表只读自己 branch 全文
  - `Archivist` 读取多线摘要，不读取多线全文
- `crossline_gallery`
  - 只读摘要卡和引文
  - 不可访问全文 turn 列表

### 必改：L2 记忆检索

当前向量写入已带 `branch_id`，但检索未按 `branch_id` 过滤。必须新增：

```python
retrieve(
  scenario_id: str,
  query_text: str,
  top_k: int = 5,
  branch_id: str | None = None,
  allowed_branch_ids: list[str] | None = None,
)
```

约束：

- `branch_id` 存在时，只返回该分支记忆
- `allowed_branch_ids` 存在时，只返回白名单分支
- 没有白名单时，默认不放宽到整个 `scenario_id`

### API 设计

```text
POST /api/scenario/{id}/ending-room
GET  /api/ending-room/{room_id}
GET  /api/ending-room/{room_id}/result
WS   /ws/ending-room/{room_id}
POST /api/ending-room/{room_id}/replay-artifact     # 第二阶段可补
```

### 验收

- room 创建可去重
- WS 可连接
- 读取权限正确
- scenario 删除时新域数据一起清理

---

## 3.3 Phase C — 结果页单结局会客厅 MVP

### 目标

让用户在结果页每个结局卡内直接进入当前世界线的后结局复盘。

### 新增文件

```text
frontend/src/components/EndingChatModal.tsx
frontend/src/components/EndingChatModal.css
frontend/src/hooks/useEndingRoomWS.ts
frontend/src/stores/endingRoomStore.ts
frontend/src/lib/endingRoomLabels.ts
frontend/src/lib/endingRoomReplay.ts          # 若首版不做 replay，可延后
frontend/src/components/__tests__/EndingChatModal.test.tsx
frontend/src/hooks/__tests__/useEndingRoomWS.test.tsx
frontend/src/stores/__tests__/endingRoomStore.test.ts
```

### 修改文件

```text
frontend/src/pages/ResultView.tsx
frontend/src/pages/ResultView.css
frontend/src/api/client.ts
frontend/src/types.ts
frontend/src/i18n/*                 # 中文/英文词条
```

### UI 挂点

- 结果页每张 `ending-card`
  - 主按钮：`进入会客厅`
  - 次按钮：`只改一步`
- 结果页顶部工具区
  - 暂不接 `世界线圆桌` 主入口，放到 Phase D

### 交互要求

- narration 未完成时按钮禁用
- replay 模式下允许只读查看，不允许发起新 live room
- 进入 modal 后：
  - 顶部显示结局标题、概率、档案标签
  - 正文显示当前结局 `story / insight`
  - 下方显示会客厅 transcript
  - 可切换：
    - `复盘`
    - `只改一步`
- 若启用流式：
  - draft 文本应在单独“正在发言”气泡中增长
  - commit 后再并入正式 transcript
  - 不允许“一条消息拆成两条正式卡片”

### 实现建议

- 结果页初版不要强依赖 `simulationStore`
- 使用 `scenario.messages` 或 `GET /api/ending-room/{room_id}` 的 transcript
- 如果复用 [BranchDetailModal.tsx](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/components/BranchDetailModal.tsx#L16)，必须将其改为 props 驱动，而不是直接读取 store

### 验收

- 单结局和多结局都能打开会客厅
- transcript 只来自当前世界线
- 中英双语文案正确
- 移动端 `390x844` 下无遮挡、无溢出

---

## 3.4 Phase D — 世界线圆桌

### 目标

多结局场景下，允许用户发起“世界线圆桌”进行跨结局复盘，但不读取他线全文。

### 推荐首版角色数

只做 3 席：

1. `档案官 / Archivist`
2. `结局代表 A`
3. `结局代表 B`

多于两条结局时：

- 默认选概率最高两条
- 其余进入 `异线旁听席`

### 阶段设计

复用 Debate 的阶段节奏，但改文案语义：

| 阶段 | 中文 | 英文 | 说明 |
|---|---|---|---|
| `opening` | 结局回顾 | Ending Recall | 各自陈述为何走到这里 |
| `crossfire` | 分歧交锋 | Fault Line | 指出关键分歧 |
| `rebuttal` | 如果重来 | If Replayed | 给单步修正建议 |
| `closing` | 导演建议 | Director Advice | 给用户/导演建议 |
| `verdict` | 档案总结 | Archive Verdict | 档案官总结 |

### 前端实现建议

复用 Debate 风格页面壳，但不要直接复用 Debate store。

新增文件建议：

```text
frontend/src/pages/WorldlineRoundtableView.tsx
frontend/src/pages/WorldlineRoundtable.css
frontend/src/stores/worldlineRoundtableStore.ts
frontend/src/hooks/useWorldlineRoundtableWS.ts
```

可复用结构：

- 阶段条
- 阶段摘要卡
- room card
- quote frame
- result signal card

### 后端实现建议

不要复用 `Debate` 表。新域只借以下结构：

- `phase_insights`
- `supporting_turns`
- `result payload` 形状

### 验收

- 只读他线摘要，不读他线全文
- 3 席布局在桌面/移动端都成立
- 阶段推进、结果摘要、引文提取都稳定

---

## 3.5 Phase E — Replay / Share / Import

### 目标

让会客厅和圆桌具备与主模式一致的传播链路，但保持只读和权限边界不变。

### 范围

- replay artifact
- permalink
- result share modal
- import 为本地只读记录

### 约束

- replay token / artifact 不包含越权全文
- `crossline_gallery` replay 仍只能看到摘要
- import 后不自动重跑模型

### 验收

- replay 打开后内容和 live 完成态一致
- import 后可在本地只读查看
- 分享文案中英双语正确

---

## 3.6 Phase F — 轻玩法扩展

### 目标

增强可玩性，但不把系统拖成第二产品。

### 玩法列表

1. `结局复盘`
   - 只讨论“为什么会这样”
2. `只改一步`
   - 只允许给一个最小修正建议
3. `异线旁听席`
   - 只读别线摘要和引文

### 设计原则

- 时间短
- 反馈快
- 不重跑整局
- 不制造复杂状态机

---

## 4. 详细任务拆解

## 4.1 后端任务

### B1. 数据模型

- 新建 `ending_room*` 表
- 建索引：
  - `scenario_id`
  - `anchor_branch_id`
  - `room_type`
  - `participant_set_hash`
- 为 `(scenario_id, anchor_branch_id, room_type, participant_set_hash)` 增加去重能力

### B2. API

- 新建 `ending_rooms.py`
- 加输入校验：
  - `anchor_branch_id` 必须属于 `scenario_id`
  - `selected_branch_ids` 不得为空
  - 不允许非结局 branch 创建 `ending_chamber`

### B3. WS

- 新增 `/ws/ending-room/{room_id}`
- 事件形状：
  - `status`
  - `room_turn_start`
  - `room_turn_delta`
  - `room_turn_commit`
  - `room_turn_error`
  - `room_phase_change`
  - `room_result_ready`
  - `heartbeat`
- 顶层 `meta` 沿用现有序列号结构

### B4. 记忆与隔离

- 修 `vector_store.retrieve()`
- 新增 scope builder
- 为会客厅/圆桌构建单独 context builder

### B5. 删除与一致性

- `delete_scenario` 显式清理 `ending_room*`
- 把残留检查加入 delete integrity guard

## 4.2 前端任务

### C1. 类型与 API 客户端

- 扩展 `frontend/src/types.ts`
- 扩展 `frontend/src/api/client.ts`

### C2. 结果页入口

- `ResultView.tsx`
  - 每个结局卡加 CTA
  - narration 未完成时禁用
  - replay 模式下只读

### C3. 单结局会客厅组件

- `EndingChatModal.tsx`
  - transcript
  - 当前结局摘要
  - 模式切换
  - close / share / replay-ready 保留位
  - 若启用流式：
    - `pendingDraftByTurnId`
    - draft -> commit 替换逻辑
    - 自动滚动但不抖动

### D1. 世界线圆桌页面

- `WorldlineRoundtableView.tsx`
  - room cards
  - stage ribbon
  - phase insights
  - quotes
  - result summary
  - 若启用流式：
    - 当前发言席位高亮
    - draft 文本独立展示
    - commit 后进入正式阶段 transcript

### D2. i18n

- 中英双语全部同时落地
- 不允许先写中文后补英文

## 4.3 测试任务

- 补单元测试
- 补 store/hook 测试
- 补结果页行为测试
- 补新 E2E suite
- 补 cross-browser / mobile smoke

---

## 5. Corner Case 清单

以下项目必须逐条实测，不能只看 happy path：

### 5.1 数据与状态

- branch narration 尚未完成时，`进入会客厅` 必须禁用
- scenario 只有 1 条结局时，`世界线圆桌` 的展示策略
- branch 无原始消息，只有 `story / insight`
- branch 被剪枝但仍保留历史消息
- agent 信息缺失时 participant fallback
- 删除 scenario 后，已打开 room 的错误态

### 5.2 隔离与权限

- `ending_chamber` 不读取他线全文
- `worldline_roundtable` 不读取他线全文
- `crossline_gallery` 不显示全文 transcript
- replay/import 不扩大权限边界
- L2 向量检索不串 branch

### 5.3 WS 与并发

- 双标签同时创建同 scope room
- 重连后 turn 不重复
- 页面刷新后 room 恢复正确
- 背景任务失败时前端能见错误，不 silent fail
- `turn_delta` 丢包后，`turn_commit` 仍能正确收口
- 迟到的 `turn_delta` 不能覆盖已 commit 内容
- draft 气泡不能因 sequence 重放生成重复卡片

### 5.4 i18n

- 中文问题 -> 中文生成 + 中文 UI
- 英文问题 -> 英文生成 + 英文 UI
- 长英文按钮在移动端不溢出
- 长中文结局标题不溢出
- 流式中文分句不应出现明显断裂或半个标点单独闪烁
- 流式英文长句换行不应引发 layout 抖动

### 5.5 响应式

- `1600x900`
- `1280x800`
- `1024x768`
- `430x932`
- `390x844`
- `375x812`

### 5.6 只读与回放

- replay 模式禁止 live room 创建
- imported room 只读
- share 后打开结果一致

---

## 6. 测试、QA 与技能使用方案

## 6.1 必用技能

本条实现必须显式使用以下技能/能力：

1. `develop-web-game`
   - 用于新玩法的实现后验证循环
   - 要求：
     - 维护 `progress.md`
     - 每轮改动后运行 Playwright 客户端动作
     - 检查 `render_game_to_text()` 与截图
     - 对流式场景额外覆盖：
       - `turn_start` 截图
       - `turn_delta` 中间态截图
       - `turn_commit` 结束态截图
2. `playwright-interactive`
   - 用于桌面/移动端持续调试
   - 必须写 QA inventory，再做功能 QA + 视觉 QA
   - 对流式场景专项检查：
     - 文本增长是否平滑
     - draft / commit 替换是否正确
     - 小屏滚动跟随是否稳定
3. `Playwright CLI Skill`
   - 用于快速 smoke、按钮文案、路由、modal、只读态检查
4. `teach-impeccable`
   - 本项目已有 `.impeccable.md`，本轮不需要再问用户新设计问题
   - 实施时必须遵守其设计原则，不得单独长出新品牌语言

## 6.2 现有 E2E 基建复用

仓库已有：

- `frontend/scripts/e2e-suite.mjs`
- `frontend/scripts/e2e-debate-suite.mjs`
- `window.render_game_to_text()`
- `window.advanceTime(ms)`

新玩法应新增：

```text
frontend/scripts/e2e-ending-room-suite.mjs
```

运行命令建议：

```bash
cd frontend
node scripts/e2e-ending-room-suite.mjs desktop --url http://127.0.0.1:18928 --output-dir output/e2e/ending-room-desktop --headless
node scripts/e2e-ending-room-suite.mjs mobile --url http://127.0.0.1:18928 --output-dir output/e2e/ending-room-mobile --headless
node scripts/e2e-ending-room-suite.mjs full --url http://127.0.0.1:18928 --output-dir output/e2e/ending-room-full --headless
```

## 6.3 QA Inventory 模板

每轮实施前先列 inventory：

```yaml
claims:
  - 结果页每张结局卡可进入会客厅
  - 会客厅只读取当前世界线全文
  - 世界线圆桌只读取他线摘要
  - 中文/英文都自然、无溢出
  - 390px 移动端可用
  - 流式时 draft 与 commit 状态一致且不重复

controls:
  - 进入会客厅
  - 关闭会客厅
  - 发起圆桌
  - 切换阶段
  - 打开旁听席
  - replay 打开

state_checks:
  - loading -> live -> done
  - single ending -> chamber
  - multi ending -> roundtable
  - replay -> read only
  - zh -> en locale
  - turn_start -> turn_delta -> turn_commit

exploratory:
  - 多标签同时开同一个房间
  - room 运行中刷新页面
  - 切英文后重新进入结果页
  - 在流式过程中关闭再重开 modal
  - 在流式过程中刷新页面观察 committed turn 恢复
```

## 6.4 发布前命令合同

### Backend

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_ending_room_service.py tests/test_ending_room_api.py tests/test_ending_room_ws.py tests/test_vector_store.py tests/test_api.py -q
python -m ruff check --ignore E501 app/api/ending_rooms.py app/services/ending_room_service.py app/services/vector_store.py tests/test_ending_room_service.py tests/test_ending_room_api.py tests/test_ending_room_ws.py
```

### Frontend

```bash
cd frontend
npm test -- --run src/pages/ResultView.test.tsx src/components/EndingChatModal.test.tsx src/hooks/useEndingRoomWS.test.tsx src/stores/endingRoomStore.test.ts src/i18n/locales.test.ts
npx tsc --noEmit -p tsconfig.app.json
npm run build
node scripts/e2e-suite.mjs corners --url http://127.0.0.1:18928 --output-dir output/e2e/post-ending-corners --headless
node scripts/e2e-suite.mjs cross-browser --url http://127.0.0.1:18928 --output-dir output/e2e/post-ending-cross-browser --headless
node scripts/e2e-ending-room-suite.mjs full --url http://127.0.0.1:18928 --output-dir output/e2e/post-ending-room --headless
```

流式专项建议：

```bash
cd frontend
node scripts/e2e-ending-room-suite.mjs full --url http://127.0.0.1:18928 --output-dir output/e2e/post-ending-room-streaming --headless --require-streaming
```

---

## 7. Review Gate

## 7.1 架构 Review

- 是否新增独立 `ending room` 域
- 是否所有读取路径显式带 scope key
- 是否 replay/import 仍保持相同权限边界
- 是否没有把新玩法写回原始 simulation transcript

## 7.2 实现 Review

- 是否存在重复 room / 重复 turn / 重复 WS 事件
- 是否存在 draft / commit 错位或迟到 delta 覆盖 commit
- 是否移动端入口、正文、按钮无裁切
- 是否 replay 只读态可靠
- 是否所有中英 copy 都有对应 key

## 7.3 QA Review

- 每个 claim 有对应截图
- `render_game_to_text` 与屏幕状态一致
- console 无新增报错
- 至少完成一次探索式测试
- 对启用流式的页面，必须同时保留：
  - draft 中间态截图
  - commit 完成态截图
  - 对应 `render_game_to_text` 状态

## 7.4 发布 Gate

以下任一失败即不得签收：

- 读取到其他世界线全文
- replay/import 权限边界失真
- 中英文串语
- `390px` 关键入口不可用
- 新增 console error / unhandled rejection
- 流式 draft 与最终 commit 不一致
- 迟到 delta 覆盖已 commit 内容

---

## 8. 美术与素材计划

## 8.1 视觉原则

遵守 `.impeccable.md`：

- cinematic
- tactical
- legible

不得做：

- 通用社交聊天视觉
- 明显偏离现有档案馆/指挥室/像素剧场调性的新风格
- 过度发光或过度装饰影响状态阅读

## 8.2 优先复用现有资产

先从以下资产体系复用：

- `archive_panel`
- `archive_seal`
- `debate_stage_banner`
- `debate_quote_frame`
- `gameplay_panel`
- `badge_*`

参考：

- `frontend/src/lib/themeRegistry.ts`

## 8.3 缺口资产清单

若现有资产不足，再补以下最小集合：

```text
ending_room_panel
worldline_roundtable_banner
badge_ending_chamber
badge_worldline_roundtable
badge_crossline_gallery
timeline_marker_chamber
timeline_marker_roundtable
```

## 8.4 AI 素材生成流程

已获用户批准将 Google 图像线路纳入实施方案。

执行顺序必须固定：

1. 先盘点缺口
2. 只生成缺的 UI asset
3. 优先 `gemini-3.1-flash-image-preview`
4. 细节不够再升 `gemini-3-pro-image-preview`
5. 生成后写 provenance sidecar
6. 跑：

```bash
cd frontend
npm run assets:provenance:check
```

注意：

- 不在本执行文档中内嵌任何密钥
- 实际调用时通过环境变量或本地安全配置注入
- 生成风格需与现有档案/圆桌/UI frame 调性对齐

---

## 9. 可玩性验收标准

只有满足以下全部条件，才能声称“功能正常实现，且确实可玩”：

1. 单结局会客厅可以稳定进入、退出、重开
2. transcript 与当前世界线一致
3. 世界线圆桌的代表逻辑可理解、结果可复盘
4. `只改一步` 在 30 秒内给出清晰建议
5. `异线旁听席` 轻量、清楚、不泄露他线全文
6. 中英双语都自然
7. 桌面/移动主流浏览器中 UI 不裁切、不失真
8. 无新增显性或隐性跨世界线污染
9. 若开启流式，用户能感知到“正在发言”，但最终 transcript、replay、share 只依赖 committed turn

---

## 10. 建议执行顺序

推荐严格按以下顺序推进，不要并行硬上所有阶段：

1. Phase A：冻结命名、契约、i18n key
2. Phase B：后端新域 + L2 隔离修复
3. Phase C：结果页单结局会客厅 MVP
4. Phase C 回归测试 + cross-browser + mobile
5. Phase D：世界线圆桌
6. Phase D 回归测试 + visual QA
7. Phase E：replay/share/import
8. Phase F：轻玩法扩展
9. 资产补齐与 provenance 收口
10. 最终 `release:signoff`

如果资源有限，首个可交付里只做：

- `结局会客厅`
- `只改一步`
- 必要 i18n
- 桌面 + 移动 E2E

把 `世界线圆桌` 放到第二个迭代里，会更稳。
