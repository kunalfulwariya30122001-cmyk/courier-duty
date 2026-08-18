import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { createClient } from '@libsql/client';
import { COUNTRIES_LIST } from './data/countriesList.js';
import alasql from 'alasql';

dotenv.config();

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

export let dbStatus: 'Connected' | 'Quota exceeded' | 'Using temporary cache' | 'Data not loaded' = 'Data not loaded';
export let lastDbError: string | null = null;
export let rawRowsLoaded = true;

export const loadedTables = new Set<string>();
export let remoteSchemaInitialized = false;

const isVercel = !!process.env.VERCEL;
const dbPath = isVercel ? '/tmp/local.db' : path.join(process.cwd(), 'local.db');

class AlasqlStatement {
  private sql: string;

  constructor(sql: string) {
    this.sql = sql;
  }

  all(...params: any[]) {
    const args = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    try {
      const result = alasql(this.sql, args);
      return Array.isArray(result) ? result : [];
    } catch (err) {
      console.error('[ALASQL PREPARE ALL ERROR] SQL:', this.sql, 'Params:', args, err);
      return [];
    }
  }

  get(...params: any[]) {
    const args = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    try {
      const result = alasql(this.sql, args);
      if (Array.isArray(result)) {
        return result[0] || null;
      }
      return result || null;
    } catch (err) {
      console.error('[ALASQL PREPARE GET ERROR] SQL:', this.sql, 'Params:', args, err);
      return null;
    }
  }

  run(...params: any[]) {
    const args = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    try {
      const result = alasql(this.sql, args);
      const changes = Array.isArray(result) ? result.length : 1;
      return { changes, lastInsertRowid: 1 };
    } catch (err) {
      console.error('[ALASQL PREPARE RUN ERROR] SQL:', this.sql, 'Params:', args, err);
      return { changes: 0, lastInsertRowid: 0 };
    }
  }
}

class AlasqlDatabase {
  exec(sql: string) {
    const stmts = sql.split(';').map(s => s.trim()).filter(Boolean);
    for (const stmt of stmts) {
      try {
        const clean = this.cleanSql(stmt);
        if (clean && clean.trim()) {
          alasql(clean);
        }
      } catch (err: any) {
        // Silently ignore benign alaSQL duplicate column or index warnings
      }
    }
  }

  pragma(sql: string) {
    // Ignore PRAGMAs
  }

  prepare(sql: string) {
    return new AlasqlStatement(this.cleanSql(sql));
  }

  transaction(fn: any) {
    return (...args: any[]) => fn(...args);
  }

  private cleanSql(sql: string): string {
    let s = sql;
    s = s.replace(/AUTOINCREMENT/gi, '');
    s = s.replace(/PRIMARY KEY\s*\([^)]+\)/gi, '');
    s = s.replace(/PRIMARY KEY/gi, '');
    s = s.replace(/UNIQUE/gi, '');
    s = s.replace(/INSERT OR IGNORE/gi, 'INSERT');
    s = s.replace(/INSERT OR REPLACE/gi, 'REPLACE');
    s = s.replace(/CREATE INDEX.*$/gm, '');
    // Remove any trailing commas before closing parenthesis caused by stripped primary keys
    s = s.replace(/,\s*\)/g, ' )');
    // Translate count functions and aliases for alasql compatibility
    s = s.replace(/\bCOUNT\s*\(\s*\*\s*\)/gi, 'count(*)');
    s = s.replace(/\bCOUNT\s*\(\s*1\s*\)/gi, 'count(*)');
    s = s.replace(/\bAS\s+count\b/gi, 'AS [count]');
    return s;
  }
}



console.info('[DATABASE] Initializing alasql pure JS database...');
const tempLocalDb = new AlasqlDatabase();

// Initialize the local file-based SQLite database
export const localDb = tempLocalDb;
export const db = localDb;

