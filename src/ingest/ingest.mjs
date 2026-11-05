/**
 * C1 — ingest: izvor → proverena beleška.
 *
 * Raw izvor iz git revizije → izvorni dokaz ( omotač sa jednim "source"
 * check-om: artifact raw fajla + outputSha256 bajtova + revision) → kandidat u
 * memory/kandidati/ sa evidence na omotač. Kandidat ne ulazi u kanal; o njemu
 * odlučuje postojeći filter.
 *
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeEnvelope, validateEnvelope } from '../evidence/envelope.mjs';
import { listMemories, writeMemory, MEMORY_LEVELS } from '../memory/memory.mjs';

export const INGEST_VERSION = 1;
const HEX40 = /^[0-9a-f]{40}$/;
const CLAIM_MAX = 500;
const INGEST_IDENTITY = { vendor: 'palimpsest-ingest', thread: 'ingest', model: null };

/** Greška ingest-a (nevalidan ulaz). */
export class IngestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IngestError';
    this.code = code;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
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
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
}

function isRelativePath(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (value.startsWith('/') || value.startsWith(':')) return false;
  const parts = value.split('/');
  if (parts.some(part => part === '..' || part === '')) return false;
  return true;
}

function assertInputs(input) {
  const { repo, revision, sourceRel, claim, memoryRoot } = input;
  if (typeof repo !== 'string' || repo === '') throw new IngestError('E_USAGE', 'repo je obavezan');
  if (!gitTry(repo, ['rev-parse', '--show-toplevel'])) throw new IngestError('E_REPO', 'repo nije git radno stablo: ' + path.resolve(repo));
  if (typeof revision !== 'string' || !HEX40.test(revision) || !gitTry(repo, ['cat-file', '-e', revision + '^{commit}'])) {
    throw new IngestError('E_REVISION', 'revision ne postoji u repou: ' + String(revision));
  }
  if (typeof claim !== 'string' || claim.trim() === '' || claim.length > CLAIM_MAX) {
    throw new IngestError('E_USAGE', 'claim mora biti string 1–' + CLAIM_MAX);
  }
  if (!isRelativePath(sourceRel)) throw new IngestError('E_USAGE', 'sourceRel mora biti relativna putanja');
  if (typeof memoryRoot !== 'string' || memoryRoot === '') throw new IngestError('E_USAGE', 'memoryRoot je obavezan');
}

function nextCandidateId(memoryRoot) {
  let records;
  try {
    records = listMemories({ memoryRoot, level: 'kandidati' });
  } catch (error) {
    throw new IngestError('E_SCHEMA', 'memorija nije validna: ' + error.message);
  }
  let max = 0;
  for (const record of records) {
    const value = Number(record.id.slice('MEM-'.length));
    if (Number.isInteger(value) && value > max) max = value;
  }
  return 'MEM-' + String(max + 1).padStart(3, '0');
}

/** Ingest jednog izvora u memoriju; sinhrona, deterministička. */
export function ingestSource(options = {}) {
  const { repo, revision, sourceRel, claim, kind = 'convention', scope, falsifier, memoryRoot, now = () => new Date().toISOString() } = options;
  assertInputs({ repo, revision, sourceRel, claim, memoryRoot });
  if (!gitTry(repo, ['cat-file', '-e', revision + ':' + sourceRel])) {
    throw new IngestError('E_SOURCE', 'izvor ne postoji u reviziji: ' + sourceRel);
  }
  const bytes = execFileSync('git', ['-C', repo, 'show', revision + ':' + sourceRel], { encoding: null, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  const digest = sha256(bytes);
  const iso = now();
  const id = nextCandidateId(memoryRoot);
  const proofRel = 'proofs/ingest-' + id + '.json';
  const command = 'node -e "process.stdout.write(require(\'node:fs\').readFileSync(' + JSON.stringify(sourceRel) + '))"';
  const envelope = {
    version: 1,
    revision,
    claims: ['C1'],
    checks: [{
      kind: 'source', claim: 'C1', command, exitCode: 0, verdict: 'ok',
      artifact: { path: sourceRel, sha256: digest },
      outputSha256: digest, durationMs: 0, executedAt: iso,
    }],
    author: INGEST_IDENTITY,
    verifier: null,
    independence: 0,
    falsifier: null,
    lesson: null,
    stale: false,
  };
  const validation = validateEnvelope(envelope);
  if (validation.ok !== true) {
    throw new IngestError('E_SCHEMA', 'omotač nije validan: ' + JSON.stringify(validation));
  }
  const memory = {
    id, claim, scope, kind,
    evidence: proofRel,
    falsifier: falsifier ?? null,
    revision_bound: revision,
    status: 'consolidated',
    supersedes: [], superseded_by: [],
    used_count: 0, last_used: null, failed_with: [],
    owner_role: 'librarian',
  };
  let record;
  try {
    record = writeMemory({ memoryRoot, level: 'kandidati', memory, now: () => iso });
  } catch (error) {
    throw new IngestError('E_SCHEMA', 'kandidat nije upisan: ' + error.message);
  }
  const proofPath = path.join(repo, proofRel);
  try {
    mkdirSync(path.dirname(proofPath), { recursive: true });
    writeFileSync(proofPath, serializeEnvelope(envelope), 'utf8');
  } catch (error) {
    throw new IngestError('E_WRITE', 'omotač nije upisan: ' + error.message);
  }
  return {
    source: { path: sourceRel, sha256: digest, revision },
    proof: proofRel,
    memory: record,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_USAGE = 2;

function parseCli(argv) {
  const options = { json: false, repo: undefined, revision: undefined, source: undefined, claim: undefined, kind: 'convention', scope: undefined, falsifier: undefined, 'memory-root': undefined };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--repo') { options.repo = argv[i + 1]; i += 1; continue; }
    if (arg === '--revision') { options.revision = argv[i + 1]; i += 1; continue; }
    if (arg === '--source') { options.source = argv[i + 1]; i += 1; continue; }
    if (arg === '--claim') { options.claim = argv[i + 1]; i += 1; continue; }
    if (arg === '--kind') { options.kind = argv[i + 1]; i += 1; continue; }
    if (arg === '--scope') { options.scope = argv[i + 1]; i += 1; continue; }
    if (arg === '--falsifier') { options.falsifier = argv[i + 1]; i += 1; continue; }
    if (arg === '--memory-root') { options.memoryRoot = argv[i + 1]; i += 1; continue; }
    if (arg.startsWith('--')) continue;
    positional.push(arg);
  }
  return options;
}

function emit(json, value) {
  if (json) process.stdout.write(JSON.stringify(value) + '\n');
  else process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function fail(json, code, message) {
  emit(true, { ok: false, error: { code, message } });
  return EXIT_USAGE;
}

function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = parseCli(rest);
  if (command !== 'ingest') return fail(true, 'E_USAGE', 'Nepoznata komanda: ' + String(command));
  if (options.repo === undefined || options.revision === undefined || options.source === undefined
    || options.claim === undefined || options.memoryRoot === undefined) {
    return fail(options.json, 'E_USAGE', 'Obavezni: --repo, --revision, --source, --claim, --memory-root');
  }
  try {
    const result = ingestSource({
      repo: options.repo, revision: options.revision, sourceRel: options.source,
      claim: options.claim, kind: options.kind,
      scope: options.scope === undefined ? [] : [options.scope],
      falsifier: options.falsifier, memoryRoot: options.memoryRoot,
    });
    emit(options.json, result);
    return EXIT_OK;
  } catch (error) {
    if (!(error instanceof IngestError)) throw error;
    return fail(options.json, error.code, error.message);
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exitCode = main();
}
