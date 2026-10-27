// PUBLIC REFERENCE IMPLEMENTATION (sanitized from private v3.7.10)
// No private upstream configuration, R2 objects, access tokens or user data.
// Audio rights remain source-specific; do not treat this as a licensed catalog.
// SECURITY: personal R2 playback and discovery are deliberately disabled
// in this public build until proper authentication is implemented.
// This version uses ADDON_0_URL through ADDON_8_URL secret bindings.

// ============================================================================
// 1. PROVIDER CONFIGURATION (PUBLIC REFERENCE BUILD)
// ============================================================================
// No live upstream URLs, tokens, or personal endpoints are committed here.
// Configure ADDON_0_URL ... ADDON_8_URL as Cloudflare Worker secrets or
// equivalent environment bindings. Positions remain fixed for saved track IDs.
// Only use providers you are authorized to access, and obey their terms.
const DISCORD_ADDONS = Object.freeze(Array(9).fill("")); // Fixed ID count only.
function configuredAddonUrl(index, env = {}) {
  if (!Number.isInteger(index) || index < 0 || index >= DISCORD_ADDONS.length) return "";
  const candidate = String(env?.[`ADDON_${index}_URL`] || "").trim();
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    // Refuse plaintext transport, embedded basic-auth and nonstandard ports.
    // Do not log candidate when invalid; it may contain private credentials.
    if (url.protocol !== "https:" || url.username || url.password || url.port) return "";
    return candidate;
  } catch { return ""; }
}
function configuredAddons(env = {}) {
  return DISCORD_ADDONS.map((_, index) => configuredAddonUrl(index, env));
}

// ============================================================================
// 2. OPTIONAL PUBLIC CATALOG SOURCES (respect rights and API rules)
// ============================================================================
const FALLBACK_SOURCES = {
  SAAVN_API: "",
  PIPED_API: "",
  IA_ENABLED: true
};

// OPTIONAL personal FLAC library. Upload legally held .flac files to an R2
// bucket bound as FLAC_BUCKET, and list each track here. Leave [] for free
// public-source-only operation. Objects become streamable via this Worker.
const PERSONAL_FLAC_TRACKS = [
  // { key: "MyMusic/Artist - Song.flac", title: "Song", artist: "Artist", duration: 240 }
];

// Jamendo requires your OWN free client ID; configure Cloudflare variable
// JAMENDO_CLIENT_ID. The read API can be used noncommercially under its terms.
// No Jamendo request is made when it is unset.
// OPTIONAL R2 36-hour read-through cache (v3.7.5): configure a SEPARATE
// private R2 bucket bound as FLAC_CACHE_BUCKET. It must not be public via r2.dev.
// Requires FLAC_CACHE_ENABLED=true, FLAC_CACHE_SIGNING_KEY (32+ random chars),
// and an explicit comma-separated FLAC_CACHE_ALLOWED_PROVIDERS allowlist.
// Only cache audio you are permitted to temporarily copy. Unknown sources are
// never cached by default; example permit after reviewing each file's license:
// FLAC_CACHE_ALLOWED_PROVIDERS=openverse,commons
// Cache uses background R2 writes; a failed/slow write NEVER blocks playback.
// An hourly Cron Trigger runs scheduled() to physically delete expired files.
// Additional no-cost public-source adapters (disabled until explicitly opted in):
// Cloudflare Worker env vars: OPENVERSE_ENABLED=true and/or COMMONS_ENABLED=true.
// No LastWave, TIDAL, Qobuz, or paid account access is added. Anonymous public APIs
// enforce quotas; enabling these sources does not confer permission to distribute
// third-party recordings. Public-source FLAC URL bytes are checked where supported.
// v3.7.6: ATMOS_ENABLED=true is optional. Atmos is served ONLY if the BitChord
// client sends atmos=auto AND an upstream provides actual eac3-joc metadata.
// E-AC-3 JOC is lossy immersive audio, never cached in the 36-hour FLAC R2.
// Stereo FLAC remains the only accepted stream when Atmos mode is off.


