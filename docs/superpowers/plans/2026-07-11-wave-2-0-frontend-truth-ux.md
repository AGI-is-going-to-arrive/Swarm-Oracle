# Wave 2.0 Frontend Truth UX Implementation Plan / Wave 2.0 前端真实状态体验实施计划

> **历史计划记录 / Historical plan record — 2026-07-11**
>
> 本文保留 2026-07-11 的设计与任务语境。任务、命令、行号和预期结果均属历史记录，不是当前操作指引；复选框和批准状态不代表当前实施或验证结果。代码示例及其中的注释、字符串保留原文，中英文共用。
>
> This document preserves the design and task context of 2026-07-11. Tasks, commands, line numbers, and expected results are historical records, not current operating instructions. Checkboxes and approval status do not establish current implementation or verification results. Both languages share the original code examples, including their comments and strings.
>
> 当前指南 / Current guides: [README](../../../README.md) · [使用指南 / Usage](../../USAGE.md) · [配置指南 / Configuration](../../CONFIGURATION.md).

![The flow for reading, asking about, and changing results](../../illustrations/read-ask-change.en.webp)

*Conceptual illustration: The flow for reading, asking about, and changing results; it is not evidence that historical tasks were completed.*

<details>
<summary>中文图解</summary>

![阅读、追问与修改结果的使用流程](../../illustrations/read-ask-change.zh.webp)

*概念配图：阅读、追问与修改结果的使用流程，不作为历史任务完成证据。*

</details>

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **面向自动化执行者（原计划要求）：** 必须使用子技能 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，逐项实施本计划。步骤使用复选框（`- [ ]`）语法跟踪。

**目标 / Goal:** 修复报告生命周期与概率表述、Agent 观察坐标、首次连接验证、主题包完整导入和 390 px 结果页溢出，使前端只展示有后端真值或明确用户确认支撑的状态。

**Goal:** Fix report lifecycle and probability wording, Agent observation coordinates, first connection verification, complete local-pack import, and result-page overflow at 390 px. The frontend must display only states supported by backend facts or explicit user acknowledgement.

**架构 / Architecture:** 报告 SSE 先进入独立、可测试的协议解析器，再由 `ResultReportPanel` 将事件和持久化 `/story` 状态合流；`partial` 只表示进行中，只有 `complete/failed/cancelled/skipped` 才终止监听。Agent 观察与主题包映射均下沉为纯函数，页面只负责选择当前分支并提交有界数据；不新增数据库表、不引入特权 prompt，也不改变 localhost LLM 支持。

**Architecture:** Send report SSE through an independent, testable protocol parser, then merge events with persisted `/story` state in `ResultReportPanel`. `partial` means work is in progress; only `complete/failed/cancelled/skipped` ends listening. Move Agent observation and pack mapping into pure functions; pages select the current branch and submit bounded data. Add no database tables or privileged prompts, and preserve localhost LLM support.

**技术栈 / Tech Stack:** React 19、TypeScript 5.9、Vitest、Testing Library、i18next、原生 Fetch/ReadableStream、现有 REST/SSE client。

**Tech Stack:** React 19, TypeScript 5.9, Vitest, Testing Library, i18next, native Fetch/ReadableStream, and the existing REST/SSE client.

---

## 前置合同与文件地图 / Prerequisite contracts and file map

本计划在后端报告合同修复落地后执行。前端依赖以下字段：

Execute this plan after the backend report contract fixes land. The frontend depends on these fields:

- `full_report.status`: `generating | partial | complete | failed | cancelled | skipped`；前两者非终态。

  `full_report.status`: `generating | partial | complete | failed | cancelled | skipped`; the first two are non-terminal.
- `report_complete.data.status`: 只能携带终态。

  `report_complete.data.status`: terminal states only.
- 章节及 `report_section_complete.data`: 可携带 `tier` 与 `failure_reason`。

  Sections and `report_section_complete.data` may include `tier` and `failure_reason`.
- 历史 `interview_evidence` 仍是既有转录摘录，不代表新采访。

  Historical `interview_evidence` remains an excerpt of an existing transcript, not a new interview.

新增文件：

New files:

- `frontend/src/lib/resultReportSse.ts`：SSE 解帧与显式终态检查。

  `frontend/src/lib/resultReportSse.ts`: SSE framing and explicit terminal-state checks.
- `frontend/src/lib/resultReportSse.test.ts`：多行 `data:`、断流、章节失败、终态测试。

  `frontend/src/lib/resultReportSse.test.ts`: tests for multiline `data:`, interrupted streams, section failures, and terminal states.
- `frontend/src/lib/agentProfileObservation.ts` 与 `.test.ts`：Simulation/Result 共用的分支观察选择。

  `frontend/src/lib/agentProfileObservation.ts` and `.test.ts`: branch observation selection shared by Simulation and Result.
- `frontend/src/lib/localPackImport.ts` 与 `.test.ts`：主题包到有界 `WorldContext`/`agentsPreview` 的纯映射。

  `frontend/src/lib/localPackImport.ts` and `.test.ts`: pure mapping from local packs to bounded `WorldContext`/`agentsPreview`.
- `frontend/src/components/CounterfactualPanel.test.tsx`：390 px 控件宽度回归。

  `frontend/src/components/CounterfactualPanel.test.tsx`: control-width regression at 390 px.

修改文件集中在报告组件、Setup、LocalPack、InputView、Result/Simulation 页面、类型和中英 locale。`gallery.html`、`frontend/src/gallery/`、样例 snapshot 清单与社区 Gallery 路由明确留到 W2.2，本计划不修改。

