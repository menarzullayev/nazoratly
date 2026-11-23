import { describe, expect, it } from "vitest";
import { detectTier } from "@/lib/capability";

const base = { reducedMotion: false, hasWebGL2: true, cores: 8, memoryGb: 8, width: 1440 };

describe("detectTier", () => {
  it("reduced motion always gets the static page", () => {
    expect(detectTier({ ...base, reducedMotion: true })).toBe("static");
  });
  it("no WebGL2 gets the static page", () => {
    expect(detectTier({ ...base, hasWebGL2: false })).toBe("static");
  });
  it("a weak device is never probed for WebGL2 and gets the lite scene", () => {
    const probe = { ...base, width: 390, get hasWebGL2(): boolean { throw new Error("probed"); } };
    expect(detectTier(probe)).toBe("lite");
  });
  it("phones and weak devices get the lite scene", () => {
    expect(detectTier({ ...base, width: 390 })).toBe("lite");
    expect(detectTier({ ...base, cores: 4 })).toBe("lite");
    expect(detectTier({ ...base, memoryGb: 4 })).toBe("lite");
  });
  it("a capable desktop gets the full scene", () => {
    expect(detectTier(base)).toBe("full");
    expect(detectTier({ ...base, memoryGb: undefined })).toBe("full");
  });
});
