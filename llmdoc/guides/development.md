# 开发指南

## 环境要求

- Python ≥3.11
- Node.js ≥18
- npm ≥9

## 本地开发

### Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 18927
```

- 如果本机有多个同级工作区都带 `app/` 包，优先显式指定：

```bash
uvicorn --app-dir /absolute/path/to/upgrade-test/backend app.main:app --reload --port 18927
```

- 这样可以避免因为 cwd / `PYTHONPATH` 污染，误导入别的工作区后端。
- 当前 `app.config.Settings` 还会把默认 `.env`、`DATABASE_URL` 与 `CHROMA_PERSIST_DIR` 统一锚到 `backend/` 根目录；即使你在 repo root 启动，也不会再误命中另一份 SQLite / Chroma 数据目录。

### Frontend

```bash
cd frontend
npm install && npm run dev
# → http://localhost:18928
```

### 配置环境变量

本地直接启动 backend 时，默认读取 `backend/.env`：

```bash
cp .env.example backend/.env
# 编辑 backend/.env 设置 LLM_RESPONSES_URL / LLM_API_KEY
```

- `docker compose` 仍使用仓库根目录 `.env`，不要把这两处混在一起。

## 测试

```bash
cd backend

# 运行全部测试
.venv/bin/python -m pytest tests/ -v

# 快速运行 (无详细输出)
.venv/bin/python -m pytest tests/ -x -q

# 仅运行 memory 模块测试
.venv/bin/python -m pytest tests/test_memory.py -v

# 运行压缩质量 benchmark
.venv/bin/python -m pytest tests/benchmark_compression.py -v -s

# 运行特定测试类
.venv/bin/python -m pytest tests/test_memory.py::TestCompressRounds -v
```

- 仓库内历史后端全量基线仍记录为 **815 passed**。
- 本次文档同步前重新执行了与当前改动直接相关的定向回归：

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_card_events.py tests/test_gameplay_contract_sync.py -q
```

- 结果：**24 passed**

### Frontend 测试

```bash
cd frontend
npm install
npm test
```

- 仓库内历史前端全量基线仍记录为 **179 passed**。
- 本次文档同步前重新执行了与当前玩法增强 / provenance / 文档改动直接相关的定向回归：

```bash
cd frontend
npm test -- --run \
  src/lib/scenarioMeta.test.ts \
  src/lib/archiveSummary.test.ts \
  src/components/gameplayCards.test.ts \
  src/components/gameplayContract.test.ts \
  src/pages/SimulationView.test.tsx \
  src/pages/ResultView.test.tsx \
  src/components/GameplayCardsModal.test.tsx
```

- 结果：
  - `vitest`：**49 passed**
- 本次文档同步还重新执行了：

```bash
cd frontend
npm run build
npm run assets:provenance:check
```

- 结果：
  - `npm run build`：通过
  - `npm run assets:provenance:check`：通过
- 自动化调试辅助：
  - 关键页面暴露 `window.render_game_to_text()`，可输出页面/场景摘要供 E2E 或调试读取。
  - `SimulationView` / `ResultView` 的输出包含控件摘要，Prediction / GameplayCards / Share modal 还会输出内部状态摘要。
  - Phaser Theater 暴露 `window.advanceTime(ms)`，可做更确定性的时间推进与自动化验证。
  - 完成态 Theater 支持世界线/轮次过滤回放，并输出 `page.replay_state`。
  - `useScreenCapture` 现在支持 `Panel / Canvas / Modal` 三种截图模式；GIF 维持 `Panel / Canvas` 可用。
  - Theater 顶部会显示“当前截取目标”，方便区分 `Panel` 和 `Canvas`。
  - DOM 截图会在 `html2canvas` 遇到 `oklch()` 解析失败时自动回退到颜色归一化 + `foreignObject SVG` 路径，`panel / canvas / modal` 三模式都可返回图片。
  - `SimulationView` 额外暴露 `window.capture_game_screenshot(mode)`，黑盒客户端可显式请求 `panel|canvas|modal`。
  - `SimulationView` 的自动化摘要现还会带 `page.controls.capture_result_kind`，可直接区分 `gif` 与 `gif_fallback_png`。
  - `SimulationView` 现还会输出 `page.director.objectives / system_tracks / commitment`，可直接取证导演目标、风险/资源轨道与 worldline 承诺。
  - 下载前会按文件扩展名归一化成标准 `image/png` / `image/gif`，减少“文件下好了但系统不认”的情况。
  - 分享文案现在会在前端补一层题材档案前缀；如需复测分享链路，优先从结果页的 `📱 生成文案` 入口进入。
  - `ResultView` 的 `archive_summary` 现还会输出 `profile_id / profile_resonance / completed_daily_challenge`，并新增 `objective_completed_count / objective_total_count / commitment_outcome / risk_value / resource_value`，方便核对导演层和后端 summary 兜底是否生效。
  - 场景主题对齐规则现已收敛：`scene_selector` / `VizSynthesizer` 会优先扫描原始题面；当前 registry 共有 33 个主题条目，其中 Theater 为 30 个语义主题，Debate 另有 3 张专属背景；`generic` 现有独立主题 `switchboard_forum / 轮值议堂`，并可命中 `switchboard_forum_variant`。
  - 固定回归输入集已落盘：
    - `frontend/output/e2e/sample_matrix.json`
    - `frontend/output/e2e/sample_matrix_variants.json`
