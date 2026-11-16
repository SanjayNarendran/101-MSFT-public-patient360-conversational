"""Downloads the public source data into data/raw (nothing here is committed):

- Synthea Coherent Data Set CSVs (CC BY 4.0, The MITRE Corporation) from the AWS Open Data bucket
- imaging source metadata from NCI Imaging Data Commons: LIDC-IDRI series, TCGA slide microscopy + clinical data
  (CC BY 3.0), and the list of Coherent brain MRI files (CC BY 4.0)
- the LIDC-IDRI nodule annotations (DICOM SR + SEG, about 3.3 GB), parsed into data/raw/imaging/lidc_nodules.csv

No AWS or GCP account is needed. Re-running skips files that are already present.
"""
import requests

import imaging_sources as src
import lidc
from common import DATA, RAW_DIR

BASE = "https://synthea-open-data.s3.amazonaws.com/coherent/unzipped/csv"
FILES = ["patients", "encounters", "conditions", "procedures", "medications", "observations",
         "imaging_studies", "providers", "organizations"]


def download_coherent():
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        url, path = f"{BASE}/{name}.csv", RAW_DIR / f"{name}.csv"
        size = int(requests.head(url, timeout=60).headers["Content-Length"])
        if path.exists() and path.stat().st_size == size:
            print(f"  {name}.csv already downloaded")
            continue
        print(f"  downloading {name}.csv ({size / 1e6:.0f} MB)")
        with requests.get(url, stream=True, timeout=600) as resp:
            resp.raise_for_status()
            with open(path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=1 << 20):
                    f.write(chunk)


def imaging_metadata():
    src.IMAGING_RAW.mkdir(parents=True, exist_ok=True)
    c = src.client()
    print(f"  IDC data version {c.get_idc_version()}")
    series = src.lidc_series(c)
    series.to_csv(src.IMAGING_RAW / "lidc_series.csv", index=False)
    print(f"  LIDC-IDRI: {series.PatientID.nunique():,} patients, {len(series):,} series, "
          f"{series.series_size_MB.sum() / 1024:.1f} GB")
    slides = src.tcga_slides(c)
    slides.to_csv(src.IMAGING_RAW / "tcga_slides.csv", index=False)
    print(f"  TCGA slides (smallest per patient): {len(slides):,} patients, {slides.series_size_MB.sum() / 1024:.1f} GB")
    mri = src.coherent_dicom()
    mri.to_csv(src.IMAGING_RAW / "coherent_dicom.csv", index=False)
    print(f"  Coherent MRI: {len(mri):,} files, {mri.size_bytes.sum() / 1e9:.1f} GB")

    src.download_lidc_annotations(c, series)
    ann, nodules = lidc.build(DATA / "raw" / "lidc_sr", DATA / "raw" / "lidc_seg")
    ann.to_csv(src.IMAGING_RAW / "lidc_annotations.csv", index=False)
    nodules.to_csv(src.IMAGING_RAW / "lidc_nodules.csv", index=False)
    print(f"  LIDC nodules: {len(ann):,} reader annotations -> {len(nodules):,} nodules")


if __name__ == "__main__":
    print("Synthea Coherent CSVs")
    download_coherent()
    print("Imaging sources")
    imaging_metadata()
