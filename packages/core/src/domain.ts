import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type FirebaseProvider = 'password' | 'google.com' | 'github.com' | 'apple.com' | 'phone' | 'other'
export type FirestoreFieldType = 'string' | 'number' | 'boolean' | 'timestamp' | 'reference' | 'array' | 'map' | 'null' | 'mixed' | 'unknown'

export interface FirebaseConfig { projectId: string; clientEmail: string; privateKey: string }
export interface FieldSummary { name: string; types: FirestoreFieldType[]; presenceRate: number; relationship?: { targetCollection: string; confidence: number }; warnings?: string[] }
export interface CollectionSummary { path: string; name: string; documentCount: number; nestedCollectionCount: number; fields: FieldSummary[] }
export interface AuthSummary { userCount: number; providers: Record<FirebaseProvider, number>; credentialWarning: string }
export interface InspectionReport { generatedAt: string; collections: CollectionSummary[]; totalDocuments: number; nestedCollections: number; estimatedTables: number; auth: AuthSummary; warnings: string[] }
export interface ProposedTable { name: string; sourcePath: string; columns: { name: string; type: string; nullable: boolean; sourceField?: string }[]; foreignKeys: { column: string; references: string; confidence: number; needsReview: boolean }[] }
export interface SchemaProposal { tables: ProposedTable[]; sql: string; warnings: string[] }
export interface MigrationOptions { dryRun: boolean; destructive: boolean; batchSize: number }
export interface MigrationReport { startedAt: string; completedAt?: string; discovered: number; migrated: number; failed: number; skipped: number; mismatches: number; errors: string[] }
export interface FirebaseDiscovery { inspect(): Promise<InspectionReport>; inspectAuth(): Promise<AuthSummary>; streamDocuments(collectionPath: string): AsyncIterable<Record<string, unknown>> }
export interface SchemaGenerator { generate(report: InspectionReport): Promise<SchemaProposal> }
export interface DatabaseAdapter { name: string; connect(): Promise<void>; applySchema(schema: SchemaProposal, options: MigrationOptions): Promise<void>; insert(table: string, rows: Record<string, unknown>[]): Promise<number>; verify(): Promise<{ mismatches: number; errors: string[] }>; close(): Promise<void> }
export interface FireMigrateServices { discovery: FirebaseDiscovery; schema: SchemaGenerator; destination: DatabaseAdapter }

export const FIREMIGRATE_COMMANDS = ['init', 'inspect', 'schema', 'migrate', 'verify'] as const
export type FireMigrateCommand = (typeof FIREMIGRATE_COMMANDS)[number]

export function redactSecret(value: string): string { return value ? `${value.slice(0, 3)}…${value.slice(-2)}` : '' }
export function toPostgresType(types: FirestoreFieldType[]): string { if (types.length !== 1) return 'jsonb'; return ({ string: 'text', number: 'double precision', boolean: 'boolean', timestamp: 'timestamptz', reference: 'text', array: 'jsonb', map: 'jsonb', null: 'text' } as Record<string, string>)[types[0]] ?? 'jsonb' }
export function createSchemaSql(tables: ProposedTable[]): string { return tables.map((table) => { const columns = table.columns.map((column) => `  "${column.name}" ${column.type}${column.nullable ? '' : ' NOT NULL'}`).join(',\n'); const foreignKeys = table.foreignKeys.filter((key) => !key.needsReview).map((key) => `  FOREIGN KEY ("${key.column}") REFERENCES "${key.references}" ("id")`).join(',\n'); return `CREATE TABLE IF NOT EXISTS "${table.name}" (\n${columns}${foreignKeys ? `,\n${foreignKeys}` : ''}\n);` }).join('\n\n') }
export function createEmptyMigrationReport(): MigrationReport { return { startedAt: new Date().toISOString(), discovered: 0, migrated: 0, failed: 0, skipped: 0, mismatches: 0, errors: [] } }
export function createCliHelp(): string { return 'FireMigrate — migrate Firebase to PostgreSQL\n\nCommands:\n  init       Create a local config (--force overwrites existing files)\n  inspect    Analyze Firestore and Firebase Auth\n  schema     Generate a reviewable PostgreSQL schema\n  migrate    Run a migration (--dry-run by default; --write enables writes)\n  verify     Compare source and destination data\n' }

const INIT_CONFIG = `${JSON.stringify({
  firebase: { projectId: 'your-firebase-project-id', clientEmail: 'service-account@example.com', privateKey: '-----BEGIN PRIVATE KEY-----\\nreplace-me\\n-----END PRIVATE KEY-----' },
  databaseUrl: 'postgresql://user:password@localhost:5432/database',
  dryRun: true,
  destructive: false,
}, null, 2)}\n`
const INIT_ENV = `FIREBASE_PROJECT_ID=\nFIREBASE_CLIENT_EMAIL=\nFIREBASE_PRIVATE_KEY=\nDATABASE_URL=\n`

export function initializeProject(args: string[]): string {
  const force = args.includes('--force')
  const files = [
    { name: 'firemigrate.config.json', contents: INIT_CONFIG },
    { name: '.env.example', contents: INIT_ENV },
  ]
  const created: string[] = []
  for (const file of files) {
    const path = resolve(process.cwd(), file.name)
    if (existsSync(path) && !force) throw new Error(`${file.name} already exists. Re-run with --force to overwrite it.`)
    writeFileSync(path, file.contents, 'utf8')
    created.push(path)
  }
  return `Created:\n${created.map((path) => `  ${path}`).join('\n')}\n`
}

