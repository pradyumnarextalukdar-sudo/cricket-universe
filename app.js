import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js";

const $=id=>document.getElementById(id);
const qs=(s,r=document)=>r.querySelector(s);
const qsa=(s,r=document)=>[...r.querySelectorAll(s)];
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const uid=()=>crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2)+Date.now().toString(36);
const code=(prefix="M")=>prefix+"-"+Math.random().toString(36).slice(2,6).toUpperCase();
const esc=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
const SAVE="cu_v11_state", SESSION="cu_v11_session", CFG="cu_v11_cfg", ACTIVE_MATCH="cu_v12_active_match", AUDIO_PREF="cu_v13_audio";
const AUTO_BALL_GAP_MS=5000, ONLINE_MANAGER_TIMEOUT=60;
const nowISO=()=>new Date().toISOString();

let state=loadState(), session=loadJSON(SESSION,null), serverRole=null, currentPage="home", activeFixtureId=null, match=null, three=null, paused=false, ballLock=false, cloudPoll=null, decisionTimerHandle=null, autoLoopToken=0, restoredLiveMatch=false, lastAudioEventId=null, lastVisualEventId=null, lastAnimatedProgressKey=null, visualEventQueue=Promise.resolve(), audioCtx=null;
state.settings.timeout=ONLINE_MANAGER_TIMEOUT;

function loadJSON(k,d){try{return JSON.parse(localStorage.getItem(k)||"null")??d}catch{return d}}
function baseState(){return{profile:{name:"Guest",fullName:"",managerName:"",region:"",points:0},settings:{thrill:90,tie:5,timeout:60,managerControl:true},players:[],teams:[],competitions:[],history:[],playerStats:{},localRole:"host",localRoom:null}}
function loadState(){return Object.assign(baseState(),loadJSON(SAVE,{}))}
function save(){localStorage.setItem(SAVE,JSON.stringify(state));renderAll();queueProfileSync()}
function getCfg(){const s=loadJSON(CFG,{}),w=window.CRICKET_UNIVERSE_CONFIG||{};return{url:s.url||w.supabaseUrl||"",key:s.key||w.supabaseAnonKey||""}}
function cloudReady(){const c=getCfg();return /^https:\/\/.+\.supabase\.co$/.test(c.url)&&c.key.length>40}
function headers(token){const c=getCfg();return{"apikey":c.key,"Authorization":"Bearer "+(token||c.key),"Content-Type":"application/json"}}

function jwtExpiryMs(token){
  try{
    const part=token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/");
    const pad="=".repeat((4-part.length%4)%4);
    const payload=JSON.parse(decodeURIComponent(escape(atob(part+pad))));
    return Number(payload.exp||0)*1000;
  }catch{return 0}
}

