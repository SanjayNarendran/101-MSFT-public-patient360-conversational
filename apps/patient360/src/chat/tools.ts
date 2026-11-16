/**
 * Ask's tools, run in the page. Copilot calls a tool on the chat server (chat/tools.py describes them); the server
 * sends a page_request and the page runs it here, through the same data API the record uses (local DuckDB or the
 * Fabric App's functions). Data tools return text for the model. Display tools also return a card, drawn with the
 * record's own viewers, and their text says what the card shows so the model can check it and write about it.
 */
import { buildModel, type Mark, type MarkKind } from '@/components/patient/Timeline';
import { notesApi } from '@/hooks/useNotes';
import {
  fetchDocument,
  fetchRequests,
  num,
  parseJson,
  queryRecords,
  searchPatients,
  str,
  type PatientBundle,
  type PatientListRow,
  type QuerySpec,
  type Row,
  type SearchRequest,
} from '@/lib/api';
import type { TractBundle } from '@/components/imaging/types';
import { describe, flag } from '@/lib/clinical';

export type Args = Record<string, unknown>;

export interface ToolCtx {
  getPatient: (id: string) => Promise<PatientBundle>;
  /** Adds patients to the conversation's strip. */
  addPatients: (rows: { id: string; name: string }[]) => void;
}

export type Series = {
  patientId: string;
  name: string;
  test: string;
  unit: string | null;
  ref?: [number, number];
  points: { date: string; value: number; flag: 'high' | 'low' | null }[];
};

export type Card =
  | { kind: 'patients'; title: string; note?: string; rows: PatientListRow[] }
  | {
      kind: 'timeline';
      title: string;
      bundles: PatientBundle[];
      kinds: string[];
      align: string;
      match?: string;
      from?: string;
      to?: string;
      anchors: (string | null)[];
    }
  | {
      kind: 'measurements';
      title: string;
      tests: string[];
      series: Series[];
      marks: string[];
      from?: string;
      to?: string;
    }
  | {
      kind: 'scan';
      title: string;
      bundle: PatientBundle;
      seriesKey: string;
      view: string;
      nodule: number | null;
    }
  | { kind: 'slide'; title: string; bundle: PatientBundle; slideId: string; overlays?: string[] | null; report?: boolean }
  | {
      kind: 'showcase';
      title: string;
      bundle: PatientBundle;
      studyId: string;
      view?: string | null;
      frame?: number | null;
      layers?: string[] | null;
      overlays?: string[] | null;
      channels?: string[] | null;
      report?: boolean;
      /** The brain fibre-tract atlas: the bundles drawn, their colour and the map on the slices. */
      tracts?: { bundles?: string[]; colour?: 'direction' | 'bundle'; map?: string } | null;
      /** Open the study's original-resolution files. */
      full?: boolean;
    }
  | { kind: 'xray'; title: string; bundle: PatientBundle; series: Row }
  | { kind: 'document'; title: string; bundle: PatientBundle; doc: Row | null }
  | { kind: 'genome'; title: string; bundle: PatientBundle; genome: string }
  | {
      kind: 'side';
      title: string;
      subtitle?: string;
      panes: { label: string; note?: string; card: Card }[];
      facts?: { label: string; values: string[] }[];
    }
  | {
      kind: 'chart';
      title: string;
      subtitle?: string;
      spec: Record<string, unknown>;
      rows: Row[];
    }
  | {
      kind: 'record';
      title: string;
      patientId: string;
      name: string;
      tab: string;
      item: string | null;
    }
  | {
      kind: 'note';
      title: string;
      patientId: string;
      name: string;
      text: string;
      about: string | null;
    };

export type ToolResult = { text: string; card?: Card };

const PID = /^(Z\d{7}|TCGA-[A-Z0-9]{2}-[A-Z0-9]{4})$/i;

class ToolError extends Error {}
const fail = (msg: string): never => {
  throw new ToolError(msg);
};

/* ------------------------------------------------------------------ small helpers */

const day = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v : v == null ? null : String(v);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};
const words = (v: unknown) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
/** A document, study or slide id, also when given as a timeline item id (d:…, r:…, sl:…, sc:…). */
const itemId = (v: unknown) => words(v).replace(/^(d|r|sl|sc):/, '');
const fmt = (n: number | null, digits = 1) => (n === null ? '' : Number.isInteger(n) ? String(n) : n.toFixed(digits).replace(/\.0+$/, ''));
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);
const int = (v: unknown, d: number, lo: number, hi: number) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : d;
};
const inRange = (d: string | null, from?: string, to?: string) => !!d && (!from || d >= from) && (!to || d <= to);

function patientId(v: unknown): string {
  const id = String(v ?? '')
    .trim()
    .toUpperCase();
  if (!PID.test(id))
    fail(`'${String(v ?? '')}' is not a patient ID. IDs look like Z1002519 or TCGA-J2-8192; find_patients resolves names.`);
  return id;
}

function patientIds(v: unknown, max = 12): string[] {
  const ids = [...new Set(list(v).map(patientId))];
  if (!ids.length) fail('Give at least one patient ID.');
  if (ids.length > max) fail(`Up to ${max} patients at a time.`);
  return ids;
}

const nameOf = (b: PatientBundle) => str(b.patient.display_name) ?? str(b.patient.patient_id) ?? '';
const idOf = (b: PatientBundle) => str(b.patient.patient_id) ?? '';
const who = (b: PatientBundle) => `${nameOf(b)} (${idOf(b)})`;

/* ------------------------------------------------------------------ tests and vital signs */

const TEST_ALIASES: Record<string, string[]> = {
  a1c: ['HbA1c'],
  hba1c: ['HbA1c'],
  'hemoglobin a1c': ['HbA1c'],
  'haemoglobin a1c': ['HbA1c'],
  'glycated hemoglobin': ['HbA1c'],
  'blood pressure': ['Systolic BP', 'Diastolic BP'],
  bp: ['Systolic BP', 'Diastolic BP'],
  systolic: ['Systolic BP'],
  diastolic: ['Diastolic BP'],
  'systolic blood pressure': ['Systolic BP'],
  'diastolic blood pressure': ['Diastolic BP'],
  bmi: ['Body mass index'],
  gfr: ['eGFR'],
  egfr: ['eGFR'],
  'kidney function': ['eGFR', 'Creatinine'],
  'renal function': ['eGFR', 'Creatinine'],
  ldl: ['LDL cholesterol'],
  hdl: ['HDL cholesterol'],
  cholesterol: ['Total cholesterol'],
  lipids: ['Total cholesterol', 'LDL cholesterol', 'HDL cholesterol', 'Triglycerides'],
  hemoglobin: ['Haemoglobin'],
  haemoglobin: ['Haemoglobin'],
  hgb: ['Haemoglobin'],
  hb: ['Haemoglobin'],
  wbc: ['White cells'],
  'white blood cells': ['White cells'],
  'white cell count': ['White cells'],
  leukocytes: ['White cells'],
  plt: ['Platelets'],
  pulse: ['Heart rate'],
  spo2: ['Oxygen saturation'],
  'o2 saturation': ['Oxygen saturation'],
  temp: ['Temperature'],
  bun: ['Urea nitrogen (BUN)'],
  urea: ['Urea nitrogen (BUN)'],
  glucose: ['Glucose'],
  'blood sugar': ['Glucose'],
  psa: ['Prostate specific Ag'],
  alt: ['ALT'],
  ast: ['AST'],
  'phq-9': ['PHQ-9 depression score'],
  phq9: ['PHQ-9 depression score'],
  smoking: ['Tobacco'],
  tobacco: ['Tobacco'],
  pain: ['Pain (0–10)'],
  weight: ['Weight'],
  height: ['Height'],
};

type Obs = { def: ReturnType<typeof describe>; row: Row };
function observations(b: PatientBundle): Obs[] {
  return b.observations.map((row) => ({
    def: describe(str(row.name) ?? '', str(row.category)),
    row,
  }));
}

/** The test names in the record that a reader's name refers to. */
function resolveTests(asked: string[], obs: Obs[]): Map<string, string[]> {
  const names = [...new Set(obs.map((o) => o.def.name))];
  const out = new Map<string, string[]>();
  for (const a of asked) {
    const q = a.trim().toLowerCase();
    const targets = TEST_ALIASES[q] ?? [a.trim()];
    const hits: string[] = [];
    for (const t of targets) {
      const tl = t.toLowerCase();
      const exact = names.filter((n) => n.toLowerCase() === tl);
      const loose = exact.length ? exact : names.filter((n) => tl.length >= 3 && n.toLowerCase().includes(tl));
      hits.push(...loose);
    }
    out.set(a, [...new Set(hits)]);
  }
  return out;
}

function seriesFor(b: PatientBundle, tests: string[], from?: string, to?: string): { series: Series[]; missing: string[] } {
  const obs = observations(b);
  const resolved = resolveTests(tests, obs);
  const series: Series[] = [];
  const missing: string[] = [];
  for (const [asked, names] of resolved) {
    if (!names.length) missing.push(asked);
    for (const name of names) {
      const rows = obs.filter((o) => o.def.name === name);
      const ref = rows[0]?.def.ref;
      const points = rows
        .map((o) => ({ date: day(o.row.date), value: num(o.row.value) }))
        .filter((p): p is { date: string; value: number } => !!p.date && p.value !== null && inRange(p.date, from, to))
        .map((p) => ({ ...p, flag: flag(p.value, ref) }));
      if (!series.some((s) => s.test === name))
        series.push({
          patientId: idOf(b),
          name: nameOf(b),
          test: name,
          unit: str(rows[0]?.row.units),
          ref,
          points,
        });
    }
  }
  return { series, missing };
}

function describeSeries(s: Series, maxValues: number): string {
  const p = s.points;
  const head = `${s.test}${s.unit ? ` (${s.unit})` : ''}${s.ref ? `, usual adult range ${s.ref[0]}–${s.ref[1]}` : ''}`;
  if (!p.length) return `${head}: no values in the range asked.`;
  const vals = p.map((x) => x.value);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const high = p.filter((x) => x.flag === 'high').length;
  const low = p.filter((x) => x.flag === 'low').length;
  let shown = p;
  if (p.length > maxValues) {
    const step = (p.length - 1) / (maxValues - 1);
    const keep = new Set(Array.from({ length: maxValues }, (_, i) => Math.round(i * step)));
    keep.add(vals.indexOf(lo));
    keep.add(vals.indexOf(hi));
    shown = p.filter((_, i) => keep.has(i));
  }
  return [
    `${head}: ${plural(p.length, 'value')} from ${p[0].date} to ${p[p.length - 1].date}; first ${fmt(p[0].value, 2)}, last ${fmt(p[p.length - 1].value, 2)}, lowest ${fmt(lo, 2)}, highest ${fmt(hi, 2)}${high ? `; ${high} above the range` : ''}${low ? `; ${low} below it` : ''}.`,
    `  ${shown.length < p.length ? `${shown.length} of the values, spread across the range: ` : 'Values: '}${shown.map((x) => `${x.date} ${fmt(x.value, 2)}${x.flag ? ` ${x.flag === 'high' ? 'H' : 'L'}` : ''}`).join('; ')}`,
  ].join('\n');
}

/* ------------------------------------------------------------------ the record as text */

const KEY_LABS = [
  'HbA1c',
  'Glucose',
  'Creatinine',
  'eGFR',
  'Sodium',
  'Potassium',
  'Total cholesterol',
  'LDL cholesterol',
  'HDL cholesterol',
  'Triglycerides',
  'Haemoglobin',
  'White cells',
  'Platelets',
  'Albumin',
  'ALT',
  'AST',
  'Prostate specific Ag',
];
const KEY_VITALS = [
  'Systolic BP',
  'Diastolic BP',
  'Heart rate',
  'Respiratory rate',
  'Oxygen saturation',
  'Temperature',
  'Weight',
  'Height',
  'Body mass index',
  'Pain (0–10)',
  'Tobacco',
];

