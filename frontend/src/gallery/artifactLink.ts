import type { PublicArtifact } from '../types';
import { MAX_ARTIFACT_BYTES } from './parseArtifact';

/** Conservative ceiling for links copied to browsers, chat clients, and terminals. */
export const MAX_GALLERY_URL_CHARS = 32 * 1024;

const MAX_ENCODED_ARTIFACT_CHARS = (MAX_ARTIFACT_BYTES * 3) + 16;
const BASE64_CHUNK_BYTES = 32 * 1024;

export interface BuildPublicArtifactLinkOptions {
  baseUrl?: string;
  currentUrl?: string;
  maxUrlChars?: number;
}

export type BuildPublicArtifactLinkResult =
  | { ok: true; url: string; json: string }
  | { ok: false; reason: 'too_large'; json: string }
  | { ok: false; reason: 'malformed'; json?: string };

export type DecodePublicArtifactHashResult =
  | { ok: true; json: string }
  | { ok: false; reason: 'too_large' | 'malformed' };

function bytesToBinaryString(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_BYTES);
    binary += String.fromCharCode(...chunk);
  }
  return binary;
}

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(bytesToBinaryString(bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

function decodeBase64Bytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/u.test(value)) return null;
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = (4 - (normalized.length % 4)) % 4;
  try {
    const binary = atob(`${normalized}${'='.repeat(paddingLength)}`);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function validateDecodedJson(json: string): DecodePublicArtifactHashResult {
  if (new TextEncoder().encode(json).byteLength > MAX_ARTIFACT_BYTES) {
    return { ok: false, reason: 'too_large' };
  }
  try {
    JSON.parse(json);
    return { ok: true, json };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

/**
 * Decode `#data=` payloads without throwing.
 *
 * New links use UTF-8 base64url. Percent-encoded JSON and plain base64 remain
 * accepted so previously exported local links continue to open.
 */
export function decodePublicArtifactHash(hash: string): DecodePublicArtifactHashResult {
  try {
    if (!hash.startsWith('#data=')) return { ok: false, reason: 'malformed' };
    const payload = hash.slice(6);
    if (!payload || payload.length > MAX_ENCODED_ARTIFACT_CHARS) {
      return {
        ok: false,
        reason: payload.length > MAX_ENCODED_ARTIFACT_CHARS ? 'too_large' : 'malformed',
      };
    }

    try {
      const percentDecoded = decodeURIComponent(payload);
      const firstCharacter = percentDecoded.trimStart()[0];
      if (firstCharacter === '{' || firstCharacter === '[') {
        return validateDecodedJson(percentDecoded);
      }
    } catch {
      // A non-percent payload may still be valid base64/base64url.
    }

    const bytes = decodeBase64Bytes(payload);
    if (!bytes) return { ok: false, reason: 'malformed' };
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) return { ok: false, reason: 'too_large' };

    try {
      const utf8Json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return validateDecodedJson(utf8Json);
    } catch {
      // Old plain-base64 links used atob's byte string directly.
      const legacyJson = bytesToBinaryString(bytes);
      return validateDecodedJson(legacyJson);
    }
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

/** Build a zero-network Gallery URL from an already-sanitized PublicArtifact. */
export function buildPublicArtifactLink(
  artifact: PublicArtifact,
  options: BuildPublicArtifactLinkOptions = {},
): BuildPublicArtifactLinkResult {
  let json: string;
  try {
    const serialized = JSON.stringify(artifact);
    if (typeof serialized !== 'string') return { ok: false, reason: 'malformed' };
    json = serialized;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  try {
    const bytes = new TextEncoder().encode(json);
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      return { ok: false, reason: 'too_large', json };
    }

    const runtimeBaseUrl = options.baseUrl ?? import.meta.env.BASE_URL;
    const currentUrl = options.currentUrl
      ?? (typeof window === 'undefined' ? 'http://localhost/' : window.location.href);
    const normalizedBaseUrl = runtimeBaseUrl.endsWith('/')
      ? runtimeBaseUrl
      : `${runtimeBaseUrl}/`;
    const galleryUrl = new URL('gallery.html', new URL(normalizedBaseUrl, currentUrl));
    galleryUrl.hash = `data=${encodeBase64Url(bytes)}`;

    const url = galleryUrl.toString();
    const maxUrlChars = options.maxUrlChars ?? MAX_GALLERY_URL_CHARS;
    if (url.length > maxUrlChars) {
      return { ok: false, reason: 'too_large', json };
    }
    return { ok: true, url, json };
  } catch {
    return { ok: false, reason: 'malformed', json };
  }
}
