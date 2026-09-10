# Sightseer

**Live: https://sightseer-gilt.vercel.app/**

Trip weather, turned into a decision. Enter a city and your travel dates; get a
plain-language verdict for each day, the hours of that day worth being outside,
and one packing list for the whole trip.

Built for the ShARE Tech Vertical recruitment task. The submission write-up —
thresholds, reasoning, workflow — is in [NOTE.md](NOTE.md).

## Who it advises

**The city sightseer.** They get between sights however they like, by taxi or
metro or on foot, and see the sights themselves by walking: 5–8 km across the
day, in stretches between 9am and 7pm. Every threshold is calibrated to that
person and would be wrong for a trekker or a parent with a toddler.

## Running it

No build step, no dependencies, no API key.

```bash
# any static server works
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` directly from the filesystem also works.

## Deploying

Deployed on Vercel from this repo. `vercel.json` runs `deploy.sh`, which copies
the five things the site needs into `dist/`, and serves that — so the note, the
tests and the task PDF are never published.

Any static host works the same way: build with `./deploy.sh`, serve `dist/`.

## Files

| File | What it is |
|---|---|
| `index.html` | Markup and the five UI states |
| `styles.css` | Styling, light and dark |
| `fonts/` | Inter (variable, self-hosted). No third-party request at runtime. |
| `app.js` | Fetch, validation, state machine, rendering |
| `engine.js` | **All judgement.** Pure functions, no DOM, no network |
| `test-fixtures.js` | Offline engine tests across six climates plus degenerate payloads |
| `ui-test.js` | Headless browser walk-through of all five states |
| `test.js` | Same as fixtures but against the live API (needs network) |
| `NOTE.md` | The submission write-up |
| `deploy.sh` | Copies the site into `dist/` and zips it, so nothing private ships |

The engine/app split is the point: the verdict logic has no dependencies on the
browser, so it can be run and re-read from the command line.

```bash
node test-fixtures.js    # engine, offline
node ui-test.js          # UI, headless chromium (needs: npm i playwright)
node test.js             # engine, live API
```

## Data

[Open-Meteo](https://open-meteo.com/) geocoding and forecast APIs. No key, no
signup. Two requests per search, made at runtime — nothing cached, nothing
stored, nothing hardcoded.

- Geocoding returns up to 5 matches; when there is more than one, the app asks
  rather than guessing.
- Forecast horizon is capped at 14 days, validated both on the date inputs and
  in JavaScript.
