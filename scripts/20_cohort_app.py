"""Stage 4, step 3: the data-request workflow around the CRC store.

- Cohort_Request_Actions (Fabric user data function): decideRequest (the dashboard's Approve / Reject buttons),
  getDeliveryPackage and markDelivered (the delivery notebook). Each records the calling user from its context.
- "Cohort Requests" semantic model: DirectQuery over the CRC store's V_* views, so a decision shows as soon as the
  button runs. Bound to the database with single sign-on.
- "Cohort Request (template)" report in the "Cohort requests" folder: every request dashboard is a copy of it.
- Cohort_Delivery notebook: delivers an approved request (QUERY_MASTER_ID, DEMO_MODE, DELIVERY_FOLDER_ID).
- Cohort_Delivery_Pipeline (Fabric data pipeline): runs the notebook with those parameters; the approval app starts it
  and follows its status.

Run after 19_cohort_store.py; the capacity must be running.
"""
from __future__ import annotations

import base64
import importlib
import re
import json
import time

import requests

import request_report
from common import ROOT, fabric, fabric_list, load_state, save_state, settings
from semantic_models import powerbi_token

nb = importlib.import_module("16_fabric_notebooks")
UDF_FUNCTIONS = {
    "decideRequest": ("Approve or reject a cohort data request (dashboard buttons).",
                      [("queryMasterId", "int"), ("decision", "str"), ("comment", "str")]),
    "getDeliveryPackage": ("Approved request and its patient set, for the delivery notebook.",
                           [("queryMasterId", "int")]),
    "markDelivered": ("Record that an approved request was delivered.",
                      [("queryMasterId", "int"), ("lakehouse", "str"), ("patients", "int")]),
    "deliveryProgress": ("One step of a running delivery, for the approval app.",
                         [("queryMasterId", "int"), ("detail", "str")])}
UDF_LIBRARY = ("fabric-user-data-functions", "1.0.142")


def _b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


def deploy_udf(ws_id: str, db_id: str) -> str:
    name = settings()["COHORT_FUNCTIONS"]
    definition = {
        "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/userDataFunction/definition/1.1.0/"
                   "schema.json",
        "runtime": "PYTHON",
        "connectedDataSources": [{"alias": "CohortRequests", "artifactId": db_id, "artifactType": "SqlDbNative",
                                  "workspaceId": ws_id}],
        "functions": [{"name": f, "description": d, "isPublicEndpointEnabled": True}
                      for f, (d, _) in UDF_FUNCTIONS.items()],
        "libraries": {"public": [{"name": UDF_LIBRARY[0], "type": "PYPI", "version": UDF_LIBRARY[1]}], "private": []}}
    functions = {"runtime": "PYTHON", "functionsMetadata": [{
        "name": f, "scriptFile": "function_app.py",
        "bindings": [{"name": "req", "type": "HttpTrigger", "direction": "In", "authLevel": "Anonymous",
                      "methods": ["POST"], "route": ""},
                     {"name": "crcDb", "type": "FabricItem", "direction": "In", "alias": "CohortRequests",
                      "subType": "FabricSqlConnection", "itemType": None, "audienceType": None},
                     {"name": "ctx", "direction": "In", "type": "UserDataFunctionContext"}],
        "fabricProperties": {"fabricMetadataSchemaVersion": "1.1.0", "fabricFunctionReturnType": "str",
                             "fabricFunctionParameters": [{"name": p, "dataType": t} for p, t in params]}}
        for f, (_, params) in UDF_FUNCTIONS.items()]}
    code = (ROOT / "scripts" / "udf_cohort_request_actions.py").read_text()
    parts = {"definition.json": json.dumps(definition, indent=2), "function_app.py": code,
             "resources/functions.json": json.dumps(functions, indent=2)}
    body = {"parts": [{"path": p, "payload": _b64(c), "payloadType": "InlineBase64"} for p, c in parts.items()]}
    existing = next((u for u in fabric_list(f"/workspaces/{ws_id}/userDataFunctions") if u["displayName"] == name),
                    None)
    if existing:
        udf_id = existing["id"]
        current = fabric("POST", f"/workspaces/{ws_id}/userDataFunctions/{udf_id}/getDefinition", {})
        current = {p["path"]: base64.b64decode(p["payload"]).decode()
                   for p in current.get("definition", {}).get("parts", [])}
        if current.get("function_app.py") == code and all(
                json.loads(current.get(k, "null")) == json.loads(parts[k]) for k in ("definition.json",)):
            print(f"User data function {name} is up to date")
            return udf_id
        for attempt in range(6):   # publishing has a cooldown of about two minutes between updates
            try:
                fabric("POST", f"/workspaces/{ws_id}/userDataFunctions/{udf_id}/updateDefinition", {"definition": body})
                break
            except RuntimeError as exc:
                wait = re.search(r"wait (\d+) second", str(exc))
                if not wait or attempt == 5:
                    raise
                time.sleep(int(wait.group(1)) + 5)
        print(f"Updated user data function {name}")
    else:
        created = fabric("POST", f"/workspaces/{ws_id}/userDataFunctions",
                         {"displayName": name, "description": "Approve, reject and deliver cohort data requests.",
                          "definition": body})
        udf_id = created.get("id") or next(u["id"] for u in fabric_list(f"/workspaces/{ws_id}/userDataFunctions")
                                           if u["displayName"] == name)
        print(f"Created user data function {name}")
    return udf_id


