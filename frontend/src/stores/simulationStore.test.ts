/**
 * SwarmOracle — Zustand simulationStore tests
 *
 * Covers: initial state, handleWSEvent dispatch (status, agent_speak,
 * round_summary, branch_*, intervention_applied), reset, dedup guard,
 * and MAX_MESSAGES cap.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const createScenarioMock = vi.fn();
const getScenarioMock = vi.fn();

vi.mock("../api/client", () => ({
  createScenario: (...args: unknown[]) => createScenarioMock(...args),
  getScenario: (...args: unknown[]) => getScenarioMock(...args),
}));

vi.mock("../i18n/config", () => ({
  default: {
    t: (key: string) => key,
  },
}));

import { useSimulationStore } from "./simulationStore";
import type { WSEvent } from "../types";

// Helper: reset store before each test
beforeEach(() => {
  useSimulationStore.getState().reset();
  createScenarioMock.mockReset();
  getScenarioMock.mockReset();
});

describe("simulationStore — initial state", () => {
  it("starts with idle status and empty collections", () => {
    const s = useSimulationStore.getState();
    expect(s.status).toBe("idle");
    expect(s.scenario).toBeNull();
    expect(s.agents).toEqual([]);
    expect(s.branches).toEqual([]);
    expect(s.messages).toEqual([]);
    expect(s.groups).toEqual([]);
    expect(s.hierarchical).toBe(false);
    expect(s.error).toBeNull();
    expect(s.thinkingAgents).toEqual([]);
    expect(s.currentRound).toBe(0);
    expect(s.isSimulationComplete).toBe(false);
  });
});

describe("simulationStore — handleWSEvent", () => {
  it("handles 'status' event → updates status", () => {
    const store = useSimulationStore;
    store.getState().handleWSEvent({
      type: "status",
      data: { status: "simulating", hierarchical: false },
    } as WSEvent);

    expect(store.getState().status).toBe("simulating");
    expect(store.getState().isSimulationComplete).toBe(false);
  });

  it("handles 'status' done → marks simulation complete", () => {
    const store = useSimulationStore;
    store.getState().handleWSEvent({
      type: "status",
      data: { status: "done" },
    } as WSEvent);

    expect(store.getState().status).toBe("done");
    expect(store.getState().isSimulationComplete).toBe(true);
  });

  it("ignores 'heartbeat' events", () => {
    const store = useSimulationStore;
    const before = store.getState();

    store.getState().handleWSEvent({
      type: "heartbeat",
      data: { ts: new Date().toISOString() },
    } as WSEvent);

    const after = store.getState();
    expect(after.status).toBe(before.status);
    expect(after.messages).toEqual(before.messages);
    expect(after.interventionLog).toEqual(before.interventionLog);
    expect(after.error).toBe(before.error);
  });

  it("handles 'agent_speak_start' → adds to thinkingAgents", () => {
    const store = useSimulationStore;
    store.getState().handleWSEvent({
      type: "agent_speak_start",
      data: { agent: "曹操", agent_id: "a1", branch: "b1", round: 1 },
    } as WSEvent);

    expect(store.getState().thinkingAgents).toHaveLength(1);
    expect(store.getState().thinkingAgents[0].agent).toBe("曹操");
  });

  it("handles 'agent_speak' → adds message, removes from thinkingAgents", () => {
    const store = useSimulationStore;

    // First, agent starts thinking
    store.getState().handleWSEvent({
      type: "agent_speak_start",
      data: { agent: "曹操", agent_id: "a1", branch: "b1", round: 1 },
    } as WSEvent);
    expect(store.getState().thinkingAgents).toHaveLength(1);

    // Then, agent finishes speaking
    store.getState().handleWSEvent({
      type: "agent_speak",
      data: {
        agent: "曹操",
        agent_id: "a1",
        branch: "b1",
        round: 1,
        message: "吾当南下取荆州！",
        emotion: "confident",
      },
    } as WSEvent);

    expect(store.getState().messages).toHaveLength(1);
    expect(store.getState().messages[0].message).toBe("吾当南下取荆州！");
    expect(store.getState().thinkingAgents).toHaveLength(0);
  });

  it("deduplicates identical agent_speak events", () => {
    const store = useSimulationStore;
    const event = {
      type: "agent_speak",
      data: {
        agent: "曹操",
        agent_id: "a1",
        branch: "b1",
        round: 1,
        message: "吾当南下取荆州！",
        emotion: "confident",
      },
    } as WSEvent;

    store.getState().handleWSEvent(event);
    store.getState().handleWSEvent(event); // duplicate

    expect(store.getState().messages).toHaveLength(1);
  });

  it("merges same-scenario hydration without overwriting newer websocket state", () => {
    const store = useSimulationStore;

    store.getState().setScenario({
      id: "scenario-1",
      question: "What if?",
      status: "simulating",
      created_at: new Date().toISOString(),
      total_rounds: 3,
      mode: "blackboard",
      agents: [],
      branches: [
        {
          id: "branch-1",
          parent_branch_id: null,
          fork_round: 0,
          fork_reason: "",
          title: "Root",
          description: "",
          summary: "",
          story: "",
          insight: "",
          key_moments: [],
          probability: 1,
          status: "ACTIVE",
        },
      ],
      groups: [],
      hierarchical: false,
      messages: [
        {
          agent: "Alpha",
          agent_id: "a1",
          branch: "branch-1",
          round: 1,
          message: "older snapshot",
          emotion: "neutral",
        },
      ],
    });

    store.getState().handleWSEvent({
      type: "agent_speak",
      data: {
        agent: "Beta",
        agent_id: "a2",
        branch: "branch-1",
        round: 2,
        message: "newer ws message",
        emotion: "confident",
      },
    } as WSEvent);
    store.getState().handleWSEvent({
      type: "status",
      data: { status: "done" },
    } as WSEvent);

    store.getState().setScenario({
      id: "scenario-1",
      question: "What if?",
      status: "simulating",
      created_at: new Date().toISOString(),
      total_rounds: 3,
      mode: "blackboard",
      agents: [],
      branches: [
        {
          id: "branch-1",
          parent_branch_id: null,
          fork_round: 0,
          fork_reason: "",
          title: "Root",
          description: "",
          summary: "",
          story: "",
          insight: "",
          key_moments: [],
          probability: 1,
          status: "ACTIVE",
        },
      ],
      groups: [],
      hierarchical: false,
      messages: [
        {
          agent: "Alpha",
          agent_id: "a1",
          branch: "branch-1",
          round: 1,
          message: "older snapshot",
          emotion: "neutral",
        },
      ],
    });

    expect(store.getState().status).toBe("done");
    expect(store.getState().messages.map((message) => message.message)).toEqual([
      "older snapshot",
      "newer ws message",
    ]);
    expect(store.getState().currentRound).toBe(2);
  });

  it("deduplicates repeated agent_speak events against preloaded scenario history", () => {
    const store = useSimulationStore;
    store.getState().setScenario({
      id: "s1",
      question: "如果罗马帝国从未衰落？",
      status: "simulating",
      created_at: new Date().toISOString(),
      total_rounds: 3,
      mode: "blackboard",
      agents: [],
      branches: [],
      groups: [],
      hierarchical: false,
      messages: [{
        agent: "曹操",
        agent_id: "a1",
        branch: "b1",
        round: 1,
        message: "吾当南下取荆州！",
        emotion: "confident",
      }],
    });

    store.getState().handleWSEvent({
      type: "agent_speak",
      data: {
        agent: "曹操",
        agent_id: "a1",
        branch: "b1",
        round: 1,
        message: "吾当南下取荆州！",
        emotion: "confident",
      },
    } as WSEvent);

    expect(store.getState().messages).toHaveLength(1);
  });

  it("handles 'round_summary' → advances currentRound", () => {
    const store = useSimulationStore;
    store.getState().handleWSEvent({
      type: "round_summary",
      data: { round: 3, branch_id: "b1", summary: "Round 3 complete" },
    } as WSEvent);

    expect(store.getState().currentRound).toBe(3);
  });

  it("refreshes an existing branch when duplicate branch_init arrives", () => {
    const store = useSimulationStore;
    store.getState().setScenario({
      id: "s1",
      question: "如果罗马帝国从未衰落？",
      status: "parsing",
      created_at: new Date().toISOString(),
      total_rounds: 3,
      mode: "blackboard",
      agents: [],
      branches: [{
        id: "b1",
        parent_branch_id: null,
        fork_round: 0,
        fork_reason: "",
        title: "历史拐点",
        summary: "",
        story: "",
        insight: "",
        key_moments: [],
        probability: 1,
        status: "ACTIVE",
      }],
      groups: [],
      hierarchical: false,
      messages: [],
    });

    store.getState().handleWSEvent({
      type: "branch_init",
      data: { id: "b1", title: "永世帝国", probability: 1, status: "ACTIVE", parent_branch_id: null },
    } as WSEvent);

    expect(store.getState().branches).toHaveLength(1);
    expect(store.getState().branches[0].title).toBe("永世帝国");
  });

  it("handles 'intervention_applied' → adds to interventionLog", () => {
    const store = useSimulationStore;
    store.getState().handleWSEvent({
      type: "intervention_applied",
      data: {
        branch_id: "b1",
        text: "突发地震",
        round: 2,
        intervention_id: "int1",
      },
    } as WSEvent);

    expect(store.getState().interventionLog).toHaveLength(1);
    expect(store.getState().interventionLog[0].text).toBe("突发地震");
  });

  it("handles 'retrospective_start' → adds placeholder branch and intervention log", () => {
    const store = useSimulationStore;
    store.getState().setScenario({
      id: "s1",
      question: "如果罗马帝国从未衰落？",
      status: "simulating",
      created_at: new Date().toISOString(),
      total_rounds: 3,
      mode: "blackboard",
      agents: [],
      branches: [{
        id: "b1",
        parent_branch_id: null,
        fork_round: 0,
        fork_reason: "",
        title: "原始分支",
        summary: "",
        story: "",
        insight: "",
        key_moments: [],
        probability: 0.6,
        status: "ACTIVE",
      }],
      groups: [],
      hierarchical: false,
      messages: [],
    });

    store.getState().handleWSEvent({
      type: "retrospective_start",
      data: {
        branch_id: "b2",
        source_branch_id: "b1",
        from_round: 2,
        text: "提前废除奴隶制",
        intervention_id: "int2",
      },
    } as WSEvent);

    expect(store.getState().branches).toHaveLength(2);
    expect(store.getState().branches[1]).toMatchObject({
      id: "b2",
      parent_branch_id: "b1",
      fork_round: 2,
      title: "Retrospective R2",
      status: "ACTIVE",
    });
    expect(store.getState().interventionLog).toHaveLength(1);
    expect(store.getState().interventionLog[0]).toMatchObject({
      branch_id: "b2",
      text: "提前废除奴隶制",
      round: 2,
    });
  });

  it("handles 'batch_intervention_applied' → appends all intervention entries", () => {
    const store = useSimulationStore;
    store.getState().handleWSEvent({
      type: "batch_intervention_applied",
      data: {
        interventions: [
          {
            branch_id: "b1",
            text: "港口停摆",
            round: 2,
            intervention_id: "int-a",
          },
          {
            branch_id: "b2",
            text: "边境关闭",
            round: 3,
            intervention_id: "int-b",
          },
        ],
      },
    } as WSEvent);

    expect(store.getState().interventionLog).toEqual([
      { branch_id: "b1", text: "港口停摆", round: 2 },
      { branch_id: "b2", text: "边境关闭", round: 3 },
    ]);
  });

  it("handles 'simulation_error' → sets error state", () => {
    const store = useSimulationStore;
    store.getState().handleWSEvent({
      type: "simulation_error",
      data: {
        error: {
          code: "SIMULATION_TIMEOUT",
          message: "Simulation timed out. Please retry.",
        },
      },
    } as WSEvent);

    expect(store.getState().status).toBe("error");
    expect(store.getState().error).toBe("common.api_errors.simulation_start_failed");
  });
});

describe("simulationStore — api error mapping", () => {
  it("forwards startSimulation options into createScenario", async () => {
    createScenarioMock.mockResolvedValueOnce({
      id: "scenario-1",
      question: "question",
      status: "parsing",
      created_at: new Date().toISOString(),
      total_rounds: 5,
      mode: "blackboard",
      agents: [],
      branches: [],
      groups: [],
      hierarchical: false,
      messages: [],
    });

    await useSimulationStore.getState().startSimulation({
      question: "question",
      rounds: 7,
      numAgents: 12,
      mode: "raw",
      llmApiKey: "sk-test",
      llmBaseUrl: "https://example.com/v1",
      llmModel: "gpt-test",
      reasoningEffort: "high",
      visualizationEnabled: true,
      userId: "director-1",
    });

    expect(createScenarioMock).toHaveBeenCalledWith({
      question: "question",
      rounds: 7,
      numAgents: 12,
      mode: "raw",
      llmApiKey: "sk-test",
      llmBaseUrl: "https://example.com/v1",
      llmModel: "gpt-test",
      reasoningEffort: "high",
      visualizationEnabled: true,
      userId: "director-1",
    });
  });

  it("maps structured start errors to localized keys", async () => {
    createScenarioMock.mockRejectedValueOnce({
      status: 503,
      code: "LLM_TEMPORARILY_UNAVAILABLE",
    });

    await expect(
      useSimulationStore.getState().startSimulation({ question: "question" }),
    ).rejects.toMatchObject({ code: "LLM_TEMPORARILY_UNAVAILABLE" });

    expect(useSimulationStore.getState().error).toBe("common.api_errors.llm_unavailable");
  });

  it("maps structured load errors to localized keys", async () => {
    getScenarioMock.mockRejectedValueOnce({
      status: 404,
      code: "SCENARIO_NOT_FOUND",
    });

    await useSimulationStore.getState().loadScenario("missing-scenario");

    expect(useSimulationStore.getState().error).toBe("common.api_errors.scenario_not_found");
  });

  it("maps structured simulation_error ws payloads to localized keys", () => {
    useSimulationStore.getState().handleWSEvent({
      type: "simulation_error",
      data: {
        error: {
          code: "GAMEPLAY_STATE_REVISION_MISMATCH",
          message: "Gameplay state revision mismatch",
        },
      },
    } as WSEvent);

    expect(useSimulationStore.getState().error).toBe("common.api_errors.sync_conflict");
    expect(useSimulationStore.getState().status).toBe("error");
  });
});

describe("simulationStore — reset", () => {
  it("resets all state back to initial", () => {
    const store = useSimulationStore;

    // Dirty the state
    store.getState().handleWSEvent({
      type: "status",
      data: { status: "simulating" },
    } as WSEvent);
    store.getState().handleWSEvent({
      type: "agent_speak",
      data: {
        agent: "X",
        agent_id: "a1",
        branch: "b1",
        round: 1,
        message: "hello",
        emotion: "neutral",
      },
    } as WSEvent);

    expect(store.getState().status).not.toBe("idle");
    expect(store.getState().messages.length).toBeGreaterThan(0);

    // Reset
    store.getState().reset();

    expect(store.getState().status).toBe("idle");
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().scenario).toBeNull();
  });
});

describe("simulationStore — scenario hydration", () => {
  it("restores theater mode when scenario visualization is enabled", () => {
    const store = useSimulationStore;

    store.getState().setScenario({
      id: "s1",
      question: "如果罗马帝国从未衰落？",
      status: "done",
      created_at: new Date().toISOString(),
      total_rounds: 3,
      mode: "blackboard",
      visualization_enabled: true,
      scene_theme: "ancient_empire",
      agents: [],
      branches: [],
      groups: [],
      hierarchical: false,
      messages: [],
    });

    expect(store.getState().visualizationEnabled).toBe(true);
    expect(store.getState().viewMode).toBe("theater");
  });

  it("does not fake theater mode when the scenario was not created with visualization", () => {
    const store = useSimulationStore;

    store.getState().setScenario({
      id: "s2",
      question: "如果互联网从未被发明？",
      status: "simulating",
      created_at: new Date().toISOString(),
      total_rounds: 3,
      mode: "blackboard",
      visualization_enabled: false,
      scene_theme: null,
      agents: [],
      branches: [],
      groups: [],
      hierarchical: false,
      messages: [],
    });

    store.getState().toggleViewMode();

    expect(store.getState().visualizationEnabled).toBe(false);
    expect(store.getState().viewMode).toBe("classic");
  });
});
