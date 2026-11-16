import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { DetailsPanel, PanelRow, PanelSection, useDetailsPanel } from './Details';
import { RENDER_PRESET_NOTES, studyNote, TIPS, WINDOW_NOTES, type ImageNote } from './guide';
import { MIP_COLORMAPS, MipViewer, type MipColormap } from './MipViewer';
import { PlainWords } from './PlainWords';
import { AtlasAbout, BundleLegend, BundlesPanel, useTracts, type TractStart } from './Tracts';
import { formatMb, frameBytes, type Locator, type VolumeStudy } from './types';
import { useMaximise } from './useMaximise';
import {
  VolumeViewer,
  type ClipSetting,
  type ColourPreset,
  type LayerSetting,
  type ViewMode,
  type VolumeViewerHandle,
  type VolumeViewerStatus,
} from './VolumeViewer';

export type PageView = ViewMode | 'mip';

const VIEWS: { id: PageView; label: string }[] = [
  { id: 'render', label: '3D' },
  { id: 'mip', label: 'MIP' },
  { id: 'multiplanar', label: 'MPR' },
  { id: 'axial', label: 'Axial' },
  { id: 'coronal', label: 'Coronal' },
  { id: 'sagittal', label: 'Sagittal' },
];

/** Colour transfer functions for 3D CT rendering (NiiVue colour maps with their HU ranges). */
const CT_RENDER: ColourPreset[] = [
  { id: 'bone', label: 'Bone', colormap: 'ct_bones', calMin: 180, calMax: 600 },
  { id: 'lungs', label: 'Lungs (glass)', colormap: 'ct_lung_glass', calMin: -1000, calMax: -300, glass: { gradientOpacity: 0.5, silhouette: 0.25 } },
  { id: 'contrast', label: 'Vessels and bone', colormap: 'ct_w_contrast', calMin: 50, calMax: 1000 },
  { id: 'artery', label: 'Arteries', colormap: 'ct_artery', calMin: 114, calMax: 800 },
  { id: 'muscle', label: 'Muscle', colormap: 'ct_muscles', calMin: -100, calMax: 246 },
  { id: 'skin', label: 'Skin', colormap: 'ct_surface', calMin: -600, calMax: 100 },
];
/** Greyscale windows for 2D CT reading. */
const CT_WINDOWS: ColourPreset[] = [
  { id: 'soft', label: 'Soft tissue', colormap: 'gray', calMin: -160, calMax: 240 },
  { id: 'lung', label: 'Lung', colormap: 'gray', calMin: -1350, calMax: 150 },
  { id: 'bonew', label: 'Bone', colormap: 'gray', calMin: -450, calMax: 1050 },
];
const MRI: ColourPreset[] = [{ id: 'gray', label: 'Greyscale', colormap: 'gray' }];
/** 3D MRI: translucent shows depth; solid gives sharp cut faces when clipping. */
const MRI_RENDER: ColourPreset[] = [
  { id: 'gray', label: 'Translucent', colormap: 'gray' },
  { id: 'solid', label: 'Solid', colormap: 'mri_solid' },
  { id: 'sepia', label: 'Skin tone', colormap: 'mri_sepia' },
];
const OVERLAY_MAPS = [
  { id: 'hot', label: 'Hot' },
  { id: 'inferno', label: 'Inferno' },
  { id: 'plasma', label: 'Plasma' },
  { id: 'ge_color', label: 'GE colour' },
  { id: 'turbo', label: 'Turbo' },
];

function viewsFor(study: VolumeStudy) {
  return VIEWS.filter((v) => (v.id === 'mip' ? !!study.mip : !study.views || study.views.includes(v.id)));
}

function presetsFor(study: VolumeStudy, view: PageView): ColourPreset[] {
  const kind = study.layers[0]?.kind;
  if (kind === 'ct') return view === 'render' ? CT_RENDER : CT_WINDOWS;
  if (kind === 'mri') return view === 'render' ? MRI_RENDER : MRI;
  return [];
}

