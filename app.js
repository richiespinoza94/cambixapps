(() => {
  'use strict';

  const COMPETITORS = ['CAMBIX', 'REXTIE', 'TKAMBIO', 'TUCAMBISTA', 'KAMBISTA'];
  const COLORS = { CAMBIX:'#0c6b6f', REXTIE:'#6689a0', TKAMBIO:'#9b6f87', TUCAMBISTA:'#a37643', KAMBISTA:'#687d5a', SUNAT:'#8492a3' };
  const state = { rows: [], dataMode: 'fallback', connectionState:'idle', refreshing:false, lastRefreshAt:0, refreshTimer:null, overviewMetric:'buy', marketMetric:'buy', historyMetric:'buy', period:'24', view:'pulse', slide:0 };
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];
  const fmtRate = n => Number(n).toFixed(4);
  const fmtSigned = n => `${n >= 0 ? '+' : ''}${Number(n).toFixed(4)}`;
  const fmtMoney = n => `${n >= 0 ? '+' : '-'} S/${Math.abs(n).toFixed(2)}`;
  const parseDate = value => new Date(String(value).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  const formatPeru = d => { const parts = Object.fromEntries(new Intl.DateTimeFormat('es-PE', { timeZone:'America/Lima', day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', hour12:false }).formatToParts(d).filter(p=>p.type!=='literal').map(p=>[p.type,p.value])); return `${parts.day} ${String(parts.month).replace('.', '').toUpperCase()} · ${parts.hour}:${parts.minute}`; };
  const escapeHtml = s => String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

  async function loadRows({ allowFallback = true, quiet = false } = {}) {
    const cfg = window.CAMBIX_CONFIG || {};
    if (cfg.supabaseUrl && cfg.supabasePublishableKey) {
      try {
        const cutoff = new Date(Date.now() - (Number(cfg.liveDays || 7) * 864e5)).toISOString();
        const base = `${cfg.supabaseUrl.replace(/\/$/,'')}/rest/v1/${encodeURIComponent(cfg.liveView || 'vw_rates_public')}`;
        const pageSize = 1000;
        const rows = [];
        for (let offset = 0; ; offset += pageSize) {
          const url = `${base}?select=captured_at,provider,provider_type,buy,sell,spread&captured_at=gte.${encodeURIComponent(cutoff)}&order=captured_at.asc,provider.asc&limit=${pageSize}&offset=${offset}`;
          const res = await fetch(url, { headers: { apikey: cfg.supabasePublishableKey } });
          if (!res.ok) throw new Error(`Supabase ${res.status}`);
          const page = await res.json();
          if (!Array.isArray(page)) throw new Error('Respuesta inválida de Supabase');
          rows.push(...page);
          if (page.length < pageSize) break;
        }
        if (!rows.length) throw new Error('Sin filas en la vista pública');
        state.dataMode = 'live';
        state.connectionState = 'healthy';
        return rows.map(normalizeRow);
      } catch (err) {
        console.warn('Live load failed.', err);
        if (!allowFallback && state.rows.length) {
          state.connectionState = 'degraded';
          if (!quiet) showToast('No se pudo actualizar; conservamos la última lectura en vivo.');
          return null;
        }
        if (!quiet) showToast('Supabase no respondió; mostrando el último CSV disponible.');
      }
    }
    state.dataMode = 'fallback';
    state.connectionState = 'fallback';
    return (window.CAMBIX_FALLBACK_RATES || []).map(normalizeRow);
  }

  function normalizeRow(r) {
    return { captured_at:r.captured_at, dt:parseDate(r.captured_at), provider:String(r.provider).toUpperCase(), provider_type:r.provider_type, buy:Number(r.buy), sell:Number(r.sell), spread:Number(r.spread) };
  }

  function latestByProvider(rows) {
    const map = new Map();
    for (const row of rows) if (!map.has(row.provider) || row.dt > map.get(row.provider).dt) map.set(row.provider, row);
    return map;
  }

  function rankMap(latest, metric) {
    const sorted = COMPETITORS.map(p => latest.get(p)).filter(Boolean).sort((a,b) => metric === 'buy' ? b.buy-a.buy : a.sell-b.sell);
    const ranks = new Map();
    let previous = null, rank = 0;
    sorted.forEach((r,i) => {
      const value = r[metric];
      if (previous === null || value !== previous) rank = i + 1;
      ranks.set(r.provider, rank);
      previous = value;
    });
    return { sorted, ranks };
  }

  function lastChange(rows, provider) {
    const rr = rows.filter(r => r.provider === provider).sort((a,b) => a.dt-b.dt);
    if (!rr.length) return null;
    let changed = rr[0].dt;
    for (let i=1;i<rr.length;i++) if (rr[i].buy !== rr[i-1].buy || rr[i].sell !== rr[i-1].sell) changed = rr[i].dt;
    return changed;
  }

  function freshnessConfig() {
    const cfg = window.CAMBIX_CONFIG || {};
    const warn = Number(cfg.freshnessWarnMinutes || 30);
    const stale = Math.max(warn, Number(cfg.freshnessStaleMinutes || 60));
    return { warn, stale };
  }

  function providerFreshness(latest, reference) {
    const { warn, stale } = freshnessConfig();
    const out = new Map();
    for (const [provider, row] of latest) {
      const minutes = Math.max(0, Math.round((reference - row.dt) / 60000));
      const status = minutes > stale ? 'stale' : minutes > warn ? 'delayed' : 'fresh';
      out.set(provider, { minutes, status, lastCapture: row.dt });
    }
    return out;
  }

  function freshnessLabel(freshness) {
    if (!freshness || freshness.status === 'fresh') return 'Al día';
    return `${freshness.minutes} min detrás`;
  }

  function metrics(rows) {
    const latest = latestByProvider(rows);
    const cambix = latest.get('CAMBIX');
    const sunat = latest.get('SUNAT');
    const buyRanks = rankMap(latest,'buy');
    const sellRanks = rankMap(latest,'sell');
    const peers = COMPETITORS.filter(p => p !== 'CAMBIX').map(p => latest.get(p)).filter(Boolean);
    const avgBuy = peers.reduce((s,r)=>s+r.buy,0) / peers.length;
    const avgSell = peers.reduce((s,r)=>s+r.sell,0) / peers.length;
    const maxDt = rows.reduce((m,r)=>r.dt>m?r.dt:m, rows[0].dt);
    const freshness = providerFreshness(latest, maxDt);
    const freshnessIssues = [...COMPETITORS, 'SUNAT']
      .map(provider => ({ provider, freshness: freshness.get(provider) }))
      .filter(item => item.freshness && item.freshness.status !== 'fresh');
    return {
      latest, cambix, sunat, buyRanks, sellRanks, avgBuy, avgSell, freshness, freshnessIssues,
      gapBuy:cambix.buy-avgBuy, gapSell:cambix.sell-avgSell,
      sunatGapBuy:sunat ? cambix.buy-sunat.buy : null,
      sunatGapSell:sunat ? cambix.sell-sunat.sell : null,
      lastCapture:maxDt, lastCambixChange:lastChange(rows,'CAMBIX')
    };
  }

  function signal(rank,total,metric) {
    if (rank === 1) return { cls:'positive', text:'▲ Lidera el mercado' };
    if (rank <= 2) return { cls:'positive', text:'▲ Posición competitiva' };
    if (rank === total) return { cls:'negative', text: metric === 'sell' ? '▼ Venta menos competitiva' : '▼ Rezagada frente al mercado' };
    return { cls:'neutral', text:'● Posición intermedia' };
  }

  function gapState(gap, metric) {
    const good = metric === 'buy' ? gap > 0 : gap < 0;
    const almost = Math.abs(gap) < 0.00005;
    if (almost) return { cls:'neutral', text:'● En línea con el mercado' };
    return good ? { cls:'positive', text:'▲ Favorable vs mercado' } : { cls:'negative', text:'▼ Desfavorable vs mercado' };
  }

  function renderPulse(m) {
    const buyRank = m.buyRanks.ranks.get('CAMBIX');
    const sellRank = m.sellRanks.ranks.get('CAMBIX');
    const total = m.buyRanks.sorted.length;
    $('buyValue').textContent = fmtRate(m.cambix.buy); $('sellValue').textContent = fmtRate(m.cambix.sell); $('spreadValue').textContent = fmtRate(m.cambix.spread);
    $('buyRank').textContent = `#${buyRank}`; $('sellRank').textContent = `#${sellRank}`; $('buyRankText').textContent = `de ${total}`; $('sellRankText').textContent = `de ${total}`;
    const bSig=signal(buyRank,total,'buy'), sSig=signal(sellRank,total,'sell');
    $('buySignal').className=`signal ${bSig.cls}`; $('buySignal').textContent=bSig.text; $('sellSignal').className=`signal ${sSig.cls}`; $('sellSignal').textContent=sSig.text;
    $('buyMiniRank').textContent=`#${buyRank} de ${total}`; $('sellMiniRank').textContent=`#${sellRank} de ${total}`;
    $('latestCapture').textContent=formatPeru(m.lastCapture);
    $('captureMode').textContent=state.dataMode==='live'?(state.connectionState==='healthy'?'Supabase · lectura en vivo':'Supabase · última lectura disponible'):'CSV de respaldo';
    $('lastChangeText').textContent=`Último cambio ${formatPeru(m.lastCambixChange)}`;
    renderFreshness(m);

    renderBand($('buyBand'),m,'buy','Compra'); renderBand($('sellBand'),m,'sell','Venta');
    renderGapCard('buy',m.gapBuy); renderGapCard('sell',m.gapSell);
    $('sunatBuyGap').textContent=fmtSigned(m.sunatGapBuy); $('sunatSellGap').textContent=fmtSigned(m.sunatGapSell); $('sunatRates').textContent=`SUNAT ${fmtRate(m.sunat.buy)} / ${fmtRate(m.sunat.sell)}`;

    const buyImpact=m.gapBuy*1000, sellImpact=m.gapSell*1000;
    const buyPhrase = buyRank <= 2 ? `mantiene una posición competitiva en compra (#${buyRank})` : `está en posición #${buyRank} en compra`;
    const sellPhrase = sellRank === total ? `presenta la venta más alta de las ${total} casas monitoreadas` : `se ubica #${sellRank} en venta`;
    $('insightText').textContent=`Cambix ${buyPhrase}, pero actualmente ${sellPhrase}. Frente al promedio de competidores, la diferencia equivale a ${fmtMoney(Math.abs(buyImpact)).replace(/[+-]\s?/,'')} por US$1,000 en compra y ${fmtMoney(Math.abs(sellImpact)).replace(/[+-]\s?/,'')} por US$1,000 en venta.`;

    renderCompactRanking($('buyRankingCompact'),m.buyRanks.sorted,m.buyRanks.ranks,'buy');
    renderCompactRanking($('sellRankingCompact'),m.sellRanks.sorted,m.sellRanks.ranks,'sell');
    renderLineChart($('overviewChart'), filteredRows(state.rows,24), state.overviewMetric, COMPETITORS, 280);
    renderLegend($('overviewLegend'), COMPETITORS);
    renderPresentation(m);
  }

  function renderFreshness(m) {
    const banner = $('freshnessBanner');
    const issues = m.freshnessIssues.filter(item => item.provider !== 'SUNAT' || item.freshness.status === 'stale');
    if (!issues.length) { banner.hidden = true; banner.classList.remove('is-stale'); return; }
    banner.hidden = false;
    banner.classList.toggle('is-stale', issues.some(item => item.freshness.status === 'stale'));
    const detail = issues.map(item => `${displayName(item.provider)} ${freshnessLabel(item.freshness).toLowerCase()}`).join(' · ');
    $('freshnessBannerText').textContent = `${detail}. El ranking usa el último dato disponible de cada fuente.`;
  }

  function updateDataStatus(m) {
    const ageMinutes = Math.max(0, Math.floor((Date.now() - m.lastCapture.getTime()) / 60000));
    let mode = 'fallback';
    let label = `Respaldo CSV · ${formatPeru(m.lastCapture)}`;
    if (state.dataMode === 'live') {
      if (state.connectionState === 'degraded') {
        mode = 'degraded';
        label = `Actualización pendiente · última lectura ${formatPeru(m.lastCapture)}`;
      } else if (ageMinutes > freshnessConfig().warn) {
        mode = 'degraded';
        label = `Sin nueva captura hace ${ageMinutes} min · ${formatPeru(m.lastCapture)}`;
      } else {
        mode = 'live';
        label = `Supabase en vivo · ${formatPeru(m.lastCapture)}`;
      }
    }
    $('dataStatus').innerHTML = `<span class="status-dot ${mode==='live'?'live':mode==='degraded'?'degraded':''}" aria-hidden="true"></span><span>${escapeHtml(label)}</span>`;
    const mobile = $('mobileDataStatus');
    mobile.className = `mobile-data-status ${mode}`;
    mobile.innerHTML = `<span class="status-dot ${mode==='live'?'live':mode==='degraded'?'degraded':''}" aria-hidden="true"></span><span>${escapeHtml(label)}</span>`;
  }

  function renderGapCard(metric,gap) {
    const stateGap=gapState(gap,metric), impact=gap*1000;
    const card=$(metric==='buy'?'buyGapCard':'sellGapCard');
    card.classList.remove('is-positive','is-negative'); card.classList.add(stateGap.cls==='positive'?'is-positive':stateGap.cls==='negative'?'is-negative':'');
    $(metric==='buy'?'buyGapMoney':'sellGapMoney').textContent=fmtMoney(impact);
    $(metric==='buy'?'buyGapRaw':'sellGapRaw').textContent=`${fmtSigned(gap)} vs promedio`;
    const target=$(metric==='buy'?'buyGapState':'sellGapState'); target.className=`delta-state ${stateGap.cls}`; target.textContent=stateGap.text;
  }

  function renderBand(container,m,metric,label) {
    const ranking=metric==='buy'?m.buyRanks:m.sellRanks;
    const rows=ranking.sorted, values=rows.map(r=>r[metric]);
    const best=rows[0], worst=rows[rows.length-1], min=Math.min(...values), max=Math.max(...values), span=max-min || 1;
    const direction = metric==='buy' ? v => (v-min)/span : v => (max-v)/span;
    const points=rows.map(r=>`<span class="band-point ${r.provider==='CAMBIX'?'cambix':''}" style="left:${8+direction(r[metric])*84}%" title="${escapeHtml(r.provider)} ${fmtRate(r[metric])}"></span>`).join('');
    const cambix=rows.find(r=>r.provider==='CAMBIX');
    const cx=8+direction(cambix[metric])*84;
    const labelCls=cx>70?'band-cambix-label band-cambix-label--right':'band-cambix-label';
    container.innerHTML=`<div class="${labelCls}" style="left:${cx}%">CAMBIX<strong>${fmtRate(cambix[metric])}</strong></div><div class="band-track">${points}</div><div class="band-edge left"><span>Mejor ${label.toLowerCase()}</span><strong>${escapeHtml(best.provider)} · ${fmtRate(best[metric])}</strong></div><div class="band-edge right"><span>Peor ${label.toLowerCase()}</span><strong>${escapeHtml(worst.provider)} · ${fmtRate(worst[metric])}</strong></div>`;
  }

  function renderCompactRanking(container, rows, ranks, metric) {
    container.innerHTML=rows.map(r=>`<div class="rank-row ${r.provider==='CAMBIX'?'cambix':''}"><span class="pos">#${ranks.get(r.provider)}</span><span>${escapeHtml(displayName(r.provider))}</span><span class="value">${fmtRate(r[metric])}</span></div>`).join('');
  }

  function nearestRival(ranking) {
    const idx = ranking.sorted.findIndex(r => r.provider === 'CAMBIX');
    if (idx === -1) return null;
    const leading = idx === 0;
    const rival = leading ? ranking.sorted[1] : ranking.sorted[idx - 1];
    return rival ? { rival, leading } : null;
  }

  function displayName(p) { return p==='TKAMBIO'?'TKambio':p==='TUCAMBISTA'?'Tucambista':p==='KAMBISTA'?'Kambista':p==='REXTIE'?'Rextie':p==='CAMBIX'?'Cambix':p; }

  function filteredRows(rows,hours) {
    if (hours==='all') return rows;
    const max=rows.reduce((m,r)=>r.dt>m?r.dt:m,rows[0].dt); const cutoff=new Date(max.getTime()-Number(hours)*3600000); return rows.filter(r=>r.dt>=cutoff);
  }

  function changeOnly(rows,provider,metric) {
    const rr=rows.filter(r=>r.provider===provider).sort((a,b)=>a.dt-b.dt); const out=[];
    for (const r of rr) if (!out.length || out[out.length-1][metric]!==r[metric]) out.push(r);
    if (rr.length && out[out.length-1]!==rr[rr.length-1]) out.push(rr[rr.length-1]);
    return out;
  }

  function renderLineChart(container, rows, metric, providers, height=280) {
    if (!rows.length) { container.innerHTML='<p class="section-copy">Sin datos para este periodo.</p>'; return; }
    const all=providers.flatMap(p=>changeOnly(rows,p,metric));
    if (!all.length) return;
    const minT=Math.min(...all.map(r=>r.dt.getTime())), maxT=Math.max(...all.map(r=>r.dt.getTime()));
    let minV=Math.min(...all.map(r=>r[metric])), maxV=Math.max(...all.map(r=>r[metric]));
    const pad=(maxV-minV)*.2 || .01; minV-=pad; maxV+=pad;
    const W=Math.max(320, Math.round(container.getBoundingClientRect().width || 1000)),H=height,P={l:W<500?42:58,r:W<500?10:20,t:16,b:34};
    const x=t=>P.l+(t-minT)/(maxT-minT||1)*(W-P.l-P.r), y=v=>P.t+(maxV-v)/(maxV-minV||1)*(H-P.t-P.b);
    const ticks=4, grid=Array.from({length:ticks+1},(_,i)=>{const v=maxV-(maxV-minV)*i/ticks, yy=y(v);return `<line class="chart-gridline" x1="${P.l}" y1="${yy}" x2="${W-P.r}" y2="${yy}"/><text class="chart-axis-label" x="4" y="${yy+3}">${v.toFixed(3)}</text>`}).join('');
    const tLabels=[0,.5,1].map(fr=>{const t=minT+(maxT-minT)*fr; return `<text class="chart-axis-label" x="${x(t)}" y="${H-8}" text-anchor="${fr===0?'start':fr===1?'end':'middle'}">${new Intl.DateTimeFormat('es-PE',{timeZone:'America/Lima',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(t))}</text>`}).join('');
    const paths=providers.map(p=>{const rr=changeOnly(rows,p,metric);if(!rr.length)return'';const points=rr.map(r=>`${x(r.dt.getTime()).toFixed(1)},${y(r[metric]).toFixed(1)}`).join(' '); const last=rr[rr.length-1]; return `<polyline class="chart-path ${p==='CAMBIX'?'cambix':''}" points="${points}" style="stroke:${COLORS[p]||'#8293a1'}"/><circle class="chart-dot" cx="${x(last.dt.getTime())}" cy="${y(last[metric])}" r="${p==='CAMBIX'?5:3}" fill="${COLORS[p]||'#8293a1'}"/>`;}).join('');
    container.innerHTML=`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${grid}${paths}${tLabels}</svg>`;
  }

  function renderLegend(container,providers) { container.innerHTML=providers.map(p=>`<span class="legend-item ${p==='CAMBIX'?'cambix':''}" style="color:${COLORS[p]}"><i class="legend-line"></i>${escapeHtml(displayName(p))}</span>`).join(''); }

  function renderMarket(m) {
    const metric=state.marketMetric, rank=metric==='buy'?m.buyRanks:m.sellRanks, avg=metric==='buy'?m.avgBuy:m.avgSell;
    const vals=rank.sorted.map(r=>r[metric]), lo=Math.min(...vals), hi=Math.max(...vals), span=hi-lo||1;
    $('marketSummary').textContent=metric==='buy'?'Compra: una tasa más alta es mejor para quien vende dólares.':'Venta: una tasa más baja es mejor para quien compra dólares.';
    $('marketBars').innerHTML=rank.sorted.map(r=>{const normalized=metric==='buy'?(r[metric]-lo)/span:(hi-r[metric])/span; return `<div class="market-bar-row ${r.provider==='CAMBIX'?'cambix':''}"><span class="bar-rank">#${rank.ranks.get(r.provider)}</span><span class="bar-provider">${escapeHtml(displayName(r.provider))}</span><div class="bar-track"><div class="bar-fill" style="width:${18+normalized*82}%"></div></div><span class="bar-value">${fmtRate(r[metric])}</span></div>`;}).join('');
    $('marketAvgValue').textContent=fmtRate(avg); $('marketAvgLabel').textContent=metric==='buy'?'Compra promedio sin Cambix':'Venta promedio sin Cambix';
    const best=rank.sorted[0]; $('marketBestValue').textContent=fmtRate(best[metric]); $('marketBestProvider').textContent=displayName(best.provider);
    $('marketCambixValue').textContent=fmtRate(m.cambix[metric]); $('marketCambixRank').textContent=`#${rank.ranks.get('CAMBIX')} de ${rank.sorted.length}`;
    renderComparisonTable(m);
  }

  function renderComparisonTable(m) {
    const rows=COMPETITORS.map(p=>m.latest.get(p)).filter(Boolean);
    const freshnessCell = r => {
      const f=m.freshness.get(r.provider);
      return `<span class="freshness-chip ${f?.status||'fresh'}">${escapeHtml(freshnessLabel(f))}</span><small class="freshness-time">${formatPeru(r.dt)}</small>`;
    };
    const table=`<table class="comparison-table"><thead><tr><th>Proveedor</th><th>Compra</th><th>Rank compra</th><th>Venta</th><th>Rank venta</th><th>Spread</th><th>Frescura</th></tr></thead><tbody>${rows.map(r=>`<tr class="${r.provider==='CAMBIX'?'cambix':''}"><td>${escapeHtml(displayName(r.provider))}</td><td class="num">${fmtRate(r.buy)}</td><td class="num">#${m.buyRanks.ranks.get(r.provider)}</td><td class="num">${fmtRate(r.sell)}</td><td class="num">#${m.sellRanks.ranks.get(r.provider)}</td><td class="num">${fmtRate(r.spread)}</td><td>${freshnessCell(r)}</td></tr>`).join('')}</tbody></table>`;
    const cards=`<div class="mobile-provider-cards">${rows.map(r=>`<article class="provider-card ${r.provider==='CAMBIX'?'cambix':''}"><div class="provider-card__head"><strong>${escapeHtml(displayName(r.provider))}</strong><span class="provider-card__rank">#${m.buyRanks.ranks.get(r.provider)} compra · #${m.sellRanks.ranks.get(r.provider)} venta</span></div><div class="provider-card__rates"><div><span>Compra</span><strong>${fmtRate(r.buy)}</strong></div><div><span>Venta</span><strong>${fmtRate(r.sell)}</strong></div></div><div class="provider-card__freshness"><span class="freshness-chip ${m.freshness.get(r.provider)?.status||'fresh'}">${escapeHtml(freshnessLabel(m.freshness.get(r.provider)))}</span><small class="freshness-time">${formatPeru(r.dt)}</small></div></article>`).join('')}</div>`;
    $('comparisonTable').innerHTML=table+cards;
  }

  function renderHistory(m) {
    const rows=filteredRows(state.rows,state.period);
    renderLineChart($('historyChart'),rows,state.historyMetric,COMPETITORS,470); renderLegend($('historyLegend'),COMPETITORS);
    $('historyLastCapture').textContent=formatPeru(m.lastCapture); $('historyLastChange').textContent=formatPeru(m.lastCambixChange);
  }

  function renderPresentation(m) {
    const br=m.buyRanks.ranks.get('CAMBIX'), sr=m.sellRanks.ranks.get('CAMBIX'), total=m.buyRanks.sorted.length;
    $('slideBuy').textContent=fmtRate(m.cambix.buy); $('slideSell').textContent=fmtRate(m.cambix.sell); $('slideBuyRank').textContent=`#${br} de ${total}`; $('slideSellRank').textContent=`#${sr} de ${total}`; $('slideCapture').textContent=`Última captura: ${formatPeru(m.lastCapture)} · Perú`;
    const buyRival=nearestRival(m.buyRanks), sellRival=nearestRival(m.sellRanks);
    $('slideBuyNext').textContent=buyRival?`${buyRival.leading?'Le sigue':'Le falta alcanzar a'} ${displayName(buyRival.rival.provider)} · ${fmtRate(buyRival.rival.buy)}`:'';
    $('slideSellNext').textContent=sellRival?`${sellRival.leading?'Le sigue':'Le falta alcanzar a'} ${displayName(sellRival.rival.provider)} · ${fmtRate(sellRival.rival.sell)}`:'';
    $('slideBuyGap').textContent=`${fmtMoney(m.gapBuy*1000)} / US$1K`; $('slideSellGap').textContent=`${fmtMoney(m.gapSell*1000)} / US$1K`;
    $('slideBuyGapState').textContent=gapState(m.gapBuy,'buy').text.replace(/[▲▼●]\s*/,''); $('slideSellGapState').textContent=gapState(m.gapSell,'sell').text.replace(/[▲▼●]\s*/,'');
    $('slideBuyBand').innerHTML='<article class="band-card"><div class="card-head"><div><p class="eyebrow">Banda competitiva</p><h2>Compra</h2></div></div><div class="competitive-band" id="pBuyBand"></div></article>';
    $('slideSellBand').innerHTML='<article class="band-card"><div class="card-head"><div><p class="eyebrow">Banda competitiva</p><h2>Venta</h2></div></div><div class="competitive-band" id="pSellBand"></div></article>';
    renderBand($('pBuyBand'),m,'buy','Compra'); renderBand($('pSellBand'),m,'sell','Venta');
    renderLineChart($('slideChart'),filteredRows(state.rows,24),'sell',COMPETITORS,370); $('slideInsight').textContent=$('insightText').textContent;
  }

  function setView(view,push=true) {
    state.view=view;
    $$('[data-view-panel]').forEach(p=>{const on=p.dataset.viewPanel===view;p.classList.toggle('is-active',on);p.hidden=!on;});
    $$('[data-view]').forEach(b=>{const on=b.dataset.view===view;b.classList.toggle('is-active',on);b.setAttribute('aria-pressed',String(on));});
    if (push) { const url=new URL(location.href); url.searchParams.set('view',view); history.replaceState(null,'',url); }
    window.scrollTo({top:0,behavior:'smooth'});
  }

  function setPressed(selector,active) { $$(selector).forEach(b=>{const on=b===active;b.classList.toggle('is-active',on);b.setAttribute('aria-pressed',String(on));}); }
  function showToast(msg) { const t=$('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(showToast.timer); showToast.timer=setTimeout(()=>t.classList.remove('show'),2400); }

  function openPresentation() {
    $('presentation').hidden=false; document.body.style.overflow='hidden'; state.slide=0; showSlide(0);
    if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(()=>{});
    $('presentationExit').focus();
  }
  function closePresentation() { $('presentation').hidden=true; document.body.style.overflow=''; if (document.fullscreenElement) document.exitFullscreen().catch(()=>{}); $('presentBtn').focus(); }
  function showSlide(i) { const slides=$$('.slide',$('presentation')); state.slide=(i+slides.length)%slides.length; slides.forEach((s,idx)=>{const on=idx===state.slide;s.classList.toggle('is-active',on);s.hidden=!on;}); $('presentationCount').textContent=`${state.slide+1} / ${slides.length}`; }

  function renderAll() {
    if (!state.rows.length) return null;
    const m=metrics(state.rows);
    updateDataStatus(m);
    renderPulse(m);
    renderMarket(m);
    renderHistory(m);
    return m;
  }

  function bind() {
    $$('[data-view]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
    $$('[data-go-view]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.goView)));
    $$('[data-overview-metric]').forEach(b=>b.addEventListener('click',()=>{state.overviewMetric=b.dataset.overviewMetric;setPressed('[data-overview-metric]',b);renderPulse(metrics(state.rows));}));
    $$('[data-market-metric]').forEach(b=>b.addEventListener('click',()=>{state.marketMetric=b.dataset.marketMetric;setPressed('[data-market-metric]',b);renderMarket(metrics(state.rows));}));
    $$('[data-history-metric]').forEach(b=>b.addEventListener('click',()=>{state.historyMetric=b.dataset.historyMetric;setPressed('[data-history-metric]',b);renderHistory(metrics(state.rows));}));
    $$('[data-period]').forEach(b=>b.addEventListener('click',()=>{state.period=b.dataset.period;setPressed('[data-period]',b);renderHistory(metrics(state.rows));}));
    $('presentBtn').addEventListener('click',openPresentation); $('presentationExit').addEventListener('click',closePresentation); $('slidePrev').addEventListener('click',()=>showSlide(state.slide-1)); $('slideNext').addEventListener('click',()=>showSlide(state.slide+1));
    $('shareBtn').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(location.href);showToast('Enlace copiado.');}catch{showToast('Copia la URL del navegador para compartir esta vista.');}});
    document.addEventListener('keydown',e=>{if($('presentation').hidden)return;if(e.key==='Escape')closePresentation();if(e.key==='ArrowRight'||e.key==='PageDown')showSlide(state.slide+1);if(e.key==='ArrowLeft'||e.key==='PageUp')showSlide(state.slide-1);});
  }

  async function refreshData({ quiet = true, allowFallback = false } = {}) {
    if (state.refreshing) return;
    state.refreshing = true;
    try {
      const rows = await loadRows({ allowFallback, quiet });
      state.lastRefreshAt = Date.now();
      if (rows?.length) state.rows = rows;
      if (state.rows.length) renderAll();
    } finally {
      state.refreshing = false;
    }
  }

  function startAutoRefresh() {
    const cfg = window.CAMBIX_CONFIG || {};
    const intervalMs = Math.max(1, Number(cfg.refreshMinutes || 5)) * 60000;
    state.refreshTimer = window.setInterval(() => {
      if (!document.hidden) refreshData({ quiet:true, allowFallback:false });
    }, intervalMs);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - state.lastRefreshAt > 60000) refreshData({ quiet:true, allowFallback:false });
    });
  }

  async function init() {
    const rows = await loadRows({ allowFallback:true, quiet:false });
    state.rows = rows || [];
    state.lastRefreshAt = Date.now();
    if (!state.rows.length) {
      $('dataStatus').innerHTML='<span class="status-dot"></span><span>Sin datos</span>';
      $('mobileDataStatus').innerHTML='<span class="status-dot"></span><span>Sin datos</span>';
      return;
    }
    renderAll();
    bind();
    const requested=new URL(location.href).searchParams.get('view'); if (['pulse','market','history'].includes(requested)) setView(requested,false);
    startAutoRefresh();
  }

  init();
})();
