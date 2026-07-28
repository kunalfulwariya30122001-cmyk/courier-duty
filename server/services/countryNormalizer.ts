/**
 * Country Normalization Service
 * Part of Courier Rate Comparator
 */

import { db } from '../db.js';
import { COUNTRIES_LIST } from '../data/countriesList.js';

export interface MasterCountry {
  id?: number;
  country_code: string;
  country_name: string;
  normalized_name: string;
  iso3_code: string;
  aliases_json: string;
  is_active: number;
}

export const SEED_COUNTRIES = COUNTRIES_LIST;

// Helper to get active master countries from SQLite or static fallback
export function getMasterCountries(): MasterCountry[] {
  try {
    return db.prepare('SELECT * FROM country_master WHERE is_active = 1').all() as MasterCountry[];
  } catch (e) {
    return SEED_COUNTRIES.map((c, idx) => ({
      id: idx + 1,
      country_code: c.code,
      country_name: c.name,
      normalized_name: c.name.toLowerCase(),
      iso3_code: c.iso3,
      aliases_json: JSON.stringify(c.aliases),
      is_active: 1
    }));
  }
}

/**
 * Standardizes a country string input (case, spaces, parentheses).
 */
export function normalizeCountryName(name: string): string {
  if (!name) return '';
  return name
    .replace(/\s*\([^)]*\)/g, '') // Remove parentheses content
    .trim()
    .toLowerCase();
}

/**
 * Advanced string cleaning for reliable comparison.
 * Removes diacritics/accents, converts to lower case, replaces non-alphanumeric chars with spaces,
 * and collapses consecutive spaces.
 */
export function cleanAndNormalize(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove accents/diacritics (e.g. ç -> c)
    .replace(/[^a-z0-9\s]/g, ' ')     // Replace punctuation and dashes with spaces
    .replace(/\s+/g, ' ')             // Collapse multiple spaces
    .trim();
}

// Custom override dictionary mapping cleaned strings to ISO-2 country codes
const CUSTOM_MAPPINGS: Record<string, string> = {
  'bahama': 'BS',
  'bahamas': 'BS',
  'the bahamas': 'BS',
  'bosnia herzegovina': 'BA',
  'bosnia and herzegovina': 'BA',
  'bosnia': 'BA',
  'curacao': 'CW',
  'curaçao': 'CW',
  'faeroe islands': 'FO',
  'faroe islands': 'FO',
  'faroe': 'FO',
  'hong kong sar china': 'HK',
  'hong kong sar': 'HK',
  'hong kong': 'HK',
  'hongkong': 'HK',
  'macau sar china': 'MO',
  'macau sar': 'MO',
  'macau': 'MO',
  'macao sar china': 'MO',
  'macao sar': 'MO',
  'macao': 'MO',
  'monserrat': 'MS',
  'montserrat': 'MS',
  'phillipines': 'PH',
  'philippines': 'PH',
  'philipines': 'PH',
  'puerto rico': 'PR',
  'u s virgin islands': 'VI',
  'us virgin islands': 'VI',
  'united states virgin islands': 'VI',
  'virgin islands us': 'VI',
  'virgin islands u s': 'VI',
  'british virgin islands': 'VG',
  'virgin islands british': 'VG',
  'st kitts': 'KN',
  'st lucia': 'LC',
  'st vincent': 'VC',
  'st martin': 'MF',
  'st barthelemy': 'XB',
  'st maarten': 'XM',
  'sint maarten': 'XM',
  'russia': 'RU',
  'vietnam': 'VN',
  'laos': 'LA',
  'syria': 'SY',
  'taiwan': 'TW',
  'taipei': 'TW',
  'south korea': 'KR',
  'korea south': 'KR',
  'north korea': 'KP',
  'korea north': 'KP',
  'venezuela': 'VE',
  'bolivia': 'BO',
  'brunei': 'BN',
  'tanzania': 'TZ',
  'iran': 'IR',
  'moldova': 'MD',
  'holland': 'NL',
  'netherlands': 'NL',
  'dr congo': 'CD',
  'democratic republic of the congo': 'CD',
  'micronesia': 'FM',
  'uae': 'AE',
  'united arab emirates': 'AE',
  'uk': 'GB',
  'united kingdom': 'GB',
  'great britain': 'GB',
  'usa': 'US',
  'united states': 'US',
  'united states of america': 'US',
  'cote d ivoire': 'CI',
  'ivory coast': 'CI',
  'xs': 'XS',
  'xy': 'XY',
  'xe': 'XE',
  'xm': 'XM',
  'xb': 'XB',
  'xn': 'XN',
  'ic': 'IC',
  'kv': 'XK',
  'xc': 'XC',
  'canary islands': 'IC',
  'somaliland': 'XS',
  'sint eustatius': 'XE',
  'nevis': 'XN',
  'st croix': 'XC',
};

