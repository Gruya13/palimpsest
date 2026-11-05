/**
 * Memorija v1 i kanal MEMORY.md.
 *
 * Memorijski zapis je JSON u memory/<nivo>/<MEM-ID>.json. MEMORY.md se generiše
 * iz saznanja (samo consolidated) kao prevedena memorija bez porekla — bez
 * evidence, autora, metrika i sna. Radnikov view je privremeni detached worktree
 * revizije, bez memory/, sa generisanim MEMORY.md kao jedinim kanalom.
 *
 * Upotreba zapisa: `used_count`/`last_used` se pune kada zapis uđe u
 * kanal za konkretan zadatak (`recordChannelUsage`, ledger `upotreba/`);
 * bez `taskId` render ostaje read-only.
 *
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { escalateQuestions } from './questions.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MEMORY_LEVELS = ['kandidati', 'saznanja', 'pravila', 'pitanja', 'povuceno'];
export const MEMORY_KINDS = ['convention', 'constraint', 'failure-mode', 'decision'];

const STATUSES = ['consolidated', 'open-question', 'retracted', 'stale'];
const RECORD_FIELDS = [
  'version', 'id', 'claim', 'scope', 'kind', 'evidence', 'falsifier', 'revision_bound',
  'status', 'supersedes', 'superseded_by', 'used_count', 'last_used', 'deadline',
  'escalated_at', 'failed_with', 'owner_role', 'created', 'updated',
];
const INPUT_FIELDS = RECORD_FIELDS.filter(f => !['version', 'created', 'updated'].includes(f));
// rok i eskalacija su opciona polja (default null).
const OPTIONAL_FIELDS = ['deadline', 'escalated_at'];
const REQUIRED_INPUT_FIELDS = INPUT_FIELDS.filter(f => !OPTIONAL_FIELDS.includes(f));
const MEM_ID = /^MEM-[0-9]{1,6}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const FORBIDDEN_WORD = /(^|[^\p{L}\p{N}_])(san|snovi|snova|snove|snu|snom|sna)(?=$|[^\p{L}\p{N}_])/iu;
const HEADER = '# Memorija projekta\n\n> Generisano iz memorije. Ne menjaj ručno. Ovo je jedini kanal ka memoriji.\n\n';
const TASK_ID = /^TASK-[0-9]{1,6}$/;
const USAGE_DIR = 'upotreba';
const USAGE_VERSION = 1;

/** Greška memorije. */
export class MemoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MemoryError';
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

function isRelativePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024) return false;
 // git pathspec magic (npr. ':(exclude)src/**') nije putanja.
  if (value.startsWith(':')) return false;
  if (path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return normalized !== '..' && !normalized.startsWith('..' + path.sep);
}

function isMemoryId(value) {
  return typeof value === 'string' && MEM_ID.test(value);
}

function isMemoryIdArray(value, max = 64) {
  return Array.isArray(value) && value.length <= max && value.every(isMemoryId);
}

