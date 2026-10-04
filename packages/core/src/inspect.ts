import type { AuthSummary, CollectionSummary, FieldSummary, FirebaseDiscovery, FirebaseProvider, FirestoreFieldType, InspectionReport } from './domain'

export interface SampledDocument {
  id: string
  data: Record<string, unknown>
  path?: string
  parentId?: string
  parentPath?: string
  parentCollection?: string
}

export interface FirestoreSource {
  listCollectionIds(): Promise<string[]>
  countDocuments(collectionId: string): Promise<number>
  sampleDocuments(collectionId: string, limit: number): Promise<SampledDocument[]>
  streamDocuments(collectionId: string): AsyncIterable<SampledDocument>
  listSubcollectionIds(collectionId: string, documentId: string): Promise<string[]>
  listSubcollectionIdsAt(documentPath: string): Promise<string[]>
  countCollectionGroup(collectionId: string): Promise<number>
  sampleCollectionGroup(collectionId: string, limit: number): Promise<SampledDocument[]>
  streamCollectionGroup(collectionId: string): AsyncIterable<SampledDocument>
}

export interface AuthScan { userCount: number; providerCounts: Record<string, number>; usersWithoutProvider: number; usersWithPasswordHash: number; complete: boolean }
export interface AuthUserRecord { uid: string; email: string | null; emailVerified: boolean; displayName: string | null; photoURL: string | null; phoneNumber: string | null; disabled: boolean; createdAt: string | null; lastSignInAt: string | null; providers: string[]; providerData: Record<string, unknown>[]; customClaims: Record<string, unknown> | null; passwordHash: string | null; passwordSalt: string | null }
export interface AuthSource { scanUsers(maxUsers: number): Promise<AuthScan>; streamUsers(): AsyncIterable<AuthUserRecord> }
export interface StorageObjectRecord { name: string; bucket: string; size: number | null; contentType: string | null; updated: string | null; md5Hash: string | null }
export interface StorageSource { listObjects(limit: number): Promise<StorageObjectRecord[]>; streamObjects(): AsyncIterable<StorageObjectRecord> }
export interface OpenedSources { firestore: FirestoreSource; auth: AuthSource; storage: StorageSource; close(): Promise<void> }
export interface InspectOptions { sampleSize: number; maxAuthUsers: number; subcollectionProbe: number; maxSubcollectionDepth: number; concurrency: number; includeSubcollections: boolean; includeAuth: boolean; includeStorage: boolean }

export const DEFAULT_INSPECT_OPTIONS: InspectOptions = { sampleSize: 100, maxAuthUsers: 100000, subcollectionProbe: 25, maxSubcollectionDepth: 20, concurrency: 4, includeSubcollections: true, includeAuth: true, includeStorage: true }
export const AUTH_CREDENTIAL_NOTE = 'Password hashes are written only when auth.includePasswordHashes is true. inspect never reads them into this report.'
export const AUTH_TABLE = 'firebase_auth_users'
export const STORAGE_TABLE = 'firebase_storage_objects'

export interface ClassifiedValue { type: FirestoreFieldType; referenceTarget?: string }
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
  return collectionIds.find((id) => { const candidate = normalizeName(id); return candidate === key || candidate === `${key}s` || candidate === `${key}es` || (key.endsWith('y') && candidate === `${key.slice(0, -1)}ies`) })
}

