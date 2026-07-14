import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import type { InitialSocialFeedItem } from '../api/client';
import {
  INITIAL_SOCIAL_FEED_MAX_ITEMS,
  INITIAL_SOCIAL_FEED_MAX_TAGS,
  isInitialSocialFeedValid,
} from '../lib/initialSocialFeed';

const emptyItem = (): InitialSocialFeedItem => ({ sourceName: '', content: '' });

interface InitialSocialFeedEditorProps {
  items: InitialSocialFeedItem[];
  onChange: (items: InitialSocialFeedItem[]) => void;
  disabled?: boolean;
}

export function InitialSocialFeedEditor({
  items,
  onChange,
  disabled = false,
}: InitialSocialFeedEditorProps) {
  const { t, i18n } = useTranslation();
  const headingId = useId();
  const hintId = useId();

  const updateItem = (index: number, patch: Partial<InitialSocialFeedItem>) => {
    onChange(items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  };

  const loadExample = () => {
    const isZh = i18n.language.startsWith('zh');
    onChange(isZh ? [
      {
        sourceName: '市防汛指挥部',
        content: '红桥区过去两小时降雨量突破 100 毫米，低洼路段已实施临时交通管制。',
        publishedAt: '2026-07-14T08:10:00+10:00',
        credibilityHint: '官方通报，仍需关注后续更新',
        tags: ['暴雨', '交通'],
      },
      {
        sourceName: '蓝天救援队现场组',
        content: '北岸社区有居民求助转移，当前需要核实积水深度及可通行路线。',
        publishedAt: '2026-07-14T08:25:00+10:00',
        credibilityHint: '现场信息，尚未完成交叉核验',
        tags: ['救援', '待核实'],
      },
      {
        sourceName: '城市交通广播',
        content: '网传跨江大桥封闭消息不实，目前仅东侧匝道暂时关闭。',
        publishedAt: '2026-07-14T08:35:00+10:00',
        credibilityHint: '已向交管部门核实',
        tags: ['辟谣', '交通'],
      },
    ] : [
      {
        sourceName: 'Municipal Flood Control Office',
        content: 'Rainfall in the Riverside District exceeded 100 mm in two hours; temporary traffic controls are active on low-lying roads.',
        publishedAt: '2026-07-14T08:10:00+10:00',
        credibilityHint: 'Official bulletin; monitor for updates',
        tags: ['storm', 'traffic'],
      },
      {
        sourceName: 'Blue Sky Rescue Field Team',
        content: 'Residents in North Shore Community requested evacuation support; water depth and safe access routes still need verification.',
        publishedAt: '2026-07-14T08:25:00+10:00',
        credibilityHint: 'Field report, not yet cross-checked',
        tags: ['rescue', 'unverified'],
      },
      {
        sourceName: 'City Traffic Radio',
        content: 'Online claims that the entire river bridge is closed are false; only the east ramp is temporarily closed.',
        publishedAt: '2026-07-14T08:35:00+10:00',
        credibilityHint: 'Confirmed with traffic authorities',
        tags: ['correction', 'traffic'],
      },
    ]);
  };

  return (
    <section className="initial-feed" aria-labelledby={headingId} aria-describedby={hintId}>
      <div className="initial-feed__header">
        <div>
          <h3 id={headingId}>{t('home.initial_feed_title')}</h3>
          <p id={hintId}>{t('home.initial_feed_hint')}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={loadExample} disabled={disabled}>
          {t('home.initial_feed_example')}
        </button>
      </div>

      <div className="initial-feed__list" aria-live="polite">
        {items.map((item, index) => {
          const prefix = `initial-feed-${index}`;
          const invalid = !isInitialSocialFeedValid([item]);
          return (
            <fieldset className="initial-feed__item" key={index} disabled={disabled}>
              <legend>{t('home.initial_feed_item', { number: index + 1 })}</legend>
              <label htmlFor={`${prefix}-source`}>{t('home.initial_feed_source')}</label>
              <input
                id={`${prefix}-source`}
                className="input"
                value={item.sourceName}
                maxLength={80}
                required
                aria-invalid={item.sourceName.trim() === ''}
                onChange={(event) => updateItem(index, { sourceName: event.target.value })}
              />
              <label htmlFor={`${prefix}-content`}>{t('home.initial_feed_content')}</label>
              <textarea
                id={`${prefix}-content`}
                className="input"
                value={item.content}
                maxLength={1200}
                rows={3}
                required
                aria-invalid={item.content.trim() === ''}
                onChange={(event) => updateItem(index, { content: event.target.value })}
              />
              <div className="initial-feed__optional-grid">
                <label>
                  <span>{t('home.initial_feed_published_at')}</span>
                  <input
                    className="input"
                    type="text"
                    value={item.publishedAt ?? ''}
                    maxLength={64}
                    placeholder={t('home.initial_feed_published_at_placeholder')}
                    aria-invalid={Boolean(item.publishedAt) && !isInitialSocialFeedValid([item])}
                    onChange={(event) => updateItem(index, { publishedAt: event.target.value || undefined })}
                  />
                </label>
                <label>
                  <span>{t('home.initial_feed_credibility')}</span>
                  <input
                    className="input"
                    value={item.credibilityHint ?? ''}
                    maxLength={300}
                    onChange={(event) => updateItem(index, { credibilityHint: event.target.value || undefined })}
                  />
                </label>
                <label className="initial-feed__tags">
                  <span>{t('home.initial_feed_tags')}</span>
                  <input
                    className="input"
                    value={(item.tags ?? []).join(', ')}
                    maxLength={400}
                    placeholder={t('home.initial_feed_tags_placeholder')}
                    onChange={(event) => updateItem(index, {
                      tags: event.target.value
                        .split(',')
                        .map((tag) => tag.trim().slice(0, 40))
                        .filter(Boolean)
                        .slice(0, INITIAL_SOCIAL_FEED_MAX_TAGS),
                    })}
                  />
                </label>
              </div>
              {invalid && <span className="initial-feed__error" role="alert">{t('home.initial_feed_item_invalid')}</span>}
              <button
                type="button"
                className="btn btn-ghost btn-sm initial-feed__remove"
                onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}
              >
                {t('home.initial_feed_remove', { number: index + 1 })}
              </button>
            </fieldset>
          );
        })}
      </div>

      <div className="initial-feed__footer">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => onChange([...items, emptyItem()])}
          disabled={disabled || items.length >= INITIAL_SOCIAL_FEED_MAX_ITEMS}
        >
          {t('home.initial_feed_add')}
        </button>
        <span>{t('home.initial_feed_count', { count: items.length, max: INITIAL_SOCIAL_FEED_MAX_ITEMS })}</span>
      </div>
    </section>
  );
}
