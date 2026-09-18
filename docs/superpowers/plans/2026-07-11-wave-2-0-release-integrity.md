# Wave 2.0 Release Integrity Implementation Plan / Wave 2.0 发布完整性实施计划

> **历史计划记录 / Historical plan record — 2026-07-11**
>
> 本文保留 2026-07-11 的设计与任务语境。任务、命令、行号和预期结果均属历史记录，不是当前操作指引；复选框和批准状态不代表当前实施或验证结果。代码示例及其中的注释、字符串保留原文，中英文共用。
>
> This document preserves the design and task context of 2026-07-11. Tasks, commands, line numbers, and expected results are historical records, not current operating instructions. Checkboxes and approval status do not establish current implementation or verification results. Both languages share the original code examples, including their comments and strings.
>
> 当前指南 / Current guides: [README](../../../README.md) · [使用指南 / Usage](../../USAGE.md) · [配置指南 / Configuration](../../CONFIGURATION.md).

![Deployment and backup boundaries](../../illustrations/deployment-backup.en.webp)

*Conceptual illustration: Deployment and backup boundaries; it is not evidence that historical tasks were completed.*

<details>
<summary>中文图解</summary>

![部署与备份边界](../../illustrations/deployment-backup.zh.webp)

*概念配图：部署与备份边界，不作为历史任务完成证据。*

</details>

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **面向自动化执行者（原计划要求）：** 必须使用子技能 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，逐项实施本计划。步骤使用复选框（`- [ ]`）语法跟踪。

**Goal:** Make CI, release evidence, browser teardown, Docker context, and GHCR publication fail closed for the exact verified commit.

**目标：** 让 CI、发布证据、浏览器清理、Docker 构建上下文和 GHCR 发布针对确切的已验证提交执行严格检查，条件不满足时按失败处理。

**Architecture:** Keep release truth in existing workflow and script boundaries. `test_infra_config.py` freezes the workflow contract first; focused Node/Vitest tests exercise runtime evidence semantics. GHCR `edge` is driven only by a successful `CI` `workflow_run` for `main`, while semver publication is manual from a `vX.Y.Z` ref and requires successful CI plus an actually executed `release-signoff` job for the same SHA.

**架构：** 在现有工作流与脚本边界内保持发布证据真实。先由 `test_infra_config.py` 固定工作流合同，再由定向 Node/Vitest 测试验证运行时证据语义。GHCR `edge` 仅由 `main` 上成功的 `CI` `workflow_run` 触发；semver 发布从 `vX.Y.Z` 引用手动发起，要求同一 SHA 的 CI 成功且 `release-signoff` 作业实际执行并成功。

**Tech Stack:** GitHub Actions, Bash/`gh`/`jq`, Python/pytest, Node.js ESM tests, Vitest, Docker Buildx.

**技术栈：** GitHub Actions、Bash/`gh`/`jq`、Python/pytest、Node.js ESM 测试、Vitest、Docker Buildx。

---

## Scope and file map / 范围与文件地图

- Modify `.github/workflows/ghcr.yml`: replace direct push publication with exact-SHA verification and publication.

  修改 `.github/workflows/ghcr.yml`：以针对确切 SHA 的验证和发布替代直接 push 发布。
- Modify `.github/workflows/ci.yml`: execute W2.0 regression tests, `npx tsc -b`, and release-script contracts.

  修改 `.github/workflows/ci.yml`：执行 W2.0 回归测试、`npx tsc -b` 及发布脚本合同。
- Modify `.dockerignore`: remove verified local-only ignored directories from Docker context.

  修改 `.dockerignore`：将已确认仅供本地使用的忽略目录移出 Docker 构建上下文。
- Modify `backend/tests/test_infra_config.py`: static RED-first release/workflow/context contracts.

  修改 `backend/tests/test_infra_config.py`：为发布、工作流和构建上下文编写先观察失败的静态合同测试。
- Modify `frontend/scripts/release-signoff.mjs`: represent dry runs as `planned`, never `passed`.

  修改 `frontend/scripts/release-signoff.mjs`：将试运行标为 `planned`，绝不标为 `passed`。
- Modify `frontend/src/scripts/releaseSignoff.test.ts`: executable dry-run status tests.

  修改 `frontend/src/scripts/releaseSignoff.test.ts`：增加实际执行的试运行状态测试。
