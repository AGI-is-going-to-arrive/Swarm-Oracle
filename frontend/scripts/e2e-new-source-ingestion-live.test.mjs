import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __test__ } from "./e2e-new-source-ingestion-live.mjs";

test("full mode keeps the legacy desktop and mobile Chromium surfaces", () => {
  const runs = __test__.buildSurfaceRuns({
    mode: "full",
    browser: "chromium",
    browserExplicitlySet: false,
  });

  assert.deepEqual(
    runs.map(({ mode, browser }) => `${mode}-${browser}`),
    ["desktop-chromium", "mobile-chromium"],
  );
});

test("explicit output directory is partitioned by surface", () => {
  const outputRoot = path.join(os.tmpdir(), "source-ingestion-output");

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

test("source card test IDs match desktop and mobile ResultView contracts", () => {
  assert.equal(__test__.sourceCardTestId("finance", "desktop"), "result-sources-finance");
  assert.equal(__test__.sourceCardTestId("finance", "mobile"), "result-sources-mobile-finance");
});
