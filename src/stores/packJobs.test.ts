// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { cancelPackInstall, packJobInstance, packJobProgress, receivePackProgress, runPackInstall, usePackJobs } from './packJobs';
const mocks = vi.hoisted(() => ({ command: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/tauri', () => ({ command: mocks.command }));
vi.mock('./appStore', () => ({ useAppStore: { getState: () => ({ refresh: mocks.refresh }) } }));
const spec = { key: 'curseforge:1204182:9086419', name: 'Horror', minecraftVersion: '1.19.2', loaderType: 'forge' as const, commandName: 'install_curseforge_modpack', args: { projectId: '1204182', versionId: '9086419' }, showDialog: true };
beforeEach(() => { usePackJobs.setState({ jobs: [], activeKey: null }); mocks.command.mockReset(); mocks.refresh.mockClear(); });
it('keeps a clickable library job through archive verification, a closed dialog and missing-file recovery', async () => {
  let reject!: (reason: unknown) => void;
  mocks.command.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const request = runPackInstall(spec);
  expect(runPackInstall(spec)).toBe(request);
  const job = usePackJobs.getState().jobs[0];
  expect(job.phase).toBe('running');
  expect(packJobInstance(job)).toMatchObject({ name: 'Horror', status: 'installing', minecraftVersion: '1.19.2' });
  usePackJobs.getState().show(null);
  expect(usePackJobs.getState().jobs).toHaveLength(1);
  reject({ message: 'Download required files into curseforge-manual' });
  await expect(request).rejects.toMatchObject({ message: expect.stringContaining('curseforge-manual') });
  expect(usePackJobs.getState().jobs[0].phase).toBe('waiting');
  expect(usePackJobs.getState().activeKey).toBe(spec.key);
  mocks.command.mockResolvedValueOnce({ id: 'installed', name: 'Horror' });
  await expect(runPackInstall(usePackJobs.getState().jobs[0])).resolves.toMatchObject({ id: 'installed' });
  expect(mocks.command).toHaveBeenLastCalledWith("run_pack_install", { key: spec.key, commandName: spec.commandName, args: spec.args });
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
  expect(usePackJobs.getState().jobs).toEqual([]);
});
it('retains the exact network failure instead of discarding it into a generic toast', async () => {
  mocks.command.mockRejectedValueOnce({ message: 'HTTP 429: Retry in 30 seconds' });
  await expect(runPackInstall(spec)).rejects.toBeDefined();
  expect(usePackJobs.getState().jobs[0]).toMatchObject({ phase: 'error', error: 'HTTP 429: Retry in 30 seconds' });
  usePackJobs.getState().dismiss(spec.key);
  expect(usePackJobs.getState().jobs).toEqual([]);
});
it('tracks only its own archive, file and Minecraft progress across operation IDs', async () => {
  let resolve!: (value: unknown) => void;
  mocks.command.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const request = runPackInstall(spec);
  const event = { operationId: spec.key, instanceId: null as string | null, operation: 'import', stage: 'pack-metadata', message: '', completed: 20, total: 61, downloadedBytes: null, totalBytes: null };
  receivePackProgress({ ...event, operationId: 'another-job' });
  expect(usePackJobs.getState().jobs[0].progress).toBeUndefined();
  receivePackProgress(event);
  expect(packJobProgress(usePackJobs.getState().jobs[0])).toMatchObject({ message: 'Preparing files', counter: '20 / 61' });
  receivePackProgress({ ...event, stage: 'pack-files', instanceId: 'new-instance' });
  receivePackProgress({ ...event, operationId: 'minecraft-id', instanceId: 'new-instance', operation: 'install', stage: 'assets', completed: 100, total: 200 });
  expect(packJobProgress(usePackJobs.getState().jobs[0])).toMatchObject({ message: 'Installing Minecraft', percentage: 50 });
  resolve({ id: 'new-instance' });
  await request;
});

it('waits for backend cancellation and keeps a cancelled job without an error or success callback', async () => {
  let reject!: (reason: unknown) => void;
  const onSuccess = vi.fn();
  mocks.command.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const request = runPackInstall({ ...spec, onSuccess });
  const rejection = expect(request).rejects.toMatchObject({ code: 'cancelled' });
  mocks.command.mockImplementationOnce(async () => {
    reject({ code: 'cancelled', message: 'Installation cancelled' });
    return true;
  });
  await cancelPackInstall(spec.key);
  await rejection;
  expect(mocks.command).toHaveBeenLastCalledWith('cancel_pack_install', { key: spec.key });
  expect(usePackJobs.getState().jobs[0]).toMatchObject({ phase: 'cancelled', error: null });
  expect(packJobProgress(usePackJobs.getState().jobs[0]).message).toBe('Installation cancelled');
  expect(onSuccess).not.toHaveBeenCalled();
  usePackJobs.getState().dismiss(spec.key);
  expect(usePackJobs.getState().jobs).toEqual([]);
});

