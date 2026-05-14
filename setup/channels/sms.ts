/**
 * SMS channel flow for setup:auto.
 *
 * `runSmsChannel(displayName)` owns the branch from Twilio credentials
 * through the welcome SMS:
 *
 *   1. Explain the Twilio sender + webhook requirements.
 *   2. Collect Account SID, Auth Token, sender, and public webhook URL.
 *   3. Validate Twilio credentials with the Accounts API.
 *   4. Persist SMS env via setup/add-sms.sh and restart the service.
 *   5. Confirm opt-in for the operator phone number.
 *   6. Wire the agent via scripts/init-first-agent.ts.
 *
 * All output obeys the three-level contract: clack UI for the user,
 * structured entries in logs/setup.log, full raw output in per-step files
 * under logs/setup-steps/. See docs/setup-flow.md.
 */
import * as p from '@clack/prompts';
import k from 'kleur';

import * as setupLog from '../logs.js';
import { readEnvKey } from '../environment.js';
import { BACK_TO_CHANNEL_SELECTION, type ChannelFlowResult } from '../lib/back-nav.js';
import { brightSelect } from '../lib/bright-select.js';
import { openUrl } from '../lib/browser.js';
import { askOperatorRole } from '../lib/role-prompt.js';
import { ensureAnswer, fail, runQuietChild } from '../lib/runner.js';
import { isHeadless } from '../platform.js';
import { accentGreen, fmtDuration, note } from '../lib/theme.js';

const TWILIO_CONSOLE_URL = 'https://console.twilio.com/us1/develop/sms/manage/senders';
const DEFAULT_AGENT_NAME = 'Nano';

type Sender = { kind: 'phone'; value: string } | { kind: 'messaging-service'; value: string };

interface TwilioAccountInfo {
  friendlyName?: string;
  status?: string;
}

export async function runSmsChannel(displayName: string): Promise<ChannelFlowResult> {
  const intro = await walkThroughTwilioSetup();
  if (intro === 'back') return BACK_TO_CHANNEL_SELECTION;

  const accountSid = await collectAccountSid();
  const authToken = await collectAuthToken();
  const accountInfo = await validateTwilioCredentials(accountSid, authToken);
  const sender = await collectSender();
  const webhookUrl = await collectWebhookUrl();
  const statusCallbackUrl = statusCallbackUrlFor(webhookUrl);

  const install = await runQuietChild(
    'sms-install',
    'bash',
    ['setup/add-sms.sh'],
    {
      running: 'Connecting SMS through Twilio...',
      done: 'SMS adapter configured.',
      skipped: 'SMS adapter already configured.',
    },
    {
      env: {
        TWILIO_ACCOUNT_SID: accountSid,
        TWILIO_AUTH_TOKEN: authToken,
        TWILIO_PHONE_NUMBER: sender.kind === 'phone' ? sender.value : '',
        TWILIO_FROM_NUMBER: '',
        TWILIO_MESSAGING_SERVICE_SID: sender.kind === 'messaging-service' ? sender.value : '',
        TWILIO_SMS_WEBHOOK_URL: webhookUrl,
        TWILIO_SMS_STATUS_CALLBACK_URL: statusCallbackUrl,
        TWILIO_VALIDATE_SIGNATURE: 'true',
        NANOCLAW_SMS_ALLOW_PHONE_SENDER: sender.kind === 'phone' ? 'true' : '',
      },
      extraFields: {
        CHANNEL: 'sms',
        ACCOUNT: accountInfo.friendlyName ?? accountInfo.status ?? 'validated',
        SENDER: maskSender(sender.value),
        WEBHOOK_URL: webhookUrl,
        STATUS_CALLBACK_URL: statusCallbackUrl,
      },
    },
  );
  if (!install.ok) {
    await fail('sms-install', "Couldn't connect SMS.", 'See logs/setup-steps/ for details, then retry setup.');
  }

  showTwilioWebhookChecklist(webhookUrl, statusCallbackUrl);

  const operatorPhone = await collectOperatorPhone();
  const confirmed = ensureAnswer(
    await p.confirm({
      message: `Confirm ${operatorPhone} has opted in to receive SMS from this assistant`,
      initialValue: true,
    }),
  );
  if (!confirmed) {
    await fail(
      'sms-opt-in',
      'SMS setup stopped before sending a welcome message.',
      'Use a phone number that has opted in, then rerun setup or /add-sms.',
    );
  }
  setupLog.userInput('sms_operator_opt_in', 'confirmed');

  const role = await askOperatorRole('SMS');
  setupLog.userInput('sms_role', role);

  const agentName = await resolveAgentName();

  const init = await runQuietChild(
    'init-first-agent',
    'pnpm',
    [
      'exec',
      'tsx',
      'scripts/init-first-agent.ts',
      '--channel',
      'sms',
      '--user-id',
      operatorPhone,
      '--platform-id',
      operatorPhone,
      '--display-name',
      displayName,
      '--agent-name',
      agentName,
      '--role',
      role,
    ],
    {
      running: `Sending ${agentName}'s welcome SMS...`,
      done: `${agentName} is ready. Check your SMS messages.`,
    },
    {
      extraFields: {
        CHANNEL: 'sms',
        AGENT_NAME: agentName,
        PLATFORM_ID: operatorPhone,
      },
    },
  );
  if (!init.ok) {
    await fail(
      'init-first-agent',
      `Couldn't finish connecting ${agentName}.`,
      'You can retry later with `/init-first-agent` or `/manage-channels`.',
    );
  }
}

