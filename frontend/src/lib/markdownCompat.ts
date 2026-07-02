// Feature-detect regex lookbehind support once at module scope.
// Safari gained lookbehind in 16.4; targets include safari/iOS >= 16.2
// (vite.config.ts legacyTargets), where remark-gfm's autolink transform
// would throw at runtime — SafeMarkdown drops GFM there instead of crashing.
let supportsLookbehind = false;
try {
  new RegExp('(?<=x)y');
  supportsLookbehind = true;
} catch {
  // Unsupported (Safari/iOS < 16.4)
}

// Test-only override; lives outside the component file so the component keeps
// fast-refresh (react-refresh/only-export-components).
let testOverride: boolean | null = null;

export function setSupportsLookbehindForTest(val: boolean | null): void {
  testOverride = val;
}

export function lookbehindSupported(): boolean {
  return testOverride !== null ? testOverride : supportsLookbehind;
}
