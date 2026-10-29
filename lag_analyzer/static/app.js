/* LagPulse dashboard client */
(() => {
    "use strict";

    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

    const state = {
        status: null,
        stats: null,
        live: false,
        target: "8.8.8.8",
        busy: false,
        sound: false,
        theme: document.documentElement.getAttribute("data-theme") || "dark",
        chart: null,
        chartSupported: typeof window.Chart !== "undefined",
        windowSeconds: 30,
        pollTimer: null,
        predictedLag: false,
        lastSpikeAt: 0,
        audioCtx: null,
        recSignature: "",
        benchmarking: false,
        benchmarked: false,
        speedTesting: false,
        speedTested: false,
    };

    const els = {
        targetForm: $("#targetForm"),
        targetInput: $("#targetInput"),
        targetInputRow: $("#targetInputRow"),
        targetError: $("#targetError"),
        toggleButton: $("#toggleButton"),
        toggleLabel: $("#toggleLabel"),
        resolvedIp: $("#resolvedIp"),
        connectionPill: $("#connectionPill"),
        statusText: $("#statusText"),
        navTarget: $("#navTarget"),
        lastSync: $("#lastSync"),
        sampleCount: $("#sampleCount"),
        uptime: $("#uptime"),
        apiNotice: $("#apiNotice"),
        apiNoticeText: $("#apiNoticeText"),
        retryButton: $("#retryButton"),
        themeToggle: $("#themeToggle"),
        soundToggle: $("#soundToggle"),
        benchmarkButton: $("#benchmarkButton"),
        speedTestButton: $("#speedTestButton"),
        healthRing: $("#healthRing"),
        healthRingWrap: $("#healthRingWrap"),
        healthScore: $("#healthScore"),
        healthGrade: $("#healthGrade"),
        healthNote: $("#healthNote"),
        healthLatencyValue: $("#healthLatencyValue"),
        healthJitterValue: $("#healthJitterValue"),
        healthLossValue: $("#healthLossValue"),
        healthLatencyBar: $("#healthLatencyBar"),
        healthJitterBar: $("#healthJitterBar"),
        healthLossBar: $("#healthLossBar"),
        forecast: $("#forecast"),
        riskBadge: $("#riskBadge"),
        forecastTitle: $("#forecastTitle"),
        forecastText: $("#forecastText"),
        probabilityValue: $("#probabilityValue"),
        probabilityBar: $("#probabilityBar"),
        timeToSpike: $("#timeToSpike"),
        trendValue: $("#trendValue"),
        confidenceValue: $("#confidenceValue"),
        slopeValue: $("#slopeValue"),
        chartEmpty: $("#chartEmpty"),
        chartRange: $("#chartRange"),
        recommendations: $("#recommendations"),
        recCount: $("#recCount"),
        commandList: $("#commandList"),
        platformLabel: $("#platformLabel"),
        versionLabel: $("#versionLabel"),
        benchmarkDialog: $("#benchmarkDialog"),
        benchmarkList: $("#benchmarkList"),
        benchmarkStamp: $("#benchmarkStamp"),
        benchmarkLabel: $("#benchmarkLabel"),
        runBenchmark: $("#runBenchmark"),
        closeBenchmark: $("#closeBenchmark"),
        speedDialog: $("#speedDialog"),
        closeSpeedTest: $("#closeSpeedTest"),
        runSpeedTest: $("#runSpeedTest"),
        speedTestLabel: $("#speedTestLabel"),
        speedStamp: $("#speedStamp"),
        speedDownload: $("#speedDownload"),
        speedUpload: $("#speedUpload"),
        speedDownloadNote: $("#speedDownloadNote"),
        speedUploadNote: $("#speedUploadNote"),
        speedData: $("#speedData"),
        speedHint: $("#speedHint"),
        exportCsv: $("#exportCsv"),
        exportJson: $("#exportJson"),
        toastStack: $("#toastStack"),
    };

    /* ------------------------------------------------------------------
       Utilities
       ------------------------------------------------------------------ */

    function cssVar(name) {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }

    function withAlpha(color, alpha) {
        const value = (color || "").trim();
        if (value.startsWith("#")) {
            let hex = value.slice(1);
            if (hex.length === 3) hex = hex.split("").map((part) => part + part).join("");
            const number = Number.parseInt(hex, 16);
            if (!Number.isFinite(number)) return value;
            const red = (number >> 16) & 255;
            const green = (number >> 8) & 255;
            const blue = number & 255;
            return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
        }
        if (value.startsWith("rgb(")) {
            return value.replace("rgb(", "rgba(").replace(")", `, ${alpha})`);
        }
        if (value.startsWith("rgba(")) {
            return value.replace(/[\d.]+\)$/, `${alpha})`);
        }
        return value;
    }

    function formatNumber(value, digits = 1) {
        if (value === null || value === undefined || value === "" || Number.isNaN(Number(value))) {
            return "—";
        }
        return Number(value).toFixed(digits);
    }

    function setMetricValue(id, value, digits = 1) {
        const el = document.getElementById(id);
        if (!el) return;
        const numeric = value !== null && value !== undefined && !Number.isNaN(Number(value));
        el.textContent = numeric ? Number(value).toFixed(digits) : "—";
        const wrapper = el.closest(".metric-value");
        if (wrapper) wrapper.classList.toggle("is-muted", !numeric);
    }

    function formatDuration(seconds) {
        if (!Number.isFinite(Number(seconds)) || Number(seconds) < 0) return "0s";
        const total = Math.round(Number(seconds));
        if (total < 60) return `${total}s`;
        if (total < 3600) {
            const minutes = Math.floor(total / 60);
            const rest = total % 60;
            return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
        }
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
    }

    function formatBytes(bytes) {
        const value = Number(bytes);
        if (!Number.isFinite(value) || value <= 0) return "0 MB";
        if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)} GB`;
        return `${(value / 1_000_000).toFixed(1)} MB`;
    }

    function looksLikeIp(value) {
        return /^(\d{1,3}\.){3}\d{1,3}$/.test(value || "") || (value || "").includes(":");
    }

    function localTime(iso) {
        if (!iso) return "—";
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return "—";
        return date.toLocaleTimeString([], { hour12: false });
    }

    function createIcon(id, className = "icon") {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", className);
        svg.setAttribute("aria-hidden", "true");
        const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
        use.setAttribute("href", `#${id}`);
        svg.append(use);
        return svg;
    }

    async function fetchWithTimeout(url, options = {}, timeout = 15000) {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), timeout);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            window.clearTimeout(timer);
        }
    }

    async function readJson(response) {
        try {
            return await response.json();
        } catch (error) {
            return {};
        }
    }

    function friendlyError(error) {
        if (!error) return "Something went wrong.";
        if (error.name === "AbortError") return "The request timed out. Is the local server still running?";
        if (error instanceof TypeError) return "Could not reach the local API.";
        return error.message || "Something went wrong.";
    }

    function showToast(message, type = "info") {
        const toast = document.createElement("div");
        toast.className = "toast";
        toast.dataset.type = type;
        const iconId = {
            success: "i-check",
            error: "i-alert",
            warning: "i-alert",
            info: "i-info",
        }[type] || "i-info";
        toast.append(createIcon(iconId));
        const text = document.createElement("span");
        text.textContent = message;
        toast.append(text);
        els.toastStack.append(toast);

        window.requestAnimationFrame(() => toast.classList.add("is-visible"));
        window.setTimeout(() => {
            toast.classList.remove("is-visible");
            window.setTimeout(() => toast.remove(), 250);
        }, 4200);

        while (els.toastStack.children.length > 4) {
            els.toastStack.firstElementChild.remove();
        }
    }

    function setApiNotice(visible, message) {
        els.apiNotice.hidden = !visible;
        if (message) els.apiNoticeText.textContent = message;
        if (visible) {
            els.connectionPill.dataset.state = "error";
            els.statusText.textContent = "Offline";
        } else if (!state.busy) {
            els.connectionPill.dataset.state = state.live ? "live" : "paused";
            els.statusText.textContent = state.live ? "Live" : "Paused";
        }
    }

    function showFieldError(message) {
        els.targetError.textContent = message;
        els.targetError.hidden = false;
        els.targetInputRow.classList.add("is-invalid");
        els.targetInput.setAttribute("aria-invalid", "true");
        els.targetInput.focus();
    }

    function clearFieldError() {
        els.targetError.hidden = true;
        els.targetError.textContent = "";
        els.targetInputRow.classList.remove("is-invalid");
        els.targetInput.removeAttribute("aria-invalid");
    }

    function setBusy(busy) {
        state.busy = busy;
        els.toggleButton.disabled = busy;
        els.toggleButton.classList.toggle("is-loading", busy);
        els.toggleLabel.textContent = busy
            ? (state.live ? "Pausing" : "Starting")
            : (state.live ? "Pause" : "Start");
    }

    /* ------------------------------------------------------------------
       State & controls
       ------------------------------------------------------------------ */

    function updateToggleButton() {
        els.toggleButton.dataset.live = String(state.live);
        if (!state.busy) {
            els.toggleLabel.textContent = state.live ? "Pause" : "Start";
        }
        const use = els.toggleButton.querySelector(".button-icon use");
        if (use) use.setAttribute("href", state.live ? "#i-pause" : "#i-play");
        els.toggleButton.setAttribute("aria-label", state.live ? "Pause monitoring" : "Start monitoring");
    }

    function updatePresetActive() {
        $$(".preset-chip").forEach((chip) => {
            chip.classList.toggle("is-active", chip.dataset.host === state.target);
        });
    }

    function setLive(live, target) {
        state.live = Boolean(live);
        if (target) state.target = target;
        els.navTarget.textContent = state.target || "—";
        els.navTarget.title = state.target || "";
        els.connectionPill.dataset.state = state.live ? "live" : "paused";
        els.statusText.textContent = state.live ? "Live" : "Paused";
        updateToggleButton();
        updatePresetActive();
        schedulePoll();
    }

    function renderStatus(payload) {
        state.status = payload;
        state.target = payload.target || state.target;
        els.navTarget.textContent = state.target;
        els.navTarget.title = state.target;
        els.resolvedIp.textContent = payload.target_ip || "unresolved";
        els.resolvedIp.title = payload.target_ip ? `Resolved address: ${payload.target_ip}` : "Target has not resolved yet";
        els.platformLabel.textContent = payload.platform || "—";
        els.versionLabel.textContent = payload.version ? `v${payload.version}` : "v2.1.0";
        renderCommands(payload.commands || []);
        updatePresetActive();
    }

    function renderCommands(commands) {
        els.commandList.replaceChildren();
        if (!commands.length) {
            const item = document.createElement("li");
            item.className = "commands-hint";
            item.textContent = "No commands available.";
            els.commandList.append(item);
            return;
        }

        commands.forEach((entry) => {
            const item = document.createElement("li");
            const button = document.createElement("button");
            button.type = "button";
            button.className = "command-item";

            const copy = document.createElement("span");
            copy.className = "command-copy";
            const label = document.createElement("span");
            label.className = "command-label";
            label.textContent = entry.label;
            const code = document.createElement("span");
            code.className = "command-code";
            code.textContent = entry.command;
            copy.append(label, code);

            const action = document.createElement("span");
            action.className = "command-action";
            action.append(createIcon("i-copy"), document.createTextNode("Copy"));

            button.append(copy, action);
            button.addEventListener("click", () => copyCommand(button, entry));
            item.append(button);
            els.commandList.append(item);
        });
    }

    async function copyText(text) {
        if (navigator.clipboard && window.isSecureContext) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (error) {
                /* fall through to the legacy path */
            }
        }
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.append(area);
        area.select();
        let copied = false;
        try {
            copied = document.execCommand("copy");
        } catch (error) {
            copied = false;
        }
        area.remove();
        return copied;
    }

    async function copyCommand(button, entry) {
        const copied = await copyText(entry.command);
        if (!copied) {
            showToast("Copy failed — select the command and copy it manually.", "error");
            return;
        }
        button.classList.add("is-copied");
        const action = button.querySelector(".command-action");
        action.replaceChildren(createIcon("i-check"), document.createTextNode("Copied"));
        showToast(`${entry.label} copied to clipboard.`, "success");
        window.setTimeout(() => {
            button.classList.remove("is-copied");
            action.replaceChildren(createIcon("i-copy"), document.createTextNode("Copy"));
        }, 1800);
    }

    /* ------------------------------------------------------------------
       Monitoring actions
       ------------------------------------------------------------------ */

    async function startTarget(host) {
        const target = (host || "").trim();
        if (!target) {
            showFieldError("Enter a hostname or IP address to monitor.");
            return;
        }
        if (target.startsWith("-") || /\s/.test(target)) {
            const message = "Hostnames cannot contain spaces or start with a dash.";
            showFieldError(message);
            showToast(message, "error");
            return;
        }
        if (target.length > 253) {
            const message = "That hostname is too long.";
            showFieldError(message);
            showToast(message, "error");
            return;
        }
        if (state.busy) return;

        clearFieldError();
        setBusy(true);
        try {
            const response = await fetchWithTimeout("/start", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ target }).toString(),
            }, 25000);
            const payload = await readJson(response);

            if (!response.ok || !payload.success) {
                throw new Error(payload.error || "The monitor could not start with that target.");
            }

            els.targetInput.value = payload.target || target;
            setLive(true, payload.target || target);
            setApiNotice(false);
            try {
                const status = await fetchStatus();
                if (status) renderStatus(status);
            } catch (error) {
                /* the probe loop is already alive; status will catch up */
            }
            await fetchStats();
            showToast(`Monitoring ${payload.target || target}.`, "success");
        } catch (error) {
            if (error instanceof TypeError) {
                setApiNotice(true);
            }
            showFieldError(friendlyError(error));
            showToast(friendlyError(error), "error");
        } finally {
            setBusy(false);
        }
    }

    async function pauseMonitoring() {
        if (state.busy) return;
        setBusy(true);
        try {
            const response = await fetchWithTimeout("/stop", { method: "POST" }, 15000);
            const payload = await readJson(response);
            if (!response.ok || !payload.success) {
                throw new Error(payload.error || "Could not pause monitoring.");
            }
            setLive(false);
            setApiNotice(false);
            await fetchStats();
            showToast("Monitoring paused. History is preserved for export.", "info");
        } catch (error) {
            if (error instanceof TypeError) setApiNotice(true);
            showToast(friendlyError(error), "error");
        } finally {
            setBusy(false);
        }
    }

    function handleToggle() {
        if (state.live) {
            pauseMonitoring();
            return;
        }
        startTarget(els.targetInput.value);
    }

    function handleFormSubmit() {
        const typed = els.targetInput.value.trim();
        if (state.live && typed && typed !== state.target) {
            startTarget(typed);
            return;
        }
        handleToggle();
    }

    /* ------------------------------------------------------------------
       Data fetching & rendering
       ------------------------------------------------------------------ */

    async function fetchStatus() {
        const requestId = (state.statusRequestId = (state.statusRequestId || 0) + 1);
        const response = await fetchWithTimeout("/api/status", { cache: "no-store" }, 8000);
        if (!response.ok) throw new Error("Status endpoint returned an error.");
        const payload = await readJson(response);
        if (requestId !== state.statusRequestId) return null;
        return payload;
    }

    async function fetchStats() {
        const requestId = (state.statsRequestId = (state.statsRequestId || 0) + 1);
        try {
            const response = await fetchWithTimeout("/api/stats", { cache: "no-store" }, 9000);
            if (!response.ok) throw new Error("Telemetry endpoint returned an error.");
            const payload = await readJson(response);
            if (payload.error) throw new Error(payload.error);
            if (requestId !== state.statsRequestId) return false;

            state.stats = payload;
            setApiNotice(false);
            renderStats(payload);
            return true;
        } catch (error) {
            if (requestId !== state.statsRequestId) return false;
            setApiNotice(true, "The local monitor is not responding. Retrying automatically…");
            return false;
        }
    }

    function renderStats(payload) {
        const current = payload.current || {};
        const history = payload.history || {};
        const prediction = payload.prediction || {};
        const meta = payload.meta || {};

        const latency = current.latency;
        const ping = current.ping;
        const jitter = current.jitter;
        const loss = current.packet_loss;
        const dns = current.dns_latency;
        const download = current.download_speed;
        const upload = current.upload_speed;

        setMetricValue("latencyValue", latency, 1);
        setMetricValue("jitterValue", jitter, 1);
        setMetricValue("lossValue", loss, 1);
        setMetricValue("dnsValue", dns, 0);
        setMetricValue("downloadValue", download, 2);
        setMetricValue("uploadValue", upload, 2);

        $("#latencyHint").textContent = ping === null || ping === undefined
            ? "No reply from target"
            : `Latest RTT ${formatNumber(ping, 1)} ms`;
        $("#dnsHint").textContent = looksLikeIp(state.target)
            ? "IP target · no lookup"
            : "Name resolution time";

        setBadge("#latencyState", latency, [
            { max: 40, label: "excellent", tone: "is-good" },
            { max: 90, label: "okay", tone: "" },
            { max: 150, label: "elevated", tone: "is-warning" },
            { max: Infinity, label: "high", tone: "is-danger" },
        ]);
        setBadge("#jitterState", jitter, [
            { max: 5, label: "smooth", tone: "is-good" },
            { max: 20, label: "uneasy", tone: "is-warning" },
            { max: Infinity, label: "high", tone: "is-danger" },
        ]);
        setBadge("#lossState", loss, [
            { max: 0.01, label: "clean", tone: "is-good" },
            { max: 2, label: "minor", tone: "is-warning" },
            { max: Infinity, label: "loss", tone: "is-danger" },
        ]);
        if (looksLikeIp(state.target)) {
            setBadgeLabel("#dnsState", "direct", "");
        } else if (dns === null || dns === undefined) {
            setBadgeLabel("#dnsState", "n/a", "");
        } else {
            setBadge("#dnsState", dns, [
                { max: 50, label: "fast", tone: "is-good" },
                { max: 150, label: "okay", tone: "" },
                { max: Infinity, label: "slow", tone: "is-warning" },
            ]);
        }

        renderSparklines(history);
        renderHealth(current);
        renderForecast(prediction);
        renderRecommendations(payload.recommendations || []);
        renderSession(meta, payload.server_time);
        syncLiveState(meta);
        updateChart(history);

        const chartEmptyText = els.chartEmpty.querySelector("p");
        if (chartEmptyText && state.chartSupported) {
            chartEmptyText.textContent = "Waiting for the first samples…";
        }
    }

    function setBadgeLabel(selector, label, tone) {
        const el = $(selector);
        if (!el) return;
        el.textContent = label;
        el.className = `metric-badge${tone ? ` ${tone}` : ""}`;
    }

    function setBadge(selector, value, bands) {
        if (value === null || value === undefined) {
            setBadgeLabel(selector, "no data", "");
            return;
        }
        const numeric = Math.abs(Number(value));
        const band = bands.find((entry) => numeric <= entry.max) || bands[bands.length - 1];
        setBadgeLabel(selector, band.label, band.tone);
    }

    function renderSession(meta, serverTime) {
        els.lastSync.textContent = localTime(serverTime);
        els.sampleCount.textContent = Number(meta.samples || 0).toLocaleString();
        els.uptime.textContent = formatDuration(meta.uptime_seconds || 0);
        if (meta.target_ip) {
            els.resolvedIp.textContent = meta.target_ip;
            els.resolvedIp.title = `Resolved address: ${meta.target_ip}`;
        }
    }

    function syncLiveState(meta) {
        if (state.busy || meta.monitoring === undefined) return;
        const monitoring = Boolean(meta.monitoring);
        if (monitoring === state.live) return;
        state.live = monitoring;
        els.connectionPill.dataset.state = monitoring ? "live" : "paused";
        els.statusText.textContent = monitoring ? "Live" : "Paused";
        updateToggleButton();
    }

    function renderSparklines(history) {
        const spark = (selector, values, colorName) => {
            const container = $(selector);
            if (container) drawSparkline(container, values || [], cssVar(colorName));
        };
        spark('[data-spark="latency"]', history.latency, "--accent");
        spark('[data-spark="jitter"]', history.jitter, "--violet");
        spark('[data-spark="packet_loss"]', history.packet_loss, "--rose");
        spark('[data-spark="dns"]', history.dns, "--amber");
        spark('[data-spark="download"]', history.download, "--cyan");
        spark('[data-spark="upload"]', history.upload, "--emerald");
    }

    function drawSparkline(container, rawValues, color) {
        const values = rawValues
            .filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)))
            .slice(-40)
            .map(Number);

        if (values.length < 2) {
            container.replaceChildren();
            return;
        }

        const width = 100;
        const height = 30;
        const pad = 2;
        const min = Math.min(...values);
        const max = Math.max(...values);
        const range = max - min || 1;
        const step = (width - pad * 2) / (values.length - 1);

        const points = values.map((value, index) => {
            const x = pad + index * step;
            const y = height - pad - ((value - min) / range) * (height - pad * 2);
            return [x, y];
        });

        const line = points
            .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
            .join(" ");
        const area = `${line} L${points[points.length - 1][0].toFixed(1)} ${height - pad} L${points[0][0].toFixed(1)} ${height - pad} Z`;

        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
        svg.setAttribute("preserveAspectRatio", "none");

        const fill = document.createElementNS("http://www.w3.org/2000/svg", "path");
        fill.setAttribute("d", area);
        fill.setAttribute("fill", withAlpha(color, 0.14));

        const stroke = document.createElementNS("http://www.w3.org/2000/svg", "path");
        stroke.setAttribute("d", line);
        stroke.setAttribute("fill", "none");
        stroke.setAttribute("stroke", color);
        stroke.setAttribute("stroke-width", "1.5");
        stroke.setAttribute("stroke-linecap", "round");
        stroke.setAttribute("stroke-linejoin", "round");

        svg.append(fill, stroke);
        container.replaceChildren(svg);
    }

    function renderHealth(current) {
        const detail = current.health_detail || {};
        const rawScore = detail.score ?? current.health_score ?? 0;
        const score = Math.max(0, Math.min(100, Math.round(Number(rawScore) || 0)));
        const circumference = 326.73;

        els.healthScore.textContent = String(score);
        els.healthRing.style.strokeDashoffset = String(circumference * (1 - score / 100));
        els.healthRing.style.stroke = score >= 85 ? cssVar("--emerald") : score >= 65 ? cssVar("--amber") : cssVar("--rose");
        els.healthRingWrap.setAttribute("aria-label", `Connection health ${score} out of 100`);

        let grade = "degraded";
        let gradeLabel = "Degraded";
        if (score >= 85) {
            grade = "optimal";
            gradeLabel = "Optimal";
        } else if (score >= 65) {
            grade = "fair";
            gradeLabel = "Fair";
        }
        els.healthGrade.dataset.grade = grade;
        els.healthGrade.textContent = gradeLabel;

        const latencySub = clampScore(detail.latency);
        const jitterSub = clampScore(detail.jitter);
        const lossSub = clampScore(detail.loss);

        els.healthLatencyValue.textContent = `${latencySub}`;
        els.healthJitterValue.textContent = `${jitterSub}`;
        els.healthLossValue.textContent = `${lossSub}%`;
        els.healthLatencyBar.style.width = `${latencySub}%`;
        els.healthJitterBar.style.width = `${jitterSub}%`;
        els.healthLossBar.style.width = `${lossSub}%`;

        let note;
        if (current.status === "Paused") {
            note = "Monitoring is paused. These values reflect the last recorded sample.";
        } else if (current.online === false) {
            note = `No reply from ${state.target}. The host may be offline, blocking ICMP, or unreachable from this network.`;
        } else if (score >= 85) {
            note = "Latency, jitter, and packet delivery are all in a healthy range right now.";
        } else if (score >= 65) {
            note = "The connection is usable, but one metric is pulling the score down.";
        } else {
            note = "Conditions are degraded. Check the advisory list for the likely cause.";
        }
        els.healthNote.textContent = note;
    }

    function clampScore(value) {
        if (value === null || value === undefined || Number.isNaN(Number(value))) return 0;
        return Math.max(0, Math.min(100, Math.round(Number(value))));
    }

    function renderForecast(prediction) {
        const probability = Number(prediction.probability) || 0;
        const risk = String(prediction.risk_level || "Low").toLowerCase();
        const trend = prediction.trend || "Stable";
        const calibrating = prediction.confidence === "Calibrating";

        let riskKey = "low";
        if (calibrating) riskKey = "calibrating";
        else if (prediction.predicted_lag || risk === "critical") riskKey = "critical";
        else if (risk === "high") riskKey = "high";
        else if (risk === "moderate") riskKey = "moderate";

        els.forecast.dataset.risk = riskKey;

        if (calibrating) {
            els.riskBadge.textContent = "Calibrating";
            els.forecastTitle.textContent = "Calibrating the model";
            els.forecastText.textContent = "A few more samples are needed before the regression model can make a call.";
        } else if (riskKey === "critical" || riskKey === "high") {
            els.riskBadge.textContent = `${prediction.risk_level || "High"} risk`;
            els.forecastTitle.textContent = prediction.predicted_lag ? "A lag spike is likely" : "Conditions are worsening";
            els.forecastText.textContent = prediction.predicted_lag
                ? `Latency is trending ${trend.toLowerCase()} at ${formatNumber(prediction.slope, 2)} ms per sample. The model expects the sharpest rise ${String(prediction.time_to_lag || "soon").toLowerCase()}.`
                : `Variance is climbing. Keep an eye on the next minute before starting anything latency-sensitive.`;
        } else if (riskKey === "moderate") {
            els.riskBadge.textContent = "Moderate risk";
            els.forecastTitle.textContent = "Some turbulence ahead";
            els.forecastText.textContent = "The connection is mostly stable, but the model sees enough variance to warrant caution.";
        } else {
            els.riskBadge.textContent = "Low risk";
            els.forecastTitle.textContent = "The next minute looks stable";
            els.forecastText.textContent = "Regression and variance checks forecast steady latency with no spike pattern forming.";
        }

        els.probabilityValue.textContent = calibrating ? "—" : `${Math.round(probability)}%`;
        els.probabilityBar.style.width = `${calibrating ? 0 : probability}%`;
        els.timeToSpike.textContent = calibrating ? "—" : (prediction.time_to_lag || "—");
        els.confidenceValue.textContent = prediction.confidence || "—";

        const trendText = {
            Rising: "↗ Rising",
            Spiking: "↑ Spiking",
            Falling: "↘ Falling",
            Stable: "→ Stable",
            Calibrating: "Calibrating",
        }[trend] || trend;
        els.trendValue.textContent = trendText;
        els.trendValue.className = trend === "Rising" || trend === "Spiking"
            ? "trend-up"
            : trend === "Falling"
                ? "trend-down"
                : "trend-flat";

        if (calibrating || !prediction.slope) {
            els.slopeValue.textContent = "—";
        } else {
            const sign = Number(prediction.slope) > 0 ? "+" : "";
            els.slopeValue.textContent = `${sign}${formatNumber(prediction.slope, 2)} ms/s`;
        }

        if (prediction.predicted_lag && !state.predictedLag) {
            playSpikeAlert();
        }
        state.predictedLag = Boolean(prediction.predicted_lag);
    }

    function renderRecommendations(recommendations) {
        const signature = JSON.stringify(recommendations);
        if (signature === state.recSignature) return;
        state.recSignature = signature;

        els.recCount.textContent = String(recommendations.length);
        els.recommendations.replaceChildren();

        if (!recommendations.length) {
            const empty = document.createElement("p");
            empty.className = "rec-desc";
            empty.textContent = "No advisories right now.";
            els.recommendations.append(empty);
            return;
        }

        const iconByType = {
            critical: "i-alert",
            warning: "i-alert",
            info: "i-info",
            optimal: "i-check",
        };

        recommendations.forEach((recommendation) => {
            const type = recommendation.type || "info";
            const article = document.createElement("article");
            article.className = "rec";
            article.dataset.type = type;

            const head = document.createElement("div");
            head.className = "rec-head";
            head.append(createIcon(iconByType[type] || "i-info", "icon rec-icon"));

            const title = document.createElement("h3");
            title.className = "rec-title";
            title.textContent = recommendation.title || "Advisory";
            head.append(title);

            const severity = document.createElement("span");
            severity.className = "rec-severity";
            severity.textContent = type;
            head.append(severity);

            const description = document.createElement("p");
            description.className = "rec-desc";
            description.textContent = recommendation.description || "";

            const action = document.createElement("div");
            action.className = "rec-action";
            action.append(createIcon("i-arrow-right"));
            const actionText = document.createElement("span");
            actionText.textContent = recommendation.action || "No action needed.";
            action.append(actionText);

            article.append(head, description, action);
            els.recommendations.append(article);
        });
    }

    /* ------------------------------------------------------------------
       Chart
       ------------------------------------------------------------------ */

    const SERIES = [
        { key: "latency", label: "Avg latency", colorVar: "--accent", unit: " ms", fill: true, dash: [] },
        { key: "ping", label: "Ping RTT", colorVar: "--cyan", unit: " ms", fill: false, dash: [4, 4] },
        { key: "jitter", label: "Jitter", colorVar: "--violet", unit: " ms", fill: false, dash: [] },
        { key: "packet_loss", label: "Packet loss", colorVar: "--rose", unit: "%", fill: true, dash: [] },
    ];

    function gradient(ctx, color, topAlpha) {
        const canvas = document.getElementById("telemetryChart");
        const height = canvas ? Math.max(120, canvas.clientHeight) : 320;
        const fill = ctx.createLinearGradient(0, 0, 0, height);
        fill.addColorStop(0, withAlpha(color, topAlpha));
        fill.addColorStop(1, withAlpha(color, 0));
        return fill;
    }

    function initChart() {
        if (!state.chartSupported) {
            els.chartEmpty.hidden = false;
            const message = els.chartEmpty.querySelector("p");
            if (message) message.textContent = "The chart library could not load. Live metrics still update.";
            return;
        }

        const canvas = document.getElementById("telemetryChart");
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        const colors = {
            accent: cssVar("--accent"),
            cyan: cssVar("--cyan"),
            violet: cssVar("--violet"),
            rose: cssVar("--rose"),
        };

        window.Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
        window.Chart.defaults.font.size = 10;

        state.chart = new window.Chart(ctx, {
            type: "line",
            data: {
                labels: [],
                datasets: SERIES.map((series, index) => ({
                    label: series.label,
                    data: [],
                    borderColor: colors[series.colorVar.slice(2)],
                    backgroundColor: series.fill
                        ? gradient(ctx, colors[series.colorVar.slice(2)], index === 3 ? 0.13 : 0.26)
                        : "transparent",
                    borderWidth: index === 0 ? 2 : 1.4,
                    borderDash: series.dash,
                    fill: series.fill,
                    tension: 0.32,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    pointBorderWidth: 2,
                    pointBackgroundColor: colors[series.colorVar.slice(2)],
                    pointBorderColor: cssVar("--panel-solid"),
                    spanGaps: series.key !== "ping",
                    yAxisID: series.key === "packet_loss" ? "yLoss" : "y",
                })),
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 280 },
                interaction: { mode: "index", intersect: false },
                layout: { padding: { top: 4, right: 2 } },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: cssVar("--panel-solid"),
                        borderColor: cssVar("--border-strong"),
                        borderWidth: 1,
                        titleColor: cssVar("--text"),
                        bodyColor: cssVar("--muted"),
                        padding: 10,
                        boxWidth: 7,
                        boxHeight: 7,
                        usePointStyle: true,
                        displayColors: true,
                        callbacks: {
                            label(context) {
                                const value = context.parsed.y;
                                if (value === null || value === undefined) return `${context.dataset.label}: no data`;
                                const unit = context.dataset.yAxisID === "yLoss" ? "%" : " ms";
                                return `${context.dataset.label}: ${Number(value).toFixed(1)}${unit}`;
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        grid: { color: cssVar("--border"), drawTicks: false },
                        border: { display: false },
                        ticks: {
                            color: cssVar("--faint"),
                            maxTicksLimit: 7,
                            maxRotation: 0,
                            autoSkip: true,
                            font: { size: 9.5 },
                        },
                    },
                    y: {
                        beginAtZero: true,
                        grace: "18%",
                        grid: { color: cssVar("--border"), drawTicks: false },
                        border: { display: false },
                        ticks: {
                            color: cssVar("--faint"),
                            font: { size: 9.5 },
                            maxTicksLimit: 6,
                            callback: (value) => `${value}`,
                        },
                    },
                    yLoss: {
                        position: "right",
                        beginAtZero: true,
                        max: 100,
                        grid: { drawOnChartArea: false },
                        border: { display: false },
                        ticks: {
                            color: cssVar("--faint"),
                            font: { size: 9.5 },
                            maxTicksLimit: 5,
                            callback: (value) => `${value}%`,
                        },
                    },
                },
            },
        });

        applyChartTheme();
    }

    function applyChartTheme() {
        if (!state.chart) return;
        const chart = state.chart;
        const colors = {
            accent: cssVar("--accent"),
            cyan: cssVar("--cyan"),
            violet: cssVar("--violet"),
            rose: cssVar("--rose"),
            faint: cssVar("--faint"),
            border: cssVar("--border"),
            panel: cssVar("--panel-solid"),
            text: cssVar("--text"),
            muted: cssVar("--muted"),
        };

        chart.data.datasets[0].borderColor = colors.accent;
        chart.data.datasets[0].backgroundColor = gradient(chart.ctx, colors.accent, 0.26);
        chart.data.datasets[0].pointBackgroundColor = colors.accent;
        chart.data.datasets[1].borderColor = colors.cyan;
        chart.data.datasets[1].pointBackgroundColor = colors.cyan;
        chart.data.datasets[2].borderColor = colors.violet;
        chart.data.datasets[2].pointBackgroundColor = colors.violet;
        chart.data.datasets[3].borderColor = colors.rose;
        chart.data.datasets[3].backgroundColor = gradient(chart.ctx, colors.rose, 0.13);
        chart.data.datasets[3].pointBackgroundColor = colors.rose;

        chart.data.datasets.forEach((dataset) => {
            dataset.pointBorderColor = colors.panel;
        });

        chart.options.scales.x.grid.color = colors.border;
        chart.options.scales.y.grid.color = colors.border;
        chart.options.scales.x.ticks.color = colors.faint;
        chart.options.scales.y.ticks.color = colors.faint;
        chart.options.scales.yLoss.ticks.color = colors.faint;
        chart.options.plugins.tooltip.backgroundColor = colors.panel;
        chart.options.plugins.tooltip.borderColor = cssVar("--border-strong");
        chart.options.plugins.tooltip.titleColor = colors.text;
        chart.options.plugins.tooltip.bodyColor = colors.muted;
        chart.update("none");
    }

    function updateChart(history) {
        const timestamps = history.timestamps || [];
        const canvas = document.getElementById("telemetryChart");

        if (!state.chart) {
            els.chartEmpty.hidden = timestamps.length > 0;
            els.chartRange.textContent = timestamps.length
                ? `${timestamps.length} samples captured`
                : "No samples yet";
            return;
        }

        if (!timestamps.length) {
            state.chart.data.labels = [];
            state.chart.data.datasets.forEach((dataset) => { dataset.data = []; });
            state.chart.update("none");
            els.chartEmpty.hidden = false;
            els.chartRange.textContent = "No samples yet";
            return;
        }

        const newest = new Date(timestamps[timestamps.length - 1]).getTime();
        const indices = [];
        for (let index = 0; index < timestamps.length; index += 1) {
            const time = new Date(timestamps[index]).getTime();
            if (!state.windowSeconds || newest - time <= state.windowSeconds * 1000) {
                indices.push(index);
            }
        }

        const labels = indices.map((index) => localTime(timestamps[index]));
        state.chart.data.labels = labels;
        state.chart.data.datasets.forEach((dataset, datasetIndex) => {
            const key = SERIES[datasetIndex].key;
            const values = history[key] || [];
            dataset.data = indices.map((index) => {
                const value = values[index];
                return value === null || value === undefined ? null : value;
            });
            dataset.pointRadius = indices.length > 90 ? 0 : 2;
        });

        state.chart.update("none");
        els.chartEmpty.hidden = true;

        const windowLabel = state.windowSeconds === 0 ? "All history" : `Last ${formatWindow(state.windowSeconds)}`;
        els.chartRange.textContent = `${windowLabel} · ${indices.length} sample${indices.length === 1 ? "" : "s"}`;

        if (canvas) {
            canvas.setAttribute(
                "aria-label",
                `Line chart showing ${indices.length} samples of latency, jitter, and packet loss over ${windowLabel.toLowerCase()}.`
            );
        }
    }

    function formatWindow(seconds) {
        if (seconds >= 60) return `${seconds / 60}m`;
        return `${seconds}s`;
    }

    /* ------------------------------------------------------------------
       Benchmark
       ------------------------------------------------------------------ */

    function openBenchmark() {
        if (els.speedDialog.open) els.speedDialog.close();
        if (!els.benchmarkDialog.open) {
            els.benchmarkDialog.showModal();
        }
        if (!state.benchmarked) runBenchmark();
    }

    function closeBenchmark() {
        if (els.benchmarkDialog.open) els.benchmarkDialog.close();
    }

    async function runBenchmark() {
        if (state.benchmarking) return;
        state.benchmarking = true;
        els.runBenchmark.disabled = true;
        els.runBenchmark.classList.add("is-loading");
        els.benchmarkLabel.textContent = "Probing";
        els.benchmarkStamp.textContent = "Measuring nodes…";

        els.benchmarkList.replaceChildren();
        for (let index = 0; index < 5; index += 1) {
            const skeleton = document.createElement("div");
            skeleton.className = "benchmark-skeleton";
            skeleton.innerHTML = '<span class="skeleton-line skeleton-line--title"></span><span class="skeleton-line"></span>';
            els.benchmarkList.append(skeleton);
        }

        try {
            const response = await fetchWithTimeout("/api/benchmark", { cache: "no-store" }, 30000);
            const payload = await readJson(response);
            if (!response.ok) throw new Error(payload.error || "Benchmark failed.");

            const results = (payload.results || []).slice().sort((left, right) => {
                if (left.latency === null || left.latency === undefined) return 1;
                if (right.latency === null || right.latency === undefined) return -1;
                return left.latency - right.latency;
            });

            const online = results.filter((item) => item.latency !== null && item.latency !== undefined);
            const maximum = online.length ? Math.max(...online.map((item) => item.latency)) : 1;
            const fastest = online.length ? online[0] : null;

            els.benchmarkList.replaceChildren();

            if (!results.length) {
                const empty = document.createElement("p");
                empty.className = "benchmark-error";
                empty.textContent = "No nodes were reachable for this benchmark.";
                els.benchmarkList.append(empty);
            }

            results.forEach((node) => {
                const reachable = node.latency !== null && node.latency !== undefined;
                const row = document.createElement("div");
                row.className = "bench-row";
                if (!reachable) row.classList.add("is-unreachable");
                if (fastest && node.host === fastest.host) row.classList.add("is-fastest");

                const head = document.createElement("div");
                head.className = "bench-row-head";

                const name = document.createElement("div");
                name.className = "bench-name";
                const strong = document.createElement("strong");
                strong.textContent = node.name;
                if (fastest && node.host === fastest.host) {
                    const badge = document.createElement("span");
                    badge.className = "bench-fastest";
                    badge.textContent = "Fastest";
                    strong.append(badge);
                }
                const meta = document.createElement("span");
                meta.textContent = `${node.host}${node.note ? ` · ${node.note}` : ""}`;
                name.append(strong, meta);

                const latency = document.createElement("span");
                latency.className = "bench-latency";
                if (reachable) {
                    latency.textContent = `${Number(node.latency).toFixed(1)} ms`;
                    latency.style.color = node.latency > 100
                        ? cssVar("--rose")
                        : node.latency > 50
                            ? cssVar("--amber")
                            : cssVar("--emerald");
                } else {
                    latency.textContent = "No reply";
                    latency.classList.add("is-unreachable");
                }

                head.append(name, latency);

                const track = document.createElement("div");
                track.className = "bench-track";
                const bar = document.createElement("i");
                bar.style.width = reachable ? `${Math.max(4, (node.latency / Math.max(maximum, 1)) * 100)}%` : "0%";
                track.append(bar);

                row.append(head, track);
                els.benchmarkList.append(row);
            });

            els.benchmarkStamp.textContent = payload.tested_at
                ? `Updated ${localTime(payload.tested_at)}`
                : "Benchmark complete";
            state.benchmarked = true;
        } catch (error) {
            els.benchmarkList.replaceChildren();
            const failure = document.createElement("p");
            failure.className = "benchmark-error";
            failure.textContent = friendlyError(error);
            els.benchmarkList.append(failure);
            els.benchmarkStamp.textContent = "Benchmark failed";
        } finally {
            state.benchmarking = false;
            els.runBenchmark.disabled = false;
            els.runBenchmark.classList.remove("is-loading");
            els.benchmarkLabel.textContent = state.benchmarked ? "Run again" : "Run benchmark";
        }
    }

    /* ------------------------------------------------------------------
       Speed test
       ------------------------------------------------------------------ */

    function openSpeedTest() {
        if (els.benchmarkDialog.open) els.benchmarkDialog.close();
        if (!els.speedDialog.open) els.speedDialog.showModal();
    }

    function closeSpeedTest() {
        if (els.speedDialog.open) els.speedDialog.close();
    }

    function renderSpeedResult(payload) {
        const errors = Array.isArray(payload.errors) ? payload.errors : [];
        const download = payload.download || null;
        const upload = payload.upload || null;

        const apply = (valueEl, noteEl, result, errorLabel) => {
            const stat = valueEl.closest(".speed-stat");
            stat.classList.toggle("is-failed", !result);
            if (result) {
                const mbps = Number(result.mbps);
                valueEl.textContent = formatNumber(mbps, mbps < 10 ? 2 : 1);
                noteEl.textContent = `${formatBytes(result.bytes)} in ${formatNumber(result.seconds, 1)}s`;
            } else {
                valueEl.textContent = "—";
                noteEl.textContent = errorLabel;
            }
        };

        apply(els.speedDownload, els.speedDownloadNote, download, errors.find((item) => /^download/i.test(item)) || "No data");
        apply(els.speedUpload, els.speedUploadNote, upload, errors.find((item) => /^upload/i.test(item)) || "No data");

        els.speedData.textContent = formatBytes(payload.data_used_bytes);
        els.speedStamp.textContent = payload.tested_at
            ? `Tested ${localTime(payload.tested_at)}`
            : "Test complete";
        els.speedHint.textContent = errors.length
            ? errors.join(" ")
            : "Measured against Cloudflare's speed endpoint. Results vary with network load.";

        state.speedTested = true;
        showToast(
            errors.length ? "Speed test finished with warnings." : "Speed test complete.",
            errors.length ? "warning" : "success"
        );
    }

    async function runSpeedTest() {
        if (state.speedTesting) return;
        state.speedTesting = true;
        els.runSpeedTest.disabled = true;
        els.runSpeedTest.classList.add("is-loading");
        els.speedTestLabel.textContent = "Testing";
        els.speedStamp.textContent = "Running… about 10–25 seconds";
        els.speedDownload.textContent = "—";
        els.speedUpload.textContent = "—";
        els.speedDownloadNote.textContent = "Measuring…";
        els.speedUploadNote.textContent = "Measuring…";
        els.speedData.textContent = "—";
        els.speedHint.textContent = "Testing download, then upload. Keep this tab open.";
        $$(".speed-stat").forEach((stat) => stat.classList.remove("is-failed"));

        try {
            const response = await fetchWithTimeout("/api/speedtest", { cache: "no-store" }, 45000);
            const payload = await readJson(response);
            if (!response.ok) throw new Error(payload.error || "Speed test failed.");
            renderSpeedResult(payload);
        } catch (error) {
            els.speedDownload.textContent = "—";
            els.speedUpload.textContent = "—";
            els.speedDownloadNote.textContent = "Not measured";
            els.speedUploadNote.textContent = "Not measured";
            els.speedStamp.textContent = "Speed test failed";
            els.speedHint.textContent = error.name === "AbortError"
                ? "The speed test timed out. Try again in a moment."
                : friendlyError(error);
            showToast("Speed test failed.", "error");
        } finally {
            state.speedTesting = false;
            els.runSpeedTest.disabled = false;
            els.runSpeedTest.classList.remove("is-loading");
            els.speedTestLabel.textContent = state.speedTested ? "Run again" : "Run test";
        }
    }

    /* ------------------------------------------------------------------
       Sound, theme, polling
       ------------------------------------------------------------------ */

    function setSound(enabled, announce = false) {
        state.sound = Boolean(enabled);
        els.soundToggle.setAttribute("aria-pressed", String(state.sound));
        els.soundToggle.setAttribute("aria-label", state.sound ? "Disable spike alerts" : "Enable spike alerts");
        try {
            localStorage.setItem("lagpulse-sound", state.sound ? "1" : "0");
        } catch (error) {
            /* storage is optional */
        }
        if (state.sound) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (Ctx && !state.audioCtx) {
                try {
                    state.audioCtx = new Ctx();
                } catch (error) {
                    /* audio is optional */
                }
            }
        }
        if (announce) {
            showToast(state.sound ? "Spike alerts enabled." : "Spike alerts muted.", state.sound ? "success" : "info");
        }
    }

    async function playSpikeAlert() {
        if (!state.sound || state.speedTesting) return;
        const now = Date.now();
        if (now - state.lastSpikeAt < 20000) return;
        state.lastSpikeAt = now;

        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;

        try {
            if (!state.audioCtx) state.audioCtx = new Ctx();
            const ctx = state.audioCtx;
            if (ctx.state === "suspended") await ctx.resume();

            [0, 0.18].forEach((offset, index) => {
                const oscillator = ctx.createOscillator();
                const gain = ctx.createGain();
                const start = ctx.currentTime + offset;
                oscillator.type = "sine";
                oscillator.frequency.setValueAtTime(index === 0 ? 660 : 880, start);
                gain.gain.setValueAtTime(0.0001, start);
                gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
                oscillator.connect(gain);
                gain.connect(ctx.destination);
                oscillator.start(start);
                oscillator.stop(start + 0.18);
            });
        } catch (error) {
            /* the browser may block audio until a gesture */
        }
    }

    function toggleTheme() {
        state.theme = state.theme === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", state.theme);
        try {
            localStorage.setItem("lagpulse-theme", state.theme);
        } catch (error) {
            /* storage is optional */
        }
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute("content", state.theme === "dark" ? "#0b0f14" : "#f5f7f8");
        els.themeToggle.setAttribute("aria-label", state.theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
        applyChartTheme();
        if (state.stats) renderSparklines(state.stats.history || {});
    }

    function schedulePoll(delay) {
        window.clearTimeout(state.pollTimer);
        if (document.hidden) return;
        const nextDelay = typeof delay === "number" ? delay : (state.live ? 1000 : 3000);
        state.pollTimer = window.setTimeout(async () => {
            const ok = await fetchStats();
            schedulePoll(ok ? undefined : 3000);
        }, Math.max(500, nextDelay));
    }

    /* ------------------------------------------------------------------
       Events
       ------------------------------------------------------------------ */

    function bindEvents() {
        els.targetForm.addEventListener("submit", (event) => {
            event.preventDefault();
            handleFormSubmit();
        });

        els.targetInput.addEventListener("input", clearFieldError);

        $$(".preset-chip").forEach((chip) => {
            chip.addEventListener("click", () => {
                const host = chip.dataset.host;
                els.targetInput.value = host;
                clearFieldError();
                startTarget(host);
            });
        });

        els.retryButton.addEventListener("click", async () => {
            const ok = await fetchStats();
            if (ok) {
                try {
                    const status = await fetchStatus();
                    if (status) renderStatus(status);
                } catch (error) {
                    /* stats are back even if status lags */
                }
            }
            schedulePoll(ok ? undefined : 3000);
        });

        els.themeToggle.addEventListener("click", toggleTheme);
        els.soundToggle.addEventListener("click", () => setSound(!state.sound, true));

        els.benchmarkButton.addEventListener("click", openBenchmark);
        els.runBenchmark.addEventListener("click", runBenchmark);
        els.closeBenchmark.addEventListener("click", closeBenchmark);

        els.speedTestButton.addEventListener("click", openSpeedTest);
        els.runSpeedTest.addEventListener("click", runSpeedTest);
        els.closeSpeedTest.addEventListener("click", closeSpeedTest);

        els.benchmarkDialog.addEventListener("click", (event) => {
            if (event.target !== els.benchmarkDialog) return;
            const rect = els.benchmarkDialog.getBoundingClientRect();
            const outside = event.clientX < rect.left || event.clientX > rect.right
                || event.clientY < rect.top || event.clientY > rect.bottom;
            if (outside) closeBenchmark();
        });

        els.speedDialog.addEventListener("click", (event) => {
            if (event.target !== els.speedDialog) return;
            const rect = els.speedDialog.getBoundingClientRect();
            const outside = event.clientX < rect.left || event.clientX > rect.right
                || event.clientY < rect.top || event.clientY > rect.bottom;
            if (outside) closeSpeedTest();
        });

        $$(".segment").forEach((button) => {
            button.addEventListener("click", () => {
                $$(".segment").forEach((item) => item.classList.toggle("is-active", item === button));
                state.windowSeconds = Number(button.dataset.window);
                if (state.stats) updateChart(state.stats.history || {});
            });
        });

        $$(".legend-item").forEach((button) => {
            button.addEventListener("click", () => {
                if (!state.chart) return;
                const index = Number(button.dataset.series);
                const dataset = state.chart.data.datasets[index];
                if (!dataset) return;
                dataset.hidden = !dataset.hidden;
                const visible = !dataset.hidden;
                button.classList.toggle("is-active", visible);
                button.setAttribute("aria-pressed", String(visible));
                state.chart.update();
            });
        });

        [els.exportCsv, els.exportJson].forEach((link) => {
            link.addEventListener("click", () => showToast("Preparing your session export…", "info"));
        });

        document.addEventListener("visibilitychange", () => {
            if (document.hidden) {
                window.clearTimeout(state.pollTimer);
            } else {
                fetchStats().then((ok) => schedulePoll(ok ? undefined : 3000));
            }
        });

        document.addEventListener("keydown", (event) => {
            const tag = (event.target.tagName || "").toLowerCase();
            if (tag === "input" || tag === "textarea" || event.target.isContentEditable) return;
            if (event.ctrlKey || event.metaKey || event.altKey) return;

            const key = event.key.toLowerCase();
            if ((els.benchmarkDialog.open || els.speedDialog.open) && key !== "b" && key !== "t") return;

            if (key === "s") {
                event.preventDefault();
                handleToggle();
            } else if (key === "b") {
                event.preventDefault();
                if (els.benchmarkDialog.open) closeBenchmark();
                else openBenchmark();
            } else if (key === "m") {
                event.preventDefault();
                setSound(!state.sound, true);
            } else if (key === "t") {
                event.preventDefault();
                if (els.speedDialog.open) closeSpeedTest();
                else openSpeedTest();
            }
        });

        const navLinks = $$(".main-nav a");
        const sections = navLinks
            .map((link) => document.querySelector(link.getAttribute("href")))
            .filter(Boolean);

        if ("IntersectionObserver" in window && sections.length) {
            const observer = new IntersectionObserver((entries) => {
                const visible = entries
                    .filter((entry) => entry.isIntersecting)
                    .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
                if (!visible) return;
                navLinks.forEach((link) => {
                    link.classList.toggle("is-active", link.getAttribute("href") === `#${visible.target.id}`);
                });
            }, { rootMargin: "-25% 0px -60% 0px", threshold: [0.05, 0.3] });
            sections.forEach((section) => observer.observe(section));
        }
    }

    /* ------------------------------------------------------------------
       Boot
       ------------------------------------------------------------------ */

    async function init() {
        try {
            state.sound = localStorage.getItem("lagpulse-sound") === "1";
        } catch (error) {
            state.sound = false;
        }
        setSound(state.sound, false);
        els.themeToggle.setAttribute(
            "aria-label",
            state.theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
        );

        initChart();
        bindEvents();

        let status = null;
        try {
            status = await fetchStatus();
            if (status) {
                els.targetInput.value = status.target || "8.8.8.8";
                renderStatus(status);
                setLive(status.monitoring, status.target);
            }
        } catch (error) {
            setApiNotice(true, "The local monitor is not responding. Start the FastAPI server, then retry.");
        }

        const statsOk = await fetchStats();
        if (!status && state.stats) {
            setLive(Boolean(state.stats.meta && state.stats.meta.monitoring), state.stats.target || "8.8.8.8");
        }

        schedulePoll(statsOk ? undefined : 3000);
    }

    init();
})();
