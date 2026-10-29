"""LagPulse — FastAPI application and JSON API."""

from __future__ import annotations

import csv
import io
import json
import logging
import mimetypes
import platform
import re
import statistics
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Optional

import httpx
from fastapi import FastAPI, Form, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from monitor import NetworkMonitor

BASE_DIR = Path(__file__).resolve().parent
# Windows' mimetype registry often omits woff2, which makes StaticFiles serve
# the bundled fonts as text/plain. Register it explicitly on every platform.
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("font/woff", ".woff")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
static_dir = BASE_DIR / "static"
static_dir.mkdir(exist_ok=True)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("lagpulse")

DEFAULT_TARGET = "8.8.8.8"
monitor = NetworkMonitor(target_host=DEFAULT_TARGET)

BENCHMARK_NODES = [
    {"name": "Cloudflare", "host": "1.1.1.1", "note": "Anycast DNS"},
    {"name": "Google", "host": "8.8.8.8", "note": "Public DNS"},
    {"name": "Quad9", "host": "9.9.9.9", "note": "Security-filtered DNS"},
    {"name": "OpenDNS", "host": "208.67.222.222", "note": "Cisco DNS"},
    {"name": "Steam CDN", "host": "steampowered.com", "note": "Gaming delivery"},
]

SPEEDTEST_DOWNLOAD_URL = "https://speed.cloudflare.com/__down?bytes={size}"
SPEEDTEST_UPLOAD_URL = "https://speed.cloudflare.com/__up"
SPEEDTEST_DOWNLOAD_BYTES = 30_000_000
SPEEDTEST_DOWNLOAD_CHUNK = 5_000_000
SPEEDTEST_UPLOAD_BYTES = 20_000_000
SPEEDTEST_SECONDS = 8.0
_speedtest_lock = Lock()
_download_large_blocked_until = 0.0


class SpeedTestBusy(RuntimeError):
    """Raised when a second speed test is requested while one is running."""


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        monitor.start_monitoring(DEFAULT_TARGET)
    except Exception:  # pragma: no cover - startup should not crash the server
        logger.exception("Could not start the telemetry collector")
    yield
    monitor.stop_monitoring()


app = FastAPI(
    title="LagPulse Network Monitor",
    description="Real-time latency, jitter, packet loss, and lag forecasting.",
    version="2.2.0",
    lifespan=lifespan,
)

