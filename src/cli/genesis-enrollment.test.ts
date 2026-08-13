import {afterEach,beforeEach,describe,expect,test} from "bun:test";import fs from "node:fs/promises";import os from "node:os";import path from "node:path";
import {bootstrapAccount,phraseToRk,sha256Hex,utf8} from "../engine/e2ee/index.js";import type {GenesisAccountObservation,GenesisPresence} from "./e2ee-remote.js";import {saveDevice} from "./e2ee-keystore.js";import {genesisPaths,hardenedWrite,publishGenesisEnrollmentWitness,publishGenesisJournal,publishPrepublishMarker,recordGenesisReceipt,stageRecoveryKey,type GenesisJournal} from "./genesis-durable.js";import {classifyEnrollment,genesisClassifierConsultationNeeded,hasExactLegacyGenesisPair,type PendingGenesisArtifacts} from "./genesis-enrollment.js";import {genesisQuarantineDir,resumeGenesisQuarantine,startGenesisQuarantine} from "./genesis-quarantine.js";
const ACCOUNT="acct_0123456789abcdef",DEVICE="dev_genesis",ZERO:GenesisPresence={rosters:0,keyStates:0,devices:0,workspaces:0,workspaceKeys:0,e2eePairingTokens:0};let home:string;let savedRboxHome:string|undefined;
beforeEach(async()=>{savedRboxHome=process.env.RBOX_HOME;home=await fs.mkdtemp(path.join(os.tmpdir(),"rbox-genesis-classifier-"));process.env.RBOX_HOME=home;});afterEach(async()=>{if(savedRboxHome===undefined)delete process.env.RBOX_HOME;else process.env.RBOX_HOME=savedRboxHome;await fs.rm(home,{recursive:true,force:true});});
const absent=(present:GenesisPresence=ZERO):GenesisAccountObservation=>({genesisPresenceVersion:1,claim:null,present});
async function complete(){const boot=await bootstrapAccount(ACCOUNT,DEVICE,1_900_000_000_000),present={...ZERO,rosters:1,keyStates:1,devices:1};const claim={genesisPresenceVersion:1 as const,recoveryWrap:JSON.stringify(boot.upload.recoveryWrap),recoveryWrapId:boot.upload.recoveryWrapId,claimCreatedAt:1_900_000_000_000,genesisDeviceId:DEVICE,rosters:[JSON.stringify(boot.upload.genesisRoster)],keyStates:[JSON.stringify(boot.upload.genesisKeyState)],devices:[{deviceId:DEVICE,sigPubkey:boot.upload.device.sigPubKey,encPubkey:boot.upload.device.encPubKey,mkWrap:JSON.stringify(boot.upload.device.mkWrap)}],present,repairTombstone:null};return{boot,observation:{genesisPresenceVersion:1 as const,claim,present,repairTombstone:null} satisfies GenesisAccountObservation};}
const REPAIR="gra_"+"a".repeat(32);
function tomb(present:GenesisPresence=ZERO):GenesisAccountObservation{const claim={genesisPresenceVersion:1 as const,recoveryWrap:"rbox:genesis-repair-tombstone:v1",recoveryWrapId:"rbox:genesis-repair-tombstone:v1",claimCreatedAt:1,genesisDeviceId:null,rosters:[],keyStates:[],devices:[],present,repairTombstone:{version:1 as const,repairId:REPAIR,repairedAt:2}};return{genesisPresenceVersion:1,claim,present,repairTombstone:claim.repairTombstone};}
describe("design 180 enrollment classifier",()=>{
  test("only absent/all-zero/no-local is pristine",async()=>{expect((await classifyEnrollment(ACCOUNT,absent())).kind).toBe("pristine");for(const key of Object.keys(ZERO) as Array<keyof GenesisPresence>){expect((await classifyEnrollment(ACCOUNT,absent({...ZERO,[key]:1}))).kind).toBe("integrity-failure");}});
  test("exact all-zero tombstone is repair-ready and workspace-bearing is fatal",async()=>{const tomb=(workspaces:number):GenesisAccountObservation=>{const present={...ZERO,workspaces};const claim={genesisPresenceVersion:1 as const,recoveryWrap:"rbox:genesis-repair-tombstone:v1",recoveryWrapId:"rbox:genesis-repair-tombstone:v1",claimCreatedAt:1,genesisDeviceId:null,rosters:[],keyStates:[],devices:[],present,repairTombstone:{version:1 as const,repairId:"gra_"+"a".repeat(32),repairedAt:2}};return{genesisPresenceVersion:1,claim,present,repairTombstone:claim.repairTombstone};};expect((await classifyEnrollment(ACCOUNT,tomb(0))).kind).toBe("repair-ready");expect((await classifyEnrollment(ACCOUNT,tomb(1))).kind).toBe("integrity-failure");});
  test("fully verified no-journal account is enrolled",async()=>{expect((await classifyEnrollment(ACCOUNT,(await complete()).observation)).kind).toBe("enrolled");});
  test("a verified local enrollment witness survives reload and suppresses consultation",async()=>{const {boot,observation}=await complete();await saveDevice(boot.secrets);expect((await classifyEnrollment(ACCOUNT,observation)).kind).toBe("enrolled");expect(JSON.parse(await fs.readFile(genesisPaths(ACCOUNT).enrolledWitness,"utf8"))).toMatchObject({version:1,accountId:ACCOUNT});expect(await genesisClassifierConsultationNeeded(ACCOUNT)).toBe(false);expect(await genesisClassifierConsultationNeeded(ACCOUNT)).toBe(false);});
  test("enrollment witness hash mismatch fails toward consultation",async()=>{const {boot,observation}=await complete();await saveDevice(boot.secrets);expect((await classifyEnrollment(ACCOUNT,observation)).kind).toBe("enrolled");await fs.appendFile(genesisPaths(ACCOUNT).device,"\n");expect(await genesisClassifierConsultationNeeded(ACCOUNT)).toBe(true);});
  test("every pending artifact overrides a matching enrollment witness",async()=>{
    const {boot}=await complete(),body=JSON.stringify({recoveryWrap:JSON.stringify(boot.upload.recoveryWrap),recoveryWrapId:boot.upload.recoveryWrapId,genesisRoster:JSON.stringify(boot.upload.genesisRoster),genesisKeyState:JSON.stringify(boot.upload.genesisKeyState),device:{deviceId:DEVICE,sigPubKey:boot.upload.device.sigPubKey,encPubKey:boot.upload.device.encPubKey,mkWrap:JSON.stringify(boot.upload.device.mkWrap)}}),journal:GenesisJournal={version:1,accountId:ACCOUNT,deviceId:DEVICE,startedAt:"2026-07-22T12:00:00.000Z",phase:"active",requestBody:body,requestSha256:await sha256Hex(utf8(body)),originalCacheRecovery:false,completionHolds:["recovery-kit-staging"],completionReceipts:{}};
    const cases:Array<[string,()=>Promise<void>]>=[
      ["marker",()=>publishPrepublishMarker({version:1,accountId:ACCOUNT,deviceId:DEVICE,repairId:null,startedAt:"2026-07-22T12:00:00.000Z",phase:"prepublish"})],
      ["journal",()=>publishGenesisJournal(journal)],
      ["staged RK",async()=>stageRecoveryKey(ACCOUNT,await phraseToRk(boot.recoveryPhrase))],
      ["completion intent",()=>hardenedWrite(genesisPaths(ACCOUNT).intent,"present")],
      ["destination progress",()=>hardenedWrite(genesisPaths(ACCOUNT).progress,"present")],
      ["RETARGET witness",()=>hardenedWrite(genesisPaths(ACCOUNT).witness,"present")],
      ["active quarantine",async()=>{await startGenesisQuarantine({accountId:ACCOUNT,purpose:"repaired-legacy",uniquenessKey:REPAIR,createdAt:"2026-07-22T12:00:00.000Z"});await publishGenesisEnrollmentWitness(ACCOUNT);}],
    ];
    for(const [name,publish] of cases){await fs.rm(genesisPaths(ACCOUNT).dir,{recursive:true,force:true});await saveDevice(boot.secrets);await publishGenesisEnrollmentWitness(ACCOUNT);expect(await genesisClassifierConsultationNeeded(ACCOUNT),`${name} precondition`).toBe(false);await publish();expect(await genesisClassifierConsultationNeeded(ACCOUNT),name).toBe(true);}
  });
  test("exact journal fields classify committed-this-attempt; one request-field mismatch competes",async()=>{const {boot,observation}=await complete();await saveDevice(boot.secrets);await stageRecoveryKey(ACCOUNT,await phraseToRk(boot.recoveryPhrase));const request={recoveryWrap:JSON.stringify(boot.upload.recoveryWrap),recoveryWrapId:boot.upload.recoveryWrapId,genesisRoster:JSON.stringify(boot.upload.genesisRoster),genesisKeyState:JSON.stringify(boot.upload.genesisKeyState),device:{deviceId:DEVICE,sigPubKey:boot.upload.device.sigPubKey,encPubKey:boot.upload.device.encPubKey,mkWrap:JSON.stringify(boot.upload.device.mkWrap)}};const makeJournal=async(requestBody:string):Promise<GenesisJournal>=>({version:1,accountId:ACCOUNT,deviceId:DEVICE,startedAt:"2026-07-22T12:00:00.000Z",phase:"active",requestBody,requestSha256:await sha256Hex(utf8(requestBody)),originalCacheRecovery:false,completionHolds:["recovery-kit-staging"],completionReceipts:{}});const exact=await makeJournal(JSON.stringify(request));await publishGenesisJournal(exact);expect((await classifyEnrollment(ACCOUNT,observation)).kind).toBe("committed-this-attempt");const mismatch=await makeJournal(JSON.stringify({...request,device:{...request.device,sigPubKey:"different"}}));await publishGenesisJournal(mismatch);expect((await classifyEnrollment(ACCOUNT,observation)).kind).toBe("competing-genesis");});
  test("journal and marker tombstone resumes reject all child-bearing inventories",async()=>{for(const key of Object.keys(ZERO) as Array<keyof GenesisPresence>){const present={...ZERO,[key]:1};await publishPrepublishMarker({version:1,accountId:ACCOUNT,deviceId:DEVICE,repairId:REPAIR,startedAt:"2026-07-22T12:00:00.000Z",phase:"prepublish"});expect((await classifyEnrollment(ACCOUNT,tomb(present))).kind).toBe("integrity-failure");await fs.rm(genesisPaths(ACCOUNT).marker);const requestBody=JSON.stringify({recoveryWrap:"rw",recoveryWrapId:"id",genesisRoster:"r",genesisKeyState:"k",device:{deviceId:DEVICE,sigPubKey:"s",encPubKey:"e",mkWrap:"m"},repairId:REPAIR}),journal:GenesisJournal={version:1,accountId:ACCOUNT,deviceId:DEVICE,startedAt:"2026-07-22T12:00:00.000Z",phase:"active",requestBody,requestSha256:await sha256Hex(utf8(requestBody)),originalCacheRecovery:false,completionHolds:["recovery-kit-staging"],completionReceipts:{}};await publishGenesisJournal(journal);expect((await classifyEnrollment(ACCOUNT,tomb(present))).kind).toBe("integrity-failure");await fs.rm(genesisPaths(ACCOUNT).journal);}});
  test("classifier exhausts every pre-journal artifact-presence state",async()=>{
    const marker={version:1 as const,accountId:ACCOUNT,deviceId:DEVICE,repairId:null,startedAt:"2026-07-22T12:00:00.000Z",phase:"prepublish" as const};
    for(let mask=0;mask<64;mask++){const pending:PendingGenesisArtifacts={stagedRk:!!(mask&1),device:!!(mask&2),mk:!!(mask&4),...(mask&8?{intentRaw:"present"}:{}),...(mask&16?{progressRaw:"present"}:{}),...(mask&32?{witnessRaw:"present"}:{}),activeQuarantines:[]};const bare=await classifyEnrollment(ACCOUNT,absent(),pending);expect(bare.kind,`unmarked mask ${mask}`).toBe(mask===0?"pristine":"integrity-failure");const marked=await classifyEnrollment(ACCOUNT,absent(),{...pending,marker});expect(marked.kind,`marked mask ${mask}`).toBe(mask&56?"integrity-failure":"restart-prepublication");}
  });
  test("classifier exhausts the reachable marker, journal, quarantine, and receipt lifecycle states",async()=>{
    const {boot,observation}=await complete(),competingObservation=(await complete()).observation;await saveDevice(boot.secrets);await stageRecoveryKey(ACCOUNT,await phraseToRk(boot.recoveryPhrase));
    const body={recoveryWrap:JSON.stringify(boot.upload.recoveryWrap),recoveryWrapId:boot.upload.recoveryWrapId,genesisRoster:JSON.stringify(boot.upload.genesisRoster),genesisKeyState:JSON.stringify(boot.upload.genesisKeyState),device:{deviceId:DEVICE,sigPubKey:boot.upload.device.sigPubKey,encPubKey:boot.upload.device.encPubKey,mkWrap:JSON.stringify(boot.upload.device.mkWrap)}};
    const journalFor=async(requestBody:string):Promise<GenesisJournal>=>({version:1,accountId:ACCOUNT,deviceId:DEVICE,startedAt:"2026-07-22T12:00:00.000Z",phase:"active",requestBody,requestSha256:await sha256Hex(utf8(requestBody)),originalCacheRecovery:false,completionHolds:["recovery-kit-staging"],completionReceipts:{}});
    const ordinaryJournal=await journalFor(JSON.stringify(body)),repairJournal=await journalFor(JSON.stringify({...body,repairId:REPAIR}));
    const ordinaryMarker={version:1 as const,accountId:ACCOUNT,deviceId:DEVICE,repairId:null,startedAt:"2026-07-22T11:59:00.000Z",phase:"prepublish" as const},repairMarker={...ordinaryMarker,repairId:REPAIR};
    const local=(extra:Partial<PendingGenesisArtifacts>):PendingGenesisArtifacts=>({stagedRk:true,device:true,mk:true,activeQuarantines:[],...extra});
    const cleanup=(journal:GenesisJournal,receipt:GenesisJournal["completionReceipts"]["recovery-kit-staging"]):GenesisJournal=>({...journal,phase:"cleanup",completionReceipts:{"recovery-kit-staging":receipt}});
    const at="2026-07-22T12:01:00.000Z";
    type Row={name:string;phase:"marker"|"journal"|"receipt"|"quarantine";mode:"ordinary"|"repair";server:GenesisAccountObservation;pending:PendingGenesisArtifacts;kind:string};const rows:Row[]=[];
    const add=(row:Row)=>rows.push(row);
    // These are the four crash-survivors produced by the actual publication order:
    // marker -> device.json -> mk.key -> rk.key.staged -> journal.  They are
    // generated for both legal expected-previous states, ordinary and repair.
    const preJournalMaterials=[{device:false,mk:false,stagedRk:false},{device:true,mk:false,stagedRk:false},{device:true,mk:true,stagedRk:false},{device:true,mk:true,stagedRk:true}];
    for(const variant of [{mode:"ordinary" as const,marker:ordinaryMarker,journal:ordinaryJournal,server:absent()},{mode:"repair" as const,marker:repairMarker,journal:repairJournal,server:tomb()}]){
      for(const [index,materials] of preJournalMaterials.entries())add({name:`${variant.mode} pre-journal step ${index}`,phase:"marker",mode:variant.mode,server:variant.server,pending:local({marker:variant.marker,...materials}),kind:"restart-prepublication"});
      // Journal publication precedes marker retirement, so both-present is the
      // normal active snapshot, not merely a corruption counterexample.
      add({name:`${variant.mode} marker+journal overlap`,phase:"journal",mode:variant.mode,server:variant.server,pending:local({marker:variant.marker,journal:variant.journal}),kind:"resume-attempt"});
    }
    // Once the journal is durable, the only transactionally observable server
    // results are expected-previous, this exact attempt, or another valid genesis.
    for(const variant of [{mode:"ordinary" as const,journal:ordinaryJournal,expected:absent(),wrongPrevious:tomb()},{mode:"repair" as const,journal:repairJournal,expected:tomb(),wrongPrevious:absent()}]){
      for(const [label,server,kind] of [["expected previous",variant.expected,"resume-attempt"],["exact commit",observation,"committed-this-attempt"],["competing commit",competingObservation,"competing-genesis"],["lost expected previous",variant.wrongPrevious,"integrity-failure"]] as const)add({name:`${variant.mode} journal ${label}`,phase:"journal",mode:variant.mode,server,pending:local({journal:variant.journal}),kind});
    }
    // A winning receipt is reachable only after the exact commit. Both receipt
    // families and both staged-RK cleanup sides are generated for both modes.
    for(const variant of [{mode:"ordinary" as const,journal:ordinaryJournal},{mode:"repair" as const,journal:repairJournal}])for(const receipt of [{outcome:"phrase-delivered" as const,at},{outcome:"artifact-committed" as const,at,artifact:{mode:"kit-path" as const,path:path.join(home,`${variant.mode}.kit`)}}])for(const stagedRk of [true,false])add({name:`${variant.mode} ${receipt.outcome} staged=${stagedRk}`,phase:"receipt",mode:variant.mode,server:observation,pending:local({journal:cleanup(variant.journal,receipt),stagedRk}),kind:"cleanup-resume"});
    // A losing receipt precedes abandoned-attempt manifest publication; while
    // active, the cleanup journal intentionally takes precedence over quarantine.
    add({name:"ordinary competing receipt before quarantine",phase:"receipt",mode:"ordinary",server:competingObservation,pending:local({journal:cleanup(ordinaryJournal,{outcome:"competing-cleaned",at})}),kind:"cleanup-resume"});
    add({name:"ordinary competing receipt with active quarantine",phase:"quarantine",mode:"ordinary",server:competingObservation,pending:local({journal:cleanup(ordinaryJournal,{outcome:"competing-cleaned",at}),activeQuarantines:[{purpose:"abandoned-attempt",key:ordinaryJournal.requestSha256}]}),kind:"cleanup-resume"});
    // Repair quarantine has no journal: active manifests resume; completed
    // archives are omitted by inspectPendingGenesis and expose repair-ready.
    add({name:"repair active legacy quarantine",phase:"quarantine",mode:"repair",server:tomb(),pending:local({stagedRk:false,activeQuarantines:[{purpose:"repaired-legacy",key:REPAIR}]}),kind:"quarantine-resume"});
    add({name:"repair completed legacy quarantine",phase:"quarantine",mode:"repair",server:tomb(),pending:local({stagedRk:false,device:false,mk:false,activeQuarantines:[]}),kind:"repair-ready"});
    for(const row of rows)expect((await classifyEnrollment(ACCOUNT,row.server,row.pending)).kind,row.name).toBe(row.kind);
    expect(new Set(rows.map((row)=>row.name)).size).toBe(rows.length);expect(rows).toHaveLength(30);
    expect(new Set(rows.map((row)=>row.phase))).toEqual(new Set(["marker","journal","receipt","quarantine"]));expect(new Set(rows.map((row)=>row.mode))).toEqual(new Set(["ordinary","repair"]));
  });
  test("repaired legacy requires the exact realistic old-flow device and MK",async()=>{const {boot}=await complete();await saveDevice(boot.secrets);expect(await hasExactLegacyGenesisPair(ACCOUNT)).toBe(true);expect((await classifyEnrollment(ACCOUNT,tomb())).kind).toBe("repaired-legacy");const raw=JSON.parse(await fs.readFile(genesisPaths(ACCOUNT).device,"utf8"));await fs.writeFile(genesisPaths(ACCOUNT).device,JSON.stringify({...raw,extra:true}));expect((await classifyEnrollment(ACCOUNT,tomb())).kind).toBe("integrity-failure");});
  test("abandoned cleanup classifies cleanup-resume on both quarantine crash boundaries",async()=>{const {boot,observation}=await complete();await saveDevice(boot.secrets);await stageRecoveryKey(ACCOUNT,await phraseToRk(boot.recoveryPhrase));const requestBody=JSON.stringify({recoveryWrap:JSON.stringify(boot.upload.recoveryWrap),recoveryWrapId:boot.upload.recoveryWrapId,genesisRoster:JSON.stringify(boot.upload.genesisRoster),genesisKeyState:JSON.stringify(boot.upload.genesisKeyState),device:{deviceId:DEVICE,sigPubKey:boot.upload.device.sigPubKey,encPubKey:boot.upload.device.encPubKey,mkWrap:JSON.stringify(boot.upload.device.mkWrap)}}),active:GenesisJournal={version:1,accountId:ACCOUNT,deviceId:DEVICE,startedAt:"2026-07-22T12:00:00.000Z",phase:"active",requestBody,requestSha256:await sha256Hex(utf8(requestBody)),originalCacheRecovery:false,completionHolds:["recovery-kit-staging"],completionReceipts:{}};const cleanup=await recordGenesisReceipt(active,{outcome:"competing-cleaned",at:"2026-07-22T12:01:00.000Z"});await startGenesisQuarantine({accountId:ACCOUNT,purpose:"abandoned-attempt",uniquenessKey:cleanup.requestSha256,createdAt:"2026-07-22T12:02:00.000Z"});expect((await classifyEnrollment(ACCOUNT,observation)).kind).toBe("cleanup-resume");await resumeGenesisQuarantine(ACCOUNT,"abandoned-attempt",cleanup.requestSha256,"2026-07-22T12:03:00.000Z");expect((await classifyEnrollment(ACCOUNT,observation)).kind).toBe("cleanup-resume");});
  test("no-claim and tombstone local-presence powersets are closed and conservative",async()=>{
    const fields=["stagedRk","device","mk","intentRaw","progressRaw","witnessRaw"] as const;
    for(let mask=0;mask<(1<<fields.length);mask++){
      const pending:PendingGenesisArtifacts={stagedRk:false,device:false,mk:false,activeQuarantines:[]};
      fields.forEach((field,index)=>{if(mask&(1<<index)){if(field==="intentRaw"||field==="progressRaw"||field==="witnessRaw")pending[field]="present";else pending[field]=true;}});
      expect((await classifyEnrollment(ACCOUNT,absent(),pending)).kind).toBe(mask===0?"pristine":"integrity-failure");
      expect((await classifyEnrollment(ACCOUNT,tomb(),pending)).kind).toBe(mask===0?"repair-ready":"integrity-failure");
    }
  });

  test("prepublish marker expected-previous states are exhaustive",async()=>{
    const base:PendingGenesisArtifacts={stagedRk:false,device:false,mk:false,activeQuarantines:[]};
    const ordinary={version:1 as const,accountId:ACCOUNT,deviceId:DEVICE,repairId:null,startedAt:"2026-07-22T12:00:00.000Z",phase:"prepublish" as const};
    const repair={...ordinary,repairId:REPAIR};
    expect((await classifyEnrollment(ACCOUNT,absent(),{...base,marker:ordinary})).kind).toBe("restart-prepublication");
    expect((await classifyEnrollment(ACCOUNT,tomb(),{...base,marker:repair})).kind).toBe("restart-prepublication");
    expect((await classifyEnrollment(ACCOUNT,tomb(),{...base,marker:ordinary})).kind).toBe("integrity-failure");
    expect((await classifyEnrollment(ACCOUNT,absent(),{...base,marker:repair})).kind).toBe("integrity-failure");
    expect((await classifyEnrollment(ACCOUNT,absent(),{...base,marker:ordinary,intentRaw:"orphan"})).kind).toBe("integrity-failure");
    expect((await classifyEnrollment(ACCOUNT,absent({...ZERO,devices:1}),{...base,marker:ordinary})).kind).toBe("integrity-failure");
  });

  test("active journal reaches resume-attempt and receipt reaches cleanup-resume",async()=>{
    const {boot}=await complete();await saveDevice(boot.secrets);await stageRecoveryKey(ACCOUNT,await phraseToRk(boot.recoveryPhrase));
    const requestBody=JSON.stringify({recoveryWrap:JSON.stringify(boot.upload.recoveryWrap),recoveryWrapId:boot.upload.recoveryWrapId,genesisRoster:JSON.stringify(boot.upload.genesisRoster),genesisKeyState:JSON.stringify(boot.upload.genesisKeyState),device:{deviceId:DEVICE,sigPubKey:boot.upload.device.sigPubKey,encPubKey:boot.upload.device.encPubKey,mkWrap:JSON.stringify(boot.upload.device.mkWrap)}});
    const active:GenesisJournal={version:1,accountId:ACCOUNT,deviceId:DEVICE,startedAt:"2026-07-22T12:00:00.000Z",phase:"active",requestBody,requestSha256:await sha256Hex(utf8(requestBody)),originalCacheRecovery:false,completionHolds:["recovery-kit-staging"],completionReceipts:{}};
    await publishGenesisJournal(active);expect((await classifyEnrollment(ACCOUNT,absent())).kind).toBe("resume-attempt");
    await recordGenesisReceipt(active,{outcome:"phrase-delivered",at:"2026-07-22T12:01:00.000Z"});expect((await classifyEnrollment(ACCOUNT,absent())).kind).toBe("cleanup-resume");
  });

  test("non-caching winning cleanup validates journal-bound device and MK after staged RK removal",async()=>{
    const makeCleanup=async()=>{const {boot,observation}=await complete();await saveDevice(boot.secrets);await stageRecoveryKey(ACCOUNT,await phraseToRk(boot.recoveryPhrase));const requestBody=JSON.stringify({recoveryWrap:JSON.stringify(boot.upload.recoveryWrap),recoveryWrapId:boot.upload.recoveryWrapId,genesisRoster:JSON.stringify(boot.upload.genesisRoster),genesisKeyState:JSON.stringify(boot.upload.genesisKeyState),device:{deviceId:DEVICE,sigPubKey:boot.upload.device.sigPubKey,encPubKey:boot.upload.device.encPubKey,mkWrap:JSON.stringify(boot.upload.device.mkWrap)}}),journal:GenesisJournal={version:1,accountId:ACCOUNT,deviceId:DEVICE,startedAt:"2026-07-22T12:00:00.000Z",phase:"active",requestBody,requestSha256:await sha256Hex(utf8(requestBody)),originalCacheRecovery:false,completionHolds:["recovery-kit-staging"],completionReceipts:{}};await recordGenesisReceipt(journal,{outcome:"phrase-delivered",at:"2026-07-22T12:01:00.000Z"});await fs.rm(genesisPaths(ACCOUNT).stagedRk);return observation;};
    let observation=await makeCleanup();expect((await classifyEnrollment(ACCOUNT,observation)).kind).toBe("cleanup-resume");
    await fs.rm(genesisPaths(ACCOUNT).device);expect((await classifyEnrollment(ACCOUNT,observation)).kind).toBe("integrity-failure");
    await fs.rm(genesisPaths(ACCOUNT).dir,{recursive:true,force:true});observation=await makeCleanup();await fs.writeFile(genesisPaths(ACCOUNT).mk,"corrupt");expect((await classifyEnrollment(ACCOUNT,observation)).kind).toBe("integrity-failure");
  });

  test("precise old-endpoint claim reaches legacy-orphan and near misses fail closed",async()=>{
    const claim={genesisPresenceVersion:1 as const,recoveryWrap:"opaque-wrap",recoveryWrapId:"opaque-id",claimCreatedAt:2,genesisDeviceId:null,rosters:[],keyStates:[],devices:[],present:ZERO,repairTombstone:null};
    const observation={genesisPresenceVersion:1 as const,claim,present:ZERO,repairTombstone:null};
    expect((await classifyEnrollment(ACCOUNT,observation)).kind).toBe("legacy-orphan");
    for(const mutation of [{...claim,recoveryWrap:""},{...claim,recoveryWrapId:""},{...claim,claimCreatedAt:0},{...claim,claimCreatedAt:1.5},{...claim,genesisDeviceId:DEVICE}])expect((await classifyEnrollment(ACCOUNT,{...observation,claim:mutation} as GenesisAccountObservation)).kind).toBe("integrity-failure");
  });

  test("repaired-legacy quarantine stays visible after every rename and becomes inert only when completed",async()=>{
    const {boot}=await complete();await saveDevice(boot.secrets);
    const manifest=await startGenesisQuarantine({accountId:ACCOUNT,purpose:"repaired-legacy",uniquenessKey:REPAIR,createdAt:"2026-07-22T12:00:00.000Z"}),dir=genesisQuarantineDir(ACCOUNT,"repaired-legacy",REPAIR);
    expect((await classifyEnrollment(ACCOUNT,tomb())).kind).toBe("quarantine-resume");
    for(const entry of manifest.entries){await fs.rename(path.join(genesisPaths(ACCOUNT).dir,entry.source),path.join(dir,entry.destination));expect((await classifyEnrollment(ACCOUNT,tomb())).kind).toBe("quarantine-resume");}
    await resumeGenesisQuarantine(ACCOUNT,"repaired-legacy",REPAIR,"2026-07-22T12:01:00.000Z");expect((await classifyEnrollment(ACCOUNT,tomb())).kind).toBe("repair-ready");
  });

  test("completed repaired-legacy archive is inert while a new attempt owns the same source paths",async()=>{
    const prior=await complete();await saveDevice(prior.boot.secrets);
    await startGenesisQuarantine({accountId:ACCOUNT,purpose:"repaired-legacy",uniquenessKey:REPAIR,createdAt:"2026-07-22T12:00:00.000Z"});
    await resumeGenesisQuarantine(ACCOUNT,"repaired-legacy",REPAIR,"2026-07-22T12:01:00.000Z");
    const {boot}=await complete();await saveDevice(boot.secrets);await stageRecoveryKey(ACCOUNT,await phraseToRk(boot.recoveryPhrase));
    const requestBody=JSON.stringify({recoveryWrap:JSON.stringify(boot.upload.recoveryWrap),recoveryWrapId:boot.upload.recoveryWrapId,genesisRoster:JSON.stringify(boot.upload.genesisRoster),genesisKeyState:JSON.stringify(boot.upload.genesisKeyState),device:{deviceId:DEVICE,sigPubKey:boot.upload.device.sigPubKey,encPubKey:boot.upload.device.encPubKey,mkWrap:JSON.stringify(boot.upload.device.mkWrap)},repairId:REPAIR});
    const journal:GenesisJournal={version:1,accountId:ACCOUNT,deviceId:DEVICE,startedAt:"2026-07-22T12:02:00.000Z",phase:"active",requestBody,requestSha256:await sha256Hex(utf8(requestBody)),originalCacheRecovery:false,completionHolds:["recovery-kit-staging"],completionReceipts:{}};
    await publishGenesisJournal(journal);
    expect((await classifyEnrollment(ACCOUNT,tomb())).kind).toBe("resume-attempt");
  });

  test("abandoned-attempt quarantine stays cleanup-resume after every rename",async()=>{
    const {boot,observation}=await complete();await saveDevice(boot.secrets);await stageRecoveryKey(ACCOUNT,await phraseToRk(boot.recoveryPhrase));
    const requestBody=JSON.stringify({recoveryWrap:JSON.stringify(boot.upload.recoveryWrap),recoveryWrapId:boot.upload.recoveryWrapId,genesisRoster:JSON.stringify(boot.upload.genesisRoster),genesisKeyState:JSON.stringify(boot.upload.genesisKeyState),device:{deviceId:DEVICE,sigPubKey:boot.upload.device.sigPubKey,encPubKey:boot.upload.device.encPubKey,mkWrap:JSON.stringify(boot.upload.device.mkWrap)}}),active:GenesisJournal={version:1,accountId:ACCOUNT,deviceId:DEVICE,startedAt:"2026-07-22T12:00:00.000Z",phase:"active",requestBody,requestSha256:await sha256Hex(utf8(requestBody)),originalCacheRecovery:false,completionHolds:["recovery-kit-staging"],completionReceipts:{}};
    const cleanup=await recordGenesisReceipt(active,{outcome:"competing-cleaned",at:"2026-07-22T12:01:00.000Z"}),manifest=await startGenesisQuarantine({accountId:ACCOUNT,purpose:"abandoned-attempt",uniquenessKey:cleanup.requestSha256,createdAt:"2026-07-22T12:02:00.000Z"}),dir=genesisQuarantineDir(ACCOUNT,"abandoned-attempt",cleanup.requestSha256);
    for(const entry of manifest.entries){await fs.rename(path.join(genesisPaths(ACCOUNT).dir,entry.source),path.join(dir,entry.destination));expect((await classifyEnrollment(ACCOUNT,observation)).kind).toBe("cleanup-resume");}
    await resumeGenesisQuarantine(ACCOUNT,"abandoned-attempt",cleanup.requestSha256,"2026-07-22T12:03:00.000Z");expect((await classifyEnrollment(ACCOUNT,observation)).kind).toBe("cleanup-resume");
  });
});
