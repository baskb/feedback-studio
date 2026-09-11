// Tests for what --tailscale reads out of `tailscale status --json`, and the
// certificate-cache rule. Run with: node --test

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTailscaleStatus, certNeedsRefresh } from '../lib/tailscale.mjs';

const status = (over = {}) => ({
  BackendState: 'Running',
  CertDomains: ['omarchy.tail695f42.ts.net'],
  Self: {
    DNSName: 'omarchy.tail695f42.ts.net.',
    TailscaleIPs: ['fd7a:115c:a1e0::c02a:6e2c', '100.80.110.43'],
  },
  ...over,
});

test('MagicDNS name loses its trailing dot, the first IPv4 wins, HTTPS is detected', () => {
  const ts = parseTailscaleStatus(status());
  assert.equal(ts.name, 'omarchy.tail695f42.ts.net');
  assert.equal(ts.ip, '100.80.110.43');
  assert.equal(ts.certOk, true);
  assert.equal(ts.running, true);
  assert.equal(ts.state, 'Running');
});

test('a tailnet without HTTPS certificates gives certOk false', () => {
  assert.equal(parseTailscaleStatus(status({ CertDomains: [] })).certOk, false);
  assert.equal(parseTailscaleStatus(status({ CertDomains: undefined })).certOk, false);
  // A different machine's domain does not count for this one.
  assert.equal(parseTailscaleStatus(status({ CertDomains: ['other.tail695f42.ts.net'] })).certOk, false);
  // Case and a trailing dot on the domain list do not matter.
  assert.equal(parseTailscaleStatus(status({ CertDomains: ['Omarchy.tail695f42.ts.net.'] })).certOk, true);
});

test('a stopped or logged-out daemon is not running, and missing fields never throw', () => {
  const t = parseTailscaleStatus(status({ BackendState: 'NeedsLogin', Self: { DNSName: '', TailscaleIPs: [] } }));
  assert.equal(t.running, false);
  assert.equal(t.state, 'NeedsLogin');
  assert.equal(t.name, '');
  assert.equal(t.ip, null);
  assert.equal(t.certOk, false);
  assert.deepEqual(parseTailscaleStatus(null), { name: '', ip: null, certOk: false, running: false, state: '' });
  assert.deepEqual(parseTailscaleStatus({}), { name: '', ip: null, certOk: false, running: false, state: '' });
});

test('IPv6-only self falls back to the top-level TailscaleIPs list, else null', () => {
  const s = status({ TailscaleIPs: ['100.1.2.3'], Self: { DNSName: 'x.ts.net.' } });
  assert.equal(parseTailscaleStatus(s).ip, '100.1.2.3');
  assert.equal(parseTailscaleStatus(status({ Self: { DNSName: 'x.ts.net.', TailscaleIPs: ['fd7a::1'] } })).ip, null);
});

test('a cached certificate is reused only while it has more than 30 days left', () => {
  const now = Date.parse('2026-09-11T12:00:00Z');
  const day = 86400000;
  assert.equal(certNeedsRefresh(new Date(now + 90 * day), now), false);
  assert.equal(certNeedsRefresh(new Date(now + 31 * day), now), false);
  assert.equal(certNeedsRefresh(new Date(now + 30 * day), now), true);
  assert.equal(certNeedsRefresh(new Date(now + 1 * day), now), true);
  assert.equal(certNeedsRefresh(new Date(now - 1 * day), now), true);
  // The X509Certificate.validTo string form, and garbage.
  assert.equal(certNeedsRefresh('Dec 10 18:37:52 2026 GMT', now), false);
  assert.equal(certNeedsRefresh('not a date', now), true);
  assert.equal(certNeedsRefresh(undefined, now), true);
});
