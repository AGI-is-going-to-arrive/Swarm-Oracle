# SwarmOracle — 下一轮玩法 / 美术 / 回放执行文档

> 用途：给下一次对话或下一位 agent 直接复用的执行 briefing。  
> 范围：玩法系统深化、Vertex AI 美术资产继续生成、Theater 回放继续增强。  
> 语言：用户交流中文；实现与提示词可中英混合；代码与注释保持项目现有风格。

---

## 1. 当前已完成状态

> 2026-03-17 状态同步：
> - `sample_matrix` 固定样本库现为 14 条；其中治理 / 法律 / 贸易 / 生态 / 战争 / 信仰这 6 个核心题材已经补齐 headed replay / result / share 证据。
> - Theater 完成态不再整页纵向滚动，compact TimelineBar 已嵌回剧场面板，marker 升级为 `fork/card/bet/result` 图标。
> - Prediction modal 现支持第三种下注：`押题材回响`。
> - 结果页会先等待 narration 完成，不再展示“故事 = —”的半成品卡片。
> - 玩法卡 prompt 已升级为“高优先级、持续生效”的导演事件，不再只是普通 intervention 文本。
> - 玩法卡已扩到 8 张，新增：`公开听证 / 资源分诊 / 禁术仪式`。
> - `resource_triage / 资源分诊` 已做过一轮真实 live 注入取证，不只是卡面存在。
> - `e2e-suite.mjs` 现在支持浏览器启动 fallback；若截图卡在字体加载，还会回退到 Chromium CDP 截图，并在输出目录落盘 `browser-launch.json`。

### 1.1 核心玩法层

- 已完成 `竞猜 2.0` 最小闭环：
  - Theater 底部 `下注竞猜` 已可点击。
  - Prediction modal 支持：
    - `押世界线`
    - `押结局倾向`
    - `押题材回响`
  - 结构化下注会写入 prediction API，并在结果页可反解析展示。

- 已完成 `导演点数 + 卡冷却`：
  - 玩法卡消耗导演点数。
  - 卡牌进入冷却。
  - 状态持久化在前端本地存储。

- 已完成 `题目驱动玩法系统`：
  - 当前按 `question + scene_theme` 推断玩法画像：
    - `governance`
    - `war`
    - `empire`
    - `industry`
    - `trade`
    - `law`
    - `faith`
    - `ecology`
    - `frontier`
    - `mythic`
    - `survival`
    - `generic`
  - 每种画像已支持：
    - 推荐卡片顺序
    - 默认任务文案
    - 角色推荐逻辑
    - 来源分支推荐逻辑
    - signature hooks
  - 当前玩法卡共 8 张：
    - `文明辩论`
    - `间谍渗透`
    - `人类潜入`
    - `时空裂缝`
    - `民意浪潮`
    - `公开听证`
    - `资源分诊`
    - `禁术仪式`

- 已完成 `因果档案`：
  - 结果页会显示：
    - 画像
    - 题材 hooks
    - scene theme
    - 每日挑战命中标记
    - 剩余导演点数
    - 玩法记录
    - 下注记录
    - 关键记录
    - `most_used_card`
    - `betting_hit`
    - `archive_grade`
    - `dominant_branch_title`
    - `dominant_tone`
    - `director_style_tag`
    - `profile_resonance`
  - 导出 Markdown 与分享文案现在也会带一段简短的题材档案前缀，不需要改后端协议。

- 已完成 `每日挑战`：
  - 首页有“每日挑战卡片”。
  - challenge pool 现在是 9 条，不再只覆盖 5 个老题材。
  - 点击会自动带入题目、轮数、Agent 数、模式、Theater 开关。
  - 结果页命中时会回写 challenge completed。
  - 首页会显示：
    - 今日是否已完成
    - 已用了几张玩法卡
    - 是否已下注
    - 题材回响反馈
  - 挑战卡文案与状态提示已支持中英文切换。

