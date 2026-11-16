import { useState } from 'react';

import { ReportPdf } from '@/components/patient/ReportPdf';

/** The scanned pathology report beside the slide. */
export function ReportPane({ url, title, sourceUrl, onClose }: { url: string; title: string; sourceUrl?: string | null; onClose: () => void }) {
  const [pages, setPages] = useState(0);
  return (
    <section className="hair flex w-[46%] min-w-[360px] max-w-[720px] shrink-0 flex-col border-l" aria-label="Pathology report">
      <div className="pane-head hair flex h-9 shrink-0 items-center gap-3 border-b px-3 text-[12px]">
        <span className="font-medium">{title}</span>
        {pages > 0 && <span className="t-faint">{pages === 1 ? '1 page' : `${pages} pages`}</span>}
        {sourceUrl && (
          <a href={sourceUrl} target="_blank" rel="noreferrer" className="link t-muted">
            Source ↗
          </a>
        )}
        <button type="button" className="icon-btn ml-auto h-7 w-7" onClick={onClose} title="Close the report" aria-label="Close the report">
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ReportPdf url={url} onPages={setPages} label={title} />
      </div>
    </section>
  );
}
