"""Attaches the imaging sources to Synthea patients by adding Synthea-format rows before the Epic tables are built.

lung_screening  Each LIDC-IDRI subject becomes one age- and sex-matched patient. Each patient gets a chest X-ray
                visit (when the subject has CR/DX images), a CT visit per LIDC CT study, and pulmonary-nodule
                conditions derived from the radiologists' annotations.
pathology       Each lung, breast, colon or prostate cancer patient gets a surgical-pathology "study" (one TCGA slide)
                on the encounter of their biopsy or resection, matched on sex and age at diagnosis.
coherent_mri    Links the 298 Synthea Coherent brain MRI DICOM files to their existing MR imaging studies.

All choices are seeded, so the output is deterministic.
"""
import uuid

import numpy as np
import pandas as pd

from imaging_sources import IMAGING_RAW

NS = uuid.UUID("0f3c5d7e-3a1b-4f6e-9d2c-6b8a1e4c7f90")
WINDOW = (pd.Timestamp("2014-01-01"), pd.Timestamp("2021-06-30"))  # raw Synthea dates; shifted +260 weeks later
SMOKING_LOINC = "72166-2"

CT_SCREEN, CT_DIAG = "CT CHEST LUNG CANCER SCREENING LOW DOSE", "CT CHEST WITHOUT CONTRAST"
SOP_NAMES = {"1.2.840.10008.5.1.4.1.1.2": "CT Image Storage",
             "1.2.840.10008.5.1.4.1.1.1": "Computed Radiography Image Storage",
             "1.2.840.10008.5.1.4.1.1.1.1": "Digital X-Ray Image Storage - For Presentation",
             "1.2.840.10008.5.1.4.1.1.77.1.6": "VL Whole Slide Microscopy Image Storage"}
MODALITY_NAMES = {"CT": "Computed Tomography", "CR": "Computed Radiography", "DX": "Digital Radiography",
                  "SM": "Slide Microscopy"}

REASONS = {
    "ex_smoker": ("8517006", "Ex-smoker (finding)"),
    "smoker": ("449868002", "Smokes tobacco daily"),
    "suspected": ("162573006", "Suspected lung cancer (situation)"),
    "cough": ("49727002", "Cough (finding)"),
    "solitary": ("427359005", "Solitary nodule of lung (disorder)"),
    "multiple": ("786838002", "Multiple pulmonary nodules (disorder)"),
}

# Cancer cohorts for pathology: condition codes, index procedures (in priority order) and the specimen they yield
PATHOLOGY_COHORTS = {
    "lung": {"conditions": {"254637007", "424132000"}, "collections": ["tcga_luad", "tcga_lusc"], "organ": "Lung",
             "procedures": [("Fine needle aspiration biopsy of lung (procedure)", "LUNG, FINE NEEDLE ASPIRATION")],
             "fallback": "LUNG, CT-GUIDED CORE BIOPSY"},
    "breast": {"conditions": {"254837009"}, "collections": ["tcga_brca"], "organ": "Breast",
               "procedures": [("Lumpectomy of breast (procedure)", "BREAST, LUMPECTOMY"),
                              ("Excision of breast tissue (procedure)", "BREAST, EXCISION"),
                              ("Biopsy of breast (procedure)", "BREAST, CORE NEEDLE BIOPSY")],
               "fallback": "BREAST, CORE NEEDLE BIOPSY"},
    "colon": {"conditions": {"363406005", "109838007", "93761005", "94260004"}, "collections": ["tcga_coad"],
              "organ": "Colon",
              "procedures": [("Partial resection of colon", "COLON, PARTIAL COLECTOMY"),
                             ("Biopsy of colon", "COLON, ENDOSCOPIC BIOPSY")],
              "fallback": "COLON, ENDOSCOPIC BIOPSY"},
    "prostate": {"conditions": {"126906006", "92691004", "314994000"}, "collections": ["tcga_prad"],
                 "organ": "Prostate", "procedures": [("Biopsy of prostate", "PROSTATE, NEEDLE CORE BIOPSIES"),
                                                     ("Prostatectomy", "PROSTATE, RADICAL PROSTATECTOMY")],
                 "fallback": "PROSTATE, NEEDLE CORE BIOPSIES"},
}


