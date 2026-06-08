"""S0 SSE helpers for the result report contract."""

from __future__ import annotations

from collections.abc import AsyncIterator

from app.services.result_report.schema import ResultReportSSEEvent, encode_sse_event


async def build_s0_report_stream(scenario_id: str) -> AsyncIterator[str]:
    """Yield the frozen Sprint S0 report SSE contract without generating a report."""

    yield encode_sse_event(
        ResultReportSSEEvent(
            event="report_started",
            data={"report_id": scenario_id, "status": "generating"},
        ),
    )
    yield encode_sse_event(
        ResultReportSSEEvent(
            event="report_complete",
            data={"report_id": scenario_id, "status": "skipped"},
        ),
    )
