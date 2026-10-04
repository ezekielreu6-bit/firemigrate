import type { InspectionReport, ProposedTable, SchemaProposal } from './domain'

export interface AgentTable {
  table: string
  sourcePath: string
  kind: 'collection' | 'subcollection' | 'auth' | 'storage'
  parentTable: string | null
  primaryKey: 'id'
  columns: string[]
  read: string
  write: string
}

export interface AgentTableManifest {
  version: 1
  instruction: string
  tableCount: number
  tables: AgentTable[]
}

export function buildTableManifest(report: InspectionReport, schema: SchemaProposal): AgentTableManifest {
  const bySource = new Map(report.collections.map((collection) => [collection.path, collection]))
  const tables = schema.tables.map((table) => toAgentTable(table, bySource.get(table.sourcePath)?.kind ?? 'collection', bySource.get(table.sourcePath)?.parentCollection ?? null))
  return {
    version: 1,
    instruction: 'Use only these PostgreSQL table names. Do not invent tables. Upsert by id. Subcollection rows include _parent_id and _parent_path. Extra document fields are in _extra.',
    tableCount: tables.length,
    tables,
  }
}

function toAgentTable(table: ProposedTable, kind: AgentTable['kind'], parentTable: string | null): AgentTable {
  const columns = table.columns.map((column) => column.name)
  return {
    table: table.name,
    sourcePath: table.sourcePath,
    kind,
    parentTable,
    primaryKey: 'id',
    columns,
    read: `SELECT ${columns.map((column) => `"${column}"`).join(', ')} FROM "${table.name}"`,
    write: `INSERT INTO "${table.name}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (...) ON CONFLICT ("id") DO UPDATE`,
  }
}