Changes focus on report components, Setup, LocalPack, InputView, Result/Simulation pages, types, and English/Chinese locales. `gallery.html`, `frontend/src/gallery/`, sample snapshot manifests, and community Gallery routing remain explicitly deferred to W2.2 and are not changed by this plan.

### Task 1: 冻结报告前端类型并建立 fail-closed SSE 解析器 / Task 1: Freeze frontend report types and build an SSE parser that fails closed

**Files / 文件:**

- Create / 创建: `frontend/src/lib/resultReportSse.ts`
- Create / 创建: `frontend/src/lib/resultReportSse.test.ts`
- Modify / 修改: `frontend/src/types.ts:647-819`

- [ ] **Step 1: 写失败测试，覆盖合法多行事件、无空格 `data:`、章节失败和无终态 EOF / Step 1: Write failing tests for valid multiline events, no-space `data:`, section failure, and EOF without a terminal event**

```ts
function responseFrom(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    },
  }));
}

it('accepts data: without a space and joins multiline data', async () => {
  const seen: string[] = [];
  const terminal = await consumeResultReportStream(responseFrom([
    'event: report_section_complete\n',
    'data:{"status":"complete","section_id":"timeline",\n',
    'data:"tier":"rewrite","failure_reason":null,"tool_trace":[]}\n\n',
    'event: report_complete\ndata:{"status":"complete","tool_trace":[]}\n\n',
  ]), new AbortController().signal, (event) => seen.push(event.event));
  expect(seen).toEqual(['report_section_complete', 'report_complete']);
  expect(terminal.data.status).toBe('complete');
});

it('does not treat a section failure as whole-report termination', async () => {
  const seen: string[] = [];
  await consumeResultReportStream(responseFrom([
    'event: report_failed\ndata:{"status":"failed","section_id":"factions","error_code":"SECTION_FAILED","tool_trace":[]}\n\n',
    'event: report_section_complete\ndata:{"status":"complete","section_id":"timeline","tool_trace":[]}\n\n',
    'event: report_complete\ndata:{"status":"complete","tool_trace":[]}\n\n',
  ]), new AbortController().signal, (event) => seen.push(event.event));
  expect(seen).toEqual(['report_failed', 'report_section_complete', 'report_complete']);
});

it('rejects EOF before report_complete', async () => {
  await expect(consumeResultReportStream(responseFrom([
    'event: report_started\ndata:{"status":"generating","tool_trace":[]}\n\n',
  ]), new AbortController().signal, () => undefined)).rejects.toMatchObject({
    name: 'ReportStreamInterruptedError',
  });
});
```

- [ ] **Step 2: 运行 RED 测试 / Step 2: Run RED tests**

Run / 运行: `cd frontend && npm test -- --run src/lib/resultReportSse.test.ts`

Expected: FAIL，模块 `./resultReportSse` 尚不存在。

Expected: FAIL because the `./resultReportSse` module does not yet exist.

- [ ] **Step 3: 扩展类型并实现解析器 / Step 3: Extend types and implement the parser**

在 `types.ts` 增加 `ReportStatus`、`ReportTier`、`ReportSectionFailureReason`；让 `FullReport.status` 包含 `cancelled`，让 `ReportSection` 增加可选 `tier/failure_reason`，让 SSE data 增加可选 `tier/failure_reason`。解析器必须：合并多行 data、接受 `data:` 与 `data: `、忽略注释、JSON 错误 fail-closed、abort 时取消 reader、只接受 `report_complete + complete/failed/cancelled/skipped` 为终态。

Add `ReportStatus`, `ReportTier`, and `ReportSectionFailureReason` in `types.ts`. Include `cancelled` in `FullReport.status`; add optional `tier/failure_reason` to `ReportSection` and SSE data. The parser must join multiline data, accept both `data:` and `data: `, ignore comments, fail closed on JSON errors, cancel the reader on abort, and accept only `report_complete + complete/failed/cancelled/skipped` as terminal.

```ts
export const REPORT_TERMINAL_STATUSES = new Set(['complete', 'failed', 'cancelled', 'skipped']);

export class ReportStreamInterruptedError extends Error {
  override name = 'ReportStreamInterruptedError';
}

export async function consumeResultReportStream(
  response: Response,
  signal: AbortSignal,
  onEvent: (event: ResultReportSSEEvent) => void,
): Promise<ResultReportSSEEvent> {
  const reader = response.body?.getReader();
  if (!reader) throw new ReportStreamInterruptedError('Report stream has no body');
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal: ResultReportSSEEvent | null = null;

  const consumeFrame = (frame: string) => {
    let eventName = '';
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator < 0 ? line : line.slice(0, separator);
      const raw = separator < 0 ? '' : line.slice(separator + 1);
      const value = raw.startsWith(' ') ? raw.slice(1) : raw;
      if (field === 'event') eventName = value;
      if (field === 'data') dataLines.push(value);
    }
    if (!eventName || dataLines.length === 0) return;
    const data = JSON.parse(dataLines.join('\n')) as ResultReportSSEEvent['data'];
    const event = { event: eventName, data: { ...data, tool_trace: data.tool_trace ?? [] } };
    onEvent(event);
    if (event.event === 'report_complete' && REPORT_TERMINAL_STATUSES.has(event.data.status)) {
      terminal = event;
    }
  };

  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      frames.forEach(consumeFrame);
      if (done) break;
    }
    if (signal.aborted) throw new DOMException('Report generation aborted', 'AbortError');
    if (buffer.trim()) consumeFrame(buffer);
    if (!terminal) throw new ReportStreamInterruptedError('Report stream ended before a terminal event');
    return terminal;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
```

