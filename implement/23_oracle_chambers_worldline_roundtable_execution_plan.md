# SwarmOracle — 神谕会客厅 / 世界线圆桌 详细设计与实施任务单

> 文档类型：active archive
> 当前真值：是，直到实现落地并并入 `README.md` / `llmdoc/*`
> 阅读方式：本文件按“可直接开工”的执行手册编写，覆盖命名、范围、分阶段开发、测试、review、i18n、跨平台、视觉一致性与素材补齐。
> 当前时间：2026-03-31
> 状态更新（2026-03-31，最新）：single-ending chamber / one-move、follow-up thread、`WorldlineRoundtableView` 的 live / reseat / replay readonly 已落地，并已进入稳定 `release:signoff` 总链；follow-up 现已升级成“后端优先真流式 + provider 探测 fallback”的 mixed-streaming 链路；Oracle 文案层已继续补到 `角色化 + 题材化 + 去重复`，并已扩到 `finance / market / faith / industry / frontier / survival / scholar` 这些语域；前端也已接入 profile skin + hook chips + 轻量氛围动效，并补了更清晰的 roundtable mobile 顶部状态带。`crossline_gallery`、`manual_shortlist`、`expert_witness`、`trait_mix`、`fault_line_first`、`witness_augmented` 当前都已形成最小可玩闭环；ending-room / roundtable 的 replay/share/import 已重新完成一轮桌面 + mobile 专项签收。单结局结果页当前也已重新人工核对：只保留 `进入会客厅 / 只改一步`，不再展示 `发起圆桌 / 异线旁听席`。Oracle fresh live room 的英文 deterministic copy 也已补去混句兜底。额外增量：`legend-talk` 借鉴的“低摩擦工作台动作”当前已项目化落地成 Oracle 自己的 `继续追问 / 另开线程 / 复制纪要 / transcript quote 级追问`；`quote / verdict / key_moment / phase` 当前都已统一进显式 `questionAnchorIds` 合同，thread/create 与 user-turn/send 两条链都能持久化锚点语义；`mobile roundtable artifact replay readonly` 的 timeout 也已定位并修复，当前重新回到 `hotseat + active_thread_id` 可恢复口径。本轮再补：0.3 的锚点可观测性、thread/read-only 回显测试、自动化 summary 字段已全部落地；`trait_mix / fault_line_first / witness_augmented` 的选择状态也已补幂等保护，避免重复写回同一份 selection。本 session 再补：`endingRoomStore` 当前会在 committed turn / room-thread hydrate 时清 stale draft，迟到 `turn_start / turn_delta` 不再复活 ghost bubble；`llm_call_stream()` 的 `estimated_tokens` 预估已补回，Oracle follow-up stream probe 不再因为变量缺失误触发 fallback。继续补：classic automation 当前已能直接看到 `thinkingAgentCount / thinkingAgents`；`EndingChatModal / WorldlineRoundtableView` 的 automation 当前会额外输出 `current_speaker_turn_key / current_speaker_participant_id / pending_drafts / stream_state`；backend 当前也会在 Oracle delta 广播和 turn 落库前先剥掉 `<think>` reasoning block。脚本侧当前已补更稳的 Oracle E2E teardown、quote-anchor 交互链、hotseat settle 等待与 per-mode fixture 选择；`followup full` 当前能稳定落盘新 `summary.json`，`roundtable` desktop / mobile rerun 当前都已重新跑通 anchored follow-up；mobile rerun 也已重新抓回 `turn_delta`。另补：`corners` rerun 当前已能稳定落 `result.json`，剩下只是一条 teardown warning 噪音。desktop live-room 当前还补了一轮轻量可读性收口：summary 左栏更窄、summary card sticky、长摘要走内部滚动、transcript 行距更松。本 session 再补：roundtable committed transcript 长段当前已支持折叠 / 展开；transcript `quote` 级动作当前还可直接切到 `点名这位代表 / Hotseat this rep`；`endingRoomStore.hydrateThread()` 当前会同步更新 `snapshot.threads`，Firefox / WebKit 下 anchored thread replay / local readonly / reload restore 不会再退回旧主桌；`transcript_layout` 当前也已补 `collapsible_turn_count / collapsed_turn_count`，能区分“有长段”和“长段已被 UI 收口”。本次再补：roundtable verdict / follow-up fallback 改成可直接展示的人话，不再泄漏 prompt 指令或模式标签；`thread_followup` prompt 会钉在 active thread 与当前 anchor；`evidence_card` assistant turn 会保留用户引用的世界线；phase insight 和 phase prompt 会把长段复述压成一句；post-verdict `1-on-1 Interview` 会先展示代表 profile，并把可读 `origin_excerpt` 交给 conversation。

---

## 0. 一句话结论

这条扩展线应该被做成 **SwarmOracle 结果页之后的可玩复盘层**，而不是另起一个通用群聊产品。

最小正确闭环是：

`推演结束 -> 结果页每个结局卡进入“结局会客厅” -> 只读取当前世界线全文 -> 自动复盘 -> 用户可继续围绕该结局追问当前世界线参与者`

第二阶段当前已落地的最小闭环是：

`多结局完成 -> 发起“世界线圆桌” -> 每条结局派 1 名代表 -> 档案官主持并总结 -> 支持改选重开 / live follow-up / 只读 replay`

绝不允许把这条线做成：

- 泛化的多 Agent 聊天平台
- 读写原始 simulation transcript 的第二套入口
- 默认可查看所有世界线全文的“跨线记忆池”
- 为了玩法扩展而破坏现有 `What-If -> Simulation -> Result -> Archive` 主闭环

## 0.1 当前真值（2026-03-31，覆盖旧状态）

下次继续执行前，默认以本节为准，而不是把后文所有历史 TODO 逐条当成未完成项。

### 已经完成并可直接复用

1. `ending_chamber`
   - 结果页 CTA -> participant picker -> live room 已完成
   - `archivist_route / hotseat / all_present` 已完成
   - room/thread transcript 隔离、scope notice、只读 replay / import 基线已完成
   - 单结局结果页当前已重新核对：只保留 `进入会客厅 / 只改一步`
2. `one_move_only`
   - 已是独立 `room_type`
   - 与 `ending_chamber` 不再 scope 混线
3. `worldline_roundtable`
   - live / reseat / replay readonly 已完成
   - `manual_shortlist` 已完成
   - `expert_witness` 已完成
   - `hotseat` follow-up 已完成
   - transcript `quote` 级当前可直接切到 `hotseat`
   - committed transcript 长段当前可折叠 / 展开
   - mobile live 首屏已压到“可直接追问”的程度
   - live-room 当前已收口到无页面级纵向滚动；picker / reseat 仍允许滚动
   - completed live roundtable 当前已有 verdict 后 `Deep Dive` 工作台：包含 participant-scoped `1-on-1 Interview`、`Research Analyst`、`Cross-Examine`
   - `1-on-1 Interview` 当前会先展示代表的角色、世界线、立场、最近原话和人物简介；发送给 conversation 的 `origin_excerpt` 是这份可读摘要，不是 raw JSON
   - 只读 replay 继续保持只读，不重新开放这些 live-only 的 `Deep Dive` / chat / analyst / survey 工具
4. `crossline_gallery`
   - 结果页入口、摘要只读展示、local readonly copy / import 基线已完成
5. Oracle follow-up 流式链路
   - 已从“整段生成后一次性 commit”升级到：
     - `user_turn_commit`
     - `assistant turn_start`
     - `assistant turn_delta`
     - `assistant turn_commit`
   - provider 不支持 stream 时，会先探测，再自动回退到非流式生成 + 伪流式 delta 收口
   - `llm_call_stream()` 的 `estimated_tokens` 预估当前已补回，stream probe 不再因为变量缺失误判成 fallback
   - 若 stream 长时间没有产出任何可见 delta，当前会尽快回退到非流式改写，不再把 anchored follow-up 长时间挂住
   - 当前会在 delta 广播和最终 turn 落库前先剥掉 `<think>` reasoning block，不再把 provider 思维链直接打进 transcript
6. Oracle 文案层
   - 已完成 `LLM-first + deterministic fallback`
   - 已完成 `recent lines` 去重
   - 已完成 `scene/profile` 语言层
   - 已完成 `profile-specific` 视觉皮肤与轻量氛围动效
   - 当前 UI 语言不再被 `scenario.language` 强制覆盖
   - `finance / market` 这批角色语域已进入第一轮词汇拉开
   - fresh live room 的英文 deterministic copy 当前已补去混句兜底，不再把中文 hinge 直接嵌进英文句子
   - roundtable verdict / follow-up fallback 当前必须是可直接展示的人话，不再把 prompt 指令、模式标签或事实清单式占位露给用户
   - `thread_followup` 生成与改写 prompt 当前会钉住 active thread / exact anchor，不重开 verdict、不复述整间房、不解释线程机制
7. `legend-talk` 借鉴的低摩擦工作台动作
   - 已按 Oracle 边界项目化落地，不做通用群聊化扩张
   - single-ending 当前已支持：
     - `继续追问`
     - `另开线程`
     - `复制纪要`
     - `追问洞察`
     - transcript `quote` 级 `沿这句追问 / 另开线程`
   - roundtable 当前已支持：
     - `Continue this table / Start anchored thread / Copy roundtable brief`
     - `phase insight` 级追问与开线程
     - transcript `quote` 级 `Follow this quote / Start anchored thread`
   - phase insight 展示和 phase prompt 预填当前会先压成长段 commentary 的第一句，避免把 transcript 又复读一遍
8. 显式锚点合同
   - `quote / verdict / key_moment / phase` 当前都不再只是 prompt 文案，而是显式 `questionAnchorIds`
   - `appendUserTurn()` 与 `createThread()` 当前都已透传并持久化锚点
   - `ending_room_thread.question_anchor_ids_json` 当前已成为真实字段
   - `evidence_card` 追问被接受后，assistant follow-up turn 会继续保留用户引用的 `cited_branch_id` 与原始引用 metadata
9. replay / readonly 恢复
   - `mobile roundtable artifact replay readonly` 的 `interaction_mode` 当前已修正为跟随 active replay thread，不再卡在 `archivist_route`
   - `endingRoomStore.hydrateThread()` 当前会同步更新 `snapshot.threads`，新 anchored thread 不会再只停留在 `threadsById`
   - Firefox / WebKit scoped regression 当前也已确认：
     - `replayReadonly.interaction_mode = thread_followup`
     - `replayReadonly.active_thread_id = anchoredThread.active_thread_id`
     - `restored.interaction_mode = thread_followup`
   - 重新验收口径：
     - `artifactReadonly.interaction_mode = hotseat`
     - `replayReadonly.interaction_mode = hotseat`
     - `replayCoverageError = null`
10. `pretext / transcript layout`
   - `EndingChatModal / WorldlineRoundtableView` 当前都已接入 Oracle transcript 运行时布局内核
   - bubble `min-height` 预测与 transcript bottom-anchor 稳定化已落地
   - automation payload / E2E summary 当前会直接带 `transcript_layout`
   - `transcript_layout` 当前再补：
     - `collapsible_turn_count`
     - `collapsed_turn_count`
   - `P2` 当前签收口径：
     - ending-room 一份 `full` summary
     - roundtable 当前优先看 desktop / mobile 分端 summary

### 当前真正还没最终签收的点

1. `corner-case / regression hardening`
   - 当前主链已签收；`corners` rerun 现在已经能稳定落 `result.json`，剩下主要是一条 teardown warning 噪音
2. 更进一步的玩法扩展
   - `后续三回合`：后端 + 前端已落地，待 E2E 专项签收
   - `证据投牌`：后端 + 前端已落地（含 scenario 级验证与 4 KB 限制），待 E2E 专项签收
3. 新增主题场景的专属美术素材
   - 11 个新主题入口已注册到 `themeRegistry.ts`，当前复用已有场景图
   - 待 Gemini Image API 可用后批量生成专属素材
### 后续执行的硬优先级

后续不要再泛泛说“继续优化 UI 交互”。下一阶段的正确顺序固定为：

1. `persona-specific vocabulary`
   - 让同题材下不同角色的说话习惯再拉开
2. `theme skin + 微动效 + 氛围层`
   - 只放大已经做好的文案差异
3. `replay/share/import` 最终签收
4. 轻玩法扩展
   - 只在不破坏主闭环的前提下推进

## 0.2 下次执行的约束

下次继续做 23 线时，必须遵守下面这条总原则：

`先优化 Oracle 文案的角色化、题材化和去重复，再让 UI/氛围层只负责放大这种差异。`

明确禁止：

- 因为“还想更有代入感”就重新发明第二套视觉系统
- 在文案差异不足时继续堆复杂组件
- 为了做玩法而把 Oracle 做成通用群聊平台
- 为了追求“像 MiroFish”而模糊“结局卡锚定 / 当前世界线锚定 / room/thread 隔离”这三条边界

## 0.3 本轮已执行的高价值收口（2026-03-31 已完成）

下面三项本轮已经落地到当前代码和回归口径里；后续仍可继续拷打，但不再属于“未执行”项。

### A. 给锚点做更强的可观测性

已完成：

1. `EndingChatModal`
   - thread rail 与 transcript header 当前都会显示当前 thread 的 `anchor badge`
2. `WorldlineRoundtableView`
   - thread rail 与 transcript header 当前也会显示 `anchor badge`
3. 当前 badge 只显示用户可读的 `kind / label`，不直接把内部 ids 打到 UI 上

### B. 补 thread/read-only 的锚点回显测试

已完成：

1. frontend
   - `EndingChatModal.test.tsx` 已补 read-only thread anchor badge 断言
   - `WorldlineRoundtableView.test.tsx` 已补 read-only anchor badge 断言
2. E2E
   - ending-room mobile single-ending 已验证：
     - `verdict-anchor thread`
     - `artifact readonly`
     - `local readonly`
     - `reload restore`
     - `import local run`
   - roundtable desktop / mobile 已验证：
     - `quote-anchor thread`
     - `artifact readonly`
     - `local readonly`
     - `reload restore`
     - `import local run`

