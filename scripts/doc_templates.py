"""Template-based clinical writing for the unstructured layer: radiology reports, pathology reports and progress notes.

Every document is built from structured facts (Clarity records, LIDC nodule annotations, TCGA clinical data) and
returns (text, facts). The facts list is the ground truth an NLP pipeline should be able to extract. Wording varies
deterministically per document so the corpus doesn't read as one template.
"""
from dataclasses import dataclass, field

import pandas as pd

# SNOMED CT condition groups used to ground findings
C = {
    "pneumonia": {"233604007"}, "chf": {"88805009"}, "emphysema": {"87433001"}, "copd": {"185086009"},
    "chd": {"53741008"}, "mi": {"22298006", "399211009"}, "afib": {"49436004"}, "htn": {"59621000"},
    "rib_fx": {"33737001"}, "nsclc": {"254637007", "424132000"}, "sclc": {"254632001", "67811000119102"},
    "lung_suspect": {"162573006"}, "breast_ca": {"254837009"}, "alzheimers": {"26929004", "230265002"},
    "stroke": {"230690007"}, "microhem": {"723857007"}, "cognition": {"386806002"}, "fx_forearm": {"65966004"},
    "fx_wrist": {"263102004"}, "sprain_wrist": {"70704007"}, "fx_ankle": {"16114001"}, "sprain_ankle": {"44465007"},
    "fx_clavicle": {"58150001"}, "fx_hip": {"359817006"}, "oa_knee": {"239873007"}, "oa_hip": {"239872002"},
    "osteoporosis": {"64859006"}, "path_fx": {"443165006"}, "knee_injury": {"444448004", "444470001", "239720000"},
    "pregnancy": {"72892002"}, "miscarriage": {"19169002"}, "blighted": {"35999006"}, "tubal": {"79586000"},
    "gallstones": {"235919008"}, "cholecystitis": {"65275009"}, "prostate_mets": {"314994000"},
    "colon_mets": {"94260004"}, "ckd": {"431855005", "431856006", "433144002", "46177005"}, "smoker": {"449868002"},
    "nodule": {"427359005", "786838002"}, "concussion": {"62106007", "62564004", "110030002"},
    "seizure": {"128613002", "84757009"}, "migraine": {"124171000119105"},
}


def pick(rng, options):
    return options[int(rng.integers(len(options)))]


def d(ts) -> str:
    return pd.Timestamp(ts).strftime("%m/%d/%Y") if pd.notna(ts) else ""


def dt(ts) -> str:
    return pd.Timestamp(ts).strftime("%m/%d/%Y %H:%M") if pd.notna(ts) else ""


EXAM_WORDS = {"Xr": "X-ray", "Ct": "CT", "Mri": "MRI", "Us": "US", "Lv": "LV"}
LAB_NAMES = {"HEMOGLOBIN A1C": "Hemoglobin A1c", "EGFR": "eGFR", "LDL CHOLESTEROL": "LDL cholesterol",
             "PSA, TOTAL": "PSA", "CREATININE": "Creatinine", "HEMOGLOBIN": "Hemoglobin"}


def exam_name(desc: str) -> str:
    return " ".join(EXAM_WORDS.get(w, w) for w in desc.title().split())


def mm(value) -> str:
    return f"{value:.0f} mm" if value >= 3 else f"{value:.1f} mm"


@dataclass
class Patient:
    pat_id: str
    mrn: str
    last: str
    first: str
    dob: pd.Timestamp
    sex: str  # Male / Female

    def age(self, at) -> int:
        at = pd.Timestamp(at)
        return at.year - self.dob.year - ((at.month, at.day) < (self.dob.month, self.dob.day))

    def noun(self, at):
        age = self.age(at)
        if age < 18:
            return "boy" if self.sex == "Male" else "girl"
        return "man" if self.sex == "Male" else "woman"


@dataclass
class Context:
    patient: Patient
    when: pd.Timestamp
    rng: object
    has: object               # has(group, acute=False) -> bool
    flow: object              # flow(flo_meas_id, days=..) -> value or None
    facts: list = field(default_factory=list)

    def fact(self, kind, text, **kw):
        self.facts.append({"type": kind, "text": text, **{k: v for k, v in kw.items() if v is not None}})


def banner(dept, campus, title):
    return f"CONTOSO HEALTH\n{dept} | {campus}\n\n{title}\n"


def patient_block(p: Patient, at, extra_left, extra_right):
    lines = [f"Patient: {p.last.upper()}, {p.first.upper()}".ljust(46) + f"MRN: {p.mrn}",
             f"DOB: {d(p.dob)}  Age: {p.age(at)}  Sex: {p.sex}".ljust(46) + extra_right[0]]
    for left, right in zip(extra_left, extra_right[1:] + [""] * len(extra_left)):
        lines.append(left.ljust(46) + right if right else left)
    return "\n".join(lines) + "\n"


# --- Radiology ----------------------------------------------------------------------------------------

LUNG_RADS_TEXT = {
    "1": ("Negative", "Continue annual screening with low-dose CT in 12 months."),
    "2": ("Benign appearance or behavior", "Continue annual screening with low-dose CT in 12 months."),
    "3": ("Probably benign", "Recommend low-dose chest CT in 6 months."),
    "4A": ("Suspicious", "Recommend low-dose chest CT in 3 months; PET/CT may be considered for solid components 8 mm or larger."),
    "4B": ("Very suspicious", "Recommend diagnostic chest CT with or without contrast, PET/CT and/or tissue sampling."),
    "4X": ("Very suspicious with additional features", "Recommend diagnostic chest CT, PET/CT and/or tissue sampling; consider multidisciplinary thoracic review."),
}


def benign_calcification(n):
    return isinstance(n.calcification, str) and n.calcification != "Absent" and "Non-central" not in n.calcification


def lung_rads(nodules) -> str:
    """Simplified Lung-RADS v2022 baseline category from consensus nodule features."""
    best = "1"
    order = ["1", "2", "3", "4A", "4B", "4X"]
    for n in nodules.itertuples():
        if benign_calcification(n):
            cat = "1"
        elif n.texture == "ground-glass":
            cat = "2" if n.diameter_mm < 30 else "3"
        elif n.texture == "part-solid":
            solid = n.diameter_mm * 0.5
            cat = "2" if n.diameter_mm < 6 else "3" if solid < 6 else "4A" if solid < 8 else "4B"
        else:
            cat = "2" if n.diameter_mm < 6 else "3" if n.diameter_mm < 8 else "4A" if n.diameter_mm < 15 else "4B"
        if cat in ("3", "4A", "4B") and n.spiculation >= 3.5:
            cat = "4X"
        best = max(best, cat, key=order.index)
    return best


