import type { AuthSummary, CollectionSummary, FieldSummary, FirebaseDiscovery, FirebaseProvider, FirestoreFieldType, InspectionReport } from './domain'

export interface SampledDocument { id: string; data: Record<string, unknown> }

export interface FirestoreSource {
  listCollectionIds(): Promise<string[]>
  countDocuments(collectionId: string): Promise<number>
  sampleDocuments(collectionId: string, limit: number): Promise<SampledDocument[]>
  streamDocuments(collectionId: string): AsyncIterable<SampledDocument>
  listSubcollectionIds(collectionId: string, documentId: string): Promise<string[]>
}

export interface AuthScan { userCount: number; providerCounts: Record<string, number>; usersWithoutProvider: number; complete: boolean }
export interface AuthSource { scanUsers(maxUsers: number): Promise<AuthScan> }

export interface OpenedSources { firestore: FirestoreSource; auth: AuthSource; close(): Promise<void> }

export interface InspectOptions { sampleSize: number; maxAuthUsers: number; subcollectionProbe: number; concurrency: number }
export const DEFAULT_INSPECT_OPTIONS: InspectOptions = { sampleSize: 100, maxAuthUsers: 100000, subcollectionProbe: 10, concurrency: 4 }

export const AUTH_CREDENTIAL_NOTE = 'Firebase stores password sign-in credentials as hashes, never plaintext. inspect does not read or print them.'

export interface ClassifiedValue { type: FirestoreFieldType; referenceTarget?: string }

/** Duck-typed so core never imports firebase-admin: Timestamp, DocumentReference and GeoPoint are recognised by shape. */
export function classifyValue(value: unknown): ClassifiedValue {
  if (value === null || value === undefined) return { type: 'null' }
  switch (typeof value) {
    case 'string': return { type: 'string' }
    case 'number':
    case 'bigint': return { type: 'number' }
    case 'boolean': return { type: 'boolean' }
    case 'object': break
    default: return { type: 'unknown' }
  }
  if (Array.isArray(value)) return { type: 'array' }
  if (value instanceof Date) return { type: 'timestamp' }
  if (value instanceof Uint8Array) return { type: 'unknown' }
  const obj = value as Record<string, unknown>
  if (typeof obj.toDate === 'function' && ('seconds' in obj || '_seconds' in obj)) return { type: 'timestamp' }
  if (typeof obj.path === 'string' && typeof obj.id === 'string' && 'firestore' in obj) {
    const segments = obj.path.split('/')
    const target = segments.length >= 2 ? segments[segments.length - 2] : undefined
    return target ? { type: 'reference', referenceTarget: target } : { type: 'reference' }
  }
  return { type: 'map' }
}

const normalizeName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '')


export function guessRelationshipTarget(fieldName: string, collectionIds: string[]): string | undefined {
  const isUid = fieldName.toLowerCase() === 'uid'
  const stripped = fieldName.replace(/(?:_id|Id|ID|_ref|Ref|_uid|Uid|UID)$/, '')
  const base = isUid ? 'user' : stripped
  if (!base || (!isUid && base === fieldName)) return undefined
  const key = normalizeName(base)
  if (!key) return undefined
  return collectionIds.find((id) => {
    const candidate = normalizeName(id)
    return candidate === key || candidate === `${key}s` || candidate === `${key}es` || (key.endsWith('y') && candidate === `${key.slice(0, -1)}ies`)
  })
}

interface FieldAccumulator { types: Map<FirestoreFieldType, number>; present: number; targets: Map<string, number> }

