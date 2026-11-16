"""Generates the unstructured layer and uploads it to the documents lakehouse (Bronze_ClinicalDocuments). Runs locally.

- a radiology report for every imaging order (Clarity ORDER_RAD_ACC_NUM), grounded in the patient's Clarity record and,
  for LIDC CTs, the radiologists' nodule annotations
- a surgical pathology report for every digital-pathology case, grounded in the TCGA clinical data of its slide
- progress notes for office visits of the imaging and pathology cohort, citing their problems, medications, vitals,
  results and prior imaging/pathology
- a subset rendered as noisy faxed scans (image-only PDFs) for an OCR demo; their source text is kept as OCR ground truth

Every document also gets a list of ground-truth facts (diagnoses, findings, measurements, assessments) for evaluating
NLP extraction. Outputs: data/generated/documents/ and, in OneLake, the lakehouse Files plus the Delta tables
Tables/document_index and Tables/document_facts.

Usage: 11_generate_documents.py [--no-upload]
"""
import argparse
import hashlib
import io
import json
import math
import shutil
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
from PIL import Image, ImageDraw, ImageFilter, ImageFont

import doc_templates as T
from common import DATA, GEN_DIR, ONELAKE_BLOB, fabric, fabric_list, load_state, onelake_delete_folder, onelake_put, \
    save_state, settings, storage_token
from imaging_sources import IMAGING_RAW

OUT = GEN_DIR / "documents"
FONTS = DATA / "raw" / "fonts"
FONT_URL = "https://github.com/google/fonts/raw/main/ofl/courierprime/CourierPrime-Regular.ttf"
MAX_NOTES = 5000
NOTES_FROM = pd.Timestamp("2010-01-01")  # progress notes cover the EHR era only
SCANNED = {"Progress Note": 250, "Radiology Report": 150, "Pathology Report": 100}
SEX = {"1": "Female", "2": "Male", "3": "Unknown"}
VITAL_ROWS = {"5": "BP", "8": "HR", "9": "RR", "6": "TEMP", "10": "SPO2", "14": "WT", "301070": "BMI"}
NOTE_LABS = ["HEMOGLOBIN A1C", "CREATININE", "EGFR", "LDL CHOLESTEROL", "HEMOGLOBIN", "PSA, TOTAL"]


def seed(*parts) -> np.random.Generator:
    return np.random.default_rng(int(hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()[:12], 16))


def read(table, cols=None, folder="clarity"):
    return pd.read_csv(GEN_DIR / folder / f"{table}.csv.gz", dtype=str, usecols=cols)


