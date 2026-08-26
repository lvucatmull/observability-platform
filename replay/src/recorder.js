import { record } from "rrweb";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_INACTIVITY_MS = 60_000;

function assertOption(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} is required.`);
  }
  return value.trim();
}

function clampSamplingRate(value) {
  const rate = Number(value ?? 0.1);
  if (!Number.isFinite(rate)) return 0.1;
  return Math.min(1, Math.max(0, rate));
}

function isSampled(sessionId, samplingRate) {
  if (samplingRate >= 1) return true;
  if (samplingRate <= 0) return false;
  let hash = 2166136261;
  for (const character of sessionId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 2 ** 32 < samplingRate;
}

function createUploader(options, sessionId) {
  const endpoint = new URL(options.endpoint);
  const batchUrl = new URL(
    `/api/v1/replays/${encodeURIComponent(sessionId)}/batches`,
    endpoint,
  );
  const completeUrl = new URL(
    `/api/v1/replays/${encodeURIComponent(sessionId)}/complete`,
    endpoint,
  );

  const headers = { "content-type": "application/json" };
  if (options.ingestKey) headers["x-replay-ingest-key"] = options.ingestKey;

  return {
    async batch(events, keepalive = false) {
      const response = await fetch(batchUrl, {
        method: "POST",
        headers,
        credentials: endpoint.origin === window.location.origin ? "same-origin" : "omit",
        keepalive,
        body: JSON.stringify({
          project: options.project,
          service: options.service,
          environment: options.environment,
          startedAt: options.startedAt,
          events,
        }),
      });
      if (!response.ok) throw new Error(`Replay upload failed (${response.status}).`);
    },
    async complete(keepalive = false) {
      await fetch(completeUrl, {
        method: "POST",
        headers,
        credentials: endpoint.origin === window.location.origin ? "same-origin" : "omit",
        keepalive,
      });
    },
  };
}

export function createReplayHeaders(sessionId, headers = {}) {
  const next = new Headers(headers);
  if (sessionId) next.set("x-session-id", sessionId);
  return next;
}

export function startSessionReplay(rawOptions) {
  const options = {
    ...rawOptions,
    endpoint: assertOption(rawOptions?.endpoint, "endpoint"),
    project: assertOption(rawOptions?.project, "project"),
    service: assertOption(rawOptions?.service, "service"),
    environment: assertOption(rawOptions?.environment, "environment"),
    startedAt: new Date().toISOString(),
  };
  const sessionId = options.sessionId || crypto.randomUUID();
  const samplingRate = clampSamplingRate(options.samplingRate);
  const allowed = options.enabled === true && options.consent === true;
  const sampled = allowed && isSampled(sessionId, samplingRate);

  if (!sampled) {
    return {
      sessionId,
      recording: false,
      flush: async () => {},
      stop: async () => {},
    };
  }

  const uploader = options.sendBatch
    ? {
        batch: (events, keepalive) =>
          options.sendBatch({ sessionId, ...options, events, keepalive }),
        complete: (keepalive) => options.complete?.({ sessionId, keepalive }),
      }
    : createUploader(options, sessionId);
  const batchSize = Math.max(10, Number(options.batchSize || DEFAULT_BATCH_SIZE));
  const flushIntervalMs = Math.max(
    1_000,
    Number(options.flushIntervalMs || DEFAULT_FLUSH_INTERVAL_MS),
  );
  const inactivityMs = Math.max(
    10_000,
    Number(options.inactivityMs || DEFAULT_INACTIVITY_MS),
  );
  let buffer = [];
  let stopped = false;
  let stopRecorder;
  let uploadChain = Promise.resolve();
  let inactivityTimer;

  const flush = (keepalive = false) => {
    if (buffer.length === 0) return uploadChain;
    const events = buffer;
    buffer = [];
    uploadChain = uploadChain
      .then(() => uploader.batch(events, keepalive))
      .catch((error) => {
        options.onError?.(error);
      });
    return uploadChain;
  };

  const beginRecording = () => {
    if (stopped || stopRecorder) return;
    stopRecorder = record({
      emit(event) {
        buffer.push(event);
        if (buffer.length >= batchSize) void flush();
      },
      blockSelector: options.blockSelector || "[data-replay-block], .replay-block",
      ignoreSelector: options.ignoreSelector || "[data-replay-ignore], .replay-ignore",
      maskAllInputs: options.maskAllInputs ?? true,
      maskTextSelector: options.maskTextSelector || "*",
      recordCanvas: options.recordCanvas ?? false,
      collectFonts: options.collectFonts ?? false,
      inlineImages: options.inlineImages ?? false,
      inlineStylesheet: options.inlineStylesheet ?? true,
      checkoutEveryNms: 60_000,
    });
  };

  const pauseForInactivity = () => {
    stopRecorder?.();
    stopRecorder = undefined;
    void flush();
  };

  const markActivity = () => {
    if (!stopRecorder) beginRecording();
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(pauseForInactivity, inactivityMs);
  };

  const activityEvents = ["pointerdown", "keydown", "scroll", "resize"];
  for (const eventName of activityEvents) {
    window.addEventListener(eventName, markActivity, { passive: true, capture: true });
  }

  const interval = setInterval(() => void flush(), flushIntervalMs);
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") void flush(true);
    else markActivity();
  };
  const onPageHide = () => void flush(true);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onPageHide);

  beginRecording();
  markActivity();
  window.__OBSERVABILITY_SESSION_ID__ = sessionId;
  window.dispatchEvent(new CustomEvent("observability:session", { detail: { sessionId } }));
  options.onSession?.(sessionId);

  return {
    sessionId,
    recording: true,
    flush,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      clearTimeout(inactivityTimer);
      stopRecorder?.();
      for (const eventName of activityEvents) {
        window.removeEventListener(eventName, markActivity, { capture: true });
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      await flush(true);
      await uploader.complete(true);
    },
  };
}
