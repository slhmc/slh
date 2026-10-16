// Short, isolated measurement of the installed build. No games or downloads.
import { chromium } from '@playwright/test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = path.resolve(`artifacts/memory-optimization-mini-${stamp}`);
const data = path.join(root, 'isolated-data');
await mkdir(data, { recursive: true });
const exe = path.join(root, 'SLH.exe');
await copyFile('E:/SLH/SLH.exe', exe);
const server = net.createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exec = promisify(execFile);
const run = (file,args,options={}) => exec(file,args,{...options,env:{...process.env,PSModulePath:`${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\Modules;${process.env.PSModulePath??''}`}});
const child = spawn(exe, ['--isolated', '--data-dir', data], {
  cwd: root, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` },
});
let browser, page;
const results = [];
const invoke = (command, args = {}) => page.evaluate(({command,args}) => window.__TAURI_INTERNALS__.invoke(command,args), {command,args});
const windowAction = action => run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/launcher-test-window.ps1'), '-LauncherId', String(child.pid), '-Action', action], {windowsHide:true});
try {
  for (let i=0; i<80; i++) {
    assert(child.exitCode===null, 'Launcher exited before measurement');
    try { browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {timeout:500}); break; } catch { await sleep(200); }
  }
  assert(browser, 'No debugging endpoint');
  for(let i=0;i<40;i++) {
    page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('tauri.localhost'));
    if(page) break; await sleep(200);
  }
  assert(page, 'No launcher page');
  await page.waitForFunction(()=>Boolean(window.__TAURI_INTERNALS__));
  const bootstrap=await invoke('get_bootstrap');
  assert.equal(path.resolve(bootstrap.portableRoot),data);
  if(!bootstrap.accounts.length) await invoke('create_offline_account',{request:{username:'MiniTest'}});
  await invoke('update_setting',{key:'onboarding',value:{completed:true}});
  await invoke('update_setting',{key:'general',value:{...bootstrap.settings.general,language:'en-US',checkUpdatesAutomatically:false,lastSection:'home',rememberSection:true}});
  await page.reload();
  await windowAction('size');
  await page.evaluate(()=>{location.hash='/home';});
  await page.waitForFunction(()=>document.querySelector('canvas')?.height>150);
  const settings=(await invoke('get_bootstrap')).settings;
  await writeFile(path.join(root,'settings.json'),JSON.stringify({appearance:settings.appearance,webview:settings.webview,general:settings.general},null,2));
  async function measure(name,warmup,duration) {
    console.log(`Measuring ${name}: ${warmup}s warmup + ${duration}s observation`);
    const output=path.join(root,`${name}.json`);
    await run('powershell',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/measure-launcher.ps1'),'-LauncherId',String(child.pid),'-OutputPath',output,'-Scenario',name,'-WarmupSeconds',String(warmup),'-DurationSeconds',String(duration)],{windowsHide:true});
    const rows=JSON.parse((await readFile(output,'utf8')).replace(/^\uFEFF/,''));
    const times=[...new Set(rows.map(r=>r.Seconds))];
    const samples=times.map(t=>rows.filter(r=>r.Seconds===t).reduce((sum,r)=>({cpu:sum.cpu+r.CpuPercent,workingSet:sum.workingSet+r.WorkingSetMiB,privateBytes:sum.privateBytes+r.PrivateBytesMiB,processes:sum.processes+r.ProcessCount}),{cpu:0,workingSet:0,privateBytes:0,processes:0}));
    const avg=k=>samples.reduce((s,r)=>s+r[k],0)/samples.length;
    const result={name,warmup,duration,samples:samples.length,cpuAverage:avg('cpu'),cpuPeak:Math.max(...samples.map(s=>s.cpu)),cpuLast:samples.at(-1).cpu,workingSetMiB:avg('workingSet'),privateBytesMiB:avg('privateBytes'),processCount:samples.at(-1).processes};
    results.push(result); console.log(JSON.stringify(result));
    await writeFile(path.join(root,'partial-results.json'),JSON.stringify(results,null,2));
  }
  await measure('home',15,24);
  await page.evaluate(()=>{location.hash='/library';});
  await page.waitForFunction(()=>!document.querySelector('canvas'));
  await measure('library',8,24);
  await page.evaluate(()=>{location.hash='/home';});
  await page.waitForFunction(()=>document.querySelector('canvas')?.height>150);
  await windowAction('minimize');
  await measure('minimized-home',3,36);
  await windowAction('restore');
  // Chromium may replace the debugging target after a longer suspension.
  await sleep(1000);
  if(page.isClosed()) {
    browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:5000});
    page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('tauri.localhost'));
    assert(page,`No page after restore; launcher exit=${child.exitCode}`);
  }
  await page.waitForFunction(async()=> (await window.__TAURI_INTERNALS__.invoke('get_window_activity')).active);
  await page.waitForFunction(()=>document.querySelector('canvas')?.height>150);
  await measure('restored-home',8,24);
  const activity=await invoke('get_window_activity');
  await writeFile(path.join(root,'summary.json'),JSON.stringify({results,activity,isolated:true,window:{width:1440,height:900},samplingSeconds:3,gpuMeasured:false,limitations:['One short pass','Empty test library','Remote debugging enabled','Working set sums include shared pages'],settings:{appearance:settings.appearance,webview:settings.webview}},null,2));
  await invoke('exit_app').catch(()=>{});
  for(let i=0;i<30&&child.exitCode===null;i++) await sleep(100);
  console.log(`RESULTS ${root}`);
} catch(error) {
  await writeFile(path.join(root,'failure.json'),JSON.stringify({error:String(error),launcherExit:child.exitCode,results},null,2));
  throw error;
} finally {
  if(child.exitCode===null) child.kill();
  await browser?.close().catch(()=>{});
}
