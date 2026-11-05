/**
 * Mašinski trag ishoda — ulaz sna.
 *
 * Graditelj traga čita samo postojeće mašinske zapise: events.jsonl (prelazi
 * stanja), dokazne omotače (checks: ishod, exitCode, trajanje, vreme) i izvodi
 * trajanja i greške alata/okruženja. Deterministički je (bez sata) i read-only;
 * trag je ulaz sna, ne dokaz — ne skladišti se u dreams/rem.json.
 *
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TRAG_VERSION = 1;

const TASK_ID = /^TASK-[0-9]{1,6}$/;
const TASK_FILE = /^TASK-([0-9]{1,6})\.json$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const VERDICTS = ['ok', 'failed', 'unexecuted'];

/** Greška traga. */
export class TragError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TragError';
    this.code = code;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isIsoUtc(value) {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function readText(file, label) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    throw new TragError('E_SCHEMA', label + ' se ne čita: ' + error.message);
  }
}

function readJson(file, label) {
  const text = readText(file, label);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new TragError('E_SCHEMA', label + ' nije validan JSON: ' + error.message);
  }
}

function gitTry(repo, args) {
  try {
    execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

function assertTasksRoot(tasksRoot) {
  if (typeof tasksRoot !== 'string' || tasksRoot === '') {
    throw new TragError('E_TASK', 'tasksRoot je obavezan');
  }
  let stat;
  try {
    stat = statSync(tasksRoot);
  } catch {
    throw new TragError('E_TASK', 'tasksRoot ne postoji: ' + path.resolve(tasksRoot));
  }
  if (!stat.isDirectory()) throw new TragError('E_TASK', 'tasksRoot nije direktorijum');
}

function assertRepo(repo) {
  if (typeof repo !== 'string' || repo === '') throw new TragError('E_REPO', 'repo je obavezan');
  let stat;
  try {
    stat = statSync(repo);
  } catch {
    throw new TragError('E_REPO', 'repo ne postoji: ' + path.resolve(repo));
  }
  if (!stat.isDirectory()) throw new TragError('E_REPO', 'repo nije direktorijum');
  if (!gitTry(repo, ['rev-parse', '--show-toplevel'])) {
    throw new TragError('E_REPO', 'repo nije git radno stablo: ' + path.resolve(repo));
  }
}

function eventError(value) {
  if (!isPlainObject(value)) return 'događaj mora biti JSON objekat';
  if (typeof value.task !== 'string' || !TASK_ID.test(value.task)) return 'događaj.task mora biti TASK-<broj>';
  if (typeof value.from !== 'string' || value.from.length < 1) return 'događaj.from mora biti ne-prazan string';
  if (typeof value.to !== 'string' || value.to.length < 1) return 'događaj.to mora biti ne-prazan string';
  if (!isIsoUtc(value.at)) return 'događaj.at mora biti ISO UTC vreme';
  return null;
}

function checkError(value) {
  if (!isPlainObject(value)) return 'check mora biti JSON objekat';
  if (typeof value.claim !== 'string' || value.claim.length < 1) return 'check.claim mora biti ne-prazan string';
  if (typeof value.kind !== 'string' || value.kind.length < 1) return 'check.kind mora biti ne-prazan string';
  if (typeof value.command !== 'string' || value.command.length < 1) return 'check.command mora biti ne-prazan string';
  if (!VERDICTS.includes(value.verdict)) return 'check.verdict mora biti ok/failed/unexecuted';
  if (!Number.isInteger(value.exitCode)) return 'check.exitCode mora biti ceo broj';
  if (!(value.durationMs === null || (Number.isInteger(value.durationMs) && value.durationMs >= 0))) {
    return 'check.durationMs mora biti ceo broj >= 0 ili null';
  }
  if (!isIsoUtc(value.executedAt)) return 'check.executedAt mora biti ISO UTC vreme';
  return null;
}

function taskFileError(value, id) {
  if (!isPlainObject(value)) return 'zadatak mora biti JSON objekat';
  if (value.id !== id) return 'id zadatka mora odgovarati imenu fajla';
  if (typeof value.kind !== 'string' || value.kind.length < 1) return 'zadatak.kind mora biti ne-prazan string';
  if (typeof value.status !== 'string' || value.status.length < 1) return 'zadatak.status mora biti ne-prazan string';
  if (value.evidence !== null && (typeof value.evidence !== 'string' || value.evidence.length < 1)) {
    return 'zadatak.evidence mora biti relative putanja ili null';
  }
  return null;
}

function extractChecks(task, repo) {
  if (task.kind !== 'code' || task.evidence === null) return [];
  const absolute = path.resolve(repo, task.evidence);
  const envelope = readJson(absolute, 'omotač ' + task.evidence);
  if (!isPlainObject(envelope) || !Array.isArray(envelope.checks)) {
    throw new TragError('E_SCHEMA', 'omotač ' + task.evidence + ' nema checks niz');
  }
  return envelope.checks.map((check, index) => {
    const error = checkError(check);
    if (error !== null) throw new TragError('E_SCHEMA', 'omotač ' + task.evidence + '.checks[' + index + ']: ' + error);
    return {
      claim: check.claim,
      kind: check.kind,
      command: check.command,
      verdict: check.verdict,
      exitCode: check.exitCode,
      durationMs: check.durationMs,
      executedAt: check.executedAt,
    };
  });
}

/**
 * Deterministički mašinski trag ishoda iz <tasksRoot> i dokaznih omotača u
 * <repo>. Read-only; isti ulaz → isti bajtovi. Prazna tabla → {tasks: []}.
 */
export function buildTrag(options = {}) {
  const { tasksRoot, repo } = options;
  assertTasksRoot(tasksRoot);
  assertRepo(repo);

  const events = [];
  const eventsFile = path.join(tasksRoot, 'events.jsonl');
  if (existsSync(eventsFile)) {
    const lines = readText(eventsFile, 'events.jsonl').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === '') continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new TragError('E_SCHEMA', 'events.jsonl:' + (index + 1) + ' nije validan JSON: ' + error.message);
      }
      const error = eventError(value);
      if (error !== null) throw new TragError('E_SCHEMA', 'events.jsonl:' + (index + 1) + ': ' + error);
      events.push({ task: value.task, from: value.from, to: value.to, at: value.at });
    }
  }

  const tasks = [];
  for (const name of readdirSync(tasksRoot)) {
    if (!TASK_FILE.test(name)) continue;
    const id = 'TASK-' + TASK_FILE.exec(name)[1];
    const value = readJson(path.join(tasksRoot, name), 'zadatak ' + name);
    const error = taskFileError(value, id);
    if (error !== null) throw new TragError('E_SCHEMA', 'zadatak ' + name + ': ' + error);
    tasks.push({ id, kind: value.kind, status: value.status, evidence: value.evidence });
  }
  tasks.sort((a, b) => Number(TASK_FILE.exec(a.id + '.json')[1]) - Number(TASK_FILE.exec(b.id + '.json')[1]));

  const result = [];
  for (const task of tasks) {
    const transitions = events
      .filter(event => event.task === task.id)
      .map(event => ({ from: event.from, to: event.to, at: event.at }));
    const checks = extractChecks(task, repo);
    const timed = checks.filter(check => Number.isInteger(check.durationMs));
    const durations = {
      stateMs: transitions.length >= 2
        ? Date.parse(transitions[transitions.length - 1].at) - Date.parse(transitions[0].at)
        : null,
      checksMs: timed.length === 0 ? null : timed.reduce((sum, check) => sum + check.durationMs, 0),
    };
    result.push({
      task: task.id,
      kind: task.kind,
      status: task.status,
      transitions,
      checks,
      durations,
      unexecuted: checks.filter(check => check.verdict === 'unexecuted').map(check => check.claim),
    });
  }
  return { version: TRAG_VERSION, tasks: result };
}

