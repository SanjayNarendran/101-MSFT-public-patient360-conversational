"""Plans the PACS: one DICOM study per imaging or pathology order (Clarity ORDER_RAD_ACC_NUM).

Studies with source images (LIDC-IDRI, TCGA, Synthea Coherent MRI) are ONLINE; the DICOM files are rewritten and
archived by 09_process_dicom.py. All other studies are indexed as OFFLINE (DICOM InstanceAvailability), i.e.
held in a legacy archive, with plausible series metadata but no pixel data.

Outputs in data/generated/pacs/: patients.csv, studies.csv, offline_series.csv, jobs.csv (one job per source series)
"""
import uuid

import numpy as np
import pandas as pd

from common import GEN_DIR
from imaging_sources import IMAGING_RAW

PACS_DIR = GEN_DIR / "pacs"
NS = uuid.UUID("6d1f2c3a-8b4e-4a5f-9c7d-2e1b0a9f8c76")
ISSUER = "CONTOSO_MRN"
# Source DOIs as recorded by NCI Imaging Data Commons (TCGA slides are IDC's DICOM conversions on Zenodo)
SOURCES = {
    "lidc_idri": ("LIDC-IDRI", "https://doi.org/10.7937/K9/TCIA.2015.LO9QL9SX", "CC BY 3.0"),
    "tcga_luad": ("TCGA-LUAD", "https://doi.org/10.5281/zenodo.12689915", "CC BY 3.0"),
    "tcga_lusc": ("TCGA-LUSC", "https://doi.org/10.5281/zenodo.12690008", "CC BY 3.0"),
    "tcga_brca": ("TCGA-BRCA", "https://doi.org/10.5281/zenodo.12689962", "CC BY 3.0"),
    "tcga_coad": ("TCGA-COAD", "https://doi.org/10.5281/zenodo.12689970", "CC BY 3.0"),
    "tcga_prad": ("TCGA-PRAD", "https://doi.org/10.5281/zenodo.12689935", "CC BY 3.0"),
    "synthea_coherent": ("Synthea Coherent Data Set", "https://doi.org/10.3390/electronics11081199", "CC BY 4.0"),
}

# BodyPartExamined (DICOM defined terms) by order description keyword, then by Clarity body site
BODY_PART_BY_DESC = [("MAMMO", "BREAST"), ("BREAST", "BREAST"), ("FETAL", "PELVIS"), ("BONE DENSITY", "HIP"),
                     ("ECHO", "HEART"), ("CHEST AND ABDOMEN", "CHEST"), ("CHEST", "CHEST"), ("BRAIN", "HEAD"),
                     ("HEAD", "HEAD"), ("ABDOMEN", "ABDOMEN")]
BODY_PART_BY_SITE = {"Chest": "CHEST", "Head": "HEAD", "Heart": "HEART", "Abdomen": "ABDOMEN", "Ankle": "ANKLE",
                     "Arm": "HUMERUS", "Clavicle": "CLAVICLE", "Knee": "KNEE", "Pelvis": "PELVIS", "Wrist": "WRIST",
                     "Lung": "LUNG", "Breast": "BREAST", "Colon": "COLON", "Prostate": "PROSTATE"}

# Offline series templates: (series description, min instances, max instances)
OFFLINE_SERIES = {
    "CT": [("Topogram", 1, 2), ("Axial 1.25 mm lung", 220, 320), ("Axial 5 mm mediastinum", 55, 75),
           ("Coronal MPR", 80, 120)],
    "MR": [("Sag T1", 22, 26), ("Ax T2 FSE", 24, 30), ("Ax FLAIR", 24, 30), ("Ax DWI", 48, 60), ("Ax SWI", 60, 90)],
    "CR": [("Chest PA", 1, 1), ("Chest Lateral", 1, 1)],
    "DX": [("AP", 1, 1), ("Lateral", 1, 1), ("Oblique", 1, 1)],
    "MG": [("R CC", 1, 1), ("L CC", 1, 1), ("R MLO", 1, 1), ("L MLO", 1, 1)],
    "US": [("Ultrasound", 18, 60)],
    "BMD": [("DXA Hip", 1, 1), ("DXA Lumbar Spine", 1, 1)],
}
VENDORS = {
    "CT": [("SIEMENS", "SOMATOM Definition Edge"), ("GE MEDICAL SYSTEMS", "Revolution CT"), ("Philips", "Ingenuity CT")],
    "MR": [("SIEMENS", "MAGNETOM Vida"), ("GE MEDICAL SYSTEMS", "SIGNA Premier"), ("Philips", "Ingenia 3.0T")],
    "CR": [("FUJIFILM Corporation", "FCR PROFECT CS")], "DX": [("Carestream Health", "DRX-Evolution Plus"),
                                                              ("SIEMENS", "Ysio Max")],
    "MG": [("HOLOGIC, Inc.", "Selenia Dimensions")], "US": [("Philips", "EPIQ 7G"), ("GE Healthcare", "Vivid E95")],
    "BMD": [("HOLOGIC", "Horizon A")],
}


