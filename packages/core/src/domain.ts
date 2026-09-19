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

export interface DatabaseAdapter { name: string; connect(): Promise<void>; applySchema(schema: SchemaProposal, options: MigrationOptions): Promise<void>; insert(table: string, rows: Record<string, unknown>[]): Promise<number>; verify(): Promise<{ mismatches: number; errors: string[] }>; close(): Promise<void>; countRows?(table: string): Promise<number | null>; drainWarnings?(): string[] }

export interface FireMigrateServices { discovery: FirebaseDiscovery; schema: SchemaGenerator; destination: DatabaseAdapter }

export const FIREMIGRATE_COMMANDS = ['init', 'inspect', 'schema', 'migrate', 'verify'] as const

export type FireMigrateCommand = (typeof FIREMIGRATE_COMMANDS)[number]

export function redactSecret(value: string): string { return value ? `${value.slice(0, 3)}…${value.slice(-2)}` : '' }

export function toPostgresType(types: FirestoreFieldType[]): string { if (types.length !== 1) return 'jsonb'; return ({ string: 'text', number: 'double precision', boolean: 'boolean', timestamp: 'timestamptz', reference: 'text', array: 'jsonb', map: 'jsonb', null: 'text' } as Record<string, string>)[types[0]] ?? 'jsonb' }

export function toTableName(collectionName: string): string { return collectionName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase() }

export function createSchemaSql(tables: ProposedTable[]): string {
  return tables.map((table) => {
    const columns = table.columns.map((column) => ` "${column.name}" ${column.type}${column.nullable ? '' : ' NOT NULL'}`)
    const constraints = [' PRIMARY KEY ("id")', ...table.foreignKeys.filter((key) => !key.needsReview).map((key) => ` FOREIGN KEY ("${key.column}") REFERENCES "${toTableName(key.references)}" ("id")`)]
    return `CREATE TABLE IF NOT EXISTS "${table.name}" (\n${[...columns, ...constraints].join(',\n')}\n);`
  }).join('\n\n')
}

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
    '  verify    Check PostgreSQL connectivity and compare row counts with Firestore',
    '',
  ].join('\n')
}

export function requireConfiguration(command: string, config: FireMigrateConfig, configPath: string | null, needsDatabase: boolean): void { assertConfigured(command, config, configPath, needsDatabase) }

export interface PgQueryResult { rows: Record<string, unknown>[] }
export interface PgQueryable { query(text: string, values?: unknown[]): Promise<PgQueryResult> }
export interface PgClient extends PgQueryable { release(): void }
export interface PgPool extends PgQueryable { connect(): Promise<PgClient>; end(): Promise<void> }

/** PostgreSQL allows 65535 bind parameters per statement; stay well under it. */
const MAX_BIND_PARAMETERS = 60000
const MAX_ADAPTER_MESSAGES = 20

