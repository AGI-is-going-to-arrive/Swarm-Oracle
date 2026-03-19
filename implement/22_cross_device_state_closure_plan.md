# SwarmOracle — 跨设备状态收口报告

> 文档状态：这份文件已从“下一次执行手册”切换为“收口结果报告”。
> 适用时间：截至 `2026-03-19`。
> 用途：记录主模式跨设备 authority 的最终形态、验证结果和剩余边界。

---

## 1. 结论

主模式跨设备状态收口已经完成。

本轮最终落地的是：

- `director goals / worldline commitment` 以后端 `Scenario.director_state_json` 为准
- `cards.usage_log / betting.bets / archive.key_moments / archive.branch_snapshots` 以后端 `Scenario.gameplay_state_json` 为准
- 前端 `scenarioMeta` 退为兼容层 / 缓存层，而不是 authority

因此，这份文件不再应被阅读成“下一次要做什么”，而应被阅读成“这条线已经如何收口”。

---

## 2. 最终 authority 形态

### 2.1 导演层

后端 authoritative：

- `Scenario.director_state_json`
  - `objectives`
  - `commitment`

正式接口：

- `GET /api/campaign/scenario/{id}/director-state`
- `PUT /api/campaign/scenario/{id}/director-state`
- `GET /api/scenario/{id}` 顶层回包 `director_state`

### 2.2 玩法层

后端 authoritative：

- `Scenario.gameplay_state_json`
  - `cards.usage_log`
  - `betting.bets`
  - `archive.key_moments`
  - `archive.branch_snapshots`

默认结构已固定为：

```json
{
  "cards": {
    "usage_log": []
  },
  "betting": {
    "bets": []
  },
  "archive": {
    "key_moments": [],
    "branch_snapshots": []
  }
}
```

正式接口：

- `GET /api/campaign/scenario/{id}/gameplay-state`
- `PUT /api/campaign/scenario/{id}/gameplay-state`
- `GET /api/scenario/{id}` 顶层回包 `gameplay_state`

---

## 3. 已完成的实现面

### 3.1 后端

已完成：

- `campaign.py` 扩展 `DEFAULT_SCENARIO_GAMEPLAY_STATE`
- `normalize_scenario_gameplay_state()`
- `normalize_bet_entry()`
- `normalize_archive_state()` 相关归一化链路
- `campaign` API request/response 扩展到完整 gameplay raw state
- `/api/scenario/{id}` 顶层一起返回完整 `gameplay_state`

说明：

- 本轮没有新增 Alembic migration
- 原因是这次只是扩展已有 JSON 列契约，没有新增数据库列

### 3.2 前端

已完成：

- `ScenarioGameplayState` 类型扩展
- `scenarioGameplayState.ts` 完成：
  - local → remote payload 映射
  - remote → local apply
  - `usage_log / bets / key_moments / branch_snapshots` merge/backfill
- `PredictionModal` 在下注成功后立即回写后端 authority
- `SimulationView` 与 `ResultView` 优先读取远端 `gameplay_state`
- 结果页在无本地缓存时仍可恢复：
  - bet list
  - key moments
  - branch snapshots

### 3.3 派生值边界

以下字段继续保持“派生值”，而不是 authority：

- `most_used_card`
- `betting_hit`
- `archive_grade`
- `directorStyleTag`
- `dominantBranchTitle`
- `dominantTone`
- `profileResonance`

这些仍应从：

- `usage_log`
- `bets`
- `branches`
- `story`

推导，而不是变成第三份真值。

---

## 4. 验证结果

### 4.1 定向测试

已通过：

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_campaign_api.py tests/test_campaign_service.py -q
```

结果：

- `19 passed`

已通过：

```bash
cd frontend
npm test -- --run \
  src/lib/scenarioGameplayState.test.ts \
  src/components/PredictionModal.test.tsx \
  src/pages/SimulationView.test.tsx \
  src/pages/ResultView.test.tsx
```

结果：

- `26 passed`

已通过：

```bash
cd frontend
npx tsc --noEmit -p tsconfig.app.json
npm run build
```

### 4.2 E2E 工件

已存在并通过的工件：

- `frontend/output/e2e/20260319-cross-device-state-corners/`
- `frontend/output/e2e/20260319-cross-device-state-cross-browser/`
- `frontend/output/e2e/20260319-cross-device-state-safari/`
- `frontend/output/e2e/20260319-cross-device-state-safari-panel/`

其中 `corners` 的 `gameplay_state_roundtrip` 已显式覆盖：

- `simulationBetting`
- `resultBetList`
- `resultKeyMoments`
- `resultBranchSnapshots`

这意味着以下目标已经达成：

1. 第二设备 / 新浏览器上下文可回读下注与 archive raw
2. 清空本地缓存后，`/sim/:id` 与 `/result/:id` 仍能恢复关键状态
3. `director_state_roundtrip / gameplay_state_roundtrip / cross-browser / safari` 未回归

---

## 5. 当前剩余边界

这条线已完成，但仍有几个边界需要诚实保留：

1. `scenarioMeta` 仍然存在。
   它现在是兼容层，不是 authority；短期内不会被完全删除。

2. Safari 取证仍有浏览器限制。
   `panel capture` 可稳定拍到 HUD / 导演态，但 Theater 画布在某些路径下仍可能发黑，这更像 Safari/WebKit 的截图限制，不是 authority 收口回归。

3. 当前交付仍是浏览器优先 Web。
   这里的“跨设备一致”指浏览器之间的状态一致，不代表原生客户端壳已完成。

---

## 6. 归档说明

这份文件保留原文件名，是为了不打断 `implement/README.md` 的索引和历史上下文。

但从现在开始，它的语义是：

- 已完成收口报告
- 不是执行手册
- 不是当前待办

如果后续还要继续演进主模式 authority，应新开增量设计文档，而不是把本文件再改回“下一次执行计划”。
