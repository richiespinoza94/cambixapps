import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./data-fallback.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox);
const rows = sandbox.window.CAMBIX_FALLBACK_RATES;

const frontend = ['config.js','app.js','index.html'].map(f => fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')).join('\n');
if (/sb_secret_/i.test(frontend)) throw new Error('Privileged sb_secret key found in frontend files');
if (/service_role/i.test(frontend)) throw new Error('service_role reference found in frontend files');
const providers = new Set(rows.map(r => r.provider));

if (!rows.length) throw new Error('Fallback data is empty');
if (providers.has('AVG_BANKS')) throw new Error('AVG_BANKS must never be exposed');
if (providers.has('IBK')) throw new Error('IBK proxy must not be exposed in the MVP');
for (const required of ['CAMBIX','REXTIE','TKAMBIO','TUCAMBISTA','KAMBISTA','SUNAT']) {
  if (!providers.has(required)) throw new Error(`Missing provider ${required}`);
}
if (rows.some(r => !(r.buy > 0) || !(r.sell > 0))) throw new Error('Non-positive rates found');

const latest = new Map();
for (const r of rows) {
  const dt = new Date(r.captured_at.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  const old = latest.get(r.provider);
  if (!old || dt > old.dt) latest.set(r.provider, { ...r, dt });
}
const competitors = ['CAMBIX','REXTIE','TKAMBIO','TUCAMBISTA','KAMBISTA'].map(p => latest.get(p));
const rank = (metric, asc) => {
  const sorted = [...competitors].sort((a,b) => asc ? a[metric]-b[metric] : b[metric]-a[metric]);
  const out = new Map(); let prev=null, current=0;
  sorted.forEach((r,i)=>{ if (prev===null || r[metric]!==prev) current=i+1; out.set(r.provider,current); prev=r[metric]; });
  return out;
};
const buyRank = rank('buy',false).get('CAMBIX');
const sellRank = rank('sell',true).get('CAMBIX');
if (buyRank !== 2) throw new Error(`Expected latest Cambix buy rank 2, got ${buyRank}`);
if (sellRank !== 5) throw new Error(`Expected latest Cambix sell rank 5, got ${sellRank}`);

console.log(`QA OK · ${rows.length} filas · Cambix compra #${buyRank} · venta #${sellRank}`);

// P0 regression checks: freshness transparency + auto refresh + mobile live/fallback state.
const configSource = fs.readFileSync(new URL('./config.js', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const htmlSource = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const cssSource = fs.readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

for (const token of ['refreshMinutes', 'freshnessWarnMinutes', 'freshnessStaleMinutes']) {
  if (!configSource.includes(token)) throw new Error(`Missing P0 config ${token}`);
}
if (!appSource.includes('setInterval') || !appSource.includes('visibilitychange')) throw new Error('Auto refresh hooks are missing');
if (!appSource.includes('providerFreshness') || !appSource.includes('renderFreshness')) throw new Error('Provider freshness logic is missing');
if (!htmlSource.includes('id="freshnessBanner"')) throw new Error('Freshness warning banner is missing');
if (!htmlSource.includes('id="mobileDataStatus"')) throw new Error('Mobile data status is missing');
if (!cssSource.includes('.mobile-data-status') || !cssSource.includes('.freshness-chip')) throw new Error('P0 responsive status styles are missing');

// Synthetic freshness boundary check: 45 minutes behind must be delayed; 75 must be stale.
const classify = (minutes, warn=30, stale=60) => minutes > stale ? 'stale' : minutes > warn ? 'delayed' : 'fresh';
if (classify(15) !== 'fresh') throw new Error('15m should be fresh');
if (classify(45) !== 'delayed') throw new Error('45m should be delayed');
if (classify(75) !== 'stale') throw new Error('75m should be stale');

console.log('P0 QA OK · frescura por proveedor · auto refresh · estado mobile live/fallback');