/**
 * Priority-based resolver for a 2-letter ISO country code.
 */
export function resolveCountryCode(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const trimmedUpper = trimmed.toUpperCase();

  if (
    trimmedUpper === '#N/A' || 
    trimmedUpper === 'N/A' || 
    trimmedUpper.includes('#REF') || 
    trimmedUpper.includes('#VALUE')
  ) {
    return null;
  }

  const countries = getMasterCountries();

  // Priority 1: Exact ISO 2-letter code match
  if (trimmedUpper.length === 2 && /^[A-Z]{2}$/.test(trimmedUpper)) {
    const found = countries.find(c => c.country_code === trimmedUpper);
    if (found) return found.country_code;
  }

  const cleanedInput = cleanAndNormalize(trimmed);
  if (!cleanedInput) return null;

  // Priority 2: Direct match against Master Country canonical fields
  for (const c of countries) {
    if (c.country_code.toLowerCase() === cleanedInput) {
      return c.country_code;
    }
    if (c.iso3_code.toLowerCase() === cleanedInput) {
      return c.country_code;
    }
    if (cleanAndNormalize(c.country_name) === cleanedInput) {
      return c.country_code;
    }
  }

  // Priority 3: Direct match against exact custom mapping
  if (CUSTOM_MAPPINGS[cleanedInput]) {
    return CUSTOM_MAPPINGS[cleanedInput];
  }

  // Priority 4: Exact match against country aliases
  for (const c of countries) {
    let aliases: string[] = [];
    try {
      aliases = JSON.parse(c.aliases_json || '[]');
    } catch (e) {
      aliases = [];
    }
    for (const alias of aliases) {
      if (cleanAndNormalize(alias) === cleanedInput) {
        return c.country_code;
      }
    }
  }

  // Priority 5: Country code inside parentheses
  const parenMatch = trimmed.match(/\(([^)]+)\)/);
  if (parenMatch && parenMatch[1]) {
    const code = parenMatch[1].trim().toUpperCase();
    if (code.length === 2) {
      const found = countries.find(c => c.country_code === code);
      if (found) return found.country_code;
    }
  }

  // Priority 6: Custom override substring prefix / word-level match
  const sortedCustomKeys = Object.keys(CUSTOM_MAPPINGS).sort((a, b) => b.length - a.length);
  for (const key of sortedCustomKeys) {
    if (cleanedInput.startsWith(key) || cleanedInput.includes(' ' + key) || cleanedInput.includes(key + ' ')) {
      return CUSTOM_MAPPINGS[key];
    }
  }

  // Priority 7: Safe fuzzy substring matching
  // (Only perform substring matches on names/aliases of length >= 4 to avoid spurious matches)
  if (cleanedInput.length >= 4) {
    const candidates: MasterCountry[] = [];
    for (const c of countries) {
      const normName = cleanAndNormalize(c.country_name);
      
      if (normName.length >= 4) {
        if (cleanedInput.includes(normName) || normName.includes(cleanedInput)) {
          candidates.push(c);
          continue;
        }
      }

      let aliases: string[] = [];
      try {
        aliases = JSON.parse(c.aliases_json || '[]');
      } catch (e) {
        aliases = [];
      }
      for (const alias of aliases) {
        const normAlias = cleanAndNormalize(alias);
        if (normAlias.length >= 4) {
          if (cleanedInput.includes(normAlias) || normAlias.includes(cleanedInput)) {
            candidates.push(c);
            break;
          }
        }
      }
    }

    // Deduplicate candidates by country code
    const uniqueCandidates = Array.from(new Map(candidates.map(c => [c.country_code, c])).values());

    if (uniqueCandidates.length === 1) {
      return uniqueCandidates[0].country_code;
    } else if (uniqueCandidates.length > 1) {
      throw new Error("Please select the correct country.");
    }
  }

  return null;
}

