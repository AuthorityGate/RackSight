'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeBaseUrl, encrypt, decrypt, statusOf, cleanInventoryValue, percentMetric, createLimiter, createStaggeredQueue, historyPollSpacingMs, startupPollSpacingMs, uniqueSensors, validateAlertSettings, validateMonitoringSettings, isPresentFan, historySnapshot, downsampleHistory, nextBmcBackoff, managerResetTarget, safeManagerResetTypes } = require('../server');
const { normalizeEmail, validateApiUrl, encodeEnrollmentQr, encryptMobilePayload, decryptMobilePayload, createMobileService } = require('../mobile');

test('normalizes BMC hostnames and addresses', () => {
  assert.equal(normalizeBaseUrl('bmc01.example.com'), 'https://bmc01.example.com');
  assert.equal(normalizeBaseUrl('http://10.0.0.5/'), 'http://10.0.0.5');
  assert.throws(() => normalizeBaseUrl('ftp://host'), /Only HTTP/);
});

test('encrypts and decrypts credentials', () => {
  const value = [{ username: 'admin', password: 'secret' }];
  const encoded = encrypt(value);
  assert.notEqual(encoded.data, JSON.stringify(value));
  assert.deepEqual(decrypt(encoded), value);
});

test('extracts health and utilization metrics', () => {
  assert.equal(statusOf({ Status: { HealthRollup: 'Warning', Health: 'OK' } }), 'Warning');
  assert.equal(percentMetric([{ Name: 'CPU Utilization', Reading: 42.4 }], ['cpu utilization']), 42.4);
  assert.equal(percentMetric([], ['cpu utilization']), null);
});

test('removes unprogrammed OEM inventory placeholders', () => {
  assert.equal(cleanInventoryValue('To be filled by O.E.M.     '), '');
  assert.equal(cleanInventoryValue('AG-ESX-0003'), 'AG-ESX-0003');
});

test('limits concurrent BMC member requests', async () => {
  const limit = createLimiter(2);
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 8 }, () => limit(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
  }));
  await Promise.all(tasks);
  assert.equal(peak, 2);
});

test('splits the polling minute evenly across the configured fleet', () => {
  assert.equal(historyPollSpacingMs(3), 20000);
  assert.equal(historyPollSpacingMs(6), 10000);
  assert.equal(historyPollSpacingMs(12), 5000);
  assert.equal(historyPollSpacingMs(60), 1000);
});

test('starts the entire fleet within the ten-second bootstrap window', () => {
  assert.equal(startupPollSpacingMs(1), 0);
  assert.equal(startupPollSpacingMs(3), 10000 / 3);
  assert.equal(startupPollSpacingMs(6), 10000 / 6);
  assert.ok(startupPollSpacingMs(60) * 59 < 10000);
});

test('staggering controls start order without waiting for prior scans to finish', async () => {
  const enqueue = createStaggeredQueue(() => 0);
  let active = 0;
  let peak = 0;
  const order = [];
  const jobs = [1, 2, 3].map(id => enqueue(async () => {
    active += 1;
    peak = Math.max(peak, active);
    order.push(`start-${id}`);
    await new Promise(resolve => setTimeout(resolve, 5));
    order.push(`end-${id}`);
    active -= 1;
  }));
  await Promise.all(jobs);
  assert.equal(peak, 3);
  assert.deepEqual(order.slice(0, 3), ['start-1', 'start-2', 'start-3']);
});

test('backs off repeated BMC authentication and rate-limit responses', () => {
  assert.equal(nextBmcBackoff(), 5 * 60 * 1000);
  assert.equal(nextBmcBackoff(5 * 60 * 1000), 10 * 60 * 1000);
  assert.equal(nextBmcBackoff(10 * 60 * 1000), 10 * 60 * 1000);
  assert.equal(nextBmcBackoff(0, 2 * 60 * 1000), 2 * 60 * 1000);
});

test('permits only Redfish Manager restart actions and never host resets', () => {
  const server = { address:'https://bmc.example.com' };
  assert.equal(managerResetTarget(server, '/redfish/v1/Managers/1/Actions/Manager.Reset'), 'https://bmc.example.com/redfish/v1/Managers/1/Actions/Manager.Reset');
  assert.throws(() => managerResetTarget(server, '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset'), /never be reset/);
  assert.throws(() => managerResetTarget(server, 'https://other.example.com/redfish/v1/Managers/1/Actions/Manager.Reset'), /unsafe external/);
  assert.deepEqual(safeManagerResetTypes(['ForceOff','On','ForceRestart','GracefulRestart']), ['GracefulRestart','ForceRestart']);
});

