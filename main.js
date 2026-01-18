// Gerekli Araçlar
const { app, BrowserWindow, ipcMain } = require('electron'); // Ana kütüphane
const path = require('path'); // Path dosyalarını birleştirmek için
const { autoUpdater } = require('electron-updater'); // Launcher'ın kendisinin güncellemesi varsa (örn: v1.0 -> v1.1) bunu kontrol eder
const axios = require('axios'); // API istekleri için
const fs = require('fs'); // Dosya işlemleri 
const { spawn } = require('child_process'); // Node.js harici bir java programı başlatmak için gerekli 
const https = require('https'); // axios yerine bazen büyük dosyaları (assets) stream ederek indirmek için kullanılan yerel modül
const AdmZip = require('adm-zip'); // indirilen sıkıştırılmış dosyaları (özellikle Minecraft'ın "native" kütüphanelerini) zipten çıkarmak için kullanılır

let mainWindow;

// ==================== YAPILANDIRMA ====================
const CONFIG = {
  API_URL: 'https://siteniz.com/api',  // Kendi API adresiniz
  SERVER_IP: 'oyna.ackcraft.net',      // Minecraft sunucu IP
  SERVER_PORT: '25565',                  // Minecraft sunucu port (?)
  MC_VERSION: '1.21.1',                  // Minecraft versiyonu
  FABRIC_VERSION: 'latest',              // Fabric loader versiyonu (latest veya belirli versiyon)
  USE_FABRIC: true,                      // Fabric kullan (true/false)
  RAM_MIN: '2G',                         // Minimum RAM (?)
  RAM_MAX: '4G'                          // Maksimum RAM (?)
};
// ====================================================

autoUpdater.autoDownload = false; // Güncelleme varsa otomatik indirme, kullanıcıya soracağız.
autoUpdater.autoInstallOnAppQuit = true; // Uygulama kapanınca güncellemeyi kur.

function createWindow() { 
  mainWindow = new BrowserWindow({
    width: 1200, height: 700, // Pencere boyutu
    resizable: false,  // Kullanıcı pencereyi büyütemesin/küçültemesin.
    frame: true, // Pencere kenarlıkları (çarpı, küçültme tuşu) olsun.
    webPreferences: { 
      nodeIntegration: true, // HTML içinden Node.js kodlarına erişim izni (Güvenlik riski).
      contextIsolation: false // Render ve Main process arası izolasyonu kapatır.
    },
    icon: path.join(__dirname, 'assets/icon.ico') // Uygulama ikonu.
  });

  mainWindow.loadFile('index.html'); // Arayüz olarak bu HTML dosyasını yükle
}

app.whenReady().then(() => { // Uygulama hazır olduğunda...
  createWindow(); // Pencereyi aç
  autoUpdater.checkForUpdates(); // Launcher güncellemesi var mı bak
});

app.on('window-all-closed', () => { 
  if (process.platform !== 'darwin') app.quit(); // 
});

// ==================== LAUNCHER GÜNCELLEMELERİ ====================
autoUpdater.on('update-available', (info) => { // Güncelleme varsa arayüze (frontend) haber ver.
  mainWindow.webContents.send('update-available', info.version);
});

autoUpdater.on('update-not-available', () => {
  mainWindow.webContents.send('update-not-available');
});

autoUpdater.on('download-progress', (progressObj) => { // İndirme yüzdesini arayüze gönder (Progress bar için).
  mainWindow.webContents.send('download-progress', progressObj);
});

autoUpdater.on('update-downloaded', () => {
  mainWindow.webContents.send('update-downloaded');
});

ipcMain.on('start-update', () => { // Arayüzden "Güncelle" butonuna basılırsa indirmeyi başlat.
  autoUpdater.downloadUpdate();
});

ipcMain.on('install-update', () => {
  autoUpdater.quitAndInstall();
});

