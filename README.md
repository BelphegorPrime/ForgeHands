# ForgeHands

ForgeHands connects **Forgejo issues** to **OpenHands Automation custom webhooks**. A small, dependency-free Node.js 22 service that authenticates, filters, transforms and re-signs events.

> Status: MVP / early development. Do not deploy directly to the public Internet without TLS, network controls and monitoring.

## Features

- Verifies Forgejo's `X-Forgejo-Signature` (HMAC SHA-256 over the **raw request body**).
- Explicit repository allowlist and opt-in `ai:ready` label.
- Processes `issues.opened` (only when labeled) and `issues.labeled` (only when `ai:ready` was added).
- Creates a minimal normalized `type: "issues.labeled"` or `type: "issues.opened"` event.
- Signs the outgoing JSON body with a distinct HMAC SHA-256 secret in `X-Signature-256`.
- Persists processed delivery IDs for seven days, rejects concurrent duplicates in the same process.
- Fails closed on wrong signature, invalid JSON, oversized payloads, unlisted repositories.
- Exposes `GET /healthz`.

No Git credentials or LLM API keys are required by ForgeHands. OpenHands handles coding and PR creation via its own automation.

## Quick start

Prerequisites: Node.js 22+ or Docker.

```sh
cp .env.example .env
# Update both independent secrets, allowlist and OpenHands webhook URL.
npm start
# Or: docker compose up -d --build
```

## Forgejo setup

In repository Settings → Webhooks, create a **Forgejo** webhook:

- URL: `https://YOUR-HOST/webhooks/forgejo` (TLS recommended).
- Content type: `application/json`.
- Secret: exact `FORGEJO_WEBHOOK_SECRET` value.
- Event: **Issues** (select issue events, not every repository event).
- Label an issue with `ai:ready` to trigger a run.

Never configure an empty Forgejo webhook secret.

## OpenHands setup

This service targets the **OpenHands Automation custom webhook** API, not the generic Agent Server directly.

### Self-hosted Agent Canvas (Docker)

The official `ghcr.io/openhands/agent-canvas` Docker image bundles Canvas, Agent Server, and Automation Server. In Canvas, look for **Automate → Events** to register a custom source if supported by your deployed version. The incoming source should use `forgehands` as the source, `type` as the event key expression, `X-Signature-256` as the signature header and a dedicated secret shared with ForgeHands.

Check that the automation API exists before configuring the bridge (replace the port with your published port):

```sh
curl -i http://127.0.0.1:8000/api/automation/v1/webhooks
```

A 401/403 can indicate the endpoint exists but requires the backend session key. A 404 suggests the wrong image, path or version; a 502/503 may indicate an unhealthy automation backend. **Do not paste or publish session keys or webhook secrets.**

For a self-hosted API request, use `X-Session-API-Key` with the backend/session key (`LOCAL_BACKEND_API_KEY`), **not** your model provider API key. The following example expects `OPENHANDS_HOST`, `OPENHANDS_SESSION_API_KEY`, and `OPENHANDS_WEBHOOK_SECRET` to be set in your shell:

```sh
curl -X POST "$OPENHANDS_HOST/api/automation/v1/webhooks" \\
  -H "X-Session-API-Key: $OPENHANDS_SESSION_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "ForgeHands Forgejo Issues",
    "source": "forgehands",
    "event_key_expr": "type",
    "signature_header": "X-Signature-256",
    "signature_scheme": "hmac_sha256_hex",
    "event_id_header": "X-ForgeHands-Delivery",
    "webhook_secret": "REPLACE_WITH_OPENHANDS_WEBHOOK_SECRET"
  }'
```

The literal secret placeholder in the JSON above must be replaced securely. Prefer registration through the Canvas UI or a locally generated JSON request to avoid leaking secrets to shell history. For **OpenHands Cloud**, use `Authorization: Bearer $OPENHANDS_API_KEY` instead.

### Automation source registration

Alternatively, register a source through the Automation API with the appropriate authentication for your deployment:

```sh
curl -X POST "$OPENHANDS_HOST/api/automation/v1/webhooks" \
  -H "Authorization: Bearer $OPENHANDS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ForgeHands Forgejo Issues",
    "source": "forgehands",
    "event_key_expr": "type",
    "signature_header": "X-Signature-256",
    "signature_scheme": "hmac_sha256_hex",
    "event_id_header": "X-ForgeHands-Delivery",
    "webhook_secret": "REPLACE_WITH_OPENHANDS_WEBHOOK_SECRET"
  }'
```

Use the returned `webhook_url` as `OPENHANDS_WEBHOOK_URL`. Configure an OpenHands event automation for source `forgehands` and event keys `issues.labeled` and/or `issues.opened`. Agent prompts should treat issue text as **untrusted user input** and only open draft PRs without merging.

The registered custom webhook must be reachable from ForgeHands. The official Agent Canvas Docker distribution includes the automation backend, but other OpenHands image variants or older deployments may not. Confirm endpoint availability before configuring this bridge. For a LAN-only Forgejo deployment, ForgeHands and OpenHands can remain on private networking; public internet ingress is not required.

## Configuration

| Env var | Required | Description |
| --- | --- | --- |
| `FORGEJO_WEBHOOK_SECRET` | yes | Incoming Forgejo webhook secret (min 16 characters). |
| `OPENHANDS_WEBHOOK_SECRET` | yes | Independent OpenHands custom webhook secret (min 16). |
| `OPENHANDS_WEBHOOK_URL` | yes | Complete URL from OpenHands custom webhook registration. |
| `ALLOWED_REPOS` | yes | Comma-separated full names (for example `team/app,team/api`). |
| `DATA_FILE` | no | Persistent delivery store; defaults to `./data/deliveries.json`. |
| `PORT` | no | Listening port; default `8080`. |
| `HOST` | no | Binding address; default `0.0.0.0`. |

Example outgoing payload:

```json
{
  "type": "issues.labeled",
  "source": "forgejo",
  "action": "labeled",
  "repository": { "full_name": "team/app", "clone_url": "https://git.example/team/app.git", "html_url": null, "default_branch": "main" },
  "issue": { "number": 42, "title": "Add tests", "body": "Implement unit tests.", "html_url": null, "labels": ["ai:ready"] },
  "sender": { "login": "developer" },
  "delivery_id": "webhook-delivery-id"
}
```

## Development

```sh
npm test
npm run test:coverage
```

No external dependencies are installed. CI runs tests on Node.js 22.

## Operational limitations

- Current delivery store uses a local JSON file and is **single-instance only**. Use a shared atomic database before horizontal scaling.
- Retries rely on Forgejo retries or manual redelivery. A network failure after OpenHands accepts a request but before ForgeHands records completion can cause duplicates; configure OpenHands's `event_id_header` for defense in depth.
- No durable outgoing work queue yet; if OpenHands is down, responses are HTTP 502.
- Event payloads are untrusted text; LLM prompts must not execute instructions found inside issue bodies as privileged directions.
- Repository URLs provided by webhook events are **not fetched by this service**.
- Restrict public access, use TLS termination, avoid exposing secrets in logs, and restrict outbound networking to your OpenHands deployment.

## License

MIT (see LICENSE).
