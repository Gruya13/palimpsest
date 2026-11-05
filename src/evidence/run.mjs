/**
 * Dokazni motor — operacija run.
 *
 * Izvršava argv na zamrznutoj reviziji u privremenom detached git worktree-u
 * i vraća verdikt izvršavanja. Timeout, greška pokretanja i prekoračen izlaz
 * daju 'unexecuted' i blokiraju kapiju; neuspeh komande daje 'failed'.
 *
 */
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUN_VERDICTS = ['ok', 'failed', 'unexecuted'];

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_ERROR = 2;
export const EXIT_UNEXECUTED = 4;

const HEX40 = /^[0-9a-f]{40}$/;
const DEFAULT_TIMEOUT = 120000;
const MAX_TIMEOUT = 3600000;
const DEFAULT_MAX_OUTPUT = 1048576;

/** Greška ulaza/okruženja operacije run. */
export class RunError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RunError';
    this.code = code;
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 60000,
  }).trim();
}

function repoRootOf(repo) {
  if (typeof repo !== 'string' || repo === '') throw new RunError('E_REPO', 'repo je obavezan');
  const abs = path.resolve(repo);
  try {
    return runGit(['rev-parse', '--show-toplevel'], abs);
  } catch {
    throw new RunError('E_REPO', 'repo nije git radno stablo: ' + abs);
  }
}

function assertRevision(root, revision) {
  if (typeof revision !== 'string' || !HEX40.test(revision)) {
    throw new RunError('E_REVISION', 'revision mora biti pun git SHA (40 lowercase hex)');
  }
  try {
    runGit(['cat-file', '-e', revision + '^{commit}'], root);
  } catch {
    throw new RunError('E_REVISION', 'revizija ne postoji: ' + revision);
  }
}

function assertArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) throw new RunError('E_ARGV', 'argv mora biti neprazan niz');
  for (const item of argv) {
    if (typeof item !== 'string') {
      throw new RunError('E_ARGV', 'svaki argv element mora biti string');
    }
  }
}

function assertTimeout(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT) {
    throw new RunError('E_TIMEOUT', 'timeoutMs mora biti ceo broj u [1, ' + MAX_TIMEOUT + ']');
  }
}

function createWorktree(root, revision, worktreeRoot) {
  const base = typeof worktreeRoot === 'string' && worktreeRoot !== '' ? worktreeRoot : os.tmpdir();
  let dir;
  try {
    dir = mkdtempSync(path.join(base, 'palimpsest-run-'));
  } catch (error) {
    throw new RunError('E_WORKTREE', 'privremeni direktorijum ne može da se napravi: ' + error.message);
  }
  try {
    execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', dir, revision], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60000,
    });
  } catch (error) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* najbolji pokušaj */ }
    throw new RunError('E_WORKTREE', 'worktree revizije ne može da se napravi: ' + error.message);
  }
  return dir;
}

function removeWorktree(root, dir) {
  try {
    execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', dir], {
      stdio: 'ignore',
      timeout: 60000,
    });
  } catch { /* worktree možda već nije registrovan */ }
  try {
    execFileSync('git', ['-C', root, 'worktree', 'prune'], { stdio: 'ignore', timeout: 60000 });
  } catch { /* najbolji pokušaj */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* najbolji pokušaj */ }
}

function decideVerdict(state) {
  if (state.timedOut || state.outputLimitExceeded || state.errorCode !== null) return 'unexecuted';
  if (state.signal !== null) return 'failed';
  if (state.exitCode === 0) return 'ok';
  return 'failed';
}

/**
 * Izvrši argv na reviziji u izolovanom worktree-u. Nikad ne baca zbog ishoda
 * komande; baca RunError samo za nevalidan ulaz/okruženje.
 */