- Modify `frontend/scripts/playwrightTeardown.mjs`: aggregate and throw every cleanup failure.

  修改 `frontend/scripts/playwrightTeardown.mjs`：汇总并抛出所有清理失败。
- Create `frontend/scripts/playwrightTeardown.test.mjs`: cleanup failure regression tests.

  创建 `frontend/scripts/playwrightTeardown.test.mjs`：增加清理失败回归测试。
- Modify `frontend/scripts/e2e-suite.mjs`, `e2e-debate-suite.mjs`, `e2e-ending-room-followup-suite.mjs`, and `e2e-worldline-roundtable-suite.mjs`: stop force-exiting success.

  修改 `frontend/scripts/e2e-suite.mjs`、`e2e-debate-suite.mjs`、`e2e-ending-room-followup-suite.mjs`、`e2e-worldline-roundtable-suite.mjs`：停止强制以成功状态退出。

Do not change `backend/Dockerfile`, `backend/pyproject.toml`, Python versions, or dependency resolution in this plan. Dependency locking and Python 3.11/3.13 parity require a separate explicit approval.

本计划不改变 `backend/Dockerfile`、`backend/pyproject.toml`、Python 版本或依赖解析。依赖锁定及 Python 3.11/3.13 一致性需要单独明确批准。

### Task 1: Freeze all release-integrity contracts RED-first / 任务 1：先观察失败，再固定全部发布完整性合同

**Files / 文件:**

- Modify / 修改: `backend/tests/test_infra_config.py:142-242`

- [ ] **Step 1: Add the failing contracts before production edits / 步骤 1：在修改生产代码前增加失败合同测试**

Append these tests:

追加以下测试：

```python
def test_ghcr_publish_requires_exact_verified_sha():
    workflow = read_repo_file(".github/workflows/ghcr.yml")
    trigger_block = workflow.split("\npermissions:", maxsplit=1)[0]

    assert "workflow_run:" in trigger_block
    assert 'workflows: ["CI"]' in trigger_block
    assert "workflow_dispatch:" in trigger_block
    assert "\n  push:" not in trigger_block
    for marker in (
        "github.event.workflow_run.head_sha",
        "github.event.workflow_run.conclusion == 'success'",
        "github.event.workflow_run.head_branch == 'main'",
        "github.event.workflow_run.head_repository.full_name == github.repository",
        'select(.name == "release-signoff" and .conclusion == "success")',
        "ref: ${{ needs.verify.outputs.target_sha }}",
    ):
        assert marker in workflow


def test_ci_executes_wave20_release_regressions_in_one_process_per_stack():
    workflow = read_repo_file(".github/workflows/ci.yml")

    for test_path in (
        "tests/test_infra_config.py",
        "tests/test_llm_provider_protocol.py",
        "tests/test_p0_wiring.py",
        "tests/test_causal_graph.py",
        "tests/test_factions.py",
        "tests/test_result_report_reducer.py",
        "tests/test_result_report_builder.py",
        "tests/test_result_report_contract.py",
        "tests/test_local_packs.py",
    ):
        assert test_path in workflow
    for test_path in (
        "src/pages/result/ResultReportPanel.test.tsx",
        "src/pages/result/ReportSection.test.tsx",
        "src/pages/result/ReportConfidenceBadge.test.tsx",
        "src/lib/agentProfileObservation.test.ts",
        "src/lib/localPackImport.test.ts",
        "src/pages/SetupWizardView.test.tsx",
        "src/components/LocalPackPicker.test.tsx",
        "src/components/CounterfactualPanel.test.tsx",
        "src/scripts/releaseSignoff.test.ts",
    ):
        assert test_path in workflow
    assert "npx tsc -b" in workflow
    assert "scripts/playwrightTeardown.test.mjs" in workflow


def test_release_scripts_do_not_force_success_exit():
    for script_path in (
        "frontend/scripts/e2e-suite.mjs",
        "frontend/scripts/e2e-debate-suite.mjs",
        "frontend/scripts/e2e-ending-room-followup-suite.mjs",
        "frontend/scripts/e2e-worldline-roundtable-suite.mjs",
    ):
        assert "process.exit(0)" not in read_repo_file(script_path), script_path


def test_docker_context_excludes_verified_local_only_directories():
    dockerignore = read_repo_file(".dockerignore")

    for relative_path in (
        ".ccg/cache",
        ".claude/session",
        ".release-audit/result.json",
        "frontend/.stitch/cache",
        "frontend/dist-spikes/index.html",
    ):
        assert dockerignore_ignores(dockerignore, relative_path), relative_path
```

