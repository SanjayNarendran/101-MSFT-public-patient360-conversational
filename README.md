# Patient 360 and conversational insights on Microsoft Fabric

A Microsoft Fabric demo that brings several healthcare data sources and formats together into one semantic model, makes them queryable in natural language, and opens any patient's whole record on one page, with a conversation about one patient or many. The project is built in stages:

| Stage | What it shows | Status |
|---|---|---|
| 1. Multi-source EHR data | Epic Clarity- and Caboodle-style tables written into **OneLake** as Delta tables, one **Bronze** lakehouse per Epic database | Done |
| 2. Imaging and unstructured data | A **PACS index in a Fabric SQL database**, DICOM images in **OneLake**, and radiology reports, pathology reports, progress notes and scanned documents, all linked to the EHR | Done |
| 3. Cohort-ready layers | A **Silver** layer in the **OMOP CDM v5.4** (with the medical imaging extension and the standard vocabularies) and a **Gold** layer in the **i2b2** star schema with a browsable ontology, both built from Bronze | Done |
| 4. Semantic models and cohort discovery | Two **semantic models** (i2b2 for counts, OMOP + PACS + documents for patient-level data). **GitHub Copilot** turns a question into an **i2b2 query** and returns obfuscated counts. A local **Cohort Discovery app** puts that next to a live query builder; data requests are approved in a **Fabric App** (Project Rayfin) and delivered to their own lakehouse | Done |
| 5. NLP | Extract entities from the reports, notes and scans into OMOP `NOTE_NLP` and compare them with the ground-truth facts | Planned |
| 6. Patient 360 and Ask | One patient's whole record on a lifetime timeline, read where each part lives (Epic, the PACS, the imaging archive, the documents, tumour genomics), with CT, MRI, X-ray, slide, document and genome viewers; **Ask**, a conversation with GitHub Copilot about one patient or many that answers with the same viewers. Locally and as a **Fabric App** | Done |

