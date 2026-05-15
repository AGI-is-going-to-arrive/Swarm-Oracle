import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { __test__ } from "./e2e-web-search-suite.mjs";

test("default provider base URLs match provider allowlist contracts", () => {
  assert.equal(__test__.defaultProviderBaseUrl("tavily"), "https://api.tavily.com/search");
  assert.equal(__test__.defaultProviderBaseUrl("exa"), "https://api.exa.ai/search");
  assert.equal(__test__.defaultProviderBaseUrl("firecrawl"), "https://api.firecrawl.dev/v2/search");
  assert.equal(__test__.defaultProviderBaseUrl("xai"), "https://api.x.ai/v1/responses");
  assert.equal(__test__.defaultProviderBaseUrl("searxng"), "http://localhost:8888");
});

test("parseArgs resolves frontend-relative output dirs", () => {
  const args = __test__.parseArgs([
    "node",
    "script",
    "--url",
    "http://127.0.0.1:19030",
    "--provider",
    "exa",
    "--api-key",
    "secret-key",
    "--intensity",
    "deep",
    "--output-dir",
    "output/e2e/web-search-live",
    "--headless",
  ]);

  assert.equal(args.baseUrl, "http://127.0.0.1:19030");
  assert.equal(args.provider, "exa");
  assert.equal(args.apiKey, "secret-key");
  assert.equal(args.intensity, "deep");
  assert.equal(args.headless, true);
  assert.equal(
    args.outputDir,
    path.resolve("output/e2e/web-search-live"),
  );
});

test("parseArgs rejects unsupported web search intensity values", () => {
  assert.throws(
    () => __test__.parseArgs(["node", "script", "--intensity", "extreme"]),
    /Unsupported web search intensity/u,
  );
});

test("redaction never writes full API keys into summaries", () => {
  const redacted = __test__.redactScenarioRequest({
    web_search_api_key: "provider-sensitive-value",
    nested: { apiKey: "native-sensitive-value" },
  });

  assert.equal(redacted.web_search_api_key, "***alue");
  assert.equal(redacted.nested.apiKey, "***alue");
  assert.equal(JSON.stringify(redacted).includes("sensitive"), false);
});
