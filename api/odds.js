// api/odds.js — Vercel Serverless Function (Node.js) — sumber data: ESPN API (gratis, tanpa API key)
// Dipanggil dari server agar tidak kena CORS di browser. Format output SAMA seperti versi lama.

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const CACHE_SECONDS = Math.max(30, parseInt(process.env.CACHE_SECONDS, 10) || 300);
const DAYS = 3;         // Hari Ini, Besok, Lusa
const HISTORY = 3;      // Riwayat: 3 hari sebelumnya
const CONCURRENCY = 10;
const TZ = 'Asia/Jakarta';

// [kode liga ESPN, nama, negara, grup pill di index.html]
const L = (keys, name, country, group = 'Lainnya') => ({ keys: [].concat(keys), name, country, group });
const LEAGUES = [
  L('eng.1', 'Premier League', 'Inggris', 'Premier League'),
  L('eng.2', 'Championship', 'Inggris'),
  L('eng.3', 'League One', 'Inggris'),
  L('esp.1', 'La Liga', 'Spanyol', 'La Liga'),
  L('esp.2', 'La Liga 2', 'Spanyol'),
  L('ita.1', 'Serie A', 'Italia', 'Serie A'),
  L('ita.2', 'Serie B', 'Italia'),
  L('ger.1', 'Bundesliga', 'Jerman', 'Bundesliga'),
  L('ger.2', 'Bundesliga 2', 'Jerman'),
  L('fra.1', 'Ligue 1', 'Prancis'),
  L('fra.2', 'Ligue 2', 'Prancis'),
  L('uefa.champions', 'Champions League', 'Eropa', 'Champions League'),
  L('uefa.europa', 'Europa League', 'Eropa'),
  L('uefa.europa.conf', 'Conference League', 'Eropa'),
  L('uefa.nations', 'Nations League', 'Eropa'),
  L('ned.1', 'Eredivisie', 'Belanda'),
  L('por.1', 'Primeira Liga', 'Portugal'),
  L('bel.1', 'Pro League', 'Belgia'),
  L('tur.1', 'Super Lig', 'Turki'),
  L('sco.1', 'Scottish Premiership', 'Skotlandia'),
  L('jpn.1', 'J-League', 'Jepang', 'Liga Asia'),
  L('chn.1', 'Chinese Super League', 'China', 'Liga Asia'),
  L('aus.1', 'A-League', 'Australia', 'Liga Asia'),
  L('ksa.1', 'Saudi Pro League', 'Arab Saudi', 'Liga Asia'),
  L('idn.1', 'Liga 1 Indonesia', 'Indonesia', 'Liga Asia'),
  L('usa.1', 'MLS', 'Amerika Serikat'),
  L('bra.1', 'Brasileirão', 'Brasil'),
  L('mex.1', 'Liga MX', 'Meksiko'),
  L('arg.1', 'Liga Argentina', 'Argentina'),
  L('conmebol.libertadores', 'Copa Libertadores', 'Amerika Selatan'),
  L('conmebol.sudamericana', 'Copa Sudamericana', 'Amerika Selatan')
];

/* ---------- ESPN API ---------- */
async function espnDay(code, ymd) {
  const res = await fetch(`${ESPN}/${code}/scoreboard?dates=${ymd}`, { headers: { Accept: 'application/json' } });
  if (res.status === 400 || res.status === 404) return [];
  if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
  return (await res.json()).events || [];
}

async function allSettledLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { status: 'fulfilled', value: await fn(items[i]) }; }
      catch (reason) { out[i] = { status: 'rejected', reason }; }
    }
  }));
  return out;
}

function errorText(e) {
  if (e.status === 429) return 'Terlalu banyak request ke ESPN API.';
  return `Gagal memuat ESPN API (${e.message}).`;
}

/* ---------- Mapping ---------- */
// Odds Amerika (-180 / +475) -> desimal (1.56 / 5.75)
function dec(v) {
  const n = parseFloat(String(v ?? '').replace('+', ''));
  if (!isFinite(n) || n === 0) return 0;
  return +(n > 0 ? 1 + n / 100 : 1 + 100 / -n).toFixed(2);
}
// 2.5 -> "2.5", 2.75 -> "2.5 / 3.0"
const fmtLine = p => ((p * 4) % 2 === 0 ? p.toFixed(1) : (p - 0.25).toFixed(1) + ' / ' + (p + 0.25).toFixed(1));
const num = v => { const n = parseFloat(String(v ?? '').replace(/^[ou]/i, '')); return isFinite(n) ? n : null; };
const close = x => (x && (x.close || x.open)) || {};

