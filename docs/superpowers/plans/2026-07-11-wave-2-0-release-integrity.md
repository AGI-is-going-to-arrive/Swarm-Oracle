# Wave 2.0 Release Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CI, release evidence, browser teardown, Docker context, and GHCR publication fail closed for the exact verified commit.

**Architecture:** Keep release truth in existing workflow and script boundaries. `test_infra_config.py` freezes the workflow contract first; focused Node/Vitest tests exercise runtime evidence semantics. GHCR `edge` is driven only by a successful `CI` `workflow_run` for `main`, while semver publication is manual from a `vX.Y.Z` ref and requires successful CI plus an actually executed `release-signoff` job for the same SHA.

**Tech Stack:** GitHub Actions, Bash/`gh`/`jq`, Python/pytest, Node.js ESM tests, Vitest, Docker Buildx.

---

## Scope and file map

- Modify `.github/workflows/ghcr.yml`: replace direct push publication with exact-SHA verification and publication.
- Modify `.github/workflows/ci.yml`: execute W2.0 regression tests, `npx tsc -b`, and release-script contracts.
- Modify `.dockerignore`: remove verified local-only ignored directories from Docker context.
- Modify `backend/tests/test_infra_config.py`: static RED-first release/workflow/context contracts.
- Modify `frontend/scripts/release-signoff.mjs`: represent dry runs as `planned`, never `passed`.
- Modify `frontend/src/scripts/releaseSignoff.test.ts`: executable dry-run status tests.
- Modify `frontend/scripts/playwrightTeardown.mjs`: aggregate and throw every cleanup failure.
- Create `frontend/scripts/playwrightTeardown.test.mjs`: cleanup failure regression tests.
- Modify `frontend/scripts/e2e-suite.mjs`, `e2e-debate-suite.mjs`, `e2e-ending-room-followup-suite.mjs`, and `e2e-worldline-roundtable-suite.mjs`: stop force-exiting success.

Do not change `backend/Dockerfile`, `backend/pyproject.toml`, Python versions, or dependency resolution in this plan. Dependency locking and Python 3.11/3.13 parity require a separate explicit approval.

### Task 1: Freeze all release-integrity contracts RED-first

**Files:**
- Modify: `backend/tests/test_infra_config.py:142-242`

- [ ] **Step 1: Add the failing contracts before production edits**

Append these tests:

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

- [ ] **Step 2: Run the single focused pytest process and observe RED**

Run: `cd backend && .venv/bin/python -m pytest tests/test_infra_config.py -q`

Expected: FAIL in the four new contracts because GHCR still has direct `push`, CI omits W2.0 tests, scripts force `process.exit(0)`, and local-only directories enter the Docker context.

- [ ] **Step 3: Commit the RED tests**

```bash
git add backend/tests/test_infra_config.py
git commit -m "test: freeze release integrity contracts"
```

### Task 2: Gate GHCR publication on the exact successful commit

**Files:**
- Modify: `.github/workflows/ghcr.yml:1-72`
- Test: `backend/tests/test_infra_config.py`

- [ ] **Step 1: Replace direct push triggers with verified entry points**

Use this trigger and gate shape; retain the existing backend/frontend matrix below `publish`:

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

- [ ] **Step 2: Make publication consume only the verified SHA**

Set `publish.needs: verify`, job-level `packages: write`, checkout `ref: ${{ needs.verify.outputs.target_sha }}`, and fail if checked-out `HEAD` differs. Enable `edge` only for `channel == 'edge'`; enable semver metadata only for `channel == 'semver'` using `version_tag`. Use SHA-based concurrency: `ghcr-${{ needs.verify.outputs.target_sha }}`.

- [ ] **Step 3: Re-run the focused workflow contract**

Run: `cd backend && .venv/bin/python -m pytest tests/test_infra_config.py::test_ghcr_publish_requires_exact_verified_sha -q`

Expected: `1 passed`. A successful `release-signoff-skipped` job does not satisfy the jq selector.

- [ ] **Step 4: Commit the publication gate**

```bash
git add .github/workflows/ghcr.yml backend/tests/test_infra_config.py
git commit -m "ci: gate image publication on verified commits"
```

### Task 3: Make dry-run evidence truthful

**Files:**
- Modify: `frontend/scripts/release-signoff.mjs:296-432,580-613,732-751,1530-1532`
- Modify: `frontend/src/scripts/releaseSignoff.test.ts`

