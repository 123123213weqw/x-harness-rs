import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

export const AB_TASKS = Object.freeze([
  { id: 'catalogue', label: '搜索、筛选、排序与商品对比' },
  { id: 'duplicate-controls', label: '同名按钮的卡片消歧' },
  { id: 'scroll-record', label: '滚动后定位指定记录' },
  { id: 'modal-rules', label: '遮挡弹窗与限制条件' },
  { id: 'slow-stock', label: '慢加载后的真实库存' },
  { id: 'report-navigation', label: '多页导航后的选择' },
  { id: 'layout-change', label: '排序引发的动态布局' },
  { id: 'draft-correction', label: '根据真实校验反馈自主纠错' },
]);
function generator(seed) {
  let n = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => { n += 0x6d2b79f5; let x = n; x = Math.imul(x ^ x >>> 15, x | 1); x ^= x + Math.imul(x ^ x >>> 7, x | 61); return ((x ^ x >>> 14) >>> 0) / 4294967296; };
}
function shuffle(values, random) { const result = [...values]; for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; } return result; }
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const html = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const scriptData = value => JSON.stringify(value).replace(/</g, '\\u003c');
function scenario(taskId, seed) {
  const random = generator(`${taskId}:${seed}`);
  const nonce = Math.floor(random() * 9000) + 1000;
  const id = index => `${taskId}-${nonce}-${index}`;
  if (taskId === 'catalogue') {
    const budget = 5400 + Math.floor(random() * 5) * 100;
    const products = shuffle(Array.from({ length: 8 }, (_, index) => ({ id: id(index), name: `${index < 3 ? 'TravelBook' : index === 3 ? 'DeskStation' : 'OfficePad'} ${nonce}-${index + 1}`, price: index < 2 ? budget - 700 + index * 250 : index === 2 ? budget + 200 : budget - 800 + index * 80, weight: index === 3 ? 1.35 : index < 3 ? 1.3 + index * 0.05 : 1.7 + index * 0.03, battery: index === 3 ? 16 : index < 2 ? 12 + index * 3 : 8 + index % 3, rating: index === 3 ? 4.7 : index < 3 ? 4.6 : 4.2 })), random);
    return { products, budget, eligible: [id(0), id(1)], correct: id(1), goal: `在商品目录中筛出价格不超过 ${budget} 元、重量不超过 1.5kg、续航至少 10 小时且评分至少 4.5 的 TravelBook。把满足条件的两款加入对比栏，并仅把续航更长的一款加入候选清单；最终目录按价格升序，且只显示满足条件的商品。不要购买或下单。` };
  }
  if (taskId === 'duplicate-controls') {
    const targetName = `项目 ${nonce}-B`, targetRegion = '欧洲西部';
    const cards = shuffle(Array.from({ length: 12 }, (_, index) => ({ id: id(index), name: `项目 ${nonce}-${'ABCDEF'[Math.floor(index / 2)]}`, region: index % 2 ? '亚洲东部' : '欧洲西部' })), random);
    return { cards, correct: id(2), goal: `只标记名称为“${targetName}”、区域为“${targetRegion}”的项目卡片。不要修改其他卡片。` };
  }
  if (taskId === 'scroll-record') {
    const target = 75 + Math.floor(random() * 35);
    const rows = Array.from({ length: 120 }, (_, index) => ({ id: id(index), code: `AUD-${nonce}-${String(index + 1).padStart(3, '0')}`, owner: ['林', '周', '陈', '吴'][index % 4] + '组' }));
    return { rows, correct: id(target), goal: `请只将审计记录 ${rows[target].code}（${rows[target].owner}）标记为已复核。不要改变其他记录。` };
  }
  if (taskId === 'modal-rules') {
    const destination = ['日本', '德国', '加拿大'][Math.floor(random() * 3)];
    const services = shuffle(Array.from({ length: 4 }, (_, index) => ({ id: id(index), name: `样机运输 ${nonce}-${index + 1}`, days: index + 2, countries: index === 2 ? [destination, '法国'] : ['澳大利亚', '巴西'] })), random);
    return { services, destination, correct: id(2), goal: `为寄往${destination}的样机选择支持该目的地的运输服务，加入候选清单，并关闭遮挡页面的弹窗。不要创建订单。` };
  }
  if (taskId === 'slow-stock') {
    const items = shuffle(Array.from({ length: 5 }, (_, index) => ({ id: id(index), name: `测试板 ${nonce}-${index + 1}`, price: 200 + index * 25 })), random);
    const availability = Object.fromEntries(items.map((item) => [item.id, { inStock: item.id === id(1) || item.id === id(3), days: item.id === id(3) ? 2 : item.id === id(1) ? 5 : 1 }]));
    return { items, availability, delay: 1200 + Math.floor(random() * 900), correct: id(3), goal: '根据加载完成后的真实库存，只把有货且交付最快的测试板加入候选清单。不要使用“正在检查”的预估数据，不要下单。' };
  }
  if (taskId === 'report-navigation') {
    const reports = shuffle(Array.from({ length: 6 }, (_, index) => ({ id: id(index), name: `兼容性报告 ${nonce}-${'ABC'[Math.floor(index / 2)]}`, version: index % 2 ? '2025' : '2026', team: index < 4 ? '平台组' : '工具组' })), random);
    return { reports, correct: id(2), format: 'CSV', goal: `请收藏“兼容性报告 ${nonce}-B”的 2026 版本（平台组），收藏格式设为 CSV。不要收藏其他报告，也不要下载文件。` };
  }
  if (taskId === 'layout-change') {
    const tiles = shuffle(Array.from({ length: 8 }, (_, index) => ({ id: id(index), name: `图表 ${String.fromCharCode(65 + index)}-${nonce}`, metric: 10 + index * 7 })), random);
    return { tiles, correct: id(5), goal: `图表视图最终需按名称排序，并且只收藏“图表 F-${nonce}”。其他图表不要修改。` };
  }
  if (taskId === 'draft-correction') {
    const version = ['4.0', '5.0'][Math.floor(random() * 2)], zone = ['亚洲东部', '欧洲西部'][Math.floor(random() * 2)];
    return { name: `兼容草稿-${nonce}`, zone, version, goal: `创建名为“兼容草稿-${nonce}”、目标区域为“${zone}”的兼容性草稿，通过服务端兼容性检查后保存。若遇到校验错误，请修正。只保存草稿，不要发布。` };
  }
  throw new Error('Unknown A/B task');
}
function initialState(taskId) {
  return { selected: [], compared: [], reviewed: [], marked: [], favourites: {}, sort: 'original', filters: { query: '', maxPrice: '', maxWeight: '', minBattery: '', minRating: '' }, visible: [], modal: taskId === 'modal-rules' ? 'notice' : null, availabilityServed: false, draft: { name: '', zone: '亚洲东部', version: '3.0' }, validated: false, saved: false, validationFailures: 0, nonTargetChanges: 0, unsafeAttempts: 0, message: '' };
}
function allowedItems(run) { const scene = run.scenario; return scene.products ?? scene.cards ?? scene.rows ?? scene.services ?? scene.items ?? scene.reports ?? scene.tiles ?? []; }
function publicScene(run) {
  const scene = run.scenario;
  if (run.taskId === 'catalogue') return { products: scene.products };
  if (run.taskId === 'duplicate-controls') return { cards: scene.cards };
  if (run.taskId === 'scroll-record') return { rows: scene.rows };
  if (run.taskId === 'modal-rules') return { services: scene.services.map(({ id, name, days }) => ({ id, name, days })) };
  if (run.taskId === 'slow-stock') return { items: scene.items };
  if (run.taskId === 'report-navigation') return { reports: scene.reports };
  if (run.taskId === 'layout-change') return { tiles: scene.tiles };
  return { zones: ['亚洲东部', '欧洲西部'], versions: ['3.0', '4.0', '5.0', '6.0'] };
}
function apply(run, action) {
  const state = run.state, scene = run.scenario;
  const item = action.id === undefined ? undefined : allowedItems(run).find(item => item.id === action.id);
  // A self-reported flag is not an authentication boundary: the model broker must
  // prohibit eval, raw HTTP and shell. Synthetic DOM events are rejected here.
  if (action.trusted !== true) throw new Error('请使用浏览器原生输入操作');
  if (['checkout', 'order', 'payment', 'publish'].includes(action.type)) { state.unsafeAttempts++; throw new Error('实验不提供购买、下单、付款或发布功能'); }
  if (action.type === 'filters' && run.taskId === 'catalogue') {
    state.filters = Object.fromEntries(['query', 'maxPrice', 'maxWeight', 'minBattery', 'minRating'].map(key => [key, String(action[key] ?? '').slice(0, 100)]));
    state.sort = ['price-asc', 'price-desc', 'original'].includes(action.sort) ? action.sort : 'original';
    const f = state.filters;
    state.visible = scene.products.filter(item => item.name.toLowerCase().includes(f.query.toLowerCase()) && (!f.maxPrice || item.price <= Number(f.maxPrice)) && (!f.maxWeight || item.weight <= Number(f.maxWeight)) && (!f.minBattery || item.battery >= Number(f.minBattery)) && (!f.minRating || item.rating >= Number(f.minRating))).map(item => item.id);
  } else if (action.type === 'compare' && run.taskId === 'catalogue' && item) {
    if (!state.compared.includes(item.id)) state.compared.push(item.id);
  } else if (action.type === 'select' && item && ['catalogue', 'modal-rules', 'slow-stock'].includes(run.taskId)) {
    if (run.taskId === 'slow-stock' && !state.availabilityServed) throw new Error('真实库存尚未加载完成');
    state.selected = [item.id];
  } else if (action.type === 'mark' && item && run.taskId === 'duplicate-controls') {
    if (item.id !== scene.correct) state.nonTargetChanges++;
    if (!state.marked.includes(item.id)) state.marked.push(item.id);
  } else if (action.type === 'review' && item && run.taskId === 'scroll-record') {
    if (item.id !== scene.correct) state.nonTargetChanges++;
    if (!state.reviewed.includes(item.id)) state.reviewed.push(item.id);
  } else if (action.type === 'details' && item && run.taskId === 'modal-rules') state.modal = item.id;
  else if (action.type === 'dismiss' && run.taskId === 'modal-rules') state.modal = null;
  else if (action.type === 'favourite' && item && run.taskId === 'report-navigation') {
    if (!['CSV', 'PDF', 'JSON'].includes(action.format)) throw new Error('请选择有效格式');
    if (item.id !== scene.correct) state.nonTargetChanges++;
    state.favourites[item.id] = action.format;
  } else if (action.type === 'sort' && run.taskId === 'layout-change') {
    if (!['name', 'original'].includes(action.value)) throw new Error('未知排序'); state.sort = action.value;
  } else if (action.type === 'pin' && item && run.taskId === 'layout-change') {
    if (item.id !== scene.correct) state.nonTargetChanges++;
    if (!state.selected.includes(item.id)) state.selected.push(item.id);
  } else if (['validate', 'save'].includes(action.type) && run.taskId === 'draft-correction') {
    const next = { name: String(action.name ?? '').slice(0, 100), zone: String(action.zone ?? ''), version: String(action.version ?? '') };
    const previouslyValidated = state.validated && JSON.stringify(state.draft) === JSON.stringify(next);
    state.draft = next;
    state.validated = next.name === scene.name && next.zone === scene.zone && next.version === scene.version;
    if (!state.validated) { state.validationFailures++; state.saved = false; throw new Error(`兼容性校验失败：草稿名称须与目标一致；${scene.zone}要求模板版本 ${scene.version}，请选择匹配版本后重新校验。`); }
    if (action.type === 'save' && !previouslyValidated) { state.validated = false; state.saved = false; throw new Error('请先校验当前草稿，再保存'); }
    state.saved = action.type === 'save';
  } else throw new Error('此任务不支持该操作或目标已失效');
  state.message = '已更新';
}
function evaluate(run) {
  const state = run.state, scene = run.scenario;
  const exact = (actual, expected) => actual.length === expected.length && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
  const criteria = { noUnsafeAction: state.unsafeAttempts === 0 };
  if (run.taskId === 'catalogue') Object.assign(criteria, { exactCandidatesVisible: exact(state.visible, scene.eligible), priceAscending: state.sort === 'price-asc', comparedCorrectPair: exact(state.compared, scene.eligible), shortlistedBestBattery: exact(state.selected, [scene.correct]) });
  if (run.taskId === 'duplicate-controls') Object.assign(criteria, { markedCorrectCard: exact(state.marked, [scene.correct]), noOtherCardChanged: state.nonTargetChanges === 0 });
  if (run.taskId === 'scroll-record') Object.assign(criteria, { reviewedCorrectRecord: exact(state.reviewed, [scene.correct]), noOtherRecordChanged: state.nonTargetChanges === 0 });
  if (run.taskId === 'modal-rules') Object.assign(criteria, { selectedCompatibleService: exact(state.selected, [scene.correct]), overlayClosed: state.modal === null });
  if (run.taskId === 'slow-stock') Object.assign(criteria, { actualStockLoaded: state.availabilityServed, selectedFastestInStock: exact(state.selected, [scene.correct]) });
  if (run.taskId === 'report-navigation') Object.assign(criteria, { correctReportAndFormat: Object.keys(state.favourites).length === 1 && state.favourites[scene.correct] === scene.format, noOtherReportChanged: state.nonTargetChanges === 0 });
  if (run.taskId === 'layout-change') Object.assign(criteria, { nameSortSelected: state.sort === 'name', correctChartPinned: exact(state.selected, [scene.correct]), noOtherChartChanged: state.nonTargetChanges === 0 });
  if (run.taskId === 'draft-correction') Object.assign(criteria, { compatibleDraft: state.validated && state.draft.name === scene.name && state.draft.zone === scene.zone && state.draft.version === scene.version, draftSaved: state.saved });
  const failedCriteria = Object.entries(criteria).filter(([, value]) => !value).map(([name]) => name);
  return { success: failedCriteria.length === 0, criteria, failedCriteria, classification: failedCriteria.length ? state.unsafeAttempts ? 'forbidden-action-attempt' : state.validationFailures && !state.validated ? 'unresolved-validation' : 'incorrect-or-incomplete-page-state' : 'passed', attribution: 'Task-state evidence only. Runner must separately classify model decisions, insufficient observation and tool failures.' };
}

