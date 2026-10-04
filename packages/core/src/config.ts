import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const CONFIG_FILE = 'firemigrate.config.json'
export const ENV_EXAMPLE_FILE = '.env.example'
export const DEFAULT_BATCH_SIZE = 500
export const PACKAGE_RUNNER = 'npx @ezekielreu6/firemigrate'

export interface AuthHashConfig {
  signerKey: string
  saltSeparator: string
  rounds: number
  memCost: number
}

export interface FireMigrateConfig {
  dryRun: boolean
  destructive: boolean
  batchSize: number
  subcollections: boolean
  firebase: { projectId: string; clientEmail: string; privateKey: string }
  postgres: { databaseUrl: string }
  auth: { migrate: boolean; includePasswordHashes: boolean; hash: AuthHashConfig }
  storage: { migrateMetadata: boolean; bucket: string }
}

export interface LoadedConfig { config: FireMigrateConfig; configPath: string | null }

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function defaultConfig(): FireMigrateConfig {
  return {
    dryRun: true,
    destructive: false,
    batchSize: DEFAULT_BATCH_SIZE,
    subcollections: true,
    firebase: { projectId: '', clientEmail: '', privateKey: '' },
    postgres: { databaseUrl: '' },
    auth: { migrate: true, includePasswordHashes: true, hash: { signerKey: '', saltSeparator: '', rounds: 8, memCost: 14 } },
    storage: { migrateMetadata: true, bucket: '' },
  }
}

const PLACEHOLDER_HINTS = ['your-firebase-project-id', 'service-account@example.com', 'replace-me', 'user:password@localhost']

function text(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return PLACEHOLDER_HINTS.some((hint) => trimmed.includes(hint)) ? '' : trimmed
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

export function normalizePrivateKey(key: string): string {
  const unquoted = key.length >= 2 && key.startsWith('"') && key.endsWith('"') ? key.slice(1, -1) : key
  return unquoted.replace(/\\n/g, '\n')
}

export function loadConfig(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const path = resolve(cwd, CONFIG_FILE)
  let raw: Record<string, unknown> = {}
  let configPath: string | null = null
  if (existsSync(path)) {
    try {
      raw = asRecord(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      throw new ConfigError(`${CONFIG_FILE} is not valid JSON. Fix the file, or regenerate it with: ${PACKAGE_RUNNER} init --force`)
    }
    configPath = path
  }
  const firebase = asRecord(raw.firebase)
  const postgres = asRecord(raw.postgres)
  const auth = asRecord(raw.auth)
  const hash = asRecord(auth.hash)
  const storage = asRecord(raw.storage)
  const defaults = defaultConfig()
  const config: FireMigrateConfig = {
    dryRun: raw.dryRun !== false,
    destructive: raw.destructive === true,
    batchSize: positiveInt(raw.batchSize, DEFAULT_BATCH_SIZE),
    subcollections: flag(raw.subcollections, true),
    firebase: {
      projectId: text(env.FIREBASE_PROJECT_ID) || text(firebase.projectId),
      clientEmail: text(env.FIREBASE_CLIENT_EMAIL) || text(firebase.clientEmail),
      privateKey: normalizePrivateKey(text(env.FIREBASE_PRIVATE_KEY) || text(firebase.privateKey)),
    },
    postgres: { databaseUrl: text(env.DATABASE_URL) || text(postgres.databaseUrl) || text(raw.databaseUrl) },
    auth: {
      migrate: flag(auth.migrate, true),
      includePasswordHashes: flag(auth.includePasswordHashes, true),
      hash: {
        signerKey: text(env.FIREBASE_HASH_SIGNER_KEY) || text(hash.signerKey),
        saltSeparator: text(env.FIREBASE_HASH_SALT_SEPARATOR) || text(hash.saltSeparator),
        rounds: positiveInt(env.FIREBASE_HASH_ROUNDS ? Number(env.FIREBASE_HASH_ROUNDS) : hash.rounds, defaults.auth.hash.rounds),
        memCost: positiveInt(env.FIREBASE_HASH_MEM_COST ? Number(env.FIREBASE_HASH_MEM_COST) : hash.memCost, defaults.auth.hash.memCost),
      },
    },
    storage: {
      migrateMetadata: flag(storage.migrateMetadata, true),
      bucket: text(env.FIREBASE_STORAGE_BUCKET) || text(storage.bucket),
    },
  }
  return { config, configPath }
}

export function missingFirebaseCredentials(config: FireMigrateConfig): string[] {
  const missing: string[] = []
  if (!config.firebase.projectId) missing.push('FIREBASE_PROJECT_ID')
  if (!config.firebase.clientEmail) missing.push('FIREBASE_CLIENT_EMAIL')
  if (!config.firebase.privateKey) missing.push('FIREBASE_PRIVATE_KEY')
  return missing
}

export function missingConfiguration(config: FireMigrateConfig, needsDatabase: boolean): string[] {
  const missing = missingFirebaseCredentials(config)
  if (needsDatabase && !config.postgres.databaseUrl) missing.push('DATABASE_URL')
  return missing
}

export function describeMissingConfiguration(command: string, missing: string[], configPath: string | null): string {
  const steps: string[] = []
  if (!configPath) steps.push(`No ${CONFIG_FILE} found in this directory. Create one with: ${PACKAGE_RUNNER} init`)
  steps.push('In the Firebase console open Project settings > Service accounts and generate a private key.')
  steps.push(`Provide the values as environment variables (names are listed in ${ENV_EXAMPLE_FILE}) or in the "firebase"/"postgres" sections of ${CONFIG_FILE}. Never commit real credentials.`)
  steps.push(`Run again: ${PACKAGE_RUNNER} ${command}`)
  return [`${command} cannot run yet. Missing configuration: ${missing.join(', ')}.`, '', 'Next steps:', ...steps.map((step, index) => `  ${index + 1}. ${step}`)].join('\n')
}

export function assertConfigured(command: string, config: FireMigrateConfig, configPath: string | null, needsDatabase: boolean): void {
  const missing = missingConfiguration(config, needsDatabase)
  if (missing.length) throw new ConfigError(describeMissingConfiguration(command, missing, configPath))
}

export function scrubSecrets(message: string, config: FireMigrateConfig): string {
  let out = message.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]')
  const secrets = [config.firebase.privateKey, config.firebase.privateKey.replace(/\n/g, '\\n'), config.postgres.databaseUrl, config.auth.hash.signerKey, config.auth.hash.saltSeparator]
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join('[redacted]')
  return out
}