function latest(b: PatientBundle, names: string[]): string[] {
  const obs = observations(b);
  const out: string[] = [];
  for (const n of names) {
    const rows = obs.filter((o) => o.def.name === n);
    const last = rows[rows.length - 1];
    if (!last) continue;
    const v = num(last.row.value);
    const f = flag(v, last.def.ref);
    out.push(
      `${n} ${v !== null ? fmt(v, 2) : words(last.row.value_text)}${str(last.row.units) && v !== null ? ` ${str(last.row.units)}` : ''} (${day(last.row.date)}${rows.length > 1 ? `, ${rows.length} values` : ''})${f ? ` ${f}` : ''}`
    );
  }
  return out;
}

function viewerSeries(b: PatientBundle): Row[] {
  return b.radiologySeries.filter((s) => s.volume_path);
}
function xraySeries(b: PatientBundle): Row[] {
  return b.radiologySeries.filter((s) => s.xray_folder);
}
function viewerSlides(b: PatientBundle): Row[] {
  return b.source === 'epic' ? b.slides.filter((s) => s.tile_root) : b.slides;
}

function nodulesOf(b: PatientBundle, studyUid: unknown): Row[] {
  return b.nodules.filter((n) => n.study_uid === studyUid);
}

function noduleLine(n: Row): string {
  return `${str(n.label) ?? 'Nodule'}: ${fmt(num(n.diameter_mm))} mm${num(n.volume_mm3) ? `, ${fmt(num(n.volume_mm3), 0)} mm³` : ''}${str(n.lobe) ? `, ${str(n.lobe)}` : ''}${str(n.texture) ? `, ${str(n.texture)?.toLowerCase()}` : ''}${num(n.malignancy) ? `, malignancy ${fmt(num(n.malignancy))}/5` : ''}${num(n.readers) ? `, ${num(n.readers)} readers` : ''}`;
}

function imagingText(b: PatientBundle, detail: boolean): string[] {
  const lines: string[] = [];
  if (b.source === 'epic') {
    const online = b.studies.filter((s) => str(s.availability) === 'ONLINE');
    lines.push(
      `PACS: ${plural(b.studies.length, 'study', 'studies')}, ${online.length} online with images, ${b.studies.length - online.length} archived offline (index and report only).`
    );
    const viewers = new Set([...viewerSeries(b), ...xraySeries(b)].map((s) => s.study_uid));
    const slideStudies = new Set(viewerSlides(b).map((s) => s.study_uid));
    const shown = detail ? b.studies : online;
    for (const s of shown) {
      const nod = nodulesOf(b, s.study_uid);
      const isSlide = /SM/.test(str(s.modalities) ?? '');
      const opens = viewers.has(s.study_uid) || slideStudies.has(s.study_uid);
      lines.push(
        `- ${day(s.date)} ${str(s.modalities)} ${words(s.description)} · accession ${str(s.accession)} · ${str(s.availability) === 'ONLINE' ? `online, ${num(s.images) ?? 0} images` : 'archived offline'}${nod.length ? ` · ${plural(nod.length, 'nodule')} outlined, largest ${fmt(Math.max(...nod.map((n) => num(n.diameter_mm) ?? 0)))} mm` : ''}${str(s.report_id) ? ` · report ${str(s.report_id)}` : ''}${opens ? ` · opens in the ${isSlide ? 'slide viewer (show_slide)' : xraySeries(b).some((x) => x.study_uid === s.study_uid) ? 'X-ray viewer (show_xray)' : 'scan viewer (show_scan)'}` : str(s.availability) === 'ONLINE' ? ' · no viewer files yet' : ''}`
      );
      if (detail) nod.forEach((n) => lines.push(`    ${noduleLine(n)}`));
    }
  } else {
    lines.push(`Research imaging: ${plural(b.radiologyStudies.length, 'study', 'studies')}; ${plural(b.slides.length, 'slide')}.`);
    for (const s of b.radiologySeries) {
      const ai = parseJson<Record<string, { volumeMl?: number }>>(s.ai_measures, {});
      lines.push(
        `- ${day(s.date)} ${str(s.modality)} ${words(s.description)} (series ${str(s.series_key)}, day ${num(s.day)} from diagnosis)${s.volume_path ? ' · opens in the scan viewer' : ''}${
          Object.keys(ai).length
            ? ` · AI segmentation: ${Object.entries(ai)
                .map(([k, v]) => `${k} ${fmt(num(v.volumeMl ?? null))} mL`)
                .join(', ')}`
            : ''
        }`
      );
    }
  }
  for (const sl of b.slides) {
    lines.push(
      `- Slide ${day(sl.date)} ${words(sl.specimen)}${str(sl.accession) ? ` · accession ${str(sl.accession)}` : ''} · ${str(sl.barcode)} · ${fmt(((num(sl.width) ?? 0) * (num(sl.height) ?? 0)) / 1e9)} gigapixels${viewerSlides(b).includes(sl) ? ' · opens in the slide viewer' : ' · no viewer files yet'}${str(sl.report_id) ? ` · report ${str(sl.report_id)}` : ''}${str(sl.til_overlay_path) ? ` · AI lymphocyte map (layer lymphocytes), ${fmt((num(sl.til_positive_fraction) ?? 0) * 100)}% of tissue TIL-positive` : ''}`
    );
  }
  const sc = showcaseLines(b);
  if (sc.length) lines.push('Studies from the imaging demo on this record (each opens with every control of its viewer):', ...sc);
  return lines;
}

/* ------------------------------------------------------------------ studies from the imaging demo */

export type ShowcaseMeta = {
  title?: string;
  defaultView?: string;
  views?: string[];
  mip?: unknown;
  layers?: { id: string; label: string; kind: string; visible?: boolean }[];
  timeline?: { label: string; unit?: string; frames: { value: number; label?: string; note?: string }[]; initial?: number };
  dims?: number[];
  spacingMm?: number[];
  sizeBytes?: number;
  fullSize?: { dims: number[]; spacingMm: number[]; sizeBytes: number };
  stats?: Record<string, number>;
  channels?: { id: string; name: string; meaning?: string; group?: string; visible?: boolean }[];
  bundles?: TractBundle[];
  areaNames?: Record<string, string>;
  floorMm?: number;
  caseInfo?: {
    images?: { key: string; label: string; overlays?: { id: string }[] }[];
    patient?: { caseId?: string; primaryDiagnosis?: string; sex?: string; ageAtDiagnosis?: number; yearOfDiagnosis?: number };
    report?: { file: string };
  };
};

const yes = (v: unknown) => v === true || v === 'true';

const STAT_WORDS: Record<string, string> = {
  lesions: 'lesions',
  lesionVolumeMl: 'mL of lesions',
  suvMax: 'SUVmax',
  injectedMBq: 'MBq injected',
  weeks: 'weeks',
  brainVolumeMlStart: 'mL of brain at the first week',
  brainVolumeMlEnd: 'mL at the last',
  phases: 'breathing phases',
  lungVolumeChangeMl: 'mL lung volume change',
  tumourMotionMm: 'mm tumour motion',
  scans: 'scans',
  days: 'days of treatment',
  bundles: 'fibre bundles',
  streamlines: 'lines drawn',
  atlasStreamlines: 'lines in the atlas',
  people: 'people averaged',
  probabilityMaps: 'probability maps',
};
const VIEW_NAMES: Record<string, string> = { render: '3D', mip: 'MIP', multiplanar: 'multi-planar', axial: 'axial', coronal: 'coronal', sagittal: 'sagittal' };
const ASK_VIEWS: Record<string, string> = { '3d': 'render', mip: 'mip', mpr: 'multiplanar', axial: 'axial', coronal: 'coronal', sagittal: 'sagittal' };
/** The slide AI layers by what a question calls them. */
const OVERLAY_WORDS: Record<string, string[]> = {
  nuclei: ['nuclei', 'nucleus', 'cells', 'cell outlines'],
  til: ['til', 'tils', 'immune', 'immune cells', 'lymphocytes', 'lymphocyte map'],
  lymphocytes: ['lymphocytes', 'lymphocyte map', 'til', 'tils', 'immune', 'immune cells'],
};

const showcaseOf = (b: PatientBundle): Row[] => b.showcase ?? [];
const scMeta = (r: Row) => parseJson<ShowcaseMeta>(r.meta_json, {});
const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');

function findShowcase(b: PatientBundle, q: unknown, section: 'radiology' | 'pathology'): Row | null {
  const k = norm(itemId(q));
  if (!k) return null;
  return showcaseOf(b).find((r) => r.section === section && [r.study_id, r.title].some((v) => norm(str(v) ?? '') === k)) ?? null;
}

function scViews(m: ShowcaseMeta): string[] {
  return ['render', 'mip', 'multiplanar', 'axial', 'coronal', 'sagittal'].filter((v) => (v === 'mip' ? !!m.mip : !m.views || m.views.includes(v)));
}

function scStats(m: ShowcaseMeta): string {
  return Object.entries(m.stats ?? {})
    .map(([k, v]) => `${fmt(v)} ${STAT_WORDS[k] ?? k}`)
    .join(', ');
}

/** What a showcase row is doing in a synthetic record, in one clause. */
function scProvenance(r: Row): string {
  return r.atlas
    ? 'a population atlas (an average of many people, not one person) shown on this synthetic patient'
    : 'public images of a real, de-identified case shown on this synthetic patient';
}

/** The marker channels a question names, resolved against a fluorescence slide's channels. */
function pickChannels(m: ShowcaseMeta, asked: string[]): string[] {
  const all = m.channels ?? [];
  return asked.map((q) => {
    const k = norm(q);
    const hit =
      all.find((c) => norm(c.id) === k || norm(c.name) === k) ??
      all.find((c) => norm(c.name).startsWith(k) || norm(c.id).startsWith(k)) ??
      all.find((c) => norm(c.name).includes(k));
    if (!hit)
      fail(`No marker channel '${q}'. Channels: ${all.filter((c) => c.group !== 'reference').map((c) => `${c.id} (${c.name})`).join(', ')}.`);
    return hit!.id;
  });
}

/** A bundle name without side or the words every bundle shares, for matching what a question calls it. */
const coreName = (v: string) => norm(v.replace(/\b(left|right|the|tracts?|fibres?|fibers?|bundles?|fasciculus)\b/gi, ' '));

/**
 * The bundles a question names: an id (CST_L), an abbreviation (CST, both sides), a name with or without its side
 * (left corticospinal tract), another name (pyramidal tract), or a whole group (projection).
 */
export function pickBundles(m: ShowcaseMeta, asked: string[], title: string): string[] {
  const all = m.bundles ?? [];
  const out: string[] = [];
  for (const q of asked) {
    const k = norm(q);
    const side = /\b(left|right)\b/i.exec(q)?.[1]?.toLowerCase();
    const rest = coreName(q);
    const one = (v: string) => v.replace(/s$/, '');
    // A group by its id or label ("cerebellum", "cerebellar fibres", "cranial nerves") before any bundle's name.
    const group = (m.layers ?? []).find((l) => l.kind === 'tracts' && !!rest && [norm(l.id), coreName(l.label)].some((g) => one(g) === one(rest)));
    let hits = all.filter((b) => norm(b.id) === k);
    if (!hits.length && group) hits = all.filter((b) => b.group === group.id);
    if (!hits.length) hits = all.filter((b) => norm(b.abbr) === k || (!!rest && norm(b.abbr) === rest));
    // A family by its shared abbreviation: SLF is SLF1, SLF2 and SLF3.
    if (!hits.length && rest) hits = all.filter((b) => norm(b.abbr).replace(/\d+$/, '') === rest);
    if (!hits.length && rest) {
      const exact = all.filter((b) => coreName(b.name) === rest || coreName(b.otherNames ?? '') === rest);
      hits = exact.length ? exact : all.filter((b) => coreName(b.name).includes(rest) || (b.otherNames ? coreName(b.otherNames).includes(rest) : false));
    }
    if (side) hits = hits.filter((b) => !b.side || b.side === side);
    if (!hits.length) {
      const names = [...new Map(all.map((b) => [b.abbr, `${b.abbr} (${b.name})`])).values()];
      fail(`${title} has no bundle '${q}'. Its bundles: ${names.join(', ')}; each has _L and _R ids unless it crosses the midline.`);
    }
    out.push(...hits.map((b) => b.id));
  }
  return [...new Set(out)];
}