### C. 把自动化输出再细一点

已完成：

1. `EndingChatModal` automation payload 当前会输出：
   - `active_thread_id`
   - `interaction_mode`
   - `question_anchor_ids`
   - `thread_question_anchor_ids_json`
   - `pending_question_anchor_ids`
   - `anchor_kind / anchor_label`
2. `WorldlineRoundtableView` automation payload 当前也会输出同一套 anchor 字段
3. 本轮回归工件已经把这些字段落进 `summary.json`
   - `frontend/output/e2e/20260331-codex-oracle-anchor-ending-room-mobile-v3/summary.json`
   - `frontend/output/e2e/20260331-codex-oracle-anchor-roundtable-desktop-v8/summary.json`
   - `frontend/output/e2e/20260331-codex-oracle-anchor-roundtable-mobile-v2/summary.json`

### D. 把 transcript layout 也落成可签收字段

已完成：

1. `EndingChatModal / WorldlineRoundtableView`
   - 当前 automation payload 已额外输出 `transcript_layout`
2. `transcript_layout` 当前统一包含：
   - `turn_count / draft_count`
   - `max_turn_lines / max_draft_lines`
   - `overflow_turn_count / overflow_draft_count`
   - `max_turn_min_height_px / max_draft_min_height_px`
   - `scroll_bottom_offset_px / scroll_height_px / client_height_px`
   - `is_bottom_anchored`
3. `P2` scoped signoff 工件已落盘：
   - `frontend/output/e2e/20260331-codex-p2-signoff-ending-room/summary.json`
   - `frontend/output/e2e/20260331-codex-p2-signoff-roundtable-desktop/summary.json`
   - `frontend/output/e2e/20260331-codex-p2-signoff-roundtable-mobile/summary.json`

当前结论：

- 这四项已经进入当前真值，不再是“待做”
- 后续如果继续回归，只需要继续拷打 readonly / reload / import 是否保持同一 anchor thread 语义
- 不需要为了继续做观测再扩大 room/thread 边界

---

## 1. 产品定位与命名

### 1.1 命名冻结

推荐采用以下命名，不再临时改词：

| 语义层 | 中文 | 英文 | 内部 ID | 说明 |
|---|---|---|---|---|
| 功能总名 | 神谕会客厅 | Oracle Chambers | `oracle_chambers` | 总玩法名 |
| 单结局房间 | 结局会客厅 | Ending Chamber | `ending_chamber` | 结果页单条结局入口 |
| 多结局复盘 | 世界线圆桌 | Worldline Roundtable | `worldline_roundtable` | 多结局代表同台 |
| 房内角色实例 | 世界线回声 | Worldline Echo | `worldline_echo` | 同一 agent 在不同世界线/房间里的隔离人格快照 |
| 结局后追问 | 追问线程 | Follow-up Thread | `followup_thread` | 围绕当前结局、事件、角色的二级讨论 |
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
9. 结局后用户追问必须写入当前 `ending_room` 新域，不得回写主 simulation transcript。
10. 参与会客厅/圆桌的 agent 只允许读取：
    - 当前 room transcript
    - 当前 worldline 全文或当前可见摘要
    - 当前 room 选中的参与者 persona snapshot
11. 即使属于同一 `scenario_id`，也禁止让 agent 读取其他 room 的历史对话，避免“同题不同线”互相污染。
12. 若用户在 A 结局里追问“B 结局里某角色当时怎么说”，系统只能引导用户去打开 B 结局对应 room，不能在 A 房间越权代答。
13. 所有“后续发展”“热座追问”“全员会谈”都属于 post-ending 复盘层，不能重新进入主 simulation 引擎继续滚动世界状态。
14. 同一 `source_agent_id` 在不同 `branch_id`、不同 room 中必须被视为不同 `worldline_echo`，不共享结局后对话记忆。
15. 结局后追问只能读取：当前世界线材料 + 当前 room 历史 + 当前 thread 历史，不得回读其他 room / 其他世界线历史。
16. “和每个 agent 聊”只允许发生在当前世界线 roster 内，不允许把整局所有 agent 自动拉进同一个全局聊天室。

### 2.2 技术边界

统一作用域键：

```json
{
  "scenario_id": "scn_xxx",
  "anchor_branch_id": "br_xxx",
  "room_type": "ending_chamber | worldline_roundtable | one_move_only | crossline_gallery",
  "discussion_mode": "auto_recap | archivist_route | hotseat | all_present | representative | expert_witness | trait_mix",
  "participant_set_hash": "sha256(sorted participants + role slots + branch scope)",
  "language": "zh | en",
  "memory_partition_version": "v1"
}
```

所有以下链路都必须按该 key 分桶：

- 持久化
- WS stream
- replay
- import
- 摘要缓存
- 向量检索

补充约束：

- 一旦引入“手动选人”，scope key 必须再显式纳入：
  - `selection_mode = auto | manual`
  - `selected_agent_ids_hash = sha256(sorted selected_agent_ids) | auto`
- `participant_set_hash` 不得只由 `branch scope` 计算；手动选人必须参与 dedupe。
- `discussion_mode` 变更时必须形成独立 room scope；不能把 `auto_recap` 和 `hotseat` 命中同一个 room。
- 同一 worldline 下：
  - `auto(top-2)`
  - `manual([A])`
  - `manual([A,B])`
  - `manual([B,A])`
  必须被稳定区分或稳定去重，不能出现“顺序不同 -> room 重复创建”或“选人不同 -> 命中同一个 room”的错误。

结局后追问线程需要额外二级 key：

```json
{
  "room_id": "er_xxx",
  "thread_id": "ert_xxx",
  "anchor_branch_id": "br_xxx",
  "thread_mode": "solo | panel | all_hands",
  "participant_set_hash": "sha256(sorted participants in thread)",
  "language": "zh | en"
}
```

并固定三层记忆边界：

1. `worldline source memory`
   - 当前 `anchor_branch_id` 的 transcript / story / insight / key_moments
2. `room memory`
   - 当前 `ending_room_turn` committed transcript
3. `thread memory`
   - 当前 `followup_thread` committed transcript

明确禁止：

- 读取其他 room 的追问记录
- 读取同一 `source_agent_id` 在其他 worldline 的历史对话
- 把 scenario 级全局对话缓存当成结局后对话上下文

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

### 2.4 差异化原则（避免同质化）

可以借鉴但不能照搬的点：

- 借鉴 `MiroFish` 的点：
  - 推演结束后，允许继续向角色追问“为什么会这样”
  - 把“报告层”之外再加一层可互动解释层
- 借鉴 `Roundtable MCP / LobeHub` 的点：
  - 主持者 / 主管调度发言顺序
  - 支持轮流、并行、总结三类会议节奏
  - 支持显式指定参与者

必须明确不做的点：

- 不做常驻开放式群聊空间
- 不做脱离结局卡/事件卡的空白聊天框
- 不做跨世界线共享角色记忆池
- 不做配置先行、玩法感不足的“多 agent 编排器 UI”

SwarmOracle 自己要成立的独特点：

- 交互入口始终从 `结局卡 / 关键转折卡 / 角色卡` 发起，而不是空白输入框
- 用户对话的对象不是“全局 agent”，而是该世界线的 `worldline_echo`
- 每次追问都围绕 `这个结局 / 这个事件 / 这个后续`，而不是泛泛聊天
- 圆桌之后可以对某条 quote / 某个结论继续追问，形成“复盘 -> 追问 -> 再复盘”的链路

### 2.5 外部灵感取舍

这条线可以明确借鉴三类外部思路，但必须经过项目化改造：

- 参考 `MiroFish`
  - 借的是“结局后仍可继续追问角色”的价值，不借“开放式漫游整个模拟世界”的产品边界
- 参考 `Lobe 群组 / Roundtable`
  - 借的是 `Supervisor / 主持人` 的编排方式、轮转节奏、自动化多角色协作，不借“通用群聊工作台”的产品定位
- 参考 `xAI multi-agent`
  - 借的是 `leader + hidden sub-agents + only committed output visible` 的执行结构，不借“把隐藏推理或中间 planning 全量暴露给用户”
- 参考 `legend-talk`
  - 借的是“低摩擦圆桌工作台动作”：
    - 快速继续一轮
    - 从某句话继续追问
    - 从当前锚点直接另开线程
    - 复制纪要
  - 不借：
    - 通用思想家聊天室
    - 同一会话里任意加人减人并直接改写当前 room
    - 无边界的本地工作台历史容器

SwarmOracle 自己的独特点必须保持：

- 所有讨论都从“结果页上的某个结局卡”进入，而不是从空白 chat 入口进入
- 所有追问都锚定当前世界线的 `story / insight / key_moments / transcript`
- 所有跨线比较都经由摘要卡、引文卡、关键转折卡进行，而不是把别的世界线全文搬进来
- `Archivist` 不是普通群聊管理员，而是“档案官 + 证据路由器 + 主持人”

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

> 状态更新（2026-03-30，最新）：
> - backend 独立 `ending_room` 域、REST/WS、scenario 删除清理、L2 branch scope 检索已落地
> - `Phase B` 可继续视为：**后端严格签收通过**
> - `Phase B+` 当前不止是 room/thread memory partition：
>   - follow-up assistant turn 已升级成“优先真流式 + probe fallback”
>   - endpoint 不再只返回整段 committed turn，而会走 `turn_start / turn_delta / turn_commit`
>   - thread-scoped draft 所需 `thread_id` 也已补齐到 WS 事件
> - 当前后端 residual 已不在“有没有新域”，而在：
>   - persona vocabulary 继续拉开
>   - replay/share/import 最终签收
> - 当前定向回归口径：
>   - `tests/test_ending_room_service.py + tests/test_ending_room_api.py + tests/test_ending_room_ws.py = 69 passed`

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

### Follow-up 流式升级（新增，Mandatory）

> 状态更新（2026-03-30）：这节的升级已经完成，下面保留为合同与实现约束，而不再是未来 TODO。

`follow-up` 不应长期停留在“后端整段生成完再一次性 commit”的口径。

目标要升级成 **更接近经典模式 agent 发言的 live 体验**，但仍严格遵守 `ending_room` 域的 mixed-streaming contract：

```text
user_turn_commit
-> followup_turn_start
-> followup_turn_delta
-> followup_turn_commit
```

强制要求：

- `archivist_route / hotseat / all_present`
  - 三种 follow-up 模式都必须支持 `turn_start -> turn_delta -> turn_commit`
  - 不允许继续只有自动复盘在流式、追问仍整段跳出
- follow-up 的 draft 体验应接近经典模式：
  - 当前 responder 头像/卡片高亮
  - draft 文本独立增长
  - commit 后替换为正式 transcript
  - 不允许同一条 follow-up 同时残留 `draft 卡片 + committed 卡片`
- follow-up 流式对象仍然只认 committed turn：
  - replay
  - share
  - import
  - quote extraction
  - supporting turns
- follow-up 流式事件必须按 `thread_id` 入桶
  - 不允许不同 follow-up thread 的 draft 混在同一个 live draft 池里
- `all_present`
  - 允许多位 responder 依次流式
  - 不允许并发把多个 active draft 泡同时铺满正文区
  - 必须让用户清楚知道“当前轮到谁在说”

建议事件补齐为：

