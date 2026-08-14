'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBaseUrl, encrypt, decrypt, statusOf, cleanInventoryValue, percentMetric, createLimiter, uniqueSensors, validateAlertSettings, validateSmtpSettings, historySnapshot, downsampleHistory } = require('../server');

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

test('validates alert and SMTP settings', () => {
  assert.equal(validateAlertSettings({ thresholdC:80, durationMinutes:5, cooldownMinutes:30 }).thresholdC, 80);
  assert.throws(() => validateAlertSettings({ thresholdC:150, durationMinutes:5, cooldownMinutes:30 }), /threshold/);
  const smtp = validateSmtpSettings({ enabled:true, host:'smtp.example.com', port:587, secure:false, username:'user', password:'secret', from:'rack@example.com', to:'ops@example.com' });
  assert.equal(smtp.port, 587);
  assert.equal(smtp.to, 'ops@example.com');
});
