import { describe, expect, it } from "vitest";
import {
  assertSafeRelativePattern,
  filterSafePaths,
  isSensitivePath,
  redactSecrets,
  redactStructured,
} from "../src/security.js";

describe("security boundaries", () => {
  it("redacts common credential shapes", () => {
    const value = redactSecrets(
      "api_key=super-secret npm_token=registry-secret Authorization: Bearer abc.def.ghi password: hunter2 ghp_12345678901234567890",
    );
    expect(value).not.toContain("super-secret");
    expect(value).not.toContain("registry-secret");
    expect(value).not.toContain("abc.def.ghi");
    expect(value).not.toContain("hunter2");
    expect(value).not.toContain("ghp_12345678901234567890");
    expect(value).toContain("[REDACTED]");
  });

  it("redacts private keys and credentials embedded in URLs", () => {
    const value = redactSecrets([
      "postgres://agent:database-password@example.invalid/app",
      "-----BEGIN PRIVATE KEY-----",
      "private-key-material",
      "-----END PRIVATE KEY-----",
    ].join("\n"));
    expect(value).not.toContain("database-password");
    expect(value).not.toContain("private-key-material");
    expect(value).toContain("[REDACTED_PRIVATE_KEY]");
  });

  it("blocks traversal, absolute paths, and credential files", () => {
    expect(() => assertSafeRelativePattern("../outside.ts")).toThrow(/escape/);
    expect(() => assertSafeRelativePattern("/tmp/file")).toThrow(/repository-relative/);
    expect(() => assertSafeRelativePattern(".env.production")).toThrow(/Sensitive/);
    expect(isSensitivePath("config/client-secret.pem")).toBe(true);
    expect(filterSafePaths(["src/index.ts", ".env", "keys/id_ed25519"])).toEqual([
      "src/index.ts",
    ]);
  });

  it("redacts nested metadata and secret-like keys", () => {
    const value = redactStructured({
      provider: "npm",
      nested: { npm_token: "registry-secret", note: "password=hunter2" },
    });
    expect(JSON.stringify(value)).not.toContain("registry-secret");
    expect(JSON.stringify(value)).not.toContain("hunter2");
    expect(value).toEqual({
      provider: "npm",
      nested: { npm_token: "[REDACTED]", note: "password=[REDACTED]" },
    });
  });
});
