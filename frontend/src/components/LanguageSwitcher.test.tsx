import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const changeLanguageMock = vi.fn();
let currentLanguage = 'en';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: {
      get language() {
        return currentLanguage;
      },
      changeLanguage: changeLanguageMock,
    },
  }),
}));

import { LanguageSwitcher } from './LanguageSwitcher';

describe('LanguageSwitcher', () => {
  it('exposes localized button labels and pressed state', () => {
    currentLanguage = 'en';
    render(<LanguageSwitcher />);

    expect(screen.getByRole('group', { name: 'Language switcher' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'EN Switch language to English' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '中文 Switch language to Chinese' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls i18n.changeLanguage when a language is selected', async () => {
    currentLanguage = 'en';
    const user = userEvent.setup();
    render(<LanguageSwitcher />);

    await user.click(screen.getByRole('button', { name: '中文 Switch language to Chinese' }));

    expect(changeLanguageMock).toHaveBeenCalledWith('zh');
  });

  it('keeps the visible label text inside each accessible name', () => {
    currentLanguage = 'en';
    render(<LanguageSwitcher />);

    expect(screen.getByRole('button', { name: /EN/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /中文/i })).toBeInTheDocument();
  });
});
