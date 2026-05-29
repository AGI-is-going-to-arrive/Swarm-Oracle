import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FormatSelector } from './FormatSelector';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'roundtable.format_deep_dive': 'Deep Dive',
        'roundtable.format_quick_review': 'Quick Review',
        'roundtable.format_clash_mode': 'Clash Mode',
        'roundtable.cast_smart_pick': 'Auto Cast',
        'roundtable.cast_custom': 'Custom Cast',
        'roundtable.format_selector_label': 'Discussion format',
        'roundtable.format_label': 'Format',
        'roundtable.cast_label': 'Cast mode',
      };
      return map[key] ?? key;
    },
  }),
}));

describe('FormatSelector', () => {
  const baseProps = {
    discussionFormat: 'deep_dive' as const,
    castMode: 'smart_pick' as const,
    onFormatChange: vi.fn(),
    onCastModeChange: vi.fn(),
  };

  it('renders all 3 format options (deep_dive, quick_review, clash_mode)', () => {
    render(<FormatSelector {...baseProps} />);
    expect(screen.getByText('Deep Dive')).toBeInTheDocument();
    expect(screen.getByText('Quick Review')).toBeInTheDocument();
    expect(screen.getByText('Clash Mode')).toBeInTheDocument();
  });

  it('renders both cast mode options (smart_pick, custom)', () => {
    render(<FormatSelector {...baseProps} />);
    expect(screen.getByText('Auto Cast')).toBeInTheDocument();
    expect(screen.getByText('Custom Cast')).toBeInTheDocument();
  });

  it('calls onFormatChange when a format radio is clicked', () => {
    const onFormatChange = vi.fn();
    render(<FormatSelector {...baseProps} onFormatChange={onFormatChange} />);
    const quickReviewRadio = screen.getByRole('radio', { name: 'Quick Review' });
    fireEvent.click(quickReviewRadio);
    expect(onFormatChange).toHaveBeenCalledWith('quick_review');
  });

  it('calls onCastModeChange when a cast radio is clicked', () => {
    const onCastModeChange = vi.fn();
    render(<FormatSelector {...baseProps} onCastModeChange={onCastModeChange} />);
    const customRadio = screen.getByRole('radio', { name: 'Custom Cast' });
    fireEvent.click(customRadio);
    expect(onCastModeChange).toHaveBeenCalledWith('custom');
  });

  it('shows active state for selected format', () => {
    const { container } = render(
      <FormatSelector {...baseProps} discussionFormat="clash_mode" />,
    );
    const activeLabel = container.querySelector('.roundtable-format-option--active');
    expect(activeLabel).not.toBeNull();
    expect(activeLabel?.textContent).toContain('Clash Mode');

    const activeRadio = screen.getByRole('radio', { name: 'Clash Mode' }) as HTMLInputElement;
    expect(activeRadio.checked).toBe(true);
    const inactiveRadio = screen.getByRole('radio', { name: 'Deep Dive' }) as HTMLInputElement;
    expect(inactiveRadio.checked).toBe(false);
  });

  it('disables inputs when disabled prop is true', () => {
    render(<FormatSelector {...baseProps} disabled />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(5);
    radios.forEach(radio => {
      expect(radio).toBeDisabled();
    });
  });

  it('has accessible fieldset/legend structure', () => {
    const { container } = render(<FormatSelector {...baseProps} />);
    const group = screen.getByRole('group', { name: 'Discussion format' });
    expect(group).toBeInTheDocument();

    const fieldsets = container.querySelectorAll('fieldset');
    expect(fieldsets).toHaveLength(2);

    const legends = container.querySelectorAll('legend');
    expect(legends).toHaveLength(2);
    expect(legends[0].textContent).toBe('Format');
    expect(legends[1].textContent).toBe('Cast mode');

    legends.forEach(legend => {
      expect(legend.classList.contains('sr-only')).toBe(true);
    });
  });
});
