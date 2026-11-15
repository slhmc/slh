import { useEffect, useState } from "react";
import { useAppStore } from "../stores/appStore";
import { command } from "./tauri";
export function useInterfaceRegions() {
 const refresh=useAppStore(s=>s.refresh);
 const [dock,setDock]=useState<string|null>(null);
 useEffect(()=>{
  let drag:{el:HTMLElement;key:string;x:number;y:number;active:boolean;side:string}|null=null;
  let saving=Promise.resolve();let suppressClick=false;
  const side=(x:number,y:number,horizontal:boolean)=>{
   if(horizontal)return x<window.innerWidth/2?"left":"right";
   return [[x,"left"],[window.innerWidth-x,"right"],[y,"top"],[window.innerHeight-y,"bottom"]].sort((a,b)=>Number(a[0])-Number(b[0]))[0][1] as string;
  };
  const down=(e:PointerEvent)=>{
   if(!e.ctrlKey||e.button!==0||!useAppStore.getState().bootstrap?.settings.general.ctrlPanelDrag)return;
   const el=(e.target as Element).closest<HTMLElement>("[data-slh-dock]");if(!el)return;
   e.preventDefault();e.stopPropagation();el.setPointerCapture(e.pointerId);
   drag={el,key:el.dataset.slhDock!,x:e.clientX,y:e.clientY,active:false,side:"left"};
  };
  const move=(e:PointerEvent)=>{if(!drag)return;if(Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<8&&!drag.active)return;drag.active=true;e.preventDefault();drag.side=side(e.clientX,e.clientY,drag.key!=="navigationPosition"&&drag.key!=="instanceTabsPosition");setDock(drag.side);};
  const end=()=>{const d=drag;drag=null;setDock(null);if(!d?.active)return;suppressClick=true;window.setTimeout(()=>{suppressClick=false;},0);saving=saving.then(async()=>{const general=useAppStore.getState().bootstrap?.settings.general;if(!general)return;await command("update_setting",{key:"general",value:{...general,[d.key]:d.side}});await refresh();}).catch(()=>undefined);};
  const cancel=()=>{drag=null;setDock(null);};
  const click=(e:MouseEvent)=>{if(!suppressClick)return;suppressClick=false;e.preventDefault();e.stopPropagation();};
  document.addEventListener("pointerdown",down,true);document.addEventListener("pointermove",move,{passive:false});document.addEventListener("pointerup",end);document.addEventListener("pointercancel",cancel);window.addEventListener("blur",cancel);document.addEventListener("click",click,true);
  return()=>{document.removeEventListener("pointerdown",down,true);document.removeEventListener("pointermove",move);document.removeEventListener("pointerup",end);document.removeEventListener("pointercancel",cancel);window.removeEventListener("blur",cancel);document.removeEventListener("click",click,true);};
 },[refresh]);
 return dock;
}
