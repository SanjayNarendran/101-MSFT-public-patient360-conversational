"""The researcher's notebook that comes with each delivery: Explore_QM<id>_<title>[_Demo].

Cohort_Delivery creates it next to the delivery lakehouse and attaches that lakehouse as its default, so a researcher
opens it and runs all. It's a Fabric Python notebook (single node, starts in seconds) with Plotly charts: who is in the
cohort, conditions, medications, labs, care over time, imaging (a CT with the radiologists' nodule outlines and one
image of every other kind, read through the delivery's OneLake shortcuts), a report, and one patient's record.

content() returns the notebook in Fabric's Git source format (notebook-content.py); cells() returns the same cells,
which also run outside Fabric: the setup cell then reads the lakehouse over OneLake instead of the attached mount.
"""
from __future__ import annotations

import json


def explore_name(lakehouse_name: str) -> str:
    """Explore_QM1006_Type2DiabetesNeverPrescribed_Demo for Delivery_QM1006_Type2DiabetesNeverPrescribed_Demo."""
    return "Explore_" + lakehouse_name.removeprefix("Delivery_")


SETUP = r'''
import io, json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date

try:
    import pydicom
except ImportError:  # not in the Fabric Python image
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "pydicom>=3,<4"])
    import pydicom

import duckdb
import numpy as np
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import plotly.io as pio
import requests
from deltalake import DeltaTable
from IPython.display import HTML, Markdown, display
from PIL import Image
from plotly.subplots import make_subplots

# The delivery lakehouse is this notebook's default lakehouse (mounted at /lakehouse/default). Elsewhere, the same
# lakehouse is read over OneLake.
MOUNT = "/lakehouse/default"
MOUNTED = os.path.isdir(f"{MOUNT}/Tables")
ONELAKE = f"https://onelake.dfs.fabric.microsoft.com/{WORKSPACE_ID}/{LAKEHOUSE_ID}"


def onelake_token():
    import notebookutils
    return notebookutils.credentials.getToken("storage")


def table(name):
    if MOUNTED:
        return DeltaTable(f"{MOUNT}/Tables/{name}")
    return DeltaTable(f"abfss://{WORKSPACE_ID}@onelake.dfs.fabric.microsoft.com/{LAKEHOUSE_ID}/Tables/{name}",
                      storage_options={"bearer_token": onelake_token(), "use_fabric_endpoint": "true"})


def ls(folder):
    """Files and folders in a lakehouse folder (shortcuts included), with their sizes in bytes."""
    if MOUNTED:
        path = f"{MOUNT}/{folder}"
        return {n: os.path.getsize(f"{path}/{n}") for n in sorted(os.listdir(path))}
    resp = requests.get(ONELAKE.rsplit("/", 1)[0], timeout=60, headers={"Authorization": f"Bearer {onelake_token()}"},
                        params={"resource": "filesystem", "recursive": "false", "directory": f"{LAKEHOUSE_ID}/{folder}"})
    resp.raise_for_status()
    return {p["name"].rsplit("/", 1)[-1]: int(p.get("contentLength", 0)) for p in resp.json().get("paths", [])}


def read(path):
    if MOUNTED:
        with open(f"{MOUNT}/{path}", "rb") as f:
            return f.read()
    resp = requests.get(f"{ONELAKE}/{path}", timeout=300, headers={"Authorization": f"Bearer {onelake_token()}"})
    resp.raise_for_status()
    return resp.content


def header(path):
    """A DICOM file's header without its pixels (over OneLake, only the first 64 KB are read)."""
    if MOUNTED:
        return pydicom.dcmread(f"{MOUNT}/{path}", stop_before_pixels=True)
    resp = requests.get(f"{ONELAKE}/{path}", timeout=60, headers={"Authorization": f"Bearer {onelake_token()}",
                                                                   "Range": "bytes=0-65535"})
    resp.raise_for_status()
    try:
        return pydicom.dcmread(io.BytesIO(resp.content), stop_before_pixels=True)
    except Exception:  # a header longer than 64 KB
        return pydicom.dcmread(io.BytesIO(read(path)), stop_before_pixels=True)


def lakehouse_path(url):
    """Files/... for a OneLake URL stored in the tables (image_occurrence.local_path, document_links.document_url)."""
    return url.split(f"/{LAKEHOUSE_ID}/", 1)[1].rstrip("/")


# Every delivered table, queryable with SQL
db = duckdb.connect()
TABLES = ["person", "death", "observation_period", "visit_occurrence", "condition_occurrence", "drug_exposure",
          "procedure_occurrence", "measurement", "observation", "note", "image_occurrence", "image_feature",
          "condition_era", "drug_era", "cohort", "concept", "document_links", "delivery_manifest"]
for name in TABLES:
    db.register(name, table(name).to_pyarrow_dataset())
sql = lambda query, *args: db.execute(query, list(args)).df()

# Chart style: the demo's ink, hairlines and one orange accent
INK, ACCENT, BRIGHT, MUTED, GRID = "#1F1D1A", "#B0450A", "#F26419", "#8A847B", "#E6E2DA"
SHADES = [ACCENT, INK, "#9A938A", "#D9B08C", "#5E6B73", "#C9C3B9", "#7A3A12"]
pio.templates["delivery"] = go.layout.Template(layout=dict(
    font=dict(family="Fira Sans, Segoe UI, Helvetica Neue, Arial, sans-serif", size=13, color=INK),
    title=dict(font=dict(size=16, color=INK), x=0, xanchor="left", y=0.97),
    colorway=SHADES, paper_bgcolor="white", plot_bgcolor="white", margin=dict(l=10, r=24, t=64, b=36),
    xaxis=dict(gridcolor=GRID, linecolor=GRID, zeroline=False, ticks="", title_font=dict(color=MUTED)),
    yaxis=dict(gridcolor=GRID, linecolor=GRID, zeroline=False, ticks="", title_font=dict(color=MUTED)),
    legend=dict(orientation="h", yanchor="bottom", y=1.0, xanchor="left", x=0, title_text=""),
    hoverlabel=dict(bgcolor="white", bordercolor=GRID, font=dict(color=INK))))
pio.templates.default = "simple_white+delivery"
SCALE = [[0, "#FFFFFF"], [0.5, "#E8B48F"], [1, ACCENT]]
BELOW = dict(orientation="h", yanchor="top", y=-0.1, xanchor="left", x=0)   # legend under charts with subplot titles
short = lambda text, n=34: text if len(text) <= n else text[:n - 1] + "…"

manifest = sql("SELECT * FROM delivery_manifest").iloc[0]
PATIENTS = int(manifest.patients)
print(f"{len(TABLES)} tables from {LAKEHOUSE_NAME} ({'attached lakehouse' if MOUNTED else 'OneLake'}), "
      f"{PATIENTS} patients")
'''