async function refreshAuthSession(force=false){
  if(!session?.refresh_token||!cloudReady())return false;
  const exp=jwtExpiryMs(session.access_token||"");
  if(!force&&exp&&exp>Date.now()+120000)return true;

  const c=getCfg();
  const r=await fetch(c.url+"/auth/v1/token?grant_type=refresh_token",{
    method:"POST",
    headers:{
      "apikey":c.key,
      "Authorization":"Bearer "+c.key,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({refresh_token:session.refresh_token})
  });

  const txt=await r.text();
  let j;
  try{j=txt?JSON.parse(txt):null}catch{j=null}
  if(!r.ok||!j?.access_token){
    if(r.status===400||r.status===401){
      session=null;
      serverRole=null;
      localStorage.removeItem(SESSION);
      renderAll();
    }
    throw new Error(j?.message||j?.error_description||"Your cloud session could not be refreshed.");
  }

  session={
    access_token:j.access_token,
    refresh_token:j.refresh_token||session.refresh_token,
    user:j.user||session.user
  };
  localStorage.setItem(SESSION,JSON.stringify(session));
  return true;
}

async function api(path,opt={}){
  if(!cloudReady())throw new Error("Cloud is not configured.");
  const c=getCfg();
  const token=opt.token||session?.access_token;
  const requestOpt={...opt};
  delete requestOpt.token;
  delete requestOpt._retried;

  let r=await fetch(c.url+path,{
    ...requestOpt,
    headers:{...headers(token),...(opt.headers||{})}
  });

  if(r.status===401&&session?.refresh_token&&!opt._retried&&!path.includes("/auth/v1/token")){
    await refreshAuthSession(true);
    return api(path,{...opt,_retried:true,token:session?.access_token});
  }

  const txt=await r.text();
  let j;
  try{j=txt?JSON.parse(txt):null}catch{j=txt}
  if(!r.ok)throw new Error(j?.message||j?.msg||j?.error_description||"Cloud request failed");
  return j
}
let syncDebounce;
function queueProfileSync(){clearTimeout(syncDebounce);if(session&&cloudReady())syncDebounce=setTimeout(()=>pushProfile().catch(()=>{}),1000)}
async function pushProfile(){if(!session?.user?.id)return;await api("/rest/v1/profiles?on_conflict=user_id",{method:"POST",headers:{"Prefer":"resolution=merge-duplicates,return=minimal"},body:JSON.stringify({user_id:session.user.id,data:state,updated_at:nowISO()})});cloudUI(true)}
async function pullProfile(){if(!session?.user?.id)return;const rows=await api("/rest/v1/profiles?user_id=eq."+encodeURIComponent(session.user.id)+"&select=data");if(rows?.[0]?.data){state=Object.assign(baseState(),rows[0].data);if(cloudReady()&&serverRole!=="admin")state.localRole="spectator";localStorage.setItem(SAVE,JSON.stringify(state));renderAll()}else await pushProfile()}
async function refreshServerRole(){
  if(!session?.user?.id||!cloudReady()){serverRole=null;return}

  serverRole="checking";
  cloudUI();

  try{
    await refreshAuthSession(false);

    // First use the protected server-side admin function.
    let isAdmin=false;
    try{
      const rpc=await api("/rest/v1/rpc/is_game_admin",{
        method:"POST",
        body:"{}"
      });
      isAdmin=rpc===true;
    }catch{}

    // Also read the user's own role row. This preserves future role expansion.
    let roleRow=null;
    try{
      const rows=await api(
        "/rest/v1/user_roles?user_id=eq."
        +encodeURIComponent(session.user.id)
        +"&select=role"
      );
      roleRow=rows?.[0]?.role||null;
    }catch{}

    serverRole=isAdmin?"admin":(roleRow||"spectator");

    if(serverRole==="admin"){
      state.localRole="host";
      localStorage.setItem(SAVE,JSON.stringify(state));
      return;
    }

    state.localRole="spectator";
    localStorage.setItem(SAVE,JSON.stringify(state));
    await loadRoomFromCloudByManager().catch(()=>{});

  }catch(e){
    // Do not falsely label an account Spectator when authentication failed.
    serverRole="unavailable";
    state.localRole="spectator";
    localStorage.setItem(SAVE,JSON.stringify(state));
    console.warn("Role refresh failed:",e);
  }
}

function generateDemo(){
  const teams=[["Aurora XI","#1b8065"],["Nova XI","#1970cc"],["Titan XI","#b46826"],["Orion XI","#7649c5"],["Harbour XI","#23768a"],["Metro XI","#bd3e70"],["Falcon XI","#7c8b2a"],["Summit XI","#9c4a33"]];
  const first=["Arin","Milan","Kavin","Rohan","Dev","Aman","Neel","Karan","Ishaan","Rishi","Yash","Samar","Nikhil","Varun","Jay","Manav","Arnav","Vihaan","Reyansh","Kabir","Vikram","Aditya"];
  const last=["Stone","Vale","North","Hale","Frost","Blaze","Quinn","Knox","Flint","Pike","Ray","Cross","Dawn","Cole","Reed","Hart","Moor","Kent","Lake","Ward","Nash","Shaw"];
  state.players=[];state.teams=[];state.playerStats={};
  let n=0;
  teams.forEach((t,ti)=>{
    const ids=[];
    for(let i=0;i<15;i++){
      const name=first[(n*3)%first.length]+" "+last[(n*5+ti)%last.length], role=i<2?"Opening Batter":i<5?"Top-order Batter":i===5?"Wicketkeeper Batter":i<8?"All-rounder":i<11?"Fast Bowler":i<13?"Spinner":"Reserve";
      const bowl=role==="Fast Bowler"?82+(i%5):role==="Spinner"?80+(i%4):role==="All-rounder"?68+(i%7):35+(i%12);
      const bat=role.includes("Batter")?82+(i%7):role==="All-rounder"?73+(i%8):42+(i%18);
      const p={id:"p"+n,name,team:t[0],role,ovr:Math.round((bat+bowl+(70+i%15))/3),batting:bat,power:65+(n*7)%27,aggression:58+(n*5)%35,bowlingSkill:bowl,fielding:68+(n*3)%25,composure:65+(n*4)%30,hand:n%4===0?"LHB":"RHB",bowling:role==="Spinner"?(n%2?"Leg Spin":"Off Spin"):role==="Fast Bowler"?"Right Arm Fast":"Right Arm Medium"};state.players.push(p);ids.push(p.id);state.playerStats[p.id]={matches:0,runs:0,balls:0,wickets:0,conceded:0,fours:0,sixes:0,outs:0};n++
    }
    state.teams.push({id:"team"+ti,name:t[0],rating:87+(ti%4),accent:t[1],squad:ids,defaultXI:ids.slice(0,11)})
  })
}
if(!state.players.length||!state.teams.length)generateDemo();

const audioPref=Object.assign({sfx:true,voice:true},loadJSON(AUDIO_PREF,{}));
function saveAudioPref(){localStorage.setItem(AUDIO_PREF,JSON.stringify(audioPref));renderAudioButtons()}
function renderAudioButtons(){
  const s=$("gameSoundToggle"),v=$("voiceToggle");
  if(s)s.textContent=audioPref.sfx?"🔊 GAME SOUND ON":"🔇 GAME SOUND OFF";
  if(v)v.textContent=audioPref.voice?"🎙 COMMENTARY ON":"🎙 COMMENTARY OFF";
}
function ensureAudio(){
  try{
    if(!audioCtx)audioCtx=new (window.AudioContext||window.webkitAudioContext)();
    if(audioCtx.state==="suspended")audioCtx.resume();
  }catch{}
}
function tone(freq=220,dur=.08,type="sine",gain=.07,delay=0){
  if(!audioPref.sfx)return;
  ensureAudio();if(!audioCtx)return;
  const o=audioCtx.createOscillator(),g=audioCtx.createGain(),t=audioCtx.currentTime+delay;
  o.type=type;o.frequency.setValueAtTime(freq,t);
  g.gain.setValueAtTime(0.0001,t);g.gain.exponentialRampToValueAtTime(Math.max(.001,gain),t+.01);g.gain.exponentialRampToValueAtTime(.0001,t+dur);
  o.connect(g).connect(audioCtx.destination);o.start(t);o.stop(t+dur+.02)
}
function noise(dur=.12,gain=.04,delay=0,highpass=500){
  if(!audioPref.sfx)return;
  ensureAudio();if(!audioCtx)return;
  const sr=audioCtx.sampleRate,buf=audioCtx.createBuffer(1,Math.max(1,Math.floor(sr*dur)),sr),d=buf.getChannelData(0);
  for(let i=0;i<d.length;i++)d[i]=(Math.random()*2-1)*(1-i/d.length);
  const src=audioCtx.createBufferSource(),filter=audioCtx.createBiquadFilter(),g=audioCtx.createGain(),t=audioCtx.currentTime+delay;
  src.buffer=buf;filter.type="highpass";filter.frequency.value=highpass;g.gain.value=gain;
  src.connect(filter).connect(g).connect(audioCtx.destination);src.start(t)
}
function playCricketSfx(kind){
  if(!audioPref.sfx)return;
  ensureAudio();
  // bowling/run-up whoosh
  noise(.16,.035,0,350);tone(115,.10,"sine",.025,.02);
  if(kind==="six"){noise(.08,.15,.24,1200);tone(155,.10,"square",.09,.24);tone(310,.24,"sine",.055,.33);noise(.55,.045,.35,180)}
  else if(kind==="four"){noise(.07,.13,.24,1100);tone(180,.09,"square",.075,.24);noise(.34,.035,.35,200)}
  else if(kind==="wicket"){noise(.06,.12,.24,1500);tone(520,.08,"square",.08,.24);tone(360,.12,"square",.07,.32);tone(210,.18,"sawtooth",.055,.43)}
  else if(kind==="ball"){tone(185,.045,"square",.04,.25);noise(.08,.025,.31,650)}
  else if(kind==="decision"){tone(620,.06,"sine",.045,0);tone(760,.08,"sine",.04,.09)}
}
function commentaryVoice(){
  const vs=window.speechSynthesis?.getVoices?.()||[];
  return vs.find(v=>/^en-IN$/i.test(v.lang))||vs.find(v=>/^en/i.test(v.lang))||vs[0]||null
}
function speakCommentary(text){
  if(!audioPref.voice||!text||!("speechSynthesis" in window))return;
  try{
    // Keep commentary current instead of building a long queue.
    speechSynthesis.cancel();
    const u=new SpeechSynthesisUtterance(String(text).replace(/[—–]/g,", "));
    const v=commentaryVoice();if(v)u.voice=v;
    u.lang=v?.lang||"en-IN";u.rate=1.08;u.pitch=1.0;u.volume=.92;
    speechSynthesis.speak(u)
  }catch{}
}
function audioFromEvent(e){
  const type=e?.event_type||"ball",text=e?.payload?.text||"";
  playCricketSfx(type);
  if(type!=="decision")setTimeout(()=>speakCommentary(text),460)
}
function visualFromEvent(e){
  const type=e?.event_type||"";
  if(!["ball","four","six","wicket"].includes(type))return;
  const payload=e?.payload||{};
  visualEventQueue=visualEventQueue.then(async()=>{
    if(currentPage!=="liveMatch"||document.visibilityState!=="visible")return;
    try{
      await animateDelivery({
        runs:Number(payload.runs||0),
        wicket:!!payload.wicket,
        type
      });
      if(type==="six")splash("SIX!");
      else if(type==="four")splash("FOUR!");
      else if(type==="wicket")splash("WICKET!");
      setAutoStatus("5s BREAK • NEXT DELIVERY SOON");
      await new Promise(r=>setTimeout(r,5000));
    }catch(err){
      console.warn("Delivery animation failed",err)
    }
  });
}
$("gameSoundToggle")?.addEventListener("click",()=>{ensureAudio();audioPref.sfx=!audioPref.sfx;saveAudioPref();if(audioPref.sfx)tone(440,.08,"sine",.05)});
$("voiceToggle")?.addEventListener("click",()=>{ensureAudio();audioPref.voice=!audioPref.voice;if(!audioPref.voice&&"speechSynthesis" in window)speechSynthesis.cancel();saveAudioPref();if(audioPref.voice)speakCommentary("Commentary voice enabled.")});

let pageHistory=[];
function updateBackButton(){const b=$("gameBackBtn");if(b)b.classList.toggle("hidden",currentPage==="home")}
function nav(id,opt={}){if(!$(id))return;if(id===currentPage){updateBackButton();return}if(!opt.fromBack&&currentPage)pageHistory.push(currentPage);qsa(".page").forEach(p=>p.classList.remove("active"));$(id).classList.add("active");currentPage=id;if(id==="home")pageHistory=[];if(id==="liveMatch")initThree();if(id==="scorecard")renderScorecard();if(id==="pointsTable")renderPoints();if(id==="statistics")renderStats();if(id==="profile")renderProfilePage();updateBackButton();window.scrollTo({top:0,behavior:"smooth"})}
function gameBack(){if(currentPage==="liveMatch"&&match&&!paused){paused=true;nav("pauseMenu",{fromBack:true});return}if(currentPage==="pauseMenu"&&match){paused=false;nav("liveMatch",{fromBack:true});return}let prev=pageHistory.pop();while(prev===currentPage)prev=pageHistory.pop();nav(prev||"home",{fromBack:true})}
$("gameBackBtn")?.addEventListener("click",gameBack);
$("brandHome")?.addEventListener("click",()=>nav("home"));
$("userProfileButton")?.addEventListener("click",()=>nav("profile"));
$("resumeLiveMatchTile")?.addEventListener("click",resumeRestoredMatch);
qsa("[data-nav]").forEach(b=>b.addEventListener("click",()=>nav(b.dataset.nav)));
$("enterGame").addEventListener("click",()=>{ensureAudio();renderAudioButtons();$("boot").classList.remove("active");$("app").classList.remove("hidden");updateBackButton()});

function P(id){return state.players.find(p=>p.id===id)}
function T(id){return state.teams.find(t=>t.id===id)}
function C(id){return state.competitions.find(c=>c.id===id)}
function teamPlayers(team){return (team?.squad||[]).map(P).filter(Boolean)}
function xiPlayers(team,fixtureSide=null){const ids=fixtureSide?.xi||team?.defaultXI||[];return ids.map(P).filter(Boolean)}

function renderPlayers(){const body=$("playerRows");body.innerHTML=state.players.map(p=>`<tr data-p="${p.id}"><td>${esc(p.role)}</td><td>${p.ovr}</td><td>${p.hand}</td><td>${p.bowlingSkill}</td><td>${esc(p.name)}</td><td>${esc(p.team)}</td></tr>`).join("");qsa("[data-p]",body).forEach(r=>r.addEventListener("click",()=>{const p=P(r.dataset.p);$("previewPlayer").textContent=p.name.toUpperCase();$("previewPlayerMeta").textContent=`${p.role} • OVR ${p.ovr} • ${p.hand} • ${p.bowling}`}))}
$("resetDemoData").addEventListener("click",()=>{if(confirm("Reset players and teams to demo data?")){generateDemo();save()}});

function renderTeams(){
  $("teamEditorList").innerHTML=state.teams.map(t=>`<div class="manager-assignment"><b>${esc(t.name)}</b><span>${t.squad.length} players</span><span>${t.rating} OVR</span></div>`).join("");
  const opts=state.teams.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join("");$("quickA").innerHTML=opts;$("quickB").innerHTML=opts;if(!$("quickA").value)$("quickA").selectedIndex=0;if(!$("quickB").value||$("quickB").value===$("quickA").value)$("quickB").selectedIndex=1;syncQuick()
}
function syncQuick(){const a=T($("quickA").value)||state.teams[0],b=T($("quickB").value)||state.teams[1];if(a){$("quickAName").textContent=a.name;$("quickARating").textContent=a.rating}if(b){$("quickBName").textContent=b.name;$("quickBRating").textContent=b.rating}renderLineups()}
$("quickA").addEventListener("change",syncQuick);$("quickB").addEventListener("change",syncQuick);
$("quickProceed").addEventListener("click",()=>{syncQuick();nav("preMatch")});
$("openMatchRoom").addEventListener("click",()=>{ensureLocalRoom();nav("matchRoom");renderMatchRoom()});

function renderLineups(){const a=T($("quickA").value)||state.teams[0],b=T($("quickB").value)||state.teams[1];if(!a||!b)return;$("lineAHead").textContent=a.name.toUpperCase();$("lineBHead").textContent=b.name.toUpperCase();const rows=t=>(t.defaultXI||[]).map((id,i)=>{const p=P(id);return`<div class="line-row"><span>${i+1}</span><span>${esc(p?.name)}</span><span>${p?.hand}</span><span>${p?.bowlingSkill}</span><span>${p?.ovr}</span></div>`}).join("");$("lineA").innerHTML=rows(a);$("lineB").innerHTML=rows(b)}

function generateRoundRobin(teamIds,rr=1){const fixtures=[];for(let r=0;r<rr;r++)for(let i=0;i<teamIds.length;i++)for(let j=i+1;j<teamIds.length;j++)fixtures.push({id:uid(),teamA:teamIds[i],teamB:teamIds[j],status:"scheduled",matchId:null,result:null,round:r+1});return fixtures}
function managerInviteFor(team){return code(team.name.split(" ")[0].slice(0,3).toUpperCase())}
$("saveCompetition").addEventListener("click",()=>{
  const count=+$("compTeamCount").value, teams=state.teams.slice(0,count).map(t=>t.id), comp={id:uid(),name:$("compName").value.trim()||"Custom Championship",structure:$("compStructure").value,format:$("compFormat").value,teams,rr:+$("compRR").value,hasFinals:$("compFinals").value==="Yes",finalTeams:+$("compFinalTeams").value,winPts:+$("compWinPts").value,tiePts:+$("compTiePts").value,superOver:$("compSuperOver").value==="Enabled",decisionTimer:ONLINE_MANAGER_TIMEOUT,createdAt:nowISO(),managerSlots:{},fixtures:[]};
  teams.forEach(id=>comp.managerSlots[id]={invite:managerInviteFor(T(id)),managerUserId:null,managerName:null});comp.fixtures=generateRoundRobin(teams,comp.rr);state.competitions.push(comp);save();renderTournamentSelect();$("tournamentSelect").value=comp.id;renderTournamentDashboard();nav("tournamentDashboard")
});
["compName","compStructure","compFormat","compTeamCount"].forEach(id=>$(id).addEventListener("input",()=>{$("competitionPreview").textContent=$("compName").value;$("competitionPreviewMeta").textContent=`${$("compTeamCount").value} Teams • ${$("compFormat").value} • ${$("compStructure").value}`}));

function renderTournamentSelect(){const s=$("tournamentSelect");s.innerHTML=state.competitions.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join("");if(state.competitions.length&&!s.value)s.value=state.competitions.at(-1).id}
$("tournamentSelect").addEventListener("change",renderTournamentDashboard);
function currentComp(){return C($("tournamentSelect").value)||state.competitions.at(-1)}
function renderTournamentDashboard(){
  const c=currentComp();if(!c){$("tournamentName").textContent="No tournament selected";$("managerAssignments").innerHTML='<div class="empty-state">Create a tournament first.</div>';$("fixtureList").innerHTML="";return}
  $("tournamentName").textContent=c.name;
  $("managerAssignments").innerHTML=c.teams.map(id=>{const t=T(id),s=c.managerSlots[id];return`<div class="manager-assignment"><b>${esc(t.name)}</b><span>${s.managerName?esc(s.managerName):"Unclaimed"}</span><span class="manager-code">${esc(s.invite)}</span></div>`}).join("");
  $("fixtureList").innerHTML=c.fixtures.map((f,i)=>`<div class="fixture"><div><b>${esc(T(f.teamA).name)} vs ${esc(T(f.teamB).name)}</b><div class="muted">${f.status}${f.result?" • "+esc(f.result):""}</div></div><button data-fix="${f.id}">${f.status==="completed"?"VIEW":"OPEN"}</button></div>`).join("");
  qsa("[data-fix]",$("fixtureList")).forEach(b=>b.addEventListener("click",()=>selectFixture(b.dataset.fix)));
  renderPoints();renderStats()
}
function selectFixture(id){const c=currentComp(),f=c?.fixtures.find(x=>x.id===id);if(!f)return;activeFixtureId=id;const a=T(f.teamA),b=T(f.teamB);$("hostFixturePanel").innerHTML=`<h3>${esc(a.name)} vs ${esc(b.name)}</h3><p>Status: <b>${esc(f.status)}</b></p><button id="fixtureRoomBtn" class="white-action">OPEN MATCH ROOM</button>`;$("fixtureRoomBtn").addEventListener("click",()=>{state.localRoom={id:f.matchId||uid(),fixtureId:f.id,tournamentId:c.id,teamA:a.id,teamB:b.id,shareCode:("M"+Math.random().toString(36).slice(2,7)).toUpperCase(),managerCodeA:c.managerSlots[a.id].invite,managerCodeB:c.managerSlots[b.id].invite,managerA:c.managerSlots[a.id].managerName,managerB:c.managerSlots[b.id].managerName,lineupA:null,lineupB:null,status:f.status==="completed"?"completed":"lobby",visibility:"public",decisionTimer:ONLINE_MANAGER_TIMEOUT,cloudId:f.matchId};save();renderMatchRoom();nav("matchRoom")})}

function ensureLocalRoom(){const a=T($("quickA").value)||state.teams[0],b=T($("quickB").value)||state.teams[1];if(!state.localRoom||state.localRoom.status==="completed")state.localRoom={id:uid(),fixtureId:null,tournamentId:null,teamA:a.id,teamB:b.id,shareCode:("M"+Math.random().toString(36).slice(2,7)).toUpperCase(),managerCodeA:managerInviteFor(a),managerCodeB:managerInviteFor(b),managerA:null,managerB:null,lineupA:null,lineupB:null,status:"lobby",visibility:"public",decisionTimer:ONLINE_MANAGER_TIMEOUT,cloudId:null};return state.localRoom}
function renderMatchRoom(){
  const r=ensureLocalRoom(),a=T(r.teamA),b=T(r.teamB);$("roomTitle").textContent=`${a.name} vs ${b.name}`;$("roomMatchCode").textContent=r.shareCode;$("roomTeamA").textContent=a.name;$("roomTeamB").textContent=b.name;$("managerAStatus").textContent=r.managerA||"Not claimed";$("managerBStatus").textContent=r.managerB||"Not claimed";$("lineupAStatus").textContent=r.lineupA?"Submitted ✓":"Not submitted";$("lineupBStatus").textContent=r.lineupB?"Submitted ✓":"Not submitted";$("managerCodeA").value=r.managerCodeA;$("managerCodeB").value=r.managerCodeB;$("roomDecisionTimer").value=ONLINE_MANAGER_TIMEOUT;$("matchVisibility").value=r.visibility||"public";$("roomAXI").innerHTML=r.lineupA?r.lineupA.xi.map(id=>esc(P(id)?.name)).join("<br>"):"";$("roomBXI").innerHTML=r.lineupB?r.lineupB.xi.map(id=>esc(P(id)?.name)).join("<br>"):"";const base=location.origin&&location.origin!=="null"?location.origin+location.pathname:"YOUR_DEPLOYED_SITE";$("spectatorLink").value=`${base}#watch=${r.shareCode}`;
}
$("roomDecisionTimer").addEventListener("change",()=>{const r=ensureLocalRoom();r.decisionTimer=ONLINE_MANAGER_TIMEOUT;$("roomDecisionTimer").value=ONLINE_MANAGER_TIMEOUT;save()});$("matchVisibility").addEventListener("change",()=>{const r=ensureLocalRoom();r.visibility=$("matchVisibility").value;save()});

function currentDemoRole(){return state.localRole}
$("localRole").addEventListener("change",()=>{if(session&&cloudReady()){alert("Online roles are assigned securely by the server.");renderAll();return}state.localRole=$("localRole").value;save();renderManagerHub()});
function localManagerTeam(){const r=ensureLocalRoom();if(state.localRole==="managerA")return T(r.teamA);if(state.localRole==="managerB")return T(r.teamB);return null}
function aggressionLabel(v){v=+v||0;return v<=20?"DEFENSIVE":v<70?"BALANCED":v<95?"AGGRESSIVE":"ALL-OUT"}
async function loadMyAggressionFromCloud(tournamentTeamId,matchId){
  if(!session||!matchId||!tournamentTeamId)return;
  const rows=await api(`/rest/v1/manager_actions?match_id=eq.${matchId}&tournament_team_id=eq.${tournamentTeamId}&action_type=eq.batting_aggression&user_id=eq.${session.user.id}&order=created_at.desc&limit=1&select=payload`);
  const v=rows?.[0]?.payload?.value;if(Number.isFinite(+v)){state.localRoom.myBattingAggression=clamp(+v,0,100);localStorage.setItem(SAVE,JSON.stringify(state))}
}
async function submitBattingAggression(value){
  const r=state.localRoom,team=localManagerTeam();if(!session||!r?.cloudId||!team)throw new Error("No active managed team.");
  const m=await api("/rest/v1/matches?id=eq."+r.cloudId+"&select=tournament_id,state,status");if(!m.length||m[0].status!=="live")throw new Error("The match is not live.");
  if(m[0].state?.battingTeam!==team.id)throw new Error("Batting aggression is available only while your team is batting.");
  const tts=await api(`/rest/v1/tournament_teams?tournament_id=eq.${m[0].tournament_id}&local_team_id=eq.${team.id}&manager_user_id=eq.${session.user.id}&select=id`);if(!tts.length)throw new Error("You are not assigned to this team.");
  const v=clamp(Math.round(+value),0,100);
  await api("/rest/v1/manager_actions",{method:"POST",body:JSON.stringify({match_id:r.cloudId,tournament_team_id:tts[0].id,user_id:session.user.id,decision_id:`aggr-${Date.now()}-${uid().slice(0,6)}`,action_type:"batting_aggression",payload:{value:v,label:aggressionLabel(v)}})});
  r.myBattingAggression=v;localStorage.setItem(SAVE,JSON.stringify(state));return v
}
function renderLiveManagerWorkspace(team,r){
  const live=r.liveState||{},isBatting=live.battingTeam===team.id,current=clamp(Number.isFinite(+r.myBattingAggression)?+r.myBattingAggression:50,0,100);
  $("myManagedTeam").textContent=team.name+" — LIVE MANAGER";
  if(isBatting){
    $("managerWorkspace").innerHTML=`<div class="manager-live-control"><div class="manager-workspace-head"><div><b>LIVE BATTING CONTROL</b><div class="muted">Private control for ${esc(team.name)}. Only this team's assigned manager can change it.</div></div><span class="live-control-badge">BATTING</span></div><div class="aggression-readout"><span>Batting aggression</span><b id="aggressionValue">${aggressionLabel(current)} • ${current}</b></div><input id="battingAggressionSlider" class="aggression-slider" type="range" min="0" max="100" step="1" value="${current}"><div class="aggression-scale"><span>DEFENSIVE<br><small>Defend • 1s • 2s</small></span><span>BALANCED<br><small>Full scoring range</small></span><span>ALL-OUT<br><small>More 4s • 6s • risk</small></span></div><p class="manager-private-note">The Host and opposition manager cannot submit this control. Your latest setting is read by the match engine before each delivery.</p><button id="managerWatchLive" class="white-action" type="button">WATCH MATCH & CONTROL LIVE</button></div>`;
    const slider=$("battingAggressionSlider"),read=$("aggressionValue");slider.addEventListener("input",()=>{read.textContent=`${aggressionLabel(slider.value)} • ${slider.value}`});slider.addEventListener("change",async()=>{slider.disabled=true;try{const v=await submitBattingAggression(slider.value);read.textContent=`${aggressionLabel(v)} • ${v}`;read.classList.add("saved-flash");setTimeout(()=>read.classList.remove("saved-flash"),900)}catch(e){alert(e.message)}finally{slider.disabled=false}});$("managerWatchLive")?.addEventListener("click",()=>watchByCode(r.shareCode))
  }else{
    $("managerWorkspace").innerHTML=`<div class="manager-live-control"><div class="manager-workspace-head"><div><b>LIVE BOWLING CONTROL</b><div class="muted">Your team is bowling. At the end of every over, you receive a 60-second Next Bowler prompt. If you do not choose in time, the AI selects a legal bowler automatically.</div></div><span class="live-control-badge bowling">BOWLING</span></div><div class="empty-state">Keep this page open. Bowler-selection and incoming-batter prompts appear automatically when your team needs a decision.</div><button id="managerWatchLive" class="white-action" type="button">WATCH MATCH LIVE</button></div>`;$("managerWatchLive")?.addEventListener("click",()=>watchByCode(r.shareCode))
  }
}
function renderManagerLiveDock(){
  const dock=$("managerLiveAggression"),slider=$("liveAggressionSlider"),label=$("liveAggressionLabel");if(!dock||!slider||!label)return;
  const team=localManagerTeam(),isManager=state.localRole==="managerA"||state.localRole==="managerB",isBatting=!!(isManager&&team&&match&&match.battingTeam?.id===team.id&&state.localRoom?.status==="live");dock.classList.toggle("hidden",!isBatting);if(!isBatting)return;
  const v=clamp(Number.isFinite(+state.localRoom.myBattingAggression)?+state.localRoom.myBattingAggression:50,0,100);if(document.activeElement!==slider)slider.value=v;label.textContent=`${aggressionLabel(slider.value)} • ${slider.value}`
}
$("liveAggressionSlider")?.addEventListener("input",()=>{$("liveAggressionLabel").textContent=`${aggressionLabel($("liveAggressionSlider").value)} • ${$("liveAggressionSlider").value}`});
$("liveAggressionSlider")?.addEventListener("change",async()=>{const el=$("liveAggressionSlider");el.disabled=true;try{const v=await submitBattingAggression(el.value);el.value=v;$("liveAggressionLabel").textContent=`${aggressionLabel(v)} • ${v}`}catch(e){alert(e.message)}finally{el.disabled=false}});

function renderManagerHub(){
  $("localRole").value=state.localRole;const demoRoleBox=$("localRole").closest(".demo-role");if(demoRoleBox)demoRoleBox.style.display=(session&&cloudReady())?"none":"";const team=localManagerTeam(),r=ensureLocalRoom();
  if(!team){
    $("myManagedTeam").textContent=state.localRole==="host"?"Host / Administrator":state.localRole==="spectator"?"Spectator":"No team claimed";
    $("managerWorkspace").innerHTML=state.localRole==="host"?'<div class="empty-state">Host creates tournaments, starts matches and can view all data.</div>':state.localRole==="spectator"?'<div class="empty-state">Spectators can watch live matches, points tables and statistics. They cannot control a team.</div>':'<div class="empty-state">Claim a team code to continue.</div>';
    return
  }
  if(r.status==="live"){renderLiveManagerWorkspace(team,r);return}
  $("myManagedTeam").textContent=team.name+" — MANAGER";
  const side=team.id===r.teamA?"A":"B",existing=side==="A"?r.lineupA:r.lineupB;
  let order=existing?.battingOrder?[...existing.battingOrder]:[...(existing?.xi||team.defaultXI)];
  const selected=new Set(existing?.xi||team.defaultXI);
  $("managerWorkspace").innerHTML=`<div class="manager-workspace-head"><div><b>Submit Playing XI</b><div class="muted">Choose exactly 11, arrange the batting order, then select captain and wicketkeeper.</div></div><span>${existing?"SUBMITTED ✓":"NOT SUBMITTED"}</span></div><div class="workspace-columns"><div><h4>Squad</h4><div class="squad-select">${team.squad.map(id=>{const p=P(id);return`<label class="squad-player"><input type="checkbox" data-xi="${id}" ${selected.has(id)?"checked":""}><span>${esc(p.name)} <small class="muted">${esc(p.role)}</small></span></label>`}).join("")}</div></div><div><h4>Batting Order</h4><div id="orderList" class="order-list"></div><label>Captain</label><select id="captainSelect"></select><label>Wicketkeeper</label><select id="wkSelect"></select></div></div><button id="submitXI" class="white-action manager-submit">SUBMIT PLAYING XI</button>`;
  const renderOrder=()=>{
    const checked=new Set(qsa("[data-xi]:checked").map(x=>x.dataset.xi));
    order=order.filter(id=>checked.has(id));
    for(const id of checked)if(!order.includes(id))order.push(id);
    $("orderList").innerHTML=order.map((id,i)=>`<div class="order-player"><span>${i+1}. ${esc(P(id).name)}</span><span><button type="button" data-up="${id}" ${i===0?"disabled":""}>↑</button> <button type="button" data-down="${id}" ${i===order.length-1?"disabled":""}>↓</button></span></div>`).join("");
    qsa("[data-up]").forEach(b=>b.addEventListener("click",()=>{const i=order.indexOf(b.dataset.up);if(i>0){[order[i-1],order[i]]=[order[i],order[i-1]];renderOrder()}}));
    qsa("[data-down]").forEach(b=>b.addEventListener("click",()=>{const i=order.indexOf(b.dataset.down);if(i>=0&&i<order.length-1){[order[i+1],order[i]]=[order[i],order[i+1]];renderOrder()}}));
    const opts=order.map(id=>`<option value="${id}">${esc(P(id).name)}</option>`).join("");
    const capPrev=$("captainSelect").value,wkPrev=$("wkSelect").value;$("captainSelect").innerHTML=opts;$("wkSelect").innerHTML=opts;
    if(order.includes(capPrev))$("captainSelect").value=capPrev;else if(existing?.captain&&order.includes(existing.captain))$("captainSelect").value=existing.captain;
    if(order.includes(wkPrev))$("wkSelect").value=wkPrev;else if(existing?.wicketkeeper&&order.includes(existing.wicketkeeper))$("wkSelect").value=existing.wicketkeeper
  };
  qsa("[data-xi]").forEach(x=>x.addEventListener("change",renderOrder));renderOrder();
  $("submitXI").addEventListener("click",async()=>{
    const ids=qsa("[data-xi]:checked").map(x=>x.dataset.xi);
    if(ids.length!==11)return alert(`Select exactly 11 players. Selected ${ids.length}.`);
    if(order.length!==11)return alert("Batting order must contain all 11 selected players.");
    const sub={xi:ids,battingOrder:[...order],captain:$("captainSelect").value,wicketkeeper:$("wkSelect").value,submittedAt:nowISO()};
    if(side==="A"){r.lineupA=sub;r.managerA=r.managerA||"Local Team A Manager"}else{r.lineupB=sub;r.managerB=r.managerB||"Local Team B Manager"}
    save();if(session&&r.cloudId)await submitCloudLineup(r.cloudId,team.id,sub).catch(e=>alert(e.message));renderManagerHub();renderMatchRoom()
  })
}

$("claimManagerBtn").addEventListener("click",async()=>{const c=$("claimManagerCode").value.trim().toUpperCase();if(!c)return;if(session&&cloudReady()){if(serverRole==="admin")return alert("Administrator account cannot claim a manager team.");try{const res=await api("/rest/v1/rpc/claim_manager_code",{method:"POST",body:JSON.stringify({p_code:c})});alert("Team claimed.");await pullProfile().catch(()=>{});await loadRoomFromCloudByManager().catch(()=>{});renderManagerHub()}catch(e){alert(e.message)}}else{const r=ensureLocalRoom();if(c===r.managerCodeA){state.localRole="managerA";r.managerA="Local Manager A"}else if(c===r.managerCodeB){state.localRole="managerB";r.managerB="Local Manager B"}else return alert("Manager code not found in local demo.");save();renderManagerHub();renderMatchRoom()}});

async function createOnlineRoom(){
  if(!session||!cloudReady())return alert("Sign in and configure Supabase first. Local room is still usable for testing.");
  const r=ensureLocalRoom();r.decisionTimer=ONLINE_MANAGER_TIMEOUT;let c=r.tournamentId?C(r.tournamentId):null;try{
    if(c){const cloudTournament=await ensureCloudTournament(c);r.cloudTournamentId=cloudTournament.id;await ensureCloudManagerInvites(r,c)}
    else{const adhoc=await ensureAdHocCloudTournament(r);r.cloudTournamentId=adhoc.id}
    const payload={host_user_id:session.user.id,tournament_id:r.cloudTournamentId,share_code:r.shareCode,team_a_local_id:r.teamA,team_b_local_id:r.teamB,status:"lobby",visibility:r.visibility,state:{score:0,wickets:0,balls:0,phase:"lobby"},decision_timeout:r.decisionTimer};
    const rows=await api("/rest/v1/matches",{method:"POST",headers:{"Prefer":"return=representation"},body:JSON.stringify(payload)});r.cloudId=rows[0].id;
    save();renderMatchRoom();startRoomPolling();alert("Online room created.")
  }catch(e){alert(e.message)}
}
$("createOnlineRoom").addEventListener("click",createOnlineRoom);

async function ensureAdHocCloudTournament(r){
  const a=T(r.teamA),b=T(r.teamB),localRef="adhoc-"+r.id;
  let found=await api("/rest/v1/tournaments?owner_user_id=eq."+session.user.id+"&local_ref=eq."+encodeURIComponent(localRef)+"&select=*");if(found?.length)return found[0];
  const rows=await api("/rest/v1/tournaments",{method:"POST",headers:{"Prefer":"return=representation"},body:JSON.stringify({owner_user_id:session.user.id,local_ref:localRef,name:`Exhibition: ${a.name} vs ${b.name}`,visibility:r.visibility,settings:{format:"T20",decisionTimer:r.decisionTimer}})});const tr=rows[0];
  const created=[];
  for(const t of [a,b]){const row=await api("/rest/v1/tournament_teams",{method:"POST",headers:{"Prefer":"return=representation"},body:JSON.stringify({tournament_id:tr.id,local_team_id:t.id,team_name:t.name,squad:t.squad,manager_user_id:null})});created.push(row[0])}
  await api("/rest/v1/manager_invites",{method:"POST",body:JSON.stringify({tournament_team_id:created[0].id,invite_code:r.managerCodeA,owner_user_id:session.user.id})});
  await api("/rest/v1/manager_invites",{method:"POST",body:JSON.stringify({tournament_team_id:created[1].id,invite_code:r.managerCodeB,owner_user_id:session.user.id})});
  return tr
}

async function ensureCloudTournament(c){
  let found=await api("/rest/v1/tournaments?owner_user_id=eq."+session.user.id+"&local_ref=eq."+encodeURIComponent(c.id)+"&select=*");if(found?.length)return found[0];
  const rows=await api("/rest/v1/tournaments",{method:"POST",headers:{"Prefer":"return=representation"},body:JSON.stringify({owner_user_id:session.user.id,local_ref:c.id,name:c.name,visibility:"public",settings:c})});const tr=rows[0];
  for(const tid of c.teams)await api("/rest/v1/tournament_teams",{method:"POST",body:JSON.stringify({tournament_id:tr.id,local_team_id:tid,team_name:T(tid).name,squad:T(tid).squad,manager_user_id:null})});
  return tr
}
async function ensureCloudManagerInvites(r,c){
  const teamRows=await api("/rest/v1/tournament_teams?tournament_id=eq."+r.cloudTournamentId+"&select=id,local_team_id");
  for(const tr of teamRows){const slot=c.managerSlots[tr.local_team_id];if(slot)await api("/rest/v1/manager_invites",{method:"POST",headers:{"Prefer":"resolution=ignore-duplicates"},body:JSON.stringify({tournament_team_id:tr.id,invite_code:slot.invite,owner_user_id:session.user.id})}).catch(()=>{})}
}
async function submitCloudLineup(matchId,localTeamId,sub){
  const m=await api("/rest/v1/matches?id=eq."+matchId+"&select=tournament_id");const tt=await api("/rest/v1/tournament_teams?tournament_id=eq."+m[0].tournament_id+"&local_team_id=eq."+localTeamId+"&select=id");if(!tt.length)throw new Error("Online team assignment not found.");
  await api("/rest/v1/lineup_submissions?on_conflict=match_id,tournament_team_id",{method:"POST",headers:{"Prefer":"resolution=merge-duplicates"},body:JSON.stringify({match_id:matchId,tournament_team_id:tt[0].id,user_id:session.user.id,lineup:sub})})
}
async function loadRoomFromCloudByManager(){if(!session)return;const tts=await api("/rest/v1/tournament_teams?manager_user_id=eq."+session.user.id+"&select=id,tournament_id,local_team_id,team_name");if(!tts.length)return;const t=tts[0];const ms=await api(`/rest/v1/matches?tournament_id=eq.${t.tournament_id}&status=in.(lobby,live)&select=*`);if(!ms.length)return;const m=ms[0];state.localRoom={id:m.id,cloudId:m.id,cloudTournamentId:t.tournament_id,teamA:m.team_a_local_id,teamB:m.team_b_local_id,shareCode:m.share_code,managerCodeA:"CLAIMED",managerCodeB:"CLAIMED",managerA:null,managerB:null,lineupA:null,lineupB:null,status:m.status,visibility:m.visibility,decisionTimer:ONLINE_MANAGER_TIMEOUT,liveState:m.state||{}};state.localRole=t.local_team_id===m.team_a_local_id?"managerA":"managerB";await loadMyAggressionFromCloud(t.id,m.id).catch(()=>{});save();startRoomPolling()}
async function pollRoom(){
  const r=state.localRoom;if(!session||!r?.cloudId||!cloudReady())return;
  try{
    const ms=await api("/rest/v1/matches?id=eq."+r.cloudId+"&select=*");if(!ms.length)return;const m=ms[0];r.status=m.status;r.shareCode=m.share_code;r.decisionTimer=ONLINE_MANAGER_TIMEOUT;r.liveState=m.state||{};
    const subs=await api("/rest/v1/lineup_submissions?match_id=eq."+r.cloudId+"&select=tournament_team_id,lineup,user_id");
    if(m.tournament_id){const tts=await api("/rest/v1/tournament_teams?tournament_id=eq."+m.tournament_id+"&select=id,local_team_id,manager_user_id");for(const tt of tts){const s=subs.find(x=>x.tournament_team_id===tt.id);if(tt.local_team_id===r.teamA){r.lineupA=s?.lineup||r.lineupA;r.managerA=tt.manager_user_id?"Claimed ✓":r.managerA}else if(tt.local_team_id===r.teamB){r.lineupB=s?.lineup||r.lineupB;r.managerB=tt.manager_user_id?"Claimed ✓":r.managerB}}}
    if(m.status==="live"&&(state.localRole==="spectator"||m.state?.engineMode==="server-v1"))syncSpectatorState(m);
    if(m.status==="live"&&(state.localRole==="managerA"||state.localRole==="managerB"))handleRemoteManagerDecision(m.state?.pendingDecision);
    localStorage.setItem(SAVE,JSON.stringify(state));renderMatchRoom();renderManagerHub()
  }catch{}
}
function startRoomPolling(){clearInterval(cloudPoll);cloudPoll=setInterval(pollRoom,2500);pollRoom()}
async function hydrateRoomFromCloudMatch(m){
  const old=state.localRoom||{};const room={id:m.id,cloudId:m.id,cloudTournamentId:m.tournament_id,tournamentId:old.tournamentId||null,fixtureId:old.fixtureId||null,teamA:m.team_a_local_id,teamB:m.team_b_local_id,shareCode:m.share_code,managerCodeA:old.managerCodeA||"ASSIGNED",managerCodeB:old.managerCodeB||"ASSIGNED",managerA:null,managerB:null,lineupA:null,lineupB:null,status:m.status,visibility:m.visibility,decisionTimer:ONLINE_MANAGER_TIMEOUT,liveState:m.state||{}};
  if(m.tournament_id){
    const tts=await api(`/rest/v1/tournament_teams?tournament_id=eq.${m.tournament_id}&select=id,local_team_id,manager_user_id`);const subs=await api(`/rest/v1/lineup_submissions?match_id=eq.${m.id}&select=tournament_team_id,lineup,user_id`);
    for(const tt of tts){const sub=subs.find(x=>x.tournament_team_id===tt.id);if(tt.local_team_id===room.teamA){room.lineupA=sub?.lineup||null;room.managerA=tt.manager_user_id?"Claimed ✓":null;room.cloudTeamAId=tt.id}else if(tt.local_team_id===room.teamB){room.lineupB=sub?.lineup||null;room.managerB=tt.manager_user_id?"Claimed ✓":null;room.cloudTeamBId=tt.id}}
    if(serverRole==="admin")try{const ids=tts.map(x=>x.id).join(",");if(ids){const inv=await api(`/rest/v1/manager_invites?tournament_team_id=in.(${ids})&select=tournament_team_id,invite_code`);for(const x of inv){if(x.tournament_team_id===room.cloudTeamAId)room.managerCodeA=x.invite_code;if(x.tournament_team_id===room.cloudTeamBId)room.managerCodeB=x.invite_code}}}catch{}
  }
  return room
}
async function discoverActiveHostMatch(){
  if(!session||!cloudReady()||serverRole!=="admin")return false;
  try{const rows=await api(`/rest/v1/matches?host_user_id=eq.${session.user.id}&status=eq.live&order=updated_at.desc&limit=1&select=*`);if(!rows.length){const local=loadJSON(ACTIVE_MATCH,null);if(local?.state&&!local.state.completed&&!local?.room?.cloudId){state.localRoom=local.room;match=restoreMatchObject(local.room,local.state);restoredLiveMatch=!!match;paused=true;renderAll();return !!match}return false}
    const m=rows[0],room=await hydrateRoomFromCloudMatch(m);state.localRoom=room;state.localRole="host";match=restoreMatchObject(room,m.state||{});if(!match)return false;restoredLiveMatch=true;paused=true;localStorage.setItem(SAVE,JSON.stringify(state));persistActiveMatchLocal();renderAll();return true
  }catch{return false}
}
async function resolveRestoredPendingDecision(){
  const d=match?.pendingDecision;if(!d)return;const options=(d.options||[]).map(P).filter(Boolean);if(!options.length){match.pendingDecision=null;return}
  let chosen=null;const remaining=Math.max(0,Math.ceil(((+d.deadline||0)-Date.now())/1000));
  if(match.room?.cloudId&&session&&managerForTeam(d.teamId)){setAutoStatus(`RESTORING MANAGER DECISION • ${remaining}s LEFT`);const found=await waitForCloudManagerAction(d,Math.max(1,remaining));if(found)chosen=P(found)}
  if(!chosen)chosen=d.type==="next_bowler"?aiBowler():options[0];
  if(d.type==="next_bowler"){match.currentBowler=chosen;if(chosen)addCom(`${chosen.name} will bowl over ${Math.floor(match.balls/6)+1}.`,"system")}
  else{match.striker=chosen;match.nextIndex=Math.max(match.nextIndex,match.order.indexOf(chosen)+1);if(chosen)addCom(`${chosen.name} is the new batter.`,"system")}
  match.pendingDecision=null;await publishMatchState()
}
async function resumeRestoredMatch(){
  if(!match||match.completed)return alert("No live match to resume.");paused=false;restoredLiveMatch=false;nav("liveMatch");updateHUD();renderCommentaryFromState();if(match.engineMode==="server-v1"&&match.room?.cloudId){setAutoStatus("SERVER AUTO • ONLINE ENGINE ACTIVE");startSpectatorPolling()}else{await resolveRestoredPendingDecision();await publishMatchState();startAutoMatchLoop()}
}
function renderCommentaryFromState(){if(!$("commentaryFeed")||!match)return;$("commentaryFeed").innerHTML=(match.logs||[]).map(x=>`<div class="com ${esc(x.cls||"")}">${esc(x.text)}</div>`).join("");$("commentaryFeed").scrollTop=$("commentaryFeed").scrollHeight}

$("hostStartMatch").addEventListener("click",async()=>{
  const r=ensureLocalRoom();if(state.localRole!=="host"&&serverRole!=="admin")return alert("Only the Administrator/Host can start the match.");
  if(!r.lineupA||!r.lineupB){if(!confirm("One or both managers have not submitted a Playing XI. Use default XIs and start anyway?"))return;if(!r.lineupA)r.lineupA={xi:T(r.teamA).defaultXI,battingOrder:T(r.teamA).defaultXI,captain:T(r.teamA).defaultXI[0],wicketkeeper:T(r.teamA).defaultXI[4]};if(!r.lineupB)r.lineupB={xi:T(r.teamB).defaultXI,battingOrder:T(r.teamB).defaultXI,captain:T(r.teamB).defaultXI[0],wicketkeeper:T(r.teamB).defaultXI[4]}}
  r.decisionTimer=ONLINE_MANAGER_TIMEOUT;save();prepareMatch(r);if(r.cloudId&&session){try{await api("/rest/v1/matches?id=eq."+r.cloudId,{method:"PATCH",body:JSON.stringify({status:"live",started_at:nowISO(),decision_timeout:ONLINE_MANAGER_TIMEOUT,state:serializeMatch(),updated_at:nowISO()})})}catch(e){return alert("Could not prepare the online match: "+e.message)}}persistActiveMatchLocal();nav("toss");setTimeout(()=>{$("tossResult").textContent=(Math.random()<.5?T(r.teamA).name:T(r.teamB).name)+" won the toss and elected to bowl."},900)
});
$("tossContinue").addEventListener("click",async()=>{
  nav("liveMatch");
  showPlayerIntro(match.bowlingTeam);
  updateHUD();

  if(!(match.logs||[]).length)
    addCom(`${match.battingTeam.name} begin the innings.`,"system");

  if(match.room?.cloudId&&session){
    if(serverRole!=="admin"&&state.localRole!=="host"){
      setAutoStatus("SERVER ENGINE NOT STARTED • ADMIN VERIFICATION REQUIRED");
      return alert("Your Administrator role is not verified yet. Reopen the game or sign in again, then start a new match.");
    }

    try{
      match.engineMode="server-v1";
      match.engineActive=true;
      match.nextDeliveryAt=nowISO();

      const authoritativeState=serializeMatch();

      await api("/rest/v1/matches?id=eq."+match.room.cloudId,{
        method:"PATCH",
        body:JSON.stringify({
          status:"live",
          state:authoritativeState,
          decision_timeout:ONLINE_MANAGER_TIMEOUT,
          started_at:nowISO(),
          updated_at:nowISO()
        })
      });

      // Read the row back. Do not claim success unless Supabase actually stored
      // the server-engine activation flags.
      const verify=await api(
        "/rest/v1/matches?id=eq."
        +match.room.cloudId
        +"&select=id,status,state"
      );

      const remote=verify?.[0];
      const active=
        remote?.status==="live"
        && remote?.state?.engineMode==="server-v1"
        && remote?.state?.engineActive===true;

      if(!active){
        match.engineActive=false;
        setAutoStatus("SERVER ENGINE ACTIVATION FAILED");
        return alert("The match was not activated on the server. Please do not close Chrome yet. Send me a screenshot.");
      }

      state.localRole="host";
      localStorage.setItem(SAVE,JSON.stringify(state));
      persistActiveMatchLocal();

      lastAudioEventId=0;lastVisualEventId=0;lastAnimatedProgressKey=null;setAutoStatus("SERVER AUTO ACTIVE • SAFE TO CLOSE/BACKGROUND CHROME");
      startSpectatorPolling();

    }catch(e){
      match.engineActive=false;
      setAutoStatus("SERVER ENGINE ACTIVATION FAILED");
      alert("Server engine could not start: "+e.message);
    }

  }else{
    match.engineMode="browser";
    match.engineActive=true;
    await publishMatchState();
    startAutoMatchLoop();
  }
});

function prepareMatch(r){
  const a=T(r.teamA),b=T(r.teamB);const battingFirst=Math.random()<.5?a:b,bowlingFirst=battingFirst.id===a.id?b:a;
  match={room:r,a,b,innings:1,battingTeam:battingFirst,bowlingTeam:bowlingFirst,score:0,wickets:0,balls:0,target:null,first:null,order:[],striker:null,non:null,nextIndex:2,currentBowler:null,lastBowler:null,bowlerBalls:{},bowlerRuns:{},batterRuns:{},batterBalls:{},lastBalls:[],logs:[],superOverRound:0,pendingDecision:null,completed:false,battingAggression:{[a.id]:50,[b.id]:50},teamRowIds:{},engineMode:r.cloudId?"server-v1":"browser",engineActive:false,nextDeliveryAt:nowISO()};
  setInningsOrder()
}
function lineupForTeam(team){const r=match.room,sub=team.id===r.teamA?r.lineupA:r.lineupB;return sub||{xi:team.defaultXI,battingOrder:team.defaultXI}}
function setInningsOrder(){const sub=lineupForTeam(match.battingTeam);match.order=(sub.battingOrder||sub.xi).map(P).filter(Boolean);match.striker=match.order[0];match.non=match.order[1];match.nextIndex=2;match.currentBowler=null}
function showPlayerIntro(team){const p=xiPlayers(team,lineupForTeam(team))[0];if(!p)return;$("introName").textContent=p.name.toUpperCase();$("introRole").textContent=p.bowling;$("introCard").classList.remove("hidden");setTimeout(()=>$("introCard").classList.add("hidden"),2200)}

function managerForTeam(teamId){const r=match?.room||state.localRoom;if(!r)return null;if(teamId===r.teamA)return r.managerA;if(teamId===r.teamB)return r.managerB}
function localRoleCanControl(teamId){const r=match?.room||state.localRoom;if(state.localRole==="managerA"&&teamId===r.teamA)return true;if(state.localRole==="managerB"&&teamId===r.teamB)return true;return false}
function availableBowlers(){const sub=lineupForTeam(match.bowlingTeam),ids=sub.xi||match.bowlingTeam.defaultXI;return ids.map(P).filter(Boolean).filter(p=>(match.bowlerBalls[p.id]||0)<24).sort((a,b)=>b.bowlingSkill-a.bowlingSkill)}
function aiBowler(){let a=availableBowlers().filter(p=>p.id!==match.lastBowler);if(!a.length)a=availableBowlers();return a[0]}
async function requestDecision(type,team,options){
  const managerName=managerForTeam(team.id),timeout=match.room.cloudId?ONLINE_MANAGER_TIMEOUT:(match.room.decisionTimer||state.settings.timeout);
  if((!match.room.cloudId&&!state.settings.managerControl)||!managerName)return type==="next_bowler"?aiBowler():options[0];
  const decision={id:uid(),type,teamId:team.id,options:options.map(p=>p.id),deadline:Date.now()+timeout*1000,createdAt:nowISO()};match.pendingDecision=decision;await publishMatchState();
  if(localRoleCanControl(team.id)){return await showDecisionModal(decision,options)}
  if(match.room.cloudId&&session){const found=await waitForCloudManagerAction(decision,timeout);if(found)return P(found)}
  return type==="next_bowler"?aiBowler():options[0]
}
function showDecisionModal(decision,options){return new Promise(resolve=>{const label=decision.type==="next_bowler"?"Choose Next Bowler":"Choose Next Batter";$("decisionTitle").textContent=label;$("decisionHint").textContent=decision.type==="next_bowler"?"Select the bowler for the next over. AI will bowl every delivery.":"Choose who comes in next. AI will bat for the selected player.";$("decisionChoices").innerHTML=options.map(p=>`<div class="decision-choice"><div><b>${esc(p.name)}</b><span class="muted"> ${esc(p.role)} • OVR ${p.ovr}</span></div><button data-dec="${p.id}">SELECT</button></div>`).join("");$("decisionModal").classList.remove("hidden");let left=Math.max(1,Math.ceil((decision.deadline-Date.now())/1000));$("decisionCountdown").textContent=left;clearInterval(decisionTimerHandle);decisionTimerHandle=setInterval(()=>{left--; $("decisionCountdown").textContent=Math.max(0,left);if(left<=0){clearInterval(decisionTimerHandle);$("decisionModal").classList.add("hidden");resolve(decision.type==="next_bowler"?aiBowler():options[0])}},1000);qsa("[data-dec]",$("decisionChoices")).forEach(b=>b.addEventListener("click",async()=>{clearInterval(decisionTimerHandle);$("decisionModal").classList.add("hidden");const p=P(b.dataset.dec);if(match.room.cloudId&&session)await submitManagerAction(decision,p.id).catch(()=>{});resolve(p)}))})}
let lastRemoteDecisionId=null;
function localManagerTeamId(){const r=state.localRoom;if(!r)return null;return state.localRole==="managerA"?r.teamA:state.localRole==="managerB"?r.teamB:null}
function handleRemoteManagerDecision(decision){
  if(!decision||lastRemoteDecisionId===decision.id||decision.teamId!==localManagerTeamId())return;
  lastRemoteDecisionId=decision.id;
  const options=(decision.options||[]).map(P).filter(Boolean);
  if(!options.length)return;
  $("decisionTitle").textContent=decision.type==="next_bowler"?"Choose Next Bowler":"Choose Next Batter";
  $("decisionHint").textContent=decision.type==="next_bowler"?"Choose the bowler for the next over. The AI will bowl every delivery.":"Choose the incoming batter. The AI will bat for the selected player.";
  $("decisionChoices").innerHTML=options.map(p=>`<div class="decision-choice"><div><b>${esc(p.name)}</b><span class="muted"> ${esc(p.role)} • OVR ${p.ovr}</span></div><button data-remote-dec="${p.id}">SELECT</button></div>`).join("");
  $("decisionModal").classList.remove("hidden");
  let left=Math.max(0,Math.ceil((decision.deadline-Date.now())/1000));$("decisionCountdown").textContent=left;
  clearInterval(decisionTimerHandle);decisionTimerHandle=setInterval(()=>{left--; $("decisionCountdown").textContent=Math.max(0,left);if(left<=0){clearInterval(decisionTimerHandle);$("decisionModal").classList.add("hidden")}},1000);
  qsa("[data-remote-dec]",$("decisionChoices")).forEach(b=>b.addEventListener("click",async()=>{clearInterval(decisionTimerHandle);$("decisionModal").classList.add("hidden");try{await submitManagerAction(decision,b.dataset.remoteDec)}catch(e){alert(e.message)}}))
}

async function waitForCloudManagerAction(decision,timeout){const start=Date.now();while(Date.now()-start<timeout*1000){try{const rows=await api(`/rest/v1/manager_actions?match_id=eq.${match.room.cloudId}&decision_id=eq.${decision.id}&consumed=eq.false&select=*`);if(rows?.length){const a=rows[0];await api("/rest/v1/manager_actions?id=eq."+a.id,{method:"PATCH",body:JSON.stringify({consumed:true})});return a.payload?.player_id}}catch{}await sleep(1500)}return null}
async function submitManagerAction(decision,playerId){const room=match?.room||state.localRoom;if(!session||!room?.cloudId)return;const m=await api("/rest/v1/matches?id=eq."+room.cloudId+"&select=tournament_id");const tts=await api(`/rest/v1/tournament_teams?tournament_id=eq.${m[0].tournament_id}&local_team_id=eq.${decision.teamId}&select=id`);if(!tts.length)return;await api("/rest/v1/manager_actions",{method:"POST",body:JSON.stringify({match_id:room.cloudId,tournament_team_id:tts[0].id,user_id:session.user.id,decision_id:decision.id,action_type:decision.type,payload:{player_id:playerId}})})}

async function teamRowIdFor(teamId){if(!match?.room?.cloudTournamentId&&!match?.room?.tournament_id)return null;match.teamRowIds=match.teamRowIds||{};if(match.teamRowIds[teamId])return match.teamRowIds[teamId];const tid=match.room.cloudTournamentId||match.room.tournament_id;const rows=await api(`/rest/v1/tournament_teams?tournament_id=eq.${tid}&local_team_id=eq.${teamId}&select=id`);const id=rows?.[0]?.id||null;if(id)match.teamRowIds[teamId]=id;return id}
async function refreshBattingAggressionFromCloud(){
  if(!match||!match.room?.cloudId||!session||state.localRole!=="host")return;try{const tt=await teamRowIdFor(match.battingTeam.id);if(!tt)return;const rows=await api(`/rest/v1/manager_actions?match_id=eq.${match.room.cloudId}&tournament_team_id=eq.${tt}&action_type=eq.batting_aggression&order=created_at.desc&limit=1&select=payload`);const v=rows?.[0]?.payload?.value;if(Number.isFinite(+v))match.battingAggression[match.battingTeam.id]=clamp(+v,0,100)}catch{}
}
function aggression(){const p=match.striker,ov=match.balls/6,left=120-match.balls;let situation=.42+ov*.018;if(match.target){const need=Math.max(0,match.target-match.score),rr=need/Math.max(1,left/6);situation=.32+(rr-6)/14+(ov/20)*.10;if(left<=30)situation+=.05;if(left<=12)situation+=.08;if(match.wickets>=7)situation-=.10}const manager=clamp((match.battingAggression?.[match.battingTeam.id]??50)/100,0,1);return clamp(.24*(p.aggression/100)+.26*clamp(situation,.10,.98)+.50*manager,.06,.99)}
function outcome(){const p=match.striker,b=match.currentBowler,a=aggression();let wp=clamp(.018+(b.bowlingSkill-70)*.00065-(p.batting-70)*.0004+Math.max(0,a-.55)*.065-Math.max(0,.28-a)*.012,.008,.13);if(Math.random()<wp)return{wicket:true,runs:0};const skill=clamp(.50+(p.batting-b.bowlingSkill)*.003+(p.power-70)*.0015,.28,.82),p6=clamp(.002+(a*a)*.135+(p.power-70)*.0010,.001,.19),p4=clamp(.022+a*.145+(p.batting-70)*.0008,.018,.22),p2=clamp(.19-a*.07+skill*.025,.10,.22),p3=clamp(.006+(1-Math.abs(a-.5)*2)*.018,.004,.024),p0=clamp(.38-a*.23-skill*.055,.07,.39),x=Math.random();let runs=1;if(x<p6)runs=6;else if(x<p6+p4)runs=4;else if(x<p6+p4+p2)runs=2;else if(x<p6+p4+p2+p3)runs=3;else if(x<p6+p4+p2+p3+p0)runs=0;return thriller({wicket:false,runs})}
function thriller(o){if(!match.target||state.settings.thrill<45)return o;const left=120-match.balls,need=match.target-match.score,bias=state.settings.thrill/100;if(left<=36&&need>0&&!o.wicket){const reqPerBall=need/Math.max(1,left);if(reqPerBall>.85&&Math.random()<.20*bias)o.runs=Math.max(o.runs,4);if(reqPerBall<.18&&o.runs>=4&&Math.random()<.25*bias)o.runs=Math.random()<.6?1:0}if(left<=12&&need>14&&!o.wicket&&Math.random()<.3*bias)o.runs=Math.max(o.runs,4);return o}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function setAutoStatus(text){if($("autoMatchStatus"))$("autoMatchStatus").textContent=text}
async function waitAutoGap(){let left=Math.ceil(AUTO_BALL_GAP_MS/1000);while(left>0&&match&&!match.completed){if(paused){setAutoStatus("PAUSED");await sleep(250);continue}setAutoStatus(`AUTO • NEXT DELIVERY IN ${left}s`);await sleep(1000);if(!paused)left--}}
function addCom(text,cls=""){match?.logs.push({text,cls,at:nowISO()});const e=$("commentaryFeed");if(e){e.innerHTML+=`<div class="com ${cls}">${esc(text)}</div>`;e.scrollTop=e.scrollHeight}if(match?.engineMode!=="server-v1"){playCricketSfx(cls||"ball");if(cls!=="system")setTimeout(()=>speakCommentary(text),430)}}
function splash(text){$("eventSplash").textContent=text;$("eventSplash").classList.add("show");setTimeout(()=>$("eventSplash").classList.remove("show"),1100)}
function stat(id){return state.playerStats[id]||(state.playerStats[id]={matches:0,runs:0,balls:0,wickets:0,conceded:0,fours:0,sixes:0,outs:0})}
function updateHUD(){
  if(!match)return;
  const overs=`${Math.floor(match.balls/6)}.${match.balls%6}`;
  const rr=match.balls?(match.score/(match.balls/6)).toFixed(2):"0.00";
  $("hudScore").textContent=`${match.score}-${match.wickets}`;
  $("hudOvers").textContent=`${overs} OVERS`;
  $("hudRate").textContent=`RUN RATE ${rr}`;
  $("hudStriker").textContent=(match.striker?.name||"—").toUpperCase();
  $("hudNon").textContent=(match.non?.name||"—").toUpperCase();
  $("hudStrikerRuns").textContent=`${match.batterRuns[match.striker?.id]||0} (${match.batterBalls[match.striker?.id]||0})`;
  if($("hudNonRuns"))$("hudNonRuns").textContent=`${match.batterRuns[match.non?.id]||0} (${match.batterBalls[match.non?.id]||0})`;
  $("hudBowler").textContent=(match.currentBowler?.name||"—").toUpperCase();
  const bid=match.currentBowler?.id;
  $("hudBowlingFigures").textContent=bid?`${match.bowlerRuns[bid]||0}-${0} (${Math.floor((match.bowlerBalls[bid]||0)/6)}.${(match.bowlerBalls[bid]||0)%6})`:"";
  $("lastBalls").innerHTML=match.lastBalls.slice(-6).map(x=>`<i>${x}</i>`).join("");
  $("activeRoleDisplay").textContent=state.localRole.toUpperCase();
  $("footerRole").textContent="ROLE: "+state.localRole.toUpperCase();
  if($("stageBatTeam"))$("stageBatTeam").textContent=(match.battingTeam?.name||"BAT").toUpperCase();
  if($("stageScore"))$("stageScore").textContent=`${match.score}/${match.wickets}`;
  if($("stageOvers"))$("stageOvers").textContent=`${overs} OV`;
  if($("stageRate"))$("stageRate").textContent=`CRR ${rr}`;
  if($("stageTarget"))$("stageTarget").textContent=match.target?`TARGET ${match.target}`:"1ST INNINGS";
  if($("stageThisOver"))$("stageThisOver").textContent=match.lastBalls.length?`THIS OVER ${match.lastBalls.slice(-6).join("  ")}`:"THIS OVER —";
  if(three?.syncTeams)three.syncTeams();
  renderManagerLiveDock()
}
async function ensureCurrentBowler(){
  if(!match||match.currentBowler||match.completed)return;if(state.localRole!=="host")return;
  setAutoStatus("WAITING FOR BOWLING MANAGER • UP TO 60s");
  match.currentBowler=await requestDecision("next_bowler",match.bowlingTeam,availableBowlers());match.pendingDecision=null;
  if(match.currentBowler)addCom(`${match.currentBowler.name} will bowl over ${Math.floor(match.balls/6)+1}.`,"system");await publishMatchState()
}
async function playBall(){if(!match||match.completed||ballLock||paused||state.localRole!=="host")return false;ballLock=true;try{
  if(!match.currentBowler)await ensureCurrentBowler();if(!match.currentBowler||paused||match.completed)return false;
  await refreshBattingAggressionFromCloud();setAutoStatus("AUTO • DELIVERY IN PROGRESS");updateHUD();const o=outcome(),no=`${Math.floor(match.balls/6)}.${match.balls%6+1}`,striker=match.striker,bowler=match.currentBowler;match.batterBalls[striker.id]=(match.batterBalls[striker.id]||0)+1;stat(striker.id).balls++;
  await animateDelivery(o);match.balls++;match.bowlerBalls[bowler.id]=(match.bowlerBalls[bowler.id]||0)+1;
  if(o.wicket){match.wickets++;stat(striker.id).outs++;stat(bowler.id).wickets++;match.lastBalls.push("W");addCom(`${no} ${bowler.name} to ${striker.name} — WICKET! The pressure brings a breakthrough.`,"wicket");splash("WICKET!");if(!inningsDone()){const opts=match.order.slice(match.nextIndex);setAutoStatus("WAITING FOR BATTING MANAGER • UP TO 60s");match.striker=await requestDecision("next_batter",match.battingTeam,opts);match.nextIndex=Math.max(match.nextIndex,match.order.indexOf(match.striker)+1);match.pendingDecision=null;addCom(`${match.striker.name} is the new batter.`,"system")}}
  else{match.score+=o.runs;match.batterRuns[striker.id]=(match.batterRuns[striker.id]||0)+o.runs;match.bowlerRuns[bowler.id]=(match.bowlerRuns[bowler.id]||0)+o.runs;stat(striker.id).runs+=o.runs;stat(bowler.id).conceded+=o.runs;if(o.runs===4)stat(striker.id).fours++;if(o.runs===6)stat(striker.id).sixes++;match.lastBalls.push(String(o.runs));if(o.runs===6){addCom(`${no} ${bowler.name} to ${striker.name} — SIX! Launched over the rope.`,"six");splash("SIX!")}else if(o.runs===4){addCom(`${no} ${bowler.name} to ${striker.name} — FOUR! Timed perfectly into the gap.`,"four");splash("FOUR!")}else if(o.runs===0)addCom(`${no} ${bowler.name} to ${striker.name} — Dot ball.`);else addCom(`${no} ${bowler.name} to ${striker.name} — ${o.runs} run${o.runs===1?"":"s"}.`);if(o.runs%2){const t=match.striker;match.striker=match.non;match.non=t}}
  if(match.balls%6===0&&!inningsDone()){const t=match.striker;match.striker=match.non;match.non=t;addCom(`End of over ${match.balls/6}: ${match.battingTeam.name} ${match.score}/${match.wickets}.`,"system");match.lastBowler=match.currentBowler.id;match.currentBowler=null;match.lastBalls=[]}
  updateHUD();await publishBallEvent(o,no);await publishMatchState();if(inningsDone())await endInnings();return true
}finally{ballLock=false}}
async function startAutoMatchLoop(){
  if(!match||match.completed||state.localRole!=="host")return;if(match.engineMode==="server-v1"&&match.room?.cloudId){setAutoStatus("SERVER AUTO • ONLINE ENGINE ACTIVE");startSpectatorPolling();return;}const token=++autoLoopToken;paused=false;setAutoStatus("AUTO PLAY ACTIVE • 5s BREAK BETWEEN DELIVERIES");
  while(token===autoLoopToken&&match&&!match.completed&&state.localRole==="host"){
    if(paused){setAutoStatus("PAUSED");await sleep(250);continue}
    if(!match.currentBowler){await ensureCurrentBowler();if(token!==autoLoopToken||paused||!match||match.completed)continue}
    await waitAutoGap();if(token!==autoLoopToken||paused||!match||match.completed)continue;
    await playBall()
  }
  if(match?.completed)setAutoStatus("MATCH COMPLETE")
}
function inningsDone(){return match.balls>=120||match.wickets>=10||(match.target&&match.score>=match.target)}
async function endInnings(){if(match.innings===1){match.first={team:match.battingTeam,score:match.score,wickets:match.wickets,balls:match.balls};addCom(`${match.battingTeam.name} finish ${match.score}/${match.wickets}.`,"system");const bt=match.bowlingTeam,bo=match.battingTeam;match.innings=2;match.target=match.score+1;match.score=0;match.wickets=0;match.balls=0;match.bowlerBalls={};match.bowlerRuns={};match.batterRuns={};match.batterBalls={};match.lastBowler=null;match.lastBalls=[];match.battingTeam=bt;match.bowlingTeam=bo;setInningsOrder();addCom(`${bt.name} need ${match.target} to win.`,"system");await publishMatchState()}else await finishMatch()}
async function finishMatch(){let result;if(match.score>=match.target)result=`${match.battingTeam.name} won by ${10-match.wickets} wickets.`;else if(match.score===match.first.score)result="TIE";else result=`${match.first.team.name} won by ${match.first.score-match.score} runs.`;const margin=Math.abs(match.first.score-match.score);if(result!=="TIE"&&margin<=4&&Math.random()*100<state.settings.tie)result="TIE";if(result==="TIE"){addCom("MATCH TIED — SUPER OVER!","system");splash("TIE!");await sleep(1300);return superOver()}match.completed=true;recordResult(result,false);addCom("MATCH OVER — "+result,"system");await completeCloudMatch(result,false)}
async function superOver(){match.superOverRound++;const a=simulateSO(match.a),b=simulateSO(match.b);addCom(`Super Over ${match.superOverRound}: ${match.a.name} ${a}/2, ${match.b.name} ${b}/2.`,"system");if(a===b&&match.superOverRound<4){addCom("SUPER OVER TIED — ANOTHER SUPER OVER!","system");return superOver()}const winner=a>b?match.a:match.b,result=`${winner.name} won in Super Over ${match.superOverRound}.`;match.completed=true;splash("SUPER OVER");recordResult(result,true);await completeCloudMatch(result,true)}
function simulateSO(team){let s=0,w=0;for(let i=0;i<6&&w<2;i++){const r=Math.random();if(r<.09)w++;else if(r<.28)s+=6;else if(r<.5)s+=4;else if(r<.75)s+=2;else s+=1}return s}
function recordResult(result,so){const r=match.room;for(const id of [...new Set([...lineupForTeam(match.a).xi,...lineupForTeam(match.b).xi])])stat(id).matches++;state.history.push({date:nowISO(),competitionId:r.tournamentId,fixtureId:r.fixtureId,a:match.a.name,b:match.b.name,first:`${match.first.score}/${match.first.wickets}`,second:`${match.score}/${match.wickets}`,firstBalls:match.first.balls,secondBalls:match.balls,result,superOver:so,tied:so,managerA:r.managerA,managerB:r.managerB});state.profile.points+=10;if(r.tournamentId&&r.fixtureId){const c=C(r.tournamentId),f=c?.fixtures.find(x=>x.id===r.fixtureId);if(f){f.status="completed";f.result=result}}r.status="completed";save()}
async function completeCloudMatch(result,so){localStorage.removeItem(ACTIVE_MATCH);autoLoopToken++;if(match.room.cloudId&&session)await api("/rest/v1/matches?id=eq."+match.room.cloudId,{method:"PATCH",body:JSON.stringify({status:"completed",result:{result,superOver:so,first:match.first,second:{score:match.score,wickets:match.wickets}},state:serializeMatch(),completed_at:nowISO(),updated_at:nowISO()})}).catch(()=>{})}
function serializeMatch(){
  if(!match)return{};
  const teams=[match.a,match.b].filter(Boolean),ids=[...new Set(teams.flatMap(t=>(lineupForTeam(t).xi||t.defaultXI||[])))];
  const enginePlayers=ids.map(id=>P(id)).filter(Boolean).map(p=>({id:p.id,name:p.name,role:p.role,batting:p.batting,power:p.power,aggression:p.aggression,bowlingSkill:p.bowlingSkill,fielding:p.fielding,composure:p.composure}));
  const lineups={},battingOrders={};for(const t of teams){const sub=lineupForTeam(t);lineups[t.id]=sub.xi||t.defaultXI||[];battingOrders[t.id]=sub.battingOrder||sub.xi||t.defaultXI||[]}
  const teamNames={};for(const t of teams)teamNames[t.id]=t.name;
  return{version:3,engineMode:match.engineMode||"browser",engineActive:!!match.engineActive,nextDeliveryAt:match.nextDeliveryAt||nowISO(),phase:match.completed?"completed":"live",innings:match.innings,score:match.score,wickets:match.wickets,balls:match.balls,target:match.target,battingTeam:match.battingTeam?.id,bowlingTeam:match.bowlingTeam?.id,order:(match.order||[]).map(p=>p?.id).filter(Boolean),striker:match.striker?.id,non:match.non?.id,nextIndex:match.nextIndex||2,bowler:match.currentBowler?.id,lastBowler:match.lastBowler,bowlerBalls:match.bowlerBalls||{},bowlerRuns:match.bowlerRuns||{},batterRuns:match.batterRuns||{},batterBalls:match.batterBalls||{},lastBalls:match.lastBalls||[],logs:(match.logs||[]).slice(-160),pendingDecision:match.pendingDecision,completed:!!match.completed,superOverRound:match.superOverRound||0,first:match.first?{team:match.first.team?.id||match.first.team,score:match.first.score,wickets:match.first.wickets,balls:match.first.balls}:null,battingAggression:match.battingAggression||{[match.a.id]:50,[match.b.id]:50},lineups,battingOrders,teamNames,enginePlayers,thrill:state.settings.thrill,tieChance:state.settings.tie}
}
function persistActiveMatchLocal(){if(match&&!match.completed)localStorage.setItem(ACTIVE_MATCH,JSON.stringify({room:match.room,state:serializeMatch(),savedAt:nowISO()}));else localStorage.removeItem(ACTIVE_MATCH)}
function restoreMatchObject(room,s){
  if(!room||!s||!s.battingTeam)return null;const a=T(room.teamA),b=T(room.teamB);if(!a||!b)return null;
  const battingTeam=T(s.battingTeam)||a,bowlingTeam=T(s.bowlingTeam)||(battingTeam.id===a.id?b:a);
  const restored={room,a,b,innings:+s.innings||1,battingTeam,bowlingTeam,score:+s.score||0,wickets:+s.wickets||0,balls:+s.balls||0,target:s.target==null?null:+s.target,first:s.first?{team:T(s.first.team)||a,score:+s.first.score||0,wickets:+s.first.wickets||0,balls:+s.first.balls||0}:null,order:(s.order||[]).map(P).filter(Boolean),striker:P(s.striker),non:P(s.non),nextIndex:+s.nextIndex||2,currentBowler:P(s.bowler),lastBowler:s.lastBowler||null,bowlerBalls:s.bowlerBalls||{},bowlerRuns:s.bowlerRuns||{},batterRuns:s.batterRuns||{},batterBalls:s.batterBalls||{},lastBalls:s.lastBalls||[],logs:s.logs||[],superOverRound:+s.superOverRound||0,pendingDecision:s.pendingDecision||null,completed:!!s.completed,battingAggression:s.battingAggression||{[a.id]:50,[b.id]:50},teamRowIds:{},engineMode:s.engineMode||"browser",engineActive:s.engineActive!==false,nextDeliveryAt:s.nextDeliveryAt||nowISO(),resultText:s.resultText||""};
  if(!restored.order.length){const sub=room.lineupA&&battingTeam.id===room.teamA?room.lineupA:room.lineupB&&battingTeam.id===room.teamB?room.lineupB:null;restored.order=((sub?.battingOrder||sub?.xi||battingTeam.defaultXI)||[]).map(P).filter(Boolean)}
  restored.striker=restored.striker||restored.order[0];restored.non=restored.non||restored.order[1];return restored
}
async function publishMatchState(){
  persistActiveMatchLocal();
  const canHost=state.localRole==="host"||serverRole==="admin";
  if(match?.room?.cloudId&&session&&canHost){
    await api("/rest/v1/matches?id=eq."+match.room.cloudId,{
      method:"PATCH",
      body:JSON.stringify({
        state:serializeMatch(),
        decision_timeout:ONLINE_MANAGER_TIMEOUT,
        updated_at:nowISO()
      })
    });
  }
}

async function publishBallEvent(o,no){if(match?.room?.cloudId&&session&&state.localRole==="host")await api("/rest/v1/match_events",{method:"POST",body:JSON.stringify({match_id:match.room.cloudId,ball_no:no,event_type:o.wicket?"wicket":o.runs===6?"six":o.runs===4?"four":"ball",payload:{runs:o.runs||0,wicket:!!o.wicket,score:match.score,wickets:match.wickets,balls:match.balls,text:match.logs.at(-1)?.text}})}).catch(()=>{})}

$("pauseBtn").addEventListener("click",()=>{paused=true;nav("pauseMenu")});qsa('[data-nav="liveMatch"]').forEach(b=>b.addEventListener("click",()=>{paused=false;if(match?.engineMode==="server-v1"&&match?.room?.cloudId)startSpectatorPolling();else if(state.localRole==="host"&&match&&!match.completed)startAutoMatchLoop()}));
$("tacticBowler").addEventListener("click",()=>renderTactics("bowler"));$("tacticBatting").addEventListener("click",()=>renderTactics("batting"));$("tacticIntent").addEventListener("click",()=>renderTactics("intent"));
function renderTactics(type="bowler"){$("tacticBowler").classList.toggle("selected",type==="bowler");$("tacticBatting").classList.toggle("selected",type==="batting");$("tacticIntent").classList.toggle("selected",type==="intent");if(!match){$("tacticsPanel").innerHTML='<div class="empty-state">No active match.</div>';return}if(type==="bowler"){const rows=availableBowlers().map(p=>`<div class="tactic-row actionable"><span>${esc(p.name)}</span><span>${((match.bowlerBalls[p.id]||0)/6).toFixed(1)}</span><span>${match.bowlerRuns[p.id]||0}</span><span>${p.ovr}</span><span>${esc(p.bowling)}</span><span>${85+Math.floor(Math.random()*15)}%</span><span>${35+Math.floor(Math.random()*60)}%</span><span>Strike</span></div>`).join("");$("tacticsPanel").innerHTML=`<div class="tactic-row header"><span>BOWLER</span><span>OVERS</span><span>RUNS</span><span>RATING</span><span>TYPE</span><span>STAMINA</span><span>CONF.</span><span>ARCHETYPE</span></div>${rows}`}else if(type==="batting"){const rest=match.order.slice(match.nextIndex);$("tacticsPanel").innerHTML=`<div class="tactic-row header"><span>BATTER</span><span>AVG</span><span>SR</span><span>RATING</span><span>TYPE</span><span>STAMINA</span><span>CONF.</span><span>ARCHETYPE</span></div>${rest.map(p=>`<div class="tactic-row actionable"><span>${esc(p.name)}</span><span>${(28+Math.random()*25).toFixed(2)}</span><span>${(115+Math.random()*55).toFixed(1)}</span><span>${p.ovr}</span><span>${p.hand}</span><span>100%</span><span>${35+Math.floor(Math.random()*60)}%</span><span>Attacker</span></div>`).join("")}`}else{$("tacticsPanel").innerHTML='<div class="panel"><h3>Team Intent</h3><p>Live batting aggression is controlled privately by the manager of the batting team. The Host and opposition cannot change it. The AI remains responsible for shot execution and outcomes.</p></div>'}}

function renderScorecard(){if(!match){$("scorecardContent").innerHTML='<div class="empty-state">No active match.</div>';return}$("scorecardContent").innerHTML=`<h3>${esc(match.battingTeam.name)} ${match.score}/${match.wickets}</h3><p>${match.logs.slice(-30).map(x=>esc(x.text)).join("<br>")}</p>`}

function computeTable(c){if(!c)return[];const rows=Object.fromEntries(c.teams.map(id=>[id,{team:T(id),p:0,w:0,l:0,t:0,pts:0,forRuns:0,forBalls:0,againstRuns:0,againstBalls:0}]));for(const h of state.history.filter(x=>x.competitionId===c.id)){const a=c.teams.find(id=>T(id).name===h.a),b=c.teams.find(id=>T(id).name===h.b);if(!a||!b)continue;const ar=+h.first.split("/")[0],br=+h.second.split("/")[0],ab=h.firstBalls||120,bb=h.secondBalls||120;rows[a].p++;rows[b].p++;rows[a].forRuns+=ar;rows[a].forBalls+=ab;rows[a].againstRuns+=br;rows[a].againstBalls+=bb;rows[b].forRuns+=br;rows[b].forBalls+=bb;rows[b].againstRuns+=ar;rows[b].againstBalls+=ab;if(h.result.includes(T(a).name)){rows[a].w++;rows[b].l++;rows[a].pts+=c.winPts}else if(h.result.includes(T(b).name)){rows[b].w++;rows[a].l++;rows[b].pts+=c.winPts}else{rows[a].t++;rows[b].t++;rows[a].pts+=c.tiePts;rows[b].pts+=c.tiePts}}return Object.values(rows).map(r=>({...r,nrr:(r.forBalls?r.forRuns/(r.forBalls/6):0)-(r.againstBalls?r.againstRuns/(r.againstBalls/6):0)})).sort((a,b)=>b.pts-a.pts||b.nrr-a.nrr)}
function renderPoints(){const c=currentComp();if(!c){$("pointsTableContent").innerHTML='<div class="empty-state">Create a competition first.</div>';return}const t=computeTable(c);$("pointsTableContent").innerHTML=`<table><thead><tr><th>#</th><th>TEAM</th><th>P</th><th>W</th><th>L</th><th>T/NR</th><th>NRR</th><th>PTS</th></tr></thead><tbody>${t.map((r,i)=>`<tr><td>${i+1}</td><td>${esc(r.team.name)}</td><td>${r.p}</td><td>${r.w}</td><td>${r.l}</td><td>${r.t}</td><td>${r.nrr.toFixed(3)}</td><td><b>${r.pts}</b></td></tr>`).join("")}</tbody></table>`}
function renderStats(){const arr=state.players.map(p=>({p,s:stat(p.id)}));const runs=[...arr].sort((a,b)=>b.s.runs-a.s.runs).slice(0,10),w=[...arr].sort((a,b)=>b.s.wickets-a.s.wickets).slice(0,10),six=[...arr].sort((a,b)=>b.s.sixes-a.s.sixes).slice(0,10);const draw=(el,list,key)=>$(el).innerHTML=list.map((x,i)=>`<div class="leader-row"><span class="rank">${i+1}</span><span><b>${esc(x.p.name)}</b><br><small class="muted">${esc(x.p.team)}</small></span><b>${x.s[key]}</b></div>`).join("");draw("runLeaders",runs,"runs");draw("wicketLeaders",w,"wickets");draw("sixLeaders",six,"sixes")}
function renderCareer(){$("careerMatches").textContent=state.history.length;$("careerTies").textContent=state.history.filter(h=>h.tied||h.result==="TIE").length;$("careerSO").textContent=state.history.filter(h=>h.superOver).length;$("careerManagerWins").textContent=state.history.filter(h=>h.managerA||h.managerB).length;$("careerHistory").innerHTML=state.history.length?`<table><thead><tr><th>DATE</th><th>MATCH</th><th>SCORES</th><th>RESULT</th></tr></thead><tbody>${[...state.history].reverse().map(h=>`<tr><td>${new Date(h.date).toLocaleDateString()}</td><td>${esc(h.a)} vs ${esc(h.b)}</td><td>${esc(h.first)} • ${esc(h.second)}</td><td>${esc(h.result)}</td></tr>`).join("")}</tbody></table>`:'<div class="empty-state">No completed matches yet.</div>'}

$("watchMatchBtn").addEventListener("click",()=>watchByCode($("watchCode").value.trim().toUpperCase()));
async function watchByCode(c){if(!c)return;if(cloudReady()){try{const rows=await api("/rest/v1/matches?share_code=eq."+encodeURIComponent(c)+"&select=*");if(!rows.length)return alert("Match not found.");const m=rows[0],prior=state.localRoom||{},keepManager=(state.localRole==="managerA"||state.localRole==="managerB")&&prior.cloudId===m.id;if(!keepManager)state.localRole="spectator";state.localRoom={...prior,id:m.id,cloudId:m.id,cloudTournamentId:m.tournament_id,teamA:m.team_a_local_id,teamB:m.team_b_local_id,shareCode:m.share_code,status:m.status,visibility:m.visibility,decisionTimer:ONLINE_MANAGER_TIMEOUT,liveState:m.state||{}};localStorage.setItem(SAVE,JSON.stringify(state));nav("liveMatch");syncSpectatorState(m);startSpectatorPolling()}catch(e){alert(e.message)}}else{const r=ensureLocalRoom();if(c!==r.shareCode)return alert("Local demo match code not found.");if(!(state.localRole==="managerA"||state.localRole==="managerB"))state.localRole="spectator";save();nav("liveMatch")}}
function renderLiveList(){$("liveMatchList").innerHTML=state.localRoom?`<div class="live-row"><b>${esc(T(state.localRoom.teamA)?.name)} vs ${esc(T(state.localRoom.teamB)?.name)}</b><span>${esc(state.localRoom.status)}</span><span>${esc(state.localRoom.shareCode)}</span><button data-watch-local>WATCH</button></div>`:'<div class="empty-state">No local live match yet.</div>';qs("[data-watch-local]")?.addEventListener("click",()=>watchByCode(state.localRoom.shareCode))}
function parseHash(){const m=location.hash.match(/#watch=([A-Z0-9-]+)/i);if(m){$("boot").classList.remove("active");$("app").classList.remove("hidden");$("watchCode").value=m[1].toUpperCase();nav("liveHub");setTimeout(()=>watchByCode(m[1].toUpperCase()),200)}}
async function startSpectatorPolling(){
  clearInterval(cloudPoll);
  cloudPoll=setInterval(async()=>{
    const r=state.localRoom;
    if(!r?.cloudId)return;
    try{
      const rows=await api("/rest/v1/matches?id=eq."+r.cloudId+"&select=*");
      const remote=rows?.[0];

      if(remote){
        r.status=remote.status;
        r.liveState=remote.state||{};
        syncSpectatorState(remote);

        if(state.localRole==="managerA"||state.localRole==="managerB")
          handleRemoteManagerDecision(remote.state?.pendingDecision);
      }

      const ev=await api(
        `/rest/v1/match_events?match_id=eq.${r.cloudId}&order=id.desc&limit=40&select=*`
      );

      const ordered=[...ev].reverse();
      const feed=$("commentaryFeed");
      if(feed){
        feed.innerHTML=ordered.map(
          e=>`<div class="com ${e.event_type}">${esc(e.payload?.text||e.event_type)}</div>`
        ).join("");
        feed.scrollTop=feed.scrollHeight;
      }

      if(ordered.length){
        const newest=Number(ordered[ordered.length-1].id);

        // Audio: do not replay a backlog for someone joining mid-match.
        if(lastAudioEventId===null){
          lastAudioEventId=(Number(remote?.state?.balls||0)<=1)?0:newest;
        }else{
          for(const e of ordered){
            if(Number(e.id)>Number(lastAudioEventId))audioFromEvent(e);
          }
          lastAudioEventId=newest;
        }

        // Visuals: a brand-new match starts at 0 so the first ball also animates.
        if(lastVisualEventId===null){
          lastVisualEventId=(Number(remote?.state?.balls||0)<=1)?0:newest;
        }

        let animatedFreshEvent=false;
        for(const e of ordered){
          if(Number(e.id)>Number(lastVisualEventId)
             && ["ball","four","six","wicket"].includes(e.event_type)){
            visualFromEvent(e);
            animatedFreshEvent=true;
          }
        }
        lastVisualEventId=newest;

        // Fallback: if score state advanced but the event feed missed the event,
        // animate the latest delivery once anyway.
        const rs=remote?.state||{};
        const progressKey=`${rs.innings||1}:${rs.balls||0}:${rs.score||0}:${rs.wickets||0}`;
        if(currentPage==="liveMatch"
           && document.visibilityState==="visible"
           && Number(rs.balls||0)>0
           && progressKey!==lastAnimatedProgressKey){
          if(!animatedFreshEvent){
            const lastBall=Array.isArray(rs.lastBalls)&&rs.lastBalls.length
              ? String(rs.lastBalls[rs.lastBalls.length-1])
              : "0";
            const wicket=lastBall==="W";
            const runs=wicket?0:Number(lastBall)||0;
            visualFromEvent({
              event_type:wicket?"wicket":runs===6?"six":runs===4?"four":"ball",
              payload:{runs,wicket}
            });
          }
          lastAnimatedProgressKey=progressKey;
        }
      }

      renderManagerLiveDock();
    }catch(err){
      console.warn("Live polling failed",err)
    }
  },1000);
}
function syncSpectatorState(m){
  const s=m.state||{},room=state.localRoom||match?.room;
  if(s.version>=3&&room){
    const restored=restoreMatchObject(room,s);if(restored)match=restored;
  }else if(!match){
    const a=T(m.team_a_local_id),b=T(m.team_b_local_id);match={room,a,b,battingTeam:T(s.battingTeam)||a,bowlingTeam:T(s.bowlingTeam)||b,score:s.score||0,wickets:s.wickets||0,balls:s.balls||0,target:s.target||null,striker:P(s.striker),non:P(s.non),currentBowler:P(s.bowler),lastBalls:s.lastBalls||[],batterRuns:{},batterBalls:{},bowlerRuns:{},bowlerBalls:{},logs:[],completed:s.completed}
  }else Object.assign(match,{score:s.score||0,wickets:s.wickets||0,balls:s.balls||0,target:s.target||null,battingTeam:T(s.battingTeam)||match.battingTeam,bowlingTeam:T(s.bowlingTeam)||match.bowlingTeam,striker:P(s.striker)||match.striker,non:P(s.non)||match.non,currentBowler:P(s.bowler)||match.currentBowler,lastBalls:s.lastBalls||[]});
  if(!s.pendingDecision){clearInterval(decisionTimerHandle);$("decisionModal")?.classList.add("hidden")}
  if(match?.completed)setAutoStatus("MATCH COMPLETE"+(match.resultText?" • "+match.resultText:""));
  else if(s.pendingDecision)setAutoStatus(s.pendingDecision.type==="next_bowler"?"WAITING FOR BOWLING MANAGER • 60s":"WAITING FOR BATTING MANAGER • 60s");
  else if(s.engineMode==="server-v1")setAutoStatus("SERVER AUTO • 5s BREAK BETWEEN DELIVERIES");
  updateHUD();initThree();renderManagerLiveDock()
}


function roleLabel(){
  if(serverRole==="admin")return "Administrator";
  if(serverRole==="checking")return "Checking account role…";
  if(serverRole==="unavailable")return "Cloud role unavailable";
  if(state.localRole==="managerA"||state.localRole==="managerB")return "Team Manager";
  return session?"Spectator":"Guest";
}
function profileDisplayName(){
  const n=(state.profile?.name||"").trim();
  if(n&&n!=="Guest")return n;
  return session?.user?.email?.split("@")[0]||"Guest";
}
function renderProfilePage(){
  if(!$("profileEmail"))return;
  const p=state.profile||{};
  const connected=!!session&&cloudReady();
  const display=profileDisplayName();

  $("profileEmail").textContent=session?.user?.email||"Not signed in";
  $("profileRole").textContent=roleLabel();
  $("profileCloudStatus").textContent=connected?"Connected & cloud-synced":"Local / not signed in";
  $("profileUserId").textContent=session?.user?.id||"—";
  $("profileConnectionBadge").textContent=connected?"CONNECTED":"LOCAL";
  $("profileConnectionBadge").classList.toggle("connected",connected);
  $("profileHeroAvatar").textContent=(display[0]||"G").toUpperCase();

  $("profileFullName").value=p.fullName||"";
  $("profileDisplayName").value=(p.name&&p.name!=="Guest")?p.name:"";
  $("profileManagerName").value=p.managerName||"";
  $("profileRegion").value=p.region||"";
  $("profileSyncBtn").disabled=!connected;
}
$("savePersonalDetails")?.addEventListener("click",async()=>{
  const display=$("profileDisplayName").value.trim();
  state.profile=state.profile||{};
  state.profile.fullName=$("profileFullName").value.trim();
  state.profile.name=display||session?.user?.email?.split("@")[0]||"Guest";
  state.profile.managerName=$("profileManagerName").value.trim();
  state.profile.region=$("profileRegion").value.trim();
  if(typeof state.profile.points!=="number")state.profile.points=0;
  save();
  if(session&&cloudReady()){
    try{await pushProfile();alert("Personal details saved and synced.");}
    catch(e){alert("Saved on this device. Cloud sync failed: "+e.message);}
  }else alert("Personal details saved on this device.");
  renderProfilePage();
});
$("profileSyncBtn")?.addEventListener("click",async()=>{
  if(!session||!cloudReady())return alert("Sign in to sync your profile.");
  try{await pushProfile();await pullProfile();await refreshServerRole();renderAll();alert("Profile synced.");}
  catch(e){alert(e.message);}
});

function cloudUI(ok=false){const on=!!session&&cloudReady();$("cloudBadge").textContent=on?"CLOUD SYNC":"LOCAL MODE";$("cloudBadge").classList.toggle("amber",!on);$("signedOutBox").classList.toggle("hidden",!!session);$("signedInBox").classList.toggle("hidden",!session);const adminSetupPanel=$("adminCloudSetup");if(adminSetupPanel)adminSetupPanel.classList.toggle("hidden",!(session&&serverRole==="admin"));if(session){$("signedEmail").textContent=session.user?.email||"Signed in";$("userName").textContent=profileDisplayName();const roleText=roleLabel();$("userState").textContent=roleText+" • Private cloud account";$("userAvatar").textContent=($("userName").textContent[0]||"G").toUpperCase()}else{$("userName").textContent=profileDisplayName();$("userState").textContent="Preview profile";$("userAvatar").textContent=($("userName").textContent[0]||"G").toUpperCase()}renderProfilePage()}
$("saveCloudConfig").addEventListener("click",()=>{localStorage.setItem(CFG,JSON.stringify({url:$("supabaseUrl").value.trim().replace(/\/$/,""),key:$("supabaseKey").value.trim()}));cloudUI();alert("Cloud configuration saved.")});
$("signUpBtn").addEventListener("click",async()=>{try{const email=$("authEmail").value.trim(),password=$("authPass").value;if(password.length<6)throw new Error("Password must be at least 6 characters.");const r=await api("/auth/v1/signup",{method:"POST",body:JSON.stringify({email,password})});if(r.access_token){session={access_token:r.access_token,refresh_token:r.refresh_token,user:r.user};localStorage.setItem(SESSION,JSON.stringify(session));await refreshServerRole();await pushProfile();renderAll()}else alert("Account created. Confirm your email if confirmation is enabled.")}catch(e){alert(e.message)}});
$("signInBtn").addEventListener("click",async()=>{try{const r=await api("/auth/v1/token?grant_type=password",{method:"POST",body:JSON.stringify({email:$("authEmail").value.trim(),password:$("authPass").value})});session={access_token:r.access_token,refresh_token:r.refresh_token,user:r.user};localStorage.setItem(SESSION,JSON.stringify(session));await pullProfile();await refreshServerRole();await discoverActiveHostMatch();renderAll()}catch(e){alert(e.message)}});
$("signOutBtn").addEventListener("click",()=>{session=null;serverRole=null;state.localRole="host";localStorage.setItem(SAVE,JSON.stringify(state));localStorage.removeItem(SESSION);renderAll()});$("syncNowBtn").addEventListener("click",()=>pushProfile().then(()=>alert("Synced.")).catch(e=>alert(e.message)));

$("thrillBias").addEventListener("input",()=>{state.settings.thrill=+$("thrillBias").value;$("thrillLabel").textContent=state.settings.thrill;save()});$("tieBias").addEventListener("input",()=>{state.settings.tie=+$("tieBias").value;$("tieLabel").textContent=state.settings.tie+"%";save()});$("defaultManagerTimeout").addEventListener("change",()=>{state.settings.timeout=+$("defaultManagerTimeout").value;save()});$("managerControl").addEventListener("change",()=>{state.settings.managerControl=$("managerControl").value==="on";save()});

async function loadCloudLiveMatches(){if(!cloudReady())return;try{const rows=await api("/rest/v1/matches?visibility=eq.public&status=in.(lobby,live)&order=created_at.desc&limit=20&select=*");$("liveMatchList").innerHTML=rows.map(m=>`<div class="live-row"><b>${esc(T(m.team_a_local_id)?.name||m.team_a_local_id)} vs ${esc(T(m.team_b_local_id)?.name||m.team_b_local_id)}</b><span>${esc(m.status)}</span><span>${esc(m.share_code)}</span><button data-cloud-watch="${m.share_code}">WATCH</button></div>`).join("")||'<div class="empty-state">No public matches.</div>';qsa("[data-cloud-watch]").forEach(b=>b.addEventListener("click",()=>watchByCode(b.dataset.cloudWatch)))}catch{}}

function initThree(){
  if(three)return;

  const canvas=$("threeCanvas");
  if(!canvas)return;

  const renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:"high-performance"});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.65));
  renderer.shadowMap.enabled=true;
  renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=1.12;

  const scene=new THREE.Scene();
  scene.background=new THREE.Color(0x8fb8cf);
  scene.fog=new THREE.FogExp2(0xa8c4d2,.0042);

  const camera=new THREE.PerspectiveCamera(43,1,.1,350);
  camera.position.set(0,10.8,28.5);
  camera.lookAt(0,1.15,-2.5);

  const hemi=new THREE.HemisphereLight(0xe9f7ff,0x244c26,2.35);
  scene.add(hemi);
  const sun=new THREE.DirectionalLight(0xfff5e5,4.4);
  sun.position.set(-24,39,22);
  sun.castShadow=true;
  sun.shadow.mapSize.set(1024,1024);
  sun.shadow.camera.left=-38;sun.shadow.camera.right=38;sun.shadow.camera.top=38;sun.shadow.camera.bottom=-38;
  scene.add(sun);

  // Shared low-poly geometry. V2 remains browser-native and self-contained.
  const GEO={
    head:new THREE.SphereGeometry(.25,14,10),
    neck:new THREE.CylinderGeometry(.105,.12,.22,8),
    chest:new THREE.BoxGeometry(.72,.82,.34),
    waist:new THREE.BoxGeometry(.58,.46,.30),
    upperArm:new THREE.CylinderGeometry(.095,.105,.58,8),
    foreArm:new THREE.CylinderGeometry(.075,.09,.55,8),
    hand:new THREE.SphereGeometry(.09,8,6),
    thigh:new THREE.CylinderGeometry(.12,.135,.72,8),
    shin:new THREE.CylinderGeometry(.09,.115,.68,8),
    shoe:new THREE.BoxGeometry(.22,.12,.42),
    helmet:new THREE.SphereGeometry(.285,14,8,0,Math.PI*2,0,Math.PI*.65),
    cap:new THREE.CylinderGeometry(.26,.27,.12,14),
    pad:new THREE.BoxGeometry(.16,.53,.12),
    glove:new THREE.BoxGeometry(.16,.14,.16),
    batBlade:new THREE.BoxGeometry(.20,1.08,.10),
    batHandle:new THREE.CylinderGeometry(.035,.045,.48,8)
  };

  const matte=(color,rough=.78)=>new THREE.MeshStandardMaterial({color,roughness:rough,metalness:.02});
  const white=matte(0xf0f1e8,.68), skin=matte(0xb97a55,.82), black=matte(0x15191f,.76), wood=matte(0xd8b472,.7);

  function teamColor(team,fallback=0x176fc0){try{return new THREE.Color(team?.accent||fallback)}catch{return new THREE.Color(fallback)}}
  function darker(c,f=.55){const x=c.clone();x.multiplyScalar(f);return x}

  // Procedural grass texture: original and lightweight.
  const grassCanvas=document.createElement("canvas");grassCanvas.width=512;grassCanvas.height=512;
  const gx=grassCanvas.getContext("2d");
  gx.fillStyle="#397d43";gx.fillRect(0,0,512,512);
  for(let y=0;y<512;y+=64){gx.fillStyle=(y/64)%2?"#3d8749":"#347541";gx.fillRect(0,y,512,64)}
  for(let i=0;i<3600;i++){
    const v=50+Math.floor(Math.random()*45);gx.fillStyle=`rgba(${25+Math.random()*20|0},${v+60},${30+Math.random()*20|0},.10)`;
    gx.fillRect(Math.random()*512,Math.random()*512,1,2+Math.random()*3);
  }
  const grassTex=new THREE.CanvasTexture(grassCanvas);grassTex.wrapS=grassTex.wrapT=THREE.RepeatWrapping;grassTex.repeat.set(5,5);grassTex.colorSpace=THREE.SRGBColorSpace;
  const ground=new THREE.Mesh(new THREE.CircleGeometry(54,96),new THREE.MeshStandardMaterial({map:grassTex,roughness:1}));
  ground.rotation.x=-Math.PI/2;ground.position.y=-.035;ground.receiveShadow=true;scene.add(ground);

  // Pitch texture with wear and crease markings.
  const pc=document.createElement("canvas");pc.width=256;pc.height=1024;const px=pc.getContext("2d");
  px.fillStyle="#c9a66e";px.fillRect(0,0,256,1024);
  for(let i=0;i<1100;i++){const a=.03+Math.random()*.08;px.fillStyle=`rgba(83,62,36,${a})`;px.fillRect(Math.random()*256,Math.random()*1024,1+Math.random()*3,4+Math.random()*18)}
  px.strokeStyle="rgba(255,255,255,.94)";px.lineWidth=5;
  for(const y of[84,142,882,940]){px.beginPath();px.moveTo(12,y);px.lineTo(244,y);px.stroke()}
  px.lineWidth=3;for(const x of[58,198]){px.beginPath();px.moveTo(x,55);px.lineTo(x,170);px.stroke();px.beginPath();px.moveTo(x,854);px.lineTo(x,969);px.stroke()}
  const pitchTex=new THREE.CanvasTexture(pc);pitchTex.colorSpace=THREE.SRGBColorSpace;
  const pitch=new THREE.Mesh(new THREE.BoxGeometry(4.35,.10,22.1),new THREE.MeshStandardMaterial({map:pitchTex,roughness:.93}));
  pitch.position.y=.025;pitch.castShadow=false;pitch.receiveShadow=true;scene.add(pitch);

  // Boundary rope.
  const boundary=new THREE.Mesh(new THREE.TorusGeometry(45,.10,8,160),new THREE.MeshStandardMaterial({color:0xf6f1db,roughness:.65}));
  boundary.rotation.x=Math.PI/2;boundary.position.y=.06;scene.add(boundary);

  // Stadium bowl and seats.
  const lowerStand=new THREE.Mesh(new THREE.RingGeometry(49,61,96,1),new THREE.MeshStandardMaterial({color:0x253641,side:THREE.DoubleSide,roughness:.9}));
  lowerStand.rotation.x=-Math.PI/2;lowerStand.position.y=2.35;scene.add(lowerStand);
  const upperStand=new THREE.Mesh(new THREE.RingGeometry(55,65,96,1),new THREE.MeshStandardMaterial({color:0x17242d,side:THREE.DoubleSide,roughness:.9}));
  upperStand.rotation.x=-Math.PI/2;upperStand.position.y=5.3;scene.add(upperStand);

  // Crowd as low-cost colored points.
  const crowdCount=900,crowdPos=new Float32Array(crowdCount*3),crowdCol=new Float32Array(crowdCount*3);
  const crowdPalette=[new THREE.Color(0xffffff),new THREE.Color(0x2a78c5),new THREE.Color(0xd64c43),new THREE.Color(0xf0bd36),new THREE.Color(0x43a66c)];
  for(let i=0;i<crowdCount;i++){
    const a=Math.random()*Math.PI*2,r=51+Math.random()*11,h=1.2+Math.random()*5.2;
    crowdPos[i*3]=Math.cos(a)*r;crowdPos[i*3+1]=h;crowdPos[i*3+2]=Math.sin(a)*r;
    const c=crowdPalette[Math.floor(Math.random()*crowdPalette.length)];crowdCol.set([c.r,c.g,c.b],i*3);
  }
  const crowdGeo=new THREE.BufferGeometry();crowdGeo.setAttribute("position",new THREE.BufferAttribute(crowdPos,3));crowdGeo.setAttribute("color",new THREE.BufferAttribute(crowdCol,3));
  const crowd=new THREE.Points(crowdGeo,new THREE.PointsMaterial({size:.20,vertexColors:true,sizeAttenuation:true}));scene.add(crowd);

  // Advertising boards, all original Cricket Universe branding.
  function board(text,a){
    const c=document.createElement("canvas");c.width=512;c.height=96;const x=c.getContext("2d");x.fillStyle="#111824";x.fillRect(0,0,c.width,c.height);x.fillStyle="#38d6ef";x.font="900 35px Arial";x.textAlign="center";x.fillText(text,256,60);
    const tex=new THREE.CanvasTexture(c);tex.colorSpace=THREE.SRGBColorSpace;
    const m=new THREE.Mesh(new THREE.PlaneGeometry(8,1.5),new THREE.MeshBasicMaterial({map:tex,side:THREE.DoubleSide}));
    m.position.set(Math.cos(a)*46,1.0,Math.sin(a)*46);m.lookAt(0,1,0);scene.add(m)
  }
  for(let i=0;i<14;i++)board(i%2?"CRICKET UNIVERSE":"AI MANAGER CRICKET",i/14*Math.PI*2);

  // Sight screens.
  for(const z of[-48,48]){const s=new THREE.Mesh(new THREE.BoxGeometry(13,7,.4),white);s.position.set(0,3.3,z);scene.add(s)}

  // Floodlight towers.
  const towerMat=matte(0x495a65,.58),lampMat=new THREE.MeshStandardMaterial({color:0xffffff,emissive:0xf7f3d4,emissiveIntensity:3});
  for(const [x,z] of[[-43,-35],[43,-35],[-43,35],[43,35]]){
    const pole=new THREE.Mesh(new THREE.CylinderGeometry(.16,.28,18,8),towerMat);pole.position.set(x,8.8,z);scene.add(pole);
    const bank=new THREE.Mesh(new THREE.BoxGeometry(5.5,2,.35),towerMat);bank.position.set(x,17.3,z);bank.lookAt(0,6,0);scene.add(bank);
    for(let ix=-2;ix<=2;ix++)for(let iy=0;iy<2;iy++){const lamp=new THREE.Mesh(new THREE.SphereGeometry(.16,8,6),lampMat);lamp.position.copy(bank.position);lamp.position.x+=ix*.75;lamp.position.y+=(iy-.5)*.65;scene.add(lamp)}
  }

  function createRig(team,{batter=false,keeper=false,umpire=false,number=""}={}){
    const root=new THREE.Group();
    const primary=umpire?new THREE.Color(0xd64336):teamColor(team);
    const trousers=umpire?black:matte(darker(primary,.48));
    const shirt=umpire?matte(0xd73e36):matte(primary);
    const helmetMat=matte(darker(primary,.38),.5);

    const pelvis=new THREE.Group();pelvis.position.y=1.02;root.add(pelvis);
    const waist=new THREE.Mesh(GEO.waist,trousers);waist.position.y=.16;waist.castShadow=true;pelvis.add(waist);
    const chestPivot=new THREE.Group();chestPivot.position.y=.42;pelvis.add(chestPivot);
    const chest=new THREE.Mesh(GEO.chest,shirt);chest.position.y=.42;chest.castShadow=true;chestPivot.add(chest);
    const neck=new THREE.Mesh(GEO.neck,skin);neck.position.y=.95;chestPivot.add(neck);
    const headPivot=new THREE.Group();headPivot.position.y=1.13;chestPivot.add(headPivot);
    const head=new THREE.Mesh(GEO.head,skin);head.position.y=.17;head.castShadow=true;headPivot.add(head);

    if(umpire){
      const hat=new THREE.Mesh(new THREE.CylinderGeometry(.34,.34,.10,16),black);hat.position.y=.43;headPivot.add(hat);
      const brim=new THREE.Mesh(new THREE.CylinderGeometry(.47,.47,.035,16),black);brim.position.y=.36;headPivot.add(brim);
    }else if(batter||keeper){
      const helmet=new THREE.Mesh(GEO.helmet,helmetMat);helmet.position.y=.23;helmet.scale.set(1.05,1,1.05);headPivot.add(helmet);
      const grill=matte(0xcad0d4,.35);
      for(const x of[-.14,0,.14]){const bar=new THREE.Mesh(new THREE.CylinderGeometry(.012,.012,.42,6),grill);bar.position.set(x,.13,-.24);bar.rotation.x=Math.PI/2;headPivot.add(bar)}
    }else{
      const cap=new THREE.Mesh(GEO.cap,helmetMat);cap.position.y=.42;headPivot.add(cap);
      const brim=new THREE.Mesh(new THREE.BoxGeometry(.34,.025,.18),helmetMat);brim.position.set(0,.39,-.20);headPivot.add(brim)
    }

    function arm(side){
      const shoulder=new THREE.Group();shoulder.position.set(.45*side,.72,0);chestPivot.add(shoulder);
      const upper=new THREE.Mesh(GEO.upperArm,shirt);upper.position.y=-.29;upper.castShadow=true;shoulder.add(upper);
      const elbow=new THREE.Group();elbow.position.y=-.58;shoulder.add(elbow);
      const fore=new THREE.Mesh(GEO.foreArm,skin);fore.position.y=-.27;fore.castShadow=true;elbow.add(fore);
      const hand=new THREE.Group();hand.position.y=-.55;elbow.add(hand);
      const hm=new THREE.Mesh(keeper||batter?GEO.glove:GEO.hand,keeper||batter?white:skin);hm.castShadow=true;hand.add(hm);
      return{shoulder,elbow,hand}
    }
    const armL=arm(-1),armR=arm(1);

    function leg(side){
      const hip=new THREE.Group();hip.position.set(.19*side,.05,0);pelvis.add(hip);
      const thigh=new THREE.Mesh(GEO.thigh,trousers);thigh.position.y=-.36;thigh.castShadow=true;hip.add(thigh);
      const knee=new THREE.Group();knee.position.y=-.72;hip.add(knee);
      const shin=new THREE.Mesh(GEO.shin,trousers);shin.position.y=-.34;shin.castShadow=true;knee.add(shin);
      if(batter){const pad=new THREE.Mesh(GEO.pad,white);pad.position.set(0,-.30,-.09);knee.add(pad)}
      const foot=new THREE.Mesh(GEO.shoe,black);foot.position.set(0,-.72,-.10);foot.castShadow=true;knee.add(foot);
      return{hip,knee,foot}
    }
    const legL=leg(-1),legR=leg(1);

    let bat=null;
    if(batter){
      bat=new THREE.Group();
      const blade=new THREE.Mesh(GEO.batBlade,wood);blade.position.y=-.53;blade.castShadow=true;bat.add(blade);
      const handle=new THREE.Mesh(GEO.batHandle,black);handle.position.y=.26;bat.add(handle);
      bat.position.set(0,-.48,-.02);armR.hand.add(bat);
      bat.rotation.z=-.10;
    }

    root.userData={pelvis,chestPivot,headPivot,armL,armR,legL,legR,bat,baseY:0,uniform:{shirt,trousers,helmetMat},isUmpire:umpire};
    root.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true}});
    return root
  }

  const battingTeam=match?.battingTeam||match?.a,bowlingTeam=match?.bowlingTeam||match?.b;
  const batter=createRig(battingTeam,{batter:true});batter.position.set(0,0,-7.05);batter.rotation.y=Math.PI;scene.add(batter);
  const non=createRig(battingTeam,{batter:true});non.position.set(.72,0,6.7);scene.add(non);
  const bowler=createRig(bowlingTeam,{});bowler.position.set(0,0,15.4);bowler.rotation.y=Math.PI;scene.add(bowler);
  const keeper=createRig(bowlingTeam,{keeper:true});keeper.position.set(0,0,-9.55);scene.add(keeper);
  const umpire=createRig(null,{umpire:true});umpire.position.set(0,0,8.8);umpire.rotation.y=Math.PI;scene.add(umpire);

  const fieldPos=[[-12,-2],[-10,13],[11,14],[15,2],[-13,-15],[13,-14],[-27,8],[27,9],[-26,-10]];
  const fielders=fieldPos.map((p)=>{const f=createRig(bowlingTeam,{});f.position.set(p[0],0,p[1]);f.rotation.y=Math.atan2(-p[0],-p[1]);scene.add(f);return f});

  // Stumps + bails at both ends.
  const stumpMat=matte(0xf4e5b8,.55),stumps=[];
  for(const z of[-8.12,8.12]){
    const end=[];
    for(const x of[-.20,0,.20]){const s=new THREE.Mesh(new THREE.CylinderGeometry(.035,.035,.86,8),stumpMat);s.position.set(x,.43,z);s.castShadow=true;scene.add(s);end.push(s)}
    const bail1=new THREE.Mesh(new THREE.CylinderGeometry(.018,.018,.35,8),stumpMat);bail1.rotation.z=Math.PI/2;bail1.position.set(-.10,.89,z);bail1.userData.home=bail1.position.clone();scene.add(bail1);
    const bail2=bail1.clone();bail2.position.x=.10;bail2.userData.home=bail2.position.clone();scene.add(bail2);end.push(bail1,bail2);stumps.push(end)
  }

  const ball=new THREE.Mesh(new THREE.SphereGeometry(.115,14,10),new THREE.MeshStandardMaterial({color:0xa91429,roughness:.42,metalness:.02}));
  ball.castShadow=true;ball.position.set(0,1.9,14.6);scene.add(ball);

  // Radar dots are DOM so they remain crisp and cheap.
  const radar=$("fieldRadar");if(radar){radar.querySelectorAll("i").forEach(x=>x.remove());fieldPos.forEach((p,i)=>{const d=document.createElement("i");d.className="radar-dot";d.style.left=(50+p[0]*1.35)+"%";d.style.top=(50-p[1]*1.10)+"%";radar.appendChild(d)});const b=document.createElement("i");b.className="radar-dot radar-batter";b.style.left="50%";b.style.top="59%";radar.appendChild(b)}

  const cameraPresets={
    broadcast:{pos:new THREE.Vector3(0,10.8,28.5),look:new THREE.Vector3(0,1.1,-2.8),fov:43,label:"BROADCAST CAM"},
    bowler:{pos:new THREE.Vector3(0,5.7,23.0),look:new THREE.Vector3(0,1,-5.0),fov:37,label:"BOWLER CAM"},
    batter:{pos:new THREE.Vector3(8.4,4.0,-1.5),look:new THREE.Vector3(0,1,-7),fov:42,label:"BATTER CAM"},
    wide:{pos:new THREE.Vector3(22,19,28),look:new THREE.Vector3(0,0,0),fov:49,label:"FIELD CAM"},
    wicket:{pos:new THREE.Vector3(7.8,3.4,-11),look:new THREE.Vector3(0,1,-8),fov:38,label:"WICKET CAM"}
  };

  function resize(){const r=canvas.parentElement.getBoundingClientRect();renderer.setSize(Math.max(1,r.width),Math.max(1,r.height),false);camera.aspect=Math.max(.1,r.width/Math.max(1,r.height));camera.updateProjectionMatrix()}
  addEventListener("resize",resize);resize();

  let clock=0;
  (function renderLoop(){requestAnimationFrame(renderLoop);clock+=.012;crowd.rotation.y=Math.sin(clock*.08)*.002;renderer.render(scene,camera)})();

  function recolorRig(rig,team){
    if(!rig?.userData?.uniform||rig.userData.isUmpire)return;
    const c=teamColor(team),d=darker(c,.48);
    rig.userData.uniform.shirt.color.copy(c);
    rig.userData.uniform.trousers.color.copy(d);
    rig.userData.uniform.helmetMat.color.copy(darker(c,.38));
  }
  function syncTeams(){
    const key=(match?.battingTeam?.id||"")+"|"+(match?.bowlingTeam?.id||"");
    if(three?.teamKey===key)return;
    recolorRig(batter,match?.battingTeam);recolorRig(non,match?.battingTeam);
    recolorRig(bowler,match?.bowlingTeam);recolorRig(keeper,match?.bowlingTeam);fielders.forEach(f=>recolorRig(f,match?.bowlingTeam));
    if(three)three.teamKey=key;
  }
  three={scene,camera,renderer,batter,non,bowler,keeper,umpire,fielders,fieldPos,ball,stumps,cameraPresets,cameraHome:cameraPresets.broadcast,createRig,recolorRig,syncTeams,teamKey:(match?.battingTeam?.id||"")+"|"+(match?.bowlingTeam?.id||"")};
  setCameraPreset("broadcast",0);
}