- [ ] **Step 4: 运行 GREEN 测试和类型门禁 / Step 4: Run GREEN tests and the type gate**

Run / 运行: `cd frontend && npm test -- --run src/lib/resultReportSse.test.ts && npx tsc -b`

Expected: PASS；TypeScript 无错误。

Expected: PASS with no TypeScript errors.

- [ ] **Step 5: 提交协议边界 / Step 5: Commit the protocol boundary**

```bash
git add frontend/src/types.ts frontend/src/lib/resultReportSse.ts frontend/src/lib/resultReportSse.test.ts
git commit -m "fix(frontend): fail closed on interrupted report streams"
```

### Task 2: 修复 partial 轮询并展示章节、工具与降级进度 / Task 2: Fix partial polling and show section, tool, and fallback progress

**Files / 文件:**

- Modify / 修改: `frontend/src/pages/result/ResultReportPanel.tsx:153-985`
- Modify / 修改: `frontend/src/pages/result/ResultReportPanel.test.tsx`
- Modify / 修改: `frontend/src/pages/result/ReportSection.tsx:42-89`
- Modify / 修改: `frontend/src/pages/result/ReportSection.test.tsx`
- Modify / 修改: `frontend/src/pages/ResultReportView.css:652-737`

- [ ] **Step 1: 写失败测试 / Step 1: Write failing tests**

增加四个回归：`partial` 拉取后继续每 15 秒轮询直至 `complete`；流 EOF 不触发成功刷新而显示“连接中断、继续核对持久化状态”；`report_section_complete` 展示章节、tool trace、tier；章节 `static + timeout` 显示本地化 fallback reason。使用 fake timers，并在每次推进后 `await vi.runOnlyPendingTimersAsync()`。

Add four regressions: after fetching `partial`, keep polling every 15 seconds until `complete`; EOF must show “Connection interrupted; continuing to check persisted state” without a success refresh; `report_section_complete` shows section, tool trace, and tier; a `static + timeout` section shows a localized fallback reason. Use fake timers and `await vi.runOnlyPendingTimersAsync()` after each advance.

```ts
expect(getStoryMock).toHaveBeenCalledTimes(2);
expect(screen.getByText(/1.*6.*sections/i)).toBeInTheDocument();
expect(screen.getByText(/rewrite/i)).toBeInTheDocument();
expect(screen.getByText(/stream interrupted/i)).toBeInTheDocument();
expect(onRefresh).not.toHaveBeenCalled();
```

- [ ] **Step 2: 运行 RED 测试 / Step 2: Run RED tests**

Run / 运行: `cd frontend && npm test -- --run src/pages/result/ResultReportPanel.test.tsx src/pages/result/ReportSection.test.tsx`

Expected: FAIL；现有代码把首个 `partial` 当终态，且忽略 SSE event/tier/failure reason。

Expected: FAIL because the existing code treats the first `partial` as terminal and ignores the SSE event, tier, and failure reason.

- [ ] **Step 3: 将持久化状态与 stream 进度合流 / Step 3: Merge persisted state with stream progress**

用 `consumeResultReportStream` 替换 `drainReportStreamAndDetectAlreadyRunning`。定义 `isReportInProgress(status) => status === 'generating' || status === 'partial'`；轮询每次都更新 `localStoryData`，仅在终态停止。章节级 `report_failed` 记录失败章节但不停止整份报告；断流设置 `streamInterrupted=true` 并保持轮询，不调用 `onRefresh`；只有终态 `report_complete` 或轮询读到终态才刷新。

Replace `drainReportStreamAndDetectAlreadyRunning` with `consumeResultReportStream`. Define `isReportInProgress(status) => status === 'generating' || status === 'partial'`. Update `localStoryData` on every poll and stop only at a terminal state. Section-level `report_failed` records the failed section without stopping the whole report. A disconnected stream sets `streamInterrupted=true`, keeps polling, and does not call `onRefresh`. Refresh only after a terminal `report_complete` or a terminal persisted state.

```ts
function isReportInProgress(status: FullReport['status'] | undefined): boolean {
  return status === 'generating' || status === 'partial';
}

const persistedInProgress = report ? isReportInProgress(report.status) : false;
const isGenerating = localGenerating || persistedInProgress;

if (newReport && isReportInProgress(newReport.status)) {
  setLocalStoryData(updatedStory);
  timerId = window.setTimeout(poll, 15_000);
} else if (newReport) {
  setLocalStoryData(updatedStory);
  setLocalGenerating(false);
  setStreamInterrupted(false);
  onRefresh?.();
} else {
  timerId = window.setTimeout(poll, 15_000);
}
```

`partial + sections` 必须继续渲染已完成章节，并在顶部展示进行中控制台；不得再显示“生成失败/重试”。控制台至少显示完成章节数、当前章节、章节错误、tool trace、stream 中断状态。`ReportSection` 对 `generation/rewrite/static` 显示来源 chip；`failure_reason` 只显示白名单 locale 映射，未知值统一为“其他降级原因”，不泄露原始 provider 文本。

