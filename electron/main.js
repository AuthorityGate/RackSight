'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Menu, Notification, Tray, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let tray;
let webServer;
let alertTimer;
let isQuitting = false;
let updatePromptOpen = false;
const notifiedAt = new Map();
const iconPath = path.join(__dirname, '..', 'Logo', 'racksight-icon.png');

function persistentPaths() {
  const root = app.getPath('userData');
  return { data:path.join(root, 'data'), backups:path.join(root, 'update-backups') };
}

function restoreUpdateBackupIfNeeded() {
  const { data, backups } = persistentPaths();
  if (fs.existsSync(data) || !fs.existsSync(backups)) return;
  const candidates = fs.readdirSync(backups, { withFileTypes:true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
    .reverse();
  if (candidates[0]) fs.cpSync(path.join(backups, candidates[0]), data, { recursive:true, errorOnExist:true });
}

function backupPersistentData(version) {
  const { data, backups } = persistentPaths();
  if (!fs.existsSync(data)) return;
  fs.mkdirSync(backups, { recursive:true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.cpSync(data, path.join(backups, `${stamp}-before-${version}`), { recursive:true, errorOnExist:true });
  const candidates = fs.readdirSync(backups, { withFileTypes:true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
    .reverse();
  for (const old of candidates.slice(3)) fs.rmSync(path.join(backups, old), { recursive:true, force:true });
}

function configureUpdates() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', () => { /* Offline/private GitHub access must not interrupt startup. */ });
  autoUpdater.on('update-available', async info => {
    if (updatePromptOpen) return;
    updatePromptOpen = true;
    const result = await dialog.showMessageBox(mainWindow, {
      type:'info', title:'RackSight update available',
      message:`RackSight ${info.version} is available`,
      detail:`You are running ${app.getVersion()}. Upgrade now, review the release changelog, or install it later. Configuration and telemetry history are preserved.`,
      buttons:['Upgrade now', 'Read changelog', 'Later'], defaultId:0, cancelId:2, icon:iconPath
    });
    updatePromptOpen = false;
    if (result.response === 1) {
      await shell.openExternal(`https://github.com/AuthorityGate/RackSight/releases/tag/v${encodeURIComponent(info.version)}`);
    } else if (result.response === 0) {
      try { await autoUpdater.downloadUpdate(); }
      catch { /* The next startup check offers the update again. */ }
    }
  });
  autoUpdater.on('update-downloaded', async info => {
    try { backupPersistentData(info.version); }
    catch (error) {
      await dialog.showMessageBox(mainWindow, { type:'error', title:'RackSight update paused', message:'RackSight could not back up its local data.', detail:`The update was not started. Your current data is unchanged. ${error.message}`, buttons:['OK'] });
      return;
    }
    const result = await dialog.showMessageBox(mainWindow, {
      type:'info', title:'RackSight update ready',
      message:`RackSight ${info.version} is ready to install`,
      detail:'A local data backup was created. Restart RackSight now to complete the signed update.',
      buttons:['Restart and install', 'Install when I quit'], defaultId:0, cancelId:1, icon:iconPath
    });
    if (result.response === 0) {
      isQuitting = true;
      autoUpdater.quitAndInstall(false, true);
    }
  });
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 4000);
}

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
  restoreUpdateBackupIfNeeded();
  process.env.RACKSIGHT_DATA_DIR = persistentPaths().data;
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
  configureUpdates();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.whenReady().then(startApplication).catch(error => { console.error(error); app.quit(); });
}
app.on('before-quit', () => { isQuitting = true; });
app.on('window-all-closed', () => {});
app.on('quit', () => { if (alertTimer) clearInterval(alertTimer); if (webServer) webServer.close(); });
