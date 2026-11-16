import OpenSeadragon from 'openseadragon';
import { useEffect, useMemo, useRef, useState } from 'react';

import { SlideWorkspace, type SlideImage } from '@/components/imaging/SlideWorkspace';
import type { ImageNote } from '@/components/imaging/guide';
import type { VolumeStudy } from '@/components/imaging/types';
import type { VolumeViewerHandle } from '@/components/imaging/VolumeViewer';
import { VolumeWorkspace } from '@/components/imaging/VolumeWorkspace';
import { Scrubber, type ScrubItem } from '@/components/Scrubber';
import { fileUrl, num, parseJson, str, type FileAccess, type PatientBundle, type Row } from '@/lib/api';
import { fmtBytes, fmtDate, fmtDay, fmtNum } from '@/lib/format';

/* ================================================================== Pathology */

type Hotspot = { x: number; y: number; kind?: string };

/** Short name for a research slide: section code and what it shows. */
function slideTick(s: Row): string {
  if (s.role === 'diagnostic') return 'Diagnostic slide';
  const section = str(s.section) ?? '';
  const normal = /normal/i.test(str(s.sample_type) ?? '');
  const where = section.startsWith('T') ? 'top' : section.startsWith('B') ? 'bottom' : '';
  return `Frozen ${section}, ${normal ? 'normal' : 'tumour'}${where ? ` ${where}` : ''}`;
}

/**
 * The record's slides in the slide workspace's shape. The TCGA research patients' pyramids sit under slides/<id>
 * (Bronze_Oncology_Imaging), with an AI lymphocyte map on the diagnostic slide; the hospital patients' under the
 * viewer folder of their PACS series (Patient360), with the pathology report when it is a scan.
 */
export function slideImages(slides: Row[], access: FileAccess, b?: PatientBundle): SlideImage[] {
  return slides
    .filter((s) => num(s.width) && num(s.levels))
    .map((s) => {
      const sid = str(s.slide_id)!;
      const epic = !!s.tile_root;
      const root = str(s.tile_root) ?? `slides/${sid}`;
      const rel = (path: string | null) => (path ? path.replace(`${root}/`, '') : null);
      const files = (path: string) => fileUrl(access, `${root}/${path}`);
      const til = str(s.til_overlay_path);
      const tilPct = num(s.til_positive_fraction);
      const width = num(s.width)!;
      const height = num(s.height)!;
      const doc = epic && b ? b.documents.find((d) => d.document_id === s.report_id && d.scanned && str(d.path)) : null;
      const report =
        b && !epic && b.report.pdfPath && !b.access.report.error
          ? { url: fileUrl(b.access.report, b.report.pdfPath), title: 'Pathology report', sourceUrl: b.report.gdcFileId ? `https://portal.gdc.cancer.gov/files/${b.report.gdcFileId}` : null }
          : doc
            ? { url: fileUrl(b!.access.documents, str(doc.path)!), title: `Pathology report ${str(doc.document_id)}` }
            : null;
      const label = epic ? `${str(s.specimen) ?? 'H&E slide'}${s.date ? `, ${fmtDate(str(s.date))}` : ''}` : slideTick(s);
      const detail = epic ? 'H&E · FFPE' : `${s.role === 'frozen' ? 'Frozen' : 'FFPE'}${/normal/i.test(str(s.sample_type) ?? '') ? ' · normal' : ''}${til ? ' · AI' : ''}`;
      return {
        key: sid,
        label,
        detail,
        tip: [str(s.barcode), str(s.specimen)].filter(Boolean).join('\n'),
        thumbnail: str(s.thumbnail_path) ? fileUrl(access, str(s.thumbnail_path)!) : null,
        files,
        report,
        slide: {
          id: sid,
          imageKey: sid,
          prefix: '',
          kind: 'brightfield',
          title: label,
          organ: str(b?.patient.organ) ?? '',
          diagnosis: str(s.specimen) ?? '',
          blurb: '',
          project: '',
          case: str(s.barcode) ?? '',
          sourceFile: '',
          gdcFileId: str(s.gdc_file_id) ?? '',
          source: '',
          sourceUrl: str(s.source_url) ?? '',
          vendor: str(s.vendor),
          objectivePower: num(s.objective_power) ?? 40,
          mpp: num(s.mpp),
          width,
          height,
          levels: num(s.levels)!,
          tileSize: 1022,
          overlap: 1,
          format: 'jpg',
          tileCount: num(s.tile_count) ?? 0,
          hotspots: parseJson<Hotspot[]>(s.hotspots, []).map(({ x, y }) => ({ x, y })),
          rawSizeBytes: num(s.raw_bytes) ?? 0,
          dzi: 'slide.dzi',
          tiles: 'slide_files',
          thumbnail: rel(str(s.thumbnail_path)) ?? 'thumbnail.jpg',
          raw: '',
          overlays: til
            ? [
                {
                  id: 'lymphocytes',
                  kind: 'image',
                  seriesUid: '',
                  file: rel(til)!,
                  x: num(s.til_x) ?? 0,
                  y: num(s.til_y) ?? 0,
                  fraction: num(s.til_width) ?? 1,
                  summary: tilPct !== null ? `AI flags ${fmtNum(tilPct * 100, 1)}% of tissue tiles as lymphocyte-rich` : undefined,
                },
              ]
            : [],
        },
        about: {
          title: label,
          specimen: [str(s.stain), str(s.specimen)].filter(Boolean).join(', ') || null,
          case: str(s.barcode),
          scanner: str(s.vendor) ? `${str(s.vendor)![0].toUpperCase()}${str(s.vendor)!.slice(1)}` : null,
          sourceUrl: str(s.source_url),
          license: epic ? 'TCGA images via NCI Imaging Data Commons, CC BY 3.0' : 'NIH GDC open access',
          item: epic ? 'Patient360' : 'Bronze_Oncology_Imaging',
          served: `Files/${root}/`,
          original: epic
            ? `Tiled from the ${fmtBytes(num(s.raw_bytes))} DICOM whole-slide image, which stays in the imaging archive.`
            : `The original ${fmtBytes(num(s.raw_bytes))} Aperio SVS stays in Files/raw.`,
        },
      } satisfies SlideImage;
    });
}