def fleischner(nodules) -> str:
    nodules = nodules[[not benign_calcification(n) for n in nodules.itertuples()]]
    if nodules.empty:
        return "Calcified nodules are benign. No follow-up imaging is needed for these findings."
    solid = nodules[nodules.texture == "solid"]
    sub = nodules[nodules.texture != "solid"]
    biggest = nodules.diameter_mm.max()
    if biggest >= 30:
        return "Findings are concerning for primary lung malignancy. Recommend PET/CT and tissue sampling."
    if len(solid) and solid.diameter_mm.max() > 8:
        return "Per Fleischner Society guidelines, consider CT at 3 months, PET/CT, or tissue sampling."
    if len(sub) and sub.diameter_mm.max() >= 6:
        return "Per Fleischner Society guidelines, recommend CT at 6 to 12 months to confirm persistence."
    if biggest >= 6:
        return "Per Fleischner Society guidelines, recommend CT at 6 to 12 months; consider CT at 18 to 24 months if high risk."
    return "Per Fleischner Society guidelines, no routine follow-up is required for a low-risk patient; optional CT at 12 months if high risk."


def describe_nodule(n, rng):
    size = mm(n.diameter_mm)
    if n.diameter_mm >= 30:
        noun = "mass"
    else:
        noun = pick(rng, ["nodule", "nodule", "pulmonary nodule"])
    parts = [f"{size} {n.texture} {noun}"]
    loc = n.lobe if isinstance(n.lobe, str) else "lung"
    text = f"{parts[0]} in the {loc}"
    traits = []
    if isinstance(n.margin, str):
        traits.append(f"{n.margin} margins")
    if n.spiculation >= 3:
        traits.append("spiculation")
    if benign_calcification(n):
        traits.append(f"{'central' if 'Central' in n.calcification else 'dense'} calcification")
    if traits:
        text += " with " + " and ".join(traits)
    return text


def ct_chest_screening(ctx: Context, nodules: pd.DataFrame, screening: bool, prior):
    rng = ctx.rng
    find, imp = [], []
    nod = nodules.sort_values("diameter_mm", ascending=False)
    if len(nod):
        if len(nod) == 1:
            find.append(f"There is a {describe_nodule(nod.iloc[0], rng)}.")
        else:
            find.append(f"There are {len(nod)} pulmonary nodules:")
            for i, n in enumerate(nod.itertuples(), start=1):
                find.append(f"  {i}. {describe_nodule(n, rng).capitalize()} (image {int(rng.integers(40, 260))}).")
        for n in nod.itertuples():
            ctx.fact("finding", f"{n.texture} pulmonary nodule", site=n.lobe, laterality=n.side,
                     value=round(float(n.diameter_mm), 1), unit="mm", code="R91.1" if len(nod) == 1 else "R91.8")
    else:
        find.append(pick(rng, ["No suspicious pulmonary nodules.", "No pulmonary nodules are identified.",
                               "No noncalcified pulmonary nodules."]))
    if ctx.has("emphysema"):
        find.append(pick(rng, ["Centrilobular emphysema, upper lobe predominant.", "Mild centrilobular emphysema."]))
        ctx.fact("finding", "emphysema", code="J43.9")
    elif ctx.has("copd"):
        find.append("Mild bronchial wall thickening.")
    else:
        find.append(pick(rng, ["No consolidation.", "Lungs are otherwise clear.", "No focal consolidation."]))
    find.append(pick(rng, ["No pleural effusion or pneumothorax.", "No pleural effusion. No pneumothorax."]))
    heart = "Heart size is normal." if not ctx.has("chf") else "Mild cardiomegaly."
    if ctx.has("chd") or ctx.has("mi"):
        heart += " Moderate coronary artery calcifications."
        ctx.fact("finding", "coronary artery calcification", code="I25.10")
    find.append(heart + pick(rng, [" No mediastinal or hilar lymphadenopathy.", " No enlarged mediastinal lymph nodes."]))
    find.append(pick(rng, ["Visualized upper abdomen is unremarkable.", "Limited images of the upper abdomen are unremarkable."]))
    find.append(pick(rng, ["No acute osseous abnormality.", "Degenerative changes of the thoracic spine."]))

    significant = nod[[not benign_calcification(n) for n in nod.itertuples()]]
    lead_nodule = significant.iloc[0] if len(significant) else (nod.iloc[0] if len(nod) else None)
    if screening:
        cat = lung_rads(nod)
        label, rec = LUNG_RADS_TEXT[cat]
        lead = f"{describe_nodule(lead_nodule, rng).capitalize()}." if len(nod) else "No suspicious pulmonary nodules."
        imp.append(lead)
        imp.append(f"Lung-RADS category {cat}: {label}. {rec}")
        ctx.fact("assessment", f"Lung-RADS {cat}", system="Lung-RADS v2022", value=cat)
    else:
        if len(nod):
            extra = len(nod) - 1
            imp.append(f"{describe_nodule(lead_nodule, rng).capitalize()}." +
                       (f" {extra} additional nodule{'s' if extra > 1 else ''} as described." if extra else ""))
            imp.append(fleischner(nod))
        else:
            imp.append("No acute cardiopulmonary abnormality. No suspicious pulmonary nodule.")
    if ctx.has("emphysema"):
        imp.append("Emphysema.")
    technique = ("Low-dose helical CT of the chest without intravenous contrast. Axial images reconstructed at "
                 f"{nod.slice_thickness_mm.iloc[0] if len(nod) else 2.5:.2g} mm. CTDIvol {rng.uniform(1.2, 2.9):.1f} mGy."
                 if screening else
                 "Helical CT of the chest without intravenous contrast. Multiplanar reformations were reviewed.")
    return technique, find, imp


