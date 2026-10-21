/**
 * Minimal structured logger.
 *
 * Deliberately dependency-free and deliberately noisy about redaction: the
 * values in this process include a service-role key that bypasses Row Level
 * Security. Anything that looks like a credential is masked before it reaches
 * stdout, so an accidental `logger.info(req.headers)` cannot leak it into a log
 * aggregator.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const configured = (process.env.LOG_LEVEL || "").toLowerCase();
  if (configured in LEVELS) return LEVELS[configured as Level];
  return process.env.NODE_ENV === "production" ? LEVELS.info : LEVELS.debug;
}

const SECRET_PATTERNS: RegExp[] = [
  /sb_secret_[A-Za-z0-9_-]+/g,
  /sb_publishable_[A-Za-z0-9_-]+/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // any JWT
  /postgres(?:ql)?:\/\/[^\s"']+/gi, // connection strings
];

const SECRET_KEYS = /^(authorization|apikey|api_key|cookie|password|token|access_token|refresh_token|service_role_key)$/i;

function maskString(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

function sanitise(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return maskString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return { name: value.name, message: maskString(value.message) };
  if (Array.isArray(value)) return value.map((v) => sanitise(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "[redacted]" : sanitise(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function emit(level: Level, message: string, meta?: Record<string, unknown>) {
  if (LEVELS[level] < threshold()) return;

  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: maskString(message),
  };
  if (meta) Object.assign(line, sanitise(meta) as Record<string, unknown>);

  const text = JSON.stringify(line);
  if (level === "error") process.stderr.write(text + "\n");
  else process.stdout.write(text + "\n");
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};

/** Exported for tests. */
export const __testing = { sanitise, maskString };
