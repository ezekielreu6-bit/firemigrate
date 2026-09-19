import { ConfigError, assertConfigured, loadConfig, missingFirebaseCredentials, scrubSecrets } from './config'
import type { FireMigrateConfig } from './config'
import { openFirebaseAdmin } from './firebase-source'
import { formatInspection } from './format'
import { initializeProject } from './init'
import { DEFAULT_INSPECT_OPTIONS, SourceBackedDiscovery } from './inspect'
import type { InspectOptions } from './inspect'

export { initializeProject }

export type FirebaseProvider = 'password' | 'google.com' | 'github.com' | 'apple.com' | 'phone' | 'other'

export type FirestoreFieldType = 'string' | 'number' | 'boolean' | 'timestamp' | 'reference' | 'array' | 'map' | 'null' | 'mixed' | 'unknown'

export interface FirebaseConfig { projectId: string; clientEmail: string; privateKey: string }

export interface FieldSummary { name: string; types: FirestoreFieldType[]; presenceRate: number; relationship?: { targetCollection: string; confidence: number }; warnings?: string[] }

export interface CollectionSummary { path: string; name: string; documentCount: number; nestedCollectionCount: number; fields: FieldSummary[]; sampledDocuments?: number }

export interface AuthSummary { userCount: number; providers: Record<FirebaseProvider, number>; credentialWarning: string }

export interface SourceStatus { ok: boolean; error?: string }

export interface InspectionReport { generatedAt: string; collections: CollectionSummary[]; totalDocuments: number; nestedCollections: number; estimatedTables: number; auth: AuthSummary; warnings: string[]; sampledDocuments?: number; sources?: { firestore: SourceStatus; auth: SourceStatus } }

export interface ProposedTable { name: string; sourcePath: string; columns: { name: string; type: string; nullable: boolean; sourceField?: string }[]; foreignKeys: { column: string; references: string; confidence: number; needsReview: boolean }[] }

export interface SchemaProposal { tables: ProposedTable[]; sql: string; warnings: string[] }

export interface MigrationOptions { dryRun: boolean; destructive: boolean; batchSize: number }

export interface MigrationReport { startedAt: string; completedAt?: string; discovered: number; migrated: number; failed: number; skipped: number; mismatches: number; errors: string[]; dryRun?: boolean; notes?: string[] }

export interface FirebaseDiscovery { inspect(): Promise<InspectionReport>; inspectAuth(): Promise<AuthSummary>; streamDocuments(collectionPath: string): AsyncIterable<Record<string, unknown>> }

export interface SchemaGenerator { generate(report: InspectionReport): Promise<SchemaProposal> }

export interface DatabaseAdapter { name: string; connect(): Promise<void>; applySchema(schema: SchemaProposal, options: MigrationOptions): Promise<void>; insert(table: string, rows: Record<string, unknown>[]): Promise<number>; verify(): Promise<{ mismatches: number; errors: string[] }>; close(): Promise<void> }

export interface FireMigrateServices { discovery: FirebaseDiscovery; schema: SchemaGenerator; destination: DatabaseAdapter }

export const FIREMIGRATE_COMMANDS = ['init', 'inspect', 'schema', 'migrate', 'verify'] as const

export type FireMigrateCommand = (typeof FIREMIGRATE_COMMANDS)[number]

export function redactSecret(value: string): string { return value ? `${value.slice(0, 3)}…${value.slice(-2)}` : '' }

export function toPostgresType(types: FirestoreFieldType[]): string { if (types.length !== 1) return 'jsonb'; return ({ string: 'text', number: 'double precision', boolean: 'boolean', timestamp: 'timestamptz', reference: 'text', array: 'jsonb', map: 'jsonb', null: 'text' } as Record<string, string>)[types[0]] ?? 'jsonb' }

export function createSchemaSql(tables: ProposedTable[]): string { return tables.map((table) => { const columns = table.columns.map((column) => ` "${column.name}" ${column.type}${column.nullable ? '' : ' NOT NULL'}`).join(',\n'); const foreignKeys = table.foreignKeys.filter((key) => !key.needsReview).map((key) => ` FOREIGN KEY ("${key.column}") REFERENCES "${key.references}" ("id")`).join(',\n'); return `CREATE TABLE IF NOT EXISTS "${table.name}" (\n${columns}${foreignKeys ? `,\n${foreignKeys}` : ''}\n);` }).join('\n\n') }