def ct_chest_oncology(ctx: Context, tumor: dict, k: int, prior):
    rng = ctx.rng
    size = max(tumor["size"] * (0.94 ** min(k, 12)), tumor["size"] * 0.45)
    prev = max(tumor["size"] * (0.94 ** min(k - 1, 12)), tumor["size"] * 0.45) if k else None
    small = tumor["histology"] == "small cell"
    change = "" if prev is None else (" (previously " + f"{prev / 10:.1f} cm" + "), " +
                                      ("decreased" if size < prev - 0.5 else "stable"))
    find = [f"{'Central' if small else 'Spiculated'} mass in the {tumor['lobe']} measures "
            f"{size / 10:.1f} x {size * 0.8 / 10:.1f} cm{change}."]
    ctx.fact("finding", "lung mass", site=tumor["lobe"], value=round(size / 10, 1), unit="cm",
             code="C34.90")
    nodes = "Enlarged right paratracheal and subcarinal lymph nodes" if small else "Ipsilateral hilar lymph node"
    find.append(f"{nodes} {'have decreased in size' if k > 2 else 'measure up to 1.6 cm in short axis'}.")
    if ctx.has("emphysema"):
        find.append("Background centrilobular emphysema.")
    find.append(pick(rng, ["No new pulmonary nodules.", "No new suspicious pulmonary nodules."]))
    find.append(pick(rng, ["No pleural effusion.", "Trace pleural effusion, unchanged."]))
    find.append("No suspicious osseous lesion.")
    imp = [f"Known {tumor['histology']} lung cancer, {tumor['lobe']} primary, "
           + ("baseline measurement." if prior is None else
              ("partial response with decreased size." if k and size < prev - 0.5 else "stable disease."))]
    ctx.fact("diagnosis", f"{tumor['histology']} lung cancer", code="C34.90")
    return "Helical CT of the chest without intravenous contrast.", find, imp


def ct_chest_abdomen(ctx: Context):
    rng = ctx.rng
    find = ["CHEST: " + pick(rng, ["No suspicious pulmonary nodules.", "Lungs are clear."]) + " No pleural effusion.",
            "ABDOMEN: Liver, spleen, pancreas and adrenal glands are unremarkable. No hydronephrosis.",
            "PELVIS: No pelvic mass or free fluid.",
            "LYMPH NODES: No lymphadenopathy by size criteria.",
            "BONES: No suspicious osseous lesion."]
    imp = ["No evidence of metastatic disease in the chest, abdomen or pelvis."]
    if ctx.has("colon_mets") or ctx.has("prostate_mets"):
        find[1] = "ABDOMEN: Multiple hypoattenuating hepatic lesions, the largest measuring 2.3 cm in segment VII."
        imp = ["Hepatic lesions concerning for metastatic disease."]
        ctx.fact("finding", "hepatic metastases", code="C78.7")
    return "CT of the chest, abdomen and pelvis with intravenous contrast.", find, imp


def chest_xray(ctx: Context, views: int, nodules: pd.DataFrame | None):
    rng = ctx.rng
    find, imp = [], []
    if ctx.has("pneumonia", acute=True):
        lobe = pick(rng, ["right lower lobe", "left lower lobe", "right middle lobe", "lingula"])
        find.append(f"Patchy airspace opacity in the {lobe}.")
        imp.append(f"{lobe.capitalize()} airspace opacity compatible with pneumonia in the appropriate clinical setting.")
        ctx.fact("finding", "pneumonia", site=lobe, code="J18.9")
    big = nodules[nodules.diameter_mm >= 10] if nodules is not None and len(nodules) else None
    if big is not None and len(big):
        n = big.sort_values("diameter_mm").iloc[-1]
        zone = n.lobe.replace(" lobe", "").replace("lingula", "left mid") if isinstance(n.lobe, str) else "right"
        find.append(f"Approximately {n.diameter_mm / 10:.1f} cm nodular opacity projecting over the {zone} lung zone.")
        imp.append("Nodular opacity. Recommend chest CT for further characterization.")
        ctx.fact("finding", "pulmonary nodule", site=n.lobe, value=round(float(n.diameter_mm) / 10, 1), unit="cm",
                 code="R91.1")
    if ctx.has("chf"):
        find.append("Cardiomegaly with mild pulmonary vascular congestion.")
        imp.append("Cardiomegaly with mild vascular congestion.")
        ctx.fact("finding", "cardiomegaly", code="I51.7")
    elif not find:
        find.append(pick(rng, ["The cardiomediastinal silhouette is within normal limits.",
                               "Heart size is normal. Mediastinal contours are normal."]))
    if ctx.has("emphysema") or ctx.has("copd"):
        find.append("The lungs are hyperinflated.")
    if ctx.has("rib_fx", acute=True):
        side = pick(rng, ["right", "left"])
        find.append(f"Minimally displaced fracture of the {side} lateral 7th rib.")
        imp.append(f"Acute {side} 7th rib fracture. No pneumothorax.")
        ctx.fact("finding", "rib fracture", laterality=side, code="S22.39XA")
    find.append(pick(rng, ["No pleural effusion or pneumothorax.", "No pneumothorax. No pleural effusion."]))
    if not imp:
        imp.append(pick(rng, ["No acute cardiopulmonary process.", "No acute cardiopulmonary abnormality."]))
    tech = f"{'PA and lateral' if views >= 2 else 'Single frontal'} view{'s' if views >= 2 else ''} of the chest."
    return tech, find, imp


EXTREMITY = {
    "ANKLE": ("fx_ankle", "sprain_ankle", "distal fibula", "lateral malleolus", "S82.899A",
              "Three views of the {side} ankle."),
    "WRIST": ("fx_wrist", "sprain_wrist", "distal radius", "distal radial metaphysis", "S62.109A",
              "Three views of the {side} wrist."),
    "HUMERUS": ("fx_forearm", None, "radius", "distal radial shaft", "S52.90XA", "Two views of the {side} humerus and forearm."),
    "CLAVICLE": ("fx_clavicle", None, "clavicle", "midshaft clavicle", "S42.009A", "Two views of the {side} clavicle."),
    "KNEE": ("knee_injury", None, "knee", "", "", "Three views of the {side} knee."),
    "PELVIS": ("fx_hip", None, "femoral neck", "femoral neck", "S72.009A", "AP pelvis and frog-leg lateral view of the {side} hip."),
}


def extremity_xray(ctx: Context, part: str):
    rng = ctx.rng
    fx, sprain, bone, site, icd, tech = EXTREMITY[part]
    side = pick(rng, ["right", "left"])
    find, imp = [], []
    if part != "KNEE" and ctx.has(fx, acute=True):
        disp = pick(rng, ["nondisplaced", "minimally displaced", "mildly angulated"])
        find.append(f"There is an acute {disp} fracture of the {side} {site}.")
        find.append("No dislocation. Soft tissue swelling.")
        imp.append(f"Acute {disp} {side} {bone} fracture.")
        ctx.fact("finding", f"{bone} fracture", laterality=side, code=icd)
    elif part == "PELVIS" and ctx.has("oa_hip"):
        find.append(f"Moderate joint space narrowing of the {side} hip with subchondral sclerosis and osteophytes.")
        imp.append(f"Moderate {side} hip osteoarthritis. No fracture.")
        ctx.fact("finding", "osteoarthritis of hip", laterality=side, code="M16.9")
    elif part == "KNEE" and ctx.has("oa_knee"):
        find.append(f"Medial compartment joint space narrowing of the {side} knee with marginal osteophytes.")
        imp.append(f"Moderate {side} knee osteoarthritis.")
        ctx.fact("finding", "osteoarthritis of knee", laterality=side, code="M17.9")
    elif part == "KNEE" and ctx.has(fx, acute=True):
        find.append("Small joint effusion. No fracture or dislocation.")
        imp.append("Joint effusion without fracture. MRI may be considered for internal derangement.")
    else:
        find.append("No acute fracture or dislocation. Joint spaces are preserved.")
        if sprain and ctx.has(sprain, acute=True):
            find.append("Mild soft tissue swelling.")
        imp.append("No acute osseous abnormality.")
    if ctx.has("osteoporosis"):
        find.append("Diffuse osteopenia.")
    return tech.format(side=side), find, imp


