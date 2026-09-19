import type { FireMigrateConfig } from './config'
import type { AuthScan, AuthSource, FirestoreSource, OpenedSources, SampledDocument } from './inspect'


export async function openFirebaseAdmin(config: FireMigrateConfig): Promise<OpenedSources> {
  const appModule = await import('firebase-admin/app')
  const firestoreModule = await import('firebase-admin/firestore')
  const authModule = await import('firebase-admin/auth')

  const { projectId, clientEmail, privateKey } = config.firebase
  const app = appModule.initializeApp({ credential: appModule.cert({ projectId, clientEmail, privateKey }), projectId }, `firemigrate-${Date.now()}`)
  const db = firestoreModule.getFirestore(app)
  const auth = authModule.getAuth(app)

  const firestore: FirestoreSource = {
    async listCollectionIds() {
      return (await db.listCollections()).map((collection) => collection.id)
    },
    async countDocuments(collectionId) {
      return (await db.collection(collectionId).count().get()).data().count
    },
    async sampleDocuments(collectionId, limit) {
      const snapshot = await db.collection(collectionId).limit(limit).get()
      return snapshot.docs.map((doc): SampledDocument => ({ id: doc.id, data: doc.data() as Record<string, unknown> }))
    },
    async *streamDocuments(collectionId) {
      const snapshot = await db.collection(collectionId).get()
      for (const doc of snapshot.docs) yield { id: doc.id, data: doc.data() as Record<string, unknown> }
    },
    async listSubcollectionIds(collectionId, documentId) {
      return (await db.collection(collectionId).doc(documentId).listCollections()).map((collection) => collection.id)
    },
  }

  const authSource: AuthSource = {
    async scanUsers(maxUsers): Promise<AuthScan> {
      const providerCounts: Record<string, number> = {}
      let userCount = 0
      let usersWithoutProvider = 0
      let complete = true
      let pageToken: string | undefined
      do {
        const page = await auth.listUsers(1000, pageToken)
        for (const user of page.users) {
          userCount += 1
          const ids = new Set(user.providerData.map((provider) => provider.providerId))
          if (ids.size === 0) usersWithoutProvider += 1
          for (const id of ids) providerCounts[id] = (providerCounts[id] ?? 0) + 1
        }
        pageToken = page.pageToken
        if (pageToken && userCount >= maxUsers) {
          complete = false
          break
        }
      } while (pageToken)
      return { userCount, providerCounts, usersWithoutProvider, complete }
    },
  }

  return { firestore, auth: authSource, close: () => appModule.deleteApp(app) }
}
