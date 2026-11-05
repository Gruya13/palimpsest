/**
 * Izolovana radna stabla.
 *
 * Svaki zadatak dobija `<repo>/.worktrees/<TASK-ID>` i granu
 * `zadatak/<TASK-ID>[/<role>]` od `main`. Glavna grana ostaje netaknuta;
 * uklanjanje briše worktree, granu i prune-uje registraciju. Logika je preneta
 * iz Agent 2.0 `worktree.mjs` (baseline 107dfb1), prilagođena Palimpsestu.
 *
 * `recoverWorktree` je imenovan, idempotentan pun oporavak siročeta —
 * poziva `removeWorktree` (worktree + grana + prune), za razliku od
 * `pruneWorktrees` koji uklanja samo registraciju.
 *
 */
import { existsSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAIN_BRANCH = 'main';

const TASK_ID = /^TASK-[0-9]{1,6}$/;

/** Greška radnog stabla. */
export class WorktreeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
  }
}

function gitText(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
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

function assertRepo(repo) {
  if (typeof repo !== 'string' || repo === '') throw new WorktreeError('E_REPO', 'repo je obavezan');
  let stat;
  try {
    stat = statSync(repo);
  } catch {
    throw new WorktreeError('E_REPO', 'repo ne postoji: ' + path.resolve(repo));
  }
  if (!stat.isDirectory()) throw new WorktreeError('E_REPO', 'repo nije direktorijum');
  if (!gitTry(repo, ['rev-parse', '--show-toplevel'])) {
    throw new WorktreeError('E_REPO', 'repo nije git radno stablo: ' + path.resolve(repo));
  }
  if (!gitTry(repo, ['rev-parse', '--verify', 'refs/heads/' + MAIN_BRANCH])) {
    throw new WorktreeError('E_REPO', 'repo nema granu "' + MAIN_BRANCH + '"');
  }
}

function assertTaskId(taskId) {
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) {
    throw new WorktreeError('E_WORKTREE', 'taskId mora biti TASK-<broj>');
  }
}

function assertRole(role) {
  if (role !== null && role !== undefined && (typeof role !== 'string' || role.length < 1 || role.length > 32)) {
    throw new WorktreeError('E_USAGE', 'role mora biti 1–32 znaka ili null');
  }
}

/** Putanja worktree-a za zadatak. */
export function worktreePathFor({ repo, taskId }) {
  return path.join(repo, '.worktrees', taskId);
}

/** Ime grane za zadatak/ulogu. */
export function branchNameFor({ taskId, role = null }) {
  return role === null || role === undefined ? 'zadatak/' + taskId : 'zadatak/' + taskId + '/' + role;
}

/** Kreiraj worktree i granu od base revizije. */
export function createWorktree(options = {}) {
  const { repo, taskId, role = null, base = MAIN_BRANCH } = options;
  assertRepo(repo);
  assertTaskId(taskId);
  assertRole(role);
  const worktreePath = worktreePathFor({ repo, taskId });
  const branch = branchNameFor({ taskId, role });
  if (existsSync(worktreePath)) throw new WorktreeError('E_WORKTREE', 'worktree već postoji: ' + worktreePath);
  if (gitTry(repo, ['rev-parse', '--verify', 'refs/heads/' + branch])) {
    throw new WorktreeError('E_WORKTREE', 'grana već postoji: ' + branch);
  }
  if (!gitTry(repo, ['rev-parse', '--verify', String(base) + '^{commit}'])) {
    throw new WorktreeError('E_REVISION', 'base revizija ne postoji: ' + String(base));
  }
  try {
    gitText(repo, ['worktree', 'add', '-b', branch, worktreePath, String(base)]);
  } catch (error) {
    throw new WorktreeError('E_WORKTREE', 'worktree nije napravljen: ' + error.message);
  }
  return { path: worktreePath, branch, base: String(base) };
}

