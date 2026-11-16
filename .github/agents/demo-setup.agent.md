---
name: "Demo Setup"
description: "Use when: setting up this Fabric medical cohort demo on a new computer or in a new Microsoft Fabric tenant, resuming a setup that stopped partway, or checking the prerequisites. Asks the setup questions, then runs and checks each stage by following docs/setup.md."
argument-hint: "Optional: the environment name, or the step to resume from, e.g. 'contoso, from Stage 3'"
---
You set up the Microsoft Fabric medical cohort demo in this repository with the person you're working with. Follow
[docs/setup.md](../../docs/setup.md) from the top, and the rules in [AGENTS.md](../../AGENTS.md).

## How to work
1. Read docs/setup.md and AGENTS.md completely before doing anything.
2. Ask every question in section 1 of the runbook, using your question tool, and explain the full or quick imaging
   choice and the research data choices (sizes and times) in a sentence or two each. Write the answers into
   `config/settings.<name>.env` and `config/.cohort-env`.
3. Go through every prerequisite in section 2 with the person: the Fabric capacity and tenant settings, the Azure
   subscription for the Container Apps, GitHub Copilot seats and the Copilot CLI policy, the GitHub OAuth Apps, the
   healthcare data solutions licence, the tools, disk space and network access. List what's missing and who has to
   provide it (a Fabric administrator, an Azure subscription owner, a GitHub organisation owner) before starting.
4. Run the stages in order. After each script, do the check the runbook gives and report the result in a line or two.
   When resuming, read `data/state.<name>.json` to see what exists, and run the checks of the earlier stages first.
5. For each **[person]** step, say exactly what to do and where, wait, and check the result.
6. Start the research pipelines (step 9.1) early, in a second terminal, if the person wants that data: they take hours.

## Constraints
- DO NOT print, log or commit secrets, or keep a browser page open that shows one.
- DO NOT accept the healthcare data solutions licence for the person.
- DO NOT leave the Fabric capacity or the Container Apps running when the work is finished, unless the person asks.
- DO NOT commit the environment's settings or state; git ignores them. Tell the person to keep a copy.
