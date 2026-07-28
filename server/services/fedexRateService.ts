/**
 * FedEx Rate Service
 * Part of Courier Rate Comparator
 */

import { resolveCountryZone } from './countryZoneService.js';
import { calculateBillableWeight } from './billableWeightService.js';
import { resolveRateRow, extractBaseRate } from './rateSlabService.js';
import { getSurchargeSettings, computeFinalCharges } from './surchargeService.js';
import type { CourierRateResult } from './dhlRateService.js';

/**
 * Calculates rate comparison result specifically for FedEx
 */
export function calculateFedExRate(params: {
  country: string;
  weight: number;
  shipmentType: 'Document' | 'Non-document';
  service?: string;
  direction?: 'EXPORT' | 'IMPORT';
  length?: number;
  width?: number;
  height?: number;
}): CourierRateResult {
  const service = params.service || 'INTERNATIONAL_PRIORITY';
  const direction = params.direction || 'EXPORT';

  // 1. Resolve Country & Zone
  const zoneMatch = resolveCountryZone({
    courier: 'FedEx',
    countryInput: params.country,
    service,
    direction
  });

  if (!zoneMatch) {
    return {
      courier: 'FedEx',
      status: 'Rate chart missing',
      message: 'Country-to-zone mapping missing'
    };
  }

  // 2. Compute billable weight
  const weightCalcs = calculateBillableWeight({
    weight: params.weight,
    length: params.length,
    width: params.width,
    height: params.height
  });

  const roundedWeight = weightCalcs.roundedWeight;

  // 3. Resolve rate row
  const rateRow = resolveRateRow({
    courier: 'FedEx',
    weight: roundedWeight,
    shipmentType: params.shipmentType,
    service,
    direction
  });

  if (!rateRow) {
    return {
      courier: 'FedEx',
      status: 'Rate chart missing',
      zone: zoneMatch.zone,
      countryCode: zoneMatch.countryCode,
      message: `No rate slab found for weight ${roundedWeight} KG`
    };
  }

  // 4. Extract base rate from row
  const rawBaseRate = extractBaseRate(rateRow, zoneMatch.zone);
  if (rawBaseRate === null) {
    return {
      courier: 'FedEx',
      status: 'Rate chart missing',
      zone: zoneMatch.zone,
      countryCode: zoneMatch.countryCode,
      message: `Rate missing for Zone ${zoneMatch.zone}`
    };
  }

  // Multiply by weight if it is a per-kg slab
  const baseRate = rateRow.is_per_kg === 1 ? rawBaseRate * roundedWeight : rawBaseRate;

  // 5. Apply surcharges
  const settings = getSurchargeSettings('FedEx');
  const charges = computeFinalCharges(baseRate, settings);

  return {
    courier: 'FedEx',
    status: 'ok',
    zone: zoneMatch.zone,
    countryCode: zoneMatch.countryCode,
    billableWeight: roundedWeight,
    baseRate: charges.baseRate,
    fuelSurcharge: charges.fuelSurcharge,
    gst: charges.gst,
    otherSurcharge: charges.otherSurcharge,
    finalRate: charges.finalRate,
    warning: charges.warning
  };
}
