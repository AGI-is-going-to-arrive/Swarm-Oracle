# SwarmOracle — 四轨优化执行文档

> 目标：把以下四个方向扩展成可执行的实现、测试、review、E2E 文档，而不是停留在方向判断。  
> 范围：`Director Campaign / 导演生涯`、玩法契约统一、稳定性与验证面、`AI 辩论竞技场 MVP`。  
> 原则：不偏离项目初衷 `What-If 推演引擎 + Pixel Theater + 分支比较 + 下注/排行`，避免把产品拉成小游戏合集。  
> 当前时间：2026-03-18

---

## 0. 背景与结论

### 0.1 2026-03-18 执行状态同步

按这份执行文档继续推进后，当前状态已经不是“纯规划”：

- `Track A`
  - 导演生涯最小闭环已落地，`campaign finalize / profile / mastery / badges / daily-status` 都已在真实代码中存在
  - 首页与结果页都能看到导演生涯进展，并会把后端 `daily-status` 与本地缓存合并显示
  - 仍然保留本地 `scenarioMeta` 作为缓存层，但主链路已经不是只靠前端本地状态

- `Track B`
  - `B1` 已完成
  - `B2` 也已收口：`shared/gameplay_contract.v1.json` 现在不仅覆盖卡牌规则/画像推荐，也覆盖 modal 输入契约、prompt 语义和后端 branching bonus
  - 前后端不再各自维护第二份静态玩法卡事实源；保留下来的 `profile` heuristics / animation 表现属于派生实现层，不再算第二事实源
  - 本轮又在同一份 shared contract 上补进 4 张反制卡：`审计清算 / 情报反噬 / 民意回摆 / 停火委员会`
  - 当前玩法卡总数已变为 `14`（10 张原始导演卡 + 4 张反制卡）

- `Track C`
  - 主 12 profile 工件、mobile 双证据、`develop-web-game` 工件、variant matrix 都已补齐
  - 当前可用的变体工件还包括：
    - `law_court_variant`
    - `faith_temple_variant`
    - `switchboard_forum_variant`
  - `frontend/public/assets/ui/generated + frontend/public/assets/scenes` 下当前 62 张 PNG 都已有同名 `.meta.json`；较新的 Debate 资产保留原始生成字段，较早的 legacy 资产则以 backfilled 方式补齐 provenance sidecar

- `Track D`
  - 已不再处于“设计冻结”
  - 已有独立 Debate domain：`backend/app/models/debate.py`、`backend/app/api/debate.py`、`backend/app/services/debate*.py`
  - 前端已有 `DebateArenaView / DebateResultView / debateStore / useDebateWS / DebateBetModal / DebateShareModal`
  - 已有真实工件：`frontend/output/e2e/20260318-post-director-goals-debate-full/`、`frontend/output/e2e/20260318-debate-mobile-430x932-v2/`、`frontend/output/e2e/20260318-debate-civic-v2/` 与 `frontend/output/web-game/20260317-debate-arena-signoff/`

后文保留的设计型条目主要作为归档设计基线；若与当前实现冲突，以本节同步状态为准。

当前仓库已经具备一条可玩的基础主循环：

`每日挑战 / 快速开始 -> 起局 -> Theater 推演 -> 出牌 / 下注 -> 结果页 -> 因果档案 / 分享`

并且本轮又补上了第一层“导演玩法”：

`导演目标 -> 常驻风险/资源 -> worldline 承诺 -> 反制卡推荐 -> 结果页目标/承诺结算`

它仍然不是高操作深度游戏，但现在已经不再只是“看推演 + 出牌 + 下注意图”的轻元玩法。当前更准确的判断是：

- 已经形成可玩的导演式闭环
- 仍主要依赖 What-If 推演和 prompt 驱动，不是硬规则战棋
- 当前新增的导演目标 / worldline 承诺 / 反制卡 / 风险资源轨道，属于第一层玩法加深，而不是最终形态

后续若继续做深，当前更准确的约束已经从“核心能力未实现”转为三类增量工作：

