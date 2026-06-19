# AstraMemory Transcript Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AstraMemory plugin production-ready by replacing raw transcript dumps with extracted typed memories (decision / fact / lesson / event), graph-linked to prior knowledge, sent over Bearer auth with client-side scrub + retry.

**Architecture:** Plugin captures last-N turns in hooks, scrubs obvious secrets, POSTs to a new `/ingest/transcript` endpoint with Bearer token + 2-retry. Server applies a defense-in-depth scrub, stores the raw turns as a `summary` memory, runs a `TranscriptExtractor` (LLM) emitting typed atoms, then a `MemoryGraphLinker` writes `mentions`, `relates_to`, and `supersedes` edges to existing memories.

**Tech Stack:** C# / .NET 9 (AstraMemory.Api, AstraMemory.Application, AstraMemory.Infrastructure), EF Core (PostgreSQL), Bash 4+ (Git Bash on Windows), Node 20+ (plugin CLI / tests via `node --test`).

**Repos touched:**
- `C:/work/mega/memory` — server (AstraMemory.Api / Application / Infrastructure / Tests).
- `C:/work/mega/astramemory-plugin` — plugin (hooks, CLI, `.mcp.json`, tests).

**Spec:** `docs/superpowers/specs/2026-06-19-astramemory-transcript-ingest-design.md`

---

## File Structure

### Server (`C:/work/mega/memory/`)

**Create:**
- `src/AstraMemory.Api/Controllers/TranscriptIngestController.cs` — POST `/ingest/transcript`.
- `src/AstraMemory.Api/Models/IngestTranscriptRequest.cs` — request DTO (`event`, `turns[]`, etc.).
- `src/AstraMemory.Api/Models/IngestTranscriptResponse.cs` — response DTO.
- `src/AstraMemory.Application/Features/TranscriptIngest/TranscriptScrubber.cs` — regex pass + hit count.
- `src/AstraMemory.Application/Features/TranscriptIngest/ITranscriptIngestService.cs`
- `src/AstraMemory.Application/Features/TranscriptIngest/TranscriptIngestService.cs` — orchestrates scrub → write summary → extractor → linker.
- `src/AstraMemory.Application/Features/TranscriptIngest/IdempotencyCache.cs` — in-memory `ConcurrentDictionary` 24 h TTL.
- `src/AstraMemory.Domain/Interfaces/ITranscriptExtractor.cs`
- `src/AstraMemory.Infrastructure/Services/TranscriptExtractor.cs` — LLM call + JSON parse → typed items.
- `src/AstraMemory.Domain/Interfaces/IMemoryGraphLinker.cs`
- `src/AstraMemory.Infrastructure/Services/MemoryGraphLinker.cs` — entity-ref + similarity + supersedes passes.
- `tests/AstraMemory.Tests/TranscriptIngest/TranscriptScrubberTests.cs`
- `tests/AstraMemory.Tests/TranscriptIngest/TranscriptExtractorTests.cs`
- `tests/AstraMemory.Tests/TranscriptIngest/MemoryGraphLinkerTests.cs`
- `tests/AstraMemory.Tests/TranscriptIngest/TranscriptIngestServiceTests.cs`
- `tests/AstraMemory.Tests/Controllers/TranscriptIngestControllerTests.cs`

**Modify:**
- `src/AstraMemory.Application/DependencyInjection.cs` — register new services.
- `src/AstraMemory.Infrastructure/DependencyInjection.cs` — register extractor + linker.
- `src/AstraMemory.Api/Program.cs` (only if a route-specific rate limiter is needed; otherwise reuse existing middleware).

### Plugin (`C:/work/mega/astramemory-plugin/`)

**Create:**
- `hooks/scripts/_ingest-transcript.sh` — shared helper (scrub + Bearer + retry + POST).
- `hooks/scripts/subagent-stop-capture.sh` — SubagentStop hook entry.
- `tests/ingest-scrub.test.mjs`
- `tests/ingest-retry.test.mjs`
- `tests/ingest-payload.test.mjs`

**Modify:**
- `hooks/scripts/pre-compact-capture.sh` — delegate to helper.
- `hooks/scripts/session-end-summary.sh` — delegate to helper.
- `hooks/hooks.json` — add `SubagentStop` block.
- `.mcp.json` — switch `Authorization` to Bearer.
- `.env.local` — drop `MEMORY_API_KEY`, add retry/subagent vars.
- `.env.azuredev` — drop `MEMORY_API_KEY`, add retry/subagent vars.
- `.claude-plugin/plugin.json` — bump `version` 0.2.0 → 0.3.0.
- `package.json` — bump `version` 0.2.0 → 0.3.0.
- `README.md` — document new endpoint, retry vars, Bearer-only `.mcp.json`, SubagentStop.
- `CHANGELOG.md` — add v0.3.0 entry (file may not yet exist; create if absent).

---

## Phase 1 — Server `/ingest/transcript` endpoint

### Task 1.1: Scaffold `TranscriptScrubber` with failing test

**Files:**
- Create: `tests/AstraMemory.Tests/TranscriptIngest/TranscriptScrubberTests.cs`
- Create: `src/AstraMemory.Application/Features/TranscriptIngest/TranscriptScrubber.cs`

- [ ] **Step 1: Write the failing scrub tests**

Create `tests/AstraMemory.Tests/TranscriptIngest/TranscriptScrubberTests.cs`:

```csharp
using AstraMemory.Application.Features.TranscriptIngest;
using FluentAssertions;
using Xunit;

namespace AstraMemory.Tests.TranscriptIngest;

public sealed class TranscriptScrubberTests
{
    [Theory]
    [InlineData(
        "token is eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
        "token is [redacted:jwt]")]
    [InlineData(
        "AKIAIOSFODNN7EXAMPLE inside notes",
        "[redacted:aws-key] inside notes")]
    [InlineData(
        "key sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa here",
        "key [redacted:anthropic-key] here")]
    [InlineData(
        "config: api_key=ABCDEF1234567890ABCDEF and then more",
        "config: [redacted:generic-secret] and then more")]
    public void Scrub_replaces_known_secret_patterns(string input, string expected)
    {
        var result = TranscriptScrubber.Scrub(input);

        result.Text.Should().Be(expected);
        result.Hits.Should().Be(1);
    }

    [Fact]
    public void Scrub_counts_multiple_hits_in_one_string()
    {
        var input = "AKIAIOSFODNN7EXAMPLE and AKIAABCDEFGHIJKL1234";

        var result = TranscriptScrubber.Scrub(input);

        result.Hits.Should().Be(2);
        result.Text.Should().Be("[redacted:aws-key] and [redacted:aws-key]");
    }

    [Fact]
    public void Scrub_leaves_normal_text_untouched()
    {
        var input = "the cosine threshold for relates_to is 0.82 in MemoryGraphLinker";

        var result = TranscriptScrubber.Scrub(input);

        result.Hits.Should().Be(0);
        result.Text.Should().Be(input);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/AstraMemory.Tests/AstraMemory.Tests.csproj --filter "FullyQualifiedName~TranscriptScrubberTests"`
Expected: FAIL — type `AstraMemory.Application.Features.TranscriptIngest.TranscriptScrubber` is undefined.

- [ ] **Step 3: Write minimal `TranscriptScrubber`**

Create `src/AstraMemory.Application/Features/TranscriptIngest/TranscriptScrubber.cs`:

```csharp
using System.Text.RegularExpressions;

namespace AstraMemory.Application.Features.TranscriptIngest;

public static class TranscriptScrubber
{
    private static readonly (Regex Pattern, string Replacement)[] Patterns =
    [
        (new Regex(@"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+",
                   RegexOptions.Compiled),                         "[redacted:jwt]"),
        (new Regex(@"AKIA[0-9A-Z]{16}",
                   RegexOptions.Compiled),                         "[redacted:aws-key]"),
        (new Regex(@"sk-(?:ant-)?[A-Za-z0-9_-]{20,}",
                   RegexOptions.Compiled),                         "[redacted:anthropic-key]"),
        (new Regex(@"(?i)(?:api[_-]?key|secret|password|token)\s*[:=]\s*['""]?[A-Za-z0-9_\-./+=]{16,}",
                   RegexOptions.Compiled),                         "[redacted:generic-secret]"),
    ];

    public readonly record struct ScrubResult(string Text, int Hits);

    public static ScrubResult Scrub(string input)
    {
        if (string.IsNullOrEmpty(input)) return new(input ?? string.Empty, 0);

        var text = input;
        var hits = 0;
        foreach (var (pattern, replacement) in Patterns)
        {
            text = pattern.Replace(text, _ => { hits++; return replacement; });
        }
        return new(text, hits);
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `dotnet test tests/AstraMemory.Tests/AstraMemory.Tests.csproj --filter "FullyQualifiedName~TranscriptScrubberTests"`
Expected: PASS — all 6 cases green.

- [ ] **Step 5: Commit**

```bash
cd C:/work/mega/memory
git add tests/AstraMemory.Tests/TranscriptIngest/TranscriptScrubberTests.cs \
        src/AstraMemory.Application/Features/TranscriptIngest/TranscriptScrubber.cs
git commit -m "feat(api): TranscriptScrubber regex pass for transcript ingest"
```

---

### Task 1.2: Define request + response DTOs

**Files:**
- Create: `src/AstraMemory.Api/Models/IngestTranscriptRequest.cs`
- Create: `src/AstraMemory.Api/Models/IngestTranscriptResponse.cs`

- [ ] **Step 1: Create request DTO**

Create `src/AstraMemory.Api/Models/IngestTranscriptRequest.cs`:

```csharp
using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace AstraMemory.Api.Models;

public sealed record IngestTranscriptRequest(
    [property: JsonPropertyName("event")]
    [Required, RegularExpression("^(pre_compact|session_end|subagent_stop)$")]
    string Event,

    [property: JsonPropertyName("project_id")]
    string? ProjectId,

    [property: JsonPropertyName("session_id")]
    [Required]
    string SessionId,

    [property: JsonPropertyName("agent_type")]
    string? AgentType,

    [property: JsonPropertyName("cwd")]
    string? Cwd,

    [property: JsonPropertyName("captured_at")]
    DateTimeOffset? CapturedAt,

    [property: JsonPropertyName("turns")]
    [Required]
    IReadOnlyList<TranscriptTurn> Turns,

    [property: JsonPropertyName("client_scrub_applied")]
    bool? ClientScrubApplied,

    [property: JsonPropertyName("client_scrub_hits")]
    int? ClientScrubHits,

    [property: JsonPropertyName("client_version")]
    string? ClientVersion);

public sealed record TranscriptTurn(
    [property: JsonPropertyName("role")]
    [Required, RegularExpression("^(user|assistant)$")]
    string Role,

    [property: JsonPropertyName("text")]
    [Required]
    string Text,

    [property: JsonPropertyName("ts")]
    DateTimeOffset? Ts);
```

- [ ] **Step 2: Create response DTO**

Create `src/AstraMemory.Api/Models/IngestTranscriptResponse.cs`:

```csharp
using System.Text.Json.Serialization;

namespace AstraMemory.Api.Models;

public sealed record IngestTranscriptResponse(
    [property: JsonPropertyName("summary_memory_id")]
    Guid SummaryMemoryId,

    [property: JsonPropertyName("extraction_job_id")]
    Guid ExtractionJobId,

    [property: JsonPropertyName("extracted_count")]
    int ExtractedCount,

    [property: JsonPropertyName("scrub_hits")]
    ScrubHits ScrubHits,

    [property: JsonPropertyName("queued_extraction_types")]
    IReadOnlyList<string> QueuedExtractionTypes);

public sealed record ScrubHits(
    [property: JsonPropertyName("client")] int Client,
    [property: JsonPropertyName("server")] int Server);
```

- [ ] **Step 3: Verify compile**

Run: `dotnet build src/AstraMemory.Api/AstraMemory.Api.csproj`
Expected: build succeeds; no test changes yet.

- [ ] **Step 4: Commit**

```bash
git add src/AstraMemory.Api/Models/IngestTranscriptRequest.cs \
        src/AstraMemory.Api/Models/IngestTranscriptResponse.cs