export function PathologyPanel({
  slide,
  slides,
  onSlide,
  access,
  b,
  height,
  compact = false,
  folded = false,
  startOverlays,
  startReport,
}: {
  slide: Row;
  slides: Row[];
  onSlide: (id: string) => void;
  access: FileAccess;
  /** The record, for the pathology report beside the slide. */
  b?: PatientBundle;
  /** Kept for callers that drew a slide stepper; the filmstrip steps through the slides now. */
  stepper?: boolean;
  height?: number | string;
  compact?: boolean;
  folded?: boolean;
  /** AI layers to show at the start, by id ('lymphocytes'), for Ask. */
  startOverlays?: string[];
  /** Open with the pathology report beside the slide, for Ask. */
  startReport?: boolean;
}) {
  const images = useMemo(() => slideImages(slides, access, b), [slides, access, b]);
  if (!images.length) return <p className="t-faint text-[13px]">The slide's deep-zoom tiles have not been built yet (scripts/25_patient360_viewers.py).</p>;
  const epic = !!slide.tile_root;
  return (
    <div className="min-w-0">
      {!compact && (
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="whitespace-nowrap text-[15px] font-medium">{epic ? 'H&E slide' : slide.role === 'frozen' ? 'Frozen section, H&E' : 'Diagnostic H&E slide'}</h3>
          <span className="mono t-faint truncate">{str(slide.barcode)}</span>
          <span className="src ml-auto">
            <span className="swatch sw-pathology" />
            {epic ? 'Patient360/Files/viewer, tiled from the DICOM in the imaging archive' : 'Bronze_Oncology_Imaging/Files/slides'}
          </span>
        </div>
      )}
      {!compact && !epic && (
        <div className="t-muted mb-2 text-[12.5px]">
          {str(slide.specimen)}
          {slide.role === 'frozen' ? '. Frozen sections are cut from the same tissue that was sequenced; the diagnostic slide is the fixed, paraffin-embedded section.' : ''}
        </div>
      )}
      <SlideWorkspace
        images={images}
        current={str(slide.slide_id)!}
        onSelect={onSlide}
        compact={compact}
        folded={folded}
        startOverlays={startOverlays}
        startReport={startReport}
        height={typeof height === 'number' ? `${height}px` : height}
      />
    </div>
  );
}

