"""Patient 360: TCGA tumour genomes for the Epic patients whose biopsy slides come from TCGA (follow-up D1).

The pathology crosswalk (data/generated/crosswalk/pathology_cases.csv) gives 709 Epic patients the diagnostic slides
of 792 TCGA cases. The same TCGA cases were sequenced, so each of those tumours has a genome: somatic mutations,
copy number, expression of a gene panel, the immune mix and mutation burden against the same cancer. This script
fetches them in bulk from cBioPortal (the PanCancer Atlas studies) and the immune landscape files from the GDC, then
merges them into the research genomics silo next to the fifteen reference patients' genomes, keyed by TCGA barcode
(the reference app's schema, so the Genomics tab and Ask show them unchanged). `24` links each Epic patient to their
genomes (p360_genome) and flags them in the index.

Only tumours in cBioPortal's sequenced sample lists count, so every genome has its mutation calls. The downloads are
cached in data/raw/tcga_genomics, so a rerun (for example after `26 --from-local` replaced the research tables) only
asks cBioPortal for the gene panel's ids and the sample lists. The research patients' rows are kept as they are; every
other row is rebuilt.

Run:  .venv/bin/python scripts/29_patient360_genomics.py            # fetch, merge into the local research silo
      .venv/bin/python scripts/24_patient360_data.py --index-only  # link them to the Epic patients
      .venv/bin/python scripts/29_patient360_genomics.py --fabric   # also write the silo to Bronze_Oncology_Genomics
"""
from __future__ import annotations

import argparse
import math
import re
from concurrent.futures import ThreadPoolExecutor

import pandas as pd
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from common import DATA, GEN_DIR, ensure_lakehouse, write_tables

CBIO = "https://www.cbioportal.org/api"
GDC = "https://api.gdc.cancer.gov"
CACHE = DATA / "raw" / "tcga_genomics"
CROSSWALK = GEN_DIR / "crosswalk" / "pathology_cases.csv"
TABLES = GEN_DIR / "research" / "genomics" / "tables"
PATIENTS = GEN_DIR / "research" / "clinical" / "tables" / "patient.parquet"

# IDC collection of the slide -> cBioPortal PanCancer Atlas study (colon and rectum are one study there)
STUDY = {"tcga_brca": "brca", "tcga_coad": "coadread", "tcga_luad": "luad", "tcga_lusc": "lusc", "tcga_prad": "prad"}

# Lineage markers, therapy targets, immune checkpoints, DNA repair and antibody-drug conjugate targets.
GENE_PANEL = [
    "ERBB2", "ESR1", "PGR", "AR", "EGFR", "MET", "ALK", "FGFR3", "KIT", "VEGFA", "CA9", "MKI67",
    "CD274", "PDCD1", "CTLA4", "LAG3", "CD8A", "GZMB",
    "TACSTD2", "NECTIN4", "FOLR1", "CLDN18", "CD276", "DLL3", "MSLN",
    "KLK3", "FOLH1", "MUC16", "CEACAM5", "AFP", "GATA3", "NKX2-1", "TP63", "KRT5", "PAX8", "WT1", "CDX2",
    "MLH1", "MSH2", "MSH6", "PMS2", "BRCA1", "BRCA2", "CDKN2A", "PTEN",
]

