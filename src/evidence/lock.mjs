/**
 * Dokazni motor — operacija lock.
 *
 * Zamrzava artefakt: sha256 bajtova + git revizija koja ga je poslednja
 * menjala + git autor te revizije. Provera (verify) vraća locked/changed/
 * unlocked/unproven — bez izvršavanja i bez pisanja.
 *
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LOCK_VERSION = 1;
export const EXIT_LOCKED = 0;
export const EXIT_CHANGED = 1;
export const EXIT_UNLOCKED = 2;
export const EXIT_ERROR = 3;
export const EXIT_UNPROVEN = 4;

/** Greška operacije lock: mašinski čitljiv kod, ljudska poruka. */
export class LockError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LockError';
    this.code = code;
  }
}

const LOCK_FIELDS = [
  'lockVersion', 'artifactSha256', 'artifactFile', 'gitRevision',
  'gitRel', 'gitAuthor', 'lockedBy', 'lockedAt', 'relocks',
];
const RELOCK_FIELDS = ['by', 'reason', 'at', 'previousSha256', 'previousGitRevision'];
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ── pomoćne funkcije ────────────────────────────────────────────────────────

function sha256Bytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sha256File(abs) {
  return sha256Bytes(readFileSync(abs));
}

function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 15000,
  }).trim();
}

function gitRootOf(dir) {
  try {
    return runGit(['rev-parse', '--show-toplevel'], dir);
  } catch {
    return null;
  }
}

function rootRelative(root, abs) {
  const rel = path.relative(root, abs);
  return rel.split(path.sep).join('/');
}

function resolveArtifact(file, cwd) {
  if (typeof file !== 'string' || file === '') throw new LockError('E_FILE', 'Putanja artefakta je obavezna');
  const base = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
  return path.resolve(base, file);
}

