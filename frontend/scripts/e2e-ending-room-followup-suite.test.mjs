import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "e2e-ending-room-followup-suite.mjs");
const SCRIPT_SOURCE = fs.readFileSync(SCRIPT_PATH, "utf8");

function extractAsyncFunction(name) {
  const marker = `async function ${name}`;
  const start = SCRIPT_SOURCE.indexOf(marker);
  if (start === -1) {
    throw new Error(`Function not found: ${name}`);
  }

  let parenDepth = 0;
  let braceIndex = -1;
  for (let index = start; index < SCRIPT_SOURCE.length; index += 1) {
    const char = SCRIPT_SOURCE[index];
    if (char === "(") {
      parenDepth += 1;
    } else if (char === ")") {
      parenDepth -= 1;
    } else if (char === "{" && parenDepth === 0) {
      braceIndex = index;
      break;
    }
  }
  if (braceIndex === -1) {
    throw new Error(`Failed to locate function body: ${name}`);
  }

  let depth = 0;

  for (let index = braceIndex; index < SCRIPT_SOURCE.length; index += 1) {
    const char = SCRIPT_SOURCE[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return SCRIPT_SOURCE.slice(start, index + 1);
      }
    }
  }

  throw new Error(`Failed to parse function body: ${name}`);
}

function extractFunction(name) {
  const asyncMarker = `async function ${name}`;
  const syncMarker = `function ${name}`;
  const start = SCRIPT_SOURCE.indexOf(asyncMarker) !== -1
    ? SCRIPT_SOURCE.indexOf(asyncMarker)
    : SCRIPT_SOURCE.indexOf(syncMarker);
  if (start === -1) {
    throw new Error(`Function not found: ${name}`);
  }

  let parenDepth = 0;
  let braceIndex = -1;
  for (let index = start; index < SCRIPT_SOURCE.length; index += 1) {
    const char = SCRIPT_SOURCE[index];
    if (char === "(") {
      parenDepth += 1;
    } else if (char === ")") {
      parenDepth -= 1;
    } else if (char === "{" && parenDepth === 0) {
      braceIndex = index;
      break;
    }
  }
  if (braceIndex === -1) {
    throw new Error(`Failed to locate function body: ${name}`);
  }
  let depth = 0;

  for (let index = braceIndex; index < SCRIPT_SOURCE.length; index += 1) {
    const char = SCRIPT_SOURCE[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return SCRIPT_SOURCE.slice(start, index + 1);
      }
    }
  }

  throw new Error(`Failed to parse function body: ${name}`);
}

function loadAsyncFunction(name, injected = {}) {
  const parameterNames = Object.keys(injected);
  const parameterValues = Object.values(injected);
  const factory = new Function(
    ...parameterNames,
    `${extractAsyncFunction(name)}\nreturn ${name};`,
  );
  return factory(...parameterValues);
}

function loadFunction(name, injected = {}) {
  const parameterNames = Object.keys(injected);
  const parameterValues = Object.values(injected);
  const factory = new Function(
    ...parameterNames,
    `${extractFunction(name)}\nreturn ${name};`,
  );
  return factory(...parameterValues);
}

const POLL_ONCE = async (_page, probe) => probe();
const FRONTEND_URL = "http://127.0.0.1:18928";

test("parseArgs accepts an explicit locale override", () => {
  const normalizeLocale = loadFunction("normalizeLocale");
  const parseArgs = loadFunction("parseArgs", {
    DEFAULT_BASE_URL: FRONTEND_URL,
    normalizeLocale,
    VALID_BROWSERS: new Set(["chromium", "firefox", "webkit"]),
    VALID_LOCALES: new Set(["zh", "en"]),
  });

  const args = parseArgs([
    "node",
    "e2e-ending-room-followup-suite.mjs",
    "desktop",
    "--url",
    FRONTEND_URL,
    "--locale",
    "en-US",
  ]);

  assert.equal(args.locale, "en");
});

