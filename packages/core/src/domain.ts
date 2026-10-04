import { ConfigError, assertConfigured, loadConfig, missingFirebaseCredentials, scrubSecrets } from './config'
import type { AuthHashConfig, FireMigrateConfig } from './config'
import { openFirebaseAdmin } from './firebase-source'
import { formatInspection } from './format'
import { initializeProject } from './init'
import { AUTH_TABLE, DEFAULT_INSPECT_OPTIONS, STORAGE_TABLE, SourceBackedDiscovery } from './inspect'
import type { InspectOptions } from './inspect'

export { initializeProject }

export type FirebaseProvider = 'password' | 'google.com' | 'github.com' | 'apple.com' | 'phone' | 'other'
export type FirestoreFieldType = 'string' | 'number' | 'boolean' | 'timestamp' | 'reference' | 'array' | 'map' | 'null' | 'mixed' | 'unknown'
export type CollectionKind = 'collection' | 'subcollection' | 'auth' | 'storage'

export interface FieldSummary { name: string; types: FirestoreFieldType[]; presenceRate: number; relationship?: { targetCollection: string; confidence: number }; warnings?: string[] }
export interface CollectionSummary { path: string; name: string; documentCount: number; nestedCollectionCount: number; fields: FieldSummary[]; sampledDocuments?: number; kind?: CollectionKind; parentCollection?: string; countIsEstimate?: boolean }
export interface AuthSummary { userCount: number; providers: Record<FirebaseProvider, number>; credentialWarning: string; usersWithPasswordHash: number }
export interface SourceStatus { ok: boolean; error?: string }
export interface InspectionReport { generatedAt: string; collections: CollectionSummary[]; totalDocuments: number; nestedCollections: number; estimatedTables: number; auth: AuthSummary; warnings: string[]; sampledDocuments?: number; sources?: { firestore: SourceStatus; auth: SourceStatus; storage?: SourceStatus } }
export interface ProposedTable { name: string; sourcePath: string; columns: { name: string; type: string; nullable: boolean; sourceField?: string }[]; foreignKeys: { column: string; references: string; confidence: number; needsReview: boolean }[] }
export interface SchemaProposal { tables: ProposedTable[]; sql: string; warnings: string[] }
export interface MigrationOptions { dryRun: boolean; destructive: boolean; batchSize: number; includeSubcollections: boolean; includeAuth: boolean; includeStorage: boolean; includePasswordHashes: boolean; hash?: AuthHashConfig }
export interface MigrationReport { startedAt: string; completedAt?: string; discovered: number; migrated: number; failed: number; skipped: number; mismatches: number; errors: string[]; dryRun?: boolean; notes?: string[] }

export interface FirebaseDiscovery {
  inspect(): Promise<InspectionReport>
  inspectAuth(): Promise<AuthSummary>
  streamDocuments(collectionPath: string): AsyncIterable<Record<string, unknown>>
  streamAuthUsers(includePasswordHashes: boolean, hash?: AuthHashConfig): AsyncIterable<Record<string, unknown>>
  streamStorageObjects(): AsyncIterable<Record<string, unknown>>
}

export interface SchemaGenerator { generate(report: InspectionReport): Promise<SchemaProposal> }
export interface DatabaseAdapter { name: string; connect(): Promise<void>; applySchema(schema: SchemaProposal, options: MigrationOptions): Promise<void>; insert(table: string, rows: Record<string, unknown>[]): Promise<number>; verify(): Promise<{ mismatches: number; errors: string[] }>; close(): Promise<void>; countRows?(table: string): Promise<number | null>; drainWarnings?(): string[] }
export interface FireMigrateServices { discovery: FirebaseDiscovery; schema: SchemaGenerator; destination: DatabaseAdapter }

export const FIREMIGRATE_COMMANDS = ['init', 'inspect', 'schema', 'migrate', 'verify'] as const
export type FireMigrateCommand = (typeof FIREMIGRATE_COMMANDS)[number]
export const RESERVED_COLUMNS = new Set(['id', '_path', '_parent_id', '_parent_path', '_extra'])

