import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../storefront/src/http.js';
import { loadConfig } from '../storefront/src/config.js';
import { FixtureSource, FixtureOrderGateway, demoFixture } from '../storefront/src/fixture.js';
import { visitorNetwork } from '../storefront/src/network.js';
const key = 'a'.repeat(32);
function setup() {
  const data = new FixtureSource(demoFixture(10, { ordering: 'online' }));
  const gateway = new FixtureOrderGateway(data);
  const config = loadConfig({ ORDER_GATEWAY_KEY: 'test' });
  const call = (url: string, method = 'POST', body = '{}', headers = { 'content-type': 'application/json' }) => handle({ host: 'beirut-market.myomnipos.com', url, method, body, headers, network: 'hash' }, { config, data, gateway, assetVersion: 'test' });
  return { data, gateway, config, call };
}
test('order methods, body checks and private headers', async () => {
  const { call } = setup();
  for (const [url, method, body, status] of [['/order','GET','',405], ['/','POST','',405], ['/order','POST','{',400], ['/order','POST','x'.repeat(16385),413]] as const) {
    const r = await call(url, method, body); assert.equal(r.status, status); assert.equal(r.headers['Cache-Control'], 'no-store');
  }
  assert.equal((await call('/order', 'POST', '{}', { 'content-type': 'text/plain' })).status, 415);
  const r = await call('/order/quote'); assert.equal(r.headers['X-Robots-Tag'], 'noindex'); assert.equal(r.headers.Vary, undefined); assert.equal(r.headers['Set-Cookie'], undefined);
});
test('store gates, previews, invalid keys and upstream failures', async () => {
  const { call, data, gateway, config } = setup();
  assert.equal((await call('/o/bad','GET')).status,404);
  assert.equal(JSON.parse(String((await call('/order?preview=x')).body)).code,'refused');
  for (const mode of ['off','whatsapp','online'] as const) {
    data.fx.store.ordering_mode = mode; if (mode === 'online') config.orderGatewayKey = undefined;
    assert.equal(JSON.parse(String((await call('/order')).body)).code,'store_unavailable');
  }
  config.orderGatewayKey = 'test'; gateway.unavailable = true;
  const r = await call('/order/quote'); assert.equal(r.status,503); assert.equal(r.headers['Retry-After'],'30');
});
test('create, replay, status and cancel redirects', async () => {
  const { call, data } = setup();
  const payload = { attempt: 'attempt', status_key: key, customer: { name: 'Jane Doe', phone: '70123456', fulfilment: 'pickup' }, lines: [{ listing: data.fx.listings[0].listing_id, unit: 'base', qty: 10, price: 1.5 }], expected_total_usd: 15, website: '' };
  for (const code of ['created','existing']) { const r = await call('/order','POST',JSON.stringify(payload)); const b = JSON.parse(String(r.body)); assert.equal(b.code,code); assert.equal(b.status_url,`/o/${key}`); }
  const status = await call(`/o/${key}`,'GET'); assert.equal(status.status,200); assert.equal(status.headers['Cache-Control'],'private, no-store'); assert.equal(status.headers['Referrer-Policy'],'no-referrer'); assert.match(String(status.body),/W-1001/); assert.match(String(status.body),/submitted/);
  for (const flag of ['cancelled','not_cancellable']) { const r = await call(`/o/${key}/cancel`,'POST','confirm=1',{'content-type':'application/x-www-form-urlencoded'}); assert.equal(r.status,303); assert.equal(r.headers.Location,`/o/${key}?${flag}=1`); }
});
test('network precedence, daily rotation and privacy', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const headers = { 'cf-connecting-ip':'1.1.1.1', 'true-client-ip':'2.2.2.2', 'x-forwarded-for':'3.3.3.3, 4.4.4.4' };
  const a = visitorNetwork(headers,'5.5.5.5','key',now); assert.equal(a.source,'cf-connecting-ip'); assert.match(a.hash,/^[a-f0-9]{64}$/); assert.ok(!JSON.stringify(a).includes('1.1.1.1'));
  assert.equal(visitorNetwork({'x-forwarded-for':headers['x-forwarded-for']},'','key',now).hash,visitorNetwork({},'4.4.4.4','key',now).hash);
  assert.equal(visitorNetwork({'true-client-ip':'2.2.2.2'},'','key',now).source,'true-client-ip');
  assert.notEqual(a.hash,visitorNetwork(headers,'','key',new Date('2026-01-02')).hash); assert.notEqual(a.hash,visitorNetwork(headers,'','other',now).hash);
});

