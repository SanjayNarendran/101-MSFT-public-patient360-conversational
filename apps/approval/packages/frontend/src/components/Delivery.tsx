import { useEffect, useState } from 'react';

import type { DeliveryJob } from '@/lib/api';
import { DEMO_LIMITS, RUNNING, clock, when } from '@/lib/format';

const STATUS_TEXT: Record<string, string> = {
  NotStarted: 'Queued', InProgress: 'Running', Completed: 'Completed', Failed: 'Failed', Cancelled: 'Cancelled',
  Deduped: 'Already running', Unknown: 'Unknown',
};

function utc(value: string | null | undefined): number {
  if (!value) return NaN;
  const v = String(value);
  return new Date(v.includes('T') ? (v.endsWith('Z') ? v : v + 'Z') : v.replace(' ', 'T') + 'Z').getTime();
}

function elapsed(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function DemoCheck({ demo, setDemo, disabled }: { demo: boolean; setDemo: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`check${disabled ? ' disabled' : ''}`}>
      <input type="checkbox" checked={demo} disabled={disabled} onChange={(e) => setDemo(e.target.checked)} />
      <span>Demo mode <span className="muted">· {DEMO_LIMITS}, to keep a live demo short</span></span>
    </label>
  );
}

/** The delivery: what it does, the pipeline run with its steps (live while it runs), and the controls to start it. */
export function DeliveryPanel({ job, requestStatus, id, busy, onStart }: {
  job: DeliveryJob | null;
  requestStatus: string;
  id: number;
  busy: boolean;
  onStart: (demo: boolean) => void;
}) {
  const [demo, setDemo] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const running = !!job && RUNNING.includes(job.status);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const done = job?.lakehouse ?? null;
  const failed = !!job && ['Failed', 'Cancelled'].includes(job.status);
  const start = utc(job?.requestedAt);
  const end = utc(job?.endTimeUtc) || now;

  return (
    <div style={{ maxWidth: 760 }}>
      <p style={{ margin: '0 0 14px' }}>
        Delivery runs the <b>Cohort_Delivery_Pipeline</b>. It creates a lakehouse next to this app, named after the
        request (<span className="mono">Delivery_QM{id}_…</span>): the cohort's OMOP tables are copied, its DICOM
        studies are linked with OneLake shortcuts, and its documents are copied. A notebook to explore the data,
        <span className="mono">Explore_QM{id}_…</span>, is created next to it.
      </p>

      {job ? (
        <div className={`run${running ? ' live' : ''}`}>
          <div className="run-head">
            <span className={`status status-${running ? 'RUNNING' : done ? 'DELIVERED' : failed ? 'REJECTED' : 'PENDING'}`}>
              {running ? STATUS_TEXT[job.status] : done ? 'Delivered' : STATUS_TEXT[job.status] ?? job.status}
            </span>
            <span className="muted">
              {job.runner}{job.demo ? ' · demo mode' : ''} · {Number.isFinite(start) ? elapsed(start, running ? now : end) : ''}
              {' · '}started by {job.startedBy}, {when(job.requestedAt)}
            </span>
          </div>
          <ol className="steps">
            {job.steps.map((s, i) => (
              <li key={i} className={`step enter${s.event === 'DELIVERED' ? ' final' : s.detail?.startsWith('Failed') ? ' failed' : ''}`}>
                <span>{s.event === 'DELIVERY_STARTED' ? `The notebook started: ${s.detail ?? ''} approved` : s.event === 'DELIVERED' ? `Delivered ${s.detail ?? ''}` : s.detail}</span>
                <span className="muted step-time">{clock(s.at)}</span>
              </li>
            ))}
            {running ? (
              <li className="step pending">
                <span>{job.steps.length ? 'Working…' : job.status === 'NotStarted' ? 'Queued: the pipeline is starting' : 'Starting the notebook session'}</span>
              </li>
            ) : null}
          </ol>
          {done ? (
            <p style={{ margin: '12px 0 0', display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {job.notebook?.url ? (
                <a className="btn btn-primary" href={job.notebook.url} target="_blank" rel="noopener">Explore the data in a notebook ↗</a>
              ) : null}
              {done.url ? <a className="btn" href={done.url} target="_blank" rel="noopener">Open {done.name} in Fabric ↗</a> : <span className="mono">{done.name}</span>}
            </p>
          ) : null}
          {failed ? <p className="alert" style={{ marginTop: 12 }}>The delivery failed: {job.failureReason ?? 'see the run in Fabric'}.</p> : null}
          <p className="note" style={{ marginTop: 10 }}>
            <a href={job.runnerUrl} target="_blank" rel="noopener">Open the {running ? 'running ' : ''}{job.runner.includes('Pipeline') ? 'pipeline' : 'notebook'} in Fabric ↗</a>
            {running ? ' · this page updates as each step finishes' : ''}
          </p>
        </div>
      ) : null}

      {!running && (requestStatus === 'APPROVED' || requestStatus === 'DELIVERED') ? (
        <div style={{ display: 'grid', gap: 10, marginTop: job ? 18 : 0 }}>
          <DemoCheck demo={demo} setDemo={setDemo} />
          <div>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onStart(demo)}>
              {busy ? 'Starting…' : job || requestStatus === 'DELIVERED' ? (demo ? 'Deliver again (demo)' : 'Deliver the full data set') : 'Start delivery'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
