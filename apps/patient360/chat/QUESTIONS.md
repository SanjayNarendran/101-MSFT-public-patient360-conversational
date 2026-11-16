# Ask: suggested questions

The questions on the Ask tab, by who would ask them (they live in [src/chat/starters.ts](../src/chat/starters.ts)), with
what a good answer shows and the record facts it rests on. [dev/cases.py](dev/cases.py) reads the same file, so every
question here is also a test case; [TESTING.md](TESTING.md) has the results.

All patients are demo patients (see [demo_patients.json](../demo_patients.json)). The hospital patients are
synthetic (Synthea Coherent, reshaped into Epic tables); the research patients are real TCGA cases with synthetic
names.

Comparisons are answered side by side: one card with a column per thing compared (two CTs, two genomes, a slide and
its report), each the record's own viewer, and a table of the differences under them (`show_side_by_side`). In the
narrow side panel the columns stack.

## Oncology

| Question | A good answer shows | Rests on |
| --- | --- | --- |
| Walk me through Stephan Rutherford's two cancers on one timeline: diagnosis, pathology, treatment and outcome. | His lifetime timeline; both slides; the treatment courses | Carcinoma in situ of the prostate (January 2017) and stage 1 non-small cell lung cancer (March 2018), each with a slide and report; cisplatin, paclitaxel, docetaxel, leuprolide; died October 2019 |
| Levi Hills had a screening CT a year before his lung cancer was diagnosed. Show the nodules on that CT and the biopsy slide that confirmed it. | The CT centred on the 16.2 mm nodule; the lung slide | Screening CT November 2019 with 10 outlined nodules; stage 1 NSCLC a year later |
| Line up the lung cancer patients in the demo at their diagnosis. What imaging and treatment did each have before and after? | One row per patient, aligned on the lung cancer diagnosis | Stephan Rutherford, Levi Hills, Stanley Bernhard (Epic); Jettie Osinski, Damian Macejkovic (TCGA) |
| Cassie Heidenreich had breast cancer in 1993 and colon cancer in 2018. Draft a tumour board note that covers both. | A draft note with the Add to the record button | Both cancers with slides and reports; oxaliplatin and leucovorin; died February 2021 |
| Compare the treatment of Betty Feeney and Karly Lakin for breast cancer, and what imaging each had afterwards. | Both cancer courses on one timeline; their imaging side by side | Betty Feeney: epirubicin and exemestane, slide June 2022, CT with five nodules. Karly Lakin: slide 2004, CT with three nodules in 2021 |

## Radiology

