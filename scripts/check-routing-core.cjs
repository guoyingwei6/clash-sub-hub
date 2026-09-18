const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const net = require('node:net');
const dns = require('node:dns').promises;
const crypto = require('node:crypto');
const yaml = require('yaml');

const source = path.resolve(process.argv[2] || '.wrangler/verge-routing-migration/candidate.yaml');
const baselineRoot = path.join(process.env.HOME, 'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev');
const baselineFile = path.join(baselineRoot, 'clash-verge.yaml');
const baselineHash = crypto.createHash('sha256').update(fs.readFileSync(baselineFile)).digest('hex');
const dir = fs.mkdtempSync(path.resolve('.wrangler/routing-core-'));
fs.chmodSync(dir, 0o700);
const core = '/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo';
const config = yaml.parse(fs.readFileSync(source, 'utf8'));
let child;
async function port() {
  const server = net.createServer();
  await new Promise((resolve,reject) => server.listen(0,'127.0.0.1',resolve).on('error',reject));
  const p = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return p;
}
async function main() {
  for (const name of ['geoip.dat', 'geosite.dat', 'Country.mmdb', 'GeoLite2-ASN.mmdb']) {
    const from = path.join(baselineRoot, name);
    if (fs.existsSync(from)) fs.copyFileSync(from,path.join(dir,name));
  }
  for (const provider of Object.values(config['rule-providers'] || {})) {
    if (!provider.path) continue;
    const from = path.resolve(baselineRoot,provider.path);
    const dest = path.resolve(dir,provider.path);
    if (!from.startsWith(baselineRoot+'/') || !dest.startsWith(dir+'/')) throw new Error('Unsafe ruleset path');
    if (fs.existsSync(from)) {
      fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});
      fs.copyFileSync(from,dest);
    }
  }
  const schemaFile = path.join(dir,'schema.yaml');
  fs.writeFileSync(schemaFile,yaml.stringify(config),{mode:0o600});
  const check = cp.spawnSync(core,['-t','-d',dir,'-f',schemaFile],{encoding:'utf8',timeout:45000});
  fs.writeFileSync(path.join(dir,'schema.log'),(check.stdout||'')+(check.stderr||''),{mode:0o600});
  if(check.status!==0) throw new Error(`Core schema failed; private log: ${dir}/schema.log`);
  console.log('Mihomo schema validation passed');
  const controller = await port(), mixed = await port(), dnsPort = await port();
  const secret = crypto.randomBytes(24).toString('hex');
  const runtime = {...config,tun:{...config.tun,enable:false},'mixed-port':mixed,
    'allow-lan':false,'bind-address':'127.0.0.1','external-controller':`127.0.0.1:${controller}`,
    secret,'log-level':'error',dns:{...config.dns,listen:`127.0.0.1:${dnsPort}`}};
  fs.writeFileSync(path.join(dir,'runtime.yaml'),yaml.stringify(runtime),{mode:0o600});
  const fd = fs.openSync(path.join(dir,'runtime.log'),'w',0o600);
  child = cp.spawn(core,['-d',dir,'-f',path.join(dir,'runtime.yaml')],{stdio:['ignore',fd,fd]});
  fs.closeSync(fd);
  const api = async route => {
    const r = await fetch(`http://127.0.0.1:${controller}${route}`,{
      headers:{Authorization:`Bearer ${secret}`},signal:AbortSignal.timeout(15000)});
    return {status:r.status,data:await r.json()};
  };
  let ready = false;
  for(let i=0;i<100;i++){
    if(child.exitCode!==null) throw new Error('Isolated core exited before ready');
    try { ready=(await api('/version')).status===200; if(ready) break; } catch {}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(!ready) throw new Error('Isolated core startup timeout');
  const rules = await api('/rules');
  if(rules.data.rules?.length!==config.rules.length) throw new Error('Runtime rule count mismatch');
  const result = {schema:true,runtimeRules:rules.data.rules.length,dns:[],nodes:[]};
  const resolver = new dns.Resolver({timeout:5000,tries:1});
  resolver.setServers([`127.0.0.1:${dnsPort}`]);
  for(const domain of ['example.com','www.google.com']){
    try{
      const addresses=await resolver.resolve4(domain);
      result.dns.push({domain,ok:addresses.length>0});
    }catch{result.dns.push({domain,ok:false});}
  }
  await Promise.all(config.proxies.map(async node=>{
    try{
      const test = await api(`/proxies/${encodeURIComponent(node.name)}/delay?timeout=10000&url=${encodeURIComponent('https://www.gstatic.com/generate_204')}`);
      result.nodes.push({name:node.name,ok:test.status===200,delay:test.data.delay??null});
    }catch{result.nodes.push({name:node.name,ok:false});}
  }));
  const failed=result.nodes.filter(n=>!n.ok);
  for(const previous of failed){
    const node=config.proxies.find(n=>n.name===previous.name);
    if(!node?.['dialer-proxy']) continue;
    const group = await api(`/proxies/${encodeURIComponent(node['dialer-proxy'])}`);
    const firstSelected=group.data.now;
    // Lazy url-test groups may still be discovering a working relay on startup.
    await new Promise(resolve=>setTimeout(resolve,10000));
    const selected=await api(`/proxies/${encodeURIComponent(node['dialer-proxy'])}`);
    const retry=await api(`/proxies/${encodeURIComponent(node.name)}/delay?timeout=10000&url=${encodeURIComponent('https://www.gstatic.com/generate_204')}`);
    previous.initialFailure=true;
    previous.relaySelectionChanged=selected.data.now!==firstSelected;
    previous.ok=retry.status===200;
    previous.delay=retry.data.delay??null;
  }
  result.vergeUnchanged = crypto.createHash('sha256').update(fs.readFileSync(baselineFile)).digest('hex')===baselineHash;
  fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(result,null,2),{mode:0o600});
  console.log(JSON.stringify(result));
  console.log('Private test report:',path.join(dir,'report.json'));
  if(!result.vergeUnchanged || result.dns.some(d=>!d.ok) || result.nodes.some(n=>!n.ok)) process.exitCode=1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(async()=>{
  if(child && child.exitCode===null){
    child.kill('SIGTERM');
    await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);
    if(child.exitCode===null){child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));}
  }
});
