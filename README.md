# Sleeper Shield

Responsive Sleeper league intelligence app with weekly lineup recommendations, trade analysis, free-agency recommendations, roster context, rookie targets, player comparisons, and recap generation.

## Run locally

```bash
python3 -m http.server 5173
```

Then open `http://localhost:5173`.

## Notes

- Uses Sleeper public/read-only API data.
- League IDs save locally in the browser and auto-load on the device.
- The Recommended Lineup view automatically targets Sleeper's upcoming regular-season display week; during the offseason and preseason it prepares Week 1.
- Lineups are optimized across the league's exact legal starter slots using matchup-specific projected stat lines scored under the league's settings. Missing weekly data falls back to season forecasts and is labeled clearly.
- Matchup boosts and fades compare each player's weekly projection with his season baseline. Bye, out, IR/reserve, suspended, inactive, and taxi players are excluded, while injury-questionable players remain visible with a warning.
- Trade dropdowns include rostered players and owned draft picks, including current-year rookie picks when the draft has not been completed.
- Player values use format-specific Sleeper ADP, league-scored projections, value over replacement, verified production, opportunity-adjusted efficiency, and dynasty-only player age/career-horizon curves.
- Dynasty views show each player's age, age-curve stage, and estimated years to a position-specific retirement horizon. Redraft values and views exclude the age/horizon layer.
- Trade evaluation applies elite-asset scarcity and package consolidation before showing each team's separate projected lineup/depth impact.
- Trade target recommendations rank players on the selected partner by positional need, projected lineup gain, value over replacement, and the partner's replacement cost.
- Generate Offer searches one-, two-, and three-asset packages from the selected team's players and owned picks, prioritizing the model's fair-value range and both rosters' needs.
- Trade analysis updates automatically whenever a team, player, pick, or model setting changes.
- The Free Agency Analyzer ranks only unrostered players, then models the lineup, depth, and value effect of swapping each target for potential drop candidates.
- Valuable cut candidates are flagged "Trade, do not drop" instead of being presented as disposable roster pieces.
- Pick values use the exact Sleeper draft slot once order is published; unset orders use original-roster strength, with format and future-year adjustments applied in either case.
- The rookie fit board ranks the best overall roster fits on the left and likely options at each owned pick on the right.
- Draft availability uses exact Sleeper draft order when published, projects unset slots from roster strength, follows traded-pick ownership, and runs repeated team-need-aware mock drafts.
- League management lives in Settings; the active league selector is available globally.
- Primary navigation uses a persistent bottom dock with football-themed icons and compact mobile labels.
- Displayed numeric outputs are capped at two decimal places.
- The generated Sleeper Shield identity is included as install icons, an Apple touch icon, browser favicons, and the in-app brand mark.

## Model tests

```bash
node tests/trade-model.test.js
```
