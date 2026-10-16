// Isolated WebView2 benchmark; never writes to an installed launcher's data.
import { chromium } from '@playwright/test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';

const [exeArgument, label] = process.argv.slice(2);
const lifecycleOnly=process.argv.includes('--lifecycle-only');
const legacyPolicy=process.argv.includes('--legacy-policy');
assert(exeArgument && /^[a-z0-9-]+$/.test(label), 'Provide executable and a benchmark label');
const exe = path.resolve(exeArgument);
assert(exe.toLowerCase().includes(`${path.sep}artifacts${path.sep}memory-optimization-`), 'Use an isolated artifact executable');
const root = path.resolve('test-results', `home-benchmark-${label}`);
const output = path.resolve('artifacts/performance', label);
await mkdir(root, { recursive:true }); await mkdir(output, { recursive:true });
const server = net.createServer();
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
const run = promisify(execFile);
const child = spawn(exe,['--isolated','--data-dir',root],{ windowsHide:true,stdio:['ignore','ignore','pipe'],
  env:{ ...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}` } });
child.stderr.pipe(createWriteStream(path.join(output,'native-stderr.log')));
child.on('exit',(code,signal)=>console.log(JSON.stringify({label,event:'launcher-exit',code,signal})));
let browser, page;
try {
  for (let attempt=0; attempt<100; attempt++) {
    assert(child.exitCode === null, `Launcher exited with ${child.exitCode}`);
    try { browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:500}); break; }
    catch { await sleep(200); }
  }
  assert(browser,'WebView2 debugging endpoint unavailable');
  for (let attempt=0; attempt<50; attempt++) {
    page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes('tauri.localhost'));
    if (page) break; await sleep(200);
  }
  assert(page,'Launcher page unavailable');
  const invoke=(command,args={})=>page.evaluate(async ({command,args})=>{
    try { return await window.__TAURI_INTERNALS__.invoke(command,args); }
    catch (error) { throw new Error(`${command}: ${JSON.stringify(error)}`); }
  },{command,args});
  const bootstrap=await invoke('get_bootstrap');
  if (!bootstrap.accounts.length) await invoke('create_offline_account',{request:{username:'PerformanceCheck'}});
  await invoke('update_setting',{key:'onboarding',value:{completed:true}});
  await invoke('update_setting',{key:'general',value:{...bootstrap.settings.general,language:'en-US',checkUpdatesAutomatically:false,
    lastSection:'home',rememberSection:true,webview:{enabled:false,extreme:false,cpuCores:1,backgroundCpuCores:1,
      backgroundMemoryMb:128,maxFps:15,suspendAfterSeconds:5,...bootstrap.settings.general.webview,
      ...(legacyPolicy?{enabled:true,extreme:true,maxFps:1,backgroundMemoryMb:16,suspendAfterSeconds:1}:{enabled:false})}}});
  await invoke('update_setting',{key:'appearance',value:{...bootstrap.settings.appearance,minimalism:false,beautifulHome:true,homeCharacterFps:0}});
  await page.reload();
  if (legacyPolicy) {
    const saved=await invoke('get_bootstrap');
    assert.equal(saved.settings.general.webview.enabled,true,'Legacy policy was unexpectedly erased');
    assert.equal(saved.settings.general.webview.maxFps,1);
    await page.evaluate(()=>{location.hash='/settings/advanced';});
    await page.getByRole('button',{name:'Check for updates',exact:true}).waitFor();
    assert.equal(await page.locator('[data-webview-controls]').count(),0,'Removed resource controls reappeared');
    await page.screenshot({path:path.join(output,'advanced.png')});
  }
  await page.evaluate(()=>{location.hash='/home';});
  await page.waitForFunction(()=>document.querySelector('canvas')?.height>150).catch(async error=>{
    console.log(await page.evaluate(()=>({url:location.href,text:document.body.innerText.slice(0,1200)})));
    throw error;
  });
  const windowAction=action=>run('pwsh',['-NoProfile','-ExecutionPolicy','Bypass','-File',
    path.resolve('scripts/launcher-test-window.ps1'),'-LauncherId',String(child.pid),'-Action',action,
    '-Width','2560','-Height','1356'],{windowsHide:true});
  const nativeWindow=JSON.parse((await windowAction('size')).stdout);
  const conditions=await page.evaluate(()=>{
    const canvas=document.querySelector('canvas');
    const gl=canvas.getContext('webgl2');
    const debug=gl?.getExtension('WEBGL_debug_renderer_info');
    return { dpr:devicePixelRatio,viewport:[innerWidth,innerHeight],canvas:[canvas.width,canvas.height],fps:0,limits:false,
      gpu:debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null };
  });
  conditions.nativeWindow=nativeWindow;
  conditions.legacyResourcePolicySaved=legacyPolicy;
  const renderedFps=()=>page.evaluate(async ()=>{
    const gl=document.querySelector('canvas').getContext('webgl2');
    const clear=gl.clear;
    let frames=0;
    gl.clear=function(mask) {
      if ((mask&gl.COLOR_BUFFER_BIT)&&gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)===null) frames++;
      return clear.call(this,mask);
    };
    const start=performance.now();
    try { await new Promise(resolve=>setTimeout(resolve,1500)); return frames*1000/(performance.now()-start); }
    finally {gl.clear=clear;}
  });
  conditions.renderedFpsBefore=await renderedFps();
  if (legacyPolicy) assert(conditions.renderedFpsBefore>10,'Legacy 1 FPS policy must be ignored');
  const measure=async (scenario,warmup=10,duration=30)=>{
    const file=path.join(output,`${scenario}.json`);
    await run('pwsh',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/measure-launcher.ps1'),
      '-LauncherId',String(child.pid),'-OutputPath',file,'-WarmupSeconds',String(warmup),'-DurationSeconds',String(duration),
      '-Scenario',scenario],{windowsHide:true,timeout:180000});
    return JSON.parse(await readFile(file,'utf8'));
  };
  if (process.argv.includes('--compare-character-modes')) {
    const modes=[];
    for (const mode of [1,0,2]) {
      const bootstrap=await invoke('get_bootstrap');
      await invoke('update_setting',{key:'appearance',value:{...bootstrap.settings.appearance,homeCharacterMode:mode}});
      await page.reload();
      if (mode===1) {
        await page.locator('[data-home-character="image"] img').waitFor();
        await page.locator('[data-home-character="image"] img').evaluate(image=>image.decode());
        assert(await page.locator('[data-home-character="image"] img').evaluate(image=>image.getBoundingClientRect().bottom<=innerHeight),
          'Portrait extends below the native window');
        await page.screenshot({path:path.join(output,'portrait.png')});
        await page.reload();
        await page.locator('[data-home-character="image"] img').waitFor();
        await page.locator('[data-home-character="image"] img').evaluate(image=>image.decode());
      } else if (mode===2) await page.waitForFunction(()=>document.querySelector('canvas')?.height>150);
      else await page.getByRole('search').waitFor();
      const state=await page.evaluate(()=>({canvasCount:document.querySelectorAll('canvas').length,
        engineImported:performance.getEntriesByType('resource').some(entry=>/scene-loop-[^/]+\.js/.test(entry.name))}));
      assert.equal(state.canvasCount,mode===2?1:0,'Unexpected retained 3D canvas');
      if (mode!==2) assert.equal(state.engineImported,false,'Static/off modes imported the 3D engine');
      const saved=await invoke('get_bootstrap');assert.equal(saved.settings.appearance.homeCharacterMode,mode);
      modes.push({mode,...state});
    }
    await page.evaluate(()=>{location.hash='/settings/appearance';});
    const modeSlider=page.getByRole('slider',{name:'Home character',exact:true});
    await modeSlider.waitFor();
    await modeSlider.press('End');
    await page.waitForFunction(async()=> (await window.__TAURI_INTERNALS__.invoke('get_bootstrap')).settings.appearance.homeCharacterMode===0);
    await modeSlider.press('Home');
    await page.waitForFunction(async()=> (await window.__TAURI_INTERNALS__.invoke('get_bootstrap')).settings.appearance.homeCharacterMode===2);
    await writeFile(path.join(output,'modes.json'),JSON.stringify({conditions,modes,sliderVerified:true},null,2));
    console.log(JSON.stringify({label,modes}));
  } else {
  console.log(JSON.stringify({label,conditions,pid:child.pid,stage:'open'}));
  const open=await measure('open',lifecycleOnly?0:10,lifecycleOnly?3:30);
  conditions.renderedFpsAfter=await renderedFps();
  conditions.nativeWindowAfter=JSON.parse((await windowAction('inspect')).stdout);
  await page.screenshot({path:path.join(output,'home.png')});
  if (process.argv.includes('--open-only')) {
    const totals = new Map();
    for (const row of open) {
      const total=totals.get(row.Seconds)??{cpu:0,memory:0};
      total.cpu+=row.CpuPercent;total.memory+=row.PrivateWorkingSetMiB;totals.set(row.Seconds,total);
    }
    const values=[...totals.values()];
    const report={label,conditions,open:{samples:values.length,
      cpuAverage:values.reduce((sum,v)=>sum+v.cpu,0)/values.length,cpuMaximum:Math.max(...values.map(v=>v.cpu)),
      memoryAverageMiB:values.reduce((sum,v)=>sum+v.memory,0)/values.length,memoryMaximumMiB:Math.max(...values.map(v=>v.memory))}};
    await writeFile(path.join(output,'summary.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  } else {
  await page.evaluate(()=>{window.__benchmarkCanvas=document.querySelector('canvas');});
  await windowAction('minimize');
  await sleep(350);
  await windowAction('restore');
  if (!browser.isConnected() || page.isClosed()) {
    browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:5000});
    page=browser.contexts().flatMap(context=>context.pages()).find(candidate=>candidate.url().includes('tauri.localhost'));
  }
  await page.waitForFunction(()=>!document.hidden&&document.querySelector('canvas')?.height>150);
  const quickRestore=await page.evaluate(()=>window.__benchmarkCanvas===document.querySelector('canvas'));
  assert(quickRestore,'Quick restore must preserve the warm character scene');
  await windowAction('minimize');
  console.log(JSON.stringify({label,stage:'minimized'}));
  const minimized=await measure('minimized',35,lifecycleOnly?3:30);
  const restoreStart=performance.now();
  await windowAction('restore');
  let debuggerReconnected=false;
  try { await page.waitForFunction(()=>!document.hidden&&document.querySelector('canvas')?.height>150); }
  catch (error) {
    console.log(JSON.stringify({label,event:'restore-target-unavailable',exitCode:child.exitCode,error:String(error)}));
    console.log(JSON.stringify({label,connected:browser.isConnected(),window:(await windowAction('inspect')).stdout,
      targets:await fetch(`http://127.0.0.1:${port}/json/list`).then(response=>response.json()).catch(error=>String(error))}));
    if (child.exitCode!==null) throw error;
    if(!browser.isConnected()) browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:5000});
    for (let attempt=0;attempt<20;attempt++) {
      const candidate=browser.contexts().flatMap(context=>context.pages()).find(candidate=>!candidate.isClosed()&&candidate.url().includes('tauri.localhost'));
      if (candidate) {page=candidate;debuggerReconnected=true;break;}
      await sleep(250);
    }
    await page.waitForFunction(()=>!document.hidden&&document.querySelector('canvas')?.height>150);
  }
  const restored=await page.evaluate(()=>({ recreated:window.__benchmarkCanvas!==document.querySelector('canvas'),
    releasedSize:window.__benchmarkCanvas ? [window.__benchmarkCanvas.width,window.__benchmarkCanvas.height] : null,
    webgl:Boolean(document.querySelector('canvas').getContext('webgl2')&&!document.querySelector('canvas').getContext('webgl2').isContextLost()) }));
  assert(restored.webgl,'Restored canvas lost its WebGL context');
  await page.screenshot({path:path.join(output,'restored.png')});
  const summarize=rows=>{
    const totals=new Map();
    for (const row of rows) {
      const sum=totals.get(row.Seconds)??{cpu:0,memory:0};
      sum.cpu+=row.CpuPercent; sum.memory+=row.PrivateWorkingSetMiB;
      totals.set(row.Seconds,sum);
    }
    const values=[...totals.values()];
    return { samples:values.length,cpuAverage:values.reduce((sum,v)=>sum+v.cpu,0)/values.length,
      cpuMaximum:Math.max(...values.map(v=>v.cpu)),memoryAverageMiB:values.reduce((sum,v)=>sum+v.memory,0)/values.length,
      memoryMaximumMiB:Math.max(...values.map(v=>v.memory)) };
  };
  const report={label,conditions,open:summarize(open),minimized:summarize(minimized),quickRestore,restored,debuggerReconnected,restoreElapsedMs:performance.now()-restoreStart};
  await writeFile(path.join(output,'summary.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
  }
  }
} finally {
  if (page) await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('exit_app')).catch(()=>{});
  await browser?.close().catch(()=>{});
  for(let attempt=0;attempt<50&&child.exitCode===null;attempt++) await sleep(100);
  if(child.exitCode===null) child.kill(); // Only the child created by this script.
}
