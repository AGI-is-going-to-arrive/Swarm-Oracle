const DEFAULT_BATCH_A_SCENARIO_ID = "sc-e2e-causal-001";
const DEFAULT_BATCH_B_SCENARIO_ID = "sc-e2e-batch-b";
const DEFAULT_BATCH_B_DEBATE_ID = "debate-e2e-batch-b";
const DEFAULT_BATCH_B_BRANCH_A = "branch-a";
const DEFAULT_BATCH_B_BRANCH_B = "branch-b";
const SCRIPT_CONTENT_TYPE_PATTERN = /javascript|ecmascript/i;
const CSS_CONTENT_TYPE_PATTERN = /text\/css/i;

function normalizeBaseUrl(baseUrl) {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function dedupeRoutePaths(routePaths) {
  return [...new Set(routePaths)];
}

function buildRouteUrl(baseUrl, routePath) {
  return new URL(routePath, normalizeBaseUrl(baseUrl)).toString();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLocalAssetReference(baseUrl, assetPath) {
  const assetUrl = new URL(assetPath, normalizeBaseUrl(baseUrl));
  const normalizedBaseUrl = new URL(normalizeBaseUrl(baseUrl));
  return assetUrl.origin === normalizedBaseUrl.origin;
}

function extractModuleEntryAssetPath(html) {
  const match = html.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/i);
  if (!match?.[1]) {
    throw new Error("Could not locate the main module entry script in preview HTML");
  }
  return match[1];
}

function extractLocalCssEntryAssetPaths(baseUrl, html) {
  const matches = [...html.matchAll(
    /<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\bhref=["']([^"']+)["'])[^>]*>/gi,
  )];
  const localAssetPaths = dedupeRoutePaths(
    matches
      .map((match) => match[1])
      .filter((assetPath) => isLocalAssetReference(baseUrl, assetPath)),
  );
  if (localAssetPaths.length === 0) {
    throw new Error("Could not locate a local CSS entry stylesheet in preview HTML");
  }
  return localAssetPaths;
}

function extractInlineNomoduleFallback(html) {
  const matches = [...html.matchAll(
    /<script\b(?=[^>]*\bnomodule\b)(?![^>]*\bsrc=)(?![^>]*\bdata-src=)[^>]*>([\s\S]*?)<\/script>/gi,
  )];
  const inlineNomoduleScript = matches.find((match) => match[1]?.trim());
  if (!inlineNomoduleScript) {
    throw new Error("Could not locate the legacy nomodule fallback script in preview HTML");
  }
  return inlineNomoduleScript[1].trim();
}

function extractLegacyAssetPath(html, { id, attribute, label }) {
  const viteMatch = html.match(
    new RegExp(
      `<script\\b(?=[^>]*\\bnomodule\\b)(?=[^>]*\\bid=["']${escapeRegExp(id)}["'])(?=[^>]*\\b${attribute}=["']([^"']+)["'])[^>]*>`,
      "i",
    ),
  );
  if (viteMatch?.[1]) {
    return viteMatch[1];
  }

  const genericMatch = html.match(
    new RegExp(
      `<script\\b(?=[^>]*\\bnomodule\\b)(?=[^>]*\\b${attribute}=["']([^"']+)["'])[^>]*>`,
      "i",
    ),
  );
  if (!genericMatch?.[1]) {
    throw new Error(`Could not locate the legacy ${label} script in preview HTML`);
  }
  return genericMatch[1];
}

function normalizeResolvedAssetUrls(baseUrl, assetPaths) {
  return dedupeRoutePaths(assetPaths.map((assetPath) => buildRouteUrl(baseUrl, assetPath))).sort();
}

