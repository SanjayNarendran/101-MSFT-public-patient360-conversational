"""Patient 360: the imaging-demo studies on Stephan Rutherford and Ivelisse Nitzsche at full size (plan I).

The imaging pipeline (research/imaging) reduced its volumes for the browser (the PET/CT's CT and the 4D CT at 2 mm) and kept only the parts it
showed (the 4D-Lung patient's planning 4D CT, the fetal atlas's T2 and tissue labels). This script downloads each
subject in full from its publisher and builds viewer files from the originals:

  download   data/raw/idc/4d_lung/100_HM10395/       every series of the 4D-Lung patient (NCI Imaging Data Commons,
                                                     CC BY 3.0): the planning 4D CT with RT structures and 26
                                                     treatment-day 4D scans, 9.3 GB
             data/raw/idc/fdg_pet_ct_lesions/PETCT_5e2da717db/   the PET/CT study with its lesion masks, 0.3 GB
                                                     (both as <collection>/<patient>/<study>/<modality>_<series>/)
             data/raw/dhcp_fetal_atlas/              the dHCP fetal brain MRI atlas from G-Node GIN (CC0): T1, T2,
                                                     diffusion, tissue labels, centiles, registration warps, 20 GB

  build      viewer files from the originals, in each study's folder under data/generated/p360/files/viewer:
             petct-whole-body   the CT on its native 0.86 x 0.86 x 3 mm grid (was 2 mm); the PET was already native
             lung-4dct          the planning 4D CT and its RT contours on the native 0.98 x 0.98 x 3 mm grid (was 2 mm)
             lung-4dcbct        a new study: the 33 cone-beam CTs taken on the treatment couch over 46 days, each the
                                average of its ten breathing phases, aligned to the first; one frame per scan
             fetal-brain-atlas  T1, FA, MD, RD and b = 1000 diffusion images on every week, beside the T2 and tissue
                                labels (the fibre orientation maps and registration warps stay with the downloads)
             Each changed study gets fullsize.json (merged over the imaging pipeline's metadata by 30 and here), the new one
             its own study.json; p360_showcase is updated.
  --fabric   the downloads to Patient360/Files/raw, the study folders, and the showcase tables

  tables     p360_showcase again from the built studies (build ends with it)

Run:  .venv/bin/python scripts/32_patient360_fullsize.py download
      .venv/bin/python scripts/32_patient360_fullsize.py build
      .venv/bin/python scripts/32_patient360_fullsize.py --fabric
"""
from __future__ import annotations

import argparse
import datetime as dt
import glob
import importlib
import json
import re
import shutil
import struct
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import nibabel as nib
import numpy as np
import pandas as pd
import pydicom
import requests
import SimpleITK as sitk
from PIL import Image, ImageDraw
from scipy import ndimage

from common import DATA, GEN_DIR

RAW = DATA / "raw"
IDC = RAW / "idc"
GIN = "https://gin.g-node.org/kcl_cdb/fetal_brain_mri_atlas"
FETAL = RAW / "dhcp_fetal_atlas"
FETAL_FOLDERS = ["structural", "parcellations", "diffusion", "cnn_cortex_probability", "composite_warps",
                 "composite_warps_fetal2neonatal", "transformations", "info"]
# collection, patient
IDC_SUBJECTS = [("4d_lung", "100_HM10395"), ("fdg_pet_ct_lesions", "PETCT_5e2da717db")]
LUNG = IDC / "4d_lung" / "100_HM10395"
PETCT = IDC / "fdg_pet_ct_lesions" / "PETCT_5e2da717db"
VIEWER = GEN_DIR / "p360" / "files" / "viewer"
STUDY = {
    "petct-whole-body": VIEWER / "Z1002519" / "showcase" / "petct-whole-body",
    "lung-4dct": VIEWER / "Z1002519" / "showcase" / "lung-4dct",
    "lung-4dcbct": VIEWER / "Z1002519" / "showcase" / "lung-4dcbct",
    "fetal-brain-atlas": VIEWER / "Z1003499" / "showcase" / "fetal-brain-atlas",
}
# The study this script adds to the record: id, kind, patient, date, tab, why it sits there (as in 30's SHOWCASE).
COURSE_START = dt.date(2018, 3, 18)  # Stephan Rutherford's chemoradiation began the day after his planning CT
NEW_STUDIES = [
    ("lung-4dcbct", "volume", "Z1002519", COURSE_START.isoformat(), "radiology",
     "Cone-beam CTs taken on the treatment couch before his radiotherapy sessions, 33 scans over the first 46 days of "
     "his chemoradiation, from the same patient as his planning 4D CT. Each is the average of its ten breathing "
     "phases, aligned to the first day."),
]
LUNG_LICENSE = "CC BY 3.0"
LUNG_SOURCE = "The Cancer Imaging Archive, 4D-Lung (Hugo et al.), via NCI Imaging Data Commons"
LUNG_URL = "https://www.cancerimagingarchive.net/collection/4d-lung/"
LUNG_CITATION = ("Hugo GD, Weiss E, Sleeman WC, et al. Data from 4D Lung Imaging of NSCLC Patients. The Cancer Imaging "
                 "Archive, 2016. https://doi.org/10.7937/K9/TCIA.2016.ELN8YGLE")


