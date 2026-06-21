/* Sleeper Trade Shield
   Static web app for Sleeper fantasy football league analysis.
   Uses only public/read-only Sleeper API endpoints. */

const API_BASE = 'https://api.sleeper.app/v1';
const API_STATS_BASE = 'https://api.sleeper.com/stats/nfl/player';
const STORAGE_KEYS = {
  leagues: 'sts.leagueIds',
  selectedLeague: 'sts.selectedLeagueId',
  settings: 'sts.settings'
};

const DEFAULT_SETTINGS = {
  ageWeight: 1,
  recentWeight: 1,
  needWeight: 1,
  pickWeight: 1
};

const POSITION_ORDER = ['QB', 'RB', 'WR', 'TE', 'DL', 'LB', 'DB', 'K', 'DEF'];
const PICK_BASE_VALUES = { 1: 4200, 2: 1600, 3: 650, 4: 275, 5: 110, 6: 50 };
const FLEX_SLOTS = new Set(['FLEX', 'REC_FLEX', 'WRRB_FLEX', 'WRT', 'RB_WR_TE']);
const SUPER_FLEX_SLOTS = new Set(['SUPER_FLEX', 'SUPERFLEX', 'OP']);
const IDP_FLEX_SLOTS = new Set(['IDP_FLEX', 'DL_LB_DB']);
const RECENT_GAME_COUNT = 5;


// KTC-style dynasty market anchors. These are intentionally offline, approximate anchors, not a live KTC scrape.
// They give the app a dynasty-market spine so stat-efficient players cannot leapfrog higher-value assets solely from PPG.
const KTC_STYLE_MARKET_ANCHORS = {
  'josh allen': 9985,
  'bijan robinson': 9980,
  'jamar chase': 9960,
  'ja\'marr chase': 9960,
  'jahmyr gibbs': 9880,
  'jaxon smith njigba': 9630,
  'jaxon smith-njigba': 9630,
  'drake maye': 9420,
  'puka nacua': 8710,
  'brock bowers': 8110,
  'caleb williams': 8030,
  'amon ra st brown': 7900,
  'amon-ra st. brown': 7900,
  'amon-ra st brown': 7900,
  'jayden daniels': 7840,
  'justin jefferson': 7680,
  'ashton jeanty': 7680,
  'lamar jackson': 7640,
  'malik nabers': 7490,
  'joe burrow': 7440,
  'trey mcbride': 7380,
  'patrick mahomes': 7350,
  'jalen hurts': 7300,
  'ceedee lamb': 7150,
  'c d lamb': 7150,
  'cj stroud': 7000,
  'c.j. stroud': 7000,
  'justin herbert': 6900,
  'malik washington': 2500,
  'kyler murray': 6350,
  'jordan love': 6250,
  'anthony richardson': 5900,
  'bo nix': 5850,
  'baker mayfield': 5600,
  'brock purdy': 5450,
  'dak prescott': 5350,
  'tua tagovailoa': 5200,
  'jared goff': 5000,
  'trevor lawrence': 4900,
  'sam darnold': 3500,
  'matthew stafford': 3000,
  'aaron rodgers': 1200
};

const KTC_STYLE_QB_CEILING_BY_ANCHOR = [
  { maxAnchor: 99999, ceiling: 9999 },
  { maxAnchor: 9000, ceiling: 9650 },
  { maxAnchor: 8000, ceiling: 8750 },
  { maxAnchor: 7000, ceiling: 7900 },
  { maxAnchor: 6000, ceiling: 7050 },
  { maxAnchor: 5000, ceiling: 6100 },
  { maxAnchor: 4000, ceiling: 5150 },
  { maxAnchor: 0, ceiling: 4300 }
];

const state = {
  nflState: null,
  players: {},
  playerSearch: [],
  leagues: [],
  savedLeagueIds: loadSavedLeagueIds(),
  selectedAssets: { A: [], B: [] },
  settings: loadSettings()
};

const $ = (id) => document.getElementById(id);

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(STORAGE_KEYS.settings) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings));
}

function loadSavedLeagueIds() {
  try {
    return parseLeagueIds(localStorage.getItem(STORAGE_KEYS.leagues) || '');
  } catch {
    return [];
  }
}

function saveLeagueIds(ids) {
  state.savedLeagueIds = [...new Set((ids || []).map(String).filter(Boolean))];
  localStorage.setItem(STORAGE_KEYS.leagues, state.savedLeagueIds.join('\n'));
}

async function addSavedLeagueId() {
  const input = $('leagueIdInput');
  const ids = parseLeagueIds(`${input.value}\n${state.savedLeagueIds.join('\n')}`);
  if (!ids.length) {
    alert('Enter a valid Sleeper league ID.');
    return;
  }
  saveLeagueIds(ids);
  input.value = '';
  logStatus(`Saved ${ids.length} league ID${ids.length === 1 ? '' : 's'} in this browser.`);
  await loadAll(ids);
}

function logStatus(message) {
  console.log(`[Trade Shield] ${message}`);
  const el = $('statusLog');
  if (!el) return;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  el.textContent = `${time} — ${message}\n${el.textContent}`.trim();
}

function setBusy(isBusy) {
  const loadBtn = $('loadLeaguesBtn');
  if (loadBtn) loadBtn.disabled = isBusy;
  if ($('addLeagueIdBtn')) $('addLeagueIdBtn').disabled = isBusy;
  if ($('clearBtn')) $('clearBtn').disabled = isBusy;
}

