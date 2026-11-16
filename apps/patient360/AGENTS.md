# AGENTS.md

This project ships agent context: skills under `.agents/skills/` and MCP servers in `.mcp.json`. Load them before writing code.

## Project

React + TypeScript (Vite) patient record, **Patient 360**, for the Fabric medical cohort demo, backed by **Project
Rayfin**, with **Ask**, a conversation with GitHub Copilot about one patient or many. Ported from the Patient 360
reference app (15 TCGA patients) and grown to this dataset: 3,539 synthetic Epic patients plus those 15, searchable, with 27 demo
patients first. The repository's [docs/patient-360.md](../../docs/patient-360.md) is the plan and build log, and
[docs/setup.md](../../docs/setup.md) step 9 the runbook.

The record is read where each part lives: Epic Clarity (`Bronze_Clarity`, Delta tables), the
PACS index (`Bronze_PACS`, a Fabric SQL database), the imaging archive (`Bronze_ImagingArchive`), the documents
(`Bronze_ClinicalDocuments`) and the research silos (`Bronze_Oncology_Clinical`, `_Genomics`, `_Imaging`). The
`Patient360` lakehouse holds only derived tables (the patient index, demo patients, viewer index, time companions,
inventory) and the viewer files. Functions query its SQL analytics endpoint, which reaches every other item by
three-part name, **as the signed-in user** (`ctx.Tokens.Sql`), and sign read-only, folder-scoped OneLake SAS links
with the user's storage token, so the browser streams files straight from OneLake. Tumour board notes are the only
app-owned data (`TumorBoardNote`). Production auth is Fabric Entra SSO; `rayfin dev` signs in locally with the Rayfin
CLI login (dev-only dynamic import in `src/main.tsx`).

## Repo map

- `src/` – React UI
- `src/components/ui/` – Radix-based UI components (shadcn)
- `src/components/` – App components (AppShell, Panel, Doc, AuthPage, Wordmark, ThemeToggle, Scrubber)
- `src/components/patient/` – Timeline (lifetime timeline) and TimelineDetail (an item in a tab), Imaging
  (PathologyPanel, RadiologyPanel, XrayPanel), Showcase (the imaging demo's studies), Genomics, Clinical (registry,
  report, notes), EpicSections (Epic visits, measurements, documents), PrimaryCare (MeasurementsPanel,
  PrimaryCareGlance), ReportPdf
- `src/components/imaging/` – the viewers ported from the Rayfin imaging demo: `SlideWorkspace` (OpenSeadragon) and
  `VolumeWorkspace` (Niivue), with their details panel, guide texts (`guide.ts`, `caseGuide.ts`) and AI layers
- `src/hooks/` – React hooks (usePatient, useNotes, useTheme, AuthContext, useCohort). `useCohort` opens on seven demo
  patients and shows the last visit's list (`p360.demoList.v1` in localStorage) while the live one is read, because
  the SQL endpoint can take about 10 s on its first queries after the capacity resumes; `fromCache` drives the note.
- `src/lib/` – `api.ts` (function calls, SAS file URLs), `record.ts` (tabs, mark kinds per tab, `tabFor`), `format.ts`,
  `clinical.ts` (observation vocabulary, reference ranges, drug classes), `timelineLink.ts` (`openInTimeline`)
- `src/pages/` – Patients (search, filters, paging, demo patients), PatientView, Ask, DataMap, Sources, AuthCallback
- `src/chat/` – Ask's page side (see below)
- `chat/` – Ask's chat server (local and relay), its tools and rules, local history, the evaluation (`chat/dev/`)
- `src/services/` – Service layer (ServiceContainer, Rayfin services, auth services)
- `rayfin/rayfin.yml` – Rayfin configuration (auth, data, functions, static hosting, the `CHAT_TICKET_KEY` secret)
- `rayfin/functions/src/function_app.ts` – Functions (`searchPatients`, `getPatient`, `getDocument`, `queryRecords`,
  `getDataMap`, `chatTicket`); `record.ts` – every query, in T-SQL and DuckDB, and the bundle assembly shared with
  local mode; `config.generated.ts` – the workspace's ids, written by `scripts/27_patient360_app.py` (git-ignored)
