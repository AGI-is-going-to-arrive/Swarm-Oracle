# 🔮 SwarmOracle

> AI "What-If" Prediction Playground — 群体预言机

SwarmOracle 让你提出假设性问题（"如果……会怎样？"），由 AI 代理群体模拟多条故事线，展示不同可能性。

## 功能亮点

- **多分支推演** — 一个问题，多条故事线，看不同结局
- **辩论竞技场** — AI 正反方激辩，帮你看清争议的两面
- **神谕密室** — 与 AI 角色深度对话，追问细节
- **世界线圆桌** — 多方代表圆桌讨论，综合不同立场
- **反事实对比** — "如果那句话说得不同，世界线会怎么变？"
- **因果图谱** — 可视化事件之间的因果关系
- **支持自带 LLM** — 兼容任何 OpenAI 格式的 API

## 快速开始

### Docker 一键部署（推荐）

1. 编辑 `.env.docker`，填入你的 LLM API 信息：
   ```bash
   # 默认指向宿主机本地 OpenAI-compatible 网关:
   # LLM_RESPONSES_URL=http://host.docker.internal:8317/v1
   #
   # 如果使用 OpenAI 官方 API，改成:
   # LLM_RESPONSES_URL=https://api.openai.com/v1
   # LLM_API_KEY=你的真实 API Key
   ```

2. 启动：
   ```bash
   docker compose up --build -d
   ```

3. 打开浏览器访问 http://localhost:18928

### 本地开发

后端（Python 3.11+）：
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp ../.env.example .env   # 编辑 .env，填入你的 LLM 配置
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

## 配置说明

核心配置在 `.env.example`（本地开发）或 `.env.docker`（Docker 部署）中：

| 配置项 | 说明 | 示例 |
|--------|------|------|
| `LLM_RESPONSES_URL` | LLM 服务地址 | `https://api.openai.com/v1` |
| `LLM_API_KEY` | API 密钥 | `sk-...` |
| `LLM_MODEL_NAME` | 模型名称 | `gpt-4o` |
| `ENABLE_WEB_SEARCH` | 搜索增强（可选） | `false` |

常用配置见 `.env.example` 文件内注释；完整运行时配置以后端配置实现为准。

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

## License

AGPL-3.0