// ==================== KULLANICI GİRİŞİ ====================
ipcMain.handle('login', async (event, username, password) => {
  try {
    const response = await axios.post(`${CONFIG.API_URL}/login`, {  // API isteği
      username: username,
      password: password
    });
    // ====== TEST İÇİN BURDADIR KESİNLİKLE KALDIRILACAK ======
    if(username=="admin" && password =="admin"){
      return{
        success: true,
        username: response.data.username,
        uuid: response.data.uuid || generateOfflineUUID(response.data.username)
      };
    }; 
    // =======================================================
    if (response.data.success) {
      return {
        success: true,
        username: response.data.username,
        uuid: response.data.uuid || generateOfflineUUID(response.data.username)
      };
    } else {
      return { success: false, error: 'Kullanıcı adı veya şifre hatalı' };
    }
  } catch (error) {
    console.error('Login hatası:', error);
    return { success: false, error: 'Sunucuya bağlanılamadı' };
  }
});

function generateOfflineUUID(username) {
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update('OfflinePlayer:' + username).digest('hex');
  return `${hash.substr(0, 8)}-${hash.substr(8, 4)}-${hash.substr(12, 4)}-${hash.substr(16, 4)}-${hash.substr(20, 12)}`;
}

// ==================== YAMA NOTLARI ====================
ipcMain.handle('get-patch-notes', async () => {
  try {
    const response = await axios.get(`${CONFIG.API_URL}/patch-notes`);
    return response.data;
  } catch (error) {
    return { 
      notes: '<h3>Yama Notları</h3><p>Sunucuya bağlanırken bir hata oluştu.</p>' 
    };
  }
});

// ==================== MINECRAFT BAŞLATMA ====================
ipcMain.handle('launch-game', async (event, userData) => {
  try {
    const mcPath = path.join(app.getPath('appData'), '.ackcraft');
    const version = CONFIG.MC_VERSION;
    const useFabric = CONFIG.USE_FABRIC;
    
    const dirs = {
      root: mcPath,
      versions: path.join(mcPath, 'versions'),
      versionDir: path.join(mcPath, 'versions', version),
      fabricDir: path.join(mcPath, 'versions', `fabric-loader-${version}`),
      libraries: path.join(mcPath, 'libraries'),
      natives: path.join(mcPath, 'natives'),
      assets: path.join(mcPath, 'assets')
    };

    // Dizinleri oluştur
    for (const dir of Object.values(dirs)) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    sendStatus('Minecraft dosyaları hazırlanıyor...');
    
    // Vanilla Minecraft'ı indir
    const manifest = await downloadJSON('https://launchermeta.mojang.com/mc/game/version_manifest.json');
    const versionData = manifest.versions.find(v => v.id === version);
    
    if (!versionData) {
      throw new Error('Minecraft versiyonu bulunamadı');
    }

    const vanillaJson = await downloadJSON(versionData.url);
    
    // Vanilla version JSON'ını kaydet
    const vanillaJsonPath = path.join(dirs.versionDir, `${version}.json`);
    fs.writeFileSync(vanillaJsonPath, JSON.stringify(vanillaJson, null, 2));

    // Client JAR'ı indir
    const clientJarPath = path.join(dirs.versionDir, `${version}.jar`);
    if (!fs.existsSync(clientJarPath)) {
      sendStatus('Minecraft client indiriliyor...');
      await downloadFile(vanillaJson.downloads.client.url, clientJarPath);
    }

    // Assets indir
    sendStatus('Oyun dosyaları indiriliyor...');
    await downloadAssets(vanillaJson, dirs.assets);

    // Fabric kurulumu
    let finalJson = vanillaJson;
    let finalVersionDir = dirs.versionDir;
    
    if (useFabric) {
      sendStatus('Fabric loader kuruluyor...');
      
      // Fabric meta API'den loader bilgilerini al
      const fabricLoaderUrl = `https://meta.fabricmc.net/v2/versions/loader/${version}`;
      const fabricLoaders = await downloadJSON(fabricLoaderUrl);
      
      if (!fabricLoaders || fabricLoaders.length === 0) {
        throw new Error('Fabric loader bulunamadı');
      }
      
      // En son stable loader'ı al veya belirli versiyonu
      const fabricLoader = CONFIG.FABRIC_VERSION === 'latest' 
        ? fabricLoaders[0] 
        : fabricLoaders.find(l => l.loader.version === CONFIG.FABRIC_VERSION);
      
      if (!fabricLoader) {
        throw new Error('Fabric loader versiyonu bulunamadı');
      }
      
      const loaderVersion = fabricLoader.loader.version;
      const fabricVersionId = `fabric-loader-${loaderVersion}-${version}`;
      
      // Fabric profile JSON'ını al
      const fabricProfileUrl = `https://meta.fabricmc.net/v2/versions/loader/${version}/${loaderVersion}/profile/json`;
      const fabricJson = await downloadJSON(fabricProfileUrl);
      
      // Fabric version JSON'ını kaydet
      finalVersionDir = path.join(dirs.versions, fabricVersionId);
      if (!fs.existsSync(finalVersionDir)) {
        fs.mkdirSync(finalVersionDir, { recursive: true });
      }
      
      const fabricJsonPath = path.join(finalVersionDir, `${fabricVersionId}.json`);
      fs.writeFileSync(fabricJsonPath, JSON.stringify(fabricJson, null, 2));
      
      // ÖNEMLİ: Fabric ve Vanilla kütüphanelerini birleştir
      const combinedLibraries = [
        ...fabricJson.libraries,  // Fabric kütüphaneleri
        ...vanillaJson.libraries  // Vanilla Minecraft kütüphaneleri
      ];
      
      // Birleştirilmiş JSON oluştur
      finalJson = {
        ...fabricJson,
        libraries: combinedLibraries,
        assetIndex: vanillaJson.assetIndex  // Vanilla'dan asset index'i al
      };
      
      sendStatus('Fabric kütüphaneleri indiriliyor...');
    } else {
      sendStatus('Kütüphaneler indiriliyor...');
    }

    // Libraries indir (vanilla + fabric)
    await downloadLibraries(finalJson, dirs.libraries, dirs.natives);

    // Minecraft'ı başlat
    sendStatus('Oyun başlatılıyor...');
    
    const args = buildLaunchArgs(finalJson, dirs, userData, finalVersionDir);
    
    const minecraft = spawn('java', args, { cwd: dirs.root });

    minecraft.stdout.on('data', (data) => {
      console.log(`Minecraft: ${data}`);
    });

    minecraft.stderr.on('data', (data) => {
      console.error(`Minecraft: ${data}`);
    });

    minecraft.on('close', (code) => {
      console.log(`Minecraft kapandı (${code})`);
      mainWindow.webContents.send('game-closed', code);
    });

    sendStatus('Oyun başlatıldı!');
    return { success: true };
    
  } catch (error) {
    console.error('Başlatma hatası:', error);
    sendStatus('Hata oluştu!');
    return { success: false, error: error.message };
  }
});

// ==================== HELPER FONKSİYONLAR ====================
function sendStatus(message) {
  mainWindow.webContents.send('game-status', message);
}

async function downloadJSON(url) {
  const response = await axios.get(url);
  return response.data;
}

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function downloadAssets(versionJson, assetsDir) {
  const assetsIndex = await downloadJSON(versionJson.assetIndex.url);
  
  const indexDir = path.join(assetsDir, 'indexes');
  const objectsDir = path.join(assetsDir, 'objects');
  
  if (!fs.existsSync(indexDir)) fs.mkdirSync(indexDir, { recursive: true });
  if (!fs.existsSync(objectsDir)) fs.mkdirSync(objectsDir, { recursive: true });
  
  fs.writeFileSync(
    path.join(indexDir, `${versionJson.assetIndex.id}.json`),
    JSON.stringify(assetsIndex)
  );

  let downloaded = 0;
  const total = Object.keys(assetsIndex.objects).length;
  
  for (const [name, asset] of Object.entries(assetsIndex.objects)) {
    const hash = asset.hash;
    const subdir = hash.substring(0, 2);
    const assetPath = path.join(objectsDir, subdir, hash);
    
    if (!fs.existsSync(assetPath)) {
      const assetDir = path.join(objectsDir, subdir);
      if (!fs.existsSync(assetDir)) fs.mkdirSync(assetDir, { recursive: true });
      
      const url = `https://resources.download.minecraft.net/${subdir}/${hash}`;
      try {
        await downloadFile(url, assetPath);
        downloaded++;
        if (downloaded % 100 === 0) {
          sendStatus(`Dosyalar indiriliyor... ${downloaded}/${total}`);
        }
      } catch (err) {
        console.error(`Asset hatası: ${name}`);
      }
    }
  }
}

