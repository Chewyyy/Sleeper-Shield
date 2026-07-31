# Sleeper Shield

Responsive Sleeper league intelligence app with trade analysis, roster context, rookie targets, player comparisons, and recap generation.

## Run locally

```bash
python3 -m http.server 5173
```

Then open `http://localhost:5173`.

## Notes

- Uses Sleeper public/read-only API data.
- League IDs save locally in the browser and auto-load on the device.
- Trade dropdowns include rostered players and owned draft picks, including current-year rookie picks when the draft has not been completed.
- Player values use format-specific Sleeper ADP, league-scored projections, value over replacement, verified production, opportunity-adjusted efficiency, and dynasty-only player age/career-horizon curves.
- Dynasty views show each player's age, age-curve stage, and estimated years to a position-specific retirement horizon. Redraft values and views exclude the age/horizon layer.
- Trade evaluation applies elite-asset scarcity and package consolidation before showing each team's separate projected lineup/depth impact.
- Trade analysis updates automatically whenever a team, player, pick, or model setting changes.
- Pick values use continuous early/mid/late bands, original-roster strength, format, and a future-year discount.
- The rookie fit board ranks available prospects against each team's position needs using published Sleeper market, projection, and NFL draft-capital data.
- League management lives in Settings; the active league selector is available globally.
- Displayed numeric outputs are capped at two decimal places.

## Model tests

```bash
node tests/trade-model.test.js
```
