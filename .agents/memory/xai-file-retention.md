---
name: xAI file retention
description: xAI Files API expiration behavior for saved Knowledge Hub attachment IDs.
---

For Knowledge Hub uploads whose xAI `file_id` is persisted for later chat turns, omit `expires_after`. xAI deletes files after the configured expiration; omitting the field keeps the file permanently.

**Why:** Reusing a database-stored file ID only works while the upstream file remains available.

**How to apply:** Distinguish durable Knowledge Hub uploads from temporary one-off chat attachments, which may keep a short expiry.
