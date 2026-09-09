/**
 * PR specs: the static storage layer for the work queue.
 *
 * Each PR is one markdown file in the specs directory:
 *
 *   ---
 *   id: 001-footer-year
 *   title: Show the current year in the footer
 *   priority: 2            # 1 (highest) .. 5 (lowest), default 3
 *   depends_on: []         # ids that must be merged first
 *   touches: [src/components/Footer.tsx]   # paths this PR is expected to edit
 *   ---
 *   (markdown body: the full instructions a coding agent reads)
 *
 * Only the frontmatter enters orchestrator state. The body is read from disk
 * by exactly one coding agent, once. That is what keeps the orchestrator's
 * context tiny no matter how many PRs are queued: it schedules by metadata,
 * it never reads code or spec bodies itself.
 */
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import { packWave, type SchedulingRules } from "./scheduling.js";

export const SpecFrontmatterSchema = z.object({
  id: z
    .string()
    .max(50, "id must be at most 50 characters so branch names stay short")
    .regex(
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      "id must be lowercase letters and digits, single dashes between words",
    ),
  title: z.string().min(1),
  priority: z.number().int().min(1).max(5).default(3),
  depends_on: z.array(z.string()).default([]),
  touches: z.array(z.string()).default([]),
  /** Named interfaces this PR changes (an API, a schema). Two PRs sharing one never run together. */
  contracts: z.array(z.string()).default([]),
  /** Run alone in its wave, before anything else (e.g. a migration). */
  serial: z.boolean().default(false),
});

export interface PrSpec {
  id: string;
  title: string;
  priority: number;
  dependsOn: string[];
  /** Path hints. Two PRs that touch the same path are not run concurrently. */
  touches: string[];
  contracts: string[];
  serial: boolean;
  /** Absolute path of the spec file; the coder reads the body from here. */
  specPath: string;
  /** Length of the markdown body, used to flag oversized or empty specs. */
  bodyChars: number;
}

export function parseSpecFile(filePath: string, raw: string): PrSpec {
  const { data, content } = matter(raw);
  const fm = SpecFrontmatterSchema.parse(data);
  return {
    id: fm.id,
    title: fm.title,
    priority: fm.priority,
    dependsOn: fm.depends_on,
    touches: fm.touches,
    contracts: fm.contracts,
    serial: fm.serial,
    specPath: path.resolve(filePath),
    bodyChars: content.trim().length,
  };
}

/** Load every *.md file in the specs directory, sorted by file name. */
export function loadSpecs(specsDir: string): PrSpec[] {
  if (!fs.existsSync(specsDir)) {
    throw new Error(`Specs directory not found: ${specsDir}`);
  }
  return fs
    .readdirSync(specsDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const filePath = path.join(specsDir, f);
      try {
        return parseSpecFile(filePath, fs.readFileSync(filePath, "utf8"));
      } catch (err) {
        throw new Error(`Invalid spec ${f}: ${(err as Error).message}`, {
          cause: err,
        });
      }
    });
}

/**
 * Return human-readable problems: duplicate ids, unknown dependencies,
 * dependency cycles, empty bodies. An empty array means the set is runnable.
 */
export function validateSpecs(specs: PrSpec[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const s of specs) {
    if (ids.has(s.id)) problems.push(`Duplicate id "${s.id}"`);
    ids.add(s.id);
    if (s.bodyChars === 0) problems.push(`Spec "${s.id}" has an empty body`);
    for (const dep of s.dependsOn) {
      if (dep === s.id) problems.push(`Spec "${s.id}" depends on itself`);
      else if (!specs.some((o) => o.id === dep))
        problems.push(`Spec "${s.id}" depends on unknown id "${dep}"`);
    }
  }
  if (problems.length === 0) {
    const ordered = topologicalOrder(specs);
    if (ordered.length !== specs.length) {
      const stuck = specs.filter((s) => !ordered.includes(s)).map((s) => s.id);
      problems.push(`Dependency cycle among: ${stuck.join(", ")}`);
    }
  }
  return problems;
}

/**
 * Kahn's algorithm. Dependencies come first; among ready specs, higher
 * priority (lower number) first, then id for a stable order. Specs caught in
 * a cycle are omitted, which validateSpecs() reports.
 */
export function topologicalOrder(specs: PrSpec[]): PrSpec[] {
  const byId = new Map(specs.map((s) => [s.id, s]));
  const remainingDeps = new Map(
    specs.map((s) => [s.id, new Set(s.dependsOn.filter((d) => byId.has(d)))]),
  );
  const ordered: PrSpec[] = [];
  const placed = new Set<string>();
  while (ordered.length < specs.length) {
    const ready = specs
      .filter((s) => !placed.has(s.id) && remainingDeps.get(s.id)?.size === 0)
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    if (ready.length === 0) break; // cycle
    const next = ready[0];
    ordered.push(next);
    placed.add(next.id);
    for (const deps of remainingDeps.values()) deps.delete(next.id);
  }
  return ordered;
}

/**
 * Static preview of how the scheduler would batch the queue with N coders,
 * assuming every PR succeeds. Uses the same packing rules as the live
 * scheduler (scheduling.ts), so this matches a real run when nothing fails.
 */
export function previewWaves(
  specs: PrSpec[],
  concurrency: number,
  alreadyMerged: Iterable<string> = [],
  rules: SchedulingRules = { serialPaths: [] },
): PrSpec[][] {
  const merged = new Set(alreadyMerged);
  const remaining = topologicalOrder(specs).filter((s) => !merged.has(s.id));
  const waves: PrSpec[][] = [];
  while (remaining.length > 0) {
    const candidates = remaining.filter((s) =>
      s.dependsOn.every((d) => merged.has(d)),
    );
    const wave = packWave(candidates, concurrency, rules);
    if (wave.length === 0) {
      throw new Error("No schedulable spec; run validateSpecs first");
    }
    for (const s of wave) {
      remaining.splice(remaining.indexOf(s), 1);
      merged.add(s.id);
    }
    waves.push(wave);
  }
  return waves;
}
