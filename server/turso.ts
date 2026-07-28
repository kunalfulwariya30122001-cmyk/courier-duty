import { loadFromTurso, saveToTurso } from './db.js';

export async function syncLocalToFirestore(sqliteDb?: any) {
  console.log('[FIREBASE] Syncing local in-memory DB to Firestore...');
  await saveToTurso();
}

export async function syncFirestoreToLocal(sqliteDb?: any) {
  console.log('[FIREBASE] Restoring local in-memory DB from Firestore...');
  await loadFromTurso();
}
