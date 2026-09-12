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

// 日付変更線をまたぐ図形は、経度が +180 と -180 を行き来して地図を横断してしまう。
// 隣り合う点の差が180度を超えたら360度ずらして、1本の連続した輪に直す。
function unwrap(ring){
  const out=[ring[0].slice()]; let off=0;
  for(let i=1;i<ring.length;i++){
    const d=ring[i][0]-ring[i-1][0];
    if(d>180) off-=360; else if(d<-180) off+=360;
    out.push([ring[i][0]+off, ring[i][1]]);
  }
  return out;
}
// 表示範囲に一番かぶる位置へ寄せる（アラスカのように東西どちらにも置ける図形がある）
function bestShift(ring,l0,l1){
  let best=ring, score=-1;
  for(const s of [-360,0,360]){
    const n=ring.filter(p=>p[0]+s>=l0&&p[0]+s<=l1).length;
    if(n>score){ score=n; best=s?ring.map(p=>[p[0]+s,p[1]]):ring; }
  }
  return best;
}
// Sutherland-Hodgman。範囲外を縁に潰すのではなく、きちんと切り落とす
function clipPoly(pts,[x0,y0,x1,y1]){
  const ins=(p,e)=>e===0?p[0]>=x0:e===1?p[1]>=y0:e===2?p[0]<=x1:p[1]<=y1;
  const cut=(a,b,e)=>{
    const t=e===0?(x0-a[0])/(b[0]-a[0]):e===1?(y0-a[1])/(b[1]-a[1])
           :e===2?(x1-a[0])/(b[0]-a[0]):(y1-a[1])/(b[1]-a[1]);
    return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t];
  };
  let out=pts;
  for(let e=0;e<4&&out.length;e++){
    const src=out; out=[];
    for(let i=0;i<src.length;i++){
      const cur=src[i], prev=src[(i+src.length-1)%src.length];
      const ci=ins(cur,e), pi=ins(prev,e);
      if(ci){ if(!pi) out.push(cut(prev,cur,e)); out.push(cur); }
      else if(pi) out.push(cut(prev,cur,e));
    }
  }
  return out;
}
// Douglas-Peucker（開いた折れ線用）
function dpLine(pts,tol){
  if(pts.length<3) return pts;
  const keep=new Uint8Array(pts.length); keep[0]=keep[pts.length-1]=1;
  const st=[[0,pts.length-1]];
  while(st.length){ const [a,b]=st.pop(); if(b-a<2) continue;
    const [x1,y1]=pts[a],[x2,y2]=pts[b]; const dx=x2-x1,dy=y2-y1; const L=Math.hypot(dx,dy);
    let bi=-1,bd=tol;
    for(let i=a+1;i<b;i++){
      const d=L<1e-9?Math.hypot(pts[i][0]-x1,pts[i][1]-y1)
                    :Math.abs(dy*pts[i][0]-dx*pts[i][1]+x2*y1-y2*x1)/L;
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
  const r=v=>+v.toFixed(dec);
  const M=2;                                  // 切り取りは少し外側。境界線を画面外に逃がす
  const rect=[l0-M,b0-M,l1+M,b1+M];
  const parts=[];
  for(const g of topo.objects.countries.geometries)
    for(const poly of polysOf(g,arcs))
      for(const ring of poly){
        if(ring.length<4) continue;
        const open=ring.slice(0,-1);          // 始点と終点が同じなので末尾を落とす
        const clipped=clipPoly(bestShift(unwrap(open),rect[0],rect[2]),rect);
        if(clipped.length<3) continue;
        const pts=clipped.map(pr);
        let A=0; for(let i=0,j=pts.length-1;i<pts.length;j=i++) A+=(pts[j][0]+pts[i][0])*(pts[j][1]-pts[i][1]);
        if(Math.abs(A/2)<minArea) continue;
        const s=[]; let prev=null;
        for(const p of dpRing(pts.concat([pts[0]]),tol)){ const q=[r(p[0]),r(p[1])];
          if(prev&&q[0]===prev[0]&&q[1]===prev[1]) continue; s.push(q); prev=q; }
        if(s.length<3) continue;
        parts.push('M'+s.map(p=>p.join(' ')).join('L')+'Z');
      }
  return {d:parts.join(''),w:Math.round(W),h:Math.round(H),bbox};
}

const ATLAS='https://cdn.jsdelivr.net/npm/world-atlas@2/';
const get=async f=>{ const r=await fetch(ATLAS+f); if(!r.ok) throw new Error(f+' '+r.status); return r.json(); };
const [t110,t50]=await Promise.all([get('countries-110m.json'),get('countries-50m.json')]);
// [データ, [西経度,南緯度,東経度,北緯度], 幅, 最小面積, 小数桁, 間引きの強さ]
const VIEWS={
  world:[t110,[-130,-46,162,62],1200,3,0,1.1],
  jp:   [t50, [128.5,30.5,146,46], 760,0.8,1,1.0],
  us:   [t50, [-126,24,-66,50],    860,1.2,1,1.3],
  eu:   [t50, [-11,43,14.5,57.5],  820,0.6,1,1.0],
};
const out={};
for(const [k,[t,bb,W,ma,dc,tol]] of Object.entries(VIEWS)){
  out[k]=build(t,bb,W,ma,dc,tol);
  console.log(k.padEnd(6),(out[k].w+'x'+out[k].h).padEnd(10),(out[k].d.length/1024).toFixed(1)+'KB');
}
const here=new URL('.',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1');
const venues=JSON.parse(readFileSync(here+'venues.json','utf8'));
const banner=`/* 自動生成ファイル — 直接編集しないこと。
   生成元: Natural Earth（world-atlas 110m / 50m）を Web メルカトルに投影し、
   Douglas-Peucker で間引いたもの。再生成の手順は DEPLOY.md を参照。
   views[].bbox = [西経度, 南緯度, 東経度, 北緯度] / w,h = SVG の座標系 */
window.WP_MAPS = `;
writeFileSync(here+'../map-data.js', banner+JSON.stringify({views:out,venues})+';\n');
console.log('map-data.js', (readFileSync(here+'../map-data.js').length/1024).toFixed(1)+'KB');