```yaml
ending_room_followup_turn_start:
  room_id:
  thread_id:
  turn_id:
  participant_id:
  interaction_mode:
  sequence:

ending_room_followup_turn_delta:
  room_id:
  thread_id:
  turn_id:
  participant_id:
  interaction_mode:
  delta:
  chunk_index:

ending_room_followup_turn_commit:
  room_id:
  thread_id:
  turn_id:
  participant_id:
  interaction_mode:
  content:
  sequence:
```

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
POST /api/ending-room/{room_id}/user-turn          # 结局后用户追问 / 热座问答 / 圆桌追问
WS   /api/ws/ending-room/{room_id}
POST /api/ending-room/{room_id}/replay-artifact     # 第二阶段可补
```

### 验收

- room 创建可去重
- WS 可连接
- 读取权限正确
- scenario 删除时新域数据一起清理

---

## 3.3 Phase C — 结果页单结局会客厅 MVP

> 状态更新（2026-03-30，latest truth）：
> - 这条线已经不再停在“只能开 modal 看 auto recap”的最早口径
> - 当前真实代码里，结果页 CTA 会先进入 participant picker，再把 `selected_agent_ids` 带进 room scope
> - 单结局 `EndingChatModal` 当前已接上 thread rail、follow-up composer、`archivist_route / hotseat / all_present`
> - 单结局桌面 `1600x900` 与移动端 `390x844` 的 picker / chamber / hotseat / all-present 当前已做真实浏览器验收
> - 多结局结果页当前已通过专项 E2E：按各自 ending 打开 picker / chamber / one-move
> - `WorldlineRoundtableView` 当前已落地 live / reseat / replay readonly，并进入稳定 `release:signoff` 总链
> - 当前这节的 residual 已经从“功能没做完”收口到：
>   - ending-room / roundtable replay/share/import 最终专项签收
>   - persona vocabulary 继续拉开
>   - profile-specific ambient motion / audio / Theater 联动皮肤

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

### 当前体验评审结论（2026-03-30，latest truth）

这节原来的问题清单大部分已经被解决，下次执行时不要再把它们当成未完成项。

当前已经解决：

1. participant roster 错位
   - 当前结果页 CTA 已先进入 participant picker
   - room scope 已正式吃进 `selected_agent_ids`
2. 手动选人缺失
   - `ending_chamber / one_move_only` 已允许手动选人
3. transcript 缺少角色感
   - 像素头像 / role / persona / impact / active speaker 高亮已接上
4. 左侧 story 信息墙
   - 当前已改成更偏玩法信息架构，不再默认只是一堵长文
5. 多结局结果页覆盖不足
   - 多结局 `ending_chamber / one_move_only` 已有专项 E2E
6. follow-up 像“整段跳出”
   - 当前 follow-up assistant turn 已升级成后端优先真流式 + fallback
7. 文案过于 deterministic
   - 当前已补到：
     - `LLM-first + deterministic fallback`
     - `recent line` 去重
     - `profile/theme` 语言层
     - `persona-specific` 基础词汇拉开

当前仍然保留的残余：

1. replay/share/import 还缺一次最终专项签收
2. 文案层已经不是模板硬拼，但还可以继续深化：
   - `persona-specific vocabulary`
   - `profile/theme lexicon`
   - `conflict/tension shaping`
3. 视觉层已经有 profile skin + 轻量氛围动效，但还不是最终形态：
   - `ambient motion`
   - `audio/SFX`
   - `Theater 联动皮肤`

---

## 3.3.1 Phase C2 — 参与者驱动与可玩性修复（Mandatory Before Phase D）

### 目标

把当前“结果页附属文本框”升级成真正可玩的复盘玩法。

一句话要求：

`真实参与者 -> 手动选人 -> 像素人物卡 -> 去模板化发言 -> 再谈圆桌`

### 必须先解决的五类问题

#### A. 参与者错位

当前用户在结果页底部看到的是这局的真实参与 roster，但会客厅里只看到后端 auto-pick 的一小撮代表，认知错位严重。

下轮必须改成：

- 先基于 `anchor_branch_id` 统计当前世界线里**真实发过言**的 agent
- CTA 打开后先展示该 branch 的真实参与者 roster
- `auto` 模式可以预选 top-impact 的 `1-3` 人
- 但 UI 必须允许用户手动改选

#### B. 缺少手动选人

下一轮 contract 必须扩成：

```json
{
  "room_type": "ending_chamber | one_move_only | worldline_roundtable | crossline_gallery",
  "anchor_branch_id": "br_xxx",
  "selected_branch_ids": ["br_xxx"],
  "selection_mode": "auto | manual",
  "selected_agent_ids": ["ag_x", "ag_y"],
  "language": "zh | en"
}
```

并约束：

- `ending_chamber`
  - 允许 `1-3` 名真实参与者
  - 默认 `auto` 预选 `2`
- `one_move_only`
  - 必须且仅允许 `1` 名主回应者
  - `Archivist` 可固定附带，但不能替代用户选的人
- `worldline_roundtable`
  - 每条 branch 仍只派 `1` 名代表
  - 但这个代表必须允许用户在候选 roster 里改选

#### C. 套话化文案

当前 deterministic 模板句适合做链路验证，不适合做最终玩法。

下一轮必须改成：

- 每条发言都从当前 branch 的真实 transcript / story / insight / key moments 抽证据
- prompt 明确要求：
  - 保持角色口吻
  - 至少给出 `1` 个具体 hinge / decision / tradeoff
  - 不允许空泛句式
  - 句子要短，像人在复盘，不像系统在解释
- `one_move_only` 的输出固定成：
  - `1` 个动作
  - `1` 句原因
  - `1` 句代价/风险

#### D. 缺少角色感和玩法感

下一轮必须增加：

- 像素头像
- 角色标题
- persona 短句
- 影响力标签
- 发言高亮/脉冲
- turn 切换动效
- story 折叠摘要，而不是默认整堵长文

#### E. 多结局结果页覆盖不足

下一轮必须把以下场景单独签收，而不是只在单结局局面下通过：

- `multi-ending + ending_chamber(ending A)`
- `multi-ending + ending_chamber(ending B)`
- `multi-ending + one_move_only(ending A)`
- `multi-ending + one_move_only(ending B)`

必须确认：

- 每张结局卡进入的会客厅都只读取自己的 `anchor_branch_id`
- 从结局 A 打开的 chamber，不会因为之前打开过结局 B 而串房间
- 切换不同 ending card 后，participant picker、推荐阵容、story 摘要、transcript、impact score 都跟着变
- 在多结局结果页里关闭并重开不同 ending 的 modal，不会复用错 room 或显示错 transcript

#### F. 缺少“结局后继续追问”

当前 chamber 更像一次性生成的结果页附属 transcript，还不是一个真正可继续追问的复盘空间。

下一轮必须补上：

- 自动复盘结束后，用户可继续围绕当前结局发问
- 用户可：
  - 让 `Archivist` 自行路由给最相关的 `1-2` 名当前世界线参与者
  - 点名当前世界线里的某个 agent 进入 `hotseat`
  - 让当前已选参与者做一次 `all_present` 短轮回应
- 每个追问线程都只属于当前结局卡对应 room，不得被别的结局卡复用

#### G. 上下文隔离必须从“branch scope”升级到“room scope”

当前 branch 隔离是必要条件，但对“结局后追问”还不够。

必须新增硬合同：

- agent 回答用户追问时，默认只读：
  - 当前 room committed transcript
  - 当前 `anchor_branch_id` 全文
  - 当前 room 的 participant persona snapshot
- 不读取：
  - 同一 `scenario_id` 下其他 ending-room transcript
  - 其他 `worldline_roundtable` transcript
  - 历史上同 branch 但不同选人配置的旧 room transcript
- 若用户显式提到其他世界线，系统只允许返回摘要卡或提示跳转，不允许直接把他线全文混进回答

### 后端合同

#### 新增服务层 helper

```text
collect_branch_participant_candidates(...)
rank_branch_participant_candidates(...)
validate_selected_agent_ids(...)
build_manual_participant_defs(...)
build_auto_participant_defs(...)
```

#### 候选参与者规则

- 候选集只来自：
  - 当前 `anchor_branch_id` 中真实发过言的 `AgentMessage.agent_id`
- 排序至少综合：
  - `turn_count`
  - 是否命中 `key_moments`
  - 是否在后段轮次仍发言
  - `CORE / IMPORTANT` 权重
- 若当前 branch 完全没有 message：
  - fallback 到该 scenario 的 agent roster
  - 但 UI 必须明确标记 `fallback cast`

#### `ending_room_participant` 返回 payload 至少补齐

```json
{
  "id": "erp_xxx",
  "source_agent_id": "ag_xxx",
  "display_name": "Mara Veld",
  "role_slot": "agent | representative | archivist",
  "persona_snapshot_json": {
    "agent_role": "Chief Emergency Coordinator",
    "agent_persona": "Moves first, justifies later, and hates ceremonial delay.",
    "sprite_key": "sprite_general",
    "bio_short": "Frontline coordinator who treats delay as a hidden casualty.",
    "impact_score": 0.84,
    "turn_count": 4,
    "key_moment_hits": 2,
    "last_round_spoken": 3,
    "selection_reason": "top_impact | user_selected | fallback"
  }
}
```

#### 输入校验

- `selected_agent_ids` 不能为空（manual）
- `selected_agent_ids` 不得包含不属于该 `scenario_id` 的 agent
- `selected_agent_ids` 不得包含从未参与该 `anchor_branch_id` 的 agent，除非显式 fallback
- duplicate agent id 要去重
- `one_move_only` 超过 `1` 个选人时必须 `422`
- `ending_chamber` 超过 `3` 个选人时必须 `422`

### 前端合同

#### 结果页 CTA 改成两步

当前：

`点击按钮 -> 直接建 room`

必须改成：

`点击按钮 -> 打开选人面板 -> 确认后建 room`

#### 新增组件建议

```text
frontend/src/components/EndingRoomParticipantPicker.tsx
frontend/src/components/EndingRoomParticipantPicker.css
frontend/src/components/EndingRoomParticipantCard.tsx
frontend/src/components/EndingRoomParticipantCard.css
frontend/src/components/EndingRoomSpeakerBadge.tsx
frontend/src/components/EndingRoomSpeakerBadge.css
```

#### 选人面板要求

- 展示当前 branch 的真实参与者 roster
- 每个参与者卡必须展示：
  - 像素头像
  - 名字
  - role
  - persona 短句
  - impact score
  - 发言轮次 / 关键转折命中数
- 默认预选：
  - `ending_chamber`: top 2
  - `one_move_only`: top 1
- 支持：
  - 单选
  - 多选
  - reset 为推荐阵容

#### 会客厅布局必须改成“玩法信息架构”

左侧：

- `结局摘要卡`
- `故事摘要（折叠）`
- `关键转折卡`
- `参与者快速卡`

右侧：

- `发言记录`
- 每条发言都带：
  - 像素头像
  - 名字
  - role
  - 发言阶段
  - 内容
- 当前 speaker 有 active 高亮

### 文案质量合同

禁止风格：

- 审计报告腔
- AI 总结腔
- 空泛因果句
- 连续多条同构模板

目标风格：

- 像角色在复盘，而不是系统在讲解
- 有立场
- 有偏好
- 有冲突
- 有一点“会客厅戏剧感”，但不过火

具体约束：

- 每条发言 `1-3` 句
- 避免重复 branch title
- 避免连续两条 turn 用同一种开头
- `Archivist` 负责收束，不抢戏

### 结局后追问合同（新增，Mandatory）

#### 玩法定位

这不是把会客厅改造成通用群聊，而是给每个结局卡增加一个“可继续追问的证据化复盘层”。

与 `MiroFish` 的关键差异必须明确：

- `MiroFish` 更像“进入模拟世界后继续和角色自由对话”
- `SwarmOracle` 必须是“从某个结局卡进入，只围绕这个结局继续追问”

#### 追问模式

在 `ending_chamber` 内新增：

1. `archivist_route`
   - 用户提问后，由 `Archivist` 决定点名 `1-2` 位最相关参与者回应
2. `hotseat`
   - 用户显式点名一个当前世界线参与者作答
   - 允许 `Archivist` 在结尾补一条整理意见
3. `all_present`
   - 仅限当前世界线
   - 所有已选参与者各回 `1` 次短回应
   - 若真实参与者过多，必须降级成：
     - 前台 `3-4` 位 active speakers
     - 其余人折叠为 `chorus strip / 旁席意见条`

#### 新增请求字段

```json
{
  "interaction_mode": "auto_recap | archivist_route | hotseat | all_present",
  "question_text": "如果你当时再多等一轮，会不会避免失控？",
  "addressed_agent_ids": ["ag_xxx"],
  "question_anchor_ids": ["km_1", "km_4"],
  "selection_recipe": "manual | impact_top | responsibility_mix | disagreement_pair | trait_mix"
}
```

#### 后端合同

- 新增 `append_user_turn(...)`
- 新增 `build_room_followup_context(...)`
- 新增 `resolve_followup_responders(...)`
- follow-up 若后端 LLM 支持流式：
  - 必须优先走 `llm_call_stream()` / 等价 streaming path
  - 再按 mixed-streaming contract 收口成 committed turn
  - 不允许在数据库事务持有期间长时间等待 LLM 返回
- `user_turn` / `agent_followup_turn` / `archivist_followup_turn` 必须继续写入 `ending_room_turn`
- 每条 follow-up turn 必须带：
  - `source = auto_recap | user_followup`
  - `memory_partition_id`
  - `interaction_mode`
  - `addressed_agent_ids`

#### 前端合同

- `EndingChatModal` 在自动复盘完成后，底部出现：
  - `继续追问`
  - `点名追问`
  - `当前全员回应`
- `EndingChatModal / WorldlineRoundtableView` 当前统一锚点规则应为：
  - `预填追问`
  - `另开线程`
  - 适用锚点：`verdict / key_moment / quote / phase`
- `follow-up` 若启用流式：
  - 必须复用与经典模式接近的“当前说话中”视觉结构
  - 当前 responder 的 participant card / avatar / ring 同步高亮
  - thread 内 draft 与 committed transcript 显式区分
  - `all_present` 逐位 responder 切换时，active highlight 必须同步切换
- 当前合同要求：
  - `appendUserTurn()` 必须显式带 `questionAnchorIds`
  - `createThread()` 必须显式带 `questionAnchorIds`
- 必须支持从 `key_moment card` 直接发起追问：
  - `为什么这里转向了？`
  - `如果不这么做会怎样？`
  - `谁最该为这里负责？`
- `hotseat` 模式要显式展示当前被点名的角色
- `all_present` 模式要避免 UI 被十几个头像撑爆：
  - 只把 active speakers 放正文区
  - 旁席意见折叠为 summary chip / side strip

#### 选人策略合同

除了手动点名，还必须支持“按属性快速成局”，这样这条线才会更像玩法，而不是纯配置面板：

1. `impact_top`
   - 默认推荐
   - 选择当前世界线影响度最高的 `1-3` 人
2. `responsibility_mix`
   - 优先拉入：
     - 关键行动发起者
     - 关键后果承受者
     - `Archivist`
3. `disagreement_pair`
   - 优先选择在关键转折上立场最冲突的两人
4. `trait_mix`
   - 按 persona 标签自动混编：
     - `冒进 / 保守`
     - `理想 / 现实`
     - `秩序 / 裂变`

约束：

- `selection_recipe` 只能在当前 worldline roster 内选人
- recipe 产出的真实 `selected_agent_ids` 必须写回 room snapshot，便于 replay / debug
- recipe 若与 manual 产出同一组人，可以命中同一 room；若产出不同组人，必须形成不同 room scope

#### 隔离验收

1. ending A 的追问历史不会出现在 ending B
2. 同一 ending 下，`auto(top-2)` 与 `manual([A,B,C])` 的追问历史不能混线
3. 点名不存在于当前 worldline 的 agent 必须 `422`
4. replay 打开后只能重播既有追问，不能继续 live 发问
5. 用户在 A 结局中追问 B 结局细节时，系统只能提示“去 B 结局会客厅查看”

### Phase C2 验收

只有以下全部成立，才能把 Phase C 从“功能打通”升级成“真的可玩”：

1. 用户看得见当前世界线真实参与者，而不是只看到神秘代表
2. 用户能手动指定 1 个或多个参与者进入玩法
3. 角色卡有头像、角色、persona、影响度
4. 发言不再是套话模板
5. 左侧 story 不是默认整堵长文
6. 右侧 transcript 有角色感和动态反馈
7. `390x844` 下仍完整可用
8. 中英双语都自然
9. replay 只读且稳定
10. 才允许进入 `Phase D`

---

## 3.3.2 Phase C3 — 同线听证 / 热座追问（Strongly Recommended Before Phase D Signoff）

> 状态更新（2026-03-30，latest truth）：
> - backend 侧 `follow-up thread / user-turn / memory partition` 已先按 `Phase B+` 最小口径落地
> - 当前已能创建 thread、读取 thread snapshot、写 room/thread follow-up turn，并显式区分 room memory 与 thread memory
> - `delete_scenario` 也已把 `ending_room_thread` 纳入清理
> - frontend 当前已接上 thread UI / thread store / thread WS、scope notice、room/thread transcript 切换，以及 `archivist_route / hotseat / all_present`
> - 当前这节不再是“单结局 follow-up 可玩”的阶段，而是：
>   - 单结局与 roundtable follow-up 都已具备可玩基线
>   - 流式链路已升级成后端优先真流式 + probe fallback
>   - 后续重点转向更深的 persona/theme 文案层和 replay/share 最终签收

### 目标

把“结局后继续问 agent”做成 SwarmOracle 自己的玩法，而不是 MiroFish 式的自由漫游复制品。

### 一句话定义

`结局自动复盘结束 -> 用户围绕当前结局继续追问 -> 档案官路由/主持 -> 当前世界线参与者给出带证据的后续回应`

补充定义：

- 用户实际在对话的对象不是“全局 agent”，而是当前 worldline 内的 `worldline_echo`
- 每条追问都必须带锚点：
  - `结局卡`
  - `关键转折卡`
  - `角色卡`
  - `圆桌 quote / verdict`
- 追问历史应被建模为 `followup_thread`，而不是无限追加到一个无边界 room transcript

### 推荐首版三种桌型

1. `档案官路由`
   - 用户只提问题
   - `Archivist` 负责选人和控节奏
2. `角色热座`
   - 用户点名一个 agent
   - 其他已选角色只做短追问或旁批
3. `同线听证`
   - 当前世界线参与者做一轮短会谈
   - 仅限单 worldline，不用于跨线

### 参与者成局方式

`Phase C3` 首版不要只支持“手动多选”，而要同时提供三种快速入口：

1. `推荐阵容`
   - 当前世界线影响度最高的 `1-3` 人
2. `点名热座`
   - 用户手动指定 `1` 人
3. `属性混编`
   - 系统自动选出更有戏剧张力的一组人

其中 `属性混编` 建议首版固定三种 recipe：

- `责任链`
  - 发起者 + 承担者 + 记录者
- `分歧链`
  - 最支持该结局的人 + 最质疑该结局的人
- `气质链`
  - 冒进者 + 稳定派 + 理想主义者

### 必须坚持的独特性

- 追问必须带“结局锚点”：
  - `story`
  - `insight`
  - `key_moments`
  - `supporting_turns`
- 用户不是在“和虚拟角色闲聊”，而是在“追问这个结局为什么成立、还能怎么发展”
- 若要谈“后续发展”，只能做：
  - `three-turn epilogue / 后续三回合`
  - 不能变成重启整局 simulation
- 同一 `source_agent_id` 在 ending A / ending B 中必须生成两个彼此隔离的 `worldline_echo`

### 追问线程结构建议

建议把自动复盘和追问分成两层：

1. `room transcript`
   - 用于自动复盘、圆桌阶段 transcript、结论沉淀
2. `followup_thread`
   - 用于围绕某个角色/某个转折/某句结论继续问

这样可以避免：

- 一个 room 聊得越来越散
- 用户第二次追问时找不到“我是围绕哪个点在问”
- 同一个 room 内多个追问主题互相污染

### 验收

- `hotseat` 能稳定点名当前 worldline agent
- `同线听证 / all_present` 在高 agent 数时能优雅降级
- 每次追问都能看出引用的是当前结局证据，而不是空泛角色扮演
- 追问线程与主 simulation transcript 严格分离

---

## 3.4 Phase D — 世界线圆桌

> 状态更新（2026-03-30，最新）：
> - `WorldlineRoundtableView` 的 live / reseat / replay readonly 已落地并进入稳定 `release:signoff` 总链
> - `manual_shortlist / expert_witness / trait_mix / fault_line_first / witness_augmented` 已形成最小可玩闭环
> - roundtable 自己的 follow-up / hotseat 已完成
> - 当前已补上：
>   - profile-aware 文案层
>   - profile skin / hook chips / 轻量微动效
> - `Phase D` 当前不再是“从 0 到 1”阶段，而是“可玩基线已完成，且已继续补到 `manual_shortlist / expert_witness / trait_mix / fault_line_first / witness_augmented`；后续只剩更大的玩法扩展和更深 hardening”的阶段

### 目标

多结局场景下，允许用户发起“世界线圆桌”进行跨结局复盘，但不读取他线全文。

### 当前桌面口径

当前真实代码口径不是早期那版“固定 3 席桌”了，而是：

1. `representative`
   - 默认模式
   - 当前入桌的每条 worldline 各派 `1` 名代表
   - 另带 `Archivist`
2. `manual_shortlist`
   - 用户手动指定 `2-4` 条 worldline 入桌
   - shortlist 外的 worldline 当前不入桌
3. `expert_witness`
   - 维持当前代表席
   - 再额外请入 `1` 位当前 worldline 证人

也就是说，多于两条结局时：

- 默认仍可全量代表入桌
- `manual_shortlist` 时可主动缩成 `2-4` 条线
- `crossline_gallery` 则负责承担“桌外世界线的摘要旁听”

### 主持与轮转机制

圆桌必须采用 `Archivist / Supervisor` 式编排，而不是自由抢话：

1. `Archivist` 先定义本阶段问题
2. 代表席按阶段规则并行或串行发言
3. 若需要 hidden planning，可在后台启用临时 sub-agents 做证据整理
4. 只有 committed 发言进入正式 transcript
5. hidden planning 不落库，不进入 replay，不对用户裸露

这一点可以参考：

- `Lobe 群组` 的 `Supervisor + 群组成员` 协作
- `xAI multi-agent` 的 `leader-only visible output`

但在本项目里必须进一步收紧：

- `Archivist` 只能调用当前可见范围内的证据
- 后台 sub-agents 只负责“找证据/整理冲突”，不能偷偷扩大上下文读取范围

### 可选桌型（新增）

`世界线圆桌` 不应只有一种固定桌型。首版建议支持以下模式：

1. `representative`
   - 默认模式
   - 每条结局 `1` 名代表 + `Archivist`
2. `manual_shortlist`
   - 已完成
   - 用户手动指定 `2-4` 条 worldline 入桌
   - 适合“我只想看这几条线怎么吵”
3. `trait_mix`
   - 已完成
   - 系统按 persona / 角色标签自动推荐冲突更强的组合
   - 例如：`冒进者 vs 稳定派 vs 理想主义者`
4. `expert_witness`
   - 已完成
   - 在当前代表席基础上额外请入 `1` 名当前 worldline 的专家证人，发 `1` 轮短证词

### 席位编排策略（新增）

支持桌型还不够，圆桌必须允许不同“选人逻辑”，否则最后还是固定模板：

1. `probability_top`
   - 默认模式
   - 概率最高的 `2` 条世界线入桌
2. `fault_line_first`
   - 已完成
   - 优先选择分歧最大的两条世界线
3. `manual_shortlist`
   - 用户手动指定 `2-4` 个席位
4. `witness_augmented`
   - 已完成
   - 代表席固定，再额外请入 `1` 个证人席位

实现边界：

- 任何策略都不能扩大摘要/全文权限边界
- 策略只决定“谁入桌”，不决定“能读取什么”
- 同一策略若最终选出相同 `selected_branch_ids + selected_agent_ids`，可以命中同一个 room

边界必须写死：

- `all_present` 只允许发生在单 worldline 的 `ending_chamber`
- 多 worldline 圆桌不允许把每条线所有 agent 全拉上桌，否则既乱又容易串上下文

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

### 圆桌后的用户追问（新增）

圆桌 verdict 结束后，允许用户继续在“当前桌面”提问，但仍然遵守本桌 scope：

- 可问：
  - `如果把最关键的一步换成另一种选择，会怎样？`
  - `哪条世界线最脆弱？`
  - `谁的判断最值得信任？`
- 不可问：
  - `把未入桌世界线的完整 transcript 贴出来`
  - `读取另一桌历史讨论`

推荐复用同一个接口：

`POST /api/ending-room/{room_id}/user-turn`

### 验收

- 只读他线摘要，不读他线全文
- 圆桌后的追问仍只停留在当前桌 scope
- 3 席布局在桌面/移动端都成立
- 阶段推进、结果摘要、引文提取都稳定

---

## 3.5 Phase E — Replay / Share / Import

> 状态更新（2026-03-30，最新）：
> - local read-only copy / import 已完成
> - replay readonly 已完成
> - ending-room / roundtable 的 permalink / artifact share / readonly replay / import 已完成专项签收

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

> 状态更新（2026-03-30，最新）：
> - `trait_mix / fault_line_first / witness_augmented` 已完成
> - 当前仍留在后续阶段的，只剩 `后续三回合 / 证据投牌` 这类再下一轮玩法扩展

### 目标

增强可玩性，但不把系统拖成第二产品。

### 玩法列表

1. `结局复盘`
   - 只讨论“为什么会这样”
2. `只改一步`
   - 只允许给一个最小修正建议
3. `异线旁听席`
   - 只读别线摘要和引文
4. `关键转折追问`
   - 点某张 `key moment` 卡，直接发起一轮 `为什么在这里转向` 的追问
5. `角色热座`
   - 点名当前结局里最值得追责或最有洞见的人
6. `后续三回合`
   - 只允许做超短后续发展推演
   - 不重开 simulation
7. `证据投牌`
   - 用户把另一条世界线的一张摘要卡拖进当前房间，要求 `Archivist` 解释两线差异
   - 仍然只能引用摘要，不得拉全文

### 设计原则

- 时间短
- 反馈快
- 不重跑整局
- 不制造复杂状态机
- 所有玩法都必须锚定某张结局卡或某个关键转折卡

---

## 3.7 Phase G — Persona Vocabulary / Theme Skin / Atmosphere Polish

> 状态：**done**
> 说明：本轮已完成更深的 persona vocabulary、profile skin、hook chips、ambient drift 与 roundtable mobile 顶部状态带清晰度修复。

### 目标

把 Oracle 当前“已经可玩”的基线继续抬到“更像这个角色、这个题材、这个房间里的话”。

一句话要求：

`先拉开角色说话习惯，再让题材皮肤和氛围层只负责放大这些差异。`

### G1. Persona-specific Vocabulary

后端优先做：

1. 同题材下不同角色的词汇习惯拉开
   - `ruler / imperial`
   - `field commander`
   - `civic operator`
   - `finance / settlement`
   - `market / cashflow`
   - `scholar / witness / archivist`
2. hotseat 与 all-present 的句式分工继续拉开
   - `hotseat`: 先答，再钉 hinge/cost
   - `all_present`: 每位 speaker 只补一个角度，不替全场总结
3. 加强冲突感
   - 不只“说不同内容”，还要“说得像不同立场的人”

建议拆成：

```text
G1-A: persona vocabulary dictionaries
G1-B: interaction-mode-specific cadence
G1-C: conflict / tension shaping
```

### G2. Theme Skin + 微动效 + 氛围层

前端只做放大，不改主骨架：

1. 继续复用现有 `GameplayProfile` 资产
   - 不另起第二套 Oracle design system
2. 允许补强：
   - profile-specific frame / chip / accent
   - ambient float / glow / dust / scroll shimmer
   - profile-specific audio / SFX（若后续引入）
3. 当前已落地：
   - `EndingChatModal / WorldlineRoundtableView` 的更轻 ambient drift
   - Oracle 页面当前跟随用户 UI 语言，而不是反向被 scenario 语言覆盖
4. 禁止：
   - 因为想“更沉浸”而牺牲可读性
   - 因为题材化而把页面重新设计成另一款产品

### G3. 题材与 Theater 联动（可后置）

这节不是当前阻塞，但可以在 G1/G2 之后推进：

1. Oracle room 与当前 `scene_theme / gameplay profile` 的背景 motif 联动
2. Roundtable / Chamber 的 skin 与 Theater scene 形成弱关联
3. 仍然不允许读取越权上下文，不允许引入“看起来很像跨线”的误导视觉

### 验收

只有以下都满足，才能把 Phase G 视为完成：

1. 同题材下不同角色的开头与词汇明显不同
2. `Archivist` 不再和普通 speaker 撞节奏
3. `law / faith / empire / frontier / governance ...` 至少 5 个 profile 的词汇感可区分
4. fallback 路径也保留题材感，而不是一掉回 generic
5. profile skin 与 hook chips 不影响移动端首屏可追问
6. UI 仍然属于当前 SwarmOracle 视觉语言，而不是新产品

---

## 3.8 Phase H — Replay/Share Final Signoff + Next Playability Expansions

> 状态：**after Phase G**

### 目标

在不打断当前可玩主链的前提下，把 replay/share 彻底收口，再考虑轻玩法扩展。

### H1. Replay / Share / Import 最终签收

必须单独签收：

1. ending-room permalink
2. roundtable permalink
3. readonly replay
4. import local run
5. share 文案中英一致

### H2. 轻玩法扩展（只在 H1 完成后）

推荐顺序：

1. `expert_witness / witness_augmented`
   - 已完成
2. `trait_mix / fault_line_first`
   - 已完成
3. `后续三回合`
   - 已完成：后端 `EPILOGUE` 交互模式 + 前端按钮（EndingChatModal / WorldlineRoundtableView）
4. `证据投牌`
   - 已完成：后端 `EVIDENCE_CARD` 交互模式 + `cited_branch_id` / `cited_refs_json` 全链路 + 前端证据卡抽屉面板
   - `cited_branch_id` 含 scenario 级验证，`cited_refs_json` 含 4 KB 大小限制

要求：

- 任何新增玩法都不能破坏 room/thread scope
- 任何新增玩法都不能把 Oracle 变成通用 chat 平台
- 任何新增玩法都必须锚定结局卡 / 转折卡 / quote / verdict

---

## 4. 详细任务拆解

## 4.1 后端任务

### B1. 数据模型

- 新建 `ending_room*` 表
- `ending_room_turn` 至少补：
  - `thread_id`
  - `source`
  - `interaction_mode`
  - `memory_partition_id`
- 建索引：
  - `scenario_id`
  - `anchor_branch_id`
  - `room_type`
  - `participant_set_hash`
- 为 `(scenario_id, anchor_branch_id, room_type, participant_set_hash)` 增加去重能力
- 新增：
  - `ending_room_thread`
  - `ending_room_thread.participant_set_hash`
  - `ending_room_thread.question_anchor_ids_json`
  - `ending_room_participant.worldline_echo_key`

### B2. API

- 新建 `ending_rooms.py`
- 加输入校验：
  - `anchor_branch_id` 必须属于 `scenario_id`
  - `selected_branch_ids` 不得为空
  - 不允许非结局 branch 创建 `ending_chamber`
- 新增 `POST /api/ending-room/{room_id}/user-turn`
  - 校验 `interaction_mode`
  - 校验 `addressed_agent_ids` 必须属于当前 room candidate set
  - 校验 replay / read-only 模式不可继续 live 追问
- 若引入 thread 化，新增：
  - `POST /api/ending-room/{room_id}/thread`
  - `GET /api/ending-room/thread/{thread_id}`
  - `POST /api/ending-room/thread/{thread_id}/user-turn`
- `user-turn` 与 `thread create` 当前都应接受：
  - `question_anchor_ids`
  - 并在 response snapshot 中回显 `question_anchor_ids_json`

### B3. WS

- 新增 `/api/ws/ending-room/{room_id}`
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
- follow-up context 只允许拼：
  - 当前 room transcript
  - 当前 branch transcript / summary
  - 当前 room participant snapshots
- 不允许把“同 branch 旧房间 transcript”作为记忆补充
- 若启用 `followup_thread`：
  - thread context 只允许在 room context 上再追加当前 thread transcript
  - 不允许读取其他 thread transcript
  - `worldline_echo_key` 必须纳入 cache / retrieval partition

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

### C2.5 结果页选人面板（新增，Mandatory）

- CTA 不再直接建 room
- 先打开 `participant picker`
- picker 负责：
  - 展示当前 worldline 实际参与者
  - 预选推荐阵容
  - 手动改单选/多选
  - 解释“为什么推荐这些人”

### C2.6 结果页 roster 对齐（新增，Mandatory）

- 底部 `参与 Agent` 区块和会客厅里的参与者列表必须语义对齐：
  - 前者：整局实际 roster
  - 后者：当前 branch 候选 roster + 当前选中 roster
- UI 必须显式说明：
  - 谁是“参与过这条世界线”
  - 谁是“本次进入会客厅”

### C3. 单结局会客厅组件

- `EndingChatModal.tsx`
  - transcript
  - 当前结局摘要
  - 模式切换
  - participant strip
  - sprite avatar
  - role / persona / impact
  - close / share / replay-ready 保留位
  - 若启用流式：
    - `pendingDraftByTurnId`
    - draft -> commit 替换逻辑
    - 自动滚动但不抖动
  - 必须支持：
    - story 摘要折叠 / 展开
    - 当前 speaker 高亮
    - 重新选人后重建 room
    - 自动复盘结束后继续追问
    - `hotseat / archivist_route / all_present` 三种 follow-up 模式切换
    - thread 切换或 thread 恢复
    - 当前 thread 的 scope 提示
    - 从 `key_moment / quote / verdict` 直接注入追问草稿
    - 从 `结局卡 / 关键转折卡 / quote` 直接起追问
    - follow-up 模式下也走 mixed streaming：
      - `followup_turn_start / followup_turn_delta / followup_turn_commit`
      - 当前 responder 高亮
      - thread 级 draft state 按 `thread_id` 隔离

### C3.5 追问线程组件（新增）

- `EndingRoomThreadPanel.tsx`
  - thread transcript
  - source anchor badge
  - thread participant strip
  - close back to room
- `WorldlineEchoCard.tsx`
  - 头像
  - role / persona / impact
  - why here
  - `问这个人`
  - `加入圆桌`
- `EndingRoomFollowupComposer.tsx`
  - quick chips
  - 当前锚点说明
  - 当前 scope 提示

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
  - verdict 后支持当前桌追问，但要继续显示 scope 提示：
    - `只基于当前入桌世界线摘要与当前桌历史`
  - 圆桌 follow-up 若启用流式：
    - 当前 responder 高亮与正文 draft 保持同步
    - 不能只在自动复盘有流式，追问退回整段 commit

### D2. i18n

- 中英双语全部同时落地
- 不允许先写中文后补英文
- `agent role / persona / influence / selection_reason / active speaker` 等新增字段必须中英同时齐全
- 不允许出现“中文 UI + 英文套话正文”或反向串语

## 4.3 测试任务

- 补单元测试
- 补 store/hook 测试
- 补结果页行为测试
- 补新 E2E suite
- 补 cross-browser / mobile smoke
- 补 participant picker / avatar / replay permalink / read-only chamber 场景

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
- branch 有 `10+` 参与者时，默认推荐阵容是否稳定
- selected agent 在 room 创建后被删除时，replay 是否仍能显示人物卡
- agent 全程 silent 时，是否会错误进入候选 roster
- `one_move_only` 若用户不选人，是否会稳定 fallback 到 top 1
- `ending_chamber` 若用户改选后刷新页面，room 是否按选人维度正确恢复
- 多结局结果页中，从 ending A 打开 chamber 后立刻关闭，再打开 ending B，是否仍正确命中 B 的 branch
- 多结局结果页中，两张 ending card 的默认推荐阵容是否各自独立
- 多结局结果页中，A/B 两个 ending 的 story / insight / key_moments / participant roster 是否串线
- 同一 ending 下，`archivist_route` 与 `hotseat` 是否正确形成不同 thread
- `trait_mix` 若选不出足够角色，是否能稳定降级到 `impact_top`
- 圆桌 `expert_witness` 被移除后，旧 quote / witness badge 是否正确失效

### 5.2 隔离与权限

- `ending_chamber` 不读取他线全文
- `worldline_roundtable` 不读取他线全文
- `crossline_gallery` 不显示全文 transcript
- replay/import 不扩大权限边界
- L2 向量检索不串 branch
- 手动选人不会扩大世界线全文读取范围
- `selected_agent_ids` 只影响 participant roster，不得影响 branch scope
- 角色 bio / 影响力说明不得泄露其他 branch 才知道的信息
- 多结局结果页下，从 ending A 进入 `one_move_only` 时，不得读取 ending B 的全文或 key moments
- `hotseat` 不得读取该 agent 在其他 room / 其他 worldline 的结局后对话
- 圆桌 verdict 后的追问不得读取未入桌世界线全文
- `memory_partition_id` 变化后，旧 thread 不得被新 thread 复用
- 同一 `source_agent_id` 在 ending A / ending B 下的 `worldline_echo` 不得共享追问历史
- 从某条 `quote / verdict` 发起的追问线程，不得读取其他 quote thread 的历史

### 5.3 WS 与并发

- 双标签同时创建同 scope room
- 重连后 turn 不重复
- 页面刷新后 room 恢复正确
- 背景任务失败时前端能见错误，不 silent fail
- `turn_delta` 丢包后，`turn_commit` 仍能正确收口
- 迟到的 `turn_delta` 不能覆盖已 commit 内容
- draft 气泡不能因 sequence 重放生成重复卡片
- 选人后立刻建 room，如果 room 比 WS 建连更快完成，前端是否会主动 resync
- `selection_mode=manual` 与 `selection_mode=auto` 不能互相串 room
- 同一 branch 但不同 `selected_agent_ids` 不得被 dedupe 成同一 room
- 多结局结果页下，同时打开 ending A / ending B 的两个标签页时，不得串 `room_id`
- 多结局结果页下，先后快速点击两张卡的 CTA，不得把后到事件写进先开的 modal
- 自动复盘刚结束时立刻发送追问，不能把 `auto_recap` draft 写进 follow-up thread
- 圆桌 verdict 后立刻追问，不能把追问 turn 插进 `verdict` 阶段 transcript 中间
- 同一 room 下连续打开两个不同 `followup_thread` 时，不得串 transcript
- thread 比 WS 建连更快完成时，前端也必须补拉 snapshot/result
- `followup_turn_start` 已到但 `followup_turn_delta` 迟到时，active speaker 不得卡死
- `followup_turn_commit` 到达后，旧 draft 不得残留在 thread transcript 中
- `all_present` 多 responder 场景下，draft 必须串行切换，不得同屏多个 active draft 泡

### 5.4 i18n

- 中文问题 -> 中文生成 + 中文 UI
- 英文问题 -> 英文生成 + 英文 UI
- 长英文按钮在移动端不溢出
- 长中文结局标题不溢出
- 流式中文分句不应出现明显断裂或半个标点单独闪烁
- 流式英文长句换行不应引发 layout 抖动
- 中英双语下 agent bio 都必须读起来自然，不像字段拼接
- 中英混合名字（如 `Mara Veld`）在中文 UI 下仍不应破版

### 5.5 响应式

- `1600x900`
- `1280x800`
- `1024x768`
- `430x932`
- `390x844`
- `375x812`
- 选人面板打开态
- 选人面板 -> modal 过渡态
- story 展开后 modal 高度
- transcript 超长后滚动
- avatar + role + persona 卡片在窄屏两列/单列时不挤压

### 5.6 只读与回放

- replay 模式禁止 live room 创建
- imported room 只读
- share 后打开结果一致
- share permalink 不得出现“artifact 能创建但 fresh context 打不开”的不稳定状态
- replay 下点击 `进入会客厅 / 只改一步` 只能读取既有 payload，不得重新发 POST
- replay 下点击 `继续追问 / 点名追问 / 当前全员回应` 必须禁用

### 5.7 可玩性与观感

- 用户第一次进入 modal 时，能否在 `3` 秒内理解“我在和谁复盘”
- 用户能否一眼区分：
  - 角色发言
  - 档案官收束
  - `只改一步` 建议
- 长 story 是否默认可读，而不是一眼就是信息墙
- 当前发言者是否有足够明显但不刺眼的动态反馈
- 像素头像是否与角色/题材匹配，而不是随机感过强
- 文案是否像“角色说话”，而不是“系统解释”
- 用户能否一眼看懂当前是：
  - 自动复盘
  - 热座追问
  - 同线听证
  - 跨线圆桌

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
     - 对本条线新增专项：
       - `结果页 CTA -> picker -> confirm -> chamber done`
       - `结果页 CTA -> picker -> one_move_only done`
       - `关闭 -> 重开 -> 状态恢复`
       - `390x844` 小屏动作链
     - 对流式场景额外覆盖：
       - `turn_start` 截图
       - `turn_delta` 中间态截图
       - `turn_commit` 结束态截图
       - `followup_turn_start` 截图
       - `followup_turn_delta` 中间态截图
       - `followup_turn_commit` 结束态截图
2. `playwright-interactive`
   - 用于桌面/移动端持续调试
   - 必须写 QA inventory，再做功能 QA + 视觉 QA
   - 对流式场景专项检查：
     - 文本增长是否平滑
     - draft / commit 替换是否正确
     - 小屏滚动跟随是否稳定
     - follow-up 是否也具备与经典模式一致的“当前说话中”视觉反馈
   - 对本条线新增专项：
      - participant card 是否与当前世界线 roster 对齐
      - speaker avatar / active ring / pulse 是否正确
      - `one_move_only` 是否像人物建议，而不是系统提示
3. `Playwright CLI Skill`
   - 用于快速 smoke、按钮文案、路由、modal、只读态检查
   - 对本条线新增专项：
      - picker 文案与按钮可达性
      - replay permalink / replay 只读
      - 中文/英文文案切换后 refetch 是否稳定
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
frontend/scripts/e2e-ending-room-followup-suite.mjs
frontend/scripts/e2e-worldline-roundtable-suite.mjs
```

