const assert = require('node:assert/strict');
const model = require('./app.js');
model.state.nflState = { season: '2026', league_season: '2026', season_type: 'regular', week: 8, display_week: 8 };
model.state.projectionSeason = 2026;
model.state.players = Object.fromEntries([
  ['a', 'RB'], ['b', 'RB'], ['c', 'RB'], ['d', 'WR'], ['e', 'WR'], ['q', 'QB'], ['lb', 'LB'], ['db', 'DB']
].map(([id, position]) => [id, { player_id: id, full_name: `Player ${id}`, position, fantasy_positions: [position], team: 'AAA', active: true }]));
const roster = { roster_id: 1, players: ['a', 'b', 'c', 'd', 'e'], starters: ['b', 'a', 'd'] };
const league = {
  league_id: 'context-test', season: '2026', roster_positions: ['RB', 'RB', 'FLEX', 'BN', 'BN'],
  rosterMap: new Map([[1, roster]]), rosters: [roster], settings: { type: 2 },
  scoring_settings: { rush_yd: 1 }, playerStats: new Map(), historicalStats: new Map(), valueCache: new Map()
};
function lineup(points) {
  model.state.weeklyProjectionMeta = { ...model.upcomingLineupPeriod(), rows: 5 };
  model.state.weeklyProjections = new Map(Object.entries(points).map(([id, value]) => [id, { stats: { rush_yd: value } }]));
  return model.recommendedLineupForRoster(league, 1);
}
let result = lineup({ a: 25, b: 20, c: 10, d: 22, e: 5 });
assert.deepEqual(result.starters.map(row => row.detail.playerId), ['b', 'a', 'd'], 'Preserve RB1/RB2/FLEX when the lineup is already optimal');
assert.deepEqual(result.startIds, []);
assert.deepEqual(result.sitIds, []);
assert.deepEqual(result.moves, []);
result = lineup({ a: 25, b: 20, c: 30, d: 22, e: 5 });
assert.equal(result.total, 77, 'Optimize total points across the full lineup');
assert.deepEqual(result.startIds, ['c']);
assert.deepEqual(result.sitIds, ['b']);
assert.equal(new Set(result.starters.map(row => row.detail.playerId)).size, 3);
assert.deepEqual(result.moves, [], 'Bench upgrades should replace the departing starter in place when legal');

// Adding a WR requires an existing FLEX RB to move into an RB slot.
roster.starters = ['a', 'c', 'b'];
result = lineup({ a: 25, b: 20, c: 10, d: 22, e: 5 });
assert.deepEqual(result.startIds, ['d']);
assert.deepEqual(result.sitIds, ['c']);
assert.deepEqual(result.moves, [{ playerId: 'b', fromIndex: 2, toIndex: 1 }]);
const moved = result.starters[1];
const markup = model.renderLineupStarterRow(moved, result.starters, league);
assert.match(markup, /Already starting at FLEX · move to RB 2/);
const flexMarkup = model.renderLineupStarterRow(result.starters[2], result.starters, league);
assert.match(flexMarkup, /Current starter · move to RB 2/);
const output = {};
global.document = { getElementById: () => output };
model.renderLineupChanges(result);
assert.match(output.innerHTML, /1 start\/sit change · 1 slot move/);
assert.match(output.innerHTML, /Player b: FLEX → RB 2/);
delete global.document;

// Equal projections should not trigger an unnecessary bench substitution.
roster.starters = ['b', 'a', 'd'];
result = lineup({ a: 25, b: 20, c: 20, d: 22, e: 5 });
assert.deepEqual(result.startIds, []);
assert.deepEqual(result.sitIds, []);
// Ineligible reserves must still be excluded even if currently starting.
roster.reserve = ['b'];
result = lineup({ a: 25, b: 20, c: 19, d: 22, e: 5 });
assert.deepEqual(result.startIds, ['c']);
assert.deepEqual(result.sitIds, ['b']);
roster.reserve = [];

// Shared eligibility also applies to Superflex and IDP.
const details = [['q', 30], ['a', 20], ['lb', 15], ['db', 18]].map(([playerId, points]) => ({ playerId, points, available: true, confidence: 1 }));
const mixed = model.optimizeLineupAssignments({ roster_positions: ['QB', 'SUPER_FLEX', 'IDP_FLEX', 'IDP_FLEX'] }, details);
assert.equal(mixed.filled, 4);
assert.equal(new Set(mixed.selected).size, 4);
assert.equal(mixed.total, 83);
console.log('Lineup context tests passed');
