[中文在前 / Chinese first](README.md) · [English first / 英文在前](README.en.md)

# SwarmOracle

用 AI 角色探索“如果……会怎样”。你可以阅读不同结局、核对发言依据，再追问角色或改写一次决定。SwarmOracle 开源，适合在本机或自己的服务器运行。

Explore “What if...?” with AI characters. Read different endings, check the statements behind them, then ask a follow-up or change a decision. SwarmOracle is open source and runs on your computer or your own server.

![中文配图：同一问题分成多条世界线的概念图 / Chinese illustration: Conceptual illustration of one question branching into several worldlines](docs/illustrations/worldlines.zh.webp)

*AI 生成概念插画：每条线代表一次模拟中的可能走向，并非产品截图。*

*AI-generated conceptual illustration: each line represents a possible path within a simulation. This is not a product screenshot.*

<details>
<summary>English illustration / 英文配图</summary>

![English illustration: Conceptual illustration of one question branching into several worldlines / 英文配图：同一问题分成多条世界线的概念图](docs/illustrations/worldlines.en.webp)

</details>

<a id="built-in-official-samples-and-snapshot-demo"></a>
<a id="内置官方样例与-snapshot-演示"></a>

## 先打开一个样例 / Open a sample first

启动前后端后，打开 http://127.0.0.1:18928 ，在首页选择一个官方样例。随附的 3 个样例无需 API Key，也不会调用模型；你可以先读结局、比较已有分支，再检查保存的证据。

After starting the backend and frontend, open http://127.0.0.1:18928 and choose an official sample on the home page. The three bundled samples need no API key and make no model calls. Start by reading an ending, comparing existing branches, and checking saved evidence.

已有的推演文件（Snapshot，扩展名为 `.swarm`）也可从首页导入。样例和快照让你浏览已有推演；生成新内容需要配置模型。逐步操作见[使用指南](docs/USAGE.md)。

You can also import a saved run, called a Snapshot, as a `.swarm` file from the home page. Samples and snapshots let you explore saved runs; generating new content requires a configured model. Follow the [usage guide](docs/USAGE.en.md) for the steps.

<a id="quick-start"></a>
<a id="快速开始"></a>
<a id="docker-compose"></a>

## 在本机启动 / Run locally

先下载并解压本仓库，或用下面的 Git 命令取得源码。后续命令都在下载后的 `Swarm-Oracle` 目录中运行。

Download and extract this repository, or clone it with Git below. Run the remaining commands inside the downloaded `Swarm-Oracle` folder.

```bash
git clone https://github.com/AGI-is-going-to-arrive/Swarm-Oracle.git
cd Swarm-Oracle
```

首次用 Docker Compose 启动时，在仓库根目录执行下面的命令。Windows/macOS 使用 Docker Desktop 的 Linux 容器模式；Linux 使用 Docker Engine 与 Compose 插件。

For a first Docker Compose start, run the commands below from the repository root. Use Docker Desktop in Linux-container mode on Windows/macOS, or Docker Engine with the Compose plugin on Linux.

macOS / Linux：

macOS / Linux:

```bash
test -f .env.docker || cp .env.docker.example .env.docker
docker compose config --quiet
docker compose up -d
```

Windows PowerShell：

Windows PowerShell:

```powershell
if (-not (Test-Path .env.docker)) { Copy-Item .env.docker.example .env.docker }
docker compose config --quiet
docker compose up -d
```

打开 http://127.0.0.1:18928 。默认只允许本机访问：前端端口 `18928`，后端端口 `18927`。需要使用当前源码构建镜像时，把最后一行换为 `docker compose up --build -d`。

Open http://127.0.0.1:18928. By default, only your computer can reach the frontend on port `18928` and backend on `18927`. To build images from the current source, replace the last line with `docker compose up --build -d`.

<a id="local-development"></a>
<a id="本地开发"></a>
<a id="public-deployment"></a>
<a id="公开部署"></a>

