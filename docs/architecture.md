# Architecture

bbx-server-os runs a **combined** Trigger.dev v4 deployment (webapp + worker
on one host) on a single AWS EC2 instance:

- **Instance:** `i-0ca603e4ef9deb7f9` (t2.large, 2 vCPU, 8 GB RAM)
- **Public IP:** `100.31.146.20`
- **OS:** Ubuntu 26.04 (hvm-ssd-gp3)

This is the "run everything on one machine for testing" setup Trigger.dev's
docs describe — appropriate for a single-tenant internal tool like BBX Chat
GSFC, not for high-concurrency multi-tenant SaaS. See
[Scaling beyond this host](#scaling-beyond-this-host) below for the upgrade
path.

## Why combined, not split webapp/worker?

Trigger.dev's official minimums are **3 vCPU / 6 GB for the webapp alone**
and **4 vCPU / 8 GB for a worker alone** — i.e. ~7 vCPU / 14 GB combined if
run on separate boxes. A single t2.large (2 vCPU / 8 GB) is below the
*recommended* minimum for either role individually. We accept this
trade-off deliberately for a low-traffic internal tool, and compensate with:

- Aggressive per-service memory caps (`mem_limit`) so no single container
  can starve the others under load.
- `ENFORCE_MACHINE_PRESETS=1` on the supervisor, so task containers are
  capped at their machine preset's CPU/RAM regardless of what the task code
  tries to consume.
- Small default machine presets (`small-1x`, `small-2x`) on all example jobs.
- CPU is *not* hard-limited (Docker CPU shares, not quotas) so short bursts
  can borrow idle cycles from other services — memory is the tighter
  constraint on an 8 GB box, so that's what's hard-capped.

## 8 GB RAM budget

| Service | mem_limit | mem_reservation | Purpose |
|---|---|---|---|
| webapp | 1536 MB | 1024 MB | Dashboard, API, run orchestration (Remix/Node) |
| postgres | 768 MB | 512 MB | Users, orgs, projects, runs, tasks, deployments metadata |
| clickhouse | 1536 MB | 768 MB | Run/task event timeseries, logs, dashboard analytics queries |
| redis | 320 MB | 192 MB | Queues, rate limiting, v1 realtime streams |
| minio | 320 MB | 192 MB | Local S3-compatible object store for task I/O packets |
| registry | 192 MB | 96 MB | Docker registry for deployed task images |
| docker-proxy | 96 MB | 32 MB | Scoped Docker socket access for the supervisor |
| supervisor | 512 MB | 256 MB | Pulls/runs task containers, enforces machine presets |
| **Subtotal (services)** | **5280 MB** | **3072 MB** | |
| OS + Docker daemon overhead | ~1200 MB | | Ubuntu, dockerd, containerd, sshd, etc. |
| **Headroom for task containers** | **~1.5 GB** | | Actual task runs (see below) |
| **Total** | **8192 MB** | | |

Notes:
- `mem_limit` is a hard cap Docker/cgroups will OOM-kill against; the sum of
  all `mem_limit`s (5.28 GB) intentionally leaves ~2.9 GB free so that (a)
  the host OS/Docker daemon has room and (b) task containers spawned by the
  supervisor have somewhere to run.
- `mem_reservation` (3.07 GB total) is a *soft* minimum the Linux kernel
  tries to honor under memory pressure — it is not a hard cap, so containers
  can burst above it as long as the host has free memory.
- **ClickHouse and the webapp are the two biggest consumers.** If you see
  OOM kills, check those two first (`docker compose logs clickhouse webapp`,
  `docker stats`).
- Every value is overridable via `.env` (see `.env.example`) without
  editing `docker-compose.yml` — resize a single service if you outgrow a
  default.

### Task container headroom

Only 1-2 task containers can run concurrently at a time on the remaining
~1.5 GB, using the example jobs' machine presets:

| Preset | vCPU | RAM | Concurrent capacity on this host |
|---|---|---|---|
| `small-1x` | 0.5 | 0.5 GB | ~3 concurrent |
| `small-2x` | 1.0 | 1.0 GB | ~1-2 concurrent |
| `medium-1x` | 1.0 | 2.0 GB | ~1 concurrent (tight) |

This is fine for a low-volume internal bot/meeting-transcription workload
(a handful of meetings processed per day, sequentially or with light

## Folder structure

```
bbx-server-os/
├── .env.example              # All environment variables, documented
├── README.md                 # Entry point: decision, quickstart, links
├── docker/
│   ├── docker-compose.yml    # The full stack (webapp + worker, combined)
│   ├── generate-secrets.sh   # Generates all required secrets into .env
│   ├── clickhouse/
│   │   └── override.xml      # Memory-tuning override for ClickHouse
│   └── registry/
│       └── auth.htpasswd     # htpasswd file for the bundled registry (generated)
├── jobs/                      # Trigger.dev task definitions (deployed as tasks)
│   ├── package.json
│   ├── trigger.config.ts
│   └── src/tasks/
│       ├── transcribe-meeting.ts
│       ├── translate-transcript.ts
│       └── summarize-with-bedrock.ts
└── docs/
    ├── architecture.md        # This file
    ├── aws-setup.md            # IAM policy, S3 layout, Bedrock/Transcribe/Translate setup
    └── deployment.md           # Step-by-step local → EC2 deployment + checklist
```

## Networking

Three internal Docker networks isolate concerns (matching upstream
Trigger.dev's v4 design):

- `webapp` — webapp, postgres, redis, clickhouse, registry, minio, and the
  supervisor (needs to reach the webapp's API + workload endpoints).
- `supervisor` — webapp ↔ supervisor control channel only.
- `docker-proxy` — supervisor ↔ docker-proxy only; the proxy is the *only*
  thing with (read-only, scoped) access to the host's Docker socket.

Only the webapp's dashboard/API port (`8030`) is published on
`0.0.0.0` (all interfaces) by default. Postgres, Redis, ClickHouse, the
registry, and MinIO are published to `127.0.0.1` only — reachable from the
EC2 host itself (e.g. via SSH tunnel for debugging) but not from the public
internet. Lock down inbound security group rules to `8030/tcp` (and `22/tcp`
for SSH) — see `docs/deployment.md`.

## Scaling beyond this host

When workloads outgrow this box:

1. **Vertical first** — resize the EC2 instance (e.g. `t2.large` →
   `t3.xlarge`, 4 vCPU/16 GB) and raise the `mem_limit`/`cpus` values in
   `.env`. No architecture change needed.
2. **Split webapp and worker** — move `postgres`, `redis`, `clickhouse`,
   `registry`, `minio`, `webapp` to one host and `supervisor` +
   `docker-proxy` to one or more separate worker hosts. Trigger.dev
   supports this natively (`TRIGGER_API_URL`, `TRIGGER_WORKER_TOKEN`) — see
   the "Split" setup in the [official docs](https://trigger.dev/docs/self-hosting/docker).
3. **Horizontal workers** — once split, add more worker hosts pointing at
   the same webapp to increase concurrent task capacity.
4. **Managed datastores** — swap the bundled Postgres/ClickHouse for AWS RDS
   / a managed ClickHouse service for durability and easier backups.

