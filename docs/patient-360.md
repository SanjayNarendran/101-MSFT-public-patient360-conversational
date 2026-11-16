# Patient 360 and Ask: plan and build log

This is the design and build log of the original deployment. The Epic tables there came from another store through
OneLake shortcuts; in this repository `scripts/05_onelake_load.py` writes them straight into `Bronze_Clarity` and
`Bronze_Caboodle`, and the research data comes from the pipelines in [research/](../research/README.md).

Two additions to the demo, built side by side:

1. **Patient 360**: one patient's whole record on a lifetime timeline, whatever source or format each part comes
   from: Epic Clarity tables, the PACS database, DICOM in OneLake, typed and scanned documents, and the oncology
   research data. A port of the Patient 360 reference app
   ([MS101-public-patient-360-fabric-rayfin-GHC](https://github.com/SanjayNarendran/MS101-public-patient-360-fabric-rayfin-GHC),
   here called *the reference app*; its pipeline is in [research/patient360](../research/patient360)) to this dataset: 3,539
   patients instead of 15, so the patient list searches and pages instead of showing everyone.
2. **Ask**: a conversation with GitHub Copilot about one patient or several at once, answered with the record's own
   viewers (slides, CT and MRI, X-rays, scanned documents, timelines, lab trends, genomics) drawn inside the answer.
   It follows the conversational design of the CMS Quality Dashboard's *Ask your data*
   ([MS102-public-CMS-Hospital-Insights-fabric-rayfin-GHC](https://github.com/SanjayNarendran/MS102-public-CMS-Hospital-Insights-fabric-rayfin-GHC),
   `copilot/` and `assets/js/chat/`), and is tested the same way.

Both run locally (no Fabric, no sign-in) and as a Fabric App. Started 2026-11-08.

Status: ☐ to do · ◐ in progress · ☑ done · ⏸ deferred until the app works

## Decisions (user, 2026-11-08)

| | Decision |
| --- | --- |
| Where it lives | Its own Fabric App **`patient-360`** in workspace MedicalCohortDemo, with a local mode. Linked both ways with `cohort-approval` |
| What the record reads | The **Bronze** sources: Epic Clarity and Caboodle (`Bronze_Clarity`, `Bronze_Caboodle`), `Bronze_PACS`, `Bronze_ImagingArchive`, `Bronze_ClinicalDocuments`. Not OMOP or i2b2 |
| Demo patients | (a) About 12 of our own patients picked to show every modality, pinned as *Demo patients*. (b) The reference app's 15 TCGA patients imported as well, with their genomics, AI segmentations and lymphocyte maps |
| Import route | The fastest copy available: local to local (APFS clone of the reference app's `work/`), Fabric to Fabric (OneLake to OneLake, server side). No re-download, no re-processing |
| Image viewers | First, full viewers built ahead for the demo patients; any other patient's images open from what's available. **The full build for every online study runs after the app works, in parallel with the user's testing** (see [Data work that runs during testing](#data-work-that-runs-during-testing)) |
| Hosted chat | Container App `patient360-chat` in `cohort-discovery-env`, on each viewer's own GitHub Copilot plan, with a **new GitHub OAuth App** "Patient 360 (Fabric)" |
| Follow-up data | All five: TCGA genomics from cBioPortal for the 792 slide patients; TCGA registry details for them; Coherent immunisations, allergies, care plans and devices; Coherent germline DNA panel; AI lymphocyte (TIL) maps for the TCGA slides. Built after the app, not blocking it |
| Look and words | The cohort apps' theme (`apps/shared/theme.css`, the CMS dashboard look) and voice. No AI-slop styling or phrasing (see [Style](#style)) |

Assumed, to confirm while building: Claude Opus 5.5 at high thinking as the chat's default model (each viewer can
pick another), as in the CMS dashboard; the capacity resumed only for Fabric work and paused after;
the Container App stopped with minimum replicas 0 between demos.

## What we start from

**The reference app** (React 19, Vite, Tailwind 4, Rayfin 1.36; about 19,000 lines). Patients page with one SQL
statement across three silos; the record: lifetime timeline (five lanes, zoom, date-picker pill that snaps from event
to event, lane resizing, left or top layout), 13 tabs synchronised with the timeline and the URL, Summary with a
*Read in place* provenance drawer, Visits, Measurements (ten small multiples with adult ranges), Conditions,
Medications and immunisations, Cancer course, Treatment, Pathology (OpenSeadragon, deep zoom, AI lymphocyte map,
guided tour), Radiology (NiiVue, 3D/MPR, AI segmentation with volumes), Report (PDF.js beside the OCR text, facts
highlighted), Tests, Genomics (TMB and peers, genome plot, drivers, expression, immune mix), Tumour board notes (the
only write, Rayfin Data); Where the data lives; Sources. Local mode is a Vite plugin running the same queries in
DuckDB and serving files from `work/` (`local/plugin.ts`, `local/api.ts`); Fabric mode is Rayfin Functions
(`getCohort`, `getPatient`, `getDataMap`) on a shortcut-only lakehouse's SQL endpoint, with signed OneLake links for
files.

**The CMS dashboard's Ask your data**: Starlette and the Copilot SDK (`copilot/server.py`), one codebase for local and
relay modes; tools whose results are drawn by the page; figure templates drawn with d3 into the answer; Vega-Lite as a
fallback; every figure measured from the reader's side and redrawn when the check flags it; the tab (Copilot speaks
first, suggestions by role above a docked box, steps that open to reasoning and tool calls) and the right-click popup
that becomes a docked side panel; chat history with folders and archive; an evaluation that asks 81 questions through
the real page and grades them (`copilot/dev/eval.py`, `copilot/TESTING.md`).

**This repo**: the Cohort Discovery chat (`apps/discovery/app.py`, the relay in `apps/discovery/relay/`, chat tickets
from the approval app's `chatTicket` function, `scripts/23_discovery_chat.py` to deploy) and its starter questions
grouped with a short line on what each shows.

## The data, against the reference app

3,539 patients (Synthea Coherent, reshaped into Epic tables). Imaging: 12,910 studies indexed, 2,398 ONLINE in OneLake.

| Reference app | Here | Source here |
| --- | --- | --- |
| Visits, vitals, labs, screening scores | ☑ 286,647 visits, 1.38M measurements | Clarity `PAT_ENC`, `PAT_ENC_HSP`, `IP_FLWSHT_MEAS` (+ `IP_FLO_GP_DATA`), `ORDER_RESULTS` (+ `CLARITY_COMPONENT`), `CLARITY_SER`, `CLARITY_DEP` |
| Conditions and medications | ☑ | `PAT_ENC_DX`, `PROBLEM_LIST` (+ `CLARITY_EDG`), `ORDER_MED` (+ `CLARITY_MEDICATION`, drug classes) |
| Procedures | ☑ | `ORDER_PROC` (+ `CLARITY_EAP`) |
| Immunisations, allergies, care plans | ☐ not loaded | Coherent publishes them for the same patients (follow-up D3) |
| Cancer course and treatment (GDC registry) | ◐ Synthea cancer conditions, procedures and chemotherapy for every patient; TCGA stage, TNM, grade and Gleason for the 792 slide patients in `data/raw/imaging/tcga_slides.csv` | Clarity; registry follow-up D2 |
| Pathology slides | ☑ 792 TCGA H&E slides (LUAD 54, LUSC 73, COAD 146, PRAD 378, BRCA 141) as DICOM SM | `Bronze_PACS`, `Bronze_ImagingArchive` |
| AI lymphocyte maps | ☐ | IDC (follow-up D5); the 15 imported patients have them |
| Radiology | ☑ 1,018 LIDC chest CTs with up to four radiologists' nodule outlines (SEG) and ratings, 298 brain MRIs, 290 chest X-rays (DX/CR); 10,512 more studies indexed as OFFLINE | `Bronze_PACS` (`Study`, `Series`, `Instance`, `NoduleFinding`), `Bronze_ImagingArchive` |
| AI segmentations | ☐ (radiologist outlines instead, for the CTs) | the 15 imported patients have them |
| Pathology report | ☑ 792 (692 typed, 100 scanned PDFs) | `Bronze_ClinicalDocuments` |
| Tests (tumour markers, PFTs) | ◐ the labs Synthea records (PSA and others where present) | `ORDER_RESULTS` |
| Tumour genome | ☑ | the 15 imported patients, and 756 genomes of the slides' TCGA cases for 681 hospital patients (D1, cBioPortal) |
| Tumour board notes | build | the app's own Rayfin database (Fabric) or a JSON file (local) |
| *Not in the reference app* | Radiology reports (11,968 typed, 150 scanned), progress notes (4,750 typed, 250 scanned), document facts (the ground truth behind every report), Epic identifiers (MRN, CSN, order and accession numbers) across the sources, i2b2 cohorts and data requests that include the patient, OFFLINE studies, brain MRI, X-rays, multi-reader nodule ratings, deaths | Clarity, `Bronze_PACS`, `Bronze_ClinicalDocuments`, `Cohort_Requests` |

Patients with more than one online modality: 481 with two kinds (CT, slide, MRI, X-ray), 52 with three, 4 with all
four. These are where the demo patients come from.

## Design

### Architecture

```
                      local:  npm run dev:local in apps/patient360       chat: python apps/patient360/chat/server.py
Browser (React) ──/local-api──▶ Vite plugin: DuckDB over data/generated (Clarity CSVs, PACS, documents, research silos)
   │    ▲        /local-files─▶ viewer assets, documents, DICOM previews from data/generated
   │    └─ page tools ◀── NDJSON ── /chat-api ──▶ chat server (Copilot SDK) ──▶ Copilot runtime ──▶ models

                      Fabric: Fabric App patient-360 (static site + Rayfin Functions + Rayfin Data)
Browser ──Rayfin Functions──▶ searchPatients, getPatient, getDocument, queryRecords, getDataMap, chatTicket
   │                          (as the signed-in user)
   │                             └─ T-SQL on the Patient360 lakehouse's SQL endpoint, three-part names to
   │                                Bronze_Clarity, Bronze_PACS, Bronze_ClinicalDocuments and the oncology silos
   │──signed read-only links──▶ OneLake (viewer files, scanned documents, slides, volumes, reports), into the viewers
   └──question + ticket──▶ Container App patient360-chat (same chat server, RELAY=1) ──▶ the user's Copilot plan
                              └─ page_request ──▶ the page runs the tool through the same functions ──▶ tool-result
```

- **One data API, two back ends**, as in the reference app: `rayfin/functions/src/*.ts` (T-SQL on Fabric) and
  `local/api.ts` (DuckDB on local files) keep the same queries and return the same shapes. A query changed in one is
  changed in the other.
- **Chat tools run in the page, in both modes.** The chat server only talks to Copilot. When Copilot calls a tool, the
  server sends a `page_request`; the page runs it through the data API it already uses for the record and posts the
  result back. The tools are written once (TypeScript), the viewers they open are the record's own components, and
  the local chat and the hosted relay are the same Python code.
- **Patient keys.** Epic patients by `PAT_ID` (`Z1000001`), with MRN shown; imported research patients by their TCGA
  barcode. A patient index (`p360_patient`, below) maps every key and says which sources hold the patient.
- **Governance.** Patient 360 is a clinical view of identified records. Cohort Discovery stays counts-only: the record
  and Ask list a request's patients only once it's APPROVED or DELIVERED.

### Data layer

New lakehouse **Patient360** (Fabric) and `data/generated/p360/` (local):

- **No shortcuts.** One SQL endpoint (Patient360's) reaches every other item by its three-part name
  (`Bronze_Clarity.dbo.PAT_ENC`, `Bronze_PACS.pacs.Study`), so the lakehouse holds only the derived tables.
- **Hidden times.** Lakehouse SQL endpoints leave out `timestamp_ntz` columns (what pandas writes for
  naive datetimes, and what the original deployment's Epic tables carried). The record reads ten such columns: `PAT_ENC`
  (APPT_TIME, ENC_CLOSE_TIME), `PAT_ENC_HSP` (admission and discharge), `ORDER_RESULTS` (RESULT_TIME), `IP_FLWSHT_MEAS`
  (RECORDED_TIME), `ORDER_PROC` (ORDER_INST, PROC_START_TIME) and `document_index` (service and signed times). In
  Fabric they come from companion tables `p360_time_<table>` (key and times), written by `24 --fabric` from the Bronze
  copy; `record.ts` (`timed()`) joins each back under the table's alias, so local and Fabric queries read the same
  columns. `05_onelake_load.py` writes the Epic times as UTC timestamps, which the endpoint shows; the companions work
  either way.
  `common.write_tables` writes naive datetimes as dates or UTC timestamps, so the derived tables don't lose columns.
- **Derived tables**, built by a script and kept small:
  - `p360_patient`: one row per patient: keys (PAT_ID, MRN, TCGA barcode), name, sex, birth and death dates, age,
    the sources holding them, counts (visits, labs, notes, documents, studies online and offline), modalities online
    (CT, CT with nodule outlines, MRI, X-ray, slide), cancers, top long-term conditions, demo flag, demo order and
    *why this patient*, and a search text. Drives search, filters and paging.
  - `p360_viewer_asset`: one row per prepared viewer asset (volume, label map, deep-zoom slide, X-ray image,
    preview): study, series, kind, path, size, built at.
  - `p360_demo`: the pinned demo patients and the story each one tells.
  - `p360_time_<table>`: the hidden time columns above.
  - `p360_inventory`: every source item's tables (bytes in OneLake) and Files area (files, bytes), measured by
    `24 --fabric` for *Where the data lives*; row counts there are live.
- **Research silos**, imported from the reference app and grown by the follow-ups: `Bronze_Oncology_Clinical` (GDC
  registry, the 15 imported patients' synthetic primary care), `Bronze_Oncology_Genomics` (somatic mutations, copy
  number, expression, immune mix, molecular profile, cohort reference; later the germline panel),
  `Bronze_Oncology_Imaging` (deep-zoom slides with lymphocyte maps, NIfTI volumes with AI segmentations), with the
  reference app's table schemas, so its Genomics, Cancer course and Treatment tabs work unchanged.

### Images

| Kind | Demo patients now | Everyone else, now | After the full build (E1) |
| --- | --- | --- | --- |
| Chest CT (LIDC) | NIfTI volume and a label map per reader and nodule (from the SEG objects), nodule list with size, volume and the readers' ratings; NiiVue 3D, MPR, cut plane | Nodule list and report; viewer opens the series from DICOM in the browser if the spike (A3.1) works, otherwise "prepared on request" | NIfTI and label maps for all 1,018 |
| Brain MRI (Coherent) | NIfTI from the multi-frame DICOM | as above | all 298 |
| X-ray (DX/CR) | 8-bit PNG with window and level kept from the header | in-browser DICOM if the spike works | all 290 |
| Slide (SM) | Deep Zoom pyramid (OpenSlide reads DICOM WSI) and thumbnail | low-resolution level as a still image | all 792; lymphocyte maps from D5 |
| OFFLINE studies (10,512) | listed on the timeline and in Radiology as archived, with their reports | same | same |

Source for builds: the DICOM already in OneLake, or the original public buckets (IDC, Coherent), whichever is faster
on the day; both are the same files.

### Patient 360 app

`apps/patient360/` starts as a copy of the reference app's code (not its data or deployment state), then:

- **Theme**: `apps/shared/theme.css` tokens and the cohort apps' top bar (wordmark, section switch, workspace, user,
  Light/Dark). The reference app's `atlas.css` component styles are kept, with their tokens mapped to the shared ones.
- **Patients page**: *Demo patients* first (ours and the imported 15, each with *why this patient*), then search:
  name, MRN or ID, condition, and filters for modality (CT with nodule outlines, slide, MRI, X-ray, scanned document,
  genome), cancer type, sex, age band, living or deceased, and *patients in an approved request*. Ten rows at a time,
  with *Show 10 more*. *Show the SQL* shows the statement across Epic, PACS and documents.
- **Record**: the reference app's timeline and tabs, with dates as dates (the reference app counts days from
  diagnosis), and lanes for visits; conditions and medications; cancer course and treatment (when there is a cancer);
  imaging, pathology and tests (OFFLINE studies drawn hollow); documents; tumour board. Tabs without items are hidden.
  New tabs: **Documents** (every report and note, typed or scanned, OCR beside the scan, facts highlighted),
  **Cohorts** (approved and delivered requests that include the patient, linked to the approval app) and the Epic
  identifiers in *Read in place*.
- **Where the data lives** and **Sources**: rewritten for the Bronze sources, the research silos and their licences.
- **Links**: the approval app's request page lists a delivered request's patients with *Open in Patient 360*; the
  record's Cohorts tab links back.

### Ask

- **Surfaces**, as in the CMS dashboard: an **Ask** tab (name to confirm), and right-click anywhere in the app (a
  patient row, a timeline mark, a lab point, a nodule, a slide region, a document passage) for a popup with what was
  clicked and questions that fit it, which becomes a side panel docked on the right; *Continue in Ask* moves it to the
  tab. Copilot speaks first; suggestions by role sit above the docked box; the patients in the conversation, the model
  and the thinking level share the line just above it; each answer opens with the answer, then its viewers and figures in cards with a short note under each, then the
  steps (reasoning, each tool call with its arguments, result and timing).
- **Patients in the conversation**: a strip of patient chips above the box. Add them from search, from the open record,
  from the demo list or from an approved request; Copilot's `find_patients` adds them too. One patient or many.
- **Tools**: data tools (`find_patients`, `patient_overview`, `patient_events`, `lab_series`, `read_documents`,
  `imaging_studies`, `genomics`, `request_patients`, and `query_records`, a structured query compiled to T-SQL or DuckDB
  so the model never writes a dialect) and display tools that draw the record's own components in the answer
  (`show_timeline`, aligned across patients on an event; `show_measurements`; `show_scan` with nodule outlines,
  plane, window; `show_slide` with region and overlay; `show_xray`; `show_document`, scan beside text with passages
  highlighted; `show_genome`; `show_patients`; `show_figure` from the CMS figure templates; `render_visual` with
  Vega-Lite as the last resort; `open_record`). `draft_note` writes a tumour board note that the reader adds with one
  click; Copilot never writes to the record itself.
- **Rules**: answer first; every fact says where it came from (source, document, study, date); synthetic and real data
  labelled; say plainly what the record doesn't hold; education and research only, no diagnosis or treatment advice;
  the dashboard's writing rules; figures checked from the reader's side (`check.js`) and redrawn when flagged.
- **History**: every chat saved with its answers, in folders, with an archive; reopened answers shown as answered.
  Local: DuckDB and answer files under `data/chats/`. Fabric: Rayfin Data (`ChatFolder`, `ChatThread`, `ChatTurn`,
  per user) and answer files in the Patient360 lakehouse.
- **Sign-in**: locally, the Copilot accounts on this Mac. In Fabric, *Sign in with GitHub* through the relay (GitHub
  OAuth web flow, token kept in the relay's memory keyed to the Fabric user from the chat ticket).

### Style

- Look: the shared theme's warm ivory and ink, one orange accent used only for state, Fira Sans with Fira Sans
  Condensed headings and Fira Mono for identifiers, hairline rules, 3 to 4 px corners. No gradients, glass, glows,
  emoji, hero stat cards, icon grids or sparkle badges. Numbers in sentences or definition lists. Colour carries
  meaning only: one muted hue per modality, red for disease events, dashed grey for anything synthetic.
- Motion: panels, the side panel, full screen and view changes slide and morph smoothly, never cut.
- Words: plain, specific and editorial, as on the dashboards. No negation frames ("not X but Y"), triplets of one-word
  claims, slogan titles, colon reveals, closing lines starting with "So", bold lead-ins, exclamation marks, or AI
  vocabulary. Ask's answers follow the same rules (enforced in its rules and flagged by the evaluation).
- Disclaimer as in the reference app: synthetic or public de-identified data, education and research only.

## Files

| Path | What |
| --- | --- |
| `apps/patient360/` | The app: React, Vite, Rayfin (`rayfin/rayfin.yml`, functions, `TumorBoardNote` and chat history entities), local mode (`local/`) |
| `apps/patient360/chat/` | Chat server (local and relay), `rules.py`, `tools.py` (tool definitions), `history.py` (local), `Dockerfile`, `QUESTIONS.md`, `TESTING.md`, `dev/` (cases, eval) |
| `scripts/24_patient360_data.py` | Bronze copy, `p360_patient`, `p360_demo` (local parquet); `--fabric`: the Patient360 lakehouse with those, the time companions and the inventory |
| `scripts/25_patient360_viewers.py` | Viewer files: the demo patients (default) or `--all`; resumable; `--fabric` / `--upload-only` copy them to Patient360/Files/viewer |
| `scripts/26_patient360_import.py` | The reference app's 15 patients: `--from-local [path]` (APFS clone of research/patient360/work) or `--upload-local` |
| `scripts/27_patient360_app.py` | Writes the functions' config and deploys the Fabric App (as `22_approval_app.py`) |
| `scripts/28_patient360_chat.py` | The Ask relay: `create`, `configure`, `deploy`, `set-app-secret` (as `23_discovery_chat.py`) |
| `scripts/29_*.py` and later | Follow-up data (D1 to D5) |

## Todo

### A. Patient 360, local

- ☑ A0. Plan (this file), commit.
- ☑ A1. Patient index and demo patients: `p360_patient` from Clarity, PACS and documents (local parquet); pick about
  12 demo patients across every modality with *why this patient*; check counts against the sources.
- ☑ A2. Port the app into `apps/patient360`: copy the reference app's code, rename, shared theme and top bar, remove
  its data files and deployment state; builds and tests pass.
- ☑ A3. Local data API over Bronze: `searchPatients` (search, filters, paging), `getPatient` (record from Clarity,
  PACS, documents), `getDataMap`; DuckDB in `local/api.ts`.
  - ⏸ A3.1. Spike: open a CT, an MRI and an X-ray straight from DICOM in the browser. Dropped (2026-11-08): building
    viewer files takes about 5 s per CT or MRI and 10 to 40 s per slide, so the full build (E1) covers every online
    study; until it runs, other patients' studies say their viewer files aren't built yet.
- ◐ A4. Record: patients page (demo first, search, ten at a time), timeline lanes and tabs for this data, Documents and
  Cohorts tabs, *Read in place* with Epic identifiers, Where the data lives, Sources.
- ☑ A5. Viewer assets for the demo patients (`25_patient360_viewers.py --demo`): CT and MRI volumes, nodule label maps,
  X-ray images, deep-zoom slides; Radiology and Pathology tabs on them.
- ☑ A6. Import the reference app's 15 patients locally (`26_patient360_import.py --from-local`, APFS clone); the record
  reads them from the research silos; all their tabs work.
- ☑ A7. Tumour board notes (local JSON store; demo notes for our demo patients written from their records and
  labelled illustrative).
- ☐ A8. Local test in the browser: every tab for every demo patient, light and dark, 1440 px and the integrated
  browser's width; fix; commit.

### B. Ask, local (starts once A3 returns records)

- ☑ B1. `chat/QUESTIONS.md` and `src/chat/starters.ts`: 25 suggested questions in six roles (oncology, radiology,
  pathology, primary care, research, data), each with what it shows; three more when patients are in the
  conversation; the side panel's suggestions by tab. Nursing and care management were folded into primary care.
- ☑ B2. Chat server (`chat/server.py`, from the CMS dashboard's): local and relay modes, page requests, steps, stop,
  models, accounts, resume; `rules.py` for this data; `tools.py` with 7 data and 11 display tools.
- ☑ B3. Page tools in TypeScript (`src/chat/tools.ts`): data tools over the same API as the record, `query_records`
  compiled for DuckDB and T-SQL (`record.ts` `querySql`), display tools drawing the record's own viewers as cards
  (`cards.tsx`); multi-patient timelines and result trends drawn in the same marks; Vega-Lite for counts with the
  app's theme. The CMS figure templates and reader-side check were not ported: the cards are the record's views, and
  each display tool's result tells the model what the card shows.
- ☑ B4. The Ask tab (`src/pages/Ask.tsx`), right-click menu and side panel that narrows the page
  (`src/chat/SidePanel.tsx`), patients in the conversation, Continue in Ask, Ask about this patient on each record.
- ☑ B5. Chat history, local (`chat/history.py`, `src/chat/History.tsx`): folders, archive, rename, move, delete,
  search by title or patient; reopened chats draw their cards again and carry on in the same Copilot session.
- ☑ B6. Evaluation: `chat/dev/cases.py` (45 cases: every suggested question, free-form, outside the data,
  robustness, follow-ups, side panel) and `chat/dev/eval.py` (Playwright through the real page, cards saved as PNG,
  answers graded); `chat/TESTING.md` with the results: 45 of 45 without flags after six runs, median answer 14 s.

### C. Fabric

- ☑ C1. Patient360 lakehouse with the derived tables, the time companions and the inventory (`24 --fabric`); no
  shortcuts (three-part names).
- ☑ C2. Viewer files for the demo patients to OneLake (`25 --upload-only`: 24,953 files, 2 GB, under a minute).
- ☑ C3. The 15 patients Fabric to Fabric (OneLake to OneLake from the reference app's workspace): tables, reports, 229,561 slide
  tiles (28.7 GB in 7 minutes) and the volumes, server side; the source capacity ran only for the copy.
- ☑ C4. Rayfin Functions (`searchPatients`, `getPatient`, `getDocument`, `queryRecords`, `getDataMap`, `chatTicket`),
  as the signed-in user; deploy `patient-360` (`27_patient360_app.py`) into the folder *Patient 360*. Tumour board
  notes and Ask's history (`AskFolder`, `AskChat`, `AskTurn`, private to each user) use the app's Rayfin Data.
- ☑ C5. Ask relay: Container App `patient360-chat` in the Discovery relay's environment and registry, GitHub OAuth App
  *Patient 360 (Fabric)*, client secret stored from the person's clipboard, ticket key, CORS, deploy
  (`28_patient360_chat.py`).
- ◐ C6. Test in Fabric: patient list, Levi Hills's record (Epic, PACS, documents), his CT with the 10 nodules from
  OneLake, a TCGA patient's radiology, slides, report and genomics from the imported silos, Where the data lives,
  and Ask (GitHub sign-in, a starter question answered with the CT and the biopsy slide in 20 s). Still to run: the
  evaluation's cases against the hosted app, tumour board notes; then pause the capacity.
- ☑ C7. The record's **Cohorts** tab (approved and delivered requests that include the patient, whether a demo-mode
  delivery included them, the i2b2 query, links to the request and to the cohort's patients), a *Data request* filter
  in the patient list (`?request=<id>` links to it), Ask's `data_requests` tool and `request` filter, and *Open the
  cohort's patients in Patient 360* on the approval app's request page. Read live in Fabric (`Cohort_Requests` and
  `Silver_OMOP.i2b2_patient_mapping` by three-part name); locally from copies `24` makes. Pending requests stay
  counts only everywhere.

### D. Follow-up data (after the app works; does not block testing)

- ☑ D1. TCGA genomics for the slide patients: `scripts/29_patient360_genomics.py` fetches 755 genomes in bulk from
  cBioPortal's PanCancer Atlas studies (mutations, copy number, expression of the gene panel, subtype, TMB, MSI) and the
  immune landscape files from the GDC, and merges them into the research genomics tables (37 of the 792 cases have no
  sequenced primary tumour in cBioPortal's lists; one, TCGA-J4-A6G3, is also a research patient). `24` links 681
  hospital patients to 756 genomes (`p360_genome`); a patient with two cancers has two. The record shows one genome mark per tumour on the
  slide's day, the Genomics tab lists them, and a slide links to its tumour's genome. Ask's `show_genome` takes
  `tumour`, and `query_records` gained `genomes`, `mutations` and `copy_number` for questions across genomes.
- ⏸ D2. TCGA registry details for the 792 (stage, TNM, grade, Gleason, nodes; treatments and follow-up from the GDC).
- ⏸ D3. Coherent immunisations, allergies, care plans and devices into Clarity (`01`, `02`, `05 TABLE ...`, `06`),
  then into the record.
- ⏸ D4. Coherent germline DNA panel into the genomics silo.
- ⏸ D5. AI lymphocyte maps for the TCGA slides from IDC, as slide overlays.
- ☐ D6. Nodule side and lobe for 11 LIDC subjects (27 nodules, e.g. LIDC-IDRI-0697, Stanley Bernhard's 39.6 mm
  nodule): their CTs are stored flipped (orientation -1,0,0,0,-1,0) and their SEGs declare an unflipped orientation
  with the CT's positions, so `scripts/lidc.py` computed centroids outside the body and called every one "left". The
  outlines themselves are the CT's pixel grid (checked by eye on LIDC-IDRI-0697: the as-is outline follows a lobulated
  mass in the right lung). Fix the centroid in `lidc.py` the way `25_patient360_viewers.py` now places those frames,
  then rerun the stages that carry the lobe (PACS NoduleFinding, the radiology reports and their facts, OMOP, i2b2).
- ☐ D7. Two eGFR series in one. Synthea writes "Glomerular filtration rate/1.73 sq M.predicted" (metabolic panel,
  blind to kidney disease) and "Estimated Glomerular Filtration Rate" (CKD monitoring) with the same LOINC code,
  33914-3; `scripts/02` made both the Clarity component EGFR in the renal function panel, so patients with CKD show
  values such as 75.9 and 22.2 on the same day. Give the first its own component (or leave it out for patients with
  CKD), then rerun 02 and the stages after it. Until then Ask charts creatinine for kidney trends (`chat/rules.py`).

### E. Data work that runs during testing

- ☑ E1. **Full viewer build for every online study** (1,018 CT, 298 MRI, 290 X-rays, 792 slides): `25_patient360_viewers.py
  --all --jobs 8` built 2,153 series without a failure in about 4 hours (2,398 with the demo patients', 166 GB, most
  of it slides), and `25 --upload-only` copied them to `Patient360/Files/viewer` (2 million files, about 45 minutes).
- ⏸ E2. D2 to D5 in the same window, smallest first (D1 is done).

### F. Docs

- ☐ F1. README (Patient 360 and Ask: run locally, deploy, screenshots), `docs/setup.md` (each new script with its
  check, the person steps, the tenant setting *Use short-lived user-delegated SAS tokens*), AGENTS.md, this log.

### G. Demo imaging (user, 2026-11-09)

The request: the old app's patient list and its fifteen patients in view; Jettie Osinski's slide and CT for the wow
demo; six studies from the imaging demo ([MS101-public-patient-imaging-2D-3D-4D-fabric-rayfin-GHC](https://github.com/SanjayNarendran/MS101-public-patient-imaging-2D-3D-4D-fabric-rayfin-GHC), now [research/imaging](../research/imaging))
on two or three demo patients, with that app's viewer controls. Decided with the user:

| Patient | Gets | Why it fits the record |
| --- | --- | --- |
| Jettie Osinski (TCGA-J2-8192) | nothing new; first of the research patients | already has the four slides and the CT with the AI lung and nodule segmentation |
| Stephan Rutherford (Z1002519, demo 1) | 4D breathing-lungs CT with RT structures (TCIA 4D-Lung, CC BY 3.0); whole-body FDG PET/CT with lesion masks (TCIA FDG-PET-CT-Lesions, CC BY 4.0); DTI brain-wiring atlas (HCP1065, CC BY-SA 4.0) | lung cancer March 2018 with radiotherapy to October 2019 (planning CT, PET/CT); stroke in 2003 with that year's brain MRI (the wiring atlas beside it) |
| Ivelisse Nitzsche (Z1003499, new demo patient) | TCGA-AC-A4ZE breast slide with AI nuclei and immune-cell layers, its frozen section and report (TCGA, Pan-Cancer-Nuclei-Seg and TIL maps, CC BY 4.0); fetal brain MRI atlas, 21 to 36 weeks (dHCP, CC0); 36-plex CyCIF of a colon cancer (HTAN, CC BY 4.0) | breast cancer 2009, pregnancy 2016, colon cancer 2018, chest CT 2023 |

The fetal brain and brain-wiring studies are atlases (averages of many people) and are labelled so. The other four
are one person's images attached to a synthetic patient, like every image here. They are not added to the PACS or
Epic: they live in `Patient360/Files/viewer/<patient>/showcase/` with an index table, and the record says where they
come from. The viewers gain the imaging demo's controls for every slide and scan, not only these six.

- ☑ G1 (local; in Fabric with G7). Patient list: every demo patient at once (no paging), with the old app's columns (cancer with sex, age and
  race; stage; outcome, red if the patient died; key alterations; mutations per Mb with its bar; slide gigapixels;
  scans) beside the current ones, for hospital patients too (their stage, outcome and genomes). The summary line
  (patients, cancer types, deaths, gigapixels, CT and MRI series). Columns computed by `24` into `p360_patient`.
- ☑ G2 (local; in Fabric with G7). `scripts/30_patient360_showcase.py`: copy the six studies' viewer files from the imaging demo (`--from-local`
  its `work/`), check the PET/CT subject's diagnosis (lung cancer, else
  pick an NSCLC subject from the same collection), write `p360_showcase` (patient, date, kind, title, description,
  source, licence, citation, the study's layers and timeline as JSON), add Ivelisse Nitzsche to the demo patients.
- ☑ G3 (local). Record: the showcase studies on the timeline and in the Radiology and Pathology tabs (`showcase` query in
  `record.ts`, both dialects), labelled with their source and licence.
- ☑ G4 (local). 3D viewer, for every scan: layers panel (visibility, opacity, colour map, label legend), PET overlay with
  colour maps and an SUV bar, sagittal and MIP views, clip plane (front, side, top, depth), timeline with play for
  4D studies (one 4D NIfTI or a file per frame), tractography bundles, reset, save image, full screen, About and
  Controls tabs. The record's CTs and MRIs (`RadiologyPanel`) now open in the same workspace as the showcase
  studies, keeping the nodule legend with Go to and the AI segmentation measures.
- ☑ G5 (local). Slide viewer, for every slide: AI layers (nuclei pyramid, immune-cell map) with switch, opacity and legend;
  filmstrip of the patient's slides; Compare (two slides linked at the same magnification); the report beside the
  slide; scale bar and live magnification; copy link; full screen; About, Case and Controls tabs; multiplex
  fluorescence with channel chips and every channel's switch, colour and window. The record's slides
  (`PathologyPanel`) use it too: the TCGA patients' four slides with the lymphocyte map and the scanned report, the
  hospital patients' slides with their scanned pathology report when there is one.
- ☑ G6 (local). Ask: the showcase studies in `imaging_studies`, `show_scan` and `show_slide` (layers, time point,
  channels, the report beside the slide), rules, seven starter questions for the wow demo, evaluation cases; the
  full evaluation passed 57 of 58 (chat/TESTING.md).
- ☑ G7. Fabric: upload the files (about 4 GB), write the tables, deploy the app (27) and the relay (28); pause the
  capacity and stop the relay. Checked by T-SQL on the endpoint (the showcase queries and the demo list's new
  columns) and the relay's /healthz; the hosted app itself still wants a look with a signed-in browser.
- ☑ G8. Docs: README, setup.md (script 30, question 13), Sources page (the six studies' citations), AGENTS.md (both),
  chat/QUESTIONS.md and TESTING.md, this log.

### H. The brain-wiring atlas in full (user, 2026-11-12)

Asked which pathways in the atlas run from the cortex to the spinal cord, Ask named none: the imaging demo merged
the atlas's 87 bundles into five group files and kept only the group names. The user asked for all the data of the
original study, downloaded, and viewer controls that show it. The publisher (brain.labsolver.org/hcp_trk_atlas.html,
Yeh 2022, CC BY-SA 4.0) offers about 1.7 GB:

| File | What it holds | Used for |
| --- | --- | --- |
| `hcp1065_avg_tracts_trk.zip` (588 MB) | the 87 bundles' fibre lines | each bundle's name, side, length and reach; which lines of the viewer's group files belong to it |
| `hcp1065_avg_tracts_tt.zip` (152 MB) | the same in DSI Studio's format | kept for lineage |
| `hcp1065_avg_tracts_nifti.zip` (3 MB) | each bundle as a volume | the bundle on the slices |
| `hcp1065_prob_coverage_nifti.zip` (17 MB) | how often each of 64 tracts passes through each voxel, over 1,065 people | the probability map |
| `1065_subject_tract_in_nifti.zip` (756 MB) | each person's tracts, 56 tracts by 1,065 people | each tract's volume across people, and how many people have it |
| `tract_to_region_connectome_BM_KL.xlsx`, `_MMP.xlsx` | the share of people whose tract reaches each cortical area (Brodmann, Kleist, HCP-MMP) | the areas each bundle connects |
| `abbreviation.xlsx`, `abbreviation2.xlsx` | the names, and other names in use | bundle names |
| `hcp1065_prob_coverage_jpg.zip` (158 MB) | the publisher's 20 figures and two slide decks | figures in About |
| the paper's scripts (0.15 MB) | the code behind its figures | kept for lineage |

- ☑ H1. `scripts/31_patient360_tractography.py`: download them all to `data/raw/hcp1065` (skipping what is there);
  build into the study's folder each bundle's facts (group, its lines in the group file, length, reach, cortical
  areas, volume across people), the probability maps, the bundle volumes and the figures; check the split against
  the raw bundles; merge into `p360_showcase`. `--fabric` uploads the downloads to `Patient360/Files/raw/hcp1065` and
  the study folder, then writes the tables. `30` applies it again after copying the study.
- ☑ H2. Viewer: a Bundles tab for a study with bundles: every bundle by group with its switch and *only this*,
  colour by direction or by bundle (with swatches), search; a bundle's facts (names, side, lines, length, reach,
  cortical areas with the share of people, volume across people); its probability map or volume on the slices; the
  figures in About.
- ☑ H3. Ask: `show_scan` takes bundles, colour and a probability map; its result names each bundle shown with what it
  connects; `imaging_studies` lists the bundles; rules, starters and evaluation cases.
- ☑ H4. Test locally on the GPU in both themes, and the tractography evaluation cases.
- ☑ H5. Fabric: `31 --fabric` (the downloads to `Files/raw/hcp1065`, the study's files, the tables), the app (27) and
  the relay (28, image `patient360-chat:20261112-113102`). Checked: the endpoint returns the atlas's metadata (15
  parts), the relay's /healthz, and the deployed build carries the Bundles tab and the new questions.
- ☑ H6. Docs: setup.md (script 31), README, AGENTS.md, the Sources page, chat/QUESTIONS.md and TESTING.md, this log.

### I. The imaging studies at full size (user, 2026-11-12)

The user asked for the full-size data of the other imaging studies, locally and in Fabric, shown in the viewers and
Ask. The slides (breast case, CyCIF) and the tractography atlas are already full size. The rest, with 103 GiB free on
the Mac at the start (about 30 GB added):

| Study | Viewer now | Full size | Download |
| --- | --- | --- | --- |
| 4D CT (4D-Lung 100_HM10395) | 2 mm | 0.98 × 0.98 × 3 mm planning 4D CT, and the patient's 26 treatment-day 4D scans | 9.3 GB (IDC) |
| PET/CT (FDG-PET-CT-Lesions PETCT_5e2da717db) | CT 2 mm, PET native | CT 0.86 × 0.86 × 3 mm | 0.3 GB (IDC) |
| Fetal brain atlas (dHCP) | T2 and tissue labels | T1, diffusion (FA, MD, RD, DWI, ODF), tissue-volume centiles, registration warps | 20 GB (G-Node GIN) |

The record's own 1,316 CT and MRI series stay at about 1.25 mm in the viewer; their originals (about 290 GB of DICOM)
are already full size in `Bronze_ImagingArchive` and would not fit on the Mac.

- ☑ I1. `scripts/32_patient360_fullsize.py`: download the three subjects in full to `data/raw/` (IDC with idc-index,
  GIN over HTTPS), skipping what is there.
- ☑ I2. Viewer files: the PET/CT's CT and the planning 4D CT at native resolution; the treatment-day scans as a study
  of their own, one frame per day; the fetal atlas's T1 and diffusion maps as layers on each week; the centiles.
- ☑ I3. Ask: the new study and layers in `imaging_studies` and `show_scan`, the centiles in the fetal atlas's facts;
  starters and evaluation cases.
- ☑ I4. Test locally (GPU, both themes, load times at full size).
- ☐ I5. Fabric: the downloads to `Patient360/Files/raw`, the viewer files and tables, deploy; docs.

## Build log

### 2026-11-13

**Which scans and slides open.** Many of a hospital patient's studies are archived (the PACS index and report only),
and during a demo there was no telling them apart from the timeline. A scan or slide whose images open in the viewer
is now an orange square, and an archived one a hollow grey square; the ticks of the tab's study strip follow the same
colours, and the Key says so. "Opens" means its viewer files were built (a volume, X-ray images or slide tiles), not
just that the PACS lists it as online.

### 2026-11-12, evening (three studies at full size, plan I)

**Downloads (I1).** `32 download` fetched every series of the 4D-Lung patient (350 series, 9.3 GB) and the PET/CT
study (0.3 GB) from NCI Imaging Data Commons in about four minutes, and the dHCP fetal atlas (649 files, 20.6 GB) from
G-Node GIN in about 25. GIN serves annexed files under `/media/` and small ones under `/raw/`; idc-index folder
templates take only patient, collection, modality, study and series. The Mac went from 103 to 71 GiB free.

**Viewer files (I2).** The PET/CT's CT at 0.86 × 0.86 × 2.5 mm (95 MB) and the planning 4D CT at 0.98 × 0.98 × 3 mm
(131 MB, about 550 MB in the browser) are too heavy to open by default, so they sit beside the 2 mm files as
`fullSize`, behind a *Full size* button; the 4D CT's measures now come from the native grid (tumour motion 2.4 mm, was
2.1). The 33 cone-beam CTs, taken over 46 days of treatment (four days have two), are each the average of their ten
phases, rigidly aligned to the first by mutual information and placed on his record from 18 March 2018; one frame
per scan, the frame's value its treatment day. The fetal atlas gained T1, FA, MD, RD and b = 1000 layers on each
week, resampled with the week's own scaling, and each week's white-matter FA and MD (FA 0.15 at 21 weeks, 0.09 at 30
to 32, 0.10 at 36). A timeline of separate files now loads only the layers switched on, so the atlas plays as before.
A first build overwrote the 2 mm files and wrote its layers with the imaging demo's paths (404s); the files came
back from the imaging demo, and the table now starts from the folder's own metadata on every build.

**Ask (I3, I4).** `show_scan full_size`, timelines with each frame's note (date, brain volume, FA), the cone-beam CTs
in the rules, two starters. The Radiology and Research starters and the fetal atlas: 21 of 22 without flags (the 4D
CT's expectation moved to 2.4 mm).

### 2026-11-12 (the brain-wiring atlas in full, plan H)

**The data (H1).** `31` downloads the publisher's eleven files (1.7 GB) and rebuilds the study's extras in about a
minute. Which lines of the five group files belong to which bundle comes from replaying the imaging demo's sampling
(same order, same seed); every bundle's first and last line is checked against the publisher's bundle. The
connectome gives each cortical tract the share of people in whom it reaches each Brodmann and HCP-MMP area; each
person's maps give 52 tracts' volumes across the 1,065 people (and the corpus callosum's four parts). Probability
maps (64) and bundle volumes (87) are resampled onto the template's grid. The metadata grew to 80 KB (14 parts).

**Mirrored lines.** With the probability maps on, the left corticospinal tract's lines sat on the right. The imaging
demo wrote its group files with voxel order LAS and a RAS affine; nibabel honours the voxel order, NiiVue does not, so
every line was drawn mirrored. Symmetric enough to go unnoticed until a bundle had a side and a map. `31` rewrites the
group files in RAS order; the imaging demo's own app still draws them mirrored.

**The viewer (H2).** A Bundles tab: each bundle by group with its switch and *Only*, a partly drawn group shown as
such, colour by direction or by bundle, search, and the picked bundle's facts at the top (names, lines, length,
reach, cortical areas with bars, volume across people, the publisher's figure). Its probability map (or volume)
loads over the template, the crosshair moves to the bundle, and a colour bar reads 5 to 100%. A legend on the image
names the bundles drawn when there are 16 or fewer. NiiVue hides lines with a per-line threshold (direction colours)
or a group colour map with alpha 0 (bundle colours), so the group files stay as they are.

**Ask (H3).** `show_scan` takes `bundles` (id, abbreviation, name with or without its side, another name, a group),
`colour` and `map` (opens in MPR); its result lists each bundle drawn with its reach, every cortical area reached by
a fifth of people or more, and its volume across people, and says where the atlas ends. A first cut listed six areas
per bundle, and the arcuate answer said the right tract didn't reach BA22 (it does, in 54%). The projection question
now answers with the corticospinal tract; a new Research starter compares the two arcuate fasciculi, and three
Radiology starters (the internal capsule after his stroke, the optic radiations, the corpus callosum) are for demos. The Radiology
and Research starters and the fetal atlas: 17 of 17 without flags. A review then found names that drew part of what
was asked (SLF without SLF I, cerebellum as the one bundle of that name instead of its group, cranial nerves not
found) and "corpus callosum" opening only its body's map; groups and families now resolve first and parts only by
their exact names (`src/__tests__/tractBundles.test.ts`).

### 2026-11-10 (demo imaging, plan G)

**Patient list (G1).** All 28 demo patients at once with the old app's columns, computed by `24` for the hospital
patients too: cancer with sex and age, stage (from the staging flowsheet, else the problem name), outcome, the top
three driver changes, mutations per Mb, MSI, slide gigapixels and scan series. The fifteen research rows match the
old app's.

**Six imaging-demo studies (G2, G3).** `scripts/30_patient360_showcase.py` copies them from the imaging demo's pipeline (about
4 GB) to `viewer/<patient>/showcase/` and lists them in `p360_showcase`. The study metadata runs past the SQL
endpoint's 8,000-character strings, so `p360_showcase_part` holds it in parts. On the record they are timeline marks
(`sc:<study>`) in the Radiology and Pathology tabs, each with a line on why it sits on that patient and its source and
licence. The PET/CT subject was checked first: PETCT_5e2da717db has lung cancer, like Stephan Rutherford. TCIA now
lists the non-defaced FDG-PET-CT-Lesions under controlled access; IDC labels the series used here CC BY 4.0.

**Every scan and slide in the imaging demo's viewers (G4, G5).** Its components live in `src/components/imaging/`
almost unchanged (a `Locator` for file URLs instead of its proxy). The record's CTs and MRIs open in its volume
workspace with the nodule legend and *Go to* kept, a plain-words note per series, the lung window for chest CTs and
the details panel; the slides in its slide workspace with the filmstrip, Compare, the report beside the slide
(research PDFs and scanned hospital reports) and the TIL map as an AI layer. A research patient's pathology tab opens
on the diagnostic slide, not the last frozen section. In Ask the panels start folded.

**Ask (G6).** `show_scan` and `show_slide` open the six studies by id with a view, time point, layers, marker
channels, or the case's report beside the slide; `imaging_studies` lists what each offers. Two things the first run
caught: the PET MIP can't draw the lesion masks (the answer said it did), and the breast case's TCGA slide was put
beside Ivelisse Nitzsche's own synthetic biopsy report as if both were one specimen. Both are fixed in the tool text
and rules. Seven new starters; the full evaluation passed 57 of 58 (`--gpu` added for the WebGL-heavy cards).
A review then found that a slide asked for with its report inside a side-by-side column showed no report while the
answer said it did; columns now leave the report to its own column.

**Fabric (G7).** `30 --fabric` copied 39,184 files (3.95 GB) and wrote both showcase tables; `24 --index-only
--fabric` the index with the list columns; `27` and `28 deploy` (image `patient360-chat:20261109-104222`). The
showcase files sit under each patient's `viewer/<patient>` folder, so the record's existing read-only link covers them.
Capacity paused and relay stopped afterwards.

### 2026-11-09, night (every viewer, genomes for the hospital patients, Cohorts)

**Cohorts (C7).** The record's Cohorts tab, the patient list's *Data request* filter and `?request=<id>` links, Ask's
`data_requests` tool, and *Open the cohort's patients in Patient 360* on the approval app's request page.

**Every viewer (E1).** All 2,398 online series have viewer files, locally and in OneLake, so any patient's CT, MRI,
X-ray or slide opens, not only the demo patients'. The capacity was paused at 00:46 Central by an identity outside this
tenant's directory (a scheduled job, not this work) while the last 3% of tiles were uploading; they failed with 404 on
commit. After resuming it, `azcopy jobs resume` copied only those, and every folder checked matches its local count.

**Genomes for the hospital patients (D1).** The slides attached to 709 hospital patients come from 792 TCGA cases, and
TCGA sequenced those tumours, so the slide's tumour now has its genome: 756 genomes for 681 patients, the same views
as the research patients' (TMB against the same cancer, copy number, every mutation, drivers, expression, immune mix),
without the AI lymphocyte map. Stephan Rutherford's two cancers show two genomes (lung squamous: TP53, CDKN2A, NFE2L2,
SOX2 amplified; prostate: 25 mutations, no driver), and Ask puts them side by side. The counts across tumours match
what TCGA reports for these cancers: KRAS in 51 of 122 colorectal and 17 of 54 lung adenocarcinomas, MSI-high in 18 of
122 colorectal, ERBB2 amplified in 18 of 136 breast tumours. The first build also counted 19 tumours that cBioPortal
never sequenced, as genomes with no mutations (found in review); only its sequenced sample lists count now. A cohort question across genomes first took 153 steps of
patient_overview; with `query_records` subjects for genomes it takes 8. The genome plot had a 600 px minimum, so in a
side-by-side card the right-hand genome lost chromosomes 19 to X; it now fits half width.

### 2026-11-09 (Fabric, history, side by side)

**Fabric (C1 to C6).** Patient 360 and Ask run as the Fabric App `patient-360` and the relay `patient360-chat`.
Fabric showed what local mode couldn't: lakehouse SQL endpoints hide `timestamp_ntz` columns, which the
original deployment's Epic tables carried, so ten Epic and document time columns come from companion tables
(`p360_time_<table>`); T-SQL `TIMESTAMP` is rowversion; `rayfin up` needs `host.json`; Rayfin's data client returns
only the fields a query selects.

**History in Fabric.** `AskFolder`, `AskChat` and `AskTurn` in the app's Rayfin database, each row readable and
writable only by its owner; `src/chat/historyFabric.ts` implements the same operations as `chat/history.py`.
Checked in Fabric: an answer saved and reopened with its card, a folder created, a chat moved in, the folder deleted
and the chat moved up, all kept after a reload.

**Side by side (user feedback).** "For comparison questions the chat should show text, images and viewers side by
side." `show_side_by_side` puts two to four of the other views in columns (CT beside CT, genome beside genome, a
slide beside its report), with a note under each and a table of the differences; columns stack in the side panel.
The rules make it the way to answer any comparison, and seven cases now fail if a comparison isn't side by side.
Half-width views needed container queries in place of window breakpoints (the genome's metrics and lower panels,
a document's details and its scan) and a compact CT viewer (one axial slice on the nodule, the legend folded).
Looking at two CTs next to each other showed the crosshair on the mirror image of the nodule, in x and y: Niivue's
voxel fractions are in its RAS-reordered space and the label map is stored LPS. `goToLabel` now goes through
millimetres, so *Go to* and every centred CT land on the nodule. The legend's *Go to* links couldn't be clicked at
all (the legend ignores the pointer so the viewer keeps it); its buttons take it again, and the legend can be hidden.

### 2026-11-08 (Ask)

**B1 to B6.** Ask is the CMS dashboard's Ask your data rebuilt for records: every tool runs in the page (the server
sends a page request; the page reads the record through the same API and draws the record's own viewers), so the
model never sees SQL and the same tools work locally and in Fabric. One answer is a stream of events drawn by
`src/chat/turn.ts`: steps (reasoning, each tool call with arguments, result and time), an opening above the cards,
each card's narrative under it (`[[fig N]]`), and a summary. Saved answers are the same events, drawn again.

The first evaluation (45 cases) found: booleans in `query_records` filters reached DuckDB as the strings 'true' and
'false' (now 1 and 0); questions sent before the model list loaded ran without the chosen thinking level (the box
now waits for it); "aligned at diagnosis" used each patient's first cancer, so a patient with two cancers was
aligned on the wrong one (`show_timeline` now takes `match`, e.g. lung); tumour board notes were capped at 1,000
characters (now 4,000, in the Rayfin entity too); nodules went by position while the viewer's legend uses their
PACS labels (both now say "Nodule 6"). It also found two viewer bugs that affected the record itself: chest CTs in
slice views fell back to the soft-tissue window, because the default was the 3D preset's id (now Lung for slices,
Air for 3D), and centring on a nodule never ran, because Niivue 0.69 leaves `NVImage.dims` unset after loading
(now read from the header), so *Go to* in the legend works again.

### 2026-11-08

**Plan.** Read the reference app, the CMS dashboard's Ask your data and this repo's data; measured what each patient
has online; asked the questions above. Found: no tumour genomics or registry here yet, but every TCGA slide carries
its real barcode (so cBioPortal can fill the genomics), and the Coherent bucket also holds immunisations, allergies,
care plans, devices and a germline DNA panel (about 160 variants per patient, cardiovascular genes such as PCSK9)
for the same patients. The reference app's data to import is 1.3 MB of tables, 27 GB of viewer assets and 8 MB of
report PDFs.

**A1 to A7** (same day). `scripts/24_patient360_data.py` copies the Bronze tables locally (Clarity from the generated
CSVs with the types in `epic_schema.py`, the PACS tables from `pacs_index`, the documents index with the Delta types) and
builds `p360_patient`: 3,539 Epic patients plus the 15 research patients, 27 of them demo patients
(`apps/patient360/demo_patients.json`). The app (`apps/patient360`) is the reference app's code with a shared data
layer, `rayfin/functions/src/record.ts`: one set of SQL for T-SQL and DuckDB (local mode attaches DuckDB catalogs named
as the Fabric items, so `Bronze_Clarity.dbo.PATIENT` is the same text in both), and the assembly of a patient's bundle
in the reference app's shape. Epic results map to the reference vocabulary by LOINC code, orders for the same drug
less than 45 days apart become one course, and the cancer course comes from the problem list, the oncology flowsheets
and the orders. New: search and filters ten at a time, the Documents tab (scan beside its text, ground-truth facts
marked), the study and nodule panels, Epic names in natural case. A patient page is 14 queries, about 50 ms locally.

`scripts/25_patient360_viewers.py` builds viewer files from the original public DICOM (NIfTI volumes, the LIDC
radiologists' outlines as a consensus label map, X-ray PNGs, Deep Zoom slides): 39 series for the demo patients,
about 1.3 GB, 5 s per CT or MRI and 10 to 40 s per slide. Found and fixed: a scout image in a CT series skewed its
geometry (now only the largest stack of one orientation is read); four TCGA slides are JPEG 2000, which OpenSlide
can't read, so they are transcoded frame by frame to baseline JPEG DICOM first; the reference viewer applied the
previous series' view after a load (it now applies the current one). Chest CTs open in the lung window, centred on
the largest nodule, with *Go to* for each.

`scripts/26_patient360_import.py --from-local` imported the reference app's 15 patients in 41 s as APFS clones
(229,561 slide tiles, 27 GB, about 4 GB of new disk). Their tabs run the reference app's own queries against the
`Bronze_Oncology_*` catalogs. Tumour board notes: the reference app's 15 plus 12 written for our demo patients from
their records (`apps/patient360/notes.json`, labelled illustrative).
