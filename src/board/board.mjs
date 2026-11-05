/**
 * Crna tabla i kapija verified.
 *
 * Zadatak je JSON fajl sa statusom i vezom na dokazni omotač. Prelaz
 * review → verified prolazi kroz kapiju: dokaz mora postojati i check mora
 * vratiti ok za reviziju zadatka. Uspešni prelazi idu u append-only
 * events.jsonl; odbijeni ne menjaju ništa.
 *
 * prelaz u `blocked` zahteva `blocked_reason` (string 1–500); polje se
 * lenjo upisuje (samo u blocked statusu) i uklanja na `blocked → ready`; red
 * `events.jsonl` za blocked nosi i `reason`. 
 *
 */
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEnvelope, CheckError } from '../evidence/check.mjs';
import { independenceOf, INDEPENDENCE_THRESHOLD } from '../evidence/independence.mjs';
import { verifyLock } from '../evidence/lock.mjs';

export const BOARD_STATUSES = ['proposed', 'ready', 'in_progress', 'review', 'verified', 'blocked'];

/** Vrste zadatka (O-15); kapija zavisi od vrste. */
export const TASK_KINDS = ['ingest', 'audit', 'spec', 'code'];

export const BOARD_TRANSITIONS = {
  proposed: ['ready', 'blocked'],
  ready: ['in_progress', 'blocked'],
  in_progress: ['review', 'blocked'],
  review: ['in_progress', 'verified', 'blocked'],
  verified: [],
  blocked: ['ready'],
};

export const EXIT_OK = 0;
export const EXIT_REJECTED = 1;
export const EXIT_USAGE = 2;

const FIELDS = ['id', 'title', 'kind', 'status', 'revision', 'evidence', 'test_set', 'target', 'created', 'updated'];
const TASK_ID = /^TASK-[0-9]{1,6}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const EVENTS_FILE = 'events.jsonl';

/** Greška crne table i kapije. */
export class BoardError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'BoardError';
    this.code = code;
    if (extra.reason !== undefined) this.reason = extra.reason;
    if (extra.check !== undefined) this.check = extra.check;
    if (extra.independence !== undefined) this.independence = extra.independence;
    if (extra.cause !== undefined) this.cause = extra.cause;
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

function normalizeEvidence(repo, evidence, label = 'evidence') {
  if (typeof evidence !== 'string' || evidence === '') {
    throw new BoardError('E_TASK', label + ' mora biti relativna putanja');
  }
  if (path.isAbsolute(evidence)) {
    throw new BoardError('E_TASK', label + ' mora biti relativna putanja, ne apsolutna');
  }
  const normalized = path.normalize(evidence);
  if (normalized === '..' || normalized.startsWith('..' + path.sep)) {
    throw new BoardError('E_TASK', label + ' izlazi izvan repo korena');
  }
  const repoAbs = path.resolve(repo);
  const abs = path.resolve(repoAbs, evidence);
  const rel = path.relative(repoAbs, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new BoardError('E_TASK', label + ' izlazi izvan repo korena');
  }
  return normalized.split(path.sep).join('/');
}

function validateTaskValue(value) {
  const errors = [];
  if (!isPlainObject(value)) return ['zadatak mora biti JSON objekat'];
  for (const key of Object.keys(value)) {
    if (!FIELDS.includes(key) && key !== 'blocked_reason') errors.push('nepoznato polje: ' + key);
  }
  for (const field of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) errors.push('nedostaje polje: ' + field);
  }
  const hasBlockedReason = Object.prototype.hasOwnProperty.call(value, 'blocked_reason');
  if (value.status === 'blocked') {
    if (!hasBlockedReason) errors.push('blocked zadatak zahteva blocked_reason');
    else if (typeof value.blocked_reason !== 'string' || value.blocked_reason.trim().length < 1 || value.blocked_reason.length > 500) {
      errors.push('blocked_reason mora biti string 1–500 znakova');
    }
  } else if (hasBlockedReason) {
    errors.push('blocked_reason je dozvoljen samo u statusu blocked');
  }
  if (typeof value.id !== 'string' || !TASK_ID.test(value.id)) errors.push('id mora biti TASK-<broj>');
  if (typeof value.title !== 'string' || value.title.length < 1 || value.title.length > 200) errors.push('title mora biti 1–200 znakova');
  if (!TASK_KINDS.includes(value.kind)) errors.push('nepoznat kind');
  if (!BOARD_STATUSES.includes(value.status)) errors.push('nepoznat status');
  if (value.revision !== null && (typeof value.revision !== 'string' || !HEX40.test(value.revision))) errors.push('revision mora biti 40 hex ili null');
  if (value.evidence !== null && (typeof value.evidence !== 'string' || value.evidence.length === 0)) errors.push('evidence mora biti putanja ili null');
  for (const field of ['test_set', 'target']) {
    const fieldValue = value[field];
    if (fieldValue === null) continue;
    if (typeof fieldValue !== 'string' || fieldValue.length === 0) { errors.push(field + ' mora biti relativna putanja ili null'); continue; }
    if (path.isAbsolute(fieldValue)) { errors.push(field + ' mora biti relativna putanja'); continue; }
    const normalized = path.normalize(fieldValue);
    if (normalized === '..' || normalized.startsWith('..' + path.sep)) errors.push(field + ' izlazi izvan repo korena');
  }
  if (value.kind !== 'spec' && (value.test_set !== null || value.target !== null)) {
    errors.push('test_set/target su dozvoljeni samo za kind spec');
  }
  if (!isIsoUtc(value.created)) errors.push('created mora biti ISO vreme');
  if (!isIsoUtc(value.updated)) errors.push('updated mora biti ISO vreme');
  return errors;
}