test("parseArgs defaults to the standard frontend URL", () => {
  const normalizeLocale = loadFunction("normalizeLocale");
  const parseArgs = loadFunction("parseArgs", {
    DEFAULT_BASE_URL: FRONTEND_URL,
    normalizeLocale,
    VALID_BROWSERS: new Set(["chromium", "firefox", "webkit"]),
    VALID_LOCALES: new Set(["zh", "en"]),
  });

  const args = parseArgs([
    "node",
    "e2e-ending-room-followup-suite.mjs",
    "desktop",
  ]);

  assert.equal(args.url, FRONTEND_URL);
});

test("findScenarioIds prefers the newest fully-completed single and multi scenarios", async () => {
  const detailsById = {
    "multi-old": {
      id: "multi-old",
      created_at: "2026-04-01T00:00:00Z",
      agents: [{ id: "a1" }],
      messages: [{ id: "m1" }],
      branches: [
        { id: "b1", status: "COMPLETED", story: "done" },
        { id: "b2", status: "COMPLETED", story: "done" },
      ],
    },
    "multi-incomplete-newer": {
      id: "multi-incomplete-newer",
      created_at: "2026-04-10T00:00:00Z",
      agents: [{ id: "a1" }],
      messages: [{ id: "m1" }],
      branches: [
        { id: "b1", status: "COMPLETED", story: "done" },
        { id: "b2", status: "RUNNING", story: "" },
      ],
    },
    "multi-new": {
      id: "multi-new",
      created_at: "2026-04-12T00:00:00Z",
      agents: [{ id: "a1" }],
      messages: [{ id: "m1" }],
      branches: [
        { id: "b1", status: "COMPLETED", story: "done" },
        { id: "b2", status: "COMPLETED", story: "done" },
        { id: "b3", status: "COMPLETED", story: "done" },
      ],
    },
    "single-old": {
      id: "single-old",
      created_at: "2026-04-01T00:00:00Z",
      agents: [{ id: "a1" }],
      messages: [{ id: "m1" }],
      branches: [{ id: "b1", status: "COMPLETED", story: "done" }],
    },
    "single-incomplete-newer": {
      id: "single-incomplete-newer",
      created_at: "2026-04-11T00:00:00Z",
      agents: [{ id: "a1" }],
      messages: [{ id: "m1" }],
      branches: [{ id: "b1", status: "RUNNING", story: "" }],
    },
    "single-new": {
      id: "single-new",
      created_at: "2026-04-12T12:00:00Z",
      agents: [{ id: "a1" }],
      messages: [{ id: "m1" }],
      branches: [{ id: "b1", status: "COMPLETED", story: "done" }],
    },
  };

  const fetchJson = async (url) => {
    if (url.endsWith("/api/scenarios?status=done&limit=80&offset=0")) {
      return {
        scenarios: Object.keys(detailsById).map((id) => ({ id })),
      };
    }

    const scenarioId = url.split("/").at(-1);
    const detail = detailsById[scenarioId];
    if (!detail) {
      throw new Error(`Unknown scenario URL: ${url}`);
    }
    return detail;
  };

  const findScenarioIds = loadAsyncFunction("findScenarioIds", {
    fetchJson,
    resolveBackendUrl: () => "http://127.0.0.1:18927",
  });

  await assert.deepEqual(
    await findScenarioIds("http://127.0.0.1:18928"),
    { multiId: "multi-new", singleId: "single-new" },
  );
});

