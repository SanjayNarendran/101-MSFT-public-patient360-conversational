import { useEffect, useState } from 'react';

import { DocSection } from '@/components/Doc';
import { fetchDataMap, SOURCE_INFO, type DataMap as DataMapT } from '@/lib/api';
import { fmtBytes, fmtInt, fmtMs } from '@/lib/format';
import { LOCAL_DATA } from '@/lib/localMode';

/** Where each source lives and what reads it. */
const ROLE: Record<string, string> = {
  clarity: 'Epic Clarity tables, written as Delta tables into a lakehouse.',
  pacs: 'The PACS index: patients, studies, series, instances and nodule findings, in a Fabric SQL database.',
  archive: 'The DICOM files the PACS index points to, as the scanners sent them.',
  documents: 'Reports and notes as text and scanned PDF, with an index and the facts each was written from.',
  p360: 'The patient index and the viewer files made for the demo patients.',
  oncology: 'The imported TCGA patients’ registry records and primary-care history.',
  genomics: 'TCGA tumour genomes: the imported patients’ and those behind the hospital patients’ slides.',
  research_imaging: 'The imported TCGA patients’ slide pyramids and CT and MRI volumes.',
};

export function DataMap() {
  const [map, setMap] = useState<DataMapT | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchDataMap()
      .then(setMap)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-8 pb-24 pt-8">
        <div className="t-label">Where the data lives</div>
        <h1 className="t-display mt-1 text-[40px]">Read where it lives</h1>
        <p className="t-muted mt-3 text-[15px] leading-relaxed">
          A patient’s record is assembled on request from the systems that hold it: Epic Clarity, the PACS
          database, the imaging archive and the documents lakehouse, and for the oncology research patients, three
          research silos. The app keeps a small patient index and the viewer files it makes from the DICOM.
          {LOCAL_DATA ? ' In local mode each source is a DuckDB catalog with the same name, over a local copy.' : ''}
        </p>
        {error && <p className="mt-6 text-[13px]" style={{ color: 'var(--c-alert)' }}>{error}</p>}
        {!map && !error && <div className="loading-bar mt-6" />}
        {map &&
          map.sources.map((s) => (
            <DocSection
              key={s.source}
              title={SOURCE_INFO[s.source].label}
              intro={
                <>
                  <span className="mono">{s.name}</span>
                  <br />
                  {SOURCE_INFO[s.source].system}
                </>
              }
            >
              <p className="t-muted mb-3 text-[13.5px]">{ROLE[s.source]}</p>
              <table className="tbl text-[12.5px]">
                <thead>
                  <tr>
                    <th>Table or folder</th>
                    <th className="text-right">Rows</th>
                    <th className="text-right">Files</th>
                    <th className="text-right">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {s.tables.map((t) => (
                    <tr key={t.name}>
                      <td className="mono">{t.name}</td>
                      <td className="num text-right">{fmtInt(t.rows)}</td>
                      <td />
                      <td className="num text-right">{fmtBytes(t.bytes)}</td>
                    </tr>
                  ))}
                  {s.files.map((f) => (
                    <tr key={f.name}>
                      <td className="mono">{f.name}/</td>
                      <td />
                      <td className="num text-right">{fmtInt(f.files)}</td>
                      <td className="num text-right">{fmtBytes(f.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DocSection>
          ))}
        {map && <p className="t-faint mt-6 text-[12px]">Read in {fmtMs(map.provenance.totalMs)}.</p>}
      </div>
    </div>
  );
}
