'use strict';

const THEME_NAMES = ['corporate','chocolate','charcoal'];
const THEME_LOGOS = {
  corporate:'/racksight-icon.png',
  chocolate:'/racksight-icon-chocolate.png',
  charcoal:'/racksight-icon-charcoal.png'
};
const MIT_LICENSE = `MIT License

Copyright (c) 2026 AuthorityGate

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const savedTheme = THEME_NAMES.includes(localStorage.getItem('racksight-theme')) ? localStorage.getItem('racksight-theme') : 'corporate';
document.documentElement.dataset.theme = savedTheme;
const savedChartMode = localStorage.getItem('racksight-chart-mode') === '3d' ? '3d' : '2d';
const state = { servers: [], data: new Map(), timer: null, alertTimer: null, detailServerId: null, historyRange: '24h', historyData:null, chartMode:savedChartMode, showFanPeaks:false, hiddenFans:new Set(), view: 'overview', theme:savedTheme, alertSettings: null, monitoringSettings: null, mobileSettings: null, mobileEnrollment: null, alerts: [], notifiedAlerts: new Set(), updateState: { supported:Boolean(window.rackSightDesktop), status:window.rackSightDesktop ? 'idle' : 'unavailable', currentVersion:null, availableVersion:null, checkedAt:null, error:null } };
const requestedView = new URLSearchParams(window.location.search).get('view');
if (['overview','hardware','settings','help'].includes(requestedView)) state.view = requestedView;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function enforceLegalReview() {
  const accepted = localStorage.getItem('racksight-mit-accepted') === '2026';
  $('#legalGate').classList.toggle('hidden', accepted);
  document.body.classList.toggle('legal-review-required', !accepted);
}

$('#acceptMitLicense').addEventListener('click', () => {
  localStorage.setItem('racksight-mit-accepted', '2026');
  enforceLegalReview();
});
enforceLegalReview();

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
  return body;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}

function healthClass(health) {
  const value = String(health || '').toLowerCase();
  if (['ok', 'healthy', 'online'].includes(value)) return '';
  if (['warning', 'degraded'].includes(value)) return 'warning';
  return 'error';
}

function formatPercent(value) { return value == null ? 'N/A' : `${Math.round(value)}%`; }
function maxTemperature(item) {
  if (!item?.temperatures?.length) return null;
  return Math.max(...item.temperatures.map(sensor => Number(sensor.value)).filter(Number.isFinite));
}
function showToast(message) {
  const toast = $('#toast'); toast.textContent = message; toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 2500);
}

function updateStatusText(update) {
  const labels = {
    idle:'The automatic startup check is scheduled.',
    checking:'Checking for a newer RackSight release…',
    current:'RackSight is up to date.',
    available:`RackSight ${update.availableVersion || ''} is available.`,
    downloading:`Downloading RackSight ${update.availableVersion || ''}…`,
    downloaded:`RackSight ${update.availableVersion || ''} is ready to install.`,
    installing:`Installing RackSight ${update.availableVersion || ''} and restarting…`,
    error:`Update check failed: ${update.error || 'The release service could not be reached.'}`,
    unavailable:'Update checks are available in the installed Windows desktop application.'
  };
  return labels[update.status] || 'Update status is not available.';
}

function render() {
  const hasServers = state.servers.length > 0;
  $('#emptyState').classList.toggle('hidden', hasServers || state.view !== 'overview');
  $('#dashboard').classList.toggle('hidden', !hasServers || state.view !== 'overview');
  $('#secondaryView').classList.toggle('hidden', state.view === 'overview' || (!hasServers && !['settings','help'].includes(state.view)));
  renderPageHeader();
  if (!state.servers.length) {
    if (['settings','help'].includes(state.view)) renderSecondaryView();
    return;
  }
  const records = state.servers.map(server => state.data.get(server.id));
  const successful = records.filter(item => item && !item.error && item.connectivity?.online !== false);
  const healthy = successful.filter(item => String(item.overallHealth).toLowerCase() === 'ok').length;
  const warnings = records.filter(item => item?.error || !['ok', 'unknown'].includes(String(item?.overallHealth).toLowerCase())).length;
  const responses = successful.map(item => item.responseMs).filter(Number.isFinite);
  $('#serverCount').textContent = state.servers.length;
  $('#onlineCount').textContent = `${successful.length} reachable`;
  $('#healthyCount').textContent = healthy;
  $('#warningCount').textContent = warnings;
  $('#responseTime').textContent = responses.length ? `${Math.round(responses.reduce((a,b) => a+b, 0) / responses.length)}ms` : '—';
  const stamps = successful.map(item => new Date(item.collectedAt).getTime()).filter(Number.isFinite);
  $('#lastUpdated').textContent = stamps.length ? `Updated ${new Date(Math.max(...stamps)).toLocaleTimeString()}` : 'Connecting…';
  $('#serverGrid').innerHTML = state.servers.map(server => renderCard(server, state.data.get(server.id))).join('');
  if (state.view !== 'overview' && !(state.view === 'settings' && document.activeElement?.closest?.('form'))) renderSecondaryView();
  renderAlertIndicator();
}

function renderPageHeader() {
  const pages = {
    overview: ['INFRASTRUCTURE','System overview','Health and telemetry across your Redfish-managed servers.'],
    hardware: ['INVENTORY','Hardware','Compare processors, memory, temperatures, and cooling across every server.'],
    settings: ['CONFIGURATION','Settings','Manage BMC connections and review monitoring and system configuration.'],
    help: ['HELP AND LEGAL','Help','Understand RackSight alerts, its read-only Android design, security boundaries, and MIT License.']
  };
  const [eyebrow,title,subtitle] = pages[state.view] || pages.overview;
  $('#pageEyebrow').textContent = eyebrow; $('#pageTitle').textContent = title; $('#pageSubtitle').textContent = subtitle;
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === state.view));
}

function serverStatus(server) {
  const item = state.data.get(server.id);
  if (!item) return { label:'Connecting', css:'warning' };
  if (item.error || item.connectivity?.online === false) return { label:'Offline', css:'error' };
  return { label:item.overallHealth || 'Unknown', css:healthClass(item.overallHealth) };
}

function offlineDuration(value) {
  const start = new Date(value).getTime();
  if (!Number.isFinite(start)) return 'duration unknown';
  const totalMinutes = Math.max(0, Math.floor((Date.now() - start) / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return `${days ? `${days}d ` : ''}${hours}h ${minutes}m`;
}

function offlineNotice(item) {
  if (item?.connectivity?.online !== false) return '';
  const lastSeen = item.connectivity.lastSeenAt || item.collectedAt;
  return `<div class="offline-notice"><strong>Showing last known data</strong><span>Last seen ${escapeHtml(lastSeen ? new Date(lastSeen).toLocaleString() : 'unknown')} · Offline ${escapeHtml(offlineDuration(item.connectivity.offlineSince))}</span><small>${escapeHtml(item.connectivity.error || 'The BMC is not responding.')}</small></div>`;
}

function renderHardwareView() {
  const cards = state.servers.map(server => {
    const item = state.data.get(server.id); const status = serverStatus(server);
    if (!item || item.error) return `<article class="inventory-card"><div class="inventory-head"><div><h2>${escapeHtml(server.name)}</h2><p>${escapeHtml(server.address)}</p></div><span class="health ${status.css}">${escapeHtml(status.label)}</span></div><div class="error-message">${escapeHtml(item?.error || 'Loading hardware inventory…')}</div></article>`;
    const cpu = item.cpu[0] || {};
    const presentFans = item.fans.filter(fan => fan.state !== 'Absent' && fan.value != null);
    return `<article class="inventory-card ${item.connectivity?.online === false ? 'offline-card' : ''}"><div class="inventory-head"><div><h2>${escapeHtml(server.name)}</h2><p>${escapeHtml(item.identity.model || server.address)}</p></div><span class="health ${status.css}">${escapeHtml(status.label)}</span></div>${offlineNotice(item)}<div class="inventory-summary"><div><small>PROCESSOR</small><strong>${escapeHtml(cpu.model || 'Unknown CPU')}</strong><span>${cpu.cores || '—'} cores · ${cpu.threads || '—'} threads</span></div><div><small>MEMORY</small><strong>${escapeHtml(item.memory.totalGiB)} GB</strong><span>${item.memory.populatedSlots} populated DIMMs</span></div><div><small>COOLING</small><strong>${presentFans.length} fans</strong><span>Control index ${escapeHtml(item.cooling?.fanSpeedControlIndex ?? '—')}</span></div></div><div class="inventory-section"><h3>Temperatures</h3><div class="compact-sensors">${item.temperatures.map(sensor => `<span><i>${escapeHtml(sensor.name)}</i><strong>${escapeHtml(sensor.value)}°C</strong></span>`).join('')}</div></div><div class="inventory-section"><h3>Connected fans</h3><div class="compact-sensors">${presentFans.map(fan => `<span><i>${escapeHtml(fan.name)}</i><strong>${escapeHtml(fan.value)} RPM</strong></span>`).join('') || '<p class="muted">No fan readings</p>'}</div></div><div class="inventory-footer"><span>BIOS ${escapeHtml(item.identity.biosVersion || '—')} · BMC ${escapeHtml(item.identity.bmcFirmware || '—')}</span><button class="button ghost small" data-open="${server.id}">View full details</button></div></article>`;
  }).join('');
  return `<div class="view-heading"><div><h2>Hardware inventory</h2><p>Live Redfish inventory grouped by physical server.</p></div><span>${state.servers.length} systems</span></div><div class="inventory-grid">${cards}</div>`;
}

function renderMobileSettings() {
  const mobile = state.mobileSettings || { configured:false, status:'unconfigured', ownerEmail:'', devices:[] };
  const statusLabel = mobile.configured ? 'Configured' : mobile.status === 'verification-required' ? 'Verification required' : 'Unconfigured';
  const statusClass = mobile.configured ? '' : 'disabled';
  const sync = mobile.lastSyncAt ? new Date(mobile.lastSyncAt).toLocaleString() : 'Never';
  const error = mobile.lastError ? `<div class="error-message">${escapeHtml(mobile.lastError)}</div>` : '';
  let setup;
  if (mobile.status === 'verification-required') {
    setup = `<form id="mobileOwnerVerifyForm" class="config-form inline-config"><label>Six-digit email code<input id="mobileOwnerCode" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label><button class="button primary" type="submit">Verify owner</button></form><p class="muted">The code sent to ${escapeHtml(mobile.ownerEmail)} expires after 10 minutes.</p>`;
  } else if (!mobile.configured) {
    setup = `<form id="mobileOwnerForm" class="config-form inline-config"><label>Owner email<input id="mobileOwnerEmail" type="email" autocomplete="email" placeholder="admin@example.com" value="${escapeHtml(mobile.ownerEmail)}" required></label><label>Company <small>optional</small><input id="mobileCompany" autocomplete="organization"></label><button class="button primary" type="submit">Send verification code</button></form>`;
  } else {
    const devices = mobile.devices?.length ? mobile.devices.map(device => `<div class="mobile-device"><div><strong>${escapeHtml(device.name)}</strong><small>${escapeHtml(device.email)} · Last contact ${escapeHtml(device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : 'not yet')}</small></div><button class="button ghost small" data-revoke-device="${escapeHtml(device.id)}">Revoke</button></div>`).join('') : '<p class="muted">No Android devices have completed registration.</p>';
    const enrollment = state.mobileEnrollment ? `<div class="enrollment-panel"><div class="qr-code">${state.mobileEnrollment.qrSvg}</div><div><strong>Scan with RackSight for Android</strong><p>For ${escapeHtml(state.mobileEnrollment.email)}. This QR code is single-use and expires ${escapeHtml(new Date(state.mobileEnrollment.expiresAt).toLocaleTimeString())}.</p><small>The encryption key is transferred inside this locally generated QR code and is never readable by AuthorityGate.</small></div></div>` : '';
    setup = `<div class="mobile-summary">${kv('Verified notification owner',mobile.ownerEmail)}${kv('Email notifications','Enabled via Alerts@AuthorityGate.com')}${kv('Encrypted Android sync',sync)}</div>${error}<form id="mobileEnrollmentForm" class="config-form inline-config"><label>New Android device email<input id="mobileDeviceEmail" type="email" autocomplete="email" value="${escapeHtml(mobile.ownerEmail)}" required></label><button class="button primary" type="submit">Create QR code</button></form>${enrollment}<div class="mobile-device-list">${devices}</div><div class="form-buttons"><button class="button ghost" id="refreshMobileDevices" type="button">Refresh devices</button><button class="button ghost" id="syncMobileNow" type="button">Sync now</button></div>`;
  }
  const description = mobile.configured
    ? 'Email notifications are active. Android devices can be enrolled for encrypted, read-only alerts.'
    : 'Verify the notification owner first to activate email notifications or enroll Android devices.';
  return `<section class="settings-card mobile-card ${statusClass}"><div class="card-title-row"><div><h2>Notifications <span class="mobile-status ${statusClass}">${statusLabel}</span></h2><p>${description}</p></div></div>${setup}</section>`;
}

function renderThemeSettings() {
  const option = (id, title, detail) => `<button type="button" class="theme-option ${state.theme === id ? 'active' : ''}" data-theme-choice="${id}"><i class="theme-swatch ${id}"></i><span><strong>${title}</strong><small>${detail}</small></span></button>`;
  return `<section class="settings-card theme-card"><h2>Appearance</h2><p>AuthorityGate corporate palettes with WCAG AA contrast.</p><div class="theme-options">${option('corporate','Corporate Cream','Cream · gold · burgundy')}${option('chocolate','Chocolate','Dark chocolate · espresso · gold')}${option('charcoal','Charcoal','Warm charcoal · near black · copper')}</div></section>`;
}

function renderMonitoringSettings() {
  const monitoring = state.monitoringSettings || { pollIntervalMinutes:5 };
  return `<section class="settings-card"><h2>Monitoring</h2><form id="monitoringSettingsForm" class="config-form"><label>BMC polling interval<input id="pollIntervalMinutes" type="number" min="2" max="10" step="1" value="${escapeHtml(monitoring.pollIntervalMinutes)}"><small>minutes · default 5 · allowed 2–10</small></label><p class="muted">The dashboard can refresh without contacting each BMC. Failed hosts retry automatically and back off to a maximum of 10 minutes.</p><div class="form-buttons"><button class="button primary" type="submit">Save polling interval</button></div></form>${kv('History retention','31 days')}${kv('Available ranges','1h · 4h · 24h · 7d · 30d')}${kv('Mobile sync','Encrypted · outbound HTTPS')}</section>`;
}

function renderHelpView() {
  const point = (title, detail) => `<div class="help-point"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p></div>`;
  return `<div class="view-heading"><div><h2>RackSight help</h2><p>Monitoring and notification behavior, operating boundaries, and legal terms.</p></div><span>Notifications only on Android</span></div>
    <section class="settings-card help-hero"><p class="eyebrow">PURPOSE AND BOUNDARIES</p><h2>Know when datacenter hardware needs attention</h2><p>RackSight reads Redfish telemetry and alerts enrolled users. An alert reports a condition; it does not repair the condition.</p><div class="disclosure-grid"><article><h3>What RackSight does</h3><p>Monitors server reachability, temperatures, and confirmed connected fans. It retains telemetry history and sends encrypted alerts to registered Android devices.</p></article><article class="warning"><h3>What Android cannot do</h3><p>There is no two-way datacenter control. Android cannot send BMC, host, console, reset, remediation, configuration, power, KVM, shell, or host-reboot commands back to the datacenter.</p></article></div></section>
    <div class="help-grid">
      <section class="settings-card"><h2>Alert meanings</h2>${point('Server failure','RackSight cannot obtain current monitoring data from the BMC. Last-known telemetry may remain visible with its timestamp.')}${point('Fan warning','A confirmed connected fan is below the configured RPM minimum.')}${point('Fan failure','A previously confirmed connected fan is missing or reports no rotation. Unused fan slots are not treated as failures.')}${point('Temperature warning','A sensor remained above the configured threshold for the configured duration.')}${point('Recovery','The monitored condition returned to normal; this does not prove the underlying cause was permanently corrected.')}</section>
      <section class="settings-card"><h2>Android enrollment</h2>${point('1. Verify the notification owner','Settings sends a six-digit code to the assigned owner email. The code expires after ten minutes.')}${point('2. Create a one-time QR code','The QR transfers the installation identifier, pairing secret, and data key directly to Android. It is single-use and short-lived.')}${point('3. Verify the device email','Android requires a second six-digit email code before activation.')}${point('4. Allow notifications','Choose server, fan, temperature, and recovery categories in Android Settings.')}</section>
      <section class="settings-card"><h2>Security model</h2>${point('Encrypted payloads','RackSight encrypts monitoring data before upload. AuthorityGate stores ciphertext and routes notifications.')}${point('Local decryption','Only a device enrolled with the QR-delivered key can decrypt that installation’s monitoring payloads.')}${point('No datacenter credentials on Android','BMC usernames and passwords stay on the Windows or IIS RackSight host and are never entered into the Android app.')}${point('Device revocation','Revoke a phone from Notifications settings when it is replaced, lost, or no longer authorized.')}</section>
      <section class="settings-card"><h2>Troubleshooting</h2>${point('No current data','Confirm RackSight and the phone both have internet access, then use Sync now and Android Refresh.')}${point('No Android alert','Confirm notification permission and the relevant Android alert category are enabled. Check Android system notification settings.')}${point('Enrollment expired','Generate a new QR code and repeat email verification. Enrollment codes cannot be reused.')}${point('BMC offline','Use an authorized administrative system to investigate. Android intentionally cannot initiate recovery or manager reset actions.')}</section>
    </div>
    <section class="settings-card license-card"><h2>MIT License</h2><pre class="license-text">${escapeHtml(MIT_LICENSE)}</pre></section>`;
}

function renderSettingsView() {
  const rows = state.servers.map(server => {
    const item = state.data.get(server.id); const status = serverStatus(server);
    const network = item?.settings?.network?.flatMap(net => net.ipv4 || []).filter(Boolean).join(', ') || '—';
    return `<div class="connection-row"><div class="connection-name"><span class="server-glyph">▰</span><div><strong>${escapeHtml(server.name)}</strong><small>${escapeHtml(server.address)}</small></div></div><div><small>ACCOUNT</small><strong>${escapeHtml(server.username)}</strong></div><div><small>BMC ADDRESS</small><strong>${escapeHtml(network)}</strong></div><div><span class="health ${status.css}">${escapeHtml(status.label)}</span></div><div class="connection-actions"><button class="icon-btn" data-connect="${server.id}">Connect now</button><button class="icon-btn" data-open="${server.id}">Details</button><button class="icon-btn" data-edit="${server.id}">Edit</button><button class="icon-btn danger" data-delete="${server.id}">Delete</button></div></div>`;
  }).join('');
  const alert = state.alertSettings || { enabled:true, thresholdC:85, fanAlerts:true, minimumFanRpm:500, durationMinutes:5, cooldownMinutes:30, browserNotifications:true };
  const monitoring = state.monitoringSettings || { pollIntervalMinutes:5 };
  const firing = state.alerts.filter(item => item.status === 'firing');
  const alertRows = state.alerts.length ? state.alerts.map(item => `<div class="active-alert ${item.status}"><strong>${escapeHtml(item.serverName)} · ${escapeHtml(item.sensor)}</strong><span>${item.type === 'fan' ? (item.condition === 'missing' ? 'Missing' : `${escapeHtml(item.valueRpm)} RPM / minimum ${escapeHtml(item.thresholdRpm)} RPM`) : `${escapeHtml(item.valueC)}°C / ${escapeHtml(item.thresholdC)}°C`} · ${escapeHtml(item.status)}</span></div>`).join('') : '<p class="muted">No pending or active hardware alerts.</p>';
  const update = state.updateState;
  const checkedAt = update.checkedAt ? new Date(update.checkedAt).toLocaleString() : 'Not checked yet';
  const updatesCard = `<section class="settings-card update-card"><div><h2>Application updates</h2><p>${escapeHtml(updateStatusText(update))}</p><small>Installed version ${escapeHtml(update.currentVersion || '—')} · Last check ${escapeHtml(checkedAt)}</small></div><button type="button" class="button primary" id="checkForUpdates" ${!update.supported || update.status === 'checking' ? 'disabled' : ''}>${update.status === 'checking' ? 'Checking…' : 'Check for updates'}</button></section>`;
  return `<div class="view-heading"><div><h2>BMC connections</h2><p>Credentials remain encrypted on this dashboard host.</p></div><button class="button primary" data-add>＋ Add server</button></div><section class="settings-card connection-list">${rows}</section><div class="settings-columns alert-columns"><section class="settings-card"><h2>Hardware alerts</h2><form id="alertSettingsForm" class="config-form"><label class="toggle-row"><span><strong>Enable alerts</strong><small>Track physical temperature and fan sensors</small></span><input type="checkbox" id="alertsEnabled" ${alert.enabled ? 'checked' : ''}></label><label class="toggle-row"><span><strong>Fan missing or low speed</strong><small>Alert when a fan is absent or below the minimum RPM</small></span><input type="checkbox" id="fanAlerts" ${alert.fanAlerts ? 'checked' : ''}></label><div class="config-grid"><label>Temperature threshold °C<input type="number" id="alertThreshold" min="20" max="120" value="${escapeHtml(alert.thresholdC)}"></label><label>Minimum fan RPM<input type="number" id="minimumFanRpm" min="0" max="50000" value="${escapeHtml(alert.minimumFanRpm)}"></label><label>Condition duration<input type="number" id="alertDuration" min="1" max="1440" value="${escapeHtml(alert.durationMinutes)}"><small>minutes</small></label><label>Notification cooldown<input type="number" id="alertCooldown" min="1" max="10080" value="${escapeHtml(alert.cooldownMinutes)}"><small>minutes</small></label></div><label class="toggle-row"><span><strong>Browser notifications</strong><small>Show alerts while the web app is open</small></span><input type="checkbox" id="browserNotifications" ${alert.browserNotifications ? 'checked' : ''}></label><div class="form-buttons"><button type="button" class="button ghost" id="enableBrowserNotifications">Enable desktop permission</button><button class="button primary" type="submit">Save alert rules</button></div></form></section><section class="settings-card"><h2>Active alerts <span class="count-badge">${firing.length}</span></h2><div class="active-alerts">${alertRows}</div></section></div>${renderMobileSettings()}${updatesCard}<div class="settings-columns"><section class="settings-card"><h2>Monitoring</h2>${kv('Browser refresh','30 seconds')}${kv('History sampling','60 seconds')}${kv('History retention','31 days')}${kv('Available ranges','1h · 4h · 24h · 7d · 30d')}${kv('Mobile sync','Encrypted · outbound HTTPS')}</section><section class="settings-card"><h2>Connection policy</h2>${kv('Protocol','Redfish over HTTPS')}${kv('Mobile access','Read-only')}${kv('Cloud visibility','Ciphertext only')}${kv('Payload encryption','AES-256-GCM')}${kv('Credential encryption','AES-256-GCM')}</section></div><section class="settings-card settings-note"><h2>System configuration</h2><p>Select <strong>Details</strong> beside a server to review its BIOS attributes, boot configuration, firmware inventory, BMC network interfaces, sensors, and historical telemetry.</p></section><section class="settings-card settings-note"><h2>Help and MIT License</h2><p>Review RackSight alert meanings, its notifications-only Android design, security boundaries, troubleshooting, and license terms.</p><button class="button ghost" type="button" data-view="help">Open Help and MIT License</button></section>`;
}

function renderSecondaryView() {
  $('#secondaryView').innerHTML = state.view === 'hardware' ? renderHardwareView() : state.view === 'help' ? renderHelpView() : renderSettingsView();
  if (state.view === 'settings') {
    $('#secondaryView').insertAdjacentHTML('afterbegin', renderThemeSettings());
    const monitoring = [...$('#secondaryView').querySelectorAll('.settings-card')].find(card => card.querySelector('h2')?.textContent === 'Monitoring');
    if (monitoring) monitoring.outerHTML = renderMonitoringSettings();
    $$('#secondaryView [data-connect]').forEach(button => button.insertAdjacentHTML('afterend', `<button class="icon-btn danger" data-manager-reset="${escapeHtml(button.dataset.connect)}">Recover BMC</button>`));
  }
}

function setView(view) {
  if (!['overview','hardware','settings','help'].includes(view)) return;
  state.view = view;
  const url = new URL(window.location.href); url.searchParams.set('view', view); history.replaceState({}, '', url);
  render();
  window.scrollTo({ top:0, behavior:'smooth' });
}

function renderCard(server, item) {
  if (!item) return `<article class="server-card loading-card"><div><div class="spinner"></div><p>Connecting to ${escapeHtml(server.name)}…</p></div></article>`;
  if (item.error) return `<article class="server-card" style="--glow:var(--red)"><button class="card-open" data-open="${server.id}" aria-label="Open details"></button><div class="card-head"><div class="server-title"><span class="server-glyph">▰</span><div><h3>${escapeHtml(server.name)}</h3><p>${escapeHtml(server.address)}</p></div></div><span class="health error">Offline</span></div><div class="error-message">${escapeHtml(item.error)}</div><div class="card-footer"><span>Connection failed</span><div class="card-actions"><button class="icon-btn" data-connect="${server.id}">Connect now</button><button class="icon-btn" data-edit="${server.id}">Edit</button><button class="icon-btn" data-delete="${server.id}">Delete</button></div></div></article>`;
  const temp = maxTemperature(item);
  const health = item.overallHealth || 'Unknown';
  const offline = item.connectivity?.online === false;
  return `<article class="server-card ${offline ? 'offline-card' : ''}" style="--glow:${offline ? 'var(--danger)' : healthClass(health) ? 'var(--amber)' : 'var(--green)'}"><button class="card-open" data-open="${server.id}" aria-label="Open details"></button><div class="card-head"><div class="server-title"><span class="server-glyph">▰</span><div><h3>${escapeHtml(server.name)}</h3><p>${escapeHtml(item.identity.model || server.address)}</p></div></div><span class="health ${offline ? 'error' : healthClass(health)}">${offline ? 'Offline' : escapeHtml(health)}</span></div>${offlineNotice(item)}<div class="metrics"><div class="metric"><small>CPU LOAD</small><strong>${formatPercent(item.utilization.cpuPercent)}</strong></div><div class="metric"><small>MEMORY</small><strong>${item.utilization.memoryPercent == null ? `${item.memory.totalGiB || '—'} GB` : formatPercent(item.utilization.memoryPercent)}</strong></div><div class="metric"><small>MAX TEMP</small><strong>${temp == null ? 'N/A' : `${Math.round(temp)}°C`}</strong><div class="temp-bar"><i style="width:${Math.min(100,temp || 0)}%"></i></div></div></div><div class="card-footer"><span>${offline ? 'Last known inventory' : `${escapeHtml(item.powerState)} · ${item.responseMs}ms`}</span><div class="card-actions">${offline ? `<button class="icon-btn" data-connect="${server.id}">Connect now</button>` : ''}<button class="icon-btn" data-edit="${server.id}">Edit</button><button class="icon-btn" data-delete="${server.id}">Delete</button></div></div></article>`;
}

async function loadServers() {
  const [servers, alertSettings, monitoringSettings, mobileSettings] = await Promise.all([api('/api/servers'), api('/api/alert-settings'), api('/api/monitoring-settings'), api('/api/mobile')]);
  state.servers = servers; state.alertSettings = alertSettings; state.monitoringSettings = monitoringSettings; state.mobileSettings = mobileSettings;
  render();
  await Promise.all([refreshAll(), pollAlerts()]);
}

function renderAlertIndicator() {
  const firing = state.alerts.filter(alert => alert.status === 'firing');
  const indicator = $('#alertIndicator');
  indicator.classList.toggle('hidden', firing.length === 0);
  indicator.querySelector('span').textContent = `${firing.length} alert${firing.length === 1 ? '' : 's'}`;
}

async function pollAlerts() {
  try {
    state.alerts = await api('/api/alerts/active');
    renderAlertIndicator();
    if (state.alertSettings?.browserNotifications && 'Notification' in window && Notification.permission === 'granted') {
      for (const alert of state.alerts.filter(item => item.status === 'firing')) {
        if (state.notifiedAlerts.has(alert.id)) continue;
        const fan = alert.type === 'fan';
        new Notification(`${fan ? 'Fan alert' : 'High temperature'}: ${alert.serverName}`, { body:fan ? (alert.condition === 'missing' ? `${alert.sensor} is missing` : `${alert.sensor} is ${alert.valueRpm} RPM (minimum ${alert.thresholdRpm} RPM)`) : `${alert.sensor} is ${alert.valueC}°C (threshold ${alert.thresholdC}°C)`, tag:alert.id });
        state.notifiedAlerts.add(alert.id);
      }
    }
    const activeIds = new Set(state.alerts.map(alert => alert.id));
    for (const id of state.notifiedAlerts) if (!activeIds.has(id)) state.notifiedAlerts.delete(id);
    if (state.view === 'settings' && !document.activeElement?.closest?.('form')) renderSecondaryView();
  } catch { /* The main server status already reports connectivity failures. */ }
}

async function refreshAll() {
  $('#refreshButton').disabled = true;
  await Promise.all(state.servers.map(async server => {
    try { state.data.set(server.id, await api(`/api/servers/${server.id}/data`)); }
    catch (error) { state.data.set(server.id, { error: error.message, server }); }
    render();
  }));
  $('#refreshButton').disabled = false;
}

function openModal(server = null) {
  $('#serverForm').reset(); $('#formError').classList.add('hidden');
  $('#serverId').value = server?.id || ''; $('#name').value = server?.name || '';
  $('#address').value = server?.address || ''; $('#username').value = server?.username || '';
  $('#password').required = !server; $('#password').placeholder = server ? 'Leave blank to keep current' : '••••••••';
  $('#modalTitle').textContent = server ? 'Edit server' : 'Add server'; $('#modal').classList.remove('hidden');
  setTimeout(() => $('#address').focus(), 0);
}
function closeModal() { $('#modal').classList.add('hidden'); }

function closeDetails() {
  const panel = $('#detailPanel');
  if (panel.classList.contains('hidden') || panel.classList.contains('closing')) return;
  panel.classList.add('closing');
  setTimeout(() => {
    panel.classList.add('hidden');
    panel.classList.remove('closing');
    state.detailServerId = null;
  }, 190);
}

function kv(label, value) { return value !== '' && value != null ? `<div class="kv"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>` : ''; }
function detailCard(title, body, wide = false) { return `<section class="detail-card ${wide ? 'wide' : ''}"><h3>${title}</h3>${body || '<div class="kv"><span>No data reported</span></div>'}</section>`; }

const CHART_PALETTES = {
  corporate:['#9B2335','#5D3A1A','#C17F59','#6C1017','#C9A227','#4A2C17','#D4A84B','#3D3D3D','#8A8580','#2C2C2C','#D4A574','#5C3D2E'],
  chocolate:['#F5F0E6','#C9A227','#C17F59','#D4A84B','#E8DCC8','#D4A574','#8A8580','#9B2335','#F5F0E6','#C17F59','#C9A227','#E8DCC8'],
  charcoal:['#F5F0E6','#D4A574','#C9A227','#D4A84B','#E8DCC8','#C17F59','#8A8580','#9B2335','#F5F0E6','#D4A84B','#C17F59','#E8DCC8']
};
let chartColors = CHART_PALETTES.corporate;

function applyTheme(theme) {
  if (!THEME_NAMES.includes(theme)) return;
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  document.querySelector('.brand-mark')?.setAttribute('src', THEME_LOGOS[theme]);
  localStorage.setItem('racksight-theme', theme);
  chartColors = CHART_PALETTES[theme];
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'corporate' ? '#F5F0E6' : theme === 'chocolate' ? '#3C2415' : '#2C2C2C');
}
applyTheme(savedTheme);

function historyChart(title, unit, points, series) {
  const available = series.filter(item => points.some(point => Number.isFinite(item.value(point))));
  if (!available.length) return `<section class="history-chart"><div class="chart-title"><strong>${escapeHtml(title)}</strong><span>No telemetry reported</span></div><div class="chart-empty">No data available for this metric.</div></section>`;
  const width = 620, height = 210, left = 46, right = 14, top = 18, bottom = 34;
  const allValues = available.flatMap(item => points.map(item.value).filter(Number.isFinite));
  let minimum = Math.min(...allValues), maximum = Math.max(...allValues);
  if (minimum === maximum) { minimum -= Math.max(1, minimum * .05); maximum += Math.max(1, maximum * .05); }
  const padding = (maximum - minimum) * .08; minimum = Math.max(0, minimum - padding); maximum += padding;
  const first = points[0].t, last = points.at(-1).t || first + 1;
  const x = timestamp => left + (timestamp - first) / Math.max(1, last - first) * (width - left - right);
  const y = value => top + (maximum - value) / (maximum - minimum) * (height - top - bottom);
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g,'-');
  const definitions = available.map((item,index) => {
    const color = item.color || chartColors[index % chartColors.length];
    return `<linearGradient id="${slug}-fill-${index}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".20"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient>`;
  }).join('');
  const threeDimensional = state.chartMode === '3d';
  const lines = available.map((item,index) => {
    const segments = []; let current = [];
    const seriesIndex = item.seriesIndex ?? index;
    const depth = threeDimensional ? Math.min(15, seriesIndex) : 0;
    for (const point of points) {
      const value = item.value(point);
      if (Number.isFinite(value)) current.push(`${(x(point.t) + depth * .65).toFixed(1)},${(y(value) - depth * .7).toFixed(1)}`);
      else if (current.length) { segments.push(current); current = []; }
    }
    if (current.length) segments.push(current);
    const color = item.color || chartColors[index % chartColors.length];
    const patterns = ['none','12 4','3 3','14 3 3 3','2 4','9 3 2 3'];
    const pattern = item.dashed ? '6 4' : patterns[(item.patternIndex || 0) % patterns.length];
    return segments.map(segment => {
      const firstX = segment[0].split(',')[0], lastPoint = segment.at(-1), [lastX,lastY] = lastPoint.split(',');
      const area = !item.dashed && index < 8 ? `<polygon points="${firstX},${y(minimum).toFixed(1)} ${segment.join(' ')} ${lastX},${y(minimum).toFixed(1)}" fill="url(#${slug}-fill-${index})"/>` : '';
      const underlay = `<polyline points="${segment.join(' ')}" fill="none" stroke="var(--panel)" stroke-width="${item.dashed ? '3.8' : '5'}" stroke-dasharray="${pattern}" opacity=".72" vector-effect="non-scaling-stroke"/>`;
      const line = `<polyline points="${segment.join(' ')}" fill="none" stroke="${color}" stroke-width="${item.dashed ? '1.8' : '2.5'}" stroke-dasharray="${pattern}" stroke-linecap="round" stroke-linejoin="round" opacity="${item.dashed ? '.82' : '1'}" vector-effect="non-scaling-stroke"/>`;
      const markerShapes = [
        `<circle cx="${lastX}" cy="${lastY}" r="3.2"/>`,
        `<rect x="${Number(lastX)-3}" y="${Number(lastY)-3}" width="6" height="6" rx="1"/>`,
        `<path d="M ${lastX} ${Number(lastY)-4} L ${Number(lastX)+4} ${Number(lastY)+3} L ${Number(lastX)-4} ${Number(lastY)+3} Z"/>`
      ];
      const marker = item.dashed ? '' : `<g fill="${color}" stroke="var(--panel)" stroke-width="1.4" vector-effect="non-scaling-stroke">${markerShapes[seriesIndex % markerShapes.length]}</g>`;
      return area + underlay + line + marker;
    }).join('');
  }).join('');
  const grid = [0,.25,.5,.75,1].map(ratio => {
    const gy = top + ratio * plotHeight; const value = maximum - ratio * (maximum - minimum);
    return `<line x1="${left}" y1="${gy}" x2="${width-right}" y2="${gy}" class="grid-line"/><text x="${left-7}" y="${gy+3}" class="axis-label" text-anchor="end">${Math.round(value)}</text>`;
  }).join('') + [.25,.5,.75].map(ratio => `<line x1="${left + ratio * plotWidth}" y1="${top}" x2="${left + ratio * plotWidth}" y2="${height-bottom}" class="grid-line vertical"/>`).join('');
  const timeLabel = timestamp => new Date(timestamp).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
  const formatValue = value => `${Math.round(value * 10) / 10}${unit}`;
  const latestValues = available.filter(item => !item.dashed).map(item => [...points].reverse().map(item.value).find(Number.isFinite)).filter(Number.isFinite);
  const latest = latestValues.length ? latestValues.reduce((sum,value) => sum + value, 0) / latestValues.length : allValues.at(-1);
  const legend = available.map((item,index) => { const color = item.color || chartColors[index % chartColors.length]; const pattern = item.patternIndex ?? index; return `<span><i class="pattern-${pattern % 6}" style="--series-color:${color};${item.dashed ? 'border-style:dashed' : ''}"></i>${escapeHtml(item.name)}</span>`; }).join('');
  return `<section class="history-chart ${threeDimensional ? 'chart-3d' : ''}"><div class="chart-title"><div><strong>${escapeHtml(title)}</strong><small>Telemetry trend · ${available.filter(item => !item.dashed).length} series · ${threeDimensional ? 'layered 3D' : 'standard 2D'}</small></div><div class="chart-stats"><span><small>Latest avg</small><b>${escapeHtml(formatValue(latest))}</b></span><span><small>Observed range</small><b>${escapeHtml(formatValue(Math.min(...allValues)))}–${escapeHtml(formatValue(Math.max(...allValues)))}</b></span></div></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)} history in ${threeDimensional ? 'layered three-dimensional' : 'two-dimensional'} view"><defs>${definitions}</defs><rect class="plot-background" x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}" rx="9"/>${grid}<g class="chart-series">${lines}</g><text x="${left}" y="${height-9}" class="axis-label">${escapeHtml(timeLabel(first))}</text><text x="${width-right}" y="${height-9}" class="axis-label" text-anchor="end">${escapeHtml(timeLabel(last))}</text></svg><div class="chart-legend">${legend}</div></section>`;
}

