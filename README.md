# BitChord FLAC Aggregator 🎧

**A FLAC-focused music-source aggregator for BitChord, built on Cloudflare Workers, with recording-aware recovery, optional Atmos, public music catalogs, a personal R2 library, and a permission-controlled 36-hour R2 cache. This is solely for Unknown_CommandZtain only and if you want to set up similarly like this, feel free to take a look on the below on how to create and deploy it on Cloudflare or any hosting website**

> **Latest prepared Worker:** `v3.7.9` · **FLAC Reliability Update**  
> **Runtime:** JavaScript on Cloudflare Workers  
> **Client:** BitChord-compatible addon API  
> **Deployment status:** v3.7.9 was packaged and locally tested; deployment and successful end-to-end playback were **not independently confirmed**  
> **Project:** Unofficial personal/community integration, not affiliated with BitChord or any music provider

BitChord FLAC Aggregator searches compatible music providers, selects FLAC candidates, and attempts to locate the **same recording** elsewhere if the first stream fails. It distinguishes song titles, artists, Japanese/Romaji variants, producer credits, and recording versions to reduce incorrect matches. Its default playback mode requires verification of actual FLAC header bytes, rather than trusting a `LOSSLESS` search-result label.

**Design priorities:** correct recording, verified FLAC bytes, bounded latency, graceful failure, stable provider IDs, private and permission-aware storage, and clear diagnostics.

> [!IMPORTANT]
> A `LOSSLESS` search badge is **provider metadata, not evidence of successful FLAC playback**. Even `[FLAC READY]` or HTTP 200 means the Worker resolved or handed off a stream; it does **not** prove BitChord subsequently downloaded, decoded, or played it. The Worker also cannot control independent fallback behavior in the BitChord app or its other addons.

## Contents

