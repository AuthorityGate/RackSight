'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS || 10000);
const DATA_DIR = process.env.RACKSIGHT_DATA_DIR ? path.resolve(process.env.RACKSIGHT_DATA_DIR) : path.join(__dirname, 'data');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const KEY_FILE = path.join(DATA_DIR, 'master.key');
const SERVERS_FILE = path.join(DATA_DIR, 'servers.enc.json');
const ALERT_SETTINGS_FILE = path.join(DATA_DIR, 'alert-settings.json');
const ALERT_STATE_FILE = path.join(DATA_DIR, 'alert-state.json');
const ALERT_EVENTS_FILE = path.join(DATA_DIR, 'alert-events.jsonl');
const FAN_STATE_FILE = path.join(DATA_DIR, 'fan-state.json');
const SMTP_FILE = path.join(DATA_DIR, 'smtp.enc.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const APP_VERSION = require('./package.json').version;
const UPDATE_FILE = path.join(DATA_DIR, 'update-status.json');
const MAX_BODY = 64 * 1024;
const HISTORY_INTERVAL_MS = Math.max(30000, Number(process.env.HISTORY_INTERVAL_MS || 60000));
const HISTORY_RETENTION_MS = 31 * 24 * 60 * 60 * 1000;
const DATA_CACHE_MS = 55000;
const BMC_BACKOFF_INITIAL_MS = 5 * 60 * 1000;
const BMC_BACKOFF_MAX_MS = 30 * 60 * 1000;
const pollInFlight = new Map();
const recentData = new Map();
const bmcBackoffs = new Map();
const bmcSessions = new Map();
const bmcSessionPromises = new Map();
const lastRecordedAt = new Map();
let alertStateLoaded = false;
const activeAlerts = new Map();
let fanStateLoaded = false;
const knownFans = new Map();

function historyPollSpacingMs(serverCount, intervalMs = HISTORY_INTERVAL_MS) {
  const count = Math.max(1, Number(serverCount) || 1);
  return intervalMs / count;
}

function startupPollSpacingMs(serverCount, windowMs = 10000) {
  const count = Math.max(1, Number(serverCount) || 1);
  return count === 1 ? 0 : windowMs / count;
}

function createStaggeredQueue(getSpacingMs = () => 0) {
  let schedulingTail = Promise.resolve();
  let lastStartedAt = 0;
  return task => {
    let taskPromise;
    const start = async () => {
      const spacing = Math.max(0, Number(getSpacingMs()) || 0);
      const waitMs = Math.max(0, lastStartedAt + spacing - Date.now());
      if (waitMs) await delay(waitMs);
      lastStartedAt = Date.now();
      taskPromise = Promise.resolve().then(task);
    };
    const scheduled = schedulingTail.then(start, start);
    // Advance the queue as soon as a scan starts. The scan may continue while
    // the next server waits for its assigned start slot.
    schedulingTail = scheduled.catch(() => {});
    return scheduled.then(() => taskPromise);
  };
}

const enqueueCollection = createStaggeredQueue(() => {
  try { return historyPollSpacingMs(readServers().length); }
  catch { return HISTORY_INTERVAL_MS; }
});
const enqueueStartupCollection = createStaggeredQueue(() => {
  try { return startupPollSpacingMs(readServers().length); }
  catch { return 10000; }
});

const DEFAULT_ALERT_SETTINGS = {
  enabled: true,
  thresholdC: 85,
  durationMinutes: 5,
  fanAlertsEnabled: true,
  fanFailureDurationMinutes: 2,
  cooldownMinutes: 30,
  browserNotifications: true
};
const DEFAULT_SMTP_SETTINGS = { enabled: false, host: '', port: 587, secure: false, username: '', password: '', from: '', to: '' };

function normalizeBaseUrl(value) {
  const input = String(value || '').trim();
  if (!input) throw new Error('A hostname or IP address is required.');
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(input);
  const candidate = hasScheme ? input : `https://${input}`;
  const url = new URL(candidate);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS targets are supported.');
  if (url.username || url.password || url.search || url.hash) throw new Error('Enter only the BMC hostname or address.');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.origin + (url.pathname === '/' ? '' : url.pathname);
}

function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(HISTORY_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32), { mode: 0o600 });
  }
}

function historyFile(serverId) {
  const safeId = String(serverId || '').replace(/[^a-zA-Z0-9-]/g, '');
  if (!safeId) throw new Error('Invalid server identifier.');
  return path.join(HISTORY_DIR, `${safeId}.jsonl`);
}

function encryptionKey() {
  ensureStorage();
  const configured = process.env.DASHBOARD_SECRET;
  if (configured) return crypto.scryptSync(configured, 'asrock-dashboard-v1', 32);
  const key = fs.readFileSync(KEY_FILE);
  if (key.length !== 32) throw new Error('Invalid dashboard master key.');
  return key;
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64')
  };
}

function decrypt(payload) {
  if (!payload || payload.v !== 1) throw new Error('Unsupported credential-store format.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final()
  ]).toString('utf8'));
}

