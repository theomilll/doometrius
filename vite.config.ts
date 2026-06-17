import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Allow access through tunnel hostnames (cloudflared) for remote multiplayer sessions.
    allowedHosts: true,
  },
});
