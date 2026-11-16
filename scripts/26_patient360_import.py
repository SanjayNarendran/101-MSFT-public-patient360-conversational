"""Patient 360: import the fifteen TCGA oncology research patients built by research/patient360 as research data.

The research pipeline (research/patient360/pipeline/run_all.py, ported from the Patient 360 reference app) downloads
fifteen real, de-identified TCGA cases from their publishers and builds three silos. They keep the reference app's table
schemas, so its Genomics, Cancer course, Treatment, Pathology, Radiology and Report tabs work on them unchanged:

  data/generated/research/clinical/tables/*.parquet   registry, synthetic primary care, report text, summaries
  data/generated/research/clinical/files/reports/     scanned pathology reports (PDF)
  data/generated/research/genomics/tables/*.parquet   somatic mutations, copy number, expression, immune mix, profile
  data/generated/research/imaging/tables/*.parquet    slides, radiology studies and series
  data/generated/research/imaging/files/slides/       Deep Zoom pyramids and AI lymphocyte maps
  data/generated/research/imaging/files/radiology/    NIfTI volumes and AI segmentations

--from-local copies them from the pipeline's work/ folder (research/patient360 unless PATH is given), as APFS clones
on macOS: instant, and no extra disk until a file changes. Then rebuild the patient index so they appear in the list:
.venv/bin/python scripts/24_patient360_data.py --index-only

--upload-local publishes the local copy to three lakehouses, Bronze_Oncology_Clinical, Bronze_Oncology_Genomics and
Bronze_Oncology_Imaging, created if missing: the tables written as Delta, the files uploaded with azcopy.

Run:  .venv/bin/python research/patient360/pipeline/run_all.py
      .venv/bin/python scripts/26_patient360_import.py --from-local
      .venv/bin/python scripts/26_patient360_import.py --upload-local
"""
from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
from pathlib import Path

import pandas as pd

from common import GEN_DIR, ROOT, ensure_lakehouse, write_tables

RESEARCH = GEN_DIR / "research"
PIPELINE = ROOT / "research" / "patient360"
# reference work/ path -> research path
LOCAL_MAP = [
    ("tables/clinical", "clinical/tables"),
    ("tables/genomics", "genomics/tables"),
    ("tables/imaging", "imaging/tables"),
    ("raw/reports", "clinical/files/reports"),
    ("lakehouse/imaging/slides", "imaging/files/slides"),
    ("lakehouse/imaging/radiology", "imaging/files/radiology"),
]


def clone(src: Path, dst: Path):
    """Copies a folder; on macOS as APFS clones (cp -c), which share the source's blocks."""
    if dst.exists():
        shutil.rmtree(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    if platform.system() == "Darwin":
        subprocess.run(["cp", "-cR", str(src), str(dst)], check=True)
    else:
        shutil.copytree(src, dst)


def from_local(root: Path):
    work = root / "work"
    if not (work / "tables" / "clinical" / "patient.parquet").exists():
        raise SystemExit(f"No research tables in {work}/tables. Run research/patient360/pipeline/run_all.py first.")
    for a, b in LOCAL_MAP:
        src = work / a
        if not src.exists():
            print(f"  {a}: not in {work}, skipped")
            continue
        clone(src, RESEARCH / b)
        files = sum(1 for f in (RESEARCH / b).rglob("*") if f.is_file())
        print(f"  {a:<28} -> research/{b} ({files:,} files)")


# Fabric: each research silo, its folder in data/generated/research, and the Files folders it holds
SILOS = [
    ("Bronze_Oncology_Clinical", "clinical", ["reports"],
     "Oncology research: TCGA registry, synthetic primary care, pathology reports"),
    ("Bronze_Oncology_Genomics", "genomics", [],
     "Oncology research: TCGA tumour genomes"),
    ("Bronze_Oncology_Imaging", "imaging", ["slides", "radiology"],
     "Oncology research: TCGA slides and CT/MRI with AI segmentations"),
]
BLOB = "https://onelake.blob.fabric.microsoft.com"


def azcopy(src: str, dst: str) -> None:
    env = {**os.environ, "AZCOPY_AUTO_LOGIN_TYPE": "AZCLI"}
    subprocess.run(["azcopy", "copy", src, dst, "--recursive", "--overwrite=ifSourceNewer",
                    "--trusted-microsoft-suffixes=onelake.blob.fabric.microsoft.com;onelake.dfs.fabric.microsoft.com",
                    "--log-level=ERROR", "--output-level=essential"], env=env, check=True)


def upload_local() -> None:
    for target, silo, folders, description in SILOS:
        tables = RESEARCH / silo / "tables"
        if not tables.exists():
            raise SystemExit(f"No local copy in {tables}: run --from-local first.")
        ws_id, lh_id = ensure_lakehouse(target, description)
        print(f"{target}")
        for folder in folders:
            src = RESEARCH / silo / "files" / folder
            if src.exists():
                print(f"  Files/{folder}")
                azcopy(str(src), f"{BLOB}/{ws_id}/{lh_id}/Files/")
        write_tables(ws_id, lh_id, {f.stem: pd.read_parquet(f) for f in sorted(tables.glob("*.parquet"))})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--from-local", type=Path, metavar="PATH", nargs="?", const=PIPELINE,
                     help="the research pipeline's folder, with work/ (default research/patient360)")
    src.add_argument("--upload-local", action="store_true", help="publish the local copy to the Fabric lakehouses")
    args = ap.parse_args()
    if args.from_local:
        print(f"Importing from {args.from_local.expanduser()}")
        from_local(args.from_local.expanduser())
        print("Done. Rebuild the patient index: .venv/bin/python scripts/24_patient360_data.py --index-only")
    else:
        upload_local()


if __name__ == "__main__":
    main()
