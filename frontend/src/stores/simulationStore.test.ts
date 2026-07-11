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
import type { Scenario, WSEvent } from "../types";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeScenario(id: string, overrides: Partial<Scenario> = {}): Scenario {
  return {
    id,
    question: `Scenario ${id}`,
    status: "simulating",
    created_at: new Date().toISOString(),
    total_rounds: 3,
    mode: "blackboard",
    agents: [],
    branches: [],
    groups: [],
    hierarchical: false,
    messages: [],
    ...overrides,
  };
}

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

  it("does not let a stale simulating status overwrite done", () => {
    const store = useSimulationStore;
    store.getState().handleWSEvent({
      type: "status",
      data: { status: "done" },
    } as WSEvent);
    store.getState().handleWSEvent({
      type: "status",
      data: { status: "simulating" },
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

  it("keeps the last known roster emotion when speech metadata is unavailable", () => {
    const store = useSimulationStore;
    store.getState().setScenario(makeScenario("scenario-metadata", {
      agents: [{
        id: "a1",
        name: "曹操",
        role: "主公",
        tier: "CORE",
        emotion: "alert",
      }],
    }));

    store.getState().handleWSEvent({
      type: "agent_speak",
      data: {
        agent: "曹操",
        agent_id: "a1",
        branch: "b1",
        round: 1,
        message: "真实发言仍然保留。",
        emotion: "",
        emotion_metadata_status: "unavailable",
        emotion_metadata_failure_code: "LLM_TIMEOUT",
      },
    } as unknown as WSEvent);

    expect(store.getState().agents[0].emotion).toBe("alert");
    expect(store.getState().messages[0]).toMatchObject({
      emotion: "",
      emotion_metadata_status: "unavailable",
      emotion_metadata_failure_code: "LLM_TIMEOUT",
    });
  });

  it("clears stale thinkingAgents when a scenario snapshot resync is applied", () => {
    const store = useSimulationStore;

    store.getState().handleWSEvent({
      type: "agent_speak_start",
      data: { agent: "曹操", agent_id: "a1", branch: "b1", round: 1 },
    } as WSEvent);
    expect(store.getState().thinkingAgents).toHaveLength(1);

    store.getState().setScenario({
      id: "scenario-resync",
      question: "What if?",
      status: "simulating",
      created_at: new Date().toISOString(),
      total_rounds: 3,
      mode: "blackboard",
      agents: [],
      branches: [],
      groups: [],
      hierarchical: false,
      messages: [],
    });

    expect(store.getState().thinkingAgents).toEqual([]);
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

  it("clears live timing state when switching to a different scenario snapshot", () => {
    vi.useFakeTimers();
    try {
      const store = useSimulationStore;
      store.getState().setScenario({
        id: "scenario-a",
        question: "A",
        status: "simulating",
        created_at: new Date().toISOString(),
        total_rounds: 3,
        mode: "blackboard",
        agents: [],
        branches: [],
        groups: [],
        hierarchical: false,
        messages: [],
      });

      vi.setSystemTime(1_000);
      store.getState().handleWSEvent({
        type: "status",
        data: { status: "simulating" },
      } as WSEvent);
      vi.setSystemTime(5_000);
      store.getState().handleWSEvent({
        type: "round_summary",
        data: { round: 1, branch_id: "branch-a", summary: "Round 1 done" },
      } as WSEvent);

      expect(store.getState().simStartTime).toBe(1_000);
      expect(store.getState().roundCompleteTimes).toEqual([5_000]);
      expect(store.getState().currentRound).toBe(1);

      store.getState().setScenario({
        id: "scenario-b",
        question: "B",
        status: "simulating",
        created_at: new Date().toISOString(),
        total_rounds: 3,
        mode: "blackboard",
        agents: [],
        branches: [],
        groups: [],
        hierarchical: false,
        messages: [],
      });

      expect(store.getState().simStartTime).toBeNull();
      expect(store.getState().roundCompleteTimes).toEqual([]);
      expect(store.getState().currentRound).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

  it("uses the live fork_round from 'branch_fork' for child branches", () => {
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
      type: "branch_fork",
      data: {
        parent: "b1",
        reason: "关键制度分歧",
        children: [
          {
            id: "b2",
            title: "子世界线",
            description: "新的未来",
            fork_round: 2,
            probability: 0.4,
          },
        ],
      },
    } as WSEvent);

    expect(store.getState().branches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "b1",
        status: "COMPLETED",
      }),
      expect.objectContaining({
        id: "b2",
        parent_branch_id: "b1",
        fork_round: 2,
        fork_reason: "关键制度分歧",
        status: "ACTIVE",
      }),
    ]));
  });

  it("does not let branch_update regress a completed branch back to active", () => {
    const store = useSimulationStore;
    store.getState().setScenario({
      id: "s1",
      question: "如果罗马帝国从未衰落？",
      status: "done",
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
        status: "COMPLETED",
      }],
      groups: [],
      hierarchical: false,
      messages: [],
    });

    store.getState().handleWSEvent({
      type: "branch_update",
      data: { branch_id: "b1", status: "ACTIVE" },
    } as WSEvent);

    expect(store.getState().branches[0].status).toBe("COMPLETED");
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
      title: "intervention.retrospective_title",
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
    expect(store.getState().interventionLifecycle.get("int-a")).toBe("queued");
    expect(store.getState().interventionLifecycle.get("int-b")).toBe("queued");
  });

  it("transitions intervention lifecycle to receipt_ready when simulation completes", () => {
    const store = useSimulationStore;

    // Add queued and injected interventions
    store.getState().handleWSEvent({
      type: "intervention_applied",
      data: { branch_id: "b1", text: "Int 1", round: 1, intervention_id: "int-1" },
    } as WSEvent);
    store.getState().handleWSEvent({
      type: "intervention_injected",
      data: { branch_id: "b1", text: "Int 2", round: 2, intervention_id: "int-2" },
    } as WSEvent);

    expect(store.getState().interventionLifecycle.get("int-1")).toBe("queued");
    expect(store.getState().interventionLifecycle.get("int-2")).toBe("injected");

    // Complete simulation
    store.getState().handleWSEvent({ type: "simulation_done" } as WSEvent);

    expect(store.getState().interventionLifecycle.get("int-1")).toBe("receipt_ready");
    expect(store.getState().interventionLifecycle.get("int-2")).toBe("receipt_ready");
  });

  it("clears intervention lifecycle when switching scenarios", () => {
    const store = useSimulationStore;

    store.getState().setScenario({
      id: "scenario-a",
      question: "A",
      status: "simulating",
      created_at: new Date().toISOString(),
      total_rounds: 2,
      mode: "blackboard",
      agents: [],
      branches: [],
      groups: [],
      hierarchical: false,
      messages: [],
    });
    store.getState().handleWSEvent({
      type: "intervention_applied",
      data: { branch_id: "b1", text: "Int 1", round: 1, intervention_id: "int-1" },
    } as WSEvent);
    expect(store.getState().interventionLifecycle.get("int-1")).toBe("queued");

    store.getState().setScenario({
      id: "scenario-b",
      question: "B",
      status: "simulating",
      created_at: new Date().toISOString(),
      total_rounds: 2,
      mode: "blackboard",
      agents: [],
      branches: [],
      groups: [],
      hierarchical: false,
      messages: [],
    });

    expect(store.getState().interventionLifecycle.size).toBe(0);
    expect(store.getState().interventionLog).toEqual([]);
  });

  it("accepts KG realtime graph events without logging unhandled warnings", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      useSimulationStore.getState().handleWSEvent({
        type: "kg:delta",
        data: {
          scenario_id: "scenario-kg",
          version: 2,
          added: [],
          updated: [],
          deleted: [],
          snapshot_invalidated: false,
        },
      } as WSEvent);
      useSimulationStore.getState().handleWSEvent({
        type: "kg:snapshot_invalidated",
        data: {
          scenario_id: "scenario-kg",
          version: 3,
        },
      } as WSEvent);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
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

describe("simulationStore — S1-1 cancellation", () => {
  it("transitions to cancelled when handling 'simulation_cancelled' WS event", () => {
    const store = useSimulationStore;
    store.getState().handleWSEvent({
      type: "status",
      data: { status: "simulating" },
    } as WSEvent);
    expect(store.getState().status).toBe("simulating");

    store.getState().handleWSEvent({
      type: "simulation_cancelled",
      reason: "user_cancelled",
    } as WSEvent);

    expect(store.getState().status).toBe("cancelled");
    expect(store.getState().cancelReason).toBe("user_cancelled");
    expect(store.getState().thinkingAgents).toEqual([]);
    expect(store.getState().error).toBeNull();
  });

  it("setCancelled action transitions store and stores reason", () => {
    const store = useSimulationStore;
    store.getState().handleWSEvent({
      type: "status",
      data: { status: "simulating" },
    } as WSEvent);

    store.getState().setCancelled("user_cancelled");

    expect(store.getState().status).toBe("cancelled");
    expect(store.getState().cancelReason).toBe("user_cancelled");
    expect(store.getState().thinkingAgents).toEqual([]);
  });

  it("does not regress cancelled status when a stale 'status' event arrives", () => {
    const store = useSimulationStore;
    store.getState().setCancelled("user_cancelled");
    expect(store.getState().status).toBe("cancelled");

    store.getState().handleWSEvent({
      type: "status",
      data: { status: "simulating" },
    } as WSEvent);

    expect(store.getState().status).toBe("cancelled");
    expect(store.getState().cancelReason).toBe("user_cancelled");
  });

  it("does not regress cancelled status when a snapshot resync is applied", () => {
    const store = useSimulationStore;
    store.getState().setScenario({
      id: "scenario-cancel",
      question: "Q",
      status: "simulating",
      created_at: "2026-03-23T00:00:00Z",
      agents: [],
      branches: [],
      groups: [],
      hierarchical: false,
      messages: [],
    });
    store.getState().setCancelled("user_cancelled");
    expect(store.getState().status).toBe("cancelled");

    store.getState().setScenario({
      id: "scenario-cancel",
      question: "Q",
      status: "simulating",
      created_at: "2026-03-23T00:00:00Z",
      agents: [],
      branches: [],
      groups: [],
      hierarchical: false,
      messages: [],
    });

    expect(store.getState().status).toBe("cancelled");
  });

  it("ignores stale websocket state events after cancellation", () => {
    const store = useSimulationStore;
    store.getState().setScenario({
      id: "scenario-cancel",
      question: "Q",
      status: "simulating",
      created_at: "2026-03-23T00:00:00Z",
      agents: [],
      branches: [],
      groups: [],
      hierarchical: false,
      messages: [],
    });
    store.getState().setCancelled("user_cancelled");

    const before = {
      status: store.getState().status,
      cancelReason: store.getState().cancelReason,
      messages: store.getState().messages,
      thinkingAgents: store.getState().thinkingAgents,
      branches: store.getState().branches,
      interventionLog: store.getState().interventionLog,
      currentRound: store.getState().currentRound,
    };

    store.getState().handleWSEvent({
      type: "agent_speak_start",
      data: { agent: "Alpha", agent_id: "a1", branch: "b1", round: 1 },
    } as WSEvent);
    store.getState().handleWSEvent({
      type: "agent_speak",
      data: {
        agent: "Alpha",
        agent_id: "a1",
        branch: "b1",
        round: 1,
        message: "late message",
        emotion: "neutral",
      },
    } as WSEvent);
    store.getState().handleWSEvent({
      type: "round_summary",
      data: { round: 1, branch_id: "b1", summary: "late round" },
    } as WSEvent);
    store.getState().handleWSEvent({
      type: "branch_init",
      data: { id: "b1", title: "Late branch", probability: 1, status: "ACTIVE", parent_branch_id: null },
    } as WSEvent);
    store.getState().handleWSEvent({
      type: "intervention_applied",
      data: { branch_id: "b1", text: "late intervention", round: 1, intervention_id: "int-late" },
    } as WSEvent);

    expect({
      status: store.getState().status,
      cancelReason: store.getState().cancelReason,
      messages: store.getState().messages,
      thinkingAgents: store.getState().thinkingAgents,
      branches: store.getState().branches,
      interventionLog: store.getState().interventionLog,
      currentRound: store.getState().currentRound,
    }).toEqual(before);
  });

  it("reset clears cancelled state back to idle", () => {
    const store = useSimulationStore;
    store.getState().setCancelled("user_cancelled");
    expect(store.getState().status).toBe("cancelled");

    store.getState().reset();

    expect(store.getState().status).toBe("idle");
    expect(store.getState().cancelReason).toBeNull();
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
    }, {
      signal: expect.objectContaining({ aborted: false }),
    });
    expect(useSimulationStore.getState().interventionLifecycle.size).toBe(0);
    expect(useSimulationStore.getState().interventionLog).toEqual([]);
  });

  it("aborts the active startSimulation request", async () => {
    let capturedSignal: AbortSignal | undefined;
    createScenarioMock.mockImplementationOnce(
      (_options: unknown, requestOptions?: { signal?: AbortSignal }) => {
        capturedSignal = requestOptions?.signal;
        return new Promise((_resolve, reject) => {
          capturedSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    );

    const pendingStart = useSimulationStore.getState()
      .startSimulation({ question: "question" })
      .catch(() => undefined);

    await vi.waitFor(() => {
      expect(capturedSignal).toBeDefined();
    });
    expect(capturedSignal?.aborted).toBe(false);

    useSimulationStore.getState().abortStartSimulation();

    expect(capturedSignal?.aborted).toBe(true);
    await pendingStart;
  });

  it("ignores a stale aborted start after a newer start succeeds", async () => {
    let firstSignal: AbortSignal | undefined;
    let rejectFirstStart: (error: Error) => void = () => {};
    createScenarioMock
      .mockImplementationOnce(
        (_options: unknown, requestOptions?: { signal?: AbortSignal }) => {
          firstSignal = requestOptions?.signal;
          return new Promise((_resolve, reject) => {
            rejectFirstStart = reject;
          });
        },
      )
      .mockResolvedValueOnce({
        id: "scenario-new",
        question: "new question",
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

    const staleStart = useSimulationStore.getState()
      .startSimulation({ question: "old question" })
      .catch(() => undefined);

    await vi.waitFor(() => {
      expect(firstSignal).toBeDefined();
    });

    const newScenarioId = await useSimulationStore.getState()
      .startSimulation({ question: "new question" });
    expect(newScenarioId).toBe("scenario-new");
    expect(firstSignal?.aborted).toBe(true);

    rejectFirstStart(new Error("aborted"));
    await staleStart;

    expect(useSimulationStore.getState().status).toBe("parsing");
    expect(useSimulationStore.getState().scenario?.id).toBe("scenario-new");
    expect(useSimulationStore.getState().error).toBeNull();
  });

  it("ignores a stale successful start after a newer start succeeds", async () => {
    let firstSignal: AbortSignal | undefined;
    let resolveFirstStart: (scenario: unknown) => void = () => {};
    createScenarioMock
      .mockImplementationOnce(
        (_options: unknown, requestOptions?: { signal?: AbortSignal }) => {
          firstSignal = requestOptions?.signal;
          return new Promise((resolve) => {
            resolveFirstStart = resolve;
          });
        },
      )
      .mockResolvedValueOnce({
        id: "scenario-new",
        question: "new question",
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

    const staleStart = useSimulationStore.getState()
      .startSimulation({ question: "old question" })
      .catch(() => undefined);

    await vi.waitFor(() => {
      expect(firstSignal).toBeDefined();
    });

    const newScenarioId = await useSimulationStore.getState()
      .startSimulation({ question: "new question" });
    expect(newScenarioId).toBe("scenario-new");
    expect(firstSignal?.aborted).toBe(true);

    resolveFirstStart({
      id: "scenario-old",
      question: "old question",
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
    await staleStart;

    expect(useSimulationStore.getState().scenario?.id).toBe("scenario-new");
    expect(useSimulationStore.getState().error).toBeNull();
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
  it("clears the previous scenario immediately when a different scenario starts loading", async () => {
    const deferred = createDeferred<Scenario>();
    const store = useSimulationStore;
    store.getState().setScenario(makeScenario("scenario-a", {
      agents: [{ id: "agent-a", name: "A", role: "A", tier: "CORE", emotion: "neutral" }],
      branches: [{
        id: "branch-a",
        parent_branch_id: null,
        fork_round: 0,
        fork_reason: "",
        title: "Branch A",
        summary: "",
        story: "",
        insight: "",
        key_moments: [],
        probability: 1,
        status: "ACTIVE",
      }],
      messages: [{
        agent: "A",
        agent_id: "agent-a",
        branch: "branch-a",
        round: 1,
        message: "A-only message",
        emotion: "neutral",
      }],
    }));
    store.getState().handleWSEvent({
      type: "agent_speak_start",
      data: { agent: "A", agent_id: "agent-a", branch: "branch-a", round: 2 },
    } as WSEvent);
    getScenarioMock.mockReturnValueOnce(deferred.promise);

    const pendingLoad = store.getState().loadScenario("scenario-b");

    expect(getScenarioMock).toHaveBeenCalledWith("scenario-b");
    expect(store.getState()).toMatchObject({
      activeScenarioId: "scenario-b",
      scenario: null,
      agents: [],
      branches: [],
      messages: [],
      thinkingAgents: [],
      status: "idle",
      currentRound: 0,
    });

    deferred.resolve(makeScenario("scenario-b"));
    await pendingLoad;
  });

  it("ignores an older scenario response that resolves after the new route response", async () => {
    const scenarioAResponse = createDeferred<Scenario>();
    const scenarioBResponse = createDeferred<Scenario>();
    const store = useSimulationStore;
    store.getState().setScenario(makeScenario("scenario-a", { question: "Scenario A" }));
    getScenarioMock
      .mockReturnValueOnce(scenarioAResponse.promise)
      .mockReturnValueOnce(scenarioBResponse.promise);

    const staleLoad = store.getState().loadScenario("scenario-a");
    const currentLoad = store.getState().loadScenario("scenario-b");
    scenarioBResponse.resolve(makeScenario("scenario-b", { question: "Scenario B" }));
    await currentLoad;
    scenarioAResponse.resolve(makeScenario("scenario-a", {
      question: "Late Scenario A",
      status: "done",
    }));
    await staleLoad;

    expect(store.getState().activeScenarioId).toBe("scenario-b");
    expect(store.getState().scenario?.id).toBe("scenario-b");
    expect(store.getState().scenario?.question).toBe("Scenario B");
  });

  it("treats same-scenario empty message and branch arrays as authoritative", () => {
    const store = useSimulationStore;
    const base = makeScenario("scenario-authoritative-empty");
    store.getState().setScenario(makeScenario("scenario-authoritative-empty", {
      branches: [{
        id: "stale-branch",
        parent_branch_id: null,
        fork_round: 0,
        fork_reason: "",
        title: "Stale branch",
        summary: "",
        story: "",
        insight: "",
        key_moments: [],
        probability: 1,
        status: "ACTIVE",
      }],
      messages: [{
        agent: "Stale",
        agent_id: "stale-agent",
        branch: "stale-branch",
        round: 1,
        message: "Stale message",
        emotion: "neutral",
      }],
    }));

    store.getState().setScenario({ ...base, branches: [], messages: [] });

    expect(store.getState().branches).toEqual([]);
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().scenario?.branches).toEqual([]);
    expect(store.getState().scenario?.messages).toEqual([]);
  });

  it("ignores websocket events tagged for a different scenario", () => {
    const store = useSimulationStore;
    store.getState().setScenario(makeScenario("scenario-b"));

    store.getState().handleWSEvent({
      type: "agent_speak",
      data: {
        agent: "Late A",
        agent_id: "agent-a",
        branch: "branch-a",
        round: 2,
        message: "Late A message",
        emotion: "neutral",
      },
    } as WSEvent, "scenario-a");

    expect(store.getState().messages).toEqual([]);
    expect(store.getState().thinkingAgents).toEqual([]);
  });

  it("defaults to classic mode for completed scenarios even with visualization enabled", () => {
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
    expect(store.getState().viewMode).toBe("classic");
  });

  it("restores theater mode for in-progress scenarios with visualization enabled", () => {
    const store = useSimulationStore;

    store.getState().setScenario({
      id: "s1b",
      question: "如果罗马帝国从未衰落？",
      status: "simulating",
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

  it("preserves theater mode when same scenario resyncs to done", () => {
    const store = useSimulationStore;
    const sharedScenario: Omit<Scenario, "status"> = {
      id: "s1c",
      question: "如果罗马帝国从未衰落？",
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
    };

    store.getState().setScenario({ ...sharedScenario, status: "simulating" });
    expect(store.getState().viewMode).toBe("theater");

    store.getState().setScenario({ ...sharedScenario, status: "done" });
    expect(store.getState().viewMode).toBe("theater");
  });

  it("can force classic mode for completed same-scenario route entry", () => {
    const store = useSimulationStore;
    const sharedScenario: Omit<Scenario, "status"> = {
      id: "s1e",
      question: "如果罗马帝国从未衰落？",
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
    };

    store.getState().setScenario({ ...sharedScenario, status: "simulating" });
    store.getState().setScenario({ ...sharedScenario, status: "done" });
    expect(store.getState().viewMode).toBe("theater");

    store.getState().setScenario(
      { ...sharedScenario, status: "done" },
      { forceClassicForDone: true },
    );
    expect(store.getState().viewMode).toBe("classic");
  });

  it("keeps theater for replay mode even when scenario is done", () => {
    const store = useSimulationStore;

    store.getState().setScenario(
      {
        id: "s1d",
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
      },
      { replayMode: true },
    );

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

  describe("simulationStore — watchdog and progress events", () => {
    it("updates lastContentEventAt on various WS events", () => {
      const store = useSimulationStore;
      store.getState().reset();
      expect(store.getState().lastContentEventAt).toBe(0);

      // 1. Status event
      store.getState().handleWSEvent({
        type: "status",
        data: { status: "simulating" },
      } as WSEvent);
      const t1 = store.getState().lastContentEventAt;
      expect(t1).toBeGreaterThan(0);

      // 2. agent_speak_start
      store.getState().handleWSEvent({
        type: "agent_speak_start",
        data: { agent: "A", agent_id: "a1", branch: "b1", round: 1 },
      } as WSEvent);
      const t2 = store.getState().lastContentEventAt;
      expect(t2).toBeGreaterThanOrEqual(t1);

      // 3. turn_progress
      store.getState().handleWSEvent({
        type: "turn_progress",
        data: { branch_id: "b1", round: 1, completed: 2, total: 5 },
      } as WSEvent);
      const t3 = store.getState().lastContentEventAt;
      expect(t3).toBeGreaterThanOrEqual(t2);
      expect(store.getState().turnProgress).toEqual({
        branch_id: "b1",
        round: 1,
        completed: 2,
        total: 5,
      });

      // 4. round_progress
      store.getState().handleWSEvent({
        type: "round_progress",
        data: { round: 2, phase: "round_start", active_branches: 1 },
      } as WSEvent);
      const t4 = store.getState().lastContentEventAt;
      expect(t4).toBeGreaterThanOrEqual(t3);
      expect(store.getState().turnProgress).toBeNull();
      expect(store.getState().activeRoundProgress).toEqual({
        round: 2,
        active_branches: 1,
      });
      expect(store.getState().currentRound).toBe(0);
    });

    it("keeps active round progress separate from completed currentRound", () => {
      const store = useSimulationStore;
      store.getState().reset();

      store.getState().handleWSEvent({
        type: "round_progress",
        data: { round: 1, phase: "round_start", active_branches: 2 },
      } as WSEvent);

      expect(store.getState().currentRound).toBe(0);
      expect(store.getState().activeRoundProgress).toEqual({
        round: 1,
        active_branches: 2,
      });

      store.getState().handleWSEvent({
        type: "turn_progress",
        data: { branch_id: "branch-a", round: 1, completed: 1, total: 3 },
      } as WSEvent);

      expect(store.getState().currentRound).toBe(0);
      expect(store.getState().activeRoundProgress).toEqual({
        round: 1,
        active_branches: 2,
      });
      expect(store.getState().turnProgress).toEqual({
        branch_id: "branch-a",
        round: 1,
        completed: 1,
        total: 3,
      });
    });

    it("preserves lastContentEventAt across a same-scenario re-poll so a true orphan's stuck banner does not self-clear", () => {
      vi.useFakeTimers();
      try {
        const store = useSimulationStore;
        store.getState().reset();
        const base = {
          id: "orphan-resync",
          question: "q",
          created_at: new Date().toISOString(),
          total_rounds: 5,
          mode: "blackboard",
          visualization_enabled: false,
          scene_theme: null,
          agents: [],
          branches: [],
          groups: [],
          hierarchical: false,
          messages: [],
        };
        // First load of a fresh scenario seeds the watchdog signal.
        store.getState().setScenario({ ...base, status: "simulating" } as Scenario);
        const seeded = store.getState().lastContentEventAt;
        expect(seeded).toBeGreaterThan(0);

        // Time passes with NO new content frame; the watchdog's stuck re-poll resyncs
        // the SAME scenario. The signal must stay put — otherwise the reset effect
        // clears simulationStuck and a true orphan's banner only flickers.
        vi.advanceTimersByTime(5000);
        store.getState().setScenario({ ...base, status: "simulating" } as Scenario);
        expect(store.getState().lastContentEventAt).toBe(seeded);

        // A genuine incremental WS frame still advances the signal.
        store.getState().handleWSEvent({
          type: "agent_speak_start",
          data: { agent: "A", agent_id: "a1", branch: "b1", round: 1 },
        } as WSEvent);
        expect(store.getState().lastContentEventAt).toBeGreaterThan(seeded);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
