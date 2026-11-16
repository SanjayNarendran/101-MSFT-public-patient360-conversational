"""Patient 360: the brain-wiring atlas on Stephan Rutherford's record, in full (plan H).

The imaging pipeline (research/imaging) builds the HCP1065 tractography atlas (Yeh 2022) as five group files and
names only the groups, so a question about one pathway had nothing to go on. This script downloads every file the
atlas's publisher offers (about 1.7 GB, CC BY-SA 4.0) to data/raw/hcp1065 and adds to the study's folder
(data/generated/p360/files/viewer/Z1002519/showcase/brain-tractography):

  atlas.json            the 87 bundles: name, side, group, which lines of the group's file are theirs (the imaging
                        demo's sampling replayed, and checked line by line against the publisher's bundles), length,
                        reach, the cortical areas each reaches and in what share of the 1,065 people, and its volume
                        across them; the publisher's figures and the downloads
  prob/<bundle>.nii.gz  how often the tract passes through each voxel over the 1,065 people (64 tracts), in percent,
                        on the template's grid
  mask/<bundle>.nii.gz  each bundle of the averaged atlas as a volume (87), on the template's grid
  figures/<name>.jpg    the publisher's 20 figures (the two slide decks stay with the downloads)

It then merges atlas.json into the study's metadata in p360_showcase. 30 applies it again after copying the study.

Run:  .venv/bin/python scripts/31_patient360_tractography.py            # download (once) and build
      .venv/bin/python scripts/31_patient360_tractography.py --fabric   # then upload both and write the showcase tables
"""
from __future__ import annotations

import argparse
import colorsys
import gzip
import importlib
import io
import json
import re
import shutil
import struct
import zipfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import nibabel as nib
import numpy as np
import pandas as pd
import requests
from nibabel.processing import resample_from_to
from PIL import Image

from common import DATA, GEN_DIR

RAW = DATA / "raw" / "hcp1065"
P360 = GEN_DIR / "p360"
STUDY_ID = "brain-tractography"
PATIENT = "Z1002519"
STUDY = P360 / "files" / "viewer" / PATIENT / "showcase" / STUDY_ID
VOLUME_CACHE = P360 / "hcp1065_volumes.json"
PEOPLE = 1065

GH = "https://github.com/data-others/atlas/releases/download/hcp1065/"
# name, where it comes from, what it holds
FILES = [
    ("hcp1065_avg_tracts_trk.zip", GH, "The 87 bundles of the averaged atlas as fibre lines (TrackVis)"),
    ("hcp1065_avg_tracts_tt.zip", GH, "The same bundles in DSI Studio's format"),
    ("hcp1065_avg_tracts_nifti.zip", GH, "Each bundle of the averaged atlas as a volume"),
    ("hcp1065_prob_coverage_nifti.zip", GH, "How often each of 64 tracts passes through each voxel, over 1,065 people"),
    ("1065_subject_tract_in_nifti.zip", GH, "Each person's tracts: 56 tracts in each of the 1,065 people"),
    ("tract_to_region_connectome_BM_KL.xlsx", GH, "Share of people whose tract reaches each Brodmann and Kleist area"),
    ("tract_to_region_connectome_MMP.xlsx", GH, "Share of people whose tract reaches each HCP-MMP area"),
    ("abbreviation.xlsx", GH, "The bundles' abbreviations and names"),
    ("abbreviation2.xlsx", GH, "The tracts' names and other names in use"),
    ("hcp1065_prob_coverage_jpg.zip", GH, "The publisher's figures of the probability maps, and two slide decks"),
    ("41467_2022_32595_MOESM4_ESM.zip", "https://static-content.springer.com/esm/art%3A10.1038%2Fs41467-022-32595-4/MediaObjects/",
     "The scripts behind the paper's figures"),
]

# The imaging pipeline's group files (research/imaging/pipeline/volumes/build_tractography.py): its folders in this
# order, each bundle sampled with one shared generator seeded 7.
GROUPS = [("association", "association"), ("projection", "projection"), ("commissural", "commissural"),
          ("cerebellum", "cerebellum"), ("cranial nerve", "cranial-nerve")]
MAX_PER_BUNDLE, POINT_STRIDE, SEED = 400, 4, 7

