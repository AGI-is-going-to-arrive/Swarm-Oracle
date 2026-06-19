import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assignLocalFontNames } from "./download-fonts.mjs";
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

test("download fonts assigns unique CJK chunk names per family style and weight", () => {
  const blocks = assignLocalFontNames([
    {
      subset: null,
      family: "Noto Sans SC",
      style: "normal",
      weight: "400",
      url: "https://example.test/0.woff2",
      range: "U+4E00-4E5F",
    },
    {
      subset: null,
      family: "Noto Sans SC",
      style: "normal",
      weight: "400",
      url: "https://example.test/1.woff2",
      range: "U+4E60-4EBF",
    },
    {
      subset: null,
      family: "Noto Sans SC",
      style: "normal",
      weight: "400",
      url: "https://example.test/2.woff2",
      range: "U+4EC0-4F1F",
    },
    {
      subset: "latin",
      family: "Instrument Sans",
      style: "normal",
      weight: "400 700",
      url: "https://example.test/latin.woff2",
      range: "U+0000-00FF",
    },
  ]);

  assert.deepEqual(
    blocks.map((block) => block.localName),
    [
      "noto-sans-sc-400-cjk-000.woff2",
      "noto-sans-sc-400-cjk-001.woff2",
      "noto-sans-sc-400-cjk-002.woff2",
      "instrument-sans-400-700.woff2",
    ],
  );
  assert.equal(new Set(blocks.map((block) => block.localName)).size, blocks.length);
});
