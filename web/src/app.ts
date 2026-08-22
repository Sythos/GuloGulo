/*
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
*/

// The shell deliberately stays JavaScript-compatible while the API contracts
// settle. The compiler still emits and syntax-checks this module; stricter
// shared types will be introduced with the stable API contract.
// @ts-nocheck

/* @gulogulo-browser-source */

const DEFAULT_WEB_CONFIG = Object.freeze({
  apiBase: '/api',
  eventsPath: '/api/events',
  locale: 'en',
});

const FOLDER_LABELS = Object.freeze({
  inbox: 'Inbox',
  starred: 'Starred',
  sent: 'Sent',
  drafts: 'Drafts',
  trash: 'Trash',
});

const DANGEROUS_ELEMENTS = new Set([
  'base',
  'embed',
  'form',
  'iframe',
  'object',
  'script',
  'style',
  'svg',
  'template',
]);

const SAFE_URL_PROTOCOLS = new Set(['cid:', 'https:', 'mailto:']);

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function normaliseTimeZone(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    return undefined;
  }

  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return value;
  } catch {
    return undefined;
  }
}

function detectBrowserTimeZone(windowRef = globalThis) {
  try {
    return normaliseTimeZone(windowRef.Intl?.DateTimeFormat?.().resolvedOptions?.().timeZone) ?? 'UTC';
  } catch {
    return 'UTC';
  }
}

function readManualTimeZone(windowRef = globalThis) {
  try {
    return normaliseTimeZone(windowRef.localStorage?.getItem('gulogulo.timezone'));
  } catch {
    return undefined;
  }
}

function writeManualTimeZone(windowRef, timeZone) {
  try {
    if (timeZone === 'auto' || !timeZone) {
      windowRef.localStorage?.removeItem('gulogulo.timezone');
    } else {
      windowRef.localStorage?.setItem('gulogulo.timezone', timeZone);
    }
  } catch {
    // Storage is an optional preference, never an authentication boundary.
  }
}

function formatDateTime(value, timeZone, locale = 'en') {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return 'Unknown date';
  }

  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function formatMessageTime(message, userTimeZone, locale = 'en') {
  const local = formatDateTime(message?.date, userTimeZone, locale);
  const senderTimeZone = normaliseTimeZone(message?.senderTimeZone);
  if (!senderTimeZone || senderTimeZone === userTimeZone) {
    return local;
  }

  return `${local} (${formatDateTime(message?.date, senderTimeZone, locale)})`;
}

function sanitiseUrl(value) {
  const candidate = asString(value).trim();
  try {
    const url = new URL(candidate, 'https://gulogulo.invalid');
    if (url.origin === 'https://gulogulo.invalid' && !candidate.startsWith('/')) {
      return undefined;
    }
    if (!SAFE_URL_PROTOCOLS.has(url.protocol)) {
      return undefined;
    }
    return candidate;
  } catch {
    return undefined;
  }
}

