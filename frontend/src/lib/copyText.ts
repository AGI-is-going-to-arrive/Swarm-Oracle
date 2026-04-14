export async function copyText(value: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Fall back when clipboard permissions are denied or unavailable.
  }

  const ta = document.createElement('textarea');
  ta.value = value;
  try {
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
  } finally {
    document.body.removeChild(ta);
  }
}
