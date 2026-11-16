import { DRAG_MODE, Niivue, SHOW_RENDER, SLICE_TYPE } from '@niivue/niivue';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';

import { layerFile, type Locator, type TractBundle, type VolumeStudy } from './types';

export type ViewMode = 'render' | 'multiplanar' | 'axial' | 'coronal' | 'sagittal';

export interface ColourPreset {
  id: string;
  label: string;
  colormap: string;
  calMin?: number;
  calMax?: number;
  /** Gradient-weighted opacity: edges stay, uniform interiors turn see-through. */
  glass?: { gradientOpacity: number; silhouette: number };
}

export interface LayerSetting {
  visible: boolean;
  opacity: number;
  colormap?: string;
}

export interface ClipSetting {
  on: boolean;
  depth: number;
  /** Which way the cut faces: front (coronal), side (sagittal) or top (axial). */
  face: 'front' | 'side' | 'top';
}

export interface VolumeViewerStatus {
  loading: boolean;
  error: string | null;
  loadMs: number | null;
  location: string | null;
}

/** A tractography atlas's bundles: the ones left out, and colour by line direction or one colour per bundle. */
export interface TractSettings {
  hidden: string[];
  colour: 'direction' | 'bundle';
}

/** A volume drawn over the base image: a bundle's probability map (percent of people) or its volume. */
export interface FocusVolume {
  file: string;
  kind: 'prob' | 'mask';
  colour: string;
  /** Where to put the crosshair, in mm, so every slice cuts through it. */
  centreMm?: [number, number, number];
}

export interface VolumeViewerHandle {
  resetView: () => void;
  saveImage: () => void;
  /** Moves the crosshair to the centre of one label of a label layer (an outlined nodule); false if it is empty. */
  goToLabel: (layerId: string, label: number) => boolean;
}

interface Props {
  study: VolumeStudy;
  /** URLs of the study's files, from paths relative to its folder. */
  files: Locator;
  frameIndex: number;
  view: ViewMode;
  preset: ColourPreset | null;
  layers: Record<string, LayerSetting>;
  clip: ClipSetting;
  spin: boolean;
  /** A tractography atlas: which bundles to draw and how to colour them. */
  tracts?: TractSettings;
  focus?: FocusVolume | null;
  onStatus: (status: VolumeViewerStatus) => void;
  /** After a study (not a timeline frame) has loaded and its settings are applied. */
  onLoaded?: () => void;
}

const SLICE: Record<ViewMode, SLICE_TYPE> = {
  render: SLICE_TYPE.RENDER,
  multiplanar: SLICE_TYPE.MULTIPLANAR,
  axial: SLICE_TYPE.AXIAL,
  coronal: SLICE_TYPE.CORONAL,
  sagittal: SLICE_TYPE.SAGITTAL,
};

/** Default camera: patient facing the viewer, slightly from above. */
const HOME = { azimuth: 180, elevation: 12 };
const CLIP_ANGLES: Record<ClipSetting['face'], [number, number]> = {
  front: [180, 0],
  side: [270, 0],
  top: [0, 90],
};

/** Camera azimuth/elevation that looks onto the exposed cut surface for each clip direction. */
const CLIP_CAMERA: Record<ClipSetting['face'], [number, number]> = {
  front: [180, 12],
  side: [90, 8],
  top: [180, -80],
};

function themeColours(): { back: number[]; font: number[] } {
  const dark = document.documentElement.dataset.theme === 'dark';
  return dark
    ? { back: [0.078, 0.078, 0.075, 1], font: [0.94, 0.93, 0.9, 1] }
    : { back: [0.914, 0.902, 0.863, 1], font: [0.08, 0.08, 0.07, 1] };
}

/** The centre of one label in a label volume, in voxels as stored, or null when the label is empty. */
function labelCentre(img: ArrayLike<number>, dims: number[], label: number): [number, number, number] | null {
  const [nx, ny] = [dims[1], dims[2]];
  let sx = 0, sy = 0, sz = 0, n = 0;
  for (let i = 0; i < img.length; i++) {
    if (img[i] !== label) continue;
    sx += i % nx;
    sy += Math.floor(i / nx) % ny;
    sz += Math.floor(i / (nx * ny));
    n++;
  }
  return n ? [sx / n, sy / n, sz / n] : null;
}