`partial + sections` must keep rendering completed sections and show a progress console at the top, without “Generation failed / Retry.” The console shows at least completed-section count, current section, section errors, tool trace, and stream interruption. `ReportSection` shows a source chip for `generation/rewrite/static`. Map `failure_reason` only through an allowed locale list; unknown values become “Other fallback reason” without exposing raw provider text.

- [ ] **Step 4: 把“采访”准确改为历史转录摘录 / Step 4: Relabel interviews accurately as historical transcript excerpts**

保持 branch/round 坐标和 AI 角色免责声明，将标题、状态文案、badge 统一成“Historical simulation transcript excerpts / 历史推演转录摘录”。不得引入“new interview”“real interview”或暗示本轮额外调用 LLM 的文案。

Keep branch/round coordinates and the AI-role disclaimer. Use “Historical simulation transcript excerpts / 历史推演转录摘录” consistently for titles, status text, and badges. Do not introduce “new interview,” “real interview,” or wording that implies an additional LLM call in this run.

- [ ] **Step 5: 运行 GREEN 测试 / Step 5: Run GREEN tests**

Run / 运行: `cd frontend && npm test -- --run src/lib/resultReportSse.test.ts src/pages/result/ResultReportPanel.test.tsx src/pages/result/ReportSection.test.tsx`

Expected: PASS；断流测试中 `onRefresh` 保持 0 次，partial 测试最终只在 complete 时停止。

Expected: PASS. The interrupted-stream test keeps `onRefresh` at 0 calls, and partial polling stops only at complete.

- [ ] **Step 6: 提交报告生命周期 UI / Step 6: Commit the report lifecycle UI**

```bash
git add frontend/src/pages/result/ResultReportPanel.tsx frontend/src/pages/result/ResultReportPanel.test.tsx frontend/src/pages/result/ReportSection.tsx frontend/src/pages/result/ReportSection.test.tsx frontend/src/pages/ResultReportView.css
git commit -m "fix(frontend): show truthful report generation progress"
```

### Task 3: 隐藏单路径伪概率，并把多分支数字标成模拟分布 / Task 3: Hide unsupported single-path probabilities and label multiple branches as a simulated distribution

**Files / 文件:**

- Modify / 修改: `frontend/src/pages/result/ReportConfidenceBadge.tsx:83-278`
- Modify / 修改: `frontend/src/pages/result/ReportConfidenceBadge.test.tsx`

- [ ] **Step 1: 写失败测试 / Step 1: Write failing tests**

```ts
it('hides probability, WEP and interval for a single simulated path', () => {
  const { container } = render(<ReportConfidenceBadge verdict={makeVerdict({
    likelihood: { probability: 1, interval: [0.95, 1], wep: 'almost_certain' },
    analytic_confidence: { level: 'high', basis: 'branch_count=1; evidence_count=5; agent_consensus=1.0000' },
  })} />);
  expect(container.querySelector('.report-hero__pct')).toBeNull();
  expect(screen.queryByText(/100\.0/)).toBeNull();
  expect(screen.getByText('[L10N single-path-no-distribution]')).toBeInTheDocument();
});

it('labels multi-branch weights as a simulated distribution', () => {
  render(<ReportConfidenceBadge verdict={makeVerdict({
    analytic_confidence: { level: 'medium', basis: 'branch_count=3; evidence_count=5; agent_consensus=0.5000' },
  })} />);
  expect(screen.getByText('[L10N simulated branch share]')).toBeInTheDocument();
  expect(screen.queryByText('[L10N likelihood]')).toBeNull();
});
```

- [ ] **Step 2: 运行 RED 测试 / Step 2: Run RED tests**

Run / 运行: `cd frontend && npm test -- --run src/pages/result/ReportConfidenceBadge.test.tsx`

Expected: FAIL；单分支仍显示 `100.0%` 与区间，多分支仍写 Estimated Likelihood。

Expected: FAIL because a single branch still shows `100.0%` and an interval, while multiple branches still say Estimated Likelihood.

- [ ] **Step 3: 实现 truth mode / Step 3: Implement truth mode**

复用已解析的 `branchCountNum`：`===1` 时不渲染 pct、WEP、interval，只显示“单条模拟路径，无法形成分支分布”；`>1` 时数字标题为“主导模拟分支占比”，区间标题为“模拟分布范围”；未知 branch count 采用“模拟结果权重”而非现实概率。分析置信度继续独立显示，但 disclaimer 明确数字不代表现实发生率。

Reuse the parsed `branchCountNum`. For `===1`, render no pct, WEP, or interval; show only “A single simulated path cannot form a branch distribution.” For `>1`, label the number “Dominant simulated branch share” and the interval “Simulated distribution range.” For unknown branch count, use “Simulation result weight,” not a real-world probability. Keep analytic confidence separate and state clearly that these numbers are not real-world occurrence rates.

- [ ] **Step 4: 运行 GREEN 测试并提交 / Step 4: Run GREEN tests and commit**

Run / 运行: `cd frontend && npm test -- --run src/pages/result/ReportConfidenceBadge.test.tsx && npx tsc -b`

Expected: PASS。

Expected: PASS.

```bash
git add frontend/src/pages/result/ReportConfidenceBadge.tsx frontend/src/pages/result/ReportConfidenceBadge.test.tsx
git commit -m "fix(frontend): label report weights as simulation output"
```

### Task 4: 共享 Agent observation helper，并把 Result 档案绑定到真实分支/轮次 / Task 4: Share the Agent observation helper and bind Result profiles to actual branches and rounds

**Files / 文件:**

