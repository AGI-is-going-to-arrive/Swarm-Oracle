# SwarmOracle — 下一轮玩法 / 美术 / 回放执行文档

> 文档类型：superseded archive
> 当前真值：否
> 阅读方式：本文件保留“玩法 / 美术 / 回放”这一条线的历史执行思路，但正文已改为归档基线，不再保留旧数量、旧 authority 或旧 TODO 口径。当前请优先阅读 `implement/README.md`、`implement/19_four_track_execution_plan.md`、`implement/22_cross_device_state_closure_plan.md`、仓库根 `README.md` 与 `llmdoc/*`。

## 1. 文档定位

这份文档最初是“下一轮继续做什么”的执行手册。当前它的作用已经变成：

- 保留这条线当时关注的主题：
  - 玩法系统深化
  - 像素美术资产持续扩充
  - Theater 回放与截图体验打磨
- 说明这条线有哪些能力已经并入当前产品基线
- 说明这条线剩下的工作属于 polish / 工程优化，而不是核心功能缺失

因此，后文不再使用“下一次必须做”的计划语气，而只保留：

1. 当前仍然成立的事实
2. 当前仍然成立的设计约束
3. 这条线在今天还值得继续推进的增量方向

## 2. 当前已并入产品基线的事实

### 2.1 玩法层

- 结构化押注已是产品基线：
  - `押世界线`
  - `押结局倾向`
  - `押题材回响`
- 玩法卡已不是 10 张的早期形态，而是当前 14 张基线：
  - 10 张导演卡
  - 4 张反制卡：`审计清算 / 情报反噬 / 民意回摆 / 停火委员会`
- 玩法卡会按题材画像动态推荐，并携带：
  - 题材 hooks
  - 三段式题材连锁事件
  - `风险 / 资源` 轨道
  - profile-specific 打法说明
- Director goals / worldline commitment 与主模式 `cards.usage_log / betting.bets / archive.key_moments / archive.branch_snapshots` 当前都以后端 authority 为准：
  - `Scenario.director_state_json`
  - `Scenario.gameplay_state_json`
- `scenarioMeta` 仍存在，但只作为兼容/缓存层与 replay payload 输入，不再承担跨设备真值职责。

### 2.2 结果与档案层

- ResultView 当前会稳定展示：
  - 玩法记录
  - 下注记录
  - key moments
  - branch snapshots
  - `most_used_card`
  - `betting_hit`
  - `archive_grade`
  - `dominant_branch_title`
  - `dominant_tone`
  - `director_style_tag`
  - `profile_resonance`
  - director goals / commitment outcome
  - 最终 `风险 / 资源` 轨道
- 导出 Markdown 与分享文案会带题材档案前缀。
- Daily challenge 当前已扩到 12 条题材池，并且与后端 `daily-status` / `weekly-summary` 共同构成首页真值显示。

### 2.3 回放与截图层

- 主模式与 Debate 都已经有 replay 页面：
  - `/sim/replay`
  - `/result/replay`
  - `/debate/replay/result`
- replay 不是实验功能，而是当前产品基线：
  - 支持 replay token
  - 主模式优先走后端 `ReplayArtifact` 短 `share id`
  - 支持“导入为本地运行”
- Theater 完成态支持：
  - 按世界线回放
  - 按轮次回放
  - `重播 / 跳到最新 / 倍速`
  - `fork / card / bet / result` marker
- 截图模式当前以三种显式模式为准：
  - `Panel`
  - `Canvas`
  - `Modal`
- `e2e-suite.mjs` 与 `e2e-debate-suite.mjs` 会在输出目录落盘 `browser-launch.json`，便于审计浏览器启动 profile。

### 2.4 美术资产层

- 当前美术资产不再以这份文档里的“待生成清单”为准，而以：
  - `frontend/public/assets/ASSET_CREDITS.md`
  - `frontend/public/assets/ui/generated`
  - `frontend/public/assets/scenes`
  为准。
