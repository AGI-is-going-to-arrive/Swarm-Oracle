# 后端开发 / Backend development

后端保存推演、调用模型、推进世界线，并通过 REST、SSE 和 WebSocket 为网页提供数据。浏览官方样例无需模型；新建推演、追问和生成报告需要可用模型连接。

The backend stores runs, calls models, advances worldlines, and serves the web app through REST, SSE, and WebSocket. Browsing official samples needs no model. New runs, questions, and generated reports need a working model connection.

![独立工具环境、后端与前端](../docs/illustrations/local-development.zh.webp)

*分别启动前后端，模型连接单独配置。*

<details>
<summary>English illustration / 英文配图</summary>

![Separate tooling, backend, and frontend](../docs/illustrations/local-development.en.webp)

*Start the backend and frontend separately, then configure the model connection.*

</details>

## 安装锁定依赖 / Install locked dependencies

从**仓库根目录**运行以下命令，需要 Python 3.11+。`pyproject.toml` 固定 uv 0.12.7，`uv.lock` 是原生开发、CI 和 Docker 共用的依赖锁。uv 放在 `.swarm-tools/uv`，应用使用 `backend/.venv`；不要把 uv 装入应用环境或重建已有的根目录 `.venv`。

Run these commands from the **repository root** with Python 3.11+. `pyproject.toml` requires uv 0.12.7. Native development, CI, and Docker share `uv.lock`. Keep uv in `.swarm-tools/uv` and the app in `backend/.venv`; do not install uv into the app environment or recreate an existing root `.venv`.

### macOS / Linux

```bash
(
set -eu
if [ ! -d .swarm-tools/uv ]; then
  python3 -m venv .swarm-tools/uv
  .swarm-tools/uv/bin/python -m pip install 'uv==0.12.7'
fi
.swarm-tools/uv/bin/uv --version
.swarm-tools/uv/bin/uv sync --directory backend --locked --extra dev --no-build
test -f backend/.env || cp .env.example backend/.env
)
```

### Windows PowerShell

无需激活脚本、修改执行策略或全局安装包。每步都检查原生命令的退出码。

You do not need activation scripts, execution-policy changes, or global packages. Check native command exit codes at each step.

```powershell
& {
  $ErrorActionPreference = 'Stop'
  if (-not (Test-Path .swarm-tools/uv)) {
    python -m venv .swarm-tools/uv
    if ($LASTEXITCODE -ne 0) { throw 'Tooling environment creation failed' }
    & .\.swarm-tools\uv\Scripts\python.exe -m pip install 'uv==0.12.7'
    if ($LASTEXITCODE -ne 0) { throw 'uv installation failed' }
  }
  & .\.swarm-tools\uv\Scripts\uv.exe --version
  if ($LASTEXITCODE -ne 0) { throw 'uv version check failed' }
  & .\.swarm-tools\uv\Scripts\uv.exe sync --directory backend --locked --extra dev --no-build
  if ($LASTEXITCODE -ne 0) { throw 'Locked dependency installation failed' }
  if (-not (Test-Path backend/.env)) { Copy-Item .env.example backend/.env }
}
```

锁过期、uv 版本不匹配或平台缺少匹配 wheel 时，安装会失败。保留 `--locked` 和 `--no-build`；不要改用未锁定的 `pip install -e` 或 `--frozen`。上述命令保留已有环境文件。

Installation fails for a stale lock, a mismatched uv version, or missing platform wheels. Keep `--locked` and `--no-build`; do not substitute an unlocked `pip install -e` or `--frozen`. The commands preserve existing environment files.

## 配置与启动 / Configure and start

需要模型调用时，编辑 `backend/.env`，或启动后在 `/admin/setup` 保存连接。模板的 `8317` 地址与占位 key 只是未配置哨兵，不代表本机已运行模型。精确本地服务可免 key，远端服务需要真实 key。配置与 reasoning effort 继承见[配置说明](../docs/CONFIGURATION.md)。

For model calls, edit `backend/.env` or save a connection at `/admin/setup` after startup. The template's `8317` address and placeholder key mark an unconfigured connection; they do not mean a model is running. Exact-local services may omit a key; remote services need a real key. See [Configuration](../docs/CONFIGURATION.en.md) for settings and reasoning-effort inheritance.

macOS / Linux：

```bash
cd backend
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 18927 --reload
```

Windows PowerShell：

```powershell
Set-Location backend
& .\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 18927 --reload
```

另开终端按[前端说明](../frontend/README.md)启动网页，然后打开 `http://127.0.0.1:18928`。后端默认只监听本机。`GET /` 检查服务是否响应，不验证模型生成。设置 `EXPOSE_API_DOCS=true` 并重启，才会开放 `/docs`、`/redoc` 和 `/openapi.json`。

Start the web app in another terminal using the [frontend guide](../frontend/README.md), then open `http://127.0.0.1:18928`. The backend listens on loopback. `GET /` checks service response, not model generation. Set `EXPOSE_API_DOCS=true` and restart to enable `/docs`, `/redoc`, and `/openapi.json`.

## 验证改动 / Check a change

先运行相关测试文件，同一工作区只运行一个 pytest 进程。以下命令在 `backend` 中运行，请替换示例文件名。全量测试使用同一个解释器运行 `python -m pytest -q`。

Start with the relevant test file and one pytest process per workspace. Run these commands from `backend`, replacing the example filename. For the full suite, run `python -m pytest -q` with the same interpreter.

```bash
.venv/bin/python -m pytest -q tests/test_preflight_cli.py
.venv/bin/ruff check app/ tests/test_preflight_cli.py
```

PowerShell 使用 `.\.venv\Scripts\python.exe` 和 `.\.venv\Scripts\ruff.exe`。前端与发布检查见[贡献指南](../CONTRIBUTING.md)。

On PowerShell, use `.\.venv\Scripts\python.exe` and `.\.venv\Scripts\ruff.exe`. See [Contributing](../CONTRIBUTING.md) for frontend and release checks.

预检会产生真实连接请求。确认模型和调用预算后，在仓库根运行下列命令。精确本地地址即使没有 key 也会被探测；远端空值或占位 key 只得到警告，不发送请求。

Preflight makes live connection requests. Confirm the model and call budget before running this from the repository root. It probes exact-local addresses even without a key. Remote connections with an empty or placeholder key receive a warning without a request.

```bash
backend/.venv/bin/python backend/scripts/preflight.py
```

## 数据与部署 / Data and deployment

SQLite 保存运行和配置，Chroma 保存向量数据。`init_db()` 负责启动时的数据库迁移。实例备份必须覆盖数据库、原始 WAL/SHM 与 Chroma；Snapshot 用于可移植运行。停机备份、镜像门禁和恢复见[部署说明](../deploy/README.md)，公网鉴权见[安全说明](../SECURITY.md)。

SQLite stores runs and configuration; Chroma stores vector data. `init_db()` owns startup migrations. Instance backups must cover the database, original WAL/SHM files, and Chroma; Snapshots carry portable runs. See [Deployment](../deploy/README.md) for stopped-instance backups, image gates, and recovery, and [Security](../SECURITY.md) for public-deployment authentication.
