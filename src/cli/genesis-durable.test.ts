import {afterEach,beforeEach,describe,expect,test} from "bun:test";
import fs from "node:fs/promises";import os from "node:os";import path from "node:path";
import {bootstrapAccount,canonicalString,generateRecoveryKey,sha256Hex,utf8} from "../engine/e2ee/index.js";
import {saveDevice,saveMasterKey} from "./e2ee-keystore.js";
import {
  appendDestinationEvent,buildDestinationSetReceipt,completionIntentSha256,createDestinationProgress,foldDestinationProgress,
  genesisPaths,hardenedWrite,loadDestinationProgress,loadStagedRecoveryKey,parseCompletionIntent,parseDestinationProgress,
  parseGenesisEnrollmentWitness,parseGenesisJournal,parsePrepublishMarker,parseRetargetWitness,publishCompletionIntent,
  publishDestinationProgress,publishGenesisEnrollmentWitness,publishGenesisJournal,publishPrepublishMarker,
  reconcileRetargetIntent,recordDestinationSetReceipt,recordGenesisReceipt,replaceDestinationSetIntent,
  retargetCompletionIntent,serializeCompletionIntent,stageRecoveryKey,
  type CompletionIntent,type CompletionIntentRetargetWitness,type DestinationCompletion,type DestinationEvent,type DestinationSetCompletionIntent,
  type GenesisJournal,type HardenedWriteOptions
} from "./genesis-durable.js";

const ACCOUNT="acct_0123456789abcdef";let home:string;
beforeEach(async()=>{home=await fs.mkdtemp(path.join(os.tmpdir(),"rbox-genesis-durable-"));process.env.RBOX_HOME=home;});afterEach(async()=>{delete process.env.RBOX_HOME;await fs.rm(home,{recursive:true,force:true});});
async function journal():Promise<GenesisJournal>{const requestBody='{"recoveryWrap":"\\u0061","recoveryWrapId":"wrap-id","genesisRoster":"roster","genesisKeyState":"state","device":{"deviceId":"dev_a","sigPubKey":"sig","encPubKey":"enc","mkWrap":"mk-wrap"}}';return{version:1,accountId:ACCOUNT,deviceId:"dev_a",startedAt:"2026-07-22T12:00:00.000Z",phase:"active",requestBody,requestSha256:await sha256Hex(utf8(requestBody)),originalCacheRecovery:false,completionHolds:["recovery-kit-staging"],completionReceipts:{}};}

