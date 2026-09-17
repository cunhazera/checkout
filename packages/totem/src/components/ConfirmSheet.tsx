import type { Product } from '../api/types';
import { formatCents } from '../money';
import { Art } from './Art';
import { Stepper } from './Stepper';
import { t } from '../i18n';

interface Props {
  product: Product;
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
  product,
  quantity,
  alreadyInCart,
  onQuantity,
  onCancel,
  onConfirm,
}: Props) {
  const remaining = Math.max(0, product.availableQuantity - alreadyInCart);
  const lineTotal = product.priceCents * quantity;

  return (
    <div className="tp-backdrop" onClick={onCancel}>
      <div className="tp-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="tp-sheet-head">
          <Art productId={product.id} className="tp-sheet-art tp-art" />
          <div className="tp-sheet-info">
            <div className="tp-sheet-name">{product.name}</div>
            {product.description && <div className="tp-sheet-size">{product.description}</div>}
            <div className="tp-sheet-price">{formatCents(product.priceCents)}</div>
          </div>
        </div>

        <div className="tp-qty">
          <span className="tp-qty-label">{t('howMany')}</span>
          <Stepper value={quantity} onChange={onQuantity} min={1} max={remaining} />
        </div>

        {quantity >= remaining && (
          <div className="tp-notice">
            {remaining === 1 ? t('lastOneInStock') : t('onlyNLeft', { n: remaining })}
          </div>
        )}

        <div className="tp-sheet-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            {t('addToBasket', { total: formatCents(lineTotal) })}
          </button>
        </div>
      </div>
    </div>
  );
}
