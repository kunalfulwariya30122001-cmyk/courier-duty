import { createClient } from '@libsql/client';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  
  if (!url) {
    console.log('No Turso URL');
    return;
  }
  
  const client = createClient({ url, authToken });
  
  const allTables = ['shiptax', 'charges', 'double_billing', 'review', 'uploads', 'summary_stats', 'datewise_summary', 'customer_fob', 'courier_settings', 'courier_zones', 'courier_rates', 'country_master', 'rate_packages'];
  
  for (const t of allTables) {
    try {
      await client.execute(`DROP TABLE IF EXISTS ${t}`);
      console.log(`Dropped ${t}`);
    } catch(e) {
      console.log(`Failed to drop ${t}`, e.message);
    }
  }
  
  console.log('Done!');
  process.exit(0);
}

run();
