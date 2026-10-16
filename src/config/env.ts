import { readFileSync } from 'node:fs'

function env(key: string): string | undefined {
  const val = process.env[key]
  return val || undefined
}

/**
 * Read an env var, falling back to the file referenced by `${key}_FILE`.
 * Enables the Docker / Compose secrets convention without forcing users to
 * inline sensitive values in shell env. Returns undefined if both miss.
 */
function envOrFile(key: string): string | undefined {
  const direct = env(key)
  if (direct) return direct
  const filePath = env(`${key}_FILE`)
  if (!filePath) return undefined
  try {
    return readFileSync(filePath, 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

function envBool(key: string, fallback = false): boolean {
  const val = process.env[key]
  if (!val) return fallback
  return val === 'true' || val === '1'
}

function envInt(key: string): number | undefined {
  const val = process.env[key]
  if (!val) return undefined
  const n = Number.parseInt(val, 10)
  return Number.isNaN(n) ? undefined : n
}

function envOneOf<const T extends readonly string[]>(
  key: string,
  allowed: T,
): T[number] | undefined {
  const val = process.env[key]
  if (!val) return undefined
  return allowed.includes(val) ? val : undefined
}

const DB_SSL_MODES = ['disable', 'require', 'no-verify'] as const

export const envConfig = {
  // Database
  databaseUrl: envOrFile('DATABASE_URL'),
  dbHost: env('DB_HOST'),
  dbPort: envInt('DB_PORT'),
  dbUser: env('DB_USER'),
  dbPass: envOrFile('DB_PASS'),
  dbName: env('DB_NAME'),
  dbPath: env('DB_PATH'),
  dbPoolMax: envInt('DB_POOL_MAX'),
  dbConnectTimeoutMs: envInt('DB_CONNECT_TIMEOUT_MS'),
  dbSslMode: envOneOf('DB_SSL_MODE', DB_SSL_MODES),

  // Server
  port: envInt('PORT') ?? 3000,
  allowedOrigin: env('ALLOWED_ORIGIN'),
  // Space/comma-separated origins allowed to show DJ Llama inside a frame
  // (e.g. a car-dashboard launcher). Unset = never framed by other sites.
  frameAncestors: (env('DJLLAMA_FRAME_ANCESTORS') ?? '').split(/[\s,]+/).filter(Boolean),
  allowInsecureCookies: envBool('DJLLAMA_ALLOW_INSECURE_COOKIES', false),

  // Lidarr
  lidarrUrl: env('LIDARR_URL'),
  lidarrApiKey: env('LIDARR_API_KEY'),
  skipTlsVerify: envBool('SKIP_TLS_VERIFY'),

  // AI provider
  aiProvider: env('AI_PROVIDER'),
  aiApiKey: env('AI_API_KEY'),
  aiModel: env('AI_MODEL'),
  aiBaseUrl: env('AI_BASE_URL'),
  aiTimeoutSeconds: envInt('DJLLAMA_AI_TIMEOUT_SECONDS'),

  // Auth
  authToken: env('DJLLAMA_AUTH_TOKEN') ?? null,

  // Integrations (machine-to-machine, e.g. BuxFlix's landing page pulling
  // recommendations -- see /api/v1/integrations/recommendations)
  integrationsToken: envOrFile('DJLLAMA_INTEGRATIONS_TOKEN') ?? null,

  // Webhook (injected into preferences during auto-setup only)
  webhookUrl: env('WEBHOOK_URL'),

  // Encryption (optional - encrypts API keys and tokens at rest in the DB)
  encryptionKey: env('DJLLAMA_ENCRYPTION_KEY'),
  // Secondary key for rotation. When set, decryptField falls back to this
  // key if the primary key fails (see scripts/rotate-encryption-key.ts).
  encryptionKeyNext: env('DJLLAMA_ENCRYPTION_KEY_NEXT'),
} as const

export type EnvConfig = typeof envConfig

/**
 * Build a DATABASE_URL from either the env var directly or individual DB_* vars.
 * Throws if neither is configured.
 */
export function buildDatabaseUrl(): string {
  if (envConfig.databaseUrl) return envConfig.databaseUrl

  const { dbHost, dbPort, dbUser, dbPass, dbName } = envConfig
  if (dbHost && dbUser && dbName) {
    const port = dbPort ?? 5432
    const pass = dbPass ? `:${encodeURIComponent(dbPass)}` : ''
    return `postgresql://${dbUser}${pass}@${dbHost}:${port}/${dbName}`
  }

  throw new Error('DATABASE_URL or DB_HOST + DB_USER + DB_NAME must be set')
}

/** Settings fields that can be sourced from env vars (fallback for null DB values). */
const ENV_OVERRIDE_KEYS = [
  'lidarrUrl',
  'lidarrApiKey',
  // skipTlsVerify is NOT NULL in the DB (defaults false), so null-merge never applies
  'aiProvider',
  'aiApiKey',
  'aiModel',
  'aiBaseUrl',
] as const satisfies ReadonlyArray<keyof EnvConfig>

export function envSettingsOverrides(): Record<string, unknown> {
  const overrides: Record<string, unknown> = {}
  for (const key of ENV_OVERRIDE_KEYS) {
    if (envConfig[key]) overrides[key] = envConfig[key]
  }
  return overrides
}

/** True if env vars contain all required fields to auto-complete setup. */
export function canAutoSetup(): boolean {
  const { aiProvider, aiModel } = envConfig
  // AI provider + model are always required
  if (!aiProvider || !aiModel) return false
  // Lidarr is optional - if not set, runs in discovery-only mode
  return true
}
