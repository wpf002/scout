import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().max(65535).default(3001),
  /**
   * Audit attribution. Single-operator until Phase 8 adds real auth; every
   * QueryLog row still carries a name so the column does not have to be
   * backfilled later.
   */
  SCOUT_OPERATOR: z.string().min(1).default("local"),
  /**
   * Origins allowed to call the API from a browser, comma-separated.
   * Defaults to the local dashboard. Deliberately an allowlist and never `*`:
   * this API executes scope-gated lookups, so any origin being able to drive
   * it from a victim's browser is not an acceptable default.
   */
  SCOUT_WEB_ORIGINS: z.string().default("http://localhost:3000"),
  /**
   * Require a bearer token. Defaults to ON in production, because an audit log
   * whose every row says "local" cannot answer the question it exists to
   * answer. Off in development so a single local operator is not blocked by
   * ceremony.
   */
  SCOUT_AUTH_REQUIRED: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const withDefaults = {
    ...env,
    SCOUT_AUTH_REQUIRED:
      env["SCOUT_AUTH_REQUIRED"] ??
      (env["NODE_ENV"] === "production" ? "true" : "false"),
  };
  const parsed = configSchema.safeParse(withDefaults);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config: Config = loadConfig();
