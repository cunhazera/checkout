import type { CartLine } from '../state/session';
import { formatCents } from '../money';
import { Art } from '../components/Art';
import { Stepper } from '../components/Stepper';
import { t } from '../i18n';

interface Props {
  lines: CartLine[];
  totals: { subtotalCents: number; taxCents: number; totalCents: number };
  taxBasisPoints: number;
  notice: string | null;
  busy: boolean;
  onQuantity: (productId: string, next: number) => void;
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
        <h2 className="tp-h2">{t('yourBasket')}</h2>
        <div className="tp-review-sub">{t('basketHint')}</div>
      </div>

      {notice && <div className="tp-notice">{notice}</div>}

      <div className="tp-lines">
        {empty ? (
          // The prototype's copy said "scan or tap"; there is no scanner.
          <div className="tp-empty">{t('basketEmpty')}</div>
        ) : (
          lines.map(({ product, quantity }) => (
            <div className="tp-line" key={product.id}>
              <Art productId={product.id} className="tp-line-art tp-art" />
              <div className="tp-line-info">
                <div className="tp-line-name">{product.name}</div>
                <div className="tp-line-meta">
                  {product.description
                    ? t('eachAndSize', {
                        price: formatCents(product.priceCents),
                        size: product.description,
                      })
                    : t('each', { price: formatCents(product.priceCents) })}
                </div>
              </div>
              <Stepper
                value={quantity}
                onChange={(n) => onQuantity(product.id, n)}
                min={0}
                max={product.availableQuantity}
              />
              <div className="tp-line-total">{formatCents(product.priceCents * quantity)}</div>
            </div>
          ))
        )}
      </div>

      <div className="tp-foot">
        <div className="tp-foot-row">
          <span>{t('subtotal')}</span>
          <span>{formatCents(totals.subtotalCents)}</span>
        </div>
        {/* Only shown when tax is actually configured — see PROGRESS.md. */}
        {taxBasisPoints > 0 && (
          <div className="tp-foot-row">
            <span>
              {t('tax', {
                percent: (taxBasisPoints / 100).toFixed(taxBasisPoints % 100 === 0 ? 0 : 2),
              })}
            </span>
            <span>{formatCents(totals.taxCents)}</span>
          </div>
        )}
        <div className="tp-total-row">
          <span className="tp-total-label">{t('total')}</span>
          <span className="tp-total-amount">{formatCents(totals.totalCents)}</span>
        </div>
        <div className="tp-foot-actions">
          <button type="button" className="btn btn-secondary" onClick={onAddMore}>
            {t('addMore')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onPay}
            disabled={empty || busy}
          >
            {busy ? t('reserving') : t('pay', { total: formatCents(totals.totalCents) })}
          </button>
        </div>
      </div>
    </div>
  );
}