/** Lista internih worktree-ova (samo ispod `.worktrees/`). */
export function listWorktrees({ repo } = {}) {
  assertRepo(repo);
  const output = gitText(repo, ['worktree', 'list', '--porcelain']);
  const prefix = path.join(repo, '.worktrees') + path.sep;
  const worktrees = [];
  for (const block of output.split('\n\n')) {
    const lines = block.split('\n');
    const pathLine = lines.find(line => line.startsWith('worktree '));
    const branchLine = lines.find(line => line.startsWith('branch '));
    if (pathLine === undefined || branchLine === undefined) continue;
    const at = pathLine.slice('worktree '.length);
    if (!at.startsWith(prefix)) continue;
    worktrees.push({
      path: at,
      branch: branchLine.slice('branch '.length).replace(/^refs\/heads\//, ''),
      task: path.basename(at),
    });
  }
  return worktrees;
}

/** Ukloni worktree i granu; idempotentno. */
export function removeWorktree({ repo, taskId, role = null } = {}) {
  assertRepo(repo);
  assertTaskId(taskId);
  assertRole(role);
  const worktreePath = worktreePathFor({ repo, taskId });
  const branch = branchNameFor({ taskId, role });
  if (existsSync(worktreePath)) {
    try {
      gitText(repo, ['worktree', 'remove', '--force', worktreePath]);
    } catch { /* čišćenje se nastavlja */ }
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch { /* najbolji pokušaj */ }
  }
  if (gitTry(repo, ['rev-parse', '--verify', 'refs/heads/' + branch])) {
    try {
      gitText(repo, ['branch', '-D', branch]);
    } catch { /* najbolji pokušaj */ }
  }
  try {
    gitText(repo, ['worktree', 'prune']);
  } catch { /* najbolji pokušaj */ }
}

/**
 * Puni oporavak radnog stabla: uklanja worktree, granu i registraciju.
 * Idempotentno; drugi poziv vraća `recovered: false` i ne menja stanje.
 */
export function recoverWorktree({ repo, taskId, role = null } = {}) {
  assertRepo(repo);
  assertTaskId(taskId);
  assertRole(role);
  const worktreePath = worktreePathFor({ repo, taskId });
  const branch = branchNameFor({ taskId, role });
  const hadWorktree = existsSync(worktreePath);
  const hadBranch = gitTry(repo, ['rev-parse', '--verify', 'refs/heads/' + branch]);
 // Siročetu je direktorijum nestao, pa ga `git branch -D` još vidi kao
 // "checked out"; prvo prune-ujemo registraciju, pa tek onda brišemo granu.
  try {
    gitText(repo, ['worktree', 'prune']);
  } catch { /* najbolji pokušaj */ }
  removeWorktree({ repo, taskId, role });
  return {
    task: taskId,
    role: role === null || role === undefined ? null : role,
    recovered: hadWorktree || hadBranch,
    worktreeRemoved: hadWorktree,
    branchRemoved: hadBranch,
  };
}

/** Počisti registracije worktree-ova kojima je direktorijum nestao. */
export function pruneWorktrees({ repo } = {}) {
  assertRepo(repo);
  try {
    gitText(repo, ['worktree', 'prune']);
  } catch (error) {
    throw new WorktreeError('E_WORKTREE', 'prune nije uspeo: ' + error.message);
  }
}

/** Komituj sve izmene u worktree-u datim autorom. */
export function commitWorktree({ repo, taskId, role = null, message, actor } = {}) {
  assertRepo(repo);
  assertTaskId(taskId);
  assertRole(role);
  const worktreePath = worktreePathFor({ repo, taskId });
  if (!existsSync(worktreePath)) throw new WorktreeError('E_WORKTREE', 'worktree ne postoji: ' + worktreePath);
  if (typeof message !== 'string' || message.length < 1 || message.length > 500) {
    throw new WorktreeError('E_USAGE', 'message mora biti 1–500 znakova');
  }
  if (actor === null || typeof actor !== 'object' || typeof actor.name !== 'string' || typeof actor.email !== 'string') {
    throw new WorktreeError('E_USAGE', 'actor mora biti { name, email }');
  }
  try {
    gitText(worktreePath, ['add', '-A']);
    gitText(worktreePath, ['-c', 'user.name=' + actor.name, '-c', 'user.email=' + actor.email, '-c', 'commit.gpgsign=false', 'commit', '-m', message]);
  } catch (error) {
    throw new WorktreeError('E_WORKTREE', 'commit nije uspeo: ' + error.message);
  }
  return { sha: gitText(worktreePath, ['rev-parse', 'HEAD']) };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_USAGE = 2;

function parseCli(argv) {
  const options = { json: false, repo: undefined, task: undefined, role: undefined, base: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--repo') { options.repo = argv[i + 1]; i += 1; continue; }
    if (arg === '--task') { options.task = argv[i + 1]; i += 1; continue; }
    if (arg === '--role') { options.role = argv[i + 1]; i += 1; continue; }
    if (arg === '--base') { options.base = argv[i + 1]; i += 1; continue; }
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

function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = parseCli(rest);
  try {
    if (command === 'create') {
      if (options.repo === undefined || options.task === undefined) return fail('E_USAGE', 'Obavezni: --repo i --task');
      const result = createWorktree({ repo: options.repo, taskId: options.task, role: options.role, base: options.base });
      emit(options.json, result);
      return EXIT_OK;
    }
    if (command === 'list') {
      if (options.repo === undefined) return fail('E_USAGE', 'Obavezan: --repo');
      emit(options.json, { worktrees: listWorktrees({ repo: options.repo }) });
      return EXIT_OK;
    }
    if (command === 'remove') {
      if (options.repo === undefined || options.task === undefined) return fail('E_USAGE', 'Obavezni: --repo i --task');
      removeWorktree({ repo: options.repo, taskId: options.task, role: options.role });
      emit(options.json, { task: options.task, removed: true });
      return EXIT_OK;
    }
    if (command === 'recover') {
      if (options.repo === undefined || options.task === undefined) return fail('E_USAGE', 'Obavezni: --repo i --task');
      const result = recoverWorktree({ repo: options.repo, taskId: options.task, role: options.role });
      emit(options.json, result);
      return EXIT_OK;
    }
    return fail('E_USAGE', 'Nepoznata komanda: ' + String(command));
  } catch (error) {
    if (!(error instanceof WorktreeError)) throw error;
    return fail(error.code, error.message);
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
