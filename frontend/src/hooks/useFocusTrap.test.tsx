import { useRef, useState } from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import useFocusTrap from './useFocusTrap';

function TrapComponent({ active, id }: { active: boolean; id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, active);
  return (
    <div ref={ref} data-testid={`container-${id}`}>
      <button data-testid={`btn-${id}-1`}>First {id}</button>
      <button data-testid={`btn-${id}-2`}>Second {id}</button>
    </div>
  );
}

describe('useFocusTrap', () => {
  it('traps focus inside the active container and wraps around', () => {
    render(<TrapComponent active={true} id="single" />);

    const btn1 = screen.getByTestId('btn-single-1');
    const btn2 = screen.getByTestId('btn-single-2');

    // Focus on first button, press Shift+Tab
    btn1.focus();
    expect(document.activeElement).toBe(btn1);

    const shiftTabEvent = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true });
    fireEvent(btn1, shiftTabEvent);
    expect(document.activeElement).toBe(btn2);

    // Focus on second button, press Tab
    btn2.focus();
    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
    fireEvent(btn2, tabEvent);
    expect(document.activeElement).toBe(btn1);
  });

  it('does not trap focus when active is false', () => {
    render(<TrapComponent active={false} id="inactive" />);

    const btn1 = screen.getByTestId('btn-inactive-1');
    btn1.focus();
    expect(document.activeElement).toBe(btn1);

    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
    const prevented = !fireEvent(btn1, tabEvent);
    expect(prevented).toBe(false); // Should not prevent default
  });

  it('handles nested focus traps by letting only the topmost trap intercept', () => {
    function NestedTraps() {
      const [trap2Active, setTrap2Active] = useState(true);
      return (
        <div>
          <TrapComponent active={true} id="parent" />
          {trap2Active && <TrapComponent active={trap2Active} id="nested" />}
          <button data-testid="close-nested" onClick={() => setTrap2Active(false)}>Close</button>
        </div>
      );
    }

    render(<NestedTraps />);

    const parentBtn1 = screen.getByTestId('btn-parent-1');
    const nestedBtn1 = screen.getByTestId('btn-nested-1');
    const nestedBtn2 = screen.getByTestId('btn-nested-2');
    const closeBtn = screen.getByTestId('close-nested');

    // Start by focusing a parent button
    parentBtn1.focus();

    // Trigger tab on parentBtn1. Since nested trap is active and topmost, it should intercept
    // and force focus to its own first focusable element.
    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
    fireEvent(parentBtn1, tabEvent);
    expect(document.activeElement).toBe(nestedBtn1);

    // Within nested trap, tab wraps around
    nestedBtn2.focus();
    fireEvent(nestedBtn2, tabEvent);
    expect(document.activeElement).toBe(nestedBtn1);

    // Close the nested trap
    closeBtn.focus();
    fireEvent(closeBtn, new MouseEvent('click', { bubbles: true }));

    // Now parent trap is the only active one. Focus parentBtn2 and press Tab, it should wrap to parentBtn1
    const parentBtn2 = screen.getByTestId('btn-parent-2');
    parentBtn2.focus();
    fireEvent(parentBtn2, tabEvent);
    expect(document.activeElement).toBe(parentBtn1);
  });
});
