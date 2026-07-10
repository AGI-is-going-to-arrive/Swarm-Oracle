/* ═══════════════════════════════════════════════════════════
   SwarmOracle — AgentPanel (Enhanced with Pixel Avatars + Speech Bubbles)
   ═══════════════════════════════════════════════════════════ */

import { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSimulationStore } from '../stores/simulationStore';
import type { AgentMessage, BranchInfo } from '../types';
import './AgentPanel.css';

// ── Deterministic Pixel Avatar ──────────────────────────────
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0; // M-1 fix: unsigned right shift to prevent negative values
}

function PixelAvatar({ name, size = 36 }: { name: string; size?: number }) {
  const { t } = useTranslation();
  const hash = hashString(name);
  const hue = hash % 360;
  const sat = 50 + (hash % 30);
  const primaryColor = `hsl(${hue}, ${sat}%, 45%)`;
  const secondaryColor = `hsl(${hue}, ${sat - 10}%, 65%)`;
  const bgColor = `hsl(${hue}, 15%, 92%)`;

  const grid: boolean[][] = [];
  for (let y = 0; y < 5; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < 3; x++) {
      row.push(((hash >> (y * 3 + x)) & 1) === 1);
    }
    grid.push([row[0], row[1], row[2], row[1], row[0]]);
  }

  const cellSize = size / 5;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="pixel-avatar"
      aria-label={t('sim.avatar.avatar_alt', { name })}
    >
      <rect width={size} height={size} fill={bgColor} rx={size * 0.15} />
      {grid.map((row, y) =>
        row.map((filled, x) =>
          filled ? (
            <rect
              key={`${y}-${x}`}
              x={x * cellSize}
              y={y * cellSize}
              width={cellSize}
              height={cellSize}
              fill={y < 2 ? primaryColor : secondaryColor}
            />
          ) : null,
        ),
      )}
    </svg>
  );
}

// ── Emotion Color Map ───────────────────────────────────────
const EMOTION_COLORS: Record<string, string> = {
  neutral: 'var(--text-muted)',
  happy: '#4caf50',
  excited: '#ff9800',
  angry: '#f44336',
  sad: '#2196f3',
  thoughtful: '#9c27b0',
  anxious: '#ff5722',
  calm: '#00bcd4',
  surprised: '#ffeb3b',
};

function EmotionDot({ emotion }: { emotion: string }) {
  const { t } = useTranslation();
  const color = EMOTION_COLORS[emotion] || EMOTION_COLORS.neutral;
  return (
    <span
      className="emotion-dot"
      ref={(el) => { if (el) el.style.setProperty('--emotion-color', color); }}
      title={emotion}
      aria-label={t('sim.panel.emotion_label', { emotion })}
    />
  );
}

// ── Branch short label ──────────────────────────────────────
function branchShortLabel(branchId: string, branches: Array<{ id: string; description?: string; title?: string }>): string {
  const branch = branches.find((b) => b.id === branchId);
  const label = branch?.description || branch?.title;
  if (label) {
    return label.length > 14 ? label.slice(0, 14) + '…' : label;
  }
  return branchId.slice(0, 6);
}

function branchDisplayTitle(
  branchId: string,
  branches: BranchInfo[],
  fallbackTitle?: string,
): string {
  const branch = branches.find((b) => b.id === branchId);
  return branch?.title || branch?.description || fallbackTitle || branchId.slice(0, 6);
}

interface AgentMessageGroup {
  branchId: string;
  title: string;
  startRound: number;
  endRound: number;
  messages: Array<{ message: AgentMessage; originalIndex: number }>;
}

function groupMessagesByWorldline(
  filteredMessages: AgentMessage[],
  branches: BranchInfo[],
): AgentMessageGroup[] {
  const groups = new Map<string, AgentMessageGroup>();

  filteredMessages.forEach((message, originalIndex) => {
    const existing = groups.get(message.branch);
    if (existing) {
      existing.messages.push({ message, originalIndex });
      existing.startRound = Math.min(existing.startRound, message.round);
      existing.endRound = Math.max(existing.endRound, message.round);
      return;
    }

    groups.set(message.branch, {
      branchId: message.branch,
      title: branchDisplayTitle(message.branch, branches, message.branch_title),
      startRound: message.round,
      endRound: message.round,
      messages: [{ message, originalIndex }],
    });
  });

  return Array.from(groups.values()).map((group) => ({
    ...group,
    messages: [...group.messages].sort((a, b) => {
      if (a.message.round !== b.message.round) {
        return a.message.round - b.message.round;
      }
      return a.originalIndex - b.originalIndex;
    }),
  }));
}