def echo(ctx: Context):
    rng = ctx.rng
    ef = ctx.flow("1570008", days=45)
    if ef is None:
        ef = 35 if ctx.has("chf") else round(float(rng.uniform(55, 65)))
    ef = min(max(float(ef), 15.0), 72.0)  # Synthea's LVEF observations include implausible extremes
    find = [f"Left ventricle: normal size. {'Severely' if ef < 30 else 'Moderately' if ef < 40 else 'Mildly' if ef < 50 else 'Normal'}"
            f"{'' if ef >= 50 else ' reduced'} systolic function. Visually estimated LVEF {ef:.0f}%."]
    ctx.fact("measurement", "left ventricular ejection fraction", value=round(ef), unit="%", code="10230-1")
    if ctx.has("mi"):
        find.append("Hypokinesis of the mid to apical anterior wall and apex.")
        ctx.fact("finding", "regional wall motion abnormality", code="I25.2")
    find.append("Right ventricle: normal size and function.")
    find.append("Left atrium: " + ("moderately dilated." if ctx.has("afib") else "normal size."))
    find.append("Mitral valve: " + pick(rng, ["trace regurgitation.", "mild regurgitation.", "structurally normal."]))
    find.append("Aortic valve: trileaflet, no stenosis.")
    find.append("Pericardium: no effusion.")
    imp = [f"LVEF {ef:.0f}%" + (" with reduced systolic function." if ef < 50 else ", normal systolic function.")]
    if ctx.has("afib"):
        imp.append("Moderate left atrial enlargement.")
    return "Complete transthoracic echocardiogram with 2D, M-mode, color and spectral Doppler.", find, imp


def fetal_us(ctx: Context):
    rng = ctx.rng
    if ctx.has("tubal", acute=True):
        side = pick(rng, ["right", "left"])
        find = ["No intrauterine gestational sac.", f"Complex {side} adnexal mass measuring 2.8 cm separate from the ovary.",
                "Small volume complex free fluid in the pelvis."]
        ctx.fact("finding", "ectopic pregnancy", laterality=side, code="O00.109")
        return "Transabdominal and transvaginal pelvic ultrasound.", find, [
            f"Findings concerning for {side} tubal ectopic pregnancy. Results discussed with the ordering provider."]
    weeks = int(rng.integers(7, 12))
    days = int(rng.integers(0, 7))
    crl = round(2.5 + (weeks - 6) * 7 + days)
    if ctx.has("blighted", acute=True) or ctx.has("miscarriage", acute=True):
        find = [f"Intrauterine gestational sac with mean sac diameter of {int(rng.integers(26, 34))} mm.",
                "No yolk sac or embryo identified."]
        ctx.fact("finding", "failed early pregnancy", code="O02.0")
        return "Transvaginal pelvic ultrasound.", find, ["Findings diagnostic of failed pregnancy (anembryonic gestation)."]
    hr = int(rng.integers(140, 175))
    find = ["Single intrauterine pregnancy.", f"Crown-rump length {crl} mm, corresponding to {weeks} weeks {days} days.",
            f"Fetal cardiac activity present at {hr} beats per minute.", "No subchorionic hemorrhage. Ovaries unremarkable."]
    ctx.fact("measurement", "gestational age", value=f"{weeks}w{days}d")
    ctx.fact("measurement", "fetal heart rate", value=hr, unit="bpm")
    return "Transabdominal and transvaginal pelvic ultrasound.", find, [
        f"Single live intrauterine pregnancy at {weeks} weeks {days} days by crown-rump length."]


def mammogram(ctx: Context, screening: bool, ultrasound=False):
    rng = ctx.rng
    density = pick(rng, ["A", "B", "B", "C", "C", "D"])
    words = {"A": "almost entirely fatty", "B": "scattered areas of fibroglandular density",
             "C": "heterogeneously dense, which may obscure small masses", "D": "extremely dense"}
    side = pick(rng, ["right", "left"])
    clock = f"{int(rng.integers(1, 12))} o'clock"
    if ctx.has("breast_ca"):
        size = round(float(rng.uniform(1.1, 3.2)), 1)
        find = [f"There is a {size} cm irregular mass with spiculated margins in the {side} breast at {clock}, "
                f"{int(rng.integers(3, 9))} cm from the nipple."]
        birads, imp = "5", f"Highly suggestive of malignancy. Ultrasound-guided core biopsy of the {side} breast mass is recommended."
        ctx.fact("finding", "breast mass", laterality=side, value=size, unit="cm", code="N63.0")
    else:
        find = [pick(rng, ["No suspicious mass, architectural distortion or suspicious calcifications.",
                           "Scattered benign-appearing calcifications. No suspicious mass."])]
        birads, imp = ("1", "Negative.") if "No suspicious" in find[0] else ("2", "Benign findings.")
        imp += " Routine annual screening mammography is recommended."
    if not ultrasound:
        find.insert(0, f"Breast composition: {words[density]} (ACR density {density}).")
        ctx.fact("finding", "breast density", value=density, system="ACR BI-RADS")
    ctx.fact("assessment", f"BI-RADS {birads}", system="ACR BI-RADS", value=birads)
    tech = ("Bilateral breast ultrasound." if ultrasound else
            f"Bilateral {'screening' if screening else 'diagnostic'} digital mammography with tomosynthesis, CC and MLO views.")
    return tech, find, [f"BI-RADS {birads}: {imp}"]


