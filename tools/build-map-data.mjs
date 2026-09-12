// 競馬場マップの下絵（map-data.js）を作り直すスクリプト。
// 使い方:  node tools/build-map-data.mjs
// Natural Earth（world-atlas）を取得し、Webメルカトルに投影して
// Douglas-Peucker で間引き、プロジェクト直下の map-data.js を上書きします。
// 競馬場を追加したら tools/venues.json に「名前:[緯度, 経度]」を足してから実行します。
import { readFileSync, writeFileSync } from 'fs';
function decode(topo){const {scale:[sx,sy],translate:[tx,ty]}=topo.transform;
  return topo.arcs.map(a=>{let x=0,y=0;return a.map(([dx,dy])=>{x+=dx;y+=dy;return [x*sx+tx,y*sy+ty];});});}
function ringOf(arcs,idx){const out=[];for(const i of idx){const a=i<0?arcs[~i].slice().reverse():arcs[i];
  for(let k=(out.length?1:0);k<a.length;k++) out.push(a[k]);}return out;}
function polysOf(g,arcs){return g.type==='Polygon'?[g.arcs.map(r=>ringOf(arcs,r))]
  :g.type==='MultiPolygon'?g.arcs.map(p=>p.map(r=>ringOf(arcs,r))):[];}
const merc=([lon,lat])=>{const la=Math.max(-85,Math.min(85,lat))*Math.PI/180;
  return [(lon+180)/360,(1-Math.log(Math.tan(la)+1/Math.cos(la))/Math.PI)/2];};
// Douglas-Peucker（開いた折れ線用）
function dpLine(pts,tol){
  if(pts.length<3) return pts;
  const keep=new Uint8Array(pts.length); keep[0]=keep[pts.length-1]=1;
  const st=[[0,pts.length-1]];
  while(st.length){ const [a,b]=st.pop(); if(b-a<2) continue;
    const [x1,y1]=pts[a],[x2,y2]=pts[b]; const dx=x2-x1,dy=y2-y1; const L=Math.hypot(dx,dy);
    let bi=-1,bd=tol;
    for(let i=a+1;i<b;i++){
      const d = L<1e-9 ? Math.hypot(pts[i][0]-x1,pts[i][1]-y1)
                       : Math.abs(dy*pts[i][0]-dx*pts[i][1]+x2*y1-y2*x1)/L;
      if(d>bd){bd=d;bi=i;} }
    if(bi>=0){ keep[bi]=1; st.push([a,bi],[bi,b]); } }
  return pts.filter((_,i)=>keep[i]);
}
// 閉じた輪は始点=終点で線分が潰れるので、最も遠い点で2本に割ってから間引く
function dpRing(pts,tol){
  if(pts.length<6) return pts;
  let far=1,fd=-1;
  for(let i=1;i<pts.length-1;i++){
    const d=Math.hypot(pts[i][0]-pts[0][0],pts[i][1]-pts[0][1]); if(d>fd){fd=d;far=i;} }
  return dpLine(pts.slice(0,far+1),tol).concat(dpLine(pts.slice(far),tol).slice(1));
}
function build(topo,bbox,W,minArea,dec,tol){
  const arcs=decode(topo); const [l0,b0,l1,b1]=bbox;
  const p0=merc([l0,b1]),p1=merc([l1,b0]); const k=W/(p1[0]-p0[0]); const H=(p1[1]-p0[1])*k;
  const pr=ll=>{const m=merc(ll);return [(m[0]-p0[0])*k,(m[1]-p0[1])*k];};
  const cl=(v,lo,hi)=>v<lo?lo:v>hi?hi:v;
  const r=v=>+v.toFixed(dec);
  const parts=[];
  for(const g of topo.objects.countries.geometries)
    for(const poly of polysOf(g,arcs))
      for(const ring of poly){
        // 表示範囲の外は縁に貼り付ける。連続した点が重なって消えるので、そのまま圧縮になる
        let inside=false, pts=[];
        for(const ll of ring){
          if(ll[0]>=l0&&ll[0]<=l1&&ll[1]>=b0&&ll[1]<=b1) inside=true;
          pts.push(pr([cl(ll[0],l0-4,l1+4),cl(ll[1],b0-4,b1+4)]));
        }
        if(!inside||pts.length<4) continue;
        let A=0; for(let i=0,j=pts.length-1;i<pts.length;j=i++) A+=(pts[j][0]+pts[i][0])*(pts[j][1]-pts[i][1]);
        if(Math.abs(A/2)<minArea) continue;
        const s=[]; let prev=null;
        for(const p of dpRing(pts,tol)){ const q=[r(p[0]),r(p[1])];
          if(prev&&q[0]===prev[0]&&q[1]===prev[1]) continue; s.push(q); prev=q; }
        if(s.length<3) continue;
        parts.push('M'+s.map(p=>p.join(' ')).join('L')+'Z');
      }
  return {d:parts.join(''),w:Math.round(W),h:Math.round(H),bbox};
}
const ATLAS='https://cdn.jsdelivr.net/npm/world-atlas@2/';
const get=async f=>{ const r=await fetch(ATLAS+f); if(!r.ok) throw new Error(f+' '+r.status); return r.json(); };
const [t110,t50]=await Promise.all([get('countries-110m.json'),get('countries-50m.json')]);
const VIEWS={
  world:[t110,[-170,-56,192,76],1200,4,0,1.5],
  jp:   [t50, [128.5,30.5,146,46], 760,0.8,1,1.0],
  us:   [t50, [-126,24,-66,50],  860,1.2,1,1.3],
  eu:   [t50, [-11,43,14.5,57.5], 820,0.6,1,1.0],
};
const out={};
for(const [k,[t,bb,W,ma,dc,tol]] of Object.entries(VIEWS)){
  out[k]=build(t,bb,W,ma,dc,tol);
  console.log(k.padEnd(6),(out[k].w+'x'+out[k].h).padEnd(10),(out[k].d.length/1024).toFixed(1)+'KB');
}


// ---- map-data.js を書き出す ----
const here=new URL('.',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1');
const venues=JSON.parse(readFileSync(here+'venues.json','utf8'));
const banner=`/* 自動生成ファイル — 直接編集しないこと。
   生成元: Natural Earth（world-atlas 110m / 50m）を Web メルカトルに投影し、
   Douglas-Peucker で間引いたもの。再生成の手順は DEPLOY.md を参照。
   views[].bbox = [西経度, 南緯度, 東経度, 北緯度] / w,h = SVG の座標系 */
window.WP_MAPS = `;
writeFileSync('map-data.js', banner+JSON.stringify({views:out,venues})+';\n');
console.log('map-data.js', (readFileSync('map-data.js').length/1024).toFixed(1)+'KB');
