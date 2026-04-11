import { useEffect, useMemo, useState } from 'react';
import {
  type Active,
  type DragEndEvent,
  type DragStartEvent,
  type Over,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
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

type DragRole = 'representative' | 'witness';

interface DragCardPayload {
  role: DragRole;
  branchId: string;
  agentId: string;
  name: string;
  roleLabel: string;
  branchTitle?: string;
  persona?: string;
}

interface SlotPayload {
  role: DragRole;
  branchId?: string;
  title: string;
}

type SlotState = 'idle' | 'available' | 'over-valid' | 'over-invalid';

function buildRepresentativeDragId(branchId: string, agentId: string) {
  return `drag-rep-${branchId}-${agentId}`;
}

function buildWitnessDragId(branchId: string, agentId: string) {
  return `drag-wit-${branchId}-${agentId}`;
}

function buildRepresentativeSlotId(branchId: string) {
  return `slot-rep-${branchId}`;
}

function isValidSlotForDrag(slot: SlotPayload, drag: DragCardPayload | null) {
  if (!drag) return false;
  if (slot.role !== drag.role) return false;
  if (slot.role === 'representative') {
    return slot.branchId === drag.branchId;
  }
  return true;
}

function getSlotState(slot: SlotPayload, drag: DragCardPayload | null, overId: string | null, slotId: string): SlotState {
  if (!drag) return 'idle';
  const valid = isValidSlotForDrag(slot, drag);
  if (overId === slotId) {
    return valid ? 'over-valid' : 'over-invalid';
  }
  return valid ? 'available' : 'idle';
}

function getActiveDragPayload(active: Active | null): DragCardPayload | null {
  const payload = active?.data.current;
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const candidate = payload as Partial<DragCardPayload>;
  if (
    (candidate.role === 'representative' || candidate.role === 'witness')
    && typeof candidate.branchId === 'string'
    && typeof candidate.agentId === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.roleLabel === 'string'
  ) {
    return candidate as DragCardPayload;
  }
  return null;
}

function getOverId(over: Over | null) {
  return over?.id ? String(over.id) : null;
}

function PickerCardFrame({
  payload,
  selectedLabel,
}: {
  payload: DragCardPayload;
  selectedLabel?: string | null;
}) {
  return (
    <>
      <div className="worldline-roundtable-picker-card__title">
        <strong>{payload.name}</strong>
        {selectedLabel && <span>{selectedLabel}</span>}
      </div>
      <span>{payload.roleLabel}</span>
      {payload.persona && <small>{payload.persona}</small>}
      {payload.branchTitle && <em>{payload.branchTitle}</em>}
    </>
  );
}

function DraggablePickerCard({
  id,
  payload,
  selected,
  disabled,
  dragEnabled,
  onClick,
  selectedLabel,
}: {
  id: string;
  payload: DragCardPayload;
  selected: boolean;
  disabled: boolean;
  dragEnabled: boolean;
  onClick: () => void;
  selectedLabel: string;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging,
  } = useDraggable({
    id,
    disabled: disabled || !dragEnabled,
    data: payload,
  });

  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`worldline-roundtable-picker-card ${selected ? 'is-selected' : ''} ${isDragging ? 'is-dragging' : ''}`}
      disabled={disabled}
      onClick={onClick}
      style={transform ? { transform: CSS.Translate.toString(transform) } : undefined}
      {...attributes}
      {...listeners}
    >
      <PickerCardFrame
        payload={payload}
        selectedLabel={selected ? selectedLabel : null}
      />
    </button>
  );
}