function validateRecord(value) {
  const errors = [];
  if (!isPlainObject(value)) return ['zapis mora biti JSON objekat'];
  for (const key of Object.keys(value)) {
    if (!RECORD_FIELDS.includes(key)) errors.push('nepoznato polje: ' + key);
  }
  for (const field of RECORD_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) errors.push('nedostaje polje: ' + field);
  }
  if (value.version !== 1) errors.push('version mora biti 1');
  if (!isMemoryId(value.id)) errors.push('id mora biti MEM-<broj>');
  if (typeof value.claim !== 'string' || value.claim.length < 1 || value.claim.length > 500) errors.push('claim mora biti 1–500 znakova');
  if (!Array.isArray(value.scope) || value.scope.length < 1 || value.scope.length > 64 || !value.scope.every(isRelativePath)) errors.push('scope mora biti niz relativnih putanja (1–64)');
  if (!MEMORY_KINDS.includes(value.kind)) errors.push('nepoznat kind');
  if (value.evidence !== null && !isRelativePath(value.evidence)) errors.push('evidence mora biti relativna putanja ili null');
  if (value.falsifier !== null && (typeof value.falsifier !== 'string' || value.falsifier.length < 1 || value.falsifier.length > 2000)) errors.push('falsifier mora biti 1–2000 znakova ili null');
  if (value.revision_bound !== null && (typeof value.revision_bound !== 'string' || !HEX40.test(value.revision_bound))) errors.push('revision_bound mora biti 40 hex ili null');
  if (!STATUSES.includes(value.status)) errors.push('nepoznat status');
  if (!isMemoryIdArray(value.supersedes)) errors.push('supersedes mora biti niz MEM-id-jeva (0–64)');
  if (!isMemoryIdArray(value.superseded_by)) errors.push('superseded_by mora biti niz MEM-id-jeva (0–64)');
  if (!Number.isInteger(value.used_count) || value.used_count < 0) errors.push('used_count mora biti ceo broj >= 0');
  if (value.last_used !== null && !isIsoUtc(value.last_used)) errors.push('last_used mora biti ISO vreme ili null');
  if (value.deadline !== null && value.deadline !== undefined && !isIsoUtc(value.deadline)) errors.push('deadline mora biti ISO vreme ili null');
  if (value.escalated_at !== null && value.escalated_at !== undefined && !isIsoUtc(value.escalated_at)) errors.push('escalated_at mora biti ISO vreme ili null');
  if (value.escalated_at !== null && value.escalated_at !== undefined && (value.deadline === null || value.deadline === undefined)) errors.push('escalated_at zahteva deadline');
  if (!Array.isArray(value.failed_with) || value.failed_with.length > 64 || !value.failed_with.every(x => typeof x === 'string' && x.length >= 1 && x.length <= 64)) errors.push('failed_with mora biti niz stringova (0–64)');
  if (typeof value.owner_role !== 'string' || value.owner_role.length < 1 || value.owner_role.length > 64) errors.push('owner_role mora biti 1–64 znaka');
  if (!isIsoUtc(value.created)) errors.push('created mora biti ISO vreme');
  if (!isIsoUtc(value.updated)) errors.push('updated mora biti ISO vreme');
  return errors;
}

function assertRecord(value) {
  const errors = validateRecord(value);
  if (errors.length > 0) throw new MemoryError('E_SCHEMA', 'Nevalidan zapis: ' + errors.join('; '));
  return value;
}

function validateLevel(level) {
  if (!MEMORY_LEVELS.includes(level)) {
    throw new MemoryError('E_LEVEL', 'Nepoznat nivo: ' + String(level) + ' (dozvoljeni: ' + MEMORY_LEVELS.join(', ') + ')');
  }
  return level;
}

function assertLevelRules(level, value) {
  if (level === 'saznanja' || level === 'pravila') {
    for (const field of ['evidence', 'falsifier', 'revision_bound']) {
      if (value[field] === null) {
        throw new MemoryError('E_SCHEMA', 'Nivo ' + level + ' zahteva ' + field);
      }
    }
  }
  if (level === 'pitanja' && value.status !== 'open-question') {
    throw new MemoryError('E_SCHEMA', 'Nivo pitanja zahteva status open-question');
  }
 // rok i eskalacija postoje samo u nivou pitanja.
  if (level !== 'pitanja' && ((value.deadline ?? null) !== null || (value.escalated_at ?? null) !== null)) {
    throw new MemoryError('E_SCHEMA', 'deadline/escalated_at su dozvoljeni samo u nivou pitanja');
  }
  if (level === 'povuceno' && !['retracted', 'stale'].includes(value.status)) {
    throw new MemoryError('E_SCHEMA', 'Nivo povuceno zahteva status retracted ili stale');
  }
}

function readJsonFile(file, notFoundCode) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new MemoryError(notFoundCode, 'Fajl ne postoji ili se ne čita: ' + path.resolve(file));
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new MemoryError('E_SCHEMA', 'Nije validan JSON: ' + error.message);
  }
}

