import * as XLSX from 'xlsx';

export interface CustomRateMapping {
  zoneSheetName: string;
  countryCol: string | number;
  zoneCol: string | number;
  
  rateSheetName: string;
  weightCol: string | number;
  zoneRateCols: string[]; // e.g. ["Zone 1", "Zone 2"] or ["1", "2"]
}

export interface ParsedSummary {
  courier: string;
  countriesCount: number;
  zonesCount: number;
  weightSlabsCount: number;
  status: 'Success' | 'Error' | 'Pending Mapping';
  message: string;
}

// Normalize country names for lookups
export function normalizeCountry(name: string): string {
  if (!name) return '';
  return String(name)
    .replace(/\s*\([^)]*\)/g, '') // Remove parentheses and content (e.g. "(TH)")
    .trim()
    .toLowerCase();
}

// Extract country code if present in parentheses (e.g. "Thailand (TH)" -> "TH")
export function extractCountryCode(name: string): string {
  if (!name) return '';
  const match = String(name).match(/\(([^)]+)\)/);
  if (match && match[1]) {
    return match[1].trim().toUpperCase();
  }
  // If the whole string is 2-3 characters and uppercase, treat it as a code
  const trimmed = name.trim();
  if (trimmed.length <= 3 && trimmed === trimmed.toUpperCase()) {
    return trimmed;
  }
  return '';
}

/**
 * Helper to detect country-zone mapping sheet by structure
 */
function detectZoneSheet(sheets: { sheetName: string; rawRows: any[][] }[]) {
  for (const sheet of sheets) {
    const rows = sheet.rawRows;
    if (rows.length < 5) continue;
    
    let countryColIdx = -1;
    let zoneColIdx = -1;
    
    // Scan the first 30 rows for headers
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const row = rows[i];
      if (!row) continue;
      for (let colIdx = 0; colIdx < row.length; colIdx++) {
        const val = String(row[colIdx]).trim().toLowerCase();
        if (
          val === 'country' || 
          val === 'destination' || 
          val.includes('country') || 
          val.includes('destination') || 
          val.includes('dest')
        ) {
          countryColIdx = colIdx;
        }
        if (val === 'zone' || val.includes('zone')) {
          zoneColIdx = colIdx;
        }
      }
      if (countryColIdx !== -1 && zoneColIdx !== -1) {
        break;
      }
    }
    
    if (countryColIdx !== -1 && zoneColIdx !== -1) {
      // Must contain multiple valid country-zone rows
      let validRowsCount = 0;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length <= Math.max(countryColIdx, zoneColIdx)) continue;
        const countryRaw = String(row[countryColIdx]).trim();
        const zoneRaw = String(row[zoneColIdx]).trim();
        if (countryRaw && zoneRaw) {
          const lowerCountry = countryRaw.toLowerCase();
          if (
            lowerCountry.includes('country') || 
            lowerCountry.includes('destination') || 
            lowerCountry.includes('zone') || 
            /^\d+$/.test(countryRaw)
          ) {
            continue;
          }
          validRowsCount++;
        }
      }
      if (validRowsCount >= 3) {
        return { sheetName: sheet.sheetName, countryColIdx, zoneColIdx };
      }
    }
  }
  return null;
}

/**
 * Helper to detect rates sheet by structure
 */