/**
 * Returns canonical display name for a country code.
 */
export function getCanonicalCountryName(countryCode: string): string | null {
  const codeUpper = countryCode.trim().toUpperCase();
  const found = getMasterCountries().find(c => c.country_code === codeUpper);
  return found ? found.country_name : null;
}

/**
 * Legacy support / direct alias check
 */
export function matchCountryAlias(input: string): string | null {
  try {
    return resolveCountryCode(input);
  } catch (e) {
    return null;
  }
}

/**
 * Normalizes full country input structure conforming to user request.
 */
export function normalizeCountryInput(input: string): {
  countryCode: string;
  countryName: string;
  normalizedName: string;
  rawInput: string;
  strategy: 'ISO_MATCH' | 'CANONICAL_MATCH' | 'ALIAS_MATCH' | 'FUZZY_FALLBACK';
} {
  const code = resolveCountryCode(input);
  if (!code) {
    throw new Error(`Country "${input}" could not be resolved. Please select the correct country.`);
  }
  const canonicalName = getCanonicalCountryName(code);

  const trimmed = input.trim();
  const trimmedLower = trimmed.toLowerCase();
  const trimmedUpper = trimmed.toUpperCase();
  const countries = getMasterCountries();

  let strategy: 'ISO_MATCH' | 'CANONICAL_MATCH' | 'ALIAS_MATCH' | 'FUZZY_FALLBACK' = 'CANONICAL_MATCH';

  if (trimmedUpper.length === 2 && /^[A-Z]{2}$/.test(trimmedUpper)) {
    strategy = 'ISO_MATCH';
  } else if (countries.some(c => c.normalized_name === trimmedLower || c.country_name.toLowerCase() === trimmedLower)) {
    strategy = 'CANONICAL_MATCH';
  } else {
    let isAlias = false;
    for (const c of countries) {
      let aliases: string[] = [];
      try {
        aliases = JSON.parse(c.aliases_json || '[]');
      } catch (e) {
        aliases = [];
      }
      if (aliases.some(alias => alias.toLowerCase() === trimmedLower)) {
        isAlias = true;
        break;
      }
    }
    if (isAlias) {
      strategy = 'ALIAS_MATCH';
    } else {
      const parenMatch = trimmed.match(/\(([^)]+)\)/);
      if (parenMatch && parenMatch[1] && parenMatch[1].trim().length === 2) {
        strategy = 'ISO_MATCH';
      } else {
        const normSearch = cleanAndNormalize(trimmed);
        if (normSearch) {
          if (countries.some(c => cleanAndNormalize(c.country_name) === normSearch)) {
            strategy = 'CANONICAL_MATCH';
          } else {
            strategy = 'FUZZY_FALLBACK';
          }
        } else {
          strategy = 'FUZZY_FALLBACK';
        }
      }
    }
  }

  return {
    countryCode: code,
    countryName: canonicalName || code,
    normalizedName: (canonicalName || code).toLowerCase(),
    rawInput: input,
    strategy
  };
}

// Keep legacy export compatibility so we don't break other files
export function getCountryIsoCode(input: string): string | null {
  try {
    return resolveCountryCode(input);
  } catch (e) {
    return null;
  }
}

export function getCountryDisplayName(code: string): string {
  return getCanonicalCountryName(code) || code;
}

