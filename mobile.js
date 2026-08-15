'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const QRCode = require('qrcode');

const DEFAULT_API_URL = 'https://license.authoritygate.com/api/racksight/mobile/v1';
const CODE_TTL_SECONDS = 10 * 60;
const ENROLLMENT_TTL_SECONDS = 5 * 60;
const SYNC_INTERVAL_MS = 60 * 1000;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function uuidBytes(value) {
  const normalized = String(value || '').replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(normalized)) throw new Error('AuthorityGate returned an invalid enrollment identifier.');
  return Buffer.from(normalized, 'hex');
}

function encodeEnrollmentQr(payload) {
  const pairing = Buffer.from(payload.pairing_token, 'base64url');
  const key = Buffer.from(payload.data_key, 'base64url');
  if (pairing.length !== 32 || key.length !== 32) throw new Error('AuthorityGate returned an invalid enrollment secret.');
  const expiration = Math.floor(new Date(payload.expires_at).getTime() / 1000);
  if (!Number.isInteger(expiration) || expiration <= 0 || expiration > 0xffffffff) throw new Error('AuthorityGate returned an invalid enrollment expiration.');
  const compact = Buffer.alloc(101);
  compact[0] = 1;
  uuidBytes(payload.installation_id).copy(compact, 1);
  uuidBytes(payload.enrollment_id).copy(compact, 17);
  pairing.copy(compact, 33);
  key.copy(compact, 65);
  compact.writeUInt32BE(expiration, 97);
  return `RS1:${compact.toString('base64url')}`;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('Enter a valid email address.');
  return email;
}

function encryptMobilePayload(value, key, installationId) {
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from(`racksight-mobile-v1:${installationId}`, 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    v: 1,
    algorithm: 'A256GCM',
    iv: base64url(iv),
    tag: base64url(cipher.getAuthTag()),
    ciphertext: base64url(ciphertext)
  };
}

function decryptMobilePayload(envelope, key, installationId) {
  if (!envelope || envelope.v !== 1 || envelope.algorithm !== 'A256GCM') throw new Error('Unsupported mobile payload.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), Buffer.from(envelope.iv, 'base64url'));
  decipher.setAAD(Buffer.from(`racksight-mobile-v1:${installationId}`, 'utf8'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
    decipher.final()
  ]).toString('utf8'));
}

function validateApiUrl(value) {
  const url = new URL(value || DEFAULT_API_URL);
  const localDevelopment = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(localDevelopment && url.protocol === 'http:')) throw new Error('The mobile API must use HTTPS.');
  return url.toString().replace(/\/$/, '');
}

