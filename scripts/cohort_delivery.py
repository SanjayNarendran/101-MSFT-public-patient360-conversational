"""Delivers an approved cohort data request (the Cohort_Delivery notebook, run by Cohort_Delivery_Pipeline).

1. getDeliveryPackage (Cohort_Request_Actions user data function) returns the approved request: the i2b2 query and
   its patient set (surrogate patient_num values). It refuses requests that aren't approved.
2. The surrogates are mapped back to OMOP person_id with Silver_OMOP.i2b2_patient_mapping (the protected side).
3. The cohort is written to Silver_OMOP.cohort / cohort_definition (cohort_definition_id = QUERY_MASTER_ID).
4. A delivery lakehouse Delivery_QM<id>_<title> is created in the given folder (the approval app's folder) with a
   limited data set: no source identifiers, no day of birth and no note text in the tables.
   - Tables: the cohort's OMOP rows are copied. A shortcut can't filter rows, so it would expose every patient.
   - Imaging: each of the cohort's DICOM studies is a OneLake shortcut to its folder in Bronze_ImagingArchive
     (Files/dicom/<StudyInstanceUID>), so the images are linked, not copied. Shortcut names can't contain dots, so
     the shortcut is the UID with underscores (Files/dicom/1_2_840_…); image_occurrence.local_path points at it.
   - Documents: the cohort's reports and notes are copied (they are filed by type and year in
     Bronze_ClinicalDocuments, so a folder shortcut would include other patients' documents).
   Demo mode delivers only DEMO limits to keep a live demo short: patients and studies are taken one kind of
   image at a time (CT with nodule outlines, slide, MR, X-ray, other CT), so each kind shows.
5. The notebook Explore_QM<id>_<title> (research_notebook.py) is created next to the lakehouse, attached to it,
   with charts and images for a first look at the data. The lakehouse's SQL analytics endpoint is synced so the
   tables can be queried right away.
6. Each step is recorded with deliveryProgress; markDelivered records who delivered it, when, and where.
"""
from __future__ import annotations

import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone

import duckdb
import requests

from omop_etl import write_delta
from research_notebook import content as notebook_content, explore_name

FABRIC = "https://api.fabric.microsoft.com/v1"
ONELAKE_DFS, ONELAKE_BLOB = "https://onelake.dfs.fabric.microsoft.com", "https://onelake.blob.fabric.microsoft.com"
DEMO = {"patients": 25, "documents": 20, "studies": 5}
PERSON_CDM_FIELD = 1147026      # CDM concept person.person_id
# Delivered OMOP tables: source table -> columns (None = all)
TABLES = {
    "person": ["person_id", "gender_concept_id", "year_of_birth", "month_of_birth", "race_concept_id",
               "ethnicity_concept_id", "gender_source_value", "race_source_value", "ethnicity_source_value"],
    "death": None, "observation_period": None, "visit_occurrence": None, "condition_occurrence": None,
    "drug_exposure": None, "procedure_occurrence": None, "measurement": None, "observation": None, "specimen": None,
    "note": ["note_id", "person_id", "note_date", "note_datetime", "note_type_concept_id", "note_class_concept_id",
             "note_title", "encoding_concept_id", "language_concept_id", "provider_id", "visit_occurrence_id",
             "note_source_value", "note_event_id", "note_event_field_concept_id"],
    "image_occurrence": None, "image_feature": None, "condition_era": None, "drug_era": None}


