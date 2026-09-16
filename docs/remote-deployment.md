# Remote deployment

Operational guide for exposing UKP endpoints over the network. For the
two fastest consumer-side paths (SSH between personal machines, native TLS
on a bare IP), see the README's "Remote in 60 seconds"; this guide covers
every deployment shape end to end.

`ukp serve` speaks plain HTTP by default; TLS and public exposure are either
**native** (`--tls` self-signs through the local openssl, `--tls-cert/--tls-key`
serve your own certificate) or **delegated to a fronting component** (reverse
proxy, SSH tunnel, overlay). The trust model is public PKI, or automatic TOFU
pinning for self-signed and private-CA certificates. **Authentication is
deny-by-default**: serving requires `UKP_SERVE_TOKEN`; tokenless serving needs
an explicit `--allow-anonymous` and is refused off loopback. A reverse proxy on
the same host forwards from the public side to the loopback bind, so proxied
deployments treat the token as mandatory (serve cannot see past its own bind
address).

## Via SSH (two personal machines — zero extra components, zero ceremony)

The `ssh://` URL scheme makes the transport transparent: ukp opens an
ephemeral SSH tunnel per invocation (key auth from your SSH config), so a
registered remote endpoint takes the same commands as a local one — search,
read, nav, rg, propose — with no manual tunnel and no env ceremony once the
token is stored.

```bash
ukp register --url ssh://<host>:8570 --token <token>   # once; TOFU + token stored
ukp read --endpoint <name> notes/x.md                   # just works, like local
```

## Native TLS (bare IP, no domain — zero extra components)

`--tls` self-signs on first start (identity = keypair, persisted under the
Service folder's `.ukp/tls/`; SAN covers the host's addresses). Clients pin
the certificate automatically at registration — same command as any other
remote, no flags added:

```bash
UKP_SERVE_TOKEN=<token> ukp serve --endpoint <name> --host 0.0.0.0 --port 8570 --tls
# consumer machine (self-signed is TOFU-pinned at registration):
ukp register --url https://<ip>:8570 --token <token>
ukp read --endpoint <name> notes/x.md                # just works, like local
```

A certificate renewal that keeps the key re-anchors transparently; a new key
(reinstall) blocks with both fingerprints until you re-register. Prefer real
certificates? Let's Encrypt issues IP-address certificates (GA 2026-01) —
run certbot with a renewal timer and point `--tls-cert/--tls-key` at the
files; clients then need no pinning at all.

## Host door (one host, many endpoints — one gesture, zero tokens)

Trust's natural unit is the host, not the endpoint: if you can ssh to a
machine, per-endpoint tokens are ceremony. Run `ukp serve` **without**
`--endpoint` and the whole registry answers behind one loopback port
(`docker DOCKER_HOST=ssh://` posture — SSH carries encryption and auth, so
`--allow-anonymous` on loopback is the owner deployment):

```bash
# on the host (systemd: the same unit with --endpoint dropped):
ukp serve --allow-anonymous
# serving host door (ukp-remote v1)
#   listening:  http://127.0.0.1:8570
#   endpoints:  archive, notes            <- every local binding, grows without restart

# on your machine — one gesture imports everything behind the door:
ukp register --url ssh://<host>
# door ssh://<host>: 2 endpoint(s)
# imported: notes    (search,propose)
# imported: archive  (-)
ukp list                       # flat rows, urls like ssh://<host>/notes
ukp read ukp://notes/plan.md   # day-2 is byte-identical to today's remotes
```

Imported endpoints are ordinary remote bindings (`url = <door>/<name>`); a
name already bound elsewhere is skipped with a visible reason, re-running
the import refreshes pins idempotently, and `--select a,b` narrows the
take. When the door grows, `ukp list` says so on stderr (`1 unimported
endpoint(s): …`) — importing it stays your call. The consumer variant of
the same door is public: `ukp serve --host 0.0.0.0 --tls-cert …` with
`UKP_SERVE_TOKEN`, imported with `ukp register --url https://<ip>:8570
--token <t>` (token and pinned certificate copied into each binding).

## Behind Caddy (public domain)

```
# Caddyfile — automatic Let's Encrypt
kb.example.com {
    reverse_proxy 127.0.0.1:8570
}
```

```bash
UKP_SERVE_TOKEN=<token> ukp serve --endpoint <name> --host 127.0.0.1 --port 8570
# on the consumer machine:
UKP_ENDPOINT_<NAME>_TOKEN=<token> ukp register --url https://kb.example.com
```

## Via Tailscale (two machines on any network — including the same LAN)

Enable HTTPS certificates on your tailnet once (admin console: DNS →
MagicDNS → HTTPS Certificates); Tailscale then provisions Let's Encrypt
certificates for your `*.ts.net` hostnames.

```bash
# both machines: tailscale up (same tailnet)
# server machine:
UKP_SERVE_TOKEN=<token> ukp serve --endpoint <name> --host 127.0.0.1 --port 8570
tailscale serve --bg --https=443 http://127.0.0.1:8570
# consumer machine:
UKP_ENDPOINT_<NAME>_TOKEN=<token> ukp register --url https://<machine>.<tailnet>.ts.net
```

The overlay covers LAN and roaming machines alike; a fully offline LAN (no
coordination reachability) is the one gap — a dedicated private-CA recipe is
not covered here.

## Hardening posture

- rate limiting, IP allowlists, and audit logging live at the proxy layer —
  the `ukp` core stays thin;
- multiple client tokens: comma-separate them — `UKP_SERVE_TOKEN=alice,bob`
  (any listed token authorizes);
- identity pinning is TOFU on `instance_uid`: a changed endpoint warns by
  default; set `UKP_TOFU=block` on hostile networks to refuse it outright.