git commit -m "feat(api): transcript ingest DTOs"
```

---

### Task 1.3: `IdempotencyCache` with failing test

**Files:**
- Create: `tests/AstraMemory.Tests/TranscriptIngest/IdempotencyCacheTests.cs`
- Create: `src/AstraMemory.Application/Features/TranscriptIngest/IdempotencyCache.cs`

- [ ] **Step 1: Write the failing test**

Create `tests/AstraMemory.Tests/TranscriptIngest/IdempotencyCacheTests.cs`:

```csharp
using AstraMemory.Application.Features.TranscriptIngest;
using FluentAssertions;
using Xunit;

namespace AstraMemory.Tests.TranscriptIngest;

public sealed class IdempotencyCacheTests
{
    [Fact]
    public void TryGet_returns_false_for_unknown_key()
    {
        var cache = new IdempotencyCache(TimeSpan.FromHours(1), () => DateTimeOffset.UtcNow);

        cache.TryGet("missing", out var value).Should().BeFalse();
        value.Should().BeNull();
    }

    [Fact]
    public void Store_then_TryGet_returns_stored_value()
    {
        var cache = new IdempotencyCache(TimeSpan.FromHours(1), () => DateTimeOffset.UtcNow);
        var payload = """{"id":"abc"}""";

        cache.Store("k", payload);

        cache.TryGet("k", out var value).Should().BeTrue();
        value.Should().Be(payload);
    }

    [Fact]
    public void TryGet_evicts_expired_entries()
    {
        var now = DateTimeOffset.UtcNow;
        var clock = now;
        var cache = new IdempotencyCache(TimeSpan.FromMinutes(5), () => clock);
        cache.Store("k", "v");

        clock = now.AddMinutes(6);

        cache.TryGet("k", out var value).Should().BeFalse();
        value.Should().BeNull();
    }
}
```

- [ ] **Step 2: Run to verify fails**

Run: `dotnet test --filter "FullyQualifiedName~IdempotencyCacheTests"`
Expected: FAIL — `IdempotencyCache` undefined.

- [ ] **Step 3: Implement `IdempotencyCache`**

Create `src/AstraMemory.Application/Features/TranscriptIngest/IdempotencyCache.cs`:

```csharp
using System.Collections.Concurrent;

namespace AstraMemory.Application.Features.TranscriptIngest;

public sealed class IdempotencyCache
{
    private readonly ConcurrentDictionary<string, Entry> _entries = new();
    private readonly TimeSpan _ttl;
    private readonly Func<DateTimeOffset> _clock;

    public IdempotencyCache(TimeSpan ttl, Func<DateTimeOffset> clock)
    {
        _ttl = ttl;
        _clock = clock;
    }

    public IdempotencyCache() : this(TimeSpan.FromHours(24), () => DateTimeOffset.UtcNow) { }

    public bool TryGet(string key, out string? value)
    {
        if (_entries.TryGetValue(key, out var entry))
        {
            if (_clock() - entry.StoredAt <= _ttl)
            {
                value = entry.Payload;
                return true;
            }
            _entries.TryRemove(key, out _);
        }
        value = null;
        return false;
    }

    public void Store(string key, string payload)
    {
        _entries[key] = new Entry(payload, _clock());
    }

    private readonly record struct Entry(string Payload, DateTimeOffset StoredAt);
}
```

- [ ] **Step 4: Run tests; expect PASS**

Run: `dotnet test --filter "FullyQualifiedName~IdempotencyCacheTests"`
Expected: PASS — 3 cases green.

- [ ] **Step 5: Commit**

```bash
git add tests/AstraMemory.Tests/TranscriptIngest/IdempotencyCacheTests.cs \
        src/AstraMemory.Application/Features/TranscriptIngest/IdempotencyCache.cs
git commit -m "feat(api): idempotency cache for transcript ingest"
```

---

### Task 1.4: `ITranscriptIngestService` skeleton (no extraction yet)

**Files:**
- Create: `src/AstraMemory.Application/Features/TranscriptIngest/ITranscriptIngestService.cs`
- Create: `src/AstraMemory.Application/Features/TranscriptIngest/TranscriptIngestService.cs`
- Create: `tests/AstraMemory.Tests/TranscriptIngest/TranscriptIngestServiceTests.cs`

The full service is built incrementally: this task only wires the scrub + write-summary path. Extractor + linker are wired in Phase 2.

- [ ] **Step 1: Define interface**

Create `src/AstraMemory.Application/Features/TranscriptIngest/ITranscriptIngestService.cs`:

```csharp
using AstraMemory.Domain.ValueObjects;

namespace AstraMemory.Application.Features.TranscriptIngest;

public interface ITranscriptIngestService
{
    Task<TranscriptIngestResult> IngestAsync(
        TenantContext tenant,
        TranscriptIngestCommand cmd,
        CancellationToken ct = default);
}

public sealed record TranscriptIngestCommand(
    string Event,
    string SessionId,
    string? ProjectId,
    string? AgentType,
    string? Cwd,
    DateTimeOffset? CapturedAt,
    IReadOnlyList<TranscriptIngestTurn> Turns,
    bool ClientScrubApplied,
    int ClientScrubHits,
    string? ClientVersion,
    string? IdempotencyKey);

public sealed record TranscriptIngestTurn(string Role, string Text, DateTimeOffset? Ts);

public sealed record TranscriptIngestResult(
    Guid SummaryMemoryId,
    Guid ExtractionJobId,
    int ExtractedCount,
    int ClientScrubHits,
    int ServerScrubHits,
    IReadOnlyList<string> QueuedExtractionTypes);
```

- [ ] **Step 2: Write failing test for happy path summary write**

Create `tests/AstraMemory.Tests/TranscriptIngest/TranscriptIngestServiceTests.cs`:

```csharp
using AstraMemory.Application.Features.TranscriptIngest;
using AstraMemory.Domain.ValueObjects;
using AstraMemory.Infrastructure.Services;
using FluentAssertions;
using NSubstitute;
using Xunit;

namespace AstraMemory.Tests.TranscriptIngest;

