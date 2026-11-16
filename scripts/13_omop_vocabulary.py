"""Stage 3, step 1: get the OMOP standardized vocabularies from Microsoft's healthcare data solutions package.

Pulls only the vocabulary files (about 1 GB compressed) out of the HDS v1.4.0 zip with HTTP range requests, then
converts them to Parquet with DuckDB. CPT4 is dropped (AMA licence; our data doesn't use it). The small Microsoft
vocabulary that ships with HDS (DICOMCodes modalities, HL7 code systems) is merged in.

Output: data/generated/omop/vocab/<table>.parquet, which 14_silver_omop.py loads and uploads.
Running this script means accepting the Microsoft licence terms for HDS (see hds_package.py).
"""
from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor

import duckdb

import hds_package as hds
from common import DATA, GEN_DIR

RAW = DATA / "raw" / "hds_vocab"
OUT = GEN_DIR / "omop" / "vocab"
EXCLUDED_VOCABULARIES = ("CPT4",)

# Athena's DOMAIN.csv isn't in the HDS package; these domains don't match a Domain concept by name
DOMAIN_CONCEPTS = {"Spec Anatomic Site": 38, "Spec Disease Status": 39, "Meas Value": 24, "Meas Value Operator": 23,
                   "Obs/Procedure": 42, "Meas/Procedure": 43, "Device/Procedure": 41, "Condition/Meas": 47,
                   "Condition/Obs": 48, "Condition/Procedure": 49, "Drug/Procedure": 54, "Plan Stop Reason": 0}


def download():
    members = hds.members()
    names = [n for n in members if n.startswith(hds.VOCAB_DIR) and n.endswith(".csv")]
    start = time.time()

    def one(name):
        hds.extract(members[name], RAW / name.rsplit("/", 1)[1])
        print(f"  {time.time() - start:5.0f}s {name.rsplit('/', 1)[1]}")

    with ThreadPoolExecutor(4) as pool:
        list(pool.map(one, names))


def csv(name: str, columns: dict[str, str]) -> str:
    """DuckDB reader for an Athena-format file: tab-delimited, no quoting, dates as YYYYMMDD."""
    spec = ", ".join(f"'{k}': '{v}'" for k, v in columns.items())
    return (f"read_csv('{RAW / name}', delim='\\t', quote='', escape='', header=true, columns={{{spec}}}, "
            f"null_padding=true, strict_mode=false)")


CONCEPT_COLS = {"concept_id": "INTEGER", "concept_name": "VARCHAR", "domain_id": "VARCHAR", "vocabulary_id": "VARCHAR",
                "concept_class_id": "VARCHAR", "standard_concept": "VARCHAR", "concept_code": "VARCHAR",
                "valid_start_date": "VARCHAR", "valid_end_date": "VARCHAR", "invalid_reason": "VARCHAR"}
MSFT_CONCEPT_COLS = {**{k: v for k, v in CONCEPT_COLS.items() if not k.startswith("valid") and k != "invalid_reason"},
                     "invalid_reason": "VARCHAR", "valid_start_date": "VARCHAR", "valid_end_date": "VARCHAR"}
REL_COLS = {"concept_id_1": "INTEGER", "concept_id_2": "INTEGER", "relationship_id": "VARCHAR",
            "valid_start_date": "VARCHAR", "valid_end_date": "VARCHAR", "invalid_reason": "VARCHAR"}
MSFT_REL_COLS = {"concept_id_1": "INTEGER", "concept_id_2": "INTEGER", "relationship_id": "VARCHAR",
                 "invalid_reason": "VARCHAR", "valid_start_date": "VARCHAR", "valid_end_date": "VARCHAR"}
DATES = "strptime(valid_start_date, '%Y%m%d')::DATE AS valid_start_date, " \
        "strptime(valid_end_date, '%Y%m%d')::DATE AS valid_end_date, NULLIF(invalid_reason, '') AS invalid_reason"