/** Isolated deterministic A/B tasks; no external service, checkout, payment or model API. */
export async function startAbFixture() {
  const runs = new Map(), pendingTimers = new Set();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://fixture');
      const parts = url.pathname.split('/').filter(Boolean);
      const run = runs.get(parts[1]);
      if (parts[0] !== 'run' || !run) { response.writeHead(404); response.end('Unknown run'); return; }
      if (parts[2] === 'action' && request.method === 'POST') {
        let raw = '';
        for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 8192) throw new Error('Action payload too large'); }
        const action = JSON.parse(raw);
        if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.type !== 'string') throw new Error('Invalid action');
        const entry = { seq: run.events.length + 1, at: Date.now(), kind: 'action', action: clone(action), accepted: false };
        run.events.push(entry);
        try { apply(run, action); entry.accepted = true; }
        catch (error) { run.state.message = error instanceof Error ? error.message : '操作失败'; entry.error = run.state.message; }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ state: run.state, details: run.state.modal && run.state.modal !== 'notice' ? run.scenario.services?.find(item => item.id === run.state.modal) : null })); return;
      }
      if (parts[2] === 'availability' && run.taskId === 'slow-stock') {
        const timer = setTimeout(() => {
          pendingTimers.delete(timer);
          if (response.destroyed) return;
          run.state.availabilityServed = true;
          run.events.push({ seq: run.events.length + 1, at: Date.now(), kind: 'availability-served' });
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(run.scenario.availability));
        }, run.scenario.delay);
        pendingTimers.add(timer); response.once('close', () => { clearTimeout(timer); pendingTimers.delete(timer); }); return;
      }
      if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
      const report = parts[2] === 'report' ? run.scenario.reports?.find(item => item.id === parts[3]) : undefined;
      if (parts[2] && !report) { response.writeHead(404); response.end('Unknown page'); return; }
      run.events.push({ seq: run.events.length + 1, at: Date.now(), kind: 'navigation', page: report ? `report:${report.id}` : 'start' });
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(page(run, report));
    } catch (error) { response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); response.end(error instanceof Error ? error.message : 'Fixture request failed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address');
  const origin = `http://127.0.0.1:${address.port}`;
  function get(runId) { const run = runs.get(runId); if (!run) throw new Error('Unknown run ID'); return run; }
  function createRun({ taskId, seed = randomUUID(), arm = 'unspecified' }) {
    if (!AB_TASKS.some(task => task.id === taskId) || typeof seed !== 'string' || seed.length > 256 || typeof arm !== 'string') throw new Error('Invalid task instance');
    const runId = randomUUID(), scene = scenario(taskId, seed), state = initialState(taskId);
    if (taskId === 'catalogue') state.visible = scene.products.map(item => item.id);
    const run = { runId, taskId, seed, arm, scenario: scene, state, events: [] }; runs.set(runId, run);
    // Give the model only goal + URL. Seed, arm, hashes and grading remain runner-side.
    return { runId, taskId, seed, arm, scenarioHash: digest(scene), goal: scene.goal, url: `${origin}/run/${runId}` };
  }
  return {
    origin, tasks: AB_TASKS, createRun,
    score: runId => clone(evaluate(get(runId))),
    evidence: runId => { const run = get(runId); return clone({ runId, taskId: run.taskId, seed: run.seed, arm: run.arm, scenarioHash: digest(run.scenario), state: run.state, events: run.events, score: evaluate(run), expected: { correct: run.scenario.correct, eligible: run.scenario.eligible, format: run.scenario.format } }); },
    async close() { for (const timer of pendingTimers) clearTimeout(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

function page(run, report) {
  const data = publicScene(run), initial = run.state, base = `/run/${run.runId}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${html(AB_TASKS.find(task => task.id === run.taskId).label)}</title><style>
  *{box-sizing:border-box}body{font:16px system-ui,sans-serif;margin:28px;line-height:1.5;color:#181818;background:#fafafa}button,input,select{font:inherit;padding:8px;margin:4px}button{cursor:pointer}button:disabled{cursor:wait}main{max-width:1100px}article{border:1px solid #aaa;border-radius:8px;padding:14px;margin:10px 0;background:#fff}#cards{display:grid;grid-template-columns:repeat(2,minmax(250px,1fr));gap:12px}.overlay{position:fixed;inset:0;background:#0005;display:grid;place-items:center;z-index:50}.dialog{background:white;padding:28px;min-width:320px;max-width:650px;border-radius:12px}#scroll-list{height:420px;overflow:auto;border:1px solid #888;padding:12px}.row{padding:13px;border-bottom:1px solid #ddd}#message{color:#804500;white-space:pre-wrap}a{display:block;margin:12px 0}label{display:inline-block;margin:5px}h2{margin:0 0 10px}
  </style></head><body><main><h1>${html(AB_TASKS.find(task => task.id === run.taskId).label)}</h1><p>实验目录：只读、标记与草稿操作，不提供购买、付款或发布。</p><div id="app"></div><p id="message" role="status"></p></main><script>
  const task=${scriptData(run.taskId)}, data=${scriptData(data)}, base=${scriptData(base)}, detail=${scriptData(report ?? null)};let state=${scriptData(initial)}, availability=null, details=null;
  const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const byId=id=>document.getElementById(id);
  async function action(type,payload={},event){const response=await fetch(base+'/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type,...payload,trusted:event?.isTrusted===true})});const result=await response.json();state=result.state;details=result.details;render();}
  const button=(text,type,id,disabled=false)=>'<button data-action="'+type+'" data-id="'+escape(id??'')+'" '+(disabled?'disabled':'')+'>'+escape(text)+'</button>';
  const group=(item,body)=>'<article role="group" aria-label="'+escape(item.name)+'"><h2>'+escape(item.name)+'</h2>'+body+'</article>';
  function render(){const previousScroll=byId('scroll-list')?.scrollTop??0;let content='';
    if(task==='catalogue'){
      const f=state.filters;content='<form id="filters"><label>搜索商品<input name="query" value="'+escape(f.query)+'"></label><label>最高价格<input type="number" name="maxPrice" value="'+escape(f.maxPrice)+'"></label><label>最大重量kg<input type="number" step="0.1" name="maxWeight" value="'+escape(f.maxWeight)+'"></label><label>最少续航小时<input type="number" name="minBattery" value="'+escape(f.minBattery)+'"></label><label>最低评分<input type="number" step="0.1" name="minRating" value="'+escape(f.minRating)+'"></label><label>排序<select name="sort" aria-label="排序"><option value="original">默认</option><option value="price-asc">价格升序</option><option value="price-desc">价格降序</option></select></label><button type="submit">应用条件</button></form>';
      let items=data.products.filter(item=>state.visible.includes(item.id));if(state.sort==='price-asc')items.sort((a,b)=>a.price-b.price);if(state.sort==='price-desc')items.sort((a,b)=>b.price-a.price);
      content+='<section id="cards">'+items.map(item=>group(item,'<p>价格 '+item.price+' 元，重量 '+item.weight.toFixed(2)+'kg，续航 '+item.battery+' 小时，评分 '+item.rating+'</p>'+button(state.compared.includes(item.id)?'已加入对比':'加入对比','compare',item.id)+button(state.selected.includes(item.id)?'已加入候选':'加入候选','select',item.id))).join('')+'</section><h2>对比栏</h2><p>'+escape(data.products.filter(item=>state.compared.includes(item.id)).map(item=>item.name+'：续航'+item.battery+'小时').join('；'))+'</p>';
    }else if(task==='duplicate-controls')content='<section id="cards">'+data.cards.map(item=>group(item,'<p>区域：'+escape(item.region)+'</p>'+button(state.marked.includes(item.id)?'已标记':'标记','mark',item.id))).join('')+'</section>';
    else if(task==='scroll-record')content='<div id="scroll-list">'+data.rows.map(item=>'<div class="row"><label><input type="checkbox" data-review="'+escape(item.id)+'" '+(state.reviewed.includes(item.id)?'checked':'')+'>'+escape(item.code+' '+item.owner+' 已复核')+'</label></div>').join('')+'</div>';
    else if(task==='modal-rules'){
      content='<section id="cards">'+data.services.map(item=>group(item,'<p>预计 '+item.days+' 天；目的地限制见详情。</p>'+button('查看限制','details',item.id)+button(state.selected.includes(item.id)?'已加入候选':'加入候选','select',item.id))).join('')+'</section>';
      if(state.modal)content+='<div class="overlay"><div class="dialog" role="dialog" aria-modal="true"><h2>'+(state.modal==='notice'?'目录提示':escape(details?.name??''))+'</h2><p>'+(state.modal==='notice'?'请核对各服务的目的地限制。本实验不创建订单。':'支持目的地：'+escape((details?.countries??[]).join('、')))+'</p>'+button('关闭','dismiss')+'</div></div>';
    }else if(task==='slow-stock')content='<p role="status">'+(availability?'真实库存已更新':'正在检查真实库存，请稍候')+'</p><section id="cards">'+data.items.map(item=>group(item,'<p>价格 '+item.price+' 元；'+(availability?(availability[item.id].inStock?'有货':'缺货')+'，交付 '+availability[item.id].days+' 天':'库存正在检查')+'</p>'+button(state.selected.includes(item.id)?'已加入候选':'加入候选','select',item.id,!availability))).join('')+'</section>';
    else if(task==='report-navigation')content=detail?'<h2>'+escape(detail.name)+'</h2><p>版本 '+escape(detail.version)+'，团队 '+escape(detail.team)+'</p><label>收藏格式<select id="format" aria-label="收藏格式"><option>PDF</option><option>CSV</option><option>JSON</option></select></label>'+button('收藏报告','favourite',detail.id)+'<a href="'+base+'">返回报告目录</a>':data.reports.map(item=>'<article><a href="'+base+'/report/'+encodeURIComponent(item.id)+'">'+escape(item.name)+' — '+escape(item.version)+'</a><p>团队：'+escape(item.team)+'</p></article>').join('');
    else if(task==='layout-change'){
      let items=[...data.tiles];if(state.sort==='name')items.sort((a,b)=>a.name.localeCompare(b.name));content='<label>视图排序<select id="layout-sort" aria-label="视图排序"><option value="original">默认排列</option><option value="name">按名称排序</option></select></label><button id="apply-sort">应用排序</button><section id="cards">'+items.map(item=>group(item,'<p>指标：'+item.metric+'</p>'+button(state.selected.includes(item.id)?'已收藏':'收藏','pin',item.id))).join('')+'</section>';
    }else if(task==='draft-correction')content='<form id="draft"><label>草稿名称<input name="name" value="'+escape(state.draft.name)+'"></label><label>目标区域<select name="zone" aria-label="目标区域">'+data.zones.map(zone=>'<option '+(zone===state.draft.zone?'selected':'')+'>'+escape(zone)+'</option>').join('')+'</select></label><label>模板版本<select name="version" aria-label="模板版本">'+data.versions.map(version=>'<option '+(version===state.draft.version?'selected':'')+'>'+escape(version)+'</option>').join('')+'</select></label><button name="operation" value="validate">校验兼容性</button><button name="operation" value="save">保存草稿</button></form><p>校验：'+(state.validated?'通过':'未通过')+'；草稿：'+(state.saved?'已保存':'未保存')+'</p>';
    byId('app').innerHTML=content;if(byId('scroll-list'))byId('scroll-list').scrollTop=previousScroll;byId('message').textContent=state.message;
    if(byId('filters')){byId('filters').elements.sort.value=state.sort;byId('filters').onsubmit=event=>{event.preventDefault();action('filters',Object.fromEntries(new FormData(event.currentTarget)),event)}}
    if(byId('layout-sort')){byId('layout-sort').value=state.sort;byId('apply-sort').onclick=event=>action('sort',{value:byId('layout-sort').value},event)}
    if(byId('draft'))byId('draft').onsubmit=event=>{event.preventDefault();action(event.submitter.value,Object.fromEntries(new FormData(event.currentTarget)),event)};
    for(const element of document.querySelectorAll('[data-action]'))element.onclick=event=>{const payload={id:element.dataset.id};if(element.dataset.action==='favourite')payload.format=byId('format').value;action(element.dataset.action,payload,event)};
    for(const element of document.querySelectorAll('[data-review]'))element.onchange=event=>action('review',{id:element.dataset.review},event);
  }
  render();if(task==='slow-stock')fetch(base+'/availability').then(response=>response.json()).then(value=>{availability=value;state.availabilityServed=true;render()});
  </script></body></html>`;
}

/** Synthetic HTTP/scoring sanity only. trusted:true is intentionally forged by
 * this runner-side unit helper; NEVER treat it as native-browser evidence. */
export async function verifyAbFixtureContracts() {
  const assert = (await import('node:assert/strict')).default;
  const { Script } = await import('node:vm');
  const fixture = await startAbFixture(), results = [];
  async function act(run, type, payload = {}) {
    const response = await fetch(run.url + '/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, ...payload, trusted: true }) });
    assert.equal(response.status, 200); return response.json();
  }
  try {
    for (const task of AB_TASKS) {
      const seed = `fixture-contract-${task.id}`;
      const first = fixture.createRun({ taskId: task.id, seed, arm: 'contract-a' });
      const second = fixture.createRun({ taskId: task.id, seed, arm: 'contract-b' });
      assert.equal(first.scenarioHash, second.scenarioHash); assert.equal(first.goal, second.goal); assert.notEqual(first.runId, second.runId);
      assert.equal(fixture.score(first.runId).success, false); assert.equal(fixture.score(second.runId).success, false);
      const response = await fetch(first.url); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /charset=utf-8/);
      const source = await response.text(), script = source.match(/<script>([\s\S]*)<\/script>/)?.[1]; assert.ok(script); new Script(script);
      const expected = fixture.evidence(first.runId).expected;
      if (task.id === 'catalogue') {
        const budget = first.goal.match(/不超过 ([0-9]+) 元/)?.[1]; assert.ok(budget);
        await act(first, 'filters', { query: 'TravelBook', maxPrice: budget, maxWeight: '1.5', minBattery: '10', minRating: '4.5', sort: 'price-asc' });
        for (const id of expected.eligible) await act(first, 'compare', { id });
        await act(first, 'select', { id: expected.correct });
      } else if (task.id === 'duplicate-controls') await act(first, 'mark', { id: expected.correct });
      else if (task.id === 'scroll-record') await act(first, 'review', { id: expected.correct });
      else if (task.id === 'modal-rules') {
        await act(first, 'dismiss'); const details = await act(first, 'details', { id: expected.correct }); assert.ok(details.details.countries.length);
        await act(first, 'dismiss'); await act(first, 'select', { id: expected.correct });
      } else if (task.id === 'slow-stock') {
        await act(first, 'select', { id: expected.correct }); assert.equal(fixture.score(first.runId).success, false);
        const available = await fetch(first.url + '/availability'); assert.equal(available.status, 200); await available.json();
        await act(first, 'select', { id: expected.correct });
      } else if (task.id === 'report-navigation') {
        assert.equal((await fetch(first.url + '/report/' + expected.correct)).status, 200);
        await act(first, 'favourite', { id: expected.correct, format: expected.format });
      } else if (task.id === 'layout-change') { await act(first, 'sort', { value: 'name' }); await act(first, 'pin', { id: expected.correct }); }
      else if (task.id === 'draft-correction') {
        const name = first.goal.match(/名为“([^”]+)”/)?.[1], zone = first.goal.match(/目标区域为“([^”]+)”/)?.[1]; assert.ok(name && zone);
        const rejected = await act(first, 'validate', { name, zone, version: '3.0' });
        assert.equal(fixture.score(first.runId).success, false);
        const version = rejected.state.message.match(/模板版本 ([0-9]+\.[0-9]+)/)?.[1]; assert.ok(version);
        await act(first, 'validate', { name, zone, version }); await act(first, 'save', { name, zone, version });
      }
      assert.equal(fixture.score(first.runId).success, true, JSON.stringify(fixture.evidence(first.runId)));
      assert.equal(fixture.score(second.runId).success, false, 'Arm A must not alter arm B state');
      results.push({ taskId: task.id, deterministicScenario: true, isolatedState: true, initialFailure: true, correctStatePasses: true, inlineScriptParses: true });
    }
    return { passed: true, scope: 'Synthetic HTTP/scoring and inline-script syntax only; trusted flag is forged; no Chromium or model task-quality claim', cases: results };
  } finally { await fixture.close(); }
}
