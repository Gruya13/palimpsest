/**
 * Dokazni motor — operacija check.
 *
 * Validira dokazni omotač i proverava da li dokaz još važi za
 * reviziju 'at': OK / CHANGED / STALE / UNPROVEN. Ne izvršava ništa i ne menja
 * ni omotač ni repo.
 *
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEnvelope } from './envelope.mjs';

export const CHECK_STATUSES = ['ok', 'changed', 'stale', 'unproven'];

export const EXIT_OK = 0;
export const EXIT_CHANGED = 1;
export const EXIT_STALE = 2;
export const EXIT_ERROR = 3;
export const EXIT_UNPROVEN = 4;

const HEX40 = /^[0-9a-f]{40}$/;

/** Greška poziva/okruženja operacije check. */
export class CheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CheckError';
    this.code = code;
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function runGit(args, cwd, encoding = 'utf8') {
  return execFileSync('git', args, {
    cwd,
    encoding,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30000,
  });
}

function gitText(args, cwd) {
  return String(runGit(args, cwd)).trim();
}

function repoRootOf(repo) {
  if (typeof repo !== 'string' || repo === '') throw new CheckError('E_REPO', 'repo je obavezan');
  try {
    return gitText(['-C', repo, 'rev-parse', '--show-toplevel'], process.cwd());
  } catch {
    throw new CheckError('E_REPO', 'repo nije git radno stablo: ' + path.resolve(repo));
  }
}

function resolveAt(root, at) {
  if (at === null || at === undefined) {
    try {
      return gitText(['-C', root, 'rev-parse', 'HEAD'], process.cwd());
    } catch {
      throw new CheckError('E_AT', 'repo nema HEAD reviziju');
    }
  }
  if (typeof at !== 'string' || !HEX40.test(at)) {
    throw new CheckError('E_AT', 'at mora biti pun git SHA (40 lowercase hex) ili null');
  }
  try {
    runGit(['-C', root, 'cat-file', '-e', at + '^{commit}'], process.cwd());
  } catch {
    throw new CheckError('E_AT', 'at revizija ne postoji: ' + at);
  }
  return at;
}

function readEnvelope(envelopePath) {
  if (typeof envelopePath !== 'string' || envelopePath === '') {
    throw new CheckError('E_ENVELOPE', 'putanja omotača je obavezna');
  }
  let stat;
  try {
    stat = statSync(envelopePath);
  } catch {
    throw new CheckError('E_ENVELOPE', 'omotač ne postoji: ' + path.resolve(envelopePath));
  }
  if (!stat.isFile()) throw new CheckError('E_ENVELOPE', 'omotač nije regularan fajl: ' + path.resolve(envelopePath));
  let text;
  try {
    text = readFileSync(envelopePath, 'utf8');
  } catch (error) {
    throw new CheckError('E_ENVELOPE', 'omotač se ne može pročitati: ' + error.message);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { valid: false, value: null, revisionHint: null };
  }
  const hint = value !== null && typeof value === 'object' && typeof value.revision === 'string'
    && HEX40.test(value.revision) ? value.revision : null;
  const validation = validateEnvelope(value);
  if (!validation.ok) return { valid: false, value, revisionHint: hint };
  return { valid: true, value, revisionHint: hint };
}

function result(status, exitCode, at, revision, checkedAt, reasons) {
  return { status, exitCode, at, revision, checkedAt, reasons };
}

function reason(code, message) {
  return [{ code, message }];
}

/**
 * Proveri dokazni omotač za reviziju 'at'. Sinhrona; ne menja fajlove.
 * Redosled: envelope pristup → validnost → marked-stale → revision-missing →
 * revision-mismatch → artifact → unexecuted → failed → ok.
 */
export function checkEnvelope(envelopePath, options = {}) {
  const { repo, at = null, now = () => new Date().toISOString() } = options;
  const root = repoRootOf(repo);
  const atRevision = resolveAt(root, at);
  const checkedAt = now();
  const envelope = readEnvelope(envelopePath);

  if (!envelope.valid) {
    return result('unproven', EXIT_UNPROVEN, atRevision, envelope.revisionHint, checkedAt,
      reason('envelope-invalid', 'Omotač nije validan JSON ili ne prolazi šemu v1'));
  }
  const env = envelope.value;
  const revision = env.revision;

  if (env.stale === true) {
    return result('stale', EXIT_STALE, atRevision, revision, checkedAt,
      reason('marked-stale', 'Omotač je označen kao stale'));
  }

  try {
    runGit(['-C', root, 'cat-file', '-e', revision + '^{commit}'], process.cwd());
  } catch {
    return result('unproven', EXIT_UNPROVEN, atRevision, revision, checkedAt,
      reason('revision-missing', 'Revizija iz omotača ne postoji: ' + revision));
  }

  if (atRevision !== revision) {
    return result('stale', EXIT_STALE, atRevision, revision, checkedAt,
      reason('revision-mismatch', 'Omotač važi za drugu reviziju'));
  }

  for (const check of env.checks) {
    if (check.artifact === null) continue;
    const spec = atRevision + ':' + check.artifact.path;
    let objectType;
    try {
      objectType = gitText(['-C', root, 'cat-file', '-t', spec], process.cwd());
    } catch {
      return result('changed', EXIT_CHANGED, atRevision, revision, checkedAt,
        reason('artifact-missing', 'Artefakt ne postoji u reviziji: ' + check.artifact.path));
    }
    if (objectType !== 'blob') {
      return result('changed', EXIT_CHANGED, atRevision, revision, checkedAt,
        reason('artifact-changed', 'Artefakt nije fajl (blob): ' + check.artifact.path));
    }
    let blob;
    try {
      blob = runGit(['-C', root, 'show', spec], process.cwd(), null);
    } catch {
      return result('changed', EXIT_CHANGED, atRevision, revision, checkedAt,
        reason('artifact-missing', 'Artefakt ne postoji u reviziji: ' + check.artifact.path));
    }
    if (!Buffer.isBuffer(blob)) blob = Buffer.from(blob);
    if (sha256(blob) !== check.artifact.sha256) {
      return result('changed', EXIT_CHANGED, atRevision, revision, checkedAt,
        reason('artifact-changed', 'Hash artefakta se ne poklapa: ' + check.artifact.path));
    }
  }

  if (env.checks.some(check => check.verdict === 'unexecuted')) {
    return result('unproven', EXIT_UNPROVEN, atRevision, revision, checkedAt,
      reason('unexecuted-check', 'Dokaz sadrži neizvršenu proveru (O-16)'));
  }
  if (env.checks.some(check => check.verdict === 'failed')) {
    return result('unproven', EXIT_UNPROVEN, atRevision, revision, checkedAt,
      reason('failed-check', 'Dokaz sadrži oborena provera; tvrdnja nije dokazana'));
  }

  return result('ok', EXIT_OK, atRevision, revision, checkedAt, []);
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
  if (command !== 'check') {
    emit(options.json || true, {
      ok: false,
      error: { code: 'E_USAGE', message: 'Nepoznata komanda: ' + String(command) },
    });
    return EXIT_ERROR;
  }
  if (envelopePath === undefined) {
    emit(true, { ok: false, error: { code: 'E_USAGE', message: 'Nedostaje putanja omotača' } });
    return EXIT_ERROR;
  }
  try {
    const value = checkEnvelope(envelopePath, { repo: options.repo, at: options.at });
    emit(options.json, value);
    return value.exitCode;
  } catch (error) {
    if (!(error instanceof CheckError)) throw error;
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
