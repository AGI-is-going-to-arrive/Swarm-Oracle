# SwarmOracle 3.0 — 全面视觉改进计划

> 参考项目：[Star-Office-UI](https://github.com/ringhyacinth/Star-Office-UI) — 像素办公室实时 Agent 状态仪表盘
> 现状分析：2.0 升级计划四个 Phase 均已完成，但实际运行中存在多个美术/视觉/逻辑 bug
>
> 2026-03-16 状态同步：
> - 完成态 Theater 的首屏布局已稳定，compact TimelineBar 已直接嵌回面板内。
> - Timeline marker 已从文本 `F/C/B` 升级为 `fork/card/bet/result` 图标。
> - 剧场气泡文字已切到更清晰的常规字体栈，保留气泡框像素风。
> - 截图 / GIF 下载链路已加固为标准 `PNG / GIF` 下载。
> - 2026-03-19 补充同步：
>   - 导演目标 / worldline 承诺已后端化到 `Scenario.director_state_json`，不再只是前端本地态。
>   - 主模式 `cards.usageLog` 已后端化到 `Scenario.gameplay_state_json`，前端会基于远端 `usage_log` 重算导演点数、卡牌冷却与反制轨迹摘要。
>   - 当前定向验证口径：后端 `80 passed`，前端 `66 passed`，Theater 可读性定向 `12 passed`。
>   - 当前主模式 `gameplay_state_roundtrip` 黑盒工件位于 `frontend/output/e2e/20260319-post-gameplay-state-corners/result.json`。
>   - 当前官方跨浏览器工件位于 `frontend/output/e2e/20260319-official-cross-browser/result.json` 与 `frontend/output/e2e/20260319-official-safari-v5/result.json`。
>   - WebKit 下结果页因果档案顶部大图白块已修复；Safari 若开启翻译插件，截图仍可能被浏览器/插件浮层污染，但官方 `e2e:safari` 已实跑通过。
>   - Theater 又做了一轮可读性收口：舞台优先、上下 chrome 压缩、气泡文字放大并加清晰化描边。

## 问题诊断

### 核心问题

| # | 问题 | 严重度 | 根因 |
|---|------|--------|------|
| 1 | **场景不随 What-If 问题动态切换** | 🔴 高 | `VizSynthesizer.inferSceneTheme()` 仅做静态关键词匹配，且后端 `scene_selector.py` 未在实时 WS 流中调用 |
| 2 | **角色不随问题/persona 动态分配** | 🔴 高 | `persona_mapper.py` 仅在 REST 合成路径调用，WS 实时流未触发 `viz:scene_init` |
| 3 | **AI 生成的 58 张 PNG 美术质量不佳** | 🟡 中 | Nano Banana 生成的 640×640 PNG 缩放至 32×48 后模糊/失真 |
| 4 | **修改代码后未通过 Chrome DevTools 实测** | 🟡 中 | 开发流程缺失视觉验收环节 |
| 5 | **Phaser 场景背景与 UI 美术风格不统一** | 🟡 中 | 场景/角色/UI 分批生成，缺乏统一调色板和风格约束 |
| 6 | **TitleScene 过于简陋** | 🟡 中 | 仅显示标题文字 + 渐变背景，无动画/交互 |

### Star-Office-UI 可借鉴要素

| 要素 | Star-Office-UI 做法 | SwarmOracle 适配方案 |
|------|---------------------|---------------------|
| 像素办公室分区 | 6 种 Agent 状态映射至办公室不同区域 | ✅ 已有立场站队 — 可增加 **区域标签 + 区域背景** |
| LimeZu 风格精灵 | 使用专业像素角色包（行走动画） | 重新生成更高质量的像素精灵，统一色调 |
| Phaser 直接渲染 | 原生 Phaser 场景管理 | ✅ 已有，可复用 |
| 实时状态轮询 | 定时 GET `/status` | ✅ 已有 WebSocket 更优 |
| 精简页面布局 | 单屏仪表盘，信息密度高 | 改进 SimulationView 布局，画布占主区 |

---

## 阶段规划

### Phase A: 动态场景 & 角色选择修复 (核心功能) ✅

> 解决问题 #1/#2 — 让竞技场根据用户问题动态选择场景和角色

**结论**: Phase A 功能已全部就绪，经代码审查确认：

- `simulator.py` 已实现 `viz:scene_init` WS 广播，含动态 `select_scene()` + `assign_sprites_batch()`
- 前端 `useSimulationWS` 已正确路由 `viz:*` → `EventBridge` → Phaser
- `VizSynthesizer` 已有完整关键词库 + 中文匹配（11 场景 + 18 角色）

---

### Phase B: 美术风格全面升级 ✅

> 解决问题 #3/#5/#6 — 使用 `.agents/skills` 中的技能进行系统级美术优化

#### B1: 统一风格指南 (使用 `teach-impeccable` skill) ✅

- ✅ 建立项目级设计语言：16 个 GBC 调色板 CSS custom properties (`game.css`)
- ✅ 确定像素风格约束：**GBC/GBA 风格**（而非 SNES），4 色或 16 色限制

#### B2: 重新生成全部资产 (使用 `colorize` + `bolder` skills) ✅

- ✅ 重新生成 18 张角色精灵 — 统一 GBC 调色板 + 清晰像素轮廓
- ✅ 重新生成 11 张场景背景 — 统一大气/光照风格
- ✅ 重新生成 6 张结局画面 — 更高戏剧性表现力
- ⏳ 重新生成 9 张 UI 组件 — 延后至 Phase C

#### B3: TitleScene 重做 (使用 `animate` + `delight` skills) ✅

- ✅ 新增打字机效果字幕逐字显示 + 闪烁光标
- ✅ 点击跳过交互（快速跳转 + 6s 自动过渡回退）
- ✅ 水平微光扫描线动画（Shimmer Scanline）
- ⏳ 背景音乐/音效提示 — 延后

#### B4: WorldScene 视觉增强 (使用 `polish` + `animate` skills) ✅

- ✅ 鼠标视差滚动（terrain + cloud 图层跟随指针位移）
- ⏳ 角色精灵 idle 摇摆动画 — 延后
- ✅ 对话气泡打字机效果（30ms/字逐字显现）
- ✅ 场景切换垂直擦除过渡（vertical wipe，替代简单闪光）

---

### Phase C: UI/UX 布局优化 + Theater Mode 完善 ✅

> 参考 Star-Office-UI 的单屏高信息密度布局

#### [MODIFY] SimulationView.tsx ✅

- ✅ 调整布局比例：Theater 当前改为“舞台优先”，右栏收成固定窄宽，`game-wrapper` 会优先出现在 replay filters / timeline 前
- ✅ 画布区域自适应容器尺寸（去除 max-width 960px）
- ✅ Agent 面板改为浮层（Theater 模式默认折叠）
- ✅ 新增 `simulation-view--theater` CSS 类，GBC 暗色主题全覆写

#### [MODIFY] game.css ✅

- ✅ 像素风边框（border-radius 12px → 4px，双层 box-shadow）
- ✅ CRT 扫描线增强（当前已回调到更轻的覆盖强度，避免压住小字号文字）
- ✅ Power LED 指示灯 + 呼吸动画
- ✅ HUD bar 统一 GBC 暗色调 + tabular-nums
- ✅ Bet bar 脉冲动画 + rank 变化闪光

#### [MODIFY] HudOverlay.tsx ✅

- ✅ 排行榜 rank 变化检测 + 翻牌动画（`hud-entry--animate`）
- ✅ 阵营 emoji 替换为 SVG 像素方块图标
- ✅ 统一像素风控件样式 — monospace + GBC 调色板

#### Theater Mode Bug 修复 ✅

- ✅ Bug 1-5: Agent 精灵不可见 / 全部相同 / 灰色背景 / 小地图不更新 / LLM JSON 错误
- ✅ Bug 6: 气泡不显示 — `synthesizeBubbles()` 改用 `msg.agent_id`（UUID）
- ✅ Bug 7: Agent 静止 + 气泡重叠 — 添加 idle wander + AABB 抗重叠堆叠
- ✅ Bug 8: 多轮气泡缺失 — 移除 `synthesizeBubbles` 60 条消息上限，全轮次回放（171 条）

---

### Phase D: 可靠性 & 测试强化

> 解决问题 #4 — 每次修改后必须通过浏览器实测验证

#### D1: 自动化视觉验证

- 每个 Phase 完成后使用 Chrome DevTools MCP 打开 `http://localhost:5173`
- 截图记录每个关键状态（标题画面 → 模拟中 → 结局）
- 对比截图确认视觉效果符合预期

#### D2: 现有测试回归

- 运行 `cd backend && python -m pytest tests/ -q`（708 tests）
- 运行 `cd frontend && npx vitest run`（128 tests）

#### 新增前端视觉回归测试

- WorldScene 场景主题切换测试
- Agent 动态生成和精灵分配测试
- 事件动画触发和清理测试

---

### Phase E: 代码审查 & 优化 (使用 `audit` + `optimize` + `harden` skills)

- 性能审计：Lighthouse 跑分 + Phaser 帧率监控
- 可访问性审计：ARIA 标签、键盘导航
- 错误边界强化：资产加载失败的优雅降级

---

## 实施优先级

```
Phase A (动态选择) ──→ Phase B (美术升级) ──→ Phase C (布局优化)
         ↓                    ↓                    ↓
     Phase D (实测)      Phase D (实测)       Phase D (实测)
                                                    ↓
                                              Phase E (审计)
```

| Phase | 预计工时 | 关键技能 |
|-------|---------|---------|
| A: 动态场景/角色 | ✅ 已完成 | 后端 WS 集成 |
| B: 美术全面升级 | ✅ 已完成 | `colorize`, `bolder`, `animate`, `polish` |
| C: UI/UX 布局 + Theater 完善 | ✅ 已完成 | `frontend-design`, `distill`, Chrome DevTools |
| D: 实测验证 | 贯穿 | Chrome DevTools MCP |
| E: 审计优化 | 1 天 | `audit`, `optimize`, `harden` |

---

## Verification Plan

### 自动化测试

```bash
# 后端回归 (708 tests)
cd /Users/yangjunjie/Desktop/upgrade-test/backend && python -m pytest tests/ -q

# 前端回归 (128 tests)
cd /Users/yangjunjie/Desktop/upgrade-test/frontend && npx vitest run
```

### 浏览器视觉验证

- 使用 Chrome DevTools MCP 导航到 `http://localhost:5173`
- 创建新模拟 → 验证场景自动匹配
- 验证 Agent 精灵分配与 persona 匹配
- 截图对比每个场景主题
- 录制事件动画播放过程

### 用户手动验证

1. 访问首页，输入不同类型的 What-If 问题：
   - 「如果罗马帝国没有灭亡？」→ 应选择 `ancient_empire` 场景
   - 「如果人工智能统治世界？」→ 应选择 `scifi_base` 场景
   - 「如果最高法院拥有暂停所有算法政策的紧急否决权？」→ 应选择 `modern_city` 场景
   - 「如果一则神谕成为整个奇幻王国唯一合法的统治依据？」→ 应选择 `fantasy_kingdom` 场景
   - 「如果全球最关键的海峡被一个海上商团永久垄断？」→ 应选择 `desert_outpost` 场景
   - 「如果跨大陆淡水供应在十年内枯竭？」→ 应选择 `desert_outpost` 场景
   - 「如果二战没有发生？」→ 应选择 `war_battlefield` 场景
2. 确认每次 Agent 精灵与 persona 匹配
3. 确认场景切换动画流畅
4. 确认标题画面有动画效果

> [!IMPORTANT]
> 每个 Phase 完成后需通过 Chrome DevTools 实际截图验证，不再允许"盲改"代码。
