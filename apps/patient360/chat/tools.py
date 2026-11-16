"""Ask's tools. Every tool runs in the page: the server sends a page_request, the page runs it through the same data
API the record uses (local DuckDB or the Fabric App's functions) and draws the record's own viewers, then posts back
what the model needs to know. Display tools add a card to the answer and are numbered as figures.
"""
from __future__ import annotations

KINDS = ["visit", "condition", "medication", "procedure", "lab", "vital", "study", "slide", "document", "treatment",
         "diagnosis", "note"]
HAS = ["ct", "nodules", "mri", "xray", "slide", "scanned", "genome"]
TESTS_HINT = ("Test names as the record names them, e.g. HbA1c, Glucose, Creatinine, eGFR, LDL cholesterol, HDL "
              "cholesterol, Total cholesterol, Triglycerides, Haemoglobin, White cells, Platelets, Sodium, Potassium, "
              "Systolic BP, Diastolic BP, Body mass index, Weight, Heart rate, Oxygen saturation, PSA.")

_patient = {"type": "string", "description": "Patient ID: Z1234567 (Epic) or TCGA-XX-XXXX (oncology research)"}
_patients = {"type": "array", "items": {"type": "string"}, "description": "Patient IDs (Z1234567 or TCGA-XX-XXXX)"}
_title = {"type": "string", "description": "The finding the card shows, in a short sentence"}
_replace = {"type": "integer", "description": "Figure number this card replaces (to correct a card already shown)"}


def _tool(name, kind, description, properties, required=()):
    return {"name": name, "kind": kind, "description": description,
            "parameters": {"type": "object", "properties": properties, "required": list(required)}}


