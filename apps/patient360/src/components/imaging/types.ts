/**
 * Image catalogs in the imaging demo's shapes (the Rayfin imaging demo's rayfin/functions/src/types.ts): the showcase
 * studies keep them as they are, and the record's own slides and scans are described in the same shapes, so one set
 * of viewers shows both.
 */

type SlideCatalog = { title: string; generatedAt: string; slides: { id: string; caseInfo?: undefined | { patient: { caseId: string; project: string; projectName: string; primarySite: null | string; diseaseType: null | string; sex: null | string; ageAtDiagnosis: null | number; yearOfDiagnosis: null | number; primaryDiagnosis: null | string; morphology: null | string; tissueOrigin: null | string; site: null | string; stage: null | string; stagingSystem: string; t: null | string; n: null | string; m: null | string; grade: null | string; gleason: null | string; priorMalignancy: null | string; priorCancers: string[]; treatments: string[]; vitalStatus: null | string; survivalYears: null | number; followUpYears: null | number; gdcCaseUrl: string }; genomics: { mutations: { gene: string; change: string; type: string; impact: string; dna: string }[]; mutationCount: number; proteinChangingCount: number; copyNumber: null | { method: null | string; genesMeasured: number; ploidy: number; amplifiedFrom: number; fractionAltered: number; calls: { gene: string; copies: number; call: string; chromosome: string | null; }[]; callsTotal: number }; expression: null | { method: string; genesMeasured: number; panel: { gene: string; tpm: number; percentile: number; }[] } }; report: null | { file: string; bytes: number; gdcFileId: string; sourceUrl: string }; published: { type: string; category: null | string; files: number; bytes: number }[]; images: { key: string; barcode: string; label: string; sample: string; preparation: string; section?: undefined | null | string; composition: { [k: string]: number }; overlays: { id: string; kind: string; seriesUid: string; prefix?: string | undefined; format?: string | undefined; tileSize?: number | undefined; minLevel?: number | undefined; levels?: number | undefined; tileCount?: number | undefined; drawnTiles?: number | undefined; tilesBytes?: number | undefined; count?: number | null | undefined; file?: string | undefined; width?: number | undefined; patchUm?: number | undefined; patches?: number | undefined; positivePatches?: number | undefined; tissuePatches?: number | undefined; bytes?: number | undefined }[]; prefix?: undefined | string; gdcFileId?: undefined | string; sourceUrl?: undefined | string; sourceFile?: undefined | string; width?: undefined | number; height?: undefined | number; levels?: undefined | number; tileSize?: undefined | number; overlap?: undefined | number; format?: undefined | string; tileCount?: undefined | number; tilesBytes?: undefined | number; objectivePower?: undefined | null | number; mpp?: undefined | null | number; hotspots?: undefined | { x: number; y: number; }[]; rawSizeBytes?: undefined | number }[] }; study?: undefined | { studyInstanceUid: string; patientName: string; patientId: string; studyDate: string; studyTime: string; modalities: string; description: string }; kind?: undefined | string; license?: undefined | string; channels?: undefined | { id: string; name: string; meaning: string; group?: undefined | 'featured' | 'protein' | 'reference'; color: string; visible: boolean; dzi: string; tiles: string; tileCount: number; tilesBytes: number }[]; markersAvailable?: undefined | number; title: string; organ: string; diagnosis: string; blurb: string; project: string; case: string; sourceFile: string; gdcFileId: string; source: string; sourceUrl: string; vendor: null | string; objectivePower: null | number; mpp: null | number; width: number; height: number; levels: number; tileSize: number; overlap: number; format: string; tileCount: number; tilesBytes?: undefined | number; hotspots: { x: number; y: number }[]; rawSizeBytes: number; dzi: string; tiles: string; thumbnail: string; raw: string }[]; lakehouse: { workspaceId: string; workspaceName: string; lakehouseId: string; lakehouseName: string; oneLakePath: string; portalUrl: string }; tileAccess: { mode: 'sas' | 'proxy'; baseUrl: string; query: string; expiresOn: string; reason: string }; servedAt: string };

