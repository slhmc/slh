export interface ArtworkTransform {width:number;height:number;x:number;y:number;rotation:number}
export interface Artwork { v: 1; icon: string; image?: string; imageName?: string; fit: "cover" | "contain" | "fill"; blur: boolean; gradient: boolean; second: string; width?: number; height?: number; rotation?:number; geometryVersion?:2; separate?:boolean; square?:ArtworkTransform; angle: number; zoom: number; x: number; y: number }
export const artworkPrefix = "slh-artwork:v1:";
export function readArtwork(key: string): Artwork {
 const fallback:Artwork={v:1,icon:key,fit:"contain",blur:false,gradient:false,second:"#20242a",geometryVersion:2,separate:false,width:80,height:80,rotation:0,angle:135,zoom:1,x:50,y:50};
 if(!key.startsWith(artworkPrefix))return {...fallback,square:{width:80,height:80,x:50,y:50,rotation:0}};
 try {const parsed=JSON.parse(key.slice(artworkPrefix.length));const art={...fallback,...parsed};if(parsed.geometryVersion!==2){art.width=(parsed.width??50)*1.6;art.height=parsed.height??80;}art.square??={width:art.width,height:art.height,x:art.x,y:art.y,rotation:art.rotation??0};return art;}catch{return {...fallback,icon:"cube"};}
}
export function artworkTransform(art:Artwork,square=false):ArtworkTransform {return square&&art.separate!==false&&art.square?art.square:{width:art.width??80,height:art.height??80,x:art.x,y:art.y,rotation:art.rotation??0};}
export function writeArtwork(value: Artwork) {return artworkPrefix + JSON.stringify(value);}
