// Sidera for Hypit — the Endpoint: one configured instance serves every model in MODELS.
// Lifecycle per the Hypit Endpoint SDK: start (upload references, submit) → poll → collect.
import { canonicalize, defineEndpoint, wakeAfter } from "@hypit/hypit/endpoint";
import { generationTypes, sealGeneratedImageSet, sealGeneratedVideoSet } from "@hypit/generation";
import { MODELS, capabilityKey, client, lifecycle, support, toSidera } from "./sidera.js";

export const providerModule = { name: "@sidera-ai/hypit-provider", version: "1" };

const capabilityOf = key => { const [mod, name] = key.split("#"), at = mod.lastIndexOf("@"); return { module: { name: mod.slice(0, at), version: mod.slice(at + 1) }, name }; };
const ports = need => need.constraints?.ports ?? {};

export function createSideraProvider(options) {
  const api = client({ baseUrl: options.baseUrl, fetch: options.fetch });
  const interval = options.pollIntervalMs ?? 5_000;
  const secret = credentials => {
    const value = credentials.apiKey?.secret;
    if (typeof value !== "string" || !value) throw new Error("Sidera API key is missing: create one at https://sidera-ai.ru → Профиль → «API и MCP»");
    return value;
  };
  const endpointFor = (key, kind) => ({
    async start(context) {
      const checked = support(key, ports(context.need));
      if (checked.status === "unsupported") throw new Error(checked.reason);
      const apiKey = secret(context.credentials);
      await context.reportProgress?.({ phase: "Uploading references to Sidera" });
      const request = await toSidera(key, ports(context.need), async (value, model, field) => {
        const bytes = await context.resources.get(value.artifact.resource);
        if (bytes === undefined) throw new Error("Reference media is unavailable");
        return (await api.upload(apiKey, model, field, bytes, value.artifact.mediaType)).reference;
      });
      await context.reportProgress?.({ phase: `Submitting to Sidera: ${request.model}` });
      // The operation id makes a retried submission return the same Sidera generation (no double charge).
      const started = await api.generate(apiKey, request, context.operation?.id ?? context.need?.id);
      const handle = { id: started.id }, receipt = { id: started.id, priceRub: started.price_rub };
      await context.checkpoint?.({ handle, receipt });
      return { ...wakeAfter(handle, interval), receipt };
    },
    async poll(context) {
      const id = String(context.handle?.id ?? "");
      const state = lifecycle(await api.status(secret(context.credentials), id));
      if (state.state === "pending") return wakeAfter({ id }, interval, Date.now(), { phase: state.phase });
      if (state.state === "failed") return { status: "failed", receipt: { id }, failure: { code: state.code, message: state.message } };
      return { status: "ready", handle: { id, urls: state.urls } };
    },
    async collect(context) {
      // Result links are signed; the API key is never sent to them.
      await context.reportProgress?.({ phase: "Receiving the result from Sidera" });
      const artifacts = [];
      for (const url of context.handle.urls) {
        const response = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(600_000) });
        if (!response.ok) throw new Error(`Sidera result download returned HTTP ${response.status}`);
        const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim() || (kind === "video" ? "video/mp4" : "image/png");
        if (!mediaType.startsWith(kind + "/")) throw new Error(`Sidera returned ${mediaType} for a ${kind} request`);
        artifacts.push(await context.resources.put(new Uint8Array(await response.arrayBuffer()), mediaType));
      }
      const value = kind === "video" ? sealGeneratedVideoSet({ videos: artifacts }) : sealGeneratedImageSet({ images: artifacts });
      return { status: "completed", result: { value: { kind: "inline", value: canonicalize(value) } } };
    },
  });
  return defineEndpoint({
    instance: options.instance, pool: options.pool,
    credentials: { apiKey: options.apiKey }, credentialInputs: { apiKey: { label: "Sidera API key (Профиль → «API и MCP»)" } },
    defaultConcurrency: options.concurrency ?? 2,
    actionLimits: { submit: { concurrency: 2, rate: { limit: 2, periodMs: 1_000 } }, poll: { concurrency: 8 }, collect: { concurrency: 2 } },
    pricing: { kind: "page", url: "https://sidera-ai.ru/models" },
    // Exact rubles for this request from Sidera's /estimate (no charge). Media not yet produced is
    // unknown here, so the estimate covers the parameters only.
    async readPricing(context) {
      const key = capabilityKey(context.request.capability ?? {}) in MODELS ? capabilityKey(context.request.capability) : null;
      const source = "https://sidera-ai.ru/models";
      if (!key) return [{ source, data: canonicalize({}), summary: "Sidera prices in rubles: https://sidera-ai.ru/models" }];
      const request = await toSidera(key, ports(context.request), async () => "pending");
      try {
        const e = await api.estimate(secret(await context.credentials()), request);
        return [{ source: api.base + "/estimate", data: canonicalize({ model: request.model, ...e }), summary: `${request.model}: ${e.price_rub} ₽ per run${e.complete ? "" : " (parameters incomplete)"}, charged only for a successful result` }];
      } catch (error) {
        return [{ source, data: canonicalize({ model: request.model }), summary: `${request.model}: see ${source} (${error.message})` }];
      }
    },
    capabilities: Object.entries(MODELS).map(([key, m]) => ({
      capability: capabilityOf(key),
      returns: m.kind === "video" ? generationTypes.videoSet : generationTypes.imageSet,
      lifecycle: "asynchronous",
      supports: request => support(key, ports(request)),
      endpoint: endpointFor(key, m.kind),
    })),
  });
}