| Question | A good answer shows | Rests on |
| --- | --- | --- |
| Show me Annis Stracke's CT with all fifteen nodules. Which lobes are they in, and how big is the largest? | The CT with the radiologists' outlines; nodules by lobe | 15 nodules (6 left upper, 4 right upper, 4 right middle, 1 left lower); Nodule 6 is the largest, 12.3 mm |
| Open Bret Collier's CT on the 44.9 mm nodule and tell me how the radiologists rated it. | The CT centred on that nodule | January 2022 screening CT, four nodules, one 44.9 mm |
| Karly Lakin has every kind of image. Show her brain MRI, chest X-ray and CT in date order and say what each report found. | MRI, X-ray and CT viewers | MRI 1992, X-ray and CT 2021 |
| Across all patients, how many have an outlined lung nodule of 20 mm or more, and in which lobes are those nodules? | A chart of the count by lobe | PACS NoduleFinding |
| Open Stephan Rutherford's whole-body PET/CT as a maximum-intensity projection with the expert lesion masks. How many lesions are there, and what is the highest SUV? | The PET/CT in MIP with the lesion masks on | FDG-PET-CT-Lesions case PETCT_5e2da717db (lung cancer), August 2019 on his record: 54 lesions, 313.6 mL, SUVmax 65.5 |
| Play Stephan Rutherford's 4D CT through one breath. How far does the tumour move, and how much does his lung volume change? | The 4D CT in 3D with the tumour outlined and the breathing timeline | 4D-Lung case 100_HM10395, March 2018: ten phases, tumour moves 2.4 mm (measured on the native 0.98 × 0.98 × 3 mm grid), lung volume changes 843 mL |
| Show the brain fibre-tract atlas on Stephan Rutherford's record with only the projection fibres. Which pathways run from the cortex to the spinal cord? | The 34 projection bundles, one colour each, then the corticospinal tracts; said to be an atlas | HCP1065 (Yeh, 2022), 87 named bundles: the corticospinal tract reaches the atlas floor (z −54 mm, lower brainstem) and BA4 in 100% of people; the corticobulbar tract ends in the brainstem; the reticulospinal tract has no cortical end in the connectome |
| Stephan Rutherford had a stroke in March 2003. On the brain fibre-tract atlas in his record, show the motor and sensory pathways that pass through the internal capsule, each in its own colour, and say what each one connects. | The corticospinal, corticobulbar, medial lemniscus and superior thalamic radiation bundles, one colour each; said to be an atlas | The connectome's cortical areas for each (BA4 and BA6 for the motor tracts); his 20 March 2003 MRI report (chronic right MCA territory infarct) |
| Show the optic radiations in the brain fibre-tract atlas on Stephan Rutherford's record, each in its own colour, with the left one's probability map on the slices. Which cortical areas do they reach? | Both optic radiations, one colour each; the left one's probability map over the template | BA17 and BA18 in 100% of people on both sides; median volume 12.2 mL left, 11.3 mL right |
| Show the corpus callosum in the brain fibre-tract atlas on Stephan Rutherford's record with the probability map of its forceps major. How large is each of its four parts across the 1,065 people? | The corpus callosum alone with the forceps major's probability map | Median volumes across 1,065 people: body 126.8 mL, forceps minor 54.3, forceps major 47.8, tapetum 19.3 |
| Open Stephan Rutherford's planning 4D CT at full size beside the cone-beam CTs from his first and last day of radiotherapy. How many scans were taken during the course? | The planning 4D CT at full size beside the first and last cone-beam CT | 4D-Lung 100_HM10395: 33 cone-beam CTs over 46 days (18 March to 2 May 2018 on his record), 26 separate days |

## Pathology

| Question | A good answer shows | Rests on |
| --- | --- | --- |
| Show the slide that confirmed Levi Hills' lung cancer next to its pathology report. | The slide and the report side by side | Lung biopsy slide, December 2020 |
| Andres Barrows' pathology report is a scanned document. Show it beside the slide it describes. | The slide beside the scanned report, its text and facts | Prostate carcinoma in situ, April 2023 |
| Compare the tumour-infiltrating lymphocytes on the slides of the two research patients with lung cancer. | Both diagnostic slides side by side with the AI lymphocyte maps | Jettie Osinski 6.5% TIL-positive tissue, Damian Macejkovic 16.9% |
| Show Ivelisse Nitzsche's breast cancer slide with the AI nuclei and immune-cell layers on, and its pathology report beside it. | The H&E slide with both AI layers on; the report one click away | TCGA-AC-A4ZE (lobular carcinoma) on her April 2009 breast cancer: diagnostic slide, frozen section, report, nuclei and TIL maps |
| On Ivelisse Nitzsche's 36-marker colon cancer image, show pan-cytokeratin with CD8a and CD45. Where do the T cells sit against the tumour? | The fluorescence slide with those channels on | HTAN CyCIF section HTA7_920_1000 on her May 2018 colon cancer, 36 channels |
| How many patients have an H&E slide online for each cancer type? | A chart | PACS SM studies and the problem list |

## Primary care

| Question | A good answer shows | Rests on |
| --- | --- | --- |
| Summarise Kaley Witting's record for a new GP: her long-term conditions, current medications and the results to watch. | Text, perhaps a results card | 737 visits, 1,512 lab results; diabetes with kidney disease, insulin since 1977, metformin, coronary heart disease, stroke |
| Kaley Witting has diabetes with kidney disease. Chart her creatinine and blood pressure over the last ten years and list the medications she takes for them. | Results over time | 96 creatinine values |
| Which conditions and medications did Stanley Bernhard have when his lung cancer was diagnosed, and how did his blood pressure change after? | Text and a results card | NSCLC December 2021; diabetes with kidney disease |
| Compare blood pressure and cholesterol across the demo patients with breast cancer. | One line per patient in each panel | Cassie Heidenreich, Karly Lakin, Betty Feeney, Kaley Witting |

## Research

