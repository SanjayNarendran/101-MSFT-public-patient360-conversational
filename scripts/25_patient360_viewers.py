"""Patient 360: viewer files for the record's slide, CT, MRI and X-ray viewers, built from the original public images.

For each patient (the demo patients by default; --patient for others; --all for every online study):

  data/generated/p360/files/viewer/<PAT_ID>/radiology/<key>/  volume.nii.gz, labels.nii.gz (the LIDC radiologists'
                                                              nodule outlines), labels.lut.json, thumbnail.jpg, series.json
  data/generated/p360/files/viewer/<PAT_ID>/xray/<key>/       <n>.png, series.json
  data/generated/p360/files/viewer/<PAT_ID>/slides/<key>/     slide.dzi, slide_files/<level>/<col>_<row>.jpg,
                                                              thumbnail.jpg, slide.json
  data/generated/p360/p360_viewer_asset.parquet               one row per built series: what, where, and its metadata

The DICOM is downloaded from where stage 2 got it (NCI Imaging Data Commons, the Coherent bucket) into a temporary
folder that is deleted after each series. Only pixels and geometry go into the viewer files; the synthetic identities
stay in the archive's headers. Built series are skipped on the next run, so the script can be stopped and run again.

--fabric (stage C2) then copies the viewer files to the Patient360 lakehouse (Files/viewer, with azcopy; files already
there and unchanged are skipped) and writes the index there as the Delta table p360_viewer_asset. --upload-only does
that without building anything.

Run:  .venv/bin/python scripts/25_patient360_viewers.py [--patient Z1002519 ...] [--all] [--jobs 6] [--force] [--fabric]

--jobs builds several series at once (downloads overlap; slide tiles share the cores); --all runs best with 4 to 8.

The series and SEG readers follow build_radiology.py and the slide tiling build_slides.py of the research pipeline
(research/patient360/pipeline).
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import math
import multiprocessing as mp
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd
import pydicom
import requests
import SimpleITK as sitk
from PIL import Image
from scipy import ndimage

from common import DATA, GEN_DIR, ensure_lakehouse, write_tables

P360 = GEN_DIR / "p360"
FILES = P360 / "files"
INDEX = P360 / "p360_viewer_asset.parquet"
LIDC_SEG = DATA / "raw" / "lidc_seg"
IMAGING_RAW = DATA / "raw" / "imaging"
S5CMD = str(Path(sys.executable).with_name("s5cmd"))

CT_SPACING = 1.25
CT_MAX_VOXELS = 30_000_000
MR_MAX_VOXELS = 24_000_000
TILE_SIZE = 1022  # + 2 * overlap = 1024 px tiles
OVERLAP = 1
QUALITY = 82
XRAY_MAX = 2048
NODULE_COLOURS = [(242, 100, 25), (90, 160, 230), (60, 170, 110), (200, 80, 160), (230, 190, 40), (120, 110, 220)]


def key_for(uid: str) -> str:
    return hashlib.sha1(uid.encode()).hexdigest()[:12]


def download(job: dict, folder: Path):
    folder.mkdir(parents=True, exist_ok=True)
    if job["source"] == "s3":
        subprocess.run([S5CMD, "--no-sign-request", "--numworkers", "16", "--retry-count", "10", "cp", job["url"], f"{folder}/"],
                       check=True, capture_output=True)
    else:
        with requests.get(job["url"], stream=True, timeout=600) as resp:
            resp.raise_for_status()
            with open(folder / "source.dcm", "wb") as f:
                for chunk in resp.iter_content(chunk_size=1 << 20):
                    f.write(chunk)


def folder_bytes(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


# ------------------------------------------------------------------ CT and MRI (after build_radiology.py)

def dicom_files(folder: Path) -> list[pydicom.Dataset]:
    return [pydicom.dcmread(f, stop_before_pixels=True) for f in glob.glob(str(folder / "**" / "*.dcm"), recursive=True)]


def pick_phase(headers: list[pydicom.Dataset]) -> list[pydicom.Dataset]:
    """Multi-phase series repeat slice positions; keep the first complete phase."""
    positions = [tuple(round(float(v), 2) for v in h.ImagePositionPatient) for h in headers]
    if len(set(positions)) == len(positions):
        return headers
    seen, first = set(), []
    for h in sorted(headers, key=lambda h: int(h.get("InstanceNumber", 0) or 0)):
        pos = tuple(round(float(v), 2) for v in h.ImagePositionPatient)
        if pos not in seen:
            seen.add(pos)
            first.append(h)
    return first


def read_series(folder: Path) -> tuple[sitk.Image, list[pydicom.Dataset]]:
    headers = [h for h in dicom_files(folder) if "ImagePositionPatient" in h and "ImageOrientationPatient" in h]
    # Keep the stack: the largest group of images sharing one orientation and size (a scout or localiser in the same
    # series would otherwise skew the geometry).
    groups: dict[tuple, list] = defaultdict(list)
    for h in headers:
        groups[(tuple(round(float(v), 3) for v in h.ImageOrientationPatient), int(h.Rows), int(h.Columns))].append(h)
    headers = pick_phase(max(groups.values(), key=len))
    iop = np.array([float(v) for v in headers[0].ImageOrientationPatient])
    normal = np.cross(iop[:3], iop[3:])
    headers.sort(key=lambda h: float(np.dot(normal, [float(v) for v in h.ImagePositionPatient])))
    reader = sitk.ImageSeriesReader()
    reader.SetFileNames([h.filename for h in headers])
    return reader.Execute(), headers


def read_multiframe(path: Path) -> tuple[sitk.Image, list[pydicom.Dataset]]:
    """The Coherent brain MRIs are one multi-frame secondary capture each, 256 frames of 256 x 256, without geometry.
    Frames run along the first axis; 1 mm voxels are assumed."""
    d = pydicom.dcmread(path)
    arr = d.pixel_array.astype(np.float32)
    img = sitk.GetImageFromArray(arr)
    img.SetSpacing((1.0, 1.0, 1.0))
    return img, [d]


def _frame_geometry(d: pydicom.Dataset, fg: pydicom.Dataset, name: str) -> pydicom.Dataset:
    if name in fg:
        return fg[name].value[0]
    return d.SharedFunctionalGroupsSequence[0][name].value[0]


def seg_mask(path: str, reference: sitk.Image) -> np.ndarray:
    """One LIDC reader's outline (a one-segment DICOM SEG) rasterised onto the CT grid through the SEG's own geometry.
    Some LIDC SEGs of CTs stored flipped (orientation -1,0,0,0,-1,0) copy the CT's positions but declare an unflipped
    orientation; their frames are still the CT's own pixel grid, so those frames are placed by slice position and
    their rows and columns used as they are."""
    d = pydicom.dcmread(path)
    frames = d.pixel_array
    if frames.ndim == 2:
        frames = frames[None]
    mask = np.zeros(sitk.GetArrayFromImage(reference).shape, dtype=bool)
    origin = np.array(reference.GetOrigin())
    direction = np.array(reference.GetDirection()).reshape(3, 3)
    to_index = direction.T / np.array(reference.GetSpacing())[:, None]
    for i, fg in enumerate(d.PerFrameFunctionalGroupsSequence):
        rr, cc = np.nonzero(frames[i])
        if not len(rr):
            continue
        pos = np.array([float(v) for v in fg.PlanePositionSequence[0].ImagePositionPatient])
        iop = [float(v) for v in _frame_geometry(d, fg, "PlaneOrientationSequence").ImageOrientationPatient]
        row_spacing, col_spacing = (float(v) for v in _frame_geometry(d, fg, "PixelMeasuresSequence").PixelSpacing)
        agrees = np.dot(iop[:3], direction[:, 0]) > 0.9 and np.dot(iop[3:], direction[:, 1]) > 0.9
        if not agrees and frames[i].shape == mask.shape[1:]:
            z = int(np.rint(np.dot(pos - origin, direction[:, 2]) / reference.GetSpacing()[2]))
            if 0 <= z < mask.shape[0]:
                mask[z, rr, cc] = True
            continue
        points = pos + np.outer(cc * col_spacing, iop[:3]) + np.outer(rr * row_spacing, iop[3:])
        idx = np.rint((points - origin) @ to_index.T).astype(int)
        x, y, z = idx[:, 0], idx[:, 1], idx[:, 2]
        keep = (x >= 0) & (x < mask.shape[2]) & (y >= 0) & (y < mask.shape[1]) & (z >= 0) & (z < mask.shape[0])
        mask[z[keep], y[keep], x[keep]] = True
    return mask


def nodule_labels(study_uid: str, reference: sitk.Image, annotations: pd.DataFrame, nodules: pd.DataFrame):
    """The nodules of one CT as a label map: a voxel belongs to a nodule when at least half of the radiologists who
    outlined that nodule included it. Labels follow the nodule numbers in the PACS (largest first)."""
    ann = annotations[annotations.study_uid == study_uid]
    if ann.empty:
        return None, [], {}
    found = nodules[nodules.study_uid == study_uid].sort_values("diameter_mm", ascending=False)
    shape = sitk.GetArrayFromImage(reference).shape
    labels = np.zeros(shape, dtype=np.uint8)
    names, measures = [], {}
    voxel_ml = float(np.prod(reference.GetSpacing())) / 1000.0
    for i, n in enumerate(found.itertuples(), start=1):
        reads = ann[ann.nodule == n.nodule]
        count = np.zeros(shape, dtype=np.uint8)
        readers = 0
        for seg_uid in reads.seg_series_uid.dropna().unique():
            files = glob.glob(str(LIDC_SEG / n.patient_id / seg_uid / "*.dcm"))
            if not files:
                continue
            count += seg_mask(files[0], reference)
            readers += 1
        if not readers:
            continue
        mask = count >= max(1, math.ceil(readers / 2))
        if not mask.any():
            continue
        labels[mask & (labels == 0)] = i
        name = f"{n.nodule} ({n.diameter_mm:.1f} mm, {n.lobe})"
        names.append(name)
        measures[name] = {"volumeMl": round(float(mask.sum()) * voxel_ml, 2), "components": int(ndimage.label(mask)[1]),
                          "diameterMm": float(n.diameter_mm), "readers": int(n.readers), "outlines": readers, "label": i,
                          "colour": "rgb({},{},{})".format(*NODULE_COLOURS[(len(names) - 1) % len(NODULE_COLOURS)])}
    if not names:
        return None, [], {}
    img = sitk.GetImageFromArray(labels)
    img.CopyInformation(reference)
    return img, names, measures


def lut_for(names: list[str]) -> dict:
    r, g, b, a = [0], [0], [0], [0]
    for i, _ in enumerate(names):
        c = NODULE_COLOURS[i % len(NODULE_COLOURS)]
        r.append(c[0]); g.append(c[1]); b.append(c[2]); a.append(255)
    return {"R": r, "G": g, "B": b, "A": a, "I": list(range(len(names) + 1)), "labels": [""] + names}


def crop_box(mask: np.ndarray, margin: int = 3):
    zz, yy, xx = np.nonzero(mask)
    shape = mask.shape
    lo = [max(0, int(a.min()) - margin) for a in (xx, yy, zz)]
    hi = [min(s, int(a.max()) + 1 + margin) for a, s in zip((xx, yy, zz), (shape[2], shape[1], shape[0]))]
    return lo, [h - l for l, h in zip(lo, hi)]


def body_mask(arr: np.ndarray, threshold: float) -> np.ndarray:
    m = ndimage.binary_opening(arr > threshold, iterations=2)
    lab, k = ndimage.label(m)
    if k == 0:
        return np.ones_like(m)
    return lab == (1 + int(np.argmax(ndimage.sum(m, lab, range(1, k + 1)))))


def thumbnail(arr: np.ndarray, spacing, is_ct: bool, dest: Path):
    sl = arr[:, arr.shape[1] // 2, :].astype(np.float32)
    lo, hi = (-160, 240) if is_ct else (np.percentile(sl, 1), np.percentile(sl, 99.5))
    img = (np.clip((sl - lo) / max(hi - lo, 1), 0, 1) * 255).astype(np.uint8)[::-1]
    pil = Image.fromarray(img).resize((img.shape[1], max(1, int(img.shape[0] * spacing[2] / spacing[0]))))
    pil.thumbnail((360, 360))
    canvas = Image.new("L", (360, 360), 0)
    canvas.paste(pil, ((360 - pil.width) // 2, (360 - pil.height) // 2))
    canvas.convert("RGB").save(dest, quality=88)


def build_volume(series: dict, src: Path, dest: Path, annotations: pd.DataFrame, nodules: pd.DataFrame) -> dict:
    is_ct = series["Modality"] == "CT"
    files = sorted(src.rglob("*.dcm"))
    if len(files) == 1 and not is_ct:
        img, headers = read_multiframe(files[0])
    else:
        img, headers = read_series(src)
    h0 = headers[0]
    seg_img, seg_names, measures = (nodule_labels(series["StudyInstanceUID"], img, annotations, nodules) if is_ct
                                    else (None, [], {}))
    if is_ct:
        extent_mm = np.array(img.GetSize()) * np.array(img.GetSpacing())
        voxels = np.prod(extent_mm / CT_SPACING)
        spacing = [CT_SPACING * max(1.0, (voxels / CT_MAX_VOXELS) ** (1 / 3))] * 3
    else:
        sp = np.array(img.GetSpacing())
        scale = max(1.0, (np.prod(img.GetSize()) / MR_MAX_VOXELS) ** (1 / 3))
        spacing = list(sp * scale)
    size = [int(round(sz * sp / ns)) for sz, sp, ns in zip(img.GetSize(), img.GetSpacing(), spacing)]
    fill = -1024 if is_ct else 0
    out = sitk.Resample(img, size, sitk.Transform(), sitk.sitkLinear, img.GetOrigin(), spacing, img.GetDirection(), fill,
                        sitk.sitkFloat32)
    arr = sitk.GetArrayFromImage(out)
    lo, extent = crop_box(body_mask(arr, -500 if is_ct else np.percentile(arr, 60)))
    out = sitk.RegionOfInterest(out, extent, lo)
    out = sitk.Cast(out if is_ct else sitk.RescaleIntensity(out, 0, 4000), sitk.sitkInt16)
    dest.mkdir(parents=True, exist_ok=True)
    sitk.WriteImage(out, str(dest / "volume.nii.gz"), useCompression=True)
    if seg_img is not None:
        lab = sitk.Resample(seg_img, out, sitk.Transform(), sitk.sitkNearestNeighbor, 0, sitk.sitkUInt8)
        sitk.WriteImage(lab, str(dest / "labels.nii.gz"), useCompression=True)
        (dest / "labels.lut.json").write_text(json.dumps(lut_for(seg_names)))
    thumbnail(sitk.GetArrayFromImage(out), out.GetSpacing(), is_ct, dest / "thumbnail.jpg")
    return {
        "modality": series["Modality"],
        "description": str(h0.get("SeriesDescription", "") or ""),
        "manufacturer": str(h0.get("Manufacturer", "") or ""),
        "sliceThicknessMm": float(h0.get("SliceThickness") or 0) or None,
        "images": len(headers) if len(files) > 1 else int(h0.get("NumberOfFrames", 1) or 1),
        "dims": list(out.GetSize()),
        "spacingMm": [round(s, 3) for s in out.GetSpacing()],
        "volume": "volume.nii.gz",
        "labels": "labels.nii.gz" if seg_img is not None else None,
        "labelsLut": "labels.lut.json" if seg_img is not None else None,
        "thumbnail": "thumbnail.jpg",
        "nodules": measures,
        "geometryAssumed": len(files) == 1 and not is_ct,
    }


# ------------------------------------------------------------------ X-rays

def build_xray(series: dict, src: Path, dest: Path) -> dict:
    from pydicom.pixels import apply_voi_lut  # noqa: PLC0415

    dest.mkdir(parents=True, exist_ok=True)
    images = []
    for i, f in enumerate(sorted(src.rglob("*.dcm")), start=1):
        d = pydicom.dcmread(f)
        if "PixelData" not in d:
            continue
        arr = apply_voi_lut(d.pixel_array, d).astype(np.float32)
        lo, hi = np.percentile(arr, 0.5), np.percentile(arr, 99.5)
        img = np.clip((arr - lo) / max(hi - lo, 1), 0, 1)
        if str(d.get("PhotometricInterpretation", "")) == "MONOCHROME1":
            img = 1 - img
        pil = Image.fromarray((img * 255).astype(np.uint8))
        pil.thumbnail((XRAY_MAX, XRAY_MAX))
        name = f"{i}.png"
        pil.save(dest / name, optimize=True)
        images.append({"file": name, "width": pil.width, "height": pil.height,
                       "view": str(d.get("ViewPosition", "") or d.get("SeriesDescription", "") or "")})
    return {"modality": series["Modality"], "images": images}


# ------------------------------------------------------------------ slides (after build_slides.py)

_dz = None


def _init(path: str):
    global _dz
    import openslide  # noqa: PLC0415
    from openslide.deepzoom import DeepZoomGenerator  # noqa: PLC0415

    _dz = DeepZoomGenerator(openslide.OpenSlide(path), TILE_SIZE, OVERLAP, limit_bounds=True)


def _tile(job):
    level, col, row, out = job
    if os.path.exists(out):
        return
    _dz.get_tile(level, (col, row)).convert("RGB").save(out, "JPEG", quality=QUALITY, optimize=True, progressive=True)


def whiten(image: Image.Image) -> Image.Image:
    rgb = np.asarray(image, dtype=np.float32) / 255.0
    mx, mn = rgb.max(axis=2), rgb.min(axis=2)
    sat = (mx - mn) / np.maximum(mx, 1e-6)
    glass = (sat < 0.08) & (mx > 0.7)
    white = np.median(rgb[glass], axis=0) if glass.any() else np.ones(3)
    return Image.fromarray((np.clip(rgb / np.maximum(white, 1e-3), 0, 1) * 255).astype(np.uint8))


JPEG_BASELINE = "1.2.840.10008.1.2.4.50"


def transcode_to_jpeg(src: Path):
    """Rewrites the instances of a whole-slide image whose frames OpenSlide can't decode (JPEG 2000, as in many
    TCGA slides) as baseline JPEG, frame by frame, in place. The pyramid, tiling and geometry are unchanged."""
    from io import BytesIO  # noqa: PLC0415

    from pydicom.encaps import encapsulate  # noqa: PLC0415
    from pydicom.uid import JPEGBaseline8Bit  # noqa: PLC0415

    for f in sorted(src.rglob("*.dcm")):
        ds = pydicom.dcmread(f)
        if "PixelData" not in ds or str(ds.file_meta.TransferSyntaxUID) == JPEG_BASELINE:
            continue
        frames = []
        for arr in pydicom.pixels.iter_pixels(f):  # one decoded frame at a time, in RGB
            buf = BytesIO()
            Image.fromarray(arr).convert("RGB").save(buf, "JPEG", quality=90)
            frames.append(buf.getvalue())
        ds.PixelData = encapsulate(frames)
        ds["PixelData"].is_undefined_length = True
        ds["PixelData"].VR = "OB"
        ds.file_meta.TransferSyntaxUID = JPEGBaseline8Bit
        ds.PhotometricInterpretation = "YBR_FULL_422"
        ds.LossyImageCompression = "01"
        ds.save_as(f, enforce_file_format=True)


def build_slide(series: dict, src: Path, dest: Path, workers: int) -> dict:
    import openslide  # noqa: PLC0415
    from openslide.deepzoom import DeepZoomGenerator  # noqa: PLC0415

    files = sorted(src.rglob("*.dcm"))
    try:
        openslide.OpenSlide(str(files[0])).read_region((0, 0), 0, (8, 8))
    except openslide.OpenSlideError:
        transcode_to_jpeg(src)
    # OpenSlide reads a DICOM whole-slide image from any one of its instances when the others sit beside it; pick a
    # pyramid level rather than the label or overview image.
    path = next((str(f) for f in files if "VOLUME" in str(pydicom.dcmread(f, stop_before_pixels=True).get("ImageType", ""))),
                str(files[0]))
    osr = openslide.OpenSlide(path)
    dz = DeepZoomGenerator(osr, TILE_SIZE, OVERLAP, limit_bounds=True)
    dest.mkdir(parents=True, exist_ok=True)
    jobs = []
    for level in range(dz.level_count):
        cols, rows = dz.level_tiles[level]
        (dest / "slide_files" / str(level)).mkdir(parents=True, exist_ok=True)
        jobs += [(level, c, r, str(dest / "slide_files" / str(level) / f"{c}_{r}.jpg")) for c in range(cols) for r in range(rows)]
    with mp.get_context("spawn").Pool(workers, initializer=_init, initargs=(path,)) as pool:
        for _ in pool.imap_unordered(_tile, jobs, chunksize=16):
            pass
    (dest / "slide.dzi").write_text(dz.get_dzi("jpg"))
    thumb = whiten(osr.get_thumbnail((720, 720)).convert("RGB"))
    thumb.save(dest / "thumbnail.jpg", "JPEG", quality=88)
    w, h = dz.level_dimensions[-1]
    props = osr.properties
    mpp = props.get(openslide.PROPERTY_NAME_MPP_X)
    return {
        "modality": "SM",
        "width": w,
        "height": h,
        "levels": dz.level_count,
        "tileCount": len(jobs),
        "tileSize": TILE_SIZE,
        "overlap": OVERLAP,
        "mpp": float(mpp) if mpp else None,
        "objectivePower": float(props.get(openslide.PROPERTY_NAME_OBJECTIVE_POWER) or 0) or None,
        "dzi": "slide.dzi",
        "thumbnail": "thumbnail.jpg",
        "rawBytes": sum(f.stat().st_size for f in files),
    }


# ------------------------------------------------------------------ which series

def online_series(patients: list[str]) -> pd.DataFrame:
    """Every online series of the patients, with the job that says where its DICOM came from."""
    pacs = P360 / "bronze" / "pacs"
    pt = pd.read_parquet(P360 / "p360_patient.parquet", columns=["patient_id", "mrn", "lidc_subject"])
    pt = pt[pt.patient_id.isin(patients)]
    pp = pd.read_parquet(pacs / "Patient.parquet", columns=["PatientKey", "PatientID"])
    st = pd.read_parquet(pacs / "Study.parquet", columns=["StudyKey", "StudyInstanceUID", "PatientKey", "InstanceAvailability"])
    se = pd.read_parquet(pacs / "Series.parquet", columns=["SeriesKey", "SeriesInstanceUID", "StudyKey", "Modality"])
    jobs = pd.read_csv(GEN_DIR / "pacs" / "jobs.csv", dtype=str)
    df = (pt.merge(pp, left_on="mrn", right_on="PatientID").merge(st[st.InstanceAvailability == "ONLINE"], on="PatientKey")
          .merge(se, on="StudyKey"))
    df = df[df.Modality.isin(["CT", "MR", "DX", "CR", "SM"])]
    by_series = jobs.dropna(subset=["SourceSeriesUID"]).drop_duplicates("SourceSeriesUID").set_index("SourceSeriesUID")
    by_study = jobs[jobs.Modality == "MR"].drop_duplicates("StudyInstanceUID").set_index("StudyInstanceUID")
    rows = []
    for r in df.itertuples():
        job = by_series.loc[r.SeriesInstanceUID] if r.SeriesInstanceUID in by_series.index else (
            by_study.loc[r.StudyInstanceUID] if r.Modality == "MR" and r.StudyInstanceUID in by_study.index else None)
        if job is None:
            continue
        rows.append({"patient_id": r.patient_id, "lidc_subject": r.lidc_subject, "SeriesInstanceUID": r.SeriesInstanceUID,
                     "StudyInstanceUID": r.StudyInstanceUID, "Modality": r.Modality, "source": job["source"], "url": job["url"]})
    return pd.DataFrame(rows)


def upload_fabric() -> None:
    """Copies the viewer files to Patient360/Files/viewer and writes the viewer index as a Delta table there."""
    if not INDEX.exists():
        raise SystemExit("Nothing built yet: no p360_viewer_asset.parquet.")
    ws_id, lh_id = ensure_lakehouse("Patient360", "Patient 360: the patient index, demo patients and viewer files")
    dest = f"https://onelake.blob.fabric.microsoft.com/{ws_id}/{lh_id}/Files/viewer"
    print(f"Copying {FILES / 'viewer'} to Patient360/Files/viewer")
    t0 = time.time()
    env = {**os.environ, "AZCOPY_AUTO_LOGIN_TYPE": "AZCLI"}
    subprocess.run(["azcopy", "copy", f"{FILES / 'viewer'}/*", f"{dest}/", "--recursive", "--overwrite=ifSourceNewer",
                    "--trusted-microsoft-suffixes=onelake.blob.fabric.microsoft.com", "--log-level=ERROR",
                    "--output-level=essential"], env=env, check=True)
    print(f"  copied in {time.time() - t0:.0f} s")
    write_tables(ws_id, lh_id, {"p360_viewer_asset": pd.read_parquet(INDEX)})


def kind_of(modality: str) -> str:
    return {"CT": "radiology", "MR": "radiology", "DX": "xray", "CR": "xray", "SM": "slides"}[modality]


def folder_of(s: dict) -> str:
    return f"viewer/{s['patient_id']}/{kind_of(s['Modality'])}/{key_for(s['SeriesInstanceUID'])}"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--patient", nargs="*", help="patient IDs (default: the demo patients)")
    ap.add_argument("--all", action="store_true", help="every patient with an online study")
    ap.add_argument("--workers", type=int, default=0, help="processes for one slide's tiles (default: the cores, shared by the jobs)")
    ap.add_argument("--jobs", type=int, default=1, help="series built at once; downloads overlap (e.g. 4 for --all)")
    ap.add_argument("--force", action="store_true", help="rebuild series that are already built")
    ap.add_argument("--only", choices=["radiology", "xray", "slides"], help="build one kind only")
    ap.add_argument("--fabric", action="store_true", help="then copy the files and index to the Patient360 lakehouse")
    ap.add_argument("--upload-only", action="store_true", help="copy what is built to Fabric, building nothing")
    args = ap.parse_args()
    if args.upload_only:
        upload_fabric()
        return

    index = pd.read_parquet(P360 / "p360_patient.parquet", columns=["patient_id", "demo_order", "studies_online"])
    if args.all:
        patients = index[index.studies_online > 0].patient_id.tolist()
    elif args.patient:
        patients = args.patient
    else:
        patients = index[index.demo_order.notna()].sort_values("demo_order").patient_id.tolist()
    series = online_series(patients)
    if args.only:
        series = series[series.Modality.map(kind_of) == args.only]
    annotations = pd.read_csv(IMAGING_RAW / "lidc_annotations.csv", dtype={"seg_series_uid": str})
    nodules = pd.read_csv(IMAGING_RAW / "lidc_nodules.csv")
    print(f"{len(patients)} patients, {len(series)} online series")

    done = pd.read_parquet(INDEX) if INDEX.exists() else pd.DataFrame()
    rows = done.to_dict("records") if len(done) else []
    have = {r["series_uid"] for r in rows}
    todo = [s for s in series.to_dict("records")
            if args.force or s["SeriesInstanceUID"] not in have or not (FILES / folder_of(s)).exists()]
    jobs = max(1, args.jobs)
    tile_workers = args.workers or max(2, ((os.cpu_count() or 4) - 2) // jobs)
    if len(todo) < len(series):
        print(f"  {len(series) - len(todo)} built already; {len(todo)} to build, {jobs} at a time")
    lock = threading.Lock()

    def build(s: dict) -> None:
        uid = s["SeriesInstanceUID"]
        kind = kind_of(s["Modality"])
        folder = folder_of(s)
        dest = FILES / folder
        t0 = time.time()
        tmp = Path(tempfile.mkdtemp(prefix="p360-"))
        try:
            download(s, tmp)
            if kind == "radiology":
                meta = build_volume(s, tmp, dest, annotations, nodules)
            elif kind == "xray":
                meta = build_xray(s, tmp, dest)
            else:
                meta = build_slide(s, tmp, dest, tile_workers)
        except Exception as e:  # noqa: BLE001  (one bad series shouldn't stop the rest)
            print(f"  {s['patient_id']} {s['Modality']} {uid}: FAILED {type(e).__name__}: {e}", flush=True)
            shutil.rmtree(dest, ignore_errors=True)
            return
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        (dest / "series.json").write_text(json.dumps(meta, indent=1))
        row = {"patient_id": s["patient_id"], "series_uid": uid, "study_uid": s["StudyInstanceUID"], "modality": s["Modality"],
               "kind": kind, "folder": folder, "meta_json": json.dumps(meta), "bytes": folder_bytes(dest),
               "built_at": pd.Timestamp.now(tz="UTC").floor("s").tz_localize(None)}
        extra = f", {len(meta.get('nodules') or {})} nodules" if kind == "radiology" and s["Modality"] == "CT" else ""
        with lock:  # one writer for the index
            rows[:] = [r for r in rows if r["series_uid"] != uid] + [row]
            pd.DataFrame(rows).to_parquet(INDEX, index=False)
            print(f"  {s['patient_id']} {s['Modality']:<2} {key_for(uid)}  {row['bytes'] / 1e6:7.1f} MB  "
                  f"{time.time() - t0:5.0f} s{extra}", flush=True)

    # Threads: the work is downloads, numpy and the slide tiler's own process pool, so one process can run several.
    with ThreadPoolExecutor(jobs) as pool:
        list(pool.map(build, todo))
    total = pd.read_parquet(INDEX) if INDEX.exists() else pd.DataFrame()
    print(f"Index: {len(total)} series, {total.bytes.sum() / 1e9 if len(total) else 0:.1f} GB in {FILES / 'viewer'}")
    if args.fabric:
        upload_fabric()


if __name__ == "__main__":
    main()