function tweenVector3(obj,prop,to,ms,onFrame){
  const from=obj[prop].clone(),start=performance.now();
  return new Promise(resolve=>{function frame(now){const raw=Math.min(1,(now-start)/Math.max(1,ms)),p=raw<.5?2*raw*raw:1-Math.pow(-2*raw+2,2)/2;obj[prop].lerpVectors(from,to,p);if(onFrame)onFrame(p,raw);if(raw<1)requestAnimationFrame(frame);else resolve()}requestAnimationFrame(frame)})
}
function tweenPosition(obj,to,ms,onFrame){return tweenVector3(obj,"position",to,ms,onFrame)}
function animatePose(duration,onFrame){const start=performance.now();return new Promise(resolve=>{function frame(now){const p=Math.min(1,(now-start)/Math.max(1,duration));onFrame(p);if(p<1)requestAnimationFrame(frame);else resolve()}requestAnimationFrame(frame)})}
function easeInOut(p){return p<.5?2*p*p:1-Math.pow(-2*p+2,2)/2}

function resetRig(h){
  if(!h?.userData)return;
  const u=h.userData;
  h.rotation.z=0;h.position.y=u.baseY||0;
  u.pelvis.rotation.set(0,0,0);u.chestPivot.rotation.set(0,0,0);u.headPivot.rotation.set(0,0,0);
  for(const a of[u.armL,u.armR]){a.shoulder.rotation.set(0,0,0);a.elbow.rotation.set(0,0,0);a.hand.rotation.set(0,0,0)}
  for(const l of[u.legL,u.legR]){l.hip.rotation.set(0,0,0);l.knee.rotation.set(0,0,0)}
  if(u.bat){u.bat.rotation.set(0,0,-.10);u.bat.position.set(0,-.48,-.02)}
}

