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
  calendarPath: '/calendar/events',
  contactsPath: '/contacts',
  caldavDiscoveryPath: '/discovery/caldav',
  carddavDiscoveryPath: '/discovery/carddav',
  locale: 'en',
});

const FOLDER_LABELS = Object.freeze({
  inbox: 'Inbox',
  starred: 'Starred',
  sent: 'Sent',
  drafts: 'Drafts',
  trash: 'Trash',
});

const VIEW_LABELS = Object.freeze({
  mail: 'Mail',
  calendar: 'Calendar',
  contacts: 'Contacts',
});

const DISCOVERY_PATHS = Object.freeze({
  calendar: 'caldavDiscoveryPath',
  contacts: 'carddavDiscoveryPath',
});

const REALTIME_METADATA_KEYS = new Set([
  'eventId',
  'eventType',
  'type',
  'version',
  'source',
  'tenantId',
  'userId',
  'resourceId',
  'resource',
  'messageId',
  'calendarId',
  'contactId',
  'folder',
  'mailbox',
  'operation',
  'status',
  'sequence',
  'occurredAt',
  'changedAt',
]);

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
const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type AuthenticatedSession = Readonly<{
  authenticated: true;
  csrfToken: string;
  user: Readonly<{ email: string; [key: string]: unknown }>;
}>;

type AuthenticationView = 'signed-in' | 'signed-out';

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function readAuthenticatedSession(payload: unknown): AuthenticatedSession | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const candidate = payload as Record<string, unknown>;
  const user = candidate.user;
  if (!user || typeof user !== 'object' || Array.isArray(user)) return undefined;
  const email = asString((user as Record<string, unknown>).email).trim();
  const csrfToken = asString(candidate.csrfToken);
  if (!email || !CSRF_TOKEN_PATTERN.test(csrfToken) || candidate.authenticated === false) return undefined;
  return Object.freeze({
    authenticated: true,
    csrfToken,
    user: Object.freeze({ ...(user as Record<string, unknown>), email }),
  });
}

function renderAuthenticationView(documentRef: Document, authenticated: boolean): AuthenticationView {
  const loginShell = documentRef.querySelector<HTMLElement>('#login-shell');
  const appShell = documentRef.querySelector<HTMLElement>('#app-shell');
  const skipLink = documentRef.querySelector<HTMLAnchorElement>('#skip-link');
  if (loginShell) loginShell.hidden = authenticated;
  if (appShell) appShell.hidden = !authenticated;
  if (skipLink) {
    skipLink.href = authenticated ? '#main-content' : '#login-form';
    skipLink.textContent = authenticated ? 'Skip to main content' : 'Skip to sign in';
  }
  if (documentRef.body) documentRef.body.dataset.authState = authenticated ? 'signed-in' : 'signed-out';
  return authenticated ? 'signed-in' : 'signed-out';
}

function parseRealtimeMetadata(value) {
  let payload;
  try {
    payload = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return undefined;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }

  const metadata = {};
  for (const key of REALTIME_METADATA_KEYS) {
    const candidate = payload[key];
    if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') {
      metadata[key] = candidate;
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
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
  // eslint-disable-next-line no-unsanitized/property -- parses into a detached, inert template; the walker below strips dangerous nodes/attributes before anything reaches the live DOM
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
    calendarPath: asString(body?.dataset?.calendarPath, DEFAULT_WEB_CONFIG.calendarPath),
    contactsPath: asString(body?.dataset?.contactsPath, DEFAULT_WEB_CONFIG.contactsPath),
    caldavDiscoveryPath: asString(body?.dataset?.caldavDiscoveryPath, DEFAULT_WEB_CONFIG.caldavDiscoveryPath),
    carddavDiscoveryPath: asString(body?.dataset?.carddavDiscoveryPath, DEFAULT_WEB_CONFIG.carddavDiscoveryPath),
  });
}

function createApiClient({ fetchFn = globalThis.fetch, documentRef = globalThis.document, config = DEFAULT_WEB_CONFIG } = {}) {
  const csrfElement = () => documentRef?.querySelector?.('meta[name="csrf-token"]');
  const csrfToken = () => asString(csrfElement()?.content);
  const base = config.apiBase.replace(/\/$/, '');

  function setCsrfToken(value: unknown): boolean {
    const element = csrfElement();
    if (!element) return false;
    const token = asString(value);
    element.content = CSRF_TOKEN_PATTERN.test(token) ? token : '';
    return element.content.length > 0;
  }

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
    const responseToken = payload?.csrfToken ?? response.headers?.get?.('x-csrf-token');
    if (responseToken !== undefined) setCsrfToken(responseToken);
    return payload;
  }

  return Object.freeze({ request, setCsrfToken });
}

