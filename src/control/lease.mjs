/**
 * Zakup zadatka — zaseban `tasks/<TASK-ID>.lease.json`.
 *
 * Zakup vezuje radni proces (owner + token) za zadatak; istekao zakup se može
 * preuzeti, tuđi živ ne. Board šema v2 se ne menja. Logika je preneta iz
 * Agent 2.0 `lease.mjs` (baseline 107dfb1), prilagođena Palimpsestu.
 *
 */
import { closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEASE_VERSION = 1;
export const DEFAULT_TTL_MS = 30 * 60 * 1000;

const TASK_ID = /^TASK-[0-9]{1,6}$/;
const MIN_TTL_MS = 1000;

/** Greška zakupa. */
export class LeaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LeaseError';
    this.code = code;
  }
}

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? NaN : parsed;
}

function nowMs(now) {
  const value = typeof now === 'function' ? now() : now;
  const ms = toMs(value);
  if (Number.isNaN(ms)) throw new LeaseError('E_USAGE', 'now nije validno vreme');
  return ms;
}

function assertTaskId(taskId) {
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) {
    throw new LeaseError('E_USAGE', 'taskId mora biti TASK-<broj>');
  }
}

function assertText(value, name, max = 64) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    throw new LeaseError('E_USAGE', name + ' mora biti 1–' + max + ' znakova');
  }
}

function assertTasksRoot(tasksRoot) {
  if (typeof tasksRoot !== 'string' || tasksRoot === '') {
    throw new LeaseError('E_USAGE', 'tasksRoot je obavezan');
  }
}

function writeLeaseFile(file, lease) {
  try {
    writeFileSync(file, JSON.stringify(lease, null, 2) + '\n', 'utf8');
  } catch (error) {
    throw new LeaseError('E_WRITE', 'Zakup nije upisan: ' + error.message);
  }
}

/** Putanja lease fajla. */
export function leasePathFor(tasksRoot, taskId) {
  assertTaskId(taskId);
  return path.join(tasksRoot, taskId + '.lease.json');
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Pročitaj zakup; `null` ako ne postoji. */
export function readLease(tasksRoot, taskId) {
  const file = leasePathFor(tasksRoot, taskId);
  if (!existsSync(file)) return null;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new LeaseError('E_SCHEMA', 'Zakup se ne čita: ' + error.message);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new LeaseError('E_SCHEMA', 'Zakup nije validan JSON: ' + error.message);
  }
}

/** Živ = sada < expiresAt (strogo). */
export function isLeaseLive(lease, now = new Date()) {
  if (lease === null || typeof lease !== 'object') return false;
  const expiry = toMs(lease.expiresAt);
  if (Number.isNaN(expiry)) return false;
  return nowMs(now) < expiry;
}

/** Drži li owner+token živ zakup. */
export function holdsLease({ tasksRoot, taskId, owner, token, now = new Date() } = {}) {
  assertTasksRoot(tasksRoot);
  const lease = readLease(tasksRoot, taskId);
  if (lease === null || !isLeaseLive(lease, now)) return false;
  return lease.owner === owner && lease.token === token;
}

/**
 * Uzmi ili obnovi zakup. Tuđi živ zakup → E_LEASE; istekao se preuzima.
 */
