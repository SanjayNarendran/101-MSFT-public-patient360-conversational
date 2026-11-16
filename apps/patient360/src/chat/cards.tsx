/**
 * The cards in Ask's answers. Scans, slides, X-rays, documents, genomes and single-patient timelines are the record's
 * own viewers; multi-patient timelines and result trends are drawn here in the same marks and colours; counts are
 * Vega-Lite with the app's theme (ink for the subject, grey for the rest, orange only for abnormal or worse).
 */
import * as d3 from 'd3';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { anchorDate, cohortMarks, type Card, type CohortMark, type Series } from '@/chat/tools';
import { ReportSection } from '@/components/patient/Clinical';
import { DocumentPanel } from '@/components/patient/EpicSections';
import { GenomicsSection } from '@/components/patient/Genomics';
import type { PageView } from '@/components/imaging/VolumeWorkspace';
import { PathologyPanel, RadiologyPanel, XrayPanel, type View } from '@/components/patient/Imaging';
import { ShowcasePanel } from '@/components/patient/Showcase';
import { buildModel, LifeTimeline } from '@/components/patient/Timeline';
import { useNotes } from '@/hooks/useNotes';
import { num, str, type PatientBundle, type PatientListRow, type Row } from '@/lib/api';
import { fmtDate, fmtInt, fmtNum } from '@/lib/format';

/** Patient colours for cards that compare patients: ink first, then the modality hues. */
const PATIENT_COLOURS = [
  'var(--ink)',
  'var(--c-rad)',
  'var(--c-path)',
  'var(--c-gen)',
  'var(--sys-meta)',
  'var(--sys-circ)',
  'var(--sys-mind)',
  'var(--sys-msk)',
];

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const recordLink = (id: string, tab?: string, item?: string | null) =>
  `/p/${id}${tab || item ? `?${[tab && `tab=${encodeURIComponent(tab)}`, item && `e=${encodeURIComponent(item)}`].filter(Boolean).join('&')}` : ''}`;

/* ================================================================== frame */

export function CardFrame({ card, source, footer, children }: { card: Card; source?: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <article className="ans-fig">
      <div className="card-head">
        <h3>{card.title}</h3>
        {'subtitle' in card && card.subtitle ? <p className="sub">{card.subtitle}</p> : null}
        {'note' in card && card.note ? <p className="sub">{card.note}</p> : null}
      </div>
      {children}
      {(source || footer) && (
        <div className="ans-fig-foot">
          {source && <p className="ans-src">{source}</p>}
          {footer}
        </div>
      )}
    </article>
  );
}

/** True inside a side-by-side card's column, where viewers are half as wide. */
const Compact = createContext(false);

const who = (b: PatientBundle) => `${str(b.patient.display_name)} · ${str(b.patient.patient_id)}`;

/* ================================================================== patients */

const online = (p: PatientListRow) => {
  const n = (v: unknown) => num(v as never) ?? 0;
  return (
    [
      n(p.ct_online) ? `CT${n(p.nodules) ? ` (${n(p.nodules)} ${n(p.nodules) === 1 ? 'nodule' : 'nodules'})` : ''}` : '',
      n(p.mr_online) ? 'MRI' : '',
      n(p.xray_online) ? 'X-ray' : '',
      n(p.slides_online) ? (n(p.slides_online) > 1 ? `${n(p.slides_online)} slides` : 'slide') : '',
      n(p.scanned_documents) ? `${n(p.scanned_documents)} scanned` : '',
      n(p.has_genome) ? 'genome' : '',
    ]
      .filter(Boolean)
      .join(' · ') || 'no images online'
  );
};