| Question | A good answer shows | Rests on |
| --- | --- | --- |
| Nicky Walker's endometrial cancer has 13,853 mutations. Show her tumour genome and explain what POLE has to do with it. | The genome view | POLE V411L; TMB 466 mutations/Mb, 99th percentile |
| Compare Jettie Osinski's EGFR-mutant lung adenocarcinoma with Damian Macejkovic's squamous cell lung cancer: genomes, slides and treatment. | The genomes side by side, then the slides, with the differences in a table | EGFR E746_A750del and erlotinib; TP53, KEAP1 and carboplatin with paclitaxel |
| Stephan Rutherford had lung and prostate cancer. Put the two tumours' genomes side by side: what drives each, and how do they compare with other tumours of the same kind? | The two genomes side by side, with the differences in a table | TCGA-77-6843, lung squamous: TP53 G105C, CDKN2A, NFE2L2, SOX2 and PIK3CA amplified, TMB 10.6 (71st percentile); TCGA-G9-6362, prostate: 25 mutations, none in a driver gene |
| Among hospital patients with a sequenced colorectal tumour, how many carry a KRAS mutation and how many are MSI-high? List the MSI-high patients. | A chart and a patient table | 122 colorectal genomes: 51 KRAS-mutant, 18 MSI-high |
| Which research patients have the highest tumour mutation burden, and how long did each live after diagnosis? | A chart or patient table | molecular_profile and the registry |
| Find patients with breast cancer who also have a chest CT with outlined nodules, and show them side by side. | A patient table, added to the conversation; their CTs side by side | The patient index |
| Put Jettie Osinski's diagnostic slide with the AI lymphocyte map beside her CT with the AI segmentation. What do the two say about her tumour? | The slide with the lymphocyte map on, beside the CT with the AI segmentation | 6.5% of tissue TIL-positive; BAMF-Lung-CT segmentation of the lungs (3,228 mL) and a 0.1 mL nodule, CT 2 September 2011 |
| Ivelisse Nitzsche's record carries the fetal brain atlas from her 2016 pregnancy. Open it at week 21 and explain how the brain changes by week 36. | The atlas at week 21 with its week timeline; said to be an atlas | dHCP fetal brain atlas (Uus et al.), weeks 21 to 36: brain 44.2 mL to 293.2 mL, the cortex folding |
| In the brain fibre-tract atlas on Stephan Rutherford's record, compare the left and right arcuate fasciculus. Which is larger across the 1,065 people, and which language areas does each reach? Put the left one's probability map on the slices. | The two arcuate fasciculi, one colour each; the left one's probability map on the slices | Volumes across 1,065 people (median 41.3 mL left, 28.4 mL right); BA44 in 100% (left) and 98% (right), BA22 in 100% and 54% |
| On the fetal brain atlas in Ivelisse Nitzsche's record, show the FA map at week 24 and at week 36 side by side. How does white-matter FA change between them? | The atlas with the FA layer at weeks 24 and 36 side by side | dHCP atlas diffusion: white-matter FA 0.12 at 24 weeks, 0.10 at 36 (lowest 0.09 at 30 to 32); MD peaks at 1.71 |

## Data

| Question | A good answer shows | Rests on |
| --- | --- | --- |
| How many patients have each kind of image online: chest CT, brain MRI, X-ray and pathology slide? | A chart | The patient index |
| Show me one of Annmarie Hickle's scanned documents beside its text, with the facts it was written from. | The scanned document | Three scanned documents |
| Where does each part of Stephan Rutherford's record come from? Name the system and the tables. | Text | Epic Clarity tables, the PACS database, the documents lakehouse |
| Of the patients with a chest CT online, how many also have a pathology slide, and which cancers do they have? | A chart or table | The patient index |

## With patients in the conversation

Shown above the role questions when the reader has added patients (from the strip, a patient table, or Ask about this
patient on a record):

- Compare these patients on one timeline, aligned at their first cancer diagnosis.
- What do these patients have in common, and where do they differ?
- Show the imaging each of these patients has online.

## In the side panel

Right-click anything in a record. The menu offers Ask Copilot about this and Explain this (or Summarise this patient).
The panel suggests questions for the open tab, such as "What did this study find?" on Radiology or "How has this changed
over time?" on Measurements.
