<!-- Split out of code-gen/SKILL.md so it loads only when relevant (prompting-standards.md §12). -->

Concrete code shapes for the quality principles in code-gen/SKILL.md.

---

## Code Patterns

### Test Structure: Arrange → Act → Assert
```
// Arrange
const order = buildOrder({ status: "pending" });
// Act
const result = processOrder(order);
// Assert
expect(result.status).toBe("confirmed");
```

### Typed Error Classes
```typescript
class DomainError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = this.constructor.name;
  }
}
class OrderNotFoundError extends DomainError {
  constructor(orderId: OrderId) {
    super(`Order ${orderId} not found`, "ORDER_NOT_FOUND");
  }
}
```

### Naming Conventions
- **Files:** `kebab-case.ts` for TypeScript, `snake_case.py` for Python.
- **Functions/methods:** `camelCase` (TS), `snake_case` (Python).
- **Types/classes:** `PascalCase` in both languages.
- **Constants:** `UPPER_SNAKE_CASE`.
- **Booleans:** prefix with `is`, `has`, `can`, `should`.

### Database Session Lifecycle (Python/FastAPI)
- Use `async_sessionmaker` with FastAPI `Depends()` for dependency injection — never create sessions manually per request.
- Engine and session factory created once in `lifespan`, stored on `app.state`, disposed on shutdown.
- Sessions auto-close via `async with` — never leave sessions open.
- Tests override the session dependency to use a test DB, not the dev DB.

```python
# CORRECT — lifespan manages engine lifecycle
@asynccontextmanager
async def lifespan(app: FastAPI):
    engine = create_async_engine(settings.DATABASE_URL)
    app.state.session_factory = async_sessionmaker(engine)
    yield
    await engine.dispose()

# CORRECT — session via dependency injection
async def get_db(request: Request) -> AsyncGenerator[AsyncSession, None]:
    async with request.app.state.session_factory() as session:
        yield session

DbSession = Annotated[AsyncSession, Depends(get_db)]
```

### Background Tasks Must Be Tracked
- Every background task must have a corresponding DB record with a status field (`pending`, `running`, `completed`, `failed`).
- The route creates the record (status=`pending`), then starts the background task with the record's ID.
- The background task updates the record on completion or failure — never fire-and-forget.
- Wrap the entire background task body in try/except: on failure, update the record to `failed` with error details and log the exception.

```python
# CORRECT — tracked background task
@router.post("/tasks")
async def create_task(request: TaskRequest, db: DbSession, background_tasks: BackgroundTasks):
    task = Task(query=request.query, status="pending")
    db.add(task)
    await db.commit()
    background_tasks.add_task(run_task, task.id)  # pass ID, not the object
    return {"task_id": task.id, "status": "pending"}

async def run_task(task_id: UUID) -> None:
    async with get_session() as db:
        task = await db.get(Task, task_id)
        try:
            task.status = "running"
            await db.commit()
            result = await do_work(task.query)
            task.status = "completed"
            task.result = result
        except Exception as e:
            logger.exception("Task failed", extra={"task_id": str(task_id)})
            task.status = "failed"
            task.error = str(e)
        finally:
            await db.commit()
```

### CORS Must Be Environment-Configured
- Never use `allow_origins=["*"]` with `allow_credentials=True` — this is a security vulnerability.
- Read allowed origins from an environment variable, default to `localhost` only.

```python
# CORRECT — env-configured CORS
allowed_origins = settings.ALLOWED_ORIGINS.split(",")  # from .env
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)
```

### Health Check Must Verify Dependencies
- Health endpoint must test critical dependencies (DB, cache, external APIs), not just return `{"status": "ok"}`.
- Return 503 if any dependency is unreachable.

```python
@router.get("/health")
async def health(db: DbSession) -> dict:
    try:
        await db.execute(text("SELECT 1"))
        return {"status": "ok", "db": "connected"}
    except Exception:
        raise HTTPException(status_code=503, detail="Database unreachable")
```

### Request ID Middleware
- Add middleware that generates a unique `request_id` per request and includes it in all log entries and error responses.
- This enables tracing a single user request across all service logs.

```python
@app.middleware("http")
async def add_request_id(request: Request, call_next):
    request_id = str(uuid4())
    request.state.request_id = request_id
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    return response
```

---

