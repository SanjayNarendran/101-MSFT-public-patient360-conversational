"""Creates the PACS database (a Fabric SQL database in the MedicalCohortDemo workspace) and loads the PACS index:
patients, studies, series and instances, plus the nodule findings from the LIDC-IDRI annotations.

ONLINE studies come from the instance index written by 09_process_dicom.py (files in the imaging archive lakehouse);
OFFLINE studies come from the planned series in data/generated/pacs/offline_series.csv. Re-running reloads all tables.
"""
import os
import sys
import time

# mssql-python needs OpenSSL; on macOS point the loader at Homebrew's copy before the driver loads.
_SSL = "/opt/homebrew/opt/openssl@3/lib"
if sys.platform == "darwin" and os.path.isdir(_SSL) and _SSL not in os.environ.get("DYLD_LIBRARY_PATH", ""):
    os.environ["DYLD_LIBRARY_PATH"] = _SSL
    os.execv(sys.executable, [sys.executable] + sys.argv)

import mssql_python  # noqa: E402
import pandas as pd  # noqa: E402

from common import fabric, fabric_list, load_state, save_state, settings  # noqa: E402
from pacs_index import build_tables  # noqa: E402

DDL = """
IF SCHEMA_ID('pacs') IS NULL EXEC('CREATE SCHEMA pacs');
DROP TABLE IF EXISTS pacs.NoduleFinding; DROP TABLE IF EXISTS pacs.Instance; DROP TABLE IF EXISTS pacs.Series;
DROP TABLE IF EXISTS pacs.Study; DROP TABLE IF EXISTS pacs.Patient; DROP TABLE IF EXISTS pacs.ArchiveStore;

CREATE TABLE pacs.ArchiveStore (
    ArchiveStoreKey INT NOT NULL PRIMARY KEY,
    Name NVARCHAR(64) NOT NULL,
    StorageType NVARCHAR(32) NOT NULL,
    BaseUrl NVARCHAR(256) NULL,
    Description NVARCHAR(256) NULL);

CREATE TABLE pacs.Patient (
    PatientKey INT NOT NULL PRIMARY KEY,
    PatientID NVARCHAR(64) NOT NULL,
    IssuerOfPatientID NVARCHAR(64) NOT NULL,
    PatientName NVARCHAR(128) NULL,
    PatientBirthDate DATE NULL,
    PatientSex CHAR(1) NULL,
    CONSTRAINT UQ_Patient_ID UNIQUE (IssuerOfPatientID, PatientID));

CREATE TABLE pacs.Study (
    StudyKey INT NOT NULL PRIMARY KEY,
    StudyInstanceUID VARCHAR(64) NOT NULL CONSTRAINT UQ_Study_UID UNIQUE,
    PatientKey INT NOT NULL REFERENCES pacs.Patient (PatientKey),
    AccessionNumber NVARCHAR(16) NOT NULL CONSTRAINT UQ_Study_Accession UNIQUE,
    StudyDateTime DATETIME2(0) NULL,
    StudyDescription NVARCHAR(128) NULL,
    ModalitiesInStudy NVARCHAR(64) NULL,
    BodyPartExamined NVARCHAR(32) NULL,
    ReferringPhysicianName NVARCHAR(128) NULL,
    InstitutionName NVARCHAR(128) NULL,
    StudyID NVARCHAR(16) NULL,
    NumberOfStudyRelatedSeries INT NULL,
    NumberOfStudyRelatedInstances INT NULL,
    StudySizeMB DECIMAL(12, 2) NULL,
    InstanceAvailability VARCHAR(12) NOT NULL,
    ArchiveStoreKey INT NOT NULL REFERENCES pacs.ArchiveStore (ArchiveStoreKey),
    ReceivedDateTime DATETIME2(0) NULL,
    SourceCollection NVARCHAR(64) NULL,
    SourceDOI NVARCHAR(128) NULL,
    SourceLicense NVARCHAR(32) NULL);

CREATE TABLE pacs.Series (
    SeriesKey INT NOT NULL PRIMARY KEY,
    SeriesInstanceUID VARCHAR(64) NOT NULL CONSTRAINT UQ_Series_UID UNIQUE,
    StudyKey INT NOT NULL REFERENCES pacs.Study (StudyKey),
    Modality VARCHAR(16) NULL,
    SeriesNumber INT NULL,
    SeriesDescription NVARCHAR(128) NULL,
    BodyPartExamined NVARCHAR(32) NULL,
    Manufacturer NVARCHAR(64) NULL,
    ManufacturerModelName NVARCHAR(64) NULL,
    SliceThicknessMM DECIMAL(7, 3) NULL,
    PixelSpacingMM DECIMAL(9, 5) NULL,
    NumberOfSeriesRelatedInstances INT NULL,
    SeriesSizeMB DECIMAL(12, 2) NULL,
    InstanceAvailability VARCHAR(12) NOT NULL);

CREATE TABLE pacs.Instance (
    InstanceKey INT NOT NULL PRIMARY KEY,
    SOPInstanceUID VARCHAR(64) NOT NULL CONSTRAINT UQ_Instance_UID UNIQUE,
    SeriesKey INT NOT NULL REFERENCES pacs.Series (SeriesKey),
    SOPClassUID VARCHAR(64) NULL,
    SOPClassName NVARCHAR(80) NULL,
    InstanceNumber INT NULL,
    [Rows] INT NULL,
    [Columns] INT NULL,
    NumberOfFrames INT NULL,
    TotalPixelMatrixRows INT NULL,
    TotalPixelMatrixColumns INT NULL,
    ImageType NVARCHAR(128) NULL,
    PhotometricInterpretation VARCHAR(16) NULL,
    BitsAllocated SMALLINT NULL,
    TransferSyntaxUID VARCHAR(64) NULL,
    ImagePositionZ DECIMAL(10, 3) NULL,
    FileSizeBytes BIGINT NULL,
    ArchiveStoreKey INT NOT NULL REFERENCES pacs.ArchiveStore (ArchiveStoreKey),
    StoragePath NVARCHAR(400) NULL);

CREATE TABLE pacs.NoduleFinding (
    NoduleFindingKey INT NOT NULL PRIMARY KEY,
    StudyKey INT NOT NULL REFERENCES pacs.Study (StudyKey),
    SeriesKey INT NULL REFERENCES pacs.Series (SeriesKey),
    NoduleLabel NVARCHAR(16) NOT NULL,
    ReaderCount INT NULL,
    DiameterMM DECIMAL(6, 1) NULL,
    MaxDiameterMM DECIMAL(6, 1) NULL,
    VolumeMM3 DECIMAL(10, 1) NULL,
    Texture NVARCHAR(16) NULL,
    Margin NVARCHAR(24) NULL,
    Shape NVARCHAR(16) NULL,
    Calcification NVARCHAR(40) NULL,
    MalignancyScore DECIMAL(3, 2) NULL,
    SpiculationScore DECIMAL(3, 2) NULL,
    Laterality NVARCHAR(8) NULL,
    Lobe NVARCHAR(24) NULL);

CREATE INDEX IX_Study_Patient ON pacs.Study (PatientKey);
CREATE INDEX IX_Series_Study ON pacs.Series (StudyKey);
CREATE INDEX IX_Instance_Series ON pacs.Instance (SeriesKey);
"""

