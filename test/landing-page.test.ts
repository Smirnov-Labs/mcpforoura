import { describe, expect, it } from "vitest";
import app from "../src/oauth-app";

const CANONICAL_REPO = "https://github.com/Smirnov-Labs/mcpforoura";
// The old personal-account path 404s; it must not reappear anywhere on the site.
const DEAD_REPO_PATH = "github.com/issmirnov/mcpforoura";

async function render(path: string): Promise<string> {
  const res = await app.request(`https://mcp-oura.smirnov.link${path}`);
  expect(res.status).toBe(200);
  return res.text();
}

describe("landing page links", () => {
  it("points the home-page Setup instructions button at the canonical repo", async () => {
    const html = await render("/");
    expect(html).toContain(`href="${CANONICAL_REPO}#readme"`);
  });

  it("points the home-page GitHub link at the canonical repo", async () => {
    const html = await render("/");
    expect(html).toContain(`href="${CANONICAL_REPO}"`);
  });

  it("never links to the dead issmirnov/mcpforoura GitHub path", async () => {
    for (const path of ["/", "/privacy", "/tos"]) {
      expect(await render(path)).not.toContain(DEAD_REPO_PATH);
    }
  });
});

describe("landing page content", () => {
  it("describes what the connector can do, not just how to connect", async () => {
    const html = await render("/");
    expect(html).toContain("What you can ask");
    expect(html).toContain("read-only tools");
    // A capability group from each data domain the tools cover.
    for (const group of ["Sleep", "Readiness", "Activity", "Biometrics", "Trends"]) {
      expect(html).toContain(`<strong>${group}`);
    }
  });
});
