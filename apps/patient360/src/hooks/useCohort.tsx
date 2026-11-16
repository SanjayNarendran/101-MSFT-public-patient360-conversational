import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { fetchPatient, searchPatients, type PatientBundle, type PatientListRow, type SearchRequest, type SearchResult } from '@/lib/api';

/** Signed URLs last 55 minutes; refetch well before. */
const MAX_AGE_MS = 30 * 60_000;
const PAGE = 10;
/** The first demo patients shown; Show more brings the rest, ten at a time. */
const DEMO_FIRST = 7;
const SEARCH_KEY = 'p360.search';
/** The first page of demo patients from the last visit, shown while the live list is read (the SQL endpoint can start cold). */
const LIST_CACHE_KEY = 'p360.demoList.v1';

const isDemoOnly = (s: SearchRequest) => !!s.demo && Object.entries(s).every(([k, v]) => k === 'demo' || v === undefined);

function cachedDemoList(): SearchResult | null {
  try {
    const r = JSON.parse(localStorage.getItem(LIST_CACHE_KEY) ?? 'null') as SearchResult | null;
    return r && Array.isArray(r.patients) && r.patients.length ? r : null;
  } catch {
    return null;
  }
}

/** The demo patients until the reader searches. */
export const DEMO_SEARCH: SearchRequest = { demo: true };

interface PatientsState {
  /** The current search and the patients it found so far (ten at a time). */
  search: SearchRequest;
  setSearch: (s: SearchRequest) => void;
  patients: PatientListRow[];
  total: number;
  result: SearchResult | null;
  loading: boolean;
  /** The rows shown are the last visit's demo list; the live one is still being read (or could not be). */
  fromCache: boolean;
  error: string | null;
  more: () => void;
  /** Patient bundles already read this session, keyed by id. */
  getPatient: (id: string) => Promise<PatientBundle>;
  peekPatient: (id: string) => PatientBundle | null;
}

const Ctx = createContext<PatientsState | undefined>(undefined);

type Entry = { at: number; promise: Promise<PatientBundle>; value: PatientBundle | null };

function savedSearch(): SearchRequest {
  // A link to a data request's patients (from the approval app): /?request=<QUERY_MASTER_ID>
  const request = Number(new URLSearchParams(window.location.search).get('request'));
  if (Number.isInteger(request) && request > 0) return { request };
  try {
    const s = JSON.parse(sessionStorage.getItem(SEARCH_KEY) ?? 'null') as SearchRequest | null;
    return s ?? DEMO_SEARCH;
  } catch {
    return DEMO_SEARCH;
  }
}

export function CohortProvider({ children }: { children: ReactNode }) {
  const [search, setSearchState] = useState<SearchRequest>(savedSearch);
  const [patients, setPatients] = useState<PatientListRow[]>([]);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [fromCache, setFromCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef(new Map<string, Entry>());
  const seq = useRef(0);

  const run = useCallback(async (s: SearchRequest, offset: number) => {
    const n = ++seq.current;
    setLoading(true);
    const first = offset === 0 && isDemoOnly(s);
    const cached = first ? cachedDemoList() : null;
    if (cached) {
      setResult(cached);
      setPatients(cached.patients);
    }
    if (offset === 0) setFromCache(!!cached);
    try {
      // The first page of demo patients is short so the page opens quickly; then ten at a time like any search.
      const r = await searchPatients({ ...s, offset, limit: s.demo && offset === 0 ? DEMO_FIRST : PAGE });
      if (n !== seq.current) return;
      setResult(r);
      setPatients((prev) => (offset === 0 ? r.patients : [...prev, ...r.patients]));
      if (offset === 0) setFromCache(false);
      setError(null);
      if (first) {
        try {
          localStorage.setItem(LIST_CACHE_KEY, JSON.stringify(r));
        } catch {
          /* storage full or off: the next visit reads live */
        }
      }
    } catch (err) {
      if (n !== seq.current) return;
      console.error('Search failed', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    sessionStorage.setItem(SEARCH_KEY, JSON.stringify(search));
    void run(search, 0);
  }, [search, run]);

  const setSearch = useCallback((s: SearchRequest) => setSearchState(s), []);
  const more = useCallback(() => void run(search, patients.length), [run, search, patients.length]);

  const getPatient = useCallback((id: string) => {
    const hit = cache.current.get(id);
    if (hit && Date.now() - hit.at < MAX_AGE_MS) return hit.promise;
    const entry: Entry = { at: Date.now(), promise: fetchPatient(id), value: null };
    entry.promise.then(
      (v) => (entry.value = v),
      () => cache.current.delete(id)
    );
    cache.current.set(id, entry);
    return entry.promise;
  }, []);

  const peekPatient = useCallback((id: string) => {
    const hit = cache.current.get(id);
    return hit && Date.now() - hit.at < MAX_AGE_MS ? hit.value : null;
  }, []);

  return (
    <Ctx.Provider
      value={{ search, setSearch, patients, total: result?.total ?? 0, result, loading, fromCache, error, more, getPatient, peekPatient }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useCohort(): PatientsState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useCohort must be used within CohortProvider');
  return ctx;
}

/** Loads one patient; keeps showing the previous patient until the next one arrives. */
export function usePatient(id: string | null) {
  const { getPatient, peekPatient } = useCohort();
  const [bundle, setBundle] = useState<PatientBundle | null>(() => (id ? peekPatient(id) : null));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMs, setLoadMs] = useState<number | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const cached = peekPatient(id);
    if (cached) {
      setBundle(cached);
      setLoadMs(null);
      setError(null);
      return;
    }
    setLoading(true);
    const t0 = performance.now();
    getPatient(id)
      .then((b) => {
        if (cancelled) return;
        setBundle(b);
        setError(null);
        setLoadMs(Math.round(performance.now() - t0));
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id, getPatient, peekPatient]);

  return { bundle: bundle && bundle.patient.patient_id === id ? bundle : null, stale: bundle, loading, error, loadMs };
}
