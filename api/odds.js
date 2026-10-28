// api/odds.js — Vercel Serverless Function (Node.js) — sumber data: ESPN API (gratis, tanpa API key)
// Dipanggil dari server agar tidak kena CORS di browser. Format output SAMA seperti versi lama.
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const CACHE_SECONDS = Math.max(600, parseInt(process.env.CACHE_SECONDS, 10) || 600); // 10 menit (600 detik) anti-spam
const DAYS = 3;         // Hari Ini, Besok, Lusa
const HISTORY = 3;      // Riwayat: 3 hari sebelumnya
const CONCURRENCY = 10;
const TZ = "Asia/Jakarta";

// [kode liga ESPN, nama, negara, grup pill di index.html, logo resmi ESPN]
const L = (keys, name, country, group = "Lainnya", logo = "") => ({ keys: [].concat(keys), name, country, group, logo });
const LEAGUES = [
  L("eng.1", "Premier League", "Inggris", "Premier League", "https://a.espncdn.com/i/leaguelogos/soccer/500/23.png"),
  L("eng.2", "Championship", "Inggris", "Lainnya", "https://a.espncdn.com/i/leaguelogos/soccer/500/24.png"),
  L("eng.3", "League One", "Inggris", "Lainnya", "https://a.espncdn.com/i/leaguelogos/soccer/500/25.png"),
  L("esp.1", "La Liga", "Spanyol", "La Liga", "https://a.espncdn.com/i/leaguelogos/soccer/500/15.png"),
  L("esp.2", "La Liga 2", "Spanyol", "Lainnya", "http://a.espncdn.com/i/leaguelogos/soccer/500/107.png"),
  L("ita.1", "Serie A", "Italia", "Serie A", "https://a.espncdn.com/i/leaguelogos/soccer/500/12.png"),
  L("ita.2", "Serie B", "Italia", "Lainnya", "http://a.espncdn.com/i/leaguelogos/soccer/500/99.png"),
  L("ger.1", "Bundesliga", "Jerman", "Bundesliga", "https://a.espncdn.com/i/leaguelogos/soccer/500/10.png"),
  L("ger.2", "Bundesliga 2", "Jerman", "Lainnya", "https://a.espncdn.com/i/leaguelogos/soccer/500/97.png"),
  L("fra.1", "Ligue 1", "Prancis", "Lainnya", "https://a.espncdn.com/i/leaguelogos/soccer/500/9.png"),
  L("fra.2", "Ligue 2", "Prancis", "Lainnya", "http://a.espncdn.com/i/leaguelogos/soccer/500/96.png"),
  L("uefa.champions", "Champions League", "Eropa", "Champions League", "https://a.espncdn.com/i/leaguelogos/soccer/500/2.png"),
  L("uefa.europa", "Europa League", "Eropa", "Lainnya", "https://a.espncdn.com/i/leaguelogos/soccer/500/2310.png"),
  L("uefa.europa.conf", "Conference League", "Eropa", "Lainnya", "https://a.espncdn.com/i/leaguelogos/soccer/500/20296.png"),
  L("uefa.nations", "Nations League", "Eropa", "Lainnya", "https://a.espncdn.com/i/leaguelogos/soccer/500/2395.png"),
  L("ned.1", "Eredivisie", "Belanda", "Lainnya", "https://a.espncdn.com/i/leaguelogos/soccer/500/11.png"),
  L("por.1", "Primeira Liga", "Portugal", "Lainnya", "https://a.espncdn.com/i/leaguelogos/soccer/500/14.png"),
  L("bel.1", "Pro League", "Belgia", "Lainnya", "https://a.espncdn.com/i/leaguelogos/soccer/500/6.png"),
  L("tur.1", "Super Lig", "Turki", "Lainnya", "https://a.espncdn.com/i/leaguelogos/soccer/500/18.png"),
  L("sco.1", "Scottish Premiership", "Skotlandia", "Lainnya", "https://a.espncdn.com/i/leaguelogos/soccer/500/45.png"),
  L("jpn.1", "J-League", "Jepang", "Liga Asia", "https://a.espncdn.com/i/leaguelogos/soccer/500/2199.png"),
  L("chn.1", "Chinese Super League", "China", "Liga Asia", "https://a.espncdn.com/i/leaguelogos/soccer/500/2350.png"),
  L("aus.1", "A-League", "Australia", "Liga Asia", "https://a.espncdn.com/i/leaguelogos/soccer/500/1308.png"),
  L("ksa.1", "Saudi Pro League", "Arab Saudi", "Liga Asia", "https://a.espncdn.com/i/leaguelogos/soccer/500/2488.png"),
  L("idn.1", "Liga 1 Indonesia", "Indonesia", "Liga Asia", "https://a.espncdn.com/i/leaguelogos/soccer/500/2336.png"),
  L("usa.1", "MLS", "Amerika Serikat", "Lainnya", "https://a.espncdn.com/i/leaguelogos/soccer/500/19.png"),
  L("bra.1", "Brasileirão", "Brasil", "Lainnya", "https://a.espncdn.com/i/leaguelogos/soccer/500/85.png"),
  L("mex.1", "Liga MX", "Meksiko", "Lainnya", "https://a.espncdn.com/i/leaguelogos/soccer/500/22.png"),
  L("arg.1", "Liga Argentina", "Argentina", "Lainnya", "https://a.espncdn.com/i/leaguelogos/soccer/500/1.png"),
  L("conmebol.libertadores", "Copa Libertadores", "Amerika Selatan", "Lainnya", "https://a.espncdn.com/i/leaguelogos/soccer/500/58.png"),
  L("conmebol.sudamericana", "Copa Sudamericana", "Amerika Selatan", "Lainnya", "https://a.espncdn.com/i/leaguelogos/soccer/500/1208.png")
];

