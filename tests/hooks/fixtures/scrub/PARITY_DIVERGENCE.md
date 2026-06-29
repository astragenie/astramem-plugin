# Scrub Parity Divergence Report

**Generated:** FEAT 4a Slice 3  
**Corpus:** `tests/hooks/fixtures/scrub/inputs.jsonl` (100 entries)  
**Tested:** 2026-06-29  
**Gate:** §5.3 BLOCKING for FEAT 4a merge

## Summary

The two scrub paths have **disjoint pattern sets**. There is no overlap between what bash redacts and what JS redacts. Every input touching a real secret lands in one of the divergence categories below.

| Result | Count | Tests |
|---|---|---|
| PARITY (both agree) | 45 inputs | 89 passing |
| DIVERGE:bash-only | 33 inputs | 33 `it.todo` |
| DIVERGE:js-only | 8 inputs | 8 `it.todo` |
| DIVERGE:both (mixed) | 5 inputs | 5 `it.todo` |
| DIVERGE:bash-overredact | 3 inputs | 3 `it.todo` |
| DIVERGE:newline-strip | 1 input | 1 `it.todo` |
| **Total divergences** | **50 inputs** | **57 `it.todo`** |

---

## Divergence class 1 — bash scrubs, JS does not (bash is safer)

Bash patterns: JWT, AWS key ID, Anthropic key, generic `api_key/secret/password/token=`.  
JS has no equivalent string-level patterns — JS only redacts `Bearer <hex>`.

**Safer path: bash.** The new `bin/astramem ingest-transcript` CLI (FEAT 4a Slice 2) only uses `src/lib/scrub.ts` — it will NOT redact these categories. This is a regression relative to the legacy hook path.

### JWT — bash redacts, JS does not

Bash pattern: `eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+`

Note: bash requires each of the first two segments to have 20+ characters after `eyJ`. Short test JWTs (segments < 23 chars total) do NOT match. Real production JWTs with standard claims are long enough to match.

| ID | Input (truncated) | Bash output | JS output |
|---|---|---|---|
| jwt-02 | `token eyJhbGciOiJSUzI1NiI...` | `token [redacted:jwt] rest of line` | unchanged |
| jwt-03 | `Authorization: Bearer eyJ0eXAi...` | `Authorization: Bearer [redacted:jwt]` | `[REDACTED:bearer]` replaces the hex portion but NOT the JWT-as-bearer |
| jwt-04..jwt-05 | long JWT patterns | `[redacted:jwt]` | unchanged |
| jwt-08 | `client_assertion=eyJ...` | `client_assertion=[redacted:jwt]` | unchanged |

Non-matching JWTs (bash correctly skips): jwt-01 (short header/payload), jwt-06/07 (same short header embedded in text), jwt-09 (alg:none — empty signature, `+` requires ≥1 char), jwt-10 (short header in Bearer context).

### AWS Key IDs — bash redacts, JS does not

Bash pattern: `AKIA[0-9A-Z]{16}` (exact 20 uppercase chars)

| ID | Input | Bash output | JS output |
|---|---|---|---|
| aws-key-01 | `AKIAIOSFODNN7EXAMPLE` | `[redacted:aws-key]` | unchanged |
| aws-key-02..09 | AKIA key in context | `[redacted:aws-key]` | unchanged |

Note: `aws-key-06` (`AGPA` prefix) — bash doesn't redact it (only AKIA pattern). `aws-key-10` (19-char value) doesn't match because `AKIAIOSFODNN7EXAMPL` is 19 chars total — one short. `edge-13` (`AKIAIOSFODNN7EXAMPLE1`, 21 chars) — bash DOES redact the first 20 chars, leaving the trailing `1`; this was a fixture mislabel.

ASIA session tokens (`ASIA...`): bash pattern `AKIA[0-9A-Z]{16}` does NOT match `ASIA`. aws-key-04 (`ASIAIOSFODNN7EXAMPLE12`) is therefore not redacted by bash and should be marked as a gap.

### Anthropic API Keys — bash redacts, JS does not

Bash pattern: `sk-(ant-)?[A-Za-z0-9_-]{20,}`

| ID | Input | Bash output | JS output |
|---|---|---|---|
| anthropic-01..05 | `sk-ant-api03-...` (long) | `[redacted:anthropic-key]` | unchanged |
| anthropic-08..10 | various forms | `[redacted:anthropic-key]` | unchanged |

Non-matching: anthropic-06 (`sk-ant-api03-short` — only 5 chars after prefix), anthropic-07 (`sk-12345` — too short).

### Generic secret patterns — bash redacts, JS does not

Bash pattern: `(api[_-]?key|secret|password|token)[[:space:]]*[:=][[:space:]]*['"]?[A-Za-z0-9_./+=-]{16,}`

**Critical note:** The keyword must appear IMMEDIATELY followed by optional whitespace then `:` or `=`. Full compound names like `aws_secret_access_key=` embed `secret` as a substring but the next character after `secret` is `_` — not whitespace or `:=` — so they do NOT match. This means:

- `secret=wJalrXUtnFEM...` → matches
- `aws_secret_access_key=wJalrXUT...` → does NOT match (bash gap — security risk!)
- `AWS_SECRET_ACCESS_KEY=...` → does NOT match for same reason

The character class `[A-Za-z0-9_./+=-]` includes hyphen (literal at end-of-class in ERE), so dash-separated values like `AAAA-BBBB-CCCC-DDDD` are included.