- `rayfin/data/` – Entities (export from `rayfin/data/schema.ts`)
- `local/` – Local mode (`npm run dev:local`, `.env.localdata`, `VITE_LOCAL_DATA=1`): a Vite plugin
  (`local/plugin.ts`) serves `/local-api/*` and `/local-files/*`; `local/api.ts` runs the same `record.ts` queries in
  DuckDB over `data/generated/p360` (the Bronze copy and the index from `scripts/24_patient360_data.py`) and
  `data/generated/research`. Notes are kept in `data/generated/p360/local/notes.json`; there is no sign-in
  (`LocalDataAuthService`). `src/lib/localMode.ts` holds the build-time `LOCAL_DATA` flag; production builds are
  unaffected
- Data and deploy scripts are in the repository's `scripts/`: `24` (index, `--fabric`), `25` (viewer files), `26` (the
  research patients), `27` (deploy the app), `28` (Ask's relay)

## UI (Radix-based shadcn/ui)

This project uses **Radix-based UI components** styled with **Tailwind CSS v4**.

- UI components live in `src/components/ui/`
- Utility helper lives in `src/lib/utils.ts` (`cn`)
- Add a component: `npx shadcn@latest add <component>`

Key config/files:

- Global styles + Tailwind import: `src/styles/theme.css`
- Path alias `@/*` → `src/*`: `tsconfig.json`
- Vite plugins + alias: `vite.config.ts`
- shadcn registry/config: `components.json`

## Architecture

### Service Layer

- **ServiceContainer**: Singleton that initializes and provides access to services; auto-detects local vs. production and selects the appropriate auth service
- **RayfinClientService**: Manages the RayfinClient singleton instance
- **lib/api.ts**: Calls the functions (or `/local-api` in local mode); builds signed OneLake URLs with `fileUrl`
- **usePatient**: a per-session patient cache (prefetched on hover)

### Auth Service Layer

- **RayfinAuthService**: Fabric Entra authentication operations (production)
- **RayfinFabricAuthService**: Delegates to `@microsoft/rayfin-auth-provider-fabric` SDK for Entra flows
- **MockAuthService**: Local development mock authentication (email/password via local backend)
- **AuthContext**: React context for auth state management

### Routing

- `/auth` – Public auth page (Fabric sign-in or mock sign-in; redirects to `/` if authenticated)
- `/auth/callback` – Fabric Entra OAuth callback
- `/` – Patients; `/p/<PAT_ID or TCGA barcode>?tab=<tab>&e=<mark id>` – patient record
- `/ask?p=<id>` – Ask, optionally with patients in the conversation
- `/data` – Where the data lives (live row counts; sizes from `p360_inventory`)
- `/sources` – Sources, licences, method

### Key files

- `rayfin/functions/src/function_app.ts` – SQL over the `Patient360` endpoint (database = lakehouse **name**) with
  the queries from `record.ts`, folder-scoped SAS, query provenance (*Read in place*), the chat ticket
- `src/components/patient/Imaging.tsx` – turns the record's slides and series into the imaging workspaces' shapes:
  `slideImages` (tile root, TIL map as an image overlay, the report beside the slide) and `seriesStudy` (CT or MRI
  with its label map, presets by organ, a plain-words note); the nodule legend's *Go to* calls `goToLabel` through
  millimetres. Files go through a `Locator` (path → SAS URL), so the workspaces never see the access objects
- `src/components/imaging/` – keep it close to the imaging demo's components so fixes can move between the two.
  Workspaces take `start*` props (view, frame, layers, tracts, AI overlays, channels, report) for Ask's cards and `folded` to
  open with the details panel closed; preferences are stored under `p360.imaging.*`
- `src/components/patient/Showcase.tsx` – the imaging demo's studies on two demo patients (`p360_showcase`, written by
  `scripts/30_patient360_showcase.py`): files under `viewer/<patient>/showcase/<study>`, metadata as the imaging demo
  wrote it. The tractography atlas also carries `atlas.json` from `scripts/31_patient360_tractography.py` (its 87
  bundles with each one's lines in the group files, reach, cortical areas and volume across people; probability maps;
  figures; downloads), merged into its metadata; `Tracts.tsx` draws it (Bundles tab, legend, map on the slices). `31`
  rewrites the group `.trk` files in RAS voxel order: NiiVue ignores a TRK's voxel order and drew the imaging demo's
  LAS files mirrored left to right. `scripts/32_patient360_fullsize.py` writes `fullsize.json` (merged the same way)
  for the PET/CT and 4D CT (`fullSize`: their native-resolution layers, behind the workspace's *Full size* button and
  `show_scan full_size`) and the fetal atlas (T1, FA, MD, RD and DWI layers per week), and adds the study
  `lung-4dcbct` (its own `study.json`). A timeline of separate files loads only the layers switched on
