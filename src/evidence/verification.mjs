/**
 * Verifikacioni zapis.
 *
 * Verifikator nije samo polje u dokaznom omotaču: verifikaciona nit proizvodi
 * zaseban sidecar zapis koji nosi hash omotača, reviziju i identitet
 * {vendor, thread: 'verify', model}. Integracija u main zahteva da se sidecar
 * ukršta sa omotačem (hash, revizija, identitet) — dva nezavisna zapisa.
 *
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERIFICATION_VERSION = 1;
const HEX40 = /^[0-9a-f]{40}$/;

/** Greška verifikacionog zapisa (nevalidan ulaz). */
export class VerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VerificationError';
    this.code = code;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readEnvelopeBytes(evidencePath) {
  if (typeof evidencePath !== 'string' || evidencePath === '') {
    throw new VerificationError('E_USAGE', 'evidencePath je obavezan');
  }
  if (!existsSync(evidencePath)) {
    throw new VerificationError('E_NOT_FOUND', 'omotač ne postoji: ' + path.resolve(evidencePath));
  }
  let bytes;
  try {
    bytes = readFileSync(evidencePath);
  } catch (error) {
    throw new VerificationError('E_SCHEMA', 'omotač se ne čita: ' + error.message);
  }
  let envelope;
  try {
    envelope = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new VerificationError('E_SCHEMA', 'omotač nije validan JSON: ' + error.message);
  }
  if (envelope === null || typeof envelope !== 'object') {
    throw new VerificationError('E_SCHEMA', 'omotač nije objekat');
  }
  return { bytes, envelope };
}

function assertVerifier(verifier, envelope) {
  if (verifier === null || typeof verifier !== 'object') {
    throw new VerificationError('E_USAGE', 'verifier mora biti objekat {vendor, thread, model}');
  }
  for (const field of ['vendor', 'thread']) {
    if (typeof verifier[field] !== 'string' || verifier[field] === '') {
      throw new VerificationError('E_USAGE', 'verifier.' + field + ' je obavezan');
    }
  }
  if (verifier.model !== null && typeof verifier.model !== 'string') {
    throw new VerificationError('E_USAGE', 'verifier.model mora biti string ili null');
  }
  if (verifier.thread !== 'verify') {
    throw new VerificationError('E_USAGE', 'verifikator mora biti iz verify niti (thread = verify)');
  }
  if (envelope.author !== null && typeof envelope.author === 'object'
    && envelope.author.vendor === verifier.vendor) {
    throw new VerificationError('E_USAGE', 'verifikator ne sme biti istog vendora kao autor');
  }
}

/** Napravi verifikacioni zapis (sidecar uz omotač). */
export function createVerification(options = {}) {
  const { evidencePath, verificationPath, verifier, now = () => new Date().toISOString() } = options;
  const { bytes, envelope } = readEnvelopeBytes(evidencePath);
  assertVerifier(verifier, envelope);
  const target = verificationPath === undefined ? evidencePath + '.verification.json' : verificationPath;
  if (typeof target !== 'string' || target === '') {
    throw new VerificationError('E_USAGE', 'verificationPath je obavezan');
  }
  const record = {
    version: VERIFICATION_VERSION,
    verifier: { vendor: verifier.vendor, thread: verifier.thread, model: verifier.model ?? null },
    evidenceSha256: sha256(bytes),
    revision: envelope.revision,
    verdict: 'ok',
    createdAt: now(),
  };
  try {
    writeFileSync(target, JSON.stringify(record, null, 2) + '\n', 'utf8');
  } catch (error) {
    throw new VerificationError('E_WRITE', 'verifikacioni zapis nije upisan: ' + error.message);
  }
  return record;
}

