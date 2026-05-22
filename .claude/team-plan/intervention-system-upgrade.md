# Intervention System Upgrade — Claude Code `/ccg:team-exec` Plan

> **Status:** ready for Claude Code team execution after Gate 0 truth calibration.
> This plan is based on current `upgrade-test` source, `llmdoc`, and
> `.claude/team-plan/intervention-system-upgrade-research.md` as of 2026-05-22.
> If current code/tests/browser evidence conflicts with this document, current
> evidence wins.

## Execute From Claude Code

Run from `/Users/yangjunjie/Desktop/upgrade-test`:

```text
/ccg:team-exec .claude/team-plan/intervention-system-upgrade.md
```

If the executor is exposed as `/ccg:team`, use:

```text
/ccg:team .claude/team-plan/intervention-system-upgrade.md
```

The first executor response must include:

1. Gate 0 command/read results.
2. Execution DAG and safe parallel groups.
3. File write locks and serial sections.
4. Dirty tree classification.
5. GO / NO GO decision for entering Phase 1.

Do not enter write mode until those five items are present.

## Paste This Into Claude Code

```text
你在 /Users/yangjunjie/Desktop/upgrade-test 工作。

请使用 /ccg:team-exec 执行：

/ccg:team-exec .claude/team-plan/intervention-system-upgrade.md

硬性要求：
1. 先读 llmdoc/index.md、llmdoc/overview/project.md、
   llmdoc/overview/backend.md、llmdoc/overview/frontend.md、
   llmdoc/overview/backlog.md、llmdoc/guides/development.md。
2. 再读 .claude/team-plan/intervention-system-upgrade-research.md 和本 plan。
   .claude/ 被 .gitignore 忽略，必须直接读取文件；git diff/status 不会显示它。
3. Phase 0 必须重新核对当前源码、测试、脚本、CI 和 lockfile。
   不要默认本 plan 或 research 里的行号仍然准确。
4. Claude 主 agent 只负责编排、拆分、同步、验收和最终判断；不要直接改代码。
5. Claude 使用 agent teams：安全可并行的调查、实现、测试、review 都拆给
   agent teams，避免主上下文快速膨胀。共享文件写入、迁移、locale JSON、
   同一组件重构、同一 Python 模块编辑必须串行或明确锁定写入边界。
6. 前端 UI/UX、交互、前端重构、CSS、a11y、responsive、i18n copy、
   浏览器体验和浏览器实测优先交给 Gemini：
   ~/.claude/bin/codeagent-wrapper --backend gemini "<bounded frontend task>" /Users/yangjunjie/Desktop/upgrade-test
   如果 Gemini 返回 429/quota/resource exhausted，记录 gemini-429-fallback=claude，
   再交给 Claude frontend worker agent；主 Claude 仍不直接改代码。
7. Codex 负责 backend、contracts、migration、API、tests、E2E scripts、
   非 UI TypeScript logic、bug fix、review、adversarial review 和 cross-review。
   Codex 必须通过 Claude Code 中已安装的 codex-plugin-cc 调用，使用默认模型；
   不传 --model / --effort，除非用户另行要求。
8. Codex 调用路由：
   - implementation/fix/continue: /codex:rescue --background --fresh <bounded task>
   - review: /codex:review --background --scope working-tree
   - adversarial review: /codex:adversarial-review --background --scope working-tree <risk focus>
   - lifecycle: /codex:status, /codex:result, /codex:cancel
   不要用 Skill(codex:review) 或 Skill(codex:adversarial-review)。
9. 给 Codex 的每个实现/修复/review prompt 都必须写明：
   在安全可行时尽可能使用 sub-agents / multi-agents，不限制安全可并行
   sub-agent 数量；只读调查、独立测试、互不冲突文件可并行；
   共享写入、迁移、同一文件编辑必须串行。
10. 每个 Phase/Sprint/Gate 完成后必须：
    - 跑本阶段最小验证；
    - 对用户可见改动做真实浏览器实测；
    - 调用 /codex:adversarial-review --background --scope working-tree；
    - 修复 confirmed blocker；
    - 再做 Claude + Codex cross-review；
    - 得出 GO / CONDITIONAL GO / NO GO，再决定是否进入下一阶段。
11. 必须考虑跨浏览器、i18n、Windows/macOS/Linux：
    - 浏览器：Chromium、Firefox、WebKit；desktop 和 375px mobile。
    - i18n：zh/en key parity、placeholder parity、语言切换不混文案。
    - OS：代码和脚本按 Windows/macOS/Linux 可移植性设计；没有对应实测/CI
      结果时，不得写“三端已通过”。
12. 不自动更新 llmdoc、README 或项目文档。只有用户明确确认
    “使用 recorder agent 更新项目文档”后才更新项目文档。

完成后汇报：
- 修改了哪些文件
- 每个 Phase 实际完成/跳过/阻塞项
- 运行过的命令和结果
- 浏览器/移动端/a11y/i18n/OS 复核结果
- 仍然没有解决的风险
```