class Record:
    """Per-patient lookups over the Clarity tables."""

    def __init__(self):
        print("Loading Clarity records")
        pat = read("PATIENT")
        self.patients = {r.PAT_ID: T.Patient(r.PAT_ID, r.PAT_MRN_ID, r.PAT_LAST_NAME, r.PAT_FIRST_NAME,
                                             pd.Timestamp(r.BIRTH_DATE), SEX.get(r.SEX_C, "Unknown"))
                         for r in pat.itertuples()}
        self.enc = read("PAT_ENC", ["PAT_ENC_CSN_ID", "PAT_ID", "CONTACT_DATE", "ENC_TYPE_C", "DEPARTMENT_ID",
                                    "VISIT_PROV_ID", "APPT_TIME", "INPATIENT_DATA_ID"]).set_index("PAT_ENC_CSN_ID")
        self.enc["APPT_TIME"] = pd.to_datetime(self.enc.APPT_TIME)
        self.dep = read("CLARITY_DEP").set_index("DEPARTMENT_ID")
        self.ser = read("CLARITY_SER").set_index("PROV_ID")
        self.edg = read("CLARITY_EDG").set_index("DX_ID")
        self.enc_types = read("ZC_DISP_ENC_TYPE").set_index("DISP_ENC_TYPE_C").NAME

        pl = read("PROBLEM_LIST")
        pl["start"], pl["end"] = pd.to_datetime(pl.NOTED_DATE), pd.to_datetime(pl.RESOLVED_DATE)
        edx = read("PAT_ENC_DX")
        edx["start"] = pd.to_datetime(edx.CONTACT_DATE)
        edx["end"] = edx.start + pd.Timedelta(days=21)
        cond = pd.concat([pl[["PAT_ID", "DX_ID", "start", "end"]].assign(acute=False),
                          edx[["PAT_ID", "DX_ID", "start", "end"]].assign(acute=True)], ignore_index=True)
        cond["snomed"] = cond.DX_ID.map(self.edg.SNOMED_CT_CODE)
        self.cond = dict(tuple(cond.groupby("PAT_ID")))
        self.problems = dict(tuple(pl.groupby("PAT_ID")))
        self.primary_dx = edx[edx.PRIMARY_DX_YN == "Y"].set_index("PAT_ENC_CSN_ID").DX_ID.map(self.edg.DX_NAME)

        meds = read("ORDER_MED", ["PAT_ID", "MEDICATION_ID", "START_DATE", "END_DATE"])
        meds["start"], meds["end"] = pd.to_datetime(meds.START_DATE), pd.to_datetime(meds.END_DATE)
        cm = read("CLARITY_MEDICATION").set_index("MEDICATION_ID")
        label = cm.GENERIC_NAME.str.strip() + " " + cm.STRENGTH.fillna("").str.lower() + " " + cm.FORM.fillna("").str.lower()
        meds["label"] = meds.MEDICATION_ID.map(label.str.replace(r"\s+", " ", regex=True).str.strip())
        self.meds = dict(tuple(meds.groupby("PAT_ID")))

        res = read("ORDER_RESULTS", ["PAT_ID", "COMPONENT_ID", "RESULT_TIME", "ORD_VALUE", "REFERENCE_UNIT",
                                     "RESULT_FLAG_C"])
        comp = read("CLARITY_COMPONENT").set_index("COMPONENT_ID").NAME
        res["name"] = res.COMPONENT_ID.map(comp)
        res = res[res.name.isin(NOTE_LABS + ["ESTROGEN RECEPTOR AG IN BREAST CANCER SPECIMEN BY IMMUNE STAIN",
                                             "PROGESTERONE RECEPTOR AG IN BREAST CANCER SPECIMEN BY IMMUNE STAIN",
                                             "HER2 IN BREAST CANCER SPECIMEN BY IMMUNE STAIN"])].copy()
        res["when"] = pd.to_datetime(res.RESULT_TIME)
        res["flag"] = res.RESULT_FLAG_C.map({"1": "L", "2": "H", "3": "A"})
        self.results = dict(tuple(res.groupby("PAT_ID")))

        rec = read("IP_FLWSHT_REC")
        meas = read("IP_FLWSHT_MEAS").merge(rec[["FSD_ID", "PAT_ID", "INPATIENT_DATA_ID"]], on="FSD_ID")
        meas["when"] = pd.to_datetime(meas.RECORDED_TIME)
        self.flows = dict(tuple(meas.groupby("PAT_ID")))
        # Flowsheet records link to encounters through INPATIENT_DATA_ID
        csn = self.enc.dropna(subset=["INPATIENT_DATA_ID"]).reset_index().set_index("INPATIENT_DATA_ID").PAT_ENC_CSN_ID
        vit = meas[meas.FLO_MEAS_ID.isin(VITAL_ROWS)].copy()
        vit["CSN"] = vit.INPATIENT_DATA_ID.map(csn)
        self.vitals_by_csn = {c: {VITAL_ROWS[r.FLO_MEAS_ID]: r.MEAS_VALUE for r in g.itertuples()}
                              for c, g in vit.groupby("CSN")}

    def has(self, pat_id, when):
        rows = self.cond.get(pat_id)

        def check(group, acute=False):
            if rows is None:
                return False
            hit = rows[rows.snomed.isin(T.C[group])]
            if acute:
                return bool(((hit.start >= when - pd.Timedelta(days=14)) & (hit.start <= when + pd.Timedelta(days=3))).any())
            return bool(((hit.start <= when + pd.Timedelta(days=3)) &
                         (hit.end.isna() | (hit.end >= when - pd.Timedelta(days=1)))).any())
        return check

    def flow(self, pat_id, when):
        rows = self.flows.get(pat_id)
        res = self.results.get(pat_id)

        def lookup(flo_id, days=30):
            if flo_id == "PSA":
                if res is None:
                    return None
                hit = res[(res.name == "PSA, TOTAL") & ((res.when - when).abs() <= pd.Timedelta(days=days))]
            else:
                if rows is None:
                    return None
                hit = rows[(rows.FLO_MEAS_ID == flo_id) & ((rows.when - when).abs() <= pd.Timedelta(days=days))]
            if hit.empty:
                return None
            value = hit.loc[(hit.when - when).abs().idxmin()]
            value = value.ORD_VALUE if flo_id == "PSA" else value.MEAS_VALUE
            num = pd.to_numeric(value, errors="coerce")
            return num if pd.notna(num) else value
        return lookup

    def context(self, pat_id, when, rng):
        return T.Context(self.patients[pat_id], when, rng, self.has(pat_id, when), self.flow(pat_id, when))

    def provider(self, prov_id, with_specialty=False):
        if prov_id not in self.ser.index:
            return "UNKNOWN PROVIDER"
        s = self.ser.loc[prov_id]
        name = f"{s.PROV_NAME}, {s.CLINICIAN_TITLE}"
        return f"{name} ({s.SPECIALTY})" if with_specialty else s.PROV_NAME

    def campus(self, csn):
        dep = self.enc.DEPARTMENT_ID.get(csn)
        return self.dep.REV_LOC_NAME.get(dep, "CONTOSO MEDICAL CENTER"), dep


