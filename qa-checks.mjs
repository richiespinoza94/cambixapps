import fs from 'node:fs';

const read = f => fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
const exists = f => fs.existsSync(new URL(`./${f}`, import.meta.url));
const fail = msg => { throw new Error(msg); };

const config = read('config.js');
const app = read('app.js');
const html = read('index.html');
const css = read('styles.css');
const sql = read('supabase_auth_lock.sql');

// 1) Credenciales: nada privilegiado en el navegador.
const frontend = [config, app, html].join('\n');
if (/sb_secret_/i.test(frontend)) fail('Privileged sb_secret key found in frontend files');
if (/service_role/i.test(frontend)) fail('service_role reference found in frontend files');

// 2) Datos: ningun dato embebido que se pueda leer sin login.
if (exists('data-fallback.js')) fail('data-fallback.js debe borrarse del repo: expone datos sin login');
if (/data-fallback/i.test(html)) fail('index.html todavia referencia data-fallback.js');
if (/CAMBIX_FALLBACK_RATES/.test(app)) fail('app.js todavia usa datos de respaldo embebidos');

// 3) Acceso: pantalla de login y manejo de sesion.
for (const id of ['gate', 'gateGoogle', 'gateOther', 'signOutBtn']) {
  if (!html.includes(`id="${id}"`)) fail(`Falta #${id} en index.html`);
}
if (!html.includes('class="is-locked"')) fail('El body debe nacer bloqueado (is-locked)');
if (!html.includes('vendor/supabase-js-')) fail('Falta supabase-js local en index.html');
if (/cdn\.jsdelivr|unpkg|cdnjs/.test(html)) fail('No cargues scripts de CDN en la pagina de login');
if (!/allowedDomain:\s*'bancom\.pe'/.test(config)) fail('config.js debe declarar allowedDomain bancom.pe');
for (const token of ['signInWithOAuth', "provider:'google'", "flowType:'pkce'", 'is_allowed_user', "scope:'local'", 'Authorization: `Bearer ${token}`', 'AuthError']) {
  if (!app.includes(token)) fail(`app.js no contiene: ${token}`);
}
if (!css.includes('.is-locked .main-shell')) fail('Faltan estilos que ocultan la app mientras esta bloqueada');

// 4) SQL: el candado cierra la lectura anonima.
for (const token of ['is_allowed_user()', 'revoke all on table public.vw_rates_public from anon, authenticated', 'grant select on table public.vw_rates_public to authenticated', "bancom\\.pe", 'allowed_emails']) {
  if (!sql.includes(token)) fail(`supabase_auth_lock.sql no contiene: ${token}`);
}
if (/grant select on table public\.vw_rates_public to anon/.test(sql.replace(/^--.*$/gm, ''))) fail('El SQL activo no debe dar select a anon');

// 5) Regresiones previas: frescura por proveedor, auto-refresh, estado mobile.
for (const token of ['refreshMinutes', 'freshnessWarnMinutes', 'freshnessStaleMinutes']) {
  if (!config.includes(token)) fail(`Missing config ${token}`);
}
if (!app.includes('setInterval') || !app.includes('visibilitychange')) fail('Auto refresh hooks are missing');
if (!app.includes('providerFreshness') || !app.includes('renderFreshness')) fail('Provider freshness logic is missing');
if (!html.includes('id="freshnessBanner"') || !html.includes('id="mobileDataStatus"')) fail('Banner de frescura o estado mobile faltan');
if (!css.includes('.mobile-data-status') || !css.includes('.freshness-chip')) fail('Responsive status styles are missing');

const classify = (minutes, warn = 30, stale = 60) => minutes > stale ? 'stale' : minutes > warn ? 'delayed' : 'fresh';
if (classify(15) !== 'fresh' || classify(45) !== 'delayed' || classify(75) !== 'stale') fail('Freshness boundaries broken');

console.log('QA OK · sin datos embebidos · login Google · candado SQL · frescura · auto refresh');
