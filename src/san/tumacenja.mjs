/**
 * Tumačenja — format, validacija i rangiranje po obistinjenju.
 *
 * Tumačenje je san koji je preživeo determinističku kapiju: JSON
 * TUM-YYYY-MM-DD-NN sa obaveznim based_on, outcomes i score izračunatim
 * formulom (confirmed − refuted) / max(1, attempted), bez clamp-a.
 * Sirovi snovi se ne skladište; ovde je samo tumačenje.
 *
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TUMACENJA_KINDS = ['hypothesis', 'question', 'merge-proposal'];
export const TUMACENJA_STATUSES = ['open', 'proposed', 'confirmed', 'refuted'];

const OUTCOME_VERDICTS = ['confirmed', 'refuted', 'attempted'];
const FIELDS = ['version', 'id', 'kind', 'rule', 'based_on', 'how_to_test', 'origin_dream', 'status', 'outcomes', 'score', 'priority', 'created', 'updated'];
const TUM_ID = /^TUM-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}$/;
const BASED_ON_ID = /^(TASK-[0-9]{1,6}|MEM-[0-9]{1,6}|TUM-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2})$/;
const TASK_ID = /^TASK-[0-9]{1,6}$/;

/** Greška tumačenja. */
export class TumacenjaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TumacenjaError';
    this.code = code;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
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

function isNonEmptyString(value, min, max) {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function countsOf(outcomes) {
  if (!Array.isArray(outcomes)) throw new TumacenjaError('E_SCHEMA', 'outcomes mora biti niz');
  const counts = { confirmed: 0, refuted: 0, attempted: 0 };
  for (const outcome of outcomes) {
    if (!isPlainObject(outcome)) throw new TumacenjaError('E_SCHEMA', 'ishod mora biti objekat');
    if (typeof outcome.task !== 'string' || !TASK_ID.test(outcome.task)) throw new TumacenjaError('E_SCHEMA', 'ishod.task mora biti TASK-<broj>');
    if (!OUTCOME_VERDICTS.includes(outcome.verdict)) throw new TumacenjaError('E_SCHEMA', 'nevalidan ishod: ' + String(outcome.verdict));
    counts[outcome.verdict] += 1;
  }
  return counts;
}

/** Formula: (confirmed − refuted) / max(1, attempted). */
export function scoreOf(counts = {}) {
  const { confirmed, refuted, attempted } = counts;
  for (const [name, value] of [['confirmed', confirmed], ['refuted', refuted], ['attempted', attempted]]) {
    if (!Number.isInteger(value) || value < 0) throw new TumacenjaError('E_SCHEMA', name + ' mora biti ceo broj >= 0');
  }
  return (confirmed - refuted) / Math.max(1, attempted);
}

function validateOutcomeList(outcomes) {
  if (!Array.isArray(outcomes)) return 'outcomes mora biti niz';
  for (const outcome of outcomes) {
    if (!isPlainObject(outcome)) return 'ishod mora biti objekat';
    if (typeof outcome.task !== 'string' || !TASK_ID.test(outcome.task)) return 'ishod.task mora biti TASK-<broj>';
    if (!OUTCOME_VERDICTS.includes(outcome.verdict)) return 'nevalidan ishod: ' + String(outcome.verdict);
    for (const key of Object.keys(outcome)) if (!['task', 'verdict'].includes(key)) return 'nepoznato polje ishoda: ' + key;
  }
  return null;
}

/** Vrati `undefined` za validan zapis; baci `E_SCHEMA` za nevalidan. */
export function validateTumacenje(value) {
  const errors = [];
  if (!isPlainObject(value)) throw new TumacenjaError('E_SCHEMA', 'tumačenje mora biti JSON objekat');
  for (const key of Object.keys(value)) {
    if (!FIELDS.includes(key)) errors.push('nepoznato polje: ' + key);
  }
  for (const field of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) errors.push('nedostaje polje: ' + field);
  }
  if (value.version !== 1) errors.push('version mora biti 1');
  if (typeof value.id !== 'string' || !TUM_ID.test(value.id)) errors.push('id mora biti TUM-YYYY-MM-DD-NN');
  if (!TUMACENJA_KINDS.includes(value.kind)) errors.push('nepoznat kind');
  if (!isNonEmptyString(value.rule, 1, 500)) errors.push('rule mora biti 1–500 znakova');
  if (!Array.isArray(value.based_on) || value.based_on.length < 1 || value.based_on.length > 64
    || !value.based_on.every(id => typeof id === 'string' && BASED_ON_ID.test(id))) {
    errors.push('based_on mora biti 1–64 TASK/MEM/TUM id-ja');
  }
  if (!isNonEmptyString(value.how_to_test, 1, 500)) errors.push('how_to_test mora biti 1–500 znakova');
  if (!isNonEmptyString(value.origin_dream, 1, 64)) errors.push('origin_dream mora biti 1–64 znaka');
  if (!TUMACENJA_STATUSES.includes(value.status)) errors.push('nepoznat status');
  const outcomeError = validateOutcomeList(value.outcomes);
  if (outcomeError !== null) errors.push(outcomeError);
  if (typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < -1 || value.score > 1) {
    errors.push('score mora biti broj u [-1, 1]');
  }
  if (value.priority !== null && (!Number.isInteger(value.priority))) errors.push('priority mora biti ceo broj ili null');
  if (!isIsoUtc(value.created)) errors.push('created mora biti ISO vreme');
  if (!isIsoUtc(value.updated)) errors.push('updated mora biti ISO vreme');
  if (errors.length > 0) throw new TumacenjaError('E_SCHEMA', 'Nevalidno tumačenje: ' + errors.join('; '));
}

