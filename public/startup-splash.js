(() => {
  const api = window.electron;
  if (!api) return;

  const statusNode = document.getElementById("status");
  const countNode = document.getElementById("count");
  const phaseNode = document.getElementById("phase");
  const trackNode = document.getElementById("track");
  const fillNode = document.getElementById("fill");
  let startup = { ready: false, step: 0, total: 7, label: "Starting…" };
  let search = {
    status: "preparing",
    percentage: 0,
    records: 0,
    message: "Preparing the saved search index…",
  };

  const formatCount = (value) => Number(value || 0).toLocaleString();
  const paint = () => {
    const hasMeasuredSearchProgress = search.percentage > 0;
    const showSearch = search.status === "preparing" &&
      (hasMeasuredSearchProgress || startup.ready);
    let message = startup.label || "Starting Silo…";
    let phase = startup.ready
      ? "Opening your first library view"
      : `Startup step ${Math.min(startup.step + 1, startup.total)} of ${startup.total}`;
    let percentage = null;

    if (showSearch) {
      message = search.message || "Preparing local search…";
      phase = "Preparing the saved search index";
      percentage = hasMeasuredSearchProgress
        ? Math.max(0, Math.min(99, Math.round(search.percentage)))
        : null;
    } else if (startup.ready && search.status === "ready") {
      message = "Search is ready · opening your library…";
      phase = "Almost ready";
      percentage = 100;
    } else if (startup.ready && search.status === "error") {
      message = "Search needs attention · opening Silo…";
      phase = "Opening with search diagnostics available";
    } else if (startup.ready && search.status === "unavailable") {
      message = search.message || "Search storage is unavailable · opening Silo…";
      phase = "Opening with search unavailable";
    }

    statusNode.textContent = message;
    phaseNode.textContent = phase;
    countNode.textContent = search.records > 0
      ? `${formatCount(search.records)} saved records`
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
    startup = state;
    paint();
  });
  api.onSearchIndexReadiness((state) => {
    search = state;
    paint();
  });
  if (api.onContentSettingsChanged)
    api.onContentSettingsChanged((settings) => applyTheme(settings.theme));

  void api.getStartupState().then((state) => {
    if (state.step >= startup.step || state.ready) startup = state;
    paint();
  }).catch(() => undefined);
  void api.getSearchIndexReadiness().then((state) => {
    search = state;
    paint();
  }).catch(() => undefined);
  void api.getContentSettings().then((settings) => applyTheme(settings.theme)).catch(() => undefined);
  paint();
})();
