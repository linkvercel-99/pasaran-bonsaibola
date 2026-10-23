// functions/api/odds.js — Cloudflare Pages Function
// Khusus Cloudflare Pages (dibatasi di bawah 50 subrequests pada free plan)

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const CACHE_SECONDS = 300;
const CONCURRENCY = 6;
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
  if (e && e.status === 429) return 'Terlalu banyak request ke ESPN API.';
  return `Gagal memuat ESPN API (${e && e.message ? e.message : e}).`;
}

/* ---------- Mapping ---------- */
function dec(v) {
  const n = parseFloat(String(v ?? '').replace('+', ''));
  if (!isFinite(n) || n === 0) return 0;
  return +(n > 0 ? 1 + n / 100 : 1 + 100 / -n).toFixed(2);
}

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

  let side = 'h', hdp = null;
  const hl = num(close((o.pointSpread || {}).home).line);
  const al = num(close((o.pointSpread || {}).away).line);
  if (hl !== null) { side = hl > 0 ? 'a' : 'h'; hdp = Math.abs(hl); }
  else if (al !== null) { side = al > 0 ? 'h' : 'a'; hdp = Math.abs(al); }

  let ou = null;
  const tl = num(close((o.total || {}).over).line);
  const p = tl !== null ? tl : (typeof o.overUnder === 'number' ? o.overUnder : null);
  if (p !== null) ou = fmtLine(p);

  const t = (ev.status || {}).type || {};
  let st;
  if (t.state === 'in') st = { s: 'live', min: parseInt((ev.status || {}).displayClock, 10) || 0, detail: t.shortDetail || '' };
  else if (t.state === 'post') st = { s: 'ft', detail: t.shortDetail || 'FT' };
  else st = { s: 'up' };

  return {
    id: 'espn-' + ev.id, eventId: String(ev.id), leagueCode: cfg.keys[0], league: cfg.name, country: cfg.country, group: cfg.group, order,
    ts: Date.parse(ev.date), home: (home.team || {}).displayName || '-', away: (away.team || {}).displayName || '-',
    homeLogo: (home.team || {}).logo || '', awayLogo: (away.team || {}).logo || '',
    side, hdp, ou, odds: odds.some(Boolean) ? odds : [0, 0, 0],
    st, score: t.state === 'pre' ? null : [home.score, away.score]
  };
}

function getYmd(offset) {
  return new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
}

async function fetchLive() {
  const tasks = [];
  // Cloudflare Free Worker: max 50 subrequests.
  // 20 liga terpopuler x 2 hari (Hari Ini & Besok) = 40 tasks.
  // 4 liga utama x 1 hari (Kemarin) = 4 tasks.
  // Total = 44 tasks (di bawah limit 50).
  const TOP_20 = LEAGUES.slice(0, 20);
  TOP_20.forEach((cfg, order) => {
    [0, 1].forEach(offset => tasks.push({ code: cfg.keys[0], ymd: getYmd(offset), cfg, order }));
  });
  LEAGUES.slice(0, 4).forEach((cfg, order) => {
    tasks.push({ code: cfg.keys[0], ymd: getYmd(-1), cfg, order });
  });

  const results = await allSettledLimited(tasks, CONCURRENCY, t => espnDay(t.code, t.ymd));
  const failed = results.filter(r => r.status === 'rejected').map(r => r.reason);
  if (failed.length === tasks.length) throw failed[0];

  const seen = new Set(), events = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const task = tasks[i];
    (r.value || []).forEach(ev => {
      if (!ev || !ev.id || seen.has(ev.id)) return;
      seen.add(ev.id);
      events.push(mapEvent(ev, task.cfg, task.order));
    });
  });

  events.sort((a, b) => a.ts - b.ts);
  return { events, failed };
}