def uid(kind: str, key: str) -> str:
    return str(uuid.uuid5(NS, f"{kind}:{key}"))


def iso(t: pd.Timestamp) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def business_time(day: pd.Timestamp, rng) -> pd.Timestamp:
    day = day.normalize()
    if day.dayofweek >= 5:
        day += pd.Timedelta(days=7 - day.dayofweek)
    return day + pd.Timedelta(minutes=int(rng.integers(7 * 60 + 30, 17 * 60)))


def _years(t, birth):
    return (t - birth).days / 365.25


def _pcp(enc: pd.DataFrame) -> pd.DataFrame:
    """Most frequent wellness provider (and its organization) per patient."""
    top = enc.assign(W=(enc.ENCOUNTERCLASS == "wellness").astype(int))
    top = top.groupby(["PATIENT", "PROVIDER", "ORGANIZATION"]).agg(w=("W", "sum"), n=("W", "size")).reset_index()
    top = top.sort_values(["PATIENT", "w", "n", "PROVIDER"], ascending=[True, False, False, True])
    return top.drop_duplicates("PATIENT").set_index("PATIENT")[["PROVIDER", "ORGANIZATION"]]


def lung_screening(pat, enc, obs, img, rng):
    series = pd.read_csv(IMAGING_RAW / "lidc_series.csv", dtype=str)
    nodules = pd.read_csv(IMAGING_RAW / "lidc_nodules.csv")
    ct = series[series.Modality == "CT"]
    cxr = series[series.Modality.isin(["CR", "DX"])]

    smoke = obs[obs.CODE == SMOKING_LOINC].sort_values("DATE").groupby("PATIENT").VALUE.last()
    birth = pd.to_datetime(pat.set_index("Id").BIRTHDATE)
    death = pd.to_datetime(pat.set_index("Id").DEATHDATE)
    sex = pat.set_index("Id").GENDER
    excluded = set(img.loc[img.MODALITY_CODE == "CT", "PATIENT"])  # the lung-cancer CT surveillance patients

    pool = []
    for pid in sorted(birth.index):
        if pid in excluded:
            continue
        last_day = min(WINDOW[1], death[pid] - pd.Timedelta(days=60)) if pd.notna(death[pid]) else WINDOW[1]
        lo45, hi85 = max(WINDOW[0], birth[pid] + pd.DateOffset(years=45)), min(last_day, birth[pid] + pd.DateOffset(years=85))
        if lo45 >= hi85:
            continue
        lo50, hi80 = max(WINDOW[0], birth[pid] + pd.DateOffset(years=50)), min(last_day, birth[pid] + pd.DateOffset(years=80))
        status = smoke.get(pid, "Never smoker")
        tier = (0 if status != "Never smoker" else 1) + (0 if lo50 < hi80 else 2)
        pool.append({"pid": pid, "tier": tier, "sex": sex[pid], "status": status, "lo": lo45, "hi": hi85,
                     "plo": lo50 if lo50 < hi80 else lo45, "phi": hi80 if lo50 < hi80 else hi85})
    pool = pd.DataFrame(pool)
    pool["r"] = rng.random(len(pool))
    pool = pool.sort_values(["tier", "r"]).reset_index(drop=True)

    subjects = ct.groupby("PatientID").agg(sex=("PatientSex", "first"), age=("PatientAge", "first")).reset_index()
    subjects["age"] = subjects.age.str.extract(r"(\d+)").astype(float)[0]
    subjects["known"] = subjects.sex.notna().astype(int) + subjects.age.notna().astype(int)
    subjects = subjects.sort_values(["known", "PatientID"], ascending=[False, True])

    used, assignments = set(), []

    def match(s, use_sex, use_age):
        for c in pool.itertuples():
            if c.pid in used or (use_sex and pd.notna(s.sex) and s.sex != c.sex):
                continue
            if use_age and pd.notna(s.age):
                lo = max(c.lo, birth[c.pid] + pd.DateOffset(years=int(s.age)))
                hi = min(c.hi, birth[c.pid] + pd.DateOffset(years=int(s.age) + 1))
            else:
                lo, hi = c.plo, c.phi
            if lo < hi:
                return c, lo, hi
        return None

    for s in subjects.itertuples():
        # Prefer matching both sex and age; LIDC ages outside 45-85 fall back to sex only, then to anyone
        found = match(s, True, True) or match(s, True, False) or match(s, False, False)
        if found is None:
            raise RuntimeError(f"No eligible patient left for {s.PatientID}")
        c, lo, hi = found
        day = lo + pd.Timedelta(days=int(rng.integers(0, max(1, (hi - lo).days))))
        used.add(c.pid)
        assignments.append({"lidc_patient": s.PatientID, "patient": c.pid, "status": c.status, "ct_day": day})
    assign = pd.DataFrame(assignments).set_index("lidc_patient")
    pcp = _pcp(enc)

    enc_rows, img_rows, cond_rows = [], [], []

    def add_visit(patient, start, key, reason, series_rows, proc_name, body):
        provider, org = pcp.loc[patient, "PROVIDER"], pcp.loc[patient, "ORGANIZATION"]
        enc_id = uid("enc", key)
        enc_rows.append({"Id": enc_id, "START": iso(start), "STOP": iso(start + pd.Timedelta(minutes=40)),
                         "PATIENT": patient, "ORGANIZATION": org, "PROVIDER": provider, "ENCOUNTERCLASS": "outpatient",
                         "CODE": "371572003", "DESCRIPTION": "Diagnostic imaging procedure",
                         "REASONCODE": reason[0], "REASONDESCRIPTION": reason[1]})
        first = series_rows.iloc[0]
        img_rows.append({"Id": uid("img", key), "DATE": iso(start + pd.Timedelta(minutes=15)), "PATIENT": patient,
                         "ENCOUNTER": enc_id, "BODYSITE_CODE": "51185008", "BODYSITE_DESCRIPTION": body,
                         "MODALITY_CODE": first.Modality, "MODALITY_DESCRIPTION": MODALITY_NAMES[first.Modality],
                         "SOP_CODE": first.SOPClassUID, "SOP_DESCRIPTION": SOP_NAMES.get(first.SOPClassUID, ""),
                         "PROC_NAME": proc_name, "SOURCE_COLLECTION": "lidc_idri",
                         "SOURCE_PATIENT_ID": first.PatientID, "SOURCE_STUDY_UID": first.StudyInstanceUID})
        return enc_id

    for lidc_patient, studies in ct.groupby("PatientID", sort=True):
        a = assign.loc[lidc_patient]
        first_ct = business_time(a.ct_day, rng)
        screening = a.status != "Never smoker"
        if lidc_patient in set(cxr.PatientID):
            for study_uid, rows in cxr[cxr.PatientID == lidc_patient].groupby("StudyInstanceUID", sort=True):
                when = business_time(first_ct - pd.Timedelta(days=int(rng.integers(7, 60))), rng)
                views = int(pd.to_numeric(rows.instanceCount).sum())
                add_visit(a.patient, when, f"lidc:{study_uid}", REASONS["cough"], rows,
                          "XR CHEST 2 VIEWS" if views >= 2 else "XR CHEST 1 VIEW", "Chest")
        pt_nodules = nodules[(nodules.patient_id == lidc_patient) & (nodules.readers >= 2)]
        for i, (study_uid, rows) in enumerate(studies.groupby("StudyInstanceUID", sort=True)):
            if i == 0:
                when = first_ct
            else:
                follow_up = first_ct + pd.Timedelta(days=int(rng.integers(90, 365)))
                if pd.notna(death[a.patient]):
                    follow_up = min(follow_up, death[a.patient] - pd.Timedelta(days=14))
                when = business_time(max(follow_up, first_ct + pd.Timedelta(days=30)), rng)
            if i == 0:
                reason = REASONS["smoker" if a.status.startswith("Current") else "ex_smoker"] if screening \
                    else REASONS["suspected"]
                proc = CT_SCREEN if screening else CT_DIAG
            else:
                reason, proc = REASONS["solitary" if len(pt_nodules) == 1 else "multiple"], CT_DIAG
            enc_id = add_visit(a.patient, when, f"lidc:{study_uid}", reason, rows, proc,
                               "Thoracic structure (body structure)")
            study_nodules = pt_nodules[pt_nodules.study_uid == study_uid]
            if i == 0 and len(study_nodules):
                key = "solitary" if len(study_nodules) == 1 else "multiple"
                cond_rows.append({"START": when.strftime("%Y-%m-%d"), "STOP": None, "PATIENT": a.patient,
                                  "ENCOUNTER": enc_id, "CODE": REASONS[key][0], "DESCRIPTION": REASONS[key][1]})
                suspicious = study_nodules[(study_nodules.malignancy >= 4) & (study_nodules.diameter_mm >= 8)]
                if len(suspicious):
                    cond_rows.append({"START": when.strftime("%Y-%m-%d"), "STOP": None, "PATIENT": a.patient,
                                      "ENCOUNTER": enc_id, "CODE": REASONS["suspected"][0],
                                      "DESCRIPTION": REASONS["suspected"][1]})

    subjects_out = assign.reset_index()[["lidc_patient", "patient", "status"]]
    return pd.DataFrame(enc_rows), pd.DataFrame(img_rows), pd.DataFrame(cond_rows), subjects_out


