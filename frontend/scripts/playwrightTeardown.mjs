import { execFileSync } from "node:child_process";
import process from "node:process";

function timeoutMessage(label, timeoutMs) {
  return `${label} did not close within ${timeoutMs}ms`;
}

async function closeWithTimeout(label, callback, timeoutMs = 8000) {
  let timer = null;
  try {
    await Promise.race([
      Promise.resolve().then(callback),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage(label, timeoutMs))), timeoutMs);
      }),
    ]);
    return null;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    console.warn(`[playwright-teardown] ${label}: ${failure.message}`);
    return failure;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function appendFailures(target, failure) {
  if (failure instanceof AggregateError) {
    for (const nestedFailure of failure.errors) {
      appendFailures(target, nestedFailure);
    }
    return;
  }
  target.push(failure instanceof Error ? failure : new Error(String(failure)));
}

function parseProcessTable(output) {
  return String(output ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .filter((parts) => parts.length >= 2)
    .map(([pid, parentPid]) => ({
      pid: Number.parseInt(pid, 10),
      parentPid: Number.parseInt(parentPid, 10),
    }))
    .filter(({ pid, parentPid }) => Number.isFinite(pid) && Number.isFinite(parentPid));
}

function collectDescendantPids(parentPid, rows, visited = new Set()) {
  const directChildren = rows
    .filter((row) => row.parentPid === parentPid && !visited.has(row.pid))
    .map((row) => row.pid);
  for (const childPid of directChildren) {
    visited.add(childPid);
  }
  return directChildren.flatMap((childPid) => [
    childPid,
    ...collectDescendantPids(childPid, rows, visited),
  ]);
}

function collectChildPids(parentPid, visited = new Set()) {
  if (process.platform === "win32") {
    try {
      const output = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      return collectDescendantPids(parentPid, parseProcessTable(output), visited);
    } catch {
      return [];
    }
  }
  let output = "";
  try {
    output = execFileSync("pgrep", ["-P", String(parentPid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  const directChildren = output
    .split(/\s+/u)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value) && !visited.has(value));
  for (const childPid of directChildren) {
    visited.add(childPid);
  }
  return directChildren.flatMap((childPid) => [
    childPid,
    ...collectChildPids(childPid, visited),
  ]);
}

function forceKillOwnedChildren() {
  const childPids = collectChildPids(process.pid);
  for (const pid of childPids.reverse()) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch {
      // Best effort.
    }
  }
  return childPids.length;
}

export async function closePlaywrightPage(page, label = "page", timeoutMs = 5000) {
  if (!page || page.isClosed?.()) {
    return;
  }
  const failure = await closeWithTimeout(
    label,
    () => page.close({ runBeforeUnload: false }),
    timeoutMs,
  );
  if (failure) {
    throw new AggregateError([failure], `${label} teardown failed`);
  }
}

export async function closePlaywrightContext(context, label = "context", timeoutMs = 8000) {
  if (!context) {
    return;
  }
  const failures = [];
  const pages = context.pages?.() ?? [];
  for (let index = 0; index < pages.length; index += 1) {
    try {
      await closePlaywrightPage(pages[index], `${label}:page:${index + 1}`, timeoutMs);
    } catch (error) {
      appendFailures(failures, error);
    }
  }
  const contextFailure = await closeWithTimeout(label, () => context.close(), timeoutMs);
  if (contextFailure) {
    failures.push(contextFailure);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${label} teardown failed`);
  }
}

export async function closePlaywrightBrowser(browser, label = "browser", timeoutMs = 10000) {
  if (!browser) {
    return;
  }
  const failures = [];
  const contexts = browser.contexts?.() ?? [];
  for (let index = 0; index < contexts.length; index += 1) {
    try {
      await closePlaywrightContext(contexts[index], `${label}:context:${index + 1}`, timeoutMs);
    } catch (error) {
      appendFailures(failures, error);
    }
  }
  const browserFailure = await closeWithTimeout(label, () => browser.close(), timeoutMs);
  if (browserFailure) {
    failures.push(browserFailure);
    const killed = forceKillOwnedChildren();
    if (killed > 0) {
      console.warn(`[playwright-teardown] force-killed ${killed} child process(es) after ${label} close failure`);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${label} teardown failed`);
  }
}

export async function closePlaywrightBrowsers(browsers, label = "browsers", timeoutMs = 10000) {
  const failures = [];
  const ownedBrowsers = [...new Set((browsers ?? []).filter(Boolean))];
  for (let index = 0; index < ownedBrowsers.length; index += 1) {
    try {
      await closePlaywrightBrowser(
        ownedBrowsers[index],
        `${label}:browser:${index + 1}`,
        timeoutMs,
      );
    } catch (error) {
      appendFailures(failures, error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${label} teardown failed`);
  }
}

export const __test__ = {
  collectDescendantPids,
  parseProcessTable,
};
