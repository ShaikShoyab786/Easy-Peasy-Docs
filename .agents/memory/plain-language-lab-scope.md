---
name: Plain Language Lab first-release scope
description: The user's scope boundary for the first Plain Language Lab release.
---

The first release is a paste-and-review prototype: users paste text, run their prompt through Grok, review the simplified result, and copy it. PDF processing and source-grounded Q&A are deferred.

Generated simplifications must not include a section titled “Bottom line.”

**Why:** The user explicitly scoped the first prototype to pasted text, not PDF generation or RAG.

**How to apply:** Keep changes within the paste-and-review flow unless the user asks to add PDF processing or document Q&A. Preserve the no-“Bottom line” output constraint.