// ============================================================================
// 3. YOUR MASTER MANIFEST
// ============================================================================
// FLAC-only by default; Dolby Atmos requires an explicit, opt-in client hint.
// Even in Atmos mode, no arbitrary AAC/MP3/Opus fallback is permitted.
const LOSSLESS_ONLY = true;
// Bound cross-provider work and avoid exhausting provider rate limits.
const MAX_FALLBACK_STREAMS = 3;
const METADATA_MARKER = "~bcflac1~"; // Read both v3.5 and v3.6 IDs.
const STREAM_TIMEOUT_MS = 3200;
const SEARCH_TIMEOUT_MS = 2150;
// Fast search launches known-working providers first and starts additional
// providers only when the initial results are thin. Whole request is bounded.
const SEARCH_INITIAL_WAIT_MS = 1050;
const SEARCH_TOTAL_BUDGET_MS = 2700;
const SEARCH_TARGET_RESULTS = 10;
const SEARCH_PRIMARY_COUNT = 4;
const SEARCH_SECONDARY_TIMEOUT_MS = 1350;
const RESCUE_SEARCH_TIMEOUT_MS = 1600;
const MAX_RESCUE_DURATION_MS = 6500;
// Strict FLAC checks get a modest extra window based on the October 26 logs:
// previously the 1s probe missed valid files that succeeded on a later try.
// Optional setting: FLAC_PROBE_TIMEOUT_MS (900..2200, default 1600).
// Failed/inconclusive checks never become proof of lossy audio.
const DEFAULT_FLAC_PROBE_TIMEOUT_MS = 1600;
const MAX_RESCUE_TOTAL_CANDIDATES = 5;
function flacProbeTimeoutMs(env = {}) {
  const configured = Number(env?.FLAC_PROBE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.max(900, Math.min(2200, Math.round(configured)))
    : DEFAULT_FLAC_PROBE_TIMEOUT_MS;
}
// v3.7.8: Strict FLAC proof is required, but inconclusive network probes
// never mark a recording permanently bad.
// v3.7.7: Strict default: require FLAC-byte proof for all external addons.
// FLAC_VERIFY_MODE=strict (default) | adaptive | off. Strict may skip a
// genuine FLAC if the source blocks probes; adaptive is metadata-based when inconclusive.
const FLAC_PROBE_CACHE = new Map();
const MAX_FLAC_PROBE_CACHE = 350;
const MAX_RESULT_ALTERNATIVES = 5;
const NEW_SOURCE_TIMEOUT_MS = 2800;
// October 25 sample: providers 1 and 4 resolved otherwise failed FLAC tracks.
// These are preferences, not permanent bans; indices must never be renumbered.
// v3.7.10: Starting order is based on VERIFIED FLAC playback resolution in
// the October 27 anonymized Worker sample, not unverified search badges.
// Historical (before endpoint refresh): provider 1 had 15 successful handoffs,
// provider 4 had 4. Endpoint URLs at indexes 1, 3, and 8 have since been
// updated; their observed health starts fresh per Worker isolate. Indexes 3
// and 8 are in the initial exploration cohort, not declared verified winners.
// NEVER reorder DISCORD_ADDONS itself:
// saved BitChord IDs encode the original discord_N position.
const PREFERRED_PROVIDERS = [1, 4, 3, 8, 7, 2, 5, 6, 0];
const PROVIDER_COOLDOWNS = new Map(); // best-effort per Worker isolate
const PROVIDER_FAILURE_STREAKS = new Map(); // best-effort per Worker isolate
// v3.7.3: short, per-isolate negative cache. It prevents the same nonexistent
// native stream ID being requested repeatedly, without banning its artist.
// Neither cached entries nor logs contain resolved URLs or credentials.
const STREAM_NEGATIVE_CACHE = new Map();
const STREAM_HEALTH = new Map(); // per-isolate VERIFIED resolution success, missing tracks, upstream errors, latency
const SEARCH_HEALTH = new Map(); // per-isolate search response health; weaker evidence than verified FLAC
const MAX_NEGATIVE_CACHE_ENTRIES = 400;
function trackFailureKey(index, nativeId, mode = "flac") { return `${index}:${nativeId}:${mode}`; }
function streamRecentlyFailed(index, nativeId, mode = "flac") {
  const key = trackFailureKey(index, nativeId, mode);
  const expires = STREAM_NEGATIVE_CACHE.get(key) || 0;
  if (expires > Date.now()) return true;
  if (expires) STREAM_NEGATIVE_CACHE.delete(key);
  return false;
}
function markStreamFailure(index, nativeId, status, mode = "flac") {
  const ttl = status === 404 ? 90000 : status === 410 ? 120000
    : status === 429 ? 20000 : status === 504 ? 10000
    : status === 502 || status === 503 ? 20000 : status === 415 ? 60000 : 0;
  if (!ttl) return;
  const now = Date.now();
  if (STREAM_NEGATIVE_CACHE.size >= MAX_NEGATIVE_CACHE_ENTRIES) {
    for (const [key, expiry] of STREAM_NEGATIVE_CACHE) {
      if (expiry <= now) STREAM_NEGATIVE_CACHE.delete(key);
    }
    // FIFO eviction, bounded across a long-lived isolate.
    while (STREAM_NEGATIVE_CACHE.size >= MAX_NEGATIVE_CACHE_ENTRIES) {
      STREAM_NEGATIVE_CACHE.delete(STREAM_NEGATIVE_CACHE.keys().next().value);
    }
  }
  STREAM_NEGATIVE_CACHE.set(trackFailureKey(index, nativeId, mode), now + ttl);
}
// Only a successfully verified FLAC stream counts as a provider success.
// 404/410 indicate track availability, not an outage. They gently reduce
// preferred ranking, without creating a provider-wide cooldown.
function observeStreamHealth(index, success, status = 0, latencyMs = 0) {
  const item = STREAM_HEALTH.get(index) || { ok: 0, failed: 0, missing: 0, unverified: 0, latencyMs: 0 };
  if (success) item.ok += 1;
  else if (status === 404 || status === 410) item.missing += 1;
  else if (status === -1) item.unverified += 1; // inconclusive verification, not a known wrong codec
  else if (status) item.failed += 1;
  if (item.ok + item.failed + item.missing + item.unverified > 48) {
    item.ok = Math.ceil(item.ok / 2);
    item.failed = Math.ceil(item.failed / 2);
    item.missing = Math.ceil(item.missing / 2);
    item.unverified = Math.ceil(item.unverified / 2);
  }
  // Latency means VERIFIED stream readiness, not a fast-but-dead search.
  if (success && Number.isFinite(latencyMs) && latencyMs > 0) {
    item.latencyMs = item.latencyMs > 0
      ? Math.round(item.latencyMs * 0.7 + latencyMs * 0.3)
      : Math.round(latencyMs);
  }
  STREAM_HEALTH.set(index, item);
}
function observeSearchHealth(index, success, latencyMs = 0) {
  const item = SEARCH_HEALTH.get(index) || { ok: 0, failed: 0, latencyMs: 0 };
  if (success) item.ok += 1;
  else item.failed += 1;
  if (item.ok + item.failed > 32) {
    item.ok = Math.ceil(item.ok / 2);
    item.failed = Math.ceil(item.failed / 2);
  }
  if (success && Number.isFinite(latencyMs) && latencyMs > 0) {
    item.latencyMs = item.latencyMs > 0
      ? Math.round(item.latencyMs * 0.75 + latencyMs * 0.25)
      : Math.round(latencyMs);
  }
  SEARCH_HEALTH.set(index, item);
}
// Higher means better. Priorities are deliberately close enough that repeated
// verified performance can change the order, but a single lucky result cannot.
function providerPriorityScore(index) {
  const seed = PREFERRED_PROVIDERS.indexOf(index);
  const prior = seed < 0 ? 2 : 37 - seed * 4; // seed order: 37,33,29...5
  const audio = STREAM_HEALTH.get(index);
  const search = SEARCH_HEALTH.get(index);
  let score = prior;
  if (audio) {
    const evidence = audio.ok + audio.failed + audio.missing * 0.4 + audio.unverified * 0.7;
    if (evidence > 0) {
      const posterior = (audio.ok + 1) / (evidence + 2);
      score += (posterior - 0.5) * 42 * Math.min(1, evidence / 5);
    }
    if (audio.ok && audio.latencyMs) {
      score += Math.max(-12, Math.min(8, (1250 - audio.latencyMs) / 200))
        * Math.min(1, audio.ok / 3);
    }
  }
  if (search) {
    const volume = search.ok + search.failed;
    score -= 8 * (search.failed / (volume + 2)) * Math.min(1, volume / 4);
    if (search.ok && search.latencyMs > 1900) score -= Math.min(3, (search.latencyMs - 1900) / 350);
  }
  return Math.round(score * 10) / 10;
}
// One shared ranking function is used for search, results, saved alternatives,
// and fresh discovery. A cooling provider is omitted, not permanently banned.
function preferredRank(index) { return 55 - providerPriorityScore(index); }
const PROVIDER_BAD_FOR_SEARCH_MS = { 404: 45000, 429: 90000, 502: 25000, 503: 25000, 504: 20000 };
function providerCooling(index, operation = "search") {
  const expiry = PROVIDER_COOLDOWNS.get(`${operation}:${index}`) || 0;
  return expiry > Date.now();
}
function noteProviderFailure(index, operation, status) {
  if (!Number.isInteger(index) || status === 499) return; // search cancellation is not an upstream fault
  const base = PROVIDER_BAD_FOR_SEARCH_MS[status] || (status >= 500 ? 15000 : 0);
  if (!base || (operation === "stream" && status === 404)) return;
  const key = `${operation}:${index}`;
  const failures = Math.min(4, (PROVIDER_FAILURE_STREAKS.get(key) || 0) + 1);
  PROVIDER_FAILURE_STREAKS.set(key, failures);
  const duration = Math.min(180000, base * (failures >= 3 ? 3 : failures >= 2 ? 2 : 1));
  PROVIDER_COOLDOWNS.set(key, Date.now() + duration);
  console.warn(`[PROVIDER COOLDOWN] provider=discord_${index} operation=${operation} status=${status} duration_ms=${duration}`);
}
function noteProviderSuccess(index, operation) {
  const key = `${operation}:${index}`;
  PROVIDER_COOLDOWNS.delete(key);
  PROVIDER_FAILURE_STREAKS.delete(key);
}

// v3.7.4 public-source requests are best-effort and deliberately conservative.
// Runtime-local throttles/caches reset across Worker isolates. Cloudflare's edge
// does not provide a globally shared request budget without Durable Objects/KV.
const PUBLIC_CATALOG_STATE = new Map();
const PUBLIC_CATALOG_CACHE = new Map();
function freeSourceEnabled(env, key) {
  return /^(true|1|yes|on)$/i.test(String(env?.[key] || "").trim());
}
function publicSourceBudget(name, minimumIntervalMs, dailyLimit) {
  const today = new Date().toISOString().slice(0, 10);
  const state = PUBLIC_CATALOG_STATE.get(name) || { day: today, used: 0, last: 0, blockedUntil: 0 };
  if (state.day !== today) { state.day = today; state.used = 0; state.last = 0; }
  const now = Date.now();
  if (now < state.blockedUntil || now - state.last < minimumIntervalMs || state.used >= dailyLimit) {
    PUBLIC_CATALOG_STATE.set(name, state);
    return false;
  }
  state.used++; state.last = now;
  PUBLIC_CATALOG_STATE.set(name, state);
  return true;
}
function notePublicSourceError(name, status) {
  if (status !== 429 && status < 500) return;
  const state = PUBLIC_CATALOG_STATE.get(name) || { day: new Date().toISOString().slice(0, 10), used: 0, last: 0, blockedUntil: 0 };
  state.blockedUntil = Date.now() + (status === 429 ? 10 * 60 * 1000 : 60 * 1000);
  PUBLIC_CATALOG_STATE.set(name, state);
  console.warn(`[PUBLIC SOURCE COOLDOWN] source=${name} status=${status}`);
}
function cachedPublicTracks(provider, query) {
  const key = `${provider}:${normalizeName(query)}`;
  const cached = PUBLIC_CATALOG_CACHE.get(key);
  if (!cached) return null;
  if (cached.expiry < Date.now()) { PUBLIC_CATALOG_CACHE.delete(key); return null; }
  return cached.tracks;
}
function cachePublicTracks(provider, query, tracks) {
  const key = `${provider}:${normalizeName(query)}`;
  if (PUBLIC_CATALOG_CACHE.size >= 90) {
    for (const [k, entry] of PUBLIC_CATALOG_CACHE) {
      if (entry.expiry < Date.now()) PUBLIC_CATALOG_CACHE.delete(k);
    }
    while (PUBLIC_CATALOG_CACHE.size >= 90) PUBLIC_CATALOG_CACHE.delete(PUBLIC_CATALOG_CACHE.keys().next().value);
  }
  PUBLIC_CATALOG_CACHE.set(key, { tracks, expiry: Date.now() + (tracks.length ? 120000 : 15000) });
}

const MANIFEST = {
  id: "com.custom.master-aggregator",
  name: "Master Aggregator (FLAC + Anime/Vocaloid, Optional Atmos, 36h Cache)",
  version: "3.7.10",
  resources: ["search", "stream"],
  allowDownloads: 1,
  checkValidLossless: 0,
  atmos: 0
};

export default {
  async fetch(request, env = {}, ctx = {}) {
    const workerOrigin = new URL(request.url).origin;
    const url = new URL(request.url);

    // ------------------------------------------------------------------------
    // PRIVATE R2 BACKEND, PUBLIC PLAYBACK URL. Only configured track IDs work.
    // BitChord requests bytes from this route with HTTP Range support.
    // ------------------------------------------------------------------------
    if (url.pathname.startsWith("/audio/personal/")) {
      // Disabled in public reference; an R2 bucket binding is not authentication.
      return noStream(404);
    }

    // ------------------------------------------------------------------------
    // PRIVATE R2 CACHE AUDIO: signed URLs, expiry checked BEFORE R2 GET.
    if (url.pathname.startsWith("/audio/cache/")) {
      return serveCachedFlac(request, env, url, ctx);
    }

    // ROUTE 1: GET /manifest.json
    // ------------------------------------------------------------------------
    if (url.pathname === "/manifest.json") {
      // Advertise Atmos only when explicitly opted in, avoid stale 24h capability flags.
      return json({ ...MANIFEST, atmos: freeSourceEnabled(env, "ATMOS_ENABLED") ? 1 : 0 }, 120);
    }

    // ------------------------------------------------------------------------
    // ROUTE 2: GET /search?q=...
    // ------------------------------------------------------------------------
    if (url.pathname === "/search") {
      const query = (url.searchParams.get("q") || "").trim();
      if (!query) return json({ tracks: [] });
      const wantAtmos = wantsAtmos(url, env);

      // Stage 1: responsive/known-working sources. Stage 2 is launched only
      // if the initial search has too few results. Provider indexes stay fixed.
      const started = Date.now();
      const controller = new AbortController();
      const enabled = configuredAddons(env)
        .map((addonUrl, index) => ({ addonUrl, index }))
        .filter(({ addonUrl }) => addonUrl && !addonUrl.includes("example-discord-addon"))
        .sort((a, b) => preferredRank(a.index) - preferredRank(b.index));
      const healthy = enabled.filter(({ index }) => !providerCooling(index, "search"));
      console.log(`[PROVIDER PRIORITY] phase=search order=${healthy.map(({ index }) => `discord_${index}`).join(",") || "all_cooling"} evidence=verified_flac_and_recent_health`);
      // If all sources are cooling down, probe only the first two rather than
      // hammering every broken endpoint simultaneously.
      const selected = healthy.length ? healthy : enabled.slice(0, 2);
      const primary = selected.slice(0, SEARCH_PRIMARY_COUNT);
      const secondary = selected.slice(SEARCH_PRIMARY_COUNT);
      const results = [];
      const pending = new Map();
      const finished = new Set();
      let completed = 0;
      let secondaryStarted = false;
      let totalTracks = 0;
      const signal = controller.signal;
      const jamendoEnabled = Boolean(getJamendoClientId(env));
      const archiveEnabled = Boolean(FALLBACK_SOURCES.IA_ENABLED);
      const personalEnabled = false; // Disabled in public reference build.
      const openverseEnabled = freeSourceEnabled(env, "OPENVERSE_ENABLED");
      const commonsEnabled = freeSourceEnabled(env, "COMMONS_ENABLED");
      console.log(`[SOURCE CONFIG] jamendo=${jamendoEnabled ? "enabled" : "disabled_missing_client_id"} archive=${archiveEnabled ? "enabled" : "disabled"} personal=${personalEnabled ? "enabled" : "disabled"} openverse=${openverseEnabled ? "enabled" : "disabled"} commons=${commonsEnabled ? "enabled" : "disabled"}`);

      function launch(label, producer) {
        // Completion promises always resolve. Pending requests will be aborted
        // before returning, so slow upstreams do not keep running needlessly.
        const task = Promise.resolve().then(producer).then(
          (tracks) => ({ label, tracks: Array.isArray(tracks) ? tracks : [], error: null }),
          (error) => ({ label, tracks: [], error })
        ).then((result) => {
          pending.delete(label);
          if (!signal.aborted) {
            finished.add(label);
            completed++;
            results.push(...result.tracks);
            totalTracks += result.tracks.filter(isLosslessTrackClaim).length;
            console.log(`[SOURCE RESULT] source=${label} tracks=${result.tracks.length} status=${result.error ? (result.error.status || "error") : result.tracks.length ? "results" : "empty"}`);
          }
          return result;
        });
        pending.set(label, task);
      }
      function launchDiscord(choices, ms) {
        for (const { addonUrl, index } of choices) {
          launch(`discord_${index}`, () => searchDiscordAddon(addonUrl, index, query, ms, signal, wantAtmos));
        }
      }
      launchDiscord(primary, SEARCH_TIMEOUT_MS);
      if (jamendoEnabled) launch("jamendo", () => searchJamendo(query, env, SEARCH_TIMEOUT_MS, signal));
      if (archiveEnabled) launch("ia", () => searchArchiveFlac(query, signal));
      if (personalEnabled) launch("personal", () => searchPersonalFlac(query, env));
      if (flacCacheEnabled(env)) launch("cache", () => searchCachedFlac(query, env));
      // A timed wake-up allows the fallback tier to start without waiting for
      // unrelated slow requests to finish.
      const waitUntil = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
      try {
        while (Date.now() - started < SEARCH_TOTAL_BUDGET_MS) {
          const elapsed = Date.now() - started;
          if (!secondaryStarted &&
              (elapsed >= SEARCH_INITIAL_WAIT_MS || pending.size === 0)) {
            secondaryStarted = true;
            if (totalTracks < SEARCH_TARGET_RESULTS && secondary.length) {
              const remaining = SEARCH_TOTAL_BUDGET_MS - elapsed;
              if (remaining > 350) {
                launchDiscord(secondary, Math.min(SEARCH_SECONDARY_TIMEOUT_MS, remaining - 150));
                console.log(`[SEARCH EXPANDED] sources=${secondary.length} early_tracks=${totalTracks}`);
              }
            }
            // Open public catalogs only when the first tier lacks enough
            // FLAC-claimed results. They cannot slow successful fast searches.
            if (totalTracks < SEARCH_TARGET_RESULTS) {
              if (openverseEnabled) launch("openverse", () => searchOpenverseFlac(query, env, signal));
              if (commonsEnabled) launch("commons", () => searchCommonsFlac(query, env, signal));
            }
          }
          // Wait at least the initial discovery window to give new free sources
          // a fair chance, but return early when a useful result set is ready.
          if (elapsed >= SEARCH_INITIAL_WAIT_MS && totalTracks >= SEARCH_TARGET_RESULTS && finished.size >= 2) break;
          if (secondaryStarted && pending.size === 0) break;
          const nextWake = secondaryStarted
            ? SEARCH_TOTAL_BUDGET_MS - elapsed
            : Math.min(SEARCH_INITIAL_WAIT_MS - elapsed, SEARCH_TOTAL_BUDGET_MS - elapsed);
          if (nextWake <= 0) continue;
          await Promise.race([ ...pending.values(), waitUntil(nextWake) ]);
        }
      } finally {
        const cancelled = pending.size;
        controller.abort();
        console.log(`[SEARCH PERFORMANCE] elapsed_ms=${Date.now() - started} tracks=${totalTracks} sources_done=${completed} cancelled=${cancelled} expanded=${secondaryStarted}`);
      }

      let allTracks = results;
      if (LOSSLESS_ONLY) allTracks = allTracks.filter((t) => isLosslessTrackClaim(t) || (wantAtmos && isAtmosTrackClaim(t)));
      allTracks = addKnownAlternatives(allTracks);
      allTracks.sort((a, b) => {
        // Advertised Atmos mixes rank first only for eligible opt-in requests.
        if (wantAtmos) {
          const p = Number(isAtmosTrackClaim(b)) - Number(isAtmosTrackClaim(a));
          if (p) return p;
        }
        const q = getQualityScore(b) - getQualityScore(a);
        if (q) return q;
        const aProvider = String(a.id).split(":")[0];
        const bProvider = String(b.id).split(":")[0];
        return sourceRank(aProvider) - sourceRank(bProvider);
      });
      console.log(`[SEARCH READY] tracks=${allTracks.length} mode=${wantAtmos ? "atmos_preferred" : "flac_only"} verified_at_search=false`);
      // Short cache: fast searches are intentionally partial when slow sources
      // miss the deadline; do not hold partial results for a full minute.
      return json({ tracks: allTracks }, allTracks.length ? 20 : 0);
    }

    // ------------------------------------------------------------------------
    // ROUTE 3: GET /stream/{provider}:{id}
    // ------------------------------------------------------------------------
    if (url.pathname.startsWith("/stream/")) {
      let rawId;
      try {
        rawId = decodeURIComponent(url.pathname.slice(8)).trim();
      } catch {
        return new Response(null, { status: 400 });
      }
      const requestedQuality = (url.searchParams.get("quality") || "lossless").toLowerCase();
      const wantAtmos = wantsAtmos(url, env);
      const atmos = wantAtmos ? "auto" : "";
      const colonIndex = rawId.indexOf(":");
      if (colonIndex === -1) return noStream(404);

      const provider = rawId.slice(0, colonIndex);
      const encodedTrackId = rawId.slice(colonIndex + 1);
      // BitChord normally passes only a track ID to /stream. Embed minimal,
      // non-secret metadata in newly returned IDs so failed tracks can be
      // searched safely at other providers without a KV database.
      const { nativeId: trackId, metadata } = unpackTrackId(encodedTrackId);
      if (!trackId) return noStream(404);
      if (provider === "personal") return noStream(404); // Auth not implemented.
      if (!/^discord_\d+$/.test(provider) && !["saavn", "yt", "ia", "jamendo", "openverse", "commons", "cache"].includes(provider)) return noStream(404);

      // BitChord may request HIGH during quality negotiation; this addon is
      // FLAC-only and deliberately asks upstream for LOSSLESS instead.
      const quality = ["hi_res_lossless", "hires_lossless", "lossless", "flac"].includes(requestedQuality)
        ? requestedQuality : "lossless";
      const started = Date.now();
      // Check R2 first, even if the original provider has gone offline.
      // The full, normalized recording metadata is part of the cache key, so
      // (for example) Original Mix and Album Edit never share a cached file.
      const cacheKey = provider !== "cache" && flacCacheEnabled(env) && metadata
        ? await flacCacheKey(provider, trackId, metadata) : null;
      // A cached stereo FLAC must not hide a newly available Atmos rendition.
      if (cacheKey && !wantAtmos) {
        const hit = await resolveCachedFlac(cacheKey, env, workerOrigin);
        if (hit) {
          console.log(`[FLAC CACHE HIT] provider=${provider}`);
          return json(hit, 0);
        }
        console.log(`[FLAC CACHE MISS] provider=${provider}`);
      }
      let primaryError = null;
      let streamData = null;
      let primaryElapsedMs = 0;
      const primaryStart = Date.now();
      try {
        if (provider.startsWith("discord_")) {
          const addonIndex = Number(provider.slice(8));
          const addonBaseUrl = configuredAddonUrl(addonIndex, env);
          if (addonBaseUrl) {
            try {
              // A known, verified-metadata alternate lets us abandon a stalled primary
              // resolver earlier, saving up to 900 ms on dead sources.
              const primaryTimeout = metadata?.alt?.length ? Math.min(STREAM_TIMEOUT_MS, 2300) : STREAM_TIMEOUT_MS;
              streamData = await resolveDiscordAddon(addonBaseUrl, trackId, quality, atmos, addonIndex, false, primaryTimeout, wantAtmos, env);
            } catch (err) {
              primaryError = err;
              console.warn(`[PRIMARY FAILURE] provider=${provider} reason=${safeError(err)}`);
            }
          }
          primaryElapsedMs = Date.now() - primaryStart;
          console.log(`[STREAM PHASE] stage=primary provider=${provider} elapsed_ms=${primaryElapsedMs} stream=${streamData ? "candidate" : "none"}`);
          if (streamData && !streamMatchesExpectedDuration(streamData, metadata?.duration)) {
            console.warn(`[STREAM DURATION MISMATCH] provider=${provider} action=try_alternative`);
            streamData = null;
          }
          if (!isAllowedStream(streamData, wantAtmos)) {
            if (streamData) console.warn(`[REJECTED UNSUPPORTED AUDIO] provider=${provider}`);
            streamData = null;
          }
          if (!streamData && metadata) {
            streamData = await findMatchingFlacStream(metadata, provider, quality, atmos, started, env, workerOrigin);
          } else if (!streamData) {
            console.warn(`[NO CROSS-PROVIDER METADATA] provider=${provider} action=search_again_in_BitChord`);
          }
        } else if (provider === "ia") {
          streamData = await resolveArchiveFlac(trackId);
          if (!isFlacStream(streamData) && metadata)
            streamData = await findMatchingFlacStream(metadata, provider, quality, atmos, started, env, workerOrigin);
        } else if (provider === "jamendo") {
          streamData = await resolveJamendoFlac(trackId, env);
          if (!isFlacStream(streamData) && metadata)
            streamData = await findMatchingFlacStream(metadata, provider, quality, atmos, started, env, workerOrigin);
        } else if (provider === "personal") {
          streamData = await resolvePersonalFlac(trackId, env, workerOrigin);
          if (!isFlacStream(streamData) && metadata)
            streamData = await findMatchingFlacStream(metadata, provider, quality, atmos, started, env, workerOrigin);
        } else if (provider === "openverse") {
          streamData = await resolveOpenverseFlac(trackId, env);
          if (!isFlacStream(streamData) && metadata)
            streamData = await findMatchingFlacStream(metadata, provider, quality, atmos, started, env, workerOrigin);
        } else if (provider === "cache") {
          streamData = await resolveCachedFlac(trackId, env, workerOrigin);
        } else if (provider === "commons") {
          streamData = await resolveCommonsFlac(trackId, env);
          if (!isFlacStream(streamData) && metadata)
            streamData = await findMatchingFlacStream(metadata, provider, quality, atmos, started, env, workerOrigin);
        } else {
          // JioSaavn and Piped return lossy formats; intentionally disabled.
          console.warn(`[LOSSLESS ONLY] refused lossy source=${provider}`);
        }

        if (!isAllowedStream(streamData, wantAtmos)) {
          console.warn(`[NO SUPPORTED AUDIO] provider=${provider} mode=${wantAtmos ? "atmos_preferred" : "flac_only"}`);
          if (primaryError) console.warn(`[PRIMARY ERROR CLASS] provider=${provider} code=${primaryError.status || 502}`);
          console.log(`[STREAM TIMING] mode=${wantAtmos ? "atmos" : "flac"} outcome=unavailable primary_ms=${primaryElapsedMs} total_ms=${Date.now() - started}`);
          console.warn(`[STREAM UNAVAILABLE] provider=${provider} reason=no_verified_playable_stream http_status=404`);
          return noStream(404);
        }
        console.log(`[${isAtmosStream(streamData) ? "ATMOS READY" : "FLAC READY"}] requested=${provider} resolved=${streamData._resolvedProvider || provider} elapsed_ms=${Date.now() - started}`);
        console.log(`[STREAM TIMING] mode=${wantAtmos ? "atmos" : "flac"} primary_ms=${primaryElapsedMs} total_ms=${Date.now() - started} rescue=${Boolean(streamData._resolvedProvider)}`);
        console.log(`[PLAYBACK HANDOFF] mode=${isAtmosStream(streamData) ? "atmos" : "flac"} provider=${streamData._resolvedProvider || provider} json_returned=true bytes_played_by_client=unknown`);
        // Only cache on an explicit, rights-reviewed provider allowlist.
        // Never block first playback while downloading a second copy into R2.
        const resolvedProvider = streamData._resolvedProvider || provider;
        if (cacheKey && isFlacStream(streamData) && isCacheProviderAllowed(env, resolvedProvider) &&
            isPlayableUrl(streamData.url) && ctx && typeof ctx.waitUntil === "function") {
          ctx.waitUntil(saveFlacCache(cacheKey, streamData.url, metadata, resolvedProvider, env)
            .catch(() => console.warn("[FLAC CACHE SKIP] reason=write_error")));
        }
        // Never leak internal routing metadata to the BitChord playback client.
        if (streamData._resolvedProvider) {
          const { _resolvedProvider, ...publicStreamData } = streamData;
          return json(publicStreamData, 0);
        }
        return json(streamData, 0);
      } catch (err) {
        console.error(`[STREAM FAILURE] provider=${provider} reason=${safeError(err)}`);
        return noStream(err?.status === 504 ? 504 : 502);
      }
    }

    return new Response(null, { status: 404 });
  },
  async scheduled(event, env = {}, ctx = {}) {
    if (!flacCacheEnabled(env)) return;
    // Cloudflare Cron Trigger: 0 * * * * (once per hour).
    const task = cleanExpiredFlacCache(env);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(task);
    else await task;
  }
};

// ============================================================================
// NETWORK OPTIMIZATION & LOGGING (AbortController + Console logs)
// ============================================================================
// Single fast attempts for interactive playback; no slow automatic retries.
async function fetchWithTimeout(url, options = {}, ms = 8500, sourceName = "Unknown", retries = 0) {
  const parentSignal = options.signal;
  const requestOptions = { ...options };
  delete requestOptions.signal;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (parentSignal?.aborted) {
      const cancelled = new Error("search_cancelled");
      cancelled.status = 499;
      throw cancelled;
    }
    const controller = new AbortController();
    const parentAbort = () => controller.abort("search_cancelled");
    if (parentSignal) parentSignal.addEventListener("abort", parentAbort, { once: true });
    const timeoutId = setTimeout(() => controller.abort("upstream_timeout"), ms);
    try {
      // A hard rejection guard is needed for upstream fetch implementations
      // that do not settle immediately when their AbortSignal is triggered.
      let rejectAbort;
      const aborted = new Promise((_, reject) => { rejectAbort = reject; });
      const onAbort = () => {
        const error = new Error("AbortError");
        error.name = "AbortError";
        rejectAbort(error);
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      let response;
      try {
        response = await Promise.race([
          fetch(url, { ...requestOptions, signal: controller.signal }),
          aborted
        ]);
      } finally {
        controller.signal.removeEventListener("abort", onAbort);
      }
      if (parentSignal?.aborted) {
        try { await response.body?.cancel(); } catch {}
        const cancelled = new Error("search_cancelled");
        cancelled.status = 499;
        throw cancelled;
      }
      if (response.ok) return response;
      const transient = response.status >= 500;
      console.warn(`[UPSTREAM HTTP] ${sourceName} status=${response.status} attempt=${attempt + 1}`);
      if (!transient || attempt === retries) return response;
      try { await response.body?.cancel(); } catch {}
    } catch (error) {
      if (parentSignal?.aborted || error?.status === 499) {
        const cancelled = new Error("search_cancelled");
        cancelled.status = 499;
        throw cancelled;
      }
      const timeout = controller.signal.aborted || error?.name === "AbortError";
      console.warn(`[UPSTREAM ${timeout ? "TIMEOUT" : "NETWORK"}] ${sourceName} attempt=${attempt + 1}`);
      if (attempt === retries) {
        const err = new Error(timeout ? "upstream_timeout" : "upstream_network_error");
        err.status = timeout ? 504 : 502;
        throw err;
      }
    } finally {
      clearTimeout(timeoutId);
      if (parentSignal) parentSignal.removeEventListener("abort", parentAbort);
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
}

// ============================================================================
// DISCORD ADDON PROXY HANDLERS
// ============================================================================
async function searchDiscordAddon(baseUrl, index, query, timeoutMs = SEARCH_TIMEOUT_MS, signal = undefined, wantAtmos = false) {
  const cleanBase = baseUrl.replace(/\/+$/, "").replace(/\/manifest\.json$/i, "");
  const searchStart = Date.now();
  let res;
  try {
    const params = new URLSearchParams({ q: query });
    if (wantAtmos) { params.set("quality", "lossless"); params.set("atmos", "auto"); }
    res = await fetchWithTimeout(`${cleanBase}/search?${params}`, {
      headers: { "Accept": "application/json" }, signal
    }, timeoutMs, `DiscordSearch(${index})`);
  } catch (err) {
    if (err?.status !== 499) {
      observeSearchHealth(index, false);
      noteProviderFailure(index, "search", err?.status || 504);
    }
    throw err;
  }
  if (!res.ok) {
    observeSearchHealth(index, false);
    noteProviderFailure(index, "search", res.status);
    return [];
  }
  let data;
  try { data = await res.json(); }
  catch { observeSearchHealth(index, false); noteProviderFailure(index, "search", 502); return []; }
  observeSearchHealth(index, true, Date.now() - searchStart);
  noteProviderSuccess(index, "search");
  const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
  return tracks.filter((t) => t && (typeof t.id === "string" || typeof t.id === "number") && String(t.id).length < 500).map((t) => {
    const meta = trackMetadata(t);
    return {
      ...t,
      id: `discord_${index}:${t.id}${meta ? METADATA_MARKER + encodeMetadata(meta) : ""}`
    };
  });
}

// Small bounded, private, per-isolate probe cache; never log/store signed URLs.
// Three states: true = bytes are fLaC, false = proven NOT fLaC, null =
// inaccessible or timed out. Adaptive never calls inconclusive results verified.
// Short byte-range probe. Callers can collect a SAFE categorical reason; never
// log raw stream URLs, headers, tokens, track IDs or the user's address.
// A native FLAC stream starts with fLaC. A CDN timeout is inconclusive, not lossy.
async function probeExternalFlac(url, timeoutMs = 650, diagnostics = null) {
  const note = (reason) => { if (diagnostics && !diagnostics.reason) diagnostics.reason = reason; };
  if (!safePublicAudioUrl(url)) { note("unsafe_or_unsupported_url"); return null; }
  const controller = new AbortController();
  let timeoutId;
  const attempt = (async () => {
    let reader;
    try {
      const res = await fetch(url, { headers: { Range: "bytes=0-3", "Accept-Encoding": "identity" },
        signal: controller.signal, redirect: "follow" });
      if (![200, 206].includes(res.status)) { note(`upstream_http_${res.status}`); return null; }
      if (!res.body) { note("missing_audio_body"); return null; }
      const type = String(res.headers.get("content-type") || "").toLowerCase();
      if (/(?:text\/html|application\/json|audio\/(?:mpeg|mp4|ogg|opus)|video\/webm)/.test(type)) {
        note("known_lossy_or_non_audio_type");
        try { await res.body.cancel(); } catch {}
        return false;
      }
      reader = res.body.getReader();
      const bytes = [];
      while (bytes.length < 4) {
        const chunk = await reader.read();
        if (chunk.done) break;
        for (const item of (chunk.value || [])) { if (bytes.length < 4) bytes.push(item); }
      }
      if (bytes.length !== 4) { note("incomplete_audio_header"); return null; }
      const good = bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43;
      note(good ? "flac_magic_confirmed" : "non_flac_magic_bytes");
      return good;
    } catch { note(controller.signal.aborted ? "probe_timeout" : "probe_network_error"); return null; }
    finally { if (reader) { try { void reader.cancel().catch(() => {}); } catch {} } }
  })();
  const timed = new Promise((resolve) => {
    timeoutId = setTimeout(() => { note("probe_timeout"); controller.abort(); resolve(null); }, timeoutMs);
  });
  try { return await Promise.race([attempt, timed]); }
  finally { clearTimeout(timeoutId); controller.abort(); }
}

function probeMode(env) {
  const selected = String(env?.FLAC_VERIFY_MODE || "strict").toLowerCase();
  return ["adaptive", "strict", "off"].includes(selected) ? selected : "strict";
}
// Returns structured diagnostics so inconclusive HTTP/CDN probes are never
// conflated with known non-FLAC bytes. In strict mode both are rejected, but
// only a proven wrong codec is eligible for track-level negative caching.
// Deadline-aware verification: extra time is used ONLY for slow byte checks;
// fast endpoints finish immediately. A rescue can't use time beyond its budget.
async function verifyAddonFlac(stream, index, nativeId, env = {}, deadline = 0) {
  if (!isFlacStream(stream)) return { accepted: false, verdict: false, reason: "metadata_not_flac" };
  const mode = probeMode(env);
  if (mode === "off") return { accepted: true, verdict: null, reason: "verification_off" };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stream.url));
  const fingerprint = Array.from(new Uint8Array(digest).slice(0, 12),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
  const cacheKey = `${index}:${nativeId}:${mode}:${fingerprint}`;
  const cached = FLAC_PROBE_CACHE.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    const accepted = cached.verdict === true || (cached.verdict === null && mode === "adaptive");
    console.log(`[FLAC PROBE CACHE] provider=discord_${index} verdict=${cached.verdict === true ? "confirmed" : "non_flac"} accepted=${accepted}`);
    return { accepted, verdict: cached.verdict, reason: cached.verdict === false ? "non_flac_bytes" : "confirmed" };
  }
  const intendedTimeout = mode === "strict" ? flacProbeTimeoutMs(env) : 700;
  const remaining = deadline ? deadline - Date.now() - 75 : intendedTimeout;
  // Strict mode must not accept unknown audio simply because time ran out.
  if (deadline && remaining < 200) {
    console.warn(`[FLAC PROBE BUDGET] provider=discord_${index} remaining_ms=${Math.max(0,remaining)}`);
    return { accepted: false, verdict: null, reason: "probe_budget_exhausted" };
  }
  const timeoutMs = Math.max(200, Math.min(intendedTimeout, remaining));
  const begin = Date.now();
  const diagnostic = {};
  const verdict = await probeExternalFlac(stream.url, timeoutMs, diagnostic);
  if (FLAC_PROBE_CACHE.size >= MAX_FLAC_PROBE_CACHE) {
    for (const [key, item] of FLAC_PROBE_CACHE) {
      if (item.expires <= Date.now()) FLAC_PROBE_CACHE.delete(key);
    }
    while (FLAC_PROBE_CACHE.size >= MAX_FLAC_PROBE_CACHE)
      FLAC_PROBE_CACHE.delete(FLAC_PROBE_CACHE.keys().next().value);
  }
  // Cache only verified results and definite non-FLAC bytes. Never cache
  // network errors, HTTP errors, or inconclusive responses as bad tracks.
  if (verdict !== null) FLAC_PROBE_CACHE.set(cacheKey, { verdict, expires: Date.now() +
    (verdict === true ? 60000 : 20000) });
  const accepted = verdict === true || (verdict === null && mode === "adaptive");
  console.log(`[FLAC PROBE] provider=discord_${index} verdict=${verdict === true ? "confirmed" : verdict === false ? "non_flac" : "inconclusive"} reason=${diagnostic.reason || "unknown"} accepted=${accepted} elapsed_ms=${Date.now() - begin} budget_ms=${timeoutMs} mode=${mode}`);
  return { accepted, verdict, reason: verdict === null ? (diagnostic.reason || "probe_inconclusive") : verdict === false ? "non_flac_bytes" : "confirmed" };
}

async function resolveDiscordAddon(baseUrl, originalTrackId, quality, atmos, index, allowFallback = false, timeoutMs = STREAM_TIMEOUT_MS, wantAtmos = false, env = {}, verificationDeadline = 0) {
  const cacheMode = wantAtmos ? "atmos" : "flac";
  const resolveStart = Date.now();
  if (streamRecentlyFailed(index, originalTrackId, cacheMode)) {
    console.log(`[TRACK SKIPPED] provider=discord_${index} reason=recent_resolution_failure`);
    return null;
  }
  const cleanBase = baseUrl.replace(/\/+$/, "").replace(/\/manifest\.json$/i, "");
  const tryQuality = async (requestedQuality) => {
    const params = new URLSearchParams();
    if (requestedQuality) params.set("quality", requestedQuality);
    if (atmos) params.set("atmos", atmos);
    const streamUrl = `${cleanBase}/stream/${encodeURIComponent(originalTrackId)}?${params}`;
    const res = await fetchWithTimeout(streamUrl, {
      headers: { "Accept": "application/json" }
    }, timeoutMs, `DiscordStream(${index})`, 0);

    if (res.status === 404 || res.status === 410) {
      markStreamFailure(index, originalTrackId, res.status, cacheMode);
      observeStreamHealth(index, false, res.status);
      return null;
    }
    if (!res.ok) {
      const error = new Error(`upstream_http_${res.status}`);
      error.status = res.status;
      throw error;
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error("upstream_invalid_json");
    }
    if (!data || typeof data !== "object" || !isPlayableUrl(data.url)) {
      markStreamFailure(index, originalTrackId, 415, cacheMode);
      observeStreamHealth(index, false, 415);
      return null;
    }
    if (wantAtmos && isAtmosStream(data)) {
      noteProviderSuccess(index, "stream");
      // Atmos is opt-in lossy E-AC-3 JOC, not a VERIFIED FLAC success.
      // Keep its playback working but do not let it bias FLAC ranking.
      STREAM_NEGATIVE_CACHE.delete(trackFailureKey(index, originalTrackId, cacheMode));
      return normalizeAtmosStream(data);
    }
    if (isFlacStream(data)) {
      const probe = await verifyAddonFlac(data, index, originalTrackId, env, verificationDeadline);
      if (!probe.accepted) {
        console.warn(`[FLAC PROBE REJECT] provider=discord_${index} reason=${probe.reason} mode=${probeMode(env)}`);
        // HTTP Range timeouts, CDN blocking and inaccessible signed URLs are
        // NOT proof of an unsupported format. Never negative-cache them as 415.
        if (probe.verdict === false) markStreamFailure(index, originalTrackId, 415, cacheMode);
        // Do not penalize provider health on inconclusive verification either.
        if (probe.verdict === false) observeStreamHealth(index, false, 415, Date.now() - resolveStart);
        if (probe.verdict === null) {
          observeStreamHealth(index, false, -1);
          // Media URL rate limiting affects playback even when the upstream
          // addon returned JSON successfully. Cool down, but do NOT cache a
          // negative result for the track based on an inconclusive check.
          const status = /^upstream_http_(429|502|503|504)$/.exec(probe.reason || "");
          if (status) noteProviderFailure(index, "stream", Number(status[1]));
        }
        return null;
      }
      noteProviderSuccess(index, "stream");
      observeStreamHealth(index, true, 0, Date.now() - resolveStart);
      STREAM_NEGATIVE_CACHE.delete(trackFailureKey(index, originalTrackId, cacheMode));
      return normalizeFlacStream(data);
    }
    // A valid but disallowed Atmos mix is not a broken upstream recording.
    // Do not poison a later opt-in Atmos request with a FLAC-only rejection.
    if (!isAtmosStream(data)) markStreamFailure(index, originalTrackId, 415, cacheMode);
    observeStreamHealth(index, false, 415, Date.now() - resolveStart);
    return null;
  };

  let firstError = null;
  let data = null;
  try {
    data = await tryQuality(quality);
  } catch (err) {
    const status = err?.status || 504;
    noteProviderFailure(index, "stream", status);
    observeStreamHealth(index, false, status, Date.now() - resolveStart);
    markStreamFailure(index, originalTrackId, status, cacheMode);
    firstError = err;
  }
  if (data) return data;

  // Preserve lossless intent unless caller explicitly opts into lower quality.
  if (allowFallback && ["lossless", "hi_res_lossless", "hires", "flac"].includes(quality)) {
    console.warn(`[QUALITY FALLBACK] provider=discord_${index} from=${quality} to=high`);
    try {
      const fallback = await tryQuality("high");
      if (fallback) return fallback;
    } catch (err) {
      if (!firstError) firstError = err;
    }
  }
  if (firstError) throw firstError;
  return null;
}

// ============================================================================
// BUILT-IN FALLBACK 1: JIOSAAVN (Updated Parsing)
// ============================================================================
async function searchSaavn(query) {
  if (!FALLBACK_SOURCES.SAAVN_API) return [];
  const res = await fetchWithTimeout(
    `${FALLBACK_SOURCES.SAAVN_API}/search/songs?query=${encodeURIComponent(query)}&limit=6`,
    {}, 6500, "JioSaavn Search"
  );
  if (!res.ok) return [];
  const jsonResp = await res.json();
  
  // Safely fallback through common API fork structures
  const results = jsonResp?.data?.results || jsonResp?.results || jsonResp?.data || [];

  return results.map((song) => {
    // Handle variations in artist and image arrays
    const artistNames = song.artists?.primary?.map((a) => a.name).join(", ") 
                        || song.primaryArtists 
                        || "Unknown Artist";
                        
    const imageArray = song.image || song.thumbnails || [];
    const highestArt = imageArray.length > 0 ? (imageArray[imageArray.length - 1]?.url || imageArray[imageArray.length - 1]?.link) : "";

    return {
      id: `saavn:${song.id}`,
      title: cleanText(song.name || song.title || ""),
      artist: cleanText(artistNames),
      album: cleanText(song.album?.name || song.album || ""),
      duration: Number(song.duration) || 0,
      artworkURL: highestArt || "",
      format: "aac",
      audioQuality: "HIGH"
    };
  });
}

async function resolveSaavn(id, quality) {
  const res = await fetchWithTimeout(`${FALLBACK_SOURCES.SAAVN_API}/songs/${encodeURIComponent(id)}`, {}, 15000, "JioSaavn Stream");
  if (!res.ok) return null;
  const jsonResp = await res.json();
  
  // Handle single-song array vs object responses
  const song = jsonResp?.data?.[0] || jsonResp?.data || jsonResp?.[0];
  if (!song) return null;

  const urls = song.downloadUrl || song.downloadUrls || [];
  if (urls.length === 0) return null;

  let chosen = urls[urls.length - 1];
  if (quality === "low") {
    chosen = urls.find((d) => d.quality === "96kbps" || d.quality === "96") || urls[0];
  }
  
  const streamUrl = chosen?.url || chosen?.link;
  if (!streamUrl) return null;

  return {
    url: streamUrl,
    format: "aac",
    quality: quality === "low" ? "Low" : "High",
    codec: "aac",
    container: "m4a",
    manifest: "none",
    encrypted: false,
    sampleRate: 44100,
    bitDepth: 16
  };
}
// ============================================================================
// BUILT-IN FALLBACK 2: YOUTUBE MUSIC
// ============================================================================
async function searchPipedYTMusic(query) {
  if (!FALLBACK_SOURCES.PIPED_API) return [];
  const res = await fetchWithTimeout(
    `${FALLBACK_SOURCES.PIPED_API}/search?q=${encodeURIComponent(query)}&filter=music_songs`,
    {}, 6500, "Piped YT Search"
  );
  if (!res.ok) return [];
  const data = await res.json();
  const items = data?.items || [];

  return items.slice(0, 6).map((item) => {
    const videoId = (item.url || "").replace("/watch?v=", "");
    return {
      id: `yt:${videoId}`,
      title: cleanText(item.title || ""),
      artist: cleanText(item.uploaderName || "Unknown Artist"),
      album: cleanText(item.title || "Single"),
      duration: Number(item.duration) || 0,
      artworkURL: item.thumbnail || "",
      format: "aac",
      audioQuality: "HIGH"
    };
  });
}

async function resolvePipedYTMusic(videoId, quality) {
  const res = await fetchWithTimeout(`${FALLBACK_SOURCES.PIPED_API}/streams/${encodeURIComponent(videoId)}`, {}, 15000, "Piped YT Stream");
  if (!res.ok) return null;
  const data = await res.json();
  const audioStreams = data?.audioStreams || [];
  if (audioStreams.length === 0) return null;

  const m4aStreams = audioStreams.filter((s) => (s.mimeType || "").includes("mp4"));
  const pool = m4aStreams.length > 0 ? m4aStreams : audioStreams;

  pool.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  const chosen = quality === "low" ? pool[pool.length - 1] : pool[0];
  if (!chosen?.url) return null;

  return {
    url: chosen.url,
    format: (chosen.mimeType || "").includes("webm") ? "opus" : "aac",
    quality: quality === "low" ? "Low" : "High",
    codec: (chosen.mimeType || "").includes("webm") ? "opus" : "aac",
    container: (chosen.mimeType || "").includes("webm") ? "webm" : "m4a",
    manifest: "none",
    encrypted: false
  };
}

// ============================================================================
// FREE SOURCES: JAMENDO, INTERNET ARCHIVE, OPTIONAL PERSONAL R2
// ============================================================================
function getJamendoClientId(env) {
  return String(env?.JAMENDO_CLIENT_ID || "").trim();
}
function packSourceId(value) { return encodeMetadata(value); }
function unpackSourceId(value) {
  try {
    const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0))));
  } catch { return null; }
}
function sourceTrack(provider, nativeId, track) {
  const meta = trackMetadata(track);
  if (!meta || String(nativeId).length > 210) return null;
  return { ...track, id: `${provider}:${nativeId}${METADATA_MARKER}${encodeMetadata(meta)}`,
    format: "flac", audioQuality: "LOSSLESS" };
}
function streamFlacUrl(url) {
  return { url, quality: "Lossless", audioQuality: "LOSSLESS", format: "flac",
    codec: "flac", container: "flac", manifest: "none", encrypted: false };
}
async function searchJamendo(query, env, timeoutMs = NEW_SOURCE_TIMEOUT_MS, signal = undefined) {
  const clientId = getJamendoClientId(env);
  if (!clientId) return [];
  const params = new URLSearchParams({ client_id: clientId, format: "json",
    search: query.slice(0, 160), audioformat: "flac", type: "single albumtrack", limit: "8" });
  try {
    const res = await fetchWithTimeout(`https://api.jamendo.com/v3.0/tracks/?${params}`,
      { headers: { Accept: "application/json" }, signal }, timeoutMs, "JamendoSearch");
    if (!res.ok) return [];
    const body = await res.json();
    if (signal?.aborted) return [];
    if (body?.headers?.status !== "success") return [];
    return (Array.isArray(body.results) ? body.results : []).map((t) => {
      if (!t.id || !isPlayableUrl(t.audio)) return null;
      return sourceTrack("jamendo", String(t.id), {
        title: cleanText(t.name || ""), artist: cleanText(t.artist_name || ""),
        album: cleanText(t.album_name || ""), duration: Number(t.duration) || 0,
        artworkURL: t.image || "", format: "flac", audioQuality: "LOSSLESS"
      });
    }).filter(Boolean);
  } catch (err) { if (err?.status !== 499) console.warn(`[JAMENDO SEARCH] ${safeError(err)}`); return []; }
}