VIEWS = ["""
CREATE OR ALTER VIEW pacs.vStudy AS
SELECT s.StudyKey, s.AccessionNumber, s.StudyInstanceUID, p.PatientID AS Mrn, p.PatientName, s.StudyDateTime,
       s.StudyDescription, s.ModalitiesInStudy, s.BodyPartExamined, s.InstitutionName, s.ReferringPhysicianName,
       s.NumberOfStudyRelatedSeries, s.NumberOfStudyRelatedInstances, s.StudySizeMB, s.InstanceAvailability,
       a.BaseUrl + 'dicom/' + s.StudyInstanceUID + '/' AS StudyFolderUrl
FROM pacs.Study s JOIN pacs.Patient p ON p.PatientKey = s.PatientKey
JOIN pacs.ArchiveStore a ON a.ArchiveStoreKey = s.ArchiveStoreKey""", """
CREATE OR ALTER VIEW pacs.vInstanceFile AS
SELECT i.InstanceKey, i.SOPInstanceUID, se.SeriesInstanceUID, st.StudyInstanceUID, st.AccessionNumber, se.Modality,
       i.FileSizeBytes, a.BaseUrl + REPLACE(i.StoragePath, 'Files/', '') AS FileUrl
FROM pacs.Instance i JOIN pacs.Series se ON se.SeriesKey = i.SeriesKey
JOIN pacs.Study st ON st.StudyKey = se.StudyKey JOIN pacs.ArchiveStore a ON a.ArchiveStoreKey = i.ArchiveStoreKey"""]