function createMobileService(options) {
  const dataDir = options.dataDir;
  const encryptStore = options.encryptStore;
  const decryptStore = options.decryptStore;
  const fetchFn = options.fetchFn || global.fetch;
  const apiUrl = validateApiUrl(options.apiUrl || process.env.RACKSIGHT_MOBILE_API_URL || DEFAULT_API_URL);
  const stateFile = path.join(dataDir, 'mobile.enc.json');
  let lastSyncStartedAt = 0;
  let syncPromise = null;

  function defaultState() {
    return {
      localInstallationId: crypto.randomUUID(),
      installationId: '',
      installationToken: '',
      ownerEmail: '',
      ownerVerified: false,
      claimChallengeId: '',
      dataKey: '',
      devices: [],
      lastSyncAt: '',
      lastError: ''
    };
  }

  function readState() {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(stateFile)) {
      const state = defaultState();
      writeState(state);
      return state;
    }
    try { return { ...defaultState(), ...decryptStore(JSON.parse(fs.readFileSync(stateFile, 'utf8'))) }; }
    catch (error) { throw new Error(`Mobile notification configuration could not be decrypted: ${error.message}`); }
  }

  function writeState(state) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${stateFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(encryptStore(state), null, 2), { mode: 0o600 });
    fs.renameSync(temporary, stateFile);
  }

  function publicState(state = readState()) {
    const configured = Boolean(state.ownerVerified && state.installationId && state.installationToken && state.dataKey);
    return {
      configured,
      status: configured ? 'configured' : (state.claimChallengeId ? 'verification-required' : 'unconfigured'),
      ownerEmail: state.ownerEmail,
      codeExpiresInSeconds: CODE_TTL_SECONDS,
      enrollmentExpiresInSeconds: ENROLLMENT_TTL_SECONDS,
      devices: state.devices || [],
      lastSyncAt: state.lastSyncAt,
      lastError: state.lastError,
      apiUrl
    };
  }

  async function cloud(pathname, init = {}, token = '') {
    const headers = { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetchFn(`${apiUrl}${pathname}`, { ...init, headers, signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
    if (!response.ok) throw new Error(body.error || (response.status === 404 ? 'AuthorityGate notification enrollment is not available on the server yet.' : `AuthorityGate notification service returned HTTP ${response.status}.`));
    return body;
  }

  async function requestOwnerCode(input) {
    const email = normalizeEmail(input.email);
    const state = readState();
    const result = await cloud('/installations/claim/request', {
      method: 'POST',
      body: JSON.stringify({
        email,
        local_installation_id: state.localInstallationId,
        registration_id: String(process.env.RACKSIGHT_REGISTRATION_ID || ''),
        instance_name: String(input.instanceName || os.hostname()).slice(0, 120),
        company: String(input.company || '').trim().slice(0, 160),
        app_version: String(input.appVersion || '').slice(0, 40)
      })
    });
    state.ownerEmail = email;
    state.ownerVerified = false;
    state.claimChallengeId = String(result.challenge_id || '');
    state.installationToken = '';
    state.lastError = '';
    writeState(state);
    return publicState(state);
  }

  async function verifyOwnerCode(input) {
    const code = String(input.code || '').trim();
    if (!/^\d{6}$/.test(code)) throw new Error('Enter the six-digit verification code.');
    const state = readState();
    if (!state.claimChallengeId || !state.ownerEmail) throw new Error('Request an email verification code first.');
    const result = await cloud('/installations/claim/verify', {
      method: 'POST',
      body: JSON.stringify({ challenge_id: state.claimChallengeId, email: state.ownerEmail, code })
    });
    if (!result.installation_id || !result.installation_token) throw new Error('AuthorityGate returned an incomplete installation credential.');
    state.installationId = String(result.installation_id);
    state.installationToken = String(result.installation_token);
    state.ownerVerified = true;
    state.claimChallengeId = '';
    state.dataKey ||= base64url(crypto.randomBytes(32));
    state.lastError = '';
    writeState(state);
    return publicState(state);
  }

  async function createEnrollment(input) {
    const state = readState();
    if (!state.ownerVerified) throw new Error('Verify the installation owner before registering an Android device.');
    const email = normalizeEmail(input.email);
    const result = await cloud('/enrollments', {
      method: 'POST',
      body: JSON.stringify({ email, expires_in_seconds: ENROLLMENT_TTL_SECONDS })
    }, state.installationToken);
    if (!result.enrollment_id || !result.pairing_token) throw new Error('AuthorityGate returned an incomplete enrollment.');
    const payload = {
      installation_id: state.installationId,
      enrollment_id: String(result.enrollment_id),
      pairing_token: String(result.pairing_token),
      data_key: state.dataKey,
      expires_at: result.expires_at || new Date(Date.now() + ENROLLMENT_TTL_SECONDS * 1000).toISOString()
    };
    return {
      enrollmentId: payload.enrollment_id,
      email,
      expiresAt: payload.expires_at,
      qrSvg: await QRCode.toString(encodeEnrollmentQr(payload), {
        type: 'svg',
        errorCorrectionLevel: 'L',
        margin: 5,
        width: 480,
        color: { dark:'#000000', light:'#FFFFFF' }
      })
    };
  }

  async function refreshDevices() {
    const state = readState();
    if (!state.ownerVerified) return publicState(state);
    const result = await cloud('/devices', { method: 'GET' }, state.installationToken);
    state.devices = (result.devices || []).map(device => ({
      id: String(device.id),
      name: String(device.name || 'Android device'),
      email: String(device.email || ''),
      registeredAt: device.registered_at || '',
      lastSeenAt: device.last_seen_at || '',
      notificationsEnabled: device.notifications_enabled !== false
    }));
    state.lastError = '';
    writeState(state);
    return publicState(state);
  }

  async function revokeDevice(deviceId) {
    const state = readState();
    if (!state.ownerVerified) throw new Error('Android notifications are not configured.');
    await cloud(`/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' }, state.installationToken);
    state.devices = (state.devices || []).filter(device => device.id !== deviceId);
    writeState(state);
    return publicState(state);
  }

  async function upload(kind, value, { notify = false, email = false } = {}) {
    const state = readState();
    if (!state.ownerVerified) return { skipped: true };
    const envelope = encryptMobilePayload(value, state.dataKey, state.installationId);
    return cloud('/payloads', {
      method: 'POST',
      body: JSON.stringify({ kind, envelope, notify, email })
    }, state.installationToken);
  }

  async function syncSnapshot(snapshot, force = false) {
    const state = readState();
    if (!state.ownerVerified) return { skipped: true };
    if (!force && Date.now() - lastSyncStartedAt < SYNC_INTERVAL_MS) return { skipped: true };
    if (syncPromise) return syncPromise;
    lastSyncStartedAt = Date.now();
    syncPromise = upload('snapshot', snapshot).then(result => {
      const next = readState();
      next.lastSyncAt = new Date().toISOString();
      next.lastError = '';
      writeState(next);
      return result;
    }).catch(error => {
      const next = readState();
      next.lastError = error.message;
      writeState(next);
      throw error;
    }).finally(() => { syncPromise = null; });
    return syncPromise;
  }

  async function publishAlert(alert, event) {
    return upload('alert', { event, alert, occurredAt: new Date().toISOString() }, { notify: true, email: true });
  }

  return { publicState, requestOwnerCode, verifyOwnerCode, createEnrollment, refreshDevices, revokeDevice, syncSnapshot, publishAlert };
}

module.exports = { DEFAULT_API_URL, CODE_TTL_SECONDS, ENROLLMENT_TTL_SECONDS, normalizeEmail, validateApiUrl, encodeEnrollmentQr, encryptMobilePayload, decryptMobilePayload, createMobileService };
