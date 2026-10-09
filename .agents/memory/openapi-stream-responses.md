---
name: OpenAPI streaming responses
description: How to add negotiated SSE without weakening generated JSON client types.
---

When an endpoint supports both server-sent events and its existing JSON response, document both media types under the existing success status and keep `application/json` first. Do not add a separate earlier stream-only status unless the generated client types are checked.

**Why:** Orval selected the first response status for the operation response schema; making a stream-only `200` precede an existing JSON `201` changed the generated Zod response to `unknown`.

**How to apply:** Keep the JSON response and generated client compatible, use an explicit `Accept: text/event-stream` header to select SSE, and regenerate API helpers after changing the OpenAPI contract.
