# Deployment guide

Step-by-step path from a fresh EC2 instance to a working Trigger.dev stack
running the example jobs against real AWS services.

## Prerequisites

- [ ] EC2 instance running (`i-0ca603e4ef9deb7f9`, Ubuntu 26.04, t2.large,
      100.31.146.20) — already provisioned.
- [ ] A domain name pointed at the instance (`server.pddt.in` → A record →
      `100.31.146.20`) — recommended over using the bare IP; see "HTTPS via
      Caddy" below for why.
- [ ] Security group allows inbound `22/tcp` (SSH, from your IP only),
      `80/tcp` and `443/tcp` (HTTP/HTTPS via Caddy, from `0.0.0.0/0` — both
      are required for Let's Encrypt's ACME challenge and normal traffic).
      `8030/tcp` no longer needs to be open publicly once Caddy is in front
      of it (see below) — it's only used internally, proxied by Caddy.
- [ ] SSH key pair (`bbx-server-os-key`) available locally.
- [ ] Docker Engine 20.10.0+ and Docker Compose 2.20.0+ installed on the
      instance (see below).
- [ ] An IAM role attached to the instance with the policy from
      `docs/aws-setup.md`, OR access keys ready to place in `.env`.
- [ ] An S3 bucket created (`docs/aws-setup.md` → S3 bucket structure).
- [ ] Bedrock model access enabled for the model(s) you'll use.
- [ ] Node.js 20+ and pnpm/npm locally if you plan to develop/deploy tasks
      from your own machine instead of directly on the EC2 host.

## 1. Install Docker on the EC2 instance

```bash
ssh -i bbx-server-os-key.pem ubuntu@100.31.146.20

curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker
docker --version          # confirm 20.10.0+
docker compose version    # confirm 2.20.0+
```

## 2. Clone the repo and generate secrets

```bash
git clone <this-repo-url> bbx-server-os
cd bbx-server-os
cp .env.example .env
cd docker
chmod +x generate-secrets.sh
./generate-secrets.sh     # fills in SESSION_SECRET, POSTGRES_PASSWORD, etc.
```

Review `.env` afterwards — set `APP_ORIGIN`/`LOGIN_ORIGIN`/`API_ORIGIN` to
your domain over `https://` (e.g. `https://server.pddt.in`, matching the
`.env.example` default) once Caddy is set up in step 2b below, and fill in
`AWS_REGION` / `BBX_S3_BUCKET` / `BBX_BEDROCK_MODEL_ID` for the AWS
integration.

## 2b. HTTPS via Caddy (strongly recommended)

**Why this matters, not just for appearances:** the webapp always runs with
`NODE_ENV=production`, and its session cookie is unconditionally set with
the `Secure` attribute in that mode (`sessionStorage.server.ts`). Browsers
silently refuse to send `Secure` cookies back over a plain `http://`
connection. Since the session cookie carries the magic-link/OAuth `state`
during login, **serving the dashboard over bare HTTP breaks both magic-link
and GitHub OAuth login** — the callback silently redirects back to `/login`
with no error logged anywhere. A domain + real TLS cert (even a free
Let's Encrypt one via Caddy) fixes this outright.

Install Caddy from its official apt repo:

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
```

Point it at the webapp using this repo's `docker/Caddyfile` (edit the
domain first if you're not using `server.pddt.in`):

```bash
sudo cp docker/Caddyfile /etc/caddy/Caddyfile
sudo systemctl restart caddy
sudo systemctl status caddy   # should show "active (running)"
```

Caddy automatically requests and renews a Let's Encrypt certificate for the
domain in the Caddyfile on first start — no manual certbot steps needed.
Watch it happen live:

```bash
sudo journalctl -u caddy -f
# look for: "certificate obtained successfully"
```

Then update `.env` to match your domain and recreate the webapp container
(a plain `restart` won't pick up new env vars — see the note in step 4):

```bash
# .env
APP_ORIGIN=https://server.pddt.in
LOGIN_ORIGIN=https://server.pddt.in
API_ORIGIN=https://server.pddt.in

docker compose down
docker compose up -d
```

Verify:

```bash
curl -I https://server.pddt.in
# Expect: HTTP/2 302, location: /login?redirectTo=%2F, via: 1.1 Caddy
```

A `302` to `/login` is success here (it's the app's own auth redirect for
an unauthenticated request to `/`) — a `502` means Caddy is up but can't
reach the webapp container (check `docker compose ps`); a TLS/connection
error means Caddy itself isn't running or ports 80/443 aren't reachable
from the internet (check the security group).

## 3. Start the stack

```bash
cd docker
docker compose up -d
docker compose ps            # all services should show "healthy" within ~2 min
docker compose logs -f webapp   # watch for "Trigger.dev is ready" or similar
```

First boot runs Postgres/ClickHouse migrations automatically — this can take
1-2 minutes. If `webapp` restarts a few times while Postgres/ClickHouse are
still starting, that's expected (Compose's `depends_on` handles ordering but
not full readiness); it will stabilize once dependencies are healthy.

> **Known issue — ClickHouse JSON column type.** The webapp's ClickHouse
> migrations (`task_runs_v1`, `task_events_v1`) use the `JSON` column type,

> which requires `allow_experimental_json_type` and, on ClickHouse 24.x,
> the `enable_json_type` table setting is entirely unsupported. This repo's
> `docker-compose.yml` pins `CLICKHOUSE_IMAGE_TAG=26.2` (via `.env.example`)
> and ships `docker/clickhouse/users.d/default.xml` enabling
> `allow_experimental_json_type` to avoid this out of the box. If `webapp`
> crash-loops with `DB::Exception: ... experimental JSON type is not
> allowed` or `Unknown setting 'enable_json_type'` in
> `docker compose logs webapp`, confirm `CLICKHOUSE_IMAGE_TAG=26.2` (or
> newer) is set in `.env` and that the `users.d/default.xml` volume mount is
> present on the `clickhouse` service, then `docker compose down && docker
> compose up -d`.
>
> **Important:** mount `users.d/default.xml` as a single file, not the
> whole `users.d` directory. ClickHouse's entrypoint writes its own
> `default-user.xml` into that directory on every boot (to apply
> `CLICKHOUSE_PASSWORD`) — mounting the entire directory `:ro` blocks that
> write and crash-loops the container with `Read-only file system`.



1. Open `https://server.pddt.in` in a browser (or `http://100.31.146.20:8030`
   if you skipped the Caddy step — see the cookie warning below).
