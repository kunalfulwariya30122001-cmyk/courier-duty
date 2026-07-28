import * as XLSX from 'xlsx';
import JSZip from 'jszip';

/**
 * REAL-DATA VERIFICATION TARGETS:
 * - ShipTax all real files: 13,584 unique AWBs, 33 blank AWB review rows.
 * - DHL Book7(2).xlsx: 108 duty rows, sum 167,518.57.
 * - DHL Book7(3).xlsx: 305 duty rows, sum 343,520.67.
 * - DHL fwdrequiredinvoicesinexcelformat.zip: 225 duty rows, sum 232,005.74.
 * - FedEx fedex new.zip: 3,616 duty rows, total 8,539,110.30.
 * - UPS HARRY FASHION LLP invoice listing(1).xlsx: 4,231 US duty rows, total 3,095,331.06.
 * - UPS hary fashion(1).xlsx: 2,655 US duty rows, total 1,759,400.68.
 */

export interface FedExCharge {
  label: string;
  amount: number;
}

/**
 * Normalizes an Air Waybill (AWB) or tracking number.
 * Removes spaces, hyphens, quotes, and converts to uppercase letters and digits.
 */
export function normalizeAWB(awb: any): string {
  if (awb === undefined || awb === null) return '';
  let str = String(awb).trim();
  if (str.endsWith('.0')) {
    str = str.slice(0, -2);
  }
  return str.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/**
 * Robustly parses floating point currency amounts, stripping currency symbols, commas, and formatting.
 */
export function parseAmount(val: any): number {
  if (val === undefined || val === null || val === '') return NaN;
  if (typeof val === 'number') return val;
  const str = String(val).trim();
  // Strip currency prefixes/suffixes and commas: e.g. ₹, $, €, £, INR, USD, spaces, commas
  const cleaned = str.replace(/[₹$€£\s,A-Za-z]/g, '');
  return parseFloat(cleaned);
}

/**
 * Decodes and parses dates. Supports:
 * - Excel Serial Numbers (e.g., 46116)
 * - Indian/UK style dates (DD-MM-YYYY or DD/MM/YYYY)
 * - US style dates (MM-DD-YYYY or MM/DD/YYYY)
 * - ISO dates (YYYY-MM-DD)
 * - Compact dates (YYYYMMDD)
 */
export function parseExcelDate(val: any): string {
  if (val === undefined || val === null || val === '') return '';
  
  if (val instanceof Date || Object.prototype.toString.call(val) === '[object Date]') {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  const str = String(val).trim();
  if (!str) return '';

  // Convert string representing serial number to actual float/int
  let numVal = typeof val === 'number' ? val : parseFloat(str);
  if (!isNaN(numVal) && numVal > 30000 && numVal < 60000 && !str.includes('/') && !str.includes('-')) {
    // Excel date serial number
    const date = new Date((numVal - 25569) * 86400 * 1000);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  }

  // Extract the date portion (ignore any time suffix or extra spaces)
  // Check for ISO: YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = str.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }
  
  // Compact Date: YYYYMMDD
  const compactMatch = str.match(/^(\d{8})/);
  if (compactMatch) {
    const s = compactMatch[1];
    return `${s.substring(0, 4)}-${s.substring(4, 6)}-${s.substring(6, 8)}`;
  }

  // Check for DD/MM/YYYY or MM/DD/YYYY or DD-MM-YYYY or MM-DD-YYYY
  const dmyMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (dmyMatch) {
    const part1 = parseInt(dmyMatch[1], 10);
    const part2 = parseInt(dmyMatch[2], 10);
    let yearStr = dmyMatch[3];
    if (yearStr.length === 2) {
      yearStr = "20" + yearStr; // assume 20xx
    }
    const year = yearStr;

    if (part2 > 12) {
      // Second part > 12 must be day: MM/DD/YYYY
      const month = String(part1).padStart(2, '0');
      const day = String(part2).padStart(2, '0');
      return `${year}-${month}-${day}`;
    } else {
      // Default to Indian DMY format: DD-MM-YYYY (or both <= 12, or part1 > 12)
      const day = String(part1).padStart(2, '0');
      const month = String(part2).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  }

  // Fallback normal Date.parse (only for strings not matching slash/dash numeric formats, or strings containing alphabetical month characters)
  if (!/[\/\-]/.test(str) || /[a-zA-Z]/.test(str)) {
    try {
      const d = new Date(str);
      if (!isNaN(d.getTime())) {
        return d.toISOString().split('T')[0];
      }
    } catch (_) {}
  }

  return '';
}

/**
 * Dynamically finds the key in a row that matches any candidate headings,
 * ignoring casing, spacing, and symbols.
 */
/**
 * Dynamically finds the key in a row that matches any candidate headings,
 * ignoring casing, spacing, and symbols. Supports both arrays of headers and objects.
 */
export function findColumn(row: any, candidates: string[]): string | null {
  if (!row) return null;
  let keys: string[] = [];
  if (Array.isArray(row)) {
    keys = row.map(cell => cell !== undefined && cell !== null ? String(cell).trim() : '');
  } else {
    keys = Object.keys(row);
  }
  
  for (const cand of candidates) {
    const normalizedCand = cand.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const key of keys) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normalizedKey === normalizedCand) {
        return key;
      }
    }
  }
  return null;
}

/**
 * Unzips a buffer recursively or extracts files inside.
 */
export async function extractZipFiles(buffer: Buffer): Promise<{ name: string; data: Buffer }[]> {
  const zip = await JSZip.loadAsync(buffer);
  const files: { name: string; data: Buffer }[] = [];
  for (const [relativePath, file] of Object.entries(zip.files)) {
    if (!file.dir) {
      const data = await file.async('nodebuffer');
      files.push({ name: relativePath, data });
    }
  }
  return files;
}

/**
 * Parses CSV files as raw text manually, preserving every cell exactly as written.
 */
export function parseCSVManual(csvText: string): any[][] {
  const result: any[][] = [];
  let currentLine: any[] = [];
  let currentField = '';
  let inQuotes = false;
  
  let text = csvText;
  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
  }
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];
    
    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          currentField += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        currentLine.push(currentField);
        currentField = '';
      } else if (char === '\r') {
        if (nextChar === '\n') {
          i++;
        }
        currentLine.push(currentField);
        result.push(currentLine);
        currentLine = [];
        currentField = '';
      } else if (char === '\n') {
        currentLine.push(currentField);
        result.push(currentLine);
        currentLine = [];
        currentField = '';
      } else {
        currentField += char;
      }
    }
  }
  
  if (currentField !== '' || currentLine.length > 0) {
    currentLine.push(currentField);
    result.push(currentLine);
  }
  
  return result;
}

/**
 * Parses any XLS, XLSX, XLSM, or CSV format into raw rows per sheet (using header: 1).
 */
export function parseFileBuffer(buffer: Buffer, filename: string): { sheetName: string; rawRows: any[][] }[] {
  const isCsv = filename.toLowerCase().endsWith('.csv');
  
  if (isCsv) {
    const text = buffer.toString('utf-8');
    const rawRows = parseCSVManual(text);
    return [{ sheetName: 'CSV', rawRows }];
  }
  
  const readOptions: XLSX.ParsingOptions = { type: 'buffer' };
  const workbook = XLSX.read(buffer, readOptions);
  const results: { sheetName: string; rawRows: any[][] }[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    // Use raw: true in sheet_to_json to get raw values (and avoid any formatted/converted values)
    const rawRows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, defval: '', raw: true });
    results.push({ sheetName, rawRows });
  }
  return results;
}

/**
 * Scans the first 30 rows of a 2D array to find the best header row index based on key columns.
 */
export function findBestHeaderRow(rawRows: any[][]): { headerIdx: number; score: number } {
  let bestIdx = 0;
  let maxScore = -1;
  const limit = Math.min(rawRows.length, 30);
  
  const keywords = new Set([
    'awb', 'airwaybill', 'trackingnumber', 'trackingno', 'trackno', 'dateshipped', 'shipdate', 'shippeddate', 'date', 
    'shippingdate', 'billingdate', 'invdate', 'invoicedate', 'invdt', 'couriername', 'courier', 'carrier', 
    'destinationcountry', 'country', 'destcountry', 'destctry', 'orderreference', 'orderref', 'ref2', 'referencenumber', 
    'reference', 'description', 'product', 'amount', 'chargeamount', 'dutyamount', 'duty', 'invoice', 'invoicenumber', 
    'invno', 'invnum', 'currency', 'curr', 'airwaybillchargelabel', 'chargelabel', 'airwaybillchargeamount'
  ]);

  for (let i = 0; i < limit; i++) {
    const row = rawRows[i];
    if (!row || !Array.isArray(row)) continue;
    
    let score = 0;
    for (const cell of row) {
      if (cell === null || cell === undefined) continue;
      const str = String(cell).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
      if (str) {
        if (keywords.has(str)) {
          score += 1;
        }
        if (str.includes('tracking') || str.includes('airwaybill') || str.includes('invoice') || str.includes('shipdate') || str.includes('dutyamount') || str.includes('chargeamount')) {
          score += 0.5;
        }
      }
    }
    if (score > maxScore) {
      maxScore = score;
      bestIdx = i;
    }
  }
  return { headerIdx: bestIdx, score: maxScore };
}

/**
 * Builds row objects starting from a detected header row index.
 * Deduplicates repeated header names by adding _1, _2, etc. suffix to later occurrences.
 */
