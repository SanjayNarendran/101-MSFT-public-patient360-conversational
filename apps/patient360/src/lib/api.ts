import type {
  Cell as RecordCell,
  DocumentText,
  FileAccess as RecordFileAccess,
  Genome,
  PatientBundle as RecordBundle,
  Provenance as RecordProvenance,
  Row as RecordRow,
  SearchRequest,
  SearchResult,
  SourceId,
} from '../../rayfin/functions/src/record';
import { LOCAL_DATA, localApi } from '@/lib/localMode';
import { getRayfinClient } from '@/services/rayfin/RayfinClientService';

export type { DocumentText, Genome, SearchRequest, SearchResult, SourceId };
export { SOURCE_INFO, withGenome } from '../../rayfin/functions/src/record';
export type PatientBundle = RecordBundle;
export type Provenance = RecordProvenance;
export type FileAccess = RecordFileAccess;
export type Row = RecordRow;
export type Cell = RecordCell;
export type PatientListRow = SearchResult['patients'][number];
/** The oncology research silos (the imported TCGA patients). */
export type Silo = 'clinical' | 'genomics' | 'imaging';

export type DataMap = {
  workspace: { id: string; name: string; portalUrl: string };
  sources: { source: SourceId; name: string; portalUrl: string; tables: { name: string; rows: number; bytes: number }[]; files: { name: string; files: number; bytes: number }[] }[];
  provenance: Provenance;
};

// The Rayfin client is typed from the generated function schema, which follows function_app.ts; the shapes are
// the ones in record.ts, so calls go through this untyped view of it.
type Invoke = (input?: unknown, opts?: { timeoutMs?: number }) => Promise<unknown>;
const fn = (name: string): Invoke => {
  const functions = getRayfinClient().functions as unknown as Record<string, { invoke: Invoke }>;
  return (input, opts) => functions[name].invoke(input, opts);
};
/** The Rayfin client returns a function's JSON text already parsed; accept either. */
const parsed = <T,>(v: unknown): T => (typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));

export async function searchPatients(req: SearchRequest): Promise<SearchResult> {
  if (LOCAL_DATA) return localApi('searchPatients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
  return parsed(await fn('searchPatients')({ request: JSON.stringify(req) }, { timeoutMs: 90_000 }));
}

export async function fetchPatient(patientId: string): Promise<PatientBundle> {
  if (LOCAL_DATA) return localApi(`getPatient?patientId=${encodeURIComponent(patientId)}`);
  return parsed(await fn('getPatient')({ patientId }, { timeoutMs: 90_000 }));
}

export async function fetchDocument(documentId: string): Promise<DocumentText> {
  if (LOCAL_DATA) return localApi(`getDocument?documentId=${encodeURIComponent(documentId)}`);
  return parsed(await fn('getDocument')({ documentId }, { timeoutMs: 60_000 }));
}

export async function fetchSeriesFiles(seriesUid: string, patientId: string): Promise<{ files: Row[]; access: FileAccess }> {
  if (LOCAL_DATA) return localApi(`getSeriesFiles?seriesUid=${encodeURIComponent(seriesUid)}&patientId=${encodeURIComponent(patientId)}`);
  return parsed(await fn('getSeriesFiles')({ seriesUid, patientId }, { timeoutMs: 60_000 }));
}

export async function fetchDataMap(): Promise<DataMap> {
  if (LOCAL_DATA) return localApi('getDataMap');
  return parsed(await fn('getDataMap')(undefined, { timeoutMs: 90_000 }));
}

export type RequestList = { requests: Row[]; approvalUrl: string };
let requestList: Promise<RequestList> | null = null;

/** The approved and delivered data requests (for the patient list's filter, the Cohorts tab and Ask), once a session. */
export function fetchRequests(): Promise<RequestList> {
  requestList ??= (LOCAL_DATA ? localApi<RequestList>('listRequests') : fn('listRequests')(undefined, { timeoutMs: 60_000 }).then((v) => parsed<RequestList>(v))).catch(
    (e) => {
      requestList = null;
      throw e;
    }
  );
  return requestList;
}

/** URL of a file in an item's Files area, signed with the read-only SAS from the function (unsigned in local mode). */
export function fileUrl(access: FileAccess, path: string): string {
  const p = path.replace(/^Files\//, '');
  return access.query ? `${access.baseUrl}/${p}?${access.query}` : `${access.baseUrl}/${p}`;
}

export function str(v: Cell | undefined): string | null {
  return v === null || v === undefined || v === '' ? null : String(v);
}

export function num(v: Cell | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseJson<T>(v: Cell | undefined, fallback: T): T {
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export type QuerySpec = import('../../rayfin/functions/src/record').QuerySpec;
export type QueryResult = { rows: Row[]; sql: string; ms: number } | { error: string };

/** Ask's query_records: a structured query compiled to SQL by the data layer (record.ts querySql). */
export async function queryRecords(spec: QuerySpec): Promise<QueryResult> {
  if (LOCAL_DATA) return localApi('queryRecords', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) });
  return parsed(await fn('queryRecords')({ spec: JSON.stringify(spec) }, { timeoutMs: 90_000 }));
}
