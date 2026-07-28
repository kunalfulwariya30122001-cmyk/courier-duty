/**
 * Surcharge Service
 * Part of Courier Rate Comparator
 */

import { db } from '../db.js';

export interface SurchargeSettings {
  courier: string;
  fuel_surcharge: number;
  gst: number;
  other_surcharge: number;
}

export interface CalculatedCharges {
  baseRate: number;
  fuelSurcharge: number;
  otherSurcharge: number;
  subtotal: number;
  gst: number;
  finalRate: number;
  warning: string | null;
}

/**
 * Retrieves the surcharge configuration for a given courier from the database
 */
export function getSurchargeSettings(courier: string): SurchargeSettings {
  const row = db.prepare('SELECT * FROM courier_settings WHERE courier = ?').get(courier) as any;
  return {
    courier,
    fuel_surcharge: row?.fuel_surcharge ?? 0,
    gst: row?.gst ?? 0,
    other_surcharge: row?.other_surcharge ?? 0
  };
}

/**
 * Calculates fuel surcharges, other surcharges, and GST based on base rate
 */
export function computeFinalCharges(baseRate: number, settings: SurchargeSettings): CalculatedCharges {
  const fuelPercent = settings.fuel_surcharge;
  const gstPercent = settings.gst;
  const otherSurcharge = settings.other_surcharge;

  const fuelSurcharge = baseRate * (fuelPercent / 100);
  const subtotal = baseRate + fuelSurcharge + otherSurcharge;
  const gst = subtotal * (gstPercent / 100);
  const finalRate = subtotal + gst;

  const isUnconfigured = fuelPercent === 0 && gstPercent === 0 && otherSurcharge === 0;

  return {
    baseRate,
    fuelSurcharge,
    otherSurcharge,
    subtotal,
    gst,
    finalRate,
    warning: isUnconfigured ? 'surcharge not configured' : null
  };
}
