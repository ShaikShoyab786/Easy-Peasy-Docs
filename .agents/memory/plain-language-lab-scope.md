---
name: Plain Language Lab first-release scope
description: The user's scope boundary for the first Plain Language Lab release.
---

Phase 1 keeps the existing paste-and-review flow and adds a separate PDF workspace for uploading text-based PDFs and previewing extracted text, tables, and embedded images. It does not simplify or export a document. OCR for scanned PDFs and source-grounded Q&A are deferred.

The long-term goal is to take an original document and generate a separate simplified document. Document transformation is the core feature; Q&A is optional and not required for that flow.

For Phase 1 extraction, exclude index/contents pages, printed page-number lines, and author bylines on the original first and last pages from extracted text. Preserve useful section headings, extract tables with their rows, and preview embedded images in reading order with page references.

For a future simplified document, omit the original index/contents page, start the main matter under one main heading, retain useful section headings in the body, exclude original page numbers and author names on the first or last page from text sent to the model, and extract images and tables. Preserve table structure and include tables where useful in the simplified result.

Generated simplifications must not include a section titled “Bottom line.”

**Why:** The user expanded the prototype with a separate PDF extraction-only Phase 1 and explicitly deferred simplification, export, and OCR. They also specified the treatment of indexes, page numbers, front/last-page author names, images, and tables, and confirmed useful section headings should remain.

**How to apply:** Keep PDF Phase 1 limited to extraction and preview; do not add simplification, export, or OCR unless asked. When the user asks to advance the document workflow, prioritize producing a separate simplified document; omit the source index, page numbers, and front/last-page author names, keep one main heading plus useful body headings, extract images/tables, and treat Q&A as separate optional scope. Preserve the no-“Bottom line” output constraint.
