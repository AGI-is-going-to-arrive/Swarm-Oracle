import { Component, type ErrorInfo, type ReactNode } from 'react';

import i18n from '../i18n/config';

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  hasError: boolean;
};

function resolveCopy() {
  const language = (
    typeof document !== 'undefined' && document.documentElement.lang
      ? document.documentElement.lang
      : typeof navigator !== 'undefined'
        ? navigator.language
        : ''
  ).toLowerCase();
  const isZh = language.startsWith('zh') || i18n.language.toLowerCase().startsWith('zh');
  return isZh
    ? {
        title: '页面发生错误',
        body: '请刷新页面后重试。',
        action: '刷新页面',
      }
    : {
        title: 'Something went wrong',
        body: 'Refresh the page and try again.',
        action: 'Reload page',
      };
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    hasError: false,
  };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[AppErrorBoundary] Unhandled render error', error, errorInfo);
  }

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const copy = resolveCopy();
    return (
      <div className="game-skeleton" role="alert">
        <h1>{copy.title}</h1>
        <p>{copy.body}</p>
        <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>
          {copy.action}
        </button>
      </div>
    );
  }
}
