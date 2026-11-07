// Sidera for Hypit — the service side, with no Hypit imports (tested on its own).
// Maps Hypit's exact models to Sidera models and fields, checks what Sidera accepts before any
// upload or charge, and talks to the Sidera REST API (https://sidera-ai.ru/docs/api).

export const DEFAULT_BASE_URL = "https://sidera-ai.ru/api/v1";

// Hypit capability → Sidera model(s). Image models have a text variant and a variant with input
// images; Sidera picks by whether reference images are present.
export const MODELS = {
  "@hypit/seedance@1#seedance-2":      { kind: "video", sidera: "bytedance/seedance-2" },
  "@hypit/seedance@1#seedance-2-fast": { kind: "video", sidera: "bytedance/seedance-2-fast" },
  "@hypit/seedance@1#seedance-2-mini": { kind: "video", sidera: "bytedance/seedance-2-mini" },
  "@hypit/seedance@1#seedance-2.5":    { kind: "video", sidera: "bytedance/seedance-2-5", maxRefs: { image: 30, video: 10, audio: 10 } },
  "@hypit/gpt-image@1#gpt-image-2":    { kind: "image", text: "gpt-image-2-text-to-image", withImages: "gpt-image-2-image-to-image", imagesField: "input_urls", maxImages: 16 },
  "@hypit/nano-banana@1#nano-banana-2":   { kind: "image", text: "nano-banana-2", withImages: "nano-banana-2", imagesField: "image_input", maxImages: 10 },
  "@hypit/nano-banana@1#nano-banana-pro": { kind: "image", text: "nano-banana-pro", withImages: "nano-banana-pro", imagesField: "image_input", maxImages: 8 },
};
export const capabilityKey = c => `${c.module.name}@${c.module.version}#${c.name}`;
const first = (ports, name) => ports[name]?.[0];
const media = (ports, name) => (ports[name] || []).filter(v => v && typeof v === "object" && v.artifact);

// What Sidera cannot do for an otherwise valid Hypit request — refused before uploads or charges.
export function support(key, ports) {
  const m = MODELS[key];
  if (!m) return { status: "unsupported", reason: `Sidera does not serve ${key}` };
  if (m.kind === "image") {
    const images = media(ports, "images").length;
    if (images > m.maxImages) return { status: "unsupported", reason: `Sidera accepts at most ${m.maxImages} input images for this model, not ${images}` };
    return { status: "supported" };
  }
  // Seedance: duration -1 (2.5) means «as long as the source video» — Sidera's video editing, which
  // is a reference video without reference images.
  if (first(ports, "duration") === -1 && !(media(ports, "referenceVideo").length && !media(ports, "referenceImage").length))
    return { status: "unsupported", reason: "Sidera renders duration -1 only for video editing: a reference video without reference images" };
  return { status: "supported" };
}

// Builds the Sidera request. `upload(value, model, field)` turns a Hypit media value into a Sidera
// reference (it uploads the bytes); it is called only after support() passed.
export async function toSidera(key, ports, upload) {
  const m = MODELS[key];
  const prompt = String(first(ports, "prompt") ?? "");
  if (m.kind === "image") {
    const images = media(ports, "images"), model = images.length ? m.withImages : m.text, values = { prompt };
    if (first(ports, "aspectRatio") !== undefined) values.aspect_ratio = String(first(ports, "aspectRatio"));
    if (first(ports, "resolution") !== undefined) values.resolution = String(first(ports, "resolution"));
    if (first(ports, "background") !== undefined) values.background = String(first(ports, "background"));
    if (first(ports, "outputFormat") !== undefined) values.output_format = String(first(ports, "outputFormat"));
    if (images.length) values[m.imagesField] = await Promise.all(images.map(v => upload(v, model, m.imagesField)));
    return { model, values };
  }
  const model = m.sidera, values = { prompt };
  const scalar = { resolution: "resolution", aspectRatio: "aspect_ratio", generateAudio: "generate_audio", webSearch: "web_search" };
  for (const [port, field] of Object.entries(scalar)) if (first(ports, port) !== undefined) values[field] = first(ports, port);
  const duration = first(ports, "duration");
  // -1 is decided by Sidera from the source video (editing); any valid number is accepted there.
  if (duration !== undefined) values.duration = duration === -1 ? 5 : Number(duration);
  const lists = { referenceImage: "reference_image_urls", referenceVideo: "reference_video_urls", referenceAudio: "reference_audio_urls" };
  for (const [port, field] of Object.entries(lists)) { const items = media(ports, port); if (items.length) values[field] = await Promise.all(items.map(v => upload(v, model, field))); }
  for (const [port, field] of [["firstFrame", "first_frame_url"], ["lastFrame", "last_frame_url"]]) { const [v] = media(ports, port); if (v) values[field] = await upload(v, model, field); }
  return { model, values };
}

// Sidera REST client. Errors keep Sidera's public message and HTTP status; secrets never appear.
export function client({ baseUrl = DEFAULT_BASE_URL, fetch: fetcher = globalThis.fetch } = {}) {
  const base = new URL(baseUrl).href.replace(/\/$/u, "");
  if (!base.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/u.test(base)) throw new Error("Sidera baseUrl requires HTTPS");
  async function call(key, path, init = {}) {
    const response = await fetcher(base + path, { ...init, headers: { ...init.headers, authorization: `Bearer ${key}` }, signal: init.signal ?? AbortSignal.timeout(120_000) });
    let body = null; try { body = await response.json(); } catch { /* no JSON body */ }
    if (!response.ok) {
      const message = typeof body?.error?.message === "string" ? body.error.message : `HTTP ${response.status}`;
      throw Object.assign(new Error(`Sidera ${init.method ?? "GET"} ${path.split("?")[0]}: ${message}`), { status: response.status, code: `SIDERA_${response.status}` });
    }
    return body;
  }
  return {
    base,
    upload: (key, model, field, bytes, mediaType) => call(key, `/uploads?model=${encodeURIComponent(model)}&field=${encodeURIComponent(field)}`, { method: "POST", headers: { "content-type": mediaType }, body: new Blob([bytes], { type: mediaType }), signal: AbortSignal.timeout(600_000) }),
    estimate: (key, request) => call(key, "/estimate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) }),
    // Idempotency-Key makes a retried submission return the same generation instead of paying twice.
    generate: (key, request, idempotencyKey) => call(key, "/generations", { method: "POST", headers: { "content-type": "application/json", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) }, body: JSON.stringify(request) }),
    status: (key, id) => call(key, `/generations/${encodeURIComponent(id)}`),
    models: key => call(key, "/models"),
  };
}

// Sidera generation status → Hypit lifecycle.
export function lifecycle(g) {
  if (g.status === "succeeded") {
    if (!Array.isArray(g.media) || !g.media.length) throw new Error(`Sidera generation ${g.id} succeeded without a result`);
    return { state: "ready", urls: g.media };
  }
  if (g.status === "failed") return { state: "failed", code: "SIDERA_GENERATION_FAILED", message: `Sidera generation ${g.id} failed; the reserved rubles were returned to the balance` };
  return { state: "pending", phase: g.status };
}