## Gate 0 — Read-Only Truth Calibration

**Owner:** Claude orchestrator + parallel read-only agent teams. No file writes.

Required reads:

```text
llmdoc/index.md
llmdoc/overview/project.md
llmdoc/overview/backend.md
llmdoc/overview/frontend.md
llmdoc/overview/backlog.md
llmdoc/guides/development.md
.claude/team-plan/intervention-system-upgrade-research.md
.claude/team-plan/intervention-system-upgrade.md
frontend/package.json
backend/pyproject.toml
docker-compose.yml
.github/workflows/ci.yml
backend/app/api/interventions.py
backend/app/api/schemas.py
backend/app/models/database.py
backend/app/services/simulator.py
backend/app/services/replay.py
backend/app/api/helpers.py
backend/app/api/campaign.py
frontend/src/components/InterventionModal.tsx
frontend/src/components/InterventionReceiptCard.tsx
frontend/src/pages/SimulationView.tsx
frontend/src/stores/simulationStore.ts
frontend/src/types.ts
frontend/src/api/client.ts
```

Required commands:

```bash
pwd
git status --short
git check-ignore -v .claude/team-plan/intervention-system-upgrade.md || true
find backend/alembic/versions -maxdepth 1 -type f -name "*.py" | sort | tail -20
rg -n "runs-on:|windows-latest|macos|ubuntu" .github/workflows -g "*.yml"
```

Gate 0 must record:

- current Alembic head file; current observed head is `032_intervention_lifecycle.py`.
  If unchanged, the next migration is expected to be a `033_*` revision, but executor
  must verify head before creating it.
- frontend toolchain; current observed frontend package manager is `npm@11.12.1`
  with `frontend/package-lock.json`. Do not use pnpm/yarn unless lockfiles change.
- current CI OS coverage; current workflows use `ubuntu-latest` only. Do not claim
  Windows/macOS CI unless workflows change and run.
- dirty tree classification. Do not revert unrelated user changes.

Gate 0 NO-GO conditions:

- target files have unrelated user edits that cannot be safely merged;
- current code has already implemented one of the phases differently and this plan
  would regress it;
- migration head or database bootstrap contract cannot be determined;
- required browser/runtime dependencies are unavailable and no safe fallback is possible.

## Current Truth Constraints

These are the verified surfaces after the current intervention upgrade. Future
work should still re-check them before writing.

- Existing intervention endpoints:
  - `POST /api/scenario/{id}/intervene`
  - `POST /api/scenario/{id}/intervene/retrospective`
  - `POST /api/scenario/{id}/intervene/batch`
  - `GET /api/intervention-templates`
- `InterveneRequest` supports `branch_id / text / card_id / profile_id / directive`.
  `RetrospectiveInterveneRequest` supports `branch_id / round_number / text`.
  `BatchInterveneRequest` caps items at 50.
