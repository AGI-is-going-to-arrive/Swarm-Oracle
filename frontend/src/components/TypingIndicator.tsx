import { memo } from 'react';

interface TypingIndicatorProps {
  agentName?: string;
  className?: string;
  ariaLabel?: string;
}

function TypingIndicatorImpl({ agentName, className, ariaLabel }: TypingIndicatorProps) {
  return (
    <span
      className={`typing-indicator ${className ?? ''}`}
      role="status"
      aria-label={ariaLabel ?? (agentName ? `${agentName} is typing` : 'Agent is typing')}
    >
      {agentName && <span className="typing-indicator-name">{agentName}</span>}
      <span className="typing-indicator-dots" aria-hidden="true">
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </span>
    </span>
  );
}

export const TypingIndicator = memo(TypingIndicatorImpl);