- [What's new in v3.7.9](#whats-new-in-v379)
- [Features and verification model](#features-and-verification-model)
- [Architecture and playback flow](#architecture-and-playback-flow)
- [Supported sources](#supported-sources)
- [Deployment](#deployment)
- [Environment variables and bindings](#environment-variables-and-bindings)
- [36-hour private FLAC cache: Cloudflare R2](#36-hour-private-flac-cache-cloudflare-r2)
- [Personal R2 library and access controls](#personal-r2-library-and-access-controls)
- [Optional Dolby Atmos](#optional-dolby-atmos)
- [API routes](#api-routes)
- [Monitoring, testing, and troubleshooting](#monitoring-testing-and-troubleshooting)
- [Source research and future roadmap](#source-research-and-future-roadmap)
- [Costs, security, and rights](#costs-security-and-rights)
- [Release history](#release-history)
- [Documentation](#documentation)

## What's new in v3.7.9

**v3.7.9 builds on v3.7.8 and retains the original nine configured addon positions, public-source adapters, optional Atmos, and both R2 storage paths.** The October 2026 reliability work was motivated by recordings that appeared as lossless search results but stalled or skipped at playback.

| Improvement | Behavior |
| --- | --- |
| **Longer strict FLAC check** | External-addon signature probe defaults to **1,600 ms** rather than 1,000 ms; successful fast checks return without waiting the whole interval. |
| **Configurable deadline** | Optional `FLAC_PROBE_TIMEOUT_MS`, clamped to **900–2,200 ms**. |
| **Retryable inconclusive probes** | Network errors, inaccessible URLs, absent response bodies, and probe timeouts are **not** treated as proven lossy bytes and are not recorded as permanent bad tracks. Strict mode still rejects unverified streams for that attempt. |
| **Better candidate handling** | Up to **five saved matching candidates** may be examined, in batches of up to **three**, within a bounded recovery deadline. |
| **Provider health awareness** | Recent upstream failures, latency observations, and cooldowns influence which sources are tried first; a track-specific 404 is not automatically treated as a provider-wide outage. |
| **Diagnostic clarity** | `[FLAC PROBE]`, `[STREAM UNAVAILABLE]`, `[FLAC RESCUE SUCCESS]`, `[STREAM TIMING]`, and `[PLAYBACK HANDOFF]` distinguish resolution, byte verification, and handoff. Logs intentionally avoid printing raw signed stream URLs. |

**Recent improvements preserved:**

- **v3.7.8:** Inconclusive FLAC probes remain retryable; do not falsely negative-cache temporary verification failures.
- **v3.7.7:** Conservative Japanese↔Romaji title aliases, Vocaloid producer-aware matching, and anime/recording-version handling. Includes the **DECO*27 “Rabbit Hole” / `ラビットホール`** alias correction and separation of alternate versions where identifiable.
- **v3.7.6:** Optional E-AC-3 JOC Dolby Atmos mode, behind an explicit opt-in and client request.
- **v3.7.5:** 36-hour private R2 read-through cache with signed URLs and cleanup.
- **v3.7.4:** Optional Openverse and Wikimedia Commons discovery.
- **v3.7.3 and earlier:** Version-aware matching, soundtrack discovery, staged searching, and cross-provider FLAC recovery.

> [!NOTE]
> Local mocked tests and JavaScript syntax checks passed during preparation of v3.7.9. These do **not** establish real-world uptime, copyright permission, playback compatibility, or successful audio fetching by BitChord itself.

## Features and verification model

| Feature | Description |
| --- | --- |
| FLAC-only default | Rejects known MP3, AAC, Opus, WebM, and other non-FLAC responses **through this Worker** in normal mode. |
| Nine compatible addon positions | Preserves the original configured IDs `discord_0` through `discord_8` and existing track references. |
| Cross-provider rescue | Uses saved matching alternatives, then bounded fresh discovery, to recover the intended recording. |
| Recording-aware matching | Uses title, artist, version/mix text, and available duration; distinguishes original mixes, edits, remixes, and other variants where possible. |
| Japanese/Vocaloid support | Conservative Japanese/Romaji aliases, producer credits, and anime soundtrack search forms; not an exhaustive transliteration engine. |
| Staged search | Favors responsive providers and limits the time spent on slow sources. |
| Provider cooldowns | Avoids repeatedly hammering unhealthy endpoints; some in-memory state resets when a Worker isolate restarts. |
| Public music catalogs | Internet Archive and optional Jamendo, Openverse, and Wikimedia Commons. |
| Personal R2 library | Optional `FLAC_BUCKET` and manually registered `PERSONAL_FLAC_TRACKS`. **Current audio route is not access-controlled.** |
| Temporary R2 cache | Optional independent `FLAC_CACHE_BUCKET`, 36-hour expiry, permission allowlist, signed links, and cleanup. |
| Optional Atmos | Explicitly enabled E-AC-3 JOC, which is **not FLAC and is lossy**; never silently substituted into ordinary FLAC mode. |
| Diagnostic logs | Probe outcome, upstream failures, matching reasons, provider performance, cache status, rescue and playback handoff. |

### What “verified” means

There are **three distinct questions**, and the Worker answers only part of them:

1. **Valid FLAC file/stream:** The first bytes are the actual FLAC signature `fLaC`. This rejects many incorrect codec claims, but does not by itself validate the entire file.
2. **Genuinely lossless source/master:** A file can be converted from AAC/Opus/MP3 to FLAC. The `fLaC` signature **cannot prove** that the original recording was never lossy. That requires provenance and, when available, trusted reference comparisons.
3. **Playable by BitChord:** A confirmed FLAC header does not guarantee the final URL is still valid, reachable by the user's device, range-friendly, or supported by the player.

### Verification modes

| `FLAC_VERIFY_MODE` | Behavior | Suitable for strict FLAC-only use? |
| --- | --- | --- |
| **`strict` (default)** | Requires actual FLAC signature proof for external-addon streams. Inconclusive verification fails safely and can be retried. | **Yes, for verifying the container signature** |
| `adaptive` | Accepts an inconclusive check when stream metadata claims FLAC; known non-FLAC bytes are still rejected. | **No**, cannot guarantee actual FLAC bytes |
| `off` | Relies on format metadata without checking external-addon audio bytes. | **No** |

> [!CAUTION]
> Use the **exact** text value `strict`. In the current v3.7.9 source, an **unrecognized** `FLAC_VERIFY_MODE` value unexpectedly falls back to `adaptive`. Avoid typos and verify this behavior is corrected before treating invalid configuration values as fail-closed. Do not misrepresent signature verification as proof of original-master provenance.

### Timing and recovery budgets

- Default strict probe: `1,600 ms`, adjustable to `900–2,200 ms`.
- Interactive search budget: approximately **2,700 ms** at the Worker search layer, with staged source selection.
- Cross-provider rescue: bounded to approximately **6,500 ms** from the playback request start.
- Matching alternates are attempted in bounded batches, and unhealthy providers can be skipped.
- These are application targets, **not guarantees** of end-to-end listening latency or total network availability.

## Architecture and playback flow

```text
BitChord
  │
  ├── GET /manifest.json
  ├── GET /search?q=...&quality=LOSSLESS
  │     ├── primary subset of configured addons
  │     ├── optional archive / Jamendo / personal / cached entries
  │     └── slower or optional catalogs only if results are thin
  │
  └── GET /stream/{provider}:{id}?quality=LOSSLESS
        │
        ├── Existing permitted, unexpired R2 cache copy?
        │     └── YES → signed /audio/cache/{hash}.flac link
        │               └── R2 response supports HTTP Range
        │
        └── NO → original source
              ├── Resolve URL/format
              ├── For external addons in strict mode: inspect FLAC bytes
              ├── Failed → try same recording from other providers
              ├── Still failed → HTTP error, no Worker-level lossy fallback
              └── Verified candidate → return playback JSON to BitChord
                                      └── optional background R2 copy
                                          ONLY if expressly permitted

Optional personal R2 file: /audio/personal/{index}.flac
  └── Currently externally reachable by anyone with the URL/track index.

Hourly Cron Trigger: 0 * * * *
  └── Cleanup expired temporary cache objects, not personal library files.
```

**The source registry is not yet a permanent learning database.** Current rescue metadata is embedded in eligible track IDs, with short-lived in-isolate caches and the optional R2 objects. The proposed **Pathfinder / Cloudflare D1** approach is future work, not a feature of v3.7.9.

## Supported sources

| Source | Status in v3.7.9 | Notes |
| --- | --- | --- |
| Nine configured BitChord-compatible addons, `discord_0`–`discord_8` | **Included** | External providers may break, impose quotas, mislabel codec/quality, or require credentials and permission. **Provider order must not change.** |
| Internet Archive (`ia`) | Included | Archive metadata and qualifying FLAC recordings. Rights and completeness vary by item. |
| Jamendo (`jamendo`) | Optional | Requires your own `JAMENDO_CLIENT_ID`; API and recording licenses apply. |
| Openverse (`openverse`) | Optional | Enable `OPENVERSE_ENABLED=true`; index metadata/license claims must be checked per work. |
| Wikimedia Commons (`commons`) | Optional | Enable `COMMONS_ENABLED=true`; mainly public-domain/open-licensed recordings. |
| Personal R2 library (`personal`) | Optional | `FLAC_BUCKET` plus `PERSONAL_FLAC_TRACKS`; protect the audio routes before using genuinely private recordings. |
| Temporary 36-hour R2 cache (`cache`) | Optional | Separate signed-link cache with an explicit permission allowlist. |
| Dolby Atmos | Optional **format mode**, not a provider | Requires `ATMOS_ENABLED=true` **and** a request with `atmos=auto`; only accepts matching E-AC-3 JOC metadata. |

**Not added:** Funkwhale v2, Audius, ccMixter, Soulseek, FLACidal, Sidify, LastWave, Navidrome, and any direct new TIDAL/Qobuz commercial integration. Discussion, download testing, and API benchmarks are **not** production integration.

The source file can contain URLs with embedded provider access tokens. **Do not publish the unredacted code or provider configuration.**

## Deployment

### Requirements

- Cloudflare account with Workers access.
- A **private copy of the v3.7.9 Worker** (`BitChord_v3.7.9.js` or matching TXT version).
- The existing nine authorized provider URLs and their current indices.
- Optional R2 bindings and secrets for personal library/cache functions.
- Optional permitted public catalog credentials and flags.

### Deploy safely

1. **Back up the currently deployed Worker** before editing anything. The latest *prepared* release being v3.7.9 does not prove the live Worker is running it.
2. Keep all provider entries in their existing order: `discord_0` through `discord_8`. Track IDs contain provider indices; reordering can break existing saved songs.
3. Open **Cloudflare Dashboard → Workers & Pages → your Worker → Edit Code**. Replace the existing code with the **complete v3.7.9 source**, not the README or benchmark script.
4. Retain your environment variables, secrets, R2 bindings and Cron Trigger. Set `FLAC_VERIFY_MODE` **exactly** to `strict` (or leave it unset to use the default).
5. Deploy, then open `https://YOUR-WORKER.workers.dev/manifest.json`. Check that it reports version `3.7.9`.
6. Search in BitChord and test playback of a recording you have permission to access. Check Worker logs for resolution and `[PLAYBACK HANDOFF]`, then confirm real playback on the client.
7. Test seeking, failed-provider fallback, and optional R2 cache behavior separately.

> [!CAUTION]
> The packaged Worker source includes original provider configuration that may contain **private or token-bearing URLs**. Keep the raw JavaScript, ZIP packages, and full Cloudflare logs private. A public GitHub README should never embed actual provider URLs, user addresses, API keys, signed audio links, or request identifiers. Rotate compromised keys as appropriate.

### Deployment without R2

The Worker can function as an aggregator without any R2 bucket. The personal library and 36-hour cache activate only when their respective bindings/configuration exist.

## Environment variables and bindings

Set these under your Worker's **Settings → Variables and Secrets** or the corresponding bindings section. Names are case-sensitive.

| Name | Type | Purpose / default |
| --- | --- | --- |
| `FLAC_VERIFY_MODE` | Text, optional | `strict` (**default**), `adaptive`, or `off`. Use `strict` for FLAC header verification. |
| `FLAC_PROBE_TIMEOUT_MS` | Text, optional | Strict probe default `1600`; clamped to `900..2200` milliseconds. |
| `ATMOS_ENABLED` | Text, optional | `true` to permit Atmos when the *request also* contains `atmos=auto`; otherwise off. |
| `FLAC_BUCKET` | R2 bucket binding, optional | Separate **permanent personal library**. Does not grant private route authentication. |
| `FLAC_CACHE_BUCKET` | R2 bucket binding, optional | **Temporary** 36-hour cache. Must not be the same bucket as `FLAC_BUCKET`. |
| `FLAC_CACHE_ENABLED` | Text, optional | `true` to enable temporary-cache behavior when other prerequisites are present. |
| `FLAC_CACHE_SIGNING_KEY` | **Secret**, required for cache | At least **32 random characters** to sign cache URLs. |
| `FLAC_CACHE_ALLOWED_PROVIDERS` | Text, optional | Comma-separated **explicit permission-approved** provider IDs for cache writes; empty means no allowed providers. |
| `OPENVERSE_ENABLED` | Text, optional | `true` to enable Openverse discovery. |
| `COMMONS_ENABLED` | Text, optional | `true` to enable Wikimedia Commons discovery. |
| `JAMENDO_CLIENT_ID` | Secret, optional | Your own authorized Jamendo API client ID. |

**No `D1` binding is used in v3.7.9.** Funkwhale and Audius API keys are not part of this release.

## 36-hour private FLAC cache: Cloudflare R2

**`FLAC_CACHE_BUCKET` is temporary object storage, not a general public song database.** The signed Worker URL acts as a limited-time playback bearer link: anyone obtaining an unexpired link may be able to replay it.

### Create a distinct, non-public bucket

1. In Cloudflare, create an **R2 Standard** bucket intended solely for temporary cache files.
2. Leave direct public `r2.dev` and public custom-domain access **disabled**.
3. Bind the new bucket to the Worker as **`FLAC_CACHE_BUCKET`**.
4. Do **not** bind this bucket to the `FLAC_BUCKET` personal library name.
5. Set `FLAC_CACHE_ENABLED=true`, a strong `FLAC_CACHE_SIGNING_KEY`, and only the providers whose recordings may legitimately be copied into cache.
6. Configure the existing hourly Cron Trigger: `0 * * * *` (UTC).

For example, you can generate a signing key locally with:

```bash
openssl rand -base64 48
```

Store the resulting value **only** as a Cloudflare secret, not in committed source files.

### Cache safeguards

| Policy | Implemented behavior |
| --- | --- |
| Application expiry | **36 hours** from the cache upload; expired objects are not served. |
| Cleanup | Hourly `scheduled()` handler; physical cleanup may occur later if the job fails or is delayed. |
| Target total size | Approximately **2 GiB**; best-effort target, **not** a hard storage or spending cap. |
| Maximum individual file | **100 MiB**. |
| Unknown length | Rejected for automatic cache writes. |
| Content check | Downloaded data must begin with `fLaC` before being saved. |
| Write permissions | Only explicit `FLAC_CACHE_ALLOWED_PROVIDERS`, after reviewing rights. |
| First playback | Normal resolved URL is returned; background cache copying uses `ctx.waitUntil()` and can fail without blocking playback. |
| Cached playback links | HMAC signed, with expiry no later than the object's lifetime and normally up to **6 hours**. |
| HTTP methods | Signed cache route supports `GET`, `HEAD`, and Range requests. |
| Stored metadata | Limited title, artist, album, duration, provider and expiry for cache discovery. |
| Key naming | Hashed under `bc-flac-cache-v1/`, not recognizable song filenames. |

> [!NOTE]
> An empty cache is normal when `FLAC_CACHE_ALLOWED_PROVIDERS` is empty, the recording license forbids copying, the source is unavailable, the size is unsuitable, or the background job fails. Do not enable arbitrary provider caching just to populate the bucket. An R2 lifecycle rule expiring `bc-flac-cache-v1/` items after about **2 days** can add orphan protection, but is not the exact 36-hour mechanism.

## Personal R2 library and access controls

A **different** R2 bucket may be bound as `FLAC_BUCKET`. Add legally held, permitted files to the bucket and register them in the Worker's `PERSONAL_FLAC_TRACKS` array:

```js
const PERSONAL_FLAC_TRACKS = [
  { key: "MyMusic/Artist - Song.flac", title: "Song", artist: "Artist", duration: 240 }
];
```

The personal-library route is currently:

```text
GET /audio/personal/{index}.flac
HEAD /audio/personal/{index}.flac
```

**Critical privacy limitation:** The **bucket can be private while the Worker playback route remains public**. In v3.7.9, this route has **no per-user authentication or signed link requirement**. Anyone who discovers the route/index may retrieve the configured recording. Merely keeping its URL secret is not sufficient protection. `PERSONAL_FLAC_TRACKS` indices may also be discoverable through search results.

For a genuinely private collection, **do not register sensitive/personal tracks in the publicly reachable Worker until appropriate authenticated route protection is implemented and tested**. The temporary cache signing mechanism is not automatically applied to the personal library route. If you only want private listening, keep this separate from any shared public addon.

A LastWave download being a valid FLAC does **not** establish that storing it or offering access is permitted. Personal use, public distribution, and selling access can have different legal/contractual requirements.

## Optional Dolby Atmos

Atmos support was introduced as an **opt-in option** in v3.7.6 and is retained in v3.7.9.

- Set `ATMOS_ENABLED=true` in the Worker **and** have the BitChord request include `atmos=auto`.
- Only accept upstream streams identified as **E-AC-3 JOC** for Atmos mode; not generic AAC/MP3/Opus.
- E-AC-3 JOC is **lossy immersive audio**, not a FLAC/lossless stream.
- Ordinary requests without both opt-ins keep the **stereo FLAC-only** behavior.
- Do **not** store Atmos content in the 36-hour FLAC R2 cache.

The manifest advertises Atmos when enabled, but actual Atmos playback still depends on an upstream providing the format and the BitChord client supporting it.

## API routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/manifest.json` | BitChord addon manifest; version `3.7.9`. |
| `GET` | `/search?q=artist+title` | FLAC-claimed search results and eligible personal/cache entries. A search result is not proof of playback. |
| `GET` | `/stream/{provider}:{trackId}?quality=LOSSLESS` | Resolve original or rescued FLAC and return playback JSON, or an error when unavailable. |
| `GET` | `/stream/{provider}:{trackId}?quality=LOSSLESS&atmos=auto` | Atmos preference **only when** `ATMOS_ENABLED=true`. |
| `GET`, `HEAD` | `/audio/cache/{hash}.flac?exp=...&sig=...` | Signed, unexpired cache playback. |
| `GET`, `HEAD` | `/audio/personal/{index}.flac` | Personal R2 bytes. **Not authenticated in the current version.** |

A harmless search shape is:

```text
https://YOUR-WORKER.workers.dev/search?q=Artist%20Song&quality=LOSSLESS
```

Never paste live signed stream URLs, upstream credentials, or private account endpoints into public reports.

## Monitoring, testing, and troubleshooting

### Watch logs

Open **Cloudflare Dashboard → Workers & Pages → your Worker → Observability / Logs**. Exact navigation labels may vary.

| Marker | Interpretation |
| --- | --- |
| `[SOURCE CONFIG]` | Optional source configuration states, without actual credentials. |
| `[SEARCH PERFORMANCE]` / `[SEARCH READY]` | Query duration and result count; search matches are not yet byte-verified. |
| `[UPSTREAM HTTP]` / `[UPSTREAM TIMEOUT]` | Upstream returned an error or was unreachable. |
| `[PROVIDER COOLDOWN]` | Requests to a temporarily unhealthy provider are being delayed/skipped. |
| `[MATCH REASONS]` / `[OST MATCH]` | Why soundtrack/recording candidates were accepted or rejected. |
| `[FLAC PROBE]` | Actual external FLAC-byte check: confirmed, non-FLAC, or inconclusive, with elapsed time. |
| `[FLAC PROBE REJECT]` | Why strict mode rejected the particular resolution attempt. |
| `[FLAC RESCUE SUCCESS]` | An alternative provider was found and passed the applicable resolver checks. |
| `[FLAC RESCUE EXHAUSTED]` | No acceptable equivalent recording found within the budget. |
| `[FLAC READY]` | The Worker resolved an allowed FLAC candidate, not confirmation of actual client playback. |
| `[PLAYBACK HANDOFF]` | Playback JSON returned; **client bytes played remain unknown**. |
| `[STREAM UNAVAILABLE]` | No verified playable source could be returned. |
| `[FLAC CACHE HIT]` / `[FLAC CACHE MISS]` | Temporary R2 cache lookup. |
| `[FLAC CACHE SAVED]` / `[FLAC CACHE SKIP]` | Background save succeeded or did not meet requirements. |
| `[FLAC CACHE CLEANUP]` | Scheduled deletion/eviction. |

### What the real logs already showed

An October 2026 trace showed an initial upstream **404**, a rescued FLAC candidate failing an initial one-second probe, and a later request **confirming FLAC bytes** from an alternate provider. That demonstrates why v3.7.8/3.7.9 distinguish inconclusive network conditions from confirmed non-FLAC. The later HTTP 200 confirms Worker handoff, **not** successful playback inside BitChord.

Cloudflare request-event exports may still contain **IP addresses, geolocation, user agents, complete request paths, account data, and other identifiers**, even when application `console.log()` entries are privacy-conscious. Sanitize exports before sharing or publishing them.

### Troubleshooting

| Symptom | What to check |
| --- | --- |
| Song is labeled Lossless but skips | Search metadata may be inaccurate; inspect `[FLAC PROBE]`, upstream status, `[STREAM UNAVAILABLE]`, and cross-provider rescue logs. |
| Strict verification repeatedly times out | Keep `FLAC_VERIFY_MODE=strict`; consider `FLAC_PROBE_TIMEOUT_MS=1900` or `2100` after checking delays, with a maximum of 2200. |
| `[FLAC READY]` but BitChord still skips | Inspect actual playback URL access, expiry, HTTP Range support, and client compatibility; the Worker cannot prove player behavior. |
| Provider returns 404/410 | Track missing, removed, or upstream identifier invalid; try a different legitimate source. |
| Provider returns 429/502/503/504 | Rate limit, gateway failure, or timeout; provider cooldown should reduce repeated load. |
| Japanese/Romaji track not found | Try original Japanese title or alternate transliteration and correct producer credit; preserve edition/version information. |
| Wrong edit/remix found | Add exact mix/album/version and check duration mismatch diagnostics. |
| Cache bucket remains empty | Confirm bindings, cache secret, explicit permission allowlist, source rights, size restrictions, and `[FLAC CACHE SKIP]`. |
| Cache link returns 403 | Invalid/expired signature or changed signing key; request a fresh stream link. |
| Cache returns 404 | Object expired, missing, or cache disabled; resolve again from a source. |
| Cron cleanup absent | Check `0 * * * *` attached to the correct Worker and ensure `scheduled()` is deployed. |
| Personal audio unexpectedly accessible | **Expected security weakness in v3.7.9**: `/audio/personal/{index}.flac` is not authenticated. Do not use it for private files until fixed. |
| Opus plays despite Worker rules | BitChord may independently choose another addon or YouTube Music; Worker restrictions affect only this addon. |
| Old song IDs no longer resolve | Confirm original nine provider IDs/positions were not changed. |
| Public catalog returns no matches | Open catalogs have limited coverage and track-specific licenses; enabling them does not create mainstream FLAC releases. |

### Safe validation sequence

1. Back up current Worker and take note of the manifest version actually deployed.
2. Test `/manifest.json` and `/search` without exposing tokens.
3. Resolve a recording with permission for playback, observe `[FLAC PROBE]` and `[PLAYBACK HANDOFF]`, and verify **audible playback** in BitChord.
4. Simulate a dead primary source and confirm bounded equivalent-track rescue rather than wrong-version substitution.
5. If authorized for caching, confirm a cache write, signed playback, seeking, expiry, and scheduled cleanup.
6. Keep an eye on Workers requests/subrequests, CPU time, R2 storage/operations, and upstream API allowances.

## Source research and future roadmap

**The following items are exploratory. None has been incorporated into the v3.7.9 Worker.** Their inclusion here is a record of testing and plans, **not** a claim that their licenses or streaming permissions are established.

### v3.8.0: source expansion research

| Candidate | Findings from local-network tests or review | Decision |
| --- | --- | --- |
| **Funkwhale v2 (`open.audio`)** | Corrected v2 endpoint test: **9/9 successful** API requests. A later search-only/audio-eligibility trial: **3/3 searches**, median **948 ms**, but **zero eligible public FLAC candidates and zero byte probes**. | Research only; do not add before verified eligible playback. |
| **Audius** | Original search benchmark: **6/6 success**, median **110 ms**. Later trial: **3/3 searches**, median **855 ms**; **zero eligible public FLAC originals, zero byte probes**. Ordinary Audius playback is not a substitute for FLAC. | Research artist-authorized original downloads, not compressed streaming. |
| **ccMixter** | Original benchmark: **2/6 successful** JSON responses, no FLAC hints; other requests had network errors. | Deprioritized pending stability/format evidence. |
| **FLACidal** | Useful as an architectural reference for metadata matching, provider health, and fallbacks; desktop/downloader dependencies do not drop directly into Workers. | Reference only, not a provider. |
| **Soulseek P2P** | Peer sessions, queues and direct-network requirements do not fit a simple standalone Worker streaming API. | On hold; no Worker P2P integration. |
| **Sidify All-in-One** | Commercial desktop converter; output FLAC does not guarantee a lossless original. | Not a streaming source. |
| **LastWave** | Personal downloaded files underwent independent technical inspection; two uploaded examples passed FLAC integrity, but **original lossless provenance remains inconclusive**. | Not integrated as a provider; individual files require separate rights assessment. |
| **FlacMusicFinder** | Security, reliability, public-API, and provenance concerns. | **Explicitly excluded from development.** |

**Benchmark caveats:** Test results reflect particular endpoints, dates, network conditions, and small query samples. Metadata hints are not byte-level verification. The later trial made **no audio probes at all** because it identified no eligible public FLAC candidates. It cannot establish that a catalog has no FLAC files or that audio would play in BitChord.

For personal **authorized downloads**, artist/label FLAC files from Bandcamp, BOOTH, or other licensed download stores may provide clearer source provenance, but a purchased file is not automatically licensed for redistribution.

### Proposed v3.9.0: Pathfinder (not built)

The **Pathfinder** concept is a bounded, permission-aware fallback discovery layer:

```text
All active sources failed
     ↓
Search a curated set of permitted music APIs/catalogs
     ↓
Match artist + title + recording version / ISRC where available
     ↓
Verify playable FLAC bytes and provider permission
     ↓
Remember provider reference and last-verification status in D1
     ↓
Future request: resolve a fresh permitted playback URL
```

Desired safeguards include strict timeouts, per-provider and daily budgets, a queue for long discovery, deduplication, positive/negative provider health memory, signed or authenticated private routes, and **metadata-only storage unless audio caching is specifically allowed**. Avoid internet-wide scraping, unapproved copyright copying, or treating expiring CDN links as permanent.

**There is currently no D1 source registry, global web crawler, continuous autonomous discovery, or guaranteed last-resort song finder in v3.7.9.** No extra Cloudflare services should be enabled without checking current plan quotas and costs.

### Future privacy work

Before a private personal library can be treated as private, add real authentication/authorization to the `/audio/personal/` route, ensure user-specific access to matching search/stream endpoints, prevent public enumeration and token leakage, and validate range playback under authenticated requests. This is a **recommended future fix**, not currently shipped.

## Costs, security, and rights

- **Cloudflare free allowances are not a guarantee of zero charges.** Monitor request counts, CPU, subrequests, R2 storage and operations, and any optional Queues/D1 usage if introduced later. Billing limits vary by product, plan, and time.
- **Keep private buckets private and protect Worker routes.** A private R2 bucket does not make `/audio/personal/` private; signed `/audio/cache/` links are bearer credentials until they expire.
- **Respect licenses and agreements.** Discovery, streaming, downloading, storage, caching, and charging other users are distinct permissions. Personal use does not automatically grant public redistribution rights.
- **Do not bypass access controls.** Do not adapt protected subscription APIs, paywalls, app credentials or unofficial proxies without authorization.
- **A FLAC header proves codec/container identity, not original-master provenance.** Upsampled or lossy-derived FLAC may still pass signature checks.
- **Protect logs and code.** Do not commit private upstream URLs, signed links, request identifiers, tokens, or raw network logs. Sanitize any support examples.
- **Publicly listed source code requires licensing clarity.** A GitHub repository without a license does not automatically grant unrestricted reuse.
- **Provider health memory and cache budgets are best-effort.** Some data is per-isolate and not shared globally; a 2 GiB app target is not an enforceable billing limit.

## Release history

| Version | Main improvement |
| --- | --- |
| **v3.7.9** | Longer configurable strict FLAC probe, improved health-based selection, expanded bounded rescue, safe playback-handoff diagnostics. |
| **v3.7.8** | Do not negative-cache inconclusive FLAC probes; retry after recoverable verification failure. |
| **v3.7.7** | Japanese/Romaji and Vocaloid/anime matching, FLAC-byte probing, Rabbit Hole alias/version fix. |
| **v3.7.6** | Optional E-AC-3 JOC Atmos requests, explicitly separate from stereo FLAC. |
| **v3.7.5** | 36-hour private R2 temporary cache, signed playback, permission allowlist and hourly cleanup. |
| **v3.7.4** | Optional Openverse and Wikimedia Commons discovery. |
| **v3.7.3** | Improved version-aware recording matching and mismatch diagnostics. |
| **v3.7.2** | Game-soundtrack matching and diagnostics. |
| **v3.7.1** | Staged search and responsiveness optimizations. |
| **v3.7.0** | Internet Archive, Jamendo and optional personal R2 library support. |
| **v3.6.1** | Provider cooldowns and better ordering. |
| **v3.6.0** | Faster stream resolution and known-lossy rejection. |
| **v3.5.0** | Cross-provider FLAC rescue and matching. |

## Documentation

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare R2 lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [Funkwhale documentation](https://docs.funkwhale.audio/)
- [Audius developer documentation](https://docs.audius.org/)
- [Openverse API](https://api.openverse.org/v1/)
- [Wikimedia Commons / MediaWiki API](https://www.mediawiki.org/wiki/API:Main_page)
- [Jamendo API](https://developer.jamendo.com/v3.0/tracks)
- [Internet Archive developer documentation](https://archive.org/developers/)

---

**Built for more reliable, permission-aware personal lossless listening. Verify the recording, protect the library, and keep the provider indices stable.** 🎵