1. `scenarioMeta` 仍保留本地缓存/兼容层。`director_state` 与主模式 `gameplay_state` 已完成 authority 收口，但若继续推进，重点应是继续缩小本地兼容层，而不是再重做 authority 方案。
2. release signoff 仍需要 clean-room 复验。`corners / cross-browser / debate:full` 已有真实工件，但后续发版前仍应在更干净的运行环境再跑一次，而不是只引用旧工件。
3. 移动端 Theater 首屏密度、Safari/WebKit 截图限制、前端包体大小仍属于 polish / 工程优化项，不是阻断当前产品闭环的未完成功能。

因此本执行文档采用四轨路线作为历史收口基线：

1. `Track A`：先做 `Director Campaign / 导演生涯` 最小闭环。
2. `Track B`：统一玩法契约，建立单一事实源。
3. `Track C`：并行补稳定性和验证面。
4. `Track D`：当前已实现 MVP，后续重点转为文档收口、回归验证和增量迭代，而不是继续把产品扩成多模式合集。

---

## 1. 本轮真实验证基线

本轮先完成了 `implement/` 收口与 Track B2 shared contract 去重，随后又补了 Track A `campaign daily-status` 时区修复、`test_predictions.py` warning 清理，并完成了一轮真实验证，作为本执行文档的当前基线。

### 1.1 单测 / 集成测试

```bash
cd frontend
npm test -- --run \
  src/components/GameplayCardsModal.test.tsx \
  src/lib/scenarioMeta.test.ts \
  src/lib/archiveSummary.test.ts \
  src/lib/dailyChallenge.test.ts \
  src/game/replaySelection.test.ts \
  src/game/replaySync.test.ts \
  src/pages/SimulationView.test.tsx
```

- 结果：`30 passed`

```bash
cd backend
.venv/bin/python -m pytest \
  tests/test_card_events.py \
  tests/test_scene_selector.py \
  tests/test_simulator_viz_integration.py -q
```

- 结果：`230 passed`

### 1.2 E2E matrix smoke

```bash
cd frontend
npm run e2e:matrix -- \
  --headless \
  --themes governance,law,trade,war_logistics,generic \
  --output-dir output/e2e/20260317-four-track-smoke
```

- 结果：通过
- 工件目录：
  - `frontend/output/e2e/20260317-four-track-smoke`

已验证题材：

- `governance`
- `law`
- `trade`
- `generic`
- `war_logistics`

本轮确认输出中同时包含：

- `replay.replayState`
- `replay.scene/theme`
- `result.branchTitles`
- `result.shareContext`

### 1.3 `develop-web-game` skill 工件

使用 `develop-web-game` 的 Playwright 客户端做了一轮真实取证，注意到两个工具现实问题：

1. skill 自带脚本是 ESM，但扩展名为 `.js`，直接 `node` 会报 `SyntaxError: Cannot use import statement outside a module`
2. 若把脚本复制到 `/tmp/*.mjs`，又会因为找不到 `frontend/node_modules/playwright` 而失败

本轮采用的可行 workaround：

```bash
mkdir -p frontend/.tmp-playwright
cp ~/.codex/skills/develop-web-game/scripts/web_game_playwright_client.js \
  frontend/.tmp-playwright/web_game_playwright_client.mjs

cd frontend
node .tmp-playwright/web_game_playwright_client.mjs \
  --url http://127.0.0.1:18928/sim/e8ae7cc0-8f11-4b7d-9c38-fdab2a6bac0f \
  --actions-file ~/.codex/skills/develop-web-game/references/action_payloads.json \
  --iterations 2 \
  --pause-ms 250 \
  --capture-mode panel \
  --screenshot-dir output/web-game/20260317-director-campaign-doc
```

工件：

- `frontend/output/web-game/20260317-director-campaign-doc/shot-0.png`
- `frontend/output/web-game/20260317-director-campaign-doc/state-0.json`

### 1.4 `playwright-interactive` skill 工件

本轮使用 `js_repl + Playwright` 做了持久桌面/移动端 QA，会话中已真实检查：

- 首页 desktop / mobile
- 完成态 Theater `/sim/:id` desktop / mobile
- 结果页 `/result/:id`
- 结果页分享 modal
- 首页语言切换

关键观察：

