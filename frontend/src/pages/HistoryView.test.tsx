import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import HistoryView from './HistoryView';

const { listScenariosMock, setLanguage, getLanguage, translate } = vi.hoisted(() => {
  const listScenariosMock = vi.fn();
  let language = 'en';
  return {
    listScenariosMock,
    setLanguage(next: string) {
      language = next;
    },
    getLanguage() {
      return language;
    },
    translate(key: string) {
      return `${language}:${key}`;
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translate,
    i18n: {
      get language() {
        return getLanguage();
      },
    },
  }),
}));

vi.mock('../api/client', async () => {
  const actual = await import('../api/client');
  return {
    ...actual,
    listScenarios: listScenariosMock,
    deleteScenario: vi.fn(),
  };
});

describe('HistoryView', () => {
  it('reloads localized errors when the translation function changes', async () => {
    listScenariosMock.mockRejectedValue(new ApiError(404, 'SCENARIO_NOT_FOUND', 'missing'));
    setLanguage('en');

    const view = render(
      <MemoryRouter>
        <HistoryView />
      </MemoryRouter>,
    );

    expect(await screen.findByText('en:common.api_errors.scenario_not_found')).toBeInTheDocument();

    setLanguage('zh');
    view.rerender(
      <MemoryRouter>
        <HistoryView />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('zh:common.api_errors.scenario_not_found')).toBeInTheDocument();
    });
  });
});
