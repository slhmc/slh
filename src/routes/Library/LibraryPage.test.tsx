// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { command } from '../../lib/tauri';
import { useAppStore } from '../../stores/appStore';
import { usePackJobs } from '../../stores/packJobs';
import { LibraryPage } from './LibraryPage';
import type { BootstrapData } from '../../lib/types';
vi.mock('../../i18n/I18nProvider', () => ({ useI18n: () => ({ tr: (s: string) => s, t: (_: string, fallback: string) => fallback, locale: 'en-US' }) }));
afterEach(() => { cleanup(); usePackJobs.setState({ jobs: [], activeKey: null }); });
it('keeps the modpack visible after the archive is verified and lets its card open recovery', async () => {
  const bootstrap = await command<BootstrapData>('get_bootstrap');
  useAppStore.setState({ bootstrap, activities: [], selectedInstanceId: null, search: '' });
  usePackJobs.setState({ jobs: [{ key: 'cf-fixture', name: 'Horror fixture', minecraftVersion: '1.19.2', loaderType: 'forge', commandName: 'install_curseforge_modpack', args: {}, phase: 'running', error: null, startedAt: new Date().toISOString() }] });
  render(<MemoryRouter><LibraryPage /></MemoryRouter>);
  expect(screen.getByText('Horror fixture')).toBeDefined();
  act(() => useAppStore.setState({ activities: [{ operationId: 'archive', instanceId: null, operation: 'modpack', stage: 'downloaded', message: 'Horror fixture archive verified', completed: 1, total: 1, downloadedBytes: 100, totalBytes: 100 }] }));
  expect(screen.getByText('Horror fixture')).toBeDefined();
  act(() => usePackJobs.setState((state) => ({ jobs: state.jobs.map((job) => ({ ...job, phase: 'waiting', error: 'curseforge-manual' })) })));
  expect(screen.getByText('Waiting for downloads')).toBeDefined();
  fireEvent.click(screen.getByText('Horror fixture'));
  expect(usePackJobs.getState().activeKey).toBe('cf-fixture');
});
