"""Cohort discovery service (option 1): i2b2 query definitions run against the Cohort Discovery semantic model.

run():    validate the query definition against the ontology, name it the i2b2 way, compile it to DAX, run the count,
          breakdown and patient-set queries on the semantic model (Power BI executeQueries, as the signed-in user),
          obfuscate the counts as the i2b2 CRC does for DATA_OBFSC users, and record everything in the CRC store.
          Returns the QUERY_MASTER_ID and the obfuscated counts; real counts and patient numbers are never returned.
submit(): turn a query into a data request (status PENDING) and link it to its approval page (the Rayfin approval
          app, or a Power BI dashboard copied from the report template with APPROVAL_UI=powerbi).
"""
from __future__ import annotations

import re
import time
from datetime import datetime, timezone

import cohort_store as store
import i2b2_crc as crc
import i2b2_query as Q
import semantic_models as sm
from common import load_state, settings, signed_in_user

ONTOLOGY_COLUMNS = ["c_hlevel", "c_fullname", "c_name", "c_visualattributes", "c_totalnum", "c_basecode",
                    "c_tablename", "c_columnname", "c_operator", "c_dimcode", "c_columndatatype", "c_facttablecolumn",
                    "c_metadataxml", "m_applied_path"]
SMALL_CELL = 10  # ontology term counts below this are not shown (small-cell suppression)


def term_count(n: int | None) -> int | str:
    return n if (n or 0) >= SMALL_CELL else f"fewer than {SMALL_CELL}"


