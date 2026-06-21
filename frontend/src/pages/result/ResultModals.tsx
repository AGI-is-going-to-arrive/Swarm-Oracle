/* ═══════════════════════════════════════════════════════════
   SwarmOracle — Result modals + unified source feed + conversation widget
   ═══════════════════════════════════════════════════════════ */

import { type Dispatch, type ReactNode, type RefObject, type SetStateAction, useState, useEffect } from 'react';
import type { OracleReplayPayload } from '../../lib/oracleReplay';
import type { ShareFlavorContext } from '../../lib/shareEnvelope';
import type { EndingRoomCandidate } from '../../lib/endingRoomCandidates';
import type { StoryData, WebSearchContext, ModelProfile } from '../../types';
import { useCapabilityCheck } from '../../hooks/useCapabilityCheck';
import { listModelProfiles } from '../../api/client';
import ShareModal from '../../components/ShareModal';
import SnapshotExportWizard from '../../components/Export/SnapshotExportWizard';
import EndingChatModal from '../../components/EndingChatModal';
import { ResultConversationWidget } from '../../components/ResultConversationWidget';
import { NodeConversationSheet } from '../../components/kg/NodeConversationSheet';
import { MobileSourceSheet } from '../../components/result/MobileSourceSheet';
import { UnifiedSourceFeed } from '../../components/result/UnifiedSourceFeed';
import { getEndingRoomCandidateAvatar } from '../resultHelpers';
import { useResultContext } from './ResultContext';

type SourceFamilyContext = NonNullable<WebSearchContext['family_context']>;

interface PendingEndingRoomPicker {
  branchId: string;
  roomType: 'ending_chamber' | 'one_move_only';
  selectedAgentIds: string[];
  maxSelectable: number;
}

interface ResultModalsProps {
  shareFlavorContext: ShareFlavorContext;
  setShareAutomation: (next: Record<string, unknown> | null) => void;
  pendingEndingRoomPicker: PendingEndingRoomPicker | null;
  setPendingEndingRoomPicker: Dispatch<SetStateAction<PendingEndingRoomPicker | null>>;
  pendingEndingRoomBranch: StoryData['branches'][number] | null;
  pendingEndingRoomCandidates: EndingRoomCandidate[];
  endingRoomPickerDialogRef: RefObject<HTMLDivElement | null>;
  endingRoomPickerCloseRef: RefObject<HTMLButtonElement | null>;
  openEndingRoomDirect: (
    branchId: string,
    roomType: 'ending_chamber' | 'one_move_only' | 'crossline_gallery',
    selectedAgentIds?: string[],
    roomModelProfileId?: string,
  ) => void;
  activeEndingRoomBranch: StoryData['branches'][number] | null;
  activeEndingRoomMode: 'ending_chamber' | 'one_move_only' | 'crossline_gallery';
  activeEndingRoomSelectedBranchIds: string[];
  activeEndingRoomSelectedAgentIds: string[];
  activeEndingRoomReplayPayload: OracleReplayPayload | null;
  endingRoomHeaderActions: ReactNode;
  setEndingRoomAutomation: (next: Record<string, unknown> | null) => void;
  handleEndingRoomModeChange: (next: 'ending_chamber' | 'one_move_only') => void;
  handleCloseEndingRoom: () => void;
  // Source family contexts
  sourceFamilyContext: SourceFamilyContext;
  mobileSourceSheetOpen: boolean;
  setMobileSourceSheetOpen: (next: boolean) => void;
  resultConversationContext: {
    branchId: string;
    title: string;
    insight?: string | null | undefined;
    forkReason?: string | null | undefined;
    keyMoments?: string[] | null | undefined;
    comparisonTitles: string[];
  } | null;
  activeEndingRoomModelProfileId?: string;
}