describe("design 180 durable genesis artifacts",()=>{
  test("marker and journal parsers are strict and preserve exact request UTF-8",async()=>{const marker={version:1 as const,accountId:ACCOUNT,deviceId:"dev_a",repairId:null,startedAt:"2026-07-22T12:00:00.000Z",phase:"prepublish" as const};await publishPrepublishMarker(marker);expect(parsePrepublishMarker(await fs.readFile(genesisPaths(ACCOUNT).marker,"utf8"),ACCOUNT)).toEqual(marker);expect(()=>parsePrepublishMarker(canonicalString({...marker,extra:true}),ACCOUNT)).toThrow();const j=await journal();await publishGenesisJournal(j);expect((await parseGenesisJournal(await fs.readFile(genesisPaths(ACCOUNT).journal,"utf8"),ACCOUNT)).requestBody).toBe(j.requestBody);await expect(parseGenesisJournal(canonicalString({...j,requestSha256:"0".repeat(64)}),ACCOUNT)).rejects.toThrow();});
  test("digest-valid malformed bootstrap bodies are rejected before replay",async()=>{const j=await journal();for(const body of [{recoveryWrap:"rw",device:{deviceId:"dev_a"}},{recoveryWrap:"rw",recoveryWrapId:"id",genesisRoster:"r",genesisKeyState:"k",device:{deviceId:"other",sigPubKey:"s",encPubKey:"e",mkWrap:"m"}},{recoveryWrap:"rw",recoveryWrapId:"id",genesisRoster:"r",genesisKeyState:"k",device:{deviceId:"dev_a",sigPubKey:"s",encPubKey:"e",mkWrap:"m"},repairId:"bad"}]){const requestBody=JSON.stringify(body),candidate={...j,requestBody,requestSha256:await sha256Hex(utf8(requestBody))};await expect(parseGenesisJournal(canonicalString(candidate),ACCOUNT)).rejects.toThrow(/bootstrap/);}});
  test("staged RK is 0600 and phrase-round-trippable",async()=>{const rk=generateRecoveryKey();await stageRecoveryKey(ACCOUNT,rk);expect(await loadStagedRecoveryKey(ACCOUNT)).toEqual(rk);expect((await fs.stat(genesisPaths(ACCOUNT).stagedRk)).mode&0o777).toBe(0o600);});
  test("hardened writer awaits and fail-closes at every durability stage",async()=>{const stages=["ancestor-mkdir","ancestor-fsync","temp-create","temp-write","temp-fsync","temp-close","rename","read-back","published-file-fsync","parent-fsync"] as const;const seen:string[]=[];await hardenedWrite(path.join(genesisPaths(ACCOUNT).dir,"probe"),"bytes",{onStep:(step)=>{seen.push(step);}});expect(seen).toEqual(stages);for(const fail of stages){await expect(hardenedWrite(path.join(genesisPaths(ACCOUNT).dir,`fail-${fail}`),"x",{onStep:(step)=>{if(step===fail)throw new Error(fail);}})).rejects.toThrow(fail);}});
  test("every genesis artifact publisher awaits both boundaries of every hardened-writer stage",async()=>{
    const stages=["ancestor-mkdir","ancestor-fsync","temp-create","temp-write","temp-fsync","temp-close","rename","read-back","published-file-fsync","parent-fsync"] as const,boot=await bootstrapAccount(ACCOUNT,"dev_a",1_900_000_000_000),j=await journal(),marker={version:1 as const,accountId:ACCOUNT,deviceId:"dev_a",repairId:null,startedAt:"2026-07-22T12:00:00.000Z",phase:"prepublish" as const},intent:CompletionIntent={version:1,accountId:ACCOUNT,requestSha256:j.requestSha256,mode:"phrase-display",intentAt:"2026-07-22T12:01:00.000Z"};
    const publishers:Array<[string,(options:HardenedWriteOptions)=>Promise<void>]>=[
      ["device.json",options=>saveDevice(boot.secrets,{device:options})],
      ["mk.key",options=>saveMasterKey(ACCOUNT,boot.secrets.mk,options)],
      ["rk.key.staged",options=>stageRecoveryKey(ACCOUNT,generateRecoveryKey(),options)],
      ["genesis-prepublish.json",options=>publishPrepublishMarker(marker,options)],
      ["genesis-journal.json",options=>publishGenesisJournal(j,options)],
      ["genesis-completion-intent.json",options=>publishCompletionIntent(intent,j,options)],
      ["genesis-enrolled.json",async options=>{await saveDevice(boot.secrets);await publishGenesisEnrollmentWitness(ACCOUNT,"2026-07-22T12:02:00.000Z",options);}],
    ];
    for(const [artifact,publish] of publishers)for(const stage of stages)for(const boundary of ["before","after"] as const){await fs.rm(genesisPaths(ACCOUNT).dir,{recursive:true,force:true});const label=`${artifact}:${stage}:${boundary}`;await expect(publish({onBoundary(seen,at){if(seen===stage&&at===boundary)throw new Error(label);}})).rejects.toThrow(label);}
  });
  test("enrollment witness parser is strict and binds exact raw device/MK hashes",async()=>{const boot=await bootstrapAccount(ACCOUNT,"dev_a",1_900_000_000_000);await saveDevice(boot.secrets);const witness=await publishGenesisEnrollmentWitness(ACCOUNT,"2026-07-22T12:02:00.000Z");expect(parseGenesisEnrollmentWitness(await fs.readFile(genesisPaths(ACCOUNT).enrolledWitness,"utf8"),ACCOUNT)).toEqual(witness);expect(()=>parseGenesisEnrollmentWitness(canonicalString({...witness,extra:true}),ACCOUNT)).toThrow();expect(()=>parseGenesisEnrollmentWitness(canonicalString({...witness,accountId:"acct_ffffffffffffffff"}),ACCOUNT)).toThrow();});
  test("completion intent binds exact account/digest and absence is distinguishable",async()=>{const j=await journal(),intent:CompletionIntent={version:1,accountId:ACCOUNT,requestSha256:j.requestSha256,mode:"kit-path",path:path.resolve(home,"kit.txt"),intentAt:"2026-07-22T12:01:00.000Z"};await publishCompletionIntent(intent,j);expect(parseCompletionIntent(await fs.readFile(genesisPaths(ACCOUNT).intent,"utf8"),j)).toEqual(intent);expect(()=>parseCompletionIntent(canonicalString({...intent,accountId:"acct_ffffffffffffffff"}),j)).toThrow();expect(()=>parseCompletionIntent(canonicalString({...intent,path:"relative.txt"}),j)).toThrow();});
  test("RETARGET witness authorizes exactly old or new survivor and retires last",async()=>{const j=await journal(),oldIntent:CompletionIntent={version:1,accountId:ACCOUNT,requestSha256:j.requestSha256,mode:"keychain",keychain:{service:"rbox recovery phrase",account:ACCOUNT,keychainPath:path.resolve(home,"login.keychain")},intentAt:"2026-07-22T12:01:00.000Z"},newIntent:CompletionIntent={version:1,accountId:ACCOUNT,requestSha256:j.requestSha256,mode:"kit-path",path:path.resolve(home,"kit.txt"),intentAt:"2026-07-22T12:02:00.000Z"};await publishCompletionIntent(oldIntent,j);await retargetCompletionIntent(j,oldIntent,newIntent,"2026-07-22T12:03:00.000Z");expect((await reconcileRetargetIntent(j))?.mode).toBe("kit-path");await expect(fs.access(genesisPaths(ACCOUNT).witness)).rejects.toThrow();});

  test("every present malformed completion intent is preserved and fails closed",async()=>{
    const j=await journal();
    const valid:CompletionIntent={version:1,accountId:ACCOUNT,requestSha256:j.requestSha256,mode:"phrase-display",intentAt:"2026-07-22T12:01:00.000Z"};
    const invalid:unknown[]=[
      {...valid,version:2},
      {...valid,accountId:"acct_ffffffffffffffff"},
      {...valid,requestSha256:"f".repeat(64)},
      {...valid,intentAt:"yesterday"},
      {...valid,extra:true},
      {...valid,mode:"unknown"},
      {...valid,mode:"kit-path",path:"relative/kit.txt"},
      {...valid,mode:"kit-path",path:path.resolve(home,"kit.txt"),extra:true},
      {...valid,mode:"keychain",keychain:{service:"wrong",account:ACCOUNT,keychainPath:path.resolve(home,"login.keychain")}},
      {...valid,mode:"keychain",keychain:{service:"rbox recovery phrase",account:"",keychainPath:path.resolve(home,"login.keychain")}},
      {...valid,mode:"keychain",keychain:{service:"rbox recovery phrase",account:ACCOUNT,keychainPath:"relative"}},
    ];
    for(const candidate of invalid){
      const raw=canonicalString(candidate);
      await hardenedWrite(genesisPaths(ACCOUNT).intent,raw);
      expect(()=>parseCompletionIntent(raw,j)).toThrow();
      expect(await fs.readFile(genesisPaths(ACCOUNT).intent,"utf8")).toBe(raw);
    }
  });

  test("RETARGET reconciles every hardened-writer crash boundary for the old or new exact survivor",async()=>{
    const j=await journal();
    const oldIntent:CompletionIntent={version:1,accountId:ACCOUNT,requestSha256:j.requestSha256,mode:"keychain",keychain:{service:"rbox recovery phrase",account:ACCOUNT,keychainPath:path.resolve(home,"login.keychain")},intentAt:"2026-07-22T12:01:00.000Z"};
    const newIntent:CompletionIntent={version:1,accountId:ACCOUNT,requestSha256:j.requestSha256,mode:"kit-path",path:path.resolve(home,"kit.txt"),intentAt:"2026-07-22T12:02:00.000Z"};
    const stages=["ancestor-mkdir","ancestor-fsync","temp-create","temp-write","temp-fsync","temp-close","rename","read-back","published-file-fsync","parent-fsync"] as const;
    for(const fail of stages)for(const boundary of ["before","after"] as const){
      await fs.rm(genesisPaths(ACCOUNT).witness,{force:true});await publishCompletionIntent(oldIntent,j);
      let occurrence=0;const label=`new-${boundary}-${fail}`;
      await expect(retargetCompletionIntent(j,oldIntent,newIntent,"2026-07-22T12:03:00.000Z",{onBoundary(step,at){if(step===fail&&at===boundary&&++occurrence===2)throw new Error(label);}})).rejects.toThrow(label);
      expect(await fs.readFile(genesisPaths(ACCOUNT).witness,"utf8")).toContain('"oldIntent"');
      const survivor=await reconcileRetargetIntent(j),stageIndex=stages.indexOf(fail),renameIndex=stages.indexOf("rename"),newSurvives=stageIndex>renameIndex||(stageIndex===renameIndex&&boundary==="after");
      expect(survivor?.mode).toBe(newSurvives?"kit-path":"keychain");expect(await fs.readFile(genesisPaths(ACCOUNT).intent,"utf8")).toBe(serializeCompletionIntent(survivor!));await expect(fs.access(genesisPaths(ACCOUNT).witness)).rejects.toThrow();
    }
  });

  test("RETARGET witness publication failures never authorize an unwitnessed fallback",async()=>{
    const j=await journal();
    const oldIntent:CompletionIntent={version:1,accountId:ACCOUNT,requestSha256:j.requestSha256,mode:"keychain",keychain:{service:"rbox recovery phrase",account:ACCOUNT,keychainPath:path.resolve(home,"login.keychain")},intentAt:"2026-07-22T12:01:00.000Z"};
    const newIntent:CompletionIntent={version:1,accountId:ACCOUNT,requestSha256:j.requestSha256,mode:"kit-path",path:path.resolve(home,"kit.txt"),intentAt:"2026-07-22T12:02:00.000Z"};
    const stages=["ancestor-mkdir","ancestor-fsync","temp-create","temp-write","temp-fsync","temp-close","rename","read-back","published-file-fsync","parent-fsync"] as const;
    for(const fail of stages)for(const boundary of ["before","after"] as const){
      await fs.rm(genesisPaths(ACCOUNT).witness,{force:true});await publishCompletionIntent(oldIntent,j);const label=`witness-${boundary}-${fail}`;
      await expect(retargetCompletionIntent(j,oldIntent,newIntent,"2026-07-22T12:03:00.000Z",{onBoundary(step,at){if(step===fail&&at===boundary)throw new Error(label);}})).rejects.toThrow(label);
      expect(parseCompletionIntent(await fs.readFile(genesisPaths(ACCOUNT).intent,"utf8"),j)).toEqual(oldIntent);
      const survivor=await reconcileRetargetIntent(j),stageIndex=stages.indexOf(fail),renameIndex=stages.indexOf("rename"),witnessSurvives=stageIndex>renameIndex||(stageIndex===renameIndex&&boundary==="after");
      if(witnessSurvives)expect(survivor).toEqual(oldIntent);else expect(survivor).toBeUndefined();
    }
  });

  test("RETARGET rejects malformed witnesses, a third canonical value, and post-receipt replacement",async()=>{
    const j=await journal();
    const oldIntent:CompletionIntent={version:1,accountId:ACCOUNT,requestSha256:j.requestSha256,mode:"keychain",keychain:{service:"rbox recovery phrase",account:ACCOUNT,keychainPath:path.resolve(home,"login.keychain")},intentAt:"2026-07-22T12:01:00.000Z"};
    const newIntent:CompletionIntent={version:1,accountId:ACCOUNT,requestSha256:j.requestSha256,mode:"kit-path",path:path.resolve(home,"kit.txt"),intentAt:"2026-07-22T12:02:00.000Z"};
    await publishCompletionIntent(oldIntent,j);
    let secondRename=0;
    await expect(retargetCompletionIntent(j,oldIntent,newIntent,"2026-07-22T12:03:00.000Z",{onStep(step){if(step==="rename"&&++secondRename===2)throw new Error("stop before replacement");}})).rejects.toThrow();
    const witnessRaw=await fs.readFile(genesisPaths(ACCOUNT).witness,"utf8");
    const witness=JSON.parse(witnessRaw) as CompletionIntentRetargetWitness;
    for(const mutation of [
      {...witness,version:2},
      {...witness,accountId:"acct_ffffffffffffffff"},
      {...witness,requestSha256:"f".repeat(64)},
      {...witness,witnessedAt:"invalid"},
      {...witness,oldIntentSha256:"0".repeat(64)},
      {...witness,newIntentSha256:"0".repeat(64)},
      {...witness,extra:true},
    ])await expect(parseRetargetWitness(canonicalString(mutation),j)).rejects.toThrow();

    const third:CompletionIntent={version:1,accountId:ACCOUNT,requestSha256:j.requestSha256,mode:"phrase-display",intentAt:"2026-07-22T12:04:00.000Z"};
    await hardenedWrite(genesisPaths(ACCOUNT).intent,serializeCompletionIntent(third));
    await expect(reconcileRetargetIntent(j)).rejects.toThrow(/witnessed value/);
    expect(await fs.readFile(genesisPaths(ACCOUNT).witness,"utf8")).toBe(witnessRaw);

    await hardenedWrite(genesisPaths(ACCOUNT).intent,serializeCompletionIntent(oldIntent));
    expect((await reconcileRetargetIntent(j))?.mode).toBe("keychain");
    const cleanup=await recordGenesisReceipt(j,{outcome:"artifact-committed",at:"2026-07-22T12:05:00.000Z",artifact:{mode:"keychain",service:"rbox recovery phrase",account:ACCOUNT,keychainPath:path.resolve(home,"login.keychain")}});
    await expect(retargetCompletionIntent(cleanup,oldIntent,newIntent,"2026-07-22T12:06:00.000Z")).rejects.toThrow(/not authorized/);
    await expect(recordGenesisReceipt(cleanup,{outcome:"artifact-committed",at:"2026-07-22T12:07:00.000Z",artifact:{mode:"kit-path",path:path.resolve(home,"kit.txt")}})).rejects.toThrow(/monotone/);
  });
});

