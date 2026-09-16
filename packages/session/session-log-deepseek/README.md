---
description: "Incremental canonical session-log upload for deployments enabling official DeepSeek request metadata."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-log-deepseek

English | [中文](README.zh.md)

## Summary

Incremental canonical session-log upload for official DeepSeek LLM API requests. This function plugin injects `ctx.sessions` and `ctx.deepseekLlmApiExtensions`, then owns the `dsh_session_log` request field and the durable `session-log-deepseek/delivery-accepted` event from which it derives the acceptance watermark. Disable it only when the official API must not receive a Session-log suffix.

## Table of Contents

- [Configuration](#configuration)
- [Request field](#request-field)
- [Acceptance and retry](#acceptance-and-retry)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="configuration"></a>
## Configuration

| Key | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | Register the `dsh_session_log` contribution. Set it to `false` to stop Session-log upload. |
| `maxBatchBytes` | `4194304` (4 MiB) | Inclusive ceiling on the summed serialized size of one request's `events` members, excluding the array's own punctuation. |

Shipped profiles mount the plugin, so the default configuration registers the request field and appends the acceptance watermark; an overlay opts out with `enabled: false`.

`maxBatchBytes` bounds each request, not the Session. A pending suffix larger than the ceiling drains over successive requests, one admitted prefix per accepted request, so a long-lived Session never has to fit its whole backlog into a single body. This matters because a provider that rejects an oversized body returns no acceptance: before this ceiling existed, a Session whose backlog outgrew the provider's request limit stayed permanently unresumable, since every retry rebuilt the same rejected body. A single event larger than the ceiling is still admitted alone — withholding it would freeze the watermark below it — so the bound is a target rather than a hard guarantee for one oversized record.

<a id="request-field"></a>
## Request field

For a request carrying a live `sessionId`, the plugin folds the greatest accepted watermark for that exact Session format generation, snapshots `Session.events`, and sends the contiguous suffix after the watermark, admitted oldest-first up to `maxBatchBytes`. A process-local fold scans each event once and consumes later appends incrementally; restart and HMR rebuild it from the durable log. The version-1 field contains `sessionFormatVersion`, a raw session header (`seedLength` is present only for a seeded Session), numeric `afterSeq` and `throughSeq`, and every canonical event in the admitted batch translated to raw-number envelope fields. `throughSeq` names the last sequence the request actually carries, never the log tail, so the unadmitted remainder is not recorded as accepted and the next request resumes at the following sequence. Forked sessions ignore inherited parent watermarks because both the recorded Session id and format generation must match the request source. Surface events require `surfaceOp`, with numeric `startSeq` and `endSeq` for replacements; only system, user, and tool events may carry `sourceEventSeqs`. Assistant provider metadata stays in the embedded stream, and log-only events carry neither metadata field.

<a id="acceptance-and-retry"></a>
## Acceptance and retry

The DeepSeek adapter calls the prepared contribution's `accept()` after HTTP 2xx, before it consumes the SSE body. Acceptance appends `session-log-deepseek/delivery-accepted` with the uploaded `throughSeq` and `sessionFormatVersion`; a record that omits the format field denotes v0. The next request uploads that event as part of its new suffix. Transport and non-2xx failures append no acceptance record, so later requests resend the uncertain range. Concurrent deliveries may be accepted out of order; folding the maximum matching `throughSeq` prevents cursor regression.

A crash after server acceptance but before the watermark reaches persistence can replay an accepted range after restart. This is the at-least-once failure direction: uncertainty creates duplicates, never a skipped sequence. The ordinary session checkpoint policy persists the watermark at the next semantic checkpoint; this plugin performs no independent I/O.

Direct requests without a live Session omit `dsh_session_log`. Normal agent, compaction, and session-title calls carry their live Session id.

<a id="model-experience"></a>
## Model Experience

### Session-log metadata

#### What the model sees

Nothing. `dsh_session_log` is a sibling of the DeepSeek request's model-input fields and is not inserted into `messages`, the system prompt, or tool schemas.

#### Token effect

Zero model-input tokens; the field only increases HTTP request bytes.

#### KV Cache effect

None; the model-visible request prefix remains unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Crash-window duplicates** — a 2xx followed by process loss before the acceptance watermark persists causes conservative replay on resume.
- **No live Session means no field** — direct or stale-session calls have no canonical log to snapshot; explicit absence semantics remain deferred.
- **Bounded batches, not a bounded total** — `maxBatchBytes` caps each request, so a large backlog drains over successive requests, but one event larger than the ceiling is still delivered alone and can still be rejected at that size. Delivery remains fail-closed: no event is truncated or dropped to fit.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
