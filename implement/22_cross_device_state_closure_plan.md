# SwarmOracle — 跨设备状态收口执行文档

> 目标：把主模式剩余的本地玩法状态收口到后端 authority，完成“完全跨设备一致”的最后一段。  
> 范围：`betting.bets`、必要的 archive raw 细节、前端 merge/backfill、E2E roundtrip、文档收口。  
> 当前基线：截至 `2026-03-19`，`director goals / worldline commitment` 与 `cards.usageLog` 已后端化；Safari 正式 smoke 已跑通；Theater 视觉可读性已做一轮压缩与放大。  
> 本文是**下一次执行的操作手册**，不是状态同步稿。

---

## 0. 当前真实状态

### 0.1 已完成的 authority 链路

- 后端 authoritative：
  - `Scenario.director_state_json`
    - `objectives`
    - `commitment`
  - `Scenario.gameplay_state_json`
    - `cards.usageLog`
- 已有正式接口：
  - `GET /api/campaign/scenario/{id}/director-state`
  - `PUT /api/campaign/scenario/{id}/director-state`
  - `GET /api/campaign/scenario/{id}/gameplay-state`
  - `PUT /api/campaign/scenario/{id}/gameplay-state`
  - `GET /api/scenario/{id}` 已回包：
    - `director_state`
    - `gameplay_state`

### 0.2 仍然没完全收口的状态

- 仍主要在前端 `scenarioMeta`：
  - `betting.bets`
  - 部分 archive raw 细节
- 仍是“前端可重算 / 后端只存聚合或完全不存”的字段：
  - `archive.keyMoments`
  - `archive.branchSnapshots`
  - `archive.directorStyleTag`
  - `archive.dominantBranchTitle`
  - `archive.dominantTone`
  - 以及所有依赖 `bets + branches + local archive` 才能完整还原的展示内容

### 0.3 当前最关键的边界

- `usageLog` 已后端化，但只解决了：
  - 导演点数
  - 卡牌冷却
  - `most_used_card`
  - `counterplay_card_count`
  - `last_counterplay_card`
- “完全跨设备一致”还差：
  - 下注列表可跨设备回读
  - 结果页 archive raw 区块在无本地缓存时仍完整
  - E2E 能证明“清空 localStorage 后 `/sim` + `/result` 仍一致”

---

## 1. 本轮目标定义

### 1.1 最终交付目标

完成后，下面 4 件事应同时成立：

1. 同一 `scenario` 在第二台设备 / 新浏览器上下文打开时：
   - `SimulationView` 里的下注相关摘要一致
   - `ResultView` 里的 bet log 一致
2. 清空本地缓存后重新打开：
   - `/sim/:id`
   - `/result/:id`
   仍能还原下注状态与 archive 关键细节
3. `e2e-suite.mjs corners` 新增或更新的 roundtrip case 通过
4. 现有 `director_state_roundtrip / gameplay_state_roundtrip / safari / cross-browser` 不回归

### 1.2 本轮不做的事

- 不继续新增 mode / 玩法系统大改
- 不新开 `betting_state_json` 第二套并行 authority
- 不把整个 archive 全量原样持久化
- 不做原生客户端壳

---

## 2. 推荐的 authority 设计

### 2.1 设计原则

优先继续沿用现有 `Scenario.gameplay_state_json`，不要再新建另一份状态主干。

原因：

- 目前 `director_state_json + gameplay_state_json` 的边界已经比较清楚：
  - `director_state_json`：导演层意图与承诺
  - `gameplay_state_json`：玩法层 raw 事件
- 再开新表或新 JSON 字段，只会扩大双写和漂移风险

### 2.2 建议的数据结构

在 `gameplay_state_json` 下扩到：

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

#### 为什么只放这三块

- `cards.usage_log`
  - 已经是 authority
- `betting.bets`
  - 是剩余跨设备一致最关键的 raw source
- `archive.key_moments / branch_snapshots`
  - 这两项是“结果页能否在无本地缓存时仍可读”的最低限度 raw context