function assertTaskValue(value) {
  const errors = validateTaskValue(value);
  if (errors.length > 0) {
    throw new BoardError('E_TASK', 'Nevalidan zadatak: ' + errors.join('; '));
  }
  return value;
}

function writeTaskFile(taskPath, task, options = {}) {
  try {
    writeFileSync(taskPath, JSON.stringify(task, null, 2) + '\n',
      options.exclusive ? { encoding: 'utf8', flag: 'wx' } : 'utf8');
  } catch (error) {
    if (options.exclusive && error.code === 'EEXIST') throw error;
    throw new BoardError('E_WRITE', 'zadatak nije upisan: ' + error.message);
  }
}

function readJson(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new BoardError('E_TASK', 'zadatak se ne može pročitati: ' + error.message);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new BoardError('E_TASK', 'zadatak nije validan JSON: ' + error.message);
  }
}

/** Pročitaj i validiraj zadatak. Ne menja fajl. */
export function readTask(taskPath) {
  if (typeof taskPath !== 'string' || taskPath === '') throw new BoardError('E_TASK', 'putanja zadatka je obavezna');
  let stat;
  try {
    stat = statSync(taskPath);
  } catch {
    throw new BoardError('E_TASK', 'zadatak ne postoji: ' + path.resolve(taskPath));
  }
  if (!stat.isFile()) throw new BoardError('E_TASK', 'zadatak nije regularan fajl');
  return assertTaskValue(readJson(taskPath));
}

function nextTaskId(tasksRoot) {
  let max = 0;
  for (const name of readdirSync(tasksRoot)) {
    if (!name.endsWith('.json')) continue;
    let value;
    try {
      value = JSON.parse(readFileSync(path.join(tasksRoot, name), 'utf8'));
    } catch {
      continue;
    }
    const match = typeof value?.id === 'string' ? /^TASK-([0-9]{1,6})$/.exec(value.id) : null;
    if (match) max = Math.max(max, Number(match[1]));
  }
  return 'TASK-' + String(max + 1).padStart(3, '0');
}

/** Napravi zadatak u statusu proposed. */
export function createTask(options = {}) {
  const { tasksRoot, id, title, kind = 'code', now = () => new Date().toISOString() } = options;
  if (typeof tasksRoot !== 'string' || tasksRoot === '') throw new BoardError('E_USAGE', 'tasksRoot je obavezan');
  let stat;
  try {
    stat = statSync(tasksRoot);
  } catch {
    throw new BoardError('E_TASK', 'tasksRoot ne postoji: ' + path.resolve(tasksRoot));
  }
  if (!stat.isDirectory()) throw new BoardError('E_TASK', 'tasksRoot nije direktorijum');
  if (typeof title !== 'string' || title.length < 1 || title.length > 200) {
    throw new BoardError('E_TASK', 'title mora biti 1–200 znakova');
  }
  if (!TASK_KINDS.includes(kind)) throw new BoardError('E_TASK', 'kind mora biti jedan od: ' + TASK_KINDS.join(', '));
  let taskId;
  const explicit = id !== undefined && id !== null;
  if (explicit) {
    if (typeof id !== 'string' || !TASK_ID.test(id)) throw new BoardError('E_TASK', 'id mora biti TASK-<broj>');
    if (existsSync(path.join(tasksRoot, id + '.json'))) throw new BoardError('E_TASK', 'zadatak već postoji: ' + id);
    taskId = id;
  } else {
    taskId = nextTaskId(tasksRoot);
  }
  const at = now();
  const makeTask = value => ({
    id: value,
    title,
    kind,
    status: 'proposed',
    revision: null,
    evidence: null,
    test_set: null,
    target: null,
    created: at,
    updated: at,
  });
  if (explicit) {
    const task = makeTask(taskId);
    assertTaskValue(task);
    writeTaskFile(path.join(tasksRoot, taskId + '.json'), task);
    return task;
  }
 // Auto-ID: isključivi upis (wx); nevalidan fajl sa istim ID-jem se ne prepisuje.
  let candidate = taskId;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const task = makeTask(candidate);
    assertTaskValue(task);
    try {
      writeTaskFile(path.join(tasksRoot, candidate + '.json'), task, { exclusive: true });
      return task;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      candidate = 'TASK-' + String(Number(candidate.slice(5)) + 1).padStart(3, '0');
    }
  }
  throw new BoardError('E_TASK', 'nema slobodnog TASK id-a');
}