/** The one bundle, or part of the corpus callosum, whose probability map (or volume) goes on the slices. */
export function pickMap(m: ShowcaseMeta, q: string, title: string): string {
  if (!m.bundles?.length) fail(`${title} has no bundles to map.`);
  // A part by its exact name; "corpus callosum" alone is the whole bundle.
  const part = m.bundles!.flatMap((b) => b.parts ?? []).find((x) => [x.id, x.name, `corpus callosum ${x.name}`, `${x.name} of the corpus callosum`].some((v) => norm(v) === norm(q)));
  if (part?.prob) return part.id;
  const hits = pickBundles(m, [q], title);
  if (hits.length > 1) fail(`Name one side for the map: ${hits.join(' or ')}.`);
  return hits[0];
}

/** One bundle's facts from the atlas's data, in one line. */
function bundleLine(m: ShowcaseMeta, b: TractBundle): string {
  const names = m.areaNames ?? {};
  const atFloor = m.floorMm !== undefined && b.zMm[0] <= m.floorMm + 1;
  const parts = [
    `${b.id} ${b.name}${b.side ? `, ${b.side}` : ''}${b.otherNames ? ` (also called ${b.otherNames})` : ''}`,
    `${b.group}`,
    `median line ${b.lengthMm} mm`,
    `z ${b.zMm[0]} to ${b.zMm[1]} mm${atFloor ? ', down to the atlas floor in the lower brainstem' : ''}`,
    b.cortex?.length
      ? `reaches (every cortical area in 20% of people or more) ${b.cortex.map((c) => `${c.area}${names[c.area] ? ` ${names[c.area]}` : ''} in ${Math.round(c.share * 100)}%`).join(', ')} of people`
      : b.cortex
        ? 'reaches no cortical area in 20% of people or more'
        : 'not in the publisher\'s tract-to-region connectome',
  ];
  if (b.volume) parts.push(`volume ${b.volume.medianMl} mL median (middle half ${b.volume.p25Ml} to ${b.volume.p75Ml}) in ${b.volume.people} of ${b.volume.of} people`);
  if (b.parts)
    parts.push(
      `parts, each with its median volume across people and its own probability map: ${b.parts.map((x) => `${x.name}${x.volume ? ` ${x.volume.medianMl} mL (middle half ${x.volume.p25Ml} to ${x.volume.p75Ml})` : ''}`).join(', ')}`
    );
  parts.push(b.prob ? 'probability map available' : 'its volume can go on the slices');
  return `- ${parts.join('; ')}`;
}

/** The atlas's bundles by group, for imaging_studies. */
function bundleIndex(m: ShowcaseMeta): string {
  const groups = new Map<string, Map<string, string>>();
  for (const b of m.bundles ?? []) {
    const g = groups.get(b.group) ?? new Map<string, string>();
    g.set(b.abbr, `${b.abbr} ${b.name}`);
    groups.set(b.group, g);
  }
  return `${(m.bundles ?? []).length} named bundles (ids are the abbreviation with _L or _R unless the bundle crosses the midline): ${[...groups.entries()]
    .map(([g, names]) => `${g}: ${[...names.values()].join(', ')}`)
    .join('; ')}`;
}

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
const grid = (g: { dims: number[]; spacingMm: number[]; sizeBytes: number }) =>
  `${g.dims.join(' × ')} voxels at ${g.spacingMm.map((v) => fmt(v, 2)).join(' × ')} mm, ${mb(g.sizeBytes)}`;

/** A study's timeline with what the atlas or scan notes for each frame (its date, brain volume, white-matter FA). */
function timelineText(m: ShowcaseMeta): string {
  const t = m.timeline!;
  const noted = t.frames.some((f) => f.note);
  const frames = t.frames.map((f) => `${fmt(f.value)}${noted && (f.note || f.label) ? ` (${[f.label, f.note].filter(Boolean).join(', ')})` : ''}`);
  return `${t.label.toLowerCase()} timeline${t.unit ? ` in ${t.unit}` : ''}: ${frames.join('; ')}`;
}

/** The reduced and the full-size versions of a study, for imaging_studies and show_scan. */
function sizeText(m: ShowcaseMeta): string {
  return `opens reduced for speed (${m.dims && m.spacingMm ? grid({ dims: m.dims, spacingMm: m.spacingMm, sizeBytes: m.sizeBytes ?? 0 }) : 'reduced'}); full size, the original resolution: ${grid(m.fullSize!)} (show_scan full_size, or the viewer's Full size button)`;
}

/** The AI layers a question names, resolved against the ids a slide has. */
function pickOverlays(available: string[], asked: string[]): string[] {
  return asked.map((q) => {
    const k = q.toLowerCase().trim();
    const hit = available.find((id) => id === k) ?? available.find((id) => (OVERLAY_WORDS[id] ?? []).includes(k));
    if (!hit) fail(available.length ? `No AI layer '${q}'. This slide has: ${available.join(', ')}.` : 'This slide has no AI layers.');
    return hit!;
  });
}

function showcaseLines(b: PatientBundle): string[] {
  return showcaseOf(b).map((r) => {
    const m = scMeta(r);
    const vol = r.section === 'radiology';
    const parts = [
      `- ${day(r.date)} ${words(r.modality)}: ${words(r.title)} · study ${str(r.study_id)} · ${scProvenance(r)} · ${words(r.license)}`,
      vol ? `opens in the scan viewer (show_scan study ${str(r.study_id)})` : `opens in the slide viewer (show_slide slide ${str(r.study_id)})`,
    ];
    if (vol) parts.push(`views: ${scViews(m).map((v) => VIEW_NAMES[v]).join(', ')}`);
    if (m.layers?.length) parts.push(`layers: ${m.layers.map((l) => `${l.id} (${l.label}${l.visible === false ? ', off at the start' : ''})`).join(', ')}`);
    if (m.timeline) parts.push(timelineText(m));
    if (m.fullSize) parts.push(sizeText(m));
    if (m.bundles?.length) parts.push(bundleIndex(m));
    if (m.channels?.length)
      parts.push(
        `${m.channels.length} marker channels; the proteins: ${m.channels
          .filter((c) => c.group !== 'reference')
          .map((c) => `${c.id} (${c.name}${c.meaning ? `, ${c.meaning}` : ''})`)
          .join(', ')}`
      );
    const images = m.caseInfo?.images ?? [];
    if (images.length)
      parts.push(`slides of the case: ${images.map((i) => `${i.label}${i.overlays?.length ? ` with AI layers ${i.overlays.map((o) => o.id).join(' and ')}` : ''}`).join('; ')}`);
    const stats = scStats(m);
    if (stats) parts.push(stats);
    return parts.join(' · ');
  });
}

function overviewText(b: PatientBundle, notes: number): string {
  const p = b.patient;
  const ix = b.index ?? {};
  const L: string[] = [];
  const died = day(p.death_date);
  L.push(
    `${who(b)}${str(p.mrn) ? `, MRN ${str(p.mrn)}` : ''}. ${str(p.sex) ?? ''}, ${p.birth_date ? `born ${day(p.birth_date)}` : `${num(p.age_at_diagnosis)} at diagnosis`}${died ? `, died ${died}` : ''}${num(ix.age) !== null ? ` (age ${died ? 'at death' : 'now'} ${num(ix.age)})` : ''}. ${[str(p.race), str(p.ethnicity)].filter(Boolean).join(', ')}${str(p.city) ? `; ${str(p.city)}, ${str(p.state)}` : ''}.${str(p.pcp) ? ` PCP ${str(p.pcp)}.` : ''}`
  );
  L.push(
    b.source === 'epic'
      ? 'Hospital patient: Epic record (synthetic), PACS studies and documents.'
      : `Oncology research case: real, de-identified TCGA data (${str(p.project_id)}); name and primary-care history synthetic. Dates count from diagnosis.`
  );
  if (str(ix.demo_title)) L.push(`Demo patient: ${str(ix.demo_title)}. ${words(ix.demo_why)}`);
  if (b.summary) L.push(`Registry summary: ${words(b.summary.headline)} ${words(b.summary.summary)}`);

  const enc = b.encounters;
  const byClass = new Map<string, number>();
  enc.forEach((e) => byClass.set(str(e.encounter_class) ?? 'other', (byClass.get(str(e.encounter_class) ?? 'other') ?? 0) + 1));
  const labs = b.observations.filter((o) => o.category === 'laboratory').length;
  L.push(
    `Record: ${plural(enc.length, 'visit')}${enc.length ? ` (${day(enc[0].start)} to ${day(enc[enc.length - 1].start)}; ${[...byClass].map(([k, v]) => `${v} ${k}`).join(', ')})` : ''}, ${plural(labs, 'lab result')}, ${plural(b.observations.length - labs, 'other measurement')}, ${plural(b.conditions.length, 'problem-list entry', 'problem-list entries')}, ${plural(b.medications.length, 'medication order')}, ${plural(b.procedures.length, 'procedure')}, ${plural(b.documents.length, 'document')}, ${plural(notes, 'tumour board note')}.`
  );

  // Cancer
  if (str(p.diagnosis_date) || b.diagnoses.length) {
    L.push('', 'Cancer:');
    for (const d of b.diagnoses) {
      if (!str(d.primary_diagnosis) && !str(d.site)) continue;
      L.push(
        `- ${day(d.date) ?? (num(d.day) !== null ? `day ${num(d.day)}` : 'date not recorded')} ${str(d.classification) ?? ''}: ${words(d.primary_diagnosis) || ''}${str(d.site) ? ` (${str(d.site)})` : ''}${str(d.icd10) ? ` ${str(d.icd10)}` : ''}${str(d.stage) ? `, ${str(d.stage)}` : ''}${day(d.resolved) ? `, resolved ${day(d.resolved)}` : ''}`
      );
    }
    const facts = [
      str(p.stage) && `stage ${str(p.stage)}`,
      str(p.tnm),
      str(p.grade) && `grade ${str(p.grade)}`,
      str(p.gleason_score) && `Gleason ${str(p.gleason_score)}`,
      str(p.residual_disease) && `residual ${str(p.residual_disease)}`,
    ].filter(Boolean);
    if (facts.length) L.push(`- ${facts.join(', ')}`);
    const given = b.treatments.filter((t) => t.given !== false && (str(t.agent) || str(t.anatomic_site) || str(t.start_date)));
    if (given.length) {
      L.push('Cancer treatment:');
      for (const t of given)
        L.push(
          `- ${day(t.start_date) ?? `day ${num(t.start_day)}`}${day(t.end_date) ? ` to ${day(t.end_date)}` : ''} ${str(t.treatment_type)}: ${str(t.agent) ?? str(t.anatomic_site) ?? ''}${num(t.orders) ? ` (${plural(num(t.orders)!, 'order')})` : ''}${str(t.outcome) ? `; ${str(t.outcome)}` : ''}${num(t.cycles) ? `; ${num(t.cycles)} cycles` : ''}`
        );
    }
    const responses = b.followUps.filter((f) => str(f.disease_response) || str(f.progression) === 'Yes');
    if (responses.length)
      L.push(
        `Follow-up: ${responses.map((f) => `${day(f.date) ?? `day ${num(f.day)}`} ${str(f.disease_response) ?? `${str(f.progression_type) ?? ''} progression ${str(f.progression_site) ?? ''}`.trim()}`).join('; ')}`
      );
  } else L.push('', 'Cancer: none on the problem list.');

  // Problems
  const firstOf = new Map<string, Row>();
  for (const c of b.conditions) {
    const k = str(c.description) ?? '';
    if (k && !firstOf.has(k)) firstOf.set(k, c);
  }
  const conds = [...firstOf.values()];
  const active = conds.filter((c) => !day(c.resolved));
  const resolved = conds.filter((c) => day(c.resolved));
  L.push(
    '',
    `Problems still open (${active.length}): ${active.map((c) => `${str(c.description)}${str(c.icd10) ? ` [${str(c.icd10)}]` : ''} since ${day(c.onset)}`).join('; ') || 'none'}.`
  );
  if (resolved.length)
    L.push(
      `Resolved problems (${resolved.length}), most recent: ${resolved
        .slice(-12)
        .map((c) => `${str(c.description)} ${day(c.onset)} to ${day(c.resolved)}`)
        .join('; ')}.`
    );

  // Medications
  const lastContact = day(p.last_contact_date) ?? '9999';
  const meds = new Map<
    string,
    {
      n: number;
      first: string | null;
      last: string | null;
      open: boolean;
      reason: string | null;
      cls: string | null;
    }
  >();
  for (const m of b.medications) {
    const k = str(m.description) ?? '';
    if (!k) continue;
    const e = meds.get(k) ?? {
      n: 0,
      first: day(m.start),
      last: null,
      open: false,
      reason: str(m.reason),
      cls: str(m.therapeutic_class),
    };
    e.n++;
    e.last = day(m.start) ?? e.last;
    if (!day(m.stop) || (day(m.stop) ?? '') >= lastContact) e.open = true;
    meds.set(k, e);
  }
  const current = [...meds].filter(([, v]) => v.open);
  L.push(
    `Medications open at last contact (${current.length}): ${current.map(([k, v]) => `${k}${v.reason ? ` (for ${v.reason.toLowerCase()})` : ''} since ${v.first}`).join('; ') || 'none'}.`
  );
  const most = [...meds].sort((a, z) => z[1].n - a[1].n).slice(0, 15);
  if (most.length) L.push(`Most ordered (${meds.size} distinct): ${most.map(([k, v]) => `${k} ×${v.n} ${v.first}–${v.last}`).join('; ')}.`);

  const v = latest(b, KEY_VITALS);
  if (v.length) L.push('', `Latest vital signs: ${v.join('; ')}.`);
  const l = latest(b, KEY_LABS);
  if (l.length) L.push(`Latest key labs: ${l.join('; ')}.`);

  L.push('', 'Imaging and pathology:', ...imagingText(b, false));
  if (b.documents.length) {
    const types = new Map<string, number>();
    b.documents.forEach((d) => types.set(str(d.type) ?? 'Document', (types.get(str(d.type) ?? 'Document') ?? 0) + 1));
    const scanned = b.documents.filter((d) => d.scanned);
    L.push(
      '',
      `Documents: ${[...types].map(([k, n]) => `${n} ${k.toLowerCase()}${n === 1 ? '' : 's'}`).join(', ')}; ${scanned.length} scanned.`
    );
    const notable = [...b.documents.filter((d) => d.type !== 'Progress Note' || d.scanned)].slice(-12);
    notable.forEach((d) =>
      L.push(`- ${day(d.date)} ${str(d.type)}: ${str(d.title)} · ${str(d.document_id)}${d.scanned ? ' · scanned' : ''}`)
    );
  }
  if (b.cohorts?.length)
    L.push(
      '',
      `Data requests that include this patient (approved or delivered): ${b.cohorts
        .map(
          (c) =>
            `request ${num(c.query_master_id)} "${str(c.title)}" (${str(c.status)?.toLowerCase()}, ${plural(num(c.patients) ?? 0, 'patient')}${
              c.in_delivery === true ? '; in the delivered sample' : c.in_delivery === false ? '; not in the delivered sample' : ''
            })`
        )
        .join('; ')}. The record's Cohorts tab shows them.`
    );
  if (b.source === 'research' && b.report.text)
    L.push(
      '',
      `Pathology report: ${b.report.text.length.toLocaleString('en-US')} characters (read_document with document_id ${idOf(b)}/report).`
    );
  b.genomes.forEach((g, i) => {
    const pr = g.profile;
    const slide = b.slides.find((s) => s.genome === g.barcode);
    L.push(
      '',
      `Tumour genome${b.genomes.length > 1 ? ` ${i + 1} of ${b.genomes.length}` : ''}, TCGA case ${g.barcode}${slide ? `, the tumour on the ${day(slide.date)} slide` : ''} (${g.cancer}, compared with ${num(pr.cohort_size)} tumours of this type): subtype ${str(pr.subtype)}; ${fmt(num(pr.tmb))} mutations/Mb (TMB, ${fmt(num(pr.tmb_percentile))}th percentile); ${num(pr.mutation_count)} mutations; ${str(pr.msi_status)}; fraction of genome altered ${fmt(num(pr.fraction_genome_altered), 3)} (${fmt(num(pr.fga_percentile))}th percentile); aneuploidy ${num(pr.aneuploidy_score)}; HRD ${num(pr.hrd_score)}; leukocyte fraction ${fmt(num(pr.leukocyte_fraction), 2)}.`
    );
    if (g.drivers.length)
      L.push(
        `Driver mutations: ${g.drivers
          .slice(0, 15)
          .map((d) => `${str(d.gene)} ${str(d.protein_change) ?? ''} (${str(d.mutation_type)}, VAF ${fmt(num(d.vaf), 2)})`)
          .join('; ')}.`
      );
    const cn = g.copyNumber.filter((c) => Number(c.is_driver_gene) === 1 && str(c.alteration) && !/neutral|diploid/i.test(str(c.alteration) ?? ''));
    if (cn.length)
      L.push(
        `Driver copy-number changes: ${cn
          .slice(0, 15)
          .map((c) => `${str(c.gene)} ${str(c.call) ?? str(c.alteration)}`)
          .join('; ')}.`
      );
    const imm = [...g.immuneCells].sort((a, z) => (num(z.fraction) ?? 0) - (num(a.fraction) ?? 0)).slice(0, 4);
    if (imm.length)
      L.push(`Immune mix (largest): ${imm.map((c) => `${str(c.cell_type)} ${fmt((num(c.fraction) ?? 0) * 100)}%`).join(', ')}.`);
  });
  if (b.genomes.length && b.biomarkers.length)
    L.push(
      `Biomarker tests: ${b.biomarkers
        .slice(0, 10)
        .map((t) => `${str(t.test)} ${str(t.result) ?? str(t.value) ?? ''}`)
        .join('; ')}.`
    );
  if (b.source === 'epic')
    L.push('', `Not in this record: ${b.genomes.length ? '' : 'tumour genome (no TCGA slide), '}immunisations, allergies, care plans, costs.`);
  return L.join('\n');
}

