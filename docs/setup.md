# Set up the demo on a new computer or tenant

This is the runbook for setting up the whole demo in a Microsoft Fabric tenant, on a computer that hasn't run it
before. It's written for an AI coding agent working with a person (GitHub Copilot in VS Code, Claude Code, Codex or
similar), and it works as a checklist for a person on their own. Agents read [AGENTS.md](../AGENTS.md) first; in VS Code
the **Demo Setup** agent ([.github/agents/demo-setup.agent.md](../.github/agents/demo-setup.agent.md)) follows this file.

Steps marked **[person]** need the person: signing in, accepting a licence, clicking in a web page or copying a secret.
The agent says exactly what to do, waits, and then checks the result.

The repository holds code only. Every dataset is downloaded from its publisher during setup, onto this computer, and
uploaded to the person's own OneLake. The [README](../README.md) describes what each stage builds.
[patient-360.md](patient-360.md) and [fabric-hosted-discovery.md](fabric-hosted-discovery.md) are the design notes of
the original deployment; names in angle brackets there stand for this deployment's own.

Rough timings: Stage 1 takes about 20 minutes, Stage 2 takes 5 to 6 hours with all the images (about an hour with the
quick sample), Stage 3 about 30 minutes, Stage 4 about 30 minutes, the Discovery tab another 30, and Patient 360 with
Ask about an hour, plus the research pipelines (step 9.1): several hours, mostly downloads and slide tiling. Stages run
one after another; the research pipelines can run in a second terminal while Stages 1 to 4 run.

## 1. Questions to ask first

Ask all of these before running anything, and write the answers into the environment's settings file (step 3.2).

| # | Question | Default | Where the answer goes |
|---|---|---|---|
| 1 | A short name for this environment: letters, digits, `-` or `_`, for example `contoso` | none | `config/settings.<name>.env`, `data/state.<name>.json`, `config/.cohort-env` |
| 2 | The Entra tenant ID, and who in that tenant is a Fabric administrator | | `FABRIC_TENANT_ID` |
| 3 | Which Fabric capacity: its SKU (F4 or larger), Azure region and ID, and whether the person may pause and resume it | | `FABRIC_CAPACITY_ID` |
| 4 | The workspace name (the scripts create the workspace) | `MedicalCohortDemo` | `FABRIC_WORKSPACE` |
| 5 | Imaging: **full** (about 290 GB uploaded, 5 to 6 hours) or a **quick** sample (about 10 GB, about an hour)? | ask | the `09` commands in step 5 |
| 6 | Has the person read and accepted the healthcare data solutions licence? The OMOP vocabularies come from that package (step 6) | must be yes | |
| 7 | Which optional parts to set up: the approval app, the VS Code agents, the local Discovery app, the Discovery tab in Fabric, Patient 360 and Ask (locally, in Fabric), the presentation app | all | |
| 8 | For the Discovery tab and for Ask in Fabric: the Azure subscription, the resource group (new or existing) and its region, a globally unique registry name, and the GitHub account that will own the OAuth Apps | | `DISCOVERY_*` |
| 9 | Patient 360's research data (step 9.1): the 15 TCGA research patients (about 30 GB to download, 60 GB on disk), and the six showcase studies with the CyCIF slide at full resolution (52 GB), half (16 GB) or left out (3 GB)? | ask | step 9.1 |
| 10 | Patient 360's full-size studies and atlas files (scripts `31` and `32`, about 32 GB)? | ask | step 9.1 |
| 11 | Pause the capacity, and stop the Container Apps, whenever work is finished? | yes | |

Check the free disk space against the answers (section 2, *This computer*) before starting.

## 2. Prerequisites

Check each item with the person and note who will do the ones they can't. Tell the person about every item, even the
ones the agent can check itself.

### Accounts and licences