- [ ] **Step 1: Add failing Vitest coverage**

Add Node `fs/os/path` imports and this case:

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

- [ ] **Step 2: Observe RED**

Run: `cd frontend && npm test -- --run src/scripts/releaseSignoff.test.ts`

Expected: FAIL because the helpers are not exported and dry-run steps currently become `passed`.

- [ ] **Step 3: Implement the minimal status contract**

In both step runners set `step.status = runArgs.dryRun ? "planned" : "passed"`; add `successfulSummaryStatus(dryRun)`, use it at the final summary assignment, and export the three helpers through `__test__`. Preserve `failed` for attempted commands and never emit `passed` for unexecuted work.

- [ ] **Step 4: Verify GREEN and commit**

Run: `cd frontend && npm test -- --run src/scripts/releaseSignoff.test.ts`

Expected: PASS.

```bash
git add frontend/scripts/release-signoff.mjs frontend/src/scripts/releaseSignoff.test.ts
git commit -m "fix: report release dry runs as planned"
```

### Task 4: Propagate every Playwright teardown failure

**Files:**
- Modify: `frontend/scripts/playwrightTeardown.mjs:4-101`
- Create: `frontend/scripts/playwrightTeardown.test.mjs`
- Modify: `frontend/scripts/e2e-suite.mjs:3210-3218`
- Modify: `frontend/scripts/e2e-debate-suite.mjs:1218-1226`
- Modify: `frontend/scripts/e2e-ending-room-followup-suite.mjs:3126-3134`
- Modify: `frontend/scripts/e2e-worldline-roundtable-suite.mjs:2702-2712`

- [ ] **Step 1: Write failing Node tests**

Create the test with `node:test`, `node:assert/strict`, and the public teardown helpers. The aggregate case is:

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

- [ ] **Step 2: Observe RED**

Run: `cd frontend && node --test scripts/playwrightTeardown.test.mjs`

Expected: FAIL because current helpers swallow errors and return `false`.

- [ ] **Step 3: Aggregate without short-circuiting cleanup**

Change the internal close attempt to return an `Error | null`. Each public helper must attempt all owned pages/contexts and its own close, collect failures, force-kill owned browser children after browser-close failure, then throw one `AggregateError(failures, "<label> teardown failed")`. Success returns normally.

- [ ] **Step 4: Remove forced success exits**

Replace `.then(() => process.exit(0)).catch(...)` with `main().catch(error => { console.error(error); process.exitCode = 1; })` in all four CLI scripts. This lets a teardown rejection determine the process result without terminating before pending artifact writes.

- [ ] **Step 5: Verify GREEN and commit**

Run: `cd frontend && node --test scripts/playwrightTeardown.test.mjs scripts/e2e-frontend-preflight.test.mjs scripts/e2eFixtureNet.test.mjs`

Expected: all Node tests pass and the intentional close failure rejects.

```bash
git add frontend/scripts/playwrightTeardown.mjs frontend/scripts/playwrightTeardown.test.mjs frontend/scripts/e2e-suite.mjs frontend/scripts/e2e-debate-suite.mjs frontend/scripts/e2e-ending-room-followup-suite.mjs frontend/scripts/e2e-worldline-roundtable-suite.mjs
git commit -m "fix: fail browser suites on teardown errors"
```

### Task 5: Exclude local-only build context and wire W2.0 into CI

**Files:**
- Modify: `.dockerignore:1-37`
- Modify: `.github/workflows/ci.yml:20-138`
- Modify: `frontend/scripts/release-signoff.mjs:26-90`
- Test: `backend/tests/test_infra_config.py`

- [ ] **Step 1: Add exact ignore rules**

Add `.ccg/**`, `.claude/**`, `.release-audit/**`, `frontend/.stitch/**`, and `frontend/dist-spikes/**`. Do not ignore tracked runtime inputs (`packs`, `samples`, `shared`, frontend source, or backend source).

- [ ] **Step 2: Expand the existing single backend pytest invocation**

Add the backend files named in Task 1 to the existing multiline pytest command. Do not start a second pytest process. Include `test_simulator.py` and `test_config.py` because provider timeout configuration is part of W2.0.

- [ ] **Step 3: Expand frontend gates**

