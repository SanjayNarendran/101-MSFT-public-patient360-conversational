"""Patient 360: six imaging research studies (research/imaging), attached to two demo patients.

The imaging pipeline (research/imaging/pipeline/run_all.py, ported from the Rayfin imaging demo) builds public research
images for richer viewers: a TCGA breast slide with AI layers, a 36-plex immunofluorescence slide, a whole-body FDG
PET/CT, a breathing 4D CT, a brain-wiring atlas and a fetal brain atlas. Each goes to a demo patient whose record it
fits:

  Stephan Rutherford (Z1002519)   4D CT planning his radiotherapy (March 2018), whole-body FDG PET/CT (August 2019),
                                  brain-wiring atlas beside his MRI after a stroke (March 2003)
  Ivelisse Nitzsche (Z1003499)    breast slide with AI layers (April 2009), fetal brain atlas in her pregnancy (2016),
                                  36-plex CyCIF of colon cancer tissue (May 2018)

They are not added to the PACS or to Epic. Their viewer files go to data/generated/p360/files/viewer/<patient>/showcase/
<study>/ (paths in their metadata made relative to that folder), and p360_showcase.parquet lists them: patient, date,
section, title, what it shows, source, licence and citation; p360_showcase_part holds each study's own metadata as JSON,
in parts of 6,000 characters. `--fabric` uploads the files to Patient360/Files/viewer and writes both tables there.

Source (the pipeline downloads each study from its publisher; licences in research/README.md):
  --from-local [PATH]     the pipeline's folder with work/lakehouse and work/volumes (default research/imaging); files
                          are APFS clones on macOS. A study the pipeline did not build (--skip-cycif) is left out.

The brain-wiring atlas gets the rest of its publisher's data from 31 (scripts/31_patient360_tractography.py), and the
PET/CT, 4D CT and fetal atlas their full-size originals from 32 (scripts/32_patient360_fullsize.py, which also adds the
treatment-day cone-beam CTs); this script runs both builds again after copying the studies, once they have downloaded.

Run:  .venv/bin/python research/imaging/pipeline/run_all.py
      .venv/bin/python scripts/30_patient360_showcase.py --from-local
      .venv/bin/python scripts/24_patient360_data.py --index-only     # the list's slide and scan counts
      .venv/bin/python scripts/30_patient360_showcase.py --fabric      # upload and write the table
"""
from __future__ import annotations

import argparse
import importlib
import json
import os
import platform
import shutil
import subprocess
from pathlib import Path

import pandas as pd

from common import GEN_DIR, ROOT, ensure_lakehouse, write_tables

P360 = GEN_DIR / "p360"
PIPELINE = ROOT / "research" / "imaging"
VIEWER = P360 / "files" / "viewer"
TABLE = P360 / "p360_showcase.parquet"
PARTS = P360 / "p360_showcase_part.parquet"
# SQL analytics endpoints expose strings as varchar(8000): each study's metadata is stored in parts.
PART = 6000
BLOB = "https://onelake.blob.fabric.microsoft.com"

# study id in the imaging pipeline, its kind there, the patient, the date in the record, the tab, and how it fits the record
SHOWCASE = [
    ("lung-4dct", "volume", "Z1002519", "2018-03-17", "radiology",
     "Planning CT for his radiotherapy, the day before chemoradiation began: ten phases of one breath, with the tumour, "
     "airway, heart and spine outlined by the radiotherapy team."),
    ("petct-whole-body", "volume", "Z1002519", "2019-08-12", "radiology",
     "Whole-body FDG PET/CT in August 2019, two months before he died. The PET shows where glucose is used: tumour "
     "deposits glow against normal uptake in the brain, heart, kidneys and bladder."),
    ("brain-tractography", "volume", "Z1002519", "2003-03-20", "radiology",
     "The brain's long-range wiring from a population atlas, shown beside his brain MRI after the stroke of March 2003. "
     "It is an average of 1,065 healthy adults, not his own diffusion scan."),
    ("breast-brca", "slide", "Z1003499", "2009-04-15", "pathology",
     "A second breast cancer slide for her 2009 diagnosis, with AI outlines of every cell nucleus and a map of immune "
     "cells, the frozen section and the scanned report of the case it comes from."),
    ("fetal-brain-atlas", "volume", "Z1003499", "2016-05-30", "radiology",
     "The normal fetal brain from 21 to 36 weeks, the reference for her 2016 pregnancy. It is an atlas averaged from "
     "187 pregnancies, not a scan of her baby."),
    ("colon-cycif", "slide", "Z1003499", "2018-05-08", "pathology",
     "Colon cancer tissue imaged with 36 markers by cyclic immunofluorescence, for her 2018 colon cancer: tumour, stroma, "
     "nuclei and the immune cells around them, each marker switchable."),
]
ATLAS = {"brain-tractography", "fetal-brain-atlas"}