- `Branch` already has replay provenance fields:
  `replay_kind / replay_source_branch_id / replay_source_round /
  replay_source_agent_id`.
- `InterventionLog` has lifecycle `status`, `effect_summary_json`, and nullable
  `impact_summary_json`. There is still no LLM impact-summary generator.
- `PendingIntervention` has durable queue metadata:
  `metadata_json / status / claim_token / claimed_at / lease_expires_at /
  failure_reason / display_text`.
- Immediate and batch interventions now accept only `ScenarioStatus.SIMULATING`.
  `NARRATING / DONE / ERROR / CANCELLED` return `409`.
- Persisted queue processing now claims a row first, refreshes/clears stale claims,
  deletes after successful injection, and marks failed claims instead of
  delete-before-process.
- Immediate and batch persisted paths write `InterventionLog` and
  `PendingIntervention` in one session transaction. The in-memory fallback remains
  for non-file test databases after the durable commit path.
- Retrospective intervention uses the shared replay clone helper, regenerates from
  the selected source round, writes `replay_kind="retrospective"` with source
  branch/round provenance, and cleans up branch/log state if scheduling fails.
- `compare_branches()` recognizes both counterfactual and retrospective
  intervention context.
- Effect receipt remains deterministic and additive. `impact_summary` stays
  nullable/fallback-safe until a real generator is implemented and tested.
- Frontend `simulationStore` handles `intervention_applied`,
  `batch_intervention_applied`, `intervention_injected`, `retrospective_start`, and
  receipt-ready lifecycle transitions.
- `InterventionModal` keeps `standard / retrospective / batch` modes, uses
  pressed-button semantics, consumes bilingual templates with structured
  `variables`, and falls back safely when older template responses omit variables.
- `InterventionReceiptCard` renders pending/injected lifecycle placeholders before
  completion and fetches persisted receipts after the completed receipt surface is
  enabled.
- Existing browser scripts for gameplay surfaces are fixture-first and support
  `--browser chromium|firefox|webkit`, `desktop|mobile|full`, `--url`,
  `--backend-url`, `--headless`, and `--output-dir`.
- Existing Docker compose is Linux-container smoke only. It is useful for Linux-like
  build/runtime validation, not proof that native Windows/macOS passed.

## Orchestration Contract

### Claude Main Agent

- Owns DAG, delegation, context control, gate decisions, conflict resolution, and
  final synthesis.
- Must not directly edit production code, tests, styles, migrations, scripts, or
  locale files.
- Uses agent teams aggressively for read-heavy, implementation-heavy, test-heavy,
  and browser-heavy work.
- May only edit this plan if the user explicitly asks.

### Gemini Route

Gemini is primary for frontend UI/UX, visual design, component structure, CSS,
a11y, responsive layout, i18n copy, and browser experience.

```bash
~/.claude/bin/codeagent-wrapper --backend gemini "<bounded frontend task>" /Users/yangjunjie/Desktop/upgrade-test
```

If Gemini hits `429`, quota, resource exhausted, or equivalent capacity failure:

- record `gemini-429-fallback=claude`;
- route the same bounded task to a Claude frontend worker agent;
- keep Claude main agent in orchestration mode.

### Codex Route

Codex owns backend, contracts, migrations, API, tests, E2E scripts, non-UI TS logic,
bug fixes, review, adversarial review, and cross-review.

```text
/codex:rescue --background --fresh <bounded implementation or bug-fix task>
/codex:review --background --scope working-tree
/codex:adversarial-review --background --scope working-tree <risk focus>
/codex:status
/codex:result
/codex:cancel
```

Rules:

- use Codex default model through `codex-plugin-cc`;
- do not pass `--model`, `--effort`, or `--wait` unless the user explicitly asks;
- do not call slash commands through `Skill(...)`;
- every prompt must require safe sub-agents / multi-agents and serial handling of
  unsafe shared writes.

### Safe Parallelism

Parallelize:

- read-only truth checks by backend/frontend/tests/browser/docs dimensions;
- independent backend and frontend tasks with disjoint write sets;
- independent package validations after implementation;
- browser checks across browsers/viewports after app servers are stable;
- Codex review and Gemini UI review when neither writes files.

Serialize:

- Alembic migration + SQLModel changes;
- edits to `backend/app/api/interventions.py`;
- edits to `backend/app/services/simulator.py`;
- locale JSON changes;
- `frontend/src/types.ts` and shared API contract changes;
- `SimulationView.tsx` when multiple frontend tasks need it;
- package/script edits;
- gate decisions and final merge decisions.

### Required Gate Loop

Every Phase/Sprint/Gate uses this loop:

1. Claude states the current execution graph, write locks, and delegated workers.
2. Workers implement or review only their assigned scope.
3. Run the smallest relevant validation first.
4. Run browser checks for user-visible changes.
5. Invoke Codex adversarial review:

```text
/codex:adversarial-review --background --scope working-tree
Focus: Phase <N> intervention-system-upgrade changes. Verify correctness,
migration safety, queue durability, replay provenance, prompt/display separation,
i18n, a11y, browser behavior, cross-platform script safety, and missing tests.
Cite exact files/lines. Do not speculate.
```

6. Fix confirmed issues through the correct worker:
   - backend/API/contracts/tests/migrations -> Codex `/codex:rescue`;
   - frontend UI/UX/CSS/a11y/i18n -> Gemini wrapper, Claude frontend worker on 429;
   - scripts/non-UI TS -> Codex unless Gemini owns the visible UI coupling.
7. Invoke Codex review:

```text
/codex:review --background --scope working-tree
Focus: Review the final Phase <N> diff after fixes. Findings first, exact
file/line evidence, no fabricated findings, include missing tests and residual risk.
```

8. Claude synthesizes GO / CONDITIONAL GO / NO GO.

## Execution DAG

Phase dependency graph:

```text
Gate 0 truth calibration
  -> Phase 1 schema + queue claim foundation
  -> Phase 2 API correctness + transaction boundaries
  -> Phase 3 retrospective replay contract
  -> Phase 4 frontend lifecycle + receipt UX
  -> Phase 5 templates, batch polish, and i18n completion
  -> Phase 6 full browser/signoff/OS-risk gate
```

Phase 1-3 touch shared backend files and should be mostly serial around
`interventions.py` and `simulator.py`. Phase 4-5 can start design review earlier,
but frontend writes must not land until backend event/API contract is stable.

## Phase 1 — Backend Schema And Queue Claim Foundation

**Primary worker:** Codex via `/codex:rescue`.

**Write locks:**

- `backend/app/models/database.py`
- `backend/alembic/versions/*`
- `backend/app/services/simulator.py`
- migration/fallback tests

**Scope:**

1. Verify current Alembic head before creating a new revision. This upgrade created
   `032_intervention_lifecycle.py`; if that remains the head, the next migration
   should be a `033_*` revision.
2. Add durable lifecycle fields to `PendingIntervention`:
   - `status`
   - `claim_token`
   - `claimed_at`
   - `lease_expires_at`
   - `failure_reason`
   - `display_text`
3. Add additive receipt lifecycle fields to `InterventionLog`:
   - `status`
   - nullable `impact_summary_json`
4. Add indexes needed for claim-by-scenario/branch/status.
5. Replace delete-before-process with claim/lease helpers:
   - `claim_next_pending_intervention`
   - `mark_intervention_injected`
   - `mark_intervention_failed`
   - expired claim handling or explicit no-retry decision with tests
6. Keep the in-memory fallback behavior test-only and explicit.
7. Fix `_pending_intervention_db_path()` for SQLite `file:` URI only if current code
   still falls back incorrectly.

**Do not do in Phase 1:**

- change endpoint behavior;
- change frontend types/UI;
- implement LLM impact summaries.

**Minimum validation:**