DRIVER_GENES = {
    "TP53", "KRAS", "NRAS", "HRAS", "PIK3CA", "PIK3R1", "EGFR", "ERBB2", "ERBB3", "BRAF", "MET", "ALK", "ROS1",
    "RET", "VHL", "PBRM1", "SETD2", "BAP1", "KDM5C", "BRCA1", "BRCA2", "PALB2", "ATM", "ATR", "CHEK2",
    "PTEN", "ARID1A", "ARID1B", "ARID2", "APC", "CTNNB1", "AXIN1", "FGFR1", "FGFR2", "FGFR3", "KMT2D",
    "KMT2C", "KEAP1", "STK11", "NFE2L2", "RB1", "CDKN2A", "CDKN1A", "SMAD4", "SMAD2", "TGFBR2", "FBXW7",
    "SPOP", "FOXA1", "GATA3", "MAP3K1", "CDH1", "TERT", "POLE", "POLD1", "KDM6A", "ELF3", "MTOR", "TSC1",
    "TSC2", "NF1", "NF2", "IDH1", "IDH2", "MLH1", "MSH2", "MSH6", "PMS2", "CREBBP", "EP300", "NOTCH1",
    "FAT1", "ZFHX3", "CTCF", "RNF43", "SOX9", "ACVR2A", "PPP2R1A", "TP63", "SOX2", "MYC", "CCNE1",
    "CCND1", "MDM2", "CDK4", "AKT1", "ESR1", "AR", "STAG2", "TET2", "ASXL1", "DNMT3A", "PIK3CB",
}

COHORT_METRICS = ["TMB_NONSYNONYMOUS", "FRACTION_GENOME_ALTERED", "ANEUPLOIDY_SCORE", "MSI_SCORE_MANTIS"]
SAMPLE_ATTRS = COHORT_METRICS + ["MSI_SENSOR_SCORE", "SUBTYPE"]

# The Immune Landscape of Cancer (Thorsson et al. 2018), https://gdc.cancer.gov/about-data/publications/panimmune
PANIMMUNE = {
    "TCGA_all_leuk_estimate.masked.20170107.tsv": "6f75c9d7-5134-4ed1-b8f3-72856c98a4e8",
    "TCGA.Kallisto.fullIDs.cibersort.relative.tsv": "b3df502e-3594-46ef-9f94-d041a20a0b9a",
    "Scores_160_Signatures.tsv.gz": "80a82092-161d-4615-9d96-e858f113618d",
    "mitcr_sampleStatistics_20160714.tsv": "da5724d2-2ae7-4632-8a9d-4b08496a9d20",
    "TCGA.HRD_withSampleID.txt": "66dd07d7-6366-4774-83c3-5ad1e22b177e",
}
IMMUNE_SIGNATURES = {
    "proliferation": "Module11_Prolif_score",
    "ifn_gamma_response": "Module3_IFN_score",
    "tgf_beta_response": "TGFB_score_21050467",
    "wound_healing": "CHANG_CORE_SERUM_RESPONSE_UP",
    "macrophage_regulation": "CSF1_response",
    "lymphocyte_infiltration": "LIexpression_score",
}
CIBERSORT = [
    "B Cells Naive", "B Cells Memory", "Plasma Cells", "T Cells CD8", "T Cells CD4 Naive", "T Cells CD4 Memory Resting",
    "T Cells CD4 Memory Activated", "T Cells Follicular Helper", "T Cells Regulatory Tregs", "T Cells gamma delta",
    "NK Cells Resting", "NK Cells Activated", "Monocytes", "Macrophages M0", "Macrophages M1", "Macrophages M2",
    "Dendritic Cells Resting", "Dendritic Cells Activated", "Mast Cells Resting", "Mast Cells Activated", "Eosinophils",
    "Neutrophils",
]

HTTP = requests.Session()
HTTP.mount("https://", HTTPAdapter(max_retries=Retry(
    total=6, backoff_factor=2, allowed_methods=None, status_forcelist=[429, 500, 502, 503, 504],
)))


def cbio_get(path: str, **params):
    r = HTTP.get(f"{CBIO}{path}", params=params, timeout=600)
    r.raise_for_status()
    return r.json()


def cbio_post(path: str, body, **params):
    r = HTTP.post(f"{CBIO}{path}", params=params, json=body, timeout=600)
    r.raise_for_status()
    return r.json()


def chunks(items: list, n: int):
    for i in range(0, len(items), n):
        yield items[i : i + n]


def num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else f


