import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseYaml, stringifyYaml } from '../src/yaml';
import { ROUTING_KEYS, validateRoutingProfile } from '../src/domain/routing-profile';
import { loadActiveDesiredConfig, TextKv } from '../src/storage/config-state';
import { upstreamIdForName } from '../src/domain/merge';
import { upstreamSourceFingerprint, putUpstreamCache, putUpstreamState } from '../src/storage/upstream-cache';
import { buildDefaultMaterializedArtifact } from '../src/subscription';
import { Env, ProxyNode } from '../src/types';
import { DesiredConfigV2, UpstreamDefinition } from '../src/domain/config';

const root = path.join(process.env.HOME!, 'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev');
const work = path.resolve('.wrangler/verge-routing-migration');
const account = '52f2d11d4f24ec1988178f11a0732948';
const namespace = '58dfb8a63c1b43f58c840d3b14bfae80';
const origin = 'https://clash.guoyingwei.top';
const api = `https://api.cloudflare.com/client/v4/accounts/${account}`;
const kvUrl = `${api}/storage/kv/namespaces/${namespace}/values/`;
const token = cp.execFileSync('python3', ['-c',
  'import tomllib,pathlib; print(tomllib.loads((pathlib.Path.home()/"Library/Preferences/.wrangler/config/default.toml").read_text())["oauth_token"])'
], { encoding: 'utf8' }).trim();
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
function save(name: string, content: string) {
  fs.writeFileSync(path.join(work, name), content, { mode: 0o600 });
}
async function get(key: string) {
  const r = await fetch(kvUrl + encodeURIComponent(key), {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`KV read HTTP ${r.status}`);
  return r.text();
}
async function put(key: string, value: string) {
  const r = await fetch(kvUrl + encodeURIComponent(key), {
    method: 'PUT', headers: { Authorization: `Bearer ${token}` },
    body: value, signal: AbortSignal.timeout(20000),
  });
  if (!r.ok || !(await r.json() as { success: boolean }).success) throw new Error(`KV write failed: ${key}`);
}
class MemoryKv implements TextKv {
  constructor(readonly values: Record<string, string>) {}
  async get(key: string) { return this.values[key] ?? null; }
  async put(key: string, value: string) { this.values[key] = value; }
  async delete(key: string) { delete this.values[key]; }
}
async function prepare() {
  if (fs.existsSync(path.join(work, 'pending.json'))) throw new Error('Existing prepared migration; inspect it before replacing');
  fs.mkdirSync(work, { recursive: true, mode: 0o700 });
  const bytes = fs.readFileSync(path.join(root, 'clash-verge.yaml'));
  const local = parseYaml<Record<string, any>>(bytes.toString())!;
  const routing = validateRoutingProfile(Object.fromEntries(
    ROUTING_KEYS.filter(key => key in local).map(key => [key, local[key]])
  ));
  const backup: Record<string, string | null> = {};
  for (const key of ['config:v2:active', 'upstreams', 'custom-nodes', 'users']) backup[key] = await get(key);
  const old = new MemoryKv(Object.fromEntries(Object.entries(backup).filter((e): e is [string,string] => e[1] !== null)));
  const current = await loadActiveDesiredConfig(old);
  const desired: DesiredConfigV2 = {
    schemaVersion: 2, revision: `r_verge_${Date.now()}`, updatedAt: new Date().toISOString(),
    upstreams: [], customNodes: local.proxies as ProxyNode[],
    policy: {filterUpstreamInfoNodes:false,missingCache:'serve-stale',maxCacheAgeSeconds:21600,routingProfile:routing},
  };
  const memory = new MemoryKv({});
  for (const [name, raw] of Object.entries(local['proxy-providers']) as [string,Record<string,any>][]) {
    const existing = current.upstreams.find(u => u.name === name);
    const options = structuredClone(raw);
    delete options.url;
    // Preserve provider overrides and health checks; headers do not belong in inline output.
    const ua = raw.header?.['User-Agent'];
    const def: UpstreamDefinition = {
      id: existing?.id ?? upstreamIdForName(name), name, url: raw.url,
      userAgent: Array.isArray(ua) ? ua[0] : ua || 'clash.meta',
      prefix: raw.override?.['additional-prefix'] ?? '',
      exclude: raw['exclude-filter'],
      fetchMode: existing?.fetchMode ?? 'server', required: true, providerOptions: options,
    };
    desired.upstreams.push(def);
    const cachePath = path.resolve(root, raw.path);
    if (!cachePath.startsWith(root + '/')) throw new Error('Unexpected local provider cache path');
    const content = fs.readFileSync(cachePath, 'utf8');
    const nodes = parseYaml<{proxies:ProxyNode[]}>(content)?.proxies;
    if (!nodes?.length) throw new Error(`Empty local cache: ${name}`);
    const stamp = fs.statSync(cachePath).mtime.toISOString();
    const fingerprint = await upstreamSourceFingerprint(def);
    await putUpstreamCache(memory, {schemaVersion:1,upstreamId:def.id,sourceFingerprint:fingerprint,content,
      updatedAt:stamp,nodeCount:nodes.length});
    await putUpstreamState(memory, {upstreamId:def.id,sourceFingerprint:fingerprint,
      lastAttemptAt:stamp,lastSuccessAt:stamp,cacheUpdatedAt:stamp,nodeCount:nodes.length,
      lastError:null,consecutiveFailures:0,nextRetryAt:null});
  }
  const extras = current.upstreams.filter(u => !desired.upstreams.some(d => d.name === u.name));
  desired.upstreams.push(...extras.map(u => ({...u,fetchMode:'disabled' as const})));
  desired.materializedArtifact = await buildDefaultMaterializedArtifact(desired, {KV:memory as unknown as KVNamespace} as Env);
  const output = parseYaml<Record<string,any>>(desired.materializedArtifact.yaml)!;
  const checks = Object.fromEntries(Object.entries(routing).map(([key,value]) => [
    key, JSON.stringify(output[key]) === JSON.stringify(value),
  ]));
  if (Object.values(checks).some(v => !v)) throw new Error('Routing roundtrip differs from Verge');
  for (const key of Object.keys(memory.values)) backup[key] = await get(key);
  const deployment = await fetch(`${api}/workers/scripts/clash-sub-hub/deployments`, {
    headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000),
  });
  if (!deployment.ok) throw new Error('Could not backup deployment metadata');
  save('deployments-before.json', await deployment.text());
  save('backup.json', JSON.stringify(backup));
  save('routing-dns.yaml', stringifyYaml(routing));
  save('candidate.yaml', desired.materializedArtifact.yaml);
  save('pending.json', JSON.stringify({baselineHash:hash(bytes),expectedActive:backup['config:v2:active'],
    values:memory.values,desired}));
  console.log(JSON.stringify({prepared:true,rules:local.rules.length,groups:local['proxy-groups'].length,
    ruleProviders:Object.keys(local['rule-providers']).length,checks,
    disabledOnlineOnly:extras.map(u=>u.name),privateDirectory:work}));
}
async function apply() {
  const p = JSON.parse(fs.readFileSync(path.join(work,'pending.json'),'utf8'));
  if (hash(fs.readFileSync(path.join(root,'clash-verge.yaml'))) !== p.baselineHash) throw new Error('Verge changed; reprepare required');
  if (await get('config:v2:active') !== p.expectedActive) throw new Error('Online config changed; reprepare required');
  for(const [key,value] of Object.entries(p.values)) await put(key,value as string);
  await put(`config:v2:revision:${p.desired.revision}`,JSON.stringify(p.desired));
  await put('config:v2:active',JSON.stringify(p.desired));
  if(await get('config:v2:active')!==JSON.stringify(p.desired)) throw new Error('Active config read-back differs');
  save('applied.json',JSON.stringify({revision:p.desired.revision,at:new Date().toISOString()}));
  console.log('Applied and verified active strategy and node caches; Verge unchanged');
}
async function rebuild() {
  const p = JSON.parse(fs.readFileSync(path.join(work,'pending.json'),'utf8'));
  if (hash(fs.readFileSync(path.join(root,'clash-verge.yaml'))) !== p.baselineHash) throw new Error('Verge changed');
  validateRoutingProfile(p.desired.policy.routingProfile);
  p.desired.materializedArtifact = await buildDefaultMaterializedArtifact(p.desired, {
    KV:new MemoryKv(p.values) as unknown as KVNamespace,
  } as Env);
  save('candidate.yaml',p.desired.materializedArtifact.yaml);
  save('pending.json',JSON.stringify(p));
  console.log('Rebuilt private candidate from unchanged baseline and cached snapshot');
}
async function verify() {
  const p=JSON.parse(fs.readFileSync(path.join(work,'pending.json'),'utf8'));
  const users=JSON.parse(await get('users') || '[]');
  const reports=[];
  for(let i=0;i<users.length;i++){
    const u=users[i];
    if(!u.enabled || !u.token) continue;
    const link=`${origin}/sub/${encodeURIComponent(u.token)}`;
    const r=await fetch(link,{signal:AbortSignal.timeout(30000)});
    if(!r.ok) throw new Error(`Subscription ${i}: HTTP ${r.status}`);
    const text=await r.text();
    const doc=parseYaml<Record<string,any>>(text)!;
    for(const [key,value] of Object.entries(p.desired.policy.routingProfile)){
      if(JSON.stringify(doc[key])!==JSON.stringify(value)) throw new Error(`Subscription ${i}: ${key} mismatch`);
    }
    if(JSON.stringify(doc.proxies)!==JSON.stringify(p.desired.customNodes)) throw new Error(`Subscription ${i}: custom node mismatch`);
    const candidate=parseYaml<Record<string,any>>(fs.readFileSync(path.join(work,'candidate.yaml'),'utf8'))!;
    if(JSON.stringify(doc['proxy-providers'])!==JSON.stringify(candidate['proxy-providers'])) throw new Error(`Subscription ${i}: provider mismatch`);
    save(`subscription-${i}.yaml`,text);
    save(`subscription-${i}-link.txt`,link+'\n');
    reports.push({testUser:i,status:r.status,rules:doc.rules.length,groups:doc['proxy-groups'].length,
      ruleProviders:Object.keys(doc['rule-providers']).length,providers:Object.keys(doc['proxy-providers']).length,
      nodes:Object.values(doc['proxy-providers']).reduce((n:number,v:any)=>n+v.payload.length,0),
      customNodes:doc.proxies.length,allRoutingFieldsEqual:true});
  }
  if(!reports.length) throw new Error('No existing test link available to verify');
  if(hash(fs.readFileSync(path.join(root,'clash-verge.yaml'))) !== p.baselineHash) throw new Error('Verge baseline changed');
  save('verification.json',JSON.stringify(reports,null,2));
  console.log(JSON.stringify(reports,null,2));
}
async function status() {
  for(const suffix of ['deployments','schedules']){
    const response=await fetch(`${api}/workers/scripts/clash-sub-hub/${suffix}`,{
      headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000),
    });
    const body=await response.json() as any;
    save(`${suffix}-after.json`,JSON.stringify(body));
    console.log(JSON.stringify({section:suffix,status:response.status,result:body.result,errors:body.errors}));
  }
}
async function repairSchedule() {
  const endpoint=`${api}/workers/scripts/clash-sub-hub/schedules`;
  const before=await fetch(endpoint,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});
  const body=await before.json() as any;
  if(!before.ok || !body.success) throw new Error('Cannot inspect current schedules');
  const schedules=body.result.schedules;
  if(schedules.length && !(schedules.length===1 && schedules[0].cron==='17 * * * *')) {
    throw new Error('Different existing schedule; refusing replacement');
  }
  if(!schedules.length){
    const r=await fetch(endpoint,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify([{cron:'17 * * * *'}]),signal:AbortSignal.timeout(20000)});
    const result=await r.json() as any;
    save('schedule-repair.json',JSON.stringify(result));
    console.log(JSON.stringify({status:r.status,success:result.success,errors:result.errors}));
    if(!r.ok || !result.success) throw new Error('Schedule registration failed');
  }
  const final=await fetch(endpoint,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});
  const verified=await final.json() as any;
  if(!final.ok || !verified.result.schedules.some((s:any)=>s.cron==='17 * * * *')) throw new Error('Schedule read-back mismatch');
  console.log('Hourly refresh schedule registered and read back');
}
const action=process.argv[2];
(action==='--prepare'?prepare():action==='--apply'?apply():action==='--verify'?verify():action==='--rebuild'?rebuild():action==='--status'?status():action==='--repair-schedule'?repairSchedule():
  Promise.reject(new Error('Use --prepare, --apply, --verify or --rebuild')))
  .catch(e=>{console.error(e instanceof Error?e.message:'Migration failed');process.exitCode=1;});