const STAT_LABELS: Record<string, string> = {
  lesions: 'Lesions',
  lesionVolumeMl: 'Lesion volume, ml',
  suvMax: 'SUVmax',
  injectedMBq: 'Injected, MBq',
  weeks: 'Weeks',
  brainVolumeMlStart: 'Brain, first week, ml',
  brainVolumeMlEnd: 'Brain, last week, ml',
  phases: 'Phases',
  lungVolumeChangeMl: 'Lung volume change, ml',
  tumourMotionMm: 'Tumour motion, mm',
  bundles: 'Fibre bundles',
  streamlines: 'Lines drawn',
  atlasStreamlines: 'Lines in the atlas',
  people: 'People averaged',
  probabilityMaps: 'Probability maps',
  scans: 'Scans',
  days: 'Days of treatment',
};

/** Voxel sizes without floating-point noise: 0.15630000000000002 -> 0.1563. */
const formatMm = (mm: number) => String(Number(mm.toFixed(4)));

type Lut = { R: number[]; G: number[]; B: number[]; A: number[]; labels: string[] };

/** Swatches grouped by colour, so a long label table reads as a short legend. */
function LabelLegend({ url }: { url: string }) {
  const [groups, setGroups] = useState<{ colour: string; names: string[] }[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((r) => r.json() as Promise<Lut>)
      .then((t) => {
        const byColour = new Map<string, string[]>();
        t.labels.forEach((name, i) => {
          if (!name || !t.A[i]) return;
          const colour = `rgb(${t.R[i]} ${t.G[i]} ${t.B[i]})`;
          const names = byColour.get(colour) ?? [];
          if (!names.includes(name)) byColour.set(colour, [...names, name]);
        });
        if (!cancelled) setGroups([...byColour.entries()].map(([colour, names]) => ({ colour, names })));
      })
      .catch(() => setGroups([]));
    return () => {
      cancelled = true;
    };
    // The table is fetched once per file; a refreshed SAS changes the URL but not the table.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url.split('?')[0]]);
  if (groups.length === 0) return null;
  const shown = groups.slice(0, 14);
  return (
    <ul className="mt-2 space-y-1 pl-6">
      {shown.map((g) => (
        <li key={g.colour} className="flex items-start gap-2 text-[11.5px]">
          <span className="mt-[3px] h-2.5 w-2.5 shrink-0" style={{ background: g.colour }} />
          <span className="t-muted min-w-0">{g.names.length > 2 ? `${g.names[0]} and ${g.names.length - 1} more` : g.names.join(', ')}</span>
        </li>
      ))}
      {groups.length > shown.length && <li className="t-faint text-[11.5px]">{groups.length - shown.length} more colours</li>}
    </ul>
  );
}

/** Where the study's files are, for About › Storage. */
export type StudyStorage = { item: string; served: string; original?: string };

/**
 * A 3D or 4D study with the imaging demo's controls: views (3D, MIP, MPR, single planes), colour presets and
 * windows, clip plane, spin, reset, save image, full screen, a timeline with play for 4D studies, and a details
 * panel with each layer's switch, opacity, colour map and legend. `compact` (a column of a side-by-side answer)
 * keeps the views and the timeline and leaves the panel out.
 */
export function VolumeWorkspace({
  study: given,
  files,
  height = 'clamp(640px, 82vh, 980px)',
  compact = false,
  startView,
  startFrame,
  storage,
  overlay,
  aboutExtra,
  onLoaded,
  folded = false,
  note: givenNote,
  startLayers,
  startTracts,
  startFull = false,
}: {
  study: VolumeStudy;
  files: Locator;
  height?: string;
  compact?: boolean;
  startView?: PageView;
  /** Timeline value to open on (a week, a breathing phase). */
  startFrame?: number;
  storage?: StudyStorage;
  /** Drawn over the viewer (the record's nodule legend); `goTo` centres the crosshair on a label of a layer. */
  overlay?: (goTo: (layerId: string, label: number) => boolean) => ReactNode;
  /** Start with the details panel folded (inside an answer). */
  folded?: boolean;
  /** In plain words, for an image without a written note (a series from the record). */
  note?: ImageNote;
  /** Layers to show at the start (Ask), by id; the rest start hidden, except that the base image keeps its default. */
  startLayers?: string[];
  /** A tractography atlas (Ask): the bundles to draw, their colour and the map on the slices. */
  startTracts?: TractStart;
  /** Open a study that has them on its full-size files (Ask). */
  startFull?: boolean;
  /** More rows for About › Study (the record's own facts). */
  aboutExtra?: ReactNode;
  /** Once the study has loaded: the record centres a CT on its nodule here. */
  onLoaded?: (handle: VolumeViewerHandle) => void;
}) {
  const viewerRef = useRef<VolumeViewerHandle>(null);
  // A study reduced for the browser can open its original-resolution files instead (same layers, bigger files).
  const [full, setFull] = useState(startFull && !!given.fullSize);
  const study = useMemo(
    () =>
      full && given.fullSize
        ? { ...given, layers: given.fullSize.layers, dims: given.fullSize.dims, spacingMm: given.fullSize.spacingMm, sizeBytes: given.fullSize.sizeBytes }
        : given,
    [given, full]
  );
  const timeline = study.timeline;
  const initialView = startView ?? ((study.defaultView as PageView) || 'render');
  const [view, setView] = useState<PageView>(initialView);
  const [volumeView, setVolumeView] = useState<ViewMode>(initialView === 'mip' ? 'render' : initialView);
  const [mipColormap, setMipColormap] = useState<MipColormap>((study.mip?.colormap as MipColormap) ?? 'inverted');
  const chooseView = (v: PageView) => {
    setView(v);
    if (v !== 'mip') setVolumeView(v);
  };
  const [presetIds, setPresetIds] = useState<Record<string, string>>({});
  const tracts = useTracts(study, startTracts);
  // Asked-for bundles switch on the groups they are in.
  const bundleGroups = (study.bundles ?? []).filter((b) => startTracts?.bundles?.includes(b.id)).map((b) => b.group);
  const startIds = startLayers?.length || bundleGroups.length ? [...(startLayers ?? []), ...bundleGroups] : null;
  const initialLayers = () =>
    Object.fromEntries(
      study.layers.map((l, i) => [
        l.id,
        {
          // A probability map asked for opens over the template brain.
          visible:
            (i === 0 && !!startTracts?.map) || (startIds ? startIds.includes(l.id) || (i === 0 && (l.visible ?? true)) : (l.visible ?? true)),
          opacity: l.opacity ?? 1,
          colormap: l.colormap,
        },
      ])
    );
  const [layers, setLayers] = useState<Record<string, LayerSetting>>(initialLayers);
  const [clip, setClip] = useState<ClipSetting>(() => study.defaultClip ?? { on: false, depth: 0, face: 'front' });
  const [spin, setSpin] = useState(false);
  const [playing, setPlaying] = useState(!!timeline?.loop && !compact);
  const maximise = useMaximise<HTMLDivElement>();
  const details = useDetailsPanel(folded);
  const [status, setStatus] = useState<VolumeViewerStatus>({ loading: true, error: null, loadMs: null, location: null });
  const [frameIndex, setFrameIndex] = useState(() => {
    if (!timeline) return 0;
    const i = timeline.frames.findIndex((f) => f.value === (startFrame ?? timeline.initial));
    return i >= 0 ? i : 0;
  });

  // A different study (the record's scrubber moved on) starts from its own defaults.
  const studyKey = study.id;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const v = startView ?? ((study.defaultView as PageView) || 'render');
    setView(v);
    setVolumeView(v === 'mip' ? 'render' : v);
    setLayers(initialLayers());
    setFull(startFull && !!given.fullSize);
    tracts.reset(startTracts);
    setClip(study.defaultClip ?? { on: false, depth: 0, face: 'front' });
    setPlaying(!!study.timeline?.loop && !compact);
    const i = study.timeline ? study.timeline.frames.findIndex((f) => f.value === (startFrame ?? study.timeline!.initial)) : 0;
    setFrameIndex(Math.max(0, i));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studyKey]);

  const frame = timeline?.frames[frameIndex];
  const presets = presetsFor(study, view);
  const mode = view === 'render' ? 'render' : '2d';
  const fallback = mode === 'render' ? study.defaultPreset ?? undefined : study.defaultPreset2d ?? undefined;
  const preset = presets.find((p) => p.id === (presetIds[mode] ?? fallback)) ?? presets[0] ?? null;

  // Timeline playback. 4D files switch frames in place at the study's frame rate; per-file timelines advance once
  // the current frame has loaded.
  const inPlace = timeline?.mode === 'frames4d';
  useEffect(() => {
    if (!playing || !timeline || status.loading) return;
    const delay = inPlace ? 1000 / (timeline.fps ?? 10) : 700;
    const t = window.setTimeout(() => setFrameIndex((i) => (i + 1) % timeline.frames.length), delay);
    return () => window.clearTimeout(t);
  }, [playing, timeline, status.loading, frameIndex, inPlace]);

  const setLayer = (id: string, patch: Partial<LayerSetting>) => setLayers((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const servedBytes = frameBytes(study, frameIndex);
  const note = givenNote ?? studyNote(study.id, study.description);
  const presetNote = preset ? (mode === 'render' ? RENDER_PRESET_NOTES : WINDOW_NOTES)[preset.id] : undefined;
  const hint =
    view === 'mip'
      ? `${study.mip?.label ?? 'Maximum intensity projection'} · drag sideways to rotate`
      : view === 'render'
        ? 'Drag to rotate · scroll to zoom · right-drag to pan'
        : 'Click to move the cursor · scroll to change slice · right-drag to pan';
  const canClip = view !== 'mip' && (!study.views || study.views.includes('render'));
  const views = viewsFor(study).filter((v) => !compact || v.id !== 'multiplanar');

  return (
    <div ref={maximise.ref} className={`imaging-ws ${maximise.on ? 'workspace-max' : ''}`} style={{ height }}>
      <div className="hair flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2">
        <div className="seg" role="group" aria-label="View">
          {views.map((v) => (
            <button key={v.id} aria-pressed={view === v.id} onClick={() => chooseView(v.id)} title={TIPS.views[v.label]}>
              {v.label}
            </button>
          ))}
        </div>

        {view === 'mip' && (
          <label className="flex items-center gap-2 text-[12.5px]">
            <span className="t-faint">Colour</span>
            <select className="field !h-[30px] !w-auto py-0 pr-7" value={mipColormap} onChange={(e) => setMipColormap(e.target.value as MipColormap)}>
              {MIP_COLORMAPS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        )}

        {view !== 'mip' && presets.length > 1 && (
          <label className="flex items-center gap-2 text-[12.5px]">
            {!compact && <span className="t-faint">{view === 'render' ? 'Colour' : 'Window'}</span>}
            <select
              className="field !h-[30px] !w-auto py-0 pr-7"
              value={preset?.id}
              onChange={(e) => setPresetIds((p) => ({ ...p, [mode]: e.target.value }))}
              title={presetNote}
              aria-label={view === 'render' ? 'Colour' : 'Window'}
            >
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}

        {canClip && (
          <div className="flex items-center gap-2">
            <button className={`btn ${clip.on ? 'btn-ink' : ''}`} aria-pressed={clip.on} title={TIPS.clip} onClick={() => setClip((c) => ({ ...c, on: !c.on }))}>
              Clip
            </button>
            {clip.on && (
              <>
                <div className="seg" role="group" aria-label="Clip direction" title={TIPS.clipFace}>
                  {(['front', 'side', 'top'] as const).map((f) => (
                    <button key={f} aria-pressed={clip.face === f} onClick={() => setClip((c) => ({ ...c, face: f }))}>
                      {f[0].toUpperCase() + f.slice(1)}
                    </button>
                  ))}
                </div>
                <input
                  type="range"
                  className="range w-24"
                  min={-0.5}
                  max={0.5}
                  step={0.01}
                  value={clip.depth}
                  aria-label="Clip depth"
                  title={TIPS.clipDepth}
                  onChange={(e) => setClip((c) => ({ ...c, depth: Number(e.target.value) }))}
                />
              </>
            )}
          </div>
        )}

        {given.fullSize && view !== 'mip' && (
          <button
            className={`btn ${full ? 'btn-ink' : ''}`}
            aria-pressed={full}
            title={
              full
                ? `Back to the ${formatMm(given.spacingMm[0])} mm version (${formatMb(given.sizeBytes)})`
                : `Load the original resolution, ${given.fullSize.spacingMm.map(formatMm).join(' × ')} mm (${formatMb(given.fullSize.sizeBytes)})`
            }
            onClick={() => setFull((f) => !f)}
          >
            Full size
          </button>
        )}
        <button
          className={`btn ${spin ? 'btn-ink' : ''}`}
          aria-pressed={spin}
          title={TIPS.spin}
          onClick={() => setSpin((s) => !s)}
          disabled={view !== 'render' && view !== 'multiplanar' && view !== 'mip'}
        >
          Spin
        </button>
        <button className="btn" title={TIPS.reset} onClick={() => viewerRef.current?.resetView()}>
          Reset
        </button>

        <div className="ml-auto flex items-center gap-2">
          {!compact && (
            <button className="btn" title={TIPS.saveImage} onClick={() => viewerRef.current?.saveImage()}>
              Save image
            </button>
          )}
          <button
            className={`btn ${maximise.on ? 'btn-ink' : ''}`}
            aria-pressed={maximise.on}
            title={maximise.on ? TIPS.exitFullScreen : TIPS.fullScreen}
            onClick={maximise.toggle}
          >
            {maximise.on ? 'Exit full screen' : 'Full screen'}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1" style={{ background: 'var(--well)' }}>
            <VolumeViewer
              ref={viewerRef}
              study={study}
              files={files}
              frameIndex={frameIndex}
              view={volumeView}
              preset={preset}
              layers={layers}
              clip={clip}
              spin={spin && view !== 'mip'}
              tracts={tracts.bundles.length ? tracts.settings : undefined}
              focus={tracts.focus}
              onStatus={setStatus}
              onLoaded={() => viewerRef.current && onLoaded?.(viewerRef.current)}
            />
            {view === 'mip' && study.mip && (
              <MipViewer
                url={files(study.mip.sprite)}
                mip={study.mip}
                colormap={mipColormap}
                spin={spin}
                gamma={mipColormap === 'inverted' || mipColormap === 'gray' ? 0.85 : 0.7}
              />
            )}
            {overlay?.((layerId, label) => viewerRef.current?.goToLabel(layerId, label) ?? false)}
            {tracts.bundles.length > 0 && view !== 'mip' && (
              <BundleLegend
                t={tracts}
                onPick={(id) => {
                  tracts.setSelected(id);
                  details.show('bundles');
                }}
              />
            )}
            {status.loading && !playing && view !== 'mip' && (
              <div className="statusbar absolute left-3 top-3 border px-3 py-1.5 text-[12.5px]">Loading {formatMb(servedBytes)} from OneLake</div>
            )}
            {status.error && (
              <div className="absolute inset-x-3 top-3 border px-3 py-2 text-[12.5px]" style={{ background: 'var(--bg)', borderColor: 'var(--accent)' }}>
                Could not load this study: {status.error}
              </div>
            )}
          </div>

          {timeline && frame && (
            <div className="statusbar flex shrink-0 items-center gap-4 px-3 py-2.5">
              <button className={`btn ${playing ? 'btn-ink' : 'btn-primary'} w-[72px] justify-center`} title={TIPS.play} onClick={() => setPlaying((p) => !p)}>
                {playing ? 'Pause' : 'Play'}
              </button>
              <div className="min-w-0 flex-1">
                <input
                  type="range"
                  className="range w-full"
                  min={0}
                  max={timeline.frames.length - 1}
                  step={1}
                  value={frameIndex}
                  aria-label={timeline.label}
                  onChange={(e) => {
                    setPlaying(false);
                    setFrameIndex(Number(e.target.value));
                  }}
                />
                {!compact && (
                  <div className="mt-1 flex justify-between">
                    {timeline.frames.map((f, i) => (
                      <button
                        key={f.value}
                        className="timeline-tick"
                        aria-current={i === frameIndex}
                        onClick={() => {
                          setPlaying(false);
                          setFrameIndex(i);
                        }}
                      >
                        {f.value}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className={`${compact ? 'w-[110px]' : 'w-[170px]'} shrink-0 text-right`}>
                <div className="t-display text-[20px] font-semibold">{frame.label}</div>
                <div className="t-faint text-[11.5px]">
                  {timeline.label}
                  {frame.note ? ` · ${frame.note}` : ''}
                </div>
              </div>
            </div>
          )}

          <div className="statusbar flex h-9 shrink-0 items-center gap-5 overflow-hidden whitespace-nowrap px-3 text-[12.5px]">
            <span className="t-muted">
              {study.dims.join(' × ')} voxels · {formatMm(study.spacingMm[0])} mm
            </span>
            <span className="t-faint">
              {formatMb(servedBytes)}
              {status.loadMs != null && !status.loading ? ` in ${(status.loadMs / 1000).toFixed(1)} s` : ''}
            </span>
            {status.location && view !== 'render' && <span className="mono t-muted truncate text-[11.5px]">{status.location}</span>}
            <span className="t-faint ml-auto hidden truncate xl:inline">{hint}</span>
          </div>
        </div>

        {!compact && (
          <DetailsPanel
            panel={details}
            about={
              <>
                <PanelSection title="In plain words">
                  <PlainWords note={note} />
                </PanelSection>
                <PanelSection title="Study">
                  <dl>
                    <PanelRow term="Modality">{study.modality}</PanelRow>
                    <PanelRow term="Subject">{study.subject}</PanelRow>
                    {study.scanner && <PanelRow term="Scanner">{study.scanner}</PanelRow>}
                    {study.patientId && (
                      <PanelRow term="Case">
                        <span className="mono">{study.patientId}</span>
                      </PanelRow>
                    )}
                    <PanelRow term="Grid">
                      {study.dims.join(' × ')} at {study.spacingMm.map(formatMm).join(' × ')} mm
                    </PanelRow>
                    {study.stats &&
                      Object.entries(study.stats).map(([k, v]) => (
                        <PanelRow key={k} term={STAT_LABELS[k] ?? k}>
                          {v.toLocaleString('en-US')}
                        </PanelRow>
                      ))}
                    {aboutExtra}
                  </dl>
                </PanelSection>
                {(study.source || study.license) && (
                  <PanelSection title="Source and licence">
                    <p className="text-[12.5px]">{study.source}</p>
                    {study.license && (
                      <p className="mt-2 text-[12.5px]">
                        <span className="t-faint">Licence </span>
                        {study.license}
                      </p>
                    )}
                    {study.citation && <p className="t-faint mt-2 text-[11.5px]">{study.citation}</p>}
                    {study.sourceUrl && (
                      <a href={study.sourceUrl} target="_blank" rel="noreferrer" className="link mt-3 inline-block text-[12.5px]">
                        Dataset page ↗
                      </a>
                    )}
                  </PanelSection>
                )}
                <AtlasAbout study={study} files={files} />
                {storage && (
                  <PanelSection title="Storage">
                    <div className="text-[12.5px] font-medium">{storage.item}</div>
                    <dl className="mt-2">
                      <PanelRow term="Served">
                        <span className="mono text-[11.5px]">{storage.served}</span>
                        <span className="t-faint block text-[11.5px]">{formatMb(study.sizeBytes)} NIfTI</span>
                      </PanelRow>
                      {storage.original && (
                        <PanelRow term="Original">
                          <span className="text-[12px]">{storage.original}</span>
                        </PanelRow>
                      )}
                    </dl>
                  </PanelSection>
                )}
              </>
            }
            bundles={
              tracts.bundles.length ? (
                <BundlesPanel
                  study={study}
                  t={tracts}
                  layerVisible={(id) => layers[id]?.visible ?? true}
                  setLayerVisible={(id, on) => setLayer(id, { visible: on })}
                  files={files}
                  sliceView={view !== 'render' && view !== 'mip'}
                  onSlices={() => {
                    chooseView('multiplanar');
                    setLayer(study.layers[0].id, { visible: true });
                  }}
                  onShowBase={() => setLayer(study.layers[0].id, { visible: true })}
                  onPicked={() => requestAnimationFrame(() => details.scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }))}
                />
              ) : undefined
            }
            controls={
              <>
                <PanelSection title="Layers">
                  <ul className="space-y-3">
                    {study.layers.map((l, i) => (
                      <li key={l.id}>
                        <label className="flex items-center gap-2 text-[13px]">
                          <input type="checkbox" className="check" checked={layers[l.id]?.visible ?? true} onChange={(e) => setLayer(l.id, { visible: e.target.checked })} />
                          <span className="font-medium">{l.label}</span>
                          {l.unit && <span className="t-faint text-[11.5px]">{l.unit}</span>}
                        </label>
                        {note.layers?.[l.id] && <p className="t-faint mt-1 pl-6 text-[11.5px] leading-snug">{note.layers[l.id]}</p>}
                        {i > 0 && (
                          <div className="mt-1.5 flex items-center gap-3 pl-6">
                            <input
                              type="range"
                              className="range flex-1"
                              min={0}
                              max={1}
                              step={0.05}
                              value={layers[l.id]?.opacity ?? 1}
                              aria-label={`${l.label} opacity`}
                              onChange={(e) => setLayer(l.id, { opacity: Number(e.target.value) })}
                            />
                            {l.kind === 'overlay' && (
                              <select
                                className="field !h-[28px] !w-auto py-0 text-[12px]"
                                value={layers[l.id]?.colormap ?? l.colormap}
                                onChange={(e) => setLayer(l.id, { colormap: e.target.value })}
                                aria-label={`${l.label} colour map`}
                              >
                                {OVERLAY_MAPS.map((m) => (
                                  <option key={m.id} value={m.id}>
                                    {m.label}
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        )}
                        {l.kind === 'overlay' && l.calMin !== undefined && (
                          <div className="t-faint mt-1 pl-6 text-[11.5px]">
                            Shown from {l.calMin} to {l.calMax} {l.unit}
                          </div>
                        )}
                        {l.kind === 'labels' && l.lut && <LabelLegend url={files(l.lut)} />}
                      </li>
                    ))}
                  </ul>
                </PanelSection>
                <PanelSection title="Current view">
                  <dl>
                    <PanelRow term="View">{TIPS.views[VIEWS.find((x) => x.id === view)?.label ?? ''] ?? view}</PanelRow>
                    {presetNote && view !== 'mip' && <PanelRow term={preset?.label ?? 'Colour'}>{presetNote}</PanelRow>}
                    {clip.on && view !== 'mip' && <PanelRow term="Clip">Cutting from the {clip.face}; the slider moves the cut.</PanelRow>}
                    <PanelRow term="Mouse">{hint}</PanelRow>
                  </dl>
                </PanelSection>
              </>
            }
          />
        )}
      </div>
    </div>
  );
}

