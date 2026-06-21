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
- Lets you add multiple leagues and switch between them.
- Loads league settings, rosters, users, matchups, transactions, traded picks, drafts, and player metadata.
- Shows the league format and scoring rules.
- Builds roster-strength and team-need summaries from league rules and roster slots.
- Trade tool supports players and draft picks from each selected team's asset dropdown.
- Trade evaluation includes current-year and previous-year stat cards for involved players.
- Draft-pick values estimate early/mid/late value from the original owner's roster strength.
- Recap generator creates week/month/season/offseason league packages to paste into ChatGPT.
- Draft recap generator summarizes draft classes, top picks, current model value from drafted players, draft-day trades, and traded future picks.

## Historical stats note

Sleeper's documented public API is read-only and does not require login. Historical player stats are fetched through Sleeper's public stats endpoint on a best-effort basis, then rescored using the league's scoring settings. If those rows are unavailable, the model falls back to matchup data and player metadata.
