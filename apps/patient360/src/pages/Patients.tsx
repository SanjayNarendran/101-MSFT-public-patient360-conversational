import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { ListColumn } from '@/components/Panel';
import { DEMO_SEARCH, useCohort } from '@/hooks/useCohort';
import { fetchRequests, type PatientListRow, type Row, type SearchRequest } from '@/lib/api';
import { fmtInt, fmtMonth, fmtMs, fmtNum, fmtSpan, shortStage } from '@/lib/format';
import { LOCAL_DATA } from '@/lib/localMode';
import { PatientView } from '@/pages/PatientView';

/** What can be asked for: kinds of data online for the patient. */
const HAS: { id: string; label: string }[] = [
  { id: 'ct', label: 'Chest CT' },
  { id: 'nodules', label: 'Outlined nodules' },
  { id: 'mri', label: 'Brain MRI' },
  { id: 'xray', label: 'X-ray' },
  { id: 'slide', label: 'Pathology slide' },
  { id: 'scanned', label: 'Scanned document' },
];
const CANCERS = ['breast', 'lung', 'colon', 'prostate'];

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
const s = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));

function initials(name: string) {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('');
}

/** What the patient has online, as a short line. */
function online(p: PatientListRow): string {
  const parts = [
    n(p.ct_online) ? `CT${n(p.nodules) ? ` (${n(p.nodules)} ${n(p.nodules) === 1 ? 'nodule' : 'nodules'})` : ''}` : '',
    n(p.mr_online) ? 'MRI' : '',
    n(p.xray_online) ? 'X-ray' : '',
    n(p.slides_online) ? (n(p.slides_online) > 1 ? `${n(p.slides_online)} slides` : 'slide') : '',
    n(p.scanned_documents) ? `${n(p.scanned_documents)} scanned` : '',
    ...(s(p.showcase)?.split('; ') ?? []),
  ].filter(Boolean);
  return parts.join(' · ') || 'no images online';
}

/** "Died after 12 months" from the first cancer; patients without one, by their date of death. */
function outcome(p: PatientListRow): string {
  const dead = s(p.vital_status) === 'Dead' || !!s(p.death_date);
  const days = p.days_from_diagnosis === null || p.days_from_diagnosis === undefined ? null : n(p.days_from_diagnosis);
  if (days !== null) return dead ? `Died after ${fmtSpan(days)}` : `Alive at ${fmtSpan(days)}`;
  return dead ? `Died ${fmtMonth(s(p.death_date))}` : 'Living';
}

const count = (v: unknown, one: string, many = `${one}s`) => `${fmtInt(n(v))} ${n(v) === 1 ? one : many}`;

const maxTmb = (rows: PatientListRow[]) => Math.max(1, ...rows.map((p) => n(p.tmb)));

/** The demo patients in one line, as the reference app summed up its cohort. */
function summary(rows: PatientListRow[], total: number): string {
  const cancers = new Set(rows.flatMap((p) => s(p.cancer_type)?.split('; ') ?? []));
  const died = rows.filter((p) => s(p.vital_status) === 'Dead' || s(p.death_date)).length;
  const gp = rows.reduce((t, p) => t + n(p.slide_gigapixels), 0);
  const scans = rows.reduce((t, p) => t + n(p.scan_series), 0);
  return `${rows.length < total ? `${rows.length} of ${total}` : rows.length} demo patients · ${cancers.size} cancer types · ${died} died · ${fmtNum(gp, 0)} gigapixels of pathology · ${fmtInt(scans)} CT and MRI series`;
}

function PatientRow({ p, current, onHover, query }: { p: PatientListRow; current: boolean; onHover: () => void; query: string }) {
  return (
    <Link to={`/p/${p.patient_id}${query}`} className="pt-row" aria-current={current} onMouseEnter={onHover}>
      <span className="min-w-0">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[13.5px] font-medium">{s(p.display_name)}</span>
          <span className="t-faint shrink-0 text-[11px]">
            {s(p.sex)?.[0]} {n(p.age)}
          </span>
        </span>
        <span className="t-muted block truncate text-[12.5px]">{s(p.demo_title) ?? s(p.cancers)?.split(';')[0] ?? 'No cancer recorded'}</span>
        <span className="t-faint block truncate text-[11.5px]">{online(p)}</span>
      </span>
    </Link>
  );
}

