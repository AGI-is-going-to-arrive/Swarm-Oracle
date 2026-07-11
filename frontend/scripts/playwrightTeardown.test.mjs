import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  closePlaywrightBrowser,
  closePlaywrightBrowsers,
  closePlaywrightContext,
  closePlaywrightPage,
  __test__,
} from "./playwrightTeardown.mjs";

test("page teardown propagates its close failure", async () => {
  const calls = [];
  const page = {
    isClosed: () => false,
    close: async () => {
      calls.push("page");
      throw new Error("page failed");
    },
  };

  await assert.rejects(
    closePlaywrightPage(page, "page-contract", 50),
    (error) => error instanceof AggregateError
      && /page-contract teardown failed/u.test(error.message),
  );
  assert.deepEqual(calls, ["page"]);
});

test("context teardown closes its pages before propagating its own close failure", async () => {
  const calls = [];
  const page = {
    isClosed: () => false,
    close: async () => {
      calls.push("page");
    },
  };
  const context = {
    pages: () => [page],
    close: async () => {
      calls.push("context");
      throw new Error("context failed");
    },
  };

  await assert.rejects(
    closePlaywrightContext(context, "context-contract", 50),
    (error) => error instanceof AggregateError
      && /context-contract teardown failed/u.test(error.message),
  );
  assert.deepEqual(calls, ["page", "context"]);
});

test("browser teardown attempts every layer and propagates any failure", async () => {
  const calls = [];
  const page = {
    isClosed: () => false,
    close: async () => {
      calls.push("page");
      throw new Error("page failed");
    },
  };
  const context = {
    pages: () => [page],
    close: async () => {
      calls.push("context");
    },
  };
  const browser = {
    contexts: () => [context],
    close: async () => {
      calls.push("browser");
    },
  };

  await assert.rejects(
    closePlaywrightBrowser(browser, "contract", 50),
    (error) => error instanceof AggregateError
      && /contract teardown failed/u.test(error.message),
  );
  assert.deepEqual(calls, ["page", "context", "browser"]);
});