def download_idc() -> None:
    from idc_index import IDCClient  # noqa: PLC0415

    client = IDCClient()
    for collection, patient in IDC_SUBJECTS:
        size = client.sql_query(f"SELECT ROUND(SUM(series_size_MB) / 1024, 2) AS gb, COUNT(*) AS n FROM index "
                                f"WHERE collection_id = '{collection}' AND PatientID = '{patient}'").iloc[0]
        print(f"  {collection}/{patient}: {int(size.n)} series, {size.gb} GB")
        client.download_from_selection(downloadDir=str(IDC), collection_id=collection, patientId=patient,
                                       dirTemplate="%collection_id/%PatientID/%StudyInstanceUID/%Modality_%SeriesInstanceUID",
                                       use_s5cmd_sync=True, show_progress_bar=False)


def gin_listing(path: str) -> list[str]:
    """The files under one folder of the GIN repository (its web pages list them; subfolders are followed)."""
    html = requests.get(f"{GIN}/src/master/{path}", timeout=120).text
    out = []
    for item in sorted(set(re.findall(rf'href="/kcl_cdb/fetal_brain_mri_atlas/src/master/({re.escape(path)}/[^"]+)"', html))):
        if re.search(r"\.[A-Za-z0-9]+$", item.split("/")[-1]):
            out.append(item)
        else:
            out += gin_listing(item)
    return out