function PatientsCard({
  card,
  onAdd,
}: {
  card: Extract<Card, { kind: 'patients' }>;
  onAdd?: (rows: { id: string; name: string }[]) => void;
}) {
  const [added, setAdded] = useState(false);
  return (
    <CardFrame
      card={card}
      source="Patient 360 index, Epic (Clarity), the PACS database and the documents lakehouse"
      footer={
        onAdd && (
          <button
            className="btn"
            disabled={added}
            onClick={() => {
              onAdd(
                card.rows.map((p) => ({
                  id: str(p.patient_id)!,
                  name: str(p.display_name) ?? '',
                }))
              );
              setAdded(true);
            }}
          >
            {added ? 'Added to the conversation' : 'Add them to the conversation'}
          </button>
        )
      }
    >
      <div className="table-wrap">
        <table className="tbl text-[13px]">
          <thead>
            <tr>
              <th>Patient</th>
              <th>Cancers or why in the demo</th>
              <th>Online</th>
              <th className="text-right">Visits</th>
              <th className="text-right">Studies</th>
              <th className="text-right">Documents</th>
            </tr>
          </thead>
          <tbody>
            {card.rows.map((p) => (
              <tr key={str(p.patient_id)!}>
                <td className="align-top">
                  <Link to={recordLink(str(p.patient_id)!)} className="font-medium hover:underline">
                    {str(p.display_name)}
                  </Link>
                  <div className="mono t-faint">
                    {str(p.patient_id)} · {str(p.sex)}, {num(p.age)}
                    {str(p.death_date) ? ' · died' : ''}
                  </div>
                </td>
                <td className="align-top">
                  {str(p.demo_title) ?? str(p.cancers)?.split(';').slice(0, 2).join(';') ?? (
                    <span className="t-faint">No cancer recorded</span>
                  )}
                </td>
                <td className="align-top text-[12.5px]">{online(p)}</td>
                <td className="num text-right align-top">{fmtInt(num(p.visits))}</td>
                <td className="num text-right align-top">
                  {fmtInt(num(p.studies))}
                  <div className="t-faint text-[11.5px]">{fmtInt(num(p.studies_online))} online</div>
                </td>
                <td className="num text-right align-top">{fmtInt(num(p.documents))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CardFrame>
  );
}

/* ================================================================== timelines */

function SingleTimeline({ card }: { card: Extract<Card, { kind: 'timeline' }> }) {
  const b = card.bundles[0];
  const model = useMemo(() => buildModel(b), [b]);
  const [sel, setSel] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const mark = sel ? model.marks.find((m) => m.id === sel) : null;
  const lens = useMemo(() => new Set<never>(), []);
  return (
    <CardFrame
      card={card}
      source={`${who(b)} · ${b.source === 'epic' ? 'Epic (Clarity), the PACS and the documents lakehouse' : 'TCGA registry, genomics and imaging; primary care synthetic'}`}
      footer={
        <Link className="link t-muted text-[12.5px]" to={recordLink(str(b.patient.patient_id)!, undefined, sel)}>
          {mark ? 'Open this event in the record' : 'Open the record'}
        </Link>
      }
    >
      <div className="ans-timeline" style={{ height: collapsed ? 120 : 430 }}>
        <LifeTimeline
          model={model}
          selected={sel}
          onSelect={(id) => setSel(id)}
          lens={lens}
          orientation="top"
          onOrientation={() => undefined}
          collapsed={collapsed}
          onCollapsed={setCollapsed}
        />
      </div>
      {mark && (
        <p className="t-muted mt-2 text-[13px]">
          <span className="font-medium" style={{ color: 'var(--ink)' }}>
            {mark.title}
          </span>{' '}
          · {mark.lines.join(' · ')}
        </p>
      )}
    </CardFrame>
  );
}

const KIND_STYLE: Record<
  string,
  {
    colour: string;
    shape: 'diamond' | 'square' | 'bar' | 'tick' | 'dot' | 'cross';
    label: string;
  }
> = {
  diagnosis: { colour: 'var(--ink)', shape: 'diamond', label: 'Cancer course' },
  treatment: { colour: 'var(--ink-2)', shape: 'bar', label: 'Treatment' },
  study: { colour: 'var(--c-rad)', shape: 'square', label: 'Imaging' },
  slide: { colour: 'var(--c-path)', shape: 'square', label: 'Slide' },
  document: { colour: 'var(--ink-3)', shape: 'tick', label: 'Report' },
  visit: { colour: 'var(--ink-3)', shape: 'tick', label: 'Visit' },
  condition: { colour: 'var(--sys-other)', shape: 'dot', label: 'Condition' },
  medication: { colour: 'var(--sys-meta)', shape: 'dot', label: 'Medication' },
  procedure: { colour: 'var(--ink-2)', shape: 'tick', label: 'Procedure' },
  lab: { colour: 'var(--ink-3)', shape: 'dot', label: 'Lab result' },
  vital: { colour: 'var(--ink-3)', shape: 'dot', label: 'Measurement' },
  note: { colour: 'var(--accent)', shape: 'dot', label: 'Tumour board note' },
};

const YEAR_MS = 365.25 * 86_400_000;
const ALIGN_LABEL: Record<string, string> = {
  first_cancer: 'first cancer diagnosis',
  first_ct: 'first CT',
  first_slide: 'first slide',
  death: 'death',
};

function CohortTimeline({ card }: { card: Extract<Card, { kind: 'timeline' }> }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<{
    x: number;
    y: number;
    m: CohortMark;
    who: string;
  } | null>(null);
  const aligned = card.align !== 'calendar';
  const rows = useMemo(
    () =>
      card.bundles.map((b, i) => ({
        b,
        anchor: card.anchors[i] ?? anchorDate(b, card.align, card.match),
        marks: cohortMarks(b, card.kinds, card.from, card.to),
      })),
    [card]
  );
  const pos = (date: string, anchor: string | null) =>
    aligned && anchor ? (Date.parse(date) - Date.parse(anchor)) / YEAR_MS : Date.parse(date);
  const all = rows.flatMap((r) => r.marks.flatMap((m) => [pos(m.date, r.anchor), m.end ? pos(m.end, r.anchor) : pos(m.date, r.anchor)]));
  const lo = all.length ? Math.min(...all) : 0;
  const hi = all.length ? Math.max(...all) : 1;
  const pad = (hi - lo || (aligned ? 1 : YEAR_MS)) * 0.04;
  const G = {
    l: Math.min(200, Math.max(130, width * 0.2)),
    r: 14,
    t: 8,
    row: 34,
  };
  const plotW = Math.max(40, width - G.l - G.r);
  const x = aligned
    ? d3
        .scaleLinear()
        .domain([lo - pad, hi + pad])
        .range([0, plotW])
    : d3
        .scaleTime()
        .domain([new Date(lo - pad), new Date(hi + pad)])
        .range([0, plotW]);
  const X = (v: number) => (aligned ? (x as d3.ScaleLinear<number, number>)(v) : (x as d3.ScaleTime<number, number>)(new Date(v)));
  const ticks = aligned
    ? (x as d3.ScaleLinear<number, number>).ticks(Math.max(2, Math.floor(plotW / 80)))
    : (x as d3.ScaleTime<number, number>).ticks(Math.max(2, Math.floor(plotW / 80)));
  const h = G.t + rows.length * G.row + 30;
  const kindsShown = [...new Set(rows.flatMap((r) => r.marks.map((m) => m.kind)))];
  return (
    <CardFrame card={card} source="Each patient's record: Epic, the PACS and the documents lakehouse, or the TCGA registry">
      <div ref={ref} className="relative" onMouseLeave={() => setTip(null)}>
        {width > 0 && (
          <svg width={width} height={h} className="block" role="img" aria-label={card.title}>
            <g transform={`translate(${G.l},${G.t})`}>
              {ticks.map((t, i) => {
                const v = typeof t === 'number' ? t : (t as Date).getTime();
                return (
                  <g key={i} transform={`translate(${X(v)},0)`}>
                    <line y1={0} y2={rows.length * G.row} stroke="var(--line)" />
                    <text y={rows.length * G.row + 16} textAnchor="middle" fontSize={11} fill="var(--ink-3)">
                      {aligned ? (v === 0 ? '0' : `${v > 0 ? '+' : ''}${v} y`) : d3.utcFormat('%Y')(new Date(v))}
                    </text>
                  </g>
                );
              })}
              {aligned && lo - pad < 0 && hi + pad > 0 && (
                <g transform={`translate(${X(0)},0)`}>
                  <line y1={-4} y2={rows.length * G.row} stroke="var(--ink)" strokeDasharray="3 3" />
                </g>
              )}
              {rows.map((r, i) => {
                const y = i * G.row + G.row / 2;
                return (
                  <g key={str(r.b.patient.patient_id)!}>
                    <line x1={0} x2={plotW} y1={y} y2={y} stroke="var(--line)" strokeDasharray="1 3" />
                    {r.marks.map((m, k) => {
                      const st = KIND_STYLE[m.kind] ?? KIND_STYLE.visit;
                      const cx = X(pos(m.date, r.anchor));
                      const died = m.title === 'Died';
                      const enter = (e: React.MouseEvent) => {
                        const box = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect();
                        setTip({
                          x: e.clientX - box.left,
                          y: e.clientY - box.top,
                          m,
                          who: str(r.b.patient.display_name) ?? '',
                        });
                      };
                      const common = {
                        onMouseEnter: enter,
                        onMouseMove: enter,
                        style: { cursor: 'pointer' },
                      };
                      const go = m.item
                        ? recordLink(str(r.b.patient.patient_id)!, undefined, m.item)
                        : recordLink(str(r.b.patient.patient_id)!);
                      let shape: ReactNode;
                      if (died)
                        shape = (
                          <path
                            d={`M${cx - 5},${y - 5}L${cx + 5},${y + 5}M${cx + 5},${y - 5}L${cx - 5},${y + 5}`}
                            stroke="var(--c-alert)"
                            strokeWidth={2}
                          />
                        );
                      else if (st.shape === 'bar') {
                        const x2 = m.end ? X(pos(m.end, r.anchor)) : cx + 4;
                        shape = <rect x={cx} y={y - 4} width={Math.max(4, x2 - cx)} height={8} rx={1.5} fill={st.colour} opacity={0.85} />;
                      } else if (st.shape === 'diamond')
                        shape = <path d={`M${cx},${y - 7}L${cx + 7},${y}L${cx},${y + 7}L${cx - 7},${y}Z`} fill={st.colour} />;
                      else if (st.shape === 'square') shape = <rect x={cx - 4.5} y={y - 4.5} width={9} height={9} fill={st.colour} />;
                      else if (st.shape === 'tick')
                        shape = <line x1={cx} x2={cx} y1={y - 7} y2={y + 7} stroke={st.colour} strokeWidth={1.5} />;
                      else shape = <circle cx={cx} cy={y} r={3.5} fill={st.colour} />;
                      return (
                        <Link key={k} to={go} {...common}>
                          <rect x={cx - 7} y={y - 9} width={14} height={18} fill="transparent" />
                          {shape}
                        </Link>
                      );
                    })}
                  </g>
                );
              })}
            </g>
            {rows.map((r, i) => (
              <foreignObject key={i} x={0} y={G.t + i * G.row} width={G.l - 12} height={G.row}>
                <div className="flex h-full flex-col justify-center overflow-hidden text-[12.5px] leading-tight">
                  <Link to={recordLink(str(r.b.patient.patient_id)!)} className="truncate font-medium hover:underline">
                    {str(r.b.patient.display_name)}
                  </Link>
                  <span className="t-faint truncate text-[11px]">
                    {str(r.b.patient.patient_id)}
                    {aligned && r.anchor ? ` · 0 = ${fmtDate(r.anchor)}` : ''}
                  </span>
                </div>
              </foreignObject>
            ))}
          </svg>
        )}
        {tip && (
          <div
            className="tl-tip"
            style={{
              left: Math.min(tip.x + 12, width - 260),
              top: tip.y + 14,
              position: 'absolute',
              pointerEvents: 'none',
              maxWidth: 260,
            }}
          >
            <div className="font-medium">{tip.m.title}</div>
            <div className="t-faint">
              {tip.who} · {fmtDate(tip.m.date)}
              {tip.m.end ? ` to ${fmtDate(tip.m.end)}` : ''}
            </div>
            {tip.m.detail && <div className="t-muted mt-0.5">{tip.m.detail.slice(0, 160)}</div>}
          </div>
        )}
      </div>
      <div className="t-faint mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
        {aligned && (
          <span>
            Aligned on each patient's{' '}
            {card.align === 'first_cancer' && card.match ? `first ${card.match} cancer diagnosis` : (ALIGN_LABEL[card.align] ?? card.align)}
            : years before and after
          </span>
        )}
        {kindsShown.map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className="swatch" style={{ background: (KIND_STYLE[k] ?? KIND_STYLE.visit).colour }} />
            {(KIND_STYLE[k] ?? KIND_STYLE.visit).label}
          </span>
        ))}
      </div>
    </CardFrame>
  );
}

/* ================================================================== measurements */

function MeasurementsCard({ card }: { card: Extract<Card, { kind: 'measurements' }> }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{
    test: string;
    x: number;
    y: number;
    text: string;
  } | null>(null);
  const patients = [...new Map(card.series.map((s) => [s.patientId, s.name])).entries()];
  const colourOf = (id: string) => PATIENT_COLOURS[patients.findIndex(([p]) => p === id) % PATIENT_COLOURS.length];
  const cols = width > 760 && card.tests.length > 1 ? 2 : 1;
  const panelW = cols === 2 ? (width - 28) / 2 : width;
  const panelH = card.tests.length > 2 ? 190 : 230;
  const allDates = card.series.flatMap((s) => s.points.map((p) => Date.parse(p.date)));
  const marks = card.marks.map((m) => Date.parse(m));
  const t0 = Math.min(...allDates, ...(card.from ? [Date.parse(card.from)] : []), ...marks);
  const t1 = Math.max(...allDates, ...(card.to ? [Date.parse(card.to)] : []), ...marks);
  const M = { l: 44, r: 10, t: 8, b: 22 };
  return (
    <CardFrame
      card={card}
      source={`Lab results and vital signs from each record${patients.length > 1 ? '' : ` · ${patients[0]?.[1]} · ${patients[0]?.[0]}`}. The shaded band is a typical adult range, for orientation only.`}
    >
      {patients.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px]">
          {patients.map(([id, name]) => (
            <span key={id} className="flex items-center gap-1.5">
              <span className="inline-block h-[2px] w-4" style={{ background: colourOf(id) }} />
              {name} <span className="t-faint mono">{id}</span>
            </span>
          ))}
        </div>
      )}
      <div ref={ref} className="grid gap-x-7 gap-y-5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {width > 0 &&
          card.tests.map((test) => {
            const series = card.series.filter((s) => s.test === test);
            const vals = series.flatMap((s) => s.points.map((p) => p.value));
            const ref0 = series[0]?.ref;
            const lo = Math.min(...vals, ...(ref0 && ref0[0] > 0 ? [ref0[0]] : []));
            const hi = Math.max(...vals, ...(ref0 && ref0[1] < 150 ? [ref0[1]] : []));
            const x = d3
              .scaleTime()
              .domain([new Date(t0), new Date(t1)])
              .range([M.l, panelW - M.r]);
            const y = d3
              .scaleLinear()
              .domain([lo - (hi - lo) * 0.08 || lo - 1, hi + (hi - lo) * 0.08 || hi + 1])
              .nice()
              .range([panelH - M.b, M.t]);
            const line = d3
              .line<{ date: string; value: number }>()
              .x((p) => x(new Date(p.date)))
              .y((p) => y(p.value));
            const [d0, d1] = y.domain();
            const unit = series[0]?.unit;
            return (
              <div key={test} className="min-w-0">
                <div className="mb-1 flex items-baseline gap-2 text-[13px]">
                  <span className="font-medium">{test}</span>
                  {unit && <span className="t-faint text-[12px]">{unit}</span>}
                  {series.length === 1 && series[0].points.length > 0 && (
                    <span className="t-muted num ml-auto text-[12px]">
                      last {fmtNum(series[0].points[series[0].points.length - 1].value, 1)} ·{' '}
                      {fmtDate(series[0].points[series[0].points.length - 1].date)}
                    </span>
                  )}
                </div>
                <svg width={panelW} height={panelH} className="block overflow-visible" onMouseLeave={() => setHover(null)}>
                  {ref0 && (
                    <rect
                      x={M.l}
                      width={panelW - M.l - M.r}
                      y={y(Math.min(ref0[1], d1))}
                      height={Math.max(0, y(Math.max(ref0[0], d0)) - y(Math.min(ref0[1], d1)))}
                      fill="var(--surface)"
                    />
                  )}
                  {y.ticks(4).map((t) => (
                    <g key={t}>
                      <line x1={M.l} x2={panelW - M.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeDasharray="2 3" />
                      <text x={M.l - 6} y={y(t) + 3.5} textAnchor="end" fontSize={10.5} fill="var(--ink-3)">
                        {t}
                      </text>
                    </g>
                  ))}
                  {x.ticks(Math.max(2, Math.floor(panelW / 110))).map((t) => (
                    <text key={t.getTime()} x={x(t)} y={panelH - 6} textAnchor="middle" fontSize={10.5} fill="var(--ink-3)">
                      {d3.utcFormat(t1 - t0 > 3 * YEAR_MS ? '%Y' : '%b %Y')(t)}
                    </text>
                  ))}
                  {marks.map((m, i) => (
                    <g key={i}>
                      <line x1={x(new Date(m))} x2={x(new Date(m))} y1={M.t} y2={panelH - M.b} stroke="var(--ink)" strokeDasharray="3 3" />
                      {/* Dates on the first panel only, stepped down when they would collide */}
                      {test === card.tests[0] && (
                        <text
                          x={x(new Date(m)) + 4}
                          y={
                            M.t +
                            9 +
                            12 *
                              markRow(
                                marks.map((v) => x(new Date(v))),
                                i
                              )
                          }
                          fontSize={10.5}
                          fill="var(--ink-2)"
                          stroke="var(--bg)"
                          strokeWidth={3}
                          paintOrder="stroke"
                        >
                          {fmtDate(card.marks[i])}
                        </text>
                      )}
                    </g>
                  ))}
                  {series.map((s) => (
                    <g key={s.patientId}>
                      <path d={line(s.points) ?? ''} fill="none" stroke={colourOf(s.patientId)} strokeWidth={1.6} opacity={0.9} />
                      {s.points.map((p, i) => (
                        <circle
                          key={i}
                          cx={x(new Date(p.date))}
                          cy={y(p.value)}
                          r={p.flag ? 3 : 2.2}
                          fill={p.flag ? 'var(--accent)' : colourOf(s.patientId)}
                          onMouseEnter={() =>
                            setHover({
                              test,
                              x: x(new Date(p.date)),
                              y: y(p.value),
                              text: `${s.name}: ${fmtNum(p.value, 2)}${unit ? ` ${unit}` : ''} · ${fmtDate(p.date)}${p.flag ? ` · ${p.flag}` : ''}`,
                            })
                          }
                        />
                      ))}
                    </g>
                  ))}
                  {hover && hover.test === test && (
                    <g transform={`translate(${Math.min(hover.x, panelW - 200)},${Math.max(14, hover.y - 10)})`} pointerEvents="none">
                      <text fontSize={11.5} fill="var(--ink)" stroke="var(--bg)" strokeWidth={3} paintOrder="stroke">
                        {hover.text}
                      </text>
                    </g>
                  )}
                </svg>
              </div>
            );
          })}
      </div>
    </CardFrame>
  );
}

