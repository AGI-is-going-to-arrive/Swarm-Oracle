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
- 可配置的初始世界事件 Feed，以及由同一份结构化决策约束发言与动作的 `POST`、`COMMENT`、`REACTION`、`FOLLOW`、`MUTE`、`SEARCH`、`TREND`、`REFRESH`、`IDLE` 九种原生社交动作
- 玩法卡、预测押注、世界线承诺和赛后因果档案
- 辩论竞技场、结局会客厅和世界线圆桌
- 反事实续跑、分支对比、Replay Trace
- 因果图谱、知识图谱与时间线视图
- 推演内 Agent 档案、分支记忆、可审计决策、可重放的有界领域状态与跨轮记录、自定义 Agent、人物备份、有序 Agent Pack、预测日志与 Snapshot
- 有界 Local Pack 原子导入与可点击 Snapshot 演示，以及结果结论、对 complete/partial 输出执行 Claim–Evidence 编译的透明完整报告、脱敏离线 Gallery 与可选搜索增强

## W2.1 可见性与真值边界

- Agent 档案会区分配置立场与已观察情绪。成长事件始终显示场景、分支、轮次与 `event_type` 坐标；只有事件同时匹配当前路由场景和明确选中的分支时，才标为“当前（Current）· 所选分支片段”，其它可判定事件标为“历史（Past）”。
- 如果 Agent 发言成功但第二阶段结构化元数据解析失败，真实发言仍会保留，情绪、立场和关系观测会明确标为不可用并携带有界错误码；live、Replay、Snapshot 和 Pixel Theater 都不会把缺失观测伪装成 `neutral`。
- 因果图和阵营时间线中的旧 `stance` / `trust` / `opposition` 字段只是由模型生成的 `emotion` / `diverge` 推导出的情绪代理值（affect proxy），不是已验证的立场、信任、关系或因果证据。带 `branch_id` 的 causal、faction、report、Replay 和 compare 统一读取有效的 root-to-leaf 谱系：包含轮次截点内的分叉前祖先轮次，排除父分支分叉后的未来、兄弟分支和 cutoff 之后的数据；自包含 Replay 在自己的 Replay 边界停止。
- 报告的 likelihood 与分析置信度只把已完成的终局叶分支当作分支样本，并结合实际证据条目数；分叉父节点不计数，带符号的情绪收敛代理值也不会抬高分析置信度。已执行的章节工具轨迹有界保存，生成、重写或静态回退后刷新/重开仍可查看；结构化 premortem 为每个失败模式保留独立证据链与不确定性，实时“当前章节”位置仍是瞬时状态。
- Local Pack 刷新会重新读取当前同 ID 包的详情，切换包时先清除旧详情与操作，并隔离迟到响应。包内 `demo_snapshots` 可点击、按目录白名单和 Snapshot 合同校验并直接导入；明确失败可重试，无法确认结果时会提示先检查历史记录，避免重复导入。
- Agent Pack 按资料库选择顺序原子导入或导出，不携带身份 ID、owner、记忆、成长历史、对话或单独存储的凭据，并脱敏常见凭据模式。Public Artifact 可导出脱敏 JSON、单文件 HTML 或离线 Gallery hash 链接，也可由 `gallery.html` 打开本地文件；它不是 hosted registry、社区索引或 marketplace。
- 初始 Feed 最多接受 20 条带来源、正文、可选发布时间、可信度提示和标签的世界事件；这些字段始终是不可信数据，不是系统指令。来源账户可被 Agent 关注或静音，静音会影响后续 Feed、搜索与趋势投影。Causal Review 中的 Action Ledger 面板按分支展示已持久化的原生动作、目标、状态与领域裁决；独立证据回执接口投影 Agent 发言、上下文观察与派生后果，记忆只携带哈希引用和来源场景坐标，不公开正文。旧推演缺少对应证据时会明确显示 `unavailable`，不会补造历史。
- 实时 Agent 回合会先生成并校验有界的 Decision Envelope，再由同一结果约束发言和原生动作；COMMENT、REACTION、FOLLOW、MUTE、SEARCH、TREND 与 REFRESH 只在上一轮真实社交机会允许时开放，带领域规则的动作还必须满足同一份冻结 schema、状态 revision 与阈值。`IDLE` 必须有明确原因，但系统不会用动作配额、随机动作或强制轮换制造活跃。
- parser 可让模型提议预算、客流、容量、承诺等有界领域变量与规则，但只有通过固定类型、单位、精度、边界和凭据校验的 `domain_world_v1` schema 才会被冻结。每个完整轮次只从 durable verified action 确定性裁决状态变化；运行页和结果页显示分支状态条、阈值 tooltip、domain-gated IDLE 归因与有来源坐标的世界结局，Compare 也会显示领域差异。State Transition 继续记录上一轮结果、目标进度、障碍、关系变化和下一轮压力。不可验证或旧数据明确降级为 `unavailable`；这些都是推演内场景假设或有界估计，不是现实测量或因果证明。
- verified-memory promotion 是默认关闭的后端 core，当前没有 capability、REST 或 UI 入口；只有 `FEATURE_AGENT_IDENTITY=true` 与 `FEATURE_MEMORY_PROMOTION=true` 同时满足时才会启用。启用后，它只把与 verified action、领域裁决和实际 delta 精确绑定的结果写入版本化 Chroma namespace，并以稳定哈希 ref 供后续 Decision 召回；关闭任一 gate 只让 reader 忽略该版本，不删除物理记录。v1 留存为 append-only；显式 user-wide purge 仅是 service-level、有界、point-in-time best-effort，当前没有 production caller、continuation/completion cursor 或 terminal purge-wins 保证；Snapshot/import/clone 中的旧 ref 只作 opaque history。
- complete/partial 报告在保存前会把结论编译为带 Agent、消息、动作、分支和轮次坐标的 Claim，并校验逐字引语是否命中同一 speaker 的同一 utterance，以及角色与时间覆盖。证据不足时会移除不安全引号、降低置信度或改为“证据有限的假设”；可用的编译报告会让结果页顶部结论与报告分析置信度保持同源。generating、failed、cancelled、skipped、stalled 和 truncated 等外层状态不宣称已完成 Claim 校验，模型合成访谈和模拟变化也不是现实证据。

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

