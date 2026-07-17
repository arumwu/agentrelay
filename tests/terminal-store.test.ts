import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../src/store.js";
import { createTestRepository, removeTestRepository } from "./helpers.js";

describe("terminal audit and read guards", () => {
  let root: string;
  let store: ProjectStore;

  beforeEach(() => {
    root = createTestRepository();
    store = new ProjectStore(root);
  });

  afterEach(() => {
    store.close();
    removeTestRepository(root);
  });

  it("allows one send after a recent read and records metadata without message content", () => {
    const read = store.recordTerminalRead({
      transportId: "transport-a",
      actorId: "%1",
      paneId: "%2",
      paneTarget: "agents:0.1",
      tmuxSession: "agents",
      requestedLines: 40,
      outputBytes: 120,
      truncated: false,
      guardSeconds: 90,
    });
    expect(read.eventId).toMatch(/[0-9a-f-]{36}/u);

    store.consumeTerminalReadGuard({
      transportId: "transport-a",
      actorId: "%1",
      paneId: "%2",
      guardSeconds: 90,
    });
    expect(() => store.consumeTerminalReadGuard({
      transportId: "transport-a",
      actorId: "%1",
      paneId: "%2",
      guardSeconds: 90,
    })).toThrow(/missing or expired/u);

    store.recordTerminalSend({
      transportId: "transport-a",
      actorId: "%1",
      paneId: "%2",
      paneTarget: "agents:0.1",
      tmuxSession: "agents",
      correlationId: "abc123",
      messageBytes: 42,
    });

    const log = fs.readFileSync(`${root}/.agentrelay/events.jsonl`, "utf8");
    expect(log).toContain("terminal_read");
    expect(log).toContain("terminal_send");
    expect(log).toContain("Message content was not persisted");
    expect(log).not.toContain("private message payload");
  });

  it("does not share a read guard between actors", () => {
    store.recordTerminalRead({
      transportId: "transport-a",
      actorId: "%1",
      paneId: "%2",
      paneTarget: "agents:0.1",
      tmuxSession: "agents",
      requestedLines: 10,
      outputBytes: 10,
      truncated: false,
      guardSeconds: 90,
    });
    expect(() => store.consumeTerminalReadGuard({
      transportId: "transport-a",
      actorId: "%3",
      paneId: "%2",
      guardSeconds: 90,
    })).toThrow(/missing or expired/u);
  });
});
