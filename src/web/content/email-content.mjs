// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

const ALLOWED_ELEMENTS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'del', 'em', 'hr', 'i', 'img',
  'li', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
]);

const BLOCKED_ELEMENTS = new Set([
  'applet', 'base', 'embed', 'form', 'iframe', 'input', 'link', 'meta', 'object',
  'script', 'select', 'style', 'textarea', 'title', 'video', 'audio', 'source',
]);

const VOID_ELEMENTS = new Set(['br', 'hr', 'img']);
const BLOCK_ELEMENTS = new Set(['blockquote', 'li', 'ol', 'p', 'pre', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul']);
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function contentError(message, code = 'EMAIL_CONTENT_ERROR') {
  const error = new Error(`Email content error: ${message}`);
  error.code = code;
  return error;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, code) => {
      const number = Number.parseInt(code, 16);
      return Number.isSafeInteger(number) ? String.fromCodePoint(Math.min(number, 0x10ffff)) : '';
    })
    .replace(/&#([0-9]+);?/g, (_, code) => {
      const number = Number.parseInt(code, 10);
      return Number.isSafeInteger(number) ? String.fromCodePoint(Math.min(number, 0x10ffff)) : '';
    })
    .replace(/&(?:amp|lt|gt|quot|apos|#39);/gi, (entity) => ({
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'",
    }[entity.toLowerCase()] ?? entity));
}

function parseTag(token) {
  const match = token.match(/^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)([\s\S]*?)>$/);
  if (!match) return null;
  return {
    closing: match[1] === '/',
    name: match[2].toLowerCase(),
    attributes: match[3].replace(/\/\s*$/, ''),
  };
}

function parseAttributes(source) {
  const attributes = [];
  const pattern = /([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    attributes.push({ name: match[1].toLowerCase(), value: match[2] ?? match[3] ?? match[4] ?? '' });
  }
  return attributes;
}

function safeUrl(rawValue, { kind, allowRemoteImages, allowHttpLinks }) {
  const value = decodeHtmlEntities(String(rawValue).trim());
  if (value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) return { allowed: false, reason: 'empty-or-control-character' };
  if (kind === 'image' && value.toLowerCase().startsWith('cid:')) return { allowed: true, value };
  let parsed;
  try {
    parsed = new URL(value, 'https://invalid.local');
  } catch {
    return { allowed: false, reason: 'invalid-url' };
  }
  const protocol = parsed.protocol.toLowerCase();
  if (!SAFE_PROTOCOLS.has(protocol) || (kind === 'image' && protocol !== 'https:') || (kind === 'image' && !allowRemoteImages)) {
    return { allowed: false, reason: 'protocol-or-resource-policy' };
  }
  if (protocol === 'http:' && !allowHttpLinks && kind === 'link') {
    return { allowed: false, reason: 'insecure-link' };
  }
  if (parsed.username || parsed.password) return { allowed: false, reason: 'embedded-credentials' };
  if (parsed.hostname === 'invalid.local') return { allowed: true, value: parsed.pathname + parsed.search + parsed.hash };
  return { allowed: true, value: parsed.toString() };
}

function safeClass(value) {
  return String(value).split(/\s+/u).filter((token) => /^[A-Za-z0-9_-]{1,64}$/u.test(token)).slice(0, 32).join(' ');
}

function safeDimension(value) {
  return /^(?:[1-9][0-9]{0,3}|0)$/u.test(String(value).trim()) ? String(value).trim() : null;
}

function sanitizeAttributes(tag, attributes, options, metadata) {
  const output = [];
  const seen = new Set();
  let imageBlocked = false;
  let imageAlt = '';
  for (const attribute of attributes) {
    const { name, value } = attribute;
    if (seen.has(name)) continue;
    seen.add(name);
    if (name.startsWith('on') || name === 'style' || name === 'srcdoc' || name === 'formaction' || name === 'ping') {
      metadata.blockedAttributes.push(name);
      continue;
    }
    if (name === 'href' && tag === 'a') {
      const result = safeUrl(value, { kind: 'link', allowRemoteImages: options.allowRemoteImages, allowHttpLinks: options.allowHttpLinks });
      if (!result.allowed) {
        metadata.blockedResources.push({ kind: 'link', reason: result.reason });
        continue;
      }
      output.push(['href', result.value]);
      continue;
    }
    if (name === 'src' && tag === 'img') {
      const result = safeUrl(value, { kind: 'image', allowRemoteImages: options.allowRemoteImages, allowHttpLinks: options.allowHttpLinks });
      if (!result.allowed) {
        imageBlocked = true;
        metadata.blockedResources.push({ kind: 'image', reason: result.reason });
        continue;
      }
      output.push(['src', result.value]);
      continue;
    }
    if (name === 'alt' && tag === 'img') {
      imageAlt = String(value).slice(0, 512);
      output.push(['alt', imageAlt]);
      continue;
    }
    if (name === 'target' && tag === 'a' && value === '_blank') {
      output.push(['target', '_blank']);
      output.push(['rel', 'noopener noreferrer nofollow']);
      continue;
    }
    if (name === 'rel' && tag === 'a') continue;
    if (name === 'class') {
      const safeValue = safeClass(value);
      if (safeValue) output.push(['class', safeValue]);
      continue;
    }
    if (name === 'id' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value)) {
      output.push(['id', value]);
      continue;
    }
    if (name === 'title' || name === 'dir' || name === 'lang' || name === 'role' || name === 'scope') {
      if (value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)) output.push([name, value]);
      continue;
    }
    if (name === 'width' || name === 'height' || name === 'colspan' || name === 'rowspan') {
      const safeValue = safeDimension(value);
      if (safeValue) output.push([name, safeValue]);
      continue;
    }
    if (name === 'loading' && tag === 'img' && (value === 'lazy' || value === 'eager')) {
      output.push(['loading', value]);
      continue;
    }
    if (name.startsWith('aria-') && /^[A-Za-z0-9 _.,:;()'"!?/-]{0,256}$/u.test(value)) {
      output.push([name, value]);
      continue;
    }
    metadata.blockedAttributes.push(name);
  }
  if (tag === 'img' && imageBlocked) {
    metadata.remoteImagesBlocked += 1;
    output.push(['data-gulogulo-remote-image-blocked', 'true']);
    if (!output.some(([name]) => name === 'alt')) output.push(['alt', imageAlt || 'Remote image blocked']);
  }
  return output.map(([name, value]) => `${name}="${escapeHtml(value)}"`).join(' ');
}

