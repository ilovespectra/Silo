#!/usr/bin/env node
/*
 * `npm run dev`: stop every earlier Silo dev process gracefully, compile main,
 * start the React dev server, launch Electron only once it answers, and tear the
 * whole tree down together. Electron gets SIGTERM first so index writes flush.
 */
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const PORT = 8787;
const GRACE_MS = 12000; // Electron flushes index writes for up to 8s on quit.
const log = (message) => console.log(`[dev] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function processTable() {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
}

function ancestorsOf(pid, table) {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const result = new Set();
  for (let current = byPid.get(pid); current && !result.has(current.pid); current = byPid.get(current.ppid))
    result.add(current.pid);
  return result;
}

function portListeners() {
  const result = spawnSync("lsof", ["-tiTCP:" + PORT, "-sTCP:LISTEN"], { encoding: "utf8" });
  return (result.stdout || "").split("\n").map(Number).filter(Boolean);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function stopAll(pids, label, graceMs = GRACE_MS) {
  if (!pids.length) return;
  log(`Stopping ${label} (${pids.join(", ")})…`);
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && pids.some(alive)) await sleep(250);
  const stubborn = pids.filter(alive);
  for (const pid of stubborn) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  if (stubborn.length) log(`Force-stopped ${stubborn.join(", ")} after ${graceMs / 1000}s.`);
}

/** Earlier launchers first (so nothing respawns), then Electron gracefully, then dev servers. */
async function stopPreviousRun() {
  const table = processTable();
  const mine = ancestorsOf(process.pid, table);
  const inRepo = (entry) => !mine.has(entry.pid) && entry.command.includes(root);
  const launchers = table.filter((entry) => inRepo(entry) &&
    /scripts\/dev\.cjs|node_modules\/\.bin\/concurrently|node_modules\/\.bin\/wait-on|node_modules\/\.bin\/electron /.test(entry.command));
  // Earlier launchers first stop their own Silo (up to GRACE_MS), so give them longer.
  await stopAll(launchers.map((entry) => entry.pid), "previous launchers", GRACE_MS * 2 + 8000);
  // Main Electron processes only; helpers and crashpad exit with their parent.
  const electron = processTable().filter((entry) => !mine.has(entry.pid) &&
    (entry.command.includes(`${root}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`) ||
      /\/(File Browser|silo)\.app\/Contents\/MacOS\/[^/]+$/i.test(entry.command.split(" --")[0])));
  await stopAll(electron.map((entry) => entry.pid), "running Silo instances");
  const servers = processTable().filter((entry) => inRepo(entry) &&
    /react-scripts|fork-ts-checker|webpack/.test(entry.command)).map((entry) => entry.pid);
  await stopAll(Array.from(new Set([...servers, ...portListeners()])).filter((pid) => !mine.has(pid)), `port ${PORT} dev server`);
}

function start(command, args, env = {}) {
  return spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
    detached: true, // Own process group, so the whole subtree stops together.
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (child.exitCode !== null) return reject(new Error("React dev server exited before it was ready."));
      const request = http.get({ host: "localhost", port: PORT, path: "/", timeout: 2000 }, (response) => {
        response.resume();
        resolve();
      });
      request.on("timeout", () => request.destroy());
      request.on("error", () => setTimeout(attempt, 500));
    };
    attempt();
  });
}

async function stopGroup(child, label) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  log(`Stopping ${label}…`);
  try { process.kill(-child.pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + GRACE_MS;
  while (Date.now() < deadline && child.exitCode === null && !child.signalCode) await sleep(200);
  if (child.exitCode === null && !child.signalCode) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
  }
}

async function main() {
  await stopPreviousRun();
  log("Compiling the Electron main process…");
  const compiled = spawnSync(path.join(root, "node_modules/.bin/tsc"), [], { cwd: root, stdio: "inherit" });
  if (compiled.status !== 0) process.exit(compiled.status || 1);
  // macOS shows the dev bundle's name and icon in the Dock and menu bar ("Silo", not "Electron").
  if (process.platform === "darwin")
    spawnSync(process.execPath, [path.join(__dirname, "brand-dev-app.js"), "--quiet"], { cwd: root, stdio: "inherit" });

  let electron = null;
  let shuttingDown = false;
  const react = start(path.join(root, "node_modules/.bin/react-scripts"), ["start"], { PORT: String(PORT), BROWSER: "none" });
  const shutdown = async (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Electron first: it must finish index writes before anything else disappears.
    await stopGroup(electron, "Silo");
    await stopGroup(react, "React dev server");
    process.exit(code);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => void shutdown(0));
  react.on("exit", (code) => void shutdown(code ?? 1));

  log(`Waiting for http://localhost:${PORT}…`);
  try {
    await waitForServer(react);
  } catch (error) {
    log(error.message);
    return shutdown(1);
  }
  if (shuttingDown) return;
  log("Launching Silo…");
  // Large libraries hold ~1M index records in the main process; V8's default heap is too tight.
  electron = start(path.join(root, "node_modules/.bin/electron"),
    [".", "--enable-logging", "--js-flags=--max-old-space-size=8192 --expose-gc", ...process.argv.slice(2)]);
  electron.on("exit", (code) => {
    log(`Silo exited${code ? ` with code ${code}` : ""}.`);
    void shutdown(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