/* ---------- ESPN API ---------- */
async function espnDay(code, ymd) {
  const res = await fetch(`${ESPN}/${code}/scoreboard?dates=${ymd}`, { headers: { Accept: "application/json" } });
  if (res.status === 400 || res.status === 404) return [];
  if (!res.ok) { const e = new Error("HTTP " + res.status); e.status = res.status; throw e; }
  return (await res.json()).events || [];
}

async function allSettledLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { status: "fulfilled", value: await fn(items[i]) }; }
      catch (reason) { out[i] = { status: "rejected", reason }; }
    }
  }));
  return out;
}

function errorText(e) {
  if (e.status === 429) return "Terlalu banyak request ke ESPN API.";
  return `Gagal memuat ESPN API (${e.message}).`;
}

/* ---------- Mapping ---------- */
// Odds Amerika (-180 / +475) -> desimal (1.56 / 5.75)
function dec(v) {
  const n = parseFloat(String(v ?? "").replace("+", ""));
  if (!isFinite(n) || n === 0) return 0;
  return +(n > 0 ? 1 + n / 100 : 1 + 100 / -n).toFixed(2);
}
// 2.5 -> "2.5", 2.75 -> "2.5 / 3.0"
const fmtLine = p => ((p * 4) % 2 === 0 ? p.toFixed(1) : (p - 0.25).toFixed(1) + " / " + (p + 0.25).toFixed(1));
const num = v => { const n = parseFloat(String(v ?? "").replace(/^[ou]/i, "")); return isFinite(n) ? n : null; };
const close = x => (x && (x.close || x.open)) || {};

function mapEvent(ev, cfg, order) {
  const c = (ev.competitions || [])[0] || {};
  const home = (c.competitors || []).find(t => t.homeAway === "home") || {};
  const away = (c.competitors || []).find(t => t.homeAway === "away") || {};
  const o = (c.odds || [])[0] || {};
  const ml = o.moneyline || {};
  const odds = [
    dec(close(ml.home).odds ?? (o.homeTeamOdds || {}).moneyLine),
    dec(close(ml.draw).odds ?? (o.drawOdds || {}).moneyLine),
    dec(close(ml.away).odds ?? (o.awayTeamOdds || {}).moneyLine)
  ];
  let side = "h", hdp = null; // line negatif = tim pemberi voor
  const hl = num(close((o.pointSpread || {}).home).line);
  const al = num(close((o.pointSpread || {}).away).line);
  if (hl !== null) { side = hl > 0 ? "a" : "h"; hdp = Math.abs(hl); }
  else if (al !== null) { side = al > 0 ? "h" : "a"; hdp = Math.abs(al); }
  let ou = null;
  const tl = num(close((o.total || {}).over).line);
  const p = tl !== null ? tl : (typeof o.overUnder === "number" ? o.overUnder : null);
  if (p !== null) ou = fmtLine(p);
  // Status asli dari ESPN (live / selesai) + skor
  const t = (ev.status || {}).type || {};
  let st;
  if (t.state === "in") st = { s: "live", min: parseInt((ev.status || {}).displayClock, 10) || 0, detail: t.shortDetail || "" };
  else if (t.state === "post") st = { s: "ft", detail: t.shortDetail || "FT" };
  else st = { s: "up" };

  return {
    id: "espn-" + ev.id, eventId: String(ev.id), leagueCode: cfg.keys[0], league: cfg.name, country: cfg.country, group: cfg.group, order,
    leagueLogo: cfg.logo || "",
    ts: Date.parse(ev.date), home: (home.team || {}).displayName || "-", away: (away.team || {}).displayName || "-",
    homeId: (home.team || {}).id || "", awayId: (away.team || {}).id || "",
    homeLogo: (home.team || {}).logo || "", awayLogo: (away.team || {}).logo || "",
    side, hdp, ou, odds: odds.some(Boolean) ? odds : [0, 0, 0],
    st, score: t.state === "pre" ? null : [home.score, away.score]
  };
}

