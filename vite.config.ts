import { defineConfig } from 'vite';

export default defineConfig({
  // Относительные пути — сборка работает и в корне домена, и в подпапке.
  base: './',
  build: { target: 'es2020' },
  // В разработке API отдаёт `npm run dev:server` (порт 3000).
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