def dicom_uid(*parts) -> str:
    return f"2.25.{uuid.uuid5(NS, '|'.join(map(str, parts))).int}"


def body_part(desc, site):
    for key, part in BODY_PART_BY_DESC:
        if key in str(desc):
            return part
    return BODY_PART_BY_SITE.get(site)


def person_name(clarity_name):
    if not isinstance(clarity_name, str):
        return ""
    last, _, first = clarity_name.partition(",")
    return f"{last.strip()}^{first.strip()}"


def main():
    PACS_DIR.mkdir(parents=True, exist_ok=True)
    orders = pd.read_csv(GEN_DIR / "crosswalk" / "imaging_orders.csv", dtype=str)
    pats = pd.read_csv(GEN_DIR / "crosswalk" / "patients.csv", dtype=str).set_index("PAT_ID")
    ser = pd.read_csv(GEN_DIR / "clarity" / "CLARITY_SER.csv.gz", dtype=str).set_index("PROV_ID")
    enc = pd.read_csv(GEN_DIR / "clarity" / "PAT_ENC.csv.gz", dtype=str, usecols=["PAT_ENC_CSN_ID", "DEPARTMENT_ID"])
    dep = pd.read_csv(GEN_DIR / "clarity" / "CLARITY_DEP.csv.gz", dtype=str).set_index("DEPARTMENT_ID")
    campus = enc.set_index("PAT_ENC_CSN_ID").DEPARTMENT_ID.map(dep.REV_LOC_NAME)

    sex = {"1": "F", "2": "M", "3": "O"}
    patients = pd.DataFrame({
        "PAT_ID": pats.index, "PatientID": pats.PAT_MRN_ID.values, "IssuerOfPatientID": ISSUER,
        "PatientName": (pats.PAT_LAST_NAME.str.upper() + "^" + pats.PAT_FIRST_NAME.str.upper()).values,
        "PatientBirthDate": pats.BIRTH_DATE.values, "PatientSex": pats.SEX_C.map(sex).values})
    patients = patients[patients.PAT_ID.isin(orders.PAT_ID)]
    patients.to_csv(PACS_DIR / "patients.csv", index=False)

    when = pd.to_datetime(orders.STUDY_DATETIME)
    online = orders.SOURCE_COLLECTION.notna()
    studies = pd.DataFrame({
        "StudyInstanceUID": np.where(online, orders.SOURCE_STUDY_UID, [dicom_uid("study", a) for a in orders.ACC_NUM]),
        "AccessionNumber": orders.ACC_NUM, "PAT_ID": orders.PAT_ID, "PatientID": orders.PAT_ID.map(pats.PAT_MRN_ID),
        "StudyDateTime": when.dt.strftime("%Y-%m-%d %H:%M:%S"), "StudyDescription": orders.DESCRIPTION,
        "Modality": orders.MODALITY.replace({"BMD": "OT"}),
        "BodyPartExamined": [body_part(d, s) for d, s in zip(orders.DESCRIPTION, orders.BODYSITE)],
        "ReferringPhysicianName": orders.AUTHRZING_PROV_ID.map(ser.PROV_NAME).map(person_name),
        "InstitutionName": orders.PAT_ENC_CSN_ID.map(campus), "StudyID": orders.ACC_NUM.str[-6:],
        "InstanceAvailability": np.where(online, "ONLINE", "OFFLINE"),
        "SourceCollection": orders.SOURCE_COLLECTION.map(lambda c: SOURCES[c][0] if isinstance(c, str) else None),
        "SourceDOI": orders.SOURCE_COLLECTION.map(lambda c: SOURCES[c][1] if isinstance(c, str) else None),
        "SourceLicense": orders.SOURCE_COLLECTION.map(lambda c: SOURCES[c][2] if isinstance(c, str) else None),
        "ORDER_PROC_ID": orders.ORDER_PROC_ID, "PAT_ENC_CSN_ID": orders.PAT_ENC_CSN_ID,
        "SOURCE_COLLECTION": orders.SOURCE_COLLECTION, "SOURCE_PATIENT_ID": orders.SOURCE_PATIENT_ID,
    })
    if studies.StudyInstanceUID.duplicated().any():
        raise SystemExit("Duplicate StudyInstanceUID in PACS plan")

    # Offline studies: synthesize series with deterministic UIDs, instance counts and equipment
    rng = np.random.default_rng(20261106)
    rows = []
    for s in studies[studies.InstanceAvailability == "OFFLINE"].itertuples():
        modality = "BMD" if s.Modality == "OT" else s.Modality
        template = OFFLINE_SERIES[modality]
        if modality == "DX":
            template = template[:2] if s.BodyPartExamined in ("CHEST", "CLAVICLE", "PELVIS") else template
        vendor = VENDORS[modality][int(rng.integers(len(VENDORS[modality])))]
        for n, (desc, lo, hi) in enumerate(template, start=1):
            if modality == "US" and s.BodyPartExamined == "HEART":
                desc = "Echo TTE"
            rows.append({"SeriesInstanceUID": dicom_uid("series", s.AccessionNumber, n),
                         "StudyInstanceUID": s.StudyInstanceUID, "Modality": s.Modality, "SeriesNumber": n,
                         "SeriesDescription": desc, "BodyPartExamined": s.BodyPartExamined,
                         "NumberOfSeriesRelatedInstances": int(rng.integers(lo, hi + 1)),
                         "Manufacturer": vendor[0], "ManufacturerModelName": vendor[1]})
    offline = pd.DataFrame(rows)
    offline.to_csv(PACS_DIR / "offline_series.csv", index=False)

    # Pipeline jobs: one per source series of every online study
    lidc = pd.read_csv(IMAGING_RAW / "lidc_series.csv", dtype=str)
    tcga = pd.read_csv(IMAGING_RAW / "tcga_slides.csv", dtype=str)
    mri = pd.read_csv(IMAGING_RAW / "coherent_dicom.csv", dtype=str)
    target = studies[studies.InstanceAvailability == "ONLINE"].merge(patients, on=["PAT_ID", "PatientID"])
    jobs = []
    for t in target.itertuples():
        if t.SOURCE_COLLECTION == "lidc_idri":
            src = lidc[lidc.StudyInstanceUID == t.StudyInstanceUID]
        elif t.SOURCE_COLLECTION.startswith("tcga_"):
            src = tcga[tcga.StudyInstanceUID == t.StudyInstanceUID]
        else:
            src = None
        base = {"StudyInstanceUID": t.StudyInstanceUID, "AccessionNumber": t.AccessionNumber, "PatientID": t.PatientID,
                "IssuerOfPatientID": ISSUER, "PatientName": t.PatientName, "PatientBirthDate": t.PatientBirthDate,
                "PatientSex": t.PatientSex, "StudyDateTime": t.StudyDateTime, "StudyDescription": t.StudyDescription,
                "ReferringPhysicianName": t.ReferringPhysicianName, "InstitutionName": t.InstitutionName,
                "StudyID": t.StudyID, "SourceCollection": t.SOURCE_COLLECTION}
        if src is None:
            f = mri[mri.study_uid == t.StudyInstanceUID].iloc[0]
            jobs.append({**base, "job_id": f"mri-{t.AccessionNumber}", "source": "http", "url": f.url,
                         "SourceSeriesUID": None, "Modality": "MR", "instances": 1,
                         "size_MB": round(int(f.size_bytes) / 1048576, 1)})
            continue
        for x in src.itertuples():
            jobs.append({**base, "job_id": x.SeriesInstanceUID, "source": "s3", "url": x.series_aws_url,
                         "SourceSeriesUID": x.SeriesInstanceUID, "Modality": x.Modality,
                         "instances": int(float(x.instanceCount)), "size_MB": round(float(x.series_size_MB), 1)})
    jobs = pd.DataFrame(jobs).sort_values(["SourceCollection", "AccessionNumber", "job_id"])
    jobs.to_csv(PACS_DIR / "jobs.csv", index=False)
    studies.to_csv(PACS_DIR / "studies.csv", index=False)

    print(f"Studies: {len(studies):,} ({online.sum():,} online, {(~online).sum():,} offline)")
    print(f"Offline series: {len(offline):,} ({offline.NumberOfSeriesRelatedInstances.sum():,} instances not archived)")
    by = jobs.groupby("SourceCollection").agg(series=("job_id", "size"), instances=("instances", "sum"),
                                             GB=("size_MB", lambda v: round(v.sum() / 1024, 1)))
    print(f"Pipeline jobs: {len(jobs):,} series, {jobs.instances.sum():,} instances, {jobs.size_MB.sum() / 1024:.1f} GB")
    print(by.to_string())


if __name__ == "__main__":
    main()