/** Veži dokazni omotač i reviziju za zadatak. Ne proverava omotač (to je kapija). */
export function attachEvidence(options = {}) {
  const { taskPath, repo, evidence, revision, now = () => new Date().toISOString() } = options;
  const task = readTask(taskPath);
  if (task.kind !== 'code') throw new BoardError('E_KIND', 'dokazni omotač se vezuje samo za kind code');
  if (task.status === 'verified') throw new BoardError('E_STATE', 'verifikovan zadatak se ne menja');
  if (typeof repo !== 'string' || repo === '') throw new BoardError('E_USAGE', 'repo je obavezan');
  const normalized = normalizeEvidence(repo, evidence);
  if (typeof revision !== 'string' || !HEX40.test(revision)) {
    throw new BoardError('E_TASK', 'revision mora biti pun git SHA (40 lowercase hex)');
  }
  const updated = { ...task, evidence: normalized, revision, updated: now() };
  assertTaskValue(updated);
  writeTaskFile(taskPath, updated);
  return updated;
}

/** Veži slepi test set i target za spec zadatak. Lock proverava kapija, ne attach. */
export function attachSpec(options = {}) {
  const { taskPath, repo, testSet, target, now = () => new Date().toISOString() } = options;
  const task = readTask(taskPath);
  if (task.kind !== 'spec') throw new BoardError('E_KIND', 'test_set/target se vezuju samo za kind spec');
  if (task.status === 'verified') throw new BoardError('E_STATE', 'verifikovan zadatak se ne menja');
  if (typeof repo !== 'string' || repo === '') throw new BoardError('E_USAGE', 'repo je obavezan');
  const normalizedTestSet = normalizeEvidence(repo, testSet, 'test_set');
  const normalizedTarget = normalizeEvidence(repo, target, 'target');
  const updated = { ...task, test_set: normalizedTestSet, target: normalizedTarget, updated: now() };
  assertTaskValue(updated);
  writeTaskFile(taskPath, updated);
  return updated;
}

function checkGate(task, repo) {
  if (task.evidence === null) {
    throw new BoardError('E_GATE', 'Kapija: zadatak nema dokaz', { reason: 'no-evidence' });
  }
  if (task.revision === null) {
    throw new BoardError('E_GATE', 'Kapija: zadatak nema reviziju', { reason: 'no-revision' });
  }
  let result;
  try {
    result = checkEnvelope(path.resolve(repo, task.evidence), { repo, at: task.revision });
  } catch (error) {
    if (error instanceof CheckError) {
      throw new BoardError('E_GATE', 'Kapija: check nije mogao da se izvrši (' + error.code + ')', {
        reason: 'check-error',
        check: { code: error.code },
        cause: error,
      });
    }
    throw error;
  }
  if (result.status !== 'ok') {
    const reason = result.reasons.length > 0 ? result.reasons[0].code : result.status;
    throw new BoardError('E_GATE', 'Kapija: dokaz nije ok (' + result.status + '/' + reason + ')', {
      reason,
      check: result,
    });
  }
 // Matrica nezavisnosti: kapija računa iz identiteta, ne iz polja
 // 'independence' u omotaču — falsifikovano polje ne otvara kapiju.
  let envelope;
  try {
    envelope = JSON.parse(readFileSync(path.resolve(repo, task.evidence), 'utf8'));
  } catch (error) {
    throw new BoardError('E_GATE', 'Kapija: omotač se ne čita: ' + error.message, {
      reason: 'check-error',
      cause: error,
    });
  }
  const independence = independenceOf(envelope.author, envelope.verifier);
  if (independence < INDEPENDENCE_THRESHOLD) {
    throw new BoardError('E_GATE', 'Kapija: verifikator nije nezavisan (independence ' + independence + ' < ' + INDEPENDENCE_THRESHOLD + ')', {
      reason: 'not-independent',
      independence,
    });
  }
 // Dokaz mora imati artefakt: ok provera bez artefakta ne otvara kapiju.
 // check ugovor se ne menja; zabrana je samo ovde.
  for (const check of envelope.checks) {
    if (check.verdict === 'ok' && check.artifact === null) {
      throw new BoardError('E_GATE', 'Kapija: ok provera nema artefakt (nije atestirana)', {
        reason: 'unattested-check',
      });
    }
  }
}

