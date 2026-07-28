/**
 * Billable Weight Service
 * Part of Courier Rate Comparator
 */

export interface WeightCalculation {
  actualWeight: number;
  volumetricWeight: number;
  billableWeight: number;
  roundedWeight: number;
}

/**
 * Computes the billable weight and rounds it based on carrier rules:
 * - Up to nearest 0.5 kg up to 30.0 kg
 * - Up to nearest 1.0 kg above 30.0 kg
 */
export function calculateBillableWeight(params: {
  weight: number;
  length?: number;
  width?: number;
  height?: number;
}): WeightCalculation {
  const actualWeight = parseFloat(String(params.weight)) || 0;
  
  // Calculate dimensional/volumetric weight: L * W * H / 5000
  let volumetricWeight = 0;
  const l = parseFloat(String(params.length)) || 0;
  const w = parseFloat(String(params.width)) || 0;
  const h = parseFloat(String(params.height)) || 0;
  
  if (l > 0 && w > 0 && h > 0) {
    volumetricWeight = (l * w * h) / 5000;
  }
  
  const billableWeight = Math.max(actualWeight, volumetricWeight);
  
  let roundedWeight = 0;
  if (billableWeight <= 30.0) {
    // Round to nearest 0.5 kg above
    roundedWeight = Math.ceil(billableWeight * 2) / 2;
  } else {
    // Round to nearest 1.0 kg above
    roundedWeight = Math.ceil(billableWeight);
  }

  return {
    actualWeight,
    volumetricWeight,
    billableWeight,
    roundedWeight
  };
}