/** Pročitaj i validiraj zapis. Ne menja fajl. Stari zapisi dobijaju null opciona polja. */
export function readMemory(file) {
  if (typeof file !== 'string' || file === '') throw new MemoryError('E_SCHEMA', 'putanja zapisa je obavezna');
  const value = readJsonFile(file, 'E_NOT_FOUND');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return assertRecord(value);
  return assertRecord({ ...value, deadline: value.deadline ?? null, escalated_at: value.escalated_at ?? null });
}

function recordPathFor(memoryRoot, level, id) {
  return path.join(memoryRoot, level, id + '.json');
}

/** Upiši nov zapis u nivo; version/created/updated dolaze iz now. */
export function writeMemory(options = {}) {
  const { memoryRoot, level, memory, now = () => new Date().toISOString() } = options;
  if (typeof memoryRoot !== 'string' || memoryRoot === '') throw new MemoryError('E_USAGE', 'memoryRoot je obavezan');
  const normalizedLevel = validateLevel(level);
  if (!isPlainObject(memory)) throw new MemoryError('E_SCHEMA', 'zapis mora biti JSON objekat');
  for (const field of ['version', 'created', 'updated']) {
    if (Object.prototype.hasOwnProperty.call(memory, field)) {
      throw new MemoryError('E_SCHEMA', field + ' dodaje writeMemory, ne ulaz');
    }
  }
  for (const field of REQUIRED_INPUT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(memory, field)) throw new MemoryError('E_SCHEMA', 'nedostaje polje: ' + field);
  }
  for (const key of Object.keys(memory)) {
    if (!INPUT_FIELDS.includes(key)) throw new MemoryError('E_SCHEMA', 'nepoznato polje: ' + key);
  }
  const at = now();
  const record = { ...memory, version: 1, created: at, updated: at };
  delete record.version;
  delete record.created;
  delete record.updated;
  const ordered = {
    version: 1,
    id: memory.id,
    claim: memory.claim,
    scope: memory.scope,
    kind: memory.kind,
    evidence: memory.evidence,
    falsifier: memory.falsifier,
    revision_bound: memory.revision_bound,
    status: memory.status,
    supersedes: memory.supersedes,
    superseded_by: memory.superseded_by,
    used_count: memory.used_count,
    last_used: memory.last_used,
    deadline: memory.deadline ?? null,
    escalated_at: memory.escalated_at ?? null,
    failed_with: memory.failed_with,
    owner_role: memory.owner_role,
    created: at,
    updated: at,
  };
  assertRecord(ordered);
  assertLevelRules(normalizedLevel, ordered);
  const file = recordPathFor(memoryRoot, normalizedLevel, ordered.id);
  if (existsSync(file)) throw new MemoryError('E_EXISTS', 'Zapis već postoji: ' + ordered.id + ' u ' + normalizedLevel);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
 // Isključivi upis: race sa drugim procesom ne prepisuje postojeći fajl.
    writeFileSync(file, JSON.stringify(ordered, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new MemoryError('E_EXISTS', 'Zapis već postoji: ' + ordered.id + ' u ' + normalizedLevel);
    throw new MemoryError('E_WRITE', 'Zapis nije upisan: ' + error.message);
  }
  return ordered;
}

/** Lista validiranih zapisa, sortirano po id; opciono po nivou. */
export function listMemories(options = {}) {
  const { memoryRoot, level } = options;
  if (typeof memoryRoot !== 'string' || memoryRoot === '') throw new MemoryError('E_USAGE', 'memoryRoot je obavezan');
  const levels = level === undefined ? MEMORY_LEVELS : [validateLevel(level)];
  const records = [];
  for (const name of levels) {
    const dir = path.join(memoryRoot, name);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      records.push(readMemory(path.join(dir, entry)));
    }
  }
  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return records;
}

