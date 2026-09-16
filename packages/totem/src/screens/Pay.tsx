import type { PaymentMethod } from '../api/types';
import { formatCents } from '../money';

const METHODS: { id: PaymentMethod; name: string; note: string }[] = [
  { id: 'card', name: 'Card', note: 'Credit or debit' },
  { id: 'wallet', name: 'Apple / Google Pay', note: 'Phone wallet' },
  { id: 'qr', name: 'QR payment', note: 'Scan with your bank app' },
];

interface Props {
  totalCents: number;
  itemCount: number;
  method: PaymentMethod | null;
  notice: string | null;
  busy: boolean;
  onMethod: (m: PaymentMethod) => void;
  onPay: () => void;
  onCancel: () => void;
}

export function Pay({
  totalCents,
  itemCount,
  method,
  notice,
  busy,
  onMethod,
  onPay,
  onCancel,
}: Props) {
  // ADR-003 resolves payment synchronously, including up to 30s of
  // reconciliation. The screen is non-dismissible while that runs.
  if (busy) {
    return (
      <div className="tp-screen tp-pay">
        <div className="tp-spinner" />
        <h2 className="tp-amount-value" style={{ fontSize: 72 }}>
          Confirming your payment…
        </h2>
        <p className="tp-done-body">
          Follow the instructions on the card reader. Please do not walk away.
        </p>
      </div>
    );
  }

  return (
    <div className="tp-screen tp-pay">
      <div
        className="tp-deco"
        style={{ width: 580, height: 580, top: -190, left: -170, background: 'var(--color-accent-2-200)' }}
      />

      <div className="tp-amount">
        <div className="tp-amount-label">Amount due</div>
        <div className="tp-amount-value">{formatCents(totalCents)}</div>
        <div className="tp-amount-count">{itemCount === 1 ? '1 item' : `${itemCount} items`}</div>
      </div>

      {notice && <div className="tp-notice tp-notice-bad">{notice}</div>}

      <div className="tp-methods-list">
        <div className="tp-methods-label">Choose how to pay</div>
        {METHODS.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`tp-method${method === m.id ? ' is-selected' : ''}`}
            onClick={() => onMethod(m.id)}
          >
            <span className="tp-dot" />
            <span className="tp-method-name">{m.name}</span>
            <span className="tp-method-note">{m.note}</span>
          </button>
        ))}
      </div>

      <div className="tp-pay-actions">
        <button type="button" className="btn btn-primary" onClick={onPay} disabled={!method}>
          {method ? `Pay ${formatCents(totalCents)}` : 'Select a payment method'}
        </button>
        <div className="tp-pay-row">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
