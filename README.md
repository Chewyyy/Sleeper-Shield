# Sleeper Trade Shield

A static web app for Sleeper fantasy football league analysis, trade evaluation, player comparison, and league recap generation.

## What it does

- Loads one or more Sleeper league IDs.
- Pulls public/read-only Sleeper league data: users, rosters, matchups, transactions, traded picks, drafts, and player metadata.
- Caches the large Sleeper player database in the browser.
- Estimates player value using league scoring, production, recent form, age, position scarcity, roster format, start rate, and injury/status.
- Estimates draft-pick value using round, season, and the original roster’s strength.
- Evaluates trades using raw asset value plus team-need adjustment.
- Generates structured recap packages for week/month/season summaries.
- Includes Sleeper-style player stat cards with headshots, value, PPG, last-four trend, starts, rank, status, and game log.
- Includes a head-to-head player comparison panel for trade decisions.
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

## Deployment

This is a static site. You can host the folder on GitHub Pages, Netlify, Vercel, Cloudflare Pages, or any static web server.

## Notes

Sleeper's official API is public/read-only and does not require a token. The player database endpoint is large, so the app stores it in IndexedDB and refreshes it roughly once per day.

The player card production data is derived from the loaded league matchup data, especially `players_points`. If a league season has limited matchup history available, the app falls back to Sleeper player metadata and search-rank-based value estimates.