/** Ažuriraj postojeći zapis: created i id ostaju, updated dolazi iz now. */
export function updateMemory(options = {}) {
  const { memoryPath, memory, memoryRoot, level, id, changes, now = () => new Date().toISOString() } = options;
 // režim: { memoryRoot, level, id, changes }
  if (changes !== undefined) {
    if (typeof memoryRoot !== 'string' || memoryRoot === '') throw new MemoryError('E_USAGE', 'memoryRoot je obavezan');
    const normalizedLevel = validateLevel(level);
    if (typeof id !== 'string' || !MEM_ID.test(id)) throw new MemoryError('E_USAGE', 'id mora biti MEM-<broj>');
    if (!isPlainObject(changes)) throw new MemoryError('E_SCHEMA', 'changes mora biti JSON objekat');
    for (const field of ['version', 'created', 'updated']) {
      if (Object.prototype.hasOwnProperty.call(changes, field)) throw new MemoryError('E_SCHEMA', field + ' se ne menja');
    }
    for (const key of Object.keys(changes)) {
      if (!INPUT_FIELDS.includes(key)) throw new MemoryError('E_SCHEMA', 'nepoznato polje: ' + key);
    }
    const file = recordPathFor(memoryRoot, normalizedLevel, id);
    const current = readMemory(file);
    const updated = { ...current, ...changes, updated: now() };
    assertRecord(updated);
    assertLevelRules(normalizedLevel, updated);
    try {
      writeFileAtomicSync(file, JSON.stringify(updated, null, 2) + '\n');
    } catch (error) {
      throw new MemoryError('E_WRITE', 'Zapis nije upisan: ' + error.message);
    }
    return updated;
  }
  if (typeof memoryPath !== 'string' || memoryPath === '') throw new MemoryError('E_USAGE', 'memoryPath je obavezan');
  const existing = readMemory(memoryPath);
  assertRecord(memory);
  if (memory.version !== existing.version) throw new MemoryError('E_SCHEMA', 'version se ne menja');
  if (memory.id !== existing.id) throw new MemoryError('E_SCHEMA', 'id se ne menja');
  if (memory.created !== existing.created) throw new MemoryError('E_SCHEMA', 'created se ne menja');
  const updated = { ...memory, created: existing.created, updated: now() };
  assertRecord(updated);
  try {
    writeFileAtomicSync(memoryPath, JSON.stringify(updated, null, 2) + '\n');
  } catch (error) {
    throw new MemoryError('E_WRITE', 'Zapis nije upisan: ' + error.message);
  }
  return updated;
}

/** Sledeći globalni MEM-id: najveći postojeći broj + 1, najmanje tri cifre. */
export function nextMemoryId(options = {}) {
  const { memoryRoot } = options;
  if (typeof memoryRoot !== 'string' || memoryRoot === '') throw new MemoryError('E_USAGE', 'memoryRoot je obavezan');
  let max = 0;
  for (const level of MEMORY_LEVELS) {
    const dir = path.join(memoryRoot, level);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const match = /^MEM-([0-9]{1,6})\.json$/.exec(entry);
      if (match) max = Math.max(max, Number(match[1]));
    }
  }
  return 'MEM-' + String(max + 1).padStart(3, '0');
}

function hasForbiddenWord(value) {
  if (typeof value === 'string') return FORBIDDEN_WORD.test(value);
  if (Array.isArray(value)) return value.some(hasForbiddenWord);
  return false;
}

/** atomski upis (temp + rename) — prekid ne ostavlja polupisan fajl. */
function writeFileAtomicSync(file, text) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now().toString(36);
  writeFileSync(tmp, text, 'utf8');
  try {
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* već uklonjen */ }
    throw error;
  }
}

function channelKnowledge(memoryRoot) {
  return listMemories({ memoryRoot, level: 'saznanja' })
    .filter(record => record.status === 'consolidated')
 // pojam sna se zabranjuje u tvrdnji (poreklo), ali ne u
 // putanjama scope/falsifier — radnik ionako vidi src/san i tests/san.
    .filter(record => !hasForbiddenWord(record.claim));
}

/** Broj zapisa koji ulaze u kanal (isto pravilo kao renderer). */
export function countChannelRecords(options = {}) {
  const { memoryRoot } = options;
  if (typeof memoryRoot !== 'string' || memoryRoot === '') throw new MemoryError('E_USAGE', 'memoryRoot je obavezan');
  return channelKnowledge(memoryRoot).length;
}

