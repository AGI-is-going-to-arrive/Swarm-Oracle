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
  const rawFrames = __test__.buildToolTraceSseBody()
    .trim()
    .split(/\r?\n\r?\n/u);
  const frames = rawFrames.map((frame) => {
    const eventLine = frame.split(/\r?\n/u).find((line) => line.startsWith("event:"));
    const dataLine = frame.split(/\r?\n/u).find((line) => line.startsWith("data:"));
    assert.ok(eventLine);
    assert.ok(dataLine);
    const event = eventLine.replace(/^event:\s*/u, "");
    const data = JSON.parse(dataLine.replace(/^data:\s*/u, ""));
    assert.equal(data.event, undefined);
    return { event, data };
  });

  assert.equal(frames.length, 3);
  for (const frame of frames) {
    assert.equal(typeof frame.data.status, "string");
    assert.ok(Array.isArray(frame.data.tool_trace));
  }
  assert.equal(frames[1].event, "report_section_complete");
  assert.equal(frames[1].data.status, "complete");
  assert.equal(frames[1].data.tier, "generation");
  assert.equal(frames[1].data.tool_trace.length, 2);
  assert.equal(frames[2].event, "report_complete");
  assert.equal(frames[2].data.status, "complete");
  assert.equal(frames[2].data.error_code, undefined);
  assert.equal(frames.filter((frame) => frame.event === "report_complete").length, 1);
});

test("browser coverage checks the bounded SSE lifecycle instead of a transient tool-trace chip", () => {
  assert.doesNotMatch(source, /#report-tool-trace-trigger/);
  assert.match(source, /tooltrace-sse-report-complete/);
  assert.match(source, /tooltrace-refresh-count-bounded/);
  assert.match(source, /tooltrace-report-recovers/);
  assert.match(
    source,
    /partialBanner\.waitFor\(\{\s*state:\s*"hidden",\s*timeout:\s*12000\s*\}\)/su,
  );
  assert.doesNotMatch(
    source,
    /page\.reload\(\{\s*waitUntil:\s*"domcontentloaded"/su,
  );
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
  assert.doesNotMatch(
    source,
    /if \(page\) await closePlaywrightPage\([^;]+;\s*if \(context\) await closePlaywrightContext\([^;]+;\s*await closePlaywrightBrowser/u,
  );
});