function readServers() {
  ensureStorage();
  if (!fs.existsSync(SERVERS_FILE)) return [];
  return decrypt(JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8')));
}

function writeServers(servers) {
  ensureStorage();
  const temporary = `${SERVERS_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(encrypt(servers), null, 2), { mode: 0o600 });
  fs.renameSync(temporary, SERVERS_FILE);
}

function readAlertSettings() {
  ensureStorage();
  if (!fs.existsSync(ALERT_SETTINGS_FILE)) return { ...DEFAULT_ALERT_SETTINGS };
  try { return { ...DEFAULT_ALERT_SETTINGS, ...JSON.parse(fs.readFileSync(ALERT_SETTINGS_FILE, 'utf8')) }; }
  catch { return { ...DEFAULT_ALERT_SETTINGS }; }
}

function validateAlertSettings(input) {
  const thresholdC = Number(input.thresholdC);
  const durationMinutes = Number(input.durationMinutes);
  const cooldownMinutes = Number(input.cooldownMinutes);
  const fanFailureDurationMinutes = Number(input.fanFailureDurationMinutes ?? 2);
  if (!Number.isFinite(thresholdC) || thresholdC < 20 || thresholdC > 120) throw new Error('Temperature threshold must be between 20°C and 120°C.');
  if (!Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) throw new Error('Alert duration must be between 1 and 1,440 minutes.');
  if (!Number.isFinite(cooldownMinutes) || cooldownMinutes < 1 || cooldownMinutes > 10080) throw new Error('Cooldown must be between 1 minute and 7 days.');
  if (!Number.isFinite(fanFailureDurationMinutes) || fanFailureDurationMinutes < 1 || fanFailureDurationMinutes > 1440) throw new Error('Fan failure duration must be between 1 and 1,440 minutes.');
  return { enabled: input.enabled !== false, thresholdC, durationMinutes, fanAlertsEnabled: input.fanAlertsEnabled !== false, fanFailureDurationMinutes, cooldownMinutes, browserNotifications: input.browserNotifications !== false };
}

function writeAlertSettings(settings) {
  ensureStorage();
  const validated = validateAlertSettings(settings);
  fs.writeFileSync(ALERT_SETTINGS_FILE, JSON.stringify(validated, null, 2), { mode: 0o600 });
  return validated;
}

function loadAlertState() {
  if (alertStateLoaded) return;
  alertStateLoaded = true;
  if (!fs.existsSync(ALERT_STATE_FILE)) return;
  try {
    for (const alert of JSON.parse(fs.readFileSync(ALERT_STATE_FILE, 'utf8'))) activeAlerts.set(alert.key, alert);
  } catch { /* Start with clean runtime state if a prior file is incomplete. */ }
}

function saveAlertState() {
  ensureStorage();
  fs.writeFileSync(ALERT_STATE_FILE, JSON.stringify([...activeAlerts.values()], null, 2), { mode: 0o600 });
}

function loadFanState() {
  if (fanStateLoaded) return;
  fanStateLoaded = true;
  if (!fs.existsSync(FAN_STATE_FILE)) return;
  try { for (const fan of JSON.parse(fs.readFileSync(FAN_STATE_FILE, 'utf8'))) knownFans.set(fan.key, fan); }
  catch { /* Relearn connected fans if a prior baseline file is incomplete. */ }
}

function saveFanState() {
  ensureStorage();
  fs.writeFileSync(FAN_STATE_FILE, JSON.stringify([...knownFans.values()], null, 2), { mode: 0o600 });
}

function appendAlertEvent(event) {
  ensureStorage();
  fs.appendFileSync(ALERT_EVENTS_FILE, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

function readSmtpSettings(includePassword = false) {
  ensureStorage();
  let settings = { ...DEFAULT_SMTP_SETTINGS };
  if (fs.existsSync(SMTP_FILE)) {
    try { settings = { ...settings, ...decrypt(JSON.parse(fs.readFileSync(SMTP_FILE, 'utf8'))) }; }
    catch { /* Preserve safe defaults if configuration cannot be decrypted. */ }
  }
  if (!includePassword) return { ...settings, password: '', passwordConfigured: Boolean(settings.password) };
  return settings;
}

function validateSmtpSettings(input, existing = {}) {
  const port = Number(input.port || 587);
  if (input.enabled && !String(input.host || '').trim()) throw new Error('SMTP host is required when email alerts are enabled.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP port must be between 1 and 65,535.');
  if (input.enabled && !String(input.from || '').includes('@')) throw new Error('A valid SMTP sender address is required.');
  if (input.enabled && !String(input.to || '').split(',').some(value => value.trim().includes('@'))) throw new Error('At least one recipient email address is required.');
  return {
    enabled: input.enabled === true,
    host: String(input.host || '').trim(),
    port,
    secure: input.secure === true,
    username: String(input.username || '').trim(),
    password: input.password ? String(input.password) : String(existing.password || ''),
    from: String(input.from || '').trim(),
    to: String(input.to || '').split(',').map(value => value.trim()).filter(Boolean).join(', ')
  };
}

function writeSmtpSettings(input) {
  const settings = validateSmtpSettings(input, readSmtpSettings(true));
  fs.writeFileSync(SMTP_FILE, JSON.stringify(encrypt(settings), null, 2), { mode: 0o600 });
  return readSmtpSettings(false);
}

function smtpTransport(settings) {
  const options = { host: settings.host, port: settings.port, secure: settings.secure };
  if (settings.username || settings.password) options.auth = { user: settings.username, pass: settings.password };
  return nodemailer.createTransport(options);
}

async function sendSmtpMessage(subject, text, force = false) {
  const settings = readSmtpSettings(true);
  if (!settings.enabled && !force) return { skipped: true };
  validateSmtpSettings({ ...settings, enabled: true }, settings);
  const info = await smtpTransport(settings).sendMail({ from: settings.from, to: settings.to, subject, text });
  return { messageId: info.messageId, accepted: info.accepted };
}

function sendAlertEmail(alert, event) {
  if (alert.type === 'fan') {
    const state = event === 'resolved' ? 'FAN RECOVERED' : 'FAN FAILURE';
    const subject = `[RackSight] ${state}: ${alert.serverName} ${alert.sensor}`;
    const text = event === 'resolved'
      ? `${alert.serverName} fan ${alert.sensor} has recovered.\n\nCurrent speed: ${alert.valueRpm} RPM\nRecovered: ${new Date().toLocaleString()}\n`
      : `${alert.serverName} reported a fan failure for the configured duration.\n\nFan: ${alert.sensor}\nReason: ${alert.reason}\nCurrent speed: ${alert.valueRpm ?? 'Unavailable'} RPM\nFailure observed since: ${new Date(alert.since).toLocaleString()}\n`;
    sendSmtpMessage(subject, text).catch(error => console.error(`SMTP alert failed: ${error.message}`));
    return;
  }
  const state = event === 'resolved' ? 'RECOVERED' : 'HIGH TEMPERATURE';
  const subject = `[RackSight] ${state}: ${alert.serverName} ${alert.sensor}`;
  const text = event === 'resolved'
    ? `${alert.serverName} has recovered.\n\nSensor: ${alert.sensor}\nCurrent: ${alert.valueC}°C\nThreshold: ${alert.thresholdC}°C\nRecovered: ${new Date().toLocaleString()}\n`
    : `${alert.serverName} exceeded its configured temperature threshold for the required duration.\n\nSensor: ${alert.sensor}\nCurrent: ${alert.valueC}°C\nThreshold: ${alert.thresholdC}°C\nAbove threshold since: ${new Date(alert.since).toLocaleString()}\n`;
  sendSmtpMessage(subject, text).catch(error => console.error(`SMTP alert failed: ${error.message}`));
}

function publicServer(server) {
  return { id: server.id, name: server.name, address: server.address, username: server.username };
}

function requestJson(target, options = {}, timeout = POLL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const client = url.protocol === 'http:' ? http : https;
    const body = options.body == null ? null : JSON.stringify(options.body);
    const request = client.request(url, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body) } : {}),
        ...(options.headers || {})
      },
      rejectUnauthorized: process.env.ALLOW_SELF_SIGNED === 'false',
      timeout
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 5 * 1024 * 1024) request.destroy(new Error('Redfish response is too large.'));
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          let detail = '';
          try { detail = JSON.parse(body)?.error?.message || ''; } catch { /* Use the status-only error. */ }
          const error = new Error(`BMC returned HTTP ${response.statusCode}${detail ? `: ${detail}` : ''}.`);
          error.statusCode = response.statusCode;
          return reject(error);
        }
        try { resolve({ data:body ? JSON.parse(body) : {}, headers:response.headers, statusCode:response.statusCode }); }
        catch { reject(new Error('BMC returned an invalid JSON response.')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error(`BMC did not respond within ${timeout / 1000} seconds.`)));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function credentialFingerprint(server) {
  return crypto.createHash('sha256').update(`${server.address}\0${server.username}\0${server.password}`).digest('hex');
}

async function createBmcSession(server) {
  const fingerprint = credentialFingerprint(server);
  const existing = bmcSessions.get(server.id);
  if (existing?.fingerprint === fingerprint) return existing;
  if (bmcSessionPromises.has(server.id)) return bmcSessionPromises.get(server.id);
  const operation = requestJson(`${server.address}/redfish/v1/SessionService/Sessions`, {
    method:'POST', body:{ UserName:server.username, Password:server.password }
  }).then(result => {
    const token = result.headers['x-auth-token'];
    if (!token) throw new Error('BMC created a Redfish session without returning an authentication token.');
    const session = { token:String(token), location:String(result.headers.location || ''), fingerprint };
    bmcSessions.set(server.id, session);
    return session;
  }).catch(error => {
    // Older implementations may omit SessionService entirely. Retain Basic
    // authentication only for an explicit unsupported-method response.
    if ([404, 405, 501].includes(Number(error?.statusCode))) {
      const session = { token:null, location:'', fingerprint, basicFallback:true };
      bmcSessions.set(server.id, session);
      return session;
    }
    throw error;
  }).finally(() => bmcSessionPromises.delete(server.id));
  bmcSessionPromises.set(server.id, operation);
  return operation;
}

async function redfishGet(server, target, retrySession = true) {
  const session = await createBmcSession(server);
  const headers = session.basicFallback
    ? { Authorization:`Basic ${Buffer.from(`${server.username}:${server.password}`).toString('base64')}` }
    : { 'X-Auth-Token':session.token };
  try { return (await requestJson(target, { headers })).data; }
  catch (error) {
    if (retrySession && !session.basicFallback && error?.statusCode === 401) {
      bmcSessions.delete(server.id);
      return redfishGet(server, target, false);
    }
    throw error;
  }
}

function createLimiter(limit) {
  let active = 0;
  const queue = [];
  function drain() {
    while (active < limit && queue.length) {
      const { task, resolve, reject } = queue.shift();
      active += 1;
      task().then(resolve, reject).finally(() => { active -= 1; drain(); });
    }
  }
  return task => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    drain();
  });
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function joinRedfish(base, link) {
  if (!link) return null;
  return new URL(link, `${base}/`).toString();
}

async function safeGet(server, link) {
  if (!link) return null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const task = () => redfishGet(server, joinRedfish(server.address, link));
      return await (server._requestLimiter ? server._requestLimiter(task) : task());
    } catch {
      if (attempt === 0) await delay(150);
    }
  }
  return null;
}

async function getMembers(server, collectionOrLink) {
  const collection = typeof collectionOrLink === 'string'
    ? await safeGet(server, collectionOrLink)
    : collectionOrLink;
  const members = collection?.Members || [];
  const values = await Promise.all(members.map(member => member?.['@odata.id'] ? safeGet(server, member['@odata.id']) : member));
  return values.filter(Boolean);
}

function uniqueSensors(items) {
  const result = new Map();
  for (const item of items.filter(Boolean)) {
    const name = String(item.Name || item.Id || item.MemberId || 'Sensor');
    const existing = result.get(name);
    if (!existing || reading(existing) === null) result.set(name, item);
  }
  return [...result.values()];
}

function statusOf(resource) {
  return resource?.Status?.HealthRollup || resource?.Status?.Health || 'Unknown';
}

function cleanInventoryValue(value) {
  const normalized = String(value || '').trim();
  return /^to be filled by o\.e\.m\.?$/i.test(normalized) ? '' : normalized;
}

function reading(sensor) {
  return sensor?.Reading ?? sensor?.ReadingCelsius ?? sensor?.ReadingVolts ?? sensor?.PowerConsumedWatts ?? null;
}

function percentMetric(resources, names) {
  const lowered = names.map(name => name.toLowerCase());
  for (const item of resources.filter(Boolean)) {
    const label = `${item.Name || ''} ${item.MetricId || ''} ${item.ReadingType || ''}`.toLowerCase();
    if (lowered.some(name => label.includes(name))) {
      const value = Number(item.Reading ?? item.Value ?? item.MetricValue);
      if (Number.isFinite(value)) return Math.max(0, Math.min(100, value));
    }
  }
  return null;
}

async function collectServer(server) {
  const startedAt = Date.now();
  // AST2600 BMCs can drop responses when many member resources are requested
  // simultaneously. Bound concurrency and retry transient member failures.
  server._requestLimiter = createLimiter(4);
  const root = await server._requestLimiter(() => redfishGet(server, `${server.address}/redfish/v1/`));
  const [systems, chassis, managers] = await Promise.all([
    getMembers(server, root.Systems?.['@odata.id'] || '/redfish/v1/Systems'),
    getMembers(server, root.Chassis?.['@odata.id'] || '/redfish/v1/Chassis'),
    getMembers(server, root.Managers?.['@odata.id'] || '/redfish/v1/Managers')
  ]);
  const system = systems[0] || {};
  const chassisItem = chassis[0] || {};
  const manager = managers[0] || {};

  const [processors, memory, thermal, sensors, thermalFans, environment, bios, firmware, ethernet] = await Promise.all([
    getMembers(server, system.Processors?.['@odata.id']),
    getMembers(server, system.Memory?.['@odata.id']),
    safeGet(server, chassisItem.Thermal?.['@odata.id'] || `${chassisItem['@odata.id'] || '/redfish/v1/Chassis/Self'}/Thermal`),
    getMembers(server, chassisItem.Sensors?.['@odata.id']),
    getMembers(server, chassisItem.ThermalSubsystem?.['@odata.id'] ? `${chassisItem.ThermalSubsystem['@odata.id']}/Fans` : null),
    safeGet(server, chassisItem.EnvironmentMetrics?.['@odata.id']),
    safeGet(server, system.Bios?.['@odata.id']),
    getMembers(server, root.UpdateService?.['@odata.id'] ? `${root.UpdateService['@odata.id']}/FirmwareInventory` : '/redfish/v1/UpdateService/FirmwareInventory'),
    getMembers(server, manager.EthernetInterfaces?.['@odata.id'])
  ]);

  const temperatureSources = uniqueSensors([
    ...(thermal?.Temperatures || []).map(item => ({ ...item, Reading: item.ReadingCelsius, Units: '°C' })),
    ...sensors.filter(item => String(item.ReadingType || '').toLowerCase() === 'temperature'),
    ...(Number.isFinite(environment?.TemperatureCelsius?.Reading) ? [{ Name: 'Environment', Reading: environment.TemperatureCelsius.Reading, ReadingUnits: '°C', Status: environment.Status }] : [])
  ]);
  // AMI exposes FSC_INDEX inside the Redfish Temperatures array even though it
  // is a synthetic fan-speed-control demand value, not a physical temperature.
  const fanControlSensor = temperatureSources.find(item => String(item.Name || '').toUpperCase() === 'FSC_INDEX');
  const temperatures = temperatureSources.map(item => ({
    name: item.Name || item.Id || 'Temperature',
    value: reading(item),
    units: item.ReadingUnits || item.Units || '°C',
    health: statusOf(item),
    upperCritical: item.UpperThresholdCritical ?? item.UpperThresholdNonCritical ?? null
  })).filter(item => item.value !== null && String(item.name).toUpperCase() !== 'FSC_INDEX');

  const sensorFans = sensors.filter(item => {
    const type = `${item.ReadingType || ''} ${item.ReadingUnits || ''}`.toLowerCase();
    return type.includes('rotational') || type.includes('rpm') || (/fan/i.test(item.Name || '') && reading(item) !== null);
  });
  const fanSources = uniqueSensors([...(thermal?.Fans || []), ...thermalFans, ...sensorFans]);
  const metricSources = [...sensors, ...fanSources];
  const moduleMemoryGiB = memory.reduce((sum, item) => sum + Number(item.CapacityMiB || 0) / 1024, 0);
  const summaryMemoryGiB = Number(system.MemorySummary?.TotalSystemMemoryGiB);
  const totalMemoryGiB = Number.isFinite(summaryMemoryGiB) && summaryMemoryGiB > 0
    ? summaryMemoryGiB
    : moduleMemoryGiB;
  const populatedMemory = memory.filter(item => Number(item.CapacityMiB || 0) > 0);
  const cpuUsage = percentMetric(metricSources, ['cpu utilization', 'processor utilization', 'cpu usage']);
  const memoryUsage = percentMetric(metricSources, ['memory utilization', 'memory usage']);

  return {
    server: publicServer(server),
    collectedAt: new Date().toISOString(),
    responseMs: Date.now() - startedAt,
    overallHealth: statusOf(system) !== 'Unknown' ? statusOf(system) : statusOf(chassisItem),
    powerState: system.PowerState || 'Unknown',
    identity: {
      manufacturer: system.Manufacturer || chassisItem.Manufacturer || '',
      model: system.Model || chassisItem.Model || '',
      serialNumber: cleanInventoryValue(system.SerialNumber || chassisItem.SerialNumber),
      hostname: system.HostName || '',
      biosVersion: system.BiosVersion || '',
      bmcFirmware: manager.FirmwareVersion || ''
    },
    utilization: { cpuPercent: cpuUsage, memoryPercent: memoryUsage },
    cooling: { fanSpeedControlIndex: fanControlSensor ? reading(fanControlSensor) : null },
    cpu: processors.map(item => ({
      name: item.Name || item.Id,
      model: item.Model || item.ProcessorType || '',
      cores: item.TotalCores ?? null,
      threads: item.TotalThreads ?? null,
      maxMHz: item.MaxSpeedMHz ?? null,
      health: statusOf(item)
    })),
    memory: {
      totalGiB: Math.round(totalMemoryGiB * 10) / 10,
      populatedSlots: populatedMemory.length,
      slots: memory.length,
      modules: populatedMemory.map(item => ({
        name: item.Name || item.Id,
        capacityGiB: Math.round(Number(item.CapacityMiB || 0) / 1024 * 10) / 10,
        type: item.MemoryDeviceType || item.MemoryType || '',
        speedMHz: item.OperatingSpeedMhz ?? item.OperatingSpeedMHz ?? null,
        manufacturer: item.Manufacturer || '',
        health: statusOf(item)
      }))
    },
    temperatures,
    fans: fanSources.map(item => ({
      name: item.Name || item.Id,
      value: item.Reading ?? null,
      units: item.ReadingUnits || '',
      health: statusOf(item),
      state: item.Status?.State || 'Unknown'
    })),
    firmware: firmware.map(item => ({ name: item.Name || item.Id, version: item.Version || '', status: item.Status?.State || '' })),
    settings: {
      boot: system.Boot || {},
      bios: bios?.Attributes || {},
      manager: {
        name: manager.Name || '',
        model: manager.Model || '',
        dateTime: manager.DateTime || '',
        state: manager.Status?.State || ''
      },
      network: ethernet.map(item => ({
        name: item.Name || item.Id,
        hostname: item.HostName || '',
        mac: item.MACAddress || '',
        ipv4: (item.IPv4Addresses || []).map(address => address.Address).filter(Boolean),
        ipv6: (item.IPv6Addresses || []).map(address => address.Address).filter(Boolean)
      }))
    }
  };
}

function numericMap(items) {
  return Object.fromEntries((items || [])
    .filter(item => item.value !== null && item.value !== '' && Number.isFinite(Number(item.value)))
    .map(item => [item.name, Number(item.value)]));
}

function historySnapshot(data) {
  return {
    t: new Date(data.collectedAt).getTime(),
    online: true,
    health: data.overallHealth,
    power: data.powerState,
    cpu: Number.isFinite(data.utilization?.cpuPercent) ? data.utilization.cpuPercent : null,
    memory: Number.isFinite(data.utilization?.memoryPercent) ? data.utilization.memoryPercent : null,
    memoryGiB: Number.isFinite(data.memory?.totalGiB) ? data.memory.totalGiB : null,
    fsc: Number.isFinite(data.cooling?.fanSpeedControlIndex) ? data.cooling.fanSpeedControlIndex : null,
    temperatures: numericMap(data.temperatures),
    fans: numericMap(data.fans)
  };
}

function appendHistory(serverId, snapshot) {
  ensureStorage();
  const previous = lastRecordedAt.get(serverId) || 0;
  if (snapshot.t - previous < 20000) return;
  fs.appendFileSync(historyFile(serverId), `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  lastRecordedAt.set(serverId, snapshot.t);
}

function recordOffline(serverId, error) {
  const now = Date.now();
  appendHistory(serverId, { t: now, online: false, error: String(error?.message || error), temperatures: {}, fans: {} });
}

function nextBmcBackoff(previousDelay = 0) {
  return previousDelay > 0
    ? Math.min(BMC_BACKOFF_MAX_MS, previousDelay * 2)
    : BMC_BACKOFF_INITIAL_MS;
}

function activeBmcBackoff(serverId, now = Date.now()) {
  const backoff = bmcBackoffs.get(serverId);
  if (!backoff || backoff.until <= now) return null;
  const remainingMinutes = Math.max(1, Math.ceil((backoff.until - now) / 60000));
  const error = new Error(`BMC temporarily refused requests (HTTP ${backoff.statusCode}). RackSight paused polling and will retry in about ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}.`);
  error.statusCode = backoff.statusCode;
  error.retryAfterMs = backoff.until - now;
  return error;
}

function applyBmcBackoff(serverId, error, now = Date.now()) {
  if (![401, 403, 429].includes(Number(error?.statusCode))) return error;
  const previous = bmcBackoffs.get(serverId);
  const delay = nextBmcBackoff(previous?.delay || 0);
  bmcBackoffs.set(serverId, { delay, until: now + delay, statusCode: Number(error.statusCode) });
  const minutes = Math.ceil(delay / 60000);
  error.message = `${error.message} RackSight paused polling for ${minutes} minute${minutes === 1 ? '' : 's'} to avoid extending a BMC lockout or rate limit.`;
  error.retryAfterMs = delay;
  return error;
}

function evaluateTemperatureAlerts(server, data, now = Date.now()) {
  loadAlertState();
  const settings = readAlertSettings();
  if (!settings.enabled) {
    for (const [key, alert] of activeAlerts) if (alert.serverId === server.id && alert.type !== 'fan') activeAlerts.delete(key);
    saveAlertState();
    return;
  }
  const seen = new Set();
  for (const sensor of data.temperatures || []) {
    const value = Number(sensor.value);
    if (!Number.isFinite(value)) continue;
    const key = `${server.id}:${sensor.name}`;
    seen.add(key);
    const existing = activeAlerts.get(key);
    if (value > settings.thresholdC) {
      const alert = existing || {
        key,
        id: crypto.randomUUID(),
        serverId: server.id,
        serverName: server.name,
        sensor: sensor.name,
        thresholdC: settings.thresholdC,
        since: now,
        status: 'pending'
      };
      alert.valueC = value;
      alert.lastSeen = now;
      alert.thresholdC = settings.thresholdC;
      if (now - alert.since >= settings.durationMinutes * 60 * 1000 && alert.status !== 'firing') {
        alert.status = 'firing';
        alert.firedAt = now;
        appendAlertEvent({ ...alert, event: 'fired', t: now });
        sendAlertEmail(alert, 'fired');
      }
      activeAlerts.set(key, alert);
    } else if (existing) {
      if (existing.status === 'firing') {
        const resolved = { ...existing, valueC: value };
        appendAlertEvent({ ...resolved, event: 'resolved', t: now });
        sendAlertEmail(resolved, 'resolved');
      }
      activeAlerts.delete(key);
    }
  }
  // Resolve sensors that disappeared from a successful poll rather than
  // leaving stale alerts active indefinitely.
  for (const [key, alert] of activeAlerts) {
    if (alert.serverId === server.id && alert.type !== 'fan' && !seen.has(key)) activeAlerts.delete(key);
  }
  saveAlertState();
}

function fanFailureReason(fan, wasKnown = false) {
  const state = String(fan?.state || '').toLowerCase();
  const health = String(fan?.health || '').toLowerCase();
  const value = fan?.value == null ? null : Number(fan.value);
  if (health && !['ok', 'unknown'].includes(health)) return `health is ${fan.health}`;
  if (wasKnown && ['absent', 'disabled', 'unavailable'].includes(state)) return `state is ${fan.state}`;
  if (!['absent', 'disabled'].includes(state) && Number.isFinite(value) && value <= 0) return 'speed is 0 RPM';
  if (wasKnown && !Number.isFinite(value)) return 'RPM reading is unavailable';
  return null;
}

function evaluateFanAlerts(server, data, now = Date.now()) {
  loadAlertState(); loadFanState();
  const settings = readAlertSettings();
  if (!settings.fanAlertsEnabled) {
    for (const [key, alert] of activeAlerts) if (alert.serverId === server.id && alert.type === 'fan') activeAlerts.delete(key);
    saveAlertState(); return;
  }
  for (const fan of data.fans || []) {
    const key = `${server.id}:fan:${fan.name}`;
    const wasKnown = knownFans.has(key);
    const value = fan.value == null ? null : Number(fan.value);
    const state = String(fan.state || '').toLowerCase();
    const health = String(fan.health || '').toLowerCase();
    const explicitlyPresent = !['absent', 'disabled', 'unavailable'].includes(state) && (Number.isFinite(value) || !['', 'ok', 'unknown'].includes(health));
    if (Number.isFinite(value) && value > 0 && state !== 'absent') knownFans.set(key, { key, serverId:server.id, sensor:fan.name, lastHealthyRpm:value, lastSeen:now });
    if (!wasKnown && !explicitlyPresent) continue;
    const reason = fanFailureReason(fan, wasKnown);
    const existing = activeAlerts.get(key);
    if (reason) {
      const alert = existing || { key, id:crypto.randomUUID(), type:'fan', serverId:server.id, serverName:server.name, sensor:fan.name, since:now, status:'pending' };
      alert.valueRpm = Number.isFinite(value) ? value : null; alert.reason = reason; alert.lastSeen = now;
      if (now - alert.since >= settings.fanFailureDurationMinutes * 60000 && alert.status !== 'firing') {
        alert.status = 'firing'; alert.firedAt = now;
        appendAlertEvent({ ...alert, event:'fired', t:now }); sendAlertEmail(alert, 'fired');
      }
      activeAlerts.set(key, alert);
    } else if (existing) {
      if (existing.status === 'firing') { const resolved = { ...existing, valueRpm:value }; appendAlertEvent({ ...resolved, event:'resolved', t:now }); sendAlertEmail(resolved, 'resolved'); }
      activeAlerts.delete(key);
    }
  }
  saveFanState(); saveAlertState();
}

function getActiveAlerts() {
  loadAlertState();
  return [...activeAlerts.values()].sort((a, b) => b.since - a.since);
}

function readAlertEvents(limit = 100) {
  if (!fs.existsSync(ALERT_EVENTS_FILE)) return [];
  return fs.readFileSync(ALERT_EVENTS_FILE, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }).slice(-Math.max(1, Math.min(500, limit))).reverse();
}

