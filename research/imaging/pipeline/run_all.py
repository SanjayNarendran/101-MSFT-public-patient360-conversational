"""Download and build the six showcase studies that scripts/30_patient360_showcase.py adds to two demo patients.

    .venv/bin/python research/imaging/pipeline/run_all.py [--cycif-half | --skip-cycif]

  breast-brca         TCGA breast cancer slide (TCGA-AC-A4ZE) with its case, report and AI layers   0.5 GB
  colon-cycif         HTAN CyCIF colon cancer slide, 36 markers                                    49 GB (12.8 GB with --cycif-half)
  petct-whole-body    TCIA FDG-PET-CT-Lesions whole-body PET/CT                                      0.6 GB
  lung-4dct           TCIA 4D-Lung planning 4D CT with its contours                                  0.7 GB
  brain-tractography  HCP1065 tractography atlas on the ICBM 2009a template                          1.1 GB
  fetal-brain-atlas   dHCP fetal brain atlas, 21 to 36 weeks (with the KCL body and face atlases)    0.15 GB

Everything is written under research/imaging/work/ (git-ignored); the built studies add about 4 GB. Each step is
a script you could run by hand, run with this interpreter; the first failure stops the run. Downloads skip files that
already exist, so a failed run can be started again. --skip-cycif leaves the CyCIF slide out; 30 then adds five studies.
"""
from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
BREAST = ["--only", "breast-brca"]


def steps(cycif: bool, half: bool) -> list[list[str]]:
    plan = [
        ["download_slides.py", *BREAST],
        ["download_data.py", "petct", "lung4d", "tracts", "fetal"],
        ["build_cases.py", "fetch", *BREAST],
    ]
    if cycif:
        plan.append(["dicom/download_dicom.py", "--only", "cycif", *(["--cycif-half"] if half else [])])
    plan += [
        ["generate_tiles.py", *BREAST],
        ["build_cases.py", "tile", *BREAST],
        ["build_cases.py", "overlays", *BREAST],
        ["build_cases.py", "assemble", *BREAST],
    ]
    if cycif:
        plan.append(["build_multiplex.py"])
    plan += [
        ["generate_tiles.py", "--only", "none"],  # the slide catalog again, with the case and the CyCIF slide
        ["volumes/build_petct.py"],
        ["volumes/build_lung4d.py"],
        ["volumes/build_tractography.py"],
        ["volumes/build_fetal_atlas.py"],
        ["volumes/build_mip.py"],
        ["volumes/build_manifest.py"],
    ]
    return plan


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    size = ap.add_mutually_exclusive_group()
    size.add_argument("--cycif-half", action="store_true", help="the CyCIF slide at half resolution (12.8 GB download)")
    size.add_argument("--skip-cycif", action="store_true", help="leave the CyCIF slide out")
    args = ap.parse_args()
    for script, *opts in steps(not args.skip_cycif, args.cycif_half):
        print(f"=== {script} {' '.join(opts)}".rstrip(), flush=True)
        if subprocess.run([sys.executable, "-u", str(HERE / script), *opts], cwd=HERE.parent).returncode:
            raise SystemExit(f"{script} failed; fix the cause and run this again")
    print("=== done. Next: .venv/bin/python scripts/30_patient360_showcase.py --from-local")


if __name__ == "__main__":
    main()