运行命令建议：

```bash
cd frontend
node scripts/e2e-ending-room-suite.mjs desktop --url http://127.0.0.1:18928 --output-dir output/e2e/ending-room-desktop --headless
node scripts/e2e-ending-room-suite.mjs mobile --url http://127.0.0.1:18928 --output-dir output/e2e/ending-room-mobile --headless
node scripts/e2e-ending-room-suite.mjs full --url http://127.0.0.1:18928 --output-dir output/e2e/ending-room-full --headless
node scripts/e2e-ending-room-followup-suite.mjs full --url http://127.0.0.1:18928 --output-dir output/e2e/ending-room-followup-full --headless
node scripts/e2e-worldline-roundtable-suite.mjs full --url http://127.0.0.1:18928 --backend-url http://127.0.0.1:18927 --output-dir output/e2e/worldline-roundtable-full --headless
```

## 6.3 QA Inventory 模板

每轮实施前先列 inventory：

```yaml
claims:
  - 结果页每张结局卡可进入会客厅
  - 用户可看见当前世界线真实参与者
  - 用户可手动选择进入会客厅/只改一步的 agent
  - 会客厅只读取当前世界线全文
  - 多结局结果页里，每张结局卡分别进入时也只读取自己的世界线
  - 用户可以围绕当前结局/当前转折/当前角色继续追问
  - 世界线圆桌只读取他线摘要
  - 中文/英文都自然、无溢出
  - 390px 移动端可用
  - 流式时 draft 与 commit 状态一致且不重复
  - 会客厅文案像人话，不像系统套话
  - 头像/角色卡/影响度让用户能理解“为什么是这些人”

controls:
  - 进入会客厅
  - 从第二张 / 第三张 ending card 进入会客厅
  - 打开选人面板
  - 单选 agent
  - 多选 agent
  - reset 推荐阵容
  - 打开角色追问线程
  - 打开转折追问线程
  - 发送 `all_present` 追问
  - 关闭会客厅
  - 发起圆桌
  - 切换阶段
  - 打开旁听席
  - replay 打开

state_checks:
  - loading -> live -> done
  - picker open -> selection -> confirm -> room create
  - single ending -> chamber
  - multi ending -> chamber on ending A
  - multi ending -> chamber on ending B
  - multi ending -> one_move_only on ending A
  - multi ending -> one_move_only on ending B
  - chamber done -> hotseat followup
  - chamber done -> archivist_route followup
  - chamber done -> all_present followup
  - multi ending -> roundtable
  - roundtable verdict -> followup
  - replay -> read only
  - zh -> en locale
  - turn_start -> turn_delta -> turn_commit
  - ending_chamber(selected A+B) -> reopen(selected A+B)
  - ending_chamber(selected A+B) -> reopen(selected A)

exploratory:
  - 多标签同时开同一个房间
  - room 运行中刷新页面
  - 切英文后重新进入结果页
  - 在流式过程中关闭再重开 modal
  - 在流式过程中刷新页面观察 committed turn 恢复
  - 手动改选一个冷门 agent，观察文案是否仍具体
  - 连续切 `复盘 <-> 只改一步`，确认不会串状态
  - 在多结局结果页里交替点两张 ending card 的 CTA，观察是否串 ending
  - 在同一结局里连续打开两个不同追问主题，观察 thread 是否隔离
  - 在 A 结局和 B 结局分别追问同名角色，观察 `worldline_echo` 是否隔离
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
npm test -- --run src/pages/ResultView.test.tsx src/components/EndingChatModal.test.tsx src/hooks/useEndingRoomWS.test.tsx src/stores/endingRoomStore.test.ts src/pages/WorldlineRoundtableView.test.tsx
npx tsc --noEmit -p tsconfig.app.json
npm run build
node scripts/e2e-suite.mjs corners --url http://127.0.0.1:18928 --output-dir output/e2e/post-ending-corners --headless
node scripts/e2e-suite.mjs cross-browser --url http://127.0.0.1:18928 --output-dir output/e2e/post-ending-cross-browser --headless
node scripts/e2e-ending-room-suite.mjs full --url http://127.0.0.1:18928 --output-dir output/e2e/post-ending-room --headless
node scripts/e2e-ending-room-followup-suite.mjs full --url http://127.0.0.1:18928 --output-dir output/e2e/post-ending-room-followup --headless
node scripts/e2e-worldline-roundtable-suite.mjs full --url http://127.0.0.1:18928 --backend-url http://127.0.0.1:18927 --output-dir output/e2e/post-ending-roundtable --headless
```

