// api/odds.js — Vercel Serverless Function (Node.js)
// API key hanya dibaca dari environment variable ODDS_API_KEY dan tidak pernah dikirim ke browser.

const API_BASE = 'https://api.the-odds-api.com/v4/sports';
const REGIONS = process.env.ODDS_REGIONS || 'eu';
const MARKETS = process.env.ODDS_MARKETS || 'h2h,spreads,totals';
const CACHE_SECONDS = Math.max(60, parseInt(process.env.CACHE_SECONDS, 10) || 3600); // cache CDN Vercel
const MAX_LEAGUES = Math.max(1, parseInt(process.env.MAX_LEAGUES, 10) || 25); // batas jumlah liga per refresh (hemat kuota)
const WINDOW_DAYS = 7; // data yang dikirim ke browser: sekarang sampai +7 hari
const TZ = 'Asia/Jakarta';

// Metadata liga yang dikenal: nama, negara, grup pill filter, dan urutan tampil.
// Daftar ini TIDAK membatasi: semua liga sepak bola yang aktif di The Odds API ikut dimuat otomatis (lihat fetchLive).
// group harus sama dengan pill di index.html ('Lainnya' = hanya muncul di "Semua Liga").
const L = (keys, name, country, group = 'Lainnya') => ({ keys: [].concat(keys), name, country, group });
const LEAGUES = [
  L('soccer_epl', 'Premier League', 'Inggris', 'Premier League'),
  L('soccer_efl_champ', 'Championship', 'Inggris'),
  L('soccer_england_league1', 'League One', 'Inggris'),
  L('soccer_spain_la_liga', 'La Liga', 'Spanyol', 'La Liga'),
  L('soccer_spain_segunda_division', 'La Liga 2', 'Spanyol'),
  L('soccer_italy_serie_a', 'Serie A', 'Italia', 'Serie A'),
  L('soccer_italy_serie_b', 'Serie B', 'Italia'),
  L('soccer_germany_bundesliga', 'Bundesliga', 'Jerman', 'Bundesliga'),
  L('soccer_germany_bundesliga2', 'Bundesliga 2', 'Jerman'),
  L('soccer_france_ligue_one', 'Ligue 1', 'Prancis'),
  L('soccer_france_ligue_two', 'Ligue 2', 'Prancis'),
  L('soccer_uefa_champs_league', 'Champions League', 'Eropa', 'Champions League'),
  L('soccer_uefa_europa_league', 'Europa League', 'Eropa'),
  L('soccer_uefa_europa_conf_league', 'Conference League', 'Eropa'),
  L('soccer_uefa_nations_league', 'Nations League', 'Eropa'),
  L('soccer_netherlands_eredivisie', 'Eredivisie', 'Belanda'),
  L('soccer_portugal_primeira_liga', 'Primeira Liga', 'Portugal'),
  L('soccer_belgium_first_div', 'Pro League', 'Belgia'),
  L('soccer_turkey_super_league', 'Super Lig', 'Turki'),
  L('soccer_spl', 'Scottish Premiership', 'Skotlandia'),
  L('soccer_japan_j_league', 'J-League', 'Jepang', 'Liga Asia'),
  L(['soccer_korea_kleague1', 'soccer_korea_k_league'], 'K League', 'Korea Selatan', 'Liga Asia'),
  L(['soccer_china_superleague', 'soccer_china_super_league'], 'Chinese Super League', 'China', 'Liga Asia'),
  L('soccer_australia_aleague', 'A-League', 'Australia', 'Liga Asia'),
  L(['soccer_saudi_arabia_pro_league', 'soccer_saudi_pro_league'], 'Saudi Pro League', 'Arab Saudi', 'Liga Asia'),
  L('soccer_usa_mls', 'MLS', 'Amerika Serikat'),
  L('soccer_brazil_campeonato', 'Brasileirão', 'Brasil'),
  L('soccer_mexico_ligamx', 'Liga MX', 'Meksiko'),
  L('soccer_argentina_primera_division', 'Liga Argentina', 'Argentina'),
  L('soccer_conmebol_copa_libertadores', 'Copa Libertadores', 'Amerika Selatan'),
  L('soccer_conmebol_copa_sudamericana', 'Copa Sudamericana', 'Amerika Selatan')
];

// Liga yang tidak ada di daftar di atas: pakai judul dari The Odds API; key Asia masuk pill "Liga Asia"
const ASIA = /japan|korea|china|australia|saudi|thailand|indonesia|malaysia|india|uae|qatar|iran|uzbekistan|vietnam|afc/i;
function cfgFor(s, i) {
  const k = LEAGUES.findIndex(c => c.keys.includes(s.key));
  if (k >= 0) return { cfg: LEAGUES[k], order: k };
  return { cfg: { name: s.title || s.key, country: '', group: ASIA.test(s.key) ? 'Liga Asia' : 'Lainnya' }, order: LEAGUES.length + i };
}

/* ---------- The Odds API ---------- */
async function apiError(res) {
  let code = '';
  try { code = (await res.json()).error_code || ''; } catch {}
  const e = new Error(code || 'HTTP ' + res.status);
  e.status = res.status; e.code = code;
  return e;
}