// ── MessageText: parse agent name mentions ──────────────────
function MessageText({
  text,
  agents,
  onAgentClick,
}: {
  text: string;
  agents: Array<{ id: string; name: string }>;
  onAgentClick: (agentId: string) => void;
}) {
  const parts = useMemo(() => {
    if (agents.length === 0) return [{ type: 'text' as const, value: text }];
    // Sort by name length descending to avoid partial matches
    const sorted = [...agents].sort((a, b) => b.name.length - a.name.length);
    const escaped = sorted.map((a) => a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(`(${escaped.join('|')})`, 'g');
    const nameToId = new Map(sorted.map((a) => [a.name, a.id]));

    const result: Array<{ type: 'text' | 'mention'; value: string; agentId?: string }> = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        result.push({ type: 'text', value: text.slice(lastIndex, match.index) });
      }
      result.push({ type: 'mention', value: match[0], agentId: nameToId.get(match[0]) });
      lastIndex = pattern.lastIndex;
    }
    if (lastIndex < text.length) {
      result.push({ type: 'text', value: text.slice(lastIndex) });
    }
    return result;
  }, [text, agents]);

  return (
    <p>
      {parts.map((part, i) =>
        part.type === 'mention' && part.agentId ? (
          <span
            key={i}
            className="agent-mention"
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onAgentClick(part.agentId!); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onAgentClick(part.agentId!); } }}
          >
            {part.value}
          </span>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </p>
  );
}

// ── Main Component ──────────────────────────────────────────
interface AgentPanelProps {
  onBranchDetail?: (branchId: string) => void;
  onViewProfile?: (agentId: string) => void;
}