export default function ResultModals(props: ResultModalsProps) {
  const {
    shareFlavorContext,
    setShareAutomation,
    pendingEndingRoomPicker,
    setPendingEndingRoomPicker,
    pendingEndingRoomBranch,
    pendingEndingRoomCandidates,
    endingRoomPickerDialogRef,
    endingRoomPickerCloseRef,
    openEndingRoomDirect,
    activeEndingRoomBranch,
    activeEndingRoomMode,
    activeEndingRoomSelectedBranchIds,
    activeEndingRoomSelectedAgentIds,
    activeEndingRoomReplayPayload,
    endingRoomHeaderActions,
    setEndingRoomAutomation,
    handleEndingRoomModeChange,
    handleCloseEndingRoom,
    mobileSourceSheetOpen,
    setMobileSourceSheetOpen,
    resultConversationContext,
    activeEndingRoomModelProfileId,
  } = props;

  const {
    t,
    id,
    isReplayMode,
    showShare,
    setShowShare,
    showSnapshotExport,
    setShowSnapshotExport,
    scenario,
    branches,
    agents,
    shareSourceFamilies,
    capabilities,
    activeScenarioId,
    primaryAgentIdentityId,
    isZh,
    resolvedProfileId,
    gameplayProfileLabel,
    gameplayProfileHooks,
    agentFollowupTarget,
    setAgentFollowupTarget,
    analysisBranch,
  } = useResultContext();
  const { enabled: modelProfilesEnabled } = useCapabilityCheck('model_profiles');
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [endingRoomProfileId, setEndingRoomProfileId] = useState<string>('');

  useEffect(() => {
    if (modelProfilesEnabled && pendingEndingRoomPicker) {
      listModelProfiles()
        .then((res) => setProfiles(res.profiles || []))
        .catch(() => {});
    }
  }, [modelProfilesEnabled, pendingEndingRoomPicker]);

  if (!pendingEndingRoomPicker && endingRoomProfileId !== '') {
    setEndingRoomProfileId('');
  }
  const ctx = scenario?.web_search_context;
  const showFeed = Boolean(ctx);

  return (
    <>
      {/* Share Modal (P6) */}
      {showShare && id && !isReplayMode && (
        <ShareModal
          scenarioId={id}
          shareContext={shareFlavorContext}
          branches={branches.map((b) => ({ ...b, fork_round: 0, summary: b.insight ?? '', status: b.status as 'COMPLETED' | 'ACTIVE' | 'PRUNED' }))}
          agentNames={agents.slice(0, 3).map((a) => a.name)}
          sourceFamilies={shareSourceFamilies}
          onAutomationStateChange={setShareAutomation}
          onClose={() => setShowShare(false)}
        />
      )}
      {/* S3-6: Snapshot export wizard */}
      {showSnapshotExport && id && !isReplayMode && (
        <SnapshotExportWizard
          scenarioId={id}
          isOpen={showSnapshotExport}
          onClose={() => setShowSnapshotExport(false)}
          scenarioTitle={scenario?.question ?? undefined}
        />
      )}
      {pendingEndingRoomPicker && pendingEndingRoomBranch && (
        <div className="ending-room-picker-overlay" onClick={() => setPendingEndingRoomPicker(null)}>
          <div
            ref={endingRoomPickerDialogRef}
            className="ending-room-picker"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ending-room-picker-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="ending-room-picker__header">
              <div>
                <p className="ending-room-picker__kicker">
                  {pendingEndingRoomPicker.roomType === 'one_move_only'
                    ? t('ending_room.one_move_cta')
                    : t('ending_room.entry_cta')}
                </p>
                <h3 id="ending-room-picker-title">
                  {t('result.ending_room_picker_title')}
                </h3>
                <p>
                  {pendingEndingRoomBranch.title}
                  {' · '}
                  {t('result.ending_room_picker_limit', { count: pendingEndingRoomPicker.maxSelectable })}
                </p>
              </div>
              <button
                type="button"
                ref={endingRoomPickerCloseRef}
                className="ending-room-picker__close"
                onClick={() => setPendingEndingRoomPicker(null)}
                aria-label={t('common.close')}
              >
                ×
              </button>
            </header>

            <div className="ending-room-picker__body">
              {pendingEndingRoomCandidates.length === 0 ? (
                <p className="ending-room-picker__empty">
                  {t('result.ending_room_picker_empty')}
                </p>
              ) : (
                pendingEndingRoomCandidates.map((candidate) => {
                  const selected = pendingEndingRoomPicker.selectedAgentIds.includes(candidate.id);
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      className={`ending-room-picker__card ${selected ? 'is-selected' : ''}`}
                      aria-pressed={selected}
                      onClick={() => {
                        setPendingEndingRoomPicker((current) => {
                          if (!current || current.branchId !== pendingEndingRoomBranch.id) {
                            return current;
                          }
                          const alreadySelected = current.selectedAgentIds.includes(candidate.id);
                          if (alreadySelected) {
                            return {
                              ...current,
                              selectedAgentIds: current.selectedAgentIds.filter((item) => item !== candidate.id),
                            };
                          }
                          if (current.maxSelectable === 1) {
                            return { ...current, selectedAgentIds: [candidate.id] };
                          }
                          if (current.selectedAgentIds.length >= current.maxSelectable) {
                            return current;
                          }
                          return {
                            ...current,
                            selectedAgentIds: [...current.selectedAgentIds, candidate.id],
                          };
                        });
                      }}
                    >
                      <img
                        className="ending-room-picker__avatar"
                        src={getEndingRoomCandidateAvatar(candidate.role, candidate.name)}
                        alt=""
                        aria-hidden="true"
                      />
                      <div className="ending-room-picker__card-copy">
                        <strong>{candidate.name}</strong>
                        <span>{candidate.role}</span>
                        {candidate.persona && <small>{candidate.persona}</small>}
                        <em>
                          {candidate.contributionCount > 0
                            ? t('result.ending_room_picker_impact', {
                                impact: Math.round(candidate.impactScore * 100),
                                turns: candidate.contributionCount,
                                hinges: candidate.keyMomentHits,
                                round: candidate.lastRound,
                              })
                            : t('result.ending_room_picker_fallback_roster')}
                        </em>
                        {candidate.fallbackCast && (
                          <em className="ending-room-picker__fallback">
                            {t('result.ending_room_picker_fallback_lineup')}
                          </em>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {modelProfilesEnabled && (
              <div className="ending-room-picker__profile-selector" style={{ marginBottom: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <label htmlFor="ending-room-profile-select" style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-color)' }}>
                  {t('model_profiles.placeholder_select')}
                </label>
                <select
                  id="ending-room-profile-select"
                  className="form-control"
                  value={endingRoomProfileId}
                  onChange={(e) => setEndingRoomProfileId(e.target.value)}
                  style={{ width: '100%', padding: '0.4rem 0.5rem', borderRadius: '4px', border: '1px solid var(--border-color, #e6dfd5)', fontSize: '0.85rem' }}
                >
                  <option value="">{t('model_profiles.byok_custom_option')}</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>{p.name} ({p.provider} - {p.model})</option>
                  ))}
                </select>
              </div>
            )}

            <footer className="ending-room-picker__footer">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setPendingEndingRoomPicker(null)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => openEndingRoomDirect(
                  pendingEndingRoomPicker.branchId,
                  pendingEndingRoomPicker.roomType,
                  pendingEndingRoomPicker.selectedAgentIds,
                  endingRoomProfileId || undefined,
                )}
                disabled={
                  pendingEndingRoomCandidates.length > 0
                  && pendingEndingRoomPicker.selectedAgentIds.length === 0
                }
              >
                {t('result.ending_room_picker_enter')}
              </button>
            </footer>
          </div>
        </div>
      )}
      {activeEndingRoomBranch && scenario && (
        <EndingChatModal
          open={Boolean(activeEndingRoomBranch)}
          scenarioId={scenario.id}
          branch={activeEndingRoomBranch}
          roomType={activeEndingRoomMode}
          selectedBranchIds={activeEndingRoomSelectedBranchIds}
          profileId={resolvedProfileId}
          profileLabel={gameplayProfileLabel}
          profileHooks={gameplayProfileHooks}
          selectedAgentIds={activeEndingRoomSelectedAgentIds}
          galleryBranches={branches}
          language={isZh ? 'zh' : 'en'}
          readOnly={isReplayMode || Boolean(activeEndingRoomReplayPayload)}
          roomModelProfileId={activeEndingRoomModelProfileId}
          fallbackMessages={
            activeEndingRoomBranch
              ? (scenario?.messages ?? []).filter((message) => message.branch === activeEndingRoomBranch.id)
              : []
          }
          replayState={activeEndingRoomReplayPayload ? {
            snapshot: activeEndingRoomReplayPayload.roomSnapshot,
            result: activeEndingRoomReplayPayload.roomResult,
            activeThreadId: activeEndingRoomReplayPayload.activeThreadId,
            selectedAgentIds: activeEndingRoomReplayPayload.selectedAgentIds,
          } : null}
          headerActions={endingRoomHeaderActions}
          onAutomationStateChange={setEndingRoomAutomation}
          onModeChange={handleEndingRoomModeChange}
          onClose={handleCloseEndingRoom}
        />
      )}
      {showFeed && (
        <>
          <button
            type="button"
            data-testid="result-mobile-sources-trigger"
            onClick={() => setMobileSourceSheetOpen(true)}
            aria-expanded={mobileSourceSheetOpen}
            aria-controls={mobileSourceSheetOpen ? "mobile-source-sheet" : undefined}
            className="result-mobile-sources-trigger"
          >
            {t('source.feed.title', { defaultValue: 'Real-World Sources' })}
          </button>
          <MobileSourceSheet
            open={mobileSourceSheetOpen}
            onOpenChange={setMobileSourceSheetOpen}
          >
            <UnifiedSourceFeed target="mobile" />
          </MobileSourceSheet>
        </>
      )}
      {!isReplayMode && activeScenarioId && (capabilities?.agent_conversation?.enabled ?? false) && (
        <div id="result-conversation">
          <ResultConversationWidget
            scenarioId={activeScenarioId}
            primaryAgentIdentityId={primaryAgentIdentityId}
            resultContext={resultConversationContext}
          />
        </div>
      )}
      {!isReplayMode
        && activeScenarioId
        && (capabilities?.agent_conversation?.enabled ?? false)
        && agentFollowupTarget && (
        <NodeConversationSheet
          key={`${activeScenarioId}:${agentFollowupTarget.id}:${agentFollowupTarget.agent_identity_id ?? ''}`}
          open={!!agentFollowupTarget}
          onOpenChange={(open) => { if (!open) setAgentFollowupTarget(null); }}
          scenarioId={activeScenarioId}
          identityId={agentFollowupTarget.agent_identity_id ?? null}
          origin={{
            surface: 'result',
            nodeId: `agent:${agentFollowupTarget.id}`,
            nodeType: 'agent',
            agentName: agentFollowupTarget.name,
            nodeLabel: agentFollowupTarget.name,
            excerpt: (agentFollowupTarget.persona ?? '').slice(0, 200),
            branchId: analysisBranch?.id ?? null,
          }}
        />
      )}
    </>
  );
}
