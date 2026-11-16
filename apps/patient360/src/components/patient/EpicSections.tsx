/**
 * The record's sections for patients read from the Bronze sources (Epic Clarity, the PACS database, the imaging
 * archive and the documents lakehouse): the summary overview, a document beside its scan, a radiology study with its
 * nodules, a slide, and the cancer course from the problem list and orders.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { ReportPdf, warmPdfJs } from '@/components/patient/ReportPdf';
import { Scrubber } from '@/components/Scrubber';
import { fetchDocument, fileUrl, num, str, type DocumentText, type PatientBundle, type Row } from '@/lib/api';
import { properName } from '../../../rayfin/functions/src/record';
import { fmtBytes, fmtDate, fmtInt, fmtMonth, fmtMs, fmtNum, fmtSpan, parseDate, sentenceCase } from '@/lib/format';
import { LOCAL_DATA } from '@/lib/localMode';

const DAY = 86_400_000;

function Kv({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv kv-tight text-[13px]">
      {rows
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  );
}

function Source({ swatch, children }: { swatch: string; children: ReactNode }) {
  return (
    <span className="src ml-auto">
      <span className={`swatch sw-${swatch}`} />
      {children}
    </span>
  );
}

/* ================================================================== summary */

export function epicPersonLine(b: PatientBundle): string {
  const p = b.patient;
  const age = num(p.age);
  const died = str(p.death_date);
  const sex = str(p.sex)?.toLowerCase() === 'female' ? 'woman' : 'man';
  const ageText = died ? `died aged ${age}` : `${age}-year-old ${sex}`;
  return [died ? `${sex.charAt(0).toUpperCase()}${sex.slice(1)}, ${ageText}` : ageText.charAt(0).toUpperCase() + ageText.slice(1), str(p.race), str(p.ethnicity), [str(p.city), str(p.state)].filter(Boolean).join(', ')]
    .filter(Boolean)
    .join(' · ');
}

export function epicBarLine(b: PatientBundle): string {
  const p = b.patient;
  const sex = str(p.sex)?.toLowerCase() === 'female' ? 'F' : 'M';
  const status = str(p.death_date) ? `died ${fmtMonth(str(p.death_date))}` : `last seen ${fmtMonth(str(p.last_contact_date))}`;
  return [str(p.cancer_type), `${num(p.age)} ${sex}`, `MRN ${str(p.mrn)}`, status].filter(Boolean).join(' · ');
}

function Modality({ swatch, label, children }: { swatch: string; label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="t-label flex items-center gap-1.5">
        <span className={`swatch sw-${swatch}`} />
        {label}
      </div>
      <div className="num mt-0.5 text-[13px]">{children}</div>
    </div>
  );
}