# abbreviation: name, other names, the publisher's name in its probability maps and each person's maps, connectome column
BASES = {
    "AF": ("Arcuate fasciculus", "", "Arcuate_Fasciculus", "AF"),
    "C_FPH": ("Cingulum, frontal parahippocampal segment", "", "Cingulum_Frontal_Parahippocampal", "C_FPH"),
    "C_FP": ("Cingulum, frontal parietal segment", "", "Cingulum_Frontal_Parietal", "C_FP"),
    "C_PHP": ("Cingulum, parahippocampal parietal segment", "sledge runner fasciculus", "Cingulum_Parahippocampal_Parietal", "C_PHP"),
    "C_PH": ("Cingulum, parahippocampal segment", "", "Cingulum_Parahippocampal", "C_PH"),
    "C_PO": ("Cingulum, parolfactory segment", "", "Cingulum_Parolfactory", "C_R"),
    "EMC": ("Extreme capsule", "", None, None),
    "FAT": ("Frontal aslant tract", "", "Frontal_Aslant_Tract", "FAT"),
    "IFOF": ("Inferior fronto-occipital fasciculus", "", "Inferior_Fronto_Occipital_Fasciculus", "IFOF"),
    "ILF": ("Inferior longitudinal fasciculus", "", "Inferior_Longitudinal_Fasciculus", "ILF"),
    "MdLF": ("Middle longitudinal fasciculus", "", "Middle_Longitudinal_Fasciculus", "MdLF"),
    "PAT": ("Parietal aslant tract", "temporo-parietal aslant tract; posterior or vertical arcuate fasciculus",
            "Parietal_Aslant_Tract", "PTAT"),
    "SLF1": ("Superior longitudinal fasciculus I", "", "Superior_Longitudinal_Fasciculus1", "SLF_I"),
    "SLF2": ("Superior longitudinal fasciculus II", "dorsal SLF", "Superior_Longitudinal_Fasciculus2", "SLF_II"),
    "SLF3": ("Superior longitudinal fasciculus III", "ventral SLF; long segment of the arcuate fasciculus",
             "Superior_Longitudinal_Fasciculus3", "SLF_III"),
    "UF": ("Uncinate fasciculus", "", "Uncinate_Fasciculus", "UF"),
    "VOF": ("Vertical occipital fasciculus", "", "Vertical_Occipital_Fasciculus", "VOF"),
    "AR": ("Acoustic radiation", "auditory radiation", None, None),
    "CBT": ("Corticobulbar tract", "", "Corticobulbar_Tract", "CBT"),
    "CPT_F": ("Corticopontine tract, frontal", "frontopontine tract", "Corticopontine_Tract_Frontal", None),
    "CPT_O": ("Corticopontine tract, occipital", "occipitopontine tract", "Corticopontine_Tract_Occipital", None),
    "CPT_P": ("Corticopontine tract, parietal", "parietopontine tract", "Corticopontine_Tract_Parietal", None),
    "CS_A": ("Corticostriatal tract, anterior", "", "Corticostriatal_Tract_Anterior", "CStr_A"),
    "CS_P": ("Corticostriatal tract, posterior", "", "Corticostriatal_Tract_Posterior", "CStr_P"),
    "CS_S": ("Corticostriatal tract, superior", "", "Corticostriatal_Tract_Superior", "CStr_S"),
    "CST": ("Corticospinal tract", "pyramidal tract", "Corticospinal_Tract", "CST"),
    "DRTT": ("Dentatorubrothalamic tract", "", None, None),
    "F": ("Fornix", "", "Fornix", "F"),
    "ML": ("Medial lemniscus", "", None, None),
    "OR": ("Optic radiation", "geniculocalcarine tract, with Meyer's loop", "Optic_Radiation", "OR"),
    "RST": ("Reticulospinal tract", "", "Reticulospinal_Tract", None),
    "TR_A": ("Thalamic radiation, anterior", "anterior corticothalamic tract", "Thalamic_Radiation_Anterior", "CTh_A"),
    "TR_P": ("Thalamic radiation, posterior", "posterior corticothalamic tract", "Thalamic_Radiation_Posterior", "CTh_P"),
    "TR_S": ("Thalamic radiation, superior", "superior corticothalamic tract", "Thalamic_Radiation_Superior", "CTh_S"),
    "AC": ("Anterior commissure", "", None, None),
    "CC": ("Corpus callosum", "", "Corpus_Callosum", None),
    "CB": ("Cerebellum", "cerebellar white matter", None, None),
    "ICP": ("Inferior cerebellar peduncle", "", None, None),
    "MCP": ("Middle cerebellar peduncle", "", None, None),
    "SCP": ("Superior cerebellar peduncle", "", None, None),
    "V": ("Vermis", "", None, None),
    "CNII": ("Optic nerve (cranial nerve II)", "", None, None),
    "CNIII": ("Oculomotor nerve (cranial nerve III)", "", None, None),
    "CNV": ("Trigeminal nerve (cranial nerve V)", "", None, None),
    "CNVII": ("Facial nerve (cranial nerve VII)", "", None, None),
    "CNVIII": ("Vestibulocochlear nerve (cranial nerve VIII)", "", None, None),
}
# The publisher's spellings that differ from the names above
LONG_ALIASES = {"Cingulum_Rarolfactory": "Cingulum_Parolfactory", "Reticular_Tract": "Reticulospinal_Tract"}
CC_PARTS = {"Body": "body", "Forceps_Major": "forceps major", "Forceps_Minor": "forceps minor", "Tapetum": "tapetum"}