def relative(value, prefixes: tuple[str, ...]):
    """The metadata with every path made relative to the study's own folder."""
    if isinstance(value, dict):
        return {k: relative(v, prefixes) for k, v in value.items()}
    if isinstance(value, list):
        return [relative(v, prefixes) for v in value]
    if isinstance(value, str):
        for p in prefixes:
            if value.startswith(p):
                return value[len(p):]
    return value


def clone(src: Path, dst: Path):
    """Copies a folder; on macOS as APFS clones (cp -c), which share the source's blocks."""
    if dst.exists():
        shutil.rmtree(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    if platform.system() == "Darwin":
        subprocess.run(["cp", "-cR", str(src), str(dst)], check=True)
    else:
        shutil.copytree(src, dst)


def azcopy(src: str, dst: str) -> None:
    env = {**os.environ, "AZCOPY_AUTO_LOGIN_TYPE": "AZCLI"}
    subprocess.run(["azcopy", "copy", src, dst, "--recursive", "--overwrite=ifSourceNewer",
                    "--trusted-microsoft-suffixes=onelake.blob.fabric.microsoft.com;onelake.dfs.fabric.microsoft.com",
                    "--log-level=ERROR", "--output-level=essential"], env=env, check=True)


def catalogs(work: Path) -> dict[str, dict]:
    """The imaging pipeline's slide and volume catalogs, by study id."""
    slides = json.loads((work / "lakehouse" / "manifest.json").read_text())["slides"]
    volumes = json.loads((work / "volumes" / "manifest.json").read_text())["studies"]
    return {x["id"]: x for x in slides + volumes}


def from_local(root: Path) -> dict[str, dict]:
    work = root.expanduser() / "work"
    if not (work / "lakehouse" / "manifest.json").exists() or not (work / "volumes" / "manifest.json").exists():
        raise SystemExit(f"No imaging catalogs in {work}. Run research/imaging/pipeline/run_all.py first.")
    cat = catalogs(work)
    for sid, kind, pid, *_ in SHOWCASE:
        src = work / ("lakehouse/slides" if kind == "slide" else "volumes") / sid
        dst = VIEWER / pid / "showcase" / sid
        if sid not in cat or not src.exists():
            print(f"  {sid:<20} not built, left out")
            cat.pop(sid, None)
            continue
        clone(src, dst)
        files = sum(1 for f in dst.rglob("*") if f.is_file())
        print(f"  {sid:<20} -> viewer/{pid}/showcase/{sid} ({files:,} files)")
    return cat


def table(cat: dict[str, dict]) -> pd.DataFrame:
    rows = []
    for sid, kind, pid, date, section, note in SHOWCASE:
        if sid not in cat:
            continue
        meta = cat[sid]
        folder = f"viewer/{pid}/showcase/{sid}"
        meta = relative(meta, (f"slides/{sid}/", f"{sid}/"))
        atlas = VIEWER / pid / "showcase" / sid / "atlas.json"
        if atlas.exists():
            # The tractography atlas in full: its bundles, figures and downloads (31).
            meta = importlib.import_module("31_patient360_tractography").merge(meta, json.loads(atlas.read_text()))
        fullsize = VIEWER / pid / "showcase" / sid / "fullsize.json"
        if fullsize.exists():
            # The study at full size, from its originals (32).
            meta = {**meta, **json.loads(fullsize.read_text())}
        size = sum(f.stat().st_size for f in (VIEWER / pid / "showcase" / sid).rglob("*") if f.is_file())
        rows.append({
            "patient_id": pid, "study_id": sid,
            "kind": "fluorescence" if meta.get("kind") == "fluorescence" else kind,
            "section": section, "date": pd.Timestamp(date).date(), "atlas": sid in ATLAS,
            "title": meta["title"], "subtitle": meta.get("subtitle") or meta.get("diagnosis"),
            "modality": meta.get("modality") or ("Multiplexed immunofluorescence" if meta.get("kind") == "fluorescence" else "H&E whole-slide image"),
            "description": meta.get("description") or meta.get("blurb"), "note": note,
            "subject": meta.get("subject") or meta.get("case"),
            "source": meta.get("source"), "source_url": meta.get("sourceUrl"),
            "license": meta.get("license") or ("NIH GDC open access; AI layers CC BY 4.0" if kind == "slide" else None),
            "citation": meta.get("citation"), "folder": folder, "thumbnail": meta.get("thumbnail"),
            "bytes": size,
            "gigapixels": round(meta["width"] * meta["height"] / 1e9, 3) if "dzi" in meta else None,
            "meta_json": json.dumps(meta),
        })
    # The studies 32 adds from the full downloads (the treatment-day cone-beam CTs), once built.
    rows += importlib.import_module("32_patient360_fullsize").new_rows()
    return pd.DataFrame(rows)


def split(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """The studies, and their metadata in parts."""
    parts = [{"patient_id": r.patient_id, "study_id": r.study_id, "part": i // PART, "meta": r.meta_json[i : i + PART]}
             for r in df.itertuples() for i in range(0, len(r.meta_json), PART)]
    return df.drop(columns="meta_json"), pd.DataFrame(parts)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--from-local", type=Path, metavar="PATH", nargs="?", const=PIPELINE,
                     help="the imaging pipeline's folder, with work/ (default research/imaging)")
    ap.add_argument("--fabric", action="store_true", help="upload the files and write p360_showcase to Patient360")
    args = ap.parse_args()
    if args.from_local:
        print("Copying the six studies")
        cat = from_local(args.from_local)
        tracts = importlib.import_module("31_patient360_tractography")
        if all((tracts.RAW / n).exists() for n, *_ in tracts.FILES):
            print("Adding the tractography atlas in full (31)")
            tracts.build()
        else:
            print("Next, for the tractography atlas in full: .venv/bin/python scripts/31_patient360_tractography.py")
        full = importlib.import_module("32_patient360_fullsize")
        if full.LUNG.exists() and full.PETCT.exists() and (full.FETAL / "transformations").exists():
            print("Adding the studies at full size (32)")
            full.build(write_tables=False)
        else:
            print("Next, for the studies at full size: .venv/bin/python scripts/32_patient360_fullsize.py download, then build")
        df = table(cat)
        studies, parts = split(df)
        studies.to_parquet(TABLE, index=False)
        parts.to_parquet(PARTS, index=False)
        for r in df.itertuples():
            print(f"  {r.patient_id} {r.date} {r.section:<10} {r.title} ({r.bytes / 1e6:,.0f} MB)")
        print("Next: .venv/bin/python scripts/24_patient360_data.py --index-only")
    if args.fabric:
        if not TABLE.exists():
            raise SystemExit("Nothing imported yet: run with --from-local first.")
        df = pd.read_parquet(TABLE)
        ws_id, lh_id = ensure_lakehouse("Patient360", "Patient 360: the patient index, demo patients and viewer files")
        for pid in sorted(df.patient_id.unique()):
            print(f"Uploading viewer/{pid}/showcase")
            azcopy(str(VIEWER / pid / "showcase"), f"{BLOB}/{ws_id}/{lh_id}/Files/viewer/{pid}/")
        write_tables(ws_id, lh_id, {"p360_showcase": df, "p360_showcase_part": pd.read_parquet(PARTS)})
    if not (args.from_local or args.fabric):
        ap.error("give --from-local or --fabric")


if __name__ == "__main__":
    main()
