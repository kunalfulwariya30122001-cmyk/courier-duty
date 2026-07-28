import { loadFromFirestore, saveToFirestore } from './db.ts';

export async function syncLocalToFirestore(sqliteDb?: any) {
  console.log('[FIREBASE] Syncing local in-memory DB to Firestore...');
  await saveToFirestore();
}

export async function syncFirestoreToLocal(sqliteDb?: any) {
  console.log('[FIREBASE] Restoring local in-memory DB from Firestore...');
  await loadFromFirestore();
}