async function pollServer(server, force = false, startup = false) {
  const paused = !force && activeBmcBackoff(server.id);
  if (paused) {
    recordOffline(server.id, paused);
    throw paused;
  }
  const cached = recentData.get(server.id);
  if (!force && cached && Date.now() - cached.time < DATA_CACHE_MS) return cached.data;
  if (pollInFlight.has(server.id)) return pollInFlight.get(server.id);
  // Startup gives every BMC a start slot within ten seconds. Steady-state
  // collection starts are spread evenly across the polling minute.
  const enqueue = startup ? enqueueStartupCollection : enqueueCollection;
  const operation = enqueue(() => collectServer(server))
    .then(data => {
      bmcBackoffs.delete(server.id);
      recentData.set(server.id, { time: Date.now(), data });
      appendHistory(server.id, historySnapshot(data));
      evaluateTemperatureAlerts(server, data);
      evaluateFanAlerts(server, data);
      return data;
    })
    .catch(error => {
      applyBmcBackoff(server.id, error);
      recordOffline(server.id, error);
      throw error;
    })
    .finally(() => pollInFlight.delete(server.id));
  pollInFlight.set(server.id, operation);
  return operation;
}

function summarizeMap(target, source) {
  for (const [name, rawValue] of Object.entries(source || {})) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    const entry = target[name] || { sum: 0, count: 0, peak: null };
    entry.sum += value;
    entry.count += 1;
    entry.peak = entry.peak == null ? value : Math.max(entry.peak, value);
    target[name] = entry;
  }
}

