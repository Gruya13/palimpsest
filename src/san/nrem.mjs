/**
 * NREM san — deterministički kompajler memorije.
 *
 * Audit pronalazi saznanja i pravila koja su prestala da važe: `revision_bound`
 * više nije predak HEAD-a ili ne postoji, ili je u deklarisanom opsegu
 * (`scope`) promenjen bar jedan fajl između `revision_bound` i HEAD-a
 * (`scope-changed`). Apply menja samo status u `stale`. Nema LLM poziva i
 * nema vremena u rezultatu: isti ulaz → isti bajtovi.
 *
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MEMORY_LEVELS, MemoryError, countChannelRecords, listMemories, nextMemoryId,
  readMemory, renderMemoryChannel, updateMemory, writeMemory,
} from '../memory/memory.mjs';

export const NREM_VERSION = 1;

const STATUSES = ['consolidated', 'stale', 'open-question', 'retracted'];
const CHECKED_LEVELS = ['saznanja', 'pravila'];

/** Greška NREM sna. */
export class NremError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NremError';
    this.code = code;
  }
}

function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function gitTry(repo, args) {
  try {
    execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

function gitText(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000,
  }).trim();
}

function assertMemoryRoot(memoryRoot) {
  if (typeof memoryRoot !== 'string' || memoryRoot === '') {
    throw new NremError('E_MEMORY', 'memoryRoot je obavezan');
  }
  let stat;
  try {
    stat = statSync(memoryRoot);
  } catch {
    throw new NremError('E_MEMORY', 'memoryRoot ne postoji: ' + path.resolve(memoryRoot));
  }
  if (!stat.isDirectory()) throw new NremError('E_MEMORY', 'memoryRoot nije direktorijum');
}

function assertRepo(repo) {
  if (typeof repo !== 'string' || repo === '') throw new NremError('E_REPO', 'repo je obavezan');
  let stat;
  try {
    stat = statSync(repo);
  } catch {
    throw new NremError('E_REPO', 'repo ne postoji: ' + path.resolve(repo));
  }
  if (!stat.isDirectory()) throw new NremError('E_REPO', 'repo nije direktorijum');
  if (!gitTry(repo, ['rev-parse', '--show-toplevel'])) {
    throw new NremError('E_REPO', 'repo nije git radno stablo: ' + path.resolve(repo));
  }
}

function headOf(repo) {
  try {
    return gitText(repo, ['rev-parse', 'HEAD']);
  } catch {
    throw new NremError('E_REVISION', 'repo nema HEAD reviziju');
  }
}

/**
 * Promena u deklarisanom opsegu: git diff između vezane revizije i HEAD-a,
 * ograničen na `scope`. Gleda se samo commitovana istorija; radno stablo se
 * ne gleda. Greška git-a je E_REPO (audit tada ne vraća delimičan rezultat).
 */
function scopeChanged(repo, revisionBound, scope) {
  let output;
 // literal pathspec — scope iz memorije ne može da nosi git magic.
  const pathspecs = scope.map(entry => ':(literal)' + entry);
  try {
    output = execFileSync('git', ['-C', repo, 'diff', '--name-only', revisionBound + '..HEAD', '--', ...pathspecs], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000,
    });
  } catch (error) {
    throw new NremError('E_REPO', 'scope diff nije moguć: ' + error.message);
  }
  return output.split('\n').some(line => line.trim() !== '');
}

function staleReason(repo, revisionBound, scope) {
  if (!gitTry(repo, ['cat-file', '-e', revisionBound + '^{commit}'])) return 'missing-revision';
  if (!gitTry(repo, ['merge-base', '--is-ancestor', revisionBound, 'HEAD'])) return 'not-ancestor';
  if (scopeChanged(repo, revisionBound, scope)) return 'scope-changed';
  return null;
}

/**
 * Read-only audit memorije: metrike po nivoima i statusima + stale kandidati.
 * Determinizam: nema vremena u rezultatu; digest je sha256 kanonskog JSON-a.
 */
