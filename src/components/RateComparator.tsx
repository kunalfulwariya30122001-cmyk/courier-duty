import React, { useState, useEffect } from 'react';
import { 
  Calculator, 
  HelpCircle, 
  TrendingDown, 
  ArrowRight, 
  AlertCircle, 
  Check, 
  MapPin, 
  FileText,
  Percent,
  Scale
} from 'lucide-react';

interface CompareResult {
  courier: string;
  status: string;
  zone?: string;
  billableWeight?: number;
  baseRate?: number;
  fuelSurcharge?: number;
  gst?: number;
  otherSurcharge?: number;
  finalRate?: number;
  warning?: string | null;
  message?: string;
  rank?: number | null;
  difference?: number | null;
}

interface CompareResponse {
  actualWeight: number;
  volumetricWeight: number;
  billableWeight: number;
  roundedWeight: number;
  results: CompareResult[];
  resolution?: {
    userEntered: string;
    countryCode: string;
    countryName: string;
    strategy: 'ISO_MATCH' | 'CANONICAL_MATCH' | 'ALIAS_MATCH' | 'FUZZY_FALLBACK';
  };
}

export default function RateComparator() {
  const [country, setCountry] = useState('');
  const [weight, setWeight] = useState('');
  const [shipmentType, setShipmentType] = useState<'Document' | 'Non-document'>('Non-document');
  const [length, setLength] = useState('');
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');

  const [countries, setCountries] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compareData, setCompareData] = useState<CompareResponse | null>(null);

  const [diagnostics, setDiagnostics] = useState<any>(null);
  const [runningDiag, setRunningDiag] = useState(false);

  const runDiagnostics = async () => {
    setRunningDiag(true);
    try {
      const res = await fetch('/api/rates/diagnostics');
      if (res.ok) {
        const data = await res.json();
        setDiagnostics(data);
      }
    } catch (err) {
      console.warn('Failed to run diagnostics', err);
    } finally {
      setRunningDiag(false);
    }
  };

  // Fetch unique countries for autocomplete
  const fetchCountries = async () => {
    try {
      const res = await fetch('/api/rates/countries');
      if (res.ok) {
        const list = await res.json();
        setCountries(list);
      }
    } catch (err) {
      console.warn('Failed to load countries', err);
    }
  };

  useEffect(() => {
    fetchCountries();
  }, []);

  // Handle country suggestions
  const handleCountryChange = (val: string) => {
    setCountry(val);
    if (!val.trim()) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    const filtered = countries.filter(c => 
      c.toLowerCase().includes(val.toLowerCase())
    ).slice(0, 8);
    setSuggestions(filtered);
    setShowSuggestions(true);
  };

  const selectCountry = (c: string) => {
    setCountry(c);
    setSuggestions([]);
    setShowSuggestions(false);
  };

  const handleCompare = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setCompareData(null);

    if (!country.trim()) {
      setError('Please select or type a destination country.');
      return;
    }
    const w = parseFloat(weight);
    if (isNaN(w) || w <= 0) {
      setError('Please enter a valid weight in KG.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/rates/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          country,
          weight: w,
          shipmentType,
          length: length ? parseFloat(length) : null,
          width: width ? parseFloat(width) : null,
          height: height ? parseFloat(height) : null
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to calculate rates');
      }

      setCompareData(data);
    } catch (err: any) {
      setError(err.message || 'An error occurred during rate comparison.');
    } finally {
      setLoading(false);
    }
  };

  // Volumetric weight math explanation
  const volumetricKg = (length && width && height) 
    ? (parseFloat(length) * parseFloat(width) * parseFloat(height)) / 5000 
    : 0;

  const formatCurrency = (num?: number) => {
    if (num === undefined) return '—';
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0
    }).format(num);
  };

  return (
    <div className="space-y-8" id="rate-comparator-view">
      {/* Intro Header */}
      <div className="bg-slate-50 border border-slate-100 rounded-2xl p-6">
        <h2 className="text-xl font-bold text-slate-900 flex items-center space-x-2">
          <TrendingDown className="w-5.5 h-5.5 text-indigo-600" />
          <span>Courier Rate Comparator (Daily Office Tool)</span>
        </h2>
        <p className="text-xs text-slate-500 mt-1 max-w-2xl leading-relaxed">
          Compare real-time rates across DHL, FedEx, and UPS based on uploaded manager rate charts. Calculates actual versus volumetric weight, applies fuel surcharges & GST automatically, and ranks couriers starting with the cheapest.
        </p>
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Comparator Form */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-6 shadow-xs">
          <form onSubmit={handleCompare} className="space-y-5">
            <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3">
              Shipment Specifications
            </h3>

            {/* Destination Country Selection with Autocomplete */}
            <div className="relative">
              <label className="block text-xs font-bold text-slate-600 mb-1.5 flex items-center space-x-1">
                <MapPin className="w-3.5 h-3.5 text-indigo-500" />
                <span>Destination Country *</span>
              </label>
              <input
                type="text"
                placeholder="Type Country or Code (e.g., Thailand, TH)"
                value={country}
                onChange={e => handleCountryChange(e.target.value)}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                className="w-full bg-slate-50 border border-slate-200 focus:border-indigo-500 focus:bg-white rounded-xl px-4 py-3 text-sm font-medium outline-none transition-all"
                required
              />
              {showSuggestions && suggestions.length > 0 && (
                <ul className="absolute z-10 w-full bg-white border border-slate-200 rounded-xl shadow-lg mt-1 max-h-48 overflow-y-auto divide-y divide-slate-50">
                  {suggestions.map((s, idx) => (
                    <li
                      key={idx}
                      onMouseDown={() => selectCountry(s)}
                      className="px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-indigo-50 hover:text-indigo-700 cursor-pointer transition-colors"
                    >
                      {s}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Shipment Type: Document / Non-document */}
            <div>
              <label className="block text-xs font-bold text-slate-600 mb-1.5 flex items-center space-x-1">
                <FileText className="w-3.5 h-3.5 text-indigo-500" />
                <span>Shipment Type</span>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setShipmentType('Document')}
                  className={`py-3 rounded-xl border text-xs font-bold transition-all cursor-pointer ${
                    shipmentType === 'Document'
                      ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
                      : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  Document
                </button>
                <button
                  type="button"
                  onClick={() => setShipmentType('Non-document')}
                  className={`py-3 rounded-xl border text-xs font-bold transition-all cursor-pointer ${
                    shipmentType === 'Non-document'
                      ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
                      : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  Non-document
                </button>
              </div>
              <p className="text-[10px] text-slate-400 mt-1 leading-normal">
                * Documents above 2 KG are automatically processed as Non-documents (courier policy).
              </p>
            </div>

            {/* Weight Input (KG) */}
            <div>
              <label className="block text-xs font-bold text-slate-600 mb-1.5 flex items-center space-x-1">
                <Scale className="w-3.5 h-3.5 text-indigo-500" />
                <span>Actual Weight (KG) *</span>
              </label>
              <div className="relative">
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  placeholder="e.g. 5.5"
                  value={weight}
                  onChange={e => setWeight(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 focus:border-indigo-500 focus:bg-white rounded-xl px-4 py-3 text-sm font-semibold outline-none transition-all"
                  required
                />
                <span className="absolute right-4 top-3.5 text-xs font-extrabold text-slate-400">KG</span>
              </div>
            </div>

            {/* Optional Volumetric Sizing */}
            <div className="bg-slate-50/50 rounded-xl p-4 border border-slate-150 space-y-3">
              <span className="text-[11px] font-bold text-slate-700 block uppercase tracking-wider">
                Volumetric Weight (Optional)
              </span>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 mb-1">Length</label>
                  <input
                    type="number"
                    placeholder="L cm"
                    value={length}
                    onChange={e => setLength(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-center font-semibold focus:border-indigo-500 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 mb-1">Width</label>
                  <input
                    type="number"
                    placeholder="W cm"
                    value={width}
                    onChange={e => setWidth(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-center font-semibold focus:border-indigo-500 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 mb-1">Height</label>
                  <input
                    type="number"
                    placeholder="H cm"
                    value={height}
                    onChange={e => setHeight(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-center font-semibold focus:border-indigo-500 outline-none"
                  />
                </div>
              </div>

              {volumetricKg > 0 && (
                <div className="text-[11px] font-semibold text-slate-600 flex justify-between bg-white border border-slate-100 p-2 rounded-lg">
                  <span>Volumetric Weight:</span>
                  <span className="font-extrabold text-indigo-600">{volumetricKg.toFixed(2)} KG</span>
                </div>
              )}
            </div>

            {error && (
              <div className="p-3 bg-rose-50 border border-rose-100 text-rose-700 rounded-xl text-xs font-semibold flex items-start space-x-1.5">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white rounded-xl font-bold text-sm shadow-md transition-all flex items-center justify-center space-x-2 active:scale-98 cursor-pointer"
            >
              <Calculator className="w-4 h-4" />
              <span>{loading ? 'Calculating Rates...' : 'Compare Courier Rates'}</span>
            </button>
          </form>
        </div>

        {/* Results Panel */}
        <div className="lg:col-span-7 space-y-6">
          {!compareData && !loading && (
            <div className="h-full min-h-[380px] bg-slate-50 border border-slate-200 border-dashed rounded-2xl flex flex-col items-center justify-center p-8 text-center">
              <Scale className="w-12 h-12 text-slate-300 mb-3" />
              <p className="text-sm font-bold text-slate-600">No calculation performed yet</p>
              <p className="text-xs text-slate-400 mt-1 max-w-sm">
                Enter shipment weight, country, and optional dimensions on the left to see comparative pricing across carriers.
              </p>
            </div>
          )}

          {loading && (
            <div className="h-full min-h-[380px] bg-white border border-slate-200 rounded-2xl flex flex-col items-center justify-center p-8 text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 mb-3"></div>
              <p className="text-sm font-bold text-slate-600">Running pricing matrix engine...</p>
              <p className="text-xs text-slate-400 mt-1">Checking zones and weights for DHL, FedEx, and UPS</p>
            </div>
          )}

          {compareData && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-200">
              {/* Volumetric / Billable Weight Summary Banner */}
              <div className="bg-slate-900 text-white rounded-2xl p-5 shadow-xs grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <span className="text-[10px] text-slate-400 font-bold block uppercase tracking-wider">Actual Weight</span>
                  <span className="text-base font-extrabold">{compareData.actualWeight.toFixed(2)} KG</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 font-bold block uppercase tracking-wider">Volumetric Weight</span>
                  <span className="text-base font-extrabold">
                    {compareData.volumetricWeight > 0 ? `${compareData.volumetricWeight.toFixed(2)} KG` : '—'}
                  </span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 font-bold block uppercase tracking-wider">Billable Weight</span>
                  <span className="text-base font-extrabold text-indigo-300">{compareData.billableWeight.toFixed(2)} KG</span>
                </div>
                <div>
                  <span className="text-[10px] text-indigo-300 font-bold block uppercase tracking-wider">Rounded (Slab) Weight</span>
                  <span className="text-base font-extrabold text-indigo-300">{compareData.roundedWeight.toFixed(1)} KG</span>
                </div>
              </div>

              {/* Country Resolution Details Debug Section */}
              {compareData.resolution && (
                <div className="bg-indigo-50/50 border border-indigo-100 rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-3 text-indigo-950">
                  <div className="flex items-center space-x-2.5">
                    <div className="p-2 bg-indigo-500 text-white rounded-xl shadow-xs">
                      <MapPin className="w-4 h-4" />
                    </div>
                    <div>
                      <h4 className="text-xs font-extrabold uppercase tracking-wider text-indigo-900">
                        Normalized Country Identity Resolution
                      </h4>
                      <p className="text-[11px] text-indigo-700/90 font-medium mt-0.5">
                        Central normalizer resolved raw input to canonical ISO 3166-1 ID.
                      </p>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-2 md:flex md:items-center gap-3 text-[11px] font-semibold">
                    <div className="bg-white border border-indigo-100 px-3 py-1.5 rounded-xl">
                      <span className="text-[9px] text-indigo-400 block uppercase font-bold">User Input</span>
                      <span className="font-extrabold text-indigo-900">{compareData.resolution.userEntered}</span>
                    </div>
                    <div className="bg-white border border-indigo-100 px-3 py-1.5 rounded-xl">
                      <span className="text-[9px] text-indigo-400 block uppercase font-bold">Canonical Name</span>
                      <span className="font-extrabold text-indigo-900">{compareData.resolution.countryName}</span>
                    </div>
                    <div className="bg-white border border-indigo-100 px-3 py-1.5 rounded-xl">
                      <span className="text-[9px] text-indigo-400 block uppercase font-bold">ISO-2 Code</span>
                      <span className="font-mono font-extrabold text-indigo-900">{compareData.resolution.countryCode}</span>
                    </div>
                    <div className="bg-white border border-indigo-100 px-3 py-1.5 rounded-xl">
                      <span className="text-[9px] text-indigo-400 block uppercase font-bold">Match Strategy</span>
                      <span className="px-1.5 py-0.5 rounded-md bg-indigo-50 text-indigo-700 font-mono text-[9px] font-bold block mt-0.5 uppercase tracking-wide">
                        {compareData.resolution.strategy}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Direct Comparison Highlights */}
              {compareData.results.filter(r => r.status === 'ok').length > 1 && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-5 flex items-start space-x-3 text-emerald-800">
                  <Check className="w-5 h-5 shrink-0 bg-emerald-500 text-white rounded-full p-0.5 mt-0.5" />
                  <div>
                    <h4 className="text-xs font-extrabold uppercase tracking-wide text-emerald-900">
                      Pricing Summary Matrix
                    </h4>
                    <p className="text-xs font-semibold mt-1 leading-normal text-emerald-800">
                      {compareData.results[0].courier} is the cheapest option for this route costing{' '}
                      <strong>{formatCurrency(compareData.results[0].finalRate)}</strong>.
                      {compareData.results.filter(r => r.status === 'ok' && r.rank && r.rank > 1).map((r, i) => (
                        <span key={i} className="block mt-1">
                          • {r.courier} is <strong className="text-red-700">{formatCurrency(r.difference || 0)} higher</strong> ({formatCurrency(r.finalRate)}).
                        </span>
                      ))}
                    </p>
                  </div>
                </div>
              )}

              {/* Comparison Output Table */}
              <div className="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200">
                        <th className="px-5 py-4 text-xs font-bold text-slate-700 uppercase tracking-wider">Rank & Courier</th>
                        <th className="px-4 py-4 text-xs font-bold text-slate-700 uppercase tracking-wider text-center">Zone</th>
                        <th className="px-4 py-4 text-xs font-bold text-slate-700 uppercase tracking-wider text-center">Billable KG</th>
                        <th className="px-4 py-4 text-xs font-bold text-slate-700 uppercase tracking-wider text-right">Base Rate</th>
                        <th className="px-4 py-4 text-xs font-bold text-slate-700 uppercase tracking-wider text-right">Fuel Surcharge</th>
                        <th className="px-4 py-4 text-xs font-bold text-slate-700 uppercase tracking-wider text-right">GST</th>
                        <th className="px-4 py-4 text-xs font-bold text-slate-700 uppercase tracking-wider text-right">Other</th>
                        <th className="px-5 py-4 text-xs font-bold text-slate-700 uppercase tracking-wider text-right">Estimated Rate</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {compareData.results.map((row, idx) => {
                        const isCheapest = row.status === 'ok' && row.rank === 1;
                        const isMissing = row.status === 'Rate chart missing';

                        return (
                          <tr 
                            key={idx} 
                            className={`transition-colors ${
                              isCheapest ? 'bg-emerald-50/40 hover:bg-emerald-50/60' : 'hover:bg-slate-50'
                            }`}
                          >
                            {/* Rank & Courier */}
                            <td className="px-5 py-4 text-sm font-semibold text-slate-800">
                              <div className="flex items-center space-x-2">
                                {isCheapest ? (
                                  <span className="w-5 h-5 rounded-full bg-emerald-500 text-white font-extrabold text-[10px] flex items-center justify-center">
                                    1
                                  </span>
                                ) : row.rank ? (
                                  <span className="w-5 h-5 rounded-full bg-slate-200 text-slate-700 font-extrabold text-[10px] flex items-center justify-center">
                                    {row.rank}
                                  </span>
                                ) : (
                                  <span className="w-5 h-5 rounded-full bg-slate-100 text-slate-400 font-extrabold text-[10px] flex items-center justify-center">
                                    —
                                  </span>
                                )}
                                <span className={isCheapest ? 'text-emerald-800 font-extrabold' : ''}>{row.courier}</span>
                              </div>
                            </td>

                            {/* Zone */}
                            <td className="px-4 py-4 text-sm font-medium text-slate-700 text-center">
                              {row.zone ? (
                                <span className="bg-slate-100 px-2.5 py-1 rounded-lg text-xs font-semibold text-slate-800 uppercase">
                                  {row.zone}
                                </span>
                              ) : '—'}
                            </td>

                            {/* Billable Weight */}
                            <td className="px-4 py-4 text-sm font-medium text-slate-700 text-center">
                              {row.billableWeight ? `${row.billableWeight.toFixed(1)} KG` : '—'}
                            </td>

                            {/* Rates */}
                            {isMissing ? (
                              <td colSpan={5} className="px-5 py-4 text-sm font-bold text-red-600 text-right">
                                <span className="inline-flex items-center space-x-1.5 bg-red-50 text-red-700 px-3 py-1 rounded-full border border-red-100 text-xs font-extrabold uppercase">
                                  <AlertCircle className="w-3.5 h-3.5" />
                                  <span>Rate chart missing</span>
                                </span>
                              </td>
                            ) : row.status !== 'ok' ? (
                              <td colSpan={5} className="px-5 py-4 text-sm text-slate-500 text-right font-semibold">
                                {row.message || 'Calculation error'}
                              </td>
                            ) : (
                              <>
                                <td className="px-4 py-4 text-sm font-medium text-slate-700 text-right">
                                  {formatCurrency(row.baseRate)}
                                </td>
                                <td className="px-4 py-4 text-sm font-medium text-slate-700 text-right">
                                  {formatCurrency(row.fuelSurcharge)}
                                </td>
                                <td className="px-4 py-4 text-sm font-medium text-slate-700 text-right">
                                  {formatCurrency(row.gst)}
                                </td>
                                <td className="px-4 py-4 text-sm font-medium text-slate-700 text-right">
                                  {row.otherSurcharge ? formatCurrency(row.otherSurcharge) : '—'}
                                </td>
                                <td className="px-5 py-4 text-sm font-extrabold text-slate-900 text-right">
                                  <div className="flex flex-col items-end">
                                    <span className={isCheapest ? 'text-emerald-700 text-base' : ''}>
                                      {formatCurrency(row.finalRate)}
                                    </span>
                                    {row.warning && (
                                      <span className="text-[9px] text-amber-600 font-semibold bg-amber-50 border border-amber-100 px-1.5 py-0.5 rounded mt-0.5 uppercase tracking-wide">
                                        {row.warning}
                                      </span>
                                    )}
                                  </div>
                                </td>
                              </>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>

      </div>

      {/* Automated Diagnostic Audit Suite Card */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs mt-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-100 pb-4 mb-4">
          <div>
            <h3 className="text-base font-bold text-slate-900 flex items-center space-x-2">
              <Check className="w-5 h-5 text-emerald-500 bg-emerald-100 rounded-full p-0.5" />
              <span>Automated Pricing & Zone Diagnostic Suite</span>
            </h3>
            <p className="text-xs text-slate-500 mt-1 max-w-2xl leading-relaxed">
              Verify accuracy against trusted manual benchmarks (such as Thailand 4KG Non-document resolving to DHL Zone 2, expected rate ₹1,794).
            </p>
          </div>
          <button
            type="button"
            onClick={runDiagnostics}
            disabled={runningDiag}
            className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold text-xs rounded-xl transition-all shadow-xs cursor-pointer flex items-center space-x-1.5 self-start shrink-0"
          >
            <span>{runningDiag ? 'Running Suite...' : 'Run Verification Suite'}</span>
          </button>
        </div>

        {diagnostics && (
          <div className="space-y-4 animate-in fade-in duration-200">
            <div className={`p-4 rounded-xl text-xs font-semibold flex items-center justify-between ${
              diagnostics.success 
                ? 'bg-emerald-50 text-emerald-800 border border-emerald-150' 
                : 'bg-rose-50 text-rose-800 border border-rose-150'
            }`}>
              <span className="flex items-center space-x-1.5">
                <AlertCircle className="w-4 h-4" />
                <span>Diagnostic Results: <strong>{diagnostics.passCount} of {diagnostics.totalCount} passed</strong></span>
              </span>
              <span className="bg-white px-2.5 py-1 rounded-md shadow-xs text-[10px] font-extrabold uppercase">
                {diagnostics.success ? 'System Stable' : 'System Needs Update'}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {diagnostics.results.map((r: any, i: number) => (
                <div key={i} className="border border-slate-100 rounded-xl p-3 bg-slate-50/50 text-xs flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="font-extrabold text-slate-800">{r.name}</span>
                      <span className={`px-2 py-0.5 rounded-full text-[9px] font-extrabold uppercase ${
                        r.passed ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                      }`}>
                        {r.passed ? 'PASS' : 'FAIL'}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-500 font-medium leading-relaxed">{r.message}</p>
                  </div>
                  <div className="mt-2 pt-2 border-t border-slate-100/80 flex items-center justify-between text-[10px] font-mono text-slate-400">
                    <span>Expected Zone: {r.expectedZone}</span>
                    <span>Actual: {r.actualZone}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
