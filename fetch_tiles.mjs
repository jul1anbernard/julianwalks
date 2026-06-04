// Download USGS topo + AWS terrarium DEM tiles for the route corridor only.
import fs from 'fs';
import path from 'path';

const GPX = 'C:/Users/julia/Documents/SHR_Site/SHR26.gpx';
const OUT = 'C:/Users/julia/Documents/SHR_Site/tiles';
const CORRIDOR_MI = 3.5;         // == site's outer fade ring; nothing past the visible corridor
const TOPO_URL = (z,x,y) => `https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/${z}/${y}/${x}`;
const DEM_URL  = (z,x,y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const TOPO_ZOOMS = [6,7,8,9,10,11,12,13,14,15];   // sharper imagery
const DEM_ZOOMS  = [6,7,8,9,10,11,12,13,14];       // z14 = native ~10 m detail (z15 is just upsampled)
const CONCURRENCY = 16;
const COUNT_ONLY = process.argv.includes('--count');
const PRUNE = process.argv.includes('--prune');

// ---- parse main-route track coords (exclude "access") ----
const xml = fs.readFileSync(GPX, 'utf8');
const trks = [...xml.matchAll(/<trk\b[\s\S]*?<\/trk>/g)].map(m => m[0]);
let pts = [];
for (const t of trks) {
  const name = (t.match(/<name>([\s\S]*?)<\/name>/) || [,''])[1];
  if (/access/i.test(name)) continue;
  for (const m of t.matchAll(/<trkpt lat="([-\d.]+)" lon="([-\d.]+)"/g)) pts.push([+m[2], +m[1]]); // [lng,lat]
}
// decimate to ~ every ~0.3 mi to speed up distance checks
const decim = [];
let last = null;
const haversineMi = (a,b) => {
  const R=3958.8, tr=d=>d*Math.PI/180;
  const dLat=tr(b[1]-a[1]), dLng=tr(b[0]-a[0]);
  const h=Math.sin(dLat/2)**2+Math.cos(tr(a[1]))*Math.cos(tr(b[1]))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));
};
for (const p of pts) { if (!last || haversineMi(last,p) > 0.25) { decim.push(p); last = p; } }
console.log(`main-route points: ${pts.length} → decimated ${decim.length}`);

// bbox
let minLng=180,maxLng=-180,minLat=90,maxLat=-90;
for (const [lng,lat] of decim){ minLng=Math.min(minLng,lng);maxLng=Math.max(maxLng,lng);minLat=Math.min(minLat,lat);maxLat=Math.max(maxLat,lat); }

const lon2tile=(lon,z)=>Math.floor((lon+180)/360*Math.pow(2,z));
const lat2tile=(lat,z)=>Math.floor((1-Math.log(Math.tan(lat*Math.PI/180)+1/Math.cos(lat*Math.PI/180))/Math.PI)/2*Math.pow(2,z));
const tile2lon=(x,z)=>x/Math.pow(2,z)*360-180;
const tile2lat=(y,z)=>{const n=Math.PI-2*Math.PI*y/Math.pow(2,z);return 180/Math.PI*Math.atan(0.5*(Math.exp(n)-Math.exp(-n)));};

// A tile is needed if its bbox comes within CORRIDOR_MI of the route.
// (Identical predicate to the site's runtime gate → no missing tiles / 404s.)
function tileNeeded(z,x,y) {
  const w=tile2lon(x,z), e=tile2lon(x+1,z), n=tile2lat(y,z), s=tile2lat(y+1,z);
  for (const p of decim) {
    if (p[1] < s-0.25 || p[1] > n+0.25) continue;
    const clng=Math.max(w,Math.min(p[0],e)), clat=Math.max(s,Math.min(p[1],n));
    if (haversineMi([clng,clat], p) <= CORRIDOR_MI) return true;
  }
  return false;
}
function corridorTiles(z) {
  const pad = 0.2; // deg bbox margin (generous so edge tiles aren't missed)
  const x0=lon2tile(minLng-pad,z), x1=lon2tile(maxLng+pad,z);
  const y0=lat2tile(maxLat+pad,z), y1=lat2tile(minLat-pad,z);
  const out=[];
  for (let x=x0;x<=x1;x++) for (let y=y0;y<=y1;y++) if (tileNeeded(z,x,y)) out.push([x,y]);
  return out;
}

// prune: delete any on-disk tile no longer within CORRIDOR_MI of the route
if (PRUNE) {
  let kept=0, removed=0;
  for (const set of ['topo','dem']) {
    const base = path.join(OUT, set);
    if (!fs.existsSync(base)) continue;
    for (const z of fs.readdirSync(base)) {
      const zd = path.join(base, z);
      for (const x of fs.readdirSync(zd)) {
        const xd = path.join(zd, x);
        for (const f of fs.readdirSync(xd)) {
          if (tileNeeded(+z, +x, parseInt(f))) kept++;
          else { fs.unlinkSync(path.join(xd, f)); removed++; }
        }
        if (fs.readdirSync(xd).length === 0) fs.rmdirSync(xd);
      }
      if (fs.readdirSync(zd).length === 0) fs.rmdirSync(zd);
    }
  }
  console.log(`PRUNE (corridor ${CORRIDOR_MI} mi): kept ${kept}, removed ${removed}`);
  process.exit(0);
}

// plan
const plan = []; // {set, z, x, y, url}
for (const z of TOPO_ZOOMS) for (const [x,y] of corridorTiles(z)) plan.push({set:'topo',z,x,y,url:TOPO_URL(z,x,y)});
for (const z of DEM_ZOOMS)  for (const [x,y] of corridorTiles(z)) plan.push({set:'dem', z,x,y,url:DEM_URL(z,x,y)});

const byZoom = {};
for (const t of plan){ const k=`${t.set} z${t.z}`; byZoom[k]=(byZoom[k]||0)+1; }
console.log('tiles per set/zoom:'); for (const k of Object.keys(byZoom).sort()) console.log('  '+k+': '+byZoom[k]);
console.log(`TOTAL tiles: ${plan.length}`);
if (COUNT_ONLY) process.exit(0);

// ---- download ----
let done=0, ok=0, fail=0, bytes=0;
async function fetchTile(t){
  const dir = path.join(OUT, t.set, String(t.z), String(t.x));
  const ext = t.set === 'topo' ? '.jpg' : '.png';   // USGS topo is JPEG; DEM must stay PNG
  const file = path.join(dir, `${t.y}${ext}`);
  if (fs.existsSync(file)) { done++; ok++; return; }
  for (let attempt=0; attempt<3; attempt++){
    try {
      const r = await fetch(t.url);
      if (!r.ok) throw new Error('HTTP '+r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(file, buf);
      bytes+=buf.length; ok++; done++; return;
    } catch(e){ if (attempt===2){ fail++; done++; console.error('FAIL',t.url,e.message); } }
  }
}
async function run(){
  const q=[...plan];
  const workers = Array.from({length:CONCURRENCY}, async ()=>{
    while(q.length){ const t=q.pop(); await fetchTile(t);
      if (done % 200 === 0) console.log(`  ${done}/${plan.length}  (${(bytes/1e6).toFixed(1)} MB)`); }
  });
  await Promise.all(workers);
  console.log(`DONE: ${ok} ok, ${fail} failed, ${(bytes/1e6).toFixed(1)} MB`);
}
run();