export class PostgresAdapter implements DatabaseAdapter {
  name = 'postgresql'
  private pool: PgPool | undefined
  private tables = new Map<string, ProposedTable>()
  private messages: string[] = []
  private suppressed = 0
  private droppedFields = new Map<string, number>()
  constructor(private readonly databaseUrl: string, private readonly openPool?: () => Promise<PgPool>) {}
  async connect(): Promise<void> {
    if (!this.databaseUrl) throw new Error('DATABASE_URL is required')
    if (this.openPool) this.pool = await this.openPool()
    else {
      const { Pool } = await import('pg')
      this.pool = new Pool({ connectionString: this.databaseUrl, max: 4, connectionTimeoutMillis: 10000 }) as unknown as PgPool
    }
    await this.pool.query('SELECT 1')
  }
  async applySchema(schema: SchemaProposal, options: MigrationOptions): Promise<void> {
    if (!schema.sql) throw new Error('Schema SQL is empty')
    this.tables = new Map(schema.tables.map((table) => [table.name, table]))
    if (options.dryRun) return
    if (!this.pool) throw new Error('Database is not connected')
    // A pool hands out any connection per query(), so BEGIN/COMMIT must share one dedicated client to be a real transaction.
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(schema.sql)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
  async insert(table: string, rows: Record<string, unknown>[]): Promise<number> {
    const pool = this.pool
    if (!pool || rows.length === 0) return 0
    const meta = this.tables.get(table)
    const columns = meta ? meta.columns.map((column) => ({ name: column.name, type: column.type })) : unionColumns(rows)
    const known = new Set(columns.map((column) => column.name))
    const valid: Record<string, unknown>[] = []
    for (const row of rows) {
      if (row.id === undefined || row.id === null) { this.note(`${table}: a document without an id was skipped`); continue }
      for (const key of Object.keys(row)) if (!known.has(key)) this.droppedFields.set(`${table}\u0000${key}`, (this.droppedFields.get(`${table}\u0000${key}`) ?? 0) + 1)
      valid.push(row)
    }
    const perStatement = Math.max(1, Math.floor(MAX_BIND_PARAMETERS / Math.max(1, columns.length)))
    let written = 0
    for (let start = 0; start < valid.length; start += perStatement) {
      const chunk = valid.slice(start, start + perStatement)
      try {
        await this.insertChunk(pool, table, columns, chunk)
        written += chunk.length
      } catch {
        // One bad document must not sink the whole batch: retry one by one and report exactly which ones failed.
        for (const row of chunk) {
          try { await this.insertChunk(pool, table, columns, [row]); written += 1 } catch (error) { this.note(`${table}: document ${String(row.id)} failed: ${errorMessage(error)}`) }
        }
      }
    }
    return written
  }
  private async insertChunk(pool: PgPool, table: string, columns: { name: string; type: string }[], rows: Record<string, unknown>[]): Promise<void> {
    const values: unknown[] = []
    const tuples = rows.map((row) => `(${columns.map((column) => { values.push(serializeForColumn(row[column.name], column.type)); return `$${values.length}` }).join(', ')})`).join(', ')
    const updates = columns.filter((column) => column.name !== 'id').map((column) => `${quoteIdentifier(column.name)} = EXCLUDED.${quoteIdentifier(column.name)}`)
    await pool.query(`INSERT INTO ${quoteIdentifier(table)} (${columns.map((column) => quoteIdentifier(column.name)).join(', ')}) VALUES ${tuples} ON CONFLICT ("id") ${updates.length ? `DO UPDATE SET ${updates.join(', ')}` : 'DO NOTHING'}`, values)
  }
  async countRows(table: string): Promise<number | null> {
    if (!this.pool) return null
    try {
      const result = await this.pool.query(`SELECT count(*) AS n FROM ${quoteIdentifier(table)}`)
      return Number(result.rows[0]?.n ?? 0)
    } catch (error) {
      if ((error as { code?: string }).code === '42P01') return null
      throw error
    }
  }
  async verify(): Promise<{ mismatches: number; errors: string[] }> {
    if (!this.pool) return { mismatches: 0, errors: ['Database is not connected'] }
    try { await this.pool.query('SELECT current_database()'); return { mismatches: 0, errors: [] } } catch (error) { return { mismatches: 1, errors: [errorMessage(error)] } }
  }
  drainWarnings(): string[] {
    const out = [...this.messages]
    if (this.suppressed) out.push(`${this.suppressed} more message(s) suppressed`)
    for (const [key, count] of this.droppedFields) {
      const [table, field] = key.split('\u0000')
      out.push(`${table}: field "${field}" is not in the inferred schema and was skipped in ${count} document(s); the schema is inferred from a sample, so re-check it`)
    }
    this.messages = []
    this.suppressed = 0
    this.droppedFields = new Map()
    return out
  }
  async close(): Promise<void> { await this.pool?.end(); this.pool = undefined }
  private note(message: string): void { if (this.messages.length < MAX_ADAPTER_MESSAGES) this.messages.push(message); else this.suppressed += 1 }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function quoteIdentifier(value: string): string { return `"${value.replace(/"/g, '""')}"` }
function unionColumns(rows: Record<string, unknown>[]): { name: string; type: string }[] {
  const names = new Set<string>()
  for (const row of rows) for (const key of Object.keys(row)) names.add(key)
  return [...names].map((name) => ({ name, type: 'unknown' }))
}
/** Timestamps become ISO strings and document references become their path, instead of leaking SDK internals or cycles. */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    const candidate = value as { toDate?: () => Date; path?: unknown }
    if (typeof candidate.toDate === 'function') return candidate.toDate().toISOString()
    if (typeof candidate.path === 'string' && 'firestore' in candidate) return candidate.path
  }
  return value
}
function serializeForColumn(value: unknown, type: string): unknown {
  if (value === undefined || value === null) return null
  // Mixed-type fields map to jsonb: a plain string like "hello" is not valid JSON, so every value must be JSON-encoded.
  if (type === 'jsonb') return JSON.stringify(value, jsonReplacer)
  return serializePostgresValue(value)
}
function serializePostgresValue(value: unknown): unknown {
  if (value === undefined) return null
  if (value instanceof Date) return value
  if (value !== null && typeof value === 'object') {
    const candidate = value as { toDate?: () => Date; path?: unknown }
    if (typeof candidate.toDate === 'function') return candidate.toDate()
    if (typeof candidate.path === 'string' && 'firestore' in candidate) return candidate.path
    return JSON.stringify(value, jsonReplacer)
  }
  return value
}