def dxa(ctx: Context):
    rng = ctx.rng
    t = ctx.flow("1570013", days=60)
    if t is None:
        t = -2.8 if ctx.has("osteoporosis") else round(float(rng.uniform(-1.8, 0.8)), 1)
    t = float(t)
    neck = round(t - float(rng.uniform(0, 0.5)), 1)
    cls = "osteoporosis" if t <= -2.5 else "osteopenia (low bone mass)" if t < -1 else "normal bone density"
    find = [f"Lumbar spine (L1-L4): BMD {0.95 + t * 0.11:.3f} g/cm2, T-score {t:.1f}.",
            f"Left femoral neck: BMD {0.85 + neck * 0.11:.3f} g/cm2, T-score {neck:.1f}.",
            f"Total left hip: T-score {round((t + neck) / 2, 1):.1f}."]
    ctx.fact("measurement", "lumbar spine T-score", value=t, code="38265-5")
    if t <= -2.5:
        ctx.fact("diagnosis", "osteoporosis", code="M81.0")
    return "Dual-energy x-ray absorptiometry of the lumbar spine and left hip.", find, [
        f"Findings meet WHO criteria for {cls}.",
        "FRAX 10-year probability of hip fracture should be considered." if t < -1 else "Repeat DXA in 2 years."]


def us_ruq(ctx: Context):
    if ctx.has("cholecystitis", acute=True):
        find = ["Gallbladder is distended with multiple shadowing gallstones, wall thickening to 5 mm and pericholecystic fluid.",
                "Positive sonographic Murphy sign.", "Common bile duct measures 4 mm."]
        ctx.fact("finding", "acute cholecystitis", code="K81.0")
        return "Grayscale and color Doppler ultrasound of the right upper quadrant.", find, [
            "Findings consistent with acute calculous cholecystitis."]
    find = ["Multiple mobile shadowing gallstones without gallbladder wall thickening.", "Common bile duct measures 3 mm.",
            "Liver is normal in echotexture."]
    ctx.fact("finding", "cholelithiasis", code="K80.20")
    return "Grayscale ultrasound of the right upper quadrant.", find, ["Cholelithiasis without sonographic evidence of cholecystitis."]


def mri_brain(ctx: Context, volumetric=False):
    rng = ctx.rng
    find, imp = [], []
    mmse = ctx.flow("1570005", days=365)
    if ctx.has("alzheimers"):
        find.append("Moderate generalized parenchymal volume loss, disproportionate bilateral mesial temporal lobe "
                    "and hippocampal atrophy.")
        imp.append("Mesial temporal predominant volume loss, pattern can be seen with Alzheimer disease.")
        ctx.fact("finding", "hippocampal atrophy", code="G31.9")
    else:
        find.append("Age-appropriate parenchymal volume.")
    if ctx.has("stroke"):
        side = pick(rng, ["right", "left"])
        find.append(f"Chronic infarct in the {side} middle cerebral artery territory with encephalomalacia.")
        imp.append(f"Chronic {side} MCA territory infarct.")
        ctx.fact("finding", "chronic infarct", laterality=side, code="I69.30")
    if ctx.has("microhem"):
        n = int(rng.integers(3, 9))
        find.append(f"{n} punctate foci of susceptibility in the cortical-subcortical junctions on SWI.")
        imp.append("Cerebral microhemorrhages; differential includes amyloid angiopathy.")
        ctx.fact("finding", "cerebral microhemorrhages", value=n, code="I61.9")
    find.append(pick(rng, ["Scattered T2/FLAIR white matter hyperintensities, likely chronic small vessel ischemic change.",
                           "No significant white matter disease."]))
    find.append("No acute infarct on diffusion-weighted imaging. No mass, hemorrhage or extra-axial collection.")
    if volumetric:
        pct = int(rng.integers(2, 12)) if ctx.has("alzheimers") else int(rng.integers(30, 70))
        find.append(f"Volumetric analysis: hippocampal volume at the {pct}th percentile for age and sex.")
        ctx.fact("measurement", "hippocampal volume percentile", value=pct, unit="percentile")
    if not imp:
        imp.append("No acute intracranial abnormality.")
    indication_extra = f" MMSE {int(float(mmse))}/30." if mmse is not None else ""
    tech = "Multiplanar multisequence MRI of the brain without contrast" + (
        " with 3D T1 volumetric acquisition." if volumetric else ".")
    return tech, find, imp, indication_extra


def mri_breast(ctx: Context):
    side = pick(ctx.rng, ["right", "left"])
    find = ["Moderate background parenchymal enhancement.",
            f"Known biopsy-proven malignancy in the {side} breast: 2.4 cm irregular enhancing mass with washout kinetics.",
            "No suspicious contralateral enhancement. No axillary lymphadenopathy."]
    ctx.fact("finding", "breast mass", laterality=side, value=2.4, unit="cm", code="C50.919")
    return "Bilateral breast MRI with and without gadolinium.", find, [
        f"Known {side} breast malignancy. No additional suspicious disease. BI-RADS 6: known biopsy-proven malignancy."]


def radiology_report(ctx: Context, study: dict, sections: tuple, radiologist: str, style: int, indication: str):
    technique, find, imp = sections[:3]
    p = ctx.patient
    signed = study["when"] + pd.Timedelta(minutes=int(ctx.rng.integers(45, 26 * 60)))
    head = banner("Department of Radiology", study["campus"], "RADIOLOGY REPORT")
    head += patient_block(p, study["when"], [f"Exam: {study['desc']}", f"Exam date: {dt(study['when'])}"],
                          [f"Accession: {study['acc']}", "", f"Ordering: {study['ordering']}"])
    body = [f"\nCLINICAL INDICATION: {indication}", f"\nTECHNIQUE: {technique}",
            f"\nCOMPARISON: {study['comparison']}"]
    # A finding ending in ":" owns the indented list lines that follow it
    blocks = []
    for line in find:
        if line.startswith("  ") and blocks:
            blocks[-1].append(line)
        else:
            blocks.append([line])
    body.append("\nFINDINGS:")
    if style == 0:
        for block in blocks:
            body += block
    else:
        paragraph = []
        for block in blocks:
            if len(block) > 1:
                if paragraph:
                    body.append(" ".join(paragraph))
                    paragraph = []
                body += block
            else:
                paragraph.append(block[0])
        if paragraph:
            body.append(" ".join(paragraph))
    body.append("\nIMPRESSION:")
    body += [f"{i}. {x}" for i, x in enumerate(imp, start=1)]
    body.append(f"\nElectronically signed by: {radiologist}, MD (Diagnostic Radiology) on {dt(signed)}")
    return head + "\n".join(body) + "\n", signed


# --- Pathology ----------------------------------------------------------------------------------------

