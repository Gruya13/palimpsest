/**
 * Dokazni motor — operacija stale.
 *
 * Održava 'stale' polje dokaznog omotača: kad revizija odmakne, dokaz se
 * označava kao zastareo; kad se revizija vrati, oznaka se skida. Ovo je jedina
 * operacija motora koja upisuje u omotač — i to samo polje 'stale'.
 *
 */
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeEnvelope, validateEnvelope } from './envelope.mjs';

export const STALE_STATUSES = ['ok', 'stale'];

export const EXIT_OK = 0;
export const EXIT_STALE = 2;
export const EXIT_ERROR = 3;

const HEX40 = /^[0-9a-f]{40}$/;

/** Greška operacije stale. */
export class StaleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StaleError';
    this.code = code;
  }
}

function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30000,
  }).trim();
}

function repoRootOf(repo) {
  if (typeof repo !== 'string' || repo === '') throw new StaleError('E_REPO', 'repo je obavezan');
  try {
    return runGit(['-C', repo, 'rev-parse', '--show-toplevel'], process.cwd());
  } catch {
    throw new StaleError('E_REPO', 'repo nije git radno stablo: ' + path.resolve(repo));
  }
}

function resolveAt(root, at) {
  if (at === null || at === undefined) {
    try {
      return runGit(['-C', root, 'rev-parse', 'HEAD'], process.cwd());
    } catch {
      throw new StaleError('E_AT', 'repo nema HEAD reviziju');
    }
  }
  if (typeof at !== 'string' || !HEX40.test(at)) {
    throw new StaleError('E_AT', 'at mora biti pun git SHA (40 lowercase hex) ili null');
  }
  try {
    runGit(['-C', root, 'cat-file', '-e', at + '^{commit}'], process.cwd());
  } catch {
    throw new StaleError('E_AT', 'at revizija ne postoji: ' + at);
  }
  return at;
}

function readEnvelope(envelopePath) {
  if (typeof envelopePath !== 'string' || envelopePath === '') {
    throw new StaleError('E_ENVELOPE', 'putanja omotača je obavezna');
  }
  let stat;
  try {
    stat = statSync(envelopePath);
  } catch {
    throw new StaleError('E_ENVELOPE', 'omotač ne postoji: ' + path.resolve(envelopePath));
  }
  if (!stat.isFile()) throw new StaleError('E_ENVELOPE', 'omotač nije regularan fajl: ' + path.resolve(envelopePath));
  let text;
  try {
    text = readFileSync(envelopePath, 'utf8');
  } catch (error) {
    throw new StaleError('E_ENVELOPE', 'omotač se ne može pročitati: ' + error.message);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new StaleError('E_SCHEMA', 'omotač nije validan JSON: ' + error.message);
  }
  const validation = validateEnvelope(value);
  if (!validation.ok) {
    throw new StaleError('E_SCHEMA', 'omotač ne prolazi šemu v1: ' + validation.errors.map(e => e.code + '@' + e.path).join(', '));
  }
  return value;
}

function writeEnvelopeAtomically(envelopePath, value) {
  const temporary = path.join(
    path.dirname(envelopePath),
    '.' + path.basename(envelopePath) + '.' + process.pid + '.tmp',
  );
  try {
    writeFileSync(temporary, serializeEnvelope(value), 'utf8');
    renameSync(temporary, envelopePath);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* najbolji pokušaj */ }
    throw new StaleError('E_WRITE', 'omotač nije upisan: ' + error.message);
  }
}

/**
 * Održi stale oznaku omotača za reviziju 'at'. Sinhrona; read-only kad se
 * oznaka ne menja.
 */
export function markStale(envelopePath, options = {}) {
  const { repo, at = null, now = () => new Date().toISOString() } = options;
  const checkedAt = now();
  const value = readEnvelope(envelopePath);
  const root = repoRootOf(repo);
  const atRevision = resolveAt(root, at);

  const desired = atRevision !== value.revision;
  const current = value.stale === true;
  const result = {
    status: desired ? 'stale' : 'ok',
    stale: desired,
    changed: false,
    at: atRevision,
    revision: value.revision,
    checkedAt,
  };
  if (current === desired) return result;

  writeEnvelopeAtomically(envelopePath, Object.assign({}, value, { stale: desired }));
  result.changed = true;
  return result;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseCli(argv) {
  const options = { json: false, repo: undefined, at: null };
  let envelopePath;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--repo') { options.repo = argv[i + 1]; i += 1; continue; }
    if (arg === '--at') { options.at = argv[i + 1]; i += 1; continue; }
    if (arg.startsWith('--')) continue;
    if (envelopePath === undefined) envelopePath = arg;
  }
  return { options, envelopePath };
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
  const { options, envelopePath } = parseCli(rest);
  if (command !== 'mark') {
    emit(true, { ok: false, error: { code: 'E_USAGE', message: 'Nepoznata komanda: ' + String(command) } });
    return EXIT_ERROR;
  }
  if (envelopePath === undefined) {
    emit(true, { ok: false, error: { code: 'E_USAGE', message: 'Nedostaje putanja omotača' } });
    return EXIT_ERROR;
  }
  try {
    const value = markStale(envelopePath, { repo: options.repo, at: options.at });
    emit(options.json, value);
    return value.status === 'ok' ? EXIT_OK : EXIT_STALE;
  } catch (error) {
    if (!(error instanceof StaleError)) throw error;
    emit(true, { ok: false, error: { code: error.code, message: error.message } });
    return EXIT_ERROR;
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write((error && error.stack ? error.stack : String(error)) + '\n');
    process.exitCode = EXIT_ERROR;
  }
}