function SearchBar({ search, onSearch }: { search: SearchRequest; onSearch: (s: SearchRequest) => void }) {
  const [text, setText] = useState(search.q ?? '');
  const [requests, setRequests] = useState<Row[]>([]);
  useEffect(() => {
    fetchRequests()
      .then((r) => setRequests(r.requests))
      .catch(() => setRequests([]));
  }, []);
  useEffect(() => setText(search.q ?? ''), [search.q]);
  const toggleHas = (id: string) => {
    const has = new Set(search.has ?? []);
    if (has.has(id)) has.delete(id);
    else has.add(id);
    onSearch({ ...search, demo: false, has: [...has] });
  };
  const isDemo = !!search.demo;
  return (
    <div className="mt-8">
      <form
        className="search-row"
        onSubmit={(e) => {
          e.preventDefault();
          onSearch({ ...search, demo: false, q: text.trim() || undefined });
        }}
      >
        <input
          className="field"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Name, MRN, patient ID or condition"
          aria-label="Search patients"
        />
        <button className="btn" type="submit">
          Search
        </button>
        <div className="seg" role="group" aria-label="Which patients">
          <button type="button" aria-pressed={isDemo} onClick={() => onSearch(DEMO_SEARCH)}>
            Demo patients
          </button>
          <button type="button" aria-pressed={!isDemo} onClick={() => onSearch({ ...search, demo: false })}>
            All patients
          </button>
        </div>
      </form>
      <div className="filter-row mt-3 text-[12.5px]">
        <span className="t-label">Has online</span>
        {HAS.map((h) => (
          <label key={h.id} className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={(search.has ?? []).includes(h.id)} onChange={() => toggleHas(h.id)} />
            {h.label}
          </label>
        ))}
      </div>
      <div className="filter-row mt-2 text-[12.5px]">
        <span className="t-label">Cancer</span>
        <select className="field" value={search.cancer ?? ''} onChange={(e) => onSearch({ ...search, demo: false, cancer: e.target.value || undefined })}>
          <option value="">any or none</option>
          {CANCERS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <span className="t-label">Sex</span>
        <select className="field" value={search.sex ?? ''} onChange={(e) => onSearch({ ...search, demo: false, sex: e.target.value || undefined })}>
          <option value="">any</option>
          <option value="Female">female</option>
          <option value="Male">male</option>
        </select>
        <span className="t-label">Age</span>
        <select
          className="field"
          value={search.ageMin !== undefined ? `${search.ageMin}-${search.ageMax ?? ''}` : ''}
          onChange={(e) => {
            const [a, z] = e.target.value.split('-');
            onSearch({ ...search, demo: false, ageMin: a ? Number(a) : undefined, ageMax: z ? Number(z) : undefined });
          }}
        >
          <option value="">any</option>
          <option value="0-17">under 18</option>
          <option value="18-49">18 to 49</option>
          <option value="50-64">50 to 64</option>
          <option value="65-79">65 to 79</option>
          <option value="80-">80 and over</option>
        </select>
        <span className="t-label">Status</span>
        <select className="field" value={search.vital ?? ''} onChange={(e) => onSearch({ ...search, demo: false, vital: (e.target.value || undefined) as SearchRequest['vital'] })}>
          <option value="">living or deceased</option>
          <option value="living">living</option>
          <option value="deceased">deceased</option>
        </select>
        {(requests.length > 0 || search.request) && (
          <>
            <span className="t-label">Data request</span>
            <select
              className="field max-w-[280px]"
              value={search.request ?? ''}
              title="The cohort of an approved or delivered request from Cohort Discovery"
              onChange={(e) => onSearch({ ...search, demo: false, request: e.target.value ? Number(e.target.value) : undefined })}
            >
              <option value="">any</option>
              {requests.map((r) => (
                <option key={String(r.query_master_id)} value={String(r.query_master_id)}>
                  {String(r.title ?? `Request ${r.query_master_id}`)} ({String(r.query_master_id)}, {String(r.patients)} patients)
                </option>
              ))}
              {search.request && !requests.some((r) => Number(r.query_master_id) === search.request) && (
                <option value={search.request}>Request {search.request}</option>
              )}
            </select>
          </>
        )}
        {!isDemo && (
          <button className="link t-muted" onClick={() => onSearch({})}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function PatientsOverview() {
  const { search, setSearch, patients, total, result, loading, fromCache, error, more } = useCohort();
  const [showSql, setShowSql] = useState(false);
  const q = result?.provenance.queries.find((x) => x.id === 'patients');
  return (
    <div className="mx-auto max-w-[1640px] px-8 py-8">
      <div className="t-label">Patient 360</div>
      <h1 className="t-display mt-1 text-[40px]">Patients</h1>
      <p className="t-muted mt-3 text-[15px] leading-relaxed">
        3,539 synthetic patients, each with a whole record across the hospital's systems: visits, problems,
        prescriptions and results from Epic, studies from the PACS, DICOM images from the archive, and
        reports and notes, typed and scanned. The demo patients come first; search to find anyone else. Select a
        patient to open their record.
      </p>
      <SearchBar search={search} onSearch={setSearch} />
      {error && (
        <p className="mt-6 text-[13px]" style={{ color: 'var(--c-alert)' }}>
          {fromCache ? `The list below is from your last visit; the latest could not be read (${error}).` : error}
        </p>
      )}
      {search.demo && patients.length > 0 ? (
        <p className="num mt-6 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[14px]">
          <span>{summary(patients, total)}</span>
          {fromCache && loading && (
            <span className="list-refresh" role="status">
              From your last visit · reading the latest from Fabric
            </span>
          )}
        </p>
      ) : (
        <div className="t-faint mt-6 text-[12.5px]">
          {result ? `${fmtInt(total)} ${total === 1 ? 'patient' : 'patients'} · showing ${patients.length}` : loading ? 'Searching' : ''}
        </div>
      )}
      <div className="mt-3 overflow-x-auto">
        <table className="tbl text-[13px]">
          <thead>
            <tr>
              <th>Patient</th>
              <th>Cancer</th>
              <th>Stage</th>
              <th>Outcome</th>
              <th>Key alterations</th>
              <th className="text-right">Mutations per Mb</th>
              <th className="text-right">Slide</th>
              <th className="text-right">Scans</th>
              <th>Online and in the record</th>
            </tr>
          </thead>
          <tbody>
            {patients.map((p) => (
              <tr key={s(p.patient_id)!} className="cursor-pointer hover:bg-[var(--surface)]" title={s(p.demo_why) ?? undefined}>
                <td className="align-top">
                  <Link to={`/p/${s(p.patient_id)}`} className="font-medium hover:underline">
                    {s(p.display_name)}
                  </Link>
                  {s(p.demo_title) && <div className="t-muted max-w-[260px] text-[12.5px] leading-snug">{s(p.demo_title)}</div>}
                  <div className="mono t-faint">
                    {s(p.patient_id)}
                    {s(p.mrn) ? ` · MRN ${s(p.mrn)}` : ''}
                  </div>
                </td>
                <td className="align-top">
                  {s(p.cancer_type) ? (
                    s(p.cancer_type)!
                      .split('; ')
                      .map((c) => <div key={c}>{c}</div>)
                  ) : (
                    <div className="t-faint">No cancer recorded</div>
                  )}
                  <div className="t-faint text-[12px]">
                    {[`${s(p.sex) ?? ''}, ${n(p.age)}`, s(p.race)].filter(Boolean).join(' · ')}
                  </div>
                </td>
                <td className="whitespace-nowrap align-top">{shortStage(s(p.stage)) || '–'}</td>
                <td className="whitespace-nowrap align-top">
                  <span style={{ color: s(p.vital_status) === 'Dead' ? 'var(--c-alert)' : undefined }}>{outcome(p)}</span>
                </td>
                <td className="mono max-w-[300px] align-top text-[12px]">{s(p.key_alterations)?.split('; ').join(' · ') ?? '–'}</td>
                <td className="text-right align-top">
                  {p.tmb !== null && p.tmb !== undefined ? (
                    <div className="flex items-center justify-end gap-2">
                      <span className="num">{fmtNum(n(p.tmb), 1)}</span>
                      <span className="hbar w-[70px]">
                        <span
                          style={{
                            left: 0,
                            width: `${(Math.log10(1 + n(p.tmb)) / Math.log10(1 + maxTmb(patients))) * 100}%`,
                            background: s(p.msi_status) === 'MSI-high' || n(p.tmb) > 100 ? 'var(--c-gen)' : 'var(--ink-3)',
                          }}
                        />
                      </span>
                    </div>
                  ) : (
                    <span className="t-faint">–</span>
                  )}
                </td>
                <td className="num whitespace-nowrap text-right align-top">{n(p.slide_gigapixels) ? `${fmtNum(n(p.slide_gigapixels), 1)} GP` : '–'}</td>
                <td className="num text-right align-top">{n(p.scan_series) || '–'}</td>
                <td className="align-top text-[12.5px]">
                  <div>{online(p)}</div>
                  <div className="t-faint text-[12px]">
                    {count(p.visits, 'visit')} · {count(p.studies, 'study', 'studies')}, {fmtInt(n(p.studies_online))} online ·{' '}
                    {count(p.documents, 'document')}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {patients.length < total && (
        <button className="btn mt-4" onClick={more} disabled={loading}>
          {loading ? 'Reading' : `Show ${Math.min(10, total - patients.length)} more`}
        </button>
      )}
      {result && !fromCache && (
        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-[12.5px]">
          <span className="t-faint">
            The rows shown are one SQL statement over the Patient 360 index, Epic Clarity, the PACS database and the
            documents lakehouse{LOCAL_DATA ? ' (in local mode, DuckDB over local copies)' : ''}: {q?.rows ?? 0} rows in {fmtMs(q?.ms)}.
          </span>
          <span className="flex items-center gap-3">
            <span className="src"><span className="swatch sw-clinical" />Bronze_Clarity</span>
            <span className="src"><span className="swatch sw-radiology" />Bronze_PACS</span>
            <span className="src"><span className="swatch sw-documents" />Bronze_ClinicalDocuments</span>
          </span>
          <button className="link t-muted" onClick={() => setShowSql((v) => !v)}>
            {showSql ? 'Hide the SQL' : 'Show the SQL'}
          </button>
        </div>
      )}
      {showSql && result && <pre className="code mt-3">{result.provenance.showcaseSql}</pre>}
      <p className="t-faint mt-10 max-w-[92ch] text-[11.5px]">
        For demonstration, education and research only. Every patient is synthetic (Synthea Coherent Data Set, CC BY
        4.0); the images come from public archives (LIDC-IDRI, TCGA, Coherent) with synthetic identities attached.
      </p>
    </div>
  );
}

const LIST_KEY = 'p360.list';

export function Patients() {
  const { id } = useParams();
  // Switching patient keeps the open tab, so the same view can be compared across patients.
  const [params] = useSearchParams();
  const keepTab = params.get('tab') ? `?tab=${encodeURIComponent(params.get('tab')!)}` : '';
  const { patients, total, loading, fromCache, getPatient, search, setSearch, more, result } = useCohort();
  const [query, setQuery] = useState(search.q ?? '');
  useEffect(() => setQuery(search.q ?? ''), [search.q]);
  // The list folds to a rail by default so the record has room; the choice is remembered.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(LIST_KEY) !== 'open');
  const toggle = () => {
    setCollapsed((c) => {
      localStorage.setItem(LIST_KEY, c ? 'open' : 'collapsed');
      return !c;
    });
    // Viewers size themselves on window resize; tell them the column changed.
    window.setTimeout(() => window.dispatchEvent(new Event('resize')), 30);
  };
  // The list's box searches as you stop typing.
  useEffect(() => {
    const q = query.trim();
    if (q === (search.q ?? '')) return;
    const t = window.setTimeout(() => setSearch(q ? { ...search, demo: false, q } : search.demo ? search : { ...search, q: undefined }), 350);
    return () => window.clearTimeout(t);
  }, [query, search, setSearch]);

  const count = result
    ? `${patients.length} of ${fmtInt(total)} ${search.demo ? 'demo patients' : 'patients'} · ${fromCache ? (loading ? 'updating' : 'last visit') : fmtMs(result.provenance.totalMs)}`
    : loading
      ? 'Searching'
      : '';

  return (
    <div className="flex h-full">
      <ListColumn
        query={query}
        onQuery={setQuery}
        placeholder="Name, MRN or condition"
        count={count}
        collapsed={collapsed}
        onToggle={toggle}
        rail={patients.map((p) => (
          <Link
            key={s(p.patient_id)!}
            to={`/p/${s(p.patient_id)}${keepTab}`}
            className="rail-item"
            aria-current={p.patient_id === id}
            title={`${s(p.display_name)} · ${s(p.demo_title) ?? online(p)}`}
            onMouseEnter={() => void getPatient(s(p.patient_id)!).catch(() => undefined)}
          >
            {initials(s(p.display_name) ?? '')}
          </Link>
        ))}
      >
        <Link to="/" className="list-row text-[13px]" aria-current={!id}>
          Search patients
        </Link>
        <div className="list-heading">{search.demo ? 'Demo patients' : 'Patients found'}</div>
        {patients.map((p) => (
          <PatientRow
            key={s(p.patient_id)!}
            p={p}
            current={p.patient_id === id}
            onHover={() => void getPatient(s(p.patient_id)!).catch(() => undefined)}
            query={keepTab}
          />
        ))}
        {patients.length < total && (
          <button className="list-row t-muted text-[12.5px]" onClick={more} disabled={loading}>
            Show {Math.min(10, total - patients.length)} more
          </button>
        )}
      </ListColumn>
      <main className="min-w-0 flex-1 overflow-y-auto" id="patient-scroll">
        {id ? <PatientView id={id} /> : <PatientsOverview />}
      </main>
    </div>
  );
}