/** The fibre-line fields of a NiiVue mesh that this viewer sets (not in its public types). */
type FiberMesh = {
  offsetPt0: Uint32Array | null;
  groups: { id: string; vals: Int32Array }[] | null;
  fiberGroupColormap: { R: number[]; G: number[]; B: number[]; A: number[]; I: number[] } | null;
  dps: { id: string; vals: Float32Array; global_min: number; global_max: number; cal_min: number; cal_max: number }[] | null;
  dpsThreshold: number;
  updateMesh: (gl: WebGL2RenderingContext) => void;
};

const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/**
 * Draws one group file's bundles: each in its own colour (NiiVue's line groups, a hidden bundle's alpha 0), or by line
 * direction with the hidden bundles' lines below a per-line threshold.
 */
function paintTracts(gl: WebGL2RenderingContext, mesh: FiberMesh, bundles: TractBundle[], tracts: TractSettings): void {
  if (!mesh.offsetPt0) return;
  const hidden = new Set(tracts.hidden);
  if (tracts.colour === 'bundle') {
    mesh.groups = bundles.map((b) => ({ id: b.id, vals: Int32Array.from({ length: b.lines }, (_, i) => b.first + i) }));
    const rgb = bundles.map((b) => rgbOf(b.colour));
    mesh.fiberGroupColormap = {
      R: rgb.map((c) => c[0]),
      G: rgb.map((c) => c[1]),
      B: rgb.map((c) => c[2]),
      A: bundles.map((b) => (hidden.has(b.id) ? 0 : 255)),
      I: bundles.map((_, i) => i),
    };
    mesh.dpsThreshold = NaN;
  } else {
    mesh.fiberGroupColormap = null;
    if (bundles.some((b) => hidden.has(b.id))) {
      const vals = new Float32Array(mesh.offsetPt0.length - 1).fill(1);
      for (const b of bundles) if (hidden.has(b.id)) vals.fill(0, b.first, b.first + b.lines);
      mesh.dps = [{ id: 'shown', vals, global_min: 0, global_max: 1, cal_min: 0, cal_max: 1 }];
      mesh.dpsThreshold = 0.5;
    } else {
      mesh.dpsThreshold = NaN;
    }
  }
  mesh.updateMesh(gl);
}

/** Point the camera at the cut surface when clipping, otherwise at the patient's front. */
function faceCamera(nv: Niivue, clip: ClipSetting, home: { azimuth: number; elevation: number } = HOME): void {
  if (!clip.on) {
    nv.setRenderAzimuthElevation(home.azimuth, home.elevation);
    return;
  }
  const view = CLIP_CAMERA[clip.face];
  nv.setRenderAzimuthElevation(view[0], view[1]);
}