class CohortService:
    def __init__(self):
        self.state, self.cfg = load_state(), settings()
        self.workspace_id = self.state["workspace_id"]
        self.model_id = self.state["semantic_models"][self.cfg["SEMANTIC_MODEL_DISCOVERY"]]
        self._ontology: Q.Ontology | None = None
        self._user: str | None = None
        self._conn = None
        self._patients: int | None = None

    # --- plumbing ---
    @property
    def user(self) -> str:
        if self._user is None:
            self._user = signed_in_user()
        return self._user

    @property
    def conn(self):
        """The CRC store connection, reopened when it has dropped (capacity paused, token expired). Every store call
        commits its own work, so anything still open here is left over from a failed call and is rolled back."""
        if self._conn is not None:
            try:
                self._conn.rollback()
                self._conn.cursor().execute("SELECT 1").fetchall()
            except Exception:
                try:
                    self._conn.close()
                except Exception:
                    pass
                self._conn = None
        if self._conn is None:
            self._conn = store.connect()
        return self._conn

    def dax(self, query: str) -> list[dict]:
        return sm.execute_dax(self.workspace_id, self.model_id, query)

    @property
    def ontology(self) -> Q.Ontology:
        if self._ontology is None:
            cols = ", ".join(f'"{c}", i2b2_ontology[{c}]' for c in ONTOLOGY_COLUMNS)
            rows = self.dax(f"EVALUATE SELECTCOLUMNS(i2b2_ontology, {cols})")
            tables = self.dax('EVALUATE SELECTCOLUMNS(table_access, "c_table_cd", table_access[c_table_cd], '
                              '"c_fullname", table_access[c_fullname], "c_name", table_access[c_name])')
            self._ontology = Q.Ontology.from_rows(rows, tables)
        return self._ontology

    # --- ontology ---
    def node_info(self, node: Q.Node) -> dict:
        info = {"item_key": self.ontology.key(node.fullname), "path": node.fullname, "name": node.name,
                "kind": {"F": "folder", "L": "leaf", "C": "container", "D": "modifier folder",
                         "R": "modifier"}.get(node.visual[:1], node.visual), "patients": term_count(node.totalnum)}
        if node.metadataxml:
            info["numeric_values"] = True
        if node.tablename == "modifier_dimension":
            info["applies_to"] = node.applied_path
        return info

    def search(self, text: str, under: str | None = None, limit: int = 25) -> list[dict]:
        return [self.node_info(n) for n in self.ontology.search(text, limit=limit, under=under)]

    def browse(self, path: str | None = None) -> list[dict]:
        if not path:
            return [self.node_info(self.ontology.nodes[root]) for root in sorted(self.ontology.tables.values())]
        node = self.ontology.node(path)
        return [self.node_info(n) for n in self.ontology.children(node.fullname)]

    def modifiers(self) -> list[dict]:
        rows = [n for n in self.ontology.nodes.values() if n.tablename == "modifier_dimension"]
        return [{"modifier_key": self.ontology.key(n.fullname), "name": n.name, "kind": n.visual.strip(),
                 "applies_to": n.applied_path, "patients": term_count(n.totalnum)}
                for n in sorted(rows, key=lambda n: n.fullname)]

    # --- queries ---
    def prepare(self, query: dict) -> tuple[Q.QueryDefinition, str, str]:
        qd = Q.QueryDefinition.from_dict(query).normalize(self.ontology)
        return qd, Q.to_xml(qd, self.ontology), Q.describe(qd, self.ontology)

    def breakdown_nodes(self) -> dict[str, list[Q.Node]]:
        return {kind: self.ontology.children(path) for kind, path in crc.BREAKDOWN_PATHS.items()}

    def run(self, query: dict, nl_question: str = "") -> dict:
        started = datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)
        qd, xml, summary = self.prepare(query)
        compiler = Q.DaxCompiler(self.ontology)
        nodes = self.breakdown_nodes()
        count_dax = compiler.count_query(qd, nodes)
        rows = self.dax(count_dax)
        real_total = next(int(r["set_size"]) for r in rows if r["result_type"] == "PATIENT_COUNT_XML")
        breakdowns = {kind: [(r["category"], int(r["set_size"] or 0)) for r in rows if r["result_type"] == kind]
                      for kind in nodes}
        patients = [int(r["patient_num"]) for r in self.dax(compiler.patient_set_query(qd))]
        if len(patients) != real_total:
            raise RuntimeError(f"Patient set ({len(patients)}) and count ({real_total}) disagree")
        result = store.record_run(
            self.conn, user=self.user, name=qd.name, request_xml=xml, generated_query=count_dax,
            query_json=qd.to_dict(), nl_question=nl_question, summary=summary, language="i2b2 query definition -> DAX",
            model_id=self.model_id, real_total=real_total, breakdowns=breakdowns, patients=patients, started=started)
        return {**result, "summary": summary, "i2b2_query_xml": xml,
                "note": "Counts are obfuscated as for an i2b2 DATA_OBFSC user (Gaussian noise; 3 or fewer -> 0)."}

    def queries(self, limit: int = 20, mine: bool = True) -> list[dict]:
        rows = store.list_queries(self.conn, self.user if mine else None, limit)
        for r in rows:
            r["PATIENT_COUNT"] = crc.display(r["PATIENT_COUNT"] or 0)
        return rows

    def query(self, query_master_id: int) -> dict:
        q = store.get_query(self.conn, query_master_id)
        if not q:
            raise ValueError(f"No query with QUERY_MASTER_ID {query_master_id}")
        q["PATIENT_COUNT"] = crc.display(q["PATIENT_COUNT"] or 0)
        q.pop("GENERATED_SQL", None)
        q["BREAKDOWNS"] = store.get_breakdowns(self.conn, query_master_id)
        return q

    # --- data requests ---
    def submit(self, query_master_id: int, title: str | None = None) -> dict:
        """Creates the data request and links it to its approval page: the Rayfin approval app (APPROVAL_UI=rayfin,
        the default) or a Power BI dashboard copied from the template (APPROVAL_UI=powerbi, the earlier version)."""
        legacy = settings().get("APPROVAL_UI", "rayfin").strip().lower() == "powerbi"
        app_url = (load_state().get("approval_app") or {}).get("url")
        if not legacy and not app_url:
            raise RuntimeError("The approval app isn't deployed: run scripts/22_approval_app.py, or set APPROVAL_UI=powerbi.")
        request = store.create_request(self.conn, query_master_id, self.user, title)
        if legacy:
            import request_report
            report_id, url = request_report.create_for_request(query_master_id, request["TITLE"])
        else:
            report_id, url = None, f"{app_url}/#/requests/{query_master_id}"
        store.set_report(self.conn, query_master_id, report_id, url)
        return self.request(query_master_id)

    def request(self, query_master_id: int) -> dict:
        r = store.get_request(self.conn, query_master_id)
        if not r:
            raise ValueError(f"No data request for QUERY_MASTER_ID {query_master_id}")
        r.pop("PATIENT_COUNT", None)
        r.pop("GENERATED_QUERY", None)
        return r

    def delivery_folder(self) -> str | None:
        """The folder of the approval app item: delivery lakehouses are created next to it (None = workspace root)."""
        from common import fabric
        app = (load_state().get("approval_app") or {}).get("deploy", {}).get("deployment", {})
        if not app.get("rayfinItemId"):
            return None
        return fabric("GET", f"/workspaces/{self.workspace_id}/items/{app['rayfinItemId']}").get("folderId")

    def explore_notebook(self, query_master_id: int) -> str:
        """Creates or refreshes the Explore notebook of a delivered request (research_notebook.py), next to its
        delivery lakehouse. Delivery does this itself; this is for earlier deliveries and notebook changes."""
        from cohort_delivery import Delivery
        from common import _fabric_token, fabric_list, storage_token
        from research_notebook import content, explore_name
        request = self.request(query_master_id)
        name = request.get("DELIVERY_LAKEHOUSE")
        lakehouse = next((i for i in fabric_list(f"/workspaces/{self.workspace_id}/lakehouses")
                          if i["displayName"] == name), None) if name else None
        if not lakehouse:
            raise ValueError(f"Request {query_master_id} has no delivery lakehouse.")
        notebook = explore_name(name)
        Delivery(self.workspace_id, None, None, None, _fabric_token, storage_token).ensure_notebook(
            notebook, content(self.workspace_id, lakehouse["id"], name, request["TITLE"] or request["QUERY_NAME"],
                              request.get("NL_QUESTION"), request.get("QUERY_SUMMARY")),
            f"Explore the data delivered for request {query_master_id}: {request['TITLE']}"[:256],
            lakehouse.get("folderId"))
        return notebook

    def remove_request(self, query_master_id: int) -> list[str]:
        """Admin clean-up, not an MCP tool: removes a data request with its dashboard, its delivery lakehouse and
        notebook, and its Silver_OMOP cohort rows. The query itself stays in the history."""
        from deltalake import DeltaTable
        from deltalake.exceptions import TableNotFoundError

        from common import fabric, fabric_list, storage_token
        ws, removed = self.workspace_id, []
        url = self.request(query_master_id).get("REPORT_URL") or ""
        report_id = url.rsplit("/", 1)[-1] if "/reports/" in url else None
        if report_id and any(r["id"] == report_id for r in fabric_list(f"/workspaces/{ws}/reports")):
            fabric("DELETE", f"/workspaces/{ws}/reports/{report_id}")
            removed.append(f"dashboard {report_id}")
        for kind, prefix in (("lakehouses", "Delivery"), ("notebooks", "Explore")):
            for item in fabric_list(f"/workspaces/{ws}/{kind}"):
                if item["displayName"] == f"{prefix}_QM{query_master_id}" or \
                        item["displayName"].startswith(f"{prefix}_QM{query_master_id}_"):
                    fabric("DELETE", f"/workspaces/{ws}/{kind}/{item['id']}")
                    removed.append(f"{kind[:-1]} {item['displayName']}")
        silver = self.state["lakehouses"][self.cfg["LAKEHOUSE_SILVER_OMOP"]]
        opts = {"bearer_token": storage_token(), "use_fabric_endpoint": "true"}
        for table in ("cohort", "cohort_definition"):
            try:
                dt = DeltaTable(f"abfss://{ws}@onelake.dfs.fabric.microsoft.com/{silver}/Tables/{table}",
                                storage_options=opts)
            except TableNotFoundError:
                continue
            n = dt.delete(f"cohort_definition_id = {int(query_master_id)}")["num_deleted_rows"]
            if n:
                removed.append(f"{n} Silver_OMOP.{table} rows")
        store.delete_request(self.conn, query_master_id)
        return removed + [f"request {query_master_id}"]
    # --- option 2: free DAX on the Cohort Discovery model, counts only, not recorded ---
    def describe_model(self) -> dict:
        """Tables, columns, measures and AI instructions of the Cohort Discovery semantic model."""
        import importlib
        spec = importlib.import_module("18_semantic_models").discovery(self.state, self.cfg)
        return {"model": spec.name, "instructions": spec.instructions.strip(), "relationships": spec.relationships,
                "tables": [{"name": t.name, "description": t.description, "columns": t.columns or [],
                            "column_descriptions": t.column_descriptions,
                            "measures": [{"name": m.name, "description": m.description} for m in t.measures]}
                           for t in spec.tables]}

    def explore_dax(self, dax: str) -> dict:
        """Runs a DAX query on the Cohort Discovery model and returns only obfuscated patient counts.

        Every numeric value is treated as a patient count and obfuscated as for an i2b2 DATA_OBFSC user; any other
        number (an average, a lab value), patient-level column or a result of more than EXPLORE_ROWS rows is refused.
        """
        rows = self.dax(dax)
        if len(rows) > EXPLORE_ROWS:
            raise ValueError(f"The query returned {len(rows)} rows; group it into at most {EXPLORE_ROWS}.")
        columns = list(rows[0]) if rows else []
        hidden = [c for c in columns if PATIENT_LEVEL.search(c)]
        if hidden:
            raise ValueError(f"Patient-level columns can't be returned: {', '.join(hidden)}. Return counts instead.")
        out = []
        counted = [c for c in columns if any(isinstance(r.get(c), (int, float)) for r in rows)]
        for row in rows:
            if counted and all(row.get(c) is None for c in counted):
                continue  # Direct Lake's blank member: a group with no patients
            clean = {}
            for col, value in row.items():
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    if float(value) != int(value) or value < 0:
                        raise ValueError(f"Only patient counts can be returned; {col} holds {value}.")
                    clean[col] = crc.obfuscate(int(value), crc.SIGMA_TOTAL)
                else:
                    clean[col] = value
            out.append(clean)
        if self._patients is None:
            self._patients = int(self.dax('EVALUATE ROW("n", COUNTROWS(ALLNOBLANKROW(patient_dimension)))')[0]["n"])
        return {"columns": columns, "rows": out, "patients_in_model": crc.obfuscate(self._patients, crc.SIGMA_TOTAL),
                "note": "Counts are obfuscated as for an i2b2 DATA_OBFSC user: Gaussian noise (sigma 1.323); a true "
                        "count of 3 or fewer is 0. Report them as 'about N (±3)' and 0 as 'fewer than 4'."}


EXPLORE_ROWS = 100
PATIENT_LEVEL = re.compile(r"patient_num|encounter_num|_ide\b|birth|death_date|zip", re.I)


def cross_check(service: CohortService, query: dict, duck_con) -> tuple[int, int]:
    """Exact count of the same query with the DAX compiler (semantic model) and the SQL compiler (DuckDB)."""
    qd, _, _ = service.prepare(query)
    variables, cohort = Q.DaxCompiler(service.ontology).cohort(qd)
    dax = "\n".join(["DEFINE"] + [f"    VAR {n} = {e}" for n, e in variables]
                    + [f"    VAR __cohort = {cohort}", 'EVALUATE ROW("n", COUNTROWS(__cohort))'])
    t = time.time()
    dax_n = int(service.dax(dax)[0]["n"] or 0)
    sql_n = duck_con.execute(f"SELECT count(*) FROM ({Q.SqlCompiler(service.ontology).cohort(qd)})").fetchone()[0]
    print(f"    DAX {dax_n:>5}  SQL {sql_n:>5}  ({time.time() - t:.1f}s)")
    return dax_n, sql_n
