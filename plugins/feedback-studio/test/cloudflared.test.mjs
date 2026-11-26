// Tests for which cloudflared --tunnel downloads and the checksum it must
// match (lib/cloudflared.mjs). Nothing is downloaded. Run with: node --test

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { cloudflaredPlan, sha256File, CLOUDFLARED_VERSION } from '../lib/cloudflared.mjs';

const PLATFORMS = [
  ['linux', 'x64', 'cloudflared-linux-amd64', 'bin'],
  ['linux', 'arm64', 'cloudflared-linux-arm64', 'bin'],
  ['linux', 'arm', 'cloudflared-linux-arm', 'bin'],
  ['darwin', 'x64', 'cloudflared-darwin-amd64.tgz', 'tgz'],
  ['darwin', 'arm64', 'cloudflared-darwin-arm64.tgz', 'tgz'],
  ['win32', 'x64', 'cloudflared-windows-amd64.exe', 'exe'],
  ['win32', 'arm64', 'cloudflared-windows-amd64.exe', 'exe'],
];
const HEX64 = /^[0-9a-f]{64}$/;
const OTHER = 'a'.repeat(64);

test('every platform gets the fixed release, never "latest", with a hash to check', () => {
  for (const [platform, arch, file, kind] of PLATFORMS) {
    const p = cloudflaredPlan(platform, arch, {});
    assert.equal(p.version, CLOUDFLARED_VERSION, `${platform}/${arch}`);
    assert.equal(p.url, `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${file}`);
    assert.ok(!p.url.includes('/latest/'), p.url);
    assert.equal(p.kind, kind);
    assert.match(p.programSha256, HEX64, `${platform}/${arch} program hash`);
    if (kind === 'tgz') {
      assert.match(p.archiveSha256, HEX64, `${platform}/${arch} archive hash`);
      assert.notEqual(p.archiveSha256, p.programSha256, 'on macOS the archive and the program inside it differ');
    } else {
      assert.equal(p.archiveSha256, null);
    }
  }
});

test('the saved file name holds the version, so an old unchecked "cloudflared" is never reused', () => {
  assert.equal(cloudflaredPlan('linux', 'x64', {}).fileName, `cloudflared-${CLOUDFLARED_VERSION}`);
  assert.equal(cloudflaredPlan('win32', 'x64', {}).fileName, `cloudflared-${CLOUDFLARED_VERSION}.exe`);
  assert.notEqual(cloudflaredPlan('linux', 'x64', {}).fileName, 'cloudflared');
});

test('the built-in hashes are the ones checked for release 2026.11.2', () => {
  assert.equal(CLOUDFLARED_VERSION, '2026.11.2');
  assert.equal(cloudflaredPlan('linux', 'x64', {}).programSha256, '56f13335143ec0e22772963290683a84a04114a35ec64cbc794a4d39ff9bb8cf');
  assert.equal(cloudflaredPlan('darwin', 'arm64', {}).archiveSha256, 'f6d58eeec91ad1ec5fd1f7e4a587303772929b2625be5d24068033851c36ff55');
  assert.equal(cloudflaredPlan('darwin', 'arm64', {}).programSha256, '8654fbdc9057f3e13e95f7892f417f8643113bee1b91ee2388fd0acb05210d55');
});

test('an unknown platform is refused with a way forward', () => {
  assert.throws(() => cloudflaredPlan('freebsd', 'x64', {}), /no prebuilt cloudflared for freebsd\/x64.*install cloudflared yourself/);
  assert.throws(() => cloudflaredPlan('linux', 'ia32', {}), /no prebuilt cloudflared/);
});

test('another version without a hash is refused', () => {
  assert.throws(
    () => cloudflaredPlan('linux', 'x64', { FBS_CLOUDFLARED_VERSION: '2025.1.0' }),
    /FBS_CLOUDFLARED_VERSION=2025\.1\.0 needs FBS_CLOUDFLARED_SHA256/,
  );
  assert.throws(
    () => cloudflaredPlan('darwin', 'arm64', { FBS_CLOUDFLARED_VERSION: '2025.1.0' }),
    /the file inside the \.tgz/,
  );
});

test('another version with a hash is used, and that hash is what the program must match', () => {
  const p = cloudflaredPlan('linux', 'arm64', { FBS_CLOUDFLARED_VERSION: ' 2025.1.0 ', FBS_CLOUDFLARED_SHA256: OTHER.toUpperCase() });
  assert.equal(p.version, '2025.1.0');
  assert.equal(p.url, 'https://github.com/cloudflare/cloudflared/releases/download/2025.1.0/cloudflared-linux-arm64');
  assert.equal(p.fileName, 'cloudflared-2025.1.0');
  assert.equal(p.programSha256, OTHER);
  assert.equal(p.archiveSha256, null);
});

test('a malformed hash or version is refused', () => {
  assert.throws(() => cloudflaredPlan('linux', 'x64', { FBS_CLOUDFLARED_SHA256: 'abc' }), /64 hexadecimal characters/);
  assert.throws(
    () => cloudflaredPlan('linux', 'x64', { FBS_CLOUDFLARED_VERSION: '../../evil', FBS_CLOUDFLARED_SHA256: OTHER }),
    /is not a release tag/,
  );
});

test('a hash set for the built-in version must agree with the built-in one', () => {
  const builtIn = cloudflaredPlan('linux', 'x64', {}).programSha256;
  assert.equal(cloudflaredPlan('linux', 'x64', { FBS_CLOUDFLARED_SHA256: builtIn }).programSha256, builtIn);
  assert.throws(() => cloudflaredPlan('linux', 'x64', { FBS_CLOUDFLARED_SHA256: OTHER }), /does not match cloudflared 2026\.11\.2/);
  assert.throws(
    () => cloudflaredPlan('linux', 'x64', { FBS_CLOUDFLARED_VERSION: CLOUDFLARED_VERSION, FBS_CLOUDFLARED_SHA256: OTHER }),
    /does not match/,
  );
});

test('sha256File hashes a file the same way node:crypto does', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fbs-cloudflared-test-'));
  try {
    const file = path.join(dir, 'blob');
    const data = crypto.randomBytes(3 * 1024 * 1024 + 17);
    writeFileSync(file, data);
    assert.equal(await sha256File(file), crypto.createHash('sha256').update(data).digest('hex'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
