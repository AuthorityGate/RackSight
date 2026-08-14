'use strict';

const state = { servers: [], data: new Map(), timer: null, alertTimer: null, detailServerId: null, historyRange: '24h', view: 'overview', alertSettings: null, smtpSettings: null, alerts: [], notifiedAlerts: new Set(), updateState: { supported:Boolean(window.rackSightDesktop), status:window.rackSightDesktop ? 'idle' : 'unavailable', currentVersion:null, availableVersion:null, checkedAt:null, error:null } };
const requestedView = new URLSearchParams(window.location.search).get('view');
if (['overview','hardware','settings'].includes(requestedView)) state.view = requestedView;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

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
    error:`Update check failed: ${update.error || 'The release service could not be reached.'}`,
    unavailable:'Update checks are available in the installed Windows desktop application.'
  };
  return labels[update.status] || 'Update status is not available.';
}

function render() {
  const hasServers = state.servers.length > 0;
  $('#emptyState').classList.toggle('hidden', hasServers || state.view !== 'overview');
  $('#dashboard').classList.toggle('hidden', !hasServers || state.view !== 'overview');
  $('#secondaryView').classList.toggle('hidden', state.view === 'overview' || (!hasServers && state.view !== 'settings'));
  renderPageHeader();
  if (!state.servers.length) {
    if (state.view === 'settings') renderSecondaryView();
    return;
  }
  const records = state.servers.map(server => state.data.get(server.id));
  const successful = records.filter(item => item && !item.error);
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
    settings: ['CONFIGURATION','Settings','Manage BMC connections and review monitoring and system configuration.']
  };
  const [eyebrow,title,subtitle] = pages[state.view] || pages.overview;
  $('#pageEyebrow').textContent = eyebrow; $('#pageTitle').textContent = title; $('#pageSubtitle').textContent = subtitle;
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === state.view));
}

function serverStatus(server) {
  const item = state.data.get(server.id);
  if (!item) return { label:'Connecting', css:'warning' };
  if (item.error) return { label:'Offline', css:'error' };
  return { label:item.overallHealth || 'Unknown', css:healthClass(item.overallHealth) };
}

function renderHardwareView() {
  const cards = state.servers.map(server => {
    const item = state.data.get(server.id); const status = serverStatus(server);
    if (!item || item.error) return `<article class="inventory-card"><div class="inventory-head"><div><h2>${escapeHtml(server.name)}</h2><p>${escapeHtml(server.address)}</p></div><span class="health ${status.css}">${escapeHtml(status.label)}</span></div><div class="error-message">${escapeHtml(item?.error || 'Loading hardware inventory…')}</div></article>`;
    const cpu = item.cpu[0] || {};
    const presentFans = item.fans.filter(fan => fan.state !== 'Absent' && fan.value != null);
    return `<article class="inventory-card"><div class="inventory-head"><div><h2>${escapeHtml(server.name)}</h2><p>${escapeHtml(item.identity.model || server.address)}</p></div><span class="health ${status.css}">${escapeHtml(status.label)}</span></div><div class="inventory-summary"><div><small>PROCESSOR</small><strong>${escapeHtml(cpu.model || 'Unknown CPU')}</strong><span>${cpu.cores || '—'} cores · ${cpu.threads || '—'} threads</span></div><div><small>MEMORY</small><strong>${escapeHtml(item.memory.totalGiB)} GB</strong><span>${item.memory.populatedSlots} populated DIMMs</span></div><div><small>COOLING</small><strong>${presentFans.length} fans</strong><span>Control index ${escapeHtml(item.cooling?.fanSpeedControlIndex ?? '—')}</span></div></div><div class="inventory-section"><h3>Temperatures</h3><div class="compact-sensors">${item.temperatures.map(sensor => `<span><i>${escapeHtml(sensor.name)}</i><strong>${escapeHtml(sensor.value)}°C</strong></span>`).join('')}</div></div><div class="inventory-section"><h3>Connected fans</h3><div class="compact-sensors">${presentFans.map(fan => `<span><i>${escapeHtml(fan.name)}</i><strong>${escapeHtml(fan.value)} RPM</strong></span>`).join('') || '<p class="muted">No fan readings</p>'}</div></div><div class="inventory-footer"><span>BIOS ${escapeHtml(item.identity.biosVersion || '—')} · BMC ${escapeHtml(item.identity.bmcFirmware || '—')}</span><button class="button ghost small" data-open="${server.id}">View full details</button></div></article>`;
  }).join('');
  return `<div class="view-heading"><div><h2>Hardware inventory</h2><p>Live Redfish inventory grouped by physical server.</p></div><span>${state.servers.length} systems</span></div><div class="inventory-grid">${cards}</div>`;
}

