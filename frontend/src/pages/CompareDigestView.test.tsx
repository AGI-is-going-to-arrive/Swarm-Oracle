import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { CompareDigestView } from './CompareDigestView';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | { round?: number; defaultValue?: string }, options?: { round?: number; defaultValue?: string }) => {
      if (key === 'compare.round') {
        return `第 ${options?.round ?? (typeof fallback === 'object' ? fallback.round : '?')} 轮`;
      }
      return ({
        'compare.title': '反事实对比',
        'compare.missing_params': '缺少分支参数',
        'compare.divergence_label': '分歧度',
        'compare.branch_a_label': '分支 A（原始）',
        'compare.branch_b_label': '分支 B（反事实）',
        'compare.no_data': '当前没有可用的对比数据。',
        'common.loading': '加载中…',
        'common.back_to_result': '返回结果页',
      }[key] ?? (typeof fallback === 'string' ? fallback : key));
    },
    i18n: { changeLanguage: vi.fn(), language: 'zh' },
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderView(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/result/:id/compare" element={<CompareDigestView />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CompareDigestView', () => {
  it('renders localized missing-params state', async () => {
    renderView('/result/test-id/compare');
    expect(await screen.findByRole('heading', { name: '反事实对比' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('缺少分支参数');
    expect(screen.getByRole('link', { name: '返回结果页' })).toBeInTheDocument();
  });

  it('renders localized comparison labels', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        scenario_id: 'test-id',
        branch_a: 'a',
        branch_b: 'b',
        rounds: [
          {
            round: 2,
            branch_a_summary: '原始分支摘要',
            branch_b_summary: '反事实分支摘要',
            divergence_score: 0.61,
          },
        ],
      }),
    } as Response);

    renderView('/result/test-id/compare?branch_a=a&branch_b=b');

    expect(await screen.findByRole('heading', { name: '反事实对比' })).toBeInTheDocument();
    expect(screen.getByText('第 2 轮')).toBeInTheDocument();
    expect(screen.getByText('分歧度:')).toBeInTheDocument();
    expect(screen.getByText('分支 A（原始）')).toBeInTheDocument();
    expect(screen.getByText('分支 B（反事实）')).toBeInTheDocument();
  });
});
