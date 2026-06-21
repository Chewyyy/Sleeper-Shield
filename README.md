# Sleeper Trade Shield

A static, iPhone-friendly fantasy football trade evaluator for Sleeper leagues.

## Run locally

```bash
python3 -m http.server 5173
```

Open:

```text
http://localhost:5173
```

## What it does

- Saves Sleeper league IDs locally in the browser.
- Automatically reloads saved leagues when the app opens.
- Keeps league adding and league switching on the Home tab only.
- Lets you add multiple leagues and switch between them.
- Loads league settings, rosters, users, matchups, transactions, traded picks, drafts, and player metadata.
- Shows the league format and scoring rules.
- Builds roster-strength and team-need summaries from league rules and actual roster slots only.
- Trade tool supports players and draft picks from each selected team's asset dropdown.
- Trade evaluation includes player stat cards using the most recent played seasons, avoiding unplayed future weeks.
- Draft-pick values now use a KTC-style 0–10,000 value scale and estimate early/mid/late value from the original owner's roster strength.
- Player values now use a KTC-style dynasty-market model: market/tier anchor first, then controlled adjustments for production, recent form, positional percentile, rushing upside, age, status, league format, and team need.
- Player value table uses tap-to-compare selection: first tap fills Player 1, second tap fills Player 2, and selected rows/slots must be tapped again to unselect before replacing them.
- QB values are tier-guarded, so a stat-efficient QB like Brock Purdy cannot leapfrog Drake Maye/Josh Allen/Lamar-type assets solely because of PPG or efficiency.
- Recap generator creates week/month/season/offseason league packages to paste into ChatGPT.
- Draft recap generator summarizes draft classes, top picks, current model value from drafted players, draft-day trades, and traded future picks.

## Historical stats note

Sleeper's documented public API is read-only and does not require login. Historical player stats are fetched through Sleeper's public stats endpoint on a best-effort basis, then rescored using the league's scoring settings. The app filters out unplayed zero-stat future weeks and shows recent game logs from the last five played games. If those rows are unavailable, the model falls back to scored matchup data and player metadata.

## Value model note

The app does not live-sync KeepTradeCut values or scrape rankings in real time. It uses an offline KTC-style value curve and named dynasty anchors so the tool behaves more like a market-value calculator than a pure points model. Stats still matter, but they move players within a reasonable band instead of letting one strong sample override dynasty market tiers.
