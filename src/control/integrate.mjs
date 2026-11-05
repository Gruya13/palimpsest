/**
 * Integracija kroz kapiju.
 *
 * Jedini put u glavnu granu: zadatak mora biti verified, dokaz ok za
 * task.revision, promene u dozvoljenim zonama, glavno stablo čisto; grana se
 * rebase-uje na main pa merge-uje --no-ff. Konflikt se ne rešava automatski.
 * Logika je preneta iz Agent 2.0 mergeIntoMain (baseline 107dfb1).
 *
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoardError, readTask } from '../board/board.mjs';
import { checkEnvelope, CheckError } from '../evidence/check.mjs';
import { attestEvidence } from '../evidence/attest.mjs';
import { checkVerification } from '../evidence/verification.mjs';
import { removeWorktree, MAIN_BRANCH, worktreePathFor } from './worktree.mjs';

const TASK_ID = /^TASK-[0-9]{1,6}$/;
// smeju zavisiti od globalnog git config-a; autor promene ostaje radnikov.
const COMMIT_IDENTITY = ['-c', 'user.name=Palimpsest kontrolni sloj', '-c', 'user.email=kontrola@palimpsest.local'];

/** Greška integracije (poziv/okruženje). */
export class IntegrateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IntegrateError';
    this.code = code;
  }
}

function gitText(repo, args, options = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, ...options,
  }).trim();
}

function gitTry(repo, args) {
  try {
    gitText(repo, args);
    return true;
  } catch {
    return false;
  }
}

// Sirov izlaz bez trim-a: status --porcelain zadržava vodeći space formata.
function gitRaw(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
  });
}

function gitLines(repo, args) {
  const output = gitText(repo, args);
  return output === '' ? [] : output.split('\n').filter(Boolean);
}

function assertRepo(repo) {
  if (typeof repo !== 'string' || repo === '') throw new IntegrateError('E_REPO', 'repo je obavezan');
  let stat;
  try {
    stat = statSync(repo);
  } catch {
    throw new IntegrateError('E_REPO', 'repo ne postoji: ' + path.resolve(repo));
  }
  if (!stat.isDirectory()) throw new IntegrateError('E_REPO', 'repo nije direktorijum');
  if (!gitTry(repo, ['rev-parse', '--show-toplevel'])) {
    throw new IntegrateError('E_REPO', 'repo nije git radno stablo: ' + path.resolve(repo));
  }
  if (!gitTry(repo, ['rev-parse', '--verify', 'refs/heads/' + MAIN_BRANCH])) {
    throw new IntegrateError('E_REPO', 'repo nema granu "' + MAIN_BRANCH + '"');
  }
}

// Zaštićene zone za kind code: integracija ne sme dirati tests/ ni.worktrees/.
const PROTECTED_PREFIXES = ['tests', '.worktrees'];

function normalizeZonePrefix(value) {
  if (typeof value !== 'string') throw new IntegrateError('E_USAGE', 'zona mora biti string');
  let prefix = value.trim();
  if (prefix === '') throw new IntegrateError('E_USAGE', 'zona je prazna');
  if (path.isAbsolute(prefix)) throw new IntegrateError('E_USAGE', 'zona ne sme biti apsolutna: ' + prefix);
  prefix = path.normalize(prefix).split(path.sep).join('/');
  if (prefix === '.' || prefix === '..' || prefix.startsWith('../')) {
    throw new IntegrateError('E_USAGE', 'zona ne sme izlaziti izvan repo-a: ' + value);
  }
  while (prefix.endsWith('/')) prefix = prefix.slice(0, -1);
  return prefix;
}

function assertAllowedPrefixes(allowedPrefixes) {
  if (!Array.isArray(allowedPrefixes)) {
    throw new IntegrateError('E_USAGE', 'allowedPrefixes mora biti niz stringova');
  }
  return allowedPrefixes.map(normalizeZonePrefix);
}

function inZone(file, zones) {
  return zones.some(zone => file === zone || file.startsWith(zone + '/'));
}

function inProtected(file) {
  return PROTECTED_PREFIXES.some(prefix => file === prefix || file.startsWith(prefix + '/'));
}

/**
 * Promenjene putanje grane prema base-u, sa obe strane rename-a.
 */
export async function branchChangedPaths({ repo, branch, base = MAIN_BRANCH } = {}) {
  assertRepo(repo);
  if (typeof branch !== 'string' || branch === '') throw new IntegrateError('E_BRANCH', 'branch je obavezan');
  const lines = gitLines(repo, ['diff', '--name-status', '--find-renames', base + '...' + branch]);
  const paths = new Set();
  for (const line of lines) {
    const parts = line.split('\t');
    const status = parts[0] || '';
    if (status.startsWith('R') || status.startsWith('C')) {
      for (const candidate of parts.slice(1)) paths.add(candidate);
    } else {
      for (const candidate of parts.slice(1)) paths.add(candidate);
    }
  }
  return [...paths];
}

/**
 * Je li glavno stablo čisto, osim tačno navedenih dozvoljenih putanja.
 */