def readers(rec: Record, specialty: str) -> dict:
    s = rec.ser[rec.ser.SPECIALTY == specialty]
    by_campus = {}
    for prov_id, row in s.iterrows():
        by_campus.setdefault(rec.dep.REV_LOC_NAME.get(row.PRIMARY_DEPT_ID), []).append(row.PROV_NAME)
    by_campus["*"] = sorted(s.PROV_NAME)
    return by_campus


def radiology(rec: Record, orders: pd.DataFrame, studies: pd.DataFrame):
    nodules = pd.read_csv(IMAGING_RAW / "lidc_nodules.csv")
    nodules = nodules[nodules.readers >= 2]
    nod_by_study = dict(tuple(nodules.groupby("study_uid")))
    lidc_first_ct = {}
    rads = readers(rec, "Diagnostic Radiology")
    study_uid = studies.set_index("AccessionNumber").StudyInstanceUID
    orders = orders[orders.MODALITY != "SM"].copy()
    orders["when"] = pd.to_datetime(orders.STUDY_DATETIME)
    orders = orders.sort_values(["PAT_ID", "when"])
    tumors, ct_index, docs, summaries = {}, {}, [], {}

    for o in orders.itertuples():
        pat, when = o.PAT_ID, o.when
        rng = seed("rad", o.ACC_NUM)
        ctx = rec.context(pat, when, rng)
        campus, _ = rec.campus(o.PAT_ENC_CSN_ID)
        prior = orders[(orders.PAT_ID == pat) & (orders.DESCRIPTION == o.DESCRIPTION) & (orders.when < when)]
        comparison = f"{T.exam_name(o.DESCRIPTION)} dated {T.d(prior.when.iloc[-1])}." if len(prior) else "None."
        study = {"acc": o.ACC_NUM, "desc": o.DESCRIPTION, "when": when, "campus": campus,
                 "ordering": rec.provider(o.AUTHRZING_PROV_ID), "comparison": comparison}
        reason = rec.primary_dx.get(o.PAT_ENC_CSN_ID)
        indication = f"{reason}." if isinstance(reason, str) else None
        desc, extra = o.DESCRIPTION, ""
        uid = study_uid.get(o.ACC_NUM)

        if o.SOURCE_COLLECTION == "lidc_idri" and o.MODALITY == "CT":
            nod = nod_by_study.get(uid, nodules.iloc[0:0])
            screening = "SCREENING" in desc
            lidc_first_ct.setdefault(pat, nod)
            sections = T.ct_chest_screening(ctx, nod, screening, prior if len(prior) else None)
            if screening:
                status = "Current smoker" if reason and "daily" in reason.lower() else "Former smoker"
                indication = f"Lung cancer screening. {status}, asymptomatic."
        elif o.SOURCE_COLLECTION == "lidc_idri":
            nod = None
            ct = orders[(orders.PAT_ID == pat) & (orders.SOURCE_COLLECTION == "lidc_idri") & (orders.MODALITY == "CT")]
            if len(ct):
                nod = nod_by_study.get(study_uid.get(ct.ACC_NUM.iloc[0]))
            sections = T.chest_xray(ctx, 2 if "2 VIEWS" in desc else 1, nod)
        elif o.MODALITY == "CT" and "ABDOMEN" in desc:
            sections = T.ct_chest_abdomen(ctx)
        elif o.MODALITY == "CT":
            if pat not in tumors:
                r = seed("tumor", pat)
                small = ctx.has("sclc")
                tumors[pat] = {"lobe": T.pick(r, ["right upper lobe", "left upper lobe", "right lower lobe",
                                                    "right middle lobe", "left lower lobe"]),
                               "size": float(r.uniform(28, 55)), "histology": "small cell" if small else "non-small cell"}
            k = ct_index.get(pat, 0)
            ct_index[pat] = k + 1
            sections = T.ct_chest_oncology(ctx, tumors[pat], k, prior if len(prior) else None)
        elif o.MODALITY in ("CR", "DX") and (o.BODYSITE == "Chest" or "CHEST" in desc):
            sections = T.chest_xray(ctx, 1 if "1 VIEW" in desc or "PLAIN" in desc else 2, None)
        elif o.MODALITY == "DX":
            part = {"Ankle": "ANKLE", "Wrist": "WRIST", "Arm": "HUMERUS", "Clavicle": "CLAVICLE", "Knee": "KNEE",
                    "Pelvis": "PELVIS"}[o.BODYSITE]
            sections = T.extremity_xray(ctx, part)
        elif "ECHO" in desc:
            sections = T.echo(ctx)
            indication = indication or "Evaluate left ventricular function."
        elif "FETAL" in desc:
            sections = T.fetal_us(ctx)
            indication = indication or "First trimester pregnancy, confirm viability."
        elif "BREASTS" in desc:
            sections = T.mammogram(ctx, False, ultrasound=True)
        elif o.MODALITY == "MG":
            sections = T.mammogram(ctx, "SCREENING" in desc or desc == "MAMMOGRAPHY")
            indication = indication or "Screening mammogram."
        elif "RIGHT UPPER QUADRANT" in desc:
            sections = T.us_ruq(ctx)
        elif o.MODALITY == "BMD" or "BONE DENSITY" in desc:
            sections = T.dxa(ctx)
            indication = indication or "Osteoporosis screening."
        elif "BREAST" in desc:
            sections = T.mri_breast(ctx)
        else:
            tech, find, imp, extra = T.mri_brain(ctx, volumetric="VOLUME" in desc)
            sections = (tech, find, imp)
            indication = indication or "Cognitive decline."
        indication = (indication or "Clinical correlation.") + extra
        names = rads.get(campus) or rads["*"]
        radiologist = T.pick(seed("reader", o.ACC_NUM), names)
        style = int(hashlib.md5(radiologist.encode()).hexdigest(), 16) % 2
        text, signed = T.radiology_report(ctx, study, sections, radiologist, style, indication)
        summaries.setdefault(pat, []).append((when, f"{T.exam_name(desc)} on {T.d(when)}: {sections[2][0]}"))
        docs.append({"DocumentId": f"RAD-{o.ACC_NUM}", "DocumentType": "Radiology Report", "PAT_ID": pat,
                     "PAT_ENC_CSN_ID": o.PAT_ENC_CSN_ID, "ORDER_PROC_ID": o.ORDER_PROC_ID,
                     "AccessionNumber": o.ACC_NUM, "StudyInstanceUID": uid, "ServiceDateTime": when,
                     "DocumentDateTime": signed, "AuthorName": f"{radiologist}, MD", "Title": f"{T.exam_name(desc)} report",
                     "Department": "Radiology", "Campus": campus, "text": text, "facts": ctx.facts})
    return docs, summaries


