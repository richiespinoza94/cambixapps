window.CAMBIX_CONFIG = {
  // Safe for browser: public project URL + Supabase Publishable Key only.
  // Never place privileged server credentials in this file.
  supabaseUrl: 'https://mvxauaetfpivphawpync.supabase.co',
  supabasePublishableKey: 'sb_publishable_rNf33QmS4AYMCoMek__PsQ_eojg7bBd',
  liveView: 'vw_rates_public',
  liveDays: 7,
  refreshMinutes: 5,
  freshnessWarnMinutes: 30,
  freshnessStaleMinutes: 60,

  // Acceso: solo es una pista visual para Google (hd). El candado real vive en Supabase.
  allowedDomain: 'bancom.pe'
};
