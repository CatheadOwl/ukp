# Remote deployment

Operational guide for exposing UKP endpoints over the network. For the
two fastest consumer-side paths (SSH between personal machines, native TLS
on a bare IP), see the README's "Remote in 60 seconds"; this guide covers
every deployment shape end to end.

**Choosing a path by burden** (someone always holds the port — the only
question is who): the ssh:// path wakes the door on demand and adds zero
resident processes on every OS (Windows hosts enable the built-in OpenSSH
Server feature once). The https path needs a resident listener: on Linux,
systemd socket activation holds the port and spawns the door per use
(zero resident ukp); on Windows there is no systemd equivalent and a bun
process cannot natively be a service — the resident door runs as a
hidden logon task (no visible window, bounded crash retry; see the
Windows section), and only unattended-boot always-on would want a real
service wrapper (WinSW-class), or prefer ssh:// there. The https door is
the right shape when consumers have no SSH credentials.

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

The `ssh://` URL scheme makes the transport transparent AND wakes the door
on demand: each invocation runs one ssh process that opens the forward and
starts a pinned loopback `ukp serve` on the host (the door serves the host
Registry fresh and self-reaps when idle — nothing to pre-start, no token:
SSH carries encryption and auth). Later invocations within a couple of
minutes reuse the warmed SSH connection. Prerequisites on the host: ssh
reachable (your key) and ukp on its PATH. A first call that cannot find
`ukp` on the remote PATH says so with the remedy.

```bash
ukp register --url ssh://<host>                        # once; the first call wakes the door
ukp read --endpoint <name> notes/x.md                  # just works, like local
```

Notes:
- The `ssh://` url port selects nothing — the woken door listens on a
  client-chosen loopback port per invocation.
- **Host prerequisite = a standard install.** `npm install -g
  @catheadowl/ukp` (or `bun add -g`) on the host is all it takes — the wake
  command prepends the standard install locations (`~/.bun/bin`,
  `~/.npm-global/bin`, brew prefixes, then `$PATH`) before exec, so both
  `ukp` and its bun shebang resolve even though `ssh host cmd` runs a bare
  non-interactive PATH. Verified with a user-prefix npm install (ukp + bun
  both in `~/.npm-global/bin`, invisible to a bare shell):
  wake register 5.2s, day-2 read 4.8s, no orphans. Only exception:
  nvm-style versioned layouts have no fixed path shape — link once with
  `sudo ln -s "$(command -v ukp)" /usr/local/bin/ukp`.
- Consecutive invocations share an ssh multiplexing master for two minutes
  (handshake amortization); Windows' native ssh has no multiplexing and
  quietly pays the handshake per call.
- To lock down what SSH may run, restrict the login shell (git-shell
  style). A forced `command=` in authorized_keys does NOT compose with
  wake — the client chooses the door port per invocation, which a fixed
  forced command cannot express.

Windows note: some antivirus setups (Windows Defender behavioral inspection
included) delay a process spawned directly by the runtime by several seconds
per call — 5-10s per ssh/rg spawn was measured before ukp routed its
Windows tool spawns through a one-level relay. ukp does this automatically;
if you also add your own exclusion for your package manager's runtimes the
residual per-call cost is just the real ssh handshake plus the door spawn.

Windows hosts work out of the box: when the host's OpenSSH default shell
(cmd.exe) rejects the POSIX wake form, the client detects the signature and
resends the pinned cmd.exe form automatically — nothing to configure beyond
the OpenSSH Server feature and your key. A powershell DefaultShell is not
supported (its `-c` quoting drops the wake form).

## Native TLS (bare IP, no domain — zero extra components)

`--tls` self-signs on first start (identity = keypair, persisted under the
Service folder's `.ukp/tls/`; SAN covers the host's addresses). Clients pin
the certificate automatically at registration — same command as any other
remote, no flags added:

```bash
UKP_SERVE_TOKEN=<token> ukp serve --endpoint <name> --host 0.0.0.0 --port 8570 --tls
# consumer machine (self-signed is TOFU-pinned at registration):
ukp register --url https://<ip>:8570 --endpoint <name> --token <token>
ukp read --endpoint <name> notes/x.md                # just works, like local
```

A certificate renewal that keeps the key re-anchors transparently; a new key
(reinstall) blocks with both fingerprints until you re-register. Prefer real
certificates? Let's Encrypt issues IP-address certificates (GA 2026-01) —
run certbot with a renewal timer and point `--tls-cert/--tls-key` at the
files; clients then need no pinning at all.