// Tanggal YYYYMMDD (UTC) dari -(HISTORY+1) s/d +DAYS agar riwayat 3 hari & semua jam WIB tercakup
function ymdList() {
  const out = [];
  for (let d = -(HISTORY + 1); d <= DAYS; d++) out.push(new Date(Date.now() + d * 864e5).toISOString().slice(0, 10).replace(/-/g, ""));
  return out;
}

async function fetchLive() {
  const tasks = [];
  LEAGUES.forEach((cfg, order) => ymdList().forEach(ymd => tasks.push({ code: cfg.keys[0], ymd, cfg, order })));
  const results = await allSettledLimited(tasks, CONCURRENCY, t => espnDay(t.code, t.ymd));
  const failed = results.filter(r => r.status === "rejected").map(r => r.reason);
  if (failed.length === tasks.length) throw failed[0];
  const from = Date.now() - (HISTORY + 1) * 864e5, to = Date.now() + (DAYS + 1) * 864e5;
  const seen = new Set(), events = [];
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
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
  [0,"Premier League","19:30","Aston Villa","Tottenham","a",0.25,"2.5 / 3.0",2.95,3.80,2.30],
  [0,"Premier League","22:00","Arsenal","Chelsea","h",0.5,"2.5",1.85,3.60,4.20],
  [0,"La Liga","23:30","Barcelona","Atletico Madrid","h",0.5,"3.0",1.95,3.80,3.65],
  [0,"Serie A","23:00","Inter","Napoli","h",0.25,"2.5",2.10,3.40,3.50],
  [0,"Bundesliga","21:30","Bayer Leverkusen","VfB Stuttgart","h",0.75,"3.0 / 3.5",1.65,4.30,4.80],
  [0,"Ligue 1","23:00","Marseille","Lyon","h",0.25,"2.5 / 3.0",2.30,3.50,3.00],
  [0,"Champions League","23:45","Bayern Munich","PSG","h",0.25,"3.0 / 3.5",2.15,3.80,3.10],
  [0,"Champions League","23:45","Real Madrid","Dortmund","h",0.75,"3.0",1.60,4.20,5.00],
  [0,"J-League","17:00","Vissel Kobe","Yokohama F. Marinos","h",0.25,"2.5 / 3.0",2.20,3.50,3.10],
  [1,"Premier League","21:00","Liverpool","Manchester City","h",0,"3.0",2.60,3.60,2.55],
  [1,"La Liga","22:00","Sevilla","Valencia","h",0.25,"2.0 / 2.5",2.35,3.00,3.10],
  [1,"Serie A","23:45","Juventus","AC Milan","h",0.25,"2.0 / 2.5",2.30,3.10,3.20],
  [1,"Bundesliga","21:30","Borussia Dortmund","RB Leipzig","h",0.25,"3.0",2.30,3.70,2.90],
  [1,"Champions League","23:45","Napoli","Benfica","h",0.5,"2.5 / 3.0",1.90,3.60,4.10],
  [1,"K League","17:30","Ulsan HD","Jeonbuk Motors","h",0.25,"2.5",2.20,3.30,3.10],
  [1,"Saudi Pro League","23:00","Al Hilal","Al Nassr","h",0.5,"3.0 / 3.5",1.80,4.00,3.90],
  [2,"Premier League","22:00","Newcastle","Brighton","h",0.25,"2.5 / 3.0",2.25,3.60,3.10],
  [2,"La Liga","22:15","Athletic Bilbao","Girona","h",0.25,"2.5",2.30,3.20,3.15],
  [2,"Serie A","20:00","Roma","Lazio","h",0,"2.0 / 2.5",2.60,3.10,2.85],
  [2,"Bundesliga","20:30","Eintracht Frankfurt","Werder Bremen","h",0.5,"3.0",1.95,3.70,3.60],
  [2,"Champions League","23:45","Manchester City","Sporting CP","h",1.25,"3.5",1.28,5.75,9.50],
  [2,"Chinese Super League","18:35","Shanghai Port","Shandong Taishan","h",0.25,"2.5",2.15,3.30,3.20],
  [2,"A-League","15:00","Melbourne City","Sydney FC","h",0.25,"3.0",2.20,3.50,3.00]
];

