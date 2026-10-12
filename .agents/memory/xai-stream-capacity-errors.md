---
name: xAI stream capacity errors
description: Retryable capacity and rate-limit failures can arrive inside successful HTTP streaming responses.
---

xAI may accept a Responses request with HTTP 200 and then report model-capacity or rate-limit failure in a streamed `error` or `response.failed` event. HTTP status handling alone will miss these failures.

**Why:** The stream event is the actual failed model result even though the initial HTTP response succeeded.

**How to apply:** Inspect structured stream error codes/messages and retry with the same bounded backoff policy before emitting any reply deltas; restarting after visible deltas risks duplicating partial answers.
