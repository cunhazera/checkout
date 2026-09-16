import type { MenuItem } from '../api/types';
import { formatCents } from '../money';
import { Art } from '../components/Art';
import { itemCountLabel, t } from '../i18n';

interface Props {
  menu: MenuItem[];
  cart: Record<string, number>;
  itemCount: number;
  totalCents: number;
  status: string;
  notice: string | null;
  menuError: string | null;
  busy: boolean;
  onTile: (itemId: string) => void;
  onEmpty: () => void;
  onReview: () => void;
}

export function Shop({
  menu,
  cart,
  itemCount,
  totalCents,
  status,
  notice,
  menuError,
  busy,
  onTile,
  onEmpty,
  onReview,
}: Props) {
  return (
    <div className="tp-screen">
      <div className="tp-head">
        <h2 className="tp-h2">{t('addYourItems')}</h2>
        <button type="button" className="btn btn-ghost" onClick={onEmpty} disabled={itemCount === 0}>
          {t('emptyBasket')}
        </button>
      </div>

      <div className="tp-subrow">
        <span>{t('shopHint')}</span>
        <span className="tp-status">{status}</span>
      </div>

      {menuError && <div className="tp-notice tp-notice-bad">{menuError}</div>}
      {notice && <div className="tp-notice">{notice}</div>}

      <div className="tp-grid">
        {menu.map((item) => {
          const inCart = cart[item.id] ?? 0;
          // The design has no stock concept; the arch doc's edge-case table
          // requires sold-out items to be visibly unavailable, not hidden.
          const soldOut = item.outOfStock || inCart >= item.availableQuantity;
          return (
            <button
              key={item.id}
              type="button"
              className={`tp-tile${inCart > 0 ? ' is-selected' : ''}`}
              onClick={() => onTile(item.id)}
              disabled={soldOut}
            >
              <Art itemId={item.id} className="tp-art" />
              <div className="tp-tile-name">{item.name}</div>
              {item.description && <div className="tp-tile-size">{item.description}</div>}
              <div className="tp-tile-foot">
                <span className="tp-price">{formatCents(item.priceCents)}</span>
                <span
                  className={`tp-badge${inCart > 0 ? ' is-in-cart' : ''}${
                    item.outOfStock ? ' is-out' : ''
                  }`}
                >
                  {item.outOfStock
                    ? t('badgeSoldOut')
                    : inCart > 0
                      ? t('badgeInBasket', { n: inCart })
                      : soldOut
                        ? t('badgeAllInBasket')
                        : t('badgeAdd')}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="tp-bar">
        <div>
          <div className="tp-bar-count">{itemCountLabel(itemCount)}</div>
          <div className="tp-bar-total">{formatCents(totalCents)}</div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onReview}
          disabled={itemCount === 0 || busy}
        >
          {t('reviewAndPay')}
        </button>
      </div>
    </div>
  );
}