test('limits configurable BMC polling to whole minutes from two through ten', () => {
  assert.deepEqual(validateMonitoringSettings({ pollIntervalMinutes:5 }), { pollIntervalMinutes:5 });
  assert.deepEqual(validateMonitoringSettings({ pollIntervalMinutes:2 }), { pollIntervalMinutes:2 });
  assert.deepEqual(validateMonitoringSettings({ pollIntervalMinutes:10 }), { pollIntervalMinutes:10 });
  assert.throws(() => validateMonitoringSettings({ pollIntervalMinutes:1 }), /2 to 10/);
  assert.throws(() => validateMonitoringSettings({ pollIntervalMinutes:2.5 }), /whole number/);
});

test('creates compact history snapshots without full settings', () => {
  const snapshot = historySnapshot({
    collectedAt: '2026-08-14T12:00:00Z', overallHealth: 'OK', powerState: 'On',
    utilization: { cpuPercent: 25, memoryPercent: null }, memory: { totalGiB: 256 },
    cooling: { fanSpeedControlIndex: 70 },
    temperatures: [{ name: 'TEMP_CPU', value: 61 }],
    fans: [{ name: 'FAN1_1', value: 3000 }, { name: 'FAN2_1', value: null }], settings: { bios: { Secret: true } }
  });
  assert.equal(snapshot.memoryGiB, 256);
  assert.equal(snapshot.temperatures.TEMP_CPU, 61);
  assert.equal(snapshot.fans.FAN1_1, 3000);
  assert.equal('FAN2_1' in snapshot.fans, false);
  assert.equal('settings' in snapshot, false);
});

test('downsamples history into average and peak time buckets', () => {
  const points = downsampleHistory([
    { t: 1000, online: true, cpu: 20, memory: 30, fsc: 70, temperatures: { TEMP_CPU: 50 }, fans: { FAN1: 3000 } },
    { t: 2000, online: true, cpu: 40, memory: 50, fsc: 80, temperatures: { TEMP_CPU: 60 }, fans: { FAN1: 5000 } }
  ], 5000);
  assert.equal(points.length, 1);
  assert.equal(points[0].cpu, 30);
  assert.equal(points[0].cpuPeak, 40);
  assert.equal(points[0].memory, 40);
  assert.equal(points[0].memoryPeak, 50);
  assert.equal(points[0].fsc, 75);
  assert.equal(points[0].fscPeak, 80);
  assert.equal(points[0].temperatures.TEMP_CPU, 55);
  assert.equal(points[0].temperaturePeaks.TEMP_CPU, 60);
  assert.equal(points[0].fans.FAN1, 4000);
  assert.equal(points[0].fanPeaks.FAN1, 5000);
  assert.equal(points[0].onlinePercent, 100);
});

test('accepts standard and expanded Redfish sensor shapes', () => {
  const sensors = uniqueSensors([{ Name:'Fan 1', Reading:null }, { Name:'Fan 1', Reading:4200 }, { Id:'Temp 1', Reading:50 }]);
  assert.equal(sensors.length, 2);
  assert.equal(sensors.find(item => item.Name === 'Fan 1').Reading, 4200);
});

test('validates temperature and fan alert settings', () => {
  const settings = validateAlertSettings({ thresholdC:80, fanAlerts:true, minimumFanRpm:500, durationMinutes:5, cooldownMinutes:30 });
  assert.equal(settings.thresholdC, 80);
  assert.equal(settings.minimumFanRpm, 500);
  assert.throws(() => validateAlertSettings({ thresholdC:150, minimumFanRpm:500, durationMinutes:5, cooldownMinutes:30 }), /threshold/);
  assert.throws(() => validateAlertSettings({ thresholdC:80, minimumFanRpm:-1, durationMinutes:5, cooldownMinutes:30 }), /fan speed/);
});