function mockPayload(reason) {
  const dayOf = off => new Date(Date.now() + off * 864e5).toLocaleDateString("en-CA", { timeZone: TZ });
  const events = MOCK.map((r, i) => {
    const order = LEAGUES.findIndex(c => c.name === r[1]), cfg = LEAGUES[order] || { country: "", group: "Lainnya", logo: "" };
    return {
      id: "mock-" + i, eventId: "mock-" + i, leagueCode: cfg.keys?.[0] || "eng.1", league: r[1], country: cfg.country, group: cfg.group, order,
      leagueLogo: cfg.logo || "",
      ts: Date.parse(`${dayOf(r[0])}T${r[2]}:00+07:00`), home: r[3], away: r[4],
      homeLogo: "", awayLogo: "", side: r[5], hdp: r[6], ou: r[7], odds: [r[8], r[9], r[10]]
    };
  }).sort((a, b) => a.ts - b.ts);
  return { source: "mock", notice: reason + " Menampilkan data contoh.", updatedAt: new Date().toISOString(), events };
}

/* ---------- BERITA (liga top dunia, Bahasa Indonesia) ---------- */
const NEWS_LEAGUES = [
  ["eng.1", "Premier League"], ["esp.1", "La Liga"], ["ita.1", "Serie A"],
  ["ger.1", "Bundesliga"], ["fra.1", "Ligue 1"], ["uefa.champions", "Champions League"]
];
const NEWS_PER_LEAGUE = 8;
const NEWS_MAX = 30;
// Terjemahan EN -> ID (Google Translate publik, tanpa API key). Gagal -> teks asli.
async function toID(text) {
  if (!text) return "";
  try {
    const u = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=id&dt=t&q=" + encodeURIComponent(text);
    const r = await fetch(u);
    if (!r.ok) return text;
    const j = await r.json();
    return (j[0] || []).map(x => x[0]).join("") || text;
  } catch { return text; }
}

async function fetchNews() {
  const results = await allSettledLimited(NEWS_LEAGUES, CONCURRENCY, async ([code, name]) => {
    const r = await fetch(`${ESPN}/${code}/news?limit=${NEWS_PER_LEAGUE}`, { headers: { Accept: "application/json" } });
    if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
    return ((await r.json()).articles || []).map(a => ({ a, name }));
  });
  const seen = new Set(), list = [];
  results.forEach(r => r.status === "fulfilled" && r.value.forEach(({ a, name }) => {
    const id = String(a.id || a.headline);
    if (seen.has(id) || !a.headline) return;
    seen.add(id);
    list.push({
      id, league: name,
      headline: a.headline, description: a.description || "",
      published: a.published || a.lastModified || "",
      links: {
        web: ((a.links || {}).web || {}).href || "",
        mobile: ((a.links || {}).mobile || {}).href || "",
        app: (((a.links || {}).app || {}).sportscenter || {}).href || ""
      },
      images: (a.images || []).filter(i => i && i.url).map(i => ({ url: i.url, width: i.width || null, height: i.height || null, caption: i.caption || "" }))
    });
  }));
  if (!list.length) throw results.find(r => r.status === "rejected")?.reason || new Error("Berita kosong");
  list.sort((x, y) => Date.parse(y.published) - Date.parse(x.published));
  const top = list.slice(0, NEWS_MAX);
  await allSettledLimited(top, CONCURRENCY, async n => {
    [n.headline, n.description] = await Promise.all([toID(n.headline), toID(n.description)]);
    for (const img of n.images) if (img.caption) img.caption = await toID(img.caption);
  });
  return top;
}

/* ---------- ARTIKEL LENGKAP ---------- */
async function fetchArticle(id) {
  const r = await fetch(`https://now.core.api.espn.com/v1/sports/news/${encodeURIComponent(id)}`, { headers: { Accept: "application/json" } });
  if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
  const j = await r.json();
  const a = ((j.headlines || [])[0]) || {};
  let story = String(a.story || a.description || "")
    .replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<[^>]*>/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n").trim();
  const [headline, storyID] = await Promise.all([a.headline ? toID(a.headline) : "", story ? toID(story) : ""]);
  return { id: String(id), headline, story: storyID, link: ((a.links || {}).web || {}).href || "" };
}

