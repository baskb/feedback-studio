// Feedback Studio — which cloudflared --tunnel downloads, and the checksum the
// program must match before it runs.
//
// --tunnel runs cloudflared. A cloudflared on PATH (installed by the user or a
// package manager) is used as it is. Without one, the server downloads one
// fixed release into ~/.feedback-studio/bin. That release and the SHA-256 of
// every file it can use are written below, so every download is the same
// program, and the saved program is checked against its SHA-256 on every
// start, not only after the download. A file that does not match is deleted
// and never run.
//
// The hashes are the digests GitHub lists for release 2026.11.2 of
// cloudflare/cloudflared, checked against a download of each file. For macOS
// the release has a .tgz: `sha256` is the archive, `programSha256` the
// cloudflared program inside it, which is what is saved and checked later.
//
// To use another release, set FBS_CLOUDFLARED_VERSION to its tag and
// FBS_CLOUDFLARED_SHA256 to the SHA-256 of the program that runs (on macOS:
// the cloudflared file inside the .tgz). A version without a hash is refused.

import { createReadStream } from 'node:fs';
import crypto from 'node:crypto';

export const CLOUDFLARED_VERSION = '2026.11.2';

const WIN_X64 = { file: 'cloudflared-windows-amd64.exe', kind: 'exe', sha256: '555b46c85582461d189cac30d14ad05480d612613801be9f110b8ce08c5b2113' };

const RELEASE = {
  'linux-x64': { file: 'cloudflared-linux-amd64', kind: 'bin', sha256: '56f13335143ec0e22772963290683a84a04114a35ec64cbc794a4d39ff9bb8cf' },
  'linux-arm64': { file: 'cloudflared-linux-arm64', kind: 'bin', sha256: '04a7b7f08bce85d56b26ffe1fdbfbb21a074495a363d16f0783c40e25b5c5281' },
  'linux-arm': { file: 'cloudflared-linux-arm', kind: 'bin', sha256: 'd219494581180764c6d2454409691bb06879d01b43cdeae12476070a7e4e4762' },
  'darwin-x64': {
    file: 'cloudflared-darwin-amd64.tgz', kind: 'tgz',
    sha256: '6153d9ec629174882a3adbff2f7dc5a24b4f3bdd7ccc38eaa84fba26eb890311',
    programSha256: '870dc2094f98befdd993c455234562be4eee51f8fca6e2e356df4579fa7e6766',
  },
  'darwin-arm64': {
    file: 'cloudflared-darwin-arm64.tgz', kind: 'tgz',
    sha256: 'f6d58eeec91ad1ec5fd1f7e4a587303772929b2625be5d24068033851c36ff55',
    programSha256: '8654fbdc9057f3e13e95f7892f417f8643113bee1b91ee2388fd0acb05210d55',
  },
  'win32-x64': WIN_X64,
  // cloudflared has no Windows build for Arm; Windows 11 on Arm runs the x64 one.
  'win32-arm64': WIN_X64,
};

const HEX64 = /^[0-9a-f]{64}$/;
const TAG = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;

// What to download for this platform, as
//   { version, url, kind, fileName, archiveSha256, programSha256 }
// kind      'bin' | 'exe' (the download is the program) or 'tgz' (macOS archive)
// fileName  the name the program is saved under in ~/.feedback-studio/bin; it
//           holds the version, so a copy saved by an older release of Feedback
//           Studio (which fetched "latest" unchecked) is never picked up
// archiveSha256  the .tgz's own hash when known (the built-in release), else null
// programSha256  the hash the saved program must match on every start
// Throws an Error with a message for the user when there is no safe answer.
export function cloudflaredPlan(platform, arch, env = {}) {
  const known = RELEASE[`${platform}-${arch}`];
  if (!known) {
    throw new Error(`no prebuilt cloudflared for ${platform}/${arch}: install cloudflared yourself (it is used from PATH), then run --tunnel again`);
  }
  const exe = platform === 'win32' ? '.exe' : '';
  const wanted = String(env.FBS_CLOUDFLARED_VERSION || '').trim();
  const pin = String(env.FBS_CLOUDFLARED_SHA256 || '').trim().toLowerCase();
  if (pin && !HEX64.test(pin)) {
    throw new Error('FBS_CLOUDFLARED_SHA256 must be a SHA-256 hash: 64 hexadecimal characters');
  }

  if (!wanted || wanted === CLOUDFLARED_VERSION) {
    const programSha256 = known.programSha256 || known.sha256;
    if (pin && pin !== programSha256) {
      throw new Error(`FBS_CLOUDFLARED_SHA256 does not match cloudflared ${CLOUDFLARED_VERSION} for ${platform}/${arch} (built in: ${programSha256})`);
    }
    return {
      version: CLOUDFLARED_VERSION,
      url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${known.file}`,
      kind: known.kind,
      fileName: `cloudflared-${CLOUDFLARED_VERSION}${exe}`,
      archiveSha256: known.kind === 'tgz' ? known.sha256 : null,
      programSha256,
    };
  }

  if (!TAG.test(wanted)) throw new Error(`FBS_CLOUDFLARED_VERSION "${wanted}" is not a release tag`);
  if (!pin) {
    throw new Error(`FBS_CLOUDFLARED_VERSION=${wanted} needs FBS_CLOUDFLARED_SHA256 as well: the SHA-256 of that release's cloudflared program for ${platform}/${arch}${known.kind === 'tgz' ? ' (the file inside the .tgz)' : ''}. Without it the download cannot be checked, so it is not used.`);
  }
  return {
    version: wanted,
    url: `https://github.com/cloudflare/cloudflared/releases/download/${wanted}/${known.file}`,
    kind: known.kind,
    fileName: `cloudflared-${wanted}${exe}`,
    archiveSha256: null,
    programSha256: pin,
  };
}

// SHA-256 of a file, read in pieces (cloudflared is about 40 MB).
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}
