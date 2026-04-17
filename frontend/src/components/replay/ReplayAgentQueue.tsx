/* ═══════════════════════════════════════════════════════════
   FE-4 — ReplayAgentQueue
   Horizontal scrollable avatar strip. Marks `activeAgentId`
   with a highlighted ring (Motion-compatible via CSS variable
   transition; prefers-reduced-motion is respected at CSS level).
   ═══════════════════════════════════════════════════════════ */

import type { CSSProperties } from 'react';

export interface ReplayAgentInfo {
  id: string;
  name: string;
  /** Optional persona hint used for initials fallback. */
  role?: string;
  /** Optional color hint (hex or CSS var); falls back to derived hue. */
  color?: string;
}

export interface ReplayAgentQueueProps {
  agents: ReplayAgentInfo[];
  activeAgentId?: string | null;
  onSelect?: (agentId: string) => void;
  ariaLabel?: string;
}

function getInitials(name: string): string {
  const trimmed = (name || '').trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return trimmed.slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function hashToHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function ReplayAgentQueue({
  agents,
  activeAgentId,
  onSelect,
  ariaLabel,
}: ReplayAgentQueueProps) {
  return (
    <div
      role="list"
      aria-label={ariaLabel ?? 'Replay agent queue'}
      className="flex items-center gap-2 overflow-x-auto py-2 px-1"
      style={{ scrollbarWidth: 'thin' }}
    >
      {agents.map((agent) => {
        const isActive = agent.id === activeAgentId;
        const tid = `replay-agent-queue-${agent.id}`;
        const color = agent.color || `hsl(${hashToHue(agent.id)} 65% 55%)`;
        const bubbleStyle: CSSProperties = {
          backgroundColor: color,
          boxShadow: isActive
            ? '0 0 0 2px var(--color-primary, #8ab4f8), 0 0 12px 2px color-mix(in oklch, var(--color-primary, #8ab4f8) 60%, transparent)'
            : 'none',
          transform: isActive ? 'scale(1.08)' : 'scale(1)',
          transition: 'transform 180ms cubic-bezier(.16,1,.3,1), box-shadow 200ms ease-out',
        };
        const handleClick = () => {
          if (onSelect) onSelect(agent.id);
        };
        return (
          <button
            key={agent.id}
            type="button"
            role="listitem"
            data-testid={tid}
            data-active={isActive ? 'true' : 'false'}
            aria-current={isActive ? 'true' : undefined}
            aria-label={agent.name}
            onClick={handleClick}
            className="flex flex-col items-center gap-1 shrink-0 focus:outline-none focus:ring-2 focus:ring-primary/60 rounded-full"
          >
            <span
              aria-hidden="true"
              style={bubbleStyle}
              className="flex items-center justify-center w-10 h-10 rounded-full font-semibold text-white text-xs"
            >
              {getInitials(agent.name)}
            </span>
            <span
              className="text-[10px] max-w-[60px] truncate text-muted-foreground"
              title={agent.name}
            >
              {agent.name}
            </span>
          </button>
        );
      })}
      {agents.length === 0 && (
        <span className="text-xs text-muted-foreground italic px-2">
          No agents recorded
        </span>
      )}
    </div>
  );
}

export default ReplayAgentQueue;