app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.middleware("http")
async def no_store_api_responses(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


def _platform_label() -> str:
    system = platform.system()
    if system == "Windows":
        return f"Windows {platform.release()}"
    if system == "Darwin":
        version = platform.mac_ver()[0]
        return f"macOS {version}" if version else "macOS"
    return f"{system} {platform.release()}".strip()


def _diagnostic_commands(target: str) -> list[dict]:
    system = platform.system().lower()
    if system == "windows":
        commands = [
            {"label": "Flush DNS cache", "command": "ipconfig /flushdns"},
            {"label": "10-packet ping", "command": f"ping {target} -n 10"},
            {"label": "Trace route", "command": f"tracert {target}"},
        ]
    elif system == "darwin":
        commands = [
            {
                "label": "Flush DNS cache",
                "command": "sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder",
            },
            {"label": "10-packet ping", "command": f"ping -c 10 {target}"},
            {"label": "Trace route", "command": f"traceroute {target}"},
        ]
    else:
        commands = [
            {"label": "Flush DNS cache", "command": "sudo resolvectl flush-caches"},
            {"label": "10-packet ping", "command": f"ping -c 10 {target}"},
            {"label": "Trace route", "command": f"traceroute {target}"},
        ]
    return commands


def _status_payload() -> dict:
    return {
        "monitoring": monitor.is_monitoring,
        "target": monitor.target_host,
        "target_ip": monitor.target_ip,
        "samples": len(monitor.timestamps),
        "uptime_seconds": monitor.uptime_seconds(),
        "poll_interval": monitor.SAMPLE_INTERVAL,
        "history_capacity": monitor.window_size,
        "platform": _platform_label(),
        "commands": _diagnostic_commands(monitor.target_host),
        "version": app.version,
    }


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")


@app.post("/start")
async def start_monitoring(target: str = Form(default=DEFAULT_TARGET)):
    try:
        clean_target = (target or "").strip() or DEFAULT_TARGET
        monitor.start_monitoring(target_host=clean_target)
        payload = _status_payload()
        return JSONResponse(
            {
                "success": True,
                "target": payload["target"],
                "target_ip": payload["target_ip"],
                "monitoring": payload["monitoring"],
            }
        )
    except ValueError as exc:
        return JSONResponse({"success": False, "error": str(exc)}, status_code=400)
    except Exception as exc:
        logger.exception("Failed to start monitoring")
        return JSONResponse(
            {"success": False, "error": f"Could not start monitoring: {exc}"},
            status_code=500,
        )


@app.post("/stop")
async def stop_monitoring():
    try:
        monitor.stop_monitoring()
        return JSONResponse({"success": True, "monitoring": False, "target": monitor.target_host})
    except Exception as exc:
        logger.exception("Failed to stop monitoring")
        return JSONResponse(
            {"success": False, "error": f"Could not stop monitoring: {exc}"},
            status_code=500,
        )


@app.get("/api/stats")
async def get_stats():
    try:
        stats = monitor.get_current_stats()
        stats["server_time"] = datetime.now().isoformat()
        return JSONResponse(stats)
    except Exception as exc:
        logger.exception("Failed to read stats")
        return JSONResponse({"error": str(exc)}, status_code=500)


@app.get("/api/status")
async def get_status():
    return JSONResponse(_status_payload())


def _probe_host(host: str) -> Optional[float]:
    """Take three probes and return the median, or None if every probe failed."""
    probe = NetworkMonitor(target_host=host)
    samples: list[float] = []
    for _ in range(3):
        value = probe.measure_ping()
        if value is not None:
            samples.append(value)
        time.sleep(0.05)
    if not samples:
        return None
    return round(statistics.median(samples), 1)


def _run_benchmark() -> list[dict]:
    with ThreadPoolExecutor(max_workers=len(BENCHMARK_NODES)) as pool:
        futures = {node["host"]: pool.submit(_probe_host, node["host"]) for node in BENCHMARK_NODES}
        results = []
        for node in BENCHMARK_NODES:
            try:
                latency = futures[node["host"]].result(timeout=10)
            except Exception:
                latency = None
            results.append(
                {
                    "name": node["name"],
                    "host": node["host"],
                    "note": node["note"],
                    "latency": latency,
                    "status": "Online" if latency is not None else "No reply",
                }
            )
        return results


@app.get("/api/benchmark")
async def run_benchmark():
    """Compare latency across public DNS and gaming CDN nodes."""
    try:
        results = await run_in_threadpool(_run_benchmark)
        return JSONResponse({"results": results, "tested_at": datetime.now().isoformat()})
    except Exception as exc:
        logger.exception("Benchmark failed")
        return JSONResponse({"error": f"Benchmark failed: {exc}"}, status_code=500)


def _measure_download(client: httpx.Client, size: int, started: Optional[float] = None) -> tuple[int, float]:
    """Read one download response, returning bytes and the shared start time."""
    url = SPEEDTEST_DOWNLOAD_URL.format(size=size)
    with client.stream("GET", url) as response:
        response.raise_for_status()
        if started is None:
            started = time.perf_counter()
        received = 0
        for chunk in response.iter_bytes(262144):
            received += len(chunk)
            if time.perf_counter() - started >= SPEEDTEST_SECONDS:
                break
    return received, started


def _download_worker(started: float) -> tuple[int, Optional[Exception]]:
    """Download one small chunk in its own connection until the window ends."""
    received = 0
    timeout = httpx.Timeout(SPEEDTEST_SECONDS + 12.0, connect=10.0)
    url = SPEEDTEST_DOWNLOAD_URL.format(size=SPEEDTEST_DOWNLOAD_CHUNK)
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            with client.stream("GET", url, headers={"Accept-Encoding": "identity"}) as response:
                response.raise_for_status()
                for chunk in response.iter_bytes(262144):
                    received += len(chunk)
                    if time.perf_counter() - started >= SPEEDTEST_SECONDS:
                        break
    except Exception as exc:
        return received, exc
    return received, None


def _download_parallel() -> tuple[int, float]:
    """Aggregate a few small transfers when a large one is rate-limited."""
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(_download_worker, [started] * 4))
    elapsed = time.perf_counter() - started
    total = sum(item[0] for item in results)
    if total <= 0:
        errors = [item[1] for item in results if item[1] is not None]
        if errors:
            raise errors[0]
        raise RuntimeError("Cloudflare returned no data.")
    return total, elapsed