def pathology(rec: Record, orders: pd.DataFrame, studies: pd.DataFrame):
    cases = pd.read_csv(GEN_DIR / "crosswalk" / "pathology_cases.csv", dtype=str)
    tcga = pd.read_csv(IMAGING_RAW / "tcga_slides.csv", dtype=str).set_index("SeriesInstanceUID")
    sm = orders[orders.MODALITY == "SM"].set_index(["PAT_ID", "SOURCE_PATIENT_ID"])
    paths = readers(rec, "Pathology")
    study_uid = studies.set_index("AccessionNumber").StudyInstanceUID
    docs, summaries = [], {}
    for c in cases.itertuples():
        o = sm.loc[(c.PAT_ID, c.tcga_patient)]
        when = pd.Timestamp(o.STUDY_DATETIME)
        collected = rec.enc.APPT_TIME.get(o.PAT_ENC_CSN_ID, when)
        rng = seed("path", o.ACC_NUM)
        ctx = rec.context(c.PAT_ID, when, rng)
        campus, _ = rec.campus(o.PAT_ENC_CSN_ID)
        res = rec.results.get(c.PAT_ID)
        receptors = {}
        if res is not None:
            near = res[(res.when - when).abs() <= pd.Timedelta(days=60)]
            for marker, key in (("ER", "ESTROGEN"), ("PR", "PROGESTERONE"), ("HER2", "HER2")):
                hit = near[near.name.str.startswith(key)]
                if len(hit):
                    receptors[marker] = str(hit.ORD_VALUE.iloc[0]).lower().replace(" (qualifier value)", "")
        study = {"acc": o.ACC_NUM, "when": when, "collected": collected, "campus": campus,
                 "ordering": rec.provider(o.AUTHRZING_PROV_ID)}
        pathologist = T.pick(seed("pathologist", o.ACC_NUM), paths.get(campus) or paths["*"])
        text, signed = T.pathology_report(ctx, c._asdict(), tcga.loc[c.slide_series_uid].to_dict(), study,
                                          pathologist, receptors)
        dx = next((f["text"] for f in ctx.facts if f["type"] == "diagnosis"), "carcinoma")
        summaries.setdefault(c.PAT_ID, []).append((when, f"{c.specimen.title()} on {T.d(collected)} showed {dx}."))
        docs.append({"DocumentId": f"PATH-{o.ACC_NUM}", "DocumentType": "Pathology Report", "PAT_ID": c.PAT_ID,
                     "PAT_ENC_CSN_ID": o.PAT_ENC_CSN_ID, "ORDER_PROC_ID": o.ORDER_PROC_ID, "AccessionNumber": o.ACC_NUM,
                     "StudyInstanceUID": study_uid.get(o.ACC_NUM), "ServiceDateTime": collected,
                     "DocumentDateTime": signed, "AuthorName": f"{pathologist}, MD",
                     "Title": f"Surgical pathology: {c.specimen.title()}", "Department": "Pathology", "Campus": campus,
                     "text": text, "facts": ctx.facts})
    return docs, summaries