function runCycle(h,phase,intensity=1){
  const u=h.userData,s=Math.sin(phase)*intensity,c=Math.cos(phase)*intensity;
  u.armL.shoulder.rotation.x=s*.85;u.armR.shoulder.rotation.x=-s*.85;
  u.armL.elbow.rotation.x=-.25-Math.max(0,-s)*.7;u.armR.elbow.rotation.x=-.25-Math.max(0,s)*.7;
  u.legL.hip.rotation.x=-s*.72;u.legR.hip.rotation.x=s*.72;
  u.legL.knee.rotation.x=Math.max(0,s)*.85;u.legR.knee.rotation.x=Math.max(0,-s)*.85;
  u.chestPivot.rotation.x=-.06;u.chestPivot.rotation.z=c*.035;
}

function setCameraPreset(name,ms=500){
  if(!three)return Promise.resolve();
  const p=three.cameraPresets[name]||three.cameraPresets.broadcast;
  if($("cameraLabel"))$("cameraLabel").textContent=p.label;
  three.camera.fov=p.fov;three.camera.updateProjectionMatrix();
  if(ms<=0){three.camera.position.copy(p.pos);three.camera.lookAt(p.look);return Promise.resolve()}
  const fromPos=three.camera.position.clone(),fromLook=three.camera.userData.look?.clone()||p.look.clone(),start=performance.now();
  three.camera.userData.look=fromLook.clone();
  return new Promise(resolve=>{function frame(now){const raw=Math.min(1,(now-start)/ms),e=easeInOut(raw);three.camera.position.lerpVectors(fromPos,p.pos,e);three.camera.userData.look.lerpVectors(fromLook,p.look,e);three.camera.lookAt(three.camera.userData.look);if(raw<1)requestAnimationFrame(frame);else resolve()}requestAnimationFrame(frame)})
}