function downsampleHistory(points, bucketMs) {
  const buckets = new Map();
  for (const point of points) {
    const key = Math.floor(point.t / bucketMs) * bucketMs;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { t: key, samples: 0, online: 0, health: point.health, cpu: 0, cpuCount: 0, cpuPeak: null, memory: 0, memoryCount: 0, memoryPeak: null, memoryGiB: 0, memoryGiBCount: 0, memoryGiBPeak: null, fsc: 0, fscCount: 0, fscPeak: null, temperatures: {}, fans: {} };
      buckets.set(key, bucket);
    }
    bucket.samples += 1;
    bucket.online += point.online ? 1 : 0;
    for (const field of ['cpu', 'memory', 'memoryGiB', 'fsc']) {
      if (Number.isFinite(point[field])) {
        bucket[field] += point[field];
        bucket[`${field}Count`] += 1;
        bucket[`${field}Peak`] = bucket[`${field}Peak`] == null ? point[field] : Math.max(bucket[`${field}Peak`], point[field]);
      }
    }
    if (point.health && point.health !== 'OK') bucket.health = point.health;
    summarizeMap(bucket.temperatures, point.temperatures);
    summarizeMap(bucket.fans, point.fans);
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t).map(bucket => ({
    t: bucket.t,
    onlinePercent: Math.round(bucket.online / bucket.samples * 1000) / 10,
    health: bucket.health || 'Unknown',
    cpu: bucket.cpuCount ? Math.round(bucket.cpu / bucket.cpuCount * 10) / 10 : null,
    cpuPeak: bucket.cpuPeak,
    memory: bucket.memoryCount ? Math.round(bucket.memory / bucket.memoryCount * 10) / 10 : null,
    memoryPeak: bucket.memoryPeak,
    memoryGiB: bucket.memoryGiBCount ? Math.round(bucket.memoryGiB / bucket.memoryGiBCount * 10) / 10 : null,
    memoryGiBPeak: bucket.memoryGiBPeak,
    fsc: bucket.fscCount ? Math.round(bucket.fsc / bucket.fscCount * 10) / 10 : null,
    fscPeak: bucket.fscPeak,
    temperatures: Object.fromEntries(Object.entries(bucket.temperatures).map(([name, value]) => [name, Math.round(value.sum / value.count * 10) / 10])),
    temperaturePeaks: Object.fromEntries(Object.entries(bucket.temperatures).map(([name, value]) => [name, value.peak])),
    fans: Object.fromEntries(Object.entries(bucket.fans).map(([name, value]) => [name, Math.round(value.sum / value.count)])),
    fanPeaks: Object.fromEntries(Object.entries(bucket.fans).map(([name, value]) => [name, value.peak]))
  }));
}

