# SwarmOracle - Track D AI 辩论竞技场 MVP 蓝图

> 目标：记录 Track D Debate Arena MVP 的设计蓝图与已实现状态，而不是继续把它当作候选方向。
> 范围：产品设计、美术素材、代码开发拆解、测试、code review、E2E 方案。
> 原则：不偏离项目初衷 What-If 推演引擎 + Pixel Theater + 分支比较 + 下注排行 + 分享。
> 当前时间：2026-03-18

---

## 0. 文档定位

这份文档回答 7 个问题：

1. Debate Arena 为什么适合当前项目，而不是把产品拉向另一种游戏。
2. 核心玩法循环是什么，什么必须做，什么明确不做。
3. 视觉风格如何沿用当前 Theater 像素剧场，而不是重做一套电竞 UI。
4. 前后端代码应该怎么拆，哪些能力复用，哪些能力独立。
5. i18n、跨平台、自动化钩子从第一天就要怎么设计。
6. develop-web-game、playwright-interactive、Playwright CLI Skill 在这条线里怎么用。
7. 什么时候才算 Track D 真正达到可玩、可测、可审查的完成态。

---

## 0.1 2026-03-18 落地状态同步

这份蓝图已不再是“候选方向”。当前 Debate Arena MVP 已经落地，后文中的设计条目主要作为设计基线与验收参考。

- 已落地的用户面
  - 首页已有 `Debate Arena` 入口
  - live 页：`/debate/:id`
  - result 页：`/debate/:id/result`
  - 押注：`winner / verdict_tone`
  - 分享：`DebateShareModal`
- 已落地的实现面
  - 后端：`Debate / DebateTurn / DebatePrediction / DebateCounterplay` 独立模型与 `/api/debate` + `/ws/debate/{id}`
  - 前端：`DebateArenaView / DebateResultView / debateStore / useDebateWS / DebateBetModal / DebateShareModal`
  - 自动化：`render_game_to_text()` / `advanceTime(ms)` / `capture_game_screenshot()`
- 已落地的验证面
  - E2E：`frontend/output/e2e/20260318-post-b2-debate-full/result.json`
  - 本轮 desktop smoke：`frontend/output/e2e/20260318-b2-debate-smoke/result.json`
  - 本轮移动端 `430x932`：`frontend/output/e2e/20260318-debate-mobile-430x932-v2/result.json`
  - 本轮 civic 主题：`frontend/output/e2e/20260318-debate-civic-v2/result.json`
  - develop-web-game 工件：`frontend/output/web-game/20260317-debate-arena-signoff/`
  - 本次 session 又补了 Debate counterplay live/result desktop 黑盒：`frontend/output/e2e/20260318-codex-audit-debate-live-counterplay-desktop/result.json`

---

## 1. 产品定位

### 1.1 一句话定义

AI 辩论竞技场是一种结构化 What-If 对抗模式：
用户提出问题，系统转译为辩题，由正方、反方、评委在 Theater 中实时交锋，用户下注胜方或判词走向，最后得到带评分、最佳论点和可分享结果的结构化结论。

### 1.2 它如何符合项目初衷

- 仍然从 What-If 问题出发，不是独立聊天机器人，也不是动作小游戏。
- 仍然强调多 Agent 推理、可视化、结果比较、用户下注。
- 复用现有 Theater、Prediction、Share、Result、i18n、scene selector、automation hooks。
- 比继续横向扩更多随机玩法更收束，因为辩论规则更清晰、测试面更可控。

### 1.3 明确不做

- 不做真人实时 PvP
- 不做赛季、ELO、战队系统
- 不做语音房、弹幕房
- 不做开放沙盒论战编辑器
- 不做独立经济系统或皮肤商城

---

## 2. 核心体验

### 2.1 体验支柱

- 高可读张力：用户一眼看懂谁在主张什么、谁占上风、为什么
- 可下注可回看：下注围绕胜负和判词，不是装饰层
- 像素剧场一致性：沿用当前 Theater 语言，不做泛化电竞 neon UI
- 快开快结算：一局应比完整多分支推演更短、更聚焦、更容易重复玩
- 可分享：结果页必须比普通 scenario 更适合生成金句、裁决摘要和胜负原因

### 2.2 MVP 主循环

