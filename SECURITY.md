# Security Policy

## Threat model

Feedback Studio is a **local developer tool**. It serves your own site (or your
own Markdown) on your own machine and injects a commenting overlay. By default the
server binds to **loopback only** (`127.0.0.1`), so the comment API — which can
write to `.feedback/` and, in Markdown mode, stamp markers into your source files
— is not reachable from the network.

You opt into wider exposure with `--host 0.0.0.0` (e.g. to comment from your
phone). When you do:

- Only expose it on a network you trust (your own Wi-Fi).
- The mutating API rejects cross-site requests (Origin/Host mismatch), but anyone
  who can reach the port can still use the API directly. Don't run it exposed on
  an untrusted or public network.
- `--proxy` is pinned to the single upstream you configure; it is not an open
  forward proxy.

When you use `--tunnel`:

- This is the **one mode that sends data off your machine.** To create the public
  `trycloudflare.com` link, your page content and comments are routed through
  Cloudflare's edge. Nothing is stored there, but the session is no longer
  local-only / no-egress.
- The URL is **public and unauthenticated** while the server runs — anyone who has
  it can view *and* comment / edit / resolve. Treat the link like a password, share
  it only with people you trust, and stop the server to revoke it.
- Cloudflare quick tunnels are for **ad-hoc review, not a stable or production URL**,
  and carry no uptime guarantee.
- For sensitive content, prefer the LAN paths (`--https` + `--host`) or staying fully local.

## Supported versions

This is pre-1.0; only the latest release is supported. Please test against `main`
before reporting.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Email **bastiaan@kb365.nl** with:

- a description of the issue and its impact,
- steps to reproduce (a minimal case is ideal),
- the version / commit you tested.

You'll get an acknowledgement, and a fix or mitigation plan once it's triaged.
Thanks for disclosing responsibly.
