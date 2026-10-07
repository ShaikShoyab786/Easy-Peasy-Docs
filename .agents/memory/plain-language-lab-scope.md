---
name: Plain Language Lab first-release scope
description: The user's scope boundary for the first Plain Language Lab release.
---

The first release is a paste-and-review prototype: users paste text, run their prompt through Grok, review the simplified result, and copy it. PDF processing and source-grounded Q&A are deferred.

The long-term goal is to take an original document and generate a separate simplified document. Document transformation is the core feature; Q&A is optional and not required for that flow.

For the simplified document, omit the original index/contents page, start the main matter under one main heading, retain useful section headings in the body, exclude original page numbers from text sent to the model, and extract images and tables. Preserve table structure and include tables where useful in the simplified result.

Generated simplifications must not include a section titled “Bottom line.”

**Why:** The user scoped the first prototype to pasted text, clarified the document-to-document goal, specified the treatment of indexes, page numbers, images, and tables, and confirmed useful section headings should remain.

**How to apply:** Keep the first release within the paste-and-review flow. When the user asks to expand it, prioritize the document-to-document simplification pipeline; omit the source index and page numbers, keep one main heading plus useful body headings, extract images/tables, and treat Q&A as separate optional scope. Preserve the no-“Bottom line” output constraint.
