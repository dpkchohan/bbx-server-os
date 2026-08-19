#!/usr/bin/env bash
# Generates all required secrets for the bbx-server-os Trigger.dev stack and
# writes them into .env (created from .env.example if missing), plus the
# registry's htpasswd file.
#
# Usage (from the docker/ directory):
#   ./generate-secrets.sh
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp ../.env.example .env
  echo "Created .env from ../.env.example"
fi

gen() { openssl rand -hex 16; }

set_or_append() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env; then
    sed -i.bak "s#^${key}=.*#${key}=${value}#" .env && rm -f .env.bak
  else
    echo "${key}=${value}" >> .env
  fi
}

for key in SESSION_SECRET MAGIC_LINK_SECRET ENCRYPTION_KEY PROVIDER_SECRET \
           COORDINATOR_SECRET MANAGED_WORKER_SECRET POSTGRES_PASSWORD \
           CLICKHOUSE_PASSWORD OBJECT_STORE_SECRET_ACCESS_KEY; do
  current="$(grep "^${key}=" .env | cut -d= -f2- || true)"
  if [ -z "${current}" ]; then
    set_or_append "$key" "$(gen)"
    echo "Generated ${key}"
  else
    echo "${key} already set, skipping"
  fi
done

# Registry htpasswd (basic auth for the bundled container registry)
REGISTRY_USER="${REGISTRY_USER:-trigger}"
REGISTRY_PASSWORD="$(gen)"
docker run --rm httpd:2.4-alpine htpasswd -Bbn "$REGISTRY_USER" "$REGISTRY_PASSWORD" > registry/auth.htpasswd
set_or_append DOCKER_REGISTRY_USERNAME "$REGISTRY_USER"
set_or_append DOCKER_REGISTRY_PASSWORD "$REGISTRY_PASSWORD"

echo ""
echo "Done. Registry credentials: ${REGISTRY_USER} / ${REGISTRY_PASSWORD}"
echo "Review .env, then run: docker compose up -d"
