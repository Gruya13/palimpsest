/**
 * Dokazni omotač, verzija 1 — šema, validacija i kanonska serijalizacija.
 *
 *
 * Ovaj modul ne zna ništa o git-u, izvršavanju ni kapijama — on samo definiše
 * oblik dokaza. Operacije lock/run/check/stale dolaze u.
 */
import { createHash } from 'node:crypto';

const FIELDS = [
  'version', 'revision', 'claims', 'checks', 'author', 'verifier',
  'independence', 'falsifier', 'lesson', 'stale',
];
const IDENTITY_FIELDS = ['vendor', 'thread', 'model'];
const CHECK_FIELDS = [
  'kind', 'claim', 'command', 'exitCode', 'verdict', 'artifact',
  'outputSha256', 'durationMs', 'executedAt',
];
const ARTIFACT_FIELDS = ['path', 'sha256'];
const KINDS = ['citation', 'reproduction', 'test-set', 'source'];
const VERDICTS = ['ok', 'failed', 'unexecuted'];
const CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
// Spec: tačno YYYY-MM-DDTHH:mm:ss.sssZ. Proširene (6-cifrene) godine
// new Date prihvata, ali spec ih ne dopušta — zato regex pre Date provere.
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Greška validacije: nosi sve nalaze, a code/path prve. */
export class EvidenceError extends Error {
  constructor(errors) {
    const list = Array.isArray(errors) ? errors : [];
    const first = list[0] || { code: 'E_ERROR', path: '$', message: 'Nevalidan omotač.' };
    super(first.message);
    this.name = 'EvidenceError';
    this.errors = list;
    this.code = first.code;
    this.path = first.path;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function fieldPath(base, key) {
  return base === '' ? key : base + '.' + key;
}

function add(errors, path, code, message) {
  errors.push({ path, code, message });
}

function unknownFields(errors, object, path, allowed) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      add(errors, fieldPath(path, key), 'E_UNKNOWN_FIELD', 'Polje nije deo šeme v1: ' + fieldPath(path, key));
    }
  }
}

/**
 * Obavezno polje: nedostaje ili je undefined. Vraća false kad polje nije
 * prisutno, da pozivalac ne validira dalje.
 */
function required(errors, object, key, path) {
  if (!hasOwn(object, key) || object[key] === undefined) {
    add(errors, path, 'E_MISSING', 'Obavezno polje nedostaje: ' + path);
    return false;
  }
  return true;
}

/** Null je dozvoljen samo na nullable poljima; inače je nedostatak. */
function requiredNonNullable(errors, object, key, path) {
  if (!hasOwn(object, key) || object[key] === undefined || object[key] === null) {
    add(errors, path, 'E_MISSING', 'Obavezno polje nedostaje ili je null: ' + path);
    return false;
  }
  return true;
}

function stringField(errors, value, path, min, max) {
  if (typeof value !== 'string') {
    add(errors, path, 'E_TYPE', 'Očekivan string: ' + path);
    return;
  }
  if (value.length < min || value.length > max) {
    add(errors, path, 'E_RANGE', 'Dužina van granica [' + min + ', ' + max + ']: ' + path);
  }
}

function nullableStringField(errors, value, path, min, max) {
  if (value === null) return;
  stringField(errors, value, path, min, max);
}

function hashField(errors, value, path, nullable) {
  if (nullable && value === null) return;
  if (typeof value !== 'string') {
    add(errors, path, 'E_TYPE', 'Očekivan heks string: ' + path);
    return;
  }
  if (!HEX64.test(value)) {
    add(errors, path, 'E_HASH', 'Očekivan sha256 (64 lowercase hex): ' + path);
  }
}

function integerField(errors, value, path) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    add(errors, path, 'E_TYPE', 'Očekivan ceo broj: ' + path);
    return false;
  }
  return true;
}

function validateIdentity(errors, value, path) {
  if (!isPlainObject(value)) {
    add(errors, path, 'E_TYPE', 'Identitet je objekat: ' + path);
    return;
  }
  unknownFields(errors, value, path, IDENTITY_FIELDS);
  if (requiredNonNullable(errors, value, 'vendor', fieldPath(path, 'vendor'))) {
    stringField(errors, value.vendor, fieldPath(path, 'vendor'), 1, 64);
  }
  if (required(errors, value, 'thread', fieldPath(path, 'thread'))) {
    nullableStringField(errors, value.thread, fieldPath(path, 'thread'), 1, 64);
  }
  if (required(errors, value, 'model', fieldPath(path, 'model'))) {
    nullableStringField(errors, value.model, fieldPath(path, 'model'), 1, 128);
  }
}