- [ ] **Step 2: Run the single focused pytest process and observe RED / 步骤 2：运行单个定向 pytest 进程并观察 RED**

Run / 运行: `cd backend && .venv/bin/python -m pytest tests/test_infra_config.py -q`

Expected: FAIL in the four new contracts because GHCR still has direct `push`, CI omits W2.0 tests, scripts force `process.exit(0)`, and local-only directories enter the Docker context.

预期：四项新增合同测试失败，因为 GHCR 仍直接响应 `push`、CI 缺少 W2.0 测试、脚本强制 `process.exit(0)`，且仅供本地使用的目录进入了 Docker 上下文。

- [ ] **Step 3: Commit the RED tests / 步骤 3：提交 RED 测试**

```bash
git add backend/tests/test_infra_config.py
git commit -m "test: freeze release integrity contracts"
```

### Task 2: Gate GHCR publication on the exact successful commit / 任务 2：仅允许确切的已成功验证提交发布至 GHCR

**Files / 文件:**

- Modify / 修改: `.github/workflows/ghcr.yml:1-72`
- Test / 测试: `backend/tests/test_infra_config.py`

- [ ] **Step 1: Replace direct push triggers with verified entry points / 步骤 1：以经过验证的入口替代直接 push 触发器**

Use this trigger and gate shape; retain the existing backend/frontend matrix below `publish`:

使用以下触发器与门禁结构；保留 `publish` 下现有后端／前端矩阵：

```yaml
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  verify:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event.workflow_run.conclusion == 'success' &&
       github.event.workflow_run.event == 'push' &&
       github.event.workflow_run.head_branch == 'main' &&
       github.event.workflow_run.head_repository.full_name == github.repository)
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: read
    outputs:
      target_sha: ${{ steps.target.outputs.target_sha }}
      channel: ${{ steps.target.outputs.channel }}
      version_tag: ${{ steps.target.outputs.version_tag }}
    steps:
      - name: Resolve immutable publication target
        id: target
        env:
          EVENT_NAME: ${{ github.event_name }}
          CI_SHA: ${{ github.event.workflow_run.head_sha }}
          REF_TYPE: ${{ github.ref_type }}
          REF_NAME: ${{ github.ref_name }}
          MANUAL_SHA: ${{ github.sha }}
        run: |
          set -euo pipefail
          if [ "$EVENT_NAME" = "workflow_run" ]; then
            target_sha="$CI_SHA"
            channel="edge"
            version_tag=""
          else
            if [ "$REF_TYPE" != "tag" ] || ! [[ "$REF_NAME" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
              echo "Semver publication must be dispatched from a vX.Y.Z tag." >&2
              exit 1
            fi
            target_sha="$MANUAL_SHA"
            channel="semver"
            version_tag="$REF_NAME"
          fi
          [[ "$target_sha" =~ ^[0-9a-f]{40}$ ]]
          echo "target_sha=$target_sha" >> "$GITHUB_OUTPUT"
          echo "channel=$channel" >> "$GITHUB_OUTPUT"
          echo "version_tag=$version_tag" >> "$GITHUB_OUTPUT"

      - name: Verify exact SHA gates
        env:
          GH_TOKEN: ${{ github.token }}
          TARGET_SHA: ${{ steps.target.outputs.target_sha }}
          CHANNEL: ${{ steps.target.outputs.channel }}
          VERSION_TAG: ${{ steps.target.outputs.version_tag }}
        run: |
          set -euo pipefail
          ci_runs="$(gh api -X GET "repos/${GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs" -f status=completed -f per_page=100)"
          ci_id="$(jq -r --arg sha "$TARGET_SHA" '.workflow_runs | map(select(.head_sha == $sha and .event == "push" and .conclusion == "success")) | first | .id // empty' <<<"$ci_runs")"
          [ -n "$ci_id" ] || { echo "No successful CI push run for $TARGET_SHA" >&2; exit 1; }

          if [ "$CHANNEL" = "semver" ]; then
            resolved_sha="$(gh api "repos/${GITHUB_REPOSITORY}/commits/${VERSION_TAG}" --jq .sha)"
            [ "$resolved_sha" = "$TARGET_SHA" ] || { echo "Tag does not resolve to target SHA" >&2; exit 1; }
            signoff_runs="$(gh api -X GET "repos/${GITHUB_REPOSITORY}/actions/workflows/release-signoff.yml/runs" -f status=completed -f per_page=100)"
            mapfile -t run_ids < <(jq -r --arg sha "$TARGET_SHA" '.workflow_runs[] | select(.head_sha == $sha and .event == "workflow_dispatch" and .conclusion == "success") | .id' <<<"$signoff_runs")
            verified="false"
            for run_id in "${run_ids[@]}"; do
              jobs="$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/jobs")"
              if jq -e '.jobs[] | select(.name == "release-signoff" and .conclusion == "success")' <<<"$jobs" >/dev/null; then
                verified="true"
                break
              fi
            done
            [ "$verified" = "true" ] || { echo "No executed successful release-signoff job for $TARGET_SHA" >&2; exit 1; }
          fi
```

