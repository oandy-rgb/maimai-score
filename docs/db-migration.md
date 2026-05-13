# Database Migration Runbook

This project can temporarily use Neon as the primary PostgreSQL database, then
move back to CloudNativePG later. Do not write to both databases at the same
time.

## Current Target Architecture

Temporary production:

```text
Cloudflare Tunnel
  -> k3s
     -> maimai-frontend
     -> maimai-score
        -> Neon PostgreSQL
```

Later production:

```text
Cloudflare Tunnel
  -> k3s
     -> maimai-frontend
     -> maimai-score
        -> CloudNativePG PostgreSQL
           -> object-store backups
```

## Rules

- Only one database is primary at a time.
- During the Neon phase, `maimai-score` writes only to Neon.
- During the CloudNativePG phase, `maimai-score` writes only to CloudNativePG.
- Stop user writes before migration. Do not run bookmarklet sync while dumping
  or restoring data.
- Keep Neon for a few days after switching back, so rollback is still possible.

## Recommended Versions

The current CloudNativePG cluster is PostgreSQL 17.5:

```text
ghcr.io/cloudnative-pg/postgresql:17.5
```

Use PostgreSQL 17 on Neon to keep dump/restore compatibility simple.

## Switch Backend To Neon

Create a Neon database and copy the full connection string:

```text
postgresql://USER:PASSWORD@HOST/DB?sslmode=require
```

Create a Kubernetes secret for testing:

```sh
kubectl create secret generic maimai-neon-db \
  -n maimai \
  --from-literal=DATABASE_URL='postgresql://USER:PASSWORD@HOST/DB?sslmode=require'
```

Point the deployment at this secret:

```sh
kubectl set env deployment/maimai-score \
  -n maimai \
  DATABASE_URL-

kubectl set env deployment/maimai-score \
  -n maimai \
  --from=secret/maimai-neon-db

kubectl rollout restart deployment/maimai-score -n maimai
```

Check logs:

```sh
kubectl logs -n maimai deploy/maimai-score
```

Expected lines:

```text
PostgreSQL connected
Schema initialized
```

Import song data:

```sh
kubectl exec -n maimai deploy/maimai-score -- bun run src/import-cc.ts
```

Verify row counts:

```sh
kubectl exec -n maimai deploy/maimai-score -- bun -e '
const {Pool}=require("pg");
const db=new Pool({connectionString:process.env.DATABASE_URL});
console.log("song", (await db.query("select count(*) from song")).rows[0]);
console.log("score", (await db.query("select count(*) from score")).rows[0]);
console.log("player", (await db.query("select count(*) from player")).rows[0]);
await db.end();
'
```

After this works, move the Neon secret into SOPS/Flux. The manual `kubectl`
change is only for validation.

## Migrate From Neon Back To CloudNativePG

### 1. Stop Writes

Stop bookmarklet sync and any frontend operation that writes data. If needed,
scale the frontend down temporarily or block the write endpoint.

### 2. Dump Neon

Run this from a machine with `pg_dump` installed:

```sh
pg_dump 'postgresql://USER:PASSWORD@HOST/DB?sslmode=require' \
  --format=custom \
  --no-owner \
  --no-acl \
  -f maimai-neon.dump
```

### 3. Prepare CloudNativePG

Prefer restoring into an empty CloudNativePG database or a new cluster. Avoid
mixing restored data into an old non-empty database unless that is intentional.

Get the CloudNativePG connection URI:

```sh
kubectl get secret -n maimai maimai-postgres-app \
  -o jsonpath='{.data.uri}' | base64 -d
```

Port-forward the read-write service:

```sh
kubectl port-forward -n maimai svc/maimai-postgres-rw 15432:5432
```

### 4. Restore Into CloudNativePG

In another terminal:

```sh
pg_restore \
  --dbname='postgresql://USER:PASSWORD@localhost:15432/DB' \
  --clean \
  --if-exists \
  --no-owner \
  --no-acl \
  maimai-neon.dump
```

### 5. Switch Backend Back To CloudNativePG

Change the deployment secret reference back to CloudNativePG:

```yaml
env:
  - name: DATABASE_URL
    valueFrom:
      secretKeyRef:
        name: maimai-postgres-app
        key: uri
```

Then restart:

```sh
kubectl rollout restart deployment/maimai-score -n maimai
```

### 6. Verify

Check logs:

```sh
kubectl logs -n maimai deploy/maimai-score
```

Check data:

```sh
kubectl exec -n maimai deploy/maimai-score -- bun -e '
const {Pool}=require("pg");
const db=new Pool({connectionString:process.env.DATABASE_URL});
console.log("song", (await db.query("select count(*) from song")).rows[0]);
console.log("score", (await db.query("select count(*) from score")).rows[0]);
console.log("player", (await db.query("select count(*) from player")).rows[0]);
await db.end();
'
```

Also verify in the browser:

- Login works.
- Song database loads.
- B50 loads.
- Bookmarklet sync writes new scores.

## Rollback

If CloudNativePG has a problem after switching back:

1. Stop writes again.
2. Point `DATABASE_URL` back to the Neon secret.
3. Restart `maimai-score`.
4. Verify logs and row counts.

Do not keep both databases active for writes. If data was written to
CloudNativePG after the switch, decide whether to dump that data before rolling
back to Neon.

