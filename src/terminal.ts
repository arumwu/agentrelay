/**
 * Built-in tmux transport for AgentRelay.
 *
 * This module adapts the public behavior and selected implementation ideas of
 * tmux-bridge-mcp by Howard Peng. See THIRD_PARTY_NOTICES.md and
 * LICENSES/tmux-bridge-mcp-MIT.txt for attribution and license terms.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import { promisify } from "node:util";
import { redactSecrets } from "./security.js";
import { ProjectStore } from "./store.js";

const execFileAsync = promisify(execFile);
const FIELD_SEPARATOR = "::AGENTRELAY_FIELD::";
const DEFAULT_READ_LINES = 50;
const MAX_READ_LINES = 200;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_TMUX_BUFFER_BYTES = 512 * 1024;
const MAX_MESSAGE_BYTES = 8 * 1024;
const READ_GUARD_SECONDS = 90;
const TMUX_TIMEOUT_MS = 10_000;

export interface TerminalPane {
  id: string;
  target: string;
  session: string;
  windowIndex: number;
  paneIndex: number;
  process: string;
  label: string | null;
  workingDirectory: string;
  active: boolean;
}

export interface TerminalScope {
  id: string;
  session: string;
  actorId: string;
}

export interface TerminalReadResult {
  scope: TerminalScope;
  pane: TerminalPane;
  requestedLines: number;
  output: string;
  outputBytes: number;
  truncated: boolean;
}

export interface TerminalSendResult {
  scope: TerminalScope;
  pane: TerminalPane;
  correlationId: string;
  messageBytes: number;
  submitted: true;
}

export interface TerminalDoctorResult {
  available: boolean;
  version: string | null;
  currentPane: string | null;
  session: string | null;
  sessionSource: "configured" | "current-pane" | "unavailable";
  socketSource: "configured" | "inherited" | "default";
  limits: {
    maxReadLines: number;
    maxOutputBytes: number;
    maxMessageBytes: number;
    readGuardSeconds: number;
  };
  problems: string[];
}

export interface TerminalTransportOptions {
  tmuxPath?: string;
  socketPath?: string;
  sessionName?: string;
  currentPane?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface TerminalAuditContext {
  sessionId?: string;
  taskId?: string;
}

function ensureSafeArgument(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 500 || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new Error(`${label} must be non-empty text without control characters.`);
  }
  return trimmed;
}

function ensureLabel(value: string): string {
  const label = ensureSafeArgument(value, "Pane label");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(label)) {
    throw new Error("Pane labels must use 1-64 letters, numbers, dots, underscores, or hyphens.");
  }
  return label;
}

function ensureMessage(value: string): string {
  const message = value.trim();
  if (!message) throw new Error("Terminal messages cannot be empty.");
  if (/[\u0000-\u001f\u007f]/u.test(message)) {
    throw new Error("Terminal messages must be a single line without control characters.");
  }
  if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error(`Terminal messages cannot exceed ${MAX_MESSAGE_BYTES} UTF-8 bytes.`);
  }
  return message;
}

function compactError(error: unknown): string {
  if (!(error instanceof Error)) return redactSecrets(String(error));
  const withStderr = error as Error & { stderr?: string | Buffer };
  const stderr = typeof withStderr.stderr === "string"
    ? withStderr.stderr
    : Buffer.isBuffer(withStderr.stderr)
      ? withStderr.stderr.toString("utf8")
      : "";
  return redactSecrets((stderr.trim() || error.message).slice(0, 2_000));
}

function truncateUtf8(value: string, maxBytes: number): { value: string; bytes: number; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return { value, bytes: buffer.byteLength, truncated: false };
  }
  const marker = "[older terminal output truncated]\n";
  const suffixBytes = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  const suffix = buffer.subarray(buffer.byteLength - suffixBytes).toString("utf8").replace(/^\uFFFD/u, "");
  const truncatedValue = `${marker}${suffix}`;
  return {
    value: truncatedValue,
    bytes: Buffer.byteLength(truncatedValue, "utf8"),
    truncated: true,
  };
}

function hideHome(value: string, environment: NodeJS.ProcessEnv): string {
  const home = environment.HOME || os.homedir();
  if (!home) return value;
  return value === home ? "~" : value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value;
}

export class TerminalTransport {
  private readonly tmuxPath: string;
  private readonly socketPath: string | null;
  private readonly configuredSession: string | null;
  private readonly currentPane: string | null;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly socketSource: "configured" | "inherited" | "default";
  private resolvedSession: string | null = null;
  private resolvedSessionTarget: string | null = null;

  constructor(options: TerminalTransportOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.tmuxPath = options.tmuxPath ?? "tmux";
    const inheritedSocket = this.environment.TMUX?.split(",", 1)[0]?.trim() || null;
    const configuredSocket = options.socketPath?.trim()
      || this.environment.AGENTRELAY_TMUX_SOCKET?.trim()
      || null;
    this.socketPath = configuredSocket || inheritedSocket;
    this.socketSource = configuredSocket ? "configured" : inheritedSocket ? "inherited" : "default";
    this.configuredSession = options.sessionName?.trim()
      || this.environment.AGENTRELAY_TMUX_SESSION?.trim()
      || null;
    this.currentPane = options.currentPane?.trim()
      || this.environment.TMUX_PANE?.trim()
      || null;
  }

  private socketArgs(): string[] {
    return this.socketPath ? ["-S", this.socketPath] : [];
  }

  private async run(args: string[], includeSocket = true): Promise<string> {
    try {
      const result = await execFileAsync(
        this.tmuxPath,
        [...(includeSocket ? this.socketArgs() : []), ...args],
        {
          encoding: "utf8",
          timeout: TMUX_TIMEOUT_MS,
          maxBuffer: MAX_TMUX_BUFFER_BYTES,
          env: this.environment,
        },
      );
      return result.stdout;
    } catch (error) {
      throw new Error(`tmux failed: ${compactError(error)}`);
    }
  }

  private async allowedSession(): Promise<string> {
    if (this.resolvedSession) return this.resolvedSession;
    if (this.configuredSession) {
      this.resolvedSession = ensureSafeArgument(this.configuredSession, "tmux session");
      return this.resolvedSession;
    }
    if (!this.currentPane) {
      throw new Error(
        "No tmux session is configured. Run AgentRelay inside tmux or set AGENTRELAY_TMUX_SESSION.",
      );
    }
    const session = (await this.run([
      "display-message",
      "-t",
      ensureSafeArgument(this.currentPane, "Current tmux pane"),
      "-p",
      "#{session_name}",
    ])).trim();
    this.resolvedSession = ensureSafeArgument(session, "tmux session");
    return this.resolvedSession;
  }

  private parsePane(line: string): TerminalPane {
    const [id, session, windowIndex, paneIndex, processName, label, workingDirectory, active] =
      line.split(FIELD_SEPARATOR);
    if (!id || !session || windowIndex === undefined || paneIndex === undefined) {
      throw new Error("tmux returned an incomplete pane record.");
    }
    return {
      id,
      target: `${session}:${windowIndex}.${paneIndex}`,
      session,
      windowIndex: Number(windowIndex),
      paneIndex: Number(paneIndex),
      process: redactSecrets(processName || "unknown"),
      label: label ? redactSecrets(label) : null,
      workingDirectory: redactSecrets(hideHome(workingDirectory || "", this.environment)),
      active: active === "1",
    };
  }

  private paneFormat(): string {
    return [
      "#{pane_id}",
      "#{session_name}",
      "#{window_index}",
      "#{pane_index}",
      "#{pane_current_command}",
      "#{@agentrelay_name}",
      "#{pane_current_path}",
      "#{pane_active}",
    ].join(FIELD_SEPARATOR);
  }

  private async allowedSessionTarget(): Promise<string> {
    if (this.resolvedSessionTarget) return this.resolvedSessionTarget;
    const session = await this.allowedSession();
    const output = await this.run([
      "list-sessions",
      "-F",
      ["#{session_id}", "#{session_name}"].join(FIELD_SEPARATOR),
    ]);
    const matches = output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(FIELD_SEPARATOR))
      .filter(([, name]) => name === session);
    if (matches.length === 0 || !matches[0]?.[0]) {
      throw new Error(`The allowed tmux session '${session}' does not exist.`);
    }
    if (matches.length > 1) {
      throw new Error(`More than one tmux session resolved to '${session}'.`);
    }
    this.resolvedSessionTarget = `${matches[0][0]}:`;
    return this.resolvedSessionTarget;
  }

  private async directPane(target: string): Promise<TerminalPane> {
    const output = await this.run([
      "display-message",
      "-t",
      ensureSafeArgument(target, "Pane target"),
      "-p",
      this.paneFormat(),
    ]);
    const pane = this.parsePane(output.trim());
    const session = await this.allowedSession();
    if (pane.session !== session) {
      throw new Error(`Pane ${pane.id} is outside the allowed tmux session '${session}'.`);
    }
    return pane;
  }

  async scope(): Promise<TerminalScope> {
    const session = await this.allowedSession();
    const socketIdentity = this.socketPath || "default";
    const id = createHash("sha256")
      .update(`${socketIdentity}\u0000${session}`)
      .digest("hex")
      .slice(0, 24);
    return {
      id,
      session,
      actorId: this.currentPane || "external",
    };
  }

  async list(): Promise<TerminalPane[]> {
    const output = await this.run([
      "list-panes",
      "-t",
      await this.allowedSessionTarget(),
      "-F",
      this.paneFormat(),
    ]);
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => this.parsePane(line));
  }

  async resolvePane(target: string): Promise<TerminalPane> {
    const safeTarget = ensureSafeArgument(target, "Pane target");
    if (
      /^%\d+$/u.test(safeTarget)
      || /^\d+(?:\.\d+)?$/u.test(safeTarget)
      || safeTarget.includes(":")
    ) {
      return this.directPane(safeTarget);
    }
    const label = ensureLabel(safeTarget);
    const matches = (await this.list()).filter((pane) => pane.label === label);
    if (matches.length === 0) throw new Error(`No pane has the AgentRelay label '${label}'.`);
    if (matches.length > 1) throw new Error(`More than one pane has the AgentRelay label '${label}'.`);
    return matches[0]!;
  }

  async read(target: string, lines = DEFAULT_READ_LINES): Promise<TerminalReadResult> {
    if (!Number.isInteger(lines) || lines < 1 || lines > MAX_READ_LINES) {
      throw new Error(`Terminal read lines must be an integer from 1 to ${MAX_READ_LINES}.`);
    }
    const pane = await this.resolvePane(target);
    const raw = await this.run([
      "capture-pane",
      "-t",
      pane.id,
      "-p",
      "-J",
      "-S",
      `-${lines}`,
    ]);
    const redacted = redactSecrets(raw.replace(/\s+$/u, ""));
    const bounded = truncateUtf8(redacted, MAX_OUTPUT_BYTES);
    return {
      scope: await this.scope(),
      pane,
      requestedLines: lines,
      output: bounded.value,
      outputBytes: bounded.bytes,
      truncated: bounded.truncated,
    };
  }

  async sendResolved(pane: TerminalPane, messageInput: string): Promise<TerminalSendResult> {
    const paneNow = await this.directPane(pane.id);
    const scope = await this.scope();
    if (this.currentPane && paneNow.id === this.currentPane) {
      throw new Error("AgentRelay will not send a terminal message to its own pane.");
    }
    const message = ensureMessage(messageInput);
    let sender = scope.actorId;
    if (this.currentPane) {
      try {
        const label = (await this.run([
          "display-message",
          "-t",
          this.currentPane,
          "-p",
          "#{@agentrelay_name}",
        ])).trim();
        if (label) sender = label;
      } catch {
        // Sender labeling is optional; the pane id remains a stable fallback.
      }
    }
    sender = sender.replace(/[^A-Za-z0-9%._-]/gu, "_").slice(0, 64) || "external";
    const correlationId = randomUUID().slice(0, 12);
    const payload = `[AgentRelay from:${sender} id:${correlationId}] ${message}`;
    await this.run(["send-keys", "-t", paneNow.id, "-l", "--", payload]);
    await this.run(["send-keys", "-t", paneNow.id, "Enter"]);
    return {
      scope,
      pane: paneNow,
      correlationId,
      messageBytes: Buffer.byteLength(message, "utf8"),
      submitted: true,
    };
  }

  async name(target: string, labelInput: string): Promise<{ scope: TerminalScope; pane: TerminalPane; label: string }> {
    const pane = await this.resolvePane(target);
    const label = ensureLabel(labelInput);
    await this.run(["set-option", "-p", "-t", pane.id, "@agentrelay_name", label]);
    return { scope: await this.scope(), pane: { ...pane, label }, label };
  }

  async doctor(): Promise<TerminalDoctorResult> {
    const problems: string[] = [];
    let version: string | null = null;
    let session: string | null = null;
    try {
      version = (await this.run(["-V"], false)).trim() || null;
    } catch (error) {
      problems.push(compactError(error));
    }
    if (version) {
      try {
        session = await this.allowedSession();
        await this.allowedSessionTarget();
      } catch (error) {
        problems.push(compactError(error));
      }
    }
    return {
      available: Boolean(version && session && problems.length === 0),
      version,
      currentPane: this.currentPane,
      session,
      sessionSource: this.configuredSession
        ? "configured"
        : this.currentPane
          ? "current-pane"
          : "unavailable",
      socketSource: this.socketSource,
      limits: {
        maxReadLines: MAX_READ_LINES,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        maxMessageBytes: MAX_MESSAGE_BYTES,
        readGuardSeconds: READ_GUARD_SECONDS,
      },
      problems,
    };
  }
}

export class TerminalService {
  constructor(
    private readonly store: ProjectStore,
    private readonly transport = new TerminalTransport(),
  ) {}

  async list(): Promise<{ scope: TerminalScope; panes: TerminalPane[] }> {
    return { scope: await this.transport.scope(), panes: await this.transport.list() };
  }

  async read(
    target: string,
    lines = DEFAULT_READ_LINES,
    context: TerminalAuditContext = {},
  ): Promise<TerminalReadResult & { auditEventId: string; readGuardExpiresAt: string }> {
    this.store.validateTerminalAuditContext(context);
    const result = await this.transport.read(target, lines);
    const audit = this.store.recordTerminalRead({
      transportId: result.scope.id,
      actorId: result.scope.actorId,
      paneId: result.pane.id,
      paneTarget: result.pane.target,
      tmuxSession: result.scope.session,
      requestedLines: result.requestedLines,
      outputBytes: result.outputBytes,
      truncated: result.truncated,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.taskId ? { taskId: context.taskId } : {}),
      guardSeconds: READ_GUARD_SECONDS,
    });
    return {
      ...result,
      auditEventId: audit.eventId,
      readGuardExpiresAt: audit.expiresAt,
    };
  }

  async send(
    target: string,
    message: string,
    context: TerminalAuditContext = {},
  ): Promise<TerminalSendResult & { auditEventId: string }> {
    this.store.validateTerminalAuditContext(context);
    const messageInput = ensureMessage(message);
    const pane = await this.transport.resolvePane(target);
    const scope = await this.transport.scope();
    if (scope.actorId === pane.id) {
      throw new Error("AgentRelay will not send a terminal message to its own pane.");
    }
    this.store.consumeTerminalReadGuard({
      transportId: scope.id,
      actorId: scope.actorId,
      paneId: pane.id,
      guardSeconds: READ_GUARD_SECONDS,
    });
    const result = await this.transport.sendResolved(pane, messageInput);
    const audit = this.store.recordTerminalSend({
      transportId: result.scope.id,
      actorId: result.scope.actorId,
      paneId: result.pane.id,
      paneTarget: result.pane.target,
      tmuxSession: result.scope.session,
      correlationId: result.correlationId,
      messageBytes: result.messageBytes,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.taskId ? { taskId: context.taskId } : {}),
    });
    return { ...result, auditEventId: audit.eventId };
  }

  async name(
    target: string,
    label: string,
    context: TerminalAuditContext = {},
  ): Promise<{ scope: TerminalScope; pane: TerminalPane; label: string; auditEventId: string }> {
    this.store.validateTerminalAuditContext(context);
    const result = await this.transport.name(target, label);
    const audit = this.store.recordTerminalName({
      paneId: result.pane.id,
      paneTarget: result.pane.target,
      tmuxSession: result.scope.session,
      label: result.label,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.taskId ? { taskId: context.taskId } : {}),
    });
    return { ...result, auditEventId: audit.eventId };
  }

  doctor(): Promise<TerminalDoctorResult> {
    return this.transport.doctor();
  }
}