test("buildFollowupExpectations counts the same-thread user turn in expected totals", async () => {
  const normalizeVisibleText = loadFunction("normalizeVisibleText");
  const buildFollowupVisibilityNeedles = loadFunction("buildFollowupVisibilityNeedles", {
    normalizeVisibleText,
  });
  const buildFollowupExpectations = loadFunction("buildFollowupExpectations", {
    buildFollowupVisibilityNeedles,
  });

  const expectations = buildFollowupExpectations(
    {
      active_thread_id: "thread-room",
      turn_count: 3,
      thread_count: 1,
    },
    {
      thread_id: "thread-room",
      turns: [
        {
          id: "turn-user",
          thread_id: "thread-room",
          source: "user_turn",
          interaction_mode: "hotseat",
          content: "Follow this up",
        },
        {
          id: "turn-assistant",
          thread_id: "thread-room",
          source: "assistant_followup",
          interaction_mode: "hotseat",
          content: "Here is the follow-up answer",
        },
      ],
    },
  );

  assert.equal(expectations.expectedTurnCount, 5);
  assert.equal(expectations.expectedSnapshotTurnCount, 5);
});

test("waitForApiDrivenFollowupVisible does not treat unchanged same-thread thread_count as progress", async () => {
  const waitForApiDrivenFollowupVisible = loadAsyncFunction("waitForApiDrivenFollowupVisible", {
    buildFollowupExpectations: () => ({
      expectedThreadId: "thread-room",
      expectedTurnCount: 5,
      expectedInteractionMode: "hotseat",
      expectedThreadCount: 1,
      expectedSnapshotTurnCount: 5,
      visibilityNeedles: [],
    }),
    waitFor: POLL_ONCE,
    getAutomationState: async () => ({
      page: {
        controls: {
          modal_state: {
            room_id: "room-1",
            active_thread_id: "thread-room",
            interaction_mode: "hotseat",
            turn_count: 3,
            thread_count: 1,
            pending_draft_count: 0,
          },
        },
      },
    }),
    isFollowupModalStateSatisfied: () => false,
    anchorIdsEqual: () => true,
    waitForExpectedFollowupSettled: async () => {
      throw new Error("Unexpected settled fallback");
    },
  });

  const result = await waitForApiDrivenFollowupVisible(
    { evaluate: async () => false },
    {
      label: "same-thread stale state",
      roomId: "room-1",
      beforeModalState: {
        active_thread_id: "thread-room",
        turn_count: 3,
        thread_count: 1,
      },
      apiPayload: {
        thread_id: "thread-room",
        turns: [
          { id: "turn-user", source: "user_turn", thread_id: "thread-room" },
          { id: "turn-assistant", source: "assistant_followup", thread_id: "thread-room" },
        ],
      },
      timeout: 1000,
    },
  );

  assert.equal(result, null);
});

test("waitForApiDrivenFollowupVisible rejects anchored snapshot fallback with only a user turn", async () => {
  const normalizeVisibleText = loadFunction("normalizeVisibleText");
  const buildFollowupVisibilityNeedles = loadFunction("buildFollowupVisibilityNeedles", {
    normalizeVisibleText,
  });
  const buildFollowupExpectations = loadFunction("buildFollowupExpectations", {
    buildFollowupVisibilityNeedles,
  });
  const anchorIdsEqual = loadFunction("anchorIdsEqual");
  const isFollowupModalStateSatisfied = loadFunction("isFollowupModalStateSatisfied", {
    anchorIdsEqual,
  });
  const waitForApiDrivenFollowupVisible = loadAsyncFunction("waitForApiDrivenFollowupVisible", {
    buildFollowupExpectations,
    isFollowupModalStateSatisfied,
    anchorIdsEqual,
    waitFor: POLL_ONCE,
    getAutomationState: async () => null,
    fetchJson: async () => ({
      threads: [
        {
          id: "thread-followup",
          interaction_mode: "thread_followup",
        },
      ],
      turns: [
        {
          id: "turn-user",
          thread_id: "thread-followup",
          source: "user_turn",
          question_anchor_ids_json: ["ending:verdict:room-1"],
        },
      ],
    }),
    resolveBackendUrl: () => "http://127.0.0.1:18927",
    waitForExpectedFollowupSettled: async () => {
      throw new Error("Unexpected settled fallback");
    },
  });

  const result = await waitForApiDrivenFollowupVisible(
    { evaluate: async () => false },
    {
      label: "anchored snapshot with user turn only",
      frontendUrl: FRONTEND_URL,
      roomId: "room-1",
      beforeModalState: {
        active_thread_id: "thread-room",
        turn_count: 3,
        thread_count: 1,
      },
      apiPayload: {
        thread_id: "thread-followup",
        turns: [
          {
            id: "turn-user",
            thread_id: "thread-followup",
            source: "user_turn",
            question_anchor_ids_json: ["ending:verdict:room-1"],
          },
        ],
      },
      timeout: 1000,
    },
  );

  assert.equal(result, null);
});