function assertUsageTaskId(taskId) {
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) {
    throw new MemoryError('E_USAGE', 'taskId mora biti TASK-<broj>');
  }
  return taskId;
}

function readUsageLedger(file, taskId) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new MemoryError('E_WRITE', 'Ledger se ne čita: ' + error.message);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new MemoryError('E_SCHEMA', 'Ledger nije validan JSON: ' + error.message);
  }
  const errors = [];
  if (!isPlainObject(value)) errors.push('ledger mora biti JSON objekat');
  else {
    if (value.version !== USAGE_VERSION) errors.push('version mora biti 1');
    if (value.task !== taskId) errors.push('task mora biti ' + taskId);
    if (!isMemoryIdArray(value.ids)) errors.push('ids mora biti niz MEM-id-jeva');
    if (!isIsoUtc(value.at)) errors.push('at mora biti ISO vreme');
  }
  if (errors.length > 0) throw new MemoryError('E_SCHEMA', 'Nevalidan ledger: ' + errors.join('; '));
  return value;
}

/**
 * Zabeleži upotrebu kanalskih zapisa za zadatak; idempotentno po zadatku
 * preko ledger-a `<memoryRoot>/upotreba/<TASK-ID>.json`. Menja samo
 * `used_count`, `last_used` i `updated` kanalskih zapisa; `upotreba/` nije
 * memorijski nivo i ne vidi se u listama, renderu ni NREM-u.
 */
export function recordChannelUsage(options = {}) {
  const { memoryRoot, taskId, now = () => new Date().toISOString() } = options;
  if (typeof memoryRoot !== 'string' || memoryRoot === '') throw new MemoryError('E_USAGE', 'memoryRoot je obavezan');
  assertUsageTaskId(taskId);
  let stat;
  try {
    stat = statSync(memoryRoot);
  } catch {
    throw new MemoryError('E_USAGE', 'memoryRoot ne postoji: ' + path.resolve(memoryRoot));
  }
  if (!stat.isDirectory()) throw new MemoryError('E_USAGE', 'memoryRoot nije direktorijum');
  const at = now();
  if (!isIsoUtc(at)) throw new MemoryError('E_USAGE', 'now mora biti ISO UTC vreme');
  const ledgerFile = path.join(memoryRoot, USAGE_DIR, taskId + '.json');
  if (existsSync(ledgerFile)) {
    const existing = readUsageLedger(ledgerFile, taskId);
    return { version: USAGE_VERSION, task: taskId, ids: [...existing.ids], already: true };
  }
  const knowledge = channelKnowledge(memoryRoot);
  const ids = [];
  for (const record of knowledge) {
    const file = recordPathFor(memoryRoot, 'saznanja', record.id);
    updateMemory({
      memoryPath: file,
      memory: { ...record, used_count: record.used_count + 1, last_used: at },
      now: () => at,
    });
    ids.push(record.id);
  }
  const ledger = { version: USAGE_VERSION, task: taskId, ids, at };
  try {
    mkdirSync(path.dirname(ledgerFile), { recursive: true });
    writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
  } catch (error) {
    throw new MemoryError('E_WRITE', 'Ledger nije upisan: ' + error.message);
  }
  return { version: USAGE_VERSION, task: taskId, ids, already: false };
}

function renderInto(memoryRoot) {
  const knowledge = channelKnowledge(memoryRoot);
  const blocks = [];
  for (const record of knowledge) {
    blocks.push('## ' + record.id + ' — ' + record.claim + '\n\n'
      + '- scope: ' + record.scope.join(', ') + '\n'
      + '- kind: ' + record.kind + '\n'
      + '- falsifier: ' + record.falsifier + '\n'
      + '- revision: ' + record.revision_bound + '\n');
  }
  return { text: HEADER + blocks.join('\n'), memoryCount: knowledge.length };
}

