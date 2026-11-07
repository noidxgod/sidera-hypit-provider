# sidera-hypit-provider

Sidera as a model service for [Hypit](https://github.com/hypit-ai/hypit): Seedance 2 / 2.5, GPT Image 2 and
Nano Banana generated through your [Sidera](https://sidera-ai.ru) balance — rubles, Russian cards and SBP,
no subscription, charged only for successful results.

**По-русски:** [sidera-ai.ru/docs/hypit](https://sidera-ai.ru/docs/hypit)

## Models

| Hypit capability | Sidera |
| --- | --- |
| `@hypit/seedance@1#seedance-2`, `#seedance-2-fast`, `#seedance-2-mini` | Seedance 2.0 / Fast / Mini: text, first/last frame, image/video/audio references |
| `@hypit/seedance@1#seedance-2.5` | Seedance 2.5, including video editing (`duration: -1`) |
| `@hypit/gpt-image@1#gpt-image-2` | GPT Image 2, text or up to 16 input images |
| `@hypit/nano-banana@1#nano-banana-2`, `#nano-banana-pro` | Nano Banana 2 (up to 10 input images), Nano Banana Pro (up to 8) |

## Setup

1. Sign in at [sidera-ai.ru](https://sidera-ai.ru), open Профиль → «API и MCP» and create a key (a daily limit
   is recommended for agents). Top up the balance.
2. In the Hypit video project: `npm install sidera-hypit-provider`
3. Merge `endpoints` and `bindings` from this package's `hypit.runtime.json` into the project's Runtime
   Profile (bind only the models you want served by Sidera).
4. `hypit auth login sidera` — enter the key into the credential store. Never paste the key into the chat.

## How it works

- `start` uploads reference media to Sidera (`POST /api/v1/uploads`) and submits the generation
  (`POST /api/v1/generations`) with an idempotency key, so a retried submission never pays twice.
- `poll` reads `GET /api/v1/generations/{id}`; `collect` downloads the signed result links (the key is never
  sent to them).
- `supports` refuses what Sidera cannot render before any upload or charge (e.g. more than 10 images for
  Nano Banana 2, or `duration: -1` without a reference video).
- `readPricing` returns the exact ruble price of the request from `POST /api/v1/estimate` (free).
- A failed generation is refunded to the Sidera balance automatically.

`personReference` is accepted and not transmitted: Sidera does not require it.

## Development

`src/sidera.js` holds the mapping and the REST client without Hypit imports; `npm test` checks it.
`src/provider.js` is the Endpoint (Hypit Endpoint SDK), `src/activation.js` the Runtime activation.

Hypit is a project of Hypit.AI and is not affiliated with Sidera. This package is an independent provider.