def convert():
    OUT.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute("SET preserve_insertion_order = false")
    excluded = ", ".join(f"'{v}'" for v in EXCLUDED_VOCABULARIES)

    def write(table: str, query: str):
        start = time.time()
        con.execute(f"COPY ({query}) TO '{OUT / table}.parquet' (FORMAT parquet, COMPRESSION zstd, "
                    f"ROW_GROUP_SIZE 1000000)")
        n = con.execute(f"SELECT count(*) FROM '{OUT / table}.parquet'").fetchone()[0]
        print(f"  {table:<22} {n:>12,} rows  {time.time() - start:5.0f}s")

    cols = "concept_id, concept_name, domain_id, vocabulary_id, concept_class_id, NULLIF(standard_concept, '') " \
           "AS standard_concept, concept_code"
    write("concept", f"""
        SELECT {cols}, {DATES} FROM {csv('athena_CONCEPT.csv', CONCEPT_COLS)} WHERE vocabulary_id NOT IN ({excluded})
        UNION ALL
        SELECT {cols}, {DATES} FROM {csv('msft_dmh_sample_CONCEPT.csv', MSFT_CONCEPT_COLS)}""")
    con.execute(f"CREATE TEMP TABLE dropped AS SELECT concept_id FROM {csv('athena_CONCEPT.csv', CONCEPT_COLS)} "
                f"WHERE vocabulary_id IN ({excluded})")

    rel = f"concept_id_1, concept_id_2, relationship_id, {DATES}"
    write("concept_relationship", f"""
        SELECT {rel} FROM {csv('athena_CONCEPT_RELATIONSHIP.csv', REL_COLS)}
        WHERE concept_id_1 NOT IN (SELECT concept_id FROM dropped) AND concept_id_2 NOT IN (SELECT concept_id FROM dropped)
        UNION ALL
        SELECT {rel} FROM {csv('msft_dmh_sample_CONCEPT_RELATIONSHIP.csv', MSFT_REL_COLS)}""")
    write("concept_ancestor", f"""
        SELECT * FROM {csv('athena_CONCEPT_ANCESTOR.csv', {
            'ancestor_concept_id': 'INTEGER', 'descendant_concept_id': 'INTEGER',
            'min_levels_of_separation': 'INTEGER', 'max_levels_of_separation': 'INTEGER'})}
        WHERE ancestor_concept_id NOT IN (SELECT concept_id FROM dropped)
          AND descendant_concept_id NOT IN (SELECT concept_id FROM dropped)""")
    write("concept_synonym", f"""
        SELECT * FROM {csv('athena_CONCEPT_SYNONYM.csv', {
            'concept_id': 'INTEGER', 'concept_synonym_name': 'VARCHAR', 'language_concept_id': 'INTEGER'})}
        WHERE concept_id NOT IN (SELECT concept_id FROM dropped)""")
    vocab_cols = {"vocabulary_id": "VARCHAR", "vocabulary_name": "VARCHAR", "vocabulary_reference": "VARCHAR",
                  "vocabulary_version": "VARCHAR", "vocabulary_concept_id": "INTEGER"}
    write("vocabulary", f"""
        SELECT * FROM {csv('athena_VOCABULARY.csv', vocab_cols)} WHERE vocabulary_id NOT IN ({excluded})
        UNION ALL
        SELECT vocabulary_id, vocabulary_name, vocabulary_reference, vocabulary_version, vocabulary_concept_id
        FROM {csv('msft_dmh_sample_VOCABULARY.csv', {**vocab_cols, 'valid_start_date': 'VARCHAR',
                                                      'valid_end_date': 'VARCHAR'})}""")
    class_cols = {"concept_class_id": "VARCHAR", "concept_class_name": "VARCHAR", "concept_class_concept_id": "INTEGER"}
    write("concept_class", f"SELECT * FROM {csv('athena_CONCEPT_CLASS.csv', class_cols)}")
    overrides = " ".join(f"WHEN '{k}' THEN {v}" for k, v in DOMAIN_CONCEPTS.items())
    write("domain", f"""
        WITH ids AS (SELECT DISTINCT domain_id FROM '{OUT / 'concept'}.parquet'),
             named AS (SELECT concept_name, min(concept_id) AS concept_id FROM '{OUT / 'concept'}.parquet'
                       WHERE vocabulary_id = 'Domain' GROUP BY concept_name)
        SELECT ids.domain_id, ids.domain_id AS domain_name,
               COALESCE(CASE ids.domain_id {overrides} END, named.concept_id, 0)::INTEGER AS domain_concept_id
        FROM ids LEFT JOIN named ON lower(named.concept_name) = lower(ids.domain_id) ORDER BY 1""")


def main():
    print("Downloading the OMOP vocabularies from the HDS package (Microsoft Download Center)")
    download()
    print("Converting to Parquet")
    convert()


if __name__ == "__main__":
    main()
