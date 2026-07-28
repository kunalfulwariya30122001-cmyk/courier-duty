/**
 * Rate Diagnostic and Audit Service
 * Part of Courier Rate Comparator
 */

import { db } from '../db.js';
import { compareCourierRates } from './rateComparisonService.js';
import { clearAllRatePackages } from './activeRatePackageService.js';

export interface AuditTestCase {
  id: string;
  name: string;
  courier: 'DHL' | 'UPS' | 'FedEx';
  country: string;
  weight: number;
  shipmentType: 'Document' | 'Non-document';
  expectedZone: string;
  expectedMinRate?: number;
  expectedMaxRate?: number;
}

// Trusted audit test cases based on manually verified rates
export const AUDIT_TEST_CASES: AuditTestCase[] = [
  {
    id: 'DHL-TH-4KG',
    name: 'DHL Thailand 4 KG Non-document',
    courier: 'DHL',
    country: 'Thailand',
    weight: 4.0,
    shipmentType: 'Non-document',
    expectedZone: '2',
    expectedMinRate: 1700,
    expectedMaxRate: 1900 // Benchmark correct rate is ₹1,794
  },
  {
    id: 'DHL-US-1.5KG-DOC',
    name: 'DHL United States 1.5 KG Document',
    courier: 'DHL',
    country: 'United States',
    weight: 1.5,
    shipmentType: 'Document',
    expectedZone: '12'
  },
  {
    id: 'UPS-TH-4KG',
    name: 'UPS Thailand 4 KG Non-document',
    courier: 'UPS',
    country: 'Thailand',
    weight: 4.0,
    shipmentType: 'Non-document',
    expectedZone: '2'
  },
  {
    id: 'FedEx-TH-4KG',
    name: 'FedEx Thailand 4 KG Non-document',
    courier: 'FedEx',
    country: 'Thailand',
    weight: 4.0,
    shipmentType: 'Non-document',
    expectedZone: 'D'
  }
];

export interface DiagnosticResult {
  testId: string;
  name: string;
  courier: string;
  passed: boolean;
  expectedZone: string;
  actualZone: string;
  expectedRateRange?: string;
  actualRate?: number;
  message: string;
}

/**
 * Runs the automated diagnostic test suite comparing database lookups to expected correct rules
 */
export function runAutomatedRateDiagnostics(): {
  success: boolean;
  passCount: number;
  failCount: number;
  totalCount: number;
  results: DiagnosticResult[];
} {
  const results: DiagnosticResult[] = [];
  let passCount = 0;
  let failCount = 0;

  for (const tc of AUDIT_TEST_CASES) {
    try {
      const comp = compareCourierRates({
        country: tc.country,
        weight: tc.weight,
        shipmentType: tc.shipmentType
      });

      const matchedResult = comp.results.find(r => r.courier === tc.courier);
      
      if (!matchedResult) {
        results.push({
          testId: tc.id,
          name: tc.name,
          courier: tc.courier,
          passed: false,
          expectedZone: tc.expectedZone,
          actualZone: 'None',
          message: `Courier not returned in comparison results.`
        });
        failCount++;
        continue;
      }

      if (matchedResult.status !== 'ok') {
        results.push({
          testId: tc.id,
          name: tc.name,
          courier: tc.courier,
          passed: false,
          expectedZone: tc.expectedZone,
          actualZone: 'None',
          message: `Comparison failed: ${matchedResult.message || 'Rate chart missing'}`
        });
        failCount++;
        continue;
      }

      const actualZone = matchedResult.zone || '';
      const actualRate = matchedResult.baseRate || 0;

      // 1. Validate Zone Match
      const zonePassed = actualZone.toUpperCase().replace('ZONE', '').trim() === tc.expectedZone.toUpperCase().trim();
      
      // 2. Validate Rate Range (if specified)
      let ratePassed = true;
      let rateMsg = '';
      if (tc.expectedMinRate !== undefined && tc.expectedMaxRate !== undefined) {
        ratePassed = actualRate >= tc.expectedMinRate && actualRate <= tc.expectedMaxRate;
        rateMsg = ` expected ₹${tc.expectedMinRate}-₹${tc.expectedMaxRate}, got ₹${actualRate.toFixed(2)}`;
      }

      const passed = zonePassed && ratePassed;

      if (passed) {
        passCount++;
      } else {
        failCount++;
      }

      let message = '';
      if (!zonePassed) {
        message = `Zone mismatch: Expected Zone ${tc.expectedZone}, got Zone ${actualZone}.`;
      } else if (!ratePassed) {
        message = `Rate mismatch:${rateMsg}.`;
      } else {
        message = `Passed successfully. Resolved Zone ${actualZone} with rate ₹${actualRate.toFixed(2)}.`;
      }

      results.push({
        testId: tc.id,
        name: tc.name,
        courier: tc.courier,
        passed,
        expectedZone: tc.expectedZone,
        actualZone,
        expectedRateRange: tc.expectedMinRate ? `₹${tc.expectedMinRate}-₹${tc.expectedMaxRate}` : undefined,
        actualRate,
        message
      });

    } catch (err: any) {
      failCount++;
      results.push({
        testId: tc.id,
        name: tc.name,
        courier: tc.courier,
        passed: false,
        expectedZone: tc.expectedZone,
        actualZone: 'Error',
        message: `Diagnostic execution error: ${err.message || err}`
      });
    }
  }

  return {
    success: failCount === 0,
    passCount,
    failCount,
    totalCount: AUDIT_TEST_CASES.length,
    results
  };
}

/**
 * Resets the entire rate comparator subsystem back to factory state
 */
export function resetCourierRatesSubsystem(): { success: boolean; message: string } {
  try {
    clearAllRatePackages();
    
    // Reset courier settings to defaults
    db.prepare('UPDATE courier_settings SET fuel_surcharge = 0, gst = 0, other_surcharge = 0').run();

    return {
      success: true,
      message: 'Rate comparator tables and custom packages cleared successfully.'
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to reset comparator subsystem: ${err.message}`
    };
  }
}
