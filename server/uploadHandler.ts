import path from 'path';
import fs from 'fs';
import { db, prefetchShiptaxAwbs } from './db.js';
import {
  normalizeAWB,
  parseExcelDate,
  findColumn,
  extractZipFiles,
  parseFileBuffer,
  isDHLDuty,
  isFedExDuty,
  extractFedExCharges,
  detectCourierFromRow,
  parseAmount,
  findBestHeaderRow,
  buildRowObjects
} from './parsers.js';

export async function processShipTaxFile(
  buffer: Buffer,
  fileName: string,
  batchId: string
): Promise<{ added: number; updated: number; review: number }> {
  let stats = { added: 0, updated: 0, review: 0 };
  
  if (fileName.toLowerCase().endsWith('.zip')) {
    const zipFiles = await extractZipFiles(buffer);
    for (const zf of zipFiles) {
      const zfStats = await processShipTaxFile(zf.data, zf.name, batchId);
      stats.added += zfStats.added;
      stats.updated += zfStats.updated;
      stats.review += zfStats.review;
    }
    return stats;
  }
  
  const parsedSheets = parseFileBuffer(buffer, fileName);
  
  for (const sheet of parsedSheets) {
    const rawRows = sheet.rawRows;
    if (rawRows.length === 0) continue;
    
    const { headerIdx } = findBestHeaderRow(rawRows);
    const headerRow = rawRows[headerIdx] || [];
    
    const awbKey = findColumn(headerRow, [
      'trackingnumber', 'awb', 'airwaybill', 'trackingno', 'trackno', 
      'shipmentnumber', 'shipmentno', 'shpmtno', 'shpmtnumber', 'airwaybillnumber'
    ]);
    const shipDateKey = findColumn(headerRow, [
      'dateshipped', 'shipdate', 'shippeddate', 'date', 'shipmentdate', 
      'dateshipment', 'shippedon', 'shipon'
    ]);
    const courierKey = findColumn(headerRow, ['couriername', 'courier', 'carrier']);
    const countryKey = findColumn(headerRow, ['destinationcountry', 'country', 'destcountry', 'destctry']);
    const orderRefKey = findColumn(headerRow, ['orderreference', 'orderref', 'ref2', 'referencenumber', 'reference']);
    
    if (!awbKey) {
      db.prepare(`
        INSERT INTO review (reason, courier, awb, source_file, source_sheet, source_row, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'Missing AWB column',
        'ShipTax',
        '',
        fileName,
        sheet.sheetName,
        headerIdx + 1,
        'No valid AWB/Tracking column was found in the sheet.',
        new Date().toISOString()
      );
      stats.review++;
      continue;
    }
    
    const rows = buildRowObjects(rawRows, headerIdx);
    
    const insertStmt = db.prepare(`
      INSERT INTO shiptax (awb, original_awb, ship_date, courier, country, order_reference, source_file, import_batch, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const seenAwbs = new Set();
    
    for (const row of rows) {
      const rawAwb = row[awbKey];
      const normalizedAwb = normalizeAWB(rawAwb);
      const sourceRow = row._source_row;
      
      if (!normalizedAwb) {
        db.prepare(`
          INSERT INTO review (reason, courier, awb, source_file, source_sheet, source_row, message, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'AWB missing in row',
          'ShipTax',
          '',
          fileName,
          sheet.sheetName,
          sourceRow,
          'The AWB value is blank or empty in this row.',
          new Date().toISOString()
        );
        stats.review++;
        continue;
      }
      
      if (seenAwbs.has(normalizedAwb)) continue;
      seenAwbs.add(normalizedAwb);
      
      const shipDate = shipDateKey ? parseExcelDate(row[shipDateKey]) : '';
      const courier = courierKey ? String(row[courierKey] || '').trim() : '';
      const country = countryKey ? String(row[countryKey] || '').trim() : '';
      const orderRef = orderRefKey ? String(row[orderRefKey] || '').trim() : '';
      
      insertStmt.run(
        normalizedAwb,
        String(rawAwb || ''),
        shipDate,
        courier,
        country,
        orderRef,
        fileName,
        batchId,
        new Date().toISOString()
      );
      stats.added++;

      // Secondary digit-only insertion for bi-directional AWB matching
      const digitsOnly = normalizedAwb.replace(/[^0-9]/g, '');
      if (digitsOnly && digitsOnly !== normalizedAwb && !seenAwbs.has(digitsOnly)) {
        seenAwbs.add(digitsOnly);
        insertStmt.run(
          digitsOnly,
          String(rawAwb || ''),
          shipDate,
          courier,
          country,
          orderRef,
          fileName,
          batchId,
          new Date().toISOString()
        );
      }
    }
  }
  
  return stats;
}

export interface SheetDebugInfo {
  fileName: string;
  sheetName: string;
  courier: string;
  rowsScanned: number;
  headerRowFound: string;
  dutyRowsFound: number;
  rowsAdded: number;
  rowsSkipped: number;
  missingColumns: string[];
}

function runExtraChecks(
  db: any,
  courier: string,
  normalizedAwb: string,
  invoiceNum: string,
  finalDate: string,
  shiptaxShipDate: string,
  fileName: string,
  sheetName: string,
  sourceRow: number,
  stats: any,
  stmtGetSameInvoice: any,
  stmtGetCrossCourier: any,
  stmtInsertReview: any
) {
  // Check 1: Old Shipment Charge (>60 days from ShipTax ship date)
  if (shiptaxShipDate && finalDate) {
    const d1 = new Date(shiptaxShipDate);
    const d2 = new Date(finalDate);
    if (!isNaN(d1.getTime()) && !isNaN(d2.getTime())) {
      const diffTime = Math.abs(d2.getTime() - d1.getTime());
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      if (diffDays > 60) {
        stmtInsertReview.run(
          'Old Shipment Charge',
          courier,
          normalizedAwb,
          fileName,
          sheetName,
          sourceRow,
          `This duty was charged >60 days after ShipTax ship date (Ship Date: ${shiptaxShipDate}, Charge Date: ${finalDate}).`,
          new Date().toISOString()
        );
        stats.review++;
      }
    }
  }

  // Check 2: Same Invoice Duplicate (multiple duty rows for same AWB on same invoice)
  if (invoiceNum) {
    const existingSameInvoice = stmtGetSameInvoice.get(normalizedAwb, invoiceNum, courier);
    
    if (existingSameInvoice) {
      stmtInsertReview.run(
        'Same Invoice Duplicate',
        courier,
        normalizedAwb,
        fileName,
        sheetName,
        sourceRow,
        `AWB ${normalizedAwb} has multiple duty rows on the same invoice ${invoiceNum}.`,
        new Date().toISOString()
      );
      stats.review++;
    }
  }

  // Check 3: Cross Courier Review (same AWB in different courier)
  const crossCourierMatch = stmtGetCrossCourier.get(normalizedAwb, courier) as any;
  
  if (crossCourierMatch) {
    stmtInsertReview.run(
      'Cross Courier Review',
      courier,
      normalizedAwb,
      fileName,
      sheetName,
      sourceRow,
      `AWB ${normalizedAwb} is charged by ${courier}, but was also charged by ${crossCourierMatch.courier} (Invoice: ${crossCourierMatch.invoice_number}).`,
      new Date().toISOString()
    );
    stats.review++;
  }
}

export async function processCourierFile(
  buffer: Buffer,
  fileName: string,
  selectedCourier: string,
  targetMonth: string
): Promise<{ added: number; double: number; skipped: number; review: number; debug: SheetDebugInfo[] }> {
  let stats = { added: 0, double: 0, skipped: 0, review: 0 };
  let debugReports: SheetDebugInfo[] = [];
  
  if (fileName.toLowerCase().endsWith('.zip')) {
    const zipFiles = await extractZipFiles(buffer);
    for (const zf of zipFiles) {
      const zfStats = await processCourierFile(zf.data, zf.name, selectedCourier, targetMonth);
      stats.added += zfStats.added;
      stats.double += zfStats.double;
      stats.skipped += zfStats.skipped;
      stats.review += zfStats.review;
      debugReports = debugReports.concat(zfStats.debug);
    }
    return { ...stats, debug: debugReports };
  }
  
  const parsedSheets = parseFileBuffer(buffer, fileName);
  
  // Extract and bulk prefetch ShipTax AWBs from Firestore to avoid full collection reads
  const awbList: string[] = [];
  for (const sheet of parsedSheets) {
    const rawRows = sheet.rawRows;
    if (rawRows.length === 0) continue;
    const { headerIdx } = findBestHeaderRow(rawRows);
    const headerRow = rawRows[headerIdx] || [];
    const awbKey = findColumn(headerRow, [
      'trackingnumber', 'awb', 'airwaybill', 'trackingno', 'tracking#', 'waybill', 'shipmentnumber', 'shipmentno', 'conno', 'hawb'
    ]);
    if (awbKey) {
      const rows = buildRowObjects(rawRows, headerIdx);
      for (const row of rows) {
        const rawAwb = row[awbKey];
        if (rawAwb) {
          const norm = normalizeAWB(rawAwb);
          if (norm) {
            awbList.push(norm);
          }
        }
      }
    }
  }
  if (awbList.length > 0) {
    await prefetchShiptaxAwbs(awbList);
  }
  
  // Precompile Map/Set caches for maximum O(1) performance inside loop
  const allShiptax = db.prepare('SELECT * FROM shiptax').all() as any[];
  const shiptaxMap = new Map();
  const shiptaxOriginalMap = new Map();
  const shiptaxDigitsMap = new Map();
  
  for (const row of allShiptax) {
    if (row.awb) shiptaxMap.set(row.awb, row);
    if (row.original_awb) shiptaxOriginalMap.set(row.original_awb, row);
    const digits = (row.awb || '').replace(/[^0-9]/g, '');
    if (digits) shiptaxDigitsMap.set(digits, row);
  }

  const allCharges = db.prepare('SELECT signature, awb, courier, charge_type_key, invoice_number, source_file, charge_month, status FROM charges').all() as any[];
  const sigSet = new Set();
  const chargeMap = new Map();
  const invoiceSet = new Set();
  const crossCourierMap = new Map();
  
  for (const row of allCharges) {
    if (row.signature) sigSet.add(row.signature);
    if (row.awb && row.courier && row.charge_type_key) {
      chargeMap.set(`${row.awb}_${row.courier}_${row.charge_type_key}`, row);
    }
    if (row.awb && row.invoice_number && row.courier && row.status !== 'double_billing') {
      invoiceSet.add(`${row.awb}_${row.invoice_number}_${row.courier}`);
    }
    if (row.awb && row.courier) {
      if (!crossCourierMap.has(row.awb)) crossCourierMap.set(row.awb, new Set());
      crossCourierMap.get(row.awb).add(row.courier);
    }
  }

  function findShiptaxMatch(awb: string): any {
    if (!awb) return null;
    if (shiptaxMap.has(awb)) return shiptaxMap.get(awb);
    if (shiptaxOriginalMap.has(awb)) return shiptaxOriginalMap.get(awb);
    
    const digitsOnly = awb.replace(/[^0-9]/g, '');
    if (digitsOnly && digitsOnly !== awb) {
      if (shiptaxMap.has(digitsOnly)) return shiptaxMap.get(digitsOnly);
    }
    if (digitsOnly) {
      if (shiptaxDigitsMap.has(digitsOnly)) return shiptaxDigitsMap.get(digitsOnly);
    }
    return null;
  }

  // Mock the slow Alasql statements with instant O(1) JS lookups
  const stmtGetChargeSig = { get: (sig: string) => sigSet.has(sig) ? {1:1} : undefined };
  
  const stmtGetExistingCharge = { 
    get: (awb: string, courier: string, key: string) => chargeMap.get(`${awb}_${courier}_${key}`)
  };
  
  const stmtGetSameInvoice = {
    get: (awb: string, inv: string, courier: string) => invoiceSet.has(`${awb}_${inv}_${courier}`) ? {1:1} : undefined
  };
  
  const stmtGetCrossCourier = {
    get: (awb: string, currentCourier: string) => {
      const couriers = crossCourierMap.get(awb);
      if (!couriers) return undefined;
      for (const c of couriers) {
        if (c !== currentCourier) return { courier: c };
      }
      return undefined;
    }
  };

  const rawInsertReview = db.prepare(`
    INSERT INTO review (reason, courier, awb, source_file, source_sheet, source_row, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtInsertReview = { run: (...args: any[]) => rawInsertReview.run(...args) };

  const rawInsertDoubleBilling = db.prepare(`
    INSERT INTO double_billing (awb, courier, ship_date, first_charge_month, first_invoice_number, first_source_file, repeat_charge_month, repeat_invoice_number, repeat_source_file, duty_amount, charge_type, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtInsertDoubleBilling = { run: (...args: any[]) => rawInsertDoubleBilling.run(...args) };

  const rawInsertCharge = db.prepare(`
    INSERT INTO charges (signature, awb, original_awb, courier, charge_type, charge_type_key, duty_amount, currency, invoice_number, invoice_date, courier_ship_date, final_date, date_source, shiptax_found, shiptax_ship_date, destination_country, charge_month, source_file, source_sheet, source_row, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  // Wrap InsertCharge to keep our memory cache perfectly synced for intra-file duplicates
  const stmtInsertCharge = {
    run: (...args: any[]) => {
      const [signature, awb, original_awb, courier, charge_type, charge_type_key, duty_amount, currency, invoice_number, invoice_date, courier_ship_date, final_date, date_source, shiptax_found, shiptax_ship_date, destination_country, charge_month, source_file, source_sheet, source_row, status, created_at] = args;
      
      sigSet.add(signature);
      chargeMap.set(`${awb}_${courier}_${charge_type_key}`, {
        awb, courier, charge_type_key, charge_month, invoice_number, source_file
      });
      if (status !== 'double_billing') {
        invoiceSet.add(`${awb}_${invoice_number}_${courier}`);
      }
      if (!crossCourierMap.has(awb)) crossCourierMap.set(awb, new Set());
      crossCourierMap.get(awb).add(courier);
      
      return rawInsertCharge.run(...args);
    }
  };

  db.transaction(() => {
    for (const sheet of parsedSheets) {
    const rawRows = sheet.rawRows;
    if (rawRows.length === 0) continue;
    
    const { headerIdx, score } = findBestHeaderRow(rawRows);
    const headerRow = rawRows[headerIdx] || [];
    
    let detectedCourier = selectedCourier;
    if (detectedCourier === 'AUTO') {
      detectedCourier = detectCourierFromRow(headerRow);
    }
    
    if (detectedCourier === 'UNKNOWN' || !detectedCourier) {
      stmtInsertReview.run(
        'Courier not detected',
        'Unknown',
        '',
        fileName,
        sheet.sheetName,
        headerIdx + 1,
        'Could not automatically detect Courier (DHL/UPS/FedEx) for this sheet. Please select it manually.',
        new Date().toISOString()
      );
      stats.review++;
      
      debugReports.push({
        fileName,
        sheetName: sheet.sheetName,
        courier: 'Unknown',
        rowsScanned: rawRows.length,
        headerRowFound: `Row ${headerIdx + 1} (Score: ${score})`,
        dutyRowsFound: 0,
        rowsAdded: 0,
        rowsSkipped: 0,
        missingColumns: ['Courier Identification']
      });
      continue;
    }
    
    let rowsScanned = rawRows.length;
    let dutyRowsFound = 0;
    let rowsAdded = 0;
    let rowsSkipped = 0;
    let missingColumns: string[] = [];
    
    if (detectedCourier === 'STANDARD') {
      const awbKey = findColumn(headerRow, ['awb']);
      const courierKey = findColumn(headerRow, ['courier']);
      const invoiceKey = findColumn(headerRow, ['invoicenumber']);
      const shipDateKey = findColumn(headerRow, ['shipdate']);
      const dutyAmountKey = findColumn(headerRow, ['dutyamount']);
      const currencyKey = findColumn(headerRow, ['currency']);
      
      if (!awbKey) missingColumns.push('AWB');
      if (!dutyAmountKey) missingColumns.push('Duty Amount');
      
      if (missingColumns.length > 0) {
        throw new Error(`Required columns missing in Standard Template: ${missingColumns.join(', ')}`);
      }
      
      const rows = buildRowObjects(rawRows, headerIdx);
      
      for (const row of rows) {
        const rawAwb = row[awbKey!];
        if (!rawAwb) continue;
        const normalizedAwb = normalizeAWB(rawAwb);
        if (!normalizedAwb) continue;
        
        dutyRowsFound++;
        
        const dutyAmtStr = String(row[dutyAmountKey!] || '0');
        const dutyAmount = parseFloat(dutyAmtStr.replace(/[^0-9.-]+/g, '')) || 0;
        if (dutyAmount <= 0) {
          rowsSkipped++;
          continue;
        }
        
        const cName = courierKey ? String(row[courierKey] || 'Unknown').trim() : 'Unknown';
        const invNo = invoiceKey ? String(row[invoiceKey] || '').trim() : '';
        const sDate = shipDateKey ? parseExcelDate(row[shipDateKey]) : '';
        const curr = currencyKey ? String(row[currencyKey] || 'INR').trim() : 'INR';
        const sourceRow = row._source_row;
        let finalDate = sDate;
        let dateSource = sDate ? 'Standard File' : '';
        let shiptaxFound = 0;
        let shiptaxShipDate = '';
        let destCountry = '';

        const shiptaxMatch = findShiptaxMatch(normalizedAwb);
        if (shiptaxMatch) {
          shiptaxFound = 1;
          shiptaxShipDate = shiptaxMatch.ship_date || '';
          if (shiptaxMatch.country) destCountry = shiptaxMatch.country;
        }

        if (!finalDate && shiptaxShipDate) {
          finalDate = shiptaxShipDate;
          dateSource = 'ShipTax';
        }

        const chargeMonth = targetMonth || (sDate ? sDate.substring(0, 7) : new Date().toISOString().substring(0, 7));
        const signature = `${cName}|${normalizedAwb}|${invNo}|${dutyAmount}|import_export_duties`;
        
        const signatureExists = stmtGetChargeSig.get(signature);
        if (signatureExists) {
          stats.skipped++;
          rowsSkipped++;
          continue;
        }

        let rowStatus = 'accepted';
        if (!finalDate) {
          rowStatus = 'needs_review';
          stmtInsertReview.run(
            'Ship date missing', cName, normalizedAwb, fileName, sheet.sheetName, sourceRow,
            'Could not find a reliable date from file or ShipTax memory.', new Date().toISOString()
          );
          stats.review++;
        }

        const existingCharge = stmtGetExistingCharge.get(normalizedAwb, cName, 'import_export_duties') as any;
        if (existingCharge) {
          const existingMonth = existingCharge.charge_month || 'Unknown Month';
          const existingInvoice = existingCharge.invoice_number || 'Unknown Invoice';
          const msgText = `This AWB was already charged in ${existingMonth}/${existingInvoice}/${existingCharge.source_file || 'Unknown'}. It is charged again in ${chargeMonth}/${invNo || 'Unknown'}/${fileName}.`;
          
          stmtInsertDoubleBilling.run(
            normalizedAwb, cName, finalDate || shiptaxShipDate || '', existingMonth, existingInvoice,
            existingCharge.source_file || '', chargeMonth, invNo, fileName, dutyAmount, 'Duty', msgText, new Date().toISOString()
          );
          stats.double++;
          rowStatus = 'double_billing';
        }

        stmtInsertCharge.run(
          signature, normalizedAwb, String(rawAwb || ''), cName, 'Duty', 'import_export_duties',
          dutyAmount, curr, invNo, '', '', finalDate, dateSource, shiptaxFound, shiptaxShipDate,
          destCountry, chargeMonth, fileName, sheet.sheetName, sourceRow, rowStatus, new Date().toISOString()
        );
        stats.added++;
        rowsAdded++;
      }
    } else if (detectedCourier === 'DHL') {
      // Check if this is the new detailed CSV format
      const isNewDHL = findColumn(headerRow, ['shipmentnumber', 'xc1name', 'xc1charge']) !== null;
      
      if (isNewDHL) {
        const awbKey = findColumn(headerRow, ['shipmentnumber', 'shipmentno']);
        const shipDateKey = findColumn(headerRow, ['shipmentdate', 'shipdate']);
        const invoiceKey = findColumn(headerRow, ['invoicenumber', 'invoice', 'invno']);
        const invoiceDateKey = findColumn(headerRow, ['invoicedate', 'date', 'invdt']);
        const countryKey = findColumn(headerRow, ['destcountrycode', 'destcountryname', 'destcountry', 'country', 'destctry']);
        const currKey = findColumn(headerRow, ['currency', 'curr']);
        
        if (!awbKey) missingColumns.push('Shipment Number');
        if (!invoiceKey) missingColumns.push('Invoice Number');
        
        if (missingColumns.length > 0) {
          throw new Error(`Required columns missing in DHL New format: ${missingColumns.join(', ')}`);
        }
        
        const rows = buildRowObjects(rawRows, headerIdx);
        
        for (const row of rows) {
          const sourceRow = row._source_row;
          const rawAwb = awbKey ? row[awbKey] : '';
          const normalizedAwb = normalizeAWB(rawAwb);
          
          // skip invoice summary rows where Shipment Number is blank
          if (!normalizedAwb) {
            continue;
          }
          
          const invoiceNum = invoiceKey ? String(row[invoiceKey] || '').trim() : '';
          const invoiceDate = invoiceDateKey ? parseExcelDate(row[invoiceDateKey]) : '';
          const shippingDate = shipDateKey ? parseExcelDate(row[shipDateKey]) : '';
          const currency = currKey ? String(row[currKey] || '').trim() : 'INR';
          const destCountryRaw = countryKey ? String(row[countryKey] || '').trim() : '';
          
          // scan XC1 to XC9
          for (let xcNum = 1; xcNum <= 9; xcNum++) {
            const nameKey = findColumn(headerRow, [`xc${xcNum}name`]);
            const chargeKey = findColumn(headerRow, [`xc${xcNum}charge`]);
            
            if (nameKey && chargeKey) {
              const nameVal = String(row[nameKey] || '').trim();
              const chargeVal = row[chargeKey];
              
              if (isDHLDuty(nameVal)) {
                dutyRowsFound++;
                const amount = parseAmount(chargeVal);
                
                if (isNaN(amount) || amount <= 0) {
                  stmtInsertReview.run(
                    'Amount missing',
                    'DHL',
                    normalizedAwb,
                    fileName,
                    sheet.sheetName,
                    sourceRow,
                    `A DHL duty row has an invalid or zero amount for ${nameVal}: "${chargeVal}"`,
                    new Date().toISOString()
                  );
                  stats.review++;
                  continue;
                }
                
                let finalDate = '';
                let dateSource = '';
                let shiptaxFound = 0;
                let shiptaxShipDate = '';
                let destCountry = destCountryRaw;
                
                const shiptaxMatch = findShiptaxMatch(normalizedAwb);
                if (shiptaxMatch) {
                  shiptaxFound = 1;
                  shiptaxShipDate = shiptaxMatch.ship_date || '';
                  if (!destCountry && shiptaxMatch.country) {
                    destCountry = shiptaxMatch.country;
                  }
                }
                
                // DHL Date Priority Rule: Shipping Date, then ShipTax, then Billing Date fallback
                if (shippingDate) {
                  finalDate = shippingDate;
                  dateSource = 'DHL Shipping Date';
                } else if (shiptaxShipDate) {
                  finalDate = shiptaxShipDate;
                  dateSource = 'ShipTax';
                } else if (invoiceDate) {
                  finalDate = invoiceDate;
                  dateSource = 'DHL Billing Date';
                }
                
                const chargeMonth = targetMonth || (invoiceDate ? invoiceDate.substring(0, 7) : new Date().toISOString().substring(0, 7));
                
                const signature = `DHL|${normalizedAwb}|${invoiceNum}|${amount}|import_export_duties`;
                const signatureExists = stmtGetChargeSig.get(signature);
                if (signatureExists) {
                  stats.skipped++;
                  rowsSkipped++;
                  continue;
                }
                
                let rowStatus = 'accepted';
                if (!finalDate) {
                  rowStatus = 'needs_review';
                  stmtInsertReview.run(
                    'Ship date missing',
                    'DHL',
                    normalizedAwb,
                    fileName,
                    sheet.sheetName,
                    sourceRow,
                    'Could not find a reliable date from DHL shipping date, ShipTax, or DHL billing date.',
                    new Date().toISOString()
                  );
                  stats.review++;
                }
                
                const existingCharge = stmtGetExistingCharge.get(normalizedAwb, 'DHL', 'import_export_duties') as any;
                
                if (existingCharge) {
                  const existingMonth = existingCharge.charge_month || 'Unknown Month';
                  const existingInvoice = existingCharge.invoice_number || 'Unknown Invoice';
                  const msgText = `This AWB was already charged in ${existingMonth}/${existingInvoice}/${existingCharge.source_file || 'Unknown'}. It is charged again in ${chargeMonth}/${invoiceNum || 'Unknown'}/${fileName}.`;
                  
                  stmtInsertDoubleBilling.run(
                    normalizedAwb,
                    'DHL',
                    finalDate || shiptaxShipDate || '',
                    existingMonth,
                    existingInvoice,
                    existingCharge.source_file || '',
                    chargeMonth,
                    invoiceNum,
                    fileName,
                    amount,
                    nameVal,
                    msgText,
                    new Date().toISOString()
                  );
                  stats.double++;
                  rowStatus = 'double_billing';
                }
                
                stmtInsertCharge.run(
                  signature,
                  normalizedAwb,
                  String(rawAwb || ''),
                  'DHL',
                  nameVal,
                  'import_export_duties',
                  amount,
                  currency,
                  invoiceNum,
                  invoiceDate,
                  shippingDate,
                  finalDate || null,
                  dateSource || null,
                  shiptaxFound,
                  shiptaxShipDate,
                  destCountry,
                  chargeMonth,
                  fileName,
                  sheet.sheetName,
                  sourceRow,
                  rowStatus,
                  new Date().toISOString()
                );
                stats.added++;
                rowsAdded++;
              }
            }
          }
        }
      } else {
        // --- OLD DHL ROW-WISE EXCEL FORMAT ---
        const awbKey = findColumn(headerRow, ['awb', 'refkey3', 'trackingnumber', 'airwaybill', 'trackno']);
        const descKey = findColumn(headerRow, ['description', 'product']);
        const shipDateKey = findColumn(headerRow, ['shippingdate', 'shipdate', 'dateshipped', 'shipping date']);
        const billingDateKey = findColumn(headerRow, ['billingdate', 'invdate', 'invoicedate', 'date', 'billing date']);
        const amountKey = findColumn(headerRow, ['amount', 'chargeamount', 'dutyamount', 'value']);
        const invoiceKey = findColumn(headerRow, ['invoice', 'invoicenumber', 'invno', 'invnum']);
        const currKey = findColumn(headerRow, ['currency', 'curr']);
        
        // Check required DHL columns
        if (!awbKey) missingColumns.push('AWB');
        if (!descKey) missingColumns.push('Description');
        if (!shipDateKey) missingColumns.push('Shipping Date');
        if (!billingDateKey) missingColumns.push('Billing Date');
        if (!amountKey) missingColumns.push('Amount');
        if (!invoiceKey) missingColumns.push('Invoice');
        
        if (missingColumns.length > 0) {
          throw new Error(`Required columns missing in DHL standard format: ${missingColumns.join(', ')}`);
        }
        
        const rows = buildRowObjects(rawRows, headerIdx);
        
        for (const row of rows) {
          const desc = descKey ? String(row[descKey] || '').trim() : '';
          const sourceRow = row._source_row;
          
          if (!isDHLDuty(desc)) {
            continue;
          }
          
          dutyRowsFound++;
          
          const rawAwb = awbKey ? row[awbKey] : '';
          const normalizedAwb = normalizeAWB(rawAwb);
          const amount = amountKey ? parseAmount(row[amountKey]) : NaN;
          const invoiceNum = invoiceKey ? String(row[invoiceKey] || '').trim() : '';
          const invoiceDate = billingDateKey ? parseExcelDate(row[billingDateKey]) : '';
          const shippingDate = shipDateKey ? parseExcelDate(row[shipDateKey]) : '';
          const currency = currKey ? String(row[currKey] || '').trim() : 'INR';
          
          if (!normalizedAwb) {
            stmtInsertReview.run(
              'AWB missing',
              'DHL',
              '',
              fileName,
              sheet.sheetName,
              sourceRow,
              'A DHL duty row is missing its AWB/tracking number.',
              new Date().toISOString()
            );
            stats.review++;
            continue;
          }
          
          if (isNaN(amount) || amount <= 0) {
            stmtInsertReview.run(
              'Amount missing',
              'DHL',
              normalizedAwb,
              fileName,
              sheet.sheetName,
              sourceRow,
              `A DHL duty row has an invalid or zero amount: "${row[amountKey || '']}"`,
              new Date().toISOString()
            );
            stats.review++;
            continue;
          }
          
          let finalDate = '';
          let dateSource = '';
          let shiptaxFound = 0;
          let shiptaxShipDate = '';
          let destCountry = '';
          
          const shiptaxMatch = findShiptaxMatch(normalizedAwb);
          if (shiptaxMatch) {
            shiptaxFound = 1;
            shiptaxShipDate = shiptaxMatch.ship_date || '';
            destCountry = shiptaxMatch.country || '';
          }
          
          // DHL Date Priority Rule: Shipping Date, then ShipTax, then Billing Date fallback
          if (shippingDate) {
            finalDate = shippingDate;
            dateSource = 'DHL Shipping Date';
          } else if (shiptaxShipDate) {
            finalDate = shiptaxShipDate;
            dateSource = 'ShipTax';
          } else if (invoiceDate) {
            finalDate = invoiceDate;
            dateSource = 'DHL Billing Date';
          }
          
          const chargeMonth = targetMonth || (invoiceDate ? invoiceDate.substring(0, 7) : new Date().toISOString().substring(0, 7));
          
          const signature = `DHL|${normalizedAwb}|${invoiceNum}|${amount}|import_export_duties`;
          const signatureExists = stmtGetChargeSig.get(signature);
          if (signatureExists) {
            stats.skipped++;
            rowsSkipped++;
            continue;
          }
          
          let rowStatus = 'accepted';
          if (!finalDate) {
            rowStatus = 'needs_review';
            stmtInsertReview.run(
              'Ship date missing',
              'DHL',
              normalizedAwb,
              fileName,
              sheet.sheetName,
              sourceRow,
              'Could not find a reliable date from DHL shipping date, ShipTax, or DHL billing date.',
              new Date().toISOString()
            );
            stats.review++;
          }
          
          const existingCharge = stmtGetExistingCharge.get(normalizedAwb, 'DHL', 'import_export_duties') as any;
          
          if (existingCharge) {
            const existingMonth = existingCharge.charge_month || 'Unknown Month';
            const existingInvoice = existingCharge.invoice_number || 'Unknown Invoice';
            const msgText = `This AWB was already charged in ${existingMonth}/${existingInvoice}/${existingCharge.source_file || 'Unknown'}. It is charged again in ${chargeMonth}/${invoiceNum || 'Unknown'}/${fileName}.`;
            
            stmtInsertDoubleBilling.run(
              normalizedAwb,
              'DHL',
              finalDate || shiptaxShipDate || '',
              existingMonth,
              existingInvoice,
              existingCharge.source_file || '',
              chargeMonth,
              invoiceNum,
              fileName,
              amount,
              'Import Export Duties',
              msgText,
              new Date().toISOString()
            );
            stats.double++;
            rowStatus = 'double_billing';
          }
          
          stmtInsertCharge.run(
            signature,
            normalizedAwb,
            String(rawAwb || ''),
            'DHL',
            'Import Export Duties',
            'import_export_duties',
            amount,
            currency,
            invoiceNum,
            invoiceDate,
            shippingDate,
            finalDate || null,
            dateSource || null,
            shiptaxFound,
            shiptaxShipDate,
            destCountry,
            chargeMonth,
            fileName,
            sheet.sheetName,
            sourceRow,
            rowStatus,
            new Date().toISOString()
          );
          stats.added++;
          rowsAdded++;
        }
      }
    } 
    
    else if (detectedCourier === 'UPS') {
      const awbKey = findColumn(headerRow, [
        'track no', 'tracking number', 'awb', 'trackno', 'trackingno', 
        'airwaybill', 'airwaybillnumber', 'shipmentnumber', 'shipmentno'
      ]);
      const countryKey = findColumn(headerRow, ['dest ctry', 'destinationcountry', 'country', 'destcountry', 'destctry']);
      const dutyAmountKey = findColumn(headerRow, ['duty amount', 'dutyamount', 'duty']);
      const invoiceKey = findColumn(headerRow, ['invoice number', 'invoice', 'invoicenumber', 'invno', 'invnum']);
      const invoiceDateKey = findColumn(headerRow, ['invoicedate', 'date', 'invdt', 'invoice date']);
      const currKey = findColumn(headerRow, ['currency', 'curr']);
      
      // Check required UPS columns
      if (!awbKey) missingColumns.push('track no / tracking number / awb');
      if (!countryKey) missingColumns.push('dest ctry');
      if (!dutyAmountKey) missingColumns.push('DUTY AMOUNT');
      if (!invoiceKey) missingColumns.push('invoice number');
      
      if (missingColumns.length > 0) {
        throw new Error(`Required columns missing in UPS sheet: ${missingColumns.join(', ')}`);
      }
      
      const rows = buildRowObjects(rawRows, headerIdx);
      
      const isUS = (c: string) => {
        const clean = c.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
        return clean === 'us' || clean === 'usa' || clean === 'unitedstates' || clean === 'unitedstatesofamerica';
      };
      
      for (const row of rows) {
        const sourceRow = row._source_row;
        const dutyVal = dutyAmountKey ? row[dutyAmountKey] : '';
        const amount = parseAmount(dutyVal);
        
        if (isNaN(amount) || amount <= 0) {
          continue;
        }
        
        dutyRowsFound++;
        
        const rawAwb = awbKey ? row[awbKey] : '';
        const normalizedAwb = normalizeAWB(rawAwb);
        const invoiceNum = invoiceKey ? String(row[invoiceKey] || '').trim() : '';
        const invoiceDate = invoiceDateKey ? parseExcelDate(row[invoiceDateKey]) : '';
        const currency = currKey ? String(row[currKey] || '').trim() : 'INR';
        
        if (!normalizedAwb) {
          stmtInsertReview.run(
            'AWB missing',
            'UPS',
            '',
            fileName,
            sheet.sheetName,
            sourceRow,
            'A UPS duty row is missing its AWB/tracking number.',
            new Date().toISOString()
          );
          stats.review++;
          continue;
        }
        
        // Find ShipTax matches to determine finalDate and destination country
        let finalDate = '';
        let dateSource = '';
        let shiptaxFound = 0;
        let shiptaxShipDate = '';
        let rawDestCountry = countryKey ? String(row[countryKey] || '').trim() : '';
        let destCountry = rawDestCountry || 'United States';
        
        const shiptaxMatch = findShiptaxMatch(normalizedAwb);
        if (shiptaxMatch) {
          shiptaxFound = 1;
          shiptaxShipDate = (shiptaxMatch.ship_date || '').trim();
          if (shiptaxMatch.country) {
            destCountry = shiptaxMatch.country;
          }
        }
        
        // UPS Rule: Only US/USA/United States destination
        if (!isUS(destCountry)) {
          stats.skipped++;
          rowsSkipped++;
          continue;
        }
        
        // UPS Rule: date ONLY from ShipTax. Never use UPS invoice date as ship date.
        if (shiptaxShipDate) {
          finalDate = shiptaxShipDate;
          dateSource = 'ShipTax';
        }
        
        const chargeMonth = targetMonth || (invoiceDate ? invoiceDate.substring(0, 7) : new Date().toISOString().substring(0, 7));
        
        const signature = `UPS|${normalizedAwb}|${invoiceNum}|${amount}|duty_amount`;
        const signatureExists = stmtGetChargeSig.get(signature);
        if (signatureExists) {
          stats.skipped++;
          rowsSkipped++;
          continue;
        }
        
        let rowStatus = 'accepted';
        if (shiptaxFound === 0) {
          rowStatus = 'needs_review';
          stmtInsertReview.run(
            'AWB not found in ShipTax',
            'UPS',
            normalizedAwb,
            fileName,
            sheet.sheetName,
            sourceRow,
            'AWB not found in ShipTax',
            new Date().toISOString()
          );
          stats.review++;
        } else if (!shiptaxShipDate) {
          rowStatus = 'needs_review';
          stmtInsertReview.run(
            'ShipTax date missing',
            'UPS',
            normalizedAwb,
            fileName,
            sheet.sheetName,
            sourceRow,
            'ShipTax date missing',
            new Date().toISOString()
          );
          stats.review++;
        }
        
        const existingCharge = stmtGetExistingCharge.get(normalizedAwb, 'UPS', 'duty_amount') as any;
        
        if (existingCharge) {
          const existingMonth = existingCharge.charge_month || 'Unknown Month';
          const existingInvoice = existingCharge.invoice_number || 'Unknown Invoice';
          const msgText = `This AWB was already charged in ${existingMonth}/${existingInvoice}/${existingCharge.source_file || 'Unknown'}. It is charged again in ${chargeMonth}/${invoiceNum || 'Unknown'}/${fileName}.`;
          
          stmtInsertDoubleBilling.run(
            normalizedAwb,
            'UPS',
            finalDate || '',
            existingMonth,
            existingInvoice,
            existingCharge.source_file || '',
            chargeMonth,
            invoiceNum,
            fileName,
            amount,
            'DUTY AMOUNT',
            msgText,
            new Date().toISOString()
          );
          stats.double++;
          rowStatus = 'double_billing';
        }
        
        stmtInsertCharge.run(
          signature,
          normalizedAwb,
          String(rawAwb || ''),
          'UPS',
          'DUTY AMOUNT',
          'duty_amount',
          amount,
          currency,
          invoiceNum,
          invoiceDate,
          null,
          finalDate || null,
          dateSource || null,
          shiptaxFound,
          shiptaxShipDate,
          destCountry,
          chargeMonth,
          fileName,
          sheet.sheetName,
          sourceRow,
          rowStatus,
          new Date().toISOString()
        );
        stats.added++;
        rowsAdded++;
      }
    } 
    
    else if (detectedCourier === 'FedEx') {
      const awbKey = findColumn(headerRow, ['airwaybillnumber', 'awb', 'trackingnumber', 'airwaybill']);
      const shipDateFormattedKey = findColumn(headerRow, ['shipdateformatted', 'ship date (formatted)', 'ship date formatted']);
      const shipDateKey = findColumn(headerRow, ['shipdate', 'ship date', 'dateshipped']);
      const tenderedDateKey = findColumn(headerRow, ['tendereddate', 'tendered date', 'datetendered', 'tender date']);
      const invoiceKey = findColumn(headerRow, ['fedexinvoicenumber', 'invoicenumber', 'invoice', 'invno']);
      const invoiceDateKey = findColumn(headerRow, ['invoicedate', 'date']);
      const currKey = findColumn(headerRow, ['currency', 'curr']);
      
      // Check required FedEx columns
      if (!awbKey) missingColumns.push('airway bill number');
      if (!invoiceKey) missingColumns.push('fedex invoice number');
      
      if (missingColumns.length > 0) {
        throw new Error(`Required columns missing in FedEx sheet: ${missingColumns.join(', ')}`);
      }
      
      const rows = buildRowObjects(rawRows, headerIdx);
      
      for (const row of rows) {
        const sourceRow = row._source_row;
        const fedexCharges = extractFedExCharges(row);
        
        for (const charge of fedexCharges) {
          if (!isFedExDuty(charge.label)) {
            continue;
          }
          
          dutyRowsFound++;
          
          const rawAwb = awbKey ? row[awbKey] : '';
          const normalizedAwb = normalizeAWB(rawAwb);
          const invoiceNum = invoiceKey ? String(row[invoiceKey] || '').trim() : '';
          const invoiceDate = invoiceDateKey ? parseExcelDate(row[invoiceDateKey]) : '';
          
          const formattedShipDate = shipDateFormattedKey ? parseExcelDate(row[shipDateFormattedKey]) : '';
          const rawShipDate = shipDateKey ? parseExcelDate(row[shipDateKey]) : '';
          const tenderedDate = tenderedDateKey ? parseExcelDate(row[tenderedDateKey]) : '';
          
          const currency = currKey ? String(row[currKey] || '').trim() : 'INR';
          const chargeTypeKey = charge.label.toLowerCase().replace(/[^a-z0-9]/g, '_');
          
          if (!normalizedAwb) {
            stmtInsertReview.run(
              'AWB missing',
              'FedEx',
              '',
              fileName,
              sheet.sheetName,
              sourceRow,
              `A FedEx ${charge.label} row is missing its AWB/tracking number.`,
              new Date().toISOString()
            );
            stats.review++;
            continue;
          }
          
          let finalDate = '';
          let dateSource = '';
          let shiptaxFound = 0;
          let shiptaxShipDate = '';
          let destCountry = '';
          
          const shiptaxMatch = findShiptaxMatch(normalizedAwb);
          if (shiptaxMatch) {
            shiptaxFound = 1;
            shiptaxShipDate = shiptaxMatch.ship_date || '';
            destCountry = shiptaxMatch.country || '';
          }
          
          // FedEx date priority:
          // 1. Ship Date (formatted)
          // 2. Ship Date
          // 3. Tendered Date
          // 4. ShipTax ship date if available
          if (formattedShipDate) {
            finalDate = formattedShipDate;
            dateSource = 'FedEx Ship Date (formatted)';
          } else if (rawShipDate) {
            finalDate = rawShipDate;
            dateSource = 'FedEx Ship Date';
          } else if (tenderedDate) {
            finalDate = tenderedDate;
            dateSource = 'FedEx Tendered Date';
          } else if (shiptaxShipDate) {
            finalDate = shiptaxShipDate;
            dateSource = 'ShipTax';
          }
          
          const courierShipDate = formattedShipDate || rawShipDate || tenderedDate || '';
          const chargeMonth = targetMonth || (invoiceDate ? invoiceDate.substring(0, 7) : new Date().toISOString().substring(0, 7));
          
          const signature = `FedEx|${normalizedAwb}|${invoiceNum}|${charge.amount}|${chargeTypeKey}`;
          const signatureExists = stmtGetChargeSig.get(signature);
          if (signatureExists) {
            stats.skipped++;
            rowsSkipped++;
            continue;
          }
          
          let rowStatus = 'accepted';
          if (!finalDate) {
            rowStatus = 'needs_review';
            stmtInsertReview.run(
              'Ship date missing',
              'FedEx',
              normalizedAwb,
              fileName,
              sheet.sheetName,
              sourceRow,
              `Could not find a reliable date from FedEx courier ship date or ShipTax.`,
              new Date().toISOString()
            );
            stats.review++;
          }
          
          const existingCharge = stmtGetExistingCharge.get(normalizedAwb, 'FedEx', chargeTypeKey) as any;
          
          if (existingCharge) {
            const existingMonth = existingCharge.charge_month || 'Unknown Month';
            const existingInvoice = existingCharge.invoice_number || 'Unknown Invoice';
            const msgText = `This AWB was already charged in ${existingMonth}/${existingInvoice}/${existingCharge.source_file || 'Unknown'}. It is charged again in ${chargeMonth}/${invoiceNum || 'Unknown'}/${fileName}.`;
            
            stmtInsertDoubleBilling.run(
              normalizedAwb,
              'FedEx',
              finalDate || shiptaxShipDate || '',
              existingMonth,
              existingInvoice,
              existingCharge.source_file || '',
              chargeMonth,
              invoiceNum,
              fileName,
              charge.amount,
              charge.label,
              msgText,
              new Date().toISOString()
            );
            stats.double++;
            rowStatus = 'double_billing';
          }
          
          stmtInsertCharge.run(
            signature,
            normalizedAwb,
            String(rawAwb || ''),
            'FedEx',
            charge.label,
            chargeTypeKey,
            charge.amount,
            currency,
            invoiceNum,
            invoiceDate,
            courierShipDate,
            finalDate || null,
            dateSource || null,
            shiptaxFound,
            shiptaxShipDate,
            destCountry,
            chargeMonth,
            fileName,
            sheet.sheetName,
            sourceRow,
            rowStatus,
            new Date().toISOString()
          );
          stats.added++;
          rowsAdded++;
        }
      }
    }
    
    debugReports.push({
      fileName,
      sheetName: sheet.sheetName,
      courier: detectedCourier,
      rowsScanned,
      headerRowFound: `Row ${headerIdx + 1} (Score: ${score})`,
      dutyRowsFound,
      rowsAdded,
      rowsSkipped,
      missingColumns
    });
  }
  })();
  
  return { ...stats, debug: debugReports };
}

export function normalizeCustomerHeader(h: any): string {
  if (h === undefined || h === null) return '';
  let str = String(h).toLowerCase();
  // remove dots and punctuation
  str = str.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?|[\]'"]/g, '');
  // convert multiple spaces to one space
  str = str.replace(/\s+/g, ' ');
  return str.trim();
}

export function findCustomerColumn(headerRow: any[], aliases: string[]): string | null {
  if (!headerRow || headerRow.length === 0) return null;
  
  const normalizedAliases = aliases.map(a => normalizeCustomerHeader(a));
  const normalizedAliasesNoSpaces = normalizedAliases.map(a => a.replace(/\s+/g, ''));
  
  // First pass: exact normalized match (with spaces preserved)
  for (const cell of headerRow) {
    if (cell === undefined || cell === null) continue;
    const cellStr = String(cell).trim();
    const norm = normalizeCustomerHeader(cellStr);
    if (!norm) continue;
    
    const idx = normalizedAliases.indexOf(norm);
    if (idx !== -1) {
      return cellStr;
    }
  }
  
  // Second pass: match without spaces
  for (const cell of headerRow) {
    if (cell === undefined || cell === null) continue;
    const cellStr = String(cell).trim();
    const norm = normalizeCustomerHeader(cellStr);
    const normNoSpaces = norm.replace(/\s+/g, '');
    if (!normNoSpaces) continue;
    
    const idx = normalizedAliasesNoSpaces.indexOf(normNoSpaces);
    if (idx !== -1) {
      return cellStr;
    }
  }
  
  return null;
}

export async function processCustomerReportFile(
  buffer: Buffer,
  fileName: string
): Promise<{ added: number; updated: number; review: number }> {
  let stats = { added: 0, updated: 0, review: 0 };
  
  if (fileName.toLowerCase().endsWith('.zip')) {
    const zipFiles = await extractZipFiles(buffer);
    for (const zf of zipFiles) {
      const zfStats = await processCustomerReportFile(zf.data, zf.name);
      stats.added += zfStats.added;
      stats.updated += zfStats.updated;
      stats.review += zfStats.review;
    }
    return stats;
  }
  
  const parsedSheets = parseFileBuffer(buffer, fileName);
  
  for (const sheet of parsedSheets) {
    const rawRows = sheet.rawRows;
    if (rawRows.length === 0) continue;
    
    const { headerIdx } = findBestHeaderRow(rawRows);
    const headerRow = rawRows[headerIdx] || [];
    
    // Auto-detect AWB column aliases with custom normalization
    const awbKey = findCustomerColumn(headerRow, [
      'AWB_NO',
      'AWB No',
      'AWB',
      'AWB Number',
      'Tracking no',
      'Tracking no.',
      'Tracking Number',
      'Airway Bill No',
      'Waybill No'
    ]);
    
    // Auto-detect FOB column aliases with custom normalization
    const fobKey = findCustomerColumn(headerRow, [
      'VALUE_OF_THE_SHIPMENT_IN_INR',
      'Value of the Shipment in INR',
      'total value',
      'FOB',
      'FOB Amount',
      'FOB Value',
      'Invoice Value',
      'Shipment Value',
      'Export Value',
      'Amount in INR',
      'FOB Amount (INR)',
      'FOB Amount INR',
      'FOB (INR)',
      'FOB INR',
      'FOB Value (INR)',
      'FOB Value INR',
      'Export Value (INR)',
      'Export Value INR',
      'Invoice Value (INR)',
      'Invoice Value INR',
      'Value of Shipment (INR)',
      'Value of Shipment INR'
    ]);
    
    // Auto-detect invoice/date/country columns if available
    const invoiceKey = findCustomerColumn(headerRow, [
      'invoicenumber',
      'invoice',
      'invno',
      'invnum',
      'invoice no',
      'invoice number',
      'inv no',
      'inv number',
      'invoice_no',
      'invoice_number'
    ]);
    const dateKey = findCustomerColumn(headerRow, [
      'INVOICE_DATE',
      'Invoice Date',
      'Import Date',
      'Departure Date',
      'Shipping Date',
      'SB Date',
      'S.B. Date',
      'SB_Date',
      'Invoice_Date'
    ]);
    const countryKey = findCustomerColumn(headerRow, [
      'RECIPIENT_COUNTRY',
      'Recipient Country',
      'Dest Country',
      'Destination Country',
      'Country',
      'Consignee Country',
      'Consignee_Country',
      'Dest_Country',
      'Recipient_Country'
    ]);
    const sbKey = findCustomerColumn(headerRow, [
      'SB NUMBER',
      'Shipping bill Number',
      'Shipping Bill No',
      'SB No',
      'S.B. No',
      'S.B. Number',
      'S.B. No.',
      'Shipping Bill Number',
      'SB_No',
      'SB_Number'
    ]);
    
    // Custom error prompt if FOB column is not found
    if (!fobKey) {
      const possibleValueCols: string[] = [];
      for (const cell of headerRow) {
        if (cell === undefined || cell === null) continue;
        const cellStr = String(cell);
        const norm = normalizeCustomerHeader(cellStr);
        if (
          norm.includes('value') ||
          norm.includes('amount') ||
          norm.includes('price') ||
          norm.includes('inr') ||
          norm.includes('total') ||
          norm.includes('amt') ||
          norm.includes('val')
        ) {
          possibleValueCols.push(cellStr.trim());
        }
      }
      const possibleList = possibleValueCols.length > 0 ? possibleValueCols.join(', ') : '';
      const promptSuffix = possibleList ? ` I found possible value columns: ${possibleList}. Use this as FOB?` : '';
      throw new Error(`Could not find FOB amount column.${promptSuffix}`);
    }
    
    if (!awbKey) {
      db.prepare(`
        INSERT INTO review (reason, courier, awb, source_file, source_sheet, source_row, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'Missing required AWB column',
        'Customer Report',
        '',
        fileName,
        sheet.sheetName,
        headerIdx + 1,
        `Could not find AWB column.`,
        new Date().toISOString()
      );
      stats.review++;
      continue;
    }
    
    const rows = buildRowObjects(rawRows, headerIdx);
    
    try {
      const debugLogPath = path.join(process.cwd(), 'upload_debug.json');
      let currentLogs: any[] = [];
      if (fs.existsSync(debugLogPath)) {
        try {
          currentLogs = JSON.parse(fs.readFileSync(debugLogPath, 'utf-8'));
          if (!Array.isArray(currentLogs)) currentLogs = [];
        } catch (_) {}
      }
      currentLogs.push({
        timestamp: new Date().toISOString(),
        fileName,
        sheetName: sheet.sheetName,
        headerIdx,
        headerRow,
        detectedKeys: {
          awbKey,
          fobKey,
          invoiceKey,
          dateKey,
          countryKey,
          sbKey
        },
        firstRow: rows[0] || null,
        totalRowsCount: rows.length
      });
      fs.writeFileSync(debugLogPath, JSON.stringify(currentLogs, null, 2));
    } catch (e: any) {
      console.error('[DEBUG_WRITE_ERROR]', e);
    }
    
    const insertStmt = db.prepare(`
      INSERT INTO customer_fob (awb, original_awb, fob_inr, invoice_number, invoice_date, country, shipping_bill, source_file, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(awb) DO UPDATE SET
        original_awb=excluded.original_awb,
        fob_inr=excluded.fob_inr,
        invoice_number=excluded.invoice_number,
        invoice_date=excluded.invoice_date,
        country=excluded.country,
        shipping_bill=excluded.shipping_bill,
        source_file=excluded.source_file,
        created_at=excluded.created_at
    `);
    
    for (const row of rows) {
      const rawAwb = row[awbKey];
      const normalizedAwb = normalizeAWB(rawAwb);
      const sourceRow = row._source_row;
      
      if (!normalizedAwb) {
        db.prepare(`
          INSERT INTO review (reason, courier, awb, source_file, source_sheet, source_row, message, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'AWB missing in row',
          'Customer Report',
          '',
          fileName,
          sheet.sheetName,
          sourceRow,
          'The AWB value is blank or empty in this customer report row.',
          new Date().toISOString()
        );
        stats.review++;
        continue;
      }
      
      const rawFob = row[fobKey];
      const fobInr = parseAmount(rawFob);
      
      const invoiceNum = invoiceKey ? String(row[invoiceKey] || '').trim() : '';
      const invoiceDate = dateKey ? parseExcelDate(row[dateKey]) : '';
      const country = countryKey ? String(row[countryKey] || '').trim() : '';
      const shippingBill = sbKey ? String(row[sbKey] || '').trim() : '';
      
      try {
        insertStmt.run(
          normalizedAwb,
          String(rawAwb || ''),
          isNaN(fobInr) ? null : fobInr,
          invoiceNum || null,
          invoiceDate || null,
          country || null,
          shippingBill || null,
          fileName,
          new Date().toISOString()
        );
        stats.added++;
        
        // Secondary digit-only insertion to allow robust bi-directional SQL JOINs
        const digitsOnly = normalizedAwb.replace(/[^0-9]/g, '');
        if (digitsOnly && digitsOnly !== normalizedAwb) {
          insertStmt.run(
            digitsOnly,
            String(rawAwb || ''),
            isNaN(fobInr) ? null : fobInr,
            invoiceNum || null,
            invoiceDate || null,
            country || null,
            shippingBill || null,
            fileName,
            new Date().toISOString()
          );
        }
      } catch (err: any) {
        stats.review++;
        db.prepare(`
          INSERT INTO review (reason, courier, awb, source_file, source_sheet, source_row, message, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'FOB Row Error',
          'Customer Report',
          normalizedAwb,
          fileName,
          sheet.sheetName,
          sourceRow,
          `Failed to save FOB record: ${err.message}`,
          new Date().toISOString()
        );
      }
    }
  }
  
  return stats;
}
