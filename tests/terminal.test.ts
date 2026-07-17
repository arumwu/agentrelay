import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../src/store.js";
import { TerminalService, TerminalTransport } from "../src/terminal.js";
import { createTestRepository, removeTestRepository } from "./helpers.js";

const hasTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;

describe.skipIf(!hasTmux)("isolated tmux transport", () => {
  let root: string;
  let store: ProjectStore;
  let socketPath: string;
  let sessionName: string;
  let service: TerminalService;
  let currentPane: string;
  let workerPane: string;

  const runTmux = (args: string[]): string => {
    const result = spawnSync("tmux", ["-S", socketPath, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || `tmux exited with ${result.status}`);
    return result.stdout.trim();
  };

  beforeEach(() => {
    root = createTestRepository();
    store = new ProjectStore(root);
    socketPath = path.join(os.tmpdir(), `agentrelay-tmux-${randomUUID()}.sock`);
    sessionName = `agentrelay-${randomUUID().slice(0, 8)}`;
    const readerPath = path.join(root, "terminal-reader.mjs");
    fs.writeFileSync(
      readerPath,
      [
        'process.stdout.write("READY api_key=super-secret\\n");',
        'process.stdin.setEncoding("utf8");',
        'let pending = "";',
        'process.stdin.on("data", (chunk) => {',
        '  pending += chunk;',
        '  const lines = pending.split(/\\r?\\n/u);',
        '  pending = lines.pop() || "";',
        '  for (const line of lines) process.stdout.write(`ACK:${line}\\n`);',
        '});',
      ].join("\n"),
      "utf8",
    );
    const readerCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(readerPath)}`;
    runTmux(["new-session", "-d", "-s", sessionName, "-n", "agents", readerCommand]);
    runTmux(["split-window", "-d", "-t", `=${sessionName}`, readerCommand]);
    [currentPane, workerPane] = runTmux([
      "list-panes",
      "-t",
      `=${sessionName}`,
      "-F",
      "#{pane_id}",
    ]).split("\n") as [string, string];
    const transport = new TerminalTransport({
      socketPath,
      sessionName,
      currentPane,
    });
    service = new TerminalService(store, transport);
  });

  afterEach(() => {
    try {
      runTmux(["kill-server"]);
    } catch {
      // A failed test may already have stopped the isolated server.
    }
    store.close();
    removeTestRepository(root);
  });

  it("lists, labels, reads, sends, redacts, and consumes the read guard", async () => {
    expect((await service.list()).panes).toHaveLength(2);
    await service.name(workerPane, "worker.review");

    await expect(service.send("worker.review", "hello before read")).rejects.toThrow(/read guard/u);
    const firstRead = await service.read("worker.review", 20);
    expect(firstRead.output).toContain("READY");
    expect(firstRead.output).not.toContain("super-secret");
    const sent = await service.send("worker.review", "hello from test");
    expect(sent.submitted).toBe(true);
    await expect(service.send("worker.review", "second send")).rejects.toThrow(/read guard/u);

    let output = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      output = (await service.read("worker.review", 30)).output;
      if (output.includes("ACK:[AgentRelay")) break;
    }
    expect(output).toContain("hello from test");
  });

  it("rejects self-messages and panes outside the configured session", async () => {
    await service.read(currentPane, 10);
    await expect(service.send(currentPane, "do not loop")).rejects.toThrow(/own pane/u);

    const otherSession = `other-${randomUUID().slice(0, 8)}`;
    runTmux(["new-session", "-d", "-s", otherSession]);
    const otherPane = runTmux(["list-panes", "-t", `=${otherSession}`, "-F", "#{pane_id}"]);
    await expect(service.read(otherPane, 10)).rejects.toThrow(/outside the allowed/u);
  });
});
