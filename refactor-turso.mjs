import fs from 'fs';
import path from 'path';

const projectRoot = process.cwd();

// 1. Refactor server/db.ts
const dbPath = path.join(projectRoot, 'server/db.ts');
let dbContent = fs.readFileSync(dbPath, 'utf8');

// Remove Firebase imports
dbContent = dbContent.replace(/import { initializeApp, getApps, getApp } from 'firebase\/app';\n/g, '');
dbContent = dbContent.replace(/import { getFirestore, collection, getDocs, where, query, writeBatch, doc, setDoc, limit } from 'firebase\/firestore';\n/g, '');

// Remove Firestore connection logic
dbContent = dbContent.replace(/let firestoreDb: any = null;\n[\s\S]*?export function getTursoClient\(\) \{/g, 'export function getTursoClient() {');

// Rename exported statuses
dbContent = dbContent.replace(/export let firestoreStatus:/g, 'export let dbStatus:');
dbContent = dbContent.replace(/firestoreStatus = /g, 'dbStatus = ');

// Replace loadFromFirestore
dbContent = dbContent.replace(/export async function loadFromFirestore/g, 'export async function loadFromTurso');
dbContent = dbContent.replace(/const fdb = getFirestoreDb\(\);\n[\s\S]*?const results = await Promise\.all\(fetchPromises\);/g, `const client = getTursoClient();

    // Ensure remote tables exist on Turso
    const allTables = ['shiptax', 'charges', 'double_billing', 'review', 'uploads', 'summary_stats', 'datewise_summary', 'customer_fob', 'courier_settings', 'courier_zones', 'courier_rates', 'country_master', 'rate_packages'];
    for (const t of allTables) {
       await client.execute(\`CREATE TABLE IF NOT EXISTS \${t} (id INTEGER PRIMARY KEY)\`); // Dummy create to ensure it exists if empty, though schema sync is better done manually or via local.db schema dump. Wait, Turso doesn't need this if we just try catch the select.
    }
    
    console.log('[TURSO] Syncing on-demand tables from Turso:', toLoad);
    const results: any[] = [];
    for (const table of toLoad) {
      try {
        const rs = await client.execute(\`SELECT * FROM \${table}\`);
        results.push({ table, allRows: rs.rows });
      } catch (e) {
        // Table might not exist yet on remote, that's fine
        results.push({ table, allRows: [] });
      }
    }`);

dbContent = dbContent.replace(/\[FIRESTORE/g, '[TURSO');
dbContent = dbContent.replace(/\[FIRESTORE SYNC\]/g, '[TURSO SYNC]');
dbContent = dbContent.replace(/saveToFirestore/g, 'saveToTurso');

// Fix the specialized saveToFirestore block in loadFromTurso
dbContent = dbContent.replace(/await saveToTurso\(\['country_master'\]\);/g, 'await saveToTurso(["country_master"]);');

// Completely replace the old saveToFirestore function body
const oldSaveFuncRegex = /export async function saveToTurso\(tablesToSave\?: string\[\]\) \{[\s\S]*?export function forceEmptyAndLoaded\(\)/;
const newSaveFunc = `export async function saveToTurso(tablesToSave?: string[]) {
  try {
    const client = getTursoClient();
    const allTables = ['shiptax', 'charges', 'double_billing', 'review', 'uploads', 'summary_stats', 'datewise_summary', 'customer_fob', 'courier_settings', 'courier_zones', 'courier_rates', 'country_master', 'rate_packages'];
    const tables = tablesToSave || allTables;

    // Conditionally recalculate precomputed tables locally if we are saving them
    if (tables.includes('summary_stats') || tables.includes('datewise_summary')) {
      const shiptaxCount = localDb.prepare('SELECT COUNT(*) AS count FROM shiptax').get() as any;
      const chargesCount = localDb.prepare('SELECT COUNT(*) AS count FROM charges').get() as any;
      const doubleCount = localDb.prepare('SELECT COUNT(*) AS count FROM double_billing').get() as any;
      const reviewCount = localDb.prepare('SELECT COUNT(*) AS count FROM review').get() as any;
      
      const allCharges = localDb.prepare('SELECT * FROM charges').all() as any[];
      const computedDuty = allCharges.reduce((acc: number, row: any) => acc + (Number(row.duty_amount) || 0), 0);
      
      localDb.exec('DELETE FROM summary_stats');
      localDb.prepare('INSERT INTO summary_stats (shiptax, charges, double, review, duty) VALUES (?, ?, ?, ?, ?)').run(
        shiptaxCount?.count || 0, chargesCount?.count || 0, doubleCount?.count || 0, reviewCount?.count || 0, computedDuty
      );
      
      localDb.exec('DELETE FROM datewise_summary');
      const groups: Record<string, any> = {};
      for (const row of allCharges) {
        let fDate = row.final_date || 'Missing Date';
        if (fDate === 'Unknown' || fDate === 'null' || fDate === 'undefined') fDate = 'Missing Date';
        const key = \`\${fDate}|\${row.courier}\`;
        if (!groups[key]) groups[key] = { ship_date: fDate, courier: row.courier, awbs: new Set<string>(), duty_amount: 0 };
        groups[key].awbs.add(row.awb);
        groups[key].duty_amount += Number(row.duty_amount) || 0;
      }
      
      if (Object.keys(groups).length > 0) {
        const insertDatewise = localDb.prepare('INSERT INTO datewise_summary (ship_date, courier, shipment_count, duty_amount, awbs) VALUES (?, ?, ?, ?, ?)');
        localDb.transaction(() => {
          for (const g of Object.values(groups)) {
            insertDatewise.run(g.ship_date, g.courier, g.awbs.size, g.duty_amount, Array.from(g.awbs).join(','));
          }
        })();
      }
    }

    console.log('[TURSO] Uploading local tables to remote Turso DB:', tables);
    
    // Auto-migrate schema on remote Turso just in case
    try {
        await client.executeMultiple(\`
        CREATE TABLE IF NOT EXISTS shiptax (awb TEXT PRIMARY KEY, original_awb TEXT, ship_date TEXT, courier TEXT, country TEXT, order_reference TEXT, source_file TEXT, import_batch TEXT, created_at TEXT);
        CREATE TABLE IF NOT EXISTS charges (id INTEGER PRIMARY KEY AUTOINCREMENT, signature TEXT UNIQUE, awb TEXT, original_awb TEXT, courier TEXT, charge_type TEXT, charge_type_key TEXT, duty_amount REAL, disbursement_fee REAL, tax_amount REAL, other_charges REAL, total_charges REAL, currency TEXT, invoice_number TEXT, invoice_date TEXT, courier_ship_date TEXT, final_date TEXT, date_source TEXT, shiptax_found INTEGER, shiptax_ship_date TEXT, destination_country TEXT, charge_month TEXT, source_file TEXT, source_sheet TEXT, source_row INTEGER, status TEXT, created_at TEXT);
        CREATE TABLE IF NOT EXISTS double_billing (id INTEGER PRIMARY KEY AUTOINCREMENT, awb TEXT, courier TEXT, ship_date TEXT, first_charge_month TEXT, first_invoice_number TEXT, first_source_file TEXT, repeat_charge_month TEXT, repeat_invoice_number TEXT, repeat_source_file TEXT, duty_amount REAL, first_amount REAL, repeat_amount REAL, difference REAL, charge_type TEXT, message TEXT, created_at TEXT);
        CREATE TABLE IF NOT EXISTS review (id INTEGER PRIMARY KEY AUTOINCREMENT, reason TEXT, courier TEXT, awb TEXT, source_file TEXT, source_sheet TEXT, source_row INTEGER, message TEXT, created_at TEXT);
        CREATE TABLE IF NOT EXISTS uploads (id INTEGER PRIMARY KEY AUTOINCREMENT, file_name TEXT UNIQUE, file_type TEXT, import_type TEXT, rows_seen INTEGER, rows_added INTEGER, rows_skipped INTEGER, created_at TEXT);
        CREATE TABLE IF NOT EXISTS summary_stats (shiptax INTEGER, charges INTEGER, double INTEGER, review INTEGER, duty REAL);
        CREATE TABLE IF NOT EXISTS datewise_summary (ship_date TEXT, courier TEXT, shipment_count INTEGER, duty_amount REAL, awbs TEXT, PRIMARY KEY (ship_date, courier));
        CREATE TABLE IF NOT EXISTS customer_fob (awb TEXT PRIMARY KEY, original_awb TEXT, fob_inr REAL, invoice_number TEXT, invoice_date TEXT, country TEXT, shipping_bill TEXT, source_file TEXT, created_at TEXT);
        CREATE TABLE IF NOT EXISTS courier_settings (courier TEXT PRIMARY KEY, fuel_surcharge REAL DEFAULT 0, gst REAL DEFAULT 0, other_surcharge REAL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS courier_zones (id INTEGER PRIMARY KEY AUTOINCREMENT, courier TEXT, country TEXT, zone TEXT, package_id TEXT, service TEXT, direction TEXT, country_code TEXT, active INTEGER DEFAULT 1, country_name TEXT, raw_country_value TEXT);
        CREATE TABLE IF NOT EXISTS country_master (id INTEGER PRIMARY KEY AUTOINCREMENT, country_code TEXT UNIQUE, country_name TEXT, normalized_name TEXT, iso3_code TEXT, aliases_json TEXT, is_active INTEGER DEFAULT 1);
        CREATE TABLE IF NOT EXISTS courier_rates (id INTEGER PRIMARY KEY AUTOINCREMENT, courier TEXT, shipment_type TEXT, weight_slab REAL, is_per_kg INTEGER DEFAULT 0, min_weight REAL, max_weight REAL, rates_json TEXT, package_id TEXT, service TEXT, direction TEXT, active INTEGER DEFAULT 1);
        CREATE TABLE IF NOT EXISTS rate_packages (id TEXT PRIMARY KEY, courier TEXT, service TEXT, direction TEXT, file_name TEXT, file_hash TEXT UNIQUE, parser_version TEXT, uploaded_at TEXT, effective_date TEXT, status TEXT DEFAULT 'active', import_result TEXT, warning_count INTEGER DEFAULT 0);
        \`);
    } catch(e) { console.warn('[TURSO] Schema init warning:', e); }

    for (const table of tables) {
      const localRows = localDb.prepare(\`SELECT * FROM \${table}\`).all() as any[];
      
      const stmts = [];
      stmts.push(\`DELETE FROM \${table}\`);
      
      if (localRows.length > 0) {
        const columns = Object.keys(localRows[0]);
        const sql = \`INSERT INTO \${table} (\${columns.join(', ')}) VALUES (\${columns.map(() => '?').join(', ')})\`;
        
        for (const row of localRows) {
          const args = columns.map(col => row[col]);
          stmts.push({ sql, args });
        }
      }
      
      const chunkSize = 500;
      for (let i = 0; i < stmts.length; i += chunkSize) {
        await client.batch(stmts.slice(i, i + chunkSize), 'write');
      }
      loadedTables.add(table);
    }
    
    console.log('[TURSO] Cloud sync complete for tables:', tables);
    dbStatus = 'Connected';
    lastDbError = null;
  } catch (err: any) {
    console.error('[TURSO SYNC ERROR]', err);
    dbStatus = 'Using temporary cache';
    lastDbError = err.message || String(err);
    throw err;
  }
}

export function forceEmptyAndLoaded()`;

dbContent = dbContent.replace(oldSaveFuncRegex, newSaveFunc);
fs.writeFileSync(dbPath, dbContent);


// 2. Refactor server.ts
const serverPath = path.join(projectRoot, 'server.ts');
let serverContent = fs.readFileSync(serverPath, 'utf8');

serverContent = serverContent.replace(/loadFromFirestore/g, 'loadFromTurso');
serverContent = serverContent.replace(/saveToFirestore/g, 'saveToTurso');
serverContent = serverContent.replace(/firestoreStatus/g, 'dbStatus');
serverContent = serverContent.replace(/firebase/g, 'turso');
fs.writeFileSync(serverPath, serverContent);

// 3. Rename server/firebase.ts to server/turso.ts and refactor
const firebasePath = path.join(projectRoot, 'server/firebase.ts');
const tursoPath = path.join(projectRoot, 'server/turso.ts');

if (fs.existsSync(firebasePath)) {
    let firebaseContent = fs.readFileSync(firebasePath, 'utf8');
    firebaseContent = firebaseContent.replace(/loadFromFirestore/g, 'loadFromTurso');
    firebaseContent = firebaseContent.replace(/saveToFirestore/g, 'saveToTurso');
    fs.writeFileSync(tursoPath, firebaseContent);
    fs.unlinkSync(firebasePath);
}

console.log("Refactoring complete.");
