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
| InputView | `frontend/src/pages/InputView.tsx` | scenario 创建、BYOK、quick starts、challenge、主模式档位 |
| SimulationView | `frontend/src/pages/SimulationView.tsx` | live 推演、Theater、干预、玩法卡、押注、capture |
| ResultView | `frontend/src/pages/ResultView.tsx` | 结局对比、archive、campaign summary、分享、导出、replay/import |
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
- 前端 authority 合流主要通过：
  - `frontend/src/lib/scenarioAuthority.ts`
  - `frontend/src/lib/scenarioDirectorState.ts`
  - `frontend/src/lib/scenarioGameplayState.ts`

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

## Theater 与性能边界

- Pixel Theater 运行时在 `frontend/src/game/`。
- `PhaserGameLoader` 负责按需加载 Theater。
- screenshot / GIF capture runtime 已拆分，不进入默认首包。
- 主题、素材与 UI asset 路径的单一事实源位于 `themeRegistry.ts`。

## 关键模块

| 模块 | 位置 | 责任 |
|------|------|------|
| `themeRegistry.ts` | `frontend/src/lib/themeRegistry.ts` | Theater / Debate / Oracle 资产注册表 |
| `scenarioAuthority.ts` | `frontend/src/lib/scenarioAuthority.ts` | 主模式 authority 合流入口 |
| `scenarioGameplayState.ts` | `frontend/src/lib/scenarioGameplayState.ts` | gameplay_state 映射与判等 |
| `scenarioDirectorState.ts` | `frontend/src/lib/scenarioDirectorState.ts` | director_state 映射 |
| `predictionBetting.ts` | `frontend/src/lib/predictionBetting.ts` | 结构化押注 helper |
| `gameplayContract.ts` | `frontend/src/lib/gameplayContract.ts` | 共享玩法契约消费层 |
| `roundtableSelection.ts` | `frontend/src/lib/roundtableSelection.ts` | `trait_mix / fault_line_first / witness_augmented` 选择辅助与测试入口 |
| `endingRoomStore.ts` / `worldlineRoundtableStore.ts` | `frontend/src/stores/` | ending-room / roundtable 状态 |
| `textLayout/*` | `frontend/src/lib/textLayout/` | `pretext` 只读文本预测 / overflow contract |

## 当前边界

- 前端交付目标仍是浏览器端，不维护原生壳约束。
- `follow-up` 体验已经可用，但与经典模式的完整流式一致性仍在继续收口。
- Oracle replay copy 现在优先走 artifact；如果 artifact 不可用且 URL token 也过大，会回退为本地只读副本链接，而不是直接失效。
- `WorldlineRoundtableView` 的 readonly replay 现在会按 `active_thread_id` 恢复对应 thread 的 `interaction_mode` 与 hotseat target，不再把 hotseat replay 误显示成 `archivist_route`。
- Oracle 页面 UI 语言当前跟随用户语言开关；room payload 会显式带 `zh | en`，但页面不再反向用 `scenario.language` 覆盖当前 UI 语言。
- `WorldlineRoundtableView` 当前开桌 payload 会跟随最新的 `selectionMode` 与当前 UI 语言，不再复用旧闭包值。
- `useEndingRoomWS` 当前重连会复用最新的 connect 回调，不再依赖旧的自引用调度。
- 单结局结果页当前不展示 `worldline_roundtable / crossline_gallery` 入口，只保留 `ending_chamber / one_move_only`。
- Oracle fresh live room 的 English deterministic anchor copy 当前已补去混句兜底；single-ending / roundtable 在 fresh room 下不会再把中文 hinge 直接嵌进英文句子。
- `EndingChatModal` 当前已补：
  - `继续追问 / 另开线程 / 复制纪要 / 追问洞察`
  - transcript `quote` 级 `沿这句追问 / 另开线程`
- `WorldlineRoundtableView` 当前已补：
  - `Continue this table / Start anchored thread / Copy roundtable brief`
  - `phase insight` 级追问 / 开线程
  - transcript `quote` 级 `Follow this quote / Start anchored thread`
- Oracle 当前统一锚点规则：
  - `verdict / key_moment / quote / phase`
  - 都先落到显式 `questionAnchorIds`
  - `appendUserTurn()` 与 `createThread()` 两条链都带锚点语义，不再只靠 prompt 预填
- `EndingChatModal / WorldlineRoundtableView` 当前会在线程 rail / transcript header 回显当前 thread 的 anchor badge，只显示用户可读 label，不直接暴露内部 ids。
- Oracle 自动化状态当前会额外输出：
  - `question_anchor_ids`
  - `thread_question_anchor_ids_json`
  - `pending_question_anchor_ids`
  - `anchor_kind / anchor_label`
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
  - ending-room：`mobile single-ending verdict-anchor thread / artifact readonly / local readonly / reload restore / import`，以及 `multi-ending hotseat / all_present / crossline gallery / artifact readonly / local readonly / reload restore / import`
  - roundtable：`trait_mix / fault_line_first / witness_augmented / hotseat thread switch / quote-anchor thread / artifact readonly / local readonly / reload restore / import`
- roundtable replay 的自动化口径当前已修正：
  - readonly replay 下 `interaction_mode` 会跟随 active replay thread
  - mobile artifact replay readonly 不再因为错误暴露 `archivist_route` 而超时
- 当前 single-ending Oracle 已额外做过真实浏览器复核：
  - 结果页无 `Start Roundtable / Crossline Gallery`
  - `ending_chamber / one_move_only` 可正常打开
  - single-ending chamber readonly replay 仍可 `import`
  - mobile `390x844` 下 chamber modal 仍能完整落在视口内
- `pretext` 已以只读 helper / contract 形式落地在 `frontend/src/lib/textLayout/*` 与相关页面测试中；当前还没有接入运行时 transcript 布局内核。

## 查找路径

- 查页面入口：`frontend/src/pages/*`
- 查 store：`frontend/src/stores/*`
- 查 lib/helper：`frontend/src/lib/*`
- 查 Theater：`frontend/src/game/*`
- 查开发/签收命令：`llmdoc/guides/development.md`
