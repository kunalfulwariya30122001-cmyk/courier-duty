import { createClient } from '@libsql/client';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  
  if (!url) {
    console.log("No Turso URL");
    return;
  }

  const client = createClient({ url, authToken });

  console.log("Dropping country_master on Turso...");
  try {
    await client.execute("DROP TABLE IF EXISTS country_master");
    console.log("Dropped successfully.");
  } catch(e) {
    console.log("Failed to drop:", e.message);
  }
}

run();
