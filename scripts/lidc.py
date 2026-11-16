"""Parses the LIDC-IDRI nodule annotations (DICOM SR TID 1500 + DICOM SEG, from NCI IDC) into one row per
radiologist annotation and one aggregated row per nodule. The aggregated nodules ground the CT reports and the
pulmonary-nodule diagnoses added to the matched patients.

Laterality and lobe are approximations: the segmentation centroid gives left/right and the cranio-caudal position
within the CT series; the lobe is inferred from that position, not from a lung segmentation.
"""
import re
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd
import pydicom

CODE_FIELDS = {
    "Subtlety score": "subtlety", "Internal structure": "internal_structure", "Calcification": "calcification",
    "Sphericity": "sphericity", "Margin": "margin", "Lobular Pattern": "lobulation", "Spiculation": "spiculation",
    "Texture": "texture", "Malignancy": "malignancy",
}
NUM_FIELDS = {"Volume": "volume_mm3", "Diameter": "diameter_mm", "Surface area of mesh": "surface_mm2"}


# LIDC rates these on 1-5 scales; the SR encodes the end points as text and the middle values as "N out of 5"
TEXT_SCORES = {
    "texture": {"non-solid pulmonary nodule": 1, "part-solid pulmonary nodule": 3, "solid pulmonary nodule": 5},
    "margin": {"Indistinct margin": 1, "Circumscribed margin": 5},
    "sphericity": {"linear": 1, "ovoid": 3, "round": 5},
}


def _score(text):
    m = re.match(r"(\d) out of 5", text or "")
    return int(m.group(1)) if m else None


def texture_word(score):
    return None if pd.isna(score) else "ground-glass" if score < 2.5 else "part-solid" if score < 4 else "solid"


def margin_word(score):
    return None if pd.isna(score) else "ill-defined" if score < 2.5 else "lobulated" if score < 4 else "well-circumscribed"


def shape_word(score):
    return None if pd.isna(score) else "elongated" if score < 2.5 else "ovoid" if score < 4 else "round"


def _content(seq):
    for item in seq:
        name = item.ConceptNameCodeSequence[0].CodeMeaning if "ConceptNameCodeSequence" in item else ""
        yield name, item


def parse_sr(path: Path) -> dict:
    ds = pydicom.dcmread(path)
    row = {"patient_id": ds.PatientID, "study_uid": ds.StudyInstanceUID, "sr_series_uid": ds.SeriesInstanceUID,
           "annotation": ds.SeriesDescription.replace(" evaluations", "")}
    zs = []
    for name, item in _content(ds.ContentSequence):
        if name == "Image Library":
            for _, group in _content(item.ContentSequence):
                for gname, gitem in _content(group.ContentSequence):
                    if gitem.ValueType == "IMAGE" and "ContentSequence" in gitem:
                        for _, sub in _content(gitem.ContentSequence):
                            if sub.ValueType == "NUM" and "MeasuredValueSequence" in sub:
                                zs.append(float(sub.MeasuredValueSequence[0].NumericValue))
                    elif gname == "Slice Thickness" and "MeasuredValueSequence" in gitem:
                        row["slice_thickness_mm"] = float(gitem.MeasuredValueSequence[0].NumericValue)
        if name == "Imaging Measurements":
            for _, group in _content(item.ContentSequence):
                for gname, gitem in _content(group.ContentSequence):
                    if gname == "Tracking Identifier":
                        row["nodule"] = gitem.TextValue
                    elif gname == "Source series for segmentation":
                        row["ct_series_uid"] = gitem.UID
                    elif gname in NUM_FIELDS and "MeasuredValueSequence" in gitem:
                        row[NUM_FIELDS[gname]] = float(gitem.MeasuredValueSequence[0].NumericValue)
                    elif gname in CODE_FIELDS:
                        meaning = gitem.ConceptCodeSequence[0].CodeMeaning
                        key = CODE_FIELDS[gname]
                        score = TEXT_SCORES.get(key, {}).get(meaning, _score(meaning))
                        row[key] = score if score is not None else meaning
    if zs:
        row["ct_z_min"], row["ct_z_max"] = min(zs), max(zs)
    return row


