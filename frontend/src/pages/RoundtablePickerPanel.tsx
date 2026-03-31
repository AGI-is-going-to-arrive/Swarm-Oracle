import { useTranslation } from 'react-i18next';
import type { EndingRoomCandidate } from '../lib/endingRoomCandidates';
import type { EndingRoomSnapshot, RoundtableWitnessSelection, StoryData } from '../types';
import {
  type RoundtableSelectionMode,
  type WitnessCandidate,
  MANUAL_SHORTLIST_MIN,
} from './roundtableHelpers';

interface Props {
  isZh: boolean;
  selectionMode: RoundtableSelectionMode;
  onSelectionModeChange: (mode: RoundtableSelectionMode) => void;
  effectiveSnapshot: EndingRoomSnapshot | null;
  branches: StoryData['branches'];
  branchOrder: string[];
  branchCandidates: Record<string, EndingRoomCandidate[]>;
  selectedRepresentatives: Record<string, string>;
  onSelectRepresentative: (branchId: string, agentId: string) => void;
  selectedBranchIdsForLaunch: string[];
  selectionUsesShortlist: boolean;
  manualShortlistMin: number;
  manualShortlistMax: number;
  onToggleManualShortlistBranch: (branchId: string) => void;
  witnessCandidates: WitnessCandidate[];
  selectedWitness: RoundtableWitnessSelection | null;
  onSelectWitness: (witness: RoundtableWitnessSelection) => void;
  launchingRoom: boolean;
  onLaunchRoundtable: () => void;
  onCancelEditing: () => void;
}