/** Compares real PostgreSQL row counts with the expected document counts. This is the only check that proves rows arrived. */
export async function compareRowCounts(destination: DatabaseAdapter, collections: { name: string; documentCount: number }[]): Promise<{ compared: number; mismatches: number; errors: string[] }> {
  if (!destination.countRows) return { compared: 0, mismatches: 0, errors: ['This destination cannot count rows, so no counts were compared.'] }
  let compared = 0
  let mismatches = 0
  const errors: string[] = []
  for (const collection of collections) {
    const table = toTableName(collection.name)
    const rows = await destination.countRows(table)
    if (rows === null) { mismatches += 1; errors.push(`Table "${table}" does not exist in PostgreSQL (Firestore collection "${collection.name}" has ${collection.documentCount} documents)`); continue }
    compared += 1
    if (rows !== collection.documentCount) { mismatches += 1; errors.push(`"${table}": PostgreSQL has ${rows} rows, expected ${collection.documentCount}`) }
  }
  return { compared, mismatches, errors }
}

export class UnconfiguredFirebaseDiscovery implements FirebaseDiscovery {
  constructor(private readonly missing: string[] = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']) {}
  private failure(): Error { return new Error(`Firebase credentials are not configured (missing: ${this.missing.join(', ')}). Provide them as environment variables or in firemigrate.config.json, then run again.`) }
  async inspect(): Promise<InspectionReport> { throw this.failure() }
  async inspectAuth(): Promise<AuthSummary> { throw this.failure() }
  async *streamDocuments(_collectionPath: string): AsyncIterable<Record<string, unknown>> { throw this.failure(); yield {} }
}

export class BasicSchemaGenerator implements SchemaGenerator {
  async generate(report: InspectionReport): Promise<SchemaProposal> {
    const warnings = [...report.warnings]
    const tables = report.collections.map((collection) => {
      if (collection.fields.some((field) => field.name === 'id')) warnings.push(`${collection.name} has a document field named "id"; it collides with the document id column and is not migrated`)
      const fields = collection.fields.filter((field) => field.name !== 'id')
      return { name: toTableName(collection.name), sourcePath: collection.path, columns: [{ name: 'id', type: 'text', nullable: false, sourceField: '__name__' }, ...fields.map((field) => ({ name: field.name, type: toPostgresType(field.types), nullable: field.presenceRate < 1, sourceField: field.name }))], foreignKeys: fields.filter((field) => field.relationship).map((field) => ({ column: field.name, references: field.relationship!.targetCollection, confidence: field.relationship!.confidence, needsReview: field.relationship!.confidence < 0.85 })) }
    })
    return { tables, sql: createSchemaSql(tables), warnings }
  }
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
    const streamed: { name: string; documentCount: number }[] = []
    for (const collection of inspection.collections) {
      const table = toTableName(collection.name)
      let rows: Record<string, unknown>[] = []
      let streamedCount = 0
      const flush = async (): Promise<void> => {
        if (!rows.length) return
        const batch = rows
        rows = []
        if (options.dryRun) { report.skipped += batch.length; return }
        const written = await services.destination.insert(table, batch)
        report.migrated += written
        report.failed += batch.length - written
      }
      for await (const document of services.discovery.streamDocuments(collection.path)) {
        report.discovered += 1
        streamedCount += 1
        rows.push(document)
        if (rows.length >= options.batchSize) await flush()
      }
      await flush()
      streamed.push({ name: collection.name, documentCount: streamedCount })
    }
    if (options.dryRun) {
      report.notes = ['Dry run: no data was written.', 'Row counts are only compared on a real write.']
    } else {
      const comparison = await compareRowCounts(services.destination, streamed)
      report.mismatches = comparison.mismatches
      report.errors.push(...comparison.errors)
      report.notes = ['Documents were upserted by id in batches, then PostgreSQL row counts were compared with the documents streamed from Firestore.']
    }
    report.errors.push(...(services.destination.drainWarnings?.() ?? []))
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
    if (!services) requireConfiguration(command, config, configPath, true)
    const active = services ?? createServices(undefined, config)
    await active.destination.connect()
    try {
      const connectivity = await active.destination.verify()
      const inspection = await active.discovery.inspect()
      assertFirestoreReadable(inspection)
      const comparison = await compareRowCounts(active.destination, inspection.collections)
      const mismatches = connectivity.mismatches + comparison.mismatches
      const errors = [...connectivity.errors, ...comparison.errors]
      if (mismatches || errors.length) process.exitCode = 1
      return JSON.stringify({ connected: connectivity.errors.length === 0, tablesCompared: comparison.compared, mismatches, errors }, null, 2)
    } finally { await active.destination.close() }
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
  const migration = await runMigration(services ?? createServices(undefined, config), options)
  if (migration.failed > 0 || migration.mismatches > 0) process.exitCode = 1
  return JSON.stringify(migration, null, 2)
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

export const VERSION = '0.1.3'

export default { createServices, runMigration, runCli }