function mapAveragePeakSeries(points, averageField, peakField, options = {}) {
  const names = [...new Set(points.flatMap(point => [...Object.keys(point[averageField] || {}), ...Object.keys(point[peakField] || {})]))];
  return names.flatMap((name, index) => {
    if (options.hidden?.has(name)) return [];
    const color = chartColors[index % chartColors.length];
    const result = [{ name:options.averageOnly ? name : `${name} AVG`, color, seriesIndex:index, patternIndex:index, value:point => point[averageField]?.[name] }];
    if (!options.averageOnly || options.showPeaks) result.push({ name:`${name} PEAK`, color, seriesIndex:index, patternIndex:index, dashed:true, value:point => point[peakField]?.[name] });
    return result;
  });
}

function fanControls(points) {
  const names = [...new Set(points.flatMap(point => Object.keys(point.fans || {})))].sort((a,b) => a.localeCompare(b, undefined, { numeric:true }));
  if (!names.length) return '';
  const visible = names.filter(name => !state.hiddenFans.has(name)).length;
  const fans = names.map((name,index) => `<label class="fan-series-toggle"><input type="checkbox" data-fan-series="${escapeHtml(name)}" ${state.hiddenFans.has(name) ? '' : 'checked'}><i class="pattern-${index % 6}" style="--series-color:${chartColors[index % chartColors.length]}"></i><span>${escapeHtml(name)}</span></label>`).join('');
  return `<section class="chart-controls" aria-label="Fan chart controls"><div class="chart-control-heading"><div><strong>Fan visibility</strong><small>${visible} of ${names.length} fans displayed</small></div><div class="chart-control-actions"><button class="button ghost small" type="button" data-fans="all">All</button><button class="button ghost small" type="button" data-fans="none">None</button><button class="button ghost small ${state.showFanPeaks ? 'active' : ''}" type="button" data-fan-peaks aria-pressed="${state.showFanPeaks}">${state.showFanPeaks ? 'Hide peaks' : 'Show peaks'}</button><button class="button ghost small" type="button" data-chart-mode aria-pressed="${state.chartMode === '3d'}">${state.chartMode === '3d' ? 'Use 2D' : 'Use layered 3D'}</button></div></div><div class="fan-series-list">${fans}</div></section>`;
}

function renderHistory(history) {
  const target = $('#historyContent');
  if (!target || state.detailServerId !== target.dataset.serverId) return;
  const points = history.points || [];
  if (!points.length) {
    target.innerHTML = '<div class="history-empty"><strong>History collection has started</strong><span>The first chart points will appear after the next samples are recorded.</span></div>';
    return;
  }
  const availability = Math.round(points.reduce((sum, point) => sum + point.onlinePercent, 0) / points.length * 10) / 10;
  const utilization = [
    { name:'CPU AVG', color:chartColors[0], value:point=>point.cpu },
    { name:'CPU PEAK', color:chartColors[0], dashed:true, value:point=>point.cpuPeak },
    { name:'Memory AVG', color:chartColors[1], value:point=>point.memory },
    { name:'Memory PEAK', color:chartColors[1], dashed:true, value:point=>point.memoryPeak }
  ];
  const fsc = [
    { name:'FSC AVG', color:chartColors[0], value:point=>point.fsc },
    { name:'FSC PEAK', color:chartColors[0], dashed:true, value:point=>point.fscPeak }
  ];
  state.historyData = history;
  const fanSeries = mapAveragePeakSeries(points,'fans','fanPeaks',{ averageOnly:true, showPeaks:state.showFanPeaks, hidden:state.hiddenFans });
  target.innerHTML = `<div class="history-meta"><span>${points.length} chart points · solid average${state.showFanPeaks ? ' · dashed peak' : ''}</span><span>${availability}% average availability</span></div>${historyChart('Utilization','%',points,utilization)}${historyChart('Temperature','°C',points,mapAveragePeakSeries(points,'temperatures','temperaturePeaks'))}${fanControls(points)}${historyChart('Fan speed','RPM',points,fanSeries)}${historyChart('Fan control index','control demand',points,fsc)}`;
}

async function loadHistory(id, range = '24h') {
  state.historyRange = range;
  $$('.range-button').forEach(button => button.classList.toggle('active', button.dataset.historyRange === range));
  const target = $('#historyContent');
  if (target) target.innerHTML = '<div class="history-loading"><div class="spinner"></div><span>Loading telemetry history…</span></div>';
  try { renderHistory(await api(`/api/servers/${id}/history?range=${range}`)); }
  catch (error) { if ($('#historyContent')) $('#historyContent').innerHTML = `<div class="error-message">${escapeHtml(error.message)}</div>`; }
}

function openDetails(id) {
  state.detailServerId = id;
  state.historyRange = '24h';
  state.historyData = null;
  try { state.hiddenFans = new Set(JSON.parse(localStorage.getItem(`racksight-hidden-fans:${id}`) || '[]')); } catch { state.hiddenFans = new Set(); }
  const item = state.data.get(id); const server = state.servers.find(value => value.id === id);
  let content = `<div class="detail-header"><p class="eyebrow">SERVER DETAIL</p><h2>${escapeHtml(server.name)}</h2><p>${escapeHtml(server.address)}</p></div>`;
  if (!item || item.error) content += `<div class="error-message">${escapeHtml(item?.error || 'Still connecting…')}</div>`;
  else {
    content += offlineNotice(item);
    const identity = Object.entries(item.identity).map(([key,value]) => kv(key.replace(/([A-Z])/g,' $1'),value)).join('');
    const cpus = item.cpu.map(cpu => kv(cpu.name, `${cpu.model}${cpu.cores ? ` · ${cpu.cores}C/${cpu.threads || '?'}T` : ''} · ${cpu.health}`)).join('');
    const memory = item.memory.modules.map(module => kv(module.name, `${module.capacityGiB} GB ${module.type} ${module.speedMHz ? `@ ${module.speedMHz} MHz` : ''} · ${module.health}`)).join('');
    const temps = `<div class="sensor-grid">${item.temperatures.map(sensor => `<div class="sensor"><span title="${escapeHtml(sensor.name)}">${escapeHtml(sensor.name)}</span><strong>${escapeHtml(sensor.value)}${escapeHtml(sensor.units)}</strong></div>`).join('')}</div>`;
    const connectedFans = item.fans.filter(fan => fan.state !== 'Absent' && fan.value !== null && fan.value !== undefined);
    const fans = `<div class="sensor-grid">${connectedFans.map(fan => `<div class="sensor"><span>${escapeHtml(fan.name)}</span><strong>${escapeHtml(fan.value)} ${escapeHtml(fan.units)}</strong></div>`).join('')}</div>`;
    const firmware = item.firmware.map(fw => kv(fw.name, fw.version || fw.status)).join('');
    const boot = Object.entries(item.settings.boot || {}).filter(([,value]) => typeof value !== 'object').map(([key,value]) => kv(key,value)).join('');
    const network = item.settings.network.map(net => kv(net.name, [...net.ipv4,...net.ipv6].join(', ') || net.mac || net.hostname)).join('');
    const bios = Object.entries(item.settings.bios || {}).map(([key,value]) => kv(key, typeof value === 'object' ? JSON.stringify(value) : value)).join('');
    content += `<section class="history-section"><div class="history-heading"><div><p class="eyebrow">TELEMETRY HISTORY</p><h3>Performance over time</h3></div><div class="range-picker"><button class="range-button" data-history-range="1h">1 hour</button><button class="range-button" data-history-range="4h">4 hours</button><button class="range-button active" data-history-range="24h">24 hours</button><button class="range-button" data-history-range="7d">7 days</button><button class="range-button" data-history-range="30d">30 days</button></div></div><div id="historyContent" data-server-id="${id}"></div></section><div class="detail-grid">${detailCard('System identity',identity)}${detailCard('Current status',kv('Health',item.overallHealth)+kv('Power',item.powerState)+kv('CPU utilization',formatPercent(item.utilization.cpuPercent))+kv('Memory utilization',formatPercent(item.utilization.memoryPercent))+kv('Installed memory',`${item.memory.totalGiB} GB`)+kv('Fan control index',item.cooling?.fanSpeedControlIndex)+kv('Connected fans',connectedFans.length))}${detailCard('Processors',cpus,true)}${detailCard('Memory modules',memory,true)}${detailCard('Temperature sensors',temps,true)}${detailCard('Connected fan sensors',fans,true)}${detailCard('Firmware inventory',firmware,true)}${detailCard('Boot settings',boot)}${detailCard('BMC network',network)}${detailCard('BIOS attributes',`<div class="settings-list">${bios}</div>`,true)}</div>`;
  }
  $('#detailBody').innerHTML = content;
  const detailPanel = $('#detailPanel');
  detailPanel.classList.remove('hidden', 'closing');
  requestAnimationFrame(() => detailPanel.querySelector('[data-detail-close]')?.focus());
  if (item && !item.error) loadHistory(id);
}