def notes(rec: Record, cohort: set, summaries: dict):
    enc = rec.enc[rec.enc.PAT_ID.isin(cohort) & rec.enc.ENC_TYPE_C.isin(["101", "2101"])].copy()
    enc["prov_specialty"] = enc.VISIT_PROV_ID.map(rec.ser.SPECIALTY)
    enc = enc[~enc.prov_specialty.isin(["Diagnostic Radiology", "Pathology"])]
    enc = enc.reset_index().sort_values(["PAT_ID", "APPT_TIME"])
    # Up to four visits per patient, from a year before their first imaging/pathology event onwards (EHR era only)
    first_event = {p: min(t for t, _ in s) for p, s in summaries.items()}
    enc["event"] = enc.PAT_ID.map(first_event)
    enc = enc[(enc.APPT_TIME >= enc.event - pd.Timedelta(days=365)) & (enc.APPT_TIME >= NOTES_FROM)]
    chosen = enc.groupby("PAT_ID").head(4)
    if len(chosen) > MAX_NOTES:
        chosen = chosen.sample(MAX_NOTES, random_state=7).sort_values(["PAT_ID", "APPT_TIME"])
    docs = []
    for v in chosen.itertuples():
        when = v.APPT_TIME
        rng = seed("note", v.PAT_ENC_CSN_ID)
        ctx = rec.context(v.PAT_ID, when, rng)
        campus, dep = rec.campus(v.PAT_ENC_CSN_ID)
        dept = rec.dep.DEPARTMENT_NAME.get(dep, "PRIMARY CARE").split(" ", 1)[-1]
        pl = rec.problems.get(v.PAT_ID)
        problems = []
        if pl is not None:
            active = pl[(pl.start <= when) & (pl.end.isna() | (pl.end > when))].sort_values("start")
            for dx in active.DX_ID.drop_duplicates():
                problems.append({"name": rec.edg.DX_NAME.get(dx), "icd": rec.edg.CURRENT_ICD10_LIST.get(dx)})
        problems = [p for p in problems if isinstance(p["icd"], str)]
        md = rec.meds.get(v.PAT_ID)
        meds = []
        if md is not None:
            act = md[(md.start <= when) & (md.end.isna() | (md.end >= when))]
            meds = sorted({m for m in act.label.dropna()})[:10]
        res = rec.results.get(v.PAT_ID)
        labs = []
        if res is not None:
            recent = res[(res.when <= when) & (res.when >= when - pd.Timedelta(days=180)) & res.name.isin(NOTE_LABS)]
            for name, g in recent.sort_values("when").groupby("name"):
                last = g.iloc[-1]
                labs.append({"name": name, "value": last.ORD_VALUE, "unit": last.REFERENCE_UNIT or "",
                             "flag": last.flag if isinstance(last.flag, str) else "", "when": last.when})
                ctx.fact("lab", name, value=last.ORD_VALUE, unit=last.REFERENCE_UNIT)
        vitals = rec.vitals_by_csn.get(v.PAT_ENC_CSN_ID, {})
        smoking = ctx.flow("1570006", days=3650) or "Never smoker"
        prior = [s for t, s in sorted(summaries.get(v.PAT_ID, [])) if when - pd.Timedelta(days=730) <= t <= when][-2:]
        visit = {"when": when, "dept": dept, "campus": campus, "smoking": smoking,
                 "type": rec.enc_types.get(v.ENC_TYPE_C, "Office Visit"),
                 "reason": (rec.primary_dx.get(v.PAT_ENC_CSN_ID) or "") + ("." if rec.primary_dx.get(
                     v.PAT_ENC_CSN_ID) else "")}
        provider = rec.provider(v.VISIT_PROV_ID, with_specialty=True)
        text, signed = T.progress_note(ctx, visit, problems, meds, vitals, labs, prior, provider)
        docs.append({"DocumentId": f"NOTE-{v.PAT_ENC_CSN_ID}", "DocumentType": "Progress Note", "PAT_ID": v.PAT_ID,
                     "PAT_ENC_CSN_ID": v.PAT_ENC_CSN_ID, "ORDER_PROC_ID": None, "AccessionNumber": None,
                     "StudyInstanceUID": None, "ServiceDateTime": when, "DocumentDateTime": signed,
                     "AuthorName": provider.split(" (")[0], "Title": f"{dept.title()} progress note",
                     "Department": dept.title(), "Campus": campus, "text": text, "facts": ctx.facts})
    return docs


