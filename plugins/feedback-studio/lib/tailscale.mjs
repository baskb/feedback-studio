// Feedback Studio — what --tailscale needs from `tailscale status --json`.
//
// No child process here: the server runs the command and hands the parsed JSON
// to parseTailscaleStatus, so the same rules run against a fake status object
// in the test suite.

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// Distil a status document into { name, ip, certOk, running, state }:
//   name    the machine's MagicDNS name, without the trailing dot, lower-case
//   ip      its first Tailscale IPv4 (100.x.y.z), or null
//   certOk  whether the tailnet has HTTPS certificates enabled for that name
//           (CertDomains lists the names `tailscale cert` may issue for)
//   running whether the daemon is up and logged in (BackendState "Running")
export function parseTailscaleStatus(status) {
  const s = status && typeof status === 'object' ? status : {};
  const self = s.Self && typeof s.Self === 'object' ? s.Self : {};
  const name = String(self.DNSName || '').replace(/\.+$/, '').toLowerCase();
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs
    : Array.isArray(s.TailscaleIPs) ? s.TailscaleIPs : [];
  const ip = ips.map(String).find((a) => IPV4.test(a)) || null;
  const domains = (Array.isArray(s.CertDomains) ? s.CertDomains : []).map((d) => String(d).replace(/\.+$/, '').toLowerCase());
  const state = String(s.BackendState || '');
  return { name, ip, certOk: !!name && domains.includes(name), running: state === 'Running', state };
}

// A cached certificate is reused while it has more than `minDays` left.
// `validTo` is the X509Certificate.validTo string (or a Date / epoch ms).
export function certNeedsRefresh(validTo, now = Date.now(), minDays = 30) {
  const exp = validTo instanceof Date ? validTo.getTime() : (typeof validTo === 'number' ? validTo : Date.parse(String(validTo)));
  if (!Number.isFinite(exp)) return true;
  const nowMs = now instanceof Date ? now.getTime() : now;
  return exp - nowMs <= minDays * 86400000;
}
