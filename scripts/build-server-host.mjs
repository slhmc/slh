import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nativeTarget = spawnSync('rustc',['-vV'],{encoding:'utf8'}).stdout?.match(/^host: (.+)$/m)?.[1];
const explicitTarget = process.argv.indexOf('--target');
const target = (explicitTarget >= 0 ? process.argv[explicitTarget + 1] : undefined)
  ?? process.env.CARGO_BUILD_TARGET ?? process.env.TAURI_ENV_TARGET_TRIPLE
  ?? nativeTarget;
if (!target) throw new Error('Unable to determine the server-host target');
const args = ['build', '--manifest-path', resolve(root,'crates/slh-core/Cargo.toml'), '--bin', 'slh-server-host', '--release', '--target-dir', resolve(root,'crates/slh-core/target')];
if (target !== nativeTarget) args.push('--target',target);
const result = spawnSync('cargo',args,{cwd:root,stdio:'inherit'});
if (result.status !== 0) process.exit(result.status ?? 1);
const name = target.includes('windows') ? 'slh-server-host.exe' : 'slh-server-host';
const source = resolve(root,'crates/slh-core/target',...(target !== nativeTarget ? [target] : []),'release',name);
mkdirSync(resolve(root,'.generated/server-host',target),{recursive:true});
copyFileSync(source,resolve(root,'.generated/server-host',target,name));
