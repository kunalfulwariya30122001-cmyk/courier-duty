import { loadFromFirestore, saveToFirestore, clearTable } from './server/db.ts';

async function test() {
  console.log('Loading from Firestore first...');
  await loadFromFirestore();
  console.log('Loading done. Clearing tables locally...');
  clearTable('shiptax');
  clearTable('charges');
  clearTable('double_billing');
  clearTable('review');
  clearTable('uploads');
  console.log('Local tables cleared. Now syncing/saving to Firestore...');
  try {
    await saveToFirestore();
    console.log('Successfully saved to Firestore!');
  } catch (err: any) {
    console.error('Error occurred in saveToFirestore:', err);
    if (err.stack) {
      console.error(err.stack);
    }
  }
}

test();
