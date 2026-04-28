export function parseSseFrame<T extends { type: string }>(frame: string): T | null {
  let eventName = '';
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith(':')) continue;
    const separatorIndex = line.indexOf(':');
    const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    let value = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value.trim();
    if (field === 'data') dataLines.push(value);
  }
  const dataText = dataLines.join('\n');
  if (!eventName || !dataText) return null;
  try {
    return { type: eventName, ...(JSON.parse(dataText) as Record<string, unknown>) } as T;
  } catch {
    return null;
  }
}
