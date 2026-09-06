"""Bounded report-text translation helpers; no database writes or model calls."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from app.services.result_report.schema import FullReport, ReportAuthoredContent

TRANSLATION_MAX_BATCHES = 8
TRANSLATION_BATCH_CHARS = 6_000
TRANSLATION_MAX_OUTPUT_CHARS = 96_000
_TRANSLATABLE_SCALARS = (
    "title", "summary", "headline_answer", "limitations", "disclaimer", "confidence_basis",
)
_INDICATOR_TEXT_FIELDS = ("signal", "note", "threshold", "observation", "time_horizon", "rationale")
_PREMORTEM_TEXT_FIELDS = (
    "failure_mode_i18n", "mechanism_i18n", "early_warning_i18n", "uncertainty_i18n",
)
_NUMBERS_RE = re.compile(
    r"(?<![A-Za-z0-9_.])(?<![A-Za-z_][+-])[-+]?\d+(?:[.,]\d+)*(?:%|％)?(?![A-Za-z0-9_.])"
)
_CODE_RE = re.compile(r"```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`")
_URL_RE = re.compile(r"https?://[^\s)]+")


@dataclass(frozen=True)
class ReportTextField:
    path: tuple[str | int, ...]
    text: str


def authored_content(report: FullReport, language: str) -> ReportAuthoredContent:
    """Project a saved language without modifying original report text."""
    basis = report.verdict.analytic_confidence
    payload: dict[str, Any] = {
        "title": getattr(report.title_i18n, language) or report.title,
        "summary": getattr(report.summary_i18n, language) or report.summary,
        "headline_answer": report.verdict.headline_answer,
        "limitations": report.limitations,
        "disclaimer": report.verdict.disclaimer,
        "confidence_basis": getattr(basis.basis_i18n, language)
        if basis.basis_i18n
        else basis.basis,
        "section_texts": {
            section.id: {
                "title": getattr(section.title_i18n, language) or section.title,
                "body_md": getattr(section.body_md_i18n, language),
            }
            for section in report.sections
        },
        **report.model_dump(
            mode="json",
            include={
                "follow_ups",
                "indicators_to_watch",
                "dissenting",
                "interview_evidence",
                "interview_status",
                "premortem_analysis",
            },
        ),
    }
    localized = report.authored_content_i18n.get(language)
    if localized is not None:
        payload.update(
            {
                key: value
                for key, value in localized.model_dump(mode="json").items()
                if value is not None
            }
        )
    return ReportAuthoredContent.model_validate(payload)


def report_text_fields(
    payload: dict[str, Any],
    *,
    source_language: str,
    target_language: str,
    include_sections: bool = True,
) -> list[ReportTextField]:
    fields: list[ReportTextField] = []

    def append(path: tuple[str | int, ...], value: object) -> None:
        if isinstance(value, str) and value.strip():
            fields.append(ReportTextField(path=path, text=value))

    for key in _TRANSLATABLE_SCALARS:
        append((key,), payload.get(key))
    if include_sections:
        for section_id, section in (payload.get("section_texts") or {}).items():
            for key in ("title", "body_md"):
                append(("section_texts", section_id, key), section.get(key))
    for index, value in enumerate(payload.get("follow_ups") or []):
        append(("follow_ups", index), value)
    for index, indicator in enumerate(payload.get("indicators_to_watch") or []):
        for key in _INDICATOR_TEXT_FIELDS:
            append(("indicators_to_watch", index, key), indicator.get(key))
    dissenting = payload.get("dissenting")
    if isinstance(dissenting, dict):
        for key in ("why_verdict_could_be_wrong", "what_almost_won"):
            append(("dissenting", key), dissenting.get(key))
    status = payload.get("interview_status")
    if isinstance(status, dict):
        append(("interview_status", "message"), status.get("message"))
    # Interview excerpts are original evidence and intentionally do not enter the
    # translation payload. The variant preserves them byte-for-byte.
    analysis = payload.get("premortem_analysis")
    for index, item in enumerate(analysis.get("items", []) if isinstance(analysis, dict) else []):
        for key in _PREMORTEM_TEXT_FIELDS:
            localized = item.get(key) or {}
            value = localized.get(source_language) or localized.get(target_language)
            if isinstance(value, str):
                localized[target_language] = value
                append(("premortem_analysis", "items", index, key, target_language), value)
        for link_index, link in enumerate(item.get("evidence_chain") or []):
            localized = link.get("rationale_i18n") or {}
            value = localized.get(source_language) or localized.get(target_language)
            if isinstance(value, str):
                localized[target_language] = value
                append(
                    (
                        "premortem_analysis",
                        "items",
                        index,
                        "evidence_chain",
                        link_index,
                        "rationale_i18n",
                        target_language,
                    ),
                    value,
                )
    return fields


def set_report_text(payload: dict[str, Any], path: tuple[str | int, ...], text: str) -> None:
    current: Any = payload
    for key in path[:-1]:
        current = current[key]
    current[path[-1]] = text


class ReportTranslationProtection:
    """Freeze source quotations, provenance, numerals and existing safety labels."""

    def __init__(
        self, report: FullReport, *, target_language: str, identity_names: tuple[str, ...]
    ) -> None:
        self.prefix = f"REPORT_KEEP_{uuid4().hex}_"
        self.values: dict[str, str] = {}
        self.identities = tuple(
            sorted({value for value in identity_names if value}, key=len, reverse=True)
        )
        self.references = tuple(
            sorted(
                {
                    value
                    for evidence in report.evidence
                    for value in (
                        evidence.id,
                        evidence.message_id,
                        evidence.branch_id,
                        evidence.round_id,
                        evidence.agent_id,
                    )
                },
                key=len,
                reverse=True,
            )
        )
        self.quotes = tuple(
            sorted(
                {
                    *(item.quote for item in report.evidence),
                    *(claim.exact_quote for claim in report.claims if claim.exact_quote),
                    *(
                        entry.get("excerpt")
                        for entry in report.interview_evidence
                        if isinstance(entry.get("excerpt"), str)
                    ),
                },
                key=len,
                reverse=True,
            )
        )
        self.notice_pairs = (
            ("**Evidence-limited hypothesis:**", "**证据有限的假设：**"),
            ("**Unverified attribution:**", "**归因未经验证：**"),
            ("Evidence-limited hypothesis:", "证据有限的假设："),
            ("Unverified attribution:", "归因未经验证："),
        )
        self.target_language = target_language

    def _token(self, original: str) -> str:
        token = f"[[{self.prefix}{len(self.values):04d}]]"
        self.values[token] = original
        return token

    def protect(self, text: str) -> str:
        spans: list[tuple[int, int, str, int]] = []

        def literal_spans(literal: str, replacement: str, priority: int) -> None:
            if not literal:
                return
            for match in re.finditer(re.escape(literal), text):
                spans.append((match.start(), match.end(), replacement, priority))

        for quote in self.quotes:
            for opening, closing in (
                ("“", "”"),
                ('"', '"'),
                ("‘", "’"),
                ("「", "」"),
                ("『", "』"),
                ("«", "»"),
            ):
                literal = f"{opening}{quote}{closing}"
                literal_spans(literal, literal, 0)
            block = "> " + quote.replace("\n", "\n> ")
            literal_spans(block, block, 0)
        for pattern in (_CODE_RE, _URL_RE):
            for match in pattern.finditer(text):
                spans.append((match.start(), match.end(), match.group(0), 0))
        for english, chinese in self.notice_pairs:
            replacement = chinese if self.target_language == "zh" else english
            for source in (english, chinese):
                literal_spans(source, replacement, 1)
        for literal in self.references:
            literal_spans(literal, literal, 2)
        for literal in self.identities:
            literal_spans(literal, literal, 3)
        for match in _NUMBERS_RE.finditer(text):
            spans.append((match.start(), match.end(), match.group(0), 4))
        protected = [False] * len(text)
        selected: list[tuple[int, int, str]] = []
        for start, end, replacement, _priority in sorted(
            spans, key=lambda span: (span[3], -(span[1] - span[0]), span[0])
        ):
            if any(protected[start:end]):
                continue
            protected[start:end] = [True] * (end - start)
            selected.append((start, end, self._token(replacement)))
        parts: list[str] = []
        cursor = 0
        for start, end, token in sorted(selected):
            parts.extend((text[cursor:start], token))
            cursor = end
        parts.append(text[cursor:])
        return "".join(parts)

    def restore(self, source: str, translated: str) -> str:
        source_tokens = re.findall(r"\[\[REPORT_KEEP_[^\]\s]+\]\]", source)
        translated_tokens = re.findall(r"\[\[REPORT_KEEP_[^\]\s]+\]\]", translated)
        if source_tokens != translated_tokens:
            raise ValueError("Translation changed the order or presence of protected source values")
        unprotected = re.sub(r"\[\[REPORT_KEEP_[^\]\s]+\]\]", "", translated)
        if (
            _NUMBERS_RE.search(unprotected)
            or _URL_RE.search(unprotected)
            or _CODE_RE.search(unprotected)
        ):
            raise ValueError("Translation introduced an unprotected figure, URL, or code span")
        for token in translated_tokens:
            if token not in self.values:
                raise ValueError("Translation introduced an unknown protected token")
        for token, original in self.values.items():
            if translated.count(token) != source.count(token):
                raise ValueError("Translation changed a protected quotation or coordinate")
            translated = translated.replace(token, original)
        return translated


def split_translation_text(text: str) -> list[str]:
    chunks: list[str] = []
    current = ""
    for paragraph in text.split("\n\n"):
        if len(paragraph) > TRANSLATION_BATCH_CHARS:
            raise ValueError("A report paragraph exceeds the bounded translation size")
        joined = f"{current}\n\n{paragraph}" if current else paragraph
        if len(joined) > TRANSLATION_BATCH_CHARS:
            chunks.append(current)
            current = paragraph
        else:
            current = joined
    if current:
        chunks.append(current)
    return chunks or [text]
