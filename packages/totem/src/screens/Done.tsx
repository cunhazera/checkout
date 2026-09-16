import type { Result } from '../state/session';
import { formatCents } from '../money';
import { t } from '../i18n';

interface Props {
  result: Result;
  amountCents: number;
  orderId: string | null;
  supportReference: string | null;
  failureMessage: string | null;
  onRetry: () => void;
  onFinish: () => void;
}

export function Done({
  result,
  amountCents,
  orderId,
  supportReference,
  failureMessage,
  onRetry,
  onFinish,
}: Props) {
  const success = result === 'approved';
  // ADR-003: an unknown outcome must never claim the card was not charged.
  const unknown = result === 'unknown';

  const title = success ? t('paidEnjoy') : unknown ? t('contactStaff') : t('declined');

  const body = success
    ? t('paidBody')
    : unknown
      ? t('unknownBody')
      : (failureMessage ?? t('declinedBody'));

  return (
    <div className="tp-screen tp-done">
      <div className={`tp-disc ${success ? 'tp-disc-ok' : 'tp-disc-bad'}`}>
        <svg viewBox="0 0 24 24" fill="none" strokeWidth={2.75} strokeLinecap="round" strokeLinejoin="round">
          {success ? <path d="M4 12.5l5.5 5.5L20 6.5" /> : <path d="M6 6l12 12M18 6L6 18" />}
        </svg>
      </div>

      <h2 className="tp-done-title">{title}</h2>
      <p className="tp-done-body">{body}</p>

      {unknown && supportReference && (
        <div className="tp-notice tp-notice-bad">{t('reference', { ref: supportReference })}</div>
      )}

      {success && (
        <div className="tp-receipt">
          <div className="tp-qr">
            {/* Stand-in for a generated QR pointing at the receipt URL. */}
            <svg viewBox="0 0 24 24" fill="var(--color-neutral-100)">
              <path d="M3 3h7v7H3V3zm2 2v3h3V5H5zM14 3h7v7h-7V3zm2 2v3h3V5h-3zM3 14h7v7H3v-7zm2 2v3h3v-3H5zM14 14h3v3h-3v-3zM18 14h3v3h-3v-3zM14 18h3v3h-3v-3zM18 18h3v3h-3v-3z" />
            </svg>
          </div>
          <div className="tp-receipt-info">
            <div className="tp-receipt-title">{t('receiptTitle')}</div>
            <div className="tp-receipt-note">{t('receiptNote')}</div>
            {orderId && (
              <div className="tp-receipt-ref">
                {t('orderLine', {
                  code: orderId.slice(0, 8).toUpperCase(),
                  total: formatCents(amountCents),
                })}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="tp-done-actions">
        {result === 'declined' && (
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            {t('tryAgain')}
          </button>
        )}
        <button type="button" className="btn btn-secondary" onClick={onFinish}>
          {success ? t('done') : t('cancelOrder')}
        </button>
      </div>

      {success && (
        <div className="tp-returning">{t('returningSoon')}</div>
      )}
    </div>
  );
}