- Create / 创建: `frontend/src/lib/agentProfileObservation.ts`
- Create / 创建: `frontend/src/lib/agentProfileObservation.test.ts`
- Modify / 修改: `frontend/src/pages/SimulationView.tsx:131-250,658-667`
- Modify / 修改: `frontend/src/pages/SimulationView.test.tsx`
- Modify / 修改: `frontend/src/pages/ResultView.tsx:1149-1176,2141-2151`
- Modify / 修改: `frontend/src/pages/ResultView.test.tsx`
- Modify / 修改: `frontend/src/components/result/AgentProfileSheet.tsx:36-45,168-209`
- Modify / 修改: `frontend/src/components/result/AgentProfileSheet.test.tsx`

- [ ] **Step 1: 写纯函数 RED 测试 / Step 1: Write RED tests for the pure function**

覆盖：目标分支的最新消息胜过其他分支更晚的消息；同轮使用最后一条；结果分支无匹配消息时返回 `baseline`；Replay 无匹配仍返回 `replay_unavailable`。

Cover these cases: the latest message in the target branch takes precedence over a later message elsewhere; use the last message within the same round; return `baseline` when the result branch has no matching message; Replay still returns `replay_unavailable` when nothing matches.

```ts
const observation = buildAgentProfileObservation({
  agent, messages, branches,
  selection: { kind: 'result', branchId: 'branch-b', round: null },
});
expect(observation).toMatchObject({
  source: 'result', branchId: 'branch-b', branchTitle: 'Branch B', round: 2, emotion: 'concerned',
});
```

- [ ] **Step 2: 运行 RED 测试 / Step 2: Run RED tests**

Run / 运行: `cd frontend && npm test -- --run src/lib/agentProfileObservation.test.ts`

Expected: FAIL，helper 尚不存在。

Expected: FAIL because the helper does not yet exist.

- [ ] **Step 3: 移出 Simulation 私有实现并接入 Result / Step 3: Extract the private Simulation implementation and connect Result**

helper 接受 `selection.kind: live | replay | result`，使用现有 `filterReplayMessages` 处理分支祖先与 round 上限；Result 传 `analysisBranch.id` 和 `round: null`，再将返回值传入 `AgentProfileSheet.observation`。`AgentProfileObservation.source` 增加 `result`，档案文案显示“结果分支 X 的最新观测 · Rn”；没有证据时明确显示 configured baseline，不回退为无坐标 snapshot。

The helper accepts `selection.kind: live | replay | result` and uses existing `filterReplayMessages` behavior for branch ancestry and the round ceiling. Result passes `analysisBranch.id` and `round: null`, then supplies the returned value to `AgentProfileSheet.observation`. Add `result` to `AgentProfileObservation.source`; display “Latest observation in result branch X · Rn.” When evidence is missing, explicitly show the configured baseline, without falling back to a snapshot lacking coordinates.

- [ ] **Step 4: 增加页面集成回归 / Step 4: Add page integration regressions**

`SimulationView.test.tsx` 保证原 live/replay 行为不变；`ResultView.test.tsx` 构造两个分支和交错消息，展开 Agent 档案后断言展示目标 analysis branch、round 和 emotion，而非 Agent 初始 snapshot。

`SimulationView.test.tsx` preserves existing live/replay behavior. In `ResultView.test.tsx`, create two branches with interleaved messages, open the Agent profile, and assert that it shows the target analysis branch, round, and emotion rather than the initial Agent snapshot.

- [ ] **Step 5: 运行 GREEN 测试并提交 / Step 5: Run GREEN tests and commit**

Run / 运行: `cd frontend && npm test -- --run src/lib/agentProfileObservation.test.ts src/pages/SimulationView.test.tsx src/pages/ResultView.test.tsx src/components/result/AgentProfileSheet.test.tsx`

Expected: PASS。

Expected: PASS.

```bash
git add frontend/src/lib/agentProfileObservation.ts frontend/src/lib/agentProfileObservation.test.ts frontend/src/pages/SimulationView.tsx frontend/src/pages/SimulationView.test.tsx frontend/src/pages/ResultView.tsx frontend/src/pages/ResultView.test.tsx frontend/src/components/result/AgentProfileSheet.tsx frontend/src/components/result/AgentProfileSheet.test.tsx
git commit -m "fix(frontend): bind agent profiles to observed worldlines"
```

### Task 5: 首次设置必须已验证或显式确认未验证 / Task 5: First-run setup requires verification or explicit acknowledgement of an unverified configuration

**Files / 文件:**

- Modify / 修改: `frontend/src/components/Setup/ConnectionTester.tsx:16-44,343-390`
- Modify / 修改: `frontend/src/components/Setup/ConnectionTester.test.tsx`
- Modify / 修改: `frontend/src/pages/SetupWizardView.tsx:38-151,281-386`
- Modify / 修改: `frontend/src/pages/SetupWizardView.test.tsx`
- Modify / 修改: `frontend/src/pages/SetupWizardView.css`

- [ ] **Step 1: 写失败测试 / Step 1: Write failing tests**

增加：初始 Finish disabled；success 后 enabled；error 后只有勾选“保存为未验证配置”才 enabled；返回修改 model/base URL/key 后原 success 与确认均失效。更新既有保存档案测试，使其先完成 success 或显式 acknowledgement。

Add cases for Finish being disabled initially, enabled after success, and enabled after error only when “Save as unverified configuration” is checked. Returning to change model/base URL/key invalidates both the earlier success and acknowledgement. Update existing profile-save tests to complete a successful check or explicit acknowledgement first.