function detectRateSheet(sheets: { sheetName: string; rawRows: any[][] }[], zoneSheetName: string) {
  for (const sheet of sheets) {
    if (sheet.sheetName === zoneSheetName) continue; // Don't use the zone sheet
    
    const rows = sheet.rawRows;
    if (rows.length < 5) continue;
    
    let weightColIdx = -1;
    let zoneColsCount = 0;
    
    // Scan first 30 rows for header
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const row = rows[i];
      if (!row) continue;
      
      let foundWeight = -1;
      let zonesFound = 0;
      
      for (let colIdx = 0; colIdx < row.length; colIdx++) {
        const val = String(row[colIdx]).trim().toLowerCase();
        if (
          val === 'weight' || 
          val === 'kg' || 
          val === 'wgt' || 
          val.includes('weight') || 
          val.includes('kg') || 
          val === 'weight (kg)'
        ) {
          foundWeight = colIdx;
        } else {
          const zoneMatch = val.match(/zone\s*(\w+)/i) || val.match(/^(\d+)$/);
          if (zoneMatch) {
            zonesFound++;
          }
        }
      }
      
      if (foundWeight !== -1 && zonesFound >= 2) {
        weightColIdx = foundWeight;
        zoneColsCount = zonesFound;
        break;
      }
    }
    
    if (weightColIdx !== -1 && zoneColsCount >= 2) {
      return { sheetName: sheet.sheetName, weightColIdx };
    }
  }
  return null;
}

/**
 * Internal parser implementation once sheet objects are resolved
 */