export function toPostgresType(types: FirestoreFieldType[]): string { if (types.length !== 1) return 'jsonb'; return ({ string: 'text', number: 'double precision', boolean: 'boolean', timestamp: 'timestamptz', reference: 'text', array: 'jsonb', map: 'jsonb', null: 'text' } as Record<string, string>)[types[0]] ?? 'jsonb' }
export function toTableName(collectionName: string): string { return collectionName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase() }

export function createSchemaSql(tables: ProposedTable[]): string {
  return tables.map((table) => {
    const columns = table.columns.map((column) => `  "${column.name}" ${column.type}${column.nullable ? '' : ' NOT NULL'}`)
    const constraints = ['  PRIMARY KEY ("id")', ...table.foreignKeys.filter((key) => !key.needsReview).map((key) => `  FOREIGN KEY ("${key.column}") REFERENCES "${toTableName(key.references)}" ("id")`)]
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
    '  inspect   Read-only analysis of Firestore, subcollections, Auth and Storage metadata (--sample=<n>)',
    '  schema    Generate a reviewable PostgreSQL schema from the inspection',
    '  migrate   Write the streamed rows (--dry-run by default)',
    '  verify    Check PostgreSQL connectivity and compare row counts with Firebase',
    '',
    'migrate options: --dry-run, --write, --destructive, --skip-auth, --skip-storage, --skip-subcollections',
    '',
  ].join('\n')
}

export function requireConfiguration(command: string, config: FireMigrateConfig, configPath: string | null, needsDatabase: boolean): void { assertConfigured(command, config, configPath, needsDatabase) }

export interface PgQueryResult { rows: Record<string, unknown>[] }
export interface PgQueryable { query(text: string, values?: unknown[]): Promise<PgQueryResult> }
export interface PgClient extends PgQueryable { release(): void }
export interface PgPool extends PgQueryable { connect(): Promise<PgClient>; end(): Promise<void> }

const MAX_BIND_PARAMETERS = 60000
const MAX_ADAPTER_MESSAGES = 20

export class PostgresAdapter implements DatabaseAdapter {
  name = 'postgresql'
  private pool: PgPool | undefined
  private tables = new Map<string, ProposedTable>()
  private messages: string[] = []
  private suppressed = 0
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
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(schema.sql)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally { client.release() }
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
      const extra: Record<string, unknown> = {}
      for (const key of Object.keys(row)) if (!known.has(key)) extra[key] = row[key]
      if (Object.keys(extra).length) row._extra = extra
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
  drainWarnings(): string[] { const out = [...this.messages]; if (this.suppressed) out.push(`${this.suppressed} more message(s) suppressed`); this.messages = []; this.suppressed = 0; return out }
  async close(): Promise<void> { await this.pool?.end(); this.pool = undefined }
  private note(message: string): void { if (this.messages.length < MAX_ADAPTER_MESSAGES) this.messages.push(scrubHash(message)); else this.suppressed += 1 }
}

function errorMessage(error: unknown): string { return scrubHash(error instanceof Error ? error.message : String(error)) }
function scrubHash(message: string): string { return message.replace(/\$fbscrypt\$\S+/g, '[redacted password hash]') }
function quoteIdentifier(value: string): string { return `"${value.replace(/"/g, '""')}"` }
function unionColumns(rows: Record<string, unknown>[]): { name: string; type: string }[] {
  const names = new Set<string>()
  for (const row of rows) for (const key of Object.keys(row)) names.add(key)
  return [...names].map((name) => ({ name, type: 'unknown' }))
}
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

export async function compareRowCounts(destination: DatabaseAdapter, collections: CollectionSummary[]): Promise<{ compared: number; mismatches: number; errors: string[] }> {
  if (!destination.countRows) return { compared: 0, mismatches: 0, errors: ['This destination cannot count rows, so no counts were compared.'] }
  let compared = 0
  let mismatches = 0
  const errors: string[] = []
  for (const collection of collections) {
    if (collection.countIsEstimate) continue
    const table = toTableName(collection.name)
    const rows = await destination.countRows(table)
    if (rows === null) { mismatches += 1; errors.push(`Table "${table}" does not exist in PostgreSQL (${collection.kind ?? 'collection'} "${collection.name}" has ${collection.documentCount} documents)`); continue }
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
  async *streamAuthUsers(): AsyncIterable<Record<string, unknown>> { throw this.failure(); yield {} }
  async *streamStorageObjects(): AsyncIterable<Record<string, unknown>> { throw this.failure(); yield {} }
}

function kindRank(kind?: string): number { return kind === 'subcollection' ? 1 : kind === 'auth' ? 2 : kind === 'storage' ? 3 : 0 }

export class BasicSchemaGenerator implements SchemaGenerator {
  async generate(report: InspectionReport): Promise<SchemaProposal> {
    const warnings = [...report.warnings]
    const ordered = [...report.collections].sort((a, b) => kindRank(a.kind) - kindRank(b.kind))
    const tables = ordered.map((collection) => {
      const reserved = collection.fields.filter((field) => RESERVED_COLUMNS.has(field.name))
      if (reserved.length) warnings.push(`${collection.name} has document fields named ${reserved.map((field) => `"${field.name}"`).join(', ')}; they collide with reserved columns and are not migrated`)
      const fields = collection.fields.filter((field) => !RESERVED_COLUMNS.has(field.name))
      const columns = [{ name: 'id', type: 'text', nullable: false, sourceField: '__name__' }, { name: '_path', type: 'text', nullable: true, sourceField: '__path__' }]
      if (collection.kind === 'subcollection') columns.push({ name: '_parent_id', type: 'text', nullable: true, sourceField: '__parent__' }, { name: '_parent_path', type: 'text', nullable: true, sourceField: '__parent_path__' })
      columns.push(...fields.map((field) => ({ name: field.name, type: toPostgresType(field.types), nullable: field.presenceRate < 1, sourceField: field.name })))
      columns.push({ name: '_extra', type: 'jsonb', nullable: true, sourceField: '__extra__' })
      const foreignKeys = fields.filter((field) => field.relationship).map((field) => ({ column: field.name, references: field.relationship!.targetCollection, confidence: field.relationship!.confidence, needsReview: field.relationship!.confidence < 0.85 }))
      if (collection.kind === 'subcollection' && collection.parentCollection) foreignKeys.push({ column: '_parent_id', references: collection.parentCollection, confidence: 1, needsReview: true })
      return { name: toTableName(collection.name), sourcePath: collection.path, columns, foreignKeys }
    })
    return { tables, sql: createSchemaSql(tables), warnings }
  }
}

export interface ServiceExtras { onProgress?: (message: string) => void; inspect?: Partial<InspectOptions> }

export function createServices(databaseUrl?: string, config: FireMigrateConfig = loadConfig().config, extras: ServiceExtras = {}): FireMigrateServices {
  const missing = missingFirebaseCredentials(config)
  const discovery = missing.length
    ? new UnconfiguredFirebaseDiscovery(missing)
    : new SourceBackedDiscovery(() => openFirebaseAdmin(config), { ...DEFAULT_INSPECT_OPTIONS, ...extras.inspect, includeSubcollections: config.subcollections, includeAuth: config.auth.migrate, includeStorage: config.storage.migrateMetadata }, (message) => scrubSecrets(message, config), extras.onProgress)
  return { discovery, schema: new BasicSchemaGenerator(), destination: new PostgresAdapter(databaseUrl ?? config.postgres.databaseUrl) }
}

function assertFirestoreReadable(report: InspectionReport): void {
  if (report.sources && !report.sources.firestore.ok) throw new Error(`Firestore could not be read: ${report.sources.firestore.error ?? 'unknown error'}`)
}

export function resolveMigrateOptions(args: string[], config: FireMigrateConfig): MigrationOptions {
  const allowed = ['--dry-run', '--write', '--destructive', '--skip-auth', '--skip-storage', '--skip-subcollections']
  const unknown = args.filter((arg) => !allowed.includes(arg))
  if (unknown.length) throw new ConfigError(`Unknown option for migrate: ${unknown.join(' ')}. Supported: ${allowed.join(', ')}`)
  const wantsWrite = args.includes('--write')
  if (wantsWrite && args.includes('--dry-run')) throw new ConfigError('Choose either --dry-run or --write, not both.')
  if (args.includes('--destructive') && !wantsWrite) throw new ConfigError('--destructive only applies to writes. Pass --write --destructive, or drop --destructive for a dry run.')
  if (wantsWrite && config.dryRun) throw new ConfigError('--write refused: firemigrate.config.json has "dryRun": true. Set it to false to allow writes.')
  if (args.includes('--destructive') && !config.destructive) throw new ConfigError('--destructive refused: firemigrate.config.json has "destructive": false. Set it to true to allow destructive writes.')
  const hash = config.auth.hash.signerKey && config.auth.hash.saltSeparator ? config.auth.hash : undefined
  return { dryRun: !wantsWrite, destructive: wantsWrite && args.includes('--destructive'), batchSize: config.batchSize, includeSubcollections: config.subcollections && !args.includes('--skip-subcollections'), includeAuth: config.auth.migrate && !args.includes('--skip-auth'), includeStorage: config.storage.migrateMetadata && !args.includes('--skip-storage'), includePasswordHashes: config.auth.includePasswordHashes, hash }
}

export async function runMigration(services: FireMigrateServices, options: MigrationOptions): Promise<MigrationReport> {
  if (options.destructive && !options.dryRun) throw new Error('Destructive migration requires explicit confirmation.')
  const report = createEmptyMigrationReport()
  report.dryRun = options.dryRun
  await services.destination.connect()
  try {
    const inspection = await services.discovery.inspect()
    assertFirestoreReadable(inspection)
    const selected = inspection.collections.filter((collection) => {
      if (collection.kind === 'subcollection') return options.includeSubcollections
      if (collection.kind === 'auth') return options.includeAuth
      if (collection.kind === 'storage') return options.includeStorage
      return true
    })
    const schema = await services.schema.generate({ ...inspection, collections: selected })
    await services.destination.applySchema(schema, options)
    const streamed: CollectionSummary[] = []
    for (const collection of selected) {
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
      const source = collection.kind === 'auth'
        ? services.discovery.streamAuthUsers(options.includePasswordHashes, options.hash)
        : collection.kind === 'storage'
          ? services.discovery.streamStorageObjects()
          : services.discovery.streamDocuments(collection.path)
      for await (const document of source) {
        report.discovered += 1
        streamedCount += 1
        rows.push(document)
        if (rows.length >= options.batchSize) await flush()
      }
      await flush()
      streamed.push({ ...collection, documentCount: streamedCount, countIsEstimate: false })
    }
    if (options.dryRun) report.notes = ['Dry run: no data was written.', 'A write upserts every streamed document, Auth user, and Storage object. Fields outside the sample are kept in _extra.']
    else {
      const comparison = await compareRowCounts(services.destination, streamed)
      report.mismatches = comparison.mismatches
      report.errors.push(...comparison.errors)
      report.notes = ['Every streamed document, Auth user, and Storage object was upserted. Fields outside the sampled schema were kept in _extra. File bytes were not copied. Password hashes are stored and are never printed.']
      if (options.includeAuth && options.includePasswordHashes && !options.hash) report.notes.push('supabase_password_hash was left null because FIREBASE_HASH_SIGNER_KEY and FIREBASE_HASH_SALT_SEPARATOR were not set. Raw password_hash and password_salt were still stored.')
    }
    report.errors.push(...(services.destination.drainWarnings?.() ?? []))
    report.completedAt = new Date().toISOString()
    return report
  } finally { await services.destination.close() }
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

export const VERSION = '0.2.0'
export { AUTH_TABLE, STORAGE_TABLE }
export default { createServices, runMigration, runCli }
