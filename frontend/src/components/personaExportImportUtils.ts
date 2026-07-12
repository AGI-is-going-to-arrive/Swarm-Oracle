import type { PersonaExportPayload } from '../api/client';

const PERSONA_SCHEMA_VERSION = 1;

interface ValidationOk {
  ok: true;
  payload: PersonaExportPayload;
}
interface ValidationErr {
  ok: false;
  errorKey: 'persona_export.invalid_schema' | 'persona_export.missing_fields' | 'persona_export.invalid_json';
}

/**
 * Validate a parsed JSON value against the schema_version 1 contract.
 * Returns either a typed payload or an i18n error key.
 *
 * Required: schema_version === 1, persona.{name, role} non-empty strings,
 * and persona_text present as a string.
 * Soft-fills: decision_bias = {}, tags = [], exported_at = "" if absent.
 */
export function validatePersonaPayload(raw: unknown): ValidationOk | ValidationErr {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errorKey: 'persona_export.invalid_schema' };
  }
  const root = raw as Record<string, unknown>;
  if (root.schema_version !== PERSONA_SCHEMA_VERSION) {
    return { ok: false, errorKey: 'persona_export.invalid_schema' };
  }
  const personaRaw = root.persona;
  if (!personaRaw || typeof personaRaw !== 'object' || Array.isArray(personaRaw)) {
    return { ok: false, errorKey: 'persona_export.missing_fields' };
  }
  const persona = personaRaw as Record<string, unknown>;
  const name = typeof persona.name === 'string' ? persona.name.trim() : '';
  const role = typeof persona.role === 'string' ? persona.role.trim() : '';
  const personaText = typeof persona.persona_text === 'string' ? persona.persona_text.trim() : null;
  if (!name || !role || personaText === null) {
    return { ok: false, errorKey: 'persona_export.missing_fields' };
  }

  const decisionBias: Record<string, number> = {};
  if (persona.decision_bias && typeof persona.decision_bias === 'object' && !Array.isArray(persona.decision_bias)) {
    for (const [biasKey, biasValue] of Object.entries(persona.decision_bias as Record<string, unknown>)) {
      if (typeof biasValue === 'number' && Number.isFinite(biasValue)) {
        decisionBias[biasKey] = biasValue;
      }
    }
  }
  const tags = Array.isArray(persona.tags)
    ? (persona.tags as unknown[]).filter((tag): tag is string => typeof tag === 'string')
    : [];

  return {
    ok: true,
    payload: {
      schema_version: PERSONA_SCHEMA_VERSION,
      exported_at: typeof root.exported_at === 'string' ? root.exported_at : '',
      persona: {
        name,
        role,
        persona_text: personaText,
        decision_bias: decisionBias,
        tags,
      },
    },
  };
}

/** Trigger a browser download for a JSON payload. Exported for testing. */
export function triggerJsonDownload(payload: unknown, fileName: string): void {
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
