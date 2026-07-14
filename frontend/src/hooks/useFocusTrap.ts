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
    if (node.closest('[aria-hidden="true"], [inert]')) return false;
    const style = node.ownerDocument?.defaultView?.getComputedStyle(node);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    return true;
  });
}

const activeTrapsStack: HTMLElement[] = [];

/**
 * Trap Tab/Shift+Tab inside the container while active. On deactivation,
 * restore focus to whichever element was focused at the time the trap turned on.
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(
  containerRef: RefObject<T | null>,
  active: boolean,
  isolateBackground = false,
): void {
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    previouslyFocusedRef.current =
      (container.ownerDocument?.activeElement as HTMLElement | null) ?? null;

    const doc = container.ownerDocument || document;
    const isolatedSiblings: Array<{
      element: HTMLElement;
      inert: boolean;
      ariaHidden: string | null;
    }> = [];

    if (isolateBackground) {
      let current: HTMLElement | null = container;
      while (current?.parentElement && current.parentElement !== doc.body) {
        for (const sibling of Array.from(current.parentElement.children)) {
          if (sibling === current || !(sibling instanceof HTMLElement)) continue;
          isolatedSiblings.push({
            element: sibling,
            inert: sibling.hasAttribute('inert'),
            ariaHidden: sibling.getAttribute('aria-hidden'),
          });
          sibling.setAttribute('inert', '');
          sibling.setAttribute('aria-hidden', 'true');
        }
        current = current.parentElement;
      }
      if (current?.parentElement === doc.body) {
        for (const sibling of Array.from(doc.body.children)) {
          if (sibling === current || !(sibling instanceof HTMLElement)) continue;
          isolatedSiblings.push({
            element: sibling,
            inert: sibling.hasAttribute('inert'),
            ariaHidden: sibling.getAttribute('aria-hidden'),
          });
          sibling.setAttribute('inert', '');
          sibling.setAttribute('aria-hidden', 'true');
        }
      }
    }

    activeTrapsStack.push(container);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (activeTrapsStack[activeTrapsStack.length - 1] !== container) return;
      if (event.key !== 'Tab') return;
      const focusable = getFocusable(container);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = doc.activeElement as HTMLElement | null;

      if (!activeElement || !container.contains(activeElement)) {
        event.preventDefault();
        if (event.shiftKey) {
          last.focus();
        } else {
          first.focus();
        }
        return;
      }

      if (event.shiftKey) {
        if (activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    doc.addEventListener('keydown', handleKeyDown);
    return () => {
      doc.removeEventListener('keydown', handleKeyDown);
      const idx = activeTrapsStack.indexOf(container);
      if (idx !== -1) {
        activeTrapsStack.splice(idx, 1);
      }
      const previous = previouslyFocusedRef.current;
      if (previous && typeof previous.focus === 'function') {
        previous.focus();
      }
      for (const { element, inert, ariaHidden } of isolatedSiblings) {
        if (inert) {
          element.setAttribute('inert', '');
        } else {
          element.removeAttribute('inert');
        }
        if (ariaHidden === null) {
          element.removeAttribute('aria-hidden');
        } else {
          element.setAttribute('aria-hidden', ariaHidden);
        }
      }
      previouslyFocusedRef.current = null;
    };
  }, [active, containerRef, isolateBackground]);
}

export default useFocusTrap;
