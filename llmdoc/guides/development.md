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

### Frontend

```bash
cd frontend
npm install && npm run dev
# → http://localhost:18928
```

### 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 设置 LLM_RESPONSES_URL / LLM_API_KEY
```

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

### Frontend 测试

```bash
cd frontend
npm install
npm test
```

- 当前前端回归套件为 **139 tests**。
- 自动化调试辅助：
  - 关键页面暴露 `window.render_game_to_text()`，可输出页面/场景摘要供 E2E 或调试读取。
  - `SimulationView` / `ResultView` 的输出包含控件摘要，Prediction / GameplayCards / Share modal 还会输出内部状态摘要。
  - Phaser Theater 暴露 `window.advanceTime(ms)`，可做更确定性的时间推进与自动化验证。
  - 完成态 Theater 支持世界线/轮次过滤回放，并输出 `page.replay_state`。
  - `useScreenCapture` 现在支持 `Panel / Canvas / Modal` 三种截图模式；GIF 维持 `Panel / Canvas` 可用。
  - Theater 顶部会显示“当前截取目标”，方便区分 `Panel` 和 `Canvas`。
  - DOM 截图会在 `html2canvas` 遇到 `oklch()` 解析失败时自动回退到颜色归一化 + `foreignObject SVG` 路径，`panel / canvas / modal` 三模式都可返回图片。
  - `SimulationView` 额外暴露 `window.capture_game_screenshot(mode)`，黑盒客户端可显式请求 `panel|canvas|modal`。
  - 下载前会按文件扩展名归一化成标准 `image/png` / `image/gif`，减少“文件下好了但系统不认”的情况。
  - 分享文案现在会在前端补一层题材档案前缀；如需复测分享链路，优先从结果页的 `📱 生成文案` 入口进入。
  - 场景主题对齐规则现已收敛：`scene_selector` / `VizSynthesizer` 会优先扫描原始题面，当前 Theater 场景池为 26 个主题，支持主场景和轻量语义变体。
  - 固定回归输入集已落盘：
    - `frontend/output/e2e/sample_matrix.json`
  - 当前固定样本为 14 条，可直接作为后续 replay / result / share 取证的样本清单
  - 一键黑盒回归入口：
    - `npm run e2e:matrix`
    - `npm run e2e:corners`
    - `npm run e2e:full`
    - 最新完整结果：`frontend/output/e2e/full-regression-final/result.json`

### 前端本地玩法状态

- 新增本地持久化 helper：
  - `src/lib/scenarioMeta.ts` — 导演点数、卡冷却、玩法记录、下注记录、因果档案摘要
  - `src/lib/dailyChallenge.ts` — 每日挑战题库与完成状态（现为 9 条 challenge，按本地日期切换）
  - `src/lib/predictionBetting.ts` — 结构化下注编码/反解析；现支持 `branch_winner / ending_tone / profile_resonance`

### 语言行为

- UI 文案跟随右下角语言切换器（EN / ZH）。
- agent 发言、结果叙事、评分语言主要跟随后端输入语言检测：
  - 英文输入 → 英文输出
  - 中文输入 → 中文输出
- 当前产品规则不是“只看 UI 切换器强制改语言”，而是“UI 看切换器，LLM 输出看输入语言”。

### Vertex / Gemini 图像素材

- 当前玩法装饰资产位于：

```bash
frontend/public/assets/ui/generated/
```

- 当前 Theater 背景资产位于：

```bash
frontend/public/assets/scenes/
```

- 新增素材包括：
  - 11 张玩法卡题材 frame
  - 26 张 Theater 场景背景
  - 4 个 UI badge（recommended / daily challenge / archive / bet winner）

- 已验证可用图像模型调用路径：

```bash
https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent
```

```bash
https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent
```

- 使用时通过环境变量提供 API key，避免把密钥写入仓库：

```bash
export GOOGLE_API_KEY="..."
```

**测试约定**:
- `conftest.py` 提供 SQLite in-memory 数据库 fixture
- `asyncio_mode = "auto"` — 自动检测async测试
- LLM调用全部通过 `unittest.mock.AsyncMock` 模拟

## Docker 部署

```bash
cp .env.example .env  # 配置LLM地址
docker compose up --build
# Frontend: http://localhost:18928
# Backend:  http://localhost:18927
```

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
