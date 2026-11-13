'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const core = require('./lib/core');
const CFG = require('./config.json');

let win = null;
let data = { mode: 'join', installed: {}, sessionActive: false, gamePath: '' };
let manifest = null;
let playing = false;
let busy = false;
let booted = false;
let quitWhenDone = false;
let monitor = null;
let pushTimer = null;
const ui = { error: null, mods: [], progress: null, ready: false };

const dataFile = () => path.join(app.getPath('userData'), 'data.json');

function loadData() {
  try { Object.assign(data, JSON.parse(fs.readFileSync(dataFile(), 'utf8'))); } catch (_) { /* première fois */ }
  data.mode = data.mode === 'session' ? 'session' : 'join';
  if (!data.installed || typeof data.installed !== 'object') data.installed = {};
}

function saveData() {
  try {
    fs.mkdirSync(path.dirname(dataFile()), { recursive: true });
    const tmp = dataFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, dataFile());
  } catch (_) { /* non bloquant */ }
}

function snapshot() {
  const p = data.gamePath ? core.paths(data.gamePath) : null;
  const pending = ui.mods.filter((m) => m.status !== 'ok');
  return {
    ready: ui.ready,
    error: ui.error,
    gamePath: data.gamePath || '',
    gameOk: !!(p && fs.existsSync(p.exe)),
    modsDir: p ? p.modsDir : '',
    mode: data.mode,
    playing,
    busy,
    mods: ui.mods,
    pending: pending.length,
    pendingBytes: pending.reduce((a, m) => a + m.size, 0),
    hasManifest: !!manifest,
    news: manifest && manifest.news ? manifest.news : null,
    progress: ui.progress,
    discordSet: !/REMPLACER/i.test(CFG.discordUrl),
    args: CFG.launchArgs,
  };
}

function push(now) {
  if (!win || win.isDestroyed()) return;
  if (now) { clearTimeout(pushTimer); pushTimer = null; win.webContents.send('state', snapshot()); return; }
  if (pushTimer) return;
  pushTimer = setTimeout(() => { pushTimer = null; if (win && !win.isDestroyed()) win.webContents.send('state', snapshot()); }, 120);
}

async function computeMods() {
  if (!manifest) { ui.mods = []; return; }
  const p = data.gamePath ? core.paths(data.gamePath) : null;
  const out = [];
  for (const m of manifest.mods) {
    let status = 'new';
    if (p) status = await core.statusOf(p.modsDir, m, data.installed);
    out.push({ name: m.name, version: m.version, size: m.size, status });
  }
  ui.mods = out;
  saveData();
}

async function refresh() {
  ui.error = null;
  try {
    manifest = await core.fetchManifest(CFG.manifestUrl + '?t=' + Date.now(), { allowedPrefix: CFG.allowedPrefix });
  } catch (e) {
    manifest = null;
    ui.error = 'Impossible de lire la liste des mods sur GitHub. Vérifiez votre connexion.';
  }
  await computeMods();
  push(true);
}

async function cleanup() {
  if (data.gamePath) {
    const p = core.paths(data.gamePath);
    const names = new Set([...Object.keys(data.installed), ...(manifest ? manifest.mods.map((m) => m.name) : [])]);
    await core.removeMods(p.modsDir, [...names]);
  }
  data.installed = {};
  data.sessionActive = false;
  saveData();
}

async function onGameEnded() {
  playing = false;
  ui.progress = null;
  if (data.sessionActive) await cleanup();
  await computeMods();
  push(true);
  if (quitWhenDone) app.quit();
}

function startMonitor() {
  clearInterval(monitor);
  let seen = false;
  let miss = 0;
  const t0 = Date.now();
  monitor = setInterval(async () => {
    const run = await core.isRunning(CFG.gameExe);
    if (run) { seen = true; miss = 0; return; }
    miss++;
    if ((seen && miss >= 2) || (!seen && Date.now() - t0 > 120000)) {
      clearInterval(monitor);
      await onGameEnded();
    }
  }, 4000);
}

async function boot() {
  if (!data.gamePath || !core.normalizeGameRoot(data.gamePath)) {
    data.gamePath = (await core.detectGame()) || '';
    saveData();
  }
  if (data.sessionActive) {
    if (await core.isRunning(CFG.gameExe)) { playing = true; startMonitor(); } else { await cleanup(); }
  }
  await refresh();
  ui.ready = true;
  push(true);
}

