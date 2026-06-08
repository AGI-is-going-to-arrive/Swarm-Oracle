[English](README.en.md) | 中文

# 🔮 SwarmOracle

> AI "What-If" Prediction Playground - 群体预言机

SwarmOracle 让你提出假设性问题（"如果……会怎样？"），由 AI 代理群体模拟多条故事线，展示不同可能性。

![SwarmOracle 首页](docs/screenshots/01-home.png)

## 在线介绍页 / Live demo

打开就能看完整截图和一段介绍视频：**https://agi-is-going-to-arrive.github.io/Swarm-Oracle/**

也可以直接在 B 站看中文介绍视频：**https://www.bilibili.com/video/BV1Xh7168ECc**

## 功能亮点

- **多分支推演**：一个问题，多条故事线，看不同结局
- **辩论竞技场**：AI 正反方激辩，帮你看清争议的两面
- **神谕密室**：与当前世界线里的 AI 角色深度对话，追问细节
- **世界线圆桌**：多方代表圆桌讨论，完成后可回到已保存结果并继续 Deep Dive
- **反事实对比**："如果那句话说得不同，世界线会怎么变？"
- **因果图谱 + 知识图谱**：从结果页进入图谱工作台、知识图谱浏览器和时间线星系
- **自定义 Agent**：在 Agent 工坊里创建、导入、导出你自己的角色
- **预测日志与排行榜**：记录预测、复盘校准，也能看全局排行榜
- **Snapshot 导入 / 导出**：把一次推演打包保存，之后再导入继续查看
- **支持自带 LLM**：兼容任何 OpenAI 格式的 API

> 每种玩法的具体用法见 **[使用指南 docs/USAGE.md](docs/USAGE.md)**；逐项功能图鉴见 **[FEATURES.md](docs/FEATURES.md)**。默认功能基本开箱可用；搜索增强和来源复选框需要额外配置，详见 **[配置说明 docs/CONFIGURATION.md](docs/CONFIGURATION.md)**。

## 玩起来什么样

提一个问题，看一群 AI 推演出好几条故事线，拿到结论，再进各种房间接着追问。

| 推演中：分支实时长出来 | 结果：直接回答你的问题 |
|:---:|:---:|
| ![推演中](docs/screenshots/21-simulation.png) | ![结果页](docs/screenshots/02-result.png) |
| **辩论竞技场：正反方开杠** | **因果图谱：看清来龙去脉** |
| ![辩论竞技场](docs/screenshots/20-debate-arena.png) | ![因果图谱](docs/screenshots/06-causal-map.png) |

## 快速开始

### 运行要求

最低浏览器要求：Chrome/Edge >= 111、Firefox >= 113、Safari/iOS >= 16.2（支持 oklch / color-mix 的现代浏览器）。

### Docker 一键部署（推荐）

1. 编辑 `.env.docker`，填入你的 LLM API 信息：
   ```bash
   # 默认指向宿主机本地 OpenAI-compatible 网关:
   # LLM_RESPONSES_URL=http://host.docker.internal:8317/v1
   #
   # 如果使用 OpenAI 官方 API，改成:
   # LLM_RESPONSES_URL=https://api.openai.com/v1
   # LLM_API_KEY=你的真实 API Key
   # LLM_MODEL_NAME=你的模型名
   ```
   如果不是只在本机访问，同时设置 `SESSION_SECRET` 和 `ADMIN_TOKEN`。前者保护普通 REST / WebSocket 访问，后者保护 `/api/admin/*` 诊断端点（请求头为 `X-Admin-Token`）。

2. 启动：
   ```bash
   docker compose up --build -d
   ```

3. 打开浏览器访问 http://localhost:18928

Docker 默认把前端映射到 `18928`，后端映射到 `18927`。

### 本地开发

后端（Python 3.11+，macOS/Linux）：
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp ../.env.example .env   # 编辑 .env，填入你的 LLM 配置
uvicorn app.main:app --host 127.0.0.1 --port 18927 --reload
```

Windows PowerShell 对应命令：
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
Copy-Item ..\.env.example .env
uvicorn app.main:app --host 127.0.0.1 --port 18927 --reload
```

`.env.example` 里的 `your-api-key-here` 只是占位值。只要 `LLM_RESPONSES_URL`
不是本地地址，后端会拒绝继续使用占位 key。

前端（Node.js 20+）：
```bash
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
| `WEB_SEARCH_PROVIDER` | 搜索服务商（开启搜索时） | `tavily` / `exa` / `firecrawl` / `xai` / `searxng` / `native` |

完整配置项、功能开关清单和搜索增强说明见 **[配置说明 docs/CONFIGURATION.md](docs/CONFIGURATION.md)**。自定义 Agent、跨场景身份、因果图谱、图谱分析、阵营关系、论点地图、知识图谱浏览器、时间线星系、回放轨迹、圆桌 Deep Dive、snapshot、预测日志、教学模板和人物备份在模板里默认开启。`ENABLE_WEB_SEARCH`、`FEATURE_NEW_SOURCES`、`FEATURE_FAMILY_QUERY_OPTIMIZATION` 默认关闭，因为它们需要搜索 provider 和对应配置；实验性的 `FEATURE_RESULT_REPORT` 也默认关闭。

Docker Compose 会读取 `.env.docker`，并把数据库和 Chroma 数据放到
`/data` volume。普通本地开发读取 `backend/.env`。

## 项目结构

```
SwarmOracle/
├── backend/          # FastAPI 后端 (Python)
├── frontend/         # React + Phaser 前端 (TypeScript)
├── docker-compose.yml
├── .env.example      # 本地开发配置模板
└── .env.docker       # Docker 部署配置模板
```

## 技术栈

- **后端**: FastAPI + SQLite + ChromaDB
- **前端**: React 19 + TypeScript + Phaser 3
- **部署**: Docker Compose

## 致谢

感谢 [Linux.do](https://linux.do/) 社区的反馈与支持。

## License

AGPL-3.0