test("waitForExpectedFollowupSettled rejects anchored snapshot fallback when anchors do not match", async () => {
  const anchorIdsEqual = loadFunction("anchorIdsEqual");
  const isFollowupModalStateSatisfied = loadFunction("isFollowupModalStateSatisfied", {
    anchorIdsEqual,
  });
  const waitForExpectedFollowupSettled = loadAsyncFunction("waitForExpectedFollowupSettled", {
    isFollowupModalStateSatisfied,
    anchorIdsEqual,
    waitFor: POLL_ONCE,
    getAutomationState: async () => null,
    fetchJson: async () => ({
      threads: [
        {
          id: "thread-followup",
          interaction_mode: "thread_followup",
        },
      ],
      turns: [
        {
          id: "turn-user",
          thread_id: "thread-followup",
          source: "user_turn",
          question_anchor_ids_json: ["ending:verdict:room-other"],
        },
        {
          id: "turn-assistant",
          thread_id: "thread-followup",
          source: "assistant_followup",
          interaction_mode: "thread_followup",
          question_anchor_ids_json: ["ending:verdict:room-other"],
        },
      ],
    }),
    resolveBackendUrl: () => "http://127.0.0.1:18927",
  });

  const result = await waitForExpectedFollowupSettled(
    {},
    {
      label: "anchored snapshot with mismatched anchors",
      frontendUrl: FRONTEND_URL,
      roomId: "room-1",
      expectedThreadId: "thread-followup",
      expectedInteractionMode: "thread_followup",
      expectedTurnCount: 2,
      expectedThreadCount: 1,
      expectedSnapshotTurnCount: 2,
      expectedQuestionAnchorIds: ["ending:verdict:room-1"],
      timeout: 1000,
    },
  );

  assert.equal(result, null);
});

test("isFollowupCommitCandidate accepts same-thread mobile followups after assistant progress", async () => {
  const hasReachedCommittedTurnDelta = loadFunction("hasReachedCommittedTurnDelta");
  const isFollowupCommitCandidate = loadFunction("isFollowupCommitCandidate", {
    hasReachedCommittedTurnDelta,
  });

  assert.equal(
    isFollowupCommitCandidate(
      {
        interaction_mode: "hotseat",
        active_thread_id: "thread-room",
        pending_draft_count: 0,
        turn_count: 5,
      },
      {
        active_thread_id: "thread-room",
        turn_count: 3,
      },
      {
        interactionMode: "hotseat",
        minimumTurnDelta: 2,
      },
    ),
    true,
  );
});

test("isFollowupCommitCandidate accepts anchored followups after the new thread has both user and assistant turns", async () => {
  const hasReachedCommittedTurnDelta = loadFunction("hasReachedCommittedTurnDelta");
  const isFollowupCommitCandidate = loadFunction("isFollowupCommitCandidate", {
    hasReachedCommittedTurnDelta,
  });

  assert.equal(
    isFollowupCommitCandidate(
      {
        interaction_mode: "thread_followup",
        active_thread_id: "thread-followup",
        pending_draft_count: 0,
        question_anchor_ids: ["ending:verdict:room-1"],
        turn_count: 2,
      },
      {
        active_thread_id: "thread-room",
        turn_count: 3,
      },
      {
        interactionMode: "thread_followup",
        expectedThreadId: "thread-followup",
        minimumTurnCount: 2,
        requireAnchorIds: true,
      },
    ),
    true,
  );
});