export default function RoundtablePickerPanel({
  isZh,
  selectionMode,
  onSelectionModeChange,
  effectiveSnapshot,
  branches,
  branchOrder,
  branchCandidates,
  selectedRepresentatives,
  onSelectRepresentative,
  selectedBranchIdsForLaunch,
  selectionUsesShortlist,
  manualShortlistMin,
  manualShortlistMax,
  onToggleManualShortlistBranch,
  witnessCandidates,
  selectedWitness,
  onSelectWitness,
  launchingRoom,
  onLaunchRoundtable,
  onCancelEditing,
}: Props) {
  const { t } = useTranslation();

  const hintText = selectionMode === 'manual_shortlist'
    ? t('roundtable.shortlist_hint')
    : selectionMode === 'trait_mix'
      ? t('roundtable.trait_mix_hint')
      : selectionMode === 'fault_line_first'
        ? t('roundtable.fault_line_hint')
        : selectionMode === 'witness_augmented'
          ? t('roundtable.witness_augmented_hint')
    : (isZh
      ? (effectiveSnapshot
        ? '当前桌面会保留到你重新开桌为止。改完代表后，再用新的阵容重建这桌圆桌。'
        : '每条结局只派一位代表入席。系统会优先按影响度预选，并尽量错开代表，让这桌更有比较价值。')
      : (effectiveSnapshot
        ? 'The current table stays available until you reopen it. Swap representatives here, then rebuild the roundtable with the new lineup.'
        : 'Seat one representative for each ending. The table starts with high-impact picks while trying to avoid the same voice on every worldline.'));

  const launchDisabled = launchingRoom
    || selectedBranchIdsForLaunch.length === 0
    || selectedBranchIdsForLaunch.some((branchId) => !selectedRepresentatives[branchId]);

  const launchLabel = launchingRoom
    ? (isZh ? '正在开桌…' : 'Launching…')
    : (effectiveSnapshot
      ? (isZh ? '按当前阵容重开' : 'Reopen this lineup')
      : (isZh ? '按当前代表开桌' : 'Open this lineup'));

  const showWitnessSection = selectionMode === 'expert_witness' || selectionMode === 'witness_augmented';

  return (
    <section className="worldline-roundtable-card worldline-roundtable-card--picker">
      <div className="worldline-roundtable-card__heading worldline-roundtable-card__heading--stacked">
        <div>
          <h3>{isZh ? '改选每条世界线的代表' : 'Reseat each worldline representative'}</h3>
          <p className="worldline-roundtable-picker__hint">{hintText}</p>
          <div className="worldline-roundtable-picker__mode-switch" role="group" aria-label={isZh ? '圆桌桌型' : 'Roundtable seating mode'}>
            {(['representative', 'manual_shortlist', 'expert_witness', 'trait_mix', 'fault_line_first', 'witness_augmented'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`worldline-roundtable-picker__mode-pill ${selectionMode === mode ? 'is-active' : ''}`}
                onClick={() => onSelectionModeChange(mode)}
                disabled={
                  (mode === 'expert_witness' && witnessCandidates.length === 0)
                  || (mode === 'fault_line_first' && branchOrder.length < 2)
                  || (mode === 'witness_augmented' && witnessCandidates.length === 0)
                }
              >
                {t(`roundtable.selection_mode_${mode}`)}
              </button>
            ))}
            {selectionUsesShortlist && (
              <span className="worldline-roundtable-picker__count">
                {t('roundtable.shortlist_count', {
                  count: selectedBranchIdsForLaunch.length,
                  max: manualShortlistMax,
                })}
              </span>
            )}
          </div>
        </div>
        <div className="worldline-roundtable-picker__actions">
          {effectiveSnapshot && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onCancelEditing}
              disabled={launchingRoom}
            >
              {isZh ? '返回当前圆桌' : 'Back to current table'}
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={onLaunchRoundtable}
            disabled={launchDisabled}
          >
            {launchLabel}
          </button>
        </div>
      </div>

      <div className="worldline-roundtable-picker-grid">
        {branches.map((branch) => {
          const candidates = branchCandidates[branch.id] ?? [];
          const branchSelected = !selectionUsesShortlist || selectedBranchIdsForLaunch.includes(branch.id);
          const branchToggleDisabled = !selectionUsesShortlist
            || (branchSelected
              ? selectedBranchIdsForLaunch.length <= manualShortlistMin
              : selectedBranchIdsForLaunch.length >= manualShortlistMax);
          return (
            <article key={branch.id} className={`worldline-roundtable-picker-branch ${branchSelected ? 'is-active' : 'is-muted'}`}>
              <header className="worldline-roundtable-picker-branch__header">
                <div>
                  <strong>{branch.title}</strong>
                  <span>{Math.round((branch.probability ?? 0) * 100)}%</span>
                </div>
                {selectionUsesShortlist && branchOrder.length > MANUAL_SHORTLIST_MIN && (
                  <button
                    type="button"
                    className={`worldline-roundtable-picker-branch__toggle ${branchSelected ? 'is-active' : ''}`}
                    onClick={() => onToggleManualShortlistBranch(branch.id)}
                    disabled={branchToggleDisabled}
                  >
                    {branchSelected ? t('roundtable.shortlist_toggle_off') : t('roundtable.shortlist_toggle_on')}
                  </button>
                )}
                <p>{branch.insight}</p>
              </header>
              <div className="worldline-roundtable-picker-branch__options">
                {candidates.map((candidate) => {
                  const selected = selectedRepresentatives[branch.id] === candidate.id;
                  return (
                    <button
                      key={`${branch.id}-${candidate.id}`}
                      type="button"
                      className={`worldline-roundtable-picker-card ${selected ? 'is-selected' : ''}`}
                      disabled={!branchSelected}
                      onClick={() => onSelectRepresentative(branch.id, candidate.id)}
                    >
                      <div className="worldline-roundtable-picker-card__title">
                        <strong>{candidate.name}</strong>
                        {selected && <span>{isZh ? '已选代表' : 'Selected'}</span>}
                      </div>
                      <span>{candidate.role}</span>
                      {candidate.persona && <small>{candidate.persona}</small>}
                      <em>
                        {isZh
                          ? `影响 ${Math.round(candidate.impactScore * 100)} · 发言 ${candidate.contributionCount} 次 · 转折命中 ${candidate.keyMomentHits} · 最近 R${candidate.lastRound}`
                          : `Impact ${Math.round(candidate.impactScore * 100)} · ${candidate.contributionCount} turns · ${candidate.keyMomentHits} hinge hits · latest R${candidate.lastRound}`}
                      </em>
                    </button>
                  );
                })}
              </div>
            </article>
          );
        })}
      </div>

      {showWitnessSection && (
        <section className="worldline-roundtable-picker-witness">
          <div className="worldline-roundtable-card__heading">
            <h3>{selectionMode === 'witness_augmented' ? t('roundtable.witness_augmented_section') : t('roundtable.witness_section')}</h3>
            {selectedWitness && (
              <span className="worldline-roundtable-picker__count">
                {t('roundtable.witness_selected')}
              </span>
            )}
          </div>
          <p className="worldline-roundtable-picker__hint">
            {selectionMode === 'witness_augmented' ? t('roundtable.witness_augmented_hint') : t('roundtable.witness_hint')}
          </p>
          <div className="worldline-roundtable-picker-witness__options">
            {witnessCandidates.map((candidate) => {
              const selected = selectedWitness?.branchId === candidate.branchId && selectedWitness?.agentId === candidate.agentId;
              return (
                <button
                  key={`${candidate.branchId}-${candidate.agentId}`}
                  type="button"
                  className={`worldline-roundtable-picker-card ${selected ? 'is-selected' : ''}`}
                  onClick={() => onSelectWitness({ branchId: candidate.branchId, agentId: candidate.agentId })}
                >
                  <div className="worldline-roundtable-picker-card__title">
                    <strong>{candidate.name}</strong>
                    {selected && <span>{t('roundtable.witness_badge')}</span>}
                  </div>
                  <span>{candidate.branchTitle}</span>
                  <small>{candidate.role}</small>
                  {candidate.persona && <small>{candidate.persona}</small>}
                  <em>{isZh ? `影响 ${Math.round(candidate.impactScore * 100)}` : `Impact ${Math.round(candidate.impactScore * 100)}`}</em>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </section>
  );
}