DELIVERED = r'''
tables = json.loads(manifest.tables)
demo = (f" Demo mode: {PATIENTS} of the cohort's {int(manifest.cohort_patients)} patients, "
        f"{int(manifest.imaging_studies_linked)} of {int(manifest.imaging_studies_total)} imaging studies and "
        f"{int(manifest.documents_copied)} of {int(manifest.documents_total)} documents.") if manifest.demo_mode else ""
display(Markdown(f"Request {int(manifest.query_master_id)}, approved by {manifest.approved_by} on "
                 f"{str(manifest.approved_at)[:16]} UTC and delivered {str(manifest.delivered_at_utc)[:16]} UTC. "
                 f"{PATIENTS} patients, {sum(tables.values()):,} rows in {len(tables)} tables.{demo}"))

rows = pd.Series(tables, name="rows").drop(["delivery_manifest", "cohort_definition"], errors="ignore")
rows = rows.sort_values().rename_axis("table").reset_index()
fig = px.bar(rows, x="rows", y="table", orientation="h", log_x=True, text="rows",
             title="Rows delivered per OMOP table (log scale)")
fig.update_traces(marker_color=[ACCENT if t == "person" else INK for t in rows.table], texttemplate="%{text:,}",
                  textposition="outside", cliponaxis=False)
fig.update_layout(height=520, xaxis=dict(title=None, dtick=1), yaxis_title=None)
fig.show()
'''

PEOPLE = r'''
people = sql("""
    SELECT p.person_id, g.concept_name AS sex, coalesce(r.concept_name, 'Unknown') AS race, p.year_of_birth,
           d.death_date IS NOT NULL AS deceased,
           coalesce(year(d.death_date), year(current_date)) - p.year_of_birth AS age
    FROM person p
    LEFT JOIN concept g ON g.concept_id = p.gender_concept_id
    LEFT JOIN concept r ON r.concept_id = p.race_concept_id
    LEFT JOIN death d USING (person_id)""")
bands = [0, 18, 30, 40, 50, 60, 70, 80, 200]
labels = ["0-17", "18-29", "30-39", "40-49", "50-59", "60-69", "70-79", "80+"]
people["band"] = pd.cut(people.age, bands, right=False, labels=labels)
pyramid = people.groupby(["band", "sex"], observed=False).size().unstack(fill_value=0).reindex(labels)

fig = make_subplots(rows=1, cols=2, column_widths=[0.58, 0.42], horizontal_spacing=0.14,
                    subplot_titles=["Age (as of today, or at death) and sex", "Race"])
for sex, sign, colour in [("MALE", -1, INK), ("FEMALE", 1, ACCENT)]:
    if sex in pyramid:
        fig.add_bar(y=pyramid.index, x=sign * pyramid[sex], orientation="h", name=sex.title(), marker_color=colour,
                    customdata=pyramid[sex], hovertemplate="%{y}: %{customdata} " + sex.lower() + "<extra></extra>",
                    row=1, col=1)
top = max(1, int(pyramid.values.max()))
ticks = sorted({-top, -round(top / 2), 0, round(top / 2), top})
fig.update_xaxes(tickvals=ticks, ticktext=[str(abs(t)) for t in ticks], range=[-top * 1.08, top * 1.08], row=1, col=1)
race = people.race.value_counts().sort_values()
fig.add_bar(y=[short(r, 26) for r in race.index], x=race.values, orientation="h", marker_color=MUTED,
            showlegend=False, text=race.values, textposition="outside", cliponaxis=False, row=1, col=2)
alive = int((~people.deceased).sum())
fig.update_layout(barmode="relative", bargap=0.18, height=440, legend=BELOW,
                  title=f"{len(people)} patients: {alive} living, {len(people) - alive} deceased")
fig.show()
'''