function appendText(text, htmlParts, textParts) {
  htmlParts.push(escapeHtml(text));
  textParts.push(decodeHtmlEntities(text));
}

/**
 * Sanitize untrusted email HTML into a deliberately small rendering subset.
 * Scripts, active content, CSS, forms, remote images (by default), unsafe
 * protocols, event handlers, and unknown attributes never reach the browser.
 */
export function sanitizeEmailHtml(input, {
  allowRemoteImages = false,
  allowHttpLinks = false,
  maxInputBytes = 1_048_576,
  maxOutputBytes = 1_048_576,
} = {}) {
  if (typeof input !== 'string') throw contentError('HTML input must be a string', 'INVALID_INPUT');
  if (Buffer.byteLength(input, 'utf8') > maxInputBytes) throw contentError('HTML input exceeds the rendering limit', 'CONTENT_TOO_LARGE');
  const metadata = {
    mode: 'constrained',
    allowedElements: Object.freeze([...ALLOWED_ELEMENTS].sort()),
    blockedElements: [],
    blockedAttributes: [],
    blockedResources: [],
    remoteImagesBlocked: 0,
    truncated: false,
  };
  const htmlParts = [];
  const textParts = [];
  const openElements = [];
  const blockedElements = [];
  const tokens = input.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][^>]*>|[^<]+/g) ?? [];
  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<!')) continue;
    const tag = token.startsWith('<') ? parseTag(token) : null;
    if (!tag) {
      if (blockedElements.length === 0) appendText(token, htmlParts, textParts);
      continue;
    }
    if (blockedElements.length > 0) {
      if (tag.closing && tag.name === blockedElements.at(-1)) blockedElements.pop();
      continue;
    }
    if (BLOCKED_ELEMENTS.has(tag.name)) {
      metadata.blockedElements.push(tag.name);
      if (!tag.closing && !token.endsWith('/>')) blockedElements.push(tag.name);
      continue;
    }
    if (!ALLOWED_ELEMENTS.has(tag.name)) {
      metadata.blockedElements.push(tag.name);
      continue;
    }
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
    if (tag.name === 'br') textParts.push('\n');
    if (BLOCK_ELEMENTS.has(tag.name)) textParts.push('\n');
    if (!VOID_ELEMENTS.has(tag.name) && !token.endsWith('/>')) openElements.push(tag.name);
  }
  for (const tag of openElements.reverse()) htmlParts.push(`</${tag}>`);
  const html = htmlParts.join('');
  if (Buffer.byteLength(html, 'utf8') > maxOutputBytes) throw contentError('sanitized HTML exceeds the rendering limit', 'CONTENT_TOO_LARGE');
  const text = textParts.join('').replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
  return Object.freeze({
    html,
    text,
    metadata: Object.freeze({
      ...metadata,
      blockedElements: Object.freeze([...new Set(metadata.blockedElements)]),
      blockedAttributes: Object.freeze([...new Set(metadata.blockedAttributes)]),
      blockedResources: Object.freeze(metadata.blockedResources.map((item) => Object.freeze({ ...item }))),
    }),
  });
}

export { contentError };
