"""The cohort request dashboard: a PBIR report template and per-request copies of it.

The template ("Cohort Request (template)") lives in the workspace and can be restyled there. A request dashboard is a
copy of the template's definition with its report filter set to one QUERY_MASTER_ID, saved in the "Cohort requests"
folder. Approve and Reject are translytical buttons: they call decideRequest in the Cohort_Request_Actions user data
function, which records the signed-in user's name and the UTC time in the CRC store; the report then refreshes.
"""
from __future__ import annotations

import base64
import json

from common import fabric, fabric_list, load_state, save_state, settings

ENTITY, BREAKDOWN, EVENT = "Request", "Breakdown", "Event"
INK, IVORY, ACCENT, MUTED, RULE = "#1D1D1B", "#FAF8F3", "#F26419", "#6B6A66", "#E4E0D8"
TEMPLATE_FILTER = 0
VC = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.2.0/schema.json"


def _lit(value) -> dict:
    return {"expr": {"Literal": {"Value": value}}}


def _measure(name: str, entity: str = ENTITY) -> dict:
    return {"Measure": {"Expression": {"SourceRef": {"Entity": entity}}, "Property": name}}


def _column(name: str, entity: str = ENTITY) -> dict:
    return {"Column": {"Expression": {"SourceRef": {"Entity": entity}}, "Property": name}}


def _projection(field: dict, entity: str, name: str, label: str | None = None) -> dict:
    p = {"field": field, "queryRef": f"{entity}.{name}", "nativeQueryRef": label or name}
    if label:
        p["displayName"] = label
    return p


def _title(text: str) -> dict:
    return {"title": [{"properties": {"show": _lit("true"), "text": _lit(f"'{text}'"),
                                      "fontSize": _lit("10D"), "fontColor": {"solid": {"color": _lit(f"'{MUTED}'")}}}}]}


def _container(name: str, x, y, w, h, visual: dict, z: int = 0) -> dict:
    return {"$schema": VC, "name": name, "position": {"x": x, "y": y, "z": z, "width": w, "height": h, "tabOrder": z},
            "visual": visual}


def _textbox(name, x, y, w, h, runs: list[tuple[str, str, str]]) -> dict:
    """runs: (text, font size, colour) paragraphs."""
    paragraphs = [{"textRuns": [{"value": text, "textStyle": {"fontSize": size, "color": color,
                                                              "fontFamily": "Segoe UI"}}]}
                  for text, size, color in runs]
    return _container(name, x, y, w, h, {"visualType": "textbox",
                                         "objects": {"general": [{"properties": {"paragraphs": paragraphs}}]}})


def _card(name, x, y, w, h, measure: str, label: str, size: int = 20) -> dict:
    """A single-value card titled by the container; the card's own label and inner outline are hidden."""
    default = {"selector": {"id": "default"}}
    return _container(name, x, y, w, h, {
        "visualType": "cardVisual",
        "query": {"queryState": {"Data": {"projections": [_projection(_measure(measure), ENTITY, measure)]}}},
        "objects": {
            "value": [{"properties": {"fontSize": _lit(f"{size}D"), "fontColor": {"solid": {"color": _lit(f"'{INK}'")}},
                                      "horizontalAlignment": _lit("'left'")}} | default],
            "label": [{"properties": {"show": _lit("false")}} | default],
            "outline": [{"properties": {"show": _lit("false")}} | default],
            "padding": [{"properties": {"paddingUniform": _lit("4D")}} | default],
            "layout": [{"properties": {"paddingUniform": _lit("0D")}} | default]},
        "visualContainerObjects": _title(label) | {"padding": [{"properties": {
            k: _lit("8D") for k in ("top", "bottom", "left", "right")}}]}})


def _table(name, x, y, w, h, columns: list[tuple[str, str, str]], label: str, sort: list[str] = ()) -> dict:
    """columns: (entity, column, display name)."""
    query = {"queryState": {"Values": {"projections": [_projection(_column(c, e), e, c, d) for e, c, d in columns]}}}
    if sort:
        query["sortDefinition"] = {"sort": [{"field": _column(c, columns[0][0]), "direction": "Ascending"}
                                            for c in sort], "isDefaultSort": True}
    wrap = [{"properties": {"wordWrap": _lit("true")}}]
    return _container(name, x, y, w, h, {
        "visualType": "tableEx", "query": query,
        "objects": {"values": wrap, "columnHeaders": wrap},
        "visualContainerObjects": _title(label)})


