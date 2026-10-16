import { ConfigError, assertConfigured, loadConfig, missingFirebaseCredentials, scrubSecrets } from './config'
import type { AuthHashConfig, FireMigrateConfig } from './config'
import { openFirebaseAdmin } from './firebase-source'
import { formatInspection } from './format'
import { initializeProject } from './init'
import { AUTH_TABLE, DEFAULT_INSPECT_OPTIONS, STORAGE_TABLE, SourceBackedDiscovery } from './inspect'
import { inspectPostgresForReverse, formatReverseInspection } from './reverse'
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

export const FIREMIGRATE_COMMANDS = ['init', 'inspect', 'schema', 'migrate', 'verify', 'reverse'] as const
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
    '  reverse   Inspect PostgreSQL tables and propose Firestore collection mappings (read-only)',
    '',
    'migrate options: --dry-run, --write, --destructive, --skip-auth, --skip-storage, --skip-subcollections',
    'reverse options: (inspect by default; --table=<name> to limit)',
    '',
  ].join('\n')
}

export function requireConfiguration(command: string, config: FireMigrateConfig, configPath: string | null, needsDatabase: boolean): void { assertConfigured(command, config, configPath, needsDatabase) }

// ... rest of original file remains unchanged until runCli ...
