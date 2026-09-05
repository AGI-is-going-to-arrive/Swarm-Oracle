import { type RefObject, useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');
const FOCUS_TRAP_EXEMPT_SELECTOR = '[data-focus-trap-exempt="true"]';

function isFocusable(node: HTMLElement): boolean {
    if (node.hasAttribute('disabled')) return false;
    if (node.getAttribute('aria-hidden') === 'true') return false;
    if (node.closest('[aria-hidden="true"], [inert]')) return false;
    const style = node.ownerDocument?.defaultView?.getComputedStyle(node);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    return true;
}

function getFocusable(container: HTMLElement, doc: Document): HTMLElement[] {
  const localNodes = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(isFocusable);
  const exemptNodes = Array.from(doc.querySelectorAll<HTMLElement>(FOCUS_TRAP_EXEMPT_SELECTOR))
    .filter((node) => !container.contains(node))
    .filter((node) => node.matches(FOCUSABLE_SELECTOR))
    .filter(isFocusable);
  return [...localNodes, ...exemptNodes];
}

function containsFocusTrapExemption(element: HTMLElement): boolean {
  return element.matches(FOCUS_TRAP_EXEMPT_SELECTOR)
    || element.querySelector(FOCUS_TRAP_EXEMPT_SELECTOR) !== null;
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
          if (containsFocusTrapExemption(sibling)) continue;
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
          if (containsFocusTrapExemption(sibling)) continue;
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
      const focusable = getFocusable(container, doc);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const activeElement = doc.activeElement as HTMLElement | null;
      const activeIndex = activeElement ? focusable.indexOf(activeElement) : -1;

      event.preventDefault();
      if (activeIndex === -1) {
        const target = event.shiftKey ? focusable[focusable.length - 1] : focusable[0];
        target.focus();
        return;
      }

      const direction = event.shiftKey ? -1 : 1;
      const nextIndex = (activeIndex + direction + focusable.length) % focusable.length;
      focusable[nextIndex].focus();
    };

    doc.addEventListener('keydown', handleKeyDown);
    return () => {
      doc.removeEventListener('keydown', handleKeyDown);
      const wasTopmost = activeTrapsStack[activeTrapsStack.length - 1] === container;
      const idx = activeTrapsStack.indexOf(container);
      if (idx !== -1) {
        activeTrapsStack.splice(idx, 1);
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
      // Browsers refuse focus while the opener is still inside an inert subtree.
      const previous = previouslyFocusedRef.current;
      const remainingTrap = activeTrapsStack[activeTrapsStack.length - 1];
      if (wasTopmost) {
        if (
          previous?.isConnected
          && isFocusable(previous)
          && (!remainingTrap || remainingTrap.contains(previous) || previous.matches(FOCUS_TRAP_EXEMPT_SELECTOR))
        ) {
          previous.focus({ preventScroll: true });
        } else if (remainingTrap?.isConnected) {
          (getFocusable(remainingTrap, doc)[0] ?? remainingTrap).focus({ preventScroll: true });
        }
      }
      previouslyFocusedRef.current = null;
    };
  }, [active, containerRef, isolateBackground]);
}

export default useFocusTrap;