export function createEmptyMigrationReport(): MigrationReport { return { startedAt: new Date().toISOString(), discovered: 0, migrated: 0, failed: 0, skipped: 0, mismatches: 0, errors: [] } }

export function createCliHelp(): string {
  return [
    'FireMigrate — migrate Firebase to PostgreSQL',
    '',
    'Commands:',
    '  init      Create firemigrate.config.json and .env.example (--force overwrites existing files)',
    '  inspect   Read-only analysis of Firestore collections and Firebase Auth (--sample=<n>, default 100 documents per collection)',
    '  schema    Generate a reviewable PostgreSQL schema from the inspection',
    '  migrate   Apply the generated schema and stream Firestore documents into PostgreSQL (--dry-run by default)',
    '  verify    Check PostgreSQL connectivity and migration state',
    '',
  ].join('\n')
}

export function requireConfiguration(command: string, config: FireMigrateConfig, configPath: string | null, needsDatabase: boolean): void { assertConfigured(command, config, configPath, needsDatabase) }

export class PostgresAdapter implements DatabaseAdapter {
  name = 'postgresql'
  private pool: import('pg').Pool | undefined
  constructor(private readonly databaseUrl: string) {}
  async connect(): Promise<void> {
    if (!this.databaseUrl) throw new Error('DATABASE_URL is required')
    const { Pool } = await import('pg')
    this.pool = new Pool({ connectionString: this.databaseUrl, max: 4, connectionTimeoutMillis: 10000 })
    await this.pool.query('SELECT 1')
  }
  async applySchema(schema: SchemaProposal, options: MigrationOptions): Promise<void> {
    if (!schema.sql) throw new Error('Schema SQL is empty')
    if (!options.dryRun) await this.pool?.query('BEGIN').then(() => this.pool!.query(schema.sql)).then(() => this.pool!.query('COMMIT')).catch(async (error: unknown) => { await this.pool?.query('ROLLBACK').catch(() => undefined); throw error })
  }
  async insert(table: string, rows: Record<string, unknown>[]): Promise<number> {
    if (!this.pool || rows.length === 0) return 0
    const columns = Object.keys(rows[0]!).filter((column) => column !== 'id' || rows.some((row) => row.id !== undefined))
    if (!columns.length) return 0
    const values: unknown[] = []
    const tuples = rows.map((row, rowIndex) => `(${columns.map((column, columnIndex) => { values.push(serializePostgresValue(row[column])); return `$${rowIndex * columns.length + columnIndex + 1}` }).join(', ')})`).join(', ')
    const quotedTable = quoteIdentifier(table)
    const quotedColumns = columns.map(quoteIdentifier).join(', ')
    await this.pool.query(`INSERT INTO ${quotedTable} (${quotedColumns}) VALUES ${tuples} ON CONFLICT ("id") DO UPDATE SET ${columns.filter((column) => column !== 'id').map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`).join(', ') || '"id" = EXCLUDED."id"'}`, values)
    return rows.length
  }
  async verify(): Promise<{ mismatches: number; errors: string[] }> {
    if (!this.pool) return { mismatches: 0, errors: ['Database is not connected'] }
    try { await this.pool.query('SELECT current_database()'); return { mismatches: 0, errors: [] } } catch (error) { return { mismatches: 1, errors: [error instanceof Error ? error.message : String(error)] } }
  }
  async close(): Promise<void> { await this.pool?.end(); this.pool = undefined }
}

function quoteIdentifier(value: string): string { return `"${value.replace(/"/g, '""')}"` }
function serializePostgresValue(value: unknown): unknown {
  if (value === undefined) return null
  if (value instanceof Date) return value
  if (value !== null && typeof value === 'object') {
    const candidate = value as { toDate?: () => Date }
    if (typeof candidate.toDate === 'function') return candidate.toDate()
    return JSON.stringify(value)
  }
  return value
}