CONDITIONS = r'''
conditions = sql("""
    SELECT DISTINCT e.person_id, c.concept_name AS condition
    FROM condition_era e JOIN concept c ON c.concept_id = e.condition_concept_id
    WHERE c.domain_id = 'Condition'""")
top = conditions.condition.value_counts().head(15)
fig = px.bar(x=top.values / PATIENTS, y=[short(c, 48) for c in top.index], orientation="h",
             title="The 15 most common conditions (share of patients)")
fig.update_traces(marker_color=[ACCENT] + [INK] * (len(top) - 1), texttemplate="%{x:.0%}", textposition="outside",
                  cliponaxis=False, hovertemplate="%{y}: %{x:.0%}<extra></extra>")
fig.update_layout(height=520, xaxis_tickformat=".0%", xaxis_title=None, yaxis_title=None,
                  yaxis=dict(autorange="reversed"))
fig.show()

# Which conditions go together: the share of patients who have both
ten = list(top.index[:10])
sets = {c: set(conditions.person_id[conditions.condition == c]) for c in ten}
both = np.array([[len(sets[a] & sets[b]) / PATIENTS for b in ten] for a in ten])
names = [short(c, 30) for c in ten]
fig = px.imshow(both, x=names, y=names, color_continuous_scale=SCALE, zmin=0, text_auto=".0%", aspect="auto",
                title="Conditions that occur together (share of patients with both)")
fig.update_layout(height=600, coloraxis_showscale=False, xaxis_tickangle=-35)
fig.update_traces(hovertemplate="%{y} and %{x}: %{z:.0%}<extra></extra>")
fig.show()
'''

MEDICATIONS = r'''
eras = sql("""
    SELECT e.person_id, c.concept_name AS drug, year(e.drug_era_start_date) AS first_year,
           year(e.drug_era_end_date) AS last_year
    FROM drug_era e JOIN concept c ON c.concept_id = e.drug_concept_id""")
if eras.empty:
    print("No medications in this delivery.")
else:
    drugs = eras.groupby("drug").person_id.nunique().sort_values(ascending=False).head(12)
    years = sql("""
        SELECT drug, year, count(DISTINCT person_id) AS patients FROM (
            SELECT e.person_id, c.concept_name AS drug,
                   unnest(range(year(e.drug_era_start_date), year(e.drug_era_end_date) + 1)) AS year
            FROM drug_era e JOIN concept c ON c.concept_id = e.drug_concept_id)
        GROUP BY ALL""")
    last = int(years.year.max())
    grid = (years[years.drug.isin(drugs.index) & (years.year > last - 20)]
            .pivot_table(index="drug", columns="year", values="patients", fill_value=0).reindex(drugs.index))
    fig = make_subplots(rows=1, cols=2, column_widths=[0.3, 0.7], shared_yaxes=True, horizontal_spacing=0.02,
                        subplot_titles=["Patients ever on it", "Patients on it each year"])
    fig.add_bar(x=drugs.values, y=[short(d, 30) for d in drugs.index], orientation="h", marker_color=INK,
                text=drugs.values, textposition="inside", showlegend=False, row=1, col=1)
    fig.add_heatmap(z=grid.values, x=grid.columns, y=[short(d, 30) for d in grid.index], colorscale=SCALE,
                    showscale=False, hovertemplate="%{y}, %{x}: %{z} patients<extra></extra>", row=1, col=2)
    fig.update_yaxes(autorange="reversed")
    fig.update_layout(height=520, title="Medications (drug eras by ingredient)")
    fig.show()
'''