/* ================================================================== Radiology */

export type View = 'render' | 'multiplanar' | 'axial' | 'coronal' | 'sagittal';

type Measure = { volumeMl: number; components?: number; label?: number; colour?: string };

/** A record series in the imaging demo's study shape, so the 3D workspace shows it with every control. */
function seriesStudy(b: PatientBundle, s: Row): VolumeStudy {
  const ct = s.modality === 'CT';
  const outlined = s.labels_kind === 'radiologists';
  const organ = str(b.patient.organ) ?? '';
  const air = ct && ((outlined && !!s.labels_path) || /lung|colon/i.test(organ) || /chest|lung|thorax/i.test(`${str(s.body_part) ?? ''} ${str(s.description) ?? ''}`));
  const study = b.studies.find((x) => x.study_uid === s.study_uid);
  const tcga = b.source === 'research';
  return {
    id: String(s.series_uid),
    category: '',
    title: str(s.description) ?? (ct ? 'CT' : 'MRI'),
    subtitle: '',
    modality: ct ? 'CT' : 'MRI',
    description: str(s.description) ?? '',
    source: tcga
      ? 'The Cancer Imaging Archive TCGA collections, via the NCI Imaging Data Commons'
      : str(study?.source_collection)
        ? `${str(study?.source_collection)}, via the imaging archive`
        : 'The imaging archive',
    sourceUrl: str(s.source_url) ?? (str(study?.source_doi) ? `https://doi.org/${str(study?.source_doi)}` : ''),
    license: str(study?.source_license) ?? (tcga ? 'CC BY 3.0' : ''),
    citation: '',
    subject: tcga ? `TCGA case ${str(b.patient.patient_id)}` : 'Public images attached to a synthetic patient',
    scanner: [str(s.manufacturer), str(s.model)].filter(Boolean).join(' ') || undefined,
    thumbnail: str(s.thumbnail_path) ?? '',
    rawPath: '',
    rawFiles: num(s.raw_files) ?? 0,
    rawSizeBytes: num(s.raw_bytes) ?? 0,
    sizeBytes: num(s.volume_bytes) ?? 0,
    defaultView: ct && !outlined ? 'render' : 'multiplanar',
    defaultPreset: ct ? (air ? 'lungs' : 'contrast') : 'gray',
    defaultPreset2d: ct ? (air ? 'lung' : 'soft') : 'gray',
    layers: [
      { id: 'volume', label: ct ? 'CT' : 'MRI', kind: ct ? 'ct' : 'mri', file: str(s.volume_path)! },
      ...(s.labels_path
        ? [
            {
              id: 'labels',
              label: outlined ? 'Nodules outlined by radiologists' : 'AI segmentation',
              kind: 'labels',
              file: str(s.labels_path)!,
              lut: str(s.labels_lut_path) ?? undefined,
              opacity: 0.9,
              visible: true,
            },
          ]
        : []),
    ],
    dims: parseJson<number[]>(s.dims, []),
    spacingMm: parseJson<number[]>(s.spacing_mm, [1, 1, 1]),
  };
}