export function analyzeFields(collectionId: string, docs: SampledDocument[], collectionIds: string[]): FieldSummary[] {
  const accumulators = new Map<string, FieldAccumulator>()
  for (const doc of docs) {
    for (const [name, value] of Object.entries(doc.data)) {
      let acc = accumulators.get(name)
      if (!acc) {
        acc = { types: new Map(), present: 0, targets: new Map() }
        accumulators.set(name, acc)
      }
      const classified = classifyValue(value)
      if (classified.type === 'null') continue
      acc.present += 1
      acc.types.set(classified.type, (acc.types.get(classified.type) ?? 0) + 1)
      if (classified.referenceTarget) acc.targets.set(classified.referenceTarget, (acc.targets.get(classified.referenceTarget) ?? 0) + 1)
    }
  }

  return [...accumulators.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, acc]) => {
      const observed = [...acc.types.keys()].sort()
      const summary: FieldSummary = { name, types: observed.length ? observed : ['null'], presenceRate: docs.length ? acc.present / docs.length : 0 }
      const warnings: string[] = []

      if (observed.length > 1) {
        const breakdown = [...acc.types.entries()].sort((x, y) => y[1] - x[1]).map(([type, count]) => `${type}: ${count}`).join(', ')
        warnings.push(`${collectionId}.${name} has mixed types (${breakdown}); it maps to jsonb until reviewed`)
      }

      if (acc.targets.size > 0) {
        const ranked = [...acc.targets.entries()].sort((x, y) => y[1] - x[1])
        const target = ranked[0]![0]
        if (ranked.length > 1) {
          summary.relationship = { targetCollection: target, confidence: 0.5 }
          warnings.push(`${collectionId}.${name} references several collections (${ranked.map(([id]) => id).join(', ')}); pick the target manually`)
        } else if (collectionIds.includes(target)) {
          summary.relationship = { targetCollection: target, confidence: 1 }
        } else {
          summary.relationship = { targetCollection: target, confidence: 0.6 }
          warnings.push(`${collectionId}.${name} points at "${target}", which is not a top-level collection found in this scan`)
        }
      } else if (observed.includes('string')) {
        const guess = guessRelationshipTarget(name, collectionIds)
        if (guess) {
          summary.relationship = { targetCollection: guess, confidence: 0.5 }
          warnings.push(`${collectionId}.${name} may reference "${guess}" (matched by field name only; it is not a Firestore reference)`)
        }
      }

      if (warnings.length) summary.warnings = warnings
      return summary
    })
}

const KNOWN_PROVIDERS: FirebaseProvider[] = ['password', 'google.com', 'github.com', 'apple.com', 'phone']
export const toFirebaseProvider = (id: string): FirebaseProvider => (KNOWN_PROVIDERS as string[]).includes(id) ? (id as FirebaseProvider) : 'other'
const emptyProviders = (): Record<FirebaseProvider, number> => ({ password: 0, 'google.com': 0, 'github.com': 0, 'apple.com': 0, phone: 0, other: 0 })
const emptyAuth = (): AuthSummary => ({ userCount: 0, providers: emptyProviders(), credentialWarning: AUTH_CREDENTIAL_NOTE })

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index] as T)
    }
  })
  await Promise.all(workers)
  return results
}

const formatCount = (value: number): string => value.toLocaleString('en-US')


export class SourceBackedDiscovery implements FirebaseDiscovery {
  constructor(
    private readonly open: () => Promise<OpenedSources>,
    private readonly options: InspectOptions = DEFAULT_INSPECT_OPTIONS,
    private readonly redact: (message: string) => string = (message) => message,
    private readonly onProgress: (message: string) => void = () => undefined,
  ) {}