let tursoClient: any = null;
export function getTursoClient() {
  if (!tursoClient) {
    if (!url) {
      console.warn('[TURSO] TURSO_DATABASE_URL environment variable is missing. Returning fallback dummy client.');
      return {
        execute: async (sql: string, args?: any[]) => {
          console.warn('[TURSO FALLBACK] Executing on dummy client:', sql, args);
          return { rows: [] };
        },
        batch: async (stmts: any[], mode?: string) => {
          console.warn('[TURSO FALLBACK] Batch executing on dummy client:', stmts, mode);
          return [];
        }
      };
    }
    tursoClient = createClient({
      url: url,
      authToken: authToken || '',
    });
  }
  return tursoClient;
}

// Ensures local database tables are initialized
export function initLocalSchema() {
  localDb.exec(`
    CREATE TABLE IF NOT EXISTS shiptax (
      awb TEXT PRIMARY KEY,
      original_awb TEXT,
      ship_date TEXT,
      courier TEXT,
      country TEXT,
      order_reference TEXT,
      source_file TEXT,
      import_batch TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS charges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signature TEXT UNIQUE,
      awb TEXT,
      original_awb TEXT,
      courier TEXT,
      charge_type TEXT,
      charge_type_key TEXT,
      duty_amount REAL,
      disbursement_fee REAL,
      tax_amount REAL,
      other_charges REAL,
      total_charges REAL,
      currency TEXT,
      invoice_number TEXT,
      invoice_date TEXT,
      courier_ship_date TEXT,
      final_date TEXT,
      date_source TEXT,
      shiptax_found INTEGER,
      shiptax_ship_date TEXT,
      destination_country TEXT,
      charge_month TEXT,
      source_file TEXT,
      source_sheet TEXT,
      source_row INTEGER,
      status TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS double_billing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      awb TEXT,
      courier TEXT,
      ship_date TEXT,
      first_charge_month TEXT,
      first_invoice_number TEXT,
      first_source_file TEXT,
      repeat_charge_month TEXT,
      repeat_invoice_number TEXT,
      repeat_source_file TEXT,
      duty_amount REAL,
      first_amount REAL,
      repeat_amount REAL,
      difference REAL,
      charge_type TEXT,
      message TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS review (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reason TEXT,
      courier TEXT,
      awb TEXT,
      source_file TEXT,
      source_sheet TEXT,
      source_row INTEGER,
      message TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT UNIQUE,
      file_type TEXT,
      import_type TEXT,
      rows_seen INTEGER,
      rows_added INTEGER,
      rows_skipped INTEGER,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS summary_stats (
      shiptax INTEGER,
      charges INTEGER,
      double INTEGER,
      review INTEGER,
      duty REAL
    );
    CREATE TABLE IF NOT EXISTS datewise_summary (
      ship_date TEXT,
      courier TEXT,
      shipment_count INTEGER,
      duty_amount REAL,
      awbs TEXT,
      PRIMARY KEY (ship_date, courier)
    );
    CREATE TABLE IF NOT EXISTS customer_fob (
      awb TEXT PRIMARY KEY,
      original_awb TEXT,
      fob_inr REAL,
      invoice_number TEXT,
      invoice_date TEXT,
      country TEXT,
      shipping_bill TEXT,
      source_file TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS courier_settings (
      courier TEXT PRIMARY KEY,
      fuel_surcharge REAL DEFAULT 0,
      gst REAL DEFAULT 0,
      other_surcharge REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS courier_zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      courier TEXT,
      country TEXT,
      zone TEXT,
      package_id TEXT,
      service TEXT,
      direction TEXT,
      country_code TEXT,
      active INTEGER DEFAULT 1,
      country_name TEXT,
      raw_country_value TEXT
    );
    CREATE TABLE IF NOT EXISTS country_master (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      country_code TEXT UNIQUE,
      country_name TEXT,
      normalized_name TEXT,
      iso3_code TEXT,
      aliases_json TEXT,
      is_active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS courier_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      courier TEXT,
      shipment_type TEXT,
      weight_slab REAL,
      is_per_kg INTEGER DEFAULT 0,
      min_weight REAL,
      max_weight REAL,
      rates_json TEXT,
      package_id TEXT,
      service TEXT,
      direction TEXT,
      active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS rate_packages (
      id TEXT PRIMARY KEY,
      courier TEXT,
      service TEXT,
      direction TEXT,
      file_name TEXT,
      file_hash TEXT UNIQUE,
      parser_version TEXT,
      uploaded_at TEXT,
      effective_date TEXT,
      status TEXT DEFAULT 'active',
      import_result TEXT,
      warning_count INTEGER DEFAULT 0
    );
  `);

  // Clean up potential duplicate courier_settings (if created without PRIMARY KEY previously)
  try {
    const counts = localDb.prepare('SELECT courier, COUNT(*) as cnt FROM courier_settings GROUP BY courier').all() as any[];
    const hasDuplicates = counts.some(c => c.cnt > 1);
    if (hasDuplicates) {
      console.log('[MIGRATION] Found duplicate courier_settings, recreating table to enforce UNIQUE');
      const uniqueSettings = localDb.prepare('SELECT courier, MAX(fuel_surcharge) as fuel_surcharge, MAX(gst) as gst, MAX(other_surcharge) as other_surcharge FROM courier_settings GROUP BY courier').all() as any[];
      localDb.exec('DROP TABLE courier_settings');
      localDb.exec(`
        CREATE TABLE courier_settings (
          courier TEXT PRIMARY KEY,
          fuel_surcharge REAL DEFAULT 0,
          gst REAL DEFAULT 0,
          other_surcharge REAL DEFAULT 0
        )
      `);
      const insert = localDb.prepare('INSERT INTO courier_settings (courier, fuel_surcharge, gst, other_surcharge) VALUES (?, ?, ?, ?)');
      localDb.transaction(() => {
        for (const s of uniqueSettings) {
          insert.run(s.courier, s.fuel_surcharge || 0, s.gst || 0, s.other_surcharge || 0);
        }
      })();
    }
  } catch (e) {
    console.error('[MIGRATION ERROR] cleaning courier_settings', e);
  }

  // Seed default settings if they do not exist
  try {
    localDb.exec(`
      INSERT OR IGNORE INTO courier_settings (courier, fuel_surcharge, gst, other_surcharge) VALUES ('DHL', 0, 0, 0);
      INSERT OR IGNORE INTO courier_settings (courier, fuel_surcharge, gst, other_surcharge) VALUES ('FedEx', 0, 0, 0);
      INSERT OR IGNORE INTO courier_settings (courier, fuel_surcharge, gst, other_surcharge) VALUES ('UPS', 0, 0, 0);
    `);
  } catch (e) {
    console.error('[SEED ERROR]', e);
  }

  // Seed country_master with comprehensive COUNTRIES_LIST using INSERT OR IGNORE
  try {
    const stmt = localDb.prepare('INSERT OR IGNORE INTO country_master (country_code, country_name, normalized_name, iso3_code, aliases_json, is_active) VALUES (?, ?, ?, ?, ?, 1)');
    let inserted = 0;
    for (const c of COUNTRIES_LIST) {
      const info = stmt.run(c.code, c.name, c.name.toLowerCase(), c.iso3, JSON.stringify(c.aliases));
      if (info.changes > 0) {
        inserted++;
      }
    }
    if (inserted > 0) {
      console.log(`Seeded ${inserted} new countries to country_master table (out of ${COUNTRIES_LIST.length}).`);
    }
  } catch (e) {
    console.error('[SEED ERROR] country_master', e);
  }

  // Safe migrations for local SQLite to add new columns if they don't exist
  try { localDb.exec(`ALTER TABLE charges ADD COLUMN disbursement_fee REAL DEFAULT 0`); } catch (e) {}
  try { localDb.exec(`ALTER TABLE charges ADD COLUMN tax_amount REAL DEFAULT 0`); } catch (e) {}
  try { localDb.exec(`ALTER TABLE charges ADD COLUMN other_charges REAL DEFAULT 0`); } catch (e) {}
  try { localDb.exec(`ALTER TABLE charges ADD COLUMN total_charges REAL DEFAULT 0`); } catch (e) {}
  try { localDb.exec(`ALTER TABLE double_billing ADD COLUMN first_amount REAL DEFAULT 0`); } catch (e) {}
  try { localDb.exec(`ALTER TABLE double_billing ADD COLUMN repeat_amount REAL DEFAULT 0`); } catch (e) {}
  try { localDb.exec(`ALTER TABLE double_billing ADD COLUMN difference REAL DEFAULT 0`); } catch (e) {}

  // Add columns to courier_zones
  try { localDb.exec(`ALTER TABLE courier_zones ADD COLUMN package_id TEXT`); } catch (e) {}
  try { localDb.exec(`ALTER TABLE courier_zones ADD COLUMN service TEXT`); } catch (e) {}
  try { localDb.exec(`ALTER TABLE courier_zones ADD COLUMN direction TEXT`); } catch (e) {}
  try { localDb.exec(`ALTER TABLE courier_zones ADD COLUMN country_code TEXT`); } catch (e) {}
  try { localDb.exec(`ALTER TABLE courier_zones ADD COLUMN active INTEGER DEFAULT 1`); } catch (e) {}
  try { localDb.exec(`ALTER TABLE courier_zones ADD COLUMN country_name TEXT`); } catch (e) {}
  try { localDb.exec(`ALTER TABLE courier_zones ADD COLUMN raw_country_value TEXT`); } catch (e) {}

  // Add columns to courier_rates
  try { localDb.exec(`ALTER TABLE courier_rates ADD COLUMN package_id TEXT`); } catch (e) {}
  try { localDb.exec(`ALTER TABLE courier_rates ADD COLUMN service TEXT`); } catch (e) {}
  try { localDb.exec(`ALTER TABLE courier_rates ADD COLUMN direction TEXT`); } catch (e) {}
  try { localDb.exec(`ALTER TABLE courier_rates ADD COLUMN active INTEGER DEFAULT 1`); } catch (e) {}
  try { localDb.exec(`ALTER TABLE customer_fob ADD COLUMN shipping_bill TEXT`); } catch (e) {}

  // Ensure Indexes are created (Do this at the end of schema init, after any migrations and rate_packages table are guaranteed to be created)
  try {
    localDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_shiptax_awb ON shiptax(awb);
      CREATE INDEX IF NOT EXISTS idx_charges_awb ON charges(awb);
      CREATE INDEX IF NOT EXISTS idx_charges_courier ON charges(courier);
      CREATE INDEX IF NOT EXISTS idx_charges_charge_type_key ON charges(charge_type_key);
      CREATE INDEX IF NOT EXISTS idx_charges_final_date ON charges(final_date);
      CREATE INDEX IF NOT EXISTS idx_charges_charge_month ON charges(charge_month);
      CREATE INDEX IF NOT EXISTS idx_customer_fob_awb ON customer_fob(awb);
      CREATE INDEX IF NOT EXISTS idx_courier_zones ON courier_zones(courier, country);
      CREATE INDEX IF NOT EXISTS idx_courier_rates ON courier_rates(courier, shipment_type);
      CREATE INDEX IF NOT EXISTS idx_country_master_code ON country_master(country_code);
      CREATE INDEX IF NOT EXISTS idx_rate_packages_active ON rate_packages(courier, service, direction, status);
      CREATE INDEX IF NOT EXISTS idx_courier_rates_active ON courier_rates(courier, service, direction, active);
    `);
  } catch (e) {
    console.error('[INDEX CREATION ERROR]', e);
  }
}

// Memory-compatible getter wrapper for other endpoints and backup generation
export const memoryDb = {
  get shiptax() {
    return localDb.prepare('SELECT * FROM shiptax').all() as any[];
  },
  get charges() {
    return localDb.prepare('SELECT * FROM charges').all() as any[];
  },
  get double_billing() {
    return localDb.prepare('SELECT * FROM double_billing').all() as any[];
  },
  get review() {
    return localDb.prepare('SELECT * FROM review').all() as any[];
  },
  get uploads() {
    return localDb.prepare('SELECT * FROM uploads').all() as any[];
  },
  get datewise_summary() {
    return localDb.prepare('SELECT * FROM datewise_summary').all() as any[];
  },
  get summary_stats() {
    return localDb.prepare('SELECT * FROM summary_stats LIMIT 1').get() as any;
  },
  get customer_fob() {
    return localDb.prepare('SELECT * FROM customer_fob').all() as any[];
  },
  get courier_settings() {
    return localDb.prepare('SELECT * FROM courier_settings').all() as any[];
  },
  get courier_zones() {
    return localDb.prepare('SELECT * FROM courier_zones').all() as any[];
  },
  get courier_rates() {
    return localDb.prepare('SELECT * FROM courier_rates').all() as any[];
  },
  get country_master() {
    return localDb.prepare('SELECT * FROM country_master').all() as any[];
  }
};

let isLoaded = false;

// Connects to Firestore, and downloads initial database state to local sqlite cache
export async function loadFromTurso(force = false, tablesToLoad?: string[]) {
  initLocalSchema();

  const allTables = ['shiptax', 'charges', 'double_billing', 'review', 'uploads', 'summary_stats', 'datewise_summary', 'customer_fob', 'courier_settings', 'courier_zones', 'courier_rates', 'country_master', 'rate_packages'];
  const targets = tablesToLoad || allTables;
  const toLoad = force ? targets : targets.filter(t => !loadedTables.has(t));

  if (toLoad.length === 0) {
    isLoaded = true;
    return;
  }

  try {
    const client = getTursoClient();

    const allTables = ['shiptax', 'charges', 'double_billing', 'review', 'uploads', 'summary_stats', 'datewise_summary', 'customer_fob', 'courier_settings', 'courier_zones', 'courier_rates', 'country_master', 'rate_packages'];
    
    console.log('[TURSO] Syncing on-demand tables from Turso:', toLoad);

    // Initialize the remote Turso database schema cleanly before querying!
    try {
        await client.executeMultiple(`
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
        `);
    } catch(e) { console.warn('[TURSO] Schema init warning:', e); }
    
    // Fetch all tables in a SINGLE network request to prevent Vercel timeouts!
    const selectStmts = toLoad.map(table => `SELECT * FROM ${table}`);
    let batchResults: any[] = [];
    try {
      batchResults = await client.batch(selectStmts, 'read');
    } catch (batchErr) {
      console.warn('[TURSO SYNC] client.batch failed (maybe some tables missing). Falling back to safe sequential fetch.');
      // Safe fallback: fetch one by one so missing tables don't crash the whole batch
      for (const table of toLoad) {
        try {
          const rs = await client.execute(`SELECT * FROM ${table}`);
          batchResults.push(rs);
        } catch (e) {
          batchResults.push({ rows: [] });
        }
      }
    }

    const results = toLoad.map((table, i) => {
      let allRows: any[] = [];
      if (batchResults[i] && batchResults[i].rows) {
        allRows = batchResults[i].rows;
      }
      return { table, allRows };
    });

    for (const { table, allRows } of results) {
      localDb.exec(`DELETE FROM ${table}`);
      
      if (allRows.length > 0) {
        const columns = Object.keys(allRows[0]);
        const placeholders = columns.map(() => '?').join(', ');
        const insertStmt = localDb.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`);
        
        localDb.transaction(() => {
          for (const row of allRows) {
            const values = columns.map(col => {
              const val = row[col];
              if (val === undefined || val === null) return null;
              if (typeof val === 'boolean') return val ? 1 : 0;
              return val;
            });
            insertStmt.run(...values);
          }
        })();
      }
      loadedTables.add(table);
    }

    // Special logic for canonical country seeding if we loaded country_master
    if (toLoad.includes('country_master')) {
      try {
        const checkStmt = localDb.prepare('SELECT COUNT(*) as count FROM country_master WHERE country_code = ?');
        const stmt = localDb.prepare('INSERT INTO country_master (country_code, country_name, normalized_name, iso3_code, aliases_json, is_active) VALUES (?, ?, ?, ?, ?, 1)');
        let inserted = 0;
        for (const c of COUNTRIES_LIST) {
          const exists = checkStmt.get(c.code) as any;
          if (!exists || exists.count === 0) {
            stmt.run(c.code, c.name, c.name.toLowerCase(), c.iso3, JSON.stringify(c.aliases));
            inserted++;
          }
        }
        if (inserted > 0) {
          console.log(`[TURSO SYNC] Seeded ${inserted} missing countries locally.`);
        }

        // Query Turso count directly to check if we need to synchronize
        try {
            const rs = await client.execute('SELECT COUNT(*) as count FROM country_master');
            let remoteCount = rs.rows.length > 0 ? Number(rs.rows[0].count) : 0;
            if (remoteCount < COUNTRIES_LIST.length) {
              console.log(`[TURSO SYNC] Remote country_master has only ${remoteCount} records. Uploading entire canonical list of ${COUNTRIES_LIST.length} countries...`);
              await saveToTurso(["country_master"]);
            }
        } catch(e) {}

      } catch (seedErr) {
        console.error('[TURSO SYNC] Failed to seed/sync country_master:', seedErr);
      }
    }

    dbStatus = 'Connected';
    lastDbError = null;
    isLoaded = true;
  } catch (err: any) {
    console.warn('[TURSO] Failed to load/connect to database. Falling back to local SQLite cache:', err);
    dbStatus = 'Using temporary cache';
    lastDbError = err.message || String(err);
    // Mark requested tables as loaded so we don't spam errors and can use local DB fallback
    for (const table of toLoad) {
      loadedTables.add(table);
    }
    isLoaded = true;
  }
}