- `src/pages/PatientView.tsx` – the record, in chapters: `ChapterRule` (2 px orange rule, pill at the start,
  Hide/Show action at the end) for *Timeline* (the chart, indented under its rule; controls portalled into the record
  header) and *Details* (folder tabs on a plain rule; with the timeline on top this
  rule is also the resize handle). The timeline has no background; the lane and time column under the pointer are
  shaded. `RecordHead`, the timeline (on top by default, or left; `p360.timelineLayout`,
  height and width in localStorage, one resizable splitter for both; collapsed to a strip with
  `p360.timelineCollapsed`, size animated by CSS except while dragging), `TabBar` and `TabPane`. The DOM is the same in
  both layouts so the timeline keeps its zoom when flipped. The record scrolls as one page (`#patient-scroll` is the `<main>` in `Patients.tsx`); the tab bar is sticky, and
  with the timeline on the left the timeline column is sticky and a screen tall. The tab and selected mark are URL state (`?tab=&e=`);
  timeline clicks and tab switches push history, stepping within a tab replaces it. `tabFor` keeps the current tab
  when it can show the mark (a visit stays in Measurements). Each tab defaults to its latest item and remembers the
  last one. Pathology, Radiology and Report stay mounted once opened (hidden), and a `resize` event is sent on tab
  or layout change. `openInTimeline` requests are resolved here. Notes are loaded once (`useNotes`) and drawn as marks
- `src/components/patient/Timeline.tsx` – `buildModel` turns the bundle into marks in five lanes (`visits`,
  `problems`, `cancer`, `diagnostics`, `notes`; each lane has per-row `sizes`). Ids such as `v:<encounter_id>`,
  `c:<condition>` (a `band`), `m:<medicine>:<span>` (an `inset` bar inside its condition's row when its `reason`
  matches a kept condition), `t:<treatment index>`, `r:<study uid>`, `slide` / `sl:<slide_id>`, `report`, `genome`;
  `noteMarks` adds `n:<note id>` at the note's `eventId`. Conditions and medicines are coloured by `bodySystem()` in
  `src/lib/clinical.ts` (`--sys-*` tokens in `atlas.css`). `LifeTimeline` computes a time axis and a cross axis and
  maps them to x/y for `orientation` (`top` or `left`); piecewise time scale (life before diagnosis compressed), zoom
  window `{f0, f1}` over the base scale, gliding zoom changes, `lens` fading marks outside the open tab. Controls
  (zoom − slider + and factor, one layout toggle, Key pop-over, collapse) are portalled into the record header
  (`controlsHost`), so the timeline has no toolbar.
  Lane sizes are multipliers on each lane's natural size (`p360.laneSizes`), changed by dragging the grips beside
  the lane names (the next lane gives the space) or double-clicking a name. `collapsed` draws one thin row per lane.
  The date pill (and a 10 px hit area around the selection line, `.tl-pick-line`) is a picker; hovering
  either sets `pickHover` (pill lifts, line thickens). `detents` (one per visible mark, same-day marks fanned 8 px apart, 5 px
  collapsed) and `startPick`/`land` select the nearest notch while dragging, calling `onSelect(id, stepping)` (the
  record pushes history for the first notch and replaces it after). The wheel zooms; shift + wheel pans. A drag on the
  axis strip (ages and years, `.tl-axis-band`) draws a stretch to zoom to (`brush`); a drag anywhere else picks the
  timeline up and moves it when zoomed (`startPan`, window listeners so it keeps going outside the chart), and a press
  that doesn't move selects the mark under it. Collapsed, the axis strip still scrubs the date picker.
  Conditions are solid round-ended lines (medications a thinner line beneath); names go just before
  their line (conditions in their colour), after it when there is no room; label size follows the row height (at least 10.5 px); `labelSpecs` joins names that
  start together ("Pemetrexed + Cisplatin"), places conditions first and tries the other end of the line before
  dropping a name that would collide. In the
  horizontal layout the years sit on top under the ages