/* ---------- Data Cadangan (Jika ESPN mati total) ---------- */
function mockPayload(reason) {
  const now = Date.now();
  const sample = [
    { league: 'Premier League', country: 'Inggris', group: 'Premier League', home: 'Arsenal', away: 'Chelsea', hdp: 0.5, side: 'h', ou: '2.5 / 3.0', odds: [1.95, 3.40, 3.80], offsetHour: 2, st: { s: 'up' } },
    { league: 'La Liga', country: 'Spanyol', group: 'La Liga', home: 'Real Madrid', away: 'Barcelona', hdp: 0.25, side: 'h', ou: '3.0', odds: [2.10, 3.50, 3.20], offsetHour: 5, st: { s: 'up' } },
    { league: 'Serie A', country: 'Italia', group: 'Serie A', home: 'Juventus', away: 'Inter Milan', hdp: 0.0, side: 'h', ou: '2.0 / 2.5', odds: [2.60, 3.10, 2.75], offsetHour: -1, st: { s: 'live', min: 54, detail: "54'" }, score: [1, 1] }
  ];
  const events = sample.map((m, i) => ({
    id: 'mock-' + (i + 1), eventId: String(900000 + i), leagueCode: 'eng.1',
    league: m.league, country: m.country, group: m.group, order: i,
    ts: now + (m.offsetHour || 0) * 36e5, home: m.home, away: m.away,
    homeLogo: '', awayLogo: '', side: m.side, hdp: m.hdp, ou: m.ou, odds: m.odds,
    st: m.st, score: m.score || null
  })).sort((a, b) => a.ts - b.ts);

  return { source: 'mock', notice: reason + ' Menampilkan data cadangan.', updatedAt: new Date().toISOString(), events };
}

/* ---------- Lineup ESPN ---------- */
const LINEUP_WAIT = 'Susunan pemain belum dirilis resmi oleh ESPN (biasanya tersedia 30–60 menit sebelum kickoff).';

function mapLineup(summary) {
  const rosters = summary?.rosters;
  if (!Array.isArray(rosters) || rosters.length === 0) {
    return { available: false, message: LINEUP_WAIT, teams: [] };
  }
  const teams = rosters.map(r => {
    const rawList = Array.isArray(r?.roster) ? r.roster : [];
    const starters = rawList.filter(p => p?.starter).map(formatPlayer);
    const bench = rawList.filter(p => p && !p.starter).map(formatPlayer);
    return {
      homeAway: r?.homeAway === 'home' ? 'home' : 'away',
      teamName: r?.team?.displayName || (r?.homeAway === 'home' ? 'Tuan Rumah' : 'Tamu'),
      teamLogo: r?.team?.logos?.[0]?.href || '',
      formation: r?.formation || '',
      coach: r?.coach?.[0]?.displayName || '',
      starters,
      bench
    };
  });
  const hasStarters = teams.some(t => t.starters.length > 0);
  return { available: hasStarters, message: hasStarters ? '' : LINEUP_WAIT, teams };
}

function formatPlayer(p) {
  return {
    name: p?.athlete?.displayName || p?.athlete?.shortName || '-',
    jersey: p?.jersey != null ? String(p.jersey) : '',
    position: p?.position?.name || p?.position?.abbreviation || '',
    subbedIn: Boolean(p?.subbedIn)
  };
}

/* ---------- Berita ESPN ---------- */
const NEWS_LEAGUES = [
  { code: 'eng.1', name: 'Premier League' },
  { code: 'esp.1', name: 'La Liga' },
  { code: 'ita.1', name: 'Serie A' },
  { code: 'ger.1', name: 'Bundesliga' },
  { code: 'fra.1', name: 'Ligue 1' },
  { code: 'uefa.champions', name: 'Champions League' }
];

async function fetchArticle(id) {
  const res = await fetch(`https://now.core.api.espn.com/v1/sports/news/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const raw = (data.headlines || [])[0] || data.headline || data;
  return {
    id: String(raw.id || id),
    headline: raw.headline || raw.title || '-',
    description: raw.description || raw.story || '',
    published: raw.published || raw.lastModified || new Date().toISOString(),
    byline: raw.byline || '',
    story: raw.story || raw.description || '',
    link: (raw.links && raw.links.web && raw.links.web.href) || '',
    images: (raw.images || []).map(img => ({ url: img.url, width: img.width, height: img.height, caption: img.caption }))
  };
}

async function fetchNews() {
  const articles = [];
  await Promise.all(NEWS_LEAGUES.map(async (l) => {
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${l.code}/news?limit=2`, { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const data = await res.json();
      (data.articles || []).forEach(art => {
        articles.push({
          id: String(art.id || ''),
          league: l.name,
          headline: art.headline || art.title || '',
          description: art.description || '',
          published: art.published || new Date().toISOString(),
          links: { web: { href: art.links?.web?.href || '' } },
          images: (art.images || []).map(img => ({ url: img.url, width: img.width, height: img.height }))
        });
      });
    } catch {}
  }));
  return articles;
}

