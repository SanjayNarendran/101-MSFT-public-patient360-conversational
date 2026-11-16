"""Cohort discovery MCP server (stdio) for GitHub Copilot: natural language -> i2b2 query -> obfuscated counts.

Copilot maps a question to i2b2 ontology terms, builds an i2b2 query definition (panels ANDed, items within a panel
ORed), runs it against the "Cohort Discovery (i2b2)" semantic model and gets back a QUERY_MASTER_ID with obfuscated
counts. When the researcher is happy, submit_request creates the data request and links it to its approval page (the
approval app, or a Power BI dashboard with APPROVAL_UI=powerbi). Approving and delivering a request are deliberately
not tools here.

Run by VS Code from .vscode/mcp.json; to try it by hand: .venv/bin/python scripts/cohort_mcp.py
"""
from __future__ import annotations

import contextlib
import json
import os
import sys
import threading
import traceback
from typing import Any, Literal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import ensure_openssl  # noqa: E402

ensure_openssl()

from mcp.server.mcpserver import MCPServer  # noqa: E402
from mcp.server.mcpserver.exceptions import ToolError  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from cohort_service import CohortService  # noqa: E402

INSTRUCTIONS = """\
Cohort discovery over an i2b2 star schema (Contoso Health synthetic data, Epic Clarity -> OMOP -> i2b2).
Workflow: (1) find concepts with search_ontology / browse_ontology (and list_modifiers for modifiers such as
nodule size); (2) build an i2b2 query definition from the returned item_key values; (3) optionally check it with
preview_query; (4) run_i2b2_query with the researcher's question; (5) show the QUERY_MASTER_ID, the i2b2 query
summary and the obfuscated counts; iterate as asked; (6) only when the researcher says so, submit_request.
Rules: use only item_key values returned by the ontology tools; panels are ANDed and items inside a panel are ORed;
invert a panel for NOT; with SAMEVISIT timing, give panels that aren't about the same visit (such as "excluding
anyone with X") panel_timing ANY; counts are obfuscated (N±3, 3 or fewer shown as 0) and patient-level data is never
returned. Approval happens on the request's approval page; delivery is a separate manual step."""

server = MCPServer("cohort-discovery", instructions=INSTRUCTIONS, log_level="WARNING")
_service: CohortService | None = None
_lock = threading.Lock()  # one CRC store connection; tool calls can arrive in parallel


def service() -> CohortService:
    global _service
    if _service is None:
        _service = CohortService()
    return _service


def call(fn, *args, **kwargs):
    """Runs a service call with stdout (the MCP channel) redirected, and returns JSON-safe data. Errors go back to
    the client as ToolError so Copilot sees the reason (mcp 2.x hides the text of any other exception)."""
    try:
        with _lock, contextlib.redirect_stdout(sys.stderr):
            result = fn(*args, **kwargs)
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        raise ToolError(f"{type(exc).__name__}: {exc}") from exc
    return json.loads(json.dumps(result, default=str))


class ValueConstraint(BaseModel):
    value_operator: str = Field(description="NUMBER: GT, GE, LT, LE, EQ, NE or BETWEEN. TEXT: EQ, NE, IN, "
                                            "LIKE[contains], LIKE[begin], LIKE[end], LIKE[exact].")
    value_constraint: str = Field(description="The value, e.g. '6'; BETWEEN as '6 and 10'; IN as 'A','B'.")
    value_type: Literal["NUMBER", "TEXT"] = "NUMBER"
    value_unit_of_measure: str | None = None


class DateConstraint(BaseModel):
    date_from: str | None = Field(None, description="YYYY-MM-DD, on the observation start date")
    date_to: str | None = Field(None, description="YYYY-MM-DD")


class ModifierConstraint(BaseModel):
    modifier_key: str = Field(description="A modifier_key from list_modifiers whose applies_to matches the item")
    modifier_name: str = ""
    constrain_by_value: ValueConstraint | None = None