- [ ] **Step 2: Make publication consume only the verified SHA / 步骤 2：让发布仅使用已验证的 SHA**

Set `publish.needs: verify`, job-level `packages: write`, checkout `ref: ${{ needs.verify.outputs.target_sha }}`, and fail if checked-out `HEAD` differs. Enable `edge` only for `channel == 'edge'`; enable semver metadata only for `channel == 'semver'` using `version_tag`. Use SHA-based concurrency: `ghcr-${{ needs.verify.outputs.target_sha }}`.

设置 `publish.needs: verify`、作业级 `packages: write` 和 checkout `ref: ${{ needs.verify.outputs.target_sha }}`，若检出的 `HEAD` 不同则失败。仅在 `channel == 'edge'` 时启用 `edge`；仅在 `channel == 'semver'` 时使用 `version_tag` 启用 semver 元数据。并发键基于 SHA：`ghcr-${{ needs.verify.outputs.target_sha }}`。

- [ ] **Step 3: Re-run the focused workflow contract / 步骤 3：重新运行定向工作流合同测试**

Run / 运行: `cd backend && .venv/bin/python -m pytest tests/test_infra_config.py::test_ghcr_publish_requires_exact_verified_sha -q`

Expected: `1 passed`. A successful `release-signoff-skipped` job does not satisfy the jq selector.

预期：`1 passed`。成功的 `release-signoff-skipped` 作业不满足 jq 筛选条件。

- [ ] **Step 4: Commit the publication gate / 步骤 4：提交发布门禁**

```bash
git add .github/workflows/ghcr.yml backend/tests/test_infra_config.py
git commit -m "ci: gate image publication on verified commits"
```

### Task 3: Make dry-run evidence truthful / 任务 3：如实记录试运行证据

**Files / 文件:**

- Modify / 修改: `frontend/scripts/release-signoff.mjs:296-432,580-613,732-751,1530-1532`
- Modify / 修改: `frontend/src/scripts/releaseSignoff.test.ts`

- [ ] **Step 1: Add failing Vitest coverage / 步骤 1：增加预期失败的 Vitest 覆盖**

Add Node `fs/os/path` imports and this case:

增加 Node `fs/os/path` 导入及以下用例：

```typescript
it('records unexecuted dry-run work as planned', async () => {
  const outputRoot = mkdtempSync(path.join(tmpdir(), 'swarm-signoff-'));
  const summary = { steps: [] as Array<{ status: string }> };
  const args = { dryRun: true, outputRoot };
  let asyncRunnerCalled = false;

  __test__.runStep(summary, args, 'sync', process.execPath, ['-e', 'process.exit(9)']);
  await __test__.runAsyncStep(summary, args, 'async', async () => {
    asyncRunnerCalled = true;
  });

  expect(asyncRunnerCalled).toBe(false);
  expect(summary.steps.map((step) => step.status)).toEqual(['planned', 'planned']);
  expect(__test__.successfulSummaryStatus(true)).toBe('planned');
  expect(__test__.successfulSummaryStatus(false)).toBe('passed');
});
```

- [ ] **Step 2: Observe RED / 步骤 2：观察 RED**

Run / 运行: `cd frontend && npm test -- --run src/scripts/releaseSignoff.test.ts`

Expected: FAIL because the helpers are not exported and dry-run steps currently become `passed`.

预期：FAIL，因为辅助函数尚未导出，且当时试运行步骤会被标为 `passed`。

- [ ] **Step 3: Implement the minimal status contract / 步骤 3：实现最小状态合同**

