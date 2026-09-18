import { describe, expect, it } from 'vitest';
import { handleSubscription } from '../../src/subscription';
import { getRouting, updateRouting } from '../../src/admin';
import { parseRoutingYaml, validateRoutingProfile, validateRoutingReferences } from '../../src/domain/routing-profile';
import { parseMergeYaml, serializeMergeConfig } from '../../src/domain/merge';
import { loadActiveDesiredConfig } from '../../src/storage/config-state';
import { FakeKv } from '../helpers/fake-kv';
import { parseYaml, stringifyYaml } from '../../src/yaml';
import { Env } from '../../src/types';

const profile = {
  rules: ['IP-CIDR,100.64.0.0/10,DIRECT,no-resolve', 'DOMAIN,example.org,Home', 'MATCH,Relay'],
  'proxy-groups': [
    { name: 'Relay', type: 'url-test', use: ['Fixture'], filter: 'US', url: 'https://example.org/204', interval: 300 },
    { name: 'Home', type: 'select', proxies: ['Residential'] },
  ],
  'rule-providers': {},
  dns: { enable: true, 'enhanced-mode': 'fake-ip', 'nameserver-policy': { 'example.org': ['https://dns.example.org/dns-query'] } },
  hosts: { 'local.example.org': '192.0.2.1' },
  tun: { enable: true, mtu: 1500, 'route-exclude-address': ['100.64.0.0/10'] },
};
function environment(): Env {
  return { KV: new FakeKv({
    upstreams: JSON.stringify([{name:'Fixture',url:'https://source.invalid/sub',userAgent:'fixture',lastUpdate:new Date().toISOString()}]),
    'custom-nodes': JSON.stringify([{name:'Residential',type:'socks5',server:'192.0.2.3',port:1080,'dialer-proxy':'Relay'}]),
    users: JSON.stringify([{token:'fixture-routing-token',enabled:true}]),
    'cache:Fixture': stringifyYaml({proxies:[{name:'US fixture',type:'ss',server:'192.0.2.2',port:443,cipher:'aes-128-gcm',password:'fixture-password',sni:null,udp:false}]}),
  }) as unknown as KVNamespace } as Env;
}
function request(yaml: string, expectedRevision = 'legacy') {
  return new Request('https://hub.invalid/api/routing', {
    method:'PUT',body:JSON.stringify({yaml,expectedRevision}),
  });
}

