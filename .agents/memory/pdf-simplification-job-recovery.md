---
name: PDF simplification job recovery
description: Current persistence boundary for in-progress PDF simplification jobs.
---

Job state, event history, and completed section output are held in API-process memory. Server-sent event replay supports browser reconnects while that process remains alive; an API restart clears the jobs.

**Why:** The approved reliability update required background work and reconnectable progress, but did not call for persistent job storage or a database migration.

**How to apply:** If restart-safe continuation is later requested, persist job state, the event sequence, validated section output, and enough source metadata to resume safely. Do not treat the current in-memory replay as durable.
