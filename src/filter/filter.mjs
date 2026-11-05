/**
 * Filter šuma — pet determinističkih kapija pre upisa.
 *
 * Redosled: dokaz → opseg → konflikt → svežina → nezavisnost. Prva kapija koja
 * padne zaustavlja proveru i daje odluku. filterCandidate je read-only;
 * promoteCandidate menja memoriju samo na accept (kandidat → saznanje).
 *
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEnvelope, CheckError } from '../evidence/check.mjs';
import { independenceOf, INDEPENDENCE_THRESHOLD } from '../evidence/independence.mjs';
import { listMemories, MemoryError, readMemory } from '../memory/memory.mjs';

export const FILTER_GATES = ['dokaz', 'opseg', 'konflikt', 'svezina', 'nezavisnost'];
export const FILTER_DECISIONS = ['accept', 'question', 'reject', 'stale', 'weak'];

const EXIT_OK = 0;
const EXIT_REJECTED = 1;
const EXIT_USAGE = 2;

/** Greška filtera. */
export class FilterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FilterError';
    this.code = code;
  }
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
    throw new FilterError('E_MEMORY', 'memoryRoot je obavezan');
  }
  let stat;
  try {
    stat = statSync(memoryRoot);
  } catch {
    throw new FilterError('E_MEMORY', 'memoryRoot ne postoji: ' + path.resolve(memoryRoot));
  }
  if (!stat.isDirectory()) throw new FilterError('E_MEMORY', 'memoryRoot nije direktorijum');
}

function assertRepo(repo) {
  if (typeof repo !== 'string' || repo === '') throw new FilterError('E_REPO', 'repo je obavezan');
  let stat;
  try {
    stat = statSync(repo);
  } catch {
    throw new FilterError('E_REPO', 'repo ne postoji: ' + path.resolve(repo));
  }
  if (!stat.isDirectory()) throw new FilterError('E_REPO', 'repo nije direktorijum');
  if (!gitTry(repo, ['rev-parse', '--show-toplevel'])) {
    throw new FilterError('E_REPO', 'repo nije git radno stablo: ' + path.resolve(repo));
  }
}

function readCandidate(candidatePath) {
  if (typeof candidatePath !== 'string' || candidatePath === '') {
    throw new FilterError('E_FILTER', 'putanja kandidata je obavezna');
  }
  let stat;
  try {
    stat = statSync(candidatePath);
  } catch {
    throw new FilterError('E_FILTER', 'kandidat ne postoji: ' + path.resolve(candidatePath));
  }
  if (!stat.isFile()) throw new FilterError('E_FILTER', 'kandidat nije regularan fajl');
  try {
    return readMemory(candidatePath);
  } catch (error) {
    if (error instanceof MemoryError) {
      throw new FilterError('E_FILTER', 'kandidat nije validan zapis: ' + error.message);
    }
    throw error;
  }
}