/** In plain words for a series from the record: what the scan is and what is drawn on it. */
function seriesNote(s: Row, measures: Record<string, Measure>): ImageNote {
  const ct = s.modality === 'CT';
  const names = Object.keys(measures);
  const outlined = s.labels_kind === 'radiologists' && names.length > 0;
  const region = (str(s.body_part) ?? '').toLowerCase().replace(/_/g, ' ');
  const of = region && !/^(unknown|other)$/.test(region) ? ` of the ${region}` : '';
  const slices = num(s.images) ? ` This one has ${num(s.images)} slices.` : '';
  let plain = ct
    ? `A CT scan${of}: X-ray images taken around the body and stacked into a 3D block.${slices} Air shows black and bone white, with soft tissue in shades of grey between them.`
    : `An MRI scan${of}: images made with a strong magnet and radio waves, stacked into a 3D block.${slices} MRI shows soft tissue in more detail than CT.`;
  if (outlined) plain += ` Radiologists in the LIDC study outlined ${names.length === 1 ? 'one nodule' : `${names.length} nodules`} on it, each in its own colour.`;
  else if (names.length) plain += ` An AI model outlined ${names.length === 1 ? names[0].toLowerCase() : `${names.slice(0, -1).join(', ').toLowerCase()} and ${names[names.length - 1].toLowerCase()}`} and measured the volume of each.`;
  const lookFor = outlined
    ? ['Go to in the legend centres the three slices on that nodule.', 'Lung under Colour shows the nodule against the air spaces.', '3D shows the outlines inside the chest; drag to turn it.']
    : names.length
      ? ['3D shows the segmentation inside the body; drag to turn it, or press Spin.', 'Clip cuts away the front of the body to any depth.', 'Controls in the details panel hides the segmentation to read the scan underneath.']
      : ct
        ? ['Drag in 3D to turn the body round; Spin turns it for you.', 'Axial, Coronal and Sagittal show one slice at a time: scroll to move through them.']
        : ['Scroll through the slices to follow the anatomy from top to bottom.', 'MPR shows three directions at once; click to move the crosshair.'];
  return {
    plain,
    lookFor,
    layers: {
      volume: ct ? 'The CT. The window under Colour picks which densities are shown.' : 'The MRI.',
      labels: outlined ? 'Each outlined nodule in its own colour.' : 'Each structure the AI found, in its own colour.',
    },
  };
}

