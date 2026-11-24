# River Pulse

A public Canadian hydrometric field notebook for [CoolCode.ca](https://coolcode.ca/riverpulse/). Search ECCC's station catalogue for Canada and selected cross-border gauges, fetch any gauge's recent observations, compare archived years, and keep dated receipts with source queries and qualifiers.

<!-- coolcode:guide -->
River Pulse starts with real captures for the Nicomekl River in Langley, the Fraser River at Hope and the Sackville River at Bedford. Search a station name or ECCC number, choose recent days and two comparison years, then select **Fetch this station**. For a closed gauge or empty period, select **Find archive dates**, then **Use available years** and **Fetch this station**. This checks actual measured records, so a historical gauge does not leave you guessing which years to try. Switch between discharge (m³/s) and water level (metres at that gauge's datum). Recent unit observations and historical daily means have separate charts; gaps stay empty.

Save a JSON receipt to reopen later, export the station's observations as CSV, or import a receipt into the current tab. Dated published captures can be compared for changed values and qualifiers at overlapping observation times. A first capture establishes a record; it does not invent earlier history. Use the linked official station for source context. Water levels are not comparable flood-risk scores across stations.

To expand the automatically collected stations, edit `stationIds` and `defaultStation` in `web/config.json`; no code or API key is needed. Change `historicalYears` and `realtimeDays` there as well. The refresh workflow runs daily, manually, and after configuration/collector changes on main. Every successful capture is retained. A failed refresh preserves the previous public data.
<!-- /coolcode:guide -->

## What is implemented

- Searchable local catalogue of 8,057 stations from the initial ECCC source capture, including active, discontinued and selected cross-border stations in the source catalogue. This count changes as the source changes. Station search is not limited to the three defaults.
- Genuine initial data: `08MH155` Nicomekl River at 203 Street, Langley (BC); `08MF005` Fraser River at Hope (BC); `01EJ001` Sackville River at Bedford (NS). Each initial receipt includes three recent days and all available daily observations from 2024 and 2023.
- **Find archive dates** checks the earliest measured date and the newest 367 measured daily rows with two bounded ECCC requests, cached per station for this tab. Its count includes dates with at least one non-null level or discharge. The optional **Use available years** shortcut fills up to two years actually represented in those rows; it neither assumes continuous coverage nor changes the displayed capture until you fetch. A one-year archive uses that same year in both controls and fetches it once.
- Explicit live lookup for any catalogue station, 1–30 recent days and any two years from 1850 onward. A missing period is reported, never synthesized. Discontinued stations may have historical data without recent readings.
- Separate recent-unit and archived-daily charts. Calendar-day seasonal alignment uses a leap reference year, preserving February 29. Missing values and long intervals break the line.
- Exact source symbols retained in the observation table and exports. GeoMet's selected collections provide text qualifiers, not the separate Datamart QA/QC flags; the app does not infer approval grades.
- Immutable dated JSON captures, provenance URLs, downloadable CSV/JSON, local imports, and overlapping-record revision comparisons. New readings are additions, not revisions. Windows that no longer overlap are not treated as deletions.
- Last-good preservation: collection completes before replacing `data/index.json`. Partial, malformed, incomplete or failed source requests do not replace the current capture.

## Add or change scheduled stations

Edit [`web/config.json`](web/config.json), for example:

```json
"stationIds": ["08MH155", "08MF005", "01EJ001", "01EJ004"],
"defaultStation": "08MH155",
"realtimeDays": 3,
"historicalYears": [2024, 2023]
```

Use **the station ID**, not a river nickname. Find IDs in the public app or [ECCC's station search](https://wateroffice.ec.gc.ca/search/real_time_e.html). Adding a station extends the scheduled published captures; visitors can already fetch arbitrary catalogue stations without editing the config. Changes pushed to main automatically trigger `River Pulse · Refresh observations`. You can also run it from **Actions → River Pulse · Refresh observations → Run workflow**.

`maxStations` defaults to 20 and can be raised to 100. `historicalYears` accepts 1–4 unique years. The live form offers two years; all configured years in retained captures are displayed. `pageSize` defaults to 3,000 (ECCC maximum 10,000), and `maxPages` to 4 per series. For a long recent period at a frequently sampled gauge, increase `maxPages`. The collector fails instead of silently truncating a result. `catalogueRefreshDays` defaults to seven. `historicalRefreshDays` defaults to 30, reusing prior daily-mean series between updates while retaining each series’ original `retrievedAt`. Lower it to check historical revisions more often. Changes to the requested years automatically fetch those new periods. `requestGapSeconds` spaces page/station requests. Collection IDs and the base URL are explicit in config but must match the supported ECCC adapter; a different provider needs a new adapter and tests.

There are **no secrets or registration requirements** for these public ECCC services. Data collection uses only ECCC endpoints. No river location is inferred from a visitor's device.

## Refresh, retention and publishing

The `refresh.yml` workflow runs daily at **09:43 UTC**, via manual dispatch, and when `web/config.json`, `scripts/refresh.py` or the refresh workflow changes on main. GitHub schedules may run late. It collects data, validates it and commits only `web/data/`. A successful refresh triggers the Pages workflow through `workflow_run`; this is necessary because a bot commit does not trigger an ordinary push workflow. Main pushes and manual Pages runs also rebuild. PRs validate without publishing.

- `web/data/stations.json`: normalized source catalogue, refreshed weekly by default.
- `web/data/captures/<timestamp>-<digest>.json`: immutable source receipts. Existing captures are never rewritten or pruned automatically.
- `web/data/index.json`: newest-first capture manifest with SHA-256 of each receipt file's bytes.
- A capture date tells you **when River Pulse assembled the receipt**; each series’ `retrievedAt` tells you when ECCC was queried. An observation date tells you **when the gauge measured it**. Provider response timestamps are also retained.
- Scheduled capture windows are bounded. This records revisions to observations still present in an overlapping recent window or configured historical years; it does not promise a complete archive of every provisional revision at ECCC.
- Live visitor fetches/imports stay in tab memory. **Save receipt** downloads the selected station's data; it does not silently write to GitHub or the visitor's storage. All published scheduled captures remain accessible in the selector. The local comparison UI displays up to 100 changed measurement/qualifier pairs, with full data in exports.
- Growing retention uses repository space. To keep a larger long-term archive elsewhere, move old receipt files deliberately and update the manifest/source path implementation together. No default retention cutoff silently discards them.

Local maintenance (network required only for refresh):

```sh
python3 scripts/refresh.py
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -v
python3 scripts/build.py
```

Builds are offline and copy only `web/` to `dist/`. GitHub Actions runs the Playwright browser smoke test at a project subpath and saves desktop/mobile screenshots. `dist/` and browser test artifacts are not committed. The public app uses relative asset URLs for `/riverpulse/` hosting.

## Measurements and source caveats

**Water level:** metres above the station's reference datum. An assumed datum is local and arbitrary; level is not river depth or elevation above sea level. Datum changes can affect a station's historical comparisons. Never compare levels at different gauges as flood risk.

**Discharge:** cubic metres per second (m³/s). Recent data are unit readings, often at short intervals. HYDAT daily mean values average the day's unit values; comparing these with instantaneous observations as if they were the same statistic would be misleading. They are charted separately.

**Dates:** GeoMet recent `DATETIME` is UTC. The original `DATETIME_LST` is retained unchanged in receipts and CSV; it represents source-provided local standard time and can differ from daylight-saving or civil-clock expectations. Historical `DATE` is a calendar day and is not converted to another timezone. Chart/table timestamps for recent readings are shown in UTC. ECCC has posted timezone-transition notices; the tool preserves the source's timestamps rather than guessing corrections.

**Qualifiers and gaps:** `LEVEL_SYMBOL_EN` / `DISCHARGE_SYMBOL_EN` are retained verbatim. No symbol does not establish approval. Nulls remain null, not zero. Recent plotted gaps over two hours and historical gaps over 36 hours break lines. Only reported values are counted. Source precision is retained in JSON/CSV; display values use at most three decimals.

The app is an independent observation explorer, not a flood forecasting or warning service. For safety decisions, consult current official local advisories.

## Source documentation and attribution

Data: **Environment and Climate Change Canada, MSC GeoMet / Water Survey of Canada / HYDAT**, retrieved at the date shown in each receipt. Station contributor metadata is preserved. Adapted for display; this site is not endorsed by ECCC.

- [GeoMet OGC API guide and pagination](https://eccc-msc.github.io/open-data/msc-geomet/ogc_api_en/)
- [Hydrometric collection documentation](https://eccc-msc.github.io/open-data/msc-data/obs_hydrometric/readme_hydrometric_en/)
- [Stations](https://api.weather.gc.ca/collections/hydrometric-stations), [recent observations](https://api.weather.gc.ca/collections/hydrometric-realtime), [historical daily means](https://api.weather.gc.ca/collections/hydrometric-daily-mean)
- [Water Survey FAQ: assumed datum, provisional readings and citation](https://wateroffice.ec.gc.ca/contactus/faq_e.html)
- [MSC open-data end-user licence](https://eccc-msc.github.io/open-data/licence/readme_en/)
- [MSC service usage policy](https://eccc-msc.github.io/open-data/usage-policy/readme_en/)

This app retrieves bounded periods for a selected set of stations and caches historical data. ECCC recommends MSC Datamart for bulk local archives; use that mechanism if expanding this into a whole-network raw-data archive.

## Privacy and external requests

A station search reads the shipped catalogue locally. Fetching readings or checking archive dates sends station IDs, date ranges and the browser's ordinary connection information to ECCC. No account, key, precise visitor position or uploaded file is sent. Imported JSON is processed only in the current tab and is labelled unverified; exports include source queries. The app does not save form values or receipts in browser storage. CoolCode's shared visit counter may run on published pages; it is independent of receipt contents. External source links open the official sites only when selected.

<!-- schedule-reliability -->
## Schedule reliability

Public GitHub repositories can have scheduled workflows disabled after 60 days of inactivity. A separate weekly [schedule guard](.github/workflows/schedule-guard.yml) calls GitHub's enable-workflow API for an explicit list of refresh workflows and itself. It can restore workflows disabled for inactivity, preserves manually disabled workflows, and runs independently of collection failures.

This is an interim mitigation, not a scheduling guarantee: GitHub does not document active-workflow renewal as a permanent exemption, and scheduled runs can be delayed or dropped. A scheduler on our own Linux server is the planned independent trigger. The guard does not collect data, create dummy commits, or change source/check timestamps; successful collection and published data freshness still need monitoring.
<!-- /schedule-reliability -->