2. Sign up with the magic-link flow. If email isn't configured yet (see
   below), retrieve the link from the logs instead:
   ```bash
   docker compose logs webapp | grep "Click here to log in"
   ```
   > **Cookie/HTTPS requirement.** The webapp's session cookie (which
   > carries the magic-link/OAuth `state`) is always set with the `Secure`
   > attribute in production mode. Browsers silently drop `Secure` cookies
   > over plain HTTP, which breaks the login callback with no visible
   > error — it just redirects back to `/login`. **Complete step 2b (HTTPS
   > via Caddy) before testing login**, and access the dashboard only via
   > `https://server.pddt.in`, not the bare IP/port. If you also see the
   > magic link logged with an `https://` scheme when testing without
   > Caddy, that's the same underlying issue from the other direction —
   > it resolves itself once you're actually serving over HTTPS.
3. **Configure a real email transport** so magic links actually arrive
   (without this, `EMAIL_TRANSPORT` is unset and links are console-log-only
   forever). Set in `.env`, then recreate the webapp container — a plain
   `restart` does **not** pick up new env vars, you need `up -d`:
   ```bash
   # .env
   EMAIL_TRANSPORT=aws-ses
   FROM_EMAIL=noreply@yourdomain.com
   REPLY_TO_EMAIL=you@yourdomain.com
   # AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are reused from
   # the "AWS integration" section above - no separate SES-specific vars.

   docker compose up -d webapp
   ```
   **AWS SES setup required before emails will actually send:**
   - Verify `FROM_EMAIL` (or its whole domain) as a **verified identity** in
     the [SES console](https://console.aws.amazon.com/ses/) → *Verified
     identities*.
   - If the AWS account is still in the **SES sandbox** (the default for
     new accounts/regions), SES will only deliver to *also-verified*
     recipient addresses — verify `REPLY_TO_EMAIL` and any login email
     addresses too, or [request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
     to send to arbitrary recipients.
   - The IAM identity in `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (or the
     EC2 instance role) needs `ses:SendEmail` and `ses:SendRawEmail`
     permissions — see `docs/aws-setup.md` for the IAM policy pattern.
   - Verify it worked: `docker compose logs webapp | grep -i ses` after
     attempting a login; SES rejections show up here (e.g.
     `MessageRejected: Email address is not verified`).
4. **Alternative: GitHub OAuth**, if you'd rather skip email entirely.
   Create an OAuth app at <https://github.com/settings/developers>:
   - Homepage URL: `https://server.pddt.in`
   - Authorization callback URL: `https://server.pddt.in/auth/github/callback`

   (Use your actual domain — this **requires** step 2b/HTTPS to be done
   first, for the same `Secure` cookie reason as magic links above.)

   Then set in `.env` and recreate the webapp container:
   ```bash
   AUTH_GITHUB_CLIENT_ID=<from GitHub>
   AUTH_GITHUB_CLIENT_SECRET=<from GitHub>

   docker compose up -d webapp
   ```
   A "Continue with GitHub" button appears on the login page once both
   values are set (verify with
   `curl -s https://server.pddt.in/login | grep -o 'Continue with GitHub'`).
   `WHITELISTED_EMAILS` (a regex, if you set one) applies to GitHub
   sign-ins too, not just magic links.
5. Because `TRIGGER_BOOTSTRAP_ENABLED=1`, a worker group named `bootstrap`
   and its token are created automatically and shared with the `supervisor`
   container via the `shared` volume — no manual worker-token setup needed
   for this combined single-host deployment.



## 5. Configure and deploy the example jobs

```bash
cd ../jobs
npm install
# Edit trigger.config.ts or set TRIGGER_PROJECT_REF in .env to your project ref

npx trigger.dev@latest login -a https://server.pddt.in --profile self-hosted
npx trigger.dev@latest deploy --profile self-hosted
```

This builds each task in `/jobs/src/tasks` into a container image, pushes it
to the bundled registry (`localhost:5000`, or `100.31.146.20:5000` if
deploying from your own machine — see the registry auth note below), and
registers it with the webapp.

> **Registry access from off-box:** the registry is published to
> `127.0.0.1` only by default. To `deploy` from your laptop instead of from
> the EC2 host itself, either SSH-tunnel port 5000
> (`ssh -L 5000:localhost:5000 ubuntu@100.31.146.20`) or temporarily set
> `REGISTRY_PUBLISH_IP=0.0.0.0` in `.env` and restrict access via the
> security group instead — the registry is already protected by the
> htpasswd credentials from `generate-secrets.sh`.

## 6. Trigger a test run

From the dashboard: **Test** tab → select `transcribe-meeting` → provide a
payload pointing at a short test audio file already uploaded to your S3
bucket:

```json
{
  "meetingId": "test-001",
  "s3Uri": "s3://bbx-chat-gsfc-media/recordings/test-001.mp3",
  "languageCode": "en-US"
}
```

Watch the run in the dashboard's **Runs** view. On success, check
`s3://bbx-chat-gsfc-media/transcripts/` for the output JSON.

## Deployment checklist

- [ ] Docker + Docker Compose installed and verified (`docker compose version`)
- [ ] DNS record for your domain points at the EC2 instance's public IP
- [ ] Caddy installed and running, `docker/Caddyfile` deployed with your
      domain, certificate obtained (`sudo systemctl status caddy`,
      `sudo journalctl -u caddy | grep "certificate obtained"`)
- [ ] `.env` populated via `generate-secrets.sh`, reviewed for correct
      `APP_ORIGIN`/`LOGIN_ORIGIN`/`API_ORIGIN` (your `https://` domain, not
      the bare IP) and AWS variables
- [ ] `docker compose up -d` — all 8 services report healthy
- [ ] Dashboard reachable at `https://server.pddt.in` (curl returns
      `HTTP/2 302` to `/login`, not a TLS or connection error)
- [ ] Account created, project created, project ref copied into
      `jobs/trigger.config.ts` (or `.env`)
- [ ] IAM role/instance profile attached with the policy from
      `docs/aws-setup.md` (or access keys set in `.env`)
- [ ] S3 bucket created with public access blocked
- [ ] Bedrock model access enabled for the configured model
- [ ] `npx trigger.dev@latest deploy` completes without errors
- [ ] Test run of `transcribe-meeting` succeeds end-to-end and writes output
      to S3
- [ ] Test run of `translate-transcript` succeeds using the above output
- [ ] Test run of `summarize-with-bedrock` succeeds using the translated
      (or original) transcript text
- [ ] Security group reviewed — only `22` and `8030` open, scoped to known
      IP ranges where possible
- [ ] `docker stats` checked once under load — no service near its
      `mem_limit` ceiling (see `docs/architecture.md` budget)
- [ ] Backup plan for the `postgres` and `clickhouse` named volumes decided
      (e.g. periodic `docker compose exec postgres pg_dump`, or migrate to
      RDS per the scaling section in `docs/architecture.md`)

## Testing approach

- **Unit level:** none required for the example jobs as written (they're
  thin wrappers around AWS SDK calls) — if you extend them with business
  logic, add standard Vitest/Jest tests in `jobs/src/tasks/*.test.ts`.
- **Integration level:** use the Trigger.dev dashboard's **Test** tab (see
  step 6 above) to trigger each task with a real payload against a small
  test file — this exercises the actual AWS calls end-to-end without
  needing a separate test harness.
- **Local dev loop:** run `npx trigger.dev@latest dev --profile self-hosted`
  from `/jobs` to get hot-reload against the self-hosted instance while
  iterating on task code, before running `deploy`.
- **Smoke test after any docker-compose.yml change:** `docker compose config`
  to validate YAML, then `docker compose up -d` and `docker compose ps` to
  confirm every service reaches `healthy`.

## Milestones

- [x] **Phase 1 — Research:** Trigger.dev vs Inngest self-hosting compared,
      decision documented in `README.md`.
- [x] **Phase 2 — Architecture:** 8GB RAM budget and folder structure
      documented in `docs/architecture.md`.
- [x] **Phase 3 — Build:** `docker/docker-compose.yml`, `.env.example`,
      three example jobs, and this deployment guide created.
- [x] **Phase 4 — AWS integration:** IAM policy, S3 layout, and
      Bedrock/Transcribe/Translate setup documented in `docs/aws-setup.md`.
- [ ] **Phase 5 — Validation (you are here):** run through the checklist
      above on the live EC2 instance and confirm all three example jobs
      succeed end-to-end.

