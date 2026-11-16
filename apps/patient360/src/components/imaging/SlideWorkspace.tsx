import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { DetailsPanel, PanelRow, PanelSection, useDetailsPanel } from './Details';
import { markerNote, slideNote, TIPS } from './guide';
import { AiButtons, AiLayerControls } from './pathology/AiLayers';
import { CaseBanner } from './pathology/CaseBanner';
import { CasePanel } from './pathology/CasePanel';
import { ReportPane } from './pathology/ReportPane';
import { SlideTray, type TrayItem } from './pathology/SlideTray';
import { PlainWords } from './PlainWords';
import { SlideViewer, type SlideViewerHandle, type SyncView, type ViewerStatus, type ViewerSlide, type ViewState } from './SlideViewer';
import type { CaseImage, CaseInfo, Channel, Locator } from './types';
import { CASE_PREF_LABELS, useCasePrefs, useOverlayDisplay } from './useCasePrefs';
import { useMaximise } from './useMaximise';

/** One slide the workspace can show: the viewer's description of it, where its files are, and what to say about it. */
export type SlideImage = TrayItem & {
  slide: ViewerSlide;
  files: Locator;
  /** The TCGA case the slide comes from, when its catalog has one (banner and Case tab). */
  caseInfo?: CaseInfo | null;
  caseImage?: CaseImage | null;
  report?: { url: string; title: string; sourceUrl?: string | null } | null;
  about: {
    title: string;
    specimen?: string | null;
    project?: string | null;
    case?: string | null;
    scanner?: string | null;
    source?: string | null;
    sourceUrl?: string | null;
    license?: string | null;
    /** Lakehouse and folder the viewer reads, and where the original is. */
    item: string;
    served: string;
    original?: string | null;
  };
};

const NICE_UM = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

function ScaleBar({ umPerPixel }: { umPerPixel: number | null }) {
  if (!umPerPixel) return null;
  const um = [...NICE_UM].reverse().find((n) => n <= 110 * umPerPixel) ?? NICE_UM[0];
  return (
    <span className="flex items-center gap-2">
      <span className="scalebar inline-block" style={{ width: um / umPerPixel }} />
      <span>{um >= 1000 ? `${um / 1000} mm` : `${um} µm`}</span>
    </span>
  );
}

const formatMag = (mag: number) => `${mag < 10 ? mag.toFixed(1) : mag.toFixed(0)}×`;
const markerLabel = (name: string) => name.replace('Aortic smooth muscle actin', 'SMA').replace('Antigen Ki67', 'Ki-67');

const MARKER_GROUPS: { id: NonNullable<Channel['group']>; title: string; intro?: string }[] = [
  { id: 'featured', title: 'Key markers', intro: 'Also shown as chips above the slide.' },
  { id: 'protein', title: 'More proteins' },
  { id: 'reference', title: 'Reference channels', intro: 'The DNA stain repeated in every imaging round, used to line the rounds up, and background-only controls.' },
];
const channelGroup = (c: Channel): NonNullable<Channel['group']> => c.group ?? 'featured';
function channelHint(c: Channel): string {
  const note = markerNote(c.id, c.name);
  return note ? `${note.shows} ${note.why}`.trim() : c.meaning;
}