function sanitiseMessageHtml(html, documentRef = globalThis.document) {
  if (!documentRef?.createElement) {
    return undefined;
  }

  const template = documentRef.createElement('template');
  template.innerHTML = asString(html);
  const walker = documentRef.createTreeWalker(template.content, 1);
  const nodes = [];
  let current = walker.nextNode();
  while (current) {
    nodes.push(current);
    current = walker.nextNode();
  }

  for (const node of nodes) {
    const name = asString(node.nodeName).toLowerCase();
    if (DANGEROUS_ELEMENTS.has(name)) {
      node.remove();
      continue;
    }

    for (const attribute of [...node.attributes]) {
      const attributeName = attribute.name.toLowerCase();
      if (attributeName.startsWith('on') || attributeName === 'style' || attributeName === 'srcdoc') {
        node.removeAttribute(attribute.name);
      }
    }

    for (const attributeName of ['href', 'src', 'cite', 'action']) {
      if (!node.hasAttribute(attributeName)) {
        continue;
      }
      const safeValue = sanitiseUrl(node.getAttribute(attributeName));
      if (!safeValue) {
        node.removeAttribute(attributeName);
      } else {
        node.setAttribute(attributeName, safeValue);
      }
    }

    if (name === 'a' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  }

  return template.content;
}

function buildWebConfig(documentRef = globalThis.document) {
  const body = documentRef?.body;
  return Object.freeze({
    ...DEFAULT_WEB_CONFIG,
    apiBase: asString(body?.dataset?.apiBase, DEFAULT_WEB_CONFIG.apiBase),
    eventsPath: asString(body?.dataset?.eventsPath, DEFAULT_WEB_CONFIG.eventsPath),
  });
}

function createApiClient({ fetchFn = globalThis.fetch, documentRef = globalThis.document, config = DEFAULT_WEB_CONFIG } = {}) {
  const csrfToken = () => asString(documentRef?.querySelector?.('meta[name="csrf-token"]')?.content);
  const base = config.apiBase.replace(/\/$/, '');

  async function request(path, options = {}) {
    const method = asString(options.method, 'GET').toUpperCase();
    const headers = new Headers(options.headers ?? {});
    headers.set('accept', 'application/json');
    if (method !== 'GET' && method !== 'HEAD') {
      headers.set('content-type', 'application/json');
      const token = csrfToken();
      if (token) {
        headers.set('x-csrf-token', token);
      }
    }

    const response = await fetchFn(`${base}${path.startsWith('/') ? path : `/${path}`}`, {
      ...options,
      method,
      headers,
      credentials: 'include',
      body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
    });
    const contentType = response.headers?.get?.('content-type') ?? '';
    const payload = contentType.includes('json') ? await response.json() : undefined;
    if (!response.ok) {
      const error = new Error(asString(payload?.message, `Request failed with HTTP ${response.status}`));
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  return Object.freeze({ request });
}

function createEventStream({ windowRef = globalThis, path = DEFAULT_WEB_CONFIG.eventsPath, onMail, onState } = {}) {
  const EventSourceRef = windowRef.EventSource;
  if (typeof EventSourceRef !== 'function') {
    onState?.('unsupported');
    return Object.freeze({ close() {} });
  }

  const source = new EventSourceRef(path, { withCredentials: true });
  source.addEventListener('open', () => onState?.('connected'));
  source.addEventListener('error', () => onState?.('error'));
  source.addEventListener('mail.new', (event) => {
    try {
      onMail?.(JSON.parse(event.data));
    } catch {
      onState?.('error');
    }
  });
  return Object.freeze({ close: () => source.close() });
}

function createWebApplication(documentRef = globalThis.document, windowRef = globalThis, injected = {}) {
  const config = { ...buildWebConfig(documentRef), ...injected };
  const api = injected.api ?? createApiClient({ fetchFn: windowRef.fetch?.bind(windowRef), documentRef, config });
  const state = {
    activeFolder: 'inbox',
    messages: [],
    selectedMessage: undefined,
    timeZone: readManualTimeZone(windowRef) ?? detectBrowserTimeZone(windowRef),
    account: undefined,
    eventStream: undefined,
  };

  const get = (selector) => documentRef.querySelector(selector);
  const status = get('#app-status');
  const listState = get('#list-state');
  const connectionState = get('#connection-state');

  function announce(message, tone = 'info') {
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
    status.hidden = !message;
  }

  function setConnectionState(value) {
    if (!connectionState) return;
    const labels = { connected: 'Live updates connected', error: 'Live updates unavailable', unsupported: 'Live updates unavailable' };
    connectionState.textContent = labels[value] ?? 'Connecting…';
    connectionState.dataset.state = value;
  }

  function renderTimeZone() {
    const readout = get('#timezone-readout');
    if (readout) readout.textContent = state.timeZone;
    const help = get('#timezone-help');
    if (help) help.textContent = `Times are shown in ${state.timeZone}. The sender's local equivalent is shown in parentheses when it differs.`;
  }

  function renderMessages() {
    const list = get('#message-list');
    if (!list) return;
    list.replaceChildren();
    if (!state.messages.length) {
      if (listState) listState.textContent = 'No messages in this folder.';
      return;
    }
    if (listState) listState.textContent = `${state.messages.length} message${state.messages.length === 1 ? '' : 's'}`;

    for (const message of state.messages) {
      const item = documentRef.createElement('li');
      item.className = 'message-list-item';
      const button = documentRef.createElement('button');
      button.type = 'button';
      button.className = message.id === state.selectedMessage?.id ? 'is-selected' : '';
      if (message.unread) button.classList.add('is-unread');
      button.dataset.messageId = asString(message.id);
      const sender = documentRef.createElement('span');
      sender.className = 'message-sender';
      sender.textContent = asString(message.from, 'Unknown sender');
      const date = documentRef.createElement('time');
      date.className = 'message-list-date';
      date.dateTime = asString(message.date);
      date.textContent = formatMessageTime(message, state.timeZone, config.locale);
      const subject = documentRef.createElement('span');
      subject.className = 'message-subject';
      subject.textContent = asString(message.subject, '(No subject)');
      const preview = documentRef.createElement('span');
      preview.className = 'message-preview';
      preview.textContent = asString(message.preview);
      button.append(sender, date, subject, preview);
      button.addEventListener('click', () => selectMessage(message));
      item.append(button);
      list.append(item);
    }
  }

  function renderMessage(message) {
    const empty = get('#message-empty');
    const content = get('#message-content');
    if (!message) {
      if (empty) empty.hidden = false;
      if (content) content.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;
    if (content) content.hidden = false;
    get('#message-folder-label').textContent = FOLDER_LABELS[state.activeFolder] ?? 'Mail';
    get('#message-subject').textContent = asString(message.subject, '(No subject)');
    get('#message-from').textContent = asString(message.from, 'Unknown sender');
    get('#message-to').textContent = asString(message.to, 'Unknown recipient');
    const date = get('#message-date');
    date.dateTime = asString(message.date);
    date.textContent = formatMessageTime(message, state.timeZone, config.locale);
    const body = get('#message-body');
    body.replaceChildren();
    const safeFragment = sanitiseMessageHtml(message.html, documentRef);
    if (safeFragment) {
      body.append(safeFragment);
    } else {
      const text = documentRef.createElement('p');
      text.textContent = asString(message.text, 'This message has no displayable body.');
      body.append(text);
    }
    renderAttachments(message.attachments);
  }

  function renderAttachments(attachments = []) {
    const section = get('#attachment-section');
    const list = get('#attachment-list');
    if (!section || !list) return;
    list.replaceChildren();
    const safeAttachments = Array.isArray(attachments) ? attachments.filter((item) => item && typeof item === 'object') : [];
    section.hidden = safeAttachments.length === 0;
    for (const attachment of safeAttachments) {
      const item = documentRef.createElement('li');
      const link = documentRef.createElement('a');
      const url = sanitiseUrl(attachment.downloadUrl);
      if (!url) continue;
      link.href = url;
      link.textContent = `${asString(attachment.name, 'Attachment')} (${asString(attachment.contentType, 'file')})`;
      link.setAttribute('download', '');
      item.append(link);
      list.append(item);
    }
  }

  async function loadFolder(folder = state.activeFolder, query = '') {
    state.activeFolder = folder;
    for (const button of documentRef.querySelectorAll('[data-folder]')) {
      const active = button.dataset.folder === folder;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    get('#active-folder-label').textContent = FOLDER_LABELS[folder] ?? 'Mail';
    if (listState) listState.textContent = 'Loading messages…';
    try {
      const path = query ? `/mail/search?q=${encodeURIComponent(query)}` : `/mail/folders/${encodeURIComponent(folder)}`;
      const payload = await api.request(path);
      state.messages = Array.isArray(payload?.messages) ? payload.messages : [];
      renderMessages();
      announce('Messages updated.');
    } catch (error) {
      state.messages = [];
      renderMessages();
      if (listState) {
        listState.textContent = 'Messages could not be loaded.';
        listState.dataset.tone = 'error';
      }
      announce(asString(error?.message, 'Messages could not be loaded.'), 'error');
    }
  }

  async function selectMessage(message) {
    state.selectedMessage = message;
    renderMessages();
    renderMessage(message);
    try {
      const payload = await api.request(`/mail/messages/${encodeURIComponent(message.id)}`);
      state.selectedMessage = payload?.message ?? message;
      renderMessage(state.selectedMessage);
    } catch {
      // The list preview remains available when the detail request is unavailable.
    }
  }

  async function submitCompose(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await api.request('/mail/send', {
        method: 'POST',
        body: { to: data.get('to'), subject: data.get('subject'), text: data.get('body') },
      });
      form.reset();
      get('#compose-dialog')?.close();
      announce('Message accepted for delivery.', 'success');
    } catch (error) {
      announce(asString(error?.message, 'Message could not be sent.'), 'error');
    }
  }

  async function submitPreferences(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const selectedTimeZone = asString(data.get('timezone'), 'auto');
    const nextTimeZone = selectedTimeZone === 'auto' ? detectBrowserTimeZone(windowRef) : normaliseTimeZone(selectedTimeZone);
    if (!nextTimeZone) {
      announce('Choose a valid timezone.', 'error');
      return;
    }
    state.timeZone = nextTimeZone;
    writeManualTimeZone(windowRef, selectedTimeZone);
    renderTimeZone();
    renderMessages();
    if (state.selectedMessage) renderMessage(state.selectedMessage);
    try {
      await api.request('/preferences', {
        method: 'POST',
        body: {
          timeZone: selectedTimeZone,
          signature: data.get('signature'),
          vacationEnabled: data.get('vacationEnabled') === 'on',
          vacationMessage: data.get('vacationMessage'),
        },
      });
      get('#preferences-dialog')?.close();
      announce('Preferences saved.', 'success');
    } catch (error) {
      announce(asString(error?.message, 'Preferences could not be saved.'), 'error');
    }
  }

  function bindEvents() {
    get('#compose-button')?.addEventListener('click', () => get('#compose-dialog')?.showModal());
    get('#preferences-button')?.addEventListener('click', () => get('#preferences-dialog')?.showModal());
    get('#compose-form')?.addEventListener('submit', submitCompose);
    get('#preferences-form')?.addEventListener('submit', submitPreferences);
    get('#logout-button')?.addEventListener('click', async () => {
      try { await api.request('/session/logout', { method: 'POST', body: {} }); } catch { /* logout remains local below */ }
      state.eventStream?.close();
      windowRef.location?.assign?.('/login');
    });
    get('#search-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void loadFolder(state.activeFolder, asString(new FormData(event.currentTarget).get('query')).trim());
    });
    for (const button of documentRef.querySelectorAll('[data-folder]')) {
      button.addEventListener('click', () => void loadFolder(button.dataset.folder));
    }
    get('#navigation-toggle')?.addEventListener('click', (event) => {
      const navigation = get('#navigation');
      const open = navigation.classList.toggle('is-open');
      event.currentTarget.setAttribute('aria-expanded', String(open));
    });
    for (const button of documentRef.querySelectorAll('[data-close-dialog]')) {
      button.addEventListener('click', () => get(`#${button.dataset.closeDialog}`)?.close());
    }
    get('#reply-button')?.addEventListener('click', () => {
      const dialog = get('#compose-dialog');
      const message = state.selectedMessage;
      if (!dialog || !message) return;
      get('#compose-to').value = asString(message.from);
      get('#compose-subject').value = `Re: ${asString(message.subject, '')}`.trim();
      dialog.showModal();
    });
    get('#archive-button')?.addEventListener('click', async () => {
      if (!state.selectedMessage) return;
      try {
        await api.request(`/mail/messages/${encodeURIComponent(state.selectedMessage.id)}/archive`, { method: 'POST', body: {} });
        await loadFolder(state.activeFolder);
        renderMessage(undefined);
        announce('Message archived.', 'success');
      } catch (error) {
        announce(asString(error?.message, 'Message could not be archived.'), 'error');
      }
    });
  }

  async function start() {
    renderTimeZone();
    bindEvents();
    state.eventStream = createEventStream({
      windowRef,
      path: config.eventsPath,
      onState: setConnectionState,
      onMail: () => void loadFolder(state.activeFolder),
    });
    try {
      const payload = await api.request('/session');
      state.account = payload?.user;
      const account = asString(state.account?.email, 'Signed-in user');
      get('#account-label').textContent = account;
      get('#account-name').textContent = account;
    } catch {
      // The protected API decides whether the session is valid; do not cache identity locally.
    }
    await loadFolder('inbox');
    return Object.freeze({ state, loadFolder, selectMessage, close: () => state.eventStream?.close() });
  }

  return Object.freeze({ state, start, loadFolder, selectMessage, sanitiseMessageHtml });
}

export {
  buildWebConfig,
  createApiClient,
  createEventStream,
  createWebApplication,
  detectBrowserTimeZone,
  formatDateTime,
  formatMessageTime,
  normaliseTimeZone,
  sanitiseMessageHtml,
};

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const application = createWebApplication(document, window);
  void application.start();
}
