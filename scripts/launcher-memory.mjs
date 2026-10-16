// Release WebView2 integration and external memory comparison. Only isolated
// copies are accepted. This does not add diagnostic code to the shipped UI.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts/memory-optimization-20261012');
const mode = process.argv[2] ?? 'probe';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = (name, value) => fs.writeFile(path.join(output, name), JSON.stringify(value, null, 2));
const invoke = (page, command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
async function windowAction(launcherId, action) {
  return await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/launcher-test-window.ps1'), '-LauncherId', String(launcherId), '-Action', action], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let result = ''; child.stdout.on('data', value => { result += value; });
    let error = ''; child.stderr.on('data', value => { error += value; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(JSON.parse(result)) : reject(Error(error)));
  });
}

async function launch(version, port) {
  const directory = path.join(output, version);
  const data = path.join(output, `data-${version}`);
  const marker = JSON.parse(await fs.readFile(path.join(data, 'native-prototype.json'), 'utf8'));
  if (!marker.isolated || path.resolve(marker.root) !== data || data.toLowerCase().startsWith(path.resolve('E:/SLH').toLowerCase())) throw Error('Not an isolated data root');
  const executable = path.join(directory, 'SLH.exe');
  const child = spawn(executable, ['--isolated', '--data-dir', data], {
    cwd: directory, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'webview-profile'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` },
  });
  child.on('error', error => console.error(error.message));
  let browser;
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw Error(`Launcher exited: ${child.exitCode}`);
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); break; } catch { await sleep(500); }
    }
    if (!browser) throw Error('WebView2 debugging endpoint did not appear');
    const page = browser.contexts()[0].pages()[0];
    await page.waitForFunction(() => window.__TAURI_INTERNALS__ && document.querySelector('nav'), { timeout: 60000 });
    const nativeWindow = await windowAction(child.pid, 'size');
    if (nativeWindow.Width !== 1440 || nativeWindow.Height !== 900) throw Error('Window size does not match the benchmark');
    const bootstrap = await invoke(page, 'get_bootstrap');
    if (path.resolve(bootstrap.portableRoot) !== data) throw Error('Launcher resolved a different root');
    return { page, browser, child, bootstrap, data, nativeWindow, async close() {
      try { await invoke(page, 'exit_app'); } catch { }
      await sleep(1000);
      if (child.exitCode === null) child.kill();
      await browser.close().catch(() => {});
    } };
  } catch (error) { await browser?.close().catch(() => {}); child.kill(); throw error; }
}

async function navigate(page, hash) {
  const start = performance.now();
  await page.evaluate(hash => { location.hash = hash; }, hash);
  await page.waitForFunction(hash => location.hash === `#${hash}` && !document.querySelector('[class*="boot"]'), hash);
  await page.locator('main').first().waitFor({ state: 'visible', timeout: 30000 });
  const route = hash.split('?')[0].split('/')[1];
  const ready = {
    home: 'main [role="search"]',
    library: 'main [class*="_library_"]',
    discover: 'main [class*="_searchBox_"]',
    servers: 'main h1',
    settings: 'main aside h1',
    instance: 'main [class*="_consolePanel_"]',
  }[route];
  if (ready) await page.locator(ready).first().waitFor({ state: 'visible', timeout: 30000 });
  const mountedMs = performance.now() - start;
  // Route chunks and backend queries must finish before the warmup begins.
  await sleep(1500);
  return mountedMs;
}

async function home(page) {
  await navigate(page, '/home');
  await expect(page.locator('[role="group"] canvas').first()).toBeVisible({ timeout: 30000 });
  await page.waitForFunction(() => [...document.querySelectorAll('canvas')].some(c => c.width > 160 && c.height > 320));
}

async function inspectScene(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('[role="group"] canvas');
    if (!canvas) throw Error('No home canvas');
    let fiber = canvas[Object.keys(canvas).find(key => key.startsWith('__reactFiber$'))];
    while (fiber) {
      let hook = fiber.memoizedState;
      while (hook && typeof hook === 'object') {
        const engine = hook.memoizedState?.current;
        if (engine?.getDebugStats && engine?.renderer) return { stats: engine.getDebugStats(), atmosphereAllocated: engine._atmosphere !== null, effectsEnabled: engine._enableEffects, sceneChildren: engine.scene.children.length };
        hook = hook.next;
      }
      fiber = fiber.return;
    }
    throw Error('No live engine ref');
  });
}

