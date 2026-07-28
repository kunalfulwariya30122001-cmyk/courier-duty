/**
 * Automated Unit Test Suite for Services
 * Part of Courier Rate Comparator
 */

import { getCountryIsoCode, normalizeCountryName } from './server/services/countryNormalizer.ts';
import { calculateBillableWeight } from './server/services/billableWeightService.ts';
import { runAutomatedRateDiagnostics } from './server/services/rateDiagnosticService.ts';
import { getRatePackages } from './server/services/activeRatePackageService.ts';

let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string) {
  if (condition) {
    console.log(`✅ PASSED: ${testName}`);
    passedTests++;
  } else {
    console.error(`❌ FAILED: ${testName}`);
    failedTests++;
  }
}

console.log('==================================================');
console.log('RUNNING UNIT TESTS FOR COURIER COMPARATOR SERVICES');
console.log('==================================================\n');

// 1. Country Normalizer Tests
console.log('--- 1. Testing Country Normalizer ---');
assert(normalizeCountryName('Thailand (TH)') === 'thailand', 'normalizeCountryName removes parenthesis');
assert(normalizeCountryName('  United States  ') === 'united states', 'normalizeCountryName trims outer spaces');
assert(getCountryIsoCode('Thailand') === 'TH', 'getCountryIsoCode maps Thailand -> TH');
assert(getCountryIsoCode('TH') === 'TH', 'getCountryIsoCode maps direct TH -> TH');
assert(getCountryIsoCode('USA') === 'US', 'getCountryIsoCode maps USA -> US');
assert(getCountryIsoCode('United Kingdom') === 'GB', 'getCountryIsoCode maps United Kingdom -> GB');
assert(getCountryIsoCode('Great Britain') === 'GB', 'getCountryIsoCode maps alias Great Britain -> GB');
assert(getCountryIsoCode('InvalidCountryNameXYZ') === null, 'getCountryIsoCode handles invalid inputs gracefully');
console.log('');

// 2. Billable Weight Tests
console.log('--- 2. Testing Billable Weight Calculations ---');
// Test case 1: Actual weight heavier than volumetric weight, weight <= 30
const calc1 = calculateBillableWeight({ weight: 4.2 });
assert(calc1.actualWeight === 4.2, 'Actual weight is correct');
assert(calc1.volumetricWeight === 0, 'Volumetric is 0 when dimensions are missing');
assert(calc1.roundedWeight === 4.5, 'Rounding up to nearest 0.5 (4.2 -> 4.5)');

// Test case 2: Volumetric weight heavier, weight <= 30
const calc2 = calculateBillableWeight({ weight: 2.0, length: 30, width: 20, height: 25 });
// Volumetric: 30 * 20 * 25 / 5000 = 15000 / 5000 = 3.0 KG
assert(calc2.volumetricWeight === 3.0, 'Volumetric weight is computed correctly');
assert(calc2.billableWeight === 3.0, 'Billable weight selects maximum of actual vs volumetric');
assert(calc2.roundedWeight === 3.0, 'Rounded is correct (3.0 -> 3.0)');

// Test case 3: Weight > 30, should round to nearest whole integer
const calc3 = calculateBillableWeight({ weight: 34.3 });
assert(calc3.roundedWeight === 35, 'Weight above 30.0 rounds up to nearest integer (34.3 -> 35)');
console.log('');

// 3. Rate Packages & Active Packages Check
console.log('--- 3. Testing Active Packages State ---');
try {
  const packages = getRatePackages();
  console.log(`Currently loaded rate packages: ${packages.length}`);
  assert(Array.isArray(packages), 'getRatePackages returns an array');
} catch (e: any) {
  console.error('Failed to get packages:', e.message);
}
console.log('');

// 4. Run Diagnostic Audit Tests on Current SQLite Data
console.log('--- 4. Running Automated Database Rate Diagnostics ---');
try {
  const diagnostics = runAutomatedRateDiagnostics();
  console.log(`Diagnostic Run: passed ${diagnostics.passCount}/${diagnostics.totalCount} benchmarks.`);
  for (const r of diagnostics.results) {
    console.log(`- [${r.passed ? 'PASS' : 'FAIL'}] ${r.name}: ${r.message}`);
  }
} catch (e: any) {
  console.error('Failed running diagnostics:', e.message);
}
console.log('');

console.log('==================================================');
console.log(`TEST SUMMARY: ${passedTests} passed, ${failedTests} failed.`);
console.log('==================================================');

if (failedTests > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