/** Generiši MEMORY.md iz saznanja; deterministički, bez porekla i vremena. */
export function renderMemoryChannel(options = {}) {
  const { memoryRoot, out, taskId, now = () => new Date().toISOString() } = options;
  if (typeof memoryRoot !== 'string' || memoryRoot === '') throw new MemoryError('E_USAGE', 'memoryRoot je obavezan');
  if (typeof out !== 'string' || out === '') throw new MemoryError('E_USAGE', 'out je obavezan');
  if (taskId !== undefined) assertUsageTaskId(taskId);
  const { text } = renderInto(memoryRoot);
  try {
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeFileAtomicSync(out, text);
  } catch (error) {
    throw new MemoryError('E_WRITE', 'Kanal nije upisan: ' + error.message);
  }
  if (taskId !== undefined) recordChannelUsage({ memoryRoot, taskId, now });
  return out;
}

function assertRepo(repo) {
  if (typeof repo !== 'string' || repo === '') throw new MemoryError('E_REPO', 'repo je obavezan');
  let stat;
  try {
    stat = statSync(repo);
  } catch {
    throw new MemoryError('E_REPO', 'repo ne postoji: ' + path.resolve(repo));
  }
  if (!stat.isDirectory()) throw new MemoryError('E_REPO', 'repo nije direktorijum');
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 15000 });
  } catch {
    throw new MemoryError('E_REPO', 'repo nije git radno stablo: ' + path.resolve(repo));
  }
}

function assertRevision(repo, revision) {
  if (typeof revision !== 'string' || !HEX40.test(revision)) {
    throw new MemoryError('E_REVISION', 'revision mora biti pun git SHA (40 lowercase hex)');
  }
  try {
    execFileSync('git', ['-C', repo, 'cat-file', '-e', revision + '^{commit}'], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 15000 });
  } catch {
    throw new MemoryError('E_REVISION', 'revision ne postoji u repou: ' + revision);
  }
}

/** Napravi izolovani radnikov view: detached worktree bez memory/, sa generisanim kanalom. */
export function prepareWorkerView(options = {}) {
  const { repo, revision, memoryRoot, out, taskId, now = () => new Date().toISOString() } = options;
  assertRepo(repo);
  assertRevision(repo, revision);
  if (typeof memoryRoot !== 'string' || memoryRoot === '') throw new MemoryError('E_USAGE', 'memoryRoot je obavezan');
  if (typeof out !== 'string' || out === '') throw new MemoryError('E_USAGE', 'out je obavezan');
  if (taskId !== undefined) assertUsageTaskId(taskId);
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', '--force', out, revision], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 60000 });
  } catch (error) {
    throw new MemoryError('E_WRITE', 'View nije napravljen: ' + error.message);
  }
  try {
    rmSync(path.join(out, 'memory'), { recursive: true, force: true });
    const { text, memoryCount } = renderInto(memoryRoot);
    writeFileAtomicSync(path.join(out, 'MEMORY.md'), text);
    if (taskId !== undefined) recordChannelUsage({ memoryRoot, taskId, now });
    return { view: out, revision, memoryCount };
  } catch (error) {
    try {
      execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', out], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch { /* najbolji pokušaj */ }
    rmSync(out, { recursive: true, force: true });
    if (error instanceof MemoryError) throw error;
    throw new MemoryError('E_WRITE', 'View nije pripremljen: ' + error.message);
  }
}

/** Ukloni radnikov view; idempotentno. */
export function removeWorkerView(options = {}) {
  const { repo, out } = options;
  assertRepo(repo);
  if (typeof out !== 'string' || out === '') throw new MemoryError('E_USAGE', 'out je obavezan');
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', out], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 60000 });
  } catch { /* nije worktree ili ne postoji */ }
  rmSync(out, { recursive: true, force: true });
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'prune'], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 15000 });
  } catch { /* najbolji pokušaj */ }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_REJECTED = 1;
const EXIT_USAGE = 2;

const EXIT_BY_CODE = {
  E_SCHEMA: EXIT_REJECTED,
  E_EXISTS: EXIT_REJECTED,
  E_LEVEL: EXIT_REJECTED,
  E_NOT_FOUND: EXIT_REJECTED,
  E_USAGE: EXIT_USAGE,
  E_REPO: EXIT_USAGE,
  E_REVISION: EXIT_USAGE,
  E_WRITE: EXIT_USAGE,
};