### 1.2 Theater 回放层

- 已完成：
  - `重播`
  - `跳到最新`
  - `速度切换`
  - `按世界线回放`
  - `按轮次回放`
  - `TimelineBar` 轮次点击跳转
  - round marker 图标（`fork / card / bet / result`）
  - `page.replay_state`

- 当前逻辑：
  - 完成态 Theater 里，`PhaserGame` 只回放筛选后的消息。
  - `skip` 模式只跳到该世界线、该轮之前的最新 bubble。
  - 完成态 replay 现在会带上目标世界线的祖先消息，不再从半路开始。
  - 完成态 Theater 会隐藏底部 timeline bar，把空间让回主剧场画面。
  - live / replay 启动期会跳过 `TitleScene`，避免 4 秒空转。
  - 顶部截图模式现在是显式三段：
    - `Panel`
    - `Canvas`
    - `Modal`

### 1.3 美术资产层

- 已用 Vertex/Gemini 图像模型生成并接入：
  - `frontend/public/assets/ui/generated/daily_challenge_panel.png`
  - `frontend/public/assets/ui/generated/archive_panel.png`
  - `frontend/public/assets/ui/generated/gameplay_panel.png`
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

- 已接入位置：
  - 首页每日挑战卡
  - 结果页因果档案
  - 玩法卡 modal
  - 推荐 badge / 挑战 badge / 档案 badge / 押注命中 badge

### 1.4 已通过验证

- `cd frontend && npm test` → `142 passed`
- `cd frontend && npm run build` → 通过
- 后端当前全量通过：
  - `cd backend && .venv/bin/python -m pytest tests/ -q` → `777 passed, 2 warnings`

### 1.5 当前稳定样本库

- 可直接复用的高分叉 completed 样本：
  - `governance` — `72ae364d-3ea1-4959-939c-8fe1dbeca1c9`
  - `law` — `1e4eb90d-95d5-4851-8141-c571dc0dd9ab`
  - `trade` — `5be95c28-b726-4ba8-a74f-482f637d128c`
  - `ecology` — `fda52830-e300-4a4b-840f-75e4fa003f4c`
  - `war` — `f867f9e0-f4ca-4cdb-976e-493614ae2248`
  - `faith` — `b87e3668-3189-4e80-8f2a-03ca016f659d`
- 主题口径：
  - `law -> modern_city`
  - `faith -> fantasy_kingdom`
  - `trade/ecology -> desert_outpost`

---

## 2. 风格与实现约束

### 2.1 前端风格约束

- 保持当前项目的视觉语言，不要改成另一套设计系统。
- 继续沿用现有调性：
  - 温暖纸面 / 暗色 Theater
  - 洋红、紫、青金、黄铜作为强调色
  - 像素感装饰，但页面仍保持现代可读性
- 不要做：
  - 玻璃拟态泛滥
  - 赛博蓝紫霓虹重做
  - 与现有字体和配色脱节的“新主页”

### 2.2 技能使用约束

如果继续做前端优化，优先使用 `.agent/skills` 中这些技能的原则：

- `frontend-design`
- `polish`
- `harden`
- `optimize`

只允许在“保持当前项目风格一致”的前提下使用这些技能的思路，不允许借机重做视觉体系。

### 2.3 文档约束

- 不要自动更新 `llmdoc/`，除非用户明确说：
  - `使用 recorder agent 更新项目文档`

---

## 3. 下一轮最值得做的任务

按优先级从高到低：

### P1. Theater 截图稳定性 hardening

这一项已经基本收敛：

- `develop-web-game` 黑盒客户端现在支持：
  - `--capture-mode panel`
  - `--capture-mode canvas`
  - `--capture-mode modal`
