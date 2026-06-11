import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import './LlmErrorHint.css';

interface LlmErrorHintProps {
  code: string;
}

export function LlmErrorHint({ code }: LlmErrorHintProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const isLlmErrorCode = [
    'LLM_UNREACHABLE',
    'LLM_AUTH_FAILED',
    'LLM_MODEL_NOT_FOUND',
    'LLM_RATE_LIMITED'
  ].includes(code);

  if (!isLlmErrorCode) return null;

  return (
    <div className="llm-error-hint" role="alert" aria-live="assertive">
      <div className="llm-error-header">
        <span className="llm-error-icon" aria-hidden="true">🚫</span>
        <span className="llm-error-title">{t('llm_error_hint.title')}</span>
      </div>
      <div className="llm-error-body">
        <p className="llm-error-message">
          <strong>{t(`llm_error_hint.${code}.message`)}</strong>
        </p>
        <p className="llm-error-fix">
          {t(`llm_error_hint.${code}.hint`)}
        </p>
      </div>
      <div className="llm-error-actions">
        <button
          type="button"
          onClick={() => navigate('/admin/setup')}
          className="btn btn-secondary llm-error-diagnose-btn"
        >
          {t('llm_error_hint.diagnose_btn')}
        </button>
      </div>
    </div>
  );
}