- 首页 desktop / mobile 当前无致命裁切，但移动端首屏密度仍高，参数区需要继续向下滚动才能完整看完。
- 完成态 Theater desktop 正常；mobile 当前可用，但信息密度偏高，Agent 区和实时发言区的首屏观感仍可继续优化。
- 结果页 desktop / mobile 当前可用，分享 modal 正常打开。

### 1.5 `Playwright CLI Skill` 现实状态

按 skill 要求完成了以下预检：

```bash
command -v npx >/dev/null 2>&1 && echo NPX_OK
cd frontend && node -e "import('playwright').then(()=>console.log('PLAYWRIGHT_IMPORT_OK'))"
```

结果：

- `npx` 可用
- 本地 `playwright` 可导入

但 skill wrapper 当前实际会落到 `@playwright/mcp` server 命令，而不是可直接交互的 `playwright-cli` 子命令，因此本轮未把它作为主验证链路，改用：

- 项目内 `scripts/e2e-suite.mjs`
- `playwright-interactive`
- `develop-web-game`

结论：`Playwright CLI Skill` 当前在本仓库里属于“预检通过，但 wrapper 行为待修”的状态。

---

## 2. Track A — Director Campaign / 导演生涯

### 2.1 目标

把现有单局玩法提升为可积累的长期循环：

`每日挑战 / 自定义起局 -> 出牌 / 下注 -> 结果档案 -> 题材 mastery / badge / unlock -> 再起一局`

### 2.2 非目标

本阶段不做：

- 复杂赛季系统
- 联网 PvP
- 真正的商城 / 付费机制
- 多角色养成树
- 大量新玩法卡

### 2.3 最小产品定义

#### Director Campaign 核心对象

1. `DirectorProfile`
   - 每个用户一个导演档案
   - 记录总局数、完成挑战数、总下注数、总命中数、档案等级

2. `ProfileMastery`
   - 12 个题材画像各自独立积累
   - 记录局数、挑战完成数、signature resonance 次数、最常用卡、最佳档案等级

3. `DirectorBadge`
   - 可解锁徽章
   - 先支持静态规则计算，不做复杂稀有度系统

4. `CampaignUnlock`
   - 控制少量解锁项
   - 只允许解锁“每日挑战变体 / 卡框样式 / quick start 条目 / 题材 guide copy”

### 2.4 最小解锁规则

先只实现规则可审计、不会破坏平衡的一版：

- `profile_mastery.level`
  - 基于该 profile 的累计 `campaign_score`
- `campaign_score`
  - `+1` 完成一局
  - `+1` 完成每日挑战
  - `+2` `profileResonance = signature`
  - `+1` `profileResonance = aligned`
  - `+1` 有下注且结果结算完成
  - `+2` 下注命中
  - `+2` 档案评级 `S`
  - `+1` 档案评级 `A`

### 2.5 后端设计

#### 新增数据表

建议新增：

- `director_profile`
- `profile_mastery`
- `director_badge_unlock`
- `scenario_campaign_log`

建议文件：

- `backend/app/models/campaign.py`
- `backend/app/api/campaign.py`
- `backend/app/services/campaign.py`
- `backend/alembic/versions/<new_revision>_add_campaign_tables.py`

#### 最小字段建议

`DirectorProfile`

- `id`
- `user_id`
- `user_name`
- `total_runs`
- `completed_challenges`
- `total_bets`
- `hit_bets`
- `highest_archive_grade`
- `created_at`
- `updated_at`

`ProfileMastery`

- `id`
- `director_profile_id`
- `profile_id`
- `runs`
- `challenge_completions`
- `signature_hits`
- `aligned_hits`
- `campaign_score`
- `level`
- `best_archive_grade`
- `favorite_card_id`
- `updated_at`

`DirectorBadgeUnlock`

- `id`
- `director_profile_id`
- `badge_id`
- `unlocked_at`
- `source_profile_id`
- `source_scenario_id`

`ScenarioCampaignLog`

- `id`
- `scenario_id`
- `director_profile_id`
- `profile_id`
- `archive_grade`
- `profile_resonance`
- `betting_hit`
- `most_used_card`
- `completed_daily_challenge`
- `campaign_score_delta`
- `created_at`

#### 最小 API