~~~text
输入问题
  ↓
系统生成辩题 + 正反阵营 framing
  ↓
用户进入 Debate Arena
  ↓
正方开篇 → 反方开篇 → 交叉质询 → 反驳 → 评委判决
  ↓
用户下注 / 查看实时优势条 / 关键论点
  ↓
结果页：胜方、维度评分、最佳论点、判词、分享
~~~

### 2.3 用户真正在玩什么

用户不是操纵角色移动，而是在玩三类决策：

- 选题：挑更容易出现冲突和可辩性的 What-If
- 下注：押正方、反方或判词走向
- 观看与复盘：从 live 辩论中判断局势，回看关键阶段和最佳驳斥

这与当前产品心智一致：它仍然是带可视化和下注层的推理剧场。

---

## 3. MVP 玩法设计

### 3.1 实体与角色

- 正方 Proposition Agent
  - 主张该 What-If 路径应被支持、加速或正当化
- 反方 Opposition Agent
  - 主张该 What-If 路径应被阻止、约束或推翻
- 评委 Judge Agent
  - 不直接站边，负责阶段总结、提炼争点、最终评分与判决
- 观众势能 Audience Meter
  - 一条可视化风向辅助指标，不做真实聊天观众群

### 3.2 MVP 阶段结构

建议固定 5 段，不开放自由轮数：

1. Opening
2. Crossfire
3. Rebuttal
4. Closing
5. Verdict

作用：

- Opening 拉开立场
- Crossfire 产生最高戏剧张力
- Rebuttal 决定谁真正抓住漏洞
- Closing 收束冲突
- Verdict 把观感和结构化结论统一起来

### 3.3 评委评分维度

MVP 只保留 4 个维度：

- coherence
- evidence
- adaptability
- impact

输出结构建议：

~~~json
{
  "winner": "proposition",
  "score": {
    "proposition": 82,
    "opposition": 77
  },
  "breakdown": {
    "coherence": { "proposition": 20, "opposition": 18 },
    "evidence": { "proposition": 18, "opposition": 20 },
    "adaptability": { "proposition": 22, "opposition": 17 },
    "impact": { "proposition": 22, "opposition": 22 }
  },
  "best_argument": "...",
  "best_rebuttal": "...",
  "judge_summary": "..."
}
~~~

### 3.4 下注范围

第一版只允许两类下注：

- winner
  - proposition
  - opposition
- verdict_tone
  - order
  - balance
  - rupture

不把旧的多分支下注协议直接硬塞进来。

### 3.5 Replay 设计

Replay 围绕辩论结构切段，不重播所有粒度消息：

- Opening
- Crossfire
- Rebuttal
- Closing
- Verdict

用户至少能：

- 跳到某个辩论阶段
- 看该阶段代表性论点
- 看势能条和评委临时意见

---

## 4. 页面流与信息架构

### 4.1 路由建议

~~~text
/                    首页
/debate/:id          Debate Arena 实时页
/debate/:id/result   Debate Arena 结果页
~~~

### 4.2 首页入口

建议采用轻量模式切换，而不是新首页：

- World Simulation
- Debate Arena

也可以补一张快速开始卡片，但不要喧宾夺主。

### 4.3 Debate 实时页布局

桌面端：

~~~text
┌─────────────────────────────────────────────┬─────────────────────────┐
│ Theater 舞台                               │ 辩手 / 评委卡片         │
│ 正反站位 + 气泡 + 势能条 + 阶段标记        │ 当前发言摘要            │
│                                             │ 下注入口 / 赔率 / 规则  │
├─────────────────────────────────────────────┼─────────────────────────┤
│ 阶段时间线 / 关键论点 marker / 判决预告     │ Live feed               │
└─────────────────────────────────────────────┴─────────────────────────┘
~~~

移动端：

- 舞台必须留在首屏
- 辩手卡片改为横向切换或折叠卡组
- 下注按钮固定在不遮挡主舞台的位置
- 判决阶段卡片必须在一屏内读到胜方和理由摘要

### 4.4 Debate 结果页

必须包含：

- 胜方卡片
- 正反双方总分
- 维度分解
- 最佳论点
- 最佳反驳
- 判词摘要
- 下注结算
- 分享 CTA

