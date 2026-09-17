import { useEffect, useState } from 'react';
import { useSession } from './state/session';
import { Welcome } from './screens/Welcome';
import { Shop } from './screens/Shop';
import { Review } from './screens/Review';
import { Pay } from './screens/Pay';
import { Done } from './screens/Done';
import { ConfirmSheet } from './components/ConfirmSheet';
import { t } from './i18n';

/** The design is authored at a fixed 1080x1920 panel and scaled to fit. */
function useCanvasScale() {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const fit = () =>
      setScale(Math.min(window.innerWidth / 1080, window.innerHeight / 1920) * 0.96);
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  return scale;
}

export default function App() {
  const s = useSession();
  const scale = useCanvasScale();
  const a = s.actions;

  return (
    <div className="tp-viewport">
      <div
        className="tp-canvas"
        style={{ transform: `translate(-50%, -50%) scale(${scale})` }}
        onPointerDown={a.touch}
      >
        {s.screen === 'welcome' && <Welcome onStart={() => void a.start()} />}

        {s.screen === 'shop' && (
          <Shop
            menu={s.menu}
            cart={s.cart}
            itemCount={s.itemCount}
            totalCents={s.totals.totalCents}
            status={s.status}
            notice={s.failureMessage}
            menuError={s.menuError}
            busy={s.busy}
            onTile={a.openConfirm}
            onEmpty={a.emptyCart}
            onReview={a.goToReview}
          />
        )}

        {s.screen === 'review' && (
          <Review
            lines={s.lines}
            totals={s.totals}
            taxBasisPoints={s.store?.taxBasisPoints ?? 0}
            notice={s.failureMessage}
            busy={s.busy}
            onQuantity={a.setQuantity}
            onAddMore={a.goToShop}
            onPay={() => void a.goToPay()}
          />
        )}

        {s.screen === 'pay' && (
          <Pay
            totalCents={s.totals.totalCents}
            itemCount={s.itemCount}
            method={s.method}
            notice={s.failureMessage}
            busy={s.busy}
            onMethod={a.setMethod}
            onPay={() => void a.pay()}
            onCancel={() => void a.cancelPay()}
          />
        )}

        {s.screen === 'done' && (
          <Done
            result={s.result}
            amountCents={s.totals.totalCents}
            orderId={s.order?.id ?? s.supportReference}
            supportReference={s.supportReference}
            failureMessage={s.failureMessage}
            onRetry={() => void a.retryPayment()}
            onFinish={() => void a.endSession()}
          />
        )}

        {/* Overlay: the grid stays mounted underneath. */}
        {s.pending && (
          <ConfirmSheet
            product={s.pending}
            quantity={s.pendingQty}
            alreadyInCart={s.cart[s.pending.id] ?? 0}
            onQuantity={a.setPendingQty}
            onCancel={a.closeConfirm}
            onConfirm={a.confirmAdd}
          />
        )}

        {s.idlePrompt && (
          <div className="tp-overlay">
            <div className="tp-modal">
              <h3 className="tp-modal-title">{t('stillThere')}</h3>
              <p className="tp-modal-body">{t('stillThereBody')}</p>
              <button type="button" className="btn btn-primary" onClick={a.touch}>
                {t('imStillHere')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