**NAT/EIP cloud hosts** (public IP on no NIC — Alibaba/AWS-style 1:1 NAT):
the automatic SAN coverage can never see the public address, so name it
explicitly with `--tls-san` (repeatable; DNS names too):

```bash
UKP_SERVE_TOKEN=<token> ukp serve --endpoint <name> --host 0.0.0.0 --port 8570 \
  --tls --tls-san <public-ip>
```

A persisted certificate missing a requested entry is re-signed over the
SAME key — the pin (and thus every client registration) survives, the
banner honestly reports `self-signed identity (re-signed)`, and coverage
only grows: the re-sign keeps everything the certificate already carried
(so changing the flag list loses nothing), and already-covered or
narrower requests reuse the certificate untouched. Explicit `--tls-cert` certificates carry their own SAN, so
`--tls-san` next to them is a usage error, not a no-op.

## Windows host (https — resident form)

Windows has no socket-activation equivalent, so the https path on a
Windows host is the resident form: one-time setup, auto-start at logon,
one bun process always running — with **no visible window** (a hidden
launcher owns the console; a popping cmd box is not an acceptable product
form) and bounded crash retry. Verified end to end (register/TOFU →
read → nav, plus zero-flash and crash-recovery drills) on a Windows 11
host with a plain user-level install. Steps 3–6 are exactly what
`ukp serve --print-task --host 0.0.0.0 --tls`
(or `--tls-cert/--tls-key`) prints for you — the generator assembles the
mechanical half (start script, hidden launcher, Task Scheduler command,
firewall rule, token placeholder); this section keeps the judgment calls
and the pitfalls the verification run caught:

1. Install the usual way (bun's official installer + `npm i -g
   @catheadowl/ukp` — the npm shim needs bun on PATH, both land in
   per-user PATH dirs, which is fine here: the door is started by a
   logged-on task, not a bare ssh shell).
2. `ukp init service` in each folder, then run `ukp register` from inside
   it (register takes no folder argument) for every endpoint to expose.
3. Certificate — generate ONCE (Git for Windows' openssl works; avoids
   any runtime openssl dependency of `--tls`):
   `openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout
   %USERPROFILE%\.ukp\tls\key.pem -out %USERPROFILE%\.ukp\tls\cert.pem
   -subj "/CN=ukp" -addext "subjectAltName=IP:<lan-ip>,DNS:localhost"`
4. `%USERPROFILE%\.ukp\start-door.cmd` (CRLF!) — set UKP_SERVE_TOKEN,
   run `ukp serve --host 0.0.0.0 --port 8570 --tls-cert ... --tls-key ...`
   with the door.log redirect. No PATH export: the launcher finds bun
   itself, and the logged-on task carries the per-user PATH. Write it
   with a real editor (writing cmd files over ssh echo mangles `%`
   escaping — copy the file instead).
5. `%USERPROFILE%\.ukp\start-door-hidden.vbs` (CRLF, real editor) — the
   hidden launcher the task actually runs: it starts the console hidden
   at process creation (nothing ever flashes), captures everything to
   door.log, propagates the exit code, and retries a crashed door
   3 times, 30s apart. `ukp serve --print-task` prints it verbatim.
6. `schtasks /Create /TN ukp-door /TR "wscript.exe
   \"%USERPROFILE%\.ukp\start-door-hidden.vbs\"" /SC ONLOGON /F` (from an
   elevated shell — creating an ONLOGON task from a plain one fails with
   Access denied) + a firewall rule for the port; `schtasks /Run /TN
   ukp-door` to start now.
7. Client: `ukp register --url https://<host>:8570 --token <token>` —
   TOFU pins the certificate; re-registering refreshes the pin.

Pitfalls the verification run caught:
- **A silent bind failure**: if something already listens on the port
  (a leftover manual door, say), the new door exits EADDRINUSE invisibly
  — door.log carries the line (the hidden launcher captures everything);
  check `netstat -ano | findstr :8570` and the PID's command line.
- ONLOGON starts at LOGON, not boot, and the launcher's crash retry is
  bounded (3×30s): after an unattended reboot nobody logs into, or after
  exhausted retries, the door is down until the next logon or a manual
  `schtasks /Run`. Unattended-boot always-on would need WinSW/NSSM-class
  wrapping — or prefer ssh:// there. (Task Scheduler's own
  restart-on-failure setting does not fire on exit codes — do not rely
  on it.)
- To restart the door by hand (new token, ukp upgrade, new cert):
  `taskkill /PID <door-pid> /T /F`, then `schtasks /Run /TN ukp-door` —
  `schtasks /End` does not reliably kill the process tree.
- `rg` on the host is the host's business — no ripgrep installed means
  the remote `rg` capability reports unavailable (everything else works).

