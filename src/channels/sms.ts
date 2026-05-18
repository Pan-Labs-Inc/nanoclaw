/**
 * SMS channel backed by Twilio Programmable Messaging.
 *
 * Conversation model: one E.164 phone number = one non-threaded messaging group.
 * Webhooks are served by the shared NanoClaw webhook server:
 *   POST /webhook/sms
 *   POST /webhook/sms/status
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { getActiveSessions } from '../db/sessions.js';
import { updateDeliveredStatusByPlatformMessageId } from '../db/session-db.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { openInboundDb } from '../session-manager.js';
import { registerWebhookHandler, unregisterWebhookHandler, type WebhookHandler } from '../webhook-server.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const CHANNEL_TYPE = 'sms';
const WEBHOOK_NAME = 'sms';
const TWILIO_MESSAGES_API_VERSION = '2010-04-01';
const TWILIO_ACCOUNT_SID_RE = /^AC[0-9a-fA-F]{32}$/;
const TWILIO_MESSAGING_SERVICE_SID_RE = /^MG[0-9a-fA-F]{32}$/;
const E164_PHONE_RE = /^\+[1-9]\d{7,14}$/;
const SMS_OPT_OUT_STORE_MODE = 0o600;
const DEFAULT_STOP_REPLY =
  'You have been unsubscribed and will no longer receive SMS messages from this assistant. Reply START to resubscribe.';
const DEFAULT_START_REPLY = 'You are opted in to SMS messages from this assistant. Reply STOP to opt out.';
const DEFAULT_HELP_REPLY = 'Reply STOP to opt out. Reply START to opt back in.';
const DEFAULT_CONTROL_STORE_ERROR_REPLY =
  "We couldn't update SMS preferences right now. Please contact the assistant operator.";

type FetchLike = typeof fetch;

export interface SmsConfig {
  accountSid: string;
  authToken: string;
  sender: string;
  webhookUrl?: string;
  statusCallbackUrl?: string;
  validateSignature: boolean;
  optOutStorePath?: string;
  helpMessage?: string;
  validateCredentials?: boolean;
  fetchImpl?: FetchLike;
}

export interface TwilioInbound {
  messageSid: string;
  from: string;
  to: string;
  body: string;
  numMedia: number;
  media: Array<{ url: string; contentType?: string }>;
  optOutType?: string;
}

export interface TwilioStatusCallback {
  sid: string;
  status: string;
  to?: string;
  from?: string;
  errorCode?: string;
  errorMessage?: string;
}

function envValue(env: Record<string, string>, key: string): string | undefined {
  // Runtime env wins over .env so deploy/test overrides can change one value
  // without rewriting the persisted NanoClaw env file.
  return process.env[key] || env[key] || undefined;
}

function envBool(env: Record<string, string>, key: string, fallback: boolean): boolean {
  const raw = envValue(env, key);
  if (raw === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

export function readSmsConfig(): SmsConfig | null {
  const env = readEnvFile([
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_PHONE_NUMBER',
    'TWILIO_FROM_NUMBER',
    'TWILIO_MESSAGING_SERVICE_SID',
    'TWILIO_SMS_WEBHOOK_URL',
    'TWILIO_SMS_STATUS_CALLBACK_URL',
    'TWILIO_STATUS_CALLBACK_URL',
    'TWILIO_VALIDATE_SIGNATURE',
    'TWILIO_SMS_HELP_MESSAGE',
    'NANOCLAW_SMS_ALLOW_PHONE_SENDER',
  ]);

  const accountSid = envValue(env, 'TWILIO_ACCOUNT_SID');
  const authToken = envValue(env, 'TWILIO_AUTH_TOKEN');
  const messagingServiceSid = envValue(env, 'TWILIO_MESSAGING_SERVICE_SID');
  const sender = messagingServiceSid ?? envValue(env, 'TWILIO_PHONE_NUMBER') ?? envValue(env, 'TWILIO_FROM_NUMBER');

  if (!accountSid || !authToken || !sender) return null;
  validateSmsConfigEnv({
    accountSid,
    authToken,
    messagingServiceSid,
    phoneNumber: envValue(env, 'TWILIO_PHONE_NUMBER'),
    fromNumber: envValue(env, 'TWILIO_FROM_NUMBER'),
    sender,
    allowPhoneSender: envBool(env, 'NANOCLAW_SMS_ALLOW_PHONE_SENDER', false),
  });

  const webhookUrl = envValue(env, 'TWILIO_SMS_WEBHOOK_URL');
  const smsStatusUrl = envValue(env, 'TWILIO_SMS_STATUS_CALLBACK_URL');
  const legacyStatusUrl = envValue(env, 'TWILIO_STATUS_CALLBACK_URL');
  const explicitStatusUrl = smsStatusUrl ?? legacyStatusUrl;
  validateHttpUrl(webhookUrl, 'TWILIO_SMS_WEBHOOK_URL');
  validateHttpUrl(smsStatusUrl, 'TWILIO_SMS_STATUS_CALLBACK_URL');
  validateHttpUrl(legacyStatusUrl, 'TWILIO_STATUS_CALLBACK_URL');
  // A Messaging Service is the production path because it can enforce
  // carrier-standard Advanced Opt-Out. Require both public URLs here so runtime
  // startup fails before Twilio can keep using stale Console webhook settings.
  if (messagingServiceSid) {
    if (!webhookUrl) {
      throw new Error('TWILIO_SMS_WEBHOOK_URL is required when TWILIO_MESSAGING_SERVICE_SID is set');
    }
    if (!smsStatusUrl) {
      throw new Error('TWILIO_SMS_STATUS_CALLBACK_URL is required when TWILIO_MESSAGING_SERVICE_SID is set');
    }
  }

  return {
    accountSid,
    authToken,
    sender,
    webhookUrl,
    statusCallbackUrl: explicitStatusUrl ?? statusCallbackUrlFor(webhookUrl),
    validateSignature: envBool(env, 'TWILIO_VALIDATE_SIGNATURE', true),
    helpMessage: envValue(env, 'TWILIO_SMS_HELP_MESSAGE'),
    validateCredentials: true,
  };
}

function validateSmsConfigEnv(config: {
  accountSid: string;
  authToken: string;
  messagingServiceSid?: string;
  phoneNumber?: string;
  fromNumber?: string;
  sender: string;
  allowPhoneSender: boolean;
}): void {
  if (!TWILIO_ACCOUNT_SID_RE.test(config.accountSid)) {
    throw new Error('TWILIO_ACCOUNT_SID must look like AC followed by 32 hex characters');
  }
  if (config.authToken.trim().length < 16) {
    throw new Error('TWILIO_AUTH_TOKEN format invalid');
  }
  if (config.messagingServiceSid && !TWILIO_MESSAGING_SERVICE_SID_RE.test(config.messagingServiceSid)) {
    throw new Error('TWILIO_MESSAGING_SERVICE_SID must look like MG followed by 32 hex characters');
  }
  if (config.phoneNumber && !E164_PHONE_RE.test(config.phoneNumber)) {
    throw new Error('TWILIO_PHONE_NUMBER must be E.164, like +15551234567');
  }
  if (config.fromNumber && !E164_PHONE_RE.test(config.fromNumber)) {
    throw new Error('TWILIO_FROM_NUMBER must be E.164, like +15551234567');
  }
  if (!isValidSmsSender(config.sender)) {
    throw new Error('SMS sender must be a valid Twilio Messaging Service SID or E.164 phone number');
  }
  if (!config.messagingServiceSid && E164_PHONE_RE.test(config.sender) && !config.allowPhoneSender) {
    throw new Error(
      'TWILIO_PHONE_NUMBER is local/dev only; set TWILIO_MESSAGING_SERVICE_SID for production or NANOCLAW_SMS_ALLOW_PHONE_SENDER=true for local/dev',
    );
  }
}

function validateHttpUrl(value: string | undefined, label: string): void {
  if (!value) return;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('bad protocol');
  } catch {
    throw new Error(`${label} must be an absolute http(s) URL`);
  }
}

export function parseTwilioInbound(params: URLSearchParams): TwilioInbound {
  const numMediaRaw = Number.parseInt(params.get('NumMedia') || '0', 10);
  const numMedia = Number.isFinite(numMediaRaw) && numMediaRaw > 0 ? numMediaRaw : 0;
  const media: TwilioInbound['media'] = [];

  for (let i = 0; i < numMedia; i++) {
    const url = params.get(`MediaUrl${i}`);
    if (!url) continue;
    media.push({
      url,
      contentType: params.get(`MediaContentType${i}`) || undefined,
    });
  }

  const inbound: TwilioInbound = {
    messageSid: params.get('MessageSid') || params.get('SmsSid') || `sms-${Date.now()}`,
    from: params.get('From') || '',
    to: params.get('To') || '',
    body: params.get('Body') || '',
    numMedia,
    media,
  };
  const optOutType = params.get('OptOutType');
  if (optOutType) inbound.optOutType = optOutType;
  return inbound;
}

export function parseTwilioStatusCallback(params: URLSearchParams): TwilioStatusCallback {
  return {
    sid: params.get('MessageSid') || params.get('SmsSid') || '',
    status: params.get('MessageStatus') || params.get('SmsStatus') || '',
    to: params.get('To') || undefined,
    from: params.get('From') || undefined,
    errorCode: params.get('ErrorCode') || undefined,
    errorMessage: params.get('ErrorMessage') || undefined,
  };
}

export function twilioInboundToMessage(inbound: TwilioInbound): InboundMessage {
  return {
    id: inbound.messageSid,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    isMention: true,
    isGroup: false,
    content: {
      text: inbound.body,
      sender: inbound.from,
      senderId: inbound.from,
      senderName: inbound.from,
      from: inbound.from,
      to: inbound.to,
      provider: 'twilio',
      media: inbound.media,
      numMedia: inbound.numMedia,
      optOutType: inbound.optOutType,
    },
  };
}

export function extractSmsText(message: OutboundMessage): string | null {
  const content = message.content;
  if (typeof content === 'string') return stripSmsMarkdown(content);
  if (!content || typeof content !== 'object') return null;

  // Other channels can deliver structured cards/questions. SMS cannot, so this
  // is the channel-specific plain-text projection before Twilio delivery.
  const payload = content as Record<string, unknown>;
  if (payload.type === 'ask_question') return stripSmsMarkdown(renderAskQuestion(payload) ?? '');
  if (payload.type === 'card') return stripSmsMarkdown(renderCard(payload) ?? '');

  const text = typeof payload.text === 'string' ? payload.text : undefined;
  const markdown = typeof payload.markdown === 'string' ? payload.markdown : undefined;
  return stripSmsMarkdown(markdown || text || '');
}

function renderAskQuestion(payload: Record<string, unknown>): string | null {
  const title = typeof payload.title === 'string' ? payload.title : '';
  const question = typeof payload.question === 'string' ? payload.question : '';
  const options = Array.isArray(payload.options) ? payload.options : [];
  const renderedOptions = options
    .map((opt, idx) => {
      if (typeof opt === 'string') return `${idx + 1}. ${opt}`;
      if (!opt || typeof opt !== 'object') return null;
      const label = (opt as Record<string, unknown>).label;
      return typeof label === 'string' && label ? `${idx + 1}. ${label}` : null;
    })
    .filter((line): line is string => line !== null);

  const parts = [title, question, renderedOptions.length > 0 ? renderedOptions.join('\n') : ''].filter(Boolean);
  return parts.join('\n\n').trim() || null;
}

function renderCard(payload: Record<string, unknown>): string | null {
  const fallbackText = typeof payload.fallbackText === 'string' ? payload.fallbackText : '';
  if (fallbackText.trim()) return fallbackText.trim();

  const card = payload.card && typeof payload.card === 'object' ? (payload.card as Record<string, unknown>) : {};
  const title = typeof card.title === 'string' ? card.title : '';
  const description = typeof card.description === 'string' ? card.description : '';
  const children = Array.isArray(card.children)
    ? card.children
        .map((child) => {
          if (typeof child === 'string') return child;
          if (!child || typeof child !== 'object') return null;
          const text = (child as Record<string, unknown>).text;
          return typeof text === 'string' ? text : null;
        })
        .filter((line): line is string => line !== null)
    : [];

  return [title, description, ...children].filter(Boolean).join('\n\n').trim() || null;
}

export function stripSmsMarkdown(text: string): string | null {
  const stripped = text
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(^|\s)[*_]{1,3}([^*_]+)[*_]{1,3}(\s|$)/g, '$1$2$3')
    .replace(/[`*_~]/g, '')
    .replace(/^>\s?/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  return stripped || null;
}

export function validateTwilioSignature(
  authToken: string,
  publicUrl: string,
  params: URLSearchParams,
  signature: string | null | undefined,
): boolean {
  if (!signature) return false;

  // Twilio signs the exact public URL plus sorted form parameters. Behind a
  // proxy, publicUrl must match the URL configured in Twilio, not necessarily
  // the local request URL seen by NanoClaw.
  const signedPayload =
    publicUrl +
    [...new Set([...params.keys()])]
      .sort()
      .map((key) => `${key}${params.getAll(key).join('')}`)
      .join('');
  const expected = crypto.createHmac('sha1', authToken).update(signedPayload).digest('base64');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export async function validateTwilioCredentials(config: SmsConfig): Promise<void> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const auth = twilioBasicAuth(config);
  const url = `https://api.twilio.com/${TWILIO_MESSAGES_API_VERSION}/Accounts/${encodeURIComponent(
    config.accountSid,
  )}.json`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Twilio credential validation failed (${response.status}): ${sanitizeSmsText(detail).slice(0, 300)}`,
    );
  }
}

export async function sendTwilioSms(config: SmsConfig, to: string, body: string): Promise<string | undefined> {
  const fetchImpl = config.fetchImpl ?? fetch;
  if (!E164_PHONE_RE.test(to)) {
    throw new Error('SMS recipient must be an E.164 phone number');
  }
  const params = new URLSearchParams({
    To: to,
    Body: body,
  });

  const senderParam = senderParamName(config.sender);
  params.set(senderParam, config.sender);
  if (config.statusCallbackUrl) params.set('StatusCallback', config.statusCallbackUrl);

  const url = `https://api.twilio.com/${TWILIO_MESSAGES_API_VERSION}/Accounts/${encodeURIComponent(
    config.accountSid,
  )}/Messages.json`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${twilioBasicAuth(config)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Twilio SMS send failed (${response.status}): ${sanitizeSmsText(detail).slice(0, 300)}`);
  }

  const json = (await response.json().catch(() => ({}))) as { sid?: string };
  return json.sid;
}

export function createSmsWebhookHandler(config: SmsConfig, hostConfig: ChannelSetup): WebhookHandler {
  return async (request) => {
    const url = new URL(request.url);
    if (request.method !== 'POST') return textResponse('Not found', 404);

    if (url.pathname === '/webhook/sms/status') {
      return handleStatusWebhook(request, config);
    }
    if (url.pathname !== '/webhook/sms') {
      return textResponse('Not found', 404);
    }

    const body = await request.text();
    const params = new URLSearchParams(body);
    if (!verifyRequestSignature(request, config, params, config.webhookUrl)) {
      log.warn('Rejected SMS webhook with invalid Twilio signature', { url: publicRequestUrl(request) });
      return textResponse('Forbidden', 403);
    }

    const inbound = parseTwilioInbound(params);
    if (!inbound.from) return textResponse('Missing From', 400);
    if (!E164_PHONE_RE.test(inbound.from)) return textResponse('Invalid From', 400);

    // Control keywords are handled before agent routing. If Twilio Advanced
    // Opt-Out included OptOutType, Twilio owns the user-facing keyword reply;
    // NanoClaw only mirrors the state locally for outbound suppression.
    const control = handleSmsControlMessage(inbound.from, inbound.body, config, inbound.optOutType);
    if (control) return twimlResponse(control.reply);

    await hostConfig.onInbound(inbound.from, null, twilioInboundToMessage(inbound));
    return twimlResponse();
  };
}

type SmsControlAction = 'stop' | 'start' | 'help';

export function parseSmsControlAction(body: string): SmsControlAction | null {
  const keyword = normalizeSmsControlKeyword(body);
  if (!keyword) return null;
  if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(keyword)) return 'stop';
  if (['START', 'UNSTOP', 'YES'].includes(keyword)) return 'start';
  if (['HELP', 'INFO'].includes(keyword)) return 'help';
  return null;
}

export function parseSmsOptOutType(optOutType: string | null | undefined): SmsControlAction | null {
  const normalized = String(optOutType || '')
    .trim()
    .toUpperCase();
  if (normalized === 'STOP') return 'stop';
  if (normalized === 'START') return 'start';
  if (normalized === 'HELP') return 'help';
  return null;
}

function normalizeSmsControlKeyword(body: string): string | null {
  const keyword = body
    .trim()
    .toUpperCase()
    .replace(/[.!?]+$/g, '');
  if (!keyword || /\s/.test(keyword)) return null;
  return keyword;
}

function handleSmsControlMessage(
  phone: string,
  body: string,
  config: SmsConfig,
  optOutType?: string,
): { action: SmsControlAction; reply?: string } | null {
  const optOutAction = parseSmsOptOutType(optOutType);
  const keyword =
    normalizeSmsControlKeyword(body) ??
    String(optOutType || '')
      .trim()
      .toUpperCase();
  if (!keyword) return null;
  const action = optOutAction ?? parseSmsControlAction(keyword);
  if (!action) return null;
  // Avoid double replies for Twilio-managed HELP/STOP/START. Twilio sends the
  // carrier-compliant response, while NanoClaw records the same event locally.
  const replyHandledByTwilio = !!optOutAction;

  if (action === 'stop') {
    if (!tryRecordSmsControlEvent(phone, action, keyword, config)) {
      return { action, reply: replyHandledByTwilio ? undefined : DEFAULT_CONTROL_STORE_ERROR_REPLY };
    }
    log.info('SMS sender opted out', { phone: redactSmsPhone(phone) });
    return { action, reply: replyHandledByTwilio ? undefined : DEFAULT_STOP_REPLY };
  }
  if (action === 'start') {
    if (!tryRecordSmsControlEvent(phone, action, keyword, config)) {
      return { action, reply: replyHandledByTwilio ? undefined : DEFAULT_CONTROL_STORE_ERROR_REPLY };
    }
    log.info('SMS sender opted in', { phone: redactSmsPhone(phone) });
    return { action, reply: replyHandledByTwilio ? undefined : DEFAULT_START_REPLY };
  }

  tryRecordSmsControlEvent(phone, action, keyword, config);
  return { action, reply: replyHandledByTwilio ? undefined : (config.helpMessage ?? DEFAULT_HELP_REPLY) };
}

interface SmsOptOutStore {
  // Local suppression is a fail-safe mirror of SMS consent state. Twilio remains
  // the carrier-facing enforcement point, but NanoClaw checks this store before
  // every outbound send so STOP works even before a provider-side lookup exists.
  optedOut: Record<string, { optedOutAt: string }>;
  controlEvents: Record<string, { action: SmsControlAction; keyword: string; receivedAt: string }>;
}

export function isSmsOptedOut(phone: string, config: SmsConfig): boolean {
  try {
    return !!readSmsOptOutStore(config).optedOut[normalizePhoneKey(phone)];
  } catch (err) {
    // Consent failures must fail closed: if the suppression file is corrupt or
    // unreadable, sending is riskier than dropping the outbound SMS.
    log.error('SMS opt-out store is unreadable; suppressing outbound SMS fail closed', {
      phone: redactSmsPhone(phone),
      storePath: smsOptOutStorePath(config),
      err,
    });
    return true;
  }
}

export function setSmsOptOut(phone: string, optedOut: boolean, config: SmsConfig): void {
  const key = normalizePhoneKey(phone);
  if (!key) return;
  const store = readSmsOptOutStore(config);
  if (optedOut) {
    store.optedOut[key] = { optedOutAt: new Date().toISOString() };
  } else {
    delete store.optedOut[key];
  }
  writeSmsOptOutStore(config, store);
}

export function getSmsControlEvent(
  phone: string,
  config: SmsConfig,
): { action: SmsControlAction; keyword: string; receivedAt: string } | undefined {
  return readSmsOptOutStore(config).controlEvents[normalizePhoneKey(phone)];
}

function recordSmsControlEvent(phone: string, action: SmsControlAction, keyword: string, config: SmsConfig): void {
  const key = normalizePhoneKey(phone);
  if (!key) return;
  const store = readSmsOptOutStore(config);
  if (action === 'stop') {
    store.optedOut[key] = { optedOutAt: new Date().toISOString() };
  } else if (action === 'start') {
    delete store.optedOut[key];
  }
  store.controlEvents[key] = {
    action,
    keyword,
    receivedAt: new Date().toISOString(),
  };
  writeSmsOptOutStore(config, store);
}

function tryRecordSmsControlEvent(
  phone: string,
  action: SmsControlAction,
  keyword: string,
  config: SmsConfig,
): boolean {
  try {
    recordSmsControlEvent(phone, action, keyword, config);
    return true;
  } catch (err) {
    log.error('SMS control store is unreadable; could not record SMS control event', {
      phone: redactSmsPhone(phone),
      action,
      keyword,
      storePath: smsOptOutStorePath(config),
      err,
    });
    return false;
  }
}

function readSmsOptOutStore(config: SmsConfig): SmsOptOutStore {
  const storePath = smsOptOutStorePath(config);
  let raw = '';
  try {
    raw = fs.readFileSync(storePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { optedOut: {}, controlEvents: {} };
    }
    throw err;
  }

  const parsed = JSON.parse(raw) as Partial<SmsOptOutStore>;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`SMS opt-out store ${storePath} did not contain an object`);
  }
  return {
    optedOut: parsed.optedOut && typeof parsed.optedOut === 'object' ? parsed.optedOut : {},
    controlEvents: parsed.controlEvents && typeof parsed.controlEvents === 'object' ? parsed.controlEvents : {},
  };
}

function writeSmsOptOutStore(config: SmsConfig, store: SmsOptOutStore): void {
  const storePath = smsOptOutStorePath(config);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.tmp`;
  // Atomic replace keeps readers from seeing a partial JSON write. The explicit
  // chmods preserve owner-only access even on filesystems that ignore writeFile
  // mode when replacing an existing path.
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: SMS_OPT_OUT_STORE_MODE });
  fs.chmodSync(tmp, SMS_OPT_OUT_STORE_MODE);
  fs.renameSync(tmp, storePath);
  fs.chmodSync(storePath, SMS_OPT_OUT_STORE_MODE);
}

function smsOptOutStorePath(config: SmsConfig): string {
  return config.optOutStorePath ?? path.join(DATA_DIR, 'sms-opt-outs.json');
}

function normalizePhoneKey(phone: string): string {
  return phone.trim();
}

function redactSmsPhone(phone: string | undefined): string | undefined {
  const normalized = String(phone || '').trim();
  if (!normalized) return undefined;
  if (!E164_PHONE_RE.test(normalized)) return '[invalid-phone]';
  return `${normalized.slice(0, 3)}...${normalized.slice(-4)}`;
}

function sanitizeOptionalSmsText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return sanitizeSmsText(value);
}

function sanitizeSmsText(value: string): string {
  return value.replace(/\+[1-9]\d{7,14}/g, '[redacted-phone]').replace(/%2B[1-9]\d{7,14}/gi, '[redacted-phone]');
}

async function handleStatusWebhook(request: Request, config: SmsConfig): Promise<Response> {
  const body = await request.text();
  const params = new URLSearchParams(body);
  if (!verifyRequestSignature(request, config, params, config.statusCallbackUrl)) {
    log.warn('Rejected SMS status callback with invalid Twilio signature', { url: publicRequestUrl(request) });
    return textResponse('Forbidden', 403);
  }

  const status = parseTwilioStatusCallback(params);
  if (!status.sid || !status.status) return textResponse('Missing status', 400);

  const updatedRows = recordSmsDeliveryStatus(status.sid, status.status);
  const logPayload = {
    ...status,
    to: redactSmsPhone(status.to),
    from: redactSmsPhone(status.from),
    errorMessage: sanitizeOptionalSmsText(status.errorMessage),
    updatedRows,
  };
  if (status.errorCode || ['failed', 'undelivered'].includes(status.status)) {
    log.warn('Twilio SMS delivery failed', logPayload);
  } else {
    log.info('Twilio SMS delivery status received', logPayload);
  }

  return textResponse('OK', 200);
}

export function recordSmsDeliveryStatus(platformMessageId: string, status: string): number {
  let sessions;
  try {
    sessions = getActiveSessions();
  } catch (err) {
    log.warn('Could not record SMS delivery status because session DB is unavailable', { platformMessageId, err });
    return 0;
  }

  let changes = 0;
  // Twilio status callbacks identify only the Twilio message SID. Delivered
  // rows live in per-session SQLite files, so fan out across active sessions
  // and update whichever one owns the platform message id.
  for (const session of sessions) {
    let db;
    try {
      db = openInboundDb(session.agent_group_id, session.id);
      changes += updateDeliveredStatusByPlatformMessageId(db, platformMessageId, normalizeDeliveryStatus(status));
    } catch (err) {
      log.debug('Skipping session while recording SMS delivery status', {
        platformMessageId,
        sessionId: session.id,
        err,
      });
    } finally {
      db?.close();
    }
  }

  if (changes === 0) {
    log.warn('SMS delivery status did not match any delivered row', { platformMessageId, status });
  }
  return changes;
}

export function createSmsAdapter(config: SmsConfig): ChannelAdapter {
  let connected = false;

  return {
    name: CHANNEL_TYPE,
    channelType: CHANNEL_TYPE,
    supportsThreads: false,

    async setup(hostConfig: ChannelSetup): Promise<void> {
      if (config.validateCredentials !== false) {
        await validateTwilioCredentials(config);
      }
      registerWebhookHandler(WEBHOOK_NAME, createSmsWebhookHandler(config, hostConfig));
      connected = true;
      log.info('SMS adapter initialized', {
        webhookPath: '/webhook/sms',
        statusWebhookPath: '/webhook/sms/status',
        signatureValidation: config.validateSignature,
      });
    },

    async teardown(): Promise<void> {
      unregisterWebhookHandler(WEBHOOK_NAME);
      connected = false;
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const text = extractSmsText(message);
      if (!text) return undefined;
      if (isSmsOptedOut(platformId, config)) {
        log.info('SMS delivery suppressed because recipient opted out', {
          platformId: redactSmsPhone(platformId),
        });
        return undefined;
      }
      return sendTwilioSms(config, platformId, text);
    },
  };
}

function verifyRequestSignature(
  request: Request,
  config: SmsConfig,
  params: URLSearchParams,
  configuredUrl: string | undefined,
): boolean {
  if (!config.validateSignature) return true;
  // Prefer the configured public URL because reverse proxies often rewrite
  // scheme/host before the request reaches this process.
  return validateTwilioSignature(
    config.authToken,
    configuredUrl || publicRequestUrl(request),
    params,
    request.headers.get('x-twilio-signature'),
  );
}

function publicRequestUrl(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '');
  const host =
    request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || request.headers.get('host') || url.host;
  return `${proto}://${host}${url.pathname}${url.search}`;
}

function statusCallbackUrlFor(webhookUrl: string | undefined): string | undefined {
  if (!webhookUrl) return undefined;
  const url = new URL(webhookUrl);
  url.pathname = url.pathname.endsWith('/') ? `${url.pathname}status` : `${url.pathname}/status`;
  return url.toString();
}

function senderParamName(sender: string): 'MessagingServiceSid' | 'From' {
  if (TWILIO_MESSAGING_SERVICE_SID_RE.test(sender)) return 'MessagingServiceSid';
  if (E164_PHONE_RE.test(sender)) return 'From';
  throw new Error('SMS sender must be a valid Twilio Messaging Service SID or E.164 phone number');
}

function isValidSmsSender(sender: string): boolean {
  return TWILIO_MESSAGING_SERVICE_SID_RE.test(sender) || E164_PHONE_RE.test(sender);
}

function twilioBasicAuth(config: SmsConfig): string {
  return Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
}

function normalizeDeliveryStatus(status: string): string {
  const normalized = status.trim().toLowerCase();
  return normalized || 'unknown';
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

function twimlResponse(message?: string): Response {
  const body = message ? `<Response><Message>${escapeXml(message)}</Message></Response>` : '<Response></Response>';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/xml' } });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

registerChannelAdapter(CHANNEL_TYPE, {
  factory: () => {
    const config = readSmsConfig();
    if (!config) return null;
    return createSmsAdapter(config);
  },
});