GRADE_WORDS = {1: "well differentiated", 2: "moderately differentiated", 3: "poorly differentiated"}
GLEASON_SPLIT = {6: [(3, 3)], 7: [(3, 4), (3, 4), (4, 3)], 8: [(4, 4), (3, 5), (5, 3)], 9: [(4, 5), (5, 4)], 10: [(5, 5)]}
GRADE_GROUP = {(3, 3): 1, (3, 4): 2, (4, 3): 3, (4, 4): 4, (3, 5): 4, (5, 3): 4, (4, 5): 5, (5, 4): 5, (5, 5): 5}
LUNG_SITE = {"R-Upper": "right upper lobe", "R-Middle": "right middle lobe", "R-Lower": "right lower lobe",
             "L-Upper": "left upper lobe", "L-Lower": "left lower lobe"}


def _clean(v):
    return v if isinstance(v, str) and v and v.lower() != "nan" else None


def pathology_report(ctx: Context, case: dict, tcga: dict, study: dict, pathologist: str, receptors: dict):
    rng = ctx.rng
    p = ctx.patient
    cohort, specimen = case["cohort"], case["specimen"]
    hist = _clean(tcga.get("histological_type")) or ""
    pt, pn = _clean(tcga.get("pathologic_T")), _clean(tcga.get("pathologic_N"))
    margin = _clean(tcga.get("residual_tumor"))
    nodes_ex = pd.to_numeric(tcga.get("number_of_lymphnodes_examined"), errors="coerce")
    nodes_pos = pd.to_numeric(tcga.get("number_of_lymphnodes_positive_by_he"), errors="coerce")
    grade = int(rng.integers(1, 4))
    resection = any(k in specimen for k in ("COLECTOMY", "LUMPECTOMY", "EXCISION", "PROSTATECTOMY"))
    clinical, gross, micro, diag, synoptic = "", "", "", [], []

    if cohort == "prostate":
        g = pd.to_numeric(tcga.get("gleason_score_combined"), errors="coerce")
        g = int(g) if pd.notna(g) else 7
        primary, secondary = pick(rng, GLEASON_SPLIT[g])
        gg = GRADE_GROUP[(primary, secondary)]
        psa = ctx.flow("PSA", days=180) or pd.to_numeric(tcga.get("psa_value"), errors="coerce")
        psa = float(psa) if psa is not None and pd.notna(psa) else None
        if psa is not None and psa >= 4:
            clinical = f"{p.age(study['when'])}-year-old man with elevated PSA ({psa:.1f} ng/mL)."
        elif psa is not None:
            clinical = (f"{p.age(study['when'])}-year-old man with a palpable nodule on digital rectal examination; "
                        f"PSA {psa:.1f} ng/mL.")
        else:
            clinical = f"{p.age(study['when'])}-year-old man with an abnormal digital rectal examination."
        ctx.fact("diagnosis", "prostatic adenocarcinoma", code="C61")
        ctx.fact("measurement", "Gleason score", value=f"{primary}+{secondary}={g}")
        ctx.fact("measurement", "Grade Group", value=gg)
        if resection:
            weight = int(rng.integers(35, 75))
            gross = (f"Received fresh labeled 'prostate and seminal vesicles' is a {weight} g radical prostatectomy "
                     "specimen. The surface is inked and the specimen is serially sectioned from apex to base.")
            diag = [f"PROSTATE AND SEMINAL VESICLES, RADICAL PROSTATECTOMY:",
                    f"- PROSTATIC ADENOCARCINOMA, ACINAR TYPE.",
                    f"- GLEASON SCORE {primary}+{secondary}={g} (GRADE GROUP {gg})."]
        else:
            cores = int(rng.integers(10, 15))
            pos = max(1, min(cores, int(round(cores * (0.15 + 0.07 * gg)))))
            pct = int(rng.integers(20, 90))
            sides = pick(rng, ["LEFT", "RIGHT"])
            gross = (f"Received in formalin are {cores} containers labeled A through {chr(64 + cores)}, each containing "
                     f"one to two tan-white needle cores measuring 0.6 to 1.8 cm. Entirely submitted.")
            diag = [f"PROSTATE, {cores}-CORE NEEDLE BIOPSIES:",
                    f"- PROSTATIC ADENOCARCINOMA, ACINAR TYPE, GLEASON SCORE {primary}+{secondary}={g} (GRADE GROUP {gg}).",
                    f"- Tumor involves {pos} of {cores} cores ({sides} predominant), up to {pct}% of core length.",
                    f"- Perineural invasion: {'present' if gg >= 3 else 'not identified'}."]
            ctx.fact("measurement", "positive cores", value=f"{pos}/{cores}")
        micro = ("Sections show infiltrating small to medium-sized glands lined by cells with enlarged nuclei and "
                 f"prominent nucleoli{', with fused and cribriform glands' if secondary >= 4 or primary >= 4 else ''}. "
                 "Basal cells are absent by morphology.")
    elif cohort == "lung":
        squam = "Squamous" in hist
        site = LUNG_SITE.get(_clean(tcga.get("anatomic_neoplasm_subdivision")) or "", "right upper lobe")
        clinical = f"{p.age(study['when'])}-year-old {p.noun(study['when'])} with a {site} mass."
        stain = ("Tumor cells are positive for p40 and CK5/6 and negative for TTF-1 and Napsin A." if squam else
                 "Tumor cells are positive for TTF-1 and Napsin A and negative for p40.")
        typ = "SQUAMOUS CELL CARCINOMA" if squam else "ADENOCARCINOMA"
        if "FINE NEEDLE" in specimen:
            gross = "Received are four air-dried and four alcohol-fixed smears and a cell block from CT-guided FNA."
            diag = [f"LUNG, {site.upper()}, FINE NEEDLE ASPIRATION:", "- POSITIVE FOR MALIGNANCY.",
                    f"- NON-SMALL CELL CARCINOMA, FAVOR {typ}."]
        else:
            gross = (f"Received in formalin are {int(rng.integers(2, 5))} tan-pink core biopsies measuring up to "
                     f"{rng.uniform(1.0, 1.8):.1f} cm. Entirely submitted in one cassette.")
            diag = [f"LUNG, {site.upper()}, CT-GUIDED CORE BIOPSY:", f"- {typ}, {GRADE_WORDS[grade].upper()}."]
        micro = ("Sections show sheets and nests of malignant cells with keratinization and intercellular bridges. "
                 if squam else "Sections show malignant glands with acinar and lepidic growth patterns. ") + stain
        if study["when"].year >= 2015:
            diag.append("- Molecular testing (EGFR, ALK, ROS1, PD-L1) has been ordered." if not squam else
                        "- PD-L1 (22C3) testing has been ordered.")
        ctx.fact("diagnosis", f"non-small cell lung carcinoma, {'squamous' if squam else 'adenocarcinoma'}",
                 site=site, code="C34.90")
    elif cohort == "breast":
        lobular = "Lobular" in hist
        typ = "INVASIVE LOBULAR CARCINOMA" if lobular else "INVASIVE DUCTAL CARCINOMA (NO SPECIAL TYPE)"
        site = _clean(tcga.get("anatomic_neoplasm_subdivision")) or "Left"
        clinical = f"{p.age(study['when'])}-year-old {p.noun(study['when'])} with a {site.lower()} breast mass, BI-RADS 5."
        size = {"T1": 1.5, "T1b": 0.8, "T1c": 1.6, "T2": 3.1, "T3": 5.6, "T4": 6.0, "T4b": 6.2}.get(pt or "T2", 2.4)
        size = round(size + float(rng.uniform(-0.3, 0.3)), 1)
        score = {1: "3-5", 2: "6-7", 3: "8-9"}[grade]
        if resection:
            gross = (f"Received fresh labeled '{site.lower()} breast lumpectomy' is an oriented "
                     f"{size + 3:.1f} x {size + 2:.1f} x {size + 1.5:.1f} cm fibrofatty specimen with a firm tan-white "
                     f"stellate mass measuring {size} cm.")
            diag = [f"BREAST, {site.upper()}, {'LUMPECTOMY' if 'LUMPECTOMY' in specimen else 'EXCISION'}:",
                    f"- {typ}, NOTTINGHAM GRADE {grade} (score {score}), {size} cm.",
                    f"- Margins: {'negative, closest margin 0.4 cm' if margin != 'R1' else 'positive at the anterior margin'}."]
        else:
            gross = "Received in formalin are four tan-white core biopsies measuring 1.2 to 1.6 cm, entirely submitted."
            diag = [f"BREAST, {site.upper()}, ULTRASOUND-GUIDED CORE BIOPSY:", f"- {typ}, NOTTINGHAM GRADE {grade} (score {score})."]
        micro = ("Sections show single-file infiltrating cells with loss of cohesion." if lobular else
                 "Sections show infiltrating nests and cords of malignant cells forming occasional tubules.")
        for marker, label in (("ER", "Estrogen receptor"), ("PR", "Progesterone receptor"), ("HER2", "HER2 (IHC)")):
            if receptors.get(marker):
                diag.append(f"- {label}: {receptors[marker]}.")
                ctx.fact("measurement", label, value=receptors[marker])
        ctx.fact("diagnosis", typ.lower(), site=f"{site} breast", code="C50.919")
        ctx.fact("measurement", "tumor size", value=size, unit="cm")
    else:  # colon
        mucinous = "Mucinous" in hist
        site = _clean(tcga.get("anatomic_neoplasm_subdivision")) or "Sigmoid Colon"
        typ = "MUCINOUS ADENOCARCINOMA" if mucinous else "ADENOCARCINOMA"
        clinical = f"{p.age(study['when'])}-year-old {p.noun(study['when'])} with a {site.lower()} mass on colonoscopy."
        if resection:
            length = int(rng.integers(18, 32))
            size = round(float(rng.uniform(2.5, 6.5)), 1)
            gross = (f"Received fresh labeled '{site.lower()}' is a {length} cm segment of colon with an ulcerated "
                     f"circumferential mass measuring {size} cm, located {int(rng.integers(4, 10))} cm from the nearest margin.")
            diag = [f"COLON, {site.upper()}, PARTIAL COLECTOMY:", f"- {typ}, {GRADE_WORDS[min(grade, 2) if not mucinous else 3].upper()}.",
                    f"- Tumor size: {size} cm.", f"- Margins: {'negative' if margin in (None, 'R0', 'RX') else 'involved'}."]
            ctx.fact("measurement", "tumor size", value=size, unit="cm")
        else:
            gross = "Received in formalin are multiple tan-pink fragments of soft tissue measuring up to 0.5 cm."
            diag = [f"COLON, {site.upper()}, ENDOSCOPIC BIOPSY:", f"- INVASIVE {typ}, {GRADE_WORDS[min(grade, 2)].upper()}.",
                    "- Mismatch repair proteins (MLH1, PMS2, MSH2, MSH6): intact nuclear expression."]
        micro = ("Sections show pools of extracellular mucin containing malignant epithelium." if mucinous else
                 "Sections show invasive malignant glands with dirty necrosis extending through the muscularis propria.")
        ctx.fact("diagnosis", f"colon {typ.lower()}", site=site, code="C18.9")

    if resection and pt:
        year = study["when"].year
        edition = "8th" if year >= 2018 else "7th" if year >= 2010 else "6th" if year >= 2003 else "5th"
        synoptic.append(f"Pathologic stage (AJCC {edition} edition): p{pt} p{pn or 'NX'}")
        ctx.fact("stage", f"p{pt} p{pn or 'NX'}", system=f"AJCC {edition} edition")
        if pd.notna(nodes_ex) and nodes_ex > 0:
            synoptic.append(f"Regional lymph nodes: {int(nodes_pos) if pd.notna(nodes_pos) else 0} of {int(nodes_ex)} "
                            "involved by carcinoma")
            ctx.fact("measurement", "lymph nodes involved",
                     value=f"{int(nodes_pos) if pd.notna(nodes_pos) else 0}/{int(nodes_ex)}")
        synoptic.append(f"Lymphovascular invasion: {pick(rng, ['not identified', 'present', 'not identified'])}")

    collected = study["collected"]
    reported = study["when"] + pd.Timedelta(days=int(rng.integers(1, 4)))
    text = banner("Department of Pathology and Laboratory Medicine", study["campus"], "SURGICAL PATHOLOGY REPORT")
    text += patient_block(p, study["when"], [f"Collected: {dt(collected)}", f"Reported: {dt(reported)}"],
                          [f"Accession: {study['acc']}", f"Submitting: {study['ordering']}", ""])
    text += f"\nSPECIMEN: {specimen.title()}\n\nCLINICAL HISTORY: {clinical}\n\nGROSS DESCRIPTION:\n{gross}\n"
    text += f"\nMICROSCOPIC DESCRIPTION:\n{micro}\n\nFINAL DIAGNOSIS:\n" + "\n".join(diag) + "\n"
    if synoptic:
        text += "\nSYNOPTIC SUMMARY:\n" + "\n".join(f"- {s}" for s in synoptic) + "\n"
    text += (f"\nGlass slides have been scanned to the enterprise image archive (accession {study['acc']}).\n"
             f"\nElectronically signed by: {pathologist}, MD (Pathology) on {dt(reported)}\n")
    return text, reported


