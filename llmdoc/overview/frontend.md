# Frontend 模块地图

> 文档类型：L0 current-truth
> 作用：描述前端页面、状态边界、性能收口与自动化入口。历史修复细节不再写入本页。

## 技术栈

- React 19
- TypeScript 5.9
- Vite 7
- Zustand
- i18next
- Phaser
- Playwright-based E2E

当前默认构建/测试路径会把 `phaser` alias 到本地精简入口 `frontend/experiments/phaser-custom/entry.mjs`，用于降低默认包体。

## 页面地图

| 页面 | 位置 | 责任 |
|------|------|------|
| InputView | `frontend/src/pages/InputView.tsx` | scenario 创建、BYOK、quick starts、challenge、主模式档位、搜索增强 toggle |
| SimulationView | `frontend/src/pages/SimulationView.tsx` | live 推演、Theater、干预、玩法卡、押注、capture |
| ResultView | `frontend/src/pages/ResultView.tsx` | 结局对比、archive、campaign summary、分享、导出、replay/import、真实世界来源卡片、counterfactual / resume / faction 入口 |
| DebateArenaView | `frontend/src/pages/DebateArenaView.tsx` | debate live |
| DebateResultView | `frontend/src/pages/DebateResultView.tsx` | debate result、share、replay/import |
| WorldlineRoundtableView | `frontend/src/pages/WorldlineRoundtableView.tsx` | 世界线圆桌 live/replay |
| HistoryView | `frontend/src/pages/HistoryView.tsx` | scenario 历史列表 |
| LeaderboardView | `frontend/src/pages/LeaderboardView.tsx` | prediction leaderboard |

## 状态与 authority 边界

### 当前 authority

- 主模式 authority 来自后端：
  - `director_state`
  - `gameplay_state`
- `gameplay_state` 当前按分区看 authority：
  - 只要后端显式返回该分区字段，即使值是空数组，也视为后端已接管该分区
  - 前端不会再把本地 `scenarioMeta` 里的 stale `bets / key_moments / branch_snapshots / usage_log` 反向补回去
- 前端 authority 合流主要通过：
  - `frontend/src/lib/scenarioAuthority.ts`
  - `frontend/src/lib/scenarioDirectorState.ts`
  - `frontend/src/lib/scenarioGameplayState.ts`
- `gameplay_state` 当前按“分区显式拥有”判断 authority：
  - 后端只要显式返回 `cards.usage_log`、`betting.bets`、`archive.key_moments`、`archive.branch_snapshots`，即使数组为空，前端也视为该分区已由后端接管。
  - 这种情况下前端不会再用本地 `scenarioMeta` 把旧的玩法卡、押注或 archive raw 数据补回去。

### 兼容与缓存层

- `scenarioMeta` 仍存在，但不是跨设备真值。
- 它现在主要承担：
  - 本地缓存
  - 兼容旧数据
  - replay 输入与 hydrate

### Replay

- 主模式 replay helper：
  - `scenarioReplay.ts`
  - `simulationReplay.ts`
- Debate replay helper：
  - `debateReplay.ts`
- Oracle replay helper：
  - `oracleReplay.ts`
- 编解码共享：
  - `replayCodec.ts`

## 实时链路

- scenario live：`useSimulationWS`
- debate live：`useDebateWS`
- ending room / roundtable：各自独立 WS hook + store

当前约束：

- 前端会按 `sequence / event_id` 做重复丢弃与时序修正。
- store 负责保持 phase/branch 状态单调，不让旧事件覆盖新状态。
- `simulationStore` 的消息去重集（`seenMessageKeys`）按 scenario ID 隔离，切换场景时自动重置，避免跨场景 hash 碰撞。
- `useSimulationWS` 在 `scenarioId` 为空或 `ready` 为 false 时不会发起连接；重连使用 `connectRef` 模式防止闭包过期；初始连接也会调用 `requestScenarioResync` 补拉状态（与 `useEndingRoomWS` 行为对齐）。
- 三个 WS hooks 均支持首帧 auth：如果 `localStorage` 有 token，`onopen` 时发送 `{"type":"auth","token":"..."}`，收到 `auth_ok` 后才触发 resync；无 token 时直接 resync（兼容 auth 未开启场景）。
- 三个 WS hooks 对 `4001`（认证失败）和 `4404`（资源不存在）不进行自动重连；`1006`（异常断连）照常重连。
- REST API 路径参数统一使用 `encodeURIComponent()` 编码（约 30 处），防止含特殊字符的 ID 破坏 URL 结构。
- API 客户端对服务端错误文本做脱敏处理（`sanitizeErrorText`），超过 200 字符或包含 stack trace / HTML 的响应会被替换为通用错误信息。