---

## 5. 美术与素材方案

### 5.1 视觉原则

- 继续沿用 Pixel Theater + GBC 调色板 + 剧场舞台风格
- 避免做成通用电竞直播间或 neon 赛博面板
- 保留故事剧场质感，不让 Debate Arena 变成表格化评分界面

### 5.2 推荐新增场景

第一版只新增 3 个 Debate 专用背景：

~~~yaml
scenes:
  - debate_arena_civic
  - debate_arena_judicial
  - debate_arena_forum
~~~

语义映射：

- debate_arena_civic
  - 公民大会、治理争论、平台国家、民主程序
- debate_arena_judicial
  - 审判庭、程序对决、法条争议、紧急否决
- debate_arena_forum
  - 通用高冲突议场、轮值审查、制度博弈

### 5.3 可直接复用的现有资产

- 角色像素精灵
- bet_panel、leaderboard、panel_bg、title_screen
- debate、particle_smoke、particle_star
- timeline_marker 系列
- 现有 Theater panel 边框与 GBC 色板

### 5.4 建议新增 UI 资产

~~~yaml
ui:
  - debate_stage_banner
  - debate_verdict_panel
  - debate_score_meter
  - debate_badge_proposition
  - debate_badge_opposition
  - debate_badge_judge
  - debate_quote_frame
~~~

### 5.5 Gemini 生图约束

继续使用现有前端生成链路，不把 key 写进仓库。

建议新增 preset：

- debate_arena_civic
- debate_arena_judicial
- debate_arena_forum
- debate_verdict_panel

生成提示词骨架：

~~~text
Create a pixel-art debate chamber for a retro strategy theater interface.
Style constraints:
- same visual language as an existing Game Boy Color inspired political simulation theater
- readable central stage
- side podiums for two speakers
- restrained palette, no neon esports look
- cinematic but still grid-friendly for UI overlays
- 16:9 composition
~~~

### 5.6 必须避免的方向

- 过度电竞化红蓝对抗 HUD
- 现代直播间弹幕风
- 大面积高饱和霓虹紫
- 写实法庭或写实演播厅
- 与当前像素剧场不兼容的立体透视 UI

---

## 6. 代码开发方案

### 6.1 后端拆分原则

Track D 不建议直接塞进现有通用 scenario service。
推荐独立 domain，复用共用基础设施。

~~~text
backend/app/
├── api/
│   └── debate.py
├── models/
│   └── debate.py
└── services/
    ├── debate.py
    ├── debate_prompts.py
    └── debate_scoring.py
~~~

复用层：

- llm_client.py
- lang_detect.py
- prediction / share envelope 逻辑
- WebSocket 推送基础设施

### 6.2 后端最小数据模型

~~~text
Debate
- id
- question
- motion
- language
- status
- scene_theme
- created_at
- updated_at

DebateParticipant
- debate_id
- side
- agent_name
- role
- stance

DebateTurn
- debate_id
- phase
- speaker_side
- speaker_name
- content
- score_delta_json

DebatePrediction
- debate_id
- user_id
- user_name
- kind
- target_value
- confidence
- score
~~~

### 6.3 后端 API

~~~http
POST /api/debate
GET  /api/debate/:id
GET  /api/debate/:id/result
POST /api/debate/:id/predict
WS   /ws/debate/:id
~~~

事件建议：

- status
- agent_speak_start / delta / complete
- debate_phase_change
- debate_score_update
- debate_verdict

### 6.4 前端拆分

~~~text
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
└── lib/
    ├── debateLabels.ts
    └── debateShare.ts
~~~

### 6.5 前端复用优先级

- 复用 SimulationView 的 Theater shell 结构，但不要把 Debate Arena 硬塞进同一个组件
- 复用 PredictionModal 的表单经验，但下注应做单独 modal
- 复用 ResultView 的分享和导出思路，但单独做 DebateResultView
- 复用 render_game_to_text、capture_game_screenshot、advanceTime 协议

### 6.6 Debate 自动化钩子

第一版就必须暴露：