public sealed class TranscriptIngestServiceTests
{
    [Fact]
    public async Task IngestAsync_stores_raw_turns_as_summary_memory()
    {
        var writer = Substitute.For<IMemoryWriteService>();
        writer.StoreAsync(Arg.Any<TenantContext>(), Arg.Any<MemoryWriteService.StoreCommand>(), Arg.Any<CancellationToken>())
              .Returns(new MemoryWriteService.StoreResult(
                  Guid.Parse("11111111-1111-1111-1111-111111111111"),
                  "active", false, DateTimeOffset.UtcNow));

        var sut = new TranscriptIngestService(writer, new IdempotencyCache());
        var cmd = new TranscriptIngestCommand(
            Event: "pre_compact",
            SessionId: "s1",
            ProjectId: "p1",
            AgentType: null,
            Cwd: "/c/repo",
            CapturedAt: DateTimeOffset.UtcNow,
            Turns: [new("user", "hello", null), new("assistant", "world", null)],
            ClientScrubApplied: true,
            ClientScrubHits: 0,
            ClientVersion: "0.3.0",
            IdempotencyKey: null);

        var tenant = new TenantContext(Guid.NewGuid(), Guid.NewGuid(), "tier1", false);

        var result = await sut.IngestAsync(tenant, cmd, CancellationToken.None);

        result.SummaryMemoryId.Should().Be(Guid.Parse("11111111-1111-1111-1111-111111111111"));
        result.ServerScrubHits.Should().Be(0);
        await writer.Received(1).StoreAsync(
            tenant,
            Arg.Is<MemoryWriteService.StoreCommand>(c =>
                c.Type == "summary" &&
                c.Source == "claude-code-pre_compact" &&
                c.Content.Contains("[user] hello") &&
                c.Content.Contains("[assistant] world")),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task IngestAsync_scrubs_server_side_and_counts_hits()
    {
        var writer = Substitute.For<IMemoryWriteService>();
        writer.StoreAsync(Arg.Any<TenantContext>(), Arg.Any<MemoryWriteService.StoreCommand>(), Arg.Any<CancellationToken>())
              .Returns(new MemoryWriteService.StoreResult(Guid.NewGuid(), "active", false, DateTimeOffset.UtcNow));

        var sut = new TranscriptIngestService(writer, new IdempotencyCache());
        var cmd = new TranscriptIngestCommand(
            "session_end", "s2", "p1", null, null, null,
            [new("user", "AKIAIOSFODNN7EXAMPLE leak", null)],
            ClientScrubApplied: false, ClientScrubHits: 0, ClientVersion: null, IdempotencyKey: null);
        var tenant = new TenantContext(Guid.NewGuid(), Guid.NewGuid(), "tier1", false);

        var result = await sut.IngestAsync(tenant, cmd, CancellationToken.None);

        result.ServerScrubHits.Should().Be(1);
        await writer.Received().StoreAsync(
            tenant,
            Arg.Is<MemoryWriteService.StoreCommand>(c => c.Content.Contains("[redacted:aws-key]")),
            Arg.Any<CancellationToken>());
    }
}
```

- [ ] **Step 3: Run; expect FAIL (no impl)**

Run: `dotnet test --filter "FullyQualifiedName~TranscriptIngestServiceTests"`
Expected: FAIL — `TranscriptIngestService` undefined.

- [ ] **Step 4: Implement Phase-1 service**

Create `src/AstraMemory.Application/Features/TranscriptIngest/TranscriptIngestService.cs`:

```csharp
using System.Text;
using AstraMemory.Domain.ValueObjects;
using AstraMemory.Infrastructure.Services;

namespace AstraMemory.Application.Features.TranscriptIngest;

public sealed class TranscriptIngestService(
    IMemoryWriteService writer,
    IdempotencyCache idempotency) : ITranscriptIngestService
{
    public async Task<TranscriptIngestResult> IngestAsync(
        TenantContext tenant, TranscriptIngestCommand cmd, CancellationToken ct = default)
    {
        var scrubbedTurns = new List<(string Role, string Text)>(cmd.Turns.Count);
        var serverHits = 0;
        foreach (var turn in cmd.Turns)
        {
            var r = TranscriptScrubber.Scrub(turn.Text);
            serverHits += r.Hits;
            scrubbedTurns.Add((turn.Role, r.Text));
        }

        var sb = new StringBuilder();
        sb.Append("Transcript digest (").Append(cmd.Event).Append(") session=").Append(cmd.SessionId).AppendLine();
        if (!string.IsNullOrEmpty(cmd.ProjectId)) sb.Append("Project: ").AppendLine(cmd.ProjectId);
        if (!string.IsNullOrEmpty(cmd.AgentType)) sb.Append("Agent: ").AppendLine(cmd.AgentType);
        sb.AppendLine();
        foreach (var (role, text) in scrubbedTurns)
        {
            sb.Append('[').Append(role).Append("] ").AppendLine(text);
        }

        var storeCmd = new MemoryWriteService.StoreCommand(
            Content: sb.ToString(),
            Type: "summary",
            Scope: "private",
            Importance: 0.7,
            AgentId: cmd.AgentType,
            ProjectId: cmd.ProjectId,
            SessionId: cmd.SessionId,
            ExpiresAt: null,
            Metadata: null,
            Source: $"claude-code-{cmd.Event}",
            Tags: BuildTags(cmd.Event));

        var stored = await writer.StoreAsync(tenant, storeCmd, ct);

        return new TranscriptIngestResult(
            SummaryMemoryId: stored.Id,
            ExtractionJobId: Guid.NewGuid(), // populated when extractor wired (Phase 2)
            ExtractedCount: 0,
            ClientScrubHits: cmd.ClientScrubHits,
            ServerScrubHits: serverHits,
            QueuedExtractionTypes: ["decision", "fact", "lesson", "event"]);
    }

    private static string[] BuildTags(string evt) => evt switch
    {
        "pre_compact"   => ["claude-code", "pre-compact", "session-digest"],
        "session_end"   => ["claude-code", "session-summary"],
        "subagent_stop" => ["claude-code", "subagent", "session-digest"],
        _               => ["claude-code"],
    };
}
```

- [ ] **Step 5: Run tests; expect PASS**

Run: `dotnet test --filter "FullyQualifiedName~TranscriptIngestServiceTests"`
Expected: PASS — 2 cases green.

- [ ] **Step 6: Commit**

```bash
git add src/AstraMemory.Application/Features/TranscriptIngest/ITranscriptIngestService.cs \
        src/AstraMemory.Application/Features/TranscriptIngest/TranscriptIngestService.cs \
        tests/AstraMemory.Tests/TranscriptIngest/TranscriptIngestServiceTests.cs
git commit -m "feat(api): TranscriptIngestService stores scrubbed digest as summary memory"
```

---

### Task 1.5: Controller + DI wiring

**Files:**
- Create: `src/AstraMemory.Api/Controllers/TranscriptIngestController.cs`
- Modify: `src/AstraMemory.Application/DependencyInjection.cs`
- Create: `tests/AstraMemory.Tests/Controllers/TranscriptIngestControllerTests.cs`

- [ ] **Step 1: Write failing controller test**

Create `tests/AstraMemory.Tests/Controllers/TranscriptIngestControllerTests.cs`:

```csharp
using System.Net;
using System.Net.Http.Json;
using AstraMemory.Api.Models;
using AstraMemory.Tests.Fixtures;
using FluentAssertions;
using Xunit;

namespace AstraMemory.Tests.Controllers;

public sealed class TranscriptIngestControllerTests(WebFactory factory)
    : IClassFixture<WebFactory>
{
    private readonly HttpClient _client = factory.CreateAuthenticatedClient();

    [Fact]
    public async Task Post_ingest_transcript_returns_200_with_summary_id()
    {
        var body = new IngestTranscriptRequest(
            Event: "pre_compact",
            ProjectId: "test-project",
            SessionId: "sess-1",
            AgentType: null,
            Cwd: "/tmp/x",
            CapturedAt: DateTimeOffset.UtcNow,
            Turns: [
                new("user", "what does FEAT-172 do", null),
                new("assistant", "ships the M2E auth fix", null),
            ],
            ClientScrubApplied: true,
            ClientScrubHits: 0,
            ClientVersion: "0.3.0");

        var resp = await _client.PostAsJsonAsync("/ingest/transcript", body);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var payload = await resp.Content.ReadFromJsonAsync<IngestTranscriptResponse>();
        payload!.SummaryMemoryId.Should().NotBe(Guid.Empty);
        payload.QueuedExtractionTypes.Should().Contain("decision");
    }

    [Fact]
    public async Task Post_ingest_transcript_returns_422_for_unknown_event()
    {
        var body = new IngestTranscriptRequest(
            Event: "bogus", ProjectId: null, SessionId: "s", AgentType: null,
            Cwd: null, CapturedAt: null,
            Turns: [new("user", "x", null)],
            ClientScrubApplied: null, ClientScrubHits: null, ClientVersion: null);

        var resp = await _client.PostAsJsonAsync("/ingest/transcript", body);

        resp.StatusCode.Should().BeOneOf(HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity);
    }
}
```

If `WebFactory` and `CreateAuthenticatedClient` patterns already exist in the test project, use them. Otherwise look at `tests/AstraMemory.Tests/Controllers/WebhookControllerTests.cs` for the bootstrapping pattern and adapt.

- [ ] **Step 2: Run; expect FAIL (no controller)**

Run: `dotnet test --filter "FullyQualifiedName~TranscriptIngestControllerTests"`
Expected: FAIL — 404 on the route.

- [ ] **Step 3: Create the controller**

Create `src/AstraMemory.Api/Controllers/TranscriptIngestController.cs`:

```csharp
using AstraMemory.Api.Middleware;
using AstraMemory.Api.Models;
using AstraMemory.Application.Features.TranscriptIngest;
using Microsoft.AspNetCore.Mvc;

namespace AstraMemory.Api.Controllers;

[ApiController]
[Route("ingest/transcript")]
public sealed class TranscriptIngestController(ITranscriptIngestService service) : ControllerBase
{
    private const int MaxTurns = 200;
    private const int MaxTextBytes = 8 * 1024;

    [HttpPost]
    public async Task<IActionResult> Post(
        [FromBody] IngestTranscriptRequest req,
        [FromHeader(Name = "Idempotency-Key")] string? idempotencyKey,
        CancellationToken ct)
    {
        if (req is null) return BadRequest(new { error = "body required" });

        var tenant = HttpContext.GetTenantContext();

        // Reject ApiKey on this route; only Bearer is acceptable.
        if (string.Equals(tenant.AuthScheme, "ApiKey", StringComparison.OrdinalIgnoreCase))
            return Unauthorized(new { error = "unauthenticated", detail = "Bearer required on /ingest/transcript" });

        var turns = req.Turns ?? [];
        if (turns.Count == 0)
            return BadRequest(new { error = "turns required" });

        // Truncate to caps: keep newest by tail-slicing.
        if (turns.Count > MaxTurns)
            turns = turns.Skip(turns.Count - MaxTurns).ToList();

        var capped = turns.Select(t =>
        {
            var text = t.Text ?? string.Empty;
            if (System.Text.Encoding.UTF8.GetByteCount(text) > MaxTextBytes)
            {
                // Byte-cap by char approximation; full UTF-8 truncation isn't worth the complexity here.
                text = text[..Math.Min(text.Length, MaxTextBytes)] + "…[truncated]";
            }
            return new TranscriptIngestTurn(t.Role, text, t.Ts);
        }).ToList();

        var cmd = new TranscriptIngestCommand(
            Event: req.Event,
            SessionId: req.SessionId,
            ProjectId: req.ProjectId,
            AgentType: req.AgentType,
            Cwd: req.Cwd,
            CapturedAt: req.CapturedAt,
            Turns: capped,
            ClientScrubApplied: req.ClientScrubApplied ?? false,
            ClientScrubHits: req.ClientScrubHits ?? 0,
            ClientVersion: req.ClientVersion,
            IdempotencyKey: idempotencyKey);

        var result = await service.IngestAsync(tenant, cmd, ct);

        return Ok(new IngestTranscriptResponse(
            SummaryMemoryId: result.SummaryMemoryId,
            ExtractionJobId: result.ExtractionJobId,
            ExtractedCount: result.ExtractedCount,
            ScrubHits: new ScrubHits(result.ClientScrubHits, result.ServerScrubHits),
            QueuedExtractionTypes: result.QueuedExtractionTypes));
    }
}
```

If `TenantContext.AuthScheme` does not exist, grep the codebase for the existing way to distinguish ApiKey vs Bearer auth and use that; otherwise add an `AuthScheme` property to `TenantContext` as a follow-on task before this one. Verify by running `grep -rn "AuthScheme" src/AstraMemory.Domain src/AstraMemory.Api` and adapt to whatever already exists.

- [ ] **Step 4: Register service in DI**

Modify `src/AstraMemory.Application/DependencyInjection.cs`. Add the two registrations inside the existing `AddApplication` (or equivalent) extension method:

```csharp
services.AddSingleton<AstraMemory.Application.Features.TranscriptIngest.IdempotencyCache>();
services.AddScoped<
    AstraMemory.Application.Features.TranscriptIngest.ITranscriptIngestService,
    AstraMemory.Application.Features.TranscriptIngest.TranscriptIngestService>();
```

Read the current `DependencyInjection.cs` first to land the lines in the right spot. If the project uses a different DI surface (e.g. `AddInfrastructure` in a different file), register them there instead.

- [ ] **Step 5: Run tests; expect PASS**

Run: `dotnet test --filter "FullyQualifiedName~TranscriptIngestControllerTests"`
Expected: PASS — both cases green.

- [ ] **Step 6: Commit**

```bash
git add src/AstraMemory.Api/Controllers/TranscriptIngestController.cs \
        src/AstraMemory.Application/DependencyInjection.cs \
        tests/AstraMemory.Tests/Controllers/TranscriptIngestControllerTests.cs
git commit -m "feat(api): TranscriptIngestController POST /ingest/transcript"
```

---

### Task 1.6: Idempotency on controller

**Files:**
- Modify: `src/AstraMemory.Api/Controllers/TranscriptIngestController.cs`
- Modify: `src/AstraMemory.Application/Features/TranscriptIngest/TranscriptIngestService.cs`
- Modify: `tests/AstraMemory.Tests/Controllers/TranscriptIngestControllerTests.cs`

- [ ] **Step 1: Add the idempotency test**

Append to `TranscriptIngestControllerTests.cs`:

```csharp
[Fact]
public async Task Post_replays_response_when_idempotency_key_matches()
{
    var body = new IngestTranscriptRequest(
        "pre_compact", "p", "sess-idem", null, null, DateTimeOffset.UtcNow,
        [new("user", "x", null)], true, 0, "0.3.0");

    using var req1 = new HttpRequestMessage(HttpMethod.Post, "/ingest/transcript")
    {
        Content = JsonContent.Create(body),
    };
    req1.Headers.Add("Idempotency-Key", "abc-1");
    var r1 = await _client.SendAsync(req1);
    r1.StatusCode.Should().Be(HttpStatusCode.OK);
    var p1 = await r1.Content.ReadFromJsonAsync<IngestTranscriptResponse>();

    using var req2 = new HttpRequestMessage(HttpMethod.Post, "/ingest/transcript")
    {
        Content = JsonContent.Create(body),
    };
    req2.Headers.Add("Idempotency-Key", "abc-1");
    var r2 = await _client.SendAsync(req2);
    var p2 = await r2.Content.ReadFromJsonAsync<IngestTranscriptResponse>();

    p2!.SummaryMemoryId.Should().Be(p1!.SummaryMemoryId);
}
```

- [ ] **Step 2: Run; expect FAIL (second call returns different id)**

Run: `dotnet test --filter "FullyQualifiedName~Post_replays_response_when_idempotency_key_matches"`
Expected: FAIL.

- [ ] **Step 3: Wire idempotency in service**

In `TranscriptIngestService.IngestAsync`, before the scrub loop:

```csharp
var cacheKey = !string.IsNullOrEmpty(cmd.IdempotencyKey)
    ? $"{tenant.TenantId}:{cmd.IdempotencyKey}"
    : null;

if (cacheKey is not null && idempotency.TryGet(cacheKey, out var cached) && cached is not null)
{
    return System.Text.Json.JsonSerializer.Deserialize<TranscriptIngestResult>(cached)!;
}
```

Right before the return:

```csharp
var result = new TranscriptIngestResult( /* existing fields */ );
if (cacheKey is not null)
    idempotency.Store(cacheKey, System.Text.Json.JsonSerializer.Serialize(result));
return result;
```

(Refactor: stop constructing the result inline in the return statement; build it in a local first so it can be cached then returned.)

- [ ] **Step 4: Run tests; expect PASS**

Run: `dotnet test --filter "FullyQualifiedName~TranscriptIngestControllerTests"`
Expected: PASS — all 3 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/AstraMemory.Application/Features/TranscriptIngest/TranscriptIngestService.cs \
        tests/AstraMemory.Tests/Controllers/TranscriptIngestControllerTests.cs
git commit -m "feat(api): idempotency-key replay on /ingest/transcript"
```

---

## Phase 2 — Server extractor + graph linker

### Task 2.1: `ITranscriptExtractor` + impl with prompt + JSON parse

**Files:**
- Create: `src/AstraMemory.Domain/Interfaces/ITranscriptExtractor.cs`
- Create: `src/AstraMemory.Infrastructure/Services/TranscriptExtractor.cs`
- Create: `tests/AstraMemory.Tests/TranscriptIngest/TranscriptExtractorTests.cs`

- [ ] **Step 1: Define interface**

Create `src/AstraMemory.Domain/Interfaces/ITranscriptExtractor.cs`:

```csharp
namespace AstraMemory.Domain.Interfaces;

public interface ITranscriptExtractor
{
    Task<IReadOnlyList<ExtractedAtom>> ExtractAsync(
        string content, CancellationToken ct = default);
}

public sealed record ExtractedAtom(
    string Type,           // decision | fact | lesson | event
    string Title,
    string Content,
    double Importance,
    IReadOnlyList<string> EntityRefs,
    string? SupersedesHint);
```

- [ ] **Step 2: Write failing parse + dispatch tests**

Create `tests/AstraMemory.Tests/TranscriptIngest/TranscriptExtractorTests.cs`:

```csharp
using Astra.Core.LLM;
using AstraMemory.Domain.Interfaces;
using AstraMemory.Infrastructure.Services;
using FluentAssertions;
using NSubstitute;
using Xunit;

namespace AstraMemory.Tests.TranscriptIngest;

public sealed class TranscriptExtractorTests
{
    [Fact]
    public async Task ExtractAsync_returns_empty_when_llm_unavailable()
    {
        var llm = Substitute.For<ILlmCompletionProvider>();
        llm.IsAvailable.Returns(false);
        var sut = new TranscriptExtractor(llm);

        var result = await sut.ExtractAsync("anything", CancellationToken.None);

        result.Should().BeEmpty();
    }

    [Fact]
    public async Task ExtractAsync_parses_well_formed_json()
    {
        var llm = Substitute.For<ILlmCompletionProvider>();
        llm.IsAvailable.Returns(true);
        llm.CompleteAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
           .Returns("""
                [{"type":"decision","title":"Use Bearer for ingest",
                  "content":"We chose Bearer over ApiKey because the gateway enforces JwtOrApiKey and per-user scoping matters.",
                  "importance":0.85,"entity_refs":["FEAT-172"],"supersedes_hint":null}]
                """);
        var sut = new TranscriptExtractor(llm);

        var result = await sut.ExtractAsync("conversation text", CancellationToken.None);

        result.Should().HaveCount(1);
        result[0].Type.Should().Be("decision");
        result[0].EntityRefs.Should().ContainSingle().Which.Should().Be("FEAT-172");
        result[0].Importance.Should().BeApproximately(0.85, 0.001);
    }

    [Fact]
    public async Task ExtractAsync_drops_items_with_unknown_type()
    {
        var llm = Substitute.For<ILlmCompletionProvider>();
        llm.IsAvailable.Returns(true);
        llm.CompleteAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
           .Returns("""
                [{"type":"adr","title":"x","content":"y","importance":0.5,"entity_refs":[]},
                 {"type":"fact","title":"endpoint /ingest/transcript","content":"new in v0.3.0","importance":0.8,"entity_refs":[]}]
                """);
        var sut = new TranscriptExtractor(llm);

        var result = await sut.ExtractAsync("c", CancellationToken.None);

        result.Should().HaveCount(1);
        result[0].Type.Should().Be("fact");
    }

    [Fact]
    public async Task ExtractAsync_returns_empty_on_malformed_json()
    {
        var llm = Substitute.For<ILlmCompletionProvider>();
        llm.IsAvailable.Returns(true);
        llm.CompleteAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
           .Returns("not json at all");
        var sut = new TranscriptExtractor(llm);

        var result = await sut.ExtractAsync("c", CancellationToken.None);

        result.Should().BeEmpty();
    }
}
```

- [ ] **Step 3: Run; expect FAIL**

Run: `dotnet test --filter "FullyQualifiedName~TranscriptExtractorTests"`
Expected: FAIL — `TranscriptExtractor` undefined.

- [ ] **Step 4: Implement extractor**

Create `src/AstraMemory.Infrastructure/Services/TranscriptExtractor.cs`:

```csharp
using System.Text.Json;
using Astra.Core.LLM;
using AstraMemory.Domain.Interfaces;

namespace AstraMemory.Infrastructure.Services;

public sealed class TranscriptExtractor(ILlmCompletionProvider llm) : ITranscriptExtractor
{
    private static readonly HashSet<string> AllowedTypes =
        new(StringComparer.Ordinal) { "decision", "fact", "lesson", "event" };

    private const string SystemPrompt = """
        You extract durable engineering memory from a developer's chat transcript with an AI assistant.
        Identify and emit JSON array of items, each one of these types:

        - "decision": a deliberate choice with rationale. "We chose X over Y because Z."
                        Includes ADR-style architecture choices, library picks, scope cuts.
        - "fact":     a stable repo/system truth worth remembering. Endpoints, paths,
                        config values, who-owns-what, versions. NOT ephemeral state.
        - "lesson":   a learning from failure or surprise.
        - "event":    a time-bound milestone. Releases, renames, deletions, merges, incidents.

        For each item return:
        {
          "type": "decision|fact|lesson|event",
          "title": "<=100 chars",
          "content": "1-3 paragraphs, self-contained",
          "importance": 0.0..1.0,
          "entity_refs": ["FEAT-172", "PR-#14", "SPEC-002", "src/foo.cs"],
          "supersedes_hint": "free-text or null"
        }

        Rules:
        - Skip ephemeral chatter, tool output, error stack traces unless they map to a lesson.
        - Skip secrets, API keys, personal data.
        - Prefer 0 high-quality items over 10 weak items. Empty array is fine.
        - Each item must stand alone.
        Return only the JSON array.
        """;

    public async Task<IReadOnlyList<ExtractedAtom>> ExtractAsync(string content, CancellationToken ct = default)
    {
        if (!llm.IsAvailable || string.IsNullOrWhiteSpace(content)) return [];

        var raw = await llm.CompleteAsync(SystemPrompt, content, ct);
        return Parse(raw);
    }

    internal static IReadOnlyList<ExtractedAtom> Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return [];

            var result = new List<ExtractedAtom>();
            foreach (var item in doc.RootElement.EnumerateArray())
            {
                var type = item.TryGetProperty("type", out var t) ? t.GetString() : null;
                if (type is null || !AllowedTypes.Contains(type)) continue;

                var title = item.TryGetProperty("title", out var ti) ? ti.GetString() ?? "" : "";
                if (string.IsNullOrWhiteSpace(title)) continue;

                var contentField = item.TryGetProperty("content", out var c) ? c.GetString() ?? "" : "";
                var importance = item.TryGetProperty("importance", out var i) && i.ValueKind == JsonValueKind.Number
                    ? i.GetDouble() : 0.5;

                var refs = new List<string>();
                if (item.TryGetProperty("entity_refs", out var er) && er.ValueKind == JsonValueKind.Array)
                {
                    foreach (var r in er.EnumerateArray())
                    {
                        var s = r.GetString();
                        if (!string.IsNullOrWhiteSpace(s)) refs.Add(s);
                    }
                }

                string? sup = null;
                if (item.TryGetProperty("supersedes_hint", out var sh) && sh.ValueKind == JsonValueKind.String)
                    sup = sh.GetString();

                result.Add(new ExtractedAtom(type, title, contentField, importance, refs, sup));
            }
            return result;
        }
        catch (JsonException) { return []; }
    }
}
```

- [ ] **Step 5: Run tests; expect PASS**

Run: `dotnet test --filter "FullyQualifiedName~TranscriptExtractorTests"`
Expected: PASS — 4 cases green.

- [ ] **Step 6: Commit**

```bash
git add src/AstraMemory.Domain/Interfaces/ITranscriptExtractor.cs \
        src/AstraMemory.Infrastructure/Services/TranscriptExtractor.cs \
        tests/AstraMemory.Tests/TranscriptIngest/TranscriptExtractorTests.cs
git commit -m "feat(api): TranscriptExtractor emits decision/fact/lesson/event atoms"
```

---

### Task 2.2: `IMemoryGraphLinker` — entity-ref pass

**Files:**
- Create: `src/AstraMemory.Domain/Interfaces/IMemoryGraphLinker.cs`
- Create: `src/AstraMemory.Infrastructure/Services/MemoryGraphLinker.cs`
- Create: `tests/AstraMemory.Tests/TranscriptIngest/MemoryGraphLinkerTests.cs`

The linker is built in two sub-passes: entity-refs here, similarity + supersedes in 2.3.

- [ ] **Step 1: Define interface**

Create `src/AstraMemory.Domain/Interfaces/IMemoryGraphLinker.cs`:

```csharp
namespace AstraMemory.Domain.Interfaces;

public interface IMemoryGraphLinker
{
    Task LinkAsync(
        Guid tenantId,
        Guid newMemoryId,
        string? projectId,
        IReadOnlyList<string> entityRefs,
        string? supersedesHint,
        CancellationToken ct = default);
}
```

- [ ] **Step 2: Write failing test for entity-ref edge writes**

Create `tests/AstraMemory.Tests/TranscriptIngest/MemoryGraphLinkerTests.cs`:

```csharp
using AstraMemory.Domain.Interfaces;
using AstraMemory.Infrastructure.Services;
using FluentAssertions;
using NSubstitute;
using Xunit;

namespace AstraMemory.Tests.TranscriptIngest;

public sealed class MemoryGraphLinkerTests
{
    [Fact]
    public async Task LinkAsync_writes_mentions_edges_for_each_resolved_entity_ref()
    {
        var lookup = Substitute.For<IMemoryReferenceLookup>();
        var graph = Substitute.For<IMemoryGraphService>();
        var tenantId = Guid.NewGuid();
        var newMemoryId = Guid.NewGuid();
        var feat172Id = Guid.NewGuid();
        var spec002Id = Guid.NewGuid();

        lookup.FindByReferenceAsync(tenantId, "FEAT-172", Arg.Any<CancellationToken>())
              .Returns([feat172Id]);
        lookup.FindByReferenceAsync(tenantId, "SPEC-002", Arg.Any<CancellationToken>())
              .Returns([spec002Id]);

        var sut = new MemoryGraphLinker(graph, lookup,
            similarity: new NullSimilarityProvider());

        await sut.LinkAsync(tenantId, newMemoryId, "p1",
            entityRefs: ["FEAT-172", "SPEC-002"], supersedesHint: null,
            CancellationToken.None);

        await graph.Received().UpsertEdgeAsync(
            Arg.Is<UpsertEdgeCommand>(e =>
                e.SourceId == newMemoryId && e.TargetId == feat172Id &&
                e.RelationshipType == "mentions"),
            Arg.Any<CancellationToken>());
        await graph.Received().UpsertEdgeAsync(
            Arg.Is<UpsertEdgeCommand>(e =>
                e.SourceId == newMemoryId && e.TargetId == spec002Id &&
                e.RelationshipType == "mentions"),
            Arg.Any<CancellationToken>());
    }
}
```

This test depends on `IMemoryReferenceLookup` and `NullSimilarityProvider` types that we define in the next step. Compilation will fail at first — that's expected for a TDD red.

- [ ] **Step 3: Run; expect FAIL**

Run: `dotnet test --filter "FullyQualifiedName~MemoryGraphLinkerTests"`
Expected: FAIL — `MemoryGraphLinker` / `IMemoryReferenceLookup` / `NullSimilarityProvider` undefined.

- [ ] **Step 4: Implement entity-ref lookup + linker skeleton**

Create `src/AstraMemory.Domain/Interfaces/IMemoryReferenceLookup.cs`:

```csharp
namespace AstraMemory.Domain.Interfaces;

public interface IMemoryReferenceLookup
{
    /// Look up memory ids that mention the given reference string in their title or content.
    Task<IReadOnlyList<Guid>> FindByReferenceAsync(
        Guid tenantId, string reference, CancellationToken ct = default);
}
```

The concrete EF Core implementation (`MemoryReferenceLookup`) is wired in Task 2.5. The linker accepts the interface so it remains testable.

Create `src/AstraMemory.Infrastructure/Services/MemoryGraphLinker.cs` (entity-ref pass only; similarity + supersedes added in 2.3):

```csharp
using AstraMemory.Domain.Interfaces;

namespace AstraMemory.Infrastructure.Services;

public interface ISimilarityProvider
{
    Task<IReadOnlyList<(Guid Id, float Score)>> NeighborsAsync(
        Guid tenantId, Guid sourceMemoryId, string? projectId, int topN, float threshold, CancellationToken ct);
    Task<IReadOnlyList<(Guid Id, float Score)>> NeighborsForTextAsync(
        Guid tenantId, string text, string? projectId, int topN, float threshold, CancellationToken ct);
}

public sealed class NullSimilarityProvider : ISimilarityProvider
{
    public Task<IReadOnlyList<(Guid Id, float Score)>> NeighborsAsync(
        Guid tenantId, Guid sourceMemoryId, string? projectId, int topN, float threshold, CancellationToken ct)
        => Task.FromResult<IReadOnlyList<(Guid, float)>>([]);
    public Task<IReadOnlyList<(Guid Id, float Score)>> NeighborsForTextAsync(
        Guid tenantId, string text, string? projectId, int topN, float threshold, CancellationToken ct)
        => Task.FromResult<IReadOnlyList<(Guid, float)>>([]);
}

public sealed class MemoryGraphLinker(
    IMemoryGraphService graph,
    IMemoryReferenceLookup lookup,
    ISimilarityProvider similarity) : IMemoryGraphLinker
{
    private const float RelatesToThreshold = 0.82f;
    private const float SupersedesThreshold = 0.78f;
    private const int RelatedTopN = 5;

    public async Task LinkAsync(
        Guid tenantId, Guid newMemoryId, string? projectId,
        IReadOnlyList<string> entityRefs, string? supersedesHint, CancellationToken ct = default)
    {
        await LinkEntityRefsAsync(tenantId, newMemoryId, entityRefs, ct);
        // similarity + supersedes added in Task 2.3
    }

    private async Task LinkEntityRefsAsync(
        Guid tenantId, Guid newMemoryId, IReadOnlyList<string> refs, CancellationToken ct)
    {
        foreach (var raw in refs)
        {
            if (string.IsNullOrWhiteSpace(raw)) continue;
            var matches = await lookup.FindByReferenceAsync(tenantId, raw, ct);
            foreach (var targetId in matches)
            {
                if (targetId == newMemoryId) continue;
                await graph.UpsertEdgeAsync(
                    new UpsertEdgeCommand(newMemoryId, targetId, tenantId, "mentions", 1.0f),
                    ct);
            }
        }
    }
}
```

- [ ] **Step 5: Run tests; expect PASS**

Run: `dotnet test --filter "FullyQualifiedName~MemoryGraphLinkerTests"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/AstraMemory.Domain/Interfaces/IMemoryGraphLinker.cs \
        src/AstraMemory.Domain/Interfaces/IMemoryReferenceLookup.cs \
        src/AstraMemory.Infrastructure/Services/MemoryGraphLinker.cs \
        tests/AstraMemory.Tests/TranscriptIngest/MemoryGraphLinkerTests.cs
git commit -m "feat(api): MemoryGraphLinker entity-ref pass writes mentions edges"
```

---

### Task 2.3: Linker — similarity (`relates_to`) + supersedes passes

**Files:**
- Modify: `src/AstraMemory.Infrastructure/Services/MemoryGraphLinker.cs`
- Modify: `tests/AstraMemory.Tests/TranscriptIngest/MemoryGraphLinkerTests.cs`

- [ ] **Step 1: Add failing tests**

Append to `MemoryGraphLinkerTests.cs`:

```csharp
[Fact]
public async Task LinkAsync_writes_relates_to_edges_above_cosine_082()
{
    var lookup = Substitute.For<IMemoryReferenceLookup>();
    var graph = Substitute.For<IMemoryGraphService>();
    var sim = Substitute.For<ISimilarityProvider>();

    var tenantId = Guid.NewGuid();
    var newId = Guid.NewGuid();
    var hitId = Guid.NewGuid();
    var lowId = Guid.NewGuid();

    sim.NeighborsAsync(tenantId, newId, "p", 5, 0.82f, Arg.Any<CancellationToken>())
       .Returns([(hitId, 0.91f), (lowId, 0.65f)]);

    var sut = new MemoryGraphLinker(graph, lookup, sim);

    await sut.LinkAsync(tenantId, newId, "p", entityRefs: [], supersedesHint: null, CancellationToken.None);

    await graph.Received().UpsertEdgeAsync(
        Arg.Is<UpsertEdgeCommand>(e =>
            e.SourceId == newId && e.TargetId == hitId &&
            e.RelationshipType == "relates_to" && e.Strength >= 0.82f),
        Arg.Any<CancellationToken>());

    await graph.DidNotReceive().UpsertEdgeAsync(
        Arg.Is<UpsertEdgeCommand>(e => e.TargetId == lowId),
        Arg.Any<CancellationToken>());
}

[Fact]
public async Task LinkAsync_writes_supersedes_edge_when_hint_matches_above_078()
{
    var lookup = Substitute.For<IMemoryReferenceLookup>();
    var graph = Substitute.For<IMemoryGraphService>();
    var sim = Substitute.For<ISimilarityProvider>();
    var tenantId = Guid.NewGuid();
    var newId = Guid.NewGuid();
    var priorId = Guid.NewGuid();

    sim.NeighborsForTextAsync(tenantId, "old api-key auth", "p", 1, 0.78f, Arg.Any<CancellationToken>())
       .Returns([(priorId, 0.84f)]);

    var sut = new MemoryGraphLinker(graph, lookup, sim);

    await sut.LinkAsync(tenantId, newId, "p", entityRefs: [],
        supersedesHint: "old api-key auth", CancellationToken.None);

    await graph.Received().UpsertEdgeAsync(
        Arg.Is<UpsertEdgeCommand>(e =>
            e.SourceId == newId && e.TargetId == priorId &&
            e.RelationshipType == "supersedes"),
        Arg.Any<CancellationToken>());
}

[Fact]
public async Task LinkAsync_skips_supersedes_when_hint_is_null_or_low_confidence()
{
    var lookup = Substitute.For<IMemoryReferenceLookup>();
    var graph = Substitute.For<IMemoryGraphService>();
    var sim = Substitute.For<ISimilarityProvider>();
    sim.NeighborsForTextAsync(Arg.Any<Guid>(), Arg.Any<string>(), Arg.Any<string>(), 1, 0.78f, Arg.Any<CancellationToken>())
       .Returns([]);

    var sut = new MemoryGraphLinker(graph, lookup, sim);

    await sut.LinkAsync(Guid.NewGuid(), Guid.NewGuid(), "p", [], null, CancellationToken.None);
    await sut.LinkAsync(Guid.NewGuid(), Guid.NewGuid(), "p", [], "some hint", CancellationToken.None);

    await graph.DidNotReceive().UpsertEdgeAsync(
        Arg.Is<UpsertEdgeCommand>(e => e.RelationshipType == "supersedes"),
        Arg.Any<CancellationToken>());
}
```

- [ ] **Step 2: Run; expect FAIL**

Run: `dotnet test --filter "FullyQualifiedName~MemoryGraphLinkerTests"`
Expected: FAIL on the 3 new tests.

- [ ] **Step 3: Extend `MemoryGraphLinker.LinkAsync`**

Replace the body of `LinkAsync`:

```csharp
public async Task LinkAsync(
    Guid tenantId, Guid newMemoryId, string? projectId,
    IReadOnlyList<string> entityRefs, string? supersedesHint, CancellationToken ct = default)
{
    await LinkEntityRefsAsync(tenantId, newMemoryId, entityRefs, ct);
    await LinkSimilarAsync(tenantId, newMemoryId, projectId, ct);
    await LinkSupersedesAsync(tenantId, newMemoryId, projectId, supersedesHint, ct);
}

private async Task LinkSimilarAsync(Guid tenantId, Guid newMemoryId, string? projectId, CancellationToken ct)
{
    var neighbors = await similarity.NeighborsAsync(tenantId, newMemoryId, projectId, RelatedTopN, RelatesToThreshold, ct);
    foreach (var (id, score) in neighbors)
    {
        if (id == newMemoryId) continue;
        if (score < RelatesToThreshold) continue;
        await graph.UpsertEdgeAsync(
            new UpsertEdgeCommand(newMemoryId, id, tenantId, "relates_to", score), ct);
    }
}

private async Task LinkSupersedesAsync(
    Guid tenantId, Guid newMemoryId, string? projectId, string? hint, CancellationToken ct)
{
    if (string.IsNullOrWhiteSpace(hint)) return;
    var top = await similarity.NeighborsForTextAsync(tenantId, hint, projectId, 1, SupersedesThreshold, ct);
    if (top.Count == 0) return;
    var (priorId, score) = top[0];
    if (priorId == newMemoryId || score < SupersedesThreshold) return;
    await graph.UpsertEdgeAsync(
        new UpsertEdgeCommand(newMemoryId, priorId, tenantId, "supersedes", score), ct);
}
```

- [ ] **Step 4: Run tests; expect PASS**

Run: `dotnet test --filter "FullyQualifiedName~MemoryGraphLinkerTests"`
Expected: PASS — all 4 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/AstraMemory.Infrastructure/Services/MemoryGraphLinker.cs \
        tests/AstraMemory.Tests/TranscriptIngest/MemoryGraphLinkerTests.cs
git commit -m "feat(api): MemoryGraphLinker similarity + supersedes passes"
```

---

### Task 2.4: Wire extractor + linker into `TranscriptIngestService`

**Files:**
- Modify: `src/AstraMemory.Application/Features/TranscriptIngest/TranscriptIngestService.cs`
- Modify: `tests/AstraMemory.Tests/TranscriptIngest/TranscriptIngestServiceTests.cs`

- [ ] **Step 1: Add failing test for extracted memories + edges**

Append to `TranscriptIngestServiceTests.cs`:

```csharp
[Fact]
public async Task IngestAsync_invokes_extractor_and_writes_extracted_atoms_with_graph_edges()
{
    var writer = Substitute.For<IMemoryWriteService>();
    writer.StoreAsync(Arg.Any<TenantContext>(), Arg.Any<MemoryWriteService.StoreCommand>(), Arg.Any<CancellationToken>())
          .Returns(call => new MemoryWriteService.StoreResult(Guid.NewGuid(), "active", false, DateTimeOffset.UtcNow));

    var extractor = Substitute.For<ITranscriptExtractor>();
    extractor.ExtractAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
             .Returns([new ExtractedAtom(
                 "decision", "Use Bearer for ingest",
                 "We chose Bearer over ApiKey ...",
                 Importance: 0.85,
                 EntityRefs: ["FEAT-172"], SupersedesHint: null)]);

    var linker = Substitute.For<IMemoryGraphLinker>();

    var sut = new TranscriptIngestService(writer, new IdempotencyCache(), extractor, linker);
    var tenant = new TenantContext(Guid.NewGuid(), Guid.NewGuid(), "tier1", false);

    var result = await sut.IngestAsync(
        tenant,
        new TranscriptIngestCommand("pre_compact", "s1", "p1", null, null, null,
            [new("user", "we chose Bearer over ApiKey because gateway requires it", null)],
            true, 0, "0.3.0", null),
        CancellationToken.None);

    result.ExtractedCount.Should().Be(1);
    // 1 summary + 1 atom = 2 writes.
    await writer.Received(2).StoreAsync(Arg.Any<TenantContext>(), Arg.Any<MemoryWriteService.StoreCommand>(), Arg.Any<CancellationToken>());
    // Linker called once per extracted atom.
    await linker.Received(1).LinkAsync(
        tenant.TenantId,
        Arg.Any<Guid>(),
        "p1",
        Arg.Is<IReadOnlyList<string>>(l => l.Count == 1 && l[0] == "FEAT-172"),
        null,
        Arg.Any<CancellationToken>());
}
```

- [ ] **Step 2: Update existing tests to pass the new constructor args**

Locate the existing two tests in `TranscriptIngestServiceTests.cs` and change their `new TranscriptIngestService(writer, new IdempotencyCache())` calls to:

```csharp
new TranscriptIngestService(
    writer,
    new IdempotencyCache(),
    Substitute.For<ITranscriptExtractor>(),
    Substitute.For<IMemoryGraphLinker>())
```

- [ ] **Step 3: Run; expect FAIL (constructor signature wrong)**

Run: `dotnet test --filter "FullyQualifiedName~TranscriptIngestServiceTests"`
Expected: FAIL — `TranscriptIngestService` constructor mismatch.

- [ ] **Step 4: Extend service**

Change the constructor of `TranscriptIngestService`:

```csharp
public sealed class TranscriptIngestService(
    IMemoryWriteService writer,
    IdempotencyCache idempotency,
    AstraMemory.Domain.Interfaces.ITranscriptExtractor extractor,
    AstraMemory.Domain.Interfaces.IMemoryGraphLinker linker) : ITranscriptIngestService
```

After `var stored = await writer.StoreAsync(tenant, storeCmd, ct);` add:

```csharp
var atoms = await extractor.ExtractAsync(sb.ToString(), ct);
var extractedCount = 0;

foreach (var atom in atoms)
{
    var autoAccept = atom.Type is "decision" or "fact" or "event"
        && atom.Importance >= 0.7
        && atom.EntityRefs.Count > 0;

    var atomCmd = new MemoryWriteService.StoreCommand(
        Content: atom.Content,
        Type: atom.Type,
        Scope: "private",
        Importance: atom.Importance,
        AgentId: cmd.AgentType,
        ProjectId: cmd.ProjectId,
        SessionId: cmd.SessionId,
        ExpiresAt: null,
        Metadata: new Dictionary<string, object>
        {
            ["title"] = atom.Title,
            ["entity_refs"] = atom.EntityRefs,
            ["extracted_from"] = stored.Id,
        },
        Source: $"claude-code-{cmd.Event}-extract",
        Tags: ["claude-code", "extracted", atom.Type],
        Status: autoAccept ? "active" : "pending");

    var atomStored = await writer.StoreAsync(tenant, atomCmd, ct);

    if (atomStored.ErrorStatus == 0)
    {
        extractedCount++;
        await linker.LinkAsync(
            tenant.TenantId, atomStored.Id, cmd.ProjectId,
            atom.EntityRefs, atom.SupersedesHint, ct);
    }
}
```

Update the `TranscriptIngestResult` construction to set `ExtractedCount = extractedCount`.

- [ ] **Step 5: Run tests; expect PASS**

Run: `dotnet test --filter "FullyQualifiedName~TranscriptIngestServiceTests"`
Expected: PASS — 3 cases green (original 2 + new extraction test).

- [ ] **Step 6: Commit**

```bash
git add src/AstraMemory.Application/Features/TranscriptIngest/TranscriptIngestService.cs \
        tests/AstraMemory.Tests/TranscriptIngest/TranscriptIngestServiceTests.cs
git commit -m "feat(api): wire TranscriptExtractor + MemoryGraphLinker into ingest service"
```

---

### Task 2.5: EF-Core `MemoryReferenceLookup` + `EmbeddingSimilarityProvider` + DI

**Files:**
- Create: `src/AstraMemory.Infrastructure/Services/MemoryReferenceLookup.cs`
- Create: `src/AstraMemory.Infrastructure/Services/EmbeddingSimilarityProvider.cs`
- Modify: `src/AstraMemory.Infrastructure/DependencyInjection.cs`

- [ ] **Step 1: Implement `MemoryReferenceLookup`**

Create `src/AstraMemory.Infrastructure/Services/MemoryReferenceLookup.cs`:

```csharp
using AstraMemory.Domain.Interfaces;
using AstraMemory.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;

namespace AstraMemory.Infrastructure.Services;

internal sealed class MemoryReferenceLookup(MemoryContext db) : IMemoryReferenceLookup
{
    public async Task<IReadOnlyList<Guid>> FindByReferenceAsync(
        Guid tenantId, string reference, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(reference)) return [];

        // Use parameterised LIKE — both columns are indexed for trigram in the existing schema.
        var pattern = $"%{reference}%";

        return await db.Memories
            .AsNoTracking()
            .Where(m => m.TenantId == tenantId && (EF.Functions.ILike(m.Content, pattern)
                                                || EF.Functions.ILike(m.Source ?? "", pattern)))
            .Select(m => m.Id)
            .Take(20)
            .ToListAsync(ct);
    }
}
```

If the `Memories` DbSet or column names differ, adapt — run `grep -rn "class MemoryEntity" src/AstraMemory.Infrastructure` and use the live schema.

- [ ] **Step 2: Implement `EmbeddingSimilarityProvider`**

Create `src/AstraMemory.Infrastructure/Services/EmbeddingSimilarityProvider.cs`:

```csharp
using AstraMemory.Domain.Interfaces;

namespace AstraMemory.Infrastructure.Services;

internal sealed class EmbeddingSimilarityProvider(
    IMemoryGraphService graph,
    IEmbeddingProvider embedder) : ISimilarityProvider
{
    public async Task<IReadOnlyList<(Guid Id, float Score)>> NeighborsAsync(
        Guid tenantId, Guid sourceMemoryId, string? projectId, int topN, float threshold, CancellationToken ct)
    {
        // Reuse the existing API which already knows about embeddings stored on memories.
        var rows = await graph.FindSimilarNeighborsAsync(sourceMemoryId, tenantId, topN, threshold, ct);
        return rows;
    }

    public async Task<IReadOnlyList<(Guid Id, float Score)>> NeighborsForTextAsync(
        Guid tenantId, string text, string? projectId, int topN, float threshold, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(text)) return [];
        // Compute embedding for the free-text hint, then ask graph to find nearest neighbors.
        // The graph service exposes id-based search only; we approximate by embedding text and
        // delegating to a tenant-scoped vector query if available.
        // If the existing IMemoryGraphService has no text-based neighbor API, add an internal
        // helper here that queries pgvector directly via MemoryContext. For v1, fall back to
        // returning an empty list when the API can't be expressed; supersedes simply doesn't fire.
        return [];
    }
}
```

The `NeighborsForTextAsync` method is intentionally degraded for v1 to keep this task bounded: it requires a text-based vector query that may not exist on `IMemoryGraphService` yet. If a `Memories` table with an embedding column is queryable through `MemoryContext`, run `grep -rn "Embedding" src/AstraMemory.Infrastructure/Data/Entities` to confirm the column name, then add a follow-on micro-task to compute the embedding via `IEmbeddingProvider` and execute a `MemoryContext.Memories.OrderBy(... <-> @vec).Take(topN)` query. Without that follow-on, `supersedes` edges will not be written (graceful degradation) and the corresponding test in 2.3 keeps passing because it mocks the provider.

- [ ] **Step 3: Register in DI**

Modify `src/AstraMemory.Infrastructure/DependencyInjection.cs`. In the existing extension method (`AddInfrastructure` or equivalent) add:

```csharp
services.AddScoped<AstraMemory.Domain.Interfaces.ITranscriptExtractor,
                   AstraMemory.Infrastructure.Services.TranscriptExtractor>();
