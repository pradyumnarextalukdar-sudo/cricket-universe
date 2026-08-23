let THREE=null;
let GLTFLoader=null;
let cloneSkeleton=null;
let retargetClip=null;
let cuThreeModulesPromise=null;
let cuInitThreePromise=null;

/*
  V4.0.2 stability architecture:
  Game/menu JavaScript starts WITHOUT loading the 3D engine.
  Three.js is fetched lazily only when the live 3D match screen is opened.
  Therefore a model/CDN/Three.js failure cannot disable normal website buttons.
*/
function cuEnsureThreeModules(){
  if(THREE&&GLTFLoader&&cloneSkeleton)return Promise.resolve();
  if(cuThreeModulesPromise)return cuThreeModulesPromise;

  cuThreeModulesPromise=Promise.all([
    import("three"),
    import("https://cdn.jsdelivr.net/npm/three@0.178.0/examples/jsm/loaders/GLTFLoader.js"),
    import("https://cdn.jsdelivr.net/npm/three@0.178.0/examples/jsm/utils/SkeletonUtils.js")
  ]).then(([threeMod,loaderMod,skeletonMod])=>{
    THREE=threeMod;
    GLTFLoader=loaderMod.GLTFLoader;
    cloneSkeleton=skeletonMod.clone;
    retargetClip=skeletonMod.retargetClip;

    if(!THREE || !GLTFLoader || !cloneSkeleton || !retargetClip){
      throw new Error("Required Three.js modules did not initialize.");
    }
  }).catch(err=>{
    cuThreeModulesPromise=null;
    throw err;
  });

  return cuThreeModulesPromise;
}

const CU_VITRUVIAN_BODY_URL =
  "https://cdn.jsdelivr.net/gh/ibrews/VitruvianGodot@main/godot_project/vitruvian_body.glb";
const CU_VITRUVIAN_HEAD_URL =
  "https://cdn.jsdelivr.net/gh/ibrews/VitruvianGodot@main/godot_project/vitruvian_head.glb";

const CU_M2M_BASE_ANIM_URL =
  "https://cdn.jsdelivr.net/gh/Mesh2Motion/mesh2motion-app@main/static/animations/human-base-animations.glb";
const CU_M2M_ADDON_ANIM_URL =
  "https://cdn.jsdelivr.net/gh/Mesh2Motion/mesh2motion-app@main/static/animations/human-addon-animations.glb";

