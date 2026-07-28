/**
 * Rate Comparison Service
 * Part of Courier Rate Comparator
 */

import { calculateDhlRate } from './dhlRateService.js';
import type { CourierRateResult } from './dhlRateService.js';
import { calculateUpsRate } from './upsRateService.js';
import { calculateFedExRate } from './fedexRateService.js';
import { calculateBillableWeight } from './billableWeightService.js';
import { normalizeCountryInput } from './countryNormalizer.js';

export interface ComparisonResponse {
  actualWeight: number;
  volumetricWeight: number;
  billableWeight: number;
  roundedWeight: number;
  results: Array<CourierRateResult & { rank: number | null; difference: number | null }>;
  resolution?: {
    userEntered: string;
    countryCode: string;
    countryName: string;
    strategy: 'ISO_MATCH' | 'CANONICAL_MATCH' | 'ALIAS_MATCH' | 'FUZZY_FALLBACK';
  };
}

/**
 * Conducts a full cross-courier rate comparison audit and calculation
 */
export function compareCourierRates(params: {
  country: string;
  weight: number;
  shipmentType: 'Document' | 'Non-document';
  service?: string;
  direction?: 'EXPORT' | 'IMPORT';
  length?: number;
  width?: number;
  height?: number;
}): ComparisonResponse {
  const direction = params.direction || 'EXPORT';

  // 1. Calculate weights
  const weightCalcs = calculateBillableWeight({
    weight: params.weight,
    length: params.length,
    width: params.width,
    height: params.height
  });

  // 1.5. Resolve Country Resolution details
  let resolution: any = undefined;
  try {
    const norm = normalizeCountryInput(params.country);
    resolution = {
      userEntered: params.country,
      countryCode: norm.countryCode,
      countryName: norm.countryName,
      strategy: norm.strategy
    };
  } catch (err) {}

  // 2. Query each courier service
  const rawResults: CourierRateResult[] = [
    calculateDhlRate({
      country: params.country,
      weight: params.weight,
      shipmentType: params.shipmentType,
      service: params.service || 'EXPRESS_WORLDWIDE',
      direction,
      length: params.length,
      width: params.width,
      height: params.height
    }),
    calculateUpsRate({
      country: params.country,
      weight: params.weight,
      shipmentType: params.shipmentType,
      service: params.service || 'EXPRESS_SAVER',
      direction,
      length: params.length,
      width: params.width,
      height: params.height
    }),
    calculateFedExRate({
      country: params.country,
      weight: params.weight,
      shipmentType: params.shipmentType,
      service: params.service || 'INTERNATIONAL_PRIORITY',
      direction,
      length: params.length,
      width: params.width,
      height: params.height
    })
  ];

  // 3. Process and rank successfully computed rates
  const okResults = rawResults
    .filter(r => r.status === 'ok')
    .sort((a, b) => (a.finalRate ?? 0) - (b.finalRate ?? 0));

  const missingResults = rawResults.filter(r => r.status !== 'ok');

  const formattedResults: Array<CourierRateResult & { rank: number | null; difference: number | null }> = [];
  const cheapestRate = okResults.length > 0 ? (okResults[0].finalRate ?? 0) : 0;

  // Add ranked OK results
  for (let i = 0; i < okResults.length; i++) {
    const r = okResults[i];
    formattedResults.push({
      ...r,
      rank: i + 1,
      difference: Math.max(0, (r.finalRate ?? 0) - cheapestRate)
    });
  }

  // Add unranked missing results
  for (const r of missingResults) {
    formattedResults.push({
      ...r,
      rank: null,
      difference: null
    });
  }

  return {
    actualWeight: weightCalcs.actualWeight,
    volumetricWeight: weightCalcs.volumetricWeight,
    billableWeight: weightCalcs.billableWeight,
    roundedWeight: weightCalcs.roundedWeight,
    results: formattedResults,
    resolution
  };
}