services.AddScoped<AstraMemory.Domain.Interfaces.IMemoryReferenceLookup,
                   AstraMemory.Infrastructure.Services.MemoryReferenceLookup>();
services.AddScoped<AstraMemory.Infrastructure.Services.ISimilarityProvider,
                   AstraMemory.Infrastructure.Services.EmbeddingSimilarityProvider>();
services.AddScoped<AstraMemory.Domain.Interfaces.IMemoryGraphLinker,
                   AstraMemory.Infrastructure.Services.MemoryGraphLinker>();
```

- [ ] **Step 4: Build + integration test once**

Run: `dotnet build` then `dotnet test tests/AstraMemory.Tests/AstraMemory.Tests.csproj`
Expected: full test suite green; no regressions from earlier controllers.

- [ ] **Step 5: Commit**

```bash
git add src/AstraMemory.Infrastructure/Services/MemoryReferenceLookup.cs \
        src/AstraMemory.Infrastructure/Services/EmbeddingSimilarityProvider.cs \
        src/AstraMemory.Infrastructure/DependencyInjection.cs
git commit -m "feat(api): wire infra implementations for extractor + linker"
```

---

## Phase 3 — Plugin client work

Plugin lives at `C:/work/mega/astramemory-plugin`. All paths below are relative to that root.

### Task 3.1: `_ingest-transcript.sh` helper with scrub + retry + Bearer

**Files:**
- Create: `hooks/scripts/_ingest-transcript.sh`
- Create: `tests/ingest-scrub.test.mjs`

- [ ] **Step 1: Write failing scrub test**

Create `tests/ingest-scrub.test.mjs`:

```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HELPER = join(process.cwd(), 'hooks', 'scripts', '_ingest-transcript.sh');