# --- Scanned documents ---------------------------------------------------------------------------------

def font(size):
    path = FONTS / "CourierPrime-Regular.ttf"
    if not path.exists():
        import requests
        FONTS.mkdir(parents=True, exist_ok=True)
        path.write_bytes(requests.get(FONT_URL, timeout=60).content)
    return ImageFont.truetype(str(path), size)


def wrap(text, width=82):
    import textwrap
    lines = []
    for line in text.splitlines():
        lines.extend(textwrap.wrap(line, width, subsequent_indent="  " if line.startswith("- ") else "") or [""])
    return lines


def render_scan(text: str, doc: dict, rng) -> bytes:
    """Renders text as a faxed, slightly skewed and noisy grayscale scan, returned as an image-only PDF."""
    dpi, w, h, margin, size = 150, 1275, 1650, 95, 21
    f, small = font(size), font(16)
    lines = wrap(text)
    per_page = int((h - 2 * margin - 40) / (size * 1.32))
    pages = math.ceil(len(lines) / per_page)
    sent = doc["DocumentDateTime"] + pd.Timedelta(days=int(rng.integers(1, 30)), minutes=int(rng.integers(0, 600)))
    images = []
    for i in range(pages):
        img = Image.new("L", (w, h), 255)
        draw = ImageDraw.Draw(img)
        draw.text((margin - 40, 28), f"FROM: (617) 555-01{int(rng.integers(10, 99))}   {sent:%m/%d/%Y %I:%M %p}   "
                                     f"CONTOSO HEALTH HIM          P.{i + 1:03d}/{pages:03d}", font=small, fill=40)
        y = margin
        for line in lines[i * per_page:(i + 1) * per_page]:
            draw.text((margin, y), line, font=f, fill=int(rng.integers(0, 45)))
            y += int(size * 1.32)
        img = img.rotate(float(rng.uniform(-1.4, 1.4)), resample=Image.BICUBIC, fillcolor=255, expand=False)
        img = img.filter(ImageFilter.GaussianBlur(float(rng.uniform(0.4, 0.9))))
        arr = np.asarray(img, dtype=np.int16)
        arr = arr + rng.normal(0, 9, arr.shape).astype(np.int16)
        speck = rng.random(arr.shape)
        arr[speck < 0.0015] = 0
        arr[(speck > 0.9985)] = 255
        streak = int(rng.integers(0, h))
        arr[streak:streak + 2, :] = np.minimum(arr[streak:streak + 2, :], 150)
        img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "L")
        if rng.random() < 0.35:
            img = img.point(lambda p: 0 if p < 150 else 255, mode="1").convert("L")
        images.append(img)
    buf = io.BytesIO()
    images[0].save(buf, "PDF", save_all=True, append_images=images[1:], resolution=dpi, quality=70)
    return buf.getvalue()