function parseDhlWithSheets(
  zoneSheet: { sheetName: string; rawRows: any[][] },
  rateSheet: { sheetName: string; rawRows: any[][] }
) {
  // --- Parse Mappings ---
  const zones: { country: string; code: string; zone: string }[] = [];
  const zoneRows = zoneSheet.rawRows;
  let countryColIdx = -1;
  let zoneColIdx = -1;

  // Find header for zones
  for (let i = 0; i < Math.min(zoneRows.length, 30); i++) {
    const row = zoneRows[i];
    if (!row) continue;
    for (let colIdx = 0; colIdx < row.length; colIdx++) {
      const val = String(row[colIdx]).trim().toLowerCase();
      if (val.includes('country') || val.includes('destination')) {
        countryColIdx = colIdx;
      }
      if (
        val.includes('zone') && 
        (
          val.includes('tdi') || 
          val.includes('export') || 
          val.includes('ww') || 
          val.includes('worldwide') || 
          val.includes('mapping') || 
          val.toLowerCase() === 'zone'
        )
      ) {
        zoneColIdx = colIdx;
      }
    }
    if (countryColIdx !== -1 && zoneColIdx !== -1) {
      break;
    }
  }

  // Smart fallback for zone headers
  if (countryColIdx === -1 || zoneColIdx === -1) {
    countryColIdx = 0;
    zoneColIdx = 1;
  }

  // Read country mapping rows
  for (let i = 1; i < zoneRows.length; i++) {
    const row = zoneRows[i];
    if (!row || row.length <= Math.max(countryColIdx, zoneColIdx)) continue;
    
    const countryRaw = String(row[countryColIdx]).trim();
    const zoneRaw = String(row[zoneColIdx]).trim();
    const countryRawLower = countryRaw.toLowerCase();
    
    if (
      !countryRaw || 
      countryRawLower.includes('country') || 
      countryRawLower.includes('destination') ||
      countryRawLower === '#n/a' ||
      countryRawLower === 'n/a' ||
      countryRawLower.includes('#ref') ||
      countryRawLower.includes('#value')
    ) {
      continue;
    }
    
    // Normalize zone
    let cleanZone = zoneRaw.toUpperCase().replace('ZONE', '').trim();
    // If it's a number like "02", parse to "2"
    if (/^\d+$/.test(cleanZone)) {
      cleanZone = String(parseInt(cleanZone, 10));
    }

    if (countryRaw && cleanZone) {
      zones.push({
        country: countryRaw,
        code: extractCountryCode(countryRaw),
        zone: cleanZone
      });
    }
  }

  // --- Parse Rates ---
  const rates: any[] = [];
  const rateRows = rateSheet.rawRows;

  let currentSection: 'Document' | 'Non-document' = 'Document';
  let zoneColIndices: Record<string, number> = {};
  let weightColIdx = 0;

  for (let i = 0; i < rateRows.length; i++) {
    const row = rateRows[i];
    if (!row || row.length === 0) continue;

    // Detect section switch
    const rowStr = row.map(cell => String(cell).toLowerCase()).join(' ');
    
    // If there is any indicator that we've switched to non-document rates
    if (
      rowStr.includes('non-doc') || 
      rowStr.includes('non document') || 
      rowStr.includes('express worldwide') || 
      rowStr.includes('package') ||
      rowStr.includes('ww')
    ) {
      currentSection = 'Non-document';
    } else if (rowStr.includes('doc up to') || (rowStr.includes('document') && !rowStr.includes('non-document') && i < 15)) {
      currentSection = 'Document';
    }

    // Detect header row containing Zone 1, Zone 2...
    if (rowStr.includes('weight') || rowStr.includes('kg')) {
      zoneColIndices = {};
      for (let colIdx = 0; colIdx < row.length; colIdx++) {
        const val = String(row[colIdx]).trim().toLowerCase();
        if (val.includes('weight') || val.includes('kg')) {
          weightColIdx = colIdx;
        }
        
        // Find zone headers like "Zone 1", "1", "Zone 2", "2"
        const zoneMatch = val.match(/zone\s*(\w+)/i) || val.match(/^(\d+)$/);
        if (zoneMatch) {
          const zoneNum = zoneMatch[1].toUpperCase();
          zoneColIndices[zoneNum] = colIdx;
        }
      }
      continue;
    }

    // If we have parsed zone columns, let's look for weight rows
    if (Object.keys(zoneColIndices).length > 0) {
      const weightVal = row[weightColIdx];
      if (weightVal === null || weightVal === undefined || String(weightVal).trim() === '') continue;

      const weightStr = String(weightVal).trim();
      
      let isPerKg = 0;
      let minW = 0;
      let maxW = 9999;
      let weightSlab = 0;

      // Check if it matches a per-kg slab
      const match30 = weightStr.match(/30\.1|31\s*-\s*70/i) || (weightStr.includes('30.1') && weightStr.includes('70'));
      const match70 = weightStr.match(/70\.1|71\s*-\s*300/i) || (weightStr.includes('70.1') && weightStr.includes('300'));
      const match300 = weightStr.match(/300\.1|301|300\s*\+/i) || weightStr.includes('300+') || weightStr.includes('300.1');

      if (match30) {
        isPerKg = 1;
        minW = 30.1;
        maxW = 70.0;
        weightSlab = 30.1;
      } else if (match70) {
        isPerKg = 1;
        minW = 70.1;
        maxW = 300.0;
        weightSlab = 70.1;
      } else if (match300) {
        isPerKg = 1;
        minW = 300.1;
        maxW = 9999.0;
        weightSlab = 300.1;
      } else {
        // Check if it's any general hyphen/range indicating a per-kg band
        const rangeMatch = weightStr.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/);
        if (rangeMatch) {
          isPerKg = 1;
          minW = parseFloat(rangeMatch[1]);
          maxW = parseFloat(rangeMatch[2]);
          weightSlab = minW;
        } else if (
          weightStr.includes('+') || 
          weightStr.toLowerCase().includes('above') || 
          weightStr.toLowerCase().includes('per kg') || 
          weightStr.toLowerCase().includes('multi')
        ) {
          isPerKg = 1;
          const numMatch = weightStr.match(/(\d+(?:\.\d+)?)/);
          if (numMatch) {
            minW = parseFloat(numMatch[1]);
            maxW = 9999;
            weightSlab = minW;
          } else {
            minW = 100;
            maxW = 9999;
            weightSlab = 100;
          }
        } else {
          // Regular numeric weight slab
          const numWeight = parseFloat(weightStr.replace(/[^0-9.]/g, ''));
          if (isNaN(numWeight)) continue;
          isPerKg = 0;
          weightSlab = numWeight;
          minW = numWeight;
          maxW = numWeight;
        }
      }

      // Read rates for each zone
      const ratesJson: Record<string, number> = {};
      let hasValidRate = false;

      for (const [zone, colIdx] of Object.entries(zoneColIndices)) {
        if (colIdx < row.length) {
          const rawRate = row[colIdx];
          const rateNum = parseFloat(String(rawRate).replace(/[^0-9.]/g, ''));
          if (!isNaN(rateNum) && rateNum > 0) {
            ratesJson[zone] = rateNum;
            // Also store as "Zone X" so it maps perfectly
            ratesJson[`ZONE ${zone}`] = rateNum;
            hasValidRate = true;
          }
        }
      }

      if (hasValidRate) {
        rates.push({
          shipment_type: currentSection,
          weight_slab: weightSlab,
          is_per_kg: isPerKg,
          min_weight: minW,
          max_weight: maxW,
          rates_json: ratesJson
        });
      }
    }
  }

  if (zones.length === 0) {
    throw new Error(`No country mappings parsed. Please check "${zoneSheet.sheetName}" format.`);
  }
  if (rates.length === 0) {
    throw new Error(`No rate slabs parsed. Please check "${rateSheet.sheetName}" format.`);
  }

  return { zones, rates };
}

