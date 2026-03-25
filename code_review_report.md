# SwarmOracle Full-Stack Deep Audit Report

> **审计类型**: 只读代码审查 + 自动化测试验证（五轮深潜）
> **覆盖范围**: 后端全服务 + 前端 WS / Store / Game Engine / API Client / Gameplay State
> **代码修改**: 无（Read-Only Audit）

---

## 测试基线

| Suite | Passed | Failed | Notes |
|-------|--------|--------|-------|
| Backend (全量, 排除 agent_group) | **1063 / 1063** | 0 | 3m44s |
| Backend (`test_agent_group.py`) | 13 / 14 | 1 | P0 parser fallback 缺 side-effect |
| Frontend (全量) | 363 / 366 | 3 | `llmProviderPolicy.test.ts` 缺 `disableUserQuota` 字段 |
| Debate (targeted) | **40 / 40** | 0 | service + API + prompts |
| Campaign (targeted) | **37 / 37** | 0 | service + API |

---

## 2026-03-25 状态校正（当前真值）

> 以下状态以 2026-03-25 的当前代码、定向测试与真实浏览器 E2E 为准。下文原始 `#1-#39` 条目保留，作为历史审计记录与编号对照。

### 当前复核结果

- 前端当前定向回归已通过：
  - `src/lib/llmProviderPolicy.test.ts + src/lib/predictionBetting.test.ts + src/stores/debateStore.test.ts + src/stores/simulationStore.test.ts`：`47 passed`
  - `src/hooks/useDebateWS.test.tsx + src/hooks/useSimulationWS.test.tsx + src/pages/InputView.test.tsx + src/i18n/locales.test.ts`：`30 passed`
  - `src/api/client.test.ts + src/hooks/useSimulationWS.test.tsx + src/hooks/useDebateWS.test.tsx + src/i18n/locales.test.ts`：`26 passed`
  - `src/game/managers/EventBridge.test.ts + src/game/PhaserGame.test.ts + src/game/scenes/WorldScene.test.ts + src/pages/SimulationView.test.tsx + src/lib/scenarioGameplayState.test.ts`：`66 passed`
  - `npx tsc --noEmit -p tsconfig.app.json`：通过
- 后端当前定向回归已通过：
  - `tests/test_predictions.py + tests/test_api.py + tests/test_runtime_lock.py + tests/test_vector_store.py`：`190 passed`
  - `tests/test_agent_group.py + tests/test_memory.py + tests/test_simulator.py + tests/test_config.py`：`142 passed`
  - `tests/test_debate_service.py + tests/test_llm_client.py + tests/test_runtime_lock.py + tests/test_api.py + tests/test_intervention.py`：`189 passed`
  - `tests/test_campaign_api.py + tests/test_corner_cases.py + tests/test_api.py`：`143 passed`
  - 对应 `ruff check`：通过
- 浏览器/E2E 当前结论：
  - 主模式 `corners` / `mobile` 套件可通过
  - Debate `full` 套件可完整跑通到 live / result / share
  - 中英切换、桌面/移动浏览器路径、Theater/Result/Share 的主流程当前可用
  - 移动端结果页操作区溢出已修复，后修复截图可见 `mobile-result.png`

### 已修复