export function RadiologyPanel({
  b,
  seriesKey,
  onSeries,
  stepper = true,
  list,
  startView,
  startNodule,
  height,
  compact = false,
  folded = false,
}: {
  b: PatientBundle;
  seriesKey: string | null;
  onSeries: (k: string) => void;
  /** Draw the scan timepoint slider; off when the record's tab already steps through scans. */
  stepper?: boolean;
  /** The series that have a volume; defaults to every radiology series (the TCGA patients'). */
  list?: Row[];
  /** How the scan opens (Ask's cards): the view, and the outlined nodule to centre on (1 is the largest). */
  startView?: View;
  startNodule?: number | null;
  height?: string;
  /** A narrow place (half of a side-by-side card): no details panel, the legend starts folded. */
  compact?: boolean;
  /** Start with the details panel folded (inside an answer). */
  folded?: boolean;
}) {
  const series = list ?? b.radiologySeries;
  const current = series.find((s) => s.series_key === seriesKey) ?? series.find((s) => s.role === 'primary') ?? series[0];
  const study = useMemo(() => (current ? seriesStudy(b, current) : null), [b, current]);
  const [legendOpen, setLegendOpen] = useState(!compact);
  const files = useMemo(() => (path: string) => fileUrl(b.access.radiology, path), [b.access.radiology]);

  if (!current || !study) return <div className="t-faint text-[13px]">No radiology for this patient.</div>;
  const measures = parseJson<Record<string, Measure>>(current.ai_measures, {});
  const segNames = Object.keys(measures);
  const outlined = current.labels_kind === 'radiologists';
  const colourFor = (name: string) =>
    measures[name]?.colour ??
    (/tumor|mass|nodule/i.test(name) ? 'rgb(255,143,82)' : /cyst/i.test(name) ? 'rgb(90,160,230)' : /liver/i.test(name) ? 'rgb(196,120,90)' : /lung/i.test(name) ? 'rgb(120,170,210)' : 'rgb(214,150,120)');
  // A CT with outlined nodules opens on the slices, centred on the largest (or the one asked about).
  const centre = (h: VolumeViewerHandle) => {
    if (!outlined) return;
    const list = Object.values(measures);
    const first = list[(startNodule ?? 1) - 1] ?? list[0];
    if (first?.label) h.goToLabel('labels', first.label);
  };

  return (
    <div className="min-w-0">
      {!compact && (
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="whitespace-nowrap text-[15px] font-medium">
            {current.epic
              ? `${current.modality === 'CT' ? 'CT' : 'MRI'}, ${fmtDate(str(current.date))}`
              : `${current.modality === 'CT' ? 'CT' : 'MRI'} ${(num(current.day) ?? 0) <= 0 ? 'before treatment' : `on ${fmtDay(num(current.day))}`}`}
          </h3>
          <span className="t-faint truncate text-[12.5px]">{str(current.description)}</span>
          <span className="src ml-auto">
            <span className="swatch sw-radiology" />
            {current.epic ? 'Patient360/Files/viewer, built from the DICOM in the imaging archive' : 'Bronze_Oncology_Imaging/Files/radiology'}
          </span>
        </div>
      )}
      {stepper && series.length > 1 && (
        <Scrubber
          name="Scan timepoints"
          gutter={92}
          leading={
            <>
              <div className="text-[12px]" style={{ color: 'var(--ink)' }}>
                {series.length} scans
              </div>
              <div>by day</div>
            </>
          }
          items={timepointItems(series)}
          selected={String(current.series_key)}
          onSelect={onSeries}
        />
      )}
      <VolumeWorkspace
        key={String(current.series_uid)}
        study={study}
        files={files}
        compact={compact}
        folded={folded}
        height={height}
        note={seriesNote(current, measures)}
        startView={startView ?? (current.modality === 'CT' && !current.labels_kind ? 'render' : compact ? 'axial' : 'multiplanar')}
        onLoaded={centre}
        storage={{
          item: current.epic ? 'Patient360' : 'Bronze_Oncology_Imaging',
          served: `Files/${String(current.volume_path).replace(/\/[^/]*$/, '/')}`,
          original: `${fmtBytes(num(current.raw_bytes))} DICOM (${num(current.raw_files)} files) in ${current.epic ? 'the imaging archive' : 'Files/raw'}`,
        }}
        aboutExtra={
          <>
            {current.date ? <AboutRow term="Date">{`${fmtDate(str(current.date))}${num(current.day) !== null ? `, ${fmtDay(num(current.day))}` : ''}`}</AboutRow> : null}
            {num(current.images) ? (
              <AboutRow term="Images">
                {`${num(current.images)}${num(current.slice_thickness_mm) ? `, ${num(current.slice_thickness_mm)} mm slices` : ''}${num(current.field_strength_t) ? `, ${num(current.field_strength_t)} T` : ''}`}
              </AboutRow>
            ) : null}
            {segNames.length > 0 && <AboutRow term={outlined ? 'Outlined by' : 'AI model'}>{str(current.ai_algorithm) ?? (outlined ? 'LIDC radiologists' : '')}</AboutRow>}
            {current.geometry_assumed ? <AboutRow term="Geometry">Secondary capture without geometry: 1 mm voxels assumed</AboutRow> : null}
          </>
        }
        overlay={(goTo) =>
          segNames.length > 0 &&
          (legendOpen ? (
            <div className="overlay-legend">
              <div className="flex items-baseline gap-3">
                <span className="font-medium">{outlined ? 'Nodules outlined by radiologists' : 'AI segmentation'}</span>
                <button className="link ml-auto" onClick={() => setLegendOpen(false)}>
                  Hide
                </button>
              </div>
              {segNames.map((n) => (
                <div key={n} className="mt-1 flex items-center gap-1.5">
                  <span className="swatch" style={{ background: colourFor(n) }} />
                  <span>{n}</span>
                  <span className="num ml-auto pl-3">{fmtNum(measures[n].volumeMl, outlined ? 2 : 1)} mL</span>
                  {outlined && measures[n].label ? (
                    <button className="link pl-2" onClick={() => goTo('labels', measures[n].label!)}>
                      Go to
                    </button>
                  ) : null}
                </div>
              ))}
              {!outlined && <div className="mt-1 max-w-[220px] text-[10.5px]">{str(current.ai_algorithm)}</div>}
            </div>
          ) : (
            <button className="overlay-legend" onClick={() => setLegendOpen(true)}>
              {outlined ? `${segNames.length} ${segNames.length === 1 ? 'nodule' : 'nodules'} outlined` : 'AI segmentation'}
              <span className="link pl-2">Show</span>
            </button>
          ))
        }
      />
    </div>
  );
}

