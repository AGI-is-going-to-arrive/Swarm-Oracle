import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { memo, useEffect, useState } from 'react';

import { lookbehindSupported } from '../lib/markdownCompat';

interface SafeMarkdownProps {
  children: string;
  className?: string;
}

function SafeMarkdownImpl({ children, className }: SafeMarkdownProps) {
  const [remarkGfm, setRemarkGfm] = useState<typeof import('remark-gfm').default | null>(null);

  useEffect(() => {
    // GFM contains a lookbehind regex literal. Detect support before importing
    // it so Safari/iOS 16.2–16.3 can parse and render the plain markdown path.
    if (!lookbehindSupported()) return;
    let cancelled = false;
    void import('remark-gfm')
      .then(({ default: plugin }) => {
        if (!cancelled) setRemarkGfm(() => plugin);
      })
      .catch(() => {
        // A failed chunk download must not prevent reading the content.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={remarkGfm ? [remarkGfm] : []}
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
