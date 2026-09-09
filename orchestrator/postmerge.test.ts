// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stubCoder, stubIntegrator } from "./agents/stub";
import { OrchestratorConfigSchema, resolvePaths } from "./config";
import { commitAll, git } from "./git";
import { dueEveryN } from "./postmerge";
import { runOrchestrator } from "./run";
import { makeRepo } from "./testing";

describe("dueEveryN", () => {
  const cfg = (postMerge: Record<string, unknown>) =>
    OrchestratorConfigSchema.parse({ postMerge });
  it("fires only with a command and every N merges since the last firing", () => {
    expect(dueEveryN(cfg({}), 5, 0)).toBe(false);
    expect(dueEveryN(cfg({ command: "x" }), 5, 0)).toBe(false);
    const c = cfg({ command: "x", everyNMerges: 2 });
    expect(dueEveryN(c, 1, 0)).toBe(false);
    expect(dueEveryN(c, 2, 0)).toBe(true);
    expect(dueEveryN(c, 3, 2)).toBe(false);
    expect(dueEveryN(c, 4, 2)).toBe(true);
  });
});

describe("post-merge trigger in a run", () => {
  let repo: string;
  let root: string;
  let out: string;
  let base: ReturnType<typeof OrchestratorConfigSchema.parse>;

  beforeAll(async () => {
    repo = await makeRepo();
    root = path.dirname(repo);
    fs.mkdirSync(path.join(repo, "specs"));
    fs.writeFileSync(
      path.join(repo, "specs", "a.md"),
      "---\nid: a\ntitle: a\n---\nbody\n",
    );
    fs.writeFileSync(
      path.join(repo, "specs", "b.md"),
      "---\nid: b\ntitle: b\ndepends_on: [a]\n---\nbody\n",
    );
    fs.writeFileSync(
      path.join(repo, "specs", "c.md"),
      "---\nid: c\ntitle: c\ndepends_on: [b]\n---\nbody\n",
    );
    await commitAll(repo, "specs");
    await git(["branch", "integration", "main"], repo);
    out = path.join(root, "ci-calls.txt").replaceAll("\\", "/");
    base = resolvePaths(
      OrchestratorConfigSchema.parse({
        repoPath: repo,
        specsDir: path.join(repo, "specs"),
        runsDir: path.join(root, "runs"),
        worktreesDir: path.join(root, "wt"),
      }),
      root,
    );
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const command = () =>
    `node -e "require('fs').appendFileSync('${out}', process.env.ORCH_TRIGGER + ':' + process.env.ORCH_MERGED + '\\n')"`;
  const calls = () =>
    fs.existsSync(out)
      ? fs.readFileSync(out, "utf8").trim().split("\n").filter(Boolean)
      : [];

  it("fires every N merges and again at run end only if merges happened since", async () => {
    fs.rmSync(out, { force: true });
    const lines: string[] = [];
    await runOrchestrator(
      {
        ...base,
        postMerge: { command: command(), everyNMerges: 2, atRunEnd: true },
      },
      {
        coder: stubCoder({ delayMs: 5 }),
        integrator: stubIntegrator({ delayMs: 5 }),
        runId: "pm-1",
        onLog: (l) => lines.push(l),
      },
    );
    // a, b, c merge one per wave: fires after b (2 merges); c makes 3, which
    // is one since the last firing, so run end fires once more.
    expect(calls()).toEqual(["every-n:2", "run-end:3"]);
    expect(
      lines.filter((l) => l.includes("post-merge command succeeded")),
    ).toHaveLength(2);
  });

  it("with only atRunEnd, fires exactly once", async () => {
    fs.rmSync(out, { force: true });
    // Nothing is merged yet in a fresh integration? a, b, c already merged by
    // the stub above only in state, not git, so they run again here.
    await runOrchestrator(
      { ...base, postMerge: { command: command(), atRunEnd: true } },
      {
        coder: stubCoder({ delayMs: 5 }),
        integrator: stubIntegrator({ delayMs: 5 }),
        runId: "pm-2",
      },
    );
    expect(calls()).toEqual(["run-end:3"]);
  });
});