```bash
cd backend
source .venv/bin/activate
alembic upgrade head
alembic downgrade -1
alembic upgrade head
python -m pytest tests/test_interventions.py tests/test_fallback_migrations.py -q --tb=short
ruff check app/models/database.py app/services/simulator.py tests/test_interventions.py tests/test_fallback_migrations.py
```

If running on Windows PowerShell, use:

```powershell
cd backend
.venv\Scripts\Activate.ps1
python -m pytest tests/test_interventions.py tests/test_fallback_migrations.py -q --tb=short
```

Do not claim Windows passed unless that command actually ran on Windows.

## Phase 2 — API Correctness And Transaction Boundaries

**Primary worker:** Codex via `/codex:rescue`.

**Write locks:**

- `backend/app/api/interventions.py`
- `backend/tests/test_api.py`
- `backend/tests/test_intervention.py`
- `backend/tests/test_interventions.py`

**Scope:**

1. Change immediate and batch intervention gate to allow only
   `ScenarioStatus.SIMULATING` plus active branch.
2. Return stable business error for `NARRATING / DONE / ERROR / CANCELLED`.
   Prefer `409 INTERVENTION_SCENARIO_STATUS_INVALID`; update tests to match the
   final chosen contract.
3. Make immediate persisted queue path write `InterventionLog` and
   `PendingIntervention` in one DB transaction.
4. Keep batch persisted path atomic; do not regress it.
5. Decide and implement same-branch batch policy:
   - recommended first implementation: reject more than one item per branch with
     stable `422` code; or
   - merge same-branch items into one queued prompt with explicit response metadata.
   Do not leave implicit cross-round behavior hidden from the API/UI.
6. Ensure API/WS responses use user-visible text only, not model prompt text.

**Do not do in Phase 2:**

- rewrite retrospective behavior;
- add frontend lifecycle UI;
- add semantic/LLM effect analysis.

**Minimum validation:**

```bash
cd backend
source .venv/bin/activate
python -m pytest \
  tests/test_api.py::TestInterveneEndpoint \
  tests/test_intervention.py::TestBatchIntervention \
  tests/test_interventions.py \
  -q --tb=short
ruff check app/api/interventions.py app/services/simulator.py tests/test_api.py tests/test_intervention.py tests/test_interventions.py
```

## Phase 3 — Retrospective Replay Contract

**Primary worker:** Codex via `/codex:rescue`.

**Write locks:**

- `backend/app/api/interventions.py`
- `backend/app/services/replay.py`
- `backend/app/api/helpers.py`
- `backend/app/services/simulator.py`
- replay/counterfactual/retrospective tests

**Scope:**

1. Fix retrospective semantics so selected round is regenerated on the new branch,
   not treated as already completed old history.
2. Prefer shared replay clone/provenance machinery over bespoke branch clone code.
   If bespoke code remains, tests must prove it writes equivalent provenance.
3. Write retrospective provenance:
   - `replay_kind="retrospective"`
   - `replay_source_branch_id=<source branch>`
   - `replay_source_round=<selected round>`
   - `replay_source_agent_id=null`
4. Pre-acquire runtime lock before creating durable branch/log/pending rows, or
   implement rollback that proves no orphan branch/log/pending remains if scheduling
   cannot start.
5. Make `run_sim_background` failure visible to the caller for this path, or use a
   pre-acquired lease flow that cannot silently skip.
6. Extend compare digest so retrospective interventions can be identified without
   pretending they are counterfactual agent-message rewrites.
7. Keep quota and replay branch limit semantics explicit. If retrospective consumes
   the replay branch budget, tests must show it. If it uses simulation lock instead,
   document and test that boundary.

**Do not do in Phase 3:**

- change result page visual design;
- alter counterfactual behavior except where shared helpers require compatible tests;
- create hidden cross-worldline memory.

**Minimum validation:**