/* ------------------------------------------------------------------ events */

type Ev = {
  date: string;
  kind: string;
  title: string;
  details: string;
  source: string;
  item: string | null;
};

function events(b: PatientBundle, notes: { date: string; body: string; author: string; id: string }[]): Ev[] {
  const model = buildModel(b);
  const markOf = new Map<Row, string>();
  model.marks.forEach((m: Mark) => m.rows.forEach((r) => markOf.has(r) || markOf.set(r, m.id)));
  const visit = (r: Row) => (str(r.encounter_id) ? `v:${str(r.encounter_id)}` : null);
  const epic = b.source === 'epic';
  const dx = day(b.patient.diagnosis_date);
  const fromDay = (d: unknown) => {
    const n = num(d as never);
    if (n === null || !dx) return null;
    return new Date(Date.parse(dx) + n * 86_400_000).toISOString().slice(0, 10);
  };
  const out: Ev[] = [];
  const push = (e: Omit<Ev, 'date'> & { date: string | null }) => e.date && out.push(e as Ev);

  for (const e of b.encounters)
    push({
      date: day(e.start),
      kind: 'visit',
      title: words(e.description) || words(e.encounter_class),
      details: [str(e.encounter_class), str(e.reason) && `for ${str(e.reason)}`, str(e.department), str(e.provider), str(e.organization)]
        .filter(Boolean)
        .join(' · '),
      source: epic ? 'Clarity PAT_ENC' : 'synthetic encounter',
      item: markOf.get(e) ?? visit(e),
    });
  for (const c of b.conditions)
    push({
      date: day(c.onset),
      kind: 'condition',
      title: words(c.description),
      details: [str(c.icd10), day(c.resolved) ? `resolved ${day(c.resolved)}` : 'still open', str(c.status)].filter(Boolean).join(' · '),
      source: epic ? 'Clarity PROBLEM_LIST' : 'synthetic condition',
      item: markOf.get(c) ?? visit(c),
    });
  for (const m of b.medications)
    push({
      date: day(m.start),
      kind: 'medication',
      title: words(m.description),
      details: [
        str(m.generic_name),
        str(m.therapeutic_class),
        str(m.reason) && `for ${str(m.reason)}`,
        day(m.stop) ? `to ${day(m.stop)}` : 'no end date',
        str(m.status),
        str(m.prescriber),
      ]
        .filter(Boolean)
        .join(' · '),
      source: epic ? 'Clarity ORDER_MED' : 'synthetic medication',
      item: markOf.get(m) ?? visit(m),
    });
  for (const p of b.procedures)
    push({
      date: day(p.date),
      kind: 'procedure',
      title: words(p.description),
      details: [str(p.code), str(p.category), str(p.reason) && `for ${str(p.reason)}`].filter(Boolean).join(' · '),
      source: epic ? 'Clarity ORDER_PROC' : 'synthetic procedure',
      item: visit(p),
    });
  for (const o of observations(b)) {
    const lab = o.row.category === 'laboratory';
    const v = num(o.row.value);
    push({
      date: day(o.row.date),
      kind: lab ? 'lab' : 'vital',
      title: o.def.name,
      details: `${v !== null ? fmt(v, 2) : words(o.row.value_text)}${str(o.row.units) && v !== null ? ` ${str(o.row.units)}` : ''}${flag(v, o.def.ref) ? ` (${flag(v, o.def.ref)})` : ''}`,
      source: str(o.row.source) ?? (lab ? 'lab result' : 'measurement'),
      item: visit(o.row),
    });
  }
  if (epic) {
    for (const s of b.studies) {
      const nod = nodulesOf(b, s.study_uid);
      const slide = /SM/.test(str(s.modalities) ?? '');
      push({
        date: day(s.date),
        kind: slide ? 'slide' : 'study',
        title: words(s.description),
        details: [
          str(s.modalities),
          `accession ${str(s.accession)}`,
          str(s.availability) === 'ONLINE' ? 'online' : 'archived offline',
          nod.length ? `${nod.length} nodules, largest ${fmt(Math.max(...nod.map((n) => num(n.diameter_mm) ?? 0)))} mm` : '',
          str(s.report_id) && `report ${str(s.report_id)}`,
        ]
          .filter(Boolean)
          .join(' · '),
        source: 'PACS Study',
        item: slide ? (markOf.get(b.slides.find((x) => x.study_uid === s.study_uid) ?? {}) ?? null) : `r:${str(s.study_uid)}`,
      });
    }
  } else {
    for (const s of b.radiologyStudies)
      push({
        date: day(s.date),
        kind: 'study',
        title: `${str(s.modalities)} ${str(s.body_part)?.toLowerCase() ?? ''}`.trim(),
        details: `${num(s.series_count)} series, ${num(s.images)} images; day ${num(s.day)} from diagnosis`,
        source: 'research imaging',
        item: `r:${str(s.study_uid)}`,
      });
    for (const sl of b.slides)
      push({
        date: day(sl.date) ?? fromDay(sl.day),
        kind: 'slide',
        title: `${str(sl.role) === 'diagnostic' ? 'Diagnostic' : 'Frozen'} H&E slide ${str(sl.section) ?? ''}`.trim(),
        details: [str(sl.barcode), str(sl.sample_type)].filter(Boolean).join(' · '),
        source: 'research imaging',
        item: markOf.get(sl) ?? null,
      });
    if (b.report.text || b.report.pdfPath)
      push({
        date: dx,
        kind: 'document',
        title: 'Surgical pathology report',
        details: `document_id ${idOf(b)}/report${b.report.pdfPath ? ' · scanned PDF with OCR text' : ''}`,
        source: 'research registry',
        item: 'report',
      });
  }
  for (const d of b.documents)
    push({
      date: day(d.date),
      kind: 'document',
      title: words(d.title),
      details: [
        str(d.type),
        str(d.author),
        d.scanned ? 'scanned' : 'typed',
        `document_id ${str(d.document_id)}`,
        str(d.accession) && `accession ${str(d.accession)}`,
      ]
        .filter(Boolean)
        .join(' · '),
      source: 'documents lakehouse',
      item: `d:${str(d.document_id)}`,
    });
  b.treatments.forEach((t) => {
    if (t.given === false) return;
    push({
      date: day(t.start_date) ?? fromDay(t.start_day),
      kind: 'treatment',
      title: `${str(t.treatment_type)}${str(t.agent) ? `: ${str(t.agent)}` : ''}`,
      details: [
        str(t.anatomic_site),
        day(t.end_date) ? `to ${day(t.end_date)}` : '',
        num(t.orders) ? `${num(t.orders)} orders` : '',
        str(t.outcome),
      ]
        .filter(Boolean)
        .join(' · '),
      source: str(t.source) ?? 'oncology registry',
      item: markOf.get(t) ?? null,
    });
  });
  b.diagnoses.forEach((d) =>
    push({
      date: day(d.date) ?? fromDay(d.day),
      kind: 'diagnosis',
      title: `${str(d.classification) ?? 'Diagnosis'}: ${words(d.primary_diagnosis) || str(d.site) || ''}`,
      details: [str(d.icd10), str(d.stage), str(d.site)].filter(Boolean).join(' · '),
      source: epic ? 'Clarity PROBLEM_LIST, oncology flowsheets' : 'oncology registry',
      item: markOf.get(d) ?? (str(d.classification) === 'Primary' || d.is_primary ? 'dx' : null),
    })
  );
  b.followUps.forEach((f) => {
    const text =
      str(f.disease_response) ??
      (str(f.progression) === 'Yes' ? `${str(f.progression_type) ?? ''} progression ${str(f.progression_site) ?? ''}`.trim() : null);
    if (text)
      push({
        date: day(f.date) ?? fromDay(f.day),
        kind: 'diagnosis',
        title: text,
        details: [str(f.timepoint), str(f.evidence)].filter(Boolean).join(' · '),
        source: epic ? 'Clarity flowsheets' : 'oncology registry',
        item: markOf.get(f) ?? null,
      });
  });
  if (day(b.patient.death_date))
    push({
      date: day(b.patient.death_date),
      kind: 'diagnosis',
      title: 'Died',
      details: str(b.patient.cause_of_death) ?? '',
      source: epic ? 'Clarity PATIENT' : 'oncology registry',
      item: 'end',
    });
  for (const n of notes)
    push({
      date: n.date,
      kind: 'note',
      title: `Tumour board note by ${n.author}`,
      details: n.body.slice(0, 300),
      source: 'Patient 360 notes',
      item: `n:${n.id}`,
    });
  return out.sort((a, z) => a.date.localeCompare(z.date));
}

