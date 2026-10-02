// Сборка предпросмотра в один HTML-файл (для встроенного просмотра, например claude.ai artifact).
// Результат: dist-embed/crewpay.html + dist-embed/regulation.json
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const out = 'dist-embed';
execSync(`npx vite build --outDir ${out} --emptyOutDir`, {
  stdio: 'inherit',
  env: { ...process.env, VITE_TARGET: 'embed' },
});

const assets = join(out, 'assets');
const files = readdirSync(assets);
const css = files.filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(assets, f), 'utf8')).join('\n');
const js = files
  .filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(join(assets, f), 'utf8').replace(/<\/script/gi, '<\\/script'))
  .join('\n');

// Необязательный готовый аккаунт для предпросмотра: SEED=путь/к/crewpay-backup.json npm run build:embed
// Файл с личными данными в репозиторий не попадает — передаётся только через переменную окружения.
const seedPath = process.env.SEED;
const seed =
  seedPath && existsSync(seedPath)
    ? `<script>window.__CREWPAY_SEED__=${JSON.stringify(JSON.parse(readFileSync(seedPath, 'utf8'))).replace(/</g, '\\u003c')};</script>\n`
    : '';

const html = `<title>CrewPay</title>
<meta name="description" content="Калькулятор месячного налёта и сдельной оплаты экипажа по Положению MF.FD3-01" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Onest:wght@400;500;600;700&family=Unbounded:wght@500;600;700&display=swap" />
${seed}<style>
${css}
</style>
<div id="app"></div>
<script type="module">
${js}
</script>
`;
writeFileSync(join(out, 'crewpay.html'), html);
rmSync(assets, { recursive: true });
rmSync(join(out, 'index.html'));
console.log(`✓ ${out}/crewpay.html (${(html.length / 1024).toFixed(1)} KB)`);
