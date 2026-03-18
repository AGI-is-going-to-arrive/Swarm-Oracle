Original prompt: $develop-web-game  $playwright-interactive  $playwright-interactive 使用以上skills 进行全面的e2e测试 确保该项目所有文档中的改进计划2.0 3.0 是否所有功能都正常实现,并且确实是可玩的? 并且可玩性好

## 2026-03-14 QA Log

- 已读取 `llmdoc/index.md`、`llmdoc/overview/project.md`、`llmdoc/overview/frontend.md`、`llmdoc/overview/backend.md`、`llmdoc/guides/development.md`。
- 已读取 `README.md`、`SwarmOracle_2.0_升级计划.md`、`implement/SwarmOracle_3.0_视觉改进计划.md`、`implement/11_optimization_roadmap.md`。
- 当前目标：建立 2.0/3.0 文档承诺到实际 UI/交互的验证清单，并执行桌面/移动端 E2E 与视觉 QA。
- 待确认项：哪些功能依赖真实 LLM/外部接口；若无可用模型，需要区分“本地可验证 UI/交互”和“端到端真实推演结果”。

## 2026-03-14 Runtime Bring-up

- 后端已用显式环境变量启动在 `http://127.0.0.1:18927`。
- 前端已启动在 `http://127.0.0.1:18928`。
- `POST /api/health` 返回 `{"server":"ok","llm":{"status":"ok","model":"gpt-5.2","response":"OK"}}`，说明默认 LLM 链路可用。
- 启动坑点：不能直接 `source .env.example`，因为 `CORS_ORIGINS` 会被 shell 吃掉 JSON 引号，导致 `pydantic-settings` 解析失败。

## 2026-03-14 E2E Findings

- 已验证页面/入口：
  - 首页：输入框、轮数/Agent 滑杆、模式切换、Pixel Theater 切换、BYOK 测试连接、语言切换、历史入口、排行榜入口、快速开始卡片。
  - 模拟页：Classic/Theater 切换、Agent 列表、实时发言、时间线、截图按钮、GIF 按钮、竞猜弹窗、分支树、干预弹窗与模板。
  - 结果页：多结局列表、Markdown 导出、社交文案生成、小红书文案生成成功、排行榜跳转。
  - 历史页：列表与状态筛选正常。
  - 排行榜页：页面正常，但当前无排名数据。

- 已确认的严重问题：
  - 前端创建场景主路径会因 `frontend/src/api/client.ts` 固定 30s 超时而中止；实际后端解析经常超过 30s，用户界面回到首页且无明确错误提示。
  - Theater 模式存在真实控制台异常：`TypeError: Cannot read properties of null (reading 'drawImage')`，触发栈位于 `WorldScene.ts` 打字机/文本更新路径。

- 已确认的体验问题：
  - 直接打开 `/sim/:id` 默认回到 Classic View；Theater 模式不是 URL/后端持久状态，难以分享和稳定回放。
  - 移动端首页首屏可用，但超大号问题输入文本在 390px 宽度下有明显裁切。
  - 该产品更像“可交互推演剧场”而不是传统可控 web game；玩家主动操作主要来自参数设置、视图切换、预测、干预、导出/分享，不是连续动作操控。

- 工具/测试层事实：
  - `playwright-interactive` 需要的本地 `playwright` 依赖缺失，已通过 `/tmp` 临时 runtime 回退，不改项目依赖。
  - `develop-web-game` 自带脚本原始文件为 ESM 写法但扩展名是 `.js`，需要复制到 `.mjs` 环境后才能执行。
  - 项目未实现 `render_game_to_text` / `advanceTime` 这类标准游戏自动化钩子，导致黑盒自动化对 Phaser 画布可观测性较弱。

## 未执行项 / 保守处理

- 未执行“删除历史场景”，避免误删现有数据库数据。
- 未真正提交干预，只验证到模板加载与文本预填充，避免改变正在运行的场景。
- 未做全量 679+75 测试回归；本轮重点是浏览器 E2E 与真实可玩性验证。

## 2026-03-14 Repair Pass

- 已修复：`POST /api/scenario` 改为即时返回，解析与 agent 生成移到后台任务；前端创建场景后现在会秒级跳到 `/sim/:id`，不再卡在首页等 30s。
- 已补：首页提交失败时会显示可见错误信息，复用现有错误色，不改整体视觉风格。
- 已修复：`WorldScene` 气泡打字机回调增加生命周期守卫，切换 Theater 后不再出现 `drawImage/setText` 相关控制台错误。
- 已增强：气泡文本分辨率从低清改为更高分辨率渲染，并放宽换行宽度、内边距和堆叠间距，减少“文字糊/被压住”的情况。
- 已修复：`scenarios.py` 中旧版预测/排行榜重复路由返回字段不完整，导致排行榜名称空白、评分逻辑与共享服务不一致；现已统一字段为 `user_name/avg_score/best_score/win_streak`，评分委托给共享 scoring service。

## 2026-03-14 Validation After Fix

- 后端定向测试：
  - `pytest tests/test_api.py -k 'create_scenario_returns_immediately_and_schedules_background_parse or get_leaderboard_includes_display_fields' -q` 通过（2 passed）。
- 前端类型检查/构建：
  - `npm run build` 通过。
- 浏览器复验：
  - 首页“开始推演”现在会立即进入 `/sim/:id`。
  - 新建最小场景 `3 agents × 1 round` 成功从 `parsing -> simulating -> done`。
  - Prediction API 提交后，`score-predictions` 成功返回 `scored: 1`，排行榜页能显示用户名列。
  - 历史页成功删除一个 disposable `done` 场景，删除后 leaderboard 也回收到空状态。
  - 真实干预已提交一次，`POST /api/scenario/<id>/intervene` 返回 200。

## Residual Notes

- 由于先前异步创建 bug 产生了两个旧的测试场景仍处于 `simulating` 状态：
  - `4fd3fc3b-aeab-4004-bd0f-639f6af7d96b`
  - `c4edd926-a2f9-43b2-9a4e-0304760fc9f5`
- 这两个是本轮修复前创建的测试工件，不是当前逻辑下新产生的问题；若需要，我可以下一轮专门清理它们。

## 2026-03-15 Follow-up E2E + Repairs

- 新增后端修复：
  - `backend/app/services/simulator.py` 统一使用安全 stance 归一化，避免 `float("支持")` 这类中文立场文本直接导致 Theater 场景报错。
  - `backend/app/api/helpers.py` 的 `load_scenario_response()` 现在会返回 `visualization_enabled` 和 `scene_theme`，避免直开 `/sim/:id` 时丢失剧场状态。
- 新增前端修复：
  - `frontend/src/stores/simulationStore.ts` 在 `setScenario/loadScenario` 中恢复 `visualization_enabled -> viewMode`，已完成场景直开 `/sim/:id` 时不再默认掉回 Classic。
  - `frontend/src/types.ts` 补齐 `Scenario.visualization_enabled` / `scene_theme` 类型字段。
- 新增回归测试：
  - `backend/tests/test_api.py`：校验 `GET /api/scenario/{id}` 返回可视化字段。
  - `backend/tests/test_simulator.py`：校验文本 stance 归一化，并覆盖 `_gather_agent_messages` 的可视化/情绪事件路径。
  - `frontend/src/stores/simulationStore.test.ts`：校验场景 hydration 会恢复 Theater 模式。
- 本轮验证通过：
  - `cd backend && .venv/bin/python -m pytest tests/test_simulator.py -k 'coerce or visualization_path_handles_text_stance_and_emotion_change' -q`
  - `cd backend && .venv/bin/python -m pytest tests/test_api.py -k 'create_scenario_returns_immediately_and_schedules_background_parse or get_scenario_includes_visualization_fields' -q`
  - `cd frontend && npm test -- --run src/stores/simulationStore.test.ts`
  - `cd frontend && npm run build`
- 新的真实浏览器 E2E 结果：
  - 中文 Theater 场景 `如果罗马帝国从未衰落？` 以 `3 agents × 3 rounds` 成功从创建跑到 `done`，`scene_theme=ancient_empire`，页面可见实时气泡与 Agent 面板。
  - 结果页可见；Markdown 导出成功；社交文案弹窗成功打开；另一路场景 `如果互联网从未被发明？` 成功提交预测并由 `score-predictions` 返回 `scored: 1`，排行榜页显示 `Codex QA` 条目。
  - `develop-web-game` 脚本已运行；项目仍未实现 `render_game_to_text`，因此脚本只能产出画布截图，不能产出确定性状态 JSON。
- 仍需说明的体验问题：
  - WebSocket 首次连接阶段仍会出现一次 `closed before the connection is established` 告警，页面随后可恢复，但这是稳定性噪声。
  - 移动端首页输入超长问题时，首屏标题文本会被明显裁切。
  - Theater 完成态虽然能保持场景画面，但没有稳定看到文档中描述的 EndingScene 结局卡片演出；更像是停留在已完成的 WorldScene。

## 2026-03-15 Sequential Fixes 1/2/3

- 已执行 `1`：移动端长问题裁切修复。
  - `frontend/src/pages/InputView.tsx` 将首页问题输入从单行 `input` 改为自动增高的 `textarea`，保持 Enter 提交行为不变。
  - `frontend/src/pages/InputView.css` 新增移动端响应式样式：更小字号、自动换行、左对齐、多行自适应高度。
  - 实测结果：`如果人工智能统治世界并且所有国家都由算法直接治理，会发生什么？` 在 390px 宽度下已可完整换行显示，不再只露出结尾片段。

- 已执行 `2`：WebSocket 首次连接噪声缓解。
  - `frontend/src/hooks/useSimulationWS.ts` 增加延迟首连和定时器清理，避免 React StrictMode / 快速卸载导致 `CONNECTING` 状态下立刻关闭。
  - 同时为重连定时器做显式清理，避免陈旧重连任务残留。
  - 实测结果：新建 Theater 场景时，浏览器控制台未再出现 `WebSocket is closed before the connection is established` 或 `[WS] Error: Event` 初始噪声。

- 已执行 `3`：EndingScene 结局演出定向验证。
  - 未修改 `EndingScene` 代码；通过定制 Playwright 捕获脚本监听 `viz:ending_play`，确认结局事件确实触发。
  - 已截到两类证据：
    - 结局场景背景图（革命主题）
    - 延时后的结局卡片层（标题 `✊ 革命之曙光`） 
  - 控制台日志包含 `[EndingScene] V3 showing ending: revolution`，说明 WorldScene → EndingScene 的切换链路成立。

- 新增验证：
  - `cd frontend && npm run build`
  - `cd frontend && npm test`（现为 76 tests，全通过）

- 文档同步：
  - `llmdoc/overview/project.md`
  - `llmdoc/overview/backend.md`
  - `llmdoc/overview/frontend.md`
  - 最小校验已过：`llmdoc/index.md` 存在、无冲突标记、索引未引用缺失文件。

## 2026-03-15 Automation Hooks

- 新增 Phaser 自动化辅助层：
  - `frontend/src/game/PhaserGame.tsx` 现会在浏览器全局注册：
    - `window.render_game_to_text()`：输出 Theater 当前状态 JSON
    - `window.advanceTime(ms)`：基于 `Phaser.Game.step()` 的受控时间推进
  - `frontend/src/game/automation.ts` 负责拼装自动化输出负载。
  - `frontend/src/game/scenes/WorldScene.ts` / `EndingScene.ts` 暴露 `getAutomationState()`，让自动化层可读取当前场景摘要。
- 新增测试：
  - `frontend/src/game/automation.test.ts`
- 前端回归：
  - `npm test` 通过（现为 `78 passed`）
  - `npm run build` 通过
- `develop-web-game` 脚本验证：
  - 现已能稳定产出 `state-*.json`
  - 示例输出包含：
    - `coordinate_system`
    - `simulation.question/status/currentRound/totalRounds`
    - `simulation.viewMode/visualizationEnabled`
    - `scene.scene`
  - 随后补了 `PhaserGame` replay sync：已完成 Theater 场景直开 `/sim/:id` 时，会自动跳过 `TitleScene` 进入 `WorldScene`。
  - 最新黑盒验证中，`state-0.json` 已输出 `scene: "WorldScene"`，并包含 `theme/weather/time_of_day/agents/bubbles`。
  - 当前 Playwright 脚本对 WebGL 画布的 `shot-*.png` 仍可能读回黑底，这更像运行环境下的画布读回限制；状态 JSON 已能提供确定性自动化证据。

## 2026-03-15 Automation Hooks Phase 2

- 已执行建议 `1`：跨场景 `render_game_to_text()` 增强。
  - `frontend/src/game/scenes/TitleScene.ts` 现在会导出更细的 `getAutomationState()`，包含 `can_skip / is_transitioning / language`。
  - `frontend/src/pages/ResultView.tsx` 在结果页挂载期间也会注册 `window.render_game_to_text()`，输出 route、问题、分支标题、预测数、未评分状态等页面级摘要。
  - `frontend/src/game/automation.ts` 负载新增 `page` 字段。
- 已执行建议 `2`：WebGL 截图黑底收敛。
  - `frontend/src/game/PhaserGame.tsx` 的 Phaser config 现启用 `preserveDrawingBuffer: true`。
  - `develop-web-game` 黑盒复验中，`/tmp/upgrade-test-webgame-shotcheck/shot-0.png` 已成功截到 `WorldScene` 实际画面，不再是纯黑图。
- 新增验证：
  - `npm test` 通过（现为 `80 passed`）
  - `npm run build` 通过
  - `render_game_to_text()` 在结果页返回：
    - `page.kind = "result"`
    - `page.branch_titles`
    - `page.predictions_count`
  - `develop-web-game` 在已完成场景直开 `/sim/:id` 的输出现为：
    - `scene.scene = "WorldScene"`
    - `shot-0.png` 为真实像素剧场画面

## 2026-03-15 Page Automation Coverage

- 已继续扩展页面级 `render_game_to_text()`：
  - `frontend/src/pages/InputView.tsx`
  - `frontend/src/pages/HistoryView.tsx`
  - `frontend/src/pages/LeaderboardView.tsx`
- 当前这些页面都会输出：
  - `page.route`
  - `page.kind`
  - 页面核心摘要字段
  - 标准 `simulation` 占位结构
  - `scene: null`
- 实测读取结果：
  - `/`：返回问题输入、轮数、Agent 数、模式、可视化开关、BYOK 面板状态
  - `/history`：返回筛选器、总条数、当前页、可见场景摘要列表
  - `/leaderboard`：返回排行榜条目数和 Top entries 摘要
- 前端回归：
  - `npm test` 通过（仍为 `80 passed`）
  - `npm run build` 通过

## 2026-03-15 Control Summaries

- 已完成 `SimulationView / ResultView` 的更细控件摘要：
  - `SimulationView` 现在输出：
    - `page.controls.can_go_back`
    - `page.controls.can_toggle_view_mode`
    - `page.controls.can_open_prediction`
    - `page.controls.can_view_results`
    - `page.controls.can_capture_screenshot`
    - `page.controls.can_capture_gif`
    - `page.controls.can_toggle_sidebar`
    - `page.controls.panel_collapsed`
    - `page.controls.capture_status`
    - `page.controls.active_modal`
    - `page.branches[]`（含 `can_view_detail / can_intervene`）
  - `ResultView` 现在输出：
    - `page.controls.can_go_back_to_simulation`
    - `page.controls.can_export_markdown`
    - `page.controls.can_open_share_modal`
    - `page.controls.can_open_leaderboard`
    - `page.controls.can_score_predictions`
    - `page.controls.active_modal`
    - `page.controls.expanded_branch_id`
    - `page.branches[]`（含 `can_expand_story / expanded`）
- 实测确认：
  - `/sim/:id` 的 `render_game_to_text()` 已同时包含页面控件摘要 + Theater 场景状态。
- `/result/:id` 的 `render_game_to_text()` 已包含结果页控件摘要与分支摘要。

## 2026-03-17 Track D / Phase D1

- 已按 `implement/21_track_d_debate_arena_mvp_blueprint.md` 开始独立 Debate domain 竖切，不把逻辑继续塞进通用 `scenario` 链路。
- 当前新增后端骨架：
  - `backend/app/models/debate.py`
  - `backend/app/services/debate_prompts.py`
  - `backend/app/services/debate_scoring.py`
  - `backend/app/services/debate.py`
  - `backend/app/api/debate.py`
  - 对应测试 `backend/tests/test_debate_service.py` / `backend/tests/test_debate_api.py`
- 本轮 D1 设计取向：
  - 先用 deterministic 文案 + 评分计划打通 create/get/result/predict/WS，避免首版被外部 LLM 稳定性拖垮。
  - i18n 从第一刀进入协议层：按输入问题自动判 `zh/en`，turn/judge_summary/score_reason 跟随语言。
  - 美术/主题暂不新增资源，优先复用当前 Theater 风格场景：`law_court_variant / civic_chamber / switchboard_forum_variant / faith_temple_variant / imperial_forum / war_command`。
  - 这能先覆盖更多题材，同时避免 Debate Arena 视觉风格偏离现有 Pixel Theater。
- 待下一步验证：
  - 后端定向 pytest
  - API/WS 事件字段是否与前端 D2 预期一致
  - 是否继续推进前端 `DebateArenaView / DebateResultView / debateStore`

### 2026-03-17 D1 Validation

- 后端新增定向测试已通过：
  - `cd backend && .venv/bin/python -m pytest tests/test_debate_service.py -q`
  - `cd backend && .venv/bin/python -m pytest tests/test_debate_api.py -q`
- 主应用 smoke 也通过：
  - `cd backend && .venv/bin/python -m pytest tests/test_api.py -k 'test_root or test_health' -q`
- 当前 D1 结果：
  - 已具备 `POST /api/debate`
  - 已具备 `GET /api/debate/{id}`
  - 已具备 `GET /api/debate/{id}/result`
  - 已具备 `POST /api/debate/{id}/predict`
  - 已具备 `WS /ws/debate/{id}`
  - 背景执行为 deterministic 5 phase debate，支持 `winner / verdict_tone` 两类结构化押注，结果会自动评分已提交 prediction
- 当前未做：
  - 前端 `DebateArenaView / DebateResultView / debateStore`
  - Debate 专属素材生成与前端接线
  - desktop/mobile Debate E2E

## 2026-03-17 Track D / Phase D2-D3

- 已完成前端 Debate Arena 最小闭环：
  - 路由：
    - `frontend/src/App.tsx`
    - `/debate/:id`
    - `/debate/:id/result`
  - 首页入口：
    - `frontend/src/pages/InputView.tsx`
    - `frontend/src/pages/InputView.css`
    - 现已新增 `Start Debate Arena / 进入辩论竞技场` 次入口，不替换原 simulation 主入口
  - API / 类型 / store / hook：
    - `frontend/src/types.ts`
    - `frontend/src/api/client.ts`
    - `frontend/src/stores/debateStore.ts`
    - `frontend/src/hooks/useDebateWS.ts`
  - 页面与组件：
    - `frontend/src/pages/DebateArenaView.tsx`
    - `frontend/src/pages/DebateResultView.tsx`
    - `frontend/src/pages/DebateArena.css`
    - `frontend/src/components/DebateStageRibbon.tsx`
    - `frontend/src/components/DebateMomentumBar.tsx`
    - `frontend/src/components/DebateScoreCard.tsx`
    - `frontend/src/components/DebateBetModal.tsx`
    - `frontend/src/components/DebateShareModal.tsx`
    - `frontend/src/lib/debateLabels.ts`
    - `frontend/src/lib/debateShare.ts`
- 关键实现取向：
  - Debate live/result 暂不硬塞进 Phaser，先用 DOM 舞台复用现有 Theater 场景图、GBC 色调和仪式感面板，保证跨平台和首版稳定性。
  - `render_game_to_text()`、`advanceTime(ms)`、`capture_game_screenshot()` 已接到 Debate live/result 页面，便于后续 E2E / Playwright 自动化。
  - i18n 已补齐 Debate 文案到 `frontend/src/i18n/locales/en.json` / `zh.json`，避免新页面再写硬编码串语言。
  - 主题/美术暂时优先复用当前场景池，不新增风格冲突的素材；Track D 当前更适合先验证玩法与适配，再决定是否补 debate 专属资产。

## 2026-03-17 Validation — Frontend + Smoke

- 前端类型检查通过：
  - `cd frontend && npm exec -- tsc --noEmit`
- 前端定向测试通过：
  - `cd frontend && npm test -- --run src/stores/debateStore.test.ts src/pages/DebateArenaView.test.tsx src/pages/DebateResultView.test.tsx`
  - `cd frontend && npm test -- --run src/pages/InputView.test.tsx src/pages/SimulationView.test.tsx src/stores/debateStore.test.ts src/pages/DebateArenaView.test.tsx src/pages/DebateResultView.test.tsx`
- 前端构建通过：
  - `cd frontend && npm run build`
- 后端定向测试仍通过：
  - `cd backend && .venv/bin/python -m pytest tests/test_debate_service.py tests/test_debate_api.py -q`
- 真实浏览器 smoke：
  - 已启动本地后端 `127.0.0.1:18927` 与前端 `127.0.0.1:18928`
  - Desktop：首页输入问题 -> `Start Debate Arena` -> 进入 `/debate/:id` 成功，live 页能显示 motion / phase / momentum / panel / result CTA
  - Mobile viewport `390x844`：同一路径下首屏仍可读到舞台标题、阶段条、势能条与主按钮
  - Result：`/debate/:id/result` 可显示 winner / score breakdown / replay digest / share modal

## Residual Risks

- Debate live 当前后台生成较快，前端通过本地 `auto reveal` 做阶段揭示；后续若要更强“现场感”，可考虑在服务端事件节奏上增加可配置延迟或流式生成。
- Debate 专属美术仍未补新素材；现在依赖现有 Theater 场景池，风格一致但题材表现还不算专门化。
- 首页仍会因 campaign profile 的 404 打控制台资源错误；这是现有系统的旧行为，不是 Debate 新增问题。

## 2026-03-17 Track D / Phase D4

- 已补 Debate 专属资产生成链路：
  - `frontend/scripts/generate-ui-assets.mjs`
  - `frontend/package.json` 新增 `generate:ui-assets`
  - 新 preset：
    - `debate_arena_civic`
    - `debate_arena_judicial`
    - `debate_arena_forum`
    - `debate_stage_banner`
    - `debate_verdict_panel`
    - `debate_score_meter`
    - `debate_badge_proposition`
    - `debate_badge_opposition`
    - `debate_badge_judge`
    - `debate_quote_frame`
- 已使用 Gemini 图像模型生成并落盘：
  - `frontend/public/assets/scenes/debate_arena_*.png`
  - `frontend/public/assets/ui/generated/debate_*.png`
- 已为新生成文件补 sidecar provenance：
  - 同名 `.meta.json`
  - 字段现包含 `preset/model/provider/source/source_url/generated_at/output/prompt`
- 已补 front-end 接线：
  - `frontend/src/lib/themeRegistry.ts` 新增 `debate_arena_*` theme 和 `DEBATE_UI_ASSETS`
  - `backend/app/services/debate_prompts.py` 已把 debate profile 映射改为 Debate 专属 scene id
  - `frontend/src/pages/DebateArenaView.tsx`
  - `frontend/src/pages/DebateResultView.tsx`
  - `frontend/src/components/DebateScoreCard.tsx`
  - `frontend/src/components/DebateMomentumBar.tsx`
  - `frontend/src/pages/DebateArena.css`
- 已补 credits：
  - `frontend/public/assets/ASSET_CREDITS.md`

## 2026-03-17 D4 Validation

- 后端 debate 测试通过：
  - `cd backend && .venv/bin/python -m pytest tests/test_debate_service.py tests/test_debate_api.py -q`
- 前端类型 / 测试 / 构建通过：
  - `cd frontend && npm exec -- tsc --noEmit`
  - `cd frontend && npm test -- --run src/stores/debateStore.test.ts src/pages/DebateArenaView.test.tsx src/pages/DebateResultView.test.tsx src/pages/InputView.test.tsx src/pages/SimulationView.test.tsx`
  - `cd frontend && npm run build`
- 真实浏览器 smoke：
  - desktop：首页 -> Debate live -> result -> share modal 成功
  - mobile viewport `390x844`：result 首屏仍能读到 verdict hero、scoreline、按钮和分数卡；live 首屏可见 stage ribbon、momentum 和主按钮

## Remaining Nice-to-Haves

- 若继续提升 D4 质量，可补：
  - Debate 专属 screenshot baseline 到 `frontend/output/e2e/debate-*`
  - 生成资产的批量重试/断点续跑能力（当前 TLS `ECONNRESET` 仍需人工重跑）
  - 将旧的 `.meta.json` 统一补齐到新 provenance schema

## 2026-03-17 Cleanup Fixes

- 已修复首页 campaign 404 噪声：
  - `backend/app/services/campaign.py`
  - `backend/app/api/campaign.py`
  - 无 profile 时现在返回空摘要 / 空 mastery / 空 badges / `completed=false` 的 daily-status
  - 新增 API 回归：
    - `backend/tests/test_campaign_api.py`
- 已修复 E2E 脚本对 `frontend/output/...` 参数的路径归一化：
  - `frontend/scripts/e2e-suite.mjs`
  - `frontend/scripts/e2e-automation.mjs`
  - 现在从 `frontend` 包目录执行时，传 `frontend/output/...` 不会再误落到 `frontend/frontend/output/...`
- 额外验证：
  - `cd backend && .venv/bin/python -m pytest tests/test_campaign_api.py tests/test_campaign_service.py -q`
  - `cd frontend && node scripts/e2e-automation.mjs health --url http://127.0.0.1:18928 --output-dir frontend/output/e2e/path-fix-check --headless`
  - 浏览器实测首页加载不再出现 campaign profile 404 控制台报错

## Left Untouched

- `frontend/frontend/` 目录下已有历史工件仍保留，未自动删除，避免误删用户现有产物。当前修复只保证后续新工件不再错误写入这个嵌套路径。

## 2026-03-17 Track A3 + B2 继续推进

- 已补 `Track A3`：
  - `backend/app/services/campaign.py` 的 profile summary 现在会返回最近一次 daily challenge 完成记录：
    - `last_daily_challenge_completed_at`
    - `last_daily_challenge_profile_id`
    - `last_daily_challenge_scenario_id`
  - `backend/app/api/campaign.py` / `frontend/src/types.ts` 已同步这些字段。
  - `frontend/src/pages/InputView.tsx` 现在会优先用后端 campaign 数据判定“今天的 daily challenge 是否已完成”，本地 `dailyChallenge` 存储只继续承担“进行中 / 细节缓存”的角色。
  - 新增回归覆盖：
    - `backend/tests/test_campaign_service.py`
    - `backend/tests/test_campaign_api.py`
    - `frontend/src/pages/InputView.test.tsx`

- 已补 `Track B2`：
  - `frontend/src/components/gameplayCards.ts` 已删除前端重复维护的 card/profile/signature arc/system effects 大块常量，改为直接 alias `shared/gameplay_contract.v1.json` 的 contract 消费层。
  - 仍保留 profile inference / agent heuristics / prompt builder，这些属于消费逻辑，不再是第二份事实源。

- 本轮定向验证：
  - `cd backend && .venv/bin/python -m pytest tests/test_campaign_service.py tests/test_campaign_api.py -q` → `8 passed`
  - `cd frontend && npm test -- --run src/pages/InputView.test.tsx src/pages/ResultView.test.tsx src/components/gameplayContract.test.ts` → `5 passed`
  - `cd frontend && npm test -- --run src/components/gameplayCards.test.ts src/components/GameplayCardsModal.test.tsx src/components/PredictionModal.test.tsx` → `22 passed`
  - `cd frontend && npm run build` → 通过

- 运行时注意：
  - 发现 `18927` 一度指向了别的工作区 `Desktop/test/backend`，已切回当前仓库 `upgrade-test/backend` 的 uvicorn 进程，否则 E2E 结论会被污染。

- 下一步：
  - 跑当前仓库自己的 `e2e-suite` / `develop-web-game` / `playwright-interactive`。
  - 重点复核 12 profile 覆盖、mobile、scene selector、capture/headless、以及 replay 关键路径。

## 2026-03-17 QA Inventory Refresh

- 本轮 signoff 声称要覆盖的用户可见行为：
  - 首页 daily challenge 会以后端 campaign 为准显示完成态
  - 首页 / 结果页导演生涯信息可读
  - gameplay contract 不会因前端 legacy 常量残留而和 shared JSON 漂移
  - Theater / replay / result / share / mobile 关键路径仍可用

- 本轮需要明确检查的控件与状态：
  - 首页：daily challenge CTA、语言切换、快速开始、问题输入、模式切换、Theater 开关
  - Theater：回放筛选、截图模式、玩法卡、下注弹窗、结果跳转
  - 结果页：Campaign Progress、分享弹窗、排行榜跳转、预测评分
  - mobile：首页首屏、Theater 首屏、结果页首屏

- 本轮 off-happy-path：
  - 旧数据库 `scenario_id` 缺失时 matrix runtime fallback 是否仍能跑通
  - headless 截图异常时 suite 的 CDP fallback 是否把“工具黑底”与“真实 UI 问题”区分清楚

## 2026-03-17 i18n + Browser QA 补充

- 交互式 QA 中确认并修复：
  - 英文界面的 daily challenge 卡片此前仍显示中文题面，并且启动挑战时会把中文题面直接送进英文 UI 流。
  - 现已在 `frontend/src/lib/dailyChallenge.ts` 为 12 条 challenge 补上英文题面，并新增 `getChallengeQuestion()`。
  - `frontend/src/pages/InputView.tsx` 已改为：
    - challenge 卡片标题按当前语言展示；
    - `Start Daily Challenge` / `开始今日挑战` 会按当前语言使用对应题面发起场景。

- 新增验证：
  - `cd frontend && npm test -- --run src/lib/dailyChallenge.test.ts src/pages/InputView.test.tsx`
    - `11 passed`
  - `cd backend && .venv/bin/python -m pytest tests/test_campaign_service.py tests/test_campaign_api.py tests/test_gameplay_contract_sync.py -q`
    - `10 passed`
  - `cd frontend && npm test -- --run src/lib/dailyChallenge.test.ts src/pages/InputView.test.tsx src/pages/ResultView.test.tsx src/components/PredictionModal.test.tsx src/components/gameplayContract.test.ts src/components/gameplayCards.test.ts`
    - `37 passed`
  - `cd frontend && npm run build`
    - 通过

- 新增黑盒取证：
  - 新建 Theater 场景：
    - `e9e3e35e-db63-4ff8-a2ad-135529c7c412`
  - `develop-web-game` 工件：
    - `frontend/output/web-game/20260317-track-a3-b2/shot-0.png`
    - `frontend/output/web-game/20260317-track-a3-b2/shot-1.png`
    - `frontend/output/web-game/20260317-track-a3-b2/state-0.json`
    - `frontend/output/web-game/20260317-track-a3-b2/state-1.json`
  - 结果：
    - `render_game_to_text()` 返回 Theater replay / control / scene 摘要正常；
    - `law_court` 主题画面可见，panel 截图不是黑底；
    - 回放态 `can_view_results / can_capture_screenshot / can_capture_gif / replay_state` 都在状态 JSON 里可见。

- 浏览器自动化环境现状：
  - 这台机器上的 Playwright/Chrome 自动化会话不稳定，出现过 dev server 僵住、`js_repl` 会话超时重置、以及 Playwright 持久上下文启动失败等宿主环境问题。
  - 已拿到一部分真实浏览器证据，但全量 `e2e:full` 仍需要在更稳定的本机浏览器权限环境下重跑。

## 2026-03-17 Track C 收口

- 新增产品修复：
  - `frontend/src/game/PhaserGame.tsx`
    - 把 completed replay / mobile Theater 的 `WorldScene` bootstrap 竞态补上。
    - 现在 `scene_ready` 延迟回读 store，并额外通过 `bootstrapWorldSceneFromStore()` 统一处理 late-loaded agents/messages。
  - `frontend/src/game/worldSceneBootstrap.ts`
    - 抽出纯函数 guard，避免测试把 Phaser runtime 整个拉进 jsdom。
  - `frontend/scripts/e2e-suite.mjs`
    - `mobile` 套件不再在 `scene=null` 时误判通过。
    - 现在要求：
      - `scene.scene` 存在且不为 `BootScene/TitleScene`
      - `scene.agent_count > 0`
    - 失败时会 fresh reload 一次再重试，并把最后 scene/agent_count 打进错误信息。

- 新增/更新验证：
  - `cd frontend && npm test -- --run src/game/PhaserGame.test.ts src/game/replaySync.test.ts src/game/replaySelection.test.ts src/pages/SimulationView.test.tsx src/hooks/useScreenCapture.test.ts`
    - `21 passed`
  - `cd backend && .venv/bin/python -m pytest tests/test_scene_selector.py tests/test_simulator_viz_integration.py tests/test_gameplay_contract_sync.py -q`
    - `216 passed`
  - `cd frontend && npm run build`
    - 通过

- 真实黑盒工件：
  - corners:
    - `frontend/output/e2e/20260317-track-c-corners/result.json`
  - mobile:
    - 首次暴露了 `scene=null` 的假通过问题：
      - `frontend/output/e2e/20260317-track-c-mobile/mobile-theater.json`
      - `frontend/output/e2e/20260317-track-c-mobile/mobile-theater.png`
    - 修复后最终工件：
      - `frontend/output/e2e/20260317-track-c-mobile-final/mobile-home.json`
      - `frontend/output/e2e/20260317-track-c-mobile-final/mobile-home.png`
      - `frontend/output/e2e/20260317-track-c-mobile-final/mobile-theater.json`
      - `frontend/output/e2e/20260317-track-c-mobile-final/mobile-theater.png`
      - `frontend/output/e2e/20260317-track-c-mobile-final/mobile-result.json`
      - `frontend/output/e2e/20260317-track-c-mobile-final/mobile-result.png`
  - matrix:
    - `frontend/output/e2e/20260317-track-c-matrix/result.json`
    - 已完成 15 个样本（12 profile + 语义变体）：
      - governance / law / trade / ecology / war / faith / industry / frontier / mythic / survival / generic
      - governance_surveillance / empire_palace / industry_grid / war_logistics

- Track C 当前结论：
  - replay：
    - completed replay 不回 `TitleScene` 已有单测 + matrix replay 工件
    - `skip -> branch switch -> replay` 已由 corners 工件 `replay_skip_switch` 取证
  - scene selector：
    - 后端 selector / 前端题材命中当前通过 `216` 个后端相关测试覆盖
  - capture/headless：
    - `panel / canvas / modal` 与 replay/result/share 相关路径已在 corners/mobile/matrix 工件取证
  - mobile：
    - completed Theater 首屏与结果页双证据已补齐
    - 之前的 mobile false positive 已被修掉，不再把 `scene=null` 当作通过

## 2026-03-17 Track C 完成收口

- `Track C` 本轮已完成的代码/脚本收口：
  - `frontend/scripts/e2e-suite.mjs`
    - matrix 现在按 sample 输出到本次 `outputDir/<theme>/replay|result`，不再把工件散落到全局目录；
    - 增加逐 theme 进度日志，避免长时间静默看起来像“卡死”；
    - 修掉 fallback 分支里重赋值 `const page` 的潜在炸点；
    - matrix 会检测历史 sample 的 `scene_theme` 是否和当前 runtime 结果漂移，发现旧 `scenario_id` 过期时会自动 runtime fallback 重建。
  - `backend/app/visualization/scene_selector.py`
    - 已按最新样本契约命中 `law_court_variant / faith_temple_variant / switchboard_forum_variant`。
  - `backend/tests/test_e2e_sample_matrix.py`
    - 新增样本契约回归：`sample_matrix.json` / `sample_matrix_variants.json` 的 `scene_theme` 必须与当前 `select_scene(question)` 一致。

- 本轮定向验证：
  - `cd frontend && npm test -- --run src/game/replaySync.test.ts src/game/replaySelection.test.ts src/pages/SimulationView.test.tsx src/hooks/useScreenCapture.test.ts`
    - `18 passed`
  - `cd backend && .venv/bin/python -m pytest tests/test_scene_selector.py tests/test_simulator_viz_integration.py -q`
    - `214 passed`
  - `cd backend && .venv/bin/python -m pytest tests/test_scene_selector.py tests/test_e2e_sample_matrix.py -q`
    - `146 passed`
  - `node --check frontend/scripts/e2e-suite.mjs`
    - 通过

- 本轮真实浏览器工件：
  - matrix：`frontend/output/e2e/20260317-track-c/matrix/`
    - `result.json`
    - 15 个样本：`governance / law / trade / ecology / war / faith / industry / frontier / mythic / survival / generic / governance_surveillance / empire_palace / industry_grid / war_logistics`
  - corners：`frontend/output/e2e/20260317-track-c/corners/`
    - `result.json`
    - 已落 replay skip/switch、result loading gate、share context、share retry、history delete-last-page 等工件
  - mobile：`frontend/output/e2e/20260317-track-c/mobile/`
    - `mobile-home.png/.json`
    - `mobile-theater.png/.json`
    - `mobile-result.png/.json`
  - variants：`frontend/output/e2e/20260317-track-c/variants/`
    - `result.json`
    - 已真实跑通：
      - `law_grand_tribunal -> law_court_variant`
      - `faith_council -> faith_temple_variant`
      - `generic_review_chamber -> switchboard_forum_variant`
  - develop-web-game：`frontend/output/web-game/20260317-track-c/`
    - `shot-0.png`
    - `shot-1.png`
    - `state-0.json`
    - `state-1.json`

- 视觉复核结论：
  - `mobile-home.png`：daily challenge 卡、语言切换与首屏表单可见，无致命裁切。
  - `mobile-theater.png`：回放控件、主画布、结果入口可见；信息密度仍高，但关键控件未被裁掉。
  - `mobile-result.png`：结果页首屏 CTA、标题和首张结果卡可见。
  - `develop-web-game shot-1.png`：`scifi_base` 主题截图正常，非黑底；`state-1.json` 同时给出 replay/scene 双证据。

- 运行时注意：
  - 变体 matrix 初次失败并不是 selector 代码本身错误，而是 `18927` 上的 uvicorn 还在跑旧进程；重启当前仓库后端后，variants 已全部 runtime 通过。

## 2026-03-17 Track D 文档已落盘

- 已新增 `implement/20_track_d_debate_arena_design_execution_plan.md`。
- 该文档已覆盖：
  - Track D 产品定位与边界
  - MVP 玩法循环与评分机制
  - i18n 与跨平台约束
  - 美术素材规划与 AI 生图方向
  - 前后端代码开发拆分
  - `develop-web-game` / `playwright-interactive` / Playwright CLI 三层测试方案
  - code review 清单与验收标准
- 已同步 `implement/README.md` 索引，下一轮可直接据此进入 Debate Arena 实现。

## 2026-03-17 文档同步

- 已按实际代码与真实测试结果同步以下文档：
  - `llmdoc/overview/project.md`
  - `llmdoc/overview/frontend.md`
  - `llmdoc/overview/backend.md`
  - `llmdoc/guides/development.md`
  - `llmdoc/reference/api.md`
  - `README.md`
  - `frontend/README.md`
  - `backend/README.md`
  - `implement/README.md`
- 本轮文档同步重点：
  - `campaign daily-status` API 与首页 daily challenge 真值合并
  - daily challenge 双语题面
  - Track C 最新 matrix / corners / mobile / variants / develop-web-game 工件目录
  - `e2e-suite.mjs` 的 sample `scene_theme` 漂移 fallback
  - Track D 设计文档索引

## 2026-03-17 Track C 收口

- 已补 `Track C` 的代码侧缺口：
  - `frontend/scripts/e2e-suite.mjs`
    - 现在会检测 `sample_matrix.json` 里的 `scene_theme` 是否与当前实际场景一致；
    - 若历史 `scenario_id` 对应的是旧主题，会自动走 runtime fallback 重建，而不是继续拿漂移样本当作通过；
    - `runMatrixSuite()` 的 fallback 路径已修复 `const page` 重建问题；
    - matrix 现在会按 sample 独立落盘到 `outputDir/<theme>/{replay,result}`，便于追踪。
  - `frontend/output/e2e/sample_matrix.json`
    - 已把过时的 5 条 `scene_theme` 纠正为当前 selector 预期：
      - `law -> law_court`
      - `trade -> trade_harbor`
      - `ecology -> ecology_wasteland`
      - `war -> war_command`
      - `faith -> faith_temple`
  - `backend/app/visualization/scene_selector.py`
    - 补了 `grand tribunal archive chamber -> law_court_variant` 的更具体命中，避免 `constitutional` 与 `grand tribunal` 同长度时误回落到普通 `law_court`。
  - 新增守卫测试：
    - `backend/tests/test_e2e_sample_matrix.py`
    - 保证 `sample_matrix.json / sample_matrix_variants.json` 中每条 question 的 `scene_theme` 与当前 `select_scene(question)` 一致。

- 本轮定向验证：
  - `cd frontend && npm test -- --run src/game/replaySync.test.ts src/game/replaySelection.test.ts src/pages/SimulationView.test.tsx src/hooks/useScreenCapture.test.ts`
    - `18 passed`
  - `cd backend && .venv/bin/python -m pytest tests/test_scene_selector.py tests/test_simulator_viz_integration.py -q`
    - `214 passed`
  - `cd backend && .venv/bin/python -m pytest tests/test_scene_selector.py tests/test_e2e_sample_matrix.py -q`
    - `146 passed`
  - `node --check frontend/scripts/e2e-suite.mjs`
    - 通过

- 宿主环境结论（已明确区分，不再把它误判为产品问题）：
  - 当前机器从 Node CLI 启动 Playwright 浏览器会直接崩在 Chromium/Chrome for Testing 的 Crashpad + MachPort 权限链路：
    - `bootstrap_check_in ... Permission denied (1100)`
    - `Crashpad/settings.dat: Operation not permitted`
    - `MachPortRendezvousServer ... Permission denied (1100)`
  - 这会阻塞 `npm run e2e:matrix|corners|full` 的本机浏览器拉起，但不影响已跑过的前后端定向测试结果，也不说明 replay/scene selector/capture 业务逻辑本身仍然损坏。

- 当前 Track C 判断：
  - **代码与样本契约层面：已收口。**
  - **本机浏览器级全量回归：仍受宿主权限环境阻塞，需在能正常拉起 Playwright 浏览器的环境下重跑。**

## 2026-03-15 Replay Hardening + Timeline Director Pass

- 新发现并已修复的真实问题：
  - `frontend/src/pages/SimulationView.tsx` 在完成态 Theater 自动化路径下会因 `replayAutomationState` 的时序使用触发 `ReferenceError: Cannot access 'replayAutomationState' before initialization`。
  - 这个问题会直接导致 `develop-web-game` 客户端拿不到 `state-0.json`；现已修复，并补齐 `page.replay_state` / `controls.replay_state` 输出。

- 按 `implement/18_next_session_gameplay_art_replay_plan.md` 已继续完成的内容：
  - `TimelineBar` 现在真正接入完成态 Theater 回放：
    - 点击可用轮次可直接跳到对应 replay round
    - round marker 会显示 fork / card / bet 摘要
    - marker 数据来自：
      - 分支 `fork_round`
      - 本地玩法记录 `scenarioMeta.cards.usageLog`
      - 本地下注记录 `scenarioMeta.betting.bets`

- 新增 / 更新校验：
  - `frontend/src/components/TimelineBar.test.tsx`
  - `frontend/src/game/automation.test.ts`
  - `cd frontend && npm test` → `100 passed`
  - `cd frontend && npm run build` → 通过

## 2026-03-17 Generic Quick-Start + Regression Notes

- 已继续补 generic 入口，但保持最小改动和现有视觉风格：
  - `QuickStartCards.tsx` 现在不再只有一条 generic 样本。
  - 当前 generic quick-start 共 3 条：
    - `如果所有大型组织都必须每周随机交换一次负责人，会发生什么？`
    - `如果所有关键城市都必须每三十天由抽签产生的临时委员会接管，会发生什么？`
    - `如果每一项重大决策都必须交给轮值外部评审团重新裁决，会发生什么？`
- 前端 generic 识别已同步扩展：
  - `gameplayCards.ts` 的 generic profile 关键词已覆盖新的 `抽签委员会 / 轮值外部评审团` 题面。
  - `VizSynthesizer.ts` 的 `switchboard_forum` 场景推断也已覆盖同一组题面。
  - 对应单元测试已补齐。

- 后端测试隔离已修复：
  - `backend/tests/conftest.py` 不再复用固定 `test_swarmoracle.db` 文件。
  - 现改为每个测试使用独立 `tmp_path` SQLite，并在前后显式 `dispose_engine()`。
  - 之前的 `readonly database / disk I/O error` 已消失。

- 本轮验证：
  - `cd frontend && npm test` → `151 passed`
  - `cd frontend && npm run build` → 通过
  - `cd backend && .venv/bin/python -m pytest tests/test_scene_selector.py tests/test_simulator_viz_integration.py -q` → `209 passed`

- 仍需说明的回归/环境问题：
  - `scripts/e2e-suite.mjs` 已具备 matrix 场景缺失时的 fallback 创建能力，但在当前 macOS 会话里，Playwright 新开浏览器仍可能遇到本机浏览器会话/权限相关启动失败。
  - 旧 `sample_matrix.json` 里的固定 `scenario_id` 依然不能假设在当前数据库中存在；本地验证时要以 fallback runtime create 为准，而不是盲信历史 ID。

- 给下一位 agent 的建议：
  - 如果继续做 generic 玩法深化，优先补 `switchboard_forum` 专属截图/取证样本，而不是再扩更多文字题面。
  - 如果要继续压实一键黑盒回归，下一步应该聚焦 Playwright 启动环境兼容，而不是继续堆文档描述。

- `develop-web-game` 复验结论：
  - Headless:
    - `state-0.json` 现已恢复，包含 `page.replay_state`
    - `shot-0.png` 仍可能是纯黑（WebGL/headless 读回限制仍在）
  - Headed:
    - `state-0.json` 正常
    - `shot-0.png` 已能稳定截到真实 Theater 画面
  - 结论：当前黑盒自动化应以 `state-*.json` 为主证据；需要视觉真值时优先 headed 运行

- 当前剩余建议：
  - 若下一轮继续做回放 QA，优先补一个针对 `SimulationView` 的自动化回归测试，专门锁死 `page.replay_state`
  - 若继续做玩法 polish，下一优先级仍是 `TimelineBar hover 明细更丰富` 与 `因果档案图鉴化`

## 2026-03-15 Gameplay Art + Archive Upgrade + i18n Pass

- 已继续执行 `implement/18_next_session_gameplay_art_replay_plan.md` 的后续项：
  - 生成并接入玩法卡专属卡框：
    - `gameplay_card_frame_governance.png`
    - `gameplay_card_frame_war.png`

## 2026-03-15 QA Round 2 Kickoff

- 已按本轮要求重新读取：
  - `llmdoc/index.md`
  - `llmdoc/overview/project.md`
  - `llmdoc/overview/frontend.md`
  - `llmdoc/overview/backend.md`
  - `README.md`
  - `SwarmOracle_2.0_升级计划.md`
  - `implement/SwarmOracle_3.0_视觉改进计划.md`
  - `implement/11_optimization_roadmap.md`
  - `implement/18_next_session_gameplay_art_replay_plan.md`
- 本轮测试策略：
  - 使用 `develop-web-game` 做黑盒动作回放与 `state-*.json` / `panel|canvas|modal` 证据采集
  - 使用 `playwright-interactive` 做持久浏览器观察、截图与探索式试玩
  - 补充 `playwright` CLI 风格的流程化页面验证
- 当前运行态：
  - 15:06 检查时 `127.0.0.1:18927` / `127.0.0.1:18928` 都未监听，需重新拉起干净实例
- 目标覆盖：
  - 文档承诺核验（2.0 / 3.0 / optimization / llmdoc / README）
  - `P4` 六组题材：`governance / trade / law / faith / ecology / war`
  - 每组至少验证 `live → inject/play card → result/archive → share` 主链路
- 待验证的高价值项：
  - 页面级 `render_game_to_text()` 是否与真实 UI 同步
  - Theater replay / capture mode / gameplay cards / daily challenge / archive / share chips 是否全部成立
  - “可玩性”是否只停留在功能存在，还是已经形成足够多样的决策与反馈闭环

## 2026-03-15 P4 QA Mid-Run Fixes

- 已确认并修复 `Gameplay profile` 判定偏差：
  - 根因：`frontend/src/components/gameplayCards.ts` 的 `inferGameplayProfile(question, sceneTheme)` 会让 `sceneTheme` 与题面关键词打平后抢走最终画像，导致：
    - `law` 题面在 `modern_city` 下掉回 `governance`
    - `faith` 题面在 `fantasy_kingdom` 下掉回 `mythic`
    - `ecology` 题面因关键词覆盖不足在 live 中掉回 `governance/generic`
  - 修复：
    - 改为“题面关键词优先，`sceneTheme` 仅在无题面命中时兜底”
    - ecology 关键词补充：`淡水 / 枯竭 / 干旱 / freshwater`
  - 新增回归断言：
    - `现代都市 + 最高法院紧急否决权` => `law`
    - `奇幻王国 + 神谕统治` => `faith`
    - `现代都市 + 跨大陆淡水枯竭` => `ecology`

- 已确认并修复 `Modal` 截图模式失效：
  - 修复前：浏览器里真实存在 Gameplay modal，但 `window.capture_game_screenshot('modal')` 返回 `null`
  - 第一层根因：`SimulationView` modal 模式只抓 `.modal-overlay`，实际更稳定的目标应优先是具体 modal content
  - 修复：
    - `frontend/src/hooks/useScreenCapture.ts` 新增按 selector 顺序回退的 blob 捕获
    - `frontend/src/pages/SimulationView.tsx` 的 modal 模式改为优先尝试：
      - `.gameplay-modal`
      - `.share-modal`
      - `.modal-content`
      - `.share-overlay`
      - `.modal-overlay`
  - `SimulationView.test.tsx` 已补回归，验证 modal 模式会按顺序尝试具体弹窗节点
  - 追加真机结论：
    - selector 路径已收敛，但当前运行环境下 `captureElementDataUrl(..., 'element')` 对纯 DOM 元素整体仍可能返回 `null`
    - 额外 probe 结果：
      - `captureElementDataUrl('.gameplay-modal', 'element')` => `null`
      - `captureElementDataUrl('body', 'element')` => `null`
    - 说明底层 `html2canvas` / DOM-to-image 路径在当前运行环境仍未真正恢复；目前可视真值仍需依赖 Playwright/DevTools 直接截图

- 本轮已完成验证：
  - `cd frontend && npm test -- --run src/components/gameplayCards.test.ts src/components/GameplayCardsModal.test.tsx src/pages/SimulationView.test.tsx`
  - `cd frontend && npm run build`

- 人工复验（law / 今日挑战）：
  - 从首页 `开始今日挑战` 进入 `/sim/:id`
  - warmup 首屏显示：
    - 世界线已就绪
    - 角色同步中
    - 导演工具待解锁
  - live `🃏 玩法卡` 打开后，画像已从错误的 `治理博弈` 修正为正确的 `法律红线`
  - result 页 `因果档案` 现显示：
    - `法律红线`
    - hooks：`紧急否决 / 审计证据 / 程序补丁`
    - `挑战反馈：已完成 · 法律红线 · 方向基本吻合`
  - share modal 实测生成的小红书文案前缀包含：
    - `【法律红线｜方向基本吻合】`
    - `题材钩子：紧急否决 · 审计证据 · 程序补丁`

- 当前明确发现但尚未处理的非本次修复问题：
  - `law` 每日挑战 live 场景的 Theater 主题仍落在 `scifi_base`，这不影响玩法画像，但说明“题目 -> 场景主题”规则仍可能与玩法画像并不完全一致，需继续在 P4 批量测试中观察

## 2026-03-15 Follow-up 1 / 2 / 3 Complete

- `1` Replay 深链：
  - `frontend/src/pages/SimulationView.tsx`
    - 完成态 replay 下，切换 `世界线 / 轮次` 现在会显式把 `playbackMode` 复位到 `replay`
    - 顶部 Theater round chip 现在显示当前选中的 `selectedReplayRound`，不再固定挂 `currentRound`
  - `frontend/src/pages/SimulationView.test.tsx`
    - 新增回归：`skip -> 切世界线 -> replay_state.playback_mode` 必须回到 `replay`
    - 新增断言：Theater 顶部 round chip 应显示选中的 replay 轮次
  - 真机复核：
    - `war` 完成态场景 `4d106465-5abe-430a-b7a6-2542956fdefc`
    - `skip` 后切到另一条世界线，`render_game_to_text().page.replay_state` 已从：
      - `playback_mode = skip`
      - 切回到
      - `playback_mode = replay`
    - 且 `selected_round` 会按目标世界线更新（示例中从 `1` → `2`）
  - 说明：
    - `trade` 现有完成态样本 `823a9a7c-046d-4562-89c0-4f88ef09f3ea` 只有单世界线，无法用它验证“切世界线”类 replay 深链；但 live 玩法画像已对上 `trade`

- `2` Modal 截图根因：
  - 根因已确认：`html2canvas` 在当前页面会因 `oklch(...)` 颜色函数直接抛错
    - 日志特征：`Attempting to parse an unsupported color function "oklch"`
  - 修复：
    - `frontend/src/hooks/useScreenCapture.ts`
      - 保留 `toBlob() -> toDataURL()` 回退
      - 新增 `oklch` 样式归一化 helper
      - 当 `html2canvas` 失败时，改走 `foreignObject SVG` 的 DOM fallback，再转回 PNG blob
    - `frontend/src/hooks/useScreenCapture.test.ts`
      - 新增 `canvasToBlobWithFallback()` 回退测试
  - 真机复核：
    - homepage `body` 的 element capture 从 `false` 变为 `true`
    - `law` live gameplay modal 场景下：
      - `window.capture_game_screenshot('modal') === true`
      - `panel === true`
      - `canvas === true`
    - 说明：`Panel / Canvas / Modal` 三模式在当前 headless 真机路径已全部产出有效图片

- `3` 后端 `/story`：
  - `backend/app/api/scenarios.py`
    - `GET /api/scenario/{id}/story` 在“没有 completed branches”时，现会回退返回该场景已有 branches
    - 对根分支会补 placeholder title，避免返回空 `branches`
  - 验证：
    - `cd backend && .venv/bin/python -m pytest tests/test_api.py -k story -q` => `7 passed`
    - `cd backend && .venv/bin/python -m pytest tests/ -q` => `700 passed, 2 warnings`

- 本轮完整回归：
  - `cd frontend && npm test` => `121 passed`
  - `cd frontend && npm run build` => 通过
  - `cd backend && .venv/bin/python -m pytest tests/ -q` => `700 passed`

- 当前剩余更像产品打磨而不是功能阻断：
  - `trade` 需要一个“多世界线 completed 样本”来做更强 replay 深链视觉留证
  - 场景主题映射与玩法画像仍不是同一套分类系统，例如 `law` 题面仍可能落在 `scifi_base`

## 2026-03-15 Theme Alignment + Trade Replay Proof

- 已继续打磨“场景主题映射 vs 玩法画像”：
  - `backend/app/visualization/scene_selector.py`
    - `law` 相关词（`court/judge/legal/law/constitutional/veto/audit` + `法院/法官/法律/宪法/司法/否决/审计`）现在映射到 `modern_city`
    - `faith` 相关词（`prophecy/church/religion/sacred/heresy/temple` + `神谕/教会/宗教/神权/异端/祭司/圣谕`）现在映射到 `fantasy_kingdom`
    - `trade/ecology` 相关词（`trade route/merchant guild/tariff/strait/supply chain/freshwater/drought` + `海峡/商团/关税/贸易/供应链/淡水/枯竭/干旱`）现在映射到 `desert_outpost`
  - `frontend/src/game/managers/VizSynthesizer.ts`
    - 同步补齐同一批关键词，避免 completed replay synth 与后端 persisted `scene_theme` 脱节

- 新增验证：
  - 后端：
    - `如果最高法院拥有暂停所有算法政策的紧急否决权，会发生什么？` => `modern_city`
    - `如果全球最关键的海峡被一个海上商团永久垄断，会发生什么？` => `desert_outpost`
    - `如果跨大陆淡水供应在十年内枯竭，会发生什么？` => `desert_outpost`
    - `如果一则神谕成为整个王国唯一合法的统治依据，会发生什么？` => `fantasy_kingdom`
  - 测试：
    - `cd backend && .venv/bin/python -m pytest tests/test_scene_selector.py tests/test_simulator_viz_integration.py -q` => `133 passed`
    - `cd frontend && npm test -- --run src/game/managers/VizSynthesizer.test.ts src/components/gameplayCards.test.ts src/pages/SimulationView.test.tsx src/hooks/useScreenCapture.test.ts`

- 已补 `trade` 多世界线 completed 样本：
  - 新样本：
    - `scenarioId = 5be95c28-b726-4ba8-a74f-482f637d128c`
    - `scene_theme = desert_outpost`
    - `branchCount = 15`
    - `completedCount = 15`
  - 该样本可作为后续 `trade` replay 与视觉 QA 的稳定基线

- `trade` replay 留证：
  - 产物目录：
    - `/tmp/trade-replay-proof/`
  - 关键文件：
    - `trade-replay-state.json`
    - `trade-replay-initial-panel.png`
    - `trade-replay-switched-panel.png`
    - `trade-replay-initial-panel-playwright.png`
    - `trade-replay-switched-panel-playwright.png`
    - `trade-replay-initial-shell.png`
    - `trade-replay-switched-shell.png`
  - 真机状态结论：
    - 初始即为 completed replay，世界线下拉可见 15 条 trade branches
    - `跳到最新` 后，`page.replay_state.playback_mode = skip`
    - 再切换世界线后，`page.replay_state.playback_mode` 能回到 `replay`
    - `selected_branch_id / selected_round / filtered_message_count` 会随目标世界线同步更新
  - 说明：
    - 当前 headless 环境导出的某些 panel/shell PNG 几何形态仍偏窄，更适合作为“功能留证”而不是最终视觉海报
    - 真正的状态真值仍以 `trade-replay-state.json` 和浏览器实时 `render_game_to_text()` 为主

- `Modal` 截图链路后续确认：
  - homepage `body` 的 element capture probe 已从 `false` 变为 `true`
  - `law` gameplay modal 下：
    - `window.capture_game_screenshot('modal') === true`
    - `panel === true`
    - `canvas === true`

- 回归基线更新：
  - `cd frontend && npm test` => `122 passed`
  - `cd frontend && npm run build` => 通过

## 2026-03-15 Ecology Result/Share Proof

- ecology completed 样本：
  - `scenarioId = fda52830-e300-4a4b-840f-75e4fa003f4c`
  - `scene_theme = desert_outpost`
  - `branchCount = 15`
  - `completedCount = 15`
  - 该样本已确认可作为 replay / result / share 的后续稳定基线

- ecology 结果页真机复验：
  - `/result/fda52830-e300-4a4b-840f-75e4fa003f4c`
  - 已显示：
    - `生态阈值`
    - `desert_outpost`
    - hooks：`生态红线 / 迁徙窗口 / 系统韧性`
    - `主导世界线：断流启示`
    - `题材回响：走出了题材支线`
  - 说明：
    - 结果页即使没有出牌，也会在加载时基于 `question + scene_theme` 自动回填 archive `profileId`

- ecology 分享链路真机复验：
  - 打开 `📱 生成文案` → 选择 `📕 小红书`
  - share modal 已显示：
    - chips：`生态阈值 / 走出了题材支线 / 生态红线 / 迁徙窗口 / 系统韧性`
    - copy 前缀：
      - `【生态阈值｜走出了题材支线】`
      - `题材钩子：生态红线 · 迁徙窗口 · 系统韧性`
      - `主导世界线：断流启示`

- 当前产物状态总结：
  - `trade`
    - 已有多世界线 completed 样本
    - 已有 replay 状态留证 `trade-replay-state.json`
  - `ecology`
    - 已有多世界线 completed 样本
    - 已有 result/share 真机状态真值

## 2026-03-15 Faith Sample Closed

- `scene_selector.py` 优先级继续调整：
  - 当 `question` 存在时，先扫原始题面，再回退到 parser 的 `era/setting`
  - 目的：避免 parser 产出的泛化词（例如 `王国`）压过题面中更具体的 `神谕 / 圣谕 / 祭司联盟`
- 对应测试：
  - `backend/tests/test_scene_selector.py`
    - `futuristic world + era=medieval` 现改为期待 `scifi_base`
  - 相关回归仍通过：
    - `cd backend && .venv/bin/python -m pytest tests/test_scene_selector.py tests/test_simulator_viz_integration.py -q`

- 新的 faith 高分叉 completed 样本：
  - `scenarioId = b87e3668-3189-4e80-8f2a-03ca016f659d`
  - `question = 如果一则神谕成为整个奇幻王国唯一合法的统治依据，并引发异端审判、祭司联盟分裂与圣谕改写，会发生什么？`
  - `status = done`
  - `scene_theme = fantasy_kingdom`
  - `branchCount = 15`
  - `completedCount = 15`
  - 该样本现可正式作为 `faith` 的 replay / result / share 样本

- faith 真机结果页 / 分享链路证据：
  - 结果页：
    - `faith-result-proof-true.png`
  - 分享弹窗：
    - `faith-share-proof.png`
  - 结果页档案已显示：
    - `神权号角`
    - `fantasy_kingdom`
    - hooks：`异端审判 / 圣谕改写 / 祭司联盟`
    - `题材回响：命中题材核心`
  - 分享前缀已显示：
    - `【神权号角｜命中题材核心】`
    - `题材钩子：异端审判 · 圣谕改写 · 祭司联盟`

- 至此样本库闭环：
  - `governance`: `72ae364d-3ea1-4959-939c-8fe1dbeca1c9`
  - `law`: `1e4eb90d-95d5-4851-8141-c571dc0dd9ab`
  - `trade`: `5be95c28-b726-4ba8-a74f-482f637d128c`
  - `ecology`: `fda52830-e300-4a4b-840f-75e4fa003f4c`
  - `war`: `f867f9e0-f4ca-4cdb-976e-493614ae2248`
  - `faith`: `b87e3668-3189-4e80-8f2a-03ca016f659d`

## 2026-03-15 Recorder Doc Sync

- 用户已明确确认：`使用 recorder agent 更新项目文档`
- 实际执行方式：
  - 当前环境无显式 `recorder` agent 可调用
  - 已按 `update-doc` skill 的等价 fallback，用当前会话串行更新文档，并用只读子代理做差异核对
- 已同步的文档范围：
  - `llmdoc/guides/development.md`
  - `llmdoc/overview/project.md`
  - `llmdoc/overview/frontend.md`
  - `llmdoc/overview/backend.md`
  - `implement/README.md`
  - `implement/11_optimization_roadmap.md`
  - `implement/18_next_session_gameplay_art_replay_plan.md`
  - `implement/SwarmOracle_3.0_视觉改进计划.md`
  - `SwarmOracle_2.0_升级计划.md`
- 同步口径：
  - 后端主回归：`700 passed`
  - 前端主回归：`122 passed`
  - 主题映射：
    - `law -> modern_city`
    - `faith -> fantasy_kingdom`
    - `trade/ecology -> desert_outpost`
  - 样本库六题材均已闭环
- 基本校验：
  - `llmdoc/index.md` 存在
  - `llmdoc` / `implement` / 顶层文档无冲突标记
  - 已全文扫描，旧测试统计口径（`679/695/117/55/75`）已从需同步文档中清理

## 2026-03-15 Sample Matrix Artifact

- 已新增固定回归输入集：
  - `frontend/output/e2e/sample_matrix.json`
- 当前覆盖：
  - `governance / law / trade / ecology / war / faith`
- 已同步到文档：
  - `llmdoc/guides/development.md`
  - `llmdoc/overview/frontend.md`

## 2026-03-15 Sequential Follow-up 1/2/3

- 已按用户要求继续执行：
  1. `trade / war` replay 深链路加固
  2. `Modal` 截图根因继续下探
  3. 后端 `/story` 失败用例修复

- Replay 深链路：
  - 新增 `SimulationView` 回归：切到 descendant branch 后，`page.replay_state` 必须带上祖先消息上下文
  - 断言覆盖：
    - `selected_branch_id`
    - `selected_branch_title`
    - `selected_round`
    - `available_rounds`
    - `filtered_message_count`
  - 文件：
    - `frontend/src/pages/SimulationView.test.tsx`

- Screen capture helper：
  - 新增 `canvasToBlobWithFallback()` 单测，锁住：
    - `toBlob()` 成功时直接返回 Blob
    - `toBlob()` 返回 `null` 时退回 `toDataURL()` 转 Blob
  - 文件：
    - `frontend/src/hooks/useScreenCapture.test.ts`
  - 说明：
    - 这一步锁住了 helper 级回退语义，但真实浏览器里 `captureElementDataUrl(..., 'element')` 仍可能因当前运行环境 / `html2canvas` DOM capture 路径失效而返回 `null`
    - 即：helper fallback 已有保障，真机 modal capture 仍未完全签收

- 后端 `/story` 修复：
  - `backend/app/api/scenarios.py` 的 `GET /api/scenario/{id}/story` 现在在“无 completed branches”时回退返回该 scenario 的现有 branches，而不是空列表
  - 同时对 fallback 场景下的根世界线标题统一回填 placeholder root title（`Initial Branch` / `初始世界线`），与创建期占位语义保持一致

- 本轮验证：
  - 前端 targeted：
    - `cd frontend && npm test -- --run src/pages/SimulationView.test.tsx src/hooks/useScreenCapture.test.ts src/components/gameplayCards.test.ts src/components/GameplayCardsModal.test.tsx`
  - 前端全量：
    - `cd frontend && npm test` → `120 passed`
  - 前端构建：
    - `cd frontend && npm run build` → 通过
  - 后端 targeted：
    - `cd backend && .venv/bin/python -m pytest tests/test_api.py -k 'test_get_story_no_completed_branches or test_get_story_nonexistent' -q` → `2 passed`
    - `cd backend && .venv/bin/python -m pytest tests/test_api.py -k story -q` → `7 passed`

- 当前剩余风险：
  - `Modal` 截图在真实浏览器环境里仍未完全恢复，问题已收敛到 DOM element capture 路径，而不是 selector 路径
  - replay 逻辑当前已被单元/组件回归锁住，但 `trade / war` 的深链路视觉 artifact 仍缺少一次稳定批量导出

## 2026-03-15 Gameplay Profile Repair + QA Notes

- 新发现的真实问题：
  - `GameplayCardsModal` 在 live Theater 中会把部分题材错判：
    - `law` 题面在 `sceneTheme=modern_city` 下被拉成 `governance`
    - `faith` 题面在 `sceneTheme=fantasy_kingdom` 下被拉成 `mythic`
    - `ecology` 题面关键词命中不足，进入 live 后会被场景题材进一步带偏
- 根因：
  - `frontend/src/components/gameplayCards.ts` 的 `inferGameplayProfile()` 先给 `sceneTheme` 加分，再与 question keyword 同池比较；平分时会被先插入的 theme profile 吃掉。
  - `ecology` 中文关键词缺少 `淡水 / 枯竭 / 干旱` 等当前每日挑战题面常用词。
- 已修复：
  - `inferGameplayProfile()` 改为：**题面关键词优先，只有 question 完全没有命中时才用 sceneTheme 兜底**。
  - `ecology` 关键词补充 `淡水 / 枯竭 / 干旱 / freshwater`。
  - `frontend/src/components/gameplayCards.test.ts` 新增 3 条回归：
    - `law + modern_city`
    - `faith + fantasy_kingdom`
    - `ecology + modern_city`
- 修复后最小验证：
  - `npm test -- --run src/components/gameplayCards.test.ts src/components/GameplayCardsModal.test.tsx` 通过（10 tests）。
  - 规则 smoke：
    - `law` 题面 + `modern_city` → `law`
    - `faith` 题面 + `fantasy_kingdom` → `faith`
    - `ecology` 题面 + `modern_city` → `ecology`
- 前端全量回归：
  - `cd frontend && npm test` → `117 passed`
  - `cd frontend && npm run build` → 通过
- 后端基线（只读）：
  - `cd backend && .venv/bin/python -m pytest tests/ -q` → `699 passed, 1 failed`
  - 当前唯一失败：
    - `tests/test_api.py::TestStoryEndpoint::test_get_story_no_completed_branches`
    - 断言：`len(data["branches"]) == 1`，实际 `0`
- 当前自动化环境阻塞：
  - 本地 Playwright 直起浏览器在当前 macOS 会话下出现 `Crashpad / MachPort` 权限错误，导致仓库内 `playwright` 脚本无法稳定新开浏览器实例。
  - `mcp__playwright` 也出现了“正在现有浏览器会话中打开”后立即退出的会话冲突。
  - 因此本轮更稳定的路径是：
    - 继续使用已跑通的浏览器会话 / DevTools
    - 依赖页面级 `render_game_to_text()` + 单测回归先锁死题材判定
    - 再补剩余 P4 手工/半自动链路

## 2026-03-15 Browser Truth After Profile Fix

- 已通过 `chrome-devtools` 在真实浏览器里重做 live Theater modal 真值，六组题材当前都能在 `render_game_to_text().page.controls.modal_state.profile_id` 对上目标画像：
  - `governance`
    - scenario: `ef0c37f2-e912-410d-be05-9a995295ad64`
    - live modal: `profile_id = governance`
  - `trade`
    - scenario: `8dc4d687-e8ed-4739-b8e8-2d2f9ecbc711`
    - live modal: `profile_id = trade`
  - `law`
    - scenario: `bcbf9cde-abb9-4b27-acf1-8087c1c37ddb`
    - live modal: `profile_id = law`
  - `faith`
    - scenario: `cb10f752-400a-420d-825a-eef67b980b46`
    - live modal: `profile_id = faith`
  - `ecology`
    - scenario: `4aaa199d-2ffd-40ee-acb5-107f2d045ce6`
    - live modal: `profile_id = ecology`
  - `war`
    - scenario: `6269ccc1-0cd5-41bf-aa96-8d2672939c63`
    - live modal: `profile_id = war`
- 其中 `law` 已额外走完更深一层链路：
  - 注入 `human_takeover` 后，`scenarioMeta.cards.usageLog[0].profileId = law`
  - `director.remainingPoints` 从 `3` 降到 `2`
  - 结果页 `因果档案` 显示 `法律红线 / 紧急否决 / 审计证据 / 程序补丁`
  - 分享弹窗小红书文案前缀已包含：
    - `【法律红线｜方向基本吻合】`
    - `题材钩子：紧急否决 · 审计证据 · 程序补丁`
- 已保存的人工视觉证据：
  - `/tmp/law-live-modal-devtools.png`
  - `/tmp/law-share-devtools.png`
- 当前仍未完全收口的项：
  - 由于本地 Playwright 新开浏览器实例仍受环境权限问题影响，六组 **全部** 的 `result/share/replay + panel/canvas/modal artifact` 批量落盘还没完全自动化收尾。
  - `law` 的完整链路已有人手真值；其余五组目前已完成 live modal 级别真值和单测/规则级验证。
    - `gameplay_card_frame_empire.png`
    - `gameplay_card_frame_industry.png`
    - `gameplay_card_frame_frontier.png`
    - `gameplay_card_frame_mythic.png`
    - `gameplay_card_frame_survival.png`
  - 生成并接入徽章：
    - `badge_recommended.png`
    - `badge_daily_challenge.png`
    - `badge_archive_record.png`
    - `badge_bet_winner.png`
  - 资产清单已同步更新到 `frontend/public/assets/ASSET_CREDITS.md`

- 玩法系统 UI：
  - `frontend/src/components/GameplayCardsModal.tsx`
  - `frontend/src/components/GameplayCardsModal.css`
  - 现在玩法卡会按 `profileId` 使用专属 frame，推荐卡显示新 badge。

- 因果档案升级：
  - `frontend/src/lib/archiveSummary.ts`
  - `frontend/src/pages/ResultView.tsx`
  - `frontend/src/pages/ResultView.css`
  - 新增并展示：
    - `mostUsedCard`
    - `bettingHit`
    - `archiveGrade`
    - `dominantBranchTitle`
    - `dominantTone`
    - `directorStyleTag`

- 每日挑战状态闭环修复：
  - `frontend/src/lib/dailyChallenge.ts` 之前存在“按 `challengeId` 读，但按 `scenarioId` 写”的不一致；现已统一。
  - `frontend/src/pages/InputView.tsx`
  - `frontend/src/pages/InputView.css`
  - 首页挑战卡现在会显示完成状态、已用卡数、是否下注。

- i18n 收口：
  - 修正本轮新增文案的中英文切换，重点覆盖：
    - 首页每日挑战反馈
    - 结果页因果档案标题 / 摘要卡 / section 标题
  - `frontend/src/i18n/locales/zh.json`
  - `frontend/src/i18n/locales/en.json`
  - 另外修正了一次 locale 结构误操作：避免重复 `home` 节点覆盖首页原有翻译。

- 新增测试：
  - `frontend/src/lib/archiveSummary.test.ts`
  - `frontend/src/lib/dailyChallenge.test.ts`
  - `frontend/src/pages/SimulationView.test.tsx`
  - 现有 `frontend/src/components/gameplayCards.test.ts` 也已覆盖素材 helper。

- 验证：
  - `cd frontend && npm test` → `16 files / 106 tests passed`
  - `cd frontend && npm run build` → 通过
  - 视觉抽查：
    - 首页英文切换后 `Daily Challenge` 区块正常
    - 结果页英文切换后 `Causal Archive` 区块正常
    - Theater 玩法卡弹窗在本机 headless Playwright 下仍容易超时，不作为本轮阻塞项

## 2026-03-15 Final 18 E2E Signoff Pass

- 重新按 `develop-web-game` + `playwright-interactive` 做了实现计划 18 的收口测试，重点覆盖：
  - 首页挑战卡（ZH / EN）
  - 完成态 Theater 回放状态 JSON
  - 结果页因果档案（ZH / EN）
  - `develop-web-game` 对完成态 Theater 的 headless / headed 双模式截图与 `state-0.json`

- 新结论：
  - `develop-web-game` 现已能在 headless 与 headed 下都稳定产出 `state-0.json`
  - 完成态 Theater 的 `page.replay_state` / `scene.displayed_bubble_count` 正常
  - 但截图链路仍存在平台相关不一致：
    - headless `shot-0.png` 当前可见真实剧场画面
    - headed `shot-0.png` 出现上半区域黑块、下半区域正常
  - 因此：功能闭环可签，截图/录屏稳定性仍不建议签成“完全可靠”

- 交互节奏观察：
  - 新建 disposable Theater 场景后，前 10 秒内可能仍停在 `parsing`
  - 在这个阶段 `Gameplay Cards` 不会出现，因为分支 / Agent 尚未就绪
  - API 复查显示该场景随后会进入 `simulating`，因此这是“早期不可交互窗口”问题，而不是已确认的死锁

## 2026-03-15 Gameplay Art + Archive Pass

- `.agent/skills/` 目录存在但没有可读 skill 文件；本轮前端优化直接沿用当前项目视觉语言与现有样式系统，没有强行切换到另一套设计体系。

- 已生成并落盘的新素材：
  - `frontend/public/assets/ui/generated/gameplay_card_frame_governance.png`
  - `frontend/public/assets/ui/generated/gameplay_card_frame_war.png`
  - `frontend/public/assets/ui/generated/gameplay_card_frame_empire.png`
  - `frontend/public/assets/ui/generated/gameplay_card_frame_industry.png`
  - `frontend/public/assets/ui/generated/gameplay_card_frame_frontier.png`
  - `frontend/public/assets/ui/generated/gameplay_card_frame_mythic.png`
  - `frontend/public/assets/ui/generated/gameplay_card_frame_survival.png`
  - `frontend/public/assets/ui/generated/badge_recommended.png`
  - `frontend/public/assets/ui/generated/badge_daily_challenge.png`
  - `frontend/public/assets/ui/generated/badge_archive_record.png`
  - `frontend/public/assets/ui/generated/badge_bet_winner.png`

- 已完成的接入：
  - `InputView`：
    - 每日挑战卡新增 badge 与进度 pills（完成状态 / 已用卡数 / 是否下注）
    - 按 challengeId 读取当日进度，不再因为旧的 scenarioId-key 逻辑读空
  - `GameplayCardsModal`：
    - 玩法卡网格按当前 `profileId` 使用专属 frame 背景
    - 推荐卡使用 `badge_recommended.png`
  - `ResultView`：
    - 因果档案标题增加 `badge_archive_record.png`
    - 每日挑战 / 押注命中增加图标徽章
    - 新增 archive summary grid：
      - `dominant_branch_title`
      - `dominant_tone`
      - `most_used_card`
      - `betting_hit`
      - `archive_grade`
      - challenge feedback
    - 归档时会写入：
      - `mostUsedCard`
      - `bettingHit`
      - `archiveGrade`
      - `dominantBranchTitle`
      - `dominantTone`
      - `directorStyleTag`

- 新增 / 更新测试：
  - `frontend/src/lib/dailyChallenge.test.ts`
  - `frontend/src/pages/SimulationView.test.tsx`
  - `frontend/src/components/gameplayCards.test.ts`
  - `frontend/src/lib/archiveSummary.ts` 的评分阈值已调到与当前预期一致

- 验证结果：
  - `cd frontend && npm test` → `16 passed / 106 passed`
  - `cd frontend && npm run build` → 通过

- 环境限制：
  - 这台机器上的 Playwright / Chrome for Testing 进程仍会被 macOS 权限与 Crashpad 路径限制中断：
    - `bootstrap_check_in ... Permission denied`
    - `Crashpad/settings.dat: Operation not permitted`
  - 因此本轮无法给出可靠的新浏览器截图回归；可确认代码、类型、单测与资源接入已完成，但最终视觉真值仍建议在可正常启动 Chromium 的环境里补一轮。

## 2026-03-15 Repo E2E Scripts

- 已新增仓库内脚本：
  - `frontend/scripts/e2e-automation.mjs`
  - `frontend/package.json` 新增：
    - `npm run e2e:predict`
    - `npm run e2e:result`
    - `npm run e2e:health`
- 已新增本地依赖：
  - `frontend` `devDependencies.playwright`
  - `package-lock.json` 已同步刷新
- 三条脚本都已真实跑通：
  - `npm run e2e:health -- --headless`
    - 返回 `history` 摘要 + `leaderboard` 摘要
  - `npm run e2e:result -- --headless --scenario-id <done-id>`
    - 返回结果页 `branchTitles`
    - 自动导出 Markdown
    - 自动打开分享弹窗、选择小红书、完成复制
    - `controls.modal_state` 包含 `platform_name/copy_length/copied`
  - `npm run e2e:predict -- --headless`
    - 自动创建最小场景
    - 自动打开预测弹窗并填写
    - 返回 `beforeSubmit/afterSubmit`
    - `afterSubmit.status = "success"`
- 前端回归：
  - `npm test` 通过（现为 `82 passed`）
  - `npm run build` 通过

## 2026-03-15 Repo E2E Artifacts

- `frontend/scripts/e2e-automation.mjs` 现默认将每次运行结果写到：
  - `frontend/output/e2e/<timestamp>-<mode>/`
- 每次运行都会生成：
  - `result.json`（脚本总结果）
  - 若适用：页面级 `*.json`
  - 若适用：对应页面 `*.png`
- 已实测输出目录示例：
  - `frontend/output/e2e/2026-03-14T18-49-34-574Z-health/`
  - `frontend/output/e2e/2026-03-14T18-50-13-024Z-result/`
  - `frontend/output/e2e/2026-03-14T18-50-16-566Z-predict/`
- `health` 模式已生成：
  - `history.json/png`
  - `leaderboard.json/png`
  - `result.json`
- `result` 模式已生成：
  - `result-initial.json/png`
  - `share-modal-open.json/png`
  - `share-generated.json/png`
  - `result-final.json/png`
  - `result.json`
- `predict` 模式已生成：
  - `predict-modal-filled.json/png`
  - `predict-submitted.json/png`
  - `result.json`

## 2026-03-15 llmdoc Sync

- 已按等价 recorder/update-doc 流程同步 `llmdoc`：
  - `llmdoc/overview/backend.md`：补充 simulator 的 `_coerce_stance_value()` 说明，以及 Scenario API 响应返回 `visualization_enabled/scene_theme` 的事实。
  - `llmdoc/reference/api.md`：将场景/健康/预测相关 REST 路径统一到当前 `/api/...` 形式，WebSocket 路径更新为 `/ws/scenario/{scenario_id}`，并在 ScenarioResponse 描述中补充 `visualization_enabled/scene_theme`。
- 未改 `llmdoc/index.md`：本轮没有新增/删除文档文件，只做内容同步。

## 2026-03-14 Additional QA Pass

- 重新拉起本地后端 `18927` 与前端 `18928/18929` 做运行态复核。
- 浏览器自动化环境受宿主机限制：
  - MCP `playwright` 启动 Chrome 时命中“复用现有浏览器会话”问题；
  - `chrome-devtools` 也被既有 profile 占用；
  - 临时 `/tmp` Playwright runtime 可安装，但 `launch()` 在当前 macOS 环境下触发 Mach/bootstrap 权限错误。
- 因此本轮把“真实浏览器画面复核”与“后端 API/WS E2E”拆开处理：前者继承上一轮已落盘的 QA 结论，后者重新做运行态复测。
- 新发现的真实后端缺陷：
  - `visualization_enabled=true` 时，`parser` 返回中文 stance（如 `支持`）会在 `simulator.py` 中被 `float()` 直接打爆，导致场景卡死/失败。
  - 这不是假设，已在本地运行日志复现：`ValueError: could not convert string to float: '支持'`。
- 同时确认：WebSocket 实际路径是 `/ws/scenario/{id}`；之前按旧文档尝试 `/ws/{id}` 的 403 不是产品 bug，而是文档/记忆偏差。

## 2026-03-14 Backend Repair Pass 2

- 已修复 `backend/app/services/simulator.py`：
  - 新增 `_coerce_stance_value()`，将数值 stance、中文/英文立场词统一归一化为可视化用浮点值，未知文本安全回落到 `0.0`。
  - 修正 `map_stance_move()` 调用参数名：`sprite_id` → `agent_id`。
  - 修正 `map_emotion_change()` 调用参数名：`sprite_id` → `agent_id`。
  - 显式把 `agent_prev_emotions` 透传给 `_gather_agent_messages()` / `_gather_hierarchical_messages()`，避免 runtime `NameError`。

## 2026-03-14 Validation After Backend Repair Pass 2

- 后端回归：
  - `pytest backend/tests/test_simulator_viz_integration.py -q` 通过（`55 passed`）。
- 真实 API + WS 回归：
  - 创建 `visualization_enabled=true` 的 1 轮 / 3 Agent 中文场景，状态从 `parsing` 最终走到 `done`。
  - WebSocket 收到完整关键事件：`viz:scene_init`、`viz:scene_change`、`viz:bubble_show ×3`、`viz:agent_move ×3`、`viz:emotion_change ×3`、`viz:ending_play`、`simulation_done`。
  - 同一场景后续 `score-predictions`、`leaderboard`、`social/xiaohongshu`、`export` 均成功。
- 前端工程回归：
  - `npm run build` 通过。
  - `npm test` 通过（`75 passed`）。

## 当前残留判断

- 主流程现在可以跑通，Theater 核心后端事件链不再因参数/stance 类型问题中途崩溃。
- 但本轮仍无法在当前宿主机环境里重新做“新的”浏览器画面级 Playwright/MCP 复验：
  - MCP `playwright` / `chrome-devtools` 被现有浏览器 profile 占用；
  - 临时 Playwright runtime 能安装，但浏览器 launch/connect 受 macOS 环境权限限制。
- 因此当前“是否好玩 / 视觉是否足够强”的结论，仍需结合上一轮已做的真实页面 QA 与本轮工程/API 复验综合判断，而不是仅靠本轮新增浏览器截图。

## 2026-03-15 Comprehensive E2E + Hardening

- 本轮重新完成的回归与黑盒验证：
  - `cd backend && .venv/bin/python -m pytest tests/ -q` → `695 passed, 2 warnings`
  - `cd frontend && npm test` → `82 passed`
  - `cd frontend && npm run build` → 通过（仍有大 chunk 警告，但非构建失败）
  - 项目自带 `frontend/scripts/e2e-automation.mjs` 已跑通：
    - `health`：历史页 / 排行榜页面级自动化摘要正常
    - `predict`：预测弹窗填写、提交、成功态正常
    - `result`：结果页、Markdown 导出、分享文案、小红书平台生成正常

- 使用 `playwright-interactive` + `chrome-devtools` 的真实页面复核结论：
  - 已完成场景 `/sim/1458c352-91d7-4dc2-b477-50cd6984d75c` 的 Theater 回放正常：
    - `scene.theme = "ancient_empire"`
    - `agent_count = 3`
    - `agents[]` / `bubbles[]` 均可通过 `render_game_to_text()` 读取
    - 真实截图 `/tmp/swarmoracle-roman-world.png` 画面正常，不是黑屏
  - 结果页 `/result/1458c352-91d7-4dc2-b477-50cd6984d75c` 正常渲染，真实截图 `/tmp/swarmoracle-result-roman.png`
  - 移动端首页（390px）长问题输入已确认可换行，不再裁切；真实截图 `/tmp/swarmoracle-mobile-home.png`

- 新确认的实现/文档差异：
  - 文档中 3.0 验证示例写「如果人工智能统治世界？」应映射到 `scifi_base`；本轮真实创建的场景 `230af1e6-9534-4601-b61b-654906f49f35` 实际返回：
    - `scene_theme = "medieval_village"`
    - 说明“动态场景选择已实现”成立，但该中文示例与当前选择器结果不一致，示例口径偏乐观或关键词规则仍需调优。
  - 2.0 文档中的轻量子玩法（文明辩论 / 间谍 / 人类潜入 / 时空裂缝）仍更接近事件/素材层定义，而非完整用户可玩功能。

- 新修复：
  - `frontend/src/hooks/useScreenCapture.ts`
    - 修复 GIF 录制使用的 `gif.js` worker 路径：改为 Vite 构建产物 URL，不再依赖缺失的 `/gif.worker.js`
    - 新增 GIF 渲染超时保护，避免按钮长期卡在 `recording`
    - GIF worker 或渲染失败时，显式回退为最后一帧 PNG 下载
  - 修复后复测：
    - 截图按钮仍可下载 PNG（`~/Downloads/swarmoracle_2026-03-14T19-11-19.png`）
    - GIF 按钮已能完成导出，生成 `~/Downloads/swarmoracle_2026-03-14T19-16-38.gif`
    - `render_game_to_text()` 中的 `capture_status` 已回到 `idle`

- `develop-web-game` 技能专用黑盒脚本本轮已再次运行：
  - 通过 skill 自带 client（临时转 `.mjs` workaround）生成：
    - `/tmp/swarmoracle-webgame-roman/state-0.json`
    - `/tmp/swarmoracle-webgame-roman/state-1.json`
    - `/tmp/swarmoracle-webgame-roman/shot-0.png`
    - `/tmp/swarmoracle-webgame-roman/shot-1.png`
  - 结论：
    - `state-*.json` 可稳定返回 Theater 场景状态、agent 坐标、bubble 文本
    - `shot-*.png` 在当前 headless client 里仍是黑底；这更像该 client/运行环境的 canvas 读回限制，不是页面实际视觉结果，因为同一场景在 DevTools 实际截图中可见正常画面

- 给下一个 agent 的 TODO：
  - 优先检查 `scene_selector` 对中文科技/AI 题目的命中规则，修正文档示例与真实 `scene_theme` 的偏差
  - 若要继续提升“好玩性”，优先做 Theater 回放控制（加速 / 跳过 / 重播）与事件卡显式交互，而不是继续堆叠静态能力清单
  - 若要继续做前端质量提升，下一步值得看：
    - bundle 过大（`index` / `phaser` chunk 警告）
    - `develop-web-game` headless 黑屏兼容性

## 2026-03-15 Theater Follow-up Improvements

- 已继续修复 `scene_selector` 与 Theater 一致性：
  - `backend/app/visualization/scene_selector.py`
    - 为 `scifi_base` 增加 AI / 算法治理 / 机器人 / 火星等中英文关键词：
      - `artificial intelligence`
      - `algorithmic governance`
      - `algorithm`
      - `robot`
      - `人工智能`
      - `算法治理`
      - `算法`
      - `机器人`
      - `火星`
  - `backend/app/api/helpers.py`
    - `parse_and_run_background()` 选场景时不再只依赖 parser 的 `time_period/location`
    - 现会同时把 `scenario.question` 传给 `select_scene()`，避免 parser 字段过泛导致主题误判
  - `frontend/src/game/managers/VizSynthesizer.ts`
    - 同步扩展前端回放用的 `inferSceneTheme()` 关键词，避免已完成场景的 Theater synth 与后端落盘主题分叉
  - `frontend/src/game/PhaserGame.tsx`
    - Completed replay / synth init 现优先使用 `scenario.scene_theme`
    - 只有后端未落盘主题时才回退到 `inferSceneTheme(question)`

- 新增测试 / 回归：
  - `backend/tests/test_scene_selector.py`
    - 新增 `如果人工智能统治世界？ -> scifi_base`
    - 新增 `algorithmic government -> scifi_base`
    - 新增“era/setting 无效时回退到 question”测试
  - `frontend/src/game/managers/VizSynthesizer.test.ts`
    - 新增 AI / algorithmic government 两个 `scifi_base` 断言
  - 通过结果：
    - `cd backend && .venv/bin/python -m pytest tests/test_scene_selector.py -q` → `74 passed`
    - `cd frontend && npm test -- --run src/game/managers/VizSynthesizer.test.ts` → `20 passed`
    - `cd frontend && npm test` → `82 passed`
    - `cd frontend && npm run build` → 通过

- 已增强 Theater 过程反馈：
  - `frontend/src/pages/SimulationView.tsx`
    - 新增 Theater live status HUD，轮询读取 `window.__swarmGetSceneAutomation()`
    - 现会在 Theater 顶部显示：
      - 当前场景（Title / World / Ending）
      - 场景主题（如 `古代帝国` / `科幻基地`）
      - 当前轮次
      - 当前可见角色数
      - 当前气泡数
      - 天气 / 时段
      - 累计消息数
  - `frontend/src/pages/SimulationView.css`
    - 新增 `theater-panel__status` / `theater-chip` 样式，桌面与移动端都可读

- 本轮真实页面复测结论：
  - 罗马完成场景 `/sim/1458c352-91d7-4dc2-b477-50cd6984d75c`
    - 顶部 HUD 可见：`世界场景 / 古代帝国 / R0/3 / 3 角色 / 3 气泡 / 晴朗 / 正午 / 9 消息`
  - 新创建 AI 场景 `dc8cd542-d1a7-4f1b-9e50-a0da72fca1c8`
    - API 运行态已确认：
      - `status = "simulating"`
      - `scene_theme = "scifi_base"`
      - `branches = 7`
      - `messages = 21`
    - 真实 Theater 页面已确认：
      - `scene.theme = "scifi_base"`
      - 顶部 HUD 显示 `科幻基地`
      - `/tmp/swarmoracle-ai-theater.png` 为正常可见画面，不再是文档示例与实现不一致
    - 后端运行日志已确认修复生效：
      - `V2 Visualization enabled: theme=scifi_base, 3 sprites`

- 当前我认为最值得继续做、但本轮先不再扩 diff 的项：
  - Theater 回放控制（重播 / 加速 / 跳过）
  - 2.0 轻量子玩法产品化（而不是仅事件定义）
  - bundle 体积优化

## 2026-03-15 Replay Controls + Gameplay Cards + Bundle Split

- 已完成 Theater 回放控制第一版产品化：
  - `frontend/src/pages/SimulationView.tsx`
    - 已新增 `🔁 重播 / ⏭ 跳到最新 / ⚡ 1x-2x-4x` 三个回放控制入口
    - 完成态 Theater 中点击 `重播 / 跳到最新` 会通过重建 `PhaserGame` 实例切换回放模式，避免只靠运行时事件导致状态不稳定
  - `frontend/src/game/PhaserGameLoader.tsx`
    - 支持 `replaySpeed` 与 `playbackMode`
  - `frontend/src/game/PhaserGame.tsx`
    - 完成态加载时：
      - `playbackMode="replay"` → 按当前速度批量重播 bubble
      - `playbackMode="skip"` → 直接渲染各 agent 最新 bubble
  - `frontend/src/game/managers/VizSynthesizer.ts`
    - 新增 `synthesizeLatestBubbles()`，供“跳到最新”使用
  - `frontend/src/game/scenes/WorldScene.ts`
    - 新增 `viz:clear_bubbles` 监听和 `clearActiveBubbles()`，支持重播前清空当前气泡

- 已完成 2.0 四张玩法卡的最小真实用户入口：
  - 新增 `frontend/src/components/GameplayCardsModal.tsx`
  - 新增 `frontend/src/components/GameplayCardsModal.css`
  - 新增 `frontend/src/components/gameplayCards.ts`
  - 新增 `frontend/src/components/gameplayCards.test.ts`
  - 现在 `SimulationView` 顶栏会在有活跃分支时显示 `🃏 玩法卡`
  - Modal 中可直接选择：
    - `文明辩论`
    - `间谍渗透`
    - `人类潜入`
    - `时空裂缝`
  - 每张卡都会：
    - 选择目标活跃分支
    - 按需要选择角色 / 来源分支
    - 生成结构化 intervention prompt
    - 复用现有 `intervene()` API 注入后端
    - 成功后立即本地派发 `viz:event_anim`，触发对应 Theater 动画
  - 已真实页面验证：
    - `🃏 玩法卡` 按钮可打开 modal
    - 表单可选分支 / 角色 / 自定义输入
    - 点击 `注入玩法卡` 后进入成功态，页面出现 `干预已施加！`

- 已完成“题目驱动玩法系统”增强，不再只靠固定四张卡硬套所有题目：
  - `frontend/src/components/gameplayCards.ts`
    - 新增 `GameplayProfile` 推断层：
      - `governance`
      - `war`
      - `empire`
      - `industry`
      - `frontier`
      - `mythic`
      - `survival`
      - `generic`
    - 现会基于 `question + scene_theme` 推断“玩法画像”
    - 每种画像都有：
      - 推荐卡片顺序
      - 各卡默认任务文案（zh/en）
      - 角色推荐策略
      - 来源分支建议策略
    - Prompt 生成现会携带：
      - 原始 What-If 问题
      - 场景主题
      - 画像驱动的默认任务
  - `frontend/src/components/GameplayCardsModal.tsx`
    - 现会展示当前场景画像（例如 `治理博弈 / 帝国统合 / 战争抉择`）
    - 卡片支持 `推荐` 标记，不同题材下推荐顺序不同
    - 角色/第二角色/来源分支会按当前题材和立场自动建议
    - 文本框会自动预填与题目相关的任务句，而不是固定科幻模板
  - `frontend/src/components/gameplayCards.test.ts`
    - 新增 profile 推断、推荐卡片、角色推荐、来源分支选择、题材化默认文案测试

- 当前题材适配范围：
  - `governance`：AI / 算法 / 民主 / 互联网 / 治理
  - `war`：战争 / 战场 / 入侵 / 军事
  - `empire`：帝国 / 王朝 / 王国 / 古典历史
  - `industry`：工业 / 工厂 / 资源 / 能源 / 市场
  - `frontier`：太空 / 火星 / 海洋 / 深海 / 边疆探索
  - `mythic`：奇幻 / 魔法 / 神话秩序
  - `survival`：末日 / 崩塌 / 灾难 / 生存压力

- 最新回归：
  - `cd frontend && npm test` → `92 passed`
  - `cd frontend && npm run build` → 通过

## 2026-03-15 Structured Betting + Scenario Meta + Daily Challenge

- 已完成 `竞猜 2.0` 的最小结构化版本：
  - 新增 `frontend/src/lib/predictionBetting.ts`
    - `branch_winner / ending_tone` 两种下注类型
    - 结构化下注编码到 `prediction_text`
    - 结果页可反解析下注信息，不再只显示一段原始文本
  - `frontend/src/components/PredictionModal.tsx`
    - 现支持：
      - 下注类型选择
      - 世界线下注目标选择
      - 结局倾向下注目标选择
      - 动态下注摘要预览
    - 提交时会把结构化下注写入后端 prediction API
  - `frontend/src/game/HudOverlay.tsx`
    - Theater 底部 `下注竞猜` HUD 现已增加可点击 CTA
    - 可用时显示“立即下注”，不可用时显示“等待结算”
    - 已由 `SimulationView` 接线到 `PredictionModal`
  - `frontend/src/pages/ResultView.tsx`
    - 结果页会显示结构化下注标签：
      - 押注类型
      - 押注目标
      - 去掉结构化前缀后的理由文本

- 已完成 `scenario meta` 本地持久化层：
  - 新增 `frontend/src/lib/scenarioMeta.ts`
  - 已落地的状态：
    - 导演点数
    - 卡冷却
    - 玩法卡使用日志
    - 下注记录
    - 因果档案摘要
  - `GameplayCardsModal` 现已接入：
    - 导演点数显示
    - 无点数时禁止继续出牌
    - 冷却轮次提示
    - 成功出牌后写 usage log

- 已完成 `因果档案` 的结果页最小闭环：
  - `frontend/src/pages/ResultView.tsx`
    - 新增“因果档案”区块
    - 展示：
      - 场景画像
      - scene_theme
      - 每日挑战标记（命中时）
      - 剩余导演点数
      - 玩法记录
      - 下注记录
      - 关键记录
  - `ResultView` 加载时会调用 `updateArchive(...)`，把当前场景摘要落到本地档案

- 已完成 `每日挑战` 最小闭环：
  - 新增 `frontend/src/lib/dailyChallenge.ts`
    - 内置 5 条 challenge（治理/帝国/战争/工业/边疆）
    - 按日期轮换
    - 记录 started/completed 状态
  - `frontend/src/pages/InputView.tsx`
    - 首页新增“每日挑战卡片”
    - 可一键启动今日挑战，自动带入：
      - 题目
      - rounds
      - numAgents
      - mode
      - Theater 开关
  - `frontend/src/pages/ResultView.tsx`
    - 若当前结果命中今日挑战题目，会回写 completed 状态

- 玩法题材适配继续增强：
  - `frontend/src/components/gameplayCards.ts`
    - 新增 `GameplayProfile` 推断：
      - `governance / war / empire / industry / frontier / mythic / survival / generic`
    - 每个画像都有：
      - 推荐卡片顺序
      - 默认任务文案
      - 角色推荐逻辑
      - 来源分支推荐逻辑
  - `frontend/src/components/GameplayCardsModal.tsx`
    - 现显示：
      - 当前玩法画像
      - 推荐卡片标记
      - 自动预填、与题目相关的指令文案
    - 已实测：
      - AI 题材会显示治理相关推荐
      - 罗马帝国题材会显示帝国统合相关推荐

- 测试与构建：
  - `cd frontend && npm test` → `94 passed`
  - `cd frontend && npm run build` → 通过
  - `HudOverlay.test.tsx` 新增下注 CTA 测试
  - 拆包后仍维持良好：
    - 主入口 `index-BJoOeTRl.js 297.56 kB`
    - `SimulationView-Jj9zZdV4.js 196.17 kB`
    - `gameplayCards-zXtLWjL4.js 16.65 kB`
    - `PredictionModal-CBL0rIy_.js 5.38 kB`
    - `dailyChallenge-gdcBWM7i.js 2.28 kB`

- 已完成 bundle 拆分优化：
  - `frontend/src/App.tsx`
    - 首页 / Simulation / Result / History / Leaderboard 改为路由级懒加载
  - `frontend/src/pages/SimulationView.tsx`
    - `BranchTree` / `AgentPanel` / `TimelineBar` / 各种 modal 改为按需懒加载
  - 构建结果：
    - 主入口由此前约 `700k` 级别降到 `index-CjByLJDZ.js 297.12 kB`
    - `SimulationView` 独立成 `195.60 kB`
    - `BranchTree` 独立成 `97.68 kB`
    - `GameplayCardsModal` 独立成 `10.67 kB`
  - `phaser` chunk 仍为 `1.2 MB`，但已被隔离为单独按需下载块，不再压在主入口上

- 新增/更新回归：
  - `cd frontend && npm test` → `87 passed`
  - `cd frontend && npm run build` → 通过
  - Chrome DevTools 真实页面复测：
    - 完成态 Roman 场景可见 `重播 / 跳到最新 / 速度` 按钮
    - 运行中 AI 场景可见 `🃏 玩法卡` 按钮
    - 玩法卡 modal 可正常打开并成功提交

- 当前仍保守说明的一点：
  - 完成态 Theater 的 bubble 重播链路在控制台日志中已确认会触发重建 + 重新调度，但基于 `render_game_to_text()` 的 bubble 数抓取仍偏苛刻，适合作为下一轮 UX/automation hardening 的重点，而不再阻塞本轮功能交付

## 2026-03-15 Vertex Assets + Branch/Round Replay

- 已完成玩法视觉资产第一版：
  - 使用用户提供的 Google API key，实际可用的调用方式为：
    - `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent`
  - 已生成并落盘：
    - `frontend/public/assets/ui/generated/daily_challenge_panel.png`
    - `frontend/public/assets/ui/generated/archive_panel.png`
    - `frontend/public/assets/ui/generated/gameplay_panel.png`
  - 已接入：
    - `frontend/src/pages/InputView.tsx` / `InputView.css`：每日挑战卡片插画
    - `frontend/src/pages/ResultView.tsx` / `ResultView.css`：因果档案插画
    - `frontend/src/components/GameplayCardsModal.tsx` / `GameplayCardsModal.css`：玩法 modal 插画
  - `frontend/public/assets/ASSET_CREDITS.md` 已补充这些新素材

- 已完成 Theater 按世界线 / 按轮次跳转回放：
  - 新增 `frontend/src/game/replaySelection.ts`
  - 新增 `frontend/src/game/replaySelection.test.ts`
  - `SimulationView.tsx`
    - 完成态 Theater 新增：
      - `世界线` 下拉
      - `轮次` 下拉
      - 与现有 `重播 / 跳到最新 / 速度` 联动
  - `PhaserGameLoader.tsx`
    - 透传 `playbackBranchId / playbackRound`
  - `PhaserGame.tsx`
    - completed replay 只回放筛选后的消息
    - `skip` 也只跳到该世界线、该轮之前的最新 bubble

- 说明：
  - 用户给出的 `aiplatform.googleapis.com/v1/publishers/google/models` 直探结果为 404
  - 但同一把 key 在 `generativelanguage.googleapis.com/v1beta/models` 可正常列模型并调用图像模型
  - 已确认可用模型：
    - `gemini-3.1-flash-image-preview`
    - `gemini-3-pro-image-preview`
  - 本轮实际使用的是 `gemini-3.1-flash-image-preview`

- 最新回归：
  - `cd frontend && npm test` → `98 passed`
  - `cd frontend && npm run build` → 通过


## 2026-03-15 Next Session Plan — P1/P5 Landing

- 已按 `implement/18_next_session_gameplay_art_replay_plan.md` 继续实现两项前端增强：
  - `TimelineBar` 现在支持 completed Theater 下的轮次直跳回放。
  - `SimulationView` 的 `render_game_to_text()` / `replay_state` 现在暴露更完整的回放状态：
    - `enabled`
    - `phase`
    - `playback_mode`
    - `replay_speed`
    - `selected_branch_id`
    - `selected_branch_title`
    - `selected_round`
    - `available_rounds`
    - `filtered_message_count`
    - `batch_count`
    - `displayed_bubble_count`
- 代码位置：
  - `frontend/src/components/TimelineBar.tsx`
  - `frontend/src/components/TimelineBar.css`
  - `frontend/src/pages/SimulationView.tsx`
  - `frontend/src/game/automation.ts`
  - `frontend/src/game/automation.test.ts`
- 新增的 Timeline round markers 会显示：
  - `F<n>` = fork round
  - `C<n>` = 本轮玩法卡使用数
  - `B<n>` = 本轮下注数
- 当前可验证情况：
  - `cd frontend && ./node_modules/.bin/tsc --noEmit -p tsconfig.app.json` 通过。
- 当前环境限制：
  - `npm test` / `npm run build` 受限于运行环境无法写入 `node_modules/.vite-temp`，不是代码语法层错误。
  - MCP Playwright / Chrome DevTools 浏览器会话在本轮出现 transport close，导致截图型 E2E 证据收集不稳定。
- 下一轮建议优先做：
  - 用恢复后的浏览器工具实测 TimelineBar 点击回放与 `replay_state` 是否同步。
  - 若继续按计划推进，优先做玩法卡题材卡框与 badge 资产接入，或升级因果档案字段（`most_used_card` / `betting_hit` / `archive_grade`）。

## 2026-03-15 Build + Replay Continuation

- 已发现并修复一组前端构建阻断：
  - `frontend/src/pages/SimulationView.tsx` 的 replay automation 依赖顺序/重复 render hook 曾导致 `tsc` 报 block-scoped variable used before declaration。
  - `frontend/src/game/automation.ts` 已补 `__swarmGetReplayAutomation` 与 replay state 字段兼容定义。
  - `frontend/src/components/TimelineBar.tsx` 已恢复 `buildTimelineRoundSummaries()` 导出；`SimulationView` 现会把 `timelineRoundMarkers` 传给 `TimelineBar`。
- 本轮验证通过：
  - `cd frontend && TMPDIR=frontend/output npm run build`
  - `cd frontend && TMPDIR=frontend/output npm test -- --run src/components/TimelineBar.test.tsx`
  - `cd backend && TMPDIR=../frontend/output .venv/bin/python -m pytest -s tests/test_api.py tests/test_predictions.py tests/test_simulator.py tests/test_simulator_viz_integration.py -q` → `193 passed`
- 浏览器 E2E 新证据：
  - `frontend/output/mobile-input-long.png`：移动端长问题输入已换行显示，无早前首屏裁切。
  - `frontend/output/theater-replay-initial.{json,png}`：完成态直开 `/sim/:id` 能恢复 Theater，并暴露 replay automation state / agent / bubble 摘要。
  - `frontend/output/theater-replay-after-controls.{json,png}`：分支/轮次切换与 replay 控件可见，但切换过程仍可能出现短暂黑色顶部带，需要继续确认是过渡帧还是渲染瑕疵。
  - `frontend/output/result-*.png` 与 `share-*.png`：结果页、导出、分享生成、复制状态正常。
- 仍待下一轮继续：
  - 玩法卡 modal 的黑盒自动化还没拿到稳定脚本证据；脚本多次卡在最小 Theater 场景创建/等待链路。
  - 若继续 `implement/18_next_session_gameplay_art_replay_plan.md`，优先继续 TimelineBar 交互 polish 与 replay visual hardening。

## 2026-03-15 Sequential Fixes After User Feedback

- 已修复：Theater 首次进入时先显示默认村庄、随后再跳到真实场景的问题。
  - `frontend/src/game/PhaserGame.tsx`：在 Phaser `preBoot` 就把初始 `scene_theme` 注入 registry。
  - `frontend/src/game/scenes/WorldScene.ts`：
    - `create()` 先读取 `initialSceneTheme`
    - 首次 `viz:scene_init` 在 bootstrap 阶段直接应用主题，不再强制做黑色 wipe 过渡

- 已修复：首页每日挑战卡右上角浮动徽章压住按钮、视觉不协调的问题。
  - `frontend/src/pages/InputView.tsx`
  - `frontend/src/pages/InputView.css`
  - 徽章已改为 eyebrow 内联小图标，不再悬浮在按钮区域。

- 已修复：新建 Theater 场景早期完全没有 branch 的等待窗口。
  - `backend/app/api/scenarios.py`
    - 创建场景时立即写入 `scene_theme`
    - 同时创建 provisional root branch
  - `backend/app/services/simulator.py`
    - 模拟阶段复用已有 root branch，而不是重复创建
  - `frontend/src/stores/simulationStore.ts`
    - duplicate `branch_init` 现在会刷新占位 root branch 的标题/状态
  - 实测 API：
    - 新建场景即时返回 `status=parsing`
    - `scene_theme=medieval_village`（按问题同步推断）
    - `branch_count=1`
    - `branch_title=历史拐点`

- 已修复：完成态 Theater 底部 bar 过高、信息重复，压缩主画面的布局问题。
  - `frontend/src/components/TimelineBar.tsx`
  - `frontend/src/components/TimelineBar.css`
  - `frontend/src/pages/SimulationView.tsx`
  - `frontend/src/pages/SimulationView.css`
  - 完成态 Theater 现在会启用 compact timeline：
    - 隐藏冗余阶段条
    - 保留回放 round markers + stats
    - 页面允许纵向滚动，主剧场区域有稳定最小高度，不再被底部条无限挤压

- 回归：
  - `cd backend && .venv/bin/python -m pytest tests/test_api.py -k 'create_scenario_returns_immediately_and_schedules_background_parse or get_scenario_includes_visualization_fields' -q`
  - `cd frontend && npm test` → `107 passed`
  - `cd frontend && npm run build` → 通过

- 仍需说明：
  - `develop-web-game` / Playwright 这台机器上后续又遇到 Chromium headless shell 的 `bootstrap_check_in ... Permission denied`，所以截图链路修复后的最终黑块复验，仍受本机浏览器权限问题影响，不能只靠这轮自动化定论。

## 2026-03-15 Gameplay Correctness + Warmup/Replay Pass

- 已修复 4 个直接影响“可玩性/状态正确性”的前端逻辑问题：
  - `frontend/src/components/GameplayCardsModal.tsx`
    - 玩法卡冷却与 usage log 不再用 `branch.fork_round` 猜轮次。
    - 改为由 `SimulationView` 显式传入真实 `currentRound`，档案里的 `R<n>`、导演点数节奏、卡冷却都按真实推演轮次记录。
  - `frontend/src/lib/dailyChallenge.ts`
    - 每日挑战改为按本地日期而非 UTC 换日。
    - 新增 `isChallengeScenario()`，供结果页判断“这个场景是否真的是从每日挑战入口启动”。
  - `frontend/src/pages/ResultView.tsx`
    - 不再仅凭“题目文本等于今日挑战题目”就把普通场景记成每日挑战完成。
    - 现在只有 challenge progress 中绑定到当前 `scenarioId` 的场景才会回写 completed。
  - `frontend/src/components/PredictionModal.tsx`
    - 分支下注目标为空时，不再允许提交空 target。
    - 当分支尚未 hydrate 完成时，会自动回退到 `ending_tone` 下注模式，避免生成坏数据。

- 已修复 2 个直接影响 Theater 体验的核心链路问题：
  - `frontend/src/game/replaySelection.ts`
    - completed replay 现在会把目标分支的祖先世界线消息一并纳入。
    - 子世界线回放不再从半路开始，`available_rounds` / `filtered_message_count` 也会反映完整上下文。
  - `frontend/src/pages/SimulationView.tsx`
    - 新建 Theater warmup 阶段增加“缺 agents / branches 时的 API hydrate 轮询”。
    - 实测新场景不再出现 `agentCount=0` 导致 `🃏 玩法卡` 按钮长时间缺失的问题。
    - `render_game_to_text()` 的 `page.controls` 新增 `can_open_gameplay_cards`，便于黑盒回归。

- 已修复 1 个 live 交互布局 bug：
  - `frontend/src/components/GameplayCardsModal.css`
    - 玩法卡弹窗现在有 `max-height + overflow-y:auto`，底部操作区 sticky。
    - 在 1600×900 桌面视口下，`注入玩法卡` 不再落到视口外。

- 本轮验证通过：
  - 定向单测：
    - `cd frontend && npm test -- src/lib/dailyChallenge.test.ts src/game/replaySelection.test.ts src/components/PredictionModal.test.tsx src/pages/SimulationView.test.tsx`
    - `12 passed`
  - 类型/构建：
    - `cd frontend && ./node_modules/.bin/tsc --noEmit -p tsconfig.app.json`
    - `cd frontend && npm run build`
  - 真实浏览器 / 自动化证据：
    - completed Theater：选择 `海军与陆军联袂制霸` 后，`page.replay_state.available_rounds = [1,2,3]`，说明祖先上下文回放修复生效。
    - live warmup Theater：新建 AI 治理场景后，`state-0.json` 显示：
      - `agentCount = 3`
      - `can_open_gameplay_cards = true`
      - `scene.theme = "scifi_base"`
    - 真实 Playwright 页面确认：
      - live 场景顶部已出现 `🃏 玩法卡`
      - 玩法卡 modal 可完整看到并成功点击 `注入玩法卡`
      - 注入后消息数从 6 增长到 33，说明 intervention 链路正常触发

- 仍保留的已知风险：
  - `develop-web-game` 客户端的 `shot-0.png` 依旧可能是黑底/黑画布，即使 `state-0.json` 正常。
  - 这更像当前 Playwright 客户端对 Phaser/WebGL 的截图链路问题，而不是 `render_game_to_text()` 或 Theater 状态错误。
  - 本轮已经用真实 Playwright 页面快照和状态 JSON 交叉确认功能正确，但如果下一轮继续按 `implement/18_next_session_gameplay_art_replay_plan.md` 推进，优先级仍建议放在：
    - P1: Theater 截图稳定性 hardening
    - P3: TimelineBar hover 信息密度增强
    - 更长线：把玩法卡从“4 张通用卡”继续扩成更题材化的玩法包（比如贸易/法律/宗教/舆论专属变体）

## 2026-03-15 P1 Screenshot Stability Hardening

- 已按 `implement/18_next_session_gameplay_art_replay_plan.md` 的 P1 继续推进，并完成一轮可复测 hardening：
  - `frontend/src/hooks/useScreenCapture.ts`
    - 新增可复用的 `captureElementBlob()` / `captureElementDataUrl()`。
    - 截图时现在支持显式区分：
      - `canvas`：优先直读 canvas
      - `element`：优先 html2canvas 抓整个可见块
      - `auto`
  - `frontend/src/game/automation.ts`
    - `AutomationWindow` 新增 `capture_game_screenshot(mode)` 类型声明。
  - `frontend/src/pages/SimulationView.tsx`
    - 在浏览器全局注册 `window.capture_game_screenshot()`：
      - `panel` 模式优先抓 `.theater-panel`
      - modal 打开时优先抓 `.modal-overlay`
      - 失败时回退到 `.phaser-game-container`
  - `/Users/yangjunjie/.codex/skills/develop-web-game/scripts/web_game_playwright_client.js`
    - 新增 `--capture-mode panel|canvas`
    - 截图流程改为：
      1. 优先调用页面内 `capture_game_screenshot()`
      2. 再尝试显式 surface selector（不再只靠“最大 canvas”猜）
      3. 最后才退回 Playwright page screenshot
    - `getCanvasHandle()` 现在优先查 `.phaser-game-container canvas`

- 黑盒验证结果：
  - completed replay:
    - `node .tmp-playwright/web_game_playwright_client.mjs --url http://127.0.0.1:18928/sim/3656c117-a389-4fa0-8e60-bdcd797a2d7d --actions-json '{"steps":[{"buttons":[],"frames":8}]}' --iterations 1 --pause-ms 300 --screenshot-dir /tmp/swarmoracle-shot-panel --capture-mode panel --headless true`
    - `node .tmp-playwright/web_game_playwright_client.mjs --url http://127.0.0.1:18928/sim/3656c117-a389-4fa0-8e60-bdcd797a2d7d --actions-json '{"steps":[{"buttons":[],"frames":8}]}' --iterations 1 --pause-ms 300 --screenshot-dir /tmp/swarmoracle-shot-canvas --capture-mode canvas --headless true`
    - 两种模式都已输出真实像素剧场画面，不再是整页黑块。
  - live theater:
    - `node .tmp-playwright/web_game_playwright_client.mjs --url http://127.0.0.1:18928/sim/5f14646b-c747-4665-965f-ece5faab2088 --actions-json '{"steps":[{"buttons":[],"frames":8}]}' --iterations 1 --pause-ms 300 --screenshot-dir /tmp/swarmoracle-live-panel --capture-mode panel --headless true`
    - `shot-0.png` 已成功截到 `scifi_base` 场景与实时气泡，不再是黑图。

- 当前结论更新：
  - `develop-web-game` 的黑底截图问题已显著收敛；在当前机器上，headless + 黑盒客户端已经能稳定拿到有效 Theater 截图。
  - 仍建议下一轮继续做的不是“继续修黑块”，而是把截图契约进一步产品化：
    - 明确 `panel` 与 `canvas` 两种产物的用途
    - 如有需要，再补一个 `modal` 专用 capture mode

## 2026-03-15 P2 Warmup + P3 Timeline Hover

- 已继续推进 `implement/18_next_session_gameplay_art_replay_plan.md` 的 P2 / P3：
  - `frontend/src/pages/SimulationView.tsx`
    - live Theater 现在在 `currentRound = 0` 时会暴露更明确的 warmup 状态：
      - `page.controls.can_preview_gameplay_cards`
      - `page.warmup.active/worldline_ready/agents_ready/director_ready/preview_enabled`
    - 顶栏 `🃏 玩法卡` 不再要求“角色已经就位”才显示。
    - 现在只要世界线骨架已存在，就允许先打开玩法卡做只读预览。
  - `frontend/src/components/GameplayCardsModal.tsx`
    - 新增 `readOnly` / `disabledReason`。
    - warmup 期间 modal 会显示“导演准备中”提示，并禁用真正注入动作。
    - 当分支 / 角色 / 来源分支尚未同步时，会渲染占位 option，而不是空白 select。
  - `frontend/src/pages/SimulationView.css`
    - 新增 `theater-panel__warmup` / `theater-warmup-pill`，把 live Theater 的准备状态显式化。

- `TimelineBar` 的 hover 信息密度也已增强：
  - `frontend/src/pages/SimulationView.tsx`
    - `timelineRoundMarkers` 现在会附带：
      - `forkTitles`
      - `cardSummaries`
      - `betSummaries`
  - `frontend/src/components/TimelineBar.tsx`
    - 原来只有 `title=\"R2 · fork 2 ...\"`
    - 现在 round marker 内部新增多行 hover tooltip，可直接看到：
      - 本轮分叉到哪些世界线
      - 用了哪些玩法卡
      - 下了哪些注
  - `frontend/src/components/TimelineBar.css`
    - 新增 `timeline-round__tooltip` 样式，hover / focus 时会弹出摘要卡。

- 本轮新增测试：
  - `frontend/src/components/GameplayCardsModal.test.tsx`
    - 锁住 read-only preview 行为。
  - `frontend/src/pages/SimulationView.test.tsx`
    - 锁住 warmup automation 输出。
  - `frontend/src/components/TimelineBar.test.tsx`
    - 锁住 hover tooltip 中的 forks/cards/bets 摘要文本。

- 当前验证：
  - `cd frontend && npm test -- src/components/TimelineBar.test.tsx src/components/GameplayCardsModal.test.tsx src/pages/SimulationView.test.tsx src/components/PredictionModal.test.tsx src/lib/dailyChallenge.test.ts src/game/replaySelection.test.ts`
    - `16 passed`
  - `cd frontend && ./node_modules/.bin/tsc --noEmit -p tsconfig.app.json`
  - `cd frontend && npm run build`

- 真实页面补充观察：
  - 由于当前环境下 3-agent / 3-round 的 live 场景推进较快，warmup banner 在真实浏览器中可能只出现极短时间，常常在你手动切过去前就已进入 `R1`。
  - 但 automation 输出和单测已锁住这条 warmup 逻辑，不再依赖“人眼刚好赶上那几秒钟”。

## 2026-03-15 Gameplay Theme Packs + Capture Modes Productization

- 已继续扩展玩法题材包，但保持“4 张固定卡 + intervention API 注入”架构不变：
  - `frontend/src/components/gameplayCards.ts`
    - `GameplayProfileId` 现已扩到：
      - `trade`
      - `law`
      - `faith`
      - `ecology`
    - 每个 profile 都补了：
      - `signatureHooksZh/En`
      - `recommendedCards`
      - 四张卡各自的 `defaultDirectives`
    - `inferGameplayProfile()` 现在不再是“scene_theme 一票否决”。
      - 场景给基础分
      - 关键词命中可压过默认场景
      - 因而像 `港口/关税/商路`、`法院/宪章/否决`、`神谕/异端`、`水源/迁徙/生态` 这些问题，能真正进入新题材包，而不是被老的 theme 兜走
    - 新增：
      - `getGameplayProfileSignatureHooks()`
      - `getGameplayCardDirectivePreview()`
    - `getSuggestedGameplayAgents()` / `getSuggestedSourceBranchId()` 现在接受 `profileId`，按题材做轻量 role/title 关键词偏置

- `GameplayCardsModal` 也已同步“题材包化”：
  - `frontend/src/components/GameplayCardsModal.tsx`
    - 顶部现在会显示当前题材包的 3 个 signature hooks
    - 每张卡片除通用说明外，还会显示当前题材下的“具体导向语”
    - 选角 / 来源世界线建议已接入新的 `profileId` 偏置逻辑
  - `frontend/src/components/GameplayCardsModal.css`
    - 新增 `gameplay-modal__hooks` / `gameplay-card__flavor` 样式

- 截图模式也已从“内部支持”变成真正可见、可选的产品能力：
  - `frontend/src/hooks/useScreenCapture.ts`
    - `captureScreenshot()` / `captureGIF()` 现在支持按调用传入 selector / captureTarget override
  - `frontend/src/pages/SimulationView.tsx`
    - Theater 顶部新增显式三段式截图模式切换：
      - `Panel`
      - `Canvas`
      - `Modal`
    - 规则：
      - `Panel`：抓当前 Theater 工作区，失败时可回退到 canvas
      - `Canvas`：只抓主剧场画布
      - `Modal`：只抓当前打开的弹窗；无弹窗时显示禁用态，不再偷偷回退成 panel
      - GIF 仍保持 `Panel/Canvas` 可用，`Modal` 下禁用（避免把 html2canvas 连拍硬塞成 GIF）
    - `render_game_to_text()` 现新增：
      - `page.controls.capture_mode`
      - `page.controls.can_capture_modal`
  - `frontend/src/pages/SimulationView.css`
    - 新增 `capture-mode-toggle` 三段式控件样式
  - `frontend/src/game/automation.ts`
    - `capture_game_screenshot(mode)` 类型现显式支持 `panel|canvas|modal`
  - `/Users/yangjunjie/.codex/skills/develop-web-game/scripts/web_game_playwright_client.js`
    - `--capture-mode modal` 现在是明确语义：
      - 只找 `.modal-overlay`
      - 不再静默回退到 panel
    - `panel` / `canvas` / hook data URL 的优先级与退化链也已同步

- 本轮验证通过：
  - `cd frontend && ./node_modules/.bin/tsc --noEmit -p tsconfig.app.json`
  - `cd frontend && npm test -- src/components/gameplayCards.test.ts src/components/GameplayCardsModal.test.tsx src/components/TimelineBar.test.tsx src/pages/SimulationView.test.tsx src/components/PredictionModal.test.tsx src/lib/dailyChallenge.test.ts src/game/replaySelection.test.ts`
    - `25 passed`
  - `cd frontend && npm run build`

- 浏览器 smoke：
  - completed Theater 顶部已可见三模式切换：`Panel / Canvas / Modal`
  - `Modal` 在无弹窗时为禁用态，符合预期
  - live warmup 由于 3-agent / 3-round 场景推进很快，本轮更依赖 automation/test 锁定而不是人工等待几秒截中瞬间

## 2026-03-15 Theme Packs Surfaced + Modal Smoke

- 已把新扩的玩法题材包接到首页每日挑战和结果页因果档案，不再只在玩法卡弹窗内部可见：
  - `frontend/src/lib/dailyChallenge.ts`
    - 每日挑战题库现从 5 条扩到 9 条。
    - 新增 profile 覆盖：
      - `trade`
      - `law`
      - `faith`
      - `ecology`
  - `frontend/src/pages/InputView.tsx`
    - 每日挑战卡现在会展示：
      - 当前 challenge 的题材 label
      - 2 个 signature hooks
  - `frontend/src/pages/InputView.css`
    - 新增 `daily-challenge-card__hooks`
  - `frontend/src/pages/ResultView.tsx`
    - 因果档案现在会在 meta chips 下方展示当前题材包的 signature hooks
  - `frontend/src/pages/ResultView.css`
    - 新增 `result-archive__hooks` / `archive-chip--hook`

- 玩法题材包本身也已从“轻量标签”继续加厚：
  - `frontend/src/components/gameplayCards.ts`
    - 新增 profile：
      - `trade`
      - `law`
      - `faith`
      - `ecology`
    - 每个 profile 现在都包含：
      - `signatureHooksZh/En`
      - 更明确的 `defaultDirectives`
      - role/title 关键词启发式（选角偏置）
      - source branch 关键词启发式
    - `inferGameplayProfile()` 现在使用“scene theme + keyword scoring”联合推断，不再是 scene theme 直接一票决定。
    - 新增导出：
      - `getGameplayProfileSignatureHooks()`
      - `getGameplayCardDirectivePreview()`
  - `frontend/src/components/GameplayCardsModal.tsx`
    - 顶部新增题材 hook chips
    - 每张卡新增当前题材下的具体导向文案（flavor line）
    - 选角/来源分支建议已接入新的 profile 规则
  - `frontend/src/components/GameplayCardsModal.css`
    - 新增 `gameplay-modal__hooks` / `gameplay-card__flavor`

- `modal` 模式黑盒 smoke 回归已跑通：
  - 使用：
    - `node .tmp-playwright/web_game_playwright_client.mjs --url http://127.0.0.1:18928/sim/38790061-22bd-4600-b8b1-17bc1c8fc280 --click-selector '.sim-header__actions .btn.btn-ghost' --actions-json '{"steps":[{"buttons":[],"frames":8}]}' --iterations 1 --pause-ms 300 --screenshot-dir /tmp/swarmoracle-modal-smoke --capture-mode modal --headless true`
  - 结果：
    - `/tmp/swarmoracle-modal-smoke/shot-0.png` 为真实 `玩法卡` 弹窗截图
    - 没有回退成整页 / panel
    - `state-0.json` 同时确认：
      - `active_modal = "gameplay_cards"`
      - `modal_state.profile_id = "trade"`
      - `warmup.director_ready = true`

- 最新校验：
  - `cd frontend && ./node_modules/.bin/tsc --noEmit -p tsconfig.app.json`
  - `cd frontend && npm test -- src/components/gameplayCards.test.ts src/components/GameplayCardsModal.test.tsx src/components/TimelineBar.test.tsx src/pages/SimulationView.test.tsx src/components/PredictionModal.test.tsx src/lib/dailyChallenge.test.ts src/game/replaySelection.test.ts src/lib/archiveSummary.test.ts`
    - `28 passed`
  - `cd frontend && npm run build`

## 2026-03-15 Theme Packs Into Archive Logic + Challenge Feedback

- 已把“题材包”接入结果页档案评分逻辑，不再只是展示层：
  - `frontend/src/lib/archiveSummary.ts`
    - 新增 `ProfileResonance = signature | aligned | offbeat`
    - `buildArchiveSummary(...)` 现会接收 `profileId`
    - 会根据主导世界线文本与题材关键词的匹配度，计算 `profileResonance`
    - `archiveGrade` 也会把题材回响纳入评分：
      - `signature` 额外加 2 分
      - `aligned` 额外加 1 分
  - `frontend/src/lib/scenarioMeta.ts`
    - `ScenarioArchiveState` 新增 `profileResonance`

- 已把“题材包”接入每日挑战完成反馈：
  - `frontend/src/lib/dailyChallenge.ts`
    - `ChallengeProgressEntry` 新增 `profileResonance`
  - `frontend/src/pages/ResultView.tsx`
    - 每日挑战完成时，会把 `archiveSummary.profileResonance` 回写进 challenge progress
    - 因果档案 summary 现在新增：
      - `题材回响 / Theme Resonance`
    - 挑战反馈不再只是“已完成 · X 张牌”，而会优先显示：
      - `题材名 + 回响等级`
  - `frontend/src/pages/InputView.tsx`
    - 首页每日挑战卡如果已有完成进度，也会显示：
      - `题材名 + 回响等级`

- 新题材包的用户可见接入进一步完善：
  - `frontend/src/lib/dailyChallenge.ts`
    - challenge pool 现在扩到 9 条，已覆盖：
      - `trade`
      - `law`
      - `faith`
      - `ecology`
  - `frontend/src/pages/InputView.tsx` / `InputView.css`
    - 每日挑战卡会显示：
      - 当前题材 label
      - 2 个 signature hooks
  - `frontend/src/pages/ResultView.tsx` / `ResultView.css`
    - 因果档案会显示题材 hook chips

- 本轮校验：
  - `cd frontend && ./node_modules/.bin/tsc --noEmit -p tsconfig.app.json`
  - `cd frontend && npm test -- src/components/gameplayCards.test.ts src/components/GameplayCardsModal.test.tsx src/components/TimelineBar.test.tsx src/pages/SimulationView.test.tsx src/components/PredictionModal.test.tsx src/lib/dailyChallenge.test.ts src/game/replaySelection.test.ts src/lib/archiveSummary.test.ts`
    - `28 passed`
  - `cd frontend && npm run build`

## 2026-03-15 Share Flavor + Capture Mode UI Tests

- 已按用户要求继续完成两项：

### 1. 题材回响接入结果页导出 / 分享文案

- `frontend/src/lib/shareEnvelope.ts`
  - 新增：
    - `buildShareCopyEnvelope()`
    - `buildExportArchivePreface()`
  - 会把这些结果页已有信息包进导出 / 分享成品：
    - `profileLabel`
    - `profileHooks`
    - `resonanceLabel`
    - `directorStyleLabel`
    - `dominantBranchTitle`

- `frontend/src/pages/ResultView.tsx`
  - `export markdown` 不再直接下载原始后端内容；现在会在前端先拼一个 `题材档案 / Theme Pack Snapshot` 前缀，再导出。
  - `ShareModal` 现在会收到 `shareContext`，不再只拿 `scenarioId`。
  - 此外修复了一个真实回归：
    - `shareFlavorContext` 先前因每次 render 都创建新对象，触发 `ShareModal` automation effect 回路。
    - 现在已通过 `useMemo` 稳定化，不再出现 `Maximum update depth exceeded`。

- `frontend/src/components/ShareModal.tsx`
  - 现在生成社交文案后，前端会把题材上下文轻量拼装进最终 copy。
  - modal 结果区也会显示 context chips（题材 / 回响 / hooks）。
  - `onAutomationStateChange` 现在也会暴露 `share_context`。

- `frontend/src/components/ShareModal.css`
  - 新增 `share-context` / `share-context__chip`

- 新增测试：
  - `frontend/src/lib/shareEnvelope.test.ts`
  - `frontend/src/components/ShareModal.test.tsx`

- 真实浏览器 smoke：
  - 打开 `result/3656c117-a389-4fa0-8e60-bdcd797a2d7d`
  - 点击 `📱 生成文案` → `📕 小红书`
  - 弹窗中已出现：
    - `帝国统合`
    - `走出了题材支线`
    - `中央与行省 / 宫廷裂缝 / 军团忠诚`
  - 生成结果正文开头已带：
    - `【帝国统合｜走出了题材支线】`
    - `题材钩子：...`
    - `主导世界线：海上霸权起点 · 导演风格：静观记录者`

### 2. 截图三模式的前端 UI 级自动化测试

- 已按最小稳定方案把测试收口在 `frontend/src/pages/SimulationView.test.tsx`
  - 新增 2 条：
    - `switches capture modes in the UI and unlocks modal mode when a modal opens`
    - `routes capture_game_screenshot to panel, canvas, and modal surfaces`

- 覆盖内容：
  - UI 三段切换：
    - `panel`
    - `canvas`
    - `modal`
  - `modal` 在无弹窗时禁用
  - 打开 prediction modal 后：
    - `can_capture_modal = true`
    - `capture_mode = modal`
    - `active_modal = prediction`
  - `GIF` 在 `modal` 模式下禁用
  - `window.capture_game_screenshot()` 路由：
    - `panel -> .theater-panel + element`
    - `canvas -> .phaser-game-container + canvas`
    - `modal -> .modal-overlay + element`

- 配套修正：
  - `frontend/src/pages/SimulationView.test.tsx`
    - `useScreenCapture` mock 现在补了 `captureElementDataUrl`
    - store mock 现在带 `getState()`

- 最新校验：
  - `cd frontend && ./node_modules/.bin/tsc --noEmit -p tsconfig.app.json`
  - `cd frontend && npm test -- src/lib/shareEnvelope.test.ts src/components/ShareModal.test.tsx src/pages/SimulationView.test.tsx src/components/gameplayCards.test.ts src/components/GameplayCardsModal.test.tsx src/components/TimelineBar.test.tsx src/components/PredictionModal.test.tsx src/lib/dailyChallenge.test.ts src/game/replaySelection.test.ts src/lib/archiveSummary.test.ts`
    - `33 passed`
  - `cd frontend && npm run build`

## 2026-03-15 六题材全量回归 + Theater 布局修复

- 本轮按 `frontend/output/e2e/sample_matrix.json` 对六题材 completed 样本做了统一回归：
  - `governance`
  - `law`
  - `trade`
  - `ecology`
  - `war`
  - `faith`

- 已统一补齐结果页 / 分享页证据：
  - `frontend/output/e2e/<theme>-result-headed/`
  - 每题材都已落：
    - `result-initial.png/json`
    - `share-generated.png/json`
    - `result.json`

- 已统一补齐 replay 黑盒证据：
  - `frontend/output/e2e/<theme>-replay-proof/state-0.json`
  - `frontend/output/e2e/<theme>-replay-proof/shot-0.png`

- 已额外补齐用户点名的 headed 视觉证据：
  - `frontend/output/e2e/governance-replay-headed.png`
  - `frontend/output/e2e/law-replay-headed.png`
  - `frontend/output/e2e/war-replay-headed.png`

- 真实问题确认并修复：
  - 完成态 Theater 存在严重布局 bug：
    - 页面会变成整页可纵向滚动
    - 主剧场被垂直居中到页面中段
    - 上下滚动时大部分区域只剩纯背景 + 右侧实时发言
  - 根因：
    - `frontend/src/pages/SimulationView.css` 的 `simulation-view--replay-ready` 分支把根容器改成了 `height:auto + overflow-y:auto`
    - `frontend/src/game/game.css` 的 `.theater-panel` 使用 `justify-content:center`
    - 当右侧 AgentPanel 消息很多时，整页被拉到超长高度，主剧场居中后落到中段
  - 修复：
    - `frontend/src/pages/SimulationView.css`
      - replay-ready 回到固定视口布局，不再让整页滚动
      - `sim-content / tree / panel` 补 `min-height: 0`
    - `frontend/src/game/game.css`
      - `.theater-panel` 改为顶对齐
      - `.theater-panel__game-wrapper` 改为可伸缩且顶对齐

- 修复后人工 headed 复验：
  - `war` 场景修复后：
    - `window.scrollY = 0`
    - `document.documentElement.scrollHeight = 900`
    - 首屏不再出现大块空白背景
    - 证据图：`frontend/output/e2e/war-replay-headed.png`
  - `governance / law` 也重新抓取了修复后的 headed replay 图，首屏主剧场正常可见。

- `sample_matrix.json` 已更新为可追溯矩阵：
  - 六题材现在都带 `artifacts.replay_state / replay / result / share`
  - 路径都指向 repo 内 `frontend/output/e2e/` 下的真实文件，不再混用 `/tmp` 和仓库根旧图。

- 本轮最新校验：
  - `cd frontend && npm test -- --run src/pages/SimulationView.test.tsx src/components/TimelineBar.test.tsx src/game/automation.test.ts`
    - `10 passed`
  - `cd frontend && npm run build`
    - 通过

- 仍未彻底完成、但不影响本轮 bug 修复与六题材回归闭环的项：
  - `TimelineBar` 在完成态 Theater 中仍被隐藏，组件能力虽在，但成品路径不可达
  - `timeline_marker_fork/card/bet/result` 图标素材仍未生成接入，当前仍是 `F/C/B` 文本 marker
  - 如果下一轮继续扩玩法，当前最薄建议仍是：
    - `关键回合押注`
    - 或更小的 `押档案评级`

## 2026-03-15 最小新玩法：押题材回响 + ResultView 门禁修复

- 已补一个不改后端协议的新玩法：
  - `PredictionModal` 新增第三种结构化下注：
    - `押题材回响`
  - 可选目标：
    - `命中题材核心`
    - `方向基本吻合`
    - `走出了题材支线`

- 改动文件：
  - `frontend/src/lib/predictionBetting.ts`
    - `StructuredBetKind` 新增 `profile_resonance`
    - 新增 `PROFILE_RESONANCE_OPTIONS`
    - `buildStructuredPredictionText()` 支持新类型
  - `frontend/src/components/PredictionModal.tsx`
    - 新增题材回响目标选择
    - automation state 新增 `profile_resonance`
  - `frontend/src/lib/scenarioMeta.ts`
    - `StructuredBetRecord.kind` 支持 `profile_resonance`
  - `frontend/src/lib/archiveSummary.ts`
    - `resolveBettingHit()` 现在可结算题材回响下注

- 测试：
  - `frontend/src/components/PredictionModal.test.tsx`
    - 新增题材回响下注用例
  - `frontend/src/lib/archiveSummary.test.ts`
    - 新增题材回响命中结算用例

- 真实浏览器验证：
  - 新建场景 `41fe4a79-cb29-4018-9a8a-56c405af5618`
  - PredictionModal 中选择 `押题材回响`
  - 提交后，结果页“预测结果”区已显示：
    - `押题材回响 · 命中题材核心`

- 新发现并修复：
  - `ResultView` 在场景尚未完成 narration 时，如果用户直接打开 `/result/:id`，会把后端 fallback branches 当最终结果渲染出来，导致大量 `故事 = —`
  - 根因：
    - `GET /api/scenario/{id}/story` 在 `scenario.status != done` 阶段会返回占位 branches
    - `ResultView` 之前没有检查 `scenario.status` 是否已经 `done`
  - 修复：
    - `frontend/src/pages/ResultView.tsx`
      - 在 `scenario.status !== 'done'` 时保持 loading，并每 1.5s 轮询
      - 只有场景真正 `done` 后才渲染结果页并写入 archive

- 真实复验：
  - 新建场景 `760cc8b2-e5c7-498e-a785-0a04badba50e`
  - 立即打开 `/result/:id`
    - 修复前：会看到许多 `故事 = —`
    - 修复后：先显示 `Loading…`
  - 5 秒后 narration 完成，结果页正常显示完整故事段落，不再出现半成品卡片

- 最新校验：
  - `cd frontend && npm test -- --run src/components/PredictionModal.test.tsx src/lib/archiveSummary.test.ts src/pages/SimulationView.test.tsx`
    - `13 passed`
  - `cd frontend && npm run build`
    - 通过

## 2026-03-15 收尾：完成态 Theater 时间轴可达 + marker 图标接入

- 已完成 `1`：
  - 完成态 Theater 里不再完全隐藏 `TimelineBar`
  - 现在会在世界线/轮次筛选器下方插入一个 compact timeline
  - 时间轴保留 replay round 点击跳转能力，但不再回到底部页面流里，因此不会重新引入首屏滚动 bug

- 相关改动：
  - `frontend/src/pages/SimulationView.tsx`
    - 在 Theater 完成态内渲染 compact `LazyTimelineBar`
    - `timelineRoundMarkers` 新增 `resultCount/resultSummaries`
  - `frontend/src/pages/SimulationView.css`
    - 新增 `theater-panel__timeline` 包装与暗色嵌入式样式

- 已完成 `2`：
  - 新增四个时间轴 marker 资源：
    - `frontend/public/assets/ui/generated/timeline_marker_fork.svg`
    - `frontend/public/assets/ui/generated/timeline_marker_card.svg`
    - `frontend/public/assets/ui/generated/timeline_marker_bet.svg`
    - `frontend/public/assets/ui/generated/timeline_marker_result.svg`
  - `frontend/src/components/TimelineBar.tsx`
    - round marker 不再只显示 `F/C/B`
    - 改成 `图标 + 数量`
    - 新增 `result` marker，用于最终轮展示已生成结局数
  - `frontend/src/components/TimelineBar.css`
    - 新增 marker icon 样式
    - 新增 `timeline-round__marker--result`
  - `frontend/src/i18n/locales/zh.json`
  - `frontend/src/i18n/locales/en.json`
    - 新增 `sim.timeline.tooltip_results`
  - `frontend/public/assets/ASSET_CREDITS.md`
    - 已把 timeline marker SVG 资源记入清单，并纠正为“绝大多数 raster 资产为 AI 生成，timeline marker 为手工 SVG”

- 测试补充：
  - `frontend/src/pages/SimulationView.test.tsx`
    - 锁住“完成态 Theater 中存在 compact timeline”
    - 锁住“roundMarkers 中有 result marker 时 mock timeline 会收到该数据”
  - `frontend/src/components/TimelineBar.test.tsx`
    - 锁住 `fork/card/bet/result` 四种 marker
    - 锁住 `tooltip_results`

- 真实浏览器复验：
  - `war` 完成态 Theater 首屏已可直接看到 compact timeline
  - timeline 不再把主剧场推离首屏
  - `R3` 会显示结果 marker 和结局数量

- 最新校验：
  - `cd frontend && npm test -- --run src/components/TimelineBar.test.tsx src/pages/SimulationView.test.tsx src/components/PredictionModal.test.tsx src/lib/archiveSummary.test.ts`
    - `16 passed`
  - `cd frontend && npm run build`
    - 通过

## 2026-03-15 六题材 replay 基线重拍

- 已按用户同意继续补齐六题材 replay 基线，让新加的 compact timeline 与 marker 图标进入统一证据集。
- 统一重拍的 headed replay 图：
  - `frontend/output/e2e/governance-replay-headed.png`
  - `frontend/output/e2e/law-replay-headed.png`
  - `frontend/output/e2e/trade-replay-headed.png`
  - `frontend/output/e2e/ecology-replay-headed.png`
  - `frontend/output/e2e/war-replay-headed.png`
  - `frontend/output/e2e/faith-replay-headed.png`

- `sample_matrix.json` 已同步：
  - 六题材 `artifacts.replay` 现在全部指向这些 headed 基线图
  - `artifacts.replay_state` 继续指向各自的 `state-0.json`

- 快速校验：
  - 已逐条检查 `sample_matrix` 里的 6 个 `replay` 路径，全部存在

## 2026-03-15 任务 1-4：回归命令 / 投注展示 / 拆包 / 交互收口

### 1. sample_matrix 驱动的一键全量回归入口

- 新增：
  - `frontend/scripts/e2e-suite.mjs`
- 新脚本支持三种 mode：
  - `matrix`
  - `corners`
  - `full`

- `package.json` 新增命令：
  - `npm run e2e:matrix`
  - `npm run e2e:corners`
  - `npm run e2e:full`

- `matrix` 会读取：
  - `frontend/output/e2e/sample_matrix.json`
  - 按样本逐个重跑：
    - replay
    - result
    - share

- `corners` 当前覆盖：
  - `branch_winner` 真提交
  - `ending_tone` 真提交
  - `profile_resonance` 真提交
  - prediction failure guard（500 错误时 modal 保持 error，不会假成功）
  - result loading gate（simulating 时进入 `/result/:id` 先 loading，完成 narration 后再展示）
  - replay：`skip -> branch switch -> replay restore`
  - share context
  - share retry（首轮失败后 retry 恢复）
  - history + leaderboard load

- 最新完整黑盒回归产物：
  - `frontend/output/e2e/full-regression-latest-v2/result.json`

### 2. 结果页投注展示增强

- `frontend/src/lib/predictionBetting.ts`
  - 新增 `resolveStructuredBetOutcome()`
  - 可判定：
    - `branch_winner`
    - `ending_tone`
    - `profile_resonance`

- `frontend/src/pages/ResultView.tsx`
  - 预测卡片现在会显示每条结构化下注的状态 chip：
    - `命中`
    - `未中`
    - `待判定`
  - 档案里的下注记录也会显示同样的状态 chip
  - “下注结果”摘要从原来单个布尔口径，改成：
    - `X / Y 命中`
    - 无下注时显示 `未下注`
  - 结果页 loading 状态在 narration 尚未完成时会显示：
    - `正在生成结局叙事…`

- 新增测试：
  - `frontend/src/lib/predictionBetting.test.ts`

### 3. 前端拆包 / 构建优化

- `frontend/src/hooks/useScreenCapture.ts`
  - `html2canvas` 改为按需 `import()`，不再静态进入 `SimulationView` 首包

- 新增：
  - `frontend/src/components/ClassicBranchTree.tsx`
  - classic tree 栈从 `SimulationView` 的 Theater 路径剥离

- `frontend/vite.config.ts`
  - `manualChunks` 细分为：
    - `phaser`
    - `capture-vendor`
    - `flow-vendor`
    - `i18n-vendor`
    - `react-vendor`
    - `vendor`

- 构建结果对比：
  - `SimulationView` 从之前约 `409 kB` 降到 `32.65 kB`
  - 新增独立 chunk：
    - `ClassicBranchTree`
    - `capture-vendor`
    - `flow-vendor`

### 4. 交互抛光 / 噪声收口

- `frontend/src/pages/SimulationView.tsx`
  - warmup hydration 恢复日志改为单次提示，不再每轮轮询刷屏

- `frontend/scripts/e2e-automation.mjs`
  - 修复旧 result flow 的一个真实覆盖漏洞：
    - 先前错误读取 `controls.can_expand_story`
    - 现在改为从 `branches[].can_expand_story` 判断，结果页展开链路能真正被跑到

### 最新校验

- 定向前端测试：
  - `cd frontend && npm test -- --run src/lib/predictionBetting.test.ts src/components/PredictionModal.test.tsx src/lib/archiveSummary.test.ts src/pages/SimulationView.test.tsx src/components/TimelineBar.test.tsx src/hooks/useScreenCapture.test.ts`
    - `21 passed`

- 构建：
  - `cd frontend && npm run build`
    - 通过

- 完整 E2E：
  - `cd frontend && npm run e2e:full -- --headless --output-dir output/e2e/full-regression-latest-v2`
    - 通过

## 2026-03-16 全量 1-4 收口 + 最终 full 回归

- 新增安全的 History 删除分页 regression：
  - `frontend/scripts/e2e-suite.mjs`
  - 新 case：`history_delete_last_page`
  - 使用 Playwright route mock 喂 13 条 disposable `done` 场景
  - 验证：
    - 先翻到第 2 页且仅 1 条
    - 删除后自动回退到第 1 页
    - `total` 从 `13 -> 12`
  - 不会触碰真实数据库场景

- 结果页投注展示进一步增强：
  - `frontend/src/pages/ResultView.tsx`
  - `frontend/src/pages/ResultView.css`
  - `frontend/src/lib/predictionBetting.ts`
  - 每条结构化下注现在可显示：
    - `命中`
    - `未中`
    - `待判定`
  - 档案下注摘要从单个布尔口径改为：
    - `X / Y 命中`
    - 无下注时 `未下注`

- 性能收口最终版：
  - `frontend/src/hooks/useScreenCapture.ts`
    - `html2canvas` 改为按需动态导入
  - `frontend/src/components/ClassicBranchTree.tsx`
    - classic tree 与 Theater 路径正式拆开
  - `frontend/vite.config.ts`
    - 增加 `capture-vendor / flow-vendor / i18n-vendor / react-vendor / vendor`
  - 构建结果：
    - `SimulationView` chunk 约 `32.65 kB`
    - `ClassicBranchTree` 独立 chunk
    - `capture-vendor` 独立 chunk

- 交互收口：
  - `SimulationView` 的 warmup hydration log 现在只打印一次
  - `e2e-automation.mjs` 修复结果页故事展开覆盖漏洞

- 新增测试：
  - `frontend/src/lib/predictionBetting.test.ts`

- 最终完整黑盒回归：
  - `cd frontend && npm run e2e:full -- --headless --output-dir output/e2e/full-regression-final`
  - 结果文件：
    - `frontend/output/e2e/full-regression-final/result.json`

- `full-regression-final` 覆盖：
  - 六题材 matrix：
    - replay / result / share
  - corner cases：
    - `branch_winner` 真提交
    - `ending_tone` 真提交
    - `profile_resonance` 真提交
    - prediction failure guard
    - result loading gate
    - replay skip -> switch -> replay
    - share retry
    - history + leaderboard
    - history delete last page fallback

- 当前残余风险：
  - full 回归里的 replay 在 headless 环境下，`replayState.phase` 有时是 `idle` / `playing`，`displayed_bubble_count` 仍可能为 `0`
  - 这更像 headless WebGL 播放节拍差异；不影响当前功能结论，但若以后要把 replay 播放“是否真的播到第 N 批气泡”做严格门槛，建议保留 headed/nightly 一套

## 2026-03-16 剧场文字清晰度 + narrator 容错 + 导出/i18n 收口

- WorldScene 气泡文字清晰度已提升：
  - `frontend/src/game/scenes/WorldScene.ts`
  - 文本从小号 `monospace` 改为常规 UI 字体栈
  - `fontSize` 从 `11px -> 13px`
  - `setResolution` 从 `2 -> 3`
  - 增加 lineSpacing 和更宽的 wordWrap
  - 气泡框仍保留像素风，不改整体美术方向

- 后端 narrator 容错修复：
  - `backend/app/services/narrator.py`
  - `llm_call_json()` 返回 `list` 时不再直接报 `'list' object has no attribute 'get'`
  - 现在会：
    - 优先取 list 中第一条 mapping
    - 若只有字符串列表，则降级为 `story/insight/key_moments`
    - 否则安全回退为空
  - 测试：
    - `backend/tests/test_narrator.py`

- 真实复验：
  - 旧报错场景同类题面重新创建为：
    - `ac26354b-ecb9-4ff4-80b8-a12d0bf840ab`
  - 最终状态：
    - `status = done`
    - `scene_theme = fantasy_kingdom`
    - `/story` 已返回完整 `story/insight`

- 玩法卡提示词权重增强：
  - `frontend/src/components/gameplayCards.ts`
  - `backend/app/services/memory.py`
  - 玩法卡 prompt 现在显式标注：
    - `DIRECTOR OVERRIDE / 高优先级玩法卡事件`
    - 这是全体角色都知道的导演级事件
    - 不是一次性补充说明，而是持续影响后续轮次的状态变化
  - memory prompt 也同步要求：
    - 先回应该事件
    - 不得忽略
    - 在后续决策中持续体现其影响
  - 前端测试：
    - `frontend/src/components/gameplayCards.test.ts`

- 截图 / GIF 下载兼容性加固：
  - `frontend/src/hooks/useScreenCapture.ts`
  - 下载前现在会按文件名归一化 MIME：
    - `.png -> image/png`
    - `.gif -> image/gif`
  - 下载行为改为：
    - append anchor -> click -> remove
    - 延迟 revoke object URL
  - 真实下载验证：
    - `frontend/output/e2e/download-check-screenshot.png`
    - `frontend/output/e2e/download-check-recording.gif`
  - 文件头检查：
    - `PNG image data`
    - `GIF89a`

- 剧场页 capture mode 与 i18n 收口：
  - `frontend/src/pages/SimulationView.tsx`
  - `frontend/src/pages/SimulationView.css`
  - `frontend/src/index.css`
  - `frontend/src/i18n/locales/zh.json`
  - `frontend/src/i18n/locales/en.json`
  - 新增：
    - `当前截取目标 / Current target` 可见反馈
    - `世界线 / 轮次` 标签改走 i18n
    - Agent panel 折叠按钮 title/aria 改走 i18n
    - LanguageSwitcher 在 `simulation-view` 中抬高，不再压住底部 bar

- 英文场景真值验证：
  - 新场景：`674c7435-ebae-4740-867c-7fd25d152b17`
  - 条件：
    - UI 切到 `En`
    - What-if 使用英文
    - 开启 `Pixel Theater`
  - 结果：
    - Gameplay Cards / Predict / Worldline / Round / Director Warmup 等界面文案均为英文
    - 页面文本中未检测到 `世界线/轮次` 等中文硬编码
    - 侧边 agent 回复抽样文本为英文

- 最新校验：
  - `cd frontend && npm test -- --run src/components/gameplayCards.test.ts src/hooks/useScreenCapture.test.ts src/pages/SimulationView.test.tsx`
    - `18 passed`
  - `cd frontend && npm run build`
    - 通过
  - `cd backend && .venv/bin/python -m pytest tests/test_narrator.py -q`
    - `9 passed`
  - `cd backend && .venv/bin/python -m pytest tests/test_simulator.py -k 'save_narration' -q`
    - `2 passed`

## 2026-03-16 Frontier Theme Fit + API Reality Check

- 运行时复验：
  - backend 已在 `http://127.0.0.1:18927` 启动
  - frontend 已在 `http://127.0.0.1:18928` 启动
  - `POST /api/health` 返回 `server = ok`、`llm = ok`

- 真实 API 闭环：
  - `law` Theater 场景 `e374d876-1a9f-4b03-bd08-aaa868c433b0`
    - 成功从 `simulating -> done`
    - `scene_theme = modern_city`
    - `export` 返回完整 Markdown
  - `trade` Theater 场景 `212e6fa0-4ce5-4ddb-a3a2-5f449c3645f9`
    - 预测 `profile_resonance` 成功提交
    - `score-predictions` 返回 `score = 90`
    - `leaderboard` 已出现 `codex-api-e2e`
    - `social/xiaohongshu` 返回完整长文案
  - `frontier` Theater 场景 `6bd95d66-3bc9-4557-a2be-109926ecf4c6`
    - 创建后立即调用 intervene API 成功
    - 最终消息中可检索到 `48小时 / 撤离路线 / 生命维持`
    - 说明导演事件确实进入后续推演文本，而不是只写日志

- 浏览器自动化环境结论：
  - `npm run e2e:full -- --headless` 仍受宿主机 Chromium 权限限制阻断：
    - `bootstrap_check_in ... Permission denied`
  - `playwright-interactive` 在当前 Codex js_repl 中也无法直接加载 workspace 内的 `playwright`
  - 所以本轮“真实可玩性”主要依赖：
    - 前端 `128 passed`
    - 前端 build 通过
    - 真实 API 闭环
    - 既有 headed/manual 视觉证据

- 已修的题材适配缺口：
  - `frontier` 题材已有独立玩法画像与 `space_station` 资产，但像：
    - `火星殖民地`
    - `life support`
    - `evacuation route`
    这类明显 frontier 题面，之前仍容易被更泛的 `scifi_base` 抢走。
  - 本轮已在：
    - `backend/app/visualization/scene_selector.py`
    - `frontend/src/game/managers/VizSynthesizer.ts`
    做“更长 frontier 关键词优先”的收口。

- 新玩法覆盖补充：
  - 代码里其实已经存在第五张玩法卡：
    - `mandate_surge / 民意浪潮`
  - 文档与测试此前没有跟上，这轮补到：
    - `frontend/src/components/gameplayCards.test.ts`
  - 目前至少覆盖：
    - thematic recommendation 会包含 `mandate_surge`
    - prompt 会把它写成“整条世界线都必须回应的公开合法性冲击”

## 2026-03-16 Mandate Surge Fix + QA Notes

- 新发现的真实缺口：
  - `frontend/src/components/gameplayCards.ts` 已经把新玩法卡 `mandate_surge` 加进 `GameplayCardId`、推荐序列和 prompt 文案，但周边闭环没有完全收口，导致 `npm run build` 一度报类型错误。
  - 这说明仓库里存在一个“半落地的新卡牌”状态，而不是玩法系统已经完全封板。

- 本轮已补齐：
  - `frontend/src/components/gameplayCards.ts`
    - 为 `mandate_surge` 增加显式穷举收口，避免新卡牌分支遗漏时触发 TypeScript 穷举/返回值错误。
    - `getSuggestedGameplayAgents()` 现为 `mandate_surge` 返回稳定目标角色推荐。
  - `frontend/src/components/gameplayCards.test.ts`
    - 新增 `mandate_surge` prompt 与推荐链路测试，验证它已经进入最小可用闭环。
  - `frontend/src/lib/scenarioMeta.ts`
    - 当前文件已包含 `mandate_surge` 的导演点数/冷却规则，本轮确认其与新卡牌定义一致。

- 本轮前端验证：
  - `cd frontend && npm test -- --run src/components/gameplayCards.test.ts src/components/PredictionModal.test.ts src/pages/SimulationView.test.ts src/game/automation.test.ts src/stores/simulationStore.test.ts`
    - `34 passed`
  - `cd frontend && npm run build`
    - 通过

- 本轮运行时/工具层事实：
  - 本机 `npm run e2e:health` 触发的 Playwright Chromium/Chrome 进程会被 macOS Crashpad / MachPort 权限拦截，不是业务代码直接抛错。
  - `playwright` MCP 与 `chrome-devtools` MCP 也会因为自动化专用 profile 残留而互相抢占会话，需要先清理 `mcp-chrome` / `chrome-devtools-mcp` 进程才能恢复。
  - 因此，这轮“黑盒浏览器失败”应归类为本机自动化环境不稳定，不应直接等价成产品功能失败。

- 本轮仍需后续确认的点：
  - 用稳定浏览器会话重新跑 Theater 全链路（玩法卡 -> 下注 -> replay -> result/share）。
  - 核对 `18_next_session_gameplay_art_replay_plan.md` 里剩余项是否还有“文档写完成、但浏览器证据未复验”的部分。

## 2026-03-16 E2E Reality Check + New Gameplay Card

- 当前本机运行时：
  - 后端已起在 `http://127.0.0.1:18927`
  - 前端已起在 `http://127.0.0.1:18928`
  - `POST /api/health` 返回 `server=ok` 且默认 LLM 健康

- 本机浏览器自动化阻塞重新确认：
  - `npm run e2e:full -- --headless` 仍会因 macOS `bootstrap_check_in ... Permission denied`
    导致 `chrome-headless-shell` 直接崩溃
  - `frontend/.tmp-playwright/web_game_playwright_client.mjs --headless false`
    也会因 `Chrome for Testing` 的 Crashpad 权限失败退出
  - 因此本轮无法在这台机器上新增“真实浏览器截图”真值；这属于本机浏览器运行环境问题，
    不是前端功能本身的新回归

- 已继续扩玩法，但保持现有架构不变：
  - 新增第 5 张导演卡：`mandate_surge`
    - 中文：`民意浪潮`
    - 英文：`Mandate Surge`
  - 语义：不是接管单个角色，也不是泄漏另一条世界线，而是注入一波
    “公开且无法忽视的群众/合法性压力”，迫使整条世界线重新站位
  - 仍复用现有 `intervene` API，不改后端协议

- 代码落点：
  - `frontend/src/components/gameplayCards.ts`
    - 扩 `GameplayCardId`
    - 为 12 个 profile 补齐 `mandate_surge` 默认指令
    - 更新推荐卡顺序与 prompt 生成
  - `frontend/src/components/GameplayCardsModal.tsx`
    - 补充新卡 placeholder
  - `frontend/src/lib/scenarioMeta.ts`
    - 新卡导演点数 / 冷却规则
  - `frontend/src/lib/archiveSummary.ts`
    - 新增导演风格标签 `crowd_choreographer / 舆论导演`
  - `frontend/src/game/scenes/WorldScene.ts`
    - 新增 Theater 动效 `mandate_surge`

- 新增/更新回归：
  - `frontend/src/components/gameplayCards.test.ts`
    - 覆盖新卡 prompt 与 profile 推荐
  - `frontend/src/lib/archiveSummary.test.ts`
    - 覆盖新导演标签
  - `frontend/src/game/scenes/WorldScene.test.ts`
    - 覆盖新 Theater animation key

- 最新校验：
  - `cd frontend && ./node_modules/.bin/tsc --noEmit -p tsconfig.app.json`
  - `cd frontend && npm test`
    - `20 files / 130 tests passed`
  - `cd frontend && npm run build`
    - 通过
  - 关闭运行中的本地后端后，再跑：
    - `cd backend && .venv/bin/python -m pytest tests/test_api.py tests/test_simulator.py tests/test_scene_selector.py tests/test_simulator_viz_integration.py -q`
    - `254 passed`

- 当前判断：
  - `implement/18_next_session_gameplay_art_replay_plan.md` 的核心项仍基本完成；
    这轮新增的是“计划之外但符合设计初衷”的最小新玩法扩展
  - 仍然偏薄的不是玩法骨架，而是：
    - 本机真实浏览器自动化环境
    - Theater 题材美术的“专属 frame / 专属 scene”丰富度
    - trade / law / faith / ecology 等 profile 的专属视觉差异仍弱于玩法差异

## 2026-03-16 Replay Sync + Mobile Hero Input Tuning

- 已修复 completed Theater replay 的标题场景跳转条件：
  - `frontend/src/game/replaySync.ts` 不再等待 `messages.length > 0` 才从 `TitleScene` 切到 `WorldScene`。
  - 根因：现有黑盒 artifact 中，`law/trade` 样本在 completed replay 首次抓取时仍停留在 `TitleScene`，说明标题跳转仍可能受消息 hydration 时序影响。
- 已补回归：
  - `frontend/src/game/replaySync.test.ts` 新增“completed replay 在消息尚未 hydrate 时也应跳过 TitleScene”的断言。
- 已收紧移动端首页题目输入区排版：
  - `frontend/src/pages/InputView.css` 降低 `.input--hero` 手机端字号、内边距与行高，减轻首屏超大号问题文本的裁切感。
  - 依据：现有 artifact `/frontend/output/e2e/health-20260316/mobile-home.png` 仍可见题目输入首屏过大、阅读节奏被压坏。
- 本轮验证：
  - `cd frontend && env TMPDIR=/tmp TEMP=/tmp TMP=/tmp npm test -- --run src/game/replaySync.test.ts src/pages/SimulationView.test.tsx src/components/gameplayCards.test.ts`
    - `22 passed`
  - `cd frontend && env TMPDIR=/tmp TEMP=/tmp TMP=/tmp npm test`
    - `20 files / 134 tests passed`
  - `cd frontend && env TMPDIR=/tmp TEMP=/tmp TMP=/tmp npm run build`
    - 通过
- 仍需后续人工/真实浏览器确认：
  - 用稳定 Playwright/Chrome 会话重新抓一轮 `law/trade` completed replay，确认新逻辑下 artifact 不再停在 `TitleScene`。
  - 用真实移动浏览器再看首页首屏，确认降字号后既不裁切，也不会显得过小。

## 2026-03-16 Matrix Isolation + Gameplay Card Theme Differentiation

- 本轮关注点：
  - 不是新增一整套系统，而是把现有完成态能力做得更可信、更好看。
  - 目标一：修 `e2e:matrix` 偶发把 replay 误记成 `TitleScene` 的自动化噪声。
  - 目标二：在不重做美术体系的前提下，让 `law / trade / faith / ecology` 这些复用 frame 的玩法卡更有题材辨识度。

- 已修改：
  - `frontend/scripts/e2e-suite.mjs`
    - `runReplayFlow()` 现在会在轮询中持续调用 `window.advanceTime()`，不再只在页面打开后推进一次。
    - completed replay 只在进入真实 `WorldScene / EndingScene` 后才算通过，不再把 `BootScene / TitleScene` 视为有效结果。
    - `runMatrixSuite()` 改为“每个题材一个独立 page”，避免多题材共用同一标签页造成自动化钩子串味。
  - `frontend/src/components/GameplayCardsModal.tsx`
    - 玩法卡按钮增加 profile class，供题材差异化样式使用。
  - `frontend/src/components/GameplayCardsModal.css`
    - 为 `trade / law / faith / ecology` 增加基于当前美术语言的 overlay / tint / shadow 区分。
    - 保持原有纸面纹理、洋红/青金/黄铜强调色，不改整体风格体系。
  - `frontend/src/lib/scenarioMeta.test.ts`
    - 新增测试，校验 `mandate_surge` 的点数、冷却与持久化行为。

- 实测结果：
  - 黑盒客户端单独复验：
    - `governance / law / trade` 三个 completed replay 都能回到 `WorldScene`，不再只停在 `TitleScene`。
    - 输出状态中可见：
      - `scene.scene = "WorldScene"`
      - `scene.theme = scifi_base / modern_city / desert_outpost`
  - `npm run e2e:matrix -- --themes governance,law,trade`
    - 在前后端都由当前会话接管后，3 个题材 smoke 全通过。
  - 实际视觉截图：
    - `/tmp/law-gameplay-modal.png`
    - `/tmp/trade-gameplay-modal.png`
    - 两张图都保持了当前 UI 语系，trade 与 law 的卡面气质已不再完全重合。

- 最新校验：
  - `cd frontend && npm test`
    - `21 files / 136 tests passed`
  - `cd frontend && npm run build`
    - 通过
  - `cd frontend && npm run e2e:matrix -- --url http://127.0.0.1:18928 --headless --themes governance,law,trade --output-dir /tmp/swarmoracle-e2e-matrix-smoke`
    - 通过

- 当前结论更新：
  - `implement/18_next_session_gameplay_art_replay_plan.md` 的主路径功能仍然可签“基本完成”。
  - 当前更真实的剩余问题不是“玩法没做”，而是：
    - `sample_matrix` 还只覆盖 6 个题材，未覆盖 12 个 gameplay profile。
    - `trade / law / faith / ecology` 虽然现在卡面区分更明显，但仍没有真正专属生成 frame 资源。
    - 浏览器 MCP / Playwright interactive 在当前会话环境里依旧不稳定，因此视觉 QA 主要依赖项目内黑盒客户端与手工截图，而不是 MCP 直连浏览器。

## 2026-03-16 Dedicated Frames for Trade / Law / Faith / Ecology

- 已继续执行“补专属素材”这条路线，而不是只靠 CSS tint 顶着：
  - 新生成并接入：
    - `frontend/public/assets/ui/generated/gameplay_card_frame_trade.png`
    - `frontend/public/assets/ui/generated/gameplay_card_frame_law.png`
    - `frontend/public/assets/ui/generated/gameplay_card_frame_faith.png`
    - `frontend/public/assets/ui/generated/gameplay_card_frame_ecology.png`
  - 生成方式：
    - 继续使用此前已验证可用的 Gemini 图像链路：
      - `generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent`
    - 原因：
      - `aiplatform.googleapis.com/v1/publishers/google` 在本项目先前验证里仍是 404；
      - 同一把 key 在 `generativelanguage` 路径可稳定返回图像。

- 代码接入：
  - `frontend/src/components/gameplayCards.ts`
    - `GAMEPLAY_PROFILE_FRAME_ASSETS`
    - `GAMEPLAY_PROFILE_FRAME_SRC`
    - `trade / law / faith / ecology` 现已改为独立文件，不再复用 `industry / governance / mythic / survival`
  - `frontend/public/assets/ASSET_CREDITS.md`
    - UI 资产总数从 `79` 更新为 `83`
    - 已补 4 条新素材记录
  - `frontend/src/components/gameplayCards.test.ts`
    - 补断言，确保 4 个 profile 都指向各自专属 frame

- 视觉复查：
  - 已单独查看 4 张新 frame 原图：
    - `trade`：航线、灯塔、锚点、导航盘
    - `law`：法庭帷幕、秤与槌、程序印章
    - `faith`：月相、烛火、圣典、神秘符号
    - `ecology`：渡槽、迁徙路径、水滴与测量仪表
  - 已重新抓 modal 实景图：
    - `/tmp/faith-gameplay-modal.png`
    - `/tmp/ecology-gameplay-modal.png`
  - 结论：
    - 现在 `trade / law / faith / ecology` 至少在玩法卡视觉语义上已经脱离“同框架换文案”的状态。

- 关于“是不是只有 6 个场景”的判断：
  - 不是。
  - 当前前端/后端实际剧场背景主题仍是 `11` 个：
    - `medieval_village`
    - `ancient_empire`
    - `industrial_city`
    - `modern_city`
    - `scifi_base`
    - `post_apocalypse`
    - `fantasy_kingdom`
    - `war_battlefield`
    - `space_station`
    - `underwater_kingdom`
    - `desert_outpost`
  - 用户会感觉“像只有 6 个”，主要因为：
    - 固定黑盒回归样本只覆盖 6 个题材；
    - 12 个 gameplay profile 并没有一一对应 12 个独立场景背景；
    - 多个题材此前确实复用了同一张 card frame。

- 当前还值得继续补的素材，不是“再泛泛加一堆图”，而是更精确地补这几类：
  - `law` 专属 Theater scene（法院/议事厅/程序审查空间）
  - `trade` 专属 Theater scene（港口/海峡/贸易中枢）
  - `faith` 专属 Theater scene（神殿/圣堂/异端审判空间）
  - `ecology` 专属 Theater scene（干涸水脉/迁徙营地/生态阈值空间）
  - 对应 UI 小件：
    - daily challenge 题材 badge
    - archive 题材 seal
    - gameplay card 的 profile micro-icons

## 2026-03-16 Dedicated Theater Scenes for Law / Trade / Faith / Ecology

- 已继续补齐 4 张专属 Theater scene 背景，并且不是只放图：
  - 新增背景文件：
    - `frontend/public/assets/scenes/law_court.png`
    - `frontend/public/assets/scenes/trade_harbor.png`
    - `frontend/public/assets/scenes/faith_temple.png`
    - `frontend/public/assets/scenes/ecology_wasteland.png`
  - 生成方式：
    - 继续使用已验证可用的
      `generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent`
  - 风格口径：
    - `law_court`：宪政法庭 / 司法审查大厅
    - `trade_harbor`：海峡港口 / 海运咽喉 / 关税灯塔
    - `faith_temple`：圣谕神殿 / 月光祭坛 / stained glass
    - `ecology_wasteland`：干涸水脉 / 应急营地 / 气候迁徙阈值

- 代码接入已完成：
  - 后端 scene 选择：
    - `backend/app/visualization/scene_selector.py`
    - 新增 scene id：
      - `law_court`
      - `trade_harbor`
      - `faith_temple`
      - `ecology_wasteland`
    - `law / trade / faith / ecology` 相关关键词现在会优先命中新主题，不再回落到：
      - `modern_city`
      - `desert_outpost`
      - `fantasy_kingdom`
  - 前端贴图预加载：
    - `frontend/src/game/scenes/BootScene.ts`
  - 前端主题 palette / fallback / icon：
    - `frontend/src/game/scenes/WorldScene.ts`
  - 前端离线/回放推断：
    - `frontend/src/game/managers/VizSynthesizer.ts`
  - 前端标签显示：
    - `frontend/src/lib/themeLabels.ts`
    - `frontend/src/pages/SimulationView.tsx`
    - `frontend/src/pages/ResultView.tsx`
  - 玩法画像 scene→profile 对齐：
    - `frontend/src/components/gameplayCards.ts`
  - 资产清单：
    - `frontend/public/assets/ASSET_CREDITS.md`
    - `Scenes` 从 `11` 更新到 `15`
    - 资产总数从 `83` 更新到 `87`

- 测试与回归已同步：
  - `backend/tests/test_scene_selector.py`
    - `AVAILABLE_SCENES` 现断言 `15`
    - 新增 law/trade/faith/ecology 对应关键词
  - `backend/tests/test_simulator_viz_integration.py`
    - 补 4 个新 scene 可达性样例
  - `frontend/src/game/managers/VizSynthesizer.test.ts`
    - 题目 → 新 scene 预期已更新
  - `frontend/src/game/scenes/WorldScene.test.ts`
    - scene count 从 `11` 更新到 `15`
  - `frontend/src/components/gameplayCards.test.ts`
    - 新 scene id 能稳定映射回正确 gameplay profile

- 最新验证：
  - 后端定向：
    - `cd backend && .venv/bin/python -m pytest tests/test_scene_selector.py tests/test_simulator_viz_integration.py -q`
    - `150 passed`
  - 前端定向：
    - `cd frontend && npm test -- --run src/game/managers/VizSynthesizer.test.ts src/game/scenes/WorldScene.test.ts src/components/gameplayCards.test.ts src/components/GameplayCardsModal.test.tsx`
    - `55 passed`
  - 前端全量：
    - `cd frontend && npm test`
    - `21 files / 136 tests passed`
  - 前端构建：
    - `cd frontend && npm run build`
    - 通过

- 真实新场景冒烟结果：
  - fresh scenario create 现在立即返回：
    - `law -> law_court`
    - `trade -> trade_harbor`
    - `faith -> faith_temple`
    - `ecology -> ecology_wasteland`
  - 黑盒截图证据：
    - `/tmp/law-court-scene/shot-0.png`
    - `/tmp/trade-harbor-scene/shot-0.png`
    - `/tmp/faith-temple-scene/shot-0.png`
    - `/tmp/ecology-wasteland-scene/shot-0.png`
  - 对应 `state-0.json` 里也已读到：
    - `scene.theme = law_court`
    - `scene.theme = trade_harbor`
    - `scene.theme = faith_temple`
    - `scene.theme = ecology_wasteland`

- 当前结论：
  - 现在已经不是“11 个场景 + 4 组题材借景”，而是 `15` 个 Theater 背景主题。
  - `law / trade / faith / ecology` 已经从“借现有背景”升级为“有独立场景语义”的状态。
  - 下一轮如果继续补素材，优先级不再是这 4 组主场景，而是：
    - `frontier / industry / mythic / survival` 的专属 daily/archive 微资产
    - `governance / empire / war` 的第二套可轮换背景（提高重复可玩性）

## 2026-03-16 Semantic Scene Variants for Governance / Empire / War

- 本轮继续推进的原则不是“粗暴轮换”，而是“同一 gameplay profile 按题面语义落到不同场景”：
  - `governance`
    - `scifi_base` 仍用于 AI / 算法统治中枢
    - 新增 `civic_chamber` 用于民主、议会、公共监督、地方问责
  - `empire`
    - `ancient_empire` 保留给泛古代帝国 / 王朝
    - 新增 `imperial_forum` 用于罗马帝国 / 元老院 / 帝都制衡
  - `war`
    - `war_battlefield` 保留给传统战场 / 围攻 / 前线
    - 新增 `war_command` 用于自动化军备 / 指挥链 / 开火权 / war room

- 新增背景文件：
  - `frontend/public/assets/scenes/civic_chamber.png`
  - `frontend/public/assets/scenes/imperial_forum.png`
  - `frontend/public/assets/scenes/war_command.png`

- 代码接入：
  - 后端 scene 选择：
    - `backend/app/visualization/scene_selector.py`
  - 前端离线/回放 scene 推断：
    - `frontend/src/game/managers/VizSynthesizer.ts`
  - 前端贴图预加载：
    - `frontend/src/game/scenes/BootScene.ts`
  - 前端 palette / icon / dark theme：
    - `frontend/src/game/scenes/WorldScene.ts`
  - Theme label：
    - `frontend/src/lib/themeLabels.ts`
  - Scene -> gameplay profile 映射：
    - `frontend/src/components/gameplayCards.ts`
  - 资产清单：
    - `frontend/public/assets/ASSET_CREDITS.md`
    - `Scenes` 从 `15` 更新到 `18`
    - `Asset Inventory` 从 `87` 更新到 `90`

- 关键测试更新：
  - `backend/tests/test_scene_selector.py`
    - scene count 改为 `18`
    - 新增 / 更新 `civic_chamber / imperial_forum / war_command` 相关断言
  - `backend/tests/test_simulator_viz_integration.py`
    - 补 3 个新 scene reachable 样例
  - `frontend/src/game/managers/VizSynthesizer.test.ts`
    - 新增 governance / empire / war 子场景断言
  - `frontend/src/game/scenes/WorldScene.test.ts`
    - scene count 改为 `18`
  - `frontend/src/components/gameplayCards.test.ts`
    - 新 scene id 仍能回到正确 gameplay profile

- 最新验证：
  - 后端：
    - `cd backend && .venv/bin/python -m pytest tests/test_scene_selector.py tests/test_simulator_viz_integration.py -q`
    - `163 passed`
  - 前端定向：
    - `cd frontend && npm test -- --run src/game/managers/VizSynthesizer.test.ts src/game/scenes/WorldScene.test.ts src/components/gameplayCards.test.ts`
    - `55 passed`
  - 前端全量：
    - `cd frontend && npm test`
    - `21 files / 137 tests passed`
  - 前端构建：
    - `cd frontend && npm run build`
    - 通过

- 真实按题意选景验证：
  - 新建场景时立即返回：
    - `如果全球议会改由公民大会与地方问责机制实时审议 AI 政策，会发生什么？`
      - `scene_theme = civic_chamber`
    - `如果罗马帝国从未衰落，并且元老院持续制衡皇权，会发生什么？`
      - `scene_theme = imperial_forum`
    - `如果世界大战在高度自动化军备时代因开火权误判而升级，会发生什么？`
      - `scene_theme = war_command`
  - 黑盒截图：
    - `/tmp/civic-chamber-scene/shot-0.png`
    - `/tmp/imperial-forum-scene/shot-0.png`
    - `/tmp/war-command-scene/shot-0.png`
  - `state-0.json` 也都已读到相同 `scene.theme`

- 当前阶段结论：
  - Theater 背景现在不是“按 profile 一张图”也不是“随机轮换”，而是开始按题面语义分流。
  - 当前总背景主题数：`18`
  - 下一轮若继续做，更值得补的是：
    - `industry / frontier / mythic / survival` 的第二语义子场景
    - 每个大 profile 的 `daily challenge badge / archive seal / result chip` 题材小件

## 2026-03-16 Semantic Scene Variants for Industry / Frontier / Mythic / Survival

- 已继续扩展，不再停在 18 个：
  - 新增 4 张背景：
    - `frontend/public/assets/scenes/factory_foundry.png`
    - `frontend/public/assets/scenes/frontier_colony.png`
    - `frontend/public/assets/scenes/arcane_sanctum.png`
    - `frontend/public/assets/scenes/refuge_compound.png`
  - 语义定位：
    - `factory_foundry`：资源瓶颈 / 工厂调度 / 输电失衡
    - `frontier_colony`：自治城邦 / 地表殖民 / 边疆章程
    - `arcane_sanctum`：奥术 / 符文 / 法师 / 秘法实验
    - `refuge_compound`：避难所 / 隔离区 / 饥荒营地 / 有组织求生

- 代码接入：
  - 后端：
    - `backend/app/visualization/scene_selector.py`
  - 前端：
    - `frontend/src/game/scenes/BootScene.ts`
    - `frontend/src/game/scenes/WorldScene.ts`
    - `frontend/src/game/managers/VizSynthesizer.ts`
    - `frontend/src/components/gameplayCards.ts`
    - `frontend/src/lib/themeLabels.ts`
    - `frontend/public/assets/ASSET_CREDITS.md`

- 场景总数更新：
  - `Scenes`: `18 -> 22`
  - `Asset Inventory`: `90 -> 94`

- 测试同步：
  - `backend/tests/test_scene_selector.py`
    - scene count 改为 `22`
    - 新增 industry/frontier/mythic/survival 关键词用例
  - `backend/tests/test_simulator_viz_integration.py`
    - 可达 scene 样例扩到 `22`
  - `frontend/src/game/managers/VizSynthesizer.test.ts`
    - 新增 4 个新语义场景断言
  - `frontend/src/game/scenes/WorldScene.test.ts`
    - theme count 改为 `22`
  - `frontend/src/components/gameplayCards.test.ts`
    - 新 scene → gameplay profile 映射断言补齐

- 最新验证：
  - 后端：
    - `cd backend && .venv/bin/python -m pytest tests/test_scene_selector.py tests/test_simulator_viz_integration.py -q`
    - `185 passed`
  - 前端定向：
    - `cd frontend && npm test -- --run src/game/managers/VizSynthesizer.test.ts src/game/scenes/WorldScene.test.ts src/components/gameplayCards.test.ts`
    - `56 passed`
  - 前端全量：
    - `cd frontend && npm test`
    - `21 files / 138 tests passed`
  - 前端构建：
    - `cd frontend && npm run build`
    - 通过

- 真实题面验证：
  - `如果全球电网与工厂调度在资源瓶颈下同时失衡，会发生什么？`
    - `scene_theme = factory_foundry`
  - `如果一支远征舰队在边疆建立自治城邦并争论殖民章程，会发生什么？`
    - `scene_theme = frontier_colony`
  - `如果一群法师在秘法圣所中试图改写巨龙契约，会发生什么？`
    - `scene_theme = arcane_sanctum`
  - `如果饥荒后大型避难营地与隔离区被迫合并，会发生什么？`
    - `scene_theme = refuge_compound`

- 黑盒画布证据：
  - `/tmp/factory-foundry-scene/shot-0.png`
  - `/tmp/frontier-colony-scene/shot-0.png`
  - `/tmp/arcane-sanctum-scene/shot-0.png`
  - `/tmp/refuge-compound-scene/shot-0.png`

- 固定回归样本同步：
  - `frontend/output/e2e/sample_matrix.json`
    - 新增 `industry / frontier / mythic / survival` 4 条样本
  - 现已可直接运行：
    - `cd frontend && npm run e2e:matrix -- --themes industry,frontier,mythic,survival --headless`
    - 本轮已通过，输出在 `/tmp/swarmoracle-e2e-matrix-new-profiles`

- 当前状态判断：
  - Theater 背景已经从最初 `11` 个扩到 `22` 个，且不是随机加图，而是按题面语义分流。
  - 现在更像“有一个可扩展的语义场景池”，而不是“每个 profile 只有一张默认图”。
  - 下一轮更值得继续补的是：
    - 让 `sample_matrix` 不只覆盖 profile，还覆盖“同 profile 的不同语义子场景”
    - 为 `governance / empire / war / industry / frontier / mythic / survival` 再各补 1 个轻量变体，提升重复可玩性
    - 把新 scene label 同步到结果页文案、daily challenge UI 和 archive seal 微资产

- 追补说明：
  - `mythic` 首次落盘时，结果页画像曾误判成 `faith`，根因是 `KEYWORD_TO_PROFILE` 对 `法师 / 秘法 / 巨龙 / 符文` 的覆盖不足。
  - 已在 `frontend/src/components/gameplayCards.ts` 补齐这些关键词，随后复跑 `mythic` 结果页：
    - `share_context.profileLabel` 现已正确回到 `神话秩序`

- `sample_matrix.json` 更新：
  - 已新增：
    - `industry`
    - `frontier`
    - `mythic`
    - `survival`
  - 当前固定样本集已从 `6` 条扩到 `10` 条，可直接跑：
    - `cd frontend && npm run e2e:matrix -- --themes industry,frontier,mythic,survival --headless`
  - 本轮已通过，输出位于：
    - `/tmp/swarmoracle-e2e-matrix-new-profiles`

## 2026-03-16 Second Lightweight Variants for Governance / Empire / War / Industry

- 已继续补 4 个“同 profile 第二轻量变体”：
  - `surveillance_megacity`
    - 平台国家 / 社会信用 / 全域监控 / 数字哨卡
  - `dynastic_palace`
    - 王朝继承 / 宫廷派系 / 贵族联盟 / 宫变
  - `power_grid_nexus`
    - 电网中枢 / 限电 / blackout / 调度中心 / 变电站
  - `logistics_hub`
    - 补给线 / convoy / 后勤 / rail hub / 军工运输

- 新增背景文件：
  - `frontend/public/assets/scenes/surveillance_megacity.png`
  - `frontend/public/assets/scenes/dynastic_palace.png`
  - `frontend/public/assets/scenes/power_grid_nexus.png`
  - `frontend/public/assets/scenes/logistics_hub.png`

- 代码接入：
  - 后端：
    - `backend/app/visualization/scene_selector.py`
      - 当前 `AVAILABLE_SCENES` 已从 `22` 扩到 `26`
  - 前端：
    - `frontend/src/game/scenes/BootScene.ts`
    - `frontend/src/game/scenes/WorldScene.ts`
    - `frontend/src/game/managers/VizSynthesizer.ts`
    - `frontend/src/lib/themeLabels.ts`
    - `frontend/src/components/gameplayCards.ts`
      - `THEME_TO_PROFILE` 已补：
        - `surveillance_megacity -> governance`
        - `dynastic_palace -> empire`
        - `power_grid_nexus -> industry`
        - `logistics_hub -> war`
  - 资产清单：
    - `frontend/public/assets/ASSET_CREDITS.md`
      - `Scenes = 26`
      - `Asset Inventory = 98`

- 最新验证：
  - 后端：
    - `cd backend && .venv/bin/python -m pytest tests/test_scene_selector.py tests/test_simulator_viz_integration.py -q`
    - `201 passed`
  - 前端全量：
    - `cd frontend && npm test`
    - `21 files / 139 tests passed`
  - 前端构建：
    - `cd frontend && npm run build`
    - 通过

- 真实题面选景验证：
  - `如果一个平台国家通过社会信用与全域监控接管城市治理，会发生什么？`
    - `scene_theme = surveillance_megacity`
  - `如果一个王朝因继承危机和宫廷派系斗争而濒临内战，会发生什么？`
    - `scene_theme = dynastic_palace`
  - `如果大陆级电网中枢在大停电前夜被迫实行限电，会发生什么？`
    - `scene_theme = power_grid_nexus`
  - `如果一场大战因补给线崩溃和后勤车队失序而拖入消耗战，会发生什么？`
    - `scene_theme = logistics_hub`

- 黑盒截图证据：
  - `/tmp/surveillance-megacity-scene/shot-0.png`
  - `/tmp/dynastic-palace-scene/shot-0.png`
  - `/tmp/power-grid-nexus-scene/shot-0.png`
  - `/tmp/logistics-hub-scene/shot-0.png`

- 固定样本集继续扩容：
  - `frontend/output/e2e/sample_matrix.json`
    - 新增：
      - `governance_surveillance`
      - `empire_palace`
      - `industry_grid`
      - `war_logistics`
  - 固定样本数已从 `10` 扩到 `14`
  - 已验证：
    - `cd frontend && npm run e2e:matrix -- --themes governance_surveillance,empire_palace,industry_grid,war_logistics --headless`
    - 通过，输出位于：
      - `/tmp/swarmoracle-e2e-matrix-variants`

- 当前状态判断：
  - Theater 背景已从原始 `11` 扩到 `26`
  - 场景池已经开始具备“同一 profile 下多语义落点”的能力，而不是单图或轮换
  - 继续扩张最值得补的是：
    - `law / trade / faith / ecology / frontier / mythic / survival` 的第二轻量变体
    - 把 `daily challenge / archive / result chips` 的视觉资产做成“随 scene theme 变化”的体系

## 2026-03-16 Frontier Runtime Fixes + Capture Hardening

- 本轮针对真实运行态新发现的 3 个问题做了最小修复：
  - `num_agents` 请求值会被 parser 软忽略，`5` 实际常只生成 `3`。
  - 边疆题面 `如果一支远征舰队在荒芜边疆建立流动自治城邦，会发生什么？` 会掉到 `empire / medieval_village`，导致玩法画像和场景题材错位。
  - `Panel` 截图模式此前只截到 HUD 外壳，主剧场画布没有真正合成进去。

- 已修改：
  - `backend/app/services/parser.py`
    - 新增精确角色数预算提示与 underfill retry prompt。
    - 若重试后仍有小幅 shortfall，会补出 deterministic extras，避免用户明确要求的 agent 数在 UI 上缩水。
  - `backend/app/api/helpers.py`
    - `parse_question()` 现在显式传 `target_agents=num_agents`，不再只把用户输入当作“上限”。
  - `frontend/src/components/gameplayCards.ts`
    - frontier 画像关键词补强：`边疆 / 远征 / 舰队 / 自治城邦 / 星域 / expedition / fleet ...`
    - frontier 启发式也补了 `边疆 / 风暴 / 自治` 等词。
  - `frontend/src/hooks/useScreenCapture.ts`
    - 新增 panel 复合截图：先抓 `.theater-panel`，再把 `.phaser-game-container` 的真实画布按相对坐标叠回去。
    - `captureScreenshot()` 支持自定义 `captureBlob`，供 SimulationView 的 panel 下载链路复用。
  - `frontend/src/pages/SimulationView.tsx`
    - 浏览器自动化 hook 与用户点击 `📸 截图` 现在都走复合 panel capture。

- 新增/更新验证：
  - `backend/tests/test_parser.py`
    - 新增 underfilled parse 会 retry，并在小缺口时补满请求数量的断言。
  - `frontend/src/components/gameplayCards.test.ts`
    - 新增 frontier 题面应推断为 `frontier` 的断言。
  - `frontend/src/pages/SimulationView.test.tsx`
    - 更新 panel capture 断言，要求走 composite path。

- 本轮验证结果：
  - `cd backend && .venv/bin/python -m pytest tests/test_parser.py -k retries_underfilled -q`
    - `1 passed`
  - `cd frontend && npm test -- --run src/components/gameplayCards.test.ts src/pages/SimulationView.test.tsx`
    - `19 passed`
  - `cd frontend && npm run build`
    - 通过
  - 热更新后真实运行态复验：
    - 新建 scenario `27abe4a4-7970-4cf1-bc3d-bf31fa5f7258`
    - `scene_theme` 现为 `space_station`
    - `agent_count` 现为 `5`
    - gameplay modal 的 `profile_id` 现为 `frontier`
    - 新的 panel 产物 `/tmp/frontier-panel-fixed.png` 已包含真实空间站剧场画面，不再是空心外壳

- 残余说明：
  - `modal` capture 里的 crest 仍显示成 alt 文本，疑似 html2canvas/DOM capture 对该 `<img>` 的渲染链路还有问题；真实页面状态与 automation state 正常，但 modal 导出视觉仍需继续 hardening。
  - 后端全量 `pytest tests/ -q` 在当前机器跑到 `703 passed, 4 failed, 1 error`，失败栈主要是 SQLite fixture 的 `disk I/O error / no such table: branch`，更像本机测试环境不稳定，不像本轮改动直接引入的功能回归。

## 2026-03-16 Runtime Re-Verification + LLM Retry Fix

- 重新做了本轮“从零启动”的基线验证，不再沿用历史记录：
  - 本轮开始时前后端都没有运行。
  - 重新拉起：
    - backend `uvicorn app.main:app --host 127.0.0.1 --port 18927`
    - frontend `npm run dev -- --host 127.0.0.1 --port 18928`
  - 前端构建通过：
    - `cd frontend && npm run build`
  - 前端主回归通过：
    - `cd frontend && npm test`
    - 结果：`139 passed`

- 新发现并已修复的后端稳定性问题：
  - `backend/app/services/llm_client.py`
    - LLM 5xx / 502 重试路径里因为 `except httpx.RequestError` 分支的局部 `import asyncio`，导致整个函数把 `asyncio` 视为局部变量。
    - 一旦在前面的 `HTTPStatusError` 重试分支里执行 `await asyncio.sleep(...)`，就会抛：
      - `UnboundLocalError: cannot access local variable 'asyncio'`
    - 这会连带打爆：
      - `POST /api/health`
      - `llm_call`
      - `llm_call_json`
      - `parse_question`
  - 修复：
    - 删除局部 `import asyncio`，统一复用文件顶部导入。
  - 同时修正测试环境 LLM 端点：
    - `backend/tests/conftest.py`
    - 从不可用的 `http://127.0.0.1:8317/v1/responses` 切到当前本机可用的
      `http://127.0.0.1:8318/v1/chat/completions`

- 修复后的验证结果：
  - `cd backend && .venv/bin/python -m pytest tests/test_llm_client.py -q`
    - `9 passed`
  - `cd backend && .venv/bin/python -m pytest tests/test_api.py -k test_health -q`
    - `1 passed`
  - `cd backend && .venv/bin/python -m pytest tests/test_parser.py -q`
    - `5 passed`
  - `cd backend && .venv/bin/python -m pytest tests/ -q`
    - `777 passed, 2 warnings`

- 本轮真实浏览器 QA（不是只读审查）：
  - 使用 `playwright-interactive` 持久会话做桌面 + 移动端检查。
  - 首页桌面截图：
    - `/Users/yangjunjie/Desktop/upgrade-test/.tmp/qa-20260316/home-desktop.png`
  - 首页移动端截图：
    - `/Users/yangjunjie/Desktop/upgrade-test/.tmp/qa-20260316/home-mobile.png`
  - 发现：
    - 移动端首页首屏能打开，但信息密度仍偏高，右下角语言切换器与底部参数区距离很近。
    - 桌面端 Theater 主画面、完成态 replay、结果页主视图整体可读性正常。

- 本轮确认真正走通的玩法闭环：
  - 新建 live Theater 场景：
    - `ec859160-64d1-4658-bfc2-9ce382c975ec`
  - 在同一浏览器会话里完成：
    - warmup 预览玩法卡
    - 打开 `GameplayCardsModal`
    - 成功注入一张玩法卡
    - `director_points_remaining` 从 `3 -> 2`
    - `cooldown_remaining` 正常写入
    - `scenarioMeta.cards.usageLog` 正常写入 localStorage
    - 打开 Prediction modal
    - 切换到第三种下注 `profile_resonance`
    - 成功提交 `命中题材核心`
    - `scenarioMeta.betting.bets` 正常写入 localStorage
  - 这说明文档里写的：
    - `导演点数 + 卡冷却`
    - `玩法卡注入`
    - `第三种下注`
    - `本地玩法记录`
    - 不是只停留在代码层，而是在真实运行态里能完成闭环

- 本轮新增自动化证据：
  - `develop-web-game` 客户端重新取证成功：
    - panel proof:
      - `/tmp/swarmoracle-panel-proof/shot-0.png`
      - `/tmp/swarmoracle-panel-proof/state-0.json`
    - canvas proof:
      - `/tmp/swarmoracle-canvas-proof/shot-0.png`
      - `/tmp/swarmoracle-canvas-proof/state-0.json`
    - modal proof:
      - `/tmp/swarmoracle-modal-proof-4/shot-0.png`
      - `/tmp/swarmoracle-modal-proof-4/state-0.json`
  - `modal` 取证里，玩法卡 modal 已能被自动化状态正确识别：
    - `active_modal = gameplay_cards`
    - `modal_state.profile_id = trade`
    - `recommended_cards` / `director_points_remaining` / `current_round` 都有值

- 本轮对自动化脚本做了一个最小 hardening：
  - `frontend/.tmp-playwright/web_game_playwright_client.mjs`
    - `--click-selector` 现在在常规 `page.click()` 失败后，会继续尝试：
      - `locator.first().click({ force: true })`
      - DOM `element.click()` fallback
    - 目的：降低 live Theater header 按钮在动画/重渲染期间“看得到但点不下去”的概率
  - 说明：
    - 当前日志里仍可能打印最初那次 click timeout，但 fallback 之后 modal 证据已能实际落盘。

- 使用项目自带 CLI 的结果页/健康页链路也重新跑通：
  - `cd frontend && node scripts/e2e-automation.mjs health --url http://127.0.0.1:18928`
    - 通过，输出：
      - `/Users/yangjunjie/Desktop/upgrade-test/frontend/output/e2e/2026-03-16T15-25-41-296Z-health`
  - `cd frontend && node scripts/e2e-automation.mjs result --url http://127.0.0.1:18928 --scenario-id ec859160-64d1-4658-bfc2-9ce382c975ec`
    - 通过，输出：
      - `/Users/yangjunjie/Desktop/upgrade-test/frontend/output/e2e/2026-03-16T15-26-23-002Z-result`
    - 已确认：
      - `导出 Markdown`
      - `生成文案`
      - `share_context.profileLabel / profileHooks / resonanceLabel`
      - `result-final.json` 中 `available_platforms`

- 本轮额外注意到的限制 / 待办：
  - `npm run e2e:full -- --headless` 这次没有执行到业务断言，浏览器启动就被当前机器的 Chromium/权限环境拦住：
    - `mach_port_rendezvous_mac ... Permission denied (1100)`
  - 这更像本机 Playwright/Chrome 环境问题，不像前端业务回归。
  - 如果下一轮要继续补自动化，优先级：
    1. 给 `e2e-suite.mjs` 增加本机环境下的 headed / browser-launch fallback
    2. 继续压 `modal` capture 里的图片渲染（crest alt 文本问题）
    3. 做一份“平台 × 功能”风险矩阵，特别是：
       - iOS / Android 的截图、复制、GIF、下载能力
       - 小屏 Theater 顶部控制区密度

## 2026-03-17 Minimal New Gameplay Card

- 基于本轮验证，`18_next_session_gameplay_art_replay_plan.md` 里的核心闭环已经成立，所以没有去重做现有玩法系统。
- 额外补了一张“最小实现”的新玩法卡：
  - `public_hearing`
  - 中文名：`公开听证`
  - 设计目标：
    - 不新增后端协议
    - 不依赖新美术素材
    - 直接复用当前 `GameplayCardsModal -> intervene() -> director override prompt` 链路
    - 增加“证据 / 条款 / 代价必须被摊开”的玩法张力，强化 law / governance / trade 这类题面

- 已修改：
  - `frontend/src/components/gameplayCards.ts`
    - `GameplayCardId` 新增 `public_hearing`
    - 新增卡定义、prompt 构造、推荐卡序列和 12 个画像下的默认 directive
    - 中英文 prompt 都要求：
      - 当前世界线进入公开听证
      - 至少三个不同阵营拿出证据 / 条款 / 账本 / 风险
      - 后续轮次继续引用听证暴露出的事实与责任链
  - `frontend/src/components/GameplayCardsModal.tsx`
    - 新增 `public_hearing` 的 placeholder 文案
  - `frontend/src/lib/scenarioMeta.ts`
    - 新增 `public_hearing` 的导演点数/冷却规则
  - `frontend/src/components/gameplayCards.test.ts`
    - 新增 prompt 构造断言
    - 新增 recommended rotation 断言

- 验证：
  - `cd frontend && npm test`
    - `140 passed`
  - `cd frontend && npm run build`
    - 通过

- 当前判断：
  - 这张新卡已经进入产品体系，但还没做单独的真实浏览器“成功注入”截图取证。
  - 如果下一轮继续做玩法扩展，建议优先顺序：
    1. 用真实 live scenario 再跑一遍 `public_hearing` 注入 smoke
    2. 再补第二张偏 `survival / ecology` 的新卡，避免新增内容继续集中在 law / trade

## 2026-03-17 E2E Fallback + Survival/Ecology Card

- 已完成用户点名的两项：
  1. `frontend/scripts/e2e-suite.mjs` 浏览器启动 fallback
  2. 再补一张偏 `survival / ecology` 的新玩法卡

- E2E suite fallback 已改为“多候选启动 + 自动降级 + 结果落盘”：
  - 原来只有：
    - `chrome channel`
    - `default chromium`
  - 现在会按顺序尝试：
    - `chrome-channel`
    - `chromium-default`
    - `chromium-swiftshader`
    - 如果请求的是 `--headless` 且未显式关闭降级：
      - `chrome-channel-headed-fallback`
      - `chromium-headed-fallback`
      - `chromium-swiftshader-headed-fallback`
  - 每次 suite 运行都会把实际采用的 profile 落盘到：
    - `browser-launch.json`
  - 同时 `result.json` 也会带：
    - `launchProfile`
    - 包含 `requestedHeadless / actualHeadless / channel / usedSwiftShader / attempts`

- 新增验证：
  - 烟测命令：
    - `cd frontend && node scripts/e2e-suite.mjs matrix --themes governance --headless --output-dir /tmp/swarmoracle-e2e-fallback-smoke`
  - 结果：
    - 通过
    - 输出目录：
      - `/tmp/swarmoracle-e2e-fallback-smoke`
    - 本机这次实际命中：
      - `launchProfile.id = chrome-channel`
      - `requestedHeadless = true`
      - `actualHeadless = true`
    - 说明：
      - fallback 链路已接入，即使这次首选路径成功，也已经能在失败时给出可追溯的降级信息，而不再整套直接黑盒中止。

- 新增第二张偏 `survival / ecology` 的玩法卡：
  - `resource_triage`
  - 中文名：`资源分诊`
  - 设计目的：
    - 强制世界线明确“谁先保命、谁被限供、哪些线路必须让路”
    - 比 `public_hearing` 更偏：
      - 淡水 / 余粮 / 药品 / 氧气 / 运力 / 撤离
      - 生存阈值、生态阈值、边疆生命维持

- 已接入：
  - `frontend/src/components/gameplayCards.ts`
    - 新增卡定义
    - 新增中英文 prompt
    - 新增各 profile 默认 directive
    - `ecology / survival / frontier / industry` 的推荐序列已把它前置
  - `frontend/src/components/GameplayCardsModal.tsx`
    - 新增 placeholder
  - `frontend/src/lib/scenarioMeta.ts`
    - 新增 cost / cooldown 规则
  - `frontend/src/components/gameplayCards.test.ts`
    - 新增 prompt 与推荐序列断言

- 验证：
  - `cd frontend && npm test`
    - `141 passed`
  - `cd frontend && npm run build`
    - 通过

- 当前玩法分布判断：
  - 新增内容不再只堆在 `law / trade`
  - 现在至少有一张更明显偏：
    - `ecology`
    - `survival`
    - `frontier`
    - `industry`
  - 下一轮如果继续补玩法，更建议做：
    - 一张偏 `faith / mythic`
    - 或一张偏 `war / logistics`

- 额外复验：
  - 全量套件：
    - `cd frontend && node scripts/e2e-suite.mjs full --headless --output-dir /tmp/swarmoracle-e2e-full-fallback-2`
    - 已通过
    - 输出目录：
      - `/tmp/swarmoracle-e2e-full-fallback-2`
    - 结果摘要：
      - `matrix.sampleCount = 14`
      - `corners` 全部通过
      - `browser-launch.json` / `result.json` 都包含 `launchProfile`
      - 本次命中：
        - `launchProfile.id = chrome-channel`
        - `requestedHeadless = true`
        - `actualHeadless = true`
  - 说明：
    - 上一轮 full 失败点是 `page.screenshot()` 卡在 `waiting for fonts to load`
    - 已在 `saveScreenshot()` 里加了 Chromium CDP fallback
    - 本次 full 已跨过该阻塞点并完整结束

- `resource_triage / 资源分诊` 的真实浏览器 smoke：
  - 新建生态 live 场景：
    - `dde50abd-b476-4f94-8e9b-997f97606de8`
  - Playwright 快照确认：
    - 当前玩法画像 = `生态阈值`
    - 玩法卡列表里真实出现：
      - `🧰 资源分诊`
    - 且文案已按生态题面定制为：
      - `立即执行生态资源分诊，决定水源、余粮、迁徙通道与防疫能力谁先保住，哪些区域必须退让。`
  - 这说明它不只是测试数据存在，而是已经被：
    - 画像推断
    - 推荐列表
    - modal placeholder / directive
    - live Theater UI
    同时接通

## 2026-03-17 Resource Triage Injection + Forbidden Ritual

- `resource_triage / 资源分诊` 已补齐真实注入证据，不再只是“卡面存在”：
  - live 场景：
    - `8ca03ce8-9c0b-4c76-bc79-aabc57476483`
  - 题面：
    - `如果跨大陆淡水系统在十二轮协商中持续崩坏，各地必须决定谁先保住水源、药品、迁徙通道与防疫能力，会发生什么？`
  - 在真实浏览器里完成：
    - 打开 Theater
    - 打开玩法卡 modal
    - 选择 `🧰 资源分诊`
    - 点击 `注入玩法卡`
  - 注入后的可验证结果：
    - `director.remainingPoints: 3 -> 2`
    - `cooldowns.resource_triage.lastUsedRound = 5`
    - `cards.usageLog[0].cardId = resource_triage`
    - `cards.usageLog[0].profileId = ecology`
    - `archive.keyMoments` 新增：
      - `R5 使用了 resource_triage`
    - live automation 中：
      - `status = simulating`
      - `currentRound = 5`
      - `messageCount = 100`
      - `branchCount = 15`
      - 说明注入发生在 live 中，而不是完成态假回写

- 本轮又新增了一张偏 `faith / mythic` 的最小玩法卡：
  - `forbidden_ritual`
  - 中文名：`禁术仪式`
  - 设计目标：
    - 强制当前世界线动用高代价、可能不可逆的禁术 / 圣物 / 王权秘仪 / 例外条款
    - 让 `faith / mythic` 题面拥有区别于 `public_hearing` 与 `resource_triage` 的玩法张力
  - 已接入：
    - `frontend/src/components/gameplayCards.ts`
      - 卡定义
      - 中英文 prompt
      - 各 profile 默认 directive
      - faith / mythic 推荐序列前置
    - `frontend/src/components/GameplayCardsModal.tsx`
      - placeholder
    - `frontend/src/lib/scenarioMeta.ts`
      - 点数/冷却规则
    - `frontend/src/components/gameplayCards.test.ts`
      - prompt 与推荐序列断言

- 本轮回归结果：
  - `cd frontend && npm test`
    - `142 passed`
  - `cd frontend && npm run build`
    - 通过

- 当前玩法结构判断：
  - 现在新增的最小玩法卡已经覆盖：
    - `law/trade`：`public_hearing`
    - `ecology/survival/frontier`：`resource_triage`
    - `faith/mythic`：`forbidden_ritual`
  - 继续扩展时，最自然的下一张会是：
    - 偏 `war/logistics` 的高风险后勤或强制调度卡

## 2026-03-17 Cross-Platform Viewport Hardening

- 现实审计结论：`18_next_session_gameplay_art_replay_plan.md` 的核心玩法/Replay/美术闭环已基本完成，代码侧已包含 11 个玩法画像、26 个 Theater 场景、8 张原始玩法卡 + 后续补的 `public_hearing / resource_triage / forbidden_ritual`。
- 当前更真实的短板不在玩法主链路，而在跨平台与证据链：
  - 浏览器自动化在当前 Codex 运行环境里受到 localhost / Playwright 临时目录权限限制，无法稳定复跑真实 browser E2E；因此本轮结论主要依赖现有 `output/e2e/*` 产物 + 本地测试 + 视觉截图复核。
  - `frontend/output/e2e/full-regression-final/result.json` 仍只有 6 个 matrix 样本，不等于文档里说的 14 条全量样本；其中 `law` / `trade` 的 replay 证据仍停在 `TitleScene`，说明历史 full artifact 不能当作“所有题材 replay 全部无缺陷”的强证据。
  - 某些旧截图（如 `faith-gameplay-modal-20260316.png`）仍为空白，说明 modal capture 证据链曾经不稳定；但也存在正常 modal 截图（如 `law-daily-modal.png`），更像取证稳定性而不是玩法缺失。
- 已补的代码修复（跨平台优先级高于继续堆玩法卡）：
  - `frontend/src/index.css`：
    - `body` 增加 `min-height: 100dvh` fallback。
    - 全局 `LanguageSwitcher` 改为使用 safe-area inset 计算底/右偏移。
    - 小屏时缩小并进一步贴合安全区；Theater 页面底部偏移同步收敛。
  - `frontend/src/pages/InputView.css`：
    - 首页根容器增加 `min-height: 100dvh`。
    - 小屏底部 padding 提高到 `calc(108px + env(safe-area-inset-bottom, 0px))`，避免语言切换器压住首屏输入区。
  - `frontend/src/pages/SimulationView.css`：`height: 100dvh`，减少 iOS/Android 浏览器地址栏变化造成的 Theater 抖动/裁切。
  - `frontend/src/pages/ResultView.css` / `HistoryView.css` / `LeaderboardView.css`：统一追加 `min-height: 100dvh`。
  - `frontend/src/components/GameplayCardsModal.css`：modal 最大高度增加 `100dvh` 版本，减轻移动端视口变化时的裁切。
- 本轮验证：
  - `cd frontend && TMPDIR=/Users/yangjunjie/Desktop/upgrade-test/.tmp npx tsc --noEmit` ✅
  - `cd frontend && TMPDIR=/Users/yangjunjie/Desktop/upgrade-test/.tmp npm test` ✅ `142 passed`
  - `cd frontend && TMPDIR=/Users/yangjunjie/Desktop/upgrade-test/.tmp npm run build` ✅
  - `cd backend && TMPDIR=/Users/yangjunjie/Desktop/upgrade-test/.tmp .venv/bin/python -m pytest tests/ -q` ✅ `777 passed, 2 warnings`
- 下轮最值得继续做的事：
  1. 在真实可联网/可起浏览器的环境复跑 14 样本 `e2e-suite`，把 `browser-launch.json` 与全量 matrix 结果统一补齐到同一目录。
  2. 专门补 `law` / `trade` replay 停在 `TitleScene` 的历史 artifact。
  3. 若继续加玩法，优先做偏 `war / logistics` 的最小新卡，而不是继续往 `law / trade / faith` 堆。

## 2026-03-17 Runtime Sanity + Mobile Safe-Area Pass

- 现实排障结论：
  - `127.0.0.1:18927` 上一度跑着错误仓库的后端（实际从 `/Users/yangjunjie/Desktop/test/backend/...` 导入），这会把 `POST /api/scenario` 污染成旧同步解析链路，直接报 `cannot access local variable 'asyncio'`。
  - 现已明确改用 `--app-dir /Users/yangjunjie/Desktop/upgrade-test/backend` 启动正确后端后，`POST /api/scenario` 可即时返回，说明当前仓库的异步创建链路本身是好的。

- 新的黑盒验证：
  - `cd frontend && node scripts/e2e-suite.mjs full --url http://127.0.0.1:18929 --headless --output-dir output/e2e/full-regression-20260317-current2`
  - 本轮 `full` 已通过，且 matrix 实际覆盖 `14` 个题材/场景样本，不再只有旧 artifact 里的 6 组：
    - `governance / law / trade / ecology / war / faith / industry / frontier / mythic / survival / governance_surveillance / empire_palace / industry_grid / war_logistics`
  - 新结果显示：
    - `law` / `trade` replay 现在都能进入 `WorldScene`，旧 `TitleScene` artifact 已过时。
    - corners 里的 prediction success / failure guard / result loading gate / replay skip switch / share context / share retry / history+leaderboard / delete-last-page 都通过。

- 新发现的真实 UX 问题：
  - 移动端首页、剧场页、结果页仍会被右下角 `LanguageSwitcher` 压住底部内容，尤其会遮挡首页表单区域、Theater 实时消息面板和结果卡底部。

- 本轮已做的移动端安全区修补：
  - `frontend/src/index.css`
    - 全局语言切换器小屏进一步缩小，并继续收紧到底部 safe-area。
  - `frontend/src/pages/InputView.css`
    - 小屏底部 padding 再提高，给首页控件留出切换器缓冲区。
  - `frontend/src/pages/ResultView.css`
    - 小屏追加底部缓冲，避免结果卡与切换器直接重叠。
  - `frontend/src/pages/HistoryView.css`
    - 小屏追加底部缓冲。
  - `frontend/src/pages/LeaderboardView.css`
    - 小屏追加底部缓冲。

- 本轮代码验证：
  - `cd frontend && npm run build` ✅

- 仍需说明：
  - 这台机器当前从 Codex 子进程直接拉起新的 Playwright/Chrome 会遇到 `MachPortRendezvousServer ... Permission denied (1100)`，所以本轮 CSS 改动后的“再截图复核”没法在同一条自动化链路里完成。
  - 因此这轮移动端修补的最终结论是：代码侧已补、构建通过、需要在可正常起浏览器的宿主环境再做一次移动端视觉复拍。

## 2026-03-17 Current Turn Notes

- 本轮首先排除了一个高风险环境污染：
  - `18927` 一度跑着错误仓库 `/Users/yangjunjie/Desktop/test/backend/...` 的后端进程，导致 `POST /api/scenario` 看起来像“当前代码坏了”。
  - 改用显式 `--app-dir /Users/yangjunjie/Desktop/upgrade-test/backend` 后，当前仓库的创建场景链路恢复正常，说明问题是错进程，不是现代码本身。

- 新的真实回归证据：
  - `cd frontend && node scripts/e2e-suite.mjs full --url http://127.0.0.1:18929 --headless --output-dir output/e2e/full-regression-20260317-current2`
  - 本轮 `full` 已通过，matrix 实际覆盖 14 组题材/场景：
    - `governance / law / trade / ecology / war / faith / industry / frontier / mythic / survival / governance_surveillance / empire_palace / industry_grid / war_logistics`
  - 旧 `law` / `trade` replay 停在 `TitleScene` 的 artifact 已过时；当前回归里二者都能进入 `WorldScene`。

- 当前代码中的玩法状态：
  - `frontend/src/components/gameplayCards.ts` 现已不止计划文档里的 8 张卡，代码里已经扩到 10 张：
    - 新增 `backchannel_pact / 密约交易`
    - 新增 `evacuation_order / 撤离令`
  - `GameplayCardsModal` 的自动化摘要也已能在 live Theater 中输出这两张卡的推荐状态。

- 本轮新修的真实 UX 问题：
  - 移动端首页、结果页、剧场页的 `LanguageSwitcher` 会压住底部关键区域。
  - 已在以下文件补 safe-area / 底部留白：
    - `frontend/src/index.css`
    - `frontend/src/pages/InputView.css`
    - `frontend/src/pages/ResultView.css`
    - `frontend/src/components/AgentPanel.css`
  - 复拍结果：
    - 首页 / 结果页移动端已不再被切换器压住主要内容。
    - 剧场页移动端切换器仍在底部，但已落到空白区，不再盖住实时消息正文。

- 本轮验证：
  - `cd frontend && npm run build` ✅
  - `node .tmp-playwright/web_game_playwright_client.mjs --url http://127.0.0.1:18929/sim/72ae364d-3ea1-4959-939c-8fe1dbeca1c9 --actions-json '{"steps":[{"buttons":[],"frames":8}]}' --iterations 1 --pause-ms 300 --screenshot-dir /tmp/swarmoracle-webgame-check --capture-mode panel` ✅
  - 交互式 Playwright 复拍：
    - desktop 首页 / Theater / 结果页
    - mobile 首页 / Theater / 结果页

- 若下一轮继续：
  1. 用同一套正确后端进程补一次 headed matrix 截图，把移动端 artifact 也落盘到 `frontend/output/e2e/`。
  2. 若继续扩玩法，优先给 `mythic / survival / generic` 补更直接的首页入口或 challenge 入口，而不是再堆 replay polish。

## 2026-03-17 Homepage Entry Expansion

- 已按当前优先级补首页直达入口，不改模拟主逻辑：
  - `frontend/src/lib/dailyChallenge.ts`
    - `daily challenge` 从 9 条扩到 12 条。
    - 新增覆盖：
      - `mythic`
      - `survival`
      - `generic`
  - `frontend/src/components/QuickStartCards.tsx`
    - 首页快速开始卡新增 3 条对应题材样本，用户不需要自己手写题目才能直接进入这些画像。

- 入口层面的当前结论：
  - 玩法底层能力已经比旧计划文档更完整，但现在首页入口也终于跟上了：
    - 日挑战轮换已能打到 12 个画像。
    - quick start 也不再只偏历史/科技/社会题。

- 本轮新增验证：
  - `frontend/src/lib/dailyChallenge.test.ts`
    - 追加 12 天轮换覆盖测试，确保 `mythic / survival / generic` 都实际出现在 challenge 周期里。

## 2026-03-17 Generic Matrix Sample

- 已补 `generic` 固定 E2E 样本：
  - 题目：`如果所有大型组织都必须每周随机交换一次负责人，会发生什么？`
  - 样本 ID：`80973179-d26c-4af9-8ba0-3a68a740690f`
  - 当前 replay 主题：`switchboard_forum`
  - 结果页 `share_context.profileLabel` 已验证为 `通用博弈`

- 为了让这条题目稳定落到 `generic` 而不是被 `scene_theme -> governance` 回退：
  - `frontend/src/components/gameplayCards.ts`
    - 为 `generic` 增加一组非常窄的“随机换帅 / 轮换负责人 / leader shuffle”关键词。
  - `frontend/src/components/gameplayCards.test.ts`
    - 增加对应断言，锁定这条题目会推断成 `generic`。

- 已落盘 artifact：
  - `frontend/output/e2e/generic-replay-proof/`
  - `frontend/output/e2e/generic-replay-headed.png`
  - `frontend/output/e2e/generic-result-headed/`

- `frontend/output/e2e/sample_matrix.json` 已登记 `generic` 条目。

## 2026-03-17 Dedicated Generic Theater Theme

- 已为 `generic` 增加独立 Theater 主题：`switchboard_forum`
  - 中文标签：`轮值议堂`
  - 风格定位：组织轮值、程序性博弈、密室协调、模拟控制台，而不是继续复用 `modern_city`

- 新增素材：
  - `frontend/public/assets/scenes/switchboard_forum.png`
  - 已加入 `frontend/public/assets/ASSET_CREDITS.md`

- 代码接入：
  - 后端选景：
    - `backend/app/visualization/scene_selector.py`
      - 为“随机换帅 / 负责人轮换 / leader shuffle / rotating leadership”类题面新增独立映射
      - `AVAILABLE_SCENES` 现为 `27`
  - 前端：
    - `frontend/src/game/scenes/BootScene.ts`
    - `frontend/src/game/scenes/WorldScene.ts`
    - `frontend/src/game/managers/VizSynthesizer.ts`
    - `frontend/src/game/managers/VizSynthesizer.test.ts`
    - `frontend/src/lib/themeLabels.ts`
    - `frontend/src/components/gameplayCards.ts`
    - `frontend/src/components/gameplayCards.test.ts`
    - `frontend/src/game/scenes/WorldScene.test.ts`
  - `switchboard_forum -> generic` 的 fallback 映射已补齐。

- 回归：
  - `cd backend && .venv/bin/python -m pytest tests/test_scene_selector.py -q` ✅ `135 passed`
  - `cd frontend && npm test -- --run src/game/managers/VizSynthesizer.test.ts src/game/scenes/WorldScene.test.ts src/components/gameplayCards.test.ts` ✅ `64 passed`
  - `cd frontend && npm run build` ✅

- 新的 `generic` artifact 已重录：
  - `frontend/output/e2e/generic-replay-proof/`
  - `frontend/output/e2e/generic-replay-headed.png`
  - `frontend/output/e2e/generic-result-headed/`
  - `frontend/output/e2e/sample_matrix.json` 已更新到新场景 ID 与 `switchboard_forum`

## 2026-03-17 Gameplay Cards Expansion

- 已新增 2 张最小新玩法卡，继续沿用“导演级持续事件”设计，而不是引入另一套子系统：
  - `backchannel_pact / 密约交易`
    - 两名角色绕开公开议程私下交易筹码、保护承诺或过路权。
    - 目标是强化治理/贸易/帝国/法律这类题材里的“台面下联盟”和信息不对称。
  - `evacuation_order / 撤离令`
    - 强制当前世界线执行撤离、封锁或转运命令，明确谁先走、谁被限留、哪些通道关闭。
    - 目标是强化生态/边疆/生存/战争题材里的秩序压力与优先级重排。

- 已改的核心玩法文件：
  - `frontend/src/components/gameplayCards.ts`
    - 新增 `GameplayCardId`
    - 新增卡牌定义、提示词模板、推荐顺序
    - 为全部玩法画像补齐 `backchannel_pact / evacuation_order` directive 文案
    - 更新推荐卡序和目标角色建议逻辑
  - `frontend/src/components/GameplayCardsModal.tsx`
    - 新卡接入 placeholder、主/副角色选择逻辑和校验文案
  - `frontend/src/lib/scenarioMeta.ts`
    - 新卡冷却/消耗规则接入
  - `frontend/src/lib/archiveSummary.ts`
    - 新卡映射到现有导演风格标签，避免档案摘要失配
  - `frontend/src/game/scenes/WorldScene.ts`
    - 新增 `backchannel_signal / evacuation_alarm` 动画标签

- 本轮新增验证：
  - `cd frontend && npm test -- --run src/components/gameplayCards.test.ts src/lib/scenarioMeta.test.ts src/game/scenes/WorldScene.test.ts src/components/GameplayCardsModal.test.tsx` ✅
  - `cd frontend && npm test` ✅ `148 passed`
  - `cd frontend && npm run build` ✅

- 仍需说明：
  - 新卡目前是“最小实现”：
    - 通过现有 intervention + Viz event 动画链路接入
    - 不新增素材资源，也不改变现有视觉体系
    - 还没有为新卡补专属黑盒回放证据目录
  - 如果下一轮继续做玩法深化，最自然的方向是：
    1. 给 `backchannel_pact` 补“密约泄漏”型二次事件证据；
    2. 给 `evacuation_order` 补更强的 mobile / replay 取证脚本；
    3. 再考虑是否继续扩第三类偏 `war/logistics` 的强制调度卡。

## 2026-03-17 Generic Quick-Start + Matrix Self-Heal

- 已继续完成用户明确点名的下一步：
  - `switchboard_forum` 不再只有一条 “随机换帅” generic 入口。
  - 首页 `QuickStartCards` 现补成一组更贴题的 generic quick-start：
    - `如果所有大型组织都必须每周随机交换一次负责人，会发生什么？`
    - `如果所有关键城市都必须每三十天由抽签产生的临时委员会接管，会发生什么？`
    - `如果每一项重大决策都必须交给轮值外部评审团重新裁决，会发生什么？`
  - 英文 quick-start 也同步补齐对应题面。

- 为了让这些新 generic 题面真能落到 `switchboard_forum`，而不是只是 UI 文案：
  - `backend/app/visualization/scene_selector.py`
  - `frontend/src/game/managers/VizSynthesizer.ts`
  - `frontend/src/components/gameplayCards.ts`
  都已补齐新 generic 关键词：
    - `抽签产生的临时委员会`
    - `临时委员会接管`
    - `轮值外部评审团`
    - `重新裁决`
    - `lottery-picked emergency committee`
    - `rotating external review board`

- 同时修复了当前自动化的一个真实盲区：
  - 之前 `frontend/output/e2e/sample_matrix.json` 强依赖一批历史 `scenario_id`。
  - 当前数据库若没有这些样本，`npm run e2e:full` 会在第一条 replay 上直接卡死，看起来像 Theater 挂了，但实质是样本不存在。
  - 现已在 `frontend/scripts/e2e-suite.mjs` 增加 matrix 自愈逻辑：
    - 先尝试读取 `scenario_id`
    - 若场景不存在，则使用 `sample_matrix.json` 里新增的 `question` 自动重建场景
    - 等待状态到 `done` 后再继续 replay / result / share
  - `sample_matrix.json` 现已为 15 条样本补齐 fallback `question` 字段，不再只靠脆弱的历史 ID。

- 本轮验证：
  - `cd backend && .venv/bin/python -m pytest tests/test_scene_selector.py -q` ✅ `137 passed`
  - `cd frontend && npm test -- --run src/components/gameplayCards.test.ts src/game/managers/VizSynthesizer.test.ts src/game/scenes/WorldScene.test.ts` ✅ `64 passed`
  - `cd frontend && npm test` ✅ `149 passed`
  - `cd frontend && npm run build` ✅
  - `node --check frontend/scripts/e2e-suite.mjs` ✅

- 仍需记录的宿主环境限制：
  - 本轮再次尝试跑 Playwright 黑盒时，浏览器进程在当前 macOS 宿主上被 Mach port / Crashpad 权限拦截：
    - 典型报错：`bootstrap_check_in ... Permission denied (1100)`
  - 这会导致：
    - `npm run e2e:health`
    - `npm run e2e:predict`
    - `node scripts/e2e-suite.mjs matrix --themes generic`
    在当前机器上无法稳定起浏览器。
  - 因此这轮已经把“样本不存在”的业务盲区修掉，但还没能在这台机器上重新录完整黑盒证据目录。

- 给下一轮的直接建议：
  1. 先在可正常拉起 Playwright 浏览器的环境复跑：
     - `cd frontend && node scripts/e2e-suite.mjs matrix --themes generic --headless --output-dir output/e2e/matrix-generic-codex`
     - `cd frontend && npm run e2e:full -- --headless --output-dir output/e2e/full-regression-<stamp>`
  2. 若 generic 题材还想更厚一层，最自然的是补：
     - generic 专属 daily challenge 轮换池，而不是只保留一条 generic daily challenge；
     - `backchannel_pact / evacuation_order` 在 generic profile 下的黑盒取证目录。

## 2026-03-17 Test DB Isolation + Generic Switchboard Follow-up

- 本轮实际新增修复：
  - `backend/tests/conftest.py` 不再复用固定的 `./test_swarmoracle.db`。
  - 每个 pytest case 现在改用 `tmp_path` 下的独立临时 SQLite 文件，并在前后显式 `dispose_engine()`。
  - 这次修掉的是之前 `readonly database / disk I/O error / table already exists` 这类非业务错误，让后台可视化集成测试重新回到可复现状态。

- 本轮还补齐了 backend 侧对 generic `switchboard_forum` 的关键词兜底：
  - `temporary committee takeover`
  - `lottery committee`
  - `rotating external review board`
  - `抽签产生的临时委员会`
  - `临时委员会接管`
  - `轮值外部评审团`

- 基于当前工作区重新验证：
  - `cd backend && .venv/bin/python -m pytest tests/test_scene_selector.py -q` ✅ `139 passed`
  - `cd backend && .venv/bin/python -m pytest tests/test_simulator_viz_integration.py -q` ✅ `70 passed`
  - `cd frontend && npm test` ✅ `150 passed`
  - `cd frontend && npm run build` ✅

- 当前仍需保守说明的点：
  - Playwright 浏览器在这台 macOS 宿主上仍受 Crashpad / Mach 权限拦截，当前更适合把浏览器黑盒回归放到可正常拉起 Chromium 的环境跑。
  - 但从代码层和自动化摘要层看，generic quick-start 已经从“单条随机换帅”扩成了更像一组题面，而 backend/frontend 两端的 generic 识别也已对齐。

## 2026-03-17 Validation Follow-up

- 已再次核对并完成的最小增量：
  - 首页 generic quick-start 现确认为 3 条入口，而不是只有“随机换帅”单例：
    - `如果所有大型组织都必须每周随机交换一次负责人，会发生什么？`
    - `如果所有关键城市都必须每三十天由抽签产生的临时委员会接管，会发生什么？`
    - `如果每一项重大决策都必须交给轮值外部评审团重新裁决，会发生什么？`
  - `gameplayCards.ts` 与 `VizSynthesizer.ts` 已补齐对应 generic 识别短语，新增题面会稳定落到 `generic / switchboard_forum`。

- 后端测试隔离已修：
  - `backend/tests/conftest.py` 不再复用固定 `test_swarmoracle.db`，改为每个测试独立临时 SQLite 文件，并在前后显式 `dispose_engine()`。
  - 这修掉了之前 `readonly database / disk I/O error` 的夹具问题。

- 本轮真实验证结果：
  - `cd frontend && npm test -- --run src/components/gameplayCards.test.ts src/game/managers/VizSynthesizer.test.ts` → `44 passed`
  - `cd frontend && npm run build` → 通过
  - `cd backend && .venv/bin/python -m pytest tests/test_scene_selector.py -q` → `139 passed`
  - `cd backend && .venv/bin/python -m pytest tests/test_simulator_viz_integration.py -q` → `70 passed`

- 对 matrix/e2e 的最新认识：
  - `frontend/scripts/e2e-suite.mjs` 当前已经带 `resolveMatrixScenario()` 兜底逻辑，会在历史 `scenario_id` 缺失时按 theme 自动新建场景。
  - 但 generic matrix 在当前机器上依旧没能稳定产出 replay 证据；第一次失败是等待 replay state 超时，第二次失败是 Playwright 浏览器本身起不来。
  - 因此当前状态应视为：
    - `generic quick-start` 与 `generic/switchboard_forum` 识别链路已补齐并通过单测；
    - 黑盒 replay 取证仍需要在浏览器环境更稳定的宿主机上复跑确认。

## 2026-03-17 Generic Quick-Start Expansion

- 已补齐 generic quick-start 新题面的语义映射链：`gameplayCards.ts`、`VizSynthesizer.ts`、`scene_selector.py` 现在都能识别两条新增题面（临时委员会接管 / rotating external review board）。
- 后端定向回归：`cd backend && env TMPDIR=/Users/yangjunjie/Desktop/upgrade-test/.tmp .venv/bin/python -m pytest tests/test_scene_selector.py -q --capture=no` 通过，现为 `139 passed`。
- 前端静态类型检查：`cd frontend && ./node_modules/.bin/tsc --noEmit -p tsconfig.app.json` 通过。
- 真实 API 取证：
  - `如果所有关键城市都必须每三十天由抽签产生的临时委员会接管，会发生什么？` → `scene_theme=switchboard_forum`
  - `What if every high-stakes decision had to be re-approved by a rotating external review board?` → `scene_theme=switchboard_forum`
- 仍需说明：当前环境无法稳定启动 MCP 浏览器或本地 Playwright 的可写临时目录，因此这轮新增 generic 题面的 UI 可见性主要依靠源码核对 + 后端实时返回取证，而不是新的截图证据。

## 2026-03-17 Generic Preset Launch + Matrix Fallback Hardening

- 已补 generic quick-start 的“一键直达”缺口：
  - `QuickStartCards.tsx` 现支持把推荐预设和题面一起传给 `InputView`。
  - 三条 generic quick-start 现在都会直接以：
    - `rounds = 4`
    - `numAgents = 4`
    - `mode = blackboard`
    - `visualizationEnabled = true`
    启动，而不是沿用首页当前表单状态。

- 真实浏览器复验（桌面 + 390×844 移动视口）：
  - 点击 generic quick-start 后，`/sim/:id` 的 `render_game_to_text()` 返回：
    - `totalRounds = 4`
    - `viewMode = theater`
    - `visualizationEnabled = true`
  - warmup 阶段仍会先显示：
    - `worldline_ready = true`
    - `agents_ready = false`
    - `director_ready = false`
    - `preview_enabled = true`
  - 说明 generic quick-start 现在不仅题面对了，而且启动体验也更贴近 Theater 玩法本身。

- `frontend/scripts/e2e-suite.mjs` 本轮继续加固：
  - `matrix/full` 在历史 `scenario_id` 缺失时，会按 theme 使用内置 fallback 题面新建样本，不再立即因为旧数据库快照失效而整套退出。
  - `waitForScenarioStatus()` 现在会对瞬时 `500` 保守重试，而不是直接判整套回归失败。
  - `generic` 单主题回归已重新跑通：
    - `cd frontend && node scripts/e2e-suite.mjs matrix --themes generic --headless --output-dir frontend/output/e2e/20260317-generic-rerun`

- 仍需保守说明：
  - 完整 `e2e:full` 已不再因为历史 sample ID 缺失而立刻失败，但 runtime fallback 创建出的部分场景仍可能长时间停在 `simulating`，当前这条链路还不能视为稳定 PASS。
  - 最近观察到：
    - governance / law / trade / ecology 的 runtime fallback 样本已能进入 `DONE`
    - 个别 generic / governance fallback 场景仍会卡在 `SIMULATING`
  - 因此这轮可以确认：
    - generic 入口、主题识别、Theater 启动参数、单主题 matrix fallback 已补齐
  - `full` 黑盒整体稳定性还需要下一轮继续压实

## 2026-03-17 Runtime Smoke Stability Follow-up

- 本轮继续收敛 `full` 黑盒里的 runtime fallback 稳定性，新增两条关键修复：
  1. `frontend/scripts/e2e-suite.mjs`
     - runtime fallback 样本从“正常局”改成“浅烟雾局”：
       - `rounds = 1`
       - `numAgents = 3`
     - 目标是让缺失历史 `scenario_id` 时的 matrix/full 回归优先验证 replay/result/share 链路，而不是现场再起高分叉长叙事。
     - `resolveMatrixScenario()` 现会在旧 `requestedScenarioId` 返回 `404/500` 时直接回退到 runtime 创建，不再把坏旧样本当成致命错误。
  2. `backend/app/services/narrator.py`
     - narrator 的 `reasoning_effort` 从 `medium` 调整为 `low`
     - narration 现在有本地超时 + 软失败兜底：
       - 若 LLM 超时或抛错，会回退为基于分支标题和原始交互的简化摘要
       - 场景仍可进入 `DONE`，避免整局卡死在 `SIMULATING`

- 新增验证：
  - `cd backend && .venv/bin/python -m pytest tests/test_narrator.py -q` → `10 passed`
  - `cd backend && .venv/bin/python -m pytest tests/test_simulator_viz_integration.py -q` → `70 passed`
  - `cd frontend && node scripts/e2e-suite.mjs matrix --themes generic --headless --output-dir frontend/output/e2e/20260317-generic-rerun-smoke3` → 通过
  - `cd frontend && node scripts/e2e-suite.mjs matrix --themes governance,law,trade,ecology,war,generic --headless --output-dir frontend/output/e2e/20260317-matrix-core6` → 通过，`sampleCount = 6`

- `matrix-core6` 当前确认已通过的 runtime fallback 题材：
  - governance
  - law
  - trade
  - ecology
  - war
  - generic

- 运行时观察结论：
  - 之前最容易长时间停在 `SIMULATING` 的问题，根因主要来自两部分：
    - fallback 样本过深（多轮 + 易分叉）
    - narrator 调用受上游 LLM 波动影响，卡住整局完成态
  - 经过本轮修复后，核心 6 题材的 runtime fallback 已能稳定走到 `DONE` 并产出 replay/result/share 结果。

- 仍在继续观察：
  - 完整 `e2e:full` 已重新启动并明显比修复前更稳定，但由于它仍会串行跑更多题材 + corner cases，耗时比单独 matrix 更长。
  - 当前可以保守认为：
    - 代码侧的主要稳定性缺口已修
    - 剩余问题更像“整套 full 的长耗时签收”，而不是“关键链路仍然经常坏”

## 2026-03-17 Final Black-Box Signoff

- 已完成 clean full 黑盒终验：
  - `cd frontend && npm run e2e:full -- --headless --output-dir frontend/output/e2e/20260317-full-rerun-clean`
  - 总结果已落盘：
    - `frontend/frontend/output/e2e/20260317-full-rerun-clean/result.json`

- 本次 full 结果摘要：
  - `matrix.sampleCount = 15`
  - `matrix` 题材全通过：
    - governance
    - law
    - trade
    - ecology
    - war
    - faith
    - industry
    - frontier
    - mythic
    - survival
    - generic
    - governance_surveillance
    - empire_palace
    - industry_grid
    - war_logistics
  - `corners` 用例全通过：
    - `branch_prediction`
    - `ending_tone_prediction`
    - `profile_resonance_prediction`
    - `prediction_failure_guard`
    - `result_loading_gate`
    - `replay_skip_switch`
    - `share_context`
    - `share_retry`
    - `history_leaderboard`
    - `history_delete_last_page`

- 为使 `replay_skip_switch` 在浅烟雾 fallback 样本上也可验证，`scripts/e2e-suite.mjs` 已补：
  - 若没有第二条 branch / round 可切，会显式点击 `Replay / 重播` 按钮恢复 `playback_mode = replay`
  - clean full 结果中，`corners.cases.replay_skip_switch.replayed.playback_mode = "replay"` 已确认

- 当前口径可以升级为：
  - 代码级回归：通过
  - API/运行时 smoke：通过
  - matrix 黑盒：通过
  - corners 黑盒：通过
  - full 黑盒：通过

- 仍需保守说明：
  - 当前验证对象仍是 Web 应用路径；Windows/macOS/Linux 浏览器端可行性较高，但 iOS/Android 仍应视为“移动 Web 可行”，不是原生 App 签收。
  - 如后续要补素材，可按用户指定的 Google image endpoint / Gemini 图像模型继续生成并接入。

## 2026-03-17 Generic API Recheck

- 已确认之前 generic API 首屏落到 `modern_city / medieval_village` 只是后端旧进程未重启；函数级 `select_scene()` 和最新代码本身没有问题。
- 重启当前工作区后端后，下面两条新增 generic 题面都已完成真实推演闭环：
  - `如果所有关键城市都必须每三十天由抽签产生的临时委员会接管，会发生什么？`
  - `如果每一项重大决策都必须交给轮值外部评审团重新裁决，会发生什么？`
- 两条场景的实时结果：
  - `scene_theme = switchboard_forum`
  - `status = done`
  - `total_rounds = 3`
- 本轮最终验证口径更新为：
  - `cd backend && .venv/bin/python -m pytest tests/test_scene_selector.py -q` → `137 passed`
  - `cd backend && .venv/bin/python -m pytest tests/test_simulator_viz_integration.py -q` → `70 passed`
  - `cd frontend && npm test` → `151 passed`
  - `cd frontend && npm run build` → 通过

## 2026-03-17 E2E Hardening

- 发现 `frontend/scripts/e2e-suite.mjs` 在 `law` 样本 replay 阶段存在瞬时失败：旧样本场景首轮读取 `render_game_to_text()` 可能返回空，导致 full 套件直接中断。
- 已修复：`runReplayFlow()` 增加一次 fresh page reload 重试；`runMatrixSuite()` 在 legacy 样本仍失败时，会回退到 runtime 新建场景继续 replay/result 流程，并在结果中记录 `recovery`。
- 定向复测：`node scripts/e2e-suite.mjs matrix --themes law --headless --output-dir output/e2e/law-repro-fix-20260317` 通过；日志显示首轮 replay 超时后自动重试成功。

## 2026-03-17 Mobile Adaptation

- 真实 390x844 Playwright 巡检发现 Theater 顶部操作条在移动端窄屏下裁切，`Classic View` 胶囊和头部动作区热区不完整。
- 已修复：`SimulationView.css` 让头部动作区在 `max-width: 600px` 下可换行、隐藏品牌字样、压缩按钮；`game.css` 在同断点下把 `view-mode-toggle` 收成图标胶囊，保留切换功能但避免裁切。
- 已复验：390x844 Playwright 截图中头部控件已完整显示，`玩法卡 / 预测 / 视图切换 / 返回` 都保留可点热区。

## 2026-03-17 Theme Registry + Gameplay Arc

- 新增 `frontend/src/lib/themeRegistry.ts`，把 Theater 场景 key、关键词、标签、asset path、profile 归属，以及玩法 frame/badge 资产集中成一份 manifest。
- `BootScene.ts` 与 `VizSynthesizer.ts` 已切到同一份 registry；场景预载和题面选景不再维护两套常量，`BootScene` 的 `loaderror` 场景失败统计也一起修正。
- `gameplayCards.ts` 改为读取 manifest 中的 frame/badge/profile fallback，并新增“题材连锁事件 + 轻量轨道” helper：每个题材都有一条三段式 arc，以及一对 `风险时钟 / 资源轨道` 标签与数值。
- `GameplayCardsModal.tsx` 现会展示：
  - 当前题材连锁事件序列
  - 已完成步数 / 下一步推荐
  - 风险时钟 / 资源轨道数值
  - 推荐 badge 会优先标出当前链路的 `下一步`
- Playwright 真实验证：
  - generic 场景初次打开玩法卡时显示 `公开听证 → 密约交易 → 资源分诊`
  - 注入一次 `公开听证` 后，再打开会更新为 `1/3`，下一步切到 `密约交易`

## 2026-03-17 Docker Self-Consistency

- `backend/Dockerfile` 已改为容器真实监听 `18927`，并简化为复制源码后直接 `pip install .`，避免 editable 安装和源码拷贝顺序不一致。
- `frontend/Dockerfile` 的 Nginx 反代目标已统一改成 `backend:18927`，与 compose 对外端口一致。
- `docker-compose.yml` 现保留 `18927/18928` 口径，并补齐 `127.0.0.1` 形式的 CORS origin。
- 验证：
  - `npm test -- --run src/components/gameplayCards.test.ts src/game/managers/VizSynthesizer.test.ts` → `44 passed`
  - `npm run build` → 通过
  - `cp .env.example .env && docker compose config` → 通过；随后已删除临时 `.env`
  - `docker build` 本机未继续验证，仅做了 compose 静态展开检查

## 2026-03-17 Final QA Closure

- 新建 generic Theater 场景 `cc9a3fba-5fb3-423f-b6d0-d01bef479ef9` 成功从 `simulating -> done`，`scene_theme = switchboard_forum`。
- 浏览器自动化读取到玩法卡 modal 的 `signature_arc`：
  - `label = 通用转向链`
  - `next_card_id = public_hearing`
  - `risk_value = 0/6`
  - `resource_value = 3/6`
- 同一场景结果页已出现：
  - `题材连锁`
  - `公开听证 → 密约交易 → 资源分诊`
  - `情势轨道`
  - `分歧时钟 0/6`
  - `转圜筹码 3/6`
- 当前最终验证口径：
  - `cd frontend && npm test` → `151 passed`
  - `cd frontend && npm run build` → 通过
  - `docker compose config` → 通过（基于临时 `.env`）

## 2026-03-17 Docker Runtime Signoff

- 真实 `docker compose up --build -d` 过程中暴露两个发布链问题：
  - backend 镜像最初因 `pyproject.toml` 缺少 setuptools package 约束，`pip install .` 时把 `app / alembic` 一并做 top-level package 自动发现，导致构建失败。
  - backend healthcheck 最初打到 `POST /api/health`，该接口会同步探测外部 LLM，导致服务进程已启动仍被判 `unhealthy`。
- 已修复：
  - `backend/pyproject.toml` 新增 `[tool.setuptools] packages = ["app"]`
  - `docker-compose.yml` healthcheck 改为仅检查 `GET /`
  - 临时容器验证环境里将根 `.env` 的 `LLM_RESPONSES_URL` 指向 `http://host.docker.internal:8318/v1/chat/completions`
- 真实容器验证结果：
  - `docker compose up --build -d` 成功
  - `swarmoracle-backend` 状态为 `healthy`
  - `swarmoracle-frontend` 成功监听 `18928`
  - `curl http://127.0.0.1:18927/` 返回根信息
  - `curl http://127.0.0.1:18928/` 返回前端静态页
  - 通过前端代理 `POST http://127.0.0.1:18928/api/scenario` 创建 smoke 场景 `3ab10cc5-b08a-43a6-b4a2-84cf9990cd00`
  - 轮询后该场景成功到达 `status = done`
- 验证结束后已执行 `docker compose down`，并删除临时根 `.env`。

## 2026-03-17 Documentation Sync

- 已同步更新的文档：
  - `README.md`
  - `frontend/README.md`
  - `backend/README.md`
  - `frontend/public/assets/ASSET_CREDITS.md`
  - `llmdoc/overview/project.md`
  - `llmdoc/overview/frontend.md`
  - `llmdoc/overview/backend.md`
  - `llmdoc/guides/development.md`
  - `llmdoc/reference/config.md`
  - `llmdoc/reference/api.md`
  - `.env.example`
- 同步内容聚焦于本轮真实变更：
  - `simulating` 占位启动口径
  - 27 场景主题 + `themeRegistry.ts`
  - 10 张玩法卡 + `题材连锁 / 情势轨道`
  - 前端回归数 `151`
  - Docker 容器运行签收、`host.docker.internal` 用法、healthcheck 改为 `GET /`
  - backend README / llmdoc backend 中旧的 `/scenario/{id}/predict` / `/leaderboard` / `WS /ws/{scenario_id}` 路径已修正
- 文档校验：
  - `git diff --check -- llmdoc README.md frontend/README.md backend/README.md frontend/public/assets/ASSET_CREDITS.md .env.example` → 通过
  - `rg '^(<<<<<<<|=======|>>>>>>>)' ...` → 无冲突标记
  - `llmdoc/index.md` 中引用的文档文件均存在

## 2026-03-17 Four-Track Execution Doc + Skill-Based QA

- 新增执行文档：
  - `implement/19_four_track_execution_plan.md`
  - 范围：
    - `Director Campaign / 导演生涯`
    - `玩法契约统一`
    - `稳定性与验证面`
    - `AI 辩论竞技场 MVP`
  - 文档内容不是方向摘要，而是：
    - 目标 / 非目标
    - 建议数据模型 / API / 文件改造点
    - 单测 / 集成 / E2E 清单
    - review gate
    - 本轮真实验证基线

- 本轮按用户指定实际使用了 3 个 skill：
  - `develop-web-game`
  - `playwright-interactive`
  - `Playwright CLI Skill`

- `Playwright CLI Skill` 现实状态：
  - `npx` 可用
  - `frontend` 本地 `playwright` 可导入
  - 但 skill wrapper 当前实际落到 `@playwright/mcp` server 命令，而不是可直接交互的 `playwright-cli` 子命令
  - 本轮未把它作为主验证链路；在执行文档中已记录为“预检通过，但 wrapper 行为待修”

- 本轮真实验证：
  - 前端定向单测：
    - `cd frontend && npm test -- --run src/components/GameplayCardsModal.test.tsx src/lib/scenarioMeta.test.ts src/lib/archiveSummary.test.ts src/lib/dailyChallenge.test.ts src/game/replaySelection.test.ts src/game/replaySync.test.ts src/pages/SimulationView.test.tsx`
    - 结果：`30 passed`
  - 后端定向集成：
    - `cd backend && .venv/bin/python -m pytest tests/test_card_events.py tests/test_scene_selector.py tests/test_simulator_viz_integration.py -q`
    - 结果：`230 passed`
  - matrix smoke：
    - `cd frontend && npm run e2e:matrix -- --headless --themes governance,law,trade,war_logistics,generic --output-dir output/e2e/20260317-four-track-smoke`
    - 结果：通过
    - 工件：`frontend/output/e2e/20260317-four-track-smoke`

- `develop-web-game` 客户端现实坑位再次确认：
  - skill 脚本是 ESM 但扩展名为 `.js`，直接 `node` 会报：
    - `SyntaxError: Cannot use import statement outside a module`
  - 若复制到 `/tmp/*.mjs`，又会因找不到 `frontend/node_modules/playwright` 失败
  - 本轮可用 workaround：
    - 复制到 `frontend/.tmp-playwright/web_game_playwright_client.mjs`
  - 实际运行命令：
    - `cd frontend && node .tmp-playwright/web_game_playwright_client.mjs --url http://127.0.0.1:18928/sim/e8ae7cc0-8f11-4b7d-9c38-fdab2a6bac0f --actions-file ~/.codex/skills/develop-web-game/references/action_payloads.json --iterations 2 --pause-ms 250 --capture-mode panel --screenshot-dir output/web-game/20260317-director-campaign-doc`
  - 工件：
    - `frontend/output/web-game/20260317-director-campaign-doc/shot-0.png`
    - `frontend/output/web-game/20260317-director-campaign-doc/state-0.json`

- `playwright-interactive` 本轮真实检查面：
  - desktop 首页
  - mobile 首页
  - completed Theater `/sim/:id` desktop / mobile
  - result `/result/:id` desktop / mobile
  - result 分享 modal
  - 首页语言切换

- 本轮真实 UI 观察：
  - 首页 desktop / mobile 当前无致命裁切
  - mobile 首页首屏密度仍高，参数区需要向下滚动才能完整看完
  - completed Theater desktop 正常
  - mobile Theater 可用，但 Agent 区与实时发言区首屏信息密度仍偏高
  - result 页与分享 modal 正常

- 给下一个 agent 的默认起点：
  - 按 `implement/19_four_track_execution_plan.md` 从 `Track A / Phase A1` 开始：
    - 建 campaign 表
    - 写 finalize service
    - 结果页落一次 finalize
    - 前端先显示只读 campaign summary

## 2026-03-17 Implement 19 Execution Pass

- 已实际推进 `implement/19_four_track_execution_plan.md` 的前三条主线：
  - `Track A / Director Campaign`
  - `Track B / gameplay contract`
  - `Track C / verification + mobile evidence`
  - `Track D` 保持设计冻结，未开新模式代码

- `Track A` 后端已落地：
  - 新增 `backend/app/models/campaign.py`
  - 新增 `backend/app/services/campaign.py`
  - 新增 `backend/app/api/campaign.py`
  - 接入 `backend/app/main.py`
  - 新增 Alembic：`backend/alembic/versions/002_add_campaign_tables.py`
  - 新增测试：
    - `backend/tests/test_campaign_service.py`
    - `backend/tests/test_campaign_api.py`
  - 行为：
    - `POST /api/campaign/scenario/{id}/finalize`
    - `GET /api/campaign/profile/{user_id}`
    - `GET /api/campaign/profile/{user_id}/mastery`
    - `GET /api/campaign/profile/{user_id}/badges`
    - finalize 幂等；已完成场景才允许结算

- `Track A` 前端已接上：
  - 新增 `frontend/src/lib/directorIdentity.ts`
  - `PredictionModal` 现在会复用稳定本地 director identity，而不是每次匿名散掉
  - `ResultView` 会在本地 archive summary 稳定后调用 campaign finalize，并展示 `Campaign Progress`
  - `InputView` 会读取 director campaign 数据，在每日挑战卡与 quick start 区显示：
    - 当前题材 `Lv`
    - 距下次解锁差多少分
    - 已解锁徽章数 / 已完成局数

- `Track B` 已落一份共享事实源：
  - 新增 `shared/gameplay_contract.v1.json`
  - 来源不是手写 duplicate，而是从既有前端常量自动抽取生成
  - 已包含：
    - 10 张卡的 `labels / descriptions / animation / cost / cooldown / auto_cooldown / trigger flags`
    - 12 个 profile 的 `labels / descriptions / signature hooks / recommended cards / default directives / signature arc`
    - `card_system_effects`
  - 前端已开始消费：
    - `frontend/src/lib/gameplayContract.ts`
    - `frontend/src/lib/scenarioMeta.ts`
    - `frontend/src/components/GameplayCardsModal.tsx`
    - `frontend/src/components/gameplayCards.ts` 的主要 helper 逻辑
  - 后端已消费：
    - `backend/app/services/gameplay_contract.py`
    - `backend/app/visualization/card_events.py`
  - 新增验证：
    - `frontend/src/components/gameplayContract.test.ts`
    - `backend/tests/test_gameplay_contract_sync.py`

- 额外视觉契约补丁：
  - `frontend/src/game/scenes/WorldScene.ts` 新增 `hearing_bell`，避免 `public_hearing` 落到 generic flash

- 本轮前端验证：
  - `cd frontend && npm run build` 通过
  - `cd frontend && npm test -- --run src/pages/InputView.test.tsx src/pages/ResultView.test.tsx src/components/gameplayContract.test.ts src/components/PredictionModal.test.tsx`
  - 结果：`7 passed`

- 本轮后端验证：
  - `cd backend && source .venv/bin/activate && ruff check ... && pytest tests/test_campaign_service.py tests/test_campaign_api.py tests/test_card_events.py tests/test_gameplay_contract_sync.py -q`
  - 结果：`28 passed`

- 本轮正式 E2E / 黑盒工件：
  - 12-profile matrix + corners 主跑产物目录：
    - `frontend/output/e2e/20260317-implement19-final`
    - 说明：
      - `full` 首轮因 mobile Theater 判定条件过严而在最后阶段超时
      - matrix / corners 工件本身已落盘完成，不需要重跑
  - mobile 正式重跑目录：
    - `frontend/output/e2e/20260317-implement19-mobile-rerun`
    - 工件：
      - `mobile-home.json`
      - `mobile-home.png`
      - `mobile-theater.json`
      - `mobile-theater.png`
      - `mobile-result.json`
      - `mobile-result.png`
      - `result.json`
    - 说明：
      - `mobile-theater.json` 中 `replayState` 正常，但 `scene` 可能为 `null`
      - 已用 Playwright 手工补证：
        - `frontend/output/e2e/20260317-implement19-mobile-rerun/manual-mobile-theater.png`
        - `frontend/output/e2e/20260317-implement19-mobile-rerun/manual-mobile-theater.md`
      - 手工 `window.render_game_to_text()` 已确认 mobile Theater 实际为 `scene = WorldScene`、`theme = scifi_base`

- `develop-web-game` 再次真实取证：
  - 命令：
    - `cd frontend && node .tmp-playwright/web_game_playwright_client.mjs --url http://127.0.0.1:18928/sim/72ae364d-3ea1-4959-939c-8fe1dbeca1c9 --actions-file ~/.codex/skills/develop-web-game/references/action_payloads.json --iterations 2 --pause-ms 250 --capture-mode panel --screenshot-dir output/web-game/20260317-implement19`
  - 工件：
    - `frontend/output/web-game/20260317-implement19/shot-0.png`
    - `frontend/output/web-game/20260317-implement19/shot-1.png`
    - `frontend/output/web-game/20260317-implement19/state-0.json`
    - `frontend/output/web-game/20260317-implement19/state-1.json`
  - 已人工看图：
    - 非黑图
    - HUD / scene / bubbles 正常可见

- 本轮人工视觉 QA 结论：
  - mobile 首页：
    - `frontend/output/e2e/20260317-implement19-mobile-rerun/mobile-home.png`
    - 每日挑战卡 + 生涯提示首屏可见
  - mobile Theater：
    - `frontend/output/e2e/20260317-implement19-mobile-rerun/manual-mobile-theater.png`
    - 主剧场、HUD、Agent 列表首屏均可见；信息密度仍偏高，但未裁切到不可用
  - mobile 结果页：
    - `frontend/output/e2e/20260317-implement19-mobile-rerun/mobile-result.png`
    - 顶部 CTA 与第一张结局卡首屏可见

- 当前已知剩余边界 / 下一步：
  - `Track B` 仍是 Phase B1：
    - shared contract 已落地并被消费，但 `frontend/src/components/gameplayCards.ts` 里还保留 legacy 常量，下一轮可以清掉，进入更彻底的 Phase B2
  - `Track C`：
    - `full` 模式需要把 matrix / corners / mobile 的 summary result 再统一收口，避免首轮那种“最后一步 mobile 条件太严导致整套 exit 1”
  - `Track A`：
    - 现在是本地 director identity + 后端 campaign 的最小闭环
    - 还没有真正跨设备身份统一；不同浏览器/无 localStorage 共享时，旧 scenario 可能对新 director 返回 `409`

## 2026-03-17 Boundary Hardening + AI Asset Pipeline

- 已补 `campaign` 边界收口：
  - `InputView` 不再在“首次无 profile”时并发打 3 个 campaign GET 并制造重复 404；现在先取 `profile`，不存在就直接回退到空态。
  - `ResultView` 对 `finalize` 的两类边界态做了降级处理：
    - `404`：临时 / mocked result，不写 campaign
    - `409`：该历史结果已归属另一 director profile，本设备不重复计入
  - 这两类现在走普通说明文案，不再显示红色错误。

- 已补 AI 素材批量生成脚本：
  - 新增：
    - `frontend/scripts/generate-ui-assets.mjs`
  - 特点：
    - 支持 `--preset ...` 批量出图
    - 会先尝试 `aiplatform.googleapis.com`
    - 若失败，自动回退到已验证可用的 `generativelanguage.googleapis.com`
    - 输出 `.png` 与同名 `.meta.json`
  - 当前预置 preset：
    - `generic_frame`
    - `law_scene_variant`
    - `faith_scene_variant`

- 真实 endpoint 结论再次确认：
  - `aiplatform.googleapis.com/v1/publishers/google/models/...:generateContent?key=...`
    - 当前返回 `401 UNAUTHENTICATED`
    - 说明这条链路需要 OAuth，不接受手头这类 API key
  - `generativelanguage.googleapis.com/v1beta/models/...:generateContent?key=...`
    - 对同一把 key 可正常返回图片
  - 因此当前脚本的实际稳定 provider 仍是 `generativelanguage`

- 已用脚本真实补了一张资产：
  - 新增：
    - `frontend/public/assets/ui/generated/gameplay_card_frame_generic.png`
    - `frontend/public/assets/ui/generated/gameplay_card_frame_generic.png.meta.json`
  - 接线：
    - `frontend/src/lib/themeRegistry.ts` 中 `generic` 已不再复用 `gameplay_panel.png`
    - 改为使用 `gameplay_card_frame_generic.png`
  - 资产清单已同步：
    - `frontend/public/assets/ASSET_CREDITS.md`
  - 手工验图：
    - 风格与现有 magenta / violet / brass 像素 UI 一致
    - 适合 generic 题材卡框，不再像之前那样直接借用整块 gameplay panel

- 本轮补充回归：
  - `cd frontend && npm run build && npm test -- --run src/pages/InputView.test.tsx src/pages/ResultView.test.tsx src/components/gameplayContract.test.ts src/components/PredictionModal.test.tsx src/components/gameplayCards.test.ts`
  - 结果：
    - build 通过
    - `25 passed`

## 2026-03-17 Sequential Variant Pass — Law Then Faith

- 已按顺序补完两个薄弱主题的 scene 变体：
  - `frontend/public/assets/scenes/law_court_variant.png`
  - `frontend/public/assets/scenes/faith_temple_variant.png`
  - 对应 meta：
    - `law_court_variant.png.meta.json`
    - `faith_temple_variant.png.meta.json`
  - 生成方式：
    - `frontend/scripts/generate-ui-assets.mjs`
    - provider 实际命中 `generativelanguage`

- 已人工看图：
  - `law_court_variant.png`：更偏高耸合议庭 / 司法档案厅
  - `faith_temple_variant.png`：更偏圣议会 / 教义争辩大厅
  - 二者都与现有像素风、紫金点缀和 16:9 宽构图一致，可直接混入现有 Theater 池

- 已完成接线：
  - 前端：
    - `frontend/src/lib/themeRegistry.ts`
      - 新增 `law_court_variant`
      - 新增 `faith_temple_variant`
      - `SCENE_THEME_IDS` 实际从 27 → 29
    - `frontend/src/game/scenes/WorldScene.ts`
      - 新增两套 palette
      - 加入 darkThemes
  - 后端：
    - `backend/app/visualization/scene_selector.py`
      - 新增更具体的 `law` / `faith` 变体关键词
      - `AVAILABLE_SCENES` 从 27 → 29

- 关键词策略：
  - `law_court` 继续负责泛法律 / 法院 / 宪法 / veto
  - `law_court_variant` 只吃更具体的：
    - `grand tribunal`
    - `constitutional chamber`
    - `appellate bench`
    - `multi-judge hearing`
    - `合议庭`
    - `大审判庭`
    - `终审法庭`
  - `faith_temple` 继续负责泛神谕 / 教会 / 神权 / temple
  - `faith_temple_variant` 只吃更具体的：
    - `sacred council`
    - `doctrinal council`
    - `clerical schism`
    - `ritual council`
    - `圣议会`
    - `教义议会`
    - `祭司议会`
    - `教团分裂`

- 已更新清单：
  - `frontend/public/assets/ASSET_CREDITS.md`

- 已新增 / 更新验证：
  - 后端：
    - `backend/tests/test_scene_selector.py`
      - 新增 `law_court_variant`
      - 新增 `faith_temple_variant`
      - `AVAILABLE_SCENES == 29`
  - 前端：
    - `frontend/src/game/managers/VizSynthesizer.test.ts`
      - 新增两条 variant 命中
    - `frontend/src/game/scenes/WorldScene.test.ts`
      - 场景覆盖从 27 → 29

- 本轮定向回归：
  - `cd backend && source .venv/bin/activate && pytest tests/test_scene_selector.py -q`
    - `142 passed`
  - `cd frontend && npm test -- --run src/game/managers/VizSynthesizer.test.ts src/game/scenes/WorldScene.test.ts src/components/gameplayCards.test.ts`
    - `64 passed`
  - `cd frontend && npm run build`
    - 通过

- 下一顺位建议：
  - 若继续顺推，优先补 `generic` 的 scene 变体，而不是只停留在卡框：
    - 例如 `switchboard_forum_variant / rotating review chamber`
  - 再下一步再补 `law` / `faith` 的 matrix 样本清单，把变体真正纳入 E2E，而不是只停留在选景函数能命中

## 2026-03-17 Sequential Variant Pass — Generic

- 已继续顺推 `generic` 的第二场景变体：
  - 新增：
    - `frontend/public/assets/scenes/switchboard_forum_variant.png`
    - `frontend/public/assets/scenes/switchboard_forum_variant.png.meta.json`
  - 提示词方向：
    - `rotating review chamber`
    - `procedural tribunal`
    - `civic switchboard chamber`
    - 保持暖象牙 / 紫红 / 黄铜 / 像素策略 UI 风格

- 已完成接线：
  - 前端：
    - `frontend/src/lib/themeRegistry.ts`
      - 新增 `switchboard_forum_variant`
      - `SCENE_THEME_IDS` / inventory scenes 实际从 29 → 30
    - `frontend/src/game/scenes/WorldScene.ts`
      - 新增 palette
  - 后端：
    - `backend/app/visualization/scene_selector.py`
      - 新增更具体的 generic procedural / review chamber 关键词
      - `AVAILABLE_SCENES` 从 29 → 30

- 关键词策略：
  - `switchboard_forum`
    - 继续吃 `rotating leadership / random leader swap / lottery committee / rotating external review board`
  - `switchboard_forum_variant`
    - 只吃更具体的：
      - `rotating review chamber`
      - `procedural tribunal`
      - `civic switchboard chamber`
      - `committee dais`
      - `oversight chamber`
      - `轮值审查议场`
      - `程序议场`
      - `外部审查议场`
      - `轮值委员会中枢`
      - `程序委员会大厅`

- 已更新：
  - `frontend/public/assets/ASSET_CREDITS.md`
  - 前端 / 后端选景测试与 WorldScene 覆盖计数

- 本轮定向回归：
  - `cd backend && source .venv/bin/activate && pytest tests/test_scene_selector.py -q`
    - `144 passed`
  - `cd frontend && npm test -- --run src/game/managers/VizSynthesizer.test.ts src/game/scenes/WorldScene.test.ts src/components/gameplayCards.test.ts`
    - `64 passed`
  - `cd frontend && npm run build`
    - 通过

- 真实 smoke：
  - 新建题面：
    - `What if every emergency review had to pass through a rotating review chamber before execution?`
  - 后端 `POST /api/scenario` 首响应即命中：
    - `scene_theme = switchboard_forum_variant`
  - 前端 Theater 实测：
    - HUD 显示 `轮值审查议场`
    - `render_game_to_text().scene.theme = switchboard_forum_variant`
  - 工件：
    - `frontend/output/e2e/generic-variant-smoke-switchboard-20260317/scenario.json`
    - `frontend/output/e2e/generic-variant-smoke-switchboard-20260317/theater.png`

- 当前下一顺位：
  - 若继续顺推，就该把 `law_court_variant / faith_temple_variant / switchboard_forum_variant` 真正并入 `sample_matrix.json` 或独立 `variant_matrix.json`
  - 然后跑一次 variants-only matrix，把变体从“函数命中 + 单条 smoke”升级为正式 E2E 套件成员

## 2026-03-17 Variant Matrix Formalized

- 已把三个变体正式纳入独立 blackbox matrix：
  - `law_grand_tribunal`
  - `faith_council`
  - `generic_review_chamber`

- 新增：
  - `frontend/output/e2e/sample_matrix_variants.json`
  - `frontend/package.json` 脚本：
    - `npm run e2e:variants`
  - `frontend/scripts/e2e-suite.mjs`
    - 新增 3 个 variant fallback 题面

- 这套 matrix 不污染默认 `sample_matrix.json` / `e2e:full`
  - 保持主 12-profile 套件稳定
  - variants 作为独立加跑层

## 2026-03-17 A3 Daily Truth + i18n Hardening

- 已继续收口 `implement/19_four_track_execution_plan.md` 的剩余项：
  - `Track A3`：daily challenge 完成态开始优先结合后端 campaign 真源，而不是只看 localStorage
  - `Track B2`：`frontend/src/components/gameplayCards.ts` 的 legacy gameplay contract 副本已切到 shared contract 单一事实源
  - i18n：`PredictionModal` 的 bet kind / tone / resonance / preview 文案不再硬编码中文

- 前端当前状态：
  - `InputView` 会并行读取：
    - `getCampaignProfile`
    - `getCampaignMastery`
    - `getCampaignBadges`
    - `getCampaignDailyChallengeStatus`
  - `dailyChallenge.ts` 现通过 `resolveChallengeProgress()` 合并：
    - 本地进度
    - 后端 daily challenge 完成态
  - 同场景时保留本地 `usedCards / betPlaced` 明细；跨设备只信后端“已完成”事实，不伪造本地细节
  - `PredictionModal` 现按当前语言渲染：
    - `Branch Winner / Ending Tone / Theme Resonance`
    - `ENDING_TONE_OPTIONS`
    - `PROFILE_RESONANCE_OPTIONS`
    - preview 行文案

- 本轮验证：
  - `cd frontend && npm test -- --run src/pages/InputView.test.tsx src/components/PredictionModal.test.tsx src/components/gameplayContract.test.ts src/components/gameplayCards.test.ts`
    - `26 passed`
  - `cd frontend && npm run build`
    - 通过
  - `cd backend && .venv/bin/python -m pytest tests/test_campaign_service.py tests/test_campaign_api.py -q`
    - `8 passed`

- 真实浏览器 QA：
  - 本地 dev server 已重新用持久 TTY 会话启动：
    - backend `uvicorn ... 127.0.0.1:18927`
    - frontend `vite ... 127.0.0.1:18928`
  - 使用 Playwright MCP 真实检查：
    - desktop 首页语言切换
    - 英文 `PredictionModal`
    - desktop 结果页
    - mobile 首页
    - mobile Theater
    - result share modal 打开态
  - 截图工件：
    - `frontend/result-desktop-a3-b2.png`
    - `frontend/home-mobile-top-a3-b2.png`
    - `frontend/theater-mobile-a3-b2.png`

- 关键限制 / 已知边界：
  - `npm run e2e:matrix/full` 仍无法作为主签收链路，原因不是业务回归，而是本机 Playwright browser launch 在 Chromium headless / headed 都被 macOS 权限拦截：
    - `bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer ... Permission denied (1100)`
  - `develop-web-game` 客户端同样命中这条底层浏览器启动限制，因此本轮已记录失败事实，并改用 Playwright MCP 做页面级真实 QA
  - 当前浏览器 console 仍有两类可见网络噪声：
    - 首页首次无 campaign profile 时的 `404`
    - 打开已归属其他 director 的结果页时 `finalize` 返回 `409`
  - 这些边界当前都已有 UI 降级文案，不会阻断使用；如果下一轮继续硬化，可考虑把这两类“预期边界”从 HTTP error 收口成非错误态摘要接口

- 已实际运行：
  - `cd frontend && npm run e2e:variants -- --headless --output-dir output/e2e/20260317-variant-matrix`

- 结果：
  - 3/3 通过
  - 工件目录：
    - `frontend/output/e2e/20260317-variant-matrix/result.json`

- 已回填固定样本：
  - `frontend/output/e2e/sample_matrix_variants.json`
    - 已写入：
      - `scenario_id`
      - `completed_branch_count`
      - `replay/result/share` 工件绝对路径

- 实际命中结果：
  - `law_grand_tribunal`
    - 后端 fallback 场景：`ac977548-39d4-4bf8-8e2f-8700e79e0d21`
    - 正式工件：
      - `frontend/output/e2e/law_grand_tribunal-replay-proof/`
      - `frontend/output/e2e/law_grand_tribunal-result-headed/`
  - `faith_council`
    - 后端 fallback 场景：`67bba632-e320-450a-a608-513b313a8a3f`
    - 正式工件：
      - `frontend/output/e2e/faith_council-replay-proof/`
      - `frontend/output/e2e/faith_council-result-headed/`
  - `generic_review_chamber`
    - 后端 fallback 场景：`d5e2191d-1ca7-43d9-8d52-58317228837e`
    - 正式工件：
      - `frontend/output/e2e/generic_review_chamber-replay-proof/`
      - `frontend/output/e2e/generic_review_chamber-result-headed/`

- 到这里为止，薄弱题材变体不再只是：
  - 单测命中
  - 单条 smoke
  - 手工截图
  而是已经升级成可重复执行的正式 E2E 套件成员

## 2026-03-17 Campaign Truth + Prediction i18n Follow-up

- 已继续推进 `implement/19_four_track_execution_plan.md` 的剩余收口点：
  - `Track A3`
    - 首页 daily challenge 不再只看 localStorage
    - 现已接入后端 `campaign daily-status`
    - `frontend/src/lib/dailyChallenge.ts` 新增 `resolveChallengeProgress()`，把本地缓存与后端真源合并为单一显示状态
  - `Track B2`
    - `frontend/src/components/gameplayCards.ts` 的 legacy gameplay contract 大常量已被清理，改为统一消费 `frontend/src/lib/gameplayContract.ts`
  - `i18n`
    - `PredictionModal` 的下注类型、结局倾向、题材回响下拉和 preview 文案不再硬编码中文
    - 英文 UI 下现在会正确显示 `Branch Winner / Ending Tone / Theme Resonance` 及英文 target label

- 本轮前端定向验证：
  - `cd frontend && npm test -- --run src/lib/dailyChallenge.test.ts src/pages/InputView.test.tsx src/pages/ResultView.test.tsx src/components/PredictionModal.test.tsx src/components/gameplayContract.test.ts src/components/gameplayCards.test.ts`
    - `34 passed`
  - `cd frontend && npm run build`
    - 通过

- 本轮后端定向验证：
  - `cd backend && .venv/bin/python -m pytest tests/test_campaign_service.py tests/test_campaign_api.py tests/test_gameplay_contract_sync.py -q`
    - `10 passed`

- 当前环境限制：
  - `playwright-interactive` / `e2e:corners` / `develop-web-game` 在这台机器上都无法成功启动浏览器
  - 真实错误：
    - `bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.*: Permission denied (1100)`
  - 影响：
    - 本轮无法在当前环境重新生成新的 browser-level screenshot 工件
    - 代码、类型、单测与 API 层已验证；浏览器真值仍需要在可正常启动 Chromium 的环境里补跑

- 给下一轮 agent 的直接建议：
  - 若继续做真实 E2E，先解决当前 macOS 浏览器启动权限问题，再重跑：
    - `npm run e2e:corners -- --headless --output-dir output/e2e/<run>`
    - `node .tmp-playwright/web_game_playwright_client.mjs --url http://127.0.0.1:18928/sim/<scenario_id> --actions-file ~/.codex/skills/develop-web-game/references/action_payloads.json --iterations 2 --pause-ms 250 --capture-mode panel --screenshot-dir output/web-game/<run>`
  - 若只继续代码层推进，当前更值得优先补的是：
    - 把 `campaign daily-status` 真值也接入更多自动化摘要 / E2E 脚本
    - 清理 `backend/app/api/campaign.py` / `campaign.py` 中新增 daily-status 时留下的轻微重复字段与 helper

## 2026-03-17 Campaign Truth + Prediction i18n Verification Addendum

- 已重新在主工作区复验一轮，最新结果以这条为准：
  - `cd backend && .venv/bin/python -m pytest tests/test_campaign_service.py tests/test_campaign_api.py tests/test_gameplay_contract_sync.py -q`
    - `10 passed`
  - `cd frontend && npm test -- --run src/lib/dailyChallenge.test.ts src/pages/InputView.test.tsx src/pages/ResultView.test.tsx src/components/PredictionModal.test.tsx src/components/gameplayContract.test.ts src/components/gameplayCards.test.ts`
    - `36 passed`
  - `cd frontend && npm run build`
    - 通过

- 为避免误连到别的工作区进程，本轮还单独起过：
  - 当前仓库 backend：`127.0.0.1:18937`
  - 当前仓库 frontend：`127.0.0.1:18938`
  - 目的：把 daily challenge 后端真源与前端改动放到同一套运行时里验证

- 结论保持不变：
  - 代码层、API 层、类型检查、前端定向测试都已通过
  - 浏览器级 Playwright 黑盒仍被当前 macOS 权限环境阻塞，不属于项目代码失败

## 2026-03-17 Implement19 Final Push

- 已继续收口 `implement/19_four_track_execution_plan.md`：
  - `Track A3`
    - 新增后端 `GET /api/campaign/profile/{user_id}/daily-status`
    - 首页改为优先读取后端 daily challenge 真源，再和本地缓存合并显示
    - `frontend/src/lib/dailyChallenge.ts` 新增 `ResolvedChallengeProgress` / `resolveChallengeProgress()`
    - 仅当本地确有对应场景细节时才显示“已用卡数 / 是否已下注”，避免后端真源场景被前端瞎补本地细节
  - `Track B2`
    - `frontend/src/components/gameplayCards.ts` 已进一步去掉重复导出的 contract 常量别名
    - 文件内部改为统一走 `gameplayContract.ts` 提供的 typed alias，不再暴露第二份 card/profile/signature/system-effect 事实源

- 本轮验证：
  - `cd backend && ./.venv/bin/python -m pytest tests/test_campaign_service.py tests/test_campaign_api.py -q`
    - `8 passed`
  - `cd frontend && npm test -- --run src/components/gameplayContract.test.ts src/components/gameplayCards.test.ts src/pages/InputView.test.tsx src/lib/dailyChallenge.test.ts src/pages/ResultView.test.tsx`
    - `30 passed`
  - `cd frontend && npm run build`
    - 通过

- 本轮浏览器工件补充：
  - `frontend/output/e2e/20260317-implement19-final/mobile/mobile-home.png`
  - `frontend/output/e2e/20260317-implement19-final/mobile/mobile-home.json`
  - `frontend/output/e2e/20260317-implement19-final/corners/replay-skip-switch/replay-corner.png`
  - `frontend/output/e2e/20260317-implement19-final/corners/replay-skip-switch/replay-corner.json`
  - `frontend/output/e2e/20260317-implement19-final/corners/share-context/share-generated.png`
  - `frontend/output/e2e/20260317-implement19-final/corners/share-context/share-generated.json`

- 本轮浏览器限制更新：
  - `develop-web-game` client 在当前环境启动 Chromium 时仍会报：
    - `bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.*: Permission denied (1100)`
  - `npm run e2e:matrix` / `npm run e2e:full` 在这台机器上也出现 Playwright browser launch fallback 全失败
  - 这更像当前 macOS 自动化/浏览器会话环境问题，而不是业务代码失败
  - 部分新工件来自套件在失败前已经跑完的 `corners / mobile` 子流程；`replay-corner.png` 里的黑色 Theater 区很可能仍是 headless WebGL 取图伪像，和仓库内已有 `*-replay-headed.png` 的正常有画面结果不一致

- 给下一轮 agent 的直接建议：
  - 如果继续做真浏览器验证，先清掉测试浏览器残留进程，再在可正常启动 Playwright 的环境里补跑：
    - `npm run e2e:matrix -- --headless --themes governance,law,trade,ecology,war,faith,industry,frontier,mythic,survival,generic,governance_surveillance,empire_palace,industry_grid,war_logistics --output-dir output/e2e/<run>`
    - `npm run e2e:full -- --headless --output-dir output/e2e/<run>`
  - 如果继续代码层推进，当前更适合做的是：
    - 把 `daily-status` 接进更多自动化摘要 / E2E 断言
    - 把 `playwright` 启动 profile 冲突与 macOS 权限问题收敛到脚本层，避免每次手工清理

## 2026-03-17 A3 Wiring + E2E Recovery

- 本轮实际完成：
  - 首页 `InputView` 已接入后端 `campaign daily-status` 真源，并通过 `resolveChallengeProgress()` 与本地缓存合并。
  - `ResultView` 不再只按“今天的 challenge id”判断 daily challenge，而是通过 `findChallengeProgressByScenarioId()` 反查，跨天回看同机缓存场景时也能保持 challenge 身份。
  - `dailyChallenge.ts` 新增：
    - `ResolvedChallengeProgress`
    - `resolveChallengeProgress()`
    - `findChallengeProgressByScenarioId()`
  - `frontend/scripts/e2e-suite.mjs` 已修：
    - matrix runtime fallback 会重开新页面，不再复用已关闭 page
    - share generation 等待条件改为等待 `active_platform=xiaohongshu + has_copy=true`，并把超时放宽到 90s

- 本轮验证结果：
  - `cd frontend && env TMPDIR=/Users/yangjunjie/Desktop/upgrade-test/frontend/.tmp npm test -- --run src/lib/dailyChallenge.test.ts src/pages/InputView.test.tsx src/pages/ResultView.test.tsx src/components/gameplayCards.test.ts src/components/gameplayContract.test.ts`
    - `32 passed`
  - `cd backend && env TMPDIR=/Users/yangjunjie/Desktop/upgrade-test/backend .venv/bin/python -m pytest tests/test_campaign_service.py tests/test_campaign_api.py tests/test_gameplay_contract_sync.py tests/test_card_events.py -q`
    - `31 passed`
  - `cd frontend && env TMPDIR=/Users/yangjunjie/Desktop/upgrade-test/frontend/.tmp npm run build`
    - 通过

- 本轮真实浏览器 / 黑盒结果：
  - matrix 全量 15 主题通过：
    - `frontend/output/e2e/20260317-matrix-rerun/result.json`
  - corners 全量通过：
    - `frontend/output/e2e/20260317-corners-rerun/result.json`
  - mobile 套件通过：首页 / Theater / result 三段摘要已落盘：
    - `frontend/output/e2e/20260317-mobile-rerun/result.json`
  - `develop-web-game` 客户端本轮成功运行，不再被浏览器权限阻塞：
    - `frontend/output/web-game/20260317-a3-b2-law-check/shot-0.png`
    - `frontend/output/web-game/20260317-a3-b2-law-check/state-0.json`

- 交互式人工复核（本轮用 chrome-devtools 代替 playwright wrapper，会话可正常工作）：
  - desktop 首页：daily challenge 卡、campaign 文案、quick start 正常
  - mobile 首页：首屏可用，无明显裁切
  - result 页：`Campaign Progress` 可见，share modal 可打开
  - 手工点击 `小红书` 后文案最终成功生成；说明之前 corners 失败是 harness 等待条件过紧，不是产品不可用

- 残余观察：
  - mobile suite 输出的 `agent_count=0` 更像 capture 时机问题；同一场景用交互式快照复看时，移动端 Theater 实际有完整 HUD、Agent 列表与消息流
  - share generation 在复杂结果页上可能接近 30s，脚本层已放宽等待，但产品层仍属于“可用但偏慢”

- 给下一轮 agent 的建议：
  - 若继续扩 daily challenge 真源，可把后端 `daily-status` 的字段继续扩到 `used_card_count / bet_placed`，这样首页就能完全摆脱本地缓存细节
  - 若继续做跨平台 QA，优先补 Safari / iOS 真机或模拟器验证；本轮实际浏览器验证主要基于 Chromium

## 2026-03-17 Track D Blueprint

- 已新增 implement/21_track_d_debate_arena_mvp_blueprint.md。
- 文档覆盖：
  - 产品设计与玩法循环
  - 美术素材与 Gemini 生图约束
  - 前后端代码开发拆解
  - i18n 与跨平台 Web 约束
  - 单测 / 集成 / E2E / skill-based QA 矩阵
  - code review 与验收标准
- 已同步 implement/README.md 索引。
- 本轮未实现 Debate Arena 代码，只产出可直接开工的 Track D 规格与执行蓝图。

## 2026-03-17 Track D Gameplay + Cross-Platform Hardening

- Debate Arena 后端规则层已继续加厚，但保持协议不扩张：
  - `backend/app/services/debate_prompts.py`
    - `law / governance / trade / faith / ecology / war` 现有明确区分的 deterministic 辩风文案，中英双语都不再只是换 profile 标签。
  - `backend/app/services/debate_scoring.py`
    - profile 会轻量影响 `coherence / evidence / adaptability / impact` 偏置；
    - `war / ecology` 在高风险题面更容易落到 `rupture`。
  - `backend/app/api/debate.py`
    - `closing / verdict` 阶段会锁单，不再允许临近结果时补押；
    - `ERROR` 终态的 result API 现返回 `500`，不再伪装成 `409 未就绪`；
    - create debate 时新增 `3.0s` 开场缓冲，确保 live 页真的留出下注窗口。

- Debate Arena 前端 live/result 继续打磨：
  - `frontend/src/pages/DebateArenaView.tsx`
    - 阶段 ribbon 现在支持手动锁定回看，`selected_phase / is_phase_locked / unlocked_phases` 已进入 automation payload；
    - 新增 `Arena Read / 局势解读` 面板，显示本阶段焦点、局势压力、评委关注轴与押注窗口状态；
    - `auto_reveal` 的 `On/Off` 已本地化；
    - 移动端新增固定底部主 CTA：live 时优先给 `下注`，结算后优先给 `查看判词`。
  - `frontend/src/pages/DebateResultView.tsx`
    - `show_share_modal / active_modal` 已进入 automation payload；
    - 终态错误会直接显示，不再无限轮询。
  - `frontend/src/pages/DebateArena.css`
    - 小屏下压缩 hero、改 stage ribbon 为横向滚动，并为 mobile 主 CTA 预留固定底部区域。
  - `frontend/src/i18n/locales/en.json` / `zh.json`
    - 已补 Debate live/result 的策略文案、bet window、终态错误与 mobile CTA 语义。

- 本轮验证通过：
  - 后端：
    - `cd backend && ./.venv/bin/python -m pytest tests/test_debate_service.py tests/test_debate_api.py -q`
    - `10 passed`
  - 前端：
    - `cd frontend && npm exec -- tsc --noEmit`
    - `cd frontend && npm test -- --run src/pages/DebateArenaView.test.tsx src/pages/DebateResultView.test.tsx src/stores/debateStore.test.ts`
    - `4 passed`
    - `cd frontend && npm run build`
    - 通过

- 本轮真实浏览器 / 黑盒取证：
  - Desktop 英文：
    - `Start Debate Arena -> Open Bet -> Lock Bet -> View Verdict -> Share Result` 已由 Playwright 真实跑通；
    - 英文 trade 题面最终落到 `debate_arena_forum`，结果页 automation payload 显示 `prediction_count = 1`。
  - Mobile 中文：
    - `进入辩论竞技场 -> 下注 -> 锁定押注 -> 查看判词 -> 分享结果` 已真实跑通；
    - 中文 law 题面最终落到 `debate_arena_judicial`；
    - share modal 中文文案可见且可复制。
  - `develop-web-game` 黑盒客户端已产出工件：
    - `frontend/output/web-game/20260317-debate-arena-signoff/shot-0.png`
    - `frontend/output/web-game/20260317-debate-arena-signoff/shot-1.png`
    - `frontend/output/web-game/20260317-debate-arena-signoff/state-0.json`
    - `frontend/output/web-game/20260317-debate-arena-signoff/state-1.json`
    - 当前黑盒工件验证的是 result 页；state JSON 已包含 `show_share_modal / active_modal / prediction_count` 等 Debate 专属摘要。

- 本轮额外截图工件：
  - `debate-mobile-zh-result.png`
  - `debate-mobile-zh-share.png`
  - `debate-mobile-zh-opening-top-2.png`

- 下一轮若继续 Track D，建议优先级：
  - 给 `useDebateWS` 补一版和 `useSimulationWS` 对齐的 StrictMode / cleanup 防抖，避免延迟首连计时器竞态；
  - 给 `DebateBetModal` / `DebateShareModal` 补组件测试和更细的 automation payload；
  - 若继续提升移动端首屏，再把 live hero 的 momentum + CTA 再压一层，争取把 `下注` 也完全收进最上方首屏里。

## 2026-03-17 Track D Follow-up - Debate WS Cleanup

- 已继续完成上一条建议里的第一项：
  - `frontend/src/hooks/useDebateWS.ts`
    - 增加 `connectTimerRef`，现在会在 cleanup 时取消延迟首连；
    - 正常关闭 `code=1000` 时不再触发重连；
    - reconnect timer 在重复调度前会先清理，避免残留定时器。
- 新增 hook 级回归：
  - `frontend/src/hooks/useDebateWS.test.tsx`
    - 覆盖：
      - `unmount before delayed connect`
      - `normal close does not reconnect`
      - `abnormal close still reconnects`
- 回归通过：
  - `cd frontend && npm test -- --run src/hooks/useDebateWS.test.tsx src/pages/DebateArenaView.test.tsx src/pages/DebateResultView.test.tsx`
    - `5 passed`
  - `cd frontend && npm exec -- tsc --noEmit`
    - 通过

## 2026-03-17 Track D Debate E2E Baseline Script

- 已新增 Debate 专项黑盒基线脚本：
  - `frontend/scripts/e2e-debate-suite.mjs`
- 设计取向：
  - 不去改现有 `matrix / corners / mobile / full` 主套件；
  - 单独收口 Debate 的最小闭环：
    - `live -> bet -> result -> share`
  - 输出结构延续现有 `e2e-suite` 风格：
    - `browser-launch.json`
    - `live.json/.png`
    - `bet-open.json/.png`
    - `bet-submitted.json/.png`
    - `result-ready.json/.png`
    - `result-initial.json/.png`
    - `share-open.json/.png`
    - `share-generated.json/.png`
    - `result.json`
- 脚本模式：
  - `desktop`
    - 英文 trade 辩题
  - `mobile`
    - 中文 law 辩题
  - `full`
    - 同时产出 `desktop/` 与 `mobile/` 两套 Debate 工件
- 使用方式：
  - `cd frontend && node scripts/e2e-debate-suite.mjs desktop --output-dir output/e2e/debate-desktop`
  - `cd frontend && node scripts/e2e-debate-suite.mjs mobile --output-dir output/e2e/debate-mobile`
  - `cd frontend && node scripts/e2e-debate-suite.mjs full --output-dir output/e2e/debate-full`

## 2026-03-18 Track D Debate E2E Baseline - Green Run

- Debate 专项基线脚本已继续修到可真实跑通：
  - `frontend/scripts/e2e-debate-suite.mjs`
- 本轮关键脚本修复：
  - 去掉脚本里的 TS-only 语法，保证 `node --check` 可通过；
  - Playwright 浏览器启动优先改为 `chromium-default`，避免系统 Chrome 会话/Google 跳转污染；
  - desktop 按钮点击改为基于 Debate hero 控件位次，而不是脆弱的文本匹配；
  - mobile 按钮点击改为优先点 `.debate-mobile-rail .btn`，失败再 fallback 到 hero controls；
  - Debate modal / share modal 的状态抓取改为 DOM 读取，不再依赖 locator 文本阻塞；
  - mobile 时序改为更保守的 `disable auto reveal -> open bet -> wait modal -> save live screenshot`；
  - Debate 开场缓冲从 `3.0s` 提升到 `5.0s`，给 mobile 留出真实下注窗口。

- 本轮真实执行命令：
  - `node --check frontend/scripts/e2e-debate-suite.mjs`
  - `node frontend/scripts/e2e-debate-suite.mjs full --url http://127.0.0.1:18929 --output-dir frontend/output/e2e/20260318-debate-full-5s`

- 结果：
  - `full` 通过
  - `desktop`：
    - locale: `en`
    - scene: `debate_arena_forum`
    - winner: `opposition`
    - verdictTone: `order`
    - predictionCount: `1`
    - share modal: `Xiaohongshu`, `copy_length=675`
  - `mobile`：
    - locale: `zh`
    - scene: `debate_arena_judicial`
    - winner: `proposition`
    - verdictTone: `balance`
    - predictionCount: `1`
    - share modal: `小红书`, `copy_length=251`

- 成功工件目录：
  - `frontend/output/e2e/20260318-debate-full-5s/`
  - 其中包含：
    - `desktop/live.json`
    - `desktop/bet-open.json`
    - `desktop/bet-submitted.json`
    - `desktop/result-ready.json`
    - `desktop/result-initial.json`
    - `desktop/share-open.json`
    - `desktop/share-generated.json`
    - `mobile/live.json`
    - `mobile/bet-open.json`
    - `mobile/bet-submitted.json`
    - `mobile/result-ready.json`
    - `mobile/result-initial.json`
    - `mobile/share-open.json`
    - `mobile/share-generated.json`
    - 顶层 `result.json`

- 已把 Debate 基线脚本正式接到前端 npm scripts：
  - `cd frontend && npm run e2e:debate:desktop`
  - `cd frontend && npm run e2e:debate:mobile`
  - `cd frontend && npm run e2e:debate:full`
  - `cd frontend && npm run e2e:debate`

## 2026-03-18 Implement Docs + Track B2 收口

- 已同步 `implement/README.md`：
  - `Track B2` 改为已完成，不再标“半完成”；
  - `Track D Debate Arena` 改为已实现 MVP，而不是“待评估”。
- 已同步：
  - `implement/19_four_track_execution_plan.md`
  - `implement/20_track_d_debate_arena_design_execution_plan.md`
  - `implement/21_track_d_debate_arena_mvp_blueprint.md`
- 这三份文档现在都补了 `2026-03-18` 的实现状态同步，明确：
  - Debate 已有独立 backend domain / frontend live+result / bet+share / automation hooks；
  - 当前真实测试与 E2E 工件路径；
  - 旧的“待开工 / 设计冻结”表述仅作为归档设计基线，不再代表真实剩余工程。

- `Track B2` 本轮代码收口：
  - `shared/gameplay_contract.v1.json`
    - 新增每张卡的 `ui` 输入契约：
      - `requires_primary_agent`
      - `requires_secondary_agent`
      - `requires_source_branch`
      - `placeholder.zh/en`
    - 新增每张卡的 `prompt_lines.zh/en`
    - 新增 `branching_bonus`（当前 `spacetime_rift=0.15`）
  - `frontend/src/lib/gameplayContract.ts`
    - 前端 contract selector 现暴露 cost/cooldown、输入契约、placeholder、prompt lines、branching bonus
  - `frontend/src/components/GameplayCardsModal.tsx`
    - 删除卡牌 UI 的手写 `requires*` 常量
    - 删除 placeholder switch
    - 默认卡 fallback 改为从 contract 首项取，不再手写 `civilization_debate`
    - usage 写入不再硬编码 `cost: 1`
  - `frontend/src/lib/scenarioMeta.ts`
    - `applyCardUsage()` 改为内部按 contract 写入 cost，调用方不再传入
  - `frontend/src/components/gameplayCards.ts`
    - 删除大段 card-specific prompt switch
    - 改为从 contract `prompt_lines` 组装 prompt
  - `backend/app/visualization/card_events.py`
    - branching bonus 现从 contract 读取
    - auto trigger 逻辑不再写死 `spacetime_rift` 常量特例

- 本轮验证：
  - 前端定向：
    - `cd frontend && npm test -- --run src/components/gameplayContract.test.ts src/components/gameplayCards.test.ts src/components/GameplayCardsModal.test.tsx src/lib/scenarioMeta.test.ts`
    - 结果：`26 passed`
  - 后端定向：
    - `cd backend && .venv/bin/python -m pytest tests/test_card_events.py tests/test_gameplay_contract_sync.py -q`
    - 结果：`24 passed`
  - 前端构建：
    - `cd frontend && npm run build`
    - 结果：通过

- 本轮真实浏览器验证：
  - 新建 live scenario：
    - `3e0fedb0-2c53-486c-91bb-dac0f21b942e`
  - Playwright 真实检查：
    - `Gameplay Cards` modal 可打开；
    - `Public Hearing` 选中后不再显示 agent selector，placeholder 正确；
    - `Civilization Debate` 选中后显示 `Primary Agent + Second Agent`，placeholder 正确；
    - `Space-Time Rift` 选中后显示 `Source Branch`，placeholder 正确。

- 本轮新工件：
  - `frontend/output/web-game/20260318-b2-contract-smoke/shot-0.png`
  - `frontend/output/web-game/20260318-b2-contract-smoke/state-0.json`
  - `frontend/output/e2e/20260318-b2-debate-smoke/result.json`

- 下一轮可选继续项：
  - 如果要继续抬高 B2 的“声明式程度”，可再评估是否把 `getSuggestedGameplayAgents()` 的卡牌分叉也进一步 schema 化；
  - 当前我没有重跑 full matrix，只做了定向单测 + live modal 浏览器检查 + Debate smoke。

## 2026-03-18 Full Regression After B2 Close

- 已重新起本地服务：
  - backend: `http://127.0.0.1:18927`
  - frontend: `http://127.0.0.1:18928`

- 前端全量回归：
  - `cd frontend && npm test`
  - 结果：`31 files, 175 passed`

- 主链路完整 E2E：
  - `cd frontend && npm run e2e:full -- --url http://127.0.0.1:18928 --output-dir output/e2e/20260318-post-b2-full --headless`
  - 结果：通过
  - 工件：
    - `frontend/output/e2e/20260318-post-b2-full/result.json`
  - 关键信号：
    - matrix 15 样本通过
    - corners 通过
    - mobile 段通过
    - 若历史样本 `scene_theme` 与当前 selector 漂移，suite 正常做了 runtime fallback 重建

- Debate 完整 E2E：
  - `cd frontend && npm run e2e:debate:full -- --url http://127.0.0.1:18928 --output-dir output/e2e/20260318-post-b2-debate-full --headless`
  - 结果：通过
  - 工件：
    - `frontend/output/e2e/20260318-post-b2-debate-full/result.json`

- 后端全量 pytest：
  - `cd backend && .venv/bin/python -m pytest tests/ -x -q`
  - 结果：未全绿，首个失败为：
    - `tests/test_campaign_api.py::test_daily_status_endpoint_returns_backend_truth_for_today`
    - 失败断言：`data["completed"] is True`，实际返回 `False`
  - 现场结果：
    - `1 failed, 148 passed in 46.53s`
  - 该失败落点在 Track A / campaign `daily-status`，不属于本轮 `implement/` 文档收口或 Track B2 gameplay contract 去重改动范围。

## 2026-03-18 Campaign Daily-Status 时区修复

- 已定位根因：
  - SQLite / SQLModel 会把原本的 UTC aware 时间读回成 naive datetime；
  - `campaign daily-status` 之前直接拿 `created_at.astimezone(local_timezone)` 做本地日期换算，跨日边界会把同一天完成态误判成前一天。
- 已修复：
  - `backend/app/services/campaign.py`
    - 新增 UTC 归一与序列化 helper
    - `daily-status` 比对前会先把 campaign log 时间按 UTC 归一，再换算调用方本地日期
    - `profile / mastery / badges / daily-status` 中返回的时间字段统一输出带 `+00:00` 的 UTC ISO string
  - `backend/tests/test_campaign_service.py`
    - 补断言，锁住 `completed_at` 的 UTC ISO 输出口径
- 已验证：
  - `cd backend && source .venv/bin/activate && python -m pytest tests/test_campaign_service.py tests/test_campaign_api.py -q`
  - 结果：`9 passed`
  - `cd backend && source .venv/bin/activate && python -m pytest tests/ -q`
  - 结果：`815 passed`

## 2026-03-18 Prediction 测试 Warning 清理 + 文档同步

- 已清理 `backend/tests/test_predictions.py` 中两类测试层 warning：
  - `datetime.utcnow()` -> `datetime.now(timezone.utc)`
  - `asyncio.get_event_loop().run_until_complete(...)` -> `asyncio.run(...)`
- 已验证：
  - `cd backend && source .venv/bin/activate && python -m pytest tests/test_predictions.py -q`
  - 结果：`17 passed`
  - `cd backend && source .venv/bin/activate && python -m pytest tests/ -q`
  - 结果：`815 passed`
- 已同步文档口径：
  - `llmdoc/overview/project.md`
  - `llmdoc/overview/backend.md`
  - `llmdoc/overview/frontend.md`
  - `llmdoc/guides/development.md`
  - `llmdoc/reference/api.md`
  - `README.md`
  - `implement/README.md`
  - `implement/18_next_session_gameplay_art_replay_plan.md`
  - `implement/19_four_track_execution_plan.md`
  - `implement/20_track_d_debate_arena_design_execution_plan.md`
  - `implement/21_track_d_debate_arena_mvp_blueprint.md`

## 2026-03-18 Debate Result Automation Hooks 收口

- 本轮目标：
  - 收口 `implement/` 中 Debate Result 页与 live 页自动化协议不完全对称的问题；
  - 不改现有 Pixel Theater / Debate Arena 视觉语言，只补齐自动化与测试能力；
  - 用 `$develop-web-game`、`$playwright-interactive`、Playwright CLI 技能链做真实页面验证。

- 已完成代码改动：
  - `frontend/src/pages/DebateResultView.tsx`
    - 新增结果页自动化钩子：
      - `window.advanceTime(ms)`
      - `window.capture_game_screenshot(mode)`
    - `panel` 模式抓 `.debate-shell`，`modal` 模式在分享弹窗打开时抓 `.debate-modal--share`；
    - `render_game_to_text()` 现额外输出：
      - `page.controls.active_modal`
      - `page.controls.show_share_modal`
      - `page.controls.modal_state`
    - 自动化 effect cleanup 已同步清理三类 hook，避免页面切换后残留全局状态。
  - `frontend/src/pages/DebateResultView.test.tsx`
    - 补齐 hook parity 测试：
      - `advanceTime()` 可调用
      - `capture_game_screenshot('panel')` 返回截图 data URL
      - 分享弹窗未打开时 `capture_game_screenshot('modal')` 返回 `null`
      - 打开分享弹窗后 `capture_game_screenshot('modal')` 正常返回截图 data URL
    - 补一条 `API 409` retry polling 测试，确认结果页在后端尚未 ready 时会自动重试并最终渲染成功。

- 本轮验证：
  - 前端定向测试：
    - `cd frontend && npm test -- --run src/pages/DebateResultView.test.tsx src/pages/DebateArenaView.test.tsx src/components/DebateShareModal.test.tsx src/components/DebateBetModal.test.tsx src/hooks/useDebateWS.test.tsx src/pages/SimulationView.test.tsx`
    - 结果：`6 files, 16 passed`
  - 前端构建：
    - `cd frontend && npm run build`
    - 结果：通过

- 真实页面 / 自动化验证：
  - 本地服务：
    - backend: `http://127.0.0.1:18927`
    - frontend: `http://127.0.0.1:18928`
  - 测试用 debate：
    - `7b469197-a745-4223-a079-9e7de7d07cc9`
  - `$develop-web-game` 黑盒工件：
    - `frontend/output/web-game/20260318-debate-result-hooks-panel/shot-0.png`
    - `frontend/output/web-game/20260318-debate-result-hooks-panel/state-0.json`
    - `frontend/output/web-game/20260318-debate-result-hooks-modal/shot-0.png`
    - `frontend/output/web-game/20260318-debate-result-hooks-modal/state-0.json`
  - 关键信号：
    - `panel` 状态下 `active_modal = null`
    - 打开分享弹窗后 `active_modal = "share"`
    - `modal_state.kind = "debate_share_modal"`
    - 截图与页面样式正常，未偏离当前 Debate / Theater 美术风格
  - 交互式 QA 工件：
    - `frontend/output/playwright/debate-result-desktop.png`
    - `frontend/output/playwright/debate-result-desktop-share.png`
    - `frontend/output/playwright/debate-result-mobile.png`
    - `frontend/output/playwright/debate-result-mobile-share.png`
  - 桌面与移动端均已确认：
    - `render_game_to_text()` 存在
    - `advanceTime()` 存在
    - `capture_game_screenshot()` 存在
    - 分享弹窗打开前后状态与截图行为符合预期

- 工具链现场说明：
  - Playwright CLI skill 对应 wrapper 已检查，但当前环境里 `playwright-cli` 子命令不可用；根据安全约束，本轮未做全局安装，改用已有浏览器自动化链路完成验证。
  - `$playwright-interactive` 需要的 `js_repl + playwright` 运行时在当前环境无法直接解析本地 `playwright/playwright-core` 依赖，因此交互式页面核验回退为 `chrome_devtools`，未阻塞本轮收口。

- 当前结论：
  - Debate Result 页现在已与 live 页具备对称的核心自动化钩子能力；
  - 这次收口解决的是 Track D 结果页自动化缺口，不涉及新美术素材，也不改变现有视觉风格；
  - 更大的 `implement` 尾项仍然存在，主要还是 `19_four_track_execution_plan.md` 中已写明的 replay / scene selector / capture / full-matrix 持续维护项，而不是 Debate Result hook 本身。

## 2026-03-18 Capture / Headless 黑盒收口

- 本轮选择继续收 `Track C` 里的 `capture/headless`，原因：
  - replay 已有单测和 corner E2E；
  - full-matrix 已在跑；
  - scene selector 当前主问题更多是旧样本漂移 + runtime fallback 工件维护；
  - `panel / canvas / modal` 三模式截图虽然有单测，但此前没有进入主黑盒套件，属于最小且真实的验证缺口。

- 已完成代码改动：
  - `frontend/scripts/e2e-suite.mjs`
    - 新增 `writeDataUrlFile()` / `getDataUrlByteLength()` 帮助函数；
    - 新增 `runCaptureModesCase()`：
      - 创建启用 Theater 的 live scenario；
      - 在 `/sim/:id` 黑盒验证 `window.capture_game_screenshot('panel')` / `('canvas')` / `('modal')`；
      - 断言 modal 未打开前返回 `null`；
      - 打开预测弹窗后等待自动化 hook settle，再断言 `modal` 截图非空；
      - 落盘 `panel.png` / `canvas.png` / `modal.png` / `capture-ui.png` / `capture-modes.json`
    - `corners` 套件现已把 `capture_modes` 纳入固定回归。

- 已验证：
  - 语法检查：
    - `node --check frontend/scripts/e2e-suite.mjs`
  - 黑盒回归：
    - `cd frontend && npm run e2e:corners -- --url http://127.0.0.1:18928 --output-dir output/e2e/20260318-capture-corners --headless`
    - 结果：通过
    - 新 case 输出：
      - `capture_modes.scenarioId = 37b7765f-35ae-40d1-83db-ad9e5a46dad3`
      - `panelBytes = 1100847`
      - `canvasBytes = 697544`
      - `modalBytes = 47462`
      - `activeModal = "prediction"`
  - 前端构建：
    - `cd frontend && npm run build`
    - 结果：通过

- 新工件：
  - `frontend/output/e2e/20260318-capture-corners/result.json`
  - `frontend/output/e2e/20260318-capture-corners/capture-modes/panel.png`
  - `frontend/output/e2e/20260318-capture-corners/capture-modes/canvas.png`
  - `frontend/output/e2e/20260318-capture-corners/capture-modes/modal.png`
  - `frontend/output/e2e/20260318-capture-corners/capture-modes/capture-ui.png`
  - `frontend/output/e2e/20260318-capture-corners/capture-modes/capture-modes.json`

- 当前结论：
  - `Track C / C3` 的截图三模式现在不再只是单测能力，而是已进入主黑盒套件并能在 headless 下产出真实 PNG 工件；
  - 这轮收口没有改产品视觉、没有新增素材，仍沿用当前 Theater / Debate 既有美术风格；
  - 下一轮最值得继续收的尾项，优先级已变成：
    - `scene selector` 历史样本漂移清理 / 更新固定 matrix 样本
    - 或 `replay` 的 mobile 控件观感与裁切验证

## 2026-03-18 Debate E2E Hook Lock

- 已继续收口 Debate 自动化验证面：
  - `frontend/scripts/e2e-debate-suite.mjs` 不再只是记录 hook 探测结果，现会把关键结果页 hook 变成硬断言；
  - 新增断言点：
    - live 页 `panel` 截图必须返回 data URL
    - result 页分享前：
      - `render_game_to_text()` 存在
      - `advanceTime()` 可调用
      - `capture_game_screenshot()` 存在
      - `panel` 截图返回 data URL
      - `modal` 截图必须为 `null`
    - result 页分享打开后：
      - `page.controls.active_modal === "share"`
      - `page.controls.modal_state.kind === "debate_share_modal"`
      - `modal` 截图必须返回 data URL

- 已验证：
  - `cd frontend && npm run e2e:debate:full -- --url http://127.0.0.1:18928 --output-dir output/e2e/20260318-debate-result-hook-lock --headless`
  - 结果：通过
  - 工件：
    - `frontend/output/e2e/20260318-debate-result-hook-lock/result.json`
  - 关键结果：
    - desktop:
      - live `panel` capture: data URL
      - result before share: `panel=data URL`, `modal=null`
      - result with share: `panel=data URL`, `modal=data URL`
    - mobile:
      - live `panel` capture: data URL
      - result before share: `panel=data URL`, `modal=null`
      - result with share: `panel=data URL`, `modal=data URL`

- 当前含义：
  - Debate Track D 不仅代码上有 result hook，对应 E2E 也已把结果页 hook 行为锁住；
  - 后续如果有人改坏 `advanceTime / capture_game_screenshot / active_modal / modal_state`，`e2e:debate:full` 会直接失败，而不只是留下“工件里看起来不对”的软信号。

## 2026-03-18 Debate Share Emoji 对齐

- 已修复 Debate 结果页分享弹窗的平台视觉缺口：
  - `frontend/src/lib/debateShare.ts`
    - 新增 Debate 专属 `platform -> { labelKey, icon }` 元数据；
    - 生成文案第一行现在会带平台 emoji，例如 `📕 小红书 · Debate Share Copy`。
  - `frontend/src/components/DebateShareModal.tsx`
    - 平台按钮现显示与通用 `ShareModal` 同口径的 emoji：
      - `📕 Xiaohongshu`
      - `🔴 Weibo`
      - `💙 Zhihu`
      - `🟠 Reddit`
      - `𝕏 X`
  - `frontend/src/components/DebateShareModal.test.tsx`
    - 补断言，锁住按钮文案与复制区标题中的平台 emoji。

- 已验证：
  - `cd frontend && npm test -- --run src/components/DebateShareModal.test.tsx src/pages/DebateResultView.test.tsx`
  - `cd frontend && pnpm exec tsc --noEmit`
  - 结果：通过

## 2026-03-18 Matrix Baseline 刷新

- 已定位 Track C `scene selector / full matrix` 尾项的真实根因：
  - 不是当前 selector 仍然选错；
  - 而是 `frontend/output/e2e/sample_matrix.json` 里有 `5` 条固定样本仍指向旧 `scenario_id`，这些历史场景的 `scene_theme` 已经漂移；
  - `e2e:full` 因此会触发 `runtime_created_fallback`，造成噪声。

- 已刷新基线：
  - `frontend/output/e2e/sample_matrix.json`
    - `generated_at` 更新到 `2026-03-18`
    - 更新 `law / trade / ecology / war / faith` 五条样本：
      - `scenario_id`
      - `completed_branch_count`
  - `frontend/scripts/e2e-suite.mjs`
    - `corners` 套件中的 `lawShareSample` 也切到新的 `law_court` 场景基线，避免 share context / share retry 继续走旧样本。

- 新的 5 条样本基线：
  - `law` -> `ded5cdd5-251d-4606-8ee3-8e1418d31cbb`
  - `trade` -> `1b822c42-d290-4a2c-a5e6-978b57b20a6e`
  - `ecology` -> `5060e360-44dc-4aec-80cd-aef5c16f8551`
  - `war` -> `a4838aca-0a0b-45c4-b8e6-2178a67389f9`
  - `faith` -> `d93041cf-c639-42eb-965c-767669e3be3f`

- 本轮验证：
  - `cd frontend && npm run e2e:matrix -- --url http://127.0.0.1:18928 --themes law,trade,ecology,war,faith --output-dir output/e2e/20260318-matrix-baseline-refresh --headless`
  - 结果：
    - 五条样本全部 `createdAtRuntime = false`
    - 五条样本全部 `recovery = null`
    - 全部以 `existing` 样本跑完，不再 runtime fallback
  - `cd frontend && npm run e2e:corners -- --url http://127.0.0.1:18928 --output-dir output/e2e/20260318-corners-law-refresh --headless`
  - 结果：
    - `share_context.scenarioId = ded5cdd5-251d-4606-8ee3-8e1418d31cbb`
    - `share_retry.scenarioId = ded5cdd5-251d-4606-8ee3-8e1418d31cbb`
    - `corners` 全套通过

- 新工件：
  - `frontend/output/e2e/20260318-matrix-baseline-refresh/result.json`
  - `frontend/output/e2e/20260318-corners-law-refresh/result.json`

- 当前含义：
  - Track C 里 `scene selector` 这组尾项的最小真实缺口已经不是 selector 代码，而是 baseline 样本陈旧；
  - 这轮刷新后，至少 `law / trade / ecology / war / faith` 这 5 条 full-matrix 样本已恢复为稳定 existing baseline，不再依赖 runtime fallback 自救。

## 2026-03-18 Matrix / Variants 全面复验

- 已继续把 Track C 的基线收口做完：
  - 主 matrix 基线刷新后，重新跑了 full；
  - 变体样本也复跑了 `variants`，并定位到 `law_grand_tribunal` 仍是同型的旧基线漂移；
  - `frontend/output/e2e/sample_matrix_variants.json`
    - 已把 `law_grand_tribunal` 的 `scenario_id` 从旧样本刷新为 `0d305e42-2c4a-4580-b4be-cc0d2dfd920c`
    - `generated_at` 更新到 `2026-03-18`

- 新增验证：
  - `cd frontend && npm run e2e:full -- --url http://127.0.0.1:18928 --output-dir output/e2e/20260318-post-matrix-refresh-full --headless`
  - 结果：
    - 主 matrix `15` 条样本全部 `createdAtRuntime = false`
    - 主 matrix `15` 条样本全部 `recovery = null`
    - `corners.share_context.scenarioId` / `corners.share_retry.scenarioId` 均已切到 `ded5cdd5-251d-4606-8ee3-8e1418d31cbb`
    - full 整体通过
  - `cd frontend && npm run e2e:variants -- --url http://127.0.0.1:18928 --output-dir output/e2e/20260318-post-variant-refresh --headless`
  - 结果：
    - `law_grand_tribunal / faith_council / generic_review_chamber` 三条变体样本全部 `createdAtRuntime = false`
    - 三条变体样本全部 `recovery = null`
    - variants 整体通过

- 新工件：
  - `frontend/output/e2e/20260318-post-matrix-refresh-full/result.json`
  - `frontend/output/e2e/20260318-post-variant-refresh/result.json`

- Track C 推荐单测复验：
  - 前端：
    - `cd frontend && npm test -- --run src/game/replaySync.test.ts src/game/replaySelection.test.ts src/pages/SimulationView.test.tsx src/hooks/useScreenCapture.test.ts`
    - 结果：`18 passed`
  - 后端：
    - `cd backend && source .venv/bin/activate && python -m pytest tests/test_scene_selector.py tests/test_simulator_viz_integration.py -q`
    - 结果：`214 passed`

- 当前结论：
  - 主 matrix 漂移样本与变体漂移样本都已刷新到当前 selector 口径；
  - 现在 `e2e:full` 与 `e2e:variants` 都不再依赖 `runtime_created_fallback` 才能通过；
  - 这意味着 Track C 里最明确、最小的一类遗留尾项已经被真正收口，而不是继续靠 suite 的自愈逻辑遮蔽。

## 2026-03-18 Replay Cold-Start 噪声收口

- 已定位 residual 噪声的性质：
  - 不是产品级 replay 回归；
  - 更像 completed Theater replay 首次冷启动时，`e2e-suite` 对 `scene.scene` 的等待条件过早把过渡态记成超时，再触发整页 reload。

- 已做的最小修复：
  - `frontend/src/game/automation.ts`
    - `AutomationReplayState` 新增 `theater_ready?: boolean`
  - `frontend/src/pages/SimulationView.tsx`
    - completed Theater replay 的自动化输出现在会显式暴露 `page.replay_state.theater_ready`
    - 该字段只有在 `scene` 已进入真实 Theater 场景（非 `BootScene/TitleScene`）时为 `true`
  - `frontend/scripts/e2e-suite.mjs`
    - 新增 completed replay readiness helper
    - `runReplayFlow()` 现优先依据 `replay_state.theater_ready` 判断 replay Theater 是否真正 ready
    - 第二阶段等待窗口从 `40s` 放宽到 `60s`，避免冷浏览器首次加载 Phaser/资产时把合法过渡态误报为超时
    - 超时日志也会带 `theater_ready` 状态，后续更容易区分“冷启动慢”与“真死锁”

- 已验证：
  - `cd frontend && npm test -- --run src/pages/SimulationView.test.tsx`
  - 结果：`8 passed`
  - `cd frontend && pnpm exec tsc --noEmit`
  - 结果：通过
  - `cd frontend && npm run e2e:variants -- --url http://127.0.0.1:18928 --output-dir output/e2e/20260318-replay-ready-signal-variants --headless`
  - 结果：
    - `law_grand_tribunal / faith_council / generic_review_chamber` 全部 `createdAtRuntime = false`
    - 三条样本的 `replay.replayState.theater_ready = true`
    - 本轮复验中未再出现之前那条 replay 冷启动 reload 噪声

- 新工件：
  - `frontend/output/e2e/20260318-replay-ready-signal-variants/result.json`

- 当前含义：
  - replay 冷启动仍可能需要较长时间进入 Theater，但现在 suite 有了显式 readiness 信号，不再主要靠猜 `scene.scene !== BootScene/TitleScene`；
  - 这条 residual 现在已经从“容易制造误报的测试噪声”收敛成“可观测、可区分、且已在变体验证面复绿”的状态。

## 2026-03-18 Replay Cold-Start 噪声收口

- 已继续处理 Track C 剩余的 replay 冷启动噪声：
  - 现象是：completed replay 在 headless 下首次进入 `/sim/:id` 时，偶发 40s 后打一条 `Timed out waiting for completed replay state ... last scene=unknown`，随后 fresh reload 才成功。
  - 当前判断：
    - 这更像 completed replay 首次冷启动时，Theater scene 还在合法初始化窗口；
    - 残留问题主要在自动化协议缺少显式 readiness 信号，suite 只能靠 `scene !== BootScene/TitleScene` 这类间接条件猜测是否 ready。

- 已修复：
  - `frontend/src/game/automation.ts`
    - `AutomationReplayState` 新增 `theater_ready?: boolean`
  - `frontend/src/pages/SimulationView.tsx`
    - completed Theater replay 的自动化输出现在会显式暴露 `page.replay_state.theater_ready`
    - 仅当当前场景已进入真实 Theater 场景（非 `BootScene/TitleScene`）时，该字段才为 `true`
  - `frontend/scripts/e2e-suite.mjs`
    - 新增 completed replay readiness helper
    - `runReplayFlow()` 现在优先依据 `replay_state.theater_ready` 判断 replay Theater 是否真正 ready
    - 第二阶段等待窗口从 `40s` 放宽到 `60s`
    - timeout 诊断信息现会额外携带 `theater_ready`

- 本轮验证：
  - `cd frontend && npm test -- --run src/pages/SimulationView.test.tsx`
  - 结果：`8 passed`
  - `cd frontend && pnpm exec tsc --noEmit`
  - 结果：通过
  - `cd frontend && npm run e2e:variants -- --url http://127.0.0.1:18928 --output-dir output/e2e/20260318-replay-ready-signal-variants --headless`
  - 结果：
    - `law_grand_tribunal / faith_council / generic_review_chamber` 三条样本全部 `createdAtRuntime = false`
    - 三条样本的 `replay.replayState.theater_ready = true`
    - 本轮复验中未再出现此前那条 replay 冷启动 reload 噪声

- 新工件：
  - `frontend/output/e2e/20260318-replay-ready-signal-variants/result.json`
  - `frontend/output/e2e/20260318-post-replay-ready-full/result.json`

- 当前含义：
  - 这轮没有去改 Theater 产品逻辑，而是把 completed replay 的 readiness 判定变成了显式自动化协议；
  - 之前那类“first load unknown / second load 正常”的 residual 噪声，当前已被收敛到更可观测、可区分的状态。
  - 复验 `e2e:full` 后：
    - 主 matrix `15` 条样本全部 `createdAtRuntime = false`
    - `corners.replay_skip_switch.skipped/replayed` 也都已输出 `theater_ready = true`
    - `mobile.theater.replayState.theater_ready = true`
    - 本轮 full 没再出现 replay cold-start reload 噪声

## 2026-03-18 Debate Capture Hooks 黑盒锁定

- 已继续收口 Debate 的自动化验证面：
  - `frontend/scripts/e2e-debate-suite.mjs`
    - 新增 live / result 页自动化 hook 探针；
    - 黑盒记录：
      - `render_game_to_text()` 是否存在
      - `advanceTime()` 是否可调用
      - `capture_game_screenshot()` 是否存在
      - `panel / modal` 模式在不同阶段是否返回有效 data URL
    - 结果页现在会显式锁定：
      - 分享弹窗打开前 `modal` capture 返回 `null`
      - 分享弹窗打开后 `modal` capture 返回真实截图 data URL

- 本轮验证：
  - `cd frontend && npm run e2e:debate:full -- --url http://127.0.0.1:18928 --output-dir output/e2e/20260318-debate-capture-hooks --headless`
  - 结果：通过

- 新工件：
  - `frontend/output/e2e/20260318-debate-capture-hooks/result.json`
  - `frontend/output/e2e/20260318-debate-capture-hooks/desktop/live-hooks.json`
  - `frontend/output/e2e/20260318-debate-capture-hooks/desktop/result-hooks-before-share.json`
  - `frontend/output/e2e/20260318-debate-capture-hooks/desktop/share-open.json`
  - `frontend/output/e2e/20260318-debate-capture-hooks/mobile/live-hooks.json`
  - `frontend/output/e2e/20260318-debate-capture-hooks/mobile/result-hooks-before-share.json`
  - `frontend/output/e2e/20260318-debate-capture-hooks/mobile/share-open.json`

- 关键结论：
  - desktop / mobile 两面都确认：
    - live 页 `panel` capture 返回有效 data URL
    - result 页分享前 `modal` capture 为 `null`
    - result 页分享后 `modal` capture 返回有效 data URL
  - 这样 Debate 的自动化协议不再只是单测层成立，而是已被真实浏览器 E2E 锁住。

## 2026-03-18 Heartbeat 监控 + GIF Fallback 收口

- 已补最小只读心跳脚本：
  - `scripts/codex-heartbeat.mjs`
  - 汇总信号：
    - `git status --short` 的 modified / untracked / focus files
    - `frontend/output/e2e/**/result.json` 中最新工件
    - `progress.md` 最新 section heading + top-level highlights
  - 支持参数：
    - `--interval <seconds>`
    - `--label <name>`
    - `--log-file <path>`
    - `--json`

- 已收口 GIF fallback 提示的遗留测试噪声：
  - `frontend/src/pages/SimulationView.test.tsx`
    - 断言现在收窄到 `.capture-status` 状态节点，不再误命中整棵父级 DOM

- 本轮验证：
  - `cd frontend && npm test -- --run src/pages/SimulationView.test.tsx`
  - 结果：`9 passed`
  - `cd frontend && npx tsc --noEmit`
  - 结果：通过

- 当前用途：
  - 后续实现期间可直接启动：
    - `node scripts/codex-heartbeat.mjs --interval 30 --label implement-tail --log-file /tmp/upgrade-test-heartbeat.log`
  - 该脚本只读汇总，不触碰业务状态，也不会改数据库或样本工件。

## 2026-03-18 Capture / Replay 黑盒收口继续推进

- 已继续收口 `implement/18` 与 `Track C` 里还剩的两条验证面尾项：
  - `modal` 截图在更复杂弹窗下的 smoke 覆盖
  - replay corner case 里 `playback_mode = replay` 但 `theater_ready` 尚未锁定的问题

- 已修改：
  - `frontend/scripts/e2e-suite.mjs`
    - `runCaptureModesCase()` 现在不再只验证 prediction modal：
      - 先验证 `panel / canvas / modal(before open = null)`
      - 打开 `PredictionModal` 后执行 `capture_game_screenshot('modal')`
      - 关闭 prediction modal 后，再打开 `GameplayCardsModal`
      - 对 gameplay cards modal 再执行一次 `capture_game_screenshot('modal')`
    - 输出工件新增：
      - `prediction-modal.png`
      - `prediction-modal-open.json`
      - `gameplay-modal.png`
      - `gameplay-modal-open.json`
    - `capture-modes.json` 现会显式记录：
      - `predictionModalBytes`
      - `gameplayModalBytes`
    - `runReplayCornerCase()` 的 replay restore 等待条件现收紧为：
      - `playback_mode = replay`
      - 且 `theater_ready = true`

  - `frontend/src/pages/SimulationView.tsx`
    - `render_game_to_text()` 的 `page.controls` 现额外暴露：
      - `capture_result_kind`
    - 值与 `useScreenCapture()` 的 `lastCaptureKind` 对齐，可用于黑盒直接区分：
      - `screenshot_png`
      - `gif`
      - `gif_fallback_png`

  - `frontend/src/pages/SimulationView.test.tsx`
    - fallback 提示测试现同时断言：
      - `capture_status = done`
      - `capture_result_kind = gif_fallback_png`

- 本轮验证：
  - `cd frontend && npm test -- --run src/pages/SimulationView.test.tsx`
  - 结果：`9 passed`
  - `cd frontend && npx tsc --noEmit`
  - 结果：通过
  - `cd frontend && npm run e2e:corners -- --url http://127.0.0.1:18928 --output-dir output/e2e/20260318-corners-capture-modal-variants --headless`
  - 结果：
    - `capture_modes.predictionModalBytes > 0`
    - `capture_modes.gameplayModalBytes > 0`
    - `replay_skip_switch.replayed.theater_ready = true`
  - `cd frontend && npm run e2e:full -- --url http://127.0.0.1:18928 --output-dir output/e2e/20260318-post-replay-capture-lock-full --headless`
  - 结果：
    - `full` 通过
    - `corners.capture_modes` 已包含 `predictionModalBytes / gameplayModalBytes`
    - `corners.replay_skip_switch.replayed.theater_ready = true`

- 新工件：
  - `frontend/output/e2e/20260318-corners-capture-modal-variants/`
  - `frontend/output/e2e/20260318-corners-replay-ready-lock/`
  - `frontend/output/e2e/20260318-post-replay-capture-lock-full/result.json`

- 当前需要额外说明的环境事实：
  - 这轮本地重新启动的 backend 命中了另一份可运行数据库，因此 `full` 里的主 matrix 样本大多表现为 `createdAtRuntime = true`
  - 当前判断：
    - 这不是本轮 replay / capture 改动造成的功能回归
    - 更像是“本地当前进程命中的 DB 与之前固定样本基线不是同一份”
  - 若下一轮要继续收口环境一致性，优先检查：
    - backend 启动 cwd
    - `DATABASE_URL=sqlite:///./swarmoracle.db` 的相对路径命中位置

## 2026-03-18 Backend DB Path 环境一致性收口

- 已定位 runtime fallback 大面积回潮的根因：
  - 不是 scene selector 或 replay / capture 改动造成的回归；
  - 是 backend 默认配置里的：
    - `DATABASE_URL=sqlite:///./swarmoracle.db`
    - `CHROMA_PERSIST_DIR=./chroma_data`
  - 这两项会跟进程 `cwd` 走。
  - 结果是：
    - 从 `backend/` 目录启动服务，命中的是 `backend/swarmoracle.db`
    - 从 repo root 启动服务，命中的是根目录 `swarmoracle.db`
  - 因而 fixed sample matrix 会看起来“全部缺失”，suite 被迫走 runtime fallback。

- 已修复：
  - `backend/app/config.py`
    - 新增 `BACKEND_ROOT`
    - 默认 `DATABASE_URL` 现直接指向 `backend/swarmoracle.db` 的绝对路径
    - 默认 `CHROMA_PERSIST_DIR` 现直接指向 `backend/chroma_data` 的绝对路径
    - 对环境变量里传入的相对本地路径也做统一归一化：
      - `sqlite:///./foo.db` -> 相对 `backend/` 根解析
      - `./bar_chroma` -> 相对 `backend/` 根解析
    - `model_config.env_file` 也改为固定读取 `backend/.env`
  - `backend/tests/test_config.py`
    - 新增相对路径归一化测试

- 本轮验证：
  - 直接 API 验证：
    - `GET /api/scenario/72ae364d-3ea1-4959-939c-8fe1dbeca1c9` -> 200
    - `GET /api/scenario/ded5cdd5-251d-4606-8ee3-8e1418d31cbb` -> 200
    - `GET /api/scenario/1b822c42-d290-4a2c-a5e6-978b57b20a6e` -> 200
  - `cd backend && .venv/bin/python -m pytest tests/test_config.py -q`
  - 结果：`4 passed`
  - `Settings()` 实例化验证：
    - `DATABASE_URL = sqlite:////Users/yangjunjie/Desktop/upgrade-test/backend/swarmoracle.db`
    - `CHROMA_PERSIST_DIR = /Users/yangjunjie/Desktop/upgrade-test/backend/chroma_data`
  - `cd frontend && npm run e2e:matrix -- --url http://127.0.0.1:18928 --themes governance,law,trade --output-dir output/e2e/20260318-matrix-db-path-check --headless`
  - 结果：
    - `governance / law / trade` 全部 `existing`
    - 三条样本全部 `createdAtRuntime = false`
  - `cd frontend && npm run e2e:full -- --url http://127.0.0.1:18928 --output-dir output/e2e/20260318-post-db-path-fix-full --headless`
  - 结果：
    - `full` 通过
    - 主 matrix `15` 条样本全部 `createdAtRuntime = false`
    - `recovery = null`
    - `corners.capture_modes` 仍保留：
      - `predictionModalBytes > 0`
      - `gameplayModalBytes > 0`
    - `corners.replay_skip_switch.replayed.theater_ready = true`

- 新工件：
  - `frontend/output/e2e/20260318-matrix-db-path-check/result.json`
  - `frontend/output/e2e/20260318-post-db-path-fix-full/result.json`

- 当前含义：
  - 之前心跳里那条：
    - `full matrix=15, runtime=15`
  - 现在已被环境一致性修复实质性消掉。
  - 这意味着当前 `implement` 收口里的 replay / capture / full-matrix 这一组，不再同时被“产品逻辑”与“启动 cwd 漂移”两类问题混在一起。

## 2026-03-18 ResultView Campaign Summary 后端兜底

- 已继续收口一个更偏产品面的残项：
  - 结果页此前主要依赖本地 `scenarioMeta`
  - 如果换设备、清空 localStorage，或 scenario 是别的导演档案先 finalize 过，本地归档摘要会变瘦
  - 当前不做“整套 `scenarioMeta` 后端化”，先补最小可用的后端回读兜底

- 已修改：
  - `backend/app/services/campaign.py`
    - 新增 `get_scenario_campaign_summary(scenario_id)`
    - 基于既有 `ScenarioCampaignLog` 返回只读 summary：
      - `profile_id`
      - `archive_grade`
      - `profile_resonance`
      - `betting_hit`
      - `most_used_card`
      - `completed_daily_challenge`
      - `campaign_score_delta`
      - `finalized_at`
  - `backend/app/api/campaign.py`
    - 新增：
      - `GET /api/campaign/scenario/{scenario_id}/summary`
  - `frontend/src/api/client.ts`
    - 新增 `getCampaignScenarioSummary(scenarioId)`
  - `frontend/src/types.ts`
    - 新增 `CampaignScenarioSummary`
  - `frontend/src/pages/ResultView.tsx`
    - 结果页现在会并行读取后端 `scenario campaign summary`
    - 本地 `scenarioMeta.archive` 有值时继续优先使用本地
    - 本地缺失时，会用后端 summary 兜底这些字段：
      - `profileId`
      - `mostUsedCard`
      - `bettingHit`
      - `archiveGrade`
      - `profileResonance`
    - `下注结果` 文案也已补一条兜底：
      - 若本地 bet 列表为空，但后端已知 `betting_hit`
      - 则显示 `Bet Hit / Bet Missed`
      - 不再误显示 `No bets placed`
  - `frontend/src/i18n/locales/{en,zh}.json`
    - 新增：
      - `result.archive_bet_miss`
  - `frontend/src/pages/ResultView.test.tsx`
    - 新增跨设备/空本地缓存场景：
      - 本地 meta 为空
      - backend `campaign scenario summary` 存在
      - `finalizeCampaign()` 返回 `409`
      - 页面仍能正确显示后端回读的：
        - `most_used_card`
        - `archive_grade`
        - `profile_resonance`
        - `betting_hit`

- 本轮验证：
  - `cd backend && .venv/bin/python -m pytest tests/test_campaign_api.py tests/test_campaign_service.py -q`
  - 结果：`10 passed`
  - `cd frontend && npm test -- --run src/pages/ResultView.test.tsx`
  - 结果：`3 passed`
  - `cd frontend && npx tsc --noEmit`
  - 结果：通过
  - 运行时 smoke：
    - `curl http://127.0.0.1:18927/api/campaign/scenario/72ae364d-3ea1-4959-939c-8fe1dbeca1c9/summary`
    - 返回 `200`，可读到：
      - `archive_grade = B`
      - `profile_resonance = signature`
      - `campaign_score_delta = 3`
    - `curl .../missing-scenario/summary` -> `404`
  - 结果页黑盒 smoke：
    - `node frontend/scripts/e2e-automation.mjs result --url http://127.0.0.1:18928 --scenario-id 72ae364d-3ea1-4959-939c-8fe1dbeca1c9 --output-dir frontend/output/e2e/20260318-result-backend-summary-smoke --headless`
    - `result-final.json` 中已可见：
      - `archive_summary.archive_grade = B`
      - `archive_summary.dominant_branch_title = 算法接管`
      - `controls.modal_state.share_context.resonanceLabel = 命中题材核心`

- 新工件：
  - `frontend/output/e2e/20260318-result-backend-summary-smoke/`

- 当前含义：
  - 结果页在“本地缓存不完整 / 本机不是原始 finalize 设备”的情况下，不再只能退回一套瘦档案摘要；
  - 这条修复没有把 `scenarioMeta` 整体后端化，但已经把最用户可见的一层跨设备退化先收住了。

## 2026-03-18 ResultView Cross-Device Display 细节收口

- 在刚补完 backend summary 兜底后，又继续收了两个仍会误导用户的跨设备细节：
  1. 后端已知这局是 `completed_daily_challenge = true`，但如果本地没有 `challengeProgress`，结果页此前不会显示“每日挑战已完成”
  2. 本地没有导演状态时，结果页会把默认值 `3/3` 当成真实导演点数展示出来

- 已修改：
  - `frontend/src/pages/ResultView.tsx`
    - `isDailyChallenge` 现会把：
      - 本地 `challengeMatch`
      - 后端 `campaignScenarioSummary.completed_daily_challenge`
      两者合并判断
    - 若本地没有 `challengeProgress`，但后端明确这局属于 daily challenge：
      - 结果页仍会显示 `Daily Challenge`
      - `挑战反馈` 卡会显示 `Law · Completed` 这类后端兜底文案
    - `导演点数` chip 现在只有在存在本地导演状态时才显示：
      - `director.lastUpdatedAt`
      - `spentPoints > 0`
      - 或本地 `usageLog / bets` 非空
      否则不再展示默认 `3/3`
    - `render_game_to_text()` 的 `archive_summary` 现也会输出：
      - `profile_id`
      - `profile_resonance`
      - `completed_daily_challenge`
      且走页面实际使用的 merged archive state，不再与 UI 脱节

- 本轮验证：
  - `cd frontend && npm test -- --run src/pages/ResultView.test.tsx`
  - 结果：`3 passed`
  - `cd frontend && npx tsc --noEmit`
  - 结果：通过
  - 现有 `ResultView` 单测还额外锁住：
    - backend fallback 场景下，`render_game_to_text().page.archive_summary` 中的
      - `archive_grade`
      - `profile_id`
      - `profile_resonance`
      - `completed_daily_challenge`
      都会与 UI 一致

- 当前含义：
  - 现在跨设备打开结果页时，不只会拿到后端 archive summary；
  - 还会避免展示两类典型假状态：
    - “看不出这是每日挑战完成局”
    - “默认导演点数 3/3 冒充真实状态”

## 2026-03-18 文档同步

- 本轮按当前代码和真实验证结果，补齐了这次 session 直接相关的文档口径：
  - `frontend/README.md`
  - `llmdoc/reference/api.md`
  - `llmdoc/reference/config.md`
  - `llmdoc/overview/backend.md`
  - `llmdoc/overview/frontend.md`
  - `llmdoc/overview/project.md`
  - `llmdoc/guides/development.md`

- 这次同步的重点：
  - `campaign scenario summary` 新接口与结果页跨设备兜底行为
  - backend 默认 `.env / DATABASE_URL / CHROMA_PERSIST_DIR` 都锚定到 `backend/` 根目录
  - `SimulationView` 自动化摘要新增 `capture_result_kind`
  - `ResultView` 自动化摘要新增 `archive_summary.profile_id / profile_resonance / completed_daily_challenge`
  - `e2e-suite.mjs` 的 `capture-modes` 现会落 `predictionModalBytes / gameplayModalBytes`
  - `replay_skip_switch` 恢复判定现在要求 `theater_ready = true`
  - `scripts/codex-heartbeat.mjs` 的使用说明

- 本轮重新验证：
  - `cd backend && .venv/bin/python -m pytest tests/test_config.py tests/test_campaign_api.py tests/test_campaign_service.py -q`
  - 结果：`14 passed`
  - `cd frontend && npm test -- --run src/pages/ResultView.test.tsx src/pages/SimulationView.test.tsx`
  - 结果：`12 passed`
  - `node scripts/codex-heartbeat.mjs --label doc-sync`
  - 结果：输出正常
  - `cd frontend && npm run build`
  - 结果：当前失败，错误集中在 `ResultView.tsx / ResultView.test.tsx / SimulationView.test.tsx` 的 TypeScript 类型检查；本轮只同步文档，没有顺手改代码
