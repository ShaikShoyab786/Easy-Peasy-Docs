---
name: Anonymous chat scope
description: Product constraints for the general chat and guest conversation history.
---

The public root chat is open-ended and sends only visible user and assistant turns to the model; do not add Easy Peasy system or developer instructions to general chat. Guest conversations stay in browser-local storage. If a guest chooses sign-in or account creation from the third-message prompt, copy only the active conversation into the account and retain its local copy; do not bulk-import other guest chats. Keep PDF review and simplification separate, retaining their task-specific instructions.

**Why:** The user chose anonymous chat, explicitly rejected a hidden prompt, and asked for the conversation to work like Grok. They later approved an explicit active-chat transfer while preserving the local copy, without enabling bulk history migration.

**How to apply:** Keep the root chat usable without sign-in and without app-authored hidden instructions. Preserve account-owned conversations independently; only copy the active guest thread when the guest chooses account creation or sign-in through the prompt.