- `panel` / `canvas` 在当前机器的 headless 下已能稳定导出真实像素剧场画面。
- `modal` 也已经跑通过一轮黑盒 smoke，能截到真实弹窗而不是整页。
- `full --headless` 现在也已跑通过一轮完整回归；suite 会把本次采用的浏览器启动 profile 写进 `browser-launch.json`。
- 若 `page.screenshot()` 卡在字体加载，suite 会自动回退到 Chromium CDP 截图，不再因为单次截图超时把整套回归中断。

剩余更像 polish，而不是阻断项：

- 如需继续做稳定性优化，优先收敛：
  - 录制 GIF 时的模式语义
  - modal 截图在更复杂弹窗下的 smoke 覆盖

**推荐写入点**

- `frontend/src/hooks/useScreenCapture.ts`
- `frontend/src/pages/SimulationView.tsx`
- `/Users/yangjunjie/.codex/skills/develop-web-game/scripts/web_game_playwright_client.js`

### P2. 新建 Theater 场景的可交互 warmup

这一项也已经完成第一版：

- warmup 阶段现在会显式显示：
  - 世界线是否就绪
  - 角色是否就位
  - 导演工具是否解锁
- `🃏 玩法卡` 入口现在可以在 warmup 期间先打开只读预览。
- 真正注入动作会等到角色和分支都同步好后再解锁。

后续若继续做，只需要继续压缩 parser → 首批 agent 可见时间，不需要再重做 warmup UI。

### P3. TimelineBar hover 信息密度继续增强

这项当前也已落地：

- hover tooltip 现在会显示：
  - 本轮分叉到哪些世界线
  - 本轮用了哪些玩法卡
  - 本轮下了哪些注

如果继续做，只剩下更细的美术 polish，例如：

- tooltip 排版再压紧一点
- 视需要补 `timeline_marker_*` 图标素材

### P4. 后续玩法 E2E 测试计划

下一轮如果要继续做玩法 QA，建议不要再“想到哪测到哪”，直接按下面这套矩阵来：

#### P4.1 题材覆盖

至少覆盖这 6 组：

- `governance`
- `trade`
- `law`
- `faith`
- `ecology`
- `war`

#### P4.2 每组最少要跑的链路

每个题材至少验证：

1. 首页或 challenge 入口能正确落到对应题材包
2. live Theater 中：
   - warmup 状态正常
   - 玩法卡可预览
   - 角色就位后可真正注入
3. 注入一张牌后：
   - `messageCount` 增长
   - `modal_state.profile_id` 正确
   - `scenarioMeta.cards.usageLog` 写入
4. 结果页：
   - 因果档案显示 profile label / hooks / resonance
   - 挑战反馈口径正确
5. 分享链路：
   - ShareModal 显示题材 chips
   - copy 前缀包含题材档案

#### P4.3 截图证据

每轮至少留 3 张：

- `panel`
- `canvas`
- `modal`

#### P4.4 建议命令

黑盒优先：

```bash
node .tmp-playwright/web_game_playwright_client.mjs \
  --url http://127.0.0.1:18928/sim/<SCENARIO_ID> \
  --actions-json '{"steps":[{"buttons":[],"frames":8}]}' \
  --iterations 1 \
  --pause-ms 300 \
  --screenshot-dir /tmp/<CASE_NAME> \
  --capture-mode panel
```

需要测弹窗时：

```bash
node .tmp-playwright/web_game_playwright_client.mjs \
  --url http://127.0.0.1:18928/sim/<SCENARIO_ID> \
  --click-selector '<OPEN_MODAL_SELECTOR>' \
  --actions-json '{"steps":[{"buttons":[],"frames":8}]}' \
  --iterations 1 \
  --pause-ms 300 \
  --screenshot-dir /tmp/<CASE_NAME>-modal \
  --capture-mode modal
```

---

## 4. Vertex AI 资产继续生成指南

### 4.1 已验证可用接口

当前可用的是：

```bash
https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent
```

或：

```bash
https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent
```

### 4.2 推荐模型策略