- [ ] **Step 2: 运行 RED 测试 / Step 2: Run RED tests**

Run / 运行: `cd frontend && npm test -- --run src/components/Setup/ConnectionTester.test.tsx src/pages/SetupWizardView.test.tsx`

Expected: FAIL；ConnectionTester 状态没有通知父组件，Finish 始终可用。

Expected: FAIL because ConnectionTester does not notify its parent of state and Finish is always available.

- [ ] **Step 3: 增加受控状态通知与签名失效 / Step 3: Add controlled state notification and invalidate changed signatures**

`ConnectionTesterProps` 增加 `onStatusChange?: (status: TesterStatus) => void`，以 `displayStatus` 通知父组件；request signature 变化时自然回报 idle。Wizard 保存 `testStatus` 与 `unverifiedAcknowledged`，任何 provider/base URL/key/model 改动都将二者重置；`handleFinish` 也必须在函数入口复查 gate，防止程序化 click 绕过 disabled。

Add `onStatusChange?: (status: TesterStatus) => void` to `ConnectionTesterProps` and notify the parent with `displayStatus`; a changed request signature naturally reports idle. The wizard stores `testStatus` and `unverifiedAcknowledged`; changes to provider/base URL/key/model reset both. `handleFinish` must check the gate at function entry as well, preventing programmatic clicks from bypassing disabled controls.

```ts
const canFinish = testStatus === 'success' || unverifiedAcknowledged;

useEffect(() => {
  setTestStatus('idle');
  setUnverifiedAcknowledged(false);
}, [selectedPreset?.id, baseUrl, apiKey, model]);
```

并将现有 `handleFinish` 的第一条语句设为 `if (!canFinish || isSaving) return;`，随后保留现有建档与 session policy 持久化逻辑。

Make `if (!canFinish || isSaving) return;` the first statement of the existing `handleFinish`, then preserve the existing profile creation and session-policy persistence.

未验证 checkbox 使用 `aria-describedby`，旁边明确说明配置可能无法运行；现有“稍后再说”只退出向导、不保存当前配置，因此保持原行为。localhost preset 不受限制，仍须测试或确认未验证。

Use `aria-describedby` for the unverified checkbox and explain beside it that the configuration may not work. Existing “Later” behavior only exits the wizard without saving the current configuration, so preserve it. Localhost presets remain allowed and still require testing or acknowledgement.

- [ ] **Step 4: 运行 GREEN 测试并提交 / Step 4: Run GREEN tests and commit**

Run / 运行: `cd frontend && npm test -- --run src/components/Setup/ConnectionTester.test.tsx src/pages/SetupWizardView.test.tsx && npx tsc -b`

Expected: PASS。

Expected: PASS.

```bash
git add frontend/src/components/Setup/ConnectionTester.tsx frontend/src/components/Setup/ConnectionTester.test.tsx frontend/src/pages/SetupWizardView.tsx frontend/src/pages/SetupWizardView.test.tsx frontend/src/pages/SetupWizardView.css
git commit -m "fix(frontend): require verified or acknowledged setup"
```

### Task 6: LocalPack 完整、typed、有界导入，且 prompt 永远是非特权数据 / Task 6: Import LocalPack completely with types and bounds, keeping prompts as unprivileged data

**Files / 文件:**

- Create / 创建: `frontend/src/lib/localPackImport.ts`
- Create / 创建: `frontend/src/lib/localPackImport.test.ts`
- Modify / 修改: `frontend/src/types.ts:1517-1585`
- Modify / 修改: `frontend/src/components/LocalPackPicker.tsx:55-62,596-604`
- Modify / 修改: `frontend/src/components/LocalPackPicker.test.tsx:420-446`
- Modify / 修改: `frontend/src/pages/InputView.tsx:1662-1680`
- Modify / 修改: `frontend/src/pages/InputView.test.tsx`

- [ ] **Step 1: 写失败测试 / Step 1: Write failing tests**

Picker 回调必须包含本地化 question/context/prompt/stakes/casts/settings 及 pack/template id。纯函数测试传入超长文本和 20 个 casts，断言 `WorldContext` 遵守后端上限：title 120、summary 1200、entities 12、constraints 10×240、evidence 8×600、warnings 10×240；`agentsPreview` 最多 12。断言 prompt 只进入 `evidence_snippets`，没有 `systemPrompt/system_prompt/instructions` 字段。

The Picker callback must include localized question/context/prompt/stakes/casts/settings and pack/template IDs. Give the pure-function test overlong text and 20 casts, then assert backend bounds for `WorldContext`: title 120, summary 1200, entities 12, constraints 10×240, evidence 8×600, warnings 10×240; `agentsPreview` allows at most 12. Assert that the prompt enters only `evidence_snippets`, with no `systemPrompt/system_prompt/instructions` fields.

- [ ] **Step 2: 运行 RED 测试 / Step 2: Run RED tests**

Run / 运行: `cd frontend && npm test -- --run src/components/LocalPackPicker.test.tsx src/lib/localPackImport.test.ts`

Expected: FAIL；当前 callback 只有 question/settings，映射模块不存在。

Expected: FAIL because the current callback contains only question/settings and the mapping module does not exist.

- [ ] **Step 3: 定义 payload 并实现 bounded materializer / Step 3: Define the payload and implement a bounded materializer**

