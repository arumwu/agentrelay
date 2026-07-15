import path from "node:path";

const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:credentials?|secrets?)(?:\.|\/|$)/i,
  /(^|\/)id_(?:rsa|ed25519)(?:\.|$)/i,
  /\.(?:pem|p12|pfx|key)$/i,
];

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(\b(?:(?:[a-z0-9]+[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|client[_-]?secret)|password|passwd|cookie)\b\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]"],
  [/(\bAuthorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]"],
  [/\b(?:sk|pk|ghp|github_pat)_[A-Za-z0-9_\-]{16,}\b/g, "[REDACTED_TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
];

const SECRET_KEY_PATTERN = /(?:api[_-]?key|token|secret|password|passwd|cookie|authorization)/i;

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement),
    value,
  );
}

export function redactStructured(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[REDACTED_MAX_DEPTH]";
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactStructured(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactStructured(item, depth + 1),
      ]),
    );
  }
  return value;
}

export function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replaceAll(path.sep, "/").replace(/^\.\//, "");
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function filterSafePaths(paths: string[]): string[] {
  return paths.filter((filePath) => !isSensitivePath(filePath));
}

export function assertSafeRelativePattern(pattern: string): string {
  const normalized = pattern.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error("Scope patterns must be non-empty repository-relative paths.");
  }
  if (normalized.split("/").includes("..")) {
    throw new Error("Scope patterns cannot escape the repository root.");
  }
  if (isSensitivePath(normalized)) {
    throw new Error("Sensitive credential paths cannot be claimed or recorded.");
  }
  return normalized;
}