function runScrub(input) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-scrub-'));
  const inputFile = join(dir, 'in.txt');
  writeFileSync(inputFile, input);
  const r = spawnSync('bash', [HELPER, '--scrub-only', inputFile], {
    encoding: 'utf-8',
  });
  if (r.status !== 0) throw new Error(`scrub exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('redacts JWT', () => {
  const r = runScrub('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.Sf36POk6yJV_adQssw5c rest');
  assert.equal(r.hits, 1);
  assert.match(r.text, /\[redacted:jwt\]/);
});

test('redacts AWS key', () => {
  const r = runScrub('AKIAIOSFODNN7EXAMPLE inside');
  assert.equal(r.hits, 1);
  assert.match(r.text, /\[redacted:aws-key\]/);
});

test('redacts Anthropic key', () => {
  const r = runScrub('use sk-ant-api03-abcdefghijklmnopqrstuvwx for auth');
  assert.equal(r.hits, 1);
  assert.match(r.text, /\[redacted:anthropic-key\]/);
});

test('redacts generic api_key= patterns', () => {
  const r = runScrub('config: api_key=ABCDEF1234567890ABCDEF more');
  assert.equal(r.hits, 1);
});

test('passes innocuous text through', () => {
  const r = runScrub('the cosine threshold is 0.82 in MemoryGraphLinker');
  assert.equal(r.hits, 0);
  assert.equal(r.text, 'the cosine threshold is 0.82 in MemoryGraphLinker');
});
```

- [ ] **Step 2: Run; expect FAIL (helper does not exist)**

Run: `cd C:/work/mega/astramemory-plugin && node --test tests/ingest-scrub.test.mjs`
Expected: FAIL — helper script not found.

- [ ] **Step 3: Implement helper with scrub mode**

Create `hooks/scripts/_ingest-transcript.sh`:

```bash
#!/usr/bin/env bash
# Shared helper for AstraMemory transcript ingest hooks.
#
# Usage (production):
#   _ingest-transcript.sh --event pre_compact|session_end|subagent_stop \
#                         [--max-turns N] [--max-chars N]
#   Reads Claude Code hook payload (JSON) on stdin.
#   Always exits 0 (never block compaction / session close).
#
# Usage (test):
#   _ingest-transcript.sh --scrub-only <file>
#   Reads file content, prints JSON {"text": "...", "hits": N} to stdout.

set +e
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- scrub-only mode --------------------------------------------------------
if [ "${1:-}" = "--scrub-only" ]; then
  input="$(cat "${2:?scrub-only requires a file arg}")"
  hits=0

  scrub_pattern() {
    local pattern="$1" replacement="$2"
    # Count matches first, then substitute.
    local n
    n="$(printf '%s' "$input" | grep -oE "$pattern" | wc -l | tr -d ' ')"
    if [ "$n" -gt 0 ]; then
      hits=$((hits + n))
      input="$(printf '%s' "$input" | sed -E "s|$pattern|$replacement|g")"
    fi
  }

  scrub_pattern 'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+' '[redacted:jwt]'
  scrub_pattern 'AKIA[0-9A-Z]{16}'                                          '[redacted:aws-key]'
  scrub_pattern 'sk-(ant-)?[A-Za-z0-9_-]{20,}'                              '[redacted:anthropic-key]'
  scrub_pattern '(api[_-]?key|secret|password|token)[[:space:]]*[:=][[:space:]]*['"'"'"]?[A-Za-z0-9_./+=-]{16,}' '[redacted:generic-secret]'

  # JSON-safe output.
  printf '%s' "$input" | jq -Rs --argjson hits "$hits" '{text: ., hits: $hits}'
  exit 0
fi

# ---- production mode --------------------------------------------------------
. "$SCRIPT_DIR/_load-env.sh"

EVENT=""
MAX_TURNS=20
MAX_CHARS=12000
while [ $# -gt 0 ]; do
  case "$1" in
    --event)     EVENT="$2"; shift 2 ;;
    --max-turns) MAX_TURNS="$2"; shift 2 ;;
    --max-chars) MAX_CHARS="$2"; shift 2 ;;
    *)           shift ;;
  esac
done
[ -z "$EVENT" ] && exit 0

MEMORY_API_URL="${MEMORY_API_URL:-http://localhost:5201}"
RETRIES="${MEMORY_INGEST_RETRIES:-2}"
RETRY_SLEEP="${MEMORY_INGEST_RETRY_SLEEP:-1}"

payload="$(cat 2>/dev/null || true)"
[ -z "$payload" ] && exit 0

command -v jq >/dev/null 2>&1 || exit 0

# Need a fresh Bearer.
BEARER="$("${CLAUDE_PLUGIN_ROOT}/bin/memory-refresh" 2>/dev/null)"
[ -z "${BEARER:-}" ] && exit 0

transcript_path="$(printf '%s' "$payload" | jq -r '.transcript_path // empty')"
session_id="$(printf '%s' "$payload" | jq -r '.session_id // "unknown"')"
cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty')"
agent_type="$(printf '%s' "$payload" | jq -r '.agent_type // empty')"
[ -z "$transcript_path" ] || [ ! -f "$transcript_path" ] && exit 0

project_id="$(basename "${cwd:-$PWD}")"

# Pull last N turns as JSON array of {role,text,ts}.
turns_json="$(
  tail -n "$((MAX_TURNS * 4))" "$transcript_path" 2>/dev/null \
    | jq -c 'select(.role == "user" or .role == "assistant")
             | {role: .role, text: (.content // .text // ""), ts: (.timestamp // null)}' 2>/dev/null \
    | tail -n "$MAX_TURNS" \
    | jq -sc '.'
)"
[ -z "$turns_json" ] || [ "$turns_json" = "[]" ] && exit 0

# Client-side scrub each turn's text.
# `jq -c '.[]'` emits one line per element so the while loop sees one object per iteration.
tmp_scrub_input="$(mktemp)"
trap 'rm -f "$tmp_scrub_input"' EXIT
scrubbed_turns_json="$(
  printf '%s' "$turns_json" | jq -c '.[]' | while IFS= read -r t; do
    printf '%s' "$t" | jq -r '.text' > "$tmp_scrub_input"
    scrubbed="$("$SCRIPT_DIR/_ingest-transcript.sh" --scrub-only "$tmp_scrub_input" 2>/dev/null)"
    [ -z "$scrubbed" ] && scrubbed="$(jq -nc --rawfile s "$tmp_scrub_input" '{text: $s, hits: 0}')"
    printf '%s' "$t" | jq -c --argjson s "$scrubbed" '.text = $s.text | .scrub_hits = $s.hits'
  done | jq -sc '.'
)"

total_client_hits="$(printf '%s' "$scrubbed_turns_json" | jq '[.[].scrub_hits] | add // 0')"
stripped_turns_json="$(printf '%s' "$scrubbed_turns_json" | jq -c '[.[] | del(.scrub_hits)]')"

body="$(jq -nc \
  --arg event "$EVENT" \
  --arg session "$session_id" \
  --arg project "$project_id" \
  --arg agent "$agent_type" \
  --arg cwd "$cwd" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson turns "$stripped_turns_json" \
  --argjson hits "$total_client_hits" \
  '{
     event: $event, project_id: $project, session_id: $session,
     agent_type: ($agent | select(length > 0)),
     cwd: $cwd, captured_at: $ts, turns: $turns,
     client_scrub_applied: true, client_scrub_hits: $hits,
     client_version: "0.3.0"
   }')"

attempt=0
while [ "$attempt" -lt "$RETRIES" ]; do
  attempt=$((attempt + 1))
  http_code="$(curl -sS -o /tmp/_memory_ingest_resp.$$ -w '%{http_code}' \
        -m 10 \
        -X POST "${MEMORY_API_URL}/ingest/transcript" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${BEARER}" \
        -d "$body" 2>/dev/null)"
  rm -f /tmp/_memory_ingest_resp.$$ 2>/dev/null
  case "$http_code" in
    2*)         exit 0 ;;
    4*)         exit 0 ;;  # final, no retry
    *)          [ "$attempt" -lt "$RETRIES" ] && sleep "$RETRY_SLEEP" ;;
  esac
done

exit 0
```

- [ ] **Step 4: Make executable + run scrub tests**

Run:

```bash
cd C:/work/mega/astramemory-plugin
chmod +x hooks/scripts/_ingest-transcript.sh
node --test tests/ingest-scrub.test.mjs
```

Expected: PASS — 5 cases green.

- [ ] **Step 5: Commit**

```bash
git add hooks/scripts/_ingest-transcript.sh tests/ingest-scrub.test.mjs
git commit -m "feat(plugin): _ingest-transcript helper with scrub + retry + Bearer"
```

---

### Task 3.2: Retry test — exactly N attempts on 5xx, none on 4xx

**Files:**
- Create: `tests/ingest-retry.test.mjs`

This test stands up a one-shot HTTP server that counts calls and returns chosen status codes.

- [ ] **Step 1: Write failing retry test**

Create `tests/ingest-retry.test.mjs`:

```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HELPER = join(process.cwd(), 'hooks', 'scripts', '_ingest-transcript.sh');

function withServer(handler) {
  return new Promise((resolve) => {
    const calls = { count: 0 };
    const srv = createServer((req, res) => {
      calls.count++;
      handler(req, res, calls);
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise(r => srv.close(r)),
      });
    });
  });
}

function runHook({ url, event, transcriptPath, retries = 2 }) {
  const env = {
    ...process.env,
    MEMORY_API_URL: url,
    MEMORY_INGEST_RETRIES: String(retries),
    MEMORY_INGEST_RETRY_SLEEP: '0',
    CLAUDE_PLUGIN_ROOT: process.cwd(),
  };
  const payload = JSON.stringify({ transcript_path: transcriptPath, session_id: 's', cwd: '/tmp' });
  return spawnSync('bash', [HELPER, '--event', event], {
    encoding: 'utf-8',
    env,
    input: payload,
  });
}

function fakeBearerCli() {
  const dir = mkdtempSync(join(tmpdir(), 'memory-bin-'));
  const path = join(dir, 'memory-refresh');
  writeFileSync(path, '#!/usr/bin/env bash\necho fake-bearer-token\n');
  chmodSync(path, 0o755);
  return dir;
}

function fakeTranscript() {
  const dir = mkdtempSync(join(tmpdir(), 'memory-transcript-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path,
    JSON.stringify({ role: 'user', content: 'hello', timestamp: '2026-06-19T00:00:00Z' }) + '\n' +
    JSON.stringify({ role: 'assistant', content: 'world', timestamp: '2026-06-19T00:00:01Z' }) + '\n');
  return path;
}

test('retries exactly N=2 times on 503 then gives up', async () => {
  const binDir = fakeBearerCli();
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  const transcript = fakeTranscript();

  const srv = await withServer((req, res) => {
    res.writeHead(503).end('{}');
  });

  runHook({ url: srv.url, event: 'pre_compact', transcriptPath: transcript, retries: 2 });
  await srv.close();
  assert.equal(srv.calls.count, 2);
});

test('does not retry on 400', async () => {
  const binDir = fakeBearerCli();
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  const transcript = fakeTranscript();

  const srv = await withServer((req, res) => {
    res.writeHead(400).end('{}');
  });

  runHook({ url: srv.url, event: 'pre_compact', transcriptPath: transcript, retries: 2 });
  await srv.close();
  assert.equal(srv.calls.count, 1);
});

test('stops retrying on first 2xx', async () => {
  const binDir = fakeBearerCli();
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  const transcript = fakeTranscript();

  const srv = await withServer((req, res, calls) => {
    if (calls.count === 1) { res.writeHead(503).end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"summary_memory_id":"x","extraction_job_id":"y","extracted_count":0,"scrub_hits":{"client":0,"server":0},"queued_extraction_types":[]}');
  });

  runHook({ url: srv.url, event: 'pre_compact', transcriptPath: transcript, retries: 2 });
  await srv.close();
  assert.equal(srv.calls.count, 2);
});
```

- [ ] **Step 2: Run; expect PASS**

Run: `cd C:/work/mega/astramemory-plugin && node --test tests/ingest-retry.test.mjs`
Expected: PASS — 3 cases green. (Helper already implements retry per Task 3.1.) If the test fails on Windows because `memory-refresh` resolution path is wrong, prefix the helper invocation with `CLAUDE_PLUGIN_ROOT` pointing at the repo root — already done by the env block above.

- [ ] **Step 3: Commit**

```bash
git add tests/ingest-retry.test.mjs
git commit -m "test(plugin): retry budget honors MEMORY_INGEST_RETRIES"
```

---

### Task 3.3: Payload-shape test

**Files:**
- Create: `tests/ingest-payload.test.mjs`

- [ ] **Step 1: Write test that captures the posted body**

Create `tests/ingest-payload.test.mjs`:

```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HELPER = join(process.cwd(), 'hooks', 'scripts', '_ingest-transcript.sh');

test('builds payload matching the contract', async () => {
  const binDir = mkdtempSync(join(tmpdir(), 'memory-bin-'));
  const refreshPath = join(binDir, 'memory-refresh');
  writeFileSync(refreshPath, '#!/usr/bin/env bash\necho fake-bearer\n');
  chmodSync(refreshPath, 0o755);

  const transcriptDir = mkdtempSync(join(tmpdir(), 'memory-tx-'));
  const transcriptPath = join(transcriptDir, 't.jsonl');
  writeFileSync(transcriptPath,
    JSON.stringify({ role: 'user', content: 'token AKIAIOSFODNN7EXAMPLE leak', timestamp: '2026-06-19T00:00:00Z' }) + '\n' +
    JSON.stringify({ role: 'assistant', content: 'noted', timestamp: '2026-06-19T00:00:01Z' }) + '\n');

  let received;
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      res.writeHead(200, { 'Content-Type': 'application/json' })
         .end('{"summary_memory_id":"x","extraction_job_id":"y","extracted_count":0,"scrub_hits":{"client":0,"server":0},"queued_extraction_types":[]}');
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    MEMORY_API_URL: `http://127.0.0.1:${port}`,
    MEMORY_INGEST_RETRIES: '1',
    MEMORY_INGEST_RETRY_SLEEP: '0',
    CLAUDE_PLUGIN_ROOT: process.cwd(),
  };
  spawnSync('bash', [HELPER, '--event', 'session_end'], {
    encoding: 'utf-8',
    env,
    input: JSON.stringify({ transcript_path: transcriptPath, session_id: 'sess-z', cwd: '/c/work/mega/astramemory-plugin' }),
  });
  await new Promise(r => srv.close(r));

  assert.ok(received, 'server should have received a body');
  assert.equal(received.event, 'session_end');
  assert.equal(received.session_id, 'sess-z');
  assert.equal(received.client_scrub_applied, true);
  assert.ok(received.client_scrub_hits >= 1, 'AKIA leak should be counted as a scrub hit');
  assert.ok(Array.isArray(received.turns) && received.turns.length === 2);
  assert.equal(received.turns[0].role, 'user');
  assert.match(received.turns[0].text, /\[redacted:aws-key\]/);
  assert.ok(received.client_version);
});
```

- [ ] **Step 2: Run; expect PASS**

Run: `cd C:/work/mega/astramemory-plugin && node --test tests/ingest-payload.test.mjs`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/ingest-payload.test.mjs
git commit -m "test(plugin): payload matches /ingest/transcript contract"
```

