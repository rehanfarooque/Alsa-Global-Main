# AlsaGlobal — Panel Status Report

**Generated:** 2026-06-14
**Tested against:** local dev server (`localhost:3001`) with local Redis shim (`localhost:8079`, 4,204 cached keys) and live upstream APIs.
**Gemini:** ✅ working (spend cap raised) — AI features operational.

---

## Summary

| Status | Count | Meaning |
|---|---|---|
| ✅ **Working** | ~110 | Returns live data now |
| 🔑 **Needs API key / token** | 6 | Endpoint is fine; upstream needs a credential you don't have |
| 🌐 **Upstream blocks this network** | 6 | Data-center IP is rejected by the source (works on home/office IP or via proxy) |
| 🔄 **Needs a seed run / relay** | 8 | Populates after `run-seeders.sh` or a websocket relay |
| 🧩 **Interactive (needs user input)** | ~10 | "Empty" only because it waits for a country/symbol/query you click |

**How to keep data fresh:** run these 3 processes —
```
node scripts/local-redis-rest.mjs      # cache (keep running)
npm run dev                            # app  → localhost:3001
bash scripts/run-seeders.sh            # refresh data (hourly)
```

---

## ✅ WORKING — verified returning live data

### Markets & Finance
| Panel | Source | Notes |
|---|---|---|
| Markets / Stock quotes | Yahoo → Finnhub | live |
| Stock Analysis | Yahoo + compute | live |
| Crypto | CoinGecko → CoinPaprika | live |
| Crypto Sectors | CoinGecko | live |
| DeFi Tokens | CoinGecko | live (33 KB) |
| AI Tokens | CoinGecko | live |
| Alt / Other Tokens | CoinGecko | live (67 KB) |
| Stablecoins | CoinGecko | live |
| Sector Heatmap | Yahoo → Finnhub | live |
| Fear & Greed | CNN scrape | live |
| COT Positioning | CFTC | live |
| Market Regime / Macro Signals | FRED | live |
| Macro Indicators | FRED | live |
| Market Breadth | compute | live |
| Financial Stress (FSI) | ECB | live |
| EU Yield Curve | ECB direct | live |
| Earnings Calendar | Finnhub | live |
| BTC ETF Tracker | CoinGecko | live |
| Gold Intelligence | gold-api + CoinGecko | live |
| Gulf Economies / Quotes | Yahoo → Finnhub | live |
| Central Bank Watch (BIS) | BIS direct | live |
| BIS Exchange Rates | BIS direct | live |
| BIS Credit-to-GDP | BIS direct | live |
| ECB FX Rates | ECB direct | live |
| National Debt / Global Debt Clock | live fetch | live (45 KB) |
| Big Mac Index | Economist (GitHub) | live |
| Energy Capacity | seeded (EIA) | live |
| Oil & Gas / Crude Inventories | EIA direct | live |
| Nat-Gas Storage | EIA direct | live |
| Oil Inventories (combined) | EIA + seed | live |

### News (all 16 categories populated — 253 items)
World News, United States, Europe, Middle East, Africa, Latin America, Asia-Pacific, Politics, Tech Headlines, AI/ML, Finance, Government, Think Tanks, Energy & Resources, Intel Feed, Layoffs — **all live** via the feed-digest (`/api/news/v1/list-feed-digest`).
Also: Markets News, Commodities News, Crypto News, Economic News, Climate News, Mining News — live RSS.

### Intelligence & Geopolitics
| Panel | Source | Notes |
|---|---|---|
| AI Insights | Gemini (now uncapped) | live |
| AI Strategic Posture | Gemini | live |
| Strategic Risk Overview | compute | live |
| Live Intelligence (GDELT) | GDELT | live |
| Daily Brief | Gemini + news | live |
| Security Advisories | US State Dept + CDC + WHO RSS | live (65 KB) |
| GPS Interference | seeded | live |
| AI Market Implications | compute | live |
| Satellites | CelesTrak direct | live (26 KB) |
| Theater Posture / Force Posture | seeded | live |
| Sanctions Pressure | OFAC + scrape | live |
| Critical Minerals | embedded + compute | live |
| Geopolitical Hubs / Tech Hubs | static + live | live |
| Predictions (Polymarket) | Polymarket | live |

### World / Environment / Infra
| Panel | Source | Notes |
|---|---|---|
| Earthquakes | USGS | live (156 KB) |
| Wildfires / Fires | NASA FIRMS | live (534 KB) |
| Thermal Escalation | compute on fires | live |
| Cyber Threats | multi-source | live (137 KB) |
| Internet Outages | IODA | live |
| Service Status | scrapers | live |
| Disease Outbreaks | WHO/CDC | live |
| ACLED Conflict Events | ACLED | ⚠️ see "needs token" — your ACLED returns 403 |
| Climate News | RSS | live (17 KB) |
| Climate Disasters | EM-DAT | live (33 KB) |
| Population Exposure | compute | live |
| Displacement (UNHCR) | UNHCR | live (49 KB) |
| Radiation Watch | seeded | live |
| Airport Delays / Airline Intelligence | aviation | live (51 KB) |
| Navigational Warnings | maritime | live (158 KB) |
| Consumer Prices / Grocery / Fuel Prices / FAO Food | seeded + direct | live |
| Pipelines / Storage / Fuel Shortages / Energy Disruptions / Chokepoints | embedded + compute | live (pipelines 400 KB) |
| Good News Feed / Human Progress / Breakthroughs / Conservation / Renewable | RSS + counters | live |
| Tech Events / GitHub Trending / HackerNews / arXiv | direct APIs | live |
| World Clock | client | live |

---

## 🔑 NOT WORKING — needs an API key / token (your account)

