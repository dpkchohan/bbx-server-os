# bbx-server-os

Self-hosted AI orchestration server for BBX Chat GSFC — meeting bots,
transcription, and AI workflows.

Runs on a single AWS EC2 instance (`i-0ca603e4ef9deb7f9`, t2.large, 8 GB RAM,
public IP `100.31.146.20`) using a Docker Compose deployment of
**Trigger.dev v4**, adapted from the
[official self-hosting compose files](https://github.com/triggerdotdev/trigger.dev/tree/main/hosting/docker),
plus three example jobs that call Amazon Transcribe, Amazon Translate, and
Amazon Bedrock.

## Quick start

```bash
git clone <this-repo-url> bbx-server-os
cd bbx-server-os
cp .env.example .env
cd docker && ./generate-secrets.sh
docker compose up -d
# → open http://100.31.146.20:8030
```

Full step-by-step instructions, prerequisites, and a deployment checklist
are in **[docs/deployment.md](docs/deployment.md)**.

## What's in this repo

| Path | Purpose |
|---|---|
| `docker/docker-compose.yml` | The full Trigger.dev v4 stack (webapp + worker, combined on one host), with per-service memory/CPU limits tuned for 8 GB RAM |
| `docker/generate-secrets.sh` | Generates all required secrets and the registry's htpasswd file |
| `docker/clickhouse/override.xml` | ClickHouse memory-tuning override |
| `.env.example` | Every environment variable the stack and jobs use, documented |
| `jobs/` | Trigger.dev task definitions: transcription, translation, Bedrock summarization |
| `docs/architecture.md` | 8 GB RAM budget breakdown, folder structure, networking, scaling path |
| `docs/aws-setup.md` | IAM policy, S3 bucket layout, Bedrock/Transcribe/Translate setup, cost estimate |
| `docs/deployment.md` | Step-by-step setup guide, deployment checklist, testing approach, milestones |

## Research: Trigger.dev vs Inngest self-hosting

Both platforms support self-hosting; we evaluated both against our use case
(single internal EC2 host, 8 GB RAM, AWS-integrated meeting-bot jobs).

| | **Trigger.dev v4** | **Inngest** |
|---|---|---|
| Self-hosting maturity | Purpose-built v4 rewrite for self-hosting (simplified from v3); official Docker Compose + Kubernetes/Helm guides | Supported since 1.0; single static Go binary + official Docker image, Helm chart also available |
| License | **Apache 2.0** (fully permissive, no restrictions) | **Server Side Public License (SSPL) v1**, with a Grant of Future License converting to Apache 2.0 three years after each release |
| Minimum resources | 3 vCPU/6 GB (webapp) + 4 vCPU/8 GB (worker) recommended for split setup; combinable onto one smaller host for dev/low-traffic use | No official minimums published; single binary + in-memory Redis + SQLite can run in well under 1 GB for light use |
| Persistence out of the box | Requires Postgres + Redis + ClickHouse (all bundled in the compose file) | Defaults to embedded SQLite + in-memory Redis (zero external deps); supports swapping in external Postgres/Redis via `--postgres-uri` / `--redis-uri` |
| Task execution model | Supervisor spawns **isolated Docker containers per task run**, with enforced per-task CPU/RAM limits (`ENFORCE_MACHINE_PRESETS`) | Functions run **in-process** inside the app server that calls `serve()` (like a webhook receiver) — no built-in container-per-run isolation |
| Built-in extras | Container registry + S3-compatible object storage (MinIO) bundled, so `deploy` needs no third-party services | Prometheus metrics endpoint, KEDA-based autoscaling via the Helm chart |
| Dashboard/observability | Full run/task timeline UI backed by ClickHouse, logs, alerts, replay | Dashboard UI for apps/functions/run history backed by Postgres; no bundled ClickHouse-style analytics store |
| AWS SDK integration | Just Node.js/TypeScript task code — call any AWS SDK v3 client directly inside a task, same as any Node process | Same — functions are plain Node/Python/Go code, call AWS SDK directly |

### Decision: **Trigger.dev v4**

Reasoning, specific to bbx-server-os:

1. **Task isolation matters for our workload.** Meeting transcription and
   Bedrock summarization jobs can run long (tens of minutes) and pull in
   variable-sized audio/video. Trigger.dev's per-task Docker container
   model with `ENFORCE_MACHINE_PRESETS=1` gives hard CPU/RAM ceilings per
   run — critical protection on a shared 8 GB box where one runaway job
   should not take down the dashboard or other jobs. Inngest's in-process
   execution model has no equivalent built-in isolation; a memory-hungry
   function would compete directly with the Inngest server's own process.
2. **License is unambiguous.** Apache 2.0 imposes no restrictions on how we
   run or modify Trigger.dev. Inngest's server/CLI ships under the SSPL —
   not OSI-approved, though the Grant of Future License means each release
   becomes Apache 2.0 after 3 years. For a project we intend to run
   indefinitely and potentially modify, Apache 2.0 today is simpler to
   reason about than "SSPL now, Apache in 2029."
3. **Purpose-built container registry + object storage removes a
   dependency.** Deploying and running task code needs an image registry;
   Trigger.dev bundles one (plus MinIO for I/O packets) so we don't need to
   stand up ECR or another registry service just to self-host. Inngest has
   no equivalent — it doesn't build/push task images at all since functions
   run in-process in your own app.
4. **Dashboard/observability depth.** ClickHouse-backed run timelines, logs,
   and replay are valuable for debugging meeting-bot failures after the
   fact, and come bundled. Inngest's dashboard is comparable for events/runs
   but lacks the same level of built-in analytics storage.

Trade-off we accept: Trigger.dev's stack (8 services vs. Inngest's 1-3) is
heavier and uses more of our 8 GB budget at idle — see
[docs/architecture.md](docs/architecture.md) for exactly how that budget is
spent and why it still fits comfortably for our expected low-volume,
internal usage pattern.

## AWS integration at a glance

- **Amazon Transcribe** — converts meeting recordings in S3 to text
  (`jobs/src/tasks/transcribe-meeting.ts`).
- **Amazon Translate** — translates transcripts to a target language
  (`jobs/src/tasks/translate-transcript.ts`).
- **Amazon Bedrock** (Claude 3.5 Sonnet by default) — summarizes transcripts
  into key points + action items (`jobs/src/tasks/summarize-with-bedrock.ts`).
- Full IAM policy, S3 bucket layout, model-access setup, and cost estimate:
  **[docs/aws-setup.md](docs/aws-setup.md)**.

## Cost estimate

~$125-130/month for light internal usage (~20 meetings/month): EC2 compute
is the largest line item (~$68/month on-demand), followed by Transcribe and
Translate. Full breakdown in
[docs/aws-setup.md](docs/aws-setup.md#cost-estimate-light-internal-usage).

## Status

- [x] Research complete — Trigger.dev v4 selected over Inngest (see above)
- [x] Architecture designed — [docs/architecture.md](docs/architecture.md)
- [x] Stack built — `docker/docker-compose.yml`, `.env.example`, example jobs
- [x] AWS integration documented — [docs/aws-setup.md](docs/aws-setup.md)
- [ ] Validated end-to-end on the live EC2 instance — see the checklist in
      [docs/deployment.md](docs/deployment.md#deployment-checklist)