/* ---------- Cloudflare Pages Helper ---------- */
function jsonResponse(payload, status = 200, seconds = 60, extraHeaders = {}) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': seconds > 0
      ? `public, s-maxage=${seconds}, stale-while-revalidate=${Math.min(seconds, 600)}`
      : 'no-store',
    ...extraHeaders,
  });
  return new Response(JSON.stringify(payload), { status, headers });
}

async function serveLineup(url, allowedLeagues) {
  const league = url.searchParams.get('league');
  const id = url.searchParams.get('id');
  if (typeof league !== 'string' || !allowedLeagues.includes(league) || typeof id !== 'string' || !/^\d{1,12}$/.test(id)) {
    return jsonResponse({ error: 'Liga atau ID pertandingan tidak valid.' }, 400, 0);
  }
  try {
    const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${encodeURIComponent(league)}/summary?event=${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      if (response.status === 404) {
        return jsonResponse({ source: 'espn', available: false, message: LINEUP_WAIT, teams: [] }, 200, 60);
      }
      throw new Error('HTTP ' + response.status);
    }
    const payload = mapLineup(await response.json());
    return jsonResponse({ source: 'espn', league, id, updatedAt: new Date().toISOString(), ...payload }, 200, 90);
  } catch {
    return jsonResponse({ source: 'error', available: false, message: 'Gagal memuat susunan pemain dari ESPN. Silakan coba lagi.', teams: [] }, 502, 0);
  }
}

/* ---------- Cloudflare Pages Main Handler ---------- */
export async function onRequest(context) {
  const { request } = context;
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Allow': 'GET' }
    });
  }

  const url = new URL(request.url);
  const type = url.searchParams.get('type');

  if (type === 'lineup') {
    return serveLineup(url, LEAGUES.flatMap(l => l.keys));
  }

  if (type === 'article') {
    const id = String(url.searchParams.get('id') || '').trim();
    if (!/^\d{4,12}$/.test(id)) {
      return jsonResponse({ error: 'id berita tidak valid' }, 400, 0);
    }
    try {
      const article = await fetchArticle(id);
      return jsonResponse({ source: 'espn', updatedAt: new Date().toISOString(), article }, 200, 3600);
    } catch (e) {
      console.error('espn article error:', e.message);
      return jsonResponse({ source: 'error', notice: errorText(e), updatedAt: new Date().toISOString(), article: null }, 200, 60);
    }
  }

  if (type === 'news') {
    try {
      const articles = await fetchNews();
      return jsonResponse({ source: 'espn', updatedAt: new Date().toISOString(), articles }, 200, 900);
    } catch (e) {
      console.error('espn news error:', e.message);
      return jsonResponse({ source: 'error', notice: errorText(e), updatedAt: new Date().toISOString(), articles: [] }, 200, 60);
    }
  }

  // Standar: Ambil jadwal & skor langsung
  try {
    const { events } = await fetchLive();
    if (!events.length) {
      return jsonResponse(mockPayload('Tidak ada pertandingan terjadwal dari ESPN.'), 200, 300);
    }
    // Dikosongkan agar banner error tidak muncul di website saat data berhasil didapat
    const notice = '';
    return jsonResponse({ source: 'espn', notice, updatedAt: new Date().toISOString(), events }, 200, CACHE_SECONDS);
  } catch (e) {
    console.error('espn api error:', e.message);
    return jsonResponse(mockPayload(errorText(e)), 200, 60);
  }
}