function renderSettingsView() {
  const rows = state.servers.map(server => {
    const item = state.data.get(server.id); const status = serverStatus(server);
    const network = item?.settings?.network?.flatMap(net => net.ipv4 || []).filter(Boolean).join(', ') || '—';
    return `<div class="connection-row"><div class="connection-name"><span class="server-glyph">▰</span><div><strong>${escapeHtml(server.name)}</strong><small>${escapeHtml(server.address)}</small></div></div><div><small>ACCOUNT</small><strong>${escapeHtml(server.username)}</strong></div><div><small>BMC ADDRESS</small><strong>${escapeHtml(network)}</strong></div><div><span class="health ${status.css}">${escapeHtml(status.label)}</span></div><div class="connection-actions"><button class="icon-btn" data-connect="${server.id}">Connect now</button><button class="icon-btn" data-open="${server.id}">Details</button><button class="icon-btn" data-edit="${server.id}">Edit</button><button class="icon-btn danger" data-delete="${server.id}">Delete</button></div></div>`;
  }).join('');
  const alert = state.alertSettings || { enabled:true, thresholdC:85, durationMinutes:5, fanAlertsEnabled:true, fanFailureDurationMinutes:2, cooldownMinutes:30, browserNotifications:true };
  const smtp = state.smtpSettings || { enabled:false, host:'', port:587, secure:false, username:'', from:'', to:'', passwordConfigured:false };
  const firing = state.alerts.filter(item => item.status === 'firing');
  const alertRows = state.alerts.length ? state.alerts.map(item => `<div class="active-alert ${item.status}"><strong>${escapeHtml(item.serverName)} · ${escapeHtml(item.sensor)}</strong><span>${item.type === 'fan' ? `${escapeHtml(item.valueRpm ?? '—')} RPM · ${escapeHtml(item.reason || 'Fan failure')}` : `${escapeHtml(item.valueC)}°C / ${escapeHtml(item.thresholdC)}°C`} · ${escapeHtml(item.status)}</span></div>`).join('') : '<p class="muted">No pending or active hardware alerts.</p>';
  const update = state.updateState;
  const checkedAt = update.checkedAt ? new Date(update.checkedAt).toLocaleString() : 'Not checked yet';
  const updatesCard = `<section class="settings-card update-card"><div><h2>Application updates</h2><p>${escapeHtml(updateStatusText(update))}</p><small>Installed version ${escapeHtml(update.currentVersion || '—')} · Last check ${escapeHtml(checkedAt)}</small></div><button type="button" class="button primary" id="checkForUpdates" ${!update.supported || update.status === 'checking' ? 'disabled' : ''}>${update.status === 'checking' ? 'Checking…' : 'Check for updates'}</button></section>`;
  return `<div class="view-heading"><div><h2>BMC connections</h2><p>Credentials remain encrypted on this dashboard host.</p></div><button class="button primary" data-add>＋ Add server</button></div><section class="settings-card connection-list">${rows}</section><div class="settings-columns alert-columns"><section class="settings-card"><h2>Temperature alerts</h2><form id="alertSettingsForm" class="config-form"><label class="toggle-row"><span><strong>Enable alerts</strong><small>Track every physical temperature sensor</small></span><input type="checkbox" id="alertsEnabled" ${alert.enabled ? 'checked' : ''}></label><div class="config-grid"><label>Threshold °C<input type="number" id="alertThreshold" min="20" max="120" value="${escapeHtml(alert.thresholdC)}"></label><label>Must remain high for<input type="number" id="alertDuration" min="1" max="1440" value="${escapeHtml(alert.durationMinutes)}"><small>minutes</small></label><label>Notification cooldown<input type="number" id="alertCooldown" min="1" max="10080" value="${escapeHtml(alert.cooldownMinutes)}"><small>minutes</small></label></div><label class="toggle-row"><span><strong>Browser notifications</strong><small>Show alerts while the web app is open</small></span><input type="checkbox" id="browserNotifications" ${alert.browserNotifications ? 'checked' : ''}></label><div class="form-buttons"><button type="button" class="button ghost" id="enableBrowserNotifications">Enable desktop permission</button><button class="button primary" type="submit">Save alert rules</button></div></form></section><section class="settings-card"><h2>Active alerts <span class="count-badge">${firing.length}</span></h2><div class="active-alerts">${alertRows}</div></section></div><section class="settings-card smtp-card"><div class="card-title-row"><div><h2>Email notifications</h2><p>SMTP credentials are encrypted at rest.</p></div></div><form id="smtpSettingsForm" class="config-form"><label class="toggle-row"><span><strong>Enable SMTP alerts</strong><small>Send high-temperature and recovery emails</small></span><input type="checkbox" id="smtpEnabled" ${smtp.enabled ? 'checked' : ''}></label><div class="smtp-grid"><label>SMTP host<input id="smtpHost" placeholder="smtp.example.com" value="${escapeHtml(smtp.host)}"></label><label>Port<input id="smtpPort" type="number" min="1" max="65535" value="${escapeHtml(smtp.port)}"></label><label class="toggle-compact">TLS from connection<input id="smtpSecure" type="checkbox" ${smtp.secure ? 'checked' : ''}></label><label>Username<input id="smtpUsername" autocomplete="username" value="${escapeHtml(smtp.username)}"></label><label>Password<input id="smtpPassword" type="password" autocomplete="new-password" placeholder="${smtp.passwordConfigured ? 'Configured — leave blank to keep' : 'SMTP password'}"></label><label>From address<input id="smtpFrom" type="email" placeholder="racksight@example.com" value="${escapeHtml(smtp.from)}"></label><label class="span-two">Recipients <small>comma-separated</small><input id="smtpTo" placeholder="ops@example.com, owner@example.com" value="${escapeHtml(smtp.to)}"></label></div><div class="form-buttons"><button type="button" class="button ghost" id="testSmtp">Send test email</button><button class="button primary" type="submit">Save email settings</button></div></form></section>${updatesCard}<div class="settings-columns"><section class="settings-card"><h2>Monitoring</h2>${kv('Browser refresh','30 seconds')}${kv('History sampling','60 seconds')}${kv('History retention','31 days')}${kv('Available ranges','1h · 4h · 24h · 7d · 30d')}${kv('Storage','Local JSONL')}</section><section class="settings-card"><h2>Connection policy</h2>${kv('Protocol','Redfish over HTTPS')}${kv('Self-signed certificates','Accepted')}${kv('BMC request concurrency','4 per server')}${kv('Transient retry','1 retry')}${kv('Credential encryption','AES-256-GCM')}</section></div><section class="settings-card settings-note"><h2>System configuration</h2><p>Select <strong>Details</strong> beside a server to review its BIOS attributes, boot configuration, firmware inventory, BMC network interfaces, sensors, and historical telemetry.</p></section>`;
}

function renderSecondaryView() {
  $('#secondaryView').innerHTML = state.view === 'hardware' ? renderHardwareView() : renderSettingsView();
  if (state.view === 'settings') {
    const form = $('#alertSettingsForm'); const alert = state.alertSettings || {}; const browserRow = $('#browserNotifications')?.closest('label');
    form?.closest('section')?.querySelector('h2')?.replaceChildren('Hardware alerts');
    browserRow?.insertAdjacentHTML('beforebegin', `<label class="toggle-row"><span><strong>Fan failure alerts</strong><small>Detect zero RPM, disappearance, unavailable readings, and unhealthy status only for known connected fans</small></span><input type="checkbox" id="fanAlertsEnabled" ${alert.fanAlertsEnabled !== false ? 'checked' : ''}></label><label>Fan failure must remain for<input type="number" id="fanFailureDuration" min="1" max="1440" value="${escapeHtml(alert.fanFailureDurationMinutes ?? 2)}"><small>minutes</small></label>`);
  }
}

function setView(view) {
  if (!['overview','hardware','settings'].includes(view)) return;
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
  return `<article class="server-card" style="--glow:${healthClass(health) ? 'var(--amber)' : 'var(--green)'}"><button class="card-open" data-open="${server.id}" aria-label="Open details"></button><div class="card-head"><div class="server-title"><span class="server-glyph">▰</span><div><h3>${escapeHtml(server.name)}</h3><p>${escapeHtml(item.identity.model || server.address)}</p></div></div><span class="health ${healthClass(health)}">${escapeHtml(health)}</span></div><div class="metrics"><div class="metric"><small>CPU LOAD</small><strong>${formatPercent(item.utilization.cpuPercent)}</strong></div><div class="metric"><small>MEMORY</small><strong>${item.utilization.memoryPercent == null ? `${item.memory.totalGiB || '—'} GB` : formatPercent(item.utilization.memoryPercent)}</strong></div><div class="metric"><small>MAX TEMP</small><strong>${temp == null ? 'N/A' : `${Math.round(temp)}°C`}</strong><div class="temp-bar"><i style="width:${Math.min(100,temp || 0)}%"></i></div></div></div><div class="card-footer"><span>${escapeHtml(item.powerState)} · ${(item.responseMs / 1000).toFixed(1)}s collection</span><div class="card-actions"><button class="icon-btn" data-edit="${server.id}">Edit</button><button class="icon-btn" data-delete="${server.id}">Delete</button></div></div></article>`;
}

