export async function copyText(value: string): Promise<void> {
  let clipboardError: unknown;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch (error) {
    clipboardError = error;
  }

  const ta = document.createElement('textarea');
  ta.value = value;
  try {
    document.body.appendChild(ta);
    ta.select();
    if (document.execCommand('copy')) {
      return;
    }
  } finally {
    ta.remove();
  }

  throw new Error('Failed to copy text', {
    cause: clipboardError ?? new Error('Copy command was rejected'),
  });
}
