import { useCallback, useEffect, useState } from 'react';

import { Breakdown } from '@/components/Breakdown';
import { DeliveryPanel, DemoCheck } from '@/components/Delivery';
import { QueryPanels } from '@/components/QueryPanels';
import { api, errorText, type RequestDetail } from '@/lib/api';
import { EVENT_WORDS, RUNNING, STATUS_WORDS, when, type QueryDefinition } from '@/lib/format';

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/xml' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

export function RequestView({ id, back }: { id: number; back: () => void }) {
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [deliverOnApprove, setDeliverOnApprove] = useState(true);
  const [demo, setDemo] = useState(true);

  const load = useCallback(
    () => api.getRequest(id).then((d) => { setDetail(d); setError(null); }).catch((e) => setError(errorText(e))),
    [id]
  );
  useEffect(() => { void load(); }, [load]);

  // While the delivery pipeline runs, follow its steps; reload the request when it finishes.
  const running = !!detail?.delivery && RUNNING.includes(detail.delivery.status);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      try {
        const next = await api.getDelivery(id);
        setDetail((d) => (d ? { ...d, delivery: next } : d));
        if (!next || !RUNNING.includes(next.status)) { clearInterval(t); void load(); }
      } catch { /* keep polling */ }
    }, 4000);
    return () => clearInterval(t);
  }, [id, running, load]);

  async function startDelivery(demoMode: boolean) {
    const started = await api.startDelivery(id, demoMode);
    setDetail((d) => (d ? { ...d, delivery: started } : d));
  }

  async function decide(decision: 'APPROVED' | 'REJECTED') {
    setBusy(decision); setMessage(null); setError(null);
    try {
      const recorded = await api.decide(id, decision, comment);
      setComment('');
      if (decision === 'APPROVED' && deliverOnApprove) {
        await startDelivery(demo);
        setMessage(`${recorded} The delivery has started${demo ? ' in demo mode' : ''}.`);
      } else setMessage(recorded);
      await load();
    } catch (e) { setError(errorText(e)); }
    setBusy(null);
  }

  async function deliver(demoMode: boolean) {
    setBusy('DELIVER'); setMessage(null); setError(null);
    try {
      await startDelivery(demoMode);
      await load();
    } catch (e) { setError(errorText(e)); }
    setBusy(null);
  }

  if (!detail) {
    return (
      <section className="enter">
        <button type="button" className="btn btn-quiet" onClick={back}>← All requests</button>
        {error ? <p className="alert" style={{ marginTop: 16 }}>{error}</p> : <p className="muted">Loading request {id}…</p>}
      </section>
    );
  }

  const r = detail.request;
  const status = String(r.STATUS);
  let definition: QueryDefinition | null = null;
  try { definition = detail.definition ? JSON.parse(detail.definition) : null; } catch { definition = null; }
  const xml = String(r.I2B2_QUERY_XML ?? '');

  return (
    <section className="enter" key={id}>
      <button type="button" className="btn btn-quiet" onClick={back} style={{ marginLeft: -6 }}>← All requests</button>
      <p className="eyebrow" style={{ marginTop: 14 }}>
        Request <span className="mono">{id}</span> · i2b2 query <span className="mono">{String(r.QUERY_NAME)}</span>
      </p>
      <h1 className="headline">{String(r.TITLE)}</h1>
      {r.NL_QUESTION ? <p className="lede">“{String(r.NL_QUESTION)}”</p> : null}

      <div className="facts" style={{ margin: '22px 0 34px', gridTemplateColumns: 'minmax(150px, .8fr) minmax(150px, .8fr) minmax(250px, 1.3fr) minmax(250px, 1.3fr)' }}>
        <div className="fact">
          <div className="fact-label">Patients (obfuscated)</div>
          <div className="fact-value tnum">{String(r.PATIENT_COUNT_DISPLAY ?? '')}</div>
        </div>
        <div className="fact">
          <div className="fact-label">Status</div>
          <div className="fact-value"><span className={`status status-${status}`} style={{ fontSize: 'inherit', fontWeight: 500 }}>{STATUS_WORDS[status] ?? status}</span></div>
        </div>
        <div className="fact">
          <div className="fact-label">Requested by</div>
          <div className="fact-value small">{String(r.REQUESTED_BY)}<br /><span className="muted">{when(String(r.REQUESTED_AT))}</span></div>
        </div>
        <div className="fact">
          <div className="fact-label">Decision</div>
          <div className="fact-value small">
            {r.DECIDED_BY ? (<>{String(r.DECIDED_BY)}<br /><span className="muted">{when(String(r.DECIDED_AT))}</span></>) : <span className="muted">Not decided yet</span>}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 38 }}>
        <div>
          <h2 className="h2">The i2b2 query</h2>
          {definition ? <QueryPanels definition={definition} /> : <pre className="xml">{String(r.QUERY_SUMMARY ?? '')}</pre>}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14 }}>
            <button type="button" className="btn" onClick={() => download(`i2b2_query_${id}.xml`, xml)} disabled={!xml}>
              Download i2b2 query XML
            </button>
            <span className="muted" style={{ fontSize: 12.5 }}>{String(r.QUERY_LANGUAGE ?? '')}</span>
          </div>
          <details style={{ marginTop: 12 }}>
            <summary>Show the query definition XML</summary>
            <pre className="xml" style={{ marginTop: 8 }}>{xml}</pre>
          </details>
        </div>

        <div>
          <h2 className="h2">Counts by category</h2>
          <Breakdown rows={detail.breakdown} />
          <p className="note">Each count is obfuscated on its own, so the categories don't add up exactly to the total.</p>
        </div>

        <div>
          <h2 className="h2">Decision</h2>
          {status === 'PENDING' ? (
            <div style={{ maxWidth: 720 }}>
              <label htmlFor="comment" className="fact-label" style={{ display: 'block', marginBottom: 6 }}>Comment (optional)</label>
              <textarea id="comment" className="field" value={comment} onChange={(e) => setComment(e.target.value)}
                placeholder="Reason, conditions of use, or a note for the requester" maxLength={1000} />
              <div style={{ display: 'grid', gap: 8, marginTop: 14 }}>
                <label className="check">
                  <input type="checkbox" checked={deliverOnApprove} onChange={(e) => setDeliverOnApprove(e.target.checked)} />
                  <span>Deliver the data when I approve <span className="muted">· starts the Cohort_Delivery_Pipeline</span></span>
                </label>
                <div className={`reveal${deliverOnApprove ? ' open' : ''}`}>
                  <div><div style={{ paddingLeft: 22 }}><DemoCheck demo={demo} setDemo={setDemo} disabled={!deliverOnApprove} /></div></div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => void decide('APPROVED')}>
                  {busy === 'APPROVED' ? (deliverOnApprove ? 'Approving and delivering…' : 'Approving…') : deliverOnApprove ? 'Approve and deliver' : 'Approve'}
                </button>
                <button type="button" className="btn btn-ink" disabled={!!busy} onClick={() => void decide('REJECTED')}>
                  {busy === 'REJECTED' ? 'Rejecting…' : 'Reject'}
                </button>
              </div>
              <p className="note">Your decision is recorded as <b>{detail.viewer}</b>, with the time in UTC.</p>
            </div>
          ) : (
            <p style={{ margin: 0 }}>
              <span className={`status status-${status === 'DELIVERED' ? 'APPROVED' : status}`}>
                {status === 'REJECTED' ? 'Rejected' : 'Approved'}
              </span>{' '}
              by {String(r.DECIDED_BY)} on {when(String(r.DECIDED_AT))}.
              {r.DECISION_COMMENT ? <span className="muted"> “{String(r.DECISION_COMMENT)}”</span> : null}
            </p>
          )}
        </div>

        {status === 'APPROVED' || status === 'DELIVERED' ? (
          <div>
            <h2 className="h2">Delivery</h2>
            {status === 'DELIVERED' && !running && !detail.delivery?.lakehouse ? (
              <>
                <p style={{ margin: '0 0 12px' }}>
                  Delivered <b>{String(r.DELIVERED_PATIENTS)}</b> patients to the lakehouse{' '}
                  <span className="mono">{String(r.DELIVERY_LAKEHOUSE)}</span> on {when(String(r.DELIVERED_AT))}.
                </p>
                {detail.delivered?.notebook?.url || detail.delivered?.lakehouse.url ? (
                  <p style={{ margin: '0 0 18px', display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                    {detail.delivered.notebook?.url ? (
                      <a className="btn btn-primary" href={detail.delivered.notebook.url} target="_blank" rel="noopener">Explore the data in a notebook ↗</a>
                    ) : null}
                    {detail.delivered.lakehouse.url ? (
                      <a className="btn" href={detail.delivered.lakehouse.url} target="_blank" rel="noopener">Open {detail.delivered.lakehouse.name} in Fabric ↗</a>
                    ) : null}
                  </p>
                ) : null}
              </>
            ) : null}
            {detail.patient360 ? (
              <p style={{ margin: '0 0 18px' }}>
                <a className="btn" href={detail.patient360} target="_blank" rel="noopener">Open the cohort's patients in Patient 360 ↗</a>
              </p>
            ) : null}
            <DeliveryPanel job={detail.delivery} requestStatus={status} id={id} busy={busy === 'DELIVER'}
              onStart={(d) => void deliver(d)} />
          </div>
        ) : null}

        {message ? <p className="notice" style={{ margin: 0 }}>{message}</p> : null}
        {error ? <p className="alert" style={{ margin: 0 }}>{error}</p> : null}

        <div>
          <h2 className="h2">Audit trail</h2>
          <ol className="timeline">
            {detail.events.map((e, i) => (
              <li key={i} className={`ev-${e.EVENT}`}>
                <div className="tl-title">{EVENT_WORDS[e.EVENT] ?? e.EVENT}</div>
                <div className="tl-meta">{e.ACTOR} · {when(e.EVENT_AT)}</div>
                {e.DETAIL ? <div className="tl-detail">{e.DETAIL}</div> : null}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
