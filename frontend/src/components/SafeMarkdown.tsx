import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { memo } from 'react';

import { lookbehindSupported } from '../lib/markdownCompat';

interface SafeMarkdownProps {
  children: string;
  className?: string;
}

function SafeMarkdownImpl({ children, className }: SafeMarkdownProps) {
  // Without lookbehind (Safari/iOS 16.2–16.3 in targets) remark-gfm's autolink
  // transform throws at runtime — degrade to plain markdown; rehype-sanitize
  // stays active on every path.
  const remarkPlugins = lookbehindSupported() ? [remarkGfm] : [];

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
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
