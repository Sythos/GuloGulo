// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

const ALLOWED_ELEMENTS = new Set(['a', 'abbr', 'b', 'blockquote', 'br', 'code', 'del', 'em', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul']);
const BLOCKED_ELEMENTS = new Set(['applet', 'base', 'embed', 'form', 'iframe', 'input', 'link', 'meta', 'object', 'script', 'select', 'style', 'textarea', 'title', 'video', 'audio', 'source']);
const VOID_ELEMENTS = new Set(['br', 'hr', 'img']);
const BLOCK_ELEMENTS = new Set(['blockquote', 'li', 'ol', 'p', 'pre', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul']);
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export class EmailContentError extends Error {
  readonly code: string;
  constructor(message: string, code = 'EMAIL_CONTENT_ERROR') { super(`Email content error: ${message}`); this.name = 'EmailContentError'; this.code = code; }
}

interface ParsedTag { closing: boolean; name: string; attributes: string }
interface ParsedAttribute { name: string; value: string }
interface BlockedResource { kind: 'image' | 'link'; reason: string }
interface MutableMetadata {
  mode: 'constrained'; allowedElements: readonly string[]; blockedElements: string[]; blockedAttributes: string[];
  blockedResources: BlockedResource[]; remoteImagesBlocked: number; truncated: boolean;
}
interface SanitizeOptions { allowRemoteImages?: boolean; allowHttpLinks?: boolean; maxInputBytes?: number; maxOutputBytes?: number }

function contentError(message: string, code = 'EMAIL_CONTENT_ERROR'): EmailContentError { return new EmailContentError(message, code); }
function escapeHtml(value: unknown): string { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/giu, (_match, code: string) => { const number = Number.parseInt(code, 16); return Number.isSafeInteger(number) ? String.fromCodePoint(Math.min(number, 0x10ffff)) : ''; })
    .replace(/&#([0-9]+);?/gu, (_match, code: string) => { const number = Number.parseInt(code, 10); return Number.isSafeInteger(number) ? String.fromCodePoint(Math.min(number, 0x10ffff)) : ''; })
    .replace(/&(?:amp|lt|gt|quot|apos|#39);/giu, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" }[entity.toLowerCase()] ?? entity));
}

function parseTag(token: string): ParsedTag | null {
  const match = token.match(/^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)([\s\S]*?)>$/u);
  return match ? { closing: match[1] === '/', name: match[2].toLowerCase(), attributes: match[3].replace(/\/\s*$/u, '') } : null;
}

function parseAttributes(source: string): ParsedAttribute[] {
  const attributes: ParsedAttribute[] = [];
  const pattern = /([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  for (const match of source.matchAll(pattern)) attributes.push({ name: match[1].toLowerCase(), value: match[2] ?? match[3] ?? match[4] ?? '' });
  return attributes;
}

function safeUrl(rawValue: string, options: { kind: 'image' | 'link'; allowRemoteImages: boolean; allowHttpLinks: boolean }): { allowed: true; value: string } | { allowed: false; reason: string } {
  const value = decodeHtmlEntities(rawValue.trim());
  // eslint-disable-next-line no-control-regex -- deliberately rejecting control characters, not a stray escape
  if (value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) return { allowed: false, reason: 'empty-or-control-character' };
  if (options.kind === 'image' && value.toLowerCase().startsWith('cid:')) return { allowed: true, value };
  let parsed: URL;
  try { parsed = new URL(value, 'https://invalid.local'); } catch { return { allowed: false, reason: 'invalid-url' }; }
  const protocol = parsed.protocol.toLowerCase();
  if (!SAFE_PROTOCOLS.has(protocol) || (options.kind === 'image' && protocol !== 'https:') || (options.kind === 'image' && !options.allowRemoteImages)) return { allowed: false, reason: 'protocol-or-resource-policy' };
  if (protocol === 'http:' && !options.allowHttpLinks && options.kind === 'link') return { allowed: false, reason: 'insecure-link' };
  if (parsed.username || parsed.password) return { allowed: false, reason: 'embedded-credentials' };
  return { allowed: true, value: parsed.hostname === 'invalid.local' ? parsed.pathname + parsed.search + parsed.hash : parsed.toString() };
}

function safeClass(value: string): string { return value.split(/\s+/u).filter((token) => /^[A-Za-z0-9_-]{1,64}$/u.test(token)).slice(0, 32).join(' '); }
function safeDimension(value: string): string | null { return /^(?:[1-9][0-9]{0,3}|0)$/u.test(value.trim()) ? value.trim() : null; }

function sanitizeAttributes(tag: string, attributes: ParsedAttribute[], options: Required<Pick<SanitizeOptions, 'allowRemoteImages' | 'allowHttpLinks'>>, metadata: MutableMetadata): string {
  const output: Array<[string, string]> = [];
  const seen = new Set<string>();
  let imageBlocked = false;
  let imageAlt = '';
  for (const { name, value } of attributes) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (name.startsWith('on') || ['style', 'srcdoc', 'formaction', 'ping'].includes(name)) { metadata.blockedAttributes.push(name); continue; }
    if (name === 'href' && tag === 'a') {
      const result = safeUrl(value, { kind: 'link', ...options });
      if (!result.allowed) { metadata.blockedResources.push({ kind: 'link', reason: result.reason }); continue; }
      output.push(['href', result.value]); continue;
    }
    if (name === 'src' && tag === 'img') {
      const result = safeUrl(value, { kind: 'image', ...options });
      if (!result.allowed) { imageBlocked = true; metadata.blockedResources.push({ kind: 'image', reason: result.reason }); continue; }
      output.push(['src', result.value]); continue;
    }
    if (name === 'alt' && tag === 'img') { imageAlt = value.slice(0, 512); output.push(['alt', imageAlt]); continue; }
    if (name === 'target' && tag === 'a' && value === '_blank') { output.push(['target', '_blank'], ['rel', 'noopener noreferrer nofollow']); continue; }
    if (name === 'rel' && tag === 'a') continue;
    if (name === 'class') { const safe = safeClass(value); if (safe) output.push(['class', safe]); continue; }
    if (name === 'id' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value)) { output.push(['id', value]); continue; }
  // eslint-disable-next-line no-control-regex -- deliberately rejecting control characters, not a stray escape
    if (['title', 'dir', 'lang', 'role', 'scope'].includes(name)) { if (value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)) output.push([name, value]); continue; }
    if (['width', 'height', 'colspan', 'rowspan'].includes(name)) { const safe = safeDimension(value); if (safe) output.push([name, safe]); continue; }
    if (name === 'loading' && tag === 'img' && (value === 'lazy' || value === 'eager')) { output.push(['loading', value]); continue; }
    if (name.startsWith('aria-') && /^[A-Za-z0-9 _.,:;()'"!?/-]{0,256}$/u.test(value)) { output.push([name, value]); continue; }
    metadata.blockedAttributes.push(name);
  }
  if (tag === 'img' && imageBlocked) {
    metadata.remoteImagesBlocked += 1;
    output.push(['data-gulogulo-remote-image-blocked', 'true']);
    if (!output.some(([name]) => name === 'alt')) output.push(['alt', imageAlt || 'Remote image blocked']);
  }
  return output.map(([name, value]) => `${name}="${escapeHtml(value)}"`).join(' ');
}

function appendText(text: string, htmlParts: string[], textParts: string[]): void { htmlParts.push(escapeHtml(text)); textParts.push(decodeHtmlEntities(text)); }

export function sanitizeEmailHtml(input: unknown, options: SanitizeOptions = {}) {
  const { allowRemoteImages = false, allowHttpLinks = false, maxInputBytes = 1_048_576, maxOutputBytes = 1_048_576 } = options;
  if (typeof input !== 'string') throw contentError('HTML input must be a string', 'INVALID_INPUT');
  if (Buffer.byteLength(input, 'utf8') > maxInputBytes) throw contentError('HTML input exceeds the rendering limit', 'CONTENT_TOO_LARGE');
  const metadata: MutableMetadata = { mode: 'constrained', allowedElements: Object.freeze([...ALLOWED_ELEMENTS].sort()), blockedElements: [], blockedAttributes: [], blockedResources: [], remoteImagesBlocked: 0, truncated: false };
  const htmlParts: string[] = [];
  const textParts: string[] = [];
  const openElements: string[] = [];
  const blockedElements: string[] = [];
  const tokens = input.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][^>]*>|[^<]+/gu) ?? [];
  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<!')) continue;
    const tag = token.startsWith('<') ? parseTag(token) : null;
    if (!tag) { if (blockedElements.length === 0) appendText(token, htmlParts, textParts); continue; }
    if (blockedElements.length > 0) { if (tag.closing && tag.name === blockedElements.at(-1)) blockedElements.pop(); continue; }
    if (BLOCKED_ELEMENTS.has(tag.name)) { metadata.blockedElements.push(tag.name); if (!tag.closing && !token.endsWith('/>')) blockedElements.push(tag.name); continue; }
    if (!ALLOWED_ELEMENTS.has(tag.name)) { metadata.blockedElements.push(tag.name); continue; }
    if (tag.closing) {
      const index = openElements.lastIndexOf(tag.name);
      if (index === -1) continue;
      for (let closeIndex = openElements.length - 1; closeIndex >= index; closeIndex -= 1) htmlParts.push(`</${openElements[closeIndex]}>`);
      openElements.splice(index);
      if (BLOCK_ELEMENTS.has(tag.name)) textParts.push('\n');
      continue;
    }
    const attributeText = sanitizeAttributes(tag.name, parseAttributes(tag.attributes), { allowRemoteImages, allowHttpLinks }, metadata);
    htmlParts.push(`<${tag.name}${attributeText ? ` ${attributeText}` : ''}>`);
    if (tag.name === 'br' || BLOCK_ELEMENTS.has(tag.name)) textParts.push('\n');
    if (!VOID_ELEMENTS.has(tag.name) && !token.endsWith('/>')) openElements.push(tag.name);
  }
  for (const tag of openElements.reverse()) htmlParts.push(`</${tag}>`);
  const html = htmlParts.join('');
  if (Buffer.byteLength(html, 'utf8') > maxOutputBytes) throw contentError('sanitized HTML exceeds the rendering limit', 'CONTENT_TOO_LARGE');
  const text = textParts.join('').replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
  return Object.freeze({ html, text, metadata: Object.freeze({ ...metadata, blockedElements: Object.freeze([...new Set(metadata.blockedElements)]), blockedAttributes: Object.freeze([...new Set(metadata.blockedAttributes)]), blockedResources: Object.freeze(metadata.blockedResources.map((item) => Object.freeze({ ...item }))) }) });
}

export { contentError };