- 当前资产口径：
  - Theater / Debate 主题共 33 个 registry 条目
  - 角色 sprite 已接入 25 张运行时清单
  - `frontend/public/assets/ui/generated + frontend/public/assets/scenes` 下 62 张 PNG 均有 sidecar
- 资产扩充必须继续保持当前 GBC 像素风和 Theater 视觉语言，不能另起一套设计系统。

### 2.5 当前验证口径

- Historical full baseline：
  - backend `815 passed`
  - frontend `179 passed`
- Current targeted verification：
  - backend targeted set `82 passed`
  - frontend targeted set `79 passed`
- Current release signoff：
  - 当前 `HEAD` 已通过一轮完整 `release:signoff`
  - 工件：`frontend/output/e2e/20260320-codex-live-signoff/summary.json`

## 3. 这条线留下来的有效设计约束

### 3.1 风格约束

- 保持当前项目的视觉语言，不要改成另一套设计系统。
- 继续沿用：
  - 温暖纸面 / 暗色 Theater
  - GBC 像素风
  - 现代可读性优先，而不是为了像素感牺牲信息密度
- 不要做：
  - 玻璃拟态泛滥
  - 赛博蓝紫霓虹重做
  - 与现有字体和配色脱节的新主页

### 3.2 玩法与资产联动约束

- 扩新玩法时，优先更新 shared contract 与当前题材画像口径，不要在前后端分别维护第二事实源。
- 扩新素材时，优先更新 `ASSET_CREDITS.md` 与对应 sidecar，而不是在这份归档文档里手工维护待生成列表。
- 新增玩法或新题材前，优先补自动化工件与签收路径，而不是先扩视觉花样。

### 3.3 回放与截图约束

- 主模式 replay 与 Debate replay 现在都已经是产品合同的一部分，后续只能增量打磨，不应再回退到“只是一组脚本辅助能力”的理解。
- 截图 / GIF 路径应继续保持按需加载，避免把 capture 依赖重新拉回首页或 Theater 首包。

## 4. 今天继续做这条线时，真正值得做的增量方向

这些不是“缺失功能”，而是仍然值得投入的增量优化：

### 4.1 Theater / capture polish

- 继续收敛 GIF 录制模式语义
- 继续补复杂 modal 截图 smoke
- 继续处理 Safari / WebKit 下的截图边界

### 4.2 性能与首屏体验

- 继续压缩 `phaser` 大包和 Theater 首次进入成本
- 继续缩短 parser → 首批 agent 可见时间
- 重点放在加载时机和异步 chunk，而不是重做 warmup UI

### 4.3 玩法与美术丰富度

- 在不破坏现有美术语言的前提下继续补更广的题材覆盖
- 在 shared contract 真值不分裂的前提下扩展玩法卡和画像说明
- 对外观扩充的验收，以自动化工件和 `ASSET_CREDITS.md` 为准

## 5. 已失效的旧口径

以下口径在这份文档里已经失效，不应继续引用：

- “当前玩法卡共 10 张”
- “玩法状态持久化在前端本地存储”
- “待生成的玩法卡框 / 徽章仍以本文件素材清单为准”
- 任何把 `175 passed`、早期 `815 passed` 写成“当前签收口径”的说法
- 任何把本文件继续当作“下一轮执行入口”的读法

## 6. 推荐读法

- 当前产品范围与签收状态：
  - `README.md`
- 当前实现归档索引：
  - `implement/README.md`
- 当前四轨设计基线：
  - `implement/19_four_track_execution_plan.md`
- 当前跨设备 authority 收口：
  - `implement/22_cross_device_state_closure_plan.md`
- 当前资产清单与来源：
  - `frontend/public/assets/ASSET_CREDITS.md`

## 7. 当前结论

这条线已经不是“产品里有没有玩法、有没有回放、有没有像素资产”的问题，而是：

- 是否继续把玩法与资产做得更丰富
- 是否继续把 Theater 首屏与截图体验打磨得更稳
- 是否继续在当前视觉语言里做增量，而不是重新发明第二套产品

换句话说，这份文档今天保留的价值是“告诉你这条线还可以往哪里做深”，而不是“告诉你产品还缺哪些基础能力”。