/**
 * Kapija spec zadatka: slepi test set mora biti zaključan, a target ne sme
 * postojati u reviziji test seta (dokaz slepila). Vraća revision iz locka.
 */
function specGate(task, repo) {
  if (task.test_set === null) {
    throw new BoardError('E_GATE', 'Kapija: spec zadatak nema slepi test set', { reason: 'no-test-set' });
  }
  if (task.target === null) {
    throw new BoardError('E_GATE', 'Kapija: spec zadatak nema target', { reason: 'no-target' });
  }
  const testSetAbs = path.resolve(repo, task.test_set);
  let verify;
  try {
    verify = verifyLock(testSetAbs, { cwd: repo });
  } catch (error) {
    throw new BoardError('E_GATE', 'Kapija: lock nije mogao da se proveri (' + (error.code || 'E_LOCK') + ')', {
      reason: 'test-set-not-locked',
      check: { status: 'error', reasons: [{ code: error.code || 'E_LOCK', message: error.message }] },
      cause: error,
    });
  }
  if (verify.status !== 'locked') {
    throw new BoardError('E_GATE', 'Kapija: slepi test set nije zaključan (' + verify.status + ')', {
      reason: 'test-set-not-locked',
      check: verify,
    });
  }
  const revision = verify.lock.gitRevision;
  let implementationExists = true;
  try {
    execFileSync('git', ['-C', repo, 'cat-file', '-e', revision + ':' + task.target], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 15000,
    });
  } catch {
    implementationExists = false;
  }
  if (implementationExists) {
    throw new BoardError('E_GATE', 'Kapija: nije slepo — implementacija postoji u reviziji test seta', { reason: 'not-blind' });
  }
  return revision;
}