class Item(BaseModel):
    item_key: str = Field(description="An item_key returned by search_ontology or browse_ontology, "
                                      "e.g. \\\\i2b2_diagnoses\\i2b2\\Diagnoses\\...\\")
    item_name: str = ""
    constrain_by_value: ValueConstraint | None = Field(None, description="Only for items with numeric_values")
    constrain_by_modifier: ModifierConstraint | None = None
    constrain_by_date: DateConstraint | None = None


class Panel(BaseModel):
    items: list[Item] = Field(description="Items are ORed")
    invert: Literal[0, 1] = Field(0, description="1 = exclude patients matching this panel (NOT)")
    panel_timing: Literal["ANY", "SAMEVISIT"] | None = Field(
        None, description="With query_timing SAMEVISIT a panel defaults to SAMEVISIT. Set ANY on panels that may match "
                          "at any time, e.g. an exclusion of anyone ever diagnosed with a condition.")
    total_item_occurrences: int = Field(1, ge=1, description="Minimum number of facts (visits for visit items)")
    panel_date_from: str | None = None
    panel_date_to: str | None = None


class QueryDefinition(BaseModel):
    panels: list[Panel] = Field(description="Panels are ANDed")
    query_timing: Literal["ANY", "SAMEVISIT"] = Field(
        "ANY", description="SAMEVISIT joins SAMEVISIT panels on the same encounter")
    query_name: str = Field("", description="Leave empty for the i2b2 default name")


def _definition(query: QueryDefinition) -> dict[str, Any]:
    return query.model_dump(exclude_none=True)


@server.tool()
def search_ontology(text: str, under: str | None = None, limit: int = 25) -> list[dict[str, Any]]:
    """Searches i2b2 ontology terms by name or code. under: an item_key or path to search below.
    Returns item_key, path, name, kind (folder/leaf/modifier), patients (true count of the term) and numeric_values."""
    return call(service().search, text, under=under, limit=limit)


@server.tool()
def browse_ontology(path: str | None = None) -> list[dict[str, Any]]:
    """Lists the children of an ontology folder (item_key or path); without a path, the top-level categories."""
    return call(service().browse, path)


@server.tool()
def list_modifiers() -> list[dict[str, Any]]:
    """Lists i2b2 modifiers (e.g. nodule size, smoking detail) with the item paths they apply to."""
    return call(service().modifiers)


@server.tool()
def preview_query(query_definition: QueryDefinition) -> dict[str, Any]:
    """Validates a query definition and returns its i2b2 name, a readable summary and the i2b2 XML, without running it."""
    def prepare():
        qd, xml, summary = service().prepare(_definition(query_definition))
        return {"query_definition": qd.to_dict(), "summary": summary, "i2b2_query_xml": xml}
    return call(prepare)


@server.tool()
def run_i2b2_query(query_definition: QueryDefinition, nl_question: str) -> dict[str, Any]:
    """Runs an i2b2 query on the Cohort Discovery semantic model and records it in the CRC store.
    nl_question: the researcher's question in their own words. Returns query_master_id, query_name, the obfuscated
    patient count and breakdowns (age, gender, race, vital status), the summary and the i2b2 XML."""
    return call(service().run, _definition(query_definition), nl_question)


@server.tool()
def list_queries(limit: int = 20, mine: bool = True) -> list[dict[str, Any]]:
    """Lists previous i2b2 queries (newest first) with their QUERY_MASTER_ID and obfuscated counts."""
    return call(service().queries, limit=limit, mine=mine)


@server.tool()
def get_query(query_master_id: int) -> dict[str, Any]:
    """Returns one query: its question, definition, summary, i2b2 XML and obfuscated count."""
    return call(service().query, query_master_id)


@server.tool()
def submit_request(query_master_id: int, title: str) -> dict[str, Any]:
    """Turns a query into a data request (status PENDING) and links it to its approval page, where it is approved or
    rejected. Call only when the researcher asks to submit. Returns the request and REPORT_URL (the approval page)."""
    return call(service().submit, query_master_id, title)


@server.tool()
def request_status(query_master_id: int) -> dict[str, Any]:
    """Returns a data request's status (PENDING, APPROVED, REJECTED, DELIVERED), who decided and when, and its
    approval page (REPORT_URL)."""
    return call(service().request, query_master_id)


if __name__ == "__main__":
    server.run("stdio")