LABS = r'''
values = sql("""
    SELECT m.person_id, m.measurement_concept_id, c.concept_name AS lab, coalesce(m.unit_source_value, '') AS unit,
           m.measurement_date, m.value_as_number AS value
    FROM measurement m JOIN concept c ON c.concept_id = m.measurement_concept_id
    WHERE m.value_as_number IS NOT NULL
      AND m.measurement_id NOT IN (SELECT image_feature_event_id FROM image_feature)""")
values["measurement_date"] = pd.to_datetime(values.measurement_date)
# Familiar measures first (OMOP concept IDs), then the most common others
FAMILIAR = {3004410: "HbA1c", 3000483: "Glucose", 46236952: "eGFR", 3038553: "BMI", 3004249: "Systolic BP",
            3012888: "Diastolic BP", 3027114: "Total cholesterol", 3025315: "Body weight", 3027018: "Heart rate"}
reach = values.groupby("measurement_concept_id").person_id.nunique()
picked = [c for c in FAMILIAR if reach.get(c, 0) >= 3][:6]
picked += [c for c in reach.sort_values(ascending=False).index if c not in picked][:6 - len(picked)]
label = lambda c: (FAMILIAR.get(c) or short(values.lab[values.measurement_concept_id == c].iloc[0], 30)) + \
    (f" ({u})" if (u := values.unit[values.measurement_concept_id == c].iloc[0]) else "")
latest = values.sort_values("measurement_date").groupby(["person_id", "measurement_concept_id"]).tail(1)
fig = make_subplots(rows=2, cols=3, vertical_spacing=0.2, horizontal_spacing=0.06,
                    subplot_titles=[label(c) for c in picked])
for i, c in enumerate(picked):
    v = latest[latest.measurement_concept_id == c]
    fig.add_box(x=v.value, name="", boxpoints="all", jitter=0.5, pointpos=0, marker=dict(color=ACCENT, size=6,
                opacity=0.65), line=dict(color=INK, width=1.2), fillcolor="rgba(0,0,0,0)", showlegend=False,
                hovertemplate="%{x}<extra></extra>", row=i // 3 + 1, col=i % 3 + 1)
fig.update_yaxes(visible=False)
fig.update_layout(height=500, title="Each patient's latest result (one point per patient)")
fig.update_annotations(font_size=13)
fig.show()

# Four measures over the last 10 years: a grey line per patient, the yearly median in orange
since = values.measurement_date.max() - pd.DateOffset(years=10)
trends = [c for c in (3004410, 46236952, 3038553, 3004249) if reach.get(c, 0) >= 3] or picked[:4]
fig = make_subplots(rows=2, cols=2, vertical_spacing=0.16, horizontal_spacing=0.08,
                    subplot_titles=[label(c) for c in trends])
for i, c in enumerate(trends):
    v = values[(values.measurement_concept_id == c) & (values.measurement_date >= since)]
    v = v.sort_values(["person_id", "measurement_date"])
    gaps = pd.concat([pd.concat([g[["measurement_date", "value"]], pd.DataFrame({"measurement_date": [pd.NaT]})])
                      for _, g in v.groupby("person_id")]) if len(v) else v
    yearly = v.assign(year=v.measurement_date.dt.year).groupby("year").agg(value=("value", "median"),
                                                                           patients=("person_id", "nunique"))
    yearly = yearly[yearly.patients >= 3]
    row, col = i // 2 + 1, i % 2 + 1
    fig.add_scatter(x=gaps.measurement_date, y=gaps.value, mode="lines", line=dict(color="rgba(31,29,26,0.2)",
                    width=1), hoverinfo="skip", showlegend=i == 0, name="One patient", row=row, col=col)
    fig.add_scatter(x=pd.to_datetime(yearly.index.astype(str) + "-07-01"), y=yearly.value, mode="lines+markers",
                    line=dict(color=ACCENT, width=3), marker=dict(size=6), showlegend=i == 0,
                    name="Median per year", customdata=yearly.patients,
                    hovertemplate="%{x|%Y}: %{y:.1f} (%{customdata} patients)<extra></extra>", row=row, col=col)
    if c == 3004410:
        fig.add_hline(y=6.5, line=dict(color=MUTED, dash="dot", width=1), annotation_text="6.5 %",
                      annotation_font_color=MUTED, annotation_position="top right", row=row, col=col)
fig.update_layout(height=620, legend=BELOW, title=f"Over the last 10 years ({values.person_id.nunique()} patients)")
fig.update_annotations(font_size=13)
fig.show()
'''

VISITS = r'''
visits = sql("""
    SELECT year(v.visit_start_date) AS year, coalesce(c.concept_name, 'Other') AS visit, count(*) AS visits
    FROM visit_occurrence v LEFT JOIN concept c ON c.concept_id = v.visit_concept_id GROUP BY ALL""")
visits = visits[visits.year > visits.year.max() - 25]
order = visits.groupby("visit").visits.sum().sort_values(ascending=False).index.tolist()
fig = px.bar(visits, x="year", y="visits", color="visit", category_orders={"visit": order},
             color_discrete_sequence=[INK, ACCENT, "#9A938A", "#D9B08C", "#5E6B73", "#C9C3B9", "#7A3A12", "#E6E2DA"],
             title="Visits per year by type")
fig.update_layout(height=420, bargap=0.15, xaxis_title=None, yaxis_title=None, legend_title_text="")
fig.show()
'''

IMAGING = r'''
studies = sql("""
    SELECT modality_source_value AS modality,
           count(DISTINCT image_study_uid) FILTER (WHERE local_path IS NOT NULL) AS linked,
           count(DISTINCT image_study_uid) FILTER (WHERE local_path IS NULL) AS listed
    FROM image_occurrence GROUP BY 1 ORDER BY linked + listed DESC""")
nodules = sql("""
    SELECT m.value_as_number AS size_mm FROM image_feature f
    JOIN measurement m ON m.measurement_id = f.image_feature_event_id
    WHERE f.image_feature_concept_id = 4078486  -- nodule size (volumes and scores are stored too)
      AND m.value_as_number IS NOT NULL""")
fig = make_subplots(rows=1, cols=2, horizontal_spacing=0.12, column_widths=[0.45, 0.55],
                    subplot_titles=["Imaging studies by modality", "Lung nodule sizes (radiologist measurements)"])
fig.add_bar(x=studies.modality, y=studies.linked, name="Images linked in this lakehouse", marker_color=ACCENT,
            row=1, col=1)
fig.add_bar(x=studies.modality, y=studies.listed, name="Listed only (report and metadata)", marker_color=GRID,
            row=1, col=1)
if len(nodules):
    fig.add_histogram(x=nodules.size_mm, xbins=dict(size=2), marker_color=INK, showlegend=False,
                      hovertemplate="%{x} mm: %{y}<extra></extra>", row=1, col=2)
    for mm in (6, 8, 15):
        fig.add_vline(x=mm, line=dict(color=ACCENT, dash="dot", width=1), row=1, col=2)
        fig.add_annotation(x=mm, y=0.98, xref="x2", yref="y2 domain", text=f"{mm} mm", showarrow=False,
                           xanchor="left", xshift=3, font=dict(color=ACCENT, size=11))
    fig.update_xaxes(title_text="mm (dotted: Lung-RADS size cut-offs for solid nodules)", row=1, col=2)
fig.update_layout(barmode="stack", height=450, legend=BELOW)
fig.show()
'''