// Check actual bytes, rather than blindly trusting a provider's codec label.
// A FLAC file starts with the ASCII signature fLaC. Send only 4 bytes in Range
// and cancel the response body as soon as those bytes arrive.
async function hasFlacMagic(url, timeoutMs = 2200) {
  if (!isPlayableUrl(url)) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader;
  try {
    const response = await fetch(url, { headers: { Range: "bytes=0-3" }, signal: controller.signal });
    if (![200, 206].includes(response.status) || !response.body) return false;
    reader = response.body.getReader();
    const signature = [];
    while (signature.length < 4) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (const byte of (chunk.value || [])) {
        signature.push(byte);
        if (signature.length === 4) break;
      }
    }
    return signature.length === 4 && signature[0] === 0x66 && signature[1] === 0x4c
      && signature[2] === 0x61 && signature[3] === 0x43;
  } catch { return false; }
  finally {
    controller.abort(); // cancels any remaining audio transfer
    clearTimeout(timer);
    try { await reader?.cancel(); } catch {}
  }
}
async function resolveJamendoFlac(id, env) {
  const clientId = getJamendoClientId(env);
  if (!clientId || !/^\d+$/.test(String(id))) return null;
  const params = new URLSearchParams({ client_id: clientId, id: String(id),
    audioformat: "flac", format: "json" });
  try {
    const res = await fetchWithTimeout(`https://api.jamendo.com/v3.0/tracks/?${params}`,
      { headers: { Accept: "application/json" } }, NEW_SOURCE_TIMEOUT_MS, "JamendoStream");
    if (!res.ok) return null;
    const body = await res.json();
    if (body?.headers?.status !== "success") return null;
    const audio = body?.results?.[0]?.audio;
    if (!isPlayableUrl(audio)) return null;
    if (!(await hasFlacMagic(audio))) {
      console.warn("[JAMENDO REJECT] stream_not_verified_flac");
      return null;
    }
    return streamFlacUrl(audio);
  } catch (err) { console.warn(`[JAMENDO STREAM] ${safeError(err)}`); return null; }
}