export async function isMainClean({ repo, allowedDirty = [] } = {}) {
  assertRepo(repo);
  if (!Array.isArray(allowedDirty)) throw new IntegrateError('E_USAGE', 'allowedDirty mora biti niz');
  if (!gitTry(repo, ['rev-parse', '--verify', 'refs/heads/' + MAIN_BRANCH])) {
    throw new IntegrateError('E_REPO', 'repo nema granu "' + MAIN_BRANCH + '"');
  }
  const current = gitText(repo, ['symbolic-ref', '--short', 'HEAD']);
  if (current !== MAIN_BRANCH) return false;
  const entries = gitRaw(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\u0000').filter(Boolean);
  for (const entry of entries) {
    const file = entry.slice(3);
    if (!allowedDirty.includes(file)) return false;
  }
  return true;
}

// O-70: verified mora nastati kroz tranziciju — poslednji event zadatka je
// 'verified' i njegov 'at' je tačno task.updated. Ručno upisan status ne prolazi.
function verifiedEventProblem(task, taskPath) {
  const eventsPath = path.join(path.dirname(taskPath), 'events.jsonl');
  if (!existsSync(eventsPath)) return 'verified nije nastao kroz tranziciju';
  let entries;
  try {
    entries = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return 'dnevnik događaja nije čitljiv';
  }
  const mine = entries.filter(event => event !== null && typeof event === 'object' && event.task === task.id);
  if (mine.length === 0) return 'verified nije nastao kroz tranziciju';
  const last = mine[mine.length - 1];
  if (last.to !== 'verified' || last.at !== task.updated) {
    return 'verified nije nastao kroz tranziciju';
  }
  return null;
}

function evidenceRefusal(task, repo) {
  if (task.evidence === null) return 'zadatak nema dokaz';
  const evidencePath = path.resolve(repo, task.evidence);
  let check;
  try {
    check = checkEnvelope(evidencePath, { repo, at: task.revision });
  } catch (error) {
    if (error instanceof CheckError) return 'dokaz nije proverljiv (' + error.code + ')';
    throw error;
  }
  if (check.status !== 'ok') {
    const reason = check.reasons.length > 0 ? check.reasons[0].code : check.status;
    return 'dokaz nije ok (' + check.status + '/' + reason + ')';
  }
  return null;
}

function conflictFiles(repo, worktreePath) {
  try {
    return gitLines(worktreePath, ['diff', '--name-only', '--diff-filter=U']);
  } catch {
    try {
      return gitLines(repo, ['diff', '--name-only', '--diff-filter=U']);
    } catch {
      return [];
    }
  }
}

async function doIntegrate(options) {
  const { repo, tasksRoot, taskPath, allowedPrefixes, now = () => new Date().toISOString() } = options;
  assertRepo(repo);
  if (typeof tasksRoot !== 'string' || tasksRoot === '') throw new IntegrateError('E_USAGE', 'tasksRoot je obavezan');
  if (!existsSync(tasksRoot)) throw new IntegrateError('E_TASK', 'tasksRoot ne postoji: ' + path.resolve(tasksRoot));
  if (typeof taskPath !== 'string' || taskPath === '') throw new IntegrateError('E_TASK', 'taskPath je obavezan');
  let task;
  try {
    task = readTask(taskPath);
  } catch (error) {
    if (error instanceof BoardError && error.code === 'E_TASK') {
      throw new IntegrateError('E_TASK', error.message);
    }
    throw error;
  }
  const zones = assertAllowedPrefixes(allowedPrefixes);

  if (task.status !== 'verified') {
    return { integrated: false, code: 'E_STATE', reason: 'zadatak nije verified (' + task.status + ')' };
  }
  if (task.kind !== 'code') {
    return { integrated: false, code: 'E_STATE', reason: 'samo code zadatak se integriše (kind ' + task.kind + ')' };
  }
  const eventProblem = verifiedEventProblem(task, taskPath);
  if (eventProblem !== null) {
    return { integrated: false, code: 'E_STATE', reason: eventProblem };
  }
  const branch = 'zadatak/' + task.id;
  if (!gitTry(repo, ['rev-parse', '--verify', 'refs/heads/' + branch])) {
    return { integrated: false, code: 'E_BRANCH', reason: 'grana ne postoji: ' + branch };
  }
  const branchRevision = gitText(repo, ['rev-parse', 'refs/heads/' + branch]);
  if (branchRevision !== task.revision) {
    return { integrated: false, code: 'E_REVISION', reason: 'grana ne pokazuje na dokazanu reviziju' };
  }
  const evidenceProblem = evidenceRefusal(task, repo);
  if (evidenceProblem !== null) {
    return { integrated: false, code: 'E_EVIDENCE', reason: evidenceProblem };
  }
 // F4a: dokaz mora biti ponovo izvršen na reviziji pre ulaska u main.
  const evidencePath = path.resolve(repo, task.evidence);
  const attestation = await attestEvidence({ repo, revision: task.revision, evidencePath });
  if (!attestation.attested) {
    return { integrated: false, code: 'E_ATTEST', reason: attestation.reason, check: attestation.check };
  }
 // F4b/R3: verifikacioni zapis mora da se ukrsti sa omotačem (hash, revizija,
 // identitet verifikatora iz verify niti).
  const verificationPath = evidencePath + '.verification.json';
  const verification = checkVerification({ evidencePath, verificationPath });
  if (!verification.ok) {
    return { integrated: false, code: 'E_VERIFICATION', reason: verification.reason };
  }

  const changed = await branchChangedPaths({ repo, branch, base: MAIN_BRANCH });
  if (changed.length === 0) {
    return { integrated: false, code: 'E_BRANCH', reason: 'grana nema promena prema ' + MAIN_BRANCH };
  }
  const protectedChanged = changed.filter(inProtected);
  if (protectedChanged.length > 0) {
    return { integrated: false, code: 'E_ZONE', reason: 'promena u zaštićenoj zoni', outOfZone: protectedChanged };
  }
  const outOfZone = changed.filter(file => !inZone(file, zones));
  if (outOfZone.length > 0) {
    return { integrated: false, code: 'E_ZONE', reason: 'promene van dozvoljenih zona', outOfZone };
  }

  const allowedDirty = ['tasks/events.jsonl', 'tasks/' + task.id + '.lease.json'];
  if (!(await isMainClean({ repo, allowedDirty }))) {
    return { integrated: false, code: 'E_DIRTY', reason: 'glavno stablo nije čisto (ili nije na ' + MAIN_BRANCH + ')' };
  }

  const worktreeDir = worktreePathFor({ repo, taskId: task.id });
  if (!existsSync(worktreeDir)) {
    return { integrated: false, code: 'E_BRANCH', reason: 'radno stablo zadatka ne postoji: ' + worktreeDir };
  }

  const rebase = runGitResult(worktreeDir, [...COMMIT_IDENTITY, 'rebase', MAIN_BRANCH]);
  if (rebase.code !== 0) {
    const files = conflictFiles(repo, worktreeDir);
    runGitResult(worktreeDir, ['rebase', '--abort']);
    return {
      integrated: false,
      code: 'E_CONFLICT',
      reason: files.length > 0 ? 'konflikt rebase-a: ' + files.join(', ') : 'rebase nije uspeo',
      files,
      conflict: files.length > 0,
    };
  }

  const message = 'integrate: ' + task.id + ' ' + task.title;
  const merge = runGitResult(repo, [...COMMIT_IDENTITY, 'merge', '--no-ff', '--no-edit', '-m', message, branch]);
  if (merge.code !== 0) {
    const conflicted = gitLines(repo, ['diff', '--name-only', '--diff-filter=U']);
    runGitResult(repo, ['merge', '--abort']);
    return {
      integrated: false,
      code: 'E_CONFLICT',
      reason: conflicted.length > 0 ? 'konflikt merge-a: ' + conflicted.join(', ') : 'merge nije uspeo',
      files: conflicted,
      conflict: conflicted.length > 0,
    };
  }

  const sha = gitText(repo, ['rev-parse', 'HEAD']);
  try {
    removeWorktree({ repo, taskId: task.id });
  } catch { /* cleanup ne sme da obori uspešnu integraciju */ }
  return { integrated: true, sha, branch };
}

function runGitResult(cwd, args) {
  try {
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
    });
    return { code: 0, stdout: '', stderr: '' };
  } catch (error) {
    return {
      code: typeof error.status === 'number' ? error.status : 1,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : '',
    };
  }
}