BRODMANN = {
    "BA1/3": "primary somatosensory cortex", "BA2": "primary somatosensory cortex, caudal part",
    "BA4": "primary motor cortex", "BA5": "superior parietal cortex, somatosensory association area",
    "BA6": "premotor and supplementary motor cortex", "BA7": "superior parietal lobule and precuneus",
    "BA8": "frontal eye fields", "BA9": "dorsolateral prefrontal cortex", "BA10": "frontal pole",
    "BA11": "orbitofrontal cortex", "BA13": "insula", "BA16": "insula, posterior part",
    "BA17": "primary visual cortex", "BA18": "secondary visual cortex", "BA19": "visual association cortex",
    "BA20": "inferior temporal gyrus", "BA21": "middle temporal gyrus", "BA22": "superior temporal gyrus",
    "BA23": "posterior cingulate cortex, ventral part", "BA24": "anterior cingulate cortex, ventral part",
    "BA25": "subgenual cingulate cortex", "BA26/29/30": "retrosplenial cortex", "BA27": "presubiculum",
    "BA28": "entorhinal cortex", "BA31": "posterior cingulate cortex, dorsal part",
    "BA32": "anterior cingulate cortex, dorsal part", "BA33": "pregenual anterior cingulate cortex",
    "BA34": "entorhinal cortex, dorsal part (uncus)", "BA35/36": "perirhinal cortex", "BA37": "fusiform gyrus",
    "BA38": "temporal pole", "BA39": "angular gyrus", "BA40": "supramarginal gyrus",
    "BA41/42/52": "primary and secondary auditory cortex", "BA43": "subcentral area (taste)",
    "BA44": "pars opercularis (Broca's area)", "BA45": "pars triangularis (Broca's area)",
    "BA46": "dorsolateral prefrontal cortex", "BA47": "pars orbitalis",
}
# The publisher's figures: file stem, title, the bundles it shows
FIGURES = [
    ("all_tracts1", "All tracts, part 1", []), ("all_tracts2", "All tracts, part 2", []),
    ("all_tracts3", "All tracts, part 3", []),
    ("Arcuate_Fasciculus", "Arcuate fasciculus", ["AF"]),
    ("Cingulum", "Cingulum, its five segments", ["C_FPH", "C_FP", "C_PHP", "C_PH", "C_PO"]),
    ("Coricothalamic_Tract", "Thalamic radiations", ["TR_A", "TR_P", "TR_S"]),
    ("Corticobulbar_Tract", "Corticobulbar tract", ["CBT"]),
    ("Corticospinal_Tract", "Corticospinal tract", ["CST"]),
    ("Corticostriatal_Tract", "Corticostriatal tracts", ["CS_A", "CS_P", "CS_S"]),
    ("Fornix", "Fornix", ["F"]), ("Frontal_Aslant_Tract", "Frontal aslant tract", ["FAT"]),
    ("Inferior_Fronto_Occipital_Fasciculus", "Inferior fronto-occipital fasciculus", ["IFOF"]),
    ("Inferior_Longitudinal_Fasciculus", "Inferior longitudinal fasciculus", ["ILF"]),
    ("Optic_Radiation", "Optic radiation", ["OR"]),
    ("Superior_Longitudinal_Fasciculus_I", "Superior longitudinal fasciculus I", ["SLF1"]),
    ("Superior_Longitudinal_Fasciculus_II", "Superior longitudinal fasciculus II", ["SLF2"]),
    ("Superior_Longitudinal_Fasciculus_III", "Superior longitudinal fasciculus III", ["SLF3"]),
    ("Temporo-Parietal Aslant", "Parietal aslant tract", ["PAT"]),
    ("Uncinate_Fasciculus", "Uncinate fasciculus", ["UF"]),
    ("Vertical_Occipital_Fasciculus", "Vertical occipital fasciculus", ["VOF"]),
]