/* ---------- SUSUNAN PEMAIN (LINEUP) LAMA TETAP ADA ---------- */
const LINEUP_WAIT = "Susunan pemain belum dirilis resmi (biasanya diumumkan 45–60 menit sebelum kick-off).";
function lineupName(value) {
  if (typeof value === "string") return value;
  return value?.displayName || value?.fullName || value?.name || value?.athlete?.displayName || "";
}

function mapLineup(summary) {
  const rosters = Array.isArray(summary.rosters) ? summary.rosters : [];
  const competitors = summary.header?.competitions?.[0]?.competitors || [];
  const teams = ["home", "away"].map(homeAway => {
    const competitor = competitors.find(c => c.homeAway === homeAway) || {};
    const roster = rosters.find(r => r.homeAway === homeAway || (r.team?.id && String(r.team.id) === String(competitor.team?.id))) || {};
    const team = roster.team || competitor.team || {};
    const players = (Array.isArray(roster.roster) ? roster.roster : []).filter(p => p.athlete?.displayName);
    const player = p => ({ name: p.athlete.displayName, jersey: String(p.jersey ?? p.athlete.jersey ?? ""), position: p.position?.name || p.position?.abbreviation || p.athlete.position?.name || p.athlete.position?.abbreviation || "" });
    const coach = lineupName(roster.coach || roster.manager || roster.coaches?.[0] || competitor.coach || team.coach || team.coaches?.[0]);
    return { homeAway, team: { name: team.displayName || team.name || (homeAway === "home" ? "Tuan Rumah" : "Tim Tamu"), logo: team.logo || team.logos?.[0]?.href || "" },
      formation: typeof roster.formation === "string" ? roster.formation : roster.formation?.displayName || "",
      starters: players.filter(p => p.starter === true).map(player), bench: players.filter(p => p.starter === false).map(player), coach };
  });
  const available = teams.some(t => t.starters.length > 0);
  return { available, message: available ? "" : LINEUP_WAIT, teams };
}

async function serveLineup(req, res, allowedLeagues) {
  const league = req.query?.league;
  const id = req.query?.id;
  if (typeof league !== "string" || !allowedLeagues.includes(league) || typeof id !== "string" || !/^\d{1,12}$/.test(id)) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(400).json({ error: "Liga atau ID pertandingan tidak valid." });
  }
  try {
    const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${encodeURIComponent(league)}/summary?event=${encodeURIComponent(id)}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      if (response.status === 404) {
        res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=60");
        return res.status(200).json({ source: "espn", available: false, message: LINEUP_WAIT, teams: [] });
      }
      throw new Error("HTTP " + response.status);
    }
    const payload = mapLineup(await response.json());
    res.setHeader("Cache-Control", `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=60`);
    return res.status(200).json({ source: "espn", league, id, updatedAt: new Date().toISOString(), ...payload });
  } catch {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ source: "error", available: false, message: "Gagal memuat susunan pemain dari ESPN. Silakan coba lagi.", teams: [] });
  }
}

/* ---------- MATCH CENTER LENGKAP (8 TAB) ---------- */
async function serveMatchCenter(req, res, allowedLeagues) {
  const league = req.query?.league || "eng.1";
  const id = req.query?.id;
  if (!id || !/^\d{1,12}$/.test(id)) {
    return res.status(400).json({ error: "ID pertandingan tidak valid." });
  }
  try {
    const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${encodeURIComponent(league)}/summary?event=${encodeURIComponent(id)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      return reply(res, { source: "espn", available: false, message: "Data pertandingan belum tersedia di ESPN." }, 60);
    }
    const data = await response.json();
    const cfg = LEAGUES.find(l => l.keys.includes(league));
    const leagueLogos = data.header?.league?.logos || [];
    const leagueLogo = (Array.isArray(leagueLogos) && leagueLogos[0]?.href)
      || cfg?.logo
      || (data.header?.league?.id ? `https://a.espncdn.com/i/leaguelogos/soccer/500/${data.header.league.id}.png` : "");
    const leagueName = data.header?.league?.name || cfg?.name || league;

    // Standings fallback jika di data.standings kosong
    let standings = data.standings || null;
    if (!standings) {
      try {
        const stRes = await fetch(`https://site.api.espn.com/apis/v2/sports/soccer/${encodeURIComponent(league)}/standings`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(5000)
        });
        if (stRes.ok) {
          standings = await stRes.json();
        }
      } catch {}
    }

    return reply(res, {
      source: "espn",
      available: true,
      updatedAt: new Date().toISOString(),
      match: {
        id,
        league,
        leagueName,
        leagueLogo,
        gameInfo: data.gameInfo || null,
        lastFiveGames: data.lastFiveGames || [],
        header: data.header || null,
        boxscore: data.boxscore || null,
        rosters: data.rosters || [],
        standings,
        predictor: data.predictor || null,
        pickcenter: data.pickcenter || null,
        plays: data.plays || data.keyEvents || [],
        lineup: mapLineup(data)
      }
    }, CACHE_SECONDS);
  } catch (e) {
    return reply(res, { source: "error", available: false, message: "Data pertandingan belum dapat dimuat saat ini." }, 60);
  }
}