/** The row for a marked date's label, so labels closer than their width step down. */
function markRow(xs: number[], i: number): number {
  const order = xs.map((v, k) => [v, k] as const).sort((a, z) => a[0] - z[0]);
  const rows: number[] = [];
  const ends: number[] = [];
  for (const [v, k] of order) {
    let r = 0;
    while (ends[r] !== undefined && v < ends[r] + 6) r++;
    ends[r] = v + 74;
    rows[k] = r;
  }
  return rows[i] ?? 0;
}

/* ================================================================== images and documents */

const VIEW: Record<string, View> = {
  '3d': 'render',
  mpr: 'multiplanar',
  axial: 'axial',
  coronal: 'coronal',
};

function ScanCard({ card }: { card: Extract<Card, { kind: 'scan' }> }) {
  const b = card.bundle;
  const compact = useContext(Compact);
  // Four panes at half width are too small to read: a column opens on the one slice centred on the nodule.
  const view = compact && card.view === 'mpr' ? 'axial' : card.view;
  const list = useMemo(() => b.radiologySeries.filter((s) => s.volume_path), [b]);
  const [key, setKey] = useState(card.seriesKey);
  const s = list.find((x) => x.series_key === key);
  return (
    <CardFrame
      card={card}
      source={who(b)}
      footer={
        <Link
          className="link t-muted text-[12.5px]"
          to={recordLink(str(b.patient.patient_id)!, 'radiology', s ? `r:${str(s.study_uid)}` : null)}
        >
          Open in the record
        </Link>
      }
    >
      <RadiologyPanel
        b={b}
        list={list}
        seriesKey={key}
        onSeries={setKey}
        stepper={false}
        startView={VIEW[view]}
        startNodule={card.nodule}
        height="clamp(480px, 62vh, 640px)"
        compact={compact}
        folded
      />
    </CardFrame>
  );
}

