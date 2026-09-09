/**
 * Wave-packing rules, shared by the live scheduler (graph.ts pickWave) and
 * the plan preview (spec.ts previewWaves) so `plan` predicts exactly what
 * `run` will do.
 *
 * Ported from Commander's scripts/agent/schedule.ts, whose rules were paid
 * for in merge conflicts:
 *   1. A serial spec (`serial: true`, or touching a `scheduling.serialPaths`
 *      prefix such as `migrations/`) runs alone in its wave and before any
 *      non-serial spec: it moves the base for everyone else.
 *   2. Two specs that name the same contract never share a wave, whatever
 *      paths they touch.
 *   3. Two specs that touch the same path never share a wave, unless both
 *      declare contracts and none overlap: then the owner has stated they
 *      change different things, and the shared file is allowed.
 *   4. Otherwise a wave fills to the coder count in priority order.
 */

export interface Schedulable {
  id: string;
  priority: number;
  touches: string[];
  contracts?: string[];
  serial?: boolean;
}

export interface SchedulingRules {
  serialPaths: string[];
}

const normalizePath = (p: string) =>
  p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
const normalizeContract = (c: string) => c.trim().toLowerCase();

export function isSerial(spec: Schedulable, rules: SchedulingRules): boolean {
  if (spec.serial) return true;
  const prefixes = rules.serialPaths.map(normalizePath);
  return spec.touches.some((t) => {
    const p = normalizePath(t);
    return prefixes.some((pre) => p === pre || p.startsWith(pre));
  });
}

/** Two touch entries overlap when equal, or when one is a directory prefix (`dir/`) of the other. */
function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith("/") && b.startsWith(a)) return true;
  if (b.endsWith("/") && a.startsWith(b)) return true;
  return false;
}

/** Why `a` and `b` cannot share a wave, or null when they can. */
export function collides(a: Schedulable, b: Schedulable): string | null {
  const ca = new Set((a.contracts ?? []).map(normalizeContract));
  const cb = (b.contracts ?? []).map(normalizeContract);
  const sharedContracts = cb.filter((c) => ca.has(c));
  if (sharedContracts.length) {
    return `shares contract ${sharedContracts.join(", ")} with ${b.id}`;
  }
  const ta = a.touches.map(normalizePath);
  const tb = b.touches.map(normalizePath);
  const sharedPaths = ta.filter((x) => tb.some((y) => pathsOverlap(x, y)));
  if (!sharedPaths.length) return null;
  if (ca.size > 0 && cb.length > 0) return null; // distinct contracts on both sides
  return `shares ${sharedPaths.join(", ")} with ${b.id}, no contracts separate them`;
}

const byPriority = <T extends Schedulable>(a: T, b: T) =>
  a.priority - b.priority || a.id.localeCompare(b.id);

/**
 * Pick the next wave from runnable candidates (dependencies already
 * satisfied). Serial candidates go first, one at a time; otherwise pack
 * non-colliding candidates up to `slots`.
 */
export function packWave<T extends Schedulable>(
  candidates: T[],
  slots: number,
  rules: SchedulingRules,
): T[] {
  const sorted = [...candidates].sort(byPriority);
  const serial = sorted.find((c) => isSerial(c, rules));
  if (serial) return [serial];
  const wave: T[] = [];
  for (const c of sorted) {
    if (wave.length >= slots) break;
    if (wave.some((m) => collides(c, m) !== null)) continue;
    wave.push(c);
  }
  return wave;
}