async function fetchJson(url, label = url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${label} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseLeagueIds(raw) {
  return [...new Set((raw || '')
    .split(/[\s,;]+/)
    .map(x => x.trim())
    .filter(Boolean)
    .filter(x => /^\d{10,}$/.test(x)))];
}

function getPlayer(pid) {
  return state.players?.[String(pid)] || null;
}

function playerName(pid) {
  const p = getPlayer(pid);
  if (!p) return String(pid);
  if (p.full_name) return p.full_name;
  return [p.first_name, p.last_name].filter(Boolean).join(' ') || p.search_full_name || String(pid);
}

function playerPrimaryPosition(pid) {
  const p = getPlayer(pid);
  if (!p) return 'UNK';
  if (p.position) return p.position;
  if (Array.isArray(p.fantasy_positions) && p.fantasy_positions.length) return p.fantasy_positions[0];
  return 'UNK';
}

function playerFantasyPositions(pid) {
  const p = getPlayer(pid);
  const positions = new Set();
  if (p?.position) positions.add(p.position);
  if (Array.isArray(p?.fantasy_positions)) p.fantasy_positions.forEach(pos => positions.add(pos));
  return [...positions];
}

function teamName(league, rosterId) {
  const roster = league.rosterMap.get(Number(rosterId));
  if (!roster) return `Roster ${rosterId}`;
  const user = league.userMap.get(roster.owner_id);
  return user?.metadata?.team_name || user?.display_name || user?.username || `Roster ${rosterId}`;
}

function roundNum(n, digits = 1) {
  const value = Number(n || 0);
  return Number(value.toFixed(digits));
}

function safeNumber(n, fallback = 0) {
  const value = Number(n);
  return Number.isFinite(value) ? value : fallback;
}

function hasNonZeroPlayerPoint(pointsMap = {}) {
  return Object.values(pointsMap || {}).some(value => Math.abs(safeNumber(value, 0)) > 0.005);
}

function matchupWeekHasScoredData(matchups = []) {
  return (matchups || []).some(matchup => {
    if (Math.abs(safeNumber(matchup?.points, 0)) > 0.005) return true;
    const pointsMap = matchup?.players_points || matchup?.player_points || {};
    return hasNonZeroPlayerPoint(pointsMap);
  });
}

function shouldCountLeagueStatLine(points, didStart) {
  return Math.abs(safeNumber(points, 0)) > 0.005 || Boolean(didStart);
}

function historicalStatLinePlayed(stats = {}, points = 0) {
  if (Math.abs(safeNumber(points, 0)) > 0.005) return true;
  const ignored = new Set([
    'week', 'game_week', 'display_week', 'season', 'season_type', 'game_id', 'player_id',
    'team', 'team_abbr', 'opponent', 'opp', 'company', 'sport', 'category', 'date'
  ]);
  return Object.entries(stats || {}).some(([key, value]) => {
    if (ignored.has(String(key))) return false;
    const num = Number(value);
    return Number.isFinite(num) && Math.abs(num) > 0.005;
  });
}

function recordHasGames(rec) {
  return Boolean(rec && safeNumber(rec.games, 0) > 0);
}

function totalFpts(settings = {}) {
  return safeNumber(settings.fpts) + safeNumber(settings.fpts_decimal) / 100;
}

function totalAgainst(settings = {}) {
  return safeNumber(settings.fpts_against) + safeNumber(settings.fpts_against_decimal) / 100;
}

function currentSeasonNumber(league) {
  return Number(league?.season || state.nflState?.season || new Date().getFullYear());
}

function isDynastyLeague(league) {
  const settings = league.settings || {};
  return Boolean(
    settings.taxi_slots ||
    settings.reserve_slots ||
    settings.type === 2 ||
    String(league.name || '').toLowerCase().includes('dynasty') ||
    (league.roster_positions || []).length >= 18
  );
}

function isSuperflexLeague(league) {
  return (league.roster_positions || []).some(slot => SUPER_FLEX_SLOTS.has(String(slot).toUpperCase()));
}

function isTightEndPremium(league) {
  const scoring = league.scoring_settings || {};
  return safeNumber(scoring.bonus_rec_te) > 0 || safeNumber(scoring.rec_te) > safeNumber(scoring.rec);
}

function idpSlotCount(league) {
  return (league.roster_positions || []).filter(slot => {
    const s = String(slot).toUpperCase();
    return ['DL', 'LB', 'DB', 'IDP'].includes(s) || IDP_FLEX_SLOTS.has(s);
  }).length;
}

function activeLeaguePositions(league) {
  const active = new Set();
  const starterSlots = (league?.roster_positions || [])
    .map(slot => String(slot).toUpperCase())
    .filter(slot => !['BN', 'BE', 'IR', 'TAXI'].includes(slot));

  for (const slot of starterSlots) {
    if (POSITION_ORDER.includes(slot)) active.add(slot);
    if (FLEX_SLOTS.has(slot)) ['RB', 'WR', 'TE'].forEach(pos => active.add(pos));
    if (SUPER_FLEX_SLOTS.has(slot)) ['QB', 'RB', 'WR', 'TE'].forEach(pos => active.add(pos));
    if (IDP_FLEX_SLOTS.has(slot) || slot === 'IDP') ['DL', 'LB', 'DB'].forEach(pos => active.add(pos));
  }

  return active;
}

async function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('SleeperTradeShieldDB', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    const req = tx.objectStore('kv').put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function loadPlayers() {
  const cached = await idbGet('players.nfl.v1');
  const day = 24 * 60 * 60 * 1000;
  if (cached?.players && Date.now() - cached.savedAt < day) {
    state.players = cached.players;
    preparePlayerSearch();
    logStatus(`Loaded ${Object.keys(state.players).length.toLocaleString()} players from local cache.`);
    return;
  }

  logStatus('Fetching Sleeper player database. This is large and should only happen about once per day.');
  const players = await fetchJson(`${API_BASE}/players/nfl`, 'players');
  state.players = players || {};
  await idbSet('players.nfl.v1', { savedAt: Date.now(), players: state.players });
  preparePlayerSearch();
  logStatus(`Fetched ${Object.keys(state.players).length.toLocaleString()} players.`);
}

function preparePlayerSearch() {
  state.playerSearch = Object.values(state.players || {})
    .filter(p => p && p.player_id && (p.full_name || p.first_name || p.last_name || p.search_full_name))
    .map(p => {
      const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || p.search_full_name;
      return {
        id: String(p.player_id),
        name,
        label: `${name} — ${p.position || 'UNK'} ${p.team || ''}`.trim(),
        search: `${name} ${p.search_full_name || ''} ${p.position || ''} ${p.team || ''}`.toLowerCase()
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const datalist = $('playerOptions');
  datalist.innerHTML = '';
  state.playerSearch.slice(0, 5000).forEach(p => {
    const option = document.createElement('option');
    option.value = p.label;
    datalist.appendChild(option);
  });
  const metricPlayersEl = $('metricPlayers');
  if (metricPlayersEl) metricPlayersEl.textContent = Object.keys(state.players || {}).length.toLocaleString();
}

function findPlayerFromInput(input) {
  const value = String(input || '').toLowerCase().trim();
  if (!value) return null;
  const exact = state.playerSearch.find(p => p.label.toLowerCase() === value || p.name.toLowerCase() === value);
  if (exact) return exact;
  return state.playerSearch.find(p => p.search.includes(value));
}

async function loadNflState() {
  state.nflState = await fetchJson(`${API_BASE}/state/nfl`, 'NFL state');
  logStatus(`NFL state loaded: season ${state.nflState.season}, week ${state.nflState.week}.`);
}

async function loadLeague(leagueId) {
  const league = await fetchJson(`${API_BASE}/league/${leagueId}`, `league ${leagueId}`);
  if (!league?.league_id) throw new Error(`League ${leagueId} was not found.`);

  logStatus(`Loading ${league.name || leagueId}: rosters, users, picks, drafts, matchups, transactions.`);
  const [users, rosters, tradedPicks, drafts] = await Promise.all([
    fetchJson(`${API_BASE}/league/${leagueId}/users`, 'users'),
    fetchJson(`${API_BASE}/league/${leagueId}/rosters`, 'rosters'),
    fetchJson(`${API_BASE}/league/${leagueId}/traded_picks`, 'traded picks').catch(() => []),
    fetchJson(`${API_BASE}/league/${leagueId}/drafts`, 'drafts').catch(() => [])
  ]);

  const draftPicks = [];
  for (const draft of (drafts || [])) {
    try {
      const picks = await fetchJson(`${API_BASE}/draft/${draft.draft_id}/picks`, `draft picks ${draft.draft_id}`);
      draftPicks.push(...(picks || []));
      await delay(50);
    } catch (err) {
      console.warn(err);
    }
  }

  const weeksToLoad = inferWeeksToLoad(league);
  const matchupsByWeek = {};
  const transactionsByWeek = {};

  for (const week of weeksToLoad) {
    try {
      const [matchups, transactions] = await Promise.all([
        fetchJson(`${API_BASE}/league/${leagueId}/matchups/${week}`, `matchups week ${week}`).catch(() => []),
        fetchJson(`${API_BASE}/league/${leagueId}/transactions/${week}`, `transactions week ${week}`).catch(() => [])
      ]);
      if (Array.isArray(matchups) && matchups.length && matchupWeekHasScoredData(matchups)) matchupsByWeek[week] = matchups;
      if (Array.isArray(transactions) && transactions.length) transactionsByWeek[week] = transactions;
      await delay(80);
    } catch (err) {
      console.warn(err);
    }
  }

  const enriched = {
    ...league,
    users: users || [],
    rosters: rosters || [],
    tradedPicks: tradedPicks || [],
    drafts: drafts || [],
    draftPicks,
    matchupsByWeek,
    transactionsByWeek,
    userMap: new Map((users || []).map(u => [u.user_id, u])),
    rosterMap: new Map((rosters || []).map(r => [Number(r.roster_id), r])),
    playerStats: new Map(),
    historicalStats: new Map(),
    historyLoadedSeasons: [],
    historyLoadError: '',
    valueCache: new Map(),
    teamStrength: new Map()
  };

  buildPlayerStats(enriched);
  await fetchHistoricalStatsForLeague(enriched);
  buildTeamStrength(enriched);
  logStatus(`Loaded ${league.name}: ${Object.keys(matchupsByWeek).length} matchup weeks, ${Object.values(transactionsByWeek).flat().length} transactions, ${enriched.historyLoadedSeasons.length ? `${enriched.historyLoadedSeasons.join(', ')} historical stats` : 'no historical stats'}.`);
  return enriched;
}

function inferWeeksToLoad(league) {
  const currentWeek = safeNumber(state.nflState?.week || state.nflState?.display_week, 1);
  const leagueSeason = String(league.season || '');
  const nflSeason = String(state.nflState?.season || '');
  const isCurrentSeason = leagueSeason && nflSeason && leagueSeason === nflSeason;
  const playoffStart = safeNumber(league.settings?.playoff_week_start, 15);
  const maxWeek = isCurrentSeason ? Math.max(1, Math.min(18, currentWeek || 1)) : 18;
  const configuredMax = league.status === 'complete' ? Math.max(18, playoffStart + 3) : maxWeek;
  return Array.from({ length: Math.min(22, configuredMax) }, (_, i) => i + 1);
}

function buildPlayerStats(league) {
  const map = new Map();
  Object.entries(league.matchupsByWeek || {}).forEach(([weekText, matchups]) => {
    const week = Number(weekText);
    for (const matchup of matchups || []) {
      const players = matchup.players || [];
      const starters = new Set(matchup.starters || []);
      const pointsMap = matchup.players_points || matchup.player_points || {};
      for (const pid of players) {
        const pidText = String(pid);
        const pts = safeNumber(pointsMap?.[pid] ?? pointsMap?.[pidText], 0);
        const didStart = starters.has(pid) || starters.has(pidText);
        if (!shouldCountLeagueStatLine(pts, didStart)) continue;
        if (!map.has(pidText)) {
          map.set(pidText, {
            playerId: pidText, total: 0, games: 0, starts: 0, starterTotal: 0, benchTotal: 0,
            weeks: [], high: 0, rosterIds: new Set(), last4: []
          });
        }
        const rec = map.get(pidText);
        rec.total += pts;
        rec.games += 1;
        rec.high = Math.max(rec.high, pts);
        rec.weeks.push({ week, season: Number(league.season || currentSeasonNumber(league)), seasonType: week >= safeNumber(league.settings?.playoff_week_start, 15) ? 'post' : 'regular', points: pts, started: didStart, rosterId: matchup.roster_id });
        rec.rosterIds.add(matchup.roster_id);
        if (didStart) {
          rec.starts += 1;
          rec.starterTotal += pts;
        } else {
          rec.benchTotal += pts;
        }
      }
    }
  });

  for (const rec of map.values()) {
    rec.ppg = rec.games ? rec.total / rec.games : 0;
    rec.startRate = rec.games ? rec.starts / rec.games : 0;
    rec.weeks.sort((a, b) => a.week - b.week);
    rec.last4 = rec.weeks.slice(-RECENT_GAME_COUNT);
    rec.last4Avg = rec.last4.length ? rec.last4.reduce((sum, w) => sum + w.points, 0) / rec.last4.length : rec.ppg;
  }
  league.playerStats = map;
}

function historicalSeasonsToLoad(league) {
  const base = currentSeasonNumber(league);
  const nflSeason = Number(state.nflState?.season || 0);
  const currentWeek = safeNumber(state.nflState?.week || state.nflState?.display_week, 1);
  const hasPlayedLeagueWeeks = Object.keys(league?.matchupsByWeek || {}).length > 0;
  const isCurrentNflSeason = nflSeason && Number(base) === nflSeason;
  const includeCurrent = !isCurrentNflSeason || hasPlayedLeagueWeeks || league?.status === 'complete' || currentWeek > 1;
  const start = includeCurrent ? base : base - 1;
  return [start, start - 1, start - 2].filter(season => season >= 2018);
}

function leagueHistoryCacheKey(league, seasons) {
  const scoringHash = JSON.stringify(league.scoring_settings || {}).split('').reduce((hash, ch) => ((hash << 5) - hash + ch.charCodeAt(0)) | 0, 0);
  return `history.${league.league_id}.${seasons.join('-')}.${scoringHash}.v7`;
}

function rosteredPlayerIds(league) {
  return [...new Set((league.rosters || []).flatMap(r => r.players || []).map(String).filter(Boolean))];
}

async function fetchHistoricalStatsForLeague(league) {
  const seasons = historicalSeasonsToLoad(league);
  const playerIds = rosteredPlayerIds(league).slice(0, 320);
  if (!playerIds.length || !seasons.length) return;

  const cacheKey = leagueHistoryCacheKey(league, seasons);
  const cached = await idbGet(cacheKey).catch(() => null);
  const twelveHours = 12 * 60 * 60 * 1000;
  if (cached?.rows && Date.now() - cached.savedAt < twelveHours) {
    applyHistoricalRows(league, cached.rows);
    league.historyLoadedSeasons = cached.seasons || seasons;
    logStatus(`Loaded historical player stats for ${league.name} from local cache.`);
    return;
  }

  logStatus(`Fetching historical stats for ${league.name}. This may take a moment on iPhone.`);
  const tasks = [];
  for (const season of seasons) {
    for (const pid of playerIds) {
      tasks.push({ pid, season, seasonType: 'regular' });
      tasks.push({ pid, season, seasonType: 'post' });
    }
  }

  const rows = [];
  const concurrency = 8;
  let index = 0;
  let failures = 0;

  async function worker() {
    while (index < tasks.length) {
      const task = tasks[index++];
      try {
        const payload = await fetchJson(`${API_STATS_BASE}/${task.pid}?season_type=${task.seasonType}&season=${task.season}&grouping=week`, `stats ${task.pid} ${task.season} ${task.seasonType}`);
        rows.push(...normalizeHistoricalPayload(task.pid, task.season, payload, league, task.seasonType));
      } catch (err) {
        failures += 1;
        if (failures <= 2) console.warn(err);
      }
      if (index % 60 === 0) logStatus(`Historical stats progress: ${index}/${tasks.length} requests.`);
      await delay(20);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  applyHistoricalRows(league, rows);
  league.historyLoadedSeasons = seasons.filter(season => rows.some(row => Number(row.season) === Number(season)));
  league.historyLoadError = rows.length ? '' : 'Historical stat endpoint returned no usable rows.';
  await idbSet(cacheKey, { savedAt: Date.now(), seasons: league.historyLoadedSeasons, rows }).catch(() => null);
  logStatus(rows.length ? `Historical stats loaded: ${rows.length.toLocaleString()} player-week rows.` : `Historical stats were unavailable from the public stats endpoint.`);
}

function normalizeHistoricalPayload(playerId, season, payload, league, seasonType = 'regular') {
  if (!payload) return [];
  const entries = Array.isArray(payload)
    ? payload.map((value, idx) => [idx + 1, value])
    : Object.entries(payload);

  return entries.map(([key, value]) => {
    const raw = value?.stats && typeof value.stats === 'object' ? { ...value.stats, ...value } : { ...(value || {}) };
    delete raw.stats;
    const week = Number(raw.week || raw.game_week || raw.display_week || key);
    const stats = value?.stats && typeof value.stats === 'object' ? value.stats : raw;
    const points = fantasyPointsFromStats(stats, league.scoring_settings || {});
    return {
      playerId: String(playerId),
      season: Number(raw.season || season),
      week: Number.isFinite(week) ? week : 0,
      points: roundNum(points, 2),
      stats,
      started: false,
      rosterId: null,
      seasonType: seasonType === 'post' ? 'post' : 'regular'
    };
  }).filter(row => row.week && Number.isFinite(row.points) && historicalStatLinePlayed(row.stats, row.points));
}

function fantasyPointsFromStats(stats = {}, scoring = {}) {
  let total = 0;
  for (const [key, value] of Object.entries(scoring || {})) {
    const multiplier = Number(value);
    if (!Number.isFinite(multiplier) || !Object.prototype.hasOwnProperty.call(stats, key)) continue;
    total += safeNumber(stats[key]) * multiplier;
  }

  const bonusRules = [
    ['bonus_pass_yd_300', 'pass_yd', 300], ['bonus_pass_yd_400', 'pass_yd', 400],
    ['bonus_rush_yd_100', 'rush_yd', 100], ['bonus_rush_yd_200', 'rush_yd', 200],
    ['bonus_rec_yd_100', 'rec_yd', 100], ['bonus_rec_yd_200', 'rec_yd', 200]
  ];
  for (const [bonusKey, statKey, threshold] of bonusRules) {
    if (safeNumber(scoring[bonusKey]) && safeNumber(stats[statKey]) >= threshold && !Object.prototype.hasOwnProperty.call(stats, bonusKey)) {
      total += safeNumber(scoring[bonusKey]);
    }
  }

  if (!total) {
    const fallback = stats.pts_ppr ?? stats.pts_half_ppr ?? stats.pts_std ?? stats.fantasy_points ?? stats.points;
    total = safeNumber(fallback, 0);
  }
  return total;
}

function applyHistoricalRows(league, rows) {
  const byPlayer = new Map();
  for (const row of rows || []) {
    const pid = String(row.playerId);
    if (!byPlayer.has(pid)) byPlayer.set(pid, { playerId: pid, seasons: {}, summary: null });
    const entry = byPlayer.get(pid);
    const season = Number(row.season);
    if (!entry.seasons[season]) entry.seasons[season] = blankStatRecord(pid, season);
    addWeekToRecord(entry.seasons[season], row);
  }

  for (const entry of byPlayer.values()) {
    const seasonRecords = Object.values(entry.seasons);
    seasonRecords.forEach(finalizeStatRecord);
    entry.summary = combineHistoricalRecords(entry.playerId, seasonRecords);
    league.historicalStats.set(entry.playerId, entry);
  }
}

function blankStatRecord(playerId, season = null) {
  return {
    playerId: String(playerId), season, total: 0, games: 0, starts: 0, starterTotal: 0, benchTotal: 0,
    weeks: [], high: 0, rosterIds: new Set(), last4: [], ppg: 0, last4Avg: 0, startRate: 0,
    source: season ? 'historical' : 'league'
  };
}

function addWeekToRecord(rec, row) {
  const pts = safeNumber(row.points, 0);
  const didStart = Boolean(row.started);
  rec.total += pts;
  rec.games += 1;
  rec.high = Math.max(rec.high, pts);
  rec.weeks.push({
    week: Number(row.week),
    season: row.season ?? rec.season,
    points: pts,
    started: didStart,
    rosterId: row.rosterId ?? row.roster_id ?? null,
    stats: row.stats || null,
    seasonType: row.seasonType || 'regular'
  });
  if (row.rosterId || row.roster_id) rec.rosterIds.add(row.rosterId ?? row.roster_id);
  if (didStart) {
    rec.starts += 1;
    rec.starterTotal += pts;
  } else {
    rec.benchTotal += pts;
  }
}

function finalizeStatRecord(rec) {
  rec.ppg = rec.games ? rec.total / rec.games : 0;
  rec.startRate = rec.games ? rec.starts / rec.games : 0;
  rec.weeks.sort((a, b) => Number(a.season || 0) - Number(b.season || 0) || a.week - b.week);
  rec.last4 = rec.weeks.slice(-RECENT_GAME_COUNT);
  rec.last4Avg = rec.last4.length ? rec.last4.reduce((sum, w) => sum + w.points, 0) / rec.last4.length : rec.ppg;
  return rec;
}

function combineHistoricalRecords(playerId, records) {
  const combined = blankStatRecord(playerId, 'multi');
  const sorted = records.slice().sort((a, b) => Number(b.season) - Number(a.season));
  sorted.slice(0, 2).forEach(rec => rec.weeks.forEach(row => addWeekToRecord(combined, row)));
  combined.source = 'historical';
  return finalizeStatRecord(combined);
}

function productionRecord(league, playerId) {
  const current = league.playerStats?.get(String(playerId));
  if (recordHasGames(current) && current.games >= 2) return current;
  const historical = league.historicalStats?.get(String(playerId))?.summary;
  if (recordHasGames(historical)) return historical;
  return recordHasGames(current) ? current : null;
}

function displayRecordForPlayer(league, playerId) {
  const select = $('playerStatsSeasonSelect');
  const mode = select?.value || 'auto';
  if (mode === 'league') return league.playerStats?.get(String(playerId)) || blankStatRecord(playerId);
  if (mode !== 'auto') {
    const record = league.historicalStats?.get(String(playerId))?.seasons?.[Number(mode)];
    return record || blankStatRecord(playerId, Number(mode));
  }
  return productionRecord(league, playerId) || blankStatRecord(playerId);
}

function positionPercentile(league, playerId) {
  const pos = playerPrimaryPosition(playerId);
  const rec = productionRecord(league, playerId);
  const ppg = rec?.ppg || 0;
  const rostered = rosteredPlayerIds(league);
  const values = rostered
    .filter(pid => playerPrimaryPosition(pid) === pos)
    .map(pid => productionRecord(league, pid))
    .filter(r => r?.games >= 1)
    .map(r => r.ppg)
    .sort((a, b) => a - b);
  if (!values.length) return 0.35;
  const below = values.filter(v => v <= ppg).length;
  return below / values.length;
}

function ageAdjustment(player, league) {
  if (!player || !player.age || !isDynastyLeague(league)) return 0;
  const age = safeNumber(player.age, 0);
  const pos = player.position || 'UNK';
  let adj = 0;
  if (pos === 'QB') adj = age <= 24 ? 10 : age <= 31 ? 8 : age <= 36 ? 2 : -8;
  else if (pos === 'RB') adj = age <= 23 ? 12 : age <= 26 ? 8 : age <= 28 ? -3 : -15;
  else if (pos === 'WR') adj = age <= 24 ? 10 : age <= 28 ? 8 : age <= 31 ? 0 : -9;
  else if (pos === 'TE') adj = age <= 24 ? 8 : age <= 30 ? 7 : age <= 33 ? 0 : -8;
  else if (['DL', 'LB', 'DB'].includes(pos)) adj = age <= 27 ? 5 : age <= 31 ? 2 : -5;
  return adj * state.settings.ageWeight;
}

function statusAdjustment(player) {
  const status = String(player?.injury_status || player?.status || '').toLowerCase();
  if (!status) return 0;
  if (['ir', 'out', 'pup', 'suspended'].some(s => status.includes(s))) return -18;
  if (status.includes('doubtful')) return -10;
  if (status.includes('questionable')) return -4;
  if (status.includes('inactive')) return -8;
  return 0;
}

function dynastyMarketNameKey(name = '') {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function playerMarketAnchorKey(player, playerId = '') {
  const direct = dynastyMarketNameKey(player?.full_name || player?.metadata?.full_name || player?.search_full_name || '');
  if (direct) return direct;
  return dynastyMarketNameKey(playerName(playerId));
}

function rankFallbackValue(player) {
  const rank = safeNumber(player?.search_rank, 9999);
  if (!rank || rank >= 9999) return 900;
  return rankToKtcValue(rank, player?.position || 'UNK');
}

function clampNumber(value, min, max) {
  const num = safeNumber(value, 0);
  return Math.min(max, Math.max(min, num));
}

function rankToKtcValue(rank, position = 'UNK') {
  const r = Math.max(1, safeNumber(rank, 9999));
  // Approximate KTC-style dynasty curve: very steep at the top, then long tail.
  let value = Math.round(9800 * Math.pow(r, -0.31));
  value = clampNumber(value, 120, 9600);

  // Sleeper search_rank can be overly optimistic for efficient veteran QBs, so compress fallback QB anchors.
  if (position === 'QB') {
    if (r <= 12) value = Math.min(value, 7600);
    else if (r <= 30) value = Math.min(value, 6500);
    else if (r <= 60) value = Math.min(value, 5600);
    else if (r <= 100) value = Math.min(value, 4800);
    else value = Math.min(value, 4000);
  }

  return value;
}

function ktcStyleMarketAnchor(player, playerId = '') {
  const pos = player?.position || playerPrimaryPosition(playerId) || 'UNK';
  const key = playerMarketAnchorKey(player, playerId);
  const anchored = KTC_STYLE_MARKET_ANCHORS[key];
  if (Number.isFinite(anchored)) return anchored;

  const rank = safeNumber(player?.search_rank, 9999);
  let value = rankToKtcValue(rank, pos);

  // Dynasty positional smoothing when no named market anchor is available.
  const age = safeNumber(player?.age, 0);
  if (pos === 'RB' && age && age > 28) value *= 0.72;
  if (pos === 'WR' && age && age > 31) value *= 0.76;
  if (pos === 'TE' && age && age <= 25) value *= 1.08;
  if (pos === 'QB' && age && age <= 25) value *= 1.05;
  if (['K', 'DEF'].includes(pos)) value = Math.min(value, 450);
  if (['DL', 'LB', 'DB'].includes(pos)) value = Math.min(value, 1800);

  return Math.round(clampNumber(value, 80, 9800));
}

function marketAnchorValue(player, position = '', playerId = '') {
  return ktcStyleMarketAnchor({ ...(player || {}), position: position || player?.position }, playerId);
}

function sumStatsFromRecord(rec, keys = []) {
  return (rec?.weeks || []).reduce((sum, row) => {
    const stats = row?.stats || {};
    const found = keys.find(key => stats?.[key] !== undefined && stats?.[key] !== null && stats?.[key] !== '');
    return sum + safeNumber(found ? stats[found] : 0, 0);
  }, 0);
}

function qbRushingAdjustment(rec) {
  if (!rec?.games) return 0;
  const rushYds = sumStatsFromRecord(rec, ['rush_yd', 'rushing_yards']);
  const rushTds = sumStatsFromRecord(rec, ['rush_td', 'rushing_touchdowns']);
  const rushAtt = sumStatsFromRecord(rec, ['rush_att', 'rushing_attempts']);
  const rushYdsPerGame = rushYds / rec.games;
  const rushTdsPerGame = rushTds / rec.games;
  const rushAttPerGame = rushAtt / rec.games;

  let adj = 0;
  adj += clampNumber(rushYdsPerGame * 10, 0, 420);
  adj += clampNumber(rushTdsPerGame * 520, 0, 420);
  if (rushAttPerGame >= 6) adj += 120;
  if (rushYdsPerGame < 10 && rec.ppg < 19) adj -= 220;
  else if (rushYdsPerGame < 15 && rec.ppg < 18) adj -= 120;
  return clampNumber(adj, -300, 800);
}

function productionAdjustmentValue(rec, position = 'UNK') {
  if (!rec?.games) return 0;
  const ppg = safeNumber(rec.ppg, 0);
  const games = safeNumber(rec.games, 0);
  let baseline = 10;
  let scale = 85;
  if (position === 'QB') { baseline = 17; scale = 115; }
  else if (position === 'RB') { baseline = 10.5; scale = 105; }
  else if (position === 'WR') { baseline = 10; scale = 100; }
  else if (position === 'TE') { baseline = 8; scale = 115; }
  else if (['DL', 'LB', 'DB'].includes(position)) { baseline = 8; scale = 90; }
  const ppgAdj = clampNumber((ppg - baseline) * scale, -650, 850);
  const samplePenalty = games < 5 ? -250 : games < 10 ? -100 : 0;
  return ppgAdj + samplePenalty;
}

function recentAdjustmentValue(rec) {
  if (!rec?.games) return 0;
  const ppg = safeNumber(rec.ppg, 0);
  const last5 = safeNumber(rec.last4Avg, ppg);
  return clampNumber((last5 - ppg) * 65, -350, 350) * state.settings.recentWeight;
}

function dynastyAgeAdjustmentValue(player, league) {
  if (!player || !isDynastyLeague(league)) return 0;
  const age = safeNumber(player.age, 0);
  if (!age) return 0;
  const pos = player.position || 'UNK';
  let adj = 0;
  if (pos === 'QB') adj = age <= 24 ? 520 : age <= 28 ? 360 : age <= 32 ? 150 : age <= 36 ? -250 : -900;
  else if (pos === 'RB') adj = age <= 23 ? 620 : age <= 25 ? 250 : age <= 27 ? -150 : age <= 29 ? -700 : -1400;
  else if (pos === 'WR') adj = age <= 24 ? 500 : age <= 27 ? 250 : age <= 30 ? -100 : -700;
  else if (pos === 'TE') adj = age <= 25 ? 360 : age <= 29 ? 160 : age <= 32 ? -160 : -650;
  else if (['DL', 'LB', 'DB'].includes(pos)) adj = age <= 27 ? 180 : age <= 31 ? 40 : -280;
  return adj * state.settings.ageWeight;
}

function statusAdjustmentValue(player) {
  const status = String(player?.injury_status || player?.status || '').toLowerCase();
  if (!status) return 0;
  if (['ir', 'out', 'pup', 'suspended'].some(s => status.includes(s))) return -1200;
  if (status.includes('doubtful')) return -700;
  if (status.includes('questionable')) return -250;
  if (status.includes('inactive')) return -500;
  return 0;
}

function scarcityAdjustmentValue(league, playerId) {
  return scarcityAdjustment(league, playerId) * 85;
}

function positionPercentileAdjustmentValue(percentile, position = 'UNK') {
  const center = position === 'QB' ? 0.65 : 0.55;
  return clampNumber((percentile - center) * 850, -450, 450);
}

function qbCeilingForAnchor(anchor) {
  for (const row of KTC_STYLE_QB_CEILING_BY_ANCHOR) {
    if (anchor >= row.maxAnchor) return row.ceiling;
  }
  return 4300;
}

function qbValueDetail(league, playerId, player, rec, percentile) {
  const anchor = ktcStyleMarketAnchor(player, playerId);
  const productionAdj = productionAdjustmentValue(rec, 'QB');
  const percentileAdj = positionPercentileAdjustmentValue(percentile, 'QB') * 0.45;
  const recentAdj = recentAdjustmentValue(rec) * 0.45;
  const rushingAdj = qbRushingAdjustment(rec);
  const dynastyAdj = dynastyAgeAdjustmentValue(player, league) * 0.55;
  const statusAdj = statusAdjustmentValue(player);
  const scarcityAdj = scarcityAdjustmentValue(league, playerId) * 0.25;
  const uncapped = anchor + productionAdj + percentileAdj + recentAdj + rushingAdj + dynastyAdj + statusAdj + scarcityAdj;

  // KTC-style guardrail: production can move QBs inside a market tier, but cannot jump multiple dynasty tiers.
  const floor = Math.max(250, anchor - 950);
  const ceiling = Math.min(qbCeilingForAnchor(anchor), anchor + 950);
  const banded = clampNumber(uncapped, floor, ceiling);
  return {
    raw: banded,
    components: {
      marketAnchor: roundNum(anchor, 0),
      productionAdj: roundNum(productionAdj, 0),
      percentileAdj: roundNum(percentileAdj, 0),
      recentAdj: roundNum(recentAdj, 0),
      rushingAdj: roundNum(rushingAdj, 0),
      dynastyAdj: roundNum(dynastyAdj, 0),
      scarcityAdj: roundNum(scarcityAdj, 0),
      statusAdj: roundNum(statusAdj, 0),
      banded: roundNum(banded, 0)
    }
  };
}

function ktcStyleValueDetail(league, playerId, player, rec, percentile) {
  const pos = player?.position || playerPrimaryPosition(playerId) || 'UNK';
  const anchor = ktcStyleMarketAnchor(player, playerId);
  const productionAdj = productionAdjustmentValue(rec, pos);
  const percentileAdj = positionPercentileAdjustmentValue(percentile, pos);
  const recentAdj = recentAdjustmentValue(rec);
  const dynastyAdj = dynastyAgeAdjustmentValue(player, league);
  const statusAdj = statusAdjustmentValue(player);
  const scarcityAdj = scarcityAdjustmentValue(league, playerId);
  const uncapped = anchor + productionAdj + percentileAdj + recentAdj + dynastyAdj + statusAdj + scarcityAdj;
  const floor = Math.max(40, anchor - 1400);
  const ceiling = Math.min(9999, anchor + 1400);
  const banded = clampNumber(uncapped, floor, ceiling);
  return {
    raw: banded,
    components: {
      marketAnchor: roundNum(anchor, 0),
      productionAdj: roundNum(productionAdj, 0),
      percentileAdj: roundNum(percentileAdj, 0),
      recentAdj: roundNum(recentAdj, 0),
      dynastyAdj: roundNum(dynastyAdj, 0),
      scarcityAdj: roundNum(scarcityAdj, 0),
      statusAdj: roundNum(statusAdj, 0),
      banded: roundNum(banded, 0)
    }
  };
}

function positionMultiplier(player, league) {
  const pos = player?.position || 'UNK';
  const superflex = isSuperflexLeague(league);
  if (pos === 'QB') return 1;
  if (pos === 'TE') return isTightEndPremium(league) ? 1.15 : 1;
  if (['DL', 'LB', 'DB'].includes(pos)) return idpSlotCount(league) >= 3 ? 0.92 : 0.72;
  if (pos === 'K' || pos === 'DEF') return 0.35;
  return 1;
}

function playerValue(league, playerId) {
  const key = String(playerId);
  if (league.valueCache.has(key)) return league.valueCache.get(key);
  const player = getPlayer(key);
  const rec = productionRecord(league, key);
  const percentile = positionPercentile(league, key);
  const pos = player?.position || playerPrimaryPosition(key) || 'UNK';

  let raw;
  let valueModel = 'production model';
  let components = null;

  if (pos === 'QB') {
    const qb = qbValueDetail(league, key, player, rec, percentile);
    raw = qb.raw;
    valueModel = 'KTC-style QB tier model';
    components = qb.components;
  } else {
    const ktc = ktcStyleValueDetail(league, key, player, rec, percentile);
    raw = ktc.raw * positionMultiplier(player, league);
    valueModel = 'KTC-style market model';
    components = ktc.components;
  }

  const value = Math.max(1, roundNum(raw, 0));
  const detail = {
    value,
    ppg: roundNum(rec?.ppg || 0, 1),
    last4: roundNum(rec?.last4Avg || 0, 1),
    starts: rec?.starts || 0,
    games: rec?.games || 0,
    percentile: roundNum(percentile * 100, 0),
    age: player?.age || '',
    position: pos,
    status: player?.injury_status || player?.status || '',
    name: playerName(key),
    playerId: key,
    source: rec?.source || 'rank fallback',
    valueModel,
    searchRank: player?.search_rank || '',
    components
  };
  league.valueCache.set(key, detail);
  return detail;
}

function scarcityAdjustment(league, playerId) {
  const pos = playerPrimaryPosition(playerId);
  const pct = positionPercentile(league, playerId);
  if (pos === 'QB' && isSuperflexLeague(league) && pct > 0.75) return 6;
  if (pos === 'TE' && pct > 0.82) return isTightEndPremium(league) ? 13 : 8;
  if (['RB', 'WR'].includes(pos) && pct > 0.9) return 6;
  if (['DL', 'LB', 'DB'].includes(pos) && idpSlotCount(league) >= 3 && pct > 0.9) return 6;
  return 0;
}

function buildTeamStrength(league) {
  league.teamStrength.clear();
  for (const roster of league.rosters || []) {
    const rosterValue = (roster.players || []).reduce((sum, pid) => sum + playerValue(league, pid).value, 0);
    const startersValue = (roster.starters || []).reduce((sum, pid) => sum + playerValue(league, pid).value, 0);
    const wins = safeNumber(roster.settings?.wins);
    const losses = safeNumber(roster.settings?.losses);
    const fpts = totalFpts(roster.settings);
    const maxpf = safeNumber(roster.settings?.ppts) + safeNumber(roster.settings?.ppts_decimal) / 100;
    const score = startersValue * 0.5 + rosterValue * 0.25 + fpts * 0.02 + maxpf * 0.02 + wins * 7 - losses * 3;
    league.teamStrength.set(Number(roster.roster_id), { score, rosterValue, startersValue, wins, losses, fpts, maxpf });
  }
}

function pickValue(league, pick) {
  const currentSeason = currentSeasonNumber(league);
  const season = Number(pick.season || currentSeason + 1);
  const round = Number(pick.round || 1);
  const original = Number(pick.roster_id || pick.originalRosterId || pick.original_roster_id || pick.ownerRosterId || pick.owner_id);
  const base = PICK_BASE_VALUES[round] || Math.max(1, 10 - round);
  const yearsOut = Math.max(1, season - currentSeason);
  const timeFactor = Math.max(0.68, 1 - (yearsOut - 1) * 0.12);
  const strengthRank = teamStrengthRank(league, original);
  let pickFactor = 1;
  if (round === 1) pickFactor = strengthRank <= 0.33 ? 1.25 : strengthRank >= 0.67 ? 0.75 : 1;
  else if (round === 2) pickFactor = strengthRank <= 0.33 ? 1.15 : strengthRank >= 0.67 ? 0.86 : 1;
  else pickFactor = strengthRank <= 0.33 ? 1.08 : strengthRank >= 0.67 ? 0.92 : 1;
  const value = roundNum(base * timeFactor * pickFactor * state.settings.pickWeight, 1);
  return {
    value,
    label: `${season} Round ${round} (${teamName(league, original)} original pick)`,
    detail: `${strengthRank <= 0.33 ? 'projected early' : strengthRank >= 0.67 ? 'projected late' : 'projected mid'} based on roster strength`
  };
}

function teamStrengthRank(league, rosterId) {
  const rows = [...league.teamStrength.entries()].sort((a, b) => a[1].score - b[1].score);
  if (!rows.length) return 0.5;
  const idx = rows.findIndex(([id]) => Number(id) === Number(rosterId));
  if (idx < 0) return 0.5;
  return rows.length === 1 ? 0.5 : idx / (rows.length - 1);
}

function assetValue(league, asset) {
  if (asset.type === 'player') return playerValue(league, asset.playerId);
  if (asset.type === 'pick') return pickValue(league, asset);
  return { value: 0, label: 'Unknown asset' };
}

function sumAssets(league, assets) {
  return assets.reduce((sum, asset) => sum + assetValue(league, asset).value, 0);
}

function slotEligibility(slot, playerId) {
  const s = String(slot).toUpperCase();
  const positions = new Set(playerFantasyPositions(playerId));
  if (positions.has(s)) return true;
  if (FLEX_SLOTS.has(s)) return ['RB', 'WR', 'TE'].some(pos => positions.has(pos));
  if (SUPER_FLEX_SLOTS.has(s)) return ['QB', 'RB', 'WR', 'TE'].some(pos => positions.has(pos));
  if (IDP_FLEX_SLOTS.has(s) || s === 'IDP') return ['DL', 'LB', 'DB', 'IDP'].some(pos => positions.has(pos));
  if (s === 'DEF' && positions.has('DEF')) return true;
  return false;
}

function slotRestrictiveness(slot) {
  const s = String(slot).toUpperCase();
  if (SUPER_FLEX_SLOTS.has(s)) return 10;
  if (FLEX_SLOTS.has(s) || IDP_FLEX_SLOTS.has(s)) return 8;
  if (s === 'BN' || s === 'BE' || s === 'IR' || s === 'TAXI') return 99;
  return 1;
}

function optimalStarterScore(league, playerIds, week) {
  const matchups = league.matchupsByWeek?.[week] || [];
  const pointMap = new Map();
  for (const m of matchups) {
    const pts = m.players_points || m.player_points || {};
    Object.entries(pts).forEach(([pid, val]) => pointMap.set(String(pid), safeNumber(val)));
  }
  const starterSlots = (league.roster_positions || []).filter(slot => !['BN', 'BE', 'IR', 'TAXI'].includes(String(slot).toUpperCase()));
  const slots = [...starterSlots].sort((a, b) => slotRestrictiveness(a) - slotRestrictiveness(b));
  const available = [...new Set(playerIds.map(String))];
  let total = 0;
  const selected = [];

  for (const slot of slots) {
    const candidates = available
      .filter(pid => !selected.includes(pid) && slotEligibility(slot, pid))
      .sort((a, b) => (pointMap.get(b) || 0) - (pointMap.get(a) || 0));
    if (candidates.length) {
      const chosen = candidates[0];
      selected.push(chosen);
      total += pointMap.get(chosen) || 0;
    }
  }
  return { total, selected };
}

function rosterNeedProfile(league, rosterId, overridePlayers = null) {
  const roster = league.rosterMap.get(Number(rosterId));
  const playerIds = overridePlayers || roster?.players || [];
  const slots = league.roster_positions || [];
  const needCounts = { QB: 0, RB: 0, WR: 0, TE: 0, DL: 0, LB: 0, DB: 0, K: 0, DEF: 0 };
  for (const slot of slots) {
    const s = String(slot).toUpperCase();
    if (needCounts[s] !== undefined) needCounts[s] += 1;
    if (FLEX_SLOTS.has(s)) { needCounts.RB += 0.34; needCounts.WR += 0.43; needCounts.TE += 0.23; }
    if (SUPER_FLEX_SLOTS.has(s)) { needCounts.QB += 0.75; needCounts.RB += 0.1; needCounts.WR += 0.1; needCounts.TE += 0.05; }
    if (IDP_FLEX_SLOTS.has(s)) { needCounts.DL += 0.34; needCounts.LB += 0.33; needCounts.DB += 0.33; }
  }

  const activePositions = activeLeaguePositions(league);
  const profile = {};
  for (const pos of POSITION_ORDER) {
    const required = activePositions.has(pos) ? Math.ceil(needCounts[pos] || 0) : 0;
    if (!required) {
      profile[pos] = { required: 0, value: 0, count: 0 };
      continue;
    }
    const values = playerIds
      .filter(pid => playerFantasyPositions(pid).includes(pos))
      .map(pid => playerValue(league, pid).value)
      .sort((a, b) => b - a)
      .slice(0, required);
    const avg = values.length ? values.reduce((s, v) => s + v, 0) / required : 0;
    profile[pos] = { required, value: roundNum(avg, 1), count: values.length };
  }
  return profile;
}

function needScore(league, rosterId, overridePlayers = null) {
  const profile = rosterNeedProfile(league, rosterId, overridePlayers);
  return Object.values(profile).reduce((sum, p) => sum + p.value, 0);
}

function simulateTradePlayers(league, rosterId, gives, receives) {
  const roster = league.rosterMap.get(Number(rosterId));
  const players = new Set((roster?.players || []).map(String));
  gives.filter(a => a.type === 'player').forEach(a => players.delete(String(a.playerId)));
  receives.filter(a => a.type === 'player').forEach(a => players.add(String(a.playerId)));
  return [...players];
}

function evaluateTrade() {
  const league = getSelectedLeague('tradeLeagueSelect');
  if (!league) return;
  const rosterA = Number($('teamASelect').value);
  const rosterB = Number($('teamBSelect').value);
  if (!rosterA || !rosterB || rosterA === rosterB) {
    $('tradeResult').textContent = 'Choose two different teams.';
    return;
  }

  const aGives = state.selectedAssets.A;
  const bGives = state.selectedAssets.B;
  const aRaw = sumAssets(league, aGives);
  const bRaw = sumAssets(league, bGives);
  const aBeforeNeed = needScore(league, rosterA);
  const bBeforeNeed = needScore(league, rosterB);
  const aAfterPlayers = simulateTradePlayers(league, rosterA, aGives, bGives);
  const bAfterPlayers = simulateTradePlayers(league, rosterB, bGives, aGives);
  const aNeedDelta = (needScore(league, rosterA, aAfterPlayers) - aBeforeNeed) * state.settings.needWeight;
  const bNeedDelta = (needScore(league, rosterB, bAfterPlayers) - bBeforeNeed) * state.settings.needWeight;
  const aNet = bRaw - aRaw + aNeedDelta;
  const bNet = aRaw - bRaw + bNeedDelta;
  const spread = bRaw - aRaw;
  const fairBand = Math.max(8, (aRaw + bRaw) * 0.08);

  let verdictClass = 'good';
  let verdict = 'Fair trade range';
  let explanation = 'The raw asset values are close enough that roster fit and personal preference should decide it.';
  if (spread > fairBand) {
    verdictClass = 'bad';
    verdict = `${teamName(league, rosterA)} appears to gain more value`;
    explanation = `Team A receives about ${roundNum(spread)} more raw value than it sends before team-need adjustment.`;
  } else if (spread < -fairBand) {
    verdictClass = 'bad';
    verdict = `${teamName(league, rosterB)} appears to gain more value`;
    explanation = `Team B receives about ${roundNum(Math.abs(spread))} more raw value than it sends before team-need adjustment.`;
  } else if (Math.abs(aNet - bNet) > fairBand) {
    verdictClass = 'warn';
    verdict = 'Raw value is fair, but roster fit is not even';
    explanation = 'The player/pick value is close, but one side fills team needs better than the other.';
  }

  $('tradeResult').classList.remove('empty');
  $('tradeResult').innerHTML = `
    <div class="trade-summary">
      <div class="metric"><span>${roundNum(aRaw)}</span><small>Team A gives</small></div>
      <div class="metric"><span>${roundNum(bRaw)}</span><small>Team B gives</small></div>
      <div class="metric"><span>${roundNum(spread)}</span><small>Raw spread toward Team A</small></div>
    </div>
    <div class="verdict ${verdictClass}">
      <strong>${escapeHtml(verdict)}</strong>
      <p>${escapeHtml(explanation)}</p>
    </div>
    <div class="grid two">
      <div class="result-card">
        <h3>${escapeHtml(teamName(league, rosterA))}</h3>
        <p><strong>Net with needs:</strong> ${roundNum(aNet)}</p>
        <p><strong>Need impact:</strong> ${roundNum(aNeedDelta)}</p>
        ${renderAssetBreakdown(league, bGives, 'Receives')}
        ${renderAssetBreakdown(league, aGives, 'Sends')}
      </div>
      <div class="result-card">
        <h3>${escapeHtml(teamName(league, rosterB))}</h3>
        <p><strong>Net with needs:</strong> ${roundNum(bNet)}</p>
        <p><strong>Need impact:</strong> ${roundNum(bNeedDelta)}</p>
        ${renderAssetBreakdown(league, aGives, 'Receives')}
        ${renderAssetBreakdown(league, bGives, 'Sends')}
      </div>
    </div>
    <div class="result-card">
      <h3>Weak spots before trade</h3>
      <p><strong>${escapeHtml(teamName(league, rosterA))}:</strong> ${escapeHtml(describeWeakPositions(league, rosterA))}</p>
      <p><strong>${escapeHtml(teamName(league, rosterB))}:</strong> ${escapeHtml(describeWeakPositions(league, rosterB))}</p>
    </div>
    ${renderTradePlayerCards(league, aGives, `${teamName(league, rosterA)} sends`)}
    ${renderTradePlayerCards(league, bGives, `${teamName(league, rosterB)} sends`)}
    ${renderTradeModelExplanation(league)}
  `;
}

function renderAssetBreakdown(league, assets, title) {
  const rows = assets.map(asset => {
    const v = assetValue(league, asset);
    const label = asset.type === 'player' ? `${v.name} (${v.position})` : v.label;
    const detail = asset.type === 'player' ? `${v.ppg} PPG, last 5 ${v.last4}, ${v.percentile}th percentile` : v.detail;
    return `<li><strong>${escapeHtml(label)}</strong> — ${roundNum(v.value)} <small>${escapeHtml(detail || '')}</small></li>`;
  }).join('') || '<li>None</li>';
  return `<p><strong>${escapeHtml(title)}</strong></p><ul>${rows}</ul>`;
}

function describeWeakPositions(league, rosterId) {
  const profile = rosterNeedProfile(league, rosterId);
  const leagueProfiles = (league.rosters || []).map(r => rosterNeedProfile(league, r.roster_id));
  const weak = [];
  for (const pos of POSITION_ORDER) {
    const median = medianOf(leagueProfiles.map(p => p[pos]?.value || 0));
    if ((profile[pos]?.value || 0) < median * 0.82 && (profile[pos]?.required || 0) > 0) weak.push(pos);
  }
  return weak.length ? weak.join(', ') : 'No severe positional holes detected';
}

function medianOf(values) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function renderAssetList(side) {
  const league = getSelectedLeague('tradeLeagueSelect');
  const el = side === 'A' ? $('teamAAssets') : $('teamBAssets');
  const assets = state.selectedAssets[side];
  if (!assets.length) {
    el.className = 'asset-list empty';
    el.textContent = 'No assets selected.';
    return;
  }
  el.className = 'asset-list';
  el.innerHTML = assets.map((asset, idx) => {
    const v = league ? assetValue(league, asset) : { value: 0, label: 'Pick', detail: '' };
    const title = asset.type === 'player' ? playerName(asset.playerId) : v.label;
    const sub = asset.type === 'player'
      ? `${playerPrimaryPosition(asset.playerId)} • value ${v.value}`
      : `${v.detail || 'Draft pick'} • value ${v.value}`;
    return `<div class="asset-card"><div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(sub)}</small></div><button class="ghost" data-side="${side}" data-idx="${idx}">Remove</button></div>`;
  }).join('');
  el.querySelectorAll('button[data-side]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.selectedAssets[btn.dataset.side].splice(Number(btn.dataset.idx), 1);
      renderAssetList(btn.dataset.side);
    });
  });
}

function addPlayerAsset(side, inputId) {
  const prefix = side === 'A' ? 'teamA' : 'teamB';
  const selectedValue = $(`${prefix}PlayerSelect`)?.value || '';
  let asset = parseSelectedAssetValue(selectedValue);

  if (!asset) {
    const found = findPlayerFromInput($(inputId).value);
    if (found?.id) asset = { type: 'player', playerId: found.id };
  }

  if (!asset) {
    alert('Asset not found. Choose a player or pick from the dropdown, or type a player name.');
    return;
  }

  const key = assetKey(asset);
  if (!state.selectedAssets[side].some(existing => assetKey(existing) === key)) {
    state.selectedAssets[side].push(asset);
  }
  $(inputId).value = '';
  if ($(`${prefix}PlayerSelect`)) $(`${prefix}PlayerSelect`).value = '';
  renderAssetList(side);
}

function parseSelectedAssetValue(value) {
  const text = String(value || '');
  if (text.startsWith('player:')) return { type: 'player', playerId: text.split(':')[1] };
  if (text.startsWith('pick:')) {
    const [, season, round, originalRosterId] = text.split(':');
    if (season && round && originalRosterId) {
      return { type: 'pick', season: Number(season), round: Number(round), originalRosterId: Number(originalRosterId) };
    }
  }
  if (/^\d+$/.test(text)) return { type: 'player', playerId: text };
  return null;
}

function assetKey(asset) {
  if (!asset) return '';
  if (asset.type === 'player') return `player:${asset.playerId}`;
  if (asset.type === 'pick') return `pick:${asset.season}:${asset.round}:${asset.originalRosterId}`;
  return JSON.stringify(asset);
}


function playerFallbackAvatar(name, position) {
  const initials = String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 220 220"><rect width="220" height="220" fill="#151923"/><circle cx="110" cy="88" r="40" fill="#2a2f3d"/><rect x="42" y="138" width="136" height="70" rx="34" fill="#2a2f3d"/><text x="110" y="91" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="900" fill="#7dd3fc" text-anchor="middle" dominant-baseline="middle">${initials}</text><text x="110" y="184" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="900" fill="#9fb0cc" text-anchor="middle">${position || ''}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function playerHeadshotUrl(playerId) {
  return `https://sleepercdn.com/content/nfl/players/${playerId}.jpg`;
}

function statusTone(status) {
  const text = String(status || '').toLowerCase();
  if (!text || ['active', 'healthy'].some(s => text.includes(s))) return 'good';
  if (['questionable', 'probable'].some(s => text.includes(s))) return 'warn';
  return 'bad';
}

function valueRankByPosition(league, playerId) {
  const pos = playerPrimaryPosition(playerId);
  const rostered = new Set((league.rosters || []).flatMap(r => r.players || []).map(String));
  const rows = [...rostered]
    .map(pid => playerValue(league, pid))
    .filter(v => v.position === pos)
    .sort((a, b) => b.value - a.value);
  const idx = rows.findIndex(v => String(v.playerId) === String(playerId));
  return { rank: idx >= 0 ? idx + 1 : rows.length + 1, total: rows.length || 1, position: pos };
}

function playerCardData(league, playerId) {
  const player = getPlayer(playerId) || {};
  const value = playerValue(league, playerId);
  const rec = displayRecordForPlayer(league, playerId);
  const rank = valueRankByPosition(league, playerId);
  return {
    player,
    value,
    rec,
    rank,
    name: value.name || playerName(playerId),
    position: value.position || playerPrimaryPosition(playerId),
    team: player.team || 'FA',
    age: player.age || '',
    status: value.status || player.injury_status || player.status || 'Active',
    playerId: String(playerId)
  };
}

function displayGamesLabel(rec) {
  return rec?.source === 'league' ? 'Weeks' : 'Games';
}

function displaySampleNote(data, games) {
  if (data.rec?.source === 'league') {
    const startRate = roundNum((data.rec.startRate || 0) * 100, 0);
    return `<div class="player-note"><span>League usage</span><strong>${data.rec.starts || 0}/${games} starts · ${startRate}%</strong></div>`;
  }
  const seasonText = data.rec?.season === 'multi' ? 'past seasons' : (data.rec?.season ? `${data.rec.season}` : 'available history');
  return `<div class="player-note"><span>Stat sample</span><strong>${games} ${displayGamesLabel(data.rec).toLowerCase()} · ${seasonText}</strong></div>`;
}

function recentSeasonRecordsForPlayer(league, playerId, limit = 2) {
  const pid = String(playerId);
  const records = [];
  const current = league.playerStats?.get(pid);
  if (recordHasGames(current)) records.push(current);
  const historical = league.historicalStats?.get(pid)?.seasons || {};
  Object.values(historical).forEach(rec => {
    if (recordHasGames(rec)) records.push(rec);
  });
  const seen = new Set();
  return records
    .filter(rec => {
      const key = `${rec.source || 'x'}-${rec.season || 'league'}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Number(b.season || currentSeasonNumber(league)) - Number(a.season || currentSeasonNumber(league)))
    .slice(0, limit);
}

function trendForPlayer(data) {
  const ppg = safeNumber(data.rec.ppg);
  const last4 = safeNumber(data.rec.last4Avg);
  if (!data.rec.games) return { text: 'No game log available', direction: 'flat' };
  const delta = roundNum(last4 - ppg, 1);
  if (Math.abs(delta) < 0.4) return { text: 'Flat recent form', direction: 'flat' };
  return { text: `${delta > 0 ? '+' : ''}${delta} vs season avg`, direction: delta > 0 ? 'up' : 'down' };
}

function renderTrendDots(data) {
  const weeks = (data.rec.last4 || []).slice(-RECENT_GAME_COUNT);
  const dots = Array.from({ length: RECENT_GAME_COUNT }, (_, i) => i).map(i => `<span class="recent-dot" style="opacity:${weeks[i] ? 0.95 : 0.25}"></span>`).join('');
  const trend = trendForPlayer(data);
  const arrow = trend.direction === 'down' ? '↓' : trend.direction === 'up' ? '↑' : '→';
  return `<div class="recent-strip"><span>L5</span>${dots}<span class="trend-arrow ${trend.direction === 'down' ? 'down' : ''}">${arrow}</span></div>`;
}

function renderPlayerStatCard(league, playerId) {
  const data = playerCardData(league, playerId);
  const fallback = playerFallbackAvatar(data.name, data.position);
  const tone = statusTone(data.status);
  const trend = trendForPlayer(data);
  const ppg = roundNum(data.rec.ppg || data.value.ppg || 0, 1);
  const total = roundNum(data.rec.total || 0, 1);
  const games = safeNumber(data.rec.games || data.value.games || 0);
  const gamesLabel = displayGamesLabel(data.rec);
  const last4 = roundNum(data.rec.last4Avg || data.value.last4 || 0, 1);
  const startRate = roundNum((data.rec.startRate || 0) * 100, 0);
  const rankText = `#${data.rank.rank} ${data.rank.position}`;
  const sourceLabel = data.rec.source === 'historical' ? `${data.rec.season === 'multi' ? 'Past 2 seasons' : data.rec.season}` : `${league.season || ''} league`;
  const matchupLabel = `${data.value.percentile}th pct · ${trend.text}`;
  return `
    <article class="player-card" data-player-card data-player-id="${escapeHtml(data.playerId)}" data-league-id="${escapeHtml(league.league_id)}">
      <div class="player-card-header">
        <img class="player-headshot" src="${playerHeadshotUrl(data.playerId)}" alt="${escapeHtml(data.name)} headshot" onerror="this.onerror=null;this.src='${fallback}';" />
        <div class="player-identity">
          <h3>${escapeHtml(data.name)} <span class="status-dot ${tone === 'good' ? '' : tone}"></span></h3>
          <div class="player-meta-row"><span class="position-pill">${escapeHtml(data.position)}</span><span>${escapeHtml(data.team)} · ${data.age ? `${escapeHtml(data.age)} yrs` : 'age n/a'} · ${games} ${gamesLabel}</span></div>
          <div class="matchup-pill">${escapeHtml(matchupLabel)}</div>
        </div>
        <div class="player-score">
          <strong>${roundNum(data.value.value, 1)}</strong>
          <span>VALUE</span>
          <small>${last4} L5 avg · ${rankText}</small>
          ${renderTrendDots(data)}
        </div>
      </div>

      <div class="card-tabs" role="tablist" aria-label="Player card views">
        <button type="button" class="active" data-player-card-tab="overview">Overview</button>
        <button type="button" data-player-card-tab="gamelog">Game Log</button>
        <button type="button" data-player-card-action="trade">Trade</button>
      </div>

      <div class="player-card-pane active" data-player-card-pane="overview">
        <p class="season-label">${escapeHtml(sourceLabel)} Production</p>

        <div class="stat-tile-grid">
          <div class="stat-tile"><strong class="blue">${ppg}</strong><span>PPG</span></div>
          <div class="stat-tile"><strong>${games}</strong><span>${gamesLabel}</span></div>
          <div class="stat-tile"><strong>${total}</strong><span>Total Pts</span></div>
          <div class="stat-tile"><strong class="green">${roundNum(data.value.value, 1)}</strong><span>Trade Value</span></div>
        </div>

        ${displaySampleNote(data, games)}

        <div class="stat-tile-grid three">
          <div class="stat-tile"><strong>${roundNum(data.rec.high || 0, 1)}</strong><span>High</span></div>
          <div class="stat-tile"><strong>${last4}</strong><span>Last 5</span></div>
          <div class="stat-tile"><strong>${data.value.percentile}</strong><span>Pos Pct</span></div>
          <div class="stat-tile"><strong>${data.rank.rank}/${data.rank.total}</strong><span>Value Rank</span></div>
          <div class="stat-tile"><strong>${escapeHtml(data.status || 'Active')}</strong><span>Status</span></div>
          <div class="stat-tile"><strong>${roundNum(positionMultiplier(data.player, league), 2)}x</strong><span>Format Adj</span></div>
        </div>
      </div>

      <div class="player-card-pane" data-player-card-pane="gamelog">
        <p class="season-label">Game Log</p>
        ${renderPlayerCardGameLog(league, data)}
      </div>
    </article>`;
}

function tradeRecordForSeason(league, playerId, season) {
  const pid = String(playerId);
  const currentSeason = currentSeasonNumber(league);
  if (Number(season) === Number(currentSeason)) {
    return league.playerStats?.get(pid) || league.historicalStats?.get(pid)?.seasons?.[Number(season)] || blankStatRecord(pid, Number(season));
  }
  return league.historicalStats?.get(pid)?.seasons?.[Number(season)] || blankStatRecord(pid, Number(season));
}

function renderTradePlayerCards(league, assets, title) {
  const players = (assets || []).filter(asset => asset.type === 'player');
  if (!players.length) return '';
  return `
    <section class="result-card trade-player-section">
      <h3>${escapeHtml(title)}</h3>
      <div class="trade-player-card-grid">
        ${players.map(asset => renderTradePlayerCard(league, asset.playerId)).join('')}
      </div>
    </section>`;
}

function renderTradePlayerCard(league, playerId) {
  const value = playerValue(league, playerId);
  const player = getPlayer(playerId) || {};
  const name = value.name || playerName(playerId);
  const position = value.position || playerPrimaryPosition(playerId);
  const records = recentSeasonRecordsForPlayer(league, playerId, 2);
  const current = records[0] || blankStatRecord(playerId, currentSeasonNumber(league));
  const previous = records[1] || blankStatRecord(playerId, currentSeasonNumber(league) - 1);
  const fallback = playerFallbackAvatar(name, position);
  const tone = statusTone(value.status || player.injury_status || player.status);
  return `
    <article class="player-card trade-player-card">
      <div class="player-card-header compact-player-header">
        <img class="player-headshot" src="${playerHeadshotUrl(playerId)}" alt="${escapeHtml(name)} headshot" onerror="this.onerror=null;this.src='${fallback}';" />
        <div class="player-identity">
          <h3>${escapeHtml(name)} <span class="status-dot ${tone === 'good' ? '' : tone}"></span></h3>
          <div class="player-meta-row"><span class="position-pill">${escapeHtml(position)}</span><span>${escapeHtml(player.team || 'FA')} · value ${roundNum(value.value, 1)}</span></div>
        </div>
        <div class="player-score compact-score">
          <strong>${roundNum(value.value, 1)}</strong>
          <span>VALUE</span>
        </div>
      </div>

      <div class="trade-season-grid">
        ${renderSeasonSnapshot(`${current.season || league.season || currentSeasonNumber(league)}`, current)}
        ${renderSeasonSnapshot(`${previous.season || currentSeasonNumber(league) - 1}`, previous)}
      </div>

      <details class="season-details">
        <summary>View ${current.season || league.season || currentSeasonNumber(league)} game log</summary>
        ${renderRecordMiniLog(league, current)}
      </details>
      <details class="season-details">
        <summary>View ${previous.season || currentSeasonNumber(league) - 1} game log</summary>
        ${renderRecordMiniLog(league, previous)}
      </details>
    </article>`;
}

function renderSeasonSnapshot(label, rec) {
  const games = safeNumber(rec?.games || 0);
  const ppg = roundNum(rec?.ppg || 0, 1);
  const total = roundNum(rec?.total || 0, 1);
  const last4 = roundNum(rec?.last4Avg || 0, 1);
  const high = roundNum(rec?.high || 0, 1);
  const source = rec?.source === 'historical' ? 'NFL stats' : 'League matchups';
  return `
    <div class="season-snapshot">
      <div class="season-snapshot-title"><span>${escapeHtml(label)}</span><small>${escapeHtml(source)}</small></div>
      <div class="season-stat-row"><span>PPG</span><strong>${ppg}</strong></div>
      <div class="season-stat-row"><span>Total</span><strong>${total}</strong></div>
      <div class="season-stat-row"><span>${displayGamesLabel(rec)}</span><strong>${games}</strong></div>
      <div class="season-stat-row"><span>Last 5 / High</span><strong>${last4} / ${high}</strong></div>
    </div>`;
}

function renderRecordMiniLog(league, rec) {
  const rows = (rec?.weeks || []).slice(-RECENT_GAME_COUNT).reverse();
  if (!rows.length) return '<div class="mini-log"><p class="empty">No game-log rows found for this season.</p></div>';
  return `<div class="mini-log">${rows.map(row => {
    const weekLabel = row.season ? `${row.season} W${row.week}` : `Week ${row.week}`;
    const context = row.rosterId ? `${teamName(league, row.rosterId)}${row.started ? ' · started' : ' · bench'}` : 'NFL game stat line';
    return `<div class="mini-log-row"><strong>${escapeHtml(weekLabel)}</strong><span>${escapeHtml(context)}</span><strong>${roundNum(row.points, 1)}</strong></div>`;
  }).join('')}</div>`;
}

function renderTradeModelExplanation(league) {
  const seasons = league.historyLoadedSeasons?.length ? league.historyLoadedSeasons.join(', ') : 'none available';
  const rules = [];
  if (isSuperflexLeague(league)) rules.push('superflex QB boost');
  if (isTightEndPremium(league)) rules.push('TE premium boost');
  if (idpSlotCount(league)) rules.push(`${idpSlotCount(league)} IDP slots`);
  const formatText = rules.length ? rules.join(', ') : 'standard positional multipliers';
  return `
    <section class="result-card model-explanation">
      <h3>What the trade model used</h3>
      <p>The player values now use a KTC-style dynasty scale: market/tier anchor first, then controlled adjustments for league scoring, production, recent form, positional scarcity, age/status, rushing upside, and roster format.</p>
      <ul>
        <li><strong>Quarterbacks:</strong> QB value starts with an offline KTC-style market/tier anchor. Production, recent form, rushing upside, age, and superflex scarcity can move a QB within a capped band, but efficient PPG alone cannot push a lower-market QB above elite dynasty QBs.</li>
        <li><strong>Current year:</strong> league matchup data for ${escapeHtml(league.season || currentSeasonNumber(league))}, including PPG, total points, start rate, last-five-game trend, and positional percentile.</li>
        <li><strong>Previous years:</strong> best-effort historical stat fetches scored under this league's scoring rules. Loaded seasons: ${escapeHtml(seasons)}.</li>
        <li><strong>League format:</strong> ${escapeHtml(formatText)}.</li>
        <li><strong>Draft picks:</strong> KTC-style round value, years until the pick conveys, and the original owner's projected roster strength to estimate early/mid/late pick value.</li>
        <li><strong>Team needs:</strong> the app simulates each roster before and after the trade using starter slots, flex/superflex rules, and positional depth.</li>
      </ul>
    </section>`;
}

function renderMiniGameLog(league, data) {
  const rows = (data.rec.weeks || []).slice(-RECENT_GAME_COUNT).reverse();
  if (!rows.length) return '<div class="mini-log"><p class="empty">No game-log rows found for this view.</p></div>';
  return `<div class="mini-log">${rows.map(row => {
    const weekLabel = row.season ? `${row.season} W${row.week}` : `Week ${row.week}`;
    const context = row.rosterId ? `${teamName(league, row.rosterId)}${row.started ? ' · started' : ' · bench'}` : 'NFL game stat line';
    return `<div class="mini-log-row"><strong>${escapeHtml(weekLabel)}</strong><span>${escapeHtml(context)}</span><strong>${roundNum(row.points, 1)}</strong></div>`;
  }).join('')}</div>`;
}

function gameLogSeasonRecordsForPlayer(league, playerId) {
  const pid = String(playerId);
  const mode = $('playerStatsSeasonSelect')?.value || 'auto';
  const currentSeason = Number(league.season || currentSeasonNumber(league));
  const leagueRec = league.playerStats?.get(pid);
  const historical = league.historicalStats?.get(pid)?.seasons || {};

  if (mode === 'league') {
    return recordHasGames(leagueRec) ? [leagueRec] : [];
  }

  if (mode !== 'auto') {
    const selected = historical[Number(mode)] || (Number(mode) === currentSeason ? leagueRec : null);
    return recordHasGames(selected) ? [selected] : [];
  }

  const bySeason = new Map();
  Object.values(historical).forEach(rec => {
    if (recordHasGames(rec)) bySeason.set(Number(rec.season), rec);
  });
  if (recordHasGames(leagueRec) && !bySeason.has(currentSeason)) bySeason.set(currentSeason, leagueRec);

  return [...bySeason.values()]
    .sort((a, b) => Number(b.season || currentSeason) - Number(a.season || currentSeason))
    .slice(0, 3);
}

function statLookup(row, keys = []) {
  const stats = row?.stats || {};
  for (const key of keys) {
    if (stats?.[key] !== undefined && stats?.[key] !== null && stats?.[key] !== '') return stats[key];
    if (row?.[key] !== undefined && row?.[key] !== null && row?.[key] !== '') return row[key];
  }
  return null;
}

function percentValue(raw) {
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  return Math.abs(num) <= 1 ? num * 100 : num;
}

function ratioValue(row, numKeys, denKeys) {
  const num = safeNumber(statLookup(row, numKeys), 0);
  const den = safeNumber(statLookup(row, denKeys), 0);
  if (!den) return 0;
  return num / den;
}

function formatGameLogNumber(value, decimals = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return decimals ? roundNum(num, decimals).toFixed(decimals) : String(roundNum(num, 0));
}

function gameLogWeekLabel(row) {
  const postMap = { 1: 'WC', 2: 'DIV', 3: 'CONF', 4: 'SB', 19: 'WC', 20: 'DIV', 21: 'CONF', 22: 'SB' };
  if ((row?.seasonType || 'regular') === 'post') return postMap[Number(row.week)] || `P${row.week}`;
  return String(row?.week || '—');
}

function gameLogOpponent(row) {
  const opp = statLookup(row, ['opp', 'opponent', 'opponent_team', 'opponent_team_abbr', 'opp_abbr']);
  return opp ? String(opp).toUpperCase() : '—';
}

function gameLogSectionsForPosition(position) {
  if (position === 'QB') {
    return [
      { label: 'Fantasy', cols: [
        { label: 'FPTS', type: 'fpts' },
        { label: 'SNP%', type: 'pct', keys: ['off_snp_pct', 'snap_pct', 'off_snap_pct', 'snp_pct'], good: 85, ok: 65 },
        { label: 'RANK', type: 'rank' }
      ]},
      { label: 'Passing', cols: [
        { label: 'ATT', type: 'count', keys: ['pass_att', 'pass_attempts'], good: 34, ok: 24 },
        { label: 'CMP', type: 'count', keys: ['pass_cmp', 'pass_completions'], good: 24, ok: 18 },
        { label: 'YD', type: 'yards', keys: ['pass_yd', 'pass_yards'], good: 275, ok: 210 },
        { label: 'TD', type: 'td', keys: ['pass_td', 'pass_touchdowns'] },
        { label: 'INT', type: 'inverse', keys: ['pass_int', 'interceptions_thrown'], good: 0, ok: 1 }
      ]},
      { label: 'Rushing', cols: [
        { label: 'ATT', type: 'count', keys: ['rush_att', 'rushing_attempts'], good: 6, ok: 3 },
        { label: 'YD', type: 'yards', keys: ['rush_yd', 'rushing_yards'], good: 35, ok: 15 },
        { label: 'YPC', type: 'rate', calc: row => ratioValue(row, ['rush_yd', 'rushing_yards'], ['rush_att', 'rushing_attempts']), good: 5, ok: 3.5, decimals: 2 },
        { label: 'TD', type: 'td', keys: ['rush_td', 'rushing_touchdowns'] }
      ]}
    ];
  }

  if (position === 'K') {
    return [
      { label: 'Fantasy', cols: [
        { label: 'FPTS', type: 'fpts' },
        { label: 'RANK', type: 'rank' }
      ]},
      { label: 'Kicking', cols: [
        { label: 'FGM', type: 'count', keys: ['fgm', 'fg_made'], good: 3, ok: 2 },
        { label: 'FGA', type: 'count', keys: ['fga', 'fg_att'], good: 4, ok: 2 },
        { label: 'XPM', type: 'count', keys: ['xpm', 'xp_made'], good: 3, ok: 1 },
        { label: 'XPA', type: 'count', keys: ['xpa', 'xp_att'], good: 4, ok: 2 }
      ]}
    ];
  }

  if (position === 'DEF') {
    return [
      { label: 'Fantasy', cols: [
        { label: 'FPTS', type: 'fpts' },
        { label: 'RANK', type: 'rank' }
      ]},
      { label: 'Defense', cols: [
        { label: 'SACK', type: 'count', keys: ['sack', 'sacks'], good: 4, ok: 2 },
        { label: 'INT', type: 'count', keys: ['int', 'def_int'], good: 2, ok: 1 },
        { label: 'FR', type: 'count', keys: ['fum_rec', 'fumble_recoveries'], good: 1, ok: 1 },
        { label: 'PA', type: 'inverse', keys: ['pts_allow', 'points_allowed'], good: 10, ok: 20 }
      ]}
    ];
  }

  if (['DL', 'LB', 'DB'].includes(position)) {
    return [
      { label: 'Fantasy', cols: [
        { label: 'FPTS', type: 'fpts' },
        { label: 'SNP%', type: 'pct', keys: ['def_snp_pct', 'snap_pct', 'snp_pct'], good: 85, ok: 65 },
        { label: 'RANK', type: 'rank' }
      ]},
      { label: 'Defense', cols: [
        { label: 'TCK', type: 'count', keys: ['tkl', 'tackles', 'tackles_solo'], good: 8, ok: 5 },
        { label: 'AST', type: 'count', keys: ['ast', 'assists'], good: 3, ok: 1 },
        { label: 'SACK', type: 'count', keys: ['sack', 'sacks'], good: 1, ok: 0.5 },
        { label: 'INT', type: 'count', keys: ['int', 'interceptions'], good: 1, ok: 0.5 },
        { label: 'PD', type: 'count', keys: ['pass_def', 'passes_defended'], good: 2, ok: 1 }
      ]}
    ];
  }

  return [
    { label: 'Fantasy', cols: [
      { label: 'FPTS', type: 'fpts' },
      { label: 'SNP%', type: 'pct', keys: ['off_snp_pct', 'snap_pct', 'off_snap_pct', 'snp_pct'], good: 85, ok: 60 },
      { label: 'RANK', type: 'rank' }
    ]},
    { label: 'Rushing', cols: [
      { label: 'ATT', type: 'count', keys: ['rush_att', 'rushing_attempts'], good: 14, ok: 6 },
      { label: 'YD', type: 'yards', keys: ['rush_yd', 'rushing_yards'], good: 80, ok: 35 },
      { label: 'YPC', type: 'rate', calc: row => ratioValue(row, ['rush_yd', 'rushing_yards'], ['rush_att', 'rushing_attempts']), good: 4.8, ok: 3.7, decimals: 2 },
      { label: 'TD', type: 'td', keys: ['rush_td', 'rushing_touchdowns'] }
    ]},
    { label: 'Receiving', cols: [
      { label: 'TAR', type: 'count', keys: ['rec_tgt', 'targets'], good: 8, ok: 4 },
      { label: 'REC', type: 'count', keys: ['rec', 'receptions'], good: 6, ok: 3 },
      { label: 'YD', type: 'yards', keys: ['rec_yd', 'receiving_yards'], good: 80, ok: 40 },
      { label: 'AVG', type: 'rate', calc: row => ratioValue(row, ['rec_yd', 'receiving_yards'], ['rec', 'receptions']), good: 13, ok: 8, decimals: 1 },
      { label: 'TD', type: 'td', keys: ['rec_td', 'receiving_touchdowns'] }
    ]}
  ];
}

function weekRankForRow(league, playerId, row, position) {
  const season = Number(row?.season || currentSeasonNumber(league));
  const seasonType = row?.seasonType || 'regular';
  const pos = position || playerPrimaryPosition(playerId);
  if (!league.weekRankCache) league.weekRankCache = new Map();
  const cacheKey = `${season}-${seasonType}-${row.week}-${pos}`;
  if (!league.weekRankCache.has(cacheKey)) {
    const scores = [];
    if (season === Number(league.season || currentSeasonNumber(league))) {
      for (const [pid, rec] of league.playerStats || []) {
        if (playerPrimaryPosition(pid) !== pos) continue;
        const found = (rec.weeks || []).find(w => Number(w.week) === Number(row.week) && (w.seasonType || 'regular') === seasonType);
        if (found) scores.push({ pid, points: safeNumber(found.points) });
      }
    }
    for (const [pid, entry] of league.historicalStats || []) {
      if (playerPrimaryPosition(pid) !== pos) continue;
      const rec = entry?.seasons?.[season];
      if (!rec) continue;
      const found = (rec.weeks || []).find(w => Number(w.week) === Number(row.week) && (w.seasonType || 'regular') === seasonType);
      if (found) scores.push({ pid, points: safeNumber(found.points) });
    }
    scores.sort((a, b) => b.points - a.points);
    league.weekRankCache.set(cacheKey, new Map(scores.map((entry, index) => [String(entry.pid), index + 1])));
  }
  return league.weekRankCache.get(cacheKey)?.get(String(playerId)) || null;
}

function gameLogMetricValue(league, playerId, row, col, position) {
  if (col.type === 'fpts') return safeNumber(row.points, 0);
  if (col.type === 'rank') return weekRankForRow(league, playerId, row, position);
  if (col.type === 'pct') return percentValue(statLookup(row, col.keys || []));
  if (typeof col.calc === 'function') return col.calc(row, league, playerId, position);
  return statLookup(row, col.keys || []);
}

function gameLogMetricText(league, playerId, row, col, position) {
  const value = gameLogMetricValue(league, playerId, row, col, position);
  if (value === null || value === undefined || value === '') return '—';
  if (col.type === 'fpts') return roundNum(value, 2).toFixed(2);
  if (col.type === 'pct') return formatGameLogNumber(value, 0);
  if (col.type === 'rate') return formatGameLogNumber(value, col.decimals ?? 2);
  if (col.type === 'rank') return value ? String(value) : '—';
  if (Math.abs(Number(value) - Math.round(Number(value))) > 0.001) return formatGameLogNumber(value, col.decimals ?? 1);
  return formatGameLogNumber(value, 0);
}

function gameLogToneClass(league, playerId, row, col, position) {
  const value = Number(gameLogMetricValue(league, playerId, row, col, position));
  if (!Number.isFinite(value)) return 'tone-neutral';
  const pos = position || playerPrimaryPosition(playerId);
  let good = col.good;
  let ok = col.ok;
  if (col.type === 'fpts') {
    if (pos === 'QB') { good = 22; ok = 15; }
    else if (pos === 'TE') { good = 14; ok = 8; }
    else if (pos === 'K' || pos === 'DEF') { good = 12; ok = 7; }
    else if (['DL', 'LB', 'DB'].includes(pos)) { good = 15; ok = 8; }
    else { good = 18; ok = 10; }
  }
  if (col.type === 'rank') {
    if (value <= 12) return 'tone-good';
    if (value <= 24) return 'tone-ok';
    return 'tone-bad';
  }
  if (col.type === 'inverse') {
    if (value <= good) return 'tone-good';
    if (value <= ok) return 'tone-ok';
    return 'tone-bad';
  }
  if (col.type === 'td') {
    if (value >= 1) return 'tone-good';
    return 'tone-bad';
  }
  if (!Number.isFinite(good) || !Number.isFinite(ok)) return value > 0 ? 'tone-ok' : 'tone-neutral';
  if (value >= good) return 'tone-good';
  if (value >= ok) return 'tone-ok';
  return value > 0 ? 'tone-bad' : 'tone-neutral';
}

function renderFallbackGameLogTable(league, rows, label) {
  const ordered = rows.slice().sort((a, b) => Number(a.week) - Number(b.week));
  return `
    <div class="sleeper-log-section">
      <div class="sleeper-log-subtitle">${escapeHtml(label)}</div>
      <div class="sleeper-log-scroll">
        <table class="sleeper-log-table compact-fallback">
          <thead>
            <tr><th>WK</th><th>TEAM</th><th>FPTS</th><th>USED</th></tr>
          </thead>
          <tbody>
            ${ordered.map(row => `<tr>
              <td class="wk-cell">${escapeHtml(gameLogWeekLabel(row))}</td>
              <td>${escapeHtml(row.rosterId ? teamName(league, row.rosterId) : 'NFL')}</td>
              <td class="log-cell ${gameLogToneClass(league, '', row, { type: 'fpts' }, '')}">${roundNum(row.points, 2).toFixed(2)}</td>
              <td>${row.started ? 'Start' : 'Bench'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function renderDetailedGameLogTable(league, playerId, rows, label, position) {
  const sections = gameLogSectionsForPosition(position);
  const ordered = rows.slice().sort((a, b) => Number(a.week) - Number(b.week));
  const secondHeader = sections.flatMap(section => section.cols.map(col => `<th>${escapeHtml(col.label)}</th>`)).join('');
  return `
    <div class="sleeper-log-section">
      <div class="sleeper-log-subtitle">${escapeHtml(label)}</div>
      <div class="sleeper-log-scroll">
        <table class="sleeper-log-table">
          <thead>
            <tr>
              <th rowspan="2">WK</th>
              <th rowspan="2">OPP</th>
              ${sections.map(section => `<th colspan="${section.cols.length}">${escapeHtml(section.label)}</th>`).join('')}
            </tr>
            <tr>${secondHeader}</tr>
          </thead>
          <tbody>
            ${ordered.map(row => `<tr>
              <td class="wk-cell">${escapeHtml(gameLogWeekLabel(row))}</td>
              <td class="opp-cell">${escapeHtml(gameLogOpponent(row))}</td>
              ${sections.flatMap(section => section.cols.map(col => {
                const text = gameLogMetricText(league, playerId, row, col, position);
                const tone = gameLogToneClass(league, playerId, row, col, position);
                return `<td class="log-cell ${tone}">${escapeHtml(text)}</td>`;
              })).join('')}
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function renderGameLogSeasonBlock(league, playerId, rec, position) {
  const rows = rec?.weeks || [];
  const regular = rows.filter(row => (row.seasonType || 'regular') !== 'post');
  const post = rows.filter(row => (row.seasonType || 'regular') === 'post');
  if (!rows.length) return '';
  const detailed = rows.some(row => row.stats && Object.keys(row.stats || {}).length);
  return `
    <section class="sleeper-season-block">
      <h4>${escapeHtml(String(rec.season || currentSeasonNumber(league)))}</h4>
      ${post.length ? (detailed ? renderDetailedGameLogTable(league, playerId, post, 'Playoffs', position) : renderFallbackGameLogTable(league, post, 'Playoffs')) : ''}
      ${regular.length ? (detailed ? renderDetailedGameLogTable(league, playerId, regular, 'Regular Season', position) : renderFallbackGameLogTable(league, regular, 'Regular Season')) : ''}
    </section>`;
}

function renderPlayerCardGameLog(league, data) {
  const seasonRecords = gameLogSeasonRecordsForPlayer(league, data?.playerId);
  if (!seasonRecords.length) return '<div class="mini-log"><p class="empty">No game-log rows found for this player.</p></div>';
  const position = data?.position || playerPrimaryPosition(data?.playerId);
  return `<div class="sleeper-game-log full-game-log">${seasonRecords.map(rec => renderGameLogSeasonBlock(league, data.playerId, rec, position)).join('')}</div>`;
}

function compareMetric(label, aValue, bValue, formatter = v => roundNum(v, 1)) {
  const a = safeNumber(aValue);
  const b = safeNumber(bValue);
  const max = Math.max(1, Math.abs(a), Math.abs(b));
  const aPct = Math.max(6, Math.min(100, (Math.abs(a) / max) * 100));
  const bPct = Math.max(6, Math.min(100, (Math.abs(b) / max) * 100));
  return `
    <div class="compare-row">
      <div class="compare-label">${escapeHtml(label)}</div>
      <div class="compare-meter"><div class="compare-fill" style="width:${aPct}%">${escapeHtml(formatter(a))}</div></div>
      <div class="compare-meter"><div class="compare-fill alt" style="width:${bPct}%">${escapeHtml(formatter(b))}</div></div>
    </div>`;
}

function renderComparisonPanel(league, playerAId, playerBId) {
  if (!playerAId || !playerBId) return '';
  const a = playerCardData(league, playerAId);
  const b = playerCardData(league, playerBId);
  const diff = roundNum(a.value.value - b.value.value, 1);
  const fairBand = Math.max(4, ((a.value.value + b.value.value) / 2) * 0.08);
  let verdict = `${a.name} and ${b.name} are in the same trade-value tier.`;
  let detail = `The model sees a ${Math.abs(diff)} point value gap, which is inside the normal negotiation band.`;
  if (diff > fairBand) {
    verdict = `${a.name} has the stronger modeled value.`;
    detail = `${a.name} is ahead by about ${diff} value points before team-need adjustments.`;
  } else if (diff < -fairBand) {
    verdict = `${b.name} has the stronger modeled value.`;
    detail = `${b.name} is ahead by about ${Math.abs(diff)} value points before team-need adjustments.`;
  }
  return `
    <section class="compare-panel">
      <h3>Head-to-head comparison</h3>
      <div class="compare-verdict"><strong>${escapeHtml(verdict)}</strong><p>${escapeHtml(detail)}</p></div>
      <div class="compare-row"><div></div><strong>${escapeHtml(a.name)}</strong><strong>${escapeHtml(b.name)}</strong></div>
      <div class="compare-bars">
        ${compareMetric('Trade value', a.value.value, b.value.value)}
        ${compareMetric('PPG', a.rec.ppg, b.rec.ppg)}
        ${compareMetric('Last 5 avg', a.rec.last4Avg, b.rec.last4Avg)}
        ${compareMetric('Total pts', a.rec.total, b.rec.total)}
        ${compareMetric('Ceiling', a.rec.high, b.rec.high)}
        ${compareMetric('Start rate', (a.rec.startRate || 0) * 100, (b.rec.startRate || 0) * 100, v => `${roundNum(v, 0)}%`)}
        ${compareMetric('Pos percentile', a.value.percentile, b.value.percentile, v => `${roundNum(v, 0)}th`)}
      </div>
    </section>`;
}

function setPlayerCompareInput(target, playerId) {
  const player = state.playerSearch.find(p => String(p.id) === String(playerId));
  if (!player) return;
  $(target === 'B' ? 'playerCompareB' : 'playerCompareA').value = player.label;
  renderPlayerComparison();
}

function selectedCompareIds() {
  return {
    A: findPlayerFromInput($('playerCompareA')?.value || '')?.id || '',
    B: findPlayerFromInput($('playerCompareB')?.value || '')?.id || ''
  };
}

function togglePlayerValueSelection(playerId) {
  const player = state.playerSearch.find(p => String(p.id) === String(playerId));
  if (!player) return;
  const selected = selectedCompareIds();

  if (String(selected.A) === String(playerId)) {
    $('playerCompareA').value = '';
  } else if (String(selected.B) === String(playerId)) {
    $('playerCompareB').value = '';
  } else if (!selected.A) {
    $('playerCompareA').value = player.label;
  } else if (!selected.B) {
    $('playerCompareB').value = player.label;
  } else {
    return;
  }

  renderPlayerComparison();
  renderPlayerValues();
}

function renderPlayerComparison() {
  const league = getSelectedLeague('playerLeagueSelect');
  const el = $('playerCompareOutput');
  if (!el) return;
  if (!league) {
    el.innerHTML = '<section class="panel"><p class="empty">Load a league first.</p></section>';
    return;
  }
  const a = findPlayerFromInput($('playerCompareA').value);
  const b = findPlayerFromInput($('playerCompareB').value);
  const ids = [a?.id, b?.id].filter(Boolean);
  if (!ids.length) {
    el.innerHTML = '<section class="panel"><p class="empty">Search for one or two players, then build the player cards. You can also click a row in the player value table.</p></section>';
    return;
  }
  const cards = ids.map(pid => renderPlayerStatCard(league, pid)).join('');
  el.innerHTML = `<div class="player-card-grid">${cards}</div>${renderComparisonPanel(league, a?.id, b?.id)}`;
}

function renderTables() {
  renderStandings();
  renderStrength();
  renderLeagueRules();
  renderPlayerValues();
  renderPlayerComparison();
}

function renderLeagueRules() {
  const league = getSelectedLeague('rulesLeagueSelect') || getSelectedLeague('dashboardLeagueSelect');
  const el = $('leagueRulesPanel');
  if (!el) return;
  if (!league) {
    el.className = 'rules-panel empty';
    el.textContent = 'Load a league to view scoring and format rules.';
    return;
  }
  const scoring = league.scoring_settings || {};
  const formatRows = [
    ['Teams', league.total_rosters || league.rosters?.length || '—'],
    ['Season', league.season || '—'],
    ['Roster slots', (league.roster_positions || []).join(', ') || '—'],
    ['Superflex', isSuperflexLeague(league) ? 'Yes' : 'No'],
    ['TE premium', isTightEndPremium(league) ? 'Yes' : 'No'],
    ['IDP slots', idpSlotCount(league)],
    ['Playoff start', league.settings?.playoff_week_start ? `Week ${league.settings.playoff_week_start}` : '—'],
    ['Trade deadline', league.settings?.trade_deadline ? `Week ${league.settings.trade_deadline}` : '—'],
    ['Waiver type', readableWaiverType(league.settings?.waiver_type)],
    ['FAAB budget', league.settings?.waiver_budget ?? '—']
  ];
  const scoringRows = Object.entries(scoring)
    .filter(([, value]) => Number(value) !== 0)
    .sort(([a], [b]) => scoringGroupOrder(a) - scoringGroupOrder(b) || a.localeCompare(b));

  el.className = 'rules-panel';
  el.innerHTML = `
    <div class="rules-chip-grid">${formatRows.map(([label, value]) => `<div class="rules-chip"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</div>
    <h4>Scoring</h4>
    <div class="scoring-grid">${scoringRows.map(([key, value]) => `<div class="scoring-row"><span>${escapeHtml(scoringLabel(key))}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(key)}</small></div>`).join('') || '<p class="empty">No scoring settings returned.</p>'}</div>
  `;
}

function readableWaiverType(type) {
  const value = Number(type);
  if (value === 0) return 'Rolling waivers';
  if (value === 1) return 'FAAB';
  if (value === 2) return 'Reverse standings';
  return type ?? '—';
}

function scoringGroupOrder(key) {
  if (key.startsWith('pass')) return 1;
  if (key.startsWith('rush')) return 2;
  if (key.startsWith('rec') || key.includes('_rec')) return 3;
  if (key.startsWith('bonus')) return 4;
  if (key.startsWith('fg') || key.startsWith('xp')) return 5;
  if (key.includes('def') || key.includes('sack') || key.includes('int') || key.includes('fum')) return 6;
  return 9;
}

function scoringLabel(key) {
  const labels = {
    pass_yd: 'Passing yards', pass_td: 'Passing TD', pass_int: 'Interception thrown', pass_2pt: 'Passing 2PT',
    rush_yd: 'Rushing yards', rush_td: 'Rushing TD', rush_2pt: 'Rushing 2PT',
    rec: 'Reception', rec_yd: 'Receiving yards', rec_td: 'Receiving TD', rec_2pt: 'Receiving 2PT', bonus_rec_te: 'TE reception bonus',
    fum: 'Fumble', fum_lost: 'Fumble lost', sack: 'Sack', int: 'Interception',
    fgm: 'Field goal', fgm_0_19: 'FG 0-19', fgm_20_29: 'FG 20-29', fgm_30_39: 'FG 30-39', fgm_40_49: 'FG 40-49', fgm_50p: 'FG 50+', xpm: 'Extra point made'
  };
  return labels[key] || key.replaceAll('_', ' ').replace(/\b\w/g, ch => ch.toUpperCase());
}

function renderStandings() {
  const league = getSelectedLeague('dashboardLeagueSelect');
  const el = $('standingsTable');
  if (!league) { el.innerHTML = '<p class="empty">Load a league first.</p>'; return; }
  const rows = [...league.rosters].sort((a, b) => {
    const aw = safeNumber(a.settings?.wins), bw = safeNumber(b.settings?.wins);
    if (bw !== aw) return bw - aw;
    return totalFpts(b.settings) - totalFpts(a.settings);
  });
  el.innerHTML = `<table><thead><tr><th>Team</th><th>Record</th><th>PF</th><th>PA</th><th>Moves</th></tr></thead><tbody>${rows.map(r => `
    <tr><td>${escapeHtml(teamName(league, r.roster_id))}<small>Roster ${r.roster_id}</small></td><td>${safeNumber(r.settings?.wins)}-${safeNumber(r.settings?.losses)}-${safeNumber(r.settings?.ties)}</td><td>${roundNum(totalFpts(r.settings))}</td><td>${roundNum(totalAgainst(r.settings))}</td><td>${safeNumber(r.settings?.total_moves)}</td></tr>`).join('')}</tbody></table>`;
}

function renderStrength() {
  const league = getSelectedLeague('dashboardLeagueSelect');
  const el = $('strengthTable');
  if (!league) { el.innerHTML = '<p class="empty">Load a league first.</p>'; return; }
  const rows = [...league.teamStrength.entries()].sort((a, b) => b[1].score - a[1].score);
  el.innerHTML = `<table><thead><tr><th>Team</th><th>Total value</th><th>Starter value</th><th>Potential PF</th><th>Pick outlook</th></tr></thead><tbody>${rows.map(([rid, s]) => `
    <tr><td>${escapeHtml(teamName(league, rid))}</td><td>${roundNum(s.rosterValue)}</td><td>${roundNum(s.startersValue)}</td><td>${roundNum(s.maxpf)}</td><td>${teamStrengthRank(league, rid) <= 0.33 ? '<span class="badge good">early picks</span>' : teamStrengthRank(league, rid) >= 0.67 ? '<span class="badge bad">late picks</span>' : '<span class="badge warn">mid picks</span>'}</td></tr>`).join('')}</tbody></table>`;
}

function renderPlayerValues() {
  const league = getSelectedLeague('playerLeagueSelect');
  const el = $('playerValuesTable');
  if (!league) { el.innerHTML = '<p class="empty">Load a league first.</p>'; return; }
  const query = String($('playerValueSearch').value || '').toLowerCase().trim();
  const posFilter = $('playerPositionFilter').value;
  const rostered = new Set((league.rosters || []).flatMap(r => r.players || []).map(String));
  const rows = [...rostered]
    .map(pid => playerValue(league, pid))
    .filter(v => posFilter === 'ALL' || v.position === posFilter)
    .filter(v => !query || `${v.name} ${v.position} ${getPlayer(v.playerId)?.team || ''}`.toLowerCase().includes(query))
    .sort((a, b) => b.value - a.value)
    .slice(0, 250);
  const selected = selectedCompareIds();
  el.innerHTML = `<table><thead><tr><th>Player</th><th>Pos</th><th>Value</th><th>PPG</th><th>Last 5</th><th>Games</th><th>Model</th><th>Status</th></tr></thead><tbody>${rows.map(v => {
    const isA = String(selected.A) === String(v.playerId);
    const isB = String(selected.B) === String(v.playerId);
    const selectedClass = isA ? ' selected-a' : isB ? ' selected-b' : '';
    const selectionText = isA ? 'Selected 1 · click to remove' : isB ? 'Selected 2 · click to remove' : selected.A && selected.B ? '2 selected · click selected row to change' : 'click to select';
    const selectionBadge = isA ? '<span class="selection-badge first">1</span>' : isB ? '<span class="selection-badge second">2</span>' : '';
    return `<tr class="player-row-clickable${selectedClass}" data-player-id="${escapeHtml(v.playerId)}"><td><div class="player-table-name-row">${selectionBadge}<span>${escapeHtml(v.name)}</span></div><small>${escapeHtml(getPlayer(v.playerId)?.team || 'FA')} · ${escapeHtml(selectionText)}</small></td><td>${escapeHtml(v.position)}</td><td><strong>${roundNum(v.value)}</strong></td><td>${v.ppg}</td><td>${v.last4}</td><td>${v.games}</td><td>${escapeHtml(v.valueModel || v.source || '')}</td><td>${escapeHtml(v.status || '')}</td></tr>`;
  }).join('')}</tbody></table>`;
  el.querySelectorAll('tr[data-player-id]').forEach(row => {
    row.addEventListener('click', () => togglePlayerValueSelection(row.dataset.playerId));
  });
}

function renderLeagueList() {
  const el = $('loadedLeagues');
  if (!state.leagues.length) {
    el.className = 'league-list empty';
    el.textContent = state.savedLeagueIds.length ? `Loading ${state.savedLeagueIds.length} saved league${state.savedLeagueIds.length === 1 ? '' : 's'}…` : 'No leagues loaded.';
    return;
  }
  const selected = localStorage.getItem(STORAGE_KEYS.selectedLeague) || state.leagues[0]?.league_id;
  el.className = 'league-list';
  el.innerHTML = state.leagues.map(league => `<button class="league-card league-card-button ${String(league.league_id) === String(selected) ? 'active' : ''}" data-league-id="${escapeHtml(league.league_id)}"><strong>${escapeHtml(league.name || league.league_id)}</strong><small>${league.season} • ${league.total_rosters} teams • ${Object.keys(league.matchupsByWeek || {}).length} weeks • ${league.historyLoadedSeasons?.length ? `stats ${league.historyLoadedSeasons.join(', ')}` : 'league data only'}</small></button>`).join('');
  el.querySelectorAll('[data-league-id]').forEach(card => card.addEventListener('click', () => selectLeagueAcrossApp(card.dataset.leagueId)));
}

function fillLeagueSelects() {
  const selects = ['dashboardLeagueSelect', 'tradeLeagueSelect', 'recapLeagueSelect', 'playerLeagueSelect', 'rulesLeagueSelect'];
  const stored = localStorage.getItem(STORAGE_KEYS.selectedLeague);
  for (const id of selects) {
    const el = $(id);
    if (!el) continue;
    const previous = el.value || stored;
    el.innerHTML = state.leagues.map(l => `<option value="${l.league_id}">${escapeHtml(l.name || l.league_id)}</option>`).join('');
    if (previous && state.leagues.some(l => String(l.league_id) === String(previous))) el.value = previous;
  }
  fillTeamSelects();
  fillPickSelects();
  fillRecapWeeks();
  fillPlayerSeasonSelect();
}

function fillTeamSelects() {
  const league = getSelectedLeague('tradeLeagueSelect');
  for (const id of ['teamASelect', 'teamBSelect']) {
    const el = $(id);
    const previous = el.value;
    el.innerHTML = league ? league.rosters.map(r => `<option value="${r.roster_id}">${escapeHtml(teamName(league, r.roster_id))}</option>`).join('') : '';
    if (previous && [...el.options].some(o => o.value === previous)) el.value = previous;
  }
  const teamB = $('teamBSelect');
  if (teamB.options.length > 1 && $('teamASelect').value === teamB.value) teamB.selectedIndex = 1;
  fillTeamPlayerSelects();
}

function fillTeamPlayerSelects() {
  const league = getSelectedLeague('tradeLeagueSelect');
  if (!league) {
    ['teamAPlayerSelect', 'teamBPlayerSelect'].forEach(id => { if ($(id)) $(id).innerHTML = '<option value="">Load a league first</option>'; });
    renderTeamNeedNotes();
    return;
  }
  const pairs = [
    { rosterSelect: 'teamASelect', playerSelect: 'teamAPlayerSelect' },
    { rosterSelect: 'teamBSelect', playerSelect: 'teamBPlayerSelect' }
  ];
  for (const pair of pairs) {
    const roster = league.rosterMap.get(Number($(pair.rosterSelect).value));
    const players = (roster?.players || [])
      .map(pid => ({ pid: String(pid), value: playerValue(league, pid), player: getPlayer(pid) || {} }))
      .sort((a, b) => b.value.value - a.value.value);
    const picks = ownedPicksForRoster(league, Number(roster?.roster_id || 0));
    const playerOptions = players.map(row => `<option value="player:${escapeHtml(row.pid)}">${escapeHtml(row.value.name)} — ${escapeHtml(row.value.position)} · ${roundNum(row.value.value)} value · ${row.value.ppg} PPG</option>`).join('');
    const pickOptions = picks.map(pick => {
      const value = pickValue(league, pick);
      return `<option value="pick:${pick.season}:${pick.round}:${pick.originalRosterId}">${escapeHtml(value.label)} · ${roundNum(value.value)} value · ${escapeHtml(value.detail)}</option>`;
    }).join('');
    $(pair.playerSelect).innerHTML = `
      <option value="">Choose asset from ${escapeHtml(teamName(league, roster?.roster_id || 0))}</option>
      <optgroup label="Players">${playerOptions}</optgroup>
      <optgroup label="Draft picks">${pickOptions || '<option value="" disabled>No picks found</option>'}</optgroup>
    `;
  }
  renderTeamNeedNotes();
}

function ownedPicksForRoster(league, ownerRosterId) {
  if (!league || !ownerRosterId) return [];
  const baseSeason = currentSeasonNumber(league);
  const seasons = [baseSeason + 1, baseSeason + 2, baseSeason + 3];
  const rounds = Array.from({ length: Math.max(1, Math.min(10, safeNumber(league.settings?.draft_rounds, 5))) }, (_, i) => i + 1);
  const picks = [];
  for (const season of seasons) {
    for (const roster of league.rosters || []) {
      for (const round of rounds) {
        picks.push({
          type: 'pick',
          season,
          round,
          originalRosterId: Number(roster.roster_id),
          currentOwnerId: Number(roster.roster_id)
        });
      }
    }
  }

  for (const traded of league.tradedPicks || []) {
    const season = Number(traded.season);
    const round = Number(traded.round);
    const originalRosterId = Number(traded.roster_id || traded.original_roster_id || traded.originalRosterId);
    const currentOwnerId = Number(traded.owner_id || traded.new_owner_id || traded.ownerRosterId || traded.owner_roster_id);
    if (!season || !round || !originalRosterId || !currentOwnerId) continue;
    const row = picks.find(pick => Number(pick.season) === season && Number(pick.round) === round && Number(pick.originalRosterId) === originalRosterId);
    if (row) row.currentOwnerId = currentOwnerId;
  }

  return picks
    .filter(pick => Number(pick.currentOwnerId) === Number(ownerRosterId))
    .sort((a, b) => Number(a.season) - Number(b.season) || Number(a.round) - Number(b.round) || Number(a.originalRosterId) - Number(b.originalRosterId));
}

function renderTeamNeedNotes() {
  const league = getSelectedLeague('tradeLeagueSelect');
  const notes = [
    { select: 'teamASelect', target: 'teamANeedsNote' },
    { select: 'teamBSelect', target: 'teamBNeedsNote' }
  ];
  for (const note of notes) {
    const el = $(note.target);
    if (!el) continue;
    const rosterId = Number($(note.select)?.value);
    el.textContent = league && rosterId ? rosterNeedsSummary(league, rosterId) : 'Load a league to see roster needs.';
  }
}

function rosterNeedsSummary(league, rosterId) {
  const profile = rosterNeedProfile(league, rosterId);
  const leagueProfiles = (league.rosters || []).map(r => rosterNeedProfile(league, r.roster_id));
  const weak = [];
  const shallow = [];
  const strong = [];

  for (const pos of POSITION_ORDER) {
    const required = profile[pos]?.required || 0;
    if (!required) continue;
    const median = medianOf(leagueProfiles.map(p => p[pos]?.value || 0));
    const current = profile[pos]?.value || 0;
    const count = profile[pos]?.count || 0;
    if (count < required) shallow.push(pos);
    if (median && current < median * 0.88) weak.push(pos);
    if (median && current > median * 1.18) strong.push(pos);
  }

  const formatNotes = [];
  const flexCount = (league.roster_positions || []).filter(slot => FLEX_SLOTS.has(String(slot).toUpperCase())).length;
  if (isSuperflexLeague(league)) formatNotes.push('QB value is elevated by superflex.');
  if (isTightEndPremium(league)) formatNotes.push('TEs get premium scoring.');
  if (flexCount) formatNotes.push(`${flexCount} flex slot${flexCount === 1 ? '' : 's'} push RB/WR/TE depth.`);
  if (idpSlotCount(league)) formatNotes.push(`${idpSlotCount(league)} IDP slot${idpSlotCount(league) === 1 ? '' : 's'} matter.`);

  const needText = [...new Set([...shallow, ...weak])].slice(0, 4);
  const strongText = [...new Set(strong)].slice(0, 3);
  const leading = needText.length ? `Needs: ${needText.join(', ')}.` : 'No major roster holes detected.';
  const cushion = strongText.length ? ` Strength: ${strongText.join(', ')}.` : '';
  return `${leading}${cushion} ${formatNotes.join(' ')}`.trim();
}

function fillPlayerSeasonSelect() {
  const league = getSelectedLeague('playerLeagueSelect');
  const el = $('playerStatsSeasonSelect');
  if (!el) return;
  const previous = el.value;
  const seasons = league?.historyLoadedSeasons?.length ? league.historyLoadedSeasons : historicalSeasonsToLoad(league || {});
  el.innerHTML = `<option value="auto">Best available</option><option value="league">League matchup data</option>` + seasons.map(season => `<option value="${season}">${season} NFL stats</option>`).join('');
  if ([...el.options].some(o => o.value === previous)) el.value = previous;
}

function selectLeagueAcrossApp(leagueId) {
  if (!leagueId) return;
  localStorage.setItem(STORAGE_KEYS.selectedLeague, leagueId);
  ['dashboardLeagueSelect', 'tradeLeagueSelect', 'recapLeagueSelect', 'playerLeagueSelect', 'rulesLeagueSelect'].forEach(id => {
    const el = $(id);
    if (el && [...el.options].some(o => String(o.value) === String(leagueId))) el.value = leagueId;
  });
  fillTeamSelects();
  fillPickSelects();
  fillRecapWeeks();
  fillPlayerSeasonSelect();
  renderEverything();
}


function activateTab(tabId) {
  document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === tabId));
  document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === tabId));
}

function ownerRosterForPlayer(league, playerId) {
  const pid = String(playerId);
  return (league?.rosters || []).find(roster => (roster.players || []).map(String).includes(pid)) || null;
}

function sendPlayerToTrade(playerId, leagueId) {
  const league = state.leagues.find(l => String(l.league_id) === String(leagueId)) || getSelectedLeague('playerLeagueSelect') || getSelectedLeague('tradeLeagueSelect');
  if (!league) {
    alert('Load a league before adding a player to a trade.');
    return;
  }

  const currentTradeLeague = $('tradeLeagueSelect')?.value;
  if (currentTradeLeague && String(currentTradeLeague) !== String(league.league_id)) {
    state.selectedAssets = { A: [], B: [] };
  }
  selectLeagueAcrossApp(league.league_id);

  const roster = ownerRosterForPlayer(league, playerId);
  if (roster && $('teamASelect')) {
    $('teamASelect').value = String(roster.roster_id);
    if ($('teamBSelect')?.value === String(roster.roster_id) && $('teamBSelect').options.length > 1) {
      $('teamBSelect').selectedIndex = [...$('teamBSelect').options].findIndex(option => option.value !== String(roster.roster_id));
    }
    fillTeamPlayerSelects();
  }

  const asset = { type: 'player', playerId: String(playerId) };
  const key = assetKey(asset);
  if (!state.selectedAssets.A.some(existing => assetKey(existing) === key)) {
    state.selectedAssets.A.push(asset);
  }
  if ($('teamAPlayerSelect') && [...$('teamAPlayerSelect').options].some(option => option.value === `player:${playerId}`)) {
    $('teamAPlayerSelect').value = `player:${playerId}`;
  }
  if ($('teamAPlayerSearch')) $('teamAPlayerSearch').value = '';
  renderAssetList('A');
  renderAssetList('B');

  const result = $('tradeResult');
  if (result) {
    result.className = 'trade-result empty';
    result.textContent = `${playerName(playerId)} was added to Team A. Select the other side of the deal, then evaluate.`;
  }
  activateTab('trade');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function wirePlayerCardActions() {
  document.addEventListener('click', event => {
    const tabButton = event.target.closest('[data-player-card-tab]');
    if (tabButton) {
      const card = tabButton.closest('[data-player-card]');
      if (!card) return;
      const targetPane = tabButton.dataset.playerCardTab;
      card.querySelectorAll('[data-player-card-tab]').forEach(button => button.classList.toggle('active', button === tabButton));
      card.querySelectorAll('[data-player-card-pane]').forEach(pane => pane.classList.toggle('active', pane.dataset.playerCardPane === targetPane));
      return;
    }

    const tradeButton = event.target.closest('[data-player-card-action="trade"]');
    if (tradeButton) {
      const card = tradeButton.closest('[data-player-card]');
      if (!card) return;
      sendPlayerToTrade(card.dataset.playerId, card.dataset.leagueId);
    }
  });
}

function fillPickSelects() {
  fillTeamPlayerSelects();
}

function fillRecapWeeks() {
  const league = getSelectedLeague('recapLeagueSelect');
  const weeks = league ? Object.keys(league.matchupsByWeek).map(Number).sort((a, b) => a - b) : [];
  $('recapWeekSelect').innerHTML = weeks.map(w => `<option value="${w}">Week ${w}</option>`).join('');
  if (weeks.length) $('recapWeekSelect').value = String(weeks[weeks.length - 1]);
}

function getSelectedLeague(selectId) {
  const id = $(selectId)?.value || state.leagues[0]?.league_id;
  return state.leagues.find(l => String(l.league_id) === String(id)) || state.leagues[0] || null;
}

function renderMetrics() {
  const setText = (id, value) => {
    const el = $(id);
    if (el) el.textContent = value;
  };
  setText('metricLeagues', state.leagues.length);
  setText('metricTeams', state.leagues.reduce((sum, l) => sum + (l.rosters?.length || 0), 0));
  setText('metricWeeks', state.leagues.reduce((sum, l) => sum + Object.keys(l.matchupsByWeek || {}).length, 0));
  setText('metricPlayers', Object.keys(state.players || {}).length.toLocaleString());
}

function generateRecap() {
  const league = getSelectedLeague('recapLeagueSelect');
  if (!league) return;
  const range = $('recapRangeSelect').value;
  if (range === 'offseason') {
    generateOffseasonRecap(league);
    return;
  }
  if (range === 'draft') {
    generateDraftOnlyRecap(league);
    return;
  }

  const selectedWeek = Number($('recapWeekSelect').value);
  const loadedWeeks = Object.keys(league.matchupsByWeek).map(Number).sort((a, b) => a - b);
  let weeks = [selectedWeek];
  if (range === 'month') weeks = loadedWeeks.filter(w => w <= selectedWeek).slice(-4);
  if (range === 'season') weeks = loadedWeeks.filter(w => w <= selectedWeek);
  weeks = weeks.filter(Boolean);

  const lines = [];
  lines.push(`# Sleeper League Recap Package`);
  appendLeagueHeader(lines, league, range === 'week' ? `Week ${selectedWeek}` : range === 'month' ? `Weeks ${weeks[0]}-${weeks[weeks.length - 1]}` : `Weeks 1-${weeks[weeks.length - 1]}`);
  appendLeagueSettings(lines, league);
  appendStandingsSnapshot(lines, league);

  if (weeks.length > 1) {
    lines.push('## Range-wide highlights');
    rangeHighlights(league, weeks).forEach(line => lines.push(line));
    lines.push('');
  }

  for (const week of weeks) {
    lines.push(`## Week ${week}`);
    const matchups = league.matchupsByWeek[week] || [];
    const grouped = groupBy(matchups, m => m.matchup_id || `solo-${m.roster_id}`);
    const matchupLines = [];
    Object.values(grouped).forEach(pair => {
      if (pair.length === 2) {
        const [a, b] = pair.sort((x, y) => safeNumber(y.points) - safeNumber(x.points));
        const winner = a.points >= b.points ? a : b;
        const loser = winner === a ? b : a;
        const margin = roundNum(safeNumber(winner.points) - safeNumber(loser.points));
        const topWinner = topPlayersForMatchup(winner, 3);
        const topLoser = topPlayersForMatchup(loser, 2);
        const winnerBench = benchNotes(league, winner, week);
        const loserBench = benchNotes(league, loser, week);
        matchupLines.push(`- ${teamName(league, winner.roster_id)} beat ${teamName(league, loser.roster_id)} ${roundNum(winner.points)}-${roundNum(loser.points)} by ${margin}.`);
        matchupLines.push(`  - ${teamName(league, winner.roster_id)} top starters: ${topWinner}. ${winnerBench}`);
        matchupLines.push(`  - ${teamName(league, loser.roster_id)} top starters: ${topLoser}. ${loserBench}`);
      } else {
        pair.forEach(m => matchupLines.push(`- ${teamName(league, m.roster_id)} scored ${roundNum(m.points)}.`));
      }
    });
    lines.push(...(matchupLines.length ? matchupLines : ['- No matchup data available.']));

    const weeklyTop = topLeaguePlayers(league, week, 10);
    lines.push('');
    lines.push('### Top individual performances');
    weeklyTop.forEach((p, idx) => lines.push(`${idx + 1}. ${p.name} (${p.pos}) — ${roundNum(p.points)} points for ${teamName(league, p.rosterId)}${p.started ? '' : ' [BENCH]'}`));

    const txs = league.transactionsByWeek[week] || [];
    lines.push('');
    lines.push('### Transactions');
    if (!txs.length) lines.push('- No transactions loaded for this week.');
    txs.slice().sort((a, b) => safeNumber(a.created) - safeNumber(b.created)).forEach(tx => {
      const label = transactionSummary(league, tx);
      if (label) lines.push(`- ${label}`);
    });
    lines.push('');
  }

  lines.push('## Prompt for ChatGPT');
  lines.push('Using the league data above, write an entertaining but useful fantasy football recap. Explain what happened, who won/lost the week, biggest overperformers, awful bench decisions, important trades or waiver moves, team trends, and what managers should watch next. Do not invent facts not supported by the data.');
  $('recapOutput').value = lines.join('\n');
}

function appendLeagueHeader(lines, league, rangeLabel) {
  lines.push(`League: ${league.name}`);
  lines.push(`Season: ${league.season}`);
  lines.push(`Range: ${rangeLabel}`);
  lines.push(`Format: ${league.total_rosters} teams; roster slots ${league.roster_positions?.join(', ') || 'unknown'}`);
  lines.push('');
}

function appendLeagueSettings(lines, league) {
  lines.push('## League settings that matter');
  lines.push(`- Superflex: ${isSuperflexLeague(league) ? 'Yes' : 'No'}`);
  lines.push(`- TE premium: ${isTightEndPremium(league) ? 'Yes' : 'No'}`);
  lines.push(`- IDP slots: ${idpSlotCount(league)}`);
  lines.push(`- Draft rounds: ${safeNumber(league.settings?.draft_rounds, 0) || 'unknown'}`);
  lines.push(`- Trade deadline week: ${league.settings?.trade_deadline || league.settings?.trade_deadline_week || 'unknown'}`);
  lines.push(`- Waiver/FAAB settings JSON: ${JSON.stringify({waiver_type: league.settings?.waiver_type, waiver_budget: league.settings?.waiver_budget, waiver_clear_days: league.settings?.waiver_clear_days})}`);
  lines.push(`- Scoring settings JSON: ${JSON.stringify(league.scoring_settings || {})}`);
  lines.push('');
}

function appendStandingsSnapshot(lines, league) {
  lines.push('## Standings snapshot');
  [...league.rosters].sort((a, b) => safeNumber(b.settings?.wins) - safeNumber(a.settings?.wins) || totalFpts(b.settings) - totalFpts(a.settings)).forEach((r, idx) => {
    lines.push(`${idx + 1}. ${teamName(league, r.roster_id)} — ${safeNumber(r.settings?.wins)}-${safeNumber(r.settings?.losses)}-${safeNumber(r.settings?.ties)}, PF ${roundNum(totalFpts(r.settings))}, PA ${roundNum(totalAgainst(r.settings))}, moves ${safeNumber(r.settings?.total_moves)}`);
  });
  lines.push('');
}

function generateOffseasonRecap(league) {
  const lines = [];
  lines.push('# Sleeper League Offseason Recap Package');
  appendLeagueHeader(lines, league, 'Offseason');
  appendLeagueSettings(lines, league);
  lines.push('## Data included');
  lines.push(`- Drafts loaded: ${(league.drafts || []).length}`);
  lines.push(`- Draft picks loaded: ${(league.draftPicks || []).length}`);
  lines.push(`- Traded future picks currently recorded by Sleeper: ${(league.tradedPicks || []).length}`);
  lines.push(`- Transactions loaded from available Sleeper week endpoints: ${allLoadedTransactions(league).length}`);
  lines.push('- Note: Sleeper exposes transactions by week. True offseason activity is reconstructed from loaded draft data, traded picks, and available transaction rows; off-platform moves are not included.');
  lines.push('');

  lines.push('## Draft recap');
  draftRecapLines(league).forEach(line => lines.push(line));
  lines.push('');

  lines.push('## Draft trades and pick movement');
  draftTradeLines(league).forEach(line => lines.push(line));
  lines.push('');

  lines.push('## Other offseason / pre-season transaction notes');
  offseasonTransactionLines(league).forEach(line => lines.push(line));
  lines.push('');

  lines.push('## Roster landscape after the offseason');
  rosterLandscapeLines(league).forEach(line => lines.push(line));
  lines.push('');

  lines.push('## Prompt for ChatGPT');
  lines.push('Using the offseason data above, write a clear fantasy football offseason recap. Include the draft story, draft winners and losers, trades or pick movement, notable free-agent/waiver activity if present, team roster needs, and what managers should watch entering the season. Do not invent facts not supported by the data.');
  $('recapOutput').value = lines.join('\n');
}

function generateDraftOnlyRecap(league) {
  const lines = [];
  lines.push('# Sleeper Draft Recap + Draft Trade Package');
  appendLeagueHeader(lines, league, 'Draft recap and draft trades');
  appendLeagueSettings(lines, league);

  lines.push('## Draft recap');
  draftRecapLines(league).forEach(line => lines.push(line));
  lines.push('');

  lines.push('## Trades made during or around the draft');
  draftTradeLines(league).forEach(line => lines.push(line));
  lines.push('');

  lines.push('## Prompt for ChatGPT');
  lines.push('Using only the draft and draft-trade data above, write a focused fantasy football draft recap. Identify the best draft classes, risky reaches, value picks, positional runs, draft-day trades, and which teams changed their outlook the most. Do not invent facts not supported by the data.');
  $('recapOutput').value = lines.join('\n');
}

function draftRecapLines(league) {
  const lines = [];
  const drafts = (league.drafts || []).slice().sort((a, b) => safeNumber(b.start_time || b.created || b.last_picked) - safeNumber(a.start_time || a.created || a.last_picked));
  const picks = (league.draftPicks || []).slice().sort((a, b) => safeNumber(a.pick_no) - safeNumber(b.pick_no) || safeNumber(a.round) - safeNumber(b.round));
  if (!drafts.length && !picks.length) return ['- No draft data was loaded for this league.'];

  if (drafts.length) {
    lines.push('### Drafts loaded');
    drafts.forEach((draft, idx) => {
      const draftPicks = picks.filter(p => !draft.draft_id || !p.draft_id || String(p.draft_id) === String(draft.draft_id));
      const start = formatMaybeDate(draft.start_time || draft.created);
      lines.push(`${idx + 1}. ${draft.metadata?.name || draft.type || 'Draft'} — status ${draft.status || 'unknown'}, ${safeNumber(draft.settings?.rounds || league.settings?.draft_rounds, 0) || 'unknown'} rounds, ${draftPicks.length || 'unknown'} picks${start ? `, started ${start}` : ''}.`);
    });
    lines.push('');
  }

  const completedPicks = picks.filter(p => p.player_id);
  if (!completedPicks.length) {
    lines.push('- No completed draft picks found yet.');
    return lines;
  }

  const firstRound = completedPicks.filter(p => Number(p.round) === 1).sort((a, b) => safeNumber(a.pick_no) - safeNumber(b.pick_no));
  lines.push('### First round');
  (firstRound.length ? firstRound : completedPicks.slice(0, Math.min(12, completedPicks.length))).forEach(pick => {
    lines.push(`- ${formatDraftPickLabel(league, pick)} — ${playerName(pick.player_id)} (${playerPrimaryPosition(pick.player_id)})${pick.metadata?.team ? `, ${pick.metadata.team}` : ''}.`);
  });
  lines.push('');

  const classes = draftClasses(league, completedPicks);
  if (classes.length) {
    lines.push('### Draft class summary by team');
    classes.slice(0, Math.min(league.total_rosters || 12, classes.length)).forEach((row, idx) => {
      const top = row.picks.slice(0, 4).map(p => `${playerName(p.player_id)} (${roundPickText(p)})`).join(', ');
      lines.push(`${idx + 1}. ${teamName(league, row.rosterId)} — ${row.picks.length} picks, estimated drafted player value ${roundNum(row.value)}. Top picks: ${top || 'none'}.`);
    });
    lines.push('');
  }

  const topValues = completedPicks
    .map(pick => ({ pick, value: playerValue(league, pick.player_id).value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);
  lines.push('### Highest current model values from the draft');
  topValues.forEach((row, idx) => {
    lines.push(`${idx + 1}. ${playerName(row.pick.player_id)} (${playerPrimaryPosition(row.pick.player_id)}) — ${formatDraftPickLabel(league, row.pick)}, model value ${roundNum(row.value)}.`);
  });

  const positionCounts = groupCounts(completedPicks.map(p => playerPrimaryPosition(p.player_id)));
  lines.push('');
  lines.push(`### Position mix`);
  lines.push(`- ${Object.entries(positionCounts).sort((a, b) => b[1] - a[1]).map(([pos, count]) => `${pos}: ${count}`).join('; ') || 'No position data.'}`);
  return lines;
}

function draftTradeLines(league) {
  const lines = [];
  const txRows = allLoadedTransactions(league)
    .filter(({ tx }) => isTradeTransaction(tx))
    .map(({ week, tx }) => ({ week, tx, summary: transactionSummary(league, tx), score: draftTradeScore(league, tx) }))
    .filter(row => row.score > 0 || /draft|pick|R\d|round/i.test(row.summary || ''))
    .sort((a, b) => b.score - a.score || safeNumber(a.tx.created) - safeNumber(b.tx.created));

  if (txRows.length) {
    lines.push('### Loaded draft-related trades');
    txRows.slice(0, 20).forEach(row => {
      const when = formatMaybeDate(row.tx.created);
      lines.push(`- ${when ? `${when}; ` : ''}Week ${row.week}: ${row.summary} Approx pick/player value involved: ${roundNum(transactionImpact(league, row.tx))}.`);
    });
  } else {
    lines.push('### Loaded draft-related trades');
    lines.push('- No draft-day trade transactions were found in the loaded Sleeper transaction rows.');
  }

  const traded = (league.tradedPicks || []).slice().sort((a, b) => Number(a.season) - Number(b.season) || Number(a.round) - Number(b.round));
  lines.push('');
  lines.push('### Current traded future picks');
  if (!traded.length) {
    lines.push('- No traded future picks are currently listed by Sleeper for this league.');
  } else {
    traded.slice(0, 40).forEach(p => {
      const original = Number(p.roster_id || p.original_roster_id || p.originalRosterId);
      const owner = Number(p.owner_id || p.new_owner_id || p.ownerRosterId || p.owner_roster_id);
      lines.push(`- ${p.season} Round ${p.round}: originally ${teamName(league, original)}, currently owned by ${teamName(league, owner)}.`);
    });
    if (traded.length > 40) lines.push(`- Plus ${traded.length - 40} more traded picks.`);
  }
  return lines;
}

function offseasonTransactionLines(league) {
  const rows = allLoadedTransactions(league)
    .map(({ week, tx }) => ({ week, tx, summary: transactionSummary(league, tx), impact: transactionImpact(league, tx) }))
    .filter(row => row.summary)
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  if (!rows.length) return ['- No transaction rows are loaded for offseason analysis.'];

  const trades = rows.filter(r => isTradeTransaction(r.tx)).slice(0, 8);
  const adds = rows.filter(r => !isTradeTransaction(r.tx) && Object.keys(r.tx.adds || {}).length).slice(0, 12);
  const lines = [];
  if (trades.length) {
    lines.push('### Biggest loaded trades');
    trades.forEach(r => lines.push(`- Week ${r.week}: ${r.summary} Approx value swing: ${roundNum(r.impact)}.`));
  } else {
    lines.push('### Biggest loaded trades');
    lines.push('- No trade transactions loaded outside the draft-pick movement above.');
  }
  lines.push('');
  lines.push('### Notable adds / drops');
  if (adds.length) adds.forEach(r => lines.push(`- Week ${r.week}: ${r.summary} Approx value swing: ${roundNum(r.impact)}.`));
  else lines.push('- No notable add/drop rows loaded.');
  return lines;
}

function rosterLandscapeLines(league) {
  const lines = [];
  const rows = [...(league.teamStrength || new Map()).entries()].sort((a, b) => b[1].score - a[1].score);
  if (!rows.length) return ['- Roster strength data is unavailable.'];
  lines.push('### Current roster strength');
  rows.slice(0, 5).forEach(([rid, s], idx) => lines.push(`${idx + 1}. ${teamName(league, rid)} — total value ${roundNum(s.rosterValue)}, starter value ${roundNum(s.startersValue)}, potential PF ${roundNum(s.maxpf)}.`));
  lines.push('');
  lines.push('### Team needs entering the season');
  rows.forEach(([rid]) => lines.push(`- ${teamName(league, rid)}: ${rosterNeedsSummary(league, rid)}`));
  return lines;
}

function allLoadedTransactions(league) {
  return Object.entries(league.transactionsByWeek || {})
    .flatMap(([week, txs]) => (txs || []).map(tx => ({ week: Number(week), tx })))
    .filter(row => row.tx);
}

function isTradeTransaction(tx) {
  return String(tx?.type || '').toLowerCase().includes('trade') || Array.isArray(tx?.draft_picks) && tx.draft_picks.length > 0;
}

function draftTradeScore(league, tx) {
  let score = 0;
  score += (tx?.draft_picks || []).length * 10;
  const created = safeNumber(tx?.created);
  for (const draft of league.drafts || []) {
    const start = safeNumber(draft.start_time || draft.created);
    if (!created || !start) continue;
    const diff = Math.abs(created - start);
    if (diff <= 1000 * 60 * 60 * 36) score += 8;
  }
  if (score > 0) {
    score += Object.keys(tx?.adds || {}).length;
    score += Object.keys(tx?.drops || {}).length;
  }
  return score;
}

function draftClasses(league, picks) {
  const map = new Map();
  picks.forEach(pick => {
    const rid = draftPickRosterId(league, pick);
    if (!rid) return;
    if (!map.has(rid)) map.set(rid, { rosterId: rid, value: 0, picks: [] });
    const row = map.get(rid);
    row.picks.push(pick);
    row.value += playerValue(league, pick.player_id).value;
  });
  return [...map.values()].map(row => {
    row.picks.sort((a, b) => safeNumber(a.pick_no) - safeNumber(b.pick_no));
    return row;
  }).sort((a, b) => b.value - a.value || b.picks.length - a.picks.length);
}

function draftPickRosterId(league, pick) {
  const direct = Number(pick.roster_id || pick.rosterId || pick.owner_id || pick.ownerRosterId);
  if (direct && league.rosterMap?.has(direct)) return direct;
  const slot = Number(pick.draft_slot || pick.slot);
  const draft = (league.drafts || []).find(d => String(d.draft_id) === String(pick.draft_id));
  const fromSlot = Number(draft?.slot_to_roster_id?.[slot] || draft?.metadata?.slot_to_roster_id?.[slot]);
  if (fromSlot && league.rosterMap?.has(fromSlot)) return fromSlot;
  return direct || slot || 0;
}

function formatDraftPickLabel(league, pick) {
  const pickNo = safeNumber(pick.pick_no || pick.pick, 0);
  const round = safeNumber(pick.round, 0);
  const rosterId = draftPickRosterId(league, pick);
  const slotText = pickNo ? `Pick ${pickNo}` : round ? `Round ${round}` : 'Draft pick';
  const roundText = round ? `R${round}` : '';
  const teamText = rosterId ? `to ${teamName(league, rosterId)}` : 'team unknown';
  return `${slotText}${roundText ? ` (${roundText})` : ''} ${teamText}`;
}

function roundPickText(pick) {
  const round = safeNumber(pick.round, 0);
  const pickNo = safeNumber(pick.pick_no || pick.pick, 0);
  return round && pickNo ? `R${round}, pick ${pickNo}` : round ? `R${round}` : pickNo ? `pick ${pickNo}` : 'pick';
}

function groupCounts(values) {
  return (values || []).reduce((obj, val) => {
    const key = val || 'UNK';
    obj[key] = (obj[key] || 0) + 1;
    return obj;
  }, {});
}

function formatMaybeDate(value) {
  const num = safeNumber(value);
  if (!num) return '';
  const ms = num < 10_000_000_000 ? num * 1000 : num;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}


function rangeHighlights(league, weeks) {
  const teamRows = new Map();
  const playerRows = [];
  const benchRows = [];
  for (const roster of league.rosters || []) {
    teamRows.set(Number(roster.roster_id), { rosterId: Number(roster.roster_id), points: 0, wins: 0, losses: 0, ties: 0, bestWeek: 0, benchLeft: 0 });
  }

  for (const week of weeks) {
    const matchups = league.matchupsByWeek[week] || [];
    const grouped = groupBy(matchups, m => m.matchup_id || `solo-${m.roster_id}`);
    for (const m of matchups) {
      const row = teamRows.get(Number(m.roster_id));
      if (!row) continue;
      row.points += safeNumber(m.points);
      row.bestWeek = Math.max(row.bestWeek, safeNumber(m.points));
      const optimal = optimalStarterScore(league, m.players || [], week);
      const left = Math.max(0, optimal.total - safeNumber(m.points));
      row.benchLeft += left;
      benchRows.push({ rosterId: m.roster_id, week, left });
      const pts = m.players_points || m.player_points || {};
      for (const [pid, points] of Object.entries(pts)) {
        playerRows.push({ pid, points: safeNumber(points), rosterId: m.roster_id, week, started: (m.starters || []).includes(pid) });
      }
    }
    Object.values(grouped).forEach(pair => {
      if (pair.length !== 2) return;
      const [a, b] = pair;
      const ar = teamRows.get(Number(a.roster_id));
      const br = teamRows.get(Number(b.roster_id));
      if (!ar || !br) return;
      if (safeNumber(a.points) > safeNumber(b.points)) { ar.wins++; br.losses++; }
      else if (safeNumber(b.points) > safeNumber(a.points)) { br.wins++; ar.losses++; }
      else { ar.ties++; br.ties++; }
    });
  }

  const lines = [];
  const scoring = [...teamRows.values()].sort((a, b) => b.points - a.points).slice(0, 5);
  lines.push(`- Highest scoring teams: ${scoring.map(r => `${teamName(league, r.rosterId)} ${roundNum(r.points)}`).join('; ')}.`);
  const records = [...teamRows.values()].sort((a, b) => b.wins - a.wins || b.points - a.points).slice(0, 5);
  lines.push(`- Best records in range: ${records.map(r => `${teamName(league, r.rosterId)} ${r.wins}-${r.losses}-${r.ties}`).join('; ')}.`);
  const bench = benchRows.sort((a, b) => b.left - a.left).slice(0, 5);
  lines.push(`- Biggest estimated bench mistakes: ${bench.map(r => `${teamName(league, r.rosterId)} left ${roundNum(r.left)} in Week ${r.week}`).join('; ')}.`);
  const players = playerRows.sort((a, b) => b.points - a.points).slice(0, 10);
  lines.push(`- Biggest individual scores: ${players.map(p => `${playerName(p.pid)} ${roundNum(p.points)} Week ${p.week} for ${teamName(league, p.rosterId)}${p.started ? '' : ' [bench]'}`).join('; ')}.`);

  const txs = weeks.flatMap(week => (league.transactionsByWeek[week] || []).map(tx => ({ week, tx })));
  const notable = txs.map(({ week, tx }) => ({ week, summary: transactionSummary(league, tx), impact: transactionImpact(league, tx) }))
    .filter(x => x.summary)
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .slice(0, 8);
  if (notable.length) {
    lines.push('- Notable transaction swings:');
    notable.forEach(x => lines.push(`  - Week ${x.week}: ${x.summary} Approx value swing: ${roundNum(x.impact)}.`));
  } else {
    lines.push('- No notable transactions loaded in this range.');
  }
  return lines;
}

function transactionImpact(league, tx) {
  const adds = tx.adds || {};
  const drops = tx.drops || {};
  let impact = 0;
  Object.keys(adds).forEach(pid => impact += playerValue(league, pid).value);
  Object.keys(drops).forEach(pid => impact -= playerValue(league, pid).value);
  for (const pick of (tx.draft_picks || [])) impact += pickValue(league, pick).value;
  return impact;
}

function topPlayersForMatchup(matchup, count) {
  const starters = matchup.starters || [];
  const pts = matchup.players_points || matchup.player_points || {};
  return starters
    .map(pid => ({ pid, points: safeNumber(pts[pid]) }))
    .sort((a, b) => b.points - a.points)
    .slice(0, count)
    .map(p => `${playerName(p.pid)} ${roundNum(p.points)}`)
    .join(', ') || 'none';
}

function benchNotes(league, matchup, week) {
  const bench = (matchup.players || []).filter(pid => !(matchup.starters || []).includes(pid));
  const pts = matchup.players_points || matchup.player_points || {};
  const topBench = bench.map(pid => ({ pid, points: safeNumber(pts[pid]) })).sort((a, b) => b.points - a.points)[0];
  const optimal = optimalStarterScore(league, matchup.players || [], week);
  const left = Math.max(0, optimal.total - safeNumber(matchup.points));
  if (!topBench) return `Estimated points left on bench: ${roundNum(left)}.`;
  return `Best bench score: ${playerName(topBench.pid)} ${roundNum(topBench.points)}. Estimated points left on bench: ${roundNum(left)}.`;
}

function topLeaguePlayers(league, week, count) {
  const matchups = league.matchupsByWeek[week] || [];
  const rows = [];
  for (const matchup of matchups) {
    const pts = matchup.players_points || matchup.player_points || {};
    for (const [pid, points] of Object.entries(pts)) {
      rows.push({
        pid,
        name: playerName(pid),
        pos: playerPrimaryPosition(pid),
        points: safeNumber(points),
        rosterId: matchup.roster_id,
        started: (matchup.starters || []).includes(pid)
      });
    }
  }
  return rows.sort((a, b) => b.points - a.points).slice(0, count);
}

function transactionSummary(league, tx) {
  const type = tx.type || 'transaction';
  const adds = tx.adds || {};
  const drops = tx.drops || {};
  const addText = Object.entries(adds).map(([pid, rid]) => `${teamName(league, rid)} added ${playerName(pid)}`).join('; ');
  const dropText = Object.entries(drops).map(([pid, rid]) => `${teamName(league, rid)} dropped ${playerName(pid)}`).join('; ');
  const pickText = (tx.draft_picks || []).map(p => `${p.season} R${p.round} pick from roster ${p.roster_id} to roster ${p.owner_id}`).join('; ');
  const faab = (tx.waiver_budget || []).map(w => `${teamName(league, w.sender)} sent $${w.amount || 0} FAAB to ${teamName(league, w.receiver)}`).join('; ');
  const parts = [addText, dropText, pickText, faab].filter(Boolean).join(' | ');
  if (!parts) return `${type} transaction with no player/pick details available.`;
  return `${type.toUpperCase()}: ${parts}`;
}

function groupBy(array, keyFn) {
  return (array || []).reduce((obj, item) => {
    const key = keyFn(item);
    obj[key] = obj[key] || [];
    obj[key].push(item);
    return obj;
  }, {});
}

function exportData() {
  const data = {
    generatedAt: new Date().toISOString(),
    nflState: state.nflState,
    leagues: state.leagues.map(l => ({
      league: stripMaps(l),
      teamStrength: [...l.teamStrength.entries()],
      playerStats: [...l.playerStats.entries()].map(([pid, rec]) => [pid, { ...rec, rosterIds: [...rec.rosterIds] }])
    }))
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sleeper-trade-shield-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function stripMaps(league) {
  const clone = { ...league };
  delete clone.userMap;
  delete clone.rosterMap;
  delete clone.playerStats;
  delete clone.valueCache;
  delete clone.teamStrength;
  return clone;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

async function loadAll(idsOverride = null) {
  const raw = Array.isArray(idsOverride) ? idsOverride.join('\n') : (idsOverride || state.savedLeagueIds.join('\n'));
  const ids = parseLeagueIds(raw);
  if (!ids.length) {
    alert('Add at least one valid Sleeper league ID.');
    return;
  }
  saveLeagueIds(ids);
  if ($('leagueIdInput')) $('leagueIdInput').value = '';
  setBusy(true);
  try {
    if (!state.nflState) await loadNflState();
    if (!Object.keys(state.players || {}).length) await loadPlayers();

    const existing = new Map(state.leagues.map(league => [String(league.league_id), league]));
    const loaded = [];
    for (const id of ids) {
      try {
        if (existing.has(String(id))) {
          loaded.push(existing.get(String(id)));
        } else {
          const league = await loadLeague(id);
          loaded.push(league);
        }
      } catch (err) {
        logStatus(err.message);
        console.error(err);
      }
    }
    state.leagues = loaded;
    const stored = localStorage.getItem(STORAGE_KEYS.selectedLeague);
    if (!stored && loaded[0]) localStorage.setItem(STORAGE_KEYS.selectedLeague, loaded[0].league_id);
    if (stored && !loaded.some(l => String(l.league_id) === String(stored)) && loaded[0]) localStorage.setItem(STORAGE_KEYS.selectedLeague, loaded[0].league_id);
    state.selectedAssets = { A: [], B: [] };
    renderEverything();
  } finally {
    setBusy(false);
  }
}

function renderEverything() {
  renderLeagueList();
  fillLeagueSelects();
  renderMetrics();
  renderTables();
  renderAssetList('A');
  renderAssetList('B');
}

function wireEvents() {
  const loadBtn = $('loadLeaguesBtn');
  if (loadBtn) loadBtn.addEventListener('click', () => loadAll());
  $('addLeagueIdBtn').addEventListener('click', addSavedLeagueId);
  $('leagueIdInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addSavedLeagueId(); } });
  $('clearBtn').addEventListener('click', () => {
    state.leagues = [];
    state.selectedAssets = { A: [], B: [] };
    localStorage.removeItem(STORAGE_KEYS.leagues);
    localStorage.removeItem(STORAGE_KEYS.selectedLeague);
    state.savedLeagueIds = [];
    $('leagueIdInput').value = '';
    renderEverything();
    logStatus('Cleared leagues from this browser.');
  });

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  });

  wirePlayerCardActions();

  ['dashboardLeagueSelect', 'tradeLeagueSelect', 'recapLeagueSelect', 'playerLeagueSelect', 'rulesLeagueSelect'].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', () => {
      localStorage.setItem(STORAGE_KEYS.selectedLeague, el.value);
      if (id === 'tradeLeagueSelect') { fillTeamSelects(); fillPickSelects(); state.selectedAssets = { A: [], B: [] }; renderAssetList('A'); renderAssetList('B'); }
      if (id === 'recapLeagueSelect') fillRecapWeeks();
      if (id === 'playerLeagueSelect') fillPlayerSeasonSelect();
      renderLeagueList();
      renderTables();
    });
  });

  ['teamASelect', 'teamBSelect'].forEach(id => $(id).addEventListener('change', fillTeamPlayerSelects));
  $('playerStatsSeasonSelect').addEventListener('change', renderPlayerComparison);

  $('teamAAddPlayer').addEventListener('click', () => addPlayerAsset('A', 'teamAPlayerSearch'));
  $('teamBAddPlayer').addEventListener('click', () => addPlayerAsset('B', 'teamBPlayerSearch'));
  $('evaluateTradeBtn').addEventListener('click', evaluateTrade);
  $('resetTradeBtn').addEventListener('click', () => { state.selectedAssets = { A: [], B: [] }; renderAssetList('A'); renderAssetList('B'); $('tradeResult').className = 'trade-result empty'; $('tradeResult').textContent = 'Choose teams and assets, then evaluate.'; });
  $('generateWeekRecapBtn').addEventListener('click', () => { $('recapRangeSelect').value = 'week'; generateRecap(); });
  $('generateMonthRecapBtn').addEventListener('click', () => { $('recapRangeSelect').value = 'month'; generateRecap(); });
  $('generateSeasonRecapBtn').addEventListener('click', () => { $('recapRangeSelect').value = 'season'; generateRecap(); });
  $('generateOffseasonRecapBtn').addEventListener('click', () => { $('recapRangeSelect').value = 'offseason'; generateRecap(); });
  $('generateDraftRecapBtn').addEventListener('click', () => { $('recapRangeSelect').value = 'draft'; generateRecap(); });
  $('copyRecapBtn').addEventListener('click', async () => { await navigator.clipboard.writeText($('recapOutput').value); logStatus('Copied recap text to clipboard.'); });
  $('exportDataBtn').addEventListener('click', exportData);
  $('playerValueSearch').addEventListener('input', renderPlayerValues);
  $('playerPositionFilter').addEventListener('change', renderPlayerValues);
  $('buildPlayerCompareBtn').addEventListener('click', renderPlayerComparison);
  $('swapPlayerCompareBtn').addEventListener('click', () => { const a = $('playerCompareA').value; $('playerCompareA').value = $('playerCompareB').value; $('playerCompareB').value = a; renderPlayerComparison(); renderPlayerValues(); });
  $('clearPlayerCompareBtn').addEventListener('click', () => { $('playerCompareA').value = ''; $('playerCompareB').value = ''; renderPlayerComparison(); renderPlayerValues(); });
  ['playerCompareA', 'playerCompareB'].forEach(id => {
    $(id).addEventListener('keydown', event => { if (event.key === 'Enter') { renderPlayerComparison(); renderPlayerValues(); } });
    $(id).addEventListener('change', () => { renderPlayerComparison(); renderPlayerValues(); });
  });

  ['ageWeight', 'recentWeight', 'needWeight', 'pickWeight'].forEach(id => {
    $(id).addEventListener('input', () => {
      $(`${id}Value`).textContent = `${Number($(id).value).toFixed(1)}x`;
    });
  });
  $('saveSettingsBtn').addEventListener('click', () => {
    ['ageWeight', 'recentWeight', 'needWeight', 'pickWeight'].forEach(id => state.settings[id] = Number($(id).value));
    saveSettings();
    for (const league of state.leagues) { league.valueCache.clear(); buildTeamStrength(league); }
    renderEverything();
    logStatus('Saved value model settings.');
  });
  $('resetSettingsBtn').addEventListener('click', () => {
    state.settings = { ...DEFAULT_SETTINGS };
    saveSettings();
    applySettingsToUI();
    for (const league of state.leagues) { league.valueCache.clear(); buildTeamStrength(league); }
    renderEverything();
    logStatus('Reset value model settings.');
  });
}

function applySettingsToUI() {
  for (const [key, value] of Object.entries(state.settings)) {
    if ($(key)) {
      $(key).value = value;
      $(`${key}Value`).textContent = `${Number(value).toFixed(1)}x`;
    }
  }
}

async function boot() {
  wireEvents();
  applySettingsToUI();
  saveLeagueIds(state.savedLeagueIds);
  renderEverything();
  try {
    await loadNflState();
    await loadPlayers();
    renderMetrics();
    if (state.savedLeagueIds.length) await loadAll(state.savedLeagueIds);
  } catch (err) {
    logStatus(`Initial data load warning: ${err.message}`);
    console.warn(err);
  }
}

boot();