def invoke_udf(ws_id: str, udf_id: str, function: str, body: dict) -> dict:
    url = f"https://api.fabric.microsoft.com/v1/workspaces/{ws_id}/userDataFunctions/{udf_id}/functions/{function}/invoke"
    resp = requests.post(url, json=body, headers={"Authorization": f"Bearer {powerbi_token()}"}, timeout=120)
    return {"http": resp.status_code, **(resp.json() if resp.content else {})}


def wait_until_published(ws_id: str, udf_id: str, timeout_s: int = 600):
    """Publishing follows the definition update; a probe call answers once the functions are live."""
    start = time.time()
    while time.time() - start < timeout_s:
        r = invoke_udf(ws_id, udf_id, "decideRequest", {"queryMasterId": -1, "decision": "APPROVED", "comment": ""})
        text = json.dumps(r)
        if "There is no data request -1" in text:
            print(f"  functions are live ({time.time() - start:.0f}s)")
            return
        time.sleep(20)
    raise RuntimeError(f"User data functions not live after {timeout_s}s: {text[:600]}")


# --- Cohort Requests semantic model (DirectQuery) -----------------------------------------------------------------

V, I, DT = "string", "int64", "dateTime"
REQUEST_COLUMNS = [("QUERY_MASTER_ID", I), ("QUERY_NAME", V), ("TITLE", V), ("NL_QUESTION", V), ("QUERY_SUMMARY", V),
                   ("I2B2_QUERY_XML", V), ("QUERY_LANGUAGE", V), ("QUERY_USER", V), ("QUERY_CREATED_AT", DT),
                   ("PATIENT_SET_RESULT_INSTANCE_ID", I), ("PATIENT_COUNT", I), ("OBFUSC_METHOD", V),
                   ("PATIENT_COUNT_DISPLAY", V), ("STATUS", V), ("REQUESTED_BY", V), ("REQUESTED_AT", DT),
                   ("DECIDED_BY", V), ("DECIDED_AT", DT), ("DECISION_COMMENT", V), ("REPORT_URL", V),
                   ("DELIVERED_BY", V), ("DELIVERED_AT", DT), ("DELIVERY_LAKEHOUSE", V), ("DELIVERED_PATIENTS", I)]
BREAKDOWN_COLUMNS = [("QUERY_MASTER_ID", I), ("RESULT_TYPE", V), ("BREAKDOWN", V), ("CATEGORY", V),
                     ("PATIENTS", I), ("SORT_ORDER", I)]
EVENT_COLUMNS = [("EVENT_ID", I), ("QUERY_MASTER_ID", I), ("EVENT", V), ("ACTOR", V), ("EVENT_AT", DT),
                 ("DETAIL", V)]