type VolumeCatalog = { title: string; generatedAt: string; studies: { id: string; category: string; nonCommercial?: undefined | false | true; title: string; subtitle: string; modality: string; description: string; source: string; sourceUrl: string; license: string; citation: string; subject: string; patientId?: undefined | string; study?: undefined | { studyInstanceUid: string; patientName: string; patientId: string; studyDate: string; studyTime: string; modalities: string; description: string }; scanner?: undefined | string; thumbnail: string; rawPath: string; rawFiles: number; rawSizeBytes: number; sizeBytes: number; defaultView: string; defaultClip?: undefined | { on: boolean; depth: number; face: 'front' | 'side' | 'top' }; stats?: undefined | { [k: string]: number }; layers: { id: string; label: string; kind: string; frames4d?: undefined | false | true; file?: undefined | string; frameKey?: undefined | string; lut?: undefined | string; colormap?: undefined | string; calMin?: undefined | number; calMax?: undefined | number; opacity?: undefined | number; visible?: undefined | false | true; unit?: undefined | string; bytes?: undefined | number }[]; defaultCamera?: undefined | { azimuth: number; elevation: number }; defaultPreset?: undefined | string; views?: undefined | string[]; mip?: undefined | { sprite: string; frames: number; cols: number; frameWidth: number; frameHeight: number; label: string; colormap: string; bytes: number }; timeline?: undefined | { label: string; unit: string; initial: number; mode?: undefined | string; fps?: undefined | number; loop?: undefined | false | true; frames: { value: number; label: string; note?: undefined | string; frameIndex?: undefined | number; brainVolumeMl?: undefined | number; layers: { [k: string]: string }; bytes: number }[] }; dims: number[]; spacingMm: number[] }[]; lakehouse: { workspaceId: string; workspaceName: string; lakehouseId: string; lakehouseName: string; oneLakePath: string; portalUrl: string }; access: { baseUrl: string; query: string; expiresOn: string; reason: string }; servedAt: string };

export type Slide = SlideCatalog['slides'][number];
export type CaseInfo = NonNullable<Slide['caseInfo']>;
export type CaseImage = CaseInfo['images'][number];
export type SlideOverlay = CaseImage['overlays'][number] & {
  /** Where an image overlay starts on the slide, in units of the slide width (Patient 360's lymphocyte maps). */
  x?: number;
  y?: number;
  /** Its width in units of the slide width. */
  fraction?: number;
  /** One line on what the layer found, when the catalog has no counts. */
  summary?: string;
};
export type Channel = NonNullable<Slide['channels']>[number];
/** A tract's volume across the people of a population atlas, in mL. */
export type TractVolume = { people: number; of: number; medianMl: number; p25Ml: number; p75Ml: number; minMl: number; maxMl: number };
/**
 * One bundle of a tractography atlas (scripts/31_patient360_tractography.py): its lines in its group's file
 * (`first`, `lines`), what the publisher's data says about it, and its probability map and volume on the template.
 */
export type TractBundle = {
  id: string;
  abbr: string;
  name: string;
  side: 'left' | 'right' | null;
  /** The tracts layer (group file) its lines are in. */
  group: string;
  first: number;
  lines: number;
  atlasLines: number;
  lengthMm: number;
  zMm: [number, number];
  yMm: [number, number];
  /** The middle of its lines, in mm: where the slices go when its map is shown. */
  centreMm?: [number, number, number];
  colour: string;
  otherNames?: string;
  /** Brodmann areas it reaches, with the share of people in whom it does. */
  cortex?: { area: string; share: number }[];
  /** HCP-MMP areas it reaches. */
  mmp?: { area: string; share: number }[];
  prob?: string;
  mask?: string | null;
  figure?: string;
  volume?: TractVolume;
  /** The corpus callosum's parts, each with its own probability map and volume. */
  parts?: { id: string; name: string; prob?: string | null; volume?: TractVolume | null }[];
};
export type AtlasFigure = { file: string; small: string; title: string; bundles: string[]; width: number; height: number; bytes: number };
export type AtlasDownload = { file: string; bytes: number; what: string; url: string };
/** A tractography atlas's bundles, figures and downloads, where the study has them. */
export type AtlasParts = {
  bundles?: TractBundle[];
  areaNames?: Record<string, string>;
  /** The atlas's lowest point, in mm: a tract going on into the spinal cord leaves it here. */
  floorMm?: number;
  figures?: AtlasFigure[];
  downloads?: AtlasDownload[];
};

/** The study's layers at their original resolution, where the default ones are reduced (Patient 360's 32). */
export type FullSize = { layers: VolumeCatalog['studies'][number]['layers']; dims: number[]; spacingMm: number[]; sizeBytes: number };

/** A study; `defaultPreset2d` is the window its slices open in (the record's CTs: lung for chest, else soft tissue). */
export type VolumeStudy = VolumeCatalog['studies'][number] & { defaultPreset2d?: string; fullSize?: FullSize } & AtlasParts;
export type VolumeLayer = VolumeStudy['layers'][number];

/** The URL of a file, from its path relative to the study's folder (signed for OneLake, or local). */
export type Locator = (path: string) => string;

/** The file a layer shows for the current timeline frame (or its static file). */
export function layerFile(study: VolumeStudy, layer: VolumeLayer, frameIndex: number): string | undefined {
  if (layer.file) return layer.file;
  const frame = study.timeline?.frames[frameIndex];
  return layer.frameKey && frame ? frame.layers[layer.frameKey] : undefined;
}

export function frameBytes(study: VolumeStudy, frameIndex: number): number {
  const frame = study.timeline?.frames[frameIndex];
  return frame && frame.bytes ? frame.bytes : study.sizeBytes;
}

export function formatMb(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
}
