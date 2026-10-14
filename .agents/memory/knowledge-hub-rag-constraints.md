---
name: Knowledge Hub RAG constraints
description: Product requirements for adding retrieval to Knowledge Hub without changing the current experience.
---

Keep the existing Knowledge Hub UI, document visibility, and upload/chat workflow unchanged. Preserve original documents in object storage and retain the existing xAI file reference as a rollback path until retrieval has been backfilled and validated. Index charts and complex tables with page-level visual extraction as well as extracted text; plain PDF text extraction alone is insufficient.

**Why:** The user explicitly asked to reduce recurring long-document prompt costs without changing the user experience, and warned that charts and table data must not be lost during indexing.

**How to apply:** Treat indexing and retrieval as backend-only until quality checks and a safe fallback are ready; do not remove original files or legacy references during the initial rollout.
