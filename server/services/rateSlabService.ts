/**
 * Rate Slab Service
 * Part of Courier Rate Comparator
 */

import { db } from '../db.js';

export interface RateRowMatch {
  id: number;
  courier: string;
  shipment_type: 'Document' | 'Non-document';
  weight_slab: number;
  is_per_kg: number;
  min_weight: number;
  max_weight: number;
  rates_json: string;
}

/**
 * Resolves the appropriate rate row from the active rate tables
 */
export function resolveRateRow(params: {
  courier: 'DHL' | 'UPS' | 'FedEx';
  weight: number;
  shipmentType: 'Document' | 'Non-document';
  service: string;
  direction: 'EXPORT' | 'IMPORT';
}): RateRowMatch | null {
  const { courier, weight, shipmentType, service, direction } = params;

  // 1. Determine shipment section to use (Document is only for weights <= 2 KG)
  const sectionToUse = (shipmentType === 'Document' && weight <= 2.0) ? 'Document' : 'Non-document';

  // 2. Fetch the appropriate rate row from active entries
  let rateRow: any = null;

  if (weight <= 30.0) {
    // Flat rate lookup: find the smallest weight slab that is >= weight
    rateRow = db.prepare(`
      SELECT * FROM courier_rates 
      WHERE courier = ? AND shipment_type = ? AND is_per_kg = 0 AND weight_slab >= ? AND active = 1
      ORDER BY weight_slab ASC LIMIT 1
    `).get(courier, sectionToUse, weight);

    // Fallback if shipment_type specific flat rate not found
    if (!rateRow) {
      rateRow = db.prepare(`
        SELECT * FROM courier_rates 
        WHERE courier = ? AND is_per_kg = 0 AND weight_slab >= ? AND active = 1
        ORDER BY weight_slab ASC LIMIT 1
      `).get(courier, weight);
    }
  } else {
    // Multiplier rate lookup: find per-kg range row containing the weight
    rateRow = db.prepare(`
      SELECT * FROM courier_rates 
      WHERE courier = ? AND shipment_type = ? AND is_per_kg = 1 AND ? >= min_weight AND ? <= max_weight AND active = 1
      LIMIT 1
    `).get(courier, sectionToUse, weight, weight);

    // Fallback if shipment_type specific multiplier range not found
    if (!rateRow) {
      rateRow = db.prepare(`
        SELECT * FROM courier_rates 
        WHERE courier = ? AND is_per_kg = 1 AND ? >= min_weight AND ? <= max_weight AND active = 1
        LIMIT 1
      `).get(courier, weight, weight);
    }
    
    // Last-ditch fallback for above 30kg: if no per-kg band is defined, look for the largest per-kg slab available
    if (!rateRow) {
      rateRow = db.prepare(`
        SELECT * FROM courier_rates 
        WHERE courier = ? AND is_per_kg = 1 AND active = 1
        ORDER BY min_weight DESC LIMIT 1
      `).get(courier);
    }
  }

  return rateRow as RateRowMatch || null;
}

/**
 * Extracts the base rate from the rates JSON mapping for a specific zone name
 */
export function extractBaseRate(rateRow: RateRowMatch, zoneName: string): number | null {
  if (!rateRow || !rateRow.rates_json) return null;

  let ratesMap: Record<string, number> = {};
  try {
    ratesMap = JSON.parse(rateRow.rates_json);
  } catch (e) {
    console.error('Failed to parse rates JSON:', e);
    return null;
  }

  // Check different representations of zone key (e.g., "2", "ZONE 2", "02")
  const cleanZone = zoneName.trim().toUpperCase().replace('ZONE', '').trim();
  const zoneNum = parseInt(cleanZone, 10);
  const leadingZeroZone = !isNaN(zoneNum) && zoneNum < 10 ? `0${zoneNum}` : cleanZone;

  const keysToTry = [
    zoneName,
    `ZONE ${zoneName}`,
    cleanZone,
    `ZONE ${cleanZone}`,
    `ZONE_${cleanZone}`,
    leadingZeroZone,
    `ZONE ${leadingZeroZone}`
  ];

  for (const key of keysToTry) {
    const rate = ratesMap[key] ?? ratesMap[key.toUpperCase()] ?? ratesMap[key.toLowerCase()];
    if (rate !== undefined && rate !== null) {
      return parseFloat(String(rate));
    }
  }

  return null;
}
