import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useCohort } from '@/hooks/useCohort';
import { fetchRequests, num, str, type PatientBundle, type Row } from '@/lib/api';
import { fmtDate, fmtInt } from '@/lib/format';

const STATUS: Record<string, string> = { APPROVED: 'Approved', DELIVERED: 'Delivered' };

/** What the delivery holds for this patient: demo-mode deliveries carry part of a cohort. */
function delivery(c: Row): string | null {
  if (str(c.status) !== 'DELIVERED') return null;
  const when = fmtDate(str(c.delivered_at));
  const sent = num(c.delivered_patients);
  const all = num(c.patients);
  const part = sent !== null && all !== null && sent < all ? `${fmtInt(sent)} of the ${fmtInt(all)} patients (demo mode)` : 'the whole cohort';
  const here = c.in_delivery === true ? ', this patient among them' : c.in_delivery === false ? ', not this patient' : '';
  return `${when}: ${part}${here}`;
}

/** The approved and delivered data requests whose cohort includes this patient, from the cohort requests database. */
export function CohortsSection({ b }: { b: PatientBundle }) {
  const { setSearch } = useCohort();
  const navigate = useNavigate();
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null);
  useEffect(() => {
    fetchRequests()
      .then((r) => setApprovalUrl(r.approvalUrl || null))
      .catch(() => setApprovalUrl(null));
  }, []);
  const name = str(b.patient.display_name) ?? 'This patient';

  return (
    <div>
      <div className="sec-head">
        <h2 className="sec-title">Cohorts</h2>
        <span className="sec-note">
          Data requests from Cohort Discovery whose cohort includes {name}. A request names its patients only once it is approved.
        </span>
        <span className="src ml-auto">
          <span className="swatch sw-documents" />
          Cohort_Requests · crc.COHORT_REQUEST, crc.QT_PATIENT_SET_COLLECTION · Silver_OMOP · i2b2_patient_mapping
        </span>
      </div>
      {b.cohorts.length === 0 ? (
        <p className="t-faint text-[13px]">{name} is in no approved or delivered data request.</p>
      ) : (
        <div className="cohort-list">
          {b.cohorts.map((c) => {
            const qm = num(c.query_master_id)!;
            const sent = delivery(c);
            return (
              <article key={qm} className="cohort-item">
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <h3 className="text-[17px] font-medium">{str(c.title) ?? `Request ${qm}`}</h3>
                  <span className="t-faint num text-[12.5px]">request {qm}</span>
                  <span className={`cohort-status${str(c.status) === 'DELIVERED' ? ' on' : ''}`}>{STATUS[str(c.status) ?? ''] ?? str(c.status)}</span>
                </div>
                {str(c.question) && <p className="cohort-q">{str(c.question)}</p>}
                <dl className="kv kv-tight mt-3 text-[13px]">
                  <dt>Cohort</dt>
                  <dd>{fmtInt(num(c.patients))} patients</dd>
                  <dt>Requested</dt>
                  <dd>
                    {fmtDate(str(c.requested_at))}
                    {str(c.requested_by) ? `, by ${str(c.requested_by)}` : ''}
                  </dd>
                  <dt>Approved</dt>
                  <dd>
                    {fmtDate(str(c.decided_at))}
                    {str(c.decided_by) ? `, by ${str(c.decided_by)}` : ''}
                  </dd>
                  {sent && (
                    <>
                      <dt>Delivered</dt>
                      <dd>{sent}</dd>
                      {str(c.delivery_lakehouse) && (
                        <>
                          <dt>Lakehouse</dt>
                          <dd className="mono text-[12px]">{str(c.delivery_lakehouse)}</dd>
                        </>
                      )}
                    </>
                  )}
                </dl>
                {str(c.summary) && <pre className="cohort-query">{str(c.summary)}</pre>}
                <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
                  <button
                    className="link"
                    onClick={() => {
                      setSearch({ request: qm });
                      navigate('/');
                    }}
                  >
                    Show the cohort's patients
                  </button>
                  {approvalUrl && (
                    <a className="link" href={`${approvalUrl}/#/requests/${qm}`} target="_blank" rel="noreferrer">
                      Open the request in the approval app
                    </a>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
