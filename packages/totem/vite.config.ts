/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API binds to loopback (ADR-002 has no auth, so it must never be exposed).
// In dev the totem is served by Vite on another port, so /api is proxied.
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3210';

export default defineConfig({
  plugins: [react()],
  test: {
    // The screens are DOM components; the state machine is a hook. Both need a
    // document, and jsdom is enough — none of this depends on real layout.
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.{ts,tsx}'],
  },
  server: {
    // Bind IPv4 explicitly: Vite otherwise listens on [::1] only, and a
    // kiosk browser pointed at 127.0.0.1 would be refused.
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
});
