import { defineConfig } from 'vite';

export default defineConfig({
  // Относительные пути — сборка работает и на GitHub Pages (/CrewPay/), и в корне домена.
  base: './',
  build: { target: 'es2020' },
});