interface FieldAccumulator { types: Map<FirestoreFieldType, number>; present: number; targets: Map<string, number> }
export function analyzeFields(collectionId: string, docs: SampledDocument[], collectionIds: string[]): FieldSummary[] {
  const accumulators = new Map<string, FieldAccumulator>()
  for (const doc of docs) for (const [name, value] of Object.entries(doc.data)) {
    let acc = accumulators.get(name)
    if (!acc) { acc = { types: new Map(), present: 0, targets: new Map() }; accumulators.set(name, acc) }
    const classified = classifyValue(value)
    if (classified.type === 'null') continue
    acc.present += 1
    acc.types.set(classified.type, (acc.types.get(classified.type) ?? 0) + 1)
    if (classified.referenceTarget) acc.targets.set(classified.referenceTarget, (acc.targets.get(classified.referenceTarget) ?? 0) + 1)
  }
  return [...accumulators.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, acc]) => {
    const observed = [...acc.types.keys()].sort()
    const summary: FieldSummary = { name, types: observed.length ? observed : ['null'], presenceRate: docs.length ? acc.present / docs.length : 0 }
    const warnings: string[] = []
    if (observed.length > 1) warnings.push(`${collectionId}.${name} has mixed types (${[...acc.types.entries()].sort((x, y) => y[1] - x[1]).map(([type, count]) => `${type}: ${count}`).join(', ')}); it maps to jsonb until reviewed`)
    if (acc.targets.size > 0) {
      const ranked = [...acc.targets.entries()].sort((x, y) => y[1] - x[1])
      const target = ranked[0]![0]
      summary.relationship = { targetCollection: target, confidence: ranked.length > 1 ? 0.5 : collectionIds.includes(target) ? 1 : 0.6 }
      if (ranked.length > 1) warnings.push(`${collectionId}.${name} references several collections (${ranked.map(([id]) => id).join(', ')}); pick the target manually`)
      else if (!collectionIds.includes(target)) warnings.push(`${collectionId}.${name} points at "${target}", which is not a top-level collection found in this scan`)
    } else if (observed.includes('string')) {
      const guess = guessRelationshipTarget(name, collectionIds)
      if (guess) { summary.relationship = { targetCollection: guess, confidence: 0.5 }; warnings.push(`${collectionId}.${name} may reference "${guess}" (matched by field name only; it is not a Firestore reference)`) }
    }
    if (warnings.length) summary.warnings = warnings
    return summary
  })
}

const KNOWN_PROVIDERS: FirebaseProvider[] = ['password', 'google.com', 'github.com', 'apple.com', 'phone']
export const toFirebaseProvider = (id: string): FirebaseProvider => (KNOWN_PROVIDERS as string[]).includes(id) ? (id as FirebaseProvider) : 'other'
const emptyProviders = (): Record<FirebaseProvider, number> => ({ password: 0, 'google.com': 0, 'github.com': 0, 'apple.com': 0, phone: 0, other: 0 })
const emptyAuth = (): AuthSummary => ({ userCount: 0, providers: emptyProviders(), credentialWarning: AUTH_CREDENTIAL_NOTE, usersWithPasswordHash: 0 })
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => { while (next < items.length) { const index = next++; results[index] = await fn(items[index] as T) } }))
  return results
}
const formatCount = (value: number): string => value.toLocaleString('en-US')
export function pathMatches(documentPath: string, pattern: string): boolean {
  const actual = documentPath.split('/')
  const expected = pattern.split('/')
  return actual.length === expected.length && expected.every((part, index) => part === '*' || part === actual[index])
}
export function subcollectionTableFromPath(pattern: string): string { return pattern.split('/').filter((part) => part !== '*').join('__') }
export function leafCollectionId(pattern: string): string { return pattern.split('/').filter((part) => part !== '*').at(-1) ?? pattern }

interface NestedJob { path: string; table: string; parentTable: string; sub: string }

