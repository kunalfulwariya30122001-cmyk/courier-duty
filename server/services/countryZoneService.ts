/**
 * Country to Zone Mapping Service
 * Part of Courier Rate Comparator
 */

import { db } from '../db.js';
import { resolveCountryCode, getCanonicalCountryName } from './countryNormalizer.js';

export interface ZoneMatch {
  country: string;
  zone: string;
  countryCode: string;
}

/**
 * Resolves the zone mapping for a given courier, country input, service, and direction
 */
export function resolveCountryZone(params: {
  courier: 'DHL' | 'UPS' | 'FedEx';
  countryInput: string;
  service: string;
  direction: 'EXPORT' | 'IMPORT';
}): ZoneMatch | null {
  const { courier, countryInput, service, direction } = params;
  if (!countryInput) return null;

  // 1. Resolve ISO 2-letter country code using central Normalizer
  let searchIso = '';
  try {
    searchIso = resolveCountryCode(countryInput);
  } catch (err) {
    // If not found, searchIso remains empty
  }

  if (!searchIso) {
    return null;
  }

  const canonicalName = getCanonicalCountryName(searchIso) || countryInput;

  // 2. Query exact active country-zone mappings using country_code and exact/clean name match (for sub-regions like China (South))
  const lowerInput = countryInput.toLowerCase().trim();
  const exactMatch = db.prepare(`
    SELECT * FROM courier_zones 
    WHERE courier = ? AND country_code = ? AND service = ? AND direction = ? AND active = 1
      AND (LOWER(raw_country_value) = ? OR LOWER(country) = ? OR LOWER(country_name) = ?)
    LIMIT 1
  `).get(courier, searchIso, service, direction, lowerInput, lowerInput, lowerInput) as any;

  if (exactMatch) {
    return {
      country: exactMatch.country_name || exactMatch.country || canonicalName,
      zone: exactMatch.zone,
      countryCode: searchIso
    };
  }

  // 3. Fallback: Query exact active country-zone mappings using country_code alone
  const match = db.prepare(`
    SELECT * FROM courier_zones 
    WHERE courier = ? AND country_code = ? AND service = ? AND direction = ? AND active = 1
    LIMIT 1
  `).get(courier, searchIso, service, direction) as any;

  if (match) {
    return {
      country: match.country_name || match.country || canonicalName,
      zone: match.zone,
      countryCode: searchIso
    };
  }

  // Legacy fallback if service or direction columns are unpopulated in old rows
  const legacyMatch = db.prepare(`
    SELECT * FROM courier_zones 
    WHERE courier = ? AND country_code = ? AND active = 1
    LIMIT 1
  `).get(courier, searchIso) as any;

  if (legacyMatch) {
    return {
      country: legacyMatch.country_name || legacyMatch.country || canonicalName,
      zone: legacyMatch.zone,
      countryCode: searchIso
    };
  }

  return null;
}