- 草图 / 方向探索：
  - `gemini-3.1-flash-image-preview`
- 最终定稿：
  - `gemini-3-pro-image-preview`

### 4.3 约定

- 不要把 API key 写进仓库文件。
- 下次使用时，通过环境变量传入：

```bash
export GOOGLE_API_KEY="..."
```

### 4.4 调用模板

```bash
curl -sS -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${GOOGLE_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {
        "parts": [
          {
            "text": "YOUR PROMPT HERE"
          }
        ]
      }
    ],
    "generationConfig": {
      "responseModalities": ["TEXT", "IMAGE"]
    }
  }'
```

### 4.5 推荐提示词模板

#### Daily Challenge 牌面

```text
Pixel-art daily challenge panel for a retro strategy simulation interface, warm ivory paper background, magenta and violet accent, brass trim, centered emblem, no transparent checkerboard, no modern photorealism, consistent with an elegant retro editorial game UI.
```

#### Archive 案卷章

```text
Pixel-art archive dossier panel, imperial wax seal feeling, muted gold and violet palette, warm paper background, strategy game archive illustration, elegant and readable, no checkerboard transparency, no modern glossy effect.
```

#### Gameplay 玩法卡章

```text
Pixel-art gameplay tactics crest on parchment-like background, magenta cyan and brass accents, retro strategy game emblem, clear silhouette, decorative but readable, consistent with existing SwarmOracle theater UI.
```

#### Empire 题材卡框

```text
Pixel-art gameplay card frame for imperial strategy scenarios, ancient empire theme, parchment ivory, brass trim, deep violet shadow, centered empty window for content, no text, consistent with SwarmOracle retro theater UI.
```

#### Governance 题材卡框

```text
Pixel-art gameplay card frame for AI governance scenarios, warm ivory panel, magenta and cyan signals, refined retro-futurist strategy UI, centered content window, no text, consistent with SwarmOracle.
```

### 4.6 素材落盘目录

统一放在：

```text
frontend/public/assets/ui/generated/
```

新增素材后同步更新：

- [frontend/public/assets/ASSET_CREDITS.md](/Users/yangjunnie/Desktop/upgrade-test/frontend/public/assets/ASSET_CREDITS.md)

---

## 5. 需要继续生成的素材清单

### 第一优先级

- `gameplay_card_frame_governance.png`
- `gameplay_card_frame_war.png`
- `gameplay_card_frame_empire.png`
- `gameplay_card_frame_industry.png`
- `gameplay_card_frame_frontier.png`
- `gameplay_card_frame_mythic.png`
- `gameplay_card_frame_survival.png`

### 第二优先级

- `badge_recommended.png`
- `badge_daily_challenge.png`
- `badge_archive_record.png`
- `badge_bet_winner.png`

### 第三优先级

- `timeline_marker_fork.png`
- `timeline_marker_card.png`
- `timeline_marker_bet.png`
- `timeline_marker_result.png`

---

## 6. 下一次对话可直接使用的指令

如果下一次你要让我继续，可以直接说：

### 继续 UI / 回放

```text
继续完成 TimelineBar 点击跳转回放，保持当前美术风格一致
```

### 继续生图

```text
继续用 Vertex AI 生成玩法卡框和挑战徽章，并接入当前 UI
```

### 继续玩法 polish

```text
继续完善玩法系统，优先处理因果档案和每日挑战反馈，保持现有风格
```

### 更新 llmdoc

```text
使用 recorder agent 更新项目文档
```

---

## 7. 当前结论

项目现在已经从“推演产品”变成了一个有以下要素的最小闭环：

- 可下注
- 可出牌
- 可重播
- 可跳分支/轮次
- 可留档
- 可做每日挑战

下一轮的重点不再是“有没有玩法”，而是：

- 把截图 / 视觉证据链做稳定
- 把 live Theater 的 warmup 体验继续缩短
- 把导演工具的 hover 信息与回放 polish 做细