# --- Progress notes --------------------------------------------------------------------------------------

PLAN = [
    (("I10",), "Blood pressure {bp}. Continue current antihypertensive regimen; low-sodium diet reviewed. Recheck at next visit."),
    (("E11",), "Last hemoglobin A1c {a1c}. Continue current regimen; reinforced diet and exercise. Annual eye and foot exams due."),
    (("E78",), "Continue statin therapy. Repeat lipid panel in 12 months."),
    (("R73",), "Counseled on weight loss and physical activity. Repeat A1c in 6 months."),
    (("I25",), "Continue antiplatelet and statin therapy. No anginal symptoms. Cardiology follow-up as scheduled."),
    (("I50",), "Euvolemic on exam. Continue guideline-directed medical therapy; daily weights and fluid restriction reviewed."),
    (("I48",), "Rate controlled. Continue anticoagulation; bleeding precautions reviewed."),
    (("J44", "J43"), "Continue inhaled therapy. Pulmonary rehabilitation encouraged. Vaccinations up to date."),
    (("N18",), "Renal function stable. Avoid nephrotoxic agents; continue nephrology follow-up."),
    (("M81", "M80"), "Continue calcium, vitamin D and bisphosphonate therapy. Fall precautions discussed."),
    (("G30", "R41"), "Cognitive decline noted by family. Continue cholinesterase inhibitor; caregiver support resources provided."),
    (("R91",), "Pulmonary nodule follow-up imaging per radiology recommendation; patient informed of results."),
    (("C34",), "Followed by thoracic oncology. Tolerating treatment; restaging CT as scheduled."),
    (("C50",), "Followed by breast oncology. Continue adjuvant therapy as directed."),
    (("C18",), "Followed by colorectal surgery and oncology. Surveillance CEA and imaging per protocol."),
    (("C61", "D07.5", "D40.0"), "Followed by urology. PSA monitoring as scheduled."),
    (("E66",), "BMI {bmi}. Nutrition counseling provided; goal of 5 to 10% weight loss."),
    (("D64",), "Mild anemia, asymptomatic. Iron studies ordered."),
    (("F32", "F43"), "Mood stable on current regimen. Continue therapy; safety plan reviewed."),
    (("G89", "M79.7"), "Pain controlled. Continue non-opioid regimen and physical therapy."),
    (("Z87.891", "F17"), "Smoking history reviewed; lung cancer screening eligibility discussed."),
]