def _button(name, x, y, w, h, text: str, decision_measure: str, ws_id: str, udf_id: str, slicer: str,
            fill: str, z: int) -> dict:
    parameters = [
        {"name": "queryMasterId", "dataType": "number", "isOptional": False, "type": "ValueParameter",
         "value": {"expr": _measure("Query master ID")}},
        {"name": "decision", "dataType": "string", "isOptional": False, "type": "ValueParameter",
         "value": {"expr": _measure(decision_measure)}},
        {"name": "comment", "dataType": "string", "isOptional": True, "type": "SlicerParameter", "slicer": slicer,
         "autoClear": True}]
    return _container(name, x, y, w, h, {
        "visualType": "actionButton",
        "objects": {
            # Button objects need a selector-less "show" entry plus per-state styling entries, or they render blank.
            "icon": [{"properties": {"show": _lit("false")}}],
            "outline": [{"properties": {"show": _lit("false")}}],
            "shape": [{"properties": {"tileShape": _lit("'rectangleRounded'"), "roundEdge": _lit("3L")}},
                      {"properties": {"tileShape": _lit("'rectangleRounded'")}, "selector": {"id": "default"}}],
            "text": [{"properties": {"show": _lit("true")}},
                     *[{"properties": {"text": _lit(f"'{text}'"), "fontColor": {"solid": {"color": _lit("'#FFFFFF'")}},
                                       "fontSize": _lit("12D"), "bold": _lit("true"),
                                       "horizontalAlignment": _lit("'center'"),
                                       "verticalAlignment": _lit("'middle'")}, "selector": {"id": state}}
                       for state in ("default", "hover", "selected")],
                     {"properties": {"text": _lit("'Saving'")}, "selector": {"id": "loading"}}],
            "fill": [{"properties": {"show": _lit("true")}},
                     *[{"properties": {"fillColor": {"solid": {"color": _lit(f"'{colour}'")}},
                                       "transparency": _lit("0D")}, "selector": {"id": state}}
                       for state, colour in (("default", fill), ("hover", INK if fill == ACCENT else MUTED),
                                             ("selected", INK if fill == ACCENT else MUTED))]]},
        "visualContainerObjects": {
            "title": [{"properties": {"show": _lit("false")}}],
            "visualLink": [{"properties": {
                "show": _lit("true"), "type": _lit("'DataFunction'"),
                "dataFunction": {"kind": "ItemLocation",
                                 "byReference": {"itemId": _lit(f"'{udf_id}'"), "workspaceId": _lit(f"'{ws_id}'")},
                                 "metadata": {"dataFunction": {"name": "decideRequest", "autoRefresh": True,
                                                               "parameters": parameters}}}}}]},
        "drillFilterOtherVisuals": True}, z=z) | {"howCreated": "InsertVisualButton"}


THEME = {
    "name": "Cohort Demo", "dataColors": [ACCENT, INK, "#8C8A84", "#C9C4BA", "#5E7B8C", "#B5542A"],
    "background": "#FFFFFF", "foreground": INK, "tableAccent": ACCENT,
    "textClasses": {"title": {"fontFace": "Segoe UI Semibold", "color": INK, "fontSize": 11},
                    "label": {"fontFace": "Segoe UI", "color": INK, "fontSize": 10},
                    "callout": {"fontFace": "Segoe UI Light", "color": INK, "fontSize": 24}},
    "visualStyles": {
        "*": {"*": {"background": [{"show": True, "color": {"solid": {"color": "#FFFFFF"}}, "transparency": 0}],
                    "border": [{"show": True, "color": {"solid": {"color": RULE}}, "radius": 3}],
                    "dropShadow": [{"show": False}]}},
        "page": {"*": {"background": [{"color": {"solid": {"color": IVORY}}, "transparency": 0}],
                       "outspace": [{"color": {"solid": {"color": IVORY}}}]}},
        "textbox": {"*": {"background": [{"show": False}], "border": [{"show": False}]}},
        "actionButton": {"*": {"border": [{"show": False}]}}}}


