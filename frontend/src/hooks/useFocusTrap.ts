import { type RefObject, useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusable(container: HTMLElement): HTMLElement[] {
  const nodes = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return nodes.filter((node) => {
    if (node.hasAttribute('disabled')) return false;
    if (node.getAttribute('aria-hidden') === 'true') return false;
    const style = node.ownerDocument?.defaultView?.getComputedStyle(node);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    return true;
  });
}

/**
 * Trap Tab/Shift+Tab inside the container while active. On deactivation,
 * restore focus to whichever element was focused at the time the trap turned on.
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(
  containerRef: RefObject<T | null>,
  active: boolean,
): void {
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    previouslyFocusedRef.current =
      (container.ownerDocument?.activeElement as HTMLElement | null) ?? null;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = getFocusable(container);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active2 = container.ownerDocument?.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (active2 === first || !container.contains(active2)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active2 === last || !container.contains(active2)) {
        event.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', handleKeyDown);
    return () => {
      container.removeEventListener('keydown', handleKeyDown);
      const previous = previouslyFocusedRef.current;
      if (previous && typeof previous.focus === 'function') {
        previous.focus();
      }
      previouslyFocusedRef.current = null;
    };
  }, [active, containerRef]);
}

export default useFocusTrap;