export async function runCommand(options = {}) {
  const {
    repo,
    revision,
    argv,
    timeoutMs = DEFAULT_TIMEOUT,
    env = {},
    maxOutputBytes = DEFAULT_MAX_OUTPUT,
    worktreeRoot,
    now = () => new Date().toISOString(),
  } = options;

  const root = repoRootOf(repo);
  assertRevision(root, revision);
  assertArgv(argv);
  assertTimeout(timeoutMs);
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new RunError('E_ARGV', 'maxOutputBytes mora biti ceo broj >= 1');
  }

  const executedAt = now();
  const started = Date.now();
  const dir = createWorktree(root, revision, worktreeRoot);
  const childEnv = Object.assign({ PATH: process.env.PATH ?? '' }, isPlainObject(env) ? env : {});

  let stdoutBuffer = Buffer.alloc(0);
  let stderrBuffer = Buffer.alloc(0);
  let timedOut = false;
  let outputLimitExceeded = false;
  let spawnErrorCode = null;

  try {
    const outcome = await new Promise(resolve => {
      let child;
      try {
        child = spawn(argv[0], argv.slice(1), {
          cwd: dir,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
        });
      } catch (error) {
        resolve({ exitCode: null, signal: null, errorCode: (error && error.code) || 'E_SPAWN' });
        return;
      }

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch { /* proces je možda već izašao */ }
      }, timeoutMs);

      const collect = (target) => chunk => {
        if (outputLimitExceeded) return;
        const current = target === 'stdout' ? stdoutBuffer : stderrBuffer;
        const next = Buffer.concat([current, chunk]);
        if (next.length > maxOutputBytes) {
          outputLimitExceeded = true;
          if (target === 'stdout') stdoutBuffer = next; else stderrBuffer = next;
          try { child.kill('SIGKILL'); } catch { /* proces je možda već izašao */ }
          return;
        }
        if (target === 'stdout') stdoutBuffer = next; else stderrBuffer = next;
      };
      child.stdout.on('data', collect('stdout'));
      child.stderr.on('data', collect('stderr'));
      child.on('error', error => { spawnErrorCode = (error && error.code) || 'E_SPAWN'; });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ exitCode: code, signal: signal, errorCode: spawnErrorCode });
      });
    });

    const durationMs = Date.now() - started;
    const state = {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      errorCode: outcome.errorCode,
      timedOut,
      outputLimitExceeded,
    };
    return {
      revision,
      argv: [...argv],
      command: argv.join(' '),
      cwd: dir,
      exitCode: state.exitCode,
      signal: state.signal,
      timedOut: state.timedOut,
      outputLimitExceeded: state.outputLimitExceeded,
      errorCode: state.errorCode,
      durationMs,
      stdoutBytes: stdoutBuffer.length,
      stderrBytes: stderrBuffer.length,
      outputSha256: sha256(stdoutBuffer),
      verdict: decideVerdict(state),
      stdout: stdoutBuffer.toString('utf8'),
      stderr: stderrBuffer.toString('utf8'),
      executedAt,
    };
  } finally {
    removeWorktree(root, dir);
  }
}

/** Kao runCommand, ali bez stdout/stderr — polja spremna za checks[] omotača. */
export async function runCheck(options = {}) {
  const result = await runCommand(options);
  const { stdout, stderr, ...check } = result;
  return check;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_BY_CODE = {
  E_REPO: EXIT_ERROR,
  E_REVISION: EXIT_ERROR,
  E_ARGV: EXIT_ERROR,
  E_TIMEOUT: EXIT_ERROR,
  E_WORKTREE: EXIT_ERROR,
  E_USAGE: EXIT_ERROR,
};

function parseCli(argv) {
  const options = { repo: undefined, revision: undefined, timeoutMs: DEFAULT_TIMEOUT, env: {}, json: false };
  const commandArgv = [];
  let afterSeparator = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (afterSeparator) { commandArgv.push(arg); continue; }
    if (arg === '--') { afterSeparator = true; continue; }
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--repo') { options.repo = argv[i + 1]; i += 1; continue; }
    if (arg === '--revision') { options.revision = argv[i + 1]; i += 1; continue; }
    if (arg === '--timeout') { options.timeoutMs = Number(argv[i + 1]); i += 1; continue; }
    if (arg === '--env') {
      const pair = argv[i + 1];
      i += 1;
      const index = typeof pair === 'string' ? pair.indexOf('=') : -1;
      if (index > 0) options.env[pair.slice(0, index)] = pair.slice(index + 1);
      continue;
    }
  }
  return { options, commandArgv };
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

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === 'help') {
    process.stdout.write('Upotreba: run.mjs run --repo <repo> --revision <sha> [--timeout <ms>] [--env K=V]... [--json] -- <argv...>\n');
    return EXIT_ERROR;
  }
  if (command !== 'run') {
    emit(rest.includes('--json'), { ok: false, error: { code: 'E_USAGE', message: 'Nepoznata komanda: ' + command } });
    return EXIT_ERROR;
  }
  const { options, commandArgv } = parseCli(rest);
  if (options.repo === undefined || options.revision === undefined || commandArgv.length === 0) {
    emit(options.json, { ok: false, error: { code: 'E_USAGE', message: 'Obavezni: --repo, --revision i argv posle --' } });
    return EXIT_ERROR;
  }
  try {
    const result = await runCommand({
      repo: options.repo,
      revision: options.revision,
      argv: commandArgv,
      timeoutMs: options.timeoutMs,
      env: options.env,
    });
    emit(options.json, result);
    return result.verdict === 'ok' ? EXIT_OK : result.verdict === 'failed' ? EXIT_FAILED : EXIT_UNEXECUTED;
  } catch (error) {
    if (!(error instanceof RunError)) throw error;
    emit(options.json, { ok: false, error: { code: error.code, message: error.message } });
    return EXIT_BY_CODE[error.code] ?? EXIT_ERROR;
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write((error && error.stack ? error.stack : String(error)) + '\n');
    process.exitCode = EXIT_ERROR;
  });
}
