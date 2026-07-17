import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp.js";
import { ProjectStore } from "../src/store.js";
import { createTestRepository, removeTestRepository } from "./helpers.js";

describe("MCP surface", () => {
  let root: string;
  let store: ProjectStore;

  beforeEach(() => {
    root = createTestRepository();
    store = new ProjectStore(root);
  });

  afterEach(() => {
    if (store) store.close();
    removeTestRepository(root);
  });

  it("advertises coordination and terminal tools and accepts a join call", async () => {
    const server = createMcpServer(store);
    const client = new Client({ name: "agentrelay-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect(client.getInstructions()).toContain("At the start of development");
    expect(client.getInstructions()).toContain("Before ending or handing off");

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "agent_join",
      "agent_status",
      "build_context",
      "claim_scope",
      "claim_task",
      "create_handoff",
      "project_init",
      "record_decision",
      "record_event",
      "search_memory",
      "terminal_doctor",
      "terminal_list",
      "terminal_name",
      "terminal_read",
      "terminal_send",
    ]);

    const result = await client.callTool({
      name: "agent_join",
      arguments: {
        agent_id: "codex-test",
        agent_type: "codex",
        task_summary: "Exercise MCP",
      },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain("codex-test");

    const doctor = await client.callTool({ name: "terminal_doctor", arguments: {} });
    expect(doctor.isError).not.toBe(true);
    expect(JSON.stringify(doctor.content)).toContain("readGuardSeconds");

    await client.close();
    await server.close();
  });
});
