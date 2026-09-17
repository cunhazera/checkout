import type { PaymentMethod } from '../api/types';
import { formatCents } from '../money';
import { itemCountLabel, t } from '../i18n';

const METHODS: { id: PaymentMethod; name: () => string; note: () => string }[] = [
  { id: 'card', name: () => t('methodCard'), note: () => t('methodCardNote') },
  { id: 'wallet', name: () => t('methodWallet'), note: () => t('methodWalletNote') },
  { id: 'qr', name: () => t('methodQr'), note: () => t('methodQrNote') },
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
      <div className="tp-screen tp-pay" role="status" aria-live="assertive">
        <div className="tp-spinner" aria-hidden="true" />
        <h2 className="tp-amount-value" style={{ fontSize: 72 }}>
          {t('confirmingPayment')}
        </h2>
        <p className="tp-done-body">{t('doNotWalkAway')}</p>
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
        <div className="tp-amount-label">{t('amountDue')}</div>
        <div className="tp-amount-value">{formatCents(totalCents)}</div>
        <div className="tp-amount-count">{itemCountLabel(itemCount)}</div>
      </div>

      {notice && <div className="tp-notice tp-notice-bad">{notice}</div>}

      <div className="tp-methods-list" role="radiogroup" aria-label={t('chooseHowToPay')}>
        <div className="tp-methods-label">{t('chooseHowToPay')}</div>
        {METHODS.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`tp-method${method === m.id ? ' is-selected' : ''}`}
            onClick={() => onMethod(m.id)}
            role="radio"
            aria-checked={method === m.id}
            aria-label={`${m.name()}, ${m.note()}`}
          >
            <span className="tp-dot" aria-hidden="true" />
            <span className="tp-method-name">{m.name()}</span>
            <span className="tp-method-note">{m.note()}</span>
          </button>
        ))}
      </div>

      <div className="tp-pay-actions">
        <button type="button" className="btn btn-primary" onClick={onPay} disabled={!method}>
          {method ? t('pay', { total: formatCents(totalCents) }) : t('selectAMethod')}
        </button>
        <div className="tp-pay-row">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            {t('cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
