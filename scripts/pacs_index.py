"""The PACS index (patients, studies, series, instances, nodule findings) built from the local stage 2 outputs.

Used by 10_pacs_database.py to load the Bronze_PACS SQL database and by the OMOP ETL, which reads the same tables
locally instead of from the database. Columns are renamed to the database names by named_tables().
"""
import glob

import numpy as np
import pandas as pd

from common import GEN_DIR, load_state, settings
from imaging_sources import IMAGING_RAW

PACS_DIR = GEN_DIR / "pacs"
SOP_CLASSES = {
    "1.2.840.10008.5.1.4.1.1.2": "CT Image Storage", "1.2.840.10008.5.1.4.1.1.1": "Computed Radiography Image Storage",
    "1.2.840.10008.5.1.4.1.1.1.1": "Digital X-Ray Image Storage - For Presentation",
    "1.2.840.10008.5.1.4.1.1.7.3": "Multi-frame Grayscale Word Secondary Capture Image Storage",
    "1.2.840.10008.5.1.4.1.1.77.1.6": "VL Whole Slide Microscopy Image Storage",
    "1.2.840.10008.5.1.4.1.1.66.4": "Segmentation Storage", "1.2.840.10008.5.1.4.1.1.88.34": "Comprehensive 3D SR Storage",
    "1.2.840.10008.5.1.4.1.1.88.22": "Enhanced SR Storage",
}


