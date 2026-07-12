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
- 推演内 Agent 档案、分支记忆、自定义 Agent、人物备份、有序 Agent Pack、预测日志与 Snapshot
- 有界 Local Pack 原子导入与可点击 Snapshot 演示，以及结果结论、透明完整报告、脱敏离线 Gallery 与可选搜索增强

## W2.1 可见性与真值边界

- Agent 档案会区分配置立场与已观察情绪。成长事件始终显示场景、分支、轮次与 `event_type` 坐标；只有事件同时匹配当前路由场景和明确选中的分支时，才标为“当前（Current）· 所选分支片段”，其它可判定事件标为“历史（Past）”。
- 如果 Agent 发言成功但第二阶段结构化元数据解析失败，真实发言仍会保留，情绪、立场和关系观测会明确标为不可用并携带有界错误码；live、Replay、Snapshot 和 Pixel Theater 都不会把缺失观测伪装成 `neutral`。
- 因果图和阵营时间线中的旧 `stance` / `trust` / `opposition` 字段只是由模型生成的 `emotion` / `diverge` 推导出的情绪代理值（affect proxy），不是已验证的立场、信任、关系或因果证据。带 `branch_id` 的 causal、faction、report、Replay 和 compare 统一读取有效的 root-to-leaf 谱系：包含轮次截点内的分叉前祖先轮次，排除父分支分叉后的未来、兄弟分支和 cutoff 之后的数据；自包含 Replay 在自己的 Replay 边界停止。
- 报告的 likelihood 与分析置信度只把已完成的终局叶分支当作分支样本，并结合实际证据条目数；分叉父节点不计数，带符号的情绪收敛代理值也不会抬高分析置信度。已执行的章节工具轨迹有界保存，生成、重写或静态回退后刷新/重开仍可查看；结构化 premortem 为每个失败模式保留独立证据链与不确定性，实时“当前章节”位置仍是瞬时状态。
- Local Pack 刷新会重新读取当前同 ID 包的详情，切换包时先清除旧详情与操作，并隔离迟到响应。包内 `demo_snapshots` 可点击、按目录白名单和 Snapshot 合同校验并直接导入；明确失败可重试，无法确认结果时会提示先检查历史记录，避免重复导入。
- Agent Pack 按资料库选择顺序原子导入或导出，不携带身份 ID、owner、记忆、成长历史、对话或单独存储的凭据，并脱敏常见凭据模式。Public Artifact 可导出脱敏 JSON、单文件 HTML 或离线 Gallery hash 链接，也可由 `gallery.html` 打开本地文件；它不是 hosted registry、社区索引或 marketplace。

类别级能力与路由见 [功能索引](docs/FEATURES.md)，操作步骤见 [使用指南](docs/USAGE.md)。

## 两种使用方式

### 内置官方样例与 Snapshot 演示

真实 LLM 未配置时，前后端仍可启动。首页提供 3 个随附的官方样例：无需 API Key、无需选择文件，也不会发起模型调用，任选一个即可导入完整推演并浏览结果、回放和关联视图。你也可以继续导入 `samples/snapshots/` 中脱敏的 `*.swarm` 文件。内置样例和 Snapshot 导入不能生成新的实时推演。

### 实时 LLM 推演

新建推演、辩论、会客厅和报告需要可用的 OpenAI-compatible LLM。你可以：

- 在 `backend/.env` 或 `.env.docker` 配置服务端默认模型；或
- 启动后打开 `/admin/setup`，测试连接并保存 model profile；或
- 在首页独立的 **BYOK** 折叠区为本轮提供连接信息。

精确指向 `localhost`、`127.0.0.1`、`0.0.0.0`、`host.docker.internal` 或 `[::1]` 的本地 Base URL 可以不填 API key；此时请求不会发送 `Authorization`。其它自定义或远端 Base URL 仍必须提供 key。凭据、端点和模型按同一 provider 绑定：未改动的 profile 由后端按场景恢复，不会留下缺 key 的 session 镜像；修改远端端点或模型时必须提交完整的 key/Base URL/模型组合，partial override 会被拒绝，并会解绑旧 profile、清除其限速与能力策略。Setup 向导只有在当前组合测试成功，或你明确确认“未验证仍保存”后，才允许完成。随附的 `127.0.0.1:8317 + 空值/占位 key` 仍是“未配置”哨兵；请改成实际本地服务地址，或在 Setup 中明确保存该连接。

首页的 **高级设置** 与 **BYOK** 是两个独立折叠区。公开默认值以 [`.env.example`](.env.example) 为准，不以某台开发机的 `backend/.env` 为准。

## 快速开始

### Docker Compose

```bash
cp .env.docker.example .env.docker
docker compose up -d
```

打开 http://127.0.0.1:18928 。默认端口只发布到 loopback：前端 `18928`，后端 `18927`。后端镜像随附 `packs/` 和 `samples/`，容器内可直接使用 Local Packs 与官方样例；随附主题包的 `demo_snapshots` 只引用实际存在的 Snapshot，可从包详情直接导入。如需从源码重建镜像，运行 `docker compose up --build -d`。

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

发布镜像只从通过 CI 的同一 commit 构建；backend/frontend 先以同一 SHA 的不可变标签完成，再成对晋升，任一晋升失败会触发并验证两张标签的回滚，回滚不完整会显式阻断作业。版本标签还要求该精确 SHA 的已执行 release signoff。`--dry-run` 只记录计划步骤，不会被标成已通过。

## 文档

- [使用指南](docs/USAGE.md)：从首页到结果页的操作
- [配置说明](docs/CONFIGURATION.md)：环境变量、部署与功能开关
- [功能索引](docs/FEATURES.md)：类别级能力与主要路由
- [贡献指南](CONTRIBUTING.md) · [安全说明](SECURITY.md) · [变更记录](CHANGELOG.md)

## 技术栈与许可证

后端：FastAPI、SQLModel、SQLite、ChromaDB。前端：React 19、TypeScript、Phaser 3、Vite。数据库迁移由后端 `init_db()` 在启动时负责。

SwarmOracle 使用 [GNU Affero General Public License v3.0](LICENSE)。生成内容只适合娱乐和探索，不应作为金融、医疗、法律或事实判断依据。
