# SwarmOracle Backend

FastAPI 后端服务，提供 LLM 编排、模拟引擎和 API 接口。

## 快速开始

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp ../.env.example .env   # 编辑 .env，配置 LLM 服务
uvicorn app.main:app --host 127.0.0.1 --port 18927 --reload
```

如果 `.env` 使用非本地 LLM 地址，请把 `LLM_API_KEY=your-api-key-here`
改成真实 key。占位 key 只适合本地网关占位，不会被当成外部 provider 的有效 key。

## 技术栈

- FastAPI + SQLModel + SQLite
- ChromaDB (向量检索)
- Alembic (数据库迁移)

## 环境变量

详见根目录 `.env.example`。核心变量：

| 变量 | 说明 |
|------|------|
| `LLM_RESPONSES_URL` | LLM API 地址 |
| `LLM_API_KEY` | API 密钥 |
| `LLM_MODEL_NAME` | 模型名称 |
| `DATABASE_URL` | 数据库路径 |
| `ENABLE_WEB_SEARCH` | 搜索增强开关 |

## 测试

```bash
pytest -q
ruff check app/
```
