import type { MenuItem } from '../api/types';
import { formatCents } from '../money';
import { Art } from './Art';
import { Stepper } from './Stepper';

interface Props {
  item: MenuItem;
  quantity: number;
  /** Already in the basket — the sheet must not let the total exceed stock. */
  alreadyInCart: number;
  onQuantity: (n: number) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * The misclick guard. A tile tap never adds directly — it opens this, and the
 * customer confirms which product and how many.
 */
export function ConfirmSheet({
  item,
  quantity,
  alreadyInCart,
  onQuantity,
  onCancel,
  onConfirm,
}: Props) {
  const remaining = Math.max(0, item.availableQuantity - alreadyInCart);
  const lineTotal = item.priceCents * quantity;

  return (
    <div className="tp-backdrop" onClick={onCancel}>
      <div className="tp-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="tp-sheet-head">
          <Art itemId={item.id} className="tp-sheet-art tp-art" />
          <div className="tp-sheet-info">
            <div className="tp-sheet-name">{item.name}</div>
            {item.description && <div className="tp-sheet-size">{item.description}</div>}
            <div className="tp-sheet-price">{formatCents(item.priceCents)}</div>
          </div>
        </div>

        <div className="tp-qty">
          <span className="tp-qty-label">How many?</span>
          <Stepper value={quantity} onChange={onQuantity} min={1} max={remaining} />
        </div>

        {quantity >= remaining && (
          <div className="tp-notice">
            {remaining === 1
              ? 'This is the last one in stock.'
              : `Only ${remaining} left in stock.`}
          </div>
        )}

        <div className="tp-sheet-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            Add {formatCents(lineTotal)} to basket
          </button>
        </div>
      </div>
    </div>
  );
}
