import { useEffect, useState } from 'react';

type Row = { BREAKDOWN: string; CATEGORY: string; PATIENTS: number };

const TITLES: Record<string, string> = {
  'Age patient breakdown': 'Age',
  'Gender patient breakdown': 'Gender',
  'Race patient breakdown': 'Race',
  'Vital Status patient breakdown': 'Vital status',
};

/** One small bar chart per i2b2 breakdown (obfuscated counts). Bars grow in after mount. */
export function Breakdown({ rows }: { rows: Row[] }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(t);
  }, []);
  const order = Object.keys(TITLES);
  const groups = new Map<string, Row[]>();
  for (const r of [...rows].sort((a, b) => order.indexOf(a.BREAKDOWN) - order.indexOf(b.BREAKDOWN))) {
    groups.set(r.BREAKDOWN, [...(groups.get(r.BREAKDOWN) ?? []), r]);
  }
  if (groups.size === 0) return <p className="muted">No breakdowns were recorded for this query.</p>;
  return (
    <div className="bars-grid">
      {[...groups.entries()].map(([name, items]) => {
        const max = Math.max(1, ...items.map((r) => Number(r.PATIENTS) || 0));
        return (
          <div key={name}>
            <h3 className="h3">{TITLES[name] ?? name}</h3>
            <div className="bars">
              {items.map((r) => {
                const n = Number(r.PATIENTS) || 0;
                return (
                  <div key={r.CATEGORY} style={{ display: 'contents' }}>
                    <span className="bar-label" title={r.CATEGORY}>{r.CATEGORY}</span>
                    <span className="bar-track">
                      <span className="bar-fill" style={{ display: 'block', width: shown ? `${(n / max) * 100}%` : 0 }} />
                    </span>
                    <span className={`bar-value${n === 0 ? ' zero' : ''}`}>{n}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