function normalizeArchiveFileName(name) {
  const leaf = String(name || "").split("/").pop() || "";
  return leaf.replace(/\.flac$/i, "")
    .replace(/^\d{1,3}[\s._-]+/, "")
    .replace(/_/g, " ");
}
function archiveNameMatchesQuery(fileName, query, creator = "") {
  const file = normalizeName(normalizeArchiveFileName(fileName));
  const input = normalizeName(query);
  if (!file || !input) return false;
  // The IA metadata API describes collections, not individual songs.
  // Only expose actual .flac files with strongly matching filenames.
  const tokens = input.split(" ").filter((s) => s.length > 2);
  const fileWords = new Set(file.split(" "));
  const creatorWords = new Set(normalizeName(creator).split(" "));
  const fileHits = tokens.filter((s) => fileWords.has(s)).length;
  const combinedHits = tokens.filter((s) => fileWords.has(s) || creatorWords.has(s)).length;
  return tokens.length >= 2 && fileHits >= 2 && combinedHits / tokens.length >= 0.65;
}
async function searchArchiveFlac(query, signal = undefined) {
  if (!FALLBACK_SOURCES.IA_ENABLED || !query || query.length > 180) return [];
  const words = normalizeName(query).split(" ").filter((w) => w.length > 2).slice(0, 7);
  if (words.length < 2) return [];
  const q = `mediatype:(audio) AND format:(Flac) AND (${words.map((w) => `"${w}"`).join(" ")})`;
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier,title,creator&rows=3&output=json`;
  try {
    const res = await fetchWithTimeout(url, { signal }, 1750, "ArchiveSearch");
    if (!res.ok) return [];
    const body = await res.json();
    if (signal?.aborted) return [];
    const docs = (body?.response?.docs || []).slice(0, 3);
    const results = await Promise.allSettled(docs.map(async (doc) => {
      const identifier = String(doc.identifier || "");
      if (!identifier || identifier.length > 90) return [];
      const response = await fetchWithTimeout(`https://archive.org/metadata/${encodeURIComponent(identifier)}`,
        { signal }, 1250, "ArchiveMetadata");
      if (!response.ok) return [];
      const metadata = await response.json();
      if (signal?.aborted) return [];
      const files = Array.isArray(metadata.files) ? metadata.files : [];
      const creator = Array.isArray(doc.creator) ? doc.creator[0] : doc.creator;
      // archive.org items may include many unrelated FLAC files.
      return files.filter((f) => f?.name && /\.flac$/i.test(f.name)
        && archiveNameMatchesQuery(f.name, query, creator)).slice(0, 3).map((f) =>
          sourceTrack("ia", packSourceId([identifier, f.name]), {
            title: normalizeArchiveFileName(f.name), artist: cleanText(creator || ""),
            album: cleanText(doc.title || ""), duration: 0,
            artworkURL: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
            format: "flac", audioQuality: "LOSSLESS"
          })).filter(Boolean);
    }));
    return results.flatMap((r) => r.status === "fulfilled" ? r.value : []);
  } catch (err) { if (err?.status !== 499) console.warn(`[ARCHIVE SEARCH] ${safeError(err)}`); return []; }
}
async function resolveArchiveFlac(id) {
  const parsed = unpackSourceId(id);
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [identifier, fileName] = parsed;
  if (typeof identifier !== "string" || typeof fileName !== "string"
    || !identifier || identifier.length > 90 || !/\.flac$/i.test(fileName)) return null;
  const path = fileName.split("/").map(encodeURIComponent).join("/");
  const audioUrl = `https://archive.org/download/${encodeURIComponent(identifier)}/${path}`;
  // Inspect the actual file signature; do not silently substitute MP3 files.
  if (!(await hasFlacMagic(audioUrl))) return null;
  return streamFlacUrl(audioUrl);
}


