import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { BadgeCabinet, type BadgeDefinition } from './BadgeCabinet';

const I18N_FIXTURES: Record<string, string> = {
  'campaign.badge_locked': 'Locked',
  'campaign.badge_unlocked': 'Unlocked',
  'campaign.badge_cabinet_title': 'Badge Collection',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key in I18N_FIXTURES) {
        return I18N_FIXTURES[key];
      }
      if (opts && typeof opts === 'object') {
        const { defaultValue, ...vars } = opts as { defaultValue?: string; [k: string]: unknown };
        let resolved = key;
        if (vars && Object.keys(vars).length > 0) {
          resolved = defaultValue ?? key;
          for (const [name, value] of Object.entries(vars)) {
            resolved = resolved.replace(`{{${name}}}`, String(value));
          }
        }
        return resolved;
      }
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

const definitions: BadgeDefinition[] = [
  {
    id: 'first_daily',
    name_key: 'badge.first_daily.name',
    description_key: 'badge.first_daily.description',
    category: 'daily',
  },
  {
    id: 'streak_7',
    name_key: 'badge.streak_7.name',
    description_key: 'badge.streak_7.description',
    category: 'streak',
  },
  {
    id: 'archive_s',
    name_key: 'badge.archive_s.name',
    description_key: 'badge.archive_s.description',
    category: 'archive',
  },
];

describe('BadgeCabinet', () => {
  it('renders cabinet title', () => {
    render(<BadgeCabinet definitions={definitions} unlockedIds={[]} />);
    expect(screen.getByText('Badge Collection')).toBeInTheDocument();
  });

  it('renders one card per definition', () => {
    render(<BadgeCabinet definitions={definitions} unlockedIds={[]} />);
    const cards = screen.getAllByRole('listitem');
    expect(cards).toHaveLength(3);
  });

  it('marks unlocked badges with unlocked label and check icon', () => {
    render(<BadgeCabinet definitions={definitions} unlockedIds={['streak_7']} />);
    const unlockedCard = screen.getByRole('listitem', {
      name: /badge\.streak_7\.name.*Unlocked/,
    });
    expect(unlockedCard).toBeInTheDocument();
    expect(unlockedCard.className).toContain('badge-cabinet__card--unlocked');
    expect(unlockedCard.textContent).toContain('✓');
    expect(unlockedCard).toHaveAccessibleDescription('badge.streak_7.description');
  });

  it('marks locked badges with locked label and lock icon', () => {
    render(<BadgeCabinet definitions={definitions} unlockedIds={[]} />);
    const lockedCard = screen.getByRole('listitem', {
      name: /badge\.first_daily\.name.*Locked/,
    });
    expect(lockedCard).toBeInTheDocument();
    expect(lockedCard.className).toContain('badge-cabinet__card--locked');
    expect(lockedCard.textContent).toContain('🔒');
  });

  it('renders skeleton placeholders when loading', () => {
    const { container } = render(
      <BadgeCabinet definitions={definitions} unlockedIds={[]} loading />,
    );
    expect(container.querySelectorAll('.badge-cabinet__skeleton')).toHaveLength(6);
    expect(screen.queryByRole('listitem')).toBeNull();
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('renders nothing in grid when definitions empty (non-loading)', () => {
    const { container } = render(<BadgeCabinet definitions={[]} unlockedIds={[]} />);
    expect(container.querySelectorAll('.badge-cabinet__card')).toHaveLength(0);
  });

  it('uses i18n keys for name and description', () => {
    render(<BadgeCabinet definitions={definitions} unlockedIds={['first_daily']} />);
    expect(screen.getByText('badge.first_daily.name')).toBeInTheDocument();
    expect(screen.getByText('badge.first_daily.description')).toBeInTheDocument();
  });
});