- Timeline performance: pointer moves and wheel events are handled once per animation frame; the marks/labels and the
  lanes/grid/axis are memoised layers (`marksLayer`, `frameLayer`), so hover and the picker only re-render overlays.
  The picker draws the pill and line from local state and tells the record once per frame inside `startTransition`;
  `body.tl-picking` turns off entrance animations while it moves. In `PatientView`, `TabPane`/`IndexRow` are memoised
  and their callbacks stable (`go` reads `setSearchParams` and `select` reads the tab through refs). Keep new props
  to these stable. `npm run preview:local` serves a production build on the local data, for profiling
- `src/components/patient/TimelineDetail.tsx` – an item in a tab (visit, condition, medicine, vaccine, cancer events,
  treatment, scan, slide, genome, tests): Earlier and Later step through the tab's items; cross-links select other
  marks by id
- `src/components/patient/ReportPdf.tsx` – draws the scanned report with PDF.js (never an iframe, which Fabric and
  managed browsers block). Decoders and standard fonts are served from `/pdfjs/` by the `pdfjsAssets` plugin in
  `vite.config.ts`. `warmPdfJs()` loads the code, a shared worker and those files into memory when a record opens,
  because the static host's sign-in expires after about an hour and later lazy fetches would get 401
- `src/components/Scrubber.tsx` – the one slider for stepping through instances (a tab's items by date, report pages;
  the slide and scan viewers' own sliders are off inside the record); items carry a 0..1 position
- `src/components/patient/PrimaryCare.tsx` – synthetic primary care: `MeasurementsPanel` (trend small multiples with
  shared hover and the selected visit pinned, visits per year) and `PrimaryCareGlance` (problem list, medicines,
  allergies, lifestyle and screening, immunisations; in Summary)
- `src/components/patient/Genomics.tsx` – canvas genome plot (copy number + mutation rainfall), cohort percentiles
- `notes.json` – one illustrative case-review note per demo patient, added on request (*Add the illustrative
  case-review note*) and labelled as such. `TumorBoardNote.eventId` (optional) anchors a note to a timeline mark;
  notes without it sit at diagnosis
- `pathology_slide` in the research silo has one row per slide with `role` (`diagnostic` or `frozen`), so joins must
  filter `role = 'diagnostic'`

## Ask

- Every tool runs in the page, in both modes: the chat server (`chat/server.py`) only talks to Copilot and sends a
  `page_request`; the page runs the tool (`src/chat/tools.ts`) through the same API as the record and posts
  `tool-result`. Tool definitions and rules are Python (`chat/tools.py`, `chat/rules.py`); display tools return cards
  (`src/chat/cards.tsx`) that are the record's own viewers.
- `src/chat/turn.ts` draws an answer from its event stream; saved answers are the same events, replayed. `[[fig N]]`
  places each narrative under its card.
- Locally the Vite dev server proxies `/chat-api` to port 8771. In Fabric `transport.ts` gets a ticket and the relay's
  address from `chatTicket`, and the relay (`RELAY=1`, the Container App) checks the ticket with `CHAT_TICKET_KEY`.
  History: locally `chat/history.py` (DuckDB, through the chat server); in Fabric `src/chat/historyFabric.ts` on the
  app's Rayfin database (`AskFolder`, `AskChat`, `AskTurn`, each row readable and writable only by its owner). Rayfin
  returns only the fields a query selects.
- Evaluation: `.venv/bin/python apps/patient360/chat/dev/eval.py [--only ids] [--jobs 4] [--gpu]`, with
  `npm run dev:local` and the chat server running; don't edit `src/` during a run (Vite reloads the pages). `--gpu`
  draws WebGL on the Mac's GPU, which the tractography and fluorescence cards need. Results in `chat/TESTING.md`.
- `show_scan` and `show_slide` also open the imaging demo's studies by id (`petct-whole-body`, `colon-cycif`…) with
  `layers`, `frame`, `channels` and `report`; `imaging_studies` lists what each study offers.

## Data notes

- Lakehouse SQL analytics endpoints expose strings as `varchar(8000)`: long report text is stored in parts and cohort
  distributions as quantiles.
- They also leave out `timestamp_ntz` columns (pandas writes naive times that way). The Epic and document
  times the record reads come from `Patient360.dbo.p360_time_<table>`, joined back by `timed()` in `record.ts` (T-SQL
  only); keep `HIDDEN_TIMES` there and in `scripts/24_patient360_data.py` the same. Endpoints compare strings
  case-sensitively (`like()` lowers both sides), and T-SQL `TIMESTAMP` is rowversion (`datetime(d)`).
- Function typegen cannot express tuple types; keep function return types to objects and arrays.
- The imaging demo's study metadata is too long for one SQL endpoint string, so `p360_showcase_part` holds it in
  6,000-character parts and `record.ts` joins them back into `meta_json`. Each study is labelled with its source and
  licence; the two atlases (fetal brain, tractography) are labelled as atlases, never as the patient's own scan.
- DICOM SEGs do not always share the CT's pixel layout. `scripts/25_patient360_viewers.py` places LIDC outlines on
  the CT's grid, including the CTs stored flipped (docs/patient-360.md D6). Check a new segmentation by the mean HU
  under each label.
- Genomes live in the research genomics tables keyed by TCGA barcode. A hospital patient reaches theirs through
  `Patient360.dbo.p360_genome` (the slide crosswalk, written by `24`; the rows come from
  `scripts/29_patient360_genomics.py`, which must run again after `26 --from-local`). A bundle's `genomes` holds every
  tumour; its flat `profile` to `reference` fields are the first one's, and `withGenome()` gives a view of another.
- Anything synthetic (names, day/month of diagnosis, Synthea primary-care history) must stay labelled in the UI.
- Data sources must allow commercial reuse (NIH GDC open access, CC0, CC BY, CC BY-SA): no NC or ND data. The research
  patients' immune values come from the Thorsson study's GDC data files; its CC BY-NC-ND table is not used. No data
  is committed.
- Synthea items (observation, condition, medication, immunization, allergy, procedure, careplan) carry `encounter_id`,
  which links them to their visit in the detail panel. Reference-range flags are adult ranges and are suppressed under
  18.

## Environment

- `.env` – Default Fabric API configuration
- `.env.local` – Local overrides (git-ignored, generated by `rayfin dev`)
- `rayfin/.env` – Runtime + deployment env (managed by Rayfin CLI)
- `rayfin/.deployments.json` – Registry of all Fabric workspace deployments (managed by Rayfin CLI)
- `.env.production.local` – the header's workspace link, written by `scripts/27_patient360_app.py` (git-ignored)

## Code conventions

- TypeScript strict mode; prefer small functional React components.
- Keep UI logic in `src/`; keep data model code in `rayfin/data/`.
- Services follow the singleton pattern via `ServiceContainer`.
- `ServiceContainer` auto-selects `MockAuthService` for localhost backends and `RayfinAuthService` for production.

## Generated files (do not edit)

- `rayfin/.temp/` – Rayfin/DAB config generation output
- `dist/` – Vite build output
- `.env.local` – Local environment overrides (git-ignored, script-managed)