## Theater 与性能边界

- Pixel Theater 运行时在 `frontend/src/game/`。
- `PhaserGameLoader` 负责按需加载 Theater。
- screenshot / GIF capture runtime 已拆分，不进入默认首包。
- 主题、素材与 UI asset 路径的单一事实源位于 `themeRegistry.ts`。
- Theater 当前布局采用 canvas-first 浮动 HUD 方案：
  - Phaser canvas 以 `position: absolute; inset: 0` 填满整个舞台区域
  - 控制面板（header / status / director / filters / timeline）浮动在 canvas 上方，使用 `backdrop-filter: blur(12px)` 半透明叠加
  - 移动端（≤900px）降级为实色半透明背景（`rgba(18, 16, 38, 0.95)`），避免多层 blur 导致帧率下降
  - Theater 背景色从固定 `#06061a` 改为 `--oracle-bg-dark`，支持主题皮肤过渡
- Theater 气泡当前行为：
  - 最大同时可见气泡数 = `min(agentCount, 8)`，根据场景内 agent 数量动态计算
  - compact 模式（canvas 宽 < 360px，即真手机端）下最多 2 个，气泡固定在画面底部中央（底部安全间距从 104px 增加到 160px，避免被浮动 HUD 遮挡）
  - 非 compact 模式下气泡跟随各自 agent 头顶显示
  - 气泡文字统一为 16px / 700，不再按 compact / replay 区分字号
  - 气泡换行宽度从 180-240px 增加到 220-300px
  - 文字渲染分辨率 = 4x
  - compact 模式下文字增加了描边（`strokeThickness: 1.5`）和阴影（`blur: 2`）以提升暗色背景上的可读性
- Theater Agent sprite 当前采用动态缩放：
  - 尺寸 = `max(40, Math.min(width, height) * 0.055)` 宽，保持 2:3 宽高比
  - 阴影、名牌、faction bar 位置跟随 sprite 尺寸自动计算（`spriteH` 存储在 `AgentSpriteData` 中，各处统一使用 `spriteH * 0.5 + 2` 作 Y 偏移）
  - 阵营聚拢动画：`viz:faction_cluster` 事件驱动，对象池 flash、命名常量、tween 预算限制、reduced-motion snap
  - 原始 640×640 PNG 素材的宽高比不会因为 canvas 比例变化而拉伸

## 关键模块

| 模块 | 位置 | 责任 |
|------|------|------|
| `themeRegistry.ts` | `frontend/src/lib/themeRegistry.ts` | Theater / Debate / Oracle 资产注册表；当前包含 18 个 gameplay profiles 与 44 个主题场景 |
| `emotionColors.ts` | `frontend/src/game/constants/emotionColors.ts` | 情绪-光环颜色映射共享常量（PhaserGame 和 VizSynthesizer 共用） |
| `scenarioAuthority.ts` | `frontend/src/lib/scenarioAuthority.ts` | 主模式 authority 合流入口 |
| `scenarioGameplayState.ts` | `frontend/src/lib/scenarioGameplayState.ts` | gameplay_state 映射与判等 |
| `scenarioDirectorState.ts` | `frontend/src/lib/scenarioDirectorState.ts` | director_state 映射 |
| `predictionBetting.ts` | `frontend/src/lib/predictionBetting.ts` | 结构化押注 helper |
| `gameplayContract.ts` | `frontend/src/lib/gameplayContract.ts` | 共享玩法契约消费层 |
| `roundtableSelection.ts` | `frontend/src/lib/roundtableSelection.ts` | `trait_mix / fault_line_first / witness_augmented` 选择辅助与测试入口 |
| `endingRoomStore.ts` / `worldlineRoundtableStore.ts` | `frontend/src/stores/` | ending-room / roundtable 状态；`worldlineRoundtableStore` 是 `endingRoomStore` 的 re-export |
| `textLayout/*` | `frontend/src/lib/textLayout/` | `pretext` helper、Oracle transcript layout kernel、overflow contract、Input 面高度预测 (`inputPredict`)、Canvas bubble 预测 (`canvasTextPredict`)、P5 文本契约测试 (`textContract.test`) |
| `useTranscriptScroll.ts` | `frontend/src/hooks/useTranscriptScroll.ts` | `EndingChatModal` 与 `WorldlineRoundtableView` 共享的 transcript scroll 锚定 hook |
| `roundtableHelpers.ts` | `frontend/src/pages/roundtableHelpers.ts` | 圆桌纯函数：选型模式、锚点构建、fault-line 算法、anchor 描述 |
| `endingChatHelpers.ts` | `frontend/src/components/endingChatHelpers.ts` | 会客厅纯函数：角色标签、模式标签、prompt 构建、anchor 描述 |
| `resultHelpers.ts` | `frontend/src/pages/resultHelpers.ts` | 结果页纯函数：押注 badge、campaign cache、badge copy |
| `simulationHelpers.ts` | `frontend/src/pages/simulationHelpers.ts` | 推演页纯函数：Theater 场景/天气/时间标签、预热检测 |
| `RoundtablePickerPanel.tsx` | `frontend/src/pages/RoundtablePickerPanel.tsx` | 圆桌代表选型面板组件（6 种模式 + 证人选择） |
| `RoundtableTranscriptList.tsx` | `frontend/src/pages/RoundtableTranscriptList.tsx` | 圆桌 transcript 列表组件（turns + drafts + 折叠/锚点操作 + phase 分隔线 + speaker 左侧色标） |

