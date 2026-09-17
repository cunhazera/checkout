import { t } from '../i18n';

/**
 * Shown when the totem cannot sell: the API is unreachable, or the device was
 * never provisioned with a store and totem id.
 *
 * It exists because the alternative is worse: before this screen, a customer
 * tapping a totem with no backend got no response at all — the error was
 * written to state that only the product grid rendered, and the grid is never
 * reached. A dead screen that looks alive is the one failure a customer cannot
 * work around.
 */
export function OutOfService({ reason }: { reason: 'unreachable' | 'unprovisioned' }) {
  return (
    <div className="tp-screen tp-done" role="alert" aria-live="assertive">
      <div className="tp-disc tp-disc-bad" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" strokeWidth={2.75} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 8v5" />
          <path d="M12 16.5h.01" />
          <path d="M12 3.5 2.5 20h19L12 3.5z" />
        </svg>
      </div>

      <h2 className="tp-done-title">{t('outOfService')}</h2>
      <p className="tp-done-body">
        {reason === 'unprovisioned' ? t('outOfServiceUnprovisioned') : t('outOfServiceBody')}
      </p>
    </div>
  );
}