## Socket activation (Linux — no resident process on the https path either)

systemd can hold the listening port itself and spawn the door on first
connection; the door then self-reaps after `--max-idle` seconds of no
requests and systemd re-spawns it on the next one. Nothing resident
between uses — the same zero-maintenance posture as the ssh wake, for the
consumer-facing https door (Cockpit and Ubuntu's own sshd run this way).

Two user-level units (matches a user-local install). Two systemd facts
learned the hard way: **`Environment=` does not expand
`%h`/`$HOME`** (specifiers work in `ExecStart=` paths but NOT inside
`Environment=` — a literal `%h/...` PATH yields 203/EXEC), and **units
source no profile** — so write literal paths:

```ini
# ~/.config/systemd/user/ukp-door.socket
[Unit]
Description=ukp host door (socket-activated)

[Socket]
ListenStream=8570

# ~/.config/systemd/user/ukp-door.service
[Unit]
Description=ukp host door

[Service]
Environment=PATH=/home/<user>/.npm-global/bin:/home/<user>/.bun/bin:/usr/local/bin:/usr/bin
EnvironmentFile=-/home/<user>/.config/ukp-door.env   # UKP_SERVE_TOKEN=… (chmod 600)
ExecStart=/home/<user>/.npm-global/bin/ukp serve --systemd-socket --max-idle 60 --tls
```

```bash
loginctl enable-linger "$USER"          # let the socket answer while you're
                                        # not logged in
systemctl --user daemon-reload
systemctl --user enable --now ukp-door.socket
# nothing is running yet — the first client connection spawns the door:
ukp register --url https://<host>:8570 --token <token>   # cold start, TOFU-pins
```

Notes:
- The port belongs to the SOCKET unit — serve runs `--systemd-socket`
  (`--port` is rejected alongside) and requires `UKP_SERVE_TOKEN`: the
  bind address is the unit's (possibly public), so tokenless serving is
  not verifiable from inside the process.
- TLS: `--tls` self-signs on first start (identity under `~/.ukp/tls/`);
  clients pin at registration. LE/mkcert: `--tls-cert/--tls-key` as usual.
- Do NOT put an HTTP health-check in front of the socket — it would wake
  the door on every probe and defeat `--max-idle`.
- `systemctl --user` over bare ssh needs `XDG_RUNTIME_DIR=/run/user/$(id -u)`.
- Restarting the SOCKET while a door is still running is refused
  ("Socket service already active") — `systemctl --user restart
  ukp-door.service` instead, or let the door idle out first.
- **NAT/EIP hosts**: `--tls` self-signs with the machine's interface
  addresses — a public EIP is not among them, and registration would fail
  CERT_ALTNAME_INVALID. Add `--tls-san <public-ip>` next to `--tls`
  (see Native TLS above): the SAN grows, the key (and pin) does not.

## Host door (one host, many endpoints — one gesture, zero tokens)

Trust's natural unit is the host, not the endpoint: if you can ssh to a
machine, per-endpoint tokens are ceremony — and with the on-demand wake you
don't even run the door yourself: `ukp register --url ssh://<host>`
wakes a loopback door (`docker DOCKER_HOST=ssh://` posture — SSH carries
encryption and auth), imports everything behind it, and the door reaps
itself when idle:

```bash
# nothing to run on the host first — one gesture imports everything:
ukp register --url ssh://<host>
# door ssh://<host>: 2 endpoint(s)
# imported: notes    (search,propose)
# imported: archive  (-)
ukp list                       # flat rows, urls like ssh://<host>/notes
ukp read ukp://notes/plan.md   # day-2 is byte-identical to today's remotes
```

A manually started door still works (e.g. under systemd, for a host you
deliberately keep serving): `ukp serve --allow-anonymous` without
`--endpoint` exposes the same whole-registry door on a fixed loopback port —
but the wake makes that an explicit choice, not a prerequisite.

Imported endpoints are ordinary remote bindings (`url = <door>/<name>`); a
name already bound elsewhere is skipped with a visible reason, re-running
the import refreshes pins idempotently, and `--select a,b` narrows the
take. When the door grows, `ukp list` says so on stderr (`1 unimported
endpoint(s): …`) — importing it stays your call. The consumer variant of
the same door is public: `ukp serve --host 0.0.0.0 --tls-cert …` with
`UKP_SERVE_TOKEN`, imported with `ukp register --url https://<ip>:8570
--token <t>` for the whole door, or `ukp register --url https://<ip>:8570
--endpoint <name> --token <t>` for one asserted endpoint (token and pinned
certificate copied into each binding).

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
