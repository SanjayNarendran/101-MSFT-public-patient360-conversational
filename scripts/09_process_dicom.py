"""Rewrites the source DICOM files for the ONLINE PACS studies and archives them in OneLake. Runs locally.

For each job (one source series) in data/generated/pacs/jobs.csv:
  1. download the series (IDC public S3 bucket via s5cmd, or the Synthea Coherent bucket over HTTPS)
  2. rewrite the headers: patient identity (MRN, name, birth date, sex, age), accession number, study date and time,
     study description, referring physician and institution from the Epic-style records; research identifiers
     (LIDC/TCGA barcodes, clinical-trial and de-identification attributes, private tags) are removed. UIDs are kept,
     so LIDC SEG/SR objects still reference their CT images.
  3. upload to the imaging archive lakehouse (LAKEHOUSE_IMAGING, Bronze_ImagingArchive): Files/dicom/<StudyInstanceUID>/<SeriesInstanceUID>/<SOPInstanceUID>.dcm
  4. write the instance index to data/generated/pacs/instances/<job>.parquet (also the "done" marker)

Resumable: finished jobs are skipped. Usage: 09_process_dicom.py [--collection lidc_idri] [--workers 8] [--limit N]
"""
import argparse
import base64
import json
import shutil
import subprocess
import sys
import time
import uuid
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path

import pandas as pd
import pydicom
import requests
from pydicom.valuerep import VR

from common import DATA, GEN_DIR, fabric, fabric_list, load_state, save_state, settings

PACS_DIR = GEN_DIR / "pacs"
INDEX_DIR = PACS_DIR / "instances"
WORK_DIR = DATA / "work"
BLOB = "https://onelake.blob.fabric.microsoft.com"
BLOCK = 32 * 1024 * 1024
S5CMD = str(Path(sys.executable).with_name("s5cmd"))
TEXT_VRS = {VR.LO, VR.SH, VR.LT, VR.ST, VR.UT, VR.PN, VR.CS, VR.UC}
REMOVE = ["OtherPatientIDs", "OtherPatientIDsSequence", "OtherPatientNames", "PatientIdentityRemoved",
          "DeidentificationMethod", "DeidentificationMethodCodeSequence", "PatientComments", "InstitutionAddress",
          "InstitutionalDepartmentName", "OperatorsName", "PerformingPhysicianName", "RequestingPhysician",
          "PatientAddress", "PatientTelephoneNumbers", "EthnicGroup"]
DATE_TAGS = ["SeriesDate", "AcquisitionDate", "ContentDate", "InstanceCreationDate", "PerformedProcedureStepStartDate"]
TIME_TAGS = ["SeriesTime", "AcquisitionTime", "ContentTime", "InstanceCreationTime", "PerformedProcedureStepStartTime"]


# --- OneLake ------------------------------------------------------------------------------------

_token = {}


def storage_token():
    if not _token or _token["expires"] < time.time() + 600:
        out = subprocess.run(["az", "account", "get-access-token", "--resource", "https://storage.azure.com", "-o", "json"],
                             check=True, capture_output=True, text=True).stdout
        data = json.loads(out)
        _token.update(value=data["accessToken"], expires=int(data.get("expires_on", time.time() + 3000)))
    return _token["value"]


def _headers(extra=None):
    h = {"Authorization": f"Bearer {storage_token()}", "x-ms-version": "2023-11-03"}
    h.update(extra or {})
    return h


def _request(method, url, **kw):
    for attempt in range(8):
        try:
            resp = requests.request(method, url, timeout=600, **kw)
            if resp.status_code < 300:
                return resp
            if resp.status_code not in (408, 409, 429, 500, 502, 503, 504):
                raise RuntimeError(f"{method} {url} -> {resp.status_code}: {resp.text[:300]}")
        except requests.RequestException:
            pass
        time.sleep(min(60, 2 ** attempt))
        kw.get("headers", {}).update(_headers())
    raise RuntimeError(f"{method} {url} failed after retries")


def upload(path: Path, url: str):
    size = path.stat().st_size
    if size <= BLOCK:
        _request("PUT", url, data=path.read_bytes(), headers=_headers(
            {"x-ms-blob-type": "BlockBlob", "x-ms-blob-content-type": "application/dicom"}))
        return
    ids = []
    with open(path, "rb") as f:
        n = 0
        while chunk := f.read(BLOCK):
            block_id = uuid.uuid5(uuid.NAMESPACE_URL, f"{url}#{n}").hex
            ids.append(block_id)
            b64 = base64.b64encode(block_id.encode()).decode()
            _request("PUT", f"{url}?comp=block&blockid={b64}", data=chunk, headers=_headers())
            n += 1
    body = "<?xml version='1.0' encoding='utf-8'?><BlockList>" + "".join(
        f"<Latest>{base64.b64encode(i.encode()).decode()}</Latest>" for i in ids) + "</BlockList>"
    _request("PUT", f"{url}?comp=blocklist", data=body.encode(), headers=_headers(
        {"x-ms-blob-content-type": "application/dicom", "Content-Type": "application/xml"}))