/** Who the patient is and what each source holds for them; the top of the Summary tab. */
export function EpicOverview({ b, onProvenance, loadMs }: { b: PatientBundle; onProvenance: () => void; loadMs: number | null }) {
  const p = b.patient;
  const prov = b.provenance;
  const sources = new Set(prov.queries.flatMap((q) => q.sources));
  const online = b.studies.filter((s) => s.availability === 'ONLINE').length;
  const gp = b.slides.reduce((s, x) => s + (num(x.width) ?? 0) * (num(x.height) ?? 0), 0) / 1e9;
  const scanned = b.documents.filter((d) => d.scanned).length;
  const active = b.conditions.filter((c) => !c.resolved);
  const first = parseDate(str(b.encounters[0]?.start));
  const lastSeen = parseDate(str(p.last_contact_date));
  return (
    <div className="mb-7">
      <div className="grid items-start gap-x-14 gap-y-5 xl:grid-cols-[minmax(0,1fr)_minmax(440px,auto)]">
        <div className="min-w-0">
          <div className="text-[19px] leading-snug">
            {str(p.cancers) ? str(p.cancers) : active.length ? `${active.length} long-term conditions` : 'No long-term conditions recorded'}
          </div>
          <div className="t-muted mt-1.5 text-[13.5px]">{epicPersonLine(b)}</div>
        </div>
        <dl className="facts grid-cols-2 pt-1">
          <div className="fact">
            <dt>In the record</dt>
            <dd>
              {first && lastSeen ? fmtSpan((lastSeen.getTime() - first.getTime()) / DAY) : '–'}
              <div className="t-faint text-[12px]">
                {first ? fmtMonth(first.toISOString()) : ''} to {lastSeen ? fmtMonth(lastSeen.toISOString()) : ''}
              </div>
            </dd>
          </div>
          <div className="fact">
            <dt>{str(p.death_date) ? 'Died' : 'Last contact'}</dt>
            <dd style={{ color: str(p.death_date) ? 'var(--c-alert)' : undefined }}>
              {fmtDate(str(p.death_date) ?? str(p.last_contact_date))}
            </dd>
          </div>
          <div className="fact">
            <dt>Primary care</dt>
            <dd>{str(p.pcp) ?? '–'}</dd>
          </div>
          <div className="fact">
            <dt>Identifiers</dt>
            <dd className="mono text-[12px]">
              MRN {str(p.mrn)} · {str(p.patient_id)}
            </dd>
          </div>
        </dl>
      </div>
      <div className="hair mt-5 grid grid-cols-2 gap-x-8 gap-y-3 border-t pt-4 md:grid-cols-3 xl:grid-cols-6">
        <Modality swatch="clinical" label="Epic Clarity">
          {fmtInt(b.encounters.length)} visits · {fmtInt(b.observations.length)} results
        </Modality>
        <Modality swatch="clinical" label="Problems and orders">
          {b.conditions.length} problems · {fmtInt(b.medications.length)} prescriptions
        </Modality>
        <Modality swatch="radiology" label="PACS">
          {b.studies.length} {b.studies.length === 1 ? 'study' : 'studies'} · {online} online
          {b.nodules.length ? ` · ${b.nodules.length} nodules` : ''}
        </Modality>
        <Modality swatch="pathology" label={b.slides.length === 1 ? 'Slide' : 'Slides'}>
          {b.slides.length ? `${b.slides.length} · ${fmtNum(gp, 1)} gigapixels` : 'none'}
          {b.genomes.length ? ` · ${b.genomes.length === 1 ? 'genome' : `${b.genomes.length} genomes`}` : ''}
        </Modality>
        <Modality swatch="documents" label="Documents">
          {b.documents.length} · {scanned} scanned
        </Modality>
        <button onClick={onProvenance} className="text-left" title="See every query that built this page">
          <div className="t-label flex items-center gap-1.5">
            <span className="swatch" style={{ background: 'var(--accent)' }} />
            Read in place
          </div>
          <div className="num mt-0.5 text-[13px] underline decoration-[var(--line-strong)] underline-offset-[3px] hover:decoration-[var(--accent)]">
            {prov.queries.length} queries · {sources.size} sources · {fmtMs(loadMs ?? prov.totalMs)}
          </div>
        </button>
      </div>
    </div>
  );
}

/** Why this patient is a demo patient: written for the demo from the record, and labelled so. */
export function DemoStory({ b }: { b: PatientBundle }) {
  const why = str(b.index?.demo_why);
  if (!why) return null;
  return (
    <div className="hair grid gap-x-14 gap-y-4 border-t pt-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
      <div>
        <div className="t-label">Demo patient {num(b.index?.demo_order)}</div>
        <h2 className="t-display mt-1 text-[25px] leading-tight">{str(b.index?.demo_title)}</h2>
        <p className="lede mt-3">{why}</p>
        <p className="t-faint mt-3 text-[11.5px]">Written for the demo from this record. The patient is synthetic.</p>
      </div>
    </div>
  );
}

/* ================================================================== a document */