Add an explicit `npx tsc -b` step and the frontend files named in Task 1 to the existing single Vitest invocation. Add `node --test scripts/playwrightTeardown.test.mjs` to script smoke. Add the W2.0 report/setup/pack/result tests to `GRAPH_FOCUSED_VITEST_TESTS`, and add `test_llm_provider_protocol.py` plus `test_infra_config.py` to `BACKEND_SIGNOFF_TESTS`.

- [ ] **Step 4: Verify focused contracts**

Run: `cd backend && .venv/bin/python -m pytest tests/test_infra_config.py -q`

Expected: all tests pass in one pytest process.

Run: `cd frontend && npm test -- --run src/scripts/releaseSignoff.test.ts && node --test scripts/playwrightTeardown.test.mjs scripts/e2e-frontend-preflight.test.mjs scripts/e2eFixtureNet.test.mjs && npx tsc -b`

Expected: all tests and build-mode type checking pass.

- [ ] **Step 5: Commit CI/context hardening**

```bash
git add .dockerignore .github/workflows/ci.yml backend/tests/test_infra_config.py frontend/scripts/release-signoff.mjs
git commit -m "ci: cover Wave 2 reliability gates"
```

### Task 6: Validate the integrated release lane

**Files:**
- Verify only; no new production files.

- [ ] **Step 1: Validate YAML syntax and scoped tests**

Run: `backend/.venv/bin/python -c 'import pathlib, yaml; [yaml.safe_load(pathlib.Path(p).read_text()) for p in (".github/workflows/ci.yml", ".github/workflows/ghcr.yml", ".github/workflows/release-signoff.yml")]'`

Expected: exit 0.

Run: `cd backend && .venv/bin/python -m pytest tests/test_infra_config.py tests/test_llm_provider_protocol.py tests/test_config.py tests/test_simulator.py tests/test_p0_wiring.py tests/test_causal_graph.py tests/test_factions.py tests/test_result_report_reducer.py tests/test_result_report_builder.py tests/test_result_report_contract.py tests/test_local_packs.py -q`

Expected: all pass in one pytest process.

- [ ] **Step 2: Validate frontend and truthful dry-run evidence**

Run: `cd frontend && npm test -- --run src/scripts/releaseSignoff.test.ts src/pages/result/ResultReportPanel.test.tsx src/pages/result/ReportSection.test.tsx src/pages/result/ReportConfidenceBadge.test.tsx src/lib/agentProfileObservation.test.ts src/lib/localPackImport.test.ts src/pages/SetupWizardView.test.tsx src/components/LocalPackPicker.test.tsx src/components/CounterfactualPanel.test.tsx && npm run lint && npx tsc -b`

Expected: all pass.

Run: `cd frontend && out="$(mktemp -d)" && node scripts/release-signoff.mjs --dry-run --skip-backend-checks --skip-assets-check --headless --output-root "$out" && jq -e '.status == "planned" and ([.steps[].status] | all(. == "planned" or . == "skipped"))' "$out/summary.json"`

Expected: jq exits 0; there are no `passed` steps.

- [ ] **Step 3: Check Docker definitions without changing dependency policy**

Run: `docker buildx build --check -f backend/Dockerfile . && docker buildx build --check -f frontend/Dockerfile .`

Expected: both checks pass and the context excludes the five local-only directories.

- [ ] **Step 4: Review the final diff and commit only if clean**

Run: `git diff --check && git status --short && git diff -- .github/workflows/ghcr.yml .github/workflows/ci.yml .dockerignore backend/tests/test_infra_config.py frontend/scripts/release-signoff.mjs frontend/scripts/playwrightTeardown.mjs frontend/scripts/playwrightTeardown.test.mjs`

Expected: no whitespace errors, no out-of-scope changes, and all publication paths checkout the verified SHA.

After push, verify the first `main` run with `gh run list --workflow ci.yml --branch main --limit 5` and `gh run list --workflow ghcr.yml --branch main --limit 5`. Do not manually dispatch a semver publication as a test. Semver dispatch remains an explicit release action from a real `vX.Y.Z` tag.

## Approval boundary carried forward

Backend dependency locking and Python 3.11/3.13 alignment remain unresolved release risks, but implementing them changes dependency/configuration policy. Stop and obtain separate explicit confirmation before adding a lock, pinning versions, or changing either Python image/runtime version.