async function downloadLibraries(versionJson, librariesDir, nativesDir) {
  let downloadCount = 0;
  const total = versionJson.libraries.length;
  
  for (const lib of versionJson.libraries) {
    // Platform kontrolü
    if (lib.rules) {
      let allowed = false;
      for (const rule of lib.rules) {
        if (rule.action === 'allow') {
          if (!rule.os || rule.os.name === 'windows') allowed = true;
        }
        if (rule.action === 'disallow' && rule.os?.name === 'windows') {
          allowed = false;
        }
      }
      if (!allowed) continue;
    }

    // Native library
    if (lib.natives?.windows) {
      const classifierKey = lib.natives.windows.replace('${arch}', '64');
      const artifact = lib.downloads?.classifiers?.[classifierKey];
      
      if (artifact) {
        const libPath = path.join(librariesDir, artifact.path);
        const libDir = path.dirname(libPath);
        
        if (!fs.existsSync(libDir)) fs.mkdirSync(libDir, { recursive: true });
        
        if (!fs.existsSync(libPath)) {
          console.log(`İndiriliyor: ${artifact.path}`);
          try {
            await downloadFile(artifact.url, libPath);
            const zip = new AdmZip(libPath);
            zip.extractAllTo(nativesDir, true);
            downloadCount++;
          } catch (err) {
            console.error(`Native library hatası: ${artifact.path}`, err);
          }
        }
      }
    }
    // Normal library (downloads.artifact var)
    else if (lib.downloads?.artifact) {
      const artifact = lib.downloads.artifact;
      const libPath = path.join(librariesDir, artifact.path);
      const libDir = path.dirname(libPath);
      
      if (!fs.existsSync(libDir)) fs.mkdirSync(libDir, { recursive: true });
      
      if (!fs.existsSync(libPath)) {
        console.log(`İndiriliyor: ${artifact.path}`);
        try {
          await downloadFile(artifact.url, libPath);
          downloadCount++;
        } catch (err) {
          console.error(`Library hatası: ${artifact.path}`, err);
        }
      }
    }
    // Fabric kütüphaneleri (sadece name ve url var)
    else if (lib.name && lib.url) {
      const parts = lib.name.split(':');
      const packagePath = parts[0].replace(/\./g, '/');
      const artifactId = parts[1];
      const version = parts[2];
      
      const libPath = path.join(
        librariesDir,
        packagePath,
        artifactId,
        version,
        `${artifactId}-${version}.jar`
      );
      const libDir = path.dirname(libPath);
      
      if (!fs.existsSync(libDir)) fs.mkdirSync(libDir, { recursive: true });
      
      if (!fs.existsSync(libPath)) {
        // URL'yi düzelt - sonunda / yoksa ekle
        let baseUrl = lib.url;
        if (!baseUrl.endsWith('/')) baseUrl += '/';
        
        const libUrl = `${baseUrl}${packagePath}/${artifactId}/${version}/${artifactId}-${version}.jar`;
        console.log(`İndiriliyor (Fabric): ${libUrl}`);
        
        try {
          await downloadFile(libUrl, libPath);
          downloadCount++;
        } catch (err) {
          console.error(`Fabric library hatası: ${lib.name}`, err);
          console.error(`URL: ${libUrl}`);
        }
      }
    }
    
    if (downloadCount % 5 === 0 && downloadCount > 0) {
      sendStatus(`Kütüphaneler indiriliyor... ${downloadCount}/${total}`);
    }
  }
  
  console.log(`Toplam ${downloadCount} kütüphane indirildi`);
}

