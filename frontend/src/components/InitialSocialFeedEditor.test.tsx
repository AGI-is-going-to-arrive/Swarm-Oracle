import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { isInitialSocialFeedValid } from '../lib/initialSocialFeed';
import { InitialSocialFeedEditor } from './InitialSocialFeedEditor';

describe('InitialSocialFeedEditor', () => {
  it('loads a bounded storm rescue example without internal ids', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<InitialSocialFeedEditor items={[]} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Load storm rescue example' }));

    const items = onChange.mock.calls[0][0];
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ sourceName: expect.any(String), content: expect.any(String) });
    expect(items[0]).not.toHaveProperty('id');
    expect(items[0]).not.toHaveProperty('agentId');
  });

  it('requires source and content and rejects more than twenty items', () => {
    expect(isInitialSocialFeedValid([])).toBe(true);
    expect(isInitialSocialFeedValid([{ sourceName: '', content: 'event' }])).toBe(false);
    expect(isInitialSocialFeedValid([{ sourceName: 'source', content: 'event' }])).toBe(true);
    expect(isInitialSocialFeedValid([{
      sourceName: 'source',
      content: 'event',
      publishedAt: '2026-07-14 08:10',
    }])).toBe(false);
    expect(isInitialSocialFeedValid([{
      sourceName: 'source',
      content: 'event',
      publishedAt: '2026-07-14T08:10:00+10:00',
      tags: ['x'.repeat(41)],
    }])).toBe(false);
    expect(isInitialSocialFeedValid(Array.from({ length: 21 }, () => ({
      sourceName: 'source',
      content: 'event',
    })))).toBe(false);
  });

  it('disables adding after twenty items', () => {
    render(
      <InitialSocialFeedEditor
        items={Array.from({ length: 20 }, (_, index) => ({
          sourceName: `source ${index}`,
          content: `event ${index}`,
        }))}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Add event' })).toBeDisabled();
  });
});
