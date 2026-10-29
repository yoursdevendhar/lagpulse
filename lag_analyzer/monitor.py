"""Network telemetry engine for LagPulse.

Collects latency, jitter, packet loss, DNS resolution time and throughput,
then produces a regression-based lag forecast plus actionable advice.
"""

from __future__ import annotations

import ipaddress
import platform
import socket
import statistics
import subprocess
import threading
import time
from collections import deque
from datetime import datetime
from typing import Optional

import numpy as np
import psutil

try:  # ping3 needs raw-socket privileges on some platforms
    from ping3 import ping as icmp_ping
except Exception:  # pragma: no cover - dependency is declared but stay resilient
    icmp_ping = None


WINDOWS = platform.system().lower() == "windows"


class NetworkMonitor:
    """Thread-safe network probe with a rolling history window."""

    SAMPLE_INTERVAL = 1.0
    PING_TIMEOUT = 1.0
    DNS_REFRESH_SECONDS = 60.0
    HISTORY_SIZE = 600
    THROUGHPUT_WINDOW = 3.0

    def __init__(self, target_host: str = "8.8.8.8", window_size: int = HISTORY_SIZE):
        self.target_host = target_host
        self.target_ip: Optional[str] = None
        self.window_size = window_size

        self.latency_history: deque = deque(maxlen=window_size)
        self.packet_loss_history: deque = deque(maxlen=window_size)
        self.throughput_download_history: deque = deque(maxlen=window_size)
        self.throughput_upload_history: deque = deque(maxlen=window_size)
        self.ping_history: deque = deque(maxlen=window_size)
        self.jitter_history: deque = deque(maxlen=window_size)
        self.dns_history: deque = deque(maxlen=window_size)
        self.timestamps: deque = deque(maxlen=window_size)
        self.recent_pings_status: deque = deque(maxlen=10)

        self.is_monitoring = False
        self.monitor_thread: Optional[threading.Thread] = None
        self.lock = threading.RLock()
        self._stop_event = threading.Event()

        self._throughput_samples: deque = deque(maxlen=6)
        self._last_rtt: Optional[float] = None
        self._jitter_estimate = 0.0
        self._icmp_available = icmp_ping is not None
        self._last_dns_check = 0.0
        self._dns_latency: Optional[float] = None
        self._accumulated_uptime = 0.0
        self._run_started_at: Optional[float] = None

        self.last_stats = self._get_default_stats()

    def _get_default_stats(self) -> dict:
        return {
            "ping": None,
            "latency": None,
            "jitter": 0.0,
            "packet_loss": 0.0,
            "download_speed": 0.0,
            "upload_speed": 0.0,
            "total_throughput": 0.0,
            "dns_latency": None,
            "health_score": 100,
            "health_detail": {"score": 100, "latency": 100, "jitter": 100, "loss": 100},
            "online": False,
            "status": "Idle",
            "timestamp": datetime.now().isoformat(),
            "trend": "Stable",
        }

    # ------------------------------------------------------------------ #
    # Target handling
    # ------------------------------------------------------------------ #
    @staticmethod
    def validate_target(host: str) -> tuple[str, str]:
        """Return (host, resolved_ip) or raise ValueError with a useful message."""
        host = (host or "").strip()
        if not host:
            raise ValueError("Enter a hostname or IP address, for example 8.8.8.8.")

        if len(host) > 253:
            raise ValueError("That hostname is too long.")
        if host.startswith("-") or any(ch.isspace() for ch in host):
            raise ValueError("Hostnames cannot contain spaces or start with a dash.")
        if not all(ch.isalnum() or ch in ".-:_" for ch in host):
            raise ValueError("Use a valid hostname or IP address (letters, digits, dots, dashes).")

        try:
            ipaddress.ip_address(host)
            is_literal = True
        except ValueError:
            is_literal = False

        try:
            infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        except (socket.gaierror, UnicodeError, OSError):
            raise ValueError(f'Could not resolve "{host}". Check the spelling or try an IP address.') from None

        if not infos:
            raise ValueError(f'Could not resolve "{host}".')

        resolved = next((info[4][0] for info in infos if info[0] == socket.AF_INET), infos[0][4][0])
        if is_literal:
            resolved = host
        return host, resolved

    def _is_hostname(self) -> bool:
        try:
            ipaddress.ip_address(self.target_host)
            return False
        except ValueError:
            return True

    # ------------------------------------------------------------------ #
    # Probes
    # ------------------------------------------------------------------ #
    def _system_ping_fallback(self, host: str, timeout: float = PING_TIMEOUT) -> Optional[float]:
        """Fallback using the OS ping binary when raw sockets are unavailable."""
        try:
            if WINDOWS:
                cmd = ["ping", "-n", "1", "-w", str(int(timeout * 1000)), host]
            else:
                cmd = ["ping", "-c", "1", "-W", str(max(1, int(round(timeout)))), host]

            kwargs = {
                "stdout": subprocess.PIPE,
                "stderr": subprocess.PIPE,
                "text": True,
                "timeout": timeout + 1.0,
            }
            if WINDOWS:
                kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)

            start = time.perf_counter()
            res = subprocess.run(cmd, **kwargs)
            elapsed = (time.perf_counter() - start) * 1000.0

            if res.returncode != 0:
                return None

            for line in res.stdout.splitlines():
                lowered = line.lower()
                marker = "time=" if "time=" in lowered else ("time<" if "time<" in lowered else None)
                if not marker:
                    continue
                try:
                    raw = lowered.split(marker, 1)[1].split("ms", 1)[0].strip()
                    return float(raw)
                except (ValueError, IndexError):
                    continue
            return elapsed
        except Exception:
            return None

    def _tcp_ping_fallback(self, host: str, port: int, timeout: float = PING_TIMEOUT) -> Optional[float]:
        """TCP handshake latency for hosts that block ICMP."""
        try:
            start = time.perf_counter()
            with socket.create_connection((host, port), timeout=timeout):
                return (time.perf_counter() - start) * 1000.0
        except Exception:
            return None

    def measure_ping(self) -> Optional[float]:
        """Measure one round trip, falling back to OS ping then TCP connect."""
        if self._icmp_available and icmp_ping is not None:
            try:
                value = icmp_ping(self.target_host, timeout=self.PING_TIMEOUT, unit="ms")
                if value is not None and value is not False and value >= 0:
                    return float(value)
            except PermissionError:
                # Raw sockets are not available (common on Windows without admin).
                self._icmp_available = False
            except Exception:
                pass

        system_value = self._system_ping_fallback(self.target_host)
        if system_value is not None:
            return float(system_value)

        tcp_value = self._tcp_ping_fallback(self.target_host, 443)
        if tcp_value is None:
            tcp_value = self._tcp_ping_fallback(self.target_host, 80)
        if tcp_value is not None:
            return float(tcp_value)

        return None

    def measure_dns(self, force: bool = False) -> Optional[float]:
        """Resolve the target and report DNS lookup time (hostnames only)."""
        if not self._is_hostname():
            return None

        now = time.time()
        if not force and now - self._last_dns_check < self.DNS_REFRESH_SECONDS:
            return self._dns_latency

        self._last_dns_check = now
        try:
            start = time.perf_counter()
            infos = socket.getaddrinfo(self.target_host, 53, type=socket.SOCK_DGRAM)
            elapsed = (time.perf_counter() - start) * 1000.0
            if infos:
                ipv4 = next((i[4][0] for i in infos if i[0] == socket.AF_INET), None)
                if ipv4:
                    self.target_ip = ipv4
            self._dns_latency = round(elapsed, 2)
        except Exception:
            self._dns_latency = None
        return self._dns_latency

    @staticmethod
    def _network_totals() -> tuple[int, int]:
        """Sum non-loopback interfaces that are currently up.

        Loopback traffic is excluded so localhost transfers are not counted
        twice, and down adapters are skipped so stale counters do not inflate
        a sample.
        """
        totals = psutil.net_io_counters(pernic=True)
        stats = psutil.net_if_stats()
        received = sent = 0
        for name, io in totals.items():
            lowered = name.lower()
            if "loopback" in lowered or lowered in {"lo", "lo0"}:
                continue
            iface = stats.get(name)
            if iface is not None and not iface.isup:
                continue
            received += io.bytes_recv
            sent += io.bytes_sent
        return received, sent

    def _reset_throughput_baseline(self) -> None:
        self._throughput_samples.clear()

    def measure_throughput(self) -> tuple[float, float, float]:
        """Live interface throughput in megabits per second.

        Rates are calculated over a short rolling window instead of a single
        one-second delta, which removes most of the sample-to-sample noise.
        """
        try:
            now = time.monotonic()
            received, sent = self._network_totals()
            samples = self._throughput_samples

            # A counter reset (adapter reconnect or wrap) invalidates the window.
            if samples and (received < samples[-1][1] or sent < samples[-1][2]):
                samples.clear()

            samples.append((now, received, sent))
            if len(samples) < 2:
                return 0.0, 0.0, 0.0

            cutoff = now - self.THROUGHPUT_WINDOW
            baseline = next((sample for sample in samples if sample[0] >= cutoff), samples[0])
            elapsed = now - baseline[0]
            if elapsed <= 0:
                return 0.0, 0.0, 0.0

            delta_received = max(0, received - baseline[1])
            delta_sent = max(0, sent - baseline[2])
            down_mbps = delta_received * 8.0 / (1_000_000 * elapsed)
            up_mbps = delta_sent * 8.0 / (1_000_000 * elapsed)
            return round(down_mbps, 2), round(up_mbps, 2), round(down_mbps + up_mbps, 2)
        except Exception:
            return 0.0, 0.0, 0.0

    # ------------------------------------------------------------------ #
    # Scoring & forecasting
    # ------------------------------------------------------------------ #
    @staticmethod
    def _latency_subscore(ping_val: Optional[float]) -> int:
        if ping_val is None:
            return 0
        if ping_val <= 30:
            return 100
        if ping_val <= 60:
            return int(100 - (ping_val - 30) * 1.2)
        if ping_val <= 120:
            return int(64 - (ping_val - 60) * 0.6)
        return int(max(0, 28 - (ping_val - 120) * 0.3))

    @staticmethod
    def _jitter_subscore(jitter_val: float) -> int:
        if jitter_val <= 2:
            return 100
        if jitter_val <= 10:
            return int(100 - (jitter_val - 2) * 5)
        if jitter_val <= 30:
            return int(60 - (jitter_val - 10) * 2)
        return int(max(0, 20 - (jitter_val - 30) * 1.5))

    @staticmethod
    def _loss_subscore(loss_val: float) -> int:
        return int(max(0, 100 - loss_val * 12))

    def score_health(self, ping_val: Optional[float], jitter_val: float, packet_loss: float) -> dict:
        latency = self._latency_subscore(ping_val)
        jitter = self._jitter_subscore(jitter_val)
        loss = self._loss_subscore(packet_loss)
        score = int(round(0.45 * latency + 0.30 * jitter + 0.25 * loss))
        return {
            "score": max(0, min(100, score)),
            "latency": max(0, min(100, latency)),
            "jitter": max(0, min(100, jitter)),
            "loss": max(0, min(100, loss)),
        }

    def calculate_health_score(self, ping_val, jitter_val, packet_loss, throughput=0.0) -> int:
        return self.score_health(ping_val, jitter_val, packet_loss)["score"]

    def predict_lag(self) -> dict:
        with self.lock:
            valid = [float(x) for x in self.latency_history if x is not None]
            if len(valid) < 8:
                return {
                    "predicted_lag": False,
                    "probability": 0.0,
                    "time_to_lag": "N/A",
                    "confidence": "Calibrating",
                    "risk_level": "Low",
                    "trend": "Calibrating",
                    "slope": 0.0,
                    "std_dev": 0.0,
                    "samples": len(valid),
                }

            recent = valid[-20:]
            times = np.arange(len(recent), dtype=float)
            try:
                slope = float(np.polyfit(times, recent, deg=1)[0])
                recent_mean = float(np.mean(recent[-5:]))
                std_dev = float(np.std(recent))
                last_loss = float(self.packet_loss_history[-1]) if self.packet_loss_history else 0.0
                last_jitter = float(self.jitter_history[-1]) if self.jitter_history else 0.0
                last_ping = recent[-1]

                prob = 10.0
                if slope > 0.8:
                    prob += min(45.0, slope * 12.0)
                elif slope < -0.8:
                    prob -= min(15.0, abs(slope) * 8.0)

                if recent_mean > 90:
                    prob += min(30.0, (recent_mean - 90) * 0.5)
                elif recent_mean < 40:
                    prob = max(5.0, prob - 10.0)

                if last_jitter > 15:
                    prob += min(20.0, last_jitter * 0.8)
                if last_loss > 0:
                    prob += min(30.0, last_loss * 6.0)
                if last_ping > 150:
                    prob += 10.0

                prob = max(2.0, min(98.0, prob))
                is_lag = prob >= 65.0 or (slope > 1.8 and recent_mean > 80) or last_loss >= 5.0

                risk = "Critical" if prob >= 80 else ("High" if prob >= 65 else ("Moderate" if prob >= 40 else "Low"))
                confidence = "High" if len(valid) >= 30 else "Medium"

                if slope > 2.5 and prob > 75:
                    time_est = "Imminent (< 5s)"
                elif slope > 0.8:
                    time_est = f"~{max(5, int(120 / max(slope, 0.5)))}s"
                else:
                    time_est = "N/A"

                trend = "Spiking" if slope > 2.0 else ("Rising" if slope > 0.5 else ("Falling" if slope < -0.5 else "Stable"))

                return {
                    "predicted_lag": bool(is_lag),
                    "probability": round(prob, 1),
                    "time_to_lag": time_est,
                    "confidence": confidence,
                    "risk_level": risk,
                    "trend": trend,
                    "slope": round(slope, 3),
                    "std_dev": round(std_dev, 2),
                    "samples": len(valid),
                }
            except Exception:
                return {
                    "predicted_lag": False,
                    "probability": 0.0,
                    "time_to_lag": "N/A",
                    "confidence": "Error",
                    "risk_level": "Low",
                    "trend": "Stable",
                    "slope": 0.0,
                    "std_dev": 0.0,
                    "samples": len(valid),
                }

    def get_recommendations(self, stats: dict, prediction: dict) -> list[dict]:
        recs: list[dict] = []
        ping_v = stats.get("ping") or 0
        jitter_v = stats.get("jitter") or 0
        loss_v = stats.get("packet_loss") or 0
        down_v = stats.get("download_speed") or 0
        up_v = stats.get("upload_speed") or 0
        dns_v = stats.get("dns_latency")
        online = stats.get("online", True)

        if loss_v >= 5:
            recs.append({
                "type": "critical",
                "title": "Severe packet loss detected",
                "description": f"{loss_v:.1f}% of recent probes were dropped. This usually points to congestion, a failing cable, or severe wireless interference.",
                "action": "Switch to a wired connection if you can, then power-cycle your router and modem.",
            })
        elif loss_v > 0:
            recs.append({
                "type": "warning",
                "title": "Intermittent packet drops",
                "description": "A few probes went unanswered. Background sync, Wi-Fi interference, or ISP line noise can all cause this.",
                "action": "Pause cloud backups or large downloads and move closer to your access point.",
            })

        if jitter_v > 20:
            recs.append({
                "type": "warning",
                "title": "High jitter / bufferbloat",
                "description": f"Jitter is {jitter_v:.1f} ms, which can show up as stutter or rubber-banding in calls and games.",
                "action": "Enable Smart Queue Management (SQM) or QoS on your router, then retest under load.",
            })

        if ping_v > 120:
            recs.append({
                "type": "warning",
                "title": "High round-trip latency",
                "description": f"Current latency is {ping_v:.1f} ms to {self.target_host}. Distance or a suboptimal route is the usual cause.",
                "action": "Try a closer server or a different DNS provider, then compare the result in the benchmark panel.",
            })

        if dns_v is not None and dns_v > 80:
            recs.append({
                "type": "info",
                "title": "Slow DNS resolution",
                "description": f"Resolving {self.target_host} took {dns_v:.0f} ms. Page loads can feel sluggish even when ping is healthy.",
                "action": "Flush the DNS cache and try a faster resolver such as 1.1.1.1 or 8.8.8.8.",
            })

        if not online and loss_v >= 20:
            recs.append({
                "type": "critical",
                "title": "Target is not responding",
                "description": f"Probes to {self.target_host} are timing out. The host may be offline or blocking ICMP.",
                "action": "Confirm the host is reachable, or benchmark another node to separate a local outage from a remote block.",
            })

        if down_v > 40 or up_v > 15:
            recs.append({
                "type": "info",
                "title": "Heavy local bandwidth usage",
                "description": f"Active throughput is {down_v:.1f} Mbps down / {up_v:.1f} Mbps up.",
                "action": "If latency rises under this load, enable QoS or rate-limit the busiest application.",
            })

        if prediction.get("predicted_lag"):
            recs.insert(0, {
                "type": "critical",
                "title": f"Lag spike likely ({prediction.get('probability')}% probability)",
                "description": f"Latency is trending {prediction.get('trend', 'upward').lower()}. The model estimates onset {prediction.get('time_to_lag')}.",
                "action": "Hold off on ranked matches or important calls until the trend flattens.",
            })

        if not recs:
            recs.append({
                "type": "optimal",
                "title": "Network performing optimally",
                "description": "Latency is low, jitter is minimal, and no probes are being dropped.",
                "action": "Great conditions for competitive gaming, 4K streaming, and video calls.",
            })

        return recs

    # ------------------------------------------------------------------ #
    # Monitor loop & lifecycle
    # ------------------------------------------------------------------ #
    def _monitor_loop(self) -> None:
        while not self._stop_event.is_set():
            cycle_started = time.perf_counter()
            try:
                rtt = self.measure_ping()

                if rtt is not None:
                    self.recent_pings_status.append(1)
                    if self._last_rtt is not None:
                        delta = abs(rtt - self._last_rtt)
                        # RFC 3550 style smoothed jitter.
                        self._jitter_estimate += (delta - self._jitter_estimate) / 16.0
                    self._last_rtt = rtt
                else:
                    self.recent_pings_status.append(0)

                if self.recent_pings_status:
                    loss = (self.recent_pings_status.count(0) / len(self.recent_pings_status)) * 100.0
                else:
                    loss = 0.0

                jitter = self._jitter_estimate
                dns_latency = self.measure_dns()
                down_mbps, up_mbps, total_mbps = self.measure_throughput()

                with self.lock:
                    if self._stop_event.is_set():
                        break

                    valid_recent = [p for p in list(self.ping_history)[-4:] if p is not None]
                    if rtt is not None:
                        valid_recent.append(rtt)
                    avg_latency = statistics.mean(valid_recent) if valid_recent else None

                    self.ping_history.append(rtt)
                    self.latency_history.append(avg_latency)
                    self.jitter_history.append(jitter)
                    self.packet_loss_history.append(loss)
                    self.throughput_download_history.append(down_mbps)
                    self.throughput_upload_history.append(up_mbps)
                    self.dns_history.append(dns_latency)
                    self.timestamps.append(datetime.now())

                    health = self.score_health(avg_latency, jitter, loss)
                    self.last_stats = {
                        "ping": round(float(rtt), 2) if rtt is not None else None,
                        "latency": round(float(avg_latency), 2) if avg_latency is not None else None,
                        "jitter": round(float(jitter), 2),
                        "packet_loss": round(float(loss), 2),
                        "download_speed": round(float(down_mbps), 2),
                        "upload_speed": round(float(up_mbps), 2),
                        "total_throughput": round(float(total_mbps), 2),
                        "dns_latency": dns_latency,
                        "health_score": health["score"],
                        "health_detail": health,
                        "online": rtt is not None,
                        "status": "Monitoring",
                        "timestamp": datetime.now().isoformat(),
                        "trend": "Stable",
                    }
            except Exception:
                # A single failed probe should never kill the collector.
                pass

            elapsed = time.perf_counter() - cycle_started
            self._stop_event.wait(max(0.05, self.SAMPLE_INTERVAL - elapsed))

    def _reset_session(self) -> None:
        self.latency_history.clear()
        self.jitter_history.clear()
        self.packet_loss_history.clear()
        self.throughput_download_history.clear()
        self.throughput_upload_history.clear()
        self.dns_history.clear()
        self.ping_history.clear()
        self.timestamps.clear()
        self.recent_pings_status.clear()
        self._reset_throughput_baseline()
        self._last_rtt = None
        self._jitter_estimate = 0.0
        self._dns_latency = None
        self._last_dns_check = 0.0
        self._accumulated_uptime = 0.0
        self._run_started_at = None

    def start_monitoring(self, target_host: Optional[str] = None) -> bool:
        """Start (or retarget) the collector. Raises ValueError for bad targets."""
        validated: Optional[tuple[str, str]] = None
        if target_host is not None:
            validated = self.validate_target(target_host)

        retarget = False
        with self.lock:
            if validated is not None:
                new_host, new_ip = validated
                if new_host != self.target_host:
                    retarget = True
                if self.is_monitoring and not retarget:
                    return True

        if retarget:
            self.stop_monitoring()
            with self.lock:
                self._reset_session()
                self.target_host = validated[0]
                self.target_ip = validated[1]
                self._icmp_available = icmp_ping is not None
                self.last_stats = self._get_default_stats()

        with self.lock:
            if self.is_monitoring:
                return True

            if self.target_ip is None:
                try:
                    _, resolved_ip = self.validate_target(self.target_host)
                    self.target_ip = resolved_ip
                except ValueError:
                    pass

            self.is_monitoring = True
            self.last_stats["status"] = "Monitoring"
            self._stop_event = threading.Event()
            # Do not attribute traffic from the paused period to the new session.
            self._reset_throughput_baseline()
            self._run_started_at = time.time()
            self.monitor_thread = threading.Thread(
                target=self._monitor_loop,
                name="lagpulse-monitor",
                daemon=True,
            )
            self.monitor_thread.start()
            return True

    def stop_monitoring(self) -> bool:
        with self.lock:
            if not self.is_monitoring:
                self._stop_event.set()
                self.last_stats["status"] = "Paused"
                return True

            self.is_monitoring = False
            self._stop_event.set()
            self.last_stats["status"] = "Paused"
            if self._run_started_at is not None:
                self._accumulated_uptime += time.time() - self._run_started_at
                self._run_started_at = None

        thread = self.monitor_thread
        if thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=self.PING_TIMEOUT + 1.5)
        return True

    def uptime_seconds(self) -> int:
        with self.lock:
            uptime = self._accumulated_uptime
            if self.is_monitoring and self._run_started_at is not None:
                uptime += time.time() - self._run_started_at
            return int(uptime)

    def get_current_stats(self) -> dict:
        with self.lock:
            prediction = self.predict_lag()
            recommendations = self.get_recommendations(self.last_stats, prediction)

            def serialise(values):
                return [None if value is None else round(float(value), 2) for value in list(values)]

            history = {
                "timestamps": [t.isoformat() for t in list(self.timestamps)],
                "ping": serialise(self.ping_history),
                "latency": serialise(self.latency_history),
                "jitter": serialise(self.jitter_history),
                "packet_loss": serialise(self.packet_loss_history),
                "download": serialise(self.throughput_download_history),
                "upload": serialise(self.throughput_upload_history),
                "dns": serialise(self.dns_history),
            }

            return {
                "current": self.last_stats,
                "prediction": prediction,
                "recommendations": recommendations,
                "history": history,
                "target": self.target_host,
                "target_ip": self.target_ip,
                "meta": {
                    "samples": len(self.timestamps),
                    "uptime_seconds": self.uptime_seconds(),
                    "target_ip": self.target_ip,
                    "poll_interval": self.SAMPLE_INTERVAL,
                    "history_capacity": self.window_size,
                    "monitoring": self.is_monitoring,
                },
            }