export function nremAudit(options = {}) {
  const { memoryRoot, repo } = options;
  assertMemoryRoot(memoryRoot);
  assertRepo(repo);
  const head = headOf(repo);

  const counts = {
    levels: Object.fromEntries(MEMORY_LEVELS.map(level => [level, 0])),
    statuses: Object.fromEntries(STATUSES.map(status => [status, 0])),
    total: 0,
  };
  const stale = [];
  for (const level of MEMORY_LEVELS) {
    const records = listMemories({ memoryRoot, level });
    counts.levels[level] = records.length;
    for (const record of records) {
      counts.statuses[record.status] += 1;
      counts.total += 1;
      if (CHECKED_LEVELS.includes(level) && record.status === 'consolidated') {
        const reason = staleReason(repo, record.revision_bound, record.scope);
        if (reason !== null) stale.push({ id: record.id, level, reason });
      }
    }
  }
  stale.sort((a, b) => (a.level < b.level ? -1 : a.level > b.level ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const body = { version: NREM_VERSION, head, counts, stale };
  const digest = sha256(JSON.stringify(body));
  return { ...body, digest };
}

/**
 * Primeni stale listu: menjaju se samo status i updated. Zapis koji u
 * međuvremenu više nije consolidated se preskače.
 */
export function applyStale(options = {}) {
  const { memoryRoot, audit, now = () => new Date().toISOString() } = options;
  assertMemoryRoot(memoryRoot);
  if (audit === null || typeof audit !== 'object' || !Array.isArray(audit.stale)) {
    throw new NremError('E_SCHEMA', 'audit mora biti rezultat nremAudit-a');
  }
  const applied = [];
  const skipped = [];
  for (const entry of audit.stale) {
    const file = path.join(memoryRoot, entry.level, entry.id + '.json');
    let record;
    try {
      record = readMemory(file);
    } catch (error) {
      if (error instanceof MemoryError && error.code === 'E_NOT_FOUND') {
        skipped.push({ id: entry.id, level: entry.level });
        continue;
      }
      throw error;
    }
    if (record.status !== 'consolidated') {
      skipped.push({ id: entry.id, level: entry.level });
      continue;
    }
    updateMemory({ memoryPath: file, memory: { ...record, status: 'stale' }, now });
    applied.push({ id: entry.id, level: entry.level });
  }
  return { applied, skipped };
}

function sameScope(a, b) {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function scopeKey(record) {
  return record.scope.join('\u0000') + '\u0000' + record.kind;
}

function writeRecordFile(file, record) {
  try {
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
  } catch (error) {
    throw new NremError('E_WRITE', 'Zapis nije upisan: ' + error.message);
  }
}

/**
 * NREM ciklus: audit → apply stale → reconcile kandidata (duplikat →
 * povučeno/retracted; konflikt → pitanje) → render kanala → deterministički
 * otisak u dreams/nrem.json. Bez LLM-a i bez vremena u otisku.
 */
export function nremRun(options = {}) {
  const { memoryRoot, repo, out, now = () => new Date().toISOString() } = options;
  assertMemoryRoot(memoryRoot);
  assertRepo(repo);
  if (typeof out !== 'string' || out === '') throw new NremError('E_USAGE', 'out je obavezan');

 // 1) audit — čita i validira sve zapise pre ijednog upisa
  const audit = nremAudit({ memoryRoot, repo });

 // 2) primena stale oznaka
  const staleApplied = applyStale({ memoryRoot, audit, now });

 // 3) reconcile kandidata
  const candidates = listMemories({ memoryRoot, level: 'kandidati' });
  const knowledge = listMemories({ memoryRoot, level: 'saznanja' });
  const existingQuestions = listMemories({ memoryRoot, level: 'pitanja' });
  const retracted = [];
  const moved = [];
  const remaining = [];
  for (const candidate of candidates) {
    const duplicate = knowledge.find(item => item.status !== 'retracted'
      && item.claim === candidate.claim && item.kind === candidate.kind && sameScope(item.scope, candidate.scope));
    if (duplicate) {
      retracted.push({ id: candidate.id, duplicate_of: duplicate.id });
      moved.push({
        from: path.join(memoryRoot, 'kandidati', candidate.id + '.json'),
        to: path.join(memoryRoot, 'povuceno', candidate.id + '.json'),
        record: { ...candidate, status: 'retracted' },
      });
    } else {
      remaining.push(candidate);
    }
  }
  const questions = [];
  const newQuestions = [];
  const groups = new Map();
  for (const candidate of remaining) {
    const key = scopeKey(candidate);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  let nextIdNumber = Number(nextMemoryId({ memoryRoot }).slice(4));
  const at = now();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const first = group[0];
    const second = group.find(item => item.claim !== first.claim);
    if (second === undefined) continue;
    const claim = 'Konflikt: ' + first.claim + ' vs ' + second.claim;
    const already = existingQuestions.some(question => question.claim === claim
      && question.kind === first.kind && sameScope(question.scope, first.scope));
    if (already) continue;
    const id = 'MEM-' + String(nextIdNumber).padStart(3, '0');
    nextIdNumber += 1;
    questions.push({ id, claim });
    newQuestions.push({
      id, claim, scope: [...first.scope], kind: first.kind,
      evidence: null, falsifier: null, revision_bound: null, status: 'open-question',
      supersedes: [], superseded_by: [], used_count: 0, last_used: null,
      failed_with: [], owner_role: 'librarian',
    });
  }
 // primena plana: pomeranja pa pitanja
  for (const move of moved) {
    writeRecordFile(move.to, move.record);
    try {
      rmSync(move.from, { force: true });
    } catch (error) {
      throw new NremError('E_WRITE', 'Kandidat nije uklonjen: ' + error.message);
    }
  }
  for (const question of newQuestions) {
    writeMemory({ memoryRoot, level: 'pitanja', memory: question, now: () => at });
  }

 // 4) render kanala iz aktivne memorije
  const channelPath = renderMemoryChannel({ memoryRoot, out });
  const channelBytes = readFileSync(out);
  const channel = {
    path: channelPath,
    sha256: sha256(channelBytes),
    records: countChannelRecords({ memoryRoot }),
  };

 // 5) otisak — no-op ciklus ne prepisuje istorijski otisak
  const tracePath = path.join(memoryRoot, 'dreams', 'nrem.json');
  const changed = staleApplied.applied.length > 0 || retracted.length > 0 || questions.length > 0;
  let trace;
  if (!changed && existsSync(tracePath)) {
    trace = { path: tracePath, sha256: sha256(readFileSync(tracePath)) };
  } else {
    const body = {
      version: NREM_VERSION,
      audit: { head: audit.head, stale: audit.stale, counts: audit.counts },
      reconcile: {
        retracted: retracted.map(entry => ({ id: entry.id, duplicate_of: entry.duplicate_of })),
        questions: questions.map(entry => ({ id: entry.id, claim: entry.claim })),
      },
      channel: { sha256: channel.sha256, records: channel.records },
    };
    const digest = sha256(JSON.stringify(body));
    const value = { ...body, digest };
    try {
      mkdirSync(path.dirname(tracePath), { recursive: true });
      writeFileSync(tracePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
    } catch (error) {
      throw new NremError('E_WRITE', 'Otisak nije upisan: ' + error.message);
    }
    trace = { path: tracePath, sha256: sha256(readFileSync(tracePath)) };
  }

  return { audit, staleApplied, retracted, questions, channel, trace };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_REJECTED = 1;
const EXIT_USAGE = 2;

const EXIT_BY_CODE = {
  E_SCHEMA: EXIT_REJECTED,
  E_MEMORY: EXIT_USAGE,
  E_REPO: EXIT_USAGE,
  E_REVISION: EXIT_USAGE,
  E_USAGE: EXIT_USAGE,
  E_WRITE: EXIT_USAGE,
};

function parseCli(argv) {
  const options = { json: false, root: undefined, repo: undefined, out: undefined, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--root') { options.root = argv[i + 1]; i += 1; continue; }
    if (arg === '--repo') { options.repo = argv[i + 1]; i += 1; continue; }
    if (arg === '--out') { options.out = argv[i + 1]; i += 1; continue; }
    if (arg === '--apply') { options.apply = true; continue; }
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
    return EXIT_USAGE;
  };
  if (command === 'run') {
    if (options.root === undefined || options.repo === undefined || options.out === undefined) {
      return fail('E_USAGE', 'Obavezni: --root, --repo i --out');
    }
    try {
      const result = nremRun({ memoryRoot: options.root, repo: options.repo, out: options.out });
      emit(options.json, result);
      return EXIT_OK;
    } catch (error) {
      if (error instanceof MemoryError && error.code === 'E_SCHEMA') {
        emit(true, { ok: false, error: { code: 'E_SCHEMA', message: error.message } });
        return EXIT_REJECTED;
      }
      if (!(error instanceof NremError)) throw error;
      emit(true, { ok: false, error: { code: error.code, message: error.message } });
      return EXIT_BY_CODE[error.code] ?? EXIT_USAGE;
    }
  }
  if (command !== 'audit') return fail('E_USAGE', 'Nepoznata komanda: ' + String(command));
  if (options.root === undefined || options.repo === undefined) return fail('E_USAGE', 'Obavezni: --root i --repo');
  try {
    const audit = nremAudit({ memoryRoot: options.root, repo: options.repo });
    if (!options.apply) {
      emit(options.json, audit);
      return EXIT_OK;
    }
    const { applied, skipped } = applyStale({ memoryRoot: options.root, audit });
    emit(options.json, { audit, applied, skipped });
    return EXIT_OK;
  } catch (error) {
    if (error instanceof MemoryError && error.code === 'E_SCHEMA') {
      emit(true, { ok: false, error: { code: 'E_SCHEMA', message: error.message } });
      return EXIT_REJECTED;
    }
    if (!(error instanceof NremError)) throw error;
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
