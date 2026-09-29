# Deploying to a DigitalOcean Droplet with Docker

The stack is a plain Docker Compose application. On a server it runs the same
way as locally, with one addition: a Caddy container terminates HTTPS on ports
80/443 and proxies public traffic to the web service. PocketBase and the
worker stay on the internal network, and their loopback port bindings remain
available for SSH-tunnel administration.

## 1. Create the droplet

- Image: **Ubuntu 24.04 LTS** (or the DigitalOcean **Docker** marketplace image,
  which ships Docker and the Compose plugin already)
- Plan: at least **2 vCPU / 4 GB RAM** — the worker is capped at 1.5 GB, and
  web, PocketBase, Redis, and Caddy share the rest
- Add your SSH key when creating the droplet

## 2. Point DNS at the droplet

Create an **A record** (for example `ezpdf.example.com`) pointing to the
droplet's public IP. Caddy obtains a Let's Encrypt certificate automatically
once the name resolves, so do this before the first start.

## 3. Install Docker (skip if you used the Docker marketplace image)

```bash
ssh root@YOUR_DROPLET_IP
curl -fsSL https://get.docker.com | sh
```

## 4. Open the firewall

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

Ports 3000 and 8090 stay bound to `127.0.0.1` and must not be opened.

## 5. Clone the repository and configure

```bash
apt install -y git
git clone https://github.com/SAKWoodWorks/ezpdf.git
cd ezpdf
cp .env.example .env
```

Edit `.env`:

- `POCKETBASE_SUPERUSER_EMAIL` / `POCKETBASE_SUPERUSER_PASSWORD` — pick a
  strong, unique password; this is the server's admin account
- Add one line: `DOMAIN=ezpdf.example.com` (the DNS name from step 2)

## 6. Start the stack

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

Caddy requests a TLS certificate on first request. Create the PocketBase
superuser from the credentials in `.env`:

```bash
docker compose exec pocketbase sh -c 'pocketbase superuser upsert "$POCKETBASE_SUPERUSER_EMAIL" "$POCKETBASE_SUPERUSER_PASSWORD" --dir=/pb_data'
```

Then open `https://ezpdf.example.com/register` and create a normal user.

## 7. Verify

```bash
curl -s https://ezpdf.example.com/api/health
# -> {"status":"ok"}

docker compose ps
docker compose logs --tail 50 web worker caddy
```

## 8. Administer PocketBase without exposing it

Port 8090 is loopback-only on the droplet. Reach the admin dashboard through
an SSH tunnel from your own machine:

```bash
ssh -L 8090:127.0.0.1:8090 root@YOUR_DROPLET_IP
```

Then open `http://localhost:8090/_/` locally.

## 9. Updates

```bash
cd ezpdf
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

## 10. Backups

Two things hold state:

- `pocketbase_data` volume — accounts and job metadata
- `./runtime/jobs` — temporary files (auto-expire; back up only if you want
  in-flight results)

```bash
docker compose exec pocketbase sh -c 'cd /pb_data && tar czf - .' > pb_data_$(date +%F).tar.gz
```

Store backups off the droplet (for example with `scp`).

## Notes

- `docker compose down` preserves the PocketBase volume; never run it with
  `--volumes` unless you intend to delete accounts and metadata.
- Caddy state (TLS certificates) lives in the `caddy_data` volume; keep it so
  Let's Encrypt rate limits are not hit after restarts.
- The Windows PowerShell smoke test does not run on the droplet; the
  `curl /api/health` check plus a manual upload covers the same ground.
- Job files are temporary by design; do not move `runtime/jobs` to persistent
  storage expecting retention.
