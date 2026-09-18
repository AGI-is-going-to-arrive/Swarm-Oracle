# Phaser 自定义入口 / Custom Phaser entry

这个目录最初用于缩小 Theater 引擎体积。当前主线 Vite、Vitest 和实验配置都复用 `entry.mjs`；修改它会影响正式网页中的 Pixel Theater。

This directory began as an experiment to reduce the Theater engine bundle. The main Vite and Vitest configurations now share `entry.mjs` with the experiment. Changes affect Pixel Theater in the shipped app.

![页面、可视化和后端的关系](../../../docs/illustrations/architecture.zh.webp)

*Theater 按需加载，自定义入口属于主线运行路径。*

<details>
<summary>English illustration / 英文配图</summary>

![Relationship between pages, visualization, and the backend](../../../docs/illustrations/architecture.en.webp)

*Theater loads on demand; the custom entry is part of the main runtime.*

</details>

## 文件用途 / Files

| 文件 / File | 用途 / Purpose |
| --- | --- |
| `entry.mjs` | 基于 `phaser-core`，补上 Theater 使用的 Math、Loader.Events、Container 和 Rectangle。 / Starts from `phaser-core` and adds the Math, Loader.Events, Container, and Rectangle APIs used by Theater. |
| `global-shim.mjs` | 在载入 Phaser 前准备全局兼容变量。 / Prepares global compatibility values before loading Phaser. |
| `phaser3spectorjs-stub.cjs` | 主线和实验共用的调试依赖替身。 / Debug-dependency stub shared by the main app and experiment. |
| `vite.config.ts` | 复用主线配置与 alias，实验产物写入 `dist-spikes/phaser-custom`。 / Reuses the main configuration and aliases, writing experiment output to `dist-spikes/phaser-custom`. |
| `vitest.config.ts` | 复用主线测试配置与同一入口。 / Reuses the main test configuration and entry. |
| `entry.cjs` | 旧入口；当前主线和实验 alias 都指向 `entry.mjs`。 / Older entry; current main and experimental aliases point to `entry.mjs`. |

## 验证方式 / Verification

按[前端说明](../../README.md)安装锁定依赖，再从仓库根目录运行：

Install locked dependencies using the [frontend guide](../../README.md), then run from the repository root:

```bash
cd frontend
npx --yes npm@11.12.1 exec -- tsc -b
npx --yes npm@11.12.1 run test:spike:phaser-custom
npx --yes npm@11.12.1 run build
```

PowerShell 可使用 `npx.cmd`。这些是复验命令，不是当前提交的通过声明；不要把旧文档中的测试数量当成新结果。

PowerShell may use `npx.cmd`. These are reproduction commands, not a pass claim for the current commit. Do not reuse an old document's test count as a new result.

新增 Phaser API 前先确认真实调用点，并补浏览器检查。检查 Theater 开关、Replay 同步、手机和短屏的 16:9 舞台、文字记录入口和 PNG 捕获；单元测试不证明 Canvas 渲染或截图成功。

Before adding a Phaser API, locate the real caller and add browser checks. Cover opening and closing Theater, Replay synchronization, the 16:9 stage on phones and short screens, text records, and PNG capture. Unit tests do not prove Canvas rendering or successful capture.
