/* ═══════════════════════════════════════════════════════════
   PersonaExportMenu — unified persona export/import menu for
   the Agent Workshop. Wraps the existing ExportButton +
   ImportDialog primitives in a single toolbar surface that the
   workshop view can drop in next to its primary actions.

   - Export: only renders when an existing identity id is known
     (i.e., edit mode). Reuses the gated ExportButton, which
     itself checks the `persona_export` capability.
   - Import: opens the shared ImportDialog. Calls onImported with
     the new identity id so the host can navigate / refresh.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useCapabilityCheck } from '../../hooks/useCapabilityCheck';
import {
  ExportButton,
  ImportDialog,
} from '../PersonaExportImport';

export interface PersonaExportMenuProps {
  /** When provided, renders the export button for this identity. */
  identityId?: string;
  /** Display name used for the export button aria-label + filename. */
  identityName?: string;
  /** Called with the newly imported identity id after a successful import. */
  onImported?: (identityId: string) => void;
}

export function PersonaExportMenu({
  identityId,
  identityName,
  onImported,
}: PersonaExportMenuProps) {
  const { t } = useTranslation();
  const { enabled, loading } = useCapabilityCheck('persona_export');
  const [importOpen, setImportOpen] = useState(false);

  const handleImported = useCallback(
    (newId: string) => {
      setImportOpen(false);
      onImported?.(newId);
    },
    [onImported],
  );

  if (loading || !enabled) {
    return null;
  }

  return (
    <div
      className="persona-export-menu"
      role="group"
      aria-label={t('persona_export.menu_aria', 'Persona export and import')}
    >
      {identityId && identityName && (
        <ExportButton identityId={identityId} name={identityName} />
      )}
      <button
        type="button"
        className="agent-button"
        onClick={() => setImportOpen(true)}
      >
        {t('persona_export.import', 'Import Persona')}
      </button>
      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={handleImported}
      />
    </div>
  );
}

export default PersonaExportMenu;
