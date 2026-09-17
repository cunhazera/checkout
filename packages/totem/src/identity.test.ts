import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getIdentity, loadIdentity, setIdentity } from './identity';

const VALID = {
  storeId: 'a0000000-0000-4000-8000-000000000001',
  totemId: 'b0000000-0000-4000-8000-000000000001',
};

const respondWith = (body: unknown, ok = true) =>
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok, json: async () => body } as Response),
  );

beforeEach(() => setIdentity(null));
afterEach(() => vi.unstubAllGlobals());

describe('totem identity', () => {
  it('reads the device file at runtime', async () => {
    respondWith(VALID);
    expect(await loadIdentity()).toEqual(VALID);
    expect(getIdentity()).toEqual(VALID);
  });

  it('asks for a fresh copy, so re-provisioning takes effect on reload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => VALID } as Response);
    vi.stubGlobal('fetch', fetchMock);
    await loadIdentity();
    expect(fetchMock).toHaveBeenCalledWith('/totem.json', { cache: 'no-store' });
  });

  it.each([
    ['the file is missing', undefined, false],
    ['the file is empty', {}, true],
    ['the ids are not UUIDs', { storeId: 'store-1', totemId: 'totem-1' }, true],
    ['only one id is present', { storeId: VALID.storeId }, true],
  ])('returns nothing when %s', async (_label, body, ok) => {
    respondWith(body, ok);
    // An unprovisioned totem must not guess a store: serving the wrong store's
    // menu and prices is worse than serving none.
    expect(await loadIdentity()).toBeNull();
  });

  it('survives the request throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await loadIdentity()).toBeNull();
  });

  it('refuses to hand out an identity that was never loaded', () => {
    expect(() => getIdentity()).toThrow(/not been loaded/);
  });
});