  private describe(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error)
    return this.redact(raw.replace(/\s+/g, ' ').trim()).slice(0, 400)
  }

  async inspect(): Promise<InspectionReport> {
    const generatedAt = new Date().toISOString()
    let opened: OpenedSources
    try {
      opened = await this.open()
    } catch (error) {
      const message = this.describe(error)
      return { generatedAt, collections: [], totalDocuments: 0, nestedCollections: 0, estimatedTables: 0, auth: emptyAuth(), warnings: [], sources: { firestore: { ok: false, error: message }, auth: { ok: false, error: message } } }
    }

    try {
      const warnings: string[] = []
      const sources: NonNullable<InspectionReport['sources']> = { firestore: { ok: true }, auth: { ok: true } }
      let collections: CollectionSummary[] = []
      let auth = emptyAuth()

      try {
        this.onProgress('Reading Firestore collections...')
        collections = await this.readFirestore(opened.firestore, warnings)
      } catch (error) {
        sources.firestore = { ok: false, error: this.describe(error) }
      }

      try {
        this.onProgress('Reading Firebase Auth users...')
        const result = await this.readAuth(opened.auth)
        auth = result.summary
        warnings.push(...result.warnings)
      } catch (error) {
        sources.auth = { ok: false, error: this.describe(error) }
      }

      return {
        generatedAt,
        collections,
        totalDocuments: collections.reduce((sum, collection) => sum + collection.documentCount, 0),
        nestedCollections: collections.reduce((sum, collection) => sum + collection.nestedCollectionCount, 0),
        estimatedTables: collections.length,
        auth,
        warnings,
        sampledDocuments: collections.reduce((sum, collection) => sum + (collection.sampledDocuments ?? 0), 0),
        sources,
      }
    } finally {
      await opened.close().catch(() => undefined)
    }
  }

  async inspectAuth(): Promise<AuthSummary> {
    const opened = await this.open()
    try {
      return (await this.readAuth(opened.auth)).summary
    } finally {
      await opened.close().catch(() => undefined)
    }
  }

  async *streamDocuments(collectionPath: string): AsyncIterable<Record<string, unknown>> {
    const opened = await this.open()
    try {
      for await (const document of opened.firestore.streamDocuments(collectionPath)) {
        yield { id: document.id, ...document.data }
      }
    } finally {
      await opened.close().catch(() => undefined)
    }
  }

  private async readFirestore(firestore: FirestoreSource, warnings: string[]): Promise<CollectionSummary[]> {
    const ids = (await firestore.listCollectionIds()).sort()
    const perCollection = await mapWithConcurrency(ids, this.options.concurrency, async (id) => this.readCollection(firestore, id, ids))
    for (const entry of perCollection) warnings.push(...entry.warnings)
    return perCollection.map((entry) => entry.summary)
  }

  private async readCollection(firestore: FirestoreSource, id: string, allIds: string[]): Promise<{ summary: CollectionSummary; warnings: string[] }> {
    const [count, docs] = await Promise.all([firestore.countDocuments(id), firestore.sampleDocuments(id, this.options.sampleSize)])
    const fields = analyzeFields(id, docs, allIds)
    const warnings = fields.flatMap((field) => field.warnings ?? [])

    const nested = new Set<string>()
    for (const doc of docs.slice(0, this.options.subcollectionProbe)) for (const subId of await firestore.listSubcollectionIds(id, doc.id)) nested.add(subId)
    if (nested.size) warnings.push(`${id} has subcollections (${[...nested].sort().join(', ')}) found by probing its first ${Math.min(docs.length, this.options.subcollectionProbe)} documents; subcollections are not analyzed yet`)
    if (count === 0) warnings.push(`${id} has no documents; there is nothing to infer from it`)
    else if (docs.length < count) warnings.push(`${id}: analyzed the first ${formatCount(docs.length)} of ${formatCount(count)} documents (ordered by document ID); field types and presence reflect that sample only`)

    return { summary: { path: id, name: id, documentCount: count, nestedCollectionCount: nested.size, fields, sampledDocuments: docs.length }, warnings }
  }

  private async readAuth(auth: AuthSource): Promise<{ summary: AuthSummary; warnings: string[] }> {
    const scan = await auth.scanUsers(this.options.maxAuthUsers)
    const providers = emptyProviders()
    const otherIds: string[] = []
    for (const [id, count] of Object.entries(scan.providerCounts)) {
      const provider = toFirebaseProvider(id)
      providers[provider] += count
      if (provider === 'other') otherIds.push(id)
    }
    const warnings: string[] = []
    if (!scan.complete) warnings.push(`Auth scan stopped after ${formatCount(scan.userCount)} users; user and provider counts are partial`)
    if (otherIds.length) warnings.push(`Other sign-in providers found: ${otherIds.sort().join(', ')}`)
    if (scan.usersWithoutProvider) warnings.push(`${formatCount(scan.usersWithoutProvider)} users have no linked provider (anonymous or custom-token sign-in)`)
    return { summary: { userCount: scan.userCount, providers, credentialWarning: AUTH_CREDENTIAL_NOTE }, warnings }
  }
}