let cuCharacterTemplatePromise=null;
let cuRetargetedMotionPromise=null;

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
function splash(text){
  $("eventSplash").textContent=text;
  $("eventSplash").classList.add("show");
  setTimeout(()=>$("eventSplash").classList.remove("show"),1100);
  const fx=$("refResultFx");
  if(fx){
    const raw=String(text||"").toUpperCase();
    fx.textContent=raw.includes("SIX")?"6":raw.includes("FOUR")?"4":raw.includes("WICKET")?"W":"";
    fx.className="ref-result-fx";
    if(raw.includes("SIX"))fx.classList.add("six");
    else if(raw.includes("FOUR"))fx.classList.add("four");
    else if(raw.includes("WICKET"))fx.classList.add("wicket");
    if(fx.textContent){
      void fx.offsetWidth;
      fx.classList.add("show");
      setTimeout(()=>fx.classList.remove("show"),1800);
    }
  }
}
function stat(id){return state.playerStats[id]||(state.playerStats[id]={matches:0,runs:0,balls:0,wickets:0,conceded:0,fours:0,sixes:0,outs:0})}
function updateHUD(){
  if(!match)return;
  $("hudScore").textContent=`${match.score}-${match.wickets}`;
  $("hudOvers").textContent=`${Math.floor(match.balls/6)}.${match.balls%6} OVERS`;
  $("hudRate").textContent=`RUN RATE ${match.balls?(match.score/(match.balls/6)).toFixed(2):"0.00"}`;
  $("hudStriker").textContent=(match.striker?.name||"—").toUpperCase();
  $("hudNon").textContent=(match.non?.name||"—").toUpperCase();
  $("hudStrikerRuns").textContent=`${match.batterRuns[match.striker?.id]||0} ${match.batterBalls[match.striker?.id]||0}`;
  $("hudBowler").textContent=(match.currentBowler?.name||"—").toUpperCase();

  const bid=match.currentBowler?.id;
  const figures=bid?`${match.bowlerRuns[bid]||0}-${0} (${((match.bowlerBalls[bid]||0)/6).toFixed(1)})`:"";
  $("hudBowlingFigures").textContent=figures;
  $("lastBalls").innerHTML=match.lastBalls.slice(-6).map(x=>`<i>${x}</i>`).join("");

  $("activeRoleDisplay").textContent=state.localRole.toUpperCase();
  $("footerRole").textContent="ROLE: "+state.localRole.toUpperCase();

  if($("refBatTeam"))$("refBatTeam").textContent=(match.battingTeam?.name||"BATTING XI").toUpperCase();
  if($("refBowlTeam"))$("refBowlTeam").textContent=(match.bowlingTeam?.name||"BOWLING XI").toUpperCase();
  if($("refBatScore"))$("refBatScore").textContent=`${match.score}/${match.wickets}`;
  if($("refOver"))$("refOver").textContent=`${Math.floor(match.balls/6)}.${match.balls%6} OV`;
  if($("refBowlerName"))$("refBowlerName").textContent=(match.currentBowler?.name||"—").toUpperCase();
  if($("refBowlerMini"))$("refBowlerMini").textContent=(match.currentBowler?.name||"BOWLER").toUpperCase();
  if($("refBowlerFigures"))$("refBowlerFigures").textContent=figures||"0-0";

  let needText="LIVE MATCH";
  if(match.innings===2&&match.target){
    const need=Math.max(0,match.target-match.score);
    const ballsLeft=Math.max(0,120-match.balls);
    needText=need>0?`NEED ${need} OFF ${ballsLeft}`:"TARGET REACHED";
  }
  if($("refNeed"))$("refNeed").textContent=needText;

  const last=(match.lastBalls||[]).slice(-6);
  if($("refBallDots")){
    $("refBallDots").innerHTML=Array.from({length:6},(_,i)=>{
      const val=last[i];
      const cls=val==="W"?"wicket":val==="6"?"six":val==="4"?"four":val!=null?"used":"";
      return `<i class="${cls}">${val??""}</i>`;
    }).join("");
  }
  if($("refDeliveryRail")){
    const history=(match.lastBalls||[]).slice(-12);
    $("refDeliveryRail").innerHTML=history.map(v=>{
      const cls=v==="W"?"wicket":v==="6"?"six":v==="4"?"four":"";
      return `<i class="${cls}">${esc(v)}</i>`;
    }).join("");
  }
  renderManagerLiveDock();
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


function cuAssetStatus(text,error=false){
  const el=$("graphicsStatus");
  if(!el)return;
  el.textContent=text;
  el.classList.toggle("error",!!error);
}

function cuCameraLabel(text){
  const el=$("broadcastCamBadge");
  if(el)el.textContent=text;
}

async function cuLoadCharacterTemplate(){
  if(cuCharacterTemplatePromise)return cuCharacterTemplatePromise;

  await cuEnsureThreeModules();
  const loader=new GLTFLoader();

  cuCharacterTemplatePromise=(async()=>{
    const [body,head,baseAnim,addonAnim]=await Promise.all([
      loader.loadAsync(CU_VITRUVIAN_BODY_URL),
      loader.loadAsync(CU_VITRUVIAN_HEAD_URL),
      loader.loadAsync(CU_M2M_BASE_ANIM_URL),
      loader.loadAsync(CU_M2M_ADDON_ANIM_URL)
    ]);

    return{
      body,
      head,
      animationPacks:[
        {scene:baseAnim.scene,clips:baseAnim.animations||[],label:"Mesh2Motion base"},
        {scene:addonAnim.scene,clips:addonAnim.animations||[],label:"Mesh2Motion addon"}
      ],
      source:"Vitruvian CC0 body/head + CC0 Mesh2Motion retargeted motion"
    };
  })().catch(err=>{
    cuCharacterTemplatePromise=null;
    throw err;
  });

  return cuCharacterTemplatePromise;
}

function cuBoneByAliases(root,aliases){
  const targets=aliases.map(x=>String(x).toLowerCase());
  let exact=null,partial=null;
  root.traverse(o=>{
    if(!o.isBone)return;
    const n=String(o.name||"").toLowerCase();
    if(!exact&&targets.includes(n))exact=o;
    if(!partial&&targets.some(a=>n.endsWith(a)||n.includes(a)))partial=o;
  });
  return exact||partial;
}

function cuBuildBoneMap(model){
  return{
    pelvis:cuBoneByAliases(model,[
      "pelvis","hips","hip","mixamorig:hips","root","root.x"
    ]),
    spine1:cuBoneByAliases(model,[
      "spine","spine_01","spine01","spine1","mixamorig:spine","torso"
    ]),
    spine2:cuBoneByAliases(model,[
      "spine_02","spine02","spine2","mixamorig:spine1","chest"
    ]),
    spine3:cuBoneByAliases(model,[
      "spine_03","spine03","spine3","mixamorig:spine2","upperchest"
    ]),
    neck:cuBoneByAliases(model,[
      "neck_01","neck01","neck","mixamorig:neck"
    ]),
    head:cuBoneByAliases(model,[
      "head","mixamorig:head"
    ]),

    clavL:cuBoneByAliases(model,[
      "clavicle_l","clavicle.l","shoulder01.l","shoulder_l",
      "leftshoulder","mixamorig:leftshoulder"
    ]),
    clavR:cuBoneByAliases(model,[
      "clavicle_r","clavicle.r","shoulder01.r","shoulder_r",
      "rightshoulder","mixamorig:rightshoulder"
    ]),

    upperL:cuBoneByAliases(model,[
      "upperarm_l","upperarm.l","upper_arm.l","upperarm01.l",
      "upperarm01_l","leftarm","mixamorig:leftarm"
    ]),
    upperR:cuBoneByAliases(model,[
      "upperarm_r","upperarm.r","upper_arm.r","upperarm01.r",
      "upperarm01_r","rightarm","mixamorig:rightarm"
    ]),
    lowerL:cuBoneByAliases(model,[
      "lowerarm_l","lowerarm.l","forearm.l","lower_arm.l",
      "lowerarm01.l","lowerarm01_l","leftforearm","mixamorig:leftforearm"
    ]),
    lowerR:cuBoneByAliases(model,[
      "lowerarm_r","lowerarm.r","forearm.r","lower_arm.r",
      "lowerarm01.r","lowerarm01_r","rightforearm","mixamorig:rightforearm"
    ]),
    handL:cuBoneByAliases(model,[
      "hand_l","hand.l","wrist.l","wrist_l","lefthand","mixamorig:lefthand"
    ]),
    handR:cuBoneByAliases(model,[
      "hand_r","hand.r","wrist.r","wrist_r","righthand","mixamorig:righthand"
    ]),

    thighL:cuBoneByAliases(model,[
      "thigh_l","thigh.l","upperleg_l","upperleg.l","upperleg01.l",
      "leftupleg","mixamorig:leftupleg"
    ]),
    thighR:cuBoneByAliases(model,[
      "thigh_r","thigh.r","upperleg_r","upperleg.r","upperleg01.r",
      "rightupleg","mixamorig:rightupleg"
    ]),
    calfL:cuBoneByAliases(model,[
      "calf_l","calf.l","lowerleg_l","lowerleg.l","lowerleg01.l",
      "leftleg","mixamorig:leftleg"
    ]),
    calfR:cuBoneByAliases(model,[
      "calf_r","calf.r","lowerleg_r","lowerleg.r","lowerleg01.r",
      "rightleg","mixamorig:rightleg"
    ]),
    footL:cuBoneByAliases(model,[
      "foot_l","foot.l","leftfoot","mixamorig:leftfoot"
    ]),
    footR:cuBoneByAliases(model,[
      "foot_r","foot.r","rightfoot","mixamorig:rightfoot"
    ])
  };
}

function cuTeamPalette(teamId){
  const palettes=[
    {shirt:0x214bd8,trim:0xf4d037,pants:0x17255f},
    {shirt:0xb3263e,trim:0xf6c445,pants:0x4a1020},
    {shirt:0x117d68,trim:0xe9e4ce,pants:0x0b4037},
    {shirt:0x692fa3,trim:0xf2c84b,pants:0x31164c},
    {shirt:0xd96716,trim:0x121926,pants:0x65300e},
    {shirt:0x0877a9,trim:0xf5f6f7,pants:0x0c344d}
  ];
  const seed=[...String(teamId||"team")].reduce((a,c)=>a+c.charCodeAt(0),0);
  return palettes[seed%palettes.length];
}

function cuStylePlayerMesh(model,palette,role){
  const clothHints=[
    "shirt","tshirt","t-shirt","top","cloth","clothes","clothing",
    "jersey","pants","trouser","short","fabric","suit"
  ];

  model.traverse(o=>{
    if(!o.isMesh)return;

    o.castShadow=true;
    o.receiveShadow=true;

    const materials=Array.isArray(o.material)?o.material:[o.material];
    const cloned=materials.map(original=>{
      if(!original)return original;
      const m=original.clone();

      if("roughness" in m)m.roughness=Math.max(.42,m.roughness??.55);
      if("metalness" in m)m.metalness=Math.min(.10,m.metalness??0);

      // Tint ONLY a material that appears to be clothing.
      // We deliberately do not put new geometry over the chest/arms/legs.
      const label=(
        String(original.name||"")+" "+
        String(o.name||"")
      ).toLowerCase();

      if(clothHints.some(h=>label.includes(h)) && m.color){
        const originalColor=m.color.clone();
        const teamColor=new THREE.Color(palette.shirt);

        // Preserve texture/material detail while nudging the garment
        // toward the team colour.
        originalColor.lerp(teamColor,.48);
        m.color.copy(originalColor);
      }

      return m;
    });

    o.material=Array.isArray(o.material)?cloned:cloned[0];
  });
}

function cuMakeCricketBat(){
  // Equipment only. This is NOT used as body/clothing geometry.
  const bat=new THREE.Group();

  const bladeShape=new THREE.Shape();
  bladeShape.moveTo(-.065,-.35);
  bladeShape.lineTo(.065,-.35);
  bladeShape.lineTo(.073,.22);
  bladeShape.lineTo(.050,.34);
  bladeShape.lineTo(-.050,.34);
  bladeShape.lineTo(-.073,.22);
  bladeShape.closePath();

  const bladeGeo=new THREE.ExtrudeGeometry(bladeShape,{
    depth:.038,
    bevelEnabled:true,
    bevelThickness:.008,
    bevelSize:.007,
    bevelSegments:2
  });
  bladeGeo.center();

  const blade=new THREE.Mesh(
    bladeGeo,
    new THREE.MeshPhysicalMaterial({
      color:0xdab476,
      roughness:.48,
      clearcoat:.10,
      clearcoatRoughness:.5
    })
  );
  blade.position.y=-.29;
  blade.castShadow=true;

  const handle=new THREE.Mesh(
    new THREE.CylinderGeometry(.020,.020,.32,12),
    new THREE.MeshStandardMaterial({
      color:0x252a2e,
      roughness:.78
    })
  );
  handle.position.y=.27;
  handle.castShadow=true;

  bat.add(blade,handle);
  return bat;
}

function cuAttachCricketKit(player,palette,role){
  // V6 rule: NEVER construct a jersey, torso, sleeve, leg, pad shell,
  // glove body, or helmet shell from primitive geometry.
  //
  // The player's body and fitted clothing come entirely from the skinned
  // GLB. This prevents the balloon/capsule deformation seen in V5.

  if(role==="batter" && player.bones.handR){
    const bat=cuMakeCricketBat();
    bat.position.set(.012,-.055,.005);
    bat.rotation.set(.10,0,-.12);
    player.bones.handR.add(bat);
    player.bat=bat;
  }
}

function cuFindClip(clips,names){
  const lower=names.map(x=>String(x).toLowerCase());
  return (clips||[]).find(c=>{
    const n=String(c.name||"").toLowerCase();
    return lower.some(x=>n===x||n.includes(x));
  })||null;
}

function cuFindClipWithSource(asset,names){
  for(const pack of asset.animationPacks||[]){
    const clip=cuFindClip(pack.clips,names);
    if(clip)return{clip,source:pack.scene,label:pack.label};
  }
  return null;
}

function cuRetargetNameMap(targetRoot,sourceRoot){
  const t=cuBuildBoneMap(targetRoot);
  const s=cuBuildBoneMap(sourceRoot);
  const names={};

  for(const key of Object.keys(t)){
    if(t[key]&&s[key])names[t[key].name]=s[key].name;
  }

  return names;
}

async function cuBuildRetargetedMotionSet(asset){
  if(cuRetargetedMotionPromise)return cuRetargetedMotionPromise;

  cuRetargetedMotionPromise=(async()=>{
    const target=cloneSkeleton(asset.body.scene);
    const targetBones=cuBuildBoneMap(target);

    const definitions={
      jog:["Jog","Run","Running"],
      bowl:["OverhandThrow","Overhand Throw","Throw"],
      batAttack:["Melee_Hook","Melee Hook","Punch_Cross","Punch Cross"],
      batDefend:["Defend","Fighting Idle"],
      keeper:["Crouch_Idle","Crouch Idle"],
      celebrate:["Power Up","Greeting"]
    };

    const result={};

    for(const [key,names] of Object.entries(definitions)){
      const found=cuFindClipWithSource(asset,names);
      if(!found)continue;

      try{
        const nameMap=cuRetargetNameMap(target,found.source);
        const clip=retargetClip(
          target,
          found.source,
          found.clip,
          {
            names:nameMap,
            hip:targetBones.pelvis?.name,
            preserveHipPosition:true,
            preserveBoneMatrix:true,
            useFirstFramePosition:true,
            fps:30
          }
        );
        clip.name="cu_"+key;
        result[key]=clip;
      }catch(err){
        console.warn("Could not retarget",key,err);
      }
    }

    // Vitruvian ships its own natural locomotion/idle clips.
    const bodyClips=asset.body.animations||[];
    result.idle=
      cuFindClip(bodyClips,["Idle","HappyIdle","Sway"])||
      result.batDefend||
      null;
    result.walk=
      cuFindClip(bodyClips,["Walk"])||
      result.jog||
      null;

    // If retargeted jog is unavailable, use Vitruvian Walk.
    if(!result.jog)result.jog=result.walk;

    return result;
  })();

  return cuRetargetedMotionPromise;
}

function cuCloneHeadPreservingAlignment(root,bodyModel,headTemplate,bones){
  const head=headTemplate.clone(true);

  head.traverse(o=>{
    if(o.isMesh){
      o.castShadow=true;
      o.receiveShadow=true;
      if(o.material){
        if(Array.isArray(o.material)){
          o.material=o.material.map(m=>m?.clone?.()||m);
        }else{
          o.material=o.material.clone?.()||o.material;
        }
      }
    }
  });

  root.add(head);
  root.updateMatrixWorld(true);

  if(bones.head){
    // attach() preserves the head's current world transform while making it
    // follow the animated head bone from this point onward.
    bones.head.attach(head);
  }

  return head;
}

async function cuCreatePlayer(role,teamId){
  const asset=await cuLoadCharacterTemplate();
  const motion=await cuBuildRetargetedMotionSet(asset);

  const root=new THREE.Group();
  const bodyModel=cloneSkeleton(asset.body.scene);
  root.add(bodyModel);

  const bones=cuBuildBoneMap(bodyModel);
  const headModel=cuCloneHeadPreservingAlignment(
    root,
    bodyModel,
    asset.head.scene,
    bones
  );

  const palette=cuTeamPalette(teamId);
  cuStylePlayerMesh(bodyModel,palette,role);

  // Normalize the complete body+head character to a cricket-player height.
  root.updateMatrixWorld(true);
  let box=new THREE.Box3().setFromObject(root);
  const size=new THREE.Vector3();
  box.getSize(size);
  const h=Math.max(.01,size.y);
  root.scale.setScalar(1.82/h);

  root.updateMatrixWorld(true);
  box=new THREE.Box3().setFromObject(root);
  root.position.y-=box.min.y;

  const mixer=new THREE.AnimationMixer(root);
  const actions={};

  const loopNames=new Set(["idle","walk","jog","keeper"]);

  for(const [name,clip] of Object.entries(motion)){
    if(!clip)continue;
    const action=mixer.clipAction(clip);
    if(loopNames.has(name)){
      action.setLoop(THREE.LoopRepeat,Infinity);
    }else{
      action.setLoop(THREE.LoopOnce,1);
      action.clampWhenFinished=true;
    }
    actions[name]=action;
  }

  const p={
    root,
    model:bodyModel,
    headModel,
    bones,
    mixer,
    actions,
    role,
    palette,
    currentAction:null,
    source:asset.source
  };

  cuAttachCricketKit(p,palette,role);

  if(role==="keeper"&&actions.keeper)cuPlayPlayerAction(p,"keeper");
  else cuPlayPlayerAction(p,"idle");

  return p;
}

function cuPlayPlayerAction(p,name,fade=.16,timeScale=1){
  const a=p?.actions?.[name];
  if(!a)return null;

  if(p.currentAction===a&&a.isRunning()){
    a.timeScale=timeScale;
    return a;
  }

  a.reset();
  a.enabled=true;
  a.timeScale=timeScale;
  a.fadeIn(fade);
  a.play();

  if(p.currentAction&&p.currentAction!==a){
    p.currentAction.fadeOut(fade);
  }

  p.currentAction=a;
  return a;
}

function cuActionDurationMs(p,name,timeScale=1){
  const a=p?.actions?.[name];
  if(!a)return 0;
  return Math.max(1,(a.getClip().duration/Math.max(.01,Math.abs(timeScale)))*1000);
}

function cuPlayOnceAndWait(p,name,timeScale=1,fade=.10){
  const a=p?.actions?.[name];
  if(!a)return Promise.resolve(false);

  a.setLoop(THREE.LoopOnce,1);
  a.clampWhenFinished=true;

  const duration=cuActionDurationMs(p,name,timeScale);
  cuPlayPlayerAction(p,name,fade,timeScale);

  return new Promise(resolve=>{
    let done=false;

    const finish=e=>{
      if(done||e.action!==a)return;
      done=true;
      p.mixer.removeEventListener("finished",finish);
      resolve(true);
    };

    p.mixer.addEventListener("finished",finish);

    setTimeout(()=>{
      if(done)return;
      done=true;
      p.mixer.removeEventListener("finished",finish);
      resolve(true);
    },duration+350);
  });
}

function cuStopPlayerActions(p){
  p?.mixer?.stopAllAction();
  p.currentAction=null;
}

function cuSaveBonePose(p){
  const pose={};
  for(const [k,b] of Object.entries(p?.bones||{})){
    if(b)pose[k]={q:b.quaternion.clone(),pos:b.position.clone()};
  }
  return pose;
}

function cuRestoreBonePose(p,pose){
  for(const [k,v] of Object.entries(pose||{})){
    const b=p?.bones?.[k];
    if(!b)continue;
    b.quaternion.copy(v.q);
    b.position.copy(v.pos);
  }
}

function cuBoneRotate(b,x=0,y=0,z=0){
  if(!b)return;
  b.rotation.x+=x;
  b.rotation.y+=y;
  b.rotation.z+=z;
}

function cuPoseTween(ms,fn){
  const start=performance.now();
  return new Promise(resolve=>{
    function f(now){
      const raw=Math.min(1,(now-start)/Math.max(ms,1));
      const p=raw<.5?2*raw*raw:1-Math.pow(-2*raw+2,2)/2;
      fn(p,raw);
      if(raw<1)requestAnimationFrame(f);
      else resolve();
    }
    requestAnimationFrame(f);
  });
}

function tweenPosition(obj,to,ms,onFrame){
  const target=obj?.root||obj;
  if(!target)return Promise.resolve();
  const from=target.position.clone();
  const start=performance.now();

  return new Promise(resolve=>{
    function f(now){
      const raw=Math.min(1,(now-start)/Math.max(ms,1));
      const p=raw<.5?2*raw*raw:1-Math.pow(-2*raw+2,2)/2;
      target.position.lerpVectors(from,to,p);
      onFrame?.(p,raw);
      if(raw<1)requestAnimationFrame(f);
      else resolve();
    }
    requestAnimationFrame(f);
  });
}

function cuCameraMove(pos,look,ms=650){
  if(!three?.camera)return Promise.resolve();
  const camera=three.camera;
  const from=camera.position.clone();
  const start=performance.now();

  return new Promise(resolve=>{
    function f(now){
      const raw=Math.min(1,(now-start)/Math.max(ms,1));
      const p=raw<.5?2*raw*raw:1-Math.pow(-2*raw+2,2)/2;
      camera.position.lerpVectors(from,pos,p);
      camera.lookAt(look);
      if(raw<1)requestAnimationFrame(f);
      else resolve();
    }
    requestAnimationFrame(f);
  });
}

function cuMakeSeatMesh(count){
  const geo=new THREE.BoxGeometry(.34,.16,.34);
  const mat=new THREE.MeshStandardMaterial({
    color:0x1e4a78,
    roughness:.75
  });
  return new THREE.InstancedMesh(geo,mat,count);
}

function cuBuildStadium(scene){
  const stadium=new THREE.Group();
  scene.add(stadium);

  const concrete=new THREE.MeshStandardMaterial({
    color:0x69747e,
    roughness:.92
  });
  const dark=new THREE.MeshStandardMaterial({
    color:0x222c35,
    roughness:.82
  });
  const roofMat=new THREE.MeshPhysicalMaterial({
    color:0xa8b2bb,
    roughness:.43,
    metalness:.58
  });

  // Three continuous tiers, split into segments.
  for(let tier=0;tier<3;tier++){
    const radius=49.5+tier*5.2;
    const y=1.8+tier*4.0;

    for(let i=0;i<40;i++){
      const a0=i/40*Math.PI*2;
      const a1=(i+1)/40*Math.PI*2;
      const mid=(a0+a1)/2;

      const seg=new THREE.Mesh(
        new THREE.BoxGeometry(7.7,2.5,4.2),
        tier===2?dark:concrete
      );
      seg.position.set(Math.cos(mid)*radius,y,Math.sin(mid)*radius);
      seg.rotation.y=-mid+Math.PI/2;
      seg.castShadow=true;
      seg.receiveShadow=true;
      stadium.add(seg);
    }
  }

  // Visible individual seats in front two tiers.
  const rows=7;
  const perRow=170;
  const seats=cuMakeSeatMesh(rows*perRow);
  const dummy=new THREE.Object3D();
  let si=0;
  for(let row=0;row<rows;row++){
    const radius=48.0+row*.58;
    const y=2.20+row*.36;
    for(let i=0;i<perRow;i++){
      const a=i/perRow*Math.PI*2;
      dummy.position.set(
        Math.cos(a)*radius,
        y,
        Math.sin(a)*radius
      );
      dummy.rotation.y=-a+Math.PI/2;
      dummy.updateMatrix();
      seats.setMatrixAt(si++,dummy.matrix);
    }
  }
  seats.instanceMatrix.needsUpdate=true;
  stadium.add(seats);

  // Crowd: body + head instances. Much more obvious than dots.
  const crowdCount=1300;
  const bodyGeo=new THREE.CapsuleGeometry(.075,.22,3,5);
  const bodyMat=new THREE.MeshStandardMaterial({
    color:0x9e3348,
    roughness:.72
  });
  const headGeo=new THREE.SphereGeometry(.055,6,5);
  const headMat=new THREE.MeshStandardMaterial({
    color:0xc89570,
    roughness:.8
  });
  const bodies=new THREE.InstancedMesh(bodyGeo,bodyMat,crowdCount);
  const heads=new THREE.InstancedMesh(headGeo,headMat,crowdCount);

  for(let i=0;i<crowdCount;i++){
    const ring=i%9;
    const a=(i/crowdCount)*Math.PI*2*9;
    const radius=48.6+ring*.55;
    const y=2.35+ring*.34;
    dummy.position.set(Math.cos(a)*radius,y,Math.sin(a)*radius);
    dummy.rotation.y=-a+Math.PI/2;
    dummy.scale.setScalar(.85+(i%5)*.045);
    dummy.updateMatrix();
    bodies.setMatrixAt(i,dummy.matrix);

    dummy.position.y+=.23;
    dummy.scale.setScalar(.90);
    dummy.updateMatrix();
    heads.setMatrixAt(i,dummy.matrix);
  }
  bodies.instanceMatrix.needsUpdate=true;
  heads.instanceMatrix.needsUpdate=true;
  stadium.add(bodies,heads);

  // Roof ring.
  const roof=new THREE.Mesh(
    new THREE.TorusGeometry(59.5,2.1,8,128),
    roofMat
  );
  roof.rotation.x=Math.PI/2;
  roof.position.y=13.6;
  roof.scale.z=.36;
  stadium.add(roof);

  // Scoreboard/video screen.
  const board=new THREE.Mesh(
    new THREE.BoxGeometry(13,6,.55),
    new THREE.MeshStandardMaterial({
      color:0x08131d,
      emissive:0x08263f,
      emissiveIntensity:1.3,
      roughness:.28
    })
  );
  board.position.set(0,11,-57);
  stadium.add(board);

  const boardTextCanvas=document.createElement("canvas");
  boardTextCanvas.width=1024;
  boardTextCanvas.height=420;
  const ctx=boardTextCanvas.getContext("2d");
  ctx.fillStyle="#071520";
  ctx.fillRect(0,0,1024,420);
  ctx.fillStyle="#4ce2ff";
  ctx.font="900 66px system-ui";
  ctx.textAlign="center";
  ctx.fillText("CRICKET UNIVERSE",512,145);
  ctx.fillStyle="#ffffff";
  ctx.font="700 36px system-ui";
  ctx.fillText("LIVE • AI CRICKET",512,220);
  ctx.fillStyle="#7f8f9d";
  ctx.font="600 26px system-ui";
  ctx.fillText("MANAGER CONTROL • BROADCAST SIMULATION",512,280);
  const boardTex=new THREE.CanvasTexture(boardTextCanvas);
  boardTex.colorSpace=THREE.SRGBColorSpace;
  const screen=new THREE.Mesh(
    new THREE.PlaneGeometry(12.3,5.25),
    new THREE.MeshBasicMaterial({map:boardTex})
  );
  screen.position.set(0,11,-56.70);
  stadium.add(screen);

  // Sight screens.
  for(const z of[-45.5,45.5]){
    const ss=new THREE.Mesh(
      new THREE.BoxGeometry(12.5,6.2,.45),
      new THREE.MeshStandardMaterial({
        color:0xf0eee6,
        roughness:.70
      })
    );
    ss.position.set(0,3.2,z);
    stadium.add(ss);
  }

  // Player dugouts.
  for(const x of[-27,27]){
    const dugout=new THREE.Mesh(
      new THREE.BoxGeometry(8,2.6,3.6),
      new THREE.MeshPhysicalMaterial({
        color:0x29475a,
        transparent:true,
        opacity:.72,
        roughness:.22,
        metalness:.12
      })
    );
    dugout.position.set(x,1.3,1);
    stadium.add(dugout);
  }

  // LED boundary advertising.
  const adGeo=new THREE.BoxGeometry(5.3,.65,.18);
  for(let i=0;i<48;i++){
    const a=i/48*Math.PI*2;
    const ad=new THREE.Mesh(
      adGeo,
      new THREE.MeshStandardMaterial({
        color:i%2?0x0b2432:0x39144e,
        emissive:i%2?0x0b6885:0x5e1879,
        emissiveIntensity:.9
      })
    );
    ad.position.set(Math.cos(a)*43.7,.42,Math.sin(a)*43.7);
    ad.rotation.y=-a+Math.PI/2;
    stadium.add(ad);
  }

  // Eight floodlight towers.
  for(let i=0;i<8;i++){
    const a=i/8*Math.PI*2;
    const x=Math.cos(a)*61;
    const z=Math.sin(a)*61;

    const pole=new THREE.Mesh(
      new THREE.CylinderGeometry(.12,.22,25,12),
      new THREE.MeshStandardMaterial({
        color:0x65707b,
        metalness:.72,
        roughness:.31
      })
    );
    pole.position.set(x,12.5,z);
    stadium.add(pole);

    const bank=new THREE.Mesh(
      new THREE.BoxGeometry(5.2,2.0,.40),
      new THREE.MeshStandardMaterial({
        color:0xe8eef1,
        emissive:0xcceaff,
        emissiveIntensity:2.1,
        roughness:.25
      })
    );
    bank.position.set(x,24.3,z);
    bank.lookAt(0,3,0);
    stadium.add(bank);
  }

  const flagPoleMat=new THREE.MeshStandardMaterial({color:0xe8edf1,metalness:.5,roughness:.42});
  const flagMat=new THREE.MeshStandardMaterial({color:0xff8c19,roughness:.55,side:THREE.DoubleSide});
  for(let i=0;i<18;i++){
    const a=i/18*Math.PI*2;
    const r=58.4;
    const pole=new THREE.Mesh(new THREE.CylinderGeometry(.025,.025,1.55,6),flagPoleMat);
    pole.position.set(Math.cos(a)*r,14.65,Math.sin(a)*r);
    stadium.add(pole);
    const flag=new THREE.Mesh(new THREE.PlaneGeometry(.72,.38),flagMat);
    flag.position.set(Math.cos(a)*r,15.23,Math.sin(a)*r);
    flag.rotation.y=-a+Math.PI/2;
    flag.position.x+=Math.cos(a)*.28;
    flag.position.z+=Math.sin(a)*.28;
    stadium.add(flag);
  }

  const cloudMat=new THREE.MeshStandardMaterial({color:0xffffff,roughness:1,transparent:true,opacity:.92});
  const cloudPositions=[[-36,28,-86],[-10,31,-91],[25,28,-88],[48,30,-72]];
  for(const c of cloudPositions){
    const cloud=new THREE.Group();
    for(let j=0;j<6;j++){
      const puff=new THREE.Mesh(new THREE.SphereGeometry(3.8+(j%3)*1.1,16,12),cloudMat);
      puff.scale.set(1.5,.72,1);
      puff.position.set((j-2.5)*3.2,Math.sin(j)*1.1,(j%2)*1.4);
      cloud.add(puff);
    }
    cloud.position.set(c[0],c[1],c[2]);
    stadium.add(cloud);
  }

  return stadium;
}

function initThree(){
  if(three?.ready)return three.ready;
  if(cuInitThreePromise)return cuInitThreePromise;

  cuInitThreePromise=(async()=>{
    try{
      await cuEnsureThreeModules();
    }catch(err){
      console.error("3D engine modules failed to load:",err);
      cuAssetStatus("3D ENGINE LOAD FAILED • MENUS STILL AVAILABLE",true);
      cuInitThreePromise=null;
      return null;
    }

    if(three?.ready)return three.ready;

    const canvas=$("threeCanvas");
    if(!canvas){
      cuInitThreePromise=null;
      return null;
    }

  const renderer=new THREE.WebGLRenderer({
    canvas,
    antialias:true,
    powerPreference:"high-performance",
    alpha:false
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.shadowMap.enabled=true;
  renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=1.28;

  const scene=new THREE.Scene();
  scene.background=new THREE.Color(0x17b8e3);
  scene.fog=new THREE.Fog(0x65c8df,78,185);

  const camera=new THREE.PerspectiveCamera(39,1,.1,250);
  camera.position.set(0,5.35,24.6);
  camera.lookAt(0,1.05,-3.2);

  scene.add(new THREE.HemisphereLight(0xf2fbff,0x263c25,1.65));

  const sun=new THREE.DirectionalLight(0xfff1d7,3.4);
  sun.position.set(-24,42,25);
  sun.castShadow=true;
  sun.shadow.mapSize.set(2048,2048);
  sun.shadow.bias=-.00025;
  sun.shadow.camera.left=-48;
  sun.shadow.camera.right=48;
  sun.shadow.camera.top=48;
  sun.shadow.camera.bottom=-48;
  scene.add(sun);

  const fill=new THREE.DirectionalLight(0x8fc9ff,.85);
  fill.position.set(25,16,-30);
  scene.add(fill);

  // Outfield with layered mowing.
  const ground=new THREE.Mesh(
    new THREE.CircleGeometry(46,160),
    new THREE.MeshStandardMaterial({
      color:0x42b84f,
      roughness:.96
    })
  );
  ground.rotation.x=-Math.PI/2;
  ground.receiveShadow=true;
  scene.add(ground);

  for(let z=-44;z<44;z+=6){
    const band=new THREE.Mesh(
      new THREE.PlaneGeometry(92,3),
      new THREE.MeshBasicMaterial({
        color:(Math.round((z+44)/6)%2)?0x2f7740:0x4b9e57,
        transparent:true,
        opacity:.22,
        depthWrite:false
      })
    );
    band.rotation.x=-Math.PI/2;
    band.position.set(0,.013,z);
    scene.add(band);
  }

  // Inner ring subtle texture.
  for(let r=10;r<=40;r+=7){
    const ring=new THREE.Mesh(
      new THREE.RingGeometry(r-.10,r+.10,128),
      new THREE.MeshBasicMaterial({
        color:0xd8e3d3,
        transparent:true,
        opacity:.06,
        side:THREE.DoubleSide
      })
    );
    ring.rotation.x=-Math.PI/2;
    ring.position.y=.016;
    scene.add(ring);
  }

  // Pitch.
  const pitch=new THREE.Mesh(
    new THREE.BoxGeometry(4.45,.10,22.5),
    new THREE.MeshStandardMaterial({
      color:0xc9ac75,
      roughness:.88
    })
  );
  pitch.position.y=.05;
  pitch.receiveShadow=true;
  scene.add(pitch);

  const worn=new THREE.Mesh(
    new THREE.PlaneGeometry(1.65,16.5),
    new THREE.MeshBasicMaterial({
      color:0x886a46,
      transparent:true,
      opacity:.22
    })
  );
  worn.rotation.x=-Math.PI/2;
  worn.position.y=.106;
  scene.add(worn);

  const lineMat=new THREE.MeshBasicMaterial({color:0xf6f3e8});
  for(const z of[-8.25,8.25]){
    const crease=new THREE.Mesh(new THREE.PlaneGeometry(4.8,.055),lineMat);
    crease.rotation.x=-Math.PI/2;
    crease.position.set(0,.108,z);
    scene.add(crease);

    const pop=new THREE.Mesh(new THREE.PlaneGeometry(3.75,.05),lineMat);
    pop.rotation.x=-Math.PI/2;
    pop.position.set(0,.109,z+(z<0?1.22:-1.22));
    scene.add(pop);
  }

  // Boundary.
  const boundary=new THREE.Mesh(
    new THREE.TorusGeometry(43.2,.11,8,180),
    new THREE.MeshStandardMaterial({
      color:0xffffff,
      roughness:.45
    })
  );
  boundary.rotation.x=Math.PI/2;
  boundary.position.y=.06;
  scene.add(boundary);

  const stadium=cuBuildStadium(scene);

  // Stumps.
  const stumpMat=new THREE.MeshStandardMaterial({
    color:0xf4e4bc,
    roughness:.48
  });
  const stumpSets=[];
  for(const z of[-8.25,8.25]){
    const set={stumps:[],bails:[]};
    for(const x of[-.22,0,.22]){
      const stump=new THREE.Mesh(
        new THREE.CylinderGeometry(.032,.032,.84,10),
        stumpMat
      );
      stump.position.set(x,.42,z);
      stump.castShadow=true;
      scene.add(stump);
      set.stumps.push(stump);
    }
    for(const x of[-.11,.11]){
      const bail=new THREE.Mesh(
        new THREE.CylinderGeometry(.018,.018,.24,8),
        stumpMat
      );
      bail.rotation.z=Math.PI/2;
      bail.position.set(x,.86,z);
      scene.add(bail);
      set.bails.push(bail);
    }
    stumpSets.push(set);
  }

  const ball=new THREE.Mesh(
    new THREE.SphereGeometry(.070,20,16),
    new THREE.MeshPhysicalMaterial({
      color:0xa70f27,
      roughness:.28,
      clearcoat:.55,
      clearcoatRoughness:.22
    })
  );
  ball.castShadow=true;
  scene.add(ball);

  const clock=new THREE.Clock();

  function resize(){
    const r=canvas.parentElement.getBoundingClientRect();
    renderer.setSize(Math.max(1,r.width),Math.max(1,r.height),false);
    camera.aspect=Math.max(.1,r.width/Math.max(1,r.height));
    camera.updateProjectionMatrix();
  }
  addEventListener("resize",resize);
  resize();

  three={
    scene,camera,renderer,stadium,ball,stumpSets,clock,
    fieldHome:[
      [-16,-1],[-13,13],[13,16],[17,0],
      [-15,-17],[15,-16],[-27,9],[27,10],[-28,-11]
    ],
    athletes:[],
    ready:null
  };

  (function loop(){
    requestAnimationFrame(loop);
    const dt=Math.min(.04,clock.getDelta());
    for(const p of three?.athletes||[])p.mixer?.update(dt);
    renderer.render(scene,camera);
  })();

  three.ready=(async()=>{
    cuAssetStatus("V7 • LOADING CLOTHED RIG + MOTION");

    try{
      const batId=match?.battingTeam?.id||"bat";
      const bowlId=match?.bowlingTeam?.id||"bowl";

      const batter=await cuCreatePlayer("batter",batId);
      const non=await cuCreatePlayer("batter",batId);
      const bowler=await cuCreatePlayer("bowler",bowlId);
      const keeper=await cuCreatePlayer("keeper",bowlId);
      const umpire=await cuCreatePlayer("umpire","umpire");

      batter.root.position.set(0,0,-7.20);
      batter.root.rotation.y=Math.PI;

      non.root.position.set(.75,0,7.05);

      bowler.root.position.set(0,0,15.3);
      bowler.root.rotation.y=Math.PI;

      keeper.root.position.set(0,0,-10.0);

      umpire.root.position.set(0,0,7.65);
      umpire.root.rotation.y=Math.PI;

      scene.add(
        batter.root,non.root,bowler.root,keeper.root,umpire.root
      );

      const fielders=[];
      for(const pos of three.fieldHome){
        const f=await cuCreatePlayer("fielder",bowlId);
        f.root.position.set(pos[0],0,pos[1]);
        f.root.lookAt(0,0,0);
        scene.add(f.root);
        fielders.push(f);
      }

      three.batter=batter;
      three.non=non;
      three.bowler=bowler;
      three.keeper=keeper;
      three.umpire=umpire;
      three.fielders=fielders;
      three.athletes=[batter,non,bowler,keeper,umpire,...fielders];

      cuAssetStatus("RETARGETED CRICKET MOTION • READY");
      setTimeout(()=>$("graphicsStatus")?.classList.add("faded"),2200);

    }catch(e){
      console.error(e);
      cuAssetStatus("PLAYER ASSET FAILED • CHECK INTERNET",true);
    }
  })();

    await three.ready;
    return three;
  })().finally(()=>{
    if(!three?.ready)cuInitThreePromise=null;
  });

  return cuInitThreePromise;
}

async function cuRunBatters(runs){
  const t=three;
  if(!t?.batter||!t?.non||runs<=0)return;

  const crossings=Math.min(3,runs);
  cuPlayPlayerAction(t.batter,"jog",.10,1.15);
  cuPlayPlayerAction(t.non,"jog",.10,1.15);

  for(let i=0;i<crossings;i++){
    const bp=t.batter.root.position.clone();
    const np=t.non.root.position.clone();

    await Promise.all([
      tweenPosition(
        t.batter,
        new THREE.Vector3(np.x,0,np.z+(i%2?-.35:.35)),
        720
      ),
      tweenPosition(
        t.non,
        new THREE.Vector3(bp.x,0,bp.z+(i%2?.35:-.35)),
        720
      )
    ]);
  }

  cuPlayPlayerAction(t.batter,"idle",.14,1);
  cuPlayPlayerAction(t.non,"idle",.14,1);
}

function cuFieldCameraForTarget(target,isSix,isFour){
  const right=target.x>=0;
  if(isSix)return new THREE.Vector3(right?24:-24,8.6,target.z>0?17:-17);
  if(isFour)return new THREE.Vector3(right?19:-19,5.3,target.z>0?14:-14);
  return new THREE.Vector3(right?15:-15,5.8,10.5);
}

async function animateDelivery(o){
  await initThree();
  await three?.ready;

  const t=three;
  if(!t?.batter||!t?.bowler)return;

  const bowler=t.bowler;
  const batter=t.batter;
  const keeper=t.keeper;

  bowler.root.position.set(0,0,15.3);
  bowler.root.rotation.set(0,Math.PI,0);

  batter.root.position.set(0,0,-7.20);
  batter.root.rotation.set(0,Math.PI,0);

  keeper.root.position.set(0,0,-10.0);
  keeper.root.rotation.set(0,0,0);

  if(batter.bat)batter.bat.rotation.set(.10,0,-.12);

  cuPlayPlayerAction(batter,"idle",.12,1);
  cuPlayPlayerAction(keeper,keeper.actions.keeper?"keeper":"idle",.12,1);

  t.fielders.forEach((f,i)=>{
    const p=t.fieldHome[i];
    f.root.position.set(p[0],0,p[1]);
    f.root.lookAt(0,0,0);
    cuPlayPlayerAction(f,"idle",.12,1);
  });

  for(const set of t.stumpSets){
    set.bails.forEach((b,i)=>{
      b.rotation.set(0,0,Math.PI/2);
      b.position.y=.86;
      b.position.x=(i===0?-.11:.11);
    });
  }

  t.ball.visible=true;
  t.ball.position.set(0,1.48,13.75);

  cuCameraLabel("BOWLER END");
  await cuCameraMove(
    new THREE.Vector3(0,5.35,24.6),
    new THREE.Vector3(0,1.05,-3.2),
    320
  );

  // ---------------------------------------------------------------
  // 1. REAL LOCOMOTION CLIP FOR RUN-UP
  // ---------------------------------------------------------------
  cuPlayPlayerAction(bowler,"jog",.10,1.28);
  await tweenPosition(
    bowler,
    new THREE.Vector3(0,0,9.35),
    1500
  );

  // ---------------------------------------------------------------
  // 2. REAL OVERHAND-THROW SKELETAL CLIP, RETARGETED TO VITRUVIAN.
  //    The ball is released during the clip instead of rotating bones
  //    by hand.
  // ---------------------------------------------------------------
  cuCameraLabel("DELIVERY");
  const bowlScale=1.18;
  const bowlMs=cuActionDurationMs(bowler,"bowl",bowlScale)||760;
  const bowlPromise=cuPlayOnceAndWait(bowler,"bowl",bowlScale,.08);

  await new Promise(r=>setTimeout(r,Math.max(180,bowlMs*.42)));

  // Ball to pitch.
  const ballToPitch=tweenPosition(
    t.ball,
    new THREE.Vector3((Math.random()-.5)*.20,.16,-4.25),
    600,
    (_p,raw)=>{
      t.ball.position.y+=Math.sin(raw*Math.PI)*.34;
    }
  );

  await ballToPitch;

  // Bounce to batter.
  await tweenPosition(
    t.ball,
    new THREE.Vector3((Math.random()-.5)*.16,.82,-7.02),
    275
  );

  // ---------------------------------------------------------------
  // 3. REAL SKELETAL BATTING MOTION.
  //    Melee_Hook is used as the current CC0 source motion because it
  //    provides a natural torso/shoulder swing without deforming the rig.
  // ---------------------------------------------------------------
  const runs=Number(o.runs||0);
  const attacking=!o.wicket && runs>=2;
  const batAction=attacking && batter.actions.batAttack
    ? "batAttack"
    : (batter.actions.batDefend?"batDefend":"idle");

  if(batAction!=="idle"){
    void cuPlayOnceAndWait(
      batter,
      batAction,
      attacking?1.30:1.05,
      .07
    );
  }

  if(o.wicket){
    cuCameraLabel("WICKET CAM");

    await Promise.all([
      tweenPosition(
        t.ball,
        new THREE.Vector3(0,.45,-8.24),
        350
      ),
      cuCameraMove(
        new THREE.Vector3(4.8,3.8,-2.3),
        new THREE.Vector3(0,.8,-8.0),
        500
      )
    ]);

    const near=t.stumpSets[0];
    near?.bails.forEach((b,i)=>{
      b.rotation.z+=.65*(i?1:-1);
      b.position.y+=.28;
      b.position.x+=(i?1:-1)*.13;
    });

    await new Promise(r=>setTimeout(r,460));

  }else{
    const isSix=runs===6;
    const isFour=runs===4;

    const zones=[
      new THREE.Vector3(32,isSix?5.5:.16,-27),
      new THREE.Vector3(-34,isSix?6.2:.16,-21),
      new THREE.Vector3(31,isSix?5.8:.16,27),
      new THREE.Vector3(-32,isSix?6.0:.16,29),
      new THREE.Vector3(24,isSix?5.2:.16,-4),
      new THREE.Vector3(-25,isSix?5.4:.16,5)
    ];

    const target=(isFour||isSix)
      ? zones[Math.floor(Math.random()*zones.length)]
      : new THREE.Vector3(
          (Math.random()<.5?-1:1)*(9+Math.random()*10),
          .14,
          -9+Math.random()*19
        );

    const nearest=t.fielders.reduce((a,b)=>
      a.root.position.distanceTo(target)
      <
      b.root.position.distanceTo(target)
        ? a
        : b
    );

    cuCameraLabel(
      isSix?"SIX • CROWD CAM":
      isFour?"FOUR • BOUNDARY CAM":
      "FIELDING CAM"
    );

    cuPlayPlayerAction(nearest,"jog",.10,1.20);

    const fieldTarget=new THREE.Vector3(
      target.x*.78,
      0,
      target.z*.78
    );

    const cameraPos=cuFieldCameraForTarget(
      target,
      isSix,
      isFour
    );

    await Promise.all([
      tweenPosition(
        t.ball,
        target,
        isSix?1450:isFour?1250:900,
        (_p,raw)=>{
          if(isSix)t.ball.position.y+=Math.sin(raw*Math.PI)*7.2;
          else if(isFour)t.ball.position.y+=Math.sin(raw*Math.PI)*1.1;
        }
      ),
      tweenPosition(
        nearest,
        fieldTarget,
        isFour||isSix?1300:900
      ),
      cuCameraMove(
        cameraPos,
        target.clone().multiplyScalar(.72),
        isFour||isSix?850:620
      )
    ]);

    cuPlayPlayerAction(nearest,"idle",.12,1);

    if(runs>=1&&runs<=3){
      cuCameraLabel("RUNNING BETWEEN WICKETS");
      await cuRunBatters(runs);
    }

    if(isSix){
      await cuCameraMove(
        new THREE.Vector3(
          target.x>=0?34:-34,
          9.2,
          -39
        ),
        new THREE.Vector3(0,9.0,-55),
        720
      );
      await new Promise(r=>setTimeout(r,800));
    }else if(isFour){
      await cuCameraMove(
        new THREE.Vector3(
          target.x>=0?22:-22,
          3.8,
          target.z*.35+8
        ),
        new THREE.Vector3(
          target.x*.70,
          .5,
          target.z*.70
        ),
        520
      );
      await new Promise(r=>setTimeout(r,520));
    }
  }

  await bowlPromise;

  cuPlayPlayerAction(bowler,"idle",.12,1);
  cuPlayPlayerAction(batter,"idle",.12,1);
  cuPlayPlayerAction(
    keeper,
    keeper.actions.keeper?"keeper":"idle",
    .12,
    1
  );

  cuCameraLabel("BOWLER END");
  await cuCameraMove(
    new THREE.Vector3(0,5.35,24.6),
    new THREE.Vector3(0,1.05,-3.2),
    480
  );
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
