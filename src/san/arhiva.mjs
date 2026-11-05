/**
 * Arhiviranje nisko rangiranih tumačenja — zaborav po prioritetu.
 *
 * Tumačenje se arhivira kada je imalo dovoljno pokušaja (attempted >= N) i
 * score < 0; status prelazi u "refuted", updated na now, ostala polja ostaju.
 * Fajl se ne briše; arhivirano nije kandidat za predlog ( traži
 * "open").
 *
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreOf, validateTumacenje } from './tumacenja.mjs';

const TUM_FILE = /^TUM-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}\.json$/;

/** Greška arhiviranja. */
export class ArhivaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArhivaError';
    this.code = code;
  }
}

function isoOf(now) {
  const value = now instanceof Date ? now : new Date(String(now));
  if (Number.isNaN(value.getTime())) throw new ArhivaError('E_USAGE', 'now nije validno vreme');
  return value.toISOString();
}

function countsOf(outcomes) {
  const counts = { confirmed: 0, refuted: 0, attempted: 0 };
  for (const outcome of outcomes) counts[outcome.verdict] += 1;
  return counts;
}

/**
 * Arhiviraj nisko rangirana tumačenja: attempted >= minAttempts i score < maxScore.
 */
export function archiveLowRated(options = {}) {
  const { tumacenjaRoot, now = new Date(), minAttempts = 3, maxScore = 0 } = options;
  if (typeof tumacenjaRoot !== 'string' || tumacenjaRoot === '') {
    throw new ArhivaError('E_TUMACENJA', 'tumacenjaRoot je obavezan');
  }
  if (!Number.isInteger(minAttempts) || minAttempts < 1) {
    throw new ArhivaError('E_USAGE', 'minAttempts mora biti ceo broj >= 1');
  }
  if (typeof maxScore !== 'number' || !Number.isFinite(maxScore)) {
    throw new ArhivaError('E_USAGE', 'maxScore mora biti broj');
  }
  const iso = isoOf(now);
  let stat;
  try {
    stat = statSync(tumacenjaRoot);
  } catch {
    throw new ArhivaError('E_TUMACENJA', 'tumacenjaRoot ne postoji: ' + path.resolve(tumacenjaRoot));
  }
  if (!stat.isDirectory()) throw new ArhivaError('E_TUMACENJA', 'tumacenjaRoot nije direktorijum');

  const files = readdirSync(tumacenjaRoot).filter(name => TUM_FILE.test(name)).sort();
  const records = [];
  for (const entry of files) {
    const file = path.join(tumacenjaRoot, entry);
    let value;
    try {
      value = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new ArhivaError('E_SCHEMA', 'tumačenje ' + entry + ' nije validan JSON: ' + error.message);
    }
    try {
      validateTumacenje(value);
    } catch (error) {
      throw new ArhivaError('E_SCHEMA', 'tumačenje ' + entry + ' ne prolazi šemu: ' + error.message);
    }
    records.push({ file, value });
  }

  const archived = [];
  const skipped = [];
  for (const { file, value } of records) {
    if (value.status === 'refuted') {
      skipped.push({ id: value.id, reason: 'already-archived' });
      continue;
    }
    const attempted = countsOf(value.outcomes).attempted;
    const score = scoreOf(countsOf(value.outcomes));
    if (attempted >= minAttempts && score < maxScore) {
      const record = { ...value, status: 'refuted', updated: iso };
      validateTumacenje(record);
      writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
      archived.push(value.id);
    }
  }
  archived.sort();
  return { archived, skipped, scanned: records.length };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_REJECTED = 1;
const EXIT_USAGE = 2;

function parseCli(argv) {
  const options = { json: false, tumacenja: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--tumacenja') { options.tumacenja = argv[i + 1]; i += 1; continue; }
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
  if (command !== 'archive') return fail('E_USAGE', 'Nepoznata komanda: ' + String(command));
  if (options.tumacenja === undefined) return fail('E_USAGE', 'Obavezan: --tumacenja');
  try {
    const result = archiveLowRated({ tumacenjaRoot: options.tumacenja });
    emit(options.json, result);
    return result.archived.length > 0 ? EXIT_OK : EXIT_REJECTED;
  } catch (error) {
    if (!(error instanceof ArhivaError)) throw error;
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
