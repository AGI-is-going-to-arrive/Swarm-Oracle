import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error Plain .mjs test helper has no generated declaration file.
import { __test__ } from '../../scripts/release-signoff.mjs';

describe('release-signoff round7 checks', () => {
  it('runs every W2 truthfulness and provider regression in the release gate', () => {
    expect(__test__.graphFocusedVitestTests).toEqual(expect.arrayContaining([
      'src/components/Setup/ConnectionTester.test.tsx',
      'src/components/ModelProfileManager.test.tsx',
      'src/lib/resultReportSse.test.ts',
      'src/lib/llmProviderPolicy.test.ts',
      'src/components/DocumentSeedPanel.test.tsx',
      'src/components/result/AgentProfileSheet.test.tsx',
      'src/components/FactionForceGraph.test.tsx',
      'src/pages/result/SocialFeedPanel.test.tsx',
    ]));
    expect(__test__.backendSignoffTests).toEqual(expect.arrayContaining([
      'tests/test_agent_identity.py',
      'tests/test_vector_store.py',
      'tests/test_wave1_agent_state.py',
      'tests/test_scoring.py',
      'tests/test_causal_graph.py',
      'tests/test_factions.py',
      'tests/test_result_report_reducer.py',
      'tests/test_result_report_builder.py',
      'tests/test_result_report_contract.py',
      'tests/test_simulator.py',
      'tests/test_local_packs.py',
    ]));
  });

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

  it('builds a literal-safe Cmd+R pattern and list command', () => {
    const spec = __test__.buildFocusedVitestSpec(
      'src/components/kg/NodeConversationSheet.test.tsx',
      'Cmd+R fires onResend and preventDefault blocks browser refresh',
    );

    expect(spec.testNamePattern).toBe('Cmd\\+R fires onResend and preventDefault blocks browser refresh$');
    expect(new RegExp(spec.testNamePattern).test(
      'NodeConversationSheet — keyboard shortcuts > Cmd+R fires onResend and preventDefault blocks browser refresh',
    )).toBe(true);
    expect(new RegExp(spec.testNamePattern).test(
      'NodeConversationSheet — keyboard shortcuts > CmddR fires onResend and preventDefault blocks browser refresh',
    )).toBe(false);
    expect(new RegExp(spec.testNamePattern).test(
      'NodeConversationSheet — keyboard shortcuts > Cmd+R fires onResend and preventDefault blocks browser refresh extra',
    )).toBe(false);
    expect(spec.listArgs).toEqual([
      'vitest',
      'list',
      'src/components/kg/NodeConversationSheet.test.tsx',
      '--testNamePattern',
      'Cmd\\+R fires onResend and preventDefault blocks browser refresh$',
      '--json',
    ]);
  });

  it('rejects a focused Vitest filter that selects zero tests', () => {
    expect(__test__.parseVitestListOutput(
      '[{"name":"suite > Cmd+R fires","file":"target.test.tsx"}]',
      'cmd_r_suppress_reload',
    )).toHaveLength(1);
    expect(() => __test__.parseVitestListOutput('[]', 'cmd_r_suppress_reload'))
      .toThrow('cmd_r_suppress_reload selected zero tests');
  });

  it('sets bounded spawn timeouts and reports timeout failures explicitly', () => {
    expect(__test__.commandTimeoutMs).toBeGreaterThanOrEqual(60_000);
    expect(__test__.captureTimeoutMs).toBeGreaterThanOrEqual(5_000);
    expect(__test__.buildSpawnSyncOptions({}, false)).toMatchObject({
      timeout: __test__.commandTimeoutMs,
      killSignal: 'SIGKILL',
    });
    expect(__test__.buildSpawnSyncOptions({}, true)).toMatchObject({
      timeout: __test__.captureTimeoutMs,
      killSignal: 'SIGKILL',
    });

    const timeoutError = Object.assign(new Error('spawnSync npm ETIMEDOUT'), { code: 'ETIMEDOUT' });
    expect(() => __test__.throwSpawnSyncError(
      { error: timeoutError },
      'npm test',
      12_345,
    )).toThrow('Command timed out after 12345ms: npm test');
  });

  it('keeps the new fixture contracts in release signoff', () => {
    expect(__test__.scriptContractTests).toEqual(expect.arrayContaining([
      'scripts/e2e-prediction-modal.test.mjs',
      'scripts/e2e-result-report-suite.test.mjs',
    ]));
  });

  it('exports the five required round7 check step ids', () => {
    expect(__test__.round7CheckStepIds).toEqual([
      'agent_conversation_ws_endpoint',
      'scenario_deleted_terminal',
      'x_org_id_header',
      'cmd_r_suppress_reload',
      'snap_cycle_70_100_40',
    ]);
  });

  it('injects SWARM_E2E_MODE=live into the five graph e2e steps', () => {
    const specs = __test__.buildRound7GraphLiveStepSpecs('http://127.0.0.1:18930');

    expect(specs.map((spec: { id: string }) => spec.id)).toEqual([
      'phase3a_graph_default',
      'phase3b_graph_default',
      'phase3c_result_graphs',
      'phase3a_graph_zh',
      'phase3b_graph_zh',
    ]);
    for (const spec of specs) {
      expect(spec.env.SWARM_E2E_MODE).toBe('live');
      expect(spec.env.SWARM_URL).toBe('http://127.0.0.1:18930');
    }
  });

  it('round7 graph helper can register the five live steps through a mock runStep', () => {
    const seen: Array<{ id: string; env?: Record<string, string> }> = [];

    __test__.registerRound7GraphLiveSteps({
      baseUrl: 'http://127.0.0.1:18930',
      nodeCommand: 'node',
      runStep: (_summary: unknown, _args: unknown, id: string, _command: string, _argv: string[], options?: { env?: Record<string, string> }) => {
        seen.push({ id, env: options?.env });
      },
      summary: { steps: [] },
      args: {},
    });

    expect(seen.map((entry) => entry.id)).toEqual([
      'phase3a_graph_default',
      'phase3b_graph_default',
      'phase3c_result_graphs',
      'phase3a_graph_zh',
      'phase3b_graph_zh',
    ]);
    expect(seen.every((entry) => entry.env?.SWARM_E2E_MODE === 'live')).toBe(true);
  });

  it('exports the focused prediction step id for late branch arrival coverage', () => {
    expect(__test__.predictionFocusedStepIds).toEqual([
      'prediction_modal_late_branches',
    ]);
  });

  it('builds the late-branches prediction step with the expected command line', () => {
    const specs = __test__.buildPredictionFocusedStepSpecs(
      'http://127.0.0.1:18930',
      '/tmp/release-signoff',
      true,
    );

    expect(specs).toEqual([
      {
        id: 'prediction_modal_late_branches',
        commandArgs: [
          'scripts/e2e-automation.mjs',
          'predict-late-branches',
          '--url',
          'http://127.0.0.1:18930',
          '--output-dir',
          '/tmp/release-signoff/predict-late-branches',
          '--headless',
        ],
        artifactDir: '/tmp/release-signoff/predict-late-branches',
        resultFile: '/tmp/release-signoff/predict-late-branches/result.json',
      },
    ]);
  });

  it('prediction helper can register the late-branches step through a mock runStep', () => {
    const seen: Array<{ id: string; commandArgs: string[]; artifactDir?: string | null; resultFile?: string | null }> = [];

    __test__.registerPredictionFocusedSteps({
      baseUrl: 'http://127.0.0.1:18930',
      outputRoot: '/tmp/release-signoff',
      headless: true,
      nodeCommand: 'node',
      runStep: (
        _summary: unknown,
        _args: unknown,
        id: string,
        _command: string,
        commandArgs: string[],
        options?: { artifactDir?: string | null; resultFile?: string | null },
      ) => {
        seen.push({
          id,
          commandArgs,
          artifactDir: options?.artifactDir ?? null,
          resultFile: options?.resultFile ?? null,
        });
      },
      summary: { steps: [] },
      args: {},
    });

    expect(seen).toEqual([
      {
        id: 'prediction_modal_late_branches',
        commandArgs: [
          'scripts/e2e-automation.mjs',
          'predict-late-branches',
          '--url',
          'http://127.0.0.1:18930',
          '--output-dir',
          '/tmp/release-signoff/predict-late-branches',
          '--headless',
        ],
        artifactDir: '/tmp/release-signoff/predict-late-branches',
        resultFile: '/tmp/release-signoff/predict-late-branches/result.json',
      },
    ]);
  });
});
