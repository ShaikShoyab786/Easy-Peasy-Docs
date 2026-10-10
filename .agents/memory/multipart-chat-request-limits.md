---
name: Multipart chat request limits
description: Multer's field and part caps must account for chat form metadata as well as files.
---

When adding text fields to the chat `FormData` contract, update both Multer's `fields` and `parts` limits alongside the API schema.

**Why:** an additional metadata field caused attachment submissions to fail in Multer before route validation.

**How to apply:** recount text fields and total multipart parts whenever the chat request form changes.
