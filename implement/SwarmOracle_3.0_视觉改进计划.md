# SwarmOracle 3.0 — 全面视觉改进计划

> 文档类型：historical snapshot
> 当前真值：否
> 阅读方式：本文件保留 3.0 视觉改进的历史规划与验收基线；正文已改为“已解决问题 + 当前视觉基线 + 仍可继续优化的方向”，不再保留旧的待实施口吻、旧测试数字或已失效的问题清单。当前请以 `README.md`、`implement/README.md`、`llmdoc/*` 为准。

## 1. 文档定位

这份文档最初用于推动 3.0 视觉升级。当前它的作用已经变成：

- 记录 3.0 视觉线原本想解决什么
- 说明这些问题今天在当前产品里如何落地
- 给后续仍想继续做视觉升级的人保留一套不跑偏的设计边界

因此，后文不再使用“Phase D / E 仍待执行”的语气，而改成：

1. 原始问题今天的处理结果
2. 当前视觉系统已经固定下来的基线
3. 未来仍值得做的增量优化

## 2. 3.0 原始问题与当前处理结果

### 2.1 动态场景与角色选择

原始目标：

- 场景根据题面动态切换
- 角色根据 persona / role 动态分配

当前状态：

- 该问题已解决并并入当前产品基线。
- 后端 `scene_selector` 与前端 `VizSynthesizer` 已按题面语义选择场景。
- 当前 Theater / Debate 共有 33 个 registry 条目：
  - 30 个 Theater 语义背景
  - 3 个 Debate 专属背景
- 角色 sprite 运行时清单已扩到 25 张，并完成前后端 persona / role 映射收口。

### 2.2 美术风格统一

原始目标：

- 解决“背景、角色、UI 风格不统一”
- 用更清晰的像素美术替换早期粗糙资产

当前状态：

- 该问题已解决到“产品可交付”级别。
- 当前视觉语言已经固定为：
  - GBC 像素风
  - 暗色 Theater
  - 页面仍保持现代可读性
- 主题、badge、frame、Debate UI 资产都已统一进入 `themeRegistry.ts` 和资产 sidecar 体系。
- 资产库存与来源说明当前以 `frontend/public/assets/ASSET_CREDITS.md` 为准。

### 2.3 TitleScene / WorldScene 视觉增强

原始目标：

- 让 TitleScene 不再过于简陋
- 提升 WorldScene 的场景表现和可读性

当前状态：

- TitleScene 与 WorldScene 的增强已并入当前产品基线：
  - TitleScene：打字机字幕、点击跳过、扫描线效果
  - WorldScene：视差、气泡打字机、场景切换过渡
- Theater 还额外完成了一轮可读性收口：
  - 舞台优先布局
  - 上下 chrome 压缩
  - 气泡字体放大、描边与分辨率提高

### 2.4 Theater 稳定性与视觉验证

原始目标：

- 修复 Theater bug
- 强制每次视觉改动都经过浏览器实测

当前状态：

- 这条线已经不是“是否存在验证”，而是“验证是否持续收口”的问题。
- 当前产品已有：
  - `render_game_to_text()`
  - `advanceTime(ms)`
  - `capture_game_screenshot()`
  - `e2e:corners / cross-browser / safari / full`
  - `e2e:debate:*`
  - `release:signoff`
- 当前 `HEAD` 已通过一轮完整 `release:signoff`：
  - 工件：`frontend/output/e2e/20260320-codex-live-signoff/summary.json`

## 3. 当前视觉系统基线

### 3.1 风格基线

- GBC 调色板统一
- Pixel Theater 与页面 UI 同属一套视觉语言
- Debate Arena 不另造一套电竞 UI，而在同一剧场语言内扩展

### 3.2 资产基线

- 主题条目：33 个
- 运行时 sprite：25 张
- PNG sidecar：62/62 完整
- Debate 新资产已并入同一 provenance 体系

### 3.3 加载与性能基线

- Theater 只在用户真正进入 Theater 后再预热 Phaser
- `BootScene` 当前只预载首屏初始 theme + 角色 sprite
- `scene_change` 背景与 `EndingScene` 大图按需补载
- screenshot / GIF runtime 已拆分，避免把 capture 依赖重新拖回首包

### 3.4 当前验证基线

- Historical full baseline：
  - backend `815 passed`
  - frontend `179 passed`
- Current targeted verification：
  - backend targeted set `82 passed`
  - frontend targeted set `79 passed`
- Current release signoff：
  - `frontend/output/e2e/20260320-codex-live-signoff/summary.json`

## 4. 这条线今天还值得继续做什么

这些工作仍然有价值，但已经属于增量优化，而不是 3.0 核心能力未完成：

### 4.1 包体与首次进入成本

- 继续压缩 `phaser` 大包
- 继续收紧 Theater 首次进入路径
- 优先优化加载时机，而不是重做页面布局

### 4.2 Safari / WebKit 视觉边界

- 继续处理 Safari / WebKit 截图链路的取证边界
- 继续把“面板可见性取证”和“画布截图取证”分开维护

### 4.3 主题与资产丰富度

- 在不破坏现有 GBC 视觉语言的前提下扩主题
- 扩新资产时同步 sidecar 和 `ASSET_CREDITS.md`
- 不再回到“这批资产是否已经接入”的不确定状态

### 4.4 自动化视觉签收

- 继续把视觉回归纳入 `release:signoff`
- 对新的视觉改动，优先补工件和签收路径，而不是只补截图说明

## 5. 已失效的旧口径

以下口径不应继续从这份文档里引用：

- “当前还有多个核心视觉 bug 未修”
- “前端是 128 tests / 后端是 708 tests 的当前口径”
- “Phase D / E 仍然是待执行主计划”
- 任何把这里的旧问题表继续当作当前待办的读法

## 6. 设计边界仍然有效的部分

虽然本文件不再是当前真值，但以下约束仍然有效：

- 不要把产品拉成独立电竞 UI
- 不要另起一套与 Theater 割裂的视觉系统
- 不要为了像素感牺牲信息可读性
- 新增视觉资产要纳入统一 registry 与 provenance 体系

## 7. 当前结论

3.0 视觉线今天已经完成了“从概念升级到当前可交付视觉基线”的目标。

后续继续做这条线时，重点不再是“把 3.0 做出来”，而是：

- 把当前视觉基线继续打磨得更稳
- 把性能、Safari 边界和资产覆盖做得更完整
- 在不破坏现有风格的前提下持续扩展
