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
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[playwright-teardown] ${label}: ${reason}`);
    return false;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function collectChildPids(parentPid, visited = new Set()) {
  if (process.platform === "win32") {
    return [];
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
      process.kill(pid, "SIGKILL");
    } catch {
      // Best effort.
    }
  }
  return childPids.length;
}

export async function closePlaywrightPage(page, label = "page", timeoutMs = 5000) {
  if (!page || page.isClosed?.()) {
    return true;
  }
  return closeWithTimeout(label, () => page.close({ runBeforeUnload: false }), timeoutMs);
}

export async function closePlaywrightContext(context, label = "context", timeoutMs = 8000) {
  if (!context) {
    return true;
  }
  const pages = context.pages?.() ?? [];
  for (let index = 0; index < pages.length; index += 1) {
    await closePlaywrightPage(pages[index], `${label}:page:${index + 1}`, timeoutMs);
  }
  return closeWithTimeout(label, () => context.close(), timeoutMs);
}

export async function closePlaywrightBrowser(browser, label = "browser", timeoutMs = 10000) {
  if (!browser) {
    return true;
  }
  const contexts = browser.contexts?.() ?? [];
  for (let index = 0; index < contexts.length; index += 1) {
    await closePlaywrightContext(contexts[index], `${label}:context:${index + 1}`, timeoutMs);
  }
  const closed = await closeWithTimeout(label, () => browser.close(), timeoutMs);
  if (!closed) {
    const killed = forceKillOwnedChildren();
    if (killed > 0) {
      console.warn(`[playwright-teardown] force-killed ${killed} child process(es) after ${label} timeout`);
    }
  }
  return closed;
}
