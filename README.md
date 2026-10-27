# BitChord FLAC Aggregator 🎧

**A practical example of a FLAC-first music addon built with JavaScript and Cloudflare Workers.** This repository's documentation explains the architecture, setup process, performance improvements, and lessons learned so that other developers can build **their own** permission-aware music aggregators.

> **Reference implementation:** `v3.7.10` · Smart Provider Priority  
> **Platform used by this project:** Cloudflare Workers (JavaScript)  
> **Client interface:** BitChord-compatible `manifest`, `search`, and `stream` endpoints  
> **Audience:** Learners, hobby developers, and operators integrating sources they are authorized to use  
> **Status:** The project owner reported successful real-world operation of v3.7.10. Availability, quality, and compatibility for other installations have not been independently established.  
> **Affiliation:** Independent, unofficial project. Not affiliated with BitChord, Cloudflare, or the music services discussed here.

**This README is a guide, not a public copy of the owner's ready-to-deploy Worker.** The private implementation contains third-party endpoint identifiers that are intentionally **not published**. To reproduce a similar system, supply your own authorized providers and implement or obtain compatible Worker code. An account and this README alone will not create a working music service.

> [!IMPORTANT]
> **Lossless has multiple meanings.** A provider's `LOSSLESS` label is only metadata. A `fLaC` file signature establishes that bytes look like a FLAC stream, not that the full file is valid, the original master was lossless, or the client successfully played it. Always test these independently.

## Contents