/**
 * 1. Strict DHL rate parser
 */
export function parseDhl(
  sheets: { sheetName: string; rawRows: any[][] }[],
  options?: { confirmed?: boolean }
): {
  zones: { country: string; code: string; zone: string }[];
  rates: {
    shipment_type: 'Document' | 'Non-document';
    weight_slab: number;
    is_per_kg: number;
    min_weight: number;
    max_weight: number;
    rates_json: Record<string, number>;
  }[];
  isDetectedByStructure?: boolean;
  detectedZoneSheet?: string;
  detectedRateSheet?: string;
} {
  const cleanSheetName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

  const zoneNamesList = ['in zones tdi export', 'country zones', 'zones', 'country list'].map(n => n.toLowerCase());
  const rateNamesList = ['in td exp ww', 'rates', 'rate chart', 'tariff matrix'].map(n => n.toLowerCase());

  // 1. First search by known sheet names (case-insensitive, ignore extra spaces)
  let zoneSheet = sheets.find(s => zoneNamesList.includes(cleanSheetName(s.sheetName)));
  let rateSheet = sheets.find(s => rateNamesList.includes(cleanSheetName(s.sheetName)));

  let isDetectedByStructure = false;

  if (!zoneSheet || !rateSheet) {
    // 2. Fallback to inspect all sheets automatically based on structure
    const detectedZone = detectZoneSheet(sheets);
    const detectedRate = detectedZone ? detectRateSheet(sheets, detectedZone.sheetName) : null;

    if (detectedZone && detectedRate) {
      zoneSheet = sheets.find(s => s.sheetName === detectedZone.sheetName);
      rateSheet = sheets.find(s => s.sheetName === detectedRate.sheetName);
      isDetectedByStructure = true;
    }
  }

  // Exact names if found specifically, otherwise generic message
  if (!zoneSheet) {
    throw new Error('Missing sheet "IN Zones TDI Export" for DHL country-to-zone mapping.');
  }
  if (!rateSheet) {
    throw new Error('Missing sheet "IN TD Exp WW" for DHL rate table.');
  }

  // If detected by structure, and not confirmed, prompt the user with preview
  if (isDetectedByStructure && (!options || !options.confirmed)) {
    const previewData = parseDhlWithSheets(zoneSheet, rateSheet);
    
    const err: any = new Error(`Expected DHL sheet name not found. A compatible sheet was detected as ${zoneSheet.sheetName}. Please confirm.`);
    err.code = 'CONFIRMATION_REQUIRED';
    err.zoneSheetName = zoneSheet.sheetName;
    err.rateSheetName = rateSheet.sheetName;
    err.preview = {
      zones: previewData.zones.slice(0, 5),
      rates: previewData.rates.slice(0, 5).map(r => ({
        shipment_type: r.shipment_type,
        weight_slab: r.weight_slab,
        is_per_kg: r.is_per_kg,
        rates_count: Object.keys(r.rates_json).length
      }))
    };
    throw err;
  }

  return {
    ...parseDhlWithSheets(zoneSheet, rateSheet),
    isDetectedByStructure,
    detectedZoneSheet: zoneSheet.sheetName,
    detectedRateSheet: rateSheet.sheetName
  };
}

/**
 * 2. Automatic and Manual Generic Rate Parser (for FedEx, UPS, or custom formats)
 */
export function parseGeneric(
  sheets: { sheetName: string; rawRows: any[][] }[],
  courier: string,
  mapping?: CustomRateMapping
): {
  zones: { country: string; code: string; zone: string }[];
  rates: {
    shipment_type: 'Document' | 'Non-document';
    weight_slab: number;
    is_per_kg: number;
    min_weight: number;
    max_weight: number;
    rates_json: Record<string, number>;
  }[];
} {
  // If no mapping is supplied, let's try to automatically detect it!
  if (!mapping) {
    mapping = autoDetectMapping(sheets);
  }

  if (!mapping) {
    // If auto-detect fails, throw specific error with details of sheets to help the frontend render manual picker
    const sheetsSummary = sheets.map(s => {
      const cols = s.rawRows[0] || [];
      return {
        name: s.sheetName,
        columns: cols.map((c, idx) => String(c || `Col ${idx + 1}`).trim())
      };
    });

    throw {
      code: 'DETECTION_FAILED',
      message: 'I could not detect the rate table automatically. Please map columns manually.',
      sheets: sheetsSummary
    };
  }

  // --- Parse Zones ---
  const zoneSheet = sheets.find(s => s.sheetName === mapping!.zoneSheetName);
  if (!zoneSheet) {
    throw new Error(`Sheet "${mapping.zoneSheetName}" not found in uploaded file.`);
  }

  const zoneRows = zoneSheet.rawRows;
  const zones: { country: string; code: string; zone: string }[] = [];

  // Resolve column index for country and zone
  let countryColIdx = typeof mapping.countryCol === 'number' ? mapping.countryCol : -1;
  let zoneColIdx = typeof mapping.zoneCol === 'number' ? mapping.zoneCol : -1;

  if (countryColIdx === -1 || zoneColIdx === -1) {
    // Search headers
    const headers = zoneRows[0] || [];
    for (let c = 0; c < headers.length; c++) {
      const colVal = String(headers[c]).trim().toLowerCase();
      if (countryColIdx === -1 && (colVal === String(mapping.countryCol).toLowerCase() || colVal.includes('country') || colVal.includes('dest'))) {
        countryColIdx = c;
      }
      if (zoneColIdx === -1 && (colVal === String(mapping.zoneCol).toLowerCase() || colVal.includes('zone'))) {
        zoneColIdx = c;
      }
    }
  }

  if (countryColIdx === -1) countryColIdx = 0;
  if (zoneColIdx === -1) zoneColIdx = 1;

  for (let i = 1; i < zoneRows.length; i++) {
    const row = zoneRows[i];
    if (!row || row.length <= Math.max(countryColIdx, zoneColIdx)) continue;
    
    const countryRaw = String(row[countryColIdx]).trim();
    const zoneRaw = String(row[zoneColIdx]).trim();
    const countryRawLower = countryRaw.toLowerCase();
    
    if (
      !countryRaw || 
      countryRawLower.includes('country') || 
      countryRawLower.includes('destination') ||
      countryRawLower === '#n/a' ||
      countryRawLower === 'n/a' ||
      countryRawLower.includes('#ref') ||
      countryRawLower.includes('#value')
    ) {
      continue;
    }
    
    let cleanZone = zoneRaw.toUpperCase().replace('ZONE', '').trim();
    if (/^\d+$/.test(cleanZone)) {
      cleanZone = String(parseInt(cleanZone, 10));
    }

    if (countryRaw && cleanZone) {
      zones.push({
        country: countryRaw,
        code: extractCountryCode(countryRaw),
        zone: cleanZone
      });
    }
  }

  // --- Parse Rates ---
  const rateSheet = sheets.find(s => s.sheetName === mapping!.rateSheetName);
  if (!rateSheet) {
    throw new Error(`Sheet "${mapping.rateSheetName}" not found in uploaded file.`);
  }

  const rateRows = rateSheet.rawRows;
  const rates: any[] = [];

  let weightColIdx = typeof mapping.weightCol === 'number' ? mapping.weightCol : -1;
  let zoneColMap: Record<string, number> = {}; // zoneName -> colIndex

  // Resolve weight column and rate columns
  const firstRow = rateRows[0] || [];
  if (weightColIdx === -1) {
    for (let c = 0; c < firstRow.length; c++) {
      const colVal = String(firstRow[c]).trim().toLowerCase();
      if (colVal === String(mapping.weightCol).toLowerCase() || colVal.includes('weight') || colVal.includes('kg')) {
        weightColIdx = c;
        break;
      }
    }
    if (weightColIdx === -1) weightColIdx = 0;
  }

  // Map zone rate columns
  for (const zoneName of mapping.zoneRateCols) {
    const cleanZName = zoneName.toUpperCase().replace('ZONE', '').trim();
    for (let c = 0; c < firstRow.length; c++) {
      const colVal = String(firstRow[c]).trim().toUpperCase();
      if (colVal === zoneName.toUpperCase() || colVal.replace('ZONE', '').trim() === cleanZName || colVal.includes(`ZONE ${cleanZName}`) || colVal.includes(`ZONE_${cleanZName}`)) {
        zoneColMap[cleanZName] = c;
        break;
      }
    }
  }

  // Fallback map of zone columns if list of custom columns is empty
  if (Object.keys(zoneColMap).length === 0) {
    for (let c = 0; c < firstRow.length; c++) {
      if (c === weightColIdx) continue;
      const colVal = String(firstRow[c]).trim().toUpperCase();
      const zoneMatch = colVal.match(/ZONE\s*(\w+)/i) || colVal.match(/^(\w+)$/);
      if (zoneMatch) {
        const zoneNum = zoneMatch[1];
        zoneColMap[zoneNum] = c;
      }
    }
  }

  // Process rows
  for (let i = 1; i < rateRows.length; i++) {
    const row = rateRows[i];
    if (!row || row.length <= weightColIdx) continue;

    const weightVal = row[weightColIdx];
    if (weightVal === null || weightVal === undefined || String(weightVal).trim() === '') continue;

    const weightStr = String(weightVal).trim();
    
    let isPerKg = 0;
    let minW = 0;
    let maxW = 9999;
    let weightSlab = 0;

    // Detect per-kg range or multiplier slabs
    const hasRangeIndicator = weightStr.includes('-') || weightStr.includes('+') || weightStr.includes('above') || weightStr.toLowerCase().includes('per');
    
    if (hasRangeIndicator) {
      isPerKg = 1;
      
      // Parse out numerical bounds (e.g. "30.1-70", "70.1-300", "300+")
      const nums = weightStr.match(/\d+(\.\d+)?/g);
      if (nums && nums.length > 0) {
        minW = parseFloat(nums[0]);
        maxW = nums.length > 1 ? parseFloat(nums[1]) : 9999;
        weightSlab = minW;
      } else {
        // Guess default multiplier threshold
        minW = 31;
        maxW = 9999;
        weightSlab = 31;
      }
    } else {
      const numWeight = parseFloat(weightStr.replace(/[^0-9.]/g, ''));
      if (isNaN(numWeight)) continue;
      isPerKg = 0;
      weightSlab = numWeight;
      minW = numWeight;
      maxW = numWeight;
    }

    const ratesJson: Record<string, number> = {};
    let hasValidRate = false;

    for (const [zone, colIdx] of Object.entries(zoneColMap)) {
      if (colIdx < row.length) {
        const rawRate = row[colIdx];
        const rateNum = parseFloat(String(rawRate).replace(/[^0-9.]/g, ''));
        if (!isNaN(rateNum) && rateNum > 0) {
          ratesJson[zone] = rateNum;
          ratesJson[`ZONE ${zone}`] = rateNum;
          hasValidRate = true;
        }
      }
    }

    if (hasValidRate) {
      // For general parsing, map to Non-document by default, or split based on weight threshold
      // E.g., if weight <= 2 and document is supported
      const isDocument = weightSlab <= 2.0;
      rates.push({
        shipment_type: isDocument ? 'Document' : 'Non-document',
        weight_slab: weightSlab,
        is_per_kg: isPerKg,
        min_weight: minW,
        max_weight: maxW,
        rates_json: ratesJson
      });
    }
  }

  if (zones.length === 0) {
    throw new Error('No country mappings parsed from generic file.');
  }
  if (rates.length === 0) {
    throw new Error('No rate slabs parsed from generic file.');
  }

  return { zones, rates };
}