function SlideCard({ card }: { card: Extract<Card, { kind: 'slide' }> }) {
  const b = card.bundle;
  const compact = useContext(Compact);
  const [id, setId] = useState(card.slideId);
  const slide = b.slides.find((s) => s.slide_id === id) ?? b.slides[0];
  return (
    <CardFrame
      card={card}
      source={who(b)}
      footer={
        <Link className="link t-muted text-[12.5px]" to={recordLink(str(b.patient.patient_id)!, 'pathology')}>
          Open in the record
        </Link>
      }
    >
      <PathologyPanel
        b={b}
        slide={slide}
        slides={b.slides}
        onSlide={setId}
        access={b.access.slide}
        height="clamp(480px, 62vh, 640px)"
        compact={compact}
        folded
        startOverlays={card.overlays ?? undefined}
        startReport={!!card.report}
      />
    </CardFrame>
  );
}

/** A study from the imaging demo on a demo patient's record, opened the way the question asked. */
function ShowcaseCard({ card }: { card: Extract<Card, { kind: 'showcase' }> }) {
  const b = card.bundle;
  const compact = useContext(Compact);
  const row = (b.showcase ?? []).find((r) => r.study_id === card.studyId);
  return (
    <CardFrame
      card={card}
      source={who(b)}
      footer={
        <Link
          className="link t-muted text-[12.5px]"
          to={recordLink(str(b.patient.patient_id)!, row?.section === 'radiology' ? 'radiology' : 'pathology', `sc:${card.studyId}`)}
        >
          Open in the record
        </Link>
      }
    >
      {row ? (
        <ShowcasePanel
          b={b}
          row={row}
          compact={compact}
          folded
          height="clamp(480px, 62vh, 640px)"
          startView={(card.view ?? undefined) as PageView | undefined}
          startFrame={card.frame ?? undefined}
          startLayers={card.layers ?? undefined}
          startTracts={card.tracts ?? undefined}
          startFull={!!card.full}
          startOverlays={card.overlays ?? undefined}
          startChannels={card.channels ?? undefined}
          startReport={!!card.report}
        />
      ) : (
        <p className="t-faint text-[13px]">This study is no longer on the record.</p>
      )}
    </CardFrame>
  );
}