- `#1` Parser fallback `group` 字段问题：已修复。`_generate_fallback_groups()` 现在会给 agent 回写 `group`
- `#2` 前端测试期望漂移：已修复。`llmProviderPolicy.test.ts` 已同步 `disableUserQuota`
- `#3` VectorStore 事件循环阻塞：已修复。`_acquire_write_lease()` 不再用 `time.sleep()` 轮询
- `#4` SQLite 锁争用：已修复。`runtime_lock_is_active()` 改为纯 `SELECT`
- `#5` DebateStore phase 回退：已修复。`setPhase()` 已加单调守卫
- `#6` / `#33` WS event 去重 O(n)：已修复。`useSimulationWS.ts` / `useDebateWS.ts` 已改为 bounded `Map`
- `#7` Prediction 缺少复合唯一约束：已修复。模型、SQLite 轻量迁移、Alembic migration、API 竞态兜底已补齐
- `#8` `predictionBetting.ts` 未处理未知 Tone ID：已修复。未知值回退为原始字符串
- `#9` / `#34` reconnectCount 日志时序：已修复。重连日志会先记录真实次数，再清零计数
- `#12` DirectorState 409 冲突静默恢复：已修复。当前会给用户可见反馈，并回拉最新 authority
- `#17` Campaign finalize post-rollback session 复用：已修复。当前代码已有 `session.expire_all()`
- `#23` Memory 压缩提示词截断失效：已修复。当前已改为配置化预算 + 两段式压缩 + 高信号优先保留
- `#27` `measure_provider_parallelism` 资源泄露：已修复。当前实现使用 `async with httpx.AsyncClient()`
- `#29` `branch_update` 缺少状态单调守卫：已修复。WS 事件路径已复用分支状态守卫
- `#32` `runtime_lock_is_active` 对只读检查使用 `BEGIN IMMEDIATE`：已修复
- `#35` `client.ts` 无瞬态错误重试机制：已修复。当前仅对安全读接口启用有限退避重试，写接口仍不自动重试
- `#11` 无分页查询风险：已修复。predictions 列表已带默认分页上限，`win_streak` 已改为分批扫描
- `#13` `JSON.stringify(normalizeGameplayState(...))` 深比较脆弱：已修复。当前已改成显式结构化比较
- `#14` Debate lock lease 过长：已修复。runtime lock lease 已收口到 `15 * 60`
- `#16` `_clone_branch_history` OOM 风险：已修复。当前已改成 batch 复制 rounds/messages，而非一次性 `.all()`
- `#18` `gameplay_contract.py` TOCTOU 竞争：已修复。当前已改成 `open + fstat`
- `#20` Daily Challenge 旋转脆弱性：已修复。当前已切到显式固定 rotation order
- `#21` / `#36` `social.py` 冗余表达式：已修复。当前已直接使用 `limit * 2`
- `#22` LLM runtime guard 表重复创建开销：已修复。当前已按 SQLite db path 做 ensure 缓存
- `#24` Blackboard 模式下无用 DB 查询：已修复。blackboard 有效上下文时不再先取 `recent_msgs`
- `#25` `get_pending_intervention_count` 内存效率：已修复。当前已改成 SQL `COUNT(*)`
- `#26` SQLite migration 默认值白名单过严：已修复。当前已允许常见单引号字符串默认值
- `#28` Config 缺少旧参数范围校验：已修复。当前已补 `BRANCH_PRUNE_THRESHOLD / FORK_SENSITIVITY`
- `#30` WS 端点 `_scenario_exists` / `_debate_exists` 阻塞事件循环：已修复。当前已改为 `asyncio.to_thread(...)`
- `#31` `runtime_lock.py` 每次调用新建/关闭 SQLite 连接：已修复。当前已做 per-thread connection reuse
- `#37` FastAPI 缺少全局未处理异常兜底：已修复。当前已有统一 `INTERNAL_ERROR` handler
- `#38` `EventBridge.stop()` 清理期间事件竞争：已收口。当前已在 listener 与 `stop()` 两侧做最小安全硬化
- `#39` `_generate_fallback_groups` 函数契约不清：已基本收口。helper 现与测试期望一致，当前不再作为独立缺陷追踪
- 额外修复（非原编号）：移动端结果页操作区溢出已修复，按钮不再挤出视口

### 不存在 / 不作为当前缺陷

- `#10` `scenarioGameplayDerivations.ts` 硬编码 `maxPoints = 3`
  - 当前前后端口径一致，更像未来配置化需求，不是当前错配 bug
- `#15` EventBridge 无 start 前注册保护
  - 当前测试与挂载契约就是“未 start 不接收事件”，属于设计取舍，不作为当前缺陷处理
- `#19` `lang_detect.py` 欧洲语言盲区
  - 代码层面仍存在，但当前产品只声明 EN/ZH 双语，不作为当前版本的优先缺陷

### 剩余项

