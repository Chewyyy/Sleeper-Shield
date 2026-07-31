# Trade Shield

Static iPhone-friendly Sleeper league trade analyzer and recap builder.

## Run locally

```bash
python3 -m http.server 5173
```

Then open `http://localhost:5173`.

## Notes

- Uses Sleeper public/read-only API data.
- League IDs save locally in the browser and auto-load on the device.
- Trade dropdowns include rostered players and owned draft picks, including current-year rookie picks when the draft has not been completed.
- Player values use format-specific Sleeper ADP, league-scored projections, value over replacement, verified production, opportunity-adjusted efficiency, and position-specific dynasty age curves.
- Trade evaluation applies elite-asset scarcity and package consolidation before showing each team's separate projected lineup/depth impact.
- Pick values use continuous early/mid/late bands, original-roster strength, format, and a future-year discount.

## Model tests

```bash
node tests/trade-model.test.js
```