- **Microsoft Fabric:** a capacity (an F SKU; F4 is enough; trial capacities haven't been tried) and permission to
  create workspaces. The person setting up becomes the workspace's admin.
- **Azure:** to pause and resume the capacity, Contributor on the capacity resource. For the Discovery tab and for Ask
  in Fabric, a subscription and resource group where the person is Contributor or Owner (an Azure Container Apps
  environment, two Container Apps and a container registry go there).
- **GitHub Copilot:** a Copilot seat for the person setting up (the VS Code agents, the local Discovery app and Ask on
  this computer). In Fabric, every user of the Discovery tab and of Ask needs a Copilot seat; when an organisation
  grants it, the org must enable the **Copilot CLI** policy (the Copilot SDK runs the Copilot CLI), its model policy
  must allow the models used (both chats start on Claude Opus 5.5 at high thinking; users can pick others), and it may
  need to approve the OAuth Apps if it restricts third-party application access.
- **GitHub:** an account (personal or organisation) to own two GitHub OAuth Apps, one for the Discovery tab and one for
  Ask in Fabric.
- **Healthcare data solutions licence:** running `13_omop_vocabulary.py` downloads part of Microsoft's healthcare data
  solutions package, which means accepting its
  [Microsoft Software License Terms](https://go.microsoft.com/fwlink/?LinkId=2369925). The person reads and accepts
  them; the agent never accepts on their behalf.

### Fabric tenant settings

A Fabric administrator sets these in the Admin portal under Tenant settings. They can take up to 15 minutes to apply.

| Setting | Needed for |
|---|---|
| *Users can access data stored in OneLake with apps external to Fabric* | Every stage: the scripts write the Epic tables, images, documents and the Silver and Gold tables to OneLake from this computer |
| *Semantic models can be queried with the Execute Queries REST API* | Stage 4: the cohort tools and the Discovery tab run DAX through it |
| The Power BI / Fabric IQ MCP server setting | Optional: the Cohort Explorer (DAX) agent in VS Code |
| *Use short-lived user-delegated SAS tokens* (OneLake) | Patient 360 in Fabric: its viewers read files from OneLake through read-only links its functions sign |

Fabric SQL databases, user data functions and Fabric Apps (Project Rayfin) must also be available in the tenant. If
creating `Bronze_PACS` (step 5), publishing the functions (step 7) or `rayfin up` fails with an error that a feature
isn't enabled, ask the Fabric administrator to turn that feature on.

### Entra

Nothing. The demo creates no app registrations; the Discovery tab and Ask identify Fabric users with tickets signed by a
Rayfin secret.

### Azure (Discovery tab and Ask in Fabric)

- The resource providers `Microsoft.App` and `Microsoft.ContainerRegistry` registered in the subscription.
- Azure Policy must allow a container registry with its admin user turned on, and a Container App with public ingress.
  The Container Apps pull their images with the registry's admin credential, because a managed identity would need an
  AcrPull role assignment, and creating role assignments needs Owner or User Access Administrator.

### This computer

- macOS or Linux. Windows hasn't been tried; WSL 2 should behave like Linux. An Apple silicon Mac or a Linux machine
  with 8 or more cores and 32 GB of memory; the CyCIF build holds about 8 GB per worker.
- Python 3.12, the Azure CLI, git, and VS Code with GitHub Copilot (agent mode).
- The GitHub CLI (`brew install gh` on macOS) or the GitHub Copilot CLI, to sign this computer in to GitHub Copilot for
  the local Discovery app and Ask (steps 7 and 9.2).
- OpenSSL 3, for the SQL driver. On macOS: `brew install openssl@3`; the scripts put Homebrew's copy on the library
  path themselves.
- Node.js 20, 22 or 24. The Rayfin CLI rejects other versions, including Node 26. On macOS: `brew install node@24`;
  the scripts find Homebrew's `node@24`, `node@22` or `node@20`, or set `NODE_HOME`. For `npx rayfin` by hand, put it
  first on the path: `PATH=/opt/homebrew/opt/node@24/bin:$PATH`.
- Java 17 or newer, for the research patients' synthetic primary care (Synthea, step 9.1). On macOS:
  `brew install openjdk@21`.
- AzCopy, for Patient 360's file uploads (`brew install azcopy`). It signs in with the Azure CLI.
- Disk, by part (on macOS the copies into `data/generated` are APFS clones and take no extra space; on Linux add the
  last column):

  | Part | Disk | Extra on Linux |
  |---|---|---|
  | Stages 1 to 4 (sources, vocabularies, generated tables; images are deleted after upload) | about 25 GB | |
  | Patient 360 (Bronze copy, index, viewer files for the demo patients) | about 5 GB | |
  | Research patients (`research/patient360/work`) | about 60 GB | 28 GB |
  | Showcase studies (`research/imaging/work`): full CyCIF, half, without it | about 56, 18 or 4 GB | 4 GB |
  | Atlas and full-size studies (`31`, `32`) | about 32 GB | |
  | Optional: viewer files for every online study (`25 --all`) | about 166 GB | |

  Everything except `25 --all` needs about 180 GB free; leave 20 GB more as headroom. Once built, the largest downloads
  can be deleted: `research/patient360/work/raw/slides` (30 GB) after `build_slides.py`, and
  `research/imaging/work/dicom_src` (49 GB) after `build_multiplex.py`.
- Network: PyPI and npm; GitHub (releases and raw files); public AWS and Google Cloud buckets of the NCI Imaging Data
  Commons; api.gdc.cancer.gov and www.cbioportal.org; gin.g-node.org; templateflow.s3.amazonaws.com; data.mendeley.com;
  download.microsoft.com (the vocabularies). No sign-in is needed for any download. If PyPI is reached through a proxy,
  the `s5cmd` wheel may have to be downloaded and installed by file.

```bash
python3.12 --version; az version --query '"azure-cli"' -o tsv; node -v; java -version; openssl version; git --version
azcopy --version; gh --version; df -h .
```

## 3. Prepare this computer

### 3.1 Python

```bash
git clone https://github.com/SanjayNarendran/101-MSFT-public-patient360-conversational.git
cd 101-MSFT-public-patient360-conversational
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

### 3.2 The environment's settings

Settings and state are per environment (a tenant and workspace). Create a named environment:

```bash
NAME=contoso                                        # question 1
cp config/settings.example.env config/settings.$NAME.env
echo $NAME > config/.cohort-env                     # this computer now uses the named environment
```

Fill in `config/settings.$NAME.env`: `FABRIC_TENANT_ID`, `FABRIC_CAPACITY_ID`, `FABRIC_WORKSPACE` and the
`DISCOVERY_*` settings (Discovery tab and Ask in Fabric only). Leave the item names as they are unless the person asks
otherwise.

Every script, the cohort MCP server in VS Code and the local apps read `config/.cohort-env`. `COHORT_ENV=<name>` in
front of a single command overrides it. The scripts save the Fabric item IDs in `data/state.<name>.json`. Git ignores
all three files, because they describe the person's tenant; tell the person to keep a copy of the settings and state
files somewhere safe.

### 3.3 Sign in and start the capacity

```bash
az login --tenant <tenant-id>
az account show --query "{tenant:tenantId,user:user.name,subscription:name}" -o table
az rest --resource https://api.fabric.microsoft.com --url https://api.fabric.microsoft.com/v1/capacities \
  --query "value[].{name:displayName,id:id,sku:sku,region:region,state:state}" -o table
```

If the capacity is paused, resume it (the second command should print `Active`):

```bash
CAP=$(az resource list --name <capacity-name> --resource-type Microsoft.Fabric/capacities --query "[0].id" -o tsv)
az rest --method post --url "https://management.azure.com$CAP/resume?api-version=2023-11-01"
az resource show --ids "$CAP" --query properties.state -o tsv
```

After a resume, allow about 10 minutes before the Fabric apps work: their backend address doesn't resolve for about 3
minutes, and sign-in fails ("Something went wrong") for a few minutes more. The scripts work sooner. To pause it again,
use the same `az rest` command with `/suspend`.

## 4. Stage 1: EHR data

```bash
.venv/bin/python scripts/01_download_sources.py           # Synthea CSVs, IDC metadata, LIDC annotations (~4 GB)
.venv/bin/python scripts/02_generate_epic_data.py         # Clarity + Caboodle tables and imaging cohorts
.venv/bin/python scripts/03_fabric_workspace.py           # workspace + Bronze_Clarity and Bronze_Caboodle lakehouses
.venv/bin/python scripts/05_onelake_load.py               # the 54 tables as Delta tables in those lakehouses
.venv/bin/python scripts/07_verify.py                     # row counts, visible columns, cross-source query
```

Check: `data/generated/clarity/` and `data/generated/caboodle/` hold one `.csv.gz` per table in
`scripts/epic_schema.py`; `data/state.<name>.json` has `workspace_id` and the two lakehouse IDs; `07` ends with "All
tables match the generated files and every column is visible."

- `05` reads each file with DuckDB, typed as `epic_schema.py` declares, and writes it with `omop_etl.write_delta`;
  times are written as UTC timestamps, which the SQL analytics endpoint shows. It overwrites each table, so it can run
  again; `05_onelake_load.py TABLE ...` reloads only those tables. It refreshes each lakehouse's SQL endpoint at the
  end.
- If `07` fails with an invalid object name, the endpoint hasn't caught up yet: wait a minute and run it again (it
  refreshes the endpoint first and retries each table for two minutes).

## 5. Stage 2: imaging and documents

```bash
.venv/bin/python scripts/08_build_pacs_manifest.py        # plan 12,910 studies: 2,398 ONLINE, the rest OFFLINE
```

Then the images. For the **full** set (about 290 GB, 5 to 6 hours at about 15 MB/s; it can be stopped and restarted):

```bash
.venv/bin/python scripts/09_process_dicom.py --workers 24
```

For the **quick** sample (about 10 GB; untested as a set):

```bash
.venv/bin/python scripts/09_process_dicom.py --workers 16 --collection lidc_idri --limit 800   # ~5.8 GB: 53 chest X-rays and ~45 chest CTs, 38 with nodule outlines
for c in tcga_luad tcga_lusc tcga_brca tcga_coad tcga_prad; do
  .venv/bin/python scripts/09_process_dicom.py --workers 16 --collection $c --limit 5          # 25 pathology slides, ~4 GB
done
.venv/bin/python scripts/09_process_dicom.py --workers 16 --collection synthea_coherent --limit 20   # brain MRI, ~0.6 GB
```

With the quick sample, deliveries contain fewer images, cohorts from the lung nodule questions have the most, and some
of Patient 360's demo patients have no images online. Running `09` again later without `--limit` adds the rest.

`09` records each finished series in `data/generated/pacs/instances/`. Those markers belong to this computer and the
workspace it uploaded to: if this computer has already uploaded images for another environment, move that folder
aside before running `09` for a new one, or it skips everything.

```bash
.venv/bin/python scripts/10_pacs_database.py              # Fabric SQL database Bronze_PACS + load the index
.venv/bin/python scripts/11_generate_documents.py         # reports, notes, scans -> Bronze_ClinicalDocuments lakehouse
.venv/bin/python scripts/12_verify_stage2.py              # cross-source joins, coverage and archive spot checks
```

Run `10` after `09` finishes; studies without uploaded images are indexed as OFFLINE. Fabric replicates the PACS
database to OneLake a few minutes after `10`; `12` waits for it. SQL error 4891 during `10` is retried automatically.

## 6. Stage 3: Silver (OMOP) and Gold (i2b2)

**[person]** Confirm the healthcare data solutions licence (question 6) before `13`.

```bash
.venv/bin/python scripts/13_omop_vocabulary.py            # OMOP vocabularies from the HDS package (~1 GB download)
.venv/bin/python scripts/14_silver_omop.py --upload       # Bronze -> OMOP CDM v5.4 -> Silver_OMOP lakehouse
.venv/bin/python scripts/15_gold_i2b2.py --upload         # OMOP -> i2b2 star schema + ontology -> Gold_i2b2
.venv/bin/python scripts/16_fabric_notebooks.py           # Silver_OMOP_Build / Gold_i2b2_Build notebooks
.venv/bin/python scripts/17_verify_stage3.py              # row counts, concept coverage, OMOP vs i2b2 cohort
```

`15` also writes the local i2b2 copy in `data/generated/i2b2/`, which `21_verify_stage4.py` checks counts against. The
output is deterministic: the study question finds 358 patients.

## 7. Stage 4: semantic models, cohort store and the approval app

```bash
.venv/bin/python scripts/18_semantic_models.py            # Cohort Discovery (i2b2) + Research Data (OMOP) semantic models
.venv/bin/python scripts/19_cohort_store.py               # Cohort_Requests SQL database: i2b2 CRC tables, request tables, views
.venv/bin/python scripts/20_cohort_app.py                 # user data functions, Cohort Requests model, dashboard template, delivery notebook
.venv/bin/python scripts/21_verify_stage4.py              # DAX vs SQL query checks, MCP tools, requests model
.venv/bin/python scripts/22_approval_app.py               # approval app (Fabric App, Rayfin): configure, npm install, rayfin up
```

- **[person]** The first `22` opens a browser to sign in to the Rayfin CLI. It deploys `cohort-approval` into the
  workspace and saves its address in `data/state.<name>.json`.
- **[person]** Open the app's address and sign in with the Fabric account. Fabric opens the sign-in in a popup, so
  allow popups for the address.
- `20` publishes user data functions; Fabric allows one publish about every two minutes, and `20` waits and retries.
- `21_verify_stage4.py --e2e` runs a test request through submit, approval and delivery and removes what it created.
- Other people who use the apps need a role in the workspace (Viewer at least). The approval app records a decision
  under the user's name by looking up their ID in the workspace's role assignments.
- If signing in to the app fails with a redirect URI error, add the app's address to `services.auth.allowedRedirectUris`
  in `apps/approval/rayfin/rayfin.yml` and run `22` again.

### VS Code agents

Open the repository folder in VS Code. `.vscode/mcp.json` registers the **cohort-discovery** MCP server (this
repository's `scripts/cohort_mcp.py`, which uses `config/.cohort-env`) and **FabricIQ** (Microsoft's hosted MCP server,
for the optional DAX agent). Start them from the MCP view, then pick the **Cohort Discovery** agent in Copilot Chat.
Both use the `az login` identity. The GitHub Copilot CLI reads `.mcp.json` at the repository root instead, which
registers FabricIQ for it. The Cohort Explorer (DAX) agent names the `MedicalCohortDemo` workspace in
`.github/agents/cohort-explorer-dax.agent.md`; with another workspace name, change it in that file.

### Local Discovery app

**[person]** Sign in to GitHub Copilot on this computer once, with the GitHub CLI (`gh auth login`) or the Copilot CLI
(`copilot login`), using the GitHub account that has the Copilot seat. Then:

```bash
.venv/bin/python apps/discovery/app.py                    # http://127.0.0.1:8766
```

The Copilot SDK downloads its Copilot runtime on the first run.

## 8. Stage 4e: the Discovery tab in Fabric (optional)

The tab runs the Discovery chat inside the approval app. GitHub Copilot runs in an Azure Container App (the relay,
`apps/discovery/relay`), each user signs in to GitHub in the tab, and every question uses that user's own Copilot plan.
The tools run in the app's Rayfin Functions. [fabric-hosted-discovery.md](fabric-hosted-discovery.md) explains the
design. Ask in Fabric (step 9.4) uses the same Container Apps environment and registry, so run 8.1 for it too.

Each piece needs another's address, so the order matters: the approval app first (step 7), then the Container App,
then the GitHub OAuth App, then the relay image, then the approval app again.

### 8.1 Azure resources

Fill in `DISCOVERY_RESOURCE_GROUP`, `DISCOVERY_LOCATION` (an Azure region such as `centralus`, ideally the
capacity's), `DISCOVERY_ENVIRONMENT`, `DISCOVERY_CONTAINER_APP` and `DISCOVERY_REGISTRY` in the settings file first.
These lines load them into the shell; later steps (and step 11) start with them too:

```bash
NAME=$(cat config/.cohort-env)
eval "$(grep -E '^DISCOVERY_[A-Z_]+=' config/settings.$NAME.env)"
RG=$DISCOVERY_RESOURCE_GROUP; APP=$DISCOVERY_CONTAINER_APP; LOC=$DISCOVERY_LOCATION
```

Then create the resources:

```bash
az account set --subscription <subscription-id>
az provider register -n Microsoft.App --wait
az provider register -n Microsoft.ContainerRegistry --wait
az group create -n $RG -l $LOC --tags project=cohort-discovery -o none            # skip if it already exists
az containerapp env create -g $RG -n $DISCOVERY_ENVIRONMENT -l $LOC --logs-destination none \
  --tags project=cohort-discovery -o none
az containerapp create -g $RG -n $APP --environment $DISCOVERY_ENVIRONMENT \
  --image mcr.microsoft.com/k8se/quickstart:latest --ingress external --target-port 80 \
  --cpu 1 --memory 2Gi --min-replicas 0 --max-replicas 1 --tags project=cohort-discovery -o none
FQDN=$(az containerapp show -g $RG -n $APP --query properties.configuration.ingress.fqdn -o tsv); echo https://$FQDN
APPROVAL_URL=$(.venv/bin/python -c "import json;print(json.load(open('data/state.$NAME.json'))['approval_app']['url'])")
```

The placeholder image gives the app its address; `23_discovery_chat.py deploy` replaces it. `23` creates the registry
itself.

### 8.2 GitHub OAuth App [person]

On github.com: **Settings → Developer settings → OAuth Apps → New OAuth App** (for an organisation, the organisation's
settings).

- Application name: for example *Cohort Discovery (Fabric)*. Users see it when they authorise the app.
- Homepage URL: the approval app's address (`$APPROVAL_URL`).
- Authorization callback URL: `https://$FQDN/auth/github/callback`. Where the form takes several, also add
  `http://127.0.0.1:8770/auth/github/callback` for running the relay on this computer
  (`23_discovery_chat.py local`).
- Leave device flow off and "Expire user access tokens" on.

Register it and give the agent the **Client ID** (it isn't secret). Then generate a client secret. GitHub shows it only
once, and it must not appear in the agent's transcript: the person stores it in the Container App themselves, in
their own terminal, with the `$RG` and `$APP` values the agent gives them:

```bash
read -rs GH_SECRET     # paste the client secret, then press Enter (nothing is shown)
az containerapp secret set -g <resource-group> -n <container-app> --secrets github-client-secret="$GH_SECRET" -o none
unset GH_SECRET
```

On macOS the person can instead click the secret's copy button and let the agent run
`az containerapp secret set ... --secrets github-client-secret="$(pbpaste)"` followed by `pbcopy < /dev/null`.
Browser automation must not be on the page that shows the secret: tools that snapshot the page copy everything on it
into the transcript.

### 8.3 Container App settings

The chat ticket key is generated without being shown:

```bash
az containerapp secret set -g $RG -n $APP -o none \
  --secrets chat-ticket-key="$(.venv/bin/python -c 'import secrets;print(secrets.token_urlsafe(32))')"
az containerapp update -g $RG -n $APP -o none --set-env-vars \
  GITHUB_CLIENT_ID=<client-id> \
  GITHUB_CLIENT_SECRET=secretref:github-client-secret \
  CHAT_TICKET_KEY=secretref:chat-ticket-key \
  "ALLOWED_ORIGIN=$APPROVAL_URL,http://localhost:5173,http://127.0.0.1:5173" \
  PUBLIC_URL=https://$FQDN
az containerapp ingress cors enable -g $RG -n $APP -o none \
  --allowed-origins "$APPROVAL_URL" http://localhost:5173 http://127.0.0.1:5173 \
  --allowed-methods GET POST OPTIONS --allowed-headers authorization content-type x-chat-ticket --max-age 3600
```

Run Container App changes one after another; two at once fail. If an update leaves the app stuck in `InProgress`,
every later change fails: delete the app and create it again with the same name (the address stays the same), then
store the GitHub client secret again (8.2) and repeat 8.3 and `23_discovery_chat.py deploy`.

### 8.4 Deploy

```bash
.venv/bin/python scripts/23_discovery_chat.py deploy          # registry (admin user), image build in Azure, roll the app, /healthz
.venv/bin/python scripts/23_discovery_chat.py set-app-secret  # copy the chat ticket key into the approval app's Rayfin secrets
.venv/bin/python scripts/22_approval_app.py                   # redeploy the approval app with the relay's address
```

Check:

```bash
curl -s https://$FQDN/healthz                                 # {"ok":true,...}
```

**[person]** Then open `$APPROVAL_URL/#/discovery`, select **Sign in with GitHub**, authorise the OAuth App, and ask a
starter question. The ontology on the left loads from the semantic model, the steps stream into the chat, and the
query and its counts appear on the right. The relay keeps GitHub sign-ins in memory, so users sign in again after the
Container App restarts or scales to zero.

## 9. Stage 6: Patient 360 and Ask (optional)

Patient 360 (`apps/patient360`) shows one patient's whole record, read where each part lives, with the CT, MRI, X-ray,
slide, document and genome viewers on one timeline. Ask is its conversation with GitHub Copilot about one patient or
many, answered with the same viewers. Both run on this computer without a capacity, and in Fabric as the Fabric App
`patient-360` with the relay `patient360-chat`. [patient-360.md](patient-360.md) is the design and build log;
[apps/patient360/chat/TESTING.md](../apps/patient360/chat/TESTING.md) is how Ask is tested.

### 9.1 Data

Stage 2 must have run (the PACS index, the imaging archive and the documents). Then:

```bash
.venv/bin/python scripts/24_patient360_data.py                 # Bronze copy, patient index and demo patients, locally
.venv/bin/python scripts/25_patient360_viewers.py              # viewer files for the demo patients (about 2 GB, 15 minutes)
```

`24` prints the number of patients, how many have two or more kinds of image online, and `27 demo patients`; it warns
about any demo patient missing from the index. `25` is resumable and skips what it has built. `25 --all` builds every
online study instead (2,153 series, about 166 GB; with `--jobs 8` on an Apple silicon laptop it took about 4 hours).

**The 15 TCGA research patients** (question 9): genomes, slides, CT and MRI with AI segmentations, scanned pathology
reports and a synthetic primary-care history. The research pipeline downloads them from their publishers
([research/README.md](../research/README.md) lists every source and licence); it can run in a second terminal while
Stages 1 to 4 run:

```bash
.venv/bin/python research/patient360/pipeline/run_all.py       # about 30 GB of downloads, then hours of slide tiling
.venv/bin/python scripts/26_patient360_import.py --from-local  # copy research/patient360/work into data/generated/research
.venv/bin/python scripts/29_patient360_genomics.py             # genomes of the hospital slides' TCGA cases
.venv/bin/python scripts/24_patient360_data.py --index-only    # add them to the index
```

`run_all.py` prints `=== done` at the end; a failed step stops it, and running it again resumes. The hospital
patients' biopsy slides are TCGA slides, and those TCGA cases were sequenced. `29` downloads their genomes from
cBioPortal (the PanCancer Atlas studies) and the immune landscape files from the GDC (about 2 minutes, cached in
`data/raw/tcga_genomics`), and merges them into the research genomics tables. It prints `Genomes for 755 crosswalk
cases`; `24` then links 681 patients to 756 genomes (`p360_genome`). Run `29` again after `26 --from-local`, which
replaces those tables; the rerun reads its downloads from the cache. Without the research patients, skip these four
commands: Patient 360 then shows the hospital's patients only.

**The six showcase studies** on two demo patients: Stephan Rutherford a whole-body FDG PET/CT, a breathing 4D CT and a
brain-wiring atlas; Ivelisse Nitzsche a TCGA breast slide with AI layers, a fetal brain atlas and a 36-plex
immunofluorescence (CyCIF) slide. The imaging pipeline downloads them from their publishers; `30` copies the built
studies (about 4 GB) and lists them in `p360_showcase`:

```bash
.venv/bin/python research/imaging/pipeline/run_all.py          # add --cycif-half or --skip-cycif (question 9)
.venv/bin/python scripts/30_patient360_showcase.py --from-local
.venv/bin/python scripts/31_patient360_tractography.py         # the brain-wiring atlas in full (question 10)
.venv/bin/python scripts/32_patient360_fullsize.py download    # three studies in full (30 GB; question 10)
.venv/bin/python scripts/32_patient360_fullsize.py build
.venv/bin/python scripts/24_patient360_data.py --index-only    # the list's counts
```

`30` prints each study with its patient and size; a study the pipeline didn't build (`--skip-cycif`) is left out.
Without the imaging pipeline, skip these commands: those two records show their own hospital images only. `31`
downloads every file the brain-wiring atlas's publisher offers (about 1.7 GB, CC BY-SA 4.0, into `data/raw/hcp1065`),
then adds its 87 bundles (each one's lines, reach, cortical areas and volume across 1,065 people), probability maps and
figures to the study; it takes about a minute after the download. Check: it ends with `brain-tractography now carries
87 bundles`. `30` runs it again whenever it copies the studies.

`32` downloads three of the studies in full from their publishers (about 30 GB into `data/raw/idc` and
`data/raw/dhcp_fetal_atlas`; check the free disk space first): every series of the 4D-Lung patient (9.3 GB, including
33 treatment-day cone-beam CTs), the PET/CT study (0.3 GB) and the whole dHCP fetal atlas (20.6 GB). `build` (about
three minutes) adds full-size versions of the PET/CT and the planning 4D CT (the viewer's *Full size* button), the
cone-beam CTs as a study of their own, and the fetal atlas's T1 and diffusion layers. Check: it ends with
`p360_showcase: 7 studies`. `30` runs `build` again whenever it copies the studies.

### 9.2 On this computer

```bash
cd apps/patient360
export PATH=/opt/homebrew/opt/node@24/bin:$PATH                # Node 20, 22 or 24
npm install --legacy-peer-deps
npm run dev:local                                              # http://localhost:5178
```

In a second terminal, from the repository root, start Ask's chat server. It uses this computer's GitHub Copilot
sign-in (`gh auth login` or `copilot login`), chosen in the page:

```bash
.venv/bin/python apps/patient360/chat/server.py                # port 8771; the app reaches it at /chat-api
```

Check: the Patients page lists the demo patients first; Levi Hills's record opens with his CT and its ten nodules; the
Ask tab answers a starter question with the viewers in the answer. The evaluation runs every starter question and more
through the page (about 20 minutes with five at a time; it needs Google Chrome and Playwright,
`.venv/bin/pip install playwright`; `--gpu` draws the tractography and fluorescence cards on the GPU):

```bash
.venv/bin/python apps/patient360/chat/dev/eval.py --jobs 5 --gpu   # report and screenshots in /tmp/p360-eval
```

### 9.3 Fabric

The capacity must be running.

```bash
.venv/bin/python scripts/25_patient360_viewers.py --upload-only       # viewer files to Patient360/Files/viewer
.venv/bin/python scripts/26_patient360_import.py --upload-local       # the research silos (about 28 GB)
.venv/bin/python scripts/29_patient360_genomics.py --fabric           # the genomics silo with the slides' genomes
.venv/bin/python scripts/30_patient360_showcase.py --fabric           # the six showcase studies (about 4 GB)
.venv/bin/python scripts/31_patient360_tractography.py --fabric       # the atlas's downloads to Files/raw/hcp1065 (1.7 GB)
.venv/bin/python scripts/32_patient360_fullsize.py --fabric           # the full downloads to Files/raw (30 GB) and the studies
.venv/bin/python scripts/24_patient360_data.py --index-only --fabric  # index, demo, genome links, time columns, inventory
.venv/bin/python scripts/27_patient360_app.py                         # deploy the Fabric App patient-360
```

Skip the lines for the parts left out in 9.1.

- `25 --upload-only` creates the lakehouse `Patient360` and copies the viewer files (about a minute).
- `26 --upload-local` creates `Bronze_Oncology_Clinical`, `Bronze_Oncology_Genomics` and `Bronze_Oncology_Imaging`,
  writes their tables and uploads their files; the slides make it about 28 GB.
- `25 --upload-only` after `25 --all` copies about 166 GB (2 million files); azcopy skips files already there. From
  a home connection it took about 45 minutes. If the capacity pauses during the copy, azcopy reports
  `404 Not Found. When Committing block list` for the rest; resume the capacity, then retry only the failed files with
  `AZCOPY_AUTO_LOGIN_TYPE=AZCLI azcopy jobs resume <job id> --trusted-microsoft-suffixes=onelake.blob.fabric.microsoft.com`
  and run `25 --upload-only` again to write the viewer index it didn't reach (azcopy checks every file again first).
- `29 --fabric` overwrites the tables of `Bronze_Oncology_Genomics` with the merged local copy (the fifteen research
  patients' rows and the 755 new genomes). Run it after `26`.
- `30 --fabric` uploads the studies to `Patient360/Files/viewer/<patient>/showcase` and writes `p360_showcase` and
  `p360_showcase_part` (each study's metadata in parts, as the SQL endpoint caps a string at 8,000 characters).
- `24 --fabric` writes the index, the demo patients, each hospital patient's genomes (`p360_genome`), the time columns
  the SQL endpoint can't show (section 12) and an inventory of every source item's size in OneLake (about 10 minutes).
  Run it after `25`, `26`, `29` and `30`, and again after files change. The app reads the index's list columns, so
  deploy `27` after it.
- `27` writes the functions' coordinates, deploys, saves the address as `patient360_app` in the state file and moves
  the app and `Patient360` into the folder *Patient 360* (`PATIENT360_FOLDER`).
- If signing in fails with a redirect URI error, add the app's address to `services.auth.allowedRedirectUris` in
  `apps/patient360/rayfin/rayfin.yml` and run `27` again.

Check **[person]**: open the address `27` printed and sign in. The patient list shows the demo patients; a record
opens with its timeline and tabs; a CT opens in its viewer (files from OneLake); *Where the data lives* lists every
source with its row counts and sizes. Ask says it isn't set up yet until 9.4.

### 9.4 Ask in Fabric

Ask's relay runs in the Container Apps environment and registry of the Discovery tab, so 8.1 must have run (`28
deploy` creates the registry if `23` hasn't). Its name is `PATIENT360_CHAT_APP` in the settings file (default
`patient360-chat`).

```bash
.venv/bin/python scripts/28_patient360_chat.py create         # the Container App and its chat ticket key
```

`create` prints the relay's address and the values for the GitHub OAuth App.

**[person]** Create the OAuth App as in 8.2: name *Patient 360 (Fabric)*, homepage the app's address, callback
`https://<relay>/auth/github/callback`. Give the agent the Client ID. Generate a client secret and store it in the
Container App the same way as in 8.2, with `-n patient360-chat`; it must not appear in the agent's transcript. Then:

```bash
.venv/bin/python scripts/28_patient360_chat.py configure --client-id <client-id>   # settings, allowed origins, CORS
.venv/bin/python scripts/28_patient360_chat.py deploy         # image build in Azure, roll the app, /healthz
.venv/bin/python scripts/28_patient360_chat.py set-app-secret # the chat ticket key into the app's Rayfin secrets
.venv/bin/python scripts/27_patient360_app.py                 # redeploy with the relay's address
```

Check: `curl -s https://<relay>/healthz` answers `{"ok":true,"mode":"relay",...}`. **[person]** In the app, open
**Ask**, select **Sign in with GitHub** and authorise the OAuth App, then ask a starter question: the steps stream in
and the answer shows the record's viewers; it is saved under *Your chats*, private to each user, in the app's Rayfin
database.

## 10. The presentation

`presentation/` is a static page. Open `presentation/index.html` in a browser, or serve it:

```bash
python3 -m http.server 8792 --directory presentation      # http://127.0.0.1:8792
```

To publish it as the Fabric App `cohort-presentation` (viewers sign in with their Fabric account):

```bash
cd apps/presentation
export PATH=/opt/homebrew/opt/node@24/bin:$PATH             # Node 20, 22 or 24
npm install
npx rayfin up --workspace-id <workspace-id> --tenant <tenant-id> --yes   # first time: creates the Fabric item
npm run deploy:static                                       # later changes
cd ../..                                                    # back to the repository root
```

The workspace ID is `workspace_id` in `data/state.<name>.json`. The presentation's app screens are replicas with
stand-in names and addresses (`researcher@contoso.com`, `contoso-…` hosts), and its section 01 shows the places Epic
tables can live in production (SQL Server, Snowflake, Azure Databricks, another workspace); this demo writes them
straight into OneLake. If sign-in fails with a redirect URI error, add the published address to
`apps/presentation/rayfin/rayfin.yml` and deploy again.

## 11. Running the demo

Before:

1. Resume the capacity (step 3.3) and wait about 10 minutes.
2. Discovery tab: load the names (the first lines of 8.1), start the Container App and keep one replica running so it
   answers at once:

   ```bash
   az rest --method post --url "https://management.azure.com$(az containerapp show -g $RG -n $APP --query id -o tsv)/start?api-version=2024-03-01"
   az containerapp update -g $RG -n $APP --min-replicas 1 -o none
   ```

3. Patient 360's Ask: the same two commands with `APP=patient360-chat`.
4. Open the apps and sign in (Fabric, then GitHub in the Discovery tab and in Ask).

A demo can run: the presentation, the workspace (Bronze, Silver, Gold), a question in the Discovery tab or the local
app, **Submit request**, approval on the **Requests** tab with delivery in demo mode (about two minutes), the
delivery's `Explore_QM<id>_<title>` notebook, then Patient 360 and its Ask tab.

After: set the minimum replicas back to 0, stop the Container Apps (the same `az rest` command with `/stop`), and pause
the capacity.

## 12. Pitfalls

- On macOS, scripts that use the SQL driver restart Python with Homebrew's OpenSSL on the library path. A script fed
  through standard input (a heredoc) then runs nothing: save it to a `.py` file first. Output printed before the
  restart is lost, so use `PYTHONUNBUFFERED=1`. Ad-hoc code that calls `cohort_store.connect()` must call
  `common.ensure_openssl()` first.
- A paused capacity shows up as "This Fabric capacity ... is currently not available", or a notebook that fails within a
  minute and writes no error file.
- New Delta tables don't appear on a SQL analytics endpoint until its metadata is refreshed; every script that writes
  tables does that.
- A notebook run's error is in `Files/etl_runs/<name>_error_<time>.json` of its lakehouse; `16 --run` prints it.
- `npm install` in the approval app and in Patient 360 needs `--legacy-peer-deps` (npm 10 bug); `22` and `27` use it.
- Rayfin functions find their context parameter by its literal `RayfinContext<...>` annotation; a type alias breaks
  the function ("MissingInput: Parameter not found").
- The Rayfin client hands a function's JSON text back already parsed; page code accepts a string or an object.
- Lakehouse SQL analytics endpoints leave out `timestamp_ntz` columns, which is what pandas writes for naive
  datetimes. Queries through an endpoint then fail with "Invalid column name". `05_onelake_load.py` and
  `common.write_tables` write dates and UTC timestamps instead, and Patient 360 reads the Epic and document times from
  `Patient360.dbo.p360_time_<table>` (`24 --fabric`), which works either way.
- In T-SQL `TIMESTAMP` is rowversion; cast to `DATETIME2`.
- `rayfin up` needs the functions' `host.json`, which git ignores; `22` and `27` write it when it's missing.
- A request dashboard (with `APPROVAL_UI=powerbi`) shows a credentials error after its model is redeployed: run `20`
  again.
- `build_multiplex.py` (the CyCIF slide) is killed or runs out of memory: run it again with `--workers 1`.
- `build_synthea.py` fails to start: install Java 17 or newer, and run `download_sources.py` again for the Synthea jar.

## 13. Costs

- Fabric: the capacity, while it runs. Building everything uses a few percent of a day of F4. Pause it when idle.
- OneLake storage: about 300 GB with all images, about 20 GB with the quick sample. Patient 360 adds about 31 GB (the
  research patients' slides and volumes, the showcase studies and the viewer files), and `31` and `32` about 32 GB.
- Azure: the Basic registry costs about $5 a month. Each Container App (the Discovery relay, Ask's relay) costs nothing
  while stopped or scaled to zero, and up to about $2.60 a day with one replica running (1 vCPU, 2 GiB, list price).
- GitHub Copilot: usage is billed to each user's own plan.
