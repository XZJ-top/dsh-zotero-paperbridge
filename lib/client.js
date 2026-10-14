import { randomUUID } from 'node:crypto';

export class ConnectorError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
export const DEFAULTS = Object.freeze({
  backend: 'local', localBaseUrl: 'http://127.0.0.1:23119', libraryType: 'users', libraryId: '0',
  apiKeyEnv: 'ZOTERO_API_KEY', expectedLocalLibraryId: 1, timeoutMs: 20000, maxResponseBytes: 4000000,
  candidateTtlMinutes: 60, maxCandidates: 500, contactEmail: '', defaultTags: ['DSH'],
});
export function normalizeDoi(value) {
  const doi = String(value || '').trim().replace(/^doi:\s*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : '';
}
function stripMarkup(value) { return String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(); }
function titleKey(value) { return stripMarkup(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }
function creators(authors) { return (authors || []).filter(Boolean).map(a => typeof a === 'string' ? { creatorType: 'author', name: a } : a.family ? { creatorType: 'author', firstName: a.given || '', lastName: a.family } : { creatorType: 'author', name: a.name || a.collectiveName || '' }).filter(a => a.name || a.lastName); }
function crossrefPaper(m) {
  const parts = [m.published,m['published-print'],m['published-online'],m.issued].map(d=>d?.['date-parts']?.[0]).find(a=>Array.isArray(a)&&Number.isInteger(a[0])) || [];
  const doi = normalizeDoi(m.DOI);
  return { source: 'crossref', sourceId: doi, title: stripMarkup(m.title?.[0]), doi, url: m.URL || (doi ? `https://doi.org/${doi}` : ''),
    authors: creators(m.author), date: parts.slice(0, parts.findIndex(v=>!Number.isInteger(v)) < 0 ? parts.length : parts.findIndex(v=>!Number.isInteger(v))).map((v,i)=>i ? String(v).padStart(2,'0') : String(v)).join('-'),
    abstract: stripMarkup(m.abstract), publicationTitle: m['container-title']?.[0] || '', volume: m.volume || '', issue: m.issue || '', pages: m.page || '',
    publisher: m.publisher || '', sourceType: m.type || '', itemType: ({'book':'book','monograph':'book','edited-book':'book','book-chapter':'bookSection','proceedings-article':'conferencePaper','posted-content':'preprint','journal-article':'journalArticle','journalArticle':'journalArticle'})[m.type] || (m.type ? 'document' : 'journalArticle'),
    provenance: { provider: 'Crossref', recordUrl: `https://api.crossref.org/works/${encodeURIComponent(doi)}`, retrievedAt: new Date().toISOString() } };
}
function europePaper(m) {
  const doi = normalizeDoi(m.doi); const pmid = m.source === 'MED' ? String(m.id) : '';
  return { source: 'europepmc', sourceId: `${m.source}:${m.id}`, title: stripMarkup(m.title), doi, pmid,
    url: doi ? `https://doi.org/${doi}` : `https://europepmc.org/article/${m.source}/${m.id}`,
    authors: m.authorList?.author?.length ? creators(m.authorList.author.map(a=>({given:a.firstName,family:a.lastName,name:a.collectiveName||a.fullName}))) : creators((m.authorString || '').split(',').map(x=>x.trim()).filter(Boolean)),
    date: m.firstPublicationDate || m.pubYear || '', abstract: stripMarkup(m.abstractText), publicationTitle: m.journalInfo?.journal?.title || m.journalTitle || '',
    volume: m.journalInfo?.volume || '', issue: m.journalInfo?.issue || '', pages: m.pageInfo || '', itemType: 'journalArticle',
    openAccess: m.isOpenAccess === 'Y', provenance: { provider: 'Europe PMC', recordUrl: `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(`EXT_ID:${m.id} AND SRC:${m.source}`)}&format=json&resultType=core`, retrievedAt: new Date().toISOString() } };
}
function storedDoi(d) { return normalizeDoi(d.DOI) || normalizeDoi(String(d.extra || '').match(/^DOI:\s*(.+)$/im)?.[1]); }
function compactItem(i) { const d = i.data || i; return { key: i.key || d.key, title: d.title, doi: storedDoi(d) || '', date: d.date || '', creators: d.creators || [], collections: d.collections || [], url: d.url || '', itemType: d.itemType, abstract: d.abstractNote || '', version: i.version || d.version, zoteroUri: (i.key || d.key) ? `zotero://select/items/${i.library?.type === 'group' ? `groups/${i.library.id}` : '0' }_${i.key || d.key}` : undefined }; }
function validateKey(key) { if (!/^[A-Z0-9]{8}$/.test(key || '')) throw new ConnectorError('INVALID_KEY','Zotero key 必须是有效条目/集合 key。'); return key; }
function localUrl(value) {
  const u = new URL(value); if (!['http:','https:'].includes(u.protocol) || !['127.0.0.1','localhost','[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || !['','/'].includes(u.pathname)) throw new ConnectorError('INVALID_LOCAL_URL','localBaseUrl 必须是无凭据、无路径的本机 loopback HTTP(S) 地址。'); return u.origin;
}
export function createClient(config = {}, options = {}) {
  const cfg = { ...DEFAULTS, ...config }; cfg.localBaseUrl = localUrl(cfg.localBaseUrl);
  if (!['local','web'].includes(cfg.backend)) throw new ConnectorError('INVALID_BACKEND','backend 应为 local 或 web。');
  if (!['users','groups'].includes(cfg.libraryType) || !/^\d+$/.test(String(cfg.libraryId))) throw new ConnectorError('INVALID_LIBRARY','libraryType/libraryId 无效。');
  const transport = options.fetch || globalThis.fetch; const candidates = new Map(); const getCredential = options.resolveCredential || (async name => process.env[name]);
  const apiBase = cfg.backend === 'local' ? `${cfg.localBaseUrl}/api` : 'https://api.zotero.org';
  const libPath = `/${cfg.libraryType}/${cfg.libraryId}`; let writeQueue = Promise.resolve();
  async function request(url, { method = 'GET', body, signal, api = false, headers = {}, allowMissing = false } = {}) {
    let credential;
    if (api && cfg.backend === 'web') {
      if (cfg.libraryId === '0') throw new ConnectorError('CONFIG_REQUIRED','Web API 需要有效 libraryId；0 仅用于本地个人文库。');
      credential = await getCredential(cfg.apiKeyEnv); if (!credential) throw new ConnectorError('AUTH_REQUIRED',`请在 DSH 凭据中配置 ${cfg.apiKeyEnv}。`);
    }
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(cfg.timeoutMs)]) : AbortSignal.timeout(cfg.timeoutMs);
    let r;
    try {
      r = await transport(url, { method, redirect: 'error', signal: combined, headers: { 'Accept':'application/json', ...(body === undefined ? {} : {'Content-Type':'application/json'}), ...(api ? {'Zotero-API-Version':'3'} : {}), ...(credential ? {'Zotero-API-Key':credential} : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (e) {
      throw new ConnectorError(combined.aborted ? 'ABORTED_OR_TIMEOUT' : 'NETWORK_ERROR', method === 'GET' ? '请求未完成；检查网络或本地应用是否运行。' : '写入响应未收到，结果未知；先回读文库，避免盲目重试。', { operation: method, outcomeUnknown: method !== 'GET' });
    }
    if (allowMissing && r.status === 404) return null;
    const chunks = []; let size = 0;
    try {
      if (r.body) for await (const c of r.body) { size += c.byteLength; if (size > cfg.maxResponseBytes) throw new ConnectorError('RESPONSE_TOO_LARGE','服务响应超出配置的大小限制。'); chunks.push(c); }
    } catch (e) {
      const outcomeUnknown = r.ok && method !== 'GET' && (api || String(url).endsWith('/saveItems'));
      throw new ConnectorError(e.code === 'RESPONSE_TOO_LARGE' ? e.code : combined.aborted ? 'ABORTED_OR_TIMEOUT' : 'RESPONSE_READ_FAILED', outcomeUnknown ? '写入响应未完整读到，结果未知；先查询文库，避免盲目重试。' : '服务响应读取失败或超出大小限制。', {outcomeUnknown,status:r.status});
    }
    const text = Buffer.concat(chunks.map(c=>Buffer.from(c))).toString('utf8');
    if (!r.ok) throw new ConnectorError(`HTTP_${r.status}`, r.status === 401 || r.status === 403 ? '服务拒绝访问；检查凭据、文库权限和本地 API 设置。' : r.status === 429 ? '服务限流，请稍后重试。' : `服务返回 HTTP ${r.status}。`, { status: r.status, retryAfter: r.headers.get('Retry-After') || undefined });
    if (!text) return { status: r.status };
    try { return JSON.parse(text); } catch { throw new ConnectorError('INVALID_RESPONSE','服务未返回有效 JSON；写入请求请先回读确认。',{outcomeUnknown:r.ok&&method!=='GET'&&(api||String(url).endsWith('/saveItems')),status:r.status}); }
  }
  async function api(path, opts) { return request(`${apiBase}${libPath}${path}`, { ...opts, api: true }); }
  async function connector(path, opts) { return request(`${cfg.localBaseUrl}/connector/${path}`, { method:'POST', ...opts }); }
  function remember(paper) {
    for (const [id,e] of candidates) if (e.expires < Date.now()) candidates.delete(id);
    while(candidates.size >= cfg.maxCandidates) candidates.delete(candidates.keys().next().value);
    const candidateId = randomUUID(); candidates.set(candidateId,{ paper:structuredClone(paper),expires:Date.now()+cfg.candidateTtlMinutes*60000 });
    return { candidateId, ...paper };
  }
  async function search({ query, source = 'all', limit = 10, offset = 0 }, signal) {
    if (!String(query || '').trim()) throw new ConnectorError('QUERY_REQUIRED','请提供检索关键词。');
    if (!['all','crossref','europepmc'].includes(source)) throw new ConnectorError('INVALID_SOURCE','source 应为 all、crossref 或 europepmc。');
    const tasks = [];
    if (source !== 'europepmc') tasks.push((async()=>{
      const u = new URL(options.crossrefBase || 'https://api.crossref.org/works'); u.searchParams.set('query',query); u.searchParams.set('rows',String(limit)); u.searchParams.set('offset',String(offset)); u.searchParams.set('filter','type:journal-article'); if(cfg.contactEmail) u.searchParams.set('mailto',cfg.contactEmail);
      const r = await request(u.href,{signal}); if (!Array.isArray(r.message?.items)) throw new ConnectorError('INVALID_PROVIDER_RESPONSE','Crossref 返回无效数据。');
      return { source:'crossref', total:r.message['total-results'], papers:r.message.items.map(crossrefPaper) };
    })());
    if (source !== 'crossref') tasks.push((async()=>{
      const u = new URL(options.europeBase || 'https://www.ebi.ac.uk/europepmc/webservices/rest/search'); u.searchParams.set('query',query); u.searchParams.set('format','json');u.searchParams.set('resultType','core');u.searchParams.set('pageSize',String(limit));u.searchParams.set('page',String(Math.floor(offset/limit)+1));
      const r=await request(u.href,{signal}); if(!Array.isArray(r.resultList?.result)) throw new ConnectorError('INVALID_PROVIDER_RESPONSE','Europe PMC 返回无效数据。');
      return {source:'europepmc',total:r.hitCount,papers:r.resultList.result.map(europePaper)};
    })());
    const settled=await Promise.allSettled(tasks); const warnings=[]; const sources=[]; const seen=new Set(); const found=[];
    const batches=[];
    for(const t of settled) if(t.status==='fulfilled') { sources.push({source:t.value.source,total:t.value.total}); batches.push(t.value.papers); } else warnings.push({code:t.reason.code||'PROVIDER_ERROR',message:t.reason.message});
    for(let row=0;row<limit;row++)for(const batch of batches){const p=batch[row];if(!p)continue;const k=p.doi||`${titleKey(p.title)}:${p.date.slice(0,4)}`;if(p.title&&!seen.has(k)){seen.add(k);found.push(p);}}
    if(!sources.length) throw new ConnectorError('SEARCH_FAILED','所有文献检索来源均未完成。',{warnings});
    return {query,source,offset,nextOffset:offset+limit,results:found.slice(0,limit).map(remember),sources,warnings,saveHint:'使用结果中的 candidateId 调用 zotero_save；保存前会再次查重。'};
  }
  async function lookup(identifier, signal) {
    const doi=normalizeDoi(identifier);
    if(doi) {
      const u = `${options.crossrefBase || 'https://api.crossref.org/works'}/${encodeURIComponent(doi)}`;
      const r=await request(u,{signal}); if(!r.message?.DOI || normalizeDoi(r.message.DOI)!==doi) throw new ConnectorError('IDENTIFIER_MISMATCH','DOI 来源记录与请求不一致。'); return crossrefPaper(r.message);
    }
    const pmid=String(identifier||'').trim().replace(/^PMID:\s*/i,'');
    if(!/^\d+$/.test(pmid)) throw new ConnectorError('INVALID_IDENTIFIER','identifier 支持 DOI 或 PMID（可带 PMID: 前缀）。');
    const u=new URL(options.europeBase || 'https://www.ebi.ac.uk/europepmc/webservices/rest/search');u.searchParams.set('query',`EXT_ID:${pmid} AND SRC:MED`);u.searchParams.set('format','json');u.searchParams.set('resultType','core');
    const r=await request(u.href,{signal});const m=r.resultList?.result?.find(x=>x.source==='MED'&&String(x.id)===pmid);if(!m)throw new ConnectorError('NOT_FOUND','没有找到该 PMID 的元数据。');return europePaper(m);
  }
  async function library({ query = '', limit = 20, start = 0 }, signal) {
    const params=new URLSearchParams({limit:String(limit),start:String(start),format:'json',...(query?{q:query,qmode:'titleCreatorYear'}:{})});
    const r=await api(`/items/top?${params}`,{signal}); if(!Array.isArray(r))throw new ConnectorError('INVALID_LIBRARY_RESPONSE','Zotero 返回无效条目列表。'); return {items:r.map(compactItem),start,nextStart:r.length===limit?start+limit:null};
  }
  async function duplicate(p, signal) {
    const query=p.doi || p.title; const cap=500; const rows=[];
    for(let start=0;start<cap;start+=100){
      const params=new URLSearchParams({q:query,qmode:'everything',limit:'100',start:String(start),format:'json'});
      const r=await api(`/items/top?${params}`,{signal}); if(!Array.isArray(r))throw new ConnectorError('INVALID_LIBRARY_RESPONSE','查重时 Zotero 返回无效列表。');rows.push(...r);
      for(const i of r){const d=i.data||i; const match=p.doi ? storedDoi(d)===p.doi : (p.url&&d.url===p.url)||(titleKey(d.title)===titleKey(p.title)&&String(d.date||'').slice(0,4)===p.date.slice(0,4));if(match)return compactItem(i);}
      if(r.length<100)return null;
    }
    throw new ConnectorError('DEDUPE_INCOMPLETE','查重候选过多，尚未完成完整查重；未进行写入。',{scanned:rows.length});
  }
  function itemData(p,tags,collections=[]) {
    const type=p.itemType||'journalArticle';
    const specific = type==='journalArticle' ? {DOI:p.doi||'',publicationTitle:p.publicationTitle||'',volume:p.volume||'',issue:p.issue||'',pages:p.pages||''}
      : type==='conferencePaper' ? {DOI:p.doi||'',proceedingsTitle:p.publicationTitle||'',pages:p.pages||'',publisher:p.publisher||''}
      : type==='bookSection' ? {bookTitle:p.publicationTitle||'',pages:p.pages||'',publisher:p.publisher||''}
      : type==='book'||type==='document' ? {publisher:p.publisher||''}
      : type==='preprint' ? {DOI:p.doi||''} : {};
    return {itemType:type,title:p.title,creators:p.authors,url:p.url||'',date:p.date||'',abstractNote:p.abstract||'',...specific,
      tags:[...new Set([...(cfg.defaultTags||[]),...(tags||[])])].map(tag=>({tag})),collections,
      extra:[p.doi?`DOI: ${p.doi}`:'',p.pmid?`PMID: ${p.pmid}`:'',`DSH source: ${p.provenance.provider}`,`DSH source URL: ${p.provenance.recordUrl}`,`DSH retrieved: ${p.provenance.retrievedAt}`].filter(Boolean).join('\n')};
  }
  async function saveOne(p,{tags=[],collectionKeys=[],expectedTarget,expectedCollectionKey},signal){
    let selected, target;
    if (cfg.backend === 'local') {
      if (cfg.libraryType !== 'users' || cfg.libraryId !== '0') throw new ConnectorError('LOCAL_LIBRARY_UNSUPPORTED','本地 Connector 保存仅支持 /users/0 的个人文库。群组保存请使用 Web API。');
      if (collectionKeys.length) throw new ConnectorError('LOCAL_COLLECTION_UNSUPPORTED','本地 Connector 使用当前选中的集合；collectionKeys 仅适用于 Web API。');
      selected = await connector('getSelectedCollection',{body:{},signal});
      if (selected.libraryID !== cfg.expectedLocalLibraryId) throw new ConnectorError('LOCAL_LIBRARY_MISMATCH','当前 Zotero 选择的文库与配置不一致，未执行保存。',{selectedLibraryId:selected.libraryID,expectedLocalLibraryId:cfg.expectedLocalLibraryId});
      if (selected.libraryEditable !== true || selected.editable === false) throw new ConnectorError('READ_ONLY_TARGET','当前 Zotero 文库或集合不可写。');
      target = selected.id != null ? `C${selected.id}` : `L${selected.libraryID}`;
      if (expectedTarget && expectedTarget !== target) throw new ConnectorError('TARGET_CHANGED','Zotero 当前集合与 expectedTarget 不一致，尚未保存。',{expectedTarget,actualTarget:target});
      if (expectedCollectionKey) validateKey(expectedCollectionKey);
    }
    const exists=await duplicate(p,signal);if(exists){const targetVerified=cfg.backend==='web'?collectionKeys.every(k=>exists.collections.includes(k)):expectedCollectionKey?exists.collections.includes(expectedCollectionKey):selected.id==null?exists.collections.length===0:false;return {status:'duplicate',paper:p,existing:exists,verified:true,targetVerified,...(!targetVerified?{warning:'条目已存在，已跳过新增；它的目标集合归属未确认或不匹配，未移动已有条目。'}:{})};}
    if(cfg.backend==='web'){
      const inputData=itemData(p,tags,collectionKeys.map(validateKey));
      const template=await request(`https://api.zotero.org/items/new?itemType=${encodeURIComponent(inputData.itemType)}`,{signal});
      if(template.itemType!==inputData.itemType)throw new ConnectorError('INVALID_TEMPLATE','Zotero 未返回所需条目类型模板，未执行写入。');
      const data={...template,...Object.fromEntries(Object.entries(inputData).filter(([k])=>Object.hasOwn(template,k)))};
      const r=await api('/items',{method:'POST',body:[data],signal,headers:{'Zotero-Write-Token':randomUUID().replaceAll('-','')}});
      const key=r.successful?.['0']?.key||r.success?.['0'];
      if(!key)throw new ConnectorError('WRITE_REJECTED','Zotero 未报告写入成功。',{failure:r.failed?.['0']?{code:r.failed['0'].code,message:'条目校验失败，请检查元数据。'}:undefined});
      try {
        const readback=await api(`/items/${validateKey(key)}`,{signal});const d=readback.data||readback;
        const verified=titleKey(d.title)===titleKey(p.title)&&(!p.doi||storedDoi(d)===p.doi);
        const targetVerified=collectionKeys.every(k=>(d.collections||[]).includes(k));
        return {status:verified&&targetVerified?'saved':'saved_unverified',paper:p,item:compactItem(readback),verified,targetVerified,...(!verified||!targetVerified?{warning:'Web API 写入成功，但条目身份或要求的集合归属与回读不一致。'}:{})};
      } catch(e) {return {status:'saved_unverified',paper:p,key,verified:false,warning:e.message};}
    }
    const sessionID=randomUUID(); const data=itemData(p,tags);delete data.collections;
    data.extra += `\nDSH import ID: ${sessionID}`;
    const r=await connector('saveItems',{body:{sessionID,items:[{id:randomUUID(),...data,attachments:[]}],uri:p.url||'https://doi.org/'},signal});
    // Local Connector acceptance is not a durable item key. Always read back.
    let found;
    for(let attempt=0;attempt<3;attempt++) { try{ found=await duplicate(p,signal); if(found)break; }catch(e){return {status:'accepted_unverified',paper:p,sessionID,target,verified:false,warning:e.message,receiptStatus:r.status||'accepted'};} if(attempt<2)await new Promise(resolve=>setTimeout(resolve,200)); }
    if (!found) return {status:'accepted_unverified',paper:p,sessionID,target,verified:false,warning:'Connector 已接受请求，但未能回读条目；先检查文库，勿盲目重试。'};
    try {
      const record = await api(`/items/${validateKey(found.key)}`,{signal}); const d = record.data || record;
      const identityVerified = titleKey(d.title) === titleKey(p.title) && (!p.doi || storedDoi(d) === p.doi) && String(d.extra || '').includes(`DSH import ID: ${sessionID}`);
      const targetVerified = expectedCollectionKey ? (d.collections || []).includes(expectedCollectionKey) : selected.id == null ? (d.collections || []).length === 0 : false;
      return {status:identityVerified&&(!expectedCollectionKey||targetVerified)?'saved':'accepted_unverified',paper:p,item:compactItem(record),target,targetName:selected.name,sessionID,verified:identityVerified,targetVerified,attachmentPolicy:'metadata_only',...(!identityVerified?{warning:'回读条目与导入标记不一致，保存结果需检查。'}:!targetVerified?{warning:'条目身份已验证；集合归属未确认或与 expectedCollectionKey 不匹配，请检查 Zotero 保存目标。'}:{})};
    } catch(e) {return {status:'accepted_unverified',paper:p,item:found,sessionID,target,verified:false,warning:e.message};}
  }
  async function save(args,signal){
    const run=async()=>{
      const {candidateIds=[],identifiers=[]}=args;
      if(!candidateIds.length&&!identifiers.length)throw new ConnectorError('SELECTION_REQUIRED','请提供检索结果 candidateIds 或 DOI/PMID identifiers。');
      if(candidateIds.length+identifiers.length>20)throw new ConnectorError('TOO_MANY_ITEMS','每次最多保存 20 篇文献。');
      const papers=[];
      // Resolve the entire selection before starting any write.
      for(const id of candidateIds){const e=candidates.get(id);if(!e||e.expires<Date.now())throw new ConnectorError('CANDIDATE_EXPIRED','候选已过期或插件已重载，请重新检索。');papers.push(structuredClone(e.paper));}
      for(const id of identifiers)papers.push(await lookup(id,signal));
      const results=[];const seen=new Set();
      for(const p of papers){const k=p.doi||`${titleKey(p.title)}:${p.date}`;if(seen.has(k))continue;seen.add(k);
        try{results.push(await saveOne(p,args,signal));}catch(e){results.push({status:e.details?.outcomeUnknown?'outcome_unknown':'failed',paper:p,error:{code:e.code||'ERROR',message:e.message,...e.details}});if(e.details?.outcomeUnknown||signal?.aborted)break;}
      }
      return {backend:cfg.backend,results,saved:results.filter(x=>x.status==='saved').length,duplicates:results.filter(x=>x.status==='duplicate').length,allItemsVerified:results.every(x=>x.verified===true),allTargetsVerified:results.every(x=>x.targetVerified===true),allVerified:results.every(x=>(x.status==='saved'||x.status==='duplicate')&&x.verified===true&&x.targetVerified===true)};
    };
    const task=writeQueue.then(run,run); writeQueue=task.catch(()=>{});return task;
  }
  return {
    search,save,library,
    lookup:async(id,signal)=>remember(await lookup(id,signal)),
    get:async(key,signal)=>{const r=await api(`/items/${validateKey(key)}`,{signal}); return {item:compactItem(r),data:r.data||r};},
    collections:async(signal)=>{const r=await api('/collections?limit=100&format=json',{signal});if(!Array.isArray(r))throw new ConnectorError('INVALID_LIBRARY_RESPONSE','集合列表格式无效。');return {collections:r.map(c=>({key:c.key||c.data?.key,...c.data})),truncated:r.length===100};},
    status:async(signal)=>{
      const r=await api('/items/top?limit=1&format=json',{signal});if(!Array.isArray(r))throw new ConnectorError('INVALID_LIBRARY_RESPONSE','Zotero API 返回无效数据。');
      let selected;if(cfg.backend==='local'){selected=await connector('getSelectedCollection',{body:{},signal});}
      return {connected:true,backend:cfg.backend,libraryType:cfg.libraryType,libraryId:cfg.libraryId,library:r[0]?.library||null,selected:selected?{libraryId:selected.libraryID,name:selected.name,editable:selected.editable||selected.libraryEditable,expectedTarget:selected.id?`C${selected.id}`:`L${selected.libraryID}`} : null,localSavePolicy:cfg.backend==='local'?'保存至当前选中的集合；可用 expectedTarget 检查目标。':undefined,attachmentPolicy:'metadata_only'};
    },
  };
}
