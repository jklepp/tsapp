// @vitest-environment node
import { describe, expect, it } from "vitest";
import { collides, isSerial, packWave, type Schedulable } from "./scheduling";

const s = (
  id: string,
  extra: Partial<Omit<Schedulable, "id">> = {},
): Schedulable => ({ id, priority: 3, touches: [], ...extra });

const rules = { serialPaths: ["migrations/", "src/lib/db.ts"] };

describe("isSerial", () => {
  it("is true for serial: true or a touch under a serial prefix", () => {
    expect(isSerial(s("a", { serial: true }), rules)).toBe(true);
    expect(
      isSerial(s("b", { touches: ["migrations/0031_x.sql"] }), rules),
    ).toBe(true);
    expect(isSerial(s("c", { touches: ["src\\lib\\db.ts"] }), rules)).toBe(
      true,
    );
    expect(isSerial(s("d", { touches: ["src/lib/other.ts"] }), rules)).toBe(
      false,
    );
  });
});

describe("collides", () => {
  it("blocks on a shared contract regardless of paths", () => {
    const a = s("a", { touches: ["x.ts"], contracts: ["Notes-API"] });
    const b = s("b", { touches: ["y.ts"], contracts: ["notes-api"] });
    expect(collides(a, b)).toMatch(/shares contract notes-api with b/);
  });

  it("blocks on a shared path when contracts do not separate them", () => {
    const a = s("a", { touches: ["src/App.tsx"] });
    const b = s("b", { touches: ["src/App.tsx"], contracts: ["routing"] });
    expect(collides(a, b)).toMatch(/shares src\/app\.tsx with b/);
  });

  it("allows a shared path when both declare distinct contracts", () => {
    const a = s("a", { touches: ["src/App.tsx"], contracts: ["routing"] });
    const b = s("b", { touches: ["src/App.tsx"], contracts: ["theme"] });
    expect(collides(a, b)).toBeNull();
  });

  it("treats a directory hint as overlapping everything beneath it", () => {
    const a = s("a", { touches: ["src/lib/"] });
    const b = s("b", { touches: ["src/lib/date.ts"] });
    expect(collides(a, b)).not.toBeNull();
    expect(collides(s("c", { touches: ["src/libs/x.ts"] }), a)).toBeNull();
  });
});

describe("packWave", () => {
  it("runs a serial spec alone and before the others, highest priority first", () => {
    const wave = packWave(
      [
        s("ui", { priority: 1 }),
        s("mig2", { priority: 3, touches: ["migrations/0032.sql"] }),
        s("mig1", { priority: 2, serial: true }),
      ],
      3,
      rules,
    );
    expect(wave.map((w) => w.id)).toEqual(["mig1"]);
  });

  it("fills to the slot count skipping collisions", () => {
    const wave = packWave(
      [
        s("a", { priority: 1, touches: ["x.ts"] }),
        s("b", { priority: 2, touches: ["x.ts"] }),
        s("c", { priority: 3, touches: ["y.ts"] }),
        s("d", { priority: 4, contracts: ["k"] }),
        s("e", { priority: 5, contracts: ["k"] }),
      ],
      3,
      rules,
    );
    expect(wave.map((w) => w.id)).toEqual(["a", "c", "d"]);
  });
});
