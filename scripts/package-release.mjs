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