## 当前边界

- 前端交付目标仍是浏览器端，不维护原生壳约束。
- `follow-up` 体验已经可用，但与经典模式的完整流式一致性仍在继续收口。
- `SimulationView` 的 automation payload 当前已补：
  - `thinkingAgentCount`
  - `thinkingAgents`
  - classic live-fork fixture 已能直接观测“谁正在说话前的 thinking 态”
- `endingRoomStore` 当前会在 committed turn、room hydrate、thread hydrate 时清掉 stale draft；迟到的 `turn_start / turn_delta` 不再把 ghost bubble 重新挂回当前 transcript。
- `endingRoomStore.loadRoom` 当前在 result 加载失败时不再把整个 room 标记为 error；room 仍可正常使用，result 会在下次 WS 事件或手动刷新时重试。
- `endingRoomStore` 当前在 `hydrateThread()` 时也会同步更新 `snapshot.threads`；新建 anchored thread 后，Oracle replay 不会再只序列化旧主桌快照。
- Oracle replay copy 现在优先走 artifact；如果 artifact 不可用且 URL token 也过大，会回退为本地只读副本链接，而不是直接失效。
- `WorldlineRoundtableView` 的 readonly replay 现在会按 `active_thread_id` 恢复对应 thread 的 `interaction_mode` 与 hotseat target，不再把 hotseat replay 误显示成 `archivist_route`。
- roundtable 的 anchored thread readonly replay / local restore 当前已补过 Firefox / WebKit scoped regression，口径与 Chromium 对齐。
- Oracle 页面 UI 语言当前跟随用户语言开关；room payload 会显式带 `zh | en`，但页面不再反向用 `scenario.language` 覆盖当前 UI 语言。
- `WorldlineRoundtableView` 当前开桌 payload 会跟随最新的 `selectionMode` 与当前 UI 语言，不再复用旧闭包值。
- `useEndingRoomWS` 当前重连会复用最新的 connect 回调，不再依赖旧的自引用调度。
- `ShareModal / GameplayCardsModal / InputView / DebateArenaView / DebateResultView / SimulationView / ResultView / EndingChatModal / WorldlineRoundtableView` 当前已清完 `react-hooks/exhaustive-deps` warning；本轮只补 hook 依赖与派生值稳定化，没有改业务口径。
- 单结局结果页当前不展示 `worldline_roundtable / crossline_gallery` 入口，只保留 `ending_chamber / one_move_only`。
- Oracle fresh live room 的 English deterministic anchor copy 当前已补去混句兜底；single-ending / roundtable 在 fresh room 下不会再把中文 hinge 直接嵌进英文句子。
- `EndingChatModal` 当前已补：
  - `继续追问 / 另开线程 / 复制纪要 / 追问洞察`
  - transcript `quote` 级 `沿这句追问 / 另开线程`
  - `后续三回合` 按钮：设置 `interaction_mode=epilogue` 并预填追问内容
  - 证据卡抽屉：在非 crossline gallery 模式下，可展开其他世界线摘要卡，点击 `提交证据卡` 以 `interaction_mode=evidence_card` 发送