```bash
cd backend
source .venv/bin/activate
python -m pytest \
  tests/test_intervention.py::TestRetrospectiveIntervention \
  tests/test_replay.py \
  tests/test_counterfactual.py \
  tests/test_resume.py \
  -q --tb=short
ruff check app/api/interventions.py app/services/replay.py app/api/helpers.py app/services/simulator.py tests/test_intervention.py tests/test_replay.py tests/test_counterfactual.py tests/test_resume.py
```

## Phase 4 — Frontend Lifecycle, Receipt UX, And A11y

**Primary worker:** Gemini via `codeagent-wrapper`.
**Fallback:** Claude frontend worker only if Gemini 429/quota.
**Support:** Codex for non-UI TS contracts and review.

**Write locks:**

- `frontend/src/types.ts`
- `frontend/src/stores/simulationStore.ts`
- `frontend/src/stores/simulationStore.test.ts`
- `frontend/src/components/InterventionModal.tsx`
- `frontend/src/components/InterventionModal.css`
- `frontend/src/components/InterventionModal.test.tsx`
- `frontend/src/components/InterventionReceiptCard.tsx`
- `frontend/src/components/InterventionReceiptCard.css`
- `frontend/src/components/InterventionReceiptCard.test.tsx`
- `frontend/src/pages/SimulationView.tsx`
- `frontend/src/i18n/locales/en.json`
- `frontend/src/i18n/locales/zh.json`

**Scope:**

1. Update websocket types for the new `intervention_injected` payload:
   `intervention_id`, queue id if exposed, branch id, round, visible text, status,
   mode/card metadata as available.
2. Add a store-level intervention lifecycle:
   `queued -> injected -> observed -> receipt_ready`.
3. Handle `intervention_injected` instead of ignoring it.
4. Make ordinary interventions visible after modal close:
   - toast/status;
   - branch/timeline marker;
   - injected state when WS event arrives;
   - reduced-motion guard for pulse/animation.
5. Refactor mode tabs to accessible tab semantics or a simpler segmented control
   with correct roles. Current `role="tablist"` without tab buttons must not remain.
6. Add an explicit accessible label for the intervention text input. Do not rely on
   placeholder text as the only label.
7. Replace the hardcoded submitting label (`...` in current code) with locale-backed
   user-facing copy.
8. Add forced-colors coverage for intervention modal controls, matching the existing
   receipt/gameplay/prediction modal accessibility style.
9. Improve retrospective round selector with round context if backend/API provides
   enough data. If not, keep the selector simple but add copy that accurately says
   what will regenerate.
10. Make `InterventionReceiptCard` support live lifecycle state and persisted receipt
   state. It must not imply a receipt exists before backend data supports it.
11. Remove `branches.length` as the only refresh trigger; use lifecycle or explicit
   refresh nonce.
12. Preserve current no-leak guarantee: internal ids and backend model prompt text
   must not become visible UI.

**Do not do in Phase 4:**

- broad visual redesign of SimulationView;
- card/gameplay redesign unrelated to intervention lifecycle;
- raw HTML rendering for templates or receipts.

**Minimum validation:**

```bash
cd frontend
npm test -- --run \
  src/stores/simulationStore.test.ts \
  src/components/InterventionModal.test.tsx \
  src/components/InterventionReceiptCard.test.tsx \
  src/pages/SimulationView.test.tsx \
  src/api/client.test.ts \
  src/i18n/locales.test.ts
npx tsc --noEmit -p tsconfig.app.json
npm run lint
```

If locale files changed, also run key and placeholder parity:

