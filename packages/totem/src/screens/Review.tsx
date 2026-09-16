import type { CartLine } from '../state/session';
import { formatCents } from '../money';
import { Art } from '../components/Art';
import { Stepper } from '../components/Stepper';

interface Props {
  lines: CartLine[];
  totals: { subtotalCents: number; taxCents: number; totalCents: number };
  taxBasisPoints: number;
  notice: string | null;
  busy: boolean;
  onQuantity: (itemId: string, next: number) => void;
  onAddMore: () => void;
  onPay: () => void;
}

export function Review({
  lines,
  totals,
  taxBasisPoints,
  notice,
  busy,
  onQuantity,
  onAddMore,
  onPay,
}: Props) {
  const empty = lines.length === 0;

  return (
    <div className="tp-screen">
      <div className="tp-review-head">
        <h2 className="tp-h2">Your basket</h2>
        <div className="tp-review-sub">Change quantities before you pay.</div>
      </div>

      {notice && <div className="tp-notice">{notice}</div>}

      <div className="tp-lines">
        {empty ? (
          // The prototype's copy said "scan or tap"; there is no scanner.
          <div className="tp-empty">Your basket is empty. Go back and tap an item.</div>
        ) : (
          lines.map(({ item, quantity }) => (
            <div className="tp-line" key={item.id}>
              <Art itemId={item.id} className="tp-line-art tp-art" />
              <div className="tp-line-info">
                <div className="tp-line-name">{item.name}</div>
                <div className="tp-line-meta">
                  {formatCents(item.priceCents)} each
                  {item.description ? ` · ${item.description}` : ''}
                </div>
              </div>
              <Stepper
                value={quantity}
                onChange={(n) => onQuantity(item.id, n)}
                min={0}
                max={item.availableQuantity}
              />
              <div className="tp-line-total">{formatCents(item.priceCents * quantity)}</div>
            </div>
          ))
        )}
      </div>

      <div className="tp-foot">
        <div className="tp-foot-row">
          <span>Subtotal</span>
          <span>{formatCents(totals.subtotalCents)}</span>
        </div>
        {/* Only shown when tax is actually configured — see PROGRESS.md. */}
        {taxBasisPoints > 0 && (
          <div className="tp-foot-row">
            <span>Tax ({(taxBasisPoints / 100).toFixed(taxBasisPoints % 100 === 0 ? 0 : 2)}%)</span>
            <span>{formatCents(totals.taxCents)}</span>
          </div>
        )}
        <div className="tp-total-row">
          <span className="tp-total-label">Total</span>
          <span className="tp-total-amount">{formatCents(totals.totalCents)}</span>
        </div>
        <div className="tp-foot-actions">
          <button type="button" className="btn btn-secondary" onClick={onAddMore}>
            Add more
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onPay}
            disabled={empty || busy}
          >
            {busy ? 'Reserving…' : `Pay ${formatCents(totals.totalCents)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
