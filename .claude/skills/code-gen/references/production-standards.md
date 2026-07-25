<!-- Split out of code-gen/SKILL.md so it loads only when relevant (prompting-standards.md §12). -->

Configuration, error-envelope, and layering rules for production code.

---

## Production Standards

These standards apply to ALL generated code, not just API wrappers or LLM calls.

### Structured Logging

All generated services must use structured logging with `extra` dicts:

```python
import logging

logger = logging.getLogger(__name__)

# CORRECT — structured fields for JSON log formatters
logger.info("Document processed", extra={
    "document_id": doc.id,
    "processing_time_ms": round(elapsed_ms, 2),
    "output_size_bytes": len(result),
})

# WRONG — data interpolated into message string
logger.info(f"Document {doc.id} processed in {elapsed_ms}ms")
```

```typescript
// CORRECT — structured logger
logger.info("Document processed", {
  documentId: doc.id,
  processingTimeMs: Math.round(elapsedMs),
  outputSizeBytes: result.length,
});

// WRONG — template literal message
logger.info(`Document ${doc.id} processed in ${elapsedMs}ms`);
```

Rules:
- Use `logging.getLogger(__name__)` (Python) or scoped logger (TypeScript) at module level
- INFO for business events (request received, document processed, job completed)
- WARNING for recoverable issues (retry triggered, fallback used, slow response)
- ERROR for failures requiring attention (unhandled exception, data corruption, external service down)
- DEBUG for troubleshooting data (raw payloads, intermediate state, timing breakdowns)
- Never log secrets, tokens, passwords, or PII
- Log at service boundaries: incoming requests, outgoing calls, business decisions

### Exception Handling

```python
# CORRECT — typed exception with context
class DocumentProcessingError(Exception):
    def __init__(self, document_id: str, stage: str, cause: Exception):
        self.document_id = document_id
        self.stage = stage
        self.cause = cause
        super().__init__(f"Failed at {stage} for document {document_id}: {cause}")

# WRONG — bare except swallowing the error
try:
    result = process(doc)
except Exception:
    result = default_value
```

Rules:
- Define typed exception classes per domain (not per function)
- Every exception carries enough context to debug without the stack trace
- Never catch `Exception` or `BaseException` unless re-raising or logging at a top-level boundary
- No silent fallbacks — if an operation fails, the caller must know
- API route handlers catch domain exceptions and map to HTTP error responses

### Structured Error Responses

The canonical error-envelope shape and the layering rules live in `.claude/skills/code-gen/references/architecture.md` — defer to it if the two ever differ. Repeated here for convenience: all API error responses follow a consistent envelope:

```json
{
  "error": {
    "code": "DOCUMENT_NOT_FOUND",
    "message": "Document with ID abc123 does not exist",
    "details": {}
  }
}
```

Rules:
- `code` is a machine-readable UPPER_SNAKE_CASE string enum
- `message` is human-readable
- `details` is optional structured context
- HTTP status mapping: 400 validation, 404 not found, 409 conflict, 422 processing error, 500 internal

### Request/Response Validation

- All API inputs validated via Pydantic models (Python) or Zod schemas (TypeScript)
- Validation errors return 400 with field-level messages
- All API outputs serialized through response models — never return raw dicts or ORM objects

### Configuration

- All configurable values in `config.yml` or environment variables
- No magic numbers or hardcoded strings in business logic
- Config loaded once at startup, injected into services via constructor
- Defaults provided for all non-secret config values

---

