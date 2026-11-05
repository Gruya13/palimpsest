/**
 * Falsifikatori — izvršavanje provera tvrdnji.
 *
 * Za svako saznanje/pravilo sa falsifikatorom izvršava se komanda kroz 
 * `runCommand` na reviziji `revision_bound`, u izolovanom worktree-u, bez
 * shell-a. Ishod: `ok` čuva zapis, `failed` (tvrdnja oborena) daje `stale`,
 * `unexecuted` (neizvršiv falsifikator) premešta zapis u `povuceno/retracted`.
 *
 */
import { execFileSync } from 'node:child_process';
import { rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../evidence/run.mjs';
import { listMemories, MemoryError } from '../memory/memory.mjs';

const CHECKED_LEVELS = ['saznanja', 'pravila'];

/** Greška falsifikatora. */
export class FalsifierError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FalsifierError';
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

function assertMemoryRoot(memoryRoot) {
  if (typeof memoryRoot !== 'string' || memoryRoot === '') {
    throw new FalsifierError('E_MEMORY', 'memoryRoot je obavezan');
  }
  let stat;
  try {
    stat = statSync(memoryRoot);
  } catch {
    throw new FalsifierError('E_MEMORY', 'memoryRoot ne postoji: ' + path.resolve(memoryRoot));
  }
  if (!stat.isDirectory()) throw new FalsifierError('E_MEMORY', 'memoryRoot nije direktorijum');
}

function assertRepo(repo) {
  if (typeof repo !== 'string' || repo === '') throw new FalsifierError('E_REPO', 'repo je obavezan');
  let stat;
  try {
    stat = statSync(repo);
  } catch {
    throw new FalsifierError('E_REPO', 'repo ne postoji: ' + path.resolve(repo));
  }
  if (!stat.isDirectory()) throw new FalsifierError('E_REPO', 'repo nije direktorijum');
  if (!gitTry(repo, ['rev-parse', '--show-toplevel'])) {
    throw new FalsifierError('E_REPO', 'repo nije git radno stablo: ' + path.resolve(repo));
  }
}

function writeRecord(file, record) {
  try {
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
  } catch (error) {
    throw new FalsifierError('E_WRITE', 'Zapis nije upisan: ' + error.message);
  }
}

/**
 * Izvrši falsifikatore svih saznanja/pravila; primeni ishode tek posle svih
 * izvršavanja. Validacija cele memorije i svih revizija pre prve komande.
 */
export async function runFalsifiers(options = {}) {
  const { memoryRoot, repo, timeoutMs = 30000, now = () => new Date().toISOString() } = options;
  assertMemoryRoot(memoryRoot);
  assertRepo(repo);

 // validacija cele memorije pre ijedne komande (uključujući nivoe koji se ne izvršavaju)
  try {
    listMemories({ memoryRoot });
  } catch (error) {
    if (error instanceof MemoryError) {
      throw new FalsifierError('E_SCHEMA', 'Memorija nije validna: ' + error.message);
    }
    throw error;
  }

  const entries = [];
  for (const level of CHECKED_LEVELS) {
    for (const record of listMemories({ memoryRoot, level })) entries.push({ level, record });
  }
  entries.sort((a, b) => (a.level < b.level ? -1 : a.level > b.level ? 1 : a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0));

 // sve revizije moraju postojati pre prve komande
  for (const { record } of entries) {
    if (record.falsifier === null) continue;
    if (!gitTry(repo, ['cat-file', '-e', record.revision_bound + '^{commit}'])) {
      throw new FalsifierError('E_REVISION', 'revision_bound ne postoji: ' + record.revision_bound);
    }
  }

  const checked = [];
  const changes = [];
  for (const { level, record } of entries) {
    if (record.falsifier === null) continue;
    const argv = record.falsifier.trim().split(/\s+/).filter(Boolean);
    if (argv.length === 0) {
      checked.push({ id: record.id, level, verdict: 'unexecuted' });
      changes.push({ kind: 'retract', level, record });
      continue;
    }
    const result = await runCommand({ repo, revision: record.revision_bound, argv, timeoutMs });
    checked.push({ id: record.id, level, verdict: result.verdict });
    if (result.verdict === 'failed') changes.push({ kind: 'stale', level, record });
    else if (result.verdict === 'unexecuted') changes.push({ kind: 'retract', level, record });
  }

  const updated = now();
  const stale = [];
  const retracted = [];
  for (const change of changes) {
    const source = path.join(memoryRoot, change.level, change.record.id + '.json');
    if (change.kind === 'stale') {
      writeRecord(source, { ...change.record, status: 'stale', updated });
      stale.push(change.record.id);
    } else {
      const target = path.join(memoryRoot, 'povuceno', change.record.id + '.json');
      writeRecord(target, { ...change.record, status: 'retracted', updated });
      try {
        rmSync(source, { force: true });
      } catch (error) {
        throw new FalsifierError('E_WRITE', 'Zapis nije uklonjen: ' + error.message);
      }
      retracted.push(change.record.id);
    }
  }
  return { checked, stale, retracted };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_REJECTED = 1;
const EXIT_USAGE = 2;

const EXIT_BY_CODE = {
  E_SCHEMA: EXIT_USAGE,
  E_MEMORY: EXIT_USAGE,
  E_REPO: EXIT_USAGE,
  E_REVISION: EXIT_USAGE,
  E_USAGE: EXIT_USAGE,
  E_WRITE: EXIT_USAGE,
};

function parseCli(argv) {
  const options = { json: false, root: undefined, repo: undefined, timeoutMs: 30000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--root') { options.root = argv[i + 1]; i += 1; continue; }
    if (arg === '--repo') { options.repo = argv[i + 1]; i += 1; continue; }
    if (arg === '--timeout') {
      const raw = argv[i + 1];
      i += 1;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1) throw new FalsifierError('E_USAGE', '--timeout mora biti ceo broj >= 1');
      options.timeoutMs = value;
      continue;
    }
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

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const fail = (code, message) => {
    emit(true, { ok: false, error: { code, message } });
    return EXIT_USAGE;
  };
  if (command !== 'run') return fail('E_USAGE', 'Nepoznata komanda: ' + String(command));
  let options;
  try {
    options = parseCli(rest);
  } catch (error) {
    if (error instanceof FalsifierError) return fail(error.code, error.message);
    throw error;
  }
  if (options.root === undefined || options.repo === undefined) return fail('E_USAGE', 'Obavezni: --root i --repo');
  try {
    const result = await runFalsifiers({ memoryRoot: options.root, repo: options.repo, timeoutMs: options.timeoutMs });
    emit(options.json, result);
    return result.stale.length === 0 && result.retracted.length === 0 ? EXIT_OK : EXIT_REJECTED;
  } catch (error) {
    if (!(error instanceof FalsifierError)) throw error;
    emit(true, { ok: false, error: { code: error.code, message: error.message } });
    return EXIT_BY_CODE[error.code] ?? EXIT_USAGE;
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
