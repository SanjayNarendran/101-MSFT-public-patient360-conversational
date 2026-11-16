"""Cohort discovery from the command line: the same operations as the MCP server, plus the manual delivery step.

  python scripts/cohort.py search "lung nodule"            # ontology terms (item_key, patients)
  python scripts/cohort.py browse ["\\\\i2b2_demographics\\i2b2\\Demographics\\"]
  python scripts/cohort.py modifiers
  python scripts/cohort.py preview query.json              # validate; i2b2 name, summary, XML
  python scripts/cohort.py run query.json --question "..."  # QUERY_MASTER_ID and obfuscated counts
  python scripts/cohort.py queries [--all]
  python scripts/cohort.py show 1001
  python scripts/cohort.py delete 1001                      # remove from the query history (i2b2 DELETE_FLAG)
  python scripts/cohort.py submit 1001 --title "..."        # data request (PENDING) and its approval page
  python scripts/cohort.py status 1001
  python scripts/cohort.py deliver 1001 [--demo]            # runs the Cohort_Delivery notebook (approved only)
  python scripts/cohort.py notebook 1001                    # create or refresh the delivery's Explore notebook
  python scripts/cohort.py remove 1001                      # admin: drop a request, its dashboard and delivery

query.json is an i2b2 query definition: {"panels": [{"items": [{"item_key": "..."}]}], "query_timing": "ANY"}
(see QueryDefinition in scripts/cohort_mcp.py for every field).
"""
from __future__ import annotations

import argparse
import importlib
import json
import sys

from common import ensure_openssl

ensure_openssl()

from cohort_service import CohortService  # noqa: E402


def show(data) -> None:
    print(json.dumps(data, indent=2, default=str, ensure_ascii=False))


def deliver(service: CohortService, query_master_id: int, demo: bool = False) -> None:
    request = service.request(query_master_id)
    if request["STATUS"] not in ("APPROVED", "DELIVERED"):
        raise SystemExit(f"Request {query_master_id} is {request['STATUS']}; only approved requests are delivered.")
    nb = importlib.import_module("16_fabric_notebooks")
    state, cfg = service.state, service.cfg
    nb.run(service.workspace_id, state["cohort_app"]["delivery_notebook_id"], "Cohort_Delivery",
           state["lakehouses"][cfg["LAKEHOUSE_SILVER_OMOP"]], "cohort_delivery", timeout_min=30,
           parameters={"QUERY_MASTER_ID": query_master_id, "DEMO_MODE": demo,
                       "DELIVERY_FOLDER_ID": service.delivery_folder() or ""})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("search")
    p.add_argument("text")
    p.add_argument("--under")
    p.add_argument("--limit", type=int, default=25)
    sub.add_parser("browse").add_argument("path", nargs="?")
    sub.add_parser("modifiers")
    sub.add_parser("preview").add_argument("file")
    p = sub.add_parser("run")
    p.add_argument("file")
    p.add_argument("--question", default="")
    sub.add_parser("queries").add_argument("--all", action="store_true")
    for name in ("show", "delete", "status", "remove", "notebook"):
        sub.add_parser(name).add_argument("query_master_id", type=int)
    p = sub.add_parser("deliver")
    p.add_argument("query_master_id", type=int)
    p.add_argument("--demo", action="store_true", help="deliver a small sample (demo mode)")
    p = sub.add_parser("submit")
    p.add_argument("query_master_id", type=int)
    p.add_argument("--title")
    args = parser.parse_args()

    service = CohortService()
    load = lambda path: json.load(sys.stdin if path == "-" else open(path))
    if args.command == "search":
        show(service.search(args.text, under=args.under, limit=args.limit))
    elif args.command == "browse":
        show(service.browse(args.path))
    elif args.command == "modifiers":
        show(service.modifiers())
    elif args.command == "preview":
        qd, xml, summary = service.prepare(load(args.file))
        print(f"{qd.name}\n{summary}\n\n{xml}")
    elif args.command == "run":
        show(service.run(load(args.file), args.question))
    elif args.command == "queries":
        show(service.queries(mine=not args.all))
    elif args.command == "show":
        show(service.query(args.query_master_id))
    elif args.command == "delete":
        import cohort_store
        cohort_store.delete_query(service.conn, args.query_master_id)
        print(f"Deleted query {args.query_master_id}")
    elif args.command == "submit":
        show(service.submit(args.query_master_id, args.title))
    elif args.command == "status":
        show(service.request(args.query_master_id))
    elif args.command == "deliver":
        deliver(service, args.query_master_id, args.demo)
    elif args.command == "notebook":
        print(f"Notebook {service.explore_notebook(args.query_master_id)} is ready next to the delivery lakehouse")
    elif args.command == "remove":
        print("Removed: " + ", ".join(service.remove_request(args.query_master_id)))


if __name__ == "__main__":
    main()