#### 为什么不把更多 archive 字段直接塞进去

下面这些更适合作为派生值，而不是 authority：

- `mostUsedCard`
- `bettingHit`
- `archiveGrade`
- `directorStyleTag`
- `dominantBranchTitle`
- `dominantTone`
- `profileResonance`

这些都应该继续从：

- `usage_log`
- `bets`
- `branches`
- `story`

推导，而不是存成第三份真值。

---

## 3. 执行顺序

按这个顺序做，风险最低。

### Phase 1：后端 schema + API 契约

#### 目标

先把 `betting` 和最小 archive raw 结构接到后端，保证前端有读写通路。

#### 文件

- `backend/app/models/database.py`
- `backend/alembic/versions/008_*.py`
- `backend/app/services/campaign.py`
- `backend/app/api/campaign.py`
- `backend/app/api/schemas.py`
- `backend/app/api/helpers.py`

#### 具体动作

1. 扩 `DEFAULT_SCENARIO_GAMEPLAY_STATE`

建议：

```python
DEFAULT_SCENARIO_GAMEPLAY_STATE = {
    "cards": {"usage_log": []},
    "betting": {"bets": []},
    "archive": {
        "key_moments": [],
        "branch_snapshots": [],
    },
}
```

2. 在 `campaign.py` 里补：
   - `normalize_scenario_gameplay_state()`
   - `normalize_bet_entry()`
   - `normalize_archive_state()`

3. `GET/PUT /gameplay-state` 响应模型扩到：
   - `cards.usage_log`
   - `betting.bets`
   - `archive.key_moments`
   - `archive.branch_snapshots`

4. `GET /api/scenario/{id}` 回包一起带完整 `gameplay_state`

#### 验证

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_campaign_api.py tests/test_campaign_service.py -q
```

#### 验收

- 新增 `gameplay-state` roundtrip API 测试通过
- 无旧字段破坏

---

### Phase 2：前端 state merge / backfill

#### 目标

让前端从远端 `gameplay_state` 合并下注和 archive raw，不再只依赖本地 `scenarioMeta`

#### 文件

- `frontend/src/lib/scenarioGameplayState.ts`
- `frontend/src/types.ts`
- `frontend/src/api/client.ts`
- `frontend/src/pages/SimulationView.tsx`
- `frontend/src/pages/ResultView.tsx`
- `frontend/src/components/PredictionModal.tsx`
- `frontend/src/lib/scenarioMeta.ts`

#### 具体动作

1. 扩 `ScenarioGameplayState` TypeScript 类型：
   - `betting.bets`
   - `archive.key_moments`
   - `archive.branch_snapshots`

2. 扩 `scenarioGameplayState.ts`

新增：

- `scenarioMetaToGameplayState()`
  - 把本地：
    - `cards.usageLog`
    - `betting.bets`
    - `archive.keyMoments`
    - `archive.branchSnapshots`
    映射到远端 payload

- `mergeScenarioMetaWithGameplayState()`
  - union merge 逻辑：
    - `usage_log`: merge by stable key
    - `bets`: merge by `betId`
    - `key_moments`: 去重合并
    - `branch_snapshots`: 以 `branchId` 去重合并

3. `SimulationView.tsx`

新增或扩：

- `backendGameplayState` merge
- `persistGameplayState(nextMeta)`
- 在下注发生后也回写后端

4. `PredictionModal.tsx`

当前它只：

- `submitPrediction(...)`
- `placeBet(...)`

需要改成：

- 本地 `placeBet()` 之后，通过父层或回调把新 `meta` 同步到 `upsertScenarioGameplayState()`

建议方式：

- 仿照 `GameplayCardsModal onApplied`
- 给 `PredictionModal` 增加 `onPlacedBet(nextMeta)` 回调

5. `ResultView.tsx`

目标：

- 远端 `gameplay_state` 优先
- 无本地缓存时，仍能完整展示：
  - bet log
  - key moments
  - branch snapshots

#### 验证

```bash
cd frontend
npm test -- --run \
  src/lib/scenarioGameplayState.test.ts \
  src/pages/SimulationView.test.tsx \
  src/pages/ResultView.test.tsx
