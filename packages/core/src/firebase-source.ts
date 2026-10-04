import type { AuthScan, AuthSource, AuthUserRecord, FirestoreSource, OpenedSources, SampledDocument, StorageObjectRecord, StorageSource } from './inspect'
import type { FireMigrateConfig } from './config'

const PAGE_SIZE = 500

interface PageDoc { id: string; ref: { path: string; parent: { parent: { id: string; path: string; parent: { id: string } } | null } }; data(): Record<string, unknown> }

export async function openFirebaseAdmin(config: FireMigrateConfig): Promise<OpenedSources> {
  const appModule = await import('firebase-admin/app')
  const firestoreModule = await import('firebase-admin/firestore')
  const authModule = await import('firebase-admin/auth')
  const storageModule = await import('firebase-admin/storage')

  const { projectId, clientEmail, privateKey } = config.firebase
  const app = appModule.initializeApp({ credential: appModule.cert({ projectId, clientEmail, privateKey }), projectId }, `firemigrate-${Date.now()}`)
  const db = firestoreModule.getFirestore(app)
  const auth = authModule.getAuth(app)
  const storage = storageModule.getStorage(app)
  const bucketName = config.storage.bucket || `${projectId}.appspot.com`

  const firestore: FirestoreSource = {
    async listCollectionIds() {
      return (await db.listCollections()).map((collection) => collection.id)
    },
    async countDocuments(collectionId) {
      return (await db.collection(collectionId).count().get()).data().count
    },
    async sampleDocuments(collectionId, limit) {
      const snapshot = await db.collection(collectionId).orderBy(firestoreModule.FieldPath.documentId()).limit(limit).get()
      return snapshot.docs.map((doc) => toSample(doc as unknown as PageDoc))
    },
    async *streamDocuments(collectionId) {
      yield* pageDocuments(async (last) => {
        let query = db.collection(collectionId).orderBy(firestoreModule.FieldPath.documentId()).limit(PAGE_SIZE)
        if (last) query = query.startAfter(last)
        return query.get()
      })
    },
    async listSubcollectionIds(collectionId, documentId) {
      return (await db.collection(collectionId).doc(documentId).listCollections()).map((collection) => collection.id)
    },
    async listSubcollectionIdsAt(documentPath) {
      return (await db.doc(documentPath).listCollections()).map((collection) => collection.id)
    },
    async countCollectionGroup(collectionId) {
      return (await db.collectionGroup(collectionId).count().get()).data().count
    },
    async sampleCollectionGroup(collectionId, limit) {
      const snapshot = await db.collectionGroup(collectionId).orderBy(firestoreModule.FieldPath.documentId()).limit(limit).get()
      return snapshot.docs.map((doc) => toSample(doc as unknown as PageDoc))
    },
    async *streamCollectionGroup(collectionId) {
      yield* pageDocuments(async (last) => {
        let query = db.collectionGroup(collectionId).orderBy(firestoreModule.FieldPath.documentId()).limit(PAGE_SIZE)
        if (last) query = query.startAfter(last)
        return query.get()
      })
    },
  }

  const authSource: AuthSource = {
    async scanUsers(maxUsers): Promise<AuthScan> {
      const providerCounts: Record<string, number> = {}
      let userCount = 0
      let usersWithoutProvider = 0
      let usersWithPasswordHash = 0
      let complete = true
      let pageToken: string | undefined
      do {
        const page = await auth.listUsers(1000, pageToken)
        for (const user of page.users) {
          userCount += 1
          const ids = new Set(user.providerData.map((provider) => provider.providerId))
          if (ids.size === 0) usersWithoutProvider += 1
          if (user.passwordHash) usersWithPasswordHash += 1
          for (const id of ids) providerCounts[id] = (providerCounts[id] ?? 0) + 1
        }
        pageToken = page.pageToken
        if (pageToken && userCount >= maxUsers) {
          complete = false
          break
        }
      } while (pageToken)
      return { userCount, providerCounts, usersWithoutProvider, usersWithPasswordHash, complete }
    },
    async *streamUsers() {
      let pageToken: string | undefined
      do {
        const page = await auth.listUsers(1000, pageToken)
        for (const user of page.users) yield toAuthUser(user)
        pageToken = page.pageToken
      } while (pageToken)
    },
  }

  const storageSource: StorageSource = {
    async listObjects(limit) {
      const bucket = storage.bucket(bucketName)
      const [files] = await bucket.getFiles({ maxResults: limit, autoPaginate: false })
      return files.map(toStorageObject)
    },
    async *streamObjects() {
      const bucket = storage.bucket(bucketName)
      let pageToken: string | undefined
      for (;;) {
        const [files, next] = await bucket.getFiles({ maxResults: PAGE_SIZE, autoPaginate: false, pageToken })
        for (const file of files) yield toStorageObject(file)
        pageToken = (next as { pageToken?: string } | undefined)?.pageToken
        if (!pageToken || files.length === 0) return
      }
    },
  }

  return { firestore, auth: authSource, storage: storageSource, close: () => appModule.deleteApp(app) }
}

async function* pageDocuments(load: (last?: unknown) => Promise<{ empty: boolean; size: number; docs: unknown[] }>): AsyncIterable<SampledDocument> {
  let last: unknown
  for (;;) {
    const snapshot = await load(last)
    if (snapshot.empty) return
    for (const doc of snapshot.docs) yield toSample(doc as PageDoc)
    last = snapshot.docs[snapshot.docs.length - 1]
    if (snapshot.size < PAGE_SIZE) return
  }
}

function toSample(doc: PageDoc): SampledDocument {
  const parentDoc = doc.ref.parent.parent
  return {
    id: doc.id,
    data: doc.data(),
    path: doc.ref.path,
    parentId: parentDoc?.id,
    parentPath: parentDoc?.path,
    parentCollection: parentDoc?.parent.id,
  }
}

function toAuthUser(user: import('firebase-admin/auth').UserRecord): AuthUserRecord {
  return {
    uid: user.uid,
    email: user.email ?? null,
    emailVerified: user.emailVerified,
    displayName: user.displayName ?? null,
    photoURL: user.photoURL ?? null,
    phoneNumber: user.phoneNumber ?? null,
    disabled: user.disabled,
    createdAt: user.metadata.creationTime || null,
    lastSignInAt: user.metadata.lastSignInTime || null,
    providers: user.providerData.map((provider) => provider.providerId),
    providerData: user.providerData.map((provider) => ({ providerId: provider.providerId, uid: provider.uid, email: provider.email ?? null, displayName: provider.displayName ?? null })),
    customClaims: user.customClaims ?? null,
    passwordHash: user.passwordHash ?? null,
    passwordSalt: user.passwordSalt ?? null,
  }
}

function toStorageObject(file: { name: string; metadata: Record<string, unknown>; bucket: { name: string } }): StorageObjectRecord {
  const metadata = file.metadata
  return {
    name: file.name,
    bucket: file.bucket.name,
    size: metadata.size === undefined || metadata.size === null ? null : Number(metadata.size),
    contentType: typeof metadata.contentType === 'string' ? metadata.contentType : null,
    updated: typeof metadata.updated === 'string' ? metadata.updated : null,
    md5Hash: typeof metadata.md5Hash === 'string' ? metadata.md5Hash : null,
  }
}