def pathology(pat, enc, cond, procs, rng):
    slides = pd.read_csv(IMAGING_RAW / "tcga_slides.csv", dtype=str)
    slides["age"] = pd.to_numeric(slides.age_at_diagnosis, errors="coerce")
    birth = pd.to_datetime(pat.set_index("Id").BIRTHDATE)
    sex = pat.set_index("Id").GENDER.map({"F": "FEMALE", "M": "MALE"})
    enc_start = pd.to_datetime(enc.set_index("Id").START, utc=True).dt.tz_localize(None)
    procs = procs.assign(TIME=pd.to_datetime(procs.DATE, utc=True).dt.tz_localize(None))

    img_rows, cases = [], []
    for cohort, spec in PATHOLOGY_COHORTS.items():
        dx = cond[cond.CODE.isin(spec["conditions"])].sort_values("START").drop_duplicates("PATIENT")
        candidates = slides[slides.collection_id.isin(spec["collections"])].copy()
        candidates["used"] = False
        for d in dx.sort_values(["START", "PATIENT"]).itertuples():
            event = None
            for name, specimen in spec["procedures"]:
                p = procs[(procs.PATIENT == d.PATIENT) & (procs.DESCRIPTION == name)].sort_values("TIME")
                if len(p):
                    event = (p.iloc[0].ENCOUNTER, p.iloc[0].TIME, specimen)
                    break
            if event is None:
                if spec["fallback"] is None or pd.isna(d.ENCOUNTER) or d.ENCOUNTER not in enc_start.index:
                    continue
                event = (d.ENCOUNTER, enc_start[d.ENCOUNTER], spec["fallback"])
            encounter, when, specimen = event
            age = _years(when, birth[d.PATIENT])
            pick = candidates[~candidates.used & (candidates.gender == sex[d.PATIENT])]
            if pick.empty:
                continue
            dist = (pick.age.fillna(65) - age).abs() + rng.random(len(pick)) * 0.5
            slide = pick.loc[dist.idxmin()]
            candidates.loc[slide.name, "used"] = True
            key = f"tcga:{slide.SeriesInstanceUID}"
            scanned = business_time(when + pd.Timedelta(days=int(rng.integers(2, 5))), rng)
            died = pd.to_datetime(pat.set_index("Id").DEATHDATE.get(d.PATIENT))
            if pd.notna(died) and scanned >= died:
                scanned = when + pd.Timedelta(hours=4)
            img_rows.append({"Id": uid("img", key), "DATE": iso(scanned), "PATIENT": d.PATIENT, "ENCOUNTER": encounter,
                             "BODYSITE_CODE": "", "BODYSITE_DESCRIPTION": spec["organ"], "MODALITY_CODE": "SM",
                             "MODALITY_DESCRIPTION": MODALITY_NAMES["SM"], "SOP_CODE": "1.2.840.10008.5.1.4.1.1.77.1.6",
                             "SOP_DESCRIPTION": SOP_NAMES["1.2.840.10008.5.1.4.1.1.77.1.6"],
                             "PROC_NAME": f"SURGICAL PATHOLOGY, {spec['organ'].upper()}", "SOURCE_COLLECTION":
                             slide.collection_id, "SOURCE_PATIENT_ID": slide.PatientID,
                             "SOURCE_STUDY_UID": slide.StudyInstanceUID})
            cases.append({"patient": d.PATIENT, "cohort": cohort, "specimen": specimen, "tcga_patient": slide.PatientID,
                          "collection_id": slide.collection_id, "slide_series_uid": slide.SeriesInstanceUID,
                          "imaging_study_id": uid("img", key)})
    return pd.DataFrame(img_rows), pd.DataFrame(cases)


