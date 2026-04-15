import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "e2e-debate-suite.mjs");
const SCRIPT_SOURCE = fs.readFileSync(SCRIPT_PATH, "utf8");

function extractFunctionSource(name) {
  const markers = [`async function ${name}`, `function ${name}`];
  const start = markers
    .map((marker) => SCRIPT_SOURCE.indexOf(marker))
    .find((index) => index !== -1);
  if (start == null || start === -1) {
    throw new Error(`Function not found: ${name}`);
  }

  let braceIndex = SCRIPT_SOURCE.indexOf("{", start);
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

function extractAsyncFunction(name) {
  const marker = `async function ${name}`;
  const start = SCRIPT_SOURCE.indexOf(marker);
  if (start === -1) {
    throw new Error(`Function not found: ${name}`);
  }

  let braceIndex = SCRIPT_SOURCE.indexOf("{", start);
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
    `${extractFunctionSource(name)}\nreturn ${name};`,
  );
  return factory(...parameterValues);
}

function createPage({
  evaluateResults,
  hasSelectorResult = false,
  waitForResultNavigation = false,
} = {}) {
  let evaluateCallCount = 0;
  let waitForUrlCallCount = 0;

  return {
    get evaluateCallCount() {
      return evaluateCallCount;
    },
    get waitForUrlCallCount() {
      return waitForUrlCallCount;
    },
    async evaluate() {
      const result = evaluateResults[evaluateCallCount];
      evaluateCallCount += 1;
      return result;
    },
    async waitForTimeout() {},
    async waitForURL() {
      waitForUrlCallCount += 1;
      if (!waitForResultNavigation) {
        throw new Error("result route not reached");
      }
    },
    async hasSelector() {
      return hasSelectorResult;
    },
  };
}

test("openBet mobile fails instead of falling back to hidden hero CTA when the rail button is unavailable", async () => {
  const page = createPage({
    evaluateResults: [false, true],
  });
  const openBet = loadAsyncFunction("openBet", {
    hasSelector: async () => page.hasSelector(),
  });

  await assert.rejects(
    () => openBet(page, "mobile", "zh"),
    /mobile debate rail bet button/i,
  );
  assert.equal(page.evaluateCallCount, 1);
});

test("readReplayPermalink reuses the share modal permalink_url from automation state", () => {
  const readReplayPermalink = loadFunction("readReplayPermalink");

  const permalink = readReplayPermalink({
    page: {
      controls: {
        modal_state: {
          kind: "debate_share_modal",
          permalink_url: "https://example.com/debate/replay/result?replay=token-123",
        },
      },
    },
  });

  assert.equal(permalink, "https://example.com/debate/replay/result?replay=token-123");
});

test("readReplayPermalink also accepts local readonly replay links", () => {
  const readReplayPermalink = loadFunction("readReplayPermalink");

  const permalink = readReplayPermalink({
    page: {
      controls: {
        modal_state: {
          kind: "debate_share_modal",
          permalink_url: "https://example.com/debate/replay/result?local=replay-123",
        },
      },
    },
  });

  assert.equal(permalink, "https://example.com/debate/replay/result?local=replay-123");
});

test("isReadonlyReplayAutomation only accepts readonly replay result payloads that can be imported locally", () => {
  const isReadonlyReplayAutomation = loadFunction("isReadonlyReplayAutomation");

  assert.equal(
    isReadonlyReplayAutomation({
      page: {
        kind: "debate_result",
        loading: false,
        replay_source: "token",
        controls: {
          can_import_local_run: true,
        },
        replay: {
          is_readonly: true,
        },
      },
    }),
    true,
  );

  assert.equal(
    isReadonlyReplayAutomation({
      page: {
        kind: "debate_result",
        loading: false,
        replay_source: "local",
        controls: {
          can_import_local_run: true,
        },
        replay: {
          is_readonly: true,
        },
      },
    }),
    true,
  );

  assert.equal(
    isReadonlyReplayAutomation({
      page: {
        kind: "debate_result",
        loading: false,
        replay_source: "api",
        controls: {
          can_import_local_run: false,
        },
        replay: null,
      },
    }),
    false,
  );
});

test("openBet mobile fails instead of falling back to hidden hero CTA when the rail click does not open the modal", async () => {
  const page = createPage({
    evaluateResults: [true, true],
    hasSelectorResult: false,
  });
  const openBet = loadAsyncFunction("openBet", {
    hasSelector: async () => page.hasSelector(),
  });

  await assert.rejects(
    () => openBet(page, "mobile", "zh"),
    /mobile debate rail bet button/i,
  );
  assert.equal(page.evaluateCallCount, 1);
});

test("openResult mobile fails instead of falling back to hidden hero CTA when the rail button is unavailable", async () => {
  const page = createPage({
    evaluateResults: [false, true],
  });
  const openResult = loadAsyncFunction("openResult", {
    waitForAutomation: async () => {
      throw new Error("automation route not reached");
    },
  });

  await assert.rejects(
    () => openResult(page, "mobile", "zh"),
    /mobile debate rail result button/i,
  );
  assert.equal(page.evaluateCallCount, 1);
  assert.equal(page.waitForUrlCallCount, 0);
});

test("openResult mobile fails instead of falling back to hidden hero CTA when the rail click does not navigate", async () => {
  const page = createPage({
    evaluateResults: [true, true],
    waitForResultNavigation: false,
  });
  const openResult = loadAsyncFunction("openResult", {
    waitForAutomation: async () => {
      throw new Error("automation route not reached");
    },
  });

  await assert.rejects(
    () => openResult(page, "mobile", "zh"),
    /mobile debate rail result button/i,
  );
  assert.equal(page.evaluateCallCount, 1);
  assert.equal(page.waitForUrlCallCount, 1);
});