def template_parts(model_id: str, ws_id: str, udf_id: str, query_master_id: int = TEMPLATE_FILTER) -> dict[str, str]:
    page = "request"
    slicer = "commentSlicer"
    visuals = [
        _textbox("header", 24, 8, 1000, 84, [("Cohort data request", "22pt", INK),
                                             ("Contoso Health · i2b2 cohort discovery · review and decide", "10pt",
                                              MUTED)]),
        _card("cardQueryId", 24, 100, 176, 88, "Request number", "Query master ID"),
        _card("cardPatients", 212, 100, 216, 88, "Patient count", "Patients (obfuscated)"),
        _card("cardStatus", 440, 100, 196, 88, "Request status", "Status"),
        _card("cardRequested", 648, 100, 360, 88, "Requested by", "Requested by", size=14),
        _card("cardRequestedOn", 1020, 100, 236, 88, "Requested on", "Requested on", size=14),
        _table("tableQuestion", 24, 204, 1232, 84, [(ENTITY, "NL_QUESTION", "Question (natural language)")],
               "The question"),
        _table("tableSummary", 24, 300, 1232, 120, [(ENTITY, "QUERY_SUMMARY", "Panels (AND between, OR within)"),
                                                    (ENTITY, "QUERY_NAME", "i2b2 query name")],
               "The i2b2 query"),
        _table("tableBreakdown", 24, 432, 520, 400,
               [(BREAKDOWN, "BREAKDOWN", "Breakdown"), (BREAKDOWN, "CATEGORY", "Category"),
                (BREAKDOWN, "PATIENTS", "Patients (obfuscated)")], "Counts by category",
               sort=["BREAKDOWN", "CATEGORY"]),
        _table("tableXml", 556, 432, 700, 400, [(ENTITY, "I2B2_QUERY_XML", "query_definition")],
               "Generated i2b2 query (XML)"),
        _textbox("decisionLabel", 24, 848, 400, 40, [("Decision", "14pt", INK)]),
        _card("cardDecision", 24, 888, 520, 80, "Decision", "Current decision", size=12),
        _container(slicer, 556, 888, 380, 80, {"visualType": "textSlicer",
                                                "objects": {"general": [{"properties": {}}]},
                                                "visualContainerObjects": _title("Comment (optional)")}, z=20),
        _button("buttonApprove", 952, 900, 140, 56, "Approve", "Approve action", ws_id, udf_id, slicer, ACCENT, 21),
        _button("buttonReject", 1104, 900, 140, 56, "Reject", "Reject action", ws_id, udf_id, slicer, INK, 22),
        _textbox("footer", 24, 980, 1232, 40, [(
            "Counts are obfuscated as for an i2b2 DATA_OBFSC user (Gaussian noise; 3 or fewer shown as 0). "
            "Approve or Reject records your Microsoft Entra user name and the time (UTC). Data is delivered by a "
            "separate, manually started process after approval.", "8pt", MUTED)])]
    report = {
        "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/report/3.0.0/schema.json",
        "themeCollection": {"customTheme": {"name": "CohortDemo.json", "reportVersionAtImport": {
            "visual": "1.8.95", "report": "2.0.95", "page": "1.3.95"}, "type": "RegisteredResources"}},
        "resourcePackages": [{"name": "RegisteredResources", "type": "RegisteredResources",
                              "items": [{"name": "CohortDemo.json", "path": "CohortDemo.json",
                                         "type": "CustomTheme"}]}],
        "filterConfig": {"filters": [{
            "name": "requestFilter", "field": _column("QUERY_MASTER_ID"), "type": "Categorical",
            "filter": {"Version": 2, "From": [{"Name": "r", "Entity": ENTITY, "Type": 0}],
                       "Where": [{"Condition": {"In": {
                           "Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "r"}},
                                                       "Property": "QUERY_MASTER_ID"}}],
                           "Values": [[{"Literal": {"Value": f"{query_master_id}L"}}]]}}}]},
            "isHiddenInViewMode": True, "isLockedInViewMode": True, "howCreated": "User"}]},
        "settings": {"useStylableVisualContainerHeader": True, "exportDataMode": "AllowSummarized",
                     "defaultDrillFilterOtherVisuals": True, "useEnhancedTooltips": True}}
    parts = {
        "definition.pbir": {"$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/"
                                       "definitionProperties/2.0.0/schema.json", "version": "4.0",
                            "datasetReference": {"byConnection": {"connectionString": f"semanticmodelid={model_id}"}}},
        "definition/version.json": {"$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/"
                                               "definition/versionMetadata/1.0.0/schema.json", "version": "2.0.0"},
        "definition/report.json": report,
        "definition/pages/pages.json": {"$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/"
                                                   "definition/pagesMetadata/1.0.0/schema.json",
                                        "pageOrder": [page], "activePageName": page},
        f"definition/pages/{page}/page.json": {
            "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.0.0/"
                       "schema.json", "name": page, "displayName": "Request", "displayOption": "FitToWidth",
            "height": 1040, "width": 1280},
        "StaticResources/RegisteredResources/CohortDemo.json": THEME}
    for v in visuals:
        parts[f"definition/pages/{page}/visuals/{v['name']}/visual.json"] = v
    return {k: json.dumps(v, indent=2, ensure_ascii=False) for k, v in parts.items()}