// Recalculates metrics and syncs all changes from local SQLite cache to remote Firestore database
export async function saveToTurso(tablesToSave?: string[]) {
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
        const key = `${fDate}|${row.courier}`;
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
        await client.executeMultiple(`
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
        `);
    } catch(e) { console.warn('[TURSO] Schema init warning:', e); }

    for (const table of tables) {
      const localRows = localDb.prepare(`SELECT * FROM ${table}`).all() as any[];
      
      const stmts = [];
      
      if (localRows.length > 0) {
        const columns = Object.keys(localRows[0]);
        const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
        
        for (const row of localRows) {
          const args = columns.map(col => {
            let val = row[col];
            return val === undefined ? null : val;
          });
          stmts.push({ sql, args });
        }
      }
      
      // Delete the table contents first in a single remote call
      await client.execute(`DELETE FROM ${table}`);
      
      // Push remaining inserts sequentially with a large chunk size to save network roundtrips 
      // (MUST be sequential to prevent SQLITE_BUSY Database Locked errors on Turso)
      const chunkSize = 2000;
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

export function forceEmptyAndLoaded() {
  initLocalSchema();
  const tables = ['shiptax', 'charges', 'double_billing', 'review', 'uploads', 'summary_stats', 'datewise_summary', 'customer_fob', 'courier_settings', 'courier_zones', 'courier_rates', 'country_master', 'rate_packages'];
  loadedTables.clear();
  for (const table of tables) {
    localDb.exec(`DELETE FROM ${table}`);
    loadedTables.add(table);
  }
  localDb.prepare(`INSERT INTO summary_stats (shiptax, charges, double, review, duty) VALUES (0, 0, 0, 0, 0.0)`).run();
  
  // Seed settings back
  try {
    localDb.exec(`
      INSERT OR IGNORE INTO courier_settings (courier, fuel_surcharge, gst, other_surcharge) VALUES ('DHL', 0, 0, 0);
      INSERT OR IGNORE INTO courier_settings (courier, fuel_surcharge, gst, other_surcharge) VALUES ('FedEx', 0, 0, 0);
      INSERT OR IGNORE INTO courier_settings (courier, fuel_surcharge, gst, other_surcharge) VALUES ('UPS', 0, 0, 0);
    `);
  } catch (e) {}

  isLoaded = true;
  rawRowsLoaded = true;
  console.log('[TURSO] Database local cache forced empty.');
}

// No-op compatibility helpers
export async function ensureRawRowsLoaded() {
  return;
}

export async function prefetchShiptaxAwbs(awbs: string[]) {
  return;
}

export function clearTable(table: string) {
  localDb.exec(`DELETE FROM ${table}`);
}

// Automatically initialize local SQLite schema on module load
initLocalSchema();

export async function migrateAndCleanZones() {
  console.log('[MIGRATION] Running country-zone mappings migration and cleanup...');
  const { resolveCountryCode, getCanonicalCountryName } = await import('./services/countryNormalizer.js');
  
  try {
    const rows = localDb.prepare('SELECT * FROM courier_zones').all() as any[];
    
    // We will update each row with country_code, country_name, raw_country_value
    const updateStmt = localDb.prepare(`
      UPDATE courier_zones 
      SET country_code = ?, country_name = ?, raw_country_value = ?, country = ?
      WHERE id = ?
    `);
    
    localDb.transaction(() => {
      for (const row of rows) {
        // original country cell is stored in country
        const rawVal = row.raw_country_value || row.country;
        let isoCode = row.country_code;
        let canonicalName = row.country_name;
        
        if (!isoCode || !canonicalName) {
          try {
            isoCode = resolveCountryCode(rawVal) || '';
            canonicalName = getCanonicalCountryName(isoCode) || '';
          } catch (e) {
            // unresolved
          }
        }
        
        if (isoCode && canonicalName) {
          updateStmt.run(isoCode, canonicalName, rawVal, canonicalName, row.id);
        } else {
          // Fallback to preserve raw
          updateStmt.run(row.country_code || null, row.country_name || null, rawVal, row.country, row.id);
        }
      }
    })();
    
    // Now handle duplicates/conflicts for active mappings
    // Find all active groups of courier, service, direction, country_code
    const activeMappings = localDb.prepare(`
      SELECT courier, service, direction, country_code, COUNT(*) as count 
      FROM courier_zones 
      WHERE active = 1 AND country_code IS NOT NULL AND country_code != ''
      GROUP BY courier, service, direction, country_code
      HAVING COUNT(*) > 1
    `).all() as any[];
    
    if (activeMappings.length > 0) {
      console.log(`[MIGRATION] Found ${activeMappings.length} duplicate active country-zone mappings. Resolving...`);
      for (const m of activeMappings) {
        const instances = localDb.prepare(`
          SELECT * FROM courier_zones 
          WHERE courier = ? AND service = ? AND direction = ? AND country_code = ? AND active = 1
        `).all(m.courier, m.service, m.direction, m.country_code) as any[];
        
        // Compare zones
        const firstZone = instances[0].zone;
        const allSameZone = instances.every(inst => inst.zone === firstZone);
        
        if (allSameZone) {
          // Keep the first one, delete/deactivate others
          const keepId = instances[0].id;
          const deleteStmt = localDb.prepare(`
            DELETE FROM courier_zones 
            WHERE courier = ? AND service = ? AND direction = ? AND country_code = ? AND active = 1 AND id != ?
          `);
          deleteStmt.run(m.courier, m.service, m.direction, m.country_code, keepId);
          console.log(`[MIGRATION] Merged duplicate mappings for ${m.courier} - ${m.country_code} (identical zone: ${firstZone})`);
        } else {
          // Different zones! Flag conflict for admin review
          const keepId = instances[0].id; // Keep first for stability, but log review
          const msg = `Conflict: Multiple zones detected for ${m.courier} ${m.country_code} (${instances.map(i => i.zone).join(', ')}). Admin review required.`;
          console.warn(`[MIGRATION] ${msg}`);
          
          // Insert into review table
          localDb.prepare(`
            INSERT INTO review (reason, courier, awb, source_file, message, created_at)
            VALUES ('Zone Conflict', ?, 'MIGRATION_CONFLICT', 'System Migration', ?, ?)
          `).run(m.courier, msg, new Date().toISOString());
          
          // Deactivate others
          const deactivateStmt = localDb.prepare(`
            UPDATE courier_zones 
            SET active = 0 
            WHERE courier = ? AND service = ? AND direction = ? AND country_code = ? AND id != ?
          `);
          deactivateStmt.run(m.courier, m.service, m.direction, m.country_code, keepId);
        }
      }
    }
    
    console.log('[MIGRATION] country-zone mappings migration and cleanup finished successfully.');
  } catch (err) {
    console.error('[MIGRATION ERROR]', err);
  }
}


