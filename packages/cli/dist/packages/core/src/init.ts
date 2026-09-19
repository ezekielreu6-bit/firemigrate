import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CONFIG_FILE, ConfigError, DEFAULT_BATCH_SIZE, ENV_EXAMPLE_FILE, PACKAGE_RUNNER, defaultConfig } from './config'

const CONFIG_CONTENTS = `${JSON.stringify({ ...defaultConfig(), batchSize: DEFAULT_BATCH_SIZE }, null, 2)}\n`

const ENV_CONTENTS = [
  '# Firebase service account (Firebase console > Project settings > Service accounts)',
  'FIREBASE_PROJECT_ID=',
  'FIREBASE_CLIENT_EMAIL=',
  '# Keep the literal \\n sequences from the downloaded JSON key',
  'FIREBASE_PRIVATE_KEY=',
  '# PostgreSQL destination (not needed for inspect)',
  'DATABASE_URL=',
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
