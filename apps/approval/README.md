# Cohort data requests (approval app)

A Fabric App (Project Rayfin) in the MedicalCohortDemo workspace where data requests from cohort discovery are reviewed,
approved or rejected, and delivered. It opens on an inbox of requests; each request has its own page at
`#/requests/<QUERY_MASTER_ID>` with:

- the researcher's question, the i2b2 query as panels, and the i2b2 query XML (shown and downloadable);
- the obfuscated patient count and the breakdowns by age, gender, race and vital status;
- Approve and Reject with an optional comment, recorded under the signed-in user's name with the time (UTC);
- Start delivery once approved, which runs the Cohort_Delivery notebook and follows it until the data is delivered;
- the audit trail: submitted, decided, delivery started, delivered.

## How it works

- `packages/frontend/` is the page (React and Vite), styled with the repository's shared theme
  (`apps/shared/theme.css`) and the presentation's fonts.
- `rayfin/functions/src/function_app.ts` holds the functions the page calls: `listRequests`, `getRequest`,
  `decideRequest`, `startDelivery`, `getDelivery` and `whoAmI`. They read and write the Cohort_Requests Fabric SQL
  database (schema `crc`) and call the Fabric job API, as the app identity (the owner of the Fabric app item).
- The person deciding is the signed-in app user. In Fabric-hosted apps the Rayfin token carries the user's Entra object
  ID but no name, so the functions look the ID up in the workspace's role assignments to record the user principal name.
- `rayfin/functions/src/config.generated.ts` (not committed) holds the workspace, SQL database and notebook IDs.

## Deploy

From the repository root, with the capacity running:

```bash
.venv/bin/python scripts/22_approval_app.py
```

The script writes the configuration, installs the npm packages, runs `rayfin up` (Node.js 20, 22 or 24) and saves the
app's URL in `data/state.json`, so new requests link to it (`APPROVAL_UI=rayfin` in `config/settings.env`). After a
code change, `npx rayfin up functions deploy` or `npx rayfin up staticapp deploy` in this folder redeploys one part.

The project was created from the Rayfin `blankapp` template (MIT, see `LICENSE`).