export class SourceBackedDiscovery implements FirebaseDiscovery {
  constructor(private readonly open: () => Promise<OpenedSources>, private readonly options: InspectOptions = DEFAULT_INSPECT_OPTIONS, private readonly redact: (message: string) => string = (message) => message, private readonly onProgress: (message: string) => void = () => undefined) {}
  private describe(error: unknown): string { return this.redact((error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim()).slice(0, 400) }

  async inspect(): Promise<InspectionReport> {
    const generatedAt = new Date().toISOString()
    let opened: OpenedSources
    try { opened = await this.open() } catch (error) {
      const message = this.describe(error)
      return { generatedAt, collections: [], totalDocuments: 0, nestedCollections: 0, estimatedTables: 0, auth: emptyAuth(), warnings: [], sources: { firestore: { ok: false, error: message }, auth: { ok: false, error: message }, storage: { ok: false, error: message } } }
    }
    try {
      const warnings: string[] = []
      const sources: NonNullable<InspectionReport['sources']> = { firestore: { ok: true }, auth: { ok: true }, storage: { ok: true } }
      let collections: CollectionSummary[] = []
      let auth = emptyAuth()
      try { this.onProgress('Reading Firestore collections...'); collections = await this.readFirestore(opened.firestore, warnings) } catch (error) { sources.firestore = { ok: false, error: this.describe(error) } }
      try { this.onProgress('Reading Firebase Auth users...'); const result = await this.readAuth(opened.auth); auth = result.summary; warnings.push(...result.warnings); if (this.options.includeAuth) collections.push(authCollection(result.summary)) } catch (error) { sources.auth = { ok: false, error: this.describe(error) } }
      if (this.options.includeStorage) {
        try { this.onProgress('Reading Firebase Storage metadata...'); const objects = await opened.storage.listObjects(1000); collections.push(storageCollection(objects)); if (objects.length === 1000) warnings.push('Storage metadata sample stopped at 1,000 objects during inspect; migrate still streams the full bucket') } catch (error) { sources.storage = { ok: false, error: this.describe(error) }; warnings.push(`Firebase Storage metadata was not read: ${sources.storage.error}. File bytes are not copied in this version.`) }
      }
      const dataCollections = collections.filter((collection) => collection.kind !== 'auth' && collection.kind !== 'storage')
      return { generatedAt, collections, totalDocuments: dataCollections.reduce((sum, collection) => sum + collection.documentCount, 0), nestedCollections: collections.filter((collection) => collection.kind === 'subcollection').length, estimatedTables: collections.length, auth, warnings, sampledDocuments: dataCollections.reduce((sum, collection) => sum + (collection.sampledDocuments ?? 0), 0), sources }
    } finally { await opened.close().catch(() => undefined) }
  }

  async inspectAuth(): Promise<AuthSummary> { const opened = await this.open(); try { return (await this.readAuth(opened.auth)).summary } finally { await opened.close().catch(() => undefined) } }

  async *streamDocuments(collectionPath: string): AsyncIterable<Record<string, unknown>> {
    const opened = await this.open()
    try {
      if (collectionPath.includes('/*/')) {
        const leaf = leafCollectionId(collectionPath)
        const documentPattern = `${collectionPath}/*`
        for await (const document of opened.firestore.streamCollectionGroup(leaf)) {
          if (!pathMatches(document.path ?? '', documentPattern)) continue
          yield rowFromDocument(document)
        }
        return
      }
      for await (const document of opened.firestore.streamDocuments(collectionPath)) yield rowFromDocument(document)
    } finally { await opened.close().catch(() => undefined) }
  }

  async *streamAuthUsers(includePasswordHashes: boolean, hashParams?: { signerKey: string; saltSeparator: string; rounds: number; memCost: number }): AsyncIterable<Record<string, unknown>> {
    const opened = await this.open()
    try { for await (const user of opened.auth.streamUsers()) yield authRow(user, includePasswordHashes, hashParams) } finally { await opened.close().catch(() => undefined) }
  }
  async *streamStorageObjects(): AsyncIterable<Record<string, unknown>> {
    const opened = await this.open()
    try { for await (const object of opened.storage.streamObjects()) yield { id: object.name, bucket: object.bucket, size: object.size, content_type: object.contentType, updated: object.updated, md5_hash: object.md5Hash } } finally { await opened.close().catch(() => undefined) }
  }

  private async readFirestore(firestore: FirestoreSource, warnings: string[]): Promise<CollectionSummary[]> {
    const ids = (await firestore.listCollectionIds()).sort()
    const perCollection = await mapWithConcurrency(ids, this.options.concurrency, async (id) => this.readCollection(firestore, id, ids))
    const collections = perCollection.map((entry) => entry.summary)
    for (const entry of perCollection) warnings.push(...entry.warnings)
    if (!this.options.includeSubcollections) return collections
    const jobs: NestedJob[] = []
    for (const id of ids) jobs.push(...await this.walkSubcollections(firestore, id, id, 1, warnings))
    const nested = await mapWithConcurrency(jobs, this.options.concurrency, async (job) => this.readSubcollection(firestore, job, ids))
    for (const entry of nested) warnings.push(...entry.warnings)
    return [...collections, ...nested.map((entry) => entry.summary)]
  }

  private async walkSubcollections(firestore: FirestoreSource, collectionPattern: string, parentTable: string, depth: number, warnings: string[]): Promise<NestedJob[]> {
    const subIds = await this.collectSubcollectionIds(firestore, collectionPattern)
    const jobs: NestedJob[] = []
    for (const sub of subIds.sort()) {
      const path = `${collectionPattern}/*/${sub}`
      const table = subcollectionTableFromPath(path)
      jobs.push({ path, table, parentTable, sub })
      if (depth >= this.options.maxSubcollectionDepth) warnings.push(`${path} is at the depth limit of ${this.options.maxSubcollectionDepth}; deeper subcollections were not scanned`)
      else jobs.push(...await this.walkSubcollections(firestore, path, table, depth + 1, warnings))
    }
    return jobs
  }

  private async collectSubcollectionIds(firestore: FirestoreSource, collectionPattern: string): Promise<string[]> {
    this.onProgress(`Scanning every document in ${collectionPattern} for subcollections...`)
    const ids = new Set<string>()
    const documentPattern = `${collectionPattern}/*`
    const nested = collectionPattern.includes('/')
    const stream = nested ? firestore.streamCollectionGroup(leafCollectionId(collectionPattern)) : firestore.streamDocuments(collectionPattern)
    const paths: string[] = []
    for await (const document of stream) {
      if (nested && !pathMatches(document.path ?? '', documentPattern)) continue
      if (document.path) paths.push(document.path)
    }
    const listed = await mapWithConcurrency(paths, this.options.concurrency, async (path) => firestore.listSubcollectionIdsAt(path))
    for (const found of listed) for (const id of found) ids.add(id)
    return [...ids]
  }

  private async readCollection(firestore: FirestoreSource, id: string, allIds: string[]): Promise<{ summary: CollectionSummary; warnings: string[] }> {
    const [count, docs] = await Promise.all([firestore.countDocuments(id), firestore.sampleDocuments(id, this.options.sampleSize)])
    const fields = analyzeFields(id, docs, allIds)
    const warnings = fields.flatMap((field) => field.warnings ?? [])
    if (count === 0) warnings.push(`${id} has no documents; there is nothing to infer from it`)
    else if (docs.length < count) warnings.push(`${id}: analyzed the first ${formatCount(docs.length)} of ${formatCount(count)} documents (ordered by document ID); field types and presence reflect that sample only`)
    return { summary: { path: id, name: id, documentCount: count, nestedCollectionCount: 0, fields, sampledDocuments: docs.length, kind: 'collection' }, warnings }
  }

  private async readSubcollection(firestore: FirestoreSource, job: NestedJob, allIds: string[]): Promise<{ summary: CollectionSummary; warnings: string[] }> {
    const docs = await firestore.sampleCollectionGroup(job.sub, this.options.sampleSize)
    const documentPattern = `${job.path}/*`
    const owned = docs.filter((doc) => pathMatches(doc.path ?? '', documentPattern))
    const fields = analyzeFields(job.table, owned.length ? owned : docs, allIds)
    const warnings = fields.flatMap((field) => field.warnings ?? [])
    warnings.push(`${job.path}: every document is scanned, then written to "${job.table}" with _parent_id, _parent_path and _path. Fields outside the sample are kept in _extra.`)
    return { summary: { path: job.path, name: job.table, documentCount: owned.length, nestedCollectionCount: 0, fields, sampledDocuments: owned.length || docs.length, kind: 'subcollection', parentCollection: job.parentTable, countIsEstimate: true }, warnings }
  }

  private async readAuth(auth: AuthSource): Promise<{ summary: AuthSummary; warnings: string[] }> {
    const scan = await auth.scanUsers(this.options.maxAuthUsers)
    const providers = emptyProviders()
    const otherIds: string[] = []
    for (const [id, count] of Object.entries(scan.providerCounts)) { const provider = toFirebaseProvider(id); providers[provider] += count; if (provider === 'other') otherIds.push(id) }
    const warnings: string[] = []
    if (!scan.complete) warnings.push(`Auth scan stopped after ${formatCount(scan.userCount)} users; user and provider counts are partial`)
    if (otherIds.length) warnings.push(`Other sign-in providers found: ${otherIds.sort().join(', ')}`)
    if (scan.usersWithoutProvider) warnings.push(`${formatCount(scan.usersWithoutProvider)} users have no linked provider (anonymous or custom-token sign-in)`)
    if (scan.usersWithPasswordHash === 0 && providers.password > 0) warnings.push('Password users were found, but the Admin SDK did not return password hashes. The service account needs permission to read Auth user records, or hashes will be stored as null.')
    return { summary: { userCount: scan.userCount, providers, credentialWarning: AUTH_CREDENTIAL_NOTE, usersWithPasswordHash: scan.usersWithPasswordHash }, warnings }
  }
}

function authCollection(auth: AuthSummary): CollectionSummary {
  return { path: 'firebase-auth/users', name: AUTH_TABLE, documentCount: auth.userCount, nestedCollectionCount: 0, sampledDocuments: 0, kind: 'auth', fields: [
    { name: 'email', types: ['string'], presenceRate: 0.9 }, { name: 'email_verified', types: ['boolean'], presenceRate: 1 }, { name: 'display_name', types: ['string'], presenceRate: 0.5 }, { name: 'photo_url', types: ['string'], presenceRate: 0.3 }, { name: 'phone_number', types: ['string'], presenceRate: 0.1 }, { name: 'disabled', types: ['boolean'], presenceRate: 1 }, { name: 'created_at', types: ['timestamp'], presenceRate: 1 }, { name: 'last_sign_in_at', types: ['timestamp'], presenceRate: 0.8 }, { name: 'providers', types: ['array'], presenceRate: 1 }, { name: 'provider_data', types: ['array'], presenceRate: 1 }, { name: 'custom_claims', types: ['map'], presenceRate: 0.2 }, { name: 'password_hash', types: ['string'], presenceRate: 0.5 }, { name: 'password_salt', types: ['string'], presenceRate: 0.5 }, { name: 'supabase_password_hash', types: ['string'], presenceRate: 0.5 },
  ] }
}
function storageCollection(objects: StorageObjectRecord[]): CollectionSummary {
  return { path: 'firebase-storage/objects', name: STORAGE_TABLE, documentCount: objects.length, nestedCollectionCount: 0, sampledDocuments: objects.length, kind: 'storage', countIsEstimate: true, fields: [
    { name: 'bucket', types: ['string'], presenceRate: 1 }, { name: 'size', types: ['number'], presenceRate: 1 }, { name: 'content_type', types: ['string'], presenceRate: 0.9 }, { name: 'updated', types: ['timestamp'], presenceRate: 1 }, { name: 'md5_hash', types: ['string'], presenceRate: 0.9 },
  ] }
}
export function rowFromDocument(document: SampledDocument): Record<string, unknown> {
  return { id: document.id, ...(document.path ? { _path: document.path } : {}), ...(document.parentId ? { _parent_id: document.parentId } : {}), ...(document.parentPath ? { _parent_path: document.parentPath } : {}), ...document.data }
}
export function buildSupabasePasswordHash(hash: string, salt: string, signerKey: string, saltSeparator: string, rounds: number, memCost: number): string {
  return `$fbscrypt$v=1,n=${rounds},r=${memCost},p=1,ss=${saltSeparator},sk=${signerKey}$${salt}$${hash}`
}
export function authRow(user: AuthUserRecord, includePasswordHashes: boolean, hashParams?: { signerKey: string; saltSeparator: string; rounds: number; memCost: number }): Record<string, unknown> {
  const passwordHash = includePasswordHashes ? user.passwordHash : null
  const passwordSalt = includePasswordHashes ? user.passwordSalt : null
  const supabase = includePasswordHashes && passwordHash && passwordSalt && hashParams ? buildSupabasePasswordHash(passwordHash, passwordSalt, hashParams.signerKey, hashParams.saltSeparator, hashParams.rounds, hashParams.memCost) : null
  return { id: user.uid, email: user.email, email_verified: user.emailVerified, display_name: user.displayName, photo_url: user.photoURL, phone_number: user.phoneNumber, disabled: user.disabled, created_at: user.createdAt, last_sign_in_at: user.lastSignInAt, providers: user.providers, provider_data: user.providerData, custom_claims: user.customClaims, password_hash: passwordHash, password_salt: passwordSalt, supabase_password_hash: supabase }
}