function mapEvent(ev, cfg, order) {
  const c = (ev.competitions || [])[0] || {};
  const home = (c.competitors || []).find(t => t.homeAway === 'home') || {};
  const away = (c.competitors || []).find(t => t.homeAway === 'away') || {};
  const o = (c.odds || [])[0] || {};

  const ml = o.moneyline || {};
  const odds = [
    dec(close(ml.home).odds ?? (o.homeTeamOdds || {}).moneyLine),
    dec(close(ml.draw).odds ?? (o.drawOdds || {}).moneyLine),
    dec(close(ml.away).odds ?? (o.awayTeamOdds || {}).moneyLine)
  ];

  let side = 'h', hdp = null; // line negatif = tim pemberi voor
  const hl = num(close((o.pointSpread || {}).home).line);
  const al = num(close((o.pointSpread || {}).away).line);
  if (hl !== null) { side = hl > 0 ? 'a' : 'h'; hdp = Math.abs(hl); }
  else if (al !== null) { side = al > 0 ? 'h' : 'a'; hdp = Math.abs(al); }

  let ou = null;
  const tl = num(close((o.total || {}).over).line);
  const p = tl !== null ? tl : (typeof o.overUnder === 'number' ? o.overUnder : null);
  if (p !== null) ou = fmtLine(p);

  // Status asli dari ESPN (live / selesai) + skor
  const t = (ev.status || {}).type || {};
  let st;
  if (t.state === 'in') st = { s: 'live', min: parseInt((ev.status || {}).displayClock, 10) || 0, detail: t.shortDetail || '' };
  else if (t.state === 'post') st = { s: 'ft', detail: t.shortDetail || 'FT' };
  else st = { s: 'up' };

  return {
    id: 'espn-' + ev.id, league: cfg.name, country: cfg.country, group: cfg.group, order,
    ts: Date.parse(ev.date), home: (home.team || {}).displayName || '-', away: (away.team || {}).displayName || '-',
    homeLogo: (home.team || {}).logo || '', awayLogo: (away.team || {}).logo || '',
    side, hdp, ou, odds: odds.some(Boolean) ? odds : [0, 0, 0],
    st, score: t.state === 'pre' ? null : [home.score, away.score]
  };
}

// Tanggal YYYYMMDD (UTC) dari -(HISTORY+1) s/d +DAYS agar riwayat 3 hari & semua jam WIB tercakup
function ymdList() {
  const out = [];
  for (let d = -(HISTORY + 1); d <= DAYS; d++) out.push(new Date(Date.now() + d * 864e5).toISOString().slice(0, 10).replace(/-/g, ''));
  return out;
}

async function fetchLive() {
  const tasks = [];
  LEAGUES.forEach((cfg, order) => ymdList().forEach(ymd => tasks.push({ code: cfg.keys[0], ymd, cfg, order })));
  const results = await allSettledLimited(tasks, CONCURRENCY, t => espnDay(t.code, t.ymd));
  const failed = results.filter(r => r.status === 'rejected').map(r => r.reason);
  if (failed.length === tasks.length) throw failed[0];

  const from = Date.now() - (HISTORY + 1) * 864e5, to = Date.now() + (DAYS + 1) * 864e5;
  const seen = new Set(), events = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    r.value.forEach(ev => {
      const m = mapEvent(ev, tasks[i].cfg, tasks[i].order);
      if (seen.has(m.id) || !m.ts || m.ts < from || m.ts > to) return;
      seen.add(m.id); events.push(m);
    });
  });
  events.sort((a, b) => a.ts - b.ts);
  return { events, failed };
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
      homeLogo: '', awayLogo: '', side: r[5], hdp: r[6], ou: r[7], odds: [r[8], r[9], r[10]]
    };
  }).sort((a, b) => a.ts - b.ts);
  return { source: 'mock', notice: reason + ' Menampilkan data contoh.', updatedAt: new Date().toISOString(), events };
}


/* ---------- BERITA (liga top dunia, Bahasa Indonesia) ----------
   Panggil: GET /api/odds?type=news
   Output: { source, updatedAt, articles:[{ id, league, headline, description, published, links, images:[{url,width,height}] }] } */
const NEWS_LEAGUES = [
  ['eng.1', 'Premier League'], ['esp.1', 'La Liga'], ['ita.1', 'Serie A'],
  ['ger.1', 'Bundesliga'], ['fra.1', 'Ligue 1'], ['uefa.champions', 'Champions League']
];
const NEWS_PER_LEAGUE = 8;
const NEWS_MAX = 30;

