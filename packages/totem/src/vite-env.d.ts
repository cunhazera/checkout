/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** UUID of the store this totem belongs to. */
  readonly VITE_STORE_ID?: string;
  /** UUID of this totem, registered to that store. */
  readonly VITE_TOTEM_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
