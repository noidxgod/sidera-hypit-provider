import { test } from "node:test";
import assert from "node:assert/strict";
import { MODELS, support, toSidera, client, lifecycle, checkKey, idempotencyKey } from "../src/sidera.js";

const img = (n = 1) => Array.from({ length: n }, (_, i) => ({ role: "reference", artifact: { kind: "blob", resource: "r" + i, size: 1, mediaType: "image/png" } }));
const vid = () => [{ role: "reference", artifact: { kind: "blob", resource: "v", size: 1, mediaType: "video/mp4" } }];
const upload = async (v, model, field) => `upload:${field}:${v.artifact.resource}`;

test("every mapped Sidera model exists on the site side as a known id", () => {
  for (const m of Object.values(MODELS)) for (const id of [m.sidera, m.text, m.withImages].filter(Boolean)) assert.match(id, /^[a-z0-9./-]+$/);
});

test("GPT Image 2: the text variant without images, the image variant with them", async () => {
  const key = "@hypit/gpt-image@1#gpt-image-2";
  assert.deepEqual(await toSidera(key, { prompt: ["a cat"], aspectRatio: ["16:9"], resolution: ["2K"] }, upload), { model: "gpt-image-2-text-to-image", values: { prompt: "a cat", aspect_ratio: "16:9", resolution: "2K" } });
  const r = await toSidera(key, { prompt: ["edit"], aspectRatio: ["auto"], resolution: ["1K"], images: img(2) }, upload);
  assert.equal(r.model, "gpt-image-2-image-to-image"); assert.deepEqual(r.values.input_urls, ["upload:input_urls:r0", "upload:input_urls:r1"]);
});

test("Nano Banana 2: Sidera takes at most 10 images — more is refused before any upload", () => {
  assert.equal(support("@hypit/nano-banana@1#nano-banana-2", { prompt: ["x"], images: img(10) }).status, "supported");
  assert.match(support("@hypit/nano-banana@1#nano-banana-2", { prompt: ["x"], images: img(11) }).reason, /at most 10/);
});

test("Seedance: all fields and references map to Sidera; duration -1 only for video editing", async () => {
  const key = "@hypit/seedance@1#seedance-2.5";
  const r = await toSidera(key, { prompt: ["p"], resolution: ["720p"], aspectRatio: ["16:9"], duration: [8], generateAudio: [true], webSearch: [false], referenceImage: img(1), referenceAudio: [{ role: "reference", artifact: { resource: "a", mediaType: "audio/mpeg" } }] }, upload);
  assert.deepEqual(r, { model: "bytedance/seedance-2-5", values: { prompt: "p", resolution: "720p", aspect_ratio: "16:9", generate_audio: true, web_search: false, duration: 8, reference_image_urls: ["upload:reference_image_urls:r0"], reference_audio_urls: ["upload:reference_audio_urls:a"] } });
  const frames = await toSidera("@hypit/seedance@1#seedance-2-mini", { prompt: ["p"], resolution: ["480p"], aspectRatio: ["9:16"], duration: [5], generateAudio: [false], webSearch: [false], firstFrame: img(1), lastFrame: img(1) }, upload);
  assert.equal(frames.values.first_frame_url, "upload:first_frame_url:r0"); assert.equal(frames.values.last_frame_url, "upload:last_frame_url:r0");
  assert.match(support(key, { prompt: ["p"], duration: [-1], referenceImage: img(1) }).reason, /video editing/);
  assert.equal(support(key, { prompt: ["p"], duration: [-1], referenceVideo: vid() }).status, "supported");
});

test("REST client: bearer key, idempotency key, Sidera's error message kept", async () => {
  const calls = [];
  const api = client({ baseUrl: "https://sidera.test/api/v1", fetch: async (url, init) => { calls.push({ url, init }); return url.endsWith("/generations") ? Response.json({ id: "g1", status: "queued", price_rub: "7.50" }, { status: 202 }) : Response.json({ error: { message: "Недостаточно средств", status: 402 } }, { status: 402 }); } });
  assert.equal((await api.generate("sdr_x", { model: "m", values: {} }, "op-1")).id, "g1");
  assert.equal(calls[0].init.headers.authorization, "Bearer sdr_x"); assert.equal(calls[0].init.headers["idempotency-key"], "op-1");
  await assert.rejects(api.estimate("sdr_x", { model: "m", values: {} }), e => e.status === 402 && /Недостаточно средств/.test(e.message) && !/sdr_x/.test(e.message));
  assert.throws(() => client({ baseUrl: "http://evil.example/api" }), /HTTPS/);
});

test("lifecycle: pending, failed (refunded), ready with result links", () => {
  assert.deepEqual(lifecycle({ id: "g", status: "generating" }), { state: "pending", phase: "generating" });
  assert.equal(lifecycle({ id: "g", status: "failed" }).state, "failed");
  assert.deepEqual(lifecycle({ id: "g", status: "succeeded", media: ["https://sidera-ai.ru/m/1"] }), { state: "ready", urls: ["https://sidera-ai.ru/m/1"] });
  assert.throws(() => lifecycle({ id: "g", status: "succeeded", media: [] }), /without a result/);
});

test("checkKey accepts one Sidera key and explains repeated or foreign keys", () => {
  const key = "sdr_" + "a1".repeat(24);
  assert.equal(checkKey(` ${key}\n`), key);
  assert.throws(() => checkKey(key.repeat(4)), /contains 4 keys \(pasted 4 times\)/);
  assert.throws(() => checkKey("sk-other-123"), /not a Sidera key/);
  assert.throws(() => checkKey(undefined), /missing/);
});

test("idempotencyKey is stable, short and uses only characters Sidera accepts", async () => {
  const id = "op_" + "x/".repeat(200) + "#need:1@seedance";
  const a = await idempotencyKey(id), b = await idempotencyKey(id);
  assert.equal(a, b); assert.ok(a.length <= 100); assert.match(a, /^[A-Za-z0-9._:-]+$/);
  assert.notEqual(a, await idempotencyKey(id + "2"));
  assert.equal(await idempotencyKey(undefined), undefined);
});
