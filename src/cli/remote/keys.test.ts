import {afterEach,describe,expect,test} from "bun:test";
import {RboxApi} from "./api.js";
import {AccountAlreadyBootstrappedError,errorCode,GenesisBootstrapTerminalError,LEGACY_GENESIS_SERVICE_MESSAGE,LegacyGenesisServiceError} from "./errors.js";
import {bootstrapKeys} from "./keys.js";
import type {RemoteContext} from "./context.js";

const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});
const response=(body:unknown,status=200)=>{globalThis.fetch=(async()=>new Response(JSON.stringify(body),{status})) as typeof fetch;return new RboxApi("https://api.test","tok","","");};

describe("genesis observation server-transition contract",()=>{
  test("legacy 404 shape is a typed terminal rollout error",async()=>{const api=response({error:"not_found"},404);const error=await api.getGenesisObservation().catch(value=>value);expect(error).toBeInstanceOf(LegacyGenesisServiceError);expect(error.message).toBe(LEGACY_GENESIS_SERVICE_MESSAGE);});
  test("legacy AccountKeysDTO shape is the same typed terminal rollout error",async()=>{const api=response({recoveryWrap:null,recoveryWrapId:null,rosters:[],keyStates:[],devices:[]});const error=await api.getGenesisObservation().catch(value=>value);expect(error).toBeInstanceOf(LegacyGenesisServiceError);expect(error.message).toBe(LEGACY_GENESIS_SERVICE_MESSAGE);});
  test("actually malformed missing-version shape keeps the corruption error",async()=>{const api=response({error:"not_found",present:{}},404);const error=await api.getGenesisObservation().catch(value=>value);expect(error).not.toBeInstanceOf(LegacyGenesisServiceError);expect(error.message).toBe("unsupported or malformed genesis presence response");});
});

test("errorCode accepts only string discriminators on JSON objects",()=>{
  expect(errorCode('{"error":"body_too_large"}')).toBe("body_too_large");
  for(const text of ['{}','{"error":1}','{"error":null}','null','[]','"error"','42','{']){
    expect(errorCode(text)).toBeUndefined();
  }
});

const context=(res:Response)=>({postExactJson:async()=>res}) as unknown as RemoteContext;

describe("bootstrap error discriminators",()=>{
  test("410 keeps custom string codes and the account_erased fallback",async()=>{
    const custom=await bootstrapKeys(context(new Response('{"error":"custom_erasure"}',{status:410})),"{}").catch(cause=>cause);
    expect(custom).toBeInstanceOf(GenesisBootstrapTerminalError);
    expect(custom).toMatchObject({status:410,code:"custom_erasure"});
    const malformed=await bootstrapKeys(context(new Response("null",{status:410})),"{}").catch(cause=>cause);
    expect(malformed).toMatchObject({status:410,code:"account_erased"});
  });
  test("409 already_bootstrapped preserves its typed throw-through",async()=>{
    await expect(bootstrapKeys(context(new Response('{"error":"already_bootstrapped"}',{status:409})),"{}")).rejects.toBeInstanceOf(AccountAlreadyBootstrappedError);
  });
});