```bash
cd frontend
node -e 'const fs=require("fs");function flat(o,p=""){const r={};for(const k of Object.keys(o)){const np=p?`${p}.${k}`:k;if(o[k]&&typeof o[k]==="object"&&!Array.isArray(o[k])) Object.assign(r,flat(o[k],np)); else r[np]=o[k];}return r;}const en=flat(JSON.parse(fs.readFileSync("src/i18n/locales/en.json","utf8")));const zh=flat(JSON.parse(fs.readFileSync("src/i18n/locales/zh.json","utf8")));const enKeys=Object.keys(en).sort();const zhKeys=Object.keys(zh).sort();const missingEn=zhKeys.filter(k=>!(k in en));const missingZh=enKeys.filter(k=>!(k in zh));const vars=s=>[...String(s).matchAll(/{{\s*([^}\s]+)\s*}}/g)].map(m=>m[1]).sort().join(",");const placeholderMismatch=enKeys.filter(k=>k in zh && vars(en[k])!==vars(zh[k]));console.log("en:",enKeys.length,"zh:",zhKeys.length,enKeys.length===zhKeys.length&&missingEn.length===0&&missingZh.length===0?"PARITY OK":"MISMATCH");console.log("placeholder parity:",placeholderMismatch.length===0?"OK":placeholderMismatch.join(","));if(missingEn.length||missingZh.length||placeholderMismatch.length) process.exit(1);'
```

## Phase 5 — Templates, Batch Polish, And Optional Impact Summary

**Primary worker:** Gemini for UI/template form, Codex for API contracts.

**Enter only if Phase 1-4 are GO.**

**Scope:**

1. Upgrade hardcoded templates only if the backend contract is made explicit:
   `id / localized label / variables / intervention_kind / suggested_targets`.
2. Render template variables as structured inputs instead of forcing users to edit
   raw `{type}` placeholders.
3. Keep old template response compatible until frontend and backend migrate together.
4. If adding `impact_summary` generation, do it as a separate optional subphase:
   - deterministic receipt remains primary;
   - LLM failure cannot block simulation;
   - no prompt text leaks into receipt/API/replay;
   - tests prove fallback and malformed output handling.
5. If hierarchical mode wording changes, make it truthful:
   either say only leaders receive the intervention, or pass safe metadata into
   worker synthesis with tests.

**Do not do in Phase 5:**

- full drama manager;
- global/cross-worldline memory;
- Mirofish-style linear report-first workflow.

**Minimum validation:**

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_interventions.py tests/test_campaign_api.py tests/test_gameplay_contract_sync.py -q --tb=short
ruff check app/api/interventions.py app/api/campaign.py app/services/simulator.py tests/test_interventions.py tests/test_campaign_api.py

cd ../frontend
npm test -- --run \
  src/components/InterventionModal.test.tsx \
  src/components/InterventionReceiptCard.test.tsx \
  src/components/GameplayCardsModal.test.tsx \
  src/i18n/locales.test.ts
npx tsc --noEmit -p tsconfig.app.json
npm run lint
```

## Phase 6 — Browser, Signoff, And OS Risk Gate

**Owner:** Claude orchestrates browser/test agents. Codex handles script failures.
Gemini reviews visible UI/a11y regressions.

Before browser checks:

```bash
cd frontend
npm run build
npm run preview -- --host 127.0.0.1 --port 18930
```

If backend is needed locally:

```bash
cd backend
source .venv/bin/activate
python -m uvicorn --app-dir /Users/yangjunjie/Desktop/upgrade-test/backend app.main:app --host 127.0.0.1 --port 18927
```

Gameplay surface browser matrix:

```bash
cd frontend
for b in chromium firefox webkit; do
  node scripts/e2e-gameplay-cards-modal.mjs full --browser "$b" --url http://127.0.0.1:18930 --backend-url http://127.0.0.1:18927 --headless
  node scripts/e2e-prediction-modal.mjs full --browser "$b" --url http://127.0.0.1:18930 --backend-url http://127.0.0.1:18927 --headless
  node scripts/e2e-intervention-receipt.mjs full --browser "$b" --url http://127.0.0.1:18930 --backend-url http://127.0.0.1:18927 --headless
