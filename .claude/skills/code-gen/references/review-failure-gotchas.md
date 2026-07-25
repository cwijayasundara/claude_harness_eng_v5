<!-- Split out of code-gen/SKILL.md so it loads only when relevant (prompting-standards.md §12). -->

The specific mistakes that cause a change to fail review.

---

## Gotchas (Things That Cause Review Failures)

- Importing upward across layers (UI importing from repository layer)
- Functions exceeding 30 lines without decomposition
- Untyped values — `any`, missing return types, unannotated parameters
- Broad exception catches without re-raise or typed handling
- Mocking business logic in unit tests
- Generic test data (`"test"`, `0`, `null` as stand-ins for real domain values)
- Commented-out code in the submitted diff
- Missing error-path test coverage
- Teammates editing the same file in the same sprint without coordination
- **Free-text LLM parsing** — Never use regex to parse LLM output. Use structured output (tool_use / JSON mode).
- **Silent fallback on LLM error** — `except Exception: return default` hides compounding bugs. Raise typed errors.
- **Missing raw response logging** — Always log raw LLM response at DEBUG before parsing. This is the debugging ground truth.
- **Direct SDK imports outside wrapper** — All SDK imports must be inside the wrapper class file. Business logic imports your wrapper, not the SDK.
- **Bare except on API calls** — Catch `ApiTransientError` and `ApiPermanentError` specifically. Never `except Exception`.
- **Hardcoded retry config** — Retry attempts, backoff, and timeout belong in `config.yml`, not in code.
- **Missing structured logging in API wrapper** — Every request/response/error must be logged with structured fields (service, operation, attempt, latency_ms).
- **f-string log messages** — Use `extra` dict for structured fields, not string interpolation. Structured logs are searchable; f-strings are not.
- **Missing logging at service boundaries** — Every incoming request and outgoing call must be logged with timing and status.
- **Raw dict API responses** — Always serialize through a response model. Raw dicts bypass validation and leak internal structure.
- **Magic numbers** — All thresholds, limits, timeouts, and configuration belong in `config.yml`.
- **.env leaking into tests** — Tests that validate "missing config raises error" will pass in CI but fail locally if `.env` has the value. Always pass `_env_file=None` in pydantic-settings tests.
- **Sync DB driver in async app** — `postgresql://` uses psycopg2 (sync). Async SQLAlchemy needs `postgresql+asyncpg://`. Always match the driver scheme to the engine type.
- **Duplicate record creation** — Route creates a record, then calls a service that creates the same record again. Pass the ID, don't re-create. Test with `assert count == 1` after one API call.
- **Manual session creation** — Never create DB sessions manually per request. Use `Depends(get_db)` with `async_sessionmaker`. Manual sessions leak connections.
- **Fire-and-forget background tasks** — Every background task must update a DB record on completion or failure. No `background_tasks.add_task(fn)` without status tracking.
- **CORS allow_origins=["*"]** — Never use wildcard origins with `allow_credentials=True`. Read origins from env var, default to localhost.
- **Health check returns OK without checking DB** — Health endpoint must `SELECT 1` against the database. A healthy HTTP server with a dead DB is not healthy.
- **Engine not disposed on shutdown** — Always `await engine.dispose()` in the lifespan's teardown. Leaked connections exhaust the pool.
- **No request ID tracing** — Add middleware that generates a UUID per request, injects into logs and response headers. Without it, errors can't be traced to requests.
- **Deprecated startup/shutdown events** — Use `@asynccontextmanager` lifespan, not `@app.on_event("startup")`. The event-based API is deprecated in FastAPI.
- **Thread pool exhaustion** — `asyncio.to_thread()` uses a default pool of ~5 workers. Under concurrent load, blocking SDK calls exhaust the pool. Set `loop.set_default_executor(ThreadPoolExecutor(max_workers=20))` or use async clients.
- **N+1 queries** — Loading rows then querying per-row in a loop. Batch into one query (join / `IN` / eager-load). This is the most common cause of an endpoint that passes tests but fails the evaluator's latency ratchet.
- **Unbounded result set** — Returning a whole table/collection with no `LIMIT`/pagination. Always cap and paginate list responses; never load an unbounded table into memory.
- **Missing index on a filtered column** — A `WHERE`/`ORDER BY`/`JOIN` column with no index is a full scan; fine at 10 rows, a timeout at scale. Declare the index in the model/migration.
- **Sequential independent awaits** — Two `await`s with no data dependency run back-to-back instead of via `asyncio.gather`/`Promise.all`. Gather independent I/O.
- **Per-request re-computation** — Recompiling regexes, reloading config, or re-opening clients inside the handler instead of hoisting to startup/module scope.
