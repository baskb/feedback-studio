# Third-party attributions

Feedback Studio is zero-dependency at runtime: serving a site and injecting the
overlay uses only the Node.js standard library. Three optional helpers are fetched
on demand the first time you use a flag that needs them. They are downloaded into
`~/.feedback-studio/` (not bundled with this project) and are never required unless
you opt into the matching flag.

| Helper | Used by | License |
|---|---|---|
| [marked](https://github.com/markedjs/marked) | `--md` (Markdown rendering) | MIT |
| [selfsigned](https://github.com/jfromaniello/selfsigned) | `--https` (self-signed TLS cert) | MIT |
| [cloudflared](https://github.com/cloudflare/cloudflared) (downloaded binary) | `--tunnel` (public HTTPS tunnel) | Apache-2.0 |

Each helper is the property of its respective authors and is distributed under its
own license, linked above.

## This project

Feedback Studio itself is licensed under the MIT License. See [LICENSE](LICENSE).
