// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  parseSpecFile,
  previewWaves,
  topologicalOrder,
  validateSpecs,
} from "./spec";

const spec = (
  id: string,
  extra: { priority?: number; depends_on?: string[]; touches?: string[] } = {},
  body = "Do the thing.",
) => {
  const fm = [
    `id: ${id}`,
    `title: ${id} title`,
    extra.priority !== undefined ? `priority: ${extra.priority}` : "",
    extra.depends_on ? `depends_on: [${extra.depends_on.join(", ")}]` : "",
    extra.touches ? `touches: [${extra.touches.join(", ")}]` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return parseSpecFile(`${id}.md`, `---\n${fm}\n---\n${body}\n`);
};

describe("parseSpecFile", () => {
  it("applies defaults and measures the body", () => {
    const s = spec("a-1");
    expect(s.priority).toBe(3);
    expect(s.dependsOn).toEqual([]);
    expect(s.touches).toEqual([]);
    expect(s.bodyChars).toBe("Do the thing.".length);
  });

  it("rejects ids with uppercase or spaces", () => {
    expect(() =>
      parseSpecFile("x.md", "---\nid: Bad Id\ntitle: t\n---\nbody"),
    ).toThrow();
  });
});

describe("validateSpecs", () => {
  it("accepts a valid set", () => {
    expect(
      validateSpecs([spec("a"), spec("b", { depends_on: ["a"] })]),
    ).toEqual([]);
  });

  it("reports duplicates, unknown deps, empty bodies and cycles", () => {
    expect(validateSpecs([spec("a"), spec("a")])).toContain('Duplicate id "a"');
    expect(validateSpecs([spec("a", { depends_on: ["zz"] })])).toContain(
      'Spec "a" depends on unknown id "zz"',
    );
    expect(validateSpecs([spec("a", {}, "")])).toContain(
      'Spec "a" has an empty body',
    );
    const cyclic = [
      spec("a", { depends_on: ["b"] }),
      spec("b", { depends_on: ["a"] }),
    ];
    expect(validateSpecs(cyclic)[0]).toMatch(/cycle/);
  });
});

describe("topologicalOrder", () => {
  it("puts dependencies first, then priority, then id", () => {
    const specs = [
      spec("c", { priority: 1, depends_on: ["a"] }),
      spec("b", { priority: 1 }),
      spec("a", { priority: 3 }),
    ];
    expect(topologicalOrder(specs).map((s) => s.id)).toEqual(["b", "a", "c"]);
  });
});

describe("previewWaves", () => {
  it("fills waves up to the concurrency limit", () => {
    const specs = [spec("a"), spec("b"), spec("c"), spec("d")];
    expect(previewWaves(specs, 3).map((w) => w.map((s) => s.id))).toEqual([
      ["a", "b", "c"],
      ["d"],
    ]);
  });

  it("holds a PR until its dependency has merged", () => {
    const specs = [spec("a"), spec("b", { depends_on: ["a"] })];
    expect(previewWaves(specs, 3).map((w) => w.map((s) => s.id))).toEqual([
      ["a"],
      ["b"],
    ]);
  });

  it("does not run two PRs that touch the same file in one wave", () => {
    const specs = [
      spec("a", { touches: ["src/App.tsx"] }),
      spec("b", { touches: ["src/App.tsx"] }),
      spec("c", { touches: ["src/other.ts"] }),
    ];
    expect(previewWaves(specs, 3).map((w) => w.map((s) => s.id))).toEqual([
      ["a", "c"],
      ["b"],
    ]);
  });
});

describe("previewWaves with already merged specs", () => {
  it("skips them and treats them as satisfied dependencies", () => {
    const specs = [
      spec("a"),
      spec("b", { depends_on: ["a"] }),
      spec("c", { depends_on: ["b"] }),
    ];
    expect(
      previewWaves(specs, 3, ["a"]).map((w) => w.map((s) => s.id)),
    ).toEqual([["b"], ["c"]]);
    expect(previewWaves(specs, 3, ["a", "b", "c"])).toEqual([]);
  });
});

describe("spec id rules", () => {
  const withId = (id: string) =>
    parseSpecFile("x.md", `---\nid: ${id}\ntitle: t\n---\nbody\n`);
  it("accepts dash-separated lowercase words and digits", () => {
    expect(withId("001-footer-year").id).toBe("001-footer-year");
    expect(withId("a").id).toBe("a");
  });
  it("rejects ids a branch-ownership hook would refuse", () => {
    for (const bad of ["a--b", "-a", "a-", "A-b", "a_b", "x".repeat(51)]) {
      expect(() => withId(bad), bad).toThrow();
    }
  });
  it("parses contracts and serial with defaults", () => {
    const s = parseSpecFile(
      "y.md",
      "---\nid: y\ntitle: t\ncontracts: [notes-api]\nserial: true\n---\nbody\n",
    );
    expect(s.contracts).toEqual(["notes-api"]);
    expect(s.serial).toBe(true);
    expect(withId("z").contracts).toEqual([]);
    expect(withId("z").serial).toBe(false);
  });
});
