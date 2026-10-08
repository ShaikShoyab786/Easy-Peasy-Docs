---
name: Plain Language Lab first-release scope
description: The user's scope boundary for the first Plain Language Lab release.
---

The PDF workspace supports the existing full extraction preview plus a separate simplified document generated from a chosen starting boundary in reading order. Automatically use the first substantive contents entry only when it matches a body heading; otherwise ask the user to select a detected heading or PDF page. Filter only the simplification input, and keep later annexures and other substantive content. Local OCR recognizes text in scanned pages and embedded images; uncertain OCR is marked for review. Narrative text is rewritten in plain language, and tables are rewritten as structured rows only when their shape and numeric values pass checks; otherwise the original table is retained. The 100,000-character cap remains.

The long-term goal is to take an original document and generate a separate simplified document. Document transformation is the core feature; Q&A is optional and not required for that flow.

For Phase 1 extraction, exclude index/contents pages, printed page-number lines, and author bylines on the original first and last pages from extracted text. Preserve useful section headings, extract tables with their rows, and preview embedded images in reading order with page references.

For simplified documents, write an engaging explanation for non-specialists that explains how ideas connect rather than merely shortening or rewording. Cover important relationships, conditions, caveats, and obligations; explain unfamiliar terms. Keep sentences concise and structure proportional to the material, with one natural main heading and useful subheadings. Preserve table and image markers in original order. Render headings, lists, and useful comparison tables consistently in the PDF preview. Outside facts or examples are allowed only in a separate section titled “Extra context — examples not stated in the source.”

Generated simplifications must not include a section titled “Bottom line.”

**Why:** The user first scoped the PDF workspace to extraction only, then explicitly authorized full-document simplification, OCR, and table rewriting. The user specified the treatment of indexes, page numbers, front/last-page author names, images, and tables, and confirmed useful section headings should remain. Their proposed PDF prompt emphasizes explanations and relationships rather than shortening, proportional structure, source-as-content handling, ordered source markers, and a separate outside-context section. Uncertain main-content starts require confirmation.

**How to apply:** Keep extraction and simplification as separate views. Retain the full extraction for review; only filter the model input at the selected start. Auto-select a confident contents-to-heading match, otherwise require a section/page choice. Do not discard annexures globally. Process selected content in order within the 100,000-character cap. Use OCR for scans and images, mark low-confidence recognition, preserve original table values/shape when rewriting fails checks, and keep table/image markers in order. Export and source-grounded Q&A remain out of scope unless asked. Preserve the separate outside-context heading and no-“Bottom line” constraint.