协议真值边界：连接验证、provider probe 与要求文本的核心生成只有收到受支持的终态信号和可见正文才算成功；error envelope、明确的非终态响应或截断流都会失败。通用 Responses 调用仍允许已完成的原生工具 / reasoning-only 无正文结果，但它不能让连接验证或 provider probe 通过。启用 LLM 时，辩论的必需发言与裁决、会客厅的初始核心计划若生成失败，会明确报错，不会静默改用模板；显式关闭对应 LLM 功能时仍保留确定性模式。会客厅后续追问仍按 best-effort 处理。填写 BYOK key 后，启动前自动检查保持轻量，不执行并发 fanout。

## 快速开始

### Docker Compose

Windows/macOS 使用 Docker Desktop 的 Linux 容器模式；Linux 使用 Docker Engine 与 Compose 插件。在仓库根目录执行。

macOS / Linux：

```bash
test -f .env.docker || cp .env.docker.example .env.docker
docker compose config --quiet
docker compose up -d
```

Windows PowerShell：

```powershell
if (-not (Test-Path .env.docker)) { Copy-Item .env.docker.example .env.docker }
docker compose config --quiet
docker compose up -d
```

打开 http://127.0.0.1:18928 。默认端口只发布到 loopback：前端 `18928`，后端 `18927`。后端镜像随附 `packs/` 和 `samples/`，容器内可直接使用 Local Packs 与官方样例；随附主题包的 `demo_snapshots` 只引用实际存在的 Snapshot，可从包详情直接导入。如需从源码重建镜像，运行 `docker compose up --build -d`。

从旧版 root 容器升级时，已有数据卷不会自动改变所有者。请先完成[停机备份与旧数据卷升级](deploy/README.md#legacy-data-volume-upgrade)，再启动新版；新建数据卷无需这一步。

### 本地开发

后端（Python 3.11+），macOS / Linux：

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
test -f .env || cp ../.env.example .env
uvicorn app.main:app --host 127.0.0.1 --port 18927 --reload
```

Windows PowerShell 使用虚拟环境内的解释器，无需修改脚本执行策略：

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
if (-not (Test-Path .env)) { Copy-Item ..\.env.example .env }
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 18927 --reload
```

另开终端启动前端（Node.js 20.19+（20.x）或 ≥22.12，npm 版本见 `frontend/package.json`）。macOS / Linux：

```bash
cd frontend
npm ci
npm run dev
```

Windows PowerShell：

```powershell
cd frontend
npm.cmd ci
npm.cmd run dev
```

打开 http://127.0.0.1:18928 。前端通过 `/api` 和 `/ws` 代理到 http://127.0.0.1:18927 。

启动服务前，可在仓库根运行预检：macOS/Linux 使用 `backend/.venv/bin/python backend/scripts/preflight.py`，PowerShell 使用 `.\backend\.venv\Scripts\python.exe backend/scripts/preflight.py`。预检会检查所配置的 LLM 连接；`make` 目标仅是 POSIX 终端的便捷入口。

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