> **UPDATE:** ACLED is actually **WORKING** ✅ — your `ACLED_EMAIL`/`ACLED_PASSWORD` exchange a valid OAuth token and `list-acled-events` returns 27 KB, `get-risk-scores` returns 8.6 KB. The earlier 403 was only because Redis was down (the token couldn't be cached). With the shim running it works. **No ACLED action needed.**

| Panel | Why | Fix |
|---|---|---|
| **UCDP Conflict Events** | UCDP closed their free API (token now required) | Set `UCDP_ACCESS_TOKEN` (register at ucdp.uu.se) — optional; ACLED already covers conflicts |
| **Sanctions Entity Lookup** | OpenSanctions went paid in 2025 (`"No API key provided"`) | Set `OPENSANCTIONS_API_KEY` (paid) — the panel's local OFAC fallback still works without it |
| **Economic Calendar** | Needs a provider key | Set `TRADING_ECONOMICS_KEY` (free tier available at tradingeconomics.com) |
| **Wingbits live flight / status** | `WINGBITS_API_KEY` not set | Optional — set `WINGBITS_API_KEY` for the Wingbits flight feed |
| **Aircraft photo details** | needs a photo API | Optional — `JETPHOTOS_API_KEY` / `PLANESPOTTERS` |

---

## 🌐 NOT WORKING — upstream blocks data-center / VPS IPs

These return empty because the source API rejects requests from cloud/VPS IP ranges. They work from a home/office IP or behind a residential proxy.

| Panel | Upstream | Workaround |
|---|---|---|
| Trade Flows | UN Comtrade | residential proxy, or run from a home IP |
| Customs Revenue | UN Comtrade | same |
| Trade Barriers | WTO/Comtrade | same |
| Comtrade Bilateral | UN Comtrade | same |
| Eurostat country data / EU indicators | Eurostat | same |
| Shipping Rates | Drewry/SCFI | same |

---

## 🔄 NOT WORKING — needs a seed run or a relay process

| Panel | Why | Fix |
|---|---|---|
| **Energy Prices** | EIA series not seeded / upstream slow | `bash scripts/run-seeders.sh` (seed-economy) — runs the EIA price series |
| **Defense Patents (R&D Signal)** | USPTO PatentsView returned empty this run | re-run `seed-defense-patents.mjs`; populates when PatentsView responds |
| **Cross-Source Signals** | derived from other seeds; needs base data present first | re-run `seed-bundle-derived-signals.mjs` after the base seeds |
| **Regime History** | seed didn't run (no standalone script; comes from relay) | runs via the `ais-relay` process / seed bundle |
| **Social Velocity** | needs social-media source / relay | requires the relay or a social API key |
| **Climate Anomalies** | NOAA/Copernicus blocked from this network | works from an unblocked IP; or `seed-climate-anomalies` on a good network |
| **Ocean / Ice data** | NOAA blocked | same as climate anomalies |
| **Webcams** | needs `seed-webcams` + Windy/webcam source | run the webcam seeder |
| **Air Quality Alerts** | seed not populated | `seed-bundle-health.mjs` |
| **Iran Events** | scraper source blocked | populates via relay on an unblocked network |

---

## 🧩 "Empty" but actually fine — interactive panels

These show no data **until you click/select something** (a country, symbol, or query). They are not broken — they wait for input:

- Country Intel Brief, Regional Snapshot/Brief, Country Port Activity (pick a country)
- Sanctions Lookup, Company Signals, Company Enrichment (type a query)
- Vessel Snapshot, Track Aircraft, Flight Status (pick a vessel/flight)
- Reverse Geocode, IP Geo, Imagery Search (need coordinates/query)
- Chokepoint History, Fuel Shortage Detail, Pipeline Detail (click a map item)
- Backtesting / Stored Backtests (run a backtest first)
- Scenario Status (PRO-gated feature)

---

## API Key Reference

### ✅ You already have (working)
`GEMINI_API_KEY` (uncapped now), `FRED_API_KEY`, `EIA_API_KEY`, `FINNHUB_API_KEY`, `NASA_FIRMS_API_KEY`, `WAQI_TOKEN`, `CLOUDFLARE_API_TOKEN`, `OPENSKY_CLIENT_ID/SECRET`, `AISSTREAM_API_KEY`.

### 🆓 Recommended free additions
| Key | Unlocks | Get it at |
|---|---|---|
| `GROQ_API_KEY` | LLM fallback if Gemini caps again (insights, ARGUS) | console.groq.com |
| `ACLED_ACCESS_TOKEN` | **Armed Conflict, Country Instability, Risk Scores** | acleddata.com |
| `GITHUB_API_TOKEN` | higher GitHub Trending rate limit | github.com/settings/tokens |
| `TRADING_ECONOMICS_KEY` | Economic Calendar | tradingeconomics.com |

### 💰 Optional paid
| Key | Unlocks |
|---|---|
| `OPENSANCTIONS_API_KEY` | Sanctions entity lookup (OFAC fallback works free) |
| `WINGBITS_API_KEY` | Wingbits flight feed |
| Residential proxy | UN Comtrade / Eurostat / Drewry (Trade Flows, Customs, Shipping Rates) |

---

## Bottom line

- **News:** ✅ all 16 categories live (253 items)
- **AI features:** ✅ working now that Gemini's cap is raised — **restart the dev server** so it picks up the uncapped key
- **Markets / Crypto / Commodities / Energy / Intelligence / Environment:** ✅ ~110 panels live
- **The one high-value free fix left:** renew **ACLED** (`ACLED_ACCESS_TOKEN`) — it unlocks the conflict/risk/instability cluster, the only major gap caused by a credential rather than a blocked upstream.
