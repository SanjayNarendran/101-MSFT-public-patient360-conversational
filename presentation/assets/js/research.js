/* 06 Research. Fig 7 picks up where Fig 6 ends: the delivery of request 1005 (demo mode) created the lakehouse and,
   next to it in the Cohort requests folder, the notebook Explore_QM1005_..._Demo (scripts/research_notebook.py),
   attached to the lakehouse. A replica of Fabric opens the folder and the notebook, selects Run all and follows the
   cells as their outputs appear: the rows delivered, the cohort, conditions, medications, labs, visits, imaging, a CT
   viewer with the largest nodule outlined, one image of every other kind, a report and one patient's record.

   The chart data was computed from the demo data for the 25 delivered patients with the notebook's own queries. The
   images are the notebook's own frames for patient 1000013 (LIDC-IDRI CT and SEG) and the slide (TCGA), MR (Synthea
   Coherent) and X-ray (LIDC-IDRI) of this delivery, read through the shortcuts and saved as WebP in assets/img. Under
   the screen, a diagram shows what the notebook reads in OneLake, lit in step. */
(function () {
  'use strict';

  const card = document.getElementById('rpCard');
  if (!card || !window.FigKit) return;
  const { ICON, esc, image, legend, fitLegends, setLedger, ui, replica } = window.FigKit;

  const W = 1280, H = 740;
  const TITLE = 'Former smokers 50+, lung nodule 6 mm or more';
  const LAKEHOUSE = 'Delivery_QM1005_FormerSmokers50LungNodule6mm_Demo';
  const NOTEBOOK = 'Explore_QM1005_FormerSmokers50LungNodule6mm_Demo';
  const WORKSPACE_ID = '00000000-0000-0000-0000-000000000000';
  const ME = 'researcher@contoso.com';
  const IMG = 'assets/img/';
  const PERSON = 1000013;
  const STUDY = '1_3_6_1_4_1_14519_5_2_1_6279_6001_135649280843401063699693855484';
  // Computed from the demo data for the 25 patients of the demo-mode delivery of request 1005, with the notebook's own
  // queries (research_notebook.py)
  const ROWS = [["measurement",7163],["drug_exposure",2166],["visit_occurrence",1487],["condition_occurrence",704],["concept",510],["condition_era",439],["observation",401],["procedure_occurrence",387],["image_feature",350],["document_links",166],["note",166],["drug_era",160],["image_occurrence",88],["cohort",25],["observation_period",25],["person",25],["death",1],["specimen",1]];
  const PYRAMID = { bands: ["0-17","18-29","30-39","40-49","50-59","60-69","70-79","80+"], female: [0,0,0,0,5,2,1,5], male: [0,0,0,0,5,0,4,3] };
  const RACE = [["White",23],["Asian",1],["Black or African American",1]];
  const CONDITIONS = [["Cough",20],["Viral sinusitis",16],["Acute viral pharyngitis",16],["Normal pregnancy",13],["Nodule of lung",13],["Anemia",13],["Acute bronchitis",12],["Impaired glucose tolerance",12],["Solitary nodule of lung",12],["Miscarriage in first trimester",11],["Essential hypertension",11],["Hyperlipidemia",5],["Acute bacterial sinusitis",4],["Chronic sinusitis",4],["Sprain of wrist",3]];
  const TOGETHER = [[20,12,14,11,11,11,10,10,9,10],[12,16,11,9,9,9,8,8,7,7],[14,11,16,8,8,9,6,7,8,7],[11,9,8,13,7,7,7,7,6,11],[11,9,8,7,13,8,7,6,0,7],[11,9,9,7,8,13,5,11,5,6],[10,8,6,7,7,5,12,4,5,6],[10,8,7,7,6,11,4,12,6,6],[9,7,8,6,0,5,5,6,12,4],[10,7,7,11,7,6,6,6,4,11]];
  const MEDS = { drugs: [["acetaminophen",17],["lisinopril",9],["amlodipine",9],["naproxen",7],["amoxicillin",6],["simvastatin",6],["clavulanate",5],["doxylamine",4],["dextromethorphan",4],["hydrochlorothiazide",3],["fluticasone",3],["hydrocodone",3]], years: [2007,2008,2009,2010,2011,2012,2013,2014,2015,2016,2017,2018,2019,2020,2021,2022,2023,2024,2025,2026], z: [[0,0,0,0,0,0,0,0,0,0,3,4,1,1,4,3,3,1,3,1],[8,8,8,8,8,8,8,8,8,8,8,8,8,8,8,8,8,9,8,5],[7,7,7,7,7,7,7,7,7,7,7,8,8,8,8,8,8,8,8,6],[1,1,1,1,1,1,1,1,1,2,1,3,1,1,0,0,0,1,1,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,2,1,0,2,1],[4,4,4,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,4],[0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,1,1,0,2,1],[0,0,0,0,0,0,0,0,0,0,0,0,1,0,1,0,0,0,1,1],[0,0,0,0,0,0,0,0,0,0,0,0,1,0,1,0,0,0,1,1],[3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,1],[1,1,1,1,1,1,1,1,1,1,1,1,1,2,2,2,2,2,2,1],[0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,1,1,0,0,0]] };
  const LABS = [["HbA1c","%",[3.0,5.3,5.9,5.9,6.0,6.0,6.0,6.1,6.1,6.2,6.3,6.3,6.4]],["Glucose","mg/dL",[67.2,67.3,67.3,69.4,70.7,83.4,83.4,87.9,90.6,93.3,94.9,96.2,96.5,96.5,97.1]],["eGFR","mL/min/{1.73_m2}",[17.8,69.4,72.4,73.5,87.5,133.9]],["BMI","kg/m2",[22.1,25.9,26.0,27.1,27.2,27.4,27.4,27.4,27.5,27.8,27.8,27.8,27.8,28.0,28.2,28.2,28.8,29.8,30.1,30.1,30.2,30.2,30.2,30.3,31.1]],["Systolic BP","mm[Hg]",[113.0,121.0,131.0,131.0,144.0,144.0,146.0,150.0,152.0,153.0,154.0,155.0,157.0,157.0,161.0,162.0,163.0,164.0,164.0,164.0,164.0,165.0,167.0,167.0,170.0]],["Diastolic BP","mm[Hg]",[50.0,50.0,55.0,59.0,79.0,81.0,82.0,82.0,82.0,82.0,82.0,83.0,83.0,84.0,84.0,84.0,84.0,84.0,85.0,85.0,86.0,86.0,86.0,87.0,87.0]]];
  const VISIT_TYPES = ['Office Visit', 'Outpatient Visit', 'Urgent Care Facility', 'Telehealth', 'Emergency Room Visit', 'Inpatient Visit', 'Other'];
  const VISITS = { years: [2002,2003,2004,2005,2006,2007,2008,2009,2010,2011,2012,2013,2014,2015,2016,2017,2018,2019,2020,2021,2022,2023,2024,2025,2026], by: {"Office Visit":[18,14,13,14,17,15,15,15,17,18,17,16,17,18,34,39,37,47,45,51,49,40,44,43,28],"Outpatient Visit":[4,2,4,7,5,9,7,5,7,4,8,6,4,7,9,12,10,23,10,14,13,8,14,23,8],"Urgent Care Facility":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,4,14,13,9,15,11,14,10,16,13,6],"Telehealth":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,45,16,0],"Emergency Room Visit":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,6,1,2,3,6,1,2,4,0],"Inpatient Visit":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,2,10,3,4,3,2],"Other":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0]} };
  const MODALITIES = [["CT",2,23],["DX",1,20],["US",0,8],["CR",0,6],["OT",0,5],["MG",0,2],["SM",1,0],["MR",1,0]];   // modality, studies linked in the lakehouse, studies listed only
  const NODULES = [4.7,4.9,5.2,5.4,5.6,5.6,5.7,5.7,5.9,5.9,6.0,6.0,6.1,6.1,6.1,6.2,6.2,6.3,6.5,6.6,6.6,6.8,6.8,7.0,7.0,7.1,7.1,7.4,7.5,7.5,7.6,7.7,7.7,7.9,7.9,8.1,8.1,8.1,8.2,8.3,8.4,9.0,9.1,9.1,9.1,9.1,9.4,9.4,9.5,9.6,9.8,10.4,10.5,10.6,10.6,11.5,11.5,11.6,12.6,12.7,14.0,17.2,17.8,19.7,20.7,24.3,33.3,34.4,35.0,39.4];   // mm
  const CT = { positions: [-122.0,-119.5,-117.0,-114.5,-112.0,-109.5,-107.0,-104.5], outlined: [false,false,true,true,true,true,false,false] };
  const TIMELINE = {
    lanes: {"Conditions":["2014-12-13","2015-12-13","2016-11-28","2016-12-12","2017-03-17","2017-12-12","2018-12-12","2019-12-12","2020-12-11","2021-12-11","2022-03-30","2022-12-11","2023-12-11","2024-12-10","2025-01-12","2025-05-02","2025-09-16","2025-09-26","2025-09-26","2025-12-10","2026-04-30"],"Imaging":["2025-09-16","2025-09-26"],"Labs and vitals":["2016-11-08","2016-11-08","2016-11-08","2016-11-08","2016-11-08","2016-11-08","2016-11-08","2016-11-08","2016-11-08","2016-11-08","2016-11-08","2016-11-08","2016-11-28","2016-12-12","2016-12-12","2016-12-12","2016-12-12","2016-12-12","2016-12-12","2016-12-12","2016-12-12","2016-12-12","2016-12-12","2016-12-12","2016-12-12","2016-12-12","2016-12-12","2016-12-12","2016-12-12","2016-12-12","2016-12-12","2016-12-12","2016-12-12","2017-03-28","2017-03-28","2017-03-28","2017-03-28","2017-03-28","2017-03-28","2017-03-28","2017-03-28","2017-11-14","2017-11-14","2017-11-14","2017-11-14","2017-11-14","2017-11-14","2017-11-14","2017-11-14","2017-12-12","2017-12-12","2017-12-12","2017-12-12","2017-12-12","2017-12-12","2017-12-12","2017-12-12","2017-12-12","2017-12-12","2017-12-12","2017-12-12","2017-12-12","2017-12-12","2017-12-12","2017-12-12","2017-12-12","2017-12-12","2017-12-12","2017-12-12","2018-11-20","2018-11-20","2018-11-20","2018-11-20","2018-11-20","2018-11-20","2018-11-20","2018-11-20","2018-11-20","2018-11-20","2018-11-20","2018-11-20","2018-11-20","2018-11-20","2018-11-20","2018-11-20","2018-11-20","2018-11-20","2018-11-20","2018-12-12","2018-12-12","2018-12-12","2018-12-12","2018-12-12","2018-12-12","2018-12-12","2018-12-12","2018-12-12","2018-12-12","2018-12-12","2018-12-12","2018-12-12","2018-12-12","2018-12-12","2018-12-12","2018-12-12","2018-12-12","2018-12-12","2018-12-12","2019-11-26","2019-11-26","2019-11-26","2019-11-26","2019-11-26","2019-11-26","2019-11-26","2019-11-26","2019-11-26","2019-11-26","2019-11-26","2019-11-26","2019-12-12","2019-12-12","2019-12-12","2019-12-12","2019-12-12","2019-12-12","2019-12-12","2019-12-12","2019-12-12","2019-12-12","2019-12-12","2019-12-12","2019-12-12","2019-12-12","2019-12-12","2019-12-12","2019-12-12","2019-12-12","2019-12-12","2019-12-12","2020-12-01","2020-12-01","2020-12-01","2020-12-01","2020-12-01","2020-12-01","2020-12-01","2020-12-01","2020-12-11","2020-12-11","2020-12-11","2020-12-11","2020-12-11","2020-12-11","2020-12-11","2020-12-11","2020-12-11","2020-12-11","2020-12-11","2020-12-11","2020-12-11","2020-12-11","2020-12-11","2020-12-11","2020-12-11","2020-12-11","2020-12-11","2020-12-11","2021-12-07","2021-12-07","2021-12-07","2021-12-07","2021-12-07","2021-12-07","2021-12-07","2021-12-07","2021-12-11","2021-12-11","2021-12-11","2021-12-11","2021-12-11","2021-12-11","2021-12-11","2021-12-11","2021-12-11","2021-12-11","2021-12-11","2021-12-11","2021-12-11","2021-12-11","2021-12-11","2021-12-11","2021-12-11","2021-12-11","2021-12-11","2021-12-11","2022-03-30","2022-04-05","2022-04-05","2022-04-05","2022-04-05","2022-04-05","2022-04-05","2022-04-05","2022-04-05","2022-12-11","2022-12-11","2022-12-11","2022-12-11","2022-12-11","2022-12-11","2022-12-11","2022-12-11","2022-12-11","2022-12-11","2022-12-11","2022-12-11","2022-12-11","2022-12-11","2022-12-11","2022-12-11","2022-12-11","2022-12-11","2022-12-11","2022-12-11","2022-12-13","2022-12-13","2022-12-13","2022-12-13","2022-12-13","2022-12-13","2022-12-13","2022-12-13","2022-12-13","2022-12-13","2022-12-13","2022-12-13","2023-12-11","2023-12-11","2023-12-11","2023-12-11","2023-12-11","2023-12-11","2023-12-11","2023-12-11","2023-12-11","2023-12-11","2023-12-11","2023-12-11","2023-12-11","2023-12-11","2023-12-11","2023-12-11","2023-12-11","2023-12-11","2023-12-11","2023-12-11","2023-12-19","2023-12-19","2023-12-19","2023-12-19","2023-12-19","2023-12-19","2023-12-19","2023-12-19","2023-12-19","2023-12-19","2023-12-19","2023-12-19","2023-12-19","2023-12-19","2023-12-19","2023-12-19","2023-12-19","2023-12-19","2023-12-19","2024-12-10","2024-12-10","2024-12-10","2024-12-10","2024-12-10","2024-12-10","2024-12-10","2024-12-10","2024-12-10","2024-12-10","2024-12-10","2024-12-10","2024-12-10","2024-12-10","2024-12-10","2024-12-10","2024-12-10","2024-12-10","2024-12-10","2024-12-10","2024-12-24","2024-12-24","2024-12-24","2024-12-24","2024-12-24","2024-12-24","2024-12-24","2024-12-24","2025-09-26","2025-09-26","2025-09-26","2025-09-26","2025-09-26","2025-09-26","2025-09-26","2025-09-26","2025-09-26","2025-09-26","2025-09-26","2025-09-26","2025-09-26","2025-09-26","2025-09-26","2025-12-10","2025-12-10","2025-12-10","2025-12-10","2025-12-10","2025-12-10","2025-12-10","2025-12-10","2025-12-10","2025-12-10","2025-12-10","2025-12-10","2025-12-10","2025-12-10","2025-12-10","2025-12-10","2025-12-10","2025-12-10","2025-12-10","2025-12-10","2025-12-30","2025-12-30","2025-12-30","2025-12-30","2025-12-30","2025-12-30","2025-12-30","2025-12-30","2025-12-30","2025-12-30","2025-12-30","2025-12-30"],"Procedures":["2016-11-08","2017-02-07","2017-03-17","2017-11-14","2018-11-20","2019-11-26","2020-12-01","2022-12-13","2025-09-16","2025-09-26"],"Reports and notes":["2024-12-10","2024-12-24","2025-01-12","2025-05-02","2025-09-17","2025-09-27"],"Visits":["2014-12-13","2015-12-13","2016-01-22","2016-11-08","2016-11-28","2016-12-12","2017-02-07","2017-03-17","2017-03-28","2017-11-14","2017-12-12","2018-11-20","2018-12-12","2019-11-26","2019-12-12","2020-12-01","2020-12-11","2021-12-07","2021-12-11","2022-03-30","2022-04-05","2022-12-11","2022-12-13","2023-12-11","2023-12-19","2024-12-10","2024-12-24","2025-01-12","2025-05-02","2025-09-16","2025-09-26","2025-12-10","2025-12-30","2026-04-30","2026-05-12"]},
    drugs: [["simvastatin",[["2010-12-14","2025-12-10"]]],["levonorgestrel",[["2016-01-22","2017-01-27"]]],["acetaminophen",[["2017-03-17","2017-03-24"],["2022-03-30","2022-04-06"],["2025-05-02","2025-05-09"],["2026-04-30","2026-05-07"]]],["dextromethorphan",[["2026-04-30","2026-05-07"]]],["doxylamine",[["2026-04-30","2026-05-07"]]]],
  };
  const REPORT = `CONTOSO HEALTH
Department of Radiology | CONTOSO MEDICAL CENTER

RADIOLOGY REPORT
Patient: CONN, JENNA                          MRN: 11329595
DOB: 11/08/1966  Age: 58  Sex: Female         Accession: DX2025012497
Exam: XR CHEST 2 VIEWS
Exam date: 09/16/2025 16:46                   Ordering: JERDE, SUSANNA

CLINICAL INDICATION: Cough.

TECHNIQUE: PA and lateral views of the chest.

COMPARISON: None.

FINDINGS:
Heart size is normal. Mediastinal contours are normal. No pleural effusion or pneumothorax.

IMPRESSION:
1. No acute cardiopulmonary abnormality.

Electronically signed by: PFEFFER, TYSON, MD (Diagnostic Radiology) on 09/17/2025 11:31`;
  const DOCS = [['Progress Note', 97, 12], ['Radiology Report', 68, 8], ['Pathology Report', 1, 0]];
  const GALLERY = [['Digital X-ray (DX)', 'dx.webp'], ['MR', 'mr.webp'], ['Pathology slide (SM)', 'sm.webp']];
  const TABLES = ['cohort', 'cohort_definition', 'concept', 'condition_era', 'condition_occurrence', 'death', 'delivery_manifest',
    'document_links', 'drug_era', 'drug_exposure', 'image_feature', 'image_occurrence', 'measurement', 'note', 'observation',
    'observation_period', 'person', 'procedure_occurrence', 'specimen', 'visit_occurrence'];

  const STEPS = [
    { chip: 'Open', label: 'Step 1 of 6',
      text: `The delivery put the notebook ${NOTEBOOK} in the Cohort requests folder, next to its lakehouse. The researcher opens it. The lakehouse is already attached as the notebook’s default lakehouse, and its tables and files are listed on the left.` },
    { chip: 'Run all', label: 'Step 2 of 6',
      text: 'Run all starts a Fabric Python session in a few seconds. The setup cell loads the 18 delivered tables into DuckDB from the attached lakehouse, and the first charts show the rows delivered per table and the 25 patients by age, sex and race. All of them are 50 or older, and 24 are living.' },
    { chip: 'Conditions and labs', label: 'Step 3 of 6',
      text: 'The conditions come from condition_era. Cough is the most common, in 20 of the 25 patients, and the heatmap shows which conditions occur together. After the medications by year, each patient’s latest HbA1c, glucose, eGFR, BMI and blood pressure result is one point.' },
    { chip: 'Imaging', label: 'Step 4 of 6',
      text: 'Five of the patients’ 69 imaging studies are linked into the lakehouse, and the nodule sizes are set against the Lung-RADS cut-offs. The CT viewer reads patient 1000013’s chest CT through its OneLake shortcut and follows the largest nodule, outlined in orange where the LIDC radiologist drew it.' },
    { chip: 'Images and a report', label: 'Step 5 of 6',
      text: 'The same shortcuts give a chest X-ray, an MR of the head and a pathology slide, one image of every other kind in the delivery. The reports and notes are copies in Files/documents, and the cell shows the chest X-ray report of the same patient.' },
    { chip: 'One patient’s record', label: 'Step 6 of 6',
      text: 'The last chart joins every table on person_id for patient 1000013, born 1966: 450 events and 10 medication periods. Dragging the bar under it narrows the view to the months around the CT.' },
  ];
  const HOLD = [6200, 11500, 10500, 15500, 10500];

  /* ---- Charts, drawn as the notebook's Plotly charts are (ink bars, one orange accent) ---- */
  const CW = 900;
  const fmt = (n) => n.toLocaleString('en-US');
  const pct = (x) => `${Math.round(x * 100)}%`;
  const short = (t, n) => (t.length <= n ? t : `${t.slice(0, n - 1)}…`);
  const fig = (title, h, body, after = '') => `<figure class="rp-fig"><figcaption>${esc(title)}</figcaption>
    <svg class="rp-svg" viewBox="0 0 ${CW} ${h}" aria-hidden="true">${body}</svg>${after}</figure>`;
  const txt = (x, y, s, cls = '', anchor = 'start', extra = '') => `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}"${extra}>${esc(String(s))}</text>`;
  const bar = (x, y, w, h, i, cls = '') => `<rect class="rp-b ${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, w).toFixed(1)}" height="${h.toFixed(1)}" style="--i:${i}"/>`;
  const vline = (x, y1, y2, cls = 'rp-grid') => `<line class="${cls}" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y1}" y2="${y2}"/>`;
  const hline = (y, x1, x2, cls = 'rp-grid') => `<line class="${cls}" x1="${x1}" x2="${x2}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
  function niceTicks(lo, hi, n = 4) {
    const span = hi - lo, mag = 10 ** Math.floor(Math.log10(span / n));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n + 0.5);
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }
  const key = (items) => `<div class="rp-key">${items.map(([cls, label]) => `<span><i class="${cls}"></i>${esc(label)}</span>`).join('')}</div>`;

  // 1. Rows delivered per table, log scale
  function rowsChart() {
    const x0 = 160, x1 = CW - 70, top = 4, rh = 16, lo = Math.log10(0.5), hi = 4;
    const X = (v) => x0 + ((Math.log10(v) - lo) / (hi - lo)) * (x1 - x0);
    let s = [1, 10, 100, 1000, 10000].map((t) => vline(X(t), top, top + ROWS.length * rh) + txt(X(t), top + ROWS.length * rh + 15, t === 10000 ? '10k' : t, 'rp-tm', 'middle')).join('');
    ROWS.forEach(([t, v], i) => {
      const y = top + i * rh;
      s += txt(x0 - 8, y + 11.5, t, '', 'end') + bar(x0, y + 2.5, X(v) - x0, rh - 5, i, t === 'person' ? 'rp-acc' : '') + txt(X(v) + 5, y + 11.5, fmt(v), 'rp-v');
    });
    return fig('Rows delivered per OMOP table (log scale)', top + ROWS.length * rh + 22, s);
  }
  // 2. Age and sex pyramid, race
  function peopleChart() {
    const top = 26, rh = 22, n = PYRAMID.bands.length, cx = 300, half = 210, max = 5 * 1.08;
    const X = (v) => cx + (v / max) * half;
    let s = txt(cx, 14, 'Age (as of today, or at death) and sex', 'rp-st', 'middle') + txt(745, 14, 'Race', 'rp-st', 'middle');
    [-5, -3, 0, 3, 5].forEach((t) => { s += vline(X(t), top, top + n * rh) + txt(X(t), top + n * rh + 15, Math.abs(t), 'rp-tm', 'middle'); });
    PYRAMID.bands.forEach((b, j) => {
      const y = top + (n - 1 - j) * rh, m = PYRAMID.male[j], f = PYRAMID.female[j];
      s += txt(cx - half - 10, y + 15, b, '', 'end');
      if (m) s += bar(X(-m), y + 3, X(0) - X(-m), rh - 6, j, 'rp-bl');
      if (f) s += bar(X(0), y + 3, X(f) - X(0), rh - 6, j, 'rp-acc');
    });
    // Race: one bar per group across the whole height, largest at the top
    const rx0 = 750, rx1 = 860, rmax = 23 * 1.12, rr = (n * rh) / RACE.length;
    RACE.forEach(([r, v], k) => {
      const y = top + k * rr, w = (v / rmax) * (rx1 - rx0);
      s += txt(rx0 - 8, y + rr / 2 + 4, short(r, 26), '', 'end') + bar(rx0, y + rr * 0.2, w, rr * 0.6, k, 'rp-mut') + txt(rx0 + w + 5, y + rr / 2 + 4, v, 'rp-v');
    });
    s += [0, 10, 20].map((t) => vline(rx0 + (t / rmax) * (rx1 - rx0), top, top + n * rh) + txt(rx0 + (t / rmax) * (rx1 - rx0), top + n * rh + 15, t, 'rp-tm', 'middle')).join('');
    return fig('25 patients: 24 living, 1 deceased', top + n * rh + 22, s, key([['rp-k-ink', 'Male'], ['rp-k-acc', 'Female']]));
  }
  // 3a. The most common conditions
  function conditionsChart() {
    const x0 = 230, x1 = CW - 70, top = 4, rh = 18, max = 0.9;
    const X = (v) => x0 + (v / max) * (x1 - x0);
    let s = [0, 0.2, 0.4, 0.6, 0.8].map((t) => vline(X(t), top, top + CONDITIONS.length * rh) + txt(X(t), top + CONDITIONS.length * rh + 15, pct(t), 'rp-tm', 'middle')).join('');
    CONDITIONS.forEach(([c, v], i) => {
      const y = top + i * rh, p = v / 25;
      s += txt(x0 - 8, y + 13, short(c, 48), '', 'end') + bar(x0, y + 3, X(p) - x0, rh - 6, i, i ? '' : 'rp-acc') + txt(X(p) + 5, y + 13, pct(p), 'rp-v');
    });
    return fig('The 15 most common conditions (share of patients)', top + CONDITIONS.length * rh + 22, s);
  }
  // 3b. Which conditions occur together
  function togetherChart() {
    const names = CONDITIONS.slice(0, 10).map(([c]) => short(c, 30));
    const x0 = 230, cw = 56, ch = 26, top = 4, max = 20;
    let s = '';
    TOGETHER.forEach((row, r) => {
      s += txt(x0 - 8, top + r * ch + 17, names[r], '', 'end');
      row.forEach((z, c) => {
        const p = Math.round((z / max) * 100);
        s += `<rect class="rp-hc" x="${x0 + c * cw}" y="${top + r * ch}" width="${cw - 1}" height="${ch - 1}" style="--i:${r * 10 + c};fill:color-mix(in srgb, var(--accent) ${p}%, var(--surface))"/>`
          + txt(x0 + c * cw + cw / 2, top + r * ch + 17, pct(z / 25), `rp-hv${p > 62 ? ' rp-on-dark' : ''}`, 'middle', ` style="--i:${r * 10 + c}"`);
      });
    });
    names.forEach((nm, c) => { s += `<text class="rp-tm" text-anchor="end" transform="translate(${x0 + c * cw + cw / 2 + 4} ${top + 10 * ch + 10}) rotate(-35)">${esc(nm)}</text>`; });
    return fig('Conditions that occur together (share of patients with both)', top + 10 * ch + 128, s);
  }
  // 4. Medications: patients ever on each, and on it each year
  function medsChart() {
    const top = 24, rh = 21, n = MEDS.drugs.length, bx0 = 150, bx1 = 290, hx0 = 300, cw = (CW - 10 - hx0) / MEDS.years.length;
    let s = txt((bx0 + bx1) / 2, 14, 'Patients ever on it', 'rp-st', 'middle') + txt(hx0 + (CW - 10 - hx0) / 2, 14, 'Patients on it each year', 'rp-st', 'middle');
    MEDS.drugs.forEach(([d, v], i) => {
      const y = top + i * rh, w = (v / 17) * (bx1 - bx0);
      s += txt(bx0 - 8, y + 15, short(d, 30), '', 'end') + bar(bx0, y + 2, w, rh - 4, i) + (w > 22 ? txt(bx0 + w - 5, y + 15, v, 'rp-v rp-in', 'end') : '');
      MEDS.z[i].forEach((z, c) => {
        s += `<rect class="rp-hc" x="${(hx0 + c * cw).toFixed(1)}" y="${y}" width="${(cw - 1).toFixed(1)}" height="${rh - 1}" style="--i:${i * 20 + c};fill:color-mix(in srgb, var(--accent) ${Math.round((z / 9) * 100)}%, var(--surface))"/>`;
      });
    });
    MEDS.years.forEach((yr, c) => { if (yr % 3 === 0) s += txt(hx0 + c * cw + cw / 2, top + n * rh + 15, yr, 'rp-tm', 'middle'); });
    return fig('Medications (drug eras by ingredient)', top + n * rh + 22, s);
  }
  // 5. Each patient's latest lab result, one point per patient
  function labsChart() {
    const cols = 3, pw = 280, gap = 30, ph = 84, rowH = 136;
    let s = '', k = 0;
    LABS.forEach(([label, unit, vals], i) => {
      const ox = (i % cols) * (pw + gap), oy = Math.floor(i / cols) * rowH;
      const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.08 || 1;
      const X = (v) => ox + ((v - lo + pad) / (hi - lo + 2 * pad)) * pw;
      const q = (p) => { const a = vals[Math.floor((vals.length - 1) * p)], b = vals[Math.ceil((vals.length - 1) * p)]; return (a + b) / 2; };
      s += txt(ox + pw / 2, oy + 14, `${label}${unit ? ` (${unit})` : ''}`, 'rp-st', 'middle');
      niceTicks(lo - pad, hi + pad, 4).forEach((t) => { s += vline(X(t), oy + 22, oy + 22 + ph) + txt(X(t), oy + 22 + ph + 15, t, 'rp-tm', 'middle'); });
      const my = oy + 22 + ph / 2, iqr = q(0.75) - q(0.25);
      // Whiskers as Plotly draws them: to the furthest points within 1.5 IQR of the box
      const wlo = Math.min(...vals.filter((v) => v >= q(0.25) - 1.5 * iqr)), whi = Math.max(...vals.filter((v) => v <= q(0.75) + 1.5 * iqr));
      s += `<g class="rp-box" style="--i:${i}"><line x1="${X(wlo).toFixed(1)}" x2="${X(q(0.25)).toFixed(1)}" y1="${my}" y2="${my}"/><line x1="${X(q(0.75)).toFixed(1)}" x2="${X(whi).toFixed(1)}" y1="${my}" y2="${my}"/>
        <rect x="${X(q(0.25)).toFixed(1)}" y="${my - 18}" width="${(X(q(0.75)) - X(q(0.25))).toFixed(1)}" height="36"/><line x1="${X(q(0.5)).toFixed(1)}" x2="${X(q(0.5)).toFixed(1)}" y1="${my - 18}" y2="${my + 18}"/></g>`;
      vals.forEach((v, j) => {
        const jitter = (((j * 37 + i * 11) % 19) / 18 - 0.5) * 30;
        s += `<circle class="rp-dot" cx="${X(v).toFixed(1)}" cy="${(my + jitter).toFixed(1)}" r="3.2" style="--i:${k++}"/>`;
      });
    });
    return fig('Each patient’s latest result (one point per patient)', rowH * 2 - 10, s);
  }
  // 6. Visits per year by type
  function visitsChart() {
    const x0 = 34, x1 = CW - 6, top = 6, h = 170, n = VISITS.years.length, bw = (x1 - x0) / n;
    const Y = (v) => top + h - (v / 130) * h;
    let s = [0, 50, 100].map((t) => hline(Y(t), x0, x1) + txt(x0 - 6, Y(t) + 4, t, 'rp-tm', 'end')).join('');
    VISITS.years.forEach((yr, j) => {
      let acc = 0;
      VISIT_TYPES.forEach((t, k) => {
        const v = VISITS.by[t][j];
        if (v) s += `<rect class="rp-b rp-bv rp-s${k}" x="${(x0 + j * bw + bw * 0.08).toFixed(1)}" y="${Y(acc + v).toFixed(1)}" width="${(bw * 0.84).toFixed(1)}" height="${(Y(acc) - Y(acc + v)).toFixed(1)}" style="--i:${j}"/>`;
        acc += v;
      });
      if (yr % 4 === 2) s += txt(x0 + j * bw + bw / 2, top + h + 15, yr, 'rp-tm', 'middle');
    });
    return fig('Visits per year by type', top + h + 22, s, key(VISIT_TYPES.map((t, k) => [`rp-s${k}`, t])));
  }
  // 7. Studies by modality, and nodule sizes against the Lung-RADS cut-offs
  function imagingChart() {
    const top = 26, h = 170, lx0 = 34, lx1 = 380, n = MODALITIES.length, bw = (lx1 - lx0) / n;
    const Y = (v, max) => top + h - (v / max) * h;
    let s = txt((lx0 + lx1) / 2, 14, 'Imaging studies by modality', 'rp-st', 'middle');
    [0, 5, 10, 15, 20, 25].forEach((t) => { s += hline(Y(t, 26), lx0, lx1) + txt(lx0 - 6, Y(t, 26) + 4, t, 'rp-tm', 'end'); });
    MODALITIES.forEach(([m, linked, listed], j) => {
      const x = lx0 + j * bw + bw * 0.12, w = bw * 0.76;
      if (linked) s += `<rect class="rp-b rp-bv rp-acc" x="${x.toFixed(1)}" y="${Y(linked, 26).toFixed(1)}" width="${w.toFixed(1)}" height="${(Y(0, 26) - Y(linked, 26)).toFixed(1)}" style="--i:${j}"/>`;
      if (listed) s += `<rect class="rp-b rp-bv rp-pale" x="${x.toFixed(1)}" y="${Y(linked + listed, 26).toFixed(1)}" width="${w.toFixed(1)}" height="${(Y(linked, 26) - Y(linked + listed, 26)).toFixed(1)}" style="--i:${j}"/>`;
      s += txt(x + w / 2, top + h + 15, m, 'rp-tm', 'middle');
    });
    // Histogram, 2 mm bins
    const hx0 = 470, hx1 = CW - 10, lo = 4, hi = 40, bins = Array.from({ length: (hi - lo) / 2 }, () => 0);
    NODULES.forEach((v) => { bins[Math.min(bins.length - 1, Math.floor((v - lo) / 2))] += 1; });
    const X = (v) => hx0 + ((v - lo) / (hi - lo)) * (hx1 - hx0), bmax = 32;
    s += txt((hx0 + hx1) / 2, 14, 'Lung nodule sizes (radiologist measurements)', 'rp-st', 'middle');
    [0, 10, 20, 30].forEach((t) => { s += hline(Y(t, bmax), hx0, hx1) + txt(hx0 - 6, Y(t, bmax) + 4, t, 'rp-tm', 'end'); });
    bins.forEach((c, j) => { if (c) s += `<rect class="rp-b rp-bv" x="${(X(lo + j * 2) + 0.5).toFixed(1)}" y="${Y(c, bmax).toFixed(1)}" width="${(X(2) - X(0) - 1).toFixed(1)}" height="${(Y(0, bmax) - Y(c, bmax)).toFixed(1)}" style="--i:${j}"/>`; });
    [5, 10, 15, 20, 25, 30, 35, 40].forEach((t) => { s += txt(X(t), top + h + 15, t, 'rp-tm', 'middle'); });
    [6, 8, 15].forEach((mm, k) => { s += vline(X(mm), top, top + h, 'rp-cut') + txt(X(mm) + 4, top + 11 + (k === 1 ? 15 : 0), `${mm} mm`, 'rp-cut-t'); });
    s += txt((hx0 + hx1) / 2, top + h + 32, 'mm (dotted: Lung-RADS size cut-offs for solid nodules)', 'rp-tm', 'middle');
    return fig('', top + h + 40, s, key([['rp-k-acc', 'Images linked in this lakehouse'], ['rp-k-pale', 'Listed only (report and metadata)']]));
  }
  // The CT viewer: the notebook's frames (whole slice and close-up), a slider and a play button
  function ctViewer() {
    const n = CT.positions.length;
    return `<figure class="rp-fig rp-ct"><figcaption>Chest CT of patient ${PERSON}, 26 Sep 2025: the largest nodule, outlined by 1 LIDC radiologist, ${n} slices</figcaption>
      <div class="rp-ct-panes">
        <div><div class="rp-ct-t">Whole slice (lung window)</div><div class="rp-ct-img" style="background-image:url(${IMG}ct-slices.webp)"></div></div>
        <div><div class="rp-ct-t">Close-up of the nodule</div><div class="rp-ct-img" style="background-image:url(${IMG}ct-closeup.webp)"></div></div>
      </div>
      <div class="rp-ct-ctl"><span class="rp-play" aria-hidden="true"><svg viewBox="0 0 12 12" width="12" height="12"><path d="M3 1.8v8.4L10 6z"/></svg></span>
        <div class="rp-slider"><div class="rp-cur">Slice position: <b class="rp-pos">${CT.positions[0].toFixed(1)} mm</b></div>
          <div class="rp-track"><span class="rp-knob"></span>${CT.positions.map((p, i) => `<span class="rp-tick" style="left:${(i / (n - 1)) * 100}%"><i></i>${p.toFixed(1)} mm</span>`).join('')}</div></div></div></figure>
      <pre class="rp-print">Read ${n} DICOM files through the OneLake shortcut Files/dicom/${STUDY}</pre>`;
  }
  function galleryOut() {
    return `<figure class="rp-fig"><figcaption>One image of every other kind in this delivery, read through its OneLake shortcut</figcaption>
      <div class="rp-gal">${GALLERY.map(([t, f], i) => `<div style="--i:${i}"><div class="rp-ct-t">${esc(t)}</div><div class="rp-gal-img"><img src="${IMG}${f}" alt=""></div></div>`).join('')}</div></figure>`;
  }
  function docsOut() {
    const x0 = 130, x1 = CW - 60, rh = 24, max = 100;
    let s = [0, 20, 40, 60, 80, 100].map((t) => vline(x0 + (t / max) * (x1 - x0), 2, 2 + DOCS.length * rh) + txt(x0 + (t / max) * (x1 - x0), 2 + DOCS.length * rh + 15, t, 'rp-tm', 'middle')).join('');
    DOCS.forEach(([t, n, c], i) => {
      const y = 2 + i * rh;
      s += txt(x0 - 8, y + 16, t, '', 'end') + bar(x0, y + 4, (n / max) * (x1 - x0), rh - 8, i, 'rp-pale') + bar(x0, y + 4, (c / max) * (x1 - x0), rh - 8, i, 'rp-acc');
    });
    return fig('Reports and notes by type', 2 + DOCS.length * rh + 22, s, key([['rp-k-pale', 'Listed in document_links'], ['rp-k-acc', 'Copied to this lakehouse']]))
      + `<div class="rp-rep-h">X-ray Chest 2 Views report · Radiology Report · patient ${PERSON}</div><pre class="rp-rep">${esc(REPORT)}</pre>`;
  }
  // 9. One patient's record: a lane per kind of event, a lane per medication, and the range slider under it
  const LANES = ['Visits', 'Conditions', ...TIMELINE.drugs.map(([d]) => `Rx: ${d}`), 'Labs and vitals', 'Procedures', 'Imaging', 'Reports and notes'];
  const day = (s) => Date.parse(`${s}T00:00:00Z`);
  const T0 = Date.UTC(2014, 4, 12), T1 = Date.UTC(2026, 10, 12), Z0 = Date.UTC(2024, 8, 1);
  const TL = { x0: 170, x1: CW - 10, top: 4, lh: 22 };
  function timelineChart() {
    const { x0, x1, top, lh } = TL, h = LANES.length * lh;
    let s = `<g class="rp-tl-ticks"></g>`;
    LANES.forEach((l, i) => { s += hline(top + i * lh + lh / 2, x0, x1, 'rp-grid rp-faint') + txt(x0 - 8, top + i * lh + lh / 2 + 4, l, '', 'end'); });
    s += `<clipPath id="rpTlClip"><rect x="${x0}" y="${top}" width="${x1 - x0}" height="${h}"/></clipPath><g clip-path="url(#rpTlClip)">`;
    let k = 0;
    TIMELINE.drugs.forEach(([d, spans]) => {
      const y = top + LANES.indexOf(`Rx: ${d}`) * lh + lh / 2;
      spans.forEach(([a, b]) => { s += `<line class="rp-era" data-a="${day(a)}" data-b="${day(b)}" y1="${y}" y2="${y}" style="--i:${k++}"/>`; });
    });
    Object.entries(TIMELINE.lanes).forEach(([lane, days]) => {
      const y = top + LANES.indexOf(lane) * lh + lh / 2, img = lane === 'Imaging';
      days.forEach((dd) => {
        s += img ? `<path class="rp-ev rp-ev-img" data-t="${day(dd)}" data-y="${y}" style="--i:${k++ % 60}"/>`
          : `<circle class="rp-ev rp-ev-${lane.split(' ')[0].toLowerCase()}" data-t="${day(dd)}" cy="${y}" r="3.4" style="--i:${k++ % 60}"/>`;
      });
    });
    s += '</g>';
    // The range slider: the whole period in miniature, with the shown range between two handles
    const ry = top + h + 26;
    s += `<g class="rp-range"><rect class="rp-range-bg" x="${x0}" y="${ry}" width="${x1 - x0}" height="22"/>
      <rect class="rp-range-sel" y="${ry}" height="22"/><rect class="rp-range-h rp-range-l" y="${ry - 2}" width="6" height="26" rx="2"/><rect class="rp-range-h rp-range-r" y="${ry - 2}" width="6" height="26" rx="2"/></g>`;
    return fig(`The record of patient ${PERSON} (born 1966): 450 events and 10 medication periods`, ry + 30, s);
  }
  function layoutTimeline(root, a, b) {
    const { x0, x1, top, lh } = TL;
    const X = (t) => x0 + ((t - a) / (b - a)) * (x1 - x0);
    root.querySelectorAll('.rp-ev').forEach((el) => {
      const x = X(Number(el.dataset.t));
      if (el.tagName === 'path') { const y = Number(el.dataset.y); el.setAttribute('d', `M${x.toFixed(1)} ${y - 6}l6 6-6 6-6-6z`); } else el.setAttribute('cx', x.toFixed(1));
    });
    root.querySelectorAll('.rp-era').forEach((el) => { el.setAttribute('x1', X(Number(el.dataset.a)).toFixed(1)); el.setAttribute('x2', Math.max(X(Number(el.dataset.b)), X(Number(el.dataset.a)) + 3).toFixed(1)); });
    const span = (b - a) / 31557600000, h = LANES.length * lh;
    const first = new Date(a).getUTCFullYear() + 1, step = span > 6 ? 2 : 1;
    let ticks = '';
    for (let y = first; Date.UTC(y, 0, 1) < b; y += 1) {
      if (y % step) continue;
      const x = X(Date.UTC(y, 0, 1));
      ticks += vline(x, top, top + h) + txt(x, top + h + 15, y, 'rp-tm', 'middle');
    }
    root.querySelector('.rp-tl-ticks').innerHTML = ticks;
    const R = (t) => x0 + ((t - T0) / (T1 - T0)) * (x1 - x0);
    const sel = root.querySelector('.rp-range-sel');
    sel.setAttribute('x', R(a).toFixed(1)); sel.setAttribute('width', (R(b) - R(a)).toFixed(1));
    root.querySelector('.rp-range-l').setAttribute('x', (R(a) - 3).toFixed(1));
    root.querySelector('.rp-range-r').setAttribute('x', (R(b) - 3).toFixed(1));
  }

  /* ---- The Cohort requests folder in the workspace ---- */
  const ITEMS = [
    ['rayfin.svg', 'cohort-approval', 'App', 'Review, approve and deliver cohort data requests'],
    ['pipeline.svg', 'Cohort_Delivery_Pipeline', 'Data pipeline', 'Delivers an approved cohort data request (started from the approval app).'],
    ['lakehouse.svg', LAKEHOUSE, 'Lakehouse', `Approved cohort data request 1005: ${TITLE}`],
    ['lakehouse.svg', 'Delivery_QM1006_Type2DiabetesNeverPrescribed_Demo', 'Lakehouse', 'Approved cohort data request 1006: Type 2 diabetes, never prescribed metformin'],
    ['notebook.svg', NOTEBOOK, 'Notebook', `Explore the data delivered for request 1005: ${TITLE}`],
    ['notebook.svg', 'Explore_QM1006_Type2DiabetesNeverPrescribed_Demo', 'Notebook', 'Explore the data delivered for request 1006: Type 2 diabetes, never prescribed metformin'],
  ];
  function folderView() {
    return `<div class="cd-win rp-win-folder">
      <div class="cd-url"><span class="cd-url-text">app.fabric.microsoft.com/groups/${WORKSPACE_ID}/list</span><span class="cd-url-note">Microsoft Fabric, the workspace</span></div>
      <header class="fx-top"><img src="${ICON}fabric.svg" alt="" width="20" height="20">
        <span class="fx-crumb">MedicalCohortDemo</span><span class="fx-sep">/</span><img src="${ICON}folder.svg" alt="" width="16" height="16"><span class="fx-crumb fx-cur">Cohort requests</span></header>
      <div class="fx-ribbon"><span class="fx-rb">+ New item</span><span class="fx-rb">New folder</span><span class="fx-rb">Import</span></div>
      <div class="rp-list"><table class="fx-grid rp-items"><thead><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead><tbody>
        ${ITEMS.map(([icon, name, type, desc]) => `<tr class="${name === NOTEBOOK ? 'rp-row-nb' : ''}"><td><img src="${ICON}${icon}" alt="" width="18" height="18"><span class="fx-name">${esc(name)}</span></td><td>${type}</td><td><span class="fx-name">${esc(desc)}</span></td></tr>`).join('')}
      </tbody></table></div>
    </div>`;
  }

  /* ---- The notebook: Fabric's editor with the lakehouse attached and the notebook's cells ---- */
  const code = (lines) => esc(lines.join('\n'));
  const CELLS = [
    ['md', `<h1>Explore the data delivered for: ${esc(TITLE)}</h1><p>This notebook comes with the delivery and reads the lakehouse <b>${LAKEHOUSE}</b>, attached on the left. Select <b>Run all</b>; it takes about a minute. The tables are OMOP CDM v5.4 (a limited data set, without names, MRNs or note text). The images are read through OneLake shortcuts to the imaging archive, and the reports are copies.</p>`],
    ['code', 'params', [`WORKSPACE_ID = '${WORKSPACE_ID}'`, "LAKEHOUSE_ID = '…'", `LAKEHOUSE_NAME = '${LAKEHOUSE}'`], ''],
    ['code', 'setup', ['import io, json, os, subprocess, sys', 'from concurrent.futures import ThreadPoolExecutor'], `<pre class="rp-print">18 tables from ${LAKEHOUSE} (attached lakehouse), 25 patients</pre>`],
    ['md', '<h2>1. What was delivered</h2>'],
    ['code', 'delivered', ['tables = json.loads(manifest.tables)', 'demo = (f" Demo mode: {PATIENTS} of the cohort\'s {int(manifest.cohort_patients)} patients, "'],
      `<p class="rp-mdout">Request 1005, approved by ${ME} on 2026-11-05 07:36 UTC and delivered 2026-11-05 07:38 UTC. 25 patients, 14,265 rows in 19 tables. Demo mode: 25 of the cohort’s 358 patients, 5 of 47 imaging studies and 20 of 166 documents.</p>${rowsChart()}`],
    ['md', '<h2>2. Who is in the cohort</h2><p>Hover over a bar for the count; select a legend entry to hide it.</p>'],
    ['code', 'people', ['people = sql("""', "    SELECT p.person_id, g.concept_name AS sex, coalesce(r.concept_name, 'Unknown') AS race, p.year_of_birth,"], peopleChart()],
    ['md', '<h2>3. Conditions</h2><p>From <code>condition_era</code>, the OMOP table that merges repeated diagnoses of the same condition into periods. The second chart shows which conditions go together.</p>'],
    ['code', 'conditions', ['conditions = sql("""', '    SELECT DISTINCT e.person_id, c.concept_name AS condition'], conditionsChart() + togetherChart()],
    ['md', '<h2>4. Medications</h2><p>From <code>drug_era</code>, one period per active ingredient. Darker cells mean more patients on that medication in that year.</p>'],
    ['code', 'medications', ['eras = sql("""', '    SELECT e.person_id, c.concept_name AS drug, year(e.drug_era_start_date) AS first_year,'], medsChart()],
    ['md', '<h2>5. Labs and vitals</h2><p>From <code>measurement</code>. Each point in the first chart is one patient’s latest result; the second follows one result over time, a grey line per patient.</p>'],
    ['code', 'labs', ['values = sql("""', "    SELECT m.person_id, m.measurement_concept_id, c.concept_name AS lab, coalesce(m.unit_source_value, '') AS unit,"], labsChart()],
    ['md', '<h2>6. Care over time</h2>'],
    ['code', 'visits', ['visits = sql("""', "    SELECT year(v.visit_start_date) AS year, coalesce(c.concept_name, 'Other') AS visit, count(*) AS visits"], visitsChart()],
    ['md', '<h2>7. Imaging</h2><p><code>image_occurrence</code> lists every study; the ones with images in the archive are linked into this lakehouse under <code>Files/dicom</code> as OneLake shortcuts, so the images are read where the archive keeps them.</p>'],
    ['code', 'imaging', ['studies = sql("""', '    SELECT modality_source_value AS modality,'], imagingChart()],
    ['md', '<h3>A CT study</h3><p>Drag the slider, or press play, to move through the slices. The orange outline is the study’s largest nodule as the LIDC radiologists drew it (DICOM segmentations stored with the study).</p>'],
    ['code', 'ct', ['def lung_window(ds, centre=-600, width=1500):', '    hu = ds.pixel_array * float(ds.get("RescaleSlope", 1)) + float(ds.get("RescaleIntercept", 0))'], ctViewer()],
    ['md', '<h3>Every other kind of image</h3>'],
    ['code', 'gallery', ['def picture(ds):', '    """An 8-bit RGB picture of a DICOM image (the middle frame of a multi-frame one)."""'], galleryOut()],
    ['md', '<h2>8. Reports and notes</h2><p><code>document_links</code> lists the cohort’s documents; the ones in this delivery are copied under <code>Files/documents</code>. Below is one report for the same patient as the CT, when there is one.</p>'],
    ['code', 'documents', ['docs = sql("""', '    SELECT DocumentType AS type, count(*) AS documents, count(document_url) AS copied'], docsOut()],
    ['md', '<h2>9. One patient’s record</h2><p>Every event for one patient (the patient whose CT is shown above), from all the tables joined on <code>person_id</code>. Drag the bar under the chart to change the period.</p>'],
    ['code', 'timeline', ['person = STORY_PERSON or int(sql("""', '    SELECT person_id FROM measurement GROUP BY 1 ORDER BY count(*) DESC LIMIT 1""").person_id[0])'], timelineChart()],
  ];
  const CODE_CELLS = CELLS.filter((c) => c[0] === 'code').length;
  function notebook() {
    const cells = CELLS.map(([kind, a, lines, out]) => (kind === 'md' ? `<div class="rp-cell rp-md">${a}</div>`
      : `<div class="rp-cell rp-code" data-cell="${a}"><div class="rp-gut"><span class="rp-run"></span><span class="rp-n">[ ]</span></div>
          <pre class="rp-src">${code(lines)}</pre>${out ? `<div class="rp-out">${out}</div>` : ''}</div>`)).join('');
    return `<div class="cd-win rp-win-nb">
      <div class="cd-url"><span class="cd-url-text">app.fabric.microsoft.com/groups/${WORKSPACE_ID}/synapsenotebooks/…</span><span class="cd-url-note">Microsoft Fabric, the Explore notebook</span></div>
      <header class="fx-top"><img src="${ICON}fabric.svg" alt="" width="20" height="20">
        <span class="fx-crumb">MedicalCohortDemo</span><span class="fx-sep">/</span><span class="fx-crumb">Cohort requests</span><span class="fx-sep">/</span>
        <img src="${ICON}notebook.svg" alt="" width="18" height="18"><span class="fx-crumb fx-cur">${NOTEBOOK}</span>
        <span class="cd-top-gap"></span><span class="rp-sess"><i></i><span class="rp-sess-t">Not connected</span></span><span class="rp-env">Python 3.11</span></header>
      <div class="fx-ribbon"><span class="fx-tab on">Home</span><span class="fx-rb rp-runall"><svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M3 1.8v8.4L10 6z"/></svg>Run all</span><span class="fx-rb">Stop session</span><span class="fx-rb">Language: Python</span></div>
      <div class="fx-body rp-nb-body">
        <aside class="fx-explorer"><div class="fx-pane-h">Explorer</div>
          <div class="rp-xh">Data items</div>
          <div class="fx-row fx-root rp-lh"><img src="${ICON}lakehouse.svg" alt="" width="16" height="16"><span class="fx-name">${LAKEHOUSE}</span></div>
          <div class="rp-default">Default lakehouse</div>
          <div class="fx-row fx-group"><span class="fx-tw">⌄</span><span>Tables</span><span class="fx-n">20</span></div>
          ${TABLES.map((t) => `<div class="fx-row fx-leaf rp-t" data-t="${t}"><svg class="fx-ico" viewBox="0 0 20 20" aria-hidden="true">${TABLE_PATH}</svg><span class="fx-name">${t}</span></div>`).join('')}
          <div class="fx-row fx-group"><span class="fx-tw">⌄</span><span>Files</span></div>
          <div class="fx-row fx-leaf"><img src="${ICON}folder.svg" alt="" width="16" height="16"><span class="fx-name">dicom</span></div>
          <div class="fx-row fx-leaf"><img src="${ICON}folder.svg" alt="" width="16" height="16"><span class="fx-name">documents</span></div>
        </aside>
        <main class="rp-main"><div class="rp-cells">${cells}</div></main>
      </div>
    </div>`;
  }
  const TABLE_PATH = '<path d="M5.5 17A2.5 2.5 0 0 1 3 14.5v-9A2.5 2.5 0 0 1 5.5 3h9A2.5 2.5 0 0 1 17 5.5v9a2.5 2.5 0 0 1-2.5 2.5zM16 7V5.5a1.5 1.5 0 0 0-1.356-1.493L14.5 4H13v3zm-4-3H8v3h4zM7 4H5.5a1.5 1.5 0 0 0-1.493 1.356L4 5.5V7h3zM4 8v6.5a1.5 1.5 0 0 0 1.356 1.493L5.5 16h9a1.5 1.5 0 0 0 1.493-1.356L16 14.5V8z"/>';
  const SHORTCUT_PATH = '<path d="M17 11a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2zm-3.5 2a.5.5 0 0 0 0 1h1.793l-2.146 2.146a.5.5 0 0 0 .707.707L16 14.707V16.5a.5.5 0 0 0 1 0v-3a.5.5 0 0 0-.5-.5z"/><path d="M6.982 3c.464 0 .91.185 1.238.513L9.707 5H15.5A2.5 2.5 0 0 1 18 7.5v2.674A3 3 0 0 0 17 10V7.5A1.5 1.5 0 0 0 15.5 6H9.707l-1.56 1.56A1.5 1.5 0 0 1 7.085 8H3v6.5A1.5 1.5 0 0 0 4.5 16H10v1H4.5A2.5 2.5 0 0 1 2 14.5v-9A2.5 2.5 0 0 1 4.5 3zM4.5 4A1.5 1.5 0 0 0 3 5.5V7h4.086a.5.5 0 0 0 .353-.146L8.793 5.5l-1.28-1.28a.75.75 0 0 0-.53-.22z"/>';

  /* ---- What the notebook reads, under the screen: the delivery lakehouse it is attached to, in OneLake, and the
     imaging archive its DICOM shortcuts point to ---- */
  const part = (on, live, d = 0) => `data-on="${on}" data-live="${live}" style="--d:${d}s"`;
  const R3 = [112, 158, 204], RH = 38, BAND = [18, 240], LH = [280, 652], SUB = [296, 636], ARCH = [14, 214], NB = [752, 998];
  function flowMap() {
    const glyph = (p) => `<g class="dv-glyph" transform="translate(10 10) scale(0.9)">${p}</g>`;
    const subs = [[glyph(TABLE_PATH), 'Tables', '20 Delta tables, queried with DuckDB', '1,2,5'],
      [glyph(SHORTCUT_PATH), 'Files/dicom', '5 study shortcuts, read with pydicom', '3,4'],
      [image('folder.svg', 10, 10, 18), 'Files/documents', '20 copied reports and notes', '4']];
    const box = `<g class="dv-dlv" ${part(0, '0')}><rect class="dv-dlv-box" x="${LH[0] + 0.75}" y="40" width="${LH[1] - LH[0] - 1.5}" height="186" rx="4"/>
        ${image('lakehouse.svg', LH[0] + 14, 50, 18)}<text class="dv-iname" x="${LH[0] + 40}" y="64">${LAKEHOUSE}</text>
        <text class="u-meta" x="${LH[0] + 40}" y="80">The notebook’s default lakehouse</text>
        ${subs.map(([g, name, meta, live], i) => `<g class="dv-sub" ${part(0, live)} transform="translate(${SUB[0]} ${R3[i] - RH / 2})">
          <rect x="0.5" y="0.5" width="${SUB[1] - SUB[0] - 1}" height="${RH - 1}" rx="3"/>${g}
          <text class="dv-iname" x="36" y="16">${name}</text><text class="u-meta" x="36" y="30">${meta}</text></g>`).join('')}</g>`;
    const arch = `<g class="dv-item" ${part(3, '3,4', 0.4)} transform="translate(${ARCH[0]} ${R3[1] - RH / 2})">
        <rect x="0.5" y="0.5" width="${ARCH[1] - ARCH[0] - 1}" height="${RH - 1}" rx="3"/>${image('lakehouse.svg', 10, 10, 18)}
        <text class="dv-iname" x="36" y="16">Bronze_ImagingArchive</text><text class="u-meta" x="36" y="30">The DICOM files</text></g>`;
    const shortcut = `<g class="dv-lane dv-short" ${part(3, '3,4', 0.8)}>
        <line x1="${SUB[0] - 4}" y1="${R3[1]}" x2="${ARCH[1] + 4}" y2="${R3[1]}"/><path class="dv-head" d="M${ARCH[1] + 10} ${R3[1] - 4}L${ARCH[1] + 4} ${R3[1]}l6 4"/>
        <text class="u-meta dv-lane-label" x="${(ARCH[1] + SUB[0]) / 2}" y="${R3[1] - 8}" text-anchor="middle">shortcuts</text></g>`;
    // Reads: from each part of the lakehouse into the notebook, joining before it
    const ex = 712, end = NB[0] - 4, cy = R3[1];
    const lane = (i, on, live, d) => {
      const y = R3[i];
      const path = y === cy ? `M${SUB[1] + 4} ${y}H${end}` : `M${SUB[1] + 4} ${y}H${ex - 8}Q${ex} ${y} ${ex} ${y + (y < cy ? 8 : -8)}V${cy}H${end}`;
      return `<g class="dv-lane dv-copy" ${part(on, live, d)}><path d="${path}" pathLength="1"/><path class="dv-head" d="M${end - 6} ${cy - 4}L${end} ${cy}l-6 4"/>
        ${[0, 0.9].map((o) => `<g transform="translate(${SUB[1] + 8} ${y - 4.5})"><g class="dv-row" style="--dx:${ex - SUB[1] - 30}px;--o:${o}s"><rect width="12" height="9" rx="1.5"/><path d="M2.5 3h7M2.5 6h7"/></g></g>`).join('')}</g>`;
    };
    const node = `<g class="dv-node" ${part(0, '0,1,2,3,4,5')} transform="translate(${NB[0]} ${cy - 32})">
        <rect x="0.75" y="0.75" width="${NB[1] - NB[0] - 1.5}" height="62.5" rx="4"/>${image('notebook.svg', 14, 16, 30)}
        <text class="u-name dv-node-name" x="54" y="28">Explore_QM1005_…_Demo</text><text class="u-meta" x="54" y="45">Python notebook, Plotly charts</text></g>`;
    return `<svg class="u-svg dv-svg" viewBox="0 0 1000 ${BAND[1] + 4}" aria-hidden="true">
      <rect class="dv-band" x="0.75" y="${BAND[0]}" width="${LH[1] + 16}" height="${BAND[1] - BAND[0]}" rx="6"/>
      ${legend(12, BAND[0], [['icon', 'onelake.svg', 18, 6], ['text', 'OneLake', 5, 0]], 'u-legend-panel')}
      ${box}${arch}${shortcut}${lane(0, 1, '1,2,5', 0.6)}${lane(1, 3, '3,4', 1.2)}${lane(2, 4, '4', 1.2)}${node}
    </svg>`;
  }
  const flowHost = document.getElementById('rpFlow');
  flowHost.innerHTML = flowMap();
  const fsvg = flowHost.querySelector('svg');
  fitLegends(fsvg);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitLegends(fsvg));
  const fparts = [...fsvg.querySelectorAll('[data-on]')];
  function setFlow(n) {
    fsvg.dataset.stage = String(n);
    fparts.forEach((el) => {
      const on = Number(el.dataset.on), live = el.dataset.live ? el.dataset.live.split(',').map(Number) : [];
      el.classList.toggle('is-on', n >= on);
      el.classList.toggle('is-now', n === on);
      el.classList.toggle('is-live', live.includes(n));
    });
  }

  /* ---- Scenes ---- */
  const ledgerEl = document.getElementById('rpLedger');
  const LEDGER0 = { cells: `<b>0</b> of ${CODE_CELLS} cells`, patients: '<b>–</b> patients', images: '<b>–</b> images' };
  const ledger = (c, k, html) => { c.guard(); setLedger(ledgerEl, k, html, c.animate); };
  let stage = null, y = 0, ran = 0;
  const $ = (sel) => stage.querySelector(sel);

  async function scrollTo(c, sel, ms = 900, margin = 14) {
    const main = $('.rp-main'), el = $(sel);
    y = Math.max(0, y + c.top(main, el) - margin);
    await c.scroll($('.rp-cells'), y, ms);
  }
  // A code cell runs: [*] and a spinner, then a tick, its execution count and its output
  async function run(c, cell, ms) {
    const el = $(`.rp-code[data-cell="${cell}"]`);
    c.guard();
    el.classList.add('is-running');
    el.querySelector('.rp-n').textContent = '[*]';
    await c.wait(ms);
    el.classList.remove('is-running');
    el.classList.add('is-done');
    el.querySelector('.rp-n').textContent = `[${++ran}]`;
    ledger(c, 'cells', `<b>${ran}</b> of ${CODE_CELLS} cells`);
  }
  function session(state) {
    const s = $('.rp-sess');
    s.dataset.state = state;
    s.querySelector('.rp-sess-t').textContent = { starting: 'Starting session', ready: 'Connected' }[state];
  }
  function showSlice(i) {
    const n = CT.positions.length;
    stage.querySelectorAll('.rp-ct-img').forEach((el) => { el.style.backgroundPositionX = `${(i / (n - 1)) * 100}%`; });
    $('.rp-knob').style.left = `${(i / (n - 1)) * 100}%`;
    $('.rp-pos').textContent = `${CT.positions[i].toFixed(1)} mm`;
  }

  const SCENES = [
    // 1. The folder, then the notebook opens with its lakehouse attached
    async (c) => {
      y = 0; ran = 0; setFlow(0);
      await c.wait(700);
      const row = $('.rp-row-nb');
      await c.point(row.querySelector('.fx-name'), 900, 0.3);
      row.classList.add('sel');
      await c.click(row);
      c.hide();
      stage.classList.add('is-nb');
      await c.wait(1300);
      $('.rp-lh').classList.add('sel');
    },
    // 2. Run all: the session starts, the setup cell, the rows delivered and the cohort
    async (c) => {
      setFlow(1);
      const btn = $('.rp-runall');
      await c.point(btn, 700);
      await c.click(btn);
      c.hide();
      session('starting');
      await c.wait(1800);
      session('ready');
      await run(c, 'params', 300);
      await run(c, 'setup', 900);
      ledger(c, 'patients', '<b>25</b> patients');
      await scrollTo(c, '.rp-code[data-cell="delivered"]', 700);
      await run(c, 'delivered', 900);
      await c.wait(1300);
      await scrollTo(c, '.rp-code[data-cell="people"]');
      await run(c, 'people', 800);
    },
    // 3. Conditions, medications and labs
    async (c) => {
      setFlow(2);
      await scrollTo(c, '.rp-code[data-cell="conditions"]');
      await run(c, 'conditions', 900);
      await c.wait(1200);
      await scrollTo(c, '.rp-code[data-cell="conditions"] .rp-fig + .rp-fig', 800);
      await c.wait(1200);
      await scrollTo(c, '.rp-code[data-cell="medications"]', 800);
      await run(c, 'medications', 700);
      await c.wait(600);
      await scrollTo(c, '.rp-code[data-cell="labs"]', 800);
      await run(c, 'labs', 800);
    },
    // 4. Visits, imaging and the CT viewer played through the slices
    async (c) => {
      setFlow(3);
      await scrollTo(c, '.rp-code[data-cell="visits"]', 700);
      await run(c, 'visits', 600);
      await c.wait(500);
      await scrollTo(c, '.rp-code[data-cell="imaging"]', 800);
      await run(c, 'imaging', 800);
      await c.wait(1200);
      await scrollTo(c, '.rp-code[data-cell="ct"]', 800);
      await run(c, 'ct', 1600);
      ledger(c, 'images', '<b>8</b> CT slices');
      const play = $('.rp-play');
      await c.point(play, 700);
      await c.click(play);
      c.hide();
      for (let i = 1; i < CT.positions.length; i++) { await c.wait(520); showSlice(i); }
      await c.wait(500);
      const tick = stage.querySelectorAll('.rp-tick')[3];
      await c.point(tick, 650, 0.5, 0.1);
      await c.click(tick);
      showSlice(3);
      c.hide();
    },
    // 5. One image of every other kind, then the reports and the CT patient's chest X-ray report
    async (c) => {
      setFlow(4);
      await scrollTo(c, '.rp-code[data-cell="gallery"]', 800);
      await run(c, 'gallery', 1000);
      ledger(c, 'images', '<b>11</b> images');
      await c.wait(1500);
      await scrollTo(c, '.rp-code[data-cell="documents"]', 800);
      await run(c, 'documents', 700);
      await c.wait(900);
      await scrollTo(c, '.rp-rep-h', 900, 60);
    },
    // 6. One patient's record, then the range narrowed to the months around the CT
    async (c) => {
      setFlow(5);
      await scrollTo(c, '.rp-code[data-cell="timeline"]', 900);
      await run(c, 'timeline', 900);
      await c.wait(1300);
      const root = $('.rp-code[data-cell="timeline"]'), handle = $('.rp-range-l');
      await c.point(handle, 700, 0.5, 0.5);
      // The pointer drags the left handle: it follows the handle as the range narrows
      await c.tween(1800, (p) => {
        layoutTimeline(root, T0 + (Z0 - T0) * p, T1);
        if (c.animate) c.point(handle, 0, 0.5, 0.5).catch(() => {});
      });
      await c.wait(600);
      c.hide();
    },
  ];

  replica({
    card, view: document.getElementById('rpView'), W, H, stageClass: 'rp-stage', html: () => folderView() + notebook(),
    scenes: SCENES, steps: STEPS, hold: HOLD,
    chips: document.getElementById('rpSteps'), playBtn: document.getElementById('rpPlay'), cap: document.getElementById('rpCap'),
    onStage: (el) => { stage = el; },
    onReset: () => {
      y = 0; ran = 0;
      setFlow(-1);
      layoutTimeline(stage.querySelector('.rp-code[data-cell="timeline"]'), T0, T1);
      Object.entries(LEDGER0).forEach(([k, html]) => setLedger(ledgerEl, k, html, false));
    },
  });
})();