def cached(path, build) -> pd.DataFrame:
    """A cached frame: read it if it's there, else build and save it."""
    if path.exists():
        return pd.read_parquet(path)
    df = build()
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path, index=False)
    return df


def fetch_study(study: str, samples: list[str], genes: dict[int, str]) -> dict[str, pd.DataFrame]:
    """Every table's raw rows for the samples of one PanCancer Atlas study, from cache or cBioPortal."""
    sid = f"{study}_tcga_pan_can_atlas_2018"
    folder = CACHE / study

    def clinical():
        rows = cbio_get(f"/studies/{sid}/clinical-data", clinicalDataType="SAMPLE", projection="SUMMARY")
        df = pd.DataFrame(rows)
        df = df[df.clinicalAttributeId.isin(SAMPLE_ATTRS)][["sampleId", "clinicalAttributeId", "value"]]
        # The molecular subtype is a patient attribute; the patient's primary tumour carries it here.
        pat = pd.DataFrame(cbio_get(f"/studies/{sid}/clinical-data", clinicalDataType="PATIENT", projection="SUMMARY"))
        pat = pat[pat.clinicalAttributeId == "SUBTYPE"].assign(sampleId=lambda d: d.patientId + "-01")
        return pd.concat([df, pat[["sampleId", "clinicalAttributeId", "value"]]], ignore_index=True)

    def mutations():
        out = []
        for part in chunks(samples, 40):
            for m in cbio_post(f"/molecular-profiles/{sid}_mutations/mutations/fetch", {"sampleIds": part},
                               projection="DETAILED"):
                out.append({
                    "sampleId": m["sampleId"], "gene": m["gene"]["hugoGeneSymbol"], "proteinChange": m.get("proteinChange"),
                    "mutationType": m.get("mutationType"), "variantType": m.get("variantType"), "chr": m.get("chr"),
                    "start": m.get("startPosition"), "end": m.get("endPosition"), "ref": m.get("referenceAllele"),
                    "alt": m.get("variantAllele"), "altCount": m.get("tumorAltCount"), "refCount": m.get("tumorRefCount"),
                })
        return pd.DataFrame(out)

    def segments():
        out = []
        for part in chunks(samples, 100):
            out += cbio_post("/copy-number-segments/fetch", [{"sampleId": s, "studyId": sid} for s in part],
                             projection="SUMMARY")
        return pd.DataFrame(out)[["sampleId", "chromosome", "start", "end", "numberOfProbes", "segmentMean"]]

    def cna():
        out = []
        for part in chunks(samples, 100):
            out += [{"sampleId": c["sampleId"], "gene": c["gene"]["hugoGeneSymbol"], "alteration": c["alteration"]}
                    for c in cbio_post(f"/molecular-profiles/{sid}_gistic/discrete-copy-number/fetch", {"sampleIds": part},
                                       discreteCopyNumberEventType="HOMDEL_AND_AMP", projection="DETAILED")]
        return pd.DataFrame(out, columns=["sampleId", "gene", "alteration"])

    def expression():
        out = []
        for part in chunks(samples, 100):
            try:
                rows = cbio_post(f"/molecular-profiles/{sid}_rna_seq_v2_mrna_median_all_sample_Zscores/molecular-data/fetch",
                                 {"sampleIds": part, "entrezGeneIds": list(genes)})
            except requests.HTTPError:
                return pd.DataFrame(columns=["sampleId", "gene", "value"])
            out += [{"sampleId": r["sampleId"], "gene": genes[r["entrezGeneId"]], "value": r["value"]} for r in rows]
        return pd.DataFrame(out, columns=["sampleId", "gene", "value"])

    def fusions():
        profile = f"{sid}_structural_variants"
        try:
            rows = cbio_post("/structural-variant/fetch", {
                "molecularProfileIds": [profile],
                "sampleMolecularIdentifiers": [{"molecularProfileId": profile, "sampleId": s} for s in samples],
            })
        except requests.HTTPError:
            rows = []
        return pd.DataFrame([{
            "sampleId": s["sampleId"], "site1Gene": s.get("site1HugoSymbol"), "site2Gene": s.get("site2HugoSymbol"),
            "eventInfo": s.get("eventInfo"), "variantClass": s.get("variantClass"),
        } for s in rows], columns=["sampleId", "site1Gene", "site2Gene", "eventInfo", "variantClass"])

    return {
        name: cached(folder / f"{name}.parquet", build)
        for name, build in [("clinical", clinical), ("mutations", mutations), ("segments", segments), ("cna", cna),
                            ("expression", expression), ("fusions", fusions)]
    }


