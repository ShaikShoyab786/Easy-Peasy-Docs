---
name: Plain Language Lab first-release scope
description: The user's scope boundary for the first Plain Language Lab release.
---

The PDF workspace supports the existing extraction preview plus a separate simplified document generated from the full extracted content in reading order. Local OCR recognizes text in scanned pages and embedded images; uncertain OCR is marked for review. Narrative text is rewritten in plain language, and tables are rewritten as structured rows only when their shape and numeric values pass checks; otherwise the original table is retained. The 100,000-character cap remains.

The long-term goal is to take an original document and generate a separate simplified document. Document transformation is the core feature; Q&A is optional and not required for that flow.

For Phase 1 extraction, exclude index/contents pages, printed page-number lines, and author bylines on the original first and last pages from extracted text. Preserve useful section headings, extract tables with their rows, and preview embedded images in reading order with page references.

For simplified documents, omit the original index/contents page, start the main matter under one main heading, retain useful section headings in the body, exclude original page numbers and author names on the first or last page from text sent to the model, and extract images and tables. Preserve table structure and include tables where useful in the simplified result.

Generated simplifications must not include a section titled “Bottom line.”

**Why:** The user first scoped the PDF workspace to extraction only, then explicitly authorized full-document simplification, OCR, and table rewriting. The user specified the treatment of indexes, page numbers, front/last-page author names, images, and tables, and confirmed useful section headings should remain.

**How to apply:** Keep extraction and simplification as separate views. Process all source content in order within the 100,000-character cap. Omit source indexes, page numbers, and first/last-page author bylines; keep one main heading plus useful body headings. Use OCR for scans and images, mark low-confidence recognition, and preserve original tables when structural or numeric checks fail. Export and source-grounded Q&A remain out of scope unless asked. Preserve the no-“Bottom line” output constraint.
