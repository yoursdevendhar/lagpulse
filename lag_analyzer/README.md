# LagPulse

A local-first network diagnostics dashboard. LagPulse probes a host every second,
tracks latency, jitter, packet loss, DNS resolution and throughput, forecasts
short-term lag trends, and suggests concrete fixes when conditions degrade.

Built with FastAPI and a hand-written front end. Everything runs on your machine,
with no accounts and no telemetry. The interface loads no CDN assets; the only
external request is the optional speed test, which exchanges data with Cloudflare
when you run it.

---

## Features

**Live telemetry (1 Hz)**

- ICMP round-trip time via `ping3`, with an OS `ping` subprocess fallback and a
  TCP handshake fallback for hosts that block ICMP.
- Jitter smoothed with the RFC 3550 approach.
- Packet loss over the last 10 probes.
- DNS resolution time for hostname targets, refreshed every 60 seconds.
- Live download and upload traffic across non-loopback adapters, averaged over
  a 3-second window. These are current traffic rates, not link capacity.
- Resolved target IP and session uptime.
- 600-sample rolling history (10 minutes at the default interval).

**On-demand speed test**

- Measures real download and upload capacity through Cloudflare.
- Separates the two phases so they do not compete for bandwidth.
- Caps each measurement window at 8 seconds (30 MB down, 20 MB up) and reports actual data used.
- Uses its own explicit action; it is never started automatically.

**Health and forecasting**

- Composite health score (0–100) weighted 45% latency, 30% jitter, 25% loss,
  with a per-component breakdown.
- Linear regression over the last 20 latency samples to estimate trend, risk
  level and likely time to a spike.
- Trend labels: Stable, Rising, Falling, Spiking.

**Advisory**

- Contextual recommendations for packet loss, jitter/bufferbloat, high RTT,
  slow DNS, unreachable targets and bandwidth saturation.
- Copy-ready diagnostic commands matched to your OS (Windows, macOS, Linux).

**Dashboard**

- Metric cards with sparklines and plain-language state hints.
- Multi-series Chart.js graph for latency, jitter, loss and throughput, with
  toggleable legend and 30s / 60s / 5m / All windows.
- Five-node latency benchmark (Cloudflare, Google, Quad9, OpenDNS, Steam).
- Internet speed test with download, upload and data-usage results.
- Optional audio alert on lag spikes.
- CSV and JSON session export.
- Light and dark themes, both persisted locally.
- Keyboard shortcuts: `S` start/pause, `B` benchmark, `T` speed test, `M` mute,
  `Esc` close dialog.
- Responsive from 320px up, with visible focus states and ARIA labelling.

---

## Requirements

- Python 3.10 or newer (tested on 3.13)
- Windows, macOS or Linux
- Permission to send ICMP probes. On many systems `ping3` needs elevated
  privileges; LagPulse automatically falls back to the system `ping` binary, so
  the dashboard still works without admin rights.
- Internet access for the optional speed test. Everything else runs locally.

Install dependencies:

```bash
pip install -r requirements.txt
```

---

## Running

From this directory:

```bash
uvicorn app:app --host 127.0.0.1 --port 8000
```

Then open <http://127.0.0.1:8000>.

Add `--reload` during development. Monitoring starts automatically against
`8.8.8.8`; change the target in the input field or use a preset chip.

### Configuration

Probe defaults live as class attributes in `monitor.py`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `SAMPLE_INTERVAL` | `1.0` s | Time between probe cycles |
| `PING_TIMEOUT` | `1.0` s | Per-probe timeout |
| `HISTORY_SIZE` | `600` | Samples retained in memory |
| `DNS_REFRESH_SECONDS` | `60` | How often DNS is re-timed |
| `THROUGHPUT_WINDOW` | `3.0` s | Smoothing window for live traffic |

`DEFAULT_TARGET` and `BENCHMARK_NODES` are defined in `app.py`, along with the
speed test limits (`SPEEDTEST_DOWNLOAD_BYTES`, `SPEEDTEST_UPLOAD_BYTES`,
`SPEEDTEST_SECONDS`).

---

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | Dashboard |
| `POST` | `/start` | Start or retarget monitoring. Form field: `target` (hostname or IP) |
| `POST` | `/stop` | Pause monitoring |
| `GET` | `/api/stats` | Current metrics, history, forecast and recommendations |
| `GET` | `/api/status` | Engine state, target, uptime, sample count, platform and diagnostic commands |
| `GET` | `/api/benchmark` | Probe five nodes concurrently and return the median of three pings each |
| `GET` | `/api/speedtest` | Run a download and upload capacity test; returns Mbps, bytes used and timing |
| `GET` | `/api/export?format=csv\|json` | Download session data; other formats return `400` |

`/start` validates the target and returns `400` with a readable message for
blank, malformed or unresolvable hosts. API responses are sent with
`Cache-Control: no-store`.

Example:

```bash
curl -X POST http://127.0.0.1:8000/start -d "target=1.1.1.1"
curl http://127.0.0.1:8000/api/stats
curl http://127.0.0.1:8000/api/speedtest
curl -OJ "http://127.0.0.1:8000/api/export?format=csv"
```

CSV columns: target, timestamp, latency, ping RTT, jitter, packet loss, DNS
lookup, download and upload. Dropped probes are left blank rather than written
as zero.

---

## Project layout

```
lag_analyzer/
├── app.py                      FastAPI routes, benchmark, speed test, export, status
├── monitor.py                  Probe engine, scoring, forecasting, advice
├── templates/index.html        Dashboard markup and SVG sprite
├── static/
│   ├── app.js                  Client state, polling, charts, dialogs
│   ├── style.css               Theme, layout, components
│   ├── fonts/                  Self-hosted IBM Plex Sans and Mono
│   └── vendor/chart.umd.min.js Self-hosted Chart.js 4.4.6
├── requirements.txt
└── README.md
```

Fonts and Chart.js are served from `static/`, so the interface renders the same
way offline and makes no third-party requests. The optional speed test is the
only feature that contacts an external service.

---

## Notes and troubleshooting

- **Live traffic vs. speed test:** the Download and Upload cards show current
  adapter traffic, which is near zero when idle. The speed test measures capacity
  and runs only when you ask for it.
- **Speed test variance:** results depend on Wi-Fi conditions, concurrent traffic
  and Cloudflare's nearest edge. The main transfer is single-stream; if Cloudflare
  throttles it, LagPulse retries with several small parallel transfers. A
  single-stream result can read lower than a multi-connection speed test,
  especially on very fast links.
- **Speed test data use:** a run transfers up to 30 MB down and 20 MB up. It will
  briefly saturate the connection, so the latency graph may show a spike during
  the test.
- **Speed test rate limits:** Cloudflare may reject repeated tests from the same
  connection. LagPulse automatically retries a rejected large download with
  smaller parallel transfers; if both phases are rejected, wait for the retry
  window shown in the error before trying again.
- **ICMP blocked:** some hosts and networks drop ping. Set a target you can
  reach, or use the benchmark to separate a local outage from a remote block.
- **No throughput numbers:** `psutil` measures non-loopback adapters, so idle
  systems legitimately show near-zero rates.
- **Benchmark shows "No reply":** the node may be unreachable from your network,
  or a firewall may be blocking probes. The dashboard keeps working.
- **Pause vs. stop:** pausing keeps the current session history; retargeting
  starts a fresh session.
- **Data lifetime:** history is in memory only and resets when the server
  restarts. Use CSV/JSON export to keep a record.

Version 2.2.0.
