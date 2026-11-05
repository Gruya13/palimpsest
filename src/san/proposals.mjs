/**
 * Tumačenja u radu — predlog zadatka iz tumačenja.
 *
 * San ne upravlja radom: iz "open" tumačenja pravi se "proposed" board
 * zadatak, nikad "ready". Veza je title prefiks "[<TUM-ID>] " jer je board v2
 * šema zaključana; idempotencija se proverava po tom prefiksu, u bilo kom
 * statusu. Mapiranje: hypothesis→code, question→audit, merge-proposal→spec.
 *
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTask, readTask } from '../board/board.mjs';
import { validateTumacenje } from '../san/tumacenja.mjs';

export const PROPOSALS_VERSION = 1;

const KIND_MAP = { hypothesis: 'code', question: 'audit', 'merge-proposal': 'spec' };
const TUM_ID = /^TUM-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}$/;
const TASK_FILE = /^TASK-[0-9]{1,6}\.json$/;
const TUM_FILE = /^TUM-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}\.json$/;
const TITLE_MAX = 200;

/** Greška predloga. */
export class ProposalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProposalError';
    this.code = code;
  }
}

function isoOf(now) {
  const value = now instanceof Date ? now : new Date(String(now));
  if (Number.isNaN(value.getTime())) throw new ProposalError('E_USAGE', 'now nije validno vreme');
  return value.toISOString();
}

function assertDir(value, code, label) {
  let stat;
  try {
    stat = statSync(value);
  } catch {
    throw new ProposalError(code, label + ' ne postoji: ' + path.resolve(String(value)));
  }
  if (!stat.isDirectory()) throw new ProposalError(code, label + ' nije direktorijum');
}

function readTumacenja(tumacenjaRoot) {
  const records = new Map();
  let entries;
  try {
    entries = readdirSync(tumacenjaRoot);
  } catch (error) {
    throw new ProposalError('E_TUMACENJA', 'tumacenjaRoot se ne čita: ' + error.message);
  }
  for (const entry of entries.filter(name => TUM_FILE.test(name)).sort()) {
    const file = path.join(tumacenjaRoot, entry);
    let value;
    try {
      value = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new ProposalError('E_SCHEMA', 'tumačenje ' + entry + ' nije validan JSON: ' + error.message);
    }
    const fallbackId = entry.slice(0, -'.json'.length);
    let valid = true;
    try {
      validateTumacenje(value);
    } catch {
      valid = false;
    }
    const id = value !== null && typeof value === 'object' && typeof value.id === 'string' ? value.id : fallbackId;
    records.set(id, { id, valid, value });
  }
  return records;
}

function readTasks(tasksRoot) {
  const tasks = [];
  let entries;
  try {
    entries = readdirSync(tasksRoot);
  } catch (error) {
    throw new ProposalError('E_TASK', 'tasksRoot se ne čita: ' + error.message);
  }
  for (const entry of entries.filter(name => TASK_FILE.test(name)).sort()) {
    try {
      tasks.push(readTask(path.join(tasksRoot, entry)));
    } catch {
      /* nevalidan board fajl se preskače pri traženju veze */
    }
  }
  return tasks;
}

/**
 * Predloži "proposed" zadatke iz "open" tumačenja; read-only nad tumačenjima.
 */
export function proposeTasks(options = {}) {
  const { tumacenjaRoot, tasksRoot, now = new Date(), ids } = options;
  if (typeof tumacenjaRoot !== 'string' || tumacenjaRoot === '') {
    throw new ProposalError('E_TUMACENJA', 'tumacenjaRoot je obavezan');
  }
  if (typeof tasksRoot !== 'string' || tasksRoot === '') {
    throw new ProposalError('E_TASK', 'tasksRoot je obavezan');
  }
  if (ids !== undefined && (!Array.isArray(ids) || !ids.every(id => typeof id === 'string' && TUM_ID.test(id)))) {
    throw new ProposalError('E_USAGE', 'ids mora biti niz TUM id-jeva');
  }
  const iso = isoOf(now);
  assertDir(tumacenjaRoot, 'E_TUMACENJA', 'tumacenjaRoot');
  assertDir(tasksRoot, 'E_TASK', 'tasksRoot');

  const records = readTumacenja(tumacenjaRoot);
  const tasks = readTasks(tasksRoot);
  const proposed = [];
  const existing = [];
  const skipped = [];

  const order = ids === undefined ? [...records.keys()].sort() : [...ids];
  for (const requestedId of order) {
    const record = records.get(requestedId);
    if (record === undefined) {
      skipped.push({ id: requestedId, reason: 'not-found' });
      continue;
    }
    if (!record.valid) {
      skipped.push({ id: record.id, reason: 'invalid-tumacenje' });
      continue;
    }
    const source = record.value;
    if (source.status !== 'open') {
      skipped.push({ id: source.id, reason: 'not-open' });
      continue;
    }
    const prefix = '[' + source.id + '] ';
    const link = tasks.find(task => typeof task.title === 'string' && task.title.startsWith(prefix));
    if (link !== undefined) {
      existing.push(link);
      continue;
    }
    const kind = KIND_MAP[source.kind];
    if (kind === undefined) {
      skipped.push({ id: source.id, reason: 'invalid-kind' });
      continue;
    }
    const title = (prefix + source.rule).slice(0, TITLE_MAX);
    const task = createTask({ tasksRoot, title, kind, now: () => iso });
    tasks.push(task);
    proposed.push(task);
  }
  return { proposed, existing, skipped };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_REJECTED = 1;
const EXIT_USAGE = 2;

function parseCli(argv) {
  const options = { json: false, tumacenja: undefined, tasks: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--tumacenja') { options.tumacenja = argv[i + 1]; i += 1; continue; }
    if (arg === '--tasks') { options.tasks = argv[i + 1]; i += 1; continue; }
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
  if (command !== 'propose') return fail('E_USAGE', 'Nepoznata komanda: ' + String(command));
  if (options.tumacenja === undefined || options.tasks === undefined) {
    return fail('E_USAGE', 'Obavezni: --tumacenja i --tasks');
  }
  try {
    const result = proposeTasks({ tumacenjaRoot: options.tumacenja, tasksRoot: options.tasks });
    emit(options.json, result);
    return result.proposed.length > 0 ? EXIT_OK : EXIT_REJECTED;
  } catch (error) {
    if (!(error instanceof ProposalError)) throw error;
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