describe("design 187 durable destination sets",()=>{
  async function intent(destinations:DestinationSetCompletionIntent["destinations"]):Promise<{j:GenesisJournal;intent:DestinationSetCompletionIntent}>{
    const j=await journal();
    return{j,intent:{version:2,accountId:ACCOUNT,requestSha256:j.requestSha256,mode:"destination-set",destinations,successThreshold:1,intentAt:"2026-07-23T12:00:00.000Z"}};
  }
  const keychain=()=>({kind:"keychain" as const,service:"rbox recovery phrase" as const,account:ACCOUNT,keychainPath:path.resolve(home,"login.keychain")});
  const kit=()=>({kind:"kit-path" as const,path:path.resolve(home,"kit.txt")});
  const onePassword=()=>({kind:"onepassword" as const,accountUuid:"acctUUID_1",vaultUuid:"vaultUUID_1",operationTag:"rbox_op_1",fieldId:"rboxRecoveryPhrase" as const});

  test("v2 intent accepts one-to-four unique canonical destinations and rejects reordered or unsafe fields",async()=>{
    const {j,intent:valid}=await intent([onePassword(),keychain(),kit(),{kind:"clipboard"}]);
    expect(parseCompletionIntent(serializeCompletionIntent(valid),j)).toEqual(valid);
    for(const candidate of [
      {...valid,destinations:[]},
      {...valid,destinations:[kit(),kit()]},
      {...valid,destinations:[kit(),keychain()]},
      {...valid,destinations:[{...onePassword(),accountUuid:"bad\nuuid"}]},
      {...valid,destinations:[{...keychain(),account:"acct_ffffffffffffffff"}]},
      {...valid,destinations:[{kind:"kit-path",path:"relative"}]},
      {...valid,successThreshold:2},
      {...valid,extra:true},
    ])expect(()=>parseCompletionIntent(canonicalString(candidate),j)).toThrow();
  });

  test("progress is exact-intent-bound, append-only, and folds completion/invalidation",async()=>{
    const {intent:plan}=await intent([onePassword(),kit()]);
    await publishCompletionIntent(plan,await journal());
    let progress=await createDestinationProgress(plan);await publishDestinationProgress(plan,progress);
    const events:DestinationEvent[]=[
      {kind:"op-dispatch-prepared",destinationIndex:0,attemptId:"attempt_1",at:"2026-07-23T12:01:00.000Z"},
      {kind:"op-may-have-dispatched",destinationIndex:0,attemptId:"attempt_1",at:"2026-07-23T12:02:00.000Z"},
      {kind:"completed",destinationIndex:0,completion:{...onePassword(),itemUuid:"itemUUID_1",completedAt:"2026-07-23T12:03:00.000Z"},at:"2026-07-23T12:03:00.000Z"},
      {kind:"completed",destinationIndex:1,completion:{...kit(),completedAt:"2026-07-23T12:04:00.000Z"},at:"2026-07-23T12:04:00.000Z"},
    ];
    for(const event of events)progress=await appendDestinationEvent(plan,progress,event);
    expect((await foldDestinationProgress(plan,progress.events)).completions.filter(Boolean)).toHaveLength(2);
    const prior=progress.events[2] as Extract<DestinationEvent,{kind:"completed"}>;
    progress=await appendDestinationEvent(plan,progress,{kind:"invalidated",destinationIndex:0,priorCompletionSha256:await sha256Hex(utf8(canonicalString(prior.completion))),reason:"missing",at:"2026-07-23T12:05:00.000Z"});
    expect((await foldDestinationProgress(plan,progress.events)).completions).toEqual([undefined,events[3] && (events[3] as Extract<DestinationEvent,{kind:"completed"}>).completion]);
    await expect(appendDestinationEvent(plan,{...progress,events:progress.events.slice(0,-1)}, {kind:"completed",destinationIndex:1,completion:{...kit(),completedAt:"2026-07-23T12:06:00.000Z"},at:"2026-07-23T12:06:00.000Z"})).rejects.toThrow(/exact canonical/);
    await expect(parseDestinationProgress(canonicalString({...progress,intentSha256:"0".repeat(64)}),plan)).rejects.toThrow();
  });

  test("a completed event whose completion timestamp precedes its event time still folds (no wall-clock equality)",async()=>{
    // Regression: parseDestinationEvent used to require completion.completedAt ===
    // at, which manufactured a "completion event timestamp mismatch" whenever a
    // durable write between the two samples crossed a millisecond. The completion
    // carries its own authoritative timestamp; only `at` drives monotonicity.
    const {intent:plan}=await intent([onePassword()]);
    await publishCompletionIntent(plan,await journal());
    let progress=await createDestinationProgress(plan);await publishDestinationProgress(plan,progress);
    progress=await appendDestinationEvent(plan,progress,{kind:"op-dispatch-prepared",destinationIndex:0,attemptId:"attempt_1",at:"2026-07-23T12:01:00.000Z"});
    progress=await appendDestinationEvent(plan,progress,{kind:"op-may-have-dispatched",destinationIndex:0,attemptId:"attempt_1",at:"2026-07-23T12:02:00.000Z"});
    // completion.completedAt (12:03:00.100) is EARLIER than the event `at` (12:03:00.900).
    progress=await appendDestinationEvent(plan,progress,{kind:"completed",destinationIndex:0,completion:{...onePassword(),itemUuid:"itemUUID_1",completedAt:"2026-07-23T12:03:00.100Z"},at:"2026-07-23T12:03:00.900Z"});
    const folded=await foldDestinationProgress(plan,progress.events);
    expect(folded.completions[0]).toMatchObject({kind:"onepassword",itemUuid:"itemUUID_1",completedAt:"2026-07-23T12:03:00.100Z"});
    // and it survives a round-trip through the strict parser.
    expect((await parseDestinationProgress(canonicalString(progress),plan)).events).toHaveLength(3);
  });

  test("1Password retry transitions allow a new attempt only after strict child-not-started",async()=>{
    const {intent:plan}=await intent([onePassword()]);
    let progress=await createDestinationProgress(plan);await publishDestinationProgress(plan,progress);
    progress=await appendDestinationEvent(plan,progress,{kind:"op-dispatch-prepared",destinationIndex:0,attemptId:"attempt_1",at:"2026-07-23T12:01:00.000Z"});
    await expect(appendDestinationEvent(plan,progress,{kind:"op-dispatch-prepared",destinationIndex:0,attemptId:"attempt_2",at:"2026-07-23T12:02:00.000Z"})).rejects.toThrow(/prepare transition/);
    progress=await appendDestinationEvent(plan,progress,{kind:"op-may-have-dispatched",destinationIndex:0,attemptId:"attempt_1",at:"2026-07-23T12:02:00.000Z"});
    await expect(appendDestinationEvent(plan,progress,{kind:"op-child-not-started",destinationIndex:0,attemptId:"attempt_1",reason:"other" as "spawn-enoent",at:"2026-07-23T12:03:00.000Z"})).rejects.toThrow();
    progress=await appendDestinationEvent(plan,progress,{kind:"op-child-not-started",destinationIndex:0,attemptId:"attempt_1",reason:"spawn-enoent",at:"2026-07-23T12:03:00.000Z"});
    progress=await appendDestinationEvent(plan,progress,{kind:"op-dispatch-prepared",destinationIndex:0,attemptId:"attempt_2",at:"2026-07-23T12:04:00.000Z"});
    expect((await foldDestinationProgress(plan,progress.events)).attempts[0]).toEqual({attemptId:"attempt_2",state:"prepared"});
  });

  test("receipt contains only folded live-valid completions and requires explicit partial continuation",async()=>{
    const {j,intent:plan}=await intent([keychain(),kit()]);
    await publishCompletionIntent(plan,j);let progress=await createDestinationProgress(plan);await publishDestinationProgress(plan,progress);
    progress=await appendDestinationEvent(plan,progress,{kind:"completed",destinationIndex:0,completion:{...keychain(),completedAt:"2026-07-23T12:01:00.000Z"},at:"2026-07-23T12:01:00.000Z"});
    await expect(buildDestinationSetReceipt(plan,progress,[0],false,"2026-07-23T12:02:00.000Z")).rejects.toThrow(/explicit continuation/);
    const receipt=await buildDestinationSetReceipt(plan,progress,[0],true,"2026-07-23T12:02:00.000Z");
    expect(receipt.completions).toEqual([{...keychain(),completedAt:"2026-07-23T12:01:00.000Z"}]);
    expect(receipt.intentSha256).toBe(await completionIntentSha256(plan));
    const cleanup=await recordDestinationSetReceipt(j,plan,progress,[0],true,"2026-07-23T12:02:00.000Z");
    expect((await parseGenesisJournal(canonicalString(cleanup))).completionReceipts["recovery-kit-staging"]).toEqual(receipt);
  });

  test("witnessed intent+progress replacement carries every live-valid completion and reconciles mixed pairs",async()=>{
    for(const pair of ["old-old","new-old","old-new","new-new"] as const){
      await fs.rm(genesisPaths(ACCOUNT).dir,{recursive:true,force:true});
      const {j,intent:oldPlan}=await intent([keychain(),kit()]);
      const newPlan:DestinationSetCompletionIntent={...oldPlan,destinations:[kit(),{kind:"clipboard"}],intentAt:"2026-07-23T12:05:00.000Z"};
      await publishCompletionIntent(oldPlan,j);let oldProgress=await createDestinationProgress(oldPlan);await publishDestinationProgress(oldPlan,oldProgress);
      const completion:DestinationCompletion={...kit(),completedAt:"2026-07-23T12:01:00.000Z"};
      oldProgress=await appendDestinationEvent(oldPlan,oldProgress,{kind:"completed",destinationIndex:1,completion,at:"2026-07-23T12:01:00.000Z"});
      const mapping={oldDestinationIndex:1,newDestinationIndex:0,completionSha256:await sha256Hex(utf8(canonicalString(completion)))};
      await replaceDestinationSetIntent(j,oldPlan,oldProgress,newPlan,[mapping],[1],"2026-07-23T12:06:00.000Z");
      const witness=await parseRetargetWitness(await fs.readFile(genesisPaths(ACCOUNT).witness,"utf8"),j);
      if(witness.version!==2)throw new Error("expected destination-set witness");
      const [intentSide,progressSide]=pair.split("-") as ["old"|"new","old"|"new"];
      await hardenedWrite(genesisPaths(ACCOUNT).intent,serializeCompletionIntent(intentSide==="old"?witness.oldIntent:witness.newIntent));
      await hardenedWrite(genesisPaths(ACCOUNT).progress,canonicalString(progressSide==="old"?witness.oldProgress:witness.newProgress));
      const survivor=await reconcileRetargetIntent(j);
      expect(survivor?.version).toBe(2);
      if(!survivor||survivor.version!==2)throw new Error("expected destination-set survivor");
      const survivorProgress=await loadDestinationProgress(survivor);
      const folded=await foldDestinationProgress(survivor,survivorProgress.events);
      expect(folded.completions.filter(Boolean)).toEqual([completion]);
      expect(survivor).toEqual(intentSide==="new"?newPlan:oldPlan);
      await expect(fs.access(genesisPaths(ACCOUNT).witness)).rejects.toThrow();
    }
  });
});
