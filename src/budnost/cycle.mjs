/**
 * Cirkadijalni ciklus — san postaje neizbežan.
 *
 * Redosled: idle (nema živih zakupa) → prag (canWork false) → NREM san →
 * merenje posle sna → otisak dreams/awake.json. Oporavak je stvarno poboljšanje
 * memorije/kanala; ako san ne oporavlja, to je nalaz 'no-recovery'.
 *
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeLeases } from '../control/lease.mjs';
import { nremRun } from '../san/nrem.mjs';
import { AWAKE_VERSION, canWork, computeAwake } from './awake.mjs';

/** Greška cirkadijalnog ciklusa. */
export class CycleError extends Error {
  constructor(code, message, cause = undefined) {
    super(message);
    this.name = 'CycleError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function gitTry(repo) {
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

function assertInputs(repo, memoryRoot, out) {
  if (typeof repo !== 'string' || repo === '') throw new CycleError('E_REPO', 'repo je obavezan');
  let stat;
  try {
    stat = statSync(repo);
  } catch {
    throw new CycleError('E_REPO', 'repo ne postoji: ' + path.resolve(repo));
  }
  if (!stat.isDirectory() || !gitTry(repo)) {
    throw new CycleError('E_REPO', 'repo nije git radno stablo: ' + path.resolve(repo));
  }
  if (typeof memoryRoot !== 'string' || memoryRoot === '') throw new CycleError('E_MEMORY', 'memoryRoot je obavezan');
  try {
    stat = statSync(memoryRoot);
  } catch {
    throw new CycleError('E_MEMORY', 'memoryRoot ne postoji: ' + path.resolve(memoryRoot));
  }
  if (!stat.isDirectory()) throw new CycleError('E_MEMORY', 'memoryRoot nije direktorijum');
  if (typeof out !== 'string' || out === '') throw new CycleError('E_USAGE', 'out je obavezan');
}

function isoNow(now) {
  const value = now instanceof Date ? now : new Date(String(now));
  if (Number.isNaN(value.getTime())) throw new CycleError('E_USAGE', 'now nije validno vreme');
  return value.toISOString();
}

function recoveryOf(before, after) {
  return {
    before: before.index,
    after: after.index,
    delta: after.index - before.index,
    recovered: after.signals.stale < before.signals.stale
      || after.signals.candidates < before.signals.candidates
      || after.signals.channelRecords < before.signals.channelRecords,
    stale: { before: before.signals.stale, after: after.signals.stale },
    candidates: { before: before.signals.candidates, after: after.signals.candidates },
    channel: { before: before.signals.channelRecords, after: after.signals.channelRecords },
  };
}

/**
 * Jedini put do sna: idle → prag → NREM → merenje → otisak.
 */
export async function awakeCycle(options = {}) {
  const { repo, tasksRoot, memoryRoot, out, now = new Date() } = options;
  assertInputs(repo, memoryRoot, out);
  const iso = isoNow(now);

  const before = computeAwake({ tasksRoot, memoryRoot, out, now: iso });
  const leases = activeLeases({ tasksRoot, now: iso });
  if (leases.length > 0) {
    return { slept: false, reason: 'busy', before };
  }
  if (canWork(before.index)) {
    return { slept: false, reason: 'not-needed', before };
  }

  let nrem;
  try {
    nrem = nremRun({ memoryRoot, repo, out, now: () => iso });
  } catch (error) {
    throw new CycleError('E_NREM', 'San nije uspeo: ' + (error && error.message ? error.message : String(error)), error);
  }

  const after = computeAwake({ tasksRoot, memoryRoot, out, now: iso, lastSleepAt: iso });
  const recovery = recoveryOf(before, after);
  const finding = recovery.recovered ? null : 'no-recovery';
  const awake = {
    version: AWAKE_VERSION,
    lastSleepAt: iso,
    lastIndex: after.index,
    lastRecovery: recovery,
  };
  try {
    const dreamsDir = path.join(memoryRoot, 'dreams');
    mkdirSync(dreamsDir, { recursive: true });
    writeFileSync(path.join(dreamsDir, 'awake.json'), JSON.stringify(awake, null, 2) + '\n', 'utf8');
  } catch (error) {
    throw new CycleError('E_WRITE', 'Otisak budnosti nije upisan: ' + error.message, error);
  }

  return { slept: true, before, after, recovery, nrem, awake, finding };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_REJECTED = 1;
const EXIT_USAGE = 2;

function parseCli(argv) {
  const options = { json: false, repo: undefined, tasks: undefined, memory: undefined, out: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--repo') { options.repo = argv[i + 1]; i += 1; continue; }
    if (arg === '--tasks') { options.tasks = argv[i + 1]; i += 1; continue; }
    if (arg === '--memory') { options.memory = argv[i + 1]; i += 1; continue; }
    if (arg === '--out') { options.out = argv[i + 1]; i += 1; continue; }
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

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = parseCli(rest);
  if (command !== 'run') return fail('E_USAGE', 'Nepoznata komanda: ' + String(command));
  if (options.repo === undefined || options.tasks === undefined || options.memory === undefined || options.out === undefined) {
    return fail('E_USAGE', 'Obavezni: --repo, --tasks, --memory i --out');
  }
  try {
    const result = await awakeCycle({ repo: options.repo, tasksRoot: options.tasks, memoryRoot: options.memory, out: options.out });
    emit(options.json, result);
    return result.slept ? EXIT_OK : EXIT_REJECTED;
  } catch (error) {
    if (!(error instanceof CycleError)) {
 // Validacione greške (AwakeError/MemoryError...) nose svoj kod.
      if (error && typeof error.code === 'string') return fail(error.code, error.message);
      throw error;
    }
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
