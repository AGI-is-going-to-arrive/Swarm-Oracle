import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __test__ } from "./e2e-native-search-suite.mjs";

test("default full surface covers the P5 browser matrix", () => {
  const runs = __test__.buildSurfaceRuns({
    mode: "full",
    browser: "chromium",
    browserExplicitlySet: false,
  });

  assert.deepEqual(
    runs.map(({ mode, browser }) => `${mode}-${browser}`),
    [
      "desktop-chromium",
      "mobile-chromium",
      "desktop-firefox",
      "mobile-firefox",
      "desktop-webkit",
      "mobile-webkit",
    ],
  );
});

test("mobile Firefox surface omits unsupported isMobile context option", () => {
  const [run] = __test__.buildSurfaceRuns({
    mode: "mobile",
    browser: "firefox",
    browserExplicitlySet: true,
  });

  assert.equal(run.mode, "mobile");
  assert.equal(run.browser, "firefox");
  assert.equal(run.context.viewport.width, 375);
  assert.equal(run.context.viewport.height, 812);
  assert.equal(Object.hasOwn(run.context, "isMobile"), false);
});

test("explicit output directory is still partitioned by surface and browser", () => {
  const outputRoot = path.join(os.tmpdir(), "native-search-output");

  assert.equal(
    __test__.resolveSurfaceOutputDir({
      outputDir: outputRoot,
      mode: "desktop",
      browser: "chromium",
    }),
    path.join(outputRoot, "desktop-chromium"),
  );
  assert.equal(
    __test__.resolveSurfaceOutputDir({
      outputDir: outputRoot,
      mode: "mobile",
      browser: "chromium",
    }),
    path.join(outputRoot, "mobile-chromium"),
  );
});