def panimmune(patients: set[str]) -> dict[str, dict]:
    """The immune landscape of each patient's primary tumour, by the paper's measures."""
    src = CACHE / "panimmune"
    src.mkdir(parents=True, exist_ok=True)
    for name, file_id in PANIMMUNE.items():
        if not (src / name).exists():
            print(f"  GDC: {name}")
            r = HTTP.get(f"{GDC}/data/{file_id}", timeout=600)
            r.raise_for_status()
            (src / name).write_bytes(r.content)

    primary = lambda barcode: barcode[13:15] == "01"  # noqa: E731
    out: dict[str, dict] = {p: {} for p in patients}
    leuk = pd.read_csv(src / "TCGA_all_leuk_estimate.masked.20170107.tsv", sep="\t", header=None, names=["study", "sample", "value"])
    for row in leuk[leuk["sample"].map(primary)].itertuples():
        if row.sample[:12] in out:
            out[row.sample[:12]]["leukocyte_fraction"] = num(row.value)
    sig = pd.read_csv(src / "Scores_160_Signatures.tsv.gz", sep="\t").drop(columns="Source").set_index("SetName")
    for barcode in sig.columns:
        if primary(barcode) and barcode[:12] in out:
            for col, set_name in IMMUNE_SIGNATURES.items():
                out[barcode[:12]][col] = num(sig.at[set_name, barcode])
    cib = pd.read_csv(src / "TCGA.Kallisto.fullIDs.cibersort.relative.tsv", sep="\t")
    norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())  # noqa: E731
    cells = {c: name for c in cib.columns for name in CIBERSORT if norm(c) == norm(name)}
    for row in cib.to_dict("records"):
        barcode = row["SampleID"].replace(".", "-")
        if primary(barcode) and barcode[:12] in out:
            out[barcode[:12]]["cells"] = {name: num(row[c]) for c, name in cells.items()}
    tcr = pd.read_csv(src / "mitcr_sampleStatistics_20160714.tsv", sep="\t")
    for row in tcr[tcr["SampleTypeLetterCode"] == "TP"].itertuples():
        if row.ParticipantBarcode in out:
            out[row.ParticipantBarcode]["tcr_richness"] = num(row.numClones)
    hrd = pd.read_csv(src / "TCGA.HRD_withSampleID.txt", sep="\t")
    for row in hrd.itertuples():
        if primary(row.sampleID) and row.sampleID[:12] in out:
            out[row.sampleID[:12]]["hrd_score"] = num(row.HRD)
    return out