export function buildRowObjects(rawRows: any[][], headerIdx: number): any[] {
  const headerRow = rawRows[headerIdx] || [];
  const headers: string[] = [];
  const headerCounts: Record<string, number> = {};
  
  for (const cell of headerRow) {
    if (cell === undefined || cell === null) {
      headers.push('');
      continue;
    }
    const headerStr = String(cell).trim();
    if (headerStr === '') {
      headers.push('');
      continue;
    }
    
    if (headerCounts[headerStr] === undefined) {
      headerCounts[headerStr] = 0;
      headers.push(headerStr);
    } else {
      headerCounts[headerStr]++;
      headers.push(`${headerStr}_${headerCounts[headerStr]}`);
    }
  }
  
  const objects: any[] = [];
  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    const rawRow = rawRows[i];
    if (!rawRow || !Array.isArray(rawRow)) continue;
    
    const isEmpty = rawRow.every(cell => cell === undefined || cell === null || String(cell).trim() === '');
    if (isEmpty) continue;
    
    const obj: any = { _source_row: i + 1 };
    for (let colIdx = 0; colIdx < headers.length; colIdx++) {
      const header = headers[colIdx];
      if (header) {
        obj[header] = rawRow[colIdx] ?? '';
      }
    }
    objects.push(obj);
  }
  return objects;
}

/**
 * DHL duty row checker.
 */
export function isDHLDuty(desc: string): boolean {
  if (!desc) return false;
  const d = desc.trim().toLowerCase();
  return d === 'import export duties' || d === 'import export dut' || d === 'import export duty';
}

/**
 * FedEx duty row checker.
 */
export function isFedExDuty(label: string): boolean {
  if (!label) return false;
  const l = label.trim().toLowerCase();
  return l === 'original duty' || l === 'rebill duty' || l === 'customs duty' || l === 'duty';
}

/**
 * Extracts and pairs repeated labels and amounts for FedEx invoices.
 */
export function extractFedExCharges(row: any): FedExCharge[] {
  const charges: FedExCharge[] = [];
  const keys = Object.keys(row);

  for (const key of keys) {
    const keyLower = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (keyLower.startsWith('airwaybillchargelabel') || keyLower === 'chargelabel') {
      const label = String(row[key] || '').trim();
      if (!label) continue;

      const suffixMatch = key.match(/(_\d+|\.\d+|-\d+)$/);
      const suffix = suffixMatch ? suffixMatch[0] : '';

      const amountKey = keys.find(k => {
        const kLower = k.toLowerCase().replace(/[^a-z0-9]/g, '');
        const hasAmount = kLower.startsWith('airwaybillchargeamount') || kLower === 'chargeamount' || kLower === 'amount';
        if (!hasAmount) return false;
        
        const kSuffixMatch = k.match(/(_\d+|\.\d+|-\d+)$/);
        const kSuffix = kSuffixMatch ? kSuffixMatch[0] : '';
        return kSuffix === suffix;
      });

      if (amountKey) {
        const amount = parseAmount(row[amountKey]);
        if (!isNaN(amount) && amount > 0) {
          charges.push({ label, amount });
        }
      }
    }
  }
  return charges;
}

/**
 * Automatically detects the Courier type based on column headings in the first row.
 */
export function detectCourierFromRow(row: any): string {
  if (!row) return 'UNKNOWN';
  let keys: string[] = [];
  if (Array.isArray(row)) {
    keys = row.map(k => String(k || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
  } else {
    keys = Object.keys(row).map(k => k.toLowerCase().replace(/[^a-z0-9]/g, ''));
  }
  
  if (keys.some(k => k.includes('fedex') || k.includes('airwaybillchargelabel') || k.includes('chargelabel'))) {
    return 'FedEx';
  }
  
  if (keys.some(k => k === 'destctry' || k === 'trackno' || k === 'dutyamount' || k.includes('destctry') || k.includes('trackno') || k.includes('dutyamount'))) {
    return 'UPS';
  }
  
  if (keys.some(k => 
    k === 'refkey3' || 
    k === 'shipmentnumber' || 
    k === 'shipmentdate' || 
    k === 'xc1name' || 
    k === 'xc1charge' || 
    k === 'invoicenumber' ||
    k === 'billingdate' || 
    k === 'shippingdate' || 
    k === 'description' ||
    k === 'awb' ||
    k.includes('refkey3') ||
    k.includes('shipmentnumber') ||
    k.includes('shipmentdate') ||
    k.includes('xc1name') ||
    k.includes('xc1charge') ||
    k.includes('invoicenumber') ||
    k.includes('billingdate') ||
    k.includes('shippingdate')
  )) {
    return 'DHL';
  }

  return 'UNKNOWN';
}
