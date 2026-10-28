import { describe, expect, it } from "vitest";
import app, { renderMcpHelloPage } from "../src/oauth-app";

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

/** Every claude.ai link on the page, with HTML-escaped ampersands decoded. */
function claudeLinks(html: string): URL[] {
  return [...html.matchAll(/href="(https:\/\/claude\.ai\/[^"]*)"/g)].map(
    ([, href]) => new URL(href.replaceAll("&amp;", "&"))
  );
}

function expectAddToClaudeLink(html: string, mcpUrl: string) {
  const links = claudeLinks(html);
  expect(links).toHaveLength(1);
  const [link] = links;
  expect(link.pathname).toBe("/customize/connectors");
  expect(link.searchParams.get("modal")).toBe("add-custom-connector");
  expect(link.searchParams.get("connectorName")).toBe("Oura");
  expect(link.searchParams.get("connectorUrl")).toBe(mcpUrl);
}

describe("Add to Claude button", () => {
  it("opens Claude's prefilled Add custom connector dialog from the home page", async () => {
    const html = await render("/");
    expect(html).toContain("Add to Claude");
    expectAddToClaudeLink(html, "https://mcp-oura.smirnov.link/mcp");
  });

  it("prefills the MCP URL of the host serving the page", async () => {
    const res = await app.request("https://oura.example.test/");
    expectAddToClaudeLink(await res.text(), "https://oura.example.test/mcp");
  });

  it("appears on the page /mcp shows in a browser", async () => {
    const html = await renderMcpHelloPage(new URL("https://mcp-oura.smirnov.link/mcp")).text();
    expect(html).toContain("Add to Claude");
    expectAddToClaudeLink(html, "https://mcp-oura.smirnov.link/mcp");
  });

  it("gives claude.ai's current manual path, Customize → Connectors", async () => {
    const html = await renderMcpHelloPage(new URL("https://mcp-oura.smirnov.link/mcp")).text();
    expect(html).toContain("Customize → Connectors");
    expect(html).not.toContain("Settings → Connectors");
  });
});
