import { Pool } from 'pg'
import type { FireMigrateConfig } from './config'

export interface ReverseTableSummary {
  schema: string
  table: string
  rowCount: number
  columns: { name: string; type: string; nullable: boolean }[]
  suggestedCollection: string
  suggestedDocumentId: string
  hasPath: boolean
  hasParent: boolean
  hasExtra: boolean
  notes: string[]
}

export interface ReverseInspection {
  generatedAt: string
  database: string
  tables: ReverseTableSummary[]
  warnings: string[]
}

export interface ReverseOptions {
  table?: string
  preview: boolean
  write: boolean
  sampleSize?: number
  batchSize?: number
}

const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema', 'pg_toast'])

export async function inspectPostgresForReverse(config: FireMigrateConfig): Promise<ReverseInspection> {
  if (!config.postgres.databaseUrl) throw new Error('DATABASE_URL is required for reverse')

  const pool = new Pool({ connectionString: config.postgres.databaseUrl, max: 2, connectionTimeoutMillis: 10000 })
  const warnings: string[] = []

  try {
    const dbResult = await pool.query<{ datname: string }>('SELECT current_database() AS datname')
    const database = dbResult.rows[0]?.datname ?? 'unknown'

    const tablesResult = await pool.query<{ schema: string; table: string }>(`
      SELECT table_schema AS schema, table_name AS table
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name
    `)

    const tables: ReverseTableSummary[] = []

    for (const { schema, table } of tablesResult.rows) {
      if (SYSTEM_SCHEMAS.has(schema)) continue

      const columnsResult = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position
      `, [schema, table])

      const columns = columnsResult.rows.map((c) => ({
        name: c.column_name,
        type: c.data_type,
        nullable: c.is_nullable === 'YES',
      }))

      const countResult = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${quoteIdent(schema)}.${quoteIdent(table)}`)
      const rowCount = Number(countResult.rows[0]?.n ?? 0)

      const names = new Set(columns.map((c) => c.name))
      const hasPath = names.has('_path')
      const hasParent = names.has('_parent_id') || names.has('_parent_path')
      const hasExtra = names.has('_extra')

      let suggestedDocumentId = 'id'
      if (!names.has('id')) {
        const pk = await findPrimaryKey(pool, schema, table)
        suggestedDocumentId = pk ?? columns.find((c) => c.type.includes('char') || c.type === 'text' || c.type === 'uuid')?.name ?? columns[0]?.name ?? 'id'
        if (!names.has(suggestedDocumentId)) warnings.push(`${schema}.${table}: no obvious document id column`)
      }

      const suggestedCollection = hasPath ? table.replace(/__/g, '/') : table

      const notes: string[] = []
      if (hasPath) notes.push('has _path (FireMigrate-style nesting)')
      if (hasParent) notes.push('has parent columns')
      if (hasExtra) notes.push('has _extra jsonb')
      if (rowCount === 0) notes.push('empty')
      if (suggestedDocumentId !== 'id') notes.push(`will use "${suggestedDocumentId}" as document id`)

      tables.push({
        schema,
        table,
        rowCount,
        columns,
        suggestedCollection,
        suggestedDocumentId,
        hasPath,
        hasParent,
        hasExtra,
        notes,
      })
    }

    return { generatedAt: new Date().toISOString(), database, tables, warnings }
  } finally {
    await pool.end()
  }
}

export async function previewReverse(config: FireMigrateConfig, tables: ReverseTableSummary[], sampleSize = 3): Promise<string> {
  const pool = new Pool({ connectionString: config.postgres.databaseUrl, max: 1 })
  const lines: string[] = ['', '--- Preview (sample documents) ---', '']

  try {
    for (const t of tables.slice(0, 5)) {
      lines.push(`${t.schema}.${t.table} → ${t.suggestedCollection}`)
      const result = await pool.query(`SELECT * FROM ${quoteIdent(t.schema)}.${quoteIdent(t.table)} LIMIT $1`, [sampleSize])
      for (const row of result.rows) {
        const doc = rowToDocument(row, t)
        lines.push(`  id: ${doc.id}`)
        lines.push(`  data: ${JSON.stringify(doc.data, null, 2).split('\n').join('\n  ')}`)
        lines.push('')
      }
    }
  } finally {
    await pool.end()
  }
  return lines.join('\n')
}

