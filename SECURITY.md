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
- The mutating API rejects cross-site requests (Origin/Host mismatch) and refuses
  any request whose `Host` header isn't an expected one (loopback, the LAN IPs,
  the bound host, or the tunnel hostname), which blocks DNS-rebinding. But anyone
  who can reach the port can still use the API directly. Do not run it exposed on
  an untrusted or public network.
- `--proxy` is pinned to the single upstream you configure. It is not an open
  forward proxy.

## Reviewing untrusted Markdown (`--md`)

`--md` renders a file and serves it on the same origin as the comment API, so
script inside a hostile `.md` could post comments an agent later acts on.

**By default, HTML written in the `.md` is shown as text and never rendered.**
A `<script>` block, an `<iframe>`, an `<img onerror=...>`: all of it appears on
the page as the characters you typed. This covers both a block of HTML on its own
and a tag inside a sentence. Fenced code blocks and Markdown tables are
unaffected. Markdown-generated output still passes through the same strip as
before, because a plain Markdown link can point at a `javascript:` address with
no HTML involved.

`--md-html` renders the HTML instead, for a document you wrote yourself and want
to see in full. The rendered output is then stripped of active content
(`<script>`/`<style>`, framing and redirecting tags, inline `on*` handlers, and
`javascript:` URLs). That strip is **defense in depth, not a full HTML
sanitizer**: with `--md-html`, open only Markdown you broadly trust, and prefer
staying local (loopback) when reviewing a file you didn't write.

## Pinning the `cloudflared` helper

`--tunnel` runs `cloudflared`. A `cloudflared` on your PATH (installed by you or your package manager) is used as it is. Without one, Feedback Studio downloads one fixed release (2026.11.2) into `~/.feedback-studio/bin`. The SHA-256 of every file it can download is written in `lib/cloudflared.mjs`. The download goes to a temporary name and is checked before it gets its real name, so a half-finished or changed download is never run. The saved program is checked again on every start, and a copy that does not match is deleted and downloaded again. A copy saved by an older version (named plain `cloudflared`, fetched from "latest" without a check) is not used.

To use another release, set `FBS_CLOUDFLARED_VERSION` to its tag and `FBS_CLOUDFLARED_SHA256` to the SHA-256 of the program that runs. On macOS that is the `cloudflared` file inside the `.tgz`, not the archive. A version without a hash is refused, and the server stays local.

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

This is pre-1.0; only the latest release is supported. Please test against
`master` before reporting.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Email **bastiaan@kb365.nl** with:

- a description of the issue and its impact,
- steps to reproduce (a minimal case is ideal),
- the version / commit you tested.

You'll get an acknowledgement, and a fix or mitigation plan once it is triaged.
Thanks for disclosing responsibly.