async function update(page, key, patch) {
  const data = await invoke(page, 'get_bootstrap');
  await invoke(page, 'update_setting', { key, value: { ...data.settings[key], ...patch } });
  // The IPC command writes the database; normal UI callers also refresh the
  // Zustand store. Find the existing subscribed action without shipping a
  // benchmark API or changing production command contracts.
  await page.evaluate(async () => {
    const element = document.querySelector('main');
    let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber$'))];
    while (fiber) {
      let hook = fiber.memoizedState;
      while (hook && typeof hook === 'object') {
        const action = hook.memoizedState;
        if (typeof action === 'function' && action.name === 'refresh') { await action(); return; }
        hook = hook.next;
      }
      fiber = fiber.return;
    }
    throw Error('Could not refresh the UI after updating the isolated settings');
  });
  await sleep(500);
}

async function skinDialog(page) {
  await navigate(page, '/settings/accounts');
  const buttons = page.getByRole('button', { name: /Manage skin and cape|Управление скином и плащом|скин.*плащ|Skin.*Umhang/i });
  await buttons.first().click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('dialog').locator('canvas').first().waitFor();
  await sleep(2000);
}

async function measure(launcher, name, warmup = 60, duration = 180) {
  const file = path.join(output, 'measurements', `${name}.json`);
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/measure-launcher.ps1'), '-LauncherId', String(launcher.child.pid), '-OutputPath', file, '-Scenario', name, '-WarmupSeconds', String(warmup), '-DurationSeconds', String(duration), '-IncludeGpu'];
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    child.stderr.on('data', value => { error += value; });
    child.stdout.on('data', value => process.stdout.write(value));
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(Error(error || `Measurement failed: ${code}`)));
  });
}

const scenarios = [
  ['home-beautiful', async p => { await update(p, 'appearance', { beautifulHome: true }); await home(p); }],
  ['home-classic', async p => { await update(p, 'appearance', { beautifulHome: false }); await navigate(p, '/home'); }],
  ['library', p => navigate(p, '/library')],
  ['discover', p => navigate(p, '/discover?type=modpack&source=modrinth')],
  ['servers', p => navigate(p, '/servers')],
  ['settings', p => navigate(p, '/settings/appearance')],
  ['instance-console', async (p, b) => {
    const instance = b.instances.find(i => i.loaderType !== 'bedrock');
    if (!instance) throw Error('No Java instance for console scenario');
    await navigate(p, `/instance/${instance.id}?tab=logs`);
  }],
  ['skin-dialog', skinDialog],
  ['minimized', async (p, _b, launcher) => {
    await p.keyboard.press('Escape');
    await update(p, 'appearance', { beautifulHome: true }); await home(p);
    await windowAction(launcher.child.pid, 'minimize');
  }],
  ['restored', async (p, _b, launcher) => { await windowAction(launcher.child.pid, 'restore'); await home(p); }],
];

async function run() {
  await fs.mkdir(output, { recursive: true });
  if (mode === 'probe') {
    const launcher = await launch(process.argv[3] ?? 'baseline', 9337);
    try {
      await update(launcher.page, 'appearance', { beautifulHome: true }); await home(launcher.page);
      console.log(JSON.stringify(await launcher.page.evaluate(() => ({ url: location.href, canvas: [...document.querySelectorAll('canvas')].map(c => ({ width: c.width, height: c.height, class: c.className })), buttons: [...document.querySelectorAll('button')].map(b => b.textContent).slice(0,15) })), null, 2));
      await launcher.page.screenshot({ path: path.join(output, 'baseline-home.png') });
    } finally { await launcher.close(); }
    return;
  }
  if (mode === 'smoke') {
    const launcher = await launch('optimized', 9337);
    const p = launcher.page;
    const result = { transitions: [], restores: [], errors: [] };
    p.on('pageerror', error => result.errors.push(error.message));
    try {
      await update(p, 'appearance', { beautifulHome: true, homeCharacterFps: 30, scalePercent: 100 }); await home(p);
      await p.waitForTimeout(2000);
      result.initial = await inspectScene(p);
      expect(result.initial.atmosphereAllocated).toBe(false);
      await p.evaluate(() => { window.__slhInitialCanvas = document.querySelector('[role="group"] canvas'); });
      for (const fps of [1, 0, 60, 30]) {
        await update(p, 'appearance', { homeCharacterFps: fps });
        expect(await p.evaluate(() => window.__slhInitialCanvas === document.querySelector('[role="group"] canvas'))).toBe(true);
      }
      await p.evaluate(() => { delete window.__slhInitialCanvas; });
      const canvas = p.locator('[role="group"] canvas').first();
      const box = await canvas.boundingBox();
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await p.mouse.down(); await p.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 12 }); await p.mouse.up();
      await p.keyboard.down('Control'); await p.mouse.wheel(0, 120); await p.keyboard.up('Control');
      await p.screenshot({ path: path.join(output, 'optimized-home.png') });
      const client = await launcher.browser.contexts()[0].newCDPSession(p);
      await client.send('HeapProfiler.collectGarbage');
      result.heapBefore = await client.send('Runtime.getHeapUsage');
      for (let cycle = 1; cycle <= 20; cycle++) {
        await navigate(p, '/library'); await home(p);
        result.transitions.push(await inspectScene(p));
        console.log(`SMOKE transition ${cycle}/20`);
      }
      for (let cycle = 1; cycle <= 20; cycle++) {
        await windowAction(launcher.child.pid, 'minimize'); await sleep(cycle === 1 ? 35000 : 500);
        await windowAction(launcher.child.pid, 'restore'); await sleep(700); await home(p);
        result.restores.push(await inspectScene(p));
        console.log(`SMOKE restore ${cycle}/20`);
      }
      // Replace the isolated account skin response without touching provider
      // APIs or saved skins, then notify through the normal refresh event.
      await p.evaluate(async () => {
        const internals = window.__TAURI_INTERNALS__;
        const original = internals.invoke;
        const b = await original('get_bootstrap');
        const active = b.accounts.find(a => a.active);
        const skin = await original('get_home_account_skin', { accountId: active.id });
        internals.invoke = (command, args, ...rest) => command === 'get_home_account_skin'
          ? Promise.resolve({ ...skin, model: skin.model === 'slim' ? 'classic' : 'slim' }) : original(command, args, ...rest);
        window.dispatchEvent(new CustomEvent('slh-account-avatar-updated', { detail: active.id }));
        window.setTimeout(() => { internals.invoke = original; }, 2000);
      });
      await sleep(2500); await home(p);
      result.changedSkin = await inspectScene(p);
      await client.send('HeapProfiler.collectGarbage');
      result.heapAfter = await client.send('Runtime.getHeapUsage');
      result.final = await inspectScene(p);
      await skinDialog(p); await p.screenshot({ path: path.join(output, 'optimized-skin-dialog.png') });
      await p.keyboard.press('Escape');
      expect(result.errors).toEqual([]);
      result.passed = true;
    } finally { await save('native-webgl-smoke.json', result); await launcher.close(); }
    return;
  }
  if (mode === 'preflight') {
    for (const version of process.argv[3] ? [process.argv[3]] : ['baseline', 'optimized']) {
      const launcher = await launch(version, 9337);
      try {
        for (const [name, setup] of scenarios) {
          await setup(launcher.page, launcher.bootstrap, launcher);
          console.log(`PREFLIGHT ${version} ${name}`);
        }
      } finally { await launcher.close(); }
    }
    return;
  }
  if (mode === 'benchmark') {
    const manifest = [];
    for (let pass = 1; pass <= 3; pass++) {
      // Alternate version order to expose drift during a long run.
      for (const version of pass === 2 ? ['optimized', 'baseline'] : ['baseline', 'optimized']) {
        const launcher = await launch(version, 9337);
        try {
          await update(launcher.page, 'appearance', { homeCharacterFps: 30, scalePercent: 100 });
          for (const [scenario, setup] of scenarios) {
            const name = `${version}-${scenario}-${pass}`;
            console.log(`START ${name}`);
            const setupMs = await setup(launcher.page, launcher.bootstrap, launcher);
            await save('benchmark-status.json', { current: name, completed: manifest.length, total: 60, started: new Date().toISOString() });
            await measure(launcher, name);
            manifest.push({ name, setupMs, version, scenario, pass });
            await save('benchmark-manifest.json', manifest);
            console.log(`DONE ${name}`);
          }
        } finally { await launcher.close(); }
      }
    }
    await save('benchmark-status.json', { complete: true, completed: manifest.length, total: 60 });
    return;
  }
  throw Error(`Unknown mode: ${mode}`);
}
run().catch(error => { console.error(error); process.exitCode = 1; });
