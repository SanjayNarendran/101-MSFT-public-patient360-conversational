"""Shared helpers: settings, paths, Fabric REST calls and OneLake access.

Settings and state are per environment (a tenant and workspace). The default environment uses config/settings.env and
data/state.json. A named environment, chosen with COHORT_ENV=<name> or by the one line in config/.cohort-env (not
committed), uses config/settings.<name>.env and data/state.<name>.json. See docs/setup.md.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
RAW_DIR = DATA / "raw" / "coherent"
GEN_DIR = DATA / "generated"
FABRIC_API = "https://api.fabric.microsoft.com/v1"


def _env_name() -> str:
    name = os.environ.get("COHORT_ENV", "").strip()
    marker = ROOT / "config" / ".cohort-env"
    if not name and marker.exists():
        name = marker.read_text().strip()
    if name and not re.fullmatch(r"[A-Za-z0-9_-]+", name):
        raise SystemExit(f"COHORT_ENV must use only letters, digits, '-' and '_', not {name!r}")
    return name


ENV_NAME = _env_name()
SETTINGS_FILE = ROOT / "config" / (f"settings.{ENV_NAME}.env" if ENV_NAME else "settings.env")
STATE_FILE = DATA / (f"state.{ENV_NAME}.json" if ENV_NAME else "state.json")


def settings() -> dict[str, str]:
    path = SETTINGS_FILE
    if not path.exists():
        raise SystemExit(f"Missing {path.relative_to(ROOT)} - copy config/settings.example.env to it and fill it in.")
    out = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            out[key.strip()] = value.strip()
    return out


def load_state() -> dict:
    return json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}


def save_state(**updates) -> dict:
    state = load_state()
    state.update(updates)
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))
    return state


# --- Fabric REST ---------------------------------------------------------------------------

_token: dict = {}


def _fabric_token() -> str:
    if not _token or _token["expires"] < time.time() + 300:
        out = subprocess.run(
            ["az", "account", "get-access-token", "--resource", "https://api.fabric.microsoft.com", "-o", "json"],
            check=True, capture_output=True, text=True,
        ).stdout
        data = json.loads(out)
        _token.update(value=data["accessToken"], expires=int(data.get("expires_on", time.time() + 3000)))
    return _token["value"]


def fabric(method: str, path: str, body: dict | None = None, ok=(200, 201, 202)) -> dict:
    """Calls the Fabric REST API and waits for long-running operations to finish."""
    url = path if path.startswith("http") else f"{FABRIC_API}{path}"
    for attempt in range(6):
        resp = requests.request(method, url, json=body, headers={"Authorization": f"Bearer {_fabric_token()}"}, timeout=120)
        if resp.status_code == 429 or resp.status_code >= 500:
            time.sleep(int(resp.headers.get("Retry-After", 10)) * (attempt + 1))
            continue
        break
    if resp.status_code not in ok:
        raise RuntimeError(f"{method} {url} -> {resp.status_code}: {resp.text[:800]}")
    if resp.status_code == 202 and "Location" in resp.headers:
        return _wait_for_operation(resp)
    return resp.json() if resp.content else {}


def _wait_for_operation(resp) -> dict:
    location = resp.headers["Location"]
    while True:
        time.sleep(int(resp.headers.get("Retry-After", 5)))
        resp = requests.get(location, headers={"Authorization": f"Bearer {_fabric_token()}"}, timeout=60)
        status = resp.json().get("status") if resp.content else None
        if status in ("Succeeded", None) and resp.status_code == 200:
            result = resp.headers.get("Location")
            if result and result != location:
                return requests.get(result, headers={"Authorization": f"Bearer {_fabric_token()}"}, timeout=60).json()
            return resp.json() if resp.content else {}
        if status in ("Failed", "Cancelled"):
            raise RuntimeError(f"Fabric operation failed: {resp.text[:800]}")


def fabric_list(path: str) -> list[dict]:
    items, url = [], path
    while url:
        page = fabric("GET", url)
        items.extend(page.get("value", []))
        token = page.get("continuationToken")
        url = f"{path}{'&' if '?' in path else '?'}continuationToken={token}" if token else None
    return items


# --- OneLake data plane ------------------------------------------------------------------------------

ONELAKE_BLOB = "https://onelake.blob.fabric.microsoft.com"
ONELAKE_DFS = "https://onelake.dfs.fabric.microsoft.com"
_storage: dict = {}


def storage_token() -> str:
    if not _storage or _storage["expires"] < time.time() + 600:
        out = subprocess.run(["az", "account", "get-access-token", "--resource", "https://storage.azure.com", "-o", "json"],
                             check=True, capture_output=True, text=True).stdout
        data = json.loads(out)
        _storage.update(value=data["accessToken"], expires=int(data.get("expires_on", time.time() + 3000)))
    return _storage["value"]


def onelake_put(url: str, data: bytes, content_type: str = "application/octet-stream"):
    """Uploads one file (up to 256 MB) to OneLake through the Blob endpoint, retrying transient errors."""
    for attempt in range(8):
        try:
            resp = requests.put(url, data=data, timeout=600, headers={
                "Authorization": f"Bearer {storage_token()}", "x-ms-version": "2023-11-03",
                "x-ms-blob-type": "BlockBlob", "x-ms-blob-content-type": content_type})
            if resp.status_code < 300:
                return
            if resp.status_code not in (408, 409, 429, 500, 502, 503, 504):
                raise RuntimeError(f"PUT {url} -> {resp.status_code}: {resp.text[:300]}")
        except requests.RequestException:
            pass
        time.sleep(min(60, 2 ** attempt))
    raise RuntimeError(f"PUT {url} failed after retries")


def ensure_lakehouse(name: str, description: str) -> tuple[str, str]:
    """The workspace's lakehouse of this name, created if missing and recorded in the state file."""
    state = load_state()
    ws_id = state["workspace_id"]
    lh = next((x for x in fabric_list(f"/workspaces/{ws_id}/lakehouses") if x["displayName"] == name), None)
    if lh is None:
        lh = fabric("POST", f"/workspaces/{ws_id}/lakehouses", {"displayName": name, "description": description})
        print(f"Created lakehouse {name}")
    save_state(lakehouses={**state.get("lakehouses", {}), name: lh["id"]})
    return ws_id, lh["id"]


