<!-- Split out of code-gen/SKILL.md so it loads only when relevant (prompting-standards.md §12). -->

Structured-output rules for code that calls an LLM.

---

## LLM Integration — Structured Output Mandatory

When generated code calls any LLM (Claude, GPT, or other), follow these rules:

### 1. Always Use Structured Output

Use `tool_use` / `function_calling` / `response_format: { type: "json_schema", json_schema: ... }` for every LLM call. Never parse free-text responses with regex or string splitting.

### 2. Define a Response Schema

Every LLM call must have a typed model for the expected response:

```python
from pydantic import BaseModel
from typing import Literal

class ClassificationResult(BaseModel):
    category: str
    confidence: Literal["high", "medium", "low"]
    reasoning: str
```

```typescript
interface ClassificationResult {
  category: string;
  confidence: "high" | "medium" | "low";
  reasoning: string;
}
```

### 3. Validate Before Using

Parse the LLM response through the schema. If validation fails:
1. Retry once with an explicit correction prompt: "Your response did not match the required schema. Required: {schema}. Please respond again."
2. If second attempt fails, raise a typed error — do not fall back to a default value.

### 4. No Silent Fallbacks

Never write:
```python
# WRONG — hides bugs that compound
try:
    result = await call_llm(prompt)
    parsed = ResponseModel.model_validate_json(result)
except Exception:
    parsed = ResponseModel(category="unknown", confidence="low", reasoning="")
```

Instead:
```python
# CORRECT — caller decides how to handle failure
class LLMResponseError(Exception):
    def __init__(self, raw_response: str, validation_error: str):
        self.raw_response = raw_response
        self.validation_error = validation_error
        super().__init__(f"LLM response validation failed: {validation_error}")

try:
    result = await call_llm(prompt)
    parsed = ResponseModel.model_validate_json(result)
except ValidationError as e:
    raise LLMResponseError(raw_response=result, validation_error=str(e))
```

### 5. Log Raw Responses

Always log the raw LLM response at DEBUG level before parsing:

```python
logger.debug(
    "LLM response received",
    extra={
        "provider": self._provider_name,
        "model": self._model,
        "prompt_tokens": response.usage.input_tokens,
        "completion_tokens": response.usage.output_tokens,
        "raw_content": response.content[:1000],
        "latency_ms": round(elapsed_ms, 2),
    },
)
```

---

### 6. Prompt Caching (Anthropic API)

When the generated app calls the Claude API (the `anthropic` SDK), make it cache-friendly by default. Prompt caching reuses the unchanging prefix of a request, cutting cost and latency on repeated calls. This is an Anthropic-API-specific feature — do not apply it to OpenAI or other providers (OpenAI caches automatically with no breakpoint API).

- **Static content first.** Order each request so unchanging content comes before variable content: `tools`, then `system`, then long-lived context (instructions, docs, examples, schemas), then the moving conversation tail. Caching only helps a prefix that is byte-for-byte identical across calls, so never interleave per-request data (timestamps, user IDs, retrieved snippets) into that prefix.
- **One breakpoint on the stable prefix.** Put a single `cache_control` breakpoint (`{"type": "ephemeral"}`) on the last block of the stable prefix — typically the end of the system prompt or the end of a large tool/context block. Everything up to and including that block becomes the cached prefix.
- **Rely on auto-caching for the moving tail.** Do not stamp `cache_control` on every turn. Anthropic automatically extends cache coverage to the longest previously-seen prefix, so the one breakpoint at the end of the stable section is reused by later turns without per-message markers. Reserve extra breakpoints (max 4 total) only for additional large, reused segments.
- **Keep the prefix above the cache threshold.** Cacheable prefixes have a model-dependent minimum (~1024+ tokens). Tiny system prompts will not cache — do not contort small prompts to force it.
- **Verify cache behavior.** Confirm the breakpoint lands where intended by inspecting `usage`: `cache_creation_input_tokens` on the first call (cache write) and `cache_read_input_tokens` on later calls (cache hit).

```python
# CORRECT — stable prefix cached, moving tail auto-cached
resp = client.messages.create(
    model="claude-...",
    system=[
        {
            "type": "text",
            "text": LONG_STATIC_INSTRUCTIONS,          # unchanging across calls
            "cache_control": {"type": "ephemeral"},     # breakpoint at end of stable prefix
        }
    ],
    messages=conversation,                              # moving tail: no cache_control needed
)
# resp.usage.cache_creation_input_tokens / resp.usage.cache_read_input_tokens
```

---

### 7. Batch API for Bulk, Non-Interactive Work (Anthropic API)

When the generated app does **bulk, one-shot** LLM work — classify a backlog, summarize a document set, score a corpus, run an offline backfill — use the Anthropic **Message Batches API** instead of one synchronous call per item. Batch requests are **50% cheaper** than standard calls, and the discount **stacks with prompt caching** (a cached, batched request pays ~50% of the already-90%-discounted cache-read rate).

- **Use it only for non-interactive paths.** Batch is asynchronous (results land within ~24h, usually much sooner) and is **not** conversational — there is no mid-request tool loop. Never use it for a live request/response path, an interactive agent loop, or anything a user waits on. Those stay synchronous.
- **Right shape:** a queue/cron/worker that has many independent prompts ready at once. Wrong shape: a web handler serving one user, or an agent that needs each result to decide its next step.
- **Combine with caching:** put the shared instructions/schema in the cached prefix (section 6) so every item in the batch reuses it.
- This is Anthropic-API-specific. For OpenAI/other providers, use their equivalent batch endpoint or skip.

```python
# CORRECT — bulk classification as one batch job, not N synchronous calls
batch = client.messages.batches.create(
    requests=[
        {"custom_id": item.id, "params": {"model": "claude-...", "max_tokens": 256,
         "system": SHARED_PREFIX, "messages": [{"role": "user", "content": item.text}]}}
        for item in backlog          # many independent items, no inter-item dependency
    ]
)
# poll batch.id, then retrieve results — do NOT block a user request on this
```

### 8. Output Budgeting

Output tokens are billed at the highest rate and are fully re-read as input on the next turn of any conversation, so unbounded output compounds cost. Constrain it in generated LLM calls:

- **Always set an explicit `max_tokens`** sized to the expected response — not the model maximum. A classifier returning a small JSON object needs ~256, not 4096.
- **Ask for the smallest sufficient output.** Prefer structured output (section 1) and IDs/enums over prose; instruct the model to omit restated context and long explanations unless required.
- **Don't request reasoning you discard.** Only enable extended thinking when the task needs it; for mechanical/structured tasks, leave it off.

---