def parse_seg(path: Path) -> dict:
    ds = pydicom.dcmread(path)
    mask = ds.pixel_array
    if mask.ndim == 2:
        mask = mask[None]
    spacing = [float(v) for v in ds.SharedFunctionalGroupsSequence[0].PixelMeasuresSequence[0].PixelSpacing]
    xs, zs, weights = [], [], []
    for i, frame in enumerate(ds.PerFrameFunctionalGroupsSequence):
        count = int(mask[i].sum())
        if not count:
            continue
        ipp = [float(v) for v in frame.PlanePositionSequence[0].ImagePositionPatient]
        cols = np.nonzero(mask[i])[1]
        xs.append(ipp[0] + cols.mean() * spacing[1])
        zs.append(ipp[2])
        weights.append(count)
    annotation = ds.SeriesDescription.replace("Segmentation of ", "")
    if not weights:
        return {"patient_id": ds.PatientID, "annotation": annotation}
    w = np.array(weights, dtype=float)
    return {"patient_id": ds.PatientID, "annotation": annotation, "seg_series_uid": ds.SeriesInstanceUID,
            "centroid_x": float(np.average(xs, weights=w)), "centroid_z": float(np.average(zs, weights=w))}


def _mode(values):
    values = [v for v in values if isinstance(v, str) and v]
    return Counter(values).most_common(1)[0][0] if values else None


def lobe(row):
    if pd.isna(row.centroid_x) or pd.isna(row.ct_z_max) or row.ct_z_max == row.ct_z_min:
        return None, None
    side = "right" if row.centroid_x < 0 else "left"  # DICOM patient coordinates: +x is the patient's left
    rel = (row.ct_z_max - row.centroid_z) / (row.ct_z_max - row.ct_z_min)  # 0 = top of scan, 1 = bottom
    if side == "right":
        name = "right upper lobe" if rel < 0.38 else "right middle lobe" if rel < 0.55 else "right lower lobe"
    else:
        name = "left upper lobe" if rel < 0.42 else "lingula" if rel < 0.52 else "left lower lobe"
    return side, name


def build(sr_dir: Path, seg_dir: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    srs = pd.DataFrame([parse_sr(p) for p in sorted(sr_dir.rglob("*.dcm"))])
    segs = pd.DataFrame([parse_seg(p) for p in sorted(seg_dir.rglob("*.dcm"))])
    ann = srs.merge(segs, on=["patient_id", "annotation"], how="left")
    ann = ann.sort_values(["patient_id", "study_uid", "nodule", "annotation"]).reset_index(drop=True)

    rows = []
    for (pid, study, nodule), g in ann.groupby(["patient_id", "study_uid", "nodule"], sort=True):
        row = {"patient_id": pid, "study_uid": study, "nodule": nodule, "ct_series_uid": g.ct_series_uid.iloc[0],
               "readers": len(g), "diameter_mm": round(g.diameter_mm.mean(), 1),
               "max_diameter_mm": round(g.diameter_mm.max(), 1), "volume_mm3": round(g.volume_mm3.mean(), 1),
               "malignancy": round(g.malignancy.mean(), 2), "spiculation": round(g.spiculation.mean(), 2),
               "lobulation": round(g.lobulation.mean(), 2), "subtlety": round(g.subtlety.mean(), 2),
               "texture": texture_word(pd.to_numeric(g.texture).mean()),
               "margin": margin_word(pd.to_numeric(g.margin).mean()),
               "shape": shape_word(pd.to_numeric(g.sphericity).mean()),
               "calcification": _mode(g.calcification), "internal_structure": _mode(g.internal_structure),
               "slice_thickness_mm": g.slice_thickness_mm.iloc[0],
               "centroid_x": g.centroid_x.mean(), "centroid_z": g.centroid_z.mean(),
               "ct_z_min": g.ct_z_min.iloc[0], "ct_z_max": g.ct_z_max.iloc[0]}
        rows.append(row)
    nod = pd.DataFrame(rows)
    sides = nod.apply(lobe, axis=1, result_type="expand")
    nod["side"], nod["lobe"] = sides[0], sides[1]
    return ann, nod