/**
 * Smart automatic detection helper for Custom / Generic sheets
 */
function autoDetectMapping(sheets: { sheetName: string; rawRows: any[][] }[]): CustomRateMapping | undefined {
  let zoneSheetName = '';
  let rateSheetName = '';
  
  let countryCol: string | number = '';
  let zoneCol: string | number = '';
  let weightCol: string | number = '';
  const zoneRateCols: string[] = [];

  // 1. Try to find Zone Sheet
  const zoneSheet = sheets.find(s => {
    const name = s.sheetName.toLowerCase();
    return name.includes('zone') || name.includes('country') || name.includes('dest') || name.includes('mapping');
  }) || sheets[0];

  if (zoneSheet) {
    zoneSheetName = zoneSheet.sheetName;
    const firstFewRows = zoneSheet.rawRows.slice(0, 5);
    // Find headers
    for (const row of firstFewRows) {
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        const str = String(row[c]).toLowerCase();
        if (!countryCol && (str.includes('country') || str.includes('destination') || str.includes('dest'))) {
          countryCol = c;
        }
        if (!zoneCol && str.includes('zone') && !str.includes('import')) {
          zoneCol = c;
        }
      }
    }
    // Default fallback
    if (countryCol === '') countryCol = 0;
    if (zoneCol === '') zoneCol = 1;
  }

  // 2. Try to find Rate Sheet
  const rateSheet = sheets.find(s => {
    const name = s.sheetName.toLowerCase();
    return name.includes('rate') || name.includes('price') || name.includes('ww') || name.includes('tariff') || name.includes('express');
  }) || sheets.find(s => s.sheetName !== zoneSheetName) || sheets[0];

  if (rateSheet) {
    rateSheetName = rateSheet.sheetName;
    const firstFewRows = rateSheet.rawRows.slice(0, 5);
    
    // Find headers
    let headerRow: any[] = [];
    for (const row of firstFewRows) {
      if (!row) continue;
      const joined = row.map(cell => String(cell).toLowerCase()).join(' ');
      if (joined.includes('weight') || joined.includes('kg') || joined.includes('zone')) {
        headerRow = row;
        break;
      }
    }
    
    if (headerRow.length === 0) {
      headerRow = rateSheet.rawRows[0] || [];
    }

    for (let c = 0; c < headerRow.length; c++) {
      const str = String(headerRow[c]).trim().toLowerCase();
      if (!weightCol && (str.includes('weight') || str.includes('kg') || str === 'wgt')) {
        weightCol = c;
      } else {
        const zoneMatch = str.toUpperCase().match(/ZONE\s*(\w+)/i) || str.toUpperCase().match(/^(\d+)$/);
        if (zoneMatch) {
          zoneRateCols.push(String(headerRow[c]).trim());
        }
      }
    }

    if (weightCol === '') weightCol = 0;
  }

  if (zoneSheetName && rateSheetName && zoneRateCols.length > 0) {
    return {
      zoneSheetName,
      countryCol,
      zoneCol,
      rateSheetName,
      weightCol,
      zoneRateCols
    };
  }

  return undefined;
}