/**
 * Validacija traga; vraća listu grešaka (prazan niz = validan) i nikad ne baca.
 */
export function validateTrag(value) {
  const errors = [];
  if (!isPlainObject(value)) return ['trag mora biti JSON objekat'];
  if (value.version !== TRAG_VERSION) errors.push('version mora biti ' + TRAG_VERSION);
  if (!Array.isArray(value.tasks)) {
    errors.push('tasks mora biti niz');
    return errors;
  }
  value.tasks.forEach((task, index) => {
    const prefix = 'tasks[' + index + ']';
    if (!isPlainObject(task)) { errors.push(prefix + ' mora biti objekat'); return; }
    if (typeof task.task !== 'string' || !TASK_ID.test(task.task)) errors.push(prefix + '.task mora biti TASK-<broj>');
    if (typeof task.kind !== 'string' || task.kind.length < 1) errors.push(prefix + '.kind mora biti ne-prazan string');
    if (typeof task.status !== 'string' || task.status.length < 1) errors.push(prefix + '.status mora biti ne-prazan string');
    if (!Array.isArray(task.transitions)) errors.push(prefix + '.transitions mora biti niz');
    else task.transitions.forEach((transition, at) => {
      const where = prefix + '.transitions[' + at + ']';
      if (!isPlainObject(transition)) { errors.push(where + ' mora biti objekat'); return; }
      if (typeof transition.from !== 'string' || transition.from.length < 1) errors.push(where + '.from mora biti ne-prazan string');
      if (typeof transition.to !== 'string' || transition.to.length < 1) errors.push(where + '.to mora biti ne-prazan string');
      if (!isIsoUtc(transition.at)) errors.push(where + '.at mora biti ISO UTC vreme');
    });
    if (!Array.isArray(task.checks)) errors.push(prefix + '.checks mora biti niz');
    else task.checks.forEach((check, at) => {
      const error = checkError(check);
      if (error !== null) errors.push(prefix + '.checks[' + at + ']: ' + error);
    });
    if (!isPlainObject(task.durations)) errors.push(prefix + '.durations mora biti objekat');
    else {
      const { stateMs, checksMs } = task.durations;
      if (!(stateMs === null || (Number.isInteger(stateMs) && stateMs >= 0))) errors.push(prefix + '.durations.stateMs mora biti ceo broj >= 0 ili null');
      if (!(checksMs === null || (Number.isInteger(checksMs) && checksMs >= 0))) errors.push(prefix + '.durations.checksMs mora biti ceo broj >= 0 ili null');
    }
    if (!Array.isArray(task.unexecuted) || !task.unexecuted.every(item => typeof item === 'string')) {
      errors.push(prefix + '.unexecuted mora biti niz stringova');
    }
  });
  return errors;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_REJECTED = 1;
const EXIT_USAGE = 2;

const EXIT_BY_CODE = {
  E_SCHEMA: EXIT_REJECTED,
  E_TASK: EXIT_USAGE,
  E_REPO: EXIT_USAGE,
  E_USAGE: EXIT_USAGE,
  E_WRITE: EXIT_USAGE,
};

function parseCli(argv) {
  const options = { json: false, tasks: undefined, repo: undefined, out: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--tasks') { options.tasks = argv[i + 1]; i += 1; continue; }
    if (arg === '--repo') { options.repo = argv[i + 1]; i += 1; continue; }
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

function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = parseCli(rest);
  const fail = (code, message) => {
    emit(true, { ok: false, error: { code, message } });
    return EXIT_BY_CODE[code] ?? EXIT_USAGE;
  };
  if (command !== 'build') return fail('E_USAGE', 'Nepoznata komanda: ' + String(command));
  if (options.tasks === undefined || options.repo === undefined || options.out === undefined) {
    return fail('E_USAGE', 'Obavezni: --tasks, --repo i --out');
  }
  try {
    const trag = buildTrag({ tasksRoot: options.tasks, repo: options.repo });
    try {
      mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
      writeFileSync(options.out, JSON.stringify(trag, null, 2) + '\n', 'utf8');
    } catch (error) {
      throw new TragError('E_WRITE', 'Trag nije upisan: ' + error.message);
    }
    emit(options.json, trag);
    return EXIT_OK;
  } catch (error) {
    if (!(error instanceof TragError)) throw error;
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
