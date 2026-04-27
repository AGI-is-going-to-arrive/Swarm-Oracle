import type { CSSProperties } from 'react';

export interface ReplayAgentInfo {
  id: string;
  name: string;
  role?: string;
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
      className="replay-agents"
    >
      {agents.map((agent) => {
        const isActive = agent.id === activeAgentId;
        const tid = `replay-agent-queue-${agent.id}`;
        const hue = hashToHue(agent.id);
        const color = agent.color || `oklch(65% 0.18 ${hue})`;
        const ringColor = agent.color || `oklch(75% 0.14 ${hue})`;
        const bubbleStyle: CSSProperties = {
          '--agent-color': color,
          '--agent-ring': ringColor,
        } as CSSProperties;
        return (
          <button
            key={agent.id}
            type="button"
            role="listitem"
            data-testid={tid}
            data-active={isActive ? 'true' : 'false'}
            aria-current={isActive ? 'true' : undefined}
            aria-label={agent.name}
            onClick={() => onSelect?.(agent.id)}
            className={`replay-agents__item ${isActive ? 'replay-agents__item--active' : ''}`}
            style={bubbleStyle}
          >
            <span className="replay-agents__avatar" aria-hidden="true">
              {getInitials(agent.name)}
            </span>
            <span className="replay-agents__name" title={agent.name}>
              {agent.name}
            </span>
          </button>
        );
      })}
      {agents.length === 0 && (
        <span className="replay-agents__empty">
          No agents recorded
        </span>
      )}
    </div>
  );
}

export default ReplayAgentQueue;
