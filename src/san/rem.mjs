/**
 * REM san — kapija i materijal.
 *
 * Deterministički deo odlučuje da li ima materijala za sanjanje: N novih
 * kandidata, M otvorenih pitanja, K ponavljanja obrasca, T vremena od
 * poslednjeg sna ili ručno. Read-only; sirovi san dolazi u.
 *
 * opcioni `trag` (mašinski zapis ishoda) prosleđuje se adapteru kao
 * `{ material, trag }`; prazan trag zaustavlja ciklus; bez traga ponašanje je
 * nepromenjeno. Trag je ulaz, ne dokaz — ne upisuje se u otisak.
 *
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMemories, MemoryError } from '../memory/memory.mjs';
import { TUMACENJA_KINDS, validateTumacenje, writeTumacenje } from './tumacenja.mjs';
import { validateTrag } from './trag.mjs';

const BASED_ON_ID = /^(TASK-[0-9]{1,6}|MEM-[0-9]{1,6}|TUM-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2})$/;
const TUM_ID = /^TUM-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}$/;
const TUM_FIELDS = ['version', 'id', 'kind', 'rule', 'based_on', 'how_to_test', 'origin_dream',
  'status', 'outcomes', 'score', 'priority', 'created', 'updated'];

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export const REM_VERSION = 1;
export const REM_THRESHOLDS = { newCandidates: 3, openQuestions: 2, repeatedPatterns: 2, hoursSinceDream: 24 };

const LEVELS = ['kandidati', 'saznanja', 'pravila', 'pitanja', 'povuceno'];
const MS_PER_HOUR = 3600000;

/** Greška REM sna. */
export class RemError extends Error {
  constructor(code, message, cause = undefined) {
    super(message);
    this.name = 'RemError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? NaN : parsed;
}

function isIsoUtc(value) {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function readHistory(memoryRoot) {
  const file = path.join(memoryRoot, 'dreams', 'rem.json');
  if (!existsSync(file)) return null;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new RemError('E_SCHEMA', 'rem.json se ne čita: ' + error.message);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new RemError('E_SCHEMA', 'rem.json nije validan JSON: ' + error.message);
  }
  const valid = value !== null && typeof value === 'object' && !Array.isArray(value)
    && value.version === REM_VERSION
    && isIsoUtc(value.lastDreamAt);
  if (!valid) throw new RemError('E_SCHEMA', 'rem.json ne prolazi šemu v1');
  return value;
}

function recordsByLevel(memoryRoot) {
  const out = {};
  for (const level of LEVELS) {
    try {
      out[level] = listMemories({ memoryRoot, level });
    } catch (error) {
      if (error instanceof MemoryError) throw new RemError('E_SCHEMA', 'memorija nije validna: ' + error.message);
      throw error;
    }
  }
  return out;
}

/**
 * Materijal za sanjanje iz stvarnog stanja; read-only i deterministički.
 */
export function dreamMaterial(options = {}) {
  const { memoryRoot, now = new Date(), lastDreamAt } = options;
  if (typeof memoryRoot !== 'string' || memoryRoot === '') throw new RemError('E_MEMORY', 'memoryRoot je obavezan');
  let stat;
  try {
    stat = statSync(memoryRoot);
  } catch {
    throw new RemError('E_MEMORY', 'memoryRoot ne postoji: ' + path.resolve(memoryRoot));
  }
  if (!stat.isDirectory()) throw new RemError('E_MEMORY', 'memoryRoot nije direktorijum');
  const nowMs = toMs(now);
  if (Number.isNaN(nowMs)) throw new RemError('E_USAGE', 'now nije validno vreme');

  const history = readHistory(memoryRoot);
  const source = lastDreamAt !== undefined && lastDreamAt !== null
    ? lastDreamAt
    : history !== null ? history.lastDreamAt : null;
  const lastMs = source === null ? null : toMs(source);
  if (source !== null && Number.isNaN(lastMs)) throw new RemError('E_SCHEMA', 'lastDreamAt nije validno vreme');

  const levels = recordsByLevel(memoryRoot);
  const newCandidates = levels.kandidati.filter(record => lastMs === null || Date.parse(record.created) > lastMs).length;
  const openQuestions = levels.pitanja.filter(record => record.status === 'open-question').length;

  const scopeCounts = new Map();
  for (const level of LEVELS) {
    for (const record of levels[level]) {
      for (const scope of new Set(record.scope)) {
        scopeCounts.set(scope, (scopeCounts.get(scope) || 0) + 1);
      }
    }
  }
  let repeatedPatterns = 0;
  for (const count of scopeCounts.values()) if (count >= 2) repeatedPatterns += 1;

  return {
    newCandidates,
    openQuestions,
    repeatedPatterns,
    hoursSinceDream: lastMs === null ? null : Math.max(0, Math.floor((nowMs - lastMs) / MS_PER_HOUR)),
  };
}

/**
 * Odluka o sanjanju: bilo koji ispunjen uslov (N/M/K/T/manual).
 */
export function shouldDream(options = {}) {
  const { material, thresholds = REM_THRESHOLDS, manual = false } = options;
  if (material === null || typeof material !== 'object') throw new RemError('E_USAGE', 'material je obavezan');
  const reasons = [];
  if (material.newCandidates >= thresholds.newCandidates) reasons.push('new-candidates');
  if (material.openQuestions >= thresholds.openQuestions) reasons.push('open-questions');
  if (material.repeatedPatterns >= thresholds.repeatedPatterns) reasons.push('repeated-patterns');
  if (material.hoursSinceDream === null || material.hoursSinceDream >= thresholds.hoursSinceDream) reasons.push('time');
  if (manual) reasons.push('manual');
  reasons.sort();
  return { dream: reasons.length > 0, reasons };
}

// ── : REM ciklus ───────────────────────────────────────────────────────

function fenceBlocks(output) {
  const blocks = [];
  const pattern = /```json\s*\n([\s\S]*?)\n```/g;
  let match;
  while ((match = pattern.exec(output)) !== null) blocks.push(match[1]);
  return blocks;
}

function isPlainItem(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function coarseValid(item) {
  if (!isPlainItem(item)) return false;
  if (!TUMACENJA_KINDS.includes(item.kind)) return false;
  if (typeof item.rule !== 'string' || item.rule.length < 1 || item.rule.length > 500) return false;
  if (typeof item.how_to_test !== 'string' || item.how_to_test.length < 1 || item.how_to_test.length > 500) return false;
  if (!Array.isArray(item.based_on) || item.based_on.length < 1 || item.based_on.length > 64) return false;
  if (!item.based_on.every(id => typeof id === 'string' && BASED_ON_ID.test(id))) return false;
  return true;
}

/**
 * Deterministički parser sirovog sna: prvi fenced JSON blok, nikad ne baca.
 */
export function parseDreamOutput(output) {
  if (typeof output !== 'string') return { extracted: [], rejected: [] };
  const blocks = fenceBlocks(output);
  if (blocks.length === 0) return { extracted: [], rejected: [] };
  let value;
  try {
    value = JSON.parse(blocks[0]);
  } catch (error) {
    return { extracted: [], rejected: [{ reason: 'invalid-json' }] };
  }
  if (!Array.isArray(value)) return { extracted: [], rejected: [{ reason: 'not-array' }] };
  return { extracted: value, rejected: [] };
}

function nextId(tumacenjaRoot, day, taken) {
  let nn = 1;
  for (;;) {
    const id = 'TUM-' + day + '-' + String(nn).padStart(2, '0');
    const file = path.join(tumacenjaRoot, id + '.json');
    if (!existsSync(file) && !taken.has(id)) return id;
    nn += 1;
  }
}

function isoOf(now) {
  const value = now instanceof Date ? now : new Date(String(now));
  if (Number.isNaN(value.getTime())) throw new RemError('E_USAGE', 'now nije validno vreme');
  return value.toISOString();
}

/**
 * REM ciklus: kapija → adapter → odbacivanje sirovog → parser → tumačenja → otisak.
 */
export async function remCycle(options = {}) {
  const { memoryRoot, tumacenjaRoot, dream, now = new Date(), manual = false, trag, basedOnRoots } = options;
  if (typeof tumacenjaRoot !== 'string' || tumacenjaRoot === '') throw new RemError('E_MEMORY', 'tumacenjaRoot je obavezan');
  try {
    if (!statSync(tumacenjaRoot).isDirectory()) throw new RemError('E_MEMORY', 'tumacenjaRoot nije direktorijum');
  } catch (error) {
    if (error instanceof RemError) throw error;
    throw new RemError('E_MEMORY', 'tumacenjaRoot ne postoji: ' + path.resolve(tumacenjaRoot));
  }
  if (typeof dream !== 'function') throw new RemError('E_USAGE', 'dream adapter je obavezan');
  if (trag !== undefined) {
    const tragErrors = validateTrag(trag);
    if (tragErrors.length > 0) throw new RemError('E_SCHEMA', 'Nevalidan trag: ' + tragErrors.join('; '));
  }
  const iso = isoOf(now);
  const material = dreamMaterial({ memoryRoot, now: iso });
  const decision = shouldDream({ material, manual });
  if (trag !== undefined && trag.tasks.length === 0) {
    return { dreamed: false, reason: 'empty-trag', material, decision };
  }
  if (!decision.dream) return { dreamed: false, reason: 'no-material', material, decision };

  const started = Date.now();
  let dreamResult;
  try {
    dreamResult = await dream(trag === undefined ? { material } : { material, trag });
  } catch (error) {
    throw new RemError('E_DREAM', 'Adapter sna je pao: ' + (error && error.message ? error.message : String(error)), error);
  }
  if (dreamResult === null || typeof dreamResult !== 'object'
    || typeof dreamResult.output !== 'string' || typeof dreamResult.model !== 'string') {
    throw new RemError('E_DREAM', 'Adapter sna mora vratiti { output: string, model: string }');
  }
  const output = dreamResult.output;
  const model = dreamResult.model;
  const durationMs = Date.now() - started;
  const hash = sha256(output);
  const originDream = 'dream-' + hash.slice(0, 8);
  const day = iso.slice(0, 10);
  const parsed = parseDreamOutput(output);
  const tumacenja = [];
  const rejected = [...parsed.rejected];
  const taken = new Set();
  for (let index = 0; index < parsed.extracted.length; index += 1) {
    const item = parsed.extracted[index];
    if (!coarseValid(item)) { rejected.push({ reason: 'invalid-item', index }); continue; }
 // based_on mora pokazivati na postojeće zapise (kada su rootovi dati).
    if (basedOnRoots !== undefined) {
      const missing = basedOnMissing(item.based_on, basedOnRoots, tumacenjaRoot);
      if (missing !== null) { rejected.push({ reason: 'based-on-missing', index, id: missing }); continue; }
    }
    const id = nextId(tumacenjaRoot, day, taken);
    taken.add(id);
    const candidate = {
      version: 1, id, kind: item.kind, rule: item.rule, based_on: item.based_on,
      how_to_test: item.how_to_test, origin_dream: originDream, status: 'open', outcomes: [],
      score: 0, priority: null, created: iso, updated: iso,
    };
    for (const key of Object.keys(item)) if (!TUM_FIELDS.includes(key)) { /* nepoznata polja se ignorišu */ }
    try {
      validateTumacenje(candidate);
      tumacenja.push(writeTumacenje({ tumacenjaRoot, tumacenje: candidate, now: () => iso }));
    } catch (error) {
      rejected.push({ reason: 'invalid-item', index, code: error && error.code });
    }
  }
  const trace = { version: REM_VERSION, lastDreamAt: iso, model, hash, durationMs,
    extracted: tumacenja.length, rejected: rejected.length };
  try {
    const dreamsDir = path.join(memoryRoot, 'dreams');
    mkdirSync(dreamsDir, { recursive: true });
    writeFileSync(path.join(dreamsDir, 'rem.json'), JSON.stringify(trace, null, 2) + '\n', 'utf8');
  } catch (error) {
    throw new RemError('E_WRITE', 'Otisak sna nije upisan: ' + error.message);
  }
  return { dreamed: true, material, decision, tumacenja, rejected, trace };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_REJECTED = 1;
const EXIT_USAGE = 2;

function basedOnMissing(ids, roots, tumacenjaRoot) {
  const memoryRoot = roots === null || typeof roots !== 'object' ? undefined : roots.memoryRoot;
  const tasksRoot = roots === null || typeof roots !== 'object' ? undefined : roots.tasksRoot;
  const levels = ['kandidati', 'saznanja', 'pravila', 'pitanja', 'povuceno'];
  const validFile = file => {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      return value !== null && typeof value === 'object' && typeof value.id === 'string';
    } catch { return false; }
  };
  for (const id of ids) {
    if (id.startsWith('MEM-')) {
      if (typeof memoryRoot !== 'string') return id;
      if (!levels.some(level => validFile(path.join(memoryRoot, level, id + '.json')))) return id;
    } else if (id.startsWith('TASK-')) {
      if (typeof tasksRoot !== 'string') return id;
      if (!validFile(path.join(tasksRoot, id + '.json'))) return id;
    } else if (!validFile(path.join(tumacenjaRoot, id + '.json'))) {
      return id;
    }
  }
  return null;
}

function parseCli(argv) {
  const options = { json: false, root: undefined, tumacenja: undefined, tasks: undefined, dreamFile: undefined, tragFile: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--root') { options.root = argv[i + 1]; i += 1; continue; }
    if (arg === '--tumacenja') { options.tumacenja = argv[i + 1]; i += 1; continue; }
    if (arg === '--dream-file') { options.dreamFile = argv[i + 1]; i += 1; continue; }
    if (arg === '--tasks') { options.tasks = argv[i + 1]; i += 1; continue; }
    if (arg === '--trag-file') { options.tragFile = argv[i + 1]; i += 1; continue; }
  }
  return options;
}

function readDreamFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new RemError('E_SCHEMA', 'dream-file se ne čita: ' + error.message);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new RemError('E_SCHEMA', 'dream-file nije validan JSON: ' + error.message);
  }
  if (value === null || typeof value !== 'object' || typeof value.output !== 'string' || typeof value.model !== 'string') {
    throw new RemError('E_SCHEMA', 'dream-file mora biti { output: string, model: string }');
  }
  return { output: value.output, model: value.model };
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
  const options = parseCli(rest);
  const fail = (code, message) => {
    emit(true, { ok: false, error: { code, message } });
    return EXIT_USAGE;
  };
  if (command === 'gate') {
    if (options.root === undefined) return fail('E_USAGE', 'Obavezan: --root');
    try {
      const material = dreamMaterial({ memoryRoot: options.root });
      const decision = shouldDream({ material });
      emit(options.json, { material, decision });
      return decision.dream ? EXIT_OK : EXIT_REJECTED;
    } catch (error) {
      if (!(error instanceof RemError)) throw error;
      return fail(error.code, error.message);
    }
  }
  if (command === 'run') {
    if (options.root === undefined || options.tumacenja === undefined || options.dreamFile === undefined) {
      return fail('E_USAGE', 'Obavezni: --root, --tumacenja i --dream-file');
    }
    let trag;
    if (options.tragFile !== undefined) {
      let text;
      try {
        text = readFileSync(options.tragFile, 'utf8');
      } catch (error) {
        emit(true, { ok: false, error: { code: 'E_SCHEMA', message: 'trag-file se ne čita: ' + error.message } });
        return EXIT_REJECTED;
      }
      try {
        trag = JSON.parse(text);
      } catch (error) {
        emit(true, { ok: false, error: { code: 'E_SCHEMA', message: 'trag-file nije validan JSON: ' + error.message } });
        return EXIT_REJECTED;
      }
      const tragErrors = validateTrag(trag);
      if (tragErrors.length > 0) {
        emit(true, { ok: false, error: { code: 'E_SCHEMA', message: 'Nevalidan trag: ' + tragErrors.join('; ') } });
        return EXIT_REJECTED;
      }
    }
    try {
      const adapter = readDreamFile(options.dreamFile);
      const result = await remCycle({
        memoryRoot: options.root, tumacenjaRoot: options.tumacenja,
        dream: async () => adapter, trag,
        basedOnRoots: options.tasks === undefined ? undefined
          : { memoryRoot: options.root, tasksRoot: options.tasks },
      });
      emit(options.json, result);
      return result.dreamed ? EXIT_OK : EXIT_REJECTED;
    } catch (error) {
      if (!(error instanceof RemError)) throw error;
      return fail(error.code, error.message);
    }
  }
  return fail('E_USAGE', 'Nepoznata komanda: ' + String(command));
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write((error && error.stack ? error.stack : String(error)) + '\n');
    process.exitCode = EXIT_USAGE;
  });
}