- [What does this project do?](#what-does-this-project-do)
- [Start here: build your own addon](#start-here-build-your-own-addon)
- [How the aggregator works](#how-the-aggregator-works)
- [Choosing and configuring providers](#choosing-and-configuring-providers)
- [Smart Provider Priority in v3.7.10](#smart-provider-priority-in-v3710)
- [FLAC verification and optional Atmos](#flac-verification-and-optional-atmos)
- [Environment variables and Cloudflare bindings](#environment-variables-and-cloudflare-bindings)
- [Optional R2 storage](#optional-r2-storage)
- [API contract and examples](#api-contract-and-examples)
- [Testing your deployment](#testing-your-deployment)
- [Troubleshooting](#troubleshooting)
- [Security, costs, and rights](#security-costs-and-rights)
- [Porting to another hosting platform](#porting-to-another-hosting-platform)
- [Development history and roadmap](#development-history-and-roadmap)
- [Further reading](#further-reading)

## What does this project do?

A music aggregator searches **multiple compatible sources**, collects candidate recordings, selects an appropriate source, and returns a stream URL to a supported player. If the first source fails, it can try another **matching recording** rather than playing a different edit or remix.

The project's design goals are:

- **FLAC-first playback:** avoid unintended MP3, AAC, Opus, or other lossy substitutions *inside this addon*.
- **Correct recordings:** consider artist, song title, mix/version, and available duration, including Japanese/Romaji and Vocaloid producer variants.
- **Responsive searches:** consult more reliable sources early and avoid indefinitely waiting for slow services.
- **Fault tolerance:** retry boundedly, use temporary cooldowns, and attempt equivalent-track recovery.
- **Observable outcomes:** distinguish search results, actual FLAC-byte checks, Worker handoff, and real client playback.
- **Optional storage:** maintain a separate personal R2 library or short-lived cache only when appropriate and authorized.

| Capability | Reference implementation v3.7.10 |
| --- | --- |
| Compatible upstream addons | Nine configured **stable slots**: `discord_0` through `discord_8`; actual endpoint URLs are private |
| Search | Staged, time-bounded, performance-prioritized |
| Playback | Strict FLAC verification by default, followed by bounded alternative-source rescue |
| Matching | Song/version/duration matching and conservative Japanese/Vocaloid aliases |
| Optional discovery | Internet Archive; Jamendo, Openverse, Wikimedia Commons when configured |
| Storage | Separate optional R2 personal library and permission-controlled 36-hour cache |
| Atmos | Optional E-AC-3 JOC mode, **separate from lossless FLAC** |
| Source ordering | Seeded priorities that adjust from recent verified stream outcomes and latency |
| Persistent global ranking database | **Not implemented**; health scores are held in individual Worker isolates |

## Start here: build your own addon

This is the recommended order for someone starting from scratch. **You do not need R2, Cron Triggers, Atmos, or nine providers to build your first version.** Begin with one authorized source and expand only when the basics work.

### 1. Prepare the essentials

You need:

1. A Cloudflare account and access to **Workers & Pages**, or a different JavaScript server runtime you intend to adapt.
2. Working knowledge of JavaScript, JSON, HTTP requests, and HTTP response codes.
3. At least one **authorized** music catalog or compatible addon with a documented search/stream interface.
4. Worker source code that implements BitChord's expected routes. This README describes the structure but **does not contain a complete standalone Worker**.
5. A BitChord installation or another client able to test the same API contract.

Do **not** treat a publicly accessible search endpoint as automatic permission to stream, download, cache, redistribute, or charge for its recordings. Check the provider's terms, your authorization, and recording-level licenses.

### 2. Create a Worker

**Dashboard route:**

1. Sign in to [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Open **Workers & Pages**, choose **Create application**, and create a Worker project.
3. Open the code editor or connect your own source repository.
4. Add your JavaScript Worker code and deploy to a `workers.dev` domain or a permitted custom domain.
5. Test its public `/manifest.json` endpoint before attempting music searches.

**Command-line route:** install a supported version of Node.js, then follow Cloudflare's current project scaffolding flow:

```bash
npm create cloudflare@latest -- my-music-addon
cd my-music-addon
# Implement and test the Worker in the generated src/ directory.
npx wrangler dev
# Deploy only after configuration and tests are ready.
npx wrangler deploy
```

Choose a **JavaScript Worker** when prompted. The generated project is a starting scaffold, **not** a working BitChord music addon. Cloudflare's project generator and dashboard labels may evolve; consult the linked official setup documentation.

### 3. Build and test the minimum endpoints

A compatible addon typically needs three public routes:

```text
GET /manifest.json
GET /search?q=Artist%20Song&quality=LOSSLESS
GET /stream/{provider}:{trackId}?quality=LOSSLESS
```

Implement them according to the **client's currently supported response schema**. Avoid inventing a response object or assuming any URL returned by an upstream is a playable FLAC. If you are adapting this project, review the actual manifest, routing, error handling, and ID encoding in your copy of the Worker.

**Minimum first-release checklist:**

- Manifest returns valid JSON and is recognized by the client.
- Search returns correctly shaped track metadata from an authorized catalog.
- Stream resolution returns an authorized, reachable playback URL only for an acceptable recording.
- A missing recording yields a meaningful error; it never silently becomes unrelated audio.
- Actual playback and seeking work on the client.
- Credentials, signed URLs, and personal listening histories are not exposed in logs.

### 4. Add resilience gradually

After the minimum addon works, introduce features in this order: strict FLAC checks, timeout/error handling, recording-aware matches, second-provider rescue, health-based ranking, optional open catalogs, and **only then** optional storage. Benchmark each step with known-good and deliberately failing examples.

### 5. Deploy carefully

Back up the previous working Worker. Keep provider IDs stable. Verify `/manifest.json`, try real searches and playback, inspect sanitized logs, and roll back if an update introduces regressions. **Local unit tests do not prove live provider availability or audible playback.**

## How the aggregator works

```text
BitChord-compatible client
  |
  +-- GET /manifest.json
  |
  +-- GET /search?q=...
  |      |
  |      +-- Rank authorized providers using seeded + recent health scores
  |      +-- Search the fastest group first
  |      +-- Expand to backups / optional catalogs if needed
  |      +-- Normalize title, artist, version and duration
  |      +-- Return candidate tracks (NOT yet proof of playable FLAC)
  |
  +-- GET /stream/{provider}:{trackId}?quality=LOSSLESS
         |
         +-- Check eligible unexpired, permitted R2 cache (optional)
         +-- Resolve requested upstream
         +-- In strict mode, inspect initial FLAC bytes
         +-- If unavailable, find equivalent recording from other sources
         +-- Return accepted playback metadata, or a clear error
         +-- Optionally cache a permitted FLAC copy in the background

BitChord must still fetch/decode/play the resolved stream itself.

Hourly Cloudflare Cron Trigger (optional cache): 0 * * * *
  +-- Delete expired temporary objects from FLAC_CACHE_BUCKET only
```

A resolver's HTTP `200` or `[PLAYBACK HANDOFF]` message means **the Worker handed a response to the client**. It does not establish that bytes were played. The client can also independently use other addons or fallback mechanisms outside this Worker's control.

## Choosing and configuring providers

### Use compatible, permitted sources

A valid provider should offer a search interface, a way to resolve recordings, reasonable responsiveness, a clear authorization model, and a usable FLAC output where available. Some search APIs only return metadata or lossy audio. **Discoverability is not the same as FLAC availability.**

For reference, v3.7.10 uses nine compatible-addon slots, plus optional public-source adapters. **The live provider URLs are intentionally not listed in this README** because some contain access identifiers. You are expected to supply and verify your own endpoints.

### Keep source indexes stable

In this implementation, track IDs refer to a source position, such as `discord_3`. Reordering the `DISCORD_ADDONS` array may cause saved tracks to resolve against the wrong upstream.

**Illustration only; these URLs are not real providers:**

```js
// Example structure, NOT a complete deployable addon.
const DISCORD_ADDONS = [
  "https://YOUR-AUTHORIZED-PROVIDER-A.example",
  "https://YOUR-AUTHORIZED-PROVIDER-B.example"
];
// Stable IDs: discord_0 and discord_1.
// Prefer changing the query order, never the positions of these URLs.
```

The current private reference source stores its provider array in JavaScript. If you are creating a new public project, consider supplying sensitive endpoints through **environment secrets** or an authenticated configuration service instead. That requires writing the corresponding loader code; merely creating a Cloudflare secret does **not** automatically replace a hardcoded array.

A compatible upstream may accept a base URL or a full `/manifest.json` URL. The reference Worker normalizes those shapes for its search/stream calls, but **other implementations may differ**. Test the actual upstream contract rather than assuming a generic website URL is a compatible addon.

### Source types

| Source type | When useful | Caveat |
| --- | --- | --- |
| Authorized compatible addon | Existing music catalogs with matching search/stream API | Quality, access, reliability, and terms differ by endpoint |
| Internet Archive | Public archival discovery and qualifying FLAC files | Recordings and licenses vary |
| Jamendo | Authorized artist catalog queries | Requires your client ID; API and licensing limitations |
| Openverse / Wikimedia Commons | Publicly indexed or openly licensed audio | License must be checked for the actual file |
| Personal R2 library | Owner-uploaded authorized FLAC | Current reference audio route is **not authenticated** |
| Temporary R2 cache | Permitted reuse of recently fetched recordings | Separate private bucket, allowlist, limits, and signed URLs |

## Smart Provider Priority in v3.7.10

Earlier releases used static preferences and provider health checks. **v3.7.10 makes source ordering responsive to observed, accepted FLAC resolutions**, with search-only responsiveness treated as weaker evidence.

### What influences ranking?

- A **verified FLAC stream resolution** is positive evidence of provider usefulness.
- Faster successful FLAC resolution can improve a provider's relative score.
- Track-specific `404`/`410` responses slightly reduce availability estimates, but do **not** automatically ban the entire provider.
- Upstream `429` and server-side failures can trigger temporary cooldowns.
- Repeated search failures and long search latency can lower a provider's search priority.
- One lucky response cannot establish long-term provider superiority; recent outcomes are weighted and bounded.

**Initial ordering in this project's current private nine-slot setup:** `discord_1`, `discord_4`, `discord_3`, `discord_8`, `discord_7`, `discord_2`, `discord_5`, `discord_6`, `discord_0`. This is **specific to the owner's observed sample and subsequent endpoint-refresh exploration**, not a universal recommendation. New endpoints at indexes 1, 3, and 8 were refreshed in the same v3.7.10 release, so prior URL performance must not be mistaken for new URL performance.

The Worker **does not reorder the underlying array**. It chooses a query/rescue order from the stable IDs and changes that preference while the isolate runs.

> [!NOTE]
> `STREAM_HEALTH`, `SEARCH_HEALTH`, and cooldown state are **in-memory, per-Worker-isolate** observations. They reset on cold starts and are not shared worldwide. Do not describe this as a permanent, globally trained recommender. Durable rankings across regions would need an additional persistence and aggregation design.

### How to evaluate source priority yourself

Test multiple tracks and genres across the same set of authorized sources. Record (1) search success, (2) whether a FLAC was **byte-verified**, (3) time to acceptable stream handoff, (4) rate limits/timeouts, and (5) whether the client truly played. Give fresh replacement endpoints their own trial history. Avoid optimizing for fast **search results** that repeatedly fail at playback.

## FLAC verification and optional Atmos

### Three separate checks

| Question | What is established? |
| --- | --- |
| Are the initial bytes `fLaC`? | A FLAC file/stream signature was seen; useful to reject mislabeled codecs |
| Was the original audio mastered from lossless material? | **Not established** by the header; even a fully valid FLAC may contain lossy-transcoded audio |
| Did the client play the whole song without error? | **Not established** by a Worker's JSON response; test on the device |

### FLAC verification settings

| `FLAC_VERIFY_MODE` | Effect | Recommendation |
| --- | --- | --- |
| `strict` (default) | Requires confirmed FLAC bytes; inconclusive checks are rejected for that attempt but remain retryable | **Recommended** for FLAC-only operation |
| `adaptive` | May accept unresolved checks based on FLAC metadata | Not a strict FLAC guarantee |
| `off` | Skips external byte probing | Diagnostic/trusted-environment use only |

**v3.7.10 correction:** Unrecognized `FLAC_VERIFY_MODE` values now fall back to **`strict`** in the current Worker code. Earlier README versions described a weaker fallback for an older build; that warning no longer applies to the inspected v3.7.10 source. Setting `strict` explicitly remains a good operational practice.

`FLAC_PROBE_TIMEOUT_MS` defaults to **1,600 ms** and is clamped to **900–2,200 ms**. Probe timeouts, inaccessible CDN URLs, and 429s are **inconclusive**, not proof that a recording is lossy. Strict mode must reject an unverified attempt without permanently marking the song as bad.

For perspective, the reference implementation also uses an approximately **2,700 ms interactive search budget** and **6,500 ms bounded rescue budget**. These are software budgets, not guaranteed playback-start times.

### Optional Dolby Atmos

When explicitly enabled, this Worker can accept **E-AC-3 JOC** streams on a request containing `atmos=auto`:

- Set `ATMOS_ENABLED=true` **and** send an Atmos-specific request.
- Atmos is **lossy immersive audio**, not FLAC and not a Hi-Res lossless substitute.
- Standard non-Atmos requests remain FLAC-only under the normal verification policy.
- The temporary FLAC cache does **not** store Atmos audio.
- Playback still depends on upstream availability and the client/device's Atmos support.

## Environment variables and Cloudflare bindings

These names describe the **v3.7.10 reference implementation**, not universal BitChord requirements. Create only those needed by features you actually enable.

| Variable or binding | Kind | Purpose |
| --- | --- | --- |
| `FLAC_VERIFY_MODE` | Optional text | `strict` (default), `adaptive`, `off` |
| `FLAC_PROBE_TIMEOUT_MS` | Optional text | Default `1600`; allowed range `900..2200` ms |
| `ATMOS_ENABLED` | Optional text | `true` permits explicit Atmos requests |
| `OPENVERSE_ENABLED` | Optional text | `true` enables Openverse adapter |
| `COMMONS_ENABLED` | Optional text | `true` enables Wikimedia Commons adapter |
| `JAMENDO_CLIENT_ID` | Secret / authorized credential | Required only for optional Jamendo queries |
| `FLAC_BUCKET` | R2 bucket binding | Optional permanent personal-library storage |
| `FLAC_CACHE_BUCKET` | **Different** R2 bucket binding | Optional short-lived temporary cache |
| `FLAC_CACHE_ENABLED` | Optional text | `true` enables cache when prerequisites are met |
| `FLAC_CACHE_SIGNING_KEY` | **Secret** | Strong, random signing key of 32+ characters |
| `FLAC_CACHE_ALLOWED_PROVIDERS` | Optional text | Comma-separated provider IDs **authorized** for caching; empty denies writes |

In the Cloudflare dashboard, use the Worker's **Settings → Variables and Secrets** for values/secrets, and its **Bindings** section for R2 buckets. UI names may change.

For Wrangler-based projects, bind R2 through `wrangler.toml` or `wrangler.jsonc`; an example `wrangler.toml` excerpt is:

```toml
# Add ONLY when you actually create the corresponding R2 buckets.
[[r2_buckets]]
binding = "FLAC_BUCKET"
bucket_name = "your-personal-flac-bucket"

[[r2_buckets]]
binding = "FLAC_CACHE_BUCKET"
bucket_name = "your-separate-temporary-cache-bucket"

[triggers]
crons = ["0 * * * *"]
```

This is a **configuration excerpt**, not a complete Wrangler project. Do not enable Cron without the `scheduled()` handler and its intended maintenance policy. Use `wrangler secret put FLAC_CACHE_SIGNING_KEY` or the dashboard's **Secret** field to store sensitive values. Do not commit `.dev.vars`, `.env`, or literal credentials to a public repository.

## Optional R2 storage

R2 is **not required** for ordinary provider aggregation. Introduce it only when you need storage, understand its costs, and have the rights to store the audio.

### A. Personal library: `FLAC_BUCKET`

Use a dedicated bucket for recordings you are entitled to store. In the current reference Worker, register tracks using `PERSONAL_FLAC_TRACKS`:

```js
const PERSONAL_FLAC_TRACKS = [
  { key: "MyMusic/Artist - Song.flac", title: "Song", artist: "Artist", duration: 240 }
];
```

The existing route is `/audio/personal/{index}.flac`, with GET/HEAD and byte-range support.

> [!CAUTION]
> **Current privacy limitation:** This route is **not authenticated in v3.7.10**. A private R2 bucket does not make a public Worker route private. Anyone who discovers a valid personal-audio URL/index may retrieve the file. Do **not** put private or non-redistributable recordings behind this public endpoint. Before using it as a truly private library, implement and test authentication, authorization, non-enumerable access, and protected searches.

### B. Temporary cache: `FLAC_CACHE_BUCKET`

Create a **separate private R2 bucket** (no public `r2.dev` or public bucket domain), bind it as `FLAC_CACHE_BUCKET`, and enable caching only for recordings/providers with appropriate copying permission. Leave `FLAC_CACHE_ALLOWED_PROVIDERS` empty during initial setup.

| Cache policy | Reference implementation |
| --- | --- |
| Retention | **36 hours** from upload; expired entries not served |
| Physical cleanup | Hourly `scheduled()` handler at `0 * * * *`, executed on UTC schedule |
| Individual file maximum | **100 MiB** |
| Target total storage | Approximately **2 GiB**, a best-effort software target rather than an enforced billing cap |
| Missing content length | Does **not** automatically cache unknown-size files |
| File identification | Requires downloaded bytes beginning with `fLaC` |
| Permission | Explicit `FLAC_CACHE_ALLOWED_PROVIDERS` after verifying the relevant license/terms |
| First-play response | Return source stream first; background save is best-effort via `ctx.waitUntil()` |
| Cached playback | Short-lived HMAC-signed URL, normally up to **6 hours**, also bounded by file expiry; range support |
| R2 keys | Hashed names under `bc-flac-cache-v1/` |

Configure hourly Cron **only if** the correct `scheduled()` handler is deployed and you understand its cleanup scope. Never aim temporary cleanup at the personal-library bucket. Cloudflare Cron changes can take time to propagate. An R2 lifecycle rule for the temporary prefix can provide additional cleanup insurance but is **not** the exact 36-hour read-expiry mechanism.

Example signing-key generation:

```bash
openssl rand -base64 48
```

Store the output as a Cloudflare **secret**, never in a README or source file. Signed cache URLs are **bearer links**; anyone who obtains an unexpired link may be able to replay it.

## API contract and examples

The routes below describe the reference project. They are **not a substitute for the official BitChord response schema**.

| Method | Example route | Function |
| --- | --- | --- |
| `GET` | `/manifest.json` | Addon metadata, version `3.7.10`, supported resources |
| `GET` | `/search?q=Artist%20Song&quality=LOSSLESS` | Candidate track metadata; **not yet proof** of playable FLAC |
| `GET` | `/stream/discord_0:{trackId}?quality=LOSSLESS` | Resolve acceptable FLAC or return an error |
| `GET` | `/stream/discord_0:{trackId}?quality=LOSSLESS&atmos=auto` | Explicit Atmos path, only when enabled |
| `GET`, `HEAD` | `/audio/cache/{hash}.flac?exp=...&sig=...` | Signed temporary-cache bytes, including range playback |
| `GET`, `HEAD` | `/audio/personal/{index}.flac` | Personal-library bytes; **currently unauthenticated** |

Use a **real valid ID emitted by your own search implementation**, not the literal `{trackId}` placeholder. Do not expose live signed audio links or provider tokens in examples.

Simple, harmless smoke tests:

```bash
curl -i "https://YOUR-WORKER.workers.dev/manifest.json"
curl -i "https://YOUR-WORKER.workers.dev/search?q=Artist%20Song&quality=LOSSLESS"
```

Stream tests require an **authorized**, real track ID and must be followed by a device-level playback test. Never interpret a search-result quality label as evidence that the stream will play.

## Testing your deployment

Use a small, varied test set rather than testing only a few well-known songs. Include one recording known to have an official FLAC source, a remix-versus-original pair, Japanese/Romaji spelling variants if relevant, one intentionally unavailable item, and a slow/rate-limited provider in a local mock.

### Suggested test sequence

1. **Syntax and local regression:** for example, run `node --check your-worker.js` and your project's own mocked tests.
2. **Manifest and search:** verify the client recognizes the addon and that the returned metadata matches the intended song.
3. **FLAC verification:** test real `fLaC` bytes, known MP3/Opus responses mislabeled as lossless, and inconclusive/time-limited probes.
4. **Cross-source rescue:** make the primary source return 404; verify the exact recording is found elsewhere without substituting a different remix.
5. **Rate limiting:** simulate HTTP 429 and confirm cooldown and recovery behavior without retry storms.
6. **Actual playback:** confirm listening and seeking in BitChord on the devices and networks you expect to support.
7. **Optional cache:** only with permitted recordings, verify save, signed playback, expiry, seeking, and cleanup.
8. **Longer-term monitoring:** compare performance at different times and track improvements without sharing sensitive logs.

### Useful log markers

| Marker | Meaning |
| --- | --- |
| `[PROVIDER PRIORITY]` | Ranked query/rescue order for the current request |
| `[SEARCH PERFORMANCE]`, `[SEARCH READY]` | Query timing and result count; tracks are **not yet byte-verified** |
| `[UPSTREAM HTTP]`, `[UPSTREAM TIMEOUT]` | Provider errors and connectivity issues |
| `[PROVIDER COOLDOWN]` | Temporary isolation of a failing/rate-limited provider |
| `[MATCH REASONS]` | Candidate acceptance/rejection clues, such as different edits/remixes |
| `[FLAC PROBE]` | Confirmed / known non-FLAC / inconclusive signature check |
| `[FLAC RESCUE SUCCESS]`, `[FLAC RESCUE EXHAUSTED]` | Outcome of equivalent-track recovery |
| `[FLAC READY]`, `[PLAYBACK HANDOFF]` | Resolver succeeded and returned playback data, **not proof of listening** |
| `[STREAM UNAVAILABLE]` | No acceptable stream handed off |
| `[FLAC CACHE HIT]`, `[FLAC CACHE SAVED]`, `[FLAC CACHE SKIP]` | Optional cache status |

### Interpreting a sample benchmark responsibly

A previous owner-side Cloudflare log sample included **20 accepted FLAC resolutions out of 44 stream requests**; another **24 returned unavailable**. Of those 20 accepted resolutions, 15 came from one source and four from another. This helped establish a *starting* priority, **not a universal success rate**. It does not demonstrate client playback or the reliability of newly replaced endpoint URLs. All performance claims are dependent on the test sample, licenses, network, and specific providers.

## Troubleshooting

| Symptom | Things to investigate |
| --- | --- |
| Search shows `LOSSLESS`, but playback skips | The stream may be missing, mislabeled, inaccessible, expired, or rejected by strict FLAC probing |
| `[FLAC READY]` followed by a skip | The client still has to fetch/decode the URL; inspect URL expiry, HTTP Range, network reachability, and playback support |
| Probe timeout | Keep `strict`; inspect CDN response times and use `FLAC_PROBE_TIMEOUT_MS` conservatively, up to the implemented 2,200 ms cap |
| Repeated 404/410 | Recording or provider ID may no longer exist; try an equivalent authorized source |
| 429/502/503/504 | Rate limiting, provider failure, or gateway issue; avoid aggressive retries |
| Wrong edit/remix | Compare title/version tags, duration, and `[MATCH REASONS]` |
| Japanese title not found | Try the original script, accepted romanization, or correct producer name |
| Provider suddenly ranks low | Check actual verified FLAC success, recent latency, 429 cooldown, and whether its endpoint has changed |
| Rankings reset | Expected: current scores are stored only in each Worker isolate |
| Old saved track breaks after a provider change | Confirm the existing source **index** still refers to the expected provider |
| R2 cache stays empty | Optional configuration absent, permission allowlist empty, source not cacheable, file too large, or background save failed |
| Cache link gives 403/404 | Signature expired/invalid, object expired/deleted, or R2 not configured |
| R2 personal audio accessible to others | Current `/audio/personal/` route has **no access control**; disable exposure until protected |
| Opus plays despite FLAC-only Worker | BitChord may independently select another addon/source, outside this Worker's control |
| Optional public catalog empty | Those APIs may have limited FLAC coverage; metadata availability does not guarantee authorized audio |

## Security, costs, and rights

**Keep the following protections from the first prototype onward:**

- **Never publish credentials or private endpoint identifiers.** Keep provider access tokens, signed playback URLs, Worker account IDs, personal network identifiers, and raw logs out of GitHub issues and README files. Rotate exposed credentials when appropriate.
- **Protect your routes, not just your buckets.** A private R2 bucket can still be exposed by an unauthenticated Worker route. The reference personal-library endpoint needs access control before sensitive tracks are used.
- **Treat source authorization separately from playback capability.** A source that serves FLAC is not automatically authorized for downloading, caching, redistribution, or use in a public music service.
- **Use a license for any code you want others to reuse.** This README explains concepts and configuration; it does **not** grant rights to private provider credentials or third-party recordings. If publishing reusable code, choose an explicit software license and verify dependencies.
- **Plan for costs.** Free-plan allowances differ by Cloudflare product and can change. R2 storage, operations, Workers usage, and optional future D1/Queues each have their own limits/billing. The 2 GiB cache target is not a spending cap.
- **Avoid access-control bypasses.** Do not rely on leaked tokens or unofficial subscription proxies. Respect provider policies and copyright.
- **Audit logs.** Prefer sanitized provider indexes, status codes, and aggregate timing over raw URLs, IPs, identifiers, or listener data.

> [!WARNING]
> A valid FLAC file may have originated from a lossy source. Neither a frequency-spectrum checker nor the `fLaC` magic header can prove source provenance. For stronger confidence, acquire a trustworthy artist/label release and compare the same version/master.

## Porting to another hosting platform

Cloudflare Workers are the **only runtime for which the current reference implementation is prepared and tested**. You can adapt the architecture to Node.js, another edge runtime, or a server, but **do not assume the source works unchanged**.

A port needs equivalents for:

- Request routing, streaming responses, cancellations, request limits, and standard Web Crypto functionality.
- Timeout handling and bounded parallel searches.
- R2 bindings or compatible object-storage SDKs for optional storage.
- Cron Triggers or a separately scheduled cleanup job.
- Secrets/configuration management and restrictive public-route authentication.
- Testing of byte-range requests, caching, and client network access in the chosen runtime.

**For beginners, Cloudflare Workers is the documented path.** Start with stateless search/stream behavior; migrate to other hosting only when you understand the platform differences.

## Development history and roadmap

### Current release: v3.7.10

- Added **Smart Provider Priority** with a seeded order plus in-isolate observation of **verified FLAC** resolution success, latency, misses, upstream errors, and search health.
- Applied an updated nine-slot endpoint configuration **without changing IDs**. Private endpoints are intentionally omitted here.
- Kept strict FLAC probing, equivalent-track rescue, Japanese/Vocaloid aliases, optional public-source integrations, separate R2 functions, and optional Atmos.
- Confirmed local syntax/mock regression tests. The project owner also reported that the updated version works in their setup; this is **not** an independent uptime guarantee.

### Release history

| Version | Main change |
| --- | --- |
| **3.7.10** | Smart performance-based provider ordering while preserving IDs; refreshed live provider endpoints in the **same** version |
| **3.7.9** | Configurable, longer strict FLAC probe; bounded recovery and clearer handoff diagnostics |
| **3.7.8** | Retry inconclusive FLAC verification without falsely marking it permanently bad |
| **3.7.7** | Japanese/Romaji/Vocaloid and anime matching improvements |
| **3.7.6** | Opt-in E-AC-3 JOC Atmos mode, separate from FLAC |
| **3.7.5** | Private 36-hour R2 temporary cache and signed playback |
| **3.7.4** | Optional Openverse and Wikimedia Commons discovery |
| **3.7.3** | Better version-aware recording matching |
| **3.7.2** | Game soundtrack matching and diagnostics |
| **3.7.1** | Staged-search responsiveness |
| **3.7.0** | Internet Archive, optional Jamendo, and optional personal R2 library |
| **3.6.1** | Cooldowns and failure-aware ordering |
| **3.6.0** | Faster resolution and lossy rejection |
| **3.5.0** | Cross-provider FLAC rescue |

### Research notes (not shipping integrations)

The team has evaluated additional possibilities, including Funkwhale, Audius, and ccMixter. Small API/search tests did **not** establish verified, authorized FLAC playback for those sources. LastWave downloads were technically valid FLAC in two personal file examinations, but their **original lossless provenance was inconclusive**. FLACidal is an architectural reference, not a Cloudflare streaming integration; Soulseek's peer-to-peer networking does not directly fit a simple standalone Worker. **FlacMusicFinder is deliberately excluded from the roadmap.** None of these names implies approved access or live compatibility.

### Potential future improvements

- **v3.8.0 research:** validate additional sources and improve provider-ranking evidence using longer, privacy-safe performance observations. Adding a provider requires compatible APIs, playable eligible FLAC, and appropriate rights, not just a successful search request.
- **Pathfinder concept (not built):** a later opt-in discovery layer that searches **permitted** catalogs, validates exact recordings, and stores limited source references/verification status in Cloudflare D1. Storing a reference is different from copying the audio; neither provides a license to redistribute.
- **Privacy hardening:** signed or authenticated personal-library playback, protected personal search results, and defenses against predictable-index enumeration.
- **Durable ranking:** store aggregate, non-sensitive health statistics across Worker isolates rather than treating in-memory state as permanent learning.

There is **no Pathfinder crawler, no persistent D1 provider registry, and no guaranteed every-song FLAC finder in v3.7.10**.

## Further reading

- [Cloudflare Workers: dashboard quickstart](https://developers.cloudflare.com/workers/get-started/dashboard/)
- [Cloudflare Workers: CLI quickstart](https://developers.cloudflare.com/workers/get-started/guide/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [R2 Workers API and bindings](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [R2 object lifecycle policies](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [Internet Archive developer documentation](https://archive.org/developers/)
- [Jamendo API](https://developer.jamendo.com/v3.0/tracks)
- [Openverse API](https://api.openverse.org/v1/)
- [Wikimedia Commons / MediaWiki API](https://www.mediawiki.org/wiki/API:Main_page)

---

**Build your own responsibly:** begin with an authorized source, verify FLAC bytes, keep saved provider IDs stable, protect private audio, and measure *actual playback* rather than treating a search badge as proof. 🎵