document.addEventListener('click', async event => {
  const theme = event.target.closest('[data-theme-choice]');
  if (theme) { applyTheme(theme.dataset.themeChoice); renderSecondaryView(); return; }
  const navigation = event.target.closest('[data-view]'); if (navigation) setView(navigation.dataset.view);
  if (event.target.closest('#addButton,[data-add]')) openModal();
  if (event.target.closest('[data-close]')) closeModal();
  if (event.target.closest('[data-detail-close]')) closeDetails();
  const edit = event.target.closest('[data-edit]'); if (edit) openModal(state.servers.find(server => server.id === edit.dataset.edit));
  const connect = event.target.closest('[data-connect]');
  if (connect) {
    const id = connect.dataset.connect; connect.disabled = true; connect.textContent = 'Connecting…';
    try {
      state.data.set(id, await api(`/api/servers/${id}/connect`, { method:'POST', body:'{}' }));
      showToast('Server connected');
    } catch (error) {
      const server = state.servers.find(item => item.id === id);
      state.data.set(id, { error:error.message, server });
      showToast(error.message);
    } finally { render(); }
  }
  const managerReset = event.target.closest('[data-manager-reset]');
  if (managerReset) {
    const id = managerReset.dataset.managerReset;
    const server = state.servers.find(item => item.id === id);
    const approved = confirm(`Recover the BMC manager for ${server?.name || 'this server'}?\n\nRackSight will first request the safest BMC-advertised manager restart and may fall back to another Manager.Reset mode if it fails. The target is restricted to /Managers/.../Manager.Reset. ComputerSystem.Reset and host power actions are blocked, so this will NEVER reboot the host. BMC monitoring will be temporarily unavailable. The action has a 10-minute cooldown and is audit logged.`);
    if (approved) {
      managerReset.disabled = true; managerReset.textContent = 'Recovering BMC…';
      try {
        const result = await api(`/api/servers/${id}/manager-reset`, { method:'POST', body:JSON.stringify({ confirm:true }) });
        showToast(result.message || 'Management-controller reset accepted');
      } catch (error) { showToast(error.message); }
      finally { if (state.view === 'settings') renderSecondaryView(); }
    }
  }
  const open = event.target.closest('[data-open]'); if (open) openDetails(open.dataset.open);
  const range = event.target.closest('[data-history-range]'); if (range && state.detailServerId) loadHistory(state.detailServerId, range.dataset.historyRange);
  const fanSeries = event.target.closest('[data-fan-series]');
  if (fanSeries && state.historyData) {
    if (fanSeries.checked) state.hiddenFans.delete(fanSeries.dataset.fanSeries); else state.hiddenFans.add(fanSeries.dataset.fanSeries);
    localStorage.setItem(`racksight-hidden-fans:${state.detailServerId}`, JSON.stringify([...state.hiddenFans]));
    renderHistory(state.historyData);
  }
  const fanSet = event.target.closest('[data-fans]');
  if (fanSet && state.historyData) {
    const names = [...new Set((state.historyData.points || []).flatMap(point => Object.keys(point.fans || {})))];
    state.hiddenFans = fanSet.dataset.fans === 'none' ? new Set(names) : new Set();
    localStorage.setItem(`racksight-hidden-fans:${state.detailServerId}`, JSON.stringify([...state.hiddenFans]));
    renderHistory(state.historyData);
  }
  if (event.target.closest('[data-fan-peaks]') && state.historyData) {
    state.showFanPeaks = !state.showFanPeaks;
    renderHistory(state.historyData);
  }
  if (event.target.closest('[data-chart-mode]') && state.historyData) {
    state.chartMode = state.chartMode === '3d' ? '2d' : '3d';
    localStorage.setItem('racksight-chart-mode', state.chartMode);
    renderHistory(state.historyData);
  }
  if (event.target.closest('#enableBrowserNotifications')) {
    if (!('Notification' in window)) showToast('Notifications are not supported by this browser');
    else { const permission = await Notification.requestPermission(); showToast(permission === 'granted' ? 'Desktop notifications enabled' : 'Notification permission was not granted'); }
  }
  if (event.target.closest('#checkForUpdates') && window.rackSightDesktop) {
    const button = event.target.closest('#checkForUpdates'); button.disabled = true;
    try {
      state.updateState = await window.rackSightDesktop.checkForUpdates();
      if (state.updateState.status === 'current') showToast('RackSight is up to date');
      else if (state.updateState.status === 'available') showToast(`RackSight ${state.updateState.availableVersion} is available`);
    } catch (error) { showToast(error.message || 'Update check failed'); }
    finally { if (state.view === 'settings') renderSecondaryView(); }
  }
  if (event.target.closest('#refreshMobileDevices')) {
    try { state.mobileSettings = await api('/api/mobile/refresh', { method:'POST', body:'{}' }); showToast('Device list refreshed'); renderSecondaryView(); }
    catch (error) { showToast(error.message); }
  }
  if (event.target.closest('#syncMobileNow')) {
    try { state.mobileSettings = await api('/api/mobile/sync', { method:'POST', body:'{}' }); showToast('Encrypted mobile data synced'); renderSecondaryView(); }
    catch (error) { showToast(error.message); }
  }
  const revoke = event.target.closest('[data-revoke-device]');
  if (revoke && confirm('Revoke this Android device immediately?')) {
    try { state.mobileSettings = await api(`/api/mobile/devices/${encodeURIComponent(revoke.dataset.revokeDevice)}`, { method:'DELETE' }); showToast('Android device revoked'); renderSecondaryView(); }
    catch (error) { showToast(error.message); }
  }
  const remove = event.target.closest('[data-delete]');
  if (remove && confirm('Remove this server from the dashboard?')) {
    await api(`/api/servers/${remove.dataset.delete}`, { method:'DELETE' });
    state.data.delete(remove.dataset.delete); state.servers = state.servers.filter(server => server.id !== remove.dataset.delete); render(); showToast('Server removed');
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('#detailPanel').classList.contains('hidden')) closeDetails();
});