/* ---------- SKUAD KLUB ---------- */
async function serveTeamSquad(req, res, allowedLeagues) {
  const league = req.query?.league || "eng.1";
  const teamId = req.query?.teamId || req.query?.id;
  if (!teamId || !/^\d{1,12}$/.test(teamId)) {
    return res.status(400).json({ error: "ID klub tidak valid." });
  }
  try {
    const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${encodeURIComponent(league)}/teams/${encodeURIComponent(teamId)}/roster`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      return reply(res, { source: "espn", available: false, message: "Data skuad belum tersedia." }, 60);
    }
    const data = await response.json();
    return reply(res, {
      source: "espn",
      available: true,
      updatedAt: new Date().toISOString(),
      team: data.team || {},
      athletes: data.athletes || []
    }, CACHE_SECONDS);
  } catch (e) {
    return reply(res, { source: "error", available: false, message: "Data skuad belum dapat dimuat saat ini." }, 60);
  }
}

/* ---------- Handler ---------- */
function reply(res, payload, seconds) {
  res.setHeader("Cache-Control", `public, s-maxage=${seconds}, stale-while-revalidate=${Math.min(seconds, 600)}`);
  return res.status(200).json(payload);
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const allowedLeagues = LEAGUES.flatMap(l => l.keys);
  // 1. Endpoint Match Center 8 Tab
  if (req.query && req.query.type === "match") {
    return serveMatchCenter(req, res, allowedLeagues);
  }
  // 2. Endpoint Skuad Klub
  if (req.query && req.query.type === "team") {
    return serveTeamSquad(req, res, allowedLeagues);
  }
  // 3. Endpoint Line Up
  if (req.query && req.query.type === "lineup") {
    return serveLineup(req, res, allowedLeagues);
  }
  // 4. Endpoint Artikel Berita Lengkap
  if (req.query && req.query.type === "article") {
    const id = String(req.query.id || "").trim();
    if (!/^\d{4,12}$/.test(id)) return res.status(400).json({ error: "id berita tidak valid" });
    try {
      const article = await fetchArticle(id);
      return reply(res, { source: "espn", updatedAt: new Date().toISOString(), article }, 3600);
    } catch (e) {
      console.error("espn article error:", e.message);
      return reply(res, { source: "error", notice: errorText(e), updatedAt: new Date().toISOString(), article: null }, 60);
    }
  }
  // 5. Endpoint Daftar Berita
  if (req.query && req.query.type === "news") {
    try {
      const articles = await fetchNews();
      return reply(res, { source: "espn", updatedAt: new Date().toISOString(), articles }, CACHE_SECONDS);
    } catch (e) {
      console.error("espn news error:", e.message);
      return reply(res, { source: "error", notice: errorText(e), updatedAt: new Date().toISOString(), articles: [] }, 60);
    }
  }
  // 6. Endpoint Utama: Pasaran & Jadwal Pertandingan
  try {
    const { events, failed } = await fetchLive();
    if (!events.length) return reply(res, mockPayload("Tidak ada pertandingan terjadwal dari ESPN."), 300);
    const notice = failed.length ? `${errorText(failed[0])} ${failed.length} permintaan gagal.` : "";
    return reply(res, { source: "espn", notice, updatedAt: new Date().toISOString(), events }, failed.length ? 60 : CACHE_SECONDS);
  } catch (e) {
    console.error("espn api error:", e.message);
    return reply(res, mockPayload(errorText(e)), 60);
  }
};
