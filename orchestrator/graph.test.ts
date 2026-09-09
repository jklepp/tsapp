// @vitest-environment node
import { describe, expect, it } from "vitest";
import { stubCoder, stubIntegrator } from "./agents/stub";
import type { Coder } from "./agents/types";
import { OrchestratorConfigSchema } from "./config";
import {
  buildGraph,
  pickWave,
  propagateFailures,
  recursionLimitFor,
} from "./graph";
import type { PrRecord } from "./state";

const config = OrchestratorConfigSchema.parse({
  coders: { count: 3 },
  maxAttemptsPerPr: 2,
});

const pr = (
  id: string,
  extra: Partial<
    Pick<PrRecord, "priority" | "dependsOn" | "touches" | "status">
  > = {},
): PrRecord => ({
  id,
  title: id,
  specPath: "",
  priority: 3,
  dependsOn: [],
  touches: [],
  status: "queued",
  attempts: 0,
  ...extra,
});

const byId = (list: PrRecord[]) =>
  Object.fromEntries(list.map((p) => [p.id, p]));

async function run(
  prs: PrRecord[],
  agents: { coder?: Coder } = {},
  cfg = config,
) {
  const waves: string[][] = [];
  const graph = buildGraph({
    config: cfg,
    coder: agents.coder ?? stubCoder({ delayMs: 5 }),
    integrator: stubIntegrator({ delayMs: 5 }),
    emit: (type, data) => {
      if (type === "wave") waves.push(data!.ids as string[]);
    },
  });
  const final = await graph.invoke(
    { runId: "test", prs: byId(prs) },
    { recursionLimit: recursionLimitFor(prs.length, cfg) },
  );
  return { prs: final.prs, waves };
}

describe("pickWave", () => {
  it("respects slots, dependencies, priority and touches", () => {
    const prs = byId([
      pr("a", { priority: 5 }),
      pr("b", { priority: 1, touches: ["x"] }),
      pr("c", { priority: 2, touches: ["x"] }),
      pr("d", { dependsOn: ["a"] }),
      pr("e", { status: "merged" }),
    ]);
    expect(pickWave(prs, 3).map((p) => p.id)).toEqual(["b", "a"]);
    expect(pickWave(prs, 1).map((p) => p.id)).toEqual(["b"]);
  });
});

describe("propagateFailures", () => {
  it("fails queued PRs transitively when a dependency failed", () => {
    const prs = byId([
      pr("a", { status: "failed" }),
      pr("b", { dependsOn: ["a"] }),
      pr("c", { dependsOn: ["b"] }),
      pr("d"),
    ]);
    const updates = propagateFailures(prs);
    expect(Object.keys(updates).sort()).toEqual(["b", "c"]);
    expect(updates.b.error).toBe("dependency a failed");
    expect(updates.c.error).toBe("dependency b failed");
  });
});

describe("graph", () => {
  it("merges every PR, in waves that honour dependencies and touches", async () => {
    const { prs, waves } = await run([
      pr("001", { priority: 2, touches: ["Footer.tsx"] }),
      pr("002", { touches: ["date.ts"] }),
      pr("003", { dependsOn: ["002"], touches: ["Footer.tsx"] }),
      pr("004"),
    ]);
    expect(Object.values(prs).every((p) => p.status === "merged")).toBe(true);
    expect(waves).toEqual([["001", "002", "004"], ["003"]]);
    expect(prs["001"].attempts).toBe(1);
    expect(prs["001"].coding?.inputTokens).toBe(4000);
    expect(prs["001"].integration?.inputTokens).toBe(800);
  });

  it("retries a failed coder once and accumulates metrics across attempts", async () => {
    const { prs, waves } = await run([pr("a"), pr("b")], {
      coder: stubCoder({ delayMs: 5, failOnce: ["a"] }),
    });
    expect(prs.a.status).toBe("merged");
    expect(prs.a.attempts).toBe(2);
    expect(prs.a.coding?.inputTokens).toBe(2000 + 4000);
    expect(prs.a.coding?.numTurns).toBe(5 + 10);
    expect(waves).toEqual([["a", "b"], ["a"]]);
  });

  it("gives up after maxAttemptsPerPr and blocks dependants", async () => {
    const { prs } = await run(
      [pr("a"), pr("b", { dependsOn: ["a"] }), pr("c")],
      { coder: stubCoder({ delayMs: 5, failAlways: ["a"] }) },
    );
    expect(prs.a.status).toBe("failed");
    expect(prs.a.attempts).toBe(2);
    expect(prs.a.error).toContain("attempt 2");
    expect(prs.b.status).toBe("failed");
    expect(prs.b.error).toBe("dependency a failed");
    expect(prs.c.status).toBe("merged");
  });

  it("treats a coder that throws like a failure", async () => {
    const { prs } = await run([pr("a")], {
      coder: async () => {
        throw new Error("boom");
      },
    });
    expect(prs.a.status).toBe("failed");
    expect(prs.a.error).toBe("boom");
  });
});

describe("run budget", () => {
  it("stops scheduling new waves once maxRunBudgetUsd is reached", async () => {
    // Stub agents cost $0.30 per PR (coding 0.25 + integration 0.05).
    const cfg = OrchestratorConfigSchema.parse({
      coders: { count: 1 },
      maxRunBudgetUsd: 0.5,
    });
    const { prs, waves } = await run([pr("a"), pr("b"), pr("c")], {}, cfg);
    expect(waves).toEqual([["a"], ["b"]]);
    expect(prs.a.status).toBe("merged");
    expect(prs.b.status).toBe("merged");
    expect(prs.c.status).toBe("queued");
  });
});