```

#### 验收

- `ResultView` 在 mock 的远端 `betting/archive` 下可完整渲染
- `SimulationView` 在远端有 bet log 时 automation state 正确

---

### Phase 3：archive 计算与展示收口

#### 目标

保证 archive 区块在“无本地缓存”前提下仍成立。

#### 文件

- `frontend/src/lib/archiveSummary.ts`
- `frontend/src/pages/ResultView.tsx`
- `frontend/src/pages/ResultView.test.tsx`

#### 具体动作

1. 审视 `buildArchiveSummary()` 的输入依赖：
   - `branches`
   - `usages`
   - `bets`
   - `keyMomentCount`

2. 结果页展示层保证这些输入全部能来自：
   - 远端 `gameplay_state`
   - 远端 `story / branches`
   - 本地仅作 fallback

3. archive 的“原始明细展示”与“派生摘要展示”分层：
   - raw:
     - bet list
     - key moments
     - branch snapshots
   - derived:
     - grade
     - resonance
     - dominant tone
     - style tag

#### 验收

- 结果页在清空 localStorage 后仍可读
- 仍不需要第三份 archive authority

---

### Phase 4：E2E roundtrip 收口

#### 目标

新增真正覆盖 bet + archive raw 的 roundtrip case

#### 文件

- `frontend/scripts/e2e-suite.mjs`
- `frontend/package.json`

#### 建议新增 case

在 `corners` 下补或扩：

- `betting_state_roundtrip`
- 或把 `gameplay_state_roundtrip` 扩成：
  - 先写 `gameplay_state.cards`
  - 再写 `gameplay_state.betting`
  - 再清空 `localStorage`
  - 分别打开：
    - `/sim/:id`
    - `/result/:id`

#### 应落盘的字段

```json
{
  "simulationDirector": {},
  "simulationBetting": {},
  "resultArchiveSummary": {},
  "resultBetList": [],
  "resultKeyMoments": [],
  "resultBranchSnapshots": []
}
```

#### 验证

```bash
cd frontend
npm run e2e:corners -- --url http://127.0.0.1:18928 --output-dir output/e2e/<run-id> --headless
```

#### 验收

- `gameplay_state_roundtrip` 不仅能回读 `usageLog`
- 还要能回读：
  - bet list
  - archive raw 区块

---

### Phase 5：Safari / cross-browser 回归

#### 目标

确保新增 gameplay raw state 不破坏 Safari 和 cross-browser smoke

#### 文件

- `frontend/scripts/e2e-suite.mjs`

#### 需要重跑

```bash
cd frontend
npm run e2e:cross-browser -- --url http://127.0.0.1:18928 --output-dir output/e2e/<run-id> --headless
npm run e2e:safari -- --url http://127.0.0.1:18928 --webdriver-url http://127.0.0.1:4444 --output-dir output/e2e/<run-id> --scenario-id 72ae364d-3ea1-4959-939c-8fe1dbeca1c9
```

#### 关注点

- `/sim`：
  - director summary
  - betting-related automation fields（如果新增）
- `/result`：
  - archive summary
  - bet list
- Safari：
  - 不追求完美整页视觉
  - 但 `result` 必须能读回新的 state

---

## 4. 具体文件清单

### 后端

- [database.py](/Users/yangjunjie/Desktop/upgrade-test/backend/app/models/database.py)
- [campaign.py](/Users/yangjunjie/Desktop/upgrade-test/backend/app/services/campaign.py)
- [campaign.py](/Users/yangjunjie/Desktop/upgrade-test/backend/app/api/campaign.py)
- [schemas.py](/Users/yangjunjie/Desktop/upgrade-test/backend/app/api/schemas.py)
- [helpers.py](/Users/yangjunjie/Desktop/upgrade-test/backend/app/api/helpers.py)
- `backend/alembic/versions/008_*`
- [test_campaign_api.py](/Users/yangjunjie/Desktop/upgrade-test/backend/tests/test_campaign_api.py)
- [test_campaign_service.py](/Users/yangjunjie/Desktop/upgrade-test/backend/tests/test_campaign_service.py)

### 前端

- [types.ts](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/types.ts)
- [client.ts](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/api/client.ts)
- [scenarioGameplayState.ts](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/lib/scenarioGameplayState.ts)
- [scenarioMeta.ts](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/lib/scenarioMeta.ts)
- [PredictionModal.tsx](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/components/PredictionModal.tsx)
- [SimulationView.tsx](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/pages/SimulationView.tsx)
- [ResultView.tsx](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/pages/ResultView.tsx)
- [archiveSummary.ts](/Users/yangjunjie/Desktop/upgrade-test/frontend/src/lib/archiveSummary.ts)
- [e2e-suite.mjs](/Users/yangjunjie/Desktop/upgrade-test/frontend/scripts/e2e-suite.mjs)

---

## 5. 风险与避免方式

### 风险 1：继续把派生值也写成 authority

坏处：

- 第三份真值
- `scenarioMeta / gameplay_state / campaign summary` 三边漂移

避免：

- raw only
- derived on read

### 风险 2：下注与结果页 summary 双写不一致

坏处：

- `betting_hit`、`bet_count`、bet list 对不上

避免：

- `finalizeCampaign()` 只吃派生值
- bet list 本身不再作为 finalize authority

### 风险 3：Safari 为了增强截图把正式入口搞脆

坏处：

- 正式 smoke 变成环境噪声

避免：

- `panel capture` 继续做 opt-in
- 默认 still stable path

### 风险 4：大范围改动导致视觉/E2E 回归

避免：

- 每个 phase 后先跑最小验证
- 不一次性跨 4 条链路一起改

---

## 6. 推荐执行命令顺序

```bash
cd /Users/yangjunjie/Desktop/upgrade-test/backend
source .venv/bin/activate
python -m pytest tests/test_campaign_api.py tests/test_campaign_service.py -q
```

```bash
cd /Users/yangjunjie/Desktop/upgrade-test/frontend
npm test -- --run src/lib/scenarioGameplayState.test.ts src/pages/SimulationView.test.tsx src/pages/ResultView.test.tsx
```

```bash
cd /Users/yangjunjie/Desktop/upgrade-test/frontend
npx tsc --noEmit -p tsconfig.app.json
npm run build
```

```bash
cd /Users/yangjunjie/Desktop/upgrade-test/frontend
npm run e2e:corners -- --url http://127.0.0.1:18928 --output-dir output/e2e/<run-id> --headless
```

```bash
cd /Users/yangjunjie/Desktop/upgrade-test/frontend
npm run e2e:cross-browser -- --url http://127.0.0.1:18928 --output-dir output/e2e/<run-id> --headless
```

```bash
cd /Users/yangjunjie/Desktop/upgrade-test/frontend
npm run e2e:safari -- --url http://127.0.0.1:18928 --webdriver-url http://127.0.0.1:4444 --output-dir output/e2e/<run-id> --scenario-id 72ae364d-3ea1-4959-939c-8fe1dbeca1c9
```

---

## 7. 完成判据

下次执行完成后，必须同时满足：

- `betting.bets` 已进入 `gameplay_state`
- `archive.key_moments / branch_snapshots` 已能跨设备回读
- `SimulationView` / `ResultView` 在无本地缓存时仍完整
- 新增 roundtrip E2E 通过
- `cross-browser` 通过
- `safari` 通过
- `tsc + build + 定向单测` 通过

---

## 8. 执行后应同步的文档

本次先不自动改，等真正执行完再统一收口：

- `README.md`
- `llmdoc/overview/project.md`
- `llmdoc/overview/frontend.md`
- `llmdoc/overview/backend.md`
- `llmdoc/guides/development.md`
- `progress.md`

到时如果要做正式同步，再明确执行：

`使用 recorder agent 更新项目文档`