/** Integriši zadatak kroz kapiju; odbijanja se vraćaju, greške se bacaju. */
export async function integrateTask(options = {}) {
  return doIntegrate(options);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_REJECTED = 1;
const EXIT_USAGE = 2;

function parseCli(argv) {
  const options = { json: false, repo: undefined, tasks: undefined, allow: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--repo') { options.repo = argv[i + 1]; i += 1; continue; }
    if (arg === '--tasks') { options.tasks = argv[i + 1]; i += 1; continue; }
    if (arg === '--allow') { options.allow.push(argv[i + 1]); i += 1; continue; }
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

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const { options, positional } = parseCli(rest);
  const fail = (code, message) => {
    emit(true, { ok: false, error: { code, message } });
    return EXIT_USAGE;
  };
  if (command !== 'integrate') return fail('E_USAGE', 'Nepoznata komanda: ' + String(command));
  const taskPath = positional[0];
  if (taskPath === undefined || options.repo === undefined || options.tasks === undefined) {
    return fail('E_USAGE', 'Obavezni: zadatak, --repo i --tasks');
  }
  try {
    const result = await integrateTask({ repo: options.repo, tasksRoot: options.tasks, taskPath, allowedPrefixes: options.allow });
    emit(options.json, result);
    return result.integrated ? EXIT_OK : EXIT_REJECTED;
  } catch (error) {
    if (!(error instanceof IntegrateError)) throw error;
    emit(true, { ok: false, error: { code: error.code, message: error.message } });
    return EXIT_USAGE;
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