const HISTORY_RANGES = {
  '1h': { duration: 60 * 60 * 1000, bucket: 60 * 1000 },
  '4h': { duration: 4 * 60 * 60 * 1000, bucket: 2 * 60 * 1000 },
  '24h': { duration: 24 * 60 * 60 * 1000, bucket: 5 * 60 * 1000 },
  '7d': { duration: 7 * 24 * 60 * 60 * 1000, bucket: 30 * 60 * 1000 },
  '30d': { duration: 30 * 24 * 60 * 60 * 1000, bucket: 2 * 60 * 60 * 1000 }
};

function readHistory(serverId, rangeName = '24h') {
  const range = HISTORY_RANGES[rangeName] || HISTORY_RANGES['24h'];
  const file = historyFile(serverId);
  const cutoff = Date.now() - range.duration;
  if (!fs.existsSync(file)) return { range: rangeName, from: cutoff, to: Date.now(), intervalMs: range.bucket, points: [] };
  const points = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try {
      const point = JSON.parse(line);
      return Number(point.t) >= cutoff ? [point] : [];
    } catch { return []; }
  });
  return { range: rangeName, from: cutoff, to: Date.now(), intervalMs: range.bucket, points: downsampleHistory(points, range.bucket) };
}

function pruneHistory() {
  ensureStorage();
  const cutoff = Date.now() - HISTORY_RETENTION_MS;
  for (const fileName of fs.readdirSync(HISTORY_DIR).filter(name => name.endsWith('.jsonl'))) {
    const file = path.join(HISTORY_DIR, fileName);
    const retained = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).filter(line => {
      try { return Number(JSON.parse(line).t) >= cutoff; } catch { return false; }
    });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, retained.length ? `${retained.join('\n')}\n` : '', { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
}

async function pollAllServers(startup = false) {
  let servers;
  try { servers = readServers(); } catch (error) { console.error(`History poll: ${error.message}`); return; }
  await Promise.allSettled(servers.map(server => pollServer(server, false, startup)));
}

function startHistoryPolling() {
  pruneHistory();
  const runCycle = async (startup = false) => {
    const cycleStartedAt = Date.now();
    await pollAllServers(startup);
    const waitMs = Math.max(0, cycleStartedAt + HISTORY_INTERVAL_MS - Date.now());
    const next = setTimeout(() => runCycle(false), waitMs);
    next.unref?.();
  };
  runCycle(true).catch(error => console.error(`History poll: ${error.message}`));
  const pruneTimer = setInterval(pruneHistory, 6 * 60 * 60 * 1000);
  pruneTimer.unref?.();
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) request.destroy(new Error('Request body is too large.'));
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Request body must be valid JSON.')); }
    });
    request.on('error', reject);
  });
}

