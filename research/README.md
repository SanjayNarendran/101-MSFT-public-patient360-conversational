# Research data pipelines

Patient 360 shows two kinds of research data beside the hospital's synthetic patients. Both are built here, from
their original publishers, on the setup machine. Nothing they download is stored in this repository: each pipeline
writes to its own `work/` folder, which git ignores.

| Pipeline | What it builds | Used by | Download | `work/` at the end |
|---|---|---|---|---|
| [patient360/pipeline](patient360/pipeline) | Fifteen real, de-identified TCGA cancer patients: registry record, tumour genome, scanned pathology report, diagnostic H&E slides with AI lymphocyte maps, CT and MRI with AI segmentations, and a synthetic primary-care history before each diagnosis | `scripts/26_patient360_import.py` (the three `Bronze_Oncology_*` silos) | about 30 GB | about 60 GB |
| [imaging/pipeline](imaging/pipeline) | Six showcase studies for two demo patients: a TCGA breast slide with AI layers, a 36-marker CyCIF slide, a whole-body FDG PET/CT, a breathing 4D CT, the HCP1065 brain-wiring atlas and the dHCP fetal brain atlas | `scripts/30_patient360_showcase.py` | about 52 GB (16 GB with `--cycif-half`, 3 GB with `--skip-cycif`) | about 56 GB (18 GB, 4 GB) |

```bash
.venv/bin/python research/patient360/pipeline/run_all.py        # then scripts/26_patient360_import.py --from-local
.venv/bin/python research/imaging/pipeline/run_all.py            # then scripts/30_patient360_showcase.py --from-local
```

Each `run_all.py` runs the pipeline's scripts in order and stops at the first failure. Downloads skip files already on
disk, so a stopped run can be started again. The Patient 360 pipeline needs Java 17 or newer (it runs Synthea). Slide
tiling takes hours on a small machine; the rest takes minutes once the downloads finish.

The scripts after these (`31_patient360_tractography.py` and `32_patient360_fullsize.py`) add each atlas's and study's
full-size files from the same publishers, into `data/raw/`.

## Where the code comes from

Both pipelines are ported, with small changes, from two MIT-licensed repositories by the same author:

- `patient360/pipeline` from the Patient 360 reference app,
  [MS101-public-patient-360-fabric-rayfin-GHC](https://github.com/SanjayNarendran/MS101-public-patient-360-fabric-rayfin-GHC)
  (its `pipeline/`, without the Fabric upload, which `26 --upload-local` does here).
- `imaging/pipeline` from the Rayfin imaging demo,
  [MS101-public-patient-imaging-2D-3D-4D-fabric-rayfin-GHC](https://github.com/SanjayNarendran/MS101-public-patient-imaging-2D-3D-4D-fabric-rayfin-GHC)
  (the scripts for these six studies; `download_slides.py --only`, `download_dicom.py --cycif-half` and `run_all.py`
  are new). Comments that mention other scripts, such as `build_dicom.py` or the upload scripts, refer to that
  repository.

The rest of this repository calls them *the reference app* and *the imaging demo*.

## Data sources

Every source allows reuse with attribution, including commercial use. Check the current terms at each source before
you rely on them. The GDC queries request open-access files only, and the IDC downloads keep only series whose licence
allows commercial use (CC BY; no NC or ND).

| Dataset | Used for | Licence | Pipeline |
|---|---|---|---|
| [The Cancer Genome Atlas](https://portal.gdc.cancer.gov/) via the NCI Genomic Data Commons (open-access tier) | clinical records, diagnostic and frozen-section H&E slides (SVS), scanned pathology reports (PDF) | NIH GDC open access; cite the TCGA Research Network | both |
| [TCGA PanCancer Atlas](https://gdc.cancer.gov/about-data/publications/pancanatlas) via [cBioPortal](https://www.cbioportal.org) | mutations, copy number, structural variants, RNA z-scores, subtype, TMB, MSI | TCGA open access | patient360 |
| [The Immune Landscape of Cancer](https://gdc.cancer.gov/about-data/publications/panimmune) data files, on the GDC | leukocyte fraction, immune signatures, cell fractions, HRD score | NIH GDC open access | patient360 |
| [TCGA-Reports](https://doi.org/10.17632/hyg5xkznpx.1) (Mendeley Data) | OCR text of the pathology reports | CC BY 4.0 | patient360 |
| TCIA TCGA radiology collections via [NCI Imaging Data Commons](https://portal.imaging.datacommons.cancer.gov/) | pre-treatment CT and MRI (DICOM) | CC BY 3.0 | patient360 |
| [BAMF AIMI annotations](https://doi.org/10.5281/zenodo.8345959) and [RCC-AID](https://doi.org/10.5281/zenodo.22284133) via IDC | AI segmentations of kidneys, liver, lungs and nodules | CC BY 4.0 | patient360 |
| [TCGA TIL maps, Stony Brook](https://doi.org/10.5281/zenodo.16966285) and [Pan-Cancer-Nuclei-Seg](https://doi.org/10.7937/tcia.2019.4a4dkp9u) via IDC | AI lymphocyte maps and nucleus outlines | CC BY 4.0 | both |
| [Synthea](https://github.com/synthetichealth/synthea) | the research patients' synthetic primary-care history and display names | Apache-2.0 (software); its output is synthetic | patient360 |
| [HTAN HMS CyCIF colorectal](https://humantumoratlas.org/) via IDC | the 36-marker immunofluorescence slide | CC BY 4.0 | imaging |
| [TCIA FDG-PET-CT-Lesions](https://doi.org/10.7937/gkr0-xv29) via IDC | whole-body PET/CT with lesion segmentation | CC BY 4.0 | imaging |
| [TCIA 4D-Lung](https://doi.org/10.7937/K9/TCIA.2016.ELN8YGLE) via IDC | breathing 4D CT with its contours | CC BY 3.0 | imaging |
| [HCP1065 tractography atlas](https://brain.labsolver.org/hcp_trk_atlas.html) and [TemplateFlow](https://www.templateflow.org/) ICBM 2009a | brain-wiring atlas on its template | CC BY-SA 4.0; template permissive with attribution | imaging |
| [dHCP fetal brain atlas](https://gin.g-node.org/kcl_cdb/fetal_brain_mri_atlas) and the KCL fetal body and craniofacial atlases (King's College London) | fetal brain from 21 to 36 weeks | CC0 | imaging |

The patients, series, slides and dates are pinned in `patient360/pipeline/cohort.json`,
`imaging/pipeline/slides.json` and the download scripts.
