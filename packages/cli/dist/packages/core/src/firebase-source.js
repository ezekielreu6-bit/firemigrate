"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.openFirebaseAdmin = openFirebaseAdmin;
async function openFirebaseAdmin(config) {
    const appModule = await Promise.resolve().then(() => __importStar(require('firebase-admin/app')));
    const firestoreModule = await Promise.resolve().then(() => __importStar(require('firebase-admin/firestore')));
    const authModule = await Promise.resolve().then(() => __importStar(require('firebase-admin/auth')));
    const { projectId, clientEmail, privateKey } = config.firebase;
    const app = appModule.initializeApp({ credential: appModule.cert({ projectId, clientEmail, privateKey }), projectId }, `firemigrate-${Date.now()}`);
    const db = firestoreModule.getFirestore(app);
    const auth = authModule.getAuth(app);
    const firestore = {
        async listCollectionIds() {
            return (await db.listCollections()).map((collection) => collection.id);
        },
        async countDocuments(collectionId) {
            return (await db.collection(collectionId).count().get()).data().count;
        },
        async sampleDocuments(collectionId, limit) {
            const snapshot = await db.collection(collectionId).limit(limit).get();
            return snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
        },
        async listSubcollectionIds(collectionId, documentId) {
            return (await db.collection(collectionId).doc(documentId).listCollections()).map((collection) => collection.id);
        },
    };
    const authSource = {
        async scanUsers(maxUsers) {
            const providerCounts = {};
            let userCount = 0;
            let usersWithoutProvider = 0;
            let complete = true;
            let pageToken;
            do {
                const page = await auth.listUsers(1000, pageToken);
                for (const user of page.users) {
                    userCount += 1;
                    const ids = new Set(user.providerData.map((provider) => provider.providerId));
                    if (ids.size === 0)
                        usersWithoutProvider += 1;
                    for (const id of ids)
                        providerCounts[id] = (providerCounts[id] ?? 0) + 1;
                }
                pageToken = page.pageToken;
                if (pageToken && userCount >= maxUsers) {
                    complete = false;
                    break;
                }
            } while (pageToken);
            return { userCount, providerCounts, usersWithoutProvider, complete };
        },
    };
    return { firestore, auth: authSource, close: () => appModule.deleteApp(app) };
}