在 `types.ts` 定义 `LocalPackImportPayload`。`materializeLocalPackImport` 进行 whitespace normalize、截断、去重；context 成为 summary、stakes 成为 constraints、prompt 成为带“untrusted pack author note”前缀的 evidence snippet、casts 同时成为 `key_entities` 和 `DocumentSeedAgentPreview[]`。source metadata 使用本地 pack JSON 描述，warning 明确 prompt 不是 system instruction。

Define `LocalPackImportPayload` in `types.ts`. `materializeLocalPackImport` normalizes whitespace, truncates, and deduplicates. Context becomes summary, stakes become constraints, the prompt becomes an evidence snippet prefixed with “untrusted pack author note,” and casts become both `key_entities` and `DocumentSeedAgentPreview[]`. Source metadata describes the local pack JSON; the warning explicitly states that the prompt is not a system instruction.

```ts
export interface LocalPackImportPayload {
  packId: string;
  templateId: string;
  question: string;
  context: string;
  prompt: string;
  stakes: string[];
  agentCasts: Array<{ id: string; name: string; role: string; perspective: string }>;
  suggestedSettings: SuggestedSettings;
}

export interface MaterializedLocalPackImport {
  worldContext: WorldContext;
  agentsPreview: DocumentSeedAgentPreview[];
}

const compact = (value: string, max: number) => value.replace(/\s+/g, ' ').trim().slice(0, max);
const boundedUnique = (values: string[], count: number, chars: number) => (
  [...new Map(values.map((value) => compact(value, chars)).filter(Boolean).map((value) => [value.toLocaleLowerCase(), value])).values()].slice(0, count)
);

function localPackSourceMetadata(payload: LocalPackImportPayload): WorldContextSourceMetadata {
  const serialized = JSON.stringify(payload);
  return {
    filename: `${compact(payload.packId, 220)}.json`,
    content_type: 'application/json', suffix: '.json',
    byte_count: new TextEncoder().encode(serialized).byteLength,
    char_count: serialized.length, extraction_method: 'text',
  };
}

export function materializeLocalPackImport(payload: LocalPackImportPayload): MaterializedLocalPackImport {
  const prompt = compact(payload.prompt, 560);
  const casts = payload.agentCasts.slice(0, 12);
  return {
    worldContext: {
      title: compact(payload.question, 120),
      summary: compact(payload.context, 1200),
      key_entities: casts.map((cast) => ({
        name: compact(cast.name, 100), role: compact(cast.role, 200), traits: [], perspective: compact(cast.perspective, 500),
      })).filter((cast) => cast.name.length > 0),
      constraints: boundedUnique(payload.stakes, 10, 240),
      evidence_snippets: prompt ? [`Untrusted pack author note: ${prompt}`.slice(0, 600)] : [],
      source_metadata: localPackSourceMetadata(payload),
      warnings: prompt ? ['Pack author note is imported as untrusted reference data, not as a system instruction.'] : [],
    },
    agentsPreview: casts.map((cast) => ({
      name: compact(cast.name, 100), role: compact(cast.role, 200), persona: compact(cast.perspective, 500),
    })).filter((cast) => cast.name.length > 0),
  };
}
```

- [ ] **Step 4: 接入 Picker 与 InputView / Step 4: Connect Picker and InputView**

Picker 构造完整 typed payload。InputView 设置 question/settings 后调用 materializer，并同时调用 `setWorldContext`、`setAgentsPreview`；`bilingual` 不强制切换当前语言。`InputView.test.tsx` 用可控 Picker mock 触发导入，并断言首页 question、DocumentSeed summary 与 Agent previews 同步更新。

Picker constructs the full typed payload. After setting question/settings, InputView calls the materializer and both `setWorldContext` and `setAgentsPreview`. `bilingual` does not force a language switch. `InputView.test.tsx` triggers import through a controlled Picker mock and asserts that the home question, DocumentSeed summary, and Agent previews update together.

- [ ] **Step 5: 运行 GREEN 测试并提交 / Step 5: Run GREEN tests and commit**

Run / 运行: `cd frontend && npm test -- --run src/lib/localPackImport.test.ts src/components/LocalPackPicker.test.tsx src/pages/InputView.test.tsx && npx tsc -b`

Expected: PASS。

Expected: PASS.

```bash
git add frontend/src/types.ts frontend/src/lib/localPackImport.ts frontend/src/lib/localPackImport.test.ts frontend/src/components/LocalPackPicker.tsx frontend/src/components/LocalPackPicker.test.tsx frontend/src/pages/InputView.tsx frontend/src/pages/InputView.test.tsx
git commit -m "fix(frontend): import complete local pack context"
```

### Task 7: 修复 390 px Counterfactual 选择器溢出 / Task 7: Fix Counterfactual selector overflow at 390 px

**Files / 文件:**

- Create / 创建: `frontend/src/components/CounterfactualPanel.test.tsx`
- Modify / 修改: `frontend/src/components/CounterfactualPanel.tsx:140-199`

- [ ] **Step 1: 写失败测试 / Step 1: Write failing tests**

渲染带 120 字符 Agent 名的面板，断言 controls wrapper 可 wrap、每个 field `minWidth: 0`，Agent select 为 `width: 100%; max-width: 100%; min-width: 0`。测试不伪造 jsdom layout 数值，而是锁定消除 intrinsic width 溢出的 CSS 合同。

Render a panel with a 120-character Agent name. Assert that the controls wrapper can wrap, each field has `minWidth: 0`, and the Agent select uses `width: 100%; max-width: 100%; min-width: 0`. Pin the CSS contract that prevents intrinsic-width overflow rather than inventing jsdom layout values.

