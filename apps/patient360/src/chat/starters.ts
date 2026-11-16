/**
 * Suggested questions, by who would ask them. Each names what it shows. The facts they lean on (names, counts,
 * sizes) are the demo patients' (apps/patient360/demo_patients.json); chat/QUESTIONS.md lists them with what a good
 * answer contains, and chat/dev/cases.py tests them.
 */
export type Starter = { q: string; why: string };
export type Role = { id: string; label: string; starters: Starter[] };

export const ROLES: Role[] = [
  {
    id: 'oncology',
    label: 'Oncology',
    starters: [
      {
        q: "Walk me through Stephan Rutherford's two cancers on one timeline: diagnosis, pathology, treatment and outcome.",
        why: 'Lifetime timeline, both slides and the treatment courses',
      },
      {
        q: 'Levi Hills had a screening CT a year before his lung cancer was diagnosed. Show the nodules on that CT and the biopsy slide that confirmed it.',
        why: 'From screening CT to the pathology slide',
      },
      {
        q: 'Line up the lung cancer patients in the demo at their diagnosis. What imaging and treatment did each have before and after?',
        why: 'Several patients on one timeline, aligned on diagnosis',
      },
      {
        q: 'Cassie Heidenreich had breast cancer in 1993 and colon cancer in 2018. Draft a tumour board note that covers both.',
        why: 'A note drafted from the record, added only if you choose',
      },
      {
        q: 'Compare the treatment of Betty Feeney and Karly Lakin for breast cancer, and what imaging each had afterwards.',
        why: 'Two patients side by side: cancer course and imaging',
      },
    ],
  },
  {
    id: 'radiology',
    label: 'Radiology',
    starters: [
      {
        q: "Show me Annis Stracke's CT with all fifteen nodules. Which lobes are they in, and how big is the largest?",
        why: 'The scan viewer with the radiologists’ outlines',
      },
      {
        q: "Open Bret Collier's CT on the 44.9 mm nodule and tell me how the radiologists rated it.",
        why: 'Centred on one nodule, with texture and malignancy ratings',
      },
      {
        q: 'Karly Lakin has every kind of image. Show her brain MRI, chest X-ray and CT in date order and say what each report found.',
        why: 'MRI, X-ray and CT viewers with their reports',
      },
      {
        q: 'Across all patients, how many have an outlined lung nodule of 20 mm or more, and in which lobes are those nodules?',
        why: 'A count across the PACS, drawn as a chart',
      },
      {
        q: "Open Stephan Rutherford's whole-body PET/CT as a maximum-intensity projection with the expert lesion masks. How many lesions are there, and what is the highest SUV?",
        why: 'PET MIP with lesion masks and the SUV scale',
      },
      {
        q: "Play Stephan Rutherford's 4D CT through one breath. How far does the tumour move, and how much does his lung volume change?",
        why: 'A breathing CT, ten phases with the tumour outlined',
      },
      {
        q: "Show the brain fibre-tract atlas on Stephan Rutherford's record with only the projection fibres. Which pathways run from the cortex to the spinal cord?",
        why: 'The projection bundles, with the cortical areas each reaches',
      },
      {
        q: "Stephan Rutherford had a stroke in March 2003. On the brain fibre-tract atlas in his record, show the motor and sensory pathways that pass through the internal capsule, each in its own colour, and say what each one connects.",
        why: 'The pathways a capsular stroke can reach, from the atlas',
      },
      {
        q: "Show the optic radiations in the brain fibre-tract atlas on Stephan Rutherford's record, each in its own colour, with the left one's probability map on the slices. Which cortical areas do they reach?",
        why: 'Two bundles in colour and a probability map over the template brain',
      },
      {
        q: "Show the corpus callosum in the brain fibre-tract atlas on Stephan Rutherford's record with the probability map of its forceps major. How large is each of its four parts across the 1,065 people?",
        why: 'The corpus callosum, its parts sized across 1,065 people',
      },
      {
        q: "Open Stephan Rutherford's planning 4D CT at full size beside the cone-beam CTs from his first and last day of radiotherapy. How many scans were taken during the course?",
        why: 'The planning CT at its original resolution beside two treatment-day scans',
      },
    ],
  },
  {
    id: 'pathology',
    label: 'Pathology',
    starters: [
      {
        q: 'Show the slide that confirmed Levi Hills’ lung cancer next to its pathology report.',
        why: 'The deep-zoom slide beside the report text',
      },
      {
        q: "Andres Barrows' pathology report is a scanned document. Show it beside the slide it describes.",
        why: 'The slide beside the scanned report and its text',
      },
      {
        q: 'Compare the tumour-infiltrating lymphocytes on the slides of the two research patients with lung cancer.',
        why: 'Slides with AI lymphocyte maps, side by side',
      },
      {
        q: 'How many patients have an H&E slide online for each cancer type?',
        why: 'A count across the PACS and the problem list',
      },
      {
        q: "Show Ivelisse Nitzsche's breast cancer slide with the AI nuclei and immune-cell layers on, and its pathology report beside it.",
        why: 'An H&E case with AI layers, its filmstrip and the report',
      },
      {
        q: "On Ivelisse Nitzsche's 36-marker colon cancer image, show pan-cytokeratin with CD8a and CD45. Where do the T cells sit against the tumour?",
        why: 'Multiplex fluorescence, channels chosen by the question',
      },
    ],
  },
  {
    id: 'primary',
    label: 'Primary care',
    starters: [
      {
        q: 'Summarise Kaley Witting’s record for a new GP: her long-term conditions, current medications and the results to watch.',
        why: 'The longest record: 737 visits and 1,512 results',
      },
      {
        q: 'Kaley Witting has diabetes with kidney disease. Chart her creatinine and blood pressure over the last ten years and list the medications she takes for them.',
        why: 'Results over time, with the medications behind them',
      },
      {
        q: 'Which conditions and medications did Stanley Bernhard have when his lung cancer was diagnosed, and how did his blood pressure change after?',
        why: 'The record before and after a diagnosis',
      },
      {
        q: 'Compare blood pressure and cholesterol across the demo patients with breast cancer.',
        why: 'One line per patient in each panel',
      },
    ],
  },
  {
    id: 'research',
    label: 'Research',
    starters: [
      {
        q: "Nicky Walker's endometrial cancer has 13,853 mutations. Show her tumour genome and explain what POLE has to do with it.",
        why: 'The genome view against the same cancer in TCGA',
      },
      {
        q: "Compare Jettie Osinski's EGFR-mutant lung adenocarcinoma with Damian Macejkovic's squamous cell lung cancer: genomes, slides and treatment.",
        why: 'Two research patients side by side: genome, slide and registry',
      },
      {
        q: "Stephan Rutherford had lung and prostate cancer. Put the two tumours' genomes side by side: what drives each, and how do they compare with other tumours of the same kind?",
        why: 'Two genomes from one hospital patient, from the TCGA cases behind his slides',
      },
      {
        q: 'Among hospital patients with a sequenced colorectal tumour, how many carry a KRAS mutation and how many are MSI-high? List the MSI-high patients.',
        why: 'Mutations counted across 756 tumour genomes',
      },
      {
        q: 'Which research patients have the highest tumour mutation burden, and how long did each live after diagnosis?',
        why: 'Genomics and outcomes for the 15 TCGA cases',
      },
      {
        q: 'Find patients with breast cancer who also have a chest CT with outlined nodules, and show them side by side.',
        why: 'A search across Epic and the PACS, added to the conversation',
      },
      {
        q: "Put Jettie Osinski's diagnostic slide with the AI lymphocyte map beside her CT with the AI segmentation. What do the two say about her tumour?",
        why: 'Slide and CT side by side, each with its AI layer',
      },
      {
        q: "Ivelisse Nitzsche's record carries the fetal brain atlas from her 2016 pregnancy. Open it at week 21 and explain how the brain changes by week 36.",
        why: 'A population atlas, played week by week',
      },
      {
        q: "In the brain fibre-tract atlas on Stephan Rutherford's record, compare the left and right arcuate fasciculus. Which is larger across the 1,065 people, and which language areas does each reach? Put the left one's probability map on the slices.",
        why: 'Two bundles of the atlas with the connectome, volumes across people and a probability map',
      },
      {
        q: "On the fetal brain atlas in Ivelisse Nitzsche's record, show the FA map at week 24 and at week 36 side by side. How does white-matter FA change between them?",
        why: 'Diffusion maps from the full atlas, two weeks side by side',
      },
    ],
  },
  {
    id: 'data',
    label: 'Data',
    starters: [
      {
        q: 'How many patients have each kind of image online: chest CT, brain MRI, X-ray and pathology slide?',
        why: 'Counts from the PACS index',
      },
      {
        q: 'Show me one of Annmarie Hickle’s scanned documents beside its text, with the facts it was written from.',
        why: 'A scanned PDF, its text and its facts',
      },
      {
        q: 'Where does each part of Stephan Rutherford’s record come from? Name the system and the tables.',
        why: 'Epic Clarity, the PACS database, the documents lakehouse',
      },
      {
        q: 'Of the patients with a chest CT online, how many also have a pathology slide, and which cancers do they have?',
        why: 'Two kinds of image joined to the problem list',
      },
    ],
  },
];

