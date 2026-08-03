/* Sleeper Trade Shield
   Static web app for Sleeper fantasy football league analysis.
   Uses only public/read-only Sleeper API endpoints. */

const API_BASE = 'https://api.sleeper.app/v1';
const API_STATS_BASE = 'https://api.sleeper.com/stats/nfl/player';
const API_PROJECTIONS_BASE = 'https://api.sleeper.com/projections/nfl';
const STORAGE_KEYS = {
  leagues: 'sts.leagueIds',
  selectedLeague: 'sts.selectedLeagueId',
  myTeamByLeague: 'sts.myTeamByLeague',
  settings: 'sts.settings'
};

const DEFAULT_SETTINGS = {
  ageWeight: 1,
  recentWeight: 1,
  projectionWeight: 1,
  efficiencyWeight: 1,
  needWeight: 1,
  pickWeight: 1
};

const POSITION_ORDER = ['QB', 'RB', 'WR', 'TE', 'DL', 'LB', 'DB', 'K', 'DEF'];
const POSITION_ALIASES = {
  DE: 'DL', DT: 'DL', NT: 'DL', EDGE: 'DL',
  ILB: 'LB', OLB: 'LB', MLB: 'LB',
  CB: 'DB', S: 'DB', FS: 'DB', SS: 'DB'
};
const MARKET_VALUE_CURVE = [
  [1, 10000], [3, 9600], [6, 9100], [12, 8300], [24, 7100], [36, 6100],
  [50, 5200], [75, 4100], [100, 3300], [150, 2300], [200, 1600],
  [300, 850], [400, 450], [600, 180], [1000, 60]
];
const PICK_VALUE_BANDS = {
  1: { early: 7800, mid: 5250, late: 3850 },
  2: { early: 3250, mid: 2200, late: 1450 },
  3: { early: 1400, mid: 850, late: 500 },
  4: { early: 700, mid: 400, late: 225 },
  5: { early: 350, mid: 190, late: 100 },
  6: { early: 180, mid: 95, late: 50 }
};
const POSITION_VALUE_CAPS = { K: 750, DEF: 950 };
const FLEX_SLOTS = new Set(['FLEX', 'REC_FLEX', 'WRRB_FLEX', 'WRT', 'RB_WR_TE']);
const SUPER_FLEX_SLOTS = new Set(['SUPER_FLEX', 'SUPERFLEX', 'OP']);
const IDP_FLEX_SLOTS = new Set(['IDP_FLEX', 'DL_LB_DB']);
const RECENT_GAME_COUNT = 5;
const DRAFT_PICK_LOOKAHEAD_YEARS = 3;
const DRAFT_AVAILABILITY_SIMULATIONS = 180;

const POSITION_AGE_CURVES = {
  // Approximate dynasty curve by fantasy position. The horizon is a planning estimate, not a player-specific retirement prediction.
  QB: { primeStart: 24, primeEnd: 31, declineStart: 34, retirement: 38, youngBonus: 580, primeBonus: 260, maxPenalty: -1500 },
  RB: { primeStart: 22, primeEnd: 25, declineStart: 27, retirement: 30, youngBonus: 720, primeBonus: 220, maxPenalty: -1900 },
  WR: { primeStart: 23, primeEnd: 28, declineStart: 31, retirement: 34, youngBonus: 620, primeBonus: 220, maxPenalty: -1450 },
  TE: { primeStart: 24, primeEnd: 30, declineStart: 32, retirement: 35, youngBonus: 440, primeBonus: 180, maxPenalty: -1100 },
  DL: { primeStart: 24, primeEnd: 29, declineStart: 31, retirement: 34, youngBonus: 240, primeBonus: 90, maxPenalty: -650 },
  LB: { primeStart: 24, primeEnd: 29, declineStart: 31, retirement: 33, youngBonus: 260, primeBonus: 90, maxPenalty: -750 },
  DB: { primeStart: 24, primeEnd: 29, declineStart: 31, retirement: 34, youngBonus: 240, primeBonus: 90, maxPenalty: -650 },
  K: { primeStart: 25, primeEnd: 35, declineStart: 38, retirement: 42, youngBonus: 40, primeBonus: 20, maxPenalty: -160 },
  DEF: { primeStart: 0, primeEnd: 99, declineStart: 99, retirement: 99, youngBonus: 0, primeBonus: 0, maxPenalty: 0 },
  UNK: { primeStart: 23, primeEnd: 28, declineStart: 31, retirement: 34, youngBonus: 240, primeBonus: 80, maxPenalty: -700 }
};

const AGE_STAGE_LABELS = {
  ascending: 'Ascending',
  prime: 'Prime',
  'late-prime': 'Late prime',
  decline: 'Decline window',
  'cliff-risk': 'Horizon risk',
  unknown: 'Age unavailable'
};


const state = {
  nflState: null,
  players: {},
  projections: new Map(),
  projectionSeason: null,
  weeklyProjections: new Map(),
  weeklySchedule: new Map(),
  weeklyProjectionMeta: null,
  weeklyProjectionError: '',
  playerSearch: [],
  leagues: [],
  savedLeagueIds: loadSavedLeagueIds(),
  myTeamByLeague: loadMyTeamByLeague(),
  selectedAssets: { A: [], B: [] },
  freeAgency: { selectedPlayerId: '' },
  settings: loadSettings()
};

let tradeEvaluationTimer = null;
let recapGenerationTimer = null;
let modelSettingsTimer = null;

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

function loadMyTeamByLeague() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.myTeamByLeague) || '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved)
      .map(([leagueId, rosterId]) => [String(leagueId), String(rosterId)])
      .filter(([leagueId, rosterId]) => /^\d{10,}$/.test(leagueId) && /^\d+$/.test(rosterId)));
  } catch {
    return {};
  }
}

function saveMyTeamForLeague(leagueId, rosterId) {
  const leagueKey = String(leagueId || '').trim();
  const rosterKey = String(rosterId || '').trim();
  if (!leagueKey) return;
  if (rosterKey) state.myTeamByLeague[leagueKey] = rosterKey;
  else delete state.myTeamByLeague[leagueKey];
  localStorage.setItem(STORAGE_KEYS.myTeamByLeague, JSON.stringify(state.myTeamByLeague));
}

function savedMyTeamRosterId(league, selections = state.myTeamByLeague) {
  if (!league) return 0;
  const rosterId = Number(selections?.[String(league.league_id)]);
  return (league.rosters || []).some(roster => Number(roster.roster_id) === rosterId) ? rosterId : 0;
}

function defaultTeamRosterId(league, selections = state.myTeamByLeague) {
  return savedMyTeamRosterId(league, selections) || Number(league?.rosters?.[0]?.roster_id || 0);
}