# --- DICOM ------------------------------------------------------------------------------------------

def age_string(birth: str, study: str) -> str:
    b, s = date.fromisoformat(birth), date.fromisoformat(study)
    years = s.year - b.year - ((s.month, s.day) < (b.month, b.day))
    return f"{max(years, 0):03d}Y"


def rewrite(ds: pydicom.Dataset, job: dict, source_ids: set):
    study_dt = pd.Timestamp(job["StudyDateTime"])
    study_date, study_time = study_dt.strftime("%Y%m%d"), study_dt.strftime("%H%M%S")
    specimen = f"{job['AccessionNumber']}-A1"

    ds.remove_private_tags()
    for elem in list(ds):
        if elem.tag.group == 0x0012:
            del ds[elem.tag]
    for kw in REMOVE:
        if kw in ds:
            delattr(ds, kw)

    def scrub(dataset, elem):
        if elem.VR in TEXT_VRS and isinstance(elem.value, str):
            value = elem.value
            for sid in source_ids:
                value = value.replace(sid, specimen)
            if value != elem.value:
                elem.value = value
    ds.walk(scrub)

    ds.PatientName = job["PatientName"]
    ds.PatientID = job["PatientID"]
    ds.IssuerOfPatientID = job["IssuerOfPatientID"]
    ds.PatientBirthDate = job["PatientBirthDate"].replace("-", "")
    ds.PatientSex = job["PatientSex"]
    ds.PatientAge = age_string(job["PatientBirthDate"], study_dt.strftime("%Y-%m-%d"))
    ds.AccessionNumber = job["AccessionNumber"]
    ds.StudyDate, ds.StudyTime = study_date, study_time
    ds.StudyDescription = job["StudyDescription"]
    ds.ReferringPhysicianName = job["ReferringPhysicianName"]
    ds.InstitutionName = job["InstitutionName"]
    ds.StudyID = job["StudyID"]
    for kw in DATE_TAGS:
        if kw in ds:
            setattr(ds, kw, study_date)
    for kw in TIME_TAGS:
        if kw in ds:
            setattr(ds, kw, study_time)
    if "AcquisitionDateTime" in ds:
        ds.AcquisitionDateTime = study_date + study_time
    if "ContainerIdentifier" in ds:
        ds.ContainerIdentifier = specimen
    if job["SourceCollection"] == "synthea_coherent":
        # Coherent MRIs are multi-frame secondary captures (Modality OT); label them as the MR brain volume they are
        ds.Modality, ds.BodyPartExamined = "MR", "HEAD"
        ds.SeriesDescription = ds.get("SeriesDescription") or "3D T1 brain volume"


def instance_row(ds, job, size, onelake_path):
    def get(kw, default=None):
        value = ds.get(kw, default)
        return default if value is None or value == "" else value
    ipp = get("ImagePositionPatient")
    spacing = get("PixelSpacing")
    return {
        "SOPInstanceUID": ds.SOPInstanceUID, "SOPClassUID": ds.SOPClassUID, "SeriesInstanceUID": ds.SeriesInstanceUID,
        "StudyInstanceUID": ds.StudyInstanceUID, "AccessionNumber": job["AccessionNumber"], "Modality": get("Modality"),
        "SeriesNumber": get("SeriesNumber"), "SeriesDescription": get("SeriesDescription"),
        "BodyPartExamined": get("BodyPartExamined"), "Manufacturer": get("Manufacturer"),
        "ManufacturerModelName": get("ManufacturerModelName"), "InstanceNumber": get("InstanceNumber"),
        "Rows": get("Rows"), "Columns": get("Columns"), "NumberOfFrames": int(get("NumberOfFrames", 1) or 1),
        "TotalPixelMatrixColumns": get("TotalPixelMatrixColumns"), "TotalPixelMatrixRows": get("TotalPixelMatrixRows"),
        "ImageType": "\\".join(get("ImageType", [])) or None, "BitsAllocated": get("BitsAllocated"),
        "PhotometricInterpretation": get("PhotometricInterpretation"),
        "TransferSyntaxUID": str(ds.file_meta.TransferSyntaxUID), "SliceThickness": get("SliceThickness"),
        "PixelSpacing": float(spacing[0]) if spacing else None, "ImagePositionZ": float(ipp[2]) if ipp else None,
        "ContentDate": get("ContentDate"), "FileSizeBytes": size, "OneLakePath": onelake_path,
        "SourceCollection": job["SourceCollection"]}


def download(job, folder: Path):
    folder.mkdir(parents=True, exist_ok=True)
    if job["source"] == "s3":
        subprocess.run([S5CMD, "--no-sign-request", "--numworkers", "16", "--retry-count", "10", "cp", job["url"],
                        f"{folder}/"], check=True, capture_output=True)
    else:
        with requests.get(job["url"], stream=True, timeout=600) as resp:
            resp.raise_for_status()
            with open(folder / "source.dcm", "wb") as f:
                for chunk in resp.iter_content(chunk_size=1 << 20):
                    f.write(chunk)


