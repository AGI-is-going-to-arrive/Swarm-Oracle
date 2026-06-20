[English](README.en.md) | 中文

# 🔮 SwarmOracle

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![CI](https://github.com/AGI-is-going-to-arrive/Swarm-Oracle/actions/workflows/ci.yml/badge.svg)](https://github.com/AGI-is-going-to-arrive/Swarm-Oracle/actions/workflows/ci.yml)
[![Docker Compose](https://img.shields.io/badge/Docker%20Compose-ready-2496ED?logo=docker)](docker-compose.yml)
[![GHCR](https://img.shields.io/badge/GHCR-workflow-24292f?logo=github)](.github/workflows/ghcr.yml)

> AI "What-If" Prediction Playground - 群体预言机

SwarmOracle 让你提出假设性问题（"如果……会怎样？"），由 AI 代理群体模拟多条故事线，展示不同可能性。旗舰示例场景是：**如果郑和比哥伦布先发现了美洲大陆**。

![SwarmOracle 首页](docs/screenshots/01-home.png)

社交预览使用仓库内已存在的截图和在线介绍页素材；首屏 GIF 尚未提交，后续应由浏览器 lane 录制并在确认真实文件后再引用。

## 在线介绍页 / Live Demo

打开就能看完整截图和一段介绍视频：**https://agi-is-going-to-arrive.github.io/Swarm-Oracle/**

也可以直接在 B 站看中文介绍视频：**https://www.bilibili.com/video/BV1Xh7168ECc**

## 功能亮点

- **多分支推演**：一个问题，多条故事线，看不同结局
- **Pixel Theater + 导演/玩法卡**：用像素剧场观看推演，并用 14 张导演/玩法卡改变当前世界线节奏
- **辩论竞技场**：AI 正反方激辩，帮你看清争议的两面
- **神谕密室**：与当前世界线里的 AI 角色深度对话，追问细节
- **世界线圆桌**：多方代表圆桌讨论，完成后可回到已保存结果并继续 Deep Dive
- **反事实对比**："如果那句话说得不同，世界线会怎么变？"
- **因果图谱 + 知识图谱**：从结果页进入图谱工作台、知识图谱浏览器和时间线星系
- **自定义 Agent**：在 Agent 工坊里创建、导入、导出你自己的角色
- **预测日志与排行榜**：记录预测、复盘校准，也能看全局排行榜
- **Snapshot 导入 / 导出**：把一次推演打包保存，之后再导入继续查看
- **完整报告与证据回放**：结果页可生成独立报告，证据能跳回 replay，正文支持表格等 Markdown 内容
- **模型配置与自带 LLM**：兼容任何 OpenAI 格式的 API，可保存带限速、并发、能力覆盖和原生搜索上游声明的 profile 后在首页和辩论里直接选择

> 每种玩法的具体用法见 **[使用指南 docs/USAGE.md](docs/USAGE.md)**；逐项功能图鉴见 **[FEATURES.md](docs/FEATURES.md)**。默认功能基本开箱可用；搜索增强和来源复选框需要额外配置，详见 **[配置说明 docs/CONFIGURATION.md](docs/CONFIGURATION.md)**。

## 玩起来什么样

提一个问题，看一群 AI 推演出好几条故事线，拿到结论，再进各种房间接着追问。

| 推演中：分支实时长出来 | 结果：直接回答你的问题 |
|:---:|:---:|
| ![推演中](docs/screenshots/21-simulation.png) | ![结果页](docs/screenshots/02-result.png) |
| **辩论竞技场：正反方开杠** | **因果图谱：看清来龙去脉** |
| ![辩论竞技场](docs/screenshots/20-debate-arena.png) | ![因果图谱](docs/screenshots/06-causal-map.png) |

## 安装阶梯

### Tier 1：公共 Gallery

占位入口，F1 完成后激活。当前请使用在线介绍页查看截图和视频，或使用下面的 Tier 2 / Tier 3 本地方式。

### Tier 2：零密钥 Demo

导入 `samples/snapshots/` 下的 sanitized snapshot 即可查看离线演示，不需要 LLM API。示例场景包含 **如果郑和比哥伦布先发现了美洲大陆**，当前样本文件为 `samples/snapshots/*.swarm`；通过页面的 Snapshot 导入入口加载。

### Tier 3：BYOK 完整运行

配置你自己的 OpenAI-compatible LLM 服务后运行完整推演。Docker 和本地开发都使用同一组核心配置项；也可以在 `/admin/setup` 保存模型 profile，记录 Base URL、模型、key、限速、并发、结构化输出 / 原生搜索能力覆盖和原生搜索上游声明，之后首页会把带 key 的 profile 当作已配置 LLM 来使用，并可复用到主推演和辩论。开始或辩论按钮不可用时会在按钮下方说明原因，例如缺少问题、未配置 LLM 或本轮预算被 RPM/TPM 挡住；首页启动确认会使用输入框当前已提交文本，中文等输入法组词未确认时不会误触发。自动启动前只做轻量 LLM 预检，不跑 provider 并发压测；测试连接会把普通连通性、完整 provider probe 和模型原生搜索探测分开显示。已知官方 provider 的裸 `/v1` Base URL 会在运行时按 Responses 形态尝试原生工具注入，但不会回显完整派生 URL。如果本地代理实际转发到 xAI / OpenAI Responses 上游，仍需要在 profile 里显式声明对应上游，系统才会按官方 native-search adapter 注入工具。若后续需要 LLM 的路径无法恢复原 profile，会要求重新选择或提供完整的 key / Base URL / 模型，不会静默换到其它凭据。

## 快速开始

### 运行要求

最低浏览器要求：Chrome/Edge >= 111、Firefox >= 113、Safari/iOS >= 16.2（支持 oklch / color-mix 的现代浏览器）。

### Docker 一键部署（推荐）

1. 复制 Docker 配置模板：

   macOS / Linux:
   ```bash
   cp .env.docker.example .env.docker
   ```

   Windows PowerShell:
   ```powershell
   Copy-Item .env.docker.example .env.docker
   ```

2. 编辑 `.env.docker`，填入你的 LLM API 信息。`.env.docker` 未提交时，Compose 仍能依靠 `docker-compose.yml` 的服务默认值启动；LLM 会回落到后端内置默认值：

   macOS / Linux:
   ```bash
   ${EDITOR:-vi} .env.docker
   ```

   Windows PowerShell:
   ```powershell
   notepad .env.docker
   ```

   Docker Compose 默认只把前端和后端端口绑定到 `127.0.0.1`。如果不是只在本机访问，必须显式修改 `docker-compose.yml` 的 `ports` 绑定（例如把前端改成 `18928:80`），并在 `.env.docker` 中设置 `ENV=production`、`SESSION_SECRET` 和 `ADMIN_TOKEN`。`SESSION_SECRET` 保护普通 REST / WebSocket 访问；`ADMIN_TOKEN` 保护 `/api/admin/*`；`/metrics` 在设置 `ADMIN_TOKEN` 时接受 `X-Admin-Token`，在设置 `SESSION_SECRET` 时也接受 `X-Session-Token`。

3. 启动：

   macOS / Linux:
   ```bash
   docker compose up -d
   ```

   Windows PowerShell:
   ```powershell
   docker compose up -d
   ```

4. 打开浏览器访问 http://localhost:18928

Docker 默认把前端映射到 `127.0.0.1:18928`，后端映射到 `127.0.0.1:18927`。前端容器会代理 `/api` 和 `/ws` 到后端，因此公开部署时不能只暴露前端端口而继续留空鉴权密钥。GHCR 镜像发布后，Compose 会优先使用 `image:` 指向的 backend/frontend 镜像，并保留 `build:` 作为本地回退。要强制从源码构建，运行 `docker compose up --build -d`。

### 本地开发

后端（Python 3.11+，macOS/Linux）：

macOS / Linux:
```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp ../.env.example .env
uvicorn app.main:app --host 127.0.0.1 --port 18927 --reload
```

Windows PowerShell:
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
Copy-Item ..\.env.example .env
uvicorn app.main:app --host 127.0.0.1 --port 18927 --reload
```

`.env.example` 里的 `your-api-key-here` 只是占位值。只要 `LLM_RESPONSES_URL` 不是本地地址，后端会拒绝继续使用占位 key。

前端（Node.js 20+）：

macOS / Linux:
```bash
cd frontend
npm install
npm run dev
```

Windows PowerShell:
```powershell
cd frontend
npm install
npm run dev
```

打开 http://localhost:18928 即可使用。

> 前置条件：本地开发时请**先确保后端已在 18927 运行**，前端会把 `/api` 与 `/ws` 请求转发给它，否则页面会一直等待或报错。

## 配置说明

核心配置在 `.env.example`（本地开发）或 `.env.docker`（Docker 部署）中：

| 配置项 | 说明 | 示例 |
|--------|------|------|
| `LLM_RESPONSES_URL` | LLM 服务地址 | `https://api.openai.com/v1` |
| `LLM_API_KEY` | API 密钥 | `sk-...` |
| `LLM_MODEL_NAME` | 模型名称 | `gpt-5.5` / `deepseek-v4-pro` / `gemini-3.5-flash` / `claude-opus-4-8` |
| `ENABLE_WEB_SEARCH` | 搜索增强（可选） | `false` |
| `WEB_SEARCH_PROVIDER` | 搜索服务商（开启搜索时） | `tavily` / `exa` / `firecrawl` / `xai` / `searxng` |

完整配置项、功能开关清单和搜索增强说明见 **[配置说明 docs/CONFIGURATION.md](docs/CONFIGURATION.md)**。自定义 Agent、跨场景身份、因果图谱、图谱分析、阵营关系、论点地图、知识图谱浏览器、时间线星系、回放轨迹、圆桌 Deep Dive、snapshot、预测日志、教学模板、人物备份和完整报告在模板里默认开启。`ENABLE_WEB_SEARCH`、`FEATURE_NEW_SOURCES`、`FEATURE_FAMILY_QUERY_OPTIMIZATION` 默认关闭，因为它们需要搜索 provider 和对应配置。

Docker Compose 会读取 `.env.docker`（如果存在），并把数据库和 Chroma 数据放到 `/data` volume。普通本地开发读取 `backend/.env`。

首页 scenario 问题、辩论题目、分享挑战和模板/场景包导入链路都按 2000 字符上限收口。前端会在可控入口截断或限制输入，后端 schema 仍会拒绝超长请求。

## 迁移策略

数据库迁移 owner 保持为后端 `init_db()`。FastAPI lifespan 负责启动时 stamp/upgrade 到 head；镜像 entrypoint、Compose command 和发布脚本不新增 `alembic upgrade head`。除非后续单独批准迁移策略变更，否则 entrypoint Alembic 保持冻结。

## 项目结构

```text
SwarmOracle/
├── backend/          # FastAPI 后端 (Python)
├── frontend/         # React + Phaser 前端 (TypeScript)
├── docker-compose.yml
├── .env.example      # 本地开发配置模板
└── .env.docker       # Docker 部署本地配置，默认不提交
```

## 贡献与内容政策

贡献流程、测试门禁和内容政策见 **[CONTRIBUTING.md](CONTRIBUTING.md)**。SwarmOracle 面向 AI 生成的假设性推演和 speculative fiction；请避免真实个人诽谤、骚扰、隐私泄露、仿冒身份、违法指导和把生成内容包装成事实新闻。

## 技术栈

- **后端**: FastAPI + SQLite + ChromaDB
- **前端**: React 19 + TypeScript + Phaser 3
- **部署**: Docker Compose + GHCR 镜像（发布 workflow）

## 致谢

感谢 [Linux.do](https://linux.do/) 社区的反馈与支持。

## License

SwarmOracle 使用 **[GNU Affero General Public License v3.0](LICENSE)**。