test("suite finalizers do not let child teardown failures skip browser cleanup", () => {
  const generalSuite = readFileSync(new URL("./e2e-suite.mjs", import.meta.url), "utf8");
  const debateSuite = readFileSync(new URL("./e2e-debate-suite.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(
    generalSuite,
    /await closePlaywrightPage\([^;]+;\s*await closePlaywrightBrowser/u,
  );
  assert.doesNotMatch(
    generalSuite,
    /await closePlaywrightContext\([^;]+;\s*await closePlaywrightBrowser/u,
  );
  assert.doesNotMatch(
    debateSuite,
    /await context\.close\(\);\s*await browser\.close\(\);/u,
  );
  assert.match(debateSuite, /closePlaywrightBrowser/u);
});

test("release signoff scripts delegate final Playwright ownership to the teardown helper", () => {
  const releaseSignoffScripts = [
    "e2e-automation.mjs",
    "e2e-capability-matrix.mjs",
    "e2e-kg-explorer-live.mjs",
    "e2e-new-source-ingestion-live.mjs",
    "e2e-node-conversation-live.mjs",
    "e2e-phase3-batch-a.mjs",
    "e2e-phase3-batch-b.mjs",
    "e2e-phase3-batch-c.mjs",
    "e2e-replay-view-live.mjs",
    "e2e-web-search-suite.mjs",
  ];

  for (const script of releaseSignoffScripts) {
    const source = readFileSync(new URL(`./${script}`, import.meta.url), "utf8");
    assert.match(
      source,
      /import\s*\{[^}]*\bclosePlaywrightBrowser\b[^}]*\}\s*from\s*"\.\/playwrightTeardown\.mjs";/su,
      `${script} must import closePlaywrightBrowser`,
    );
    assert.match(
      source,
      /await closePlaywrightBrowser\(\s*browser,/u,
      `${script} must make the browser teardown helper the final owner`,
    );
    assert.doesNotMatch(
      source,
      /\bbrowser\.close\(/u,
      `${script} must not close the browser directly`,
    );
    assert.doesNotMatch(
      source,
      /\bcontext\.close\([^;]*?\)\.catch\(/su,
      `${script} must not swallow context teardown failures`,
    );
    assert.doesNotMatch(
      source,
      /\bpage\.close\([^;]*?\)\.catch\([\s\S]{0,500}?await closePlaywrightBrowser\(\s*browser,/u,
      `${script} must not swallow final page teardown failures before browser ownership`,
    );
  }

  const capabilityMatrix = readFileSync(
    new URL("./e2e-capability-matrix.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    capabilityMatrix,
    /await closePlaywrightContext\(\s*context,/u,
    "capability matrix must delegate each per-page context cleanup",
  );
});

test("release signoff runners acquire Playwright resources inside browser ownership", () => {
  const runnerContracts = new Map([
    ["e2e-node-conversation-live.mjs", ["runSurface"]],
    ["e2e-kg-explorer-live.mjs", ["runSurface"]],
    ["e2e-new-source-ingestion-live.mjs", ["runSurface"]],
    ["e2e-replay-view-live.mjs", ["runSurface"]],
    ["e2e-phase3-batch-a.mjs", ["runSurface"]],
    ["e2e-phase3-batch-b.mjs", ["runSurface"]],
    ["e2e-phase3-batch-c.mjs", ["runSurface"]],
    ["e2e-web-search-suite.mjs", ["runWebSearchFlow"]],
    [
      "e2e-suite.mjs",
      [
        "runCrossBrowserDirectorStateSuite",
        "runMatrixSuite",
        "runCornersSuite",
        "runMobileSuite",
      ],
    ],
    ["e2e-debate-suite.mjs", ["runSurface"]],
  ]);
  const acquisitionPattern = /(?:browser\.new(?:Context|Page)|context\.newPage)\(|await install(?:Fixtures|LivePreflightBypass|CornersFixture)\(/gu;
  const launchPattern = /const\s+(?:browser|\{[^}]*\bbrowser\b[^}]*\})\s*=\s*await\s+(?:launchBrowser|launchBrowserWithEngine)\([^;]+;/su;

  for (const [script, runnerNames] of runnerContracts) {
    const source = readFileSync(new URL(`./${script}`, import.meta.url), "utf8");
    for (const runnerName of runnerNames) {
      const signature = `async function ${runnerName}(`;
      const start = source.indexOf(signature);
      assert.notEqual(start, -1, `${script} must define ${runnerName}`);
      const nextFunction = source.indexOf("\nasync function ", start + signature.length);
      const runner = source.slice(start, nextFunction === -1 ? source.length : nextFunction);
      const launch = runner.match(launchPattern);
      assert.ok(launch, `${script}:${runnerName} must acquire a browser`);

      const afterLaunch = runner.slice((launch.index ?? 0) + launch[0].length);
      assert.match(
        afterLaunch,
        /^\s*try\s*\{/u,
        `${script}:${runnerName} must enter browser ownership immediately after launch`,
      );

      const ownershipStart = (launch.index ?? 0) + launch[0].length + afterLaunch.indexOf("try");
      const finalizerStart = runner.lastIndexOf("finally {");
      const finalOwner = runner.lastIndexOf("closePlaywrightBrowser(");
      assert.ok(finalizerStart > ownershipStart, `${script}:${runnerName} must retain an outer finalizer`);
      assert.ok(finalOwner > finalizerStart, `${script}:${runnerName} must finalize its browser`);
      assert.equal(
        runner.match(/closePlaywrightBrowser\(/gu)?.length,
        1,
        `${script}:${runnerName} must have exactly one final browser owner`,
      );
      assert.doesNotMatch(runner, /\bbrowser\.close\(/u);

      for (const acquisition of runner.matchAll(acquisitionPattern)) {
        assert.ok(
          acquisition.index > ownershipStart && acquisition.index < finalOwner,
          `${script}:${runnerName} leaves ${acquisition[0]} outside browser ownership`,
        );
      }
    }
  }
});

test("fixture restoration cannot skip the e2e suite browser final owner", () => {
  const source = readFileSync(new URL("./e2e-suite.mjs", import.meta.url), "utf8");
  for (const runnerName of ["runCornersSuite", "runMobileSuite"]) {
    const signature = `async function ${runnerName}(`;
    const start = source.indexOf(signature);
    const nextFunction = source.indexOf("\nasync function ", start + signature.length);
    const runner = source.slice(start, nextFunction === -1 ? source.length : nextFunction);
    assert.match(
      runner,
      /finally\s*\{\s*try\s*\{\s*if \(fixture\) fixture\.nodeFixture\.restore\(\);\s*\}\s*finally\s*\{\s*await closePlaywrightBrowser\(/su,
      `${runnerName} must close the browser even when fixture restoration fails`,
    );
  }
});

test("multi-browser teardown continues after one owned browser fails", async () => {
  const calls = [];
  const failingBrowser = {
    contexts: () => [{
      pages: () => [{
        isClosed: () => false,
        close: async () => {
          calls.push("first-page");
          throw new Error("first page failed");
        },
      }],
      close: async () => calls.push("first-context"),
    }],
    close: async () => calls.push("first-browser"),
  };
  const secondBrowser = {
    contexts: () => [],
    close: async () => calls.push("second-browser"),
  };

  await assert.rejects(
    closePlaywrightBrowsers([failingBrowser, secondBrowser], "owned", 50),
    (error) => error instanceof AggregateError && /owned teardown failed/u.test(error.message),
  );
  assert.deepEqual(calls, ["first-page", "first-context", "first-browser", "second-browser"]);
});

test("Windows descendant discovery is fail-closed instead of a platform no-op", () => {
  const rows = __test__.parseProcessTable("20 10\n30 20\n40 10\n50 99\n");
  assert.deepEqual(__test__.collectDescendantPids(10, rows), [20, 30, 40]);

  const source = readFileSync(new URL("./playwrightTeardown.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /process\.platform === "win32"\) \{\s*return \[\];/u);
  assert.match(source, /powershell\.exe/u);
  assert.match(source, /taskkill\.exe/u);
});