- `WorldlineRoundtableView` 当前已补：
  - `Continue this table / Start anchored thread / Copy roundtable brief`
  - `phase insight` 级追问 / 开线程
  - transcript `quote` 级 `Follow this quote / Start anchored thread`
  - transcript `quote` 级 `Hotseat this rep / 点名这位代表`
  - committed transcript 长段折叠 / 展开
  - `后续三回合` 按钮
- Oracle 当前统一锚点规则：
  - `verdict / key_moment / quote / phase`
  - 都先落到显式 `questionAnchorIds`
  - `appendUserTurn()` 与 `createThread()` 两条链都带锚点语义，不再只靠 prompt 预填
- `EndingChatModal / WorldlineRoundtableView` 当前会在线程 rail / transcript header 回显当前 thread 的 anchor badge，只显示用户可读 label，不直接暴露内部 ids。
- Oracle 自动化状态当前会额外输出：
  - `question_anchor_ids`
  - `thread_question_anchor_ids_json`
  - `pending_question_anchor_ids`
  - `current_speaker_turn_key`
  - `current_speaker_participant_id`
  - `pending_drafts`
  - `stream_state`
  - `anchor_kind / anchor_label`
  - `transcript_layout`
    - 当前也包含 `collapsible_turn_count / collapsed_turn_count`
- `roundtableSelection.ts` 当前承接 `trait_mix` 选择逻辑；`trait_mix / fault_line_first / witness_augmented` 的状态切换已补 no-op guard，避免对同一份 selection 反复写回。
- `WorldlineRoundtableView` 当前已支持：
  - `manual_shortlist`
  - `expert_witness`
  - `trait_mix`
  - `fault_line_first`
  - `witness_augmented`
- roundtable mobile 当前以 `live room` 为优先目标：
  - `live room` 已收口到首屏无页面级纵向滚动
  - `picker / reseat` 仍允许滚动，不与 live-room 口径混用
- 当前 Oracle mobile 专项脚本已覆盖：
  - ending-room：`mobile single-ending verdict-anchor thread / artifact readonly / local readonly / reload restore / import`，以及 `multi-ending hotseat / all_present / epilogue / crossline gallery / evidence_card / artifact readonly / local readonly / reload restore / import`
  - roundtable：`trait_mix / fault_line_first / witness_augmented / hotseat thread switch / quote-anchor thread / artifact readonly / local readonly / reload restore / import`
- `ResultView` 当前支持自动化专用的 query 参数直开 live ending-room：
  - `debugEndingRoomBranch`
  - `debugEndingRoomMode`
  - `debugEndingRoomAgents`
  - 仅用于脚本/调试稳定打开 live chamber，正常用户流仍走结果页按钮 + picker。
- `ResultView` 当前在 `counterfactual_replay` capability 开启且结果里存在 branches 时，会显示：
  - `CounterfactualPanel`
  - `ResumePanel`
  - `FactionTimeline`
- `ResumePanel` 当前会：
  - 只在用户已选分支且 round 为有效整数时允许提交
  - 成功后锁表单并在 500ms 后跳回 `/sim/:id`
  - 对 `429` 统一显示 replay branch 上限提示
- `ResumePanel` 当前有独立 smoke 入口：
  - `frontend/scripts/e2e-phase3-batch-c.mjs`
  - `cd frontend && npm run e2e:resume -- full`
- `e2e-worldline-roundtable-suite` 当前会在 verdict anchored thread 前等待 draft settle；`e2e-ending-room-followup-suite` 当前已把 ending-room follow-up 主链改成 API-driven 口径，不再靠 mobile `all_present` 的 mode-arm / settled wait 硬等。
- `e2e-ending-room-followup-suite.mjs full` 当前已重新可稳定落 `summary.json`。
- `e2e-ending-room-followup-suite.mjs` 当前也会在 multi-ending 桌面/移动端链路下额外覆盖：
  - 先 API 预热 `ending_chamber`，再通过 ResultView 调试参数直开 live chamber
  - `hotseat / all_present / epilogue / evidence_card` 统一改成 API 发起，UI 只负责模式切换、stream 观测、截图和 readonly 验证
  - 两种模式均有截图 + JSON artifact 留档
- `e2e-ending-room-followup-suite.mjs` 当前也会在命中的 follow-up 场景下额外落：
  - `turn-start`
  - `turn-delta`
  - `turn-commit`
  这些中间态工件，方便直接看 single-ending / multi-ending 的真流式观测。