In both step runners set `step.status = runArgs.dryRun ? "planned" : "passed"`; add `successfulSummaryStatus(dryRun)`, use it at the final summary assignment, and export the three helpers through `__test__`. Preserve `failed` for attempted commands and never emit `passed` for unexecuted work.

在两个步骤执行器中设置 `step.status = runArgs.dryRun ? "planned" : "passed"`；增加 `successfulSummaryStatus(dryRun)`，用于最终摘要赋值，并通过 `__test__` 导出这三个辅助函数。已尝试命令仍可标为 `failed`，未执行工作绝不能输出 `passed`。

- [ ] **Step 4: Verify GREEN and commit / 步骤 4：确认 GREEN 并提交**

Run / 运行: `cd frontend && npm test -- --run src/scripts/releaseSignoff.test.ts`

Expected: PASS.

预期：PASS。

```bash
git add frontend/scripts/release-signoff.mjs frontend/src/scripts/releaseSignoff.test.ts
git commit -m "fix: report release dry runs as planned"
```

### Task 4: Propagate every Playwright teardown failure / 任务 4：传播所有 Playwright 清理失败

**Files / 文件:**

- Modify / 修改: `frontend/scripts/playwrightTeardown.mjs:4-101`
- Create / 创建: `frontend/scripts/playwrightTeardown.test.mjs`
- Modify / 修改: `frontend/scripts/e2e-suite.mjs:3210-3218`
- Modify / 修改: `frontend/scripts/e2e-debate-suite.mjs:1218-1226`
- Modify / 修改: `frontend/scripts/e2e-ending-room-followup-suite.mjs:3126-3134`
- Modify / 修改: `frontend/scripts/e2e-worldline-roundtable-suite.mjs:2702-2712`

- [ ] **Step 1: Write failing Node tests / 步骤 1：编写预期失败的 Node 测试**

Create the test with `node:test`, `node:assert/strict`, and the public teardown helpers. The aggregate case is:

使用 `node:test`、`node:assert/strict` 和公开清理辅助函数创建测试。汇总用例如下：

```javascript
test('browser teardown attempts every layer and propagates any failure', async () => {
  const calls = [];
  const page = { isClosed: () => false, close: async () => { calls.push('page'); throw new Error('page failed'); } };
  const context = { pages: () => [page], close: async () => { calls.push('context'); } };
  const browser = { contexts: () => [context], close: async () => { calls.push('browser'); } };

  await assert.rejects(
    closePlaywrightBrowser(browser, 'contract', 50),
    (error) => error instanceof AggregateError && /contract teardown failed/u.test(error.message),
  );
  assert.deepEqual(calls, ['page', 'context', 'browser']);
});
```

Add separate page-only and context-only rejection cases so each exported helper is covered.

分别增加仅 page 失败、仅 context 失败的拒绝用例，覆盖每个导出的辅助函数。

- [ ] **Step 2: Observe RED / 步骤 2：观察 RED**

Run / 运行: `cd frontend && node --test scripts/playwrightTeardown.test.mjs`

Expected: FAIL because current helpers swallow errors and return `false`.

预期：FAIL，因为当时的辅助函数会吞掉错误并返回 `false`。

- [ ] **Step 3: Aggregate without short-circuiting cleanup / 步骤 3：汇总错误，但不提前中断清理**

Change the internal close attempt to return an `Error | null`. Each public helper must attempt all owned pages/contexts and its own close, collect failures, force-kill owned browser children after browser-close failure, then throw one `AggregateError(failures, "<label> teardown failed")`. Success returns normally.

让内部关闭尝试返回 `Error | null`。每个公开辅助函数都必须尝试关闭其管理的所有 page/context 及自身，收集失败，浏览器关闭失败后强制终止其管理的浏览器子进程，最后抛出一个 `AggregateError(failures, "<label> teardown failed")`。成功时正常返回。

- [ ] **Step 4: Remove forced success exits / 步骤 4：删除强制成功退出**

Replace `.then(() => process.exit(0)).catch(...)` with `main().catch(error => { console.error(error); process.exitCode = 1; })` in all four CLI scripts. This lets a teardown rejection determine the process result without terminating before pending artifact writes.

在四个 CLI 脚本中，用 `main().catch(error => { console.error(error); process.exitCode = 1; })` 替换 `.then(() => process.exit(0)).catch(...)`。这样清理拒绝可决定进程结果，同时不会在待完成的产物写入之前终止进程。

- [ ] **Step 5: Verify GREEN and commit / 步骤 5：确认 GREEN 并提交**