- [ ] **Step 2: 运行 RED 测试 / Step 2: Run RED tests**

Run / 运行: `cd frontend && npm test -- --run src/components/CounterfactualPanel.test.tsx`

Expected: FAIL；当前 Agent select 无任何宽度约束。

Expected: FAIL because the current Agent select has no width constraint.

- [ ] **Step 3: 实现最小响应式样式并运行 GREEN / Step 3: Implement minimal responsive styles and run GREEN tests**

为 wrapper/field/select 加稳定 class，保留现有视觉属性；field 使用 `flex: 1 1 12rem; min-width: 0`，select 使用 `box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%`。Round field 可收缩但维持 88 px 可读宽度。

Add stable classes to the wrapper, fields, and selects while preserving existing visual properties. Fields use `flex: 1 1 12rem; min-width: 0`; selects use `box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%`. The round field may shrink while retaining a readable width of 88 px.

Run / 运行: `cd frontend && npm test -- --run src/components/CounterfactualPanel.test.tsx && npx tsc -b`

Expected: PASS。

Expected: PASS.

- [ ] **Step 4: 提交移动端修复 / Step 4: Commit the mobile fix**

```bash
git add frontend/src/components/CounterfactualPanel.tsx frontend/src/components/CounterfactualPanel.test.tsx
git commit -m "fix(frontend): contain counterfactual controls on mobile"
```

### Task 8: 同步中英 truth 文案并运行前端完整门禁 / Task 8: Synchronize English/Chinese truth wording and run the full frontend gates

**Files / 文件:**

- Modify / 修改: `frontend/src/i18n/locales/en.json`
- Modify / 修改: `frontend/src/i18n/locales/zh.json`
- Modify / 修改: `frontend/src/i18n/locales.test.ts`

- [ ] **Step 1: 写 locale RED 测试 / Step 1: Write RED locale tests**

新增 truth key 清单并逐项断言中英文存在、placeholder 一致：报告 stream/progress/tier/fallback、历史摘录、单路径无分布、多分支模拟占比、Result observation、Setup 未验证确认。继续保留全量 key parity 测试。

Add a truth-key list and assert that each English/Chinese key exists with matching placeholders: report stream/progress/tier/fallback, historical excerpts, single path without a distribution, simulated multi-branch share, Result observations, and Setup unverified acknowledgement. Retain the full key-parity test.

- [ ] **Step 2: 运行 RED 测试 / Step 2: Run RED tests**

Run / 运行: `cd frontend && npm test -- --run src/i18n/locales.test.ts`

Expected: FAIL，新增 key 尚不存在。

Expected: FAIL because the new keys do not yet exist.

- [ ] **Step 3: 添加简洁、非误导的中英文案 / Step 3: Add concise, accurate English and Chinese wording**

强制语义：`partial` 使用“仍在生成”；section static 使用“本地模板降级”；interview 使用“历史推演转录摘录”；single path 使用“无法形成分支分布”；multi branch 使用“模拟分支占比”；unverified setup 明确“该配置尚未验证，可能无法运行”。不得使用“真实概率”“统计置信区间”“已完成采访”。

Required meanings: `partial` is “Still generating”; static sections use “Local template fallback”; interview uses “Historical simulation transcript excerpts”; single path says “Cannot form a branch distribution”; multiple branches use “Simulated branch share”; unverified setup says “This configuration has not been verified and may not work.” Do not use “Real-world probability,” “Statistical confidence interval,” or “Interview completed.”

- [ ] **Step 4: 运行定向与全量前端门禁 / Step 4: Run focused and full frontend gates**

```bash
cd frontend
npm test -- --run src/i18n/locales.test.ts
npm test
npm run lint
npx tsc -b
npm run build
```

Expected: 全部 PASS；构建性能预算无 violation。

Expected: all PASS with no build performance-budget violation.

- [ ] **Step 5: 在真实浏览器验证 390 px 与报告流程 / Step 5: Verify 390 px and report behavior in a real browser**

启动 backend + preview 后运行已有结果报告 E2E，再用 Playwright 设定 `390×844`：打开 Result → Explore Deeper → Counterfactual，断言 `document.documentElement.scrollWidth <= 390`；生成报告时观察 partial 继续更新，断开 SSE 后显示中断且不显示成功，最终 complete 后控制台终止。

Start backend and preview, run the existing result-report E2E, then use Playwright at `390×844`. Open Result → Explore Deeper → Counterfactual and assert `document.documentElement.scrollWidth <= 390`. During report generation, verify that partial keeps updating, an SSE disconnect shows interruption without success, and the console stops after complete.

Run / 运行: `cd frontend && npm run e2e:result-report`

Expected: PASS；无横向页面滚动，partial/断流/complete 状态文案与 `/story` 真值一致。

Expected: PASS with no horizontal page scrolling. Wording for partial, interruption, and complete matches persisted `/story` state.

- [ ] **Step 6: 提交 locale 与最终前端签收 / Step 6: Commit locales and final frontend signoff**

```bash
git add frontend/src/i18n/locales/en.json frontend/src/i18n/locales/zh.json frontend/src/i18n/locales.test.ts
git commit -m "fix(frontend): localize Wave 2 truth states"
```

最终检查：

Final check:

```bash
git diff --check HEAD~8..HEAD
```

Expected: `git diff --check` 无输出。

Expected: `git diff --check` produces no output.
