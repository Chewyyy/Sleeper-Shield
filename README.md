# Sleeper Trade Shield

A static, iPhone-friendly dark-mode web app for Sleeper fantasy football league analysis, trade evaluation, player comparison, and league recap generation.

## What it does

- Saves multiple Sleeper league IDs in the browser.
- Lets the user load saved leagues and switch between them.
- Pulls public/read-only Sleeper league data: users, rosters, matchups, transactions, traded picks, drafts, league settings, scoring settings, and player metadata.
- Shows league rules and scoring settings in a readable dashboard panel.
- Caches the large Sleeper player database in IndexedDB.
- Attempts to fetch past NFL player stats for the current and prior two seasons through Sleeper's public stats endpoint, then scores those stats using the league scoring settings.
- Falls back to league matchup scoring and player metadata when historical stats are unavailable.
- Estimates player value using scoring-adjusted production, recent form, age, position scarcity, roster format, start rate, health/status, and historical production.
- Estimates draft-pick value using round, season, and the original roster's strength.
- Evaluates trades using raw asset value plus team-need adjustment.
- Adds team-roster dropdowns in the trade tab, so selecting a team fills a player picker with that team's roster.
- Generates structured recap packages for week/month/season summaries.
- Includes player stat cards with headshots, value, PPG, last-four trend, starts, rank, status, and game log.
- Includes an iPhone-optimized Apple-style layout with safe-area support, large touch targets, bottom tab navigation, responsive cards, and standalone web-app metadata.

## Run locally

```bash
python3 -m http.server 5173
```

Then open:

```text
http://localhost:5173
```

## iPhone testing

For quick iPhone testing, run the server on your computer and open the local network address on your iPhone, for example:

```text
http://192.168.1.10:5173
```

For the most app-like experience on iPhone, open the site in Safari, tap Share, then choose **Add to Home Screen**.

## Historical stats note

Sleeper's official documented API is public/read-only and does not require a token. The broader player stats endpoint used for past-year stats is not part of the currently supported official documentation, so the app treats it as best-effort. If it is unavailable, blocked, or returns no rows, the app continues working with league matchup data and metadata-based fallback values.
