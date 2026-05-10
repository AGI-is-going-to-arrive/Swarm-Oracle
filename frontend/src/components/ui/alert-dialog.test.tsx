import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog';

function renderHarness(props: { open?: boolean; onOpenChange?: (open: boolean) => void }) {
  return render(
    <AlertDialog open={props.open ?? true} onOpenChange={props.onOpenChange}>
      <AlertDialogContent aria-label="Confirm action">
        <AlertDialogHeader>
          <AlertDialogTitle>Confirm action</AlertDialogTitle>
          <AlertDialogDescription>This is a destructive action.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction>OK</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>,
  );
}

describe('alert-dialog wrapper', () => {
  it('renders title, description, and action buttons inside the alert dialog', () => {
    renderHarness({ open: true });
    // Radix renders role="alertdialog" by default; we override role in production
    // callers when needed, but the wrapper itself stays Radix-default.
    expect(screen.getByRole('alertdialog', { name: 'Confirm action' })).toBeInTheDocument();
    expect(screen.getByText('This is a destructive action.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'OK' })).toBeInTheDocument();
  });

  it('fires onOpenChange(false) when the cancel button is clicked', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderHarness({ open: true, onOpenChange });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('fires onOpenChange(false) when Escape is pressed', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderHarness({ open: true, onOpenChange });
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders nothing when open=false', () => {
    renderHarness({ open: false });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
