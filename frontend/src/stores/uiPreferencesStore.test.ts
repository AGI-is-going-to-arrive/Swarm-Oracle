import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useUIPreferencesStore } from './uiPreferencesStore';

const STORAGE_KEY = 'swarm-ui-preferences';

describe('uiPreferencesStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUIPreferencesStore.setState({ resultViewMode: 'reader' });
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('defaults to reader mode', () => {
    expect(useUIPreferencesStore.getState().resultViewMode).toBe('reader');
  });

  it('updates resultViewMode via setResultViewMode', () => {
    useUIPreferencesStore.getState().setResultViewMode('workbench');
    expect(useUIPreferencesStore.getState().resultViewMode).toBe('workbench');
    useUIPreferencesStore.getState().setResultViewMode('reader');
    expect(useUIPreferencesStore.getState().resultViewMode).toBe('reader');
  });

  it('persists mode changes to localStorage under swarm-ui-preferences', () => {
    useUIPreferencesStore.getState().setResultViewMode('workbench');
    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed.state.resultViewMode).toBe('workbench');
  });

  it('persists transitions back to reader as well', () => {
    useUIPreferencesStore.getState().setResultViewMode('workbench');
    useUIPreferencesStore.getState().setResultViewMode('reader');
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = JSON.parse(raw as string);
    expect(parsed.state.resultViewMode).toBe('reader');
  });
});