def progress_note(ctx: Context, visit: dict, problems: list, meds: list, vitals: dict, labs: list, imaging: list,
                  provider: str):
    rng = ctx.rng
    p = ctx.patient
    when = visit["when"]
    reason = visit["reason"] or pick(rng, ["Follow-up of chronic medical conditions.", "Routine follow-up."])
    chronic = [x for x in problems if x["icd"]][:6]
    hist = ", ".join(x["name"].lower() for x in chronic[:4]) or "no significant past medical history"
    hpi = [f"{p.age(when)}-year-old {p.noun(when)} with {hist} who presents for {reason.rstrip('.').lower()}."]
    for img in imaging:
        hpi.append(img)
    hpi.append(pick(rng, ["Reports adherence to medications without side effects.",
                          "Denies chest pain, shortness of breath or new symptoms.",
                          "Overall feels well. No interval hospitalizations."]))
    for x in chronic:
        ctx.fact("diagnosis", x["name"], code=x["icd"])
    for m in meds:
        ctx.fact("medication", m)

    bp = vitals.get("BP", "not recorded")
    v = []
    for label, key, unit in (("BP", "BP", ""), ("HR", "HR", ""), ("RR", "RR", ""), ("Temp", "TEMP", " C"),
                             ("SpO2", "SPO2", "%"), ("Wt", "WT", " kg"), ("BMI", "BMI", "")):
        if vitals.get(key) is not None:
            v.append(f"{label} {vitals[key]}{unit}")
            ctx.fact("vital", label, value=vitals[key])
    a1c = next((l["value"] for l in labs if l["name"] == "HEMOGLOBIN A1C"), "not available")

    plan = []
    for i, x in enumerate(chronic, start=1):
        text = next((t for prefixes, t in PLAN if any(x["icd"].startswith(pr) for pr in prefixes)),
                    "Stable. Continue current management.")
        plan.append(f"{i}. {x['name']} ({x['icd']}): " + text.format(bp=bp, a1c=a1c, bmi=vitals.get("BMI", "n/a")))
    if not plan:
        plan.append("1. Health maintenance: age-appropriate screening reviewed. Return in 12 months.")
    plan.append(pick(rng, ["Return to clinic in 3 months or sooner as needed.", "Follow up in 6 months.",
                           "Return in 4 to 6 weeks to review results."]))

    signed = when + pd.Timedelta(minutes=int(rng.integers(30, 8 * 60)))
    text = banner(visit["dept"].title(), visit["campus"], "PROGRESS NOTE")
    text += patient_block(p, when, [f"Date of service: {dt(when)}", f"Provider: {provider}"],
                          [f"Visit type: {visit['type']}", "", ""])
    sections = [("CHIEF COMPLAINT", reason), ("HISTORY OF PRESENT ILLNESS", " ".join(hpi)),
                ("ACTIVE PROBLEMS", "\n".join(f"- {x['name']} ({x['icd']})" for x in chronic) or "- None"),
                ("MEDICATIONS", "\n".join(f"- {m}" for m in meds) or "- None"),
                ("ALLERGIES", pick(rng, ["No known drug allergies.", "NKDA."])),
                ("SOCIAL HISTORY", f"Tobacco: {visit['smoking']}. Alcohol: {pick(rng, ['occasional', 'denies', 'social'])}."),
                ("VITAL SIGNS", " | ".join(v) or "Not recorded."),
                ("RESULTS", "\n".join(f"- {LAB_NAMES.get(l['name'], l['name'].title())} {l['value']} {l['unit']}{' (' + l['flag'] + ')' if l['flag'] else ''}"
                                      f" on {d(l['when'])}" for l in labs) or "No recent results."),
                ("PHYSICAL EXAM", pick(rng, [
                    "General: well appearing, no distress. Lungs: clear to auscultation bilaterally. Heart: regular rate "
                    "and rhythm, no murmur. Extremities: no edema.",
                    "Alert and oriented. Lungs clear. Cardiac exam with normal S1/S2. Abdomen soft, nontender. No edema."])),
                ("ASSESSMENT AND PLAN", "\n".join(plan))]
    for title, content in sections:
        text += f"\n{title}\n{content}\n"
    text += f"\nElectronically signed by: {provider} on {dt(signed)}\n"
    return text, signed
