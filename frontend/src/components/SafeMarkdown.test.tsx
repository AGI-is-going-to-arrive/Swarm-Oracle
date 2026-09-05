import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { SafeMarkdown } from './SafeMarkdown';
import { setSupportsLookbehindForTest } from '../lib/markdownCompat';

describe('SafeMarkdown', () => {
  afterEach(() => {
    setSupportsLookbehindForTest(null);
    vi.doUnmock('remark-gfm');
  });

  it('renders GFM tables after loading remark-gfm', async () => {
    const md = '| 列A | 列B |\n| --- | --- |\n| 单元1 | 单元2 |';
    const { container } = render(<SafeMarkdown>{md}</SafeMarkdown>);
    await waitFor(() => expect(container.querySelector('table')).not.toBeNull());
    expect(container.querySelectorAll('th').length).toBe(2);
    expect(container.querySelectorAll('td').length).toBe(2);
    expect(container.textContent).toContain('列A');
    expect(container.textContent).toContain('单元2');
  });

  it('renders GFM strikethrough', async () => {
    const { container } = render(<SafeMarkdown>{'~~删除线~~'}</SafeMarkdown>);
    await waitFor(() => expect(container.querySelector('del')).not.toBeNull());
  });

  it('renders plain text without a table when no table syntax is present', () => {
    const { container } = render(<SafeMarkdown>{'普通段落文本'}</SafeMarkdown>);
    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).toContain('普通段落文本');
  });

  it('still strips disallowed img elements', () => {
    const { container } = render(<SafeMarkdown>{'![alt](http://example.com/x.png)'}</SafeMarkdown>);
    expect(container.querySelector('img')).toBeNull();
  });

  it('does not import remark-gfm when lookbehind is unsupported', () => {
    const loadGfm = vi.fn(() => {
      throw new SyntaxError('Lookbehind is unsupported');
    });
    vi.doMock('remark-gfm', loadGfm);
    setSupportsLookbehindForTest(false);
    const md = '| 列A | 列B |\n| --- | --- |\n| 单元1 | 单元2 |';
    const { container } = render(<SafeMarkdown>{md}</SafeMarkdown>);
    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).toContain('列A');
    expect(loadGfm).not.toHaveBeenCalled();
  });

  it('keeps safe plain Markdown readable when the GFM chunk fails to load', async () => {
    const loadGfm = vi.fn(() => {
      throw new TypeError('Failed to fetch dynamically imported module');
    });
    vi.doMock('remark-gfm', loadGfm);
    setSupportsLookbehindForTest(true);
    const { container } = render(
      <SafeMarkdown>{'**Readable** ~~text~~\n\n![image](https://example.com/a.png)\n\n<script>alert(1)</script>'}</SafeMarkdown>,
    );

    await waitFor(() => expect(loadGfm).toHaveBeenCalledOnce());
    expect(container.querySelector('strong')).toHaveTextContent('Readable');
    expect(container.querySelector('del')).toBeNull();
    expect(container.querySelector('script, img')).toBeNull();
  });

  it.each([true, false])('blocks unsafe content with lookbehind support %s', async (supported) => {
    setSupportsLookbehindForTest(supported);
    const { container } = render(
      <SafeMarkdown>{'~~ready~~\n\n[unsafe](javascript:alert%281%29)\n\n![image](https://example.com/a.png)\n\n<img src="x" onerror="alert(1)"><script>alert(1)</script>'}</SafeMarkdown>,
    );
    if (supported) {
      await waitFor(() => expect(container.querySelector('del')).not.toBeNull());
    }

    expect(container.querySelector('script, img, [onerror]')).toBeNull();
    const unsafeLink = container.querySelector('a');
    expect(unsafeLink).toHaveTextContent('unsafe');
    expect(unsafeLink).not.toHaveAttribute('href');
  });
});