STAMP = 'FORMAT(SELECTEDVALUE({t}[{c}]), "yyyy-mm-dd hh:nn") & " UTC"'
REQUEST_MEASURES = [
    ("Query master ID", "SELECTEDVALUE(Request[QUERY_MASTER_ID])", "0"),
    ("Request number", 'FORMAT(SELECTEDVALUE(Request[QUERY_MASTER_ID]), "0")', None),
    ("Patient count", "SELECTEDVALUE(Request[PATIENT_COUNT_DISPLAY])", None),
    ("Request status", "SELECTEDVALUE(Request[STATUS])", None),
    ("Requested by", "SELECTEDVALUE(Request[REQUESTED_BY])", None),
    ("Requested on", STAMP.format(t="Request", c="REQUESTED_AT"), None),
    ("Decision", 'VAR s = SELECTEDVALUE(Request[STATUS]) RETURN SWITCH(s, "PENDING", "Awaiting a decision", '
                 '"APPROVED", "Approved by " & SELECTEDVALUE(Request[DECIDED_BY]) & " on " & '
                 + STAMP.format(t="Request", c="DECIDED_AT") +
                 ', "REJECTED", "Rejected by " & SELECTEDVALUE(Request[DECIDED_BY]) & " on " & '
                 + STAMP.format(t="Request", c="DECIDED_AT") +
                 ', "DELIVERED", "Approved by " & SELECTEDVALUE(Request[DECIDED_BY]) & "; delivered to " & '
                 'SELECTEDVALUE(Request[DELIVERY_LAKEHOUSE]) & " on " & '
                 + STAMP.format(t="Request", c="DELIVERED_AT") + ', BLANK())', None),
    ("Approve action", '"APPROVED"', None),
    ("Reject action", '"REJECTED"', None)]


def _dq_table(name: str, view: str, columns, server: str, database: str, measures=()) -> str:
    lines = [f"table {name}\n", f"\tlineageTag: {request_report_tag(name)}\n\n"]
    for m, expr, fmt in measures:
        lines += [f"\tmeasure '{m}' = {expr}\n"]
        if fmt:
            lines.append(f"\t\tformatString: {fmt}\n")
        lines.append(f"\t\tlineageTag: {request_report_tag(name, m)}\n\n")
    for c, t in columns:
        lines += [f"\tcolumn {c}\n", f"\t\tdataType: {t}\n"]
        if t == DT:
            lines.append("\t\tformatString: yyyy-mm-dd hh:nn\n")
        if t == I:
            lines.append("\t\tformatString: 0\n")
        lines += [f"\t\tlineageTag: {request_report_tag(name, c)}\n", "\t\tsummarizeBy: none\n",
                  f"\t\tsourceColumn: {c}\n\n", "\t\tannotation SummarizationSetBy = Automatic\n\n"]
    lines += [f"\tpartition {name} = m\n", "\t\tmode: directQuery\n", "\t\tsource =\n", "\t\t\t\tlet\n",
              f"\t\t\t\t    Source = Sql.Database(\"{server}\", \"{database}\"),\n",
              f"\t\t\t\t    View = Source{{[Schema=\"crc\",Item=\"{view}\"]}}[Data]\n", "\t\t\t\tin\n",
              "\t\t\t\t    View\n\n"]
    return "".join(lines)


def request_report_tag(*parts: str) -> str:
    import uuid
    return str(uuid.uuid5(uuid.UUID("2f6a3c1e-0b7d-4e7a-9d0b-6c1f2a3b4c5d"), "/".join(("requests",) + parts)))


def deploy_requests_model(ws_id: str, db: dict) -> str:
    name = settings()["SEMANTIC_MODEL_REQUESTS"]
    server, database = db["server"], db["database"]
    parts = {
        "definition.pbism": json.dumps({"$schema": "https://developer.microsoft.com/json-schemas/fabric/item/"
                                                   "semanticModel/definitionProperties/1.0.0/schema.json",
                                        "version": "4.2", "settings": {}}),
        "definition/database.tmdl": "database\n\tcompatibilityLevel: 1604\n",
        "definition/model.tmdl": ("model Model\n\tculture: en-US\n\tdefaultPowerBIDataSourceVersion: powerBI_V3\n"
                                  "\tsourceQueryCulture: en-US\n\tdataAccessOptions\n\t\tlegacyRedirects\n"
                                  "\t\treturnErrorValuesAsNull\n\nref table Request\nref table Breakdown\n"
                                  "ref table Event\n"),
        "definition/tables/Request.tmdl": _dq_table("Request", "V_REQUEST", REQUEST_COLUMNS, server, database,
                                                    REQUEST_MEASURES),
        "definition/tables/Breakdown.tmdl": _dq_table("Breakdown", "V_REQUEST_BREAKDOWN", BREAKDOWN_COLUMNS, server,
                                                      database),
        "definition/tables/Event.tmdl": _dq_table("Event", "V_REQUEST_EVENT", EVENT_COLUMNS, server, database),
        "definition/relationships.tmdl": (
            f"relationship {request_report_tag('rel', 'breakdown')}\n\tfromColumn: Breakdown.QUERY_MASTER_ID\n"
            f"\ttoColumn: Request.QUERY_MASTER_ID\n\nrelationship {request_report_tag('rel', 'event')}\n"
            f"\tfromColumn: Event.QUERY_MASTER_ID\n\ttoColumn: Request.QUERY_MASTER_ID\n")}
    body = {"parts": [{"path": p, "payload": _b64(c), "payloadType": "InlineBase64"} for p, c in parts.items()]}
    existing = next((m for m in fabric_list(f"/workspaces/{ws_id}/semanticModels") if m["displayName"] == name), None)
    if existing:
        fabric("POST", f"/workspaces/{ws_id}/semanticModels/{existing['id']}/updateDefinition", {"definition": body})
        model_id = existing["id"]
        print(f"Updated semantic model {name}")
    else:
        created = fabric("POST", f"/workspaces/{ws_id}/semanticModels",
                         {"displayName": name, "description": "Cohort data requests (DirectQuery on the CRC store).",
                          "definition": body})
        model_id = created.get("id") or next(m["id"] for m in fabric_list(f"/workspaces/{ws_id}/semanticModels")
                                             if m["displayName"] == name)
        print(f"Created semantic model {name}")
    bind_sso(ws_id, model_id)
    return model_id