~~~json
{
  "page": {
    "kind": "debate",
    "route": "/debate/:id",
    "phase": "crossfire",
    "controls": {
      "can_open_prediction": true,
      "can_view_result": false,
      "capture_mode": "panel"
    }
  },
  "debate": {
    "motion": "...",
    "proposition": { "score": 41 },
    "opposition": { "score": 39 },
    "judge": { "summary_ready": false },
    "visible_quotes": ["...", "..."]
  }
}
~~~

最值得先写的 5 个钩子：

1. live 页 render_game_to_text
2. result 页 render_game_to_text
3. advanceTime(ms)
4. capture_game_screenshot(panel|canvas|modal)
5. debate phase 和 score 摘要

---

## 7. i18n 与跨平台

### 7.1 i18n 必做项

第一版就要保证这些文案不硬编码：

- 辩论阶段名
- 正方、反方、评委标签
- 下注种类与结果
- 评分维度
- 判词 CTA
- 分享模板
- 空态、错误态、loading 态

同时遵守现有规则：

- UI 跟随 LanguageSwitcher
- LLM 输出语言主要跟随输入语言
- 自动化 payload 中的结构字段稳定，文本字段允许中英切换

### 7.2 跨平台目标

当前产品仍是浏览器优先的跨平台 Web，不做原生壳。

支持目标：

- Windows、macOS、Linux
  - Chromium 系浏览器优先
  - Safari、Firefox 作为兼容目标
- iOS、Android
  - 移动浏览器可玩
  - 触控优先，不依赖 hover-only 交互

### 7.3 跨平台边界

- Fullscreen
  - 桌面浏览器完整支持
  - iOS 只做 best effort
- GIF
  - 桌面完整支持
  - 移动端允许回退到 PNG
- 性能
  - 低端移动设备减少同时显示的气泡和粒子数量
- 安全区
  - iOS 和 Android 必须检查顶部刘海区和底部手势区

### 7.4 前端优化技能约定

如果 Debate Arena 进入前端优化与打磨阶段，优先使用：

- frontend-design
- adapt
- harden
- audit
- polish
- optimize

顺序建议：

1. frontend-design 定首屏和舞台结构
2. adapt 处理桌面和移动适配
3. harden 处理 i18n、溢出和异常态
4. audit 做综合质量扫描
5. polish 与 optimize 收尾

---

## 8. 测试矩阵

### 8.1 单测

后端：

- debate_motion_builder
- debate_side_assignment
- debate_score_parser
- debate_verdict_aggregator
- debate_predict_validation

前端：

- debateStore
- DebateArenaView
- DebateResultView
- DebateBetModal
- debateLabels
- render_game_to_text payload

### 8.2 集成测试

- 创建辩题 -> 生成 motion -> 正反评委齐备
- WebSocket 阶段切换顺序正确
- 判决结果能稳定落到结果接口
- 下注提交、评分、幂等重放

### 8.3 E2E

最小主路径：

~~~text
首页选择 Debate Arena
  ↓
输入问题并创建辩题
  ↓
进入 live debate
  ↓
开局前下注胜方
  ↓
等待 Verdict
  ↓
进入结果页
  ↓
查看胜方、最佳论点、分享弹窗
~~~

当前仓库里的 Debate 专项自动化，已真实覆盖：

- desktop
- mobile
- 中文输入
- 英文输入
- 正方胜出
- 反方胜出
- share modal
- live -> bet -> result -> share 主路径

### 8.4 Skill-based QA

develop-web-game：

- 验证 deterministic step hook
- 用固定 action burst 检查阶段推进、下注、结果跳转
- 产出 shot 和 state 工件

~~~bash
cd frontend
node .tmp-playwright/web_game_playwright_client.mjs \
  --url http://127.0.0.1:18928/debate/<id> \
  --actions-json <actions-json> \
  --iterations 2 \
  --pause-ms 250 \
  --capture-mode panel \
  --screenshot-dir output/web-game/debate-arena-smoke
~~~

playwright-interactive：

- 桌面和移动双面 QA
- 检查 live 页、result 页、share modal、语言切换
- 检查移动端首屏是否把舞台、势能条、下注入口都留在可见区

固定 QA inventory：

- desktop 首页
- mobile 首页
- desktop Debate live
- mobile Debate live
- Debate result
- share modal

Playwright CLI Skill：

- 当本机 wrapper 稳定时，作为 CI 前的轻量浏览器回归入口
- 跑 debate-smoke 和 debate-mobile-smoke