- `GET /api/campaign/profile/{user_id}`
- `GET /api/campaign/profile/{user_id}/mastery`
- `GET /api/campaign/profile/{user_id}/badges`
- `POST /api/campaign/scenario/{scenario_id}/finalize`

其中 `finalize` 负责把结果页已有的档案信息固化到后端，而不是继续只停在前端 `localStorage`。

### 2.6 前端设计

#### 优先改动文件

- `frontend/src/lib/scenarioMeta.ts`
- `frontend/src/lib/archiveSummary.ts`
- `frontend/src/lib/dailyChallenge.ts`
- `frontend/src/pages/InputView.tsx`
- `frontend/src/pages/ResultView.tsx`
- `frontend/src/api/client.ts`
- `frontend/src/types.ts`

#### 最小 UI 落点

1. 首页 `InputView`
   - 每日挑战卡增加 `mastery level / next unlock`
   - quick start 增加“已解锁变体”展示

2. 结果页 `ResultView`
   - 在因果档案下方新增 `Campaign Progress` 区块
   - 展示：
     - 本局 `campaign_score_delta`
     - profile 当前 level
     - 新解锁 badge
     - 下一级差多少

3. 排行榜页可后续再接入，不作为第一阶段阻塞项

### 2.7 实现顺序

#### Phase A1

- 新增 campaign 数据模型
- 新增 campaign service
- 结果页 `finalize` 写后端
- 前端保持现有 `scenarioMeta` 兼容，不立即删除本地存储

#### Phase A2

- 首页展示 mastery / next unlock
- 结果页展示本局 campaign 增量
- 补 badge 文案和样式

#### Phase A3

- 把 daily challenge 的完成态更多地以后端 campaign 数据为准
- 本地 `scenarioMeta` 退为缓存层

### 2.8 测试

#### 单测

- `backend/tests/test_campaign_service.py`
  - `finalize` 正确累计分数
  - 同一场景重复 finalize 幂等
  - badge 解锁规则正确

- `frontend/src/lib/campaignScore.test.ts`
  - score 规则一致

- `frontend/src/pages/ResultView.test.tsx`
  - finalize 后 campaign 摘要正确显示

#### 集成测试

- `backend/tests/test_campaign_api.py`
  - 创建场景 -> 完成 -> finalize -> GET profile

#### E2E

场景 1：每日挑战主路径

- 首页点今日挑战
- 进入 Theater
- 完成一局
- 打开结果页
- finalize campaign
- 返回首页看到 challenge completed + mastery 变化

场景 2：自定义起局 + signature resonance

- 自定义问题进入对应 profile
- 完成后档案显示 `signature`
- campaign score 增量符合规则

### 2.9 Review 清单

- 是否仍兼容现有 `scenarioMeta`，未把旧局直接搞坏
- 是否保证 finalize 幂等
- 是否把 score 规则只写在一个地方，而不是前后端各自散落
- 是否把“显示用 badge”和“结算用 campaign score”分开

---

## 3. Track B — 玩法契约统一

### 3.1 目标

把卡牌定义、冷却、触发类型、可视化动画、profile 推荐、前后端命名收成单一事实源。

### 3.2 当前问题

- 前端卡牌定义比后端更全
- 冷却规则在 `scenarioMeta.ts`
- 前端 prompt 语义在 `gameplayCards.ts`
- 后端自动触发 / 可视化事件在 `card_events.py`
- 这意味着“新加一张卡”时，要手工同时改多个地方，极易漏

### 3.3 建议实现

新增一份仓库内共享 JSON：

- `shared/gameplay_contract.v1.json`

内容至少覆盖：

- `cards`
  - `id`
  - `trigger_type`
  - `cost`
  - `cooldown_rounds`
  - `animation_key`
  - `manual_enabled`
  - `auto_enabled`
  - `labels`
  - `descriptions`

- `profiles`
  - `id`
  - `signature_hooks`
  - `recommended_cards`
  - `default_directives`
  - `risk_track_labels`
  - `resource_track_labels`

### 3.4 代码落点

前端：

- `frontend/src/components/gameplayCards.ts`
- `frontend/src/lib/scenarioMeta.ts`
- `frontend/src/lib/themeRegistry.ts`

后端：

- `backend/app/visualization/card_events.py`
- `backend/tests/test_card_events.py`