CT = r'''
def lung_window(ds, centre=-600, width=1500):
    hu = ds.pixel_array * float(ds.get("RescaleSlope", 1)) + float(ds.get("RescaleIntercept", 0))
    return np.clip((hu - centre + width / 2) / width * 255, 0, 255).astype(np.uint8)


def edge(mask):
    m = mask.astype(bool)
    inner = m.copy()
    inner[1:] &= m[:-1]; inner[:-1] &= m[1:]; inner[:, 1:] &= m[:, :-1]; inner[:, :-1] &= m[:, 1:]
    line = m & ~inner
    line[1:] |= line[:-1].copy(); line[:, 1:] |= line[:, :-1].copy()
    return line


ct = sql("""
    SELECT i.person_id, i.image_study_uid, i.local_path, i.image_occurrence_date,
           EXISTS (SELECT 1 FROM image_feature f WHERE f.image_occurrence_id = i.image_occurrence_id) AS nodule
    FROM image_occurrence i WHERE i.local_path IS NOT NULL AND i.modality_source_value = 'CT'
    ORDER BY nodule DESC, i.person_id LIMIT 1""")
STORY_PERSON = None
if ct.empty:
    print("No CT images are linked in this delivery.")
else:
    study = ct.iloc[0]
    STORY_PERSON = int(study.person_id)
    series_dir = lakehouse_path(study.local_path)
    study_dir = series_dir.rsplit("/", 1)[0]
    slices = ls(series_dir)

    # The LIDC radiologists' nodule outlines are DICOM SEG objects (one per reader and nodule), stored as other series
    # of the same study. The viewer follows the largest nodule: every reader's outline of it, the slices they are drawn
    # on and two more on each side.
    def outlines(series):
        files = ls(f"{study_dir}/{series}")
        if len(files) != 1 or next(iter(files.values())) > 5_000_000:
            return {}
        ds = pydicom.dcmread(io.BytesIO(read(f"{study_dir}/{series}/{next(iter(files))}")))
        if ds.Modality != "SEG":
            return {}
        frames = ds.pixel_array.reshape(-1, ds.Rows, ds.Columns)
        return [(g.DerivationImageSequence[0].SourceImageSequence[0].ReferencedSOPInstanceUID, f)
                for f, g in zip(frames, ds.PerFrameFunctionalGroupsSequence)]

    with ThreadPoolExecutor(8) as pool:
        segs = [[(uid, f.astype(bool)) for uid, f in found if f"{uid}.dcm" in slices]
                for found in pool.map(outlines, [s for s in ls(study_dir) if f"{study_dir}/{s}" != series_dir])]
    segs = [seg for seg in segs if seg]
    masks, readers = {}, 0
    if segs:
        footprint = lambda seg: np.logical_or.reduce([f for _, f in seg])
        largest = footprint(max(segs, key=lambda seg: max(f.sum() for _, f in seg)))
        for seg in segs:
            if (footprint(seg) & largest).any():   # the same nodule, outlined by another reader
                readers += 1
                for uid, f in seg:
                    masks[uid] = masks.get(uid, False) | f
    with ThreadPoolExecutor(16) as pool:
        z = dict(pool.map(lambda n: (n, float(header(f"{series_dir}/{n}").ImagePositionPatient[2])), slices))
    order = sorted(z, key=z.get)
    if masks:
        at = [order.index(f"{uid}.dcm") for uid in masks]
        names = order[max(0, min(at) - 2):max(at) + 3]
    else:   # no outlines: 40 slices spread through the series
        names = order[:: max(1, len(order) // 40)]
    with ThreadPoolExecutor(16) as pool:
        images = list(pool.map(lambda n: pydicom.dcmread(io.BytesIO(read(f"{series_dir}/{n}"))), names))
    images.sort(key=lambda ds: float(ds.ImagePositionPatient[2]))

    frames, zoomed = [], []
    union = np.zeros((images[0].Rows, images[0].Columns), bool)
    for ds in images:
        union |= masks.get(ds.SOPInstanceUID, False)
    h, w = union.shape[0] // 4, union.shape[1] // 4          # the close-up: a quarter of the slice, scaled 4x
    if union.any():
        rows, cols = np.nonzero(union)
        r0 = int(np.clip(rows.mean() - h / 2, 0, union.shape[0] - h))
        c0 = int(np.clip(cols.mean() - w / 2, 0, union.shape[1] - w))
    for ds in images:
        rgb = np.repeat(lung_window(ds)[..., None], 3, axis=2)
        mask = masks.get(ds.SOPInstanceUID)
        if mask is not None:
            rgb[edge(mask)] = (242, 100, 25)
        frames.append(rgb)
        if union.any():
            zoomed.append(rgb[r0:r0 + h, c0:c0 + w].repeat(4, axis=0).repeat(4, axis=1))
    if zoomed:
        stack = np.stack([np.stack([f, z]) for f, z in zip(frames, zoomed)])
        fig = px.imshow(stack, animation_frame=0, facet_col=1, binary_string=True, facet_col_spacing=0.01)
        for a, text in zip(fig.layout.annotations, ["Whole slice (lung window)", "Close-up of the nodule"]):
            a.text = text
        what = f"the largest nodule, outlined by {readers} LIDC radiologist{'s' if readers > 1 else ''}, {len(images)} slices"
    else:
        fig = px.imshow(np.stack(frames), animation_frame=0, binary_string=True)
        what = f"{len(images)} slices through the chest"
    for step, ds in zip(fig.layout.sliders[0].steps, images):
        step.label = f"{float(ds.ImagePositionPatient[2]):.1f} mm"
    fig.layout.sliders[0].currentvalue = dict(prefix="Slice position: ", font=dict(color=MUTED))
    fig.update_xaxes(visible=False); fig.update_yaxes(visible=False)
    fig.update_layout(height=620, margin=dict(l=0, r=0, t=70, b=10),
                      title=f"Chest CT of patient {STORY_PERSON}, {study.image_occurrence_date:%d %b %Y}: {what}")
    fig.show()
    print(f"Read {len(images)} DICOM files through the OneLake shortcut {study_dir}")
'''

