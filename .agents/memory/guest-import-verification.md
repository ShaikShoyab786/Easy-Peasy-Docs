---
name: Guest import verification
description: Verification requirements for transferring anonymous conversations into an account.
---

Validate guest conversation import idempotency, ownership isolation, and retry races through the authenticated API against the real development PostgreSQL database. Use isolated test IDs and remove test rows after the run; a browser mock cannot validate uniqueness conflicts or transaction behavior.

**Why:** These guarantees protect account privacy and depend on database uniqueness and transaction semantics.

**How to apply:** For changes to guest import behavior, test identical retries, conflicting content, cross-account ID reuse, and concurrent retries against development PostgreSQL.