def gin_file(path: str) -> int:
    """One file of the repository: large files are served under /media/ (git-annex), small ones under /raw/."""
    dst = FETAL / path
    for kind in ("media", "raw"):
        url = f"{GIN}/{kind}/master/{path}"
        head = requests.head(url, allow_redirects=True, timeout=120)
        if head.ok and "text/html" not in head.headers.get("content-type", ""):
            break
    else:
        raise SystemExit(f"GIN has no file {path}")
    size = int(head.headers.get("content-length") or 0)
    if dst.exists() and size and dst.stat().st_size == size:
        return 0
    dst.parent.mkdir(parents=True, exist_ok=True)
    part = dst.with_name(dst.name + ".part")
    with requests.get(url, stream=True, timeout=600) as r:
        r.raise_for_status()
        if "text/html" in r.headers.get("content-type", ""):
            raise SystemExit(f"GIN served a page, not a file, for {path}")
        with open(part, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    part.rename(dst)
    return dst.stat().st_size


def download_fetal() -> None:
    files = ["README.md", "LICENSE", "datacite.yml"] + [f for d in FETAL_FOLDERS for f in gin_listing(d)]
    print(f"  dHCP fetal atlas: {len(files)} files")
    with ThreadPoolExecutor(8) as pool:
        got = sum(pool.map(gin_file, files))
    total = sum(f.stat().st_size for f in FETAL.rglob("*") if f.is_file())
    print(f"  dHCP fetal atlas: {got / 1e9:.2f} GB downloaded now, {total / 1e9:.2f} GB in {FETAL}")


# ---- DICOM ----

def read_series(folder: Path, scale=None) -> tuple[sitk.Image, list]:
    """A DICOM series as a SimpleITK image (LPS), sorted along the slice normal."""
    ds = [pydicom.dcmread(f) for f in glob.glob(str(folder / "*.dcm"))]
    iop = [float(v) for v in ds[0].ImageOrientationPatient]
    row, col = np.array(iop[:3]), np.array(iop[3:])
    normal = np.cross(row, col)
    ds.sort(key=lambda d: float(np.dot(normal, [float(v) for v in d.ImagePositionPatient])))
    pos = [np.array([float(v) for v in d.ImagePositionPatient]) for d in ds]
    dz = float(np.median(np.diff([np.dot(normal, p) for p in pos]))) if len(pos) > 1 else 1.0
    ps = [float(v) for v in ds[0].PixelSpacing]
    vol = np.stack([d.pixel_array.astype(np.float32) * float(getattr(d, "RescaleSlope", 1)) + float(getattr(d, "RescaleIntercept", 0))
                    for d in ds])
    if scale:
        vol *= scale(ds[0])
    img = sitk.GetImageFromArray(vol)
    img.SetOrigin(list(pos[0]))
    img.SetSpacing([ps[1], ps[0], dz])
    img.SetDirection([row[0], col[0], normal[0], row[1], col[1], normal[1], row[2], col[2], normal[2]])
    return img, ds


def largest(mask: np.ndarray) -> np.ndarray:
    lab, n = ndimage.label(mask)
    return lab == (1 + int(np.argmax(ndimage.sum(mask, lab, range(1, n + 1))))) if n else mask


def body_mask(ct: np.ndarray) -> np.ndarray:
    """The patient (z, y, x): the largest soft-tissue component, holes filled slice by slice (drops the couch)."""
    body = largest(ndimage.binary_opening(ct > -400, iterations=1))
    body = np.stack([ndimage.binary_fill_holes(z) for z in body])
    return ndimage.binary_dilation(body, iterations=1)


def crop_box(mask: np.ndarray, margin: int = 3) -> tuple[slice, ...]:
    idx = np.nonzero(mask)
    return tuple(slice(max(0, int(a.min()) - margin), min(n, int(a.max()) + 1 + margin)) for a, n in zip(idx, mask.shape))


def nifti_lps(arr_zyx: np.ndarray, origin_lps, spacing_xyz, dtype) -> nib.Nifti1Image:
    """(z, y, x) or (t, z, y, x) on an axial LPS grid -> NIfTI (x, y, z[, t]) with a RAS affine."""
    affine = np.diag([-spacing_xyz[0], -spacing_xyz[1], spacing_xyz[2], 1.0])
    affine[:3, 3] = [-origin_lps[0], -origin_lps[1], origin_lps[2]]
    axes = (3, 2, 1, 0) if arr_zyx.ndim == 4 else (2, 1, 0)
    return nib.Nifti1Image(np.ascontiguousarray(arr_zyx.transpose(axes)).astype(dtype), affine)


def series_folders(study: Path, modality: str) -> list[Path]:
    return sorted(Path(p) for p in glob.glob(str(study / f"{modality}_*")))


def thumbnail(slice_hu: np.ndarray, dest: Path, window=(-1000, 400)):
    img = (np.clip((slice_hu - window[0]) / (window[1] - window[0]), 0, 1) * 255).astype(np.uint8)
    pil = Image.fromarray(img)
    pil.thumbnail((512, 512))
    canvas = Image.new("RGB", (512, 512), (255, 255, 255))
    canvas.paste(pil.convert("RGB"), ((512 - pil.width) // 2, (512 - pil.height) // 2))
    canvas.save(dest, quality=90)


def folder_bytes(folder: Path) -> int:
    return sum(f.stat().st_size for f in folder.rglob("*") if f.is_file())


def study_meta(sid: str) -> dict:
    """The imaging pipeline's metadata in the study's folder, with paths made relative to that folder (as 30 does)."""
    def rel(v):
        if isinstance(v, dict):
            return {k: rel(x) for k, x in v.items()}
        if isinstance(v, list):
            return [rel(x) for x in v]
        return v[len(sid) + 1:] if isinstance(v, str) and v.startswith(f"{sid}/") else v
    return rel(json.loads((STUDY[sid] / "study.json").read_text()))


# ---- PET/CT ----

def build_petct() -> dict:
    out = STUDY["petct-whole-body"]
    study = next(p for p in PETCT.iterdir() if p.is_dir())
    ct, _ = read_series(series_folders(study, "CT")[0])
    arr = sitk.GetArrayFromImage(ct)
    body = largest(ndimage.binary_opening(arr > -500, iterations=2))
    box = crop_box(body, 4)
    sub = sitk.RegionOfInterest(ct, [b.stop - b.start for b in box[::-1]], [b.start for b in box[::-1]])
    sitk.WriteImage(sitk.Cast(sub, sitk.sitkInt16), str(out / "ct-full.nii.gz"), useCompression=True)
    meta = study_meta("petct-whole-body")
    full = out / "ct-full.nii.gz"
    layers = [dict(l, file=full.name, bytes=full.stat().st_size) if l["id"] == "ct" else l for l in meta["layers"]]
    spacing = [round(v, 3) for v in sub.GetSpacing()]
    raw = [f for f in study.rglob("*.dcm")]
    print(f"  PET/CT: CT {list(sub.GetSize())} at {spacing} mm, {full.stat().st_size / 1e6:.0f} MB")
    return {"fullSize": {"layers": layers, "dims": list(sub.GetSize()), "spacingMm": spacing,
                         "sizeBytes": sum(int(l.get("bytes") or 0) for l in layers)},
            "rawPath": "raw/idc/fdg_pet_ct_lesions/PETCT_5e2da717db/", "rawFiles": len(raw),
            "rawSizeBytes": sum(f.stat().st_size for f in raw)}


# ---- The planning 4D CT ----

LUNG_STRUCTURES = [  # label, ROI name prefix (as in the imaging pipeline's build_lung4d.py)
    (1, "RLung"), (2, "LLung"), (3, "Trachea"), (4, "Esophagus"), (5, "Heart"), (6, "Vertebra"), (7, "Cord"), (8, "LN"),
    (9, "Tumor"),
]


def phase_of(desc: str) -> float:
    return float(re.search(r"([\d.]+)%", desc).group(1))


def rasterise(rt_path: Path, ds: list) -> np.ndarray:
    """RTSTRUCT polygons -> labels on the CT's slice grid (z, y, x)."""
    rt = pydicom.dcmread(rt_path)
    names = {r.ROINumber: r.ROIName for r in rt.StructureSetROISequence}
    zs = np.array([float(d.ImagePositionPatient[2]) for d in ds])
    x0, y0 = float(ds[0].ImagePositionPatient[0]), float(ds[0].ImagePositionPatient[1])
    sy, sx = (float(v) for v in ds[0].PixelSpacing)
    rows, cols = ds[0].Rows, ds[0].Columns
    labels = np.zeros((len(ds), rows, cols), np.uint8)
    by_name = {names.get(rc.ReferencedROINumber, ""): rc for rc in rt.ROIContourSequence}
    for lid, prefix in LUNG_STRUCTURES:
        rc = next((v for k, v in by_name.items() if k.lower().startswith(prefix.lower() + "_")), None)
        if rc is None or "ContourSequence" not in rc:
            continue
        per_slice: dict[int, list] = {}
        for c in rc.ContourSequence:
            pts = np.array(c.ContourData, np.float64).reshape(-1, 3)
            k = int(np.argmin(np.abs(zs - pts[0, 2])))
            per_slice.setdefault(k, []).append([((x - x0) / sx, (y - y0) / sy) for x, y, _ in pts])
        for k, polys in per_slice.items():
            canvas = Image.new("L", (cols, rows), 0)
            draw = ImageDraw.Draw(canvas)
            for poly in polys:
                if len(poly) >= 3:
                    draw.polygon(poly, outline=1, fill=1)
            labels[k][np.asarray(canvas) > 0] = lid
    return labels


def build_lung_planning() -> dict:
    out = STUDY["lung-4dct"]
    study = max((p for p in LUNG.iterdir() if p.is_dir()), key=lambda p: len(series_folders(p, "RTSTRUCT")))
    cts = sorted(series_folders(study, "CT"),
                 key=lambda f: phase_of(pydicom.dcmread(next(f.glob("*.dcm")), stop_before_pixels=True).SeriesDescription))
    rts = {phase_of(pydicom.dcmread(f, stop_before_pixels=True).SeriesDescription): f
           for f in (next(p.glob("*.dcm")) for p in series_folders(study, "RTSTRUCT"))}
    frames, labels, phases, ref = [], [], [], None
    for folder in cts:
        img, ds = read_series(folder)
        ph = phase_of(ds[0].SeriesDescription)
        lab = rasterise(rts[ph], ds)
        if ref is None:
            ref = img
        elif img.GetSize() != ref.GetSize() or not np.allclose(img.GetOrigin(), ref.GetOrigin()):
            li = sitk.GetImageFromArray(lab)
            li.CopyInformation(img)
            img = sitk.Resample(img, ref, sitk.Transform(), sitk.sitkLinear, -1024)
            lab = sitk.GetArrayFromImage(sitk.Resample(li, ref, sitk.Transform(), sitk.sitkNearestNeighbor, 0))
        frames.append(sitk.GetArrayFromImage(img))
        labels.append(lab)
        phases.append(ph)
    ct4, lb4 = np.stack(frames), np.stack(labels)
    sx, sy, sz = ref.GetSpacing()
    # The chest: the patient, from 6 cm above to 6 cm below the contoured lungs, airway, heart and tumour.
    body = ndimage.binary_opening(ct4.max(axis=0) > -500, iterations=2)
    box = list(crop_box(body, 3))
    lz = np.nonzero(np.isin(lb4.max(axis=0), [1, 2, 3, 5, 9]).any(axis=(1, 2)))[0]
    pad = int(round(60 / sz))
    box[0] = slice(max(box[0].start, lz.min() - pad), min(box[0].stop, lz.max() + 1 + pad))
    box = tuple(box)
    ct4, lb4 = ct4[(slice(None),) + box], lb4[(slice(None),) + box]
    for t in range(len(ct4)):
        ct4[t][~body_mask(ct4[t])] = -1024
    origin = np.array(ref.GetOrigin()) + np.array([box[2].start * sx, box[1].start * sy, box[0].start * sz])
    ct_nii = nifti_lps(ct4, origin, (sx, sy, sz), np.int16)
    ct_nii.header.set_xyzt_units("mm", "sec")
    nib.save(ct_nii, out / "ct4d-full.nii.gz")
    lab_nii = nifti_lps(np.where(np.isin(lb4, [1, 2]), 0, lb4), origin, (sx, sy, sz), np.uint8)
    lab_nii.header.set_intent("label")
    nib.save(lab_nii, out / "anatomy4d-full.nii.gz")

    voxel_ml = sx * sy * sz / 1000
    lung_ml = [float(np.isin(f, [1, 2]).sum() * voxel_ml) for f in lb4]
    centres = [np.array(ndimage.center_of_mass(f == 9)) * [sz, sy, sx] for f in lb4 if (f == 9).any()]
    motion = float(np.ptp(np.stack(centres), axis=0).max()) if len(centres) > 1 else 0.0
    tidal = max(lung_ml) - min(lung_ml)
    meta = study_meta("lung-4dct")
    frames_meta = [dict(f, note=f"lungs {lung_ml[i]:,.0f} ml") for i, f in enumerate(meta["timeline"]["frames"])]
    files = {"ct": out / "ct4d-full.nii.gz", "anatomy": out / "anatomy4d-full.nii.gz"}
    layers = [dict(l, file=files[l["id"]].name, bytes=files[l["id"]].stat().st_size) for l in meta["layers"]]
    raw = [f for f in study.rglob("*.dcm")]
    print(f"  4D CT: {list(ct_nii.shape)} at {[round(v, 3) for v in (sx, sy, sz)]} mm; lungs change {tidal:,.0f} ml, "
          f"tumour moves {motion:.1f} mm; {files['ct'].stat().st_size / 1e6:.0f} MB")
    # The measures come from the native grid, whichever size the viewer opens.
    return {"fullSize": {"layers": layers, "dims": list(ct_nii.shape[:3]), "spacingMm": [round(v, 3) for v in (sx, sy, sz)],
                         "sizeBytes": sum(f.stat().st_size for f in files.values())},
            "stats": {"phases": len(phases), "lungVolumeChangeMl": round(tidal), "tumourMotionMm": round(motion, 1)},
            "subtitle": f"Ten respiratory phases, lungs change by {tidal:,.0f} ml",
            "timeline": dict(meta["timeline"], frames=frames_meta),
            "rawPath": "raw/idc/4d_lung/100_HM10395/", "rawFiles": len(raw), "rawSizeBytes": sum(f.stat().st_size for f in raw)}


# ---- The treatment-day cone-beam CTs ----

def register(fixed: sitk.Image, moving: sitk.Image) -> sitk.Transform:
    """Rigid alignment of one day's scan to the first (mutual information, three resolutions)."""
    reg = sitk.ImageRegistrationMethod()
    reg.SetMetricAsMattesMutualInformation(50)
    reg.SetMetricSamplingStrategy(reg.RANDOM)
    reg.SetMetricSamplingPercentage(0.1, seed=7)
    reg.SetInterpolator(sitk.sitkLinear)
    reg.SetOptimizerAsRegularStepGradientDescent(2.0, 1e-3, 200, relaxationFactor=0.6)
    reg.SetOptimizerScalesFromPhysicalShift()
    reg.SetShrinkFactorsPerLevel([4, 2, 1])
    reg.SetSmoothingSigmasPerLevel([2, 1, 0])
    init = sitk.CenteredTransformInitializer(fixed, moving, sitk.Euler3DTransform(), sitk.CenteredTransformInitializerFilter.GEOMETRY)
    reg.SetInitialTransform(init, inPlace=False)
    return reg.Execute(sitk.Cast(fixed, sitk.sitkFloat32), sitk.Cast(moving, sitk.sitkFloat32))


def build_course() -> tuple[dict, list]:
    out = STUDY["lung-4dcbct"]
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    scans = []
    for study in (p for p in LUNG.iterdir() if p.is_dir()):
        if series_folders(study, "RTSTRUCT"):
            continue  # the planning 4D CT
        folders = series_folders(study, "CT")
        d = pydicom.dcmread(next(folders[0].glob("*.dcm")), stop_before_pixels=True)
        scans.append((str(d.StudyDate), str(getattr(d, "StudyTime", "0")), study, folders, d))
    scans.sort(key=lambda x: (x[0], x[1]))
    first_day = dt.datetime.strptime(scans[0][0], "%Y%m%d").date()
    ref, box, frames, raw_files, raw_bytes = None, None, [], 0, 0
    for n, (date, _, study, folders, d0) in enumerate(scans, start=1):
        phases = [read_series(f)[0] for f in folders]
        mean = sitk.GetArrayFromImage(phases[0]) * 0
        for ph in phases:
            mean += sitk.GetArrayFromImage(sitk.Resample(ph, phases[0], sitk.Transform(), sitk.sitkLinear, -1000))
        img = sitk.GetImageFromArray(mean / len(phases))
        img.CopyInformation(phases[0])
        if ref is None:
            ref = img
            arr = sitk.GetArrayFromImage(img)
            box = crop_box(largest(ndimage.binary_opening(arr > -500, iterations=2)), 4)
        else:
            img = sitk.Resample(img, ref, register(ref, img), sitk.sitkLinear, -1000)
        arr = sitk.GetArrayFromImage(img)[box]
        sx, sy, sz = ref.GetSpacing()
        origin = np.array(ref.GetOrigin()) + np.array([box[2].start * sx, box[1].start * sy, box[0].start * sz])
        day = (dt.datetime.strptime(date, "%Y%m%d").date() - first_day).days
        on_record = COURSE_START + dt.timedelta(days=day)
        name = f"scan-{n:02d}"
        (out / name).mkdir()
        nib.save(nifti_lps(np.clip(arr, -1024, 3071), origin, (sx, sy, sz), np.int16), out / name / "ct.nii.gz")
        # The frame's value is the treatment day; a day's second scan sits half a day after its first.
        second = any(f["value"] == day + 1 for f in frames)
        frames.append({"value": day + 1.5 if second else day + 1, "label": f"Day {day + 1}" + (", second scan" if second else ""),
                       "note": on_record.strftime("%-d %b %Y"), "layers": {"ct": f"{name}/ct.nii.gz"},
                       "bytes": (out / name / "ct.nii.gz").stat().st_size})
        files = [f for fo in folders for f in fo.glob("*.dcm")]
        raw_files += len(files)
        raw_bytes += sum(f.stat().st_size for f in files)
        print(f"  cone-beam CT {n:2d}: day {day + 1:2d} ({on_record}), {len(phases)} phases", flush=True)
    first = nib.load(out / "scan-01" / "ct.nii.gz")
    mid = np.asanyarray(first.dataobj)
    thumbnail(np.rot90(mid[:, mid.shape[1] // 2, :]), out / "thumbnail.jpg")
    last_day = int(frames[-1]["value"])
    meta = {
        "id": "lung-4dcbct",
        "category": "Thoracic",
        "title": "Treatment-day cone-beam CTs",
        "subtitle": f"{len(frames)} scans over {last_day} days of radiotherapy",
        "modality": "4D cone-beam CT on the treatment couch (Varian On-Board Imager)",
        "description": (
            f"The cone-beam CTs taken on the treatment couch before radiotherapy sessions, {len(frames)} scans over "
            f"{last_day} days, each the average of its ten breathing phases and aligned to the first day. Play them to "
            "follow the tumour and the lungs through the course. Cone-beam CT is lower in contrast than the planning "
            "CT and its grey values are not calibrated Hounsfield units."
        ),
        "source": LUNG_SOURCE, "sourceUrl": LUNG_URL, "license": LUNG_LICENSE, "citation": LUNG_CITATION,
        "subject": "Male with non-small cell lung cancer (the same patient as the planning 4D CT)",
        "patientId": str(scans[0][4].PatientID),
        "scanner": f"{getattr(scans[0][4], 'Manufacturer', '')} {getattr(scans[0][4], 'ManufacturerModelName', '')}".strip(),
        "thumbnail": "thumbnail.jpg",
        "rawPath": "raw/idc/4d_lung/100_HM10395/", "rawFiles": raw_files, "rawSizeBytes": raw_bytes,
        "sizeBytes": folder_bytes(out),
        "defaultView": "multiplanar",
        "defaultPreset": "lungs",
        "defaultPreset2d": "lung",
        "stats": {"scans": len(frames), "days": last_day, "phases": 10},
        "layers": [{"id": "ct", "label": "Cone-beam CT, average of ten breathing phases", "kind": "ct", "frameKey": "ct",
                    "visible": True}],
        "timeline": {"label": "Treatment day", "unit": "", "initial": 1, "fps": 2, "frames": frames},
        "dims": list(first.shape[:3]),
        "spacingMm": [round(float(v), 3) for v in first.header.get_zooms()[:3]],
    }
    (out / "study.json").write_text(json.dumps(meta, indent=2))
    return meta, [s[0] for s in scans]


# ---- The fetal atlas ----

FETAL_CHANNELS = [  # id, file pattern, label, kind, scale to display units, unit, colour map
    ("t1", "structural/t1-t{w}.00.nii.gz", "T1-weighted", "mri", None, None, None),
    ("fa", "diffusion/fa-t{w}.00.nii.gz", "Fractional anisotropy (FA)", "overlay", 0.01, None, "inferno"),
    ("md", "diffusion/md-t{w}.00.nii.gz", "Mean diffusivity (MD)", "overlay", 1.0, "×10⁻³ mm²/s", "plasma"),
    ("rd", "diffusion/rd-t{w}.00.nii.gz", "Radial diffusivity (RD)", "overlay", 1.0, "×10⁻³ mm²/s", "plasma"),
    ("dwi", "diffusion/dwi1000-t{w}.00.nii.gz", "Diffusion-weighted, b = 1000", "mri", None, None, None),
]
WHITE_MATTER = (5, 6)


def read_scale(week: int) -> np.ndarray:
    """MIRTK affine-NN.dof: the week's scaling from world to atlas space (the imaging pipeline undid it the same way)."""
    raw = (FETAL / "transformations" / f"affine-{week}.dof").read_bytes()
    _, _, n = struct.unpack(">III", raw[:12])
    p = struct.unpack(f">{n}d", raw[12:12 + 8 * n])
    return np.array(p[6:9]) / 100.0


def build_fetal() -> dict:
    out = STUDY["fetal-brain-atlas"]
    meta = study_meta("fetal-brain-atlas")
    frames, ranges = [], {c[0]: [] for c in FETAL_CHANNELS}
    for f in meta["timeline"]["frames"]:
        w = int(f["value"])
        week = out / f"week-{w}"
        t2 = nib.load(week / "t2.nii.gz")
        lab = np.asanyarray(nib.load(week / "tissue.nii.gz").dataobj)
        s = read_scale(w)
        layers, notes = dict(f["layers"]), {}
        for cid, pattern, _label, _kind, factor, _unit, _cmap in FETAL_CHANNELS:
            src = nib.load(FETAL / pattern.format(w=w))
            m = np.linalg.inv(src.affine) @ np.diag([*s, 1.0]) @ t2.affine
            data = ndimage.affine_transform(np.asarray(src.dataobj, np.float32), m[:3, :3], m[:3, 3], output_shape=t2.shape,
                                            order=1, mode="constant", cval=0.0)
            data[lab == 0] = 0
            if factor is None:
                wm = data[np.isin(lab, WHITE_MATTER)]
                data = np.clip(data * (400.0 / float(np.median(wm[wm > 0]))), 0, 4000)
                img = nib.Nifti1Image(np.rint(data).astype(np.int16), t2.affine)
            else:
                data = data * factor
                img = nib.Nifti1Image(data.astype(np.float32), t2.affine)
                img.set_data_dtype(np.int16)
                vals = data[np.isin(lab, WHITE_MATTER)]
                notes[cid] = float(np.median(vals[vals > 0]))
                ranges[cid].append(np.percentile(data[lab > 0], [2, 98]))
            nib.save(img, week / f"{cid}.nii.gz")
            layers[cid] = f"week-{w}/{cid}.nii.gz"
        note = f"brain {f['brainVolumeMl']:,.0f} ml · white matter FA {notes['fa']:.2f}, MD {notes['md']:.2f}"
        # bytes stays the T2 and tissue labels', which load by default; the others load when switched on.
        frames.append(dict(f, layers=layers, note=note, whiteMatterFa=round(notes["fa"], 3),
                           whiteMatterMd=round(notes["md"], 3), whiteMatterRd=round(notes["rd"], 3)))
        print(f"  fetal atlas week {w}: {note}", flush=True)
    new_layers = []
    for cid, _, label, kind, factor, unit, cmap in FETAL_CHANNELS:
        layer = {"id": cid, "label": label, "kind": kind, "frameKey": cid, "visible": False}
        if kind == "overlay":
            lo, hi = np.median(np.stack(ranges[cid]), axis=0)
            layer.update({"colormap": cmap, "calMin": round(float(lo), 2), "calMax": round(float(hi), 2), "opacity": 0.85})
            if unit:
                layer["unit"] = unit
        new_layers.append(layer)
    files = [p for p in FETAL.rglob("*") if p.is_file()]
    return {"layers": [l for l in meta["layers"] if l["id"] not in {c[0] for c in FETAL_CHANNELS}] + new_layers,
            "timeline": dict(meta["timeline"], frames=frames), "sizeBytes": folder_bytes(out),
            "subtitle": "4D MRI atlas: T2, T1 and diffusion for each gestational week",
            "rawPath": "raw/dhcp_fetal_atlas/", "rawFiles": len(files), "rawSizeBytes": sum(p.stat().st_size for p in files)}


def build(only: str | None = None, write_tables: bool = True) -> None:
    """Every study, or those from one source (idc: the PET/CT and the lung studies; fetal: the fetal atlas)."""
    steps = [("petct-whole-body", build_petct, "idc"), ("lung-4dct", build_lung_planning, "idc"), ("fetal-brain-atlas", build_fetal, "fetal")]
    for name, fn, source in steps:
        if only and only != source:
            continue
        if not (STUDY[name] / "study.json").exists():
            raise SystemExit(f"No {name} in {STUDY[name]}. Run 30 first.")
        print(f"Building {name}")
        (STUDY[name] / "fullsize.json").write_text(json.dumps(fn()))
    if only in (None, "idc"):
        print("Building lung-4dcbct")
        build_course()
    if write_tables:
        merge_tables()


# ---- The showcase tables ----

def merge(meta: dict, override: dict) -> dict:
    return {**meta, **override}


def new_rows() -> list[dict]:
    """The studies this script adds, as rows of p360_showcase (the same columns 30 writes)."""
    rows = []
    for sid, kind, pid, date, section, note in NEW_STUDIES:
        folder = STUDY[sid]
        if not (folder / "study.json").exists():
            continue
        meta = json.loads((folder / "study.json").read_text())
        rows.append({
            "patient_id": pid, "study_id": sid, "kind": kind, "section": section, "date": pd.Timestamp(date).date(),
            "atlas": False, "title": meta["title"], "subtitle": meta["subtitle"], "modality": meta["modality"],
            "description": meta["description"], "note": note, "subject": meta["subject"], "source": meta["source"],
            "source_url": meta["sourceUrl"], "license": meta["license"], "citation": meta["citation"],
            "folder": f"viewer/{pid}/showcase/{sid}", "thumbnail": meta["thumbnail"], "bytes": folder_bytes(folder),
            "gigapixels": None, "meta_json": json.dumps(meta),
        })
    return rows


def merge_tables() -> None:
    showcase = importlib.import_module("30_patient360_showcase")
    df, parts = pd.read_parquet(showcase.TABLE), pd.read_parquet(showcase.PARTS)
    metas = {(p, s): "".join(g.sort_values("part").meta) for (p, s), g in parts.groupby(["patient_id", "study_id"])}
    df["meta_json"] = [metas[(r.patient_id, r.study_id)] for r in df.itertuples()]
    for sid, folder in STUDY.items():
        if (folder / "fullsize.json").exists():
            row = df.study_id == sid
            # From the imaging pipeline's own metadata each time (the folder's study.json, plus the DICOM study the catalog
            # adds), so earlier builds leave nothing behind.
            now = json.loads(df.loc[row, "meta_json"].iloc[0])
            base = study_meta(sid)
            base["sizeBytes"] = sum(int(l.get("bytes") or 0) for l in base["layers"]) or now.get("sizeBytes")
            if "study" in now:
                base["study"] = now["study"]
            meta = merge(base, json.loads((folder / "fullsize.json").read_text()))
            df.loc[row, "meta_json"] = json.dumps(meta)
            df.loc[row, "subtitle"] = meta.get("subtitle")
            df.loc[row, "bytes"] = folder_bytes(folder)
    extra = pd.DataFrame(new_rows())
    df = pd.concat([df[~df.study_id.isin(extra.study_id if len(extra) else [])], extra], ignore_index=True)
    studies, parts = showcase.split(df)
    studies.to_parquet(showcase.TABLE, index=False)
    parts.to_parquet(showcase.PARTS, index=False)
    print(f"  p360_showcase: {len(studies)} studies")


def fabric() -> None:
    showcase = importlib.import_module("30_patient360_showcase")
    from common import ensure_lakehouse, write_tables  # noqa: PLC0415

    ws_id, lh_id = ensure_lakehouse("Patient360", "Patient 360: the patient index, demo patients and viewer files")
    base = f"{showcase.BLOB}/{ws_id}/{lh_id}/Files"
    for src, dst in ((IDC, "raw/"), (FETAL, "raw/")):
        print(f"Uploading {src.relative_to(DATA)} to Patient360/Files/{dst}")
        showcase.azcopy(str(src), f"{base}/{dst}")
    for sid, folder in STUDY.items():
        print(f"Uploading {folder.relative_to(VIEWER.parent)}")
        showcase.azcopy(str(folder), f"{base}/{folder.parent.relative_to(VIEWER.parent)}/")
    write_tables(ws_id, lh_id, {"p360_showcase": pd.read_parquet(showcase.TABLE),
                                "p360_showcase_part": pd.read_parquet(showcase.PARTS)})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", nargs="?", choices=["download", "build", "tables"])
    ap.add_argument("--only", choices=["idc", "fetal"], help="one source (the two can run at once)")
    ap.add_argument("--fabric", action="store_true", help="upload the downloads and studies, and write the showcase tables")
    args = ap.parse_args()
    if args.fabric:
        fabric()
        return
    if args.step == "build":
        build(args.only)
        return
    if args.step == "tables":
        merge_tables()
        return
    if args.step == "download":
        if args.only != "fetal":
            print("Downloading from NCI Imaging Data Commons")
            download_idc()
        if args.only != "idc":
            print("Downloading the dHCP fetal atlas from G-Node GIN")
            download_fetal()


if __name__ == "__main__":
    main()