done
```

Broader browser smoke:

```bash
cd frontend
node scripts/e2e-suite.mjs mobile --url http://127.0.0.1:18930 --headless
node scripts/e2e-suite.mjs cross-browser --url http://127.0.0.1:18930 --browsers firefox,webkit --headless
```

Release signoff only after phase gates are green:

```bash
cd frontend
npm run release:signoff -- --url http://127.0.0.1:18930 --backend-url http://127.0.0.1:18927 --headless
```

Linux-container smoke:

```bash
docker compose -p upgrade-test-intervention up --build -d
docker compose -p upgrade-test-intervention ps -a
curl -sS http://127.0.0.1:18927/ | head
```

OS wording:

- macOS: local browser evidence can be claimed only for commands actually run.
- Linux: Docker/Ubuntu CI evidence can be claimed only for commands/jobs actually run.
- Windows: code/scripts must avoid POSIX-only assumptions; without Windows runner/manual
  evidence, report Windows as "designed for portability, not verified".
- Edge/Safari: do not claim native Edge/Safari unless explicitly run through a real
  channel/WebDriver/BrowserStack/Sauce or manual evidence.

## Phase-Level File Ownership

Backend serial files:

```text
backend/app/api/interventions.py
backend/app/services/simulator.py
backend/app/models/database.py
backend/alembic/versions/*
```

Frontend serial files:

```text
frontend/src/types.ts
frontend/src/stores/simulationStore.ts
frontend/src/pages/SimulationView.tsx
frontend/src/i18n/locales/en.json
frontend/src/i18n/locales/zh.json
```

Frontend disjoint work can run in parallel only when write scopes do not overlap:

```text
InterventionModal.*       -> Gemini UI/a11y worker
InterventionReceiptCard.* -> Gemini receipt worker
frontend scripts/tests    -> Codex script/test worker when no UI rewrite overlap
```

## Success Criteria

The implementation is not complete until all applicable items are true:

- `NARRATING / DONE / ERROR / CANCELLED` ordinary and batch interventions do not
  return false success.
- Immediate persisted queue writes log + pending queue atomically.
- Pending queue no longer delete-before-processes without durable status/claim.
- `intervention_injected` event carries visible-safe fields and never exposes model
  prompt text.
- Frontend records and renders intervention lifecycle states.
- Retrospective intervention regenerates from the selected round with replay
  provenance and no orphan branch/log/pending on scheduling failure.
- Compare digest can identify retrospective intervention context truthfully.
- Batch same-branch behavior is explicit, tested, and visible to API/UI.
- Receipt API remains backward compatible and exposes only verified/additive fields.
- Any `impact_summary` is nullable/fallback-safe and never blocks simulation.
- zh/en key and placeholder parity pass when locale files change.
- Browser checks cover Chromium/Firefox/WebKit and desktop/mobile where user-visible
  surfaces changed.
- OS claims are limited to actual evidence.

## Current Verification Status

Status: completed for the current local intervention-upgrade evidence.

- Backend `python -m pytest tests/` passed with `3329 passed, 6 skipped`;
  `ruff check app/ tests/` passed.
- Frontend `npm test -- --run` passed with `206 files / 2328 tests passed`;
  `npx tsc --noEmit -p tsconfig.app.json`, `npm run lint`, and
  `npm run build` passed.
- i18n parity passed with `en: 2800`, `zh: 2800`, and matching placeholders.
- Browser checks passed for Chromium mobile and desktop Firefox/WebKit scoped
  cross-browser `e2e-suite` coverage.
- `node --check scripts/e2e-suite.mjs` passed after the cross-browser/mobile fix.
- Docker, native Safari/Edge, BrowserStack/Sauce, and real mobile devices were not
  rerun for this intervention upgrade.

## Global Non-Goals

- Do not introduce cross-worldline global memory.
- Do not build a full drama manager.
- Do not turn SwarmOracle into a generic chat or Mirofish-style report-first product.
- Do not expose backend/model prompt text through WS/API/replay/receipt.
- Do not use the existing completed no-receipt scenario as proof that intervention
  creation/injection/receipt write works.
- Do not auto-update `llmdoc`, README, or project docs unless the user explicitly
  asks for a documentation sync.