### 3.5 迁移策略

#### Phase B1

- 先落共享 JSON
- 前端改成从 JSON 加载
- 后端仍暂时保持旧常量，但增加一致性测试

#### Phase B2

- 后端也改为从 JSON 读取
- 删除重复常量

### 3.6 测试

#### 单测

- `frontend/src/components/gameplayContract.test.ts`
  - 每个 card 都有 cost/cooldown/animation

- `backend/tests/test_gameplay_contract_sync.py`
  - 前后端读到的 card id 集合一致
  - auto/manual trigger 规则一致

#### Review 清单

- 是否还有第二份卡牌事实源
- 是否存在前端有卡、后端无定义
- 是否所有 `animation_key` 都有实际资源或 graceful fallback

### 3.7 E2E 覆盖要求

至少覆盖：

- `governance`
- `law`
- `trade`
- `war_logistics`
- `generic`
- `faith`
- `ecology`
- `frontier`
- `mythic`
- `survival`
- `empire`
- `industry`

即 12 profile 全覆盖，而不是只覆盖老的 5 到 6 个稳定题材。

---

## 4. Track C — 稳定性和验证面

### 4.1 目标

优先继续收口以下尾项：

- replay
- scene selector
- capture/headless 兼容
- 全 profile E2E 覆盖

### 4.2 分项

#### C1. Replay

重点验证：

- completed replay 不回 `TitleScene`
- `skip -> branch switch -> replay` 状态恢复正确
- mobile Theater 下 replay 控件不裁切

相关文件：

- `frontend/src/game/replaySync.ts`
- `frontend/src/game/replaySelection.ts`
- `frontend/src/pages/SimulationView.tsx`
- `frontend/src/components/TimelineBar.tsx`

#### C2. Scene Selector

重点验证：

- 题面强语义优先
- `profile` 与 `scene_theme` 不需要完全同名，但不能明显错位
- 中文题面对 `AI / law / logistics / switchboard_forum` 这类新增语义保持稳定

相关文件：

- `backend/app/visualization/scene_selector.py`
- `frontend/src/game/managers/VizSynthesizer.ts`
- `frontend/src/lib/themeRegistry.ts`

#### C3. Capture / headless

重点验证：

- `panel / canvas / modal` 三种截图模式
- GIF fallback
- headless WebGL 取图是否稳定

相关文件：

- `frontend/src/hooks/useScreenCapture.ts`
- `frontend/src/pages/SimulationView.tsx`
- `frontend/scripts/e2e-suite.mjs`

### 4.3 统一 QA inventory

每次做前端 / E2E 验证前先写覆盖清单，至少包含：

- 用户要求的显性功能
- 当前这轮实现要声称通过的用户可见行为
- 每个关键控件会引起的状态变化
- 至少 2 个 off-happy-path 场景

### 4.4 推荐命令

#### 单测

```bash
cd frontend
npm test -- --run \
  src/game/replaySync.test.ts \
  src/game/replaySelection.test.ts \
  src/pages/SimulationView.test.tsx \
  src/hooks/useScreenCapture.test.ts
```

```bash
cd backend
.venv/bin/python -m pytest \
  tests/test_scene_selector.py \
  tests/test_simulator_viz_integration.py -q
```

#### 黑盒

```bash
cd frontend
npm run e2e:matrix -- --headless --themes governance,law,trade,war_logistics,generic
npm run e2e:corners
```

#### develop-web-game

```bash
mkdir -p frontend/.tmp-playwright
cp ~/.codex/skills/develop-web-game/scripts/web_game_playwright_client.js \
  frontend/.tmp-playwright/web_game_playwright_client.mjs

cd frontend
node .tmp-playwright/web_game_playwright_client.mjs \
  --url http://127.0.0.1:18928/sim/<scenario_id> \
  --actions-file ~/.codex/skills/develop-web-game/references/action_payloads.json \
  --iterations 2 \
  --pause-ms 250 \
  --capture-mode panel \
  --screenshot-dir output/web-game/<run_id>
```

#### playwright-interactive

建议长期保留的交互式 QA 面：

- desktop homepage
- mobile homepage
- desktop Theater
- mobile Theater
- result page
- share modal

