// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAppStore } from './appStore';
import { command } from '../lib/tauri';
import type { BootstrapData } from '../lib/types';

beforeEach(async () => {
  vi.useFakeTimers();
  useAppStore.setState({ bootstrap: await command<BootstrapData>('get_bootstrap'), toasts: [] });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('replaces the previous brief notification without dismissing the replacement early', () => {
  const store = useAppStore.getState();
  store.pushToast({ brief:true, tone:'info', title:'notifications.scaleChanged', params:{percent:105}, message:'' });
  vi.advanceTimersByTime(500);
  store.pushToast({ brief:true, tone:'info', title:'notifications.scaleChanged', params:{percent:110}, message:'' });
  expect(useAppStore.getState().toasts).toHaveLength(1);
  expect(useAppStore.getState().toasts[0].params).toEqual({percent:110});
  vi.advanceTimersByTime(1500);
  expect(useAppStore.getState().toasts).toHaveLength(1);
  vi.advanceTimersByTime(499);
  expect(useAppStore.getState().toasts).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(useAppStore.getState().toasts).toHaveLength(0);
});

it('uses its own preference and preserves normal toast timing', () => {
  const bootstrap = useAppStore.getState().bootstrap!;
  useAppStore.setState({bootstrap:{...bootstrap, settings:{...bootstrap.settings, notifications:{...bootstrap.settings.notifications, enabled:false, briefEnabled:true}}}});
  const store=useAppStore.getState();
  store.pushToast({tone:'info',title:'common.loading',message:''});
  store.pushToast({brief:true,tone:'info',title:'notifications.scaleChanged',params:{percent:105},message:''});
  expect(useAppStore.getState().toasts).toHaveLength(1);
  useAppStore.setState({bootstrap:{...bootstrap,settings:{...bootstrap.settings,notifications:{...bootstrap.settings.notifications,briefEnabled:false}}},toasts:[]});
  store.pushToast({brief:true,tone:'info',title:'notifications.scaleChanged',message:''});
  store.pushToast({tone:'info',title:'common.loading',message:''});
  vi.advanceTimersByTime(2000);
  expect(useAppStore.getState().toasts).toHaveLength(1);
  vi.advanceTimersByTime(3000);
  expect(useAppStore.getState().toasts).toHaveLength(0);
});
