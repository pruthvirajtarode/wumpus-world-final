
/* scripts/app.js - Full Wumpus World game (modular)
   Expects:
   - assets/spritesheet.png (frameWidth=64)
   - sounds/music.wav, sounds/footstep.wav, sounds/arrow.wav, sounds/roar.wav
*/
const GRID = 10, TILE = 72;
const canvas = document.getElementById('gameCanvas'), ctx = canvas.getContext('2d');
let fog=true, mode='manual', aiOn=false, audioEnabled=false, musicOn=true;
const statusEl = document.getElementById('status'), reasonLog = document.getElementById('reasonLog');
const arrowCountEl = document.getElementById('arrowCount'), goldStatusEl = document.getElementById('goldStatus'), aliveStatusEl = document.getElementById('aliveStatus');
const probPanel = document.getElementById('probPanel');

let audioCtx=null, buffers={}, ambientGain=null;
async function initAudio(){
  if(audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  ambientGain = audioCtx.createGain(); ambientGain.gain.value = 0.06; ambientGain.connect(audioCtx.destination);
  // load sounds
  const paths = {
    music: 'sounds/music.wav',
    foot: 'sounds/footstep.wav',
    arrow: 'sounds/arrow.wav',
    roar: 'sounds/roar.wav'
  };
  for(const k in paths){
    try{
      const resp = await fetch(paths[k]);
      const ab = await resp.arrayBuffer();
      buffers[k] = await audioCtx.decodeAudioData(ab);
    }catch(e){
      console.warn('Sound load failed for', paths[k], e);
    }
  }
  // play ambient loop if enabled
  if(audioEnabled && musicOn && buffers.music){
    const src = audioCtx.createBufferSource(); src.buffer = buffers.music; src.loop = true;
    src.connect(ambientGain); src.start();
    buffers._musicSrc = src;
  }
}
function toggleAudio(){
  if(!audioCtx) initAudio();
  audioEnabled = !audioEnabled;
  if(!audioEnabled && buffers._musicSrc){ buffers._musicSrc.stop(); delete buffers._musicSrc; }
  if(audioEnabled && musicOn && !buffers._musicSrc && buffers.music){
    const src = audioCtx.createBufferSource(); src.buffer=buffers.music; src.loop=true; src.connect(ambientGain); src.start(); buffers._musicSrc=src;
  }
  audioBtn.textContent = 'Audio: '+(audioEnabled?'On':'Off');
}
function toggleMusic(){
  musicOn = !musicOn; musicBtn.textContent='Music: '+(musicOn?'On':'Off');
  if(audioEnabled) toggleAudio(), toggleAudio(); // quick restart to reflect change
}
function playSound(name, vol=0.5){
  if(!audioEnabled || !audioCtx || !buffers[name]) return;
  const src = audioCtx.createBufferSource(); src.buffer = buffers[name];
  const g = audioCtx.createGain(); g.gain.value = vol;
  src.connect(g); g.connect(audioCtx.destination); src.start();
}

// World & Agent state
let world = { wumpus:null, wumpusAlive:true, pits:new Set(), gold:null };
let agent = { r:0, c:0, x:TILE*0.5, y:TILE*0.5, path:[], facing:[1,0], arrow:1, hasGold:false, alive:true, kb:{safe:new Set(), breeze:new Set(), stench:new Set()}, prob:[] };

// load sprite sheet
const sprite = new Image(); sprite.src = 'assets/spritesheet.png';
const FRAME_W = 64, FRAME_H = 64;

// utilities
const key = (r,c)=>`${r},${c}`;
const inBounds = (r,c)=> r>=0 && c>=0 && r<GRID && c<GRID;
const randInt = n => Math.floor(Math.random()*n);

function initProb(){ agent.prob = Array.from({length:GRID}, ()=>Array(GRID).fill(0.08)); agent.prob[0][0]=0; }

function newWorld(seed){
  world.pits.clear(); world.wumpus=null; world.gold=null; world.wumpusAlive=true;
  for(let r=0;r<GRID;r++) for(let c=0;c<GRID;c++){ if(r===0&&c===0) continue; if(Math.random()<0.10) world.pits.add(key(r,c)); }
  let wr,wc; do{ wr=randInt(GRID); wc=randInt(GRID); } while((wr===0&&wc===0) || world.pits.has(key(wr,wc)));
  world.wumpus = key(wr,wc);
  let gr,gc; do{ gr=randInt(GRID); gc=randInt(GRID); } while((gr===0&&gc===0) || world.pits.has(key(gr,gc)) || (gr===wr && gc===wc));
  world.gold = key(gr,gc);
  agent.r=0; agent.c=0; agent.x=TILE*0.5; agent.y=TILE*0.5; agent.path=[]; agent.arrow=1; agent.hasGold=false; agent.alive=true;
  agent.kb = { safe:new Set(), breeze:new Set(), stench:new Set() }; agent.kb.safe.add(key(0,0));
  initProb(); updateUI(); log('New world generated');
}

function perceive(r,c){
  let breeze=false, stench=false, glitter=false;
  const adj = [[1,0],[-1,0],[0,1],[0,-1]];
  for(const [dr,dc] of adj){
    const nr=r+dr, nc=c+dc;
    if(inBounds(nr,nc)){
      if(world.pits.has(key(nr,nc))) breeze=true;
      if(world.wumpus===key(nr,nc) && world.wumpusAlive) stench=true;
    }
  }
  if(world.gold===key(r,c)) glitter=true;
  return {breeze, stench, glitter};
}

function updateKB(r,c){
  const p = perceive(r,c);
  if(p.glitter){ agent.hasGold=true; world.gold=null; log('Picked up gold — returning to (0,0)'); agent.path = astarPath(r,c,0,0); document.getElementById('goldStatus').textContent='Yes'; playSound('foot', 0.5); }
  if(p.breeze){ agent.kb.breeze.add(key(r,c)); log('Perceived breeze at '+key(r,c)); } else { markAdjSafe(r,c); }
  if(p.stench){ agent.kb.stench.add(key(r,c)); log('Perceived stench at '+key(r,c)); } else { markAdjSafe(r,c); }
  updateProbabilities();
}

function markAdjSafe(r,c){
  const adj = [[1,0],[-1,0],[0,1],[0,-1]];
  for(const [dr,dc] of adj){
    const nr=r+dr, nc=c+dc;
    if(inBounds(nr,nc)) agent.kb.safe.add(key(nr,nc));
  }
}

// probabilistic update (simple)
function updateProbabilities(){
  for(let r=0;r<GRID;r++) for(let c=0;c<GRID;c++) agent.prob[r][c]=0.08;
  agent.prob[agent.r][agent.c]=0;
  agent.kb.breeze.forEach(k=>{
    const [r,c]=k.split(',').map(Number);
    for(const [dr,dc] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const nr=r+dr, nc=c+dc;
      if(inBounds(nr,nc) && !(nr===agent.r && nc===agent.c)) agent.prob[nr][nc]+=0.35;
    }
  });
  agent.kb.safe.forEach(k=>{
    const [r,c]=k.split(',').map(Number);
    if(!agent.kb.breeze.has(k)){
      for(const [dr,dc] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const nr=r+dr,nc=c+dc;
        if(inBounds(nr,nc)) agent.prob[nr][nc]*=0.2;
      }
    }
  });
  for(let r=0;r<GRID;r++) for(let c=0;c<GRID;c++) agent.prob[r][c] = Math.min(0.99, Math.max(0, agent.prob[r][c]));
  renderProbPanel();
}

function renderProbPanel(){
  probPanel.innerHTML='';
  for(let r=0;r<GRID;r++) for(let c=0;c<GRID;c++){
    const d=document.createElement('div'); d.className='prob-cell';
    d.textContent = (agent.prob[r][c]*100).toFixed(0)+'%'; d.title=`${r},${c}`; probPanel.appendChild(d);
  }
}

// agent AI
function agentThink(){
  if(!aiOn || !agent.alive) return;
  if(agent.hasGold){ if(!(agent.r===0 && agent.c===0)) agent.path = astarPath(agent.r,agent.c,0,0); return; }
  let candidates=[];
  agent.kb.safe.forEach(k=>{
    const [r,c]=k.split(',').map(Number);
    for(const [dr,dc] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const nr=r+dr,nc=c+dc;
      if(inBounds(nr,nc) && !agent.kb.safe.has(key(nr,nc))) candidates.push({r:nr,c:nc,prob:agent.prob[nr][nc]});
    }
  });
  if(candidates.length===0){
    for(let r=0;r<GRID;r++) for(let c=0;c<GRID;c++) if(!agent.kb.safe.has(key(r,c))) candidates.push({r,c,prob:agent.prob[r][c]});
  }
  candidates.sort((a,b)=>a.prob-b.prob);
  const pick = candidates[0];
  if(pick){
    const path = astarPath(agent.r,agent.c,pick.r,pick.c);
    if(path) agent.path = path; else log('No safe path to target');
  }
}

// rendering
function draw(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  for(let r=0;r<GRID;r++) for(let c=0;c<GRID;c++){
    const x=c*TILE, y=r*TILE;
    ctx.fillStyle='#0b0b0b'; ctx.fillRect(x,y,TILE,TILE);
    ctx.strokeStyle='rgba(255,255,255,0.02)'; ctx.strokeRect(x+0.5,y+0.5,TILE-1,TILE-1);
  }
  for(let r=0;r<GRID;r++) for(let c=0;c<GRID;c++){
    const x=c*TILE, y=r*TILE;
    const revealed = agent.kb.safe.has(key(r,c));
    if(fog && !revealed){ ctx.fillStyle='rgba(0,0,0,0.8)'; ctx.fillRect(x,y,TILE,TILE); }
  }
  for(const p of world.pits){
    const [r,c]=p.split(',').map(Number);
    const x=c*TILE, y=r*TILE;
    if(agent.kb.safe.has(key(r,c)) || !fog) drawPit(x+TILE/2,y+TILE/2, Math.min(24, TILE*0.22));
  }
  if(world.wumpus && world.wumpusAlive){
    const [wr,wc]=world.wumpus.split(',').map(Number);
    const x=wc*TILE, y=wr*TILE;
    if(agent.kb.safe.has(key(wr,wc)) || !fog) drawWumpus(x+TILE/2,y+TILE/2, TILE*0.32);
  }
  if(world.gold){
    const [gr,gc]=world.gold.split(',').map(Number);
    const x=gc*TILE, y=gr*TILE;
    if(agent.kb.safe.has(key(gr,gc)) || !fog) drawGold(x+TILE/2,y+TILE/2);
  }
  if(agent.path){ for(let i=0;i<agent.path.length;i++){ const p=agent.path[i]; ctx.fillStyle=(i===0?'rgba(255,255,255,0.06)':'rgba(255,255,255,0.03)'); ctx.fillRect(p.c*TILE+TILE*0.3,p.r*TILE+TILE*0.3,TILE*0.4,TILE*0.4); } }
  // draw agent sprite frame based on time/frame
  const frame = Math.floor((performance.now()/150)%4);
  const sx = frame * FRAME_W;
  const sy = 0;
  ctx.drawImage(sprite, sx, sy, FRAME_W, FRAME_H, agent.x - FRAME_W*0.4, agent.y - FRAME_H*0.5, FRAME_W*0.8, FRAME_H*0.8);
  // lighting
  const grad = ctx.createRadialGradient(agent.x,agent.y,20,agent.x,agent.y,200);
  grad.addColorStop(0,'rgba(255,230,200,0.0)'); grad.addColorStop(0.6,'rgba(0,0,0,0.1)'); grad.addColorStop(1,'rgba(0,0,0,0.8)');
  ctx.fillStyle = grad; ctx.fillRect(0,0,canvas.width,canvas.height);
}

function drawAgent(cx,cy){} // replaced by sprite draw
function drawPit(cx,cy,size){ ctx.save(); ctx.translate(cx,cy); ctx.fillStyle='#504444'; ctx.beginPath(); ctx.ellipse(0,0,size*1.2,size*0.6,0,0,Math.PI*2); ctx.fill(); ctx.fillStyle='#0a0a0a'; ctx.beginPath(); ctx.ellipse(0,0,size*0.8,size*0.45,0,0,Math.PI*2); ctx.fill(); ctx.restore(); }
function drawWumpus(cx,cy,size){ ctx.save(); ctx.translate(cx,cy); ctx.fillStyle='#ff7b7b'; ctx.beginPath(); ctx.arc(0,0,size*0.6,0,Math.PI*2); ctx.fill(); ctx.fillStyle='#3b1b1b'; ctx.fillRect(-size*0.2,-size*0.8,size*0.4,size*0.24); ctx.restore(); }
function drawGold(cx,cy){ ctx.save(); ctx.translate(cx,cy); ctx.fillStyle='#ffd700'; ctx.beginPath(); ctx.moveTo(0,-8); ctx.lineTo(6,0); ctx.lineTo(0,8); ctx.lineTo(-6,0); ctx.closePath(); ctx.fill(); ctx.restore(); }

// A* (complete)
class TinyHeap{constructor(cmp){this.data=[];this.cmp=cmp;}push(v){this.data.push(v);this._siftUp();}pop(){const d=this.data;if(d.length===0) return null;const res=d[0];const last=d.pop();if(d.length) d[0]=last; this._siftDown(); return res;}size(){return this.data.length;} _siftUp(){let i=this.data.length-1; while(i>0){const p=(i-1)>>1; if(this.cmp(this.data[i],this.data[p])<0){[this.data[i],this.data[p]]=[this.data[p],this.data[i]]; i=p;} else break;}} _siftDown(){let i=0; const n=this.data.length; while(true){const l=2*i+1, r=2*i+2; let s=i; if(l<n && this.cmp(this.data[l],this.data[s])<0) s=l; if(r<n && this.cmp(this.data[r],this.data[s])<0) s=r; if(s!==i){[this.data[i],this.data[s]]=[this.data[s],this.data[i]]; i=s;} else break;}}}
function heur(r,c,tr,tc){ return Math.abs(r-tr)+Math.abs(c-tc); }
function astarPath(sr,sc,tr,tc){
  const startKey = key(sr,sc); const open = new TinyHeap((a,b)=>a.f-b.f); const gScore = {}; gScore[startKey]=0; open.push({r:sr,c:sc,f:heur(sr,sc,tr,tc)}); const came={}; const allowed = new Set(agent.kb.safe); allowed.add(startKey);
  while(open.size()){
    const cur = open.pop(); const k = key(cur.r,cur.c);
    if(k===key(tr,tc)){ const path=[]; let kk=k; while(kk){ const [rr,cc] = kk.split(',').map(Number); path.unshift({r:rr,c:cc}); kk = came[kk]; } return path; }
    for(const [dr,dc] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const nr=cur.r+dr, nc=cur.c+dc; const nk=key(nr,nc);
      if(!inBounds(nr,nc)) continue; if(!allowed.has(nk)) continue; if(world.pits.has(nk) || (world.wumpus && world.wumpus===nk && world.wumpusAlive)) continue;
      const tentative = gScore[k]+1;
      if(gScore[nk]===undefined || tentative<gScore[nk]){ came[nk]=k; gScore[nk]=tentative; open.push({r:nr,c:nc,f:tentative+heur(nr,nc,tr,tc)}); }
    }
  }
  return null;
}

function astarAny(sr,sc,tr,tc){
  const open=new TinyHeap((a,b)=>a.f-b.f); const startKey=key(sr,sc); const gScore={}; gScore[startKey]=0; open.push({r:sr,c:sc,f:heur(sr,sc,tr,tc)}); const came={};
  while(open.size()){
    const cur=open.pop(); const k=key(cur.r,cur.c);
    if(cur.r===tr && cur.c===tc){ const path=[]; let kk=k; while(kk){ const [rr,cc]=kk.split(',').map(Number); path.unshift({r:rr,c:cc}); kk=came[kk]; } return path; }
    for(const [dr,dc] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const nr=cur.r+dr,nc=cur.c+dc; const nk=key(nr,nc); if(!inBounds(nr,nc)) continue; if(world.pits.has(nk) || (world.wumpus && world.wumpus===nk && world.wumpusAlive)) continue;
      const tentative=gScore[k]+1; if(gScore[nk]===undefined || tentative<gScore[nk]){ came[nk]=k; gScore[nk]=tentative; open.push({r:nr,c:nc,f=tentative+heur(nr,nc,tr,tc)}); }
    }
  }
  return null;
}

// loop & movement
let lastTime = performance.now();
function loop(ts){
  const dt = (ts - lastTime)/1000 || 0; lastTime = ts;
  if(agent.path && agent.path.length>0){
    const next = agent.path[0];
    const tx = next.c*TILE + TILE*0.5; const ty = next.r*TILE + TILE*0.5;
    const dx = tx - agent.x, dy = ty - agent.y; const dist = Math.hypot(dx,dy); const speed = 120;
    if(dist < 3){
      agent.x = tx; agent.y = ty; agent.r = next.r; agent.c = next.c; agent.path.shift();
      updateKB(agent.r, agent.c);
      checkHazards();
      playSound('foot', 0.3);
    } else {
      agent.x += (dx/dist)*speed*dt; agent.y += (dy/dist)*speed*dt;
    }
  }
  draw(); agentThink(); requestAnimationFrame(loop);
}

function checkHazards(){
  const k = key(agent.r, agent.c);
  if(world.pits.has(k)){ agent.alive=false; agent.path=[]; world.pits.delete(k); aliveStatusEl.textContent='No'; log('Fell into a pit — mission failed'); playSound('roar', 0.6); }
  if(world.wumpus===k && world.wumpusAlive){ agent.alive=false; agent.path=[]; aliveStatusEl.textContent='No'; log('Eaten by the Wumpus — mission failed'); playSound('roar', 0.9); }
  if(agent.hasGold && agent.r===0 && agent.c===0){ agent.path=[]; log('Returned with gold — mission success!'); statusEl.textContent='You win!'; playSound('music', 0.6); }
}

// wumpus roaming & roar
function roamWumpus(){
  if(!world.wumpus || !world.wumpusAlive) return;
  const [wr,wc] = world.wumpus.split(',').map(Number);
  const neigh = [[1,0],[-1,0],[0,1],[0,-1]]; const cand=[];
  for(const [dr,dc] of neigh){ const nr=wr+dr, nc=wc+dc; if(inBounds(nr,nc) && !world.pits.has(key(nr,nc))) cand.push([nr,nc]); }
  if(cand.length){ const pick = cand[Math.floor(Math.random()*cand.length)]; world.wumpus = key(pick[0], pick[1]); playSound('roar', 0.25); }
}

// input
canvas.addEventListener('click', e=>{
  const rect = canvas.getBoundingClientRect(); const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const tr = Math.floor(y / TILE), tc = Math.floor(x / TILE);
  if(!inBounds(tr,tc)) return;
  if(mode === 'manual'){ agent.path = astarAny(agent.r, agent.c, tr, tc); } else { const path = astarPath(agent.r, agent.c, tr, tc); if(path) agent.path = path; else log('No safe path'); }
});

window.addEventListener('keydown', e=>{
  const k = e.key.toLowerCase();
  if(['arrowup','w'].includes(k)) attemptMove(-1,0);
  if(['arrowdown','s'].includes(k)) attemptMove(1,0);
  if(['arrowleft','a'].includes(k)) attemptMove(0,-1);
  if(['arrowright','d'].includes(k)) attemptMove(0,1);
  if(k === ' ') shootArrow();
});
function attemptMove(dr,dc){ if(mode !== 'manual' || !agent.alive) return; const nr = agent.r + dr, nc = agent.c + dc; if(!inBounds(nr,nc)) return; agent.path = [{r:nr,c:nc}]; }

function shootArrow(){ if(agent.arrow<=0){ log('No arrows left'); return; } agent.arrow--; arrowCountEl.textContent=agent.arrow; playSound('arrow', 0.6);
  const [fr,fc] = agent.facing; let r=agent.r, c=agent.c;
  while(true){ r += fr; c += fc; if(!inBounds(r,c)) break; if(world.wumpus===key(r,c) && world.wumpusAlive){ world.wumpusAlive=false; playSound('roar', 0.9); log('Wumpus killed!'); break; } if(world.pits.has(key(r,c))) break; }
}

// UI & helpers
function updateUI(){ arrowCountEl.textContent=agent.arrow; goldStatusEl.textContent=agent.hasGold?'Yes':'No'; aliveStatusEl.textContent=agent.alive?'Yes':'No'; modeBtn.textContent='Mode: '+(mode==='manual'?'Manual':'Logical'); aiBtn.textContent='AI: '+(aiOn?'On':'Off'); fogBtn.textContent='Fog: '+(fog?'On':'Off'); audioBtn.textContent='Audio: '+(audioEnabled?'On':'Off'); }
function log(s){ const t = new Date().toLocaleTimeString(); reasonLog.innerHTML = `<div>[${t}] ${s}</div>` + reasonLog.innerHTML; }

// buttons
document.getElementById('newBtn').addEventListener('click', ()=>{ newWorld(); updateUI(); });
document.getElementById('modeBtn').addEventListener('click', ()=>{ mode = mode==='manual'?'logic':'manual'; updateUI(); statusEl.textContent='Mode switched'; });
document.getElementById('aiBtn').addEventListener('click', ()=>{ aiOn = !aiOn; aiBtn.textContent='AI: '+(aiOn?'On':'Off'); if(aiOn) log('AI engaged'); else log('AI disengaged'); });
document.getElementById('fogBtn').addEventListener('click', ()=>{ fog = !fog; updateUI(); statusEl.textContent='Fog toggled'; });
document.getElementById('audioBtn').addEventListener('click', ()=>{ if(!audioCtx) initAudio(); toggleAudio(); });
document.getElementById('musicBtn').addEventListener('click', ()=>{ toggleMusic(); });

// periodic
setInterval(roamWumpus, 4000);

// start
newWorld();
requestAnimationFrame(loop);

// resume audio on interaction
window.addEventListener('pointerdown', ()=>{ if(!audioCtx) initAudio(); if(audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); });