function assertRoot(tumacenjaRoot) {
  if (typeof tumacenjaRoot !== 'string' || tumacenjaRoot === '') {
    throw new TumacenjaError('E_USAGE', 'tumacenjaRoot je obavezan');
  }
}

function writeRecord(file, record) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
  } catch (error) {
    throw new TumacenjaError('E_WRITE', 'Tumačenje nije upisano: ' + error.message);
  }
}

/** Upiši novo tumačenje; score se računa iz outcomes, a created/updated iz now. */
export function writeTumacenje(options = {}) {
  const { tumacenjaRoot, tumacenje, now = () => new Date().toISOString() } = options;
  assertRoot(tumacenjaRoot);
  if (!isPlainObject(tumacenje)) throw new TumacenjaError('E_SCHEMA', 'tumačenje mora biti objekat');
  const score = scoreOf(countsOf(tumacenje.outcomes));
  const at = now();
  const record = { ...tumacenje, score, created: at, updated: at };
  validateTumacenje(record);
  const file = path.join(tumacenjaRoot, record.id + '.json');
  if (existsSync(file)) throw new TumacenjaError('E_EXISTS', 'Tumačenje već postoji: ' + record.id);
  writeRecord(file, record);
  return record;
}

/** Pročitaj i validiraj tumačenje. */
export function readTumacenje(tumacenjePath) {
  if (typeof tumacenjePath !== 'string' || tumacenjePath === '') throw new TumacenjaError('E_USAGE', 'putanja tumačenja je obavezna');
  let text;
  try {
    text = readFileSync(tumacenjePath, 'utf8');
  } catch {
    throw new TumacenjaError('E_NOT_FOUND', 'Tumačenje ne postoji: ' + path.resolve(tumacenjePath));
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new TumacenjaError('E_SCHEMA', 'Tumačenje nije validan JSON: ' + error.message);
  }
  validateTumacenje(value);
  return value;
}