function DroppableSeat({
  id,
  payload,
  state,
  occupant,
  emptyLabel,
  occupiedLabel,
  testId,
}: {
  id: string;
  payload: SlotPayload;
  state: SlotState;
  occupant: DragCardPayload | null;
  emptyLabel: string;
  occupiedLabel: string;
  testId: string;
}) {
  const { setNodeRef } = useDroppable({
    id,
    data: payload,
  });

  return (
    <div
      ref={setNodeRef}
      className={`worldline-roundtable-seating-slot worldline-roundtable-seating-slot--${state}`}
      aria-label={payload.title}
      data-testid={testId}
    >
      <div className="worldline-roundtable-seating-slot__eyebrow">{payload.title}</div>
      {occupant ? (
        <div className="worldline-roundtable-seating-slot__occupant">
          <strong>{occupant.name}</strong>
          <span>{occupant.roleLabel}</span>
          <small>{occupiedLabel}</small>
        </div>
      ) : (
        <div className="worldline-roundtable-seating-slot__empty">
          <strong>{emptyLabel}</strong>
        </div>
      )}
    </div>
  );
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
  const [activeDrag, setActiveDrag] = useState<DragCardPayload | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [dragEnabled, setDragEnabled] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return true;
    }
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const mediaQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
    const handleChange = (event: MediaQueryListEvent) => {
      setDragEnabled(event.matches);
    };
    setDragEnabled(mediaQuery.matches);
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }
    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: { distance: 5 },
  });
  const keyboardSensor = useSensor(KeyboardSensor);
  const sensors = useSensors(
    ...(dragEnabled ? [pointerSensor] : []),
    keyboardSensor,
  );

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
  const selectedLabel = isZh ? '已选' : 'Selected';
  const seatingHeading = isZh ? '圆桌席位' : 'Seating board';
  const seatingHint = dragEnabled
    ? (isZh ? '拖动候选人入席。移动端保留点击上桌。' : 'Drag candidates into seats. Mobile keeps tap-to-seat.')
    : (isZh ? '当前设备保留点击上桌。' : 'Tap-to-seat is active on this device.');
  const emptyRepresentativeLabel = isZh ? '拖到这里入席' : 'Drop here to seat';
  const emptyWitnessLabel = isZh ? '拖到这里上证人席' : 'Drop here to seat a witness';
  const occupiedLabel = isZh ? '当前入席' : 'Currently seated';

  const selectedWitnessPayload = useMemo(() => {
    if (!selectedWitness) return null;
    const match = witnessCandidates.find((candidate) => (
      candidate.branchId === selectedWitness.branchId
      && candidate.agentId === selectedWitness.agentId
    ));
    if (!match) return null;
    return {
      role: 'witness',
      branchId: match.branchId,
      agentId: match.agentId,
      name: match.name,
      roleLabel: match.role,
      branchTitle: match.branchTitle,
      persona: match.persona,
    } satisfies DragCardPayload;
  }, [selectedWitness, witnessCandidates]);

  const branchSeatPayloads = useMemo(() => selectedBranchIdsForLaunch.map((branchId) => {
    const branch = branches.find((item) => item.id === branchId);
    const selectedAgentId = selectedRepresentatives[branchId];
    const selectedCandidate = (branchCandidates[branchId] ?? []).find((candidate) => candidate.id === selectedAgentId);
    return {
      branchId,
      title: branch?.title ?? branchId,
      occupant: selectedCandidate
        ? {
            role: 'representative' as const,
            branchId,
            agentId: selectedCandidate.id,
            name: selectedCandidate.name,
            roleLabel: selectedCandidate.role,
            persona: selectedCandidate.persona,
          }
        : null,
    };
  }), [branchCandidates, branches, selectedBranchIdsForLaunch, selectedRepresentatives]);

  const announcements = useMemo(() => ({
    onDragStart({ active }: { active: Active }) {
      const payload = getActiveDragPayload(active);
      if (!payload) return undefined;
      return isZh
        ? `已拿起 ${payload.name}，使用方向键寻找空位。`
        : `Picked up ${payload.name}.`;
    },
    onDragOver({ active, over }: { active: Active; over: Over | null }) {
      const payload = getActiveDragPayload(active);
      if (!payload || !over) {
        return isZh ? '当前不在任何有效席位上。' : 'Not over a valid seat.';
      }
      const slotPayload = over.data.current as SlotPayload | undefined;
      if (!slotPayload || !isValidSlotForDrag(slotPayload, payload)) {
        return isZh ? '当前不在任何有效席位上。' : 'Not over a valid seat.';
      }
      return isZh
        ? `移动到了 ${slotPayload.title} 的席位上。`
        : `Moved over ${slotPayload.title} seat.`;
    },
    onDragEnd({ active, over }: { active: Active; over: Over | null }) {
      const payload = getActiveDragPayload(active);
      if (!payload || !over) {
        return isZh ? '取消放置。' : 'Drop cancelled.';
      }
      const slotPayload = over.data.current as SlotPayload | undefined;
      if (!slotPayload || !isValidSlotForDrag(slotPayload, payload)) {
        return isZh
          ? `取消放置，${payload.name} 已退回备选池。`
          : 'Drop cancelled.';
      }
      return isZh
        ? `${payload.name} 已成功入席。`
        : `${payload.name} seated successfully.`;
    },
    onDragCancel() {
      return isZh ? '取消放置。' : 'Drop cancelled.';
    },
  }), [isZh]);

  const handleDragStart = ({ active }: DragStartEvent) => {
    setActiveDrag(getActiveDragPayload(active));
    setOverId(null);
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    const payload = getActiveDragPayload(active);
    const targetId = getOverId(over);
    if (payload && targetId) {
      if (payload.role === 'representative' && targetId === buildRepresentativeSlotId(payload.branchId)) {
        onSelectRepresentative(payload.branchId, payload.agentId);
      }
      if (payload.role === 'witness' && targetId === 'slot-witness') {
        onSelectWitness({ branchId: payload.branchId, agentId: payload.agentId });
      }
    }
    setActiveDrag(null);
    setOverId(null);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      accessibility={{ announcements }}
      onDragStart={handleDragStart}
      onDragOver={({ over }) => setOverId(getOverId(over))}
      onDragCancel={() => {
        setActiveDrag(null);
        setOverId(null);
      }}
      onDragEnd={handleDragEnd}
    >
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

      <section className="worldline-roundtable-seating" data-testid="roundtable-seating-board">
        <div className="worldline-roundtable-card__heading">
          <h3>{seatingHeading}</h3>
          <span className="worldline-roundtable-picker__count">{seatingHint}</span>
        </div>
        <div className="worldline-roundtable-seating__grid">
          {branchSeatPayloads.map((seat) => {
            const slotId = buildRepresentativeSlotId(seat.branchId);
            const slotPayload: SlotPayload = {
              role: 'representative',
              branchId: seat.branchId,
              title: seat.title,
            };
            return (
              <DroppableSeat
                key={slotId}
                id={slotId}
                payload={slotPayload}
                state={getSlotState(slotPayload, activeDrag, overId, slotId)}
                occupant={seat.occupant}
                emptyLabel={emptyRepresentativeLabel}
                occupiedLabel={occupiedLabel}
                testId={`roundtable-seat-slot-${seat.branchId}`}
              />
            );
          })}
          {showWitnessSection && (
            <DroppableSeat
              id="slot-witness"
              payload={{
                role: 'witness',
                title: selectionMode === 'witness_augmented'
                  ? t('roundtable.witness_augmented_section')
                  : t('roundtable.witness_section'),
              }}
              state={getSlotState({
                role: 'witness',
                title: selectionMode === 'witness_augmented'
                  ? t('roundtable.witness_augmented_section')
                  : t('roundtable.witness_section'),
              }, activeDrag, overId, 'slot-witness')}
              occupant={selectedWitnessPayload}
              emptyLabel={emptyWitnessLabel}
              occupiedLabel={occupiedLabel}
              testId="roundtable-seat-slot-witness"
            />
          )}
        </div>
      </section>

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
                  const payload: DragCardPayload = {
                    role: 'representative',
                    branchId: branch.id,
                    agentId: candidate.id,
                    name: candidate.name,
                    roleLabel: candidate.role,
                    persona: candidate.persona,
                  };
                  return (
                    <DraggablePickerCard
                      key={`${branch.id}-${candidate.id}`}
                      id={buildRepresentativeDragId(branch.id, candidate.id)}
                      payload={{
                        ...payload,
                        branchTitle: isZh
                          ? `影响 ${Math.round(candidate.impactScore * 100)} · 发言 ${candidate.contributionCount} 次 · 转折命中 ${candidate.keyMomentHits} · 最近 R${candidate.lastRound}`
                          : `Impact ${Math.round(candidate.impactScore * 100)} · ${candidate.contributionCount} turns · ${candidate.keyMomentHits} hinge hits · latest R${candidate.lastRound}`,
                      }}
                      selected={selected}
                      disabled={!branchSelected || selected}
                      dragEnabled={dragEnabled}
                      onClick={() => onSelectRepresentative(branch.id, candidate.id)}
                      selectedLabel={selectedLabel}
                    />
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
              const payload: DragCardPayload = {
                role: 'witness',
                branchId: candidate.branchId,
                agentId: candidate.agentId,
                name: candidate.name,
                roleLabel: candidate.role,
                branchTitle: candidate.branchTitle,
                persona: candidate.persona,
              };
              return (
                <DraggablePickerCard
                  key={`${candidate.branchId}-${candidate.agentId}`}
                  id={buildWitnessDragId(candidate.branchId, candidate.agentId)}
                  payload={{
                    ...payload,
                    branchTitle: isZh ? `影响 ${Math.round(candidate.impactScore * 100)}` : `Impact ${Math.round(candidate.impactScore * 100)}`,
                  }}
                  selected={selected}
                  disabled={selected}
                  dragEnabled={dragEnabled}
                  onClick={() => onSelectWitness({ branchId: candidate.branchId, agentId: candidate.agentId })}
                  selectedLabel={t('roundtable.witness_badge')}
                />
              );
            })}
          </div>
        </section>
      )}
      </section>
      <DragOverlay>
        {activeDrag ? (
          <div className="worldline-roundtable-picker-card worldline-roundtable-picker-card--overlay">
            <PickerCardFrame payload={activeDrag} selectedLabel={null} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