GALLERY = r'''
def picture(ds):
    """An 8-bit RGB picture of a DICOM image (the middle frame of a multi-frame one)."""
    pixels = ds.pixel_array
    frames = int(ds.get("NumberOfFrames", 1) or 1)
    if frames > 1:
        pixels = pixels[frames // 2]
    if pixels.ndim == 2:
        lo, hi = np.percentile(pixels, [0.5, 99.5])
        pixels = np.clip((pixels - lo) / max(hi - lo, 1) * 255, 0, 255).astype(np.uint8)
        if ds.get("PhotometricInterpretation") == "MONOCHROME1":
            pixels = 255 - pixels
        pixels = np.repeat(pixels[..., None], 3, axis=2)
    img = Image.fromarray(pixels.astype(np.uint8))
    ratio = 480 / max(img.size)
    img = img.resize((max(1, round(img.width * ratio)), max(1, round(img.height * ratio))), Image.LANCZOS)
    canvas = Image.new("RGB", (480, 480), "white")
    canvas.paste(img, ((480 - img.width) // 2, (480 - img.height) // 2))
    return np.asarray(canvas)


def one_image(series_dir, modality):
    files = ls(series_dir)
    if modality == "SM":   # a whole-slide image: its thumbnail, else the smallest pyramid level
        for name in sorted((n for n in files if files[n] < 3_000_000), key=files.get):
            ds = pydicom.dcmread(io.BytesIO(read(f"{series_dir}/{name}")))
            if "THUMBNAIL" in ds.get("ImageType", []):
                return picture(ds)
        name = min(files, key=files.get)
    else:
        name = sorted(files)[len(files) // 2]
    return picture(pydicom.dcmread(io.BytesIO(read(f"{series_dir}/{name}"))))


others = sql("""
    SELECT modality_source_value AS modality, arg_min(local_path, person_id) AS local_path,
           count(DISTINCT image_study_uid) AS studies
    FROM image_occurrence WHERE local_path IS NOT NULL AND modality_source_value <> 'CT'
    GROUP BY 1 ORDER BY 1""")
TITLES = {"SM": "Pathology slide (SM)", "MR": "MR", "DX": "Digital X-ray (DX)", "CR": "Computed radiography (CR)",
          "MG": "Mammogram (MG)", "US": "Ultrasound (US)"}
shown = []
for r in others.itertuples():
    try:
        shown.append((TITLES.get(r.modality, r.modality), one_image(lakehouse_path(r.local_path), r.modality)))
    except Exception as e:  # a format this notebook can't decode: skip it
        print(f"{r.modality}: not shown ({type(e).__name__}: {e})")
if shown:
    fig = px.imshow(np.stack([s[1] for s in shown]), facet_col=0, binary_string=True, facet_col_spacing=0.02)
    for a, (text, _) in zip(fig.layout.annotations, shown):
        a.text = text
    fig.update_xaxes(visible=False); fig.update_yaxes(visible=False)
    fig.update_layout(height=380, margin=dict(l=0, r=0, t=70, b=0),
                      title="One image of every other kind in this delivery, read through its OneLake shortcut")
    fig.show()
else:
    print("No other images are linked in this delivery.")
'''