class Delivery:
    def __init__(self, workspace_id: str, silver_id: str, documents_id: str, udf_id: str, fabric_token, storage_token):
        self.ws, self.silver_id, self.documents_id, self.udf_id = workspace_id, silver_id, documents_id, udf_id
        self.fabric_token, self.storage_token = fabric_token, storage_token

    # --- Fabric calls ---
    def invoke(self, function: str, body: dict) -> str:
        url = f"{FABRIC}/workspaces/{self.ws}/userDataFunctions/{self.udf_id}/functions/{function}/invoke"
        resp = requests.post(url, json=body, headers={"Authorization": f"Bearer {self.fabric_token()}"}, timeout=120)
        data = resp.json() if resp.content else {}
        if resp.status_code != 200 or data.get("status") != "Succeeded":
            raise RuntimeError(f"{function} failed ({resp.status_code}): {json.dumps(data.get('errors') or data)[:800]}")
        return data["output"]

    def ensure_lakehouse(self, name: str, description: str, folder_id: str | None = None) -> str:
        headers = {"Authorization": f"Bearer {self.fabric_token()}"}
        items = requests.get(f"{FABRIC}/workspaces/{self.ws}/lakehouses", headers=headers, timeout=60).json()["value"]
        found = next((i for i in items if i["displayName"] == name), None)
        if found:
            return found["id"]
        body = {"displayName": name, "description": description, **({"folderId": folder_id} if folder_id else {})}
        resp = requests.post(f"{FABRIC}/workspaces/{self.ws}/lakehouses", headers=headers, timeout=60, json=body)
        if resp.status_code == 201:
            return resp.json()["id"]
        for _ in range(30):                          # 202: wait for the lakehouse to appear
            time.sleep(5)
            items = requests.get(f"{FABRIC}/workspaces/{self.ws}/lakehouses", headers=headers, timeout=60).json()
            found = next((i for i in items["value"] if i["displayName"] == name), None)
            if found:
                return found["id"]
        raise RuntimeError(f"Lakehouse {name} was not created: {resp.status_code} {resp.text[:300]}")

    def _wait(self, resp) -> dict:
        """Follows a Fabric long-running operation (202 + Location) to its end."""
        headers = {"Authorization": f"Bearer {self.fabric_token()}"}
        while resp.status_code == 202 and resp.headers.get("Location"):
            time.sleep(int(resp.headers.get("Retry-After", 3)))
            state = requests.get(resp.headers["Location"], headers=headers, timeout=60)
            status = (state.json() if state.content else {}).get("status")
            if status in ("Failed", "Cancelled"):
                raise RuntimeError(f"Fabric operation {status.lower()}: {state.text[:300]}")
            if status == "Succeeded" or state.status_code == 200 and status is None:
                return state.json() if state.content else {}
            resp = state if state.status_code == 202 else resp
        if resp.status_code not in (200, 201, 202):
            raise RuntimeError(f"Fabric call failed: {resp.status_code} {resp.text[:300]}")
        return resp.json() if resp.content else {}

    def ensure_notebook(self, name: str, content: str, description: str, folder_id: str | None = None) -> str:
        """Creates (or updates) a notebook from its notebook-content.py; returns its ID."""
        import base64
        headers = {"Authorization": f"Bearer {self.fabric_token()}"}
        definition = {"format": "fabricGitSource", "parts": [
            {"path": "notebook-content.py", "payload": base64.b64encode(content.encode()).decode(),
             "payloadType": "InlineBase64"}]}
        find = lambda: next((n for n in requests.get(f"{FABRIC}/workspaces/{self.ws}/notebooks", headers=headers,
                                                     timeout=60).json()["value"] if n["displayName"] == name), None)
        found = find()
        if found:
            self._wait(requests.post(f"{FABRIC}/workspaces/{self.ws}/notebooks/{found['id']}/updateDefinition",
                                     headers=headers, json={"definition": definition}, timeout=120))
            return found["id"]
        body = {"displayName": name, "description": description, "definition": definition,
                **({"folderId": folder_id} if folder_id else {})}
        self._wait(requests.post(f"{FABRIC}/workspaces/{self.ws}/notebooks", headers=headers, json=body, timeout=120))
        for _ in range(30):
            found = find()
            if found:
                return found["id"]
            time.sleep(3)
        raise RuntimeError(f"The notebook {name} was not created")

    def _uri(self, item: str, table: str) -> str:
        return f"abfss://{self.ws}@onelake.dfs.fabric.microsoft.com/{item}/Tables/{table}"

    def _opts(self) -> dict:
        return {"bearer_token": self.storage_token(), "use_fabric_endpoint": "true"}

    def _register(self, con, name: str, item: str, table: str):
        from deltalake import DeltaTable
        con.register(f"src_{name}", DeltaTable(self._uri(item, table), storage_options=self._opts()).to_pyarrow_dataset())
        con.execute(f"CREATE OR REPLACE VIEW src.{name} AS SELECT * FROM src_{name}")

    def progress(self, query_master_id: int, detail: str) -> None:
        """Records a step for the approval app; a failure here never stops the delivery."""
        print(detail)
        try:
            self.invoke("deliveryProgress", {"queryMasterId": int(query_master_id), "detail": detail})
        except Exception as e:  # noqa: BLE001
            print(f"  (progress not recorded: {e})")

    def make_dir(self, item: str, path: str) -> None:
        resp = requests.put(f"{ONELAKE_DFS}/{self.ws}/{item}/{path}", params={"resource": "directory"}, timeout=60,
                            headers={"Authorization": f"Bearer {self.storage_token()}", "x-ms-version": "2023-11-03"})
        if resp.status_code not in (200, 201, 409):
            raise RuntimeError(f"Could not create {path}: {resp.status_code} {resp.text[:300]}")

    def shortcuts(self, lakehouse: str, parent: str, targets: list[tuple[str, str, str]]) -> int:
        """OneLake shortcuts parent/<name> -> (item, path) in this workspace, created in parallel with retries."""
        url = f"{FABRIC}/workspaces/{self.ws}/items/{lakehouse}/shortcuts?shortcutConflictPolicy=CreateOrOverwrite"
        token = self.fabric_token()

        def create(target):
            name, item, path = target
            body = {"path": parent, "name": name,
                    "target": {"oneLake": {"workspaceId": self.ws, "itemId": item, "path": path}}}
            for attempt in range(8):
                resp = requests.post(url, json=body, headers={"Authorization": f"Bearer {token}"}, timeout=60)
                if resp.status_code in (200, 201):
                    return
                if resp.status_code == 429 or resp.status_code >= 500:
                    time.sleep(float(resp.headers.get("Retry-After") or 3 * (attempt + 1)))
                    continue
                raise RuntimeError(f"Shortcut {parent}/{name} failed: {resp.status_code} {resp.text[:300]}")
            raise RuntimeError(f"Shortcut {parent}/{name} kept failing (throttled)")
        with ThreadPoolExecutor(8) as pool:
            list(pool.map(create, targets))
        return len(targets)

    def copy_files(self, source_item: str, lakehouse: str, paths: list[tuple[str, str]]) -> int:
        """Copies files (source path -> destination path) between lakehouses in this workspace."""
        token = self.storage_token()
        session = requests.Session()

        def copy(pair):
            src, dst = pair
            for attempt in range(5):
                got = session.get(f"{ONELAKE_DFS}/{self.ws}/{source_item}/{src}", timeout=120,
                                  headers={"Authorization": f"Bearer {token}"})
                if got.status_code == 200:
                    put = session.put(f"{ONELAKE_BLOB}/{self.ws}/{lakehouse}/{dst}", data=got.content, timeout=120,
                                      headers={"Authorization": f"Bearer {token}", "x-ms-version": "2023-11-03",
                                               "x-ms-blob-type": "BlockBlob",
                                               "Content-Type": got.headers.get("Content-Type",
                                                                               "application/octet-stream")})
                    if put.status_code in (200, 201):
                        return
                time.sleep(2 * (attempt + 1))
            raise RuntimeError(f"Could not copy {src}")
        with ThreadPoolExecutor(16) as pool:
            list(pool.map(copy, paths))
        return len(paths)

    def sync_sql_endpoint(self, lakehouse: str) -> int | None:
        """Asks the lakehouse's SQL analytics endpoint to pick up the new tables now (it otherwise syncs on its own
        schedule, minutes later). Returns the number of tables synced, or None if it couldn't (best effort)."""
        headers = {"Authorization": f"Bearer {self.fabric_token()}"}
        try:
            for _ in range(36):                      # a new lakehouse's endpoint takes a moment to provision
                props = requests.get(f"{FABRIC}/workspaces/{self.ws}/lakehouses/{lakehouse}", headers=headers,
                                     timeout=60).json().get("properties", {})
                endpoint = props.get("sqlEndpointProperties") or {}
                if endpoint.get("provisioningStatus") == "Success" and endpoint.get("id"):
                    break
                time.sleep(5)
            else:
                return None
            resp = requests.post(f"{FABRIC}/workspaces/{self.ws}/sqlEndpoints/{endpoint['id']}/refreshMetadata",
                                 headers=headers, json={}, timeout=120)
            if resp.status_code == 200:
                return len(resp.json().get("value", []))
            if resp.status_code != 202:
                return None
            operation = resp.headers["Location"]
            for _ in range(60):
                time.sleep(int(resp.headers.get("Retry-After", 3)))
                state = requests.get(operation, headers=headers, timeout=60)
                status = (state.json() if state.content else {}).get("status")
                if status == "Succeeded":
                    result = requests.get(state.headers.get("Location") or f"{operation}/result", headers=headers,
                                          timeout=60)
                    return len(result.json().get("value", [])) if result.ok and result.content else 0
                if status in ("Failed", "Cancelled"):
                    return None
        except Exception as e:  # noqa: BLE001
            print(f"  (SQL endpoint not synced: {e})")
        return None

    # --- delivery ---
    def run(self, query_master_id: int, demo: bool = False, folder_id: str | None = None) -> dict:
        """Delivers the request; a failure is recorded as a step (the audit trail shows why) and raised again."""
        try:
            return self._deliver(query_master_id, demo, folder_id)
        except Exception as e:
            self.progress(query_master_id, f"Failed: {str(e)[:600]}")
            raise

    def _deliver(self, query_master_id: int, demo: bool, folder_id: str | None) -> dict:
        started = time.time()
        package = json.loads(self.invoke("getDeliveryPackage", {"queryMasterId": int(query_master_id)}))
        con = duckdb.connect()
        con.execute("SET TimeZone = 'UTC'")
        con.execute("CREATE SCHEMA src")
        for t in [*TABLES, "concept_in_use", "i2b2_patient_mapping", "cohort", "cohort_definition"]:
            self._register(con, t, self.silver_id, t)
        self._register(con, "document_index", self.documents_id, "document_index")
        con.register("patient_set", __import__("pandas").DataFrame({"patient_num": package["PATIENT_NUMS"]}))
        con.execute("""CREATE TABLE cohort_persons AS
            SELECT DISTINCT CAST(m.patient_ide AS BIGINT) AS person_id FROM src.i2b2_patient_mapping m
            JOIN patient_set p ON p.patient_num = m.patient_num WHERE m.patient_ide_source = 'OMOP_PERSON_ID'""")
        persons = con.execute("SELECT count(*) FROM cohort_persons").fetchone()[0]
        if persons != len(package["PATIENT_NUMS"]):
            raise RuntimeError(f"{len(package['PATIENT_NUMS'])} patients in the set but {persons} mapped to OMOP")

        qm, decided = int(query_master_id), str(package.get("DECIDED_AT") or "")[:10]
        title = package.get("TITLE") or package["NAME"]
        # Demo mode: a few patients, chosen so every kind of image shows: one patient per kind of image in turn
        # (CT with nodule outlines, slide, MR, X-ray, other CT), then patients with documents
        con.execute(f"""CREATE TABLE image_kind AS
            SELECT i.person_id, i.image_study_uid,
                   CASE WHEN i.modality_source_value = 'CT' AND EXISTS (
                             SELECT 1 FROM src.image_feature f WHERE f.image_occurrence_id = i.image_occurrence_id) THEN 1
                        WHEN i.modality_source_value = 'SM' THEN 2 WHEN i.modality_source_value = 'MR' THEN 3
                        WHEN i.modality_source_value IN ('DX', 'CR') THEN 4 WHEN i.modality_source_value = 'CT' THEN 5
                        ELSE 6 END AS kind
            FROM src.image_occurrence i
            WHERE i.local_path IS NOT NULL AND i.person_id IN (SELECT person_id FROM cohort_persons)""")
        con.execute(f"""CREATE TABLE delivered_persons AS
            WITH best AS (
                SELECT c.person_id,
                       coalesce((SELECT min(k.kind) FROM image_kind k WHERE k.person_id = c.person_id),
                                CASE WHEN EXISTS (SELECT 1 FROM src.note n WHERE n.person_id = c.person_id)
                                     THEN 7 ELSE 8 END) AS kind
                FROM cohort_persons c)
            SELECT person_id FROM best
            ORDER BY kind >= 7, kind = 8, row_number() OVER (PARTITION BY kind ORDER BY person_id), kind
            {f"LIMIT {DEMO['patients']}" if demo else ""}""")
        delivered = con.execute("SELECT count(*) FROM delivered_persons").fetchone()[0]
        self.progress(qm, f"Preparing the delivery of {persons} approved patients"
                          + (f"; demo mode delivers {delivered} of them" if demo else ""))
        description = (f"{package.get('NL_QUESTION') or ''}\n\n{package.get('QUERY_SUMMARY') or ''}\n\n"
                       f"Approved by {package.get('DECIDED_BY')} on {package.get('DECIDED_AT')} UTC.").strip()
        con.execute(f"""CREATE TABLE out_cohort AS
            SELECT CAST({qm} AS INTEGER) AS cohort_definition_id, c.person_id AS subject_id,
                   op.observation_period_start_date AS cohort_start_date,
                   op.observation_period_end_date AS cohort_end_date
            FROM cohort_persons c JOIN src.observation_period op ON op.person_id = c.person_id""")
        con.execute("""CREATE TABLE out_cohort_definition AS
            SELECT CAST(? AS INTEGER) AS cohort_definition_id, CAST(? AS VARCHAR) AS cohort_definition_name,
                   CAST(? AS VARCHAR) AS cohort_definition_description, 0 AS definition_type_concept_id,
                   CAST(? AS VARCHAR) AS cohort_definition_syntax, CAST(? AS INTEGER) AS subject_concept_id,
                   CAST(? AS DATE) AS cohort_initiation_date""",
                    [qm, f"{title} (i2b2 query master {qm})", description, package["REQUEST_XML"], PERSON_CDM_FIELD,
                     decided or date.today().isoformat()])
        # The cohort tables in Silver keep every approved cohort; this delivery replaces only its own rows
        from deltalake import write_deltalake
        for table in ("cohort", "cohort_definition"):
            cols = [r[0] for r in con.execute(f"DESCRIBE src.{table}").fetchall()]
            data = con.execute(f"SELECT {', '.join(cols)} FROM out_{table}").fetch_arrow_table()
            data = data.cast(con.execute(f"SELECT * FROM src.{table} LIMIT 0").fetch_arrow_table().schema)
            write_deltalake(self._uri(self.silver_id, table), data, mode="overwrite",
                            predicate=f"cohort_definition_id = {qm}", storage_options=self._opts())

        name = delivery_name(qm, title, demo)
        lakehouse = self.ensure_lakehouse(name, f"Approved cohort data request {qm}: {title}"[:256], folder_id)
        self.progress(qm, f"Created the lakehouse {name}")

        # What gets linked and copied (chosen before the tables, which record where each file is)
        studies = con.execute(r"""
            WITH s AS (
                SELECT i.image_study_uid, any_value(regexp_extract(i.local_path, '/([0-9a-f-]{36})/Files/', 1)) AS archive,
                       min(k.kind) AS kind
                FROM src.image_occurrence i JOIN image_kind k USING (image_study_uid)
                WHERE i.person_id IN (SELECT person_id FROM delivered_persons) AND i.local_path IS NOT NULL
                GROUP BY i.image_study_uid)
            SELECT image_study_uid, archive FROM s
            ORDER BY row_number() OVER (PARTITION BY kind ORDER BY image_study_uid), kind""").fetchall()
        documents = con.execute("""
            SELECT d.DocumentId, d.OneLakePath FROM src.note n
            JOIN src.document_index d ON d.DocumentId = n.note_source_value
            WHERE n.person_id IN (SELECT person_id FROM delivered_persons) ORDER BY n.person_id, d.DocumentId""").fetchall()
        linked = studies[:DEMO["studies"]] if demo else studies
        copied = documents[:DEMO["documents"]] if demo else documents
        pd = __import__("pandas")
        con.register("linked_studies", pd.DataFrame({"study_uid": [u for u, _ in linked]}, dtype="object"))
        con.register("copied_documents", pd.DataFrame({"DocumentId": [d for d, _ in copied]}, dtype="object"))
        here = f"{ONELAKE_DFS}/{self.ws}/{lakehouse}/"

        rows = {}
        for table, cols in TABLES.items():
            select = ", ".join(f"t.{c}" for c in cols) if cols else "t.*"
            if table == "image_occurrence":   # local_path points at the delivered shortcut, not at Bronze
                select = (f"t.* REPLACE (CASE WHEN t.image_study_uid IN (SELECT study_uid FROM linked_studies) "
                          f"THEN '{here}Files/dicom/' || replace(t.image_study_uid, '.', '_') || '/' "
                          f"|| t.image_series_uid || '/' "
                          f"END AS local_path)")
            rows[table] = write_delta(con, f"SELECT {select} FROM src.{table} t "
                                           f"WHERE t.person_id IN (SELECT person_id FROM delivered_persons)",
                                      self._uri(lakehouse, table), self._opts())
        rows["cohort"] = write_delta(con, "SELECT * FROM out_cohort WHERE subject_id IN "
                                          "(SELECT person_id FROM delivered_persons)",
                                     self._uri(lakehouse, "cohort"), self._opts())
        rows["cohort_definition"] = write_delta(con, "SELECT * FROM out_cohort_definition",
                                                self._uri(lakehouse, "cohort_definition"), self._opts())
        concept_refs = " UNION ".join(
            f"SELECT {c} FROM src.{t} WHERE person_id IN (SELECT person_id FROM delivered_persons)"
            for t, cols in TABLES.items()
            for c in (cols or [r[0] for r in con.execute(f"DESCRIBE src.{t}").fetchall()])
            if c.endswith("concept_id"))
        rows["concept"] = write_delta(con, f"SELECT * FROM src.concept_in_use WHERE concept_id IN ({concept_refs})",
                                      self._uri(lakehouse, "concept"), self._opts())
        rows["document_links"] = write_delta(con, f"""
            SELECT n.note_id, n.person_id, d.DocumentId, d.DocumentType, d.Title, d.Format, d.IsScanned,
                   CASE WHEN d.DocumentId IN (SELECT DocumentId FROM copied_documents)
                        THEN '{here}Files/documents/' || substr(d.OneLakePath, 7) END AS document_url
            FROM src.note n JOIN src.document_index d ON d.DocumentId = n.note_source_value
            WHERE n.person_id IN (SELECT person_id FROM delivered_persons)""",
                                             self._uri(lakehouse, "document_links"), self._opts())
        self.progress(qm, f"Copied {len(rows)} tables ({sum(rows.values()):,} rows) for {delivered} patients")

        if linked:
            self.make_dir(lakehouse, "Files/dicom")
            self.shortcuts(lakehouse, "Files/dicom",
                           [(uid.replace(".", "_"), archive, f"Files/dicom/{uid}") for uid, archive in linked])
        self.progress(qm, f"Linked {len(linked)} imaging studies with OneLake shortcuts"
                          + (f" (demo mode; {len(studies)} in all)" if demo and len(studies) > len(linked) else ""))
        self.copy_files(self.documents_id, lakehouse,
                        [(path, "Files/documents/" + path.removeprefix("Files/")) for _, path in copied])
        self.progress(qm, f"Copied {len(copied)} documents"
                          + (f" (demo mode; {len(documents)} in all)" if demo and len(documents) > len(copied) else ""))

        delivered_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        manifest = {"query_master_id": qm, "query_name": package["NAME"], "title": title,
                    "nl_question": package.get("NL_QUESTION"), "query_summary": package.get("QUERY_SUMMARY"),
                    "i2b2_query_xml": package["REQUEST_XML"], "requested_by": package.get("REQUESTED_BY"),
                    "approved_by": package.get("DECIDED_BY"), "approved_at": str(package.get("DECIDED_AT")),
                    "delivered_at_utc": delivered_at, "demo_mode": bool(demo), "cohort_patients": persons,
                    "patients": delivered, "imaging_studies_linked": len(linked), "imaging_studies_total": len(studies),
                    "documents_copied": len(copied), "documents_total": len(documents),
                    "tables": json.dumps({k: v for k, v in rows.items()})}
        con.register("manifest_src", pd.DataFrame([manifest]))
        rows["delivery_manifest"] = write_delta(con, "SELECT * FROM manifest_src",
                                                self._uri(lakehouse, "delivery_manifest"), self._opts())
        notebook = explore_name(name)
        self.ensure_notebook(notebook, notebook_content(self.ws, lakehouse, name, title, package.get("NL_QUESTION"),
                                                        package.get("QUERY_SUMMARY")),
                             f"Explore the data delivered for request {qm}: {title}"[:256], folder_id)
        self.progress(qm, f"Created the notebook {notebook} to explore the data")
        synced = self.sync_sql_endpoint(lakehouse)
        self.progress(qm, f"Synced the SQL analytics endpoint: {synced} tables can be queried" if synced is not None
                      else "The SQL analytics endpoint will pick up the tables on its next sync")
        message = self.invoke("markDelivered", {"queryMasterId": qm, "lakehouse": name, "patients": delivered})
        return {"query_master_id": qm, "lakehouse": name, "lakehouse_id": lakehouse, "notebook": notebook,
                "demo_mode": bool(demo),
                "cohort_patients": persons, "patients": delivered, "imaging_studies": len(linked),
                "documents": len(copied), "rows": rows, "seconds": round(time.time() - started), "message": message}


def delivery_name(query_master_id: int, title: str, demo: bool) -> str:
    """Delivery_QM<id>_<Title in words, up to 32 characters>[_Demo]: the request number ties it to the request."""
    words, previous = [], ""
    for word in re.findall(r"[A-Za-z0-9]+", title or ""):
        if not (previous.isdigit() and word.isalpha() and len(word) <= 3):   # keep units lowercase: 8mm, 5mg
            word = word[:1].upper() + word[1:]
        if sum(map(len, words)) + len(word) > 32:
            break
        words.append(word)
        previous = word
    while words and words[-1].lower() in {"a", "an", "and", "at", "for", "in", "no", "not", "of", "on", "or", "the",
                                          "to", "with", "without"}:
        words.pop()                                  # a title cut short shouldn't end on a connecting word
    slug = "".join(words)
    return f"Delivery_QM{int(query_master_id)}" + (f"_{slug}" if slug else "") + ("_Demo" if demo else "")
