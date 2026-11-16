/* The Fabric platform figure: GitHub Copilot and Microsoft Foundry above Fabric, the workloads in one strip, the
   platform services under them, OneLake along the bottom and seven kinds of source below it. Two-way arrows join the
   tools above and the sources below to Fabric. Selecting a part (click, or ← → to step through while presenting)
   explains it in the pane beside the figure and steps back the parts it doesn't touch.
   Descriptions follow Microsoft Learn (Fabric overview, OneLake shortcuts, mirroring, Fabric IQ, Foundry's Fabric IQ
   tool, GitHub Copilot with Fabric notebooks), the Fabric MCP server README and the Rayfin SDK docs; "In this demo"
   notes use the numbers in this repository's README. */
(function () {
  'use strict';

  const ICON = 'assets/icons/';
  const TOP = ['github-copilot', 'foundry'];
  const SOURCES = ['azure', 'amazon-s3', 'google-cloud', 'dataverse', 'databricks', 'snowflake', 'on-premises'];
  const WORKLOADS = ['databases', 'data-factory', 'analytics', 'real-time-intelligence', 'power-bi', 'iq', 'rayfin'];

  // Each part is explained the same way, so every entry fills the pane alike: what it is (three or four lines), three
  // facts and one note. The note says where the part appears in this demo (`demo`) or, for parts the demo doesn't use,
  // gives a healthcare example (`health`). `link` points the note at a section further down. Selecting a part lights
  // only that part; OneLake also lights the sources joined to it.
  const PARTS = [
    {
      id: 'fabric', kind: 'brand', group: 'The platform', name: 'Microsoft Fabric', icon: 'fabric.svg',
      what: 'Microsoft’s software‑as‑a‑service data platform. Data integration, engineering, warehousing, data science, real‑time analytics and BI are workloads in the same service, and all of them store data in OneLake.',
      facts: [['Delivered as', 'A cloud service; Microsoft runs the servers and installs the updates'], ['Capacity', 'Workloads draw on a shared pool of compute, sized as an F SKU, that can be paused'], ['Security', 'Microsoft Entra ID sign‑in, with roles and permissions set per workspace and item']],
      demo: 'The demo uses one workspace, <b>MedicalCohortDemo</b>, for the Epic tables, the PACS database, the DICOM archive and the clinical documents.',
    },

    {
      id: 'azure', kind: 'source', group: 'Source', name: 'Azure ADLS', icon: 'azure-storage.svg',
      what: 'Azure Data Lake Storage Gen2 is Azure’s storage service for analytics, with a hierarchical file system and access control lists. Many organizations keep their existing data lakes in it.',
      facts: [['Shortcut', 'Containers and folders show up in OneLake and are read from ADLS directly'], ['Blob Storage', 'Azure Blob Storage containers can be added as shortcuts in the same way'], ['Same APIs', 'OneLake is built on ADLS and supports its APIs, which existing tools already use']],
      demo: 'The demo uploads its 289 GB of DICOM images and its documents into lakehouses. Kept in ADLS, the same folders would be added to those lakehouses as shortcuts.',
    },
    {
      id: 'amazon-s3', kind: 'source', group: 'Source', name: 'Amazon S3', icon: 'amazon-s3.svg',
      what: 'Amazon’s object storage service in AWS, where many data lakes and public research datasets are kept. A shortcut adds an S3 bucket to OneLake, and Fabric reads the files from AWS.',
      facts: [['Shortcut', 'S3 buckets and S3‑compatible stores appear in OneLake and are read from AWS'], ['Caching', 'OneLake can cache files it has read, which lowers repeat cross‑cloud transfer costs'], ['Private buckets', 'Buckets behind a VPC are reached through the on‑premises data gateway']],
      demo: 'The Synthea patients and the LIDC and TCGA images came from public S3 buckets. They were downloaded because their DICOM headers had to be rewritten for the Epic patients.',
    },
    {
      id: 'google-cloud', kind: 'source', group: 'Source', name: 'Google Cloud', icon: 'google-cloud-storage.svg',
      what: 'Google’s cloud platform, with files in Cloud Storage and warehouse tables in BigQuery. Fabric reaches Cloud Storage with a shortcut and BigQuery with mirroring.',
      facts: [['Shortcut', 'Cloud Storage buckets appear in OneLake, with optional caching of files read'], ['Mirroring', 'BigQuery tables are replicated into OneLake and updated as they change'], ['Private buckets', 'Buckets behind a firewall are reached through the on‑premises data gateway']],
      demo: 'NCI Imaging Data Commons, where the demo’s images come from, publishes them on Google Cloud as well as AWS and keeps its metadata in BigQuery. The demo used the AWS copies.',
    },
    {
      id: 'dataverse', kind: 'source', group: 'Source', name: 'Dataverse', icon: 'dataverse.svg',
      what: 'The data platform behind Dynamics 365 and Power Apps. With Link to Fabric, Dataverse tables are available in OneLake as shortcuts, and the data itself stays in Dataverse storage.',
      facts: [['Link to Fabric', 'Dynamics 365 and Power Apps tables appear in a Fabric lakehouse as shortcuts'], ['Security', 'Data stays inside Dataverse’s security boundary; authorized users read it in Fabric'], ['Round trip', 'Power Apps and Power Automate flows can act on the results of analysis in Fabric']],
      health: 'Microsoft’s healthcare data model for Dataverse is based on HL7 FHIR. Care management apps built on it could be linked to the clinical and imaging data in OneLake.',
    },
    {
      id: 'databricks', kind: 'source', group: 'Source', name: 'Databricks', icon: 'databricks.svg',
      what: 'A lakehouse platform for Spark and Delta Lake, with Unity Catalog managing its tables. Fabric reads Unity Catalog tables from their Databricks storage, so both platforms use the same files.',
      facts: [['Mirroring', 'A Unity Catalog is mirrored as metadata, and its tables appear as shortcuts'], ['Storage', 'The Delta files stay in Databricks storage; Fabric receives only the catalog'], ['Sync', 'New schemas and tables in the catalog can be added to Fabric automatically']],
      health: 'A research team’s feature tables in Unity Catalog could be used in the same semantic model as the EHR and imaging data, read from the same Delta files.',
    },
    {
      id: 'snowflake', kind: 'source', group: 'Source', name: 'Snowflake', icon: 'snowflake.svg',
      what: 'A cloud data warehouse. Snowflake and Fabric both read and write Apache Iceberg tables, so a table written by one of them can be read by the other from the same files.',
      facts: [['Mirroring', 'Snowflake tables are replicated into OneLake and updated as they change'], ['Iceberg', 'Snowflake writes Iceberg tables into OneLake, and Fabric reads them as Delta'], ['Region', 'Writing to OneLake requires a Fabric capacity in Snowflake’s Azure region']],
      health: 'A hospital that keeps its Epic Clarity and Caboodle tables in Snowflake could have Snowflake write them to OneLake as Iceberg for Fabric to read through shortcuts.',
      link: 'unification',
    },
    {
      id: 'on-premises', kind: 'source', group: 'Source', name: 'On‑premises', icon: 'on-premises.svg',
      what: 'Databases and file stores in a company’s own data center or behind a firewall. An on‑premises data gateway, installed on that network, carries Fabric’s connections to them.',
      facts: [['Gateway', 'Pipelines, dataflows and some shortcuts connect through the data gateway'], ['Mirroring', 'SQL Server 2016 to 2025 and Oracle databases can be mirrored into OneLake'], ['Shortcuts', 'S3‑compatible storage on site can be read through a shortcut, with caching']],
      health: 'Epic’s Clarity and Caboodle reporting databases usually run on SQL Server in the hospital’s data center. In this demo, synthetic tables written straight into OneLake take their place.',
    },

    {
      id: 'onelake', kind: 'lake', group: 'Fabric platform', name: 'OneLake', icon: 'onelake.svg', tag: 'Storage for every workload',
      what: 'The data lake that comes with every Fabric tenant, built on Azure Data Lake Storage. Every Fabric workload stores its data in OneLake, as Delta or Iceberg tables and as files.',
      facts: [['Shortcuts', 'Links to data in other clouds and lakes; Fabric reads the data from its source'], ['Mirroring', 'Replicates operational databases into OneLake and keeps the replicas current'], ['Security', 'Access can be limited by folder, row and column, and every engine applies the limits']],
      demo: 'OneLake holds the 54 Epic tables, 289 GB of DICOM images, 17,910 clinical documents and the replica of the PACS database.',
      link: 'unification', lit: ['onelake', ...SOURCES],
    },
    {
      id: 'governance', kind: 'svc', group: 'Fabric platform', name: 'Governance', icon: 'governance-purview.svg', tag: 'OneLake catalog and Purview',
      what: 'Tools for finding Fabric items and controlling who can use them. The OneLake catalog shows each item’s owner and governance status, and Microsoft Purview protects sensitive data.',
      facts: [['OneLake catalog', 'Search and explore items; the Govern tab rates the estate and suggests fixes'], ['Purview', 'Sensitivity labels stay with the data, and DLP policies and audit logs cover Fabric'], ['Domains', 'Workspaces are grouped by business area, each with its own admins and settings']],
      demo: 'The apps’ functions run as the signed‑in user, so the workspace’s roles decide what each person reads. Patient 360 streams files through short‑lived, read‑only links scoped to one patient’s folders.',
    },
    {
      id: 'copilot', kind: 'svc', group: 'Fabric platform', name: 'Copilot', icon: 'copilot.svg', tag: 'Assistant in each workload',
      what: 'An AI assistant built into each Fabric workload. It writes and explains SQL, KQL and DAX, generates and fixes notebook code, creates dataflow steps and report pages, and summarizes data.',
      facts: [['Notebooks', 'Writes, refactors and fixes Spark code, and explains the errors it finds'], ['Power BI', 'Suggests report pages and visuals, writes DAX, and answers questions about a model'], ['Security', 'Runs within the Azure security boundary and sees only data the user can access']],
      health: 'An analyst could ask Copilot for the SQL that joins encounters to imaging orders, or for a report page on screening volumes, and check it before using it.',
    },

    {
      id: 'databases', kind: 'tile', group: 'Workload', name: 'Databases', icon: 'databases.svg', tag: 'SQL database and Cosmos DB',
      what: 'Transactional databases for applications, run as a service inside Fabric. Each database is mirrored into OneLake automatically, and its tables can be queried for analytics straight away.',
      facts: [['SQL database', 'Based on Azure SQL Database, for relational apps, with vector types for AI'], ['Cosmos DB', 'A distributed NoSQL database for apps that need scale and steady latency'], ['SQL endpoint', 'Each database has a read‑only SQL analytics endpoint for reports and queries']],
      demo: '<b>Bronze_PACS</b> is a Fabric SQL database with 12,910 studies, 41,987 series and 262,171 DICOM instances. It joins to Epic on accession number.',
    },
    {
      id: 'data-factory', kind: 'tile', group: 'Workload', name: 'Data Factory', icon: 'data-factory.svg', tag: 'Pipelines and dataflows',
      what: 'Fabric’s data integration workload. It connects to more than 170 sources, moves and transforms data, and schedules the jobs that keep it current, as low‑code dataflows or in Apache Airflow.',
      facts: [['Pipelines', 'Schedule and orchestrate copies, notebooks, stored procedures and other jobs'], ['Dataflow Gen2', 'Data is shaped in Power Query, the same editor used in Excel and Power BI'], ['Copy job', 'Bulk or incremental copies between clouds, configured as a single item']],
      demo: 'An approved data request starts the Cohort_Delivery_Pipeline, which runs the notebook that builds the request’s delivery lakehouse.',
      link: 'data-delivery',
    },
    {
      id: 'analytics', kind: 'tile', group: 'Workload', name: 'Analytics', icon: 'analytics.svg', tag: 'Lakehouse and warehouse',
      what: 'Data engineering, data warehousing and data science in Fabric. Spark notebooks, T‑SQL queries and Python models all work on the same Delta tables in OneLake.',
      facts: [['Lakehouse', 'Files and Delta tables, processed with Spark and queried with T‑SQL'], ['Warehouse', 'A T‑SQL data warehouse with transactions that can span several tables'], ['Data science', 'Models are trained and tracked with MLflow, then used to score data in batch']],
      demo: 'Five <b>Bronze_</b> lakehouses hold the Epic tables, the DICOM archive and the documents, and one SQL query can join Epic, PACS and the documents.',
      link: 'medallion',
    },
    {
      id: 'real-time-intelligence', kind: 'tile', group: 'Workload', name: 'Real‑Time Intelligence', icon: 'real-time-intelligence.svg', tag: 'Streaming data',
      what: 'Fabric’s workload for streaming data, such as device readings, application logs and clickstreams. Events are ingested, stored, queried and charted as they arrive, and rules can act on them.',
      facts: [['Eventstream', 'Captures and routes streams from devices, apps and databases, with transforms'], ['Eventhouse', 'KQL databases for fast queries over large volumes of time series and logs'], ['Activator', 'Sends an alert or starts a flow when a rule on a stream or table is met']],
      health: 'Bedside monitor readings could stream into an eventhouse, and Activator could alert the care team when a patient’s vital signs cross a threshold.',
    },
    {
      id: 'power-bi', kind: 'tile', group: 'Workload', name: 'Power BI', icon: 'power-bi.svg', tag: 'Reports and semantic models',
      what: 'Reports and dashboards built on semantic models, which define a business’s tables, relationships and measures. In Direct Lake mode, a model reads Delta tables in OneLake directly.',
      facts: [['Semantic model', 'Tables, relationships and DAX measures, defined once and used by many reports'], ['Direct Lake', 'Large fact tables are read from OneLake, and no scheduled import refresh is needed'], ['Microsoft 365', 'Models feed PivotTables in Excel; live reports can be added to Teams and PowerPoint']],
      demo: 'The demo has three semantic models. Research Data (OMOP) covers two lakehouses and a SQL database, and relates each patient’s records to their CT series and reports.',
      link: 'semantic-model',
    },
    {
      id: 'iq', kind: 'tile', group: 'Workload', name: 'IQ', icon: 'iq.png', tag: 'Ontology and agents',
      what: 'A workload for describing the business so that people and AI agents use the same terms. An ontology names the entities, such as patients, studies and diagnoses, and how they relate.',
      facts: [['Ontology', 'Entities, relationships, rules and actions, built from OneLake or a semantic model'], ['Graph', 'Explores multi‑hop links between entities with visual, no‑code queries'], ['Agents', 'Data agents answer questions in plain language; operations agents act on live data']],
      demo: 'GitHub Copilot asks the Cohort Discovery model cohort questions in plain language through the Fabric IQ MCP server, such as how many former smokers aged 50 or over have a CT nodule of at least 6 mm.',
      link: 'semantic-model',
    },
    {
      id: 'rayfin', kind: 'tile', group: 'Apps on Fabric', name: 'Rayfin', icon: 'rayfin.svg', tag: 'App backends',
      what: 'A backend‑as‑a‑service built on Fabric. The developer writes the data model as TypeScript classes, and Rayfin provisions and runs the database, sign‑in, data APIs, storage and hosting.',
      facts: [['Model', 'TypeScript classes with decorators such as <code>@entity</code>, <code>@text</code> and <code>@role</code>'], ['Generated', 'GraphQL endpoints, a typed client and the database schema come from the model'], ['Deploy', '<code>npx rayfin up</code> deploys to Fabric; apps use Fabric sign‑in and governance']],
      demo: 'The approval app, where reviewers approve data requests and follow their delivery, is a Rayfin app, and so is Patient 360, which shows one patient’s whole record. This presentation is published the same way, in the same workspace.',
      link: 'data-delivery',
    },

    {
      id: 'github-copilot', kind: 'top', group: 'Works with Fabric', name: 'GitHub Copilot', icon: 'github-copilot.svg', mono: true, tag: 'Coding agent in VS Code',
      what: 'An AI coding assistant in VS Code and on GitHub. In agent mode it plans and makes changes across a project, and with Fabric’s tools installed it can work on Fabric items.',
      facts: [['Fabric MCP server', 'Gives agent mode tools for Fabric items, jobs, OneLake and Data Factory'], ['Notebooks', 'Writes notebook code with Fabric context, using the Data Engineering VS Code extension'], ['Rayfin', 'A plugin and starter prompt let it scaffold and deploy Rayfin apps']],
      demo: 'In the Cohort Discovery app, GitHub Copilot turns a researcher’s question into an i2b2 query, and in Patient 360 it answers questions about patients with the record’s own viewers. It also wrote the setup scripts and this presentation.',
      link: 'cohort-discovery',
    },
    {
      id: 'foundry', kind: 'top', group: 'Works with Fabric', name: 'Microsoft Foundry', icon: 'microsoft-foundry.svg', tag: 'AI apps and agents',
      what: 'Microsoft’s platform for building, testing and running AI apps and agents. Its catalog has more than 10,000 models from Microsoft, OpenAI, Anthropic, Meta, Mistral and others.',
      facts: [['Fabric IQ tool', 'Foundry agents can call Fabric data agents to answer questions from OneLake'], ['Identity', 'Queries run as the signed‑in user, and that user’s Fabric permissions apply'], ['Health text', 'Text analytics for health finds diagnoses, medications and dosages in clinical notes']],
      demo: 'The NLP stage will extract findings from the 17,910 reports, notes and scans. The 78,526 known facts in <b>document_facts</b> will be used to score the extraction.',
    },
  ];
  // Step order for presenting: the platform, where data comes from, the lake it lands in, what runs on it, then the
  // tools above it
  const ORDER = ['fabric', ...SOURCES, 'onelake', 'governance', 'copilot', ...WORKLOADS, ...TOP];
  const byId = Object.fromEntries(PARTS.map((p) => [p.id, p]));
  PARTS.forEach((p) => { if (!p.lit) p.lit = [p.id]; });

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = document.getElementById('platform');
  if (!root) return;
  const paneBody = document.getElementById('pfPaneBody');

  // GitHub's Copilot mark is single-colour by design (black or white), so it is inverted on the dark theme
  const img = (p, size) => `<img src="${ICON}${p.icon}" width="${size}" height="${size}" alt=""${p.mono ? ' class="pf-mono"' : ''} />`;
  const button = (p, cls, inner) =>
    `<button type="button" class="pf-node ${cls}" data-id="${p.id}" aria-pressed="false" aria-controls="pfPane" aria-label="${p.name.replace(/‑/g, '-')}${p.tag ? `: ${p.tag}` : ''}">${inner}</button>`;
  const arrow = (id, cls = '') => `<div class="pf-arrow ${cls}" data-src="${id}"><i></i></div>`;

  function draw() {
    const fabric = byId.fabric;
    root.querySelector('.pf-top').innerHTML = TOP.map((id, i) => {
      const p = byId[id];
      return button(p, `pf-box ${i ? 'pf-span-r' : 'pf-span-l'}`, `${img(p, 30)}<span class="pf-svc-text"><span class="pf-node-name">${p.name}</span><span class="pf-node-tag">${p.tag}</span></span>`);
    }).join('');
    root.querySelector('.pf-link').innerHTML = TOP.map((id, i) => arrow(id, i ? 'pf-span-r' : 'pf-span-l')).join('');
    root.querySelector('.pf-brand-slot').outerHTML = button(fabric, 'pf-brand', `${img(fabric, 30)}<span class="pf-node-name">${fabric.name}</span>`);
    root.querySelector('.pf-work').innerHTML = WORKLOADS.map((id) => {
      const p = byId[id];
      return button(p, 'pf-tile', `${img(p, 36)}<span class="pf-node-name">${p.name}</span><span class="pf-node-tag">${p.tag}</span>`);
    }).join('');
    root.querySelector('.pf-plat-row').innerHTML = ['copilot', 'governance'].map((id) => {
      const p = byId[id];
      return button(p, 'pf-svc', `${img(p, 30)}<span class="pf-svc-text"><span class="pf-node-name">${p.name}</span><span class="pf-node-tag">${p.tag}</span></span>`);
    }).join('');
    const lake = byId.onelake;
    root.querySelector('.pf-lake-slot').outerHTML = button(lake, 'pf-lake', `${img(lake, 46)}<span class="pf-lake-text"><span class="pf-node-name">${lake.name}</span><span class="pf-node-tag">${lake.tag}</span></span>`);
    root.querySelector('.pf-flow').innerHTML = SOURCES.map((id) => arrow(id)).join('');
    root.querySelector('.pf-src').innerHTML = SOURCES.map((id) => {
      const p = byId[id];
      return button(p, 'pf-source', `${img(p, 30)}<span class="pf-node-name">${p.name}</span>`);
    }).join('');
  }

  // A demo note can point at a section of the demo further down the page, named as the rail names it
  function sectionLink(id) {
    const ch = document.getElementById(id);
    if (!ch) return '';
    return ` See <a href="#${id}">${ch.dataset.num} ${ch.dataset.label}</a>.`;
  }

  function paneHTML(p) {
    const facts = p.facts && p.facts.length
      ? `<dl class="pf-facts">${p.facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>` : '';
    const note = p.demo || p.health;
    const demo = note
      ? `<div class="pf-demo"><span class="pf-demo-label">${p.demo ? 'In this demo' : 'In healthcare'}</span><p>${note}${p.link ? sectionLink(p.link) : ''}</p></div>` : '';
    return `<div class="pf-head"><span class="pf-sq" aria-hidden="true"></span>${p.group}</div>
      <div class="pf-detail"><h2 class="pf-name">${img(p, 32)}<span>${p.name}</span></h2><p class="pf-what">${p.what}</p>${facts}${demo}</div>`;
  }

  // The pane keeps the height of its longest entry, so stepping through never moves the page below it
  function holdHeight() {
    const probe = document.createElement('div');
    probe.className = 'pf-pane-body';
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;left:0;top:0;';
    probe.style.width = `${paneBody.getBoundingClientRect().width}px`;
    paneBody.parentNode.appendChild(probe);
    let h = 0;
    PARTS.forEach((p) => { probe.innerHTML = paneHTML(p); h = Math.max(h, probe.offsetHeight); });
    probe.remove();
    paneBody.style.minHeight = `${Math.ceil(h)}px`;
  }

  // The figure opens on an overview: nothing selected, every part at full strength and Fabric explained in the pane.
  // Selecting a part (Fabric's mark included) focuses it and steps the rest back; selecting it again, or Esc, returns
  // to the overview.
  let current, shown = null, swapTimer = 0;
  function select(id, animate = true) {
    const p = id ? byId[id] : null;
    const key = p ? p.id : '';
    if (current === key) return;
    current = key;
    const lit = p ? new Set(p.lit) : null;
    root.classList.toggle('has-focus', !!lit);
    root.querySelectorAll('.pf-node').forEach((n) => {
      const on = !!p && n.dataset.id === p.id;
      n.classList.toggle('sel', on);
      n.setAttribute('aria-pressed', String(on));
      n.classList.toggle('lit', !lit || lit.has(n.dataset.id));
    });
    // An arrow turns orange while its source or tool is selected; OneLake turns every source's arrow orange
    root.querySelectorAll('.pf-arrow').forEach((a) => {
      const src = a.dataset.src;
      a.classList.toggle('lit', !lit || lit.has(src));
      a.classList.toggle('hot', !!p && (p.id === src || (p.id === 'onelake' && SOURCES.includes(src))));
    });

    // The overview and Fabric itself explain the same thing, so moving between them leaves the pane as it is
    const show = p || byId.fabric;
    if (show.id === shown) return;
    shown = show.id;
    const html = paneHTML(show);
    clearTimeout(swapTimer);
    if (!animate || reduceMotion) {
      paneBody.classList.remove('out', 'in');
      paneBody.innerHTML = html;
      return;
    }
    paneBody.classList.remove('in');
    paneBody.classList.add('out');
    swapTimer = setTimeout(() => {
      paneBody.innerHTML = html;
      paneBody.classList.remove('out');
      void paneBody.offsetWidth;
      paneBody.classList.add('in');
    }, 150);
  }

  function step(dir) {
    const i = ORDER.indexOf(current);
    const next = i < 0 ? ORDER[dir > 0 ? 0 : ORDER.length - 1] : ORDER[(i + dir + ORDER.length) % ORDER.length];
    const hadFocus = document.activeElement && document.activeElement.classList.contains('pf-node');
    select(next);
    if (hadFocus) root.querySelector(`.pf-node[data-id="${next}"]`).focus({ preventScroll: true });
  }

  function init() {
    draw();
    select(null, false);
    holdHeight();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(holdHeight);
    // Spacing and type follow the screen's width and height, so a change in either re-measures the explainer
    let lastW = innerWidth, lastH = innerHeight, t = 0;
    window.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (innerWidth === lastW && innerHeight === lastH) return;
        lastW = innerWidth; lastH = innerHeight;
        holdHeight();
      }, 150);
    });

    root.addEventListener('click', (e) => {
      const n = e.target.closest('.pf-node');
      if (n) select(n.dataset.id === current ? null : n.dataset.id);
    });

    // ← → step through the parts (and Esc returns to the overview) while the figure is on screen
    document.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const r = root.getBoundingClientRect();
      // Only the figure that crosses the middle of the screen takes the keys, so section figures below can use them too
      if (r.top > innerHeight / 2 || r.bottom < innerHeight / 2) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === 'Escape' && current) { select(null); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