- `single-ending` 的 mobile verdict-anchor thread 当前也走 deterministic 兜底：
  - thread title 每次唯一，避免复用同一 room 时点到旧 thread
  - 如果 UI automation 状态刷新偏慢，脚本会回退到 backend room snapshot 合成可验证状态
- `e2e-worldline-roundtable-suite.mjs` 当前已补：
  - 更稳的 quote-anchor thread 交互链
  - hotseat settle / anchored send 的慢路径等待
  - desktop / mobile 分 browser 执行
  - 优先复用最近成功的稳定 fixture
- roundtable anchored follow-up 的 desktop / mobile rerun 当前都已重新跑通：
  - desktop 已能稳定落 `turn_start / turn_delta / turn_commit`
  - mobile 当前也已重新抓回 `turn_delta`
- roundtable 的 `full` 当前仍可能受 provider 慢路径波动影响；如果目标只是 Oracle transcript `P2` 布局签收，当前更稳的口径是：
  - desktop 一份 summary
  - mobile 一份 summary
- roundtable desktop live room 当前已补一轮轻量可读性收口：
  - 左栏更窄
  - summary card sticky
  - 长摘要走内部滚动
  - transcript 段落行距更松
  - committed transcript 长段默认可折叠
- roundtable replay 的自动化口径当前已修正：
  - readonly replay 下 `interaction_mode` 会跟随 active replay thread
  - mobile artifact replay readonly 不再因为错误暴露 `archivist_route` 而超时
- 当前 single-ending Oracle 已额外做过真实浏览器复核：
  - 结果页无 `Start Roundtable / Crossline Gallery`
  - `ending_chamber / one_move_only` 可正常打开
  - single-ending chamber readonly replay 仍可 `import`
  - mobile `390x844` 下 chamber modal 仍能完整落在视口内
- `pretext` 当前已接到 Oracle transcript 运行时布局内核：
  - `EndingChatModal / WorldlineRoundtableView` 的 bubble `min-height` 预测
  - transcript scroll bottom anchor 稳定化
  - automation payload / E2E summary 当前会带 `transcript_layout`
- `pretext` 当前已扩展到：
  - `InputView`：textarea 高度预测替代 scrollHeight 回流，中英语言切换自动重估（`inputPredict.ts`）
  - P5 文本契约测试矩阵：71 项，覆盖按钮标签 / 卡片标题 / 描述文本 / Oracle 布局 / Share 文案 的中英双语溢出检测（`textContract.test.ts`）
  - Canvas bubble 尺寸预测模块已独立封装（`canvasTextPredict.ts`），当前已正式接入 WorldScene 的 `showBubble()` 方法——预测可用时跳过 Phaser `getBounds()` DOM 调用，不可用时自动回退原路径
- `ResultView` 当前已做 Summary-First 优化：
  - 结局卡默认只显示标题 + 概率条 + insight 引言 + 操作按钮
  - 故事、分歧原因、关键时刻需点击"阅读完整故事"展开（`grid-template-rows: 0fr` 折叠动画，Safari < 16 有 `@supports` 降级）
  - 桌面端 2 列网格布局，主结局（概率最高）跨两列
  - 概率条按区间着色：>60% rose、30-60% amber、<30% gray
  - 关键时刻改为 mini-timeline 视觉化
  - 故事文本限宽 62ch、行高 1.8，提升长文可读性
- `EndingChatModal` 当前已补对话可读性优化：
  - speaker 左侧色标：按参与者 index 自动分配 oklch 颜色
  - 档案官 verdict 消息用高亮卡样式突出
  - transcript 气泡文本限宽 58ch、行高 1.75
  - transcript 列表间距从 12px 增加到 16px
  - transcript bubble 内的操作按钮（"沿这句追问 / 另开线程"）当前有上边框分隔线，颜色加深为 `oklch(45% 0.2 350)` + 700 加粗，确保在浅色气泡背景上可读
  - `onAutomationStateChange` 回调改用 `useRef` 稳定引用，修复了 "Maximum update depth exceeded" 循环渲染问题
  - automation effect 当前会对输出 payload 做 JSON 去重，相同状态不重复上报（只在 modal 关闭或 unmount 时清空快照）