def build(cases: pd.DataFrame, existing: set[str]) -> dict[str, list[dict]]:
    """Rows for the genomics silo's tables, for every crosswalk case that the PanCancer Atlas sequenced (apart from
    `existing`, the research patients, who keep their own rows)."""
    genes = {r["entrezGeneId"]: r["hugoGeneSymbol"]
             for r in cbio_post("/genes/fetch", GENE_PANEL, geneIdType="HUGO_GENE_SYMBOL")}
    cases = cases[~cases.tcga_patient.isin(existing)]
    jobs = {}
    for coll, grp in cases.groupby("collection_id"):
        study = STUDY[coll]
        # Only tumours with mutation calls: a sample outside this list would show as a genome with no mutations.
        sequenced = set(cbio_get(f"/sample-lists/{study}_tcga_pan_can_atlas_2018_sequenced/sample-ids"))
        want = sorted({f"{p}-01" for p in grp.tcga_patient} & sequenced)
        jobs.setdefault(study, set()).update(want)
        print(f"  {study:<9} {grp.tcga_patient.nunique():>4} cases, {len(want):>4} sequenced primary tumours")
    if not jobs:
        raise SystemExit("No crosswalk case has a sequenced primary tumour in cBioPortal.")
    with ThreadPoolExecutor(len(jobs)) as pool:
        fetched = dict(zip(jobs, pool.map(lambda s: fetch_study(s, sorted(jobs[s]), genes), jobs)))
    immune = panimmune({s[:12] for samples in jobs.values() for s in samples})

    t: dict[str, list[dict]] = {k: [] for k in ["molecular_profile", "somatic_mutation", "copy_number_segment",
                                                "gene_copy_number", "gene_expression", "immune_cell_fraction",
                                                "structural_variant"]}
    for study, f in fetched.items():
        sid = f"{study}_tcga_pan_can_atlas_2018"
        clin = f["clinical"].pivot_table(index="sampleId", columns="clinicalAttributeId", values="value", aggfunc="first")
        ref = {m: sorted(v for v in (num(x) for x in clin.get(m, pd.Series(dtype=str))) if v is not None)
               for m in COHORT_METRICS}

        def pct(metric, val):
            vals = ref[metric]
            return round(100 * sum(1 for x in vals if x <= val) / len(vals), 1) if val is not None and vals else None

        by = {k: dict(tuple(df.groupby("sampleId"))) if len(df) else {} for k, df in f.items() if k != "clinical"}
        for sample in sorted(jobs[study]):
            pid = sample[:12]
            attrs = clin.loc[sample].to_dict() if sample in clin.index else {}
            muts = by["mutations"].get(sample, pd.DataFrame())
            for m in muts.to_dict("records"):
                alt, refc = m.get("altCount"), m.get("refCount")
                ok = alt is not None and refc is not None and not pd.isna(alt) and not pd.isna(refc) and alt >= 0 and alt + refc > 0
                t["somatic_mutation"].append({
                    "patient_id": pid, "sample_id": sample, "gene": m["gene"], "protein_change": m.get("proteinChange"),
                    "mutation_type": m.get("mutationType"), "variant_type": m.get("variantType"),
                    "chromosome": str(m.get("chr")), "start_pos": int(m["start"]), "end_pos": int(m["end"]),
                    "ref_allele": m.get("ref"), "alt_allele": m.get("alt"),
                    "vaf": round(alt / (alt + refc), 4) if ok else None, "is_driver_gene": m["gene"] in DRIVER_GENES,
                })
            for s in by["segments"].get(sample, pd.DataFrame()).to_dict("records"):
                t["copy_number_segment"].append({
                    "patient_id": pid, "chromosome": str(s["chromosome"]), "start_pos": int(s["start"]), "end_pos": int(s["end"]),
                    "probes": int(s["numberOfProbes"]), "segment_mean": float(s["segmentMean"]),
                })
            for c in by["cna"].get(sample, pd.DataFrame()).to_dict("records"):
                t["gene_copy_number"].append({
                    "patient_id": pid, "gene": c["gene"], "alteration": int(c["alteration"]),
                    "call": {2: "Amplification", -2: "Deep deletion"}.get(int(c["alteration"]), str(c["alteration"])),
                    "is_driver_gene": c["gene"] in DRIVER_GENES,
                })
            for e in by["expression"].get(sample, pd.DataFrame()).to_dict("records"):
                if num(e["value"]) is not None:
                    t["gene_expression"].append({"patient_id": pid, "gene": e["gene"], "z_score": round(float(e["value"]), 3)})
            for sv in by["fusions"].get(sample, pd.DataFrame()).to_dict("records"):
                t["structural_variant"].append({"patient_id": pid, **{k: sv[k] for k in ["site1Gene", "site2Gene", "eventInfo", "variantClass"]}})

            imm = immune.get(pid, {})
            tmb, fga = num(attrs.get("TMB_NONSYNONYMOUS")), num(attrs.get("FRACTION_GENOME_ALTERED"))
            msi = num(attrs.get("MSI_SCORE_MANTIS"))
            t["molecular_profile"].append({
                "patient_id": pid, "sample_id": sample, "subtype": attrs.get("SUBTYPE") if isinstance(attrs.get("SUBTYPE"), str) else None,
                "tmb": tmb, "tmb_percentile": pct("TMB_NONSYNONYMOUS", tmb),
                "fraction_genome_altered": fga, "fga_percentile": pct("FRACTION_GENOME_ALTERED", fga),
                "aneuploidy_score": num(attrs.get("ANEUPLOIDY_SCORE")),
                "msi_mantis": msi, "msi_sensor": num(attrs.get("MSI_SENSOR_SCORE")),
                "msi_status": ("MSI-high" if msi >= 0.4 else "Microsatellite stable") if msi is not None else None,
                "mutation_count": len(muts),
                **{k: imm.get(k) for k in ["leukocyte_fraction", *IMMUNE_SIGNATURES, "hrd_score", "tcr_richness"]},
                "cohort_study": sid, "cohort_size": len(ref["TMB_NONSYNONYMOUS"]),
            })
            for cell, frac in (imm.get("cells") or {}).items():
                if frac is not None:
                    t["immune_cell_fraction"].append({"patient_id": pid, "cell_type": cell, "fraction": frac})
    return t


