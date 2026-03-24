import type { CreateScenarioOptions } from '../api/client';
import type { ScenarioForkDebugRoundCheck } from '../types';

export type ScenarioRuntimePresetId = 'conservative' | 'balanced' | 'aggressive';

export interface ScenarioRuntimePresetConfig {
  branchSensitivity: number;
  forkPromptVariant: NonNullable<CreateScenarioOptions['forkPromptVariant']>;
  forkDetectorActiveBranchLimit: number;
}

const STORAGE_KEY = 'swarmoracle.runtime-preset.v1';
const DEFAULT_PRESET: ScenarioRuntimePresetId = 'balanced';

const PRESET_CONFIGS: Record<ScenarioRuntimePresetId, ScenarioRuntimePresetConfig> = {
  conservative: {
    branchSensitivity: 0.7,
    forkPromptVariant: 'd',
    forkDetectorActiveBranchLimit: 1,
  },
  balanced: {
    branchSensitivity: 0.7,
    forkPromptVariant: 'b',
    forkDetectorActiveBranchLimit: 1,
  },
  aggressive: {
    branchSensitivity: 0.7,
    forkPromptVariant: 'b',
    forkDetectorActiveBranchLimit: 0,
  },
};

function canUseWindow(): boolean {
  return typeof window !== 'undefined';
}

export function normalizeScenarioRuntimePreset(
  value: string | null | undefined,
): ScenarioRuntimePresetId {
  if (value === 'conservative' || value === 'balanced' || value === 'aggressive') {
    return value;
  }
  return DEFAULT_PRESET;
}

export function getScenarioRuntimePresetConfig(
  preset: ScenarioRuntimePresetId,
): ScenarioRuntimePresetConfig {
  return PRESET_CONFIGS[preset];
}

export function buildScenarioRuntimePresetOptions(
  preset: ScenarioRuntimePresetId,
): Pick<CreateScenarioOptions, 'branchSensitivity' | 'forkPromptVariant' | 'forkDetectorActiveBranchLimit'> {
  const config = getScenarioRuntimePresetConfig(preset);
  return {
    branchSensitivity: config.branchSensitivity,
    forkPromptVariant: config.forkPromptVariant,
    forkDetectorActiveBranchLimit: config.forkDetectorActiveBranchLimit,
  };
}

export function loadScenarioRuntimePreset(): ScenarioRuntimePresetId {
  if (!canUseWindow()) return DEFAULT_PRESET;
  try {
    return normalizeScenarioRuntimePreset(window.sessionStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_PRESET;
  }
}

export function saveScenarioRuntimePreset(
  preset: ScenarioRuntimePresetId,
): void {
  if (!canUseWindow()) return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, preset);
  } catch {
    // Ignore storage failures and keep the current in-memory selection.
  }
}

export function matchScenarioRuntimePreset(
  roundChecks: ScenarioForkDebugRoundCheck[] | null | undefined,
): ScenarioRuntimePresetId | null {
  const observed = roundChecks?.find((entry) => (
    typeof entry.sensitivity === 'number'
    && typeof entry.prompt_variant === 'string'
    && typeof entry.fork_detector_active_branch_limit === 'number'
  ));

  if (!observed) return null;

  return (Object.entries(PRESET_CONFIGS) as Array<[ScenarioRuntimePresetId, ScenarioRuntimePresetConfig]>)
    .find(([, preset]) => (
      preset.branchSensitivity === observed.sensitivity
      && preset.forkPromptVariant === observed.prompt_variant
      && preset.forkDetectorActiveBranchLimit === observed.fork_detector_active_branch_limit
    ))?.[0] ?? null;
}

export function resolveScenarioRuntimePreset(
  roundChecks: ScenarioForkDebugRoundCheck[] | null | undefined,
  fallbackPreset = DEFAULT_PRESET,
): ScenarioRuntimePresetId {
  return matchScenarioRuntimePreset(roundChecks) ?? fallbackPreset;
}
