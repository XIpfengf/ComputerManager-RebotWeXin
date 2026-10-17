/** Numeric ordering prevents part 10 from overtaking part 2 on replay. */
export function compareOutboxParts(a: { clientId: string; createdAtMs: number }, b: { clientId: string; createdAtMs: number }): number {
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
  const left = /^(.*):part:([1-9][0-9]*)$/u.exec(a.clientId);
  const right = /^(.*):part:([1-9][0-9]*)$/u.exec(b.clientId);
  if (left && right && left[1] === right[1]) return Number(left[2]) - Number(right[2]);
  return a.createdAtMs - b.createdAtMs || a.clientId.localeCompare(b.clientId);
}