async function doUpdate() {
  if (busy || playing || !manifest || !data.gamePath) return;
  busy = true;
  ui.error = null;
  push(true);
  const p = core.paths(data.gamePath);
  try {
    fs.mkdirSync(p.modsDir, { recursive: true });
    const todo = manifest.mods.filter((m) => {
      const cur = ui.mods.find((x) => x.name === m.name);
      return !cur || cur.status !== 'ok';
    });
    const totalBytes = todo.reduce((a, m) => a + m.size, 0) || 1;
    let doneBytes = 0;
    for (let i = 0; i < todo.length; i++) {
      const m = todo[i];
      const cur = ui.mods.find((x) => x.name === m.name);
      if (cur) cur.status = 'dl';
      const dest = path.join(p.modsDir, m.name);
      const part = dest + '.part';
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await core.downloadFile(m.url, part, {
            expectedSha: m.sha256,
            expectedSize: m.size,
            onProgress: (got) => {
              const pct = Math.min(100, Math.round(((doneBytes + got) / totalBytes) * 100));
              ui.progress = { pct, msg: `Téléchargement ${i + 1}/${todo.length} : ${m.name}` };
              push();
            },
          });
          fs.renameSync(part, dest);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          try { fs.unlinkSync(part); } catch (_) { /* rien */ }
        }
      }
      if (lastErr) throw new Error(`${m.name} : ${lastErr.message}`);
      core.recordInstalled(p.modsDir, m, data.installed);
      doneBytes += m.size;
      if (cur) cur.status = 'ok';
    }
    // retire les anciens mods gérés par le launcher qui ne sont plus au manifeste
    const keep = new Set(manifest.mods.map((m) => m.name));
    const obsolete = Object.keys(data.installed).filter((n) => !keep.has(n));
    if (obsolete.length) {
      await core.removeMods(p.modsDir, obsolete, { retries: 1, delay: 300 });
      obsolete.forEach((n) => delete data.installed[n]);
    }
    saveData();
  } catch (e) {
    ui.error = 'Téléchargement interrompu : ' + e.message;
  }
  busy = false;
  ui.progress = null;
  await computeMods();
  push(true);
}

function doPlay() {
  if (busy || playing || !manifest || !data.gamePath) return;
  if (ui.mods.some((m) => m.status !== 'ok')) return;
  const p = core.paths(data.gamePath);
  if (!fs.existsSync(p.exe)) { ui.error = 'SCUM.exe est introuvable. Choisissez le dossier du jeu dans les paramètres.'; push(true); return; }
  try {
    const child = spawn(p.exe, CFG.launchArgs, { cwd: path.dirname(p.exe), detached: true, stdio: 'ignore' });
    child.on('error', (e) => { ui.error = 'Impossible de lancer SCUM : ' + e.message; playing = false; clearInterval(monitor); push(true); });
    child.unref();
  } catch (e) {
    ui.error = 'Impossible de lancer SCUM : ' + e.message;
    push(true);
    return;
  }
  ui.error = null;
  playing = true;
  data.sessionActive = data.mode === 'session';
  saveData();
  startMonitor();
  push(true);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 800, minWidth: 1000, minHeight: 700,
    frame: false, backgroundColor: '#070807', show: false,
    title: 'Paradis Perdu Launcher',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    // En session unique, le launcher reste en arrière-plan jusqu'à la fermeture de SCUM
    if (playing && data.mode === 'session' && !quitWhenDone) { e.preventDefault(); quitWhenDone = true; win.hide(); }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function wireIpc() {
  ipcMain.handle('init', async () => {
    if (!booted) { booted = true; await boot(); } else { await refresh(); }
    return snapshot();
  });
  ipcMain.handle('setMode', (_e, mode) => {
    if (busy || playing) return snapshot();
    data.mode = mode === 'session' ? 'session' : 'join';
    saveData();
    push(true);
    return snapshot();
  });
  ipcMain.handle('detect', async () => {
    const g = await core.detectGame();
    if (g) { data.gamePath = g; ui.error = null; saveData(); await computeMods(); } else {
      ui.error = 'SCUM est introuvable dans vos bibliothèques Steam. Utilisez « Parcourir ».';
    }
    push(true);
    return snapshot();
  });
  ipcMain.handle('pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Dossier du jeu SCUM', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return snapshot();
    const root = core.normalizeGameRoot(r.filePaths[0]);
    if (!root) {
      ui.error = 'Ce dossier ne contient pas SCUM\\Binaries\\Win64\\SCUM.exe. Choisissez le dossier « SCUM » de Steam.';
    } else {
      data.gamePath = root; ui.error = null; saveData(); await computeMods();
    }
    push(true);
    return snapshot();
  });
  ipcMain.handle('update', async () => { await doUpdate(); return snapshot(); });
  ipcMain.handle('play', () => { doPlay(); return snapshot(); });
  ipcMain.handle('ext', (_e, key) => {
    const url = key === 'discord' ? CFG.discordUrl : key === 'shop' ? CFG.shopUrl : null;
    if (url && url.startsWith('https://') && !/REMPLACER/i.test(url)) shell.openExternal(url);
  });
  ipcMain.on('win', (_e, action) => {
    if (!win) return;
    if (action === 'min') win.minimize();
    if (action === 'close') win.close();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (!win.isVisible()) win.show(); if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    loadData();
    wireIpc();
    createWindow();
  });
  app.on('window-all-closed', () => { if (!(playing && data.mode === 'session')) app.quit(); });
}