def build_tables():
    state = load_state()
    patients = pd.read_csv(PACS_DIR / "patients.csv", dtype=str)
    studies = pd.read_csv(PACS_DIR / "studies.csv", dtype=str)
    offline = pd.read_csv(PACS_DIR / "offline_series.csv", dtype=str)
    files = sorted(glob.glob(str(PACS_DIR / "instances" / "*.parquet")))
    inst = pd.concat([pd.read_parquet(f) for f in files], ignore_index=True) if files else pd.DataFrame()
    archived = set(inst.StudyInstanceUID) if len(inst) else set()

    archive = settings()["LAKEHOUSE_IMAGING"]
    ws_id, lh_id = state["workspace_id"], state["lakehouses"][archive]
    stores = pd.DataFrame([
        (1, archive, "OneLake", f"https://onelake.dfs.fabric.microsoft.com/{ws_id}/{lh_id}/Files/",
         f"Online archive: DICOM files in the {archive} lakehouse"),
        (2, "LegacyArchive", "Offline", None, "Studies migrated from the legacy PACS; pixel data not retrieved")],
        columns=["ArchiveStoreKey", "Name", "StorageType", "BaseUrl", "Description"])

    patients = patients.sort_values("PatientID").reset_index(drop=True)
    patients.insert(0, "PatientKey", np.arange(1, len(patients) + 1))
    pkey = patients.set_index("PatientID").PatientKey

    # Studies planned as ONLINE but not (yet) archived are reported OFFLINE so the index always matches the files
    studies["InstanceAvailability"] = np.where(studies.StudyInstanceUID.isin(archived), "ONLINE", "OFFLINE")
    studies = studies.sort_values(["StudyDateTime", "AccessionNumber"]).reset_index(drop=True)
    studies["StudyKey"] = np.arange(1, len(studies) + 1)
    skey = studies.set_index("StudyInstanceUID").StudyKey

    # Series: online series aggregated from the instance index, offline series from the plan
    if len(inst):
        on = inst.groupby("SeriesInstanceUID").agg(
            StudyInstanceUID=("StudyInstanceUID", "first"), Modality=("Modality", "first"),
            SeriesNumber=("SeriesNumber", "first"), SeriesDescription=("SeriesDescription", "first"),
            BodyPartExamined=("BodyPartExamined", "first"), Manufacturer=("Manufacturer", "first"),
            ManufacturerModelName=("ManufacturerModelName", "first"), SliceThicknessMM=("SliceThickness", "first"),
            PixelSpacingMM=("PixelSpacing", "first"), NumberOfSeriesRelatedInstances=("SOPInstanceUID", "size"),
            SeriesSizeMB=("FileSizeBytes", lambda b: round(b.sum() / 1048576, 2))).reset_index()
        on["InstanceAvailability"] = "ONLINE"
    else:
        on = pd.DataFrame()
    off = offline[~offline.StudyInstanceUID.isin(archived)].copy()
    off["InstanceAvailability"] = "OFFLINE"
    off["SeriesSizeMB"] = None
    series = pd.concat([on, off], ignore_index=True)
    series["StudyKey"] = series.StudyInstanceUID.map(skey)
    series = series[series.StudyKey.notna()].sort_values(["StudyKey", "SeriesNumber", "SeriesInstanceUID"])
    series = series.reset_index(drop=True)
    series["SeriesKey"] = np.arange(1, len(series) + 1)

    agg = series.groupby("StudyKey").agg(n_series=("SeriesKey", "size"), n_inst=("NumberOfSeriesRelatedInstances",
                                         lambda v: pd.to_numeric(v).sum()),
                                         mb=("SeriesSizeMB", lambda v: pd.to_numeric(v).sum(min_count=1)),
                                         mods=("Modality", lambda v: "\\".join(sorted(set(v.dropna())))))
    studies = studies.join(agg, on="StudyKey")
    studies["PatientKey"] = studies.PatientID.map(pkey)
    studies["ArchiveStoreKey"] = np.where(studies.InstanceAvailability == "ONLINE", 1, 2)
    received = pd.to_datetime(studies.StudyDateTime) + pd.to_timedelta(
        (studies.StudyKey % 50 + 10).astype(int), unit="m")
    studies["ReceivedDateTime"] = received.dt.strftime("%Y-%m-%d %H:%M:%S")

    study_cols = ["StudyKey", "StudyInstanceUID", "PatientKey", "AccessionNumber", "StudyDateTime", "StudyDescription",
                  "mods", "BodyPartExamined", "ReferringPhysicianName", "InstitutionName", "StudyID", "n_series",
                  "n_inst", "mb", "InstanceAvailability", "ArchiveStoreKey", "ReceivedDateTime", "SourceCollection",
                  "SourceDOI", "SourceLicense"]
    series_cols = ["SeriesKey", "SeriesInstanceUID", "StudyKey", "Modality", "SeriesNumber", "SeriesDescription",
                   "BodyPartExamined", "Manufacturer", "ManufacturerModelName", "SliceThicknessMM", "PixelSpacingMM",
                   "NumberOfSeriesRelatedInstances", "SeriesSizeMB", "InstanceAvailability"]

    if len(inst):
        inst = inst.merge(series[["SeriesInstanceUID", "SeriesKey"]], on="SeriesInstanceUID")
        inst = inst.sort_values(["SeriesKey", "InstanceNumber", "SOPInstanceUID"]).reset_index(drop=True)
        inst["InstanceKey"] = np.arange(1, len(inst) + 1)
        inst["SOPClassName"] = inst.SOPClassUID.map(SOP_CLASSES)
        inst["ArchiveStoreKey"] = 1
    inst_cols = ["InstanceKey", "SOPInstanceUID", "SeriesKey", "SOPClassUID", "SOPClassName", "InstanceNumber", "Rows",
                 "Columns", "NumberOfFrames", "TotalPixelMatrixRows", "TotalPixelMatrixColumns", "ImageType",
                 "PhotometricInterpretation", "BitsAllocated", "TransferSyntaxUID", "ImagePositionZ", "FileSizeBytes",
                 "ArchiveStoreKey", "OneLakePath"]

    nod = pd.read_csv(IMAGING_RAW / "lidc_nodules.csv")
    nod = nod[nod.study_uid.isin(archived)].copy()
    nod["StudyKey"] = nod.study_uid.map(skey)
    nod["SeriesKey"] = nod.ct_series_uid.map(series.set_index("SeriesInstanceUID").SeriesKey)
    nod = nod.sort_values(["StudyKey", "nodule"]).reset_index(drop=True)
    nod["NoduleFindingKey"] = np.arange(1, len(nod) + 1)
    nod_cols = ["NoduleFindingKey", "StudyKey", "SeriesKey", "nodule", "readers", "diameter_mm", "max_diameter_mm",
                "volume_mm3", "texture", "margin", "shape", "calcification", "malignancy", "spiculation", "side", "lobe"]

    return [("pacs.ArchiveStore", stores, list(stores.columns)),
            ("pacs.Patient", patients, ["PatientKey", "PatientID", "IssuerOfPatientID", "PatientName",
                                        "PatientBirthDate", "PatientSex"]),
            ("pacs.Study", studies, study_cols), ("pacs.Series", series, series_cols),
            ("pacs.Instance", inst, inst_cols), ("pacs.NoduleFinding", nod, nod_cols)]


# Generator column names that differ from the Bronze_PACS column names
DB_NAMES = {
    "pacs.Study": {"mods": "ModalitiesInStudy", "n_series": "NumberOfStudyRelatedSeries",
                   "n_inst": "NumberOfStudyRelatedInstances", "mb": "StudySizeMB"},
    "pacs.Instance": {"OneLakePath": "StoragePath"},
    "pacs.NoduleFinding": {"nodule": "NoduleLabel", "readers": "ReaderCount", "diameter_mm": "DiameterMM",
                           "max_diameter_mm": "MaxDiameterMM", "volume_mm3": "VolumeMM3", "texture": "Texture",
                           "margin": "Margin", "shape": "Shape", "calcification": "Calcification",
                           "malignancy": "MalignancyScore", "spiculation": "SpiculationScore", "side": "Laterality",
                           "lobe": "Lobe"},
}


def named_tables(skip=("pacs.Instance",)) -> dict[str, pd.DataFrame]:
    """The PACS tables keyed by short name (Study, Series, ...) with the same columns as Bronze_PACS."""
    return {name.split(".")[1]: df[cols].rename(columns=DB_NAMES.get(name, {}))
            for name, df, cols in build_tables() if name not in skip}