document.addEventListener('submit', async event => {
  if (event.target.id === 'alertSettingsForm') {
    event.preventDefault();
    try {
      state.alertSettings = await api('/api/alert-settings', { method:'PUT', body:JSON.stringify({ enabled:$('#alertsEnabled').checked, thresholdC:Number($('#alertThreshold').value), fanAlerts:$('#fanAlerts').checked, minimumFanRpm:Number($('#minimumFanRpm').value), durationMinutes:Number($('#alertDuration').value), cooldownMinutes:Number($('#alertCooldown').value), browserNotifications:$('#browserNotifications').checked }) });
      showToast('Alert rules saved'); renderSecondaryView();
    } catch (error) { showToast(error.message); }
  }
  if (event.target.id === 'monitoringSettingsForm') {
    event.preventDefault();
    try {
      state.monitoringSettings = await api('/api/monitoring-settings', { method:'PUT', body:JSON.stringify({ pollIntervalMinutes:Number($('#pollIntervalMinutes').value) }) });
      showToast(`BMC polling set to every ${state.monitoringSettings.pollIntervalMinutes} minutes`);
      renderSecondaryView();
    } catch (error) { showToast(error.message); }
  }
  if (event.target.id === 'mobileOwnerForm') {
    event.preventDefault();
    try { state.mobileSettings = await api('/api/mobile/owner/request', { method:'POST', body:JSON.stringify({ email:$('#mobileOwnerEmail').value, company:$('#mobileCompany').value }) }); showToast('Verification code sent'); renderSecondaryView(); }
    catch (error) { showToast(error.message); }
  }
  if (event.target.id === 'mobileOwnerVerifyForm') {
    event.preventDefault();
    try { state.mobileSettings = await api('/api/mobile/owner/verify', { method:'POST', body:JSON.stringify({ code:$('#mobileOwnerCode').value }) }); showToast('Notification owner verified'); renderSecondaryView(); }
    catch (error) { showToast(error.message); }
  }
  if (event.target.id === 'mobileEnrollmentForm') {
    event.preventDefault();
    try { state.mobileEnrollment = await api('/api/mobile/enrollments', { method:'POST', body:JSON.stringify({ email:$('#mobileDeviceEmail').value }) }); showToast('Single-use QR code created'); renderSecondaryView(); }
    catch (error) { showToast(error.message); }
  }
});