export function acquireLease(options = {}) {
  const { tasksRoot, taskId, owner, token, ttlMs = DEFAULT_TTL_MS, now = () => new Date() } = options;
  assertTasksRoot(tasksRoot);
  assertTaskId(taskId);
  assertText(owner, 'owner');
  assertText(token, 'token');
  if (!Number.isInteger(ttlMs) || ttlMs < MIN_TTL_MS) {
    throw new LeaseError('E_USAGE', 'ttlMs mora biti ceo broj >= ' + MIN_TTL_MS);
  }
  const at = nowMs(now);
  const leaseFile = leasePathFor(tasksRoot, taskId);
  const guardFile = leaseFile + '.guard';
 // Atomski guard (O_EXCL): read→write kritična sekcija ne može imati dva
 // izvršioca. Tuđi guard (proces je pao) se ne briše — prijavljuje se E_LEASE.
  for (let attempt = 0; ; attempt += 1) {
    let fd;
    try {
      fd = openSync(guardFile, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw new LeaseError('E_WRITE', 'Guard zakupa nije napravljen: ' + error.message);
      if (attempt >= 4) throw new LeaseError('E_LEASE', 'Zakup je u promeni: ' + taskId);
      sleepSync(2);
      continue;
    }
    try {
      closeSync(fd);
      const existing = readLease(tasksRoot, taskId);
      if (existing !== null && isLeaseLive(existing, new Date(at))) {
        if (existing.owner !== owner || existing.token !== token) {
          throw new LeaseError('E_LEASE', 'Zakup drži drugi proces: ' + existing.owner);
        }
      }
      const lockedAt = new Date(at).toISOString();
      const lease = {
        version: LEASE_VERSION,
        task: taskId,
        owner,
        token,
        lockedAt,
        expiresAt: new Date(at + ttlMs).toISOString(),
      };
      writeLeaseFile(leaseFile, lease);
      return lease;
    } finally {
      rmSync(guardFile, { force: true });
    }
  }
}

/** Oslobodi zakup; samo owner+token. Nepostojeći → `false`. */
export function releaseLease(options = {}) {
  const { tasksRoot, taskId, owner, token } = options;
  assertTasksRoot(tasksRoot);
  const lease = readLease(tasksRoot, taskId);
  if (lease === null) return false;
  if (lease.owner !== owner || lease.token !== token) {
    throw new LeaseError('E_LEASE', 'Zakup drži drugi proces: ' + lease.owner);
  }
  try {
    rmSync(leasePathFor(tasksRoot, taskId), { force: true });
  } catch (error) {
    throw new LeaseError('E_WRITE', 'Zakup nije oslobođen: ' + error.message);
  }
  return true;
}

/** Živi zakupi, sortirano po task; read-only. */
export function activeLeases({ tasksRoot, now = new Date() } = {}) {
  assertTasksRoot(tasksRoot);
  let entries;
  try {
    entries = readdirSync(tasksRoot);
  } catch {
    throw new LeaseError('E_USAGE', 'tasksRoot ne postoji: ' + path.resolve(tasksRoot));
  }
  const leases = [];
  for (const entry of entries) {
    if (!entry.endsWith('.lease.json')) continue;
    const file = path.join(tasksRoot, entry);
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const taskId = entry.slice(0, -'.lease.json'.length);
    if (!TASK_ID.test(taskId)) continue;
    const lease = readLease(tasksRoot, taskId);
    if (lease !== null && isLeaseLive(lease, now)) leases.push(lease);
  }
  leases.sort((a, b) => (a.task < b.task ? -1 : a.task > b.task ? 1 : 0));
  return leases;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_REJECTED = 1;
const EXIT_USAGE = 2;

function parseCli(argv) {
  const options = { json: false, tasks: undefined, task: undefined, owner: undefined, token: undefined, ttl: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--tasks') { options.tasks = argv[i + 1]; i += 1; continue; }
    if (arg === '--task') { options.task = argv[i + 1]; i += 1; continue; }
    if (arg === '--owner') { options.owner = argv[i + 1]; i += 1; continue; }
    if (arg === '--token') { options.token = argv[i + 1]; i += 1; continue; }
    if (arg === '--ttl') { options.ttl = argv[i + 1]; i += 1; continue; }
  }
  return options;
}

function emit(json, value) {
  if (json) {
    process.stdout.write(JSON.stringify(value) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function fail(code, message, exit = EXIT_USAGE) {
  emit(true, { ok: false, error: { code, message } });
  return exit;
}

function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = parseCli(rest);
  const required = command === 'active' ? options.tasks !== undefined : options.tasks !== undefined && options.task !== undefined;
  try {
    if (command === 'acquire') {
      if (!required || options.owner === undefined || options.token === undefined) {
        return fail('E_USAGE', 'Obavezni: --tasks, --task, --owner i --token');
      }
      const ttlMs = options.ttl === undefined ? undefined : Number(options.ttl);
      const lease = acquireLease({ tasksRoot: options.tasks, taskId: options.task, owner: options.owner, token: options.token, ...(ttlMs === undefined ? {} : { ttlMs }) });
      emit(options.json, lease);
      return EXIT_OK;
    }
    if (command === 'release') {
      if (!required || options.owner === undefined || options.token === undefined) {
        return fail('E_USAGE', 'Obavezni: --tasks, --task, --owner i --token');
      }
      const released = releaseLease({ tasksRoot: options.tasks, taskId: options.task, owner: options.owner, token: options.token });
      emit(options.json, { task: options.task, released });
      return EXIT_OK;
    }
    if (command === 'active') {
      if (!required) return fail('E_USAGE', 'Obavezan: --tasks');
      emit(options.json, { leases: activeLeases({ tasksRoot: options.tasks }) });
      return EXIT_OK;
    }
    return fail('E_USAGE', 'Nepoznata komanda: ' + String(command));
  } catch (error) {
    if (!(error instanceof LeaseError)) throw error;
    return fail(error.code, error.message, error.code === 'E_LEASE' ? EXIT_REJECTED : EXIT_USAGE);
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write((error && error.stack ? error.stack : String(error)) + '\n');
    process.exitCode = EXIT_USAGE;
  }
}
