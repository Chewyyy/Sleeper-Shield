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
- Player values use a KTC-style dynasty scale with market/tier anchors, league scoring, production, positional scarcity, roster format, and position-specific dynasty age curves.