### 4.5 Review 清单

- 是否把工具问题误判成产品问题
- 是否把 headless 黑底与真实视觉问题区分清楚
- 是否为每条“用户可见 claim”补了截图和状态 JSON 双证据
- 是否把 mobile 也纳入验证，而不是只看 desktop

---

## 5. Track D — AI 辩论竞技场 MVP

> 2026-03-18 状态：本节最初是“启动前计划”。当前 Debate Arena MVP 已实现，因此这里应按“已落地范围 + 后续增量”来阅读，而不是按“尚未开工”理解。

### 5.1 目标

作为唯一保留的新大方向，设计一个最贴近现有主线的模式：

`用户出题 -> 正反双方 AI 辩论 -> 观众下注 / 投票 -> 评委给分 -> 回放 / 分享`

### 5.2 为什么是它

- 复用现有多 Agent
- 复用现有流式推送
- 复用现有 Theater
- 复用现有下注和排行榜
- 复用现有结果页 / 分享链路

相比之下，`微型 AI 文明模拟器` 更适合下一阶段做旗舰化项目，不适合现在并行开启。

### 5.3 MVP 范围

#### 必做

- 新模式 `debate_arena`
- 两个阵营：正方 / 反方
- 一个评委 Agent
- 用户下注“谁胜”
- 结果页展示评分与最佳论点

#### 不做

- ELO 排名系统
- 多回合淘汰赛
- 人类实时插话
- 辩论赛季

### 5.4 当前已落地实现

- 后端
  - `backend/app/models/debate.py`
  - `backend/app/api/debate.py`
  - `backend/app/services/debate.py`
  - `backend/app/services/debate_prompts.py`
  - `backend/app/services/debate_scoring.py`
- 前端
  - `frontend/src/pages/DebateArenaView.tsx`
  - `frontend/src/pages/DebateResultView.tsx`
  - `frontend/src/components/DebateStageRibbon.tsx`
  - `frontend/src/components/DebateMomentumBar.tsx`
  - `frontend/src/components/DebateScoreCard.tsx`
  - `frontend/src/components/DebateBetModal.tsx`
  - `frontend/src/components/DebateShareModal.tsx`
  - `frontend/src/stores/debateStore.ts`
  - `frontend/src/hooks/useDebateWS.ts`
- 实际 API / 自动化链路
  - `POST /api/debate`
  - `GET /api/debate/{id}`
  - `POST /api/debate/{id}/predict`
  - `GET /api/debate/{id}/result`
  - `/ws/debate/{id}`
  - `render_game_to_text()` / `advanceTime(ms)` / `capture_game_screenshot()`

### 5.5 当前已验证范围

- 后端测试
  - `backend/tests/test_debate_service.py`
  - `backend/tests/test_debate_api.py`
- 前端测试
  - `frontend/src/pages/DebateArenaView.test.tsx`
  - `frontend/src/pages/DebateResultView.test.tsx`
  - `frontend/src/components/DebateBetModal.test.tsx`
  - `frontend/src/components/DebateShareModal.test.tsx`
  - `frontend/src/hooks/useDebateWS.test.tsx`
- E2E / skill 工件
  - `frontend/output/e2e/20260318-post-director-goals-debate-full/result.json`
  - `frontend/output/web-game/20260317-debate-arena-signoff/`
  - 本轮主模式 full 工件：`frontend/output/e2e/20260318-post-director-goals-full/result.json`
  - 本轮 `develop-web-game` 导演层工件：`frontend/output/web-game/20260318-director-layer-smoke-v2/`
  - 本轮补充移动端 `430x932`：`frontend/output/e2e/20260318-debate-mobile-430x932-v2/result.json`
  - 本轮补充 civic 主题：`frontend/output/e2e/20260318-debate-civic-v2/result.json`

### 5.6 剩余增量方向

- 保持 Debate live/result 与主 Theater 美术语言持续对齐
- 如需继续扩充 replay、stage 切片回看或额外判词维度，应在现有独立 domain 内增量做，不要回塞通用 `scenario` 主引擎
- Debate 现在不是“是否进入实现”的问题，而是“是否继续扩功能”的问题

---

## 6. 里程碑与排期

### Milestone 1

主题：`Director Campaign skeleton`

- campaign 表结构
- finalize API
- 结果页 campaign summary
- 基础单测

### Milestone 2

主题：`玩法契约统一`

- `shared/gameplay_contract.v1.json`
- 前端接入
- 后端一致性校验

### Milestone 3

主题：`稳定性与验证面`

- 12 profile matrix
- replay / scene selector / capture 收口
- mobile screenshot + state 双证据

### Milestone 4

主题：`AI 辩论竞技场 MVP 落地与回归`

- 独立 Debate domain 与 live/result 页面
- 结构化押注 / 分享 / 自动化钩子
- desktop/mobile Debate E2E 工件

---

## 7. 验收标准

### A. Director Campaign

- 一局结束后，后端能产生可复查的 campaign log
- 首页和结果页都能看到生涯进展
- 重刷页面后，campaign 数据不丢

### B. 玩法契约

- 新增一张卡时，改动点不超过 1 个事实源 + 2 个消费层
- 不再出现“前端有卡，后端无定义”的状态

### C. 稳定性和验证面

- 12 profile 至少各有 1 组 replay/result/share 工件
- mobile homepage / Theater / result 至少各有 1 组截图 + 状态 JSON
- replay 与 scene selector 的关键路径有自动化锁定

### D. 新模式边界

- debate arena 已实现，并保持为唯一新增模式
- 不允许同时并行开多个新大模式

---

## 8. 这轮之后建议立即执行的事

按优先级：

1. 保持 Track A `campaign finalize / daily-status` 与首页真值链路持续回归全绿
2. 继续收口 Track B / Track C 尾项，优先减少实现层重复和验证盲区，而不是继续扩玩法面
3. Track D 如需继续扩功能，保持独立 debate domain，不回塞通用 `scenario` 主引擎
4. 所有新增玩法 / 题材 / 辩题都先补自动化工件，再继续扩美术或交互

---

## 9. 附：本轮工件索引

### 测试

- 历史全量基线：
  - 前端：`179 passed`
  - 后端：`815 passed`
- 本轮围绕 provenance / 导演层 / 反制卡的定向回归：
  - 前端：`49 passed`
  - 后端：`24 passed`
- `frontend` 构建：通过

### E2E

- full 主链路 smoke：
  - `frontend/output/e2e/20260318-post-director-goals-full/result.json`
- Debate full：
  - `frontend/output/e2e/20260318-post-director-goals-debate-full/result.json`
- Debate desktop smoke：
  - `frontend/output/e2e/20260318-b2-debate-smoke/result.json`
- Debate mobile `430x932`：
  - `frontend/output/e2e/20260318-debate-mobile-430x932-v2/result.json`
- Debate civic：
  - `frontend/output/e2e/20260318-debate-civic-v2/result.json`

### develop-web-game

- `frontend/output/web-game/20260317-director-campaign-doc/shot-0.png`
- `frontend/output/web-game/20260317-director-campaign-doc/state-0.json`
- `frontend/output/web-game/20260318-b2-contract-smoke/shot-0.png`
- `frontend/output/web-game/20260318-b2-contract-smoke/state-0.json`

### 交互式 QA

本轮通过 `playwright-interactive` 实际检查了：

- 首页 desktop / mobile
- Theater completed desktop / mobile
- 结果页 desktop / mobile
- 结果页分享弹窗

---

## 10. 文档后的默认下一步

这份文档后续不应再把默认下一步写回 `Track A / Phase A1` 一类的旧实施项，因为这些能力已经落地。

如果下一轮直接进入实现，更合理的顺序应是：

1. 先跑 `release signoff`：
   - `npx tsc --noEmit -p tsconfig.app.json`
   - `npm run build`
   - `npm run e2e:corners`
   - `npm run e2e:cross-browser`
   - `npm run e2e:debate:full`
2. 再做文档真值收口，避免“前文已完成、尾部仍是计划态”再次出现。
3. 若还要继续投入开发，优先做：
   - `scenarioMeta` 兼容层继续瘦身
   - mobile Theater 信息密度优化
   - Safari/WebKit 取证稳定性补强
   - 前端包体与动态加载边界继续压缩

可选最后一步：`使用 recorder agent 更新项目文档`