流式专项建议：

```bash
cd frontend
node scripts/e2e-ending-room-suite.mjs full --url http://127.0.0.1:18928 --output-dir output/e2e/post-ending-room-streaming --headless --require-streaming
node scripts/e2e-ending-room-followup-suite.mjs full --url http://127.0.0.1:18928 --output-dir output/e2e/post-ending-followup-streaming --headless --require-streaming
```

---

## 7. Review Gate

## 7.1 架构 Review

- 是否新增独立 `ending room` 域
- 是否所有读取路径显式带 scope key
- 是否 replay/import 仍保持相同权限边界
- 是否没有把新玩法写回原始 simulation transcript
- 是否 follow-up thread 采用 room-scope memory membrane，而不是 scenario-scope history

## 7.2 实现 Review

- 是否存在重复 room / 重复 turn / 重复 WS 事件
- 是否存在 draft / commit 错位或迟到 delta 覆盖 commit
- 是否移动端入口、正文、按钮无裁切
- 是否 replay 只读态可靠
- 是否所有中英 copy 都有对应 key
- 是否会客厅 participant roster 与当前 worldline 实际参与者一致
- 是否支持手动选人，且选人结果真正影响 room
- 是否支持围绕当前锚点继续追问，且 thread scope 正确
- 是否支持 `archivist_route / hotseat / all_present`，且三者对用户可区分
- 是否存在“选了 A，结果发言的是 B”的错位
- 是否发言卡上有头像 / role / persona / impact，而不是只有名字
- 是否存在大段信息墙压垮可读性的情况