function validateArtifact(errors, value, path) {
  if (value === null) return;
  if (!isPlainObject(value)) {
    add(errors, path, 'E_TYPE', 'Artifact je objekat ili null: ' + path);
    return;
  }
  unknownFields(errors, value, path, ARTIFACT_FIELDS);
  if (requiredNonNullable(errors, value, 'path', fieldPath(path, 'path'))) {
    stringField(errors, value.path, fieldPath(path, 'path'), 1, 1024);
  }
  if (requiredNonNullable(errors, value, 'sha256', fieldPath(path, 'sha256'))) {
    hashField(errors, value.sha256, fieldPath(path, 'sha256'), false);
  }
}

function validateExecutedAt(errors, value, path) {
  if (value === null) return;
  if (typeof value !== 'string') {
    add(errors, path, 'E_TYPE', 'Očekivan ISO string: ' + path);
    return;
  }
  if (!ISO_UTC.test(value)) {
    add(errors, path, 'E_ISO', 'Očekivan tačan Date#toISOString() format: ' + path);
    return;
  }
  let iso = null;
  try {
    iso = new Date(value).toISOString();
  } catch {
    iso = null;
  }
  if (iso !== value) {
    add(errors, path, 'E_ISO', 'Očekivan stvaran datum u Date#toISOString() formatu: ' + path);
  }
}

function validateCheck(errors, value, path, claims) {
  if (!isPlainObject(value)) {
    add(errors, path, 'E_TYPE', 'Check je objekat: ' + path);
    return;
  }
  unknownFields(errors, value, path, CHECK_FIELDS);

  if (requiredNonNullable(errors, value, 'kind', fieldPath(path, 'kind'))) {
    if (typeof value.kind !== 'string') add(errors, fieldPath(path, 'kind'), 'E_TYPE', 'Očekivan string: ' + fieldPath(path, 'kind'));
    else if (!KINDS.includes(value.kind)) add(errors, fieldPath(path, 'kind'), 'E_ENUM', 'Nepoznat kind: ' + value.kind);
  }

  if (requiredNonNullable(errors, value, 'claim', fieldPath(path, 'claim'))) {
    if (typeof value.claim !== 'string') {
      add(errors, fieldPath(path, 'claim'), 'E_TYPE', 'Očekivan string: ' + fieldPath(path, 'claim'));
    } else if (Array.isArray(claims) && !claims.includes(value.claim)) {
      add(errors, fieldPath(path, 'claim'), 'E_CHECK_CLAIM', 'Check pokazuje na tvrdnju koje nema: ' + value.claim);
    }
  }

  if (requiredNullableField(errors, value, 'command', path)) {
    stringField(errors, value.command, fieldPath(path, 'command'), 1, 2000);
  }

  if (requiredNonNullable(errors, value, 'exitCode', fieldPath(path, 'exitCode'))) {
    integerField(errors, value.exitCode, fieldPath(path, 'exitCode'));
  }

  if (requiredNonNullable(errors, value, 'verdict', fieldPath(path, 'verdict'))) {
    if (typeof value.verdict !== 'string') add(errors, fieldPath(path, 'verdict'), 'E_TYPE', 'Očekivan string: ' + fieldPath(path, 'verdict'));
    else if (!VERDICTS.includes(value.verdict)) add(errors, fieldPath(path, 'verdict'), 'E_ENUM', 'Nepoznat verdict: ' + value.verdict);
  }

  if (required(errors, value, 'artifact', fieldPath(path, 'artifact'))) {
    validateArtifact(errors, value.artifact, fieldPath(path, 'artifact'));
  }

  if (required(errors, value, 'outputSha256', fieldPath(path, 'outputSha256'))) {
    if (value.outputSha256 !== null && typeof value.outputSha256 !== 'string') {
      add(errors, fieldPath(path, 'outputSha256'), 'E_TYPE', 'Očekivan heks string ili null: ' + fieldPath(path, 'outputSha256'));
    } else if (value.outputSha256 !== null) {
      hashField(errors, value.outputSha256, fieldPath(path, 'outputSha256'), true);
    }
  }

  if (required(errors, value, 'durationMs', fieldPath(path, 'durationMs'))) {
    if (value.durationMs !== null) {
      if (integerField(errors, value.durationMs, fieldPath(path, 'durationMs'))) {
        if (value.durationMs < 0) add(errors, fieldPath(path, 'durationMs'), 'E_RANGE', 'durationMs mora biti >= 0');
      }
    }
  }

  if (required(errors, value, 'executedAt', fieldPath(path, 'executedAt'))) {
    validateExecutedAt(errors, value.executedAt, fieldPath(path, 'executedAt'));
  }
}