- 当前剩余项已主要收敛为“未来扩展”或“设计取舍”：
  - `#10` 导演点数 `maxPoints = 3` 仍是前后端一致的固定口径，只有在准备做可配置规则时才值得推进
  - `#15` EventBridge 的 `on()` before `start()` 仍沿用当前生命周期契约，不作为缺陷处理
  - `#19` `lang_detect.py` 的欧洲语言盲区只有在产品要扩到 EN/ZH 之外时才值得继续投入

### 下一轮建议

1. 若继续投入，优先决定是否扩产品边界，而不是继续深挖当前缺陷单
2. 若要扩能力，三个自然方向是：
   - 扩多语言：再处理 `#19`
   - 扩配置化玩法：再处理 `#10`
   - 扩 EventBridge 生命周期语义：再讨论 `#15`

---

## P0 — 需立即修复

### [已修复] 1. Parser Fallback 未回写 `group` 字段

- **文件**: [parser.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/services/parser.py) `_generate_fallback_groups()`
- **症状**: `tests/test_agent_group.py` 失败，`KeyError: 'group'`
- **根因**: 函数生成分组但未将 `group` 字段写回 agent dict
- **影响**: 无 profile/手动分组的场景解析时，后续引用 `agent["group"]` 必崩

### [已修复] 2. 前端测试期望漂移

- **文件**: `llmProviderPolicy.test.ts`
- **症状**: 3 个测试失败，`disableUserQuota` 字段缺失
- **根因**: 生产 `loadLlmProviderPolicy()` 新增返回字段，测试未同步

---

## P1 — 运行时风险

### [已修复] 3. VectorStore 事件循环阻塞

- **文件**: [vector_store.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/services/vector_store.py) `_acquire_write_lease()`
- **问题**: 使用 `time.sleep()` 轮询写锁，在 FastAPI async context 中阻塞事件循环
- **建议**: 迁移至 `asyncio.to_thread()` 或 `asyncio.sleep()` 轮询

### [已修复] 4. SQLite 锁争用

- **文件**: [runtime_lock.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/services/runtime_lock.py) `runtime_lock_is_active()`
- **问题**: 用 `BEGIN IMMEDIATE` 执行只读检查，产生不必要的写锁争用
- **建议**: 改为 `BEGIN DEFERRED` 或简单 `SELECT`

### [已修复] 5. DebateStore Phase 回退

