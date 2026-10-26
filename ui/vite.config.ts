import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The desktop shell loads the built UI from kod://app (relative asset paths); `npm run dev` serves it on :5173.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
  },
  worker: { format: 'es' },
});
