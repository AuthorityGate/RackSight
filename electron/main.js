'use strict';

const path = require('node:path');
const { app, BrowserWindow, Menu, Notification, Tray, shell } = require('electron');

let mainWindow;
let tray;
let webServer;
let alertTimer;
let isQuitting = false;
const notifiedAt = new Map();
const iconPath = path.join(__dirname, '..', '.icon', 'AsusRocks_MB.ico');

function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

async function monitorAlerts(baseUrl) {
  try {
    const [alerts, settings] = await Promise.all([
      fetch(`${baseUrl}/api/alerts/active`).then(response => response.json()),
      fetch(`${baseUrl}/api/alert-settings`).then(response => response.json())
    ]);
    const now = Date.now();
    const activeIds = new Set(alerts.map(alert => alert.id));
    for (const alert of alerts.filter(item => item.status === 'firing')) {
      const previous = notifiedAt.get(alert.id) || 0;
      if (now - previous < Number(settings.cooldownMinutes || 30) * 60000) continue;
      if (Notification.isSupported()) {
        const notification = new Notification({ title:`High temperature · ${alert.serverName}`, body:`${alert.sensor} is ${alert.valueC}°C (threshold ${alert.thresholdC}°C)`, icon:iconPath, urgency:'critical' });
        notification.on('click', showWindow);
        notification.show();
      }
      notifiedAt.set(alert.id, now);
    }
    for (const id of notifiedAt.keys()) if (!activeIds.has(id)) notifiedAt.delete(id);
  } catch { /* Retry when the local server is available. */ }
}

async function startApplication() {
  process.env.RACKSIGHT_DATA_DIR = path.join(app.getPath('userData'), 'data');
  process.env.HOST = '127.0.0.1';
  const { createApp, startHistoryPolling } = require('../server');
  webServer = createApp();
  await new Promise((resolve, reject) => {
    webServer.once('error', reject);
    webServer.listen(0, '127.0.0.1', resolve);
  });
  startHistoryPolling();
  const baseUrl = `http://127.0.0.1:${webServer.address().port}`;
  mainWindow = new BrowserWindow({ width:1440, height:960, minWidth:900, minHeight:650, show:false, icon:iconPath, backgroundColor:'#08111f', webPreferences:{ contextIsolation:true, nodeIntegration:false, sandbox:true } });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action:'deny' }; });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', event => { if (!isQuitting) { event.preventDefault(); mainWindow.hide(); } });
  await mainWindow.loadURL(baseUrl);
  tray = new Tray(iconPath);
  tray.setToolTip('RackSight Redfish Monitor');
  tray.setContextMenu(Menu.buildFromTemplate([{ label:'Open RackSight', click:showWindow }, { type:'separator' }, { label:'Quit', click:() => { isQuitting = true; app.quit(); } }]));
  tray.on('double-click', showWindow);
  alertTimer = setInterval(() => monitorAlerts(baseUrl), 15000);
  monitorAlerts(baseUrl);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.whenReady().then(startApplication).catch(error => { console.error(error); app.quit(); });
}
app.on('before-quit', () => { isQuitting = true; });
app.on('window-all-closed', () => {});
app.on('quit', () => { if (alertTimer) clearInterval(alertTimer); if (webServer) webServer.close(); });