- `WorldlineRoundtableView` 圆桌 transcript 当前已补：
  - 按 phase 分组的视觉分隔线（`<h3>` 语义标签 + 渐变横线 + phase label）
  - 每条发言左侧色标（5-hue oklch 调色板，与 EndingChatModal 一致）
  - 档案官发言使用 `--oracle-accent` 跟随主题皮肤变化
  - 移动端分隔线 label 有 `text-overflow: ellipsis` 防溢出
- 贴图修复：`/assets/ui/generated/` 下的 1408x768 AI 全景图引用大部分已替换为 CSS gradient / box-shadow，涉及 EndingChatModal.css、WorldlineRoundtable.css、ResultView.css 共 15 处；ResultView 因果档案区域已改回使用 `scenario.scene_theme` 对应的场景图（带半透明渐变遮罩）
  - speaker glow → `radial-gradient`
  - archivist emblem → `conic-gradient`
  - oracle chamber panel → `repeating-linear-gradient` 细条纹
  - dossier divider → `linear-gradient` 渐变线
  - influence badge → `radial-gradient` 圆点
  - `daily_challenge_panel.png` 保留原图（`object-fit: cover` 裁切效果尚可）
- 交互动效当前已补：
  - PredictionModal：modal 入场、confidence badge 颜色反馈、成功脉冲、提交 shimmer
  - GameplayCardsModal：卡牌选择弹跳 + icon pop、未激活灰化
  - InterventionModal：模式选择弹跳、模板标签微交互
  - EndingChatModal：bubble 入场动画、anchor 高亮、线程切换过渡、idle 粒子
  - WorldlineRoundtable：idle 环境粒子
  - 所有新增动画均有 `prefers-reduced-motion: reduce` 覆盖
- `ResultView` 的 `endingRoomAutomation` 当前使用 `useRef` 而不是 `useState`。原因：EndingChatModal 的 automation effect 每次 deps 变化都会生成新对象并调用 `onAutomationStateChange`。如果用 `useState`，每次调用都会触发 ResultView 重渲染，形成 "store→effect→setState→re-render" 循环（190+ "Maximum update depth exceeded" error）。改为 `useRef` 后回调写入 ref 不触发渲染，`render_game_to_text()` 在调用时通过 `ref.current` 读取最新值。
- `themeRegistry.ts` 当前 `GameplayProfileId` 包含 18 种：`governance / war / empire / industry / trade / law / faith / ecology / frontier / mythic / survival / finance / scholar / medical / technology / entertainment / diplomacy / generic`。
  - 新增的 6 种 profile（`finance / scholar / medical / technology / entertainment / diplomacy`）现在均有各自专属 card frame PNG（通过 Gemini Image API 生成），不再复用其他 profile 的素材。
  - 新增 11 个主题场景入口（`finance_exchange / cyber_market / medical_institute / academy_hall / tech_campus / arena_colosseum / concert_hall / media_tower / diplomatic_summit / underground_network`）。
  - 当前全部 33 个主题场景（含变体）均已有专属 PNG 素材（512x288 像素风），无占位图。
  - `inferSceneThemeFromQuestion()` 通过关键词匹配自动路由到新主题。

## 设计 Token 体系

- 全局 token 定义在 `frontend/src/index.css` 的 `:root` 中（OKLCH 色彩空间）。
- 当前包含：背景色、主色、语义色、文本色、边框、阴影、圆角、字体栈、流体文本尺度、过渡曲线、间距缩放、z-index 层级、状态 badge 色、Oracle 暗色覆层 token。
- GBC 像素风 token 在 `frontend/src/game/game.css` 中独立定义。
- Oracle 皮肤（按 gameplay profile 动态切换）在 `WorldlineRoundtable.css` 和 `EndingChatModal.css` 中通过 `.oracle-skin--{id}` 类选择器覆盖。
- 结果页押注 badge 颜色已迁移到 CSS 变量（`--color-success-bg` / `--color-danger-bg` 等），不再硬编码 hex。

## 查找路径

- 查页面入口：`frontend/src/pages/*`
- 查页面 helper：`frontend/src/pages/*Helpers.ts`
- 查组件 helper：`frontend/src/components/*Helpers.ts`
- 查 store：`frontend/src/stores/*`
- 查 lib/helper：`frontend/src/lib/*`
- 查 hooks：`frontend/src/hooks/*`
- 查 Theater：`frontend/src/game/*`
- 查设计 token：`frontend/src/index.css`
- 查开发/签收命令：`llmdoc/guides/development.md`
