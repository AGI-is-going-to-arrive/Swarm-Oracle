# Contributing / 贡献指南

SwarmOracle welcomes focused, testable changes. Keep pull requests small,
ground user-facing claims in the repository, and avoid unrelated refactors.

SwarmOracle 欢迎范围清晰、可以验证的改动。请保持 PR 小而明确，面向用户的说法必须来自仓库里的真实代码、配置或文档，不要顺手重构无关部分。

## Development Setup / 开发环境

Backend:

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

Frontend:

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

## Test Gates / 测试门禁

Run the narrow gate that matches your change first, then broaden only when the
change crosses backend/frontend or release surfaces.

先跑与你的改动最相关的窄门禁；只有当改动跨后端、前端或发布面时再扩大范围。

Backend pytest:

```bash
cd backend && .venv/bin/python -m pytest
```

```powershell
# Windows PowerShell
cd backend; .venv\Scripts\python.exe -m pytest
```

Frontend typecheck:

```bash
cd frontend && npx tsc --noEmit -p tsconfig.app.json
```

```powershell
# Windows PowerShell
cd frontend; npx tsc --noEmit -p tsconfig.app.json
```

Frontend tests:

```bash
cd frontend && npm test
```

```powershell
# Windows PowerShell
cd frontend; npm test
```

## Branch and PR Etiquette / 分支与 PR 规范

- Use a descriptive branch name, such as `fix/snapshot-import-copy` or
  `docs/release-surface`.
- Keep each PR scoped to one behavioral or documentation goal.
- Include what changed, why it changed, and the exact commands you ran.
- Do not commit secrets, local `.env` files, generated caches, or bulky media
  captures unless the PR explicitly owns those artifacts.
- If your change touches files that an open PR is already modifying, coordinate
  in that issue or PR first instead of editing the same files in parallel.

- 分支名应说明目的，例如 `fix/snapshot-import-copy` 或
  `docs/release-surface`。
- 每个 PR 只处理一个行为或文档目标。
- PR 描述中写清楚改了什么、为什么改、实际跑过哪些命令。
- 不要提交密钥、本地 `.env`、缓存产物或大体积录屏，除非该 PR 明确负责这些资产。
- 如果你的改动会碰到其他进行中 PR 正在修改的文件，请先在对应 issue / PR 里沟通，不要并行修改同一文件。

## Content Policy / 内容政策

SwarmOracle produces AI-generated hypothetical simulations and speculative
fiction. Outputs are not factual reporting, legal advice, medical advice,
financial advice, or historical proof.

SwarmOracle 生成的是 AI 假设性推演和 speculative fiction。输出不是事实报道、法律建议、医疗建议、财务建议或历史证明。

Do not contribute prompts, examples, templates, screenshots, or docs that:

- Defame, harass, dox, or target real people.
- Impersonate a real person or present generated fiction as verified fact.
- Request instructions for violence, self-harm, cyber abuse, fraud, or other
  unlawful conduct.
- Include private credentials, API keys, authorization headers, user
  identifiers, or personal data.
- Compare the project against a named product without current, verifiable,
  maintainer-approved evidence.

请不要贡献以下内容：

- 诽谤、骚扰、开盒或定向攻击真实个人。
- 冒充真实个人，或把生成的虚构内容包装成已验证事实。
- 请求暴力、自伤、网络滥用、欺诈或其他违法行为的操作指导。
- 包含私有凭据、API key、Authorization header、用户标识符或个人数据。
- 在没有当前、可验证、维护者批准证据的情况下，把项目与某个具名产品做对比。
