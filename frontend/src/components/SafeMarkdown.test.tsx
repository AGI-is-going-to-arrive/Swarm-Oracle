import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SafeMarkdown } from './SafeMarkdown';

describe('SafeMarkdown', () => {
  it('renders GFM tables via remark-gfm', () => {
    const md = '| 列A | 列B |\n| --- | --- |\n| 单元1 | 单元2 |';
    const { container } = render(<SafeMarkdown>{md}</SafeMarkdown>);
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelectorAll('th').length).toBe(2);
    expect(container.querySelectorAll('td').length).toBe(2);
    expect(container.textContent).toContain('列A');
    expect(container.textContent).toContain('单元2');
  });

  it('renders GFM strikethrough', () => {
    const { container } = render(<SafeMarkdown>{'~~删除线~~'}</SafeMarkdown>);
    expect(container.querySelector('del')).not.toBeNull();
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
});
