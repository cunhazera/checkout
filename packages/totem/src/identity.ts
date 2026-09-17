/**
 * Which store and totem this device is.
 *
 * Read at runtime from `/totem.json`, written by provisioning *after* the disk
 * image is laid down. Fleets are built by cloning one image, so anything
 * compiled into the bundle is duplicated across every device made from it —
 * and duplicate totem ids are indistinguishable from legitimate ones, which
 * quietly kills per-device attribution and reconciliation.
 *
 * In development the VITE_* variables still work, because typing a UUID into a
 * JSON file to run the app locally is friction with no benefit. They are
 * ignored in a production build.
 */

export interface TotemIdentity {
  storeId: string;
  totemId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let identity: TotemIdentity | null = null;

/** Throws if called before the identity is loaded — a programming error. */
export function getIdentity(): TotemIdentity {
  if (!identity) throw new Error('totem identity has not been loaded');
  return identity;
}

export function setIdentity(next: TotemIdentity | null): void {
  identity = next;
}

/**
 * Returns null when the device has no usable identity. That is not a crash:
 * an unprovisioned totem shows the out-of-service screen, because serving a
 * menu for the wrong store would be worse than serving nothing.
 */
export async function loadIdentity(): Promise<TotemIdentity | null> {
  if (import.meta.env.DEV) {
    const storeId = import.meta.env.VITE_STORE_ID;
    const totemId = import.meta.env.VITE_TOTEM_ID;
    if (storeId && totemId) return accept({ storeId, totemId });
  }

  try {
    // no-store: a provisioning change must take effect on reload, not whenever
    // the kiosk browser feels like revalidating.
    const res = await fetch('/totem.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const { storeId, totemId } = (body ?? {}) as Partial<TotemIdentity>;
    if (typeof storeId !== 'string' || typeof totemId !== 'string') return null;
    return accept({ storeId, totemId });
  } catch {
    return null;
  }
}

function accept(candidate: TotemIdentity): TotemIdentity | null {
  // A malformed id would reach the API as a 400 on every request, which reads
  // like a broken server rather than a mis-provisioned device.
  if (!UUID.test(candidate.storeId) || !UUID.test(candidate.totemId)) return null;
  identity = candidate;
  return identity;
}