// Terjemahan EN -> ID (Google Translate publik, tanpa API key). Gagal -> teks asli.
async function toID(text) {
  if (!text) return '';
  try {
    const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=id&dt=t&q=' + encodeURIComponent(text);
    const r = await fetch(u);
    if (!r.ok) return text;
    const j = await r.json();
    return (j[0] || []).map(x => x[0]).join('') || text;
  } catch { return text; }
}

async function fetchNews() {
  const results = await allSettledLimited(NEWS_LEAGUES, CONCURRENCY, async ([code, name]) => {
    const r = await fetch(`${ESPN}/${code}/news?limit=${NEWS_PER_LEAGUE}`, { headers: { Accept: 'application/json' } });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return ((await r.json()).articles || []).map(a => ({ a, name }));
  });
  const seen = new Set(), list = [];
  results.forEach(r => r.status === 'fulfilled' && r.value.forEach(({ a, name }) => {
    const id = String(a.id || a.headline);
    if (seen.has(id) || !a.headline) return;
    seen.add(id);
    list.push({
      id, league: name,
      headline: a.headline, description: a.description || '',
      published: a.published || a.lastModified || '',
      links: {
        web: ((a.links || {}).web || {}).href || '',
        mobile: ((a.links || {}).mobile || {}).href || '',
        app: (((a.links || {}).app || {}).sportscenter || {}).href || ''
      },
      images: (a.images || []).filter(i => i && i.url).map(i => ({ url: i.url, width: i.width || null, height: i.height || null, caption: i.caption || '' }))
    });
  }));
  if (!list.length) throw results.find(r => r.status === 'rejected')?.reason || new Error('Berita kosong');
  list.sort((x, y) => Date.parse(y.published) - Date.parse(x.published));
  const top = list.slice(0, NEWS_MAX);
  await allSettledLimited(top, CONCURRENCY, async n => {
    [n.headline, n.description] = await Promise.all([toID(n.headline), toID(n.description)]);
    for (const img of n.images) if (img.caption) img.caption = await toID(img.caption);
  });
  return top;
}

/* ---------- ARTIKEL LENGKAP (isi berita per artikel, untuk popup) ----------
   Panggil: GET /api/odds?type=article&id=<id berita>&league=<nama liga>
   Output: { source, updatedAt, article:{ id, headline, story, link } } */
async function fetchArticle(id) {
  // Endpoint konten ESPN: mengembalikan isi artikel lengkap (story)
  const r = await fetch(`https://now.core.api.espn.com/v1/sports/news/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  const j = await r.json();
  const a = ((j.headlines || [])[0]) || {};
  // Isi berita (story) berupa HTML -> buang tag, rapikan spasi, lalu terjemahkan
  let story = String(a.story || a.description || '')
    .replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]*>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim();
  const [headline, storyID] = await Promise.all([a.headline ? toID(a.headline) : '', story ? toID(story) : '']);
  return { id: String(id), headline, story: storyID, link: ((a.links || {}).web || {}).href || '' };
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
  if (req.query && req.query.type === 'article') {
    const id = String(req.query.id || '').trim();
    if (!/^\d{4,12}$/.test(id)) return res.status(400).json({ error: 'id berita tidak valid' });
    try {
      const article = await fetchArticle(id);
      return reply(res, { source: 'espn', updatedAt: new Date().toISOString(), article }, 3600);
    } catch (e) {
      console.error('espn article error:', e.message);
      return reply(res, { source: 'error', notice: errorText(e), updatedAt: new Date().toISOString(), article: null }, 60);
    }
  }
  if (req.query && req.query.type === 'news') {
    try {
      const articles = await fetchNews();
      return reply(res, { source: 'espn', updatedAt: new Date().toISOString(), articles }, 900);
    } catch (e) {
      console.error('espn news error:', e.message);
      return reply(res, { source: 'error', notice: errorText(e), updatedAt: new Date().toISOString(), articles: [] }, 60);
    }
  }
  try {
    const { events, failed } = await fetchLive();
    if (!events.length) return reply(res, mockPayload('Tidak ada pertandingan terjadwal dari ESPN.'), 300);
    const notice = failed.length ? `${errorText(failed[0])} ${failed.length} permintaan gagal.` : '';
    return reply(res, { source: 'espn', notice, updatedAt: new Date().toISOString(), events }, failed.length ? 60 : CACHE_SECONDS);
  } catch (e) {
    console.error('espn api error:', e.message);
    return reply(res, mockPayload(errorText(e)), 60);
  }
};