function AboutRow({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[100px_1fr] gap-3 py-1 text-[12.5px]">
      <dt className="t-faint">{term}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** Scan timepoints placed by day relative to diagnosis. */
function timepointItems(series: Row[]): ScrubItem[] {
  const days = series.map((s) => num(s.day) ?? 0);
  const lo = Math.min(...days);
  const hi = Math.max(...days);
  return series.map((s, i) => ({
    id: String(s.series_key),
    at: hi > lo ? 0.07 + (0.86 * (days[i] - lo)) / (hi - lo) : 0.5,
    label: `${fmtDate(str(s.date))}, ${fmtDay(days[i])}: ${str(s.description) ?? ''}`,
    tick: fmtDay(days[i]),
  }));
}

/** What the AI measured across the scan timepoints, or that no segmentation is published. */
export function RadiologyFootnotes({ b }: { b: PatientBundle }) {
  const series = b.radiologySeries;
  const ai = series.find((s) => s.ai_measures);
  const liver = series.filter((s) => s.ai_measures && /liver/i.test(String(s.ai_measures)));
  return (
    <>
      {liver.length > 1 && (
        <p className="mt-4 max-w-[90ch] text-[13.5px]">
          AI-measured liver volume:{' '}
          {liver
            .map((s) => `${fmtNum(parseJson<Record<string, { volumeMl: number }>>(s.ai_measures, {}).Liver?.volumeMl, 0)} mL on ${fmtDay(num(s.day))}`)
            .join(', then ')}
          . Step between the scans to compare.
        </p>
      )}
      {!ai && series.length > 0 && (
        <p className="t-faint mt-3 text-[12px]">No AI segmentation is published for this patient's scan in NCI Imaging Data Commons.</p>
      )}
    </>
  );
}

/** A chest X-ray (DX or CR): each view zoomable, from the PNGs made from the DICOM (scripts/25_patient360_viewers.py). */
export function XrayPanel({ series, access, height }: { series: Row; access: FileAccess; height?: string }) {
  const images = parseJson<{ file: string; width: number; height: number; view: string }[]>(series.xray_images, []);
  const [at, setAt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const image = images[Math.min(at, images.length - 1)];
  useEffect(() => {
    if (!hostRef.current || !image) return;
    const viewer = OpenSeadragon({
      element: hostRef.current,
      tileSources: { type: 'image', url: fileUrl(access, `${str(series.xray_folder)}/${image.file}`) } as unknown as OpenSeadragon.TileSourceOptions,
      showNavigationControl: false,
      animationTime: 0.9,
      maxZoomPixelRatio: 3,
      visibilityRatio: 0.5,
      gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: true },
      crossOriginPolicy: 'Anonymous',
    });
    return () => viewer.destroy();
  }, [image, series.xray_folder, access]);
  useEffect(() => {
    const t = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
    return () => window.clearTimeout(t);
  }, [expanded]);
  if (!image) return <div className="t-faint text-[13px]">No images were made for this X-ray.</div>;
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-baseline gap-3">
        <h3 className="text-[15px] font-medium">X-ray, {fmtDate(str(series.date))}</h3>
        <span className="t-faint truncate text-[12.5px]">{str(series.description)}</span>
        <span className="src ml-auto">
          <span className="swatch sw-radiology" />
          Patient360/Files/viewer, made from the DICOM in the imaging archive
        </span>
      </div>
      <div className="toolbar mb-2">
        {images.length > 1 && (
          <div className="seg" role="group" aria-label="View">
            {images.map((im, i) => (
              <button key={im.file} aria-pressed={i === at} onClick={() => setAt(i)}>
                {im.view && images.filter((x) => x.view === im.view).length === 1 ? im.view : `Image ${i + 1}`}
              </button>
            ))}
          </div>
        )}
        <button className="btn ml-auto" onClick={() => setExpanded((v) => !v)}>{expanded ? 'Close' : 'Expand'}</button>
      </div>
      <div className={`well well-dark ${expanded ? 'expanded' : ''}`} style={{ height: expanded ? undefined : height ?? 'clamp(520px, 70vh, 860px)' }}>
        <div ref={hostRef} className="absolute inset-0" />
        {expanded && <button className="btn absolute right-3 top-3 z-10" onClick={() => setExpanded(false)}>Close</button>}
      </div>
      <div className="t-faint mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
        <span className="num">
          {image.width} × {image.height} px shown
        </span>
        <span>
          Original {fmtBytes(num(series.raw_bytes))} DICOM ({num(series.raw_files)} {num(series.raw_files) === 1 ? 'file' : 'files'}) stays in the imaging archive
        </span>
      </div>
    </div>
  );
}
