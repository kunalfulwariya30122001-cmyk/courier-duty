import React, { useState, useEffect, useRef } from 'react';
import { 
  Upload, 
  Settings, 
  FileSpreadsheet, 
  Percent, 
  HelpCircle, 
  CheckCircle, 
  AlertCircle, 
  Database,
  ArrowRight,
  Sparkles,
  RefreshCw,
  Sliders
} from 'lucide-react';

interface SurchargeSetting {
  courier: string;
  fuel_surcharge: number;
  gst: number;
  other_surcharge: number;
}

interface SummaryItem {
  courier: string;
  countriesCount: number;
  zonesCount: number;
  weightSlabsCount: number;
  status: 'Success' | 'Rate chart missing';
  latestUploadFile: string | null;
  latestUploadDate: string | null;
}

interface SheetSummary {
  name: string;
  columns: string[];
}

interface DetectionFailedDetails {
  message: string;
  sheets: SheetSummary[];
}

async function readApiResponse(res: Response): Promise<any> {
  const text = await res.text();
  const contentType = res.headers.get('content-type') || '';

  if (!contentType.toLowerCase().includes('application/json')) {
    const preview = text
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);

    throw new Error(
      `Production API returned ${res.status} ${res.statusText} instead of JSON${
        preview ? `: ${preview}` : ''
      }`
    );
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `Production API returned invalid JSON (HTTP ${res.status}).`
    );
  }
}