TOOLS = [
    # ---------------------------------------------------------------- data
    _tool("find_patients", "data",
          "Search the 3,554 patients: name, MRN, patient ID or condition text, and filters. Returns up to `limit` "
          "patients (default 10) with what each has online and the total that match. Use it to find patients by "
          "description and to resolve names to IDs. Demo patients come first.",
          {"query": {"type": "string", "description": "Name, MRN, patient ID or condition words"},
           "has": {"type": "array", "items": {"type": "string", "enum": HAS},
                   "description": "Online data the patient must have: ct (chest CT), nodules (outlined lung nodules), "
                                  "mri (brain MRI), xray, slide (H&E pathology slide), scanned (a scanned document), "
                                  "genome (a sequenced tumour: research patients and hospital patients whose "
                                  "biopsy slide is a TCGA case)"},
           "cancer": {"type": "string", "description": "breast, lung, colon, prostate, or a cancer name"},
           "sex": {"type": "string", "enum": ["Female", "Male"]},
           "age_min": {"type": "integer"}, "age_max": {"type": "integer"},
           "vital": {"type": "string", "enum": ["living", "deceased"]},
           "demo": {"type": "boolean", "description": "Only the demo patients"},
           "source": {"type": "string", "enum": ["epic", "research"],
                      "description": "epic: the hospital's 3,539 patients; research: the 15 TCGA oncology patients"},
           "request": {"type": "integer", "description": "Only the patients of this approved or delivered data request "
                                                        "(its number, from data_requests)"},
           "limit": {"type": "integer", "description": "Up to 40"},
           "add": {"type": "boolean", "description": "Add the patients found to the conversation's patient strip"}}),
    _tool("data_requests", "data",
          "The cohort data requests from Cohort Discovery that have been approved or delivered: number, title, cohort "
          "size, dates. Pending requests are counts only and are never listed. find_patients with request lists a "
          "request's patients; patient_overview says which requests include a patient.", {}),
    _tool("patient_overview", "data",
          "One patient's record at a glance: identifiers, demographics, problems (active and resolved), cancers with "
          "stage and treatment courses, current medications, latest vital signs and key labs, counts by source "
          "(Epic visits, results, PACS studies online and archived, slides, documents typed and scanned), imaging "
          "with nodules, and each tumour genome's summary (TCGA case, burden, drivers). Start here for any question "
          "about a patient.",
          {"patient_id": _patient}, ["patient_id"]),
    _tool("patient_events", "data",
          "A patient's events in date order, filtered by kind, date range and text. Kinds: " + ", ".join(KINDS) +
          ". Each event has its date, kind, title, details, its source table and an item id that show_* tools and "
          "open_record accept.",
          {"patient_id": _patient,
           "kinds": {"type": "array", "items": {"type": "string", "enum": KINDS}},
           "from": {"type": "string", "description": "YYYY-MM-DD"}, "to": {"type": "string", "description": "YYYY-MM-DD"},
           "text": {"type": "string", "description": "Words the event's title or details contain"},
           "limit": {"type": "integer", "description": "Up to 300 (default 120)"}},
          ["patient_id"]),
    _tool("lab_series", "data",
          "Values of tests and vital signs over time for one or more patients, with units, the usual adult range and "
          "flags. " + TESTS_HINT,
          {"patient_ids": _patients, "tests": {"type": "array", "items": {"type": "string"}},
           "from": {"type": "string"}, "to": {"type": "string"}},
          ["patient_ids", "tests"]),
    _tool("read_document", "data",
          "The text of a report or note (radiology, pathology, progress note; typed or scanned, where a scan's text is "
          "what it was rendered from) and the facts it was written from (findings, sizes, sites, codes). Give a "
          "document_id from patient_events or patient_overview (a research patient's pathology report is "
          "<patient id>/report; a tumour board note is its item id n:<id>, with the patient_id), or a patient_id with "
          "a type and words to find one.",
          {"document_id": {"type": "string"}, "patient_id": _patient,
           "type": {"type": "string", "enum": ["Radiology Report", "Pathology Report", "Progress Note"]},
           "text": {"type": "string", "description": "Words in the title"}}),
    _tool("imaging_studies", "data",
          "A patient's imaging: every study in the PACS (online with images, or archived offline with the index and "
          "report only), its series, the nodules the LIDC radiologists outlined (size, volume, lobe, texture, "
          "malignancy rating), slides, which studies have viewer files, and the report for each.",
          {"patient_id": _patient}, ["patient_id"]),
    _tool("query_records", "data",
          "Counts and summaries across patients from the Bronze sources, for questions about a group: how many, how "
          "often, which most. subject picks the rows: patients, conditions, medications, labs, visits, studies, "
          "nodules or documents. Filters are [field, op, value] with op in = != > >= < <= like in. group_by and "
          "measure shape the result. Restrict to patient_ids for a set of patients (such as the conversation's). "
          "Fields per subject: patients(patient_id, sex, age, deceased, cancers, demo, ct_online, nodules, "
          "largest_nodule_mm, mr_online, xray_online, slides_online, scanned_documents, visits, lab_results); "
          "conditions(patient_id, name, icd10, onset_year, active); medications(patient_id, name, generic, class, "
          "start_year); labs(patient_id, test, value, unit, year, flag); visits(patient_id, type, class, year, "
          "department); studies(patient_id, modality, description, year, online); nodules(patient_id, diameter_mm, "
          "lobe, texture, malignancy, readers); documents(patient_id, type, scanned, year); genomes, one row per "
          "sequenced tumour (patient_id, tcga_case, cancer, subtype, tmb, tmb_percentile, msi, genome_altered, "
          "aneuploidy, hrd, mutations, leukocyte_fraction, source); mutations (patient_id, tcga_case, cancer, gene, "
          "protein_change, type, driver, vaf, source); copy_number (patient_id, tcga_case, cancer, gene, call, driver, "
          "source). cancer is the TCGA study: brca, coadread, luad, lusc, prad for hospital patients; source is "
          "hospital or research. Measures: count_patients, count_rows, avg:<field>, min:<field>, max:<field>.",
          {"subject": {"type": "string", "enum": ["patients", "conditions", "medications", "labs", "visits", "studies",
                                                  "nodules", "documents", "genomes", "mutations", "copy_number"]},
           "filters": {"type": "array", "items": {"type": "array", "items": {}},
                       "description": "[[field, op, value], ...]; for op 'in' the value is a list"},
           "group_by": {"type": "array", "items": {"type": "string"}},
           "measure": {"type": "string", "description": "count_patients (default), count_rows, avg:<field>, min:<field>, max:<field>"},
           "patient_ids": _patients,
           "order": {"type": "string", "enum": ["desc", "asc"], "description": "Order of the measure (default desc)"},
           "limit": {"type": "integer", "description": "Rows to return, up to 200 (default 50)"}},
          ["subject"]),
    # ---------------------------------------------------------------- display (cards, numbered as figures)
    _tool("show_patients", "display",
          "A table of patients with what each has online and a link to open each record. Use it to present the "
          "patients found or the ones a question compares.",
          {"patient_ids": _patients, "title": _title, "note": {"type": "string", "description": "Why these patients"},
           "replace": _replace},
          ["patient_ids", "title"]),
    _tool("show_timeline", "display",
          "Timelines drawn from the record. One patient: their lifetime timeline (visits, conditions and medications, "
          "cancer course, imaging, slides and documents). Several patients (up to 8): one row each on a shared axis, "
          "aligned on calendar dates or on an event (first cancer diagnosis, first study of a modality), with the "
          "kinds of event asked for.",
          {"patient_ids": _patients, "title": _title,
           "kinds": {"type": "array", "items": {"type": "string", "enum": KINDS}},
           "align": {"type": "string", "enum": ["calendar", "first_cancer", "first_ct", "first_slide", "death"],
                     "description": "For several patients: the event at year 0"},
           "match": {"type": "string", "description": "With align first_cancer: words in the name of the cancer to align "
                                                      "on (e.g. lung), for patients who had more than one"},
           "from": {"type": "string"}, "to": {"type": "string"}, "replace": _replace},
          ["patient_ids", "title"]),
    _tool("show_measurements", "display",
          "Trend charts of tests and vital signs: one panel per test, one line per patient, the usual adult range "
          "shaded and out-of-range values marked. " + TESTS_HINT,
          {"patient_ids": _patients, "tests": {"type": "array", "items": {"type": "string"}}, "title": _title,
           "from": {"type": "string"}, "to": {"type": "string"},
           "mark": {"type": "array", "items": {"type": "string"},
                    "description": "Dates to mark with a vertical line (YYYY-MM-DD), e.g. a diagnosis or a new drug"},
           "replace": _replace},
          ["patient_ids", "tests", "title"]),
    _tool("show_scan", "display",
          "A CT, MRI or PET/CT in the record's 3D viewer with all its controls (views, layers, clip, timeline, full "
          "screen). Chest CTs carry the radiologists' nodule outlines and centre on a nodule. The imaging demo's "
          "studies on demo patients (ids such as petct-whole-body in imaging_studies) also take layers and a time "
          "point; the brain fibre-tract atlas (brain-tractography) also takes bundles, colour and map, and its result "
          "gives each bundle drawn its reach, the cortical areas it reaches in what share of people, and its volume "
          "across them. Only studies with viewer files open; imaging_studies says which.",
          {"patient_id": _patient,
           "study": {"type": "string", "description": "Accession number, study UID or an imaging-demo study id"},
           "view": {"type": "string", "enum": ["3d", "mip", "mpr", "axial", "coronal", "sagittal"],
                    "description": "mip only where imaging_studies lists it (PET)"},
           "layers": {"type": "array", "items": {"type": "string"},
                      "description": "Imaging-demo studies: the layer ids to show, as imaging_studies lists them (e.g. "
                                     "pet, lesions); the others start hidden"},
           "frame": {"type": "number",
                     "description": "Imaging-demo studies with a timeline: the time point to open on (a gestational "
                                    "week, a breathing phase in %)"},
           "bundles": {"type": "array", "items": {"type": "string"},
                       "description": "Brain fibre-tract atlas: the bundles to draw alone, by id (CST_L), abbreviation "
                                      "(CST, both sides), name (left corticospinal tract) or group (projection)"},
           "colour": {"type": "string", "enum": ["direction", "bundle"],
                      "description": "Brain fibre-tract atlas: colour lines by direction (default) or one colour per "
                                     "bundle with a legend naming them"},
           "full_size": {"type": "boolean",
                         "description": "Imaging-demo studies that imaging_studies says have a full-size version: open "
                                        "the original-resolution files (bigger, slower to load); default the reduced ones"},
           "map": {"type": "string",
                   "description": "Brain fibre-tract atlas: one bundle (one side, e.g. AF_L) whose probability map across "
                                  "the 1,065 people goes on the slices over the template brain; opens in MPR"},
           "nodule": {"type": "integer", "description": "The nodule to centre on, by its PACS label number as imaging_studies "
                                                       "and the viewer's legend show it ('Nodule 6' is 6); default the largest. "
                                                       "Centring needs a slice view (mpr, axial or coronal); 3d shows the whole "
                                                       "chest with every outline coloured."},
           "title": _title, "replace": _replace},
          ["patient_id", "title"]),
    _tool("show_slide", "display",
          "A whole-slide image in the deep-zoom viewer with all its controls (zoom to 40x, guided tour, compare, the "
          "report beside it, full screen). AI layers: a TCGA patient's diagnostic slide has the lymphocyte map "
          "(lymphocytes); the imaging demo's breast case has nuclei and til. A multiplex fluorescence slide "
          "(colon-cycif) shows the marker channels asked for.",
          {"patient_id": _patient,
           "slide": {"type": "string",
                     "description": "Accession, series UID, slide ID or an imaging-demo slide id; default the first"},
           "layers": {"type": "array", "items": {"type": "string"},
                      "description": "AI layers to switch on: lymphocytes, nuclei or til"},
           "channels": {"type": "array", "items": {"type": "string"},
                        "description": "Fluorescence slides: the marker channels to show, by id or name (e.g. dna, "
                                       "pan-cytokeratin, cd8a); the others start off. Include dna to see every "
                                       "nucleus."},
           "report": {"type": "boolean",
                      "description": "Open the slide's own pathology report beside it in the same card (a TCGA "
                                     "patient's report, a scanned hospital report, or an imaging-demo case's report)"},
           "title": _title, "replace": _replace},
          ["patient_id", "title"]),
    _tool("show_xray", "display", "A chest X-ray in a zoomable viewer.",
          {"patient_id": _patient, "study": {"type": "string", "description": "Accession number or study UID"},
           "title": _title, "replace": _replace},
          ["patient_id", "title"]),
    _tool("show_document", "display",
          "A report or note as the clinician reads it: the text with its facts marked and, for a scanned document, the "
          "scan beside it.",
          {"document_id": {"type": "string"}, "title": _title, "replace": _replace},
          ["document_id", "title"]),
    _tool("show_genome", "display",
          "A tumour genome: mutation burden against the same cancer in TCGA, copy number and every mutation along "
          "the genome, driver alterations, expression and the immune mix.",
          {"patient_id": _patient,
           "tumour": {"type": "string", "description": "The TCGA case (e.g. TCGA-77-6843) when the patient has more "
                                                       "than one genome; the first otherwise"},
           "title": _title, "replace": _replace},
          ["patient_id", "title"]),
    _tool("show_side_by_side", "display",
          "Two to four views side by side in one card, for any comparison: two patients' CTs, slides, genomes or "
          "reports; a slide beside the report that describes it; the same patient's scans before and after "
          "treatment. Each item is another display tool's call (its tool and arguments, without a title), with a "
          "short label naming what it is and an optional note of one or two sentences shown under it. facts adds a "
          "table under the views: one row per point of comparison, one value per item, in the items' order.",
          {"title": _title, "subtitle": {"type": "string", "description": "How to read it (optional)"},
           "items": {"type": "array", "minItems": 2, "maxItems": 4, "items": {"type": "object", "properties": {
               "tool": {"type": "string", "enum": ["show_scan", "show_slide", "show_xray", "show_document",
                                                   "show_genome", "show_timeline", "show_measurements"]},
               "args": {"type": "object", "description": "That tool's arguments, without title"},
               "label": {"type": "string", "description": "What this view is, e.g. 'Jettie Osinski, adenocarcinoma'"},
               "note": {"type": "string", "description": "One or two sentences under this view (optional)"}},
               "required": ["tool", "args", "label"]}},
           "facts": {"type": "array", "items": {"type": "object", "properties": {
               "label": {"type": "string"}, "values": {"type": "array", "items": {"type": "string"}}},
               "required": ["label", "values"]},
               "description": "Up to 10 rows: [{label, values: [one short value per item]}]"},
           "replace": _replace},
          ["title", "items"]),
    _tool("show_chart", "display",
          "A chart for numbers the other cards don't draw (counts across a group, comparisons between patients): a "
          "Vega-Lite spec with the rows inline. The page applies the app's theme: ink for the subject, grey for the "
          "rest, orange only for worse or abnormal. Bars start at zero.",
          {"title": _title, "subtitle": {"type": "string", "description": "How to read it"},
           "spec": {"type": "object", "description": "Vega-Lite (mark, encoding, transforms); data.values is set from rows"},
           "rows": {"type": "array", "items": {"type": "object"}}, "replace": _replace},
          ["title", "spec", "rows"]),
    _tool("open_record", "display",
          "A link that opens a patient's record at a tab and item (summary, visits, measurements, conditions, "
          "medicines, cancer, treatment, radiology, pathology, documents, genomics, notes, cohorts).",
          {"patient_id": _patient, "tab": {"type": "string"}, "item": {"type": "string", "description": "An item id from patient_events"},
           "title": _title},
          ["patient_id", "title"]),
    _tool("draft_note", "display",
          "A draft tumour board note about a patient, shown to the reader with a button to add it to the record. You "
          "never write to the record; the reader decides.",
          {"patient_id": _patient, "text": {"type": "string", "description": "The note, written from the record (up to 4,000 characters)"},
           "about": {"type": "string", "description": "An item id the note is about (optional)"}, "title": _title},
          ["patient_id", "text", "title"]),
]

TOOL_BY_NAME = {t["name"]: t for t in TOOLS}
DISPLAY = {t["name"] for t in TOOLS if t["kind"] == "display"}