## 7.3 QA Review

- 每个 claim 有对应截图
- `render_game_to_text` 与屏幕状态一致
- console 无新增报错
- 至少完成一次探索式测试
- 对启用流式的页面，必须同时保留：
  - draft 中间态截图
  - commit 完成态截图
  - 对应 `render_game_to_text` 状态
- 对 participant picker 与角色卡，必须同时保留：
  - picker 初始态截图
  - manual selection 态截图
  - chamber done 态截图
  - mobile `390x844` 截图
- 对 follow-up thread，必须同时保留：
  - 角色热座初始态截图
  - 转折追问态截图
  - thread done 态截图
- 对多结局结果页，必须额外保留：
  - ending A -> chamber done 截图
  - ending B -> chamber done 截图
  - ending A -> one_move_only done 截图
  - ending B -> one_move_only done 截图
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
- 用户无法理解“为什么是这些 agent”
- `只改一步` 像系统总结而不是人物建议
- 角色卡没有头像/角色/背景说明
- replay permalink 在 fresh context 下不稳定
- 多结局结果页里，不同结局卡进入 chamber 时发生串线
- A/B 两个结局下同名角色的 `worldline_echo` 发生记忆串线
- replay / read-only 模式下仍能继续 live 追问

---

## 8. 美术与素材计划

> 状态更新（2026-03-29，晚）：
> - 这轮已按现有画风补齐一整套 Oracle / Roundtable 专属 UI 资产：
>   - `oracle_chamber_panel / oracle_chamber_crest / oracle_quote_frame`
>   - `worldline_roundtable_panel / worldline_roundtable_banner`
>   - `badge_ending_chamber / badge_worldline_roundtable / badge_crossline_gallery`
>   - `ending_room_participant_frame / ending_room_influence_badge / ending_room_speaker_glow`
>   - `timeline_marker_chamber / timeline_marker_roundtable`
>   - `archivist_emblem / worldline_dossier_divider`
> - 这些资产当前都已写同名 `.meta.json` provenance sidecar
> - 当前已实际接到 UI 的部分：
>   - picker / chamber 的 `panel + crest`
>   - transcript bubble 的 `quote frame`
>   - participant / picker card 的 `influence badge`
>   - active speaker 的 `speaker glow`
>   - thread rail 的 `dossier divider`
> - `worldline_roundtable_panel / banner / badge` 当前已入库和 registry，但仍等真正的 Roundtable 页面接线

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
- `sprite_*` 角色资源
- `VizSynthesizer` 的 role/name -> sprite 映射

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
ending_room_participant_frame
ending_room_speaker_glow
ending_room_influence_badge
archivist_emblem
worldline_dossier_divider
```

## 8.4 AI 素材生成流程

已获用户批准将 Google 图像线路纳入实施方案。

执行顺序必须固定：

1. 先盘点缺口
2. 先确认现有 `sprite_*` 是否足够
3. 只生成缺的 UI asset
4. 生成内容优先是：
   - panel / badge / emblem / ornament
   - dossier portrait / archivist portrait
   - 不优先替换已有 runtime sprite
5. 优先 `gemini-3.1-flash-image-preview`
6. 细节不够再升 `gemini-3-pro-image-preview`
7. 生成后写 provenance sidecar
8. 跑：

```bash
cd frontend
npm run assets:provenance:check
```

注意：

- 不在本执行文档中内嵌任何密钥
- 实际调用时通过环境变量或本地安全配置注入
- 生成风格需与现有档案/圆桌/UI frame 调性对齐

补充风格要求：

- 若生成 portrait，必须与现有像素 sprite 风格兼容
- 不得出现高写实头像贴进像素 UI 的风格断层
- 不得生成“像社交 app 头像”的现代照片质感头像

## 8.5 会客厅体验层的素材优先级

第一优先（必须做）：

- 复用现有 sprite 作为 participant avatar
- speaker pulse / active ring / focus frame
- 角色影响力 badge

第二优先（如工期允许）：

- `Archivist` 专属像素肖像或徽章
- 按题材 profile 区分的 chamber accent ornament

第三优先（后续）：

- 每个 gameplay profile 的 chamber side motif
- `worldline_roundtable` 专属台面/席位背景

---

## 9. 可玩性验收标准

只有满足以下全部条件，才能声称“功能正常实现，且确实可玩”：

1. 单结局会客厅可以稳定进入、退出、重开
2. 用户能看见当前世界线真实参与者
3. 用户能手动选择 1 个或多个参与者
4. transcript 与当前世界线一致
5. 角色卡能解释：
   - 他是谁
   - 为什么在这里
   - 对该结局影响有多大
6. 世界线圆桌的代表逻辑可理解、结果可复盘
7. `只改一步` 在 30 秒内给出具体、像人话的建议
8. 用户能围绕当前结局、当前转折、当前角色继续追问
9. 用户能区分 `archivist_route / hotseat / all_present` 三种追问模式
10. `异线旁听席` 轻量、清楚、不泄露他线全文
11. 中英双语都自然
12. 桌面/移动主流浏览器中 UI 不裁切、不失真
13. 无新增显性或隐性跨世界线污染
14. 若开启流式，用户能感知到“正在发言”，但最终 transcript、replay、share 只依赖 committed turn
15. 头像、动态效果、排版与题材语义一致，不像另一款产品
16. 单结局与多结局结果页都分别签收过 `进入会客厅 / 只改一步 / 追问线程`
17. 圆桌 verdict 后继续追问时，用户能清楚知道当前仍被限制在“本桌 scope”内
18. 同题材下不同角色的说话习惯可区分，不是“同一段话换个名字”
19. `law / faith / empire / frontier / governance ...` 的 profile 词汇感能被用户感知到
20. fallback 路径也保持题材感与角色感，不会一退回就变 generic
21. profile skin / hook chips / 微动效只放大文案差异，不破坏移动端首屏与可读性

---

## 10. 建议执行顺序

历史阶段的当前口径：

1. `Phase A-D`
   - 已完成并具备可玩基线
   - 本轮又额外补到了：
     - `crossline_gallery`
     - `manual_shortlist`
     - `expert_witness`
2. `Phase E`
   - 基线已通，待最终专项签收
3. `Phase F`
   - 暂未进入正式优先级

从下一次继续执行开始，推荐严格按以下顺序推进：

1. `Phase G1`
   - persona-specific vocabulary
2. `Phase G2`
   - theme skin + 微动效 + 氛围层
3. `Phase G3`
   - Oracle 与 Theater 的弱联动皮肤（可后置）
4. `Phase E`
   - replay/share/import 最终专项签收
5. `Phase H2 / Phase F`
   - 轻玩法扩展
6. 最终 `release:signoff`

如果资源有限，首个可交付里只做：

- `结局会客厅`
- `只改一步`
- `真实参与者选人`
- `像素头像 + 人物卡 + 影响度`
- `archivist_route + hotseat`
- `角色/转折/结论 -> 追问线程`
- 必要 i18n
- 桌面 + 移动 E2E

当前已经不需要再把 `世界线圆桌` 放到第二个迭代里讨论“要不要做”。它已经在可玩基线上。

真正不允许的是：

- 在 persona/theme 文案层还没继续拉开时，就直接堆更复杂的 UI
- 在 replay/share/import 没做最终签收前，就同时开太多新玩法分支

---

## 11. 落地蓝图

这一节不是概念补充，而是“按实现顺序拆开的工程任务单”。目标是让下一次真正进入编码时，可以直接按本节开工。

## 11.1 PR 拆分建议

推荐按 `5` 个 PR 推进，不要一个超大 PR 全包：

1. `PR-1: room-scope memory membrane`
   - 收口后端数据模型
   - 明确 `worldline_echo / followup_thread / memory_partition_id`
   - 补基础 API 校验与测试
2. `PR-2: picker + roster + recipe`
   - 结果页选人面板
   - `impact_top / responsibility_mix / disagreement_pair / trait_mix`
   - roster 对齐与 room dedupe
3. `PR-3: ending followup threads`
   - `archivist_route / hotseat / all_present`
   - thread UI、thread store、thread WS、thread replay 只读
4. `PR-4: worldline roundtable`
   - `representative / manual_shortlist / expert_witness / witness_augmented`
   - `Archivist` 主持编排
   - verdict 后当前桌追问
5. `PR-5: replay/share/import + signoff`
   - replay artifact
   - permalink
   - share modal
   - import/read-only

每个 PR 都必须独立通过最小验证，不允许把“线程隔离”或“读权限限制”压到最后一起补。

## 11.2 后端详细拆解

### 11.2.1 数据模型

建议优先沿现有文件扩展：

- `backend/app/models/ending_room.py`
- `backend/app/models/database.py`

建议最少补齐以下字段：

```text
ending_room
  discussion_mode
  memory_partition_version
  selection_mode
  selected_agent_ids_hash nullable

ending_room_participant
  worldline_echo_key
  selection_reason
  impact_score
  key_moment_hits
  last_round_spoken

ending_room_thread
  id
  room_id
  thread_mode
  interaction_mode
  participant_set_hash
  anchor_kind        # key_moment | quote | verdict | role | freeform
  anchor_id nullable
  title
  created_at
  updated_at

ending_room_turn
  thread_id nullable
  source             # auto_recap | user_followup
  interaction_mode nullable
  memory_partition_id
  addressed_agent_ids_json nullable
  question_anchor_ids_json nullable
