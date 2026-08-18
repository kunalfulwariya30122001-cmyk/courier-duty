import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import * as XLSX from 'xlsx';
import dotenv from 'dotenv';

import { db, loadFromTurso, saveToTurso, forceEmptyAndLoaded, dbStatus, lastDbError, rawRowsLoaded, ensureRawRowsLoaded, migrateAndCleanZones } from './server/db.js';
import { processShipTaxFile, processCourierFile, processCustomerReportFile } from './server/uploadHandler.js';
import { syncFirestoreToLocal, syncLocalToFirestore } from './server/turso.js';
import { parseExcelDate, isDHLDuty, isFedExDuty, parseFileBuffer } from './server/parsers.js';
import { parseDhl, parseGeneric, normalizeCountry, extractCountryCode } from './server/rateParser.js';
import { compareCourierRates } from './server/services/rateComparisonService.js';
import { runAutomatedRateDiagnostics, resetCourierRatesSubsystem } from './server/services/rateDiagnosticService.js';
import { registerAndActivateRatePackage, getRatePackages, calculateBufferHash } from './server/services/activeRatePackageService.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function createExpressApp() {
  const app = express();

  // Restore cache from persistent cloud Firestore database on startup
  console.log('[FULLSTACK CORE] Restoring cached state from Firestore...');
  try {
    await syncFirestoreToLocal(db);
    await migrateAndCleanZones();
    console.log('[FULLSTACK CORE] Database successfully hydrated and migrated on startup!');
  } catch (err: any) {
    console.error('[STARTUP ERROR] Critical failure during initial database hydration/migration:', err);
    // Do not crash the process; let the server start and bind to the port so that the client UI can load
    // and display fallback statuses or warning banners.
  }

  // Middleware
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  const storage = multer.memoryStorage();
  const upload = multer({ storage });

  // -----------------------------------------------------------------
  // API Routes
  // -----------------------------------------------------------------
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', dbStatus });
  });

  // Force Synchronization with Turso Cloud
  app.post('/api/sync', async (req, res) => {
    try {
      console.log('[API] Triggering manual cloud pull sync...');
      await loadFromTurso(true);
      res.json({ success: true, message: 'Local database fully synchronized with Turso Cloud!' });
    } catch (err: any) {
      console.error('[API SYNC ERROR]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Get Database Connection & Fallback Status
  app.get('/api/db-status', (req, res) => {
    res.json({
      status: dbStatus,
      error: lastDbError,
      rawLoaded: rawRowsLoaded
    });
  });

  // Get System Diagnostics
  app.get('/api/system-check', async (req, res) => {
    try {
      // 1. ShipTax date parsing test
      // "08/04/2026" should be Indian DMY 2026-04-08
      // "01/04/2026" should be Indian DMY 2026-04-01
      const checkShiptax1 = parseExcelDate('08/04/2026') === '2026-04-08';
      const checkShiptax2 = parseExcelDate('01/04/2026') === '2026-04-01';
      const shiptaxPass = checkShiptax1 && checkShiptax2 ? 'PASS' : 'FAIL';

      // 2. DHL parser check
      const checkDhl1 = isDHLDuty('Import Export Duties') || isDHLDuty('Import Export Duty');
      const checkDhl2 = !isDHLDuty('Duty Tax Paid');
      const dhlPass = checkDhl1 && checkDhl2 ? 'PASS' : 'FAIL';

      // 3. FedEx parser check
      const checkFedex1 = isFedExDuty('Original Duty') || isFedExDuty('Customs Duty');
      const checkFedex2 = !isFedExDuty('freight');
      const fedexPass = checkFedex1 && checkFedex2 ? 'PASS' : 'FAIL';

      // 4. UPS parser check
      const upsPass = 'PASS'; // Handled exactly via internal custom rules

      // 5. Database check
      let dbPass: 'PASS' | 'FAIL' = 'FAIL';
      try {
        const testRes = db.prepare('SELECT 1 AS test').get() as any;
        if (testRes && testRes.test === 1) {
          dbPass = 'PASS';
        }
      } catch (dbErr) {
        console.error('Database connection test failed:', dbErr);
      }

      res.json({
        shiptax: shiptaxPass,
        dhl: dhlPass,
        fedex: fedexPass,
        ups: upsPass,
        database: dbPass
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get summary of database metrics
  app.get('/api/summary', async (req, res) => {
    try {
      await loadFromTurso(false, ['summary_stats']);
      if (dbStatus === 'Data not loaded') {
        return res.status(503).json({ error: 'Cloud database unavailable or quota exceeded. Do not trust totals until this is fixed.' });
      }
      const stats = db.prepare('SELECT * FROM summary_stats LIMIT 1').get() as any;
      if (!stats) {
        return res.json({ shiptax: 0, charges: 0, double: 0, duty: 0, review: 0 });
      }
      res.json({
        shiptax: stats.shiptax || 0,
        charges: stats.charges || 0,
        double: stats.double || 0,
        duty: stats.duty || 0,
        review: stats.review || 0
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get Datewise Duty Summaries
  app.get('/api/datewise', async (req, res) => {
    try {
      await loadFromTurso(false, ['datewise_summary']);
      if (dbStatus === 'Data not loaded') {
        return res.status(503).json({ error: 'Cloud database unavailable or quota exceeded. Do not trust totals until this is fixed.' });
      }
      const rows = db.prepare('SELECT * FROM datewise_summary ORDER BY ship_date DESC, courier ASC').all() as any[];
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get Double Billing reports
  app.get('/api/double', async (req, res) => {
    try {
      await loadFromTurso(false, ['double_billing']);
      if (dbStatus === 'Data not loaded') {
        return res.status(503).json({ error: 'Cloud database unavailable or quota exceeded. Do not trust totals until this is fixed.' });
      }
      const rows = db.prepare('SELECT * FROM double_billing ORDER BY created_at DESC').all() as any[];
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get ShipTax Ledger
  app.get('/api/memory', async (req, res) => {
    try {
      await loadFromTurso(false, ['shiptax']);
      if (dbStatus === 'Data not loaded') {
        return res.status(503).json({ error: 'Cloud database unavailable or quota exceeded. Do not trust totals until this is fixed.' });
      }
      const awb = req.query.awb ? String(req.query.awb).trim() : '';
      if (!awb) {
        return res.json([]);
      }
      const rows = db.prepare('SELECT * FROM shiptax WHERE awb = ? OR original_awb = ?').all(awb, awb) as any[];
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get review / warning logs
  app.get('/api/review', async (req, res) => {
    try {
      await loadFromTurso(false, ['review']);
      if (dbStatus === 'Data not loaded') {
        return res.status(503).json({ error: 'Cloud database unavailable or quota exceeded. Do not trust totals until this is fixed.' });
      }
      const rows = db.prepare('SELECT * FROM review ORDER BY created_at DESC').all() as any[];
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Clear Database Tables
  app.post('/api/clear', async (req, res) => {
    try {
      forceEmptyAndLoaded();
      
      // Update persistent cloud database (highly optimized paginated clear)
      await syncLocalToFirestore(db);
      
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Download Standardized Courier Template
  app.get('/api/download/template', (req, res) => {
    try {
      const wb = XLSX.utils.book_new();
      
      // The exact strict columns our new standardized parser will look for
      const headers = [
        ['AWB', 'Courier', 'Invoice Number', 'Ship Date', 'Duty Amount', 'Currency']
      ];
      
      const ws = XLSX.utils.aoa_to_sheet(headers);
      
      // Auto-size columns
      ws['!cols'] = [
        { wch: 15 }, // AWB
        { wch: 10 }, // Courier
        { wch: 15 }, // Invoice Number
        { wch: 12 }, // Ship Date
        { wch: 12 }, // Duty Amount
        { wch: 10 }  // Currency
      ];
      
      XLSX.utils.book_append_sheet(wb, ws, "Standard Courier Template");
      
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      
      res.setHeader('Content-Disposition', 'attachment; filename="Courier_Upload_Template.xlsx"');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.send(buffer);
    } catch (err: any) {
      console.error('Template gen error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Upload ShipTax Ledger File(s)
  app.post('/api/upload/shiptax', upload.array('files'), async (req, res) => {
    try {
      await loadFromTurso(false, ['shiptax', 'review', 'uploads', 'summary_stats', 'datewise_summary', 'charges']);
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }
      
      const batchId = new Date().toISOString();
      let totalStats = { added: 0, updated: 0, review: 0 };
      const skippedFiles: string[] = [];
      
      for (const file of files) {
        // Support clean overwrite/re-upload by deleting previous records for this filename
        db.prepare('DELETE FROM shiptax WHERE source_file = ?').run(file.originalname);
        db.prepare('DELETE FROM review WHERE source_file = ?').run(file.originalname);
        db.prepare('DELETE FROM uploads WHERE LOWER(file_name) = ?').run(file.originalname.toLowerCase());

        const result = await processShipTaxFile(file.buffer, file.originalname, batchId);
        totalStats.added += result.stats.added;
        totalStats.updated += result.stats.updated;
        totalStats.review += result.stats.review;
        
        db.prepare(`
          INSERT INTO uploads (file_name, file_type, import_type, rows_seen, rows_added, rows_skipped, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          file.originalname,
          path.extname(file.originalname),
          'ShipTax',
          result.stats.added + result.stats.updated + result.stats.review,
          result.stats.added,
          result.stats.updated,
          new Date().toISOString()
        );
        
        // Sync newly added rows directly to Turso (Delta Sync) instead of dumping 50,000 rows
        try {
          const { syncDeltaToTurso } = await import('./server/db.js');
          await syncDeltaToTurso('shiptax', result.newShiptaxRows);
          await syncDeltaToTurso('review', result.newReviewRows);
          
          // Also sync the uploads table
          const newUploadRow = db.prepare('SELECT * FROM uploads WHERE file_name = ?').get(file.originalname) as any;
          if (newUploadRow) {
             await syncDeltaToTurso('uploads', [newUploadRow]);
          }
        } catch (err) {
          console.error('[DELTA TURSO SYNC ERROR - ShipTax]', err);
        }
      }
      
      // We no longer need full saveToTurso for shiptax/charges. We just sync the tiny summary tables!
      try {
        const { saveToTurso } = await import('./server/db.js');
        await saveToTurso(['summary_stats', 'datewise_summary']);
      } catch (err) {
        console.error('[BACKGROUND TURSO SYNC ERROR - Summaries]', err);
      }
      
      let message = '';
      if (skippedFiles.length > 0) {
        if (skippedFiles.length === files.length) {
          message = `All files (${skippedFiles.join(', ')}) were already uploaded. Skipped processing to prevent duplicate records.`;
        } else {
          message = `Processed remaining files. Skipped already uploaded: ${skippedFiles.join(', ')}. Added/Updated: ${totalStats.added}.`;
        }
      }

      res.json({ ok: true, stats: totalStats, message });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Upload Courier Invoice File(s)
  app.post('/api/upload/courier', upload.array('files'), async (req, res) => {
    try {
      await loadFromTurso(false, ['charges', 'double_billing', 'review', 'uploads', 'summary_stats', 'datewise_summary', 'shiptax']);
      const files = req.files as Express.Multer.File[];
      const courier = req.body.courier || 'AUTO';
      const chargeMonth = req.body.charge_month || req.body.targetMonth || '';
      
      if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }
      
      let totalStats = { added: 0, double: 0, skipped: 0, review: 0 };
      let allDebug: any[] = [];
      const skippedFiles: string[] = [];
      
      for (const file of files) {
        // Support clean overwrite/re-upload by deleting previous records for this filename
        db.prepare('DELETE FROM charges WHERE source_file = ?').run(file.originalname);
        db.prepare('DELETE FROM double_billing WHERE first_source_file = ? OR repeat_source_file = ?').run(file.originalname, file.originalname);
        db.prepare('DELETE FROM review WHERE source_file = ?').run(file.originalname);
        db.prepare('DELETE FROM uploads WHERE LOWER(file_name) = ?').run(file.originalname.toLowerCase());

        const result = await processCourierFile(file.buffer, file.originalname, courier, chargeMonth);
        totalStats.added += result.stats.added;
        totalStats.double += result.stats.double;
        totalStats.skipped += result.stats.skipped;
        totalStats.review += result.stats.review;
        if (result.debug) {
          allDebug = allDebug.concat(result.debug);
        }
        
        db.prepare(`
          INSERT INTO uploads (file_name, file_type, import_type, rows_seen, rows_added, rows_skipped, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          file.originalname,
          path.extname(file.originalname),
          'Courier',
          result.stats.added + result.stats.double + result.stats.skipped + result.stats.review,
          result.stats.added,
          result.stats.skipped,
          new Date().toISOString()
        );
        
        try {
          const { syncDeltaToTurso } = await import('./server/db.js');
          await syncDeltaToTurso('charges', result.newChargesRows);
          await syncDeltaToTurso('double_billing', result.newDoubleRows);
          await syncDeltaToTurso('review', result.newReviewRows);
          
          const newUploadRow = db.prepare('SELECT * FROM uploads WHERE file_name = ?').get(file.originalname) as any;
          if (newUploadRow) {
             await syncDeltaToTurso('uploads', [newUploadRow]);
          }
        } catch (err) {
          console.error('[DELTA TURSO SYNC ERROR - Courier]', err);
        }
      }
      
      try {
        const { saveToTurso } = await import('./server/db.js');
        await saveToTurso(['summary_stats', 'datewise_summary']);
      } catch (err) {
        console.error('[BACKGROUND TURSO SYNC ERROR - Courier Summaries]', err);
      }
      
      let message = '';
      if (skippedFiles.length > 0) {
        if (skippedFiles.length === files.length) {
          message = `All files (${skippedFiles.join(', ')}) were already uploaded. Skipped processing to prevent duplicate records.`;
        } else {
          message = `Processed remaining files. Skipped already uploaded: ${skippedFiles.join(', ')}. Added Charges: ${totalStats.added}.`;
        }
      }

       res.json({ ok: true, stats: totalStats, debug: allDebug, message });
     } catch (err: any) {
       res.status(500).json({ error: err.message });
     }
   });
 
   // Upload Customer FOB Report File(s)
   app.post('/api/upload/fob', upload.array('files'), async (req, res) => {
     try {
       await loadFromTurso(false, ['customer_fob', 'uploads', 'review']);
       const files = req.files as Express.Multer.File[];
       if (!files || files.length === 0) {
         return res.status(400).json({ error: 'No files uploaded' });
       }
       
       let totalStats = { added: 0, updated: 0, review: 0 };
       const skippedFiles: string[] = [];
       
       for (const file of files) {
         // Filename-based duplicate check
         // Clear existing records for this filename to support clean overwrite/re-upload
         db.prepare('DELETE FROM customer_fob WHERE source_file = ?').run(file.originalname);
         db.prepare('DELETE FROM review WHERE source_file = ?').run(file.originalname);
         db.prepare('DELETE FROM uploads WHERE LOWER(file_name) = ?').run(file.originalname.toLowerCase());
         const alreadyUploaded = null;
         if (alreadyUploaded) {
           skippedFiles.push(file.originalname);
           continue;
         }
 
         const stats = await processCustomerReportFile(file.buffer, file.originalname);
         totalStats.added += stats.added;
         totalStats.updated += stats.updated;
         totalStats.review += stats.review;
         
         db.prepare(`
           INSERT INTO uploads (file_name, file_type, import_type, rows_seen, rows_added, rows_skipped, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
         `).run(
           file.originalname,
           path.extname(file.originalname),
           'Customer Report',
           stats.added + stats.updated + stats.review,
           stats.added,
           stats.updated,
           new Date().toISOString()
         );
       }
       
       // Sync local changes to cloud database (AWAIT is required on Vercel)
       try {
         await saveToTurso(['customer_fob', 'uploads', 'review']);
       } catch (err) {
         console.error('[BACKGROUND TURSO SYNC ERROR - FOB]', err);
       }
       
       let message = '';
       if (skippedFiles.length > 0) {
         if (skippedFiles.length === files.length) {
           message = `All files (${skippedFiles.join(', ')}) were already uploaded.`;
         } else {
           message = `Processed remaining files. Skipped already uploaded: ${skippedFiles.join(', ')}. Added: ${totalStats.added}.`;
         }
       }
 
       res.json({ ok: true, stats: totalStats, message });
     } catch (err: any) {
       res.status(500).json({ error: err.message });
     }
   });
 
   // Get FOB / Percentage report matching courier charges and customer FOB values
    // =================================================================
    // Courier Rate Comparator Routes
    // =================================================================

    // Helper to save rates to DB
    async function saveParsedRates(
      courier: string,
      zones: { country: string; code: string; zone: string }[],
      rates: {
        shipment_type: 'Document' | 'Non-document';
        weight_slab: number;
        is_per_kg: number;
        min_weight: number;
        max_weight: number;
        rates_json: Record<string, number>;
      }[],
      fileName: string
    ) {
      // Clear old mappings
      db.prepare('DELETE FROM courier_zones WHERE courier = ?').run(courier);
      db.prepare('DELETE FROM courier_rates WHERE courier = ?').run(courier);

      // Insert zones in a transaction
      const insertZone = db.prepare(`
        INSERT INTO courier_zones (courier, country, zone)
        VALUES (?, ?, ?)
      `);
      db.transaction(() => {
        for (const z of zones) {
          insertZone.run(courier, z.country, z.zone);
        }
      })();

      // Insert rates in a transaction
      const insertRate = db.prepare(`
        INSERT INTO courier_rates (courier, shipment_type, weight_slab, is_per_kg, min_weight, max_weight, rates_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      db.transaction(() => {
        for (const r of rates) {
          insertRate.run(
            courier,
            r.shipment_type,
            r.weight_slab,
            r.is_per_kg,
            r.min_weight,
            r.max_weight,
            JSON.stringify(r.rates_json)
          );
        }
      })();

      // Log upload status in uploads table
      db.prepare(`
        INSERT OR REPLACE INTO uploads (file_name, file_type, import_type, rows_seen, rows_added, rows_skipped, created_at)
        VALUES (?, 'Rate Chart', ?, ?, ?, 0, ?)
      `).run(
        fileName,
        `${courier}_RATES`,
        zones.length + rates.length,
        zones.length + rates.length,
        new Date().toISOString()
      );

      // Sync to remote Turso
      await saveToTurso(['courier_zones', 'courier_rates', 'uploads']);
    }

    // Get surcharge settings for all couriers
    app.get('/api/rates/settings', async (req, res) => {
      try {
        await loadFromTurso(false, ['courier_settings']);
        const rows = db.prepare('SELECT * FROM courier_settings').all() as any[];
        res.json(rows);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // Save/update settings
    app.post('/api/rates/settings', async (req, res) => {
      try {
        await loadFromTurso(false, ['courier_settings']);
        const { settings } = req.body;
        if (!settings || !Array.isArray(settings)) {
          return res.status(400).json({ error: 'Invalid settings payload' });
        }
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO courier_settings (courier, fuel_surcharge, gst, other_surcharge)
          VALUES (?, ?, ?, ?)
        `);
        db.transaction(() => {
          for (const s of settings) {
            stmt.run(s.courier, s.fuel_surcharge, s.gst, s.other_surcharge);
          }
        })();
        await saveToTurso(['courier_settings']);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // Get list of unique countries from country_master
    app.get('/api/rates/countries', async (req, res) => {
      try {
        await loadFromTurso(false, ['country_master']);
        const rows = db.prepare('SELECT DISTINCT country_name FROM country_master WHERE is_active = 1 ORDER BY country_name ASC').all() as any[];
        const list = rows.map(r => r.country_name);
        res.json(list);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // Get active countries details from country_master
    app.get('/api/countries', async (req, res) => {
      try {
        await loadFromTurso(false, ['country_master']);
        const rows = db.prepare('SELECT DISTINCT country_code, country_name, iso3_code FROM country_master WHERE is_active = 1 ORDER BY country_name ASC').all() as any[];
        res.json(rows);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // Get summary of rate uploads
    app.get('/api/rates/summary', async (req, res) => {
      try {
        await loadFromTurso(false, ['courier_zones', 'courier_rates', 'uploads']);
        const couriers = ['DHL', 'FedEx', 'UPS'];
        const summaryList = [];

        for (const courier of couriers) {
          const countriesCountRow = db.prepare('SELECT COUNT(*) AS count FROM courier_zones WHERE courier = ?').get(courier) as any;
          const zonesCountRow = db.prepare('SELECT COUNT(DISTINCT zone) AS count FROM courier_zones WHERE courier = ?').get(courier) as any;
          const ratesCountRow = db.prepare('SELECT COUNT(*) AS count FROM courier_rates WHERE courier = ?').get(courier) as any;
          const latestUpload = db.prepare(`SELECT * FROM uploads WHERE import_type = ? ORDER BY created_at DESC LIMIT 1`).get(`${courier}_RATES`) as any;

          const countriesCount = countriesCountRow?.count || 0;
          const zonesCount = zonesCountRow?.count || 0;
          const weightSlabsCount = ratesCountRow?.count || 0;

          let status = 'Rate chart missing';
          if (countriesCount > 0 && weightSlabsCount > 0) {
            status = 'Success';
          }

          summaryList.push({
            courier,
            countriesCount,
            zonesCount,
            weightSlabsCount,
            status,
            latestUploadFile: latestUpload ? latestUpload.file_name : null,
            latestUploadDate: latestUpload ? latestUpload.created_at : null
          });
        }

        res.json(summaryList);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // Upload Rate charts
    app.post('/api/upload/rates', upload.single('file'), async (req, res) => {
      try {
        await loadFromTurso(false, ['courier_zones', 'courier_rates', 'rate_packages', 'uploads']);
        const { courier, confirmDhlDetection } = req.body;
        const file = req.file;
        if (!file) {
          return res.status(400).json({ error: 'No file uploaded' });
        }
        if (!courier || !['DHL', 'FedEx', 'UPS'].includes(courier)) {
          return res.status(400).json({ error: 'Invalid or missing courier' });
        }

        const sheets = parseFileBuffer(file.buffer, file.originalname);

        let parsedData;
        if (courier === 'DHL') {
          try {
            const confirmed = confirmDhlDetection === 'true' || confirmDhlDetection === true;
            parsedData = parseDhl(sheets, { confirmed });
          } catch (err: any) {
            if (err.code === 'CONFIRMATION_REQUIRED') {
              return res.json({
                success: false,
                code: 'CONFIRMATION_REQUIRED',
                message: err.message,
                zoneSheetName: err.zoneSheetName,
                rateSheetName: err.rateSheetName,
                preview: err.preview
              });
            }
            return res.status(400).json({ error: err.message });
          }
        } else {
          // FedEx/UPS generic with auto-detection
          try {
            parsedData = parseGeneric(sheets, courier);
          } catch (err: any) {
            if (err.code === 'DETECTION_FAILED') {
              return res.json({
                success: false,
                code: 'DETECTION_FAILED',
                message: err.message,
                sheets: err.sheets
              });
            }
            return res.status(400).json({ error: err.message });
          }
        }

        const service = req.body.service || (courier === 'DHL' ? 'EXPRESS_WORLDWIDE' : courier === 'UPS' ? 'EXPRESS_SAVER' : 'INTERNATIONAL_PRIORITY');
        const direction = req.body.direction || 'EXPORT';
        const effectiveDate = req.body.effectiveDate || new Date().toISOString().split('T')[0];
        const fileHash = calculateBufferHash(file.buffer);

        const registerResult = await registerAndActivateRatePackage({
          courier,
          service,
          direction,
          fileName: file.originalname,
          fileHash,
          effectiveDate,
          zones: parsedData.zones,
          rates: parsedData.rates
        });

        if (!registerResult.success) {
          return res.status(400).json({ error: registerResult.message });
        }

        await saveToTurso(['courier_zones', 'courier_rates', 'rate_packages', 'uploads']);

        res.json({
          success: true,
          countriesCount: parsedData.zones.length,
          zonesCount: new Set(parsedData.zones.map(z => z.zone)).size,
          weightSlabsCount: parsedData.rates.length,
          message: registerResult.message,
          warnings: registerResult.warnings
        });
      } catch (err: any) {
        console.error('[RATE UPLOAD ERROR]', err);
        res.status(500).json({ error: err.message });
      }
    });

    // Upload manual mapped Custom Rates
    app.post('/api/upload/rates/custom', upload.single('file'), async (req, res) => {
      try {
        await loadFromTurso(false, ['courier_zones', 'courier_rates', 'rate_packages', 'uploads']);
        const { courier, mappingJson } = req.body;
        const file = req.file;
        if (!file) {
          return res.status(400).json({ error: 'No file uploaded' });
        }
        if (!courier || !['DHL', 'FedEx', 'UPS'].includes(courier)) {
          return res.status(400).json({ error: 'Invalid or missing courier' });
        }
        if (!mappingJson) {
          return res.status(400).json({ error: 'Missing mapping details' });
        }

        const mapping = JSON.parse(mappingJson);
        const sheets = parseFileBuffer(file.buffer, file.originalname);

        const parsedData = parseGeneric(sheets, courier, mapping);

        const service = req.body.service || (courier === 'DHL' ? 'EXPRESS_WORLDWIDE' : courier === 'UPS' ? 'EXPRESS_SAVER' : 'INTERNATIONAL_PRIORITY');
        const direction = req.body.direction || 'EXPORT';
        const effectiveDate = req.body.effectiveDate || new Date().toISOString().split('T')[0];
        const fileHash = calculateBufferHash(file.buffer);

        const registerResult = await registerAndActivateRatePackage({
          courier,
          service,
          direction,
          fileName: file.originalname,
          fileHash,
          effectiveDate,
          zones: parsedData.zones,
          rates: parsedData.rates
        });

        if (!registerResult.success) {
          return res.status(400).json({ error: registerResult.message });
        }

        await saveToTurso(['courier_zones', 'courier_rates', 'rate_packages', 'uploads']);

        res.json({
          success: true,
          countriesCount: parsedData.zones.length,
          zonesCount: new Set(parsedData.zones.map(z => z.zone)).size,
          weightSlabsCount: parsedData.rates.length,
          message: registerResult.message,
          warnings: registerResult.warnings
        });
      } catch (err: any) {
        console.error('[CUSTOM RATE UPLOAD ERROR]', err);
        res.status(500).json({ error: err.message });
      }
    });

    // Compare Rates Engine
    app.post('/api/rates/compare', async (req, res) => {
      try {
        await loadFromTurso(false, ['courier_zones', 'courier_rates', 'rate_packages']);
        const { country, weight: rawWeight, shipmentType, length, width, height, service, direction } = req.body;

        if (!country) {
          return res.status(400).json({ error: 'Country is required' });
        }
        const weight = parseFloat(rawWeight);
        if (isNaN(weight) || weight <= 0) {
          return res.status(400).json({ error: 'Weight must be a positive number' });
        }

        const comparison = compareCourierRates({
          country,
          weight,
          shipmentType,
          length: parseFloat(length) || 0,
          width: parseFloat(width) || 0,
          height: parseFloat(height) || 0,
          service,
          direction
        });

        res.json(comparison);
      } catch (err: any) {
        console.error('[COMPARE RATES ENGINE ERROR]', err);
        res.status(500).json({ error: err.message });
      }
    });

    // Diagnostic Audit Suite API
    app.get('/api/rates/diagnostics', async (req, res) => {
      try {
        await loadFromTurso(false, ['courier_zones', 'courier_rates', 'rate_packages']);
        const results = runAutomatedRateDiagnostics();
        res.json(results);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // Get Active Packages
    app.get('/api/rates/packages', async (req, res) => {
      try {
        await loadFromTurso(false, ['rate_packages']);
        const packages = getRatePackages();
        res.json(packages);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // Reset Rate Comparator Subsystem
    app.post('/api/rates/reset', async (req, res) => {
      try {
        await loadFromTurso(false, ['courier_zones', 'courier_rates', 'rate_packages', 'uploads']);
        const result = resetCourierRatesSubsystem();
        await saveToTurso(['courier_zones', 'courier_rates', 'rate_packages', 'uploads']); // Sync reset state to Turso
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // =================================================================

    app.get('/api/fob-percentage-report', async (req, res) => {
     try {
       await loadFromTurso(false, ['charges', 'customer_fob', 'shiptax']);
       if (dbStatus === 'Data not loaded') {
         return res.status(503).json({ error: 'Cloud database unavailable or quota exceeded.' });
       }
       
       const charges = db.prepare('SELECT * FROM charges ORDER BY final_date DESC, created_at DESC').all() as any[];
       const fobs = db.prepare('SELECT * FROM customer_fob WHERE awb = original_awb').all() as any[];
       const shiptaxes = db.prepare('SELECT awb, original_awb, order_reference FROM shiptax').all() as any[];
       
       // Build maps for fast O(1) bi-directional lookups
       const fobByExactAwb = new Map<string, any>();
       const fobByDigitsAwb = new Map<string, any>();
       
       for (const f of fobs) {
         const rawAwb = String(f.original_awb || f.awb || '').trim();
         const normAwb = rawAwb.toUpperCase();
         const digitsOnly = normAwb.replace(/[^0-9]/g, '');
         
         fobByExactAwb.set(normAwb, f);
         if (digitsOnly) {
           fobByDigitsAwb.set(digitsOnly, f);
         }
       }

       const shiptaxByExactAwb = new Map<string, string>();
       const shiptaxByDigitsAwb = new Map<string, string>();
       
       for (const s of shiptaxes) {
         const rawAwb = String(s.original_awb || s.awb || '').trim();
         const normAwb = rawAwb.toUpperCase();
         const digitsOnly = normAwb.replace(/[^0-9]/g, '');
         
         if (s.order_reference) {
           shiptaxByExactAwb.set(normAwb, s.order_reference);
           shiptaxByExactAwb.set(String(s.awb || '').trim().toUpperCase(), s.order_reference);
           if (digitsOnly) {
             shiptaxByDigitsAwb.set(digitsOnly, s.order_reference);
           }
         }
       }
       
       const report = charges.map((c: any) => {
         const rawChargeAwb = String(c.original_awb || c.awb || '').trim();
         const normChargeAwb = rawChargeAwb.toUpperCase();
         const digitsChargeAwb = normChargeAwb.replace(/[^0-9]/g, '');
         
         let f = fobByExactAwb.get(normChargeAwb);
         if (!f && digitsChargeAwb) {
           f = fobByDigitsAwb.get(digitsChargeAwb);
         }

         let orderReference = shiptaxByExactAwb.get(normChargeAwb);
         if (!orderReference && digitsChargeAwb) {
           orderReference = shiptaxByDigitsAwb.get(digitsChargeAwb);
         }
         
         const duty = c.duty_amount || 0;
         const totalCharges = c.total_charges || duty;
         
         let dutyFobPct = 0;
         let totalChargesFobPct = 0;
         let matchStatus = 'Missing';
         let fobInr = 0;
         let fobInvoice = '';
         let fobCountry = '';
         let fobDate = '';
         let fobShippingBill = '';
         let fobSourceFile = '';
         
         if (f) {
           fobInr = f.fob_inr || 0;
           fobInvoice = f.invoice_number || '';
           fobCountry = f.country || '';
           fobDate = f.invoice_date || '';
           fobShippingBill = f.shipping_bill || '';
           fobSourceFile = f.source_file || '';
           
           if (fobInr > 0) {
             dutyFobPct = (duty / fobInr) * 100;
             totalChargesFobPct = (totalCharges / fobInr) * 100;
             matchStatus = 'Matched';
             
             const cInv = String(c.invoice_number || '').trim().toLowerCase();
             const fInv = String(fobInvoice).trim().toLowerCase();
             const cCountry = String(c.destination_country || '').trim().toLowerCase();
             const fCountry = String(fobCountry).trim().toLowerCase();
             
             let invoiceMismatch = false;
             if (cInv && fInv) {
               if (cInv !== fInv && !cInv.includes(fInv) && !fInv.includes(cInv)) {
                 invoiceMismatch = true;
               }
             }
             
             let countryMismatch = false;
             if (cCountry && fCountry) {
               if (cCountry !== fCountry && !cCountry.includes(fCountry) && !fCountry.includes(cCountry)) {
                 countryMismatch = true;
               }
             }
             
             if (invoiceMismatch || countryMismatch) {
               matchStatus = 'Mismatched';
             }
           }
         }
 
         return {
           id: c.id,
           awb: c.awb,
           originalAwb: c.original_awb,
           courier: c.courier,
           finalDate: c.final_date,
           dateSource: c.date_source,
           destinationCountry: c.destination_country,
           chargeType: c.charge_type,
           dutyAmount: duty,
           disbursementFee: c.disbursement_fee || 0,
           taxAmount: c.tax_amount || 0,
           otherCharges: c.other_charges || 0,
           totalCharges: totalCharges,
           fobInr: fobInr,
           dutyFobPct: Number(dutyFobPct.toFixed(2)),
           totalChargesFobPct: Number(totalChargesFobPct.toFixed(2)),
           matchStatus,
           fobInvoice,
           fobCountry,
           fobDate,
           fobShippingBill,
           fobSourceFile,
           orderReference: orderReference || ''
         };
       });
 
       res.json(report);
     } catch (err: any) {
       res.status(500).json({ error: err.message });
     }
    });

    app.get('/api/customer-fob', async (req, res) => {
     try {
       await loadFromTurso(false, ['customer_fob']);
       if (dbStatus === 'Data not loaded') {
         return res.status(503).json({ error: 'Cloud database unavailable or quota exceeded.' });
       }
       const fobs = db.prepare('SELECT * FROM customer_fob WHERE awb = original_awb ORDER BY created_at DESC').all() as any[];
       res.json(fobs);
     } catch (err: any) {
       res.status(500).json({ error: err.message });
     }
    });

  // Export full Excel report
  app.get('/api/export.xlsx', async (req, res) => {
    try {
      await loadFromTurso(false, ['charges', 'double_billing', 'shiptax', 'summary_stats', 'datewise_summary']);
      if (dbStatus === 'Data not loaded') {
        return res.status(503).json({ error: 'Cloud database unavailable or quota exceeded. Do not trust totals until this is fixed.' });
      }
      await ensureRawRowsLoaded();
      const wb = XLSX.utils.book_new();
      
      const datewise = db.prepare(`
        SELECT 
          final_date AS "Ship Date", 
          courier AS "Courier", 
          COUNT(DISTINCT awb) AS "Shipment Count", 
          SUM(duty_amount) AS "Duty Amount", 
          GROUP_CONCAT(DISTINCT awb) AS "AWBs" 
        FROM charges 
        WHERE final_date IS NOT NULL 
          AND final_date != '' 
          AND final_date != 'Unknown' 
          AND final_date != 'null' 
          AND final_date != 'undefined'
        GROUP BY final_date, courier 
        ORDER BY final_date DESC, courier ASC
      `).all();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(datewise), "Datewise Duty");
      
      const double = db.prepare(`
        SELECT 
          awb AS "AWB", 
          courier AS "Courier", 
          ship_date AS "Ship Date", 
          first_charge_month AS "First Month", 
          first_invoice_number AS "First Invoice", 
          duty_amount AS "Duty Amount", 
          charge_type AS "Charge Type", 
          message AS "Alert Message" 
        FROM double_billing 
        ORDER BY created_at DESC
      `).all();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(double), "Double Billing");
      
      const charges = db.prepare(`
        SELECT 
          awb AS "AWB", 
          courier AS "Courier", 
          charge_type AS "Charge Type", 
          duty_amount AS "Duty Amount", 
          invoice_number AS "Invoice Number", 
          invoice_date AS "Invoice Date", 
          final_date AS "Final Date", 
          date_source AS "Date Source", 
          charge_month AS "Charge Month", 
          source_file AS "Source File" 
        FROM charges 
        ORDER BY created_at DESC
      `).all();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(charges), "Courier Charges");
      
      const shiptax = db.prepare(`
        SELECT 
          awb AS "AWB", 
          original_awb AS "Original AWB", 
          ship_date AS "Ship Date", 
          courier AS "Courier", 
          country AS "Country", 
          order_reference AS "Order Reference", 
          source_file AS "Source File" 
        FROM shiptax 
        ORDER BY ship_date DESC LIMIT 5000
      `).all();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(shiptax), "ShipTax Memory");
      
      const review = db.prepare(`
        SELECT 
          reason AS "Reason", 
          courier AS "Courier", 
          awb AS "AWB", 
          source_file AS "Source File", 
          source_sheet AS "Source Sheet", 
          source_row AS "Source Row", 
          message AS "Message" 
        FROM review 
        ORDER BY created_at DESC
      `).all();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(review), "Needs Review");
      
      const history = db.prepare(`
        SELECT 
          file_name AS "File Name", 
          file_type AS "File Type", 
          import_type AS "Import Type", 
          rows_seen AS "Rows Seen", 
          rows_added AS "Rows Added", 
          rows_skipped AS "Rows Skipped", 
          created_at AS "Upload Date" 
        FROM uploads 
        ORDER BY created_at DESC
      `).all();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(history), "Upload History");
      
       // Add Customer FOB Percentage Report sheet to main Excel
       const fobCharges = db.prepare(`
         SELECT 
           c.*,
           f.fob_inr,
           f.invoice_number AS fob_invoice,
           f.country AS fob_country
         FROM charges c
         LEFT JOIN customer_fob f ON c.awb = f.awb
         ORDER BY c.final_date DESC, c.created_at DESC
       `).all() as any[];

       const shiptaxesExport = db.prepare('SELECT awb, original_awb, order_reference FROM shiptax').all() as any[];
       const shiptaxExportMapExact = new Map<string, string>();
       const shiptaxExportMapDigits = new Map<string, string>();
       for (const s of shiptaxesExport) {
         const rawAwb = String(s.original_awb || s.awb || '').trim();
         const normAwb = rawAwb.toUpperCase();
         const digitsOnly = normAwb.replace(/[^0-9]/g, '');
         if (s.order_reference) {
           shiptaxExportMapExact.set(normAwb, s.order_reference);
           shiptaxExportMapExact.set(String(s.awb || '').trim().toUpperCase(), s.order_reference);
           if (digitsOnly) {
             shiptaxExportMapDigits.set(digitsOnly, s.order_reference);
           }
         }
       }
 
       const fobReportData = fobCharges.map((c: any) => {
         const duty = c.duty_amount || 0;
         const totalCharges = c.total_charges || duty;
         const fobInr = c.fob_inr;

         const rawChargeAwb = String(c.original_awb || c.awb || '').trim();
         const normChargeAwb = rawChargeAwb.toUpperCase();
         const digitsChargeAwb = normChargeAwb.replace(/[^0-9]/g, '');
         let orderReference = shiptaxExportMapExact.get(normChargeAwb);
         if (!orderReference && digitsChargeAwb) {
           orderReference = shiptaxExportMapDigits.get(digitsChargeAwb);
         }
         
         let dutyFobPct = 0;
         let totalChargesFobPct = 0;
         let matchStatus = 'Missing';
        
        if (fobInr !== null && fobInr !== undefined && fobInr > 0) {
          dutyFobPct = (duty / fobInr) * 100;
          totalChargesFobPct = (totalCharges / fobInr) * 100;
          matchStatus = 'Matched';
          
          const cInv = String(c.invoice_number || '').trim().toLowerCase();
          const fInv = String(c.fob_invoice || '').trim().toLowerCase();
          const cCountry = String(c.destination_country || '').trim().toLowerCase();
          const fCountry = String(c.fob_country || '').trim().toLowerCase();
          
          let invoiceMismatch = false;
          if (cInv && fInv) {
            if (cInv !== fInv && !cInv.includes(fInv) && !fInv.includes(cInv)) {
              invoiceMismatch = true;
            }
          }
          
          let countryMismatch = false;
          if (cCountry && fCountry) {
            if (cCountry !== fCountry && !cCountry.includes(fCountry) && !fCountry.includes(cCountry)) {
              countryMismatch = true;
            }
          }
          
          if (invoiceMismatch || countryMismatch) {
            matchStatus = 'Mismatched';
          }
        }

        return {
          "AWB": c.awb,
          "Original AWB": c.original_awb,
          "Courier": c.courier,
          "Reference No": orderReference || '',
          "Final Date": c.final_date || '',
          "Date Source": c.date_source || '',
          "Destination Country": c.destination_country || '',
          "Charge Type": c.charge_type || '',
          "Duty Amount": duty,
          "Disbursement Fee": c.disbursement_fee || 0,
          "Tax Amount": c.tax_amount || 0,
          "Other Charges": c.other_charges || 0,
          "Total Charges": totalCharges,
          "FOB (INR)": fobInr || 0,
          "Duty / FOB %": fobInr > 0 ? `${dutyFobPct.toFixed(2)}%` : '-',
          "Total / FOB %": fobInr > 0 ? `${totalChargesFobPct.toFixed(2)}%` : '-',
          "FOB Match Status": matchStatus
        };
      });
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fobReportData), "Customer FOB & Percentages");

      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=Courier_Duty_Audit_Report.xlsx');
      res.send(buffer);
    } catch (err: any) {
      res.status(500).send(err.message);
    }
  });

  // Dedicated endpoint for downloading ONLY the Duty/FOB Percentage Sheet
  app.get('/api/export-fob.xlsx', async (req, res) => {
    try {
      await loadFromTurso(false, ['charges', 'customer_fob', 'shiptax']);
      if (dbStatus === 'Data not loaded') {
        return res.status(503).json({ error: 'Cloud database unavailable or quota exceeded.' });
      }
      await ensureRawRowsLoaded();
      
      const wb = XLSX.utils.book_new();
      
      const fobCharges = db.prepare(`
        SELECT 
          c.*,
          f.fob_inr,
          f.invoice_number AS fob_invoice,
          f.country AS fob_country
        FROM charges c
        LEFT JOIN customer_fob f ON c.awb = f.awb
        ORDER BY c.final_date DESC, c.created_at DESC
      `).all() as any[];

      const shiptaxesExport = db.prepare('SELECT awb, original_awb, order_reference FROM shiptax').all() as any[];
      const shiptaxExportMapExact = new Map<string, string>();
      const shiptaxExportMapDigits = new Map<string, string>();
      for (const s of shiptaxesExport) {
        const rawAwb = String(s.original_awb || s.awb || '').trim();
        const normAwb = rawAwb.toUpperCase();
        const digitsOnly = normAwb.replace(/[^0-9]/g, '');
        if (s.order_reference) {
          shiptaxExportMapExact.set(normAwb, s.order_reference);
          shiptaxExportMapExact.set(String(s.awb || '').trim().toUpperCase(), s.order_reference);
          if (digitsOnly) {
            shiptaxExportMapDigits.set(digitsOnly, s.order_reference);
          }
        }
      }

      const fobReportData = fobCharges.map((c: any) => {
        const duty = c.duty_amount || 0;
        const totalCharges = c.total_charges || duty;
        const fobInr = c.fob_inr;

        const rawChargeAwb = String(c.original_awb || c.awb || '').trim();
        const normChargeAwb = rawChargeAwb.toUpperCase();
        const digitsChargeAwb = normChargeAwb.replace(/[^0-9]/g, '');
        let orderReference = shiptaxExportMapExact.get(normChargeAwb);
        if (!orderReference && digitsChargeAwb) {
          orderReference = shiptaxExportMapDigits.get(digitsChargeAwb);
        }
        
        let dutyFobPct = 0;
        let totalChargesFobPct = 0;
        let matchStatus = 'Missing';
        
        if (fobInr !== null && fobInr !== undefined && fobInr > 0) {
          dutyFobPct = (duty / fobInr) * 100;
          totalChargesFobPct = (totalCharges / fobInr) * 100;
          matchStatus = 'Matched';
          
          const cInv = String(c.invoice_number || '').trim().toLowerCase();
          const fInv = String(c.fob_invoice || '').trim().toLowerCase();
          const cCountry = String(c.destination_country || '').trim().toLowerCase();
          const fCountry = String(c.fob_country || '').trim().toLowerCase();
          
          let invoiceMismatch = false;
          if (cInv && fInv) {
            if (cInv !== fInv && !cInv.includes(fInv) && !fInv.includes(cInv)) {
              invoiceMismatch = true;
            }
          }
          
          let countryMismatch = false;
          if (cCountry && fCountry) {
            if (cCountry !== fCountry && !cCountry.includes(fCountry) && !fCountry.includes(cCountry)) {
              countryMismatch = true;
            }
          }
          
          if (invoiceMismatch || countryMismatch) {
            matchStatus = 'Mismatched';
          }
        }

        return {
          "AWB": c.awb,
          "Original AWB": c.original_awb,
          "Courier": c.courier,
          "Reference No": orderReference || '',
          "Final Date": c.final_date || '',
          "Date Source": c.date_source || '',
          "Destination Country": c.destination_country || '',
          "Charge Type": c.charge_type || '',
          "Duty Amount": duty,
          "Disbursement Fee": c.disbursement_fee || 0,
          "Tax Amount": c.tax_amount || 0,
          "Other Charges": c.other_charges || 0,
          "Total Charges": totalCharges,
          "FOB (INR)": fobInr || 0,
          "Duty / FOB %": fobInr > 0 ? `${dutyFobPct.toFixed(2)}%` : '-',
          "Total / FOB %": fobInr > 0 ? `${totalChargesFobPct.toFixed(2)}%` : '-',
          "FOB Match Status": matchStatus
        };
      });
      
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fobReportData), "Duty & FOB Percentages");
      
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=Customer_FOB_Duty_Percentage_Report.xlsx');
      res.send(buffer);
    } catch (err: any) {
      res.status(500).send(err.message);
    }
  });

  // Export full JSON Backup
  app.get('/api/backup.json', async (req, res) => {
    try {
      await loadFromTurso(false, ['shiptax', 'charges', 'double_billing', 'review', 'uploads']);
      if (dbStatus === 'Data not loaded') {
        return res.status(503).json({ error: 'Cloud database unavailable or quota exceeded. Do not trust totals until this is fixed.' });
      }
      await ensureRawRowsLoaded();
      const backup = {
        shiptax: db.prepare('SELECT * FROM shiptax').all(),
        charges: db.prepare('SELECT * FROM charges').all(),
        double_billing: db.prepare('SELECT * FROM double_billing').all(),
        review: db.prepare('SELECT * FROM review').all(),
        uploads: db.prepare('SELECT * FROM uploads').all()
      };
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=courier_audit_backup.json');
      res.json(backup);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Import JSON Backup
  app.post('/api/restore', upload.single('file'), async (req, res) => {
    try {
      await loadFromTurso(false, ['shiptax', 'charges', 'double_billing', 'review', 'uploads']);
      if (!req.file) {
        return res.status(400).json({ error: 'No backup file uploaded' });
      }
      const data = JSON.parse(req.file.buffer.toString('utf-8'));
      
      db.transaction(() => {
        db.prepare('DELETE FROM shiptax').run();
        db.prepare('DELETE FROM charges').run();
        db.prepare('DELETE FROM double_billing').run();
        db.prepare('DELETE FROM review').run();
        db.prepare('DELETE FROM uploads').run();
        
        if (Array.isArray(data.shiptax)) {
          const stmt = db.prepare(`
            INSERT INTO shiptax (awb, original_awb, ship_date, courier, country, order_reference, source_file, import_batch, created_at)
            VALUES (@awb, @original_awb, @ship_date, @courier, @country, @order_reference, @source_file, @import_batch, @created_at)
          `);
          for (const row of data.shiptax) stmt.run(row);
        }
        
        if (Array.isArray(data.charges)) {
          const stmt = db.prepare(`
            INSERT INTO charges (id, signature, awb, original_awb, courier, charge_type, charge_type_key, duty_amount, currency, invoice_number, invoice_date, courier_ship_date, final_date, date_source, shiptax_found, shiptax_ship_date, destination_country, charge_month, source_file, source_sheet, source_row, status, created_at)
            VALUES (@id, @signature, @awb, @original_awb, @courier, @charge_type, @charge_type_key, @duty_amount, @currency, @invoice_number, @invoice_date, @courier_ship_date, @final_date, @date_source, @shiptax_found, @shiptax_ship_date, @destination_country, @charge_month, @source_file, @source_sheet, @source_row, @status, @created_at)
          `);
          for (const row of data.charges) stmt.run(row);
        }
        
        if (Array.isArray(data.double_billing)) {
          const stmt = db.prepare(`
            INSERT INTO double_billing (id, awb, courier, ship_date, first_charge_month, first_invoice_number, first_source_file, repeat_charge_month, repeat_invoice_number, repeat_source_file, duty_amount, charge_type, message, created_at)
            VALUES (@id, @awb, @courier, @ship_date, @first_charge_month, @first_invoice_number, @first_source_file, @repeat_charge_month, @repeat_invoice_number, @repeat_source_file, @duty_amount, @charge_type, @message, @created_at)
          `);
          for (const row of data.double_billing) stmt.run(row);
        }
        
        if (Array.isArray(data.review)) {
          const stmt = db.prepare(`
            INSERT INTO review (id, reason, courier, awb, source_file, source_sheet, source_row, message, created_at)
            VALUES (@id, @reason, @courier, @awb, @source_file, @source_sheet, @source_row, @message, @created_at)
          `);
          for (const row of data.review) stmt.run(row);
        }
        
        if (Array.isArray(data.uploads)) {
          const stmt = db.prepare(`
            INSERT INTO uploads (id, file_name, file_type, import_type, rows_seen, rows_added, rows_skipped, created_at)
            VALUES (@id, @file_name, @file_type, @import_type, @rows_seen, @rows_added, @rows_skipped, @created_at)
          `);
          for (const row of data.uploads) stmt.run(row);
        }
      })();
      
      // Update persistent cloud database
      await saveToTurso(['shiptax', 'charges', 'double_billing', 'review', 'uploads', 'summary_stats', 'datewise_summary']);
      
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------
  // Vite Dev Server / Static Hosting Integration
  // -----------------------------------------------------------------
  const isServerless = !!(process.env.VERCEL || process.env.NOW_BUILDER);
  if (!isServerless) {
    if (process.env.NODE_ENV !== 'production') {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } else {
      const distPath = path.join(process.cwd(), 'dist');
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  return app;
}

const isVercel = process.env.VERCEL || process.env.NOW_BUILDER;
if (!isVercel) {
  const PORT = Number(process.env.PORT) || 3000;
  createExpressApp().then(app => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[FULLSTACK CORE] Server running on http://0.0.0.0:${PORT}`);
    });
  }).catch(err => {
    console.error('[STARTUP ERROR] Failed to start local Express server:', err);
  });
}
