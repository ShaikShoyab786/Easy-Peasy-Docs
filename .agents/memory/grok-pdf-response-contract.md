---
name: Grok PDF response contract
description: Non-obvious response-format and marker constraints for Grok document rewriting.
---

Use strict JSON Schema output for each Grok PDF rewrite chunk. Avoid synthetic table or image marker examples in the prompt, and restrict table-token output to tokens supplied for the current chunk. If prose is valid but table rewrites are missing or malformed, retain the prose and preserve the original tables.

**Why:** Historical PDF jobs failed during response parsing without recording the upstream response shape. A later live no-marker smoke request failed marker validation while the prompt contained a synthetic table token; removing marker examples and constraining table-token values made live no-table and table requests pass.

**How to apply:** Keep the Grok request schema aligned with the response parser and marker-order checks. Do not weaken those checks to accommodate model drift; use safe response metadata for diagnosis and never log source or model text.
