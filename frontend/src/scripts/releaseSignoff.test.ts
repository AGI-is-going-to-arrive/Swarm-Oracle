import { describe, expect, it } from 'vitest';

// @ts-expect-error Plain .mjs test helper has no generated declaration file.
import { __test__ } from '../../scripts/release-signoff.mjs';

describe('release-signoff round7 checks', () => {
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
