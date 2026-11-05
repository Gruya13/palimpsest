/**
 * Reprodukcija dokaza u svežem klonu.
 *
 * Za razliku od `run`, komanda se izvršava u **novom klonu**
 * (`git clone --no-local`) na tačnoj reviziji — nema lokalnih artefakata, keša
 * ni hardlinkova. Ishod je isti kao : ok / failed / unexecuted.
 * Logika je preneta iz Agent 2.0 `reproduce.mjs` (baseline 107dfb1).
 *
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HEX40 = /^[0-9a-f]{40}$/;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_OUTPUT_BYTES = 1048576;

/** Greška reprodukcije. */
export class ReproduceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReproduceError';
    this.code = code;
  }
}

function gitText(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000,
  }).trim();
}

function assertRepo(repo) {
  if (typeof repo !== 'string' || repo === '') throw new ReproduceError('E_REPO', 'repo je obavezan');
  let stat;
  try {
    stat = statSync(repo);
  } catch {
    throw new ReproduceError('E_REPO', 'repo ne postoji: ' + path.resolve(repo));
  }
  if (!stat.isDirectory()) throw new ReproduceError('E_REPO', 'repo nije direktorijum');
  try {
    gitText(repo, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new ReproduceError('E_REPO', 'repo nije git radno stablo: ' + path.resolve(repo));
  }
}

function assertRevision(repo, revision) {
  if (typeof revision !== 'string' || !HEX40.test(revision)) {
    throw new ReproduceError('E_REVISION', 'revision mora biti pun git SHA (40 lowercase hex)');
  }
  try {
    gitText(repo, ['cat-file', '-e', revision + '^{commit}']);
  } catch {
    throw new ReproduceError('E_REVISION', 'revision ne postoji u repou: ' + revision);
  }
}

function assertArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) throw new ReproduceError('E_ARGV', 'argv mora biti neprazan niz');
  for (const value of argv) {
    if (typeof value !== 'string' || value === '') throw new ReproduceError('E_ARGV', 'argv mora biti niz nepraznih stringova');
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeClone(repo, revision) {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'palimpsest-repro-'));
  const clone = path.join(parent, 'repo');
  try {
    execFileSync('git', ['clone', '--quiet', '--no-local', repo, clone], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 300000 });
    gitText(clone, ['checkout', '--quiet', '--detach', revision]);
    gitText(clone, ['remote', 'set-url', 'origin', path.resolve(repo)]);
  } catch (error) {
    rmSync(parent, { recursive: true, force: true });
    throw new ReproduceError('E_WRITE', 'Svež klon nije napravljen: ' + error.message);
  }
  return { parent, clone };
}

/**
 * Izvrši komandu u svežem klonu revizije; temp klon se uvek uklanja.
 */
export async function reproduceEvidence(options = {}) {
  const {
    repo, revision, argv,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  } = options;
  assertRepo(repo);
  assertRevision(repo, revision);
  assertArgv(argv);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new ReproduceError('E_USAGE', 'timeoutMs mora biti ceo broj >= 1');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) throw new ReproduceError('E_USAGE', 'maxOutputBytes mora biti ceo broj >= 1');

  const started = Date.now();
  const { parent, clone } = makeClone(repo, revision);
  const stdoutChunks = [];
  const stderrChunks = [];
  let timedOut = false;
  let limitExceeded = false;
  let spawnError = null;
  let exitCode = null;
  let signal = null;
  try {
    const outcome = await new Promise(resolve => {
      let child;
      try {
        child = spawn(argv[0], argv.slice(1), {
          cwd: clone,
          env: { PATH: process.env.PATH ?? '' },
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
        });
      } catch (error) {
        resolve({ exitCode: null, signal: null, errorCode: (error && error.code) || 'E_SPAWN' });
        return;
      }
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch { /* već izašao */ }
      }, timeoutMs);
      const collect = target => chunk => {
        if (limitExceeded) return;
        const current = target === 'stdout' ? stdoutChunks : stderrChunks;
        const next = Buffer.concat([...current, chunk]);
        if (next.length > maxOutputBytes) {
          limitExceeded = true;
          current.push(next);
          try { child.kill('SIGKILL'); } catch { /* već izašao */ }
          return;
        }
        current.push(chunk);
      };
      child.stdout.on('data', collect('stdout'));
      child.stderr.on('data', collect('stderr'));
      child.on('error', error => {
        clearTimeout(timer);
        spawnError = (error && error.code) || 'E_SPAWN';
        resolve({ exitCode: null, signal: null, errorCode: spawnError });
      });
      child.on('close', (code, closeSignal) => {
        clearTimeout(timer);
        resolve({ exitCode: code, signal: closeSignal, errorCode: null });
      });
    });
    exitCode = outcome.exitCode;
    signal = outcome.signal;
    if (outcome.errorCode) spawnError = outcome.errorCode;
  } finally {
    try { rmSync(parent, { recursive: true, force: true }); } catch { /* najbolji pokušaj */ }
  }

  const stdoutBuffer = Buffer.concat(stdoutChunks);
  const stderrBuffer = Buffer.concat(stderrChunks);
  const stdout = stdoutBuffer.toString('utf8');
  const stderr = stderrBuffer.toString('utf8');

  let verdict;
  if (spawnError !== null || timedOut || limitExceeded) verdict = 'unexecuted';
  else if (exitCode === 0 && signal === null) verdict = 'ok';
  else verdict = 'failed';

  return {
    verdict,
    exitCode,
    signal,
    stdout,
    stderr,
    outputSha256: sha256(stdoutBuffer),
    durationMs: Date.now() - started,
    freshClone: true,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_REJECTED = 1;
const EXIT_USAGE = 2;

function parseCli(argv) {
  const options = { json: false, repo: undefined, revision: undefined, command: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--repo') { options.repo = argv[i + 1]; i += 1; continue; }
    if (arg === '--revision') { options.revision = argv[i + 1]; i += 1; continue; }
    if (arg === '--command') { options.command = argv[i + 1]; i += 1; continue; }
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

// CLI skraćuje izlaz na rep (dijagnostika), da JSON ostane prenosiv; hash je
// izračunat u API-ju nad punim sirovim stdout-om i ostaje tačan.
function tailText(text, max = 8192) {
  if (text.length <= max) return text;
  return '…' + text.slice(-max);
}

function cliView(result) {
  return { ...result, stdout: tailText(result.stdout), stderr: tailText(result.stderr) };
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = parseCli(rest);
  if (command !== 'reproduce') return fail('E_USAGE', 'Nepoznata komanda: ' + String(command));
  if (options.repo === undefined || options.revision === undefined || options.command === undefined) {
    return fail('E_USAGE', 'Obavezni: --repo, --revision i --command');
  }
  const parts = options.command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fail('E_ARGV', '--command je prazan');
  try {
    const result = await reproduceEvidence({ repo: options.repo, revision: options.revision, argv: parts });
    emit(options.json, cliView(result));
    return result.verdict === 'ok' ? EXIT_OK : EXIT_REJECTED;
  } catch (error) {
    if (!(error instanceof ReproduceError)) throw error;
    return fail(error.code, error.message);
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write((error && error.stack ? error.stack : String(error)) + '\n');
    process.exitCode = EXIT_USAGE;
  });
}