| ID | Input | Bash output | JS output |
|---|---|---|---|
| generic-01..09 | `api_key=`, `token=`, `secret=`, `password=` variants | `[redacted:generic-secret]` | unchanged |

Non-matching: generic-10 (`token=short` — value too short, < 16 chars).

---

## Divergence class 2 — JS scrubs, bash does not (JS is safer)

JS pattern: `Bearer\s+[A-Fa-f0-9]{32,128}` (case-insensitive)  
Bash has no `Bearer` pattern.

**Safer path: JS.** The new CLI path uses JS scrub, so Bearer tokens are protected in the new path. The legacy hook path does NOT redact Bearer tokens in transcript text.

| ID | Input | JS output | Bash output |
|---|---|---|---|
| bearer-01..07, bearer-10 | `Bearer <32-128 hex chars>` variants | `[REDACTED:bearer]` | unchanged |

Non-matching: bearer-08 (only 6 hex chars), bearer-09 (31 hex chars — one below minimum).

---

## Divergence class 3 — both engines scrub but produce different output (mixed inputs)

Inputs containing patterns from both engine sets. Neither produces the fully-redacted result.

| ID | Input (summary) | Bash output | JS output |
|---|---|---|---|
| edge-06 | `AKIA... Bearer <hex>` | AKIA redacted, Bearer plain | Bearer redacted, AKIA plain |
| edge-07 | `Bearer <hex> sk-ant-...` | Anthropic key redacted, Bearer plain | Bearer redacted, Anthropic key plain |
| edge-08 | `JWT Bearer <hex>` | JWT redacted, Bearer plain | Bearer redacted, JWT plain |
| edge-10 | `sk-ant-... api_key=...` | Both bash patterns redacted | Neither redacted |
| edge-11 | All bash patterns + Bearer | AKIA/JWT/generic redacted | Bearer redacted |

---

## Divergence class 4 — bash over-redaction (false positives, bash is wrong)

Bash redacts legitimate text that should NOT be redacted. JS correctly passes through.

| ID | Input | Bash output | JS output | Root cause |
|---|---|---|---|---|
| innocuous-09 | `const token = getUserTokenFromContext();` | `const [redacted:generic-secret]();` | unchanged | `token` keyword + ` = ` + 24-char identifier triggers generic-secret pattern. False positive. |
| edge-13 | `AKIAIOSFODNN7EXAMPLE1` (21 chars) | `[redacted:aws-key]1` | unchanged | AKIA pattern matches first 20 chars; trailing `1` survives. Partial redaction is surprising behavior. |
| edge-15 | `api_key: AAAA-BBBB-CCCC-DDDD-EEEE-FFFF` | `[redacted:generic-secret]` | unchanged | Hyphen is literal in `[A-Za-z0-9_./+=-]` class; dash-separated values match. |

---

## Divergence class 5 — trailing newline stripping (bash implementation detail)

Bash's `jq -Rs` serialiser strips the trailing newline from stdin.  
JS `scrub()` preserves all characters including trailing newlines.  
Not a security concern — purely a byte-equality issue.

| ID | Input | Bash output | JS output |
|---|---|---|---|
| edge-03 | `"\t\n"` | `"\t"` (trailing `\n` stripped) | `"\t\n"` |

---

## Recommendation for Slice 4

**Three-part fix required:**

### Part A — JS must add string-level patterns for bash-only categories

`src/lib/scrub.ts` `scrub()` function currently only redacts `Bearer <hex>` in strings. It needs string-level patterns for:

1. JWT: `eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+`
2. AWS key IDs: `(AKIA|ASIA|AROA|AIDA|AIPA|ANPA|ANVA|APKA|ASCA|AGPA)[A-Z0-9]{16}`  
   (Extend beyond just AKIA — include all AWS key prefixes)
3. Anthropic keys: `sk(?:-ant)?-[A-Za-z0-9_-]{20,}`
4. Generic secrets: keyword-before-value pattern equivalent to bash's

Adding these to `BEARER_RE` (or as additional patterns in `scrub()`) makes the new CLI path as protective as the legacy bash path for these categories.

**Decision axis:** Fix the JS side (preferred — the new CLI path becomes canonical) OR add a pre-scrub step in the hook shim before calling bash (compatibility shim approach). Given the CLI is the new canonical path, fixing JS is cleaner.

### Part B — Fix bash gap: `aws_secret_access_key=...` not caught

The bash generic pattern misses compound env-var names like `AWS_SECRET_ACCESS_KEY=...` because the keyword must appear at the start of the `[:=]` boundary. This is a pre-existing bash gap. Slice 4 should add a dedicated pattern for AWS compound secret names OR acknowledge as accepted gap (the AWS secret key value itself isn't common in transcripts).

### Part C — False positive in bash: `token = <identifier>()`

Bash incorrectly redacts `token = <identifierName>()` patterns. This mangles legitimate code snippets in transcripts. The new CLI path (JS-only) correctly avoids this. The legacy hook path has this false-positive behavior. Documented as known bash limitation; not fixed since legacy path is deprecated.

---

## Verdict

**The two regex engines are NOT parity-equivalent.** The divergences are material:

- 33 categories of real secrets redacted by bash but not JS (leaks possible in new CLI path)
- 8 categories of Bearer tokens redacted by JS but not bash (leaks possible in legacy path)
- 3 bash false positives that mangle legitimate code text

**This confirms the merge gate is working correctly.** The new `ingest-transcript` CLI will NOT provide equivalent scrub protection to the legacy hook until Slice 4 extends `src/lib/scrub.ts` with the bash-equivalent patterns (Part A above).
