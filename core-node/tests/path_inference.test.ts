import { describe, expect, it, beforeEach } from "vitest";
import { inferFromPath, _resetPathRulesCache } from "../src/memory/path_inference.js";

beforeEach(() => _resetPathRulesCache());

// Inference is brand-agnostic — the test fixtures use generic placeholder
// brand names ("alpha", "beta", "art-brand") so this suite never asserts
// owner-specific brands like bmx/nepa-ai. That would be a leak.

describe("inferFromPath — input/ tree", () => {
  it("infers brand and category=raw from input/<brand>/raw/", () => {
    const r = inferFromPath("D:/AGENT/input/alpha/raw/clip_001.mp4");
    expect(r.brand).toBe("alpha");
    expect(r.category).toBe("raw");
    expect(r.intent).toBe("agent-input");
  });

  it("infers category=color-corrected from input/<brand>/fixed/", () => {
    const r = inferFromPath("D:/AGENT/input/beta/fixed/session.mp4");
    expect(r.brand).toBe("beta");
    expect(r.category).toBe("color-corrected");
  });

  it("falls back to category=raw when input/<brand>/ has no leaf marker", () => {
    const r = inferFromPath("D:/AGENT/input/gamma/random.mp4");
    expect(r.brand).toBe("gamma");
    expect(r.category).toBe("raw");
  });
});

describe("inferFromPath — content/ tree", () => {
  it("infers reels with warn_on_edit=true (already-published material)", () => {
    const r = inferFromPath("D:/AGENT/content/alpha/reels/r1.mp4");
    expect(r.brand).toBe("alpha");
    expect(r.category).toBe("reel");
    expect(r.warn_on_edit).toBe(true);
    expect(r.workflow_state).toBe("ready-to-post");
  });

  it("infers long-form videos", () => {
    const r = inferFromPath("D:/AGENT/content/beta/long-form/episode-3.mp4");
    expect(r.brand).toBe("beta");
    expect(r.category).toBe("long-form");
  });

  it("recognizes static-images dir variant", () => {
    const r = inferFromPath("D:/AGENT/content/alpha/static-images/img.png");
    expect(r.category).toBe("static-image");
  });

  it("captures pinterest pin_type variable into metadata", () => {
    const r = inferFromPath("D:/AGENT/content/pinterest/blog pins/pin1.png");
    expect(r.category).toBe("pin");
    expect(r.metadata.pin_type).toBe("blog pins");
    expect(r.metadata.platform).toBe("pinterest");
    // Pinterest is platform-specific, no brand inferred.
    expect(r.brand).toBeUndefined();
  });

  it("captures blog-images audience variable into metadata", () => {
    const r = inferFromPath("D:/AGENT/content/blog-images/some-audience/img.jpg");
    expect(r.category).toBe("blog-image");
    expect(r.metadata.audience).toBe("some-audience");
  });

  it("recognizes generated-images as ai-generated", () => {
    const r = inferFromPath("D:/AGENT/content/generated-images/gen_001.png");
    expect(r.category).toBe("ai-generated");
  });

  it("falls through to category=edited for unknown content/<brand>/ subpath", () => {
    const r = inferFromPath("D:/AGENT/content/delta/whatever.mp4");
    expect(r.brand).toBe("delta");
    expect(r.category).toBe("edited");
  });
});

describe("inferFromPath — non-content paths", () => {
  it("recognizes output/ as agent-output", () => {
    const r = inferFromPath("D:/AGENT/output/2026-05-14-result.mp4");
    expect(r.category).toBe("agent-output");
  });

  it("recognizes obs-recordings as raw-recording with intent=agent-input", () => {
    const r = inferFromPath("D:/AGENT/content/obs-recordings/2026-05-14.mkv");
    expect(r.category).toBe("raw-recording");
    expect(r.intent).toBe("agent-input");
  });

  it("recognizes content-music as stock-asset audio", () => {
    const r = inferFromPath("D:/AGENT/content-music/track.mp3");
    expect(r.category).toBe("stock-asset");
    expect(r.metadata.kind_hint).toBe("audio");
  });

  it("recognizes video-scripts as text", () => {
    const r = inferFromPath("D:/AGENT/video-scripts/episode-3.md");
    expect(r.category).toBe("script");
    expect(r.metadata.kind_hint).toBe("text");
  });
});

describe("inferFromPath — skip rules", () => {
  it("skips agent_brain", () => {
    const r = inferFromPath("D:/AGENT/AGENT_BRAIN/notes/plan.md");
    expect(r.skipped).toBe(true);
  });

  it("skips skills/ (commercial product source)", () => {
    const r = inferFromPath("D:/AGENT/skills/my-skill/SKILL.md");
    expect(r.skipped).toBe(true);
  });

  it("skips logs/", () => {
    const r = inferFromPath("D:/AGENT/logs/app.log");
    expect(r.skipped).toBe(true);
  });

  it("skips .polymath/", () => {
    const r = inferFromPath("C:/Users/billk/.polymath/polymath.json");
    expect(r.skipped).toBe(true);
  });

  it("skips node_modules and .git", () => {
    expect(inferFromPath("D:/AGENT/node_modules/foo/bar.js").skipped).toBe(true);
    expect(inferFromPath("D:/AGENT/.git/HEAD").skipped).toBe(true);
  });
});

describe("inferFromPath — robustness", () => {
  it("handles backslash paths (Windows)", () => {
    const r = inferFromPath("D:\\AGENT\\input\\alpha\\raw\\clip.mp4");
    expect(r.brand).toBe("alpha");
    expect(r.category).toBe("raw");
  });

  it("is case-insensitive on directory names", () => {
    const r = inferFromPath("D:/AGENT/Content/Alpha/Reels/R.mp4");
    expect(r.category).toBe("reel");
    expect(r.brand).toBe("alpha");
  });

  it("returns empty inference for paths outside the convention", () => {
    const r = inferFromPath("C:/random/place/file.txt");
    expect(r.skipped).toBeUndefined();
    expect(r.brand).toBeUndefined();
    expect(r.category).toBeUndefined();
  });

  it("doesn't hardcode owner brand names", () => {
    // Audit: paths with owner-specific brands resolve via the same
    // pattern-based logic, NOT via hardcoded knowledge of those names.
    const ownerBrands = ["bmx", "nepa-ai", "axon", "blasting", "gym"];
    for (const b of ownerBrands) {
      const r = inferFromPath(`D:/AGENT/input/${b}/raw/x.mp4`);
      expect(r.brand).toBe(b);  // captured from <brand>, not assumed
      expect(r.category).toBe("raw");
    }
  });
});