export default function RateAdmin() {
  const [settings, setSettings] = useState<SurchargeSetting[]>([
    { courier: 'DHL', fuel_surcharge: 0, gst: 0, other_surcharge: 0 },
    { courier: 'FedEx', fuel_surcharge: 0, gst: 0, other_surcharge: 0 },
    { courier: 'UPS', fuel_surcharge: 0, gst: 0, other_surcharge: 0 }
  ]);
  const [summaries, setSummaries] = useState<SummaryItem[]>([]);
  const [loadingSummaries, setLoadingSummaries] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsStatus, setSettingsStatus] = useState<{ type: 'idle' | 'success' | 'error'; message: string }>({ type: 'idle', message: '' });

  // Upload States
  const [selectedCourier, setSelectedCourier] = useState<'DHL' | 'FedEx' | 'UPS'>('DHL');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{ type: 'idle' | 'success' | 'error'; message: string }>({ type: 'idle', message: '' });
  const [detectionError, setDetectionError] = useState<DetectionFailedDetails | null>(null);

  // DHL Structural Detection Confirmation
  const [dhlConfirmation, setDhlConfirmation] = useState<{
    message: string;
    zoneSheetName: string;
    rateSheetName: string;
    preview: {
      zones: { country: string; code: string; zone: string }[];
      rates: {
        shipment_type: 'Document' | 'Non-document';
        weight_slab: number;
        is_per_kg: number;
        rates_count: number;
      }[];
    };
  } | null>(null);

  // Manual Mapping State
  const [manualZoneSheet, setManualZoneSheet] = useState('');
  const [manualRateSheet, setManualRateSheet] = useState('');
  const [manualCountryCol, setManualCountryCol] = useState('');
  const [manualZoneCol, setManualZoneCol] = useState('');
  const [manualWeightCol, setManualWeightCol] = useState('');
  const [manualZoneRateCols, setManualZoneRateCols] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchSettings = async () => {
    try {
      const res = await fetch('/api/rates/settings');
      if (res.ok) {
        const list = await readApiResponse(res);
        if (list && list.length > 0) {
          // Merge defaults with returned list
          setSettings(prev => prev.map(def => {
            const match = list.find((item: any) => item.courier === def.courier);
            return match ? match : def;
          }));
        }
      }
    } catch (err) {
      console.warn('Failed to load settings', err);
    }
  };

  const fetchSummary = async () => {
    setLoadingSummaries(true);
    try {
      const res = await fetch('/api/rates/summary');
      if (res.ok) {
        const summary = await readApiResponse(res);
        setSummaries(summary);
      }
    } catch (err) {
      console.warn('Failed to load rate summaries', err);
    } finally {
      setLoadingSummaries(false);
    }
  };

  useEffect(() => {
    fetchSettings();
    fetchSummary();
  }, []);

  const handleSurchargeChange = (courier: string, field: keyof SurchargeSetting, val: string) => {
    const numVal = parseFloat(val) || 0;
    setSettings(prev => prev.map(s => {
      if (s.courier === courier) {
        return { ...s, [field]: numVal };
      }
      return s;
    }));
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    setSettingsStatus({ type: 'idle', message: '' });
    try {
      const res = await fetch('/api/rates/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings })
      });
      if (res.ok) {
        setSettingsStatus({ type: 'success', message: 'Surcharge & GST percentage rules saved successfully!' });
      } else {
        const err = await readApiResponse(res);
        setSettingsStatus({ type: 'error', message: err.error || 'Failed to save rules.' });
      }
    } catch (err: any) {
      setSettingsStatus({ type: 'error', message: err.message || 'An error occurred.' });
    } finally {
      setSavingSettings(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setUploadFile(e.target.files[0]);
      setUploadStatus({ type: 'idle', message: '' });
      setDetectionError(null);
      setDhlConfirmation(null);
    }
  };

  const handleRateUpload = async (e: React.FormEvent, isConfirmedByStructure = false) => {
    if (e) e.preventDefault();
    if (!uploadFile) {
      setUploadStatus({ type: 'error', message: 'Please select an Excel file to upload.' });
      return;
    }

    setUploadLoading(true);
    setUploadStatus({ type: 'idle', message: '' });
    setDetectionError(null);
    if (!isConfirmedByStructure) {
      setDhlConfirmation(null);
    }

    const formData = new FormData();
    formData.append('file', uploadFile);
    formData.append('courier', selectedCourier);
    if (isConfirmedByStructure) {
      formData.append('confirmDhlDetection', 'true');
    }

    try {
      const res = await fetch('/api/upload/rates', {
        method: 'POST',
        body: formData
      });

      const data = await readApiResponse(res);

      if (!res.ok) {
        throw new Error(data.error || 'Upload processing failed.');
      }

      if (data.success === false && data.code === 'CONFIRMATION_REQUIRED') {
        setDhlConfirmation({
          message: data.message,
          zoneSheetName: data.zoneSheetName,
          rateSheetName: data.rateSheetName,
          preview: data.preview
        });
        setUploadStatus({
          type: 'idle',
          message: ''
        });
      } else if (data.success === false && data.code === 'DETECTION_FAILED') {
        // Handle manual mapping fallback
        setDetectionError({
          message: data.message,
          sheets: data.sheets
        });
        
        // Prepopulate sheet dropdowns with guesses
        if (data.sheets.length > 0) {
          setManualZoneSheet(data.sheets[0].name);
          setManualRateSheet(data.sheets.length > 1 ? data.sheets[1].name : data.sheets[0].name);
        }
        setUploadStatus({ 
          type: 'error', 
          message: 'Automatic parsing failed. Please complete the Manual Column Mapping form below to parse this sheet.' 
        });
      } else {
        setUploadStatus({
          type: 'success',
          message: `${selectedCourier} rates imported successfully! Parsed ${data.countriesCount} countries & ${data.weightSlabsCount} weight slabs.`
        });
        setUploadFile(null);
        setDhlConfirmation(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
        fetchSummary();
      }
    } catch (err: any) {
      setUploadStatus({ type: 'error', message: err.message || 'An error occurred during file upload.' });
    } finally {
      setUploadLoading(false);
    }
  };

  const handleCustomMappingSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!uploadFile || !detectionError) return;

    setUploadLoading(true);
    setUploadStatus({ type: 'idle', message: '' });

    const mapping = {
      zoneSheetName: manualZoneSheet,
      rateSheetName: manualRateSheet,
      countryCol: isNaN(parseInt(manualCountryCol)) ? manualCountryCol : parseInt(manualCountryCol),
      zoneCol: isNaN(parseInt(manualZoneCol)) ? manualZoneCol : parseInt(manualZoneCol),
      weightCol: isNaN(parseInt(manualWeightCol)) ? manualWeightCol : parseInt(manualWeightCol),
      zoneRateCols: manualZoneRateCols.split(',').map(s => s.trim()).filter(Boolean)
    };

    const formData = new FormData();
    formData.append('file', uploadFile);
    formData.append('courier', selectedCourier);
    formData.append('mappingJson', JSON.stringify(mapping));

    try {
      const res = await fetch('/api/upload/rates/custom', {
        method: 'POST',
        body: formData
      });

      const data = await readApiResponse(res);

      if (!res.ok) {
        throw new Error(data.error || 'Custom mapping processing failed.');
      }

      setUploadStatus({
        type: 'success',
        message: `Custom ${selectedCourier} rates imported successfully! Parsed ${data.countriesCount} countries & ${data.weightSlabsCount} weight slabs.`
      });
      setUploadFile(null);
      setDetectionError(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      fetchSummary();
    } catch (err: any) {
      setUploadStatus({ type: 'error', message: err.message || 'Custom parsing failed. Please double check column offsets/names.' });
    } finally {
      setUploadLoading(false);
    }
  };

  return (
    <div className="space-y-8" id="rate-settings-view">
      {/* Intro */}
      <div className="bg-slate-50 border border-slate-100 rounded-2xl p-6">
        <h2 className="text-xl font-bold text-slate-900 flex items-center space-x-2">
          <Settings className="w-5.5 h-5.5 text-amber-600" />
          <span>Surcharges & Rate Chart Settings</span>
        </h2>
        <p className="text-xs text-slate-500 mt-1 max-w-2xl leading-relaxed">
          Manage fuel percentage, service GST, and upload active carrier price files for DHL, FedEx, and UPS. Upload generic excel formats and customize coordinate mappings on the fly.
        </p>
      </div>

      {/* Grid Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Surcharge Settings (Left Panel) */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-6 shadow-xs flex flex-col justify-between">
          <div className="space-y-5">
            <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 flex items-center justify-between">
              <span>Surcharge & GST Rates</span>
              <Sliders className="w-4 h-4 text-slate-400" />
            </h3>

            <div className="space-y-4">
              {settings.map((item, idx) => (
                <div key={idx} className="bg-slate-50 rounded-xl p-4 border border-slate-100 space-y-3">
                  <span className="text-xs font-extrabold text-slate-800 flex items-center space-x-1.5">
                    <span className="w-2.5 h-2.5 bg-indigo-600 rounded-full" />
                    <span>{item.courier} Specifications</span>
                  </span>
                  
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 mb-1">Fuel Surcharge</label>
                      <div className="relative">
                        <input
                          type="number"
                          step="0.01"
                          value={item.fuel_surcharge}
                          onChange={e => handleSurchargeChange(item.courier, 'fuel_surcharge', e.target.value)}
                          className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-center font-bold outline-none focus:border-indigo-500"
                        />
                        <span className="absolute right-1 top-2 text-[9px] text-slate-400 font-bold">%</span>
                      </div>
                    </div>
                    
                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 mb-1">GST/Service Tax</label>
                      <div className="relative">
                        <input
                          type="number"
                          step="0.01"
                          value={item.gst}
                          onChange={e => handleSurchargeChange(item.courier, 'gst', e.target.value)}
                          className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-center font-bold outline-none focus:border-indigo-500"
                        />
                        <span className="absolute right-1 top-2 text-[9px] text-slate-400 font-bold">%</span>
                      </div>
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 mb-1">Other Flat</label>
                      <div className="relative">
                        <input
                          type="number"
                          step="1"
                          value={item.other_surcharge}
                          onChange={e => handleSurchargeChange(item.courier, 'other_surcharge', e.target.value)}
                          className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-center font-bold outline-none focus:border-indigo-500"
                        />
                        <span className="absolute left-1 top-2 text-[9px] text-slate-400 font-bold">₹</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {settingsStatus.message && (
              <div className={`p-3 rounded-xl text-xs font-semibold flex items-start space-x-1.5 ${
                settingsStatus.type === 'success' 
                  ? 'bg-emerald-50 text-emerald-800 border border-emerald-100' 
                  : 'bg-rose-50 text-rose-800 border border-rose-100'
              }`}>
                {settingsStatus.type === 'success' ? <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
                <span>{settingsStatus.message}</span>
              </div>
            )}
          </div>

          <div className="pt-4 mt-6 border-t border-slate-100">
            <button
              onClick={saveSettings}
              disabled={savingSettings}
              className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold text-xs uppercase tracking-wider rounded-xl shadow-xs transition-all active:scale-98 cursor-pointer"
            >
              {savingSettings ? 'Saving Settings...' : 'Save Surcharge Rules'}
            </button>
          </div>
        </div>

        {/* Upload Surcharges & Database Status (Right Panel) */}
        <div className="lg:col-span-7 space-y-6">
          
          {/* Summary / Table of uploaded sheets */}
          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs">
            <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 flex items-center space-x-2">
              <Database className="w-4 h-4 text-indigo-500" />
              <span>Loaded Rate Database Summary</span>
            </h3>

            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <th className="px-3 py-2.5 font-bold">Courier</th>
                    <th className="px-3 py-2.5 font-bold text-center">Countries Mapping</th>
                    <th className="px-3 py-2.5 font-bold text-center">Zones Found</th>
                    <th className="px-3 py-2.5 font-bold text-center">Weight Slabs</th>
                    <th className="px-3 py-2.5 font-bold">Import Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium">
                  {loadingSummaries ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-4 text-center text-slate-400">Loading summaries...</td>
                    </tr>
                  ) : summaries.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-4 text-center text-slate-400">No rates tables loaded in SQLite index yet.</td>
                    </tr>
                  ) : (
                    summaries.map((s, idx) => (
                      <tr key={idx} className="hover:bg-slate-50/50">
                        <td className="px-3 py-3 font-bold text-slate-800">{s.courier}</td>
                        <td className="px-3 py-3 text-center text-slate-600">{s.countriesCount} countries</td>
                        <td className="px-3 py-3 text-center text-slate-600">{s.zonesCount} zones</td>
                        <td className="px-3 py-3 text-center text-slate-600">{s.weightSlabsCount} slabs</td>
                        <td className="px-3 py-3">
                          <span className={`inline-flex items-center space-x-1 px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase border ${
                            s.status === 'Success' 
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-100' 
                              : 'bg-rose-50 text-rose-700 border-rose-100'
                          }`}>
                            {s.status === 'Success' ? 'Ready' : 'Missing'}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Rate excel Upload Panel */}
          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs">
            <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 flex items-center space-x-2">
              <FileSpreadsheet className="w-4 h-4 text-emerald-500" />
              <span>Import New Rate Chart</span>
            </h3>

            <form onSubmit={handleRateUpload} className="mt-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Target Courier</label>
                  <select
                    value={selectedCourier}
                    onChange={e => {
                      setSelectedCourier(e.target.value as any);
                      setDetectionError(null);
                      setUploadStatus({ type: 'idle', message: '' });
                    }}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-bold outline-none focus:border-indigo-500"
                  >
                    <option value="DHL">DHL Express</option>
                    <option value="FedEx">FedEx Express</option>
                    <option value="UPS">UPS Worldwide</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Select Excel File</label>
                  <input
                    type="file"
                    ref={fileInputRef}
                    accept=".xlsx,.xls,.xlsm"
                    onChange={handleFileChange}
                    className="w-full text-xs font-semibold text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200 file:cursor-pointer"
                    required
                  />
                </div>
              </div>

              {uploadStatus.message && (
                <div className={`p-3 rounded-xl text-xs font-semibold flex items-start space-x-1.5 ${
                  uploadStatus.type === 'success' ? 'bg-emerald-50 text-emerald-800 border border-emerald-100' :
                  uploadStatus.type === 'loading' ? 'bg-indigo-50 text-indigo-800 border border-indigo-100 animate-pulse' :
                  'bg-rose-50 text-rose-800 border border-rose-100'
                }`}>
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{uploadStatus.message}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={uploadLoading || !uploadFile}
                className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-100 disabled:text-slate-400 text-white rounded-xl font-bold text-xs uppercase tracking-wider shadow-xs transition-all flex items-center justify-center space-x-1.5 active:scale-98 cursor-pointer"
              >
                <Upload className="w-4 h-4" />
                <span>{uploadLoading ? 'Uploading & Parsing...' : 'Upload Rate Chart'}</span>
              </button>
            </form>

            {/* DHL Confirmation Modal/Panel */}
            {dhlConfirmation && (
              <div className="mt-6 pt-6 border-t border-slate-200 space-y-4 animate-in fade-in duration-200" id="dhl-confirmation-preview">
                <div className="p-4 bg-amber-50 border border-amber-200 text-amber-900 rounded-xl space-y-2">
                  <span className="text-xs font-extrabold uppercase tracking-wide block">
                    Compatible Sheet Detected
                  </span>
                  <p className="text-xs font-semibold leading-normal">
                    {dhlConfirmation.message}
                  </p>
                </div>

                <div className="bg-slate-50 rounded-xl p-4 border border-slate-150 space-y-4 text-xs">
                  <div>
                    <h4 className="font-extrabold text-slate-800 uppercase tracking-wider mb-2">Structure Preview</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Zones sheet preview */}
                      <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2">
                        <div className="font-bold text-slate-700 pb-1 border-b border-slate-100 flex justify-between">
                          <span>Zone Sheet</span>
                          <span className="text-[10px] bg-slate-100 px-1.5 py-0.5 rounded font-mono text-slate-500">{dhlConfirmation.zoneSheetName}</span>
                        </div>
                        <div className="space-y-1 font-mono text-[10px] text-slate-600">
                          {dhlConfirmation.preview.zones.map((z, idx) => (
                            <div key={idx} className="flex justify-between">
                              <span className="truncate max-w-[120px]">{z.country}</span>
                              <span className="font-bold text-slate-800">Zone {z.zone}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Rates sheet preview */}
                      <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2">
                        <div className="font-bold text-slate-700 pb-1 border-b border-slate-100 flex justify-between">
                          <span>Rates Sheet</span>
                          <span className="text-[10px] bg-slate-100 px-1.5 py-0.5 rounded font-mono text-slate-500">{dhlConfirmation.rateSheetName}</span>
                        </div>
                        <div className="space-y-1 font-mono text-[10px] text-slate-600">
                          {dhlConfirmation.preview.rates.map((r, idx) => (
                            <div key={idx} className="flex justify-between">
                              <span>{r.weight_slab} KG ({r.shipment_type})</span>
                              <span className="font-bold text-slate-800">{r.rates_count} Zones</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex space-x-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setDhlConfirmation(null)}
                      className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-bold text-xs uppercase cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRateUpload(null as any, true)}
                      className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold text-xs uppercase shadow-xs cursor-pointer flex items-center justify-center space-x-1.5"
                    >
                      <CheckCircle className="w-4 h-4" />
                      <span>Confirm & Import</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Manual Mapping Form (Shown only if automatic detection fails) */}
            {detectionError && (
              <div className="mt-8 pt-6 border-t border-slate-200 space-y-4 animate-in fade-in duration-200">
                <div className="p-4 bg-amber-50 border border-amber-200 text-amber-900 rounded-xl">
                  <span className="text-xs font-extrabold uppercase tracking-wide block">
                    Irregular Format Detected
                  </span>
                  <p className="text-xs font-semibold mt-1 leading-normal text-amber-850">
                    {detectionError.message} Select which sheets represent the <strong>Zone country mappings</strong> and <strong>Rate matrix columns</strong> to import manually.
                  </p>
                </div>

                <form onSubmit={handleCustomMappingSubmit} className="space-y-4">
                  <h4 className="text-xs font-extrabold uppercase tracking-wider text-slate-800">
                    Manual Column Coordinate Mapping
                  </h4>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {/* Zone country sheet */}
                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 mb-1">Zone Mapping Sheet Name</label>
                      <select
                        value={manualZoneSheet}
                        onChange={e => setManualZoneSheet(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-2 text-xs font-semibold outline-none"
                      >
                        {detectionError.sheets.map((s, i) => (
                          <option key={i} value={s.name}>{s.name}</option>
                        ))}
                      </select>
                    </div>

                    {/* Rate matrix sheet */}
                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 mb-1">Rates Matrix Sheet Name</label>
                      <select
                        value={manualRateSheet}
                        onChange={e => setManualRateSheet(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-2 text-xs font-semibold outline-none"
                      >
                        {detectionError.sheets.map((s, i) => (
                          <option key={i} value={s.name}>{s.name}</option>
                        ))}
                      </select>
                    </div>

                    {/* Country column name/index */}
                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 mb-1">Country Column (e.g. 0 or "Country")</label>
                      <input
                        type="text"
                        placeholder='e.g. 0 or "Destination"'
                        value={manualCountryCol}
                        onChange={e => setManualCountryCol(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-2 text-xs font-semibold outline-none"
                        required
                      />
                    </div>

                    {/* Zone column name/index */}
                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 mb-1">Zone Column (e.g. 1 or "Zone")</label>
                      <input
                        type="text"
                        placeholder='e.g. 1 or "Zone"'
                        value={manualZoneCol}
                        onChange={e => setManualZoneCol(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-2 text-xs font-semibold outline-none"
                        required
                      />
                    </div>

                    {/* Weight column name/index */}
                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 mb-1">Weight Column (e.g. 0 or "KG")</label>
                      <input
                        type="text"
                        placeholder='e.g. 0 or "Weight"'
                        value={manualWeightCol}
                        onChange={e => setManualWeightCol(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-2 text-xs font-semibold outline-none"
                        required
                      />
                    </div>

                    {/* Zone Rate columns list */}
                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 mb-1">Zone Columns List (comma separated)</label>
                      <input
                        type="text"
                        placeholder="e.g. 1, 2, 3, 4, 5, 6, 7"
                        value={manualZoneRateCols}
                        onChange={e => setManualZoneRateCols(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-2 text-xs font-semibold outline-none"
                        required
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={uploadLoading}
                    className="w-full py-3 bg-amber-600 hover:bg-amber-700 disabled:bg-amber-400 text-white rounded-xl font-bold text-xs uppercase tracking-wider shadow-sm transition-all flex items-center justify-center space-x-1.5 active:scale-98 cursor-pointer"
                  >
                    <span>Parse with Custom Mapping Coordinates</span>
                  </button>
                </form>
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
