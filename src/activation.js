// Sidera for Hypit — Runtime activation: reads the Endpoint config from the project's Runtime Profile.
import {
  createRuntimeEndpointAdapterFacet, runtimeConfigCredentialRef, runtimeConfigExact,
  runtimeConfigObject, runtimeConfigPositiveInteger, runtimeConfigString,
} from "@hypit/runtime-local/extension";
import { createSideraProvider, providerModule } from "./provider.js";
import { DEFAULT_BASE_URL } from "./sidera.js";

export default {
  format: "hypit.package@1",
  facets: [createRuntimeEndpointAdapterFacet({
    use: providerModule.name,
    activate(context) {
      const config = runtimeConfigObject(context.config, "Sidera");
      runtimeConfigExact(config, ["baseUrl", "apiKey", "concurrency", "pollIntervalMs"], "Sidera");
      const apiKey = runtimeConfigCredentialRef(config.apiKey, "Sidera apiKey");
      if (!apiKey || !context.pool) throw new Error("Sidera requires apiKey and pool");
      return { endpoint: createSideraProvider({
        instance: context.instance, pool: context.pool, apiKey,
        baseUrl: config.baseUrl === undefined ? DEFAULT_BASE_URL : runtimeConfigString(config.baseUrl, "Sidera baseUrl"),
        concurrency: runtimeConfigPositiveInteger(config.concurrency, "concurrency") ?? 2,
        pollIntervalMs: runtimeConfigPositiveInteger(config.pollIntervalMs, "pollIntervalMs") ?? 5_000,
      }) };
    },
  })],
};
