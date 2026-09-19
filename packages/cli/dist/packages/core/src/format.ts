import type { InspectionReport } from './domain'
import { PACKAGE_RUNNER } from './config'

export interface FormatOptions { projectId?: string }

const count = (value: number): string => value.toLocaleString('en-US')
const plural = (value: number, singular: string, pluralForm = `${singular}s`): string => `${count(value)} ${value === 1 ? singular : pluralForm}`
const MAX_FIELDS_PER_COLLECTION = 12
const MAX_WARNINGS = 50


export function formatInspection(report: InspectionReport, options: FormatOptions = {}): string {
  const firestore = report.sources?.firestore ?? { ok: true }
  const auth = report.sources?.auth ?? { ok: true }
  const lines: string[] = [options.projectId ? `FireMigrate inspect - project ${options.projectId}` : 'FireMigrate inspect', '']

  lines.push(firestore.ok || auth.ok ? '✓ Firebase credentials validated' : '✗ Firebase credentials could not be validated')
  if (firestore.ok) {
    lines.push('✓ Firestore discovered')
    lines.push(`✓ ${plural(report.collections.length, 'top-level collection')} found`)
    lines.push(`✓ ${plural(report.totalDocuments, 'document')} counted, ${count(report.sampledDocuments ?? 0)} sampled for field analysis`)
  } else {
    lines.push(`✗ Firestore could not be read: ${firestore.error ?? 'unknown error'}`)
  }
  lines.push(auth.ok ? `✓ Firebase Auth discovered: ${plural(report.auth.userCount, 'user')}` : `✗ Firebase Auth could not be read: ${auth.error ?? 'unknown error'}`)

  if (firestore.ok && report.collections.length) {
    lines.push('', 'Collections')
    for (const collection of report.collections) {
      const sampled = collection.sampledDocuments ?? 0
      lines.push(`  ${collection.name}  (${plural(collection.documentCount, 'doc')}${sampled < collection.documentCount ? `, ${count(sampled)} sampled` : ''})`)
      const shown = collection.fields.slice(0, MAX_FIELDS_PER_COLLECTION)
      const width = Math.min(32, Math.max(0, ...shown.map((field) => field.name.length)))
      for (const field of shown) {
        const notes: string[] = []
        if (field.types.length > 1) notes.push('⚠ mixed types')
        if (field.relationship) notes.push(field.relationship.confidence < 0.85 ? `⚠ may reference "${field.relationship.targetCollection}"` : `→ ${field.relationship.targetCollection}`)
        if (field.presenceRate < 1 && field.types[0] !== 'null') notes.push(`in ${Math.round(field.presenceRate * 100)}% of sampled docs`)
        lines.push(`      ${field.name.padEnd(width)}  ${field.types.join(' | ')}${notes.length ? `   ${notes.join('  ')}` : ''}`)
      }
      if (collection.fields.length > shown.length) lines.push(`      ... ${collection.fields.length - shown.length} more fields`)
    }
  }

  if (auth.ok) {
    const providers = Object.entries(report.auth.providers).filter(([, value]) => value > 0)
    lines.push('', 'Firebase Auth', `  users: ${count(report.auth.userCount)}`)
    if (providers.length) lines.push(`  providers: ${providers.map(([name, value]) => `${name} ${count(value)}`).join(' · ')}  (a user can have several)`)
    if (report.auth.userCount > 0 && report.auth.providers.password > 0) lines.push(`  ${report.auth.credentialWarning}`)
  }

  const mixed = report.collections.filter((collection) => collection.fields.some((field) => field.types.length > 1)).length
  const review = report.collections.reduce((sum, collection) => sum + collection.fields.filter((field) => field.relationship && field.relationship.confidence < 0.85).length, 0)
  if (mixed || review) lines.push('')
  if (mixed) lines.push(`⚠ ${plural(mixed, 'collection')} ${mixed === 1 ? 'contains' : 'contain'} inconsistent field types`)
  if (review) lines.push(`⚠ ${plural(review, 'relationship')} ${review === 1 ? 'requires' : 'require'} manual review`)

  if (report.warnings.length) {
    lines.push('', 'Details')
    for (const warning of report.warnings.slice(0, MAX_WARNINGS)) lines.push(`  - ${warning}`)
    if (report.warnings.length > MAX_WARNINGS) lines.push(`  ... ${report.warnings.length - MAX_WARNINGS} more`)
  }

  lines.push('')
  if (!firestore.ok) lines.push('Fix the errors above and run inspect again. No schema can be generated without Firestore access.')
  else if (report.collections.length === 0) lines.push('No collections were found, so there is nothing to migrate.')
  else lines.push(`Ready to generate a PostgreSQL schema: ${PACKAGE_RUNNER} schema`)
  return `${lines.join('\n')}\n`
}
