import {env,SELF,applyD1Migrations} from "cloudflare:test";
import {beforeAll,describe,expect,test} from "vitest";

const BASE="https://example.com";const PLATFORM={"x-rbox-platform":"test-platform-secret","content-type":"application/json"};
beforeAll(async()=>{await applyD1Migrations(env.rbox_dev_db,env.TEST_MIGRATIONS);});
async function account(name:string){const r=await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({secret:"test-bootstrap-secret",accountName:name})});expect(r.status).toBe(200);return r.json() as Promise<{token:string;accountId:string;deviceId:string}>;}
const auth=(token:string,extra:Record<string,string>={})=>({authorization:`Bearer ${token}`,...extra});
const body=(deviceId:string,repairId?:string)=>({recoveryWrap:"rw",recoveryWrapId:"rwid",genesisRoster:"roster-v0",genesisKeyState:"keystate-0",device:{deviceId,sigPubKey:"sig",encPubKey:"enc",mkWrap:"mk"},...(repairId?{repairId}:{})});
async function bootstrapKeys(a:{token:string;deviceId:string},over:Record<string,unknown>={},cap=true){return SELF.fetch(`${BASE}/v1/keys/bootstrap`,{method:"POST",headers:auth(a.token,{"content-type":"application/json",...(cap?{"x-rbox-genesis-capability":"1"}:{})}),body:JSON.stringify({...body(a.deviceId),...over})});}
const repairBody=(accountId:string,dryRun:boolean)=>JSON.stringify({accountId,operator:"on-call@example.com",reason:"support case RBOX-180: split genesis",dryRun});
const adminRepair=(accountId:string,dryRun=false)=>SELF.fetch(`${BASE}/v1/admin/account/${accountId}/genesis-repair`,{method:"POST",headers:PLATFORM,body:repairBody(accountId,dryRun)});
async function oldClaim(accountId:string,wrap="legacy-wrap",wrapId="legacy-id",createdAt=123){await env.rbox_dev_db.prepare("INSERT INTO account_keys(account_id,recovery_wrap,recovery_wrap_id,created_at) VALUES(?,?,?,?)").bind(accountId,wrap,wrapId,createdAt).run();}