def refresh_endpoint(ws_id: str, lh_id: str) -> str | None:
    """Refreshes a lakehouse's SQL analytics endpoint so new Delta tables show up; returns the endpoint's host."""
    for _ in range(30):
        props = fabric("GET", f"/workspaces/{ws_id}/lakehouses/{lh_id}")["properties"].get("sqlEndpointProperties", {})
        if props.get("id") and props.get("provisioningStatus") == "Success":
            fabric("POST", f"/workspaces/{ws_id}/sqlEndpoints/{props['id']}/refreshMetadata", {})
            return props.get("connectionString")
        time.sleep(10)
    print("  SQL analytics endpoint not ready yet; refresh its metadata later")
    return None


def _for_sql_endpoint(df):
    """Lakehouse SQL endpoints leave out timestamp_ntz columns (pandas' naive datetimes): dates are written as Delta
    dates, other naive times as UTC timestamps."""
    import pandas as pd
    import pyarrow as pa
    table = pa.Table.from_pandas(df, preserve_index=False)
    for i, field in enumerate(table.schema):
        if pa.types.is_timestamp(field.type) and field.type.tz is None:
            known = pd.to_datetime(df[field.name]).dropna()
            target = pa.date32() if (known == known.dt.normalize()).all() else pa.timestamp(field.type.unit, tz="UTC")
            table = table.set_column(i, pa.field(field.name, target), table.column(i).cast(target, safe=False))
    return table


def write_tables(ws_id: str, lh_id: str, frames: dict) -> None:
    """Writes pandas frames as Delta tables in a lakehouse (overwriting), then refreshes its SQL endpoint."""
    from deltalake import write_deltalake
    root = f"abfss://{ws_id}@onelake.dfs.fabric.microsoft.com/{lh_id}/Tables"
    for name, df in frames.items():
        write_deltalake(f"{root}/{name}", _for_sql_endpoint(df), mode="overwrite", schema_mode="overwrite",
                        storage_options={"bearer_token": storage_token(), "use_fabric_endpoint": "true"})
        print(f"  {name:<24} {len(df):>10,} rows")
    refresh_endpoint(ws_id, lh_id)


def onelake_usage(ws_id: str, path: str) -> tuple[int, int]:
    """Files and bytes under a OneLake folder (<item id>/<path>), listed recursively; (0, 0) if it doesn't exist."""
    files = size = 0
    params = {"resource": "filesystem", "recursive": "true", "directory": path, "maxResults": 5000}
    while True:
        r = requests.get(f"{ONELAKE_DFS}/{ws_id}", params=params, timeout=300,
                         headers={"Authorization": f"Bearer {storage_token()}", "x-ms-version": "2023-11-03"})
        if r.status_code == 404:
            return 0, 0
        r.raise_for_status()
        for p in r.json().get("paths", []):
            if p.get("isDirectory") != "true":
                files += 1
                size += int(p.get("contentLength", 0))
        if not r.headers.get("x-ms-continuation"):
            return files, size
        params["continuation"] = r.headers["x-ms-continuation"]


def onelake_delete_folder(ws_id: str, item_id: str, path: str):
    resp = requests.delete(f"{ONELAKE_DFS}/{ws_id}/{item_id}/{path}?recursive=true", timeout=600, headers={
        "Authorization": f"Bearer {storage_token()}", "x-ms-version": "2023-11-03"})
    if resp.status_code not in (200, 404):
        raise RuntimeError(f"DELETE {path} -> {resp.status_code}: {resp.text[:300]}")


# --- Local environment ------------------------------------------------------------------------------------------------

def ensure_openssl():
    """mssql-python needs OpenSSL 3; on macOS re-exec with Homebrew's copy on the loader path before it is imported."""
    import os
    import sys
    lib = "/opt/homebrew/opt/openssl@3/lib"
    if sys.platform == "darwin" and os.path.isdir(lib) and lib not in os.environ.get("DYLD_LIBRARY_PATH", ""):
        os.environ["DYLD_LIBRARY_PATH"] = lib
        os.execv(sys.executable, [sys.executable] + sys.argv)


def signed_in_user() -> str:
    out = subprocess.run(["az", "account", "show", "--query", "user.name", "-o", "tsv"], check=True,
                         capture_output=True, text=True)
    return out.stdout.strip()
