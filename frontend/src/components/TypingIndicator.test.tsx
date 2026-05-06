import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TypingIndicator } from './TypingIndicator';

describe('TypingIndicator', () => {
  it('renders three dots', () => {
    render(<TypingIndicator />);
    const dots = document.querySelectorAll('.typing-dot');
    expect(dots).toHaveLength(3);
  });

  it('shows agent name when provided', () => {
    render(<TypingIndicator agentName="Oracle" />);
    expect(screen.getByText('Oracle')).toBeInTheDocument();
  });

  it('has aria role status', () => {
    render(<TypingIndicator />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('includes agent name in aria-label', () => {
    render(<TypingIndicator agentName="Oracle" />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Oracle is typing');
  });

  it('uses default aria-label without agent name', () => {
    render(<TypingIndicator />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Agent is typing');
  });

  it('does not render name span when agentName is omitted', () => {
    render(<TypingIndicator />);
    expect(document.querySelector('.typing-indicator-name')).toBeNull();
  });

  it('applies custom className', () => {
    render(<TypingIndicator className="my-custom" />);
    const el = screen.getByRole('status');
    expect(el.className).toContain('my-custom');
  });
});