原生开发请按[后端启动说明](backend/README.md)和[前端启动说明](frontend/README.md)配置 Python、uv、Node 与 npm。升级旧 Docker 数据卷前，先阅读[备份与卷升级步骤](deploy/README.md#legacy-data-volume-upgrade)。公网或局域网部署请按[部署说明](deploy/README.md)设置会话、管理凭据与网络访问。

For native development, follow the [backend setup](backend/README.md) and [frontend setup](frontend/README.md) for Python, uv, Node, and npm. Before upgrading an old Docker volume, read the [backup and volume-upgrade steps](deploy/README.md#legacy-data-volume-upgrade). For LAN or public access, configure sessions, admin credentials, and network exposure using the [deployment guide](deploy/README.md).

<a id="live-llm-runs"></a>
<a id="实时-llm-推演"></a>

## 再试自己的问题 / Try your own question

1. 打开 `/admin/setup`，填写模型连接，测试后保存。也可使用服务端默认模型，或首页的 **BYOK**（本次自带模型连接）区为本次运行填写连接。<br>
   Open `/admin/setup`, enter a model connection, test it, and save it. You can also use the server default or enter a connection for one run in the home page’s **BYOK** (bring your own model connection) section.

2. 输入问题，设置角色数量和轮数，点“开始推演”后核对启动摘要。辩论有单独的固定规模和启动确认。<br>
   Enter a question, choose the number of characters and rounds, then select **Start Simulation** and review the launch summary. Debate uses its own fixed format and launch review.

3. 在结果页按“核对依据”“追问角色”“尝试改变”继续。**比较已有分支**读取现有结果；**改写一轮并重演**会用模型创建新分支。<br>
   On the result page, continue through **Check the evidence**, **Ask the characters**, or **Try a different decision**. **Compare existing branches** reads saved results; **Rewrite a turn and replay** uses a model to create a new branch.

浏览官方样例和只读回放不会发起模型调用。新推演、追问、重演、预测评分和完整分析可能产生模型费用。评分恢复行为见[使用指南](docs/USAGE.md)，模型连接和推理力度见[配置说明](docs/CONFIGURATION.md)。

Browsing official samples and read-only replay makes no model calls. New simulations, follow-ups, reruns, prediction scoring, and full analyses may incur model costs. See [usage](docs/USAGE.en.md) for scoring recovery and [configuration](docs/CONFIGURATION.en.md) for model connections and reasoning effort.

<a id="w21-visibility-and-truth-boundaries"></a>
<a id="w21-可见性与真值边界"></a>

## 怎样理解结果 / How to read the result

分支占比是模拟权重，不是真实事件的概率。角色提出方案、各方采纳方案、方案得到执行是不同状态；报告会保留证据不足、部分完成和静态回退等标签。模型叙述与模拟状态是否一致，仍需核对。

Branch shares are simulation weights, not probabilities of real events. A proposal, its adoption, and its execution are different states. Reports retain labels for limited evidence, partial output, and static fallback. You still need to check whether the narrative matches the simulation state.

把输出用于探索假设，它不构成事实证明。功能范围见[功能指南](docs/FEATURES.md)，数据与凭据边界见[安全说明](SECURITY.md)。

Use the output to explore assumptions; it does not establish facts. Read the [feature guide](docs/FEATURES.en.md) for scope and the [security guide](SECURITY.md) for data and credential boundaries.

<a id="documentation"></a>
<a id="文档"></a>
<a id="stack-and-license"></a>
<a id="技术栈与许可证"></a>

## 继续阅读 / Read more

| 中文 / Chinese | English / 英文 |
| --- | --- |
| [使用指南](docs/USAGE.md)：从样例到追问、比较和分享。 | [Usage guide](docs/USAGE.en.md): samples, follow-ups, comparison, and sharing. |
| [功能指南](docs/FEATURES.md)：根据你想做的事找入口。 | [Feature guide](docs/FEATURES.en.md): find a tool by the task you want to do. |
| [配置说明](docs/CONFIGURATION.md) · [部署与备份](deploy/README.md) | [Configuration](docs/CONFIGURATION.en.md) · [Deployment and backups](deploy/README.md) |
| [贡献指南](CONTRIBUTING.md) · [安全说明](SECURITY.md) · [变更记录](CHANGELOG.md) | [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) |
| [介绍页](https://agi-is-going-to-arrive.github.io/Swarm-Oracle/) · [中文介绍视频](https://www.bilibili.com/video/BV1Xh7168ECc) | [Showcase](https://agi-is-going-to-arrive.github.io/Swarm-Oracle/) · [Chinese introduction video](https://www.bilibili.com/video/BV1Xh7168ECc) |

界面截图参考：[中文首页](docs/screenshots/01-home.png) · [英文首页](docs/screenshots-en/01-home.png)。这些是产品截图，具体控件以当前版本为准。

UI screenshot references: [Chinese home page](docs/screenshots/01-home.png) · [English home page](docs/screenshots-en/01-home.png). These are product screenshots; consult the current app for its controls.

后端使用 FastAPI、SQLModel、SQLite 和 ChromaDB；前端使用 React、TypeScript、Phaser 和 Vite。许可证：[GNU AGPL-3.0](LICENSE)。

The backend uses FastAPI, SQLModel, SQLite, and ChromaDB; the frontend uses React, TypeScript, Phaser, and Vite. License: [GNU AGPL-3.0](LICENSE).