当前可直接复用的新参数：

- `--width`
- `--height`
- `--question`
- `--profile-hint`

这样可直接补：

- `430x932` 移动端工件
- 指定 `governance -> debate_arena_civic` 的主题工件

### 8.5 最值得先写的自动化钩子

1. live 页 render_game_to_text
2. result 页 render_game_to_text
3. advanceTime(ms)
4. capture_game_screenshot(panel|canvas|modal)
5. phase 和 score 摘要

---

## 9. Code Review 清单

### 9.1 设计一致性

- 是否仍然是 What-If 驱动，而不是脱离主线的竞技模式
- 是否尽量复用了现有 Prediction、Share、Theater 基础设施
- 是否避免把 Debate 逻辑继续塞胖通用 scenario service

### 9.2 i18n

- 是否存在中文硬编码漏到英文界面
- 是否存在 UI 语言和输出语言策略互相打架
- 是否 share、result、modal 都补齐了 key

### 9.3 可玩性

- 一局是否足够短，能重复玩
- 势能条、评分、胜负原因是否让用户看得懂
- 下注是否真的影响观看体验，而不是摆设

### 9.4 自动化

- 是否从第一版就有 render_game_to_text
- 是否 replay、result、share 都可被 E2E 取证
- 是否把移动端也纳入了验收

### 9.5 风险点

- 判决 JSON 解析失败后的 fallback
- 评委与辩手语言不一致
- 移动端首屏裁切
- 结果页过度文字化导致分享弱

---

## 10. 实施顺序

### Phase D0 - 设计冻结

- 锁定 MVP 范围
- 锁定 UI 骨架
- 锁定评委评分维度
- 锁定首批资产清单

### Phase D1 - 后端竖切

- models/debate.py
- services/debate.py
- api/debate.py
- 最小 create/get/result/predict 链路

### Phase D2 - 前端 live page

- DebateArenaView
- debateStore
- useDebateWS
- live stage、score、bet modal

### Phase D3 - 结果页与分享

- DebateResultView
- DebateScoreCard
- share envelope
- automation payload

### Phase D4 - 资产与 QA

- Debate 主题场景
- UI 资产
- desktop、mobile E2E
- develop-web-game 与 playwright-interactive 工件

---

## 11. 验收标准

达到以下条件，才可称 Track D MVP ready：

- 用户可从首页进入 Debate Arena
- 一局辩论可完整跑完，并得到评委判决
- 结果页能显示胜方、最佳论点、维度评分和分享文案
- 中英界面都可用，没有明显硬编码串语言
- desktop、mobile 都有真实截图和状态 JSON 双证据
  - 当前仓库里已补到 `390x844` 和 `430x932` 两组移动端工件
- develop-web-game 能稳定产出 shot/state 工件
- playwright-interactive 能完成桌面和移动复核

---

## 12. 推荐落地文件

~~~text
backend/app/api/debate.py
backend/app/models/debate.py
backend/app/services/debate.py
backend/app/services/debate_prompts.py
backend/app/services/debate_scoring.py
backend/tests/test_debate_api.py
backend/tests/test_debate_service.py

frontend/src/pages/DebateArenaView.tsx
frontend/src/pages/DebateResultView.tsx
frontend/src/components/DebateScoreCard.tsx
frontend/src/components/DebateMomentumBar.tsx
frontend/src/components/DebateStageRibbon.tsx
frontend/src/components/DebateBetModal.tsx
frontend/src/stores/debateStore.ts
frontend/src/hooks/useDebateWS.ts
frontend/src/lib/debateMotion.ts
frontend/src/lib/debateShare.ts
frontend/src/lib/debateLabels.ts
frontend/src/i18n/locales/en.json
frontend/src/i18n/locales/zh.json
~~~

---

## 13. 最终建议

Track D 的正确做法不是马上写很多功能，而是：

1. 先按这份蓝图锁定 MVP
2. 先做独立 debate domain，避免污染现有 scenario 主引擎
3. 先写自动化钩子和 E2E 骨架，再写视觉细节
4. 让第一版就能生成可信的 live -> verdict -> result -> share 闭环

可选最后一步：使用 recorder agent 更新项目文档
