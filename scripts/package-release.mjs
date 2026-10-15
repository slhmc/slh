import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const target = process.argv[2];
if (!target || !/^(x86_64-pc-windows-msvc|x86_64-unknown-linux-gnu|x86_64-apple-darwin|aarch64-apple-darwin)$/.test(target)) throw Error('A supported Rust target is required');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const output = path.resolve('artifacts/packages');
const release = path.resolve(`src-tauri/target/${target}/release`);
const base = `SLH-${version}-${target}`;
mkdirSync(output, { recursive:true });
const licenses = destination => {
  mkdirSync(destination, {recursive:true});
  cpSync('resources/licenses',destination,{recursive:true});
  for(const [from,to] of [['LICENSE','GPL-3.0.txt'],['THIRD_PARTY_NOTICES.md','THIRD_PARTY_NOTICES.md'],['src/assets/fonts/OFL.txt','Pixeloid-OFL.txt'],['node_modules/pixelarticons/LICENSE','Pixelarticons-MIT.txt']]) cpSync(from,path.join(destination,to));
};
if (target.includes('windows')) {
  const portable = path.resolve('artifacts',base+'-portable');
  mkdirSync(portable,{recursive:true});
  cpSync(path.join(release,'slh.exe'),path.join(portable,'SLH.exe'));
  cpSync(`src-tauri/binaries/slh-bedrock-native-${target}.exe`,path.join(portable,'slh-bedrock-native.exe'));
  cpSync('resources/languages',path.join(portable,'resources/languages'),{recursive:true});
  writeFileSync(path.join(portable,'portable.flag'),'SLH portable\n');
  licenses(path.join(portable,'licenses'));
  writeFileSync(path.join(portable,'README.txt'),'Extract the entire archive to a writable folder and run SLH.exe. WebView2 Evergreen is required. No accounts or game data are included.\n');
  execFileSync('powershell.exe',['-NoProfile','-Command',`Compress-Archive -LiteralPath '${portable.replaceAll("'","''")}' -DestinationPath '${path.join(output,base+'-portable.zip').replaceAll("'","''")}' -Force`]);
  const {readdirSync}=await import('node:fs');
  const setup=readdirSync(path.join(release,'bundle/nsis')).find(name=>name.endsWith('-setup.exe'));
  if(!setup)throw Error('NSIS installer missing');
  cpSync(path.join(release,'bundle/nsis',setup),path.join(output,base+'-setup.exe'));
  const msi=readdirSync(path.join(release,'bundle/msi')).find(name=>name.endsWith('.msi'));
  if(!msi)throw Error('MSI installer missing');
  cpSync(path.join(release,'bundle/msi',msi),path.join(output,base+'.msi'));
} else if (target.includes('darwin')) {
  const {readdirSync}=await import('node:fs');
  const dmg=readdirSync(path.join(release,'bundle/dmg')).find(name=>name.endsWith('.dmg'));
  if(!dmg)throw Error('DMG installer missing');
  cpSync(path.join(release,'bundle/dmg',dmg),path.join(output,base+'.dmg'));
  const app=path.join(release,'bundle/macos/Smile LauncHer.app');
  execFileSync('ditto',['-c','-k','--sequesterRsrc','--keepParent',app,path.join(output,base+'-app.zip')]);
} else {
  const {readdirSync}=await import('node:fs');
  for(const [folder,extension] of [['appimage','.AppImage'],['deb','.deb'],['rpm','.rpm']]) {
    const directory=path.join(release,'bundle',folder);
    const name=readdirSync(directory).find(name=>name.endsWith(extension));
    if(!name)throw Error(`${extension} package missing`);
    cpSync(path.join(directory,name),path.join(output,base+extension));
  }
}
console.log(`Packages ready for ${target}: ${output}`);

// Preserve signed Tauri update payloads alongside the human-facing packages.
const { readdirSync } = await import('node:fs');
let signedSource;
let updateName;
let platform;
if (target.includes('darwin')) {
  const directory = path.join(release, 'bundle/macos');
  const archive = readdirSync(directory).find(name => name.endsWith('.app.tar.gz'));
  if (!archive) throw Error('Signed macOS updater archive missing');
  signedSource = path.join(directory, archive); updateName = base + '.app.tar.gz';
  platform = target.startsWith('aarch64') ? 'darwin-aarch64' : 'darwin-x86_64';
} else if (target.includes('windows')) {
  const directory = path.join(release, 'bundle/nsis');
  signedSource = path.join(directory, readdirSync(directory).find(name => name.endsWith('-setup.exe')));
  updateName = base + '-setup.exe'; platform = 'windows-x86_64';
} else {
  const directory = path.join(release, 'bundle/appimage');
  signedSource = path.join(directory, readdirSync(directory).find(name => name.endsWith('.AppImage')));
  updateName = base + '.AppImage'; platform = 'linux-x86_64';
}
if (path.resolve(signedSource) !== path.join(output, updateName)) cpSync(signedSource, path.join(output, updateName));
cpSync(signedSource + '.sig', path.join(output, updateName + '.sig'));
const signature = readFileSync(signedSource + '.sig', 'utf8').trim();
writeFileSync(path.join(output, `update-${platform}.json`), JSON.stringify({
  [platform]: { signature, url: `https://github.com/slhmc/slh/releases/download/v${version}/${updateName}` }
}, null, 2));
