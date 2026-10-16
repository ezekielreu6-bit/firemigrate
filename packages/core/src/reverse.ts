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

const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema', 'pg_toast'])

export async function inspectPostgresForReverse(config: FireMigrateConfig, sampleSize = 5): Promise<ReverseInspection> {
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

      const suggestedCollection = hasPath
        ? table.replace(/__/g, '/')
        : table

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

    return {
      generatedAt: new Date().toISOString(),
      database,
      tables,
      warnings,
    }
  } finally {
    await pool.end()
  }
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
    'FireMigrate reverse — PostgreSQL → Firestore (inspect only)',
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

  lines.push('This is a read-only inspection. No data was written to Firebase.')
  lines.push('Next: reverse --preview (sample documents) or reverse --write (when ready).')
  return lines.join('\n')
}
