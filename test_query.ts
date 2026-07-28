import { db } from './server/db.ts';

try {
  const rows = db.prepare("SELECT * FROM courier_zones WHERE courier = 'DHL' AND LOWER(country) LIKE 'u%'").all();
  console.log('DHL countries starting with U:', JSON.stringify(rows, null, 2));
} catch (err) {
  console.error(err);
}
