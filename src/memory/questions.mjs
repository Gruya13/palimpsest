/**
 * rok i eskalacija otvorenih pitanja.
 *
 * Pitanje sa statusom "open-question" ima vlasnika (owner_role), opcioni rok
 * (deadline) i eskalaciju (escalated_at): kada rok istekne, pitanje se eskalira
 * upisom escalated_at = now (idempotentno).
 *
 */
import { existsSync } from "node:fs";
import { listMemories, updateMemory, MemoryError } from "./memory.mjs";

/** Eskaliraj pitanja kojima je rok istekao; idempotentno, read-only za ostalo. */
export function escalateQuestions(options = {}) {
  const { memoryRoot, now = () => new Date().toISOString() } = options;
  if (typeof memoryRoot !== "string" || memoryRoot === "") throw new MemoryError("E_USAGE", "memoryRoot je obavezan");
  if (!existsSync(memoryRoot)) throw new MemoryError("E_MEMORY", "memoryRoot ne postoji: " + memoryRoot);
  const iso = now();
  const records = listMemories({ memoryRoot, level: "pitanja" });
  const escalated = [];
  let skipped = 0;
  for (const record of records) {
    if (record.status !== "open-question" || record.deadline === null
      || record.escalated_at !== null || String(record.deadline) >= iso) {
      skipped += 1;
      continue;
    }
    const updated = updateMemory({
      memoryRoot, level: "pitanja", id: record.id,
      changes: { escalated_at: iso }, now: () => iso,
    });
    escalated.push({ id: updated.id, deadline: updated.deadline, owner_role: updated.owner_role });
  }
  return { checked: records.length, escalated, skipped };
}
