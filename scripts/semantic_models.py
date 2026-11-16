"""Generates and deploys Direct Lake on OneLake semantic models (TMDL) through the Fabric REST API.

A model is described by a ModelSpec: one OneLake source expression per Fabric item, tables (a subset of columns of a
Delta table, with descriptions and measures), relationships and optional AI instructions. Column data types are read
from the Delta tables themselves, so the model always matches what the ETL wrote.
"""
from __future__ import annotations

import base64
import json
import time
import uuid
from dataclasses import dataclass, field

import requests

from common import fabric, fabric_list, load_state, save_state, storage_token

NS = uuid.UUID("5d0b1a54-7f3e-4b51-9a77-1c2a4f0e9d10")
DELTA_TO_TMDL = {"string": "string", "long": "int64", "integer": "int64", "short": "int64", "byte": "int64",
                 "double": "double", "float": "double", "boolean": "boolean", "timestamp": "dateTime",
                 "timestamp_ntz": "dateTime", "date": "dateTime"}


@dataclass
class Measure:
    name: str
    expression: str
    format: str = "#,0"
    description: str = ""


@dataclass
class Table:
    name: str
    source: str                         # key of ModelSpec.sources
    entity: str                         # Delta table name
    schema: str | None = None           # for schema-enabled items (Fabric SQL database: 'pacs')
    columns: list[str] | None = None    # None = every column
    description: str = ""
    column_descriptions: dict[str, str] = field(default_factory=dict)
    measures: list[Measure] = field(default_factory=list)
    hidden: tuple[str, ...] = ()


@dataclass
class ModelSpec:
    name: str
    description: str
    sources: dict[str, str]             # expression name -> Fabric item id
    tables: list[Table]
    relationships: list[tuple[str, str]]  # ("table.column", "table.column") many -> one
    instructions: str = ""


def _q(name: str) -> str:
    return f"'{name}'" if any(ch in name for ch in " .-'()") else name


def _tag(*parts: str) -> str:
    return str(uuid.uuid5(NS, "/".join(parts)))


def _desc(text: str, indent: str) -> str:
    return "".join(f"{indent}/// {line}\n" for line in text.strip().splitlines()) if text.strip() else ""


def delta_columns(workspace_id: str, item_id: str, entity: str, schema: str | None) -> list[tuple[str, str]]:
    from deltalake import DeltaTable
    path = f"{schema}/{entity}" if schema else entity
    table = DeltaTable(f"abfss://{workspace_id}@onelake.dfs.fabric.microsoft.com/{item_id}/Tables/{path}",
                       storage_options={"bearer_token": storage_token(), "use_fabric_endpoint": "true"})
    out = []
    for f in table.schema().fields:
        kind = f.type.type if hasattr(f.type, "type") else str(f.type)
        kind = "decimal" if str(kind).startswith("decimal") else str(kind)
        out.append((f.name, "decimal" if kind == "decimal" else DELTA_TO_TMDL.get(kind, "string")))
    return out


def definition_parts(spec: ModelSpec, workspace_id: str) -> dict[str, str]:
    parts = {"definition.pbism": json.dumps({
        "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/"
                   "1.0.0/schema.json", "version": "4.2", "settings": {"qnaEnabled": True}}, indent=2),
             "definition/database.tmdl": "database\n\tcompatibilityLevel: 1604\n"}
    expressions = []
    for name, item in spec.sources.items():
        expressions.append(
            f"expression '{name}' =\n\t\tlet\n\t\t    Source = AzureStorage.DataLake(\"https://onelake.dfs.fabric."
            f"microsoft.com/{workspace_id}/{item}\", [HierarchicalNavigation=true])\n\t\tin\n\t\t    Source\n"
            f"\tlineageTag: {_tag(spec.name, 'expr', name)}\n\n\tannotation PBI_IncludeFutureArtifacts = False\n")
    parts["definition/expressions.tmdl"] = "\n".join(expressions)
    order = json.dumps(list(spec.sources))
    parts["definition/model.tmdl"] = (
        f"model Model\n\tculture: en-US\n\tdefaultPowerBIDataSourceVersion: powerBI_V3\n\tsourceQueryCulture: en-US\n"
        f"\tdataAccessOptions\n\t\tlegacyRedirects\n\t\treturnErrorValuesAsNull\n\n"
        f"annotation PBI_QueryOrder = {order}\n\nannotation PBI_ProTooling = [\"DirectLakeOnOneLakeInWeb\"]\n\n"
        + "".join(f"ref table {_q(t.name)}\n" for t in spec.tables))
    for t in spec.tables:
        available = dict(delta_columns(workspace_id, spec.sources[t.source], t.entity, t.schema))
        names = t.columns or list(available)
        missing = [c for c in names if c not in available]
        if missing:
            raise ValueError(f"{t.name}: columns not in {t.entity}: {missing}")
        lines = [_desc(t.description, ""), f"table {_q(t.name)}\n", f"\tlineageTag: {_tag(spec.name, t.name)}\n",
                 f"\tsourceLineageTag: [{t.schema or 'dbo'}].[{t.entity}]\n\n"]
        for m in t.measures:
            lines += [_desc(m.description, "\t"), f"\tmeasure {_q(m.name)} = {m.expression}\n",
                      f"\t\tformatString: {m.format}\n" if m.format else "",
                      f"\t\tlineageTag: {_tag(spec.name, t.name, 'm', m.name)}\n\n"]
        for c in names:
            dtype = available[c]
            lines += [_desc(t.column_descriptions.get(c, ""), "\t"), f"\tcolumn {_q(c)}\n",
                      f"\t\tdataType: {dtype}\n"]
            if c in t.hidden:
                lines.append("\t\tisHidden\n")
            if dtype == "dateTime":
                lines.append("\t\tformatString: General Date\n")
            elif dtype == "int64":
                lines.append("\t\tformatString: 0\n")
            lines += [f"\t\tlineageTag: {_tag(spec.name, t.name, c)}\n", f"\t\tsourceLineageTag: {c}\n",
                      "\t\tsummarizeBy: none\n", f"\t\tsourceColumn: {c}\n\n",
                      "\t\tannotation SummarizationSetBy = Automatic\n\n"]
        lines += [f"\tpartition {_q(t.name)} = entity\n", "\t\tmode: directLake\n", "\t\tsource\n",
                  f"\t\t\tentityName: {t.entity}\n"]
        if t.schema:
            lines.append(f"\t\t\tschemaName: {t.schema}\n")
        lines.append(f"\t\t\texpressionSource: '{t.source}'\n\n")
        parts[f"definition/tables/{t.name}.tmdl"] = "".join(lines)
    rels = []
    for frm, to in spec.relationships:
        (ft, fc), (tt, tc) = frm.rsplit(".", 1), to.rsplit(".", 1)
        rels.append(f"relationship {_tag(spec.name, 'rel', frm, to)}\n\tfromColumn: {_q(ft)}.{_q(fc)}\n"
                    f"\ttoColumn: {_q(tt)}.{_q(tc)}\n")
    parts["definition/relationships.tmdl"] = "\n".join(rels)
    if spec.instructions:
        parts["Copilot/Instructions/instructions.md"] = spec.instructions.strip() + "\n"
        parts["Copilot/Instructions/version.json"] = json.dumps({
            "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/version/1.0.0/schema.json",
            "version": "1.0.0"})
        parts["Copilot/version.json"] = parts["Copilot/Instructions/version.json"]
    return parts


