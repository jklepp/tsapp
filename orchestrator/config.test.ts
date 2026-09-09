// @vitest-environment node
import { describe, expect, it } from "vitest";
import { OrchestratorConfigSchema } from "./config";
import { branchFor, integrationWorktreeDir, worktreeDirFor } from "./naming";

describe("OrchestratorConfigSchema", () => {
  it("fills every default from an empty object", () => {
    const c = OrchestratorConfigSchema.parse({});
    expect(c.branchPrefix).toBe("pr");
    expect(c.worktreeNamePrefix).toBe("");
    expect(c.integrationWorktreeName).toBe("_integration");
    expect(c.mergeStrategy).toBe("merge");
    expect(c.fetchBeforeWork).toBe(true);
    expect(c.deleteMergedBranches).toBe(false);
    expect(c.session).toEqual({
      settingSources: ["project"],
      env: {},
      persist: false,
    });
    expect(c.scheduling.serialPaths).toEqual([]);
    expect(c.review.enabled).toBe(false);
    expect(c.review.maxRounds).toBe(1);
    expect(c.postMerge.atRunEnd).toBe(false);
    expect(c.integrator.checkCommand).toBeUndefined();
  });

  it("accepts a fully customised consumer config", () => {
    const c = OrchestratorConfigSchema.strict().parse({
      branchPrefix: "orch",
      worktreeNamePrefix: "orch-",
      integrationWorktreeName: "orch-integrate",
      mergeStrategy: "squash",
      deleteMergedBranches: true,
      checkCommand: "npm run verify:fast",
      session: {
        settingSources: ["project"],
        env: { ORCH_SESSION: "1" },
        persist: true,
      },
      scheduling: { serialPaths: ["migrations/"] },
      integrator: {
        model: "claude-sonnet-5",
        checkCommand: "npm run verify:fast && npm run check:migrations",
      },
      review: {
        enabled: true,
        classifyCommand: "node scripts/classify.ts --json",
        reviewers: [{ name: "spec", promptFile: ".claude/agents/spec.md" }],
      },
      postMerge: {
        command: "gh workflow run gate.yml",
        everyNMerges: 5,
        atRunEnd: true,
      },
    });
    expect(c.review.reviewers[0].allowedTools).toEqual([
      "Read",
      "Grep",
      "Glob",
    ]);
    expect(c.integrator.effort).toBe("high"); // other agent defaults still apply
    expect(c.postMerge.everyNMerges).toBe(5);
  });

  it("rejects unknown keys and bad values", () => {
    expect(() =>
      OrchestratorConfigSchema.strict().parse({ brnachPrefix: "x" }),
    ).toThrow();
    expect(() =>
      OrchestratorConfigSchema.parse({ mergeStrategy: "rebase" }),
    ).toThrow();
    expect(() =>
      OrchestratorConfigSchema.parse({ branchPrefix: "Bad/Prefix" }),
    ).toThrow();
    expect(() =>
      OrchestratorConfigSchema.parse({ review: { maxRounds: 2 } }),
    ).toThrow();
  });
});

describe("naming", () => {
  const c = OrchestratorConfigSchema.parse({
    branchPrefix: "orch",
    worktreesDir: "/wt",
    worktreeNamePrefix: "orch-",
    integrationWorktreeName: "orch-integrate",
  });
  it("derives branch and worktree names from config", () => {
    expect(branchFor(c, "001-x")).toBe("orch/001-x");
    expect(worktreeDirFor(c, "001-x").replaceAll("\\", "/")).toMatch(
      /\/wt\/orch-001-x$/,
    );
    expect(integrationWorktreeDir(c).replaceAll("\\", "/")).toMatch(
      /\/wt\/orch-integrate$/,
    );
  });
});