def coherent_mri(img: pd.DataFrame) -> pd.DataFrame:
    files = pd.read_csv(IMAGING_RAW / "coherent_dicom.csv", dtype=str)
    mr = img[(img.MODALITY_CODE == "MR")][["Id", "PATIENT"]]
    linked = mr.merge(files, left_on="PATIENT", right_on="synthea_patient_id")
    if linked.PATIENT.duplicated().any():
        raise RuntimeError("Expected one MR study per patient with Coherent DICOM")
    return linked[["Id", "study_uid", "key"]]


def augment(pat, enc, cond, procs, obs, img):
    """Returns encounters, conditions and imaging studies extended with the imaging cohorts, plus link tables."""
    rng = np.random.default_rng(20261105)
    l_enc, l_img, l_cond, subjects = lung_screening(pat, enc, obs, img, rng)
    p_img, cases = pathology(pat, enc, cond, procs, rng)

    img = img.copy()
    for col in ("PROC_NAME", "SOURCE_COLLECTION", "SOURCE_PATIENT_ID", "SOURCE_STUDY_UID"):
        img[col] = None
    mri = coherent_mri(img).set_index("Id")
    is_mri = img.Id.isin(mri.index)
    img.loc[is_mri, "SOURCE_COLLECTION"] = "synthea_coherent"
    img.loc[is_mri, "SOURCE_STUDY_UID"] = img.loc[is_mri, "Id"].map(mri.study_uid)
    img.loc[is_mri, "SOURCE_PATIENT_ID"] = img.loc[is_mri, "PATIENT"]

    enc = pd.concat([enc, l_enc], ignore_index=True)
    cond = pd.concat([cond, l_cond], ignore_index=True)
    img = pd.concat([img, l_img, p_img], ignore_index=True)
    print(f"  imaging cohorts: {len(subjects):,} LIDC subjects ({len(l_img):,} studies), "
          f"{len(cases):,} pathology cases, {int(is_mri.sum())} Coherent MRI studies")
    return enc, cond, img, subjects, cases