def _payload(parts: dict[str, str]) -> dict:
    return {"parts": [{"path": p, "payload": base64.b64encode(c.encode()).decode(), "payloadType": "InlineBase64"}
                      for p, c in parts.items()]}


def powerbi_token() -> str:
    import subprocess
    out = subprocess.run(["az", "account", "get-access-token", "--resource", "https://analysis.windows.net/powerbi/api",
                          "--query", "accessToken", "-o", "tsv"], check=True, capture_output=True, text=True)
    return out.stdout.strip()


def refresh(workspace_id: str, model_id: str, timeout_s: int = 600):
    """Frames a Direct Lake model (Power BI refresh API) and waits for the result."""
    url = f"https://api.powerbi.com/v1.0/myorg/groups/{workspace_id}/datasets/{model_id}/refreshes"
    headers = {"Authorization": f"Bearer {powerbi_token()}"}
    for attempt in range(10):
        resp = requests.post(url, json={"type": "full", "retryCount": 1}, headers=headers, timeout=60)
        if resp.status_code == 202:
            break
        time.sleep(15)
    else:
        raise RuntimeError(f"Refresh request failed: {resp.status_code} {resp.text[:400]}")
    start = time.time()
    while time.time() - start < timeout_s:
        time.sleep(5)
        last = requests.get(url + "?$top=1", headers=headers, timeout=60).json()["value"][0]
        if last["status"] in ("Completed", "Failed", "Disabled", "Cancelled"):
            if last["status"] != "Completed":
                raise RuntimeError(f"Refresh {last['status']}: {json.dumps(last.get('serviceExceptionJson'))[:800]}")
            return
    raise RuntimeError("Refresh did not finish in time")


def deploy(spec: ModelSpec, folder_id: str | None = None) -> str:
    state = load_state()
    ws = state["workspace_id"]
    definition = _payload(definition_parts(spec, ws))
    existing = next((m for m in fabric_list(f"/workspaces/{ws}/semanticModels") if m["displayName"] == spec.name),
                    None)
    if existing:
        fabric("POST", f"/workspaces/{ws}/semanticModels/{existing['id']}/updateDefinition", {"definition": definition})
        model_id = existing["id"]
        print(f"Updated semantic model {spec.name}")
    else:
        body = {"displayName": spec.name, "description": spec.description, "definition": definition}
        if folder_id:
            body["folderId"] = folder_id
        created = fabric("POST", f"/workspaces/{ws}/semanticModels", body)
        model_id = created.get("id") or next(m["id"] for m in fabric_list(f"/workspaces/{ws}/semanticModels")
                                             if m["displayName"] == spec.name)
        print(f"Created semantic model {spec.name}")
    refresh(ws, model_id)
    save_state(semantic_models={**load_state().get("semantic_models", {}), spec.name: model_id})
    return model_id


def execute_dax(workspace_id: str, model_id: str, dax: str) -> list[dict]:
    """Runs one DAX query (Power BI executeQueries) as the signed-in user and returns the rows."""
    url = f"https://api.powerbi.com/v1.0/myorg/groups/{workspace_id}/datasets/{model_id}/executeQueries"
    for attempt in range(5):
        resp = requests.post(url, json={"queries": [{"query": dax}], "serializerSettings": {"includeNulls": True}},
                             headers={"Authorization": f"Bearer {powerbi_token()}"}, timeout=300)
        if resp.status_code == 429 or resp.status_code >= 500:
            time.sleep(10 * (attempt + 1))
            continue
        break
    body = resp.json() if resp.content else {}
    if resp.status_code != 200 or "error" in body.get("results", [{}])[0]:
        detail = body.get("error") or body.get("results", [{}])[0].get("error") or resp.text[:800]
        raise RuntimeError(f"DAX query failed ({resp.status_code}): {json.dumps(detail)[:1500]}")
    rows = body["results"][0]["tables"][0].get("rows", [])
    return [{k.split("[")[-1].rstrip("]"): v for k, v in r.items()} for r in rows]