async function addSavedLeagueId() {
  const input = $('leagueIdInput');
  const addedIds = parseLeagueIds(input.value);
  if (!addedIds.length) {
    alert('Enter a valid Sleeper league ID.');
    return;
  }
  const ids = [...new Set([...state.savedLeagueIds, ...addedIds])];
  const addedLeagueId = addedIds.find(id => !state.savedLeagueIds.includes(id)) || addedIds[0];
  saveLeagueIds(ids);
  localStorage.setItem(STORAGE_KEYS.selectedLeague, addedLeagueId);
  input.value = '';
  logStatus(`Added ${addedIds.length} league${addedIds.length === 1 ? '' : 's'}; ${ids.length} saved on this device.`);
  await loadAll(ids);
  const addedLeague = state.leagues.find(league => String(league.league_id) === String(addedLeagueId));
  if (addedLeague && !savedMyTeamRosterId(addedLeague)) {
    $('myTeamSelect')?.focus({ preventScroll: true });
    logStatus(`Choose your team for ${addedLeague.name || addedLeagueId} to use it as the default roster.`);
  }
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

function normalizePosition(position) {
  const pos = String(position || 'UNK').toUpperCase();
  return POSITION_ALIASES[pos] || pos;
}

function playerPrimaryPosition(pid) {
  const p = getPlayer(pid);
  if (!p) return 'UNK';
  if (p.position) return normalizePosition(p.position);
  if (Array.isArray(p.fantasy_positions) && p.fantasy_positions.length) return normalizePosition(p.fantasy_positions[0]);
  return 'UNK';
}

function playerFantasyPositions(pid) {
  const p = getPlayer(pid);
  const positions = new Set();
  if (p?.position) {
    positions.add(String(p.position).toUpperCase());
    positions.add(normalizePosition(p.position));
  }
  if (Array.isArray(p?.fantasy_positions)) p.fantasy_positions.forEach(pos => {
    positions.add(String(pos).toUpperCase());
    positions.add(normalizePosition(pos));
  });
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

function displayNumber(value, digits = 2) {
  const number = safeNumber(value, 0);
  const precision = Math.max(0, Math.min(2, safeNumber(digits, 2)));
  return Number(number.toFixed(precision)).toLocaleString(undefined, { maximumFractionDigits: precision });
}

function displaySignedNumber(value, digits = 2) {
  const number = safeNumber(value, 0);
  return `${number > 0 ? '+' : ''}${displayNumber(number, digits)}`;
}

function displayJson(value) {
  return JSON.stringify(value, (key, item) => typeof item === 'number' ? roundNum(item, 2) : item);
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

function activeValuationSeason(league) {
  return Number(state.nflState?.league_season || state.nflState?.season || league?.season || new Date().getFullYear());
}

function isDynastyLeague(league) {
  const settings = league.settings || {};
  const explicitType = Number(settings.type);
  if (explicitType === 2) return true;
  if (explicitType === 0 || explicitType === 1) return false;
  return Boolean(settings.taxi_slots || String(league.name || '').toLowerCase().includes('dynasty'));
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
    return ['DL', 'LB', 'DB', 'DE', 'DT', 'EDGE', 'ILB', 'OLB', 'CB', 'S', 'IDP'].includes(s) || IDP_FLEX_SLOTS.has(s);
  }).length;
}

function activeLeaguePositions(league) {
  const active = new Set();
  const starterSlots = (league?.roster_positions || [])
    .map(slot => String(slot).toUpperCase())
    .filter(slot => !['BN', 'BE', 'IR', 'TAXI'].includes(slot));

  for (const slot of starterSlots) {
    const normalized = normalizePosition(slot);
    if (POSITION_ORDER.includes(normalized)) active.add(normalized);
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

async function loadProjections() {
  const season = activeValuationSeason();
  const cacheKey = `projections.nfl.${season}.regular.v2`;
  const cached = await idbGet(cacheKey).catch(() => null);
  const sixHours = 6 * 60 * 60 * 1000;
  let rows = null;

  if (cached?.rows && Date.now() - cached.savedAt < sixHours) {
    rows = cached.rows;
    logStatus(`Loaded ${season} player projections from local cache.`);
  } else {
    logStatus(`Fetching ${season} projections and format-specific ADP.`);
    rows = await fetchJson(`${API_PROJECTIONS_BASE}/${season}?season_type=regular`, `${season} projections`);
    await idbSet(cacheKey, { savedAt: Date.now(), rows }).catch(() => null);
    logStatus(`Fetched ${Array.isArray(rows) ? rows.length.toLocaleString() : 0} projection rows.`);
  }

  state.projections = new Map((Array.isArray(rows) ? rows : [])
    .filter(row => row?.player_id)
    .map(row => [String(row.player_id), row]));
  state.projectionSeason = season;
}

function upcomingLineupPeriod(nflState = state.nflState) {
  const seasonType = String(nflState?.season_type || '').toLowerCase();
  const season = Number(
    nflState?.league_season ||
    nflState?.league_create_season ||
    nflState?.season ||
    new Date().getFullYear()
  );
  const inRegularSeason = seasonType === 'regular';
  const reportedWeek = safeNumber(
    nflState?.display_week || nflState?.week || nflState?.leg,
    1
  );
  const week = inRegularSeason ? clampNumber(reportedWeek, 1, 18) : 1;
  return {
    season,
    week,
    seasonType: seasonType || 'offseason',
    inRegularSeason,
    resetToWeekOne: !inRegularSeason,
    label: `${season} Week ${week}`
  };
}

function rebuildWeeklySchedule(rows = []) {
  const schedule = new Map();
  for (const row of rows || []) {
    const team = String(row?.team || row?.player?.team || '').toUpperCase();
    const opponent = String(row?.opponent || row?.opp || '').toUpperCase();
    if (team && opponent) {
      schedule.set(team, opponent);
      if (!schedule.has(opponent)) schedule.set(opponent, team);
    }
  }
  state.weeklySchedule = schedule;
  return schedule;
}

async function loadWeeklyProjections({ force = false } = {}) {
  const period = upcomingLineupPeriod();
  const cacheKey = `projections.nfl.${period.season}.week.${period.week}.regular.v1`;
  const cached = force ? null : await idbGet(cacheKey).catch(() => null);
  const cacheWindow = period.inRegularSeason ? 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
  let rows = null;
  let savedAt = Date.now();

  if (cached?.rows && Date.now() - cached.savedAt < cacheWindow) {
    rows = cached.rows;
    savedAt = cached.savedAt;
    logStatus(`Loaded ${period.label} weekly projections from local cache.`);
  } else {
    logStatus(`Fetching matchup-adjusted projections for ${period.label}.`);
    rows = await fetchJson(
      `${API_PROJECTIONS_BASE}/${period.season}/${period.week}?season_type=regular`,
      `${period.label} projections`
    );
    savedAt = Date.now();
    await idbSet(cacheKey, { savedAt, rows }).catch(() => null);
    logStatus(`Fetched ${Array.isArray(rows) ? rows.length.toLocaleString() : 0} ${period.label} projection rows.`);
  }

  const usableRows = Array.isArray(rows) ? rows : [];
  state.weeklyProjections = new Map(usableRows
    .filter(row => row?.player_id)
    .map(row => [String(row.player_id), row]));
  rebuildWeeklySchedule(usableRows);
  state.weeklyProjectionMeta = {
    ...period,
    rows: usableRows.length,
    savedAt,
    source: usableRows.length ? 'weekly' : 'season-fallback'
  };
  state.weeklyProjectionError = '';
  return state.weeklyProjectionMeta;
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
  const exactLabel = state.playerSearch.find(p => p.label.toLowerCase() === value);
  if (exactLabel) return exactLabel;
  const exactNames = state.playerSearch
    .filter(p => p.name.toLowerCase() === value)
    .sort((a, b) => {
      const playerA = getPlayer(a.id) || {};
      const playerB = getPlayer(b.id) || {};
      return Number(playerB.active !== false) - Number(playerA.active !== false)
        || Number(Boolean(playerB.team)) - Number(Boolean(playerA.team))
        || safeNumber(playerA.search_rank, 999999) - safeNumber(playerB.search_rank, 999999);
    });
  if (exactNames.length) return exactNames[0];
  return state.playerSearch.find(p => p.search.includes(value));
}

function findExactPlayerFromInput(input) {
  const value = String(input || '').toLowerCase().trim();
  if (!value) return null;
  return state.playerSearch.find(player => player.label.toLowerCase() === value)
    || state.playerSearch.find(player => player.name.toLowerCase() === value)
    || null;
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

  const detailedDrafts = await Promise.all((drafts || []).map(async draft => {
    if (!draft?.draft_id) return draft;
    try {
      const detail = await fetchJson(`${API_BASE}/draft/${draft.draft_id}`, `draft ${draft.draft_id}`);
      return {
        ...draft,
        ...detail,
        settings: { ...(draft.settings || {}), ...(detail?.settings || {}) },
        metadata: { ...(draft.metadata || {}), ...(detail?.metadata || {}) }
      };
    } catch (err) {
      console.warn(err);
      return draft;
    }
  }));

  const draftPicks = [];
  for (const draft of detailedDrafts) {
    try {
      const picks = await fetchJson(`${API_BASE}/draft/${draft.draft_id}/picks`, `draft picks ${draft.draft_id}`);
      draftPicks.push(...(picks || []).map(pick => ({
        ...pick,
        season: pick?.season || draftSeasonNumber(draft, league)
      })));
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
    drafts: detailedDrafts,
    draftPicks,
    matchupsByWeek,
    transactionsByWeek,
    userMap: new Map((users || []).map(u => [u.user_id, u])),
    rosterMap: new Map((rosters || []).map(r => [Number(r.roster_id), r])),
    playerStats: new Map(),
    historicalStats: new Map(),
    historyLoadedSeasons: [],
    historyLoadError: '',
    projectionModel: null,
    valueCache: new Map(),
    teamStrength: new Map()
  };

  buildPlayerStats(enriched);
  await fetchHistoricalStatsForLeague(enriched);
  buildProjectionModel(enriched);
  buildTeamStrength(enriched);
  logStatus(`Loaded ${league.name}: ${Object.keys(matchupsByWeek).length} matchup weeks, ${Object.values(transactionsByWeek).flat().length} transactions, ${enriched.historyLoadedSeasons.length ? `${enriched.historyLoadedSeasons.join(', ')} historical stats` : 'no historical stats'}, ${roundNum((enriched.projectionModel?.coverage || 0) * 100, 0)}% roster projection coverage.`);
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
    const points = fantasyPointsFromStats(stats, league.scoring_settings || {}, playerPrimaryPosition(playerId));
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

function fantasyPointsFromStats(stats = {}, scoring = {}, position = 'UNK', options = {}) {
  let total = 0;
  for (const [key, value] of Object.entries(scoring || {})) {
    const multiplier = Number(value);
    if (!Number.isFinite(multiplier) || !Object.prototype.hasOwnProperty.call(stats, key)) continue;
    total += safeNumber(stats[key]) * multiplier;
  }

  const normalizedPosition = normalizePosition(position);
  if (normalizedPosition === 'TE' && !Object.prototype.hasOwnProperty.call(stats, 'bonus_rec_te')) {
    const teReceptionBonus = safeNumber(scoring.bonus_rec_te ?? scoring.rec_te, 0);
    total += safeNumber(stats.rec, 0) * teReceptionBonus;
  }

  // Per-game threshold bonuses are exact for weekly rows. A season projection cannot
  // reliably predict how often the threshold will be crossed, so it intentionally
  // excludes them instead of pretending a season total earned the bonus once.
  if (!options.seasonProjection) {
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

function clamp01(value) {
  return clampNumber(value, 0, 1);
}

function starterDemandPerRoster(league) {
  const demand = Object.fromEntries(POSITION_ORDER.map(pos => [pos, 0]));
  for (const slotValue of league?.roster_positions || []) {
    const slot = String(slotValue).toUpperCase();
    if (['BN', 'BE', 'IR', 'TAXI'].includes(slot)) continue;
    const normalized = normalizePosition(slot);
    if (POSITION_ORDER.includes(normalized)) {
      demand[normalized] += 1;
      continue;
    }
    if (slot === 'REC_FLEX') {
      demand.WR += 0.72;
      demand.TE += 0.28;
    } else if (FLEX_SLOTS.has(slot)) {
      demand.RB += 0.36;
      demand.WR += 0.49;
      demand.TE += 0.15;
    } else if (SUPER_FLEX_SLOTS.has(slot)) {
      demand.QB += 0.8;
      demand.RB += 0.08;
      demand.WR += 0.08;
      demand.TE += 0.04;
    } else if (IDP_FLEX_SLOTS.has(slot) || slot === 'IDP') {
      demand.DL += 0.3;
      demand.LB += 0.44;
      demand.DB += 0.26;
    }
  }
  return demand;
}

function projectionGames(stats = {}) {
  const games = safeNumber(stats.gp ?? stats.gms_active, 17);
  return clampNumber(games || 17, 1, 17);
}

function projectionEfficiencyMetric(stats = {}, position = 'UNK', points = 0, games = 17) {
  const pos = normalizePosition(position);
  const perGame = points / Math.max(1, games);
  let opportunity = 0;
  let score = 0.5;

  if (pos === 'QB') {
    const attempts = safeNumber(stats.pass_att);
    const rushAttempts = safeNumber(stats.rush_att);
    const ypa = attempts ? safeNumber(stats.pass_yd) / attempts : 0;
    const tdRate = attempts ? safeNumber(stats.pass_td) / attempts : 0;
    const intRate = attempts ? safeNumber(stats.pass_int) / attempts : 0.05;
    const rushYardsPerGame = safeNumber(stats.rush_yd) / Math.max(1, games);
    score = clamp01((ypa - 5.5) / 3.5) * 0.34
      + clamp01((tdRate - 0.025) / 0.05) * 0.26
      + (1 - clamp01((intRate - 0.01) / 0.04)) * 0.2
      + clamp01(rushYardsPerGame / 45) * 0.2;
    opportunity = attempts + rushAttempts;
    return { raw: score, reliability: clamp01(opportunity / 420), opportunity };
  }

  if (pos === 'RB') {
    const rushes = safeNumber(stats.rush_att);
    const receptions = safeNumber(stats.rec);
    const touches = rushes + receptions;
    const yardsPerTouch = touches ? (safeNumber(stats.rush_yd) + safeNumber(stats.rec_yd)) / touches : 0;
    const pointsPerTouch = touches ? points / touches : 0;
    const receivingShare = touches ? receptions / touches : 0;
    const touchdownRate = touches ? (safeNumber(stats.rush_td) + safeNumber(stats.rec_td)) / touches : 0;
    score = clamp01((yardsPerTouch - 3.2) / 3.2) * 0.34
      + clamp01((pointsPerTouch - 0.45) / 0.85) * 0.34
      + clamp01(receivingShare / 0.35) * 0.16
      + clamp01(touchdownRate / 0.07) * 0.16;
    opportunity = touches;
    return { raw: score, reliability: clamp01(opportunity / 220), opportunity };
  }

  if (pos === 'WR' || pos === 'TE') {
    const receptions = safeNumber(stats.rec);
    const reportedTargets = safeNumber(stats.rec_tgt ?? stats.targets);
    const targets = reportedTargets || (receptions ? receptions / (pos === 'TE' ? 0.67 : 0.64) : 0);
    const yardsPerTarget = targets ? safeNumber(stats.rec_yd) / targets : 0;
    const catchRate = reportedTargets && targets ? receptions / targets : (targets ? (pos === 'TE' ? 0.67 : 0.64) : 0);
    const pointsPerTarget = targets ? points / targets : 0;
    const touchdownRate = targets ? safeNumber(stats.rec_td) / targets : 0;
    score = clamp01((yardsPerTarget - 5) / 6.5) * 0.35
      + clamp01((catchRate - 0.45) / 0.38) * 0.2
      + clamp01((pointsPerTarget - 0.7) / 2) * 0.3
      + clamp01(touchdownRate / 0.11) * 0.15;
    opportunity = reportedTargets || receptions;
    return { raw: score, reliability: clamp01(opportunity / (pos === 'TE' ? 55 : 70)), opportunity };
  }

  if (['DL', 'LB', 'DB'].includes(pos)) {
    const tackles = safeNumber(stats.idp_tkl_solo) + safeNumber(stats.idp_tkl_ast);
    const impactPlays = safeNumber(stats.idp_sack) + safeNumber(stats.idp_int)
      + safeNumber(stats.idp_ff) + safeNumber(stats.idp_fum_rec) + safeNumber(stats.idp_pass_def) * 0.35;
    score = clamp01((tackles / Math.max(1, games) - 2) / 7) * 0.58
      + clamp01((impactPlays / Math.max(1, games)) / 1.4) * 0.27
      + clamp01(perGame / 18) * 0.15;
    opportunity = games;
    return { raw: score, reliability: clamp01(games / 12), opportunity };
  }

  return { raw: 0.5, reliability: points ? 0.55 : 0, opportunity: games };
}

function percentileOf(value, values = []) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length || !Number.isFinite(value)) return 0.5;
  const below = sorted.filter(item => item < value).length;
  const equal = sorted.filter(item => item === value).length;
  return clamp01((below + equal * 0.5) / sorted.length);
}

function buildProjectionModel(league) {
  const players = new Map();
  const pools = Object.fromEntries(POSITION_ORDER.map(pos => [pos, []]));
  const rostered = new Set(rosteredPlayerIds(league));
  const activePositions = activeLeaguePositions(league);

  for (const [playerId, row] of state.projections.entries()) {
    const player = getPlayer(playerId);
    const position = playerPrimaryPosition(playerId);
    if (!POSITION_ORDER.includes(position) || !activePositions.has(position)) continue;
    if (player?.active === false && !rostered.has(playerId)) continue;
    if (!player?.team && !rostered.has(playerId) && position !== 'DEF') continue;
    const stats = row?.stats || {};
    const games = projectionGames(stats);
    const points = fantasyPointsFromStats(stats, league.scoring_settings || {}, position, { seasonProjection: true });
    if (!Number.isFinite(points) || points <= 0) continue;
    const ppg = points / games;
    const efficiency = projectionEfficiencyMetric(stats, position, points, games);
    const detail = {
      playerId: String(playerId), position, season: state.projectionSeason,
      points: roundNum(points, 2), games, ppg: roundNum(ppg, 3),
      efficiencyRaw: efficiency.raw, efficiencyReliability: efficiency.reliability,
      opportunity: efficiency.opportunity, stats, row
    };
    players.set(String(playerId), detail);
    pools[position].push(detail);
  }

  const teamCount = Math.max(1, safeNumber(league.total_rosters, league.rosters?.length || 1));
  const perRosterDemand = starterDemandPerRoster(league);
  const replacementByPosition = {};
  const demandByPosition = {};

  for (const position of POSITION_ORDER) {
    const pool = pools[position].sort((a, b) => b.ppg - a.ppg);
    const demand = Math.max(0, Math.round(teamCount * safeNumber(perRosterDemand[position])));
    demandByPosition[position] = demand;
    const replacementIndex = pool.length ? clampNumber(Math.max(1, Math.ceil(demand * 1.08)) - 1, 0, pool.length - 1) : 0;
    const replacement = pool[replacementIndex]?.ppg || 0;
    replacementByPosition[position] = roundNum(replacement, 3);
    const efficiencyValues = pool.map(item => item.efficiencyRaw);

    pool.forEach((item, index) => {
      item.positionRank = index + 1;
      item.positionPool = pool.length;
      item.percentile = pool.length === 1 ? 1 : 1 - index / (pool.length - 1);
      item.efficiencyPercentile = percentileOf(item.efficiencyRaw, efficiencyValues);
      item.replacementPpg = replacement;
      item.vorp = roundNum(item.ppg - replacement, 3);
      item.starterDemand = demand;
    });
  }

  const eligibleRostered = [...rostered].filter(playerId => activePositions.has(playerPrimaryPosition(playerId)));
  const projectedRostered = eligibleRostered.filter(playerId => players.has(playerId));
  league.projectionModel = {
    season: state.projectionSeason,
    players,
    replacementByPosition,
    demandByPosition,
    coverage: eligibleRostered.length ? projectedRostered.length / eligibleRostered.length : 0
  };
  league.valueCache?.clear();
  return league.projectionModel;
}

function productionPpgSignal(league, playerId) {
  const rec = productionRecord(league, playerId);
  return recordHasGames(rec) ? { ppg: safeNumber(rec.ppg), games: safeNumber(rec.games), rec } : null;
}

function forecastForPlayer(league, playerId) {
  const projection = league.projectionModel?.players?.get(String(playerId)) || null;
  const production = productionPpgSignal(league, playerId);
  if (!projection && !production) {
    return { ppg: 0, projection, production, confidence: 0.15, projectionShare: 0 };
  }
  if (!projection) {
    return { ppg: production.ppg, projection, production, confidence: clampNumber(0.35 + production.games / 40, 0.35, 0.7), projectionShare: 0 };
  }
  if (!production) {
    return { ppg: projection.ppg, projection, production, confidence: 0.7, projectionShare: 1 };
  }

  const currentWeeks = safeNumber(league.playerStats?.get(String(playerId))?.games, 0);
  const baseProjectionWeight = currentWeeks >= 8 ? 0.5 : currentWeeks >= 4 ? 0.58 : 0.72;
  const projectionWeight = baseProjectionWeight * clampNumber(state.settings.projectionWeight, 0, 2);
  const productionWeight = (1 - baseProjectionWeight) * clampNumber(state.settings.recentWeight, 0, 2);
  const totalWeight = projectionWeight + productionWeight || 1;
  const projectionShare = projectionWeight / totalWeight;
  const ppg = projection.ppg * projectionShare + production.ppg * (1 - projectionShare);
  const sampleConfidence = clamp01(production.games / 12);
  return {
    ppg: roundNum(ppg, 3), projection, production,
    confidence: clampNumber(0.62 + sampleConfidence * 0.25, 0.62, 0.9),
    projectionShare
  };
}

function projectionIntrinsicValue(league, playerId, forecast = forecastForPlayer(league, playerId)) {
  const position = playerPrimaryPosition(playerId);
  const projection = forecast.projection;
  const replacement = projection?.replacementPpg ?? league.projectionModel?.replacementByPosition?.[position] ?? 0;
  const demand = Math.max(1, projection?.starterDemand || league.projectionModel?.demandByPosition?.[position] || 1);
  const rank = projection?.positionRank || demand + 1;
  const starterStrength = clamp01((demand + 1 - rank) / demand);
  const percentile = projection?.percentile ?? positionPercentile(league, playerId);
  const vorp = Math.max(0, forecast.ppg - replacement);
  const scales = { QB: 300, RB: 340, WR: 320, TE: 380, DL: 220, LB: 220, DB: 210, K: 90, DEF: 90 };
  const value = 200 + starterStrength * 4300 + vorp * (scales[position] || 220) + Math.pow(clamp01(percentile), 4) * 900;
  return roundNum(clampNumber(value, 60, 9600), 0);
}

function positionPercentile(league, playerId) {
  const projection = league.projectionModel?.players?.get(String(playerId));
  if (projection) return projection.percentile;
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

function clampNumber(value, min, max) {
  const num = safeNumber(value, 0);
  return Math.min(max, Math.max(min, num));
}

function marketValueFromRank(rank) {
  const valueRank = clampNumber(rank, MARKET_VALUE_CURVE[0][0], MARKET_VALUE_CURVE.at(-1)[0]);
  for (let index = 1; index < MARKET_VALUE_CURVE.length; index += 1) {
    const [rightRank, rightValue] = MARKET_VALUE_CURVE[index];
    const [leftRank, leftValue] = MARKET_VALUE_CURVE[index - 1];
    if (valueRank <= rightRank) {
      const progress = (valueRank - leftRank) / Math.max(1, rightRank - leftRank);
      return roundNum(leftValue + (rightValue - leftValue) * progress, 0);
    }
  }
  return MARKET_VALUE_CURVE.at(-1)[1];
}

function scoringAdpSuffix(league) {
  const receptions = safeNumber(league?.scoring_settings?.rec, 0);
  if (receptions >= 0.75) return 'ppr';
  if (receptions >= 0.25) return 'half_ppr';
  return 'std';
}

function validAdp(value) {
  const adp = Number(value);
  return Number.isFinite(adp) && adp > 0 && adp < 900;
}

function marketSignalForPlayer(league, playerId) {
  const player = getPlayer(playerId) || {};
  const position = playerPrimaryPosition(playerId);
  const stats = state.projections.get(String(playerId))?.stats || {};
  const dynasty = isDynastyLeague(league);
  const superflex = isSuperflexLeague(league);
  const suffix = scoringAdpSuffix(league);
  let keys;

  if (['DL', 'LB', 'DB'].includes(position)) {
    keys = superflex
      ? ['adp_idp', 'adp_dynasty_2qb', `adp_dynasty_${suffix}`]
      : ['adp_idp_1qb', 'adp_idp', `adp_dynasty_${suffix}`];
  } else if (dynasty) {
    keys = superflex
      ? ['adp_dynasty_2qb', `adp_dynasty_${suffix}`, 'adp_dynasty']
      : [`adp_dynasty_${suffix}`, 'adp_dynasty', 'adp_dynasty_2qb'];
  } else {
    keys = superflex ? ['adp_2qb', `adp_${suffix}`] : [`adp_${suffix}`, 'adp_half_ppr', 'adp_std'];
  }

  const selectedKey = keys.find(key => validAdp(stats[key]));
  if (selectedKey) {
    const adp = safeNumber(stats[selectedKey]);
    return {
      value: marketValueFromRank(adp), adp, key: selectedKey,
      source: selectedKey.replaceAll('_', ' ').toUpperCase(), reliability: 0.9,
      isDynastyAdp: selectedKey.includes('dynasty')
    };
  }

  const searchRank = safeNumber(player.search_rank, 9999);
  if (searchRank > 0 && searchRank < 1000) {
    return {
      value: marketValueFromRank(searchRank), adp: searchRank, key: 'search_rank',
      source: 'Sleeper search rank fallback', reliability: 0.48, isDynastyAdp: false
    };
  }

  return { value: 0, adp: null, key: '', source: 'No market rank', reliability: 0.2, isDynastyAdp: false };
}

function ageCurveProfile(player, league) {
  const pos = normalizePosition(player?.position || 'UNK');
  const curve = POSITION_AGE_CURVES[pos] || POSITION_AGE_CURVES.UNK;
  const age = safeNumber(player?.age, 0);
  const applicable = isDynastyLeague(league) && pos !== 'DEF';
  if (!applicable || !age) {
    return {
      adjustment: 0,
      stage: 'unknown',
      yearsToRetirement: null,
      retirementAge: applicable ? curve.retirement : null,
      age: age || null,
      position: pos,
      applicable,
      curve
    };
  }

  const yearsToRetirement = Math.max(0, roundNum(curve.retirement - age, 1));
  let adjustment = 0;
  let stage = 'prime';

  if (age < curve.primeStart) {
    const runway = curve.primeStart - age;
    const productionProof = 1 + Math.min(0.28, safeNumber(player.search_rank, 9999) <= 150 ? 0.16 : 0);
    adjustment = curve.youngBonus + runway * 80;
    adjustment *= productionProof;
    stage = 'ascending';
  } else if (age <= curve.primeEnd) {
    adjustment = curve.primeBonus;
    stage = 'prime';
  } else if (age < curve.declineStart) {
    const drift = age - curve.primeEnd;
    adjustment = Math.max(-180, curve.primeBonus - drift * 180);
    stage = 'late-prime';
  } else if (age < curve.retirement) {
    const declineWindow = Math.max(1, curve.retirement - curve.declineStart);
    const declinePct = clampNumber((age - curve.declineStart) / declineWindow, 0, 1);
    adjustment = curve.maxPenalty * declinePct;
    stage = 'decline';
  } else {
    adjustment = curve.maxPenalty;
    stage = 'cliff-risk';
  }

  // Position-specific dynasty guardrails. RBs fall off fastest, QBs retain value longest.
  if (pos === 'RB' && age >= 27) adjustment -= (age - 26) * 220;
  if (pos === 'WR' && age >= 30) adjustment -= (age - 29) * 140;
  if (pos === 'TE' && age >= 32) adjustment -= (age - 31) * 120;
  if (pos === 'QB' && age <= 25) adjustment += 180;
  if (pos === 'QB' && age >= 35) adjustment -= (age - 34) * 220;

  return {
    adjustment: roundNum(adjustment * state.settings.ageWeight, 0),
    stage,
    yearsToRetirement,
    retirementAge: curve.retirement,
    age,
    position: pos,
    applicable: true,
    curve
  };
}

function ageStageLabel(stage) {
  return AGE_STAGE_LABELS[stage] || AGE_STAGE_LABELS.unknown;
}

function retirementHorizonLabel(profile, { compact = false } = {}) {
  if (!profile?.applicable) return '';
  if (!profile.age || profile.yearsToRetirement === null) return compact ? 'Age unavailable' : 'Age and horizon unavailable';
  if (profile.yearsToRetirement <= 0) {
    return compact
      ? `At ${profile.position} horizon`
      : `At or beyond the estimated ${profile.position} horizon (age ${profile.retirementAge})`;
  }
  const years = displayNumber(profile.yearsToRetirement, 1);
  return compact
    ? `~${years}y to ${profile.position} horizon`
    : `~${years} ${Number(profile.yearsToRetirement) === 1 ? 'year' : 'years'} to the estimated ${profile.position} horizon (age ${profile.retirementAge})`;
}

function dynastyAgeSummary(league, playerOrId, { compact = true, includeStage = false } = {}) {
  if (!isDynastyLeague(league)) return '';
  const player = typeof playerOrId === 'object' ? playerOrId : (getPlayer(playerOrId) || {});
  const profile = ageCurveProfile(player, league);
  if (!profile.applicable) return '';
  if (!profile.age) return 'Age unavailable';
  const pieces = [`Age ${displayNumber(profile.age, 1)}`];
  if (includeStage) pieces.push(ageStageLabel(profile.stage));
  pieces.push(retirementHorizonLabel(profile, { compact }));
  return pieces.filter(Boolean).join(compact ? ' • ' : ' · ');
}

function statusValueAdjustment(baseValue, player, league) {
  const status = String(player?.injury_status || player?.status || '').toLowerCase();
  if (!status) return 0;
  let multiplier = 1;
  const dynasty = isDynastyLeague(league);
  if (['ir', 'out', 'pup'].some(term => status.includes(term))) multiplier = dynasty ? 0.94 : 0.82;
  else if (status.includes('suspended')) multiplier = dynasty ? 0.92 : 0.78;
  else if (status.includes('doubtful')) multiplier = dynasty ? 0.98 : 0.9;
  else if (status.includes('questionable')) multiplier = dynasty ? 0.995 : 0.97;
  else if (status.includes('inactive')) multiplier = dynasty ? 0.97 : 0.9;
  return roundNum(baseValue * (multiplier - 1), 0);
}

function valueConfidenceLabel(score) {
  if (score >= 0.78) return 'High';
  if (score >= 0.55) return 'Medium';
  return 'Low';
}

function playerValue(league, playerId) {
  const key = String(playerId);
  if (league.valueCache.has(key)) return league.valueCache.get(key);
  const player = getPlayer(key) || {};
  const rec = productionRecord(league, key);
  const forecast = forecastForPlayer(league, key);
  const projection = forecast.projection;
  const percentile = positionPercentile(league, key);
  const pos = playerPrimaryPosition(key);
  const market = marketSignalForPlayer(league, key);
  const intrinsic = projectionIntrinsicValue(league, key, forecast);
  const hasFormatAdp = market.key.startsWith('adp_');
  const baseIntrinsicWeight = hasFormatAdp ? (isDynastyLeague(league) ? 0.26 : 0.48) : (market.value ? 0.58 : 1);
  const intrinsicWeight = market.value
    ? clampNumber(baseIntrinsicWeight * clampNumber(state.settings.projectionWeight, 0, 2), 0, 0.78)
    : 1;
  const marketWeight = market.value ? 1 - intrinsicWeight : 0;
  let raw = market.value * marketWeight + intrinsic * intrinsicWeight;

  const efficiencyCentered = projection ? (projection.efficiencyPercentile - 0.5) * 2 : 0;
  const efficiencyAdj = efficiencyCentered * (isDynastyLeague(league) ? 300 : 450)
    * safeNumber(projection?.efficiencyReliability, 0) * clampNumber(state.settings.efficiencyWeight, 0, 2);
  const recentAdj = rec?.games >= 4
    ? clampNumber((safeNumber(rec.last4Avg, rec.ppg) - safeNumber(rec.ppg)) * 42, -220, 220) * clampNumber(state.settings.recentWeight, 0, 2)
    : 0;
  const ageProfile = ageCurveProfile(player, league);
  const ageScale = market.isDynastyAdp ? 0.16 : 0.48;
  const ageAdj = ageProfile.adjustment * ageScale;
  raw += efficiencyAdj + recentAdj + ageAdj;
  const statusAdj = statusValueAdjustment(raw, player, league);
  raw += statusAdj;

  if (market.value) {
    raw = clampNumber(raw, Math.max(30, market.value * 0.68), Math.min(9999, market.value * 1.32));
  }
  if (POSITION_VALUE_CAPS[pos]) raw = Math.min(raw, POSITION_VALUE_CAPS[pos]);
  const value = Math.max(1, roundNum(clampNumber(raw, 1, 9999), 0));
  const dataConfidence = clampNumber(
    market.reliability * 0.48 + forecast.confidence * 0.37 + clamp01(safeNumber(rec?.games) / 12) * 0.15,
    0.1,
    0.96
  );
  const replacementPpg = projection?.replacementPpg ?? league.projectionModel?.replacementByPosition?.[pos] ?? 0;
  const components = {
    marketAnchor: roundNum(market.value, 0),
    marketWeight: roundNum(marketWeight * 100, 0),
    marketAdp: market.adp,
    marketSource: market.source,
    projectionValue: intrinsic,
    projectionWeight: roundNum(intrinsicWeight * 100, 0),
    projectedPpg: roundNum(projection?.ppg || 0, 1),
    forecastPpg: roundNum(forecast.ppg, 1),
    replacementPpg: roundNum(replacementPpg, 1),
    vorp: roundNum(forecast.ppg - replacementPpg, 1),
    efficiencyAdj: roundNum(efficiencyAdj, 0),
    recentAdj: roundNum(recentAdj, 0),
    dynastyAdj: roundNum(ageAdj, 0),
    dynastyAgeAdjustment: roundNum(ageAdj, 0),
    ageStage: ageProfile.stage,
    yearsToRetirement: ageProfile.yearsToRetirement,
    retirementHorizonYears: ageProfile.yearsToRetirement,
    expectedPositionRetirement: ageProfile.retirementAge,
    retirementHorizonAge: ageProfile.retirementAge,
    ageApplicable: ageProfile.applicable,
    statusAdj: roundNum(statusAdj, 0),
    confidence: roundNum(dataConfidence * 100, 0)
  };
  const detail = {
    value,
    ppg: roundNum(rec?.ppg || 0, 1),
    projectedPpg: roundNum(projection?.ppg || 0, 1),
    forecastPpg: roundNum(forecast.ppg, 1),
    replacementPpg: roundNum(replacementPpg, 1),
    vorp: roundNum(forecast.ppg - replacementPpg, 1),
    efficiency: roundNum((projection?.efficiencyPercentile ?? 0.5) * 100, 0),
    projectionRank: projection?.positionRank || null,
    last4: roundNum(rec?.last4Avg || 0, 1),
    starts: rec?.starts || 0,
    games: rec?.games || 0,
    percentile: roundNum(percentile * 100, 0),
    age: isDynastyLeague(league) ? (player?.age || '') : '',
    position: pos,
    status: player?.injury_status || player?.status || '',
    name: playerName(key),
    playerId: key,
    source: `${market.source}; ${projection ? `${state.projectionSeason} projection` : 'no projection'}; ${rec?.source || 'no production sample'}`,
    valueModel: 'format ADP + league VORP',
    searchRank: player?.search_rank || '',
    marketAdp: market.adp,
    marketSource: market.source,
    confidence: valueConfidenceLabel(dataConfidence),
    confidenceScore: roundNum(dataConfidence * 100, 0),
    components
  };
  league.valueCache.set(key, detail);
  return detail;
}

function buildTeamStrength(league) {
  league.teamStrength.clear();
  for (const roster of league.rosters || []) {
    const playerIds = (roster.players || []).map(String);
    const playerValues = playerIds.map(pid => playerValue(league, pid)).sort((a, b) => b.value - a.value);
    const coreLimit = Math.max(12, (league.roster_positions || []).filter(slot => !['BN', 'BE', 'IR', 'TAXI'].includes(String(slot).toUpperCase())).length + 6);
    const rosterValue = playerValues.slice(0, coreLimit).reduce((sum, detail) => sum + detail.value, 0);
    const lineup = optimalProjectedLineupScore(league, playerIds);
    const startersValue = lineup.selected.reduce((sum, pid) => sum + playerValue(league, pid).value, 0);
    const wins = safeNumber(roster.settings?.wins);
    const losses = safeNumber(roster.settings?.losses);
    const fpts = totalFpts(roster.settings);
    const maxpf = safeNumber(roster.settings?.ppts) + safeNumber(roster.settings?.ppts_decimal) / 100;
    const score = lineup.total * 220 + startersValue * 0.24 + rosterValue * 0.18 + fpts * 1.2 + maxpf * 1.5 + wins * 180 - losses * 70;
    league.teamStrength.set(Number(roster.roster_id), {
      score, rosterValue, startersValue, projectedLineupPpg: roundNum(lineup.total, 1),
      wins, losses, fpts, maxpf
    });
  }
}

function interpolatePickBand(band, strengthRank) {
  const rank = clamp01(strengthRank);
  if (rank <= 0.5) return band.early + (band.mid - band.early) * (rank / 0.5);
  return band.mid + (band.late - band.mid) * ((rank - 0.5) / 0.5);
}

function draftPickPositionForAsset(league, pick = {}) {
  const season = Number(pick.season);
  const round = Number(pick.round);
  const originalRosterId = Number(
    pick.roster_id || pick.originalRosterId || pick.original_roster_id || pick.ownerRosterId || pick.owner_id
  );
  if (!league || !season || !round || !originalRosterId) return null;

  const row = draftSelectionRows(league, season).find(candidate => (
    Number(candidate.round) === round && Number(candidate.originalRosterId) === originalRosterId
  ));
  if (!row) return null;

  return {
    exact: Boolean(row.exact),
    pickLabel: row.pickLabel,
    roundPick: Number(row.roundPick),
    overallPick: Number(row.overallPick),
    teamCount: Math.max(1, safeNumber(league.total_rosters, league.rosters?.length || 1))
  };
}

function pickValue(league, pick) {
  const currentSeason = activeValuationSeason(league);
  const season = Number(pick.season || currentSeason + 1);
  const round = Number(pick.round || 1);
  const original = Number(pick.roster_id || pick.originalRosterId || pick.original_roster_id || pick.ownerRosterId || pick.owner_id);
  const strengthRank = teamStrengthRank(league, original);
  const resolvedPosition = draftPickPositionForAsset(league, { season, round, originalRosterId: original });
  const teamCount = Math.max(1, safeNumber(league.total_rosters, league.rosters?.length || 1));
  const positionRank = resolvedPosition?.exact
    ? (teamCount === 1 ? 0.5 : clamp01((resolvedPosition.roundPick - 1) / (teamCount - 1)))
    : strengthRank;
  const band = PICK_VALUE_BANDS[round] || { early: 80, mid: 45, late: 25 };
  const base = interpolatePickBand(band, positionRank);
  const yearsOut = Math.max(0, season - currentSeason);
  const timeFactors = [1, 0.9, 0.78, 0.68];
  const timeFactor = timeFactors[yearsOut] ?? Math.max(0.52, 0.68 - (yearsOut - 3) * 0.08);
  const formatFactor = round === 1 && !isSuperflexLeague(league) ? 0.96 : 1;
  const value = roundNum(base * timeFactor * formatFactor * state.settings.pickWeight, 0);
  const expectedSlot = resolvedPosition?.roundPick || roundNum(1 + strengthRank * Math.max(0, teamCount - 1), 1);
  const fallbackPickLabel = `${round}.${String(Math.max(1, Math.round(expectedSlot))).padStart(2, '0')}`;
  const pickLabel = resolvedPosition?.pickLabel || fallbackPickLabel;
  const exact = Boolean(resolvedPosition?.exact);
  const range = positionRank <= 0.33 ? 'early' : positionRank >= 0.67 ? 'late' : 'mid';
  const timingDetail = yearsOut ? `${yearsOut}-year discount applied` : 'current class';
  return {
    value,
    label: exact
      ? `${season} Pick ${pickLabel} (${teamName(league, original)} original pick)`
      : `${season} Round ${round} (${teamName(league, original)} original pick)`,
    detail: exact
      ? `Exact draft position ${pickLabel}; ${timingDetail}`
      : `projected ${range} (about ${pickLabel}); ${timingDetail}`,
    confidence: exact ? 'High' : league.teamStrength?.has(original) ? 'Medium' : 'Low',
    confidenceScore: exact ? 90 : league.teamStrength?.has(original) ? 62 : 45,
    exact,
    pickLabel,
    positionLabel: `${exact ? '' : '~'}${pickLabel}`,
    expectedSlot,
    range
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

function adjustPackageValues(entries = []) {
  const sorted = entries.slice().sort((a, b) => b.value - a.value);
  if (!sorted.length) return { raw: 0, adjusted: 0, adjustment: 0, premium: 0, entries: [], confidence: 0 };
  const raw = sorted.reduce((sum, entry) => sum + entry.value, 0);
  const topValue = sorted[0].value;
  const adjustedEntries = sorted.map((entry, index) => {
    if (!index) return { ...entry, packageFactor: 1, packageValue: entry.value };
    const relativeValue = clamp01(entry.value / Math.max(1, topValue));
    let discount = Math.min(0.16, index * 0.028 + (entry.value < 2000 ? 0.045 : 0));
    discount *= 1 - relativeValue * 0.58;
    if (entry.type === 'pick') discount = Math.max(0, discount - 0.025);
    const factor = 1 - discount;
    return { ...entry, packageFactor: factor, packageValue: entry.value * factor };
  });
  const top = sorted[0];
  let premiumRate = top.value >= 9000 ? 0.055 : top.value >= 7500 ? 0.035 : top.value >= 6000 ? 0.018 : 0;
  if (top.type === 'pick') premiumRate *= 0.4;
  const premium = top.value * premiumRate;
  const adjusted = adjustedEntries.reduce((sum, entry) => sum + entry.packageValue, 0) + premium;
  const confidence = sorted.reduce((sum, entry) => sum + safeNumber(entry.confidenceScore, 60) * entry.value, 0) / Math.max(1, raw);
  return {
    raw: roundNum(raw, 0), adjusted: roundNum(adjusted, 0),
    adjustment: roundNum(adjusted - raw, 0), premium: roundNum(premium, 0),
    entries: adjustedEntries, confidence: roundNum(confidence, 0)
  };
}

function packageValuation(league, assets = []) {
  const entries = assets.map(asset => {
    const detail = assetValue(league, asset);
    return {
      asset, type: asset.type, value: safeNumber(detail.value), detail,
      confidenceScore: asset.type === 'player' ? safeNumber(detail.confidenceScore, 50) : safeNumber(detail.confidenceScore, 62)
    };
  });
  return adjustPackageValues(entries);
}

function slotEligibility(slot, playerId) {
  const s = String(slot).toUpperCase();
  const positions = new Set(playerFantasyPositions(playerId));
  const normalizedSlot = normalizePosition(s);
  if (positions.has(s) || positions.has(normalizedSlot)) return true;
  if (s === 'REC_FLEX') return ['WR', 'TE'].some(pos => positions.has(pos));
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

function optimalProjectedLineupScore(league, playerIds = []) {
  const starterSlots = (league.roster_positions || [])
    .filter(slot => !['BN', 'BE', 'IR', 'TAXI'].includes(String(slot).toUpperCase()))
    .sort((a, b) => slotRestrictiveness(a) - slotRestrictiveness(b));
  const available = [...new Set((playerIds || []).map(String))];
  const selected = [];
  const bySlot = [];
  let total = 0;

  for (const slot of starterSlots) {
    const candidates = available
      .filter(playerId => !selected.includes(playerId) && slotEligibility(slot, playerId))
      .map(playerId => ({ playerId, forecast: forecastForPlayer(league, playerId) }))
      .sort((a, b) => b.forecast.ppg - a.forecast.ppg);
    if (!candidates.length) {
      bySlot.push({ slot, playerId: null, ppg: 0 });
      continue;
    }
    const chosen = candidates[0];
    selected.push(chosen.playerId);
    total += chosen.forecast.ppg;
    bySlot.push({ slot, playerId: chosen.playerId, ppg: chosen.forecast.ppg });
  }
  return { total: roundNum(total, 3), selected, bySlot };
}

function isLineupUnavailableStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized === 'out'
    || normalized === 'inactive'
    || normalized === 'suspended'
    || normalized === 'pup'
    || normalized === 'nfi'
    || normalized === 'ir'
    || normalized.startsWith('ir-')
    || normalized.includes('injured reserve');
}

function matchupProjectionLabel({ source, opponent, unavailableReason, delta = 0, baselinePpg = 0 }) {
  if (unavailableReason) return { label: unavailableReason, tone: 'bad' };
  if (source !== 'weekly') return { label: 'Season baseline', tone: 'neutral' };
  if (!opponent) return { label: 'Matchup pending', tone: 'neutral' };
  const impact = delta / Math.max(5, baselinePpg);
  if (delta >= 2.5 || impact >= 0.14) return { label: 'Strong matchup boost', tone: 'good' };
  if (delta >= 0.8 || impact >= 0.06) return { label: 'Favorable matchup', tone: 'good' };
  if (delta <= -2.5 || impact <= -0.14) return { label: 'Tough matchup', tone: 'bad' };
  if (delta <= -0.8 || impact <= -0.06) return { label: 'Slight matchup fade', tone: 'warn' };
  return { label: 'Neutral matchup', tone: 'neutral' };
}

function weeklyProjectionForPlayer(league, playerId, options = {}) {
  const pid = String(playerId);
  const player = getPlayer(pid) || {};
  const period = upcomingLineupPeriod();
  const meta = state.weeklyProjectionMeta;
  const weeklyDataMatches = Boolean(
    meta
    && Number(meta.season) === Number(period.season)
    && Number(meta.week) === Number(period.week)
  );
  const row = weeklyDataMatches ? state.weeklyProjections.get(pid) : null;
  const team = String(row?.team || row?.player?.team || player.team || '').toUpperCase();
  const opponent = String(row?.opponent || row?.opp || state.weeklySchedule.get(team) || '').toUpperCase();
  const status = row?.status || row?.player?.injury_status || player.injury_status || player.status || '';
  const forecast = forecastForPlayer(league, pid);
  const baselinePpg = Math.max(0, safeNumber(forecast.ppg, 0));
  const scheduleReady = weeklyDataMatches && safeNumber(meta?.rows, 0) > 100 && state.weeklySchedule.size >= 20;
  const onBye = Boolean(scheduleReady && team && !state.weeklySchedule.has(team));

  let unavailableReason = '';
  if (options.isTaxi) unavailableReason = 'Taxi squad';
  else if (options.isReserve) unavailableReason = 'IR/reserve';
  else if (onBye) unavailableReason = 'Bye week';
  else if (isLineupUnavailableStatus(status)) unavailableReason = String(status || 'Unavailable');
  else if (player.active === false) unavailableReason = 'Inactive';
  else if (!team && playerPrimaryPosition(pid) !== 'DEF') unavailableReason = 'No NFL team';

  const weeklyPoints = row
    ? fantasyPointsFromStats(row.stats || {}, league?.scoring_settings || {}, playerPrimaryPosition(pid))
    : null;
  const source = row ? 'weekly' : 'season-fallback';
  const points = unavailableReason
    ? 0
    : row
      ? safeNumber(weeklyPoints, 0)
      : baselinePpg;
  const delta = row && !unavailableReason ? points - baselinePpg : 0;
  const matchup = matchupProjectionLabel({ source, opponent, unavailableReason, delta, baselinePpg });
  const injuryConcern = /questionable|doubtful|limited/i.test(String(status));
  const confidence = unavailableReason
    ? 1
    : row
      ? (injuryConcern ? 0.72 : 0.9)
      : clampNumber(safeNumber(forecast.confidence, 0.5) * 0.72, 0.25, 0.68);

  return {
    playerId: pid,
    name: playerName(pid),
    position: playerPrimaryPosition(pid),
    team: team || 'FA',
    opponent,
    points: roundNum(points, 2),
    baselinePpg: roundNum(baselinePpg, 2),
    matchupDelta: roundNum(delta, 2),
    matchupLabel: matchup.label,
    matchupTone: matchup.tone,
    source,
    status: String(status || ''),
    injuryConcern,
    confidence: roundNum(confidence * 100, 0),
    available: !unavailableReason,
    unavailableReason,
    onBye,
    row
  };
}

function optimizeLineupAssignments(league, candidates = []) {
  const slots = (league?.roster_positions || [])
    .map((slot, index) => ({ slot: String(slot).toUpperCase(), index }))
    .filter(({ slot }) => !['BN', 'BE', 'IR', 'TAXI'].includes(slot));
  const usable = (candidates || [])
    .filter(candidate => candidate?.available)
    .filter(candidate => slots.some(({ slot }) => slotEligibility(slot, candidate.playerId)));

  if (!slots.length) return { total: 0, selected: [], bySlot: [], filled: 0 };

  if (slots.length > 16) {
    const orderedSlots = slots.slice().sort((a, b) => slotRestrictiveness(a.slot) - slotRestrictiveness(b.slot) || a.index - b.index);
    const selected = new Set();
    const assignments = new Map();
    for (const slot of orderedSlots) {
      const chosen = usable
        .filter(candidate => !selected.has(candidate.playerId) && slotEligibility(slot.slot, candidate.playerId))
        .sort((a, b) => b.points - a.points || b.confidence - a.confidence)[0];
      if (chosen) {
        selected.add(chosen.playerId);
        assignments.set(slot.index, chosen);
      }
    }
    const bySlot = slots.map(slot => ({ ...slot, detail: assignments.get(slot.index) || null }));
    return {
      total: roundNum(bySlot.reduce((sum, row) => sum + safeNumber(row.detail?.points), 0), 2),
      selected: [...selected],
      bySlot,
      filled: selected.size
    };
  }

  let states = new Map([[0, {
    score: 0,
    quality: 0,
    assignments: Array(slots.length).fill(null)
  }]]);

  for (const candidate of usable) {
    const snapshot = [...states.entries()];
    for (const [mask, current] of snapshot) {
      for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
        const bit = 1 << slotIndex;
        if ((mask & bit) || !slotEligibility(slots[slotIndex].slot, candidate.playerId)) continue;
        const nextMask = mask | bit;
        const score = current.score + safeNumber(candidate.points, 0);
        const slotSpecificity = Math.max(1, 12 - slotRestrictiveness(slots[slotIndex].slot));
        const quality = current.quality
          + safeNumber(candidate.points, 0) * slotSpecificity
          + safeNumber(candidate.confidence, 0) * 0.01;
        const existing = states.get(nextMask);
        if (existing && (existing.score > score + 0.0001 || (Math.abs(existing.score - score) <= 0.0001 && existing.quality >= quality))) continue;
        const assignments = current.assignments.slice();
        assignments[slotIndex] = candidate;
        states.set(nextMask, { score, quality, assignments });
      }
    }
  }

  let bestMask = 0;
  let best = states.get(0);
  for (const [mask, candidate] of states.entries()) {
    const filled = candidate.assignments.filter(Boolean).length;
    const bestFilled = best.assignments.filter(Boolean).length;
    if (filled > bestFilled
      || (filled === bestFilled && candidate.score > best.score + 0.0001)
      || (filled === bestFilled && Math.abs(candidate.score - best.score) <= 0.0001 && candidate.quality > best.quality)) {
      bestMask = mask;
      best = candidate;
    }
  }

  const bySlot = slots.map((slot, index) => ({ ...slot, detail: best.assignments[index] || null }));
  const selected = best.assignments.filter(Boolean).map(detail => detail.playerId);
  return {
    total: roundNum(best.score, 2),
    selected,
    bySlot,
    filled: best.assignments.filter(Boolean).length,
    mask: bestMask
  };
}

function recommendedLineupForRoster(league, rosterId) {
  const roster = league?.rosterMap?.get(Number(rosterId));
  const period = upcomingLineupPeriod();
  if (!league || !roster) {
    return {
      period, total: 0, baselineTotal: 0, matchupDelta: 0,
      starters: [], bench: [], unavailable: [], emptySlots: [],
      startIds: [], sitIds: [], weeklyCoverage: 0, confidence: 'Unavailable'
    };
  }

  const taxi = new Set((roster.taxi || []).map(String));
  const reserve = new Set((roster.reserve || []).map(String));
  const candidates = [...new Set((roster.players || []).map(String))]
    .map(playerId => weeklyProjectionForPlayer(league, playerId, {
      isTaxi: taxi.has(playerId),
      isReserve: reserve.has(playerId)
    }));
  const optimized = optimizeLineupAssignments(league, candidates);
  const starters = optimized.bySlot.map(row => ({
    slot: row.slot,
    slotIndex: row.index,
    detail: row.detail
  }));
  const selected = new Set(optimized.selected);
  const bench = candidates
    .filter(detail => detail.available && !selected.has(detail.playerId))
    .sort((a, b) => b.points - a.points || b.baselinePpg - a.baselinePpg);
  const unavailable = candidates
    .filter(detail => !detail.available)
    .sort((a, b) => a.unavailableReason.localeCompare(b.unavailableReason) || a.name.localeCompare(b.name));
  const filledStarters = starters.map(row => row.detail).filter(Boolean);
  const baselineTotal = filledStarters.reduce((sum, detail) => sum + detail.baselinePpg, 0);
  const weeklyCount = filledStarters.filter(detail => detail.source === 'weekly').length;
  const weeklyCoverage = filledStarters.length ? weeklyCount / filledStarters.length : 0;
  const currentStarters = period.inRegularSeason
    ? new Set((roster.starters || []).map(String).filter(playerId => playerId && playerId !== '0'))
    : new Set();
  const startIds = period.inRegularSeason ? [...selected].filter(playerId => !currentStarters.has(playerId)) : [];
  const sitIds = period.inRegularSeason ? [...currentStarters].filter(playerId => !selected.has(playerId)) : [];
  const confidence = weeklyCoverage >= 0.85 ? 'High' : weeklyCoverage >= 0.55 ? 'Medium' : weeklyCoverage > 0 ? 'Limited' : 'Season fallback';

  return {
    period,
    total: roundNum(optimized.total, 2),
    baselineTotal: roundNum(baselineTotal, 2),
    matchupDelta: roundNum(optimized.total - baselineTotal, 2),
    starters,
    bench,
    unavailable,
    emptySlots: starters.filter(row => !row.detail).map(row => row.slot),
    startIds,
    sitIds,
    weeklyCoverage: roundNum(weeklyCoverage * 100, 0),
    confidence,
    weeklyCount,
    filled: filledStarters.length,
    slotCount: starters.length
  };
}

function rosterDepthScore(league, playerIds = []) {
  const demand = starterDemandPerRoster(league);
  let total = 0;
  for (const position of activeLeaguePositions(league)) {
    const required = Math.max(1, Math.ceil(safeNumber(demand[position])));
    const replacement = safeNumber(league.projectionModel?.replacementByPosition?.[position], 0);
    const room = (playerIds || [])
      .filter(playerId => playerFantasyPositions(playerId).includes(position))
      .map(playerId => forecastForPlayer(league, playerId).ppg)
      .filter(value => value > 0)
      .sort((a, b) => b - a);
    room.slice(required, required + 2).forEach((ppg, index) => {
      total += Math.max(0, ppg - replacement) * (index ? 0.2 : 0.35);
    });
  }
  return roundNum(total, 3);
}

function rosterNeedProfile(league, rosterId, overridePlayers = null) {
  const roster = league.rosterMap.get(Number(rosterId));
  const playerIds = overridePlayers || roster?.players || [];
  const needCounts = starterDemandPerRoster(league);
  const activePositions = activeLeaguePositions(league);
  const profile = {};
  for (const pos of POSITION_ORDER) {
    const required = activePositions.has(pos) ? Math.ceil(needCounts[pos] || 0) : 0;
    if (!required) {
      profile[pos] = { required: 0, value: 0, count: 0, replacement: 0, surplus: 0 };
      continue;
    }
    const forecasts = playerIds
      .filter(pid => playerFantasyPositions(pid).includes(pos))
      .map(pid => forecastForPlayer(league, pid).ppg)
      .filter(value => value > 0)
      .sort((a, b) => b - a)
      .slice(0, required);
    const avg = forecasts.length ? forecasts.reduce((sum, value) => sum + value, 0) / required : 0;
    const replacement = safeNumber(league.projectionModel?.replacementByPosition?.[pos], 0);
    const surplus = forecasts.reduce((sum, value) => sum + Math.max(0, value - replacement), 0);
    profile[pos] = {
      required, value: roundNum(avg, 2), count: forecasts.length,
      replacement: roundNum(replacement, 2), surplus: roundNum(surplus, 2)
    };
  }
  return profile;
}

function simulateTradePlayers(league, rosterId, gives, receives) {
  const roster = league.rosterMap.get(Number(rosterId));
  const players = new Set((roster?.players || []).map(String));
  gives.filter(a => a.type === 'player').forEach(a => players.delete(String(a.playerId)));
  receives.filter(a => a.type === 'player').forEach(a => players.add(String(a.playerId)));
  return [...players];
}

function teamFitImpact(league, rosterId, beforePlayers, afterPlayers, packageReferenceValue = 0) {
  const beforeLineup = optimalProjectedLineupScore(league, beforePlayers);
  const afterLineup = optimalProjectedLineupScore(league, afterPlayers);
  const beforeDepth = rosterDepthScore(league, beforePlayers);
  const afterDepth = rosterDepthScore(league, afterPlayers);
  const lineupDelta = afterLineup.total - beforeLineup.total;
  const depthDelta = afterDepth - beforeDepth;
  const contenderIndex = teamStrengthRank(league, rosterId);
  const lineupValuePerPoint = 85 + contenderIndex * 175;
  const uncapped = lineupDelta * lineupValuePerPoint + depthDelta * 55;
  const cap = clampNumber(Math.max(325, packageReferenceValue * 0.13), 325, 1200);
  const adjustment = clampNumber(uncapped, -cap, cap) * clampNumber(state.settings.needWeight, 0, 2);
  return {
    adjustment: roundNum(adjustment, 0),
    lineupDelta: roundNum(lineupDelta, 2),
    depthDelta: roundNum(depthDelta, 2),
    beforePpg: roundNum(beforeLineup.total, 1),
    afterPpg: roundNum(afterLineup.total, 1),
    contenderIndex: roundNum(contenderIndex * 100, 0),
    label: contenderIndex >= 0.67 ? 'contender' : contenderIndex <= 0.33 ? 'retool/rebuild' : 'middle'
  };
}

function setTradeResultMessage(message) {
  const result = $('tradeResult');
  if (!result) return;
  result.className = 'trade-result empty';
  result.textContent = message;
}

function scheduleTradeEvaluation(delay = 70) {
  if (typeof document === 'undefined' || !$('tradeResult')) return;
  clearTimeout(tradeEvaluationTimer);
  tradeEvaluationTimer = setTimeout(() => evaluateTrade(), delay);
}

function evaluateTrade() {
  const league = getSelectedLeague();
  if (!league) {
    setTradeResultMessage('Add a league in Settings to start analyzing trades.');
    return;
  }
  const rosterA = Number($('teamASelect').value);
  const rosterB = Number($('teamBSelect').value);
  if (!rosterA || !rosterB || rosterA === rosterB) {
    setTradeResultMessage('Choose two different teams.');
    return;
  }

  const aGives = state.selectedAssets.A;
  const bGives = state.selectedAssets.B;
  if (!aGives.length || !bGives.length) {
    const missing = !aGives.length && !bGives.length ? 'an asset to each side' : !aGives.length ? 'a Team A asset' : 'a Team B asset';
    setTradeResultMessage(`Add ${missing} to see the live analysis.`);
    return;
  }

  const packageA = packageValuation(league, aGives);
  const packageB = packageValuation(league, bGives);
  const rosterAPlayers = (league.rosterMap.get(rosterA)?.players || []).map(String);
  const rosterBPlayers = (league.rosterMap.get(rosterB)?.players || []).map(String);
  const aAfterPlayers = simulateTradePlayers(league, rosterA, aGives, bGives);
  const bAfterPlayers = simulateTradePlayers(league, rosterB, bGives, aGives);
  const referenceValue = Math.max(packageA.adjusted, packageB.adjusted);
  const aFit = teamFitImpact(league, rosterA, rosterAPlayers, aAfterPlayers, referenceValue);
  const bFit = teamFitImpact(league, rosterB, rosterBPlayers, bAfterPlayers, referenceValue);
  const spread = packageB.adjusted - packageA.adjusted;
  const averagePackage = Math.max(1, (packageA.adjusted + packageB.adjusted) / 2);
  const packageConfidence = (packageA.confidence + packageB.confidence) / 2;
  const projectionCoverage = safeNumber(league.projectionModel?.coverage, 0) * 100;
  const analysisConfidence = clampNumber(packageConfidence * 0.68 + projectionCoverage * 0.32, 0, 96);
  const fairBand = tradeFairBand(league, packageA, packageB);
  const aNet = spread + aFit.adjustment;
  const bNet = -spread + bFit.adjustment;
  const edgePercent = Math.abs(spread) / averagePackage * 100;

  let verdictClass = 'good';
  let verdict = 'Fair market-value range';
  let explanation = `The package-adjusted difference is ${roundNum(Math.abs(spread), 0)}, inside this analysis's ${roundNum(fairBand, 0)}-point fair band.`;
  if (spread > fairBand) {
    verdictClass = 'bad';
    verdict = `${teamName(league, rosterA)} wins on market value`;
    explanation = `${teamName(league, rosterA)} receives about ${roundNum(spread, 0)} more package-adjusted value, a ${roundNum(edgePercent, 1)}% edge.`;
  } else if (spread < -fairBand) {
    verdictClass = 'bad';
    verdict = `${teamName(league, rosterB)} wins on market value`;
    explanation = `${teamName(league, rosterB)} receives about ${roundNum(Math.abs(spread), 0)} more package-adjusted value, a ${roundNum(edgePercent, 1)}% edge.`;
  } else if (Math.abs(aFit.adjustment - bFit.adjustment) > fairBand * 0.65) {
    verdictClass = 'warn';
    const fitWinner = aFit.adjustment > bFit.adjustment ? teamName(league, rosterA) : teamName(league, rosterB);
    verdict = `Fair price, stronger roster fit for ${fitWinner}`;
    explanation = 'The market values are close, but the projected starting-lineup and depth changes are materially different.';
  }

  $('tradeResult').classList.remove('empty');
  $('tradeResult').innerHTML = `
    <div class="trade-summary">
      <div class="metric"><span>${displayNumber(packageA.adjusted, 0)}</span><small>Team A package</small></div>
      <div class="metric"><span>${displayNumber(packageB.adjusted, 0)}</span><small>Team B package</small></div>
      <div class="metric"><span>${displaySignedNumber(spread, 0)}</span><small>Market edge toward Team A</small></div>
      <div class="metric"><span>${escapeHtml(valueConfidenceLabel(analysisConfidence / 100))}</span><small>${displayNumber(analysisConfidence, 0)}% data confidence</small></div>
    </div>
    <div class="verdict ${verdictClass}">
      <strong>${escapeHtml(verdict)}</strong>
      <p>${escapeHtml(explanation)}</p>
    </div>
    <div class="grid two">
      <div class="result-card">
        <h3>${escapeHtml(teamName(league, rosterA))}</h3>
        <p><strong>Market net:</strong> ${displaySignedNumber(spread, 0)}</p>
        <p><strong>Projected lineup:</strong> ${displayNumber(aFit.beforePpg)} → ${displayNumber(aFit.afterPpg)} PPG (${displaySignedNumber(aFit.lineupDelta)})</p>
        <p><strong>Roster-fit adjustment:</strong> ${displaySignedNumber(aFit.adjustment, 0)} <small>${escapeHtml(aFit.label)} profile</small></p>
        <p><strong>Team-context net:</strong> ${displaySignedNumber(aNet, 0)}</p>
        ${renderAssetBreakdown(league, bGives, 'Receives')}
        ${renderAssetBreakdown(league, aGives, 'Sends')}
      </div>
      <div class="result-card">
        <h3>${escapeHtml(teamName(league, rosterB))}</h3>
        <p><strong>Market net:</strong> ${displaySignedNumber(-spread, 0)}</p>
        <p><strong>Projected lineup:</strong> ${displayNumber(bFit.beforePpg)} → ${displayNumber(bFit.afterPpg)} PPG (${displaySignedNumber(bFit.lineupDelta)})</p>
        <p><strong>Roster-fit adjustment:</strong> ${displaySignedNumber(bFit.adjustment, 0)} <small>${escapeHtml(bFit.label)} profile</small></p>
        <p><strong>Team-context net:</strong> ${displaySignedNumber(bNet, 0)}</p>
        ${renderAssetBreakdown(league, aGives, 'Receives')}
        ${renderAssetBreakdown(league, bGives, 'Sends')}
      </div>
    </div>
    <div class="result-card">
      <h3>Package adjustment</h3>
      <p>Team A raw ${displayNumber(packageA.raw, 0)} → ${displayNumber(packageA.adjusted, 0)} (${displaySignedNumber(packageA.adjustment, 0)}); Team B raw ${displayNumber(packageB.raw, 0)} → ${displayNumber(packageB.adjusted, 0)} (${displaySignedNumber(packageB.adjustment, 0)}). Elite assets receive a scarcity premium while extra depth pieces are discounted for consolidation and roster-space cost.</p>
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
    const dynastyContext = asset.type === 'player' ? dynastyAgeSummary(league, asset.playerId) : '';
    const detail = asset.type === 'player'
      ? `${v.forecastPpg} forecast PPG, ${v.vorp >= 0 ? '+' : ''}${v.vorp} over replacement, ${v.efficiency}th efficiency percentile, ${v.confidence} confidence${v.marketAdp ? `, ADP ${roundNum(v.marketAdp, 1)}` : ''}${dynastyContext ? `, ${dynastyContext}` : ''}`
      : v.detail;
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
    const required = profile[pos]?.required || 0;
    const shallow = (profile[pos]?.count || 0) < required;
    if (required && (shallow || (median && (profile[pos]?.value || 0) < median * 0.82))) weak.push(pos);
  }
  return weak.length ? weak.join(', ') : 'No severe positional holes detected';
}

function medianOf(values) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function rosterPlayerIds(league, rosterId) {
  return (league?.rosterMap?.get(Number(rosterId))?.players || []).map(String);
}

function freeAgentCandidates(league, rosterId, positionFilter = 'NEED', limit = 12) {
  if (!league || !rosterId) return [];
  const rostered = new Set(rosteredPlayerIds(league));
  const beforePlayers = rosterPlayerIds(league, rosterId);
  const needScores = teamPositionNeedScores(league, rosterId);
  const activePositions = activeLeaguePositions(league);
  const requestedPosition = String(positionFilter || 'NEED').toUpperCase();
  const projectionIds = league.projectionModel?.players
    ? [...league.projectionModel.players.keys()]
    : [...state.projections.keys()];
  const fallbackIds = Object.entries(state.players || {})
    .filter(([, player]) => player?.active !== false && player?.team && safeNumber(player?.search_rank, 9999) < 600)
    .map(([playerId]) => String(playerId));

  const preliminary = [...new Set([...projectionIds.map(String), ...fallbackIds])]
    .filter(playerId => !rostered.has(playerId))
    .map(playerId => {
      const player = getPlayer(playerId) || {};
      const position = playerPrimaryPosition(playerId);
      const value = playerValue(league, playerId);
      const needScore = safeNumber(needScores[position], 0);
      return { playerId, player, position, value, needScore };
    })
    .filter(row => activePositions.has(row.position))
    .filter(row => !POSITION_ORDER.includes(requestedPosition) || row.position === requestedPosition)
    .filter(row => row.player.active !== false && (row.player.team || row.position === 'DEF'))
    .filter(row => row.value.forecastPpg > 0 || row.value.marketAdp || safeNumber(row.player.search_rank, 9999) < 600)
    .sort((a, b) => {
      const needMultiplier = requestedPosition === 'NEED' ? 1500 : 650;
      const aPriority = a.value.value + a.needScore * needMultiplier + Math.max(0, a.value.vorp) * 95 + a.value.confidenceScore * 2;
      const bPriority = b.value.value + b.needScore * needMultiplier + Math.max(0, b.value.vorp) * 95 + b.value.confidenceScore * 2;
      return bPriority - aPriority || b.value.value - a.value.value;
    })
    .slice(0, Math.max(80, safeNumber(limit, 12) * 8));

  return preliminary.map(row => {
    const afterPlayers = [...beforePlayers, row.playerId];
    const fit = teamFitImpact(league, rosterId, beforePlayers, afterPlayers, row.value.value);
    const fitScore = roundNum(clampNumber(
      38
        + row.needScore * 26
        + clamp01(fit.lineupDelta / 8) * 22
        + clamp01(fit.depthDelta / 4) * 8
        + clamp01(Math.max(0, row.value.vorp) / 10) * 8
        + clamp01(row.value.confidenceScore / 100) * 5,
      1,
      99
    ), 0);
    const needMultiplier = requestedPosition === 'NEED' ? 1550 : 700;
    const priority = row.value.value * 0.62
      + row.needScore * needMultiplier
      + fit.lineupDelta * 230
      + fit.depthDelta * 95
      + Math.max(0, row.value.vorp) * 110
      + row.value.confidenceScore * 2;
    return { ...row, fit, fitScore, priority: roundNum(priority, 2) };
  }).sort((a, b) => b.priority - a.priority || b.value.value - a.value.value)
    .slice(0, Math.max(1, safeNumber(limit, 12)));
}

function dropCandidatesForPickup(league, rosterId, freeAgentId, limit = 6) {
  if (!league || !rosterId || !freeAgentId) return [];
  const beforePlayers = rosterPlayerIds(league, rosterId);
  if (!beforePlayers.length) return [];
  const targetId = String(freeAgentId);
  const targetValue = playerValue(league, targetId);
  const optimalStarters = new Set(optimalProjectedLineupScore(league, beforePlayers).selected);
  const roster = league.rosterMap.get(Number(rosterId)) || {};
  const taxi = new Set((roster.taxi || []).map(String));
  const reserve = new Set((roster.reserve || []).map(String));

  return beforePlayers.map(dropPlayerId => {
    const dropValue = playerValue(league, dropPlayerId);
    const afterPlayers = beforePlayers.filter(playerId => playerId !== dropPlayerId);
    if (!afterPlayers.includes(targetId)) afterPlayers.push(targetId);
    const referenceValue = Math.max(targetValue.value, dropValue.value);
    const fit = teamFitImpact(league, rosterId, beforePlayers, afterPlayers, referenceValue);
    const netMarketValue = targetValue.value - dropValue.value;
    const teamContextNet = roundNum(netMarketValue + fit.adjustment, 0);
    const isStarter = optimalStarters.has(dropPlayerId);
    const isTaxi = taxi.has(dropPlayerId);
    const isReserve = reserve.has(dropPlayerId);
    const tradeInstead = dropValue.value >= 2500 && targetValue.value < dropValue.value * 1.15;
    const protectionPenalty = (isStarter && fit.lineupDelta < -0.25 ? 500 : 0)
      + (isTaxi && isDynastyLeague(league) ? 260 : 0)
      + (tradeInstead ? 900 : 0);
    const rankingScore = teamContextNet + fit.lineupDelta * 125 + fit.depthDelta * 55 - protectionPenalty;
    let verdict = 'Hold roster';
    let tone = 'bad';
    if (tradeInstead) {
      verdict = 'Trade, do not drop';
      tone = 'warn';
    } else if (teamContextNet >= 400 && fit.lineupDelta >= -0.25) {
      verdict = 'Best add/drop fit';
      tone = 'good';
    } else if (teamContextNet >= 0 && fit.lineupDelta >= -0.75) {
      verdict = 'Marginal upgrade';
      tone = 'warn';
    }
    return {
      playerId: dropPlayerId,
      player: getPlayer(dropPlayerId) || {},
      value: dropValue,
      targetValue,
      fit,
      netMarketValue,
      teamContextNet,
      isStarter,
      isTaxi,
      isReserve,
      tradeInstead,
      rankingScore,
      verdict,
      tone
    };
  }).sort((a, b) => b.rankingScore - a.rankingScore || a.value.value - b.value.value)
    .slice(0, Math.max(1, safeNumber(limit, 6)));
}

function tradeTargetRecommendations(league, acquiringRosterId, partnerRosterId, limit = 6) {
  if (!league || !acquiringRosterId || !partnerRosterId || Number(acquiringRosterId) === Number(partnerRosterId)) return [];
  const acquiringPlayers = rosterPlayerIds(league, acquiringRosterId);
  const partnerPlayers = rosterPlayerIds(league, partnerRosterId);
  const acquiringNeeds = teamPositionNeedScores(league, acquiringRosterId);
  const activePositions = activeLeaguePositions(league);

  return partnerPlayers.map(playerId => {
    const position = playerPrimaryPosition(playerId);
    const value = playerValue(league, playerId);
    const acquiringAfter = [...acquiringPlayers, playerId];
    const partnerAfter = partnerPlayers.filter(id => id !== playerId);
    const fit = teamFitImpact(league, acquiringRosterId, acquiringPlayers, acquiringAfter, value.value);
    const sellerFit = teamFitImpact(league, partnerRosterId, partnerPlayers, partnerAfter, value.value);
    const needScore = safeNumber(acquiringNeeds[position], 0);
    const sellerFriction = clamp01(Math.max(0, -sellerFit.lineupDelta) / 8);
    const targetScore = roundNum(clampNumber(
      34
        + needScore * 28
        + clamp01(fit.lineupDelta / 8) * 26
        + clamp01(fit.depthDelta / 4) * 8
        + clamp01(Math.max(0, value.vorp) / 10) * 8
        + clamp01(value.value / 9000) * 5
        - sellerFriction * 7,
      1,
      99
    ), 0);
    const priority = needScore * 1650
      + fit.lineupDelta * 240
      + fit.depthDelta * 95
      + Math.max(0, value.vorp) * 110
      + value.value * 0.18
      - sellerFriction * 420;
    return { playerId, player: getPlayer(playerId) || {}, position, value, fit, sellerFit, needScore, targetScore, priority };
  }).filter(row => activePositions.has(row.position) && row.value.value > 30)
    .sort((a, b) => b.priority - a.priority || b.value.value - a.value.value)
    .slice(0, Math.max(1, safeNumber(limit, 6)));
}

function tradeFairBand(league, packageA, packageB) {
  const averagePackage = Math.max(1, (safeNumber(packageA?.adjusted) + safeNumber(packageB?.adjusted)) / 2);
  const packageConfidence = (safeNumber(packageA?.confidence, 55) + safeNumber(packageB?.confidence, 55)) / 2;
  const projectionCoverage = safeNumber(league?.projectionModel?.coverage, 0) * 100;
  const analysisConfidence = clampNumber(packageConfidence * 0.68 + projectionCoverage * 0.32, 0, 96);
  const uncertainty = 1 - analysisConfidence / 100;
  return clampNumber(averagePackage * (0.065 + uncertainty * 0.04), 250, 1100);
}

function offerAssetNeedScore(league, recipientRosterId, asset, needScores = null) {
  if (asset.type === 'player') {
    const scores = needScores || teamPositionNeedScores(league, recipientRosterId);
    return safeNumber(scores[playerPrimaryPosition(asset.playerId)], 0);
  }
  const recipientRank = teamStrengthRank(league, recipientRosterId);
  return clampNumber(0.35 + (1 - recipientRank) * 0.45, 0.35, 0.8);
}

function generateFairTradeOffer(league, acquiringRosterId, partnerRosterId, targetPlayerId) {
  if (!league || !acquiringRosterId || !partnerRosterId || !targetPlayerId) return null;
  if (Number(acquiringRosterId) === Number(partnerRosterId)) return null;
  const targetId = String(targetPlayerId);
  if (!rosterPlayerIds(league, partnerRosterId).includes(targetId)) return null;

  const targetAsset = { type: 'player', playerId: targetId };
  const targetPackage = packageValuation(league, [targetAsset]);
  const targetReference = Math.max(1, targetPackage.adjusted);
  const acquiringPlayers = rosterPlayerIds(league, acquiringRosterId);
  const partnerPlayers = rosterPlayerIds(league, partnerRosterId);
  const partnerNeeds = teamPositionNeedScores(league, partnerRosterId);
  const candidateAssets = [
    ...acquiringPlayers.map(playerId => ({ type: 'player', playerId })),
    ...ownedPicksForRoster(league, acquiringRosterId)
  ];

  const rankedCandidates = candidateAssets.map(asset => {
    const detail = assetValue(league, asset);
    const needScore = offerAssetNeedScore(league, partnerRosterId, asset, partnerNeeds);
    let senderCost = 0;
    if (asset.type === 'player') {
      const afterRemoval = acquiringPlayers.filter(playerId => playerId !== String(asset.playerId));
      const removalFit = teamFitImpact(league, acquiringRosterId, acquiringPlayers, afterRemoval, detail.value);
      senderCost = Math.max(0, -removalFit.adjustment);
    }
    const closeness = Math.abs(detail.value - targetReference) / targetReference;
    const overpay = detail.value > targetReference * 1.28 ? (detail.value / targetReference - 1.28) * 2.5 : 0;
    const rankScore = closeness + senderCost / targetReference * 0.72 + overpay - needScore * 0.34;
    return { asset, detail, needScore, senderCost, rankScore };
  }).filter(row => safeNumber(row.detail.value) > 25)
    .sort((a, b) => a.rankScore - b.rankScore || b.detail.value - a.detail.value);

  const needFirst = rankedCandidates.slice().sort((a, b) => b.needScore - a.needScore || a.rankScore - b.rankScore).slice(0, 8);
  const valuePieces = rankedCandidates.filter(row => row.detail.value <= targetReference * 0.85).slice(0, 8);
  const candidateMap = new Map();
  [...rankedCandidates.slice(0, 16), ...needFirst, ...valuePieces].forEach(row => candidateMap.set(assetKey(row.asset), row));
  const candidates = [...candidateMap.values()].slice(0, 22);
  if (!candidates.length) return null;

  const combinations = candidates.map(row => [row]);
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) combinations.push([candidates[i], candidates[j]]);
  }
  const triplePool = candidates.slice(0, 14);
  for (let i = 0; i < triplePool.length; i += 1) {
    for (let j = i + 1; j < triplePool.length; j += 1) {
      for (let k = j + 1; k < triplePool.length; k += 1) combinations.push([triplePool[i], triplePool[j], triplePool[k]]);
    }
  }

  let best = null;
  for (const combination of combinations) {
    const offeredAssets = combination.map(row => row.asset);
    const offerPackage = packageValuation(league, offeredAssets);
    if (!offerPackage.adjusted) continue;
    const fairBand = tradeFairBand(league, offerPackage, targetPackage);
    const marketDifference = offerPackage.adjusted - targetPackage.adjusted;
    const marketGap = Math.abs(marketDifference);
    const acquiringAfter = simulateTradePlayers(league, acquiringRosterId, offeredAssets, [targetAsset]);
    const partnerAfter = simulateTradePlayers(league, partnerRosterId, [targetAsset], offeredAssets);
    const referenceValue = Math.max(offerPackage.adjusted, targetPackage.adjusted);
    const acquiringFit = teamFitImpact(league, acquiringRosterId, acquiringPlayers, acquiringAfter, referenceValue);
    const partnerFit = teamFitImpact(league, partnerRosterId, partnerPlayers, partnerAfter, referenceValue);
    const acquiringNet = targetPackage.adjusted - offerPackage.adjusted + acquiringFit.adjustment;
    const partnerNet = offerPackage.adjusted - targetPackage.adjusted + partnerFit.adjustment;
    const weightedNeed = combination.reduce((sum, row) => sum + row.needScore * row.detail.value, 0) / Math.max(1, offerPackage.raw);
    const outsideFairRange = marketGap > fairBand;
    const fairnessPenalty = outsideFairRange ? 1000 + (marketGap - fairBand) / fairBand * 260 : 0;
    const contextImbalance = Math.abs(acquiringNet - partnerNet) / Math.max(1, fairBand * 2);
    const score = fairnessPenalty
      + marketGap / Math.max(1, fairBand) * 100
      + contextImbalance * 18
      + (offeredAssets.length - 1) * 4
      - weightedNeed * 11
      - Math.max(0, acquiringFit.lineupDelta) * 1.5
      - Math.max(0, partnerFit.lineupDelta);
    const signature = offeredAssets.map(assetKey).sort().join('|');
    if (!best || score < best.score || (score === best.score && signature < best.signature)) {
      best = {
        targetAsset,
        targetPackage,
        offeredAssets,
        offerPackage,
        fairBand: roundNum(fairBand, 0),
        marketDifference: roundNum(marketDifference, 0),
        acquiringFit,
        partnerFit,
        acquiringNet: roundNum(acquiringNet, 0),
        partnerNet: roundNum(partnerNet, 0),
        fair: !outsideFairRange,
        score,
        signature,
        recipientNeedScore: roundNum(weightedNeed * 100, 0)
      };
    }
  }
  return best;
}

function freeAgentReasonLabels(row) {
  const labels = [];
  if (row.needScore >= 0.66) labels.push('Urgent roster need');
  else if (row.needScore >= 0.34) labels.push('Position of need');
  if (row.fit.lineupDelta >= 0.5) labels.push(`${displaySignedNumber(row.fit.lineupDelta)} lineup PPG`);
  else if (row.fit.depthDelta > 0.15) labels.push('Improves depth');
  if (row.value.vorp > 0) labels.push(`${displaySignedNumber(row.value.vorp)} VORP`);
  labels.push(`${row.value.confidence} confidence`);
  return labels.slice(0, 4);
}

function renderFreeAgentCard(row, selected = false) {
  const ageContext = dynastyAgeSummary(getSelectedLeague(), row.playerId);
  return `
    <article class="free-agent-card ${selected ? 'selected' : ''}">
      <div class="free-agent-card-topline">
        <div class="free-agent-identity">
          <span class="position-token">${escapeHtml(row.position)}</span>
          <div>
            <h4>${escapeHtml(row.value.name)}</h4>
            <p>${escapeHtml(row.player.team || 'FA')} · Value ${displayNumber(row.value.value, 0)} · ${displayNumber(row.value.forecastPpg)} forecast PPG</p>
          </div>
        </div>
        <div class="fit-score compact-fit-score"><strong>${displayNumber(row.fitScore, 0)}</strong><span>fit</span></div>
      </div>
      <div class="recommendation-badges">${freeAgentReasonLabels(row).map(label => `<span class="badge">${escapeHtml(label)}</span>`).join('')}</div>
      ${ageContext ? `<p class="card-context">${escapeHtml(ageContext)}</p>` : ''}
      <button class="secondary analyze-pickup-button" type="button" data-analyze-free-agent="${escapeHtml(row.playerId)}">${selected ? 'Analyzing pickup' : 'Analyze pickup'}</button>
    </article>`;
}

function renderDropCandidateCard(row) {
  const rosterRole = row.isTaxi ? 'Taxi' : row.isReserve ? 'IR/reserve' : row.isStarter ? 'Projected starter' : 'Depth player';
  return `
    <article class="drop-candidate-card">
      <div class="drop-candidate-topline">
        <div>
          <span class="badge ${row.tone}">${escapeHtml(row.verdict)}</span>
          <h4>${escapeHtml(row.value.name)}</h4>
          <p>${escapeHtml(row.value.position)} · ${escapeHtml(rosterRole)} · Value ${displayNumber(row.value.value, 0)}</p>
        </div>
        <div class="move-score ${row.teamContextNet >= 0 ? 'positive' : 'negative'}">
          <strong>${displaySignedNumber(row.teamContextNet, 0)}</strong>
          <span>team net</span>
        </div>
      </div>
      <div class="drop-impact-grid">
        <span><small>Value change</small><strong>${displaySignedNumber(row.netMarketValue, 0)}</strong></span>
        <span><small>Lineup change</small><strong>${displaySignedNumber(row.fit.lineupDelta)} PPG</strong></span>
        <span><small>Depth change</small><strong>${displaySignedNumber(row.fit.depthDelta)}</strong></span>
      </div>
    </article>`;
}

function fillFreeAgencyControls() {
  const league = getSelectedLeague();
  const select = $('freeAgencyTeamSelect');
  if (!select) return;
  fillRosterSelect(select, league);
}

function fillLineupControls() {
  const league = getSelectedLeague();
  const select = $('lineupTeamSelect');
  if (!select) return;
  fillRosterSelect(select, league);
}

function renderFreeAgencyAnalyzer() {
  const listOutput = $('freeAgentRecommendations');
  const dropOutput = $('dropRecommendations');
  const summary = $('freeAgencyNeedsSummary');
  const status = $('freeAgencyDataStatus');
  if (!listOutput || !dropOutput || !summary) return;
  const league = getSelectedLeague();
  const rosterId = Number($('freeAgencyTeamSelect')?.value);
  if (!league || !rosterId) {
    summary.className = 'free-agency-needs-summary empty';
    summary.textContent = 'Load a league to rank available players against a roster.';
    listOutput.className = 'free-agent-list empty';
    listOutput.textContent = 'Free-agent recommendations will appear here.';
    dropOutput.className = 'drop-recommendations empty';
    dropOutput.textContent = 'Select a player to see possible drops.';
    if (status) status.textContent = 'Waiting for league';
    return;
  }

  const positionFilter = $('freeAgencyPositionFilter')?.value || 'NEED';
  const recommendations = freeAgentCandidates(league, rosterId, positionFilter, 12);
  summary.className = 'free-agency-needs-summary';
  summary.innerHTML = `<strong>${escapeHtml(teamName(league, rosterId))}</strong><span>${escapeHtml(rosterNeedsSummary(league, rosterId))}</span>`;
  if (status) status.textContent = recommendations.length ? `${recommendations.length} best available` : 'No candidates found';

  if (!recommendations.length) {
    state.freeAgency.selectedPlayerId = '';
    listOutput.className = 'free-agent-list empty';
    listOutput.textContent = 'No unrostered players with usable Sleeper projections were found for this filter.';
    dropOutput.className = 'drop-recommendations empty';
    dropOutput.textContent = 'Try another position or select Best available.';
    return;
  }

  if (!recommendations.some(row => row.playerId === String(state.freeAgency.selectedPlayerId))) {
    state.freeAgency.selectedPlayerId = recommendations[0].playerId;
  }
  listOutput.className = 'free-agent-list';
  listOutput.innerHTML = recommendations.map(row => renderFreeAgentCard(row, row.playerId === String(state.freeAgency.selectedPlayerId))).join('');
  listOutput.querySelectorAll('[data-analyze-free-agent]').forEach(button => {
    button.addEventListener('click', () => {
      state.freeAgency.selectedPlayerId = button.dataset.analyzeFreeAgent;
      renderFreeAgencyAnalyzer();
    });
  });

  const selected = recommendations.find(row => row.playerId === String(state.freeAgency.selectedPlayerId)) || recommendations[0];
  const drops = dropCandidatesForPickup(league, rosterId, selected.playerId, 6);
  const best = drops[0];
  dropOutput.className = 'drop-recommendations';
  dropOutput.innerHTML = `
    <div class="pickup-analysis-header">
      <span class="position-token">${escapeHtml(selected.position)}</span>
      <div>
        <span class="panel-kicker">Pickup analysis</span>
        <h3>${escapeHtml(selected.value.name)}</h3>
        <p>${best ? `${escapeHtml(best.verdict)} with ${escapeHtml(best.value.name)} as the first cut candidate.` : 'No rostered player needs to be dropped.'}</p>
      </div>
    </div>
    ${drops.length ? drops.map(renderDropCandidateCard).join('') : '<div class="drop-recommendations empty">No drop candidates found.</div>'}`;
}

function tradeTargetReasonLabels(row) {
  const labels = [];
  if (row.needScore >= 0.66) labels.push('Urgent need');
  else if (row.needScore >= 0.34) labels.push('Roster need');
  if (row.fit.lineupDelta >= 0.35) labels.push(`${displaySignedNumber(row.fit.lineupDelta)} lineup PPG`);
  else if (row.fit.depthDelta > 0.1) labels.push('Depth upgrade');
  if (row.sellerFit.lineupDelta >= -0.25) labels.push('Partner has cover');
  if (row.value.vorp > 0) labels.push(`${displaySignedNumber(row.value.vorp)} VORP`);
  return labels.slice(0, 4);
}

function renderTradeTargetSuggestions() {
  const output = $('tradeTargetSuggestions');
  const summary = $('tradeTargetSummary');
  const status = $('generatedOfferStatus');
  if (!output || !summary) return;
  if (status) status.className = 'generated-offer-status';
  const league = getSelectedLeague();
  const targetSideSelect = $('tradeTargetSideSelect');
  if (league && targetSideSelect) {
    const teamAId = Number($('teamASelect')?.value);
    const teamBId = Number($('teamBSelect')?.value);
    const optionA = [...targetSideSelect.options].find(option => option.value === 'A');
    const optionB = [...targetSideSelect.options].find(option => option.value === 'B');
    if (optionA && teamAId) optionA.textContent = `Team A · ${teamName(league, teamAId)}`;
    if (optionB && teamBId) optionB.textContent = `Team B · ${teamName(league, teamBId)}`;
  }
  const side = targetSideSelect?.value === 'B' ? 'B' : 'A';
  const acquiringRosterId = Number($(side === 'A' ? 'teamASelect' : 'teamBSelect')?.value);
  const partnerRosterId = Number($(side === 'A' ? 'teamBSelect' : 'teamASelect')?.value);
  if (!league || !acquiringRosterId || !partnerRosterId || acquiringRosterId === partnerRosterId) {
    summary.textContent = 'Choose two different teams to see recommended targets.';
    output.className = 'trade-target-grid empty';
    output.textContent = 'Recommended trade targets will appear here.';
    if (status) status.textContent = 'Waiting for teams';
    return;
  }

  const rows = tradeTargetRecommendations(league, acquiringRosterId, partnerRosterId, 6);
  summary.innerHTML = `<strong>${escapeHtml(teamName(league, acquiringRosterId))}</strong> targets from ${escapeHtml(teamName(league, partnerRosterId))}, ranked by lineup gain, positional need, market value, and the partner’s ability to replace the player.`;
  if (!rows.length) {
    output.className = 'trade-target-grid empty';
    output.textContent = 'No usable targets were found on this roster.';
    if (status) status.textContent = 'No target selected';
    return;
  }

  output.className = 'trade-target-grid';
  output.innerHTML = rows.map(row => `
    <article class="trade-target-card">
      <div class="trade-target-card-topline">
        <span class="position-token">${escapeHtml(row.position)}</span>
        <div class="target-score"><strong>${displayNumber(row.targetScore, 0)}</strong><span>fit</span></div>
      </div>
      <h4>${escapeHtml(row.value.name)}</h4>
      <p>${escapeHtml(row.player.team || 'FA')} · Value ${displayNumber(row.value.value, 0)} · ${displayNumber(row.value.forecastPpg)} forecast PPG</p>
      <div class="recommendation-badges">${tradeTargetReasonLabels(row).map(label => `<span class="badge">${escapeHtml(label)}</span>`).join('')}</div>
      <button class="primary generate-offer-button" type="button" data-generate-offer="${escapeHtml(row.playerId)}" data-acquiring-side="${side}">Generate offer</button>
    </article>`).join('');
  output.querySelectorAll('[data-generate-offer]').forEach(button => {
    button.addEventListener('click', () => {
      output.querySelectorAll('[data-generate-offer]').forEach(item => { item.disabled = true; });
      if (status) status.textContent = 'Building the closest fair package from roster assets and owned picks…';
      setTimeout(() => {
        try {
          applyGeneratedTradeOffer(button.dataset.generateOffer, button.dataset.acquiringSide);
        } catch (err) {
          console.error(err);
          if (status) status.textContent = 'The offer could not be generated. Try another target.';
          output.querySelectorAll('[data-generate-offer]').forEach(item => { item.disabled = false; });
        }
      }, 20);
    });
  });
  if (status) status.textContent = 'Choose a target to build an offer';
}

function compactAssetLabel(league, asset) {
  const detail = assetValue(league, asset);
  return asset.type === 'player' ? detail.name : detail.label;
}

function applyGeneratedTradeOffer(targetPlayerId, acquiringSide = 'A') {
  const league = getSelectedLeague();
  const side = acquiringSide === 'B' ? 'B' : 'A';
  const partnerSide = side === 'A' ? 'B' : 'A';
  const acquiringRosterId = Number($(side === 'A' ? 'teamASelect' : 'teamBSelect')?.value);
  const partnerRosterId = Number($(side === 'A' ? 'teamBSelect' : 'teamASelect')?.value);
  const status = $('generatedOfferStatus');
  const offer = generateFairTradeOffer(league, acquiringRosterId, partnerRosterId, targetPlayerId);
  if (!offer) {
    if (status) status.textContent = 'No viable offer could be built from the selected roster and draft capital.';
    $('tradeTargetSuggestions')?.querySelectorAll('[data-generate-offer]').forEach(item => { item.disabled = false; });
    return;
  }

  state.selectedAssets[side] = offer.offeredAssets.map(asset => ({ ...asset }));
  state.selectedAssets[partnerSide] = [{ ...offer.targetAsset }];
  renderAssetList('A');
  renderAssetList('B');
  const offeredNames = offer.offeredAssets.map(asset => compactAssetLabel(league, asset)).join(' + ');
  const fairnessText = offer.fair ? 'Fair offer generated' : 'Closest modeled offer generated';
  if (status) {
    status.className = `generated-offer-status ${offer.fair ? 'good' : 'warn'}`;
    status.textContent = `${fairnessText}: ${offeredNames} for ${playerName(targetPlayerId)}. Seller-side market difference ${displaySignedNumber(offer.marketDifference, 0)} with a ±${displayNumber(offer.fairBand, 0)} fair range.`;
  }
  $('tradeTargetSuggestions')?.querySelectorAll('[data-generate-offer]').forEach(item => { item.disabled = false; });
  scheduleTradeEvaluation(0);
  setTimeout(() => $('tradeResult')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40);
}

function renderAssetList(side) {
  const league = getSelectedLeague();
  const el = side === 'A' ? $('teamAAssets') : $('teamBAssets');
  const assets = state.selectedAssets[side];
  if (!assets.length) {
    el.className = 'asset-list empty';
    el.textContent = 'No assets selected.';
    scheduleTradeEvaluation();
    return;
  }
  el.className = 'asset-list';
  el.innerHTML = assets.map((asset, idx) => {
    const v = league ? assetValue(league, asset) : { value: 0, label: 'Pick', detail: '' };
    const title = asset.type === 'player' ? playerName(asset.playerId) : v.label;
    const dynastyContext = asset.type === 'player' && league ? dynastyAgeSummary(league, asset.playerId) : '';
    const sub = asset.type === 'player'
      ? `${playerPrimaryPosition(asset.playerId)} • value ${v.value} • ${v.forecastPpg} forecast PPG • ${v.confidence} confidence${dynastyContext ? ` • ${dynastyContext}` : ''}`
      : `${v.detail || 'Draft pick'} • value ${v.value}`;
    return `<div class="asset-card"><div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(sub)}</small></div><button class="ghost" data-side="${side}" data-idx="${idx}">Remove</button></div>`;
  }).join('');
  el.querySelectorAll('button[data-side]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.selectedAssets[btn.dataset.side].splice(Number(btn.dataset.idx), 1);
      renderAssetList(btn.dataset.side);
    });
  });
  scheduleTradeEvaluation();
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
  const matchupLabel = `${data.value.forecastPpg} forecast PPG · ${data.value.efficiency}th efficiency pct`;
  const dynasty = isDynastyLeague(league);
  const ageProfile = ageCurveProfile(data.player, league);
  const ageCurveTitle = ageStageLabel(ageProfile.stage);
  const ageCurveSubtitle = retirementHorizonLabel(ageProfile, { compact: true });
  const playerMeta = [data.team, dynasty && data.age ? `Age ${data.age}` : '', `${games} ${gamesLabel}`].filter(Boolean).join(' · ');
  return `
    <article class="player-card" data-player-card data-player-id="${escapeHtml(data.playerId)}" data-league-id="${escapeHtml(league.league_id)}">
      <div class="player-card-header">
        <img class="player-headshot" src="${playerHeadshotUrl(data.playerId)}" alt="${escapeHtml(data.name)} headshot" onerror="this.onerror=null;this.src='${fallback}';" />
        <div class="player-identity">
          <h3>${escapeHtml(data.name)} <span class="status-dot ${tone === 'good' ? '' : tone}"></span></h3>
          <div class="player-meta-row"><span class="position-pill">${escapeHtml(data.position)}</span><span>${escapeHtml(playerMeta)}</span></div>
          <div class="matchup-pill">${escapeHtml(matchupLabel)}</div>
        </div>
        <div class="player-score">
          <strong>${roundNum(data.value.value, 1)}</strong>
          <span>VALUE</span>
          <small>${data.value.confidence} confidence · ${rankText}</small>
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
          <div class="stat-tile"><strong>${data.value.forecastPpg}</strong><span>Forecast PPG</span></div>
          <div class="stat-tile"><strong>${total}</strong><span>Total Pts</span></div>
          <div class="stat-tile"><strong class="green">${roundNum(data.value.value, 1)}</strong><span>Trade Value</span></div>
        </div>

        ${displaySampleNote(data, games)}

        <div class="stat-tile-grid three">
          <div class="stat-tile"><strong>${roundNum(data.rec.high || 0, 1)}</strong><span>High</span></div>
          <div class="stat-tile"><strong>${last4}</strong><span>Last 5</span></div>
          <div class="stat-tile"><strong>${data.value.vorp >= 0 ? '+' : ''}${data.value.vorp}</strong><span>VORP / Week</span></div>
          <div class="stat-tile"><strong>${data.rank.rank}/${data.rank.total}</strong><span>Value Rank</span></div>
          <div class="stat-tile"><strong>${data.value.efficiency}</strong><span>Efficiency Pct</span></div>
          ${dynasty ? `<div class="stat-tile"><strong>${escapeHtml(ageCurveTitle)}</strong><span>${escapeHtml(ageCurveSubtitle)}</span></div>` : ''}
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
  const dynastyContext = dynastyAgeSummary(league, player, { compact: false, includeStage: true });
  return `
    <article class="player-card trade-player-card">
      <div class="player-card-header compact-player-header">
        <img class="player-headshot" src="${playerHeadshotUrl(playerId)}" alt="${escapeHtml(name)} headshot" onerror="this.onerror=null;this.src='${fallback}';" />
        <div class="player-identity">
          <h3>${escapeHtml(name)} <span class="status-dot ${tone === 'good' ? '' : tone}"></span></h3>
          <div class="player-meta-row"><span class="position-pill">${escapeHtml(position)}</span><span>${escapeHtml(player.team || 'FA')} · ${value.forecastPpg} forecast PPG · ${value.efficiency}th efficiency pct</span></div>
          <div class="matchup-pill">${value.vorp >= 0 ? '+' : ''}${value.vorp} over replacement · ${escapeHtml(value.confidence)} confidence</div>
          ${dynastyContext ? `<div class="career-horizon-pill"><span>Dynasty</span>${escapeHtml(dynastyContext)}</div>` : ''}
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
  const coverage = roundNum(safeNumber(league.projectionModel?.coverage, 0) * 100, 0);
  const dynasty = isDynastyLeague(league);
  return `
    <section class="result-card model-explanation">
      <h3>What the trade model used</h3>
      <p>Player price and team fit are modeled separately. Format-specific Sleeper ADP anchors the market price; league-scored projections, replacement level, verified production, efficiency${dynasty ? ', player age, positional career horizon' : ''}, and availability refine it without letting one noisy input dominate.</p>
      <ul>
        <li><strong>Market anchor:</strong> format-aware Sleeper ADP (${dynasty ? 'dynasty' : 'redraft'}, ${isSuperflexLeague(league) ? 'superflex/2QB' : '1QB'}, ${escapeHtml(scoringAdpSuffix(league))}) replaces the old hard-coded player list.</li>
        <li><strong>Projection:</strong> ${escapeHtml(state.projectionSeason || activeValuationSeason(league))} raw stat projections are rescored under the league's available scoring fields. Per-game threshold bonuses use observed weekly data rather than being guessed from a season total. Roster projection coverage: ${coverage}%.</li>
        <li><strong>Replacement and efficiency:</strong> projected points are measured against a replacement level derived from league size and actual QB, flex, superflex, TE, and IDP starter demand. Opportunity-adjusted efficiency is a controlled secondary input.</li>
        ${dynasty ? '<li><strong>Age and retirement horizon:</strong> player age is evaluated against a position-specific prime, decline window, and estimated career horizon. The horizon is a planning estimate, not a player-specific retirement prediction, and its effect stays small when dynasty ADP already prices age.</li>' : ''}
        <li><strong>Verified production:</strong> league matchup data for ${escapeHtml(league.season || currentSeasonNumber(league))}, plus recent form and historical production scored under this league's rules.</li>
        <li><strong>Previous years:</strong> best-effort historical stat fetches scored under this league's scoring rules. Loaded seasons: ${escapeHtml(seasons)}.</li>
        <li><strong>League format:</strong> ${escapeHtml(formatText)}.</li>
        <li><strong>Packages:</strong> elite assets receive a scarcity premium; extra lower-tier pieces receive a modest consolidation/roster-space discount. This prevents three replaceable players from automatically equaling one cornerstone.</li>
        <li><strong>Draft picks:</strong> round value, estimated slot, original-roster strength, format, and years until the pick conveys.</li>
        <li><strong>Team needs:</strong> the app sets the best projected legal lineup before and after the trade, adds a smaller depth effect, and caps fit so need never overwhelms market price.</li>
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
  const fairBand = Math.max(200, ((a.value.value + b.value.value) / 2) * 0.07);
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
        ${compareMetric('Forecast PPG', a.value.forecastPpg, b.value.forecastPpg)}
        ${compareMetric('VORP / week', a.value.vorp, b.value.vorp)}
        ${compareMetric('Efficiency pct', a.value.efficiency, b.value.efficiency, v => `${roundNum(v, 0)}th`)}
        ${compareMetric('Verified PPG', a.rec.ppg, b.rec.ppg)}
        ${compareMetric('Last 5 avg', a.rec.last4Avg, b.rec.last4Avg)}
        ${compareMetric('Data confidence', a.value.confidenceScore, b.value.confidenceScore, v => `${roundNum(v, 0)}%`)}
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

function compareSlotMarkup(slot, playerId) {
  if (!playerId) {
    return `<button type="button" class="compare-slot empty" disabled>
      <span class="selection-badge ${slot === 'B' ? 'second' : 'first'}">${slot === 'B' ? '2' : '1'}</span>
      <span><strong>${slot === 'B' ? 'Second player' : 'First player'}</strong><small>${slot === 'B' ? 'Second tap fills this slot' : 'First tap fills this slot'}</small></span>
    </button>`;
  }
  const player = getPlayer(playerId) || {};
  const valueLeague = getSelectedLeague();
  const value = valueLeague ? playerValue(valueLeague, playerId) : null;
  return `<button type="button" class="compare-slot selected ${slot === 'B' ? 'slot-b' : 'slot-a'}" data-clear-compare-slot="${slot}">
    <span class="selection-badge ${slot === 'B' ? 'second' : 'first'}">${slot === 'B' ? '2' : '1'}</span>
    <span><strong>${escapeHtml(playerName(playerId))}</strong><small>${escapeHtml(player.position || 'UNK')} · ${escapeHtml(player.team || 'FA')}${value ? ` · ${roundNum(value.value)} value` : ''}</small></span>
    <em>×</em>
  </button>`;
}

function renderCompareSelectionSlots() {
  const el = $('compareSelectionSlots');
  if (!el) return;
  const selected = selectedCompareIds();
  el.innerHTML = `${compareSlotMarkup('A', selected.A)}${compareSlotMarkup('B', selected.B)}`;
  el.querySelectorAll('[data-clear-compare-slot]').forEach(button => {
    button.addEventListener('click', () => {
      const slot = button.dataset.clearCompareSlot;
      $(slot === 'B' ? 'playerCompareB' : 'playerCompareA').value = '';
      renderPlayerComparison();
      renderPlayerValues();
    });
  });
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
  renderCompareSelectionSlots();
  const league = getSelectedLeague();
  const el = $('playerCompareOutput');
  if (!el) return;
  if (!league) {
    el.innerHTML = '<section class="panel"><p class="empty">Load a league first.</p></section>';
    return;
  }
  const a = findPlayerFromInput($('playerCompareA')?.value || '');
  const b = findPlayerFromInput($('playerCompareB')?.value || '');
  const ids = [a?.id, b?.id].filter(Boolean);
  if (!ids.length) {
    el.innerHTML = '<section class="panel"><p class="empty">Tap a player in the value table to start comparing.</p></section>';
    return;
  }
  const cards = ids.map(pid => renderPlayerStatCard(league, pid)).join('');
  el.innerHTML = `<div class="player-card-grid">${cards}</div>${renderComparisonPanel(league, a?.id, b?.id)}`;
}

function lineupSlotDisplay(slot, slotIndex, starters = []) {
  const normalized = String(slot || '').toUpperCase();
  const names = {
    SUPER_FLEX: 'SF', SUPERFLEX: 'SF', OP: 'SF',
    REC_FLEX: 'REC FLEX', WRRB_FLEX: 'FLEX', WRT: 'FLEX', RB_WR_TE: 'FLEX', FLEX: 'FLEX',
    IDP_FLEX: 'IDP', DL_LB_DB: 'IDP'
  };
  const base = names[normalized] || normalizePosition(normalized);
  const matching = (starters || []).filter(row => String(row.slot).toUpperCase() === normalized);
  if (matching.length <= 1) return base;
  const ordinal = matching.findIndex(row => Number(row.slotIndex) === Number(slotIndex)) + 1;
  return `${base} ${Math.max(1, ordinal)}`;
}

function renderLineupStarterRow(row, starters) {
  const slotLabel = lineupSlotDisplay(row.slot, row.slotIndex, starters);
  const detail = row.detail;
  if (!detail) {
    return `<article class="lineup-player-row lineup-empty-slot">
      <span class="lineup-slot">${escapeHtml(slotLabel)}</span>
      <div><h4>Open lineup slot</h4><p>No eligible active player found.</p></div>
      <div class="lineup-projection"><strong>0</strong><span>proj pts</span></div>
    </article>`;
  }
  const opponent = detail.opponent ? ` vs ${detail.opponent}` : '';
  const sourceLabel = detail.source === 'weekly' ? 'Weekly projection' : 'Season baseline';
  const injuryBadge = detail.injuryConcern ? `<span class="lineup-status-badge warn">${escapeHtml(detail.status)}</span>` : '';
  return `<article class="lineup-player-row">
    <span class="lineup-slot">${escapeHtml(slotLabel)}</span>
    <div class="lineup-player-copy">
      <h4>${escapeHtml(detail.name)} ${injuryBadge}</h4>
      <p>${escapeHtml(detail.position)} · ${escapeHtml(detail.team)}${escapeHtml(opponent)} · ${escapeHtml(sourceLabel)}</p>
      <span class="lineup-matchup ${escapeHtml(detail.matchupTone)}">${escapeHtml(detail.matchupLabel)}${detail.source === 'weekly' && detail.baselinePpg ? ` · ${escapeHtml(displaySignedNumber(detail.matchupDelta))}` : ''}</span>
    </div>
    <div class="lineup-projection"><strong>${displayNumber(detail.points)}</strong><span>proj pts</span></div>
  </article>`;
}

function renderLineupBenchRow(detail) {
  const opponent = detail.opponent ? ` vs ${detail.opponent}` : '';
  return `<article class="lineup-bench-row">
    <div>
      <h4>${escapeHtml(detail.name)}</h4>
      <p>${escapeHtml(detail.position)} · ${escapeHtml(detail.team)}${escapeHtml(opponent)}</p>
    </div>
    <span class="lineup-matchup ${escapeHtml(detail.matchupTone)}">${escapeHtml(detail.matchupLabel)}</span>
    <strong>${displayNumber(detail.points)}</strong>
  </article>`;
}

function renderLineupChanges(lineup) {
  const output = $('lineupChanges');
  if (!output) return;
  if (!lineup.period.inRegularSeason) {
    output.className = 'lineup-changes offseason';
    output.innerHTML = `<strong>Week 1 planning mode</strong><span>Sleeper has not entered the regular season, so this is a fresh recommended lineup rather than a comparison with last season’s starters.</span>`;
    return;
  }
  if (!lineup.startIds.length && !lineup.sitIds.length) {
    output.className = 'lineup-changes matched';
    output.innerHTML = '<strong>No changes recommended</strong><span>This lineup matches the team’s current Sleeper starters.</span>';
    return;
  }
  output.className = 'lineup-changes';
  output.innerHTML = `
    <strong>${Math.max(lineup.startIds.length, lineup.sitIds.length)} recommended change${Math.max(lineup.startIds.length, lineup.sitIds.length) === 1 ? '' : 's'}</strong>
    <div class="lineup-change-groups">
      <span><small>Start</small>${lineup.startIds.map(playerId => `<b>${escapeHtml(playerName(playerId))}</b>`).join('') || '<b>—</b>'}</span>
      <span><small>Sit</small>${lineup.sitIds.map(playerId => `<b>${escapeHtml(playerName(playerId))}</b>`).join('') || '<b>—</b>'}</span>
    </div>`;
}

function renderRecommendedLineup() {
  const startersOutput = $('recommendedLineup');
  const benchOutput = $('lineupBench');
  const unavailableOutput = $('lineupUnavailable');
  const summary = $('lineupSummary');
  const weekBadge = $('lineupWeekBadge');
  const dataStatus = $('lineupDataStatus');
  if (!startersOutput || !benchOutput || !summary) return;

  const league = getSelectedLeague();
  const rosterId = Number($('lineupTeamSelect')?.value);
  const period = upcomingLineupPeriod();
  if (weekBadge) weekBadge.textContent = period.resetToWeekOne ? `${period.label} · Week 1 default` : period.label;

  if (!league || !rosterId) {
    summary.className = 'lineup-summary empty';
    summary.textContent = 'Load a league to build a recommended lineup.';
    startersOutput.className = 'recommended-lineup empty';
    startersOutput.textContent = 'Recommended starters will appear here.';
    benchOutput.className = 'lineup-bench empty';
    benchOutput.textContent = 'Bench alternatives will appear here.';
    if (unavailableOutput) unavailableOutput.innerHTML = '';
    if (dataStatus) dataStatus.textContent = 'Waiting for league';
    renderLineupChanges({ period, startIds: [], sitIds: [] });
    return;
  }

  const lineup = recommendedLineupForRoster(league, rosterId);
  const meta = state.weeklyProjectionMeta;
  const hasWeeklyRows = Boolean(meta?.rows && Number(meta.season) === Number(period.season) && Number(meta.week) === Number(period.week));
  if (dataStatus) dataStatus.textContent = hasWeeklyRows
    ? `${displayNumber(meta.rows, 0)} weekly projections`
    : 'Season projection fallback';

  summary.className = 'lineup-summary';
  summary.innerHTML = `
    <div class="lineup-summary-copy">
      <span class="panel-kicker">${escapeHtml(teamName(league, rosterId))}</span>
      <h3>${escapeHtml(period.label)} recommendation</h3>
      <p>${hasWeeklyRows
        ? 'Optimized from matchup-specific player stat projections using this league’s exact scoring and legal roster slots.'
        : 'Weekly projections are not available yet, so this lineup uses each player’s season forecast and will update automatically when weekly data arrives.'}</p>
    </div>
    <div class="lineup-summary-metrics">
      <span><small>Projected total</small><strong>${displayNumber(lineup.total)}</strong></span>
      <span><small>Vs season baseline</small><strong class="${lineup.matchupDelta > 0 ? 'positive' : lineup.matchupDelta < 0 ? 'negative' : ''}">${displaySignedNumber(lineup.matchupDelta)}</strong></span>
      <span><small>Weekly coverage</small><strong>${displayNumber(lineup.weeklyCoverage, 0)}%</strong></span>
      <span><small>Confidence</small><strong>${escapeHtml(lineup.confidence)}</strong></span>
    </div>`;

  startersOutput.className = 'recommended-lineup';
  startersOutput.innerHTML = lineup.starters.map(row => renderLineupStarterRow(row, lineup.starters)).join('');
  benchOutput.className = lineup.bench.length ? 'lineup-bench' : 'lineup-bench empty';
  benchOutput.innerHTML = lineup.bench.length
    ? lineup.bench.slice(0, 7).map(renderLineupBenchRow).join('')
    : 'No additional active bench options have usable projections.';

  if (unavailableOutput) {
    unavailableOutput.innerHTML = lineup.unavailable.length
      ? `<div class="lineup-unavailable-heading"><strong>Unavailable this week</strong><span>${lineup.unavailable.length}</span></div>
        <div class="lineup-unavailable-list">${lineup.unavailable.map(detail => `<span><b>${escapeHtml(detail.name)}</b><small>${escapeHtml(detail.unavailableReason)}</small></span>`).join('')}</div>`
      : '';
  }
  renderLineupChanges(lineup);
}

function renderTables() {
  renderStandings();
  renderStrength();
  renderLeagueRules();
  renderPlayerValues();
  renderPlayerComparison();
}

function renderLeagueRules() {
  const league = getSelectedLeague();
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
    <div class="scoring-grid">${scoringRows.map(([key, value]) => `<div class="scoring-row"><span>${escapeHtml(scoringLabel(key))}</span><strong>${escapeHtml(displayNumber(value))}</strong><small>${escapeHtml(key)}</small></div>`).join('') || '<p class="empty">No scoring settings returned.</p>'}</div>
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
  const league = getSelectedLeague();
  const el = $('standingsTable');
  if (!league) { el.innerHTML = '<p class="empty">Load a league first.</p>'; return; }
  const rows = [...league.rosters].sort((a, b) => {
    const aw = safeNumber(a.settings?.wins), bw = safeNumber(b.settings?.wins);
    if (bw !== aw) return bw - aw;
    return totalFpts(b.settings) - totalFpts(a.settings);
  });
  el.innerHTML = `<table><thead><tr><th>Team</th><th>Record</th><th>PF</th><th>PA</th><th>Moves</th></tr></thead><tbody>${rows.map(r => `
    <tr><td>${escapeHtml(teamName(league, r.roster_id))}<small>Roster ${r.roster_id}</small></td><td>${safeNumber(r.settings?.wins)}-${safeNumber(r.settings?.losses)}-${safeNumber(r.settings?.ties)}</td><td>${displayNumber(totalFpts(r.settings))}</td><td>${displayNumber(totalAgainst(r.settings))}</td><td>${safeNumber(r.settings?.total_moves)}</td></tr>`).join('')}</tbody></table>`;
}

function renderStrength() {
  const league = getSelectedLeague();
  const el = $('strengthTable');
  if (!league) { el.innerHTML = '<p class="empty">Load a league first.</p>'; return; }
  const rows = [...league.teamStrength.entries()].sort((a, b) => b[1].score - a[1].score);
  el.innerHTML = `<table><thead><tr><th>Team</th><th>Core value</th><th>Starter value</th><th>Projected lineup</th><th>Pick outlook</th></tr></thead><tbody>${rows.map(([rid, s]) => `
    <tr><td>${escapeHtml(teamName(league, rid))}</td><td>${displayNumber(s.rosterValue, 0)}</td><td>${displayNumber(s.startersValue, 0)}</td><td>${displayNumber(s.projectedLineupPpg)} PPG</td><td>${teamStrengthRank(league, rid) <= 0.33 ? '<span class="badge good">early picks</span>' : teamStrengthRank(league, rid) >= 0.67 ? '<span class="badge bad">late picks</span>' : '<span class="badge warn">mid picks</span>'}</td></tr>`).join('')}</tbody></table>`;
}

function renderPlayerValues() {
  const league = getSelectedLeague();
  const el = $('playerValuesTable');
  if (!league) { el.innerHTML = '<p class="empty">Load a league first.</p>'; return; }
  const dynasty = isDynastyLeague(league);
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
  renderCompareSelectionSlots();
  const dynastyHeaders = dynasty ? '<th>Age</th><th>Retirement horizon</th>' : '';
  el.innerHTML = `<table><thead><tr><th>Player</th><th>Pos</th><th>Value</th>${dynastyHeaders}<th>Forecast</th><th>VORP</th><th>Efficiency</th><th>ADP</th><th>Confidence</th></tr></thead><tbody>${rows.map(v => {
    const isA = String(selected.A) === String(v.playerId);
    const isB = String(selected.B) === String(v.playerId);
    const selectedClass = isA ? ' selected-a' : isB ? ' selected-b' : '';
    const locked = selected.A && selected.B && !isA && !isB;
    const selectionText = isA ? 'Selected 1 · tap again to remove' : isB ? 'Selected 2 · tap again to remove' : locked ? 'Both slots filled' : !selected.A ? 'Tap to select 1' : 'Tap to select 2';
    const selectionBadge = isA ? '<span class="selection-badge first">1</span>' : isB ? '<span class="selection-badge second">2</span>' : '';
    const player = getPlayer(v.playerId) || {};
    const ageProfile = dynasty ? ageCurveProfile(player, league) : null;
    const dynastyCells = dynasty
      ? `<td>${ageProfile?.age ? displayNumber(ageProfile.age, 1) : '—'}</td><td title="Estimated positional planning horizon, not a player-specific retirement prediction">${escapeHtml(retirementHorizonLabel(ageProfile, { compact: true }) || '—')}</td>`
      : '';
    return `<tr class="player-row-clickable${selectedClass}${locked ? ' selection-locked' : ''}" data-player-id="${escapeHtml(v.playerId)}"><td><div class="player-table-name-row">${selectionBadge}<span>${escapeHtml(v.name)}</span></div><small>${escapeHtml(player.team || 'FA')} · ${escapeHtml(selectionText)}</small></td><td>${escapeHtml(v.position)}</td><td><strong>${displayNumber(v.value, 0)}</strong></td>${dynastyCells}<td>${displayNumber(v.forecastPpg)}</td><td>${displaySignedNumber(v.vorp)}</td><td>${displayNumber(v.efficiency, 0)}th</td><td>${v.marketAdp ? displayNumber(v.marketAdp) : '—'}</td><td>${escapeHtml(v.confidence)}</td></tr>`;
  }).join('')}</tbody></table>`;
  el.querySelectorAll('tr[data-player-id]').forEach(row => {
    row.addEventListener('click', () => togglePlayerValueSelection(row.dataset.playerId));
  });
}

function rosterOptionsMarkup(league, { markMyTeam = true } = {}) {
  const myTeamRosterId = savedMyTeamRosterId(league);
  return (league?.rosters || []).map(roster => {
    const rosterId = Number(roster.roster_id);
    const myTeamLabel = markMyTeam && rosterId === myTeamRosterId ? ' · My team' : '';
    return `<option value="${rosterId}">${escapeHtml(teamName(league, rosterId))}${myTeamLabel}</option>`;
  }).join('');
}

function teamSelectDefaultValue(league, {
  previousValue = '',
  previousLeagueId = '',
  preferMyTeam = true,
  preserve = true,
  selections = state.myTeamByLeague
} = {}) {
  const leagueId = String(league?.league_id || '');
  const rosterIds = (league?.rosters || []).map(roster => Number(roster.roster_id));
  const previousRosterId = Number(previousValue);
  if (preserve && previousLeagueId === leagueId && rosterIds.includes(previousRosterId)) {
    return String(previousRosterId);
  }
  const preferredRosterId = preferMyTeam
    ? defaultTeamRosterId(league, selections)
    : Number(rosterIds[0] || 0);
  return rosterIds.includes(preferredRosterId) ? String(preferredRosterId) : '';
}

function fillRosterSelect(select, league, { preferMyTeam = true, preserve = true } = {}) {
  if (!select) return;
  const previous = select.value;
  const previousLeagueId = select.dataset.leagueId || '';
  const leagueId = String(league?.league_id || '');
  const hasRosters = Boolean(league?.rosters?.length);

  select.innerHTML = hasRosters ? rosterOptionsMarkup(league) : '<option value="">No league loaded</option>';
  select.disabled = !hasRosters;
  select.dataset.leagueId = leagueId;
  if (!hasRosters) return;

  const nextValue = teamSelectDefaultValue(league, {
    previousValue: previous,
    previousLeagueId,
    preferMyTeam,
    preserve
  });
  if (nextValue) select.value = nextValue;
}

function fillMyTeamSelect() {
  const select = $('myTeamSelect');
  const help = $('myTeamHelp');
  const setting = $('myTeamSetting');
  if (!select) return;
  const league = getSelectedLeague();

  if (!league?.rosters?.length) {
    select.innerHTML = '<option value="">No league loaded</option>';
    select.disabled = true;
    select.dataset.leagueId = '';
    if (help) help.textContent = 'Add and select a league, then choose your roster.';
    setting?.classList.remove('configured');
    return;
  }

  const myTeamRosterId = savedMyTeamRosterId(league);
  select.innerHTML = `<option value="">Choose your team</option>${rosterOptionsMarkup(league, { markMyTeam: false })}`;
  select.disabled = false;
  select.dataset.leagueId = String(league.league_id);
  select.value = myTeamRosterId ? String(myTeamRosterId) : '';
  if (help) {
    help.textContent = myTeamRosterId
      ? `${teamName(league, myTeamRosterId)} defaults across Lineup, Trade, Free Agency, and Draft.`
      : `Choose your roster in ${league.name || 'this league'} to make every analyzer open on your team.`;
  }
  setting?.classList.toggle('configured', Boolean(myTeamRosterId));
}

function applyMyTeamSelection() {
  const league = getSelectedLeague();
  const select = $('myTeamSelect');
  if (!league || !select) return;
  const rosterId = Number(select.value);
  const validRosterId = (league.rosters || []).some(roster => Number(roster.roster_id) === rosterId) ? rosterId : 0;
  saveMyTeamForLeague(league.league_id, validRosterId || '');

  const defaultRosterId = defaultTeamRosterId(league);
  for (const id of ['lineupTeamSelect', 'freeAgencyTeamSelect', 'draftTeamSelect', 'teamASelect']) {
    const control = $(id);
    if (control && [...control.options].some(option => Number(option.value) === defaultRosterId)) {
      control.value = String(defaultRosterId);
    }
  }
  const teamB = $('teamBSelect');
  if (teamB) {
    const partner = [...teamB.options].find(option => Number(option.value) !== defaultRosterId);
    if (partner) teamB.value = partner.value;
  }
  if ($('tradeTargetSideSelect')) $('tradeTargetSideSelect').value = 'A';

  state.selectedAssets = { A: [], B: [] };
  state.freeAgency.selectedPlayerId = '';
  renderEverything();
  scheduleTradeEvaluation(0);
  logStatus(validRosterId
    ? `${teamName(league, validRosterId)} is now your default team for ${league.name || league.league_id}.`
    : `Cleared the default team for ${league.name || league.league_id}.`);
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
  el.innerHTML = state.leagues.map(league => {
    const myTeamRosterId = savedMyTeamRosterId(league);
    const myTeamText = myTeamRosterId ? `My team: ${teamName(league, myTeamRosterId)}` : 'My team not set';
    return `<button class="league-card league-card-button ${String(league.league_id) === String(selected) ? 'active' : ''}" data-league-id="${escapeHtml(league.league_id)}"><strong>${escapeHtml(league.name || league.league_id)}</strong><small>${league.season} • ${league.total_rosters} teams • ${escapeHtml(myTeamText)} • ${Object.keys(league.matchupsByWeek || {}).length} weeks • ${league.historyLoadedSeasons?.length ? `stats ${league.historyLoadedSeasons.join(', ')}` : 'league data only'}</small></button>`;
  }).join('');
  el.querySelectorAll('[data-league-id]').forEach(card => card.addEventListener('click', () => selectLeagueAcrossApp(card.dataset.leagueId)));
}

function fillLeagueSelects() {
  const el = $('globalLeagueSelect');
  if (!el) return;
  const stored = localStorage.getItem(STORAGE_KEYS.selectedLeague);
  const previous = el.value || stored;
  el.innerHTML = state.leagues.length
    ? state.leagues.map(l => `<option value="${l.league_id}">${escapeHtml(l.name || l.league_id)}</option>`).join('')
    : '<option value="">No league loaded</option>';
  if (previous && state.leagues.some(l => String(l.league_id) === String(previous))) el.value = previous;
  fillMyTeamSelect();
  fillTeamSelects();
  fillLineupControls();
  fillFreeAgencyControls();
  fillRecapWeeks();
  fillPlayerSeasonSelect();
  fillDraftControls();
}

function fillTeamSelects() {
  const league = getSelectedLeague();
  fillRosterSelect($('teamASelect'), league);
  fillRosterSelect($('teamBSelect'), league, { preferMyTeam: false });
  const teamB = $('teamBSelect');
  if (teamB?.options.length > 1 && $('teamASelect')?.value === teamB.value) {
    const partner = [...teamB.options].find(option => option.value !== $('teamASelect').value);
    if (partner) teamB.value = partner.value;
  }
  fillTeamPlayerSelects();
}

function fillTeamPlayerSelects() {
  const league = getSelectedLeague();
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
    const playerOptions = players.map(row => `<option value="player:${escapeHtml(row.pid)}">${escapeHtml(row.value.name)} — ${escapeHtml(row.value.position)} · ${roundNum(row.value.value)} value · ${row.value.forecastPpg} forecast PPG</option>`).join('');
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

function draftSeasonNumber(draft, league) {
  return Number(
    draft?.season ||
    draft?.metadata?.season ||
    draft?.settings?.season ||
    league?.season ||
    currentSeasonNumber(league)
  );
}

function draftForSeason(league, season) {
  return (league?.drafts || []).filter(draft => Number(draftSeasonNumber(draft, league)) === Number(season));
}

function draftLooksComplete(league, draft) {
  const status = String(draft?.status || '').toLowerCase();
  if (['complete', 'completed'].includes(status)) return true;
  const draftId = draft?.draft_id;
  const picks = (league?.draftPicks || []).filter(pick => !draftId || String(pick.draft_id) === String(draftId));
  const teams = safeNumber(league?.total_rosters || league?.rosters?.length, 0);
  const rounds = safeNumber(draft?.settings?.rounds || league?.settings?.draft_rounds, 0);
  return Boolean(teams && rounds && picks.length >= teams * rounds);
}

function shouldShowDraftPickSeason(league, season) {
  const baseSeason = activeValuationSeason(league);
  if (Number(season) > Number(baseSeason)) return true;
  if (Number(season) < Number(baseSeason)) return false;
  if (Number(league?.season || 0) < Number(baseSeason)) return true;

  const seasonDrafts = draftForSeason(league, season);
  // Current-season rookie picks are tradeable before the draft. If there is no draft object yet, lean on league status.
  if (!seasonDrafts.length) {
    const status = String(league?.status || '').toLowerCase();
    return !['in_season', 'complete', 'post_season'].includes(status);
  }
  return !seasonDrafts.some(draft => draftLooksComplete(league, draft));
}

function pickSeasonList(league) {
  const baseSeason = activeValuationSeason(league);
  const seasons = [];
  for (let offset = 0; offset <= DRAFT_PICK_LOOKAHEAD_YEARS; offset += 1) {
    const season = baseSeason + offset;
    if (shouldShowDraftPickSeason(league, season)) seasons.push(season);
  }
  return seasons;
}

function pickCurrentOwnerFromSleeper(traded = {}) {
  return Number(
    traded.owner_id ||
    traded.new_owner_id ||
    traded.current_owner_id ||
    traded.currentOwnerId ||
    traded.ownerRosterId ||
    traded.owner_roster_id ||
    0
  );
}

function pickOriginalOwnerFromSleeper(traded = {}) {
  return Number(
    traded.roster_id ||
    traded.original_roster_id ||
    traded.originalRosterId ||
    traded.previous_owner_id ||
    traded.source_roster_id ||
    0
  );
}

function ownedPicksForRoster(league, ownerRosterId) {
  if (!league || !ownerRosterId) return [];
  const seasons = pickSeasonList(league);
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
    const originalRosterId = pickOriginalOwnerFromSleeper(traded);
    const currentOwnerId = pickCurrentOwnerFromSleeper(traded);
    if (!season || !round || !originalRosterId || !currentOwnerId) continue;
    if (!seasons.includes(season)) continue;
    const row = picks.find(pick => Number(pick.season) === season && Number(pick.round) === round && Number(pick.originalRosterId) === originalRosterId);
    if (row) row.currentOwnerId = currentOwnerId;
    else {
      picks.push({
        type: 'pick',
        season,
        round,
        originalRosterId,
        currentOwnerId
      });
    }
  }

  return picks
    .filter(pick => Number(pick.currentOwnerId) === Number(ownerRosterId))
    .sort((a, b) => Number(a.season) - Number(b.season) || Number(a.round) - Number(b.round) || Number(a.originalRosterId) - Number(b.originalRosterId));
}

function renderTeamNeedNotes() {
  const league = getSelectedLeague();
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

function playerRookieSeason(player = {}) {
  const candidates = [
    player.rookie_year,
    player.rookie_season,
    player.metadata?.rookie_year,
    player.metadata?.rookie_season,
    player.metadata?.draft_year,
    player.draft_year
  ];
  for (const candidate of candidates) {
    const season = Number(candidate);
    if (Number.isFinite(season) && season >= 2000 && season <= 2100) return season;
  }
  const yearsExperience = Number(player.years_exp);
  if (Number.isFinite(yearsExperience) && yearsExperience === 0) {
    return Number(state.projectionSeason || state.nflState?.season || new Date().getFullYear());
  }
  return 0;
}

function prospectDraftCapital(player = {}) {
  const metadata = player.metadata || {};
  const pick = safeNumber(
    player.draft_pick_no || player.draft_pick || player.pick_no || metadata.draft_pick_no || metadata.draft_pick || metadata.pick_no,
    0
  );
  const round = safeNumber(player.draft_round || metadata.draft_round || (pick ? Math.ceil(pick / 32) : 0), 0);
  if (pick > 0) {
    return {
      score: clamp01(1 - (pick - 1) / 255),
      label: `NFL pick ${displayNumber(pick, 0)}`,
      round,
      pick
    };
  }
  if (round > 0) {
    return {
      score: clamp01(1 - (round - 1) / 7),
      label: `NFL round ${displayNumber(round, 0)}`,
      round,
      pick: 0
    };
  }
  return { score: 0.28, label: 'Draft capital pending', round: 0, pick: 0 };
}

function teamPositionNeedScores(league, rosterId) {
  const profile = rosterNeedProfile(league, rosterId);
  const leagueProfiles = (league.rosters || []).map(roster => rosterNeedProfile(league, roster.roster_id));
  const scores = {};
  for (const position of POSITION_ORDER) {
    const required = safeNumber(profile[position]?.required, 0);
    if (!required) {
      scores[position] = 0;
      continue;
    }
    const count = safeNumber(profile[position]?.count, 0);
    const current = safeNumber(profile[position]?.value, 0);
    const median = medianOf(leagueProfiles.map(row => safeNumber(row[position]?.value, 0)));
    const shortage = clamp01((required - count) / Math.max(1, required));
    const qualityDeficit = median > 0 ? clamp01((median - current) / Math.max(1, median * 0.55)) : (current ? 0 : 0.5);
    const thinDepth = current <= safeNumber(profile[position]?.replacement, 0) * 1.08 ? 0.16 : 0;
    scores[position] = roundNum(clamp01(shortage * 0.56 + qualityDeficit * 0.52 + thinDepth), 3);
  }
  return scores;
}

function availableDraftSeasons(league) {
  if (!league) return [];
  const base = activeValuationSeason(league);
  const likelyNext = pickSeasonList(league)[0] || base;
  const seasons = new Set([base, likelyNext, base + 1]);
  Object.values(state.players || {}).forEach(player => {
    const season = playerRookieSeason(player);
    if (season >= base - 1 && season <= base + 2) seasons.add(season);
  });
  return [...seasons].filter(Boolean).sort((a, b) => a - b);
}

function preferredDraftForSeason(league, season) {
  const drafts = draftForSeason(league, season);
  if (!drafts.length) return null;
  const priority = { drafting: 0, pre_draft: 1, paused: 2, complete: 3, completed: 3 };
  const primaryDraftId = String(league?.draft_id || '');
  return drafts.slice().sort((a, b) => {
    const aPrimary = primaryDraftId && String(a?.draft_id || '') === primaryDraftId ? 0 : 1;
    const bPrimary = primaryDraftId && String(b?.draft_id || '') === primaryDraftId ? 0 : 1;
    if (aPrimary !== bPrimary) return aPrimary - bPrimary;
    const aStatus = priority[String(a?.status || '').toLowerCase()] ?? 2;
    const bStatus = priority[String(b?.status || '').toLowerCase()] ?? 2;
    if (aStatus !== bStatus) return aStatus - bStatus;
    const aOrderCount = Math.max(
      Object.keys(a?.slot_to_roster_id || a?.slotToRosterId || a?.metadata?.slot_to_roster_id || {}).length,
      Object.keys(a?.draft_order || a?.draftOrder || {}).length
    );
    const bOrderCount = Math.max(
      Object.keys(b?.slot_to_roster_id || b?.slotToRosterId || b?.metadata?.slot_to_roster_id || {}).length,
      Object.keys(b?.draft_order || b?.draftOrder || {}).length
    );
    if (aOrderCount !== bOrderCount) return bOrderCount - aOrderCount;
    return safeNumber(b?.created || b?.start_time, 0) - safeNumber(a?.created || a?.start_time, 0);
  })[0];
}

function draftTypeForSeason(league, season) {
  const draft = preferredDraftForSeason(league, season);
  const raw = String(draft?.type || draft?.settings?.draft_type || draft?.settings?.type || 'linear').toLowerCase();
  return raw.includes('snake') ? 'snake' : 'linear';
}

function rosterForDraftIdentity(league, identity) {
  const key = String(identity || '');
  if (!key) return null;
  return (league?.rosters || []).find(roster => {
    if (String(roster.roster_id) === key || String(roster.owner_id) === key) return true;
    return (roster.co_owners || []).some(ownerId => String(ownerId) === key);
  }) || null;
}

function draftSlotMapForSeason(league, season) {
  const teamCount = Math.max(1, safeNumber(league?.total_rosters, league?.rosters?.length || 1));
  const draft = preferredDraftForSeason(league, season);
  const slotToRoster = new Map();
  const exactSlots = new Set();
  const directMap = draft?.slot_to_roster_id || draft?.slotToRosterId || draft?.metadata?.slot_to_roster_id || {};

  for (const [slotRaw, rosterRaw] of Object.entries(directMap)) {
    const slot = Number(slotRaw);
    const rosterId = Number(rosterRaw);
    if (!slot || !rosterId || slot > teamCount) continue;
    slotToRoster.set(slot, rosterId);
    exactSlots.add(slot);
  }

  const draftOrder = draft?.draft_order || draft?.draftOrder || {};
  for (const [identity, slotRaw] of Object.entries(draftOrder)) {
    const slot = Number(slotRaw);
    const roster = rosterForDraftIdentity(league, identity);
    if (!slot || !roster || slot > teamCount || slotToRoster.has(slot)) continue;
    slotToRoster.set(slot, Number(roster.roster_id));
    exactSlots.add(slot);
  }

  const assignedRosters = new Set(slotToRoster.values());
  const projectedRosters = (league?.rosters || [])
    .filter(roster => !assignedRosters.has(Number(roster.roster_id)))
    .sort((a, b) => teamStrengthRank(league, a.roster_id) - teamStrengthRank(league, b.roster_id));
  const emptySlots = Array.from({ length: teamCount }, (_, index) => index + 1).filter(slot => !slotToRoster.has(slot));
  emptySlots.forEach((slot, index) => {
    const roster = projectedRosters[index];
    if (roster) slotToRoster.set(slot, Number(roster.roster_id));
  });

  return { draft, teamCount, slotToRoster, exactSlots };
}

function currentOwnerForDraftPick(league, season, round, originalRosterId) {
  let currentOwnerId = Number(originalRosterId);
  for (const traded of league?.tradedPicks || []) {
    if (Number(traded.season) !== Number(season) || Number(traded.round) !== Number(round)) continue;
    if (pickOriginalOwnerFromSleeper(traded) !== Number(originalRosterId)) continue;
    const nextOwner = pickCurrentOwnerFromSleeper(traded);
    if (nextOwner) currentOwnerId = nextOwner;
  }
  return currentOwnerId;
}

function draftSelectionRows(league, season) {
  if (!league || !season) return [];
  const { draft, teamCount, slotToRoster, exactSlots } = draftSlotMapForSeason(league, season);
  const rounds = Math.max(1, Math.min(10, safeNumber(draft?.settings?.rounds || league?.settings?.draft_rounds, 5)));
  const draftType = draftTypeForSeason(league, season);
  const draftId = draft?.draft_id;
  const completedPicks = (league?.draftPicks || []).filter(pick => {
    if (draftId && pick?.draft_id) return String(pick.draft_id) === String(draftId);
    return Number(pick?.season || pick?.metadata?.season || season) === Number(season);
  });
  const completedByPickNo = new Map(completedPicks
    .filter(pick => safeNumber(pick.pick_no, 0) > 0)
    .map(pick => [Number(pick.pick_no), pick]));
  const rows = [];

  for (let round = 1; round <= rounds; round += 1) {
    const slots = Array.from({ length: teamCount }, (_, index) => index + 1);
    if (draftType === 'snake' && round % 2 === 0) slots.reverse();
    slots.forEach((slot, roundIndex) => {
      const overallPick = (round - 1) * teamCount + roundIndex + 1;
      const originalRosterId = Number(slotToRoster.get(slot) || 0);
      if (!originalRosterId) return;
      const completed = completedByPickNo.get(overallPick)
        || completedPicks.find(pick => Number(pick.round) === round && Number(pick.draft_slot) === slot)
        || null;
      rows.push({
        season: Number(season),
        round,
        slot,
        roundPick: roundIndex + 1,
        overallPick,
        pickLabel: `${round}.${String(roundIndex + 1).padStart(2, '0')}`,
        originalRosterId,
        currentOwnerId: currentOwnerForDraftPick(league, season, round, originalRosterId),
        exact: exactSlots.has(slot),
        draftType,
        selectedPlayerId: completed?.player_id ? String(completed.player_id) : '',
        selectedPick: completed
      });
    });
  }
  return rows;
}

function teamDraftCapitalForSeason(league, rosterId, season) {
  const picks = draftSelectionRows(league, season)
    .filter(pick => Number(pick.currentOwnerId) === Number(rosterId) && !pick.selectedPlayerId)
    .map(pick => {
      const valuation = pickValue(league, {
        season: pick.season,
        round: pick.round,
        originalRosterId: pick.originalRosterId
      });
      return { ...pick, value: valuation.value, valuation };
    });
  return {
    picks,
    totalValue: picks.reduce((sum, pick) => sum + safeNumber(pick.value, 0), 0),
    exactCount: picks.filter(pick => pick.exact).length,
    projectedCount: picks.filter(pick => !pick.exact).length
  };
}

function draftProspectCandidates(league, season) {
  const targetSeason = Number(season);
  const rostered = new Set((league.rosters || []).flatMap(roster => roster.players || []).map(String));
  const drafted = new Set((league.draftPicks || [])
    .filter(pick => Number(pick?.season || pick?.metadata?.season || targetSeason) === targetSeason)
    .map(pick => String(pick?.player_id || ''))
    .filter(Boolean));
  const activePositions = activeLeaguePositions(league);
  return Object.values(state.players || {})
    .filter(player => player?.player_id && !rostered.has(String(player.player_id)) && !drafted.has(String(player.player_id)))
    .filter(player => player.active !== false)
    .filter(player => playerRookieSeason(player) === targetSeason)
    .filter(player => activePositions.has(playerPrimaryPosition(player.player_id)))
    .filter(player => {
      const rank = safeNumber(player.search_rank, 99999);
      const projection = state.projections.get(String(player.player_id));
      const capital = prospectDraftCapital(player);
      return Boolean(projection || rank < 2500 || capital.round || capital.pick || player.college);
    });
}

function scoredDraftProspectsForTeam(league, rosterId, season, positionFilter = 'NEED') {
  if (!league || !rosterId) return [];
  const needScores = teamPositionNeedScores(league, rosterId);
  const candidates = draftProspectCandidates(league, season)
    .map(player => {
      const playerId = String(player.player_id);
      const position = playerPrimaryPosition(playerId);
      const value = playerValue(league, playerId);
      const projection = league.projectionModel?.players?.get(playerId) || null;
      const capital = prospectDraftCapital(player);
      const searchRank = safeNumber(player.search_rank, 2500);
      const marketScore = clamp01(safeNumber(value.value, 0) / 8500);
      const projectionScore = projection
        ? clamp01(safeNumber(projection.percentile, 0) * 0.68 + safeNumber(projection.efficiencyPercentile, 0.5) * 0.32)
        : (value.marketAdp ? 0.46 : 0.18);
      const discoveryScore = clamp01(1 - (searchRank - 1) / 2499);
      const potentialScore = clamp01(marketScore * 0.43 + projectionScore * 0.27 + capital.score * 0.20 + discoveryScore * 0.10);
      const needScore = safeNumber(needScores[position], 0);
      const needWeight = positionFilter === 'NEED' ? 0.30 : 0.13;
      const fitScore = roundNum((potentialScore * (1 - needWeight) + needScore * needWeight) * 100, 1);
      const reasons = [];
      if (needScore >= 0.7) reasons.push(`Major ${position} need`);
      else if (needScore >= 0.4) reasons.push(`${position} need`);
      if (value.marketAdp) reasons.push(`ADP ${displayNumber(value.marketAdp)}`);
      if (projection?.positionRank) reasons.push(`Proj. ${position}${projection.positionRank}`);
      if (capital.round || capital.pick) reasons.push(capital.label);
      if (position === 'TE' && isTightEndPremium(league)) reasons.push('TE premium fit');
      if (position === 'QB' && isSuperflexLeague(league)) reasons.push('Superflex fit');
      if (!reasons.length) reasons.push('Developmental profile');
      return {
        playerId,
        name: playerName(playerId),
        position,
        team: player.team || 'TBD',
        college: player.college || player.metadata?.college || '',
        age: safeNumber(player.age, 0) || '',
        value: safeNumber(value.value, 0),
        marketAdp: value.marketAdp,
        forecastPpg: safeNumber(value.forecastPpg, 0),
        projectionRank: projection?.positionRank || null,
        potentialScore: roundNum(potentialScore * 100, 1),
        needScore: roundNum(needScore * 100, 1),
        fitScore,
        confidence: value.confidence,
        capital,
        reasons
      };
    });

  const consensusRanks = new Map(candidates.slice()
    .sort((a, b) => b.potentialScore - a.potentialScore || b.value - a.value || safeNumber(a.marketAdp, 9999) - safeNumber(b.marketAdp, 9999))
    .map((prospect, index) => [prospect.playerId, index + 1]));
  candidates.forEach(prospect => { prospect.draftRank = consensusRanks.get(prospect.playerId) || candidates.length; });
  return candidates
    .filter(prospect => positionFilter === 'ALL' || positionFilter === 'NEED' || prospect.position === positionFilter)
    .sort((a, b) => b.fitScore - a.fitScore || b.potentialScore - a.potentialScore || b.value - a.value);
}

function draftRecommendationsForTeam(league, rosterId, season, positionFilter = 'NEED', limit = 5) {
  return scoredDraftProspectsForTeam(league, rosterId, season, positionFilter)
    .slice(0, Math.max(1, safeNumber(limit, 5)));
}

function draftAvailabilityLabel(percent) {
  if (percent >= 75) return 'Likely';
  if (percent >= 50) return 'In range';
  if (percent >= 30) return 'Possible';
  return 'Long shot';
}

function seededDraftRandom(seedValue) {
  let seed = Number(seedValue) >>> 0;
  if (!seed) seed = 0x9e3779b9;
  return () => {
    seed += 0x6d2b79f5;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function draftSeedFromText(textValue) {
  let hash = 2166136261;
  for (const char of String(textValue || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function draftAvailabilityForTeam(league, rosterId, season, positionFilter = 'NEED', perPick = 3, simulationCount = DRAFT_AVAILABILITY_SIMULATIONS) {
  if (!league || !rosterId || !season) return { capital: { picks: [], totalValue: 0, exactCount: 0, projectedCount: 0 }, groups: [], simulations: 0 };
  const schedule = draftSelectionRows(league, season);
  const capital = teamDraftCapitalForSeason(league, rosterId, season);
  if (!capital.picks.length) return { capital, groups: [], simulations: 0 };

  const targetProfiles = scoredDraftProspectsForTeam(league, rosterId, season, positionFilter);
  const fullTargetProfiles = scoredDraftProspectsForTeam(league, rosterId, season, 'ALL');
  if (!fullTargetProfiles.length) return { capital, groups: capital.picks.map(pick => ({ pick, options: [] })), simulations: 0 };

  const maxTargetPick = Math.max(...capital.picks.map(pick => pick.overallPick));
  const poolLimit = Math.min(220, Math.max(90, maxTargetPick + 40));
  const poolIds = new Set(fullTargetProfiles.slice(0, poolLimit).map(prospect => prospect.playerId));
  targetProfiles.slice(0, 45).forEach(prospect => poolIds.add(prospect.playerId));
  const pool = fullTargetProfiles.filter(prospect => poolIds.has(prospect.playerId));
  const fullTargetById = new Map(fullTargetProfiles.map(prospect => [prospect.playerId, prospect]));
  const targetById = new Map(targetProfiles.map(prospect => [prospect.playerId, prospect]));
  const ownerProfiles = new Map();
  for (const roster of league.rosters || []) {
    const scored = scoredDraftProspectsForTeam(league, roster.roster_id, season, 'ALL');
    ownerProfiles.set(Number(roster.roster_id), new Map(scored.map(prospect => [prospect.playerId, prospect])));
  }

  const targetPickNumbers = new Set(capital.picks.map(pick => pick.overallPick));
  const availabilityCounts = new Map(capital.picks.map(pick => [pick.overallPick, new Map()]));
  const simulations = Math.max(30, Math.min(500, safeNumber(simulationCount, DRAFT_AVAILABILITY_SIMULATIONS)));
  const baseSeed = draftSeedFromText(`${league.league_id || 'league'}:${season}:${rosterId}:${pool.length}`);

  for (let simulation = 0; simulation < simulations; simulation += 1) {
    const random = seededDraftRandom(baseSeed + simulation * 2654435761);
    const available = new Set(pool.map(prospect => prospect.playerId));
    const draftedByOwner = new Map();

    for (const pick of schedule) {
      if (pick.selectedPlayerId) {
        available.delete(pick.selectedPlayerId);
        const ownerId = Number(pick.currentOwnerId);
        const position = playerPrimaryPosition(pick.selectedPlayerId);
        const positionCounts = draftedByOwner.get(ownerId) || new Map();
        positionCounts.set(position, safeNumber(positionCounts.get(position), 0) + 1);
        draftedByOwner.set(ownerId, positionCounts);
        continue;
      }
      if (pick.overallPick > maxTargetPick || !available.size) break;

      if (targetPickNumbers.has(pick.overallPick) && Number(pick.currentOwnerId) === Number(rosterId)) {
        const counts = availabilityCounts.get(pick.overallPick);
        for (const playerId of available) {
          if (!targetById.has(playerId)) continue;
          counts.set(playerId, safeNumber(counts.get(playerId), 0) + 1);
        }
      }

      const ownerId = Number(pick.currentOwnerId);
      const ownerBoard = ownerProfiles.get(ownerId) || ownerProfiles.get(Number(rosterId));
      const positionCounts = draftedByOwner.get(ownerId) || new Map();
      let selectedId = '';
      let selectedScore = -Infinity;

      for (const playerId of available) {
        const prospect = ownerBoard?.get(playerId) || fullTargetById.get(playerId);
        if (!prospect) continue;
        const alreadyDraftedAtPosition = safeNumber(positionCounts.get(prospect.position), 0);
        const diversificationPenalty = alreadyDraftedAtPosition * (prospect.position === 'QB' && isSuperflexLeague(league) ? 2.3 : 4.2);
        const confidenceNoise = prospect.confidence === 'Low' ? 2.5 : prospect.confidence === 'Medium' ? 1.2 : 0;
        const uncertainty = 4.2 + Math.min(5.5, pick.overallPick * 0.09) + confidenceNoise;
        const centeredNoise = ((random() + random() + random() + random()) - 2) * uncertainty;
        const score = prospect.potentialScore * 0.76 + prospect.needScore * 0.24 - diversificationPenalty + centeredNoise;
        if (score > selectedScore) {
          selectedScore = score;
          selectedId = playerId;
        }
      }

      if (selectedId) {
        available.delete(selectedId);
        const selected = ownerBoard?.get(selectedId) || targetById.get(selectedId);
        if (selected) positionCounts.set(selected.position, safeNumber(positionCounts.get(selected.position), 0) + 1);
        draftedByOwner.set(ownerId, positionCounts);
      }
    }
  }

  const groups = capital.picks.map(pick => {
    const counts = availabilityCounts.get(pick.overallPick) || new Map();
    const options = targetProfiles.map(prospect => {
      const availability = roundNum((safeNumber(counts.get(prospect.playerId), 0) / simulations) * 100, 0);
      const reachRounds = Math.max(0, prospect.draftRank - pick.overallPick - safeNumber(league.total_rosters, league.rosters?.length || 1));
      const targetScore = prospect.fitScore * 0.62 + prospect.potentialScore * 0.18 + availability * 0.20 - reachRounds * 0.45;
      return { ...prospect, availability, availabilityLabel: draftAvailabilityLabel(availability), targetScore };
    })
      .filter(prospect => prospect.availability >= 18)
      .sort((a, b) => b.targetScore - a.targetScore || b.fitScore - a.fitScore || a.draftRank - b.draftRank)
      .slice(0, Math.max(1, safeNumber(perPick, 3)));
    return { pick, options };
  });

  return { capital, groups, simulations };
}

function fillDraftControls() {
  const teamSelect = $('draftTeamSelect');
  const seasonSelect = $('draftSeasonSelect');
  if (!teamSelect || !seasonSelect) return;
  const league = getSelectedLeague();
  const previousSeason = Number(seasonSelect.value);
  fillRosterSelect(teamSelect, league);

  const seasons = availableDraftSeasons(league);
  seasonSelect.innerHTML = seasons.length
    ? seasons.map(season => `<option value="${season}">${season} rookie class</option>`).join('')
    : '<option value="">No class available</option>';
  if (previousSeason && seasons.includes(previousSeason)) seasonSelect.value = String(previousSeason);
  else if (league) seasonSelect.value = String(pickSeasonList(league)[0] || activeValuationSeason(league));
  renderDraftRecommendations();
}

function draftPickDisplayLabel(pick) {
  return `${pick?.exact ? '' : '~'}${pick?.pickLabel || 'Pick'}`;
}

function renderDraftProspectCard(prospect, index) {
  return `
    <article class="prospect-card">
      <span class="prospect-rank">${index + 1}</span>
      <div class="prospect-card-copy">
        <h4>${escapeHtml(prospect.name)}</h4>
        <p class="prospect-meta">${escapeHtml(prospect.position)} · ${escapeHtml(prospect.team)}${prospect.college ? ` · ${escapeHtml(prospect.college)}` : ''}${prospect.age ? ` · age ${escapeHtml(prospect.age)}` : ''}</p>
        <div class="prospect-reasons"><span class="badge">Class #${displayNumber(prospect.draftRank, 0)}</span>${prospect.reasons.slice(0, 3).map(reason => `<span class="badge">${escapeHtml(reason)}</span>`).join('')}</div>
        <p class="prospect-note">Potential ${displayNumber(prospect.potentialScore)} · Need ${displayNumber(prospect.needScore)} · ${escapeHtml(prospect.confidence)} data confidence</p>
      </div>
      <div class="fit-score"><span>Team fit</span><strong>${displayNumber(prospect.fitScore)}</strong></div>
    </article>`;
}

function renderDraftCapitalSummary(capital) {
  if (!capital?.picks?.length) return '';
  const exactText = capital.projectedCount
    ? `${capital.projectedCount} projected position${capital.projectedCount === 1 ? '' : 's'}`
    : 'Exact draft order loaded';
  return `
    <div class="draft-capital-heading">
      <span>Owned capital</span>
      <strong>${capital.picks.length} pick${capital.picks.length === 1 ? '' : 's'} · ${displayNumber(capital.totalValue, 0)} value</strong>
    </div>
    <div class="draft-pick-chips">${capital.picks.map(pick => `<span class="draft-pick-chip${pick.exact ? '' : ' projected'}">${escapeHtml(draftPickDisplayLabel(pick))}</span>`).join('')}</div>
    <p>${escapeHtml(exactText)}</p>`;
}

function renderDraftAvailabilityGroup(group, league, rosterId) {
  const pick = group.pick;
  const originalTeam = teamName(league, pick.originalRosterId);
  const acquired = Number(pick.originalRosterId) !== Number(rosterId);
  const pickMeta = `${pick.exact ? 'Exact position' : 'Projected position'}${acquired ? ` · via ${originalTeam}` : ''} · ${displayNumber(pick.value, 0)} pick value`;
  return `
    <section class="pick-availability-group">
      <div class="pick-availability-heading">
        <div><span class="pick-number">${escapeHtml(draftPickDisplayLabel(pick))}</span><span class="pick-round-label">Round ${pick.round}</span></div>
        <small>${escapeHtml(pickMeta)}</small>
      </div>
      <div class="pick-options">
        ${group.options.length ? group.options.map(prospect => `
          <article class="availability-player">
            <div class="availability-player-topline">
              <div>
                <h4>${escapeHtml(prospect.name)}</h4>
                <p>${escapeHtml(prospect.position)} · ${escapeHtml(prospect.team)} · Class #${displayNumber(prospect.draftRank, 0)}</p>
              </div>
              <div class="availability-percent"><strong>${displayNumber(prospect.availability, 0)}%</strong><span>${escapeHtml(prospect.availabilityLabel)}</span></div>
            </div>
            <div class="availability-track" aria-label="${displayNumber(prospect.availability, 0)} percent chance of being available"><span style="width:${clampNumber(prospect.availability, 0, 100)}%"></span></div>
            <div class="availability-player-footer"><span>Fit ${displayNumber(prospect.fitScore)}</span><span>Potential ${displayNumber(prospect.potentialScore)}</span></div>
          </article>`).join('') : '<p class="pick-options-empty">No prospect cleared the model’s availability threshold at this pick.</p>'}
      </div>
    </section>`;
}

function renderDraftRecommendations() {
  const summary = $('draftNeedsSummary');
  const output = $('draftRecommendations');
  const status = $('draftDataStatus');
  const capitalOutput = $('draftCapitalSummary');
  const availabilityOutput = $('draftAvailability');
  const availabilityStatus = $('draftAvailabilityStatus');
  if (!summary || !output || !capitalOutput || !availabilityOutput) return;
  const league = getSelectedLeague();
  const rosterId = Number($('draftTeamSelect')?.value);
  const season = Number($('draftSeasonSelect')?.value);
  const positionFilter = $('draftPositionFilter')?.value || 'NEED';
  if (!league || !rosterId || !season) {
    summary.className = 'draft-needs-summary empty';
    summary.textContent = 'Load a league to build a team-specific draft board.';
    output.className = 'prospect-grid empty';
    output.textContent = 'Rookie targets will appear here.';
    capitalOutput.className = 'draft-capital-summary empty';
    capitalOutput.textContent = 'Load a league to map this team’s picks.';
    availabilityOutput.className = 'draft-availability empty';
    availabilityOutput.textContent = 'Likely options will appear here.';
    if (status) status.textContent = 'Waiting for league';
    if (availabilityStatus) availabilityStatus.textContent = 'Waiting for picks';
    return;
  }

  const needs = teamPositionNeedScores(league, rosterId);
  const activeNeeds = Object.entries(needs)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1]);
  const topNeeds = activeNeeds.slice(0, 4).map(([position, score]) => `${position} ${displayNumber(score * 100, 0)}%`).join(' · ');
  summary.className = 'draft-needs-summary';
  summary.innerHTML = `<strong>${escapeHtml(teamName(league, rosterId))}</strong> · ${topNeeds ? `Priority needs: ${escapeHtml(topNeeds)}` : 'No major positional need detected; ranking best available.'}`;

  const allCandidates = draftProspectCandidates(league, season);
  const recommendations = draftRecommendationsForTeam(league, rosterId, season, positionFilter, 5);
  const availability = draftAvailabilityForTeam(league, rosterId, season, positionFilter, 3);
  if (status) status.textContent = `${allCandidates.length} ${season} rookies found`;
  if (!recommendations.length) {
    output.className = 'prospect-grid empty';
    const positionText = !['ALL', 'NEED'].includes(positionFilter) ? ` ${positionFilter}` : '';
    output.textContent = `No unrostered ${season}${positionText} prospects with usable Sleeper data were found yet.`;
  } else {
    output.className = 'prospect-grid';
    output.innerHTML = recommendations.map(renderDraftProspectCard).join('');
  }

  if (!availability.capital.picks.length) {
    capitalOutput.className = 'draft-capital-summary empty';
    capitalOutput.textContent = `${teamName(league, rosterId)} has no remaining ${season} picks found in Sleeper.`;
    availabilityOutput.className = 'draft-availability empty';
    availabilityOutput.textContent = 'Acquire a pick or select another draft class to see likely options.';
    if (availabilityStatus) availabilityStatus.textContent = 'No remaining picks';
    return;
  }

  capitalOutput.className = 'draft-capital-summary';
  capitalOutput.innerHTML = renderDraftCapitalSummary(availability.capital);
  availabilityOutput.className = 'draft-availability';
  availabilityOutput.innerHTML = availability.groups.map(group => renderDraftAvailabilityGroup(group, league, rosterId)).join('');
  if (availabilityStatus) {
    availabilityStatus.textContent = `${availability.capital.picks.length} pick${availability.capital.picks.length === 1 ? '' : 's'} · ${availability.simulations || 0} simulations`;
  }
}

function fillPlayerSeasonSelect() {
  const league = getSelectedLeague();
  const el = $('playerStatsSeasonSelect');
  if (!el) return;
  const previous = el.value;
  const seasons = league?.historyLoadedSeasons?.length ? league.historyLoadedSeasons : historicalSeasonsToLoad(league || {});
  el.innerHTML = `<option value="auto">Best available</option><option value="league">League matchup data</option>` + seasons.map(season => `<option value="${season}">${season} NFL stats</option>`).join('');
  if ([...el.options].some(o => o.value === previous)) el.value = previous;
}

function selectLeagueAcrossApp(leagueId) {
  if (!leagueId) return;
  const previousLeagueId = $('globalLeagueSelect')?.value || localStorage.getItem(STORAGE_KEYS.selectedLeague);
  if (previousLeagueId && String(previousLeagueId) !== String(leagueId)) {
    state.selectedAssets = { A: [], B: [] };
    state.freeAgency.selectedPlayerId = '';
  }
  localStorage.setItem(STORAGE_KEYS.selectedLeague, leagueId);
  const selector = $('globalLeagueSelect');
  if (selector && [...selector.options].some(option => String(option.value) === String(leagueId))) selector.value = leagueId;
  renderEverything();
}


function activateTab(tabId) {
  document.querySelectorAll('.tab').forEach(tab => {
    const active = tab.dataset.tab === tabId;
    tab.classList.toggle('active', active);
    if (active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
  document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === tabId));
  if (tabId === 'lineup') renderRecommendedLineup();
  if (tabId === 'free-agency') renderFreeAgencyAnalyzer();
  if (tabId === 'draft') renderDraftRecommendations();
  if (tabId === 'recaps') scheduleRecapGeneration(0);
}

function ownerRosterForPlayer(league, playerId) {
  const pid = String(playerId);
  return (league?.rosters || []).find(roster => (roster.players || []).map(String).includes(pid)) || null;
}

function sendPlayerToTrade(playerId, leagueId) {
  const league = state.leagues.find(l => String(l.league_id) === String(leagueId)) || getSelectedLeague();
  if (!league) {
    alert('Load a league before adding a player to a trade.');
    return;
  }

  selectLeagueAcrossApp(league.league_id);

  const roster = ownerRosterForPlayer(league, playerId);
  let side = 'A';
  if (roster && $('teamASelect')) {
    const teamA = $('teamASelect');
    const teamB = $('teamBSelect');
    const ownerRosterId = Number(roster.roster_id);
    const myTeamRosterId = savedMyTeamRosterId(league);
    const desiredTeamA = myTeamRosterId && myTeamRosterId !== ownerRosterId ? myTeamRosterId : ownerRosterId;
    let desiredTeamB = Number(teamB?.value || 0);

    if (myTeamRosterId && myTeamRosterId !== ownerRosterId) {
      desiredTeamB = ownerRosterId;
      side = 'B';
    } else if (desiredTeamB === desiredTeamA) {
      desiredTeamB = Number([...(teamB?.options || [])].find(option => Number(option.value) !== desiredTeamA)?.value || 0);
    }

    const teamsChanged = Number(teamA.value) !== desiredTeamA || Number(teamB?.value || 0) !== desiredTeamB;
    if (teamsChanged) state.selectedAssets = { A: [], B: [] };
    teamA.value = String(desiredTeamA);
    if (teamB && desiredTeamB) teamB.value = String(desiredTeamB);
    fillTeamPlayerSelects();
  }

  const asset = { type: 'player', playerId: String(playerId) };
  const key = assetKey(asset);
  if (!state.selectedAssets[side].some(existing => assetKey(existing) === key)) {
    state.selectedAssets[side].push(asset);
  }
  const playerSelect = $(side === 'A' ? 'teamAPlayerSelect' : 'teamBPlayerSelect');
  const playerSearch = $(side === 'A' ? 'teamAPlayerSearch' : 'teamBPlayerSearch');
  if (playerSelect && [...playerSelect.options].some(option => option.value === `player:${playerId}`)) {
    playerSelect.value = `player:${playerId}`;
  }
  if (playerSearch) playerSearch.value = '';
  renderAssetList('A');
  renderAssetList('B');

  const result = $('tradeResult');
  if (result) {
    result.className = 'trade-result empty';
    result.textContent = `${playerName(playerId)} was added to Team ${side}. Add the other side and the analysis will update automatically.`;
  }
  scheduleTradeEvaluation();
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
  const league = getSelectedLeague();
  const previous = $('recapWeekSelect')?.value;
  const weeks = league ? Object.keys(league.matchupsByWeek).map(Number).sort((a, b) => a - b) : [];
  $('recapWeekSelect').innerHTML = weeks.length
    ? weeks.map(w => `<option value="${w}">Week ${w}</option>`).join('')
    : '<option value="">No scored weeks loaded</option>';
  if (previous && weeks.includes(Number(previous))) $('recapWeekSelect').value = previous;
  else if (weeks.length) $('recapWeekSelect').value = String(weeks[weeks.length - 1]);
  scheduleRecapGeneration();
}

function getSelectedLeague() {
  const id = $('globalLeagueSelect')?.value || localStorage.getItem(STORAGE_KEYS.selectedLeague) || state.leagues[0]?.league_id;
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

function scheduleRecapGeneration(delay = 90) {
  if (typeof document === 'undefined' || !$('recapOutput')) return;
  clearTimeout(recapGenerationTimer);
  recapGenerationTimer = setTimeout(() => generateRecap(), delay);
}

function generateRecap() {
  const league = getSelectedLeague();
  if (!league) {
    if ($('recapOutput')) $('recapOutput').value = '';
    return;
  }
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

  if (!weeks.length) {
    $('recapOutput').value = `${league.name}\n\nNo scored matchup weeks are available for this recap range yet.`;
    return;
  }

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
        const margin = displayNumber(safeNumber(winner.points) - safeNumber(loser.points));
        const topWinner = topPlayersForMatchup(winner, 3);
        const topLoser = topPlayersForMatchup(loser, 2);
        const winnerBench = benchNotes(league, winner, week);
        const loserBench = benchNotes(league, loser, week);
        matchupLines.push(`- ${teamName(league, winner.roster_id)} beat ${teamName(league, loser.roster_id)} ${displayNumber(winner.points)}-${displayNumber(loser.points)} by ${margin}.`);
        matchupLines.push(`  - ${teamName(league, winner.roster_id)} top starters: ${topWinner}. ${winnerBench}`);
        matchupLines.push(`  - ${teamName(league, loser.roster_id)} top starters: ${topLoser}. ${loserBench}`);
      } else {
        pair.forEach(m => matchupLines.push(`- ${teamName(league, m.roster_id)} scored ${displayNumber(m.points)}.`));
      }
    });
    lines.push(...(matchupLines.length ? matchupLines : ['- No matchup data available.']));

    const weeklyTop = topLeaguePlayers(league, week, 10);
    lines.push('');
    lines.push('### Top individual performances');
    weeklyTop.forEach((p, idx) => lines.push(`${idx + 1}. ${p.name} (${p.pos}) — ${displayNumber(p.points)} points for ${teamName(league, p.rosterId)}${p.started ? '' : ' [BENCH]'}`));

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
  lines.push(`- Waiver/FAAB settings JSON: ${displayJson({waiver_type: league.settings?.waiver_type, waiver_budget: league.settings?.waiver_budget, waiver_clear_days: league.settings?.waiver_clear_days})}`);
  lines.push(`- Scoring settings JSON: ${displayJson(league.scoring_settings || {})}`);
  lines.push('');
}

function appendStandingsSnapshot(lines, league) {
  lines.push('## Standings snapshot');
  [...league.rosters].sort((a, b) => safeNumber(b.settings?.wins) - safeNumber(a.settings?.wins) || totalFpts(b.settings) - totalFpts(a.settings)).forEach((r, idx) => {
    lines.push(`${idx + 1}. ${teamName(league, r.roster_id)} — ${safeNumber(r.settings?.wins)}-${safeNumber(r.settings?.losses)}-${safeNumber(r.settings?.ties)}, PF ${displayNumber(totalFpts(r.settings))}, PA ${displayNumber(totalAgainst(r.settings))}, moves ${safeNumber(r.settings?.total_moves)}`);
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
    preferences: {
      selectedLeagueId: localStorage.getItem(STORAGE_KEYS.selectedLeague) || '',
      myTeamByLeague: { ...state.myTeamByLeague }
    },
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
    if (!state.projections.size || Number(state.projectionSeason) !== activeValuationSeason()) {
      try {
        await loadProjections();
      } catch (err) {
        logStatus(`Projection warning: ${err.message}. Falling back to market rank and production.`);
        console.warn(err);
      }
    }
    const lineupPeriod = upcomingLineupPeriod();
    const needsWeeklyProjectionRefresh = !state.weeklyProjectionMeta
      || Number(state.weeklyProjectionMeta.season) !== Number(lineupPeriod.season)
      || Number(state.weeklyProjectionMeta.week) !== Number(lineupPeriod.week);
    if (needsWeeklyProjectionRefresh) {
      try {
        await loadWeeklyProjections();
      } catch (err) {
        state.weeklyProjections = new Map();
        state.weeklySchedule = new Map();
        state.weeklyProjectionMeta = { ...lineupPeriod, rows: 0, source: 'season-fallback', savedAt: Date.now() };
        state.weeklyProjectionError = err.message;
        logStatus(`Weekly lineup projection warning: ${err.message}. Using season forecast fallback.`);
        console.warn(err);
      }
    }

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
    state.freeAgency.selectedPlayerId = '';
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
  renderRecommendedLineup();
  renderAssetList('A');
  renderAssetList('B');
  renderTradeTargetSuggestions();
  renderFreeAgencyAnalyzer();
  updateDynastyOnlyControls();
}

function applyModelSettingsFromUI() {
  const settingIds = ['ageWeight', 'recentWeight', 'projectionWeight', 'efficiencyWeight', 'needWeight', 'pickWeight'];
  settingIds.forEach(id => {
    if ($(id)) state.settings[id] = Number($(id).value);
  });
  saveSettings();
  for (const league of state.leagues) {
    league.valueCache.clear();
    buildTeamStrength(league);
  }
  renderTables();
  renderRecommendedLineup();
  renderAssetList('A');
  renderAssetList('B');
  renderTradeTargetSuggestions();
  renderFreeAgencyAnalyzer();
  renderDraftRecommendations();
  const status = $('modelSaveStatus');
  if (status) status.textContent = 'Saved';
}

function scheduleModelSettingsUpdate(delay = 180) {
  const status = $('modelSaveStatus');
  if (status) status.textContent = 'Applying…';
  clearTimeout(modelSettingsTimer);
  modelSettingsTimer = setTimeout(() => applyModelSettingsFromUI(), delay);
}

async function copyRecapOutput() {
  const output = $('recapOutput');
  if (!output?.value) return;
  try {
    await navigator.clipboard.writeText(output.value);
  } catch {
    output.focus();
    output.select();
    document.execCommand('copy');
  }
  logStatus('Copied recap text to clipboard.');
}

function wireEvents() {
  $('addLeagueIdBtn')?.addEventListener('click', addSavedLeagueId);
  $('leagueIdInput')?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addSavedLeagueId();
    }
  });
  $('clearBtn')?.addEventListener('click', () => {
    if (!window.confirm('Clear every saved Sleeper league from this device?')) return;
    state.leagues = [];
    state.selectedAssets = { A: [], B: [] };
    state.freeAgency.selectedPlayerId = '';
    localStorage.removeItem(STORAGE_KEYS.leagues);
    localStorage.removeItem(STORAGE_KEYS.selectedLeague);
    localStorage.removeItem(STORAGE_KEYS.myTeamByLeague);
    state.savedLeagueIds = [];
    state.myTeamByLeague = {};
    if ($('leagueIdInput')) $('leagueIdInput').value = '';
    if ($('recapOutput')) $('recapOutput').value = '';
    renderEverything();
    logStatus('Cleared leagues from this browser.');
  });

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      activateTab(tab.dataset.tab);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
  document.querySelectorAll('[data-open-tab]').forEach(button => {
    button.addEventListener('click', () => {
      activateTab(button.dataset.openTab);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  wirePlayerCardActions();

  $('globalLeagueSelect')?.addEventListener('change', event => {
    localStorage.setItem(STORAGE_KEYS.selectedLeague, event.target.value);
    state.selectedAssets = { A: [], B: [] };
    state.freeAgency.selectedPlayerId = '';
    renderEverything();
  });

  $('myTeamSelect')?.addEventListener('change', applyMyTeamSelection);

  ['teamASelect', 'teamBSelect'].forEach(id => {
    $(id)?.addEventListener('change', () => {
      const changedSide = id === 'teamASelect' ? 'A' : 'B';
      const otherSelect = $(changedSide === 'A' ? 'teamBSelect' : 'teamASelect');
      if (otherSelect?.value === $(id).value) {
        const alternative = [...otherSelect.options].find(option => option.value !== $(id).value);
        if (alternative) otherSelect.value = alternative.value;
      }
      state.selectedAssets = { A: [], B: [] };
      fillTeamPlayerSelects();
      renderAssetList('A');
      renderAssetList('B');
      renderTradeTargetSuggestions();
      scheduleTradeEvaluation();
    });
  });

  $('tradeTargetSideSelect')?.addEventListener('change', renderTradeTargetSuggestions);

  const tradeAssetInputs = [
    { side: 'A', selectId: 'teamAPlayerSelect', searchId: 'teamAPlayerSearch' },
    { side: 'B', selectId: 'teamBPlayerSelect', searchId: 'teamBPlayerSearch' }
  ];
  tradeAssetInputs.forEach(({ side, selectId, searchId }) => {
    $(selectId)?.addEventListener('change', () => {
      if ($(selectId).value) addPlayerAsset(side, searchId);
    });
    $(searchId)?.addEventListener('input', () => {
      if (findExactPlayerFromInput($(searchId).value)) addPlayerAsset(side, searchId);
    });
    $(searchId)?.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addPlayerAsset(side, searchId);
      }
    });
  });

  $('resetTradeBtn')?.addEventListener('click', () => {
    state.selectedAssets = { A: [], B: [] };
    renderAssetList('A');
    renderAssetList('B');
    setTradeResultMessage('Add an asset to each side to see the live analysis.');
    renderTradeTargetSuggestions();
  });

  $('lineupTeamSelect')?.addEventListener('change', renderRecommendedLineup);

  ['freeAgencyTeamSelect', 'freeAgencyPositionFilter'].forEach(id => {
    $(id)?.addEventListener('change', () => {
      state.freeAgency.selectedPlayerId = '';
      renderFreeAgencyAnalyzer();
    });
  });

  $('recapWeekSelect')?.addEventListener('change', () => scheduleRecapGeneration(0));
  $('recapRangeSelect')?.addEventListener('change', () => scheduleRecapGeneration(0));
  $('copyRecapBtn')?.addEventListener('click', copyRecapOutput);
  $('exportDataBtn')?.addEventListener('click', exportData);

  ['draftTeamSelect', 'draftSeasonSelect', 'draftPositionFilter'].forEach(id => {
    $(id)?.addEventListener('change', renderDraftRecommendations);
  });

  $('playerValueSearch')?.addEventListener('input', renderPlayerValues);
  $('playerPositionFilter')?.addEventListener('change', renderPlayerValues);
  $('playerStatsSeasonSelect')?.addEventListener('change', renderPlayerComparison);
  $('swapPlayerCompareBtn')?.addEventListener('click', () => {
    const a = $('playerCompareA').value;
    $('playerCompareA').value = $('playerCompareB').value;
    $('playerCompareB').value = a;
    renderPlayerComparison();
    renderPlayerValues();
  });
  $('clearPlayerCompareBtn')?.addEventListener('click', () => {
    $('playerCompareA').value = '';
    $('playerCompareB').value = '';
    renderPlayerComparison();
    renderPlayerValues();
  });
  ['playerCompareA', 'playerCompareB'].forEach(id => {
    $(id)?.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        renderPlayerComparison();
        renderPlayerValues();
      }
    });
    $(id)?.addEventListener('input', () => {
      if (findExactPlayerFromInput($(id).value)) {
        renderPlayerComparison();
        renderPlayerValues();
      }
    });
    $(id)?.addEventListener('change', () => {
      renderPlayerComparison();
      renderPlayerValues();
    });
  });

  ['ageWeight', 'recentWeight', 'projectionWeight', 'efficiencyWeight', 'needWeight', 'pickWeight'].forEach(id => {
    $(id)?.addEventListener('input', () => {
      $(`${id}Value`).textContent = `${Number($(id).value).toFixed(1)}x`;
      scheduleModelSettingsUpdate();
    });
    $(id)?.addEventListener('change', () => scheduleModelSettingsUpdate(0));
  });
  $('resetSettingsBtn')?.addEventListener('click', () => {
    state.settings = { ...DEFAULT_SETTINGS };
    saveSettings();
    applySettingsToUI();
    applyModelSettingsFromUI();
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

function updateDynastyOnlyControls() {
  const league = getSelectedLeague();
  const dynasty = Boolean(league && isDynastyLeague(league));
  const control = $('dynastyAgeWeightControl');
  const input = $('ageWeight');
  if (control) control.hidden = !dynasty;
  if (input) input.disabled = !dynasty;
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    state,
    DEFAULT_SETTINGS,
    savedMyTeamRosterId,
    defaultTeamRosterId,
    teamSelectDefaultValue,
    normalizePosition,
    isDynastyLeague,
    isSuperflexLeague,
    fantasyPointsFromStats,
    marketValueFromRank,
    marketSignalForPlayer,
    ageCurveProfile,
    retirementHorizonLabel,
    dynastyAgeSummary,
    starterDemandPerRoster,
    buildProjectionModel,
    forecastForPlayer,
    upcomingLineupPeriod,
    rebuildWeeklySchedule,
    weeklyProjectionForPlayer,
    optimizeLineupAssignments,
    recommendedLineupForRoster,
    projectionIntrinsicValue,
    playerValue,
    optimalProjectedLineupScore,
    rosterNeedProfile,
    teamFitImpact,
    freeAgentCandidates,
    dropCandidatesForPickup,
    tradeTargetRecommendations,
    tradeFairBand,
    generateFairTradeOffer,
    adjustPackageValues,
    packageValuation,
    interpolatePickBand,
    pickValue,
    buildTeamStrength,
    valueConfidenceLabel,
    displayNumber,
    playerRookieSeason,
    teamPositionNeedScores,
    draftProspectCandidates,
    scoredDraftProspectsForTeam,
    draftRecommendationsForTeam,
    draftSelectionRows,
    teamDraftCapitalForSeason,
    draftAvailabilityForTeam
  };
}

if (typeof document !== 'undefined' && !globalThis.__SLEEPER_SHIELD_TEST_MODE__) boot();