/** Dodaj ishod, preračunaj score i updated; ostala polja ostaju ista. */
export function recordOutcome(options = {}) {
  const { tumacenjePath, task, verdict, now = () => new Date().toISOString() } = options;
  const record = readTumacenje(tumacenjePath);
  if (typeof task !== 'string' || !TASK_ID.test(task)) throw new TumacenjaError('E_SCHEMA', 'task mora biti TASK-<broj>');
  if (!OUTCOME_VERDICTS.includes(verdict)) throw new TumacenjaError('E_SCHEMA', 'nevalidan ishod: ' + String(verdict));
  const outcomes = [...record.outcomes, { task, verdict }];
  const updated = { ...record, outcomes, score: scoreOf(countsOf(outcomes)), updated: now() };
  validateTumacenje(updated);
  writeRecord(tumacenjePath, updated);
  return updated;
}

/** Sva tumačenja, sortirana po score opadajuće pa id rastuće; read-only. */
export function rankTumacenja(options = {}) {
  const { tumacenjaRoot } = options;
  assertRoot(tumacenjaRoot);
  let entries;
  try {
    entries = readdirSync(tumacenjaRoot);
  } catch {
    throw new TumacenjaError('E_NOT_FOUND', 'tumacenjaRoot ne postoji: ' + path.resolve(tumacenjaRoot));
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(tumacenjaRoot, entry);
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    records.push(readTumacenje(file));
  }
  records.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return records;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_REJECTED = 1;
const EXIT_USAGE = 2;

const EXIT_BY_CODE = {
  E_SCHEMA: EXIT_REJECTED,
  E_EXISTS: EXIT_USAGE,
  E_NOT_FOUND: EXIT_USAGE,
  E_USAGE: EXIT_USAGE,
  E_WRITE: EXIT_USAGE,
};

function parseCli(argv) {
  const options = { json: false, root: undefined, file: undefined, task: undefined, verdict: undefined };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--root') { options.root = argv[i + 1]; i += 1; continue; }
    if (arg === '--file') { options.file = argv[i + 1]; i += 1; continue; }
    if (arg === '--task') { options.task = argv[i + 1]; i += 1; continue; }
    if (arg === '--verdict') { options.verdict = argv[i + 1]; i += 1; continue; }
    if (arg.startsWith('--')) continue;
    positional.push(arg);
  }
  return { options, positional };
}

function emit(json, value) {
  if (json) {
    process.stdout.write(JSON.stringify(value) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const { options, positional } = parseCli(rest);
  const fail = (code, message) => {
    emit(true, { ok: false, error: { code, message } });
    return EXIT_USAGE;
  };
  try {
    if (command === 'write') {
      if (options.root === undefined || options.file === undefined) return fail('E_USAGE', 'Obavezni: --root i --file');
      let text;
      try {
        text = readFileSync(options.file, 'utf8');
      } catch {
        throw new TumacenjaError('E_NOT_FOUND', 'Ulazni fajl ne postoji: ' + path.resolve(options.file));
      }
      let input;
      try {
        input = JSON.parse(text);
      } catch (error) {
        throw new TumacenjaError('E_SCHEMA', 'Ulaz nije validan JSON: ' + error.message);
      }
      const record = writeTumacenje({ tumacenjaRoot: options.root, tumacenje: input });
      emit(options.json, record);
      return EXIT_OK;
    }
    if (command === 'rank') {
      if (options.root === undefined) return fail('E_USAGE', 'Obavezan: --root');
      const records = rankTumacenja({ tumacenjaRoot: options.root });
      emit(options.json, { tumacenja: records });
      return EXIT_OK;
    }
    if (command === 'outcome') {
      const tumacenjePath = positional[0];
      if (tumacenjePath === undefined || options.task === undefined || options.verdict === undefined) {
        return fail('E_USAGE', 'Obavezni: putanja, --task i --verdict');
      }
      const record = recordOutcome({ tumacenjePath, task: options.task, verdict: options.verdict });
      emit(options.json, record);
      return EXIT_OK;
    }
    return fail('E_USAGE', 'Nepoznata komanda: ' + String(command));
  } catch (error) {
    if (!(error instanceof TumacenjaError)) throw error;
    emit(true, { ok: false, error: { code: error.code, message: error.message } });
    return EXIT_BY_CODE[error.code] ?? EXIT_USAGE;
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