- 当前固定样本为 15 条，可直接作为后续 replay / result / share 取证的样本清单
- 一键黑盒回归入口：
  - `npm run e2e:matrix`
  - `npm run e2e:variants`
  - `npm run e2e:corners`
  - `npm run e2e:full`
  - `npm run e2e:debate:desktop`
  - `npm run e2e:debate:mobile`
  - `npm run e2e:debate:full`
  - `npm run e2e:debate`
  - `npm run assets:provenance:backfill`
  - `npm run assets:provenance:check`
  - `node scripts/e2e-suite.mjs mobile --headless --output-dir <DIR>`
  - `node scripts/e2e-suite.mjs full --headless --output-dir <DIR>`
  - `node scripts/e2e-debate-suite.mjs full --url http://127.0.0.1:18928 --output-dir output/e2e/<DIR>`
  - `scripts/e2e-suite.mjs` 现在会在输出目录落盘 `browser-launch.json`，方便判断本次实际命中的浏览器启动 profile
  - `capture-modes` case 现在会额外落盘 `predictionModalBytes / gameplayModalBytes`
  - `scripts/e2e-suite.mjs` 的截图现在会先走带 `timeout` 的 Playwright `page.screenshot()`；任意截图失败都会回退到 Chromium CDP 截图，避免整套黑盒回归因截图超时中止
  - `history-delete-last-page` case 现在会在最终截图前等待删除弹窗真正脱离 DOM，减少删除后重排阶段的挂起风险
  - 若 `sample_matrix.json` 里的历史 `scenario_id` 缺失，suite 会按 theme/runtime fallback 题面自动重建场景，而不是直接失败
  - 若历史样本的 `scene_theme` 已与当前 `select_scene(question)` 漂移，matrix 也会自动 runtime fallback 重建
  - `replay` corner case 现在会等到 `playback_mode = replay` 且 `theater_ready = true` 才判定恢复完成
  - `generic` matrix smoke 已可在无旧 DB 快照时依赖 runtime fallback 重跑
  - 当前 Track C 主工件目录：
    - `frontend/output/e2e/20260317-track-c/matrix/`
    - `frontend/output/e2e/20260317-track-c/corners/`
    - `frontend/output/e2e/20260317-track-c/mobile/`
    - `frontend/output/e2e/20260317-track-c/variants/`
  - 本轮 full smoke 工件：`frontend/output/e2e/20260318-post-director-goals-full/result.json`
  - ResultView backend summary smoke 工件：`frontend/output/e2e/20260318-result-backend-summary-smoke-v2/result-final.json`
  - `generic` 主题单独 smoke 结果：`frontend/output/e2e/matrix-generic-smoke-switchboard-20260317/result.json`
  - Debate 专项最新成功工件：
    - `frontend/output/e2e/20260318-post-director-goals-debate-full/result.json`
  - Debate 额外补充工件：
    - `frontend/output/e2e/20260318-debate-mobile-430x932-v2/result.json`
    - `frontend/output/e2e/20260318-debate-civic-v2/result.json`
  - `scripts/e2e-debate-suite.mjs` 现在支持：

```bash
node scripts/e2e-debate-suite.mjs mobile --url http://127.0.0.1:18928 --width 430 --height 932 --output-dir output/e2e/<DIR>
node scripts/e2e-debate-suite.mjs desktop --url http://127.0.0.1:18928 --profile-hint governance --question 'Should every major city budget be re-approved by a rotating external review board?' --output-dir output/e2e/<DIR>
```
  - 如需在长时间实现过程中持续盯进度，可用心跳脚本：

```bash
node scripts/codex-heartbeat.mjs --interval 30 --label implement-tail --log-file /tmp/upgrade-test-heartbeat.log
```

  - 该脚本会定时汇总当前 `git status`、最新 `frontend/output/e2e/**/result.json` 与 `progress.md` 最新段落；不带 `--interval` 时可单次输出，也支持 `--json`。
  - 本轮 `develop-web-game` 相关最新工件：
    - `frontend/output/web-game/20260318-director-layer-smoke-v2/state-0.json`
    - `frontend/output/web-game/20260318-director-layer-smoke-v2/shot-0.png`

### 前端本地玩法状态

- 新增本地持久化 helper：
  - `src/lib/scenarioMeta.ts` — 导演点数、卡冷却、玩法记录、下注记录、因果档案摘要
  - `src/lib/dailyChallenge.ts` — 每日挑战题库、双语题面与完成状态合并（现为 12 条 challenge，按本地日期切换；会把后端 `campaign daily-status` 与本地缓存合并。后端在判定 `completed` 时会先把 SQLite round-trip 的 naive UTC `created_at` 归一为 UTC，再按调用方本地日期换算；`completed_at` 继续返回 UTC ISO 字符串）
  - `src/lib/predictionBetting.ts` — 结构化下注编码/反解析；现支持 `branch_winner / ending_tone / profile_resonance`