function setDeliveryInfo(text){if($("deliveryInfo"))$("deliveryInfo").textContent=text}

async function animateDelivery(o){
  initThree();const t=three;if(!t)return;
  const bowler=t.bowler,batter=t.batter,keeper=t.keeper,non=t.non;
  [bowler,batter,keeper,non,...t.fielders].forEach(resetRig);
  for(const end of t.stumps||[])for(const bail of end.slice(3)){if(bail.userData.home)bail.position.copy(bail.userData.home);bail.rotation.set(0,0,Math.PI/2)}
  if(t.syncTeams)t.syncTeams();
  bowler.position.set(0,0,15.4);batter.position.set(0,0,-7.05);non.position.set(.72,0,6.7);keeper.position.set(0,0,-9.55);
  t.fielders.forEach((f,i)=>{const p=t.fieldPos[i];f.position.set(p[0],0,p[1])});
  t.ball.visible=true;t.ball.position.set(0,1.85,14.6);
  setDeliveryInfo((match?.currentBowler?.name||"BOWLER").toUpperCase()+" • RUN-UP");
  await setCameraPreset("bowler",420);

  // Bowler run-up.
  await tweenPosition(bowler,new THREE.Vector3(0,0,9.25),1250,(_e,raw)=>{runCycle(bowler,raw*Math.PI*7,1);bowler.position.y=Math.abs(Math.sin(raw*Math.PI*7))*.055});

  // Gather + delivery stride.
  await animatePose(620,p=>{
    const u=bowler.userData,s=Math.sin(p*Math.PI);
    bowler.position.y=s*.36;bowler.position.z=9.25-1.15*p;
    u.legL.hip.rotation.x=.7-1.05*p;u.legR.hip.rotation.x=-.45+.72*p;
    u.legL.knee.rotation.x=.40*(1-p);u.chestPivot.rotation.x=-.18+.44*p;u.chestPivot.rotation.z=.16*Math.sin(p*Math.PI);
    u.armR.shoulder.rotation.x=-1.5+3.7*p;u.armR.elbow.rotation.x=-.18+.4*p;u.armL.shoulder.rotation.x=.75-1.35*p;u.headPivot.rotation.x=-.06+.12*p
  });
  bowler.position.y=0;
  setDeliveryInfo("BALL RELEASED");

  // Ball flight to bounce.
  const startBall=t.ball.position.clone(),bounce=new THREE.Vector3((Math.random()-.5)*.42,.10,-3.3),release=new THREE.Vector3(.08,2.05,8.15);
  t.ball.position.copy(release);
  await tweenPosition(t.ball,bounce,560,(_e,raw)=>{t.ball.position.y+=Math.sin(raw*Math.PI)*.42});
  const contact=new THREE.Vector3((Math.random()-.5)*.18,.72,-6.78);
  await tweenPosition(t.ball,contact,260,(_e,raw)=>{t.ball.position.y+=Math.sin(raw*Math.PI)*.20});

  // Batter footwork + shot. Different shot families by outcome.
  const shot=o.wicket?"MISS":o.runs===6?"LOFTED DRIVE":o.runs===4?"ATTACKING DRIVE":o.runs===0?"DEFENCE":o.runs>=2?"PLACED SHOT":"NUDGE";
  setDeliveryInfo(shot);
  await setCameraPreset(o.wicket?"wicket":"batter",260);
  await animatePose(o.wicket?420:520,p=>{
    const u=batter.userData,back=Math.min(1,p/.30),through=Math.max(0,(p-.28)/.72);
    u.legL.hip.rotation.x=.15*through;u.legR.hip.rotation.x=-.10*through;u.legL.knee.rotation.x=.10*through;
    u.pelvis.rotation.y=-.18*through;u.chestPivot.rotation.y=-.45*through;u.chestPivot.rotation.z=-.08*through;
    u.armR.shoulder.rotation.x=-.30-1.45*through;u.armL.shoulder.rotation.x=-.18-1.20*through;
    u.armR.shoulder.rotation.z=.22+.42*through;u.armL.shoulder.rotation.z=-.18-.34*through;
    u.armR.elbow.rotation.x=-.28-.45*through;u.armL.elbow.rotation.x=-.24-.35*through;
    if(u.bat)u.bat.rotation.z=-.10-.72*back+2.45*through;
  });

  if(o.wicket){
    setDeliveryInfo("WICKET");
    await Promise.all([
      tweenPosition(t.ball,new THREE.Vector3(0,.43,-8.10),330),
      animatePose(440,p=>{const u=keeper.userData;keeper.position.z=-9.55+.85*p;u.legL.hip.rotation.x=.35*(1-p);u.legR.hip.rotation.x=.35*(1-p);u.armL.shoulder.rotation.x=-.8*p;u.armR.shoulder.rotation.x=-.8*p;batter.userData.headPivot.rotation.y=.45*p})
    ]);
    // Bails fly.
    const end=t.stumps[0];if(end){end.slice(3).forEach((b,i)=>{b.position.y+=.45;b.position.x+=(i?1:-1)*.26;b.rotation.z+=.9})}
    await new Promise(r=>setTimeout(r,500));
  }else if(o.runs===0){
    // Keeper takes the ball.
    await Promise.all([tweenPosition(t.ball,new THREE.Vector3(.10,1.03,-9.25),420),animatePose(420,p=>{const u=keeper.userData;u.legL.hip.rotation.x=.34;u.legR.hip.rotation.x=.34;u.armL.shoulder.rotation.x=-.85*p;u.armR.shoulder.rotation.x=-.85*p})]);
  }else{
    const boundary=o.runs>=4;
    const angle=(Math.random()*.95-.475)+(o.runs===6?(Math.random()<.5?1.15:-1.15):0);
    const dist=o.runs===6?44:o.runs===4?43:o.runs===3?25:o.runs===2?19:14;
    const target=new THREE.Vector3(Math.sin(angle)*dist,o.runs===6?1.4:.14,-7-Math.cos(angle)*dist);
    const nearest=t.fielders.reduce((a,b)=>a.position.distanceTo(target)<b.position.distanceTo(target)?a:b);
    setDeliveryInfo(boundary?(o.runs===6?"SIX • INTO THE STANDS":"FOUR • RACING AWAY"):`${o.runs} RUN${o.runs===1?"":"S"}`);
    if(boundary)await setCameraPreset("wide",300);

    const fielderTarget=target.clone().multiplyScalar(boundary?.72:.88);fielderTarget.y=0;
    const chase=tweenPosition(nearest,fielderTarget,boundary?1450:950,(_e,raw)=>{nearest.lookAt(target.x,0,target.z);runCycle(nearest,raw*Math.PI*8,.9)});
    const flight=tweenPosition(t.ball,target,boundary?1450:950,(_e,raw)=>{if(o.runs===6)t.ball.position.y+=Math.sin(raw*Math.PI)*9.0;else if(o.runs===4)t.ball.position.y+=Math.sin(raw*Math.PI)*1.0;else t.ball.position.y+=Math.sin(raw*Math.PI)*.35});

    // Batters run on 1/2/3. One visual crossing is enough to communicate running.
    const runners=o.runs>0&&o.runs<4?Promise.all([
      tweenPosition(batter,new THREE.Vector3(.35,0,5.55),880,(_e,raw)=>runCycle(batter,raw*Math.PI*6,.75)),
      tweenPosition(non,new THREE.Vector3(-.35,0,-5.65),880,(_e,raw)=>runCycle(non,raw*Math.PI*6,.75))
    ]):Promise.resolve();
    await Promise.all([chase,flight,runners]);

    if(!boundary){
      // Fielder pickup / return throw.
      await animatePose(260,p=>{nearest.userData.chestPivot.rotation.x=.55*p;nearest.userData.legL.knee.rotation.x=.45*p;nearest.userData.legR.knee.rotation.x=.45*p});
      await tweenPosition(t.ball,new THREE.Vector3(0,1.0,-8.0),420,(_e,raw)=>{t.ball.position.y+=Math.sin(raw*Math.PI)*3.2});
    }
  }

  await new Promise(r=>setTimeout(r,260));
  setDeliveryInfo("5s BREAK • NEXT DELIVERY SOON");
  await setCameraPreset("broadcast",420);
  [bowler,batter,keeper,non,...t.fielders].forEach(resetRig);
}
function renderAll(){state.settings.timeout=ONLINE_MANAGER_TIMEOUT;renderPlayers();renderTeams();renderLineups();renderTournamentSelect();renderTournamentDashboard();renderMatchRoom();renderManagerHub();renderLiveList();renderPoints();renderStats();renderCareer();cloudUI();renderProfilePage();$("careerPoints").textContent=state.profile.points;$("thrillBias").value=state.settings.thrill;$("thrillLabel").textContent=state.settings.thrill;$("tieBias").value=state.settings.tie;$("tieLabel").textContent=state.settings.tie+"%";$("defaultManagerTimeout").value=ONLINE_MANAGER_TIMEOUT;$("managerControl").value=state.settings.managerControl?"on":"off";const resume=$("resumeLiveMatchTile");if(resume)resume.classList.toggle("hidden",!(match&&!match.completed&&state.localRole==="host"));const c=getCfg();$("supabaseUrl").value=c.url||"";$("supabaseKey").value=c.key||"";$("localRole").value=state.localRole}
if(session&&cloudReady()){
  state.localRole="spectator";
  serverRole="checking";
}
renderAll();
renderAudioButtons();
parseHash();

if(session&&cloudReady()){
  (async()=>{
    try{
      await refreshAuthSession(false);
      await pullProfile();
      await refreshServerRole();
      await discoverActiveHostMatch();
      renderAll();
    }catch(e){
      console.warn("Cloud startup refresh failed:",e);
      if(session)serverRole="unavailable";
      renderAll();
    }
  })();

  loadCloudLiveMatches();
  startRoomPolling();

  // Keep long-running manager/admin sessions healthy.
  setInterval(async()=>{
    if(!session||!cloudReady())return;
    try{
      await refreshAuthSession(false);
      await refreshServerRole();
      renderAll();
    }catch{}
  },300000);

  document.addEventListener("visibilitychange",async()=>{
    if(document.visibilityState!=="visible"||!session||!cloudReady())return;
    try{
      await refreshAuthSession(false);
      await refreshServerRole();
      renderAll();
    }catch{}
  });
}
