import { randomBytes, createHash } from 'node:crypto';

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateCodeVerifier() {
  return base64UrlEncode(randomBytes(32));
}

export function generateCodeChallenge(verifier) {
  return base64UrlEncode(createHash('sha256').update(verifier).digest());
}

export function generateState() {
  return base64UrlEncode(randomBytes(16));
}
