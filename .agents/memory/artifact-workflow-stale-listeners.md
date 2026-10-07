---
name: Artifact workflow stale listeners
description: A failed managed artifact restart may leave an earlier server process group bound to its port.
---

When a managed artifact restart fails with `EADDRINUSE`, check the exact port listener and test its response before assuming the app code is broken. If an earlier process group from that artifact is still serving, stop only that stale group, then restart the managed workflow.

**Why:** A failed restart left the prior API and web processes alive, so the new managed starts could not bind their ports even though the old services still answered requests.

**How to apply:** Use `lsof` or `ss` to identify the listener, confirm its command belongs to the affected artifact, and verify the service route with `curl`. Avoid killing unrelated artifact processes.
