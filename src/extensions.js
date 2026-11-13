// Baixa extensões da Chrome Web Store (CRX), extrai e carrega na sessão do Electron.
// Se o download falhar, usa a cópia em cache ou uma pasta descompactada em ./extensions/<id>.
const { app, net } = require('electron');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

function crxUrl(id) {
  const prod = process.versions.chrome || '130.0.0.0';
  return 'https://clients2.google.com/service/update2/crx?response=redirect' +
    `&prodversion=${prod}&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;
}

// CRX3: "Cr24" | versão (u32) | tamanho do header (u32) | header | zip
// CRX2: "Cr24" | versão (u32) | len chave (u32) | len assinatura (u32) | chave | assinatura | zip
function crxToZip(buf) {
  if (buf.slice(0, 4).toString() !== 'Cr24') return buf; // já é zip
  const version = buf.readUInt32LE(4);
  if (version === 3) return buf.slice(12 + buf.readUInt32LE(8));
  if (version === 2) return buf.slice(16 + buf.readUInt32LE(8) + buf.readUInt32LE(12));
  throw new Error(`Versão de CRX desconhecida: ${version}`);
}

function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return null; }
}

async function download(id, destDir) {
  const res = await net.fetch(crxUrl(id));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const zip = new AdmZip(crxToZip(Buffer.from(await res.arrayBuffer())));
  const tmp = destDir + '.tmp';
  fs.rmSync(tmp, { recursive: true, force: true });
  zip.extractAllTo(tmp, true);
  // Electron não aceita a pasta _metadata (assinatura da store); remove.
  fs.rmSync(path.join(tmp, '_metadata'), { recursive: true, force: true });
  if (!readManifest(tmp)) throw new Error('manifest.json ausente');
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.renameSync(tmp, destDir);
}

function localFolders(id) {
  const roots = [path.join(app.getAppPath(), 'extensions'), path.join(process.resourcesPath || '', 'extensions')];
  return roots.map((r) => path.join(r, id));
}

async function loadExtensions(ses, list, log = console.log) {
  const api = ses.extensions && ses.extensions.loadExtension ? ses.extensions : ses;
  const cacheRoot = path.join(app.getPath('userData'), 'extensions');
  fs.mkdirSync(cacheRoot, { recursive: true });
  const loaded = [];

  for (const ext of list || []) {
    let dir = localFolders(ext.id).find((d) => readManifest(d));
    if (!dir) {
      dir = path.join(cacheRoot, ext.id);
      try {
        await download(ext.id, dir);
        log(`[ext] ${ext.name}: baixada da Chrome Web Store`);
      } catch (e) {
        log(`[ext] ${ext.name}: download falhou (${e.message}), tentando cache`);
      }
    }
    if (!readManifest(dir)) { log(`[ext] ${ext.name}: não encontrada, pulando`); continue; }
    try {
      const info = await api.loadExtension(dir, { allowFileAccess: true });
      loaded.push({ id: ext.id, name: info.name || ext.name, version: info.version });
      log(`[ext] ${info.name} v${info.version} carregada`);
    } catch (e) {
      log(`[ext] ${ext.name}: erro ao carregar (${e.message})`);
    }
  }
  return loaded;
}

module.exports = { loadExtensions };