async function walkThroughTwilioSetup(): Promise<'continue' | 'back'> {
  const linkBlock = isHeadless() ? [`Twilio senders: ${TWILIO_CONSOLE_URL}`, ''] : [];

  note(
    [
      'NanoClaw sends and receives SMS through Twilio Programmable Messaging.',
      'You need a Twilio Account SID, Auth Token, and either a Twilio phone',
      'number or Messaging Service SID.',
      '',
      ...linkBlock,
      'Twilio must be able to reach this NanoClaw host over HTTPS:',
      '  Incoming messages:  https://your-domain/webhook/sms',
      '  Status callbacks:   https://your-domain/webhook/sms/status',
      '',
      'Use SMS only for phone numbers that have opted in. Production SMS',
      'requires a Messaging Service with Advanced Opt-Out enabled and',
      'verified opt-in before activation.',
    ].join('\n'),
    'Set up SMS',
  );

  const choice = ensureAnswer(
    await brightSelect<'open' | 'continue' | 'back'>({
      message: 'Ready to configure Twilio SMS?',
      options: [
        { value: 'open', label: 'Open Twilio senders' },
        { value: 'continue', label: 'Continue without opening Twilio' },
        { value: 'back', label: 'Back to channel selection' },
      ],
      initialValue: isHeadless() ? 'continue' : 'open',
    }),
  );
  if (choice === 'back') return 'back';
  if (choice === 'open' && !isHeadless()) openUrl(TWILIO_CONSOLE_URL);
  return 'continue';
}

async function collectAccountSid(): Promise<string> {
  const existing = envValue('TWILIO_ACCOUNT_SID');
  if (existing && isAccountSid(existing)) {
    const reuse = ensureAnswer(
      await p.confirm({
        message: `Found an existing Twilio Account SID (${maskSid(existing)}). Use it?`,
        initialValue: true,
      }),
    );
    if (reuse) {
      setupLog.userInput('twilio_account_sid', 'reused-existing');
      return existing;
    }
  }

  const answer = ensureAnswer(
    await p.text({
      message: 'Paste your Twilio Account SID',
      placeholder: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      validate: (v) => {
        const value = (v ?? '').trim();
        if (!value) return 'Account SID is required';
        if (!isAccountSid(value)) return 'Account SIDs start with AC and contain 32 hex characters';
        return undefined;
      },
    }),
  );
  const sid = (answer as string).trim();
  setupLog.userInput('twilio_account_sid', maskSid(sid));
  return sid;
}