# --- Output --------------------------------------------------------------------------------------------

def ensure_lakehouse():
    state = load_state()
    ws_id, name = state["workspace_id"], settings()["LAKEHOUSE_DOCUMENTS"]
    lh = next((x for x in fabric_list(f"/workspaces/{ws_id}/lakehouses") if x["displayName"] == name), None)
    if lh is None:
        lh = fabric("POST", f"/workspaces/{ws_id}/lakehouses", {
            "displayName": name, "description": "Raw unstructured clinical documents: reports, notes and scanned records."})
        print(f"Created lakehouse {name}")
    save_state(lakehouses={**state["lakehouses"], name: lh["id"]})
    return ws_id, lh["id"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    args = parser.parse_args()

    rec = Record()
    orders = pd.read_csv(GEN_DIR / "crosswalk" / "imaging_orders.csv", dtype=str)
    studies = pd.read_csv(GEN_DIR / "pacs" / "studies.csv", dtype=str, usecols=["AccessionNumber", "StudyInstanceUID"])
    print("Writing radiology reports")
    rad_docs, summaries = radiology(rec, orders, studies)
    print("Writing pathology reports")
    path_docs, path_summaries = pathology(rec, orders, studies)
    for pat, items in path_summaries.items():
        summaries.setdefault(pat, []).extend(items)
    online = orders[orders.SOURCE_COLLECTION.notna()]
    print("Writing progress notes")
    note_docs = notes(rec, set(online.PAT_ID), summaries)
    docs = pd.DataFrame(rad_docs + path_docs + note_docs)

    # Pick the documents that exist only as faxed scans
    docs["IsScanned"] = False
    for kind, n in SCANNED.items():
        pool = docs[docs.DocumentType == kind]
        docs.loc[pool.sample(min(n, len(pool)), random_state=11).index, "IsScanned"] = True

    folders = {"Radiology Report": "radiology_reports", "Pathology Report": "pathology_reports",
               "Progress Note": "progress_notes"}
    shutil.rmtree(OUT, ignore_errors=True)
    files, fact_rows = [], []
    for r in docs.itertuples():
        year = f"{pd.Timestamp(r.ServiceDateTime).year}"
        if r.IsScanned:
            rel = f"scanned_documents/{year}/{r.DocumentId}.pdf"
            data = render_scan(r.text, r._asdict(), seed("scan", r.DocumentId))
            truth = f"ground_truth/ocr/{r.DocumentId}.txt"
            files.append((truth, r.text.encode(), "text/plain"))
            docs.loc[r.Index, "GroundTruthTextPath"] = f"Files/{truth}"
            ctype = "application/pdf"
        else:
            rel = f"{folders[r.DocumentType]}/{year}/{r.DocumentId}.txt"
            data, ctype = r.text.encode(), "text/plain"
        files.append((rel, data, ctype))
        docs.loc[r.Index, "OneLakePath"] = f"Files/{rel}"
        docs.loc[r.Index, "Format"] = "PDF (scanned image)" if r.IsScanned else "Text"
        docs.loc[r.Index, "SizeBytes"] = len(data)
        for i, f in enumerate(r.facts, start=1):
            fact_rows.append({"DocumentId": r.DocumentId, "FactNumber": i, "FactType": f["type"], "Text": f["text"],
                              "Code": f.get("code"), "Value": None if f.get("value") is None else str(f["value"]),
                              "Unit": f.get("unit"), "Site": f.get("site"), "Laterality": f.get("laterality"),
                              "System": f.get("system")})
    for rel, data, _ in files:
        path = OUT / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    docs["Mrn"] = docs.PAT_ID.map(lambda p: rec.patients[p].mrn)
    docs["Words"] = docs.text.str.split().str.len()
    index = docs[["DocumentId", "DocumentType", "Title", "Format", "IsScanned", "PAT_ID", "Mrn", "PAT_ENC_CSN_ID",
                  "ORDER_PROC_ID", "AccessionNumber", "StudyInstanceUID", "ServiceDateTime", "DocumentDateTime",
                  "AuthorName", "Department", "Campus", "OneLakePath", "GroundTruthTextPath", "SizeBytes", "Words"]].copy()
    for col in ("ServiceDateTime", "DocumentDateTime"):
        index[col] = pd.to_datetime(index[col]).dt.floor("s")
    index["SizeBytes"] = index.SizeBytes.astype("int64")
    facts = pd.DataFrame(fact_rows)
    index.to_csv(OUT / "document_index.csv", index=False)
    facts.to_csv(OUT / "document_facts.csv", index=False)
    print(docs.groupby(["DocumentType", "IsScanned"]).size().to_string())
    print(f"{len(facts):,} ground-truth facts; {sum(len(d) for _, d, _ in files) / 1e6:.0f} MB in {len(files):,} files")

    if args.no_upload:
        return
    ws_id, lh_id = ensure_lakehouse()
    for folder in ("radiology_reports", "pathology_reports", "progress_notes", "scanned_documents", "ground_truth"):
        onelake_delete_folder(ws_id, lh_id, f"Files/{folder}")
    storage_token()
    base = f"{ONELAKE_BLOB}/{ws_id}/{lh_id}/Files"
    with ThreadPoolExecutor(24) as pool:
        for f in [pool.submit(onelake_put, f"{base}/{rel}", data, ctype) for rel, data, ctype in files]:
            f.result()
    print(f"Uploaded {len(files):,} files to {settings()['LAKEHOUSE_DOCUMENTS']}/Files")

    from deltalake import write_deltalake
    opts = {"bearer_token": storage_token(), "use_fabric_endpoint": "true"}
    root = f"abfss://{ws_id}@onelake.dfs.fabric.microsoft.com/{lh_id}/Tables"
    write_deltalake(f"{root}/document_index", index, mode="overwrite", schema_mode="overwrite", storage_options=opts)
    write_deltalake(f"{root}/document_facts", facts, mode="overwrite", schema_mode="overwrite", storage_options=opts)
    endpoint = fabric("GET", f"/workspaces/{ws_id}/lakehouses/{lh_id}")["properties"].get("sqlEndpointProperties", {})
    if endpoint.get("id"):
        fabric("POST", f"/workspaces/{ws_id}/sqlEndpoints/{endpoint['id']}/refreshMetadata", {})
    print("Delta tables document_index and document_facts written")


if __name__ == "__main__":
    main()