function isRegularFile(abs) {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function addError(errors, pathName, code, message) {
  errors.push({ path: pathName, code, message });
}

function isIsoUtc(value) {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

// ── validacija zapisa ───────────────────────────────────────────────────────

function checkString(errors, value, field, min, max) {
  if (typeof value !== 'string') {
    addError(errors, field, 'E_TYPE', 'Očekivan string: ' + field);
    return;
  }
  if (value.length < min || value.length > max) {
    addError(errors, field, 'E_RANGE', 'Dužina van granica [' + min + ', ' + max + ']: ' + field);
  }
}

function checkHash(errors, value, field, length) {
  if (typeof value !== 'string') {
    addError(errors, field, 'E_TYPE', 'Očekivan heks string: ' + field);
    return;
  }
  const re = length === 40 ? HEX40 : HEX64;
  if (!re.test(value)) {
    addError(errors, field, 'E_HASH', 'Očekivan ' + length + ' lowercase hex: ' + field);
  }
}

/** Validacija lock zapisa v1. Ne baca; vraća sve nalaze. */
export function validateLock(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    addError(errors, '$', 'E_NOT_OBJECT', 'Lock zapis mora biti JSON objekat');
    return { ok: false, errors };
  }
  for (const key of Object.keys(value)) {
    if (!LOCK_FIELDS.includes(key)) addError(errors, key, 'E_UNKNOWN_FIELD', 'Polje nije deo šeme v1: ' + key);
  }
  for (const field of LOCK_FIELDS) {
    if (!hasOwn(value, field) || value[field] === undefined || value[field] === null) {
      addError(errors, field, 'E_MISSING', 'Obavezno polje nedostaje ili je null: ' + field);
    }
  }
  if (hasOwn(value, 'lockVersion') && value.lockVersion !== undefined && value.lockVersion !== null) {
    if (typeof value.lockVersion !== 'number' || !Number.isInteger(value.lockVersion)) {
      addError(errors, 'lockVersion', 'E_TYPE', 'lockVersion mora biti ceo broj');
    } else if (value.lockVersion !== LOCK_VERSION) {
      addError(errors, 'lockVersion', 'E_ENUM', 'Podržan je samo lockVersion ' + LOCK_VERSION);
    }
  }
  if (hasOwn(value, 'artifactSha256') && value.artifactSha256 != null) checkHash(errors, value.artifactSha256, 'artifactSha256', 64);
  if (hasOwn(value, 'artifactFile') && value.artifactFile != null) checkString(errors, value.artifactFile, 'artifactFile', 1, 1024);
  if (hasOwn(value, 'gitRevision') && value.gitRevision != null) checkHash(errors, value.gitRevision, 'gitRevision', 40);
  if (hasOwn(value, 'gitRel') && value.gitRel != null) checkString(errors, value.gitRel, 'gitRel', 1, 1024);
  if (hasOwn(value, 'gitAuthor') && value.gitAuthor != null) checkString(errors, value.gitAuthor, 'gitAuthor', 1, 64);
  if (hasOwn(value, 'lockedBy') && value.lockedBy != null) checkString(errors, value.lockedBy, 'lockedBy', 1, 64);
  if (hasOwn(value, 'lockedAt') && value.lockedAt != null) {
    if (typeof value.lockedAt !== 'string') addError(errors, 'lockedAt', 'E_TYPE', 'lockedAt mora biti ISO string');
    else if (!isIsoUtc(value.lockedAt)) addError(errors, 'lockedAt', 'E_ISO', 'lockedAt mora biti tačan Date#toISOString() format');
  }
  if (hasOwn(value, 'relocks') && value.relocks !== undefined && value.relocks !== null) {
    if (!Array.isArray(value.relocks)) {
      addError(errors, 'relocks', 'E_TYPE', 'relocks mora biti niz');
    } else {
      value.relocks.forEach((entry, index) => validateRelock(errors, entry, 'relocks[' + index + ']'));
    }
  }
  if (typeof value.gitRel === 'string' && typeof value.artifactFile === 'string' && value.gitRel !== value.artifactFile) {
    addError(errors, 'gitRel', 'E_MISMATCH', 'gitRel mora biti jednak artifactFile');
  }
  if (typeof value.gitAuthor === 'string' && typeof value.lockedBy === 'string' && value.gitAuthor !== value.lockedBy) {
    addError(errors, 'lockedBy', 'E_MISMATCH', 'lockedBy mora biti jednak gitAuthor');
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validateRelock(errors, entry, prefix) {
  if (!isPlainObject(entry)) {
    addError(errors, prefix, 'E_TYPE', 'Relock zapis mora biti objekat');
    return;
  }
  for (const key of Object.keys(entry)) {
    if (!RELOCK_FIELDS.includes(key)) addError(errors, prefix + '.' + key, 'E_UNKNOWN_FIELD', 'Polje nije deo relock šeme: ' + key);
  }
  for (const field of RELOCK_FIELDS) {
    if (!hasOwn(entry, field) || entry[field] === undefined || entry[field] === null) {
      addError(errors, prefix + '.' + field, 'E_MISSING', 'Obavezno polje nedostaje ili je null: ' + field);
    }
  }
  if (hasOwn(entry, 'by') && entry.by != null) checkString(errors, entry.by, prefix + '.by', 1, 64);
  if (hasOwn(entry, 'reason') && entry.reason != null) checkString(errors, entry.reason, prefix + '.reason', 1, 500);
  if (hasOwn(entry, 'at') && entry.at != null) {
    if (typeof entry.at !== 'string') addError(errors, prefix + '.at', 'E_TYPE', 'at mora biti ISO string');
    else if (!isIsoUtc(entry.at)) addError(errors, prefix + '.at', 'E_ISO', 'at mora biti tačan Date#toISOString() format');
  }
  if (hasOwn(entry, 'previousSha256') && entry.previousSha256 != null) checkHash(errors, entry.previousSha256, prefix + '.previousSha256', 64);
  if (hasOwn(entry, 'previousGitRevision') && entry.previousGitRevision != null) checkHash(errors, entry.previousGitRevision, prefix + '.previousGitRevision', 40);
}

// ── sidecar ─────────────────────────────────────────────────────────────────

/** Putanja lock sidecara za dati artefakt. */
export function lockPathFor(file) {
  return file + '.lock.json';
}

/**
 * Pročitaj lock zapis za artefakt. Vraća undefined kad sidecar ne postoji;
 * baca kad postoji ali nije čitljiv ili nije JSON.
 */
export function readLock(file) {
  const abs = resolveArtifact(file);
  const sidecar = lockPathFor(abs);
  if (!existsSync(sidecar)) return undefined;
  let stat;
  try {
    stat = statSync(sidecar);
  } catch (error) {
    throw new LockError('E_LOCK', 'Lock sidecar nije čitljiv: ' + sidecar + ' (' + error.message + ')');
  }
  if (!stat.isFile()) throw new LockError('E_LOCK', 'Lock sidecar nije regularan fajl: ' + sidecar);
  let text;
  try {
    text = readFileSync(sidecar, 'utf8');
  } catch (error) {
    throw new LockError('E_LOCK', 'Lock sidecar nije čitljiv: ' + sidecar + ' (' + error.message + ')');
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new LockError('E_LOCK', 'Lock sidecar nije validan JSON: ' + sidecar + ' (' + error.message + ')');
  }
}

function writeLockAtomically(abs, lock) {
  const sidecar = lockPathFor(abs);
  const temporary = path.join(path.dirname(sidecar), '.' + path.basename(sidecar) + '.' + process.pid + '.tmp');
  writeFileSync(temporary, JSON.stringify(lock, null, 2) + '\n', 'utf8');
  try {
    renameSync(temporary, sidecar);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* najbolji pokušaj */ }
    throw new LockError('E_WRITE', 'Lock zapis nije upisan: ' + sidecar + ' (' + error.message + ')');
  }
}

// ── git provenijencija ──────────────────────────────────────────────────────

function isTracked(root, rel) {
  try {
    runGit(['ls-files', '--error-unmatch', '--', rel], root);
    return true;
  } catch {
    return false;
  }
}

function isClean(root, rel) {
  try {
    return runGit(['status', '--porcelain', '--', rel], root) === '';
  } catch {
    return false;
  }
}

function lastRevisionFor(root, rel) {
  try {
    const value = runGit(['log', '-1', '--format=%H', '--', rel], root);
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

function lastAuthorFor(root, rel) {
  try {
    const value = runGit(['log', '-1', '--format=%an', '--', rel], root);
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

// ── operacija lock ──────────────────────────────────────────────────────────

/**
 * Zamrzni artefakt. Vraća lock zapis; baca LockError sa kodom iz spec.
 */
export function lockArtifact(file, options = {}) {
  const { by, reason = '', relock = false, now = () => new Date().toISOString(), cwd } = options;
  if (typeof by !== 'string' || by.length < 1 || by.length > 64) {
    throw new LockError('E_BY', 'Autora (by) mora biti ne-prazan string do 64 znaka');
  }
  const abs = resolveArtifact(file, cwd);
  if (!isRegularFile(abs)) throw new LockError('E_FILE', 'Artefakt ne postoji ili nije regularan fajl: ' + abs);

  const root = gitRootOf(path.dirname(abs));
  if (root === null) throw new LockError('E_NOGIT', 'Artefakt nije u git radnom stablu: ' + abs);
  const rel = rootRelative(root, abs);

  if (!isTracked(root, rel)) throw new LockError('E_UNCOMMITTED', 'Artefakt nije commitovan (untracked): ' + rel);
  if (!isClean(root, rel)) throw new LockError('E_UNCOMMITTED', 'Artefakt ima nekomitovanih izmena: ' + rel);

  const revision = lastRevisionFor(root, rel);
  if (revision === null) throw new LockError('E_UNCOMMITTED', 'Artefakt nema nijednu reviziju: ' + rel);
  const author = lastAuthorFor(root, rel);
  if (author !== by) throw new LockError('E_AUTHOR', 'Git autor poslednje izmene je "' + author + '", ne "' + by + '"');

  const artifactSha256 = sha256File(abs);
  const at = now();

  let existing;
  try {
    existing = readLock(abs);
  } catch (error) {
    throw new LockError('E_LOCKED', 'Postojeći lock nije čitljiv: ' + error.message);
  }

  if (existing !== undefined) {
    const validation = validateLock(existing);
    if (!validation.ok) throw new LockError('E_LOCKED', 'Postojeći lock nije validan; potreban je ručni pregled');
    const same = existing.artifactSha256 === artifactSha256
      && existing.lockedBy === by
      && existing.gitRevision === revision;
    if (same) return existing;
    if (!relock) throw new LockError('E_LOCKED', 'Artefakt je već zaključan drugim sadržajem/vlasnikom/revizijom; potreban je relock');
    if (typeof reason !== 'string' || reason.length < 1 || reason.length > 500) {
      throw new LockError('E_REASON', 'Relock zahteva razlog (1–500 znakova)');
    }
    const next = {
      lockVersion: LOCK_VERSION,
      artifactSha256,
      artifactFile: rel,
      gitRevision: revision,
      gitRel: rel,
      gitAuthor: author,
      lockedBy: by,
      lockedAt: at,
      relocks: [
        ...(Array.isArray(existing.relocks) ? existing.relocks : []),
        {
          by,
          reason,
          at,
          previousSha256: existing.artifactSha256,
          previousGitRevision: existing.gitRevision,
        },
      ],
    };
    const nextValidation = validateLock(next);
    if (!nextValidation.ok) throw new LockError('E_LOCKED', 'Novi lock zapis nije validan');
    writeLockAtomically(abs, next);
    return next;
  }

  const created = {
    lockVersion: LOCK_VERSION,
    artifactSha256,
    artifactFile: rel,
    gitRevision: revision,
    gitRel: rel,
    gitAuthor: author,
    lockedBy: by,
    lockedAt: at,
    relocks: [],
  };
  const createdValidation = validateLock(created);
  if (!createdValidation.ok) throw new LockError('E_LOCKED', 'Novi lock zapis nije validan');
  writeLockAtomically(abs, created);
  return created;
}

// ── operacija verify ────────────────────────────────────────────────────────

function unproven(lock, sha256, git, code, message) {
  return {
    status: 'unproven',
    exitCode: EXIT_UNPROVEN,
    sha256,
    lock,
    git,
    reasons: [{ code, message }],
  };
}

/**
 * Proveri lock zapis. Read-only; ne menja ni artefakt ni sidecar.
 * Redosled: unlocked → lock-invalid → changed → git provenijencija.
 */
export function verifyLock(file, options = {}) {
  const { cwd } = options;
  const abs = resolveArtifact(file, cwd);
  const git = { root: null, rel: null, revision: null, author: null };

  let lock;
  let lockInvalid = false;
  try {
    lock = readLock(abs);
  } catch {
    lock = undefined;
    lockInvalid = true;
  }
  if (lock === undefined && !lockInvalid) {
    let sha = null;
    if (isRegularFile(abs)) sha = sha256File(abs);
    return { status: 'unlocked', exitCode: EXIT_UNLOCKED, sha256: sha, lock: undefined, git, reasons: [{ code: 'no-lock', message: 'Nema lock zapisa' }] };
  }
  if (lockInvalid) {
    return unproven(undefined, isRegularFile(abs) ? sha256File(abs) : null, git, 'lock-invalid', 'Lock zapis nije čitljiv ili nije validan JSON');
  }
  const validation = validateLock(lock);
  if (!validation.ok) {
    return unproven(lock, isRegularFile(abs) ? sha256File(abs) : null, git, 'lock-invalid', 'Lock zapis ne prolazi validaciju šeme');
  }
  if (!isRegularFile(abs)) {
    return { status: 'error', exitCode: EXIT_ERROR, sha256: null, lock, git, reasons: [{ code: 'artifact-missing', message: 'Artefakt ne postoji ili nije regularan fajl' }] };
  }

  const sha = sha256File(abs);
  if (sha !== lock.artifactSha256) {
    return { status: 'changed', exitCode: EXIT_CHANGED, sha256: sha, lock, git, reasons: [{ code: 'content-changed', message: 'Sadržaj artefakta se promenio' }] };
  }

  const root = gitRootOf(path.dirname(abs));
  if (root === null) return unproven(lock, sha, git, 'git-missing', 'Artefakt nije u git radnom stablu');
  git.root = root;
  const rel = rootRelative(root, abs);
  git.rel = rel;
  if (!isTracked(root, rel)) return unproven(lock, sha, git, 'git-missing', 'Artefakt nije commitovan (untracked): ' + rel);

  let revisionExists = true;
  try {
    runGit(['cat-file', '-e', lock.gitRevision + '^{commit}'], root);
  } catch {
    revisionExists = false;
  }
  if (!revisionExists) return unproven(lock, sha, git, 'revision-missing', 'Revizija iz locka ne postoji: ' + lock.gitRevision);
  git.revision = lock.gitRevision;

  let blob = null;
  try {
    blob = execFileSync('git', ['show', lock.gitRevision + ':' + lock.gitRel], {
      cwd: root,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
    });
  } catch {
    blob = null;
  }
  if (blob === null) return unproven(lock, sha, git, 'blob-mismatch', 'Revizija ne sadrži artefakt na putanji: ' + lock.gitRel);
  if (sha256Bytes(blob) !== lock.artifactSha256) return unproven(lock, sha, git, 'blob-mismatch', 'Hash bloba iz revizije se ne poklapa sa lock zapisom');

  let author = null;
  try {
    author = runGit(['show', '-s', '--format=%an', lock.gitRevision], root);
  } catch {
    author = null;
  }
  git.author = author;
  if (author !== lock.lockedBy) return unproven(lock, sha, git, 'author-mismatch', 'Autor revizije je "' + author + '", lock tvrdi "' + lock.lockedBy + '"');

  return { status: 'locked', exitCode: EXIT_LOCKED, sha256: sha, lock, git, reasons: [] };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_BY_CODE = {
  E_BY: 2,
  E_USAGE: 2,
  E_FILE: 1,
  E_NOGIT: 1,
  E_UNCOMMITTED: 1,
  E_AUTHOR: 1,
  E_LOCKED: 1,
  E_REASON: 1,
};

function parseArgs(argv) {
  const options = { json: false, relock: false, by: undefined, reason: '' };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--relock') { options.relock = true; continue; }
    if (arg === '--by') { options.by = argv[i + 1]; i += 1; continue; }
    if (arg === '--reason') { options.reason = argv[i + 1]; i += 1; continue; }
    if (arg === '--help') { options.help = true; continue; }
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
  const lines = [];
  if (value.error) lines.push('GREŠKA ' + value.error.code + ': ' + value.error.message);
  else if (value.lock) lines.push(JSON.stringify(value.lock, null, 2));
  else lines.push(JSON.stringify(value, null, 2));
  process.stdout.write(lines.join('\n') + '\n');
}

function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const { options, positional } = parseArgs(rest);
  const file = positional[0];

  if (command === undefined || command === '--help' || command === 'help') {
    process.stdout.write('Upotreba: lock.mjs <lock|verify|show> <artefakt> [--by <autor>] [--reason <tekst>] [--relock] [--json]\n');
    return EXIT_BY_CODE.E_USAGE;
  }
  if (command !== 'lock' && command !== 'verify' && command !== 'show') {
    emit(options.json, { ok: false, error: { code: 'E_USAGE', message: 'Nepoznata komanda: ' + command } });
    return EXIT_BY_CODE.E_USAGE;
  }
  if (file === undefined) {
    emit(options.json, { ok: false, error: { code: 'E_USAGE', message: 'Nedostaje putanja artefakta' } });
    return EXIT_BY_CODE.E_USAGE;
  }

  if (command === 'lock') {
    if (options.by === undefined) {
      emit(options.json, { ok: false, error: { code: 'E_USAGE', message: 'Nedostaje --by <autor>' } });
      return EXIT_BY_CODE.E_USAGE;
    }
    try {
      const lock = lockArtifact(file, { by: options.by, reason: options.reason, relock: options.relock });
      emit(options.json, { ok: true, lock });
      return EXIT_LOCKED;
    } catch (error) {
      if (!(error instanceof LockError)) throw error;
      emit(options.json, { ok: false, error: { code: error.code, message: error.message } });
      return EXIT_BY_CODE[error.code] ?? EXIT_ERROR;
    }
  }

  if (command === 'verify') {
    try {
      const result = verifyLock(file, {});
      emit(options.json, result);
      return result.exitCode;
    } catch (error) {
      if (!(error instanceof LockError)) throw error;
      emit(options.json, { ok: false, error: { code: error.code, message: error.message } });
      return EXIT_ERROR;
    }
  }

  try {
    const lock = readLock(file);
    if (lock === undefined) {
      emit(options.json, { ok: false, error: { code: 'E_LOCKED', message: 'Nema lock zapisa' } });
      return EXIT_UNLOCKED;
    }
    emit(options.json, lock);
    return EXIT_LOCKED;
  } catch (error) {
    if (!(error instanceof LockError)) throw error;
    emit(options.json, { ok: false, error: { code: error.code, message: error.message } });
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