Run / 运行: `cd frontend && node --test scripts/playwrightTeardown.test.mjs scripts/e2e-frontend-preflight.test.mjs scripts/e2eFixtureNet.test.mjs`

Expected: all Node tests pass and the intentional close failure rejects.

预期：所有 Node 测试通过，刻意注入的关闭失败会触发拒绝。

```bash
git add frontend/scripts/playwrightTeardown.mjs frontend/scripts/playwrightTeardown.test.mjs frontend/scripts/e2e-suite.mjs frontend/scripts/e2e-debate-suite.mjs frontend/scripts/e2e-ending-room-followup-suite.mjs frontend/scripts/e2e-worldline-roundtable-suite.mjs
git commit -m "fix: fail browser suites on teardown errors"
```

### Task 5: Exclude local-only build context and wire W2.0 into CI / 任务 5：排除仅供本地使用的构建上下文，并将 W2.0 接入 CI

**Files / 文件:**

- Modify / 修改: `.dockerignore:1-37`
- Modify / 修改: `.github/workflows/ci.yml:20-138`
- Modify / 修改: `frontend/scripts/release-signoff.mjs:26-90`
- Test / 测试: `backend/tests/test_infra_config.py`

- [ ] **Step 1: Add exact ignore rules / 步骤 1：增加精确忽略规则**

Add `.ccg/**`, `.claude/**`, `.release-audit/**`, `frontend/.stitch/**`, and `frontend/dist-spikes/**`. Do not ignore tracked runtime inputs (`packs`, `samples`, `shared`, frontend source, or backend source).

增加 `.ccg/**`、`.claude/**`、`.release-audit/**`、`frontend/.stitch/**` 和 `frontend/dist-spikes/**`。不要忽略受版本控制的运行时输入（`packs`、`samples`、`shared`、前端源码或后端源码）。

- [ ] **Step 2: Expand the existing single backend pytest invocation / 步骤 2：扩展现有单次后端 pytest 调用**

Add the backend files named in Task 1 to the existing multiline pytest command. Do not start a second pytest process. Include `test_simulator.py` and `test_config.py` because provider timeout configuration is part of W2.0.

将任务 1 指定的后端文件加入现有多行 pytest 命令，不启动第二个 pytest 进程。还应包含 `test_simulator.py` 和 `test_config.py`，因为 Provider 超时配置属于 W2.0。

- [ ] **Step 3: Expand frontend gates / 步骤 3：扩展前端门禁**

Add an explicit `npx tsc -b` step and the frontend files named in Task 1 to the existing single Vitest invocation. Add `node --test scripts/playwrightTeardown.test.mjs` to script smoke. Add the W2.0 report/setup/pack/result tests to `GRAPH_FOCUSED_VITEST_TESTS`, and add `test_llm_provider_protocol.py` plus `test_infra_config.py` to `BACKEND_SIGNOFF_TESTS`.

增加明确的 `npx tsc -b` 步骤，并将任务 1 指定的前端文件加入现有单次 Vitest 调用。在脚本冒烟测试中增加 `node --test scripts/playwrightTeardown.test.mjs`。将 W2.0 报告、设置、主题包和结果测试加入 `GRAPH_FOCUSED_VITEST_TESTS`，将 `test_llm_provider_protocol.py` 与 `test_infra_config.py` 加入 `BACKEND_SIGNOFF_TESTS`。

- [ ] **Step 4: Verify focused contracts / 步骤 4：验证定向合同**

Run / 运行: `cd backend && .venv/bin/python -m pytest tests/test_infra_config.py -q`

Expected: all tests pass in one pytest process.

预期：所有测试在一个 pytest 进程中通过。

Run / 运行: `cd frontend && npm test -- --run src/scripts/releaseSignoff.test.ts && node --test scripts/playwrightTeardown.test.mjs scripts/e2e-frontend-preflight.test.mjs scripts/e2eFixtureNet.test.mjs && npx tsc -b`

Expected: all tests and build-mode type checking pass.

预期：所有测试及构建模式类型检查通过。

- [ ] **Step 5: Commit CI/context hardening / 步骤 5：提交 CI 与构建上下文加固**

```bash
git add .dockerignore .github/workflows/ci.yml backend/tests/test_infra_config.py frontend/scripts/release-signoff.mjs
git commit -m "ci: cover Wave 2 reliability gates"
```

### Task 6: Validate the integrated release lane / 任务 6：验证集成后的发布工作线

