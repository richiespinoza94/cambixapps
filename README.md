# Pulso Cambiario Cambix — MVP ejecutivo

MVP estático, responsive y sin build step para presentar el benchmark cambiario de Cambix a Growth.

## Estado actual

- Conectado para leer `public.vw_rates_public` desde Supabase REST.
- Usa únicamente Project URL + Publishable Key en el navegador.
- No contiene Secret Key, `service_role`, database password ni JWKS.
- Si Supabase no responde en la carga inicial, mantiene el CSV real del piloto como fallback y lo informa en pantalla, incluido mobile/tablet.
- Si una actualización periódica falla después de haber cargado Supabase, conserva la última lectura en vivo en vez de retroceder silenciosamente al CSV.
- Refresca automáticamente cada 5 minutos mientras la pestaña está visible y vuelve a consultar al regresar a la pestaña.
- Calcula frescura por proveedor contra la captura más reciente: >30 min = rezago; >60 min = desactualizado. La UI lo advierte sin ocultar qué dato se usa.
- La carga en vivo pagina de 1,000 en 1,000 para no truncar históricos por el límite de filas de la Data API.

## Qué incluye

- Desktop, tablet y mobile con una sola base de código.
- 3 vistas: Pulso, Mercado y Evolución.
- Modo Presentación 16:9 con Fullscreen API, flechas/PageUp/PageDown y salida con Esc.
- Las 4 preguntas de Growth: tasa vigente, ranking, brecha vs mercado y referencia SUNAT.
- Banda competitiva propia del producto.
- Impacto de brecha expresado también en soles por US$1,000.
- CSV real embebido como fallback (capturas 08–10 Sep 2026).
- `AVG_BANKS` e `IBK` excluidos del MVP por calidad/proxy.
- Sin frameworks, sin build y sin dependencias JS.

## Abrir localmente

```bash
python -m http.server 8080
```

Abrir `http://localhost:8080`.

También puede abrirse `index.html` directamente; el fallback está embebido como JS para evitar restricciones de `file://`.

## Configuración Supabase

`config.js` contiene solo valores aptos para frontend:

```js
window.CAMBIX_CONFIG = {
  supabaseUrl: 'https://TU-PROYECTO.supabase.co',
  supabasePublishableKey: 'sb_publishable_...',
  liveView: 'vw_rates_public',
  liveDays: 7,
  refreshMinutes: 5,
  freshnessWarnMinutes: 30,
  freshnessStaleMinutes: 60
};
```

Nunca colocar `sb_secret_...`, `service_role`, JWT secret ni contraseña de base de datos en estos archivos.

La vista mínima esperada está documentada en `supabase_views.sql`.

## QA

```bash
node qa-checks.mjs
```

Valida fuentes permitidas, tasas positivas, ausencia de credenciales privilegiadas, la fotografía conocida del fallback y regresiones P0: frescura por proveedor, auto-refresh y estado live/fallback responsive.

## Antes de desplegar

1. Confirmar que `vw_rates_public` responde a la Publishable Key.
2. Confirmar que la Secret Key anterior fue revocada y que GitHub Actions usa la nueva.
3. Abrir el dashboard y verificar que el badge indique `Supabase · lectura en vivo`.
4. Comparar al menos una captura contra `rates` en Supabase.
5. Probar Desktop, Mobile y Presentación.
6. Incorporar logo/brand guide definitivo cuando esté disponible.

## Decisiones deliberadas

- Sin React: no aporta al MVP actual.
- Sin backend propio: Supabase REST + vista SQL cubren lectura.
- Sin IA generativa para cálculos: ranking, brechas y tasas son deterministas.
- Sin fuentes degradadas en Growth: `AVG_BANKS` e `IBK` no aparecen en la experiencia principal.
