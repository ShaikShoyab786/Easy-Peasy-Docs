---
name: OpenAPI request-body codegen names
description: Prevent duplicate generated exports from OpenAPI request-body component names.
---

Use distinct component names for request bodies rather than names that can be generated for an operation's request type. When Orval reports conflicting exports, rename the OpenAPI component and rerun codegen; avoid hand-maintained aliases in the generated barrel.

**Why:** A component can collide with an operation-derived body type, and codegen may rename its output on a later run, making manual aliases brittle.

**How to apply:** Choose unique request-body schema names in the OpenAPI source before generating the clients. Keep generated exports untouched.
