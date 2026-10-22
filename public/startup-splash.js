(() => {
  const api = window.electron;
  if (!api) return;

  const appVersionNode = document.getElementById("app-version");
  if (appVersionNode) {
    void Promise.resolve()
      .then(() => api.getAppVersion())
      .then((version) => {
        if (typeof version === "string" && version.trim())
          appVersionNode.textContent = `Silo v${version.trim()}`;
        else
          appVersionNode.textContent = "Silo version unavailable";
      })
      .catch(() => {
        appVersionNode.textContent = "Silo version unavailable";
      });
  }

  const statusNode = document.getElementById("status");
  const countNode = document.getElementById("count");
  const phaseNode = document.getElementById("phase");
  const trackNode = document.getElementById("track");
  const fillNode = document.getElementById("fill");
  let startup = { ready: false, step: 0, total: 7, label: "Starting…" };
  let search = {
    status: "preparing",
    percentage: 0,
    phase: "Preparing saved search index",
    phaseProgress: null,
    records: 0,
    message: "Preparing the saved search index…",
  };
  const progressStaleAfterMs = 6000;
  let lastSearchMeasurementAt = Date.now();
  let lastStartupCheckpointAt = Date.now();
  let startupEventReceived = false;
  let searchEventReceived = false;

  const formatCount = (value) => Number(value || 0).toLocaleString();
  const formatElapsed = (elapsedMs) => {
    const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = String(seconds % 60).padStart(2, "0");
    return hours > 0
      ? `${hours}h ${String(minutes).padStart(2, "0")}m`
      : `${minutes}m ${remainder}s`;
  };

  const paint = () => {
    const now = Date.now();
    const hasMeasuredSearchProgress = typeof search.phaseProgress === "number";
    const showSearch = search.status === "preparing" &&
      (hasMeasuredSearchProgress || search.percentage > 0 || search.records > 0 || startup.ready);
    let message = startup.label || "Starting Silo…";
    let phase = startup.ready
      ? `Opening your library · ${formatElapsed(now - lastStartupCheckpointAt)}`
      : `Startup phase · no checkpoint for ${formatElapsed(now - lastStartupCheckpointAt)}`;
    let percentage = null;

    if (showSearch) {
      message = search.message || "Preparing local search…";
      const searchModelIsLoading = /offline search model|warming/i.test(
        search.message || "",
      );
      const searchProgressIsFresh =
        now - lastSearchMeasurementAt < progressStaleAfterMs;
      if (
        hasMeasuredSearchProgress &&
        searchProgressIsFresh &&
        !searchModelIsLoading
      ) {
        percentage = Math.max(0, Math.min(99, Number(search.phaseProgress)));
        const displayedPercentage = percentage.toFixed(1).replace(/\.0$/, "");
        phase = `${search.phase || "Search preparation"} · ${displayedPercentage}%`;
      } else {
        phase = `No measured search progress · ${formatElapsed(now - lastSearchMeasurementAt)}`;
      }
    } else if (startup.ready && search.status === "ready") {
      message = "Search is ready · opening your library…";
      phase = `Opening your library · ${formatElapsed(now - lastStartupCheckpointAt)}`;
    } else if (startup.ready && search.status === "error") {
      message = "Search needs attention · opening Silo…";
      phase = `Opening Silo · ${formatElapsed(now - lastStartupCheckpointAt)}`;
    } else if (startup.ready && search.status === "unavailable") {
      message = search.message || "Search storage is unavailable · opening Silo…";
      phase = `Opening Silo · ${formatElapsed(now - lastStartupCheckpointAt)}`;
    }

    statusNode.textContent = message;
    phaseNode.textContent = phase;
    trackNode.setAttribute(
      "aria-label",
      percentage === null ? "Silo startup activity" : "Search preparation progress",
    );
    const recordLabel = /reading saved search records/i.test(search.message)
      ? "records read"
      : /validating saved search records|finalizing saved search index/i.test(search.message)
        ? "records validated"
        : /building the fast local search index/i.test(search.message)
          ? "search records"
          : "saved records";
    countNode.textContent = search.records > 0
      ? `${formatCount(search.records)} ${recordLabel}`
      : "";
    if (percentage === null) {
      trackNode.classList.add("indeterminate");
      trackNode.removeAttribute("aria-valuenow");
      fillNode.style.width = "";
    } else {
      trackNode.classList.remove("indeterminate");
      trackNode.setAttribute("aria-valuenow", String(percentage));
      fillNode.style.width = `${percentage}%`;
    }
  };

  const applyTheme = (theme) => {
    const resolved = theme === "system"
      ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
      : theme;
    document.documentElement.dataset.theme = resolved === "light" ? "light" : "dark";
  };

  document.getElementById("minimize").addEventListener("click", () => {
    void api.minimizeStartupSplash();
  });

  api.onStartupProgress((state) => {
    if (
      state.ready !== startup.ready ||
      state.step !== startup.step ||
      state.label !== startup.label
    )
      lastStartupCheckpointAt = Date.now();
    startupEventReceived = true;
    startup = state;
    paint();
  });
  api.onSearchIndexReadiness((state) => {
    if (
      state.percentage !== search.percentage ||
      state.records !== search.records ||
      state.phaseProgress !== search.phaseProgress
    )
      lastSearchMeasurementAt = Date.now();
    searchEventReceived = true;
    search = state;
    paint();
  });
  if (api.onContentSettingsChanged)
    api.onContentSettingsChanged((settings) => applyTheme(settings.theme));

  void api.getStartupState().then((state) => {
    if (!startupEventReceived) {
      if (state.step >= startup.step || state.ready) {
        if (
          state.ready !== startup.ready ||
          state.step !== startup.step ||
          state.label !== startup.label
        )
          lastStartupCheckpointAt = Date.now();
        startup = state;
      }
    }
    paint();
  }).catch(() => undefined);
  void api.getSearchIndexReadiness().then((state) => {
    if (!searchEventReceived) {
      if (
        state.percentage !== search.percentage ||
        state.records !== search.records ||
        state.phaseProgress !== search.phaseProgress
      )
        lastSearchMeasurementAt = Date.now();
      search = state;
    }
    paint();
  }).catch(() => undefined);
  void api.getContentSettings().then((settings) => applyTheme(settings.theme)).catch(() => undefined);
  window.setInterval(paint, 1000);
  paint();
})();
