import { useEffect, useMemo, useState } from 'react';

import { api, errorText, type RequestSummary } from '@/lib/api';
import { STATUS_WORDS, when } from '@/lib/format';

const FILTERS = ['All', 'PENDING', 'APPROVED', 'DELIVERED', 'REJECTED'] as const;

export function Inbox({ open }: { open: (id: number) => void }) {
  const [requests, setRequests] = useState<RequestSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('All');

  useEffect(() => {
    api.listRequests().then(setRequests).catch((e) => setError(errorText(e)));
  }, []);

  const counts = useMemo(() => {
    const c: Record<string, number> = { All: requests?.length ?? 0 };
    for (const r of requests ?? []) c[r.STATUS] = (c[r.STATUS] ?? 0) + 1;
    return c;
  }, [requests]);
  const shown = (requests ?? []).filter((r) => filter === 'All' || r.STATUS === filter);

  return (
    <section className="enter">
      <p className="eyebrow">Contoso Health · i2b2 cohort discovery</p>
      <h1 className="headline">Cohort data requests</h1>
      <p className="lede">
        Each request is an i2b2 query a researcher ran and submitted. Open one to review the question, the query and
        its counts, then approve or reject it. Approved requests are delivered separately, from the request page.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '22px 0 10px' }}>
        <div className="seg" role="group" aria-label="Filter by status">
          {FILTERS.map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === 'All' ? 'All' : STATUS_WORDS[f]} <span className="muted tnum">{counts[f] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      {error ? <p className="alert">{error}</p> : null}
      {requests === null && !error ? <p className="muted">Loading requests…</p> : null}
      {requests && shown.length === 0 ? <p className="muted">No requests here.</p> : null}
      {shown.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th className="num">Request</th>
              <th>Title and question</th>
              <th className="num">Patients</th>
              <th>Requested by</th>
              <th>Requested</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.QUERY_MASTER_ID} className="link" onClick={() => open(r.QUERY_MASTER_ID)}>
                <td className="num mono">{r.QUERY_MASTER_ID}</td>
                <td>
                  <a href={`#/requests/${r.QUERY_MASTER_ID}`} onClick={(e) => e.stopPropagation()} style={{ fontWeight: 500 }}>
                    {r.TITLE}
                  </a>
                  {r.NL_QUESTION ? <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{r.NL_QUESTION}</div> : null}
                </td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>{r.PATIENT_COUNT_DISPLAY}</td>
                <td>{r.REQUESTED_BY}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{when(r.REQUESTED_AT)}</td>
                <td><span className={`status status-${r.STATUS}`}>{STATUS_WORDS[r.STATUS] ?? r.STATUS}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p className="note">
        Patient counts are obfuscated as for an i2b2 DATA_OBFSC user: Gaussian noise is added and 3 or fewer is shown
        as "Fewer than 4".
      </p>
    </section>
  );
}