test('learns only physically present fan sensors', () => {
  assert.equal(isPresentFan({ state:'Absent', value:null }), false);
  assert.equal(isPresentFan({ state:'Enabled', value:null }), true);
  assert.equal(isPresentFan({ state:'Enabled', value:0 }), true);
  assert.equal(isPresentFan({ state:'Unknown', value:3200 }), true);
});

test('validates mobile addresses and requires HTTPS outside local development', () => {
  assert.equal(normalizeEmail(' Admin@Example.com '), 'admin@example.com');
  assert.throws(() => normalizeEmail('not-an-email'), /valid email/);
  assert.equal(validateApiUrl('https://license.authoritygate.com/api/').endsWith('/api'), true);
  assert.equal(validateApiUrl('http://127.0.0.1:8080/api'), 'http://127.0.0.1:8080/api');
  assert.throws(() => validateApiUrl('http://example.com/api'), /HTTPS/);
});

test('mobile telemetry uses authenticated end-to-end encryption', () => {
  const key = Buffer.alloc(32, 7).toString('base64url');
  const value = { schemaVersion:1, servers:[{ name:'rack-01', health:'OK' }] };
  const envelope = encryptMobilePayload(value, key, 'installation-1');
  assert.equal(envelope.algorithm, 'A256GCM');
  assert.equal(envelope.ciphertext.includes('rack-01'), false);
  assert.deepEqual(decryptMobilePayload(envelope, key, 'installation-1'), value);
  assert.throws(() => decryptMobilePayload(envelope, key, 'another-installation'));
});

test('uses a compact fixed-width QR enrollment payload', () => {
  const encoded = encodeEnrollmentQr({
    installation_id:'11111111-2222-4333-8444-555555555555',
    enrollment_id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    pairing_token:Buffer.alloc(32, 3).toString('base64url'),
    data_key:Buffer.alloc(32, 7).toString('base64url'),
    expires_at:'2026-08-15T01:00:00.000Z'
  });
  assert.equal(encoded.startsWith('RS1:'), true);
  assert.equal(encoded.length, 139);
  assert.equal(Buffer.from(encoded.slice(4), 'base64url').length, 101);
  assert.equal(encoded.includes('authoritygate.com'), false);
  assert.equal(encoded.includes('@'), false);
});

test('mobile owner verification enables short-lived QR enrollment without exposing secrets in status', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'racksight-mobile-test-'));
  const requests = [];
  const replies = [
    { challenge_id:'challenge-1' },
    { installation_id:'11111111-2222-4333-8444-555555555555', installation_token:'installation-token-secret' },
    {
      enrollment_id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      pairing_token:Buffer.alloc(32, 3).toString('base64url'),
      expires_at:new Date(Date.now() + 300000).toISOString()
    }
  ];
  const service = createMobileService({
    dataDir: directory,
    encryptStore: value => ({ v:1, value }),
    decryptStore: value => value.value,
    apiUrl: 'http://127.0.0.1:8080/api/racksight/mobile/v1',
    fetchFn: async (url, options) => {
      requests.push({ url, options });
      return { ok:true, status:200, text:async () => JSON.stringify(replies.shift()) };
    }
  });
  try {
    let status = await service.requestOwnerCode({ email:' Owner@Example.com ', company:'Example' });
    assert.equal(status.status, 'verification-required');
    status = await service.verifyOwnerCode({ code:'123456' });
    assert.equal(status.configured, true);
    assert.equal(JSON.stringify(status).includes('installation-token-secret'), false);
    const enrollment = await service.createEnrollment({ email:'person@example.com' });
    assert.match(enrollment.qrSvg, /^<svg/);
    assert.equal(enrollment.email, 'person@example.com');
    assert.equal(requests[2].options.headers.Authorization, 'Bearer installation-token-secret');
  } finally {
    fs.rmSync(directory, { recursive:true, force:true });
  }
});

test('desktop updater completes the download before silent forced installation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.match(source, /updateDownloadPromise = autoUpdater\.downloadUpdate\(\)/);
  assert.match(source, /await updateDownloadPromise/);
  assert.match(source, /downloadedFiles\.some\(file => fs\.existsSync\(file\)\)/);
  assert.match(source, /autoUpdater\.quitAndInstall\(true, true\)/);
  assert.match(source, /autoUpdater\.autoRunAppAfterInstall = true/);
});
