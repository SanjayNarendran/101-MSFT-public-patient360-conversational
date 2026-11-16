"""Builds Epic Clarity- and Caboodle-style tables from the Synthea Coherent Data Set (CC BY 4.0).

Input : data/raw/coherent/*.csv           (01_download_coherent.py)
Output: data/generated/clarity/*.csv.gz   (Clarity-style, normalized OLTP extract)
        data/generated/caboodle/*.csv.gz  (Caboodle-style star schema derived from the Clarity tables)
        data/generated/crosswalk/*.csv    (Synthea id -> Epic id maps for later stages; not loaded)

All dates are shifted forward by a constant 260 weeks so the records end in mid-2026 while ages,
intervals and weekdays stay intact. The output is deterministic.
"""
import re

import numpy as np
import pandas as pd

import epic_reference as ref
import imaging_cohorts
from common import GEN_DIR, RAW_DIR
from epic_schema import CABOODLE, CLARITY

SHIFT = pd.Timedelta(weeks=260)
RNG = np.random.default_rng(20261104)
UNSPECIFIED = -1


# --- helpers ---------------------------------------------------------------------------------

def read(name):
    return pd.read_csv(RAW_DIR / f"{name}.csv", dtype=str, keep_default_na=False, na_values=[""])


def ts(series):
    return pd.to_datetime(series, utc=True, errors="coerce").dt.tz_localize(None) + SHIFT


def clean_name(series):
    return series.fillna("").str.replace(r"\d+", "", regex=True).str.replace(r"\s+", " ", regex=True).str.strip()


def clean_term(series):
    out = series.str.replace(r"\s*\((disorder|finding|situation|procedure|regime/therapy|qualifier value|body structure)\)",
                             "", regex=True)
    return out.str.replace(r"\s+", " ", regex=True).str.strip()


def date_key(series):
    return pd.to_numeric(pd.to_datetime(series).dt.strftime("%Y%m%d"), errors="coerce").astype("Int64").fillna(UNSPECIFIED)


def fmt_num(values):
    return values.map(lambda v: "" if pd.isna(v) else (f"{v:.3f}".rstrip("0").rstrip(".")))


def npi(i):
    base = f"1{i:08d}"
    digits = [int(c) for c in "80840" + base]
    total = 0
    for pos, d in enumerate(reversed(digits)):
        if pos % 2 == 0:
            d *= 2
            d = d - 9 if d > 9 else d
        total += d
    return base + str((10 - total % 10) % 10)


def lookup(name_to_code: dict):
    return pd.DataFrame({"code": list(name_to_code.values()), "name": list(name_to_code.keys())})


def write(df: pd.DataFrame, table: str, schema: dict, folder: str):
    spec = schema[table]
    missing = [c for c, _ in spec if c not in df.columns]
    if missing:
        raise ValueError(f"{table}: missing columns {missing}")
    out = df[[c for c, _ in spec]].copy()
    for col, typ in spec:
        if typ == "INT":
            out[col] = pd.to_numeric(out[col], errors="raise").astype("Int64")
            if out[col].max() is not pd.NA and out[col].max() > 2**31 - 1:
                raise ValueError(f"{table}.{col} exceeds int32")
        elif typ.startswith("NUMBER"):
            out[col] = pd.to_numeric(out[col]).round(3)
        elif typ == "DATE":
            out[col] = pd.to_datetime(out[col]).dt.strftime("%Y-%m-%d")
        elif typ == "TIMESTAMP":
            out[col] = pd.to_datetime(out[col]).dt.strftime("%Y-%m-%d %H:%M:%S")
    path = GEN_DIR / folder / f"{table}.csv.gz"
    path.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(path, index=False, compression="gzip", na_rep="")
    print(f"  {folder}.{table:<24} {len(out):>9,} rows")
    return out


# --- category lists (ZC_) --------------------------------------------------------------------

SEX = {"Female": 1, "Male": 2, "Unknown": 3}
ETHNIC = {"Hispanic or Latino": 1, "Not Hispanic or Latino": 2, "Unknown": 3}
RACE = {"White": 1, "Black or African American": 2, "Asian": 3, "American Indian or Alaska Native": 4,
        "Native Hawaiian or Other Pacific Islander": 5, "Other": 6}
MARITAL = {"Single": 1, "Married": 2, "Divorced": 3, "Widowed": 4, "Unknown": 5}
PAT_STATUS = {"Alive": 1, "Deceased": 2}
ENC_TYPE = {"Hospital Encounter": 3, "Telemedicine": 76, "Office Visit": 101, "Hospital Outpatient Visit": 1003,
            "Urgent Care": 1214, "Preventive Care Visit": 2101, "Documentation": 2501}
APPT_STATUS = {"Scheduled": 1, "Completed": 2, "Canceled": 3, "No Show": 4}
PAT_CLASS = {"Inpatient": 1, "Outpatient": 2, "Emergency": 3, "Observation": 4}
ADM_SOURCE = {"Physician or Clinic Referral": 1, "Self Referral": 2, "Transfer from a Hospital": 4, "Emergency Room": 7}
DISCH_DISP = {"Home or Self Care": 1, "Skilled Nursing Facility": 3, "Home Health Service": 6,
              "Left Against Medical Advice": 7, "Admitted as an Inpatient": 9, "Expired": 20}
ORDER_TYPE = {"Procedures": 1, "Lab": 7, "Imaging": 10, "Pathology": 26}
ORDER_STATUS = {"Pending": 1, "Sent": 2, "Resulted": 3, "Canceled": 4, "Completed": 5, "Discontinued": 9}
RESULT_FLAG = {"Low": 1, "High": 2, "Abnormal": 3}
RESULT_STATUS = {"Preliminary": 1, "Final": 2, "Corrected": 3}
PROBLEM_STATUS = {"Active": 1, "Resolved": 2}