export const VolumeViewer = forwardRef<VolumeViewerHandle, Props>(function VolumeViewer(
  { study, files, frameIndex, view, preset, layers, clip, spin, tracts, focus, onStatus, onLoaded },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nvRef = useRef<Niivue | null>(null);
  const indexRef = useRef<Record<string, number>>({});
  const meshIndexRef = useRef<Record<string, number>>({});
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const loadedRef = useRef<{ key: string; frame: number } | null>(null);
  const statusRef = useRef<VolumeViewerStatus>({ loading: true, error: null, loadMs: null, location: null });
  const settingsRef = useRef({ view, preset, layers, clip, tracts, focus });
  const onStatusRef = useRef(onStatus);
  const onLoadedRef = useRef(onLoaded);
  /** The bundle settings each tracts mesh was last drawn with. */
  const paintedRef = useRef<Record<string, string>>({});
  const focusRef = useRef<{ file: string; vol: Niivue['volumes'][number] } | null>(null);
  settingsRef.current = { view, preset, layers, clip, tracts, focus };
  onStatusRef.current = onStatus;
  onLoadedRef.current = onLoaded;

  const frames4d = study.timeline?.mode === 'frames4d';
  // A timeline of separate files loads only the layers that are switched on (and the base image) for each frame, so
  // a study with many channels, like the fetal atlas, plays as fast as one with two. Switching a layer on loads it.
  const perFile = !!study.timeline && !frames4d;
  const loadIds = perFile
    ? study.layers
        .filter((l, i) => l.kind !== 'tracts' && (i === 0 || layers[l.id]?.visible !== false))
        .map((l) => l.id)
        .join(',')
    : '';
  // Identity of the loaded data, not just the study id: a refreshed catalog can rename or replace files.
  const dataKey = useMemo(
    () => JSON.stringify([study.id, study.layers.map((l) => [l.id, l.file, l.lut]), study.timeline?.frames.length ?? 0]),
    [study]
  );

  /** Show one time point of every 4D layer. */
  const showFrame = (nv: Niivue, frame: number) => {
    if (!frames4d) return;
    for (const layer of study.layers) {
      const i = indexRef.current[layer.id];
      const vol = i === undefined ? undefined : nv.volumes[i];
      if (layer.frames4d && vol && (vol.nFrame4D ?? 1) > 1) {
        nv.setFrame4D(vol.id, Math.min(frame, (vol.nFrame4D ?? 1) - 1));
      }
    }
  };

  const emit = (patch: Partial<VolumeViewerStatus>) => {
    statusRef.current = { ...statusRef.current, ...patch };
    onStatusRef.current(statusRef.current);
  };

  /** Push the current React settings into NiiVue without reloading data. */
  const apply = () => {
    const nv = nvRef.current;
    if (!nv || nv.volumes.length === 0) return;
    const { view: v, preset: p, layers: ls, clip: c } = settingsRef.current;
    const idx = indexRef.current;
    for (const layer of study.layers) {
      const i = idx[layer.id];
      if (i === undefined || !nv.volumes[i]) continue;
      const vol = nv.volumes[i];
      const s = ls[layer.id];
      if (i === 0 && p && layer.kind !== 'rgba') {
        vol.colormap = p.colormap;
        if (p.calMin !== undefined) vol.cal_min = p.calMin;
        if (p.calMax !== undefined) vol.cal_max = p.calMax;
      }
      if (layer.kind === 'overlay' && s?.colormap) vol.colormap = s.colormap;
      // Labels drawn over slices hide the anatomy under them; at half strength the outline and the tissue both show.
      const flat = layer.kind === 'labels' && v !== 'render' ? 0.5 : 1;
      vol.opacity = s && !s.visible ? 0 : (s?.opacity ?? 1) * flat;
    }
    for (const [id, mi] of Object.entries(meshIndexRef.current)) {
      const mesh = nv.meshes[mi];
      const s = ls[id];
      if (!mesh) continue;
      mesh.visible = s ? s.visible : true;
      mesh.opacity = s?.opacity ?? 1;
      const tr = settingsRef.current.tracts;
      if (tr && study.bundles?.length && nv.gl) {
        const key = JSON.stringify(tr);
        if (paintedRef.current[id] !== key) {
          paintedRef.current[id] = key;
          paintTracts(nv.gl, mesh as unknown as FiberMesh, study.bundles.filter((b) => b.group === id), tr);
        }
      }
    }
    const f = settingsRef.current.focus;
    const prob = !!f && f.kind === 'prob' && !!focusRef.current;
    nv.opts.isColorbar = prob || study.layers.some((l) => l.kind === 'overlay' && ls[l.id]?.visible);
    for (const [id, i] of Object.entries(idx)) {
      if (nv.volumes[i]) nv.volumes[i].colorbarVisible = study.layers.find((l) => l.id === id)?.kind === 'overlay';
    }
    if (focusRef.current) focusRef.current.vol.colorbarVisible = prob;
    // Single-plane cine has nothing to cross-reference: hide the crosshair.
    nv.opts.crosshairWidth = study.views && study.views.length === 1 ? 0 : 1;
    const glass = p?.glass ?? { gradientOpacity: 0, silhouette: 0 };
    if (nv.opts.gradientOpacity !== glass.gradientOpacity || nv.opts.renderSilhouette !== glass.silhouette) {
      void nv.setGradientOpacity(glass.gradientOpacity, glass.silhouette);
    }
    nv.updateGLVolume();
    nv.setSliceType(SLICE[v]);
    const [az, el] = CLIP_ANGLES[c.face];
    nv.setClipPlane(c.on ? [c.depth, az, el] : [2, 0, 0]);
  };

  // Create the NiiVue instance once.
  useEffect(() => {
    if (!canvasRef.current) return;
    const { back, font } = themeColours();
    const nv = new Niivue({
      backColor: back,
      fontColor: font,
      show3Dcrosshair: false,
      crosshairColor: [0.95, 0.39, 0.1, 1],
      crosshairWidth: 1,
      isOrientCube: true,
      isColorbar: false,
      colorbarHeight: 0.025,
      colorbarWidth: 0.4,
      fontMinPx: 12,
      fontSizeScaling: 0.3,
      multiplanarShowRender: SHOW_RENDER.ALWAYS,
      dragMode: DRAG_MODE.pan,
      dragAndDropEnabled: false,
      loadingText: '',
      // Fully transparent: the cut surface itself shows the anatomy.
      clipPlaneColor: [0, 0, 0, 0],
      // The cut goes through every layer (labels, PET), not just the base volume.
      isClipAllVolumes: true,
      isAntiAlias: true,
    });
    nvRef.current = nv;
    // Lung parenchyma (about -950 to -450 HU) in pink; air and soft tissue transparent. Spans -1000..-300 HU.
    nv.addColormap('ct_lung_glass', {
      min: -1000,
      max: -300,
      R: [0, 0, 236, 244, 0, 0],
      G: [0, 0, 150, 176, 0, 0],
      B: [0, 0, 170, 192, 0, 0],
      A: [0, 0, 140, 220, 0, 0],
      I: [0, 20, 60, 150, 200, 255],
    });
    // Opaque greyscale for MRI: a clip shows the cut face itself instead of a haze of the tissue behind it.
    nv.addColormap('mri_solid', {
      R: [0, 8, 40, 255],
      G: [0, 8, 40, 255],
      B: [0, 8, 40, 255],
      A: [0, 0, 255, 255],
      I: [0, 8, 40, 255],
    });
    // Warm skin tones with lighting, in the style of 3D obstetric ultrasound. The gradual opacity ramp spreads
    // the surface over a few samples, which avoids wood-grain banding on smooth skin.
    nv.addColormap('mri_sepia', {
      R: [0, 90, 200, 245, 255],
      G: [0, 55, 140, 205, 240],
      B: [0, 30, 80, 150, 210],
      A: [0, 0, 40, 160, 255],
      I: [0, 8, 45, 110, 255],
    });
    void nv.attachToCanvas(canvasRef.current).then(() => {
      nv.onLocationChange = (data: unknown) => {
        const d = data as { string?: string };
        emit({ location: d.string ?? null });
      };
    });
    const observer = new MutationObserver(() => {
      const c = themeColours();
      nv.opts.backColor = c.back;
      nv.opts.fontColor = c.font;
      nv.drawScene();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      observer.disconnect();
      nvRef.current = null;
      try {
        nv.gl?.getExtension('WEBGL_lose_context')?.loseContext();
      } catch {
        // Context already gone.
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Right- or middle-drag pans the 3D view as it does the slices (NiiVue pans only the slices). The offset is NiiVue's
  // camera position, in mm across the view.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    type Camera = { position?: number[]; furthestFromPivot: number };
    let drag: { x: number; y: number; from: number[] } | null = null;
    const down = (e: PointerEvent) => {
      const nv = nvRef.current;
      if (!nv || settingsRef.current.view !== 'render' || (e.button !== 1 && e.button !== 2)) return;
      const at = (nv as unknown as Camera).position ?? [0, 0, 0];
      drag = { x: e.clientX, y: e.clientY, from: [at[0], at[1], at[2]] };
    };
    const move = (e: PointerEvent) => {
      const nv = nvRef.current;
      if (!drag || !nv) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const span = (1.6 * (nv as unknown as Camera).furthestFromPivot) / nv.scene.volScaleMultiplier;
      const perPx = span / Math.min(w, h);
      (nv as unknown as Camera).position = [drag.from[0] - (e.clientX - drag.x) * perPx, drag.from[1] - (e.clientY - drag.y) * perPx, drag.from[2]];
      nv.drawScene();
    };
    const up = () => {
      drag = null;
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, []);

  // (Re)load data when the study or timeline frame changes. Loads are serialised.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const nv = nvRef.current;
      if (!nv || cancelled) return;
      const sameStudy = loadedRef.current?.key === dataKey;
      const camera = sameStudy
        ? { az: nv.scene.renderAzimuth, el: nv.scene.renderElevation, scale: nv.scene.volScaleMultiplier }
        : null;
      emit({ loading: true, error: null });
      const started = performance.now();
      try {
        const shown = settingsRef.current.layers;
        const entries = study.layers
          .filter((layer, i) => layer.kind !== 'tracts' && (!perFile || i === 0 || shown[layer.id]?.visible !== false))
          .map((layer) => ({ layer, file: layerFile(study, layer, frameIndex) }))
          .filter((e): e is { layer: (typeof study.layers)[number]; file: string } => !!e.file);
        const tracts = study.layers.filter((l) => l.kind === 'tracts' && l.file);
        if (!sameStudy) {
          for (const m of [...nv.meshes]) nv.removeMesh(m);
          meshIndexRef.current = {};
          paintedRef.current = {};
        }
        // Loading replaces every volume, the probability map with them.
        focusRef.current = null;
        const s = settingsRef.current.layers;
        await nv.loadVolumes(
          entries.map(({ layer, file }, i) => ({
            url: files(file),
            name: file.split('/').pop() ?? file,
            colormap: layer.kind === 'overlay' ? (s[layer.id]?.colormap ?? layer.colormap ?? 'hot') : 'gray',
            ...(layer.calMin !== undefined ? { cal_min: layer.calMin } : {}),
            ...(layer.calMax !== undefined ? { cal_max: layer.calMax } : {}),
            opacity: i === 0 ? 1 : (layer.opacity ?? 1),
          }))
        );
        if (cancelled) return;
        indexRef.current = Object.fromEntries(entries.map(({ layer }, i) => [layer.id, i]));
        await Promise.all(
          entries.map(async ({ layer }, i) => {
            if (layer.kind === 'labels' && layer.lut && nv.volumes[i]) {
              await nv.volumes[i].setColormapLabelFromUrl(files(layer.lut));
            }
          })
        );
        if (cancelled) return;
        if (!sameStudy && tracts.length) {
          await nv.loadMeshes(
            tracts.map((l) => ({ url: files(l.file!), name: l.file!.split('/').pop() ?? l.file! }))
          );
          meshIndexRef.current = Object.fromEntries(tracts.map((l, i) => [l.id, i]));
          for (const m of nv.meshes) {
            nv.setMeshProperty(m.id as unknown as number, 'fiberColor', 'Global');
            nv.setMeshProperty(m.id as unknown as number, 'fiberRadius', 0.35);
          }
        }
        if (cancelled) return;
        if (!sameStudy) {
          await nv.setVolumeRenderIllumination(study.layers[0]?.kind === 'rgba' ? 0.35 : 0.55);
        }
        showFrame(nv, frameIndex);
        if (camera) {
          nv.scene.volScaleMultiplier = camera.scale;
          nv.setRenderAzimuthElevation(camera.az, camera.el);
        } else {
          (nv as unknown as { position?: number[] }).position = [0, 0, 0];
          faceCamera(nv, settingsRef.current.clip, study.defaultCamera);
        }
        loadedRef.current = { key: dataKey, frame: frameIndex };
        apply();
        await loadFocus();
        emit({ loading: false, loadMs: Math.round(performance.now() - started) });
        if (!sameStudy) onLoadedRef.current?.();
      } catch (err) {
        console.error('Volume load failed', err);
        if (!cancelled) emit({ loading: false, error: err instanceof Error ? err.message : String(err) });
      }
    };
    queueRef.current = queueRef.current.then(run, run);
    return () => {
      cancelled = true;
    };
    // The SAS query is read at load time; a refreshed token does not require reloading loaded data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, frames4d ? 0 : frameIndex, loadIds]);

  /** Puts the asked-for probability map or bundle volume over the base image (or takes it away). */
  const loadFocus = async () => {
    const nv = nvRef.current;
    if (!nv || !loadedRef.current) return;
    const want = settingsRef.current.focus ?? null;
    const have = focusRef.current;
    if (have && want?.file === have.file && nv.volumes.includes(have.vol)) return;
    if (have && nv.volumes.includes(have.vol)) nv.removeVolume(have.vol);
    focusRef.current = null;
    if (want) {
      if (want.kind === 'mask') {
        const [r, g, b] = rgbOf(want.colour);
        nv.addColormap('p360_bundle', { R: [0, r], G: [0, g], B: [0, b], A: [0, 255], I: [0, 255] });
      }
      const vol = await nv.addVolumeFromUrl({
        url: files(want.file),
        name: want.file.split('/').pop() ?? want.file,
        colormap: want.kind === 'prob' ? 'warm' : 'p360_bundle',
        cal_min: want.kind === 'prob' ? 5 : 0.5,
        cal_max: want.kind === 'prob' ? 100 : 1,
        opacity: 0.85,
      });
      if (settingsRef.current.focus?.file !== want.file) {
        nv.removeVolume(vol);
        return;
      }
      focusRef.current = { file: want.file, vol };
      if (want.centreMm) nv.scene.crosshairPos = nv.mm2frac(want.centreMm as unknown as Parameters<typeof nv.mm2frac>[0]);
    }
    apply();
  };

  useEffect(() => {
    const run = () => loadFocus().catch((err) => console.error('Map load failed', err));
    queueRef.current = queueRef.current.then(run, run);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.file]);

  // 4D files: switch frames in place, instantly.
  useEffect(() => {
    const nv = nvRef.current;
    if (frames4d && nv && loadedRef.current?.key === dataKey) showFrame(nv, frameIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameIndex]);

  // Settings that do not need a reload.
  useEffect(() => {
    apply();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, preset, layers, clip, tracts]);

  // Turning the cut on, or changing its direction, swings the camera round to face it.
  useEffect(() => {
    const nv = nvRef.current;
    if (nv && nv.volumes.length) faceCamera(nv, clip, study.defaultCamera);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.on, clip.face]);

  // Auto-rotate.
  useEffect(() => {
    if (!spin) return;
    let raf = 0;
    const tick = () => {
      const nv = nvRef.current;
      if (nv && nv.volumes.length) {
        nv.setRenderAzimuthElevation((nv.scene.renderAzimuth + 0.35) % 360, nv.scene.renderElevation);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [spin]);

  useImperativeHandle(ref, () => ({
    resetView: () => {
      const nv = nvRef.current;
      if (!nv) return;
      nv.scene.volScaleMultiplier = 1;
      nv.scene.pan2Dxyzmm = [0, 0, 0, 1];
      (nv as unknown as { position?: number[] }).position = [0, 0, 0];
      faceCamera(nv, settingsRef.current.clip, study.defaultCamera);
    },
    saveImage: () => {
      void nvRef.current?.saveScene(`${study.id}.png`);
    },
    goToLabel: (layerId: string, label: number) => {
      const nv = nvRef.current;
      const i = indexRef.current[layerId];
      const lab = i === undefined ? undefined : nv?.volumes[i];
      // NVImage.dims is unset after loading in this Niivue version; the header has them.
      const dims = (lab?.dims ?? lab?.hdr?.dims) as number[] | undefined;
      if (!nv || !lab?.img || !dims) return false;
      const c = labelCentre(lab.img as unknown as ArrayLike<number>, dims, label);
      if (!c) return false;
      // c indexes the label map as stored; Niivue's voxel fractions are in its RAS-reordered space, which mirrors
      // stored LPS rows and columns. Going through millimetres (the NIfTI affine) puts the crosshair on the label.
      const A = (lab.hdr as { affine?: number[][] } | undefined)?.affine;
      const mm = A ? [0, 1, 2].map((r) => A[r][0] * c[0] + A[r][1] * c[1] + A[r][2] * c[2] + A[r][3]) : null;
      nv.scene.crosshairPos = mm ? nv.mm2frac(mm as unknown as Parameters<typeof nv.mm2frac>[0]) : nv.vox2frac(c, i);
      nv.updateGLVolume();
      return true;
    },
  }));

  return (
    <div className="volume-canvas relative h-full w-full">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
});