$('#serverForm').addEventListener('submit', async event => {
  event.preventDefault(); const submit = event.target.querySelector('[type=submit]'); submit.disabled = true;
  try {
    const record = await api('/api/servers', { method:'POST', body:JSON.stringify({ id:$('#serverId').value || undefined, name:$('#name').value, address:$('#address').value, username:$('#username').value, password:$('#password').value }) });
    const index = state.servers.findIndex(server => server.id === record.id); if (index >= 0) state.servers[index] = record; else state.servers.push(record);
    state.data.delete(record.id); closeModal(); render(); showToast('Server saved');
    try { state.data.set(record.id, await api(`/api/servers/${record.id}/connect`, { method:'POST', body:'{}' })); } catch (error) { state.data.set(record.id,{ error:error.message,server:record }); } render();
  } catch (error) { $('#formError').textContent = error.message; $('#formError').classList.remove('hidden'); }
  finally { submit.disabled = false; }
});

$('#refreshButton').addEventListener('click', refreshAll);

async function initializeDesktopUpdates() {
  if (!window.rackSightDesktop) return;
  window.rackSightDesktop.onUpdateState(update => {
    state.updateState = update;
    if (state.view === 'settings' && !document.activeElement?.closest?.('form')) renderSecondaryView();
  });
  try { state.updateState = await window.rackSightDesktop.getUpdateState(); }
  catch (error) { state.updateState = { ...state.updateState, status:'error', error:error.message }; }
}

initializeDesktopUpdates();
loadServers().catch(error => showToast(error.message));
state.timer = setInterval(refreshAll, 30000);
state.alertTimer = setInterval(pollAlerts, 15000);
