/**
 * Indeks budnosti — deterministička metrika degradacije.
 *
 * Sedam signala iz stvarnog stanja (memorija, board, kanal) daje penale; indeks
 * 0–100 određuje nivo i kapije: canWork (>= 30) i canStartTask (>= 10).
 * Računanje je read-only; san je jedini lek.
 *
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countChannelRecords, listMemories, MemoryError } from '../memory/memory.mjs';

export const AWAKE_VERSION = 1;
export const AWAKE_THRESHOLDS = { fresh: 60, tired: 30, overheated: 10 };
export const AWAKE_LEVELS = ['fresh', 'tired', 'exhausted', 'overheated'];

const MEMORY_LEVELS = ['kandidati', 'saznanja', 'pravila', 'pitanja', 'povuceno'];
const TASK_ID = /^TASK-[0-9]{1,6}$/;
const MS_PER_HOUR = 3600000;

/** Greška budnosti. */
export class AwakeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AwakeError';
    this.code = code;
  }
}

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? NaN : parsed;
}

function isIsoUtc(value) {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

/** Nivo za indeks (pragovi iz 03-san §6.2). */
export function awakeLevel(index) {
  if (!Number.isFinite(index)) throw new AwakeError('E_USAGE', 'index mora biti broj');
  if (index > AWAKE_THRESHOLDS.fresh) return 'fresh';
  if (index >= AWAKE_THRESHOLDS.tired) return 'tired';
  if (index >= AWAKE_THRESHOLDS.overheated) return 'exhausted';
  return 'overheated';
}

/** Rad se nastavlja samo iznad praga 30. */
export function canWork(index) {
  return index >= AWAKE_THRESHOLDS.tired;
}

/** Novi zadaci se ne primaju ispod praga 10. */
export function canStartTask(index) {
  return index >= AWAKE_THRESHOLDS.overheated;
}

function assertMemoryRoot(memoryRoot) {
  if (typeof memoryRoot !== 'string' || memoryRoot === '') {
    throw new AwakeError('E_MEMORY', 'memoryRoot je obavezan');
  }
  let stat;
  try {
    stat = statSync(memoryRoot);
  } catch {
    throw new AwakeError('E_MEMORY', 'memoryRoot ne postoji: ' + path.resolve(memoryRoot));
  }
  if (!stat.isDirectory()) throw new AwakeError('E_MEMORY', 'memoryRoot nije direktorijum');
}

function readAwakeFile(memoryRoot) {
  const file = path.join(memoryRoot, 'dreams', 'awake.json');
  if (!existsSync(file)) return null;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new AwakeError('E_SCHEMA', 'awake.json se ne čita: ' + error.message);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new AwakeError('E_SCHEMA', 'awake.json nije validan JSON: ' + error.message);
  }
  const valid = value !== null && typeof value === 'object' && !Array.isArray(value)
    && value.version === AWAKE_VERSION
    && isIsoUtc(value.lastSleepAt)
    && Number.isFinite(value.lastIndex)
    && (value.lastRecovery === null || typeof value.lastRecovery === 'object');
  if (!valid) throw new AwakeError('E_SCHEMA', 'awake.json ne prolazi šemu v1');
  return value;
}

function countTasksSince(tasksRoot, sleepMs) {
  if (typeof tasksRoot !== 'string' || tasksRoot === '' || !existsSync(tasksRoot)) return 0;
  let entries;
  try {
    entries = readdirSync(tasksRoot);
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.endsWith('.lease.json')) continue;
    if (!TASK_ID.test(entry.slice(0, -'.json'.length))) continue;
    let value;
    try {
      value = JSON.parse(readFileSync(path.join(tasksRoot, entry), 'utf8'));
    } catch {
      continue;
    }
    if (value === null || typeof value !== 'object' || !isIsoUtc(value.updated)) continue;
    if (Date.parse(value.updated) > sleepMs) count += 1;
  }
  return count;
}