def _download_speed() -> dict:
    """Measure sustained download throughput, stopping at the time limit.

    Some Cloudflare edges throttle large single responses. If that happens,
    fall back to a few smaller transfers in parallel over the same window.
    """
    global _download_large_blocked_until

    timeout = httpx.Timeout(SPEEDTEST_SECONDS + 12.0, connect=10.0)
    received = 0
    started: Optional[float] = None
    elapsed = 0.0

    with httpx.Client(timeout=timeout, follow_redirects=True) as client:
        if time.monotonic() >= _download_large_blocked_until:
            try:
                received, started = _measure_download(client, SPEEDTEST_DOWNLOAD_BYTES)
                elapsed = time.perf_counter() - started
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code != 429:
                    raise
                retry_after = (exc.response.headers.get("Retry-After") or "").strip()
                try:
                    wait = float(retry_after)
                except ValueError:
                    wait = 300.0
                _download_large_blocked_until = time.monotonic() + max(60.0, min(wait, 3600.0))

        if received <= 0:
            received, elapsed = _download_parallel()

        if received <= 0 or elapsed <= 0:
            raise RuntimeError("Cloudflare returned no data.")
        return {
            "mbps": round(received * 8.0 / elapsed / 1_000_000, 2),
            "bytes": received,
            "seconds": round(elapsed, 2),
        }


def _upload_speed() -> dict:
    """Measure sustained upload throughput using a streaming request body."""
    chunk = b"\x00" * 262144
    metrics: dict[str, Optional[float]] = {"bytes": 0, "start": None, "end": None}

    def body():
        try:
            metrics["start"] = time.perf_counter()
            while int(metrics["bytes"] or 0) < SPEEDTEST_UPLOAD_BYTES:
                if time.perf_counter() - float(metrics["start"]) >= SPEEDTEST_SECONDS:
                    break
                yield chunk
                metrics["bytes"] = int(metrics["bytes"] or 0) + len(chunk)
        finally:
            metrics["end"] = time.perf_counter()

    timeout = httpx.Timeout(SPEEDTEST_SECONDS + 12.0, connect=10.0)
    with httpx.Client(timeout=timeout) as client:
        response = client.post(
            SPEEDTEST_UPLOAD_URL,
            content=body(),
            headers={"Content-Type": "application/octet-stream"},
        )
        response.raise_for_status()

    sent = int(metrics["bytes"] or 0)
    elapsed = float(metrics["end"] or time.perf_counter()) - float(metrics["start"] or time.perf_counter())
    if sent <= 0 or elapsed <= 0:
        raise RuntimeError("No upload data was sent.")
    return {
        "mbps": round(sent * 8.0 / elapsed / 1_000_000, 2),
        "bytes": sent,
        "seconds": round(elapsed, 2),
    }


def _format_retry_after(value: str) -> str:
    """Turn a Retry-After value into a short human interval."""
    try:
        seconds = int(float(value))
    except (TypeError, ValueError):
        return " a minute"
    if seconds <= 0:
        return " a moment"
    if seconds < 60:
        return f" about {seconds} second{'s' if seconds != 1 else ''}"
    if seconds < 3600:
        minutes = max(1, round(seconds / 60))
        return f" about {minutes} minute{'s' if minutes != 1 else ''}"
    hours = max(1, round(seconds / 3600))
    return f" about {hours} hour{'s' if hours != 1 else ''}"


