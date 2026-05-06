import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { memo } from 'react';

interface SafeMarkdownProps {
  children: string;
  className?: string;
}

function SafeMarkdownImpl({ children, className }: SafeMarkdownProps) {
  return (
    <div className={className}>
      <ReactMarkdown
        rehypePlugins={[rehypeSanitize]}
        disallowedElements={['img']}
        unwrapDisallowed
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export const SafeMarkdown = memo(SafeMarkdownImpl);
