// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installMacContextMenus } from "./macContextMenu";
let cleanup = () => {};
afterEach(() => { cleanup(); vi.useRealTimers(); document.body.innerHTML = ""; });
function setup(platform = "MacIntel") {
  vi.useFakeTimers();
  document.body.innerHTML = '<aside data-slh-context-menu="true"><span>Blank</span><button>Action</button></aside>';
  cleanup = installMacContextMenus(document, platform);
  const element = document.querySelector('aside')!;
  const opened = vi.fn(); element.addEventListener('contextmenu', opened);
  return { element, opened, blank: element.querySelector('span')!, button: element.querySelector('button')! };
}
function pointer(element: Element, type = 'pointerdown', init: MouseEventInit = {}) {
  element.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: 20, clientY: 30, ...init }));
}
describe('macOS context gestures', () => {
  it('opens at the held position and consumes the following click', () => {
    const { blank, opened } = setup(); const click = vi.fn(); blank.addEventListener('click', click);
    pointer(blank); vi.advanceTimersByTime(549); expect(opened).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(opened).toHaveBeenCalledOnce();
    expect(opened.mock.calls[0][0]).toMatchObject({ clientX: 20, clientY: 30 });
    blank.dispatchEvent(new MouseEvent('click', { bubbles: true })); expect(click).not.toHaveBeenCalled();
  });
  it.each(['pointerup', 'pointercancel'])('cancels when %s arrives', type => {
    const { blank, opened } = setup(); pointer(blank); pointer(blank, type); vi.advanceTimersByTime(600); expect(opened).not.toHaveBeenCalled();
  });
  it('cancels when dragging or scrolling and ignores controls', () => {
    const { blank, button, opened } = setup(); pointer(blank); pointer(blank, 'pointermove', { clientX: 40 });
    vi.advanceTimersByTime(600); expect(opened).not.toHaveBeenCalled();
    pointer(blank); document.dispatchEvent(new Event('scroll')); vi.advanceTimersByTime(600); expect(opened).not.toHaveBeenCalled();
    pointer(button); vi.advanceTimersByTime(600); expect(opened).not.toHaveBeenCalled();
  });
  it('supports Control-click without waiting', () => {
    const { blank, opened } = setup(); pointer(blank, 'pointerdown', { ctrlKey: true }); expect(opened).toHaveBeenCalledOnce();
  });
  it('keeps Windows behavior unchanged', () => {
    const { blank, opened } = setup('Win32'); pointer(blank); vi.advanceTimersByTime(600); pointer(blank, 'pointerdown', { ctrlKey: true }); expect(opened).not.toHaveBeenCalled();
  });
});