describe("design 180 atomic genesis",()=>{
  test("absent observation is exhaustive version 1",async()=>{const a=await account("g180-absent");const r=await SELF.fetch(`${BASE}/v1/keys/account`,{headers:auth(a.token)});expect(r.status).toBe(404);expect(await r.json()).toEqual({error:"not_found",genesisPresenceVersion:1,present:{rosters:0,keyStates:0,devices:0,workspaces:0,workspaceKeys:0,e2eePairingTokens:0}});});

  test("ordinary publication is all-four atomic and exact-field idempotent",async()=>{const a=await account("g180-ordinary");expect((await bootstrapKeys(a)).status).toBe(200);expect((await bootstrapKeys(a)).status).toBe(200);expect((await bootstrapKeys(a,{genesisRoster:"different"})).status).toBe(409);const counts=await env.rbox_dev_db.prepare(`SELECT (SELECT COUNT(*) FROM account_keys WHERE account_id=?1) a,(SELECT COUNT(*) FROM rosters WHERE account_id=?1) r,(SELECT COUNT(*) FROM account_key_states WHERE account_id=?1) k,(SELECT COUNT(*) FROM device_keys WHERE account_id=?1) d`).bind(a.accountId).first<{a:number;r:number;k:number;d:number}>();expect(counts).toEqual({a:1,r:1,k:1,d:1});});

  test("exact idempotency rejects every mutable opaque replay field",async()=>{const a=await account("g180-eight-fields");expect((await bootstrapKeys(a)).status).toBe(200);const base=body(a.deviceId),variants=[{...base,recoveryWrap:"x"},{...base,recoveryWrapId:"x"},{...base,genesisRoster:"x"},{...base,genesisKeyState:"x"},{...base,device:{...base.device,sigPubKey:"x"}},{...base,device:{...base.device,encPubKey:"x"}},{...base,device:{...base.device,mkWrap:"x"}}];for(const variant of variants){const r=await SELF.fetch(`${BASE}/v1/keys/bootstrap`,{method:"POST",headers:auth(a.token,{"content-type":"application/json","x-rbox-genesis-capability":"1"}),body:JSON.stringify(variant)});expect(r.status).toBe(409);expect(await r.json()).toEqual({error:"already_bootstrapped"});}const wrongDevice=await bootstrapKeys(a,{device:{...base.device,deviceId:"dev_other"}});expect(wrongDevice.status).toBe(403);});

  test("admin dry-run audits and execute installs a non-pristine tombstone",async()=>{const a=await account("g180-repair");await env.rbox_dev_db.prepare("INSERT INTO account_keys(account_id,recovery_wrap,recovery_wrap_id,created_at) VALUES(?,?,?,?)").bind(a.accountId,"legacy-wrap","legacy-id",123).run();const hidden=await SELF.fetch(`${BASE}/v1/admin/account/${a.accountId}/genesis-repair`,{method:"POST",headers:{"content-type":"application/json"},body:repairBody(a.accountId,true)});expect(hidden.status).toBe(404);
    const dry=await SELF.fetch(`${BASE}/v1/admin/account/${a.accountId}/genesis-repair`,{method:"POST",headers:PLATFORM,body:repairBody(a.accountId,true)});expect(dry.status).toBe(200);expect(await dry.json()).toMatchObject({ok:true,dryRun:true,classification:"exact_legacy_orphan",result:"no_change"});
    const exec=await SELF.fetch(`${BASE}/v1/admin/account/${a.accountId}/genesis-repair`,{method:"POST",headers:PLATFORM,body:repairBody(a.accountId,false)});expect(exec.status).toBe(200);const result=await exec.json() as {repairId:string;auditId:string};expect(result.repairId).toBe(result.auditId);
    const observed=await SELF.fetch(`${BASE}/v1/keys/account`,{headers:auth(a.token)});expect(observed.status).toBe(200);expect(await observed.json()).toMatchObject({genesisPresenceVersion:1,recoveryWrap:"rbox:genesis-repair-tombstone:v1",repairTombstone:{version:1,repairId:result.repairId},present:{rosters:0,keyStates:0,devices:0,workspaces:0,workspaceKeys:0,e2eePairingTokens:0}});
    expect((await bootstrapKeys(a,{repairId:result.repairId},false)).status).toBe(428);expect((await bootstrapKeys(a,{},false)).status).toBe(423);const repaired=await bootstrapKeys(a,{repairId:result.repairId},true);expect({status:repaired.status,body:await repaired.json()}).toEqual({status:200,body:{ok:true}});const replay=await bootstrapKeys(a,{repairId:result.repairId},true);expect({status:replay.status,body:await replay.json()}).toEqual({status:200,body:{ok:true,idempotent:true}});
  });

  test("tombstone and erasure fences precede workspace side effects",async()=>{const a=await account("g180-fence");await env.rbox_dev_db.prepare("INSERT INTO account_keys(account_id,recovery_wrap,recovery_wrap_id,created_at,repair_id,repaired_at) VALUES(?,?,?,?,?,?)").bind(a.accountId,"rbox:genesis-repair-tombstone:v1","rbox:genesis-repair-tombstone:v1",1,"gra_"+"a".repeat(32),2).run();const ws=await SELF.fetch(`${BASE}/v1/workspaces?project=root`,{method:"POST",headers:auth(a.token)});expect(ws.status).toBe(423);expect(await ws.json()).toEqual({error:"repair_in_progress"});expect(await env.rbox_dev_db.prepare("SELECT 1 FROM workspaces WHERE account_id=?").bind(a.accountId).first()).toBeNull();
    await env.rbox_dev_db.prepare("INSERT INTO account_deletions(account_id,requested_at,purge_after,status) VALUES(?,?,?,'done')").bind(a.accountId,1,1).run();const erased=await SELF.fetch(`${BASE}/v1/workspaces?project=root`,{method:"POST",headers:auth(a.token)});expect(erased.status).toBe(410);expect(await erased.json()).toEqual({error:"account_erased"});});

  test("bootstrap 410 precedes every tombstone, repair-id, and capability response",async()=>{const a=await account("g180-erased-bootstrap"),repairId="gra_"+"b".repeat(32);await env.rbox_dev_db.prepare("INSERT INTO account_keys(account_id,recovery_wrap,recovery_wrap_id,created_at,repair_id,repaired_at) VALUES(?,?,?,?,?,?)").bind(a.accountId,"rbox:genesis-repair-tombstone:v1","rbox:genesis-repair-tombstone:v1",1,repairId,2).run();await env.rbox_dev_db.prepare("INSERT INTO account_deletions(account_id,requested_at,purge_after,status) VALUES(?,?,?,'done')").bind(a.accountId,1,1).run();for(const [over,cap] of [[{},false],[{repairId:"gra_"+"c".repeat(32)},true],[{repairId},false],[{repairId},true]] as const){const r=await bootstrapKeys(a,over,cap);expect(r.status).toBe(410);expect(await r.json()).toEqual({error:"account_erased"});}const rows=await env.rbox_dev_db.prepare("SELECT (SELECT COUNT(*) FROM rosters WHERE account_id=?1) r,(SELECT COUNT(*) FROM device_keys WHERE account_id=?1) d").bind(a.accountId).first();expect(rows).toEqual({r:0,d:0});});

  test("all pairing-token inserts honor both erasure-ledger states, including non-E2EE",async()=>{for(const status of ["purging","done"]){const a=await account(`g180-pair-erased-${status}`);await env.rbox_dev_db.prepare("INSERT INTO account_deletions(account_id,requested_at,purge_after,status) VALUES(?,?,?,?)").bind(a.accountId,1,1,status).run();const r=await SELF.fetch(`${BASE}/v1/auth/pair/create`,{method:"POST",headers:auth(a.token,{"content-type":"application/json"}),body:"{}"});expect(r.status,status).toBe(410);expect(await r.json(),status).toEqual({error:"account_erased"});expect(await env.rbox_dev_db.prepare("SELECT 1 FROM pairing_tokens WHERE account_id=?").bind(a.accountId).first(),status).toBeNull();}});

  test("repair execute records audit=1,update=0 for every dependent-row guard",async()=>{
    const cases:Array<[string,(accountId:string)=>Promise<unknown>,string]>=[
      ["roster",id=>env.rbox_dev_db.prepare("INSERT INTO rosters(account_id,version,signed,created_at) VALUES(?,0,'r',1)").bind(id).run(),"dependent_rows"],
      ["key-state",id=>env.rbox_dev_db.prepare("INSERT INTO account_key_states(account_id,account_epoch,signed,created_at) VALUES(?,0,'k',1)").bind(id).run(),"dependent_rows"],
      ["device",id=>env.rbox_dev_db.prepare("INSERT INTO device_keys(device_id,account_id,created_at) VALUES(?,?,1)").bind(`dev_guard_${id}`,id).run(),"dependent_rows"],
      ["workspace-key",id=>env.rbox_dev_db.prepare("INSERT INTO workspace_keys(workspace_id,account_id,key_epoch,kek_wrap,created_at) VALUES(?,?,0,'k',1)").bind(`ws_key_${id}`,id).run(),"dependent_rows"],
      ["E2EE pairing token",id=>env.rbox_dev_db.prepare("INSERT INTO pairing_tokens(token_hash,account_id,user_id,created_by,created_at,expires_at,mk_wrap) VALUES(?,?,?,?,1,9999999999999,'mk')").bind(`pt_guard_${id}`,id,"user_guard","dev_guard").run(),"dependent_rows"],
      ["workspace",id=>env.rbox_dev_db.prepare("INSERT INTO workspaces(workspace_id,project_id,account_id,created_at) VALUES(?,'root',?,1)").bind(`ws_guard_${id}`,id).run(),"workspace_history"],
    ];
    for(const [label,seed,classification] of cases){
      const a=await account(`g180-guard-${label}`);await oldClaim(a.accountId);await seed(a.accountId);
      const response=await adminRepair(a.accountId);expect(response.status,label).toBe(409);
      const result=await response.json() as {auditId:string;classification:string};expect(result.classification,label).toBe("repair_refused_state_changed");
      const audit=await env.rbox_dev_db.prepare("SELECT observed_classification,outcome,result_vector FROM genesis_repair_audit WHERE audit_id=?").bind(result.auditId).first();
      expect(audit,label).toEqual({observed_classification:classification,outcome:"refused",result_vector:"audit=1,update=0"});
      const claim=await env.rbox_dev_db.prepare("SELECT recovery_wrap,repair_id FROM account_keys WHERE account_id=?").bind(a.accountId).first();
      expect(claim,label).toEqual({recovery_wrap:"legacy-wrap",repair_id:null});
    }
  });

  test("a completed competitor audit never turns an otherwise eligible execute into terminal conflict",async()=>{
    const a=await account("g180-completed-competitor");await oldClaim(a.accountId);
    await env.rbox_dev_db.prepare(`INSERT INTO genesis_repair_audit
      (audit_id,account_id,operator,reason,requested_at,dry_run,observed_classification,proof_json,outcome,result_vector,completed_at,scrubbed_evidence_sha256)
      VALUES(?,?,?,?,1,0,'exact_legacy_orphan','{}','refused','audit=1,update=0',2,'digest')`)
      .bind(`gra_${"d".repeat(32)}`,a.accountId,"prior@example.com","lost race").run();
    const response=await adminRepair(a.accountId);expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ok:true,result:"tombstone_claim_installed"});
    expect(await env.rbox_dev_db.prepare("SELECT COUNT(*) n FROM genesis_repair_audit WHERE account_id=? AND outcome='attempted'").bind(a.accountId).first()).toEqual({n:0});
  });

  test("stranded repair audits reconcile deterministically before account observation",async()=>{
    const installed=await account("g180-reconcile-installed"),installedId=`gra_${"e".repeat(32)}`;
    await env.rbox_dev_db.prepare("INSERT INTO account_keys(account_id,recovery_wrap,recovery_wrap_id,created_at,repair_id,repaired_at) VALUES(?,?,?,?,?,?)").bind(installed.accountId,"rbox:genesis-repair-tombstone:v1","rbox:genesis-repair-tombstone:v1",1,installedId,2).run();
    await env.rbox_dev_db.prepare("INSERT INTO genesis_repair_audit(audit_id,account_id,requested_at,dry_run,outcome) VALUES(?,?,1,0,'attempted')").bind(installedId,installed.accountId).run();
    expect((await SELF.fetch(`${BASE}/v1/keys/account`,{headers:auth(installed.token)})).status).toBe(200);
    expect(await env.rbox_dev_db.prepare("SELECT outcome,result_vector,completed_at FROM genesis_repair_audit WHERE audit_id=?").bind(installedId).first()).toMatchObject({outcome:"tombstone_claim_installed",result_vector:"audit=1,update=1",completed_at:expect.any(Number)});

    const refused=await account("g180-reconcile-refused"),refusedId=`gra_${"f".repeat(32)}`;await oldClaim(refused.accountId);
    await env.rbox_dev_db.prepare("INSERT INTO genesis_repair_audit(audit_id,account_id,requested_at,dry_run,outcome) VALUES(?,?,1,0,'attempted')").bind(refusedId,refused.accountId).run();
    expect((await SELF.fetch(`${BASE}/v1/keys/account`,{headers:auth(refused.token)})).status).toBe(200);
    const refusedAudit=await env.rbox_dev_db.prepare("SELECT outcome,result_vector,completion_observation_json FROM genesis_repair_audit WHERE audit_id=?").bind(refusedId).first<{outcome:string;result_vector:string;completion_observation_json:string}>();
    expect(refusedAudit).toMatchObject({outcome:"refused",result_vector:"audit=1,update=0"});expect(JSON.parse(refusedAudit!.completion_observation_json)).toMatchObject({observational:true,claimShape:"old_endpoint_exact"});
  });

  test("deletion-first reverse order refuses repair before creating an audit",async()=>{
    for(const status of ["purging","done"]){const a=await account(`g180-delete-first-${status}`);await oldClaim(a.accountId);await env.rbox_dev_db.prepare("INSERT INTO account_deletions(account_id,requested_at,purge_after,status) VALUES(?,?,?,?)").bind(a.accountId,1,1,status).run();const response=await adminRepair(a.accountId);expect(response.status,status).toBe(410);expect(await env.rbox_dev_db.prepare("SELECT COUNT(*) n FROM genesis_repair_audit WHERE account_id=?").bind(a.accountId).first(),status).toEqual({n:0});}
  });

  test("workspace manifest and receipt writes fence tombstone and erasure before DO forwarding",async()=>{
    const a=await account("g180-sync-fence");const created=await SELF.fetch(`${BASE}/v1/workspaces?project=root`,{method:"POST",headers:auth(a.token)});expect(created.status).toBe(200);const {workspaceId}=await created.json() as {workspaceId:string};
    const repairId=`gra_${"1".repeat(32)}`;await env.rbox_dev_db.prepare("INSERT INTO account_keys(account_id,recovery_wrap,recovery_wrap_id,created_at,repair_id,repaired_at) VALUES(?,?,?,?,?,?)").bind(a.accountId,"rbox:genesis-repair-tombstone:v1","rbox:genesis-repair-tombstone:v1",1,repairId,2).run();
    const manifestUrl=`${BASE}/v1/ws/${workspaceId}/proj/root/manifests`,receiptUrl=`${BASE}/v1/ws/${workspaceId}/proj/root/receipts/redeem`;
    for(const url of [manifestUrl,receiptUrl]){const response=await SELF.fetch(url,{method:"POST",headers:auth(a.token,{"content-type":"application/json"}),body:"{}"});expect(response.status,url).toBe(423);expect(await response.json()).toEqual({error:"repair_in_progress"});}
    await env.rbox_dev_db.prepare("INSERT INTO account_deletions(account_id,requested_at,purge_after,status) VALUES(?,?,?,'purging')").bind(a.accountId,1,1).run();
    for(const url of [manifestUrl,receiptUrl]){const response=await SELF.fetch(url,{method:"POST",headers:auth(a.token,{"content-type":"application/json"}),body:"{}"});expect(response.status,url).toBe(410);expect(await response.json()).toEqual({error:"account_erased"});}
  });

  test("account observation returns arrays coherent with the same batch's presence counts",async()=>{
    const a=await account("g180-coherent-get");expect((await bootstrapKeys(a)).status).toBe(200);
    await env.rbox_dev_db.batch([
      env.rbox_dev_db.prepare("INSERT INTO rosters(account_id,version,signed,created_at) VALUES(?,1,'roster-v1',2)").bind(a.accountId),
      env.rbox_dev_db.prepare("INSERT INTO account_key_states(account_id,account_epoch,signed,created_at) VALUES(?,1,'keystate-1',2)").bind(a.accountId),
      env.rbox_dev_db.prepare("INSERT INTO device_keys(device_id,account_id,sig_pubkey,enc_pubkey,mk_wrap,created_at) VALUES(?,?,?,?,?,2)").bind(`dev_coherent_${a.accountId}`,a.accountId,"sig2","enc2","mk2"),
    ]);
    const response=await SELF.fetch(`${BASE}/v1/keys/account`,{headers:auth(a.token)});expect(response.status).toBe(200);const observed=await response.json() as {rosters:unknown[];keyStates:unknown[];devices:unknown[];present:{rosters:number;keyStates:number;devices:number}};
    expect(observed.present.rosters).toBe(observed.rosters.length);expect(observed.present.keyStates).toBe(observed.keyStates.length);expect(observed.present.devices).toBe(observed.devices.length);expect(observed.present).toMatchObject({rosters:2,keyStates:2,devices:2});
  });
});