function parseCli(argv) {
  const options = { json: false, root: undefined, level: undefined, file: undefined, out: undefined, repo: undefined, revision: undefined, task: undefined };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--root') { options.root = argv[i + 1]; i += 1; continue; }
    if (arg === '--level') { options.level = argv[i + 1]; i += 1; continue; }
    if (arg === '--file') { options.file = argv[i + 1]; i += 1; continue; }
    if (arg === '--out') { options.out = argv[i + 1]; i += 1; continue; }
    if (arg === '--repo') { options.repo = argv[i + 1]; i += 1; continue; }
    if (arg === '--revision') { options.revision = argv[i + 1]; i += 1; continue; }
    if (arg === '--task') { options.task = argv[i + 1]; i += 1; continue; }
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
    emit(true, { ok: false, error: { code, message } });
    return EXIT_USAGE;
  };
  try {
    if (command === 'escalate') {
      if (options.root === undefined) return fail('E_USAGE', 'Obavezan: --root');
      try {
        const result = escalateQuestions({ memoryRoot: options.root });
        emit(options.json, result);
        return EXIT_OK;
      } catch (error) {
        if (error instanceof MemoryError) return fail(error.code, error.message);
        throw error;
      }
    }
    if (command === 'stats') {
      if (options.root === undefined) return fail('E_USAGE', 'Obavezan: --root');
      if (!existsSync(options.root)) return fail('E_MEMORY', 'memoryRoot ne postoji: ' + path.resolve(options.root));
      try {
        const levels = Object.fromEntries(MEMORY_LEVELS.map(level => [level, 0]));
        const statuses = Object.fromEntries(STATUSES.map(status => [status, 0]));
        let total = 0;
        for (const level of MEMORY_LEVELS) {
          const dir = path.join(options.root, level);
          if (!existsSync(dir)) continue;
          for (const entry of readdirSync(dir).sort()) {
            if (!entry.endsWith('.json')) continue;
            const record = readMemory(path.join(dir, entry));
            levels[level] += 1;
            total += 1;
            if (Object.prototype.hasOwnProperty.call(statuses, record.status)) statuses[record.status] += 1;
          }
        }
        emit(options.json, { levels, statuses, total });
        return EXIT_OK;
      } catch (error) {
        if (error instanceof MemoryError) return fail(error.code, error.message);
        throw error;
      }
    }
    if (command === 'write') {
      if (options.root === undefined || options.level === undefined || options.file === undefined) {
        return fail('E_USAGE', 'Obavezni: --root, --level i --file');
      }
      const input = readJsonFile(options.file, 'E_NOT_FOUND');
      const record = writeMemory({ memoryRoot: options.root, level: options.level, memory: input });
      emit(true, record);
      return EXIT_OK;
    }
    if (command === 'list') {
      if (options.root === undefined) return fail('E_USAGE', 'Obavezan: --root');
      const records = listMemories({ memoryRoot: options.root, level: options.level });
      emit(true, { memories: records, count: records.length });
      return EXIT_OK;
    }
    if (command === 'render') {
      if (options.root === undefined || options.out === undefined) return fail('E_USAGE', 'Obavezni: --root i --out');
      const out = renderMemoryChannel({ memoryRoot: options.root, out: options.out, taskId: options.task });
      emit(true, { out });
      return EXIT_OK;
    }
    if (command === 'view') {
      if (options.repo === undefined || options.revision === undefined || options.root === undefined || options.out === undefined) {
        return fail('E_USAGE', 'Obavezni: --repo, --revision, --root i --out');
      }
      const result = prepareWorkerView({ repo: options.repo, revision: options.revision, memoryRoot: options.root, out: options.out, taskId: options.task });
      emit(true, result);
      return EXIT_OK;
    }
    return fail('E_USAGE', 'Nepoznata komanda: ' + String(command));
  } catch (error) {
    if (!(error instanceof MemoryError)) throw error;
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
