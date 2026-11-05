/**
 * Matrica nezavisnosti kao izvršna kapija.
 *
 * Nezavisnost se računa iz identiteta {vendor, thread, model}: broj različitih
 * dimenzija 0–3. Prag je 2 (drugi vendor + druga nit; isti model dozvoljen).
 * Polje "independence" u dokaznom omotaču ostaje informativno i
 * NE ulazi u ovu kapiju — kapija računa iz identiteta, pa falsifikovano polje
 * ne otvara kapiju.
 *
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const INDEPENDENCE_THRESHOLD = 2;
export const INDEPENDENCE_DIMENSIONS = ['vendor', 'thread', 'model'];

const IDENTITY_FIELDS = ['vendor', 'thread', 'model'];

/** Greška matrice nezavisnosti. */
export class IndependenceError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'IndependenceError';
    this.code = code;
    if (extra.independence !== undefined) this.independence = extra.independence;
    if (extra.dimensions !== undefined) this.dimensions = extra.dimensions;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateIdentity(value, label) {
  if (!isPlainObject(value)) throw new IndependenceError('E_SCHEMA', label + ' mora biti objekat');
  for (const key of Object.keys(value)) {
    if (!IDENTITY_FIELDS.includes(key)) {
      throw new IndependenceError('E_SCHEMA', label + ' ima nepoznato polje: ' + key);
    }
  }
  for (const field of IDENTITY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new IndependenceError('E_SCHEMA', label + ' nema polje: ' + field);
    }
  }
  if (typeof value.vendor !== 'string' || value.vendor.length < 1 || value.vendor.length > 64) {
    throw new IndependenceError('E_SCHEMA', label + '.vendor mora biti string 1–64');
  }
  for (const field of ['thread', 'model']) {
    if (value[field] !== null && (typeof value[field] !== 'string' || value[field].length < 1 || value[field].length > 64)) {
      throw new IndependenceError('E_SCHEMA', label + '.' + field + ' mora biti string 1–64 ili null');
    }
  }
}

function matrixCore(author, verifier) {
  if (verifier === null) {
    return { vendor: false, thread: false, model: false, independence: 0 };
  }
  const dimensions = {
    vendor: author.vendor !== verifier.vendor,
    thread: author.thread !== verifier.thread,
    model: author.model !== verifier.model,
  };
  return {
    vendor: dimensions.vendor,
    thread: dimensions.thread,
    model: dimensions.model,
    independence: Number(dimensions.vendor) + Number(dimensions.thread) + Number(dimensions.model),
  };
}

/** Matrica: koje se dimenzije razlikuju i koliko (0–3). */
export function independenceMatrix(author, verifier) {
  validateIdentity(author, 'author');
  if (verifier !== null) validateIdentity(verifier, 'verifier');
  return matrixCore(author, verifier);
}

/** Broj različitih dimenzija (0–3); verifier null → 0. */
export function independenceOf(author, verifier) {
  return independenceMatrix(author, verifier).independence;
}

/** Provera praga: vraća matricu + ok, ili baca E_INDEPENDENCE. */
export function assertIndependent(options = {}) {
  const { author, verifier, min = INDEPENDENCE_THRESHOLD } = options;
  if (!Number.isInteger(min) || min < 0 || min > 3) {
    throw new IndependenceError('E_USAGE', 'min mora biti ceo broj 0–3');
  }
  const matrix = independenceMatrix(author, verifier);
  if (matrix.independence < min) {
    throw new IndependenceError('E_INDEPENDENCE', 'Nezavisnost je ispod praga: ' + matrix.independence + ' < ' + min, {
      independence: matrix.independence,
      dimensions: { vendor: matrix.vendor, thread: matrix.thread, model: matrix.model },
    });
  }
  return { ...matrix, ok: true };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_REJECTED = 1;
const EXIT_USAGE = 2;

function parseCli(argv) {
  const options = { json: false, envelope: undefined, min: INDEPENDENCE_THRESHOLD };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--envelope') { options.envelope = argv[i + 1]; i += 1; continue; }
    if (arg === '--min') {
      const raw = argv[i + 1];
      options.min = Number(raw);
      if (!/^[0-9]$/.test(String(raw))) options.min = NaN;
      i += 1;
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

function fail(code, message) {
  emit(true, { ok: false, error: { code, message } });
  return EXIT_USAGE;
}

function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = parseCli(rest);
  if (command !== 'check') return fail('E_USAGE', 'Nepoznata komanda: ' + String(command));
  if (options.envelope === undefined) return fail('E_USAGE', 'Obavezan: --envelope');
  if (!Number.isInteger(options.min) || options.min < 0 || options.min > 3) {
    return fail('E_USAGE', '--min mora biti ceo broj 0–3');
  }
  let envelope;
  try {
    envelope = JSON.parse(readFileSync(options.envelope, 'utf8'));
  } catch (error) {
    return fail('E_SCHEMA', 'omotač se ne čita: ' + error.message);
  }
  try {
    const matrix = independenceMatrix(envelope.author, envelope.verifier);
    emit(options.json, { ...matrix, ok: matrix.independence >= options.min });
    return matrix.independence >= options.min ? EXIT_OK : EXIT_REJECTED;
  } catch (error) {
    if (!(error instanceof IndependenceError)) throw error;
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