// Semua liga sepak bola yang sedang aktif (endpoint /sports tidak memakai kuota odds)
async function activeSoccer(apiKey) {
  const res = await fetch(`${API_BASE}?${new URLSearchParams({ apiKey })}`);
  if (!res.ok) throw await apiError(res);
  return (await res.json()).filter(s => s.active && s.key.startsWith('soccer_') && !s.has_outrights && !/winner/.test(s.key));
}

async function oddsGet(apiKey, sportKey) {
  const qs = new URLSearchParams({ apiKey, regions: REGIONS, markets: MARKETS, oddsFormat: 'decimal', dateFormat: 'iso' });
  const res = await fetch(`${API_BASE}/${sportKey}/odds?${qs}`);
  if (res.status === 404) return [];
  if (!res.ok) throw await apiError(res);
  return res.json();
}

function errorText(e) {
  if (e.code === 'OUT_OF_USAGE_CREDITS') return 'Kuota API habis.';
  if (e.code === 'INVALID_KEY' || e.status === 401) return 'API key tidak valid.';
  if (e.status === 429 || e.code === 'EXCEEDED_FREQ_LIMIT') return 'Terlalu banyak request ke API.';
  return `Gagal memuat API (${e.message}).`;
}

/* ---------- Mapping ---------- */
function pickMarket(ev, key) {
  for (const b of ev.bookmakers || []) {
    const m = (b.markets || []).find(x => x.key === key);
    if (m && m.outcomes && m.outcomes.length) return m.outcomes;
  }
  return null;
}

// 2.5 -> "2.5", 2.75 -> "2.5 / 3.0"
const fmtLine = p => ((p * 4) % 2 === 0 ? p.toFixed(1) : (p - 0.25).toFixed(1) + ' / ' + (p + 0.25).toFixed(1));

function mapEvent(ev, cfg, order) {
  const h2h = pickMarket(ev, 'h2h') || [];
  const price = n => +((h2h.find(o => o.name === n) || {}).price) || 0;

  let side = 'h', hdp = null; // point negatif = tim pemberi voor
  const sp = pickMarket(ev, 'spreads');
  if (sp) {
    const ho = sp.find(o => o.name === ev.home_team), ao = sp.find(o => o.name === ev.away_team);
    if (ho && typeof ho.point === 'number') { side = ho.point > 0 ? 'a' : 'h'; hdp = Math.abs(ho.point); }
    else if (ao && typeof ao.point === 'number') { side = ao.point > 0 ? 'h' : 'a'; hdp = Math.abs(ao.point); }
  }

  let ou = null; // garis dengan harga Over/Under paling seimbang
  const tt = pickMarket(ev, 'totals');
  if (tt) {
    const lines = {};
    tt.forEach(o => { if (typeof o.point === 'number') (lines[o.point] = lines[o.point] || {})[o.name] = o.price; });
    let diff = Infinity;
    for (const p in lines) if (lines[p].Over && lines[p].Under) {
      const d = Math.abs(lines[p].Over - lines[p].Under);
      if (d < diff) { diff = d; ou = fmtLine(+p); }
    }
  }

  return {
    id: ev.id, league: cfg.name, country: cfg.country, group: cfg.group, order,
    ts: Date.parse(ev.commence_time), home: ev.home_team, away: ev.away_team,
    side, hdp, ou, odds: [price(ev.home_team), price('Draw'), price(ev.away_team)]
  };
}

// Ambil semua liga aktif sekaligus (maks. MAX_LEAGUES); satu liga gagal/kosong tidak membatalkan yang lain
async function fetchLive(apiKey) {
  const soccer = await activeSoccer(apiKey);
  const rank = s => { const i = LEAGUES.findIndex(c => c.keys.includes(s.key)); return i < 0 ? 999 : i; };
  soccer.sort((a, b) => rank(a) - rank(b) || (a.title || '').localeCompare(b.title || '')); // liga besar didahulukan

  const tasks = soccer.slice(0, MAX_LEAGUES).map((s, i) => ({ key: s.key, ...cfgFor(s, i) }));
  const inactive = soccer.slice(MAX_LEAGUES).map(s => s.key); // aktif tapi tidak dimuat (kena batas MAX_LEAGUES)

  const results = await Promise.allSettled(tasks.map(t => oddsGet(apiKey, t.key)));
  const failed = results.filter(r => r.status === 'rejected').map(r => r.reason);
  if (tasks.length && failed.length === tasks.length) throw failed[0];

  const from = Date.now() - 3 * 36e5, to = Date.now() + WINDOW_DAYS * 864e5;
  const seen = new Set(), events = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    r.value.forEach(ev => {
      const m = mapEvent(ev, tasks[i].cfg, tasks[i].order);
      if (seen.has(m.id) || m.ts < from || m.ts > to) return;
      seen.add(m.id); events.push(m);
    });
  });
  events.sort((a, b) => a.ts - b.ts);
  return { events, inactive, failed };
}

/* ---------- Data mock (fallback) ----------
   [hari ke-, liga, jam WIB, home, away, pemberi voor, voor, O/U, odds H, D, A] */
