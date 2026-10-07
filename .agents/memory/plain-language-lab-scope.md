---
name: Plain Language Lab first-release scope
description: The user's scope boundary for the first Plain Language Lab release.
---

The first release is a paste-and-review prototype: users paste text, run their prompt through Grok, review the simplified result, and copy it. PDF processing and source-grounded Q&A are deferred.

The long-term goal is to take an original document and generate a separate simplified document. Document transformation is the core feature; Q&A is optional and not required for that flow.

Generated simplifications must not include a section titled “Bottom line.”

**Why:** The user scoped the first prototype to pasted text and clarified that the ultimate product should turn an original document into a new simplified document.

**How to apply:** Keep the first release within the paste-and-review flow. When the user asks to expand it, prioritize the document-to-document simplification pipeline; treat Q&A as separate optional scope. Preserve the no-“Bottom line” output constraint.
