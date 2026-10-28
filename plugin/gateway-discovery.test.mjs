import {test} from 'node:test';
import assert from 'node:assert/strict';
import {discoverGateway,startGatewayDiscovery} from './gateway-discovery.mjs';
test('loopback discovery verifies models and never uses plugin serverUrl',async()=>{
 let requested;const config=await discoverGateway({}, {MAGPIE_ADDR:'127.0.0.1:19999',XDG_CONFIG_HOME:'/missing'},async(url,init)=>{requested=url;assert.equal(init.headers.authorization,'Bearer magpie');return {ok:true,json:async()=>({data:[]})}});
 assert.equal(requested,'http://127.0.0.1:19999/v1/models');assert.equal(config.gateway_key,'magpie');
});
test('non-loopback automatic discovery and invalid responses do not persist credentials',async()=>{
 let calls=0;assert.equal(await discoverGateway({}, {MAGPIE_ADDR:'example.com:3425'},async()=>{calls++}),undefined);assert.equal(calls,0);
 assert.equal(await discoverGateway({gatewayURL:'http://127.0.0.1:3425'},{},async()=>({ok:false})),undefined);
 assert.equal(await discoverGateway({gatewayURL:'https://remote.example'},{},async()=>{calls++}),undefined);assert.equal(calls,0);
});
test('wildcard listeners are verified through loopback addresses', async()=>{
 for(const [address,expected] of [['0.0.0.0:3425','127.0.0.1:3425'],['[::]:3425','[::1]:3425'],[':3425','127.0.0.1:3425']]){
  const cfg=await discoverGateway({}, {MAGPIE_ADDR:address,XDG_CONFIG_HOME:'/missing'},async url=>{
   assert.equal(url,`http://${expected}/v1/models`);return {ok:true,json:async()=>({data:[]})};
  });
  assert.equal(cfg.gateway_url,`http://${expected}`);
 }
});
test('effort is forwarded only when the plugin option names one', async()=>{
 const ok=async()=>({ok:true,json:async()=>({data:[]})});
 assert.equal((await discoverGateway({},{MAGPIE_ADDR:'127.0.0.1:19999',XDG_CONFIG_HOME:'/missing'},ok)).effort,undefined);
 assert.equal((await discoverGateway({effort:'  '},{MAGPIE_ADDR:'127.0.0.1:19999',XDG_CONFIG_HOME:'/missing'},ok)).effort,undefined);
 assert.equal((await discoverGateway({effort:'HIGH'},{MAGPIE_ADDR:'127.0.0.1:19999',XDG_CONFIG_HOME:'/missing'},ok)).effort,'high');
});
test('new gateway defaults to observation and accepts an explicit harness scope', async()=>{
 const ok=async()=>({ok:true,json:async()=>({data:[]})});
 const env={MAGPIE_ADDR:'127.0.0.1:19999',XDG_CONFIG_HOME:'/missing'};
 const defaults=await discoverGateway({},env,ok);
 assert.equal(defaults.gate_mode,'observe');assert.equal(defaults.gate_agents,'');
 const scoped=await discoverGateway({gateMode:'strict',gateAgents:'pi,codex'},env,ok);
 assert.equal(scoped.gate_mode,'strict');assert.equal(scoped.gate_agents,'pi,codex');
});
test('background discovery retries delayed startup and stops after saving',async()=>{
 let attempts=0,saved=0;
 const stop=startGatewayDiscovery({origin:'http://fixture',control:'control'}, {},{
  interval:5,
  discover:async()=>++attempts<3?undefined:{gateway_url:'http://127.0.0.1:3425',gateway_key:'magpie'},
  fetch:async(url,init)=>{
   assert.equal(init.headers.authorization,'Bearer control');
   if(url.endsWith('/initial')){saved++;return {ok:true};}
   return {ok:true,json:async()=>({state:{config:{gateway_url:''}}})};
  },
 });
 try {await new Promise(r=>setTimeout(r,100));assert.equal(attempts,3);assert.equal(saved,1);}
 finally{stop();}
});
test('saved manual configuration prevents discovery and cancellation prevents writes',async()=>{
 let attempts=0;
 const stop=startGatewayDiscovery({origin:'http://fixture',control:'control'}, {},{
  interval:5,discover:async()=>{attempts++;},fetch:async()=>({ok:true,json:async()=>({state:{config:{gateway_url:'https://manual.example'}}})}),
 });
 await new Promise(r=>setTimeout(r,20));stop();assert.equal(attempts,0);
 let finish,writes=0;
 const cancel=startGatewayDiscovery({origin:'http://fixture',control:'control'}, {},{
  interval:5,discover:()=>new Promise(resolve=>{finish=resolve;}),fetch:async(url)=>{
   if(url.endsWith('/initial'))writes++;
   return {ok:true,json:async()=>({state:{config:{gateway_url:''}}})};
  },
 });
 await new Promise(r=>setTimeout(r,20));cancel();finish({gateway_url:'http://127.0.0.1:3425'});
 await new Promise(r=>setTimeout(r,20));assert.equal(writes,0);
});
