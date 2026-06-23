# Sleeper Trade Shield

A static web app for evaluating Sleeper fantasy football trades and generating structured weekly/monthly/season recap packages for ChatGPT.

## What it does

- Add multiple Sleeper league IDs.
- Pull league metadata, scoring settings, roster settings, users, rosters, matchups, transactions, traded picks, drafts, and draft picks from Sleeper's public read-only API.
- Cache Sleeper's NFL player database locally in IndexedDB.
- Estimate player value on a KTC-style 0–10,000 dynasty scale using market/tier anchors, league-specific production, recent form, injury/status, positional scarcity, Superflex/TE premium/IDP settings, and roster format.
- Estimate draft pick value by round, year, original roster projected strength, and whether the current-season rookie draft is still pending.
- Compare trade packages for raw value and team-need fit.
- Generate structured recap text for a selected week, last four loaded weeks, season-to-date, offseason, or draft recap package.
- Export loaded league data as JSON.

## How to run

The app is static, but it should be served from localhost instead of double-clicked as a file.

```bash
cd sleeper-trade-shield
python3 -m http.server 5173
```

Then open:

```text
http://localhost:5173
```

## Notes

- Sleeper's official API is read-only and does not require authentication.
- Sleeper recommends not calling the full players endpoint more than once per day because it is large. This app caches that response in the browser.
- Player historical production uses best-effort Sleeper stat rows when available and falls back to `matchups/{week}` data, especially `players_points`.
- This is an MVP decision-aid, not a perfect market-pricing engine. Dynasty trade values are inherently contextual.

## Dynasty age model

For dynasty leagues, the app now applies position-specific age curves. It treats RBs as having the shortest value runway, QBs as having the longest, and WR/TE values as declining more gradually. The age curve adds value for young ascending players, keeps prime players stable, and applies stronger penalties as a player approaches the expected decline/retirement window for the position.

## Draft pick handling

Current-season rookie picks are included in the trade dropdown when that season's draft has not been completed yet. Future picks are generated for the league's configured draft rounds and then adjusted using Sleeper's traded-picks endpoint so the current owner is reflected.

## Files

- `index.html` — app shell
- `styles.css` — styling
- `app.js` — Sleeper API integration, value model, trade analyzer, recap generator