async function assertReachableAsset({
  label,
  assetDescription,
  assetPath,
  assetUrl,
  fetchImpl,
  contentTypePattern,
}) {
  const response = await fetchImpl(assetUrl);
  if (!response.ok) {
    throw new Error(
      `[${label}] ${assetDescription} ${assetPath} returned ${response.status} at ${assetUrl}`,
    );
  }

  const contentType = response.headers?.get?.("content-type") ?? "";
  if (contentTypePattern && contentType && !contentTypePattern.test(contentType)) {
    throw new Error(
      `[${label}] ${assetDescription} ${assetPath} returned unexpected content-type: ${contentType}`,
    );
  }
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
  const cssEntryAssetPathSet = new Set();
  let expectedLegacyPolyfillAssetPath = null;
  let expectedLegacyEntryAssetPath = null;
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
    const cssEntryAssetPaths = extractLocalCssEntryAssetPaths(baseUrl, html);
    extractInlineNomoduleFallback(html);
    const legacyPolyfillAssetPath = extractLegacyAssetPath(html, {
      id: "vite-legacy-polyfill",
      attribute: "src",
      label: "polyfill",
    });
    const legacyEntryAssetPath = extractLegacyAssetPath(html, {
      id: "vite-legacy-entry",
      attribute: "data-src",
      label: "entry",
    });

    if (expectedEntryAssetPath && entryAssetPath !== expectedEntryAssetPath) {
      throw new Error(
        `[${label}] Entry module mismatch across routes: expected ${expectedEntryAssetPath}, got ${entryAssetPath} for ${routePath}`,
      );
    }
    if (expectedLegacyPolyfillAssetPath && legacyPolyfillAssetPath !== expectedLegacyPolyfillAssetPath) {
      throw new Error(
        `[${label}] Legacy polyfill mismatch across routes: expected ${expectedLegacyPolyfillAssetPath}, got ${legacyPolyfillAssetPath} for ${routePath}`,
      );
    }
    if (expectedLegacyEntryAssetPath && legacyEntryAssetPath !== expectedLegacyEntryAssetPath) {
      throw new Error(
        `[${label}] Legacy entry mismatch across routes: expected ${expectedLegacyEntryAssetPath}, got ${legacyEntryAssetPath} for ${routePath}`,
      );
    }

    expectedEntryAssetPath = entryAssetPath;
    expectedLegacyPolyfillAssetPath = legacyPolyfillAssetPath;
    expectedLegacyEntryAssetPath = legacyEntryAssetPath;
    for (const cssEntryAssetPath of cssEntryAssetPaths) {
      cssEntryAssetPathSet.add(cssEntryAssetPath);
    }
    checkedRoutes.push({
      path: routePath,
      url: routeUrl,
      entryAssetPath,
      cssEntryAssetPaths,
      legacyPolyfillAssetPath,
      legacyEntryAssetPath,
      status: response.status,
    });
  }

  const entryAssetUrl = buildRouteUrl(baseUrl, expectedEntryAssetPath);
  await assertReachableAsset({
    label,
    assetDescription: "Entry asset",
    assetPath: expectedEntryAssetPath,
    assetUrl: entryAssetUrl,
    fetchImpl,
    contentTypePattern: SCRIPT_CONTENT_TYPE_PATTERN,
  });

  const cssEntryAssetPaths = Array.from(cssEntryAssetPathSet);
  const cssEntryAssetUrls = normalizeResolvedAssetUrls(baseUrl, cssEntryAssetPaths);
  for (const cssEntryAssetUrl of cssEntryAssetUrls) {
    const cssEntryAssetPath = new URL(cssEntryAssetUrl).pathname;
    await assertReachableAsset({
      label,
      assetDescription: "CSS entry asset",
      assetPath: cssEntryAssetPath,
      assetUrl: cssEntryAssetUrl,
      fetchImpl,
      contentTypePattern: CSS_CONTENT_TYPE_PATTERN,
    });
  }

  const legacyPolyfillAssetUrl = buildRouteUrl(baseUrl, expectedLegacyPolyfillAssetPath);
  await assertReachableAsset({
    label,
    assetDescription: "Legacy polyfill asset",
    assetPath: expectedLegacyPolyfillAssetPath,
    assetUrl: legacyPolyfillAssetUrl,
    fetchImpl,
    contentTypePattern: SCRIPT_CONTENT_TYPE_PATTERN,
  });

  const legacyEntryAssetUrl = buildRouteUrl(baseUrl, expectedLegacyEntryAssetPath);
  await assertReachableAsset({
    label,
    assetDescription: "Legacy entry asset",
    assetPath: expectedLegacyEntryAssetPath,
    assetUrl: legacyEntryAssetUrl,
    fetchImpl,
    contentTypePattern: SCRIPT_CONTENT_TYPE_PATTERN,
  });

  return {
    entryAssetPath: expectedEntryAssetPath,
    entryAssetUrl,
    cssEntryAssetPaths,
    cssEntryAssetUrls,
    legacyPolyfillAssetPath: expectedLegacyPolyfillAssetPath,
    legacyPolyfillAssetUrl,
    legacyEntryAssetPath: expectedLegacyEntryAssetPath,
    legacyEntryAssetUrl,
    checkedRoutes,
  };
}