**This repository holds code only.** No data is committed: every dataset is downloaded from its publisher when you run the setup, onto your computer and into your own OneLake. The only images in the repository are the presentation's small figures, credited in [presentation/assets/img/NOTICE.md](presentation/assets/img/NOTICE.md). The hospital's 3,539 patients are synthetic. The images come from public research archives, with synthetic identities attached (see [The imaging data](#the-imaging-data)). Patient 360's 15 oncology research patients are public, de-identified TCGA cases with synthetic names ([research/README.md](research/README.md)).

## Set it up with an AI agent

The setup is written for an AI coding agent working with you. In VS Code, open the repository and pick the **Demo Setup** agent in Copilot Chat; with another agent (the GitHub Copilot CLI, Claude Code, Codex), ask it to read [AGENTS.md](AGENTS.md) and follow [docs/setup.md](docs/setup.md). The agent asks its questions first (tenant, capacity, workspace name, how much of the imaging and research data to build, which optional parts), checks every prerequisite below with you, then runs the numbered scripts in order and checks each one. Steps that need you, such as signing in, accepting the licence and creating the GitHub OAuth Apps, are marked **[person]**; the agent tells you what to do and waits.

## Prerequisites

| Needed | For | Usually provided by |
|---|---|---|
| A **Microsoft Fabric capacity** (an F SKU, F4 or larger) and permission to create workspaces | everything | Fabric or Azure administrator |
| **Fabric tenant settings:** *Users can access data stored in OneLake with apps external to Fabric*; *Semantic models can be queried with the Execute Queries REST API*; *Use short-lived user-delegated SAS tokens* (OneLake); optionally the Power BI / Fabric IQ MCP server setting. Fabric SQL databases, user data functions and Fabric Apps (Project Rayfin) must be available in the tenant | stages 1 to 4; Patient 360 in Fabric; the DAX agent | Fabric administrator |
| **Contributor on the capacity** in Azure | pausing and resuming the capacity | Azure administrator |
| The **healthcare data solutions licence**, read and accepted by you | stage 3 (the OMOP vocabularies) | you |
| A **GitHub Copilot** seat, signed in on your computer (`gh auth login` or `copilot login`) | the VS Code agents, the local Discovery app, Ask on your computer | you or your GitHub organisation |
| An **Azure subscription** and resource group where you are Contributor, with the `Microsoft.App` and `Microsoft.ContainerRegistry` providers, and Azure Policy that allows a container registry with its admin user and a Container App with public ingress | the Discovery tab and Ask in Fabric, whose GitHub Copilot relays run in **Azure Container Apps** | Azure administrator |
| A **GitHub account** to own two OAuth Apps. Where an organisation grants the Copilot seats: the **Copilot CLI** policy on, Claude Opus 5.5 allowed, and the OAuth Apps approved if third-party access is restricted | the Discovery tab and Ask in Fabric | GitHub organisation owner |
| **macOS or Linux** with Python 3.12, the Azure CLI, git, Node.js 20, 22 or 24 (the Rayfin CLI rejects Node 26), OpenSSL 3, Java 17 or newer, AzCopy, the GitHub CLI, and VS Code with GitHub Copilot in agent mode | the scripts, pipelines and apps | you |
| **Disk:** about 25 GB for stages 1 to 4 (images are deleted after upload), and about 180 GB free for everything with Patient 360's research data; [docs/setup.md](docs/setup.md#this-computer) breaks it down | downloads and builds | you |
| **Network:** PyPI, npm, GitHub, the NCI Imaging Data Commons buckets on AWS and Google Cloud, the NCI GDC and cBioPortal APIs, gin.g-node.org, TemplateFlow, Mendeley Data and download.microsoft.com. No download needs a sign-in | downloads | your network administrator |
| **Time:** stage 2 with all images takes 5 to 6 hours (about 290 GB up to OneLake at about 15 MB/s); the research pipelines take several hours more, mostly downloads and slide tiling | | |

## Architecture

```
Synthea Coherent Data Set (CC BY 4.0)          NCI Imaging Data Commons (CC BY 3.0)
        |  01-02 reshape into Epic-style tables       |  LIDC-IDRI chest CT/X-ray + nodule annotations
        |  + lung screening and pathology cohorts     |  TCGA whole-slide pathology (LUAD, LUSC, BRCA, COAD, PRAD)
        v                                             |  + Synthea Coherent brain MRI
data/generated/clarity, caboodle (CSV)                |  08-09 headers rewritten to the Epic identities, locally
  05 written to OneLake as Delta tables               v
        |                                   Fabric SQL database Bronze_PACS (10)   Reports, notes, scans (11)
        v                                             |                                  |
Fabric workspace MedicalCohortDemo -------------------+----------------------------------+
  Bronze_Clarity, Bronze_Caboodle      lakehouses with the 54 Epic tables as Delta (03, 05)
  Bronze_PACS (SQL database)           Patient, Study, Series, Instance, NoduleFinding
  Bronze_ImagingArchive lakehouse      Files/dicom/<study>/<series>/<instance>.dcm
  Bronze_ClinicalDocuments lakehouse   Files/... text and PDF documents; Tables/document_index, document_facts
        |
        |  14 Bronze -> OMOP (DuckDB, locally or in the Silver_OMOP_Build notebook)
        v                                   OMOP vocabularies from Microsoft healthcare data solutions (13)
  Silver_OMOP lakehouse                OMOP CDM v5.4 + IMAGE_OCCURRENCE/IMAGE_FEATURE + vocabularies
        |
        |  15 OMOP -> i2b2 (DuckDB, locally or in the Gold_i2b2_Build notebook)
        v
  Gold_i2b2 lakehouse                  observation_fact + dimensions, i2b2_ontology with patient counts
        |
        |  18-20 semantic models, i2b2 query store, request workflow
        v
  Cohort Discovery (i2b2)              semantic model, Direct Lake on Gold_i2b2: counts only
  Research Data (OMOP)                 semantic model, Direct Lake on Silver_OMOP + Bronze_PACS + Bronze_ClinicalDocuments
  Cohort_Requests (SQL database)       i2b2 query history (QT_* tables) and data requests with their audit trail
  cohort-approval (Fabric App)         approval app (Rayfin): inbox, one page per request, Approve/Reject, delivery
  Cohort Requests                      semantic model (DirectQuery) + Power BI dashboards (the earlier approval page)
  Cohort_Request_Actions               user data functions used by the delivery notebook (and the Power BI buttons)
  Cohort_Delivery_Pipeline             runs the Cohort_Delivery notebook: approved request -> Delivery_QM<id>_<title>
                                       lakehouse, in the approval app's folder
  Explore_QM<id>_<title> notebooks     one per delivery, next to its lakehouse: the researcher's first look at the data
        ^
        |  cohort tools (scripts/cohort_mcp.py), on your machine
  Cohort Discovery app (apps/discovery) local web app: GitHub Copilot (Copilot SDK) + query builder, counts, history
  GitHub Copilot in VS Code            "Cohort Discovery" agent; "Cohort Explorer (DAX)" agent via the Fabric IQ MCP server

research/patient360, research/imaging  public TCGA, IDC, HCP1065 and dHCP data, downloaded and built locally (run_all.py)
        |  24-32
        v
  Bronze_Oncology_Clinical/_Genomics/_Imaging   15 TCGA research patients (registry, genomes, slides, scans)
  Patient360 lakehouse                 patient index, demo patients, viewer files, showcase studies
  patient-360 (Fabric App)             Patient 360 and Ask: reads every Bronze item in place through Patient360's
                                       SQL analytics endpoint; Ask's GitHub Copilot relay runs in Azure Container Apps
```

Every item that holds data as it arrives from a source has a **Bronze_** prefix. The standardized layers are **Silver_OMOP** and **Gold_i2b2**. All names are set in the settings file (`config/settings.<name>.env`).

All four sources join on the same keys: **MRN** (`PATIENT.PAT_MRN_ID` = DICOM PatientID) and **accession number** (`ORDER_RAD_ACC_NUM.ACC_NUM` = DICOM AccessionNumber = document `AccessionNumber`). One SQL query on a lakehouse SQL analytics endpoint can join the Clarity tables, the PACS SQL database and the document index (`scripts/12_verify_stage2.py` runs one).

In a hospital, the Epic tables would reach OneLake from where they already live: mirrored from SQL Server, or read through shortcuts from Snowflake, Azure Databricks or another Fabric workspace (the presentation's section 01 plays each one). This demo writes them straight into the Bronze lakehouses, so it needs nothing outside Fabric. The PACS database (`Bronze_PACS`) is a Fabric SQL database, which Fabric replicates to OneLake.

## Set up the demo

These are the commands; [docs/setup.md](docs/setup.md) is the full runbook, with the checks after each step and the optional parts.

### 1. Python environment

```bash
git clone https://github.com/SanjayNarendran/101-MSFT-public-patient360-conversational.git
cd 101-MSFT-public-patient360-conversational
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

### 2. Settings

```bash
NAME=contoso
cp config/settings.example.env config/settings.$NAME.env
echo $NAME > config/.cohort-env
```

Fill in your Entra tenant ID and the Fabric capacity ID. The item names (all with a `Bronze_` prefix) can stay as they are. You can list capacities with `az rest --resource https://api.fabric.microsoft.com --url https://api.fabric.microsoft.com/v1/capacities`. The scripts save the Fabric item IDs they create in `data/state.<name>.json`. Git ignores the settings, the state and `config/.cohort-env`, because they describe your tenant.

### 3. Stage 1: EHR data in OneLake

```bash
.venv/bin/python scripts/01_download_sources.py           # Synthea CSVs, IDC metadata, LIDC annotations (~4 GB)
.venv/bin/python scripts/02_generate_epic_data.py         # Clarity + Caboodle tables and imaging cohorts
.venv/bin/python scripts/03_fabric_workspace.py           # workspace + Bronze_Clarity and Bronze_Caboodle lakehouses
.venv/bin/python scripts/05_onelake_load.py               # the 54 tables as Delta tables in those lakehouses
.venv/bin/python scripts/07_verify.py                     # row counts, visible columns, cross-source query
```

`05_onelake_load.py` reads each generated table with DuckDB, typed as `scripts/epic_schema.py` declares, and writes it as a Delta table with times in UTC, which the SQL analytics endpoint shows. `07_verify.py` compares every table's row count on the endpoint with the generated file.

### 4. Stage 2: PACS, images and documents

```bash
.venv/bin/python scripts/08_build_pacs_manifest.py        # plan 12,910 studies: 2,398 ONLINE, the rest OFFLINE
.venv/bin/python scripts/09_process_dicom.py --workers 24 # download, rewrite headers, upload ~290 GB (resumable)
.venv/bin/python scripts/10_pacs_database.py              # Fabric SQL database Bronze_PACS + load the index
.venv/bin/python scripts/11_generate_documents.py         # reports, notes, scans -> Bronze_ClinicalDocuments lakehouse
.venv/bin/python scripts/12_verify_stage2.py              # cross-source joins, coverage and archive spot checks
```

`09_process_dicom.py` records each finished series in `data/generated/pacs/instances/`, so you can stop it and run it again to continue. Use `--collection lidc_idri` (or `tcga_brca`, `synthea_coherent`, ...) and `--limit N` to process a subset; [docs/setup.md](docs/setup.md) has a quick sample of about 10 GB. Run `10_pacs_database.py` after it finishes; studies that weren't archived are indexed as OFFLINE.

Every script can be run again safely. `05_onelake_load.py TABLE ...` reloads only the tables you name.

### 5. Stage 3: Silver (OMOP) and Gold (i2b2)

```bash
.venv/bin/python scripts/13_omop_vocabulary.py            # OMOP vocabularies from the HDS package (~1 GB download)
.venv/bin/python scripts/14_silver_omop.py --upload       # Bronze -> OMOP CDM v5.4 -> Silver_OMOP lakehouse
.venv/bin/python scripts/15_gold_i2b2.py --upload         # OMOP -> i2b2 star schema + ontology -> Gold_i2b2
.venv/bin/python scripts/16_fabric_notebooks.py           # Silver_OMOP_Build / Gold_i2b2_Build notebooks (--run to run them)
.venv/bin/python scripts/17_verify_stage3.py              # row counts, concept coverage, OMOP vs i2b2 cohort, link to Bronze
```

`13` reads only the vocabulary files out of the 6.8 GB zip, using HTTP range requests. `14` and `15` run DuckDB on your machine (about a minute in total) and keep a Parquet copy in `data/generated/`. Without `--upload` they build and report coverage but don't touch Fabric. `14_silver_omop.py --source onelake` reads Bronze from Fabric through OneLake instead of the local files, as the notebook does. Both sources produce identical tables.

The notebooks run the same code in Fabric (Python notebooks, single node, no Spark) for later refreshes. `16` uploads the ETL modules to `Silver_OMOP/Files/etl_code` and creates or updates the notebooks. Every run writes a summary, or the error, to `Files/etl_runs/` of its lakehouse.

### 6. Stage 4: semantic models and cohort discovery

```bash
.venv/bin/python scripts/18_semantic_models.py            # Cohort Discovery (i2b2) + Research Data (OMOP) semantic models
.venv/bin/python scripts/19_cohort_store.py               # Cohort_Requests SQL database: i2b2 CRC tables, request tables, views
.venv/bin/python scripts/20_cohort_app.py                 # user data functions, Cohort Requests model, dashboard template, delivery notebook
.venv/bin/python scripts/21_verify_stage4.py              # DAX vs SQL query checks, MCP tools, requests model (--e2e: full request)
.venv/bin/python scripts/22_approval_app.py               # approval app (Fabric App, Rayfin): configure, npm install, rayfin up
.venv/bin/python apps/discovery/app.py                    # Cohort Discovery app on http://127.0.0.1:8766
```

`22_approval_app.py` deploys `apps/approval` into the workspace and saves its URL; the first run opens a browser to sign in to the Rayfin CLI. Open the app's URL and sign in with your Fabric account. New data requests link to their page in it; set `APPROVAL_UI=powerbi` in the settings file to go back to the Power BI dashboards.

Then open the repository in VS Code. `.vscode/mcp.json` registers two MCP servers: **cohort-discovery** (this repository's `scripts/cohort_mcp.py`, started by VS Code with the `.venv` Python) and **FabricIQ** (Microsoft's hosted MCP server, used by the optional DAX agent). Start them from the MCP view or when Copilot first asks, then pick the **Cohort Discovery** agent in the Copilot Chat agent picker. Both use your `az login` identity. The GitHub Copilot CLI reads `.mcp.json` at the repository root, which registers FabricIQ for it too.

`21_verify_stage4.py --e2e` runs a test request through submit, approval and delivery, checks the delivered patients against the exact count, and removes everything it created.

**Optional, Stage 4e: the Discovery tab in Fabric.** The approval app can also host the Cohort Discovery chat, with GitHub Copilot running in an Azure Container App on each user's own Copilot plan. It needs a one-time Azure and GitHub setup (a Container App, a container registry and a GitHub OAuth App), with the steps in [docs/setup.md](docs/setup.md) (section 8) and the design in [docs/fabric-hosted-discovery.md](docs/fabric-hosted-discovery.md). The names of the Azure resources are the `DISCOVERY_*` settings. Then:

```bash
.venv/bin/python scripts/23_discovery_chat.py deploy          # build the relay image in Azure and roll the Container App
.venv/bin/python scripts/23_discovery_chat.py set-app-secret  # copy the chat ticket key into the approval app's secrets
.venv/bin/python scripts/22_approval_app.py                   # redeploy the approval app with the relay's address
```

### 7. Stage 6: Patient 360 and Ask

```bash
.venv/bin/python scripts/24_patient360_data.py                 # Bronze copy, patient index and demo patients, locally
.venv/bin/python scripts/25_patient360_viewers.py              # viewer files for the demo patients
.venv/bin/python research/patient360/pipeline/run_all.py       # the 15 TCGA research patients, from their publishers
.venv/bin/python scripts/26_patient360_import.py --from-local
.venv/bin/python scripts/29_patient360_genomics.py             # genomes of the hospital slides' TCGA cases
.venv/bin/python research/imaging/pipeline/run_all.py          # six showcase studies for two demo patients
.venv/bin/python scripts/30_patient360_showcase.py --from-local
.venv/bin/python scripts/31_patient360_tractography.py         # the brain-wiring atlas in full
.venv/bin/python scripts/32_patient360_fullsize.py download && .venv/bin/python scripts/32_patient360_fullsize.py build
.venv/bin/python scripts/24_patient360_data.py --index-only
```

Then run it on your computer (`npm run dev:local` in `apps/patient360`, with `apps/patient360/chat/server.py` for Ask) or deploy it to Fabric (`--fabric` and `--upload-local` on the scripts above, then `27_patient360_app.py`, and `28_patient360_chat.py` for Ask's relay). The research pipelines and `31`/`32` are optional; [docs/setup.md](docs/setup.md) (section 9) has the sizes, the checks and the Fabric steps.

### 8. Explore in Fabric

Open the **MedicalCohortDemo** workspace. On the `Bronze_Clarity` lakehouse SQL analytics endpoint you can query across all sources:

```sql
SELECT p.PAT_MRN_ID, o.DESCRIPTION, s.InstanceAvailability, s.NumberOfStudyRelatedInstances, d.OneLakePath
FROM Bronze_Clarity.dbo.ORDER_RAD_ACC_NUM a
JOIN Bronze_Clarity.dbo.ORDER_PROC o              ON o.ORDER_PROC_ID = a.ORDER_PROC_ID
JOIN Bronze_Clarity.dbo.PATIENT p                 ON p.PAT_ID = o.PAT_ID
JOIN Bronze_PACS.pacs.Study s                     ON s.AccessionNumber = a.ACC_NUM
JOIN Bronze_ClinicalDocuments.dbo.document_index d ON d.AccessionNumber = a.ACC_NUM
WHERE o.DESCRIPTION = 'CT CHEST LUNG CANCER SCREENING LOW DOSE';
```

In `Bronze_PACS`, `pacs.vInstanceFile` gives the OneLake URL of every archived DICOM file.

The same endpoint reaches the Silver and Gold layers. A cohort defined with OMOP concepts finds every SNOMED descendant through `concept_ancestor`. Here it finds former smokers with a CT lung nodule of 6 mm or more, plus each nodule's CT series in the PACS:

```sql
SELECT p.person_source_value, m.value_as_number AS nodule_mm, io.image_series_uid, s.NumberOfSeriesRelatedInstances
FROM Silver_OMOP.dbo.measurement m
JOIN Silver_OMOP.dbo.image_feature f     ON f.image_feature_event_id = m.measurement_id
JOIN Silver_OMOP.dbo.image_occurrence io ON io.image_occurrence_id = f.image_occurrence_id
JOIN Silver_OMOP.dbo.person p            ON p.person_id = m.person_id
JOIN Bronze_PACS.pacs.Series s           ON s.SeriesInstanceUID = io.image_series_uid
WHERE m.measurement_concept_id = 4078486 AND m.value_as_number >= 6      -- SNOMED 246120007 Nodule size
  AND EXISTS (SELECT 1 FROM Silver_OMOP.dbo.observation o
              WHERE o.person_id = p.person_id AND o.observation_source_value = '72166-2'
                AND o.value_as_string = 'Former smoker');
```

In `Gold_i2b2`, `i2b2_ontology` is the tree a cohort tool browses (`c_fullname`, `c_name`, `c_totalnum` = patients). A folder selects every code below it through `concept_dimension.concept_path LIKE '<folder>%'`.

## The cohort layers

Cohort discovery tools work on a standard model rather than on source schemas. **OMOP CDM** is the standard of the OHDSI community (ATLAS, the HADES packages) and of Microsoft's healthcare data solutions. **i2b2** is the model of the i2b2/SHRINE/ACT cohort tools and can also run on top of OMOP. This demo builds both: OMOP as the **Silver** layer, and an i2b2 star with its ontology as **Gold**.

**Silver_OMOP** (OMOP CDM v5.4, `scripts/omop_etl.py`):

| Table | Rows | From |
|---|---|---|
| `person`, `death`, `observation_period`, `location`, `care_site`, `provider` | 3,539 / 1,539 / 3,539 / 3,546 / 83 / 2,393 | `PATIENT`, `PATIENT_RACE`, `CLARITY_DEP`, `CLARITY_SER` |
| `visit_occurrence` | 286,647 | `PAT_ENC` + `PAT_ENC_HSP` (office, outpatient, urgent care, ED, inpatient, observation, telehealth) |
| `condition_occurrence` | 112,412 | `PAT_ENC_DX` + `PROBLEM_LIST`: SNOMED CT concept, ICD-10-CM source value, primary/secondary status |
| `procedure_occurrence` | 119,031 | Procedure, imaging and pathology orders (`ORDER_PROC`) |
| `drug_exposure` | 371,774 | `ORDER_MED` (RxNorm), plus vaccines that OMOP routes from procedures |
| `measurement` | 1,384,071 | Lab results (LOINC, units, ranges), vitals (blood pressure split), LIDC nodule measurements |
| `observation` | 61,257 | Smoking status and other coded assessments (LOINC answers), social-history findings |
| `note` | 17,910 | Reports and notes with their text; the 500 scanned PDFs have no text until OCR (stage 5) |
| `specimen` | 792 | Pathology cases: tumor tissue by organ |
| `image_occurrence`, `image_feature` | 28,179 / 13,255 | PACS series (DICOM modality, body site, OneLake folder) and nodule features linked to their measurements |
| `condition_era`, `drug_era` | 67,259 / 33,966 | Standard OHDSI era logic (30-day gap; drugs rolled up to ingredients) |
| `concept`, `concept_relationship`, `concept_ancestor`, ... | 8.6M / 59M / 70M | Standardized vocabularies (SNOMED, LOINC, RxNorm, ICD-10-CM, ATC, ...); CPT4 removed |

Records follow OMOP domain routing: each one lands in the table of its standard concept's domain. For example, a SNOMED "finding" diagnosis goes to `observation` and a vaccination procedure goes to `drug_exposure`. 99–100% of clinical records map to a standard concept; `17_verify_stage3.py` prints the coverage. Local codes are documented in `source_to_concept_map`: Epic's internal imaging and pathology procedure codes are mapped to SNOMED. Imaging follows the OHDSI [medical imaging extension](https://github.com/OHDSI/ImageWG). `note_nlp` is created empty for stage 5.

**Gold_i2b2** (`scripts/i2b2_etl.py`): `observation_fact` (2.2M facts with ACT-style codes such as `ICD10CM:E11.9`, `LOINC:4548-4`, `RXNORM:197361`), `patient_dimension`, `visit_dimension`, `provider_dimension`, `concept_dimension`, `modifier_dimension`, and the ontology tables `i2b2_ontology` and `table_access`. `patient_num` and `encounter_num` are random surrogate keys, stable across rebuilds; the i2b2 mapping tables that link them to OMOP and Epic IDs are kept in Silver_OMOP (`i2b2_patient_mapping`, `i2b2_encounter_mapping`), so the discovery layer holds no source identifiers. The ontology has ten top-level folders:
- Demographics
- Visit Details
- Diagnoses: ICD-10-CM chapter, then category, then code
- Medications: ATC, then RxNorm ingredient, then drug
- Labs: with numeric value metadata
- Vital Signs and Assessments: with answer leaves
- Procedures
- Imaging: studies by modality and body site, image availability, and LIDC nodule measurements
- Clinical Notes
- Specimens

There are two modifiers: diagnosis role and nodule lobe. Every node carries its patient count.

## Cohort discovery

Two semantic models, split by purpose. Both are Direct Lake on OneLake, so no data is imported or copied:

| Model | Over | For |
|---|---|---|
| **Cohort Discovery (i2b2)** | Gold_i2b2 | Counts only. GitHub Copilot queries it. It has no source identifiers, dates of birth or death, or ZIP codes, and its patient keys are random surrogates |
| **Research Data (OMOP)** | Silver_OMOP, Bronze_PACS (SQL database), Bronze_ClinicalDocuments | Patient-level data for approved requests: one model across two lakehouses and a SQL database |

**Option 1: the Cohort Discovery agent (i2b2).** Ask a question in Copilot Chat, for example *"Adults aged 50 to 79 who had a low-dose CT of the chest and have a lung nodule of at least 8 mm, excluding anyone with emphysema"*. The agent works through the `cohort-discovery` MCP server:

1. It finds the ontology terms (`search_ontology`, `browse_ontology`, `list_modifiers`).
2. It builds an i2b2 query definition: panels are combined with AND, items in a panel with OR, an inverted panel means NOT, and items can carry value, modifier, date, occurrence and same-visit constraints.
3. `run_i2b2_query` compiles the query to DAX, runs it on the Cohort Discovery model as you, and records it the way the i2b2 CRC does: `QT_QUERY_MASTER` (with the i2b2 request XML), `QT_QUERY_INSTANCE`, `QT_QUERY_RESULT_INSTANCE`, the patient set and the XML breakdowns.
4. It shows the **QUERY_MASTER_ID**, the i2b2 query name, the obfuscated patient count, and breakdowns by age, gender, race and vital status.

Counts are obfuscated as i2b2 does for a `DATA_OBFSC` user: a true count of 3 or fewer is reported as 0 (shown as "Fewer than 4"); otherwise Gaussian noise is added (σ 1.323 for totals, 1.6 for breakdown cells) and the count is shown as "N ±3". The true count and the patient list never leave the server, and ontology term counts under 10 are suppressed.

When you are happy with a query, ask the agent to submit it. `submit_request` creates a PENDING data request and links it to its page in the **approval app** (`apps/approval`), a Fabric App built with Project Rayfin and hosted in the workspace. The app opens on an inbox of requests; each request page shows the question, the i2b2 query as panels (with the XML to view or download), the counts and breakdowns, and the audit trail. **Approve** and **Reject** take an optional comment and record the signed-in user's name and the UTC time; a request can only be decided once. The app's functions read and write the CRC store as the app identity (the owner of the app item), and take the approver's identity from the sign-in.

The earlier approval page, a Power BI dashboard per request with translytical Approve and Reject buttons (the `decideRequest` user data function), is still there: set `APPROVAL_UI=powerbi` and new requests get a dashboard named `Cohort request <QUERY_MASTER_ID> - <title>` in the workspace folder *Cohort requests* instead.

**Delivery** starts from the approval app. When you approve, **Deliver the data when I approve** (checked by default) starts it straight away; an approved or delivered request also has a **Start delivery** (or **Deliver again**) button. **Demo mode** (also checked by default) delivers 25 of the cohort's patients, 20 documents and 5 imaging studies, which takes about two minutes; clear it to deliver the whole cohort. The app runs the **Cohort_Delivery_Pipeline**, which passes the request number, the demo setting and the app's workspace folder to the **Cohort_Delivery** notebook. The request page follows the run: the pipeline status and elapsed time, each step as the notebook records it, and at the end links to the new lakehouse and to its notebook. The steps are also kept in the audit trail, including the error if a step fails. Delivery does the following:
- maps the patient set to OMOP persons and adds the cohort to `Silver_OMOP.cohort` (cohort_definition_id = QUERY_MASTER_ID);
- creates a lakehouse in the approval app's folder (*Cohort requests*), named after the request: `Delivery_QM<id>_<title in words>`, ending in `_Demo` in demo mode, for example `Delivery_QM1006_Type2DiabetesNeverPrescribed_Demo`;
- copies the cohort's OMOP tables (person, visits, conditions, drugs, procedures, measurements, observations, notes and imaging) without source identifiers or note text, with `concept`, `cohort`, `document_links` and a `delivery_manifest`. The tables are copied because a shortcut can't filter rows;
- links each of the cohort's DICOM studies with a OneLake shortcut to its folder in Bronze_ImagingArchive, so the images themselves stay in place. Shortcut names can't contain dots, so the shortcut is the StudyInstanceUID with underscores (`Files/dicom/1_2_840_…`), and `image_occurrence.local_path` points at it;
- copies the cohort's reports and notes to `Files/documents`, and `document_links.document_url` points at each copy. Bronze_ClinicalDocuments files documents by type and year, so a folder shortcut would include other patients' documents;
- creates the notebook `Explore_QM<id>_<title>` next to the lakehouse, with the lakehouse attached (see below);
- syncs the lakehouse's SQL analytics endpoint so the tables can be queried at once, and marks the request DELIVERED.

In demo mode the patients and studies are picked one kind of image at a time (a CT with the radiologists' nodule outlines, a pathology slide, an MR, an X-ray, then other CTs), so every kind of image is in the sample.

To deliver without the app, run the Cohort_Delivery notebook by hand (set `QUERY_MASTER_ID`, and optionally `DEMO_MODE` and `DELIVERY_FOLDER_ID`) or `python scripts/cohort.py deliver <id> [--demo]`. `scripts/22_approval_app.py` puts the app in the folder set by `APPROVAL_APP_FOLDER` (by default the *Cohort requests* folder); its functions item moves with it.

The MCP server has no approve or deliver tool, so a researcher can do neither from Copilot.

**The researcher's notebook.** Each delivery comes with `Explore_QM<id>_<title>`, a Fabric Python notebook (single node; the session starts in seconds) in the same folder, with the delivery lakehouse attached. Open it from the request page (**Explore the data in a notebook**) or the folder and select **Run all**; it takes about a minute. It loads every delivered table into DuckDB, so each chart is a short SQL query, and draws them with Plotly in the demo's colours:
1. what was delivered (rows per table and the delivery manifest);
2. who is in the cohort (age and sex pyramid, race, vital status);
3. the most common conditions, and which ones occur together;
4. medications, with the patients on each one per year;
5. familiar labs and vitals (HbA1c, glucose, eGFR, BMI, blood pressure), each patient's latest result and ten years of trends;
6. visits per year by type;
7. imaging: studies by modality, nodule sizes against the Lung-RADS cut-offs, a chest CT read through its OneLake shortcut that follows the study's largest nodule, with the LIDC radiologists' outline of it (DICOM SEG) on each slice, a close-up centred on it and a slider through its slices and two more on each side, and one image of every other kind (a pathology slide thumbnail, an MR, an X-ray);
8. reports by type and one report for the same patient;
9. that patient's record on one timeline (visits, conditions, medications, labs, procedures, imaging, reports).

The notebook is generated by `scripts/research_notebook.py`. To create it for an earlier delivery, or to pick up a change to the notebook, run `python scripts/cohort.py notebook <id>`. The cells also run outside Fabric, reading the lakehouse over OneLake instead of the attached mount.

**Option 2: the Cohort Explorer (DAX) agent.** This agent writes DAX against the Cohort Discovery model through Microsoft's Fabric IQ MCP server, guided by the model's AI instructions. It's meant for quick exploration: it reports obfuscated counts, but its queries aren't recorded and can't become requests. Its counting rules are instructions to the language model, not enforced in code as they are in option 1.

**The Cohort Discovery app** (`apps/discovery`) is the easiest way to show all of this. It's a local web app: the page talks to GitHub Copilot through the Copilot SDK, and the cohort tools above run inside the app. Run `.venv/bin/python apps/discovery/app.py` and open http://127.0.0.1:8766.

- **Chat** with Copilot (streaming, with a model and thinking-level picker) and starter questions, including the ones in the validation list.
- **The i2b2 query** on the right updates as Copilot builds it: panels of chips joined by AND, OR inside a panel, NOT, values, modifiers, dates, repeat counts and same visit. You can change it by hand, or build one from scratch with **+** in the ontology browser, and run it without Copilot.
- **Result:** the QUERY_MASTER_ID, the obfuscated count and bars for the four breakdowns. **History** reopens any earlier query with its result.
- **Submit request** creates the data request; the page follows its status (pending, approved, delivered) and links to its page in the approval app.
- **DAX explore** is option 2 inside the app: Copilot writes DAX against the Cohort Discovery model, and the app enforces counts-only output in code (every number is obfuscated; patient-level columns and other numbers are refused). Nothing is recorded.

**The Discovery tab of the approval app** has the same chat inside Fabric (Stage 4e). Each user signs in to GitHub in the tab, and their questions use their own Copilot plan through a small relay in Azure Container Apps. The tools run in the app's Rayfin Functions, which query the semantic model and record runs and requests with the signed-in Fabric user. Copilot can also draw charts of the counts it has found. The local app keeps working on its own. See [docs/fabric-hosted-discovery.md](docs/fabric-hosted-discovery.md).

**From the command line,** `scripts/cohort.py` offers:
- the same operations: `search`, `browse`, `modifiers`, `preview`, `run`, `queries`, `show`, `delete`, `submit` and `status`;
- `deliver` (`--demo` for the demo-mode sample) and `notebook`, which creates or refreshes a delivery's Explore notebook;
- the admin command `remove`, which drops a request with its dashboard, delivery lakehouse and notebook, and Silver cohort rows.

## Patient 360 and Ask

Patient 360 (`apps/patient360`) opens one patient's whole record across the systems that hold it. It is a port of the
Patient 360 reference app
([MS101-public-patient-360-fabric-rayfin-GHC](https://github.com/SanjayNarendran/MS101-public-patient-360-fabric-rayfin-GHC)),
grown to this dataset: 3,554
patients, of which 3,539 are the synthetic Epic patients and 15 are the reference app's TCGA research patients with
their tumour genomes. The patient list opens on all 28 demo patients, each with a line on why they are worth showing
and the reference app's columns (cancer, stage, outcome, key gene changes, mutation burden, MSI, slide gigapixels and
scan series), and searches by name, MRN, ID or condition, with filters for the images online, cancer, sex, age and
vital status, ten at a time.

A record is a lifetime timeline (visits, conditions and medications, cancer course and treatment, imaging, pathology
and documents, tumour board notes) over tabs for each part. Scans and slides open in the viewers of the Rayfin imaging demo
([MS101-public-patient-imaging-2D-3D-4D-fabric-rayfin-GHC](https://github.com/SanjayNarendran/MS101-public-patient-imaging-2D-3D-4D-fabric-rayfin-GHC)). A CT or MRI opens in 3D, MPR or
single slices, with colour and window presets, a clip plane, spin, a layers panel (the LIDC radiologists' nodule
outlines with *Go to*, AI segmentations), save image and full screen. A slide opens at 1.25× to 40× with a tour,
copy link, full screen, Compare (a second slide linked at the same magnification), the report beside it, AI layers
and a filmstrip of the patient's slides. Both have a details panel that explains the image in plain words. X-rays
open zoomable; scanned documents sit beside their text and the facts they were written from. Every online study has
viewer files. Two demo patients also carry six studies from the imaging demo, each labelled with its source and
licence: Stephan Rutherford a whole-body FDG PET/CT with expert lesion masks, a breathing 4D CT and a brain-wiring
atlas (its 87 bundles each shown alone, with the cortical areas it reaches, its volume across 1,065 people and its
probability map, from every file the atlas's publisher offers), and the 33 cone-beam CTs from his treatment couch; the
PET/CT and 4D CT also open at full size; Ivelisse Nitzsche a TCGA breast slide with AI nuclei and immune-cell layers, a fetal brain atlas played week by
week (with T1 and diffusion maps) and a 36-marker immunofluorescence slide. The 681 hospital patients whose biopsy slides come from sequenced TCGA tumours have the genome of each (756 in all,
from cBioPortal's PanCancer Atlas), and the research patients add their tumour genome, cancer registry, AI
segmentations and scanned pathology reports. *Read in place* lists every query
a page ran, with its source and time, and *Where the data lives* lists every source item with its tables, rows and
size. The app writes only to its own Rayfin database: tumour board notes, and each user's saved Ask chats. A
**Cohorts** tab lists the approved and delivered data requests from Cohort Discovery that include the patient, with
links to the request in the approval app and to the cohort's other patients; the patient list filters by request.

Ask is a conversation with GitHub Copilot about one patient, several together, or all of them. Copilot reads the
records through the app's own data API and answers with the record's views: aligned timelines, results over time,
scans opened on a nodule, slides with their AI layers or chosen marker channels, the imaging demo's studies at the
view, layer or time point asked about, reports and genomes, and charts for counts across patients. Each answer shows
its steps. Starter questions are grouped by who is asking (oncology, radiology, pathology, primary care, research and
data). Right-click anything in a record to ask about it in a side panel. Locally, chats are saved in folders and
reopen with their viewers. `apps/patient360/chat/QUESTIONS.md` lists the questions and
`apps/patient360/chat/TESTING.md` the evaluation, which runs 58 questions through the real page.

Both run on this computer with no capacity (`npm run dev:local` and `apps/patient360/chat/server.py`) and in Fabric as
the Fabric App `patient-360`, whose functions read every source as the signed-in user through one SQL analytics
endpoint and hand the viewers short-lived, read-only links to the files in OneLake. Ask in Fabric goes through a relay
in Azure Container Apps, and each user signs in to GitHub with their own Copilot plan. Setup is step 9 of
[docs/setup.md](docs/setup.md); the design and build log are in [docs/patient-360.md](docs/patient-360.md).

## The presentation

`presentation/` is a static web page that introduces Microsoft Fabric and leads into the demo. It is styled like the CMS Quality Dashboard's Quality & safety tab: the same top bar, headline and contents rail, in light and dark. It opens with a figure of Fabric: GitHub Copilot and Microsoft Foundry above it, the workloads (with Rayfin as a seventh), the platform services, and OneLake, with two-way arrows to seven kinds of data source below. Select any part, or step through with the arrow keys, to read what it does and where it appears in this demo. Below it, **About this demo** sets out the study question the demo answers and the data it uses. Numbered sections follow. **01 Data Unification** plays, step by step, how each source reaches OneLake: the Epic tables, the PACS database by mirroring, and the images and documents in ADLS by shortcuts, ending with every source in one lake. The Epic tables' card is a stack of plates that turns through the places they can be, each with its own way in: SQL Server on premises (mirrored through the on-premises data gateway), Snowflake (Iceberg shortcut), Azure Databricks (Unity Catalog shortcuts through a mirrored catalog) and another Fabric workspace (OneLake shortcut). Its last step, Future, puts Epic Cogito Cloud, shared from Epic's own Fabric tenant, on top of the stack. A second figure shows, hypothetically, how Data Factory and Spark would bring in COBOL or AS/400 data. In **02 Medallion Architecture**, the OneLake box slides down from section 01 as you scroll and becomes the Bronze layer. Fig 3 then plays the enrichment of the imaging data, the Silver layer in OMOP, the Gold layer in i2b2, and the study question answered with 358 patients in each; a card below it says why the demo uses OMOP and i2b2. **03 Semantic Model** draws the three semantic models as small model diagrams inside a Fabric IQ box, each with the group it is for and the items it reads in OneLake. Its Cohort Discovery step shows GitHub Copilot asking that model a question in plain language through the Fabric IQ MCP server, and the approval app (Rayfin) sits above Cohort Requests. **04 Cohort Discovery** plays the researcher's and the reviewer's experience in a replica of the Cohort Discovery app and the approval app, from typing the study question to the request approved with delivery, with a track underneath that shows what each step writes in i2b2. **05 Data Delivery** follows that delivery in the approval app, step by step, until the new lakehouse opens in Fabric with its tables, its DICOM shortcuts and its documents; a diagram under it shows the Fabric items behind each step (the approval app, the Data Factory pipeline, the notebook, the request database and OneLake). **06 Research Platform** opens the Explore notebook that comes with that delivery in a replica of Fabric and runs it: the cells run one by one and draw the notebook's charts for the 25 delivered patients, a CT viewer plays patient 1000013's chest CT with the largest nodule outlined, and the images and a report follow (the images are the delivery's own, credited in `presentation/assets/img/NOTICE.md`); a diagram under it shows what the notebook reads in OneLake. **07 Research: Patient 360** opens a patient's whole record in the Patient 360 app: the demo list, Levi Hills' lifetime timeline, how the page was read from each source, his screening CT with the radiologists' nodule outlines, his biopsy slide zoomed to 20×, then a TCGA research patient's slide with its AI lymphocyte map and his tumour genome. **08 Research: Conversational Insights** replays two recorded answers from the app's Ask page, where GitHub Copilot answers with the record's own viewers and lists each step it took; diagrams under both show where the data is read and how an answer is made. A short **Summary** closes the page. The five app screens (Figs 5 to 9) are shown in white on a stone plate in either theme, the way the apps look, with their controls above the screen; **Full view** grows a screen to the whole window, with the step caption under it, and Esc returns it to the page. Sections 01 and 02 tell the story as it would run in production. In this demo `05_onelake_load.py` writes the Epic tables into OneLake as Delta, the PACS index is a Fabric SQL database, the images and documents were uploaded into lakehouses, and the DICOM headers and nodule findings were prepared on the setup machine before upload (scripts 08 to 10).

It needs no build step and no network. Open `presentation/index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8792 --directory presentation   # then open http://127.0.0.1:8792
```

The descriptions are in `presentation/assets/js/platform.js`, and the section figures are drawn by `unification.js`, `medallion.js`, `semantic.js`, `discovery.js`, `delivery.js`, `research.js`, `patient360.js` and `ask.js` (the last two share the data and viewers in `p360kit.js`), which share `figkit.js`; the icons and their sources are listed in `presentation/assets/icons/NOTICE.md`.

It can also be published as the Fabric App `cohort-presentation` in your workspace ([docs/setup.md](docs/setup.md),
section 10). Viewers sign in with their Fabric account, because the assets are protected. `apps/presentation/` is the Rayfin project: its build copies `presentation/` into `dist/` and adds
a content-hash version to every script and stylesheet URL. To publish a change, with the capacity running and Node.js
20, 22 or 24:

```bash
cd apps/presentation
npm install                 # first time only
npm run deploy:static       # build and deploy the static site
```

On a new machine, `npx rayfin up --workspace-id <workspace>` links or creates the Fabric item. The deployment state
(`rayfin/.deployments.json`, `rayfin/.env`) is not committed.

To share the presentation as a file, for example in Teams, build it as one self-contained HTML file (about 3.5 MB):
`npm run build:standalone` in `apps/presentation` writes `apps/presentation/standalone/Fabric-Rayfin-research.html`
(not committed). The scripts, stylesheets, fonts and images are all inside it, and it opens from disk in Edge or
Chrome with no network and no sign-in. It also plays in the Teams file preview, which runs HTML files in a sandboxed
frame; the figures start once they fill half of a short window or pane, as well as when most of a figure shows.

## The EHR data

The source is the [Synthea Coherent Data Set](https://registry.opendata.aws/synthea-coherent-data/): 3,539 synthetic patients with lifetime records, generated by The MITRE Corporation. `02_generate_epic_data.py` reshapes those records into a fictional health system, **Contoso Health**, which has seven Massachusetts campuses. The output is deterministic, so every run produces identical IDs.

| Clarity (normalized, OLTP-style) | Rows |
|---|---|
| `PATIENT`, `PATIENT_RACE` | 3,539 |
| `PAT_ENC` (encounters), `PAT_ENC_HSP` (ED and inpatient), `PAT_ENC_DX`, `PROBLEM_LIST` | 286,647 / 26,004 / 95,710 / 24,829 |
| `ORDER_PROC` (procedures, imaging, pathology, lab orders), `ORDER_DX_PROC`, `ORDER_RAD_ACC_NUM` (accession numbers) | 302,271 / 62,622 / 12,910 |
| `ORDER_RESULTS` (lab components), `ORDER_MED`, `ORDER_DX_MED` | 902,912 / 371,210 / 287,940 |
| `IP_FLWSHT_REC`, `IP_FLWSHT_MEAS` (vitals, scores, staging; BP stored as "120/80") | 88,285 / 449,262 |
| Masters: `CLARITY_SER` (including reading radiologists and pathologists), `CLARITY_DEP`, `CLARITY_EDG` (ICD-10 + SNOMED CT), `CLARITY_EAP`, `CLARITY_COMPONENT` (LOINC), `CLARITY_MEDICATION` (RxNorm), `IP_FLO_GP_DATA` | |
| 16 `ZC_` category lookups | |

| Caboodle (star schema, built from the Clarity tables) | Rows |
|---|---|
| `PatientDim`, `ProviderDim`, `DepartmentDim`, `DiagnosisDim`, `ProcedureDim`, `MedicationDim`, `LabComponentDim`, `FlowsheetRowDim`, `DateDim` | |
| `EncounterFact`, `HospitalAdmissionFact` | 286,647 / 12,656 |
| `DiagnosisEventFact` (encounter diagnoses and problem list), `ProcedureEventFact`, `ImagingFact` | 120,539 / 136,928 / 12,910 |
| `MedicationOrderFact`, `LabComponentResultFact`, `FlowsheetValueFact` (BP split into systolic and diastolic) | 371,210 / 902,912 / 503,701 |

Notes:

- **Dates** are shifted forward by exactly 260 weeks, so records run to mid 2026. Ages, intervals and weekdays are preserved. Synthea records are lifetime histories, so some imaging and pathology dates go back decades.
- **Imaging cohorts** (`scripts/imaging_cohorts.py`) are added to the Synthea records before the tables are built:
  - **Lung nodule program:** each of the 1,010 LIDC-IDRI subjects is matched to one patient aged 45 to 85, using sex and age where LIDC records them, with former smokers first. That gives 1,308 new radiology visits: LDCT screening for smokers, diagnostic CT otherwise, and a chest X-ray first when LIDC has one. Consensus nodules become *Solitary nodule of lung* / *Multiple pulmonary nodules* diagnoses, plus *Suspected lung cancer* for large, suspicious nodules.
  - **Digital pathology:** each lung, breast, colon and prostate cancer patient gets a surgical-pathology order on the encounter of their biopsy or resection, matched to a TCGA slide on sex and age at diagnosis (792 cases).
  - **Brain MRI:** the 298 Coherent MRI volumes are linked to their patients' existing MRI studies.
- **Clarity and Caboodle differ in shape on purpose**, in the same way the real systems do. For example, blood pressure is one string in Clarity flowsheets but two numeric rows in Caboodle, and Caboodle has `-1` "Unspecified" dimension rows. These differences are useful for demonstrating multi-source reconciliation.
- **ICD-10 codes, lab reference ranges and medication classes** are curated demo approximations in [scripts/epic_reference.py](scripts/epic_reference.py). They aren't clinically validated.
- **Column types** are declared in [scripts/epic_schema.py](scripts/epic_schema.py): `INT`, decimals with precision below 10, `VARCHAR`, `DATE` and `TIMESTAMP`, written to Delta as int, decimal, string, date and UTC timestamp. Caboodle names keep their PascalCase.

## The imaging data

The PACS has one DICOM study per imaging or pathology order: 12,910 studies.

| Source | Studies | Images | Size | Licence |
|---|---|---|---|---|
| [LIDC-IDRI](https://doi.org/10.7937/K9/TCIA.2015.LO9QL9SX): chest CT, chest X-ray, radiologist nodule segmentations (SEG) and measurements (SR) | 1,308 | 258,335 | 133 GB | CC BY 3.0 |
| TCGA [LUAD](https://doi.org/10.5281/zenodo.12689915), [LUSC](https://doi.org/10.5281/zenodo.12690008), [BRCA](https://doi.org/10.5281/zenodo.12689962), [COAD](https://doi.org/10.5281/zenodo.12689970), [PRAD](https://doi.org/10.5281/zenodo.12689935) slide microscopy (IDC DICOM conversions): one whole-slide image per case | 792 | 3,538 | 146 GB | CC BY 3.0 |
| [Synthea Coherent](https://doi.org/10.3390/electronics11081199) brain MRI volumes | 298 | 298 | 9 GB | CC BY 4.0 |
| Echo, mammography, DXA, fetal and other ultrasound, extremity X-rays and the remaining chest CTs: indexed with plausible series metadata but **no pixel data** (`InstanceAvailability = OFFLINE`, held in a "legacy archive") | 10,512 | (1.18M listed) | | |

`09_process_dicom.py` rewrites each file's patient identity (MRN, name, birth date, sex, age), accession number, study date and time, study description, referring physician and institution from the Epic records. It also removes the research identifiers: LIDC and TCGA barcodes, clinical-trial and de-identification attributes, and private tags. UIDs are kept, so the LIDC segmentations and measurement reports still reference their CT images. Coherent's secondary-capture MRIs are labelled as MR.

**The LIDC and TCGA pixel data comes from real, de-identified research participants.** This demo attaches synthetic identities to it and makes no attempt to identify anyone. Use of this data must follow the [TCIA data usage policy](https://www.cancerimagingarchive.net/data-usage-policies-and-restrictions/).

PACS database tables (`pacs` schema): `Patient`, `Study`, `Series`, `Instance` (with the OneLake storage path), `ArchiveStore`, and `NoduleFinding`. `NoduleFinding` holds the LIDC radiologists' consensus per nodule: diameter, volume, texture, margin, calcification, malignancy score, and an approximate side and lobe. Views: `vStudy` and `vInstanceFile`.

## The documents

`11_generate_documents.py` writes 18,410 documents from templates, with no LLM. Every statement is grounded in the patient's Clarity record or the image annotations:

| Type | Count | Grounded in |
|---|---|---|
| Radiology reports | 12,118 | Exam type, encounter diagnosis, active conditions, prior exams. LDCT reports use the LIDC nodules and assign a Lung-RADS category; diagnostic CTs apply Fleischner guidance. Echo reports use the LVEF and DXA reports the T-scores in flowsheets |
| Surgical pathology reports | 792 | The TCGA case of the slide: histology, pT/pN, lymph nodes, margins and Gleason score. Breast reports also cite the ER/PR/HER2 results in Clarity |
| Progress notes | 5,000 | Office visits of the imaging and pathology cohort (2010 onwards): active problems with ICD-10, active medications, vitals, recent labs, prior imaging and pathology results |
| Scanned documents | 500 of the above | Rendered as skewed, noisy, faxed image-only PDFs for OCR. The source text is kept in `Files/ground_truth/ocr/` |

The `document_index` Delta table links every document to its patient, encounter, order, accession number and DICOM study. `document_facts` holds about 78,000 ground-truth facts: diagnoses, findings, measurements, labs, medications, vitals, assessments and stages. Stage 5 uses them to evaluate NLP extraction. The scans use the Courier Prime font (SIL Open Font License), which is downloaded at setup.

## Running costs

OneLake data is only readable while the Fabric capacity is running, so resume the capacity before a demo and pause it afterwards:

```bash
az resource invoke-action --action resume --ids <capacity-resource-id>
az resource invoke-action --action suspend --ids <capacity-resource-id>
```

OneLake storage for the demo is about 300 GB. Writing it costs roughly 50,000 CU-seconds, a few percent of one day of F4. The documents and the DICOM header rewriting are generated locally, so they use no Fabric compute. The Silver and Gold layers are also built locally. Uploading them takes about four minutes. One run of each Fabric notebook takes about three minutes on a single-node Python session. A cohort query is a few DAX queries of about a second each, and one delivery is a notebook run of about two minutes.

The optional Discovery tab and Ask in Fabric add a Basic container registry (about $5 a month) and two Container Apps that scale to zero when idle. With one replica kept running for a demo each costs up to about $2.60 a day at list price. Copilot usage is billed to each user's GitHub plan. Patient 360 adds about 31 GB of OneLake storage with the research data, and `31` and `32` about 32 GB more.

## Troubleshooting

- **`07_verify.py` reports an invalid object name, or a column it can't see.** The SQL endpoint hasn't caught up with new tables yet; wait a minute and run it again. Reload one table with `05_onelake_load.py TABLE`.
- **New tables don't show up in a SQL analytics endpoint.** The scripts call the endpoint's metadata refresh API; you can also select **Refresh** in the endpoint.
- **PACS tables look empty on a SQL analytics endpoint right after `10_pacs_database.py`.** Fabric replicates the SQL database to OneLake asynchronously; give it a few minutes. `12_verify_stage2.py` waits for it.
- **Renaming items.** Lakehouses can be renamed, but a Fabric SQL database can't; change `PACS_DATABASE` and rerun `10_pacs_database.py` to create a database with the new name.
- **SQL error 4891 while loading the PACS database.** Fabric replicates new tables to OneLake right after they're created, which can briefly block bulk inserts. `10_pacs_database.py` retries automatically.
- **Reading Bronze tables from Python.** Delta tables with deletion vectors are rejected by the PyArrow reader in `deltalake`. `omop_etl.OneLakeBronze` uses the `deltalake` DataFusion reader (`QueryBuilder`) and copies the result into DuckDB.
- **The research pipelines.** `build_synthea.py` needs Java 17 or newer; `build_multiplex.py` (the CyCIF slide) needs about 8 GB of memory per worker, so run it again with `--workers 1` if it is killed. Both `run_all.py` scripts resume where they stopped.
- **A notebook run fails.** The job API only reports "statement execution failures", so read the traceback in `Files/etl_runs/<name>_error_<time>.json`. `16_fabric_notebooks.py --run` prints it. The notebooks install packages with `pip` in code because `%pip` is disabled in scheduled and API-triggered runs.
- **"This Fabric capacity ... is currently not available"**, or a notebook fails within a minute and writes no error file. The capacity was paused. Resume it and run again.
- **The approval app says "Sign in to continue" and nothing happens.** Fabric opens the sign-in in a popup; allow popups for the app's address, or find the popup window and finish signing in there.
- **`npm install` fails with "Cannot read properties of null (reading 'edgesOut')".** A bug in npm 10 with this workspace's peer dependencies. `22_approval_app.py` installs with `--legacy-peer-deps`; do the same by hand.
- **A Rayfin function fails with "MissingInput: Parameter not found".** Rayfin finds a function's context parameter by its literal `RayfinContext<...>` annotation; with a type alias the parameter is taken as a request input.
- **The Cohort Discovery app shows one column.** It needs about 1,180 pixels for three columns; on narrower windows the ontology and history open from the **Ontology and history** button.
- **A request dashboard shows a credentials error.** The Cohort Requests model reads the SQL database with single sign-on, and those credentials are reset whenever the model is redeployed. `20_cohort_app.py` sets them again, so rerun it.
- **Publishing the user data functions fails with `DeployCooldownBlock`.** Fabric allows one publish about every two minutes. `20_cohort_app.py` waits and retries, and skips publishing when the code hasn't changed.
- **The cohort-discovery MCP server doesn't start in VS Code.** It runs `.venv/bin/python scripts/cohort_mcp.py`, so create the virtual environment and install `requirements.txt` first. Check *Output → MCP: cohort-discovery* for the error. On macOS the server restarts itself with Homebrew's OpenSSL on the library path, as the other scripts do.

## Licences and attribution

- **EHR data:** Synthea Coherent Data Set, © The MITRE Corporation, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Walonoski J, et al. *The "Coherent Data Set": Combining Patient Data and Imaging in a Comprehensive Synthetic Health Record.* Electronics 2022; 11(8):1199. https://doi.org/10.3390/electronics11081199. The Epic-style tables are derived from it, with dates shifted and identifiers, names, contact details and organizations reworked.
- **LIDC-IDRI:** Armato SG III, et al. Data from LIDC-IDRI. The Cancer Imaging Archive, 2015. https://doi.org/10.7937/K9/TCIA.2015.LO9QL9SX. CC BY 3.0. The nodule SEG/SR objects: https://doi.org/10.7937/TCIA.2018.h7umfurq, described in Fedorov A, et al. *DICOM re-encoding of volumetrically annotated Lung Imaging Database Consortium (LIDC) nodules.* Med Phys 2020; 47(11):5953-5965. https://doi.org/10.1002/mp.14445.
- **TCGA:** slide microscopy from the TCGA-LUAD, TCGA-LUSC, TCGA-BRCA, TCGA-COAD and TCGA-PRAD collections as converted to DICOM by IDC (Zenodo DOIs above), with clinical data from the TCGA Research Network (https://www.cancer.gov/tcga). CC BY 3.0.
- **Patient 360's research patients:** the 15 TCGA patients built by `research/patient360` carry data from the NCI Genomic Data Commons (clinical records, slides and pathology reports; NIH GDC open access, cite the TCGA Research Network), the TCGA PanCancer Atlas through cBioPortal (mutations, copy number, expression), *The Immune Landscape of Cancer* data files on the GDC, TCGA-Reports (https://doi.org/10.17632/hyg5xkznpx.1, CC BY 4.0), the TCIA TCGA radiology collections through IDC (CC BY 3.0), the BAMF AIMI segmentations (https://doi.org/10.5281/zenodo.8345959, CC BY 4.0), RCC-AID (https://doi.org/10.5281/zenodo.22284133, CC BY 4.0) and the Stony Brook TCGA TIL maps (https://doi.org/10.5281/zenodo.16966285, CC BY 4.0). Their primary-care history and display names are synthetic (Synthea). The genomes of the hospital patients' TCGA slides come from the same cBioPortal studies and GDC immune landscape files (`scripts/29_patient360_genomics.py`, downloaded at setup). The six imaging-demo studies on two demo patients (`scripts/30_patient360_showcase.py`, built by `research/imaging` from their publishers) are FDG-PET-CT-Lesions (https://doi.org/10.7937/gkr0-xv29, CC BY 4.0; TCIA now also lists a controlled-access version of this collection, and IDC labels the series used here CC BY 4.0) and 4D-Lung (https://doi.org/10.7937/K9/TCIA.2016.ELN8YGLE, CC BY 3.0) from TCIA through IDC, the HCP1065 tractography atlas (https://doi.org/10.1038/s41467-022-32595-4, CC BY-SA 4.0) on the ICBM 2009a template (McGill free-use licence), the dHCP fetal brain atlas (https://doi.org/10.12751/g-node.ysgsy1, CC0), TCGA case TCGA-AC-A4ZE from the GDC (NIH GDC open access) with nuclei and TIL layers from IDC (CC BY 4.0), and the HTAN CyCIF section HTA7_920_1000 through IDC (CC BY 4.0). The app's Sources page cites each one.
- **NCI Imaging Data Commons:** Fedorov A, et al. *National Cancer Institute Imaging Data Commons: Toward Transparency, Reproducibility, and Scalability in Imaging Artificial Intelligence.* RadioGraphics 2023; 43(12). https://doi.org/10.1148/rg.230180.
- **Changes made:** DICOM patient, study and institution attributes were replaced with synthetic values and research identifiers were removed. The images themselves are unchanged.
- **OMOP vocabularies:** downloaded at setup from Microsoft's healthcare data solutions in Microsoft Fabric package (v1.4.0, https://aka.ms/HLSFabric), which bundles the OHDSI Athena standardized vocabularies (release v5.0 31-OCT-22) and a small Microsoft vocabulary (DICOM modalities). The package is covered by the [Microsoft Software License Terms for healthcare data solutions](https://go.microsoft.com/fwlink/?LinkId=2369925). They allow use, modification and redistribution under the same terms, **on Microsoft platforms** (Azure, Fabric, Dynamics 365, Power Platform). The vocabularies keep their own third-party terms (for example SNOMED CT, LOINC and RxNorm). CPT4 (AMA) is removed by `13_omop_vocabulary.py`. Nothing from the package is committed to this repository.
- **Data models:** the OMOP Common Data Model and its medical imaging extension are published by [OHDSI](https://ohdsi.github.io/CommonDataModel/) (the imaging extension under Apache 2.0). The i2b2 tables, query XML, CRC query tables and count obfuscation follow the published [i2b2](https://www.i2b2.org) designs. No OHDSI or i2b2 software or files are included; the table definitions and query logic are written in this repository from the published specifications.
- **MCP:** the cohort MCP server uses the [Model Context Protocol Python SDK](https://github.com/modelcontextprotocol/python-sdk) (MIT), installed from PyPI.
- **Apps:** the Cohort Discovery app uses the [GitHub Copilot SDK](https://github.com/github/copilot-sdk) (MIT), Starlette and Uvicorn (BSD), installed from PyPI. The approval app was created from the Project Rayfin `blankapp` template (MIT, `apps/approval/LICENSE`); its npm packages are installed at setup.
- **Font:** Courier Prime, SIL Open Font License 1.1. The presentation embeds Fira Sans, Fira Sans Condensed and Fira Mono, also under the SIL Open Font License 1.1 (`presentation/assets/fonts/FiraSans-OFL.txt`).
- **Icons in the presentation:** official Microsoft Fabric, Azure and Power Platform icons, AWS Architecture Icons and Google Cloud product icons, each used as its publisher allows in presentations and architecture diagrams; GitHub Copilot from Primer Octicons (MIT); Databricks and Snowflake marks from Simple Icons (CC0). See `presentation/assets/icons/NOTICE.md`.
- **Trademarks:** Table and column names imitate the general shape of Epic's Clarity and Caboodle reporting databases. This project isn't affiliated with or endorsed by Epic Systems Corporation, and it contains no Epic data or proprietary documentation. *Epic*, *Clarity* and *Caboodle* are trademarks of Epic Systems Corporation. *Snowflake* is a trademark of Snowflake Inc. Contoso is a fictional company.

## Licence

The code is released under the [MIT License](LICENSE), copyright Sanjay Narendran. The research pipelines in
`research/` are ported from two MIT-licensed repositories by the same author ([research/README.md](research/README.md)).
The data keeps the terms of its sources (see [Licences and attribution](#licences-and-attribution)) and is
downloaded at setup.

## Disclaimer

**This project is a demonstration, for education and research only.**

- It shows data architecture and user interfaces on Microsoft Fabric and Project Rayfin. It is **not a medical
  device**, has not been reviewed or cleared by any regulator, and has not been clinically validated.
- It must **not** be used to diagnose, treat, monitor or make any decision about a real patient, or in place of
  professional medical judgement.
- The hospital's patients are synthetic, and the generated reports, notes and scanned documents aren't clinically
  valid. The research patients are public, de-identified TCGA cases; their display names and primary-care histories
  are synthetic and labelled as such in the app.
- AI outputs (segmentations, lymphocyte maps, nucleus outlines, the answers in Ask and the cohort chats) and the tumour
  board notes are illustrative. They may be wrong and are not clinical opinions.
- The software is provided "as is", without warranty of any kind. Nothing here is endorsed by the data publishers, the
  NCI, Epic Systems Corporation or Microsoft.
