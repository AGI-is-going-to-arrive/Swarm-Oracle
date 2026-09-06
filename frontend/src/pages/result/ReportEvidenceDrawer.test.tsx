import { useState } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';

import { ReportEvidenceDrawer } from './ReportEvidenceDrawer';

it('restores the evidence opener after releasing background isolation and scroll lock', async () => {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  const originalOverflow = document.body.style.overflow;
  document.body.style.overflow = 'clip';

  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <MemoryRouter>
        <button type="button" onClick={() => setOpen(true)}>Open evidence</button>
        <ReportEvidenceDrawer
          isOpen={open}
          onClose={() => setOpen(false)}
          scenarioId="evidence-audit"
          evidence={[]}
        />
      </MemoryRouter>
    );
  }

  try {
    render(<Harness />, { container: root });
    const user = userEvent.setup();
    const opener = screen.getByRole('button', { name: 'Open evidence' });
    await user.click(opener);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(root).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(opener).toHaveFocus());
    expect(root).not.toHaveAttribute('inert');
    expect(root).not.toHaveAttribute('aria-hidden');
    expect(document.body.style.overflow).toBe('clip');
  } finally {
    cleanup();
    root.remove();
    document.body.style.overflow = originalOverflow;
  }
});

it('keeps saved excerpts readable when replay access is unavailable', async () => {
  const evidence = [
    { id: 'e1', branch_id: 'b1', round_id: 'r1', round_number: 1, agent_id: 'a1', agent_name: 'Original actor', message_id: 'm1', quote: 'Original stored statement.', kind: 'utterance' as const },
    { id: 'e2', branch_id: 'b1', round_id: 'r2', round_number: 2, agent_id: 'a1', agent_name: 'Original actor', message_id: 'm2', quote: 'Derived stored evidence.', kind: 'causal_fact' as const },
  ];
  render(<MemoryRouter><ReportEvidenceDrawer isOpen onClose={() => {}} scenarioId="saved-report" evidence={evidence} canOpenReplay={false} /></MemoryRouter>);
  await screen.findByRole('dialog');
  expect(screen.getByText('Original stored statement.')).toBeInTheDocument();
  expect(screen.getByText('Derived stored evidence.')).toBeInTheDocument();
  const disabledReplayActions = screen.getAllByRole('button').filter((button) => button.hasAttribute('disabled'));
  expect(disabledReplayActions).toHaveLength(2);
  expect(disabledReplayActions.every((button) => Boolean(button.getAttribute('title')))).toBe(true);
});
