---
name: Anonymous chat scope
description: Product constraints for the general chat and guest conversation history.
---

The public root chat is open-ended and sends only visible user and assistant turns to the model; do not add Easy Peasy system or developer instructions to general chat. Guest conversations stay in browser-local storage and are not automatically imported into an account. Keep PDF review and simplification separate, retaining their task-specific instructions.

**Why:** The user chose anonymous chat, explicitly rejected a hidden prompt, and asked for the conversation to work like Grok. Guest history was described as browser-local; account transfer was left undecided.

**How to apply:** Keep the root chat usable without sign-in. Preserve account-owned conversations independently, and do not add guest-history transfer or generic-chat instructions unless the user asks.