def process_job(job: dict, ws_id: str, lh_id: str) -> tuple[str, int, int]:
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    marker = INDEX_DIR / f"{job['job_id']}.parquet"
    if marker.exists():
        return job["job_id"], 0, 0
    work = WORK_DIR / job["job_id"]
    shutil.rmtree(work, ignore_errors=True)
    src, out = work / "src", work / "out"
    out.mkdir(parents=True, exist_ok=True)
    download(job, src)
    source_ids = {x for x in (job.get("SOURCE_PATIENT_ID"),) if isinstance(x, str) and x}

    rows, uploads = [], []
    for path in sorted(src.rglob("*")):
        if not path.is_file():
            continue
        ds = pydicom.dcmread(path)
        if not source_ids and ds.get("PatientID"):
            source_ids = {str(ds.PatientID)}
        source_ids |= {str(ds.PatientID)} if ds.get("PatientID") else set()
        rewrite(ds, job, {s for s in source_ids if len(s) > 3})
        rel = f"dicom/{ds.StudyInstanceUID}/{ds.SeriesInstanceUID}/{ds.SOPInstanceUID}.dcm"
        target = out / f"{ds.SOPInstanceUID}.dcm"
        ds.save_as(target)
        size = target.stat().st_size
        rows.append(instance_row(ds, job, size, f"Files/{rel}"))
        uploads.append((target, f"{BLOB}/{ws_id}/{lh_id}/Files/{rel}"))
        path.unlink()

    with ThreadPoolExecutor(16) as pool:
        for f in [pool.submit(upload, p, u) for p, u in uploads]:
            f.result()
    tmp = marker.with_suffix(".tmp")
    pd.DataFrame(rows).to_parquet(tmp, index=False)
    tmp.rename(marker)
    shutil.rmtree(work, ignore_errors=True)
    return job["job_id"], len(rows), sum(r["FileSizeBytes"] for r in rows)


def ensure_lakehouse() -> tuple[str, str]:
    state = load_state()
    ws_id, name = state["workspace_id"], settings()["LAKEHOUSE_IMAGING"]
    lh = next((x for x in fabric_list(f"/workspaces/{ws_id}/lakehouses") if x["displayName"] == name), None)
    if lh is None:
        lh = fabric("POST", f"/workspaces/{ws_id}/lakehouses", {
            "displayName": name, "description": "PACS image archive: raw DICOM files referenced by the PACS SQL database."})
        print(f"Created lakehouse {name}")
    save_state(lakehouses={**state["lakehouses"], name: lh["id"]})
    return ws_id, lh["id"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--collection", action="append", help="limit to source collections (repeatable)")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    settings()
    ws_id, lh_id = ensure_lakehouse()
    jobs = pd.read_csv(PACS_DIR / "jobs.csv", dtype=str)
    studies = pd.read_csv(PACS_DIR / "studies.csv", dtype=str, usecols=["AccessionNumber", "SOURCE_PATIENT_ID"])
    jobs = jobs.merge(studies, on="AccessionNumber", how="left")
    if args.collection:
        jobs = jobs[jobs.SourceCollection.isin(args.collection)]
    done = {p.stem for p in INDEX_DIR.glob("*.parquet")} if INDEX_DIR.exists() else set()
    todo = jobs[~jobs.job_id.isin(done)]
    if args.limit:
        todo = todo.head(args.limit)
    total_mb = pd.to_numeric(todo.size_MB).sum()
    print(f"{len(jobs) - len(todo):,} of {len(jobs):,} series already archived; processing {len(todo):,} "
          f"({total_mb / 1024:.1f} GB) with {args.workers} workers")

    started, done_mb, done_n, failures = time.time(), 0.0, 0, []
    sizes = dict(zip(todo.job_id, pd.to_numeric(todo.size_MB)))
    with ProcessPoolExecutor(args.workers) as pool:
        futures = {pool.submit(process_job, job, ws_id, lh_id): job["job_id"] for job in todo.to_dict("records")}
        for future in as_completed(futures):
            job_id = futures[future]
            try:
                future.result()
                done_n += 1
                done_mb += sizes[job_id]
            except Exception as exc:
                failures.append(job_id)
                print(f"  FAILED {job_id}: {exc}", flush=True)
            if done_n % 50 == 0 or done_n == len(todo):
                rate = done_mb / max(1, time.time() - started)
                eta = (total_mb - done_mb) / max(rate, 0.01) / 60
                print(f"  {done_n:,}/{len(todo):,} series, {done_mb / 1024:.1f} GB, {rate:.1f} MB/s, "
                      f"ETA {eta:.0f} min", flush=True)
    if failures:
        raise SystemExit(f"{len(failures)} series failed; rerun to retry them")
    print("All series archived")


if __name__ == "__main__":
    main()