# ---- Download ----

def download() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    for name, base, _ in FILES:
        dst = RAW / name
        try:
            head = requests.head(base + name, allow_redirects=True, timeout=60)
            size = int(head.headers.get("content-length") or 0)
        except requests.RequestException:
            size = 0
        if dst.exists() and (not size or dst.stat().st_size == size):
            print(f"  {name:<40} {dst.stat().st_size / 1e6:>9,.1f} MB, already here")
            continue
        part = dst.with_suffix(dst.suffix + ".part")
        with requests.get(base + name, stream=True, timeout=600) as r:
            r.raise_for_status()
            with open(part, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
        part.rename(dst)
        print(f"  {name:<40} {dst.stat().st_size / 1e6:>9,.1f} MB")


# ---- The bundles in the viewer's group files ----

def thin(line: np.ndarray) -> np.ndarray:
    idx = list(range(0, len(line), POINT_STRIDE))
    if idx[-1] != len(line) - 1:
        idx.append(len(line) - 1)
    return line[idx].astype(np.float32)


def check_bundle(member: str, picks: list[int]) -> list[np.ndarray]:
    """The first and last sampled line of one of the publisher's bundles, thinned like the group files."""
    with zipfile.ZipFile(RAW / "hcp1065_avg_tracts_trk.zip") as z:
        lines = nib.streamlines.TrkFile.load(gzip.GzipFile(fileobj=io.BytesIO(z.read(member)))).streamlines
    return [thin(lines[picks[0]]), thin(lines[picks[-1]])]


def orient_groups() -> None:
    """Rewrites the group files in RAS voxel order. The imaging pipeline wrote them as LAS with a RAS affine: nibabel reads
    that correctly, but NiiVue applies the affine alone, so it drew every line mirrored left to right (the left
    corticospinal tract on the right, away from its own probability map)."""
    for _, layer in GROUPS:
        path = STUDY / f"{layer}.trk"
        trk = nib.streamlines.load(path)
        if trk.header["voxel_order"] in (b"RAS", "RAS"):
            continue
        header = dict(trk.header)
        header["voxel_order"] = "RAS"
        nib.streamlines.TrkFile(trk.tractogram, header=header).save(str(path))
        print(f"  {layer}.trk rewritten in RAS order")


def split_groups() -> list[dict]:
    """Each bundle's lines in its group file: the imaging pipeline's sampling replayed, then checked line by line."""
    z = zipfile.ZipFile(RAW / "hcp1065_avg_tracts_trk.zip")
    members = [n for n in z.namelist() if n.endswith(".trk.gz")]
    rng = np.random.default_rng(SEED)
    bundles, jobs = [], []
    for folder, layer in GROUPS:
        group = nib.streamlines.load(STUDY / f"{layer}.trk").streamlines
        first = 0
        for m in sorted((n for n in members if n.split("/")[0] == folder), key=lambda n: n.split("/")[-1]):
            with z.open(m) as f:
                total = struct.unpack("<i", gzip.GzipFile(fileobj=f).read(1000)[988:992])[0]
            n = min(total, max(MAX_PER_BUNDLE, int(total * 0.02)), 3000)
            picks = sorted(int(i) for i in rng.choice(total, size=n, replace=False))
            lines = [group[i] for i in range(first, first + n)]
            bundles.append({"id": m.split("/")[-1][: -len(".trk.gz")], "group": layer, "first": first, "lines": n,
                            "atlasLines": total, "_lines": lines})
            jobs.append((m, picks))
            first += n
        if first != len(group):
            raise SystemExit(f"{layer}.trk has {len(group)} lines; its bundles account for {first}.")
    with ProcessPoolExecutor(max_workers=8) as pool:
        for b, got in zip(bundles, pool.map(check_bundle, *zip(*jobs))):
            if not (np.allclose(got[0], b["_lines"][0], atol=1e-3) and np.allclose(got[1], b["_lines"][-1], atol=1e-3)):
                raise SystemExit(f"{b['id']}: the group file's lines are not the bundle's.")
    print(f"  {len(bundles)} bundles; every one matches its lines in the group files")
    return bundles


def geometry(lines: list[np.ndarray]) -> dict:
    lengths = [float(np.linalg.norm(np.diff(s, axis=0), axis=1).sum()) for s in lines]
    pts = np.concatenate(lines)
    return {"lengthMm": round(float(np.median(lengths))), "zMm": [round(float(pts[:, 2].min())), round(float(pts[:, 2].max()))],
            "yMm": [round(float(pts[:, 1].min())), round(float(pts[:, 1].max()))],
            "centreMm": [round(float(v)) for v in pts.mean(axis=0)]}


# ---- The connectome ----

def read_xlsx(path: Path) -> list[list[str]]:
    """The first sheet's cells as rows of strings (no Excel library needed)."""
    z = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in re.findall(r"<si>(.*?)</si>", z.read("xl/sharedStrings.xml").decode(), re.S):
            shared.append("".join(re.findall(r"<t[^>]*>(.*?)</t>", si, re.S)))
    sheet = sorted(n for n in z.namelist() if n.startswith("xl/worksheets/sheet"))[0]
    rows = []
    for row in re.findall(r"<row[^>]*>(.*?)</row>", z.read(sheet).decode(), re.S):
        cells = {}
        for attrs, body in re.findall(r"<c ([^>]*?)(?:/>|>(.*?)</c>)", row, re.S):
            col = re.search(r'r="([A-Z]+)\d+"', attrs).group(1)
            idx = 0
            for ch in col:
                idx = idx * 26 + ord(ch) - 64
            v = re.search(r"<v>(.*?)</v>", body or "")
            v = v.group(1) if v else ""
            cells[idx - 1] = shared[int(v)] if 't="s"' in attrs and v else v
        rows.append([cells.get(i, "") for i in range(max(cells) + 1 if cells else 0)])
    return rows


def areas(path: Path, keep) -> dict[tuple[str, str], list[tuple[str, float]]]:
    """(connectome column, side) -> [(area, share of people)] from one of the publisher's connectome sheets: one row per
    cortical area, the left hemisphere's tracts in the first block of columns and the right's in the second."""
    rows = read_xlsx(path)
    head = next(i for i, r in enumerate(rows) if "CST" in r)
    keys, seen = {}, set()
    for c, code in enumerate(rows[head]):
        if code:
            keys[c] = (code, "right" if code in seen else "left")
            seen.add(code)
    out: dict[tuple[str, str], list[tuple[str, float]]] = {k: [] for k in keys.values()}
    for r in rows[head + 1:]:
        if not r or not r[0] or not keep(r[0]):
            continue
        for c, key in keys.items():
            v = float(r[c]) if c < len(r) and r[c] else 0.0
            if v > 0:
                out[key].append((r[0], v))
    return out


# ---- Each person's tracts ----

def person_volumes(folder: str) -> tuple[str, list[float]]:
    """One tract's volume in each person who has it, in mL (1 mm voxels)."""
    out = []
    with zipfile.ZipFile(RAW / "1065_subject_tract_in_nifti.zip") as z:
        for info in z.infolist():
            if info.is_dir() or info.filename.split("/")[1] != folder:
                continue
            raw = gzip.decompress(z.read(info))
            offset = int(struct.unpack("<f", raw[108:112])[0])
            out.append(np.count_nonzero(np.frombuffer(raw, np.uint8, offset=offset)) / 1000)
    return folder, out


def volumes() -> dict[str, list[float]]:
    src = RAW / "1065_subject_tract_in_nifti.zip"
    if VOLUME_CACHE.exists():
        cached = json.loads(VOLUME_CACHE.read_text())
        if cached.get("bytes") == src.stat().st_size:
            return cached["volumes"]
    with zipfile.ZipFile(src) as z:
        folders = sorted({n.split("/")[1] for n in z.namelist() if n.count("/") >= 2 and n.split("/")[1]})
    with ProcessPoolExecutor() as pool:
        result = dict(pool.map(person_volumes, folders))
    VOLUME_CACHE.write_text(json.dumps({"bytes": src.stat().st_size, "volumes": result}))
    return result


def volume_stats(values: list[float] | None) -> dict | None:
    if not values:
        return None
    v = np.array(values)
    return {"people": int(len(v)), "of": PEOPLE, "medianMl": round(float(np.median(v)), 1),
            "p25Ml": round(float(np.percentile(v, 25)), 1), "p75Ml": round(float(np.percentile(v, 75)), 1),
            "minMl": round(float(v.min()), 1), "maxMl": round(float(v.max()), 1)}


# ---- Volumes on the template's grid ----

def load_member(z: zipfile.ZipFile, member: str) -> nib.Nifti1Image:
    fh = nib.FileHolder(fileobj=io.BytesIO(gzip.decompress(z.read(member))))
    img = nib.Nifti1Image.from_file_map({"header": fh, "image": fh})
    return nib.Nifti1Image(np.asanyarray(img.dataobj).astype(np.float32), img.affine)


def write_volumes(template: nib.Nifti1Image) -> tuple[dict[str, str], dict[str, str]]:
    """prob/<id>.nii.gz (percent of people) and mask/<id>.nii.gz (the averaged bundle), on the template's grid."""
    for d in ("prob", "mask"):
        shutil.rmtree(STUDY / d, ignore_errors=True)
        (STUDY / d).mkdir(parents=True)
    by_long = {v[2]: k for k, v in BASES.items() if v[2]}
    probs: dict[str, str] = {}
    with zipfile.ZipFile(RAW / "hcp1065_prob_coverage_nifti.zip") as z:
        for m in z.namelist():
            if not m.endswith(".nii.gz"):
                continue
            stem = m.split("/")[-1][: -len(".nii.gz")]
            long, _, side = stem.rpartition("_")
            if side not in ("L", "R"):
                long, side = stem, ""
            long = LONG_ALIASES.get(long, long)
            if long.startswith("Corpus_Callosum_"):
                bid = "CC_" + long[len("Corpus_Callosum_"):]
            else:
                bid = f"{by_long[long]}_{side}" if side else by_long[long]
            img = resample_from_to(load_member(z, m), template, order=1)
            pct = np.clip(np.rint(np.asanyarray(img.dataobj) * 100), 0, 100).astype(np.uint8)
            nib.save(nib.Nifti1Image(pct, template.affine), STUDY / "prob" / f"{bid}.nii.gz")
            probs[bid] = f"prob/{bid}.nii.gz"
    masks: dict[str, str] = {}
    with zipfile.ZipFile(RAW / "hcp1065_avg_tracts_nifti.zip") as z:
        for m in z.namelist():
            if not m.endswith(".nii.gz"):
                continue
            bid = m.split("/")[-1][: -len(".nii.gz")]
            img = resample_from_to(load_member(z, m), template, order=1)
            mask = (np.asanyarray(img.dataobj) > 0.2).astype(np.uint8)
            nib.save(nib.Nifti1Image(mask, template.affine), STUDY / "mask" / f"{bid}.nii.gz")
            masks[bid] = f"mask/{bid}.nii.gz"
    print(f"  {len(probs)} probability maps and {len(masks)} bundle volumes on the template's grid")
    return probs, masks


def write_figures() -> list[dict]:
    shutil.rmtree(STUDY / "figures", ignore_errors=True)
    (STUDY / "figures").mkdir(parents=True)
    out = []
    with zipfile.ZipFile(RAW / "hcp1065_prob_coverage_jpg.zip") as z:
        names = {n.split("/")[-1].rsplit(".", 1)[0]: n for n in z.namelist() if n.endswith(".tif")}
        for stem, title, bundles in FIGURES:
            im = Image.open(io.BytesIO(z.read(names[stem])))
            flat = Image.new("RGB", im.size, (255, 255, 255))
            flat.paste(im.convert("RGBA"), mask=im.convert("RGBA").split()[3])
            slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
            big = flat.resize((2400, round(flat.height * 2400 / flat.width)), Image.LANCZOS)
            big.save(STUDY / "figures" / f"{slug}.jpg", quality=86)
            small = flat.resize((640, round(flat.height * 640 / flat.width)), Image.LANCZOS)
            small.save(STUDY / "figures" / f"{slug}-small.jpg", quality=84)
            out.append({"file": f"figures/{slug}.jpg", "small": f"figures/{slug}-small.jpg", "title": title,
                        "bundles": bundles, "width": big.width, "height": big.height,
                        "bytes": (STUDY / "figures" / f"{slug}.jpg").stat().st_size})
    print(f"  {len(out)} figures")
    return out


def colour(i: int) -> str:
    r, g, b = colorsys.hls_to_rgb((i * 0.618034) % 1, 0.56, 0.62)
    return f"#{int(r * 255):02x}{int(g * 255):02x}{int(b * 255):02x}"


# ---- Build ----

def base_of(bid: str) -> tuple[str, str | None]:
    if bid.endswith(("_L", "_R")):
        return bid[:-2], "left" if bid.endswith("_L") else "right"
    return bid, None


def build() -> dict:
    if not (STUDY / "projection.trk").exists():
        raise SystemExit(f"No study in {STUDY}. Run 30 first (--from-local).")
    missing = [n for n, *_ in FILES if not (RAW / n).exists()]
    if missing:
        raise SystemExit(f"Missing downloads: {', '.join(missing)}. Run this script without --fabric first.")
    template = nib.load(STUDY / "t1.nii.gz")
    orient_groups()
    print("Splitting the group files into bundles")
    bundles = split_groups()
    print("Reading the connectome and each person's tracts")
    bm = areas(RAW / "tract_to_region_connectome_BM_KL.xlsx", lambda a: a.startswith("BA"))
    mmp = areas(RAW / "tract_to_region_connectome_MMP.xlsx", lambda a: True)
    vols = volumes()
    probs, masks = write_volumes(template)
    figures = write_figures()
    by_long = {v[2]: k for k, v in BASES.items() if v[2]}
    person = {}
    for folder, values in vols.items():
        long, _, side = folder.rpartition("_")
        long = LONG_ALIASES.get(long, long)
        if folder.startswith("Corpus_Callosum_"):
            person["CC_" + folder[len("Corpus_Callosum_"):]] = values
        elif long in by_long:
            person[f"{by_long[long]}_{side}"] = values
    out = []
    for i, b in enumerate(bundles):
        base, side = base_of(b["id"])
        name, other, _, code = BASES[base]
        rec = {"id": b["id"], "abbr": base, "name": name, "side": side, "group": b["group"], "first": b["first"],
               "lines": b["lines"], "atlasLines": b["atlasLines"], **geometry(b["_lines"]),
               "colour": colour(i)}
        if other:
            rec["otherNames"] = other
        if code and side:
            reached = sorted(bm.get((code, side), []), key=lambda a: -a[1])
            rec["cortex"] = [{"area": a, "share": round(v, 3)} for a, v in reached if v >= 0.2]
            rec["mmp"] = [{"area": a, "share": round(v, 3)} for a, v in sorted(mmp.get((code, side), []), key=lambda a: -a[1])[:12] if v >= 0.3]
        if b["id"] in probs:
            rec["prob"] = probs[b["id"]]
        rec["mask"] = masks.get(b["id"])
        if b["id"] == "CC":
            rec["parts"] = [{"id": f"CC_{k}", "name": v, "prob": probs.get(f"CC_{k}"), "volume": volume_stats(person.get(f"CC_{k}"))}
                            for k, v in CC_PARTS.items()]
        stats = volume_stats(person.get(b["id"]))
        if stats:
            rec["volume"] = stats
        fig = next((f["file"] for f in figures if base in f["bundles"]), None)
        if fig:
            rec["figure"] = fig
        out.append(rec)
    downloads = [{"file": n, "bytes": (RAW / n).stat().st_size, "what": what, "url": base + n} for n, base, what in FILES]
    atlas = {
        "bundles": out,
        "areaNames": BRODMANN,
        # The atlas's lowest point (the lower brainstem): a tract that goes on into the spinal cord leaves it here.
        "floorMm": min(b["zMm"][0] for b in out),
        "figures": figures,
        "downloads": downloads,
        "stats": {"bundles": len(out), "streamlines": sum(b["lines"] for b in out),
                  "atlasStreamlines": sum(b["atlasLines"] for b in out), "people": PEOPLE,
                  "probabilityMaps": len(probs)},
        "description": (
            "The brain's long-range wiring, reconstructed from diffusion MRI of 1,065 healthy adults in the Human "
            "Connectome Project: 87 named bundles in five groups. Each line is a fibre pathway, coloured by direction "
            "(red left to right, green front to back, blue top to bottom) or by bundle. Each bundle can be shown on "
            "its own, with the cortical areas it reaches, how its volume varies between people and how often it "
            "passes through each point of the brain."
        ),
    }
    (STUDY / "atlas.json").write_text(json.dumps(atlas))
    for b in bundles:
        b.pop("_lines")
    print(f"  atlas.json: {len(out)} bundles, {sum(1 for b in out if b.get('cortex'))} with cortical areas, "
          f"{sum(1 for b in out if b.get('volume'))} with volumes across people")
    return atlas


def merge(meta: dict, atlas: dict) -> dict:
    """The study's metadata with the atlas's bundles, figures and downloads."""
    meta = {**meta, **{k: atlas[k] for k in ("bundles", "areaNames", "floorMm", "figures", "downloads", "description")}}
    meta["stats"] = {**(meta.get("stats") or {}), **atlas["stats"]}
    return meta


def merge_tables() -> None:
    """Writes the atlas into the study's row of p360_showcase (and its metadata parts)."""
    showcase = importlib.import_module("30_patient360_showcase")
    if not showcase.TABLE.exists():
        print("  p360_showcase.parquet is not built yet; 30 merges atlas.json when it runs")
        return
    df, parts = pd.read_parquet(showcase.TABLE), pd.read_parquet(showcase.PARTS)
    metas = {(p, s): "".join(g.sort_values("part").meta) for (p, s), g in parts.groupby(["patient_id", "study_id"])}
    df["meta_json"] = [metas[(r.patient_id, r.study_id)] for r in df.itertuples()]
    atlas = json.loads((STUDY / "atlas.json").read_text())
    row = (df.patient_id == PATIENT) & (df.study_id == STUDY_ID)
    df.loc[row, "meta_json"] = json.dumps(merge(json.loads(df.loc[row, "meta_json"].iloc[0]), atlas))
    df.loc[row, "description"] = atlas["description"]
    df.loc[row, "bytes"] = sum(f.stat().st_size for f in STUDY.rglob("*") if f.is_file())
    studies, parts = showcase.split(df)
    studies.to_parquet(showcase.TABLE, index=False)
    parts.to_parquet(showcase.PARTS, index=False)
    print(f"  p360_showcase: {STUDY_ID} now carries {len(atlas['bundles'])} bundles")


def fabric() -> None:
    showcase = importlib.import_module("30_patient360_showcase")
    from common import ensure_lakehouse, write_tables

    ws_id, lh_id = ensure_lakehouse("Patient360", "Patient 360: the patient index, demo patients and viewer files")
    print("Uploading the downloads to Patient360/Files/raw/hcp1065")
    showcase.azcopy(str(RAW), f"{showcase.BLOB}/{ws_id}/{lh_id}/Files/raw/")
    print(f"Uploading viewer/{PATIENT}/showcase/{STUDY_ID}")
    showcase.azcopy(str(STUDY), f"{showcase.BLOB}/{ws_id}/{lh_id}/Files/viewer/{PATIENT}/showcase/")
    write_tables(ws_id, lh_id, {"p360_showcase": pd.read_parquet(showcase.TABLE),
                                "p360_showcase_part": pd.read_parquet(showcase.PARTS)})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fabric", action="store_true", help="upload the downloads and the study, and write the showcase tables")
    args = ap.parse_args()
    if args.fabric:
        fabric()
        return
    print("Downloading the HCP1065 atlas from its publisher")
    download()
    build()
    merge_tables()


if __name__ == "__main__":
    main()
