---
name: Knowledge Hub RAG constraints
description: Product requirements for adding retrieval to Knowledge Hub without changing the current experience.
---

Keep the existing Knowledge Hub UI, document visibility, and upload/chat workflow unchanged. Preserve original documents in object storage and retain the existing xAI file reference as a rollback path until retrieval has been backfilled and validated. Index charts and complex tables with page-level visual extraction as well as extracted text; plain PDF text extraction alone is insufficient. Use Gemini Embedding 2 through the direct Gemini API for all document and query vectors; do not use another embedding provider. Keep xAI for visual extraction and final chat answers.

**Why:** The user explicitly asked to reduce recurring long-document prompt costs without changing the user experience, warned that charts and table data must not be lost during indexing, and selected Gemini Embedding 2 after `text-embedding-004` was shut down.

**How to apply:** Validate the authenticated upload/chat route, not only helper calls, before declaring live RAG functional. After Gemini access is corrected, ready documents with no Gemini chunks require an explicit re-index; changing the secret alone does not backfill them. Keep original files and legacy references until the Gemini-backed route is confirmed.

Policy questions can still abstain when the indexed copy has inadequate passage coverage, even if vector retrieval is active. The user reported expected answers after testing a newly uploaded copy where the existing copy returned “not specified.”

**Why:** The live path was using vector chunks, but its retrieved pages omitted a relevant exclusion; a new upload then produced the expected answer.

**How to apply:** When Preview and Live differ, verify the document version and retrieved source pages before changing credentials or blaming the grounding prompt. Re-uploading or re-indexing may matter if the stored index is stale or incomplete.