async function collectAuthToken(): Promise<string> {
  const existing = envValue('TWILIO_AUTH_TOKEN');
  if (existing && existing.length >= 16) {
    const reuse = ensureAnswer(
      await p.confirm({
        message: 'Found an existing Twilio Auth Token. Use it?',
        initialValue: true,
      }),
    );
    if (reuse) {
      setupLog.userInput('twilio_auth_token', 'reused-existing');
      return existing;
    }
  }

  const answer = ensureAnswer(
    await p.password({
      message: 'Paste your Twilio Auth Token',
      clearOnError: true,
      validate: (v) => {
        const value = (v ?? '').trim();
        if (!value) return 'Auth Token is required';
        if (value.length < 16) return "That doesn't look like a Twilio Auth Token";
        return undefined;
      },
    }),
  );
  const token = (answer as string).trim();
  setupLog.userInput('twilio_auth_token', maskSecret(token));
  return token;
}

async function validateTwilioCredentials(accountSid: string, authToken: string): Promise<TwilioAccountInfo> {
  const start = Date.now();
  const s = p.spinner();
  s.start('Checking Twilio credentials...');
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}.json`, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      },
    });
    const text = await res.text();
    if (!res.ok) {
      s.stop(`Twilio rejected those credentials. ${k.dim(`(${fmtDuration(Date.now() - start)})`)}`, 1);
      setupLog.step('sms-validate', 'failed', Date.now() - start, {
        STATUS_CODE: String(res.status),
      });
      await fail(
        'sms-validate',
        "Twilio didn't accept those credentials.",
        'Copy the Account SID and Auth Token from Twilio Console and try again.',
      );
    }

    const data = safeJson(text) as {
      friendly_name?: string;
      status?: string;
    };
    const label = data.friendly_name || data.status || 'account validated';
    s.stop(`Twilio account validated: ${label}. ${k.dim(`(${fmtDuration(Date.now() - start)})`)}`);
    setupLog.step('sms-validate', 'success', Date.now() - start, {
      ACCOUNT: label,
    });
    return { friendlyName: data.friendly_name, status: data.status };
  } catch (err) {
    s.stop(`Couldn't reach Twilio. ${k.dim(`(${fmtDuration(Date.now() - start)})`)}`, 1);
    const message = err instanceof Error ? err.message : String(err);
    setupLog.step('sms-validate', 'failed', Date.now() - start, {
      ERROR: message,
    });
    await fail('sms-validate', "Couldn't reach Twilio.", 'Check your internet connection and retry setup.');
  }
}

async function collectSender(): Promise<Sender> {
  const existingMessagingService = envValue('TWILIO_MESSAGING_SERVICE_SID');
  const existingPhone = envValue('TWILIO_PHONE_NUMBER') ?? envValue('TWILIO_FROM_NUMBER');
  const existing =
    existingMessagingService && isMessagingServiceSid(existingMessagingService)
      ? ({ kind: 'messaging-service', value: existingMessagingService } as Sender)
      : existingPhone && isE164(existingPhone)
        ? ({ kind: 'phone', value: existingPhone } as Sender)
        : null;

  if (existing) {
    const reuse = ensureAnswer(
      await p.confirm({
        message: `Found existing SMS sender ${maskSender(existing.value)}. Use it?`,
        initialValue: true,
      }),
    );
    if (reuse) {
      setupLog.userInput('twilio_sender', `reused-existing:${existing.kind}`);
      return existing;
    }
  }

  const kind = ensureAnswer(
    await brightSelect<Sender['kind']>({
      message: 'What Twilio sender should NanoClaw use?',
      options: [
        { value: 'messaging-service', label: 'Messaging Service SID', hint: 'MG...; required for production' },
        { value: 'phone', label: 'Twilio phone number', hint: '+15551234567; local/dev fallback' },
      ],
      initialValue: 'messaging-service',
    }),
  );

  const answer = ensureAnswer(
    await p.text({
      message: kind === 'phone' ? 'Paste your Twilio phone number' : 'Paste your Twilio Messaging Service SID',
      placeholder: kind === 'phone' ? '+15551234567' : 'MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      validate: (v) => {
        const value = (v ?? '').trim();
        if (!value) return 'Sender is required';
        if (kind === 'phone' && !isE164(value)) return 'Use E.164 format, like +15551234567';
        if (kind === 'messaging-service' && !isMessagingServiceSid(value)) {
          return 'Messaging Service SIDs start with MG and contain 32 hex characters';
        }
        return undefined;
      },
    }),
  );
  const value = (answer as string).trim();
  setupLog.userInput('twilio_sender', `${kind}:${maskSender(value)}`);
  return { kind, value };
}

async function collectWebhookUrl(): Promise<string> {
  const existing = envValue('TWILIO_SMS_WEBHOOK_URL');
  if (existing && normalizeWebhookUrl(existing)) {
    const reuse = ensureAnswer(
      await p.confirm({
        message: `Found existing SMS webhook URL (${existing}). Use it?`,
        initialValue: true,
      }),
    );
    if (reuse) {
      setupLog.userInput('twilio_sms_webhook_url', 'reused-existing');
      return normalizeWebhookUrl(existing)!;
    }
  }

  const answer = ensureAnswer(
    await p.text({
      message: 'Paste the public SMS webhook URL',
      placeholder: 'https://your-domain/webhook/sms',
      validate: (v) => {
        const normalized = normalizeWebhookUrl((v ?? '').trim());
        if (!normalized) {
          return 'Use a public http(s) URL, usually https://your-domain/webhook/sms';
        }
        if (!normalized.startsWith('https://')) {
          return 'Use HTTPS for production webhooks';
        }
        return undefined;
      },
    }),
  );
  const url = normalizeWebhookUrl((answer as string).trim())!;
  setupLog.userInput('twilio_sms_webhook_url', url);
  return url;
}

async function collectOperatorPhone(): Promise<string> {
  const answer = ensureAnswer(
    await p.text({
      message: `What ${accentGreen('phone number')} should get the first welcome SMS?`,
      placeholder: '+15551234567',
      validate: (v) => {
        const value = (v ?? '').trim();
        if (!value) return 'Phone number is required';
        if (!isE164(value)) return 'Use E.164 format, like +15551234567';
        return undefined;
      },
    }),
  );
  const phone = (answer as string).trim();
  setupLog.userInput('sms_operator_phone', maskSender(phone));
  return phone;
}

async function resolveAgentName(): Promise<string> {
  const preset = process.env.NANOCLAW_AGENT_NAME?.trim();
  if (preset) {
    setupLog.userInput('agent_name', preset);
    return preset;
  }
  const answer = ensureAnswer(
    await p.text({
      message: `What should your ${accentGreen('assistant')} be called?`,
      placeholder: DEFAULT_AGENT_NAME,
      defaultValue: DEFAULT_AGENT_NAME,
    }),
  );
  const value = (answer as string).trim() || DEFAULT_AGENT_NAME;
  setupLog.userInput('agent_name', value);
  return value;
}

function showTwilioWebhookChecklist(webhookUrl: string, statusCallbackUrl: string): void {
  note(
    [
      'In Twilio Console, configure the same sender you entered here:',
      '',
      `  Incoming message webhook: ${webhookUrl}`,
      `  Status callback URL:      ${statusCallbackUrl}`,
      '  Method:                   POST',
      '',
      'Keep signature validation enabled. If a proxy rewrites the URL, update',
      'TWILIO_SMS_WEBHOOK_URL and TWILIO_SMS_STATUS_CALLBACK_URL so they exactly',
      "match Twilio's configured URLs.",
    ].join('\n'),
    'Twilio settings',
  );
}

function envValue(key: string): string | null {
  return process.env[key]?.trim() || readEnvKey(key);
}

function isAccountSid(value: string): boolean {
  return /^AC[a-fA-F0-9]{32}$/.test(value);
}

function isMessagingServiceSid(value: string): boolean {
  return /^MG[a-fA-F0-9]{32}$/.test(value);
}

function isE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

function maskSid(value: string): string {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function maskSecret(value: string): string {
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function maskSender(value: string): string {
  if (value.startsWith('+') && value.length > 6) {
    return `${value.slice(0, 3)}...${value.slice(-4)}`;
  }
  if (value.length > 12) return `${value.slice(0, 6)}...${value.slice(-4)}`;
  return value;
}

function normalizeWebhookUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.pathname || url.pathname === '/') url.pathname = '/webhook/sms';
    return url.toString();
  } catch {
    return null;
  }
}

function statusCallbackUrlFor(webhookUrl: string): string {
  const url = new URL(webhookUrl);
  url.pathname = url.pathname.endsWith('/') ? `${url.pathname}status` : `${url.pathname}/status`;
  return url.toString();
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
