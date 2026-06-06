# Security Policy

## Threat model

Feedback Studio is a **local developer tool**. It serves your own site, or your
own Markdown, on your machine and injects a commenting overlay. By default, the
server listens only on `127.0.0.1`, so the comment API is not reachable from the
network. That API can write to `.feedback/` and, in Markdown mode, stamp markers
into source files.

You opt into wider exposure with `--host 0.0.0.0`, for example to comment from
your phone. When you do:

- Expose it only on a network you trust, such as your own Wi-Fi.
- The mutating API rejects cross-site requests (Origin/Host mismatch), but anyone
  who can reach the port can still use the API directly. Do not run it exposed on
  an untrusted or public network.
- `--proxy` is pinned to the single upstream you configure. It is not an open
  forward proxy.

When you use `--tunnel`:

- This is the **one mode that sends data off your machine.** To create the public
  `trycloudflare.com` link, your page content and comments pass through
  Cloudflare's servers. Nothing is stored there, but the session is no longer
  purely local.
- The URL is **public and unauthenticated** while the server runs. Anyone who has
  it can view, comment, edit, and resolve. Treat the link like a password, share
  it only with people you trust, and stop the server to revoke it.
- Cloudflare quick tunnels are for **ad-hoc review, not stable or production URLs**,
  and carry no uptime guarantee.
- For sensitive content, prefer the LAN paths (`--https` + `--host`) or staying
  fully local.

## Supported versions

This is pre-1.0; only the latest release is supported. Please test against `main`
before reporting.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Email **bastiaan@kb365.nl** with:

- a description of the issue and its impact,
- steps to reproduce (a minimal case is ideal),
- the version / commit you tested.

You'll get an acknowledgement, and a fix or mitigation plan once it is triaged.
Thanks for disclosing responsibly.