def _speedtest_error(stage: str, exc: Exception) -> str:
    """Turn transport failures into a message that belongs in the UI."""
    label = "Download" if stage == "download" else "Upload"
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if status == 429:
            retry_after = (exc.response.headers.get("Retry-After") or "").strip()
            wait = _format_retry_after(retry_after) if retry_after else " a minute"
            return f"{label} was rate-limited by Cloudflare. Try again in{wait}."
        return f"{label} failed with HTTP {status}."
    if isinstance(exc, httpx.TimeoutException):
        return f"{label} timed out before it could finish."
    if isinstance(exc, httpx.RequestError):
        return f"{label} could not reach Cloudflare."
    if isinstance(exc, RuntimeError):
        return f"{label} failed: {exc}"
    return f"{label} failed."


def _run_speedtest() -> dict:
    if not _speedtest_lock.acquire(blocking=False):
        raise SpeedTestBusy("A speed test is already running. Try again in a moment.")

    result: dict = {"server": "Cloudflare", "tested_at": datetime.now().isoformat(), "errors": []}
    try:
        for name, probe in (("download", _download_speed), ("upload", _upload_speed)):
            try:
                result[name] = probe()
            except Exception as exc:
                message = _speedtest_error(name, exc)
                result["errors"].append(message)
                logger.warning("Speed test %s failed: %s", name, exc)

        if "download" not in result and "upload" not in result:
            raise RuntimeError("; ".join(result["errors"]) or "Speed test failed.")

        total = sum(result.get(key, {}).get("bytes", 0) for key in ("download", "upload"))
        result["data_used_bytes"] = total
        return result
    finally:
        _speedtest_lock.release()


@app.get("/api/speedtest")
async def speed_test():
    """Run an on-demand download/upload capacity test against Cloudflare."""
    try:
        payload = await run_in_threadpool(_run_speedtest)
        return JSONResponse(payload)
    except SpeedTestBusy as exc:
        return JSONResponse({"error": str(exc)}, status_code=409)
    except RuntimeError as exc:
        return JSONResponse({"error": str(exc)}, status_code=502)
    except Exception as exc:
        logger.exception("Speed test failed")
        return JSONResponse({"error": f"Speed test failed: {exc}"}, status_code=502)


@app.get("/api/export")
async def export_data(format: str = Query(default="json")):
    stats = monitor.get_current_stats()
    fmt = (format or "json").strip().lower()
    if fmt not in {"csv", "json"}:
        return JSONResponse(
            {"error": "Unsupported format. Use ?format=csv or ?format=json."},
            status_code=400,
        )

    exported_at = datetime.now()
    safe_target = re.sub(r"[^A-Za-z0-9.-]+", "_", monitor.target_host) or "target"
    filename = f"lagpulse-{safe_target}-{exported_at.strftime('%Y%m%d-%H%M%S')}.{fmt}"

    if fmt == "csv":
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(
            [
                "Target",
                "Timestamp",
                "Latency (ms)",
                "Ping RTT (ms)",
                "Jitter (ms)",
                "Packet Loss (%)",
                "DNS Lookup (ms)",
                "Download (Mbps)",
                "Upload (Mbps)",
            ]
        )

        hist = stats.get("history", {})
        count = len(hist.get("timestamps", []))

        def cell(values, index):
            if index >= len(values) or values[index] is None:
                return ""
            return values[index]

        for i in range(count):
            writer.writerow(
                [
                    monitor.target_host,
                    hist["timestamps"][i],
                    cell(hist.get("latency", []), i),
                    cell(hist.get("ping", []), i),
                    cell(hist.get("jitter", []), i),
                    cell(hist.get("packet_loss", []), i),
                    cell(hist.get("dns", []), i),
                    cell(hist.get("download", []), i),
                    cell(hist.get("upload", []), i),
                ]
            )

        # Excel opens UTF-8 CSV cleanly with a BOM.
        return Response(
            content="\ufeff" + output.getvalue(),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    payload = {
        "exported_at": exported_at.isoformat(),
        "target": monitor.target_host,
        "target_ip": monitor.target_ip,
        "prediction": stats.get("prediction"),
        "current": stats.get("current"),
        "recommendations": stats.get("recommendations"),
        "history": stats.get("history"),
    }
    return Response(
        content=json.dumps(payload, indent=2, ensure_ascii=False),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return Response(status_code=204)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