const MOCK = [
  [0,'Premier League','19:30','Aston Villa','Tottenham','a',0.25,'2.5 / 3.0',2.95,3.80,2.30],
  [0,'Premier League','22:00','Arsenal','Chelsea','h',0.5,'2.5',1.85,3.60,4.20],
  [0,'La Liga','23:30','Barcelona','Atletico Madrid','h',0.5,'3.0',1.95,3.80,3.65],
  [0,'Serie A','23:00','Inter','Napoli','h',0.25,'2.5',2.10,3.40,3.50],
  [0,'Bundesliga','21:30','Bayer Leverkusen','VfB Stuttgart','h',0.75,'3.0 / 3.5',1.65,4.30,4.80],
  [0,'Ligue 1','23:00','Marseille','Lyon','h',0.25,'2.5 / 3.0',2.30,3.50,3.00],
  [0,'Champions League','23:45','Bayern Munich','PSG','h',0.25,'3.0 / 3.5',2.15,3.80,3.10],
  [0,'Champions League','23:45','Real Madrid','Dortmund','h',0.75,'3.0',1.60,4.20,5.00],
  [0,'J-League','17:00','Vissel Kobe','Yokohama F. Marinos','h',0.25,'2.5 / 3.0',2.20,3.50,3.10],
  [1,'Premier League','21:00','Liverpool','Manchester City','h',0,'3.0',2.60,3.60,2.55],
  [1,'La Liga','22:00','Sevilla','Valencia','h',0.25,'2.0 / 2.5',2.35,3.00,3.10],
  [1,'Serie A','23:45','Juventus','AC Milan','h',0.25,'2.0 / 2.5',2.30,3.10,3.20],
  [1,'Bundesliga','21:30','Borussia Dortmund','RB Leipzig','h',0.25,'3.0',2.30,3.70,2.90],
  [1,'Champions League','23:45','Napoli','Benfica','h',0.5,'2.5 / 3.0',1.90,3.60,4.10],
  [1,'K League','17:30','Ulsan HD','Jeonbuk Motors','h',0.25,'2.5',2.20,3.30,3.10],
  [1,'Saudi Pro League','23:00','Al Hilal','Al Nassr','h',0.5,'3.0 / 3.5',1.80,4.00,3.90],
  [2,'Premier League','22:00','Newcastle','Brighton','h',0.25,'2.5 / 3.0',2.25,3.60,3.10],
  [2,'La Liga','22:15','Athletic Bilbao','Girona','h',0.25,'2.5',2.30,3.20,3.15],
  [2,'Serie A','20:00','Roma','Lazio','h',0,'2.0 / 2.5',2.60,3.10,2.85],
  [2,'Bundesliga','20:30','Eintracht Frankfurt','Werder Bremen','h',0.5,'3.0',1.95,3.70,3.60],
  [2,'Champions League','23:45','Manchester City','Sporting CP','h',1.25,'3.5',1.28,5.75,9.50],
  [2,'Chinese Super League','18:35','Shanghai Port','Shandong Taishan','h',0.25,'2.5',2.15,3.30,3.20],
  [2,'A-League','15:00','Melbourne City','Sydney FC','h',0.25,'3.0',2.20,3.50,3.00]
];

function mockPayload(reason) {
  const dayOf = off => new Date(Date.now() + off * 864e5).toLocaleDateString('en-CA', { timeZone: TZ });
  const events = MOCK.map((r, i) => {
    const order = LEAGUES.findIndex(c => c.name === r[1]), cfg = LEAGUES[order];
    return {
      id: 'mock-' + i, league: r[1], country: cfg.country, group: cfg.group, order,
      ts: Date.parse(`${dayOf(r[0])}T${r[2]}:00+07:00`), home: r[3], away: r[4],
      side: r[5], hdp: r[6], ou: r[7], odds: [r[8], r[9], r[10]]
    };
  }).sort((a, b) => a.ts - b.ts);
  return { source: 'mock', notice: reason + ' Menampilkan data contoh.', updatedAt: new Date().toISOString(), events };
}

/* ---------- Handler ---------- */
function reply(res, payload, seconds) {
  res.setHeader('Cache-Control', `public, s-maxage=${seconds}, stale-while-revalidate=${Math.min(seconds, 600)}`);
  return res.status(200).json(payload);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const apiKey = (process.env.ODDS_API_KEY || '').trim();
  if (!apiKey) return reply(res, mockPayload('ODDS_API_KEY belum diatur di server.'), 60);

  try {
    const { events, inactive, failed } = await fetchLive(apiKey);
    if (!events.length) return reply(res, mockPayload('Tidak ada pertandingan terjadwal dari API.'), 300);
    const notice = failed.length ? `${errorText(failed[0])} ${failed.length} permintaan liga gagal.` : '';
    return reply(res, { source: 'live', notice, updatedAt: new Date().toISOString(), inactive, events },
      failed.length ? 120 : CACHE_SECONDS);
  } catch (e) {
    console.error('odds api error:', e.message); // jangan pernah log URL (mengandung apiKey)
    return reply(res, mockPayload(errorText(e)), 120);
  }
};