async function notesFor(id: string) {
  try {
    const list = await notesApi.list(id);
    return list.map((n) => ({
      id: String(n.id),
      date: new Date(n.createdAt as unknown as string).toISOString().slice(0, 10),
      body: n.body,
      author: n.authorName,
      eventId: n.eventId ?? null,
    }));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ finding a study, slide, document */

/** The showcase studies that do open, for a message about one that does not. */
function scList(b: PatientBundle, section: 'radiology' | 'pathology', asked: string): string {
  const rows = showcaseOf(b).filter((r) => r.section === section);
  return rows.length ? ` matching '${asked}'. These open: ${rows.map((r) => `${words(r.title)}, ${section === 'radiology' ? 'study' : 'slide'} ${str(r.study_id)}`).join('; ')}` : '';
}

function pickSeries(b: PatientBundle, study: unknown): Row {
  const vs = viewerSeries(b);
  if (!vs.length)
    fail(
      `${who(b)} has no CT or MRI with viewer files${scList(b, 'radiology', String(study ?? ''))}. ${b.studies.length ? 'imaging_studies lists the studies; archived ones have their report only.' : ''}`
    );
  const q = itemId(study).toLowerCase();
  if (!q) return vs.find((s) => s.labels_path) ?? vs.find((s) => s.role === 'primary') ?? vs[0];
  const studyOf = (s: Row) =>
    b.studies.find((x) => x.study_uid === s.study_uid) ?? b.radiologyStudies.find((x) => x.study_uid === s.study_uid);
  const hit = vs.find((s) =>
    [s.series_uid, s.study_uid, s.series_key, studyOf(s)?.accession, day(s.date)].some((v) => str(v)?.toLowerCase() === q)
  );
  if (!hit)
    fail(
      `No scan with viewer files matches '${String(study)}'. Scans that open: ${[
        ...vs.map((s) => `${day(s.date)} ${str(s.modality)} accession ${str(studyOf(s)?.accession) ?? str(s.series_key)}`),
        ...showcaseOf(b)
          .filter((r) => r.section === 'radiology')
          .map((r) => `${day(r.date)} ${words(r.title)}, study ${str(r.study_id)}`),
      ].join('; ')}.`
    );
  return hit!;
}

/** show_scan for a study from the imaging demo: the view, time point and layers the question asks for. */
function showcaseScan(b: PatientBundle, r: Row, a: Record<string, unknown>): ToolResult {
  const m = scMeta(r);
  const title = words(r.title);
  const views = scViews(m);
  const asked = ASK_VIEWS[String(a.view ?? '').toLowerCase()] ?? null;
  if (a.view && !asked) fail(`View '${String(a.view)}' is not one of 3d, mip, mpr, axial, coronal, sagittal.`);
  if (asked && !views.includes(asked)) fail(`${title} has no ${VIEW_NAMES[asked]} view; it has ${views.map((v) => VIEW_NAMES[v]).join(', ')}.`);
  let view = asked ?? (m.defaultView && views.includes(m.defaultView) ? m.defaultView : 'render');
  const ids = (m.layers ?? []).map((l) => l.id);
  const layers = list(a.layers).map((q) => {
    const k = norm(q);
    const hit = (m.layers ?? []).find((l) => norm(l.id) === k) ?? (m.layers ?? []).find((l) => norm(l.label).includes(k));
    if (!hit) fail(`${title} has no layer '${q}'. Layers: ${(m.layers ?? []).map((l) => `${l.id} (${l.label})`).join(', ')}.`);
    return hit!.id;
  });
  let frame: number | null = null;
  if (a.frame != null && String(a.frame).trim() !== '') {
    if (!m.timeline) fail(`${title} has no timeline.`);
    const want = Number(String(a.frame).replace(/[^\d.]/g, ''));
    const values = m.timeline!.frames.map((f) => f.value);
    frame = values.reduce((best, v) => (Math.abs(v - want) < Math.abs(best - want) ? v : best), values[0]);
  }
  // The brain fibre-tract atlas: named bundles, their colour, and a bundle's map on the slices.
  const bundleIds = m.bundles?.length && list(a.bundles).length ? pickBundles(m, list(a.bundles), title) : [];
  const colour = String(a.colour ?? '').toLowerCase() === 'bundle' ? 'bundle' : 'direction';
  const map = a.map && String(a.map).trim() ? pickMap(m, String(a.map), title) : null;
  if (map && !a.view) view = 'multiplanar';
  const full = yes(a.full_size) && !!m.fullSize;
  const groupsOf = new Set((m.bundles ?? []).filter((b) => bundleIds.includes(b.id)).map((b) => b.group));
  const shown = (m.layers ?? []).filter((l, i) =>
    layers.length || groupsOf.size
      ? layers.includes(l.id) || groupsOf.has(l.id) || (i === 0 && (l.visible !== false || !!map))
      : l.visible !== false || (i === 0 && !!map)
  );
  const drawn = (m.bundles ?? []).filter((b) => (bundleIds.length ? bundleIds.includes(b.id) : shown.some((l) => l.id === b.group)));
  const t = m.timeline;
  // The MIP is a turning projection of the PET alone; the other layers draw once the reader switches view.
  const mipNote =
    view === 'mip'
      ? `The MIP is a rotating projection of the PET alone${shown.some((l) => l.kind === 'labels') ? `; ${shown.filter((l) => l.kind === 'labels').map((l) => l.label.toLowerCase()).join(' and ')} are switched on and show in the 3D, multi-planar and slice views` : ''}.`
      : '';
  return {
    card: {
      kind: 'showcase',
      title: words(a.title),
      bundle: b,
      studyId: str(r.study_id)!,
      view,
      frame,
      layers: layers.length ? layers : null,
      tracts: m.bundles?.length ? { bundles: bundleIds.length ? bundleIds : undefined, colour, map: map ?? undefined } : null,
      full,
    },
    text: [
      `The card shows ${title} (${words(r.modality)}, ${day(r.date)}) on ${who(b)}'s record in the ${VIEW_NAMES[view]} view with ${shown.map((l) => l.label).join(', ') || 'its image'}${frame !== null && t ? `, at ${t.label.toLowerCase()} ${fmt(frame)}${t.unit ? ` ${t.unit}` : ''}` : ''}.`,
      mipNote,
      m.bundles?.length ? tractsText(m, drawn, bundleIds.length > 0, colour, map) : '',
      `It is ${scProvenance(r)}. ${words(r.description)}`,
      scStats(m) ? `Measured: ${scStats(m)}.` : '',
      t ? `The reader can play the ${timelineText(m)}.` : '',
      m.fullSize ? (full ? `Opened at full size: ${grid(m.fullSize)}.` : `${sizeText(m)}.`) : '',
      `Other layers: ${ids.filter((id) => !shown.some((l) => l.id === id)).join(', ') || 'none'}. Views: ${views.map((v) => VIEW_NAMES[v]).join(', ')}.`,
      `Source: ${words(r.source)}; ${words(r.license)}.`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

/** What a tractography card draws, bundle by bundle, with the facts the atlas's data gives for each. */
function tractsText(m: ShowcaseMeta, drawn: TractBundle[], named: boolean, colour: string, map: string | null): string {
  const all = m.bundles ?? [];
  const lines = [
    `${named ? 'Drawn alone' : 'Drawn'}: ${drawn.length} of ${all.length} bundles, coloured ${colour === 'bundle' ? 'one colour per bundle, named in a legend on the image' : 'by line direction'}.`,
  ];
  if (drawn.length <= 40) lines.push(...drawn.map((b) => bundleLine(m, b)));
  else {
    const byGroup = new Map<string, number>();
    drawn.forEach((b) => byGroup.set(b.group, (byGroup.get(b.group) ?? 0) + 1));
    lines.push(`By group: ${[...byGroup.entries()].map(([g, n]) => `${g} ${n}`).join(', ')}. Name bundles (bundles) or one group (layers) for each bundle's facts.`);
  }
  if (m.floorMm !== undefined)
    lines.push(`The atlas covers the brain down to z ${m.floorMm} mm, in the lower brainstem; a tract that continues into the spinal cord leaves the atlas there.`);
  if (map) {
    const b = all.find((x) => x.id === map);
    const part = all.flatMap((x) => (x.parts ?? []).map((p) => ({ ...p, of: x }))).find((p) => p.id === map);
    lines.push(
      b?.prob || part
        ? `The probability map of ${b ? `${b.name}${b.side ? `, ${b.side}` : ''}` : `the corpus callosum's ${part!.name}`} is on the slices over the template brain: how often the tract passes through each point across the 1,065 people, from 5% to 100%.`
        : `The volume of ${b!.name}${b!.side ? `, ${b!.side}` : ''} is on the slices over the template brain, in its colour.`
    );
  }
  lines.push('Each bundle\'s facts are also in the viewer\'s Bundles tab.');
  return lines.join('\n');
}

/** show_slide for a study from the imaging demo: an H&E case with AI layers, or a multiplex fluorescence slide. */
function showcaseSlide(b: PatientBundle, r: Row, a: Record<string, unknown>): ToolResult {
  const m = scMeta(r);
  const title = words(r.title);
  const fluorescence = !!m.channels?.length;
  const main = m.caseInfo?.images?.[0];
  const overlayIds = (main?.overlays ?? []).map((o) => o.id);
  const overlays = list(a.layers).length ? pickOverlays(overlayIds, list(a.layers)) : null;
  if (list(a.channels).length && !fluorescence) fail(`${title} is an H&E slide; marker channels belong to a fluorescence slide.`);
  const channels = fluorescence && list(a.channels).length ? pickChannels(m, list(a.channels)) : null;
  const report = yes(a.report) && !!m.caseInfo?.report;
  const tcga = m.caseInfo?.patient;
  const names = (ids: string[]) =>
    ids.map((id) => m.channels!.find((c) => c.id === id)!).map((c) => `${c.name}${c.meaning ? ` (${c.meaning.toLowerCase()})` : ''}`);
  return {
    card: { kind: 'showcase', title: words(a.title), bundle: b, studyId: str(r.study_id)!, overlays, channels, report },
    text: [
      `The card shows ${title} (${day(r.date)}) on ${who(b)}'s record in the slide viewer with every control: magnifications to 40x, tour, compare, full screen${m.caseInfo?.images?.length ? ', the slides of the case in a filmstrip, the case banner and the report beside the slide' : ''}.`,
      `It is ${scProvenance(r)}. ${words(r.description)}`,
      tcga?.caseId
        ? `The slide is TCGA case ${tcga.caseId} (${(tcga.primaryDiagnosis ?? '').toLowerCase()}, ${tcga.sex ?? ''} aged ${tcga.ageAtDiagnosis ?? '?'} at diagnosis in ${tcga.yearOfDiagnosis ?? '?'}), not this patient's own biopsy. ${m.caseInfo?.report ? `Its own pathology report is that case's${report ? ' and is open beside the slide' : '; report true opens it beside the slide'}. ` : ''}Reports in the hospital record describe the synthetic patient's own specimens: a different case, so never present the two as describing the same tissue.`
        : '',
      fluorescence
        ? `Marker channels shown: ${names(channels ?? m.channels!.filter((c) => c.visible).map((c) => c.id)).join(', ')}. The reader can switch any of the ${m.channels!.length} channels.`
        : '',
      overlayIds.length
        ? `AI layers ${overlays ? `on: ${overlays.join(', ')}` : 'off'} (available: ${overlayIds.join(', ')}; nuclei outlines every nucleus, til is the immune-cell heat map).`
        : '',
      `Source: ${words(r.source)}; ${words(r.license)}.`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function pickSlide(b: PatientBundle, slide: unknown): Row {
  const vs = viewerSlides(b);
  if (!vs.length) fail(`${who(b)} has no slide with viewer files${scList(b, 'pathology', String(slide ?? ''))}.`);
  const q = itemId(slide).toLowerCase();
  if (!q) return vs.find((s) => s.role === 'diagnostic') ?? vs[0];
  const hit = vs.find((s) =>
    [s.slide_id, s.series_uid, s.accession, s.barcode, s.section, day(s.date)].some((v) => str(v)?.toLowerCase() === q)
  );
  if (!hit)
    fail(
      `No slide matches '${String(slide)}'. Slides: ${[
        ...vs.map((s) => `${day(s.date)} ${str(s.accession) ?? str(s.barcode)}`),
        ...showcaseOf(b)
          .filter((r) => r.section === 'pathology')
          .map((r) => `${day(r.date)} ${words(r.title)}, slide ${str(r.study_id)}`),
      ].join('; ')}.`
    );
  return hit!;
}

function pickXray(b: PatientBundle, study: unknown): Row {
  const xs = xraySeries(b);
  if (!xs.length) fail(`${who(b)} has no X-ray with viewer files.`);
  const q = itemId(study).toLowerCase();
  if (!q) return xs[0];
  const hit = xs.find((s) =>
    [s.series_uid, s.study_uid, b.studies.find((x) => x.study_uid === s.study_uid)?.accession, day(s.date)].some(
      (v) => str(v)?.toLowerCase() === q
    )
  );
  if (!hit)
    fail(
      `No X-ray matches '${String(study)}'. X-rays: ${xs.map((s) => `${day(s.date)} accession ${str(b.studies.find((x) => x.study_uid === s.study_uid)?.accession)}`).join('; ')}.`
    );
  return hit!;
}

/* ------------------------------------------------------------------ the tools */

type Handler = (args: Args, ctx: ToolCtx) => Promise<ToolResult>;

function listRow(p: PatientListRow): string {
  const n = (v: unknown) => num(v as never) ?? 0;
  const online = [
    n(p.ct_online)
      ? `chest CT${n(p.nodules) ? ` (${plural(n(p.nodules), 'nodule')}, largest ${fmt(num(p.largest_nodule_mm))} mm)` : ''}`
      : '',
    n(p.mr_online) ? 'brain MRI' : '',
    n(p.xray_online) ? 'X-ray' : '',
    n(p.slides_online) ? plural(n(p.slides_online), 'slide') : '',
    n(p.scanned_documents) ? `${n(p.scanned_documents)} scanned documents` : '',
    n(p.has_genome) ? 'tumour genome' : '',
  ].filter(Boolean);
  return `${str(p.patient_id)} ${str(p.display_name)} · ${str(p.sex)}, ${n(p.age)}${day(p.death_date) ? `, died ${day(p.death_date)}` : ''}${str(p.demo_title) ? ` · demo: ${str(p.demo_title)}` : ''} · ${str(p.cancers) ? `cancers: ${str(p.cancers)}` : 'no cancer recorded'} · online: ${online.join(', ') || 'none'} · ${n(p.visits)} visits, ${n(p.studies)} studies (${n(p.studies_online)} online), ${n(p.documents)} documents`;
}

const handlers: Record<string, Handler> = {
  async data_requests() {
    const { requests } = await fetchRequests();
    if (!requests.length) return { text: 'No data request has been approved or delivered yet.' };
    return {
      text: [
        `${plural(requests.length, 'approved or delivered data request')}, newest first:`,
        ...requests.map(
          (r) =>
            `- Request ${num(r.query_master_id)}: "${str(r.title)}", ${str(r.status)?.toLowerCase()}, ${plural(num(r.patients) ?? 0, 'patient')}; approved ${day(r.decided_at)}${r.delivered_at ? `, delivered ${day(r.delivered_at)}` : ''}`
        ),
        'find_patients with request lists a request\'s patients.',
      ].join('\n'),
    };
  },

  async find_patients(a, ctx) {
    const limit = int(a.limit, 10, 1, 40);
    const req: SearchRequest = {
      q: words(a.query) || undefined,
      has: list(a.has),
      cancer: words(a.cancer) || undefined,
      sex: a.sex === 'Female' || a.sex === 'Male' ? a.sex : undefined,
      ageMin: typeof a.age_min === 'number' ? a.age_min : undefined,
      ageMax: typeof a.age_max === 'number' ? a.age_max : undefined,
      vital: a.vital === 'living' || a.vital === 'deceased' ? a.vital : undefined,
      demo: a.demo === true || undefined,
      source: a.source === 'epic' || a.source === 'research' ? a.source : undefined,
      request: typeof a.request === 'number' && a.request > 0 ? Math.floor(a.request) : undefined,
      offset: 0,
      limit,
    };
    const r = await searchPatients(req);
    if (a.add && r.patients.length)
      ctx.addPatients(
        r.patients.map((p) => ({
          id: str(p.patient_id)!,
          name: str(p.display_name) ?? '',
        }))
      );
    return {
      text: [
        `${plural(r.total, 'patient')} match${r.total === 1 ? 'es' : ''}; ${r.patients.length < r.total ? `the first ${r.patients.length} (demo patients first, then those with the most online)` : 'all of them'}:`,
        ...r.patients.map(listRow),
        a.add ? 'They were added to the conversation.' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },

  async patient_overview(a, ctx) {
    const id = patientId(a.patient_id);
    const [b, notes] = await Promise.all([ctx.getPatient(id), notesFor(id)]);
    return { text: overviewText(b, notes.length) };
  },

  async patient_events(a, ctx) {
    const id = patientId(a.patient_id);
    const [b, notes] = await Promise.all([ctx.getPatient(id), notesFor(id)]);
    const kinds = new Set(list(a.kinds));
    const text = words(a.text).toLowerCase();
    const from = day(a.from) ?? undefined;
    const to = day(a.to) ?? undefined;
    const limit = int(a.limit, 120, 1, 300);
    const all = events(b, notes).filter(
      (e) =>
        (!kinds.size || kinds.has(e.kind)) && inRange(e.date, from, to) && (!text || `${e.title} ${e.details}`.toLowerCase().includes(text))
    );
    const shown = all.slice(-limit);
    return {
      text: [
        `${who(b)}: ${plural(all.length, 'event')}${kinds.size ? ` of kind ${[...kinds].join(', ')}` : ''}${from || to ? ` between ${from ?? 'the start'} and ${to ?? 'the end'}` : ''}${text ? ` mentioning '${text}'` : ''}${shown.length < all.length ? `; the latest ${shown.length} (narrow with from, to, kinds or text for earlier ones)` : ''}.`,
        'date | kind | title | details | source | item',
        ...shown.map((e) => `${e.date} | ${e.kind} | ${e.title} | ${e.details} | ${e.source} | ${e.item ?? ''}`),
      ].join('\n'),
    };
  },

  async lab_series(a, ctx) {
    const ids = patientIds(a.patient_ids, 8);
    const tests = list(a.tests);
    if (!tests.length) fail('Name at least one test.');
    const bundles = await Promise.all(ids.map((id) => ctx.getPatient(id)));
    const from = day(a.from) ?? undefined;
    const to = day(a.to) ?? undefined;
    const out: string[] = [];
    for (const b of bundles) {
      const { series, missing } = seriesFor(b, tests, from, to);
      out.push(`${who(b)}:`);
      series.forEach((s) => out.push(describeSeries(s, ids.length > 3 ? 24 : 60)));
      if (missing.length) {
        const names = [...new Set(observations(b).map((o) => o.def.name))];
        out.push(`No values for ${missing.join(', ')}. Tests this record has: ${names.slice(0, 60).join(', ')}.`);
      }
      out.push('');
    }
    return { text: out.join('\n').trim() };
  },

  async read_document(a, ctx) {
    let docId = /^n:/.test(words(a.document_id)) ? words(a.document_id) : itemId(a.document_id);
    // A tumour board note, by its timeline item id (n:<note id>).
    if (/^n:/.test(docId)) {
      const pid = a.patient_id ? patientId(a.patient_id) : null;
      if (!pid) fail('Give the patient_id with a tumour board note id.');
      const note = (await notesFor(pid!)).find((n) => `n:${n.id}` === docId);
      if (!note) fail(`No tumour board note ${docId} for ${pid}.`);
      return {
        text: `Tumour board note by ${note!.author}, ${note!.date}${note!.eventId ? `, about ${note!.eventId}` : ''}:\n${note!.body}`,
      };
    }
    if (/^TCGA-.+\/report$/i.test(docId)) {
      const b = await ctx.getPatient(patientId(docId.split('/')[0]));
      if (!b.report.text) fail(`${who(b)} has no pathology report text.`);
      return {
        text: `Surgical pathology report for ${who(b)} (TCGA, ${b.report.source ?? 'OCR text'}${b.report.pdfPath ? ', scanned PDF' : ''}):\n${b.report.text.slice(0, 30_000)}`,
      };
    }
    if (!docId) {
      const b = await ctx.getPatient(patientId(a.patient_id));
      const text = words(a.text).toLowerCase();
      const found = b.documents.filter(
        (d) => (!a.type || d.type === a.type) && (!text || `${str(d.title)} ${str(d.type)}`.toLowerCase().includes(text))
      );
      if (!found.length) {
        if (b.source === 'research' && b.report.text) docId = `${idOf(b)}/report`;
        else
          fail(
            `No document matches for ${who(b)}. ${
              b.documents.length
                ? `Documents: ${b.documents
                    .slice(-20)
                    .map((d) => `${day(d.date)} ${str(d.type)} ${str(d.document_id)}`)
                    .join('; ')}`
                : 'The record has no documents.'
            }`
          );
        return handlers.read_document({ document_id: docId }, ctx);
      }
      docId = str(found[found.length - 1].document_id)!;
    }
    // A study (its UID or accession) stands for its report.
    if (/^\d+(\.\d+){3,}$/.test(docId) || (a.patient_id && !/^[A-Z]+-[A-Z0-9]+$/i.test(docId))) {
      if (!a.patient_id) fail(`Give the patient_id with study ${docId}.`);
      const b = await ctx.getPatient(patientId(a.patient_id));
      const study = b.studies.find((s) => s.study_uid === docId || s.accession === docId);
      const report = str(study?.report_id) ?? str(b.documents.find((d) => d.study_uid === docId || d.accession === docId)?.document_id);
      if (!report) fail(`No report is filed for study ${docId}.`);
      docId = report!;
    }
    const d = await fetchDocument(docId);
    const doc = d.document;
    const facts = d.facts.map(
      (f) =>
        `- ${[str(f.type), words(f.text), str(f.value) && `${str(f.value)}${str(f.unit) ? ` ${str(f.unit)}` : ''}`, str(f.site), str(f.laterality), str(f.code) && `${str(f.code_system) ?? ''} ${str(f.code)}`.trim()].filter(Boolean).join(' · ')}`
    );
    return {
      text: [
        `${str(doc.type)} ${str(doc.document_id)} for patient ${str(doc.patient_id)}: "${str(doc.title)}", ${day(doc.date)}, by ${str(doc.author)}, ${str(doc.department)}${doc.scanned ? '. A scanned PDF; the text below is what the scan was rendered from' : '. Typed text'}${str(doc.accession) ? `. About accession ${str(doc.accession)}` : ''}.`,
        '',
        d.text.slice(0, 30_000),
        '',
        facts.length ? `Facts it was written from (${facts.length}):` : 'No structured facts recorded.',
        ...facts.slice(0, 80),
      ].join('\n'),
    };
  },

  async imaging_studies(a, ctx) {
    const b = await ctx.getPatient(patientId(a.patient_id));
    return { text: [`${who(b)}:`, ...imagingText(b, true)].join('\n') };
  },

  async query_records(a) {
    const spec: QuerySpec = {
      subject: words(a.subject),
      filters: Array.isArray(a.filters) ? (a.filters as QuerySpec['filters']) : [],
      group_by: list(a.group_by),
      measure: words(a.measure) || undefined,
      patient_ids: a.patient_ids ? list(a.patient_ids).map(patientId) : undefined,
      order: a.order === 'asc' ? 'asc' : 'desc',
      limit: int(a.limit, 50, 1, 200),
    };
    const r = await queryRecords(spec);
    if ('error' in r) fail(r.error);
    const ok = r as { rows: Row[]; ms: number };
    if (!ok.rows.length) return { text: 'No rows: nothing matches.' };
    const cols = Object.keys(ok.rows[0]);
    return {
      text: [
        `${ok.rows.length} rows (${ok.ms} ms):`,
        cols.join(' | '),
        ...ok.rows.map((row) => cols.map((c) => (typeof row[c] === 'number' ? fmt(row[c] as number, 2) : words(row[c]))).join(' | ')),
      ].join('\n'),
    };
  },

  /* ---------------------------------------------------------------- display */

  async show_patients(a) {
    const ids = patientIds(a.patient_ids, 40);
    const r = await searchPatients({ ids, limit: ids.length });
    const missing = ids.filter((id) => !r.patients.some((p) => p.patient_id === id));
    if (missing.length === ids.length) fail(`None of these patients exist: ${missing.join(', ')}.`);
    const rows = ids.map((id) => r.patients.find((p) => p.patient_id === id)).filter(Boolean) as PatientListRow[];
    return {
      card: {
        kind: 'patients',
        title: words(a.title),
        note: words(a.note) || undefined,
        rows,
      },
      text: [
        `The card lists ${plural(rows.length, 'patient')}, each with a link to the record:`,
        ...rows.map(listRow),
        missing.length ? `Not found: ${missing.join(', ')}.` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },

  async show_timeline(a, ctx) {
    const ids = patientIds(a.patient_ids, 8);
    const bundles = await Promise.all(ids.map((id) => ctx.getPatient(id)));
    const kinds = list(a.kinds);
    const align = ids.length > 1 ? words(a.align) || 'calendar' : 'calendar';
    const from = day(a.from) ?? undefined;
    const to = day(a.to) ?? undefined;
    if (ids.length === 1) {
      const b = bundles[0];
      const m = buildModel(b);
      const count = (k: MarkKind[]) => m.marks.filter((x) => k.includes(x.kind)).length;
      return {
        card: {
          kind: 'timeline',
          title: words(a.title),
          bundles,
          kinds,
          align,
          from,
          to,
          anchors: [null],
        },
        text: `The card is ${who(b)}'s lifetime timeline, ${m.birth.toISOString().slice(0, 4)} to ${m.last.toISOString().slice(0, 10)}${day(b.patient.death_date) ? ' (died)' : ''}: ${count(['visit'])} visits, ${count(['condition'])} condition spans, ${count(['medication', 'vaccine'])} medication spans${m.hasCancer ? `, the cancer course from ${day(b.patient.diagnosis_date)} with ${count(['surgery', 'radiation', 'drug'])} treatment courses` : ''}, ${count(['scan'])} imaging studies, ${count(['slide'])} slides, ${count(['document', 'report'])} documents${count(['genome']) ? ' and the tumour genome' : ''}. Life before the cancer (or the last ten years) is compressed. The reader can zoom and select any mark.`,
      };
    }
    const match = words(a.match) || undefined;
    const anchors = bundles.map((b) => anchorDate(b, align, match));
    const kept = bundles.filter((_, i) => align === 'calendar' || anchors[i]);
    const left = bundles.filter((_, i) => align !== 'calendar' && !anchors[i]);
    if (!kept.length) fail(`None of these patients has the event '${align}'.`);
    const lines = kept.map((b) => {
      const evs = cohortMarks(b, kinds, from, to);
      const by = new Map<string, number>();
      evs.forEach((e) => by.set(e.kind, (by.get(e.kind) ?? 0) + 1));
      const anchor = anchors[bundles.indexOf(b)];
      return `- ${who(b)}: ${align !== 'calendar' ? `year 0 is ${anchor}; ` : ''}${[...by].map(([k, n]) => `${n} ${k}`).join(', ') || 'no events of these kinds'}`;
    });
    return {
      card: {
        kind: 'timeline',
        title: words(a.title),
        bundles: kept,
        kinds,
        align,
        match,
        from,
        to,
        anchors: kept.map((b) => anchors[bundles.indexOf(b)]),
      },
      text: [
        `The card has one row per patient on a shared axis${align === 'calendar' ? ' of calendar years' : `, aligned on ${align === 'first_cancer' && match ? `the first ${match} cancer diagnosis` : align.replace('_', ' ')} (years before and after)`}, with ${kinds.length ? kinds.join(', ') : 'the cancer course, treatment, imaging, slides and documents'}:`,
        ...lines,
        left.length ? `Left out (no ${match ? `${match} cancer` : align.replace('_', ' ')}): ${left.map(who).join(', ')}.` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },

  async show_measurements(a, ctx) {
    const ids = patientIds(a.patient_ids, 8);
    const tests = list(a.tests);
    if (!tests.length) fail('Name at least one test.');
    const bundles = await Promise.all(ids.map((id) => ctx.getPatient(id)));
    const from = day(a.from) ?? undefined;
    const to = day(a.to) ?? undefined;
    const all: Series[] = [];
    const missing: string[] = [];
    for (const b of bundles) {
      const r = seriesFor(b, tests, from, to);
      all.push(...r.series.filter((s) => s.points.length));
      if (r.missing.length) missing.push(`${who(b)}: ${r.missing.join(', ')}`);
    }
    if (!all.length) fail(`No values for ${tests.join(', ')}${from || to ? ' in that range' : ''}. ${missing.join('; ')}`);
    const panels = [...new Set(all.map((s) => s.test))];
    if (panels.length > 6) fail('Up to 6 tests in one card.');
    const marks = list(a.mark)
      .map(day)
      .filter((x): x is string => !!x);
    return {
      card: {
        kind: 'measurements',
        title: words(a.title),
        tests: panels,
        series: all,
        marks,
        from,
        to,
      },
      text: [
        `The card has ${plural(panels.length, 'panel')} (${panels.join(', ')}), one line per patient, the usual range shaded${marks.length ? `, vertical lines at ${marks.join(', ')}` : ''}:`,
        ...all.map((s) => `${s.name} (${s.patientId}) ${describeSeries(s, 0).split('\n')[0]}`),
        missing.length ? `No values: ${missing.join('; ')}.` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },

  async show_scan(a, ctx) {
    const b = await ctx.getPatient(patientId(a.patient_id));
    const sc =
      findShowcase(b, a.study, 'radiology') ??
      (!itemId(a.study) && !viewerSeries(b).length ? (showcaseOf(b).find((r) => r.section === 'radiology') ?? null) : null);
    if (sc) return showcaseScan(b, sc, a);
    const s = pickSeries(b, a.study);
    const nodules = nodulesOf(b, s.study_uid);
    const measures = parseJson<Record<string, { label?: number; volumeMl?: number }>>(s.ai_measures, {});
    const outlined = s.labels_kind === 'radiologists';
    const names = Object.keys(measures);
    // Nodules go by their PACS label, as the viewer's legend shows them ("Nodule 6"); the legend lists them largest first.
    const want = a.nodule != null && String(a.nodule).trim() !== '' ? int(String(a.nodule).replace(/\D+/g, ''), 0, 0, 999) : null;
    let at: number | null = outlined && names.length ? 1 : null;
    if (want !== null && outlined) {
      const i = names.findIndex((k) => k.startsWith(`Nodule ${want} `) || k === `Nodule ${want}`);
      if (i < 0) fail(`This CT has no Nodule ${want}. Its outlined nodules: ${names.join('; ')}.`);
      at = i + 1;
    }
    const asked = ['3d', 'mpr', 'axial', 'coronal'].includes(String(a.view)) ? String(a.view) : null;
    // Centring on a nodule needs the slices; 3D shows the whole chest.
    const view = asked === '3d' && want !== null ? 'mpr' : (asked ?? (outlined ? 'mpr' : s.modality === 'CT' ? '3d' : 'mpr'));
    const study = b.studies.find((x) => x.study_uid === s.study_uid);
    return {
      card: {
        kind: 'scan',
        title: words(a.title),
        bundle: b,
        seriesKey: str(s.series_key)!,
        view,
        nodule: at,
      },
      text: [
        `The card shows ${who(b)}'s ${str(s.modality)} of ${day(s.date)} (${words(s.description) || words(study?.description)}${study ? `, accession ${str(study.accession)}` : ''}) in the ${view === '3d' ? '3D' : view === 'mpr' ? 'multi-planar' : view} view; ${num(s.images) ?? '?'} images${num(s.slice_thickness_mm) ? `, ${fmt(num(s.slice_thickness_mm))} mm slices` : ''}.`,
        outlined
          ? `Radiologists' outlines are on. ${view === '3d' ? 'In 3D the whole chest shows with every outline coloured; to centre on one nodule, use view mpr, axial or coronal with nodule set.' : `The slices are centred on ${names[(at ?? 1) - 1]?.split(' (')[0]}.`} The viewer's legend lists the outlined nodules largest first: ${Object.entries(
              measures
            )
              .map(([k, v]) => `${k} ${fmt(num(v.volumeMl ?? null), 2)} mL`)
              .join('; ')}.`
          : '',
        nodules.length ? `PACS nodule findings for this study: ${nodules.map(noduleLine).join('; ')}.` : '',
        !outlined && Object.keys(measures).length
          ? `AI segmentation: ${Object.entries(measures)
              .map(([k, v]) => `${k} ${fmt(num(v.volumeMl ?? null))} mL`)
              .join('; ')}.`
          : '',
        s.geometry_assumed ? 'This MRI is a secondary capture without geometry: 1 mm voxels are assumed.' : '',
        study && str(study.report_id) ? `Its report is ${str(study.report_id)}.` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },

  async show_slide(a, ctx) {
    const b = await ctx.getPatient(patientId(a.patient_id));
    const sc =
      findShowcase(b, a.slide, 'pathology') ??
      (!itemId(a.slide) && !viewerSlides(b).length ? (showcaseOf(b).find((r) => r.section === 'pathology') ?? null) : null);
    if (sc) return showcaseSlide(b, sc, a);
    if (list(a.channels).length) fail('Marker channels belong to a fluorescence slide; this is an H&E slide.');
    const sl = pickSlide(b, a.slide);
    const overlays = list(a.layers).length ? pickOverlays(str(sl.til_overlay_path) ? ['lymphocytes'] : [], list(a.layers)) : null;
    const hasReport =
      b.source === 'research'
        ? !!b.report.pdfPath
        : b.documents.some((d) => d.document_id === sl.report_id && d.scanned && str(d.path));
    const report = yes(a.report) && hasReport;
    return {
      card: {
        kind: 'slide',
        title: words(a.title),
        bundle: b,
        slideId: str(sl.slide_id)!,
        overlays,
        report,
      },
      text: `The card shows ${who(b)}'s H&E slide of ${day(sl.date) ?? 'diagnosis'} (${words(sl.specimen)}${str(sl.accession) ? `, accession ${str(sl.accession)}` : ''}, ${str(sl.barcode)}) in the deep-zoom viewer: ${fmt(((num(sl.width) ?? 0) * (num(sl.height) ?? 0)) / 1e9)} gigapixels, ${num(sl.objective_power) ?? 40}x${num(sl.mpp) ? `, ${fmt(num(sl.mpp), 3)} µm per pixel` : ''}. It opens on the whole section; the reader can zoom to cells and take the guided tour.${str(sl.til_overlay_path) ? ` The AI lymphocyte map ${overlays ? 'is on' : 'can be switched on (layers lymphocytes)'}: ${fmt((num(sl.til_positive_fraction) ?? 0) * 100)}% of tissue TIL-positive.` : ''}${str(sl.report_id) ? ` Its pathology report is ${str(sl.report_id)}.` : ''}${report ? ' The scanned report is open beside the slide.' : yes(a.report) ? ' This slide has no scanned report to open beside it; show_document shows the report text.' : ''}`,
    };
  },

  async show_xray(a, ctx) {
    const b = await ctx.getPatient(patientId(a.patient_id));
    const s = pickXray(b, a.study);
    const images = parseJson<{ view: string }[]>(s.xray_images, []);
    return {
      card: { kind: 'xray', title: words(a.title), bundle: b, series: s },
      text: `The card shows ${who(b)}'s chest X-ray of ${day(s.date)} (${words(s.description)}): ${plural(images.length, 'view')}${
        images.length
          ? ` (${images
              .map((i) => i.view)
              .filter(Boolean)
              .join(', ')})`
          : ''
      }, zoomable.`,
    };
  },

  async show_document(a, ctx) {
    const id = itemId(a.document_id);
    if (/^TCGA-.+\/report$/i.test(id)) {
      const b = await ctx.getPatient(patientId(id.split('/')[0]));
      if (!b.report.text && !b.report.pdfPath) fail(`${who(b)} has no pathology report.`);
      return {
        card: { kind: 'document', title: words(a.title), bundle: b, doc: null },
        text: `The card shows ${who(b)}'s surgical pathology report${b.report.pdfPath ? ', the scanned PDF beside its OCR text' : ' (OCR text)'}.`,
      };
    }
    if (!id) fail('Give a document_id (patient_events or patient_overview list them).');
    const d = await fetchDocument(id);
    const b = await ctx.getPatient(patientId(d.document.patient_id));
    const doc = b.documents.find((x) => x.document_id === id) ?? d.document;
    return {
      card: { kind: 'document', title: words(a.title), bundle: b, doc },
      text: `The card shows ${str(doc.type)} ${id} of ${day(doc.date)} for ${who(b)}: "${str(doc.title)}", ${d.text.split(/\s+/).length} words, ${d.facts.length} facts marked${doc.scanned ? ', with the scanned PDF beside the text' : ''}.`,
    };
  },

  async show_genome(a, ctx) {
    const b = await ctx.getPatient(patientId(a.patient_id));
    if (!b.genomes.length)
      fail(
        `${who(b)} has no tumour genome. The research patients (TCGA-…) and the hospital patients whose biopsy slide is a TCGA case have one; find_patients with has ['genome'] lists them.`
      );
    const want = words(a.tumour).toUpperCase();
    const g = want ? b.genomes.find((x) => x.barcode === want) : b.genomes[0];
    if (!g) fail(`${who(b)} has no genome ${want}. Theirs: ${b.genomes.map((x) => `${x.barcode} (${x.cancer})`).join(', ')}.`);
    const others = b.genomes.filter((x) => x !== g);
    return {
      card: { kind: 'genome', title: words(a.title), bundle: b, genome: g!.barcode },
      text: `The card is ${who(b)}'s tumour genome ${g!.barcode} (${g!.cancer}): TMB ${fmt(num(g!.profile.tmb))} mutations/Mb against ${num(g!.profile.cohort_size)} TCGA tumours of the same type, the copy-number profile and every mutation along the genome, driver alterations (${
        g!.drivers
          .slice(0, 8)
          .map((d) => `${str(d.gene)} ${str(d.protein_change) ?? ''}`.trim())
          .join(', ') || 'none'
      }), expression and the immune mix.${
        others.length ? ` ${who(b)} has ${others.length === 1 ? 'one more genome' : `${others.length} more genomes`}: ${others.map((x) => `${x.barcode} (${x.cancer})`).join(', ')}.` : ''
      }`,
    };
  },


  /** Two to four views side by side: each item is another display tool's card, drawn in its own column. */
  async show_side_by_side(a, ctx) {
    const items = Array.isArray(a.items) ? (a.items as Args[]) : fail('items must be a list of 2 to 4 views.');
    if (items!.length < 2 || items!.length > 4) fail('Give 2 to 4 items.');
    const results = await Promise.all(
      items!.map(async (it, i) => {
        const tool = words(it?.tool);
        if (!SIDE_TOOLS.has(tool)) fail(`items[${i}].tool must be one of ${[...SIDE_TOOLS].join(', ')}.`);
        const label = words(it.label) || fail(`items[${i}] needs a label.`);
        const args = it.args && typeof it.args === 'object' ? (it.args as Args) : {};
        // A column is too narrow for a report beside its slide; the report takes a column of its own instead.
        const noReport = tool === 'show_slide' && yes(args.report);
        try {
          const r = await handlers[tool]({ ...args, ...(noReport ? { report: false } : {}), title: label }, ctx);
          const text = noReport
            ? `${r.text}\nIn a side-by-side column the report doesn't open beside the slide: give it a column of its own (show_document), or show the slide alone with report true.`
            : r.text;
          return r.card ? { label: label!, note: words(it.note) || undefined, card: r.card, text } : fail(`items[${i}] drew nothing.`);
        } catch (e) {
          return fail(`items[${i}] (${tool}): ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
    let facts: { label: string; values: string[] }[] | undefined;
    if (a.facts !== undefined) {
      const rows = Array.isArray(a.facts) ? (a.facts as Args[]) : fail('facts must be a list of {label, values}.');
      facts = rows!.slice(0, 10).map((r, i) => {
        const values = Array.isArray(r?.values) ? (r.values as unknown[]).map((v) => words(v)) : fail(`facts[${i}].values must be a list.`);
        if (values!.length !== results.length) fail(`facts[${i}] needs one value per item (${results.length}).`);
        return { label: words(r.label) || fail(`facts[${i}] needs a label.`)!, values: values! };
      });
    }
    return {
      card: {
        kind: 'side',
        title: words(a.title),
        subtitle: words(a.subtitle) || undefined,
        panes: results.map(({ label, note, card }) => ({ label, note, card })),
        facts,
      },
      text: `The card puts ${results.length} views side by side, left to right. ${results.map((r) => `${r.label}: ${r.text}`).join(' ')}${
        facts?.length ? ` Under them, a table compares ${facts.map((f) => f.label).join(', ')}.` : ''
      }`,
    };
  },

  async show_chart(a) {
    const rows = Array.isArray(a.rows) ? (a.rows as Row[]) : fail('rows must be a list of objects.');
    if (!rows!.length) fail('rows is empty.');
    if (rows!.length > 2000) fail('Up to 2,000 rows.');
    const spec = a.spec && typeof a.spec === 'object' ? (a.spec as Record<string, unknown>) : fail('spec must be a Vega-Lite object.');
    return {
      card: {
        kind: 'chart',
        title: words(a.title),
        subtitle: words(a.subtitle) || undefined,
        spec: spec!,
        rows: rows!,
      },
      text: `The card draws ${plural(rows!.length, 'row')} as a ${String((spec as { mark?: unknown }).mark && typeof (spec as { mark?: unknown }).mark === 'object' ? ((spec as { mark: { type?: string } }).mark.type ?? 'chart') : ((spec as { mark?: unknown }).mark ?? 'layered chart'))}.`,
    };
  },

  async open_record(a, ctx) {
    const b = await ctx.getPatient(patientId(a.patient_id));
    const tab = words(a.tab) || 'summary';
    const item = words(a.item) || null;
    return {
      card: {
        kind: 'record',
        title: words(a.title),
        patientId: idOf(b),
        name: nameOf(b),
        tab,
        item,
      },
      text: `The card links to ${who(b)}'s record, ${tab} tab${item ? `, at ${item}` : ''}.`,
    };
  },

  async draft_note(a, ctx) {
    const b = await ctx.getPatient(patientId(a.patient_id));
    // Keep the note's own lines and paragraphs.
    const text = String(a.text ?? '')
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!text) fail('The note is empty.');
    if (text.length > 4000) fail('Notes are up to 4,000 characters.');
    return {
      card: {
        kind: 'note',
        title: words(a.title),
        patientId: idOf(b),
        name: nameOf(b),
        text,
        about: words(a.about) || null,
      },
      text: `The draft is shown to the reader with a button to add it to ${who(b)}'s tumour board notes. Nothing is saved unless they add it.`,
    };
  },
};

/* ------------------------------------------------------------------ multi-patient timelines */

export function anchorDate(b: PatientBundle, align: string, match?: string): string | null {
  switch (align) {
    case 'first_cancer': {
      if (!match) return day(b.patient.diagnosis_date);
      const m = match.toLowerCase();
      const named = (...v: unknown[]) =>
        v.some((x) =>
          String(x ?? '')
            .toLowerCase()
            .includes(m)
        );
      const dates = b.diagnoses
        .filter((d) => named(d.primary_diagnosis, d.site) && day(d.date))
        .map((d) => day(d.date)!)
        .sort();
      if (dates.length) return dates[0];
      return named(b.patient.cancer_type, b.patient.primary_diagnosis, b.patient.organ) ? day(b.patient.diagnosis_date) : null;
    }
    case 'first_ct': {
      const ct = (b.source === 'epic' ? b.studies : b.radiologyStudies)
        .filter((s) => /CT/.test(str(s.modalities) ?? ''))
        .map((s) => day(s.date))
        .filter(Boolean) as string[];
      return ct.sort()[0] ?? null;
    }
    case 'first_slide':
      return (b.slides.map((s) => day(s.date)).filter(Boolean) as string[]).sort()[0] ?? null;
    case 'death':
      return day(b.patient.death_date);
    default:
      return null;
  }
}

export type CohortMark = {
  kind: string;
  date: string;
  end?: string;
  title: string;
  detail: string;
  item: string | null;
};

/** The events drawn for one patient in a multi-patient timeline. */
export function cohortMarks(b: PatientBundle, kinds: string[], from?: string, to?: string): CohortMark[] {
  const want = new Set(kinds.length ? kinds : ['diagnosis', 'treatment', 'study', 'slide', 'document']);
  const out: CohortMark[] = [];
  for (const e of events(b, [])) {
    if (!want.has(e.kind) || !inRange(e.date, from, to)) continue;
    // By default only reports: progress notes would crowd the rows.
    if (e.kind === 'document' && !kinds.length && !/Radiology|Pathology|pathology report/i.test(`${e.title} ${e.details}`)) continue;
    out.push({
      kind: e.kind,
      date: e.date,
      title: e.title,
      detail: e.details,
      item: e.item,
    });
  }
  // Treatment courses keep their span.
  for (const m of out) {
    if (m.kind !== 'treatment') continue;
    const end = /to (\d{4}-\d{2}-\d{2})/.exec(m.detail)?.[1];
    if (end) m.end = end;
  }
  return out;
}

/* ------------------------------------------------------------------ entry point */

export async function runTool(name: string, args: Args, ctx: ToolCtx): Promise<ToolResult> {
  const h = handlers[name];
  if (!h) throw new Error(`Unknown tool ${name}`);
  try {
    return await h(args ?? {}, ctx);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(/not found|no rows|404/i.test(msg) ? `Not found: ${msg}` : msg);
  }
}

/** The views show_side_by_side can put next to each other. */
const SIDE_TOOLS = new Set(['show_scan', 'show_slide', 'show_xray', 'show_document', 'show_genome', 'show_timeline', 'show_measurements']);

export const DISPLAY_TOOLS = new Set([
  'show_patients',
  'show_timeline',
  'show_measurements',
  'show_scan',
  'show_slide',
  'show_xray',
  'show_document',
  'show_genome',
  'show_chart',
  'show_side_by_side',
  'open_record',
  'draft_note',
]);
