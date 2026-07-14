import { afterEach, describe, expect, it, vi } from 'vitest';

import { createScenario } from './client';

describe('createScenario initial social feed', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends only public feed fields in snake case', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ id: 'scenario-1', status: 'pending' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    await createScenario({
      question: 'storm response',
      initialSocialFeed: [{
        sourceName: 'Flood office',
        content: 'Road closed',
        publishedAt: '2026-07-14T08:10:00+10:00',
        credibilityHint: 'official',
        tags: ['storm'],
      }],
    });

    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(body.initial_social_feed).toEqual([{
      source_name: 'Flood office',
      content: 'Road closed',
      published_at: '2026-07-14T08:10:00+10:00',
      credibility_hint: 'official',
      tags: ['storm'],
    }]);
    expect(body.initial_social_feed[0]).not.toHaveProperty('id');
  });

  it('omits an empty feed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ id: 'scenario-1', status: 'pending' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    await createScenario({ question: 'empty feed', initialSocialFeed: [] });
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(body).not.toHaveProperty('initial_social_feed');
  });
});