function segmentPrefix(a, b) {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

function scopesOverlap(a, b) {
  return a.some(left => b.some(right => segmentPrefix(left, right)));
}

function dokazGate(candidate, repo) {
  if (candidate.evidence === null) return { decision: 'question', reason: 'no-evidence' };
  const evidencePath = path.resolve(repo, candidate.evidence);
  let check;
  try {
    check = checkEnvelope(evidencePath, { repo, at: candidate.revision_bound });
  } catch (error) {
    if (error instanceof CheckError) return { decision: 'question', reason: error.code };
    throw error;
  }
  if (check.status !== 'ok') {
    const reason = check.reasons.length > 0 ? check.reasons[0].code : check.status;
    return { decision: 'question', reason };
  }
 // Omotač je već pročitan i validiran kroz checkEnvelope; čitamo ga još jednom
 // samo za kapiju nezavisnosti (autor/verifikator).
  let envelope;
  try {
    envelope = JSON.parse(readFileSync(evidencePath, 'utf8'));
  } catch {
    envelope = null;
  }
  return { envelope };
}

function opsegGate(candidate, repo) {
 // scope se proverava na reviziji na koju je kandidat vezan.
  const revision = candidate.revision_bound === null || candidate.revision_bound === undefined
    ? 'HEAD' : candidate.revision_bound;
  for (const scopePath of candidate.scope) {
    if (!gitTry(repo, ['cat-file', '-e', revision + ':' + scopePath])) {
      return { decision: 'reject', reason: 'scope-missing' };
    }
  }
  return null;
}

function konfliktGate(candidate, memoryRoot) {
  const existing = [
    ...listMemories({ memoryRoot, level: 'saznanja' }),
    ...listMemories({ memoryRoot, level: 'pravila' }),
  ];
  const conflict = existing.find(item => item.kind === candidate.kind
    && item.claim !== candidate.claim
    && scopesOverlap(item.scope, candidate.scope));
  return conflict === undefined ? null : { decision: 'question', reason: 'conflict' };
}

function svezinaGate(candidate, repo) {
  if (candidate.revision_bound === null) return { decision: 'stale', reason: 'missing-revision' };
  if (!gitTry(repo, ['cat-file', '-e', candidate.revision_bound + '^{commit}'])) {
    return { decision: 'stale', reason: 'missing-revision' };
  }
  if (!gitTry(repo, ['merge-base', '--is-ancestor', candidate.revision_bound, 'HEAD'])) {
    return { decision: 'stale', reason: 'not-ancestor' };
  }
  return null;
}

function nezavisnostGate(envelope) {
 // ista matrica kao kapija verified, prag 2.
  if (envelope === null || envelope.verifier === null) {
    return { decision: 'weak', reason: 'not-independent' };
  }
  if (independenceOf(envelope.author, envelope.verifier) < INDEPENDENCE_THRESHOLD) {
    return { decision: 'weak', reason: 'not-independent' };
  }
  return null;
}

/**
 * Read-only filter: pet kapija u fiksnom redu. Vraća odluku i trag kapija.
 */
export function filterCandidate(options = {}) {
  const { memoryRoot, repo, candidatePath } = options;
  assertMemoryRoot(memoryRoot);
  assertRepo(repo);
  const candidate = readCandidate(candidatePath);

  let envelope = null;
  const steps = [
    () => {
      const result = dokazGate(candidate, repo);
      if (result === null || result.decision === 'question' || result.decision === 'reject'
        || result.decision === 'stale' || result.decision === 'weak') return result;
      envelope = result.envelope;
      return null;
    },
    () => opsegGate(candidate, repo),
    () => konfliktGate(candidate, memoryRoot),
    () => svezinaGate(candidate, repo),
    () => nezavisnostGate(envelope),
  ];
  const gates = {};
  let decision = 'accept';
  let reason = null;
  let gate = null;
  for (let index = 0; index < FILTER_GATES.length; index += 1) {
    const name = FILTER_GATES[index];
    if (gate !== null) { gates[name] = null; continue; }
    const outcome = steps[index]();
    if (outcome === null) {
      gates[name] = { ok: true, reason: null };
    } else {
      gates[name] = { ok: false, reason: outcome.reason };
      decision = outcome.decision;
      reason = outcome.reason;
      gate = name;
    }
  }
  return { decision, gate, reason, gates };
}

/**
 * Promocija: samo accept menja memoriju (kandidat se premešta u saznanja kao
 * consolidated, updated = now); ostale odluke ne menjaju ništa.
 */
export function promoteCandidate(options = {}) {
  const { memoryRoot, repo, candidatePath, now = () => new Date().toISOString() } = options;
  const result = filterCandidate({ memoryRoot, repo, candidatePath });
  if (result.decision !== 'accept') {
    return { decision: result.decision, promoted: false, gate: result.gate, reason: result.reason };
  }
  const candidate = readCandidate(candidatePath);
  const target = path.join(memoryRoot, 'saznanja', candidate.id + '.json');
  if (path.resolve(target) === path.resolve(candidatePath)) {
    throw new FilterError('E_FILTER', 'kandidat je već saznanje');
  }
  const record = { ...candidate, status: 'consolidated', updated: now() };
  try {
    writeFileSync(target, JSON.stringify(record, null, 2) + '\n', 'utf8');
    rmSync(candidatePath, { force: true });
  } catch (error) {
    throw new FilterError('E_WRITE', 'Promocija nije uspela: ' + error.message);
  }
  return { decision: 'accept', promoted: true, memory: record };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_BY_CODE = {
  E_FILTER: EXIT_USAGE,
  E_MEMORY: EXIT_USAGE,
  E_REPO: EXIT_USAGE,
  E_WRITE: EXIT_USAGE,
  E_USAGE: EXIT_USAGE,
};

function parseCli(argv) {
  const options = { json: false, root: undefined, repo: undefined };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--root') { options.root = argv[i + 1]; i += 1; continue; }
    if (arg === '--repo') { options.repo = argv[i + 1]; i += 1; continue; }
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
  if (command !== 'check' && command !== 'promote') return fail('E_USAGE', 'Nepoznata komanda: ' + String(command));
  const candidatePath = positional[0];
  if (candidatePath === undefined || options.root === undefined || options.repo === undefined) {
    return fail('E_USAGE', 'Obavezni: kandidat, --root i --repo');
  }
  try {
    const result = command === 'check'
      ? filterCandidate({ memoryRoot: options.root, repo: options.repo, candidatePath })
      : promoteCandidate({ memoryRoot: options.root, repo: options.repo, candidatePath });
    emit(options.json, result);
    return result.decision === 'accept' ? EXIT_OK : EXIT_REJECTED;
  } catch (error) {
    if (!(error instanceof FilterError)) throw error;
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
