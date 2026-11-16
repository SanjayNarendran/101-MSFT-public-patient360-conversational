"""Download and build the fifteen TCGA oncology research patients that scripts/26_patient360_import.py imports.

    .venv/bin/python research/patient360/pipeline/run_all.py [--tissue-slides]

Steps, each the script you would run by hand, run with this interpreter (the first failure stops the run):
  download_sources.py         Synthea primary-care histories and the public reference files
  download_imaging.py         the diagnostic H&E slides from the NCI GDC (about 27 GB), and the CT/MRI, AI
                              segmentations and lymphocyte maps from IDC (about 2.1 GB)
  fetch_clinical_genomics.py  each patient's TCGA clinical record, tumour genome and scanned pathology report
  build_synthea.py            the synthetic primary care before each diagnosis
  build_slides.py             Deep Zoom tile pyramids and AI lymphocyte maps (hours on a small machine)
  build_radiology.py          browser-ready NIfTI volumes with their AI segmentations
  build_tables.py             the clinical, genomics and imaging tables (Parquet)

--tissue-slides also downloads and tiles the 23 frozen sections (about 5 GB more). Everything is written under
research/patient360/work/ (git-ignored), which grows to about 60 GB. Downloads skip files that already exist, so a
failed run can be started again.
"""
from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent


def steps(tissue_slides: bool) -> list[list[str]]:
    plan = [["download_sources.py"], ["download_imaging.py"]]
    if tissue_slides:
        plan.append(["download_imaging.py", "--tissue-slides"])
    plan += [["fetch_clinical_genomics.py"], ["build_synthea.py"], ["build_slides.py"]]
    if tissue_slides:
        plan.append(["build_slides.py", "--tissue"])
    plan += [["build_radiology.py"], ["build_tables.py"]]
    return plan


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tissue-slides", action="store_true", help="also download and tile the frozen sections")
    args = ap.parse_args()
    for script, *opts in steps(args.tissue_slides):
        print(f"=== {script} {' '.join(opts)}".rstrip(), flush=True)
        if subprocess.run([sys.executable, "-u", str(HERE / script), *opts], cwd=HERE.parent).returncode:
            raise SystemExit(f"{script} failed; fix the cause and run this again")
    print("=== done. Next: .venv/bin/python scripts/26_patient360_import.py --from-local")


if __name__ == "__main__":
    main()