---

### Task 3.4: Refactor existing hook scripts to call helper

**Files:**
- Modify: `hooks/scripts/pre-compact-capture.sh`
- Modify: `hooks/scripts/session-end-summary.sh`

- [ ] **Step 1: Rewrite `pre-compact-capture.sh`**

Replace the entire contents of `hooks/scripts/pre-compact-capture.sh` with:

```bash
#!/usr/bin/env bash
# AstraMemory pre-compact capture hook.
#
# Forwards transcript turns to the AstraMemory server for scrub + extraction.
# Never blocks compaction: always exits 0.

set +e
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_load-env.sh"

MAX_TURNS="${MEMORY_PRECOMPACT_MAX_TURNS:-20}"
MAX_CHARS="${MEMORY_PRECOMPACT_MAX_CHARS:-12000}"

exec "$SCRIPT_DIR/_ingest-transcript.sh" \
  --event pre_compact \
  --max-turns "$MAX_TURNS" \
  --max-chars "$MAX_CHARS"
```

- [ ] **Step 2: Rewrite `session-end-summary.sh`**

Replace the entire contents of `hooks/scripts/session-end-summary.sh` with:

```bash
#!/usr/bin/env bash
# AstraMemory session-end summary hook.
#
# Forwards last-N transcript turns to the server for scrub + extraction.

set +e
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_load-env.sh"

MAX_TURNS="${MEMORY_SESSION_MAX_TURNS:-40}"
MAX_CHARS="${MEMORY_SESSION_MAX_CHARS:-20000}"

exec "$SCRIPT_DIR/_ingest-transcript.sh" \
  --event session_end \
  --max-turns "$MAX_TURNS" \
  --max-chars "$MAX_CHARS"
```

