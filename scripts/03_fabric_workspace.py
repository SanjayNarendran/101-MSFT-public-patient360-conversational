"""Creates the Fabric workspace and the two Bronze lakehouses for the Epic-style tables.

Bronze_Clarity, Bronze_Caboodle  - Delta tables written by 05_onelake_load.py

The lakehouses are created without schemas, so their tables are dbo.<TABLE> on the SQL analytics endpoint, as the
later stages' SQL expects.
"""
from common import fabric, fabric_list, load_state, save_state, settings

DESCRIPTIONS = {
    "LAKEHOUSE_CLARITY": "Raw Epic Clarity-style tables (synthetic), loaded as Delta tables.",
    "LAKEHOUSE_CABOODLE": "Raw Epic Caboodle-style tables (synthetic), loaded as Delta tables.",
}


def main():
    cfg = settings()
    name = cfg["FABRIC_WORKSPACE"]
    ws = next((w for w in fabric_list("/workspaces") if w["displayName"] == name), None)
    if ws is None:
        ws = fabric("POST", "/workspaces", {
            "displayName": name,
            "capacityId": cfg["FABRIC_CAPACITY_ID"],
            "description": "Medical cohort demo: synthetic Epic, PACS and document data in OneLake.",
        })
        print(f"Created workspace {name}")
    elif ws.get("capacityId", "").lower() != cfg["FABRIC_CAPACITY_ID"].lower():
        fabric("POST", f"/workspaces/{ws['id']}/assignToCapacity", {"capacityId": cfg["FABRIC_CAPACITY_ID"]})
    ws_id = ws["id"]

    existing = {lh["displayName"]: lh for lh in fabric_list(f"/workspaces/{ws_id}/lakehouses")}
    lakehouses = {}
    for key, description in DESCRIPTIONS.items():
        lh_name = cfg[key]
        lh = existing.get(lh_name) or fabric("POST", f"/workspaces/{ws_id}/lakehouses",
                                              {"displayName": lh_name, "description": description})
        lakehouses[lh_name] = lh["id"]
        print(f"Lakehouse {lh_name}: {lh['id']}")

    # Later stages add their lakehouses to the same map; keep them when this runs again on the same workspace
    prior = load_state()
    kept = prior.get("lakehouses", {}) if prior.get("workspace_id") == ws_id else {}
    save_state(workspace_id=ws_id, lakehouses={**kept, **lakehouses})
    print(f"Workspace {name}: {ws_id}")


if __name__ == "__main__":
    main()
