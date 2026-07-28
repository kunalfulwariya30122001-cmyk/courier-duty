import React, { useState, useEffect, useRef, ChangeEvent } from 'react';
import { 
  Upload, 
  Calendar, 
  AlertTriangle, 
  Database, 
  Download, 
  RefreshCw, 
  Trash2, 
  Search, 
  FileText, 
  CheckCircle, 
  Globe, 
  Info,
  Layers,
  Sparkles,
  SearchCode,
  FileSpreadsheet,
  AlertCircle,
  Terminal,
  Cloud
} from 'lucide-react';
import RateComparator from './components/RateComparator';
import RateAdmin from './components/RateAdmin';

interface Stats {
  shiptax: number;
  charges: number;
  double: number;
  duty: number;
  review: number;
}

interface DatewiseRow {
  ship_date: string;
  courier: string;
  shipment_count: number;
  duty_amount: number;
  awbs: string;
}

interface DoubleRow {
  id: number;
  awb: string;
  courier: string;
  ship_date: string;
  first_charge_month: string;
  first_invoice_number: string;
  first_source_file: string;
  repeat_charge_month: string;
  repeat_invoice_number: string;
  repeat_source_file: string;
  duty_amount: number;
  charge_type: string;
  message: string;
  created_at: string;
}

interface ShipTaxRow {
  awb: string;
  original_awb: string;
  ship_date: string;
  courier: string;
  country: string;
  order_reference: string;
  source_file: string;
}

interface ReviewRow {
  id: number;
  reason: string;
  courier: string;
  awb: string;
  source_file: string;
  source_sheet: string;
  source_row: number;
  message: string;
}

