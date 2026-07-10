import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { __test__ } from "./e2e-result-report-suite.mjs";

const source = readFileSync(new URL("./e2e-result-report-suite.mjs", import.meta.url), "utf8");

test("result-report fixture fulfills a finite in-page SSE response without a fixed backend server", () => {
  assert.doesNotMatch(source, /node:http|startToolTraceSseServer|SWARM_BACKEND_PORT|passThroughReportGenerate/);
  assert.match(source, /contentType:\s*"text\/event-stream/);
  assert.match(source, /report_section_complete/);
  assert.match(source, /report_complete/);
});

test("finite report SSE ends with a real report_complete frame", () => {
  const frames = __test__.buildToolTraceSseBody()
    .trim()
    .split(/\r?\n\r?\n/u)
    .map((frame) => JSON.parse(frame.replace(/^data:\s*/u, "")));

  assert.equal(frames.length, 3);
  assert.equal(frames[1].event, "report_section_complete");
  assert.equal(frames[1].tool_trace.length, 2);
  assert.equal(frames[2].event, "report_complete");
  assert.equal(frames[2].error_code, undefined);
});

test("browser coverage checks the bounded SSE lifecycle instead of a transient tool-trace chip", () => {
  assert.doesNotMatch(source, /#report-tool-trace-trigger/);
  assert.match(source, /tooltrace-sse-report-complete/);
  assert.match(source, /tooltrace-refresh-count-bounded/);
  assert.match(source, /tooltrace-report-recovers/);
});

test("result-report browser assertions use the current report hero contract", () => {
  assert.doesNotMatch(source, /\.report-confidence-badge/);
  assert.match(source, /page\.locator\("\.report-hero"\)/);
});

test("result-report suite bounds Playwright cleanup and is import-safe", () => {
  assert.match(source, /closePlaywrightPage/);
  assert.match(source, /closePlaywrightContext/);
  assert.match(source, /closePlaywrightBrowser/);
  assert.match(source, /const IS_MAIN_MODULE/);
  assert.match(source, /if \(IS_MAIN_MODULE\)/);
});
