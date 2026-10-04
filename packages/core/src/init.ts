import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CONFIG_FILE, ConfigError, ENV_EXAMPLE_FILE, PACKAGE_RUNNER, defaultConfig } from './config'

const CONFIG_CONTENTS = `${JSON.stringify(defaultConfig(), null, 2)}\n`

const ENV_CONTENTS = [
  '# Firebase service account (Firebase console > Project settings > Service accounts)',
  'FIREBASE_PROJECT_ID=',
  'FIREBASE_CLIENT_EMAIL=',
  '# Keep the literal \\n sequences from the downloaded JSON key',
  'FIREBASE_PRIVATE_KEY=',
  '# Direct Postgres URL. For Supabase use the session pooler or direct connection, not the HTTP API URL.',
  'DATABASE_URL=',
  '# Optional. Firebase console > Authentication > Users > password hash parameters.',
  '# Used only to build supabase_password_hash. Raw hashes are still stored without these.',
  'FIREBASE_HASH_SIGNER_KEY=',
  'FIREBASE_HASH_SALT_SEPARATOR=',
  'FIREBASE_HASH_ROUNDS=8',
  'FIREBASE_HASH_MEM_COST=14',
  '# Optional Storage bucket. Defaults to <project-id>.appspot.com, then <project-id>.firebasestorage.app',
  'FIREBASE_STORAGE_BUCKET=',
  '',
].join('\n')

export function initializeProject(args: string[], cwd: string = process.cwd()): string {
  const unknown = args.filter((arg) => arg !== '--force')
  if (unknown.length) throw new ConfigError(`Unknown option for init: ${unknown.join(' ')}. Supported: --force`)
  const force = args.includes('--force')
  const targets = [
    { name: CONFIG_FILE, contents: CONFIG_CONTENTS },
    { name: ENV_EXAMPLE_FILE, contents: ENV_CONTENTS },
  ].map((file) => ({ ...file, path: resolve(cwd, file.name) }))

  const existing = targets.filter((target) => existsSync(target.path))
  if (existing.length && !force) {
    throw new ConfigError(`Refusing to overwrite existing file(s): ${existing.map((target) => target.name).join(', ')}. Nothing was written. Re-run with --force to overwrite.`)
  }

  const lines = targets.map((target) => {
    const existed = existsSync(target.path)
    writeFileSync(target.path, target.contents, { encoding: 'utf8', flag: force ? 'w' : 'wx' })
    return `  ${existed ? 'overwrote' : 'created'}  ${target.path}`
  })

  return [
    'FireMigrate project files:',
    ...lines,
    '',
    'Next steps:',
    `  1. Provide your Firebase service-account values as environment variables (see ${ENV_EXAMPLE_FILE}).`,
    `  2. Keep real credentials out of git. ${CONFIG_FILE} is safe to commit only while its credential fields stay empty.`,
    `  3. Run: ${PACKAGE_RUNNER} inspect`,
    '',
  ].join('\n')
}