// ============================================================================
// FREE, PUBLIC & OPT-IN FLAC DISCOVERY (Openverse + Wikimedia Commons)
// ============================================================================
// These APIs are discovery catalogs, NOT guarantees of currently accessible
// lossless audio. Search results are *claims*; stream selection checks fLaC
// magic bytes before emitting a playback URL. API IDs are re-resolved against
// the authoritative public API, never interpreted as a user-supplied URL.
function safePublicAudioUrl(value) {
  if (typeof value !== "string" || value.length > 1900) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return false;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
      || host.endsWith(".internal") || host.endsWith(".test") || host.endsWith(".example")
      || host === "metadata.google.internal" || host === "169.254.169.254"
      || host === "0.0.0.0" || host === "[::1]" || host === "[::]" || host === "::1") return false;
    // Block direct IPv4 literal hostnames and numeric IP encodings. A static
    // source hostname is preferred to making requests to arbitrary IPs.
    if (/^\d+(?:\.\d+){0,3}$/.test(host) || host.startsWith("[")) return false;
    return true;
  } catch { return false; }
}
function publicCatalogRelevant(title, creator, query) {
  const words = [...new Set(normalizeName(query).split(" ").filter((w) => w.length >= 3))];
  const titleWords = new Set(normalizeName(title).split(" "));
  const artistWords = new Set(normalizeName(creator).split(" "));
  if (!words.length) return false;
  const inTitle = words.filter((w) => titleWords.has(w)).length;
  const covered = words.filter((w) => titleWords.has(w) || artistWords.has(w)).length;
  return inTitle >= 1 && covered / words.length >= (words.length <= 2 ? 1 : 0.67);
}
function openverseFlacCandidate(item) {
  const files = [{ url: item?.url, filetype: item?.filetype },
    ...(Array.isArray(item?.alt_files) ? item.alt_files : [])];
  return files.find((file) => /^(flac|audio\/flac|audio\/x-flac)$/i.test(String(file?.filetype || ""))
    && safePublicAudioUrl(file.url))?.url || null;
}
async function searchOpenverseFlac(query, env, signal = undefined) {
  if (!freeSourceEnabled(env, "OPENVERSE_ENABLED")) return [];
  const cached = cachedPublicTracks("openverse", query);
  if (cached) return cached;
  if (!publicSourceBudget("openverse", 5000, 100)) return [];
  const params = new URLSearchParams({ q: query.slice(0, 180), category: "music",
    extension: "flac", page_size: "12" });
  try {
    const res = await fetchWithTimeout(`https://api.openverse.org/v1/audio/?${params}`,
      { headers: { Accept: "application/json" }, signal }, 1350, "OpenverseSearch");
    if (!res.ok) { notePublicSourceError("openverse", res.status); return []; }
    const data = await res.json();
    if (signal?.aborted) return [];
    const matches = (Array.isArray(data?.results) ? data.results : []).filter((item) =>
      /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(String(item?.id || "")) &&
      item?.title && item?.creator && !item?.mature &&
      openverseFlacCandidate(item) && publicCatalogRelevant(item.title, item.creator, query));
    const tracks = matches.slice(0, 7).map((item) => sourceTrack("openverse", String(item.id), {
      title: cleanText(item.title), artist: cleanText(item.creator),
      album: cleanText(item.audio_set?.title || "Openverse"),
      duration: Number(item.duration) > 0 ? Math.round(Number(item.duration) / 1000) : 0,
      artworkURL: item.thumbnail || "", format: "flac", audioQuality: "LOSSLESS",
      attribution: cleanText(item.attribution || ""),
      license: cleanText(item.license || ""),
      licenseURL: item.license_url || "", sourceURL: item.foreign_landing_url || ""
    })).filter(Boolean);
    cachePublicTracks("openverse", query, tracks);
    return tracks;
  } catch (err) { if (err?.status !== 499) console.warn(`[OPENVERSE SEARCH] ${safeError(err)}`); return []; }
}
async function resolveOpenverseFlac(id, env) {
  if (!freeSourceEnabled(env, "OPENVERSE_ENABLED") || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(String(id))) return null;
  try {
    const res = await fetchWithTimeout(`https://api.openverse.org/v1/audio/${encodeURIComponent(id)}/`,
      { headers: { Accept: "application/json" } }, 1600, "OpenverseDetail");
    if (!res.ok) { notePublicSourceError("openverse", res.status); return null; }
    const entry = await res.json();
    const audioUrl = !entry?.mature && openverseFlacCandidate(entry);
    if (!audioUrl || !(await hasFlacMagic(audioUrl, 1700))) {
      console.warn("[PUBLIC FLAC REJECT] source=openverse reason=signature_or_url");
      return null;
    }
    return streamFlacUrl(audioUrl);
  } catch (err) { console.warn(`[OPENVERSE STREAM] ${safeError(err)}`); return null; }
}
function commonsFileData(page) {
  const info = page?.imageinfo?.[0];
  if (!/^File:.*\.flac$/i.test(String(page?.title || ""))) return null;
  if (info?.mime && !/^audio\/(?:x-)?flac$/i.test(info.mime)) return null;
  const direct = info?.url;
  // Commons file URLs must originate from Wikimedia's own upload domain.
  if (!safePublicAudioUrl(direct) || new URL(direct).hostname !== "upload.wikimedia.org"
    || !/\.flac(?:$|[?#])/i.test(direct)) return null;
  return { url: direct, name: page.title.slice(5).replace(/\.flac$/i, "").replace(/_/g, " ") };
}
async function searchCommonsFlac(query, env, signal = undefined) {
  if (!freeSourceEnabled(env, "COMMONS_ENABLED")) return [];
  const cached = cachedPublicTracks("commons", query);
  if (cached) return cached;
  if (!publicSourceBudget("commons", 4000, 150)) return [];
  const params = new URLSearchParams({ action: "query", format: "json", formatversion: "2",
    generator: "search", gsrsearch: `${query.slice(0, 135)} filetype:audio`,
    gsrnamespace: "6", gsrlimit: "12", prop: "imageinfo", iiprop: "url|mime" });
  try {
    const res = await fetchWithTimeout(`https://commons.wikimedia.org/w/api.php?${params}`,
      { headers: { Accept: "application/json" }, signal }, 1500, "CommonsSearch");
    if (!res.ok) { notePublicSourceError("commons", res.status); return []; }
    const data = await res.json();
    if (signal?.aborted) return [];
    const pages = Array.isArray(data?.query?.pages) ? data.query.pages : [];
    const tracks = pages.map((page) => {
      const info = commonsFileData(page);
      if (!info || !Number.isSafeInteger(page.pageid) || page.pageid <= 0
        || !publicCatalogRelevant(info.name, "", query)) return null;
      // File name is the closest available name. Commons rarely has reliable
      // standardized music artist+duration metadata, so use a conservative
      // creator label, which won't falsely cross-match a commercial artist.
      // Where a filename explicitly follows "Artist - Song", retain those
      // separate values. Otherwise don't invent a performer from an uploader.
      const parts = info.name.split(/\s+-\s+/).map((part) => part.trim());
      const inferred = parts.length === 2 && parts.every((part) => part.length >= 2);
      return sourceTrack("commons", String(page.pageid), {
        title: cleanText(inferred ? parts[1] : info.name),
        artist: cleanText(inferred ? parts[0] : "Wikimedia Commons (artist uncredited)"),
        album: "Wikimedia Commons", duration: 0,
        sourceURL: `https://commons.wikimedia.org/?curid=${page.pageid}`,
        format: "flac", audioQuality: "LOSSLESS"
      });
    }).filter(Boolean).slice(0, 6);
    cachePublicTracks("commons", query, tracks);
    return tracks;
  } catch (err) { if (err?.status !== 499) console.warn(`[COMMONS SEARCH] ${safeError(err)}`); return []; }
}
async function resolveCommonsFlac(id, env) {
  if (!freeSourceEnabled(env, "COMMONS_ENABLED") || !/^[1-9]\d{0,11}$/.test(String(id))) return null;
  const params = new URLSearchParams({ action: "query", format: "json", formatversion: "2",
    pageids: String(id), prop: "imageinfo", iiprop: "url|mime" });
  try {
    const res = await fetchWithTimeout(`https://commons.wikimedia.org/w/api.php?${params}`,
      { headers: { Accept: "application/json" } }, 1700, "CommonsDetail");
    if (!res.ok) { notePublicSourceError("commons", res.status); return null; }
    const data = await res.json();
    const page = data?.query?.pages?.[0];
    if (page?.pageid !== Number(id)) return null;
    const audioUrl = commonsFileData(page)?.url;
    if (!audioUrl || !(await hasFlacMagic(audioUrl, 1700))) {
      console.warn("[PUBLIC FLAC REJECT] source=commons reason=signature_or_url");
      return null;
    }
    return streamFlacUrl(audioUrl);
  } catch (err) { console.warn(`[COMMONS STREAM] ${safeError(err)}`); return null; }
}

function searchPersonalFlac(query, env) {
  if (!env?.FLAC_BUCKET) return [];
  const wanted = normalizeName(query);
  if (!wanted) return [];
  return PERSONAL_FLAC_TRACKS.map((t, i) => {
    if (!/\.flac$/i.test(String(t.key || ""))) return null;
    const title = normalizeName(t.title), artist = normalizeName(t.artist);
    const tokens = wanted.split(" ").filter((w) => w.length > 2);
    const combined = `${title} ${artist}`;
    if (!tokens.length || !tokens.every((word) => combined.includes(word))) return null;
    return sourceTrack("personal", String(i), { title: t.title, artist: t.artist,
      album: t.album || "Personal Library", duration: Number(t.duration) || 0,
      format: "flac", audioQuality: "LOSSLESS", artworkURL: t.artworkURL || "" });
  }).filter(Boolean);
}
async function resolvePersonalFlac(id, env, workerOrigin) {
  const i = Number(id);
  const track = PERSONAL_FLAC_TRACKS[i];
  if (!Number.isInteger(i) || !track || !env?.FLAC_BUCKET || !/\.flac$/i.test(track.key)) return null;
  try {
    const object = await env.FLAC_BUCKET.get(track.key, { range: { offset: 0, length: 4 } });
    if (!object?.body) return null;
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    if (bytes.length < 4 || bytes[0] !== 0x66 || bytes[1] !== 0x4c
      || bytes[2] !== 0x61 || bytes[3] !== 0x43) return null;
    return streamFlacUrl(`${workerOrigin}/audio/personal/${i}.flac`);
  } catch { return null; }
}
async function servePersonalFlac(request, env, url) {
  const match = url.pathname.match(/^\/audio\/personal\/(\d+)\.flac$/);
  if (!match || !env?.FLAC_BUCKET) return noStream(404);
  const item = PERSONAL_FLAC_TRACKS[Number(match[1])];
  if (!item || !/\.flac$/i.test(String(item.key || ""))) return noStream(404);
  if (request.method === "OPTIONS") return new Response(null, { status: 204,
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "Range,Content-Type" } });
  if (!["GET", "HEAD"].includes(request.method)) return noStream(405);
  try {
    const headers = { "Access-Control-Allow-Origin": "*", "Accept-Ranges": "bytes", "Cache-Control": "private, no-store",
      "Content-Type": "audio/flac", "Access-Control-Expose-Headers": "Content-Length,Content-Range,Accept-Ranges,ETag" };
    if (request.method === "HEAD") {
      const object = await env.FLAC_BUCKET.head(item.key);
      if (!object) return noStream(404);
      headers["Content-Length"] = String(object.size);
      return new Response(null, { status: 200, headers });
    }
    const range = request.headers.get("Range");
    const object = await env.FLAC_BUCKET.get(item.key, range ? { range: request.headers } : {});
    if (!object) return noStream(404);
    headers["ETag"] = object.httpEtag;
    if (range && object.range && typeof object.range.offset === "number") {
      const begin = object.range.offset;
      const length = object.range.length;
      headers["Content-Range"] = `bytes ${begin}-${begin + length - 1}/${object.size}`;
      headers["Content-Length"] = String(length);
      return new Response(object.body, { status: 206, headers });
    }
    headers["Content-Length"] = String(object.size);
    return new Response(object.body, { status: 200, headers });
  } catch { return noStream(502); }
}

// ============================================================================
// v3.7.5: OPTIONAL, PERSONAL, 36-HOUR FLAC CACHE ON CLOUDFLARE R2
// ============================================================================
// This stores full audio bytes (not just a URL or metadata). The R2 objects have
// metadata for title/artist/duration/expiry. Use only when a source explicitly
// permits temporary storage. All extra provider credentials remain PRIVATE.
// The cache is disabled unless signing secret, R2 binding AND opt-in are set.
const FLAC_CACHE_PREFIX = "bc-flac-cache-v1/";
const FLAC_CACHE_TTL_MS = 36 * 60 * 60 * 1000;
const FLAC_CACHE_MAX_FILE_BYTES = 100 * 1024 * 1024;
const FLAC_CACHE_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

function flacCacheEnabled(env) {
  return freeSourceEnabled(env, "FLAC_CACHE_ENABLED") &&
    !!env?.FLAC_CACHE_BUCKET && String(env?.FLAC_CACHE_SIGNING_KEY || "").length >= 32;
}
function isCacheProviderAllowed(env, provider) {
  if (!flacCacheEnabled(env) || provider === "cache" || provider === "personal") return false;
  // No default allowlist. Never silently cache from unknown or paid providers.
  const allowed = String(env.FLAC_CACHE_ALLOWED_PROVIDERS || "")
    .split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(String(provider).toLowerCase());
}
function cacheRecord(meta) {
  // Stable recording identity ignores volatile cross-provider alt/ordering data.
  if (!meta) return null;
  return trackMetadata({ title: meta.title, artist: meta.artist,
    album: meta.album || "", duration: meta.duration });
}
async function flacCacheKey(provider, nativeId, meta) {
  const record = cacheRecord(meta);
  if (!record || !provider || !nativeId) return null;
  const input = `${provider}:${nativeId}:${JSON.stringify(record)}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
function validCacheId(id) { return /^[a-f0-9]{64}$/.test(String(id)); }
function cacheObjectKey(id) { return `${FLAC_CACHE_PREFIX}${id}.flac`; }
function cacheExpiry(object) {
  const expiry = Number(object?.customMetadata?.expiresAt);
  return Number.isFinite(expiry) ? expiry : 0;
}
function hasValidCacheExpiry(object) {
  return cacheExpiry(object) > Date.now() &&
    cacheExpiry(object) <= Date.now() + FLAC_CACHE_TTL_MS + 120000;
}
async function signCacheUrl(id, exp, env) {
  const secret = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.FLAC_CACHE_SIGNING_KEY),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const input = new TextEncoder().encode(`${id}.${exp}`);
  const signature = await crypto.subtle.sign("HMAC", secret, input);
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function validCacheSignature(id, expString, sig, env) {
  if (!validCacheId(id) || !/^\d{10,13}$/.test(String(expString)) ||
      !/^[a-f0-9]{64}$/.test(String(sig || "")) || !flacCacheEnabled(env)) return false;
  const exp = Number(expString);
  if (exp < Date.now() || exp > Date.now() + 12 * 60 * 60 * 1000) return false;
  // WebCrypto constant-time verify rather than direct string comparison.
  const secret = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.FLAC_CACHE_SIGNING_KEY),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const bytes = Uint8Array.from(sig.match(/../g), (h) => parseInt(h, 16));
  return crypto.subtle.verify("HMAC", secret, bytes, new TextEncoder().encode(`${id}.${exp}`));
}
async function resolveCachedFlac(id, env, origin) {
  if (!flacCacheEnabled(env) || !validCacheId(id)) return null;
  try {
    const object = await env.FLAC_CACHE_BUCKET.head(cacheObjectKey(id));
    if (!object || !hasValidCacheExpiry(object)) return null;
    const exp = Math.min(cacheExpiry(object), Date.now() + 6 * 60 * 60 * 1000);
    const sig = await signCacheUrl(id, exp, env);
    return streamFlacUrl(`${origin}/audio/cache/${id}.flac?exp=${exp}&sig=${sig}`);
  } catch {
    console.warn("[FLAC CACHE SKIP] reason=head_error"); return null;
  }
}
async function serveCachedFlac(request, env, url, ctx) {
  const match = url.pathname.match(/^\/audio\/cache\/([a-f0-9]{64})\.flac$/);
  if (!match || !flacCacheEnabled(env)) return noStream(404);
  if (request.method === "OPTIONS") return new Response(null, { status: 204,
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "Range,Content-Type" } });
  if (!["GET", "HEAD"].includes(request.method)) return noStream(405);
  const id = match[1];
  if (!(await validCacheSignature(id, url.searchParams.get("exp"), url.searchParams.get("sig"), env)))
    return noStream(403);
  const key = cacheObjectKey(id);
  try {
    const head = await env.FLAC_CACHE_BUCKET.head(key);
    if (!head) return noStream(404);
    if (!hasValidCacheExpiry(head)) {
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(env.FLAC_CACHE_BUCKET.delete(key));
      return noStream(404);
    }
    const headers = { "Access-Control-Allow-Origin": "*", "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store", "Content-Type": "audio/flac",
      "Access-Control-Expose-Headers": "Content-Length,Content-Range,Accept-Ranges,ETag" };
    headers.ETag = head.httpEtag;
    if (request.method === "HEAD") {
      headers["Content-Length"] = String(head.size);
      return new Response(null, { status: 200, headers });
    }
    const range = request.headers.get("Range");
    const object = await env.FLAC_CACHE_BUCKET.get(key, range ? { range: request.headers } : {});
    if (!object?.body) return noStream(404);
    if (range && object.range && typeof object.range.offset === "number") {
      const begin = object.range.offset;
      const length = object.range.length;
      headers["Content-Range"] = `bytes ${begin}-${begin + length - 1}/${head.size}`;
      headers["Content-Length"] = String(length);
      return new Response(object.body, { status: 206, headers });
    }
    headers["Content-Length"] = String(head.size);
    return new Response(object.body, { status: 200, headers });
  } catch {
    console.warn("[FLAC CACHE SKIP] reason=read_error"); return noStream(502);
  }
}
async function listAllFlacCache(env, maxEntries = 1000) {
  const result = [];
  let cursor;
  do {
    const page = await env.FLAC_CACHE_BUCKET.list({ prefix: FLAC_CACHE_PREFIX,
      limit: Math.min(250, maxEntries - result.length),
      include: ["customMetadata"], ...(cursor ? { cursor } : {}) });
    result.push(...page.objects);
    if (!page.truncated) return { objects: result, truncated: false };
    cursor = page.cursor;
  } while (cursor && result.length < maxEntries);
  return { objects: result, truncated: true }; // fail closed for storage cap
}
async function searchCachedFlac(query, env) {
  if (!flacCacheEnabled(env)) return [];
  const words = normalizeName(query).split(" ").filter((w) => w.length > 2);
  if (!words.length) return [];
  try {
    const page = await listAllFlacCache(env, 500);
    const tracks = [];
    for (const entry of page.objects) {
      if (!hasValidCacheExpiry(entry)) continue;
      const m = entry.customMetadata || {};
      const combined = normalizeName(`${m.title || ""} ${m.artist || ""}`);
      if (!words.every((word) => combined.includes(word))) continue;
      const id = entry.key.slice(FLAC_CACHE_PREFIX.length).replace(/\.flac$/, "");
      if (!validCacheId(id)) continue;
      const track = sourceTrack("cache", id, { title: m.title, artist: m.artist,
        album: m.album || "", duration: Number(m.duration) || 0,
        format: "flac", audioQuality: "LOSSLESS" });
      if (track) tracks.push(track);
      if (tracks.length >= 12) break;
    }
    return tracks;
  } catch {
    console.warn("[FLAC CACHE SKIP] reason=search_error"); return [];
  }
}
// Execute from ctx.waitUntil AFTER giving BitChord the original provider URL.
// Fail safely: no read-response quality downgrade and no incomplete R2 object.
async function saveFlacCache(id, sourceUrl, record, provider, env) {
  if (!isCacheProviderAllowed(env, provider) || !validCacheId(id) ||
      !safePublicAudioUrl(sourceUrl) || !record) return;
  try {
    const existing = await env.FLAC_CACHE_BUCKET.head(cacheObjectKey(id));
    if (existing && hasValidCacheExpiry(existing)) return;
    // Require an explicit Content-Length to avoid streaming unknown-sized or
    // oversized media into R2 and to enforce the small, private 2GB budget.
    const response = await fetch(sourceUrl, { headers: { "Accept-Encoding": "identity" },
      redirect: "follow" });
    if (response.status !== 200 || !response.body) return;
    const length = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(length) || length < 4 || length > FLAC_CACHE_MAX_FILE_BYTES) {
      console.warn("[FLAC CACHE SKIP] reason=size_unknown_or_exceeds_limit");
      await response.body.cancel(); return;
    }
    if (response.headers.get("content-encoding") &&
        response.headers.get("content-encoding") !== "identity") {
      console.warn("[FLAC CACHE SKIP] reason=compressed_transfer");
      await response.body.cancel(); return;
    }
    const page = await listAllFlacCache(env);
    const now = Date.now();
    const total = page.objects.filter((item) => hasValidCacheExpiry(item))
      .reduce((sum, item) => sum + item.size, 0);
    if (page.truncated || total + length > FLAC_CACHE_MAX_TOTAL_BYTES) {
      console.warn("[FLAC CACHE SKIP] reason=storage_budget");
      await response.body.cancel(); return;
    }
    // Clone only the first few bytes to verify FLAC. Never buffer 100 MB.
    const probe = response.clone();
    const reader = probe.body.getReader();
    const head = [];
    try {
      while (head.length < 4) {
        const item = await reader.read();
        if (item.done) break;
        for (const byte of item.value) {
          head.push(byte); if (head.length === 4) break;
        }
      }
    } finally { try { void reader.cancel().catch(() => {}); } catch {} }
    if (head.length !== 4 || head[0] !== 0x66 || head[1] !== 0x4c ||
        head[2] !== 0x61 || head[3] !== 0x43) {
      console.warn("[FLAC CACHE SKIP] reason=not_flac_bytes");
      await response.body.cancel(); return;
    }
    const info = cacheRecord(record);
    if (!info) { await response.body.cancel(); return; }
    const expiresAt = String(now + FLAC_CACHE_TTL_MS);
    // Some stream transformations lose the body's known length. Use
    // FixedLengthStream in Cloudflare to enforce the validated Content-Length
    // and keep R2.put() streaming rather than allocating a large ArrayBuffer.
    let uploadStream = response.body;
    let pump = Promise.resolve();
    if (typeof FixedLengthStream === "function") {
      const bridge = new FixedLengthStream(length);
      uploadStream = bridge.readable;
      pump = response.body.pipeTo(bridge.writable);
    }
    await env.FLAC_CACHE_BUCKET.put(cacheObjectKey(id), uploadStream, {
      httpMetadata: { contentType: "audio/flac", cacheControl: "private, no-store" },
      customMetadata: { title: info.title, artist: info.artist, album: info.album,
        duration: String(info.duration || 0), provider: String(provider), expiresAt }
    });
    await pump;
    console.log(`[FLAC CACHE SAVED] provider=${provider} ttl_hours=36`);
  } catch {
    console.warn("[FLAC CACHE SKIP] reason=download_or_r2_error");
  }
}
async function cleanExpiredFlacCache(env) {
  if (!flacCacheEnabled(env)) return;
  try {
    const page = await listAllFlacCache(env);
    const now = Date.now();
    const expired = page.objects.filter((o) => cacheExpiry(o) <= now);
    if (expired.length) await env.FLAC_CACHE_BUCKET.delete(expired.map((o) => o.key));
    // Additional storage safety: discard oldest fresh files if over 2 GB.
    const fresh = page.objects.filter((o) => cacheExpiry(o) > now)
      .sort((a, b) => cacheExpiry(a) - cacheExpiry(b));
    let total = fresh.reduce((sum, o) => sum + o.size, 0);
    const evict = [];
    for (const item of fresh) {
      if (total <= FLAC_CACHE_MAX_TOTAL_BYTES) break;
      total -= item.size;
      evict.push(item.key);
    }
    if (evict.length) await env.FLAC_CACHE_BUCKET.delete(evict);
    console.log(`[FLAC CACHE CLEANUP] expired=${expired.length} evicted=${evict.length}`);
    if (page.truncated) console.warn("[FLAC CACHE CLEANUP] remaining_entries_past_1000");
  } catch { console.warn("[FLAC CACHE CLEANUP] reason=r2_error"); }
}

// ============================================================================
// CROSS-PROVIDER LOSSLESS RESCUE
// ============================================================================
// Keep enough metadata inside the ID to identify the same recording. The data
// is not a secret or a proof of identity. Newly searched songs receive IDs
// with metadata; older playlist IDs remain playable from the original source.
// Soundtrack metadata is deliberately generic. This also covers games that
// are NOT in the small optional hint list below, provided there are matching
// titles, overlapping composer credits, or strongly matching album+duration.
function trackMetadata(t) {
  if (!t || typeof t !== "object") return null;
  const title = String(t.title || t.name || "").trim().slice(0, 160);
  const artistValue = t.artist || t.artists || t.artistName || t.primaryArtists || "";
  const artist = (Array.isArray(artistValue)
    ? artistValue.map((a) => typeof a === "string" ? a : a?.name || "").join(", ")
    : (typeof artistValue === "object" ? artistValue?.name || "" : String(artistValue))).trim().slice(0, 140);
  const albumValue = t.album || t.albumName || t.albumTitle || t.collectionName || "";
  const album = (typeof albumValue === "object" ? albumValue?.name || albumValue?.title || ""
    : String(albumValue)).trim().slice(0, 125);
  const duration = Number(t.duration ?? t.durationInSeconds ?? (t.durationMs ? t.durationMs / 1000 : 0)) || 0;
  if (!title || !artist || /^(unknown|unknown artist|various artists)$/i.test(artist)) return null;
  return { title, artist, album, duration: duration > 0 && duration < 3000 ? duration : 0 };
}

function encodeMetadata(metadata) {
  const bytes = new TextEncoder().encode(JSON.stringify(metadata));
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unpackTrackId(trackId) {
  const index = trackId.lastIndexOf(METADATA_MARKER);
  if (index < 0) return { nativeId: trackId, metadata: null };
  const nativeId = trackId.slice(0, index);
  const encoded = trackId.slice(index + METADATA_MARKER.length);
  if (!encoded || encoded.length > 1200) return { nativeId: trackId, metadata: null };
  try {
    const input = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(input);
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const metadata = JSON.parse(new TextDecoder().decode(bytes));
    const validated = trackMetadata(metadata);
    if (validated && Array.isArray(metadata.alt)) {
      validated.alt = metadata.alt.filter((entry) => Array.isArray(entry) && entry.length === 2 &&
        (Number.isInteger(entry[0]) && entry[0] >= 0 && entry[0] < DISCORD_ADDONS.length ||
        ["jamendo", "ia", "personal", "openverse", "commons", "cache"].includes(entry[0])) &&
        typeof entry[1] === "string" && entry[1].length <= 210).slice(0, MAX_RESULT_ALTERNATIVES);
    }
    return { nativeId, metadata: validated };
  } catch {
    return { nativeId: trackId, metadata: null };
  }
}

// Unicode-aware matching: the earlier ASCII-only normalizer discarded
// Japanese, Chinese and Korean titles entirely, creating false collisions.
function normalizeName(s) {
  return String(s || "").normalize("NFKC").normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim().replace(/\s+/g, " ");
}


// Conservative, curated Japanese ↔ Romaji/English equivalences. No automatic
// Kanji transliteration: one Japanese spelling can have many valid readings.
// Aliases are ONLY one signal; matching still checks version, artist and time.
const TITLE_ALIAS_GROUPS = [
  ["千本桜", "senbonzakura"],
  ["ロミオとシンデレラ", "romeo and cinderella", "romeo to cinderella"],
  ["ワールドイズマイン", "world is mine"],
  ["メルト", "melt"],
  ["ローリンガール", "rolling girl"],
  ["ゴーストルール", "ghost rule"],
  ["ヒバナ", "hibana"],
  // DECO*27 original track, 2023. Do not conflate with the Reloaded recording.
  ["ラビットホール", "rabbit hole", "rabitto hooru", "rabitto horu"],
  ["初音ミクの消失", "the disappearance of hatsune miku", "hatsune miku no shoushitsu"],
  ["砂の惑星", "sand planet", "suna no wakusei"],
  ["シャルル", "charles"],
  ["アイドル", "idol"],
  ["紅蓮華", "gurenge"],
  ["夜に駆ける", "racing into the night", "yoru ni kakeru"],
  ["残酷な天使のテーゼ", "a cruel angel's thesis", "zankoku na tenshi no thesis"]
];
const TITLE_ALIAS_INDEX = new Map();
for (const group of TITLE_ALIAS_GROUPS) {
  const normalized = [...new Set(group.map((name) => normalizeName(name)))];
  for (const name of normalized) TITLE_ALIAS_INDEX.set(name, normalized);
}
function cleanVersionDecorations(title) {
  // Only remove parenthesized versions/credits; versionTags is checked first.
  // Treat English/Japanese catalog decorations identically.
  return normalizeName(String(title || "")
    .replace(/\s*[\(\[【](?:tv(?:\s+|-)?(?:size|ver(?:sion)?)|テレビサイズ|tvサイズ|full(?:\s+|-)?(?:ver(?:sion)?|size)|フル(?:サイズ|ver)?|anime(?:\s+|-)?edit|instrumental|インスト|off\s*vocal|カラオケ|live|ライブ|remix|リミックス|reloaded(?:\s+(?:ver|version))?)[\)\]】]\s*$/iu, " ")
    .replace(/\s+(?:tv(?:\s+|-)?(?:size|ver(?:sion)?)|full(?:\s+|-)?(?:size|ver(?:sion)?)|movie(?:\s+|-)?ver(?:sion)?|instrumental|karaoke|off\s*vocal|live|remix|テレビサイズ|tvサイズ|フルサイズ|ライブ|リミックス|reloaded(?:\s+(?:ver|version))?)\s*$/iu, ""));
}
function titleAliasKeys(name) {
  const normalized = normalizeName(name);
  const base = cleanVersionDecorations(name);
  const variants = new Set([normalized, base]);
  for (const key of [normalized, base]) for (const alias of TITLE_ALIAS_INDEX.get(key) || []) variants.add(alias);
  return [...variants].filter(Boolean);
}
function recoverySearchTitle(title) {
  const name = cleanVersionDecorations(title);
  const aliases = TITLE_ALIAS_INDEX.get(name) || [];
  // Switch script when possible. This changes existing requests, not request count.
  return aliases.find((alias) => isBilingualPair(name, alias)) || title;
}
const VOICEBANK_ALIASES = new Map([
  ["初音ミク", "hatsune miku"], ["hatsune miku", "hatsune miku"], ["miku hatsune", "hatsune miku"],
  ["鏡音リン", "kagamine rin"], ["kagamine rin", "kagamine rin"],
  ["鏡音レン", "kagamine len"], ["kagamine len", "kagamine len"],
  ["巡音ルカ", "megurine luka"], ["megurine luka", "megurine luka"],
  ["重音テト", "kasane teto"], ["kasane teto", "kasane teto"],
  ["可不", "kafu"], ["kafu", "kafu"], ["flower vocaloid", "v flower"], ["v flower", "v flower"]
]);
// Known producers only; a voicebank is not evidence two productions are the same.
const PRODUCER_ALIASES = new Map([
  ["deco 27", "deco27"], ["deco27", "deco27"],
  ["ryo", "ryo supercell"], ["supercell", "ryo supercell"], ["ryo supercell", "ryo supercell"],
  ["wowaka", "wowaka"], ["現実逃避p", "wowaka"],
  ["黒うさp", "kurousa p"], ["kurousa p", "kurousa p"], ["whiteflame", "kurousa p"],
  ["livetune", "kz livetune"], ["kz livetune", "kz livetune"],
  ["八王子p", "hachioji p"], ["hachioji p", "hachioji p"],
  ["ピノキオピー", "pinocchiop"], ["pinocchiop", "pinocchiop"],
  ["giga", "giga"], ["ギガp", "giga"]
]);
function normalizedCredit(value) {
  const name = normalizeName(value).replace(/^(?:feat|featuring|ft)\s+/i, "");
  return VOICEBANK_ALIASES.get(name) || PRODUCER_ALIASES.get(name) || ARTIST_ALIASES.get(name) || name;
}
function voicebankCredit(credit) { return [...VOICEBANK_ALIASES.values()].includes(credit); }
function producerCredits(value) { return artistCredits(value).filter((credit) => !voicebankCredit(credit)); }
function voicebankCredits(value) { return artistCredits(value).filter(voicebankCredit); }
function isVocalSynthRecording(meta) {
  const raw = normalizeName(`${meta?.artist || ""} ${meta?.album || ""}`);
  return voicebankCredits(meta?.artist).length > 0 || /(?:vocaloid|ボカロ|synthesizer v|utau|プロセカ|project sekai)/iu.test(raw);
}
function isAnimeSoundtrack(meta) {
  const raw = normalizeName(`${meta?.album || ""} ${meta?.title || ""}`);
  return /(?:anime|アニメ|ost|soundtrack|サウンドトラック|オリジナルサウンドトラック|opening|ending|主題歌|挿入歌|劇場版)/iu.test(raw);
}
// Canonical tags are intentionally conservative. Ignore generic anime OP/ED
// attributions that do not identify a different recording. Reject TV-size,
// movie versions, karaoke, performances, covers and mixes as distinct.
function editionTags(title) {
  const text = normalizeName(title);
  const tags = new Set(versionTags(title).split("|").filter(Boolean));
  const match = (pattern, tag) => { if (pattern.test(text)) tags.add(tag); };
  match(/\b(?:tv size|tv ver|tv version|tv edit|anime edit|short ver|short version|short edit)\b|(?:tvサイズ|テレビサイズ|テレビ版|ショート版)/iu, "tv_size");
  match(/\b(?:full version|full ver|full size|full length)\b|(?:フルサイズ|フルバージョン)/iu, "full_version");
  match(/\b(?:movie ver|movie version|film version|theatrical version)\b|(?:劇場版|映画版)/iu, "movie_version");
  match(/\b(?:off vocal|no vocals|without vocals|instrumental|karaoke)\b|(?:オフボーカル|カラオケ|インスト(?:版)?)/iu, "instrumental");
  match(/\b(?:live|live version|live recording)\b|(?:ライブ|ライヴ)/iu, "live");
  match(/\b(?:cover|cover version)\b|(?:歌ってみた|カバー)/iu, "cover");
  match(/\b(?:remix|remixed|nightcore|sped up|slowed)\b|(?:リミックス|倍速)/iu, "remix");
  match(/\breloaded(?:\s+(?:ver|version))?\b|(?:リローデッド)/iu, "reloaded");
  return [...tags].sort().join("|");
}

// Small registry of ALIAS SPELLINGS, not a claim that these artists are
// identical to their publisher, record label or game studio. Extend safely.
const ARTIST_ALIASES = new Map([
  ["hoyomix", "hoyo mix"],
  ["hoyo mix", "hoyo mix"],
  ["vanguard sound studio", "vanguard sound"],
  ["vanguard sound", "vanguard sound"],
  ["monster siren", "monster siren records"],
  ["monster siren records", "monster siren records"]
]);
function artistIdentity(value) {
  const clean = normalizeName(value);
  return normalizedCredit(clean);
}
function artistCredits(value) {
  const text = String(value || "")
    .replace(/[（(]\s*(?:feat(?:uring)?|ft)\.?\s*/giu, " feat. ")
    .replace(/[）)]/g, " ");
  return [...new Set(text.split(/\s*(?:,|;|、|，|\/|\bfeat(?:uring)?\.?\s*|\bft\.?\s*|\bwith\b|&|\s+x\s+)\s*/iu)
    .map(artistIdentity).filter((name) => name && name !== "various artists"))];
}
function primaryArtist(value) { return artistCredits(value)[0] || ""; }

// Never drop qualifiers that distinguish different recordings.
const VERSION_RE = /\b(extended(?: version| mix)?|album edit|mixed cut|radio edit|radio version|radio mix|single edit|original mix|original version|club mix|kick mix|vip mix|bootleg|instrumental|karaoke|acoustic|live|remix|remastered|remaster|cover|piano version|orchestral version|sped up|slowed|nightcore|demo|re recording|re recorded|trailer version|teaser version|reloaded(?: version| ver)?)\b/giu;
function versionTags(title) {
  return [...new Set([...normalizeName(title).matchAll(VERSION_RE)].map((m) => m[0]))].sort().join("|");
}
function originalMixBase(title) {
  const value = normalizeName(title);
  if (!/\b(?:original mix|original version)$/.test(value)) return null;
  const base = value.replace(/\s+(?:original mix|original version)$/, "").trim();
  return base.length >= 3 ? base : null;
}
const SOUNDTRACK_HINTS = [
  "genshin impact", "honkai", "zenless zone zero", "wuthering waves",
  "arknights", "blue archive", "punishing gray raven", "azur lane",
  "girls frontline", "nikke", "reverse 1999", "fate grand order",
  "project sekai", "granblue fantasy", "limbus company"
];
function looksLikeGameSoundtrack(meta) {
  const text = normalizeName(`${meta?.title || ""} ${meta?.album || ""} ${meta?.artist || ""}`);
  return /\b(ost|soundtrack|game soundtrack|game music)\b/.test(text)
    || SOUNDTRACK_HINTS.some((s) => text.includes(s))
    || ["hoyo mix", "vanguard sound", "monster siren records"].some((s) => artistCredits(meta?.artist).includes(s));
}
function sameAlbum(wanted, candidate) {
  const albumKey = (s) => normalizeName(s)
    .replace(/\b(original|official|video game|game|soundtrack|ost|music from|the)\b/g, " ")
    .trim().replace(/\s+/g, " ");
  const a = albumKey(wanted?.album), b = albumKey(candidate?.album);
  // Generic values such as "OST" are not sufficient evidence.
  return !!(a && a === b && ([...a].length >= 3));
}
function isBilingualPair(a, b) {
  const hasHan = (s) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(s);
  return hasHan(a) !== hasHan(b);
}
function titleVariants(title) {
  const raw = String(title || "").normalize("NFKC").trim();
  const variants = new Set([normalizeName(raw)]);
  // Compare alternate-script Reloaded versions with other Reloaded versions,
  // but editionTags still rejects replacing a normal release with Reloaded.
  if (editionTags(raw).split("|").includes("reloaded")) {
    for (const alias of titleAliasKeys(cleanVersionDecorations(raw))) variants.add(alias);
  }
  // Bilingual official titles often include an English translation in brackets.
  // Only interpret the bracket as an alternate title if its script differs.
  const bracket = raw.match(/^(.{2,130}?)\s*[\(\[【]([^()\[\]【】]{2,100})[\)\]】]\s*$/u);
  if (bracket && isBilingualPair(bracket[1], bracket[2])) {
    variants.add(normalizeName(bracket[1]));
    variants.add(normalizeName(bracket[2]));
  }
  // A soundtrack attribution prefix is not part of a track title. Avoid
  // stripping arbitrary artist names or musical version labels.
  const prefix = raw.match(/^(.{2,85}?)\s*(?:[-:|｜])\s*(.{2,140})$/u);
  if (prefix && (looksLikeGameSoundtrack({title: prefix[1]}) || /\b(tune|theme)\b/i.test(prefix[1]))) {
    variants.add(normalizeName(prefix[2]));
  }
  // Expand only curated official-equivalent titles. Each still needs strong
  // artist and version evidence to become a cross-provider candidate.
  for (const part of [...variants]) for (const alias of titleAliasKeys(part)) variants.add(alias);
  return [...variants].filter(Boolean);
}
// v3.7.3: detailed decisions, safe to aggregate without exposing track titles.
// Bare titles may equal an explicitly labeled Original Mix only with both
// durations present (within 2s) and overlapping artist credits.
function recordingMatchDecision(wanted, candidate) {
  const actual = trackMetadata(candidate);
  if (!actual || !wanted?.title || !wanted?.artist) return { ok: false, reason: "missing_metadata" };
  const wantedTags = editionTags(wanted.title);
  const actualTags = editionTags(actual.title);
  const wantedVariants = new Set(titleVariants(wanted.title));
  const actualVariants = titleVariants(actual.title);
  const literalTitleMatch = actualVariants.some((part) => wantedVariants.has(part));
  const wantedBase = originalMixBase(wanted.title);
  const actualBase = originalMixBase(actual.title);
  const validOriginalPair = ((wantedBase && !actualTags && wantedBase === normalizeName(actual.title)) ||
    (actualBase && !wantedTags && actualBase === normalizeName(wanted.title)));
  if (wantedTags !== actualTags && !validOriginalPair)
    return { ok: false, reason: "version_conflict" };
  if (!literalTitleMatch && !validOriginalPair)
    return { ok: false, reason: "title_mismatch" };
  if (wanted.duration && actual.duration && Math.abs(wanted.duration - actual.duration) > (validOriginalPair ? 2 : 5))
    return { ok: false, reason: "duration_mismatch" };
  const wantedArtists = new Set(artistCredits(wanted.artist));
  const creditOverlap = artistCredits(actual.artist).some((name) => wantedArtists.has(name));
  if (validOriginalPair && (!wanted.duration || !actual.duration || !creditOverlap))
    return { ok: false, reason: "original_mix_needs_proof" };
  const vocalSynth = isVocalSynthRecording(wanted) || isVocalSynthRecording(actual);
  if (vocalSynth) {
    const wantedProducers = producerCredits(wanted.artist);
    const actualProducers = producerCredits(actual.artist);
    const sharedProducer = actualProducers.some((p) => wantedProducers.includes(p));
    const wantedVoices = voicebankCredits(wanted.artist);
    const actualVoices = voicebankCredits(actual.artist);
    if (wantedVoices.length && actualVoices.length &&
        !wantedVoices.some((voice) => actualVoices.includes(voice)))
      return { ok: false, reason: "voicebank_conflict" };
    // A matching singer/voicebank alone does not identify the producer.
    if (wantedProducers.length && actualProducers.length && !sharedProducer)
      return { ok: false, reason: "producer_conflict" };
    if ((!wantedProducers.length || !actualProducers.length) && !sharedProducer) {
      if (!(sameAlbum(wanted, actual) && wanted.duration && actual.duration &&
          Math.abs(wanted.duration - actual.duration) <= 2))
        return { ok: false, reason: "vocaloid_producer_unverified" };
    }
  }
  if (creditOverlap) {
    const genericTheme = /^(?:main theme|battle theme|boss theme|boss battle|opening theme|ending theme|title theme|event theme|prologue|epilogue|overture|intro|outro)$/u.test(normalizeName(wanted.title));
    if (genericTheme && (looksLikeGameSoundtrack(wanted) || looksLikeGameSoundtrack(actual))) {
      if (wanted.album && actual.album && !sameAlbum(wanted, actual))
        return { ok: false, reason: "album_mismatch" };
      if (!sameAlbum(wanted, actual) && (!wanted.duration || !actual.duration))
        return { ok: false, reason: "generic_title_ambiguous" };
    }
    return { ok: true, reason: validOriginalPair ? "verified_original_mix" : "matched" };
  }
  if (sameAlbum(wanted, actual) && wanted.duration && actual.duration &&
    Math.abs(wanted.duration - actual.duration) <= 3)
    return { ok: true, reason: "album_duration_match" };
  return { ok: false, reason: "artist_or_album_mismatch" };
}
function isSameRecording(wanted, candidate) {
  return recordingMatchDecision(wanted, candidate).ok;
}

// BitChord only asks for Atmos on eligible devices with Dolby enabled. The
// Worker additionally requires ATMOS_ENABLED=true; a spoofed query alone is
// insufficient to turn on this mode.
function wantsAtmos(url, env) {
  return freeSourceEnabled(env, "ATMOS_ENABLED") &&
    String(url.searchParams.get("atmos") || "").toLowerCase() === "auto";
}
function isAtmosTrackClaim(t) {
  if (!t || typeof t !== "object") return false;
  const values = [t.audioMode, ...(Array.isArray(t.audioModes) ? t.audioModes : []),
    t.codec, t.quality, t.audioQuality].map((v) => String(v || "").toLowerCase());
  return t.atmos === true || values.some((v) =>
    /(?:dolby[_ -]?atmos|e[-_]?ac[-_]?3[-_]?joc|eac3[-_]?joc|ec[-_]?3[-_]?joc)/.test(v));
}
function isLosslessTrackClaim(t) {
  if (!t || typeof t !== "object") return false;
  const vals = [t.format, t.codec, t.container, t.audioQuality, t.quality]
    .map((v) => String(v || "").toLowerCase());
  if (isAtmosTrackClaim(t) || vals.some((v) =>
    /(?:aac|mp3|opus|vorbis|webm|mp4a|e[-_]?ac[-_]?3|eac3|ec[-_]?3|joc|ac[-_]?4|dolby|atmos|alac|mpeg|ogg)/.test(v))) return false;
  return vals.some((v) => v.includes("flac") || v.includes("lossless"));
}
function isFlacStream(t) {
  if (!t || !isPlayableUrl(t.url) || t.encrypted === true || t.encrypted === "true") return false;
  const flags = [t.format, t.codec, t.container, t.mimeType, t.mime_type,
    t.manifest, t.audioMode, ...(Array.isArray(t.audioModes) ? t.audioModes : [])]
    .map((v) => String(v || "").toLowerCase());
  // Any explicit conflicting codec invalidates a nominal FLAC claim. In
  // particular 'ec-3' without 'joc' is still NOT FLAC (v3.7.5 bug fix).
  if (t.atmos === true || flags.some((v) =>
    /(?:aac|mp3|opus|vorbis|webm|mp4a|e[-_]?ac[-_]?3|eac3|ec[-_]?3|joc|ac[-_]?4|dolby|atmos|alac|mpeg|ogg)/.test(v))) return false;
  if (flags.some((v) => /(?:hls|dash|m3u8|mpd)/.test(v))) return false;
  try {
    const url = new URL(t.url);
    if (/(^|\.)(youtube\.com|youtu\.be|googlevideo\.com|youtube-nocookie\.com)$/.test(url.hostname.toLowerCase())) return false;
    const path = decodeURIComponent(url.pathname).toLowerCase();
    if (/\.(opus|webm|mp3|m4a|mp4|aac|ogg|m3u8|mpd|ec3|eac3)$/.test(path)) return false;
    const explicit = flags.some((v) => /\bflac\b/.test(v));
    return explicit || path.endsWith(".flac");
  } catch { return false; }
}
// E-AC-3 JOC is Dolby Digital Plus Atmos, not lossless FLAC. Explicit JOC
// identification is required: ordinary ec-3 alone is NOT enough.
function isAtmosStream(t) {
  if (!t || !isPlayableUrl(t.url) || t.encrypted === true || t.encrypted === "true") return false;
  const codec = String(t.codec || "").toLowerCase().replace(/[_\s]/g, "-");
  if (!/(?:^|\b)(?:e-?ac-?3|eac3|ec-?3)-joc(?:$|\b)/.test(codec)) return false;
  const flags = [t.format, t.container, t.mimeType, t.mime_type]
    .map((v) => String(v || "").toLowerCase());
  if (flags.some((v) => /(?:flac|alac|aac|mp3|opus|webm)/.test(v))) return false;
  const manifest = String(t.manifest || "none").toLowerCase();
  if (!["none", "hls", "dash"].includes(manifest)) return false;
  try {
    const path = decodeURIComponent(new URL(t.url).pathname).toLowerCase();
    if (/\.(flac|mp3|aac|opus|webm)$/.test(path)) return false;
    if (manifest === "none" && /\.(mpd|m3u8)$/.test(path)) return false;
    return true;
  } catch { return false; }
}
function isAllowedStream(stream, wantAtmos) {
  return isFlacStream(stream) || (wantAtmos && isAtmosStream(stream));
}
function normalizeAtmosStream(stream) {
  const { _resolvedProvider, bitDepth, ...fields } = stream;
  const manifest = String(stream.manifest || "none").toLowerCase();
  return { ...fields, format: stream.format || (manifest !== "none" ? manifest : "eac3"),
    codec: "eac3-joc", container: stream.container || "mp4", manifest,
    quality: "Dolby Atmos", audioMode: "DOLBY_ATMOS", atmos: true, encrypted: false };
}
// Some upstreams label a radio/album edit as "Original Mix". When the
// resolver explicitly includes stream duration, reject mismatched recordings.
// This is a metadata check, NOT audio fingerprinting or FLAC byte inspection.
function streamDurationSeconds(stream) {
  if (!stream || typeof stream !== "object") return 0;
  const seconds = Number(stream.durationInSeconds ?? stream.durationSeconds ?? stream.duration);
  if (Number.isFinite(seconds) && seconds > 0 && seconds <= 3000) return seconds;
  const milliseconds = Number(stream.durationMs);
  if (Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds <= 3000000) return milliseconds / 1000;
  return 0;
}
function streamMatchesExpectedDuration(stream, expectedDuration) {
  if (!(Number(expectedDuration) > 0)) return true;
  const actual = streamDurationSeconds(stream);
  return !(actual > 0 && Math.abs(actual - Number(expectedDuration)) > 5);
}

function normalizeFlacStream(stream) {
  const { _resolvedProvider, ...publicFields } = stream;
  return { ...publicFields, format: "flac", codec: "flac", container: "flac", manifest: "none", encrypted: false };
}
function noStream(status) {
  return new Response(null, { status, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
}

// Search once, share verified same-recording candidates with the stream call.
// This removes the biggest source of delays in the previous implementation.
function sourceRank(provider) {
  if (provider === "cache") return -20;
  if (provider === "personal") return 0;
  if (provider === "openverse") return 85;
  if (provider === "commons") return 88;
  if (provider === "jamendo") return 70;
  if (provider === "ia") return 80;
  const m = String(provider).match(/^discord_(\d+)$/);
  return m ? preferredRank(Number(m[1])) : 1000;
}
function sourceEnabled(provider, env) {
  if (provider === "cache") return flacCacheEnabled(env);
  if (provider === "jamendo") return !!getJamendoClientId(env);
  if (provider === "ia") return !!FALLBACK_SOURCES.IA_ENABLED;
  if (provider === "personal") return false; // Authentication not implemented.
  if (provider === "openverse") return freeSourceEnabled(env, "OPENVERSE_ENABLED");
  if (provider === "commons") return freeSourceEnabled(env, "COMMONS_ENABLED");
  const match = String(provider).match(/^discord_(\d+)$/);
  return !!(match && configuredAddonUrl(Number(match[1]), env));
}
function addKnownAlternatives(tracks) {
  const originals = tracks.map((t) => {
    const fullId = String(t.id || "");
    const sep = fullId.indexOf(":");
    if (sep < 0) return null;
    const provider = fullId.slice(0, sep);
    if (!/^discord_\d+$/.test(provider) && !["jamendo", "ia", "personal", "openverse", "commons", "cache"].includes(provider)) return null;
    const decoded = unpackTrackId(fullId.slice(sep + 1));
    return { item: t, provider, nativeId: decoded.nativeId, meta: decoded.metadata };
  });
  return tracks.map((track, position) => {
    const origin = originals[position];
    if (!origin?.meta) return track;
    const alternatives = [];
    for (const target of originals) {
      if (!target || target.provider === origin.provider || !target.meta || !isLosslessTrackClaim(target.item)) continue;
      if (!isSameRecording(origin.meta, target.item)) continue;
      if (target.nativeId.length > 210 || target.nativeId.length < 1) continue;
      const normalizedProvider = target.provider.startsWith("discord_") ? Number(target.provider.slice(8)) : target.provider;
      if (alternatives.some((a) => a[0] === normalizedProvider)) continue;
      alternatives.push([normalizedProvider, target.nativeId]);
    }
    alternatives.sort((a, b) => sourceRank(typeof a[0] === "number" ? `discord_${a[0]}` : a[0])
      - sourceRank(typeof b[0] === "number" ? `discord_${b[0]}` : b[0]));
    const packed = { ...origin.meta, alt: alternatives.slice(0, MAX_RESULT_ALTERNATIVES) };
    const id = `${origin.provider}:${origin.nativeId}${METADATA_MARKER}${encodeMetadata(packed)}`;
    return id.length <= 1900 ? { ...track, id } : track;
  });
}
async function findMatchingFlacStream(wanted, primaryProvider, quality, atmos, started, env, workerOrigin) {
  const deadline = started + MAX_RESCUE_DURATION_MS;
  const seen = new Set();
  function cleanCandidates(incoming) {
    return incoming.filter(({ provider, nativeId }) => {
      if (provider === primaryProvider || !sourceEnabled(provider, env) ||
        typeof nativeId !== "string" || !nativeId || nativeId.length > 210) return false;
      const key = `${provider}:${nativeId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      const match = provider.match(/^discord_(\d+)$/);
      if (match && streamRecentlyFailed(Number(match[1]), nativeId)) return false;
      return true;
    }).sort((a, b) => {
      const ac = providerIsCooling(a.provider), bc = providerIsCooling(b.provider);
      return Number(ac) - Number(bc) || sourceRank(a.provider) - sourceRank(b.provider);
    });
  }
  function providerIsCooling(provider) {
    const m = provider.match(/^discord_(\d+)$/);
    return !!(m && providerCooling(Number(m[1]), "stream"));
  }
  async function resolveCandidate(candidate, timeout) {
    const { provider, nativeId } = candidate;
    if (provider.startsWith("discord_")) {
      const index = Number(provider.slice(8));
      return resolveDiscordAddon(configuredAddonUrl(index, env), nativeId, quality, atmos, index, false, timeout, false, env, deadline);
    }
    if (provider === "jamendo") return resolveJamendoFlac(nativeId, env);
    if (provider === "ia") return resolveArchiveFlac(nativeId);
    if (provider === "personal") return resolvePersonalFlac(nativeId, env, workerOrigin);
    if (provider === "openverse") return resolveOpenverseFlac(nativeId, env);
    if (provider === "commons") return resolveCommonsFlac(nativeId, env);
    if (provider === "cache") return resolveCachedFlac(nativeId, env, workerOrigin);
    return null;
  }
  async function resolveCandidateBatch(candidates, label) {
    const remaining = deadline - Date.now();
    if (remaining < 500 || !candidates.length) return null;
    // Don't retry providers with a current stream cooldown: doing so consumes
    // the limited playback deadline and worsens 429/502 responses.
    const usable = candidates.filter(({ provider }) => !providerIsCooling(provider))
      .slice(0, MAX_RESCUE_TOTAL_CANDIDATES);
    if (!usable.length) {
      console.warn(`[FLAC RESCUE SKIP] phase=${label} reason=providers_cooling candidates=${candidates.length}`);
      return null;
    }
    for (let offset = 0; offset < usable.length; offset += MAX_FALLBACK_STREAMS) {
      const remaining = deadline - Date.now();
      if (remaining < 700) break;
      const pool = usable.slice(offset, offset + MAX_FALLBACK_STREAMS);
      // Reserve the verification window inside the same rescue deadline.
      // Fewer serial rounds; up to three candidates raced in each round.
      const verifyBudget = flacProbeTimeoutMs(env);
      const timeout = Math.min(STREAM_TIMEOUT_MS, Math.max(400, remaining - verifyBudget - 100));
      console.log(`[FLAC RESCUE ${label}] candidates=${pool.length} round=${Math.floor(offset / MAX_FALLBACK_STREAMS) + 1} budget_ms=${remaining}`);
      try {
        const winner = await Promise.any(pool.map(async (candidate) => {
          const data = await resolveCandidate(candidate, timeout);
          if (!isFlacStream(data)) throw new Error("non_flac_or_missing");
          if (!streamMatchesExpectedDuration(data, wanted.duration)) {
            console.warn(`[STREAM DURATION MISMATCH] provider=${candidate.provider} phase=${label}`);
            throw new Error("wrong_recording_duration");
          }
          return { ...normalizeFlacStream(data), _resolvedProvider: candidate.provider };
        }));
        console.log(`[FLAC RESCUE SUCCESS] provider=${winner._resolvedProvider}`);
        return winner;
      } catch {
        console.warn(`[FLAC RESCUE BATCH FAILED] phase=${label} attempted=${pool.length}`);
      }
    }
    return null;
  }

  const cached = cleanCandidates((wanted.alt || []).map(([index, nativeId]) => ({
    provider: typeof index === "number" ? `discord_${index}` : index, nativeId
  })));
  if (cached.length) {
    const found = await resolveCandidateBatch(cached, "CACHED");
    if (found) return found;
  }
  let remaining = deadline - Date.now();
  if (remaining < 2200) {
    console.warn(`[FLAC RESCUE EXHAUSTED] reason=deadline remaining_ms=${Math.max(0, remaining)}`);
    return null;
  }
  const available = configuredAddons(env).map((url, index) => ({ url, index }))
    .filter(({ url, index }) => url && `discord_${index}` !== primaryProvider
      && !providerCooling(index, "search") && !providerCooling(index, "stream"))
    .sort((a, b) => preferredRank(a.index) - preferredRank(b.index));
  const previousProviders = new Set((wanted.alt || []).map((a) =>
    typeof a[0] === "number" ? `discord_${a[0]}` : a[0]));
  const untried = available.filter(({ index }) => !previousProviders.has(`discord_${index}`));
  const sources = (untried.length ? untried : available).slice(0, 4);
  console.log(`[PROVIDER PRIORITY] phase=rescue order=${sources.map(({ index }) => `discord_${index}`).join(",") || "none"} evidence=verified_flac_and_recent_health`);
  const searchTimeout = Math.min(RESCUE_SEARCH_TIMEOUT_MS, remaining - 1700);
  if (searchTimeout < 450) return null;
  // For game/anime soundtracks, some catalogs index tracks under the game or
  // composer rather than the collective artist. Distribute two query shapes
  // across the SAME four upstream slots, not eight requests in a row.
  const soundtrack = looksLikeGameSoundtrack(wanted) || isAnimeSoundtrack(wanted) || isVocalSynthRecording(wanted);
  const compactTitle = wanted.title; // Preserve original script/capitalization for upstream text search.
  const alternateTitle = recoverySearchTitle(wanted.title);
  const queries = sources.map((source, slot) => ({
    ...source,
    // Reuse four existing requests: alternate Japanese/Romaji title takes an
    // existing query slot, never introduces an additional serial provider call.
    query: slot % 2 === 1 && alternateTitle !== compactTitle
      ? `${alternateTitle} ${producerCredits(wanted.artist)[0] || wanted.artist}`
      : soundtrack && slot % 2 === 1 ? compactTitle : `${wanted.title} ${wanted.artist}`
  }));
  if (alternateTitle !== compactTitle) console.log("[JP ALIAS DISCOVERY] alternate_script_query=true");
  if (soundtrack) console.log(`[OST DISCOVERY] query_modes=artist_and_title_or_title_only providers=${queries.length}`);
  const discovery = queries.map(({ url, index, query }) =>
    searchDiscordAddon(url, index, query, searchTimeout));
  // A free Jamendo read API client ID enables it as a recovery source.
  if (getJamendoClientId(env) && primaryProvider !== "jamendo")
    discovery.push(searchJamendo(`${wanted.title} ${wanted.artist}`, env, searchTimeout));
  // Cached tracks can rescue a stream even if the original catalog is down.
  if (flacCacheEnabled(env) && primaryProvider !== "cache")
    discovery.push(searchCachedFlac(`${wanted.title} ${wanted.artist}`, env));
  // Last-resort free catalog discovery for unresolved tracks. These remain
  // opt-in and have independent per-isolate request caps.
  if (primaryProvider !== "openverse" && freeSourceEnabled(env, "OPENVERSE_ENABLED"))
    discovery.push(searchOpenverseFlac(`${wanted.title} ${wanted.artist}`, env));
  if (primaryProvider !== "commons" && freeSourceEnabled(env, "COMMONS_ENABLED"))
    discovery.push(searchCommonsFlac(`${wanted.title} ${wanted.artist}`, env));
  const results = await Promise.allSettled(discovery);
  const candidates = [];
  let checkedLossless = 0, rejectedMatch = 0;
  const reasons = Object.create(null);
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const track of result.value) {
      if (!isLosslessTrackClaim(track)) continue;
      checkedLossless++;
      const decision = recordingMatchDecision(wanted, track);
      reasons[decision.reason] = (reasons[decision.reason] || 0) + 1;
      if (!decision.ok) { rejectedMatch++; continue; }
      const sep = String(track.id).indexOf(":");
      const provider = String(track.id).slice(0, sep);
      const { nativeId } = unpackTrackId(String(track.id).slice(sep + 1));
      candidates.push({ provider, nativeId });
    }
  }
  const fresh = cleanCandidates(candidates);
  if (soundtrack) console.log(`[OST MATCH] lossless_claims=${checkedLossless} rejected_metadata=${rejectedMatch} candidates=${fresh.length}`);
  const compactReasons = Object.entries(reasons).sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}:${count}`).join(",") || "none";
  console.log(`[MATCH REASONS] checked=${checkedLossless} rejected=${rejectedMatch} reasons=${compactReasons}`);
  if (!fresh.length) {
    console.warn(`[FLAC RESCUE EXHAUSTED] reason=no_fresh_match searched=${discovery.length}`);
    return null;
  }
  const resolved = await resolveCandidateBatch(fresh, "FRESH");
  if (!resolved) console.warn(`[FLAC RESCUE EXHAUSTED] reason=all_candidates_failed`);
  return resolved;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================
function isPlayableUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function safeError(err) {
  // Don't log signed provider URLs, bearer tokens, or sensitive query strings.
  const message = String(err?.message || "unknown_error");
  return /^[a-z0-9_]+$/i.test(message) ? message : "upstream_error";
}

function getQualityScore(track) {
  let score = 0;
  if (String(track.id).startsWith("discord_")) score += 10;
  if (String(track.id).startsWith("personal:")) score += 18;
  if (track.audioQuality === "LOSSLESS" || track.format === "flac") score += 20;
  else if (track.audioQuality === "HIGH") score += 5;
  return score;
}

function cleanText(str) {
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#039;/g, "'");
}

function json(value, cacheAge = 0) {
  const headers = {
    "Access-Control-Allow-Origin": "*"
  };
  
  if (cacheAge > 0) {
    headers["Cache-Control"] = `public, max-age=${cacheAge}, s-maxage=${cacheAge}`;
  } else {
    headers["Cache-Control"] = "no-store";
  }
  
  return Response.json(value, { headers });
}