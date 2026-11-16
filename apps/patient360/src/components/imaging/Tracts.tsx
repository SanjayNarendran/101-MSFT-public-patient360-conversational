import { useMemo, useState } from 'react';

import { PanelRow, PanelSection } from './Details';
import { formatMb, type Locator, type TractBundle, type TractVolume, type VolumeStudy } from './types';
import type { FocusVolume, TractSettings } from './VolumeViewer';

export type TractColour = TractSettings['colour'];

/** Where Ask (or a link) opens a tractography atlas: the bundles drawn, their colour, the map on the slices. */
export type TractStart = { bundles?: string[]; colour?: TractColour; map?: string };

export const bundleLabel = (b: TractBundle) => (b.side ? `${b.name}, ${b.side}` : b.name);
const pct = (share: number) => `${Math.round(share * 100)}%`;
const mm = (v: number) => `${v < 0 ? '−' : '+'}${Math.abs(v)}`;
const fmtInt = (n: number) => n.toLocaleString('en-US');

/** The bundles' state in a workspace: which are drawn, how they are coloured, whose facts are open, which map is on. */
export function useTracts(study: VolumeStudy, start?: TractStart) {
  const bundles = useMemo(() => study.bundles ?? [], [study]);
  const startHidden = () => (start?.bundles?.length ? bundles.filter((b) => !start.bundles!.includes(b.id)).map((b) => b.id) : []);
  const [hidden, setHidden] = useState<string[]>(startHidden);
  const [colour, setColour] = useState<TractColour>(start?.colour ?? 'direction');
  const [selected, setSelected] = useState<string | null>(start?.map?.replace(/^(CC)_.*/, '$1') ?? start?.bundles?.[0] ?? null);
  const [map, setMap] = useState<string | null>(start?.map ?? null);

  const settings = useMemo<TractSettings>(() => ({ hidden, colour }), [hidden, colour]);
  const focus = useMemo<FocusVolume | null>(() => {
    if (!map) return null;
    const b = bundles.find((x) => x.id === map);
    if (b)
      return b.prob
        ? { file: b.prob, kind: 'prob', colour: b.colour, centreMm: b.centreMm }
        : b.mask
          ? { file: b.mask, kind: 'mask', colour: b.colour, centreMm: b.centreMm }
          : null;
    for (const x of bundles) {
      const part = x.parts?.find((p) => p.id === map);
      if (part?.prob) return { file: part.prob, kind: 'prob', colour: x.colour, centreMm: x.centreMm };
    }
    return null;
  }, [map, bundles]);

  return {
    bundles,
    hidden,
    colour,
    setColour,
    selected,
    setSelected,
    map,
    setMap,
    settings,
    focus,
    shown: bundles.filter((b) => !hidden.includes(b.id)),
    toggle: (id: string, on: boolean) => setHidden((h) => (on ? h.filter((x) => x !== id) : [...new Set([...h, id])])),
    /** Draws only these bundles. */
    only: (ids: string[]) => setHidden(bundles.filter((b) => !ids.includes(b.id)).map((b) => b.id)),
    setGroup: (group: string, on: boolean) =>
      setHidden((h) => {
        const ids = bundles.filter((b) => b.group === group).map((b) => b.id);
        return on ? h.filter((x) => !ids.includes(x)) : [...new Set([...h, ...ids])];
      }),
    showAll: () => setHidden([]),
    reset: (s?: TractStart) => {
      setHidden(s?.bundles?.length ? bundles.filter((b) => !s.bundles!.includes(b.id)).map((b) => b.id) : []);
      setColour(s?.colour ?? 'direction');
      setSelected(s?.bundles?.[0] ?? null);
      setMap(s?.map ?? null);
    },
  };
}

export type Tracts = ReturnType<typeof useTracts>;

function volumeLine(v: TractVolume) {
  return `${v.medianMl} mL median (${v.p25Ml} to ${v.p75Ml} mL for the middle half of people, ${v.minMl} to ${v.maxMl} mL overall)`;
}