def bind_sso(ws_id: str, model_id: str):
    """Sets the model's SQL data source to OAuth2 with end-user single sign-on, so each viewer queries the CRC store
    as themselves. (Fabric's bindConnection 'Automatic' isn't accepted for this connection type.)"""
    import subprocess
    headers = {"Authorization": f"Bearer {powerbi_token()}"}
    base = "https://api.powerbi.com/v1.0/myorg"
    sources = requests.get(f"{base}/groups/{ws_id}/datasets/{model_id}/datasources", headers=headers,
                           timeout=60).json().get("value", [])
    sql_token = subprocess.run(["az", "account", "get-access-token", "--resource", "https://database.windows.net/",
                                "--query", "accessToken", "-o", "tsv"], check=True, capture_output=True,
                               text=True).stdout.strip()
    for src in sources:
        body = {"credentialDetails": {
            "credentialType": "OAuth2", "useEndUserOAuth2Credentials": True, "encryptedConnection": "Encrypted",
            "encryptionAlgorithm": "None", "privacyLevel": "Organizational",
            "credentials": json.dumps({"credentialData": [{"name": "accessToken", "value": sql_token}]})}}
        resp = requests.patch(f"{base}/gateways/{src['gatewayId']}/datasources/{src['datasourceId']}", json=body,
                              headers=headers, timeout=60)
        if resp.status_code != 200:
            raise RuntimeError(f"Setting credentials failed: {resp.status_code} {resp.text[:400]}")
        print(f"  {src['connectionDetails']['database']}: OAuth2 with single sign-on")


DEMO_LIMITS = "25 patients, 20 documents and 5 imaging studies"


def deploy_pipeline(ws_id: str, notebook_id: str, name: str, folder_id: str | None) -> str:
    """Cohort_Delivery_Pipeline: one notebook activity that runs Cohort_Delivery with the pipeline's parameters."""
    expression = lambda p, t: {"value": {"value": f"@pipeline().parameters.{p}", "type": "Expression"}, "type": t}  # noqa: E731
    content = {"properties": {
        "description": "Delivers an approved cohort data request (started from the approval app).",
        "activities": [{
            "name": "Deliver cohort data", "type": "TridentNotebook", "dependsOn": [],
            "policy": {"timeout": "0.02:00:00", "retry": 0, "retryIntervalInSeconds": 30, "secureOutput": False,
                       "secureInput": False},
            "typeProperties": {"notebookId": notebook_id, "workspaceId": ws_id, "parameters": {
                "QUERY_MASTER_ID": expression("QUERY_MASTER_ID", "int"),
                "DEMO_MODE": expression("DEMO_MODE", "bool"),
                "DELIVERY_FOLDER_ID": expression("DELIVERY_FOLDER_ID", "string")}}}],
        "parameters": {"QUERY_MASTER_ID": {"type": "int", "defaultValue": 0},
                       "DEMO_MODE": {"type": "bool", "defaultValue": True},
                       "DELIVERY_FOLDER_ID": {"type": "string", "defaultValue": ""}}}}
    definition = {"parts": [{"path": "pipeline-content.json", "payload": _b64(json.dumps(content, indent=2)),
                             "payloadType": "InlineBase64"}]}
    existing = next((p for p in fabric_list(f"/workspaces/{ws_id}/dataPipelines") if p["displayName"] == name), None)
    if existing:
        fabric("POST", f"/workspaces/{ws_id}/dataPipelines/{existing['id']}/updateDefinition", {"definition": definition})
        print(f"Updated pipeline {name}")
        return existing["id"]
    body = {"displayName": name, "description": content["properties"]["description"], "definition": definition}
    if folder_id:
        body["folderId"] = folder_id
    created = fabric("POST", f"/workspaces/{ws_id}/dataPipelines", body)
    print(f"Created pipeline {name}")
    return created.get("id") or next(p["id"] for p in fabric_list(f"/workspaces/{ws_id}/dataPipelines")
                                     if p["displayName"] == name)