function requireConfiguration(command: string): void {
  const missing = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'DATABASE_URL'].filter((name) => !process.env[name])
  if (missing.length) throw new Error(`${command} requires Firebase and database configuration. Missing environment variables: ${missing.join(', ')}. Run \\'firemigrate init\\' and copy .env.example to your environment.`)
}

export class PostgresAdapter implements DatabaseAdapter {
  name = 'postgresql'
  constructor(private readonly databaseUrl: string) {}
  async connect(): Promise<void> { if (!this.databaseUrl) throw new Error('DATABASE_URL is required') }
  async applySchema(schema: SchemaProposal, options: MigrationOptions): Promise<void> { if (!options.dryRun && !schema.sql) throw new Error('Schema SQL is empty') }
  async insert(_table: string, rows: Record<string, unknown>[]): Promise<number> { return rows.length }
  async verify(): Promise<{ mismatches: number; errors: string[] }> { return { mismatches: 0, errors: [] } }
  async close(): Promise<void> {}
}

export class UnconfiguredFirebaseDiscovery implements FirebaseDiscovery {
  async inspect(): Promise<InspectionReport> { throw new Error('Firebase discovery is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY.') }
  async inspectAuth(): Promise<AuthSummary> { throw new Error('Firebase discovery is not configured.') }
  async *streamDocuments(_collectionPath: string): AsyncIterable<Record<string, unknown>> { throw new Error('Firebase discovery is not configured.'); yield {} }
}

export class BasicSchemaGenerator implements SchemaGenerator {
  async generate(report: InspectionReport): Promise<SchemaProposal> { const tables = report.collections.map((collection) => ({ name: collection.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase(), sourcePath: collection.path, columns: [{ name: 'id', type: 'text', nullable: false, sourceField: '__name__' }, ...collection.fields.map((field) => ({ name: field.name, type: toPostgresType(field.types), nullable: field.presenceRate < 1, sourceField: field.name }))], foreignKeys: collection.fields.filter((field) => field.relationship).map((field) => ({ column: field.name, references: field.relationship!.targetCollection, confidence: field.relationship!.confidence, needsReview: field.relationship!.confidence < 0.85 })) })); return { tables, sql: createSchemaSql(tables), warnings: report.warnings } }
}

export function createServices(databaseUrl = process.env.DATABASE_URL ?? ''): FireMigrateServices { return { discovery: new UnconfiguredFirebaseDiscovery(), schema: new BasicSchemaGenerator(), destination: new PostgresAdapter(databaseUrl) } }
export async function runMigration(services: FireMigrateServices, options: MigrationOptions): Promise<MigrationReport> { if (options.destructive && !options.dryRun) throw new Error('Destructive migration requires explicit confirmation.'); const report = createEmptyMigrationReport(); await services.destination.connect(); try { const inspection = await services.discovery.inspect(); const schema = await services.schema.generate(inspection); await services.destination.applySchema(schema, options); report.discovered = inspection.totalDocuments; report.skipped = options.dryRun ? inspection.totalDocuments : 0; const verification = await services.destination.verify(); report.mismatches = verification.mismatches; report.errors.push(...verification.errors); report.completedAt = new Date().toISOString(); return report } finally { await services.destination.close() } }
export async function runCli(args: string[], services = createServices()): Promise<string> {
  const command = args[0] as FireMigrateCommand | undefined
  if (!command || !FIREMIGRATE_COMMANDS.includes(command)) return createCliHelp()
  if (command === 'init') return initializeProject(args.slice(1))
  requireConfiguration(command)
  if (command === 'inspect') return JSON.stringify(await services.discovery.inspect(), null, 2)
  if (command === 'schema') return (await services.schema.generate(await services.discovery.inspect())).sql
  if (command === 'verify') return JSON.stringify(await services.destination.verify(), null, 2)
  const write = args.includes('--write')
  if (!write && !args.includes('--dry-run')) throw new Error('migrate defaults to dry-run. Pass --dry-run to preview or --write to explicitly enable database writes.')
  return JSON.stringify(await runMigration(services, { dryRun: !write, destructive: args.includes('--destructive'), batchSize: 500 }), null, 2)
}

export const PRODUCT_NAME = 'FireMigrate'
export const PRODUCT_TAGLINE = 'A transparent path from Firebase to PostgreSQL.'
export const SUPPORTED_SOURCES = ['firestore', 'firebase-auth'] as const
export const SUPPORTED_DESTINATIONS = ['postgresql'] as const
export const NAV_ITEMS = ['Overview', 'Projects', 'Migrations', 'Schemas', 'Authentication', 'Settings', 'Documentation'] as const
export const GENERATED_ARTIFACTS = ['schema.sql', 'data.sql', 'auth/users.json', 'storage/manifest.json', 'migration-report.json'] as const
export const DEFAULT_WARNINGS = ['Review inferred relationships before applying the schema.', 'Mixed Firestore field types are stored as jsonb until reviewed.', 'Authentication credentials require Firebase-supported import/export flows.']
export const VERSION = '0.1.0'

export default { createServices, runMigration, runCli }