def ensure_database():
    state = load_state()
    ws_id, name = state["workspace_id"], settings()["PACS_DATABASE"]
    db = next((d for d in fabric_list(f"/workspaces/{ws_id}/sqlDatabases") if d["displayName"] == name), None)
    if db is None:
        fabric("POST", f"/workspaces/{ws_id}/sqlDatabases",
               {"displayName": name, "description": "PACS index (raw): patients, studies, series and instances."})
        db = next(d for d in fabric_list(f"/workspaces/{ws_id}/sqlDatabases") if d["displayName"] == name)
        print(f"Created SQL database {name}")
    db = fabric("GET", f"/workspaces/{ws_id}/sqlDatabases/{db['id']}")
    props = db["properties"]
    save_state(pacs_database={"id": db["id"], "server": props["serverFqdn"], "database": props["databaseName"]})
    return props["serverFqdn"], props["databaseName"]


def connect(server, database):
    host = server.split(",")[0]
    return mssql_python.connect(f"Server={host};Database={database};Authentication=ActiveDirectoryDefault;"
                                "Encrypt=yes;", autocommit=True)


def typed_rows(cur, table: str, df: pd.DataFrame):
    """Converts each column to the Python type bulk copy expects for the target column (by ordinal position)."""
    schema, name = table.split(".")
    cur.execute("SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? "
                "ORDER BY ORDINAL_POSITION", (schema, name))
    types = [r[0] for r in cur.fetchall()]
    if len(types) != df.shape[1]:
        raise ValueError(f"{table}: {df.shape[1]} columns supplied, table has {len(types)}")
    out = []
    for col, sql_type in zip(df.columns, types):
        v = df[col]
        if sql_type in ("int", "bigint", "smallint"):
            values = pd.to_numeric(v).round().astype("Int64").tolist()
        elif sql_type in ("decimal", "float"):
            values = pd.to_numeric(v).tolist()
        elif sql_type == "datetime2":
            values = list(pd.to_datetime(v).dt.to_pydatetime())
        elif sql_type == "date":
            values = [d.date() if pd.notna(d) else None for d in pd.to_datetime(v)]
        else:
            values = [None if pd.isna(x) else str(x) for x in v.tolist()]
        # Plain lists: pandas turns None back into NaN inside a Series, which bulk copy would store as 'NaN'
        out.append([None if x is None or (not isinstance(x, str) and pd.isna(x)) else x for x in values])
    return list(zip(*out))


def main():
    server, database = ensure_database()
    print(f"PACS database: {server} / {database}")
    tables = build_tables()
    conn = connect(server, database)
    cur = conn.cursor()
    for statement in [s for s in DDL.split(";") if s.strip()]:
        cur.execute(statement)
    for view in VIEWS:
        cur.execute(view)
    for name, df, cols in tables:
        if len(df):
            data = typed_rows(cur, name, df[cols])
            for attempt in range(5):
                try:
                    cur.bulkcopy(name, data, batch_size=20000, timeout=0)
                    break
                except RuntimeError as exc:
                    # Fabric mirrors new tables to OneLake right after creation, which can briefly fail bulk inserts
                    if "4891" not in str(exc) or attempt == 4:
                        raise
                    cur.execute(f"TRUNCATE TABLE {name}")
                    time.sleep(15)
        cur.execute(f"SELECT COUNT(*) FROM {name}")
        print(f"  {name:<20} {cur.fetchone()[0]:>9,} rows")
    cur.execute("SELECT InstanceAvailability, COUNT(*), SUM(NumberOfStudyRelatedInstances) FROM pacs.Study "
                "GROUP BY InstanceAvailability")
    for availability, n, instances in cur.fetchall():
        print(f"  {availability:<8} {n:>6,} studies {instances or 0:>10,} instances")
    conn.close()


if __name__ == "__main__":
    main()
