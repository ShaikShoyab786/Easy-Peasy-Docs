---
name: PyMuPDF stdout
description: Keep PyMuPDF diagnostics from corrupting JSON emitted by a subprocess.
---

PyMuPDF table detection can print advisory diagnostics to standard output during otherwise successful PDF extraction. If the subprocess writes JSON to stdout, redirect those diagnostics to stderr so the response remains valid JSON only.

**Why:** The API parses the Python subprocess stdout as one JSON response; library messages mixed into it break response parsing.

**How to apply:** When adding PyMuPDF extraction or table detection, keep stdout reserved for the machine-readable result and send library chatter to stderr.