def _definition(parts: dict[str, str]) -> dict:
    return {"parts": [{"path": p, "payload": base64.b64encode(c.encode()).decode(), "payloadType": "InlineBase64"}
                      for p, c in parts.items()]}


def ensure_folder(ws_id: str, name: str) -> str:
    folder = next((f for f in fabric_list(f"/workspaces/{ws_id}/folders") if f["displayName"] == name), None)
    if folder is None:
        folder = fabric("POST", f"/workspaces/{ws_id}/folders", {"displayName": name})
    return folder["id"]


def _upsert_report(ws_id: str, name: str, parts: dict[str, str], description: str, folder_id: str | None) -> str:
    existing = next((r for r in fabric_list(f"/workspaces/{ws_id}/reports") if r["displayName"] == name), None)
    if existing:
        fabric("POST", f"/workspaces/{ws_id}/reports/{existing['id']}/updateDefinition",
               {"definition": _definition(parts)})
        return existing["id"]
    body = {"displayName": name, "description": description, "definition": _definition(parts)}
    if folder_id:
        body["folderId"] = folder_id
    created = fabric("POST", f"/workspaces/{ws_id}/reports", body)
    return created.get("id") or next(r["id"] for r in fabric_list(f"/workspaces/{ws_id}/reports")
                                     if r["displayName"] == name)


def deploy_template(model_id: str, udf_id: str) -> str:
    state, cfg = load_state(), settings()
    ws_id = state["workspace_id"]
    folder = ensure_folder(ws_id, cfg["COHORT_REQUEST_FOLDER"])
    report_id = _upsert_report(ws_id, cfg["COHORT_REPORT_TEMPLATE"], template_parts(model_id, ws_id, udf_id),
                               "Template for cohort data request dashboards (one copy per request).", folder)
    save_state(cohort_app={**state.get("cohort_app", {}), "template_report_id": report_id, "folder_id": folder})
    return report_id


def create_for_request(query_master_id: int, title: str) -> tuple[str, str]:
    """Copies the template's definition, filters it to one query, and saves it in the request folder."""
    state = load_state()
    ws_id, app = state["workspace_id"], state["cohort_app"]
    definition = fabric("POST", f"/workspaces/{ws_id}/reports/{app['template_report_id']}/getDefinition", {})
    parts = {p["path"]: base64.b64decode(p["payload"]).decode() for p in definition["definition"]["parts"]}
    report = json.loads(parts["definition/report.json"])
    for f in report.get("filterConfig", {}).get("filters", []):
        if f.get("name") == "requestFilter":
            f["filter"]["Where"][0]["Condition"]["In"]["Values"] = [[{"Literal": {"Value": f"{query_master_id}L"}}]]
    parts["definition/report.json"] = json.dumps(report, indent=2, ensure_ascii=False)
    name = f"Cohort request {query_master_id} - {title}"[:256]
    report_id = _upsert_report(ws_id, name, parts, f"Data request for i2b2 QUERY_MASTER_ID {query_master_id}.",
                               app["folder_id"])
    return report_id, f"https://app.fabric.microsoft.com/groups/{ws_id}/reports/{report_id}"