function serveStatic(request, response) {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
  response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(response);
  return true;
}

async function handleApi(request, response, pathname) {
  const segments = pathname.split('/').filter(Boolean);
  const requestUrl = new URL(request.url, 'http://localhost');
  try {
    if (request.method === 'GET' && pathname === '/api/alert-settings') {
      return json(response, 200, readAlertSettings());
    }
    if (request.method === 'PUT' && pathname === '/api/alert-settings') {
      return json(response, 200, writeAlertSettings(await readBody(request)));
    }
    if (request.method === 'GET' && pathname === '/api/alerts/active') {
      return json(response, 200, getActiveAlerts());
    }
    if (request.method === 'GET' && pathname === '/api/alerts/events') {
      return json(response, 200, readAlertEvents(Number(requestUrl.searchParams.get('limit') || 100)));
    }
    if (request.method === 'GET' && pathname === '/api/smtp-settings') {
      return json(response, 200, readSmtpSettings(false));
    }
    if (request.method === 'PUT' && pathname === '/api/smtp-settings') {
      return json(response, 200, writeSmtpSettings(await readBody(request)));
    }
    if (request.method === 'POST' && pathname === '/api/smtp/test') {
      const result = await sendSmtpMessage('[RackSight] Test notification', `RackSight SMTP notifications are configured correctly.\n\nSent: ${new Date().toLocaleString()}\n`, true);
      return json(response, 200, { ok: true, ...result });
    }
    if (request.method === 'GET' && pathname === '/api/servers') {
      return json(response, 200, readServers().map(publicServer));
    }
    if (request.method === 'POST' && pathname === '/api/servers') {
      const body = await readBody(request);
      const address = normalizeBaseUrl(body.address);
      if (!String(body.username || '').trim()) throw new Error('A username is required.');
      const servers = readServers();
      const existing = body.id ? servers.find(item => item.id === body.id) : null;
      if (!existing && !body.password) throw new Error('A password is required.');
      const record = existing || { id: crypto.randomUUID() };
      record.name = String(body.name || new URL(address).hostname).trim();
      record.address = address;
      record.username = String(body.username).trim();
      if (body.password) record.password = String(body.password);
      if (existing) servers.splice(servers.indexOf(existing), 1, record); else servers.push(record);
      writeServers(servers);
      // A saved address or credential change must be tested immediately. Do not
      // leave the server trapped behind a cooldown created by the old values.
      bmcBackoffs.delete(record.id);
      recentData.delete(record.id);
      bmcSessions.delete(record.id);
      return json(response, existing ? 200 : 201, publicServer(record));
    }
    if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'servers' && request.method === 'DELETE') {
      const servers = readServers();
      const next = servers.filter(item => item.id !== segments[2]);
      if (next.length === servers.length) return json(response, 404, { error: 'Server not found.' });
      writeServers(next);
      bmcBackoffs.delete(segments[2]);
      recentData.delete(segments[2]);
      bmcSessions.delete(segments[2]);
      response.writeHead(204); return response.end();
    }
    if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'servers' && segments[3] === 'data' && request.method === 'GET') {
      const server = readServers().find(item => item.id === segments[2]);
      if (!server) return json(response, 404, { error: 'Server not found.' });
      try { return json(response, 200, await pollServer(server)); }
      catch (error) { return json(response, 502, { error: error.message, server: publicServer(server), collectedAt: new Date().toISOString() }); }
    }
    if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'servers' && segments[3] === 'connect' && request.method === 'POST') {
      const server = readServers().find(item => item.id === segments[2]);
      if (!server) return json(response, 404, { error: 'Server not found.' });
      bmcBackoffs.delete(server.id);
      recentData.delete(server.id);
      try { return json(response, 200, await pollServer(server, true)); }
      catch (error) { return json(response, 502, { error: error.message, server: publicServer(server), collectedAt: new Date().toISOString() }); }
    }
    if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'servers' && segments[3] === 'history' && request.method === 'GET') {
      const server = readServers().find(item => item.id === segments[2]);
      if (!server) return json(response, 404, { error: 'Server not found.' });
      const range = requestUrl.searchParams.get('range') || '24h';
      if (!HISTORY_RANGES[range]) return json(response, 400, { error: 'Range must be 1h, 4h, 24h, 7d, or 30d.' });
      return json(response, 200, readHistory(server.id, range));
    }
    return json(response, 404, { error: 'Not found.' });
  } catch (error) {
    return json(response, 400, { error: error.message });
  }
}

