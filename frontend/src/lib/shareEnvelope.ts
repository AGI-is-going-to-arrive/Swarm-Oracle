export interface ShareFlavorContext {
  question?: string | null;
  profileLabel?: string | null;
  runtimePresetLabel?: string | null;
  profileHooks?: string[];
  resonanceLabel?: string | null;
  directorStyleLabel?: string | null;
  dominantBranchTitle?: string | null;
  counterplaySummary?: string | null;
  commitmentSummary?: string | null;
  permalinkUrl?: string | null;
}

function buildContextLines(context: ShareFlavorContext, isZh: boolean): string[] {
  const lines: string[] = [];
  const profile = context.profileLabel?.trim();
  const runtimePreset = context.runtimePresetLabel?.trim();
  const resonance = context.resonanceLabel?.trim();
  const hooks = (context.profileHooks ?? []).filter(Boolean).slice(0, 3);
  const director = context.directorStyleLabel?.trim();
  const dominantBranch = context.dominantBranchTitle?.trim();
  const counterplay = context.counterplaySummary?.trim();
  const commitment = context.commitmentSummary?.trim();
  const permalinkUrl = context.permalinkUrl?.trim();

  if (profile || resonance) {
    lines.push(
      isZh
        ? `【${profile ?? '通用博弈'}｜${resonance ?? '未归档'}】`
        : `[${profile ?? 'General Tension'} | ${resonance ?? 'Uncatalogued'}]`,
    );
  }

  if (runtimePreset) {
    lines.push(
      isZh
        ? `神谕档位：${runtimePreset}`
        : `Oracle profile: ${runtimePreset}`,
    );
  }

  if (hooks.length > 0) {
    lines.push(
      isZh
        ? `题材钩子：${hooks.join(' · ')}`
        : `Theme hooks: ${hooks.join(' · ')}`,
    );
  }

  const tailBits = [
    dominantBranch
      ? (isZh ? `主导世界线：${dominantBranch}` : `Dominant branch: ${dominantBranch}`)
      : null,
    director
      ? (isZh ? `导演风格：${director}` : `Director style: ${director}`)
      : null,
  ].filter(Boolean);

  if (tailBits.length > 0) {
    lines.push(tailBits.join(' · '));
  }

  if (counterplay) {
    lines.push(
      isZh
        ? `反制轨迹：${counterplay}`
        : `Counterplay: ${counterplay}`,
    );
  }

  if (commitment) {
    lines.push(
      isZh
        ? `世界线承诺：${commitment}`
        : `Worldline commitment: ${commitment}`,
    );
  }

  if (permalinkUrl) {
    lines.push(
      isZh
        ? `固定链接：${permalinkUrl}`
        : `Permalink: ${permalinkUrl}`,
    );
  }

  return lines;
}

export function buildShareCopyEnvelope(
  copy: string,
  context: ShareFlavorContext,
  isZh: boolean,
): string {
  const trimmedCopy = copy.trim();
  if (!trimmedCopy) return copy;

  const contextLines = buildContextLines(context, isZh);
  if (contextLines.length === 0) return trimmedCopy;

  return `${contextLines.join('\n')}\n\n${trimmedCopy}`;
}

export function buildExportArchivePreface(
  markdown: string,
  context: ShareFlavorContext,
  isZh: boolean,
): string {
  const trimmedMarkdown = markdown.trim();
  const contextLines = buildContextLines(context, isZh);
  if (contextLines.length === 0) return trimmedMarkdown;

  const title = isZh ? '## 题材档案' : '## Theme Pack Snapshot';
  const bullets = contextLines.map((line) => `- ${line}`).join('\n');

  return `${title}\n${bullets}\n\n---\n\n${trimmedMarkdown}`;
}