function XrayCard({ card }: { card: Extract<Card, { kind: 'xray' }> }) {
  const b = card.bundle;
  return (
    <CardFrame
      card={card}
      source={who(b)}
      footer={
        <Link
          className="link t-muted text-[12.5px]"
          to={recordLink(str(b.patient.patient_id)!, 'radiology', `r:${str(card.series.study_uid)}`)}
        >
          Open in the record
        </Link>
      }
    >
      <XrayPanel series={card.series} access={b.access.radiology} height="clamp(440px, 58vh, 620px)" />
    </CardFrame>
  );
}

function DocumentCard({ card }: { card: Extract<Card, { kind: 'document' }> }) {
  const b = card.bundle;
  return (
    <CardFrame
      card={card}
      source={who(b)}
      footer={
        <Link
          className="link t-muted text-[12.5px]"
          to={recordLink(
            str(b.patient.patient_id)!,
            card.doc ? 'documents' : 'report',
            card.doc ? `d:${str(card.doc.document_id)}` : 'report'
          )}
        >
          Open in the record
        </Link>
      }
    >
      <div className="ans-doc">{card.doc ? <DocumentPanel b={b} doc={card.doc as Row} /> : <ReportSection b={b} />}</div>
    </CardFrame>
  );
}

function GenomeCard({ card }: { card: Extract<Card, { kind: 'genome' }> }) {
  const b = card.bundle;
  return (
    <CardFrame
      card={card}
      source={`${who(b)} · TCGA sequencing (cBioPortal PanCancer Atlas)`}
      footer={
        <Link className="link t-muted text-[12.5px]" to={recordLink(str(b.patient.patient_id)!, 'genomics')}>
          Open in the record
        </Link>
      }
    >
      <GenomicsSection b={b} genome={b.genomes.find((g) => g.barcode === card.genome)} />
    </CardFrame>
  );
}