export function AgentPanel({ onBranchDetail, onViewProfile }: AgentPanelProps) {
  const { t } = useTranslation();
  const agents = useSimulationStore((s) => s.agents);
  const messages = useSimulationStore((s) => s.messages);
  const branches = useSimulationStore((s) => s.branches);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Filter state: selected agent_id (null = show all)
  const [filterAgentId, setFilterAgentId] = useState<string | null>(null);

  // Refs for agent cards — used for scroll-to-card
  const agentCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Scroll to & highlight an agent card
  const scrollToAgent = useCallback((agentId: string) => {
    // Set filter to show that agent's messages
    setFilterAgentId((prev) => (prev === agentId ? null : agentId));

    // Scroll the card into view and flash-highlight it
    const el = agentCardRefs.current.get(agentId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      el.classList.add('agent-card--highlight');
      const onEnd = () => {
        el.classList.remove('agent-card--highlight');
        el.removeEventListener('animationend', onEnd);
      };
      el.addEventListener('animationend', onEnd);
    }
  }, []);

  // Compute filtered messages
  const filteredMessages = useMemo(() => {
    if (!filterAgentId) return messages;
    return messages.filter((m) => m.agent_id === filterAgentId);
  }, [messages, filterAgentId]);

  const selectedAgentMessageGroups = useMemo(() => {
    if (!filterAgentId) return [];
    return groupMessagesByWorldline(filteredMessages, branches);
  }, [branches, filterAgentId, filteredMessages]);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [filteredMessages.length]);

  const tierLabel = (tier: string) => {
    switch (tier) {
      case 'CORE': return t('sim.panel.tier_core');
      case 'IMPORTANT': return t('sim.panel.tier_important');
      case 'CROWD': return t('sim.panel.tier_crowd');
      default: return tier;
    }
  };

  // Get the filtered agent name for display
  const filterAgentName = useMemo(() => {
    if (!filterAgentId) return null;
    const agent = agents.find((a) => a.id === filterAgentId);
    return agent?.name || null;
  }, [filterAgentId, agents]);

  const handleAgentClick = (agentId: string) => {
    setFilterAgentId((prev) => (prev === agentId ? null : agentId));
  };

  const renderSpeechBubble = (msg: AgentMessage, keyIndex: number) => (
    <div key={`${msg.agent_id}-${msg.branch}-${msg.round}-${keyIndex}`} className="speech-bubble-wrap">
      <div className="bubble-header">
        <PixelAvatar name={msg.agent} size={24} />
        <span
          className="bubble-agent agent-mention"
          role="button"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); scrollToAgent(msg.agent_id); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); scrollToAgent(msg.agent_id); } }}
        >{msg.agent}</span>
        <span
          className="bubble-branch agent-mention"
          role="button"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); onBranchDetail?.(msg.branch); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onBranchDetail?.(msg.branch); } }}
          title={msg.branch}
        >
          🌿 {branchShortLabel(msg.branch, branches)}
        </span>
        <span className="bubble-round">
          {t('sim.panel.round')}{msg.round}
        </span>
        <EmotionDot emotion={msg.emotion} />
      </div>
      <div className="speech-bubble">
        <MessageText text={msg.message} agents={agents} onAgentClick={scrollToAgent} />
      </div>
    </div>
  );

  return (
    <aside className="agent-panel">
      <section className="agent-roster">
        <h3 className="panel-heading">{t('sim.panel.agent_list')}</h3>
        <div className="agent-list">
          {agents.map((agent) => (
            <div
              key={agent.id}
              ref={(el) => { if (el) agentCardRefs.current.set(agent.id, el); else agentCardRefs.current.delete(agent.id); }}
              className={`agent-card ${filterAgentId === agent.id ? 'agent-card--active' : ''}`}
            >
              <button
                type="button"
                className="agent-card__filter"
                aria-pressed={filterAgentId === agent.id}
                onClick={() => handleAgentClick(agent.id)}
                title={filterAgentId === agent.id ? t('sim.panel.show_all') : t('sim.panel.filter_agent', { name: agent.name })}
              >
                <PixelAvatar name={agent.name} size={36} />
                <span className="agent-info">
                  <span className="agent-name">{agent.name}</span>
                  <span className="agent-role">{agent.role}{agent.stance ? ` · ${agent.stance}` : ''}</span>
                  <span className="agent-meta">
                    <span className={`tier-badge tier-${agent.tier.toLowerCase()}`}>
                      {tierLabel(agent.tier)}
                    </span>
                    <EmotionDot emotion={agent.emotion} />
                  </span>
                </span>
              </button>
              {onViewProfile ? (
                <button
                  type="button"
                  className="agent-card__profile"
                  aria-label={t('sim.panel.view_agent_profile', { name: agent.name })}
                  title={t('sim.panel.view_agent_profile', { name: agent.name })}
                  onClick={() => onViewProfile(agent.id)}
                >
                  ⌕
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <section className="message-feed">
        <h3 className="panel-heading">
          {t('sim.panel.live_messages')}
          {filterAgentName && (
            <span className="filter-indicator">
              <span className="filter-agent-name">{filterAgentName}</span>
              <button
                className="filter-clear"
                onClick={() => setFilterAgentId(null)}
                title={t('sim.panel.show_all')}
                aria-label={t('sim.panel.clear_filter')}
              >
                ✕
              </button>
            </span>
          )}
        </h3>
        <div className="message-list">
          {filteredMessages.length === 0 ? (
            <p className="waiting-text">
              {filterAgentId ? t('sim.panel.no_agent_messages') : t('sim.panel.waiting')}
            </p>
          ) : filterAgentId ? (
            selectedAgentMessageGroups.map((group) => (
              <section
                key={group.branchId}
                className="agent-worldline-group"
                data-testid="agent-worldline-group"
              >
                <div className="agent-worldline-group__header">
                  <span className="agent-worldline-group__title">
                    {t('sim.panel.worldline_group', { title: group.title })}
                  </span>
                  <span className="agent-worldline-group__rounds">
                    {t('sim.panel.worldline_round_range', {
                      start: group.startRound,
                      end: group.endRound,
                    })}
                  </span>
                </div>
                {group.messages.map(({ message, originalIndex }) => renderSpeechBubble(message, originalIndex))}
              </section>
            ))
          ) : (
            filteredMessages.map((msg, i) => renderSpeechBubble(msg, i))
          )}
          <div ref={messagesEndRef} />
        </div>
      </section>
    </aside>
  );
}