/** Proveri da sidecar odgovara omotaču. Ne baca za neuspeh provere. */
export function checkVerification(options = {}) {
  const { evidencePath, verificationPath } = options;
  if (typeof verificationPath !== 'string' || verificationPath === '') {
    throw new VerificationError('E_USAGE', 'verificationPath je obavezan');
  }
  if (!existsSync(verificationPath)) return { ok: false, code: 'E_VERIFICATION', reason: 'missing' };
  const { bytes, envelope } = readEnvelopeBytes(evidencePath);
  let verification;
  try {
    verification = JSON.parse(readFileSync(verificationPath, 'utf8'));
  } catch (error) {
    return { ok: false, code: 'E_VERIFICATION', reason: 'invalid' };
  }
  if (verification === null || typeof verification !== 'object') return { ok: false, code: 'E_VERIFICATION', reason: 'invalid' };
  if (verification.evidenceSha256 !== sha256(bytes)) return { ok: false, code: 'E_VERIFICATION', reason: 'evidence-changed' };
  if (verification.revision !== envelope.revision || !HEX40.test(String(verification.revision))) {
    return { ok: false, code: 'E_VERIFICATION', reason: 'revision-mismatch' };
  }
  const expected = envelope.verifier;
  const got = verification.verifier;
  if (expected === null || typeof expected !== 'object' || got === null || typeof got !== 'object'
    || got.vendor !== expected.vendor || got.thread !== expected.thread
    || (got.model ?? null) !== (expected.model ?? null)) {
    return { ok: false, code: 'E_VERIFICATION', reason: 'verifier-mismatch' };
  }
  if (verification.verdict !== 'ok') return { ok: false, code: 'E_VERIFICATION', reason: 'not-ok' };
  return { ok: true, verification };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_REJECTED = 1;
const EXIT_USAGE = 2;

function parseCli(argv) {
  const options = { json: false, action: undefined, repo: undefined, revision: undefined, envelope: undefined, 'verification-path': undefined, vendor: undefined, thread: undefined, model: undefined };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--repo') { options.repo = argv[i + 1]; i += 1; continue; }
    if (arg === '--revision') { options.revision = argv[i + 1]; i += 1; continue; }
    if (arg === '--envelope') { options.envelope = argv[i + 1]; i += 1; continue; }
    if (arg === '--verification-path') { options.verificationPath = argv[i + 1]; i += 1; continue; }
    if (arg === '--vendor') { options.vendor = argv[i + 1]; i += 1; continue; }
    if (arg === '--thread') { options.thread = argv[i + 1]; i += 1; continue; }
    if (arg === '--model') { options.model = argv[i + 1]; i += 1; continue; }
    if (arg.startsWith('--')) continue;
    positional.push(arg);
  }
  if (positional.length > 0) options.action = positional[0];
  return options;
}

function emit(json, value) {
  if (json) process.stdout.write(JSON.stringify(value) + '\n');
  else process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function fail(code, message) {
  emit(true, { ok: false, error: { code, message } });
  return EXIT_USAGE;
}

function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (options.action === 'create') {
    if (options.envelope === undefined || options.vendor === undefined || options.thread === undefined) {
      return fail('E_USAGE', 'Obavezni: create --envelope, --vendor i --thread');
    }
    try {
      const record = createVerification({
        evidencePath: options.envelope,
        verificationPath: options.verificationPath,
        verifier: { vendor: options.vendor, thread: options.thread, model: options.model ?? null },
      });
      emit(options.json, record);
      return EXIT_OK;
    } catch (error) {
      if (!(error instanceof VerificationError)) throw error;
      return fail(error.code, error.message);
    }
  }
  if (options.action === 'check') {
    if (options.envelope === undefined) return fail('E_USAGE', 'Obavezan: --envelope');
    const verificationPath = options.verificationPath ?? options.envelope + '.verification.json';
    try {
      const result = checkVerification({ evidencePath: options.envelope, verificationPath });
      emit(options.json, result);
      return result.ok ? EXIT_OK : EXIT_REJECTED;
    } catch (error) {
      if (!(error instanceof VerificationError)) throw error;
      return fail(error.code, error.message);
    }
  }
  return fail('E_USAGE', 'Nepoznata komanda: ' + String(options.action));
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exitCode = main();
}
