// test/tool-annotations.test.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeAll, describe, expect, it } from "vitest";
import type { AuthProps } from "../src/auth/types";
import { registerOuraTools } from "../src/mcp/registerTools";

interface Registration {
  name: string;
  config: {
    title?: string;
    annotations?: { title?: string };
  };
}

function collectRegistrations(): Registration[] {
  const registered: Registration[] = [];
  const server = {
    registerTool(name: string, config: Registration["config"]) {
      registered.push({ name, config });
    },
  } as unknown as McpServer;
  // Registration is side-effect-free: handlers are closures invoked later, so
  // placeholder env/props are never dereferenced here.
  registerOuraTools(server, {} as Env, { ouraUserId: "test-user" } as AuthProps);
  return registered;
}

describe("tool annotations", () => {
  let registered: Registration[];

  beforeAll(() => {
    registered = collectRegistrations();
  });

  it("registers the full set of tools", () => {
    // Guards against the annotations.title loops passing vacuously on [].
    expect(registered.length).toBe(20);
  });

  it("gives every tool a non-empty annotations.title for directory listings", () => {
    const missing = registered
      .filter((r) => !r.config.annotations?.title)
      .map((r) => r.name);
    expect(missing).toEqual([]);
  });

  it("keeps annotations.title in sync with the top-level title", () => {
    const drift = registered
      .filter((r) => r.config.title && r.config.annotations?.title !== r.config.title)
      .map((r) => r.name);
    expect(drift).toEqual([]);
  });
});