- **文件**: [debateStore.ts](file:///Users/yangjunjie/Desktop/upgrade-test/frontend/src/stores/debateStore.ts#L185-L193) `setPhase()`
- **问题**: 缺少单调递增守卫。乱序 WS 事件可将 phase 从 `closing` 回退到 `crossfire`
- **对比**: `mergeDebateSnapshot` 有 `laterPhase()` 守卫（L92），但 `setPhase()` 跳过了它
- **建议**: `setPhase` 内加 `laterPhase(current, incoming)` 检查

### [已修复] 6. WS Event 去重 O(n) 性能

- **文件**: [useSimulationWS.ts](file:///Users/yangjunjie/Desktop/upgrade-test/frontend/src/hooks/useSimulationWS.ts#L118) / [useDebateWS.ts](file:///Users/yangjunjie/Desktop/upgrade-test/frontend/src/hooks/useDebateWS.ts#L100)
- **问题**: `seenEventIdsRef.current.includes(meta.event_id)` 对 500 元素数组执行 O(n) 线性扫描
- **热路径**: 每条 WS 消息都触发此检查
- **建议**: 将 `string[]` 改为 `Set<string>`，去重后用 `delete` + `add` 维护 LRU 上限

### [已修复] 7. Prediction 模型缺少复合唯一约束

- **文件**: [predictions.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/models/predictions.py)
- **问题**: `Prediction` 表无 `(scenario_id, user_id)` 复合唯一约束，去重完全依赖应用层 check-then-insert
- **风险**: 高并发下同一用户可为同一 scenario 提交多条 prediction（TOCTOU 竞争）
- **建议**: 添加 `UniqueConstraint('scenario_id', 'user_id')` 或 `INSERT ... ON CONFLICT` 策略

### [已修复] 8. `predictionBetting.ts` 未处理未知 Tone ID

- **文件**: [predictionBetting.ts](file:///Users/yangjunjie/Desktop/upgrade-test/frontend/src/lib/predictionBetting.ts#L63-L66)
- **问题**: `getEndingToneLabel(tone)` 直接访问 `ENDING_TONE_OPTIONS[tone].zh`，若 `tone` 不在枚举内将抛 `TypeError: Cannot read properties of undefined`
- **建议**: 添加 fallback: `const match = ENDING_TONE_OPTIONS[tone]; if (!match) return tone;`

### [已修复] 9. WS reconnectCount 日志时序

- **文件**: [useSimulationWS.ts](file:///Users/yangjunjie/Desktop/upgrade-test/frontend/src/hooks/useSimulationWS.ts#L73-L88)
- **问题**: `reconnectCount.current = 0` 在 `logWsDebug` 之前执行，导致日志中 `reconnectCount` 始终为 0
- **影响**: 调试重连问题时丢失重连次数信息

### [不作为当前缺陷] 10. `scenarioGameplayDerivations.ts` 硬编码 maxPoints

- **文件**: [scenarioGameplayDerivations.ts](file:///Users/yangjunjie/Desktop/upgrade-test/frontend/src/lib/scenarioGameplayDerivations.ts#L44-L65)
- **问题**: `remainingPoints` 初始为 `3`，`director.maxPoints` 硬编码为 `3`，而非从 gameplay contract 动态读取
- **风险**: 若 contract 中 `maxPoints` 变更（如 A/B 测试），前端计算不一致
- **建议**: 从 contract 配置读取初始值，或添加参数传入

### [已修复] 11. 无分页查询风险

- **文件**: [scoring.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/services/scoring.py) `_calculate_win_streak()` + [predictions.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/api/predictions.py) `list_predictions()`
- **问题**: `_calculate_win_streak` 加载用户全部已评分 prediction 到内存；`list_predictions` endpoint 无默认 LIMIT
- **风险**: 高频用户可触发 OOM 或响应超时
- **建议**: 添加 `LIMIT` + 分页，win_streak 改用 SQL 窗口函数

---

## P2 — 架构改进建议

### [已修复] 12. DirectorState 409 冲突静默恢复

- **文件**: [useSimulationViewState.ts](file:///Users/yangjunjie/Desktop/upgrade-test/frontend/src/hooks/useSimulationViewState.ts#L276-L288)
- **问题**: `persistDirectorMeta` 捕获 409 后静默从服务端拉取最新状态覆盖本地，用户无通知
- **影响**: 用户操作（commitment 等）被他方覆盖时无感知
- **建议**: 409 恢复后通过 toast 提示用户"状态已被更新"

### [已修复] 13. `areScenarioGameplayStatesEquivalent` JSON 序列化比较

- **文件**: [scenarioGameplayState.ts](file:///Users/yangjunjie/Desktop/upgrade-test/frontend/src/lib/scenarioGameplayState.ts#L324-L329)
- **问题**: 使用 `JSON.stringify(normalizeGameplayState(left)) === JSON.stringify(normalizeGameplayState(right))` 做深度比较
- **当前可工作**: 因为 `normalizeGameplayState` 已执行 sort 规范化
- **脆弱点**: 若未来任何新字段未被 normalize 覆盖，JSON 键序差异将导致误判为"不等"
- **建议**: 使用结构化深比较（如 `lodash.isEqual` 或自定义 comparator）

### [已修复] 14. Debate Lock Lease 过长

- **文件**: [debate.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/services/debate.py#L1448) `run_debate_background()`
- **问题**: 运行时锁租约 `lease_seconds=60*60`（1 小时），正常辩论仅需几分钟
- **风险**: worker 崩溃后锁需 1 小时才自动释放
- **建议**: 缩短至 10-15 分钟，或引入心跳续租机制

### [不作为当前缺陷] 15. EventBridge 无 start 前注册保护

- **文件**: [EventBridge.ts](file:///Users/yangjunjie/Desktop/upgrade-test/frontend/src/game/managers/EventBridge.ts)
- **问题**: `on()` 可在 `start()` 前调用注册 handler，但 DOM listener 尚未挂载，事件不会被路由
- **影响**: HMR reload 时序错乱或 Phaser 初始化竞争可能导致事件静默丢失
- **建议**: `on()` 中检查 `this.active`，未 active 时 warn 或 buffer

### [已修复] 16. `_clone_branch_history` OOM 风险

- **文件**: [interventions.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/api/interventions.py)
- **问题**: 分支克隆一次性加载全部历史记录到内存，长运行模拟可能 OOM
- **建议**: 实现分页克隆或流式处理

### [已修复] 17. Campaign Finalize Post-Rollback Session 复用

- **文件**: [campaign.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/services/campaign.py#L1068-L1093)
- **问题**: `IntegrityError` 捕获后 `session.rollback()` 再重新查询，缺少 `expire_all()`
- **当前可工作**: 因为重新执行了 `session.exec(select(...))`
- **建议**: rollback 后显式 `session.expire_all()` 确保缓存清除

### [已修复] 18. `gameplay_contract.py` TOCTOU 竞争

- **文件**: [gameplay_contract.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/services/gameplay_contract.py)
- **问题**: mtime cache: `os.stat(path)` 和 `open(path)` 之间有窗口，文件可能被替换
- **影响**: 极低频（仅热更新 contract 文件时），但不满足原子性
- **建议**: 改为 `open()` 后用 `os.fstat(fd)` 获取一致 mtime

### [不作为当前缺陷] 19. `lang_detect.py` 欧洲语言盲区

- **文件**: [lang_detect.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/services/lang_detect.py)
- **问题**: 仅检测 CJK / 阿拉伯 / 泰文，法语/德语/西班牙语的重音字符 fallback 到 `en`
- **建议**: 添加拉丁扩展字符检测

### [已修复] 20. Daily Challenge 旋转脆弱性

- **文件**: [daily_challenges.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/services/daily_challenges.py) `_day_index()`
- **问题**: 基于 1970 epoch 的 `days_since_epoch % len(challenges)` 计算
- **影响**: 添加/删除 challenge 后，所有日期的挑战映射全部移位
- **建议**: 改用 hash-based 分配或固定 challenge-to-date 映射表

### [已修复] 21. `social.py` 死代码

- **文件**: [social.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/api/social.py) `_bound_social_generation_buffer()`
- **问题**: `safety_limit = max(limit * 2, limit)` 永远等于 `limit * 2`（因为 `limit * 2 >= limit` 恒成立当 `limit >= 0`）
- **影响**: 无功能影响，但增加代码阅读困难度

---

## Round 4 — 深层探索发现

### [已修复] 22. LLM Runtime Guard 表重复创建开销

- **文件**: [llm_client.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/services/llm_client.py) `_ensure_runtime_guard_table()`
- **问题**: 每次 `_reserve_sqlite_runtime_slot` 调用都执行 `CREATE TABLE IF NOT EXISTS` + 2 条 `CREATE INDEX IF NOT EXISTS`，无缓存标志
- **影响**: 高并发下每个 LLM 请求都产生 3 条额外 DDL 语句的 SQLite 开销
- **建议**: 添加模块级 `_table_ensured = False` 标志，首次之后短路跳过

### [已修复] 23. Memory 压缩提示词截断失效

- **文件**: [memory.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/services/memory.py#L161-L168) `compress_rounds()`
- **问题**: `max_chars=max(4000, len(messages_text))` — 当 `messages_text` 长度超过 4000 时，`max_chars` 等于输入长度本身，截断逻辑失效
- **影响**: 长对话窗口的 `format_untrusted_text_block` 不会截断任何内容，prompt 体积无上限
- **建议**: 使用固定上限 `max_chars=8000` 或配置化的上限值

### [已修复] 24. `_gather_agent_messages` 在 Blackboard 模式下无用 DB 查询

- **文件**: [simulator.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/services/simulator.py#L1514) `_gather_agent_messages()`
- **问题**: L1514 `recent_msgs = _get_recent_messages(engine, branch_id, max_rounds=2)` 在每轮都执行，但 Blackboard 模式下 `shared_text` 非空时完全不使用 `recent_msgs`
- **影响**: Blackboard 模式下每轮每分支浪费一次 DB JOIN 查询
- **建议**: 将 `_get_recent_messages` 延迟到 fallback 路径内执行

### [已修复] 25. `get_pending_intervention_count` 内存效率

- **文件**: [simulator.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/services/simulator.py) `get_pending_intervention_count()`
- **问题**: 加载全部 `PendingIntervention` 行到 Python 后 `len()` 计数，而非使用 `SELECT COUNT(*)`
- **影响**: 干预数量大时产生不必要的内存开销
- **建议**: 改用 `select(func.count()).where(...)` SQL 原生计数

### [已修复] 26. SQLite Migration 默认值白名单过于严格

- **文件**: [database.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/models/database.py) `_migrate_add_column()`
- **问题**: 仅接受 `'0'` 和 `'1'` 作为 `default` 参数；未来需要空字符串、`'N/A'`、或 JSON 默认值的迁移将直接失败
- **建议**: 改用参数化或扩展白名单至常见默认值

### [已修复] 27. `measure_provider_parallelism` 资源泄露

- **文件**: [llm_client.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/services/llm_client.py) `measure_provider_parallelism()`
- **问题**: 每次调用创建新的 `httpx.AsyncClient` 而不复用已有共享实例
- **影响**: 频繁调用可导致连接池/文件描述符泄露
- **建议**: 使用 `_get_shared_async_client()` 或将新 client 包裹在 `async with` 中确保关闭

### [已修复] 28. Config 缺少数值范围校验

- **文件**: [config.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/config.py)
- **问题**: `BRANCH_PRUNE_THRESHOLD`、`FORK_SENSITIVITY`、`MAX_ROUNDS`、`MAX_BRANCHES` 均无范围校验
- **影响**: 环境变量误设（如 `BRANCH_PRUNE_THRESHOLD=2.0` 或 `MAX_ROUNDS=-1`）将导致运行时异常或无限循环
- **建议**: 添加 Pydantic `Field(ge=0, le=1)` 或 `@validator` 范围检查

### [已修复] 29. `branch_update` WS 事件缺少状态单调守卫

- **文件**: [simulationStore.ts](file:///Users/yangjunjie/Desktop/upgrade-test/frontend/src/stores/simulationStore.ts#L424-L432) `handleWSEvent('branch_update')`
- **问题**: 直接用 `event.data.status` 覆盖分支状态，无单调递增检查。乱序 WS 事件可将已 `COMPLETED` 的分支回退为 `ACTIVE`
- **对比**: `mergeBranch()` (L132-140) 已实现此守卫，但 `branch_update` 事件未使用它
- **建议**: 在 `branch_update` handler 中加入 `status_rank` 检查或复用 `mergeBranch` 逻辑

---

### Round 4 正面确认（修正先前发现）

| 先前发现 | Round 4 确认 | 状态 |
|----------|-------------|------|
| P1-6: `seenEventIds` O(n) (useSimulationWS) | `simulationStore.ts` 使用 `Set<string>` 实现去重 ✅ | **已正确实现** |
| P1: 分支状态回退 | `mergeBranch()` 有状态守卫 ✅ | **仅 snapshot merge 覆盖**，WS 事件路径未保护 |
| P1: 消息无上限 | `MAX_MESSAGES = 5000` + `slice` 截断 ✅ | **已正确实现** |

---

## Round 5 — 未探索代码路径深潜

### [已修复] 30. WS 端点 `_scenario_exists` / `_debate_exists` 阻塞事件循环

- **文件**: [ws.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/api/ws.py#L148-L151), [debate.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/api/debate.py#L58-L61)
- **问题**: `_scenario_exists()` 和 `_debate_exists()` 在 `async def` WebSocket handler 中直接调用同步 SQLite `session.get()`，阻塞 asyncio 事件循环
- **影响**: WS 连接握手期间所有并发请求被阻塞，高连接频率下可测量到延迟尖峰
- **建议**: 使用 `asyncio.to_thread(...)` 或异步 DB session 包装

### [已修复] 31. `runtime_lock.py` 每次调用创建/关闭新 SQLite 连接

- **文件**: [runtime_lock.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/services/runtime_lock.py#L105-L143)
- **问题**: `acquire_runtime_lock`、`release_runtime_lock`、`runtime_lock_is_active` 每次都执行 `sqlite3.connect()` + `conn.close()`，无连接复用
- **影响**: 每个 LLM 调用路径（acquire → release）产生 2 次全新 SQLite 连接握手，高并发下增加文件锁争用和 I/O 开销
- **建议**: 引入模块级连接池或 per-thread 复用连接，减少握手次数

### [已修复] 32. `runtime_lock_is_active` 对只读检查使用 `BEGIN IMMEDIATE`

- **文件**: [runtime_lock.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/services/runtime_lock.py#L159)
- **问题**: 纯读操作（检查锁是否存在）使用 `BEGIN IMMEDIATE`，获取排他写锁
- **影响**: 阻塞其他并发的 acquire/release 操作，降低吞吐量
- **建议**: 使用 `BEGIN DEFERRED`（默认）或直接 `SELECT` 即可

### [已修复] 33. `useDebateWS` 使用 `Array.includes()` 进行事件去重

- **文件**: [useDebateWS.ts](file:///Users/yangjunjie/Desktop/upgrade-test/frontend/src/hooks/useDebateWS.ts#L22-L29)
- **问题**: `seenEventIdsRef = useRef<string[]>([])`，L100 使用 `seenEventIdsRef.current.includes()` — O(n) 线性扫描
- **对比**: `simulationStore.ts` 已正确使用 `Set<string>`
- **影响**: 长时间辩论中 500 条事件 ID 列表的线性搜索可察觉到性能退化
- **建议**: 将 `string[]` 替换为 `Set<string>`，与 `simulationStore` 保持一致

### [已修复] 34. `useDebateWS.onopen` 日志丢失真实 `reconnectCount`

- **文件**: [useDebateWS.ts](file:///Users/yangjunjie/Desktop/upgrade-test/frontend/src/hooks/useDebateWS.ts#L61-L73)
- **问题**: L64 `reconnectCount.current = 0` 在 L67-69 日志记录**之前**执行，导致总是记录 `reconnectCount: 0`
- **影响**: 丢失重连次数诊断信息，难以调试间歇性连接问题
- **建议**: 将日志行移到 reset 之前，或使用局部变量保存 reset 前的值

### [已修复] 35. `client.ts` 无瞬态错误重试机制

- **文件**: [client.ts](file:///Users/yangjunjie/Desktop/upgrade-test/frontend/src/api/client.ts#L160-L175)
- **问题**: `request()` 函数对 503/429/5xx 等瞬态错误无任何重试逻辑，一次失败即终止
- **影响**: LLM 后端短暂过载时用户立即看到错误，而非等待恢复
- **建议**: 对 503/429 加入 1-2 次指数退避重试，或在 `fetchWithTimeout` 层实现

### [已修复] 36. `social.py` `_bound_social_generation_buffer` 冗余表达式

- **文件**: [social.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/api/social.py#L209)
- **问题**: `safety_limit = max(limit * 2, limit)` — 当 `limit >= 0` 时 `limit * 2 >= limit` 恒为真，`max()` 无效
- **影响**: 不影响正确性，但降低代码可读性且暗示逻辑意图不清晰
- **建议**: 直接使用 `safety_limit = limit * 2` 或添加注释说明设计意图

### [已修复] 37. FastAPI 缺少全局未处理异常兜底

- **文件**: [main.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/main.py)
- **问题**: 无 `@app.exception_handler(Exception)` 或中间件级全局异常处理，非 `HTTPException` 的异常将返回 FastAPI 默认的 500 Internal Server Error（可能泄露堆栈跟踪）
- **影响**: (1) 生产环境可能向客户端暴露内部异常详情；(2) 无统一的错误响应格式
- **建议**: 添加全局 `Exception` handler，返回统一 `{"code": "INTERNAL_ERROR", "message": "..."}` 格式

### [已收口] 38. `EventBridge.stop()` 清理期间的事件竞争

- **文件**: [EventBridge.ts](file:///Users/yangjunjie/Desktop/upgrade-test/frontend/src/game/managers/EventBridge.ts#L65-L73)
- **问题**: `stop()` 先移除 DOM 事件监听器，再 `handlers.clear()` — 如果在两步之间有 WS 事件恰好触发了 `dispatchVizEvent()`，handler 仍然会被调用（因为 handler 集合还未清空）
- **影响**: 极低概率的 teardown 期间 handler 执行导致对已卸载 Phaser 场景的操作
- **建议**: 在 `stop()` 开头设置 `this.active = false` 并在事件分发处检查

### [已收口] 39. `_generate_fallback_groups` 已知 P0（Round 1）再确认

- **文件**: [parser.py](file:///Users/yangjunjie/Desktop/upgrade-test/backend/app/services/parser.py#L755-L779)
- **确认**: Round 5 全文精读证实：`_generate_fallback_groups` 只构建 `groups` 列表返回，**不写回** `group` 字段到 `agents` 字典。已有的修复路径是 L711（`_apply_group_memberships`），但 L710 调用 `_generate_fallback_groups` 后才调用 — 问题在于中间路径（仅调用 `_generate_fallback_groups` 不经过 `_apply_group_memberships` 的情况是否存在）。当前代码中 L541 (`_build_parser_fallback_result`) 先调用 `_generate_fallback_groups` 再调用 `_apply_group_memberships`，所以 **fallback path 安全**。真正的 P0 只在 L710-711 中已被修复。
- **结论**: **降级为 P2（代码清晰度问题）** — 功能上已通过 L711 修复，但 `_generate_fallback_groups` 的函数契约不明确（副作用 vs 纯函数）

---

## 安全与配置

| 项目 | 状态 | 备注 |
|------|------|------|
| SQL 注入 | ✅ 安全 | 标识符白名单 + 参数化查询 |
| 输入长度 | ✅ 受控 | `format_untrusted_text_block` 截断用户输入 |
| CORS | ⚠️ 硬编码 | `localhost:5173`，生产需环境变量覆盖 |
| OCC | ✅ 实现 | Campaign state 使用 revision + SQL-level CAS |
| 防重入 | ✅ 双层 | in-memory guard + SQLite lease lock |
| ChromaDB | ✅ 优雅降级 | 懒导入，缺失时自动降级 |

---

## 架构亮点

1. **Campaign OCC 模式**: `save_scenario_director_state` 使用 `json_extract($.revision)` + `WHERE rowcount=1` 实现数据库层面的乐观并发控制，race condition 处理完善
2. **Debate Anti-Reentrancy**: 双层防护（in-memory `_try_mark_debate_running` + SQLite `acquire_runtime_lock`），`finally` 确保释放
3. **WS Sequence Gap Recovery**: 前端检测到 sequence gap 后自动触发 REST resync，有效防止消息丢失
4. **Badge Unlock Idempotency**: 使用 `on_conflict_do_nothing` + `rowcount` 检查，天然幂等
5. **Debate Scoring Determinism**: 使用 SHA-256 seed 确保相同问题产生确定性评分，replay 完全可复现
6. **Gameplay Authority Pattern**: `scenarioGameplayState.ts` 精心实现了 local-vs-remote 权限合并——通过 `hasOwnKey` 检测后端是否声明各字段子系统的 authority，避免覆盖未同步的本地状态

---

## 测试覆盖盲区

> 以下模块无或仅有极少的专项测试：

| 模块 | 现状 | 风险 |
|------|------|------|
| `vector_store.py` 写锁竞争 | 无并发测试 | 事件循环阻塞 |
| WS reconnection flow | 无集成测试 | 重连后状态不一致 |
| `blackboard.py` 压缩超时 | 无边界测试 | Staleness 传播 |
| `_clone_branch_history` 大数据量 | 无压力测试 | OOM |
| Debate WS + Store phase 回退 | 无测试 | UI 状态异常 |
| `predictionBetting.ts` 未知 tone ID | 无测试 | Runtime TypeError |
| Prediction 并发去重 | 无竞态测试 | 重复 prediction |
| DirectorState 409 冲突恢复 UX | 无测试 | 静默覆盖用户操作 |