- [ ] **Step 3: Run tests**

Run: `cd C:/work/mega/astramemory-plugin && node --test tests/*.test.mjs`
Expected: PASS — full suite green.

- [ ] **Step 4: Commit**

```bash
git add hooks/scripts/pre-compact-capture.sh hooks/scripts/session-end-summary.sh
git commit -m "refactor(plugin): existing hooks delegate to _ingest-transcript helper"
```

---

### Task 3.5: Add `SubagentStop` hook + script

**Files:**
- Create: `hooks/scripts/subagent-stop-capture.sh`
- Modify: `hooks/hooks.json`

- [ ] **Step 1: Create `subagent-stop-capture.sh`**

Create `hooks/scripts/subagent-stop-capture.sh`:

```bash
#!/usr/bin/env bash
# AstraMemory subagent-stop capture hook.
#
# Forwards the last N turns of a Task-agent transcript to the server.
# Always exits 0 — never blocks the SubagentStop chain.

set +e
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_load-env.sh"

MAX_TURNS="${MEMORY_SUBAGENT_MAX_TURNS:-12}"
MAX_CHARS="${MEMORY_SUBAGENT_MAX_CHARS:-8000}"

exec "$SCRIPT_DIR/_ingest-transcript.sh" \
  --event subagent_stop \
  --max-turns "$MAX_TURNS" \
  --max-chars "$MAX_CHARS"
```