```

索引最低要求：

- `ending_room(scenario_id, anchor_branch_id, room_type, participant_set_hash)`
- `ending_room_thread(room_id, participant_set_hash, interaction_mode)`
- `ending_room_turn(room_id, sequence)`
- `ending_room_turn(thread_id, sequence)`
- `ending_room_participant(room_id, source_agent_id)`

### 11.2.2 服务层职责

建议在 `backend/app/services/ending_room_service.py` 中显式拆出以下 helper：

```text
collect_branch_participant_candidates(...)
rank_branch_participant_candidates(...)
apply_selection_recipe(...)
create_followup_thread(...)
append_user_turn(...)
resolve_followup_responders(...)
build_room_followup_context(...)
build_thread_followup_context(...)
run_followup_thread_background(...)
build_roundtable_seating(...)
run_roundtable_hidden_planning(...)
```

执行顺序建议：

1. `create_ending_room(...)`
   - 校验 `scenario / branch / room_type`
   - 标准化 `selected_branch_ids`
   - 计算 `participant_set_hash`
   - 生成或复用 room
2. `collect_branch_participant_candidates(...)`
   - 只从当前 branch 的真实发言者里取候选
   - 若为空再 fallback 到 scenario roster
3. `apply_selection_recipe(...)`
   - 将 recipe 转成稳定的 `selected_agent_ids`
4. `run_ending_room_background(...)`
   - 自动复盘
   - committed turn 落库
   - result 收口
5. `create_followup_thread(...)`
   - 基于 `room_id + interaction_mode + participant_set_hash + anchor`
   - 生成 thread
6. `append_user_turn(...)`
   - 落用户追问
   - 触发 follow-up background
7. `run_followup_thread_background(...)`
   - 路由 responder
   - 可选 hidden planning
   - committed follow-up turn 落库

### 11.2.3 Room-Scope Memory Membrane

这部分必须写成单独 helper，不能散落在 prompt 拼接代码里。

建议明确三层上下文拼装函数：

```text
build_worldline_source_memory(anchor_branch_id)
build_room_memory(room_id)
build_thread_memory(thread_id)
```

拼装规则固定为：

1. `ending_chamber auto_recap`
   - `worldline source memory`
2. `ending_chamber followup`
   - `worldline source memory`
   - `room memory`
   - `thread memory`
3. `worldline_roundtable`
   - 当前席位自己的全文
   - 他席摘要
   - 当前桌 committed transcript
4. `roundtable followup`
   - 当前桌 committed transcript
   - 当前桌可见摘要
   - 当前 followup thread transcript

严禁出现：

- 从 `scenario_id` 反查整局历史对话
- 从 `source_agent_id` 反查其他 worldline 的 post-ending 对话
- 读取“同 branch 但旧 room”的 transcript 作为补充记忆

### 11.2.4 Follow-up 路由逻辑

`archivist_route` 不该是随机挑人，至少应按以下信号排序：

1. `question_anchor_ids` 命中
2. `key_moment_hits`
3. `impact_score`
4. 最近是否在该 room 发过言
5. 是否与当前问题语义最接近

`hotseat` 的规则更简单：

- 第一响应人必须是被点名者
- `Archivist` 可追加 `1` 条收束
- 其他参与者默认不上麦

`all_present` 的规则：

- 首版正文区只展示 `3-4` 名 active speakers
- 其余人写入折叠摘要，不在正文区刷屏

### 11.2.5 Hidden Planning

可以用 sub-agents，但必须只在后台做“证据整理”和“冲突提炼”。

允许：

- 从当前可见上下文中提取证据片段
- 生成候选回应大纲
- 对多个 responder 的候选观点做去重和排序

禁止：

- 让 hidden agent 自己生成正式 transcript
- 让 hidden agent 读取更大范围的数据
- 把 hidden planning 结果直接暴露给前台

正式 transcript 只能来自：

- `Archivist`
- 当前 room / 当前桌明确入席的参与者

## 11.3 API 合同细化

建议在 `backend/app/api/ending_rooms.py` 追加以下请求模型：

```text
CreateEndingRoomThreadRequest
AppendEndingRoomUserTurnRequest
```

推荐最小请求体：

```json
POST /api/ending-room/{room_id}/thread
{
  "interaction_mode": "archivist_route | hotseat | all_present",
  "anchor_kind": "key_moment | quote | verdict | role | freeform",
  "anchor_id": "km_2",
  "addressed_agent_ids": ["ag_xxx"],
  "selection_recipe": "manual | impact_top | responsibility_mix | disagreement_pair | trait_mix"
}
```

```json
POST /api/ending-room/{room_id}/user-turn
{
  "thread_id": "ert_xxx",
  "question_text": "如果当时不是你主导，会不会变成另一种结局？",
  "interaction_mode": "hotseat",
  "addressed_agent_ids": ["ag_xxx"],
  "question_anchor_ids": ["km_2"]
}
```

错误码至少显式化：

```text
ENDING_ROOM_NOT_FOUND
ENDING_ROOM_READ_ONLY
ENDING_ROOM_THREAD_NOT_FOUND
ENDING_ROOM_THREAD_SCOPE_MISMATCH
ENDING_ROOM_AGENT_NOT_VISIBLE
ENDING_ROOM_INTERACTION_MODE_INVALID
ENDING_ROOM_CROSSLINE_ACCESS_DENIED
```

## 11.4 Prompt 链路建议

建议把 prompt 分成四层，而不是一个超大 prompt：

1. `candidate extraction prompt`
   - 只做证据片段提取
2. `archivist routing prompt`
   - 决定谁回答、为什么
3. `speaker response prompt`
   - 角色化短回应
4. `archivist wrap-up prompt`
   - 收束、指出分歧或限制

每层都必须显式写进 prompt 的限制：

- 只基于当前可见 worldline / room / thread
- 不得杜撰未在当前上下文出现的另一条世界线细节
- 句子短
- 角色说话像人在复盘，不像系统报告

建议固定输出 schema，避免前端靠字符串猜：

```json
{
  "speaker_id": "erp_xxx",
  "cited_evidence": ["km_2", "turn_14"],
  "stance": "defend | regret | accuse | reframe",
  "content": "..."
}
```

## 11.5 前端详细拆解

### 11.5.1 ResultView

建议在 [ResultView.tsx](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/pages/ResultView.tsx) 做四步流：

1. 点击结局卡 CTA
2. 打开 `participant picker`
3. 选择 `selection_recipe` 或手动选人
4. 确认后进入 `EndingChatModal`

CTA 层不应该直接发 room 请求，也不应该直接进入 modal。

### 11.5.2 EndingChatModal

建议把 [EndingChatModal.tsx](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/components/EndingChatModal.tsx) 拆成：

```text
EndingChatModal
  EndingRoomSidebar
  EndingRoomTranscript
  EndingRoomParticipantStrip
  EndingRoomFollowupComposer
  EndingRoomThreadList