### 语言行为

- UI 文案跟随右下角语言切换器（EN / ZH）。
- Debate Arena 是当前的例外：当页面拿到 `debate.language` / result payload `language` 后，会自动把整页 UI 切到相同语言，避免出现“英文题挂中文壳”或反过来的情况。
- agent 发言、结果叙事、评分语言主要跟随后端输入语言检测：
  - 英文输入 → 英文输出
  - 中文输入 → 中文输出
- 当前产品规则不是“只看 UI 切换器强制改语言”，而是“常规页面 UI 看切换器，LLM 输出看输入语言；Debate 页面则以 `debate.language` 为准同步 UI”。

### Vertex / Gemini 图像素材

- 当前玩法装饰资产位于：

```bash
frontend/public/assets/ui/generated/
```

- 当前 Theater 背景资产位于：

```bash
frontend/public/assets/scenes/
```

- 当前 `frontend/public/assets/scenes/` 已可见 30 张 Theater 场景背景；再加 3 张 Debate 专属背景后，registry 总条目为 33
- 当前 `frontend/public/assets/scenes/` 加上 Debate 专属 3 张背景后，总主题条目为 33
- 当前玩法卡总数为 14（10 张原始导演卡 + 4 张反制卡）
- 玩法卡 modal 现在还会显示：
  - 题材专属三段式连锁事件
  - 下一步推荐卡
  - `风险 / 资源` 轨道

- AI 图像生成脚本已存在：

```bash
frontend/scripts/generate-ui-assets.mjs
```

- 该脚本会优先请求 `aiplatform`，若失败再自动回退到 `generativelanguage`。
- 已验证脚本里的图像模型调用路径包括：

```bash
https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.1-flash-image-preview:generateContent
```

```bash
https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3-pro-image-preview:generateContent
```

```bash
https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent
```

```bash
https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent
```

- 使用方式示例：

```bash
cd frontend
node scripts/generate-ui-assets.mjs --preset generic_frame --preset generic_scene_variant
```

- 使用时通过环境变量提供 API key，避免把密钥写入仓库：

```bash
export GOOGLE_API_KEY="..."
```

- 当前 `frontend/public/assets/ui/generated + frontend/public/assets/scenes` 下 62 张 PNG 都已有 `.meta.json` sidecar。
- 其中较新的 Debate 资产保留原始生成字段；较早的 legacy 资产则使用诚实回填的 sidecar，允许 `unknown / null` 字段与 `provenance_status=backfilled_*` 并存，而不是伪造原始生成记录。

**测试约定**:
- `conftest.py` 现为每个 pytest case 创建独立临时 SQLite 数据库，并在前后显式释放 engine
- `asyncio_mode = "auto"` — 自动检测async测试
- LLM调用全部通过 `unittest.mock.AsyncMock` 模拟

## Docker 部署

```bash
cp .env.example .env  # 配置LLM地址
docker compose up --build
# Frontend: http://localhost:18928
# Backend:  http://localhost:18927
```

- 如果后端跑在 Docker 容器里、LLM 服务跑在宿主机本地，容器内的 `LLM_RESPONSES_URL` 不能继续写 `127.0.0.1`。
- 本轮真实验证使用的配置是：

```bash
LLM_RESPONSES_URL=http://host.docker.internal:8318/v1/chat/completions
```

- Linux 环境请改成实际可达宿主机的地址，而不是直接照抄 `host.docker.internal`。
- `docker-compose.yml` 的 backend healthcheck 现只检查 `GET /`，不再调用会同步探测外部 LLM 的 `POST /api/health`。
- 本轮已完成一次真实容器 smoke：
  - `docker compose up --build -d` 成功
  - backend 变为 `healthy`
  - frontend 监听 `18928`
  - 通过前端代理 `POST /api/scenario` 成功创建 Theater 场景并跑到 `status = done`

## 代码规范

- **Linter**: ruff (line-length=100, target=py311)
- **Lint rules**: E, F, I, W
- **运行**: `.venv/bin/ruff check app/ tests/`
- **前端**: eslint + typescript-eslint

## 数据库迁移 (Alembic)

```bash
cd backend

# 生成新迁移
alembic revision --autogenerate -m "describe change"

# 执行迁移
alembic upgrade head

# 查看当前版本
alembic current

# 回滚一步
alembic downgrade -1
```

## Prometheus 监控

- **端点**: `GET /metrics` — 暴露 Prometheus 格式指标
- **指标**:
  - `http_requests_total` — 请求总数 (按方法/路径/状态码)
  - `http_request_duration_seconds` — 请求延迟直方图
  - `active_simulations` — 当前活跃模拟数
