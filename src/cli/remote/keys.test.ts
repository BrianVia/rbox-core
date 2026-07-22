import {afterEach,describe,expect,test} from "bun:test";
import {RboxApi} from "./api.js";
import {LEGACY_GENESIS_SERVICE_MESSAGE,LegacyGenesisServiceError} from "./errors.js";

const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});
const response=(body:unknown,status=200)=>{globalThis.fetch=(async()=>new Response(JSON.stringify(body),{status})) as typeof fetch;return new RboxApi("https://api.test","tok","","");};

describe("genesis observation server-transition contract",()=>{
  test("legacy 404 shape is a typed terminal rollout error",async()=>{const api=response({error:"not_found"},404);const error=await api.getGenesisObservation().catch(value=>value);expect(error).toBeInstanceOf(LegacyGenesisServiceError);expect(error.message).toBe(LEGACY_GENESIS_SERVICE_MESSAGE);});
  test("legacy AccountKeysDTO shape is the same typed terminal rollout error",async()=>{const api=response({recoveryWrap:null,recoveryWrapId:null,rosters:[],keyStates:[],devices:[]});const error=await api.getGenesisObservation().catch(value=>value);expect(error).toBeInstanceOf(LegacyGenesisServiceError);expect(error.message).toBe(LEGACY_GENESIS_SERVICE_MESSAGE);});
  test("actually malformed missing-version shape keeps the corruption error",async()=>{const api=response({error:"not_found",present:{}},404);const error=await api.getGenesisObservation().catch(value=>value);expect(error).not.toBeInstanceOf(LegacyGenesisServiceError);expect(error.message).toBe("unsupported or malformed genesis presence response");});
});
