import type { CaseImage, Slide, SlideOverlay } from './types';

/** A slide as the viewer sees it: the catalog slide, or another slide from the same case under `prefix`. */
export type ViewSlide = Slide & { imageKey: string; prefix: string; overlays: SlideOverlay[] };

export function caseImages(slide: Slide): CaseImage[] {
  return slide.caseInfo?.images ?? [];
}

export function findImage(slide: Slide, key: string | null): CaseImage | null {
  const images = caseImages(slide);
  return images.find((i) => i.key === key) ?? images[0] ?? null;
}

export function viewSlideFor(slide: Slide, image: CaseImage | null): ViewSlide {
  if (!image || image.key === 'main' || !image.width || !image.height || !image.levels) {
    return { ...slide, imageKey: 'main', prefix: '', overlays: image?.overlays ?? [] };
  }
  const prefix = image.prefix ?? `case/${image.key}/`;
  return {
    ...slide,
    imageKey: image.key,
    prefix,
    overlays: image.overlays,
    kind: 'brightfield',
    channels: undefined,
    width: image.width,
    height: image.height,
    levels: image.levels,
    tileSize: image.tileSize ?? slide.tileSize,
    overlap: image.overlap ?? slide.overlap,
    format: image.format ?? 'jpg',
    tileCount: image.tileCount ?? 0,
    tilesBytes: image.tilesBytes,
    objectivePower: image.objectivePower ?? null,
    mpp: image.mpp ?? null,
    hotspots: image.hotspots ?? [],
    rawSizeBytes: image.rawSizeBytes ?? 0,
    sourceFile: image.sourceFile ?? slide.sourceFile,
    sourceUrl: image.sourceUrl ?? slide.sourceUrl,
    gdcFileId: image.gdcFileId ?? slide.gdcFileId,
    thumbnail: `${prefix}thumbnail.jpg`,
  };
}

export function sampleShort(image: CaseImage): string {
  return [image.sample, image.preparation === 'FFPE' ? 'FFPE' : 'frozen'].join(' · ');
}

export function formatYears(y: number): string {
  if (y < 1) return `${Math.max(1, Math.round(y * 12))} months`;
  return `${y.toFixed(y < 10 ? 1 : 0)} years`;
}
