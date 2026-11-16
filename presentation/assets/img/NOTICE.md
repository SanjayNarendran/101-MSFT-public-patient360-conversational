# Images

The medical images in Fig 7 (section 06) are the ones the Explore notebook of the demo-mode delivery of request 1005
shows. They were read from Bronze_ImagingArchive and saved as small WebP files. The CT frames are the notebook's own:
a lung window, with the LIDC radiologist's outline of the study's largest nodule drawn in orange. The other images were
scaled to 360 px. The DICOM headers in the archive carry the demo's synthetic patients; the images themselves are
unchanged research data.

| File | Image | Source | Licence |
|---|---|---|---|
| `ct-slices.webp`, `ct-closeup.webp` | 8 chest CT slices and their close-ups, with the nodule outline from a DICOM SEG object | LIDC-IDRI, patient LIDC-IDRI-0230, from [NCI Imaging Data Commons](https://imaging.datacommons.cancer.gov/) ([doi:10.7937/K9/TCIA.2015.LO9QL9SX](https://doi.org/10.7937/K9/TCIA.2015.LO9QL9SX)) | CC BY 3.0 |
| `dx.webp` | Chest X-ray (DX) | LIDC-IDRI, patient LIDC-IDRI-0248, as above | CC BY 3.0 |
| `sm.webp` | Pathology slide thumbnail (SM) | TCGA-BRCA, patient TCGA-E2-A1IL, from NCI Imaging Data Commons ([doi:10.5281/zenodo.12689962](https://doi.org/10.5281/zenodo.12689962)) | CC BY 3.0 |
| `mr.webp` | Brain MR slice | [Synthea Coherent Data Set](https://registry.opendata.aws/synthea-coherent-data/), The MITRE Corporation (simulated) | CC BY 4.0 |

The images in Figs 8 and 9 (sections 07 and 08) are the ones Patient 360 shows for Levi Hills, Damian Macejkovic and
Jettie Osinski. The CT frames were rendered from Levi Hills' CT in the imaging archive the way the app's viewer shows
it: a lung window, with each nodule outlined where at least half of the LIDC radiologists who marked it drew it. The
slides were stitched from the app's deep-zoom tiles. The lymphocyte maps keep one pixel per 50 µm square of tissue.
Levi Hills is one of the demo's synthetic patients, with research images under him; Damian Macejkovic and Jettie
Osinski are TCGA cases with synthetic names.

| File | Image | Source | Licence |
|---|---|---|---|
| `levi-ct-axial.webp`, `levi-ct-coronal-n1.webp`, `levi-ct-coronal-n6.webp`, `levi-ct-sagittal-n1.webp`, `levi-ct-sagittal-n6.webp` | Chest CT: 15 axial slices from nodule 1 to nodule 6, and the coronal and sagittal planes through each, with the nodule outlines | LIDC-IDRI, patient LIDC-IDRI-0510, from NCI Imaging Data Commons ([doi:10.7937/K9/TCIA.2015.LO9QL9SX](https://doi.org/10.7937/K9/TCIA.2015.LO9QL9SX)) | CC BY 3.0 |
| `levi-slide.webp`, `levi-slide-13.webp`, `levi-slide-14.webp` | H&E slide: the whole slide and two crops at 10× and 20× | TCGA-LUSC, patient TCGA-94-7943, from NCI Imaging Data Commons ([doi:10.5281/zenodo.12689962](https://doi.org/10.5281/zenodo.12689962)) | CC BY 3.0 |
| `damian-slide.webp`, `damian-slide-15.webp`, `damian-slide-16.webp`, `jettie-slide.webp` | Diagnostic H&E slides: the whole slides, and two crops of TCGA-60-2722's at 10× and 20× | TCGA-LUSC patient TCGA-60-2722 and TCGA-LUAD patient TCGA-J2-8192, from the [NCI Genomic Data Commons](https://portal.gdc.cancer.gov/) | NIH GDC open access; cite the TCGA Research Network |
| `damian-til.webp`, `jettie-til.webp` | AI lymphocyte (TIL) maps of those two slides | Stony Brook TCGA TIL maps, Saltz J et al., Cell Reports 2018 ([doi:10.5281/zenodo.16966285](https://doi.org/10.5281/zenodo.16966285)) | CC BY 4.0 |
