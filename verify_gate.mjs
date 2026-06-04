// Replicate the browser's runtime tile gate EXACTLY and confirm every tile it
// would request exists on disk (i.e. no 404s possible).
import fs from 'fs';
import path from 'path';

const GPX = 'C:/Users/julia/Documents/SHR_Site/SHR26.gpx';
const TILES = 'C:/Users/julia/Documents/SHR_Site/tiles';
const GATE_MI = 3.2;                       // must match index.html TILE_CORRIDOR_MI
const TOPO_ZOOMS = [6,7,8,9,10,11,12,13,14,15];
const DEM_ZOOMS  = [6,7,8,9,10,11,12,13,14];

const haversineMi = (a,b) => { const R=3958.8,tr=d=>d*Math.PI/180;
  const dLat=tr(b[1]-a[1]),dLng=tr(b[0]-a[0]);
  const h=Math.sin(dLat/2)**2+Math.cos(tr(a[1]))*Math.cos(tr(b[1]))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.min(1,Math.sqrt(h))); };

// ---- parse like parseGPX: dedup identical tracks, exclude access ----
const xml = fs.readFileSync(GPX,'utf8');
const trks = [...xml.matchAll(/<trk\b[\s\S]*?<\/trk>/g)].map(m=>m[0]);
const seen = new Set(); const segs = [];
for (const t of trks) {
  const name = (t.match(/<name>([\s\S]*?)<\/name>/)||[,''])[1].replace(/<!\[CDATA\[|\]\]>/g,'');
  if (/access/i.test(name)) continue;
  const c = [...t.matchAll(/<trkpt lat="([-\d.]+)" lon="([-\d.]+)"/g)].map(m=>[+m[2],+m[1]]);
  if (c.length < 2) continue;
  const f=c[0], l=c[c.length-1];
  const sig = `${c.length}|${f[0].toFixed(4)},${f[1].toFixed(4)}|${l[0].toFixed(4)},${l[1].toFixed(4)}`;
  if (seen.has(sig)) continue; seen.add(sig);
  segs.push(c);
}
// renderParsed sorts segments N→S by start lat, then decimates globally at 0.25 mi
segs.sort((a,b)=> b[0][1]-a[0][1]);
const routePts = []; let lastP=null;
for (const c of segs) for (const p of c) { if (!lastP || haversineMi(lastP,p)>0.25){ routePts.push(p); lastP=p; } }
console.log('decimated routePts:', routePts.length);

const tile2lon=(x,z)=>x/Math.pow(2,z)*360-180;
const tile2lat=(y,z)=>{const n=Math.PI-2*Math.PI*y/Math.pow(2,z);return 180/Math.PI*Math.atan(0.5*(Math.exp(n)-Math.exp(-n)));};
const lon2tile=(lon,z)=>Math.floor((lon+180)/360*Math.pow(2,z));
const lat2tile=(lat,z)=>Math.floor((1-Math.log(Math.tan(lat*Math.PI/180)+1/Math.cos(lat*Math.PI/180))/Math.PI)/2*Math.pow(2,z));

function gateAllowed(z,x,y){
  const w=tile2lon(x,z),e=tile2lon(x+1,z),n=tile2lat(y,z),s=tile2lat(y+1,z);
  for (const p of routePts){ if (p[1]<s-0.25||p[1]>n+0.25) continue;
    const clng=Math.max(w,Math.min(p[0],e)), clat=Math.max(s,Math.min(p[1],n));
    if (haversineMi([clng,clat],p)<=GATE_MI) return true; }
  return false;
}
let bMinLng=180,bMaxLng=-180,bMinLat=90,bMaxLat=-90;
for (const [lng,lat] of routePts){bMinLng=Math.min(bMinLng,lng);bMaxLng=Math.max(bMaxLng,lng);bMinLat=Math.min(bMinLat,lat);bMaxLat=Math.max(bMaxLat,lat);}

let allowed=0, missing=0; const miss=[];
for (const [set,zooms,ext] of [['topo',TOPO_ZOOMS,'jpg'],['dem',DEM_ZOOMS,'png']]) {
  for (const z of zooms) {
    const pad=0.25;
    for (let x=lon2tile(bMinLng-pad,z); x<=lon2tile(bMaxLng+pad,z); x++)
      for (let y=lat2tile(bMaxLat+pad,z); y<=lat2tile(bMinLat-pad,z); y++) {
        if (!gateAllowed(z,x,y)) continue;
        allowed++;
        if (!fs.existsSync(path.join(TILES,set,String(z),String(x),`${y}.${ext}`))) { missing++; if(miss.length<10) miss.push(`${set}/${z}/${x}/${y}.${ext}`); }
      }
  }
}
console.log(`gate-allowed tiles: ${allowed}`);
console.log(`MISSING on disk (would 404): ${missing}`);
if (missing) console.log('examples:', miss);
else console.log('✓ every gate-requested tile is present — no 404s possible');