```

底部 composer 建议固定三段：

1. `interaction_mode switch`
2. `anchor quick actions`
3. `question input + send`

必须有可见 scope 提示：

- `只基于当前世界线`
- `只基于当前桌面`
- `只基于当前追问线程`

### 11.5.3 Store

建议扩展 [endingRoomStore.ts](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/stores/endingRoomStore.ts)：

```text
threadsById
activeThreadId
threadOrder
pendingDraftsByThreadId
interactionMode
selectionRecipe
composerDraft
scopeNotice
```

关键点：

- `room transcript` 和 `thread transcript` 不能混成一个数组
- draft 也不能只按 `turn_id` 存，最好包含 `thread_id`
- thread 切换时不能把另一个 thread 的 draft 泄露过来

### 11.5.4 WS 事件

建议在 [useEndingRoomWS.ts](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/hooks/useEndingRoomWS.ts) 补事件：

```text
ending_room_thread_created
ending_room_user_turn_commit
ending_room_followup_turn_start
ending_room_followup_turn_delta
ending_room_followup_turn_commit
ending_room_scope_notice
```

处理原则：

- `room_*` 事件更新 room transcript
- `followup_*` 事件更新 thread transcript
- 两类事件的 sequence 可以共用，但前端必须按 `thread_id` 再分桶

## 11.6 测试文件建议

建议新增或扩展：

### Backend

```text
backend/tests/test_ending_room_service.py        # 当前 follow-up / memory partition 已并入这里
backend/tests/test_ending_room_api.py
backend/tests/test_ending_room_ws.py
```

### Frontend

```text
frontend/src/components/EndingChatModal.test.tsx
frontend/src/hooks/useEndingRoomWS.test.tsx
frontend/src/stores/endingRoomStore.test.ts
frontend/src/pages/WorldlineRoundtableView.test.tsx
```

### E2E

```text
frontend/scripts/e2e-ending-room-followup-suite.mjs
frontend/scripts/e2e-worldline-roundtable-suite.mjs
```

建议最少覆盖这些 fixture：

1. `single-ending-basic`
2. `single-ending-many-speakers`
3. `multi-ending-a-b`
4. `multi-ending-witness`
5. `replay-readonly`

## 11.7 首轮编码优先级

如果你下一步就准备真正开写代码，建议只先做这 `8` 项：

1. `ending_room_thread` 数据模型
2. `POST /api/ending-room/{room_id}/user-turn`
3. room-scope memory membrane
4. `archivist_route`
5. `hotseat`
6. `EndingRoomFollowupComposer`
7. follow-up thread store + WS
8. E2E followup suite

先不要做：

- `all_present` 的复杂大人数降级
- `trait_mix` 的高级选人算法
- `expert_witness`
- 圆桌后的多轮追问

首轮只要把 `archivist_route + hotseat + thread 隔离 + replay 只读禁写` 做扎实，这条线就已经有明显区分度了。

## 11.8 逐文件实现清单

这一节只讨论“当前仓库中真实存在的文件”以及“建议新增的文件”。目标是下一步编码时，可以直接按文件推进，而不是从功能描述反推目录。

## 11.8.1 Backend 现有文件

### [ending_room.py](/Users/yangjunjie/Desktop/upgrade-test/backend/app/models/ending_room.py)

当前已有：

- `EndingRoom`
- `EndingRoomParticipant`
- `EndingRoomTurn`
- `EndingRoomType / Status / Phase / RoleSlot`

建议新增或调整：

1. `enum`
   - `EndingRoomDiscussionMode`
     - `auto_recap`
     - `archivist_route`
     - `hotseat`
     - `all_present`
     - `representative`
     - `manual_shortlist`
     - `trait_mix`
     - `expert_witness`
   - `EndingRoomTurnSource`
     - `auto_recap`
     - `user_followup`
   - `EndingRoomThreadMode`
     - `solo`
     - `panel`
     - `all_hands`
2. `EndingRoom`
   - 增加：
     - `discussion_mode`
     - `selection_mode`
     - `selected_agent_ids_hash`
     - `memory_partition_version`
3. `EndingRoomParticipant`
   - 增加：
     - `worldline_echo_key`
     - `selection_reason`
     - `impact_score`
     - `key_moment_hits`
     - `last_round_spoken`
4. 新增 `EndingRoomThread`
   - 字段见 `11.2.1`
5. `EndingRoomTurn`
   - 增加：
     - `thread_id`
     - `source`
     - `interaction_mode`
     - `memory_partition_id`
     - `addressed_agent_ids_json`
     - `question_anchor_ids_json`

实现注意：

- 不要新建第二套“followup_turn”表；首版更稳的是继续复用 `ending_room_turn`，用 `thread_id + source + interaction_mode` 分层。
- `worldline_echo_key` 建议由：
  - `scenario_id`
  - `anchor_branch_id`
  - `room_id`
  - `source_agent_id`
  组合后稳定生成。

### [database.py](/Users/yangjunjie/Desktop/upgrade-test/backend/app/models/database.py)

当前已有：

- `SQLModel.metadata.create_all(engine)`
- SQLite best-effort migration
- 已补 `ending_room.scope_fingerprint / current_phase`

建议新增：

1. 确认 `EndingRoomThread` 被 import 到 metadata 装载链路
2. 为新增字段补 lightweight migration：
   - `ending_room.discussion_mode`
   - `ending_room.selection_mode`
   - `ending_room.selected_agent_ids_hash`
   - `ending_room.memory_partition_version`
   - `ending_room_participant.worldline_echo_key`
   - `ending_room_turn.thread_id`
   - `ending_room_turn.source`
   - `ending_room_turn.interaction_mode`
   - `ending_room_turn.memory_partition_id`
3. 新表 migration：
   - `ending_room_thread`

实现注意：

- 这轮是 SQLite 项目，优先保持“best-effort migration + tests”一致，不要为了一个功能把 schema 管理大改。

### [ending_room_service.py](/Users/yangjunjie/Desktop/upgrade-test/backend/app/services/ending_room_service.py)

当前已有：

- `create_ending_room(...)`
- `build_branch_scope_context(...)`
- `build_roundtable_scope_context(...)`
- `run_ending_room_background(...)`
- `_participant_defs(...)`
- `_pick_branch_speaker(...)`

建议按四批修改：

1. `participant/ranking`
   - 新增：
     - `collect_branch_participant_candidates(...)`
     - `rank_branch_participant_candidates(...)`
     - `apply_selection_recipe(...)`
   - 让 `_participant_defs(...)` 不再直接拍脑袋选 top2，而是走显式 ranking + recipe。
2. `followup thread`
   - 新增：
     - `create_followup_thread(...)`
     - `append_user_turn(...)`
     - `resolve_followup_responders(...)`
     - `run_followup_thread_background(...)`
3. `memory membrane`
   - 新增：
     - `build_worldline_source_memory(...)`
     - `build_room_memory(...)`
     - `build_thread_memory(...)`
     - `build_room_followup_context(...)`
     - `build_thread_followup_context(...)`
4. `roundtable seating`
   - 新增：
     - `build_roundtable_seating(...)`
     - `run_roundtable_hidden_planning(...)`

建议重构点：

- `_serialize_turn(...)`
  - 要扩成能返回 `thread_id / source / interaction_mode / memory_partition_id`
- `_serialize_participant(...)`
  - 要扩成能返回 `worldline_echo_key / selection_reason / impact_score`
- `load_ending_room_snapshot(...)`
  - 要返回 `threads[]` 或至少 `active_thread_id`
- `load_ending_room_result_payload(...)`
  - 要在 replay-safe 前提下返回 follow-up thread 摘要，但不带越权上下文

### [ending_rooms.py](/Users/yangjunjie/Desktop/upgrade-test/backend/app/api/ending_rooms.py)

当前已有：

- `CreateEndingRoomRequest`
- `POST /api/scenario/{scenario_id}/ending-room`
- `GET /api/ending-room/{room_id}`
- `GET /api/ending-room/{room_id}/result`
- ending-room WS

建议新增请求模型：

```text
CreateEndingRoomThreadRequest
AppendEndingRoomUserTurnRequest
```

建议新增 endpoint：

```text
POST /api/ending-room/{room_id}/thread
POST /api/ending-room/{room_id}/user-turn
GET  /api/ending-room/thread/{thread_id}
```

每个 endpoint 的职责：

1. `POST /thread`
   - 建 thread
   - 校验 `interaction_mode`
   - 校验 `anchor_kind / anchor_id`
2. `POST /user-turn`
   - 落用户问题
   - 校验 `addressed_agent_ids`
   - 启动 follow-up background
3. `GET /thread/{thread_id}`
   - 只读 thread snapshot
   - 给前端刷新/重连补拉用

输入校验必须显式化：

- 当前 room 是 `done/live` 才能追问
- `read-only/replay` 一律拒绝 live 追问
- `addressed_agent_ids` 必须属于当前 room 可见 roster
- `hotseat` 必须只允许 `1` 个 addressed agent
- `all_present` 不允许用于 `worldline_roundtable`

### [test_ending_room_service.py](/Users/yangjunjie/Desktop/upgrade-test/backend/tests/test_ending_room_service.py)

当前已有：

- room dedupe
- branch/fulltext isolation
- basic roundtable scope

建议扩展案例：

1. `selection_recipe`
   - `manual` 与 `impact_top` 命中同一组人时能 dedupe
   - `manual` 与 `trait_mix` 选人不同步时不能 dedupe
2. `worldline_echo`
   - 同一 `source_agent_id` 在 A/B ending 下形成不同 echo key
3. `followup thread`
   - A 结局 thread 不读 B 结局 room 历史
   - 同一 room 的 thread1 不读 thread2 历史
4. `roundtable followup`
   - verdict 后追问只读当前桌摘要

### [test_ending_room_api.py](/Users/yangjunjie/Desktop/upgrade-test/backend/tests/test_ending_room_api.py)

建议新增：

- `POST /thread` happy path
- `POST /user-turn` happy path
- `ENDING_ROOM_READ_ONLY`
- `ENDING_ROOM_AGENT_NOT_VISIBLE`
- `ENDING_ROOM_CROSSLINE_ACCESS_DENIED`
- `ENDING_ROOM_THREAD_SCOPE_MISMATCH`

### [test_ending_room_ws.py](/Users/yangjunjie/Desktop/upgrade-test/backend/tests/test_ending_room_ws.py)

建议新增事件断言：

- `ending_room_thread_created`
- `ending_room_user_turn_commit`
- `ending_room_followup_turn_start`
- `ending_room_followup_turn_delta`
- `ending_room_followup_turn_commit`
- `ending_room_scope_notice`

### Backend 建议新增测试文件

当前真实口径：

- `follow-up / memory partition / thread API` 相关覆盖当前主要并入：
  - [test_ending_room_service.py](/Users/yangjunjie/Desktop/upgrade-test/backend/tests/test_ending_room_service.py)
  - [test_ending_room_api.py](/Users/yangjunjie/Desktop/upgrade-test/backend/tests/test_ending_room_api.py)
  - [test_ending_room_ws.py](/Users/yangjunjie/Desktop/upgrade-test/backend/tests/test_ending_room_ws.py)

后续如果想继续拆文件，再新增独立测试文件，不要在文档里假定它们已经存在。

## 11.8.2 Frontend 现有文件

### [types.ts](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/types.ts)

当前已有：

- `EndingRoomType`
- `EndingRoomSnapshot`
- `EndingRoomTurn`
- `CreateEndingRoomRequest`
- `EndingRoomWSEvent`

建议扩展：

1. type
   - `EndingRoomDiscussionMode`
   - `EndingRoomThreadMode`
   - `EndingRoomTurnSource`
   - `EndingRoomSelectionRecipe`
2. interface
   - `EndingRoomThread`
   - `CreateEndingRoomThreadRequest`
   - `AppendEndingRoomUserTurnRequest`
3. `EndingRoomScope`
   - 增加：
     - `discussion_mode`
     - `memory_partition_version`
4. `EndingRoomParticipant`
   - 增加：
     - `worldline_echo_key`
     - `selection_reason`
     - `impact_score`
     - `key_moment_hits`
     - `last_round_spoken`
5. `EndingRoomTurn`
   - 增加：
     - `thread_id`
     - `source`
     - `interaction_mode`
     - `memory_partition_id`
6. `EndingRoomSnapshot`
   - 增加：
     - `threads`
     - `active_thread_id`
7. `EndingRoomWSEvent`
   - 增加 follow-up 事件类型

### [client.ts](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/api/client.ts)

当前已有：

- `createEndingRoom`
- `getEndingRoom`
- `getEndingRoomResult`

建议新增：

```text
createEndingRoomThread(roomId, payload)
getEndingRoomThread(threadId)
appendEndingRoomUserTurn(roomId, payload)
```

并补请求/响应注释，避免后续同事只能读调用方猜合同。

### [endingRoomStore.ts](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/stores/endingRoomStore.ts)

当前现状：

- `snapshot`
- `result`
- `pendingDrafts`
- 只有单 transcript 视角

这是当前最需要扩的地方。

建议新增 state：

```text
threadsById
threadOrder
activeThreadId
pendingDraftsByThreadId
interactionMode
selectionRecipe
composerDraft
scopeNotice
```

建议新增 action：

```text
hydrateThread(...)
setActiveThread(...)
createThread(...)
appendUserTurn(...)
startThreadDraft(...)
appendThreadDraft(...)
commitThreadTurn(...)
setScopeNotice(...)
```

实现注意：

- 现有 `pendingDrafts` 只能按 `turn_id` 存，后续必须升级到至少能区分 `thread_id`
- `commitTurn(...)` 需要拆成：
  - `commitRoomTurn(...)`
  - `commitThreadTurn(...)`
- `reset()` 不能误清当前 replay snapshot

### [useEndingRoomWS.ts](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/hooks/useEndingRoomWS.ts)

当前已有：

- room 级 resync
- sequence/event_id 去重
- turn start/delta/commit

建议新增事件处理：

```text
ending_room_thread_created
ending_room_user_turn_commit
ending_room_followup_turn_start
ending_room_followup_turn_delta
ending_room_followup_turn_commit
ending_room_scope_notice
```

建议新增逻辑：

1. 收到 `thread_created`
   - 自动 hydrate thread
2. 收到 `followup_turn_*`
   - 只更新当前 thread transcript
3. 收到 `scope_notice`
   - 在 composer 上方显示当前约束
4. resync
   - 若 thread 事件 sequence gap，优先补拉 thread snapshot

### [EndingChatModal.tsx](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/components/EndingChatModal.tsx)

当前已有：

- sidebar
- transcript
- mode tabs
- basic room opening

建议拆成子组件，但首轮可以先在本文件内完成结构改造：

1. 新增区域
   - `participant recipe bar`
   - `thread rail`
   - `followup composer`
2. 新增行为
  - 自动复盘完成后展示 `继续追问`
  - 支持 `archivist_route / hotseat / all_present`
  - 支持从 `key_moment / quote / verdict` 发起 thread
  - 支持统一锚点动作：
    - `预填追问`
    - `按当前锚点另开线程`
3. 新增文案提示
  - `只基于当前世界线`
  - `只基于当前桌面`
   - `只基于当前追问线程`

建议状态边界：

- `readOnly`
  - 禁用 send
  - 禁用 create thread
  - 只允许切换查看
- `loading`
  - 允许看 sidebar
  - 不允许开 follow-up composer

### [EndingChatModal.css](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/components/EndingChatModal.css)

建议补三块样式：

1. `thread rail`
   - 左侧或顶部可切换 thread 列表
2. `composer`
   - 模式切换、anchor chip、输入框、send 按钮
3. `scope notice`
   - 小而明确，不抢主视觉

### [ResultView.tsx](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/pages/ResultView.tsx)

当前已有：

- 结局卡 CTA
- modal 打开态
- `activeEndingRoomBranchId`
- `activeEndingRoomMode`

建议新增 state：

```text
participantPickerOpen
participantPickerBranchId
participantSelectionRecipe
participantManualSelection
endingRoomThreadAnchor
```

建议新增交互：

1. CTA 先开 picker
2. picker 确认后再开 room
3. 从：
   - 结局卡
   - 关键转折卡
   - quote / verdict
   发起 thread 预填

### [ResultView.test.tsx](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/pages/ResultView.test.tsx)

建议新增断言：

- CTA 不直接开 room，而是先开 picker
- picker 选人后 room payload 正确
- 从 key moment 发起追问时，composer 被正确预填
- replay 态下 follow-up 按钮禁用

### [EndingChatModal.test.tsx](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/components/EndingChatModal.test.tsx)

建议新增断言：

- `archivist_route / hotseat / all_present` 三种模式切换
- hotseat 只允许一个目标
- thread 切换不串 transcript
- scope notice 正确显示
- read-only 下 composer disabled

### [useEndingRoomWS.test.tsx](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/hooks/useEndingRoomWS.test.tsx)

建议新增断言：

- follow-up 事件按 `thread_id` 入桶
- sequence gap 时触发 thread resync
- duplicate event_id 不重复渲染
- room turn 与 thread turn 不互相污染

### [endingRoomStore.test.ts](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/stores/endingRoomStore.test.ts)

建议新增断言：

- `hydrateThread`
- `setActiveThread`
- `commitThreadTurn`
- `pendingDraftsByThreadId`
- `reset` 不误清 read-only snapshot

## 11.8.3 Frontend 建议新增文件

建议新增：

- [EndingRoomParticipantPicker.tsx](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/components/EndingRoomParticipantPicker.tsx)
- [EndingRoomParticipantPicker.css](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/components/EndingRoomParticipantPicker.css)
- [EndingRoomFollowupComposer.tsx](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/components/EndingRoomFollowupComposer.tsx)
- [EndingRoomFollowupComposer.css](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/components/EndingRoomFollowupComposer.css)
- [EndingRoomThreadList.tsx](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/components/EndingRoomThreadList.tsx)
- [EndingRoomThreadList.css](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/components/EndingRoomThreadList.css)
- [WorldlineRoundtableView.tsx](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/pages/WorldlineRoundtableView.tsx)
- [WorldlineRoundtable.css](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/pages/WorldlineRoundtable.css)
- [worldlineRoundtableStore.ts](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/stores/worldlineRoundtableStore.ts)
- [useWorldlineRoundtableWS.ts](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/hooks/useWorldlineRoundtableWS.ts)

其中首轮真正必须建的只有：

- `EndingRoomParticipantPicker.tsx`
- `EndingRoomFollowupComposer.tsx`
- `EndingRoomThreadList.tsx`

圆桌页面可以等 `Phase D` 再开。

## 11.8.4 脚本与 E2E

### 建议新增脚本

- [e2e-ending-room-followup-suite.mjs](/Users/yangjunjie/Desktop/upgrade-test/frontend/scripts/e2e-ending-room-followup-suite.mjs)
- [e2e-worldline-roundtable-suite.mjs](/Users/yangjunjie/Desktop/upgrade-test/frontend/scripts/e2e-worldline-roundtable-suite.mjs)

### followup suite 最少流程

1. 打开结果页
2. 进入结局卡 picker
3. 选人确认
4. 等自动复盘 done
5. 发起 `hotseat`
6. 发起 `archivist_route`
7. 检查 thread rail
8. 检查 read-only replay 禁写

## 11.8.5 首轮逐文件优先级

如果要按文件顺序落地，建议严格按下面顺序：

1. `backend/app/models/ending_room.py`
2. `backend/app/models/database.py`
3. `backend/app/services/ending_room_service.py`
4. `backend/app/api/ending_rooms.py`
5. `backend/tests/test_ending_room_service.py`
6. `backend/tests/test_ending_room_api.py`
7. `backend/tests/test_ending_room_ws.py`
8. `frontend/src/types.ts`
9. `frontend/src/api/client.ts`
10. `frontend/src/stores/endingRoomStore.ts`
11. `frontend/src/hooks/useEndingRoomWS.ts`
12. `frontend/src/components/EndingRoomParticipantPicker.tsx`
13. `frontend/src/components/EndingRoomFollowupComposer.tsx`
14. `frontend/src/components/EndingRoomThreadList.tsx`
15. `frontend/src/components/EndingChatModal.tsx`
16. `frontend/src/pages/ResultView.tsx`
17. `frontend/src/components/EndingChatModal.test.tsx`
18. `frontend/src/pages/ResultView.test.tsx`
19. `frontend/src/hooks/useEndingRoomWS.test.tsx`
20. `frontend/src/stores/endingRoomStore.test.ts`
21. `frontend/scripts/e2e-ending-room-followup-suite.mjs`

这样推进的原因很简单：

- 先锁数据合同
- 再锁 API
- 再锁前端状态
- 最后才做 UI 和 E2E

不要倒过来先画 UI，再回来补 `thread_id / memory_partition_id / worldline_echo_key`，那样一定返工。
