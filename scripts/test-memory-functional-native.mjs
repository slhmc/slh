// One isolated functional run. No memory/CPU/GPU counters, stress or game launch.
import { chromium } from '@playwright/test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';

const exe=path.resolve(process.argv[2] ?? 'src-tauri/target/release/slh.exe');
const root=path.resolve('test-results/memory-functional-native-20261013');
const output=path.resolve('docs/verification/memory-20261013');
await mkdir(root,{recursive:true}); await mkdir(output,{recursive:true});
const server=net.createServer();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
await new Promise(resolve=>server.close(resolve));
const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const child=spawn(exe,['--isolated','--data-dir',root],{windowsHide:true,stdio:'ignore',
  env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}});
let browser;
let page;
const checks=[];
const cpuCheck=process.argv.includes('--cpu-check');
try {
  for(let attempt=0;attempt<80;attempt++) {
    if(child.exitCode!==null) throw new Error(`SLH exited: ${child.exitCode}`);
    try { browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:500});break; } catch {await sleep(200);}
  }
  assert(browser,'WebView2 did not open a debugging endpoint');
  for(let attempt=0;attempt<40;attempt++) {
    page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes('tauri.localhost'));
    if(page) break; await sleep(200);
  }
  assert(page,'No launcher page');
  await page.waitForFunction(()=>Boolean(window.__TAURI_INTERNALS__));
  const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
  const bootstrap=await invoke('get_bootstrap');
  if(!bootstrap.accounts.length) await invoke('create_offline_account',{request:{username:'MemoryCheck'}});
  await invoke('update_setting',{key:'onboarding',value:{completed:true}});
  await invoke('update_setting',{key:'general',value:{...bootstrap.settings.general,language:'en-US',checkUpdatesAutomatically:false,lastSection:'home',rememberSection:true}});
  await page.reload();
  await page.evaluate(()=>{location.hash='/home';});
  await page.waitForFunction(()=>document.querySelector('canvas')?.height>150);
  assert(await page.locator('canvas').first().evaluate(canvas=>{const gl=canvas.getContext('webgl2');return Boolean(gl&&!gl.isContextLost());}),'Home has no real WebGL context');
  checks.push('Real WebGL home');
  if(cpuCheck) {
    const beforePause=await invoke('get_window_activity');
    await page.evaluate(()=>{window.__warmCanvas=document.querySelector('canvas');});
    const nativeWindow=async action=>promisify(execFile)('powershell',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/launcher-test-window.ps1'),'-LauncherId',String(child.pid),'-Action',action],{windowsHide:true});
    await nativeWindow('minimize');
    await sleep(350);
    await nativeWindow('restore');
    await page.waitForFunction(()=>!document.hidden);
    await page.waitForFunction(async()=> (await window.__TAURI_INTERNALS__.invoke('get_window_activity')).active,undefined,{polling:100,timeout:5000});
    const afterPause=await invoke('get_window_activity');
    const nativeFlags={visible:await invoke('plugin:window|is_visible',{label:'main'}),minimized:await invoke('plugin:window|is_minimized',{label:'main'})};
    assert(afterPause.active&&afterPause.successfulSuspensions>beforePause.successfulSuspensions,`The ordinary background did not suspend: ${JSON.stringify({beforePause,afterPause,nativeFlags})}`);
    assert(await page.evaluate(()=>window.__warmCanvas===document.querySelector('canvas')&&window.__warmCanvas.height>150),'Restore recreated the warm scene');
    await page.evaluate(()=>{delete window.__warmCanvas;});
    checks.push('One minimization suspends WebView2 and preserves the warm canvas on restore');
  }
  await page.screenshot({path:path.join(output,'native-home.png')});
  const before=await invoke('get_locale_revision',{code:'en-US'});
  assert.equal(before,await invoke('get_locale_revision',{code:'en-US'}));
  const languages=path.join(root,'data/languages');
  await mkdir(languages,{recursive:true});
  const extension=path.join(languages,'functional-extension.json');
  await writeFile(extension,JSON.stringify({meta:{code:'en-US',name:'English',schemaVersion:1},navigation:{home:'Home probe'}}));
  assert.notEqual(before,await invoke('get_locale_revision',{code:'en-US'}));
  await page.getByText('Home probe',{exact:true}).waitFor();
  checks.push('Editable locale detected without a page reload');
  await unlink(extension);
  await page.getByText('Home',{exact:true}).first().waitFor();
  checks.push('Removed locale extension restores bundled text');
  await page.evaluate(()=>{window.__oldCanvas=document.querySelector('canvas');location.hash='/library';});
  await page.waitForFunction(()=>location.hash==='#/library'&&!document.querySelector('canvas'));
  await page.waitForFunction(()=>window.__oldCanvas?.width===1&&window.__oldCanvas?.height===1);
  checks.push('Leaving home releases the canvas backing store');
  await page.evaluate(()=>{delete window.__oldCanvas;location.hash='/home';});
  await page.waitForFunction(()=>document.querySelector('canvas')?.height>150);
  checks.push('Home restores after a page transition');
  await invoke('exit_app').catch(()=>{});
  for(let attempt=0;attempt<30&&child.exitCode===null;attempt++) await sleep(100);
  assert.equal(child.exitCode,0,'Launcher did not exit normally');
  checks.push('Test launcher closed normally');
  await writeFile(path.join(output,cpuCheck?'native-cpu-functional.json':'native-functional.json'),JSON.stringify({checks,measurements:false,userDataUsed:false},null,2));
  console.log(JSON.stringify({passed:checks.length,measurements:false}));
} catch(error) {
  if(page) {
    await page.screenshot({path:path.join(output,'native-failure.png')}).catch(()=>{});
    await writeFile(path.join(output,'native-failure.txt'),String(error)).catch(()=>{});
  }
  throw error;
} finally {
  if(child.exitCode===null) child.kill();
  await browser?.close().catch(()=>{});
}
