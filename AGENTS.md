# Notes for AI agents

This repository is a Microsoft Fabric demo: synthetic Epic-style EHR data, a PACS with DICOM images, clinical
documents, OMOP (Silver) and i2b2 (Gold) layers, semantic models, natural-language cohort discovery with GitHub
Copilot, Fabric Apps (Project Rayfin) for approving and delivering data requests, and Patient 360 with Ask, a
conversation with GitHub Copilot about one patient or many. The [README](README.md) describes it. The repository holds
code only: every dataset is downloaded from its publisher during setup.

## Setting it up

To set the demo up on a new computer or in a new tenant, follow [docs/setup.md](docs/setup.md) from the top. In VS Code,
the **Demo Setup** agent does this.

- Ask the questions in section 1 of the runbook before running anything, with your question tool if you have one.
  Don't guess the tenant, capacity, imaging size or how much research data to build.
- Tell the person every prerequisite in section 2 (the Fabric capacity and tenant settings, the Azure subscription for
  the Container Apps, GitHub Copilot seats and the Copilot CLI policy, the two GitHub OAuth Apps, the healthcare data
  solutions licence, the tools, disk space and network access), and who has to provide each one.
- Tell the person about each **[person]** step (sign-ins, the licence, the GitHub OAuth Apps, secrets), wait for it,
  then check the result.
- Run the numbered scripts in order and do the check after each one. Every script can be run again safely.
- The research pipelines (`research/*/pipeline/run_all.py`) download tens of gigabytes and take hours: check the free
  disk space first, and run them in a second terminal while Stages 1 to 4 run.

## Rules

- **Environments.** Each tenant is a named environment: `config/settings.<name>.env` and `data/state.<name>.json`,
  chosen by `config/.cohort-env` (one line) or `COHORT_ENV=<name>`. `scripts/common.py` resolves both. Git ignores all
  three, because they describe the person's tenant.
- **Secrets.** Never print, log or commit a secret: GitHub client secrets, the chat ticket keys, registry passwords. The person enters the GitHub client secret themselves (runbook 8.2). Browser automation
  tools that snapshot a page copy everything on it into the transcript, so stay off pages that show a secret.
- **Licences.** The person must accept the healthcare data solutions licence before `13_omop_vocabulary.py` runs. Don't
  accept it for them.
- **Cost.** Resume the Fabric capacity only for the work and pause it afterwards, unless the person says otherwise.
  The same goes for the Container Apps of the Discovery tab and Ask (stop them, minimum replicas 0).
- **Git.** Commit messages are short sentences in the imperative ("Add the Discovery tab to the approval app"). Don't
  commit settings, state, Rayfin deployment state (`apps/*/rayfin/.deployments.json`, `apps/*/rayfin/.env`), a
  deployed app's address in a `rayfin.yml`, or downloaded and generated data.

## Working in this repository

- Python: always `.venv/bin/python`. On macOS, scripts that load the SQL driver restart Python with Homebrew's OpenSSL
  (`common.ensure_openssl()`), so code fed through standard input runs nothing; save it to a `.py` file and set
  `PYTHONUNBUFFERED=1`. Ad-hoc code using `cohort_store.connect()` must call `common.ensure_openssl()` first.
- Node.js 20, 22 or 24 for the Rayfin CLI (Node 26 is rejected): `PATH=/opt/homebrew/opt/node@24/bin:$PATH` on macOS.
  `npm install` in `apps/approval` and `apps/patient360` needs `--legacy-peer-deps`.
- Fabric REST calls go through `common.fabric()` (it waits for long-running operations); OneLake writes use
  `common.storage_token()` with `deltalake`. After writing Delta tables, refresh the lakehouse's SQL analytics endpoint
  (`POST /workspaces/{ws}/sqlEndpoints/{id}/refreshMetadata`) or they don't show up.
- Fabric notebooks import the ETL modules from `Silver_OMOP/Files/etl_code`; after changing one, run
  `16_fabric_notebooks.py` (its `upload_code()`) rather than redeploying. Markdown lines in generated notebooks are
  written as `# <text>`, and blank lines as `# ` (never a bare `#`).
- Approval app (`apps/approval`): Rayfin functions must annotate their context parameter literally as
  `RayfinContext<...>`; the Rayfin client returns a function's JSON text already parsed. Deploy with
  `scripts/22_approval_app.py`.
- Presentation (`presentation/`, published by `apps/presentation`): it must work opened from `file://`, so icons are
  inline SVG or `<img>`, never CSS masks. Publish with `npm run deploy:static` in `apps/presentation`.
- Discovery chat: the local app is `apps/discovery/app.py`; the Fabric-hosted tab uses the relay in
  `apps/discovery/relay` (Azure Container Apps) and the approval app's `discovery` function. See
  [docs/fabric-hosted-discovery.md](docs/fabric-hosted-discovery.md).
- Patient 360 and Ask (`apps/patient360`, its own [AGENTS.md](apps/patient360/AGENTS.md)): locally `npm run dev:local`
  (port 5178) with `.venv/bin/python apps/patient360/chat/server.py` (port 8771); in Fabric, deploy with
  `scripts/27_patient360_app.py` and Ask's relay with `scripts/28_patient360_chat.py`. Its queries live once in
  `rayfin/functions/src/record.ts`, in T-SQL and DuckDB. Its scan and slide viewers are the Rayfin imaging demo's
  (`src/components/imaging`), and `scripts/30_patient360_showcase.py` adds six studies built by `research/imaging` to
  two demo patients; `scripts/26_patient360_import.py` imports the 15 TCGA research patients built by
  `research/patient360`; `scripts/31_patient360_tractography.py` adds the rest of the brain-wiring atlas's data (its 87 bundles), and
  `scripts/32_patient360_fullsize.py` three studies in full (full-size files, treatment-day cone-beam CTs, fetal
  diffusion layers).
  Plan and log: [docs/patient-360.md](docs/patient-360.md).
