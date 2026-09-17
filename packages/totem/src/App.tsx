import { useEffect, useState } from 'react';
import { loadIdentity } from './identity';
import { useSession } from './state/session';
import { Welcome } from './screens/Welcome';
import { Shop } from './screens/Shop';
import { Review } from './screens/Review';
import { Pay } from './screens/Pay';
import { Done } from './screens/Done';
import { OutOfService } from './screens/OutOfService';
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

/**
 * Nothing may call the API until the device knows which store it is, so the
 * identity is resolved before the checkout is mounted at all. A totem with no
 * identity says so rather than guessing a store — serving the wrong store's
 * prices would be worse than serving nothing.
 */
export default function App() {
  const [identity, setIdentity] = useState<'loading' | 'ready' | 'missing'>('loading');
  const scale = useCanvasScale();

  useEffect(() => {
    void loadIdentity().then((found) => setIdentity(found ? 'ready' : 'missing'));
  }, []);

  if (identity === 'loading') return <div className="tp-viewport" />;

  if (identity === 'missing') {
    return (
      <div className="tp-viewport">
        <div className="tp-canvas" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
          <OutOfService reason="unprovisioned" />
        </div>
      </div>
    );
  }

  return <Checkout />;
}

function Checkout() {
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
        {/* Takes over the screen: a customer who cannot be served must be
            told, not left tapping a display that looks alive. */}
        {s.serviceDown && <OutOfService reason="unreachable" />}

        {!s.serviceDown && s.screen === 'welcome' && <Welcome onStart={() => void a.start()} />}

        {!s.serviceDown && s.screen === 'shop' && (
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

        {!s.serviceDown && s.screen === 'review' && (
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

        {!s.serviceDown && s.screen === 'pay' && (
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

        {!s.serviceDown && s.screen === 'done' && (
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
        {!s.serviceDown && s.pending && (
          <ConfirmSheet
            product={s.pending}
            quantity={s.pendingQty}
            alreadyInCart={s.cart[s.pending.id] ?? 0}
            onQuantity={a.setPendingQty}
            onCancel={a.closeConfirm}
            onConfirm={a.confirmAdd}
          />
        )}

        {!s.serviceDown && s.idlePrompt && (
          <div className="tp-overlay">
            <div
              className="tp-modal"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="idle-title"
            >
              <h3 className="tp-modal-title" id="idle-title">
                {t('stillThere')}
              </h3>
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
