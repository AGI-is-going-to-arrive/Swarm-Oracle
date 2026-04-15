const DEFAULT_BATCH_A_SCENARIO_ID = "sc-e2e-causal-001";
const DEFAULT_BATCH_B_SCENARIO_ID = "sc-e2e-batch-b";
const DEFAULT_BATCH_B_DEBATE_ID = "debate-e2e-batch-b";
const DEFAULT_BATCH_B_BRANCH_A = "branch-a";
const DEFAULT_BATCH_B_BRANCH_B = "branch-b";

function normalizeBaseUrl(baseUrl) {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function dedupeRoutePaths(routePaths) {
  return [...new Set(routePaths)];
}

function buildRouteUrl(baseUrl, routePath) {
  return new URL(routePath, normalizeBaseUrl(baseUrl)).toString();
}

function extractModuleEntryAssetPath(html) {
  const match = html.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/i);
  if (!match?.[1]) {
    throw new Error("Could not locate the main module entry script in preview HTML");
  }
  return match[1];
}

function ensureSpaShellHtml(routePath, response, html) {
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!/html/i.test(contentType)) {
    throw new Error(`Route ${routePath} returned unexpected content-type: ${contentType || "unknown"}`);
  }
  if (!/id=["']root["']/i.test(html)) {
    throw new Error(`Route ${routePath} did not return the SPA shell root container`);
  }
}

export function buildPhase3BatchAPreflightPaths(scenarioId = DEFAULT_BATCH_A_SCENARIO_ID) {
  return [
    "/",
    "/agents/new",
    "/agents",
    `/sim/${scenarioId}/causal-map`,
  ];
}

export function buildPhase3BatchBPreflightPaths({
  scenarioId = DEFAULT_BATCH_B_SCENARIO_ID,
  debateId = DEFAULT_BATCH_B_DEBATE_ID,
  branchA = DEFAULT_BATCH_B_BRANCH_A,
  branchB = DEFAULT_BATCH_B_BRANCH_B,
} = {}) {
  return [
    "/",
    `/debate/${debateId}/result`,
    `/result/${scenarioId}`,
    `/result/${scenarioId}/compare?branch_a=${encodeURIComponent(branchA)}&branch_b=${encodeURIComponent(branchB)}`,
  ];
}

export async function assertFrontendRoutesReady({
  baseUrl,
  routePaths,
  fetchImpl = fetch,
  label = "frontend preview preflight",
} = {}) {
  if (!baseUrl) {
    throw new Error(`[${label}] Missing baseUrl`);
  }
  const uniqueRoutePaths = dedupeRoutePaths(routePaths ?? []);
  if (uniqueRoutePaths.length === 0) {
    throw new Error(`[${label}] No route paths were provided`);
  }

  let expectedEntryAssetPath = null;
  const checkedRoutes = [];

  for (const routePath of uniqueRoutePaths) {
    const routeUrl = buildRouteUrl(baseUrl, routePath);
    const response = await fetchImpl(routeUrl);
    const html = await response.text();

    if (!response.ok) {
      throw new Error(`[${label}] Route ${routePath} returned ${response.status} at ${routeUrl}`);
    }

    ensureSpaShellHtml(routePath, response, html);
    const entryAssetPath = extractModuleEntryAssetPath(html);

    if (expectedEntryAssetPath && entryAssetPath !== expectedEntryAssetPath) {
      throw new Error(
        `[${label}] Entry module mismatch across routes: expected ${expectedEntryAssetPath}, got ${entryAssetPath} for ${routePath}`,
      );
    }
    expectedEntryAssetPath = entryAssetPath;
    checkedRoutes.push({
      path: routePath,
      url: routeUrl,
      entryAssetPath,
      status: response.status,
    });
  }

  const entryAssetUrl = buildRouteUrl(baseUrl, expectedEntryAssetPath);
  const entryAssetResponse = await fetchImpl(entryAssetUrl);
  if (!entryAssetResponse.ok) {
    throw new Error(
      `[${label}] Entry asset ${expectedEntryAssetPath} returned ${entryAssetResponse.status} at ${entryAssetUrl}`,
    );
  }

  return {
    entryAssetPath: expectedEntryAssetPath,
    entryAssetUrl,
    checkedRoutes,
  };
}