def main():
    state, cfg = load_state(), settings()
    ws_id, db = state["workspace_id"], state["cohort_requests_db"]
    udf_id = deploy_udf(ws_id, db["id"])
    wait_until_published(ws_id, udf_id)
    model_id = deploy_requests_model(ws_id, db)
    template_id = request_report.deploy_template(model_id, udf_id)
    print(f"Template report: {template_id}")

    silver_id = state["lakehouses"][cfg["LAKEHOUSE_SILVER_OMOP"]]
    nb.upload_code(ws_id, silver_id)
    content = nb.notebook(
        "Cohort data delivery",
        "Delivers one approved cohort data request. The approval app runs it through the Cohort_Delivery_Pipeline; "
        "to run it by hand, set QUERY_MASTER_ID (the request number) and run all.\nThe notebook maps the patient set "
        "to OMOP persons, adds the cohort to Silver_OMOP.cohort, and creates the lakehouse "
        "Delivery_QM<id>_<title> in DELIVERY_FOLDER_ID (blank = workspace root): the cohort's OMOP tables (copied), "
        "its DICOM studies (OneLake shortcuts) and its documents (copied). DEMO_MODE = True limits the delivery to "
        f"{DEMO_LIMITS}. Each step is recorded in the CRC store, so the approval app shows the progress.",
        {"QUERY_MASTER_ID": 0, "DEMO_MODE": False, "DELIVERY_FOLDER_ID": "", "WORKSPACE_ID": ws_id,
         "SILVER_OMOP_ID": silver_id, "BRONZE_DOCUMENTS_ID": state["lakehouses"][cfg["LAKEHOUSE_DOCUMENTS"]],
         "UDF_ID": udf_id, "MODULES": nb.MODULES, "RUN_LOG_ITEM_ID": silver_id, "RUN_NAME": "cohort_delivery"},
        [("deliver", '''
from cohort_delivery import Delivery

if not QUERY_MASTER_ID:
    raise ValueError("Set QUERY_MASTER_ID to the query master ID of an approved request.")
delivery = Delivery(WORKSPACE_ID, SILVER_OMOP_ID, BRONZE_DOCUMENTS_ID, UDF_ID,
                    lambda: notebookutils.credentials.getToken("pbi"), token)
result = delivery.run(int(QUERY_MASTER_ID), demo=str(DEMO_MODE).lower() in ("true", "1"),
                      folder_id=DELIVERY_FOLDER_ID or None)
save(RUN_NAME, result)
''')])
    notebook_id = nb.deploy(ws_id, cfg["COHORT_DELIVERY_NOTEBOOK"], content,
                            "Delivers an approved cohort data request (run by Cohort_Delivery_Pipeline, or by hand).")
    folder_id = request_report.ensure_folder(ws_id, cfg["COHORT_REQUEST_FOLDER"])
    pipeline_id = deploy_pipeline(ws_id, notebook_id, cfg.get("COHORT_DELIVERY_PIPELINE", "Cohort_Delivery_Pipeline"),
                                  folder_id)
    save_state(cohort_app={**load_state().get("cohort_app", {}), "udf_id": udf_id, "requests_model_id": model_id,
                           "delivery_notebook_id": notebook_id, "delivery_pipeline_id": pipeline_id})
    print(f"Delivery pipeline: {pipeline_id}")
    print(f"Delivery notebook: {notebook_id}")


if __name__ == "__main__":
    main()
