import type { Result } from '../state/session';
import { formatCents } from '../money';

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

  const title = success ? 'Paid. Enjoy.' : unknown ? 'Please contact staff' : 'Payment declined';

  const body = success
    ? 'Payment went through. Take your items with you.'
    : unknown
      ? 'We could not confirm your payment. Do not try again — staff will check whether it went through.'
      : (failureMessage ??
        'The payment was not accepted. Nothing was charged. Try again or choose another payment method.');

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
        <div className="tp-notice tp-notice-bad">Reference {supportReference}</div>
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
            <div className="tp-receipt-title">Receipt on your phone</div>
            <div className="tp-receipt-note">Scan this code to open it. Nothing is printed.</div>
            {orderId && (
              <div className="tp-receipt-ref">
                Order {orderId.slice(0, 8).toUpperCase()} · {formatCents(amountCents)}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="tp-done-actions">
        {result === 'declined' && (
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            Try payment again
          </button>
        )}
        <button type="button" className="btn btn-secondary" onClick={onFinish}>
          {success ? 'Done' : 'Cancel order'}
        </button>
      </div>

      {success && (
        <div className="tp-returning">Returning to the start screen in a few seconds.</div>
      )}
    </div>
  );
}