/* ================================================================== charts */

function vegaTheme() {
  const font = cssVar('--font');
  const ink = cssVar('--ink');
  const ink2 = cssVar('--ink-2');
  const ink3 = cssVar('--ink-3');
  const line = cssVar('--line');
  const accent = cssVar('--accent');
  const cat = [
    ink,
    cssVar('--c-rad'),
    cssVar('--c-path'),
    cssVar('--c-gen'),
    cssVar('--sys-meta'),
    cssVar('--sys-circ'),
    cssVar('--sys-mind'),
    cssVar('--sys-msk'),
  ];
  return {
    background: null,
    font,
    padding: 4,
    view: { stroke: null },
    title: {
      font,
      fontSize: 14,
      fontWeight: 500,
      color: ink,
      anchor: 'start',
      subtitleColor: ink3,
      subtitleFont: font,
    },
    axisQuantitative: { tickCount: 6 },
    axisXDiscrete: { labelAngle: 0, labelLimit: 160 },
    axis: {
      labelColor: ink3,
      titleColor: ink3,
      domainColor: line,
      tickColor: line,
      gridColor: line,
      labelFontSize: 10.5,
      titleFontSize: 11,
      titleFontWeight: 400,
      labelFont: font,
      titleFont: font,
    },
    legend: {
      labelColor: ink2,
      titleColor: ink3,
      labelFontSize: 11,
      titleFontSize: 11,
      titleFontWeight: 400,
      labelFont: font,
      titleFont: font,
    },
    header: {
      labelColor: ink2,
      titleColor: ink2,
      labelFontSize: 12,
      labelFontWeight: 500,
      labelFont: font,
      titleFont: font,
    },
    range: {
      category: cat,
      ramp: [line, ink2],
      heatmap: [line, ink2],
      diverging: [cssVar('--c-good'), line, accent],
    },
    mark: { color: ink2, tooltip: true },
    bar: { color: ink2 },
    line: { color: ink2, strokeWidth: 2 },
    point: { color: ink2, filled: true, size: 40 },
    area: { color: ink2, opacity: 0.2 },
    rule: { color: ink3 },
    text: { color: ink, font },
  };
}

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) if (k !== 'href' && !(k === 'url' && typeof v === 'string')) out[k] = strip(v);
  return out;
}