async function loadServers() {
  const [servers, alertSettings, smtpSettings] = await Promise.all([api('/api/servers'), api('/api/alert-settings'), api('/api/smtp-settings')]);
  state.servers = servers; state.alertSettings = alertSettings; state.smtpSettings = smtpSettings;
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
        new Notification(alert.type === 'fan' ? `Fan failure: ${alert.serverName}` : `High temperature: ${alert.serverName}`, { body:alert.type === 'fan' ? `${alert.sensor}: ${alert.reason} (${alert.valueRpm ?? 'unavailable'} RPM)` : `${alert.sensor} is ${alert.valueC}°C (threshold ${alert.thresholdC}°C)`, tag:alert.id });
        state.notifiedAlerts.add(alert.id);
      }
    }
    const activeIds = new Set(state.alerts.map(alert => alert.id));
    for (const id of state.notifiedAlerts) if (!activeIds.has(id)) state.notifiedAlerts.delete(id);
    if (state.view === 'settings' && !document.activeElement?.closest?.('form')) renderSecondaryView();
  } catch { /* The main server status already reports connectivity failures. */ }
}

function smtpFormPayload() {
  return { enabled:$('#smtpEnabled').checked, host:$('#smtpHost').value, port:Number($('#smtpPort').value), secure:$('#smtpSecure').checked, username:$('#smtpUsername').value, password:$('#smtpPassword').value, from:$('#smtpFrom').value, to:$('#smtpTo').value };
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

function kv(label, value) { return value !== '' && value != null ? `<div class="kv"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>` : ''; }
function detailCard(title, body, wide = false) { return `<section class="detail-card ${wide ? 'wide' : ''}"><h3>${title}</h3>${body || '<div class="kv"><span>No data reported</span></div>'}</section>`; }

const chartColors = ['#4de1db','#4b9dff','#ffbd5b','#a784ff','#ff6978','#40d89b','#ff8f5b'];

function historyChart(title, unit, points, series) {
  const available = series.filter(item => points.some(point => Number.isFinite(item.value(point))));
  if (!available.length) return `<section class="history-chart"><div class="chart-title"><strong>${escapeHtml(title)}</strong><span>No telemetry reported</span></div><div class="chart-empty">No data available for this metric.</div></section>`;
  const width = 620, height = 190, left = 42, right = 12, top = 14, bottom = 29;
  const allValues = available.flatMap(item => points.map(item.value).filter(Number.isFinite));
  let minimum = Math.min(...allValues), maximum = Math.max(...allValues);
  if (minimum === maximum) { minimum -= Math.max(1, minimum * .05); maximum += Math.max(1, maximum * .05); }
  const padding = (maximum - minimum) * .08; minimum = Math.max(0, minimum - padding); maximum += padding;
  const first = points[0].t, last = points.at(-1).t || first + 1;
  const x = timestamp => left + (timestamp - first) / Math.max(1, last - first) * (width - left - right);
  const y = value => top + (maximum - value) / (maximum - minimum) * (height - top - bottom);
  const lines = available.map((item,index) => {
    const segments = []; let current = [];
    for (const point of points) {
      const value = item.value(point);
      if (Number.isFinite(value)) current.push(`${x(point.t).toFixed(1)},${y(value).toFixed(1)}`);
      else if (current.length) { segments.push(current); current = []; }
    }
    if (current.length) segments.push(current);
    const color = item.color || chartColors[index % chartColors.length];
    return segments.map(segment => `<polyline points="${segment.join(' ')}" fill="none" stroke="${color}" stroke-width="${item.dashed ? '1.6' : '2'}" stroke-dasharray="${item.dashed ? '5 4' : 'none'}" opacity="${item.dashed ? '.9' : '1'}" vector-effect="non-scaling-stroke"/>`).join('');
  }).join('');
  const grid = [0,.25,.5,.75,1].map(ratio => {
    const gy = top + ratio * (height - top - bottom); const value = maximum - ratio * (maximum - minimum);
    return `<line x1="${left}" y1="${gy}" x2="${width-right}" y2="${gy}" class="grid-line"/><text x="${left-7}" y="${gy+3}" class="axis-label" text-anchor="end">${Math.round(value)}</text>`;
  }).join('');
  const timeLabel = timestamp => new Date(timestamp).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
  const legend = available.map((item,index) => { const color = item.color || chartColors[index % chartColors.length]; return `<span><i style="${item.dashed ? `background:transparent;border:1px dashed ${color}` : `background:${color}`}" ></i>${escapeHtml(item.name)}</span>`; }).join('');
  return `<section class="history-chart"><div class="chart-title"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(unit)}</span></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)} history">${grid}${lines}<text x="${left}" y="${height-7}" class="axis-label">${escapeHtml(timeLabel(first))}</text><text x="${width-right}" y="${height-7}" class="axis-label" text-anchor="end">${escapeHtml(timeLabel(last))}</text></svg><div class="chart-legend">${legend}</div></section>`;
}

function mapAveragePeakSeries(points, averageField, peakField) {
  const names = [...new Set(points.flatMap(point => [...Object.keys(point[averageField] || {}), ...Object.keys(point[peakField] || {})]))];
  return names.flatMap((name, index) => {
    const color = chartColors[index % chartColors.length];
    return [
      { name:`${name} AVG`, color, value:point => point[averageField]?.[name] },
      { name:`${name} PEAK`, color, dashed:true, value:point => point[peakField]?.[name] }
    ];
  });
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
  target.innerHTML = `<div class="history-meta"><span>${points.length} chart points · AVG solid · PEAK dashed</span><span>${availability}% average availability</span></div>${historyChart('Utilization','%',points,utilization)}${historyChart('Temperature','°C',points,mapAveragePeakSeries(points,'temperatures','temperaturePeaks'))}${historyChart('Fan speed','RPM',points,mapAveragePeakSeries(points,'fans','fanPeaks'))}${historyChart('Fan control index','control demand',points,fsc)}`;
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
  const item = state.data.get(id); const server = state.servers.find(value => value.id === id);
  let content = `<div class="detail-header"><p class="eyebrow">SERVER DETAIL</p><h2>${escapeHtml(server.name)}</h2><p>${escapeHtml(server.address)}</p></div>`;
  if (!item || item.error) content += `<div class="error-message">${escapeHtml(item?.error || 'Still connecting…')}</div>`;
  else {
    const identity = Object.entries(item.identity).map(([key,value]) => kv(key.replace(/([A-Z])/g,' $1'),value)).join('');
    const cpus = item.cpu.map(cpu => kv(cpu.name, `${cpu.model}${cpu.cores ? ` · ${cpu.cores}C/${cpu.threads || '?'}T` : ''} · ${cpu.health}`)).join('');
    const memory = item.memory.modules.map(module => kv(module.name, `${module.capacityGiB} GB ${module.type} ${module.speedMHz ? `@ ${module.speedMHz} MHz` : ''} · ${module.health}`)).join('');
    const temps = `<div class="sensor-grid">${item.temperatures.map(sensor => `<div class="sensor"><span title="${escapeHtml(sensor.name)}">${escapeHtml(sensor.name)}</span><strong>${escapeHtml(sensor.value)}${escapeHtml(sensor.units)}</strong></div>`).join('')}</div>`;
    const fans = `<div class="sensor-grid">${item.fans.map(fan => `<div class="sensor ${fan.state === 'Absent' ? 'absent' : ''}"><span>${escapeHtml(fan.name)}</span><strong>${fan.value == null ? escapeHtml(fan.state || 'No reading') : `${escapeHtml(fan.value)} ${escapeHtml(fan.units)}`}</strong></div>`).join('')}</div>`;
    const firmware = item.firmware.map(fw => kv(fw.name, fw.version || fw.status)).join('');
    const boot = Object.entries(item.settings.boot || {}).filter(([,value]) => typeof value !== 'object').map(([key,value]) => kv(key,value)).join('');
    const network = item.settings.network.map(net => kv(net.name, [...net.ipv4,...net.ipv6].join(', ') || net.mac || net.hostname)).join('');
    const bios = Object.entries(item.settings.bios || {}).map(([key,value]) => kv(key, typeof value === 'object' ? JSON.stringify(value) : value)).join('');
    const detectedFans = item.fans.filter(fan => fan.state !== 'Absent' && fan.value != null).length;
    content += `<section class="history-section"><div class="history-heading"><div><p class="eyebrow">TELEMETRY HISTORY</p><h3>Performance over time</h3></div><div class="range-picker"><button class="range-button" data-history-range="1h">1 hour</button><button class="range-button" data-history-range="4h">4 hours</button><button class="range-button active" data-history-range="24h">24 hours</button><button class="range-button" data-history-range="7d">7 days</button><button class="range-button" data-history-range="30d">30 days</button></div></div><div id="historyContent" data-server-id="${id}"></div></section><div class="detail-grid">${detailCard('System identity',identity)}${detailCard('Current status',kv('Health',item.overallHealth)+kv('Power',item.powerState)+kv('CPU utilization',formatPercent(item.utilization.cpuPercent))+kv('Memory utilization',formatPercent(item.utilization.memoryPercent))+kv('Installed memory',`${item.memory.totalGiB} GB`)+kv('Fan control index',item.cooling?.fanSpeedControlIndex)+kv('Detected fans',`${detectedFans} of ${item.fans.length} sensor positions`))}${detailCard('Processors',cpus,true)}${detailCard('Memory modules',memory,true)}${detailCard('Temperature sensors',temps,true)}${detailCard('Fan sensors',fans,true)}${detailCard('Firmware inventory',firmware,true)}${detailCard('Boot settings',boot)}${detailCard('BMC network',network)}${detailCard('BIOS attributes',`<div class="settings-list">${bios}</div>`,true)}</div>`;
  }
  $('#detailBody').innerHTML = content; $('#detailPanel').classList.remove('hidden');
  if (item && !item.error) loadHistory(id);
}

document.addEventListener('click', async event => {
  const navigation = event.target.closest('[data-view]'); if (navigation) setView(navigation.dataset.view);
  if (event.target.closest('#addButton,[data-add]')) openModal();
  if (event.target.closest('[data-close]')) closeModal();
  if (event.target.closest('[data-detail-close]')) $('#detailPanel').classList.add('hidden');
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
  const open = event.target.closest('[data-open]'); if (open) openDetails(open.dataset.open);
  const range = event.target.closest('[data-history-range]'); if (range && state.detailServerId) loadHistory(state.detailServerId, range.dataset.historyRange);
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
  if (event.target.closest('#testSmtp')) {
    const button = event.target.closest('#testSmtp'); button.disabled = true;
    try {
      state.smtpSettings = await api('/api/smtp-settings', { method:'PUT', body:JSON.stringify(smtpFormPayload()) });
      await api('/api/smtp/test', { method:'POST', body:'{}' });
      showToast('Test email sent');
    } catch (error) { showToast(error.message); }
    finally { button.disabled = false; }
  }
  const remove = event.target.closest('[data-delete]');
  if (remove && confirm('Remove this server from the dashboard?')) {
    await api(`/api/servers/${remove.dataset.delete}`, { method:'DELETE' });
    state.data.delete(remove.dataset.delete); state.servers = state.servers.filter(server => server.id !== remove.dataset.delete); render(); showToast('Server removed');
  }
});

document.addEventListener('submit', async event => {
  if (event.target.id === 'alertSettingsForm') {
    event.preventDefault();
    try {
      state.alertSettings = await api('/api/alert-settings', { method:'PUT', body:JSON.stringify({ enabled:$('#alertsEnabled').checked, thresholdC:Number($('#alertThreshold').value), durationMinutes:Number($('#alertDuration').value), fanAlertsEnabled:$('#fanAlertsEnabled').checked, fanFailureDurationMinutes:Number($('#fanFailureDuration').value), cooldownMinutes:Number($('#alertCooldown').value), browserNotifications:$('#browserNotifications').checked }) });
      showToast('Alert rules saved'); renderSecondaryView();
    } catch (error) { showToast(error.message); }
  }
  if (event.target.id === 'smtpSettingsForm') {
    event.preventDefault();
    try { state.smtpSettings = await api('/api/smtp-settings', { method:'PUT', body:JSON.stringify(smtpFormPayload()) }); showToast('Email settings saved'); renderSecondaryView(); }
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