function buildLaunchArgs(versionJson, dirs, userData, versionDir) {
  const args = [];
  
  // JVM arguments
  args.push(`-Xmx${CONFIG.RAM_MAX}`);
  args.push(`-Xms${CONFIG.RAM_MIN}`);
  args.push(`-Djava.library.path=${dirs.natives}`);
  args.push('-cp');
  
  // Classpath
  const classpath = [];
  
  // Önce tüm kütüphaneleri ekle (Fabric kütüphaneleri dahil)
  for (const lib of versionJson.libraries) {
    let libPath = null;
    
    if (lib.downloads?.artifact) {
      libPath = path.join(dirs.libraries, lib.downloads.artifact.path);
    } else if (lib.name && lib.url) {
      // Fabric kütüphaneleri için path oluştur
      const parts = lib.name.split(':');
      const packagePath = parts[0].replace(/\./g, '/');
      const artifactId = parts[1];
      const version = parts[2];
      libPath = path.join(
        dirs.libraries,
        packagePath,
        artifactId,
        version,
        `${artifactId}-${version}.jar`
      );
    }
    
    if (libPath && fs.existsSync(libPath)) {
      classpath.push(libPath);
    } else if (libPath) {
      console.warn(`Eksik kütüphane: ${libPath}`);
    }
  }
  
  // Son olarak client jar'ı ekle
  const clientJarName = `${CONFIG.MC_VERSION}.jar`;
  const clientJarPath = path.join(dirs.versionDir, clientJarName);
  classpath.push(clientJarPath);
  
  args.push(classpath.join(';'));
  
  // DEBUG: Classpath'i konsola yazdır
  console.log('\n=== CLASSPATH ===');
  console.log(`Toplam ${classpath.length} dosya`);
  console.log('Fabric Loader:', classpath.find(p => p.includes('fabric-loader')));
  console.log('Sponge Mixin:', classpath.find(p => p.includes('sponge-mixin')));
  console.log('Intermediary:', classpath.find(p => p.includes('intermediary')));
  console.log('Client JAR:', clientJarPath);
  console.log('=================\n');
  
  // Main class (Fabric için: net.fabricmc.loader.impl.launch.knot.KnotClient)
  console.log('Main Class:', versionJson.mainClass);
  args.push(versionJson.mainClass);
  
  // Asset index'i güvenli al
  const assetIndex = versionJson.assetIndex?.id || versionJson.assets || CONFIG.MC_VERSION;
  
  // Game arguments - Fabric'in kendi argümanlarını kullan
  if (versionJson.arguments && versionJson.arguments.game) {
    // Modern format (1.13+)
    for (const arg of versionJson.arguments.game) {
      if (typeof arg === 'string') {
        // Değişkenleri değiştir
        const processedArg = arg
          .replace('${auth_player_name}', userData.username)
          .replace('${version_name}', versionJson.id)
          .replace('${game_directory}', dirs.root)
          .replace('${assets_root}', dirs.assets)
          .replace('${assets_index_name}', assetIndex)
          .replace('${auth_uuid}', userData.uuid)
          .replace('${auth_access_token}', '0')
          .replace('${user_type}', 'offline')
          .replace('${version_type}', 'release');
        
        args.push(processedArg);
      }
    }
  } else {
    // Eski format fallback
    args.push(
      '--username', userData.username,
      '--version', versionJson.id,
      '--gameDir', dirs.root,
      '--assetsDir', dirs.assets,
      '--assetIndex', assetIndex,
      '--uuid', userData.uuid,
      '--accessToken', '0',
      '--userType', 'offline',
      '--versionType', 'release'
    );
  }
  
  // Sunucu argümanlarını ekle
  args.push('--server', CONFIG.SERVER_IP);
  args.push('--port', CONFIG.SERVER_PORT);
  
  console.log('\n=== LAUNCH COMMAND ===');
  console.log('java', args.slice(0, 5).join(' '), '...');
  console.log('======================\n');
  
  return args;
}