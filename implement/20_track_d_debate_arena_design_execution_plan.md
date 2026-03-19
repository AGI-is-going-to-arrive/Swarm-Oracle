# SwarmOracle Track D — AI 辩论竞技场 MVP 设计与执行方案

> 文档类型：active archive
> 当前真值：部分是
> 阅读方式：本文件保留 Debate Arena 的设计执行基线与实现状态同步。后文未逐段改写的“建议/阶段推进”内容只作历史设计拆解，不按当前待办解释。

> 目标：保留 Debate Arena 的设计执行基线，并把当前真实实现、测试与 E2E 状态同步到同一份文档。
> 范围：产品设计、玩法规则、美术素材、代码开发拆分、i18n、跨平台约束、测试、code review、E2E。
> 原则：严格贴合项目初衷 `What-If 推演引擎 + Pixel Theater + 分支比较 + 下注/排行`，不把产品拉成独立电竞游戏。
> 当前时间：2026-03-18

---

## 0. 一句话结论

`AI 辩论竞技场 / Debate Arena` 应该被设计成 **SwarmOracle 的高张力单场模式**，而不是平行产品。

最小闭环应当是：

`用户出题 -> 正反双方 AI 围绕同一个 What-If 命题辩论 -> 观众下注谁会赢 -> 评委给出胜负和评分 -> 结果页沉淀最佳论点、关键转折和可分享摘要`

它必须复用：

- 现有 What-If 问题输入
- 现有 Theater 场景与像素美术语言
- 现有 Prediction / Share / Result 流程
- 现有 `render_game_to_text()` / `advanceTime(ms)` 自动化钩子思路

它不应该变成：

- 独立对战大厅
- 多模式小游戏合集
- 复杂赛季/ELO 平台
- 需要大量新资产和全新 UI 系统的“第二产品”

---

## 0.1 2026-03-18 实现状态同步

这份文档最初是“可直接开工”的设计文档。当前仓库状态已经进入实现态，后文未逐段改写的设计条目都应以本节为准解释。

- 已实现的后端竖切
  - `backend/app/models/debate.py`
  - `backend/app/api/debate.py`
  - `backend/app/services/debate.py`
  - `backend/app/services/debate_prompts.py`
  - `backend/app/services/debate_scoring.py`
- 已实现的前端拆分
  - `frontend/src/pages/DebateArenaView.tsx`
  - `frontend/src/pages/DebateResultView.tsx`
  - `frontend/src/components/DebateStageRibbon.tsx`
  - `frontend/src/components/DebateMomentumBar.tsx`
  - `frontend/src/components/DebateScoreCard.tsx`
  - `frontend/src/components/DebateBetModal.tsx`
  - `frontend/src/components/DebateShareModal.tsx`
  - `frontend/src/stores/debateStore.ts`
  - `frontend/src/hooks/useDebateWS.ts`
  - `frontend/src/lib/debateLabels.ts`
  - `frontend/src/lib/debateShare.ts`
- 当前真实 API / 协议口径
  - `POST /api/debate`：接收 `question` 与可选 `profile_hint`
  - `GET /api/debate/{id}`
  - `GET /api/debate/{id}/result`
  - `POST /api/debate/{id}/predict`：接收 `kind / target_value / confidence / user_id / user_name`，并可选带 `is_counterplay / counterplay_phase / counterplay_variant`
  - `WS /ws/debate/{id}`
- 当前真实自动化钩子
  - live/result 页已接 `render_game_to_text()` / `advanceTime(ms)` / `capture_game_screenshot()`
  - live 页会输出 `selected_phase / is_phase_locked / unlocked_phases / active_modal / modal_state / bet_window_open / counterplay`
- 当前真实测试与工件
  - 后端：`backend/tests/test_debate_service.py`、`backend/tests/test_debate_api.py`
  - 前端：`DebateArenaView.test.tsx`、`DebateResultView.test.tsx`、`DebateBetModal.test.tsx`、`DebateShareModal.test.tsx`、`useDebateWS.test.tsx`、`debateCounterplay.test.ts`
  - E2E：`frontend/output/e2e/20260318-post-b2-debate-full/result.json`
  - 本轮补充 smoke：`frontend/output/e2e/20260318-b2-debate-smoke/result.json`
  - 本轮补充移动端 `430x932`：`frontend/output/e2e/20260318-debate-mobile-430x932-v2/result.json`
  - 本轮补充 civic 主题：`frontend/output/e2e/20260318-debate-civic-v2/result.json`
  - 本次 session 补充的 Debate counterplay desktop 黑盒：`frontend/output/e2e/20260318-codex-audit-debate-live-counterplay-desktop/result.json`
  - 本次 session 又补了发布收口基础设施：
    - `scripts/e2e-debate-suite.mjs` 的 `result_ready / result CTA` 等待改成 progress-aware，并支持 `SWARM_DEBATE_RESULT_TIMEOUT_MS / SWARM_DEBATE_STALL_TIMEOUT_MS / SWARM_DEBATE_RESULT_CTA_TIMEOUT_MS`
    - `.github/workflows/ci.yml` 新增 deterministic `debate-signoff-smoke`
    - `frontend/output/e2e/post-fix-debate-desktop/`：Debate desktop 黑盒通过
    - `frontend/output/e2e/release-signoff-summary-dry-run/summary.json`：`summary.json` 落盘通过
    - `frontend/output/e2e/post-fix-release-signoff/summary.json`：已确认会按步骤增量更新；这次没有等待整条链路跑完，所以不要把这次复跑写成“通过”

---

## 1. 产品定位与边界

### 1.1 为什么它符合项目初衷

当前 SwarmOracle 的主价值不是“多 Agent 聊天”，而是：

- 把一个 What-If 问题拆成对立立场
- 让推理过程可见
- 让用户下注、比较、回放、分享

`Debate Arena` 只是把“推演中的对抗张力”前置成更短、更强、更易下注的形式。

因此它应该强调：

- 对立立场的可见冲突
- 评委评分的可解释性
- 关键论点和反驳的可回放性
- 单局时长可控，适合重复游玩

### 1.2 明确非目标

MVP 阶段不做：

- 多人真人实时参赛
- 长赛季、天梯、ELO
- 复杂 ban/pick 规则
- 自定义卡组系统
- 复杂裁判团投票网络
- 原生 App 专属能力

### 1.3 与主模式的关系

`Debate Arena` 不是替代主模式，而是新的“快节奏入口”。

推荐关系：

- 主模式：适合完整分支推演
- Debate Arena：适合 3-5 分钟内得到高张力结论、下注与分享

---

## 2. MVP 玩法设计

### 2.1 核心回路

每局固定为一个辩题和三个核心角色：

- 正方 Agent：主张命题成立
- 反方 Agent：主张命题不成立或代价过高
- 评委 Agent：按统一 rubric 给分、定胜负、提炼最佳论点

推荐局内阶段：

1. `Opening`：正反方开篇陈词
2. `Crossfire`：针对对方核心漏洞反击
3. `Evidence Pivot`：各自补充事实、机制、代价
4. `Closing`：压缩结论
5. `Verdict`：评委给出胜负、分数、最佳论点、败因

MVP 默认 `4` 个辩论轮次更合适：

- `Round 1` 开篇
- `Round 2` 交锋
- `Round 3` 证据转折
- `Round 4` 总结

评委不必每轮都长篇发言，但必须在关键节点产生：

- 中途点评
- 最终裁决

### 2.2 用户可交互点

用户在 MVP 中只保留 4 类高价值输入：

- 输入辩题
- 选择题材倾向或让系统自动推断 profile
- 下注“谁会赢”
- 打开回放 / 分享 / 查看评分明细

不建议在 MVP 首版加入实时“人类插话”。

原因：

- 会显著膨胀状态机
- 会让评判标准不稳定
- 会降低自动化测试的确定性

### 2.3 胜负与评分

评委评分建议固定 4 个轴：

- `Evidence`：证据与论据支撑
- `Causality`：因果链完整度
- `Strategic Feasibility`：现实可执行性
- `Counterplay`：对对方论点的拆解能力

每个轴 `0-5` 分，总分 `20`。

最终结果输出：

- 获胜方
- 正反双方总分
- 每个评分轴的简短理由
- `best_argument`
- `turning_point`
- `judge_summary`

### 2.4 与现有分支系统的关系

MVP 不需要完整复制主模式的多分支树。

推荐方案：

- Debate Arena 主体是单局单主线
- 结果页只保留 `1-3` 个“衍生结论卡”
- 这些结论卡来源于：
  - 正方若赢，会导致的主结果
  - 反方若赢，会避免/触发的主结果
  - 评委认为最值得追踪的折中路径

这样仍保留项目的“分支比较”基因，但不把 Arena 做成完整版模拟器。

---

## 3. 体验与 i18n 原则

### 3.1 首页入口

首页不建议增加第三种大模式 Tab。

更合适的入口：

- 在首页主输入区下新增 `Debate Arena` 次入口卡
- 或者在 `Quick Start` 区加入 `Arena` CTA

这样可以避免首页模式爆炸。

### 3.2 Debate Arena 页面结构

页面必须沿用 Theater 语言：

- 左/中：主剧场画布
- 右：正方 / 反方 / 评委状态栏
- 顶部：轮次、当前阶段、下注入口、回放入口
- 底部：得分条 / 论点强度条 / 观众倾向

不要做成“体育直播网站”或“紫色电竞直播间”。

### 3.3 i18n 约束

Track D 必须满足以下不变式：

- UI 文案全量双语
- 辩题文本随用户输入语言
- 正反方标签、评分轴、按钮、空状态、错误提示都有 `zh/en`
- 评委裁决文案和分享文案跟随输入语言
- 自动化输出中的 `page.kind / controls / verdict` 结构字段保持稳定，不因语言变化改 key

### 3.4 跨平台约束

目标平台是浏览器优先：

- Windows：Chrome / Edge
- macOS：Chrome / Safari
- Linux：Chrome / Chromium
- iOS：Safari / Chromium 内核壳
- Android：Chrome

当前真实验证证据已覆盖 Chromium/Chrome、Firefox、WebKit 与 Safari 的主模式 director-state smoke；Safari 若开启翻译插件，截图会被浏览器/插件浮层污染，但功能链路已实测通过。

要求：

- 首屏不依赖 hover
- 触控命中区 `>= 44px`
- 小屏安全区内语言切换、返回、下注 CTA 不重叠
- WebGL 不可用或性能过低时，允许回退到简化 DOM/HUD 视图

---

## 4. 美术素材方案

### 4.1 视觉方向

沿用当前项目的 `Pixel Theater + 仪式感 UI + GBC 像素语汇`。

关键词：

- `ceremonial`
- `pixel tribunal`
- `civic duel`
- `argument as spectacle`
- `not esports neon`

必须避免：

- 霓虹紫电竞直播间
- 现代 3D 舞台
- 写实体育馆
- 卡通综艺秀

### 4.2 可复用资产

优先复用：

- 角色 sprite 体系
- 现有主题背景的法庭/议会/神殿/轮值议场变体
- `bet_panel`
- `leaderboard`
- `minimap_frame` 的边框语言
- 当前结果页和分享卡片的排版语汇

### 4.3 建议新增资产

```text
frontend/public/assets/scenes/
├── debate_arena_civic.png
├── debate_arena_judicial.png
└── debate_arena_forum.png

frontend/public/assets/ui/generated/
├── debate_stage_banner.png
├── debate_verdict_panel.png
├── debate_score_meter.png
├── debate_badge_proposition.png
├── debate_badge_opposition.png
├── debate_badge_judge.png
└── debate_quote_frame.png
```

### 4.4 资产生成建议

建议扩展现有 `frontend/scripts/generate-ui-assets.mjs` 的 preset，而不是新造一套脚本。

推荐 prompt 原则：

- `16-bit inspired pixel art`
- `same visual language as existing SwarmOracle theater scenes`
- `ornamental but readable`
- `court / chamber / arena of ideas`
- `no photorealism`
- `no modern esports stage`

示例 prompt：

```text
Debate arena in the same pixel-theater style as SwarmOracle, ceremonial civic chamber,
two podiums facing each other, central judge dais, dramatic but readable composition,
16-bit pixel art, restrained magenta-gold-cyan palette, no photorealism, no neon esports.
```

### 4.5 美术实施优先级

优先级建议：

1. 先用现有 `law_court_variant / civic_chamber / switchboard_forum_variant` 组合出 MVP
2. 再补 1 套通用 `debate_verdict_panel / debate_stage_banner / debate_score_meter`
3. 最后补 2-3 张专用 debate arena scene

这样最符合“小步快跑 + 保持同一美术语言”。

---

## 5. 代码开发方案

### 5.1 后端拆分

建议独立实现，不直接塞进 `scenario` 主引擎。

```text
backend/app/
├── api/
│   └── debate.py
├── models/
│   └── debate.py
├── services/
│   ├── debate.py
│   └── debate_scoring.py
└── tests/
    ├── test_debate_api.py
    ├── test_debate_service.py
    └── test_debate_scoring.py
```

最小数据对象建议：

- `DebateSession`
- `DebateTurn`
- `DebateVerdict`
- `DebatePrediction`

### 5.2 最小 API

```json
POST /api/debate
{
  "question": "What if every city had to publish every emergency decision before execution?",
  "profile_hint": "law"
}

GET /api/debate/{id}

POST /api/debate/{id}/predict
{
  "kind": "winner",
  "target_value": "proposition",
  "confidence": 0.7,
  "user_id": "director-demo",
  "user_name": "Arena QA"
}
```

推荐响应字段：

- `status`
- `question`
- `profile_id`
- `scene_theme`
- `pro_agent`
- `con_agent`
- `judge_agent`
- `turns`
- `verdict`
- `best_argument`
- `score_breakdown`

### 5.3 前端拆分

```text
frontend/src/
├── pages/
│   ├── DebateArenaView.tsx
│   └── DebateResultView.tsx
├── components/
│   ├── DebateScoreCard.tsx
│   ├── DebateMomentumBar.tsx
│   ├── DebateStageRibbon.tsx
│   ├── DebateBetModal.tsx
│   └── DebateShareModal.tsx
├── stores/
│   └── debateStore.ts
├── hooks/
│   └── useDebateWS.ts
├── lib/
│   ├── debateLabels.ts
│   └── debateShare.ts
└── game/
    └── automation.ts
```

优先复用：

- `PredictionModal` 的交互模式
- `ResultView` 的结果展示块
- `themeRegistry` 的场景选择
- `LanguageSwitcher`

### 5.4 自动化钩子

`DebateArenaView` 必须暴露：

```js
window.render_game_to_text = () => JSON.stringify({
  page: {
    kind: "debate",
    route: window.location.pathname,
    phase: "crossfire",
    selected_phase: "crossfire",
    is_phase_locked: false,
    unlocked_phases: ["opening", "crossfire"],
    controls: {
      can_open_prediction: true,
      can_view_result: false,
      active_modal: null
    }
  },
  debate: {
    motion: "...",
    proposition: { score: 41 },
    opposition: { score: 39 },
    judge: { summary_ready: false },
    visible_quotes: ["...", "..."],
    bet_window_open: true
  }
});

window.advanceTime = async (ms) => { ... };
```

这样 `develop-web-game` 和 `playwright-interactive` 才能稳定工作。

### 5.5 开发里程碑

建议按 4 段推进：

1. `D1 skeleton`
   - 数据模型
   - create/get/predict API
   - 空页面和假数据结果卡

2. `D2 live arena`
   - 正反方轮次驱动
   - 评委裁决
   - Theater 壳和基础 HUD

3. `D3 polish`
   - share
   - replay
   - i18n
   - 素材接线

4. `D4 acceptance`
   - 单测
   - 集成
   - E2E
   - code review

---

## 6. 测试方案

### 6.1 单测

后端：

- `test_debate_service.py`
  - 轮次推进正确
  - 正反方角色分配正确
  - verdict 幂等

- `test_debate_api.py`
  - create/get/result/predict 路径正确
  - prediction 锁单与结果页读取正确

前端：

- `DebateArenaView.test.tsx`
  - 初始态 / live 态 / result 态
  - i18n 切换
  - `render_game_to_text()` 输出稳定

- `DebateScoreCard.test.tsx`
  - 评分轴展示
  - 平局 / 单边碾压 / 错误态

### 6.2 集成测试

- `POST /api/debate -> GET /api/debate/{id}`
- `POST /predict`
- live 到 verdict 的状态迁移
- `scene_theme` 与 `profile/question` 映射

### 6.3 develop-web-game 测试回路

Arena 模式接入后，`develop-web-game` 应负责：

- 进入 live arena
- 等待轮次推进
- 在可下注阶段下注
- 等待 verdict
- 读取 `state-*.json`
- 对比截图与状态摘要是否一致

推荐工件：

```bash
cd frontend
node .tmp-playwright/web_game_playwright_client.mjs \
  --url http://127.0.0.1:18928/debate/<id> \
  --actions-json '{"steps":[{"buttons":[],"frames":8},{"buttons":[],"frames":8}]}' \
  --iterations 3 \
  --pause-ms 250 \
  --capture-mode panel \
  --screenshot-dir output/web-game/debate-arena-smoke
```