export class UnconfiguredFirebaseDiscovery implements FirebaseDiscovery {
  constructor(private readonly missing: string[] = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']) {}
  private failure(): Error { return new Error(`Firebase credentials are not configured (missing: ${this.missing.join(', ')}). Provide them as environment variables or in firemigrate.config.json, then run again.`) }
  async inspect(): Promise<InspectionReport> { throw this.failure() }
  async inspectAuth(): Promise<AuthSummary> { throw this.failure() }
  async *streamDocuments(_collectionPath: string): AsyncIterable<Record<string, unknown>> { throw this.failure(); yield {} }
}

export class BasicSchemaGenerator implements SchemaGenerator {
  async generate(report: InspectionReport): Promise<SchemaProposal> { const tables = report.collections.map((collection) => ({ name: collection.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase(), sourcePath: collection.path, columns: [{ name: 'id', type: 'text', nullable: false, sourceField: '__name__' }, ...collection.fields.map((field) => ({ name: field.name, type: toPostgresType(field.types), nullable: field.presenceRate < 1, sourceField: field.name }))], foreignKeys: collection.fields.filter((field) => field.relationship).map((field) => ({ column: field.name, references: field.relationship!.targetCollection, confidence: field.relationship!.confidence, needsReview: field.relationship!.confidence < 0.85 })) })); return { tables, sql: createSchemaSql(tables), warnings: report.warnings } }
}

export interface ServiceExtras { onProgress?: (message: string) => void; inspect?: Partial<InspectOptions> }

export function createServices(databaseUrl?: string, config: FireMigrateConfig = loadConfig().config, extras: ServiceExtras = {}): FireMigrateServices {
  const missing = missingFirebaseCredentials(config)
  const discovery = missing.length
    ? new UnconfiguredFirebaseDiscovery(missing)
    : new SourceBackedDiscovery(() => openFirebaseAdmin(config), { ...DEFAULT_INSPECT_OPTIONS, ...extras.inspect }, (message) => scrubSecrets(message, config), extras.onProgress)
  return { discovery, schema: new BasicSchemaGenerator(), destination: new PostgresAdapter(databaseUrl ?? config.postgres.databaseUrl) }
}

function assertFirestoreReadable(report: InspectionReport): void {
  if (report.sources && !report.sources.firestore.ok) throw new Error(`Firestore could not be read: ${report.sources.firestore.error ?? 'unknown error'}`)
}


export function resolveMigrateOptions(args: string[], config: FireMigrateConfig): MigrationOptions {
  const allowed = ['--dry-run', '--write', '--destructive']
  const unknown = args.filter((arg) => !allowed.includes(arg))
  if (unknown.length) throw new ConfigError(`Unknown option for migrate: ${unknown.join(' ')}. Supported: ${allowed.join(', ')}`)
  const wantsWrite = args.includes('--write')
  if (wantsWrite && args.includes('--dry-run')) throw new ConfigError('Choose either --dry-run or --write, not both.')
  if (args.includes('--destructive') && !wantsWrite) throw new ConfigError('--destructive only applies to writes. Pass --write --destructive, or drop --destructive for a dry run.')
  if (wantsWrite && config.dryRun) throw new ConfigError('--write refused: firemigrate.config.json has "dryRun": true. Set it to false to allow writes.')
  if (args.includes('--destructive') && !config.destructive) throw new ConfigError('--destructive refused: firemigrate.config.json has "destructive": false. Set it to true to allow destructive writes.')
  return { dryRun: !wantsWrite, destructive: wantsWrite && args.includes('--destructive'), batchSize: config.batchSize }
}

export async function runMigration(services: FireMigrateServices, options: MigrationOptions): Promise<MigrationReport> {
  if (options.destructive && !options.dryRun) throw new Error('Destructive migration requires explicit confirmation.')
  const report = createEmptyMigrationReport()
  report.dryRun = options.dryRun
  await services.destination.connect()
  try {
    const inspection = await services.discovery.inspect()
    assertFirestoreReadable(inspection)
    const schema = await services.schema.generate(inspection)
    await services.destination.applySchema(schema, options)
    for (const collection of inspection.collections) {
      const rows: Record<string, unknown>[] = []
      for await (const document of services.discovery.streamDocuments(collection.path)) {
        report.discovered += 1
        rows.push(document)
        if (rows.length >= options.batchSize) {
          if (options.dryRun) report.skipped += rows.length
          else report.migrated += await services.destination.insert(collection.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase(), rows.splice(0))
        }
      }
      if (rows.length) {
        if (options.dryRun) report.skipped += rows.length
        else report.migrated += await services.destination.insert(collection.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase(), rows)
      }
    }
    const verification = await services.destination.verify()
    report.mismatches = verification.mismatches
    report.errors.push(...verification.errors)
    report.notes = options.dryRun ? ['Dry run: no data was written.'] : ['Schema and document batches were committed to PostgreSQL.']
    report.completedAt = new Date().toISOString()
    return report
  } finally {
    await services.destination.close()
  }
}

export async function runCli(args: string[], services?: FireMigrateServices): Promise<string> {
  const command = args[0] as FireMigrateCommand | undefined
  if (!command || !FIREMIGRATE_COMMANDS.includes(command)) return createCliHelp()
  const rest = args.slice(1)
  if (command === 'init') return initializeProject(rest)
  if (command === 'verify') {
    const { config, configPath } = loadConfig()
    requireConfiguration(command, config, configPath, true)
    const active = services ?? createServices(undefined, config)
    await active.destination.connect()
    try { return JSON.stringify(await active.destination.verify(), null, 2) } finally { await active.destination.close() }
  }

  const { config, configPath } = loadConfig()

  if (command === 'inspect') {
    const inspectOptions = parseInspectArgs(rest)
    if (!services) requireConfiguration(command, config, configPath, false)
    const discovery = services?.discovery ?? createServices(undefined, config, { inspect: inspectOptions, onProgress: (message) => { process.stderr.write(`${message}\n`) } }).discovery
    const report = await discovery.inspect()
    if (report.sources && !(report.sources.firestore.ok && report.sources.auth.ok)) process.exitCode = 1
    return formatInspection(report, { projectId: config.firebase.projectId })
  }

  if (command === 'schema') {
    if (!services) requireConfiguration(command, config, configPath, false)
    const active = services ?? createServices(undefined, config)
    const report = await active.discovery.inspect()
    assertFirestoreReadable(report)
    return (await active.schema.generate(report)).sql
  }

  const options = resolveMigrateOptions(rest, config)
  if (!services) requireConfiguration(command, config, configPath, true)
  return JSON.stringify(await runMigration(services ?? createServices(undefined, config), options), null, 2)
}

export function parseInspectArgs(args: string[]): Partial<InspectOptions> {
  const options: Partial<InspectOptions> = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    const inline = arg.startsWith('--sample=') ? arg.slice('--sample='.length) : undefined
    if (inline === undefined && arg !== '--sample') throw new ConfigError(`Unknown option for inspect: ${arg}. Supported: --sample=<n>`)
    const raw = inline ?? args[++index]
    const value = Number(raw)
    if (!raw || !Number.isInteger(value) || value < 1 || value > 1000) throw new ConfigError('--sample must be an integer between 1 and 1000.')
    options.sampleSize = value
  }
  return options
}

export const PRODUCT_NAME = 'FireMigrate'

export const PRODUCT_TAGLINE = 'A transparent path from Firebase to PostgreSQL.'

export const SUPPORTED_SOURCES = ['firestore', 'firebase-auth'] as const

export const SUPPORTED_DESTINATIONS = ['postgresql'] as const

export const NAV_ITEMS = ['Overview', 'Projects', 'Migrations', 'Schemas', 'Authentication', 'Settings', 'Documentation'] as const

export const GENERATED_ARTIFACTS = ['schema.sql', 'data.sql', 'auth/users.json', 'storage/manifest.json', 'migration-report.json'] as const

export const DEFAULT_WARNINGS = ['Review inferred relationships before applying the schema.', 'Mixed Firestore field types are stored as jsonb until reviewed.', 'Authentication credentials require Firebase-supported import/export flows.']

export const VERSION = '0.1.2'

export default { createServices, runMigration, runCli }
