# LagPulse

A local-first network diagnostics dashboard that monitors your connection, predicts lag before it hits, and tells you what to do about it.

LagPulse probes a host every second, tracks latency, jitter, packet loss, DNS resolution time and throughput, keeps a rolling ten-minute history, scores connection quality from 0 to 100, forecasts short-term lag trends, and turns the results into plain-language recommendations with copy-ready diagnostic commands. Everything runs on your machine: no accounts, no telemetry, no CDN assets.

---

## Features

- **Live telemetry at 1 Hz** — ICMP round-trip time with OS `ping` and TCP fallback, RFC 3550 jitter, packet loss over the last 10 probes, DNS timing, and adapter throughput.
- **Rolling history** — 600 samples (10 minutes by default) retained in memory.
- **Health score** — a single 0–100 value weighted 45% latency, 30% jitter and 25% loss, with a per-component breakdown.
- **Lag prediction** — linear regression over recent latency samples returns trend, risk level and an estimated time to a spike.
- **Actionable advice** — contextual recommendations for loss, bufferbloat, high RTT, slow DNS, unreachable targets and bandwidth saturation.
- **Live dashboard** — metric cards with sparklines, a multi-series Chart.js graph, 30s / 60s / 5m / all windows, and light and dark themes.
- **Five-node benchmark** — compare Cloudflare, Google, Quad9, OpenDNS and Steam.
- **On-demand speed test** — real download and upload capacity via Cloudflare, capped at 8 seconds per phase.
- **Export** — download the session as CSV or JSON.
- **Accessible and offline-friendly** — self-hosted fonts and Chart.js, keyboard shortcuts, visible focus states, responsive down to 320px.

---

## Modules

| # | Module | Responsibility |
|---|---|---|
| 1 | Telemetry Collector (`monitor.py`) | Probes the target every second and stores rolling history |
| 2 | Target Validator (`monitor.py`) | Validates and resolves the hostname or IP before monitoring |
| 3 | Health Scorer (`monitor.py`) | Converts latency, jitter and loss into a weighted 0–100 score |
| 4 | Lag Predictor (`monitor.py`) | Regression-based forecast of trend, risk and time to spike |
| 5 | Recommendation Engine (`monitor.py`) | Produces actionable, OS-specific advice and diagnostic commands |
| 6 | Dashboard and REST API (`app.py`, `static/`, `templates/`) | Serves live charts, benchmark, speed test and CSV/JSON export |

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Language | Python 3.10+ | Backend engine and API |
| Web framework | FastAPI | Routing, validation, JSON endpoints |
| ASGI server | Uvicorn | Application server |
| Templating | Jinja2 | Dashboard rendering |
| Probing | ping3, OS `ping`, TCP handshake | Latency measurement with fallbacks |
| System metrics | psutil | Adapter throughput counters |
| Forecasting | NumPy | Linear regression for lag prediction |
| Speed test | httpx + Cloudflare endpoints | Download and upload capacity |
| Front end | HTML, CSS, vanilla JavaScript | Dashboard behaviour |
| Charting | Chart.js (self-hosted) | Multi-series telemetry graph |
| Storage | In-memory deque | Rolling history, no database |

---

## Getting Started

### Requirements

- Python 3.10 or newer (tested on 3.13)
- Windows, macOS or Linux
- Permission to send ICMP probes. If raw sockets are unavailable, LagPulse falls back to the system `ping` binary automatically.
- Internet access for the optional speed test only.

### Install

```bash
git clone https://github.com/<your-username>/lagpulse.git
cd lagpulse/lag_analyzer
pip install -r requirements.txt
```

### Run

```bash
uvicorn app:app --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000>. Monitoring starts automatically against `8.8.8.8`; change the target in the input field or pick a preset chip. Add `--reload` during development.

---

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Dashboard |
| `POST` | `/start` | Start or retarget monitoring (`target` form field) |
| `POST` | `/stop` | Pause monitoring |
| `GET` | `/api/stats` | Current metrics, history, forecast and recommendations |
| `GET` | `/api/status` | Engine state, target, uptime, platform and diagnostic commands |
| `GET` | `/api/benchmark` | Probe five public nodes concurrently |
| `GET` | `/api/speedtest` | Download and upload capacity test |
| `GET` | `/api/export?format=csv\|json` | Download session data |

Example:

```bash
curl -X POST http://127.0.0.1:8000/start -d "target=1.1.1.1"
curl http://127.0.0.1:8000/api/stats
curl -OJ "http://127.0.0.1:8000/api/export?format=csv"
```

---

## Project Structure

```
Project/
├── README.md
├── .gitignore
└── lag_analyzer/
    ├── app.py                  FastAPI routes, benchmark, speed test, export, status
    ├── monitor.py              Probe engine, scoring, forecasting, recommendations
    ├── utils.py                Shared helpers
    ├── requirements.txt
    ├── templates/
    │   └── index.html          Dashboard markup and SVG sprite
    └── static/
        ├── app.js              Client state, polling, charts, dialogs
        ├── style.css           Theme, layout, components
        ├── fonts/              Self-hosted IBM Plex Sans and Mono
        └── vendor/             Self-hosted Chart.js 4.4.6
```

---

## How It Works

1. The dashboard sends the target to `/start`, where the Target Validator checks and resolves it.
2. The Telemetry Collector runs a background thread that probes once per second and appends each measurement to bounded deques.
3. The Health Scorer and Lag Predictor read the latest samples and compute a score and a forecast.
4. The Recommendation Engine turns those results into prioritised advice with OS-matched commands.
5. The browser polls `/api/stats` every second and updates the cards, sparklines, chart, forecast and advice.

History is held in memory, so it resets when the server restarts. Use CSV or JSON export to keep a record.

---

## Configuration

Probe defaults live as class attributes in `monitor.py`:

| Setting | Default | Meaning |
|---|---|---|
| `SAMPLE_INTERVAL` | `1.0` s | Time between probe cycles |
| `PING_TIMEOUT` | `1.0` s | Per-probe timeout |
| `HISTORY_SIZE` | `600` | Samples retained |
| `DNS_REFRESH_SECONDS` | `60` | DNS re-timing interval |
| `THROUGHPUT_WINDOW` | `3.0` s | Traffic smoothing window |

`DEFAULT_TARGET` and `BENCHMARK_NODES` live in `app.py` alongside the speed test limits.

---

## Notes

- **Live traffic vs. speed test:** the Download and Upload cards show current adapter traffic, which is near zero when idle. The speed test measures capacity and runs only on request.
- **Speed test data use:** up to 30 MB down and 20 MB up per run. It briefly saturates the link, so the latency graph may spike during the test.
- **ICMP blocked:** some hosts and networks drop ping. Pick a reachable target, or use the benchmark to separate a local outage from a remote block.
- **Privacy:** monitoring is local. The speed test is the only outbound request and only runs when you ask for it.

---

## License

This project is provided for educational and personal use. Add a license file if you plan to distribute it.