async function seeded() {
  const h = setup();
  const p = { attempt: 'status', status_key: key, customer: { name: 'Jane SecretSurname', phone: '70999888', fulfilment: 'pickup', note: 'Private note' }, lines: [{ listing: h.data.fx.listings[0].listing_id, unit: 'base', qty: 10, price: 1.5 }], expected_total_usd: 15 };
  await h.call('/order', 'POST', JSON.stringify(p));
  return { ...h, order: h.gateway.orders[0].order as any };
}
test('state sentences', async () => {
  const { call, order } = await seeded();
  const { t } = await import('../storefront/src/i18n.js');
  for (const state of ['submitted','confirmed','ready','completed','rejected','cancelled','expired']) {
    order.state = state; order.reason = '<b>Shop reason</b>'; order.cancelled_by = 'shop';
    const html = String((await call('/o/' + key, 'GET')).body);
    assert.ok(html.includes(t('en', 'state_' + (state === 'cancelled' ? 'cancelled_shop' : state))));
    assert.match(html, /class="sf-state"/);
    if (['rejected','cancelled'].includes(state)) assert.match(html, /&lt;b&gt;Shop reason&lt;\/b&gt;/);
  }
  order.state = 'cancelled'; order.cancelled_by = 'customer';
  assert.match(String((await call('/o/' + key + '?cancelled=1', 'GET')).body), /You cancelled this order\.|Your order has been cancelled/);
  assert.match(String((await call('/o/' + key + '?not_cancellable=1', 'GET')).body), /can no longer be cancelled/);
});
test('first name only', async () => {
  const { call } = await seeded(); const html = String((await call('/o/' + key, 'GET')).body);
  assert.match(html, /Jane/); assert.doesNotMatch(html, /SecretSurname|70999888|Private note/);
});
test('refresh for open states', async () => {
  const { call, order } = await seeded();
  for (const state of ['submitted','confirmed','ready','completed','rejected','cancelled','expired']) {
    order.state = state;
    assert.equal(String((await call('/o/' + key, 'GET')).body).includes('<meta http-equiv="refresh" content="60">'), ['submitted','confirmed','ready'].includes(state));
  }
});
test('cancel form only when submitted', async () => {
  const { call, order } = await seeded();
  for (const state of ['submitted','confirmed','ready','completed','rejected','cancelled','expired']) {
    order.state = state; order.confirmed_total_usd = state === 'submitted' ? null : 12;
    const html = String((await call('/o/' + key, 'GET')).body);
    assert.equal(html.includes('method="post"'), state === 'submitted');
    if (state === 'submitted') assert.match(html, /action="\/o\/[a-z]{32}\/cancel"/);
    if (['confirmed','ready'].includes(state)) assert.match(html, /contact the shop to cancel/);
  }
});
test('status and customer cancellation survive ordering off or paused', async () => {
  for (const paused of [false, true]) {
    const { call, data } = await seeded();
    if (paused) data.fx.store.status = 'paused'; else data.fx.store.ordering_mode = 'off';
    assert.equal((await call('/o/' + key, 'GET')).status, 200);
    const r = await call('/o/' + key + '/cancel', 'POST', 'confirm=1', { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(r.status, 303); assert.equal(r.headers.Location, '/o/' + key + '?cancelled=1');
    assert.match(String((await call('/o/' + key, 'GET')).body), /You cancelled this order/);
  }
});
test('cancel redirect keeps the visitor language', async () => {
  const { call } = await seeded();
  const r = await call('/o/' + key + '/cancel?lang=ar', 'POST', 'confirm=1', { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(r.status, 303);
  assert.match(r.headers.Location, /[?&]lang=ar(&|$)/);
  assert.match(r.headers.Location, /[?&]cancelled=1(&|$)/);
});
test('status key under a different store address is a neutral 404', async () => {
  const { data, gateway, config } = await seeded();
  const r = await handle({ host: 'other-store.myomnipos.com', url: '/o/' + key }, { data, gateway, config, assetVersion: 'test' });
  assert.equal(r.status, 404); assert.doesNotMatch(String(r.body), /W-1001|Jane/);
});
test('status snapshot: confirmed totals, quantities, reasons, fulfilment, contacts, logo and escaping in every language', async () => {
  const { call, data, order } = await seeded();
  order.state = 'confirmed'; order.confirmed_total_usd = 12; order.confirmed_total_local = 800; order.total_local = 1000;
  order.lines[0].confirmed_qty = 8; order.lines[0].shortfall_reason = 'damaged';
  order.store.logo_path = 'logo.png'; order.store.pickup_note = '<pickup>'; order.store.contact_phone = '+96171111222';
  order.store.contact_email = 'shop@example.test'; order.store.name = '<Shop>'; order.lines[0].product_name = '<Milk>';
  data.fx.store.status = 'paused';
  const { t } = await import('../storefront/src/i18n.js');
  for (const lang of ['en','ar','fr'] as const) {
    const html = String((await call('/o/' + key + '?lang=' + lang, 'GET')).body);
    assert.ok(html.includes(t(lang, 'ordered_qty', { qty: 10 })));
    assert.ok(html.includes(t(lang, 'confirmed_qty', { qty: 8 })));
    assert.ok(html.includes(t(lang, 'shortfall_damaged')));
    assert.match(html, /\$12.00/); assert.doesNotMatch(html, /\$15.00/);
    assert.match(html, /&lt;Milk&gt;/); assert.match(html, /&lt;pickup&gt;/); assert.match(html, /&lt;Shop&gt;/);
    assert.match(html, /src="\/img\/logo.png"/); assert.match(html, /tel:|mailto:/); assert.match(html, /order.js/);
  }
  order.fulfilment = 'delivery'; order.address = '<door>';
  assert.match(String((await call('/o/' + key, 'GET')).body), /&lt;door&gt;/);
});

test('off and WhatsApp pages are unchanged by gateway configuration',async()=>{
  const {data,config,gateway}=setup();
  for(const mode of ['off','whatsapp'] as const) { data.fx.store.ordering_mode=mode; for(const url of ['/','/cart',`/p/${data.fx.listings[0].listing_id}`]) { const req={host:'beirut-market.myomnipos.com',url}; const deps={data,config,gateway,assetVersion:'test'}; const a=await handle(req,deps); config.orderGatewayKey=undefined; assert.deepEqual(await handle(req,deps),a); config.orderGatewayKey='test'; } }
});

test('online cart shell, payload, translations and gateway gate in both URL forms', async () => {
  const { data, gateway, config } = setup();
  const { ORDER_UI_KEYS } = await import('../storefront/src/ordering.js');
  for (const [host, base] of [['beirut-market.myomnipos.com', ''], ['myomnipos.com', '/s/beirut-market']]) {
    for (const lang of ['en', 'ar', 'fr']) {
      const r = await handle({ host, url: base + '/cart?lang=' + lang }, { data, gateway, config, assetVersion: 'test' });
      const html = String(r.body);
      assert.equal(r.status, 200);
      assert.match(html, /name="phone"[^>]*maxlength="30"[^>]*inputmode="tel" required/);
      assert.match(html, /name="website" tabindex="-1" autocomplete="off"/);
      for (const id of ['sf-quote', 'sf-confirm', 'sf-myorders']) assert.ok(html.includes('id="' + id + '"'));
      assert.ok(html.indexOf('/cart.js?') < html.indexOf('/checkout.js?'));
      assert.ok(html.indexOf('/checkout.js?') < html.indexOf('/order.js?'));
      const payload = JSON.parse(html.match(/id="sf-order">(.*?)<\/script>/)![1]);
      assert.equal(payload.mode, 'online');
      assert.equal(payload.api.quote, base + '/order/quote?lang=' + lang);
      assert.equal(payload.api.submit, base + '/order?lang=' + lang);
      for (const k of ORDER_UI_KEYS) assert.notEqual(payload.ui[k], k);
      if (lang === 'ar') { assert.match(html, /dir="rtl"/); assert.match(html, /مراجعة الطلب/); }
      if (lang === 'fr') assert.match(html, /Vérifier la commande/);
    }
  }
  data.fx.store.contact_whatsapp = null;
  const html = String((await handle({ host: 'beirut-market.myomnipos.com', url: '/cart' }, { data, gateway, config, assetVersion: 'test' })).body);
  assert.equal('wa' in JSON.parse(html.match(/id="sf-order">(.*?)<\/script>/)![1]), false);
  config.orderGatewayKey = undefined;
  assert.equal((await handle({ host: 'beirut-market.myomnipos.com', url: '/cart' }, { data, gateway, config, assetVersion: 'test' })).status, 302);
  assert.doesNotMatch(String((await handle({ host: 'beirut-market.myomnipos.com', url: '/' }, { data, gateway, config, assetVersion: 'test' })).body), /sf-order|cart.js|order.js/);
});

test('both route roots retain language and reject malformed keys without gateway calls', async () => {
  const { route } = await import('../storefront/src/router.js');
  const { call, gateway } = setup();
  let calls = 0; gateway.status = async () => { calls++; throw new Error('must not call'); };
  gateway.cancel = gateway.status;
  for (const bad of ['short', 'a'.repeat(33), 'a'.repeat(31) + '!']) {
    assert.equal((await call(`/o/${bad}`, 'GET')).status,404);
    assert.equal((await call(`/o/${bad}/cancel`)).status,404);
  }
  assert.equal(calls,0);
  for (const [host, base] of [['beirut-market.myomnipos.com',''],['myomnipos.com','/s/beirut-market']]) {
    for (const [path, kind] of [['/order/quote','orderQuote'],['/order','orderSubmit'],[`/o/${key}`,'orderStatus'],[`/o/${key}/cancel`,'orderCancel']]) {
      const r = route(host,base + path + '?lang=ar','myomnipos.com'); assert.equal(r.kind,kind); assert.equal('params' in r && r.params.lang,'ar');
    }
  }
});
test('path form status URLs, neutral missing status and paused store gate', async () => {
  const { data, gateway, config } = setup();
  const request = (url: string, method = 'GET', body = '') => handle({ host:'myomnipos.com',url:'/s/beirut-market' + url,method,body,headers:{'content-type':'application/json'} },{data,gateway,config,assetVersion:'test'});
  const missing = await request(`/o/${key}`); assert.equal(missing.status,404); assert.equal(missing.headers['Cache-Control'],'private, no-store');
  const p = { attempt:'path',status_key:key,customer:{name:'Jane',phone:'70123456',fulfilment:'pickup'},lines:[{listing:data.fx.listings[0].listing_id,unit:'base',qty:10,price:1.5}],expected_total_usd:15 };
  assert.equal(JSON.parse(String((await request('/order','POST',JSON.stringify(p))).body)).status_url,`/s/beirut-market/o/${key}`);
  data.fx.store.status='paused'; assert.equal(JSON.parse(String((await request('/order/quote','POST','{}')).body)).code,'store_unavailable');
});
test('fixture reprices, validates, retries dropped responses, limits phones and expires orders',async()=>{
  const {data,gateway}=setup(); let now=Date.parse('2026-01-01');
  const g=new FixtureOrderGateway(data,()=>now);
  const line={listing:data.fx.listings[0].listing_id,unit:'base',qty:10,price:1.5};
  const p={attempt:'one',status_key:key,network:'n',customer:{name:'Jane Doe',phone:'70123456',fulfilment:'pickup'},lines:[line],expected_total_usd:15};
  assert.equal((await g.submit(data.fx.store.slug,{...p,expected_total_usd:1})).code,'changed');
  data.fx.listings[0].price_lbp=100;
  const q=await g.quote(data.fx.store.slug,[line]); assert.equal(q.quote.total_local,1000); assert.equal(q.quote.total_usd,15);
  g.dropNextResponse=true; await assert.rejects(g.submit(data.fx.store.slug,p),/dropped response/);
  assert.equal((await g.submit(data.fx.store.slug,p)).code,'existing');
  assert.equal((await g.submit(data.fx.store.slug,{...p,status_key:'b'.repeat(32)})).code,'refused');
  for(let i=2;i<=3;i++) assert.equal((await g.submit(data.fx.store.slug,{...p,attempt:String(i),status_key:String(i).repeat(32)})).code,'created');
  assert.equal((await g.submit(data.fx.store.slug,{...p,attempt:'four',status_key:'4'.repeat(32)})).code,'phone_limit');
  for(const o of g.orders) o.order.state='completed';
  for(let i=4;i<=5;i++) { assert.equal((await g.submit(data.fx.store.slug,{...p,attempt:String(i),status_key:String(i).repeat(32)})).code,'created'); g.orders.at(-1)!.order.state='completed'; }
  assert.equal((await g.submit(data.fx.store.slug,{...p,attempt:'six',status_key:'6'.repeat(32)})).code,'phone_limit');
  now+=3600001; assert.equal((await g.submit(data.fx.store.slug,{...p,attempt:'later',status_key:'l'.repeat(32)})).code,'created');
  now+=86400001; assert.equal((await g.status('l'.repeat(32))).order.state,'expired');
  assert.equal((await g.cancel('l'.repeat(32))).code,'not_cancellable');
  g.blockedPhones.add('96170123456'); assert.equal((await g.submit(data.fx.store.slug,{...p,attempt:'blocked'})).code,'refused');
});
test('Supabase gateway sends exact RPC arguments and maps transport errors',async()=>{
  const {SupabaseOrderGateway,UpstreamError}=await import('../storefront/src/data.js');
  const calls: {url:string;args:any}[]=[];
  const fetchImpl: typeof fetch=async (url,init)=>{ calls.push({url:String(url),args:JSON.parse(String(init?.body))}); return new Response('{"ok":true,"code":"ok"}'); };
  const g=new SupabaseOrderGateway('https://example.test','anon','gateway',fetchImpl);
  const p={attempt:'attempt',status_key:key,network:'hashed',customer:{name:'Jane',phone:'70123456',fulfilment:'pickup'},lines:[],expected_total_usd:0,website:''};
  await g.quote('shop',[]); await g.submit('shop',p); await g.status(key); await g.cancel(key);
  assert.deepEqual(calls.map(c=>c.url.split('/').at(-1)),['order_quote','order_submit','order_status','order_cancel']);
  assert.deepEqual(calls[1].args,{p_gateway:'gateway',p_slug:'shop',p_idempotency:'attempt',p_status_key:key,p_network:'hashed',p_customer:p.customer,p_lines:[],p_expected_total_usd:0,p_trap:''});
  assert.deepEqual(calls[0].args,{p_gateway:'gateway',p_slug:'shop',p_lines:[]});
  assert.deepEqual(calls[2].args,{p_gateway:'gateway',p_status_key:key}); assert.deepEqual(calls[3].args,calls[2].args);
  for(const fail of [async()=>{throw new Error('offline');},async()=>new Response('',{status:500})]) await assert.rejects(new SupabaseOrderGateway('https://example.test','anon','gateway',fail).status(key),UpstreamError);
});