/** Every marker channel, grouped, with what each one shows in plain words and its on-screen colour. */
function MarkerControls({
  channels,
  visible,
  onToggle,
  onSet,
  onReset,
}: {
  channels: Channel[];
  visible: Record<string, boolean>;
  onToggle: (id: string) => void;
  onSet: (ids: string[], on: boolean) => void;
  onReset: () => void;
}) {
  const shown = channels.filter((c) => visible[c.id]).length;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
        <span className="t-faint">{shown} shown</span>
        <button type="button" className="link t-muted" title="Switch every channel off" onClick={() => onSet(channels.map((c) => c.id), false)}>
          Hide all
        </button>
        <button type="button" className="link t-muted" title={TIPS.markersReset} onClick={onReset}>
          Reset
        </button>
      </div>
      {MARKER_GROUPS.map((g) => {
        const items = channels.filter((c) => channelGroup(c) === g.id);
        if (!items.length) return null;
        const ids = items.map((c) => c.id);
        return (
          <div key={g.id} className="mb-6 last:mb-0">
            <div className="mb-2 flex items-baseline gap-3 text-[12px]">
              <span className="font-medium" style={{ color: 'var(--ink)' }}>
                {g.title} ({items.length})
              </span>
              <button type="button" className="link t-muted ml-auto" onClick={() => onSet(ids, true)}>
                show
              </button>
              <button type="button" className="link t-muted" onClick={() => onSet(ids, false)}>
                hide
              </button>
            </div>
            {g.intro && <p className="t-faint mb-2 text-[11.5px] leading-snug">{g.intro}</p>}
            <ul className="space-y-3">
              {items.map((c) => {
                const note = markerNote(c.id, c.name);
                return (
                  <li key={c.id}>
                    <label className="flex items-center gap-2 text-[13px]">
                      <input type="checkbox" className="check" checked={!!visible[c.id]} onChange={() => onToggle(c.id)} />
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c.color }} />
                      <span className="font-medium">{note?.name && channelGroup(c) !== 'featured' ? note.name : markerLabel(c.name)}</span>
                    </label>
                    <p className="t-faint mt-1 pl-6 text-[11.5px] leading-snug">{channelHint(c)}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </>
  );
}

/** A slide position shared in the address (x, y and image zoom), from Copy link. */
function linkedView(): ViewState | null {
  const p = new URLSearchParams(window.location.search);
  const x = Number(p.get('x'));
  const y = Number(p.get('y'));
  const z = Number(p.get('z'));
  return p.has('x') && Number.isFinite(x) && Number.isFinite(y) && z > 0 ? { x, y, zoom: z } : null;
}

type SidePane = 'none' | 'compare' | 'report';

/**
 * A whole-slide image with the imaging demo's controls: magnification presets, Tour, Fit, Copy link, Full screen,
 * Compare (a second slide of the patient, linked at the same real-world magnification), the report beside the
 * slide, AI layers with their switches, a filmstrip of the patient's slides, multiplex fluorescence channels, a
 * status bar with the live magnification and a scale bar, and a details panel (About, Case, Controls). `compact`
 * (a column of a side-by-side answer) keeps the toolbar and leaves the panel and filmstrip out.
 */
export function SlideWorkspace({
  images,
  current,
  onSelect,
  height = 'clamp(560px, 74vh, 900px)',
  compact = false,
  folded = false,
  startOverlays,
  startChannels,
  startReport = false,
}: {
  images: SlideImage[];
  current: string;
  onSelect: (key: string) => void;
  height?: string;
  compact?: boolean;
  /** Start with the details panel folded (inside an answer). */
  folded?: boolean;
  /** AI layers to show at the start (Ask), by id; this workspace keeps that set until the reader switches a layer. */
  startOverlays?: string[];
  /** Marker channels to show at the start (fluorescence), by id. */
  startChannels?: string[];
  /** Open with the slide's report beside it. */
  startReport?: boolean;
}) {
  const viewerRef = useRef<SlideViewerHandle>(null);
  const compareRef = useRef<SlideViewerHandle>(null);
  const [status, setStatus] = useState<ViewerStatus | null>(null);
  const [compareStatus, setCompareStatus] = useState<ViewerStatus | null>(null);
  const maximise = useMaximise<HTMLDivElement>();
  const details = useDetailsPanel(folded);
  const { prefs, set: setPref, reset: resetPrefs } = useCasePrefs();
  const { display: storedDisplay, update: storeOverlay } = useOverlayDisplay();
  const image = images.find((i) => i.key === current) ?? images[0];
  const view = image.slide;
  // The AI layers come from the remembered choice, or from the question that opened this workspace.
  const [asked, setAsked] = useState<string[] | null>(startOverlays?.length ? startOverlays : null);
  const overlayDisplay = useMemo(
    () =>
      asked
        ? {
            ...storedDisplay,
            ...Object.fromEntries((view.overlays ?? []).map((o) => [o.id, { ...(storedDisplay[o.id] ?? { visible: false, opacity: 0.8 }), visible: asked.includes(o.id) }])),
          }
        : storedDisplay,
    [asked, storedDisplay, view]
  );
  const updateOverlay = (id: string, patch: Parameters<typeof storeOverlay>[1]) => {
    if (asked) {
      (view.overlays ?? []).forEach((o) => o.id !== id && storeOverlay(o.id, { visible: !!overlayDisplay[o.id]?.visible }));
      setAsked(null);
      storeOverlay(id, { visible: !!overlayDisplay[id]?.visible, ...patch });
    } else storeOverlay(id, patch);
  };
  const info = image.caseInfo ?? null;
  // A narrow column has no room beside the slide, so the report waits for the reader there.
  const [side, setSide] = useState<SidePane>(() =>
    startReport && !compact && (images.find((i) => i.key === current) ?? images[0])?.report ? 'report' : 'none'
  );
  const [compareKey, setCompareKey] = useState<string | null>(null);
  const compareImage = compareKey ? images.find((i) => i.key === compareKey) ?? null : null;
  const [linked, setLinked] = useState(true);
  const [compareAi, setCompareAi] = useState(false);
  const hiddenOverlays = useMemo(() => ({}), []);

  const startChannelKey = startChannels?.join(',') ?? '';
  const channels0 = useMemo(
    () => Object.fromEntries((view.channels ?? []).map((c) => [c.id, startChannelKey ? startChannelKey.split(',').includes(c.id) : c.visible])),
    [view, startChannelKey]
  );
  const [channels, setChannels] = useState<Record<string, boolean>>(channels0);
  useEffect(() => setChannels(channels0), [channels0]);
  const fluorescence = view.kind === 'fluorescence' && !!view.channels?.length;
  const featured = (view.channels ?? []).filter((c) => channelGroup(c) === 'featured');
  const toggleMarker = (id: string) => setChannels((v) => ({ ...v, [id]: !v[id] }));
  const setMarkers = (ids: string[], on: boolean) => setChannels((v) => ({ ...v, ...Object.fromEntries(ids.map((id) => [id, on])) }));

  // A shared link opens on the position it was copied at.
  useEffect(() => {
    const v = linkedView();
    if (!v) return;
    const t = window.setTimeout(() => viewerRef.current?.flyTo(v), 900);
    return () => window.clearTimeout(t);
  }, []);
  // Another slide closes the report (it belongs to the slide), and the comparison if it showed this slide.
  useEffect(() => {
    setStatus(null);
    if (side === 'report' && !image.report) setSide('none');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image.key]);

  const openCompare = (key?: string) => {
    const pick = key ?? compareKey ?? images.find((i) => i.key !== image.key)?.key ?? image.key;
    setCompareKey(pick);
    setSide('compare');
  };
  const hidePref = (id: keyof typeof prefs, what: string) => {
    setPref(id, false);
    toast(`${what} hidden. Turn it back on in Details › Controls.`);
  };
  const toggleOverlay = (id: string) => updateOverlay(id, { visible: !overlayDisplay[id]?.visible });
  const onMainMove = useCallback((v: SyncView) => linked && side === 'compare' && compareRef.current?.syncTo(v), [linked, side]);
  const onCompareMove = useCallback((v: SyncView) => linked && viewerRef.current?.syncTo(v), [linked]);
  // A question that asked for the report shows it even when the reader has hidden reports.
  const showReport = (prefs.report || startReport) && !!image.report;

  const copyLink = async () => {
    const v = viewerRef.current?.getView();
    const url = new URL(window.location.href);
    if (v) {
      url.searchParams.set('x', v.x.toFixed(5));
      url.searchParams.set('y', v.y.toFixed(5));
      url.searchParams.set('z', v.zoom.toFixed(5));
    }
    await navigator.clipboard.writeText(url.toString());
    toast('Link to this view copied');
  };

  const mag = status?.magnification ?? null;
  const presets = [1.25, 5, 10, 20, 40].filter((m) => !view.objectivePower || m <= view.objectivePower);
  const gp = (view.width * view.height) / 1e9;
  const area = view.mpp ? `${((view.width * view.mpp) / 1000).toFixed(1)} × ${((view.height * view.mpp) / 1000).toFixed(1)} mm` : null;

  return (
    <div ref={maximise.ref} className={`imaging-ws ${maximise.on ? 'workspace-max' : ''}`} style={{ height }}>
      {info && prefs.banner && !compact && (
        <CaseBanner
          info={info}
          image={image.caseImage ?? null}
          onOpenCase={() => (prefs.caseTab ? details.show('case') : setPref('caseTab', true))}
          onHide={() => hidePref('banner', 'Patient banner')}
        />
      )}

      <div className="hair flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="seg" role="group" aria-label="Magnification">
          {presets.map((m) => (
            <button
              key={m}
              onClick={() => viewerRef.current?.zoomToMagnification(m)}
              title={TIPS.magnification(m)}
              aria-pressed={mag != null && Math.abs(mag - m) / m < 0.04}
            >
              {m}×
            </button>
          ))}
        </div>
        <button
          onClick={() => (status?.touring ? viewerRef.current?.stopTour() : viewerRef.current?.startTour())}
          className={`btn ${status?.touring ? 'btn-ink' : 'btn-primary'}`}
          title={TIPS.tour}
          disabled={!view.hotspots?.length}
        >
          {status?.touring ? 'Stop tour' : 'Tour'}
        </button>
        <button onClick={() => viewerRef.current?.home()} className="btn" title={TIPS.fit}>
          Fit
        </button>
        {!compact && (
          <button onClick={() => void copyLink()} className="btn" title={TIPS.copyLink}>
            Copy link
          </button>
        )}
        <button onClick={maximise.toggle} className={`btn ${maximise.on ? 'btn-ink' : ''}`} aria-pressed={maximise.on} title={maximise.on ? TIPS.exitFullScreen : TIPS.fullScreen}>
          {maximise.on ? 'Exit full screen' : 'Full screen'}
        </button>
        {!compact && !fluorescence && images.length > 1 && (
          <button onClick={() => (side === 'compare' ? setSide('none') : openCompare())} className={`btn ${side === 'compare' ? 'btn-ink' : ''}`} aria-pressed={side === 'compare'} title={TIPS.compare}>
            Compare
          </button>
        )}
        {!compact && showReport && (
          <button onClick={() => setSide(side === 'report' ? 'none' : 'report')} className={`btn ${side === 'report' ? 'btn-ink' : ''}`} aria-pressed={side === 'report'} title={TIPS.report}>
            Report
          </button>
        )}
        {prefs.aiButtons && (view.overlays?.length ?? 0) > 0 && (
          <span className="ml-auto">
            <AiButtons overlays={view.overlays ?? []} display={overlayDisplay} onToggle={toggleOverlay} onMore={() => details.show('controls')} />
          </span>
        )}
      </div>

      {fluorescence && (
        <div className="hair flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
          <span className="t-faint mr-1 text-[12px]">Key markers</span>
          {featured.map((c) => (
            <button key={c.id} className="marker-chip" aria-pressed={channels[c.id]} title={channelHint(c)} onClick={() => toggleMarker(c.id)}>
              <span className="swatch" style={{ background: c.color, color: c.color }} />
              {markerLabel(c.name)}
            </button>
          ))}
          <button className="link t-muted ml-2 text-[12px]" title={TIPS.markersAll} onClick={() => setMarkers(featured.map((c) => c.id), true)}>
            all
          </button>
          <button className="link t-muted text-[12px]" title={TIPS.markersReset} onClick={() => setChannels(channels0)}>
            reset
          </button>
          {!compact && view.channels!.length > featured.length && (
            <button type="button" className="link t-muted ml-auto text-[12px]" onClick={() => details.show('controls')} title="All marker channels, with what each one shows">
              All {view.channels!.length} channels ›
            </button>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              {side === 'compare' && (
                <div className="pane-head hair flex h-9 shrink-0 items-center gap-2 border-b px-3 text-[12px]">
                  <span className="font-medium">{image.label}</span>
                  <span className="t-faint">{mag != null ? formatMag(mag) : ''}</span>
                </div>
              )}
              <div className="relative min-h-0 flex-1">
                <SlideViewer
                  key={`${image.key}:${view.imageKey ?? ''}`}
                  ref={viewerRef}
                  slide={view}
                  files={image.files}
                  channelVisibility={fluorescence ? channels : undefined}
                  overlayDisplay={overlayDisplay}
                  onStatus={setStatus}
                  onViewChange={side === 'compare' && linked ? onMainMove : undefined}
                />
              </div>
            </div>
            {side === 'compare' && compareImage && (
              <section className="hair flex min-w-0 flex-1 flex-col border-l" aria-label="Comparison slide">
                <div className="pane-head hair flex h-9 shrink-0 items-center gap-3 border-b px-3 text-[12px]">
                  <select className="field !h-7 max-w-[240px] py-0 text-[12px]" value={compareImage.key} onChange={(e) => setCompareKey(e.target.value)} aria-label="Slide on the right">
                    {images.map((i) => (
                      <option key={i.key} value={i.key}>
                        {i.label}
                      </option>
                    ))}
                  </select>
                  <span className="t-faint">{compareStatus?.magnification != null ? formatMag(compareStatus.magnification) : ''}</span>
                  {(compareImage.slide.overlays?.length ?? 0) > 0 && (
                    <label className="flex items-center gap-1.5 whitespace-nowrap" title="Draw this slide’s AI layers on the right as well">
                      <input type="checkbox" className="check" checked={compareAi} onChange={() => setCompareAi(!compareAi)} />
                      AI layers
                    </label>
                  )}
                  <label className="flex items-center gap-1.5 whitespace-nowrap" title={TIPS.linkViews}>
                    <input type="checkbox" className="check" checked={linked} onChange={() => setLinked(!linked)} />
                    Link views
                  </label>
                  <button type="button" className="icon-btn ml-auto h-7 w-7" onClick={() => setSide('none')} title="Close the comparison" aria-label="Close the comparison">
                    ×
                  </button>
                </div>
                <div className="relative min-h-0 flex-1">
                  <SlideViewer
                    key={`${compareImage.key}:${compareImage.slide.imageKey ?? ''}`}
                    ref={compareRef}
                    slide={compareImage.slide}
                    files={compareImage.files}
                    overlayDisplay={compareAi ? overlayDisplay : hiddenOverlays}
                    onStatus={setCompareStatus}
                    onViewChange={linked ? onCompareMove : undefined}
                  />
                </div>
              </section>
            )}
            {side === 'report' && image.report && showReport && (
              <ReportPane url={image.report.url} title={image.report.title} sourceUrl={image.report.sourceUrl} onClose={() => setSide('none')} />
            )}
          </div>
          {!compact && prefs.tray && images.length > 1 && (
            <SlideTray
              items={images}
              current={image.key}
              compare={side === 'compare' ? compareImage?.key ?? null : null}
              onSelect={onSelect}
              onCompare={fluorescence ? null : (key) => openCompare(key)}
              onHide={() => hidePref('tray', 'Filmstrip')}
            />
          )}
          <div className="statusbar flex h-9 shrink-0 items-center gap-5 overflow-hidden whitespace-nowrap px-3 text-[12.5px]">
            <span className="w-14 text-[14px] font-semibold">{mag != null ? formatMag(mag) : '…'}</span>
            <ScaleBar umPerPixel={status?.umPerPixel ?? null} />
            <span className="t-muted">{(status?.tilesLoaded ?? 0).toLocaleString('en-US')} tiles loaded</span>
            {status?.firstTileMs != null && <span className="t-faint">first tile {status.firstTileMs} ms</span>}
            {!!status?.tilesFailed && <span style={{ color: 'var(--accent)' }}>{status.tilesFailed} failed</span>}
            <span className="t-faint ml-auto hidden xl:inline">Scroll to zoom · drag to pan · double-click to zoom in</span>
          </div>
        </div>

        {!compact && (
          <DetailsPanel
            panel={details}
            about={
              <>
                <PanelSection title="In plain words">
                  <PlainWords note={slideNote(view.id, view.kind)} />
                </PanelSection>
                <PanelSection title="Specimen">
                  <dl>
                    {image.about.specimen && <PanelRow term="Specimen">{image.about.specimen}</PanelRow>}
                    {image.about.project && <PanelRow term="Project">{image.about.project}</PanelRow>}
                    {image.about.case && (
                      <PanelRow term="Case">
                        <span className="mono">{image.about.case}</span>
                      </PanelRow>
                    )}
                    {image.caseImage && (
                      <PanelRow term="Slide">
                        {image.caseImage.label}
                        <span className="t-faint mono block text-[11px]">{image.caseImage.barcode}</span>
                      </PanelRow>
                    )}
                    <PanelRow term="Scanner">
                      {image.about.scanner ? `${image.about.scanner}, ` : ''}
                      {view.objectivePower ? `${view.objectivePower}× objective` : 'objective not recorded'}
                    </PanelRow>
                    <PanelRow term="Resolution">{view.mpp ? `${view.mpp.toFixed(3)} µm per pixel` : 'not recorded'}</PanelRow>
                    <PanelRow term="Pixels">
                      {view.width.toLocaleString('en-US')} × {view.height.toLocaleString('en-US')} ({gp.toFixed(1)} gigapixels)
                    </PanelRow>
                    {area && <PanelRow term="Area">{area}</PanelRow>}
                    <PanelRow term="Pyramid">
                      {view.levels} levels{view.tileCount ? `, ${view.tileCount.toLocaleString('en-US')} tiles` : ''}
                      {fluorescence ? ` for each of ${view.channels!.length} channels` : ''}
                    </PanelRow>
                    {image.about.license && <PanelRow term="Licence">{image.about.license}</PanelRow>}
                  </dl>
                </PanelSection>
                <PanelSection title="Storage">
                  <div className="text-[12.5px] font-medium">{image.about.item}</div>
                  <ul className="t-muted mono mt-2 space-y-1 break-all text-[11.5px]">
                    <li>{image.about.served}</li>
                    {(view.overlays ?? []).map((o) => (
                      <li key={o.id}>
                        {image.about.served.replace(/\/$/, '')}/{view.prefix ?? ''}
                        {o.kind === 'tiled' ? o.prefix : o.file}
                      </li>
                    ))}
                  </ul>
                  {image.about.original && <p className="t-faint mt-2 text-[11.5px]">{image.about.original}</p>}
                  {image.about.sourceUrl && (
                    <a href={image.about.sourceUrl} target="_blank" rel="noreferrer" className="link mt-3 inline-block text-[12.5px]">
                      {image.about.sourceUrl.includes('gdc.cancer.gov') ? 'GDC record ↗' : 'Source ↗'}
                    </a>
                  )}
                </PanelSection>
              </>
            }
            caseInfo={
              info && prefs.caseTab ? (
                <CasePanel info={info} image={image.caseImage ?? null} reportOpen={side === 'report'} onOpenReport={showReport ? () => setSide('report') : null} />
              ) : undefined
            }
            controls={
              <>
                {fluorescence && (
                  <PanelSection title={`Marker channels (${view.channels!.length})`}>
                    <MarkerControls channels={view.channels!} visible={channels} onToggle={toggleMarker} onSet={setMarkers} onReset={() => setChannels(channels0)} />
                  </PanelSection>
                )}
                {!fluorescence && (
                  <PanelSection title="AI layers">
                    <AiLayerControls overlays={view.overlays ?? []} display={overlayDisplay} onUpdate={updateOverlay} />
                  </PanelSection>
                )}
                <PanelSection
                  title="Show on screen"
                  aside={
                    <button type="button" className="link" onClick={resetPrefs}>
                      Show all
                    </button>
                  }
                >
                  <ul className="space-y-2.5">
                    {CASE_PREF_LABELS.map((pref) => (
                      <li key={pref.id}>
                        <label className="flex items-center gap-2 text-[13px]">
                          <input type="checkbox" className="check" checked={prefs[pref.id]} onChange={() => setPref(pref.id, !prefs[pref.id])} />
                          <span>{pref.label}</span>
                        </label>
                        <p className="t-faint mt-0.5 pl-6 text-[11.5px] leading-snug">{pref.hint}</p>
                      </li>
                    ))}
                  </ul>
                </PanelSection>
              </>
            }
          />
        )}
      </div>
    </div>
  );
}