/** What the atlas's data says about one bundle. */
function BundleFacts({
  study,
  b,
  t,
  files,
  sliceView,
  onSlices,
  onShowBase,
}: {
  study: VolumeStudy;
  b: TractBundle;
  t: Tracts;
  files: Locator;
  sliceView: boolean;
  onSlices: () => void;
  onShowBase: () => void;
}) {
  const group = study.layers.find((l) => l.id === b.group)?.label ?? b.group;
  const names = study.areaNames ?? {};
  const floor = study.floorMm;
  const pair = t.bundles.find((x) => x.abbr === b.abbr && x.id !== b.id);
  const mapOn = t.map === b.id;
  const mapKind = b.prob ? 'probability map' : 'volume';
  const figure = b.figure ? study.figures?.find((f) => f.file === b.figure) : undefined;
  return (
    <div>
      <div className="flex items-start gap-2">
        <span className="swatch mt-[5px]" style={{ background: b.colour }} />
        <div className="min-w-0">
          <div className="text-[14px] font-medium leading-snug">{bundleLabel(b)}</div>
          {b.otherNames && <div className="t-faint text-[11.5px]">Also called {b.otherNames}</div>}
        </div>
      </div>
      <dl className="mt-3">
        <PanelRow term="Group">{group}</PanelRow>
        <PanelRow term="Lines">
          {fmtInt(b.lines)} drawn of {fmtInt(b.atlasLines)} in the atlas
        </PanelRow>
        <PanelRow term="Length">{b.lengthMm} mm, median line</PanelRow>
        <PanelRow term="Reach">
          z {mm(b.zMm[0])} to {mm(b.zMm[1])} mm
          {floor !== undefined && b.zMm[0] <= floor + 1 && (
            <span className="t-faint block text-[11.5px]">Down to the atlas's lowest point, in the lower brainstem; below it lies the spinal cord.</span>
          )}
        </PanelRow>
        {b.volume && (
          <PanelRow term="Volume">
            {volumeLine(b.volume)}
            <span className="t-faint block text-[11.5px]">
              Found in {fmtInt(b.volume.people)} of {fmtInt(b.volume.of)} people
            </span>
          </PanelRow>
        )}
      </dl>

      {b.cortex && b.cortex.length > 0 && (
        <div className="mt-3">
          <div className="t-faint text-[11.5px]">Cortical areas it reaches, and in what share of people</div>
          <ul className="mt-1.5 space-y-1.5">
            {b.cortex.slice(0, 10).map((c) => (
              <li key={c.area} className="text-[12px]">
                <div className="flex items-baseline gap-2">
                  <span className="mono w-[62px] shrink-0 text-[11px]">{c.area}</span>
                  <span className="t-muted min-w-0 flex-1 truncate" title={names[c.area]}>
                    {names[c.area] ?? ''}
                  </span>
                  <span className="num shrink-0">{pct(c.share)}</span>
                </div>
                <span className="bar mt-0.5">
                  <span style={{ width: pct(c.share), background: 'var(--ink-3)' }} />
                </span>
              </li>
            ))}
          </ul>
          {b.mmp && b.mmp.length > 0 && (
            <p className="t-faint mt-2 text-[11.5px]">
              HCP-MMP areas: <span className="mono">{b.mmp.map((m) => m.area).join(', ')}</span>
            </p>
          )}
        </div>
      )}
      {b.cortex && b.cortex.length === 0 && <p className="t-faint mt-3 text-[11.5px]">It reaches no cortical area in a fifth of people or more.</p>}

      {b.parts && (
        <div className="mt-3">
          <div className="t-faint text-[11.5px]">Its parts, with their volume across people</div>
          <ul className="mt-1.5 space-y-1">
            {b.parts.map((p) => (
              <li key={p.id} className="flex items-baseline gap-2 text-[12px]">
                <span className="min-w-0 flex-1">{p.name}</span>
                {p.volume && <span className="num t-muted">{p.volume.medianMl} mL</span>}
                {p.prob && (
                  <button
                    type="button"
                    className="link text-[11.5px]"
                    aria-pressed={t.map === p.id}
                    onClick={() => {
                      t.setMap(t.map === p.id ? null : p.id);
                      if (t.map !== p.id && sliceView) onShowBase();
                    }}
                  >
                    {t.map === p.id ? 'Map off' : 'Map'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="btn" onClick={() => t.only([b.id])}>
          Show only this
        </button>
        {pair && (
          <button type="button" className="btn" onClick={() => t.only([b.id, pair.id])}>
            Both sides
          </button>
        )}
      </div>
      {(b.prob || b.mask) && (
        <label className="mt-3 flex items-start gap-2 text-[12.5px]">
          <input
            type="checkbox"
            className="check mt-[2px]"
            checked={mapOn}
            onChange={(e) => {
              t.setMap(e.target.checked ? b.id : null);
              if (e.target.checked && sliceView) onShowBase();
            }}
          />
          <span>
            Its {mapKind} on the slices
            <span className="t-faint block text-[11.5px]">
              {b.prob
                ? 'How often the tract passes through each point, over the 1,065 people, from 5% (dark red) to 100% (yellow).'
                : 'Where the averaged bundle runs, in its colour.'}
              {mapOn && !sliceView && (
                <>
                  {' '}
                  <button type="button" className="link" onClick={onSlices}>
                    Open the slices
                  </button>
                </>
              )}
            </span>
          </span>
        </label>
      )}
      {figure && (
        <a href={files(figure.file)} target="_blank" rel="noreferrer" className="mt-4 block" title={`${figure.title}: the publisher's figure`}>
          <img src={files(figure.small)} alt={`${figure.title}, the publisher's figure`} className="hair w-full border" />
          <span className="t-faint mt-1 block text-[11.5px]">The publisher's figure of this tract's probability map ↗</span>
        </a>
      )}
    </div>
  );
}

/** The Bundles tab: every bundle by group with its switch, the colour, search, and the facts of the one picked. */
export function BundlesPanel({
  study,
  t,
  layerVisible,
  setLayerVisible,
  files,
  sliceView,
  onSlices,
  onShowBase,
  onPicked,
}: {
  study: VolumeStudy;
  t: Tracts;
  layerVisible: (id: string) => boolean;
  setLayerVisible: (id: string, on: boolean) => void;
  files: Locator;
  sliceView: boolean;
  /** Switch to the slices, with the template brain under the map. */
  onSlices: () => void;
  onShowBase: () => void;
  /** A bundle was picked: its facts are at the top of the tab. */
  onPicked: () => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string[]>(() => [...new Set(t.shown.length < t.bundles.length ? t.shown.map((b) => b.group) : [])]);
  const groups = study.layers.filter((l) => l.kind === 'tracts');
  const words = q.trim().toLowerCase();
  const match = (b: TractBundle) =>
    !words || [b.name, b.abbr, b.id, b.otherNames ?? '', b.side ?? ''].join(' ').toLowerCase().includes(words);
  const picked = t.bundles.find((b) => b.id === t.selected);
  const pick = (b: TractBundle) => {
    t.setSelected(b.id);
    if (!t.shown.some((x) => x.id === b.id)) t.toggle(b.id, true);
    if (!layerVisible(b.group)) setLayerVisible(b.group, true);
    onPicked();
  };
  return (
    <>
      {picked && (
        <PanelSection
          title="Bundle"
          aside={
            <button type="button" className="link text-[12px]" onClick={() => t.setSelected(null)}>
              Close
            </button>
          }
        >
          <BundleFacts study={study} b={picked} t={t} files={files} sliceView={sliceView} onSlices={onSlices} onShowBase={onShowBase} />
        </PanelSection>
      )}
      <PanelSection
        title="Fibre bundles"
        aside={
          <div className="seg" role="group" aria-label="Colour the lines by">
            {(['direction', 'bundle'] as const).map((c) => (
              <button key={c} aria-pressed={t.colour === c} onClick={() => t.setColour(c)} title={c === 'direction' ? 'Red left to right, green front to back, blue top to bottom' : 'One colour per bundle'}>
                {c === 'direction' ? 'Direction' : 'Bundle'}
              </button>
            ))}
          </div>
        }
      >
        <input className="field" placeholder="Find a bundle" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a bundle" />
        <div className="mt-2 flex items-baseline gap-3 text-[12px]">
          <span className="t-faint">
            {t.shown.length === t.bundles.length ? `All ${t.bundles.length} drawn` : `${t.shown.length} of ${t.bundles.length} drawn`}
          </span>
          {t.shown.length < t.bundles.length && (
            <button
              type="button"
              className="link ml-auto"
              onClick={() => {
                t.showAll();
                groups.forEach((g) => setLayerVisible(g.id, true));
              }}
            >
              Draw all
            </button>
          )}
        </div>
        <ul className="mt-3 space-y-2">
          {groups.map((g) => {
            const members = t.bundles.filter((b) => b.group === g.id).sort((a, b) => a.name.localeCompare(b.name) || (a.side ?? '').localeCompare(b.side ?? ''));
            const listed = members.filter(match);
            if (words && listed.length === 0) return null;
            const expanded = !!words || open.includes(g.id);
            const drawn = members.filter((b) => !t.hidden.includes(b.id)).length;
            const on = layerVisible(g.id);
            return (
              <li key={g.id}>
                <div className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    className="check"
                    checked={on && drawn === members.length}
                    ref={(el) => {
                      if (el) el.indeterminate = on && drawn > 0 && drawn < members.length;
                    }}
                    aria-label={`Draw ${g.label.toLowerCase()}`}
                    onChange={() => {
                      // A partly drawn group fills in; a fully drawn one is switched off.
                      if (on && drawn === members.length) setLayerVisible(g.id, false);
                      else {
                        t.setGroup(g.id, true);
                        setLayerVisible(g.id, true);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
                    aria-expanded={expanded}
                    onClick={() => setOpen((o) => (o.includes(g.id) ? o.filter((x) => x !== g.id) : [...o, g.id]))}
                  >
                    <span className="font-medium">{g.label}</span>
                    <span className="t-faint text-[11.5px]">
                      {drawn === members.length ? members.length : `${drawn} of ${members.length}`}
                    </span>
                    <span aria-hidden className="t-faint ml-auto text-[11px]">
                      {expanded ? '▴' : '▾'}
                    </span>
                  </button>
                </div>
                {expanded && (
                  <ul className="mt-1.5 space-y-0.5 pl-6">
                    {listed.map((b) => (
                      <li key={b.id} className={`bundle-row ${t.selected === b.id ? 'is-picked' : ''}`}>
                        <input
                          type="checkbox"
                          className="check"
                          checked={!t.hidden.includes(b.id)}
                          aria-label={`Draw ${bundleLabel(b)}`}
                          onChange={(e) => {
                            t.toggle(b.id, e.target.checked);
                            if (e.target.checked && !layerVisible(b.group)) setLayerVisible(b.group, true);
                          }}
                        />
                        {t.colour === 'bundle' && <span className="swatch" style={{ background: b.colour }} />}
                        <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => pick(b)} title={`${bundleLabel(b)} (${b.id})`}>
                          {b.name}
                          {b.side && <span className="t-faint"> · {b.side === 'left' ? 'L' : 'R'}</span>}
                        </button>
                        <button type="button" className="bundle-only link text-[11px]" onClick={() => (t.only([b.id]), pick(b))}>
                          Only
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </PanelSection>
    </>
  );
}

/** The bundles drawn, named on the image, when only a few are. */
export function BundleLegend({ t, onPick }: { t: Tracts; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(true);
  if (t.shown.length === 0 || t.shown.length === t.bundles.length || t.shown.length > 16) return null;
  if (!open)
    return (
      <button className="overlay-legend" onClick={() => setOpen(true)}>
        {t.shown.length} {t.shown.length === 1 ? 'bundle' : 'bundles'} drawn
        <span className="link pl-2">Show</span>
      </button>
    );
  return (
    <div className="overlay-legend">
      <div className="flex items-baseline gap-3">
        <span className="font-medium">Bundles drawn</span>
        <button className="link ml-auto" onClick={() => setOpen(false)}>
          Hide
        </button>
      </div>
      {t.shown.map((b) => (
        <div key={b.id} className="mt-1 flex items-center gap-1.5">
          {t.colour === 'bundle' && <span className="swatch" style={{ background: b.colour }} />}
          <button className="text-left" onClick={() => onPick(b.id)}>
            {bundleLabel(b)}
          </button>
        </div>
      ))}
    </div>
  );
}

/** About › the publisher's figures and the files downloaded from it. */
export function AtlasAbout({ study, files }: { study: VolumeStudy; files: Locator }) {
  return (
    <>
      {study.figures && study.figures.length > 0 && (
        <PanelSection title="The publisher's figures">
          <p className="t-faint mb-3 text-[11.5px]">Each tract's probability map drawn on the brain, left and right. They open full size.</p>
          <ul className="space-y-3">
            {study.figures.map((f) => (
              <li key={f.file}>
                <a href={files(f.file)} target="_blank" rel="noreferrer" className="block">
                  <img src={files(f.small)} alt={f.title} loading="lazy" className="hair w-full border" />
                  <span className="mt-1 block text-[12px]">{f.title}</span>
                </a>
              </li>
            ))}
          </ul>
        </PanelSection>
      )}
      {study.downloads && study.downloads.length > 0 && (
        <PanelSection title="Downloaded from the publisher">
          <ul className="space-y-2">
            {study.downloads.map((d) => (
              <li key={d.file} className="text-[12px]">
                <div className="flex items-baseline gap-2">
                  <a href={d.url} target="_blank" rel="noreferrer" className="link mono min-w-0 truncate text-[11px]" title={d.file}>
                    {d.file}
                  </a>
                  <span className="num t-faint ml-auto shrink-0 text-[11px]">{formatMb(d.bytes)}</span>
                </div>
                <div className="t-muted text-[11.5px]">{d.what}</div>
              </li>
            ))}
          </ul>
          <p className="t-faint mt-3 text-[11.5px]">Kept in Patient360/Files/raw/hcp1065.</p>
        </PanelSection>
      )}
    </>
  );
}