describe('independent routing policy', () => {
  it('preserves order, DNS and group use/filter while embedding provider payloads', async () => {
    const env=environment();
    const response=await updateRouting(request(stringifyYaml(profile)),env);
    expect(response.status).toBe(200);
    const sub=await handleSubscription('fixture-routing-token',null,null,env);
    expect(sub.status).toBe(200);
    const text=await sub.text();
    const doc=parseYaml<Record<string, any>>(text)!;
    for(const [key,value] of Object.entries(profile)) expect(doc[key]).toEqual(value);
    expect(doc.proxies).toHaveLength(1);
    expect(doc['proxy-providers'].Fixture.type).toBe('inline');
    expect(doc['proxy-providers'].Fixture.payload[0].name).toBe('US fixture');
    expect(doc['proxy-providers'].Fixture.payload[0]).not.toHaveProperty('sni');
    expect(doc['proxy-providers'].Fixture.payload[0].udp).toBe(false);
    expect(doc['proxy-providers'].Fixture.override['additional-prefix']).toBe('Fixture | ');
    expect(text).not.toContain('source.invalid');
    expect((await getRouting(env)).status).toBe(200);
  });

  it('rejects machine-local controller fields and node credentials in a strategy', () => {
    for(const key of ['secret','external-controller','external-controller-unix','proxies','proxy-providers']){
      expect(()=>validateRoutingProfile({...profile,[key]:'fixture-secret'})).toThrow();
    }
    expect(()=>parseRoutingYaml('a: [')).toThrow();
  });

  it('rejects dangling references without publishing a new config', async () => {
    const env=environment();
    const invalid={...profile,rules:['MATCH,Missing']};
    const response=await updateRouting(request(stringifyYaml(invalid)),env);
    expect(response.status).toBe(400);
    expect((await loadActiveDesiredConfig(env.KV)).revision).toBe('legacy');
  });

  it('rejects a stale revision and retains rules on a nodes-only merge roundtrip', async () => {
    const env=environment();
    expect((await updateRouting(request(stringifyYaml(profile)),env)).status).toBe(200);
    expect((await updateRouting(request(stringifyYaml(profile)),env)).status).toBe(409);
    const active=await loadActiveDesiredConfig(env.KV);
    expect(parseMergeYaml(serializeMergeConfig(active)).policy.routingProfile).toEqual(profile);
    expect(parseMergeYaml('proxies: []',active).policy.routingProfile).toEqual(profile);
  });

  it('does not fall back to builtin rules when a user lacks a required provider', async () => {
    const env=environment();
    await updateRouting(request(stringifyYaml(profile)),env);
    await env.KV.put('users',JSON.stringify([{token:'fixture-routing-token',enabled:true,allowedUpstreams:[]}]));
    expect((await handleSubscription('fixture-routing-token',null,null,env)).status).toBe(500);
  });

  it.each([
    null, [], {},
    {...profile,rules:[]},
    {...profile,rules:[4]},
    {...profile,'proxy-groups':[]},
    {...profile,'proxy-groups':[{}]},
    {...profile,'proxy-groups':[profile['proxy-groups'][0],profile['proxy-groups'][0]]},
    {...profile,'proxy-groups':[{name:'x',type:'unknown'}]},
    {...profile,'proxy-groups':[{name:'x',type:'select',proxies:'bad'}]},
    {...profile,'proxy-groups':[{name:'x',type:'select',use:[1]}]},
    {...profile,'proxy-groups':[{name:'x',type:'select',filter:'['}]},
    {...profile,dns:[]},
    {...profile,dns:{enable:'true'}},
    {...profile,dns:{nameserver:3}},
    {...profile,dns:{'nameserver-policy':[]}},
    {...profile,dns:{'nameserver-policy':{'example.org':[false]}}},
    {...profile,hosts:[]},
    {...profile,ipv6:'yes'},
    {...profile,'rule-providers':{a:null}},
    {...profile,'rule-providers':{a:{type:'file'}}},
    {...profile,'rule-providers':{a:{type:'http',url:'file:///local'}}},
    {...profile,'rule-providers':{a:{type:'http',url:'not a url'}}},
    {...profile,'rule-providers':{a:{path:'/absolute.yaml'}}},
    {...profile,'rule-providers':{a:{path:'../outside.yaml'}}},
  ])('rejects malformed routing input %#', value => {
    expect(()=>validateRoutingProfile(value)).toThrow();
  });

  it('accepts native DNS and HTTP ruleset shapes without normalization', () => {
    const valid={...profile,ipv6:true,sniffer:{enable:false},'rule-providers':{
      example:{type:'http',url:'https://example.org/rules.yaml',path:'./ruleset/example.yaml'},
    },dns:{...profile.dns,'nameserver-policy':{'example.org':'https://example.org/dns-query'}}};
    expect(validateRoutingProfile(valid)).toEqual(valid);
  });

  it('validates group, chain and rule-set references', () => {
    const parsed=validateRoutingProfile(profile);
    expect(()=>validateRoutingReferences(parsed,{Fixture:{}},[])).toThrow();
    expect(()=>validateRoutingReferences(parsed,{Fixture:{}},[{name:'Residential','dialer-proxy':'Missing'}])).toThrow();
    expect(()=>validateRoutingReferences({...parsed,rules:['RULE-SET,absent,DIRECT']},{Fixture:{}},[{name:'Residential'}])).toThrow();
  });
});
