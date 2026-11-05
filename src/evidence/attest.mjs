/**
 * Atestacija izvršenja dokaza.
 *
 * Pre ulaska u main, svaka "ok" provera iz dokaznog omotača mora biti ponovo
 * izvršena na reviziji zadatka i dati isti ishod (verdict ok, isti
 * outputSha256). Time postaju izvršni za ulazak u main: lažni "ok" bez
 * izvršenja ne prolazi čak i kada checkEnvelope vrati ok.
 *
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './run.mjs';

export const ATTEST_VERSION = 1;
const HEX40 = /^[0-9a-f]{40}$/;
const ATT_TIMEOUT_MS = 60000;

/** Greška atestacije (nevalidan ulaz). */
export class AttestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AttestError';
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

function assertInputs(repo, revision, evidencePath) {
  if (typeof repo !== 'string' || repo === '') throw new AttestError('E_REPO', 'repo je obavezan');
  if (!existsSync(repo)) throw new AttestError('E_REPO', 'repo ne postoji: ' + path.resolve(repo));
  if (!gitTry(repo, ['rev-parse', '--show-toplevel'])) throw new AttestError('E_REPO', 'repo nije git radno stablo');
  if (typeof revision !== 'string' || !HEX40.test(revision) || !gitTry(repo, ['cat-file', '-e', revision + '^{commit}'])) {
    throw new AttestError('E_REVISION', 'revision ne postoji u repou: ' + String(revision));
  }
  if (typeof evidencePath !== 'string' || evidencePath === '') {
    throw new AttestError('E_USAGE', 'evidencePath je obavezan');
  }
}

function readEnvelope(evidencePath) {
  if (!existsSync(evidencePath)) throw new AttestError('E_SCHEMA', 'omotač ne postoji: ' + path.resolve(evidencePath));
  let text;
  try {
    text = readFileSync(evidencePath, 'utf8');
  } catch (error) {
    throw new AttestError('E_SCHEMA', 'omotač se ne čita: ' + error.message);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new AttestError('E_SCHEMA', 'omotač nije validan JSON: ' + error.message);
  }
  return value;
}

/**
 * Atestiraj dokaz: ponovi svaku "ok" proveru na reviziji i uporedi ishod.
 */
export async function attestEvidence(options = {}) {
  const { repo, revision, evidencePath } = options;
  assertInputs(repo, revision, evidencePath);
  const envelope = readEnvelope(evidencePath);
  const checks = [];
  const refused = (reason, check, outputSha256) => ({
    attested: false,
    reason,
    check: { claim: check.claim, verdict: check.verdict, outputSha256: outputSha256 === undefined ? (check.outputSha256 ?? null) : outputSha256 },
  });
  for (const check of envelope.checks || []) {
    if (check.verdict !== 'ok') continue;
    const command = typeof check.command === 'string' ? check.command.trim() : '';
    const argv = command === '' ? [] : command.split(/\s+/);
    if (argv.length === 0) return refused('no-command', check, null);
    if (check.outputSha256 === null || check.outputSha256 === undefined) return refused('output-missing', check, null);
    const run = await runCommand({ repo, revision, argv, timeoutMs: ATT_TIMEOUT_MS });
    if (run.verdict !== 'ok') return refused('failed', check, run.outputSha256);
    if (run.outputSha256 !== check.outputSha256) return refused('output-mismatch', check, run.outputSha256);
    checks.push({ claim: check.claim, verdict: 'ok', outputSha256: run.outputSha256 });
  }
  return { attested: true, checks };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_REJECTED = 1;
const EXIT_USAGE = 2;

function parseCli(argv) {
  const options = { json: false, repo: undefined, revision: undefined, envelope: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--repo') { options.repo = argv[i + 1]; i += 1; continue; }
    if (arg === '--revision') { options.revision = argv[i + 1]; i += 1; continue; }
    if (arg === '--envelope') { options.envelope = argv[i + 1]; i += 1; continue; }
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
  if (command !== 'check') return fail('E_USAGE', 'Nepoznata komanda: ' + String(command));
  if (options.repo === undefined || options.revision === undefined || options.envelope === undefined) {
    return fail('E_USAGE', 'Obavezni: --repo, --revision i --envelope');
  }
  try {
    const result = await attestEvidence({ repo: options.repo, revision: options.revision, evidencePath: options.envelope });
    emit(options.json, result);
    return result.attested ? EXIT_OK : EXIT_REJECTED;
  } catch (error) {
    if (!(error instanceof AttestError)) throw error;
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
