import { useRef, useState } from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

function TrapWithHiddenDescendant({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, active);
  return (
    <div ref={ref}>
      <button data-testid="visible-first">First</button>
      <button data-testid="visible-last">Last</button>
      <div aria-hidden="true" inert={true}>
        <select data-testid="hidden-select">
          <option value="hidden">Hidden</option>
        </select>
      </div>
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

  it('ignores focusable descendants inside aria-hidden or inert ancestors', () => {
    render(<TrapWithHiddenDescendant active={true} />);

    const first = screen.getByTestId('visible-first');
    const last = screen.getByTestId('visible-last');

    last.focus();
    fireEvent(last, new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

    expect(document.activeElement).toBe(first);
  });

  it('optionally makes background siblings inert and restores their prior state', () => {
    function IsolatedTrap({ active }: { active: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref, active, true);
      return (
        <div>
          <main data-testid="background">Background</main>
          <div ref={ref}><button type="button">Inside</button></div>
        </div>
      );
    }

    const { rerender } = render(<IsolatedTrap active />);
    const background = screen.getByTestId('background');
    expect(background).toHaveAttribute('inert');
    expect(background).toHaveAttribute('aria-hidden', 'true');

    rerender(<IsolatedTrap active={false} />);
    expect(background).not.toHaveAttribute('inert');
    expect(background).not.toHaveAttribute('aria-hidden');
  });

  it('removes background isolation before restoring focus to the opener', () => {
    function IsolatedTrap({ active }: { active: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref, active, true);
      return (
        <div>
          <main><button data-testid="opener">Open</button></main>
          <div ref={ref}><button data-testid="inside">Inside</button></div>
        </div>
      );
    }
    const { rerender } = render(<IsolatedTrap active={false} />);
    const opener = screen.getByTestId('opener');
    opener.focus();
    // jsdom does not implement inert focus blocking, so emulate the browser boundary.
    const restoreFocus = vi.spyOn(opener, 'focus').mockImplementation((options) => {
      if (opener.closest('[inert], [aria-hidden="true"]')) return;
      HTMLElement.prototype.focus.call(opener, options);
    });
    rerender(<IsolatedTrap active />);
    screen.getByTestId('inside').focus();
    expect(opener.closest('[inert]')).not.toBeNull();
    rerender(<IsolatedTrap active={false} />);
    expect(opener).toHaveFocus();
    restoreFocus.mockRestore();
  });

  it('returns focus to the remaining trap when a nested opener was removed', () => {
    function RemainingTrap({ nested }: { nested: boolean }) {
      const parentRef = useRef<HTMLDivElement>(null);
      useFocusTrap(parentRef, true);
      return (
        <div ref={parentRef}>
          <button data-testid="parent-fallback">Parent fallback</button>
          {!nested && <button data-testid="removed-opener">Open nested</button>}
          {nested && <TrapComponent active id="child" />}
        </div>
      );
    }
    const { rerender } = render(<RemainingTrap nested={false} />);
    screen.getByTestId('removed-opener').focus();
    rerender(<RemainingTrap nested />);
    screen.getByTestId('btn-child-1').focus();
    rerender(<RemainingTrap nested={false} />);
    expect(screen.getByTestId('parent-fallback')).toHaveFocus();
  });
});
