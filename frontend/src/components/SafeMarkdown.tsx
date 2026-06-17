import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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
        remarkPlugins={[remarkGfm]}
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