export async function writeReverse(config: FireMigrateConfig, tables: ReverseTableSummary[], options: ReverseOptions): Promise<string> {
  if (!options.write) return 'Pass --write to actually write documents.'
  if (config.dryRun) throw new Error('--write refused: firemigrate.config.json has "dryRun": true. Set it to false to allow writes.')

  const missing = []
  if (!config.firebase.projectId) missing.push('FIREBASE_PROJECT_ID')
  if (!config.firebase.clientEmail) missing.push('FIREBASE_CLIENT_EMAIL')
  if (!config.firebase.privateKey) missing.push('FIREBASE_PRIVATE_KEY')
  if (missing.length) throw new Error(`Firebase credentials required for reverse --write (missing: ${missing.join(', ')})`)

  const appModule = await import('firebase-admin/app')
  const firestoreModule = await import('firebase-admin/firestore')
  const app = appModule.initializeApp(
    { credential: appModule.cert({ projectId: config.firebase.projectId, clientEmail: config.firebase.clientEmail, privateKey: config.firebase.privateKey }), projectId: config.firebase.projectId },
    `firemigrate-reverse-${Date.now()}`,
  )
  const db = firestoreModule.getFirestore(app)

  const pool = new Pool({ connectionString: config.postgres.databaseUrl, max: 2 })
  const batchSize = options.batchSize ?? config.batchSize ?? 100
  let written = 0
  const errors: string[] = []

  try {
    for (const t of tables) {
      const result = await pool.query(`SELECT * FROM ${quoteIdent(t.schema)}.${quoteIdent(t.table)}`)
      let batch = db.batch()
      let inBatch = 0

      for (const row of result.rows) {
        const doc = rowToDocument(row, t)
        if (!doc.id) { errors.push(`${t.table}: row without id skipped`); continue }
        const ref = doc.path ? db.doc(doc.path) : db.collection(t.suggestedCollection).doc(String(doc.id))
        batch.set(ref, doc.data, { merge: true })
        inBatch += 1
        written += 1

        if (inBatch >= batchSize) {
          await batch.commit()
          batch = db.batch()
          inBatch = 0
        }
      }
      if (inBatch > 0) await batch.commit()
    }
  } finally {
    await pool.end()
    await appModule.deleteApp(app).catch(() => undefined)
  }

  return [
    `Wrote ${written} documents to Firestore.`,
    errors.length ? `Errors: ${errors.slice(0, 10).join('; ')}` : '',
  ].filter(Boolean).join('\n')
}

function rowToDocument(row: Record<string, unknown>, table: ReverseTableSummary): { id: string; path?: string; data: Record<string, unknown> } {
  const id = String(row[table.suggestedDocumentId] ?? '')
  const data: Record<string, unknown> = {}
  const extra = table.hasExtra && row._extra && typeof row._extra === 'object' ? (row._extra as Record<string, unknown>) : {}

  for (const [key, value] of Object.entries(row)) {
    if (key === table.suggestedDocumentId || key === 'id' || key === '_path' || key === '_parent_id' || key === '_parent_path' || key === '_extra') continue
    data[key] = normalizeValue(value)
  }
  Object.assign(data, extra)

  const path = table.hasPath && typeof row._path === 'string' ? row._path : undefined
  return { id, path, data }
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) return value
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) out[k] = normalizeValue(v)
    return out
  }
  if (Array.isArray(value)) return value.map(normalizeValue)
  return value
}

async function findPrimaryKey(pool: Pool, schema: string, table: string): Promise<string | null> {
  const result = await pool.query<{ column_name: string }>(`
    SELECT a.attname AS column_name
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = ($1 || '.' || $2)::regclass
      AND i.indisprimary
    LIMIT 1
  `, [schema, table])
  return result.rows[0]?.column_name ?? null
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

export function formatReverseInspection(report: ReverseInspection): string {
  const lines: string[] = [
    'FireMigrate reverse — PostgreSQL → Firestore',
    `Database: ${report.database}`,
    `Tables found: ${report.tables.length}`,
    '',
  ]

  if (report.tables.length === 0) {
    lines.push('No user tables found.')
    return lines.join('\n')
  }

  for (const t of report.tables) {
    lines.push(`${t.schema}.${t.table}`)
    lines.push(`  rows: ${t.rowCount}`)
    lines.push(`  → collection: ${t.suggestedCollection}`)
    lines.push(`  → document id: ${t.suggestedDocumentId}`)
    if (t.notes.length) lines.push(`  notes: ${t.notes.join(', ')}`)
    lines.push(`  columns: ${t.columns.map((c) => c.name).join(', ')}`)
    lines.push('')
  }

  if (report.warnings.length) {
    lines.push('Warnings:')
    for (const w of report.warnings) lines.push(`  - ${w}`)
  }

  lines.push('Read-only by default. Use --preview to sample documents, or --write to push to Firestore.')
  return lines.join('\n')
}
