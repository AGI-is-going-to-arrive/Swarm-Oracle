# Contributing / 贡献指南

Keep each change focused, testable, and grounded in current code or configuration. Avoid unrelated refactors and do not publish local secrets.

每次改动应范围清晰、可以验证，并以当前代码或配置为依据。不要顺手重构无关代码，也不要提交本地密钥。

## Setup / 开发环境

Backend / 后端：

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp ../.env.example .env
uvicorn app.main:app --host 127.0.0.1 --port 18927 --reload
```

Frontend / 前端（Node.js 20+，npm）：

```bash
cd frontend
npm install
npm run dev
```

Open / 打开 http://127.0.0.1:18928 。The frontend proxies `/api` and `/ws` to backend port `18927`.

## Gates / 门禁

Run the smallest relevant check first. Expand only when the change crosses modules or release surfaces.

先跑最相关的窄门禁；只有改动跨模块或发布面时再扩大。

```bash
# Backend
cd backend
.venv/bin/python -m pytest
.venv/bin/ruff check app/

# Frontend
cd frontend
npm test
npm run lint
npx tsc -b
npm run build
```

`npx tsc -b` is the repository TypeScript gate. Do not replace it with a different no-emit command in release claims.

`npx tsc -b` 是仓库的 TypeScript 门禁；发布签收不要用其它 no-emit 命令替代。

## Pull Requests / Pull Request

- One behavioral or documentation goal per PR; use a descriptive branch name.
- Explain what changed, why, and the exact commands actually run.
- Add or update tests for behavior changes. Do not claim checks you did not run.
- Coordinate before editing files already owned by another active PR.
- Do not commit `.env`, API keys, tokens, caches, databases, or generated captures unless the PR explicitly owns them.

- 每个 PR 只处理一个行为或文档目标，分支名应说明用途。
- 写清改了什么、原因和实际运行的命令。
- 行为变更应补测试；未运行的检查不得写成已通过。
- 如果文件已由其它 PR 修改，先协调再编辑。
- 不要提交 `.env`、API key、token、缓存、数据库或无关生成产物。

## Content Policy / 内容政策

SwarmOracle produces hypothetical AI simulations, not verified reporting or professional advice. Do not contribute material that defames or targets real people, exposes personal data or credentials, impersonates a real person, requests unlawful harm, or presents generated fiction as fact.

SwarmOracle 生成假设性 AI 推演，不是事实报道或专业建议。不要贡献诽谤或定向攻击真实个人、泄露个人数据或凭据、冒充真实个人、请求违法伤害，或把生成内容包装成事实的材料。

Security reports belong in private vulnerability reporting; see [SECURITY.md](SECURITY.md). 安全漏洞请通过私密漏洞报告提交。