DOCUMENTS = r'''
docs = sql("""
    SELECT DocumentType AS type, count(*) AS documents, count(document_url) AS copied
    FROM document_links GROUP BY 1 ORDER BY 2 DESC""")
fig = go.Figure()
fig.add_bar(x=docs.documents, y=docs.type, orientation="h", name="Listed in document_links", marker_color=GRID)
fig.add_bar(x=docs.copied, y=docs.type, orientation="h", name="Copied to this lakehouse", marker_color=ACCENT)
fig.update_layout(barmode="overlay", height=360, title="Reports and notes by type",
                  yaxis=dict(autorange="reversed", title=None), xaxis_title=None)
fig.show()

report = sql("""
    SELECT person_id, Title, DocumentType, document_url FROM document_links
    WHERE document_url IS NOT NULL AND lower(document_url) LIKE '%.txt'
    ORDER BY person_id = ? DESC, DocumentType ILIKE '%radiology%' DESC, DocumentType ILIKE '%pathology%' DESC
    LIMIT 1""", STORY_PERSON or -1)
if len(report):
    r = report.iloc[0]
    text = read(lakehouse_path(r.document_url)).decode("utf-8", "replace")
    display(HTML(f"""<div style="font:600 13px Segoe UI,Helvetica,Arial,sans-serif;color:{INK};margin:6px 0">
        {r.Title} &middot; {r.DocumentType} &middot; patient {r.person_id}</div>
        <pre style="white-space:pre-wrap;font:12.5px/1.5 Menlo,Consolas,monospace;color:{INK};background:#FBFAF7;
        border:1px solid {GRID};border-left:3px solid {ACCENT};padding:12px 16px;max-height:420px;overflow:auto">{
        text.replace('&', '&amp;').replace('<', '&lt;')}</pre>"""))
'''

TIMELINE = r'''
person = STORY_PERSON or int(sql("""
    SELECT person_id FROM measurement GROUP BY 1 ORDER BY count(*) DESC LIMIT 1""").person_id[0])
events = sql("""
    SELECT 'Visits' AS lane, visit_start_date AS day, c.concept_name AS what
    FROM visit_occurrence v LEFT JOIN concept c ON c.concept_id = v.visit_concept_id WHERE person_id = $1
    UNION ALL SELECT 'Conditions', condition_start_date, c.concept_name
    FROM condition_occurrence o LEFT JOIN concept c ON c.concept_id = o.condition_concept_id WHERE person_id = $1
    UNION ALL SELECT 'Labs and vitals', measurement_date, c.concept_name || coalesce(': ' || CAST(round(value_as_number, 1) AS VARCHAR), '')
    FROM measurement m LEFT JOIN concept c ON c.concept_id = m.measurement_concept_id WHERE person_id = $1
    UNION ALL SELECT 'Procedures', procedure_date, c.concept_name
    FROM procedure_occurrence p LEFT JOIN concept c ON c.concept_id = p.procedure_concept_id WHERE person_id = $1
    UNION ALL SELECT 'Imaging', image_occurrence_date, modality_source_value || ' study'
    FROM image_occurrence WHERE person_id = $1
    UNION ALL SELECT 'Reports and notes', note_date, note_title FROM note WHERE person_id = $1""", person)
eras = sql("""
    SELECT c.concept_name AS drug, drug_era_start_date AS start, drug_era_end_date AS stop
    FROM drug_era e JOIN concept c ON c.concept_id = e.drug_concept_id WHERE person_id = ?""", person)
# One lane per medication, for the five the patient took longest
eras["days"] = (pd.to_datetime(eras.stop) - pd.to_datetime(eras.start)).dt.days
drugs = eras.groupby("drug").days.sum().sort_values(ascending=False).index[:5].tolist()
lanes = ["Reports and notes", "Imaging", "Procedures", "Labs and vitals"] + [f"Rx: {short(d, 26)}" for d in drugs][::-1] \
    + ["Conditions", "Visits"]
colours = {"Visits": MUTED, "Conditions": INK, "Labs and vitals": "#5E6B73", "Procedures": "#9A938A",
           "Imaging": ACCENT, "Reports and notes": "#D9B08C"}
fig = go.Figure()
for lane, group in events.groupby("lane"):
    fig.add_scatter(x=group.day, y=[lane] * len(group), mode="markers", name=lane, text=group.what,
                    marker=dict(color=colours[lane], size=11 if lane == "Imaging" else 7,
                                symbol="diamond" if lane == "Imaging" else "circle", opacity=0.75,
                                line=dict(width=0)), hovertemplate="%{x|%d %b %Y}: %{text}<extra></extra>")
for e in eras[eras.drug.isin(drugs)].itertuples():
    lane = f"Rx: {short(e.drug, 26)}"
    fig.add_scatter(x=[e.start, e.stop], y=[lane, lane], mode="lines", showlegend=False,
                    line=dict(color=ACCENT, width=9), opacity=0.7,
                    hovertemplate=f"{e.drug}: {e.start:%d %b %Y} to {e.stop:%d %b %Y}<extra></extra>")
born = int(sql("SELECT year_of_birth FROM person WHERE person_id = ?", person).year_of_birth[0])
last = pd.to_datetime(events.day).max()
fig.update_layout(height=520, showlegend=False, title=f"The record of patient {person} (born {born}): "
                  f"{len(events):,} events and {len(eras)} medication periods",
                  yaxis=dict(categoryorder="array", categoryarray=lanes, title=None),
                  xaxis=dict(range=[last - pd.DateOffset(years=12), last + pd.DateOffset(months=6)],
                             rangeslider=dict(visible=True, thickness=0.06), title=None))
fig.show()
'''


