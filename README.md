[English](README.en.md) | 中文

# 🔮 SwarmOracle

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![CI](https://github.com/AGI-is-going-to-arrive/Swarm-Oracle/actions/workflows/ci.yml/badge.svg)](https://github.com/AGI-is-going-to-arrive/Swarm-Oracle/actions/workflows/ci.yml)
[![Docker Compose](https://img.shields.io/badge/Docker%20Compose-ready-2496ED?logo=docker)](docker-compose.yml)

SwarmOracle 是一个开源、自托管的 AI 假设推演游乐场。你提出“如果……会怎样？”，一组 AI Agent 推演多条世界线，结果页给出结论、终局概率和可继续追问的入口。

![SwarmOracle 首页](docs/screenshots/01-home.png)

静态介绍页（截图与视频）：https://agi-is-going-to-arrive.github.io/Swarm-Oracle/
中文介绍视频：https://www.bilibili.com/video/BV1Xh7168ECc

## 能做什么

- 多分支推演、Classic 分支树与 Pixel Theater
- 玩法卡、预测押注、世界线承诺和赛后因果档案
- 辩论竞技场、结局会客厅和世界线圆桌
- 反事实续跑、分支对比、Replay Trace
- 因果图谱、知识图谱与时间线视图
- 推演内 Agent 档案、分支记忆、自定义 Agent、人物备份、预测日志与 Snapshot
- 结果结论、完整报告、分享卡片与可选搜索增强

推演内的 Agent 档案会区分配置立场与已观察情绪，并标明观察来自哪条世界线、哪一轮；回放中没有匹配观察时会明确提示。

类别级能力与路由见 [功能索引](docs/FEATURES.md)，操作步骤见 [使用指南](docs/USAGE.md)。

## 两种使用方式

### 内置官方样例与 Snapshot 演示

真实 LLM 未配置时，前后端仍可启动。首页提供 3 个随附的官方样例：无需 API Key、无需选择文件，也不会发起模型调用，任选一个即可导入完整推演并浏览结果、回放和关联视图。你也可以继续导入 `samples/snapshots/` 中脱敏的 `*.swarm` 文件。内置样例和 Snapshot 导入不能生成新的实时推演。

### 实时 LLM 推演

新建推演、辩论、会客厅和报告需要可用的 OpenAI-compatible LLM。你可以：

- 在 `backend/.env` 或 `.env.docker` 配置服务端默认模型；或
- 启动后打开 `/admin/setup`，测试连接并保存带 key 的 model profile；或
- 在首页独立的 **BYOK** 折叠区为本轮提供连接信息。

首页的 **高级设置** 与 **BYOK** 是两个独立折叠区。公开默认值以 [`.env.example`](.env.example) 为准，不以某台开发机的 `backend/.env` 为准。

## 快速开始

### Docker Compose

```bash
cp .env.docker.example .env.docker
docker compose up -d
```

打开 http://127.0.0.1:18928 。默认端口只发布到 loopback：前端 `18928`，后端 `18927`。后端镜像随附 `packs/` 和 `samples/`，容器内可直接使用 Local Packs 与官方样例。如需从源码重建镜像，运行 `docker compose up --build -d`。

### 本地开发

后端（Python 3.11+）：

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp ../.env.example .env
uvicorn app.main:app --host 127.0.0.1 --port 18927 --reload
```

另开终端启动前端（Node.js 20.19+ 或 22.12+，npm）：

```bash
cd frontend
npm install
npm run dev
```

打开 http://127.0.0.1:18928 。前端通过 `/api` 和 `/ws` 代理到 http://127.0.0.1:18927 。

## 公开部署

Docker Compose 默认仅供本机访问。改成公网或 LAN 绑定时，必须设置 `ENV=production`、唯一的 `SESSION_SECRET` 和 `ADMIN_TOKEN`；生产模式缺少任一密钥会拒绝启动。BYOK、SSRF 和管理端点边界以 [SECURITY.md](SECURITY.md) 为准，部署变量见 [配置说明](docs/CONFIGURATION.md)。

## 文档

- [使用指南](docs/USAGE.md)：从首页到结果页的操作
- [配置说明](docs/CONFIGURATION.md)：环境变量、部署与功能开关
- [功能索引](docs/FEATURES.md)：类别级能力与主要路由
- [贡献指南](CONTRIBUTING.md) · [安全说明](SECURITY.md) · [变更记录](CHANGELOG.md)

## 技术栈与许可证

后端：FastAPI、SQLModel、SQLite、ChromaDB。前端：React 19、TypeScript、Phaser 3、Vite。数据库迁移由后端 `init_db()` 在启动时负责。

SwarmOracle 使用 [GNU Affero General Public License v3.0](LICENSE)。生成内容只适合娱乐和探索，不应作为金融、医疗、法律或事实判断依据。
