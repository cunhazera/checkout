import { t } from '../i18n';
export function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <div
      className="tp-screen tp-welcome"
      onClick={onStart}
      role="button"
      tabIndex={0}
      aria-label={t('touchToStart')}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onStart();
      }}
    >
      <div
        className="tp-deco"
        style={{ width: 740, height: 740, top: -230, right: -190, background: 'var(--color-accent-2-200)' }}
      />
      <div
        className="tp-deco"
        style={{ width: 660, height: 660, bottom: -280, left: -220, background: 'var(--color-accent-200)' }}
      />

      <div className="tp-welcome-top">
        <span className="tag tag-accent-2">{t('selfCheckout')}</span>
        <h1 className="tp-h1">Snack Bar</h1>
        <p className="tp-lede">{t('welcomeLede')}</p>
      </div>

      <div className="tp-welcome-bottom">
        <div className="tp-touch-row">
          <div className="tp-touch-disc" aria-hidden="true">
            <div className="tp-pulse" />
            <svg viewBox="0 0 24 24" fill="none" strokeWidth={2.75} strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 11V5.5a1.5 1.5 0 0 1 3 0V11" />
              <path d="M11 11V4.5a1.5 1.5 0 0 1 3 0V11" />
              <path d="M14 11V6.5a1.5 1.5 0 0 1 3 0V13" />
              <path d="M17 9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-2a6 6 0 0 1-6-6v-3.5a1.5 1.5 0 0 1 3 0" />
            </svg>
          </div>
          <span className="tp-touch-label">{t('touchToStart')}</span>
        </div>
        <div className="tp-methods">
          <span>{t('payCardTap')}</span>
          <span>{t('payWallets')}</span>
          <span>{t('payQr')}</span>
        </div>
      </div>
    </div>
  );
}
