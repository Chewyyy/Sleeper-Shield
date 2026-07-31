const assert = require('node:assert/strict');
const model = require('../app.js');

function projection(playerId, points, adp = {}) {
  return {
    player_id: playerId,
    stats: {
      gp: 17,
      pts_ppr: points,
      ...adp
    }
  };
}

function makeLeague({ superflex = true, type = 2 } = {}) {
  const rosterPositions = superflex ? ['QB', 'SUPER_FLEX', 'BN', 'BN'] : ['QB', 'FLEX', 'BN', 'BN'];
  const rosters = [
    { roster_id: 1, owner_id: 'u1', players: ['q1'], starters: ['q1'], settings: {} },
    { roster_id: 2, owner_id: 'u2', players: ['q2', 'q3'], starters: ['q2', 'q3'], settings: {} }
  ];
  return {
    league_id: 'test', name: 'Test League', season: '2026', total_rosters: 2,
    roster_positions: rosterPositions,
    scoring_settings: {}, settings: { type }, rosters,
    rosterMap: new Map(rosters.map(roster => [roster.roster_id, roster])),
    userMap: new Map([
      ['u1', { user_id: 'u1', display_name: 'Weak Team' }],
      ['u2', { user_id: 'u2', display_name: 'Strong Team' }]
    ]),
    playerStats: new Map(), historicalStats: new Map(), valueCache: new Map(),
    teamStrength: new Map(), matchupsByWeek: {}, projectionModel: null
  };
}

function resetState() {
  model.state.settings = { ...model.DEFAULT_SETTINGS };
  model.state.nflState = { season: '2026', league_season: '2026', season_type: 'pre', week: 0 };
  model.state.projectionSeason = 2026;
  model.state.players = {
    q1: { player_id: 'q1', full_name: 'Elite QB', position: 'QB', fantasy_positions: ['QB'], team: 'AAA', active: true, age: 25, search_rank: 10 },
    q2: { player_id: 'q2', full_name: 'Good QB', position: 'QB', fantasy_positions: ['QB'], team: 'BBB', active: true, age: 28, search_rank: 35 },
    q3: { player_id: 'q3', full_name: 'Starter QB', position: 'QB', fantasy_positions: ['QB'], team: 'CCC', active: true, age: 27, search_rank: 55 },
    te1: { player_id: 'te1', full_name: 'Premium TE', position: 'TE', fantasy_positions: ['TE'], team: 'DDD', active: true, age: 24 }
  };
  model.state.projections = new Map([
    ['q1', projection('q1', 400, { adp_dynasty_2qb: 2, adp_dynasty_ppr: 40, adp_ppr: 70 })],
    ['q2', projection('q2', 340, { adp_dynasty_2qb: 20, adp_dynasty_ppr: 80, adp_ppr: 95 })],
    ['q3', projection('q3', 300, { adp_dynasty_2qb: 48, adp_dynasty_ppr: 120, adp_ppr: 140 })]
  ]);
}

resetState();

assert.equal(model.isDynastyLeague({ settings: { type: 0, reserve_slots: 4 }, roster_positions: Array(20).fill('BN') }), false,
  'An IR/reserve bench must not turn an explicit redraft league into dynasty');
assert.equal(model.normalizePosition('DE'), 'DL');
assert.equal(model.normalizePosition('CB'), 'DB');

const tePoints = model.fantasyPointsFromStats(
  { rec: 80, rec_yd: 800, rec_td: 6 },
  { rec: 0.5, rec_yd: 0.1, rec_td: 6, bonus_rec_te: 0.5 },
  'TE',
  { seasonProjection: true }
);
assert.equal(tePoints, 196, 'TE premium must be applied to projected receptions');

const sfLeague = makeLeague({ superflex: true });
const oneQbLeague = makeLeague({ superflex: false });
oneQbLeague.scoring_settings = { rec: 1 };
assert.equal(model.marketSignalForPlayer(sfLeague, 'q1').key, 'adp_dynasty_2qb');
assert.equal(model.marketSignalForPlayer(oneQbLeague, 'q1').key, 'adp_dynasty_ppr');
assert.ok(model.marketSignalForPlayer(sfLeague, 'q1').value > model.marketSignalForPlayer(oneQbLeague, 'q1').value,
  'The same QB must carry more market value in Superflex');

model.buildProjectionModel(sfLeague);
const q1Value = model.playerValue(sfLeague, 'q1');
const q3Value = model.playerValue(sfLeague, 'q3');
assert.ok(q1Value.value > q3Value.value, 'Elite market rank and projection must produce the higher value');
assert.ok(q1Value.forecastPpg > q3Value.forecastPpg);
assert.ok(Number.isFinite(q1Value.vorp));

model.buildTeamStrength(sfLeague);
const before = ['q1'];
const after = ['q1', 'q3'];
const fit = model.teamFitImpact(sfLeague, 1, before, after, q3Value.value);
assert.ok(fit.lineupDelta > 10, 'Adding a missing Superflex starter must materially improve projected lineup PPG');
assert.ok(fit.adjustment > 0, 'A true lineup need must create a positive, capped fit adjustment');

const elitePackage = model.adjustPackageValues([{ value: 9000, type: 'player', confidenceScore: 90 }]);
const depthPackage = model.adjustPackageValues([
  { value: 3000, type: 'player', confidenceScore: 80 },
  { value: 3000, type: 'player', confidenceScore: 80 },
  { value: 3000, type: 'player', confidenceScore: 80 }
]);
assert.equal(elitePackage.raw, depthPackage.raw);
assert.ok(elitePackage.adjusted > depthPackage.adjusted,
  'One cornerstone must beat an equal raw sum of several depth assets after consolidation');

const earlyPick = model.pickValue(sfLeague, { season: 2026, round: 1, originalRosterId: 1 });
const latePick = model.pickValue(sfLeague, { season: 2026, round: 1, originalRosterId: 2 });
const futureEarlyPick = model.pickValue(sfLeague, { season: 2028, round: 1, originalRosterId: 1 });
assert.ok(earlyPick.value > latePick.value, 'The weaker original roster must produce the more valuable pick');
assert.ok(earlyPick.value > futureEarlyPick.value, 'Future picks must be discounted for time and uncertainty');

console.log('trade-model.test.js: all assertions passed');