def cells(title: str, question: str | None, summary: str | None, lakehouse_name: str) -> list[tuple[str, str]]:
    """The notebook as (kind, text) cells: kind is markdown, parameters or code."""
    asked = f'\n\nThe question: "{question.strip()}"' if question else ""
    query = ("\n\nThe i2b2 query:\n\n" + "\n".join(f"    {line}" for line in summary.strip().splitlines())
             if summary else "")
    return [
        ("markdown", f"# Explore the data delivered for: {title}\n\n"
                     f"This notebook comes with the delivery and reads the lakehouse **{lakehouse_name}**, attached on "
                     f"the left. Select **Run all**; it takes about a minute. The tables are OMOP CDM v5.4 "
                     f"(a limited data set, without names, MRNs or note text). The images are read through "
                     f"OneLake shortcuts to the imaging archive, and the reports are copies.{asked}{query}"),
        ("parameters", None),
        ("code", SETUP),
        ("markdown", "## 1. What was delivered"),
        ("code", DELIVERED),
        ("markdown", "## 2. Who is in the cohort\n\nHover over a bar for the count; select a legend entry to hide it."),
        ("code", PEOPLE),
        ("markdown", "## 3. Conditions\n\nFrom `condition_era`, the OMOP table that merges repeated diagnoses of the "
                     "same condition into periods. The second chart shows which conditions go together."),
        ("code", CONDITIONS),
        ("markdown", "## 4. Medications\n\nFrom `drug_era`, one period per active ingredient. Darker cells mean more "
                     "patients on that medication in that year."),
        ("code", MEDICATIONS),
        ("markdown", "## 5. Labs and vitals\n\nFrom `measurement`. Each point in the first chart is one patient's "
                     "latest result; the second follows one result over time, a grey line per patient."),
        ("code", LABS),
        ("markdown", "## 6. Care over time"),
        ("code", VISITS),
        ("markdown", "## 7. Imaging\n\n`image_occurrence` lists every study; the ones with images in the archive are "
                     "linked into this lakehouse under `Files/dicom` as OneLake shortcuts, so the images are read "
                     "where the archive keeps them."),
        ("code", IMAGING),
        ("markdown", "### A CT study\n\nDrag the slider, or press play, to move through the slices. The orange "
                     "outline is the study's largest nodule as the LIDC radiologists drew it (DICOM segmentations "
                     "stored with the study)."),
        ("code", CT),
        ("markdown", "### Every other kind of image"),
        ("code", GALLERY),
        ("markdown", "## 8. Reports and notes\n\n`document_links` lists the cohort's documents; the ones in this "
                     "delivery are copied under `Files/documents`. Below is one report for the same patient as the "
                     "CT, when there is one."),
        ("code", DOCUMENTS),
        ("markdown", "## 9. One patient's record\n\nEvery event for one patient (the patient whose CT is shown above), "
                     "from all the tables joined on `person_id`. Drag the bar under the chart to change the period."),
        ("code", TIMELINE),
    ]


def _meta(language: bool) -> str:
    return ('\n# METADATA ********************\n\n# META {\n# META   "language": "python",\n'
            '# META   "language_group": "jupyter_python"\n# META }\n') if language else ""


def content(workspace_id: str, lakehouse_id: str, lakehouse_name: str, title: str, question: str | None = None,
            summary: str | None = None) -> str:
    """notebook-content.py (Fabric Git source format), attached to the delivery lakehouse."""
    meta = {"kernel_info": {"name": "jupyter", "jupyter_kernel_name": "python3.11"},
            "dependencies": {"lakehouse": {"default_lakehouse": lakehouse_id,
                                           "default_lakehouse_name": lakehouse_name,
                                           "default_lakehouse_workspace_id": workspace_id,
                                           "known_lakehouses": [{"id": lakehouse_id}]}}}
    parts = ["# Fabric notebook source\n\n# METADATA ********************\n\n"
             + "\n".join(f"# META {line}" for line in json.dumps(meta, indent=2).splitlines()) + "\n"]
    params = (f"WORKSPACE_ID = {workspace_id!r}\nLAKEHOUSE_ID = {lakehouse_id!r}\n"
              f"LAKEHOUSE_NAME = {lakehouse_name!r}")
    for kind, text in cells(title, question, summary, lakehouse_name):
        if kind == "markdown":
            # Fabric's format: every markdown line is "# <text>", a blank line is "# " (a bare "#" breaks the cell)
            parts.append("\n# MARKDOWN ********************\n\n" + "\n".join(f"# {line}" for line in
                                                                           text.strip().splitlines()) + "\n")
        else:
            label = "PARAMETERS CELL" if kind == "parameters" else "CELL"
            parts.append(f"\n# {label} ********************\n\n{(params if kind == 'parameters' else text).strip()}\n"
                         + _meta(True))
    return "".join(parts)
