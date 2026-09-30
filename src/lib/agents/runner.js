// 9router agents-b — runner inti (Opsi B).
// Prinsip: status = exit code + file log SAJA (tak pernah parse isi output harness).
// Semua state file-based di DATA_DIR/agents (volume), bukan DB.
import fs from "node:fs";
import path from "path";
import { spawn } from "node:child_process";
import { DATA_DIR } from "@/lib/dataDir.js";

export const AGENTS_DIR = path.join(DATA_DIR, "agents");
const CONFIG_PATH = path.join(AGENTS_DIR, "config.json");
const STATE_PATH = path.join(AGENTS_DIR, "state.json");
const WRAP_PATH = path.join(AGENTS_DIR, "wrap.sh");
const HOME_DIR = path.join(AGENTS_DIR, "home");

export const HARNESS_IDS = ["opencode", "pi"];

const DEFAULT_CONFIG = {
  harness: "opencode",
  count: 3,
  loop: true,
  taskMode: "shared", // shared | slot
  task: "",
  tasks: [],
  models: ["agent-fast", "agent-deep", "matahari_free"],
};

// Wrapper per slot: loop + penanda gen. Dijalankan detached (session leader)
// sehingga Stop = kill group (-pid) mematikan loop beserta anaknya.
const WRAP_SH = `#!/bin/sh
LOG="$1"; OKD="$2"; FAILD="$3"; LOOP="$4"; shift 4
K=1
while :; do
  printf '[gen-%s start %s]\\n' "$K" "$(date -u +%FT%TZ)" >> "$LOG"
  "$@" >> "$LOG" 2>&1
  C=$?
  printf '[gen-%s exit=%s %s]\\n' "$K" "$C" "$(date -u +%FT%TZ)" >> "$LOG"
  [ "$LOOP" = "1" ] || break
  if [ "$C" -eq 0 ]; then sleep "$OKD"; else sleep "$FAILD"; fi
  K=$((K+1))
done
`;

const BASE_URL = process.env.AGENTS_BASE_URL || "http://localhost:20128/v1";
const CONTEXT_LIMIT = 200000;
const OUTPUT_LIMIT = 16384;

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(p, v) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

function writeIfChanged(p, content) {
  ensureDir(path.dirname(p));
  try {
    if (fs.readFileSync(p, "utf8") === content) return;
  } catch {
    /* belum ada */
  }
  fs.writeFileSync(p, content);
}

export function getConfig() {
  return { ...DEFAULT_CONFIG, ...readJson(CONFIG_PATH, {}) };
}

export function saveConfig(cfg) {
  writeJson(CONFIG_PATH, cfg);
}

const SAFE_MODEL_RE = /^[a-zA-Z0-9_.\-/]+$/;

export function sanitizeConfig(input) {
  const c = { ...DEFAULT_CONFIG, ...(input || {}) };
  if (!HARNESS_IDS.includes(c.harness)) throw new Error(`harness harus salah satu: ${HARNESS_IDS.join("|")}`);
  c.count = Math.min(5, Math.max(1, parseInt(c.count, 10) || 1));
  c.loop = !!c.loop;
  c.taskMode = c.taskMode === "slot" ? "slot" : "shared";
  c.task = String(c.task || "").slice(0, 20000);
  c.tasks = Array.isArray(c.tasks)
    ? c.tasks.slice(0, 5).map((t) => String(t || "").slice(0, 20000))
    : [];
  const models = Array.isArray(c.models) ? c.models.slice(0, 5) : [];
  c.models = models.map((m) => String(m || "").trim()).filter((m) => m && SAFE_MODEL_RE.test(m));
  if (!c.models.length) c.models = [...DEFAULT_CONFIG.models];
  return c;
}

function taskFor(cfg, index0) {
  const t = cfg.taskMode === "slot" ? cfg.tasks[index0] || cfg.task : cfg.task;
  return String(t || "");
}