Make executable: `chmod +x hooks/scripts/subagent-stop-capture.sh`.

- [ ] **Step 2: Add hook block in `hooks/hooks.json`**

Replace the entire contents of `hooks/hooks.json` with:

```json
{
  "hooks": {
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/pre-compact-capture.sh\"",
            "description": "memory: auto-capture a pre-compaction summary so context survives compaction"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/session-end-summary.sh\"",
            "description": "memory: write a session summary memory at session end"
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/subagent-stop-capture.sh\"",
            "description": "memory: capture the tail of a Task-agent transcript for extraction"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: Smoke test the new script (stdin payload that points at a fake transcript)**

Run:

```bash
cd C:/work/mega/astramemory-plugin
printf '{"transcript_path":"/dev/null","session_id":"smoke","cwd":"/tmp"}' \
  | hooks/scripts/subagent-stop-capture.sh
echo "exit=$?"
```

Expected: prints `exit=0` (no transcript content → helper bails clean).

- [ ] **Step 4: Commit**

```bash
git add hooks/scripts/subagent-stop-capture.sh hooks/hooks.json
git commit -m "feat(plugin): SubagentStop hook captures Task-agent transcript tail"
```

---

### Task 3.6: Switch `.mcp.json` + `.env.*` to Bearer-only

**Files:**
- Modify: `.mcp.json`
- Modify: `.env.local`
- Modify: `.env.azuredev`

- [ ] **Step 1: Update `.mcp.json`**

Replace the contents of `.mcp.json` with:

```json
{
  "mcpServers": {
    "memory": {
      "type": "http",
      "url": "${MEMORY_MCP_URL}/mcp",
      "headers": {
        "Authorization": "Bearer ${MEMORY_BEARER}"
      }
    }
  }
}
```

- [ ] **Step 2: Update `.env.local`**

Replace the contents of `.env.local` with:

```
# memory plugin -- local profile (default).
#
# Hooks source this file when MEMORY_ENV is unset or =local. Points at the
# AstraMemory stack you run with `dotnet run --project src/AstraMemory.AppHost`.
#
# Auth: tokens are minted by the local Clerk dev instance via `memory-login`.
# The hook scripts call `memory-refresh` before each request and pass the
# bearer token via Authorization: Bearer.

MEMORY_API_URL=http://localhost:5201
MEMORY_MCP_URL=http://localhost:5202
MEMORY_CLERK_AUTHORITY=https://acme.clerk.accounts.dev
MEMORY_CLERK_CLIENT_ID=
MEMORY_CLERK_REDIRECT_URI=http://127.0.0.1:53682/callback

# Ingest retry / per-event limits.
MEMORY_INGEST_RETRIES=2
MEMORY_INGEST_RETRY_SLEEP=1
MEMORY_PRECOMPACT_MAX_TURNS=20
MEMORY_PRECOMPACT_MAX_CHARS=12000
MEMORY_SESSION_MAX_TURNS=40
MEMORY_SESSION_MAX_CHARS=20000
MEMORY_SUBAGENT_MAX_TURNS=12
MEMORY_SUBAGENT_MAX_CHARS=8000
```

- [ ] **Step 3: Update `.env.azuredev`**

Replace the contents of `.env.azuredev` with:

```
# memory plugin -- Azure dev profile.

MEMORY_API_URL=https://ca-yarp-dev.icymeadow-6c3aaa26.centralus.azurecontainerapps.io/memory-api
MEMORY_MCP_URL=https://ca-yarp-dev.icymeadow-6c3aaa26.centralus.azurecontainerapps.io/memory-mcp
MEMORY_CLERK_AUTHORITY=https://acme.clerk.accounts.dev
MEMORY_CLERK_CLIENT_ID=
MEMORY_CLERK_REDIRECT_URI=http://127.0.0.1:53682/callback

# Ingest retry / per-event limits.
MEMORY_INGEST_RETRIES=2
MEMORY_INGEST_RETRY_SLEEP=1
MEMORY_PRECOMPACT_MAX_TURNS=20
MEMORY_PRECOMPACT_MAX_CHARS=12000
MEMORY_SESSION_MAX_TURNS=40
MEMORY_SESSION_MAX_CHARS=20000
MEMORY_SUBAGENT_MAX_TURNS=12
MEMORY_SUBAGENT_MAX_CHARS=8000
```

- [ ] **Step 4: Run full test suite**

Run: `cd C:/work/mega/astramemory-plugin && node --test tests/*.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .mcp.json .env.local .env.azuredev
git commit -m "feat(plugin): Bearer-only auth in .mcp.json + .env profiles"
```

---

### Task 3.7: Version bump + README + CHANGELOG

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Modify: `package.json`
- Modify: `README.md`
- Create: `CHANGELOG.md` (if absent)

- [ ] **Step 1: Bump version in both manifests**

In `.claude-plugin/plugin.json`, change `"version": "0.2.0"` → `"version": "0.3.0"`.
In `package.json`, change `"version": "0.2.0"` → `"version": "0.3.0"`.

- [ ] **Step 2: Update `README.md`**

In the **Hooks** section, replace the existing PreCompact/SessionEnd description with:

```markdown
- **PreCompact / SessionEnd / SubagentStop** — `hooks/scripts/*.sh` capture
  the tail of the current transcript and POST it to the AstraMemory server
  at `${MEMORY_API_URL}/ingest/transcript`. The server scrubs secrets,
  stores the raw turns as a `summary` memory, and runs an LLM extractor
  that emits typed atoms (`decision`, `fact`, `lesson`, `event`) linked to
  prior memories via the graph.

  Hooks always `exit 0` — they never block compaction or session shutdown.
  Failures (no Bearer cache, server down, jq missing) are silent. POSTs
  retry `MEMORY_INGEST_RETRIES` times (default 2) on 5xx; 4xx is final.

  | Hook         | Max turns | Env override                  |
  | ------------ | --------- | ----------------------------- |
  | PreCompact   | 20        | `MEMORY_PRECOMPACT_MAX_TURNS` |
  | SessionEnd   | 40        | `MEMORY_SESSION_MAX_TURNS`    |
  | SubagentStop | 12        | `MEMORY_SUBAGENT_MAX_TURNS`   |
```

In the **MCP server registration** section, replace the ApiKey header sentence with:

```markdown
The Authorization header is `Bearer ${MEMORY_BEARER}`. `MEMORY_BEARER` is a
JWT minted by `memory-login` (one-time) and refreshed by `memory-refresh`.
The MCP transport binds the token at Claude Code launch — long sessions can
outlast the ~1h TTL; restart Claude Code or re-run `memory-refresh` then
restart if the MCP server starts returning 401.
```

In the **Configuration** table, replace the `MEMORY_API_KEY` row with the retry vars:

```markdown
| `MEMORY_BEARER`                  | (resolved via memory-refresh) | Bearer token used by `.mcp.json` |
| `MEMORY_INGEST_RETRIES`          | `2`                     | POST retry budget per hook fire |
| `MEMORY_INGEST_RETRY_SLEEP`      | `1`                     | Seconds between retries |
| `MEMORY_SUBAGENT_MAX_TURNS`      | `12`                    | Turns captured for SubagentStop |
| `MEMORY_SUBAGENT_MAX_CHARS`      | `8000`                  | Hard byte cap on SubagentStop digest |
```

- [ ] **Step 3: Create / extend `CHANGELOG.md`**

If `CHANGELOG.md` does not exist, create it with:

```markdown
# Changelog

## 0.3.0 — 2026-06-19

### Breaking
- Drop `MEMORY_API_KEY` from `.env.local` and `.env.azuredev`. All ingest traffic uses Clerk Bearer via `memory-refresh`.
- `.mcp.json` Authorization header is now `Bearer ${MEMORY_BEARER}`. Long sessions may need a Claude Code restart when the bearer TTL expires.

### Added
- POST `/ingest/transcript` server endpoint: scrub + summary + LLM extraction of `decision` / `fact` / `lesson` / `event` atoms + graph edges (`mentions`, `relates_to`, `supersedes`).
- `SubagentStop` hook captures Task-agent transcript tails.
- Client-side regex scrub (JWT / AWS / Anthropic / generic secret patterns) with hit count reported to server.
- Client-side retry (default 2) on 5xx / network errors. 4xx is final.

### Changed
- `pre-compact-capture.sh` and `session-end-summary.sh` now delegate to `_ingest-transcript.sh`. They no longer POST directly to `/memories`.
```

If `CHANGELOG.md` already exists, prepend the `## 0.3.0` block above the prior top entry.

- [ ] **Step 4: Final test sweep**

Run:

```bash
cd C:/work/mega/astramemory-plugin
node --test tests/*.test.mjs
```

Expected: PASS — full suite green.

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/plugin.json package.json README.md CHANGELOG.md
git commit -m "chore(release): v0.3.0 — transcript ingest + Bearer-only auth"
```

---

## Cross-repo verification (Phase 3 end)

Run both servers locally, exercise an end-to-end happy path:

- [ ] **Step 1: Start the AstraMemory stack**

```bash
cd C:/work/mega/memory
dotnet run --project src/AstraMemory.AppHost
```

Wait for the API health endpoint to come up at `http://localhost:5201/health`.

- [ ] **Step 2: One-time login (if not done)**

```bash
cd C:/work/mega/astramemory-plugin
./bin/memory-login
```

Expected: prints "logged in" and writes `~/.config/memory/auth.json` (POSIX) or `%APPDATA%\memory\auth.json` (Windows).

- [ ] **Step 3: Manually fire the PreCompact hook**

```bash
printf '{"transcript_path":"<path-to-current-claude-transcript>.jsonl","session_id":"manual-smoke","cwd":"%s"}' "$PWD" \
  | hooks/scripts/pre-compact-capture.sh
```

Expected: exit code 0. Server log shows `POST /ingest/transcript` 200.

- [ ] **Step 4: Confirm memory was created**

Use the `/memory:recall` slash command from inside Claude Code, or via curl:

```bash
BEARER="$(./bin/memory-refresh)"
curl -s -H "Authorization: Bearer $BEARER" \
  "http://localhost:5201/memories/search?query=manual-smoke&project_id=astramemory-plugin" | jq .
```

Expected: at least one hit with `type=summary` and `source=claude-code-pre_compact`. If the LLM was reachable, additional hits with `type=decision` / `fact` may also be present.

- [ ] **Step 5: Spot-check edges**

```bash
curl -s -H "Authorization: Bearer $BEARER" \
  "http://localhost:5201/graph/stats" | jq .
```

Expected: `relationshipType` counts include `mentions` (and possibly `relates_to` / `supersedes` if prior memories matched).

No commit for this verification step — just a manual sign-off.

---

## Notes

- **Async extraction queue (Phase 4)** is out of scope. When traffic warrants it, lift extractor + linker out of the request path into a background worker keyed on `extraction_job_id`. The response will then become `202 Accepted`. The plugin already treats `2xx` uniformly, so no plugin change is required.
- **Rate limiter** uses whatever middleware already exists on the API. If a dedicated `/ingest/transcript` limiter is needed (e.g. 10/min/user), wire it through the existing `RateLimit` middleware folder — add a follow-on task with the exact configuration after measuring real traffic.
- **`TenantContext.AuthScheme`** is referenced by `TranscriptIngestController` to reject ApiKey. If the property doesn't exist, add a one-line task before Task 1.5 to introduce it (or substitute the equivalent check already used by other Bearer-only routes — `grep -rn "AuthScheme\|Bearer" src/AstraMemory.Api/Middleware`).