/** Escapes the text, then marks each ground-truth fact where it appears. */
function markFacts(text: string, facts: Row[]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = esc(text);
  const terms = [...new Set(facts.map((f) => str(f.text)).filter((t): t is string => !!t && t.length > 3))].sort((a, z) => z.length - a.length);
  for (const t of terms) {
    const re = new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    html = html.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return html;
}

export function DocumentPanel({ b, doc, onOpenStudy }: { b: PatientBundle; doc: Row; onOpenStudy?: (studyUid: string) => void }) {
  const id = str(doc.document_id)!;
  const [data, setData] = useState<DocumentText | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pages, setPages] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  useEffect(() => {
    let off = false;
    setData(null);
    setError(null);
    setPages(null);
    setPage(1);
    fetchDocument(id)
      .then((d) => !off && setData(d))
      .catch((e) => !off && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      off = true;
    };
  }, [id]);
  useEffect(() => {
    if (doc.scanned) warmPdfJs().catch(() => undefined);
  }, [doc.scanned]);
  const html = useMemo(() => (data ? markFacts(data.text, data.facts) : ''), [data]);
  const scanned = !!doc.scanned;
  const pdfUrl = scanned && str(doc.path) ? fileUrl(b.access.documents, str(doc.path)!) : null;
  const study = str(doc.study_uid) ? b.studies.find((s) => s.study_uid === doc.study_uid) : null;

  return (
    <div className="@container">
      <div className="mb-5 grid gap-x-10 gap-y-2 @xl:grid-cols-2 @4xl:grid-cols-3">
        <Kv rows={[['Type', str(doc.type)], ['Format', str(doc.format)], ['Words', fmtInt(num(doc.words))]]} />
        <Kv rows={[['Author', str(doc.author)], ['Department', str(doc.department)], ['Campus', properName(str(doc.campus))]]} />
        <Kv
          rows={[
            ['Service date', fmtDate(str(doc.date))],
            ['Signed', fmtDate(str(doc.signed))],
            [
              'Study',
              study ? (
                onOpenStudy ? (
                  <button className="link" onClick={() => onOpenStudy(str(study.study_uid)!)}>
                    {str(study.accession)}
                  </button>
                ) : (
                  str(study.accession)
                )
              ) : (
                str(doc.accession)
              ),
            ],
          ]}
        />
      </div>
      {error && <p className="text-[13px]" style={{ color: 'var(--c-alert)' }}>Could not read the document: {error}</p>}
      <div className={`grid gap-8 ${scanned ? '@4xl:grid-cols-2' : ''}`}>
        <div className="min-w-0">
          <div className="t-label mb-1.5 flex items-center gap-3">
            {scanned ? 'Text (the source of the scan)' : 'Text'}
            {data && <span className="t-faint normal-case">{data.facts.length} {data.facts.length === 1 ? 'fact' : 'facts'} marked</span>}
          </div>
          {data ? (
            <div className="report" dangerouslySetInnerHTML={{ __html: html || 'No text.' }} />
          ) : (
            !error && <div className="loading-bar" />
          )}
          <div className="t-faint mt-1.5 text-[11.5px]">
            {str(scanned ? doc.text_path : doc.path)} in Bronze_ClinicalDocuments{LOCAL_DATA ? ' (local copy)' : ''}
          </div>
        </div>
        {scanned && (
          <div className="min-w-0">
            <div className="t-label mb-1.5 flex items-center gap-3">
              Scanned original
              <span className="t-faint normal-case">
                PDF, {fmtBytes(num(doc.bytes))}
                {pages ? ` · ${pages} ${pages === 1 ? 'page' : 'pages'}` : ''}
              </span>
              {pdfUrl && (
                <a className="link t-muted normal-case" href={pdfUrl} target="_blank" rel="noreferrer">
                  Open in a new tab
                </a>
              )}
            </div>
            {pdfUrl && pages && pages > 1 && (
              <Scrubber
                name="Document pages"
                gutter={92}
                leading={<div>{pages} pages</div>}
                items={Array.from({ length: pages }, (_, i) => ({ id: String(i + 1), at: 0.08 + (0.84 * i) / (pages - 1), label: `Page ${i + 1} of ${pages}`, tick: `p. ${i + 1}` }))}
                selected={String(page)}
                onSelect={(p) => setPage(Number(p))}
              />
            )}
            {pdfUrl ? <ReportPdf key={pdfUrl} url={pdfUrl} label={`Scanned ${(str(doc.type) ?? 'document').toLowerCase()}`} onPages={setPages} page={page} onPage={setPage} /> : <div className="report t-faint">The scan is not available.</div>}
          </div>
        )}
      </div>
      {data && data.facts.length > 0 && (
        <div className="hair mt-8 border-t pt-4">
          <div className="t-label mb-2">Facts in this document (the ground truth it was written from)</div>
          <table className="tbl text-[12.5px]">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Fact</th>
                <th>Code</th>
                <th className="text-right">Value</th>
                <th>Site</th>
              </tr>
            </thead>
            <tbody>
              {data.facts.map((f) => (
                <tr key={String(f.n)}>
                  <td className="t-faint">{str(f.type)}</td>
                  <td>{str(f.text)}</td>
                  <td className="mono">{[str(f.code_system), str(f.code)].filter(Boolean).join(' ')}</td>
                  <td className="num text-right">{[str(f.value), str(f.unit)].filter(Boolean).join(' ')}</td>
                  <td className="t-faint">{[str(f.laterality), str(f.site)].filter(Boolean).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ================================================================== a radiology study */

export function StudyFacts({ b, study, onOpenDocument, children }: { b: PatientBundle; study: Row; onOpenDocument?: (documentId: string) => void; children?: ReactNode }) {
  const series = b.radiologySeries.filter((s) => s.study_uid === study.study_uid);
  const nodules = b.nodules.filter((n) => n.study_uid === study.study_uid);
  const online = str(study.availability) === 'ONLINE';
  const report = str(study.report_id);
  return (
    <div>
      <div className="mb-5 grid gap-x-10 gap-y-2 md:grid-cols-2 xl:grid-cols-3">
        <Kv rows={[['Accession', <span className="mono">{str(study.accession)}</span>], ['Modality', str(study.modalities)], ['Body part', sentenceCase(str(study.body_part))]]} />
        <Kv rows={[['Institution', properName(str(study.institution))], ['Referring', properName(str(study.referring)?.replace('^', ', ') ?? null, 'person')], ['Epic order', <span className="mono">{str(study.order_id)}</span>]]} />
        <Kv
          rows={[
            ['Availability', online ? `Online, ${fmtInt(num(study.images))} images, ${fmtNum(num(study.size_mb), 0)} MB` : 'Archived offline: index and report only'],
            ['Images from', str(study.source_collection) ? `${str(study.source_collection)} (${str(study.source_license)})` : null],
            [
              'Report',
              report ? (
                onOpenDocument ? (
                  <button className="link" onClick={() => onOpenDocument(report)}>
                    {report}
                  </button>
                ) : (
                  report
                )
              ) : (
                'none'
              ),
            ],
          ]}
        />
      </div>
      {children}
      {nodules.length > 0 && (
        <div className="mt-6">
          <div className="sec-head">
            <h3 className="sec-title text-[17px]">Nodules outlined by the LIDC radiologists</h3>
            <span className="sec-note">Up to four readers outlined each nodule; sizes and ratings are their consensus.</span>
            <Source swatch="radiology">Bronze_PACS · pacs.NoduleFinding</Source>
          </div>
          <table className="tbl text-[12.5px]">
            <thead>
              <tr>
                <th>Nodule</th>
                <th className="text-right">Diameter</th>
                <th className="text-right">Volume</th>
                <th>Where</th>
                <th>Texture</th>
                <th>Margin</th>
                <th className="text-right">Malignancy</th>
                <th className="text-right">Readers</th>
              </tr>
            </thead>
            <tbody>
              {nodules.map((n) => (
                <tr key={`${str(n.label)}`}>
                  <td className="mono">{str(n.label)}</td>
                  <td className="num text-right">{fmtNum(num(n.diameter_mm), 1)} mm</td>
                  <td className="num text-right">{fmtNum(num(n.volume_mm3), 0)} mm³</td>
                  <td>{[str(n.laterality), str(n.lobe)].filter(Boolean).join(', ').toLowerCase()}</td>
                  <td>{str(n.texture)?.toLowerCase()}</td>
                  <td>{str(n.margin)?.toLowerCase()}</td>
                  <td className="num text-right">{fmtNum(num(n.malignancy), 1)} of 5</td>
                  <td className="num text-right">{num(n.readers)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {series.length > 0 && (
        <div className="mt-6">
          <div className="t-label mb-2">Series in the PACS index</div>
          <table className="tbl text-[12.5px]">
            <thead>
              <tr>
                <th>Series</th>
                <th>Modality</th>
                <th>Description</th>
                <th className="text-right">Images</th>
                <th className="text-right">Slice</th>
                <th>Scanner</th>
                <th>Availability</th>
              </tr>
            </thead>
            <tbody>
              {series.map((s) => (
                <tr key={str(s.series_uid)!}>
                  <td className="num">{num(s.series_number) ?? '–'}</td>
                  <td>{str(s.modality)}</td>
                  <td>{sentenceCase(str(s.description))}</td>
                  <td className="num text-right">{fmtInt(num(s.instances))}</td>
                  <td className="num text-right">{num(s.slice_mm) ? `${fmtNum(num(s.slice_mm), 2)} mm` : ''}</td>
                  <td className="t-faint">{[str(s.manufacturer), str(s.model)].filter(Boolean).join(' ')}</td>
                  <td className="t-faint">{str(s.availability)?.toLowerCase()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ================================================================== a slide */

export function SlideFacts({
  slide,
  onOpenDocument,
  onOpenGenome,
  children,
}: {
  slide: Row;
  onOpenDocument?: (documentId: string) => void;
  onOpenGenome?: (barcode: string) => void;
  children?: ReactNode;
}) {
  const report = str(slide.report_id);
  const genome = str(slide.genome);
  const w = num(slide.width);
  const h = num(slide.height);
  return (
    <div>
      <div className="mb-5 grid gap-x-10 gap-y-2 md:grid-cols-2 xl:grid-cols-3">
        <Kv rows={[['Specimen', sentenceCase(str(slide.specimen))], ['Accession', <span className="mono">{str(slide.accession)}</span>]]} />
        <Kv rows={[['Size', w && h ? `${fmtInt(w)} × ${fmtInt(h)} pixels, ${fmtNum((w * h) / 1e9, 1)} gigapixels` : null], ['Stored as', `DICOM whole-slide image, ${fmtNum(num(slide.size_mb), 0)} MB`]]} />
        <Kv
          rows={[
            ['Images from', str(slide.barcode)],
            ['Report', report ? onOpenDocument ? <button className="link" onClick={() => onOpenDocument(report)}>{report}</button> : report : 'none'],
            ...(genome
              ? [['Tumour genome', onOpenGenome ? <button className="link mono" onClick={() => onOpenGenome(genome)}>{genome}</button> : genome] as [string, ReactNode]]
              : []),
          ]}
        />
      </div>
      {children}
    </div>
  );
}

/* ================================================================== the cancer course (Epic) */

export function EpicCancer({ b }: { b: PatientBundle }) {
  const p = b.patient;
  if (!str(p.diagnosis_date)) return <p className="t-faint text-[13px]">No cancer is on this patient's problem list.</p>;
  return (
    <div>
      <div className="sec-head">
        <h2 className="sec-title">Cancer course</h2>
        <span className="sec-note">From the problem list, the oncology flowsheets and the medication and procedure orders.</span>
        <Source swatch="clinical">Bronze_Clarity · PROBLEM_LIST, ORDER_MED, ORDER_PROC</Source>
      </div>
      <table className="tbl text-[13px]">
        <thead>
          <tr>
            <th>Date</th>
            <th>Diagnosis</th>
            <th>ICD-10</th>
            <th>Resolved</th>
          </tr>
        </thead>
        <tbody>
          {b.diagnoses
            .filter((d) => d.primary_diagnosis)
            .map((d, i) => (
              <tr key={i}>
                <td className="num whitespace-nowrap">{fmtDate(str(d.date))}</td>
                <td>{str(d.primary_diagnosis)}</td>
                <td className="mono">{str(d.icd10)}</td>
                <td className="t-faint">{fmtDate(str(d.resolved))}</td>
              </tr>
            ))}
        </tbody>
      </table>
      {(str(p.stage) || str(p.tnm)) && (
        <p className="mt-3 text-[13px]">
          Staged {str(p.stage)} {str(p.tnm) ? `(${str(p.tnm)})` : ''} in the oncology flowsheet.
        </p>
      )}
      {b.treatments.length > 0 && (
        <div className="mt-6">
          <div className="t-label mb-2">Treatment courses (orders less than 45 days apart are one course)</div>
          <table className="tbl text-[13px]">
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th>Treatment</th>
                <th className="text-right">Orders</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {b.treatments.map((t, i) => (
                <tr key={i}>
                  <td className="num whitespace-nowrap">{fmtDate(str(t.start_date))}</td>
                  <td className="num whitespace-nowrap">{fmtDate(str(t.end_date))}</td>
                  <td>
                    {str(t.agent) ?? str(t.anatomic_site)} <span className="t-faint">· {str(t.treatment_type)?.toLowerCase()}</span>
                  </td>
                  <td className="num text-right">{num(t.orders)}</td>
                  <td className="mono t-faint text-[11.5px]">{str(t.source)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