function workRoot() {
  if (process.env.AGENTS_WORK_DIR) return process.env.AGENTS_WORK_DIR;
  try {
    fs.mkdirSync("/work", { recursive: true });
    fs.accessSync("/work", fs.constants.W_OK);
    return "/work";
  } catch {
    const p = path.join(AGENTS_DIR, "work");
    ensureDir(p);
    return p;
  }
}

// Config harness ditulis ulang tiap launch (idempoten) ke HOME di dalam volume.
function ensureHarnessHome(cfg) {
  const apiKey = process.env.AGENTS_API_KEY;
  if (!apiKey) throw new Error("AGENTS_API_KEY belum di-set di environment container");
  ensureDir(HOME_DIR);
  writeIfChanged(
    path.join(HOME_DIR, ".config", "opencode", "opencode.json"),
    JSON.stringify(
      {
        provider: {
          "9router": {
            npm: "@ai-sdk/openai-compatible",
            name: "9router",
            options: { baseURL: BASE_URL, apiKey },
            models: Object.fromEntries(
              cfg.models.map((m) => [m, { name: m, limit: { context: CONTEXT_LIMIT, output: OUTPUT_LIMIT } }]),
            ),
          },
        },
        model: `9router/${cfg.models[0]}`,
      },
      null,
      2,
    ),
  );
  writeIfChanged(
    path.join(HOME_DIR, ".pi", "agent", "models.json"),
    JSON.stringify(
      {
        providers: {
          "9router": {
            baseUrl: BASE_URL,
            apiKey,
            api: "openai-completions",
            models: cfg.models.map((m) => ({ id: m, name: m, contextWindow: CONTEXT_LIMIT, maxTokens: OUTPUT_LIMIT })),
          },
        },
      },
      null,
      2,
    ),
  );
}

