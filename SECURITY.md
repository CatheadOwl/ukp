# Security Policy

## Reporting a vulnerability

Report privately using GitHub security advisories:

https://github.com/CatheadOwl/ukp/security/advisories/new

Please do not open public issues for security reports. We follow
coordinated vulnerability disclosure (the CERT process, with the 90-day
convention as the default clock) and credit reporters unless they prefer
to stay anonymous. Good-faith research on your own deployments is welcome.

## Supported versions

Only the latest published release line receives security fixes.

## Scope

In scope:

- the `ukp` CLI runtime: local capability commands, `ukp serve`
  (transport, authentication, TLS identity, door routing), the generated
  door artifacts (`ukp serve --print-task`), and credential handling on
  consumer machines;
- the published package supply chain (npm tarball, GitHub repository).

Out of scope:

- hardening of your own host, SSH daemon, or reverse proxy — deployment
  guidance exists, but operator-side misconfiguration is not a UKP
  vulnerability;
- private working materials that are not part of the published package.

## Posture summary

- Local-first: no network listener exists until you run `ukp serve`.
- Deny-by-default serving: serving beyond loopback without
  `UKP_SERVE_TOKEN` is refused; anonymous serving is an explicit flag and
  loopback-only.
- Transport: `https://` with registration-time pinning (self-signed
  certificates are pinned by SPKI; a renewal on the same key re-pins
  transparently, a different key hard-blocks) or `ssh://`, where SSH
  carries both encryption and authentication.
- Door scoping: a `--select` door neither routes, declares, nor lists
  unselected endpoints; excluded and unknown names return byte-identical
  404s.

Deployment hardening (token strength, reverse proxies, firewalls,
systemd) is covered in the
[deployment guide](https://github.com/CatheadOwl/ukp/blob/main/docs/remote-deployment.md).

## Known, accepted tradeoffs

Disclosed rather than hidden; each has a documented trigger for change:

- Tokens are long-lived static bearer secrets. OAuth flows are deferred
  until a multi-tenant or hosted scenario exists.
- Read and write use the same token today; separation becomes mandatory
  with the first remote content-write capability.
- Client-side tokens live in the 0600 registry file or an environment
  variable, in plaintext — the same tradeoff as `~/.aws/credentials`.
- The Windows door artifact embeds the token in a 0600 `start-door.cmd`
  and never prints it; a file that ever left the machine burns the token.
- Identity pinning is trust-on-first-use, with the SSH-style
  first-connect window that implies.
- npm provenance attestations prove where and how a package was built,
  not that the code is safe — verify with `npm audit signatures` and
  treat provenance as one signal among several.
