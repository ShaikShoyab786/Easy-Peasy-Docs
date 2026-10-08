---
name: Legacy document data retention
description: The user's data-retention decision when retiring PDF functionality.
---

The user asked to remove the PDF feature while preserving existing stored PDF metadata and file objects. Do not purge those records or files as part of removing the feature. Existing conversation deletion remains an explicit destructive action and may clean up the associated legacy documents as it did before.

**Why:** The user approved retiring the PDF experience without permanently deleting stored data.

**How to apply:** Remove PDF UI and active PDF API functionality without dropping the `chat_documents` table, storage objects, or running a destructive migration. Keep existing explicit conversation-deletion cleanup behavior unless the user changes it.