// Bentuk argumen = persis pola yang tervalidasi di Phase 0 spike (Alpine).
function commandFor(harness, task, model, workDir) {
  if (harness === "pi") {
    return ["pi", "-p", "--no-session", "--provider", "9router", "--model", model, task];
  }
  return ["opencode", "run", "-m", `9router/${model}`, task, "--dir", workDir];
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

function killGroup(pid) {
  try {
    process.kill(-pid, "SIGTERM");
    return true;
  } catch (e) {
    if (e?.code === "ESRCH") return false;
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

function spawnSlot(cfg, n, model, task) {
  const logPath = path.join(AGENTS_DIR, `run-${n}.log`);
  const workDir = path.join(workRoot(), `agent-${n}`);
  ensureDir(workDir);
  ensureDir(AGENTS_DIR);
  fs.writeFileSync(WRAP_PATH, WRAP_SH);
  fs.chmodSync(WRAP_PATH, 0o755);
  const args = [
    WRAP_PATH,
    logPath,
    "5", // delay antar iterasi saat sukses (detik)
    "30", // backoff saat gagal (detik)
    cfg.loop ? "1" : "0",
    ...commandFor(cfg.harness, task, model, workDir),
  ];
  const fd = fs.openSync(logPath, "a");
  let child;
  try {
    child = spawn("sh", args, {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, HOME: HOME_DIR },
      cwd: workDir,
    });
  } finally {
    fs.closeSync(fd);
  }
  child.unref();
  if (!child.pid) throw new Error(`gagal spawn slot ${n}`);
  return {
    n,
    pid: child.pid,
    harness: cfg.harness,
    model,
    task,
    log: logPath,
    work: workDir,
    startedAt: new Date().toISOString(),
    stopped: false,
  };
}

function tail(p, bytes = 4096) {
  try {
    const st = fs.statSync(p);
    const size = Math.min(st.size, bytes);
    if (size <= 0) return "";
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(size);
    try {
      fs.readSync(fd, buf, 0, size, st.size - size);
    } finally {
      fs.closeSync(fd);
    }
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

function decorate(s) {
  const alive = s.pid ? isPidAlive(s.pid) : false;
  const t = tail(s.log || "");
  const genMatches = [...t.matchAll(/gen-(\d+) (?:start|exit)/g)];
  const exitMatches = [...t.matchAll(/gen-(\d+) exit=(-?\d+)/g)];
  const gen = genMatches.length ? Number(genMatches[genMatches.length - 1][1]) : 0;
  const lastExit = exitMatches.length ? Number(exitMatches[exitMatches.length - 1][2]) : null;
  let status;
  if (alive) status = "running";
  else if (s.stopped) status = "stopped";
  else if (lastExit === null) status = "unknown";
  else status = lastExit === 0 ? "done" : "failed";
  return { ...s, alive, gen, lastExit, status };
}

export function getState() {
  const raw = readJson(STATE_PATH, null);
  if (!raw) return { launchedAt: null, slots: [] };
  return { ...raw, slots: (raw.slots || []).map(decorate) };
}

function stopLive(state, slotN) {
  const stopped = [];
  for (const s of state.slots) {
    if (slotN && s.n !== slotN) continue;
    if (s.pid && isPidAlive(s.pid)) {
      killGroup(s.pid);
      stopped.push(s.n);
    }
    s.stopped = true;
  }
  return stopped;
}

// Launch selalu restart: slot hidup dimatikan dulu supaya tak dobel.
export function launch(configInput) {
  const cfg = sanitizeConfig(configInput === undefined ? getConfig() : configInput);
  if (!String(cfg.task || "").trim() && cfg.taskMode === "shared") throw new Error("task kosong");
  if (cfg.taskMode === "slot" && !cfg.task.trim() && cfg.tasks.every((t) => !String(t || "").trim())) {
    throw new Error("task kosong");
  }
  ensureHarnessHome(cfg);
  saveConfig(cfg);
  const prev = readJson(STATE_PATH, null);
  if (prev) stopLive(prev);
  const slots = [];
  for (let i = 0; i < cfg.count; i++) {
    const task = taskFor(cfg, i).trim();
    if (!task) throw new Error(`task slot ${i + 1} kosong`);
    slots.push(spawnSlot(cfg, i + 1, cfg.models[i % cfg.models.length], task));
  }
  const state = { launchedAt: new Date().toISOString(), loop: cfg.loop, harness: cfg.harness, slots };
  writeJson(STATE_PATH, state);
  return getState();
}

export function stop(slotN) {
  const state = readJson(STATE_PATH, null);
  if (!state) return { stopped: [], state: getState() };
  const stopped = stopLive(state, slotN);
  writeJson(STATE_PATH, state);
  return { stopped, state: getState() };
}

export function readLog(slotN, bytes = 65536) {
  const p = path.join(AGENTS_DIR, `run-${slotN}.log`);
  const st = (() => {
    try {
      return fs.statSync(p).size;
    } catch {
      return 0;
    }
  })();
  return { slot: slotN, size: st, log: tail(p, Math.min(bytes, 262144)) };
}

// Dipanggil instrumentation.js saat server boot: bersihkan pid mati +
// respawn wrapper loop yang ikut mati waktu container restart.
export function bootAgents() {
  try {
    const cfg = readJson(CONFIG_PATH, null);
    const state = readJson(STATE_PATH, null);
    if (!cfg || !state || !Array.isArray(state.slots)) return;
    let dirty = false;
    for (const s of state.slots) {
      if (s.stopped || (s.pid && isPidAlive(s.pid))) continue;
      if (!cfg.loop) {
        if (s.pid) {
          s.pid = null;
          dirty = true;
        }
        continue;
      }
      const task = taskFor(cfg, s.n - 1).trim();
      if (!task) continue;
      const fresh = spawnSlot(cfg, s.n, s.model || cfg.models[(s.n - 1) % cfg.models.length], task);
      Object.assign(s, fresh);
      dirty = true;
      console.log(`[agents] respawn loop slot ${s.n} pid=${s.pid}`);
    }
    if (dirty) writeJson(STATE_PATH, state);
  } catch (e) {
    console.error("[agents] boot gagal:", e?.message || e);
  }
}