/** command je obavezan i ne sme biti null (nije nullable), ali null daje E_MISSING. */
function requiredNullableField(errors, object, key, base) {
  const path = fieldPath(base, key);
  if (!hasOwn(object, key) || object[key] === undefined || object[key] === null) {
    add(errors, path, 'E_MISSING', 'Obavezno polje nedostaje ili je null: ' + path);
    return false;
  }
  return true;
}

/**
 * Da li JSON tekst ima duplikat ključa u bilo kom objektu (bilo koje dubine)?
 * JSON.parse duplikate tiho spaja (poslednji pobeđuje), pa se tekst proverava
 * posebno. Ulaz je već validan JSON, što pojednostavljuje skener.
 */
export function hasDuplicateObjectKeys(text) {
  const stack = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      let escaped = false;
      while (j < text.length) {
        const c = text[j];
        if (escaped) { escaped = false; j += 1; continue; }
        if (c === '\\') { escaped = true; j += 1; continue; }
        if (c === '"') break;
        j += 1;
      }
      const top = stack[stack.length - 1];
      if (top && top.type === 'object' && top.expectKey) {
        let key = null;
        try { key = JSON.parse(text.slice(i, j + 1)); } catch { key = null; }
        if (key !== null) {
          if (top.keys.has(key)) return true;
          top.keys.add(key);
        }
        top.expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (ch === '{') { stack.push({ type: 'object', keys: new Set(), expectKey: true }); i += 1; continue; }
    if (ch === '[') { stack.push({ type: 'array' }); i += 1; continue; }
    if (ch === '}' || ch === ']') { stack.pop(); i += 1; continue; }
    if (ch === ',') {
      const top = stack[stack.length - 1];
      if (top && top.type === 'object') top.expectKey = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return false;
}

function judge(errors, path, value) {
 // 1) version
  if (requiredNonNullable(errors, value, 'version', 'version')) {
    if (typeof value.version !== 'number' || !Number.isInteger(value.version)) {
      add(errors, 'version', 'E_TYPE', 'version mora biti ceo broj');
    } else if (value.version !== 1) {
      add(errors, 'version', 'E_ENUM', 'Podržana je samo verzija 1');
    }
  }

 // 2) revision
  if (requiredNonNullable(errors, value, 'revision', 'revision')) {
    if (typeof value.revision !== 'string') add(errors, 'revision', 'E_TYPE', 'revision mora biti string');
    else if (!HEX40.test(value.revision)) add(errors, 'revision', 'E_REVISION', 'revision mora biti pun git SHA (40 lowercase hex)');
  }

 // 3) claims
  if (requiredNonNullable(errors, value, 'claims', 'claims')) {
    if (!Array.isArray(value.claims)) {
      add(errors, 'claims', 'E_TYPE', 'claims mora biti niz');
    } else if (value.claims.length === 0) {
      add(errors, 'claims', 'E_CLAIMS', 'claims ne sme biti prazan');
    } else {
      const seen = new Set();
      for (const claim of value.claims) {
        if (typeof claim !== 'string') { add(errors, 'claims', 'E_TYPE', 'Svaki claim je string'); continue; }
        if (!CLAIM_ID.test(claim)) { add(errors, 'claims', 'E_CLAIMS', 'Nevalidan claim ID: ' + claim); continue; }
        if (seen.has(claim)) { add(errors, 'claims', 'E_CLAIMS', 'Duplikat claim ID: ' + claim); continue; }
        seen.add(claim);
      }
    }
  }

 // 4) checks
  if (requiredNonNullable(errors, value, 'checks', 'checks')) {
    if (!Array.isArray(value.checks)) {
      add(errors, 'checks', 'E_TYPE', 'checks mora biti niz');
    } else if (value.checks.length === 0) {
      add(errors, 'checks', 'E_RANGE', 'checks ne sme biti prazan');
    } else {
      const claims = Array.isArray(value.claims) ? value.claims.filter(c => typeof c === 'string') : [];
      value.checks.forEach((check, index) => validateCheck(errors, check, 'checks[' + index + ']', claims));
    }
  }

 // 5) author
  if (requiredNonNullable(errors, value, 'author', 'author')) {
    validateIdentity(errors, value.author, 'author');
  }

 // 6) verifier
  if (required(errors, value, 'verifier', 'verifier')) {
    if (value.verifier !== null) validateIdentity(errors, value.verifier, 'verifier');
  }

 // 7) independence
  let independenceValid = false;
  if (requiredNonNullable(errors, value, 'independence', 'independence')) {
    if (typeof value.independence !== 'number') {
      add(errors, 'independence', 'E_TYPE', 'independence mora biti broj');
    } else if (!Number.isFinite(value.independence) || value.independence < 0 || value.independence > 1) {
      add(errors, 'independence', 'E_INDEPENDENCE', 'independence mora biti konacan broj u [0, 1]');
    } else {
      independenceValid = true;
    }
  }

 // 8) falsifier
  if (required(errors, value, 'falsifier', 'falsifier')) {
    if (value.falsifier !== null) stringField(errors, value.falsifier, 'falsifier', 1, 2000);
  }

 // 9) lesson
  if (required(errors, value, 'lesson', 'lesson')) {
    if (value.lesson !== null) stringField(errors, value.lesson, 'lesson', 1, 500);
  }

 // 10) stale
  if (requiredNonNullable(errors, value, 'stale', 'stale')) {
    if (typeof value.stale !== 'boolean') add(errors, 'stale', 'E_TYPE', 'stale mora biti boolean');
  }

 // Pokrivenost u oba smera.
  const claimsList = Array.isArray(value.claims) ? value.claims : null;
  const checksList = Array.isArray(value.checks) ? value.checks : null;
  if (claimsList && checksList) {
    const covered = new Set(checksList.filter(isPlainObject).map(c => c.claim));
    claimsList.forEach((claim, index) => {
      if (!covered.has(claim)) add(errors, 'claims[' + index + ']', 'E_CLAIM_NO_CHECK', 'Tvrdnja bez ijedne provere: ' + claim);
    });
  }

 // Bez verifikatora nema nezavisnosti.
  if (value.verifier === null && independenceValid && value.independence !== 0) {
    add(errors, 'independence', 'E_VERIFIER', 'verifier je null, pa independence mora biti 0');
  }
}

/** Validacija bez bacanja: vraća sve nalaze. */
export function validateEnvelope(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    add(errors, '$', 'E_NOT_OBJECT', 'Omotač mora biti JSON objekat');
    return { ok: false, errors };
  }
  unknownFields(errors, value, '', FIELDS);
  judge(errors, '$', value);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Kanonski oblik: ključevi objekata sortirani rekurzivno, nizovi ostaju kakvi jesu. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

/** Kanonski JSON tekst: sortirani ključevi, indent 2, jedan završni novi red. */
export function serializeEnvelope(envelope) {
  const result = validateEnvelope(envelope);
  if (!result.ok) throw new EvidenceError(result.errors);
  return JSON.stringify(canonicalize(envelope), null, 2) + '\n';
}

/** Parsira i validira; baca EvidenceError sa svim nalazima. */
export function parseEnvelope(text) {
  if (typeof text !== 'string') {
    throw new EvidenceError([{ path: '$', code: 'E_JSON', message: 'Ulaz mora biti JSON tekst' }]);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new EvidenceError([{ path: '$', code: 'E_JSON', message: 'Nevalidan JSON: ' + error.message }]);
  }
  if (hasDuplicateObjectKeys(text)) {
    throw new EvidenceError([{ path: '$', code: 'E_JSON', message: 'JSON sadrži duplikat ključa' }]);
  }
  const result = validateEnvelope(value);
  if (!result.ok) throw new EvidenceError(result.errors);
  return value;
}

/** sha256 kanonske serijalizacije, lowercase hex. */
export function hashEnvelope(envelope) {
  return createHash('sha256').update(serializeEnvelope(envelope), 'utf8').digest('hex');
}
