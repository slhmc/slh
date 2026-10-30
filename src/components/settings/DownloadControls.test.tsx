// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { ParallelDownloadsControl, DownloadHistory } from "./DownloadControls";
const mock=vi.hoisted(()=>({command:vi.fn()}));
vi.mock("../../lib/tauri",()=>({command:mock.command}));
vi.mock("../../i18n/UiText",()=>({useUiText:()=> (key:string)=>key}));
beforeEach(()=>mock.command.mockReset());afterEach(cleanup);
it("commits bounded parallelism only after input is complete",async()=>{
 const save=vi.fn().mockResolvedValue(undefined);render(<ParallelDownloadsControl value={16} onChange={save}/>);
 const input=screen.getByRole("spinbutton");fireEvent.change(input,{target:{value:"3"}});expect(save).not.toHaveBeenCalled();fireEvent.blur(input);
 await waitFor(()=>expect(save).toHaveBeenCalledWith(3));
 await waitFor(()=>expect(input.hasAttribute("disabled")).toBe(false));fireEvent.change(input,{target:{value:"99"}});fireEvent.blur(input);await waitFor(()=>expect(save).toHaveBeenCalledWith(32));
});
it("does not reset saved parallelism when an empty draft loses focus",()=>{
 const save=vi.fn();render(<ParallelDownloadsControl value={16} onChange={save}/>);const input=screen.getByRole("spinbutton");fireEvent.change(input,{target:{value:""}});fireEvent.blur(input);expect(save).not.toHaveBeenCalled();expect((input as HTMLInputElement).value).toBe("16");
});
it("loads history on the first expansion and keeps it collapsed initially",async()=>{
 mock.command.mockResolvedValue([]);const {container}=render(<DownloadHistory/>);expect(mock.command).not.toHaveBeenCalled();const details=container.querySelector("details")!;expect(details.open).toBe(false);details.open=true;fireEvent(details,new Event("toggle"));await waitFor(()=>expect(mock.command).toHaveBeenCalledTimes(1));details.open=false;fireEvent(details,new Event("toggle"));details.open=true;fireEvent(details,new Event("toggle"));await waitFor(()=>expect(mock.command).toHaveBeenCalledTimes(1));
});
