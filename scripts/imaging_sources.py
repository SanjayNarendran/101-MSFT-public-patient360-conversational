"""Metadata for the imaging sources, from NCI Imaging Data Commons (idc-index) and the Synthea Coherent bucket.

lidc_series.csv     every LIDC-IDRI series (CT, CR, DX, SEG, SR), CC BY 3.0
tcga_slides.csv     smallest slide-microscopy series per TCGA patient (LUAD, LUSC, BRCA, COAD, PRAD), CC BY 3.0,
                    joined with the TCGA clinical data used to match patients and write pathology reports
coherent_dicom.csv  the 298 Synthea Coherent brain MRI files (CC BY 4.0)
"""
import re
import xml.etree.ElementTree as ET

import pandas as pd
import requests

from common import DATA

IMAGING_RAW = DATA / "raw" / "imaging"
TCGA_COLLECTIONS = ["tcga_luad", "tcga_lusc", "tcga_brca", "tcga_coad", "tcga_prad"]
TCGA_CLINICAL = ["gender", "age_at_diagnosis", "histological_type", "icd_o_3_histology", "icd_10", "tumor_tissue_site",
                 "anatomic_neoplasm_subdivision", "pathologic_stage", "pathologic_T", "pathologic_N", "pathologic_M",
                 "neoplasm_histologic_grade", "gleason_score_combined", "psa_value", "number_of_lymphnodes_examined",
                 "number_of_lymphnodes_positive_by_he", "lymphovascular_invasion_present", "venous_invasion",
                 "residual_tumor", "tobacco_smoking_history"]
COHERENT_BUCKET = "https://synthea-open-data.s3.amazonaws.com"
SERIES_COLUMNS = """collection_id, PatientID, PatientSex, PatientAge, StudyInstanceUID, SeriesInstanceUID, Modality,
    SeriesDescription, SeriesNumber, BodyPartExamined, Manufacturer, ManufacturerModelName, SOPClassUID, instanceCount,
    series_size_MB, series_aws_url, license_short_name, source_DOI"""


def client():
    from idc_index import IDCClient
    return IDCClient()


def lidc_series(c) -> pd.DataFrame:
    return c.sql_query(f"SELECT {SERIES_COLUMNS} FROM index WHERE collection_id = 'lidc_idri' "
                       "ORDER BY PatientID, StudyInstanceUID, Modality, SeriesInstanceUID")


def tcga_slides(c) -> pd.DataFrame:
    collections = ", ".join(f"'{x}'" for x in TCGA_COLLECTIONS)
    slides = c.sql_query(f"""
        SELECT {SERIES_COLUMNS} FROM index
        WHERE Modality = 'SM' AND collection_id IN ({collections}) AND license_short_name = 'CC BY 3.0'
        QUALIFY ROW_NUMBER() OVER (PARTITION BY collection_id, PatientID ORDER BY series_size_MB, SeriesInstanceUID) = 1
        ORDER BY collection_id, PatientID""")
    c.fetch_index("clinical_index")
    clinical = []
    for coll in TCGA_COLLECTIONS:
        t = c.get_clinical_table(f"{coll}_clinical")
        t = t[["dicom_patient_id"] + [col for col in TCGA_CLINICAL if col in t.columns]].copy()
        t["collection_id"] = coll
        clinical.append(t)
    clinical = pd.concat(clinical).drop_duplicates(["collection_id", "dicom_patient_id"])
    return slides.merge(clinical, left_on=["collection_id", "PatientID"],
                        right_on=["collection_id", "dicom_patient_id"], how="inner").drop(columns="dicom_patient_id")


def coherent_dicom() -> pd.DataFrame:
    resp = requests.get(f"{COHERENT_BUCKET}/?list-type=2&prefix=coherent/unzipped/dicom/", timeout=120)
    resp.raise_for_status()
    ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
    rows = []
    pattern = re.compile(r"^(?P<first>.+?)_(?P<last>.+?)_(?P<pid>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
                         r"(?P<study>1\.2\.840\..+)\.dcm$")
    for item in ET.fromstring(resp.content).findall("s3:Contents", ns):
        key = item.find("s3:Key", ns).text
        m = pattern.match(key.rsplit("/", 1)[-1])
        if m:
            rows.append({"synthea_patient_id": m["pid"], "study_uid": m["study"], "key": key,
                         "url": f"{COHERENT_BUCKET}/{key}", "size_bytes": int(item.find("s3:Size", ns).text)})
    return pd.DataFrame(rows).sort_values("key").reset_index(drop=True)


def download_lidc_annotations(c, series: pd.DataFrame):
    for modality, folder in (("SR", "lidc_sr"), ("SEG", "lidc_seg")):
        uids = series.loc[series.Modality == modality, "SeriesInstanceUID"].tolist()
        target = DATA / "raw" / folder
        target.mkdir(parents=True, exist_ok=True)
        have = sum(1 for _ in target.rglob("*.dcm"))
        if have >= len(uids):
            print(f"  LIDC {modality}: {have:,} files already downloaded")
            continue
        print(f"  downloading {len(uids):,} LIDC {modality} series")
        c.download_from_selection(seriesInstanceUID=uids, downloadDir=str(target),
                                  dirTemplate="%PatientID/%SeriesInstanceUID", quiet=True, show_progress_bar=False)