function createApp() {
  return http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname.startsWith('/api/')) return void handleApi(request, response, pathname);
    if (!['GET', 'HEAD'].includes(request.method) || !serveStatic(request, response)) json(response, 404, { error: 'Not found.' });
  });
}

function checkForUpdates() {
  const options = { hostname: 'api.github.com', path: '/repos/AuthorityGate/RackSight/releases/latest', headers: { 'User-Agent': 'AuthorityGate-RackSight-IIS', Accept: 'application/vnd.github+json' } };
  https.get(options, response => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { if (body.length < 1024 * 1024) body += chunk; });
    response.on('end', () => {
      try {
        const release = JSON.parse(body);
        const latest = String(release.tag_name || '').replace(/^v/i, '');
        const asset = Array.isArray(release.assets) ? release.assets.find(item => /^RackSight-IIS-Server-.*\.exe$/i.test(item.name)) : null;
        ensureStorage();
        fs.writeFileSync(UPDATE_FILE, JSON.stringify({ current: APP_VERSION, latest, updateAvailable: Boolean(asset && latest && latest !== APP_VERSION), assetName: asset?.name || null, checkedAt: new Date().toISOString() }, null, 2));
        if (asset && latest !== APP_VERSION) console.log(`RackSight IIS update available: ${latest} (${asset.name})`);
      } catch (error) { console.warn(`RackSight update check failed: ${error.message}`); }
    });
  }).on('error', error => console.warn(`RackSight update check failed: ${error.message}`));
}

if (require.main === module) {
  createApp().listen(PORT, HOST, () => {
    console.log(`RackSight dashboard: http://${HOST}:${PORT}`);
    console.log(`History: sampling every ${Math.round(HISTORY_INTERVAL_MS / 1000)}s, retaining 31 days`);
    startHistoryPolling();
    checkForUpdates();
    setInterval(checkForUpdates, 24 * 60 * 60 * 1000).unref();
  });
}

module.exports = { normalizeBaseUrl, encrypt, decrypt, statusOf, cleanInventoryValue, percentMetric, createLimiter, createStaggeredQueue, historyPollSpacingMs, startupPollSpacingMs, fanFailureReason, uniqueSensors, validateAlertSettings, validateSmtpSettings, historySnapshot, downsampleHistory, nextBmcBackoff, readHistory, startHistoryPolling, createApp, readServers, collectServer };
