# SwarmOracle — 实现归档索引

> 作用：给 `implement/` 建立清晰索引与阅读边界。这里默认只做归档导航，不承担当前真值。

## 读取规则

- 当前产品范围、交付状态与开发命令，以仓库根 `README.md` 和 `llmdoc/*` 为准。
- `implement/` 只保存：
  - 设计基线
  - 阶段性执行方案
  - 历史 code review / 测试快照
  - 已完成 roadmap 的归档收口
- `progress.md` 负责逐轮发现/修复/复验流水，同样不是当前真值。

## 状态标签

- `active archive`
  - 仍值得查阅的设计基线或收口文档。
- `historical snapshot`
  - 保留当时上下文，默认不要读入当前任务。
- `superseded archive`
  - 已被后续方案覆盖，只在追溯旧思路时读取。
- `merged into current docs`
  - 独立文件已消失或内容已并入 `README.md` / `llmdoc/*`。

## 推荐阅读顺序

默认不要直接扫整个目录。按需读取：

1. 先读本页，判断是否真的需要进入 `implement/`
2. 如果是主线当前设计基线，再读：
   - `11_optimization_roadmap.md`
   - `19_four_track_execution_plan.md`
   - `20_track_d_debate_arena_design_execution_plan.md`
   - `21_track_d_debate_arena_mvp_blueprint.md`
   - `22_cross_device_state_closure_plan.md`
   - `23_oracle_chambers_worldline_roundtable_execution_plan.md`
3. 如果只是查历史修复或旧方案，再按编号打开对应快照

## 文档目录

| # | 文件 | 状态 | 何时读取 |
|---|------|------|----------|
| 01 | `01_architecture_design.md` | historical snapshot | 追溯早期架构与 MVP 假设 |
| 02 | `02_backend_test_results.md` | historical snapshot | 查某轮后端测试快照 |
| 03 | `03_week1_3_code_review.md` | historical snapshot | 查早期 code review |
| 04 | `04_week4_code_review.md` | historical snapshot | 查阶段性 code review |
| 05 | `05_week4_implementation_plan.md` | historical snapshot | 查已完成计划的原始拆解 |
| 06 | `06_frontend_code_review.md` | historical snapshot | 查阶段性前端 review |
| 07 | `07_realtime_streaming_ux.md` | historical snapshot | 查某轮实时流与 UX 修复背景 |
| 09 | `09_multi_agent_context_analysis.md` | historical snapshot | 查上下文工程研究思路 |
| 10 | `10_context_optimization_feasibility.md` | historical snapshot | 查上下文优化可行性评估 |
| 11 | `11_optimization_roadmap.md` | active archive | 旧 roadmap 的归档收口，不再当未来待办 |
| 12-17 | 无独立文件 | merged into current docs | 对应事实已并入 `README.md` / `llmdoc/*` |
| 18 | `18_next_session_gameplay_art_replay_plan.md` | superseded archive | 追溯一版已过时的玩法/美术/回放计划 |
| 19 | `19_four_track_execution_plan.md` | active archive | 查四轨设计基线与已落地范围 |
| 20 | `20_track_d_debate_arena_design_execution_plan.md` | active archive | 查 Debate Arena 设计基线 |
| 21 | `21_track_d_debate_arena_mvp_blueprint.md` | active archive | 查 Debate MVP 蓝图与验收口径 |
| 22 | `22_cross_device_state_closure_plan.md` | active archive | 查 authority 收口设计 |
| 23 | `23_oracle_chambers_worldline_roundtable_execution_plan.md` | active archive | 查 Oracle Chambers / Roundtable 设计与剩余任务 |

## 当前建议

- 处理当前功能或代码时，优先使用：
  - `README.md`
  - `llmdoc/index.md`
  - `llmdoc/overview/*.md`
  - `llmdoc/guides/development.md`
- 只有在以下情况才打开 `implement/*`：
  - 需要追溯某个设计为什么这样做
  - 需要继续某条已存在但未完全结束的设计线
  - 需要核对历史约束、旧验收口径或归档方案

## 不应再做的事情

- 不要把 `01-10` 里的旧计划、旧 TODO、旧数量口径当当前任务清单。
- 不要把 `11 / 19 / 20 / 21 / 22 / 23` 的正文计划段逐字当当前真值；先看文件顶部状态说明，再结合 `README.md` 与 `llmdoc/*` 判断。
- 不要默认把整个 `implement/` 目录读进上下文。