function ChartCard({ card }: { card: Extract<Card, { kind: 'chart' }> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme);
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(document.documentElement.dataset.theme));
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => mo.disconnect();
  }, []);
  useEffect(() => {
    let view: { finalize: () => void } | null = null;
    let off = false;
    void (async () => {
      try {
        const { default: embed } = await import('vega-embed');
        if (off || !ref.current) return;
        const spec = strip(card.spec) as Record<string, unknown>;
        const composite = ['facet', 'repeat', 'concat', 'hconcat', 'vconcat'].some((k) => k in spec);
        if (!composite && (spec.width == null || typeof spec.width === 'number')) {
          spec.width = 'container';
          spec.autosize = spec.autosize ?? {
            type: 'fit-x',
            contains: 'padding',
          };
        }
        spec.data = { values: card.rows };
        spec.config = { ...vegaTheme(), ...((spec.config as object) ?? {}) };
        delete spec.title;
        const res = await embed(ref.current, spec as never, {
          actions: false,
          renderer: 'svg',
          mode: 'vega-lite',
        });
        view = res.view;
      } catch (e) {
        if (!off) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      off = true;
      view?.finalize();
    };
  }, [card, theme]);
  return (
    <CardFrame card={card} source="Counted from the Bronze sources: Epic (Clarity), the PACS database and the documents lakehouse">
      {error ? (
        <p className="text-[13px]" style={{ color: 'var(--c-alert)' }}>
          The chart could not be drawn: {error}
        </p>
      ) : (
        <div ref={ref} className="w-full" />
      )}
    </CardFrame>
  );
}

/* ================================================================== links and notes */

const TAB_NAME: Record<string, string> = {
  summary: 'Summary',
  visits: 'Visits',
  measurements: 'Measurements',
  conditions: 'Conditions',
  medicines: 'Medications',
  cancer: 'Cancer course',
  treatment: 'Treatment',
  radiology: 'Radiology',
  pathology: 'Pathology',
  documents: 'Documents',
  report: 'Report',
  genomics: 'Genomics',
  notes: 'Tumour board',
};

function RecordCard({ card }: { card: Extract<Card, { kind: 'record' }> }) {
  return (
    <article className="ans-fig ans-link">
      <Link to={recordLink(card.patientId, card.tab, card.item)} className="ans-link-row">
        <span>
          <span className="block text-[15px] font-medium">{card.title}</span>
          <span className="t-faint text-[12.5px]">
            {card.name} · {card.patientId} · {TAB_NAME[card.tab] ?? card.tab}
          </span>
        </span>
        <span aria-hidden className="ans-link-go">
          Open the record
        </span>
      </Link>
    </article>
  );
}

function NoteCard({ card }: { card: Extract<Card, { kind: 'note' }> }) {
  const notes = useNotes(card.patientId);
  const [state, setState] = useState<'draft' | 'saving' | 'added'>('draft');
  return (
    <CardFrame
      card={card}
      source={`Draft for ${card.name} · ${card.patientId}. Written by Copilot from the record; nothing is saved until you add it.`}
      footer={
        <span className="flex items-center gap-3">
          {state === 'added' ? (
            <Link className="link t-muted text-[12.5px]" to={recordLink(card.patientId, 'notes')}>
              Added. Open the tumour board notes
            </Link>
          ) : (
            <button
              className="btn btn-ink"
              disabled={state === 'saving'}
              onClick={async () => {
                setState('saving');
                const n = await notes.add(card.text, card.about ?? undefined);
                setState(n ? 'added' : 'draft');
              }}
            >
              {state === 'saving' ? 'Adding' : 'Add to the record'}
            </button>
          )}
        </span>
      }
    >
      <blockquote className="ans-note-draft">{card.text}</blockquote>
      {notes.error && (
        <p className="mt-2 text-[12.5px]" style={{ color: 'var(--c-alert)' }}>
          {notes.error}
        </p>
      )}
    </CardFrame>
  );
}

/* ================================================================== side by side */

/** Two to four views in columns, each the card its own tool draws, with the facts that differ in a table under them.
 * Narrow containers (the side panel) stack the columns. */
function SideCard({ card }: { card: Extract<Card, { kind: 'side' }> }) {
  return (
    <article className="ans-fig side-fig">
      <div className="card-head">
        <h3>{card.title}</h3>
        {card.subtitle ? <p className="sub">{card.subtitle}</p> : null}
      </div>
      <div className="side-wrap">
        <div className="side-grid" data-n={card.panes.length}>
          {card.panes.map((p, i) => (
            <div className="side-pane" key={i}>
              <Compact.Provider value={true}>
                <CardView card={p.card} />
              </Compact.Provider>
              {p.note ? <p className="side-note">{p.note}</p> : null}
            </div>
          ))}
        </div>
        {card.facts?.length ? (
          <div className="table-wrap side-facts">
            <table className="tbl text-[13px]">
              <thead>
                <tr>
                  <th />
                  {card.panes.map((p, i) => (
                    <th key={i}>{p.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {card.facts.map((f, i) => (
                  <tr key={i}>
                    <th scope="row">{f.label}</th>
                    {f.values.map((v, j) => (
                      <td key={j}>{v}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </article>
  );
}

/* ================================================================== dispatch */

export function CardView({ card, onAddPatients }: { card: Card; onAddPatients?: (rows: { id: string; name: string }[]) => void }) {
  switch (card.kind) {
    case 'patients':
      return <PatientsCard card={card} onAdd={onAddPatients} />;
    case 'timeline':
      return card.bundles.length > 1 ? <CohortTimeline card={card} /> : <SingleTimeline card={card} />;
    case 'measurements':
      return <MeasurementsCard card={card} />;
    case 'scan':
      return <ScanCard card={card} />;
    case 'slide':
      return <SlideCard card={card} />;
    case 'xray':
      return <XrayCard card={card} />;
    case 'showcase':
      return <ShowcaseCard card={card} />;
    case 'document':
      return <DocumentCard card={card} />;
    case 'genome':
      return <GenomeCard card={card} />;
    case 'chart':
      return <ChartCard card={card} />;
    case 'side':
      return <SideCard card={card} />;
    case 'record':
      return <RecordCard card={card} />;
    case 'note':
      return <NoteCard card={card} />;
  }
}

export type { Series };
