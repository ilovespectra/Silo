(() => {
  const api = window.electron;
  const state = { catalog: [], sharedPath: "", roots: {}, checks: {}, errors: {} };
  const rows = document.getElementById("rows");
  const status = document.getElementById("status");
  const sharedPath = document.getElementById("sharedPath");
  const applyShared = document.getElementById("applyShared");
  const finish = document.getElementById("finish");

  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
  const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
  };

  function render() {
    sharedPath.textContent = state.sharedPath || "Choose a folder to get started";
    applyShared.disabled = !state.sharedPath;
    rows.innerHTML = state.catalog.map((item) => {
      const destination = state.roots[item.id] || "Choose a shared folder first";
      const check = state.checks[item.id];
      let space = check
        ? `Available: ${formatBytes(check.freeBytes)}`
        : state.errors[item.id] || "Choose or apply a folder to check free space";
      if (check?.removable) space += " · External or removable drive: keep connected";
      const low = check && check.freeBytes < item.estimateBytesPerTenThousand;
      return `<article class="row" data-id="${escapeHtml(item.id)}">
        <div class="row-head"><h2>${escapeHtml(item.name)}</h2><span class="estimate">${escapeHtml(item.estimatePerTenThousand)} / 10,000</span></div>
        <p>${escapeHtml(item.description)}</p>
        <div class="row-bottom"><span class="path" title="${escapeHtml(destination)}">${escapeHtml(destination)}</span><button type="button" data-choose="${escapeHtml(item.id)}">Choose…</button></div>
        <div class="space${low ? " warn" : ""}">${escapeHtml(space)}${low ? " · below the rough estimate" : ""}</div>
      </article>`;
    }).join("");
    const ready = state.catalog.length > 0 && state.catalog.every((item) => state.roots[item.id] && state.checks[item.id]);
    finish.disabled = !ready;
  }

  async function checkRoot(id, root) {
    try {
      const result = await api.inspectCacheDestination(root);
      state.roots[id] = result.path;
      state.checks[id] = result;
      delete state.errors[id];
      return true;
    } catch (error) {
      state.checks[id] = null;
      state.errors[id] = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  document.getElementById("chooseShared").addEventListener("click", async () => {
    status.textContent = "";
    try {
      const result = await api.chooseCacheDestinationFolder(state.sharedPath || undefined);
      if (!result) return;
      state.sharedPath = result.path;
      const nextRoots = {};
      const nextChecks = {};
      for (const item of state.catalog) {
        nextRoots[item.id] = result.path;
        nextChecks[item.id] = result;
      }
      state.roots = nextRoots;
      state.checks = nextChecks;
      state.errors = {};
      render();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  });

  applyShared.addEventListener("click", async () => {
    status.textContent = "";
    try {
      state.roots = {};
      state.checks = {};
      state.errors = {};
      for (const item of state.catalog) await checkRoot(item.id, state.sharedPath);
      render();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      render();
    }
  });

  rows.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-choose]");
    if (!button) return;
    const id = button.dataset.choose;
    const current = state.roots[id] || state.sharedPath || undefined;
    status.textContent = "";
    button.disabled = true;
    try {
      const result = await api.chooseCacheDestinationFolder(current);
      if (!result) return;
      const available = await checkRoot(id, result.path);
      if (!available) throw new Error(state.errors[id]);
      render();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      button.disabled = false;
    }
  });

  finish.addEventListener("click", async () => {
    status.textContent = "Saving cache locations…";
    finish.disabled = true;
    try {
      const result = await api.saveInitialCacheDestinations(state.sharedPath, state.roots);
      status.textContent = result?.restarting
        ? "Saved. Silo is reopening with these cache locations…"
        : "Saved. Silo is opening…";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      render();
    }
  });

  async function load() {
    try {
      const initial = await api.getCacheDestinationSetupState();
      state.catalog = initial.catalog;
      state.sharedPath = initial.sharedPath || "";
      if (initial.roots) {
        state.roots = initial.roots;
        for (const item of state.catalog) {
          await checkRoot(item.id, state.roots[item.id]);
        }
      }
      render();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  }
  void load();
})();
