import { useMemo, useState } from 'react';

import { caseImages, viewSlideFor } from '@/components/imaging/cases';
import { SlideWorkspace, type SlideImage } from '@/components/imaging/SlideWorkspace';
import type { TractStart } from '@/components/imaging/Tracts';
import type { CaseImage, Locator, Slide, VolumeStudy } from '@/components/imaging/types';
import { VolumeWorkspace, type PageView } from '@/components/imaging/VolumeWorkspace';
import { fileUrl, parseJson, str, type PatientBundle, type Row } from '@/lib/api';
import { fmtDate } from '@/lib/format';

/** The URL of a file in a showcase study's folder (Patient360/Files/viewer/<patient>/showcase/<study>). */
export function showcaseFiles(b: PatientBundle, row: Row): Locator {
  const folder = str(row.folder)!;
  return (path) => fileUrl(b.access.radiology, `${folder}/${path}`);
}

function caseDetail(img: CaseImage): string {
  return [img.preparation === 'FFPE' ? 'FFPE' : 'Frozen', img.sample === 'Normal tissue' ? 'normal' : '', img.overlays.length ? 'AI' : '']
    .filter(Boolean)
    .join(' · ');
}

/** A showcase slide and the other slides of the TCGA case it comes from, as the slide workspace shows them. */
export function showcaseSlides(b: PatientBundle, row: Row): SlideImage[] {
  const slide = parseJson<Slide | null>(row.meta_json, null);
  if (!slide) return [];
  const files = showcaseFiles(b, row);
  const about = {
    title: slide.title,
    specimen: slide.diagnosis,
    project: slide.project,
    case: slide.case,
    scanner: slide.vendor ? `${slide.vendor[0].toUpperCase()}${slide.vendor.slice(1)}` : null,
    source: slide.source,
    sourceUrl: slide.sourceUrl,
    license: str(row.license),
    item: 'Patient360 (copied from the imaging demo)',
    served: `Files/${str(row.folder)}/`,
    original: slide.kind === 'fluorescence' ? `${slide.sourceFile}, in the NCI Imaging Data Commons` : `${slide.sourceFile}, at the NCI Genomic Data Commons`,
  };
  const report = slide.caseInfo?.report
    ? { url: files(slide.caseInfo.report.file), title: 'Pathology report', sourceUrl: slide.caseInfo.report.sourceUrl }
    : null;
  const images = caseImages(slide);
  if (!images.length) {
    return [
      {
        key: slide.id,
        label: slide.title,
        detail: slide.kind === 'fluorescence' ? `${slide.channels?.length ?? 0}-plex fluorescence` : 'H&E',
        tip: slide.blurb,
        thumbnail: files(slide.thumbnail),
        slide: viewSlideFor(slide, null),
        files,
        caseInfo: slide.caseInfo ?? null,
        report,
        about,
      },
    ];
  }
  return images.map((img) => {
    const view = viewSlideFor(slide, img);
    return {
      key: img.key,
      label: img.label,
      detail: caseDetail(img),
      tip: [img.barcode, img.preparation === 'FFPE' ? 'Formalin-fixed, paraffin-embedded (diagnostic quality)' : 'Frozen section'].join('\n'),
      thumbnail: files(view.thumbnail),
      slide: view,
      files,
      caseInfo: slide.caseInfo ?? null,
      caseImage: img,
      report,
      about,
    };
  });
}

/** A study from the imaging demo in the record: its viewer with every control, and what it is doing here. */
export function ShowcasePanel({
  b,
  row,
  compact = false,
  height,
  startView,
  startFrame,
  startLayers,
  startTracts,
  startFull,
  startOverlays,
  startChannels,
  startSlide,
  startReport,
  folded = false,
}: {
  b: PatientBundle;
  row: Row;
  compact?: boolean;
  height?: string;
  startView?: PageView;
  startFrame?: number;
  /** Volume layers to show at the start, by id (Ask). */
  startLayers?: string[];
  /** The brain fibre-tract atlas's bundles, colour and map at the start (Ask). */
  startTracts?: TractStart;
  /** Open on the study's full-size files (Ask). */
  startFull?: boolean;
  /** Slide AI layers to show at the start, by id (Ask). */
  startOverlays?: string[];
  /** Fluorescence marker channels to show at the start, by id (Ask). */
  startChannels?: string[];
  /** The slide of the case to open on, by its key (Ask). */
  startSlide?: string;
  /** Open with the case's pathology report beside the slide (Ask). */
  startReport?: boolean;
  folded?: boolean;
}) {
  const files = useMemo(() => showcaseFiles(b, row), [b, row]);
  const slides = useMemo(() => (row.section === 'pathology' ? showcaseSlides(b, row) : []), [b, row]);
  const study = useMemo(() => (row.section === 'radiology' ? parseJson<VolumeStudy | null>(row.meta_json, null) : null), [row]);
  const [key, setKey] = useState<string | null>(null);
  return (
    <div className="min-w-0">
      {!compact && (
        <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="whitespace-nowrap text-[15px] font-medium">{str(row.title)}</h3>
          <span className="t-faint truncate text-[12.5px]">
            {str(row.modality)} · {fmtDate(str(row.date))}
          </span>
          {row.atlas ? <span className="syn-tag">population atlas</span> : <span className="src">public images, synthetic patient</span>}
          <span className="src ml-auto">
            <span className={`swatch ${row.section === 'radiology' ? 'sw-radiology' : 'sw-pathology'}`} />
            Patient360/Files/{str(row.folder)}
          </span>
        </div>
      )}
      {!compact && <p className="t-muted mb-3 max-w-[110ch] text-[13px] leading-relaxed">{str(row.note)}</p>}
      {study ? (
        <VolumeWorkspace
          study={study}
          files={files}
          compact={compact}
          height={height}
          startView={startView}
          startFrame={startFrame}
          startLayers={startLayers}
          startTracts={startTracts}
          startFull={startFull}
          folded={folded}
          storage={{ item: 'Patient360 (copied from the imaging demo)', served: `Files/${str(row.folder)}/`, original: str(row.source) ?? undefined }}
        />
      ) : slides.length ? (
        <SlideWorkspace
          images={slides}
          current={key ?? (slides.some((x) => x.key === startSlide) ? startSlide! : slides[0].key)}
          onSelect={setKey}
          compact={compact}
          folded={folded}
          height={height}
          startOverlays={startOverlays}
          startChannels={startChannels}
          startReport={startReport}
        />
      ) : (
        <p className="t-faint text-[13px]">This study's description could not be read.</p>
      )}
      {!compact && (
        <p className="t-faint mt-2 max-w-[110ch] text-[11.5px] leading-snug">
          {str(row.description)} {str(row.source)}, {str(row.license)}.
        </p>
      )}
    </div>
  );
}