function createEventStream({
  windowRef = globalThis,
  path = DEFAULT_WEB_CONFIG.eventsPath,
  onMail,
  onCalendar,
  onContacts,
  onState,
} = {}) {
  const EventSourceRef = windowRef.EventSource;
  if (typeof EventSourceRef !== 'function') {
    onState?.('unsupported');
    return Object.freeze({ close() {} });
  }

  const source = new EventSourceRef(path, { withCredentials: true });
  source.addEventListener('open', () => onState?.('connected'));
  source.addEventListener('error', () => onState?.('error'));
  const metadataEvent = (callback) => (event) => {
    const metadata = parseRealtimeMetadata(event.data);
    if (!metadata) {
      onState?.('error');
      return;
    }
    callback?.(metadata);
  };
  source.addEventListener('mail.new', metadataEvent(onMail));
  source.addEventListener('calendar.changed', metadataEvent(onCalendar));
  source.addEventListener('contacts.changed', metadataEvent(onContacts));
  return Object.freeze({ close: () => source.close() });
}

function createWebApplication(documentRef = globalThis.document, windowRef = globalThis, injected = {}) {
  const config = { ...buildWebConfig(documentRef), ...injected };
  const api = injected.api ?? createApiClient({ fetchFn: windowRef.fetch?.bind(windowRef), documentRef, config });
  const state = {
    authentication: 'checking',
    activeView: 'mail',
    activeFolder: 'inbox',
    messages: [],
    calendarEvents: [],
    contacts: [],
    selectedMessage: undefined,
    timeZone: readManualTimeZone(windowRef) ?? detectBrowserTimeZone(windowRef),
    account: undefined,
    eventStream: undefined,
  };

  const get = (selector) => documentRef.querySelector(selector);
  const status = get('#app-status');
  const listState = get('#list-state');
  const connectionState = get('#connection-state');

  function setLoginBusy(busy) {
    const form = get('#login-form');
    const submit = get('#login-submit');
    if (form) form.setAttribute('aria-busy', String(busy));
    if (submit) submit.disabled = busy;
  }

  function setLoginError(message = '') {
    const error = get('#login-error');
    if (!error) return;
    error.textContent = message;
    error.hidden = !message;
  }

  function showLogin({ message = '', focus = true } = {}) {
    state.authentication = 'signed-out';
    state.account = undefined;
    state.eventStream?.close();
    state.eventStream = undefined;
    api.setCsrfToken?.('');
    renderAuthenticationView(documentRef, false);
    setLoginBusy(false);
    setLoginError(message);
    const password = get('#login-password');
    if (password) password.value = '';
    if (focus) {
      const target = message ? get('#login-error') : get('#login-email');
      target?.focus?.();
    }
  }

  function startEventStream() {
    if (state.eventStream) return;
    state.eventStream = createEventStream({
      windowRef,
      path: config.eventsPath,
      onState: setConnectionState,
      onMail: () => void loadFolder(state.activeFolder),
      onCalendar: () => {
        if (state.activeView === 'calendar') void loadCalendar();
        else announce('Calendar changed. Open Calendar to refresh the view.');
      },
      onContacts: () => {
        if (state.activeView === 'contacts') void loadContacts();
        else announce('Contacts changed. Open Contacts to refresh the view.');
      },
    });
  }

  async function enterWorkspace(payload, { focus = true } = {}) {
    const session = readAuthenticatedSession(payload);
    if (!session) throw new Error('The authentication response was incomplete.');
    api.setCsrfToken?.(session.csrfToken);
    state.authentication = 'signed-in';
    state.account = session.user;
    get('#account-label').textContent = session.user.email;
    get('#account-name').textContent = session.user.email;
    setLoginError('');
    setLoginBusy(false);
    renderAuthenticationView(documentRef, true);
    startEventStream();
    await loadFolder('inbox');
    if (focus) get('#main-content')?.focus?.();
  }

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

  function renderDiscoveryStatus(view, discovery, { checked = true, error = false } = {}) {
    const service = view === 'calendar' ? 'CalDAV' : 'CardDAV';
    const status = get(`#${view}-discovery-status`);
    const manual = get(`#${view}-manual-status`);
    if (!status || !manual || !checked) return;

    status.dataset.state = error ? 'error' : 'pending';
    if (error) {
      status.textContent = `Automatic ${service} discovery is unavailable right now.`;
      manual.dataset.configState = 'manual-fallback';
      manual.textContent = 'Manual configuration remains the fallback; this browser shell does not collect DAV credentials.';
      return;
    }

    const ready = discovery?.available === true || discovery?.status === 'ready' || discovery?.status === 'available';
    const unavailable = discovery?.available === false || discovery?.status === 'unavailable' || discovery?.status === 'error';
    if (ready) {
      status.dataset.state = 'ready';
      status.textContent = `Automatic ${service} discovery is available.`;
    } else if (unavailable) {
      status.dataset.state = 'error';
      status.textContent = `Automatic ${service} discovery is unavailable.`;
    } else {
      status.textContent = `Automatic ${service} discovery responded without a readiness state.`;
    }
    manual.dataset.configState = 'manual-fallback';
    manual.textContent = 'Manual configuration remains available through the authenticated server API; credentials stay server-side.';
  }

  function renderCalendarEvents(events = []) {
    const list = get('#calendar-list');
    const listState = get('#calendar-list-state');
    if (!list || !listState) return;
    list.replaceChildren();
    listState.dataset.tone = '';
    const safeEvents = Array.isArray(events) ? events.filter((event) => event && typeof event === 'object') : [];
    if (!safeEvents.length) {
      listState.textContent = 'No calendar events were returned by the server.';
      return;
    }
    listState.textContent = `${safeEvents.length} event${safeEvents.length === 1 ? '' : 's'}`;
    for (const event of safeEvents) {
      const item = documentRef.createElement('li');
      item.className = 'module-list-item';
      const title = documentRef.createElement('strong');
      title.textContent = asString(event.summary ?? event.title, 'Untitled event');
      item.append(title);
      const start = asString(event.start ?? event.startDate);
      if (start) {
        const time = documentRef.createElement('time');
        time.dateTime = start;
        time.textContent = formatDateTime(start, state.timeZone, config.locale);
        item.append(time);
      }
      const location = asString(event.location);
      if (location) {
        const details = documentRef.createElement('span');
        details.textContent = location;
        item.append(details);
      }
      list.append(item);
    }
  }

  function renderContacts(contacts = []) {
    const list = get('#contacts-list');
    const listState = get('#contacts-list-state');
    if (!list || !listState) return;
    list.replaceChildren();
    listState.dataset.tone = '';
    const safeContacts = Array.isArray(contacts) ? contacts.filter((contact) => contact && typeof contact === 'object') : [];
    if (!safeContacts.length) {
      listState.textContent = 'No contacts were returned by the server.';
      return;
    }
    listState.textContent = `${safeContacts.length} contact${safeContacts.length === 1 ? '' : 's'}`;
    for (const contact of safeContacts) {
      const item = documentRef.createElement('li');
      item.className = 'module-list-item';
      const name = documentRef.createElement('strong');
      name.textContent = asString(contact.displayName ?? contact.name, 'Unnamed contact');
      item.append(name);
      const email = asString(contact.email ?? contact.emailAddress);
      if (email) {
        const details = documentRef.createElement('span');
        details.textContent = email;
        item.append(details);
      }
      const organization = asString(contact.organization ?? contact.organizationName);
      if (organization) {
        const details = documentRef.createElement('span');
        details.textContent = organization;
        item.append(details);
      }
      list.append(item);
    }
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
      button.addEventListener('click', () => void selectMessage(message));
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

  async function loadCalendar() {
    const listState = get('#calendar-list-state');
    if (listState) {
      listState.dataset.tone = '';
      listState.textContent = 'Loading calendar events…';
    }
    try {
      const payload = await api.request(config.calendarPath);
      state.calendarEvents = Array.isArray(payload?.events) ? payload.events : [];
      renderCalendarEvents(state.calendarEvents);
      if (payload?.discovery !== undefined) renderDiscoveryStatus('calendar', payload.discovery);
      announce('Calendar updated.');
    } catch (error) {
      state.calendarEvents = [];
      renderCalendarEvents(state.calendarEvents);
      if (listState) {
        listState.textContent = 'Calendar events could not be loaded.';
        listState.dataset.tone = 'error';
      }
      announce(asString(error?.message, 'Calendar events could not be loaded.'), 'error');
    }
  }

  async function loadContacts() {
    const listState = get('#contacts-list-state');
    if (listState) {
      listState.dataset.tone = '';
      listState.textContent = 'Loading contacts…';
    }
    try {
      const payload = await api.request(config.contactsPath);
      state.contacts = Array.isArray(payload?.contacts) ? payload.contacts : [];
      renderContacts(state.contacts);
      if (payload?.discovery !== undefined) renderDiscoveryStatus('contacts', payload.discovery);
      announce('Contacts updated.');
    } catch (error) {
      state.contacts = [];
      renderContacts(state.contacts);
      if (listState) {
        listState.textContent = 'Contacts could not be loaded.';
        listState.dataset.tone = 'error';
      }
      announce(asString(error?.message, 'Contacts could not be loaded.'), 'error');
    }
  }

  async function checkDiscovery(view) {
    const pathKey = DISCOVERY_PATHS[view];
    if (!pathKey) return;
    const status = get(`#${view}-discovery-status`);
    const button = get(`#${view}-discovery-button`);
    if (status) {
      status.dataset.state = 'pending';
      status.textContent = `Checking automatic ${view === 'calendar' ? 'CalDAV' : 'CardDAV'} discovery…`;
    }
    if (button) button.disabled = true;
    try {
      const payload = await api.request(config[pathKey]);
      renderDiscoveryStatus(view, payload, { checked: true });
    } catch {
      renderDiscoveryStatus(view, undefined, { checked: true, error: true });
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function setView(view = 'mail') {
    const nextView = VIEW_LABELS[view] ? view : 'mail';
    state.activeView = nextView;
    for (const button of documentRef.querySelectorAll('[data-view]')) {
      const active = button.dataset.view === nextView;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    for (const panel of documentRef.querySelectorAll('[data-view-panel]')) {
      const active = panel.dataset.viewPanel === nextView;
      panel.hidden = !active;
      panel.setAttribute('aria-hidden', String(!active));
    }
    if (nextView === 'mail') await loadFolder(state.activeFolder);
    if (nextView === 'calendar') await loadCalendar();
    if (nextView === 'contacts') await loadContacts();
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

  async function submitLogin(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const data = new FormData(form);
    setLoginError('');
    setLoginBusy(true);
    try {
      const payload = await api.request('/session/login', {
        method: 'POST',
        body: {
          email: asString(data.get('email')).trim(),
          password: asString(data.get('password')),
          rememberMe: data.get('rememberMe') === 'on',
        },
      });
      await enterWorkspace(payload);
      form.reset();
    } catch (error) {
      const message = error?.status === 429
        ? 'Sign-in is temporarily unavailable. Wait a moment and try again.'
        : 'Sign-in failed. Check your details and try again.';
      showLogin({ message });
    }
  }

  function bindEvents() {
    get('#login-form')?.addEventListener('submit', submitLogin);
    get('#compose-button')?.addEventListener('click', () => get('#compose-dialog')?.showModal());
    get('#preferences-button')?.addEventListener('click', () => get('#preferences-dialog')?.showModal());
    get('#compose-form')?.addEventListener('submit', submitCompose);
    get('#preferences-form')?.addEventListener('submit', submitPreferences);
    get('#logout-button')?.addEventListener('click', async () => {
      try { await api.request('/session/logout', { method: 'POST', body: {} }); } catch { /* logout remains local below */ }
      showLogin();
    });
    get('#search-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void loadFolder(state.activeFolder, asString(new FormData(event.currentTarget).get('query')).trim());
    });
    for (const button of documentRef.querySelectorAll('[data-folder]')) {
      button.addEventListener('click', () => void loadFolder(button.dataset.folder));
    }
    for (const button of documentRef.querySelectorAll('[data-view]')) {
      button.addEventListener('click', () => void setView(button.dataset.view));
    }
    get('#calendar-refresh-button')?.addEventListener('click', () => void loadCalendar());
    get('#contacts-refresh-button')?.addEventListener('click', () => void loadContacts());
    get('#calendar-discovery-button')?.addEventListener('click', () => void checkDiscovery('calendar'));
    get('#contacts-discovery-button')?.addEventListener('click', () => void checkDiscovery('contacts'));
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
    setLoginBusy(true);
    documentRef.body.dataset.authState = 'checking';
    try {
      const payload = await api.request('/session');
      await enterWorkspace(payload, { focus: false });
    } catch {
      // A missing or invalid server-side session returns to the credential form.
      showLogin({ focus: false });
    }
    return Object.freeze({ state, loadFolder, loadCalendar, loadContacts, setView, selectMessage, showLogin, close: () => state.eventStream?.close() });
  }

  return Object.freeze({ state, start, loadFolder, loadCalendar, loadContacts, setView, selectMessage, sanitiseMessageHtml });
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
  parseRealtimeMetadata,
  readAuthenticatedSession,
  renderAuthenticationView,
  sanitiseMessageHtml,
};

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const application = createWebApplication(document, window);
  void application.start();
}
