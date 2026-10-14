# Knowledge Hub RAG evaluation

Run the sample comparison against the development database:

```sh
RAG_EVAL_ALLOW_DB_WRITE=1 pnpm --filter @workspace/api-server evaluate:rag
```

The harness embeds this fixture into a temporary, uniquely owned Knowledge Hub row, uploads a one-hour xAI file for the legacy path, and removes both resources after the run. The explicit opt-in is required because the harness writes temporary rows; do not point the environment at production.

It asks the same three questions through RAG and the saved-file path, records xAI input/output token usage for answer generation, and uses a separate model-assisted judge to score correctness and groundedness from 1–5. Judge tokens are excluded from the path-to-path usage comparison. Review the answers, retrieved evidence, and judge notes manually before changing rollout behavior. The fixture includes a table, chart-like values, and an intentionally absent fact to check abstention.
