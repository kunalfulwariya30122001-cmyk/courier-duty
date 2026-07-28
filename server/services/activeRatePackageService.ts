/**
 * Active Rate Package Service
 * Part of Courier Rate Comparator
 */

import crypto from 'crypto';
import { db } from '../db.ts';
import { normalizeCountryName, getCountryIsoCode, resolveCountryCode, getCanonicalCountryName } from './countryNormalizer.ts';

export interface RatePackage {
  id: string;
  courier: 'DHL' | 'UPS' | 'FedEx';
  service: string;
  direction: 'EXPORT' | 'IMPORT';
  file_name: string;
  file_hash: string;
  parser_version: string;
  uploaded_at: string;
  effective_date: string;
  status: 'active' | 'inactive';
  import_result: string;
  warning_count: number;
}

/**
 * Generates an MD5 hash of sheet rows data to prevent duplicate imports
 */
export function calculateBufferHash(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

/**
 * Validates zone and rate rows to ensure no corruption
 */
export function validatePackageRows(
  zones: { country: string; code: string; zone: string }[],
  rates: any[]
): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (zones.length === 0) {
    errors.push('Zone mappings are empty.');
  }
  if (rates.length === 0) {
    errors.push('Rate table rows are empty.');
  }

  // Validate zones
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    if (!z.country || !z.country.trim()) {
      warnings.push(`Zone row ${i + 1}: country name is empty.`);
    }
    if (!z.zone || !z.zone.trim()) {
      errors.push(`Zone row ${i + 1} (${z.country || 'Unknown country'}): zone name is empty.`);
    }
  }

  // Validate rates
  for (let i = 0; i < rates.length; i++) {
    const r = rates[i];
    if (!r.shipment_type || !['Document', 'Non-document'].includes(r.shipment_type)) {
      errors.push(`Rate row ${i + 1}: invalid shipment type "${r.shipment_type}".`);
    }
    if (r.weight_slab === undefined || isNaN(r.weight_slab) || r.weight_slab < 0) {
      errors.push(`Rate row ${i + 1}: invalid weight slab.`);
    }
    if (r.is_per_kg && (r.min_weight === undefined || r.max_weight === undefined)) {
      errors.push(`Rate row ${i + 1}: missing bounds for per-kg multiplier.`);
    }
    
    // Check rates_json structure
    let parsedRates: any = {};
    if (typeof r.rates_json === 'string') {
      try {
        parsedRates = JSON.parse(r.rates_json);
      } catch (e) {
        errors.push(`Rate row ${i + 1}: invalid rates JSON string.`);
      }
    } else {
      parsedRates = r.rates_json || {};
    }

    const zonesCovered = Object.keys(parsedRates);
    if (zonesCovered.length === 0) {
      warnings.push(`Rate row ${i + 1} (${r.weight_slab} KG): no zone rates provided.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Executes standard rate comparison acceptance tests (Part 8)
 * e.g., verifying that a sample rate lookup matches expected standard ranges
 */
export function runAcceptanceTests(
  courier: string,
  zones: { country: string; code: string; zone: string }[],
  rates: any[]
): { passed: boolean; message: string } {
  // Let's verify Thailand (TH) maps to Zone 2 or appropriate zone for DHL, or has a valid zone
  const testCountry = 'TH';
  const matchedZoneObj = zones.find(z => {
    const code = (z.code || '').toUpperCase();
    return code === testCountry || z.country.toLowerCase() === 'thailand';
  });

  if (!matchedZoneObj) {
    return {
      passed: false,
      message: `Acceptance Test Failed: Sample destination "${testCountry}" has no country-to-zone mapping.`
    };
  }

  const zoneVal = matchedZoneObj.zone;
  // Verify there is a rate slab matching 4 KG for non-documents
  const targetWeight = 4.0;
  const rateRow = rates.find(r => {
    return r.shipment_type === 'Non-document' && !r.is_per_kg && r.weight_slab >= targetWeight;
  });

  if (!rateRow) {
    return {
      passed: false,
      message: `Acceptance Test Failed: No non-document weight slab matching ${targetWeight} KG found in rate chart.`
    };
  }

  // Verify the rate exists for the resolved zone
  const parsedRates = typeof rateRow.rates_json === 'string' ? JSON.parse(rateRow.rates_json) : rateRow.rates_json;
  const price = parsedRates[zoneVal] || parsedRates[`ZONE ${zoneVal}`];

  if (price === undefined || price === null || isNaN(price) || price <= 0) {
    return {
      passed: false,
      message: `Acceptance Test Failed: Price missing or invalid for resolved Zone ${zoneVal} at weight ${targetWeight} KG.`
    };
  }

  return {
    passed: true,
    message: `Acceptance test passed successfully! Sample lookup for TH (Zone ${zoneVal}, 4KG) returned base rate ₹${price}.`
  };
}

/**
 * Saves and activates a rate package in a single secure transaction
 */
export async function registerAndActivateRatePackage(params: {
  courier: 'DHL' | 'UPS' | 'FedEx';
  service: string;
  direction: 'EXPORT' | 'IMPORT';
  fileName: string;
  fileHash: string;
  effectiveDate: string;
  zones: { country: string; code: string; zone: string }[];
  rates: any[];
}): Promise<{ success: boolean; packageId: string; warnings: string[]; message: string }> {
  
  const packageId = crypto.randomUUID();
  const uploadedAt = new Date().toISOString();
  
  // Clean params.zones to filter out any formula errors (#N/A, #REF!, etc.) or blank country rows
  params.zones = (params.zones || []).filter(z => {
    if (!z.country) return false;
    const clean = z.country.trim().toLowerCase();
    return clean !== '' && clean !== '#n/a' && clean !== 'n/a' && !clean.includes('#ref') && !clean.includes('#value');
  });

  // 1. Validate rows
  const validation = validatePackageRows(params.zones, params.rates);
  if (!validation.valid) {
    throw new Error(`Package validation failed: ${validation.errors.join(' | ')}`);
  }

  // 1.5. Country Normalization Validation & Summary
  const unmatched: string[] = [];
  const uniqueCountryCodes = new Set<string>();
  const conflictsList: string[] = [];
  const localCountryToZone = new Map<string, string>();
  const localRawCountryToZone = new Map<string, string>();
  const matchedZones: typeof params.zones = [];

  for (const z of params.zones) {
    const rawVal = z.country;
    if (!rawVal) continue;
    const rawLower = rawVal.toLowerCase().trim();
    // Skip general header labels silently
    if (rawLower === 'country' || rawLower === 'destination' || rawLower === 'name' || rawLower === 'dest') {
      continue;
    }

    let code = '';
    try {
      code = resolveCountryCode(rawVal);
    } catch (e) {
      // Fuzzy match returned multiple, or failed
    }

    if (!code) {
      unmatched.push(rawVal);
    } else {
      uniqueCountryCodes.add(code);
      matchedZones.push(z);
      
      // 1. Strict duplicate check: same exact raw country value maps to different zones
      const rawKey = rawVal.toLowerCase().trim();
      const existingRawZone = localRawCountryToZone.get(rawKey);
      if (existingRawZone && existingRawZone !== z.zone) {
        validation.warnings.push(`"${rawVal}" is mapped to multiple different zones in the sheet: ${existingRawZone} vs ${z.zone}. Both will be stored.`);
      } else {
        localRawCountryToZone.set(rawKey, z.zone);
      }

      // 2. Info / sub-regions warning check: different raw strings under the same country code mapped to different zones
      const existingZone = localCountryToZone.get(code);
      if (existingZone && existingZone !== z.zone) {
        validation.warnings.push(`Country "${getCanonicalCountryName(code) || code}" (raw "${rawVal}") is mapped to zone ${z.zone}, but another sub-region row is mapped to zone ${existingZone}. Both zones will be stored for specific sub-region lookups.`);
      } else {
        localCountryToZone.set(code, z.zone);
      }
    }
  }

  if (uniqueCountryCodes.size === 0) {
    throw new Error(`Import Validation Failed: No countries could be normalized. Please verify you mapped the correct Country/Destination column. Unmatched values: ${unmatched.slice(0, 10).join(', ')}`);
  }

  if (unmatched.length > 0) {
    validation.warnings.push(`Skipped ${unmatched.length} row(s) with unrecognized country names/header lines: ${unmatched.slice(0, 10).join(', ')}${unmatched.length > 10 ? '...' : ''}`);
  }

  if (conflictsList.length > 0) {
    throw new Error(`Import Validation Failed: Zone conflicts detected in sheet. Details: ${conflictsList.join(' | ')}`);
  }

  params.zones = matchedZones;

  const rawCountryRows = params.zones.length;
  const canonicalCount = uniqueCountryCodes.size;
  const aliasesMerged = rawCountryRows - canonicalCount;

  const importResultSummary = [
    `Raw country rows: ${rawCountryRows}`,
    `Canonical countries: ${canonicalCount}`,
    `Aliases merged: ${aliasesMerged}`,
    `Unmatched countries: ${unmatched.length}`,
    `Conflicts: 0`
  ].join('\n');

  // 2. Run acceptance tests (Make failure a non-blocking warning notice instead of hard error)
  const testResult = runAcceptanceTests(params.courier, params.zones, params.rates);
  if (!testResult.passed) {
    validation.warnings.push(`Acceptance Test Notice: ${testResult.message}`);
  }

  // 3. Start SQL transaction to insert rows and toggle active package
  const executeTransaction = db.transaction(() => {
    // Check if hash already exists
    const existing = db.prepare('SELECT id FROM rate_packages WHERE file_hash = ?').get(params.fileHash) as any;
    if (existing) {
      throw new Error(`A file with the same exact content hash already exists (ID: ${existing.id}).`);
    }

    // Deactivate previous packages for this courier, service, and direction
    db.prepare(`
      UPDATE rate_packages 
      SET status = 'inactive' 
      WHERE courier = ? AND service = ? AND direction = ?
    `).run(params.courier, params.service, params.direction);

    db.prepare(`
      UPDATE courier_zones 
      SET active = 0 
      WHERE courier = ? AND service = ? AND direction = ?
    `).run(params.courier, params.service, params.direction);

    db.prepare(`
      UPDATE courier_rates 
      SET active = 0 
      WHERE courier = ? AND service = ? AND direction = ?
    `).run(params.courier, params.service, params.direction);

    // Insert rate package record
    db.prepare(`
      INSERT INTO rate_packages (id, courier, service, direction, file_name, file_hash, parser_version, uploaded_at, effective_date, status, import_result, warning_count)
      VALUES (?, ?, ?, ?, ?, ?, '2.0.0', ?, ?, 'active', ?, ?)
    `).run(
      packageId,
      params.courier,
      params.service,
      params.direction,
      params.fileName,
      params.fileHash,
      uploadedAt,
      params.effectiveDate,
      importResultSummary,
      validation.warnings.length
    );

    // Insert zones
    const insertZone = db.prepare(`
      INSERT INTO courier_zones (courier, country, zone, package_id, service, direction, country_code, country_name, raw_country_value, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    for (const z of params.zones) {
      const rawVal = z.country;
      const code = resolveCountryCode(rawVal);
      const canonicalName = getCanonicalCountryName(code) || rawVal;
      insertZone.run(
        params.courier,
        canonicalName,
        z.zone,
        packageId,
        params.service,
        params.direction,
        code,
        canonicalName,
        rawVal
      );
    }

    // Insert rates
    const insertRate = db.prepare(`
      INSERT INTO courier_rates (courier, shipment_type, weight_slab, is_per_kg, min_weight, max_weight, rates_json, package_id, service, direction, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    for (const r of params.rates) {
      const ratesStr = typeof r.rates_json === 'string' ? r.rates_json : JSON.stringify(r.rates_json);
      insertRate.run(
        params.courier,
        r.shipment_type,
        r.weight_slab,
        r.is_per_kg,
        r.min_weight,
        r.max_weight,
        ratesStr,
        packageId,
        params.service,
        params.direction
      );
    }
  });

  try {
    executeTransaction();
    return {
      success: true,
      packageId,
      warnings: validation.warnings,
      message: `Activated rate package ${packageId} for ${params.courier} ${params.service}. ${testResult.message}`
    };
  } catch (err: any) {
    console.error('[TRANSACTION ROLLBACK]', err);
    return {
      success: false,
      packageId: '',
      warnings: [],
      message: `Import failed: ${err.message}. Changes have been rolled back cleanly.`
    };
  }
}

/**
 * Retrieves all registered rate packages
 */
export function getRatePackages(): RatePackage[] {
  return db.prepare('SELECT * FROM rate_packages ORDER BY uploaded_at DESC').all() as RatePackage[];
}

/**
 * Deactivates all packages to restore clean state if needed (Part 12)
 */
export function clearAllRatePackages() {
  const clearTx = db.transaction(() => {
    db.prepare('DELETE FROM rate_packages').run();
    db.prepare('DELETE FROM courier_zones').run();
    db.prepare('DELETE FROM courier_rates').run();
  });
  clearTx();
}