function memoryRecords(memoryRoot) {
  const records = [];
  for (const level of MEMORY_LEVELS) {
    let list;
    try {
      list = listMemories({ memoryRoot, level });
    } catch (error) {
      if (error instanceof MemoryError) throw new AwakeError('E_SCHEMA', 'memorija nije validna: ' + error.message);
      throw error;
    }
    for (const record of list) records.push({ level, record });
  }
  return records;
}

/**
 * Izračunaj indeks budnosti iz stvarnog stanja. Read-only i deterministički.
 */
export function computeAwake(options = {}) {
  const { tasksRoot, memoryRoot, out, now = new Date(), lastSleepAt } = options;
  assertMemoryRoot(memoryRoot);
  const nowMs = toMs(now);
  if (Number.isNaN(nowMs)) throw new AwakeError('E_USAGE', 'now nije validno vreme');
  const awakeFile = readAwakeFile(memoryRoot);
  const sleepSource = lastSleepAt !== undefined && lastSleepAt !== null
    ? lastSleepAt
    : awakeFile !== null ? awakeFile.lastSleepAt : null;
  const sleepMs = sleepSource === null ? null : toMs(sleepSource);
  if (sleepSource !== null && Number.isNaN(sleepMs)) {
    throw new AwakeError('E_SCHEMA', 'lastSleepAt nije validno vreme');
  }

  const records = memoryRecords(memoryRoot);
  const signals = {
    hoursSinceSleep: sleepMs === null ? 0 : Math.max(0, Math.floor((nowMs - sleepMs) / MS_PER_HOUR)),
    tasksSinceSleep: sleepMs === null ? 0 : countTasksSince(tasksRoot, sleepMs),
    stale: records.filter(item => item.record.status === 'stale').length,
    candidates: records.filter(item => item.level === 'kandidati').length,
    questions: records.filter(item => item.level === 'pitanja').length,
    failed: records.reduce((sum, item) => sum + item.record.failed_with.length, 0),
    channelRecords: typeof out === 'string' && out !== '' && existsSync(out) ? countChannelRecords({ memoryRoot }) : 0,
  };
 // F3/R13: zbir maksimuma 112 (≥ 100), pa je 'overheated' (<10) dostižan.
  const penalty = Math.min(24, 2 * signals.hoursSinceSleep)
    + Math.min(24, 2 * signals.tasksSinceSleep)
    + Math.min(24, 3 * signals.stale)
    + Math.min(12, signals.candidates)
    + Math.min(8, signals.questions)
    + Math.min(12, 2 * signals.failed)
    + Math.min(8, signals.channelRecords);
  const index = Math.max(0, Math.min(100, 100 - penalty));
  return { version: AWAKE_VERSION, index, level: awakeLevel(index), signals };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_REJECTED = 1;
const EXIT_USAGE = 2;

function parseCli(argv) {
  const options = { json: false, memory: undefined, tasks: undefined, out: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--memory') { options.memory = argv[i + 1]; i += 1; continue; }
    if (arg === '--tasks') { options.tasks = argv[i + 1]; i += 1; continue; }
    if (arg === '--out') { options.out = argv[i + 1]; i += 1; continue; }
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

function fail(code, message) {
  emit(true, { ok: false, error: { code, message } });
  return EXIT_USAGE;
}

function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = parseCli(rest);
  if (command !== 'status' && command !== 'gate') return fail('E_USAGE', 'Nepoznata komanda: ' + String(command));
  if (options.memory === undefined || options.tasks === undefined) return fail('E_USAGE', 'Obavezni: --tasks i --memory');
  try {
    const result = computeAwake({ tasksRoot: options.tasks, memoryRoot: options.memory, out: options.out });
    if (command === 'status') {
      emit(options.json, result);
      return EXIT_OK;
    }
    const gate = {
      index: result.index,
      level: result.level,
      canWork: canWork(result.index),
      canStartTask: canStartTask(result.index),
    };
    emit(options.json, gate);
    return gate.canWork ? EXIT_OK : EXIT_REJECTED;
  } catch (error) {
    if (!(error instanceof AwakeError)) throw error;
    return fail(error.code, error.message);
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
