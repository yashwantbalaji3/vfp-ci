import { afterEach, describe, expect, it, vi } from "vitest";

// Demo-to-real transition (docs/37): the real-first Discover only takes effect with demo content off.
async function flags(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
  return (await import("@/config/flags")).FLAGS;
}

describe("REAL_DISCOVERY", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is off unless set", async () => {
    expect((await flags({ REAL_DISCOVERY: "", ALLOW_DEMO_CONTENT: "" })).realDiscovery).toBe(false);
  });
  it("never mixes with demo content: on only when demo content is off", async () => {
    expect((await flags({ REAL_DISCOVERY: "true", ALLOW_DEMO_CONTENT: "true" })).realDiscovery).toBe(false);
    const on = await flags({ REAL_DISCOVERY: "true", ALLOW_DEMO_CONTENT: "false" });
    expect(on.realDiscovery).toBe(true);
    expect(on.allowDemoContent).toBe(false);
  });
  it("does not open the database's real-place lock or the public release", async () => {
    const on = await flags({ REAL_DISCOVERY: "true", ALLOW_DEMO_CONTENT: "" });
    expect(on.publicReleaseEnabled).toBe(false);
  });
});