/** When the conversation has patients in it. */
export const FOR_PATIENTS: Starter[] = [
  {
    q: 'Compare these patients on one timeline, aligned at their first cancer diagnosis.',
    why: 'One row per patient',
  },
  {
    q: 'What do these patients have in common, and where do they differ?',
    why: 'Conditions, medications, imaging and pathology',
  },
  {
    q: 'Show the imaging each of these patients has online.',
    why: 'Their images side by side',
  },
];

/** The side panel, by what was right-clicked (`text` is what the panel was told about it). */
export function panelStarters(tab: string, hasItem: boolean, text = ''): string[] {
  const nodules = /nodules? outlined/i.test(text);
  const item: Record<string, string[]> = {
    radiology: [
      'What did this study find?',
      nodules ? 'Show this scan with the nodules outlined' : 'Open the report for this study',
      'Has anything changed since the previous study?',
    ],
    pathology: ['What does the pathology report say about this slide?', 'Show this slide beside its report'],
    documents: ['Summarise this document', 'Show the facts this document was written from'],
    measurements: ['How has this changed over time?', 'Which results here are out of range?'],
    visits: ['Why was this visit?', 'What changed at this visit?'],
    conditions: ['When did this start, and what treats it?', 'Show this on the timeline'],
    medicines: ['What is this medication for, and for how long?', 'Which results changed after it started?'],
    cancer: ['Summarise the cancer course', 'Show the treatment on the timeline'],
    treatment: ['Summarise the cancer treatment', 'Which results changed during treatment?'],
    genomics: ['Which alterations are drivers?', 'How does this tumour compare with others of its type?'],
    notes: ['Draft a tumour board note for this patient'],
    summary: ['Summarise this patient for a tumour board', 'What are the key events in this record?'],
  };
  return [hasItem ? 'Explain this' : 'Summarise this patient', ...(item[tab] ?? item.summary)].slice(0, 4);
}