def main():
    print("Reading Synthea Coherent CSVs")
    pat = read("patients")
    enc = read("encounters")
    cond = read("conditions")
    meds = read("medications")
    procs = read("procedures")
    obs = read("observations")
    img = read("imaging_studies")
    provs = read("providers")
    orgs = read("organizations")
    enc, cond, img, lidc_subjects, pathology_cases = imaging_cohorts.augment(pat, enc, cond, procs, obs, img)

    clarity, caboodle = {}, {}

    # ---- PATIENT ------------------------------------------------------------------------------
    n = len(pat)
    idx = np.arange(n)
    pat["PAT_ID"] = "Z" + pd.Series(1_000_001 + idx).astype(str)
    pat["PAT_MRN_ID"] = pd.Series((idx * 7919 + 1_234_567) % 90_000_000 + 10_000_000).astype(str)
    first, last = clean_name(pat.FIRST), clean_name(pat.LAST)
    pat["PAT_FIRST_NAME"], pat["PAT_LAST_NAME"] = first, last
    pat["PAT_NAME"] = last.str.upper() + "," + first.str.upper()
    pat["BIRTH_DATE"] = ts(pat.BIRTHDATE).dt.normalize()
    pat["DEATH_DATE"] = ts(pat.DEATHDATE).dt.normalize()
    pat["SEX_C"] = pat.GENDER.map({"F": 1, "M": 2}).fillna(3)
    pat["ETHNIC_GROUP_C"] = pat.ETHNICITY.map({"hispanic": 1, "nonhispanic": 2}).fillna(3)
    pat["MARITAL_STATUS_C"] = pat.MARITAL.map({"S": 1, "M": 2, "D": 3, "W": 4}).fillna(1)
    pat["PAT_STATUS_C"] = np.where(pat.DEATH_DATE.isna(), 1, 2)
    pat["ADD_LINE_1"] = pat.ADDRESS.str.replace(r"\s+", " ", regex=True).str.strip()
    pat["STATE"] = pat.STATE.replace({"Massachusetts": "MA"})
    pat["ZIP"] = pat.ZIP.fillna("")
    areas = np.array(["617", "508", "781", "978", "413", "774", "339", "351", "857"])
    pat["HOME_PHONE"] = "(" + areas[RNG.integers(0, len(areas), n)] + ") 555-01" + pd.Series(
        RNG.integers(0, 100, n)).astype(str).str.zfill(2)
    handle = (first + "." + last).str.lower().str.replace(r"[^a-z.]", "", regex=True)
    pat["EMAIL_ADDRESS"] = handle + pd.Series(idx % 97).astype(str) + "@example.com"
    race_code = pat.RACE.map({"white": 1, "black": 2, "asian": 3, "native": 4, "hawaiian": 5}).fillna(6)
    pat_by_uuid = pat.set_index("Id")

    # ---- Providers and departments --------------------------------------------------------------
    orgs["LAT"], orgs["LON"] = orgs.LAT.astype(float), orgs.LON.astype(float)
    camp = pd.DataFrame(ref.CAMPUSES, columns=["REV_LOC_ID", "REV_LOC_NAME", "CITY", "LAT", "LON"])
    dist = ((orgs.LAT.values[:, None] - camp.LAT.values) ** 2
            + ((orgs.LON.values[:, None] - camp.LON.values) * 0.74) ** 2)
    org_campus = pd.Series(camp.REV_LOC_ID.values[dist.argmin(axis=1)], index=orgs.Id)
    abbrev = {101: "CMC", 102: "CNS", 103: "CCH", 104: "CWH", 105: "CSC", 106: "CCI", 107: "CBH"}

    enc["START_TS"], enc["STOP_TS"] = ts(enc.START), ts(enc.STOP)
    enc = enc.sort_values(["START_TS", "Id"], kind="mergesort").reset_index(drop=True)
    enc["PAT_ENC_CSN_ID"] = 200_000_001 + np.arange(len(enc))
    enc["PAT_ID"] = enc.PATIENT.map(pat_by_uuid.PAT_ID)
    birth = enc.PATIENT.map(pat_by_uuid.BIRTH_DATE)
    enc["AGE"] = ((enc.START_TS - birth).dt.days // 365.25).astype(int)
    enc["REV_LOC_ID"] = enc.ORGANIZATION.map(org_campus)

    all_provs = provs
    provs = provs[provs.Id.isin(enc.PROVIDER)].sort_values("Id").reset_index(drop=True)
    provs["PROV_ID"] = pd.Series(1_001_000 + np.arange(len(provs))).astype(str)
    spec = provs.SPECIALITY.map(lambda s: ref.SPECIALTY.get(s, ("PRIMARY CARE", "Physician", "MD")))
    provs["SERVICE"] = spec.str[0]
    provs["PROV_TYPE"] = spec.str[1]
    provs["CLINICIAN_TITLE"] = spec.str[2]
    pname = clean_name(provs.NAME)
    provs["PROV_NAME"] = (pname.str.split(" ").str[-1] + ", " + pname.str.split(" ").str[:-1].str.join(" ")).str.upper()
    provs["NPI"] = [npi(i * 37 + 1_000) for i in range(len(provs))]
    prov_by_uuid = provs.set_index("Id")
    enc["VISIT_PROV_ID"] = enc.PROVIDER.map(prov_by_uuid.PROV_ID)
    prov_service = enc.PROVIDER.map(prov_by_uuid.SERVICE)

    cls, desc = enc.ENCOUNTERCLASS, enc.DESCRIPTION.str.lower()
    service = prov_service.copy()
    service[(service == "PRIMARY CARE") & (enc.AGE < 18)] = "PEDIATRICS"
    service[service.isin(["EMERGENCY DEPT", "INTENSIVE CARE UNIT"])] = "INTERNAL MEDICINE"
    service[desc.str.contains("prenatal")] = "WOMENS HEALTH"
    wellness = cls == "wellness"
    service[wellness] = np.where(enc.AGE[wellness] < 18, "PEDIATRICS", "PRIMARY CARE")
    service[wellness & desc.str.contains("death certification")] = "HEALTH INFORMATION MANAGEMENT"
    service[(cls == "outpatient") & (enc.DESCRIPTION == "Diagnostic imaging procedure")] = "RADIOLOGY"
    service[cls == "urgentcare"] = "URGENT CARE"
    service[cls == "emergency"] = "EMERGENCY DEPT"
    inpat = cls == "inpatient"
    service[inpat] = "MEDICAL SURGICAL UNIT"
    service[inpat & desc.str.contains("intensive care")] = "INTENSIVE CARE UNIT"
    service[inpat & desc.str.contains("gynecology|obstetric")] = "LABOR AND DELIVERY"
    service[inpat & desc.str.contains("drug rehabilitation")] = "BEHAVIORAL HEALTH UNIT"
    enc["SERVICE"] = service

    all_services = sorted(set(enc.SERVICE) | {"RADIOLOGY", "LABORATORY"})
    svc_no = {s: i + 1 for i, s in enumerate(all_services)}
    deps = pd.DataFrame([(c, s) for c in camp.REV_LOC_ID for s in all_services], columns=["REV_LOC_ID", "SERVICE"])
    deps["DEPARTMENT_ID"] = deps.REV_LOC_ID * 100_000 + 1_000 + deps.SERVICE.map(svc_no)
    deps["DEPARTMENT_NAME"] = deps.REV_LOC_ID.map(abbrev) + " " + deps.SERVICE
    deps["SPECIALTY"] = deps.SERVICE.str.title()
    deps = deps.merge(camp[["REV_LOC_ID", "REV_LOC_NAME", "CITY"]], on="REV_LOC_ID")
    deps["STATE"], deps["ACTIVE_STATUS"] = "MA", "Active"
    dep_id = deps.set_index(["REV_LOC_ID", "SERVICE"]).DEPARTMENT_ID
    enc["DEPARTMENT_ID"] = dep_id.reindex(pd.MultiIndex.from_arrays([enc.REV_LOC_ID, enc.SERVICE])).values
    used_deps = set(enc.DEPARTMENT_ID) | set(deps.loc[deps.SERVICE.isin(["RADIOLOGY", "LABORATORY"]), "DEPARTMENT_ID"])
    deps = deps[deps.DEPARTMENT_ID.isin(used_deps)].sort_values("DEPARTMENT_ID")
    clarity["CLARITY_DEP"] = deps

    primary_dep = enc.groupby("VISIT_PROV_ID").DEPARTMENT_ID.agg(lambda s: s.value_counts().index[0])
    provs["PRIMARY_DEPT_ID"] = provs.PROV_ID.map(primary_dep)

    # Reading radiologists and pathologists sign the reports; Synthea gives them no encounters, so add a roster per
    # campus. Their IDs follow the encounter providers so existing provider IDs and keys don't change.
    roster = {"DIAGNOSTIC RADIOLOGY": 6, "PATHOLOGY": 2}
    readers = all_provs[all_provs.SPECIALITY.isin(roster) & ~all_provs.Id.isin(provs.Id)].copy()
    readers["REV_LOC_ID"] = readers.ORGANIZATION.map(org_campus)
    readers = readers.sort_values(["REV_LOC_ID", "SPECIALITY", "Id"])
    readers = readers[readers.groupby(["REV_LOC_ID", "SPECIALITY"]).cumcount() < readers.SPECIALITY.map(roster)]
    readers = readers.sort_values("Id").reset_index(drop=True)
    readers["PROV_ID"] = pd.Series(1_009_000 + np.arange(len(readers))).astype(str)
    readers["SERVICE"] = readers.SPECIALITY.map(lambda x: ref.SPECIALTY[x][0])
    readers["PROV_TYPE"], readers["CLINICIAN_TITLE"] = "Physician", "MD"
    rname = clean_name(readers.NAME)
    readers["PROV_NAME"] = (rname.str.split(" ").str[-1] + ", " + rname.str.split(" ").str[:-1].str.join(" ")).str.upper()
    readers["NPI"] = [npi(900_000 + i * 37) for i in range(len(readers))]
    readers["PRIMARY_DEPT_ID"] = dep_id.reindex(pd.MultiIndex.from_arrays([readers.REV_LOC_ID, readers.SERVICE])).values
    provs = pd.concat([provs, readers.drop(columns="REV_LOC_ID")], ignore_index=True)
    provs["PROV_TYPE_C"] = provs.PROV_TYPE.map({t: i + 1 for i, t in enumerate(ref.PROV_TYPES)})
    provs["SPECIALTY"] = provs.SPECIALITY.str.title()
    provs["SEX"] = provs.GENDER.map({"F": "Female", "M": "Male"})
    provs["ACTIVE_STATUS"] = "Active"
    clarity["CLARITY_SER"] = provs

    # ---- PAT_ENC and PAT_ENC_HSP --------------------------------------------------------------
    enc_type = pd.Series("Office Visit", index=enc.index)
    enc_type[cls == "ambulatory"] = np.where(desc[cls == "ambulatory"].str.contains("telemedicine"), "Telemedicine", "Office Visit")
    enc_type[wellness] = np.where(desc[wellness].str.contains("death certification"), "Documentation", "Preventive Care Visit")
    enc_type[cls == "outpatient"] = "Hospital Outpatient Visit"
    enc_type[cls == "urgentcare"] = "Urgent Care"
    enc_type[cls.isin(["emergency", "inpatient"])] = "Hospital Encounter"
    enc["ENC_TYPE"] = enc_type
    enc["ENC_TYPE_C"] = enc_type.map(ENC_TYPE)
    enc["APPT_STATUS_C"] = np.where(cls.isin(["emergency", "inpatient"]) | (enc_type == "Documentation"), np.nan, 2)
    enc["CONTACT_DATE"] = enc.START_TS.dt.normalize()
    enc["APPT_TIME"], enc["ENC_CLOSE_TIME"], enc["ENC_CLOSED_YN"] = enc.START_TS, enc.STOP_TS, "Y"

    hsp = enc[cls.isin(["inpatient", "emergency"])].copy()
    hsp["PAT_CLASS"] = np.where(hsp.ENCOUNTERCLASS == "inpatient", "Inpatient", "Emergency")
    ed = hsp[hsp.PAT_CLASS == "Emergency"][["PATIENT", "STOP_TS", "PAT_ENC_CSN_ID"]].rename(
        columns={"STOP_TS": "ED_STOP", "PAT_ENC_CSN_ID": "ED_CSN"}).sort_values("ED_STOP")
    ip = hsp[hsp.PAT_CLASS == "Inpatient"].sort_values("START_TS")
    ip = pd.merge_asof(ip, ed, left_on="START_TS", right_on="ED_STOP", by="PATIENT",
                       tolerance=pd.Timedelta(hours=12), direction="backward")
    from_ed = set(ip.loc[ip.ED_CSN.notna(), "PAT_ENC_CSN_ID"])
    ed_admitted = set(ip.ED_CSN.dropna().astype(int))
    r = RNG.random(len(hsp))
    adm_src = np.where(hsp.PAT_CLASS == "Inpatient",
                       np.where(hsp.PAT_ENC_CSN_ID.isin(from_ed), "Emergency Room",
                                np.where(r < 0.08, "Transfer from a Hospital", "Physician or Clinic Referral")),
                       np.where(r < 0.85, "Self Referral", np.where(r < 0.95, "Physician or Clinic Referral",
                                                                      "Transfer from a Hospital")))
    death = hsp.PATIENT.map(pat_by_uuid.DEATH_DATE)
    expired = death.notna() & (death >= hsp.START_TS.dt.normalize() - pd.Timedelta(days=1)) & \
        (death <= hsp.STOP_TS + pd.Timedelta(days=1))
    r2 = RNG.random(len(hsp))
    disp = np.where(hsp.AGE >= 75, np.where(r2 < 0.25, "Skilled Nursing Facility",
                                            np.where(r2 < 0.40, "Home Health Service", "Home or Self Care")),
                    np.where(r2 < 0.01, "Left Against Medical Advice", "Home or Self Care"))
    disp = np.where(hsp.PAT_ENC_CSN_ID.isin(ed_admitted), "Admitted as an Inpatient", disp)
    disp = np.where(expired, "Expired", disp)
    hsp["ADT_PAT_CLASS_C"] = hsp.PAT_CLASS.map(PAT_CLASS)
    hsp["ADMIT_SOURCE_C"] = pd.Series(adm_src, index=hsp.index).map(ADM_SOURCE)
    hsp["DISCH_DISP_C"] = pd.Series(disp, index=hsp.index).map(DISCH_DISP)
    hsp["HOSP_ADMSN_TIME"], hsp["HOSP_DISCH_TIME"] = hsp.START_TS, hsp.STOP_TS
    hsp["ADMISSION_PROV_ID"] = hsp["DISCHARGE_PROV_ID"] = hsp.VISIT_PROV_ID
    clarity["PAT_ENC_HSP"] = hsp

    enc_by_uuid = enc.set_index("Id")
    csn_of = enc_by_uuid.PAT_ENC_CSN_ID

    # ---- Diagnoses (CLARITY_EDG, PAT_ENC_DX, PROBLEM_LIST) --------------------------------------
    dx_terms = pd.concat([
        cond[["CODE", "DESCRIPTION"]],
        enc[["REASONCODE", "REASONDESCRIPTION"]].set_axis(["CODE", "DESCRIPTION"], axis=1),
        meds[["REASONCODE", "REASONDESCRIPTION"]].set_axis(["CODE", "DESCRIPTION"], axis=1),
        procs[["REASONCODE", "REASONDESCRIPTION"]].set_axis(["CODE", "DESCRIPTION"], axis=1),
    ]).dropna()
    edg = dx_terms.groupby("CODE").DESCRIPTION.agg(lambda s: s.value_counts().index[0]).reset_index()
    edg["DX_NAME"] = clean_term(edg.DESCRIPTION)
    edg = edg.sort_values(["DX_NAME", "CODE"]).reset_index(drop=True)
    edg["DX_ID"] = 100_001 + np.arange(len(edg))
    edg["CURRENT_ICD10_LIST"] = edg.CODE.map(ref.SNOMED_TO_ICD10)
    edg["SNOMED_CT_CODE"] = edg.CODE
    clarity["CLARITY_EDG"] = edg
    dx_of = edg.set_index("CODE").DX_ID

    reasons = enc[enc.REASONCODE.notna()][["Id", "REASONCODE"]].rename(columns={"REASONCODE": "CODE"})
    reasons["ORDER"] = 0
    enc_conds = cond[cond.ENCOUNTER.notna()][["ENCOUNTER", "CODE"]].rename(columns={"ENCOUNTER": "Id"})
    enc_conds["ORDER"] = 1
    edx = pd.concat([reasons, enc_conds]).drop_duplicates(["Id", "CODE"]).sort_values(["Id", "ORDER", "CODE"])
    edx = edx[edx.Id.isin(enc_by_uuid.index)]
    edx["PAT_ENC_CSN_ID"] = edx.Id.map(csn_of)
    edx = edx.sort_values(["PAT_ENC_CSN_ID", "ORDER", "CODE"], kind="mergesort")
    edx["LINE"] = edx.groupby("PAT_ENC_CSN_ID").cumcount() + 1
    edx["PAT_ID"] = edx.Id.map(enc_by_uuid.PAT_ID)
    edx["CONTACT_DATE"] = edx.Id.map(enc_by_uuid.CONTACT_DATE)
    edx["DX_ID"] = edx.CODE.map(dx_of)
    edx["PRIMARY_DX_YN"] = np.where(edx.LINE == 1, "Y", "N")
    clarity["PAT_ENC_DX"] = edx

    cond["START_TS"], cond["STOP_TS"] = ts(cond.START), ts(cond.STOP)
    chronic = cond.STOP_TS.isna() | ((cond.STOP_TS - cond.START_TS).dt.days >= 90)
    pl = cond[chronic].sort_values(["START_TS", "PATIENT", "CODE"], kind="mergesort").reset_index(drop=True)
    pl["PROBLEM_LIST_ID"] = 500_000_001 + np.arange(len(pl))
    pl["PAT_ID"] = pl.PATIENT.map(pat_by_uuid.PAT_ID)
    pl["DX_ID"] = pl.CODE.map(dx_of)
    pl["NOTED_DATE"], pl["RESOLVED_DATE"] = pl.START_TS, pl.STOP_TS
    pl["PROBLEM_STATUS_C"] = np.where(pl.STOP_TS.isna(), 1, 2)
    pl["DIAG_ENC_CSN_ID"] = pl.ENCOUNTER.map(csn_of)
    clarity["PROBLEM_LIST"] = pl

    # ---- Orders: procedures, imaging, labs -----------------------------------------------------
    procs["DATE_TS"] = ts(procs.DATE)
    procs["GROUP"] = procs.CODE.map(ref.IMAGING_PROC_CODES)
    img["DATE_TS"] = ts(img.DATE)
    img["GROUP"] = img.MODALITY_CODE.map(ref.MODALITY_GROUP)
    # Merge imaging procedures with the imaging study recorded for the same encounter
    study_counts = img.groupby(["ENCOUNTER", "GROUP"]).size()
    img_procs = procs[procs.GROUP.notna()].copy()
    img_procs["K"] = img_procs.groupby(["ENCOUNTER", "GROUP"]).cumcount()
    limit = study_counts.reindex(pd.MultiIndex.from_arrays([img_procs.ENCOUNTER, img_procs.GROUP])).fillna(0).values
    duplicate_ids = img_procs.index[img_procs.K.values < limit]
    procs = procs.drop(index=duplicate_ids)

    eap_rows = []
    proc_terms = procs.groupby("CODE").DESCRIPTION.agg(lambda s: s.value_counts().index[0])
    for code, name in proc_terms.items():
        is_img = code in ref.IMAGING_PROC_CODES
        cat = "Imaging" if is_img else next((c for k, c in ref.PROC_CATEGORIES if k in name.lower()), "General Procedures")
        eap_rows.append((clean_term(pd.Series([name]))[0].upper(), code, "SNOMED CT", cat,
                         ORDER_TYPE["Imaging" if is_img else "Procedures"]))
    for (_, _), (name, code) in ref.IMAGING_PROCS.items():
        eap_rows.append((name, code, "Internal", "Imaging", ORDER_TYPE["Imaging"]))
    for name, (code, category) in ref.EXTRA_IMAGING_PROCS.items():
        eap_rows.append((name, code, "Internal", category, ORDER_TYPE[category]))

    # Lab panels from observations
    obs = obs[obs.ENCOUNTER.notna() & ~obs.CODE.isin(ref.DROP_OBSERVATIONS)].copy()
    obs["DATE_TS"] = ts(obs.DATE)
    obs["NUM"] = pd.to_numeric(obs.VALUE, errors="coerce").where(obs.TYPE == "numeric")
    is_flow = obs.CODE.isin(ref.FLOWSHEET_ROWS.keys()) | obs.CODE.isin([ref.BP_SYSTOLIC, ref.BP_DIASTOLIC])
    flows, labs = obs[is_flow].copy(), obs[~is_flow].copy()

    comp_desc = labs.groupby("CODE").DESCRIPTION.agg(lambda s: s.value_counts().index[0])
    comp_unit = labs.groupby("CODE").UNITS.agg(lambda s: s.value_counts().index[0] if s.notna().any() else None)
    comp = pd.DataFrame({"LOINC_CODE": comp_desc.index, "EXTERNAL_NAME": comp_desc.values})
    comp["DEFAULT_UNIT"] = comp.LOINC_CODE.map(comp_unit)

    def derive_name(d):
        d = re.sub(r"\[.*?\]", "", d)
        d = re.sub(r"\b(in|by|of) (Serum or Plasma|Serum|Plasma|Blood|Urine|Stool|Tissue).*$", "", d, flags=re.I)
        return re.sub(r"\s+", " ", d.replace(".", " ")).strip().upper()

    comp["NAME"] = [ref.LAB_COMPONENTS[c][0] if c in ref.LAB_COMPONENTS else derive_name(d)
                    for c, d in zip(comp.LOINC_CODE, comp.EXTERNAL_NAME)]
    comp["BASE_NAME"] = [ref.LAB_COMPONENTS[c][1] if c in ref.LAB_COMPONENTS else re.sub(r"[^A-Z0-9]", "", n)[:10]
                         for c, n in zip(comp.LOINC_CODE, comp.NAME)]
    comp = comp.sort_values(["NAME", "LOINC_CODE"]).reset_index(drop=True)
    comp["COMPONENT_ID"] = 15_001 + np.arange(len(comp))
    clarity["CLARITY_COMPONENT"] = comp
    comp_by_loinc = comp.set_index("LOINC_CODE")

    enc_codes = labs.groupby("ENCOUNTER").CODE.agg(set)
    has_hepatic = enc_codes.map(lambda s: bool(s & ref.HEPATIC))
    has_bmp = enc_codes.map(lambda s: bool(s & ref.BMP))
    panel_of = {code: panel for panel, codes in ref.LAB_PANELS.items() for code in codes}

    def panel(row_code, row_enc, row_desc):
        if row_code in ref.BMP:
            return "COMPREHENSIVE METABOLIC PANEL" if has_hepatic.get(row_enc, False) else "BASIC METABOLIC PANEL"
        if row_code in ref.HEPATIC:
            return "COMPREHENSIVE METABOLIC PANEL" if has_bmp.get(row_enc, False) else "HEPATIC FUNCTION PANEL"
        if row_code in panel_of:
            return panel_of[row_code]
        if ref.ALLERGY_IGE_PREFIX in row_desc:
            return "ALLERGEN PANEL, IGE"
        return comp_by_loinc.NAME[row_code]

    labs["PANEL"] = [panel(c, e, d) for c, e, d in zip(labs.CODE, labs.ENCOUNTER, labs.DESCRIPTION)]
    for name in sorted(set(labs.PANEL)):
        eap_rows.append((name, None, "Internal", "Laboratory", ORDER_TYPE["Lab"]))

    eap = pd.DataFrame(eap_rows, columns=["PROC_NAME", "PROC_CODE", "CODE_TYPE", "PROC_CAT_NAME", "ORDER_TYPE_C"])
    eap = eap.drop_duplicates(["PROC_NAME", "PROC_CODE"]).sort_values(["ORDER_TYPE_C", "PROC_NAME"]).reset_index(drop=True)
    eap["PROC_ID"] = 10_001 + np.arange(len(eap))
    lab_codes = eap.ORDER_TYPE_C == ORDER_TYPE["Lab"]
    eap.loc[lab_codes, "PROC_CODE"] = "LAB" + eap.loc[lab_codes, "PROC_ID"].astype(str)
    clarity["CLARITY_EAP"] = eap
    proc_id_by_snomed = eap[eap.CODE_TYPE == "SNOMED CT"].set_index("PROC_CODE").PROC_ID
    proc_id_by_internal = eap[eap.CODE_TYPE == "Internal"].set_index("PROC_NAME").PROC_ID

    # Assemble ORDER_PROC
    p_orders = pd.DataFrame({
        "SRC": "procedure", "SRC_ID": procs.index.astype(str), "ENC": procs.ENCOUNTER, "TIME": procs.DATE_TS,
        "PROC_ID": procs.CODE.map(proc_id_by_snomed),
        "TYPE": np.where(procs.GROUP.notna(), "Imaging", "Procedures"), "REASON": procs.REASONCODE,
        "MODALITY": procs.GROUP.replace({"XR": "DX", "DXA": "BMD"}), "BODYSITE": None,
    })
    img_name = [p if isinstance(p, str) else ref.IMAGING_PROCS[(m, b)][0]
                for p, m, b in zip(img.PROC_NAME, img.MODALITY_CODE, img.BODYSITE_DESCRIPTION)]
    i_orders = pd.DataFrame({
        "SRC": "imaging_study", "SRC_ID": img.Id, "ENC": img.ENCOUNTER, "TIME": img.DATE_TS,
        "PROC_ID": pd.Series(img_name).map(proc_id_by_internal).values,
        "TYPE": np.where(img.MODALITY_CODE == "SM", "Pathology", "Imaging"), "REASON": None,
        "MODALITY": img.MODALITY_CODE, "BODYSITE": img.BODYSITE_DESCRIPTION.map(ref.IMAGING_BODYSITE),
    })
    lab_groups = labs.groupby(["ENCOUNTER", "PANEL", "DATE_TS"], sort=False).size().reset_index()
    l_orders = pd.DataFrame({
        "SRC": "lab", "SRC_ID": None, "ENC": lab_groups.ENCOUNTER, "TIME": lab_groups.DATE_TS,
        "PROC_ID": lab_groups.PANEL.map(proc_id_by_internal), "TYPE": "Lab", "REASON": None,
        "MODALITY": None, "BODYSITE": None, "PANEL": lab_groups.PANEL,
    })
    orders = pd.concat([p_orders, i_orders, l_orders], ignore_index=True)
    orders = orders[orders.ENC.isin(enc_by_uuid.index)]
    orders = orders.sort_values(["TIME", "TYPE", "PROC_ID", "SRC_ID"], kind="mergesort").reset_index(drop=True)
    orders["ORDER_PROC_ID"] = 300_000_001 + np.arange(len(orders))
    orders["PAT_ID"] = orders.ENC.map(enc_by_uuid.PAT_ID)
    orders["PAT_ENC_CSN_ID"] = orders.ENC.map(csn_of)
    orders["DESCRIPTION"] = orders.PROC_ID.map(eap.set_index("PROC_ID").PROC_NAME)
    orders["ORDER_TYPE_C"] = orders.TYPE.map(ORDER_TYPE)
    orders["ORDER_INST"] = orders.ENC.map(enc_by_uuid.START_TS)
    orders["ORDERING_DATE"] = orders.ORDER_INST.dt.normalize()
    orders["PROC_START_TIME"] = orders.TIME
    orders["AUTHRZING_PROV_ID"] = orders.ENC.map(enc_by_uuid.VISIT_PROV_ID)
    orders["ORDER_STATUS_C"] = np.where(orders.TYPE == "Lab", ORDER_STATUS["Resulted"], ORDER_STATUS["Completed"])
    clarity["ORDER_PROC"] = orders

    odp = orders[orders.REASON.notna()].copy()
    odp["LINE"], odp["DX_ID"] = 1, odp.REASON.map(dx_of)
    clarity["ORDER_DX_PROC"] = odp

    imaging = orders[orders.TYPE.isin(["Imaging", "Pathology"])].copy()
    imaging["LINE"] = 1
    imaging["ACC_NUM"] = imaging.MODALITY.fillna("DX").str[:3] + imaging.TIME.dt.strftime("%Y") + \
        pd.Series(np.arange(1, len(imaging) + 1), index=imaging.index).astype(str).str.zfill(6)
    clarity["ORDER_RAD_ACC_NUM"] = imaging

    # ORDER_RESULTS
    lab_order_id = orders[orders.TYPE == "Lab"].set_index(["ENC", "PANEL", "TIME"]).ORDER_PROC_ID
    labs["ORDER_PROC_ID"] = lab_order_id.reindex(pd.MultiIndex.from_arrays([labs.ENCOUNTER, labs.PANEL, labs.DATE_TS])).values
    labs = labs[labs.ORDER_PROC_ID.notna()]
    labs["COMPONENT_ID"] = labs.CODE.map(comp_by_loinc.COMPONENT_ID)
    labs = labs.sort_values(["ORDER_PROC_ID", "COMPONENT_ID"], kind="mergesort")
    labs["LINE"] = labs.groupby("ORDER_PROC_ID").cumcount() + 1
    labs["PAT_ID"] = labs.ENCOUNTER.map(enc_by_uuid.PAT_ID)
    labs["PAT_ENC_CSN_ID"] = labs.ENCOUNTER.map(csn_of)
    labs["RESULT_TIME"] = labs.DATE_TS
    labs["ORD_NUM_VALUE"] = labs.NUM.round(3)
    labs["ORD_VALUE"] = np.where(labs.NUM.notna(), fmt_num(labs.ORD_NUM_VALUE), labs.VALUE)
    labs["REFERENCE_UNIT"] = labs.UNITS
    lo = labs.CODE.map(lambda c: ref.LAB_COMPONENTS.get(c, (None, None, None, None))[2])
    hi = labs.CODE.map(lambda c: ref.LAB_COMPONENTS.get(c, (None, None, None, None))[3])
    hi = hi.where(~labs.DESCRIPTION.str.contains(ref.ALLERGY_IGE_PREFIX, regex=False), 0.35)
    lo, hi = pd.to_numeric(lo), pd.to_numeric(hi)
    labs["REFERENCE_LOW"], labs["REFERENCE_HIGH"] = fmt_num(lo), fmt_num(hi)
    labs["RESULT_FLAG_C"] = np.select([labs.NUM < lo, labs.NUM > hi], [RESULT_FLAG["Low"], RESULT_FLAG["High"]], np.nan)
    labs["RESULT_STATUS_C"] = RESULT_STATUS["Final"]
    clarity["ORDER_RESULTS"] = labs

    # ---- Flowsheets -------------------------------------------------------------------------
    bp = flows[flows.CODE.isin([ref.BP_SYSTOLIC, ref.BP_DIASTOLIC])]
    bp = bp.pivot_table(index=["ENCOUNTER", "DATE_TS"], columns="CODE", values="NUM", aggfunc="first").dropna().reset_index()
    bp_rows = pd.DataFrame({"ENCOUNTER": bp.ENCOUNTER, "DATE_TS": bp.DATE_TS, "FLO_MEAS_ID": ref.BP_ROW[0],
                            "MEAS_VALUE": bp[ref.BP_SYSTOLIC].round().astype(int).astype(str) + "/"
                            + bp[ref.BP_DIASTOLIC].round().astype(int).astype(str)})
    other = flows[~flows.CODE.isin([ref.BP_SYSTOLIC, ref.BP_DIASTOLIC])]
    other_rows = pd.DataFrame({"ENCOUNTER": other.ENCOUNTER, "DATE_TS": other.DATE_TS,
                               "FLO_MEAS_ID": other.CODE.map(lambda c: ref.FLOWSHEET_ROWS[c][0]),
                               "MEAS_VALUE": np.where(other.NUM.notna(), fmt_num(other.NUM.round(3)), other.VALUE)})
    meas = pd.concat([bp_rows, other_rows], ignore_index=True)
    meas = meas[meas.ENCOUNTER.isin(enc_by_uuid.index)]
    meas["CSN"] = meas.ENCOUNTER.map(csn_of)
    rec_csns = np.sort(meas.CSN.unique())
    rec = pd.DataFrame({"PAT_ENC_CSN_ID": rec_csns})
    rec["INPATIENT_DATA_ID"] = pd.Series(70_000_001 + np.arange(len(rec))).astype(str)
    rec["FSD_ID"] = pd.Series(80_000_001 + np.arange(len(rec))).astype(str)
    enc_by_csn = enc.set_index("PAT_ENC_CSN_ID")
    rec["PAT_ID"] = rec.PAT_ENC_CSN_ID.map(enc_by_csn.PAT_ID)
    rec["RECORD_DATE"] = rec.PAT_ENC_CSN_ID.map(enc_by_csn.CONTACT_DATE)
    clarity["IP_FLWSHT_REC"] = rec
    enc["INPATIENT_DATA_ID"] = enc.PAT_ENC_CSN_ID.map(rec.set_index("PAT_ENC_CSN_ID").INPATIENT_DATA_ID)
    meas["FSD_ID"] = meas.CSN.map(rec.set_index("PAT_ENC_CSN_ID").FSD_ID)
    meas = meas.sort_values(["CSN", "DATE_TS", "FLO_MEAS_ID"], kind="mergesort")
    meas["LINE"] = meas.groupby("FSD_ID").cumcount() + 1
    meas["RECORDED_TIME"] = meas.DATE_TS
    clarity["IP_FLWSHT_MEAS"] = meas

    flow_units = flows.groupby("CODE").UNITS.agg(lambda s: s.value_counts().index[0] if s.notna().any() else None)
    flo = [(fid, name, disp, flow_units.get(loinc), vtype, loinc)
           for loinc, (fid, name, disp, vtype) in ref.FLOWSHEET_ROWS.items()]
    flo.append((ref.BP_ROW[0], ref.BP_ROW[1], ref.BP_ROW[2], "mm[Hg]", ref.BP_ROW[3], f"{ref.BP_SYSTOLIC}/{ref.BP_DIASTOLIC}"))
    clarity["IP_FLO_GP_DATA"] = pd.DataFrame(flo, columns=["FLO_MEAS_ID", "FLO_MEAS_NAME", "DISP_NAME", "UNITS",
                                                           "VAL_TYPE", "LOINC_CODE"]).sort_values("FLO_MEAS_ID")

    # ---- Medications ------------------------------------------------------------------------
    med_desc = meds.groupby("CODE").DESCRIPTION.agg(lambda s: s.value_counts().index[0])
    medm = pd.DataFrame({"RXNORM_CODE": med_desc.index, "DESC": med_desc.values})

    def generic(d):
        d = re.sub(r"\[.*?\]", "", d.replace("Vitamin B 12", "Vitamin B12"))
        d = re.sub(r"^(NDA\d+\s+)?([\d.]+\s*(HR|ML|ACTUAT)\s+)*", "", d, flags=re.I)
        parts = []
        for part in d.split(" / "):
            words = []
            for w in part.split():
                if re.match(r"[\d.]", w):
                    break
                words.append(w)
            if words:
                parts.append(" ".join(words))
        return " / ".join(parts).lower().strip() or d.lower()

    def form(d):
        dl = d.lower()
        for key, value in [("inhaler", "Inhaler"), ("intrauterine", "IUD"), ("implant", "Implant"),
                           ("vaginal ring", "Ring"), ("transdermal", "Patch"), ("patch", "Patch"),
                           ("day pack", "Pack"), ("capsule", "Capsule"), ("tablet", "Tablet"),
                           ("topical", "Cream"), ("spray", "Spray"), ("inhala", "Inhalation"),
                           ("oral solution", "Liquid"), ("oral suspension", "Liquid"), ("inject", "Injection"),
                           ("syringe", "Injection"), ("pen ", "Injection")]:
            if key in dl:
                return value
        return "Other"

    def classes(d):
        dl = d.lower()
        for key, thera, pharm in ref.MED_CLASSES:
            if key in dl:
                return thera, pharm
        if any(h in dl for h in ref.CONTRACEPTIVE_HINTS):
            return "Contraceptives", "Hormonal Contraceptives"
        return "Miscellaneous", "Miscellaneous"

    medm["NAME"] = medm.DESC.str.upper()
    medm["GENERIC_NAME"] = medm.DESC.map(generic)
    medm["STRENGTH"] = medm.DESC.map(lambda d: " / ".join(m.group(0) for m in re.finditer(
        r"\d+(\.\d+)?\s*(MG|ML|UNT|MCG|%)(/(ML|ACTUAT|HR))?", d)) or None)
    medm["FORM"] = medm.DESC.map(form)
    cls_pairs = medm.DESC.map(classes)
    medm["THERA_CLASS"], medm["PHARM_CLASS"] = cls_pairs.str[0], cls_pairs.str[1]
    medm = medm.sort_values(["NAME", "RXNORM_CODE"]).reset_index(drop=True)
    medm["MEDICATION_ID"] = 20_001 + np.arange(len(medm))
    clarity["CLARITY_MEDICATION"] = medm

    meds["START_TS"], meds["STOP_TS"] = ts(meds.START), ts(meds.STOP)
    meds = meds[meds.ENCOUNTER.isin(enc_by_uuid.index)]
    meds = meds.sort_values(["START_TS", "PATIENT", "CODE"], kind="mergesort").reset_index(drop=True)
    meds["ORDER_MED_ID"] = 400_000_001 + np.arange(len(meds))
    meds["PAT_ID"] = meds.PATIENT.map(pat_by_uuid.PAT_ID)
    meds["PAT_ENC_CSN_ID"] = meds.ENCOUNTER.map(csn_of)
    meds["MEDICATION_ID"] = meds.CODE.map(medm.set_index("RXNORM_CODE").MEDICATION_ID)
    meds["DESCRIPTION"] = meds.MEDICATION_ID.map(medm.set_index("MEDICATION_ID").NAME)
    meds["ORDER_INST"] = meds.START_TS
    meds["ORDERING_DATE"] = meds["START_DATE"] = meds.START_TS.dt.normalize()
    meds["END_DATE"] = meds.STOP_TS.dt.normalize()
    meds["AUTHRZING_PROV_ID"] = meds.ENCOUNTER.map(enc_by_uuid.VISIT_PROV_ID)
    meds["ORDER_STATUS_C"] = np.where(meds.STOP_TS.isna(), ORDER_STATUS["Sent"], ORDER_STATUS["Discontinued"])
    meds["REFILLS"] = (pd.to_numeric(meds.DISPENSES, errors="coerce").fillna(1) - 1).clip(lower=0)
    clarity["ORDER_MED"] = meds
    odm = meds[meds.REASONCODE.notna()].copy()
    odm["LINE"], odm["DX_ID"] = 1, odm.REASONCODE.map(dx_of)
    clarity["ORDER_DX_MED"] = odm

    # ---- PATIENT finishing touches ---------------------------------------------------------------
    pcp = enc[enc.ENC_TYPE == "Preventive Care Visit"].groupby("PAT_ID").VISIT_PROV_ID.agg(lambda s: s.iloc[-5:].mode().iloc[0])
    pat["CUR_PCP_PROV_ID"] = pat.PAT_ID.map(pcp)
    clarity["PATIENT"] = pat
    clarity["PATIENT_RACE"] = pd.DataFrame({"PAT_ID": pat.PAT_ID, "LINE": 1, "PATIENT_RACE_C": race_code})
    clarity["PAT_ENC"] = enc

    for table, mapping in [("ZC_ETHNIC_GROUP", ETHNIC), ("ZC_PATIENT_RACE", RACE), ("ZC_MARITAL_STATUS", MARITAL),
                           ("ZC_PATIENT_STATUS", PAT_STATUS), ("ZC_DISP_ENC_TYPE", ENC_TYPE),
                           ("ZC_APPT_STATUS", APPT_STATUS), ("ZC_PAT_CLASS", PAT_CLASS), ("ZC_ADM_SOURCE", ADM_SOURCE),
                           ("ZC_DISCH_DISP", DISCH_DISP), ("ZC_ORDER_TYPE", ORDER_TYPE),
                           ("ZC_ORDER_STATUS", ORDER_STATUS), ("ZC_RESULT_FLAG", RESULT_FLAG),
                           ("ZC_RESULT_STATUS", RESULT_STATUS), ("ZC_PROBLEM_STATUS", PROBLEM_STATUS),
                           ("ZC_PROV_TYPE", {t: i + 1 for i, t in enumerate(ref.PROV_TYPES)})]:
        code_col = CLARITY[table][0][0]
        clarity[table] = lookup(mapping).rename(columns={"code": code_col, "name": "NAME"})
    clarity["ZC_SEX"] = pd.DataFrame({"RCPT_MEM_SEX_C": [1, 2, 3], "NAME": list(SEX), "ABBR": ["F", "M", "U"]})

    print("Writing Clarity tables")
    for table in CLARITY:
        write(clarity[table], table, CLARITY, "clarity")

    build_caboodle(clarity, caboodle, imaging)
    print("Writing Caboodle tables")
    for table in CABOODLE:
        write(caboodle[table], table, CABOODLE, "caboodle")

    write_crosswalks(pat, img, imaging, lidc_subjects, pathology_cases)


def dim_with_unspecified(df: pd.DataFrame, key: str, durable: str, defaults: dict) -> pd.DataFrame:
    row = {c: None for c in df.columns}
    row.update({key: UNSPECIFIED, durable: UNSPECIFIED}, **defaults)
    return pd.concat([pd.DataFrame([row]), df], ignore_index=True)


def build_caboodle(c: dict, cab: dict, imaging: pd.DataFrame):
    def names(table):
        t = c[table]
        return t.set_index(t.columns[0]).NAME

    pat = c["PATIENT"].reset_index(drop=True)
    pat_key = pd.Series(np.arange(1, len(pat) + 1), index=pat.PAT_ID)
    prov = c["CLARITY_SER"].reset_index(drop=True)
    prov_key = pd.Series(np.arange(1, len(prov) + 1), index=prov.PROV_ID)
    dep = c["CLARITY_DEP"].reset_index(drop=True)
    dep_key = pd.Series(np.arange(1, len(dep) + 1), index=dep.DEPARTMENT_ID)
    edg = c["CLARITY_EDG"].reset_index(drop=True)
    dx_key = pd.Series(np.arange(1, len(edg) + 1), index=edg.DX_ID)
    eap = c["CLARITY_EAP"].reset_index(drop=True)
    proc_key = pd.Series(np.arange(1, len(eap) + 1), index=eap.PROC_ID)
    medm = c["CLARITY_MEDICATION"].reset_index(drop=True)
    med_key = pd.Series(np.arange(1, len(medm) + 1), index=medm.MEDICATION_ID)
    comp = c["CLARITY_COMPONENT"].reset_index(drop=True)
    comp_key = pd.Series(np.arange(1, len(comp) + 1), index=comp.COMPONENT_ID)
    enc = c["PAT_ENC"].reset_index(drop=True)
    enc_key = pd.Series(np.arange(1, len(enc) + 1), index=enc.PAT_ENC_CSN_ID)

    def k(series, keys):
        return series.map(keys).fillna(UNSPECIFIED).astype(int)

    # Dimensions
    d = pd.DataFrame({
        "PatientKey": pat_key.values, "PatientDurableKey": pat_key.values, "PatientEpicId": pat.PAT_ID,
        "PrimaryMrn": pat.PAT_MRN_ID, "Name": pat.PAT_LAST_NAME + ", " + pat.PAT_FIRST_NAME,
        "FirstName": pat.PAT_FIRST_NAME, "LastName": pat.PAT_LAST_NAME,
        "Sex": pat.SEX_C.map(names("ZC_SEX")), "BirthDate": pat.BIRTH_DATE, "DeathDate": pat.DEATH_DATE,
        "Status": pat.PAT_STATUS_C.map(names("ZC_PATIENT_STATUS")),
        "MaritalStatus": pat.MARITAL_STATUS_C.map(names("ZC_MARITAL_STATUS")),
        "Ethnicity": pat.ETHNIC_GROUP_C.map(names("ZC_ETHNIC_GROUP")),
        "FirstRace": c["PATIENT_RACE"].PATIENT_RACE_C.map(names("ZC_PATIENT_RACE")).values,
        "AddressLine1": pat.ADD_LINE_1, "City": pat.CITY, "StateOrProvince": pat.STATE, "County": pat.COUNTY,
        "PostalCode": pat.ZIP, "PrimaryCareProviderDurableKey": k(pat.CUR_PCP_PROV_ID, prov_key), "IsCurrent": 1,
    })
    cab["PatientDim"] = dim_with_unspecified(d, "PatientKey", "PatientDurableKey", {"Name": "*Unspecified", "IsCurrent": 1})

    d = pd.DataFrame({
        "ProviderKey": prov_key.values, "ProviderDurableKey": prov_key.values, "ProviderEpicId": prov.PROV_ID,
        "Name": prov.PROV_NAME, "Type": prov.PROV_TYPE, "ClinicianTitle": prov.CLINICIAN_TITLE,
        "PrimarySpecialty": prov.SPECIALTY, "Sex": prov.SEX, "Npi": prov.NPI,
        "PrimaryDepartmentKey": k(prov.PRIMARY_DEPT_ID, dep_key), "IsCurrent": 1,
    })
    cab["ProviderDim"] = dim_with_unspecified(d, "ProviderKey", "ProviderDurableKey", {"Name": "*Unspecified", "IsCurrent": 1})

    d = pd.DataFrame({
        "DepartmentKey": dep_key.values, "DepartmentDurableKey": dep_key.values, "DepartmentEpicId": dep.DEPARTMENT_ID,
        "DepartmentName": dep.DEPARTMENT_NAME, "DepartmentSpecialty": dep.SPECIALTY, "LocationName": dep.REV_LOC_NAME,
        "City": dep.CITY, "StateOrProvince": dep.STATE, "IsCurrent": 1,
    })
    cab["DepartmentDim"] = dim_with_unspecified(d, "DepartmentKey", "DepartmentDurableKey",
                                                {"DepartmentName": "*Unspecified", "IsCurrent": 1})

    d = pd.DataFrame({
        "DiagnosisKey": dx_key.values, "DiagnosisDurableKey": dx_key.values, "DiagnosisEpicId": edg.DX_ID,
        "Name": edg.DX_NAME, "Icd10Code": edg.CURRENT_ICD10_LIST,
        "Icd10Chapter": edg.CURRENT_ICD10_LIST.map(ref.icd10_chapter), "SnomedCtCode": edg.SNOMED_CT_CODE,
    })
    cab["DiagnosisDim"] = dim_with_unspecified(d, "DiagnosisKey", "DiagnosisDurableKey", {"Name": "*Unspecified"})

    d = pd.DataFrame({
        "ProcedureKey": proc_key.values, "ProcedureDurableKey": proc_key.values, "ProcedureEpicId": eap.PROC_ID,
        "Name": eap.PROC_NAME, "Code": eap.PROC_CODE, "CodeSet": eap.CODE_TYPE, "Category": eap.PROC_CAT_NAME,
        "OrderType": eap.ORDER_TYPE_C.map(names("ZC_ORDER_TYPE")),
    })
    cab["ProcedureDim"] = dim_with_unspecified(d, "ProcedureKey", "ProcedureDurableKey", {"Name": "*Unspecified"})

    d = pd.DataFrame({
        "MedicationKey": med_key.values, "MedicationDurableKey": med_key.values, "MedicationEpicId": medm.MEDICATION_ID,
        "Name": medm.NAME, "GenericName": medm.GENERIC_NAME, "Strength": medm.STRENGTH, "Form": medm.FORM,
        "TherapeuticClass": medm.THERA_CLASS, "PharmaceuticalClass": medm.PHARM_CLASS, "RxNormCode": medm.RXNORM_CODE,
    })
    cab["MedicationDim"] = dim_with_unspecified(d, "MedicationKey", "MedicationDurableKey", {"Name": "*Unspecified"})

    d = pd.DataFrame({
        "LabComponentKey": comp_key.values, "LabComponentDurableKey": comp_key.values,
        "LabComponentEpicId": comp.COMPONENT_ID, "Name": comp.NAME, "CommonName": comp.EXTERNAL_NAME,
        "BaseName": comp.BASE_NAME, "LoincCode": comp.LOINC_CODE, "DefaultUnit": comp.DEFAULT_UNIT,
    })
    cab["LabComponentDim"] = dim_with_unspecified(d, "LabComponentKey", "LabComponentDurableKey", {"Name": "*Unspecified"})

    flo = c["IP_FLO_GP_DATA"]
    flo = flo[flo.FLO_MEAS_ID != ref.BP_ROW[0]]
    split = pd.DataFrame([("5-SYS", "BP SYSTOLIC", "BP Systolic", "mm[Hg]", "Numeric", ref.BP_SYSTOLIC),
                          ("5-DIA", "BP DIASTOLIC", "BP Diastolic", "mm[Hg]", "Numeric", ref.BP_DIASTOLIC)],
                         columns=flo.columns)
    flo = pd.concat([split, flo], ignore_index=True)
    flo_key = pd.Series(np.arange(1, len(flo) + 1), index=flo.FLO_MEAS_ID)
    d = pd.DataFrame({
        "FlowsheetRowKey": flo_key.values, "FlowsheetRowDurableKey": flo_key.values, "FlowsheetRowEpicId": flo.FLO_MEAS_ID,
        "Name": flo.FLO_MEAS_NAME, "DisplayName": flo.DISP_NAME, "Unit": flo.UNITS, "ValueType": flo.VAL_TYPE,
        "LoincCode": flo.LOINC_CODE,
    })
    cab["FlowsheetRowDim"] = dim_with_unspecified(d, "FlowsheetRowKey", "FlowsheetRowDurableKey", {"Name": "*Unspecified"})

    start = min(pat.BIRTH_DATE.min(), enc.CONTACT_DATE.min()).replace(month=1, day=1)
    days = pd.date_range(start, "2026-12-31", freq="D")
    cab["DateDim"] = pd.DataFrame({
        "DateKey": days.strftime("%Y%m%d").astype(int), "DateValue": days, "DayOfWeek": days.day_name(),
        "DayOfMonth": days.day, "MonthName": days.month_name(), "MonthNumber": days.month,
        "CalendarQuarter": days.quarter, "CalendarYear": days.year, "IsWeekend": (days.dayofweek >= 5).astype(int),
    })

    # Facts
    hsp = c["PAT_ENC_HSP"].set_index("PAT_ENC_CSN_ID")
    pclass = enc.PAT_ENC_CSN_ID.map(hsp.ADT_PAT_CLASS_C.map(names("ZC_PAT_CLASS"))).fillna("Outpatient")
    edx = c["PAT_ENC_DX"]
    primary_dx = edx[edx.PRIMARY_DX_YN == "Y"].set_index("PAT_ENC_CSN_ID").DX_ID
    cab["EncounterFact"] = pd.DataFrame({
        "EncounterKey": enc_key.values, "EncounterEpicCsn": enc.PAT_ENC_CSN_ID,
        "PatientKey": k(enc.PAT_ID, pat_key), "PatientDurableKey": k(enc.PAT_ID, pat_key),
        "ProviderKey": k(enc.VISIT_PROV_ID, prov_key), "DepartmentKey": k(enc.DEPARTMENT_ID, dep_key),
        "DateKey": date_key(enc.CONTACT_DATE), "EncounterInstant": enc.APPT_TIME,
        "Type": enc.ENC_TYPE_C.map(names("ZC_DISP_ENC_TYPE")), "PatientClass": pclass, "AgeInYears": enc.AGE,
        "PrimaryDiagnosisKey": k(enc.PAT_ENC_CSN_ID.map(primary_dx), dx_key),
        "IsEdVisit": (pclass == "Emergency").astype(int), "IsHospitalAdmission": (pclass == "Inpatient").astype(int),
    })

    ip = c["PAT_ENC_HSP"]
    ip = ip[ip.ADT_PAT_CLASS_C == PAT_CLASS["Inpatient"]].reset_index(drop=True)
    cab["HospitalAdmissionFact"] = pd.DataFrame({
        "HospitalAdmissionKey": np.arange(1, len(ip) + 1), "EncounterKey": k(ip.PAT_ENC_CSN_ID, enc_key),
        "PatientKey": k(ip.PAT_ID, pat_key), "PatientDurableKey": k(ip.PAT_ID, pat_key),
        "AdmittingProviderKey": k(ip.ADMISSION_PROV_ID, prov_key),
        "DischargingProviderKey": k(ip.DISCHARGE_PROV_ID, prov_key), "DepartmentKey": k(ip.DEPARTMENT_ID, dep_key),
        "AdmissionDateKey": date_key(ip.HOSP_ADMSN_TIME), "DischargeDateKey": date_key(ip.HOSP_DISCH_TIME),
        "AdmissionInstant": ip.HOSP_ADMSN_TIME, "DischargeInstant": ip.HOSP_DISCH_TIME,
        "LengthOfStayInDays": ((ip.HOSP_DISCH_TIME - ip.HOSP_ADMSN_TIME).dt.total_seconds() / 86400).round(2),
        "PatientClass": "Inpatient", "AdmissionSource": ip.ADMIT_SOURCE_C.map(names("ZC_ADM_SOURCE")),
        "DischargeDisposition": ip.DISCH_DISP_C.map(names("ZC_DISCH_DISP")),
        "PrincipalDiagnosisKey": k(ip.PAT_ENC_CSN_ID.map(primary_dx), dx_key),
    })

    pl = c["PROBLEM_LIST"]
    ev = pd.concat([
        pd.DataFrame({"PAT_ID": edx.PAT_ID, "CSN": edx.PAT_ENC_CSN_ID, "DX_ID": edx.DX_ID, "START": edx.CONTACT_DATE,
                      "END": pd.NaT, "Type": "Encounter Diagnosis", "Status": None,
                      "IsPrincipal": (edx.PRIMARY_DX_YN == "Y").astype(int)}),
        pd.DataFrame({"PAT_ID": pl.PAT_ID, "CSN": pl.DIAG_ENC_CSN_ID, "DX_ID": pl.DX_ID, "START": pl.NOTED_DATE,
                      "END": pl.RESOLVED_DATE, "Type": "Problem List",
                      "Status": pl.PROBLEM_STATUS_C.map(names("ZC_PROBLEM_STATUS")), "IsPrincipal": 0}),
    ], ignore_index=True)
    cab["DiagnosisEventFact"] = pd.DataFrame({
        "DiagnosisEventKey": np.arange(1, len(ev) + 1), "PatientKey": k(ev.PAT_ID, pat_key),
        "PatientDurableKey": k(ev.PAT_ID, pat_key), "EncounterKey": k(ev.CSN, enc_key),
        "DiagnosisKey": k(ev.DX_ID, dx_key), "StartDateKey": date_key(ev.START), "EndDateKey": date_key(ev.END),
        "Type": ev.Type, "Status": ev.Status, "IsPrincipal": ev.IsPrincipal,
    })

    op = c["ORDER_PROC"]
    pe = op[op.ORDER_TYPE_C != ORDER_TYPE["Lab"]].reset_index(drop=True)
    cab["ProcedureEventFact"] = pd.DataFrame({
        "ProcedureEventKey": np.arange(1, len(pe) + 1), "ProcedureOrderEpicId": pe.ORDER_PROC_ID,
        "PatientKey": k(pe.PAT_ID, pat_key), "PatientDurableKey": k(pe.PAT_ID, pat_key),
        "EncounterKey": k(pe.PAT_ENC_CSN_ID, enc_key), "ProcedureKey": k(pe.PROC_ID, proc_key),
        "OrderingProviderKey": k(pe.AUTHRZING_PROV_ID, prov_key), "DateKey": date_key(pe.PROC_START_TIME),
        "OrderType": pe.ORDER_TYPE_C.map(names("ZC_ORDER_TYPE")),
    })

    im = imaging.reset_index(drop=True)
    enc_dep = enc.set_index("PAT_ENC_CSN_ID").DEPARTMENT_ID
    campus = (im.PAT_ENC_CSN_ID.map(enc_dep) // 100_000)
    radiology = dep[dep.SERVICE == "RADIOLOGY"].set_index("REV_LOC_ID").DEPARTMENT_ID
    laboratory = dep[dep.SERVICE == "LABORATORY"].set_index("REV_LOC_ID").DEPARTMENT_ID
    performing = np.where(im.MODALITY == "SM", campus.map(laboratory), campus.map(radiology))
    body = im.BODYSITE.fillna(im.DESCRIPTION.map(lambda d: next(
        (b for kw, b in [("BREAST", "Breast"), ("MAMMO", "Breast"), ("FETAL", "Uterus"), ("BONE DENSITY", "Hip and Spine"),
                         ("CHEST", "Chest"), ("HEAD", "Head"), ("BRAIN", "Head"), ("PELVIS", "Pelvis"), ("KNEE", "Knee"),
                         ("WRIST", "Wrist"), ("ANKLE", "Ankle"), ("CLAVICLE", "Clavicle"), ("ARM", "Arm"),
                         ("ABDOMEN", "Abdomen"), ("ECHO", "Heart")] if kw in d), None)))
    cab["ImagingFact"] = pd.DataFrame({
        "ImagingKey": np.arange(1, len(im) + 1), "ImagingOrderEpicId": im.ORDER_PROC_ID, "AccessionNumber": im.ACC_NUM,
        "PatientKey": k(im.PAT_ID, pat_key), "PatientDurableKey": k(im.PAT_ID, pat_key),
        "EncounterKey": k(im.PAT_ENC_CSN_ID, enc_key), "ProcedureKey": k(im.PROC_ID, proc_key),
        "OrderingProviderKey": k(im.AUTHRZING_PROV_ID, prov_key),
        "PerformingDepartmentKey": k(pd.Series(performing), dep_key), "ExamStartDateKey": date_key(im.PROC_START_TIME),
        "ExamStartInstant": im.PROC_START_TIME, "Modality": im.MODALITY, "BodySite": body,
    })

    om = c["ORDER_MED"].reset_index(drop=True)
    cab["MedicationOrderFact"] = pd.DataFrame({
        "MedicationOrderKey": np.arange(1, len(om) + 1), "MedicationOrderEpicId": om.ORDER_MED_ID,
        "PatientKey": k(om.PAT_ID, pat_key), "PatientDurableKey": k(om.PAT_ID, pat_key),
        "EncounterKey": k(om.PAT_ENC_CSN_ID, enc_key), "MedicationKey": k(om.MEDICATION_ID, med_key),
        "OrderingProviderKey": k(om.AUTHRZING_PROV_ID, prov_key), "OrderedDateKey": date_key(om.ORDERING_DATE),
        "StartDateKey": date_key(om.START_DATE), "EndDateKey": date_key(om.END_DATE),
        "OrderStatus": om.ORDER_STATUS_C.map(names("ZC_ORDER_STATUS")), "Refills": om.REFILLS,
    })

    res = c["ORDER_RESULTS"].reset_index(drop=True)
    res_proc = res.ORDER_PROC_ID.map(op.set_index("ORDER_PROC_ID").PROC_ID)
    flag = res.RESULT_FLAG_C.map(names("ZC_RESULT_FLAG"))
    cab["LabComponentResultFact"] = pd.DataFrame({
        "LabComponentResultKey": np.arange(1, len(res) + 1), "LabOrderEpicId": res.ORDER_PROC_ID,
        "PatientKey": k(res.PAT_ID, pat_key), "PatientDurableKey": k(res.PAT_ID, pat_key),
        "EncounterKey": k(res.PAT_ENC_CSN_ID, enc_key), "LabComponentKey": k(res.COMPONENT_ID, comp_key),
        "ProcedureKey": k(res_proc, proc_key), "ResultDateKey": date_key(res.RESULT_TIME),
        "ResultInstant": res.RESULT_TIME, "Value": res.ORD_VALUE, "NumericValue": res.ORD_NUM_VALUE,
        "Unit": res.REFERENCE_UNIT, "Flag": flag, "ReferenceLow": res.REFERENCE_LOW,
        "ReferenceHigh": res.REFERENCE_HIGH, "IsAbnormal": flag.notna().astype(int),
    })

    meas = c["IP_FLWSHT_MEAS"].reset_index(drop=True)
    meas = meas.merge(c["IP_FLWSHT_REC"][["FSD_ID", "PAT_ID", "PAT_ENC_CSN_ID"]], on="FSD_ID", suffixes=("_M", ""))
    is_bp = meas.FLO_MEAS_ID == ref.BP_ROW[0]
    bp = meas[is_bp]
    parts = bp.MEAS_VALUE.str.split("/", expand=True)
    flat = pd.concat([
        meas[~is_bp].assign(ROW=meas.FLO_MEAS_ID, VAL=meas.MEAS_VALUE),
        bp.assign(ROW="5-SYS", VAL=parts[0]), bp.assign(ROW="5-DIA", VAL=parts[1]),
    ], ignore_index=True).sort_values(["PAT_ENC_CSN_ID", "RECORDED_TIME", "ROW"], kind="mergesort").reset_index(drop=True)
    cab["FlowsheetValueFact"] = pd.DataFrame({
        "FlowsheetValueKey": np.arange(1, len(flat) + 1), "PatientKey": k(flat.PAT_ID, pat_key),
        "PatientDurableKey": k(flat.PAT_ID, pat_key), "EncounterKey": k(flat.PAT_ENC_CSN_ID, enc_key),
        "FlowsheetRowKey": k(flat.ROW, flo_key), "DateKey": date_key(flat.RECORDED_TIME),
        "TakenInstant": flat.RECORDED_TIME, "Value": flat.VAL, "NumericValue": pd.to_numeric(flat.VAL, errors="coerce"),
    })


def write_crosswalks(pat, img, imaging, lidc_subjects, pathology_cases):
    """Local link tables for the PACS and document stages (not loaded into Bronze_Clarity)."""
    folder = GEN_DIR / "crosswalk"
    folder.mkdir(parents=True, exist_ok=True)
    pat[["Id", "PAT_ID", "PAT_MRN_ID", "PAT_FIRST_NAME", "PAT_LAST_NAME", "BIRTH_DATE", "SEX_C"]].rename(
        columns={"Id": "SYNTHEA_PATIENT_ID"}).to_csv(folder / "patients.csv", index=False, date_format="%Y-%m-%d")
    orders = imaging[["SRC", "SRC_ID", "PAT_ID", "PAT_ENC_CSN_ID", "ORDER_PROC_ID", "ORDER_TYPE_C", "PROC_ID",
                      "ACC_NUM", "MODALITY", "BODYSITE", "PROC_START_TIME", "DESCRIPTION", "AUTHRZING_PROV_ID"]]
    orders = orders.rename(columns={"PROC_START_TIME": "STUDY_DATETIME"})
    sources = img[["Id", "SOP_CODE", "SOURCE_COLLECTION", "SOURCE_PATIENT_ID", "SOURCE_STUDY_UID"]].rename(
        columns={"Id": "SRC_ID"})
    orders = orders.merge(sources, on="SRC_ID", how="left")
    orders.loc[orders.SRC != "imaging_study", ["SOP_CODE", "SOURCE_COLLECTION", "SOURCE_PATIENT_ID",
                                                "SOURCE_STUDY_UID"]] = None
    orders.to_csv(folder / "imaging_orders.csv", index=False)
    pat_id = pat.set_index("Id").PAT_ID
    lidc_subjects.assign(PAT_ID=lidc_subjects.patient.map(pat_id)).to_csv(folder / "lidc_subjects.csv", index=False)
    pathology_cases.assign(PAT_ID=pathology_cases.patient.map(pat_id)).to_csv(folder / "pathology_cases.csv", index=False)
    print(f"  crosswalk: {len(pat):,} patients, {len(orders):,} imaging/pathology orders "
          f"({orders.SOURCE_COLLECTION.notna().sum():,} with source images)")


if __name__ == "__main__":
    main()
