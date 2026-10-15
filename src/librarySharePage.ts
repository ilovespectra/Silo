export const LIBRARY_SHARE_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#0b0b0c">
  <title>Silo shared library</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0b0c;
      --surface: #131315;
      --surface-strong: #1b1b1e;
      --surface-soft: #101011;
      --surface-card: #151517;
      --line: #2c2c30;
      --text: #f4f1ed;
      --muted: #9a9690;
      --orange: #ff7a1a;
      --orange-soft: #ff9a4a;
      --shadow: rgba(0, 0, 0, 0.45);
      --button-shadow: rgba(255, 122, 26, 0.22);
      --danger: #d96e60;
      --green: #67c58b;
      font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(circle at top, rgba(255, 122, 26, 0.14), transparent 24%), var(--bg);
      color: var(--text);
    }
    button, input, select { font: inherit; }
    button { cursor: pointer; }
    .wrap {
      max-width: 1180px;
      margin: 0 auto;
      padding: env(safe-area-inset-top) 20px calc(32px + env(safe-area-inset-bottom));
    }
    .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 0 24px;
      border-bottom: 1px solid var(--line);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 11px;
      font-weight: 750;
      letter-spacing: -0.03em;
      font-size: 21px;
    }
    .mark {
      width: 31px;
      height: 31px;
      display: grid;
      place-items: center;
      background: linear-gradient(180deg, var(--orange-soft), var(--orange));
      color: #17110c;
      border-radius: 10px;
      font-size: 17px;
      font-weight: 800;
      box-shadow: 0 10px 18px var(--button-shadow);
    }
    .local {
      font-size: 12px;
      color: var(--muted);
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.01);
      border-radius: 30px;
      padding: 6px 10px;
    }
    .intro { padding: 27px 0 19px; }
    .intro h1 {
      font-size: clamp(25px, 6vw, 38px);
      letter-spacing: -0.045em;
      line-height: 1.1;
      margin: 0 0 8px;
      font-weight: 800;
    }
    .intro p {
      color: var(--muted);
      margin: 0;
      max-width: 780px;
    }
    .controls {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto auto;
      gap: 10px;
      margin: 10px 0 14px;
      align-items: end;
    }
    .search { position: relative; min-width: 0; }
    .search input {
      width: 100%;
      height: 48px;
      padding: 0 15px 0 44px;
      border: 1px solid var(--line);
      border-radius: 13px;
      background: var(--surface);
      color: var(--text);
      outline: none;
    }
    .search input::placeholder { color: var(--muted); }
    .search input:focus {
      border-color: var(--orange);
      box-shadow: 0 0 0 3px rgba(255, 122, 26, 0.18);
    }
    .search:before {
      content: "⌕";
      position: absolute;
      left: 15px;
      top: 8px;
      font-size: 26px;
      color: var(--muted);
    }
    .toolbar-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }
    .button, .type-select {
      min-height: 46px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--surface-strong);
      padding: 0 13px;
      color: var(--text);
    }
    .button.primary {
      background: linear-gradient(180deg, var(--orange-soft), var(--orange));
      border-color: rgba(255, 122, 26, 0.45);
      color: #17110c;
      font-weight: 750;
      box-shadow: 0 12px 20px rgba(255, 122, 26, 0.18);
    }
    .button.utility {
      background: var(--surface-strong);
      color: var(--text);
      font-weight: 600;
    }
    .button.utility.active {
      background: rgba(255, 122, 26, 0.16);
      border-color: rgba(255, 122, 26, 0.38);
      color: var(--text);
    }
    .button.primary:disabled { opacity: 0.42; cursor: not-allowed; }
    .button.quiet { background: transparent; color: var(--muted); }
    .type-select {
      min-width: 150px;
      background: var(--surface-strong);
      color: var(--text);
      outline: none;
    }
    .type-select:focus {
      border-color: var(--orange);
      box-shadow: 0 0 0 3px rgba(255, 122, 26, 0.18);
    }
    .nav {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 40px;
      overflow-x: auto;
      white-space: nowrap;
    }
    .crumb {
      border: 0;
      background: none;
      padding: 5px 2px;
      color: #d8b38e;
      font-weight: 600;
    }
    .crumb:hover { color: var(--orange-soft); }
    .slash { color: #a5a59e; }
    .count { margin-left: auto; color: var(--muted); font-size: 13px; }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 7px 0 14px;
    }
    .toolbar-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .toolbar .button { font-size: 14px; min-height: 40px; }
    .selection { font-size: 13px; color: var(--muted); }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(164px, 1fr));
      gap: 12px;
    }
    .tile {
      position: relative;
      overflow: hidden;
      background: var(--surface-card);
      border: 1px solid var(--line);
      border-radius: 14px;
      min-width: 0;
      box-shadow: 0 14px 24px rgba(0, 0, 0, 0.18);
    }
    .thumb {
      width: 100%;
      aspect-ratio: 1.15;
      object-fit: cover;
      display: block;
      background: #1c1d1e;
      cursor: pointer;
    }
    .folder-art {
      aspect-ratio: 1.15;
      display: grid;
      place-items: center;
      background: linear-gradient(180deg, #26282b, #17191b);
      color: #bcb8b1;
      font-size: 42px;
      cursor: pointer;
    }
    .video-tag {
      position: absolute;
      top: 9px;
      left: 9px;
      padding: 4px 7px;
      background: rgba(17, 24, 17, 0.8);
      color: #fff;
      border-radius: 6px;
      font-size: 11px;
    }
    .check {
      position: absolute;
      top: 9px;
      right: 9px;
      width: 27px;
      height: 27px;
      accent-color: var(--orange);
      filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.25));
    }
    .details { padding: 9px 10px 10px; }
    .filename {
      font-size: 13px;
      font-weight: 640;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .meta {
      display: flex;
      justify-content: space-between;
      gap: 6px;
      color: var(--muted);
      font-size: 11px;
      margin-top: 3px;
    }
    .tile-actions {
      display: flex;
      gap: 6px;
      margin-top: 8px;
    }
    .tile-actions a,
    .tile-actions button {
      flex: 1;
      text-align: center;
      text-decoration: none;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 7px 5px;
      color: var(--text);
      font-size: 12px;
      font-weight: 600;
    }
    .tile-actions a:hover,
    .tile-actions button:hover {
      border-color: rgba(255, 122, 26, 0.42);
    }
    .empty, .status {
      padding: 36px 18px;
      text-align: center;
      color: var(--muted);
    }
    .status.error { color: #efaa98; }
    .load-more {
      display: flex;
      justify-content: center;
      padding: 20px;
    }
    .modal {
      position: fixed;
      inset: 0;
      z-index: 5;
      background: rgba(8, 10, 12, 0.84);
      display: grid;
      grid-template-rows: auto 1fr auto;
      padding: calc(12px + env(safe-area-inset-top)) 14px calc(14px + env(safe-area-inset-bottom));
    }
    .modal-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: #fff;
      gap: 12px;
    }
    .modal-head strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .modal button {
      border: 0;
      border-radius: 10px;
      padding: 9px 12px;
      background: rgba(255, 255, 255, 0.12);
      color: white;
    }
    .preview {
      display: grid;
      place-items: center;
      min-height: 0;
      padding: 14px 0;
    }
    .preview img,
    .preview video {
      max-height: 100%;
      max-width: 100%;
      object-fit: contain;
      border-radius: 7px;
    }
    .modal-foot { display: flex; justify-content: center; }
    .modal-foot a {
      display: inline-block;
      text-decoration: none;
      background: linear-gradient(180deg, var(--orange-soft), var(--orange));
      color: #17110c;
      padding: 11px 18px;
      border-radius: 11px;
      font-weight: 750;
    }
    .hidden { display: none !important; }
    @media (max-width: 760px) {
      .controls { grid-template-columns: 1fr; }
      .toolbar-actions { justify-content: flex-start; }
      .button, .type-select { width: 100%; }
    }
    @media (max-width: 560px) {
      .wrap { padding-left: 14px; padding-right: 14px; }
      .top { padding-top: 15px; }
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
      .tile { border-radius: 12px; }
      .details { padding: 8px; }
      .tile-actions a,
      .tile-actions button { font-size: 11px; }
      .toolbar { align-items: flex-start; flex-direction: column; }
      .toolbar-left { width: 100%; }
      .toolbar-left .button { flex: 1; }
      .local { font-size: 11px; }
      .count { padding-top: 6px; }
      .button, .type-select { min-height: 42px; }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <header class="top">
      <div class="brand"><span class="mark">S</span><span>Silo share</span></div>
      <span class="local">Private · same Wi‑Fi</span>
    </header>

    <section class="intro">
      <h1>Photos worth sharing.</h1>
      <p>Browse and save originals from this shared Silo library. Use trusted Wi‑Fi only; this local connection is not encrypted.</p>
    </section>

    <section class="controls">
      <label class="search">
        <input id="query" type="search" placeholder="Search photos and videos" autocomplete="off" aria-label="Search photos and videos">
      </label>
      <div class="toolbar-actions">
        <button id="toggleExploded" class="button utility" type="button" aria-pressed="false">Explode</button>
      </div>
      <label aria-label="File type filter">
        <select id="showFilter" class="type-select">
          <option value="all">All files</option>
          <option value="image">Photos</option>
          <option value="video">Videos</option>
        </select>
      </label>
      <label aria-label="Sort order">
        <select id="sort" class="type-select">
          <option value="modified-desc">Newest first</option>
          <option value="modified-asc">Oldest first</option>
          <option value="size-desc">Largest first</option>
          <option value="size-asc">Smallest first</option>
          <option value="name-asc">Name A-Z</option>
          <option value="name-desc">Name Z-A</option>
        </select>
      </label>
    </section>

    <select id="source" class="type-select" aria-label="Choose shared library" style="width:100%;max-width:260px;margin:0 0 12px"></select>
    <nav id="breadcrumbs" class="nav" aria-label="Folder path"></nav>

    <div class="toolbar">
      <div class="toolbar-left">
        <button id="downloadSelected" class="button primary" disabled>Save selected</button>
        <button id="downloadAll" class="button quiet">Save all</button>
      </div>
      <span id="count" class="count"></span>
    </div>

    <section id="status" class="status">Connecting to Silo…</section>
    <section id="grid" class="grid" aria-live="polite"></section>
    <div id="loadMore" class="load-more hidden"><button class="button" id="moreButton">Load more</button></div>
  </main>

  <div id="modal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-head">
      <strong id="modalName"></strong>
      <button id="closeModal">Close</button>
    </div>
    <div id="preview" class="preview"></div>
    <div class="modal-foot"><a id="modalDownload">Save to device</a></div>
  </div>

  <script>
  (() => {
    const token = location.pathname.split('/').filter(Boolean).at(-1);
    const api = (part) => '/api/' + token + '/' + part;
    const el = (id) => document.getElementById(id);
    const source = el('source');
    const query = el('query');
    const grid = el('grid');
    const status = el('status');
    const count = el('count');
    const sort = el('sort');
    const showFilter = el('showFilter');
    const toggleExploded = el('toggleExploded');

    const state = {
      folder: '',
      offset: 0,
      nextOffset: null,
      selected: new Set(),
      request: 0,
      debounce: null,
      show: 'all',
      sort: 'modified-desc',
      explode: false,
    };

    const bytes = (n) => {
      if (!Number.isFinite(n)) return '';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let i = 0;
      while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i += 1;
      }
      return (n < 10 && i ? n.toFixed(1) : Math.round(n)) + ' ' + units[i];
    };

    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

    const endpoint = (part, params = {}) => {
      const url = new URL(api(part), location.origin);
      Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
      return url;
    };

    const message = (text, error = false) => {
      status.textContent = text;
      status.classList.toggle('error', error);
      status.classList.toggle('hidden', !text);
    };

    function updateExplodeButton() {
      toggleExploded.classList.toggle('active', state.explode);
      toggleExploded.textContent = state.explode ? 'Exploded' : 'Explode';
      toggleExploded.setAttribute('aria-pressed', String(state.explode));
    }

    function drawCrumbs() {
      const nav = el('breadcrumbs');
      nav.replaceChildren();
      const root = document.createElement('button');
      root.className = 'crumb';
      root.textContent = source.selectedOptions[0]?.textContent || 'Library';
      root.onclick = () => {
        state.folder = '';
        load(true);
      };
      nav.append(root);

      let prefix = '';
      for (const part of state.folder.split('/').filter(Boolean)) {
        const sep = document.createElement('span');
        sep.className = 'slash';
        sep.textContent = '›';
        nav.append(sep);
        prefix = prefix ? prefix + '/' + part : part;
        const target = prefix;
        const button = document.createElement('button');
        button.className = 'crumb';
        button.textContent = part;
        button.onclick = () => {
          state.folder = target;
          load(true);
        };
        nav.append(button);
      }
    }

    function transfer(items, all = false) {
      let form = document.getElementById('downloadForm');
      if (!form) {
        form = document.createElement('form');
        form.id = 'downloadForm';
        form.hidden = true;
        form.method = 'post';
        document.body.append(form);
      }
      form.action = api('download');
      form.replaceChildren();

      const data = document.createElement('input');
      data.type = 'hidden';
      data.name = 'items';
      data.value = JSON.stringify(items);
      form.append(data);

      const allInput = document.createElement('input');
      allInput.type = 'hidden';
      allInput.name = 'all';
      allInput.value = all ? '1' : '0';
      form.append(allInput);
      form.submit();
    }

    function tile(item) {
      const article = document.createElement('article');
      article.className = 'tile';

      if (item.kind === 'folder') {
        article.innerHTML = '<div class="folder-art" aria-label="Folder">▰</div><div class="details"><div class="filename">' + esc(item.name) + '</div><div class="meta"><span>Folder</span></div></div>';
        article.querySelector('.folder-art').onclick = () => {
          state.folder = item.relativePath;
          load(true);
        };
        article.querySelector('.filename').onclick = () => {
          state.folder = item.relativePath;
          load(true);
        };
        return article;
      }

      const previewUrl = endpoint('thumb/' + item.id).toString();
      article.innerHTML = '<img class="thumb" loading="lazy" alt="' + esc(item.name) + '" src="' + previewUrl + '"><span class="video-tag ' + (item.mediaType === 'video' ? '' : 'hidden') + '">VIDEO</span><input class="check" type="checkbox" aria-label="Select ' + esc(item.name) + '"><div class="details"><div class="filename" title="' + esc(item.name) + '">' + esc(item.name) + '</div><div class="meta"><span>' + bytes(item.size) + '</span><span>' + (item.modified ? new Date(item.modified).toLocaleDateString() : '') + '</span></div><div class="tile-actions"><button type="button">Preview</button><a href="' + endpoint('download/' + item.id).toString() + '">Save</a></div></div>';
      article.querySelector('.check').checked = state.selected.has(item.id);
      article.querySelector('.check').onchange = (event) => {
        if (event.target.checked) state.selected.add(item.id);
        else state.selected.delete(item.id);
        updateSelection();
      };
      article.querySelector('.thumb').onclick = () => openPreview(item);
      article.querySelector('.tile-actions button').onclick = () => openPreview(item);
      return article;
    }

    function updateSelection() {
      const button = el('downloadSelected');
      button.disabled = !state.selected.size;
      button.textContent = state.selected.size ? 'Save selected (' + state.selected.size + ')' : 'Save selected';
    }

    async function load(reset = false) {
      if (reset) {
        state.offset = 0;
        state.nextOffset = null;
        grid.replaceChildren();
      }
      const run = ++state.request;
      message(query.value ? 'Searching…' : 'Loading library…');
      drawCrumbs();

      const params = {
        source: source.value,
        folder: state.folder,
        offset: state.offset,
        limit: 72,
        explode: state.explode ? '1' : '0',
        type: state.show,
        sort: state.sort,
      };
      if (query.value.trim()) params.q = query.value.trim();

      try {
        const response = await fetch(endpoint('items', params), { cache: 'no-store' });
        if (!response.ok) throw new Error((await response.text()) || 'Could not load this library.');
        const data = await response.json();
        if (run !== state.request) return;
        if (reset) grid.replaceChildren();

        const fragment = document.createDocumentFragment();
        for (const item of data.items || []) fragment.append(tile(item));
        grid.append(fragment);

        state.nextOffset = data.nextOffset;
        el('loadMore').classList.toggle('hidden', state.nextOffset === null);
        count.textContent = data.total ? data.total.toLocaleString() + ' ' + (query.value ? 'matches' : 'items') : '';
        message((data.items && data.items.length) ? '' : (query.value ? 'No matches found.' : 'This folder is empty.'));
      } catch (error) {
        if (run === state.request) message(error.message || 'Could not load this library.', true);
      }
    }

    function openPreview(item) {
      el('modalName').textContent = item.name;
      el('modalDownload').href = endpoint('download/' + item.id).toString();
      const preview = el('preview');
      preview.replaceChildren();
      const media = document.createElement(item.mediaType === 'video' ? 'video' : 'img');
      media.src = endpoint('media/' + item.id).toString();
      if (item.mediaType === 'video') {
        media.controls = true;
        media.playsInline = true;
        media.preload = 'metadata';
      } else {
        media.alt = item.name;
      }
      preview.append(media);
      el('modal').classList.remove('hidden');
    }

    el('closeModal').onclick = () => {
      el('modal').classList.add('hidden');
      el('preview').replaceChildren();
    };
    el('modal').onclick = (event) => {
      if (event.target === el('modal')) el('closeModal').click();
    };
    el('downloadSelected').onclick = () => transfer([...state.selected]);
    el('downloadAll').onclick = () => transfer([], true);
    el('moreButton').onclick = () => {
      state.offset = state.nextOffset ?? state.offset;
      load(false);
    };

    source.onchange = () => {
      state.folder = '';
      state.selected.clear();
      updateSelection();
      load(true);
    };

    query.oninput = () => {
      clearTimeout(state.debounce);
      state.debounce = setTimeout(() => {
        state.selected.clear();
        updateSelection();
        load(true);
      }, 350);
    };

    showFilter.onchange = () => {
      state.show = showFilter.value;
      state.selected.clear();
      updateSelection();
      load(true);
    };

    sort.onchange = () => {
      state.sort = sort.value;
      state.selected.clear();
      updateSelection();
      load(true);
    };

    toggleExploded.onclick = () => {
      state.explode = !state.explode;
      updateExplodeButton();
      state.selected.clear();
      updateSelection();
      load(true);
    };

    fetch(api('sources'), { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error('This Silo share is no longer available.');
        return r.json();
      })
      .then((data) => {
        source.innerHTML = data.sources.map((s) => '<option value="' + esc(s.id) + '">' + esc(s.label) + '</option>').join('');
        if (!data.sources.length) throw new Error('No shared libraries are available.');
        load(true);
      })
      .catch((error) => message(error.message, true));

    updateSelection();
    updateExplodeButton();
  })();
  </script>
</body>
</html>`;