/** Primeni prelaz stanja; verified prolazi kroz kapiju. */
export function transitionTask(options = {}) {
  const { taskPath, repo, to, now = () => new Date().toISOString(), reason } = options;
  const task = readTask(taskPath);
  if (!BOARD_STATUSES.includes(to)) throw new BoardError('E_TRANSITION', 'Nepoznat status: ' + String(to));
  const allowed = BOARD_TRANSITIONS[task.status] || [];
  if (!allowed.includes(to)) {
    throw new BoardError('E_TRANSITION', 'Prelaz nije dozvoljen: ' + task.status + ' -> ' + to);
  }
  const reasonProvided = reason !== undefined && reason !== null;
  if (to === 'blocked') {
    if (typeof reason !== 'string' || reason.trim().length < 1 || reason.length > 500) {
      throw new BoardError('E_GATE', 'Kapija: prelaz u blocked zahteva razlog (1–500)', { reason: 'no-blocked-reason' });
    }
  } else if (reasonProvided) {
    throw new BoardError('E_GATE', 'Kapija: razlog je dozvoljen samo za prelaz u blocked', { reason: 'reason-not-allowed' });
  }
  let specRevision = null;
  if (to === 'verified') {
    if (typeof repo !== 'string' || repo === '') throw new BoardError('E_USAGE', 'repo je obavezan za kapiju');
    if (task.kind === 'code') checkGate(task, repo);
    else if (task.kind === 'spec') specRevision = specGate(task, repo);
    else throw new BoardError('E_GATE', 'Kapija za kind "' + task.kind + '" još nije implementirana', { reason: 'kind-unsupported' });
  }
  const at = now();
  const updated = { ...task, status: to, updated: at };
  if (to === 'blocked') updated.blocked_reason = reason;
  else if (task.status === 'blocked') delete updated.blocked_reason;
  if (specRevision !== null) updated.revision = specRevision;
  assertTaskValue(updated);
  const event = { task: task.id, from: task.status, to, at };
  if (to === 'blocked') event.reason = reason;
  writeTaskFile(taskPath, updated);
  try {
    appendFileSync(path.join(path.dirname(taskPath), EVENTS_FILE), JSON.stringify(event) + '\n', 'utf8');
  } catch (error) {
    throw new BoardError('E_WRITE', 'događaj nije upisan: ' + error.message);
  }
  return { task: updated, event };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_BY_CODE = {
  E_GATE: EXIT_REJECTED,
  E_TRANSITION: EXIT_REJECTED,
  E_STATE: EXIT_REJECTED,
  E_KIND: EXIT_REJECTED,
  E_TASK: EXIT_USAGE,
  E_USAGE: EXIT_USAGE,
  E_WRITE: EXIT_USAGE,
};

function parseCli(argv) {
  const options = { json: false, tasks: undefined, title: undefined, id: undefined, kind: undefined, repo: undefined, evidence: undefined, revision: undefined, to: undefined, testSet: undefined, target: undefined, reason: undefined };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--tasks') { options.tasks = argv[i + 1]; i += 1; continue; }
    if (arg === '--title') { options.title = argv[i + 1]; i += 1; continue; }
    if (arg === '--id') { options.id = argv[i + 1]; i += 1; continue; }
    if (arg === '--repo') { options.repo = argv[i + 1]; i += 1; continue; }
    if (arg === '--evidence') { options.evidence = argv[i + 1]; i += 1; continue; }
    if (arg === '--revision') { options.revision = argv[i + 1]; i += 1; continue; }
    if (arg === '--to') { options.to = argv[i + 1]; i += 1; continue; }
    if (arg === '--reason') { options.reason = argv[i + 1]; i += 1; continue; }
    if (arg === '--kind') { options.kind = argv[i + 1]; i += 1; continue; }
    if (arg === '--test-set') { options.testSet = argv[i + 1]; i += 1; continue; }
    if (arg === '--target') { options.target = argv[i + 1]; i += 1; continue; }
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
  if (value && value.ok === false && value.error) {
    process.stdout.write('GREŠKA ' + value.error.code + ': ' + value.error.message + '\n');
    return;
  }
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const { options, positional } = parseCli(rest);
  const fail = (code, message) => {
    emit(options.json || true, { ok: false, error: { code, message } });
    return EXIT_USAGE;
  };
  try {
    if (command === 'create') {
      if (options.tasks === undefined || options.title === undefined) return fail('E_USAGE', 'Obavezni: --tasks i --title');
      const task = createTask({ tasksRoot: options.tasks, id: options.id, title: options.title, kind: options.kind });
      emit(options.json || true, task);
      return EXIT_OK;
    }
    if (command === 'attach-spec') {
      const file = positional[0];
      if (file === undefined || options.repo === undefined || options.testSet === undefined || options.target === undefined) {
        return fail('E_USAGE', 'Obavezni: zadatak, --repo, --test-set i --target');
      }
      const task = attachSpec({ taskPath: file, repo: options.repo, testSet: options.testSet, target: options.target });
      emit(options.json || true, task);
      return EXIT_OK;
    }
    if (command === 'attach') {
      const file = positional[0];
      if (file === undefined || options.repo === undefined || options.evidence === undefined || options.revision === undefined) {
        return fail('E_USAGE', 'Obavezni: zadatak, --repo, --evidence i --revision');
      }
      const task = attachEvidence({ taskPath: file, repo: options.repo, evidence: options.evidence, revision: options.revision });
      emit(options.json || true, task);
      return EXIT_OK;
    }
    if (command === 'transition') {
      const file = positional[0];
      if (file === undefined || options.repo === undefined || options.to === undefined) {
        return fail('E_USAGE', 'Obavezni: zadatak, --repo i --to');
      }
      const result = transitionTask({ taskPath: file, repo: options.repo, to: options.to, reason: options.reason });
      emit(options.json || true, result);
      return EXIT_OK;
    }
    if (command === 'status') {
      const file = positional[0];
      if (file === undefined) return fail('E_USAGE', 'Nedostaje putanja zadatka');
      const task = readTask(file);
      emit(options.json || true, task);
      return EXIT_OK;
    }
    return fail('E_USAGE', 'Nepoznata komanda: ' + String(command));
  } catch (error) {
    if (!(error instanceof BoardError)) throw error;
    const body = { code: error.code, message: error.message };
    if (error.reason !== undefined) body.reason = error.reason;
    emit(true, { ok: false, error: body });
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