**Files / 文件:**

- Verify only; no new production files.

  仅验证，不新增生产文件。

- [ ] **Step 1: Validate YAML syntax and scoped tests / 步骤 1：验证 YAML 语法与指定范围测试**

Run / 运行: `backend/.venv/bin/python -c 'import pathlib, yaml; [yaml.safe_load(pathlib.Path(p).read_text()) for p in (".github/workflows/ci.yml", ".github/workflows/ghcr.yml", ".github/workflows/release-signoff.yml")]'`

Expected: exit 0.

预期：退出码为 0。

Run / 运行: `cd backend && .venv/bin/python -m pytest tests/test_infra_config.py tests/test_llm_provider_protocol.py tests/test_config.py tests/test_simulator.py tests/test_p0_wiring.py tests/test_causal_graph.py tests/test_factions.py tests/test_result_report_reducer.py tests/test_result_report_builder.py tests/test_result_report_contract.py tests/test_local_packs.py -q`

Expected: all pass in one pytest process.

预期：全部在一个 pytest 进程中通过。

- [ ] **Step 2: Validate frontend and truthful dry-run evidence / 步骤 2：验证前端及真实的试运行证据**

Run / 运行: `cd frontend && npm test -- --run src/scripts/releaseSignoff.test.ts src/pages/result/ResultReportPanel.test.tsx src/pages/result/ReportSection.test.tsx src/pages/result/ReportConfidenceBadge.test.tsx src/lib/agentProfileObservation.test.ts src/lib/localPackImport.test.ts src/pages/SetupWizardView.test.tsx src/components/LocalPackPicker.test.tsx src/components/CounterfactualPanel.test.tsx && npm run lint && npx tsc -b`

Expected: all pass.

预期：全部通过。

Run / 运行: `cd frontend && out="$(mktemp -d)" && node scripts/release-signoff.mjs --dry-run --skip-backend-checks --skip-assets-check --headless --output-root "$out" && jq -e '.status == "planned" and ([.steps[].status] | all(. == "planned" or . == "skipped"))' "$out/summary.json"`

Expected: jq exits 0; there are no `passed` steps.

预期：jq 退出码为 0；不存在 `passed` 步骤。

- [ ] **Step 3: Check Docker definitions without changing dependency policy / 步骤 3：检查 Docker 定义，不改变依赖策略**

Run / 运行: `docker buildx build --check -f backend/Dockerfile . && docker buildx build --check -f frontend/Dockerfile .`

Expected: both checks pass and the context excludes the five local-only directories.

预期：两项检查均通过，构建上下文排除上述五个仅供本地使用的目录。

- [ ] **Step 4: Review the final diff and commit only if clean / 步骤 4：审查最终差异，仅在状态干净时提交**

Run / 运行: `git diff --check && git status --short && git diff -- .github/workflows/ghcr.yml .github/workflows/ci.yml .dockerignore backend/tests/test_infra_config.py frontend/scripts/release-signoff.mjs frontend/scripts/playwrightTeardown.mjs frontend/scripts/playwrightTeardown.test.mjs`

Expected: no whitespace errors, no out-of-scope changes, and all publication paths checkout the verified SHA.

预期：无空白错误、无范围外变更，且所有发布路径都检出已验证的 SHA。

After push, verify the first `main` run with `gh run list --workflow ci.yml --branch main --limit 5` and `gh run list --workflow ghcr.yml --branch main --limit 5`. Do not manually dispatch a semver publication as a test. Semver dispatch remains an explicit release action from a real `vX.Y.Z` tag.

推送后，使用 `gh run list --workflow ci.yml --branch main --limit 5` 和 `gh run list --workflow ghcr.yml --branch main --limit 5` 验证首次 `main` 运行。不要为了测试而手动触发 semver 发布。semver 手动发布仍是从真实 `vX.Y.Z` 标签发起的明确发布操作。

## Approval boundary carried forward / 沿用的审批边界

Backend dependency locking and Python 3.11/3.13 alignment remain unresolved release risks, but implementing them changes dependency/configuration policy. Stop and obtain separate explicit confirmation before adding a lock, pinning versions, or changing either Python image/runtime version.

后端依赖锁定及 Python 3.11/3.13 对齐仍是当时未解决的发布风险，但实现它们会改变依赖／配置策略。在增加锁文件、固定版本或更改 Python 镜像／运行时版本之前，需要停下并取得单独的明确确认。
