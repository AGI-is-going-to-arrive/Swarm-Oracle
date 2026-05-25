import { Component, type ErrorInfo, type ReactNode } from 'react';

import i18n from '../i18n/config';

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  hasError: boolean;
};

type ErrorBoundaryCopy = {
  title: string;
  body: string;
  action: string;
};

const FALLBACK_COPY: Record<'en' | 'zh', ErrorBoundaryCopy> = {
  en: {
    title: 'Something went wrong',
    body: 'Refresh the page and try again.',
    action: 'Reload page',
  },
  zh: {
    title: '页面发生错误',
    body: '请刷新页面后重试。',
    action: '刷新页面',
  },
};

function resolveFallbackLanguage(): 'en' | 'zh' {
  const candidates = [
    i18n.resolvedLanguage,
    i18n.language,
    typeof document !== 'undefined' ? document.documentElement.lang : '',
    typeof navigator !== 'undefined' ? navigator.language : '',
  ];
  return candidates.some((language) => language?.toLowerCase().startsWith('zh')) ? 'zh' : 'en';
}

function translateWithFallback(key: string, fallback: string): string {
  try {
    const value = i18n.t(key, { defaultValue: fallback });
    return typeof value === 'string' && value.trim() && value !== key ? value : fallback;
  } catch {
    return fallback;
  }
}

function resolveCopy() {
  const fallback = FALLBACK_COPY[resolveFallbackLanguage()];
  return {
    title: translateWithFallback('error_boundary.title', fallback.title),
    body: translateWithFallback('error_boundary.body', fallback.body),
    action: translateWithFallback('error_boundary.action', fallback.action),
  };
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    hasError: false,
  };

  private unsubscribeI18n?: () => void;

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  componentDidMount(): void {
    const handleLanguageChange = () => {
      if (this.state.hasError) this.forceUpdate();
    };
    i18n.on?.('languageChanged', handleLanguageChange);
    this.unsubscribeI18n = () => i18n.off?.('languageChanged', handleLanguageChange);
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[AppErrorBoundary] Unhandled render error', error, errorInfo);
  }

  componentWillUnmount(): void {
    this.unsubscribeI18n?.();
  }

  private handleReload = (): void => {
    if (typeof window !== 'undefined') window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const copy = resolveCopy();
    return (
      <div className="game-skeleton" role="alert">
        <h1>{copy.title}</h1>
        <p>{copy.body}</p>
        <button className="btn btn-primary" type="button" onClick={this.handleReload}>
          {copy.action}
        </button>
      </div>
    );
  }
}