### 6.4 playwright-interactive QA 清单

必须覆盖：

- desktop 首页入口
- desktop Arena live
- desktop Arena result
- mobile 首页入口
- mobile Arena live
- mobile Arena result
- share modal
- 语言切换

必须显式检查：

- 首屏是否裁切
- 正反方标识是否明显
- 评委结论是否可见
- 下注 CTA 是否在可点击区域
- 小屏右下语言切换是否挡住 Arena HUD

### 6.5 Playwright CLI / 无状态回归

建议新增：

```text
frontend/scripts/e2e-debate-suite.mjs
```

最小场景：

1. `law debate`
2. `governance debate`
3. `generic debate`
4. `mobile smoke`
5. `i18n smoke`

输出目录：

- `output/e2e/debate-matrix/`
- `output/e2e/debate-mobile/`
- `output/e2e/debate-corners/`

---

## 7. Code Review 方案

Review 必须先看风险，不先看“代码写得像不像”。

### 7.1 后端 review 清单

- 是否又造了一套与 `scenario` 重复的状态机
- verdict 是否幂等
- judge score 是否单一事实源
- language / profile / theme 推断是否散落多处
- prediction 数据是否与现有 leaderboard 复用或隔离清楚

### 7.2 前端 review 清单

- 是否又造了一套脱离 Theater 的视觉系统
- Arena 页面是否在移动端裁切
- i18n 是否有硬编码字符串
- `render_game_to_text()` 是否覆盖 live/result 两态
- 下注、结果、回放、分享是否共用现有能力，而不是重复实现

### 7.3 资产 review 清单

- 新素材是否仍属于当前像素剧场风格
- 是否出现霓虹电竞化偏移
- 是否复用了已有边框、徽章、按钮语言
- 是否为每个新增 asset 补了命名、来源和 credits

---

## 8. E2E 验收标准

Track D 文档阶段结束后，后续实现必须以这些标准签收。

### 8.1 功能验收

- 用户能创建一场 debate
- 正反方和评委都能正常出场
- 用户能下注谁会赢
- verdict 可见
- 结果页可分享

### 8.2 i18n 验收

- 中文输入 -> 中文 Arena / verdict / share
- 英文输入 -> 英文 Arena / verdict / share
- UI 切换器文案完整
- 不出现中文题面混进英文 Arena 的问题

### 8.3 跨平台验收

- desktop `1440x960`
- mobile `390x844`
- mobile `430x932`

每个视口都要有：

- live 截图
- result 截图
- `render_game_to_text()` 状态 JSON

### 8.4 真实工件要求

- 至少 3 组 debate 主题工件
  - 当前仓库内已补到：`debate_arena_forum / debate_arena_judicial / debate_arena_civic`
- 至少 2 组移动端工件
  - 当前仓库内已补到：`390x844` 与 `430x932`
- 至少 1 组英文工件
- 至少 1 组 `develop-web-game` 工件
- 至少 1 组 `playwright-interactive` 复核截图

---

## 9. 风险与应对

### 风险 1：模式膨胀

风险：

- Debate Arena 做成第二产品

应对：

- 首页只给次入口
- 复用 Theater / Result / Prediction 能力

### 风险 2：评分不可解释

风险：

- judge 只给 winner，不给理由

应对：

- 强制 score breakdown
- 强制 best argument / turning point

### 风险 3：移动端密度过高

风险：

- Arena 比主模式更容易挤爆小屏

应对：

- 小屏默认折叠次级信息
- 评分卡优先显示 winner + 总分，详细分轴收进展开区

### 风险 4：自动化不可测

风险：

- 只有视觉，没有稳定状态输出

应对：

- MVP 首版就接 `render_game_to_text()` 与 `advanceTime(ms)`

---

## 10. 推荐执行顺序

如果下一轮正式开始 Track D 实现，推荐顺序如下：

1. 先做 `D1 skeleton`
2. 再做最小 Arena live 流程
3. 再接 i18n 和 share
4. 再补 debate 专属素材
5. 最后跑 `develop-web-game + playwright-interactive + Playwright CLI` 的真实工件

最重要的约束只有一句：

`Debate Arena 必须像 SwarmOracle 的一种高张力玩法，而不是另一个产品。`
