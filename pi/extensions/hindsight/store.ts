import { basename, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

export function projectBasename(cwd: string): string {
  const name = basename(resolve(cwd));
  if (!name || name === "." || name === ".." || name.includes(sep) || name.includes("/")) return "root";
  return name;
}

export function projectKey(cwd: string): string {
  const resolved = resolve(cwd);
  const rawBase = projectBasename(cwd);
  const base = rawBase.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeBase = !base || base === "." || base === ".." ? "root" : base;
  const hash = createHash("sha1").update(resolved).digest("hex").slice(0, 8);
  return `${safeBase}-${hash}`;
}

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\b\s*[:=]\s*["']?[^"'\s]{4,}/gi,
  /\b(sk-[A-Za-z0-9_-]{20,})\b/g,
  /\b(ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xoxb-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
  /\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*["']?[^"'\s]{8,}/gi,
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}