async function safeParseJson(response: Response): Promise<any> {
  const text = await response.text();
  const trimmed = text.trim().toLowerCase();
  if (trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html') || trimmed.startsWith('<html>')) {
    throw new Error("Iframe session expired or third-party cookies are blocked. Please refresh this page, or click the 'Open in new tab' icon at the top right of the preview to complete authentication.");
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    if (!response.ok) {
      throw new Error(`Server Error (Status ${response.status}): ${text.substring(0, 150)}`);
    }
    throw new Error(`Malformed JSON Response: ${text.substring(0, 150)}`);
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'shiptax' | 'courier' | 'fob' | 'datewise' | 'double' | 'review' | 'memory' | 'export' | 'comparator' | 'rate-admin'>('shiptax');
  
  // States
  const [fobReport, setFobReport] = useState<any[]>([]);
  const [fobSubTab, setFobSubTab] = useState<'summary' | 'matched' | 'unmatched' | 'customer-review'>('summary');
  const [customerFobData, setCustomerFobData] = useState<any[]>([]);
  const [fobFiles, setFobFiles] = useState<File[]>([]);
  const [fobStatus, setFobStatus] = useState<{ type: 'idle' | 'loading' | 'success' | 'error'; message: string }>({ type: 'idle', message: '' });
  const [fobSearch, setFobSearch] = useState('');
  const [fobStatusFilter, setFobStatusFilter] = useState<'ALL' | 'Matched' | 'Missing' | 'Mismatched'>('ALL');
  const [fobPage, setFobPage] = useState(1);
  const [customerPage, setCustomerPage] = useState(1);
  const fobPageSize = 100;
  const fobInputRef = useRef<HTMLInputElement>(null);
  const [dbStatus, setDbStatus] = useState<{
    status: 'Connected' | 'Quota exceeded' | 'Using temporary cache' | 'Data not loaded';
    error: string | null;
    rawLoaded: boolean;
  }>({
    status: 'Connected',
    error: null,
    rawLoaded: false
  });
  
  const [showCloudGuide, setShowCloudGuide] = useState(false);
  
  const [stats, setStats] = useState<Stats>({ shiptax: 0, charges: 0, double: 0, duty: 0, review: 0 });
  const [datewise, setDatewise] = useState<DatewiseRow[]>([]);
  const [double, setDouble] = useState<DoubleRow[]>([]);
  const [memory, setMemory] = useState<ShipTaxRow[]>([]);
  const [review, setReview] = useState<ReviewRow[]>([]);
  
  // System diagnostic status state
  const [systemCheck, setSystemCheck] = useState<{
    shiptax: 'PASS' | 'FAIL';
    dhl: 'PASS' | 'FAIL';
    fedex: 'PASS' | 'FAIL';
    ups: 'PASS' | 'FAIL';
    database: 'PASS' | 'FAIL';
  } | null>(null);

  // Safe purge typed-confirmation states
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearTypedWord, setClearTypedWord] = useState('');
  
  // Search state
  const [dateSearch, setDateSearch] = useState('');
  const [doubleSearch, setDoubleSearch] = useState('');
  const [memorySearch, setMemorySearch] = useState('');
  const [reviewSearch, setReviewSearch] = useState('');

  // Form states
  const [selectedCourier, setSelectedCourier] = useState('AUTO');
  const [chargeMonth, setChargeMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });

  // Files uploading states
  const [shiptaxFiles, setShiptaxFiles] = useState<File[]>([]);
  const [courierFiles, setCourierFiles] = useState<File[]>([]);
  
  // Interaction/Progress feedback
  const [shiptaxStatus, setShiptaxStatus] = useState<{ type: 'idle' | 'loading' | 'success' | 'error'; message: string }>({ type: 'idle', message: '' });
  const [courierStatus, setCourierStatus] = useState<{ type: 'idle' | 'loading' | 'success' | 'error'; message: string }>({ type: 'idle', message: '' });
  const [courierDebug, setCourierDebug] = useState<any[]>([]);
  const [generalStatus, setGeneralStatus] = useState<{ type: 'idle' | 'loading' | 'success' | 'error'; message: string }>({ type: 'idle', message: '' });
  const [serverOnline, setServerOnline] = useState<boolean>(true);

  // Cloud sync states
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<{ type: 'success' | 'error' | null; text: string | null }>({ type: null, text: null });

  // Refs for upload zones
  const shiptaxInputRef = useRef<HTMLInputElement>(null);
  const courierInputRef = useRef<HTMLInputElement>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);

  // Check health of API
  const checkHealth = async () => {
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        const data = await safeParseJson(res);
        setServerOnline(data.ok === true || data.status === 'ok' || data.server === 'online');
      } else {
        setServerOnline(false);
      }
    } catch (err) {
      setServerOnline(false);
    }

    try {
      const res = await fetch('/api/db-status');
      if (res.ok) {
        const data = await safeParseJson(res);
        setDbStatus({
          status: data.status,
          error: data.error,
          rawLoaded: data.rawLoaded
        });
      }
    } catch (err) {
      console.warn("Error fetching database status:", err);
    }
  };

  // Sync database with Turso Cloud on demand
  const syncWithCloud = async () => {
    setIsSyncing(true);
    setSyncMessage({ type: null, text: null });
    try {
      const res = await fetch('/api/sync', { method: 'POST' });
      const data = await safeParseJson(res);
      if (res.ok && data.success) {
        setSyncMessage({ type: 'success', text: data.message || 'Database synchronized with Cloud successfully!' });
        await refreshAll();
      } else {
        throw new Error(data.error || data.message || 'Cloud Sync failed.');
      }
    } catch (err: any) {
      console.warn("Cloud sync failed:", err);
      setSyncMessage({ type: 'error', text: err.message || 'Cloud Sync failed.' });
    } finally {
      setIsSyncing(false);
      // Auto-dismiss sync success message after 5 seconds
      setTimeout(() => {
        setSyncMessage(prev => prev.type === 'success' ? { type: null, text: null } : prev);
      }, 5000);
    }
  };

  // Fetch summary metrics
  const fetchSummary = async () => {
    try {
      const res = await fetch('/api/summary');
      if (res.ok) {
        const data = await safeParseJson(res);
        setStats(data);
      }
    } catch (err) {
      console.warn("Error fetching summary stats:", err);
    }
  };

  // Fetch system diagnostics status
  const fetchSystemCheck = async () => {
    try {
      const res = await fetch('/api/system-check');
      if (res.ok) {
        setSystemCheck(await safeParseJson(res));
      }
    } catch (err) {
      console.warn("Error fetching system check diagnostics:", err);
    }
  };

  // Fetch individual datasets
  const fetchDatewise = async () => {
    try {
      const res = await fetch('/api/datewise');
      if (res.ok) setDatewise(await safeParseJson(res));
    } catch (err) { console.info("Datewise fetch notice:", err); }
  };

  const fetchDouble = async () => {
    try {
      const res = await fetch('/api/double');
      if (res.ok) setDouble(await safeParseJson(res));
    } catch (err) { console.info("Double billing fetch notice:", err); }
  };

  const fetchMemory = async (awbSearch?: string) => {
    try {
      const url = awbSearch ? `/api/memory?awb=${encodeURIComponent(awbSearch)}` : '/api/memory';
      const res = await fetch(url);
      if (res.ok) setMemory(await safeParseJson(res));
    } catch (err) { console.info("Memory table fetch notice:", err); }
  };

  const fetchReview = async () => {
    try {
      const res = await fetch('/api/review');
      if (res.ok) setReview(await safeParseJson(res));
    } catch (err) { console.info("Review table fetch notice:", err); }
  };

  const fetchFobReport = async () => {
    try {
      const [resPct, resCust] = await Promise.all([
        fetch('/api/fob-percentage-report'),
        fetch('/api/customer-fob')
      ]);
      if (resPct.ok) setFobReport(await safeParseJson(resPct));
      if (resCust.ok) setCustomerFobData(await safeParseJson(resCust));
    } catch (err) { console.info("FOB report fetch notice:", err); }
  };

  // Refresh all state in one click
  const refreshAll = async () => {
    await checkHealth();
    await fetchSummary();
    await fetchSystemCheck();
    if (activeTab === 'datewise') await fetchDatewise();
    if (activeTab === 'double') await fetchDouble();
    if (activeTab === 'memory') await fetchMemory();
    if (activeTab === 'review') await fetchReview();
    if (activeTab === 'fob') await fetchFobReport();
  };

  useEffect(() => {
    refreshAll();
  }, [activeTab]);

  useEffect(() => {
    // Run periodic health checks every 5 seconds to automatically heal/recover from transient offline states or server warm-ups
    const interval = setInterval(() => {
      checkHealth();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Number format helper (Indian Rupee style formatting optionally)
  const formatINR = (num: number) => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 2
    }).format(num);
  };

  // Submit ShipTax File(s)
  const handleShiptaxUpload = async () => {
    if (shiptaxFiles.length === 0) {
      setShiptaxStatus({ type: 'error', message: 'Please select at least one ShipTax file.' });
      return;
    }

    setShiptaxStatus({ type: 'loading', message: 'Processing ShipTax records...' });
    const formData = new FormData();
    shiptaxFiles.forEach(file => formData.append('files', file));

    try {
      const res = await fetch('/api/upload/shiptax', {
        method: 'POST',
        body: formData,
      });
      const data = await safeParseJson(res);
      if (res.ok) {
        setShiptaxStatus({
          type: 'success',
          message: `Successfully processed ShipTax. Added/Updated: ${data.stats.added}. Review Flags: ${data.stats.review}.`
        });
        setShiptaxFiles([]);
        fetchSummary();
      } else {
        setShiptaxStatus({ type: 'error', message: data.error || 'Failed to upload ShipTax.' });
      }
    } catch (err: any) {
      setShiptaxStatus({ type: 'error', message: err.message || 'An error occurred during upload.' });
    }
  };

  // Submit Courier Monthly Invoice File(s)
  const handleCourierUpload = async () => {
    if (courierFiles.length === 0) {
      setCourierStatus({ type: 'error', message: 'Please select at least one Courier invoice file.' });
      return;
    }

    setCourierStatus({ type: 'loading', message: 'Running audit checks...' });
    const formData = new FormData();
    courierFiles.forEach(file => formData.append('files', file));
    formData.append('courier', selectedCourier);
    formData.append('charge_month', chargeMonth);

    try {
      const res = await fetch('/api/upload/courier', {
        method: 'POST',
        body: formData,
      });
      const data = await safeParseJson(res);
      if (res.ok) {
        const doubleCount = data.stats.double || 0;
        setCourierStatus({
          type: doubleCount > 0 ? 'error' : 'success',
          message: `Audit complete. Added Charges: ${data.stats.added}, Double Billings Caught: ${doubleCount}, Skipped Row Re-uploads: ${data.stats.skipped}, Review Row Logs: ${data.stats.review}`
        });
        setCourierDebug(data.debug || []);
        setCourierFiles([]);
        fetchSummary();
      } else {
        setCourierStatus({ type: 'error', message: data.error || 'Failed to complete Courier Audit.' });
        setCourierDebug([]);
      }
    } catch (err: any) {
      setCourierStatus({ type: 'error', message: err.message || 'An error occurred during audit execution.' });
      setCourierDebug([]);
    }
  };

  const handleFobUpload = async () => {
    if (fobFiles.length === 0) {
      setFobStatus({ type: 'error', message: 'Please select at least one Customer Report / FOB file.' });
      return;
    }

    setFobStatus({ type: 'loading', message: 'Processing Customer Report & FOB records...' });
    const formData = new FormData();
    fobFiles.forEach(file => formData.append('files', file));

    try {
      const res = await fetch('/api/upload/fob', {
        method: 'POST',
        body: formData,
      });
      const data = await safeParseJson(res);
      if (res.ok) {
        setFobStatus({
          type: 'success',
          message: `Successfully processed FOB records. Added: ${data.stats.added}. Updated: ${data.stats.updated}. Review flags: ${data.stats.review}`
        });
        setFobFiles([]);
        fetchSummary();
        fetchFobReport();
      } else {
        setFobStatus({ type: 'error', message: data.error || 'Failed to upload Customer FOB report.' });
      }
    } catch (err: any) {
      setFobStatus({ type: 'error', message: err.message || 'An error occurred during FOB upload.' });
    }
  };

  // Restore DB backup
  const handleRestoreBackup = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setGeneralStatus({ type: 'loading', message: 'Restoring backup data...' });
    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/restore', {
        method: 'POST',
        body: formData
      });
      if (res.ok) {
        setGeneralStatus({ type: 'success', message: 'Database backup successfully restored!' });
        fetchSummary();
      } else {
        const err = await safeParseJson(res);
        setGeneralStatus({ type: 'error', message: err.error || 'Failed to restore backup.' });
      }
    } catch (err: any) {
      setGeneralStatus({ type: 'error', message: err.message || 'An error occurred.' });
    }
    // reset input
    if (e.target) e.target.value = '';
  };

  // Clear Database
  const handleClearDatabase = async () => {
    setShowClearConfirm(true);
    setClearTypedWord('');
  };

  const executeClearDatabase = async () => {
    if (clearTypedWord.trim().toUpperCase() !== 'CLEAR') {
      alert("Please type 'CLEAR' in all caps to confirm.");
      return;
    }
    
    try {
      const res = await fetch('/api/clear', { method: 'POST' });
      if (res.ok) {
        alert("Database cleared successfully.");
        setShowClearConfirm(false);
        setClearTypedWord('');
        fetchSummary();
        setDatewise([]);
        setDouble([]);
        setMemory([]);
        setReview([]);
      } else {
        alert("Failed to clear database.");
      }
    } catch (err: any) {
      alert("Error clearing database: " + err.message);
    }
  };

  // Filter lists based on searches
  const filteredDatewise = datewise.filter(row => 
    row.ship_date?.toLowerCase().includes(dateSearch.toLowerCase()) ||
    row.courier?.toLowerCase().includes(dateSearch.toLowerCase()) ||
    row.awbs?.toLowerCase().includes(dateSearch.toLowerCase())
  );

  const filteredDouble = double.filter(row => 
    row.awb?.toLowerCase().includes(doubleSearch.toLowerCase()) ||
    row.courier?.toLowerCase().includes(doubleSearch.toLowerCase()) ||
    row.message?.toLowerCase().includes(doubleSearch.toLowerCase()) ||
    row.first_invoice_number?.toLowerCase().includes(doubleSearch.toLowerCase()) ||
    row.repeat_invoice_number?.toLowerCase().includes(doubleSearch.toLowerCase())
  );

  const filteredMemory = memory;

  const filteredReview = review.filter(row => 
    row.reason?.toLowerCase().includes(reviewSearch.toLowerCase()) ||
    row.courier?.toLowerCase().includes(reviewSearch.toLowerCase()) ||
    row.awb?.toLowerCase().includes(reviewSearch.toLowerCase()) ||
    row.message?.toLowerCase().includes(reviewSearch.toLowerCase())
  );

  const filteredFobReport = fobReport.filter(row => {
    const term = fobSearch.toLowerCase();
    const matchesSearch = 
      row.awb?.toLowerCase().includes(term) ||
      row.courier?.toLowerCase().includes(term) ||
      row.destinationCountry?.toLowerCase().includes(term) ||
      row.chargeType?.toLowerCase().includes(term) ||
      row.orderReference?.toLowerCase().includes(term);
      
    if (fobStatusFilter === 'ALL') return matchesSearch;
    return matchesSearch && row.matchStatus === fobStatusFilter;
  });

  const totalFobPages = Math.ceil(filteredFobReport.length / fobPageSize) || 1;
  const paginatedFobReport = filteredFobReport.slice((fobPage - 1) * fobPageSize, fobPage * fobPageSize);

  const matchedReportRows = fobReport.filter(row => {
    const term = fobSearch.toLowerCase();
    const matchesSearch = 
      row.awb?.toLowerCase().includes(term) ||
      row.courier?.toLowerCase().includes(term) ||
      row.destinationCountry?.toLowerCase().includes(term) ||
      row.chargeType?.toLowerCase().includes(term) ||
      row.fobInvoice?.toLowerCase().includes(term) ||
      row.fobShippingBill?.toLowerCase().includes(term) ||
      row.orderReference?.toLowerCase().includes(term);
      
    const isMatchedOrMismatched = row.matchStatus === 'Matched' || row.matchStatus === 'Mismatched';
    
    if (fobStatusFilter === 'ALL') return matchesSearch && isMatchedOrMismatched;
    return matchesSearch && row.matchStatus === fobStatusFilter;
  });

  const unmatchedReportRows = fobReport.filter(row => {
    const term = fobSearch.toLowerCase();
    const matchesSearch = 
      row.awb?.toLowerCase().includes(term) ||
      row.courier?.toLowerCase().includes(term) ||
      row.destinationCountry?.toLowerCase().includes(term) ||
      row.chargeType?.toLowerCase().includes(term);
      
    return matchesSearch && row.matchStatus === 'Missing';
  });

  const filteredCustomerFobRows = customerFobData.filter(row => {
    const term = fobSearch.toLowerCase();
    return (
      row.awb?.toLowerCase().includes(term) ||
      row.original_awb?.toLowerCase().includes(term) ||
      row.invoice_number?.toLowerCase().includes(term) ||
      row.shipping_bill?.toLowerCase().includes(term) ||
      row.country?.toLowerCase().includes(term) ||
      row.source_file?.toLowerCase().includes(term)
    );
  });

  const totalMatchedPages = Math.ceil(matchedReportRows.length / fobPageSize) || 1;
  const paginatedMatchedReport = matchedReportRows.slice((fobPage - 1) * fobPageSize, fobPage * fobPageSize);

  const totalUnmatchedPages = Math.ceil(unmatchedReportRows.length / fobPageSize) || 1;
  const paginatedUnmatchedReport = unmatchedReportRows.slice((fobPage - 1) * fobPageSize, fobPage * fobPageSize);

  const totalCustomerPages = Math.ceil(filteredCustomerFobRows.length / fobPageSize) || 1;
  const paginatedCustomerReport = filteredCustomerFobRows.slice((customerPage - 1) * fobPageSize, customerPage * fobPageSize);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 selection:bg-blue-500 selection:text-white">
      {/* Premium Header */}
      <header className="sticky top-0 z-40 bg-white border-b border-slate-200 shadow-xs">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-18 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 bg-blue-600 rounded-xl text-white shadow-sm">
              <Database className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-slate-900">Harry Fashion</h1>
              <p className="text-xs font-medium text-slate-500">Courier Duty Auditor & Duplicate Checker</p>
            </div>
          </div>

          <div className="flex items-center space-x-3">
            <button 
              onClick={refreshAll}
              className="p-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-slate-600 transition-colors cursor-pointer"
              title="Refresh Data Stats"
            >
              <RefreshCw className="w-5 h-5" />
            </button>

            {/* Pull Cloud Sync Button */}
            <button
              onClick={syncWithCloud}
              disabled={isSyncing}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold shadow-xs border transition-all cursor-pointer ${
                isSyncing 
                  ? 'bg-amber-50 text-amber-700 border-amber-200 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-700 text-white border-blue-500'
              }`}
              title="Pull the absolute latest data from Turso Cloud Database"
            >
              <Cloud className={`w-4 h-4 ${isSyncing ? 'animate-bounce' : ''}`} />
              <span>{isSyncing ? 'Syncing...' : 'Sync Cloud'}</span>
            </button>

            {serverOnline ? (
              <div className="text-xs bg-emerald-50 text-emerald-700 border border-emerald-100 px-3 py-1.5 rounded-lg font-medium hidden sm:block">
                Server Database Online
              </div>
            ) : (
              <div className="text-xs bg-rose-50 text-rose-700 border border-rose-100 px-3 py-1.5 rounded-lg font-medium hidden sm:block">
                Server Offline
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Grid Wrapper */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

        {/* Cloud Sync Success/Error Banner */}
        {syncMessage.text && (
          <div className={`p-4 rounded-xl shadow-xs mb-6 flex items-center justify-between border ${
            syncMessage.type === 'success' 
              ? 'bg-emerald-50 text-emerald-800 border-emerald-200' 
              : 'bg-rose-50 text-rose-800 border-rose-200'
          }`}>
            <div className="flex items-center space-x-2.5 text-sm font-medium">
              <Cloud className={`w-5 h-5 shrink-0 ${syncMessage.type === 'success' ? 'text-emerald-600' : 'text-rose-600'}`} />
              <span>{syncMessage.text}</span>
            </div>
            <button 
              onClick={() => setSyncMessage({ type: null, text: null })}
              className="text-xs font-bold hover:opacity-75 cursor-pointer bg-transparent border-none text-slate-500"
            >
              Dismiss
            </button>
          </div>
        )}
        
        {/* Cloud database warning banner */}
        {(dbStatus.status === 'Quota exceeded' || dbStatus.status === 'Data not loaded') && (
          <div className="bg-red-500 text-white font-bold px-6 py-4 rounded-2xl shadow-md mb-8 flex items-center space-x-3 animate-pulse border-2 border-red-600">
            <AlertCircle className="w-6 h-6 shrink-0" />
            <div className="flex-1 text-sm md:text-base">
              Cloud database unavailable or quota exceeded. Do not trust totals until this is fixed.
              {dbStatus.error && (
                <span className="block text-xs font-mono opacity-85 mt-1">Error Details: {dbStatus.error}</span>
              )}
            </div>
          </div>
        )}

        {/* Temporary storage warning banner */}
        {dbStatus.status === 'Using temporary cache' && (
          <div className="bg-amber-50 border border-amber-200 text-slate-800 rounded-2xl shadow-sm mb-8 overflow-hidden">
            <div className="bg-amber-500 text-white font-bold px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center space-x-3">
                <AlertTriangle className="w-6 h-6 shrink-0 text-white" />
                <div className="text-sm md:text-base">
                  Warning: Temporary storage only (Cloud db not reachable). Uploads will be reset when container restarts.
                  {dbStatus.error && (
                    <span className="block text-xs font-mono opacity-85 mt-1">Error Details: {dbStatus.error}</span>
                  )}
                </div>
              </div>
              <button 
                onClick={() => setShowCloudGuide(!showCloudGuide)}
                className="bg-white text-amber-600 hover:bg-amber-50 px-4 py-2 rounded-xl text-sm font-bold shadow-xs transition-colors shrink-0 self-start sm:self-auto cursor-pointer"
              >
                {showCloudGuide ? 'Hide Setup Guide' : 'Connect to Cloud Free'}
              </button>
            </div>
            
            {showCloudGuide && (
              <div className="p-6 bg-white border-t border-amber-200 text-slate-700 space-y-4">
                <div className="flex items-center space-x-2 text-amber-700 font-bold text-sm">
                  <Cloud className="w-5 h-5" />
                  <span>2-Minute Free Cloud Sync Guide (Turso Database)</span>
                </div>
                
                <p className="text-sm text-slate-600">
                  This application uses <strong>Turso (libSQL)</strong>, a serverless cloud SQLite engine with an extremely generous <strong>completely free tier</strong> (9 Billion reads/month, 500MB storage, no credit card required to start). Follow these steps to persist your data permanently:
                </p>

                <ol className="list-decimal pl-5 space-y-3 text-sm text-slate-600">
                  <li>
                    <strong>Create a free Turso Account:</strong> Go to <a href="https://turso.tech" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-semibold">turso.tech</a> and sign up for a free account.
                  </li>
                  <li>
                    <strong>Create a database:</strong> Use the Turso CLI or the web dashboard to create a new database (e.g. <code>courier-duty-check</code>).
                  </li>
                  <li>
                    <strong>Get your credentials:</strong>
                    <ul className="list-disc pl-5 mt-1 space-y-1 text-xs font-mono text-slate-500">
                      <li>Database URL (e.g., <code>libsql://courier-duty-check-username.turso.io</code>)</li>
                      <li>Auth Token (generated from the database dashboard or CLI)</li>
                    </ul>
                  </li>
                  <li>
                    <strong>Configure AI Studio:</strong>
                    <ul className="list-disc pl-5 mt-1 space-y-1">
                      <li>Open the <strong>Settings</strong> panel (gear icon) in the <strong>Google AI Studio Build</strong> interface.</li>
                      <li>Go to <strong>Secrets</strong> / <strong>Environment Variables</strong>.</li>
                      <li>Add the following two secrets/variables:
                        <div className="bg-slate-50 border border-slate-200 rounded-lg p-2 font-mono text-xs text-slate-700 mt-1 max-w-md">
                          <strong>TURSO_DATABASE_URL</strong> = (your database URL)<br />
                          <strong>TURSO_AUTH_TOKEN</strong> = (your auth token)
                        </div>
                      </li>
                    </ul>
                  </li>
                  <li>
                    <strong>Restart Server & Sync:</strong> Once variables are configured, click the <strong>"Sync with Cloud"</strong> button or reload this page. The system will automatically construct the tables and sync your current local uploads to your free cloud database!
                  </li>
                </ol>

                <div className="pt-2 flex justify-end">
                  <button 
                    onClick={() => setShowCloudGuide(false)}
                    className="text-slate-500 hover:text-slate-800 text-xs font-medium cursor-pointer"
                  >
                    Close Setup Guide
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Status Metrics Ribbon */}
        <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
          <div className="bg-white border border-slate-200 p-4 rounded-xl shadow-xs flex items-center space-x-4">
            <div className="p-3 bg-blue-50 text-blue-600 rounded-lg">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">ShipTax Memory</p>
              <strong className="text-2xl font-bold text-slate-900">{stats.shiptax.toLocaleString()}</strong>
            </div>
          </div>

          <div className="bg-white border border-slate-200 p-4 rounded-xl shadow-xs flex items-center space-x-4">
            <div className="p-3 bg-indigo-50 text-indigo-600 rounded-lg">
              <FileSpreadsheet className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">Courier Charges</p>
              <strong className="text-2xl font-bold text-slate-900">{stats.charges.toLocaleString()}</strong>
            </div>
          </div>

          <div className="bg-white border border-slate-200 p-4 rounded-xl shadow-xs flex items-center space-x-4">
            <div className={`p-3 rounded-lg ${stats.double > 0 ? 'bg-red-50 text-red-600' : 'bg-slate-50 text-slate-600'}`}>
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">Double Billings</p>
              <strong className={`text-2xl font-bold ${stats.double > 0 ? 'text-red-600' : 'text-slate-900'}`}>{stats.double.toLocaleString()}</strong>
            </div>
          </div>

          <div className="bg-white border border-slate-200 p-4 rounded-xl shadow-xs flex items-center space-x-4">
            <div className="p-3 bg-emerald-50 text-emerald-600 rounded-lg">
              <Calendar className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">Dated Duty Sum</p>
              <strong className="text-base sm:text-lg font-bold text-slate-900 block truncate" title={formatINR(stats.duty)}>
                {formatINR(stats.duty)}
              </strong>
            </div>
          </div>

          <div className="bg-white border border-slate-200 p-4 rounded-xl shadow-xs flex items-center space-x-4">
            <div className={`p-3 rounded-lg ${stats.review > 0 ? 'bg-amber-50 text-amber-600' : 'bg-slate-50 text-slate-600'}`}>
              <Info className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">Needs Review</p>
              <strong className={`text-2xl font-bold ${stats.review > 0 ? 'text-amber-600' : 'text-slate-900'}`}>{stats.review.toLocaleString()}</strong>
            </div>
          </div>

          <div className="bg-white border border-slate-200 p-4 rounded-xl shadow-xs flex items-center space-x-4">
            <div className={`p-3 rounded-lg ${
              dbStatus.status === 'Connected' ? 'bg-emerald-50 text-emerald-600' :
              dbStatus.status === 'Quota exceeded' ? 'bg-red-50 text-red-600 animate-pulse' :
              dbStatus.status === 'Using temporary cache' ? 'bg-amber-50 text-amber-600' :
              'bg-slate-100 text-slate-600'
            }`}>
              <Database className="w-5 h-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">Database Status</p>
              <span className={`text-xs sm:text-sm font-extrabold block truncate ${
                dbStatus.status === 'Connected' ? 'text-emerald-600' :
                dbStatus.status === 'Quota exceeded' ? 'text-red-600' :
                dbStatus.status === 'Using temporary cache' ? 'text-amber-600' :
                'text-slate-500'
              }`}>
                {dbStatus.status}
              </span>
            </div>
          </div>
        </section>

        {/* Tab Navigation Menu */}
        <nav className="flex space-x-1 border-b border-slate-200 mb-8 overflow-x-auto whitespace-nowrap scrollbar-none">
          <button
            onClick={() => setActiveTab('shiptax')}
            className={`px-5 py-3 font-semibold text-sm transition-all border-b-2 cursor-pointer ${activeTab === 'shiptax' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          >
            1. Upload ShipTax Master
          </button>
          <button
            onClick={() => setActiveTab('courier')}
            className={`px-5 py-3 font-semibold text-sm transition-all border-b-2 cursor-pointer ${activeTab === 'courier' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          >
            2. Upload Courier Invoice
          </button>
          <button
            onClick={() => setActiveTab('fob')}
            className={`px-5 py-3 font-semibold text-sm transition-all border-b-2 cursor-pointer ${activeTab === 'fob' ? 'border-violet-600 text-violet-600' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          >
            3. Customer Report / FOB
          </button>
          <button
            onClick={() => setActiveTab('datewise')}
            className={`px-5 py-3 font-semibold text-sm transition-all border-b-2 cursor-pointer ${activeTab === 'datewise' ? 'border-emerald-600 text-emerald-600' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          >
            4. Datewise Duty ({datewise.length})
          </button>
          <button
            onClick={() => setActiveTab('double')}
            className={`px-5 py-3 font-semibold text-sm transition-all border-b-2 cursor-pointer ${activeTab === 'double' ? 'border-red-600 text-red-600' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          >
            5. Double Billing ({stats.double})
          </button>
          <button
            onClick={() => setActiveTab('review')}
            className={`px-5 py-3 font-semibold text-sm transition-all border-b-2 cursor-pointer ${activeTab === 'review' ? 'border-amber-600 text-amber-600' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          >
            6. Needs Review ({stats.review})
          </button>
          <button
            onClick={() => setActiveTab('memory')}
            className={`px-5 py-3 font-semibold text-sm transition-all border-b-2 cursor-pointer ${activeTab === 'memory' ? 'border-slate-700 text-slate-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          >
            7. ShipTax Memory ({stats.shiptax})
          </button>
          <button
            onClick={() => setActiveTab('export')}
            className={`px-5 py-3 font-semibold text-sm transition-all border-b-2 cursor-pointer ${activeTab === 'export' ? 'border-slate-700 text-slate-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          >
            8. Export / Backup
          </button>
          <button
            onClick={() => setActiveTab('comparator')}
            className={`px-5 py-3 font-semibold text-sm transition-all border-b-2 cursor-pointer ${activeTab === 'comparator' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          >
            9. Courier Rate Comparator
          </button>
          <button
            onClick={() => setActiveTab('rate-admin')}
            className={`px-5 py-3 font-semibold text-sm transition-all border-b-2 cursor-pointer ${activeTab === 'rate-admin' ? 'border-amber-600 text-amber-600' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          >
            10. Rate Chart Settings
          </button>
        </nav>

        {/* System Diagnostics Status */}
        {systemCheck && (
          <section className="bg-white border border-slate-200 rounded-2xl shadow-xs p-5 mb-8">
            <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-4 flex items-center space-x-2">
              <CheckCircle className="w-4 h-4 text-emerald-500" />
              <span>System diagnostics status</span>
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
              {[
                { label: 'ShipTax Dates', val: systemCheck.shiptax },
                { label: 'DHL Rules', val: systemCheck.dhl },
                { label: 'FedEx Rules', val: systemCheck.fedex },
                { label: 'UPS Logic', val: systemCheck.ups },
                { label: 'Cloud DB', val: systemCheck.database },
              ].map((item, idx) => (
                <div key={idx} className="bg-slate-50 border border-slate-100 rounded-xl p-3 flex flex-col items-center justify-center text-center">
                  <span className="text-xs font-medium text-slate-500">{item.label}</span>
                  <span className={`mt-2 text-xs font-extrabold px-3 py-1 rounded-full border ${
                    item.val === 'PASS' 
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-100' 
                      : 'bg-rose-50 text-rose-700 border-rose-100'
                  }`}>
                    {item.val}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Tab views */}
        {activeTab === 'shiptax' && (
          <section className="max-w-3xl mx-auto">
            {/* Box 1: ShipTax Reference Upload */}
            <article className="bg-white border border-slate-200 rounded-2xl shadow-xs p-6 flex flex-col justify-between">
              <div>
                <div className="flex items-center space-x-2.5 mb-4">
                  <div className="p-2 bg-blue-50 text-blue-600 rounded-lg">
                    <Database className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">Upload ShipTax Master Ledger</h2>
                    <p className="text-xs text-slate-500">Store current year shipments to look up dates and original details.</p>
                  </div>
                </div>

                {/* Drag-and-drop zone */}
                <div 
                  onClick={() => shiptaxInputRef.current?.click()}
                  className="border-2 border-dashed border-slate-200 hover:border-blue-400 rounded-xl bg-slate-50 p-6 text-center cursor-pointer hover:bg-blue-50/20 transition-all duration-200 group"
                >
                  <Upload className="w-8 h-8 text-slate-400 group-hover:text-blue-500 mx-auto mb-2 transition-colors" />
                  <p className="text-sm font-semibold text-slate-700">Click to Select ShipTax File</p>
                  <p className="text-xs text-slate-400 mt-1">Accepts CSV, Excel (XLSX/XLSM/XLS), or ZIP containing them</p>
                  
                  {shiptaxFiles.length > 0 && (
                    <div className="mt-3 p-2 bg-blue-50/50 rounded-lg text-xs font-semibold text-blue-700 border border-blue-100 flex items-center justify-center space-x-1.5">
                      <FileText className="w-3.5 h-3.5" />
                      <span>{shiptaxFiles.length} file(s) selected</span>
                    </div>
                  )}
                </div>

                <input 
                  type="file" 
                  ref={shiptaxInputRef}
                  multiple 
                  accept=".csv,.xlsx,.xlsm,.xls,.zip"
                  onChange={e => e.target.files && setShiptaxFiles(Array.from(e.target.files))}
                  className="hidden"
                />

                {shiptaxStatus.message && (
                  <div className={`mt-4 p-3.5 rounded-lg border text-sm flex items-start space-x-2.5 ${
                    shiptaxStatus.type === 'error' ? 'bg-red-50 text-red-700 border-red-100' :
                    shiptaxStatus.type === 'success' ? 'bg-emerald-50 text-emerald-700 border-emerald-100' :
                    'bg-blue-50 text-blue-700 border-blue-100'
                  }`}>
                    {shiptaxStatus.type === 'success' ? <CheckCircle className="w-5 h-5 shrink-0" /> : <Info className="w-5 h-5 shrink-0" />}
                    <span>{shiptaxStatus.message}</span>
                  </div>
                )}
              </div>

              <button 
                onClick={handleShiptaxUpload}
                disabled={shiptaxFiles.length === 0 || shiptaxStatus.type === 'loading'}
                className={`mt-6 w-full py-3 rounded-xl font-bold text-sm tracking-wide transition-all shadow-xs cursor-pointer flex items-center justify-center space-x-1.5 ${
                  shiptaxFiles.length === 0 || shiptaxStatus.type === 'loading'
                    ? 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed'
                    : 'bg-blue-600 text-white hover:bg-blue-700 active:scale-98'
                }`}
              >
                {shiptaxStatus.type === 'loading' && <RefreshCw className="w-4 h-4 animate-spin" />}
                <span>Store ShipTax AWBs</span>
              </button>
            </article>
          </section>
        )}

        {activeTab === 'courier' && (
          <section className="max-w-3xl mx-auto">
            {/* Box 2: Courier Audit & Duplicate Check */}
            <article className="bg-white border border-slate-200 rounded-2xl shadow-xs p-6 flex flex-col justify-between">
              <div>
                <div className="flex items-center space-x-2.5 mb-4">
                  <div className="p-2 bg-indigo-50 text-indigo-600 rounded-lg">
                    <Sparkles className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">Upload Courier Invoice File</h2>
                    <p className="text-xs text-slate-500">Detect double billings, audit taxes, and map with ShipTax timelines.</p>
                  </div>
                </div>

                {/* Courier selection fields */}
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Select Courier</label>
                    <select 
                      value={selectedCourier}
                      onChange={e => setSelectedCourier(e.target.value)}
                      className="w-full bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold transition-colors outline-none focus:border-indigo-400 focus:bg-white cursor-pointer"
                    >
                      <option value="AUTO">Auto Detect</option>
                      <option value="DHL">DHL</option>
                      <option value="UPS">UPS</option>
                      <option value="FedEx">FedEx</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Billing Month</label>
                    <input 
                      type="month"
                      value={chargeMonth}
                      onChange={e => setChargeMonth(e.target.value)}
                      className="w-full bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold transition-colors outline-none focus:border-indigo-400 focus:bg-white cursor-pointer"
                    />
                  </div>
                </div>

                {/* Drag-and-drop zone */}
                <div 
                  onClick={() => courierInputRef.current?.click()}
                  className="border-2 border-dashed border-slate-200 hover:border-indigo-400 rounded-xl bg-slate-50 p-6 text-center cursor-pointer hover:bg-indigo-50/20 transition-all duration-200 group"
                >
                  <Upload className="w-8 h-8 text-slate-400 group-hover:text-indigo-500 mx-auto mb-2 transition-colors" />
                  <p className="text-sm font-semibold text-slate-700">Click to Select Courier Invoice</p>
                  <p className="text-xs text-slate-400 mt-1">Accepts CSV, Excel (XLSX/XLSM/XLS), or ZIP containing invoices</p>
                  
                  {courierFiles.length > 0 && (
                    <div className="mt-3 p-2 bg-indigo-50/50 rounded-lg text-xs font-semibold text-indigo-700 border border-indigo-100 flex items-center justify-center space-x-1.5">
                      <FileText className="w-3.5 h-3.5" />
                      <span>{courierFiles.length} file(s) selected</span>
                    </div>
                  )}
                </div>

                <input 
                  type="file" 
                  ref={courierInputRef}
                  multiple 
                  accept=".csv,.xlsx,.xlsm,.xls,.zip"
                  onChange={e => e.target.files && setCourierFiles(Array.from(e.target.files))}
                  className="hidden"
                />

                {courierStatus.message && (
                  <div className={`mt-4 p-3.5 rounded-lg border text-sm flex items-start space-x-2.5 ${
                    courierStatus.type === 'error' ? 'bg-red-50 text-red-700 border-red-100' :
                    courierStatus.type === 'success' ? 'bg-emerald-50 text-emerald-700 border-emerald-100' :
                    'bg-indigo-50 text-indigo-700 border-indigo-100'
                  }`}>
                    {courierStatus.type === 'success' ? <CheckCircle className="w-5 h-5 shrink-0" /> : <AlertTriangle className="w-5 h-5 shrink-0 text-red-500" />}
                    <span>{courierStatus.message}</span>
                  </div>
                )}

                {courierDebug.length > 0 && (
                  <div className="mt-4 p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                    <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center space-x-1.5">
                      <Terminal className="w-3.5 h-3.5 text-indigo-500" />
                      <span>Parser Debug Logs</span>
                    </h4>
                    <div className="divide-y divide-slate-100 max-h-60 overflow-y-auto pr-1">
                      {courierDebug.map((report, idx) => (
                        <div key={idx} className="py-2.5 first:pt-0 last:pb-0 space-y-1.5">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-semibold text-slate-800 truncate max-w-[200px]" title={report.fileName}>
                              {report.fileName} ({report.sheetName})
                            </span>
                            <span className="px-2 py-0.5 rounded bg-indigo-50 text-indigo-600 font-bold font-mono">
                              {report.courier}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] font-mono text-slate-500">
                            <div>Scanned Rows: {report.rowsScanned}</div>
                            <div>Header Row: {report.headerRowFound}</div>
                            <div>Duty Rows: {report.dutyRowsFound}</div>
                            <div>Added / Skipped: {report.rowsAdded} / {report.rowsSkipped}</div>
                          </div>
                          {report.missingColumns && report.missingColumns.length > 0 && (
                            <div className="text-[11px] font-semibold text-red-600 flex items-center space-x-1 mt-1">
                              <AlertTriangle className="w-3 h-3 text-red-500 shrink-0" />
                              <span>Missing columns: {report.missingColumns.join(', ')}</span>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <button 
                onClick={handleCourierUpload}
                disabled={courierFiles.length === 0 || courierStatus.type === 'loading'}
                className={`mt-6 w-full py-3 rounded-xl font-bold text-sm tracking-wide transition-all shadow-xs cursor-pointer flex items-center justify-center space-x-1.5 ${
                  courierFiles.length === 0 || courierStatus.type === 'loading'
                    ? 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed'
                    : 'bg-indigo-600 text-white hover:bg-indigo-700 active:scale-98'
                }`}
              >
                {courierStatus.type === 'loading' && <RefreshCw className="w-4 h-4 animate-spin" />}
                <span>Run Courier Audit</span>
              </button>
            </article>
          </section>
        )}

        {activeTab === 'fob' && (
          <div className="space-y-6">
            {/* Sub-tabs header */}
            <div className="flex flex-col sm:flex-row border-b border-slate-200 bg-slate-100 p-1.5 rounded-xl gap-1">
              <button
                onClick={() => { setFobSubTab('summary'); setFobPage(1); }}
                className={`flex-1 py-2 px-4 rounded-lg text-xs font-bold transition-all cursor-pointer text-center ${fobSubTab === 'summary' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'}`}
              >
                Summary
              </button>
              <button
                onClick={() => { setFobSubTab('matched'); setFobPage(1); }}
                className={`flex-1 py-2 px-4 rounded-lg text-xs font-bold transition-all cursor-pointer text-center ${fobSubTab === 'matched' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'}`}
              >
                Matched Duty FOB ({matchedReportRows.length})
              </button>
              <button
                onClick={() => { setFobSubTab('unmatched'); setFobPage(1); }}
                className={`flex-1 py-2 px-4 rounded-lg text-xs font-bold transition-all cursor-pointer text-center ${fobSubTab === 'unmatched' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'}`}
              >
                Unmatched Duty Review ({unmatchedReportRows.length})
              </button>
              <button
                onClick={() => { setFobSubTab('customer-review'); setCustomerPage(1); }}
                className={`flex-1 py-2 px-4 rounded-lg text-xs font-bold transition-all cursor-pointer text-center ${fobSubTab === 'customer-review' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'}`}
              >
                Customer File Review ({customerFobData.length})
              </button>
            </div>

            {/* Sub-tab 1: Summary Dashboard */}
            {fobSubTab === 'summary' && (
              <div className="space-y-6">
                {/* KPI Metrics Dashboard */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs">
                    <span className="block text-xs uppercase text-slate-400 font-extrabold">Total Courier Shipments</span>
                    <span className="text-2xl font-black text-slate-900 block mt-1">{fobReport.length}</span>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs border-l-4 border-l-emerald-500">
                    <span className="block text-xs uppercase text-slate-400 font-extrabold">Matched Shipments</span>
                    <span className="text-2xl font-black text-emerald-600 block mt-1">
                      {fobReport.filter(r => r.matchStatus === 'Matched').length}
                    </span>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs border-l-4 border-l-rose-500">
                    <span className="block text-xs uppercase text-slate-400 font-extrabold">Mismatched Details</span>
                    <span className="text-2xl font-black text-rose-600 block mt-1">
                      {fobReport.filter(r => r.matchStatus === 'Mismatched').length}
                    </span>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs border-l-4 border-l-amber-500">
                    <span className="block text-xs uppercase text-slate-400 font-extrabold">Missing/Unmatched Duty</span>
                    <span className="text-2xl font-black text-amber-600 block mt-1">
                      {fobReport.filter(r => r.matchStatus === 'Missing').length}
                    </span>
                  </div>
                </div>

                {/* Upload Section */}
                <section className="max-w-3xl mx-auto">
                  <article className="bg-white border border-slate-200 rounded-2xl shadow-xs p-6 flex flex-col justify-between">
                    <div>
                      <div className="flex items-center space-x-2.5 mb-4">
                        <div className="p-2 bg-violet-50 text-violet-600 rounded-lg">
                          <Sparkles className="w-5 h-5" />
                        </div>
                        <div>
                          <h2 className="text-lg font-bold text-slate-900">Upload Customer FOB / Export Report</h2>
                          <p className="text-xs text-slate-500">Auto-detects AWB and FOB values to evaluate duty-to-FOB percentage ratios.</p>
                        </div>
                      </div>

                      {/* Drag-and-drop zone */}
                      <div 
                        onClick={() => fobInputRef.current?.click()}
                        className="border-2 border-dashed border-slate-200 hover:border-violet-400 rounded-xl bg-slate-50 p-6 text-center cursor-pointer hover:bg-violet-50/20 transition-all duration-200 group"
                      >
                        <Upload className="w-8 h-8 text-slate-400 group-hover:text-violet-500 mx-auto mb-2 transition-colors" />
                        <p className="text-sm font-semibold text-slate-700">Click to Select Customer FOB Report</p>
                        <p className="text-xs text-slate-400 mt-1">Accepts CSV, Excel (XLSX/XLSM/XLS), or ZIP containing them</p>
                        
                        {fobFiles.length > 0 && (
                          <div className="mt-3 p-2 bg-violet-50/50 rounded-lg text-xs font-semibold text-violet-700 border border-violet-100 flex items-center justify-center space-x-1.5">
                            <FileText className="w-3.5 h-3.5" />
                            <span>{fobFiles.length} file(s) selected</span>
                          </div>
                        )}
                      </div>

                      <input 
                        type="file" 
                        ref={fobInputRef}
                        multiple 
                        accept=".csv,.xlsx,.xlsm,.xls,.zip"
                        onChange={e => e.target.files && setFobFiles(Array.from(e.target.files))}
                        className="hidden"
                      />

                      {fobStatus.message && (
                        <div className={`mt-4 p-3.5 rounded-lg border text-sm flex items-start space-x-2.5 ${
                          fobStatus.type === 'error' ? 'bg-red-50 text-red-700 border-red-100' :
                          fobStatus.type === 'success' ? 'bg-emerald-50 text-emerald-700 border-emerald-100' :
                          'bg-violet-50 text-violet-700 border-violet-100'
                        }`}>
                          {fobStatus.type === 'success' ? <CheckCircle className="w-5 h-5 shrink-0" /> : <Info className="w-5 h-5 shrink-0 text-violet-600" />}
                          <span>{fobStatus.message}</span>
                        </div>
                      )}
                    </div>

                    <button 
                      onClick={handleFobUpload}
                      disabled={fobFiles.length === 0 || fobStatus.type === 'loading'}
                      className={`mt-6 w-full py-3 rounded-xl font-bold text-sm tracking-wide transition-all shadow-xs cursor-pointer flex items-center justify-center space-x-1.5 ${
                        fobFiles.length === 0 || fobStatus.type === 'loading'
                          ? 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed'
                          : 'bg-violet-600 text-white hover:bg-violet-700 active:scale-98'
                      }`}
                    >
                      {fobStatus.type === 'loading' && <RefreshCw className="w-4 h-4 animate-spin" />}
                      <span>Parse Customer FOB Report</span>
                    </button>
                  </article>
                </section>
              </div>
            )}

            {/* Sub-tab 2: Matched Duty FOB */}
            {fobSubTab === 'matched' && (
              <div className="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-hidden">
                <div className="p-5 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">Matched Duty FOB</h2>
                    <p className="text-xs text-slate-500">Audit courier duties against product invoice values to track percentage taxes and verify discrepancies.</p>
                  </div>
                  <div className="flex flex-col sm:flex-row items-center gap-3 w-full md:max-w-3xl">
                    <div className="w-full sm:w-44 shrink-0">
                      <select 
                        value={fobStatusFilter}
                        onChange={e => { setFobStatusFilter(e.target.value as any); setFobPage(1); }}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold transition-colors outline-none focus:border-violet-400 focus:bg-white cursor-pointer"
                      >
                        <option value="ALL">All Match Statuses</option>
                        <option value="Matched">Matched</option>
                        <option value="Mismatched">Mismatched</option>
                      </select>
                    </div>
                    <div className="relative flex-1 w-full">
                      <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                      <input 
                        type="text"
                        placeholder="Search AWB, Courier, Country, Shipping Bill..."
                        value={fobSearch}
                        onChange={e => { setFobSearch(e.target.value); setFobPage(1); }}
                        className="pl-10 pr-4 py-2 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg text-sm w-full outline-none focus:border-violet-400 focus:bg-white font-medium"
                      />
                    </div>
                    <a 
                      href="/api/export-fob.xlsx"
                      download
                      className="w-full sm:w-auto px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-bold transition-all shadow-xs flex items-center justify-center gap-2 active:scale-98 cursor-pointer shrink-0"
                      title="Download the full Duty/FOB percentage report as a structured Excel sheet"
                    >
                      <Download className="w-4 h-4" />
                      <span>Download Sheet</span>
                    </a>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-bold uppercase tracking-wider text-[10px]">
                        <th className="px-4 py-3">AWB</th>
                        <th className="px-4 py-3">Ref No</th>
                        <th className="px-4 py-3">Courier</th>
                        <th className="px-4 py-3">Final Date / Src</th>
                        <th className="px-4 py-3">Country (Courier/FOB)</th>
                        <th className="px-4 py-3">Shipping Bill</th>
                        <th className="px-4 py-3">Charge Type</th>
                        <th className="px-4 py-3 text-right">Duty</th>
                        <th className="px-4 py-3 text-right">Disb. Fee</th>
                        <th className="px-4 py-3 text-right">Tax</th>
                        <th className="px-4 py-3 text-right">Other</th>
                        <th className="px-4 py-3 text-right font-bold text-slate-800">Total Charges</th>
                        <th className="px-4 py-3 text-right bg-violet-50/50">FOB (INR)</th>
                        <th className="px-4 py-3 text-right font-bold text-violet-700 bg-violet-50/50">Duty / FOB %</th>
                        <th className="px-4 py-3 text-right font-bold text-violet-800 bg-violet-50/50">Total / FOB %</th>
                        <th className="px-4 py-3 text-center">FOB Match Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                      {matchedReportRows.length === 0 ? (
                        <tr>
                          <td colSpan={16} className="px-4 py-12 text-center text-slate-400 text-sm">
                            No matching Matched Duty FOB records found.
                          </td>
                        </tr>
                      ) : (
                        paginatedMatchedReport.map((row) => (
                          <tr key={row.id} className="hover:bg-slate-50/50 transition-colors">
                            <td className="px-4 py-3 text-slate-900 font-bold font-mono">{row.awb}</td>
                            <td className="px-4 py-3 font-mono font-bold text-slate-600">{row.orderReference || '-'}</td>
                            <td className="px-4 py-3">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-extrabold border ${
                                row.courier === 'DHL' ? 'bg-yellow-50 text-yellow-800 border-yellow-100' :
                                row.courier === 'UPS' ? 'bg-amber-50 text-amber-800 border-amber-100' :
                                'bg-red-50 text-red-800 border-red-100'
                              }`}>
                                {row.courier}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <span className="font-mono font-bold block">{row.finalDate || 'Blank'}</span>
                              <span className="text-[10px] text-slate-400 font-mono block">{row.dateSource || 'N/A'}</span>
                            </td>
                            <td className="px-4 py-3 uppercase">
                              <div className="font-bold">{row.destinationCountry || 'US'}</div>
                              {row.fobCountry && row.fobCountry !== row.destinationCountry && (
                                <div className="text-[10px] text-rose-500 font-semibold mt-0.5">FOB: {row.fobCountry}</div>
                              )}
                            </td>
                            <td className="px-4 py-3 font-mono text-slate-600">{row.fobShippingBill || '-'}</td>
                            <td className="px-4 py-3 text-[10px] text-slate-500 max-w-[120px] truncate" title={row.chargeType}>{row.chargeType}</td>
                            <td className="px-4 py-3 text-right text-slate-900 font-mono font-bold">{formatINR(row.dutyAmount)}</td>
                            <td className="px-4 py-3 text-right text-slate-500 font-mono">{row.disbursementFee > 0 ? formatINR(row.disbursementFee) : '-'}</td>
                            <td className="px-4 py-3 text-right text-slate-500 font-mono">{row.taxAmount > 0 ? formatINR(row.taxAmount) : '-'}</td>
                            <td className="px-4 py-3 text-right text-slate-500 font-mono">{row.otherCharges > 0 ? formatINR(row.otherCharges) : '-'}</td>
                            <td className="px-4 py-3 text-right text-slate-900 font-mono font-bold text-indigo-600">{formatINR(row.totalCharges)}</td>
                            <td className="px-4 py-3 text-right text-slate-900 font-mono font-bold bg-violet-50/20">{row.fobInr > 0 ? formatINR(row.fobInr) : 'Missing'}</td>
                            <td className="px-4 py-3 text-right text-violet-700 font-mono font-bold bg-violet-50/20">
                              {row.fobInr > 0 ? `${row.dutyFobPct}%` : '-'}
                            </td>
                            <td className="px-4 py-3 text-right text-violet-900 font-mono font-bold bg-violet-50/20">
                              {row.fobInr > 0 ? `${row.totalChargesFobPct}%` : '-'}
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-extrabold border ${
                                row.matchStatus === 'Matched' ? 'bg-emerald-50 text-emerald-800 border-emerald-100' :
                                'bg-rose-50 text-rose-800 border-rose-100'
                              }`}>
                                {row.matchStatus}
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Pagination Controls */}
                {matchedReportRows.length > 0 && (
                  <div className="px-5 py-4 border-t border-slate-200 bg-slate-50 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs font-semibold text-slate-500">
                    <div>
                      Showing <span className="text-slate-800">{(fobPage - 1) * fobPageSize + 1}</span> to{' '}
                      <span className="text-slate-800">
                        {Math.min(fobPage * fobPageSize, matchedReportRows.length)}
                      </span> of{' '}
                      <span className="text-slate-800">{matchedReportRows.length}</span> records
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setFobPage(prev => Math.max(prev - 1, 1))}
                        disabled={fobPage === 1}
                        className="px-3 py-1.5 border border-slate-200 rounded-lg bg-white hover:bg-slate-50 text-slate-700 disabled:opacity-40 disabled:hover:bg-white transition-colors cursor-pointer"
                      >
                        Previous
                      </button>
                      <span className="text-slate-700">
                        Page <span className="font-bold">{fobPage}</span> of <span className="font-bold">{totalMatchedPages}</span>
                      </span>
                      <button
                        onClick={() => setFobPage(prev => Math.min(prev + 1, totalMatchedPages))}
                        disabled={fobPage === totalMatchedPages}
                        className="px-3 py-1.5 border border-slate-200 rounded-lg bg-white hover:bg-slate-50 text-slate-700 disabled:opacity-40 disabled:hover:bg-white transition-colors cursor-pointer"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Sub-tab 3: Unmatched Duty Review */}
            {fobSubTab === 'unmatched' && (
              <div className="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-hidden">
                <div className="p-5 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">Unmatched Duty Review</h2>
                    <p className="text-xs text-slate-500">Shows all courier duties where there is no matching customer FOB report entry found.</p>
                  </div>
                  <div className="flex flex-col sm:flex-row items-center gap-3 w-full md:max-w-xl">
                    <div className="relative flex-1 w-full">
                      <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                      <input 
                        type="text"
                        placeholder="Search unmatched AWBs, courier, country..."
                        value={fobSearch}
                        onChange={e => { setFobSearch(e.target.value); setFobPage(1); }}
                        className="pl-10 pr-4 py-2 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg text-sm w-full outline-none focus:border-violet-400 focus:bg-white font-medium"
                      />
                    </div>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-bold uppercase tracking-wider text-[10px]">
                        <th className="px-4 py-3">AWB</th>
                        <th className="px-4 py-3">Courier</th>
                        <th className="px-4 py-3">Final Date / Src</th>
                        <th className="px-4 py-3">Country</th>
                        <th className="px-4 py-3">Charge Type</th>
                        <th className="px-4 py-3 text-right">Duty</th>
                        <th className="px-4 py-3 text-right">Disb. Fee</th>
                        <th className="px-4 py-3 text-right">Tax</th>
                        <th className="px-4 py-3 text-right">Other</th>
                        <th className="px-4 py-3 text-right font-bold text-slate-800">Total Charges</th>
                        <th className="px-4 py-3 text-center">FOB Match Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                      {unmatchedReportRows.length === 0 ? (
                        <tr>
                          <td colSpan={11} className="px-4 py-12 text-center text-slate-400 text-sm">
                            No unmatched courier duty records found. Excellent matching coverage!
                          </td>
                        </tr>
                      ) : (
                        paginatedUnmatchedReport.map((row) => (
                          <tr key={row.id} className="hover:bg-slate-50/50 transition-colors">
                            <td className="px-4 py-3 text-slate-900 font-bold font-mono">{row.awb}</td>
                            <td className="px-4 py-3">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-extrabold border ${
                                row.courier === 'DHL' ? 'bg-yellow-50 text-yellow-800 border-yellow-100' :
                                row.courier === 'UPS' ? 'bg-amber-50 text-amber-800 border-amber-100' :
                                'bg-red-50 text-red-800 border-red-100'
                              }`}>
                                {row.courier}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <span className="font-mono font-bold block">{row.finalDate || 'Blank'}</span>
                              <span className="text-[10px] text-slate-400 font-mono block">{row.dateSource || 'N/A'}</span>
                            </td>
                            <td className="px-4 py-3 uppercase">{row.destinationCountry || 'US'}</td>
                            <td className="px-4 py-3 text-[10px] text-slate-500 max-w-[120px] truncate" title={row.chargeType}>{row.chargeType}</td>
                            <td className="px-4 py-3 text-right text-slate-900 font-mono font-bold">{formatINR(row.dutyAmount)}</td>
                            <td className="px-4 py-3 text-right text-slate-500 font-mono">{row.disbursementFee > 0 ? formatINR(row.disbursementFee) : '-'}</td>
                            <td className="px-4 py-3 text-right text-slate-500 font-mono">{row.taxAmount > 0 ? formatINR(row.taxAmount) : '-'}</td>
                            <td className="px-4 py-3 text-right text-slate-500 font-mono">{row.otherCharges > 0 ? formatINR(row.otherCharges) : '-'}</td>
                            <td className="px-4 py-3 text-right text-slate-900 font-mono font-bold text-indigo-600">{formatINR(row.totalCharges)}</td>
                            <td className="px-4 py-3 text-center">
                              <span className="px-2 py-0.5 rounded text-[10px] font-extrabold border bg-amber-50 text-amber-800 border-amber-100">
                                Missing FOB
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Pagination Controls */}
                {unmatchedReportRows.length > 0 && (
                  <div className="px-5 py-4 border-t border-slate-200 bg-slate-50 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs font-semibold text-slate-500">
                    <div>
                      Showing <span className="text-slate-800">{(fobPage - 1) * fobPageSize + 1}</span> to{' '}
                      <span className="text-slate-800">
                        {Math.min(fobPage * fobPageSize, unmatchedReportRows.length)}
                      </span> of{' '}
                      <span className="text-slate-800">{unmatchedReportRows.length}</span> records
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setFobPage(prev => Math.max(prev - 1, 1))}
                        disabled={fobPage === 1}
                        className="px-3 py-1.5 border border-slate-200 rounded-lg bg-white hover:bg-slate-50 text-slate-700 disabled:opacity-40 disabled:hover:bg-white transition-colors cursor-pointer"
                      >
                        Previous
                      </button>
                      <span className="text-slate-700">
                        Page <span className="font-bold">{fobPage}</span> of <span className="font-bold">{totalUnmatchedPages}</span>
                      </span>
                      <button
                        onClick={() => setFobPage(prev => Math.min(prev + 1, totalUnmatchedPages))}
                        disabled={fobPage === totalUnmatchedPages}
                        className="px-3 py-1.5 border border-slate-200 rounded-lg bg-white hover:bg-slate-50 text-slate-700 disabled:opacity-40 disabled:hover:bg-white transition-colors cursor-pointer"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Sub-tab 4: Customer File Review */}
            {fobSubTab === 'customer-review' && (
              <div className="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-hidden">
                <div className="p-5 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">Customer File Review</h2>
                    <p className="text-xs text-slate-500">Review all uploaded customer database records with parsed FOB values and shipping bills.</p>
                  </div>
                  <div className="flex flex-col sm:flex-row items-center gap-3 w-full md:max-w-xl">
                    <div className="relative flex-1 w-full">
                      <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                      <input 
                        type="text"
                        placeholder="Search AWB, Invoice, Country, Shipping Bill..."
                        value={fobSearch}
                        onChange={e => { setFobSearch(e.target.value); setCustomerPage(1); }}
                        className="pl-10 pr-4 py-2 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg text-sm w-full outline-none focus:border-violet-400 focus:bg-white font-medium"
                      />
                    </div>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-bold uppercase tracking-wider text-[10px]">
                        <th className="px-4 py-3">AWB No</th>
                        <th className="px-4 py-3">Original AWB</th>
                        <th className="px-4 py-3">Invoice No</th>
                        <th className="px-4 py-3">Shipping Bill</th>
                        <th className="px-4 py-3">Recipient Country</th>
                        <th className="px-4 py-3">Invoice Date</th>
                        <th className="px-4 py-3 text-right bg-violet-50/50">FOB Amount (INR)</th>
                        <th className="px-4 py-3">Uploaded Source File</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                      {filteredCustomerFobRows.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="px-4 py-12 text-center text-slate-400 text-sm">
                            No customer FOB records found.
                          </td>
                        </tr>
                      ) : (
                        paginatedCustomerReport.map((row) => (
                          <tr key={row.awb} className="hover:bg-slate-50/50 transition-colors">
                            <td className="px-4 py-3 text-slate-900 font-bold font-mono">{row.awb}</td>
                            <td className="px-4 py-3 text-slate-500 font-mono">{row.original_awb}</td>
                            <td className="px-4 py-3 font-mono font-bold text-slate-800">{row.invoice_number || '-'}</td>
                            <td className="px-4 py-3 font-mono text-indigo-600 font-semibold">{row.shipping_bill || '-'}</td>
                            <td className="px-4 py-3 uppercase">{row.country || 'US'}</td>
                            <td className="px-4 py-3 font-mono text-slate-500">{row.invoice_date || '-'}</td>
                            <td className="px-4 py-3 text-right text-slate-900 font-mono font-bold bg-violet-50/10">{formatINR(row.fob_inr || 0)}</td>
                            <td className="px-4 py-3 text-slate-500 text-[10px] max-w-[150px] truncate" title={row.source_file}>{row.source_file}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Pagination Controls */}
                {filteredCustomerFobRows.length > 0 && (
                  <div className="px-5 py-4 border-t border-slate-200 bg-slate-50 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs font-semibold text-slate-500">
                    <div>
                      Showing <span className="text-slate-800">{(customerPage - 1) * fobPageSize + 1}</span> to{' '}
                      <span className="text-slate-800">
                        {Math.min(customerPage * fobPageSize, filteredCustomerFobRows.length)}
                      </span> of{' '}
                      <span className="text-slate-800">{filteredCustomerFobRows.length}</span> records
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setCustomerPage(prev => Math.max(prev - 1, 1))}
                        disabled={customerPage === 1}
                        className="px-3 py-1.5 border border-slate-200 rounded-lg bg-white hover:bg-slate-50 text-slate-700 disabled:opacity-40 disabled:hover:bg-white transition-colors cursor-pointer"
                      >
                        Previous
                      </button>
                      <span className="text-slate-700">
                        Page <span className="font-bold">{customerPage}</span> of <span className="font-bold">{totalCustomerPages}</span>
                      </span>
                      <button
                        onClick={() => setCustomerPage(prev => Math.min(prev + 1, totalCustomerPages))}
                        disabled={customerPage === totalCustomerPages}
                        className="px-3 py-1.5 border border-slate-200 rounded-lg bg-white hover:bg-slate-50 text-slate-700 disabled:opacity-40 disabled:hover:bg-white transition-colors cursor-pointer"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'datewise' && (
          <div className="space-y-6">
            {stats.shiptax === 0 && (
              <div className="bg-amber-50 border border-amber-200 text-amber-800 px-5 py-4 rounded-xl flex items-start space-x-3 text-xs sm:text-sm font-semibold">
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <span>
                  ShipTax not uploaded. Datewise summary is created from courier ship date. Upload ShipTax only for matching and duplicate order validation.
                </span>
              </div>
            )}

            {datewise.some(row => row.ship_date === 'Missing Date') && (
              <div className="bg-rose-50 border border-rose-200 text-rose-800 px-5 py-4 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs sm:text-sm font-semibold">
                <div className="flex items-start space-x-3">
                  <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
                  <div>
                    <span className="block font-bold">AWBs with Missing Dates Detected</span>
                    <span className="text-slate-500 font-medium">These shipments do not have a valid courier ship date or matching ShipTax record. They have been placed in Needs Review.</span>
                  </div>
                </div>
                <div className="sm:text-right shrink-0">
                  <span className="block text-xs uppercase tracking-wider text-slate-400 font-bold">Missing Date Duty Total</span>
                  <span className="text-lg font-mono font-extrabold text-rose-700">
                    {formatINR(datewise.filter(row => row.ship_date === 'Missing Date').reduce((sum, r) => sum + (r.duty_amount || 0), 0))}
                  </span>
                </div>
              </div>
            )}

            <div className="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-hidden">
              <div className="p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">Datewise Duty Summary</h2>
                  <p className="text-xs text-slate-500">Displays final validated duties with reliable date signatures only.</p>
                </div>
                <div className="relative max-w-sm">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
                  <input 
                    type="text"
                    placeholder="Search date or courier..."
                    value={dateSearch}
                    onChange={e => setDateSearch(e.target.value)}
                    className="pl-10 pr-4 py-2 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg text-sm w-full outline-none focus:border-blue-400 focus:bg-white font-medium"
                  />
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-bold text-xs uppercase tracking-wider">
                      <th className="px-6 py-4">Ship Date</th>
                      <th className="px-6 py-4">Courier</th>
                      <th className="px-6 py-4 text-center">Shipment Count</th>
                      <th className="px-6 py-4 text-right">Duty Amount</th>
                      <th className="px-6 py-4">Trackings / AWBs</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                    {filteredDatewise.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-6 py-12 text-center text-slate-400">
                          No dated duties found. Process some ShipTax and Courier billing files first.
                        </td>
                      </tr>
                    ) : (
                      filteredDatewise.map((row, index) => (
                        <tr key={index} className="hover:bg-slate-50/50 transition-colors">
                          <td className="px-6 py-4 text-slate-900 font-bold font-mono">{row.ship_date}</td>
                          <td className="px-6 py-4">
                            <span className={`px-2.5 py-1 rounded-md text-xs font-bold inline-block border ${
                              row.courier === 'DHL' ? 'bg-yellow-50 text-yellow-800 border-yellow-100' :
                              row.courier === 'UPS' ? 'bg-amber-50 text-amber-800 border-amber-100' :
                              'bg-red-50 text-red-800 border-red-100'
                            }`}>
                              {row.courier}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-center text-slate-900 font-bold font-mono">{row.shipment_count}</td>
                          <td className="px-6 py-4 text-right text-slate-900 font-bold font-mono text-emerald-600">{formatINR(row.duty_amount)}</td>
                          <td className="px-6 py-4 text-xs font-mono max-w-sm truncate text-slate-500" title={row.awbs}>{row.awbs}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'double' && (
          <div className="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-hidden">
            <div className="p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Double Billing Alerts</h2>
                <p className="text-xs text-slate-500">AWBs charged multiple times by couriers across months. Shown in red.</p>
              </div>
              <div className="relative max-w-sm">
                <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
                <input 
                  type="text"
                  placeholder="Search duplicates..."
                  value={doubleSearch}
                  onChange={e => setDoubleSearch(e.target.value)}
                  className="pl-10 pr-4 py-2 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg text-sm w-full outline-none focus:border-blue-400 focus:bg-white font-medium"
                />
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-bold text-xs uppercase tracking-wider">
                    <th className="px-6 py-4">AWB</th>
                    <th className="px-6 py-4">Courier</th>
                    <th className="px-6 py-4">Ship Date</th>
                    <th className="px-6 py-4 text-right">Duty Amount</th>
                    <th className="px-6 py-4">Matched Error Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                  {filteredDouble.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-12 text-center text-slate-400">
                        Excellent! No double billings found in uploaded courier files.
                      </td>
                    </tr>
                  ) : (
                    filteredDouble.map((row) => (
                      <tr key={row.id} className="hover:bg-red-50/20 bg-red-50/10 transition-colors border-l-4 border-l-red-500">
                        <td className="px-6 py-4 text-slate-900 font-bold font-mono">{row.awb}</td>
                        <td className="px-6 py-4">
                          <span className="px-2.5 py-1 rounded-md text-xs font-bold bg-red-100 text-red-800 border border-red-200">
                            {row.courier}
                          </span>
                        </td>
                        <td className="px-6 py-4 font-mono">{row.ship_date || 'N/A'}</td>
                        <td className="px-6 py-4 text-right text-red-700 font-bold font-mono">{formatINR(row.duty_amount)}</td>
                        <td className="px-6 py-4 text-xs font-semibold text-red-700">{row.message}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'review' && (
          <div className="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-hidden">
            <div className="p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Needs Review / Parsing Warnings</h2>
                <p className="text-xs text-slate-500">Logs for records with incomplete tracking columns, missing dates, or unknown details.</p>
              </div>
              <div className="relative max-w-sm">
                <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
                <input 
                  type="text"
                  placeholder="Search reviews..."
                  value={reviewSearch}
                  onChange={e => setReviewSearch(e.target.value)}
                  className="pl-10 pr-4 py-2 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg text-sm w-full outline-none focus:border-blue-400 focus:bg-white font-medium"
                />
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-bold text-xs uppercase tracking-wider">
                    <th className="px-6 py-4">Reason / Problem</th>
                    <th className="px-6 py-4">Courier</th>
                    <th className="px-6 py-4">AWB</th>
                    <th className="px-6 py-4">Source File / Position</th>
                    <th className="px-6 py-4">Audit Suggestion</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                  {filteredReview.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-12 text-center text-slate-400">
                        All files parsed seamlessly with zero warnings!
                      </td>
                    </tr>
                  ) : (
                    filteredReview.map((row) => (
                      <tr key={row.id} className="hover:bg-amber-50/20 bg-amber-50/5 transition-colors border-l-4 border-l-amber-500">
                        <td className="px-6 py-4 font-bold text-amber-800">{row.reason}</td>
                        <td className="px-6 py-4">
                          <span className="px-2 py-0.5 rounded-md text-xs font-bold bg-amber-100 text-amber-800">
                            {row.courier}
                          </span>
                        </td>
                        <td className="px-6 py-4 font-mono font-semibold">{row.awb || 'Blank'}</td>
                        <td className="px-6 py-4 text-xs font-mono max-w-xs truncate" title={`${row.source_file} (Sheet: ${row.source_sheet || 'N/A'}, Row: ${row.source_row})`}>
                          {row.source_file} (Row: {row.source_row})
                        </td>
                        <td className="px-6 py-4 text-xs text-slate-600 font-medium">{row.message}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'memory' && (
          <div className="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-hidden">
            <div className="p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900">ShipTax Permanent Memory Ledger</h2>
                <p className="text-xs text-slate-500">Query ShipTax memory entries by their exact Airway Bill (AWB) number.</p>
              </div>
              <form onSubmit={(e) => {
                e.preventDefault();
                fetchMemory(memorySearch);
              }} className="flex items-center gap-2 max-w-md w-full">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
                  <input 
                    type="text"
                    placeholder="Enter exact AWB to lookup..."
                    value={memorySearch}
                    onChange={e => setMemorySearch(e.target.value)}
                    className="pl-10 pr-4 py-2.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg text-sm w-full outline-none focus:border-blue-400 focus:bg-white font-medium"
                  />
                </div>
                <button 
                  type="submit"
                  className="px-4 py-2.5 bg-slate-700 hover:bg-slate-800 text-white rounded-lg text-sm font-semibold transition-colors cursor-pointer shrink-0"
                >
                  Lookup AWB
                </button>
              </form>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-bold text-xs uppercase tracking-wider">
                    <th className="px-6 py-4">Normalized AWB</th>
                    <th className="px-6 py-4">Original Heading</th>
                    <th className="px-6 py-4">Ship Date</th>
                    <th className="px-6 py-4">Courier Name</th>
                    <th className="px-6 py-4">Country</th>
                    <th className="px-6 py-4">Order Ref</th>
                    <th className="px-6 py-4">Source File</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                  {filteredMemory.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-6 py-12 text-center text-slate-400">
                        No ShipTax records in ledger. Upload ShipTax sheets to create historical memory.
                      </td>
                    </tr>
                  ) : (
                    filteredMemory.map((row, index) => (
                      <tr key={index} className="hover:bg-slate-50/50 transition-colors">
                        <td className="px-6 py-4 text-slate-900 font-bold font-mono">{row.awb}</td>
                        <td className="px-6 py-4 text-xs font-mono text-slate-400">{row.original_awb}</td>
                        <td className="px-6 py-4 font-mono font-bold text-slate-700">{row.ship_date || 'N/A'}</td>
                        <td className="px-6 py-4">{row.courier}</td>
                        <td className="px-6 py-4 text-xs font-semibold">{row.country}</td>
                        <td className="px-6 py-4 text-xs font-mono text-slate-500">{row.order_reference}</td>
                        <td className="px-6 py-4 text-xs font-mono text-slate-400 max-w-xs truncate" title={row.source_file}>{row.source_file}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'export' && (
          <section className="grid grid-cols-1 md:grid-cols-2 gap-8">
            
            {/* Box 1: Excel Exporter */}
            <article className="bg-white border border-slate-200 rounded-2xl shadow-xs p-6">
              <div className="flex items-center space-x-2.5 mb-4">
                <div className="p-2.5 bg-emerald-50 text-emerald-600 rounded-lg">
                  <Download className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-slate-900">Download Excel Audit Reports</h2>
                  <p className="text-xs text-slate-500">Generate structured workbook sheets for Datewise Summary, Double Billings, ledger histories, and FOB ratios.</p>
                </div>
              </div>

              <p className="text-sm text-slate-600 mb-6 leading-relaxed">
                Generates professionally formatted Microsoft Excel spreadsheets containing complete, color-coded records (including <strong>Datewise Summary</strong>, <strong>Double Billing</strong>, and <strong>Customer FOB & Percentages</strong>) perfectly structured for reporting.
              </p>

              <div className="space-y-3">
                <a 
                  href="/api/export.xlsx" 
                  download
                  className="w-full py-3.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold text-sm tracking-wide transition-all shadow-xs flex items-center justify-center space-x-2 active:scale-98 cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  <span>Export Multi-Sheet Excel Workbook</span>
                </a>

                <a 
                  href="/api/export-fob.xlsx" 
                  download
                  className="w-full py-3 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-xl font-bold text-sm tracking-wide transition-all shadow-xs flex items-center justify-center space-x-2 active:scale-98 cursor-pointer"
                >
                  <Download className="w-4 h-4 text-emerald-600" />
                  <span>Download Duty/FOB Percentage Sheet Only</span>
                </a>
              </div>
            </article>

            {/* Box 2: JSON Backup & Safety */}
            <article className="bg-white border border-slate-200 rounded-2xl shadow-xs p-6 flex flex-col justify-between">
              <div>
                <div className="flex items-center space-x-2.5 mb-4">
                  <div className="p-2.5 bg-indigo-50 text-indigo-600 rounded-lg">
                    <Database className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">Database Backup & Safety</h2>
                    <p className="text-xs text-slate-500">Download offline backups or clear standard ledger memories safely.</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mb-4">
                  <a 
                    href="/api/backup.json" 
                    download
                    className="py-3 bg-slate-100 hover:bg-slate-200 border border-slate-200 text-slate-800 rounded-lg text-xs font-bold text-center tracking-wide transition-all flex items-center justify-center space-x-1.5 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download Backup JSON</span>
                  </a>

                  <button 
                    onClick={() => backupInputRef.current?.click()}
                    className="py-3 bg-slate-100 hover:bg-slate-200 border border-slate-200 text-slate-800 rounded-lg text-xs font-bold text-center tracking-wide transition-all flex items-center justify-center space-x-1.5 cursor-pointer"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>Upload Backup JSON</span>
                  </button>
                </div>

                <input 
                  type="file"
                  ref={backupInputRef}
                  accept=".json"
                  onChange={handleRestoreBackup}
                  className="hidden"
                />

                {generalStatus.message && (
                  <div className={`p-3 rounded-lg border text-xs flex items-start space-x-2 ${
                    generalStatus.type === 'error' ? 'bg-red-50 text-red-700 border-red-100' :
                    generalStatus.type === 'success' ? 'bg-emerald-50 text-emerald-700 border-emerald-100' :
                    'bg-blue-50 text-blue-700 border-blue-100'
                  }`}>
                    <Info className="w-4 h-4 shrink-0" />
                    <span>{generalStatus.message}</span>
                  </div>
                )}
              </div>

              <div>
                <div className="h-px bg-slate-200 my-4" />
                <button 
                  onClick={handleClearDatabase}
                  className="w-full py-3 bg-red-50 hover:bg-red-100 border border-red-200 text-red-700 rounded-xl font-bold text-sm tracking-wide transition-all flex items-center justify-center space-x-1.5 active:scale-98 cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>Purge Stored Database Records</span>
                </button>
              </div>
            </article>

          </section>
        )}

        {activeTab === 'comparator' && (
          <RateComparator />
        )}

        {activeTab === 'rate-admin' && (
          <RateAdmin />
        )}

      </main>

      {/* Footer */}
      <footer className="bg-slate-900 text-slate-500 py-8 mt-12 border-t border-slate-800 text-center text-xs">
        <p className="font-semibold text-slate-400">Harry Fashion Courier Duty Auditor & Double Billing Inspector</p>
        <p className="mt-1">Manager Interface • Pure Client-Server SQL Persistence Layer • Optimized for Cloud Run and SQLite</p>
      </footer>

      {/* Typed Confirmation Modal for Safe Purge */}
      {showClearConfirm && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-6 shadow-xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center space-x-3 text-red-600 mb-4">
              <AlertTriangle className="w-6 h-6 shrink-0" />
              <h3 className="text-lg font-bold text-slate-900">Purge Database Records?</h3>
            </div>
            <p className="text-sm text-slate-500 mb-4">
              This action is <strong className="text-red-600">irreversible</strong>. It will completely delete all stored ShipTax memory, Courier charges, duplicate billing alerts, review logs, and upload files from both local cache and Firestore.
            </p>
            <p className="text-xs text-slate-400 font-medium mb-3">
              Type <span className="font-extrabold text-slate-700">CLEAR</span> in all caps to authorize:
            </p>
            <input 
              type="text" 
              placeholder="Type CLEAR here" 
              value={clearTypedWord}
              onChange={e => setClearTypedWord(e.target.value.toUpperCase())}
              className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-sm font-extrabold tracking-widest text-center text-slate-800 focus:bg-white focus:border-red-400 transition-colors outline-none uppercase"
            />
            <div className="mt-6 flex space-x-3 justify-end">
              <button 
                onClick={() => { setShowClearConfirm(false); setClearTypedWord(''); }}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-bold transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button 
                onClick={executeClearDatabase}
                disabled={clearTypedWord.trim().toUpperCase() !== 'CLEAR'}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center space-x-1.5 cursor-pointer ${
                  clearTypedWord.trim().toUpperCase() === 'CLEAR'
                    ? 'bg-red-600 text-white hover:bg-red-700 shadow-sm active:scale-98'
                    : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                }`}
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Confirm Purge</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