def merge(new: dict[str, list[dict]], research: set[str]) -> dict[str, pd.DataFrame]:
    """The research patients' rows as they are, and the new rows in place of any from an earlier run."""
    out = {}
    for name, rows in new.items():
        old = pd.read_parquet(TABLES / f"{name}.parquet")
        df = pd.DataFrame(rows, columns=old.columns)
        df = df.astype({c: old[c].dtype for c in old.columns if str(old[c].dtype) not in ("str", "string", "object")}, errors="ignore")
        out[name] = pd.concat([old[old.patient_id.isin(research)], df], ignore_index=True)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fabric", action="store_true", help="also write the genomics silo to Bronze_Oncology_Genomics")
    args = ap.parse_args()
    if not (TABLES / "molecular_profile.parquet").exists() or not PATIENTS.exists():
        raise SystemExit(f"No research tables in {TABLES.parent.parent}: run 26_patient360_import.py --from-local first.")
    cases = pd.read_csv(CROSSWALK, dtype=str)
    # The research patients (the reference app's, in the clinical silo) keep their rows; one of them, TCGA-J4-A6G3,
    # is also a crosswalk case. Every other row is this script's and is rebuilt.
    research = set(pd.read_parquet(PATIENTS, columns=["patient_id"]).patient_id)
    print(f"Crosswalk: {cases.PAT_ID.nunique()} Epic patients, {cases.tcga_patient.nunique()} TCGA cases")
    new = build(cases, research)
    tables = merge(new, research)
    for name, df in tables.items():
        df.to_parquet(TABLES / f"{name}.parquet", index=False)
        print(f"  {name:<22} {len(df):>9,} rows ({len(new[name]):,} from the crosswalk cases)")
    print(f"Genomes for {len(new['molecular_profile'])} crosswalk cases. Next: 24_patient360_data.py --index-only")
    if args.fabric:
        ws_id, lh_id = ensure_lakehouse("Bronze_Oncology_Genomics", "Oncology research: TCGA tumour genomes")
        print("Bronze_Oncology_Genomics")
        write_tables(ws_id, lh_id, tables)


if __name__ == "__main__":
    main()
