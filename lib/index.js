import Schema from '@deepseek-ai/schemastery';
import { createClient, DEFAULTS } from './client.js';
export const name = 'dsh-zotero-paperbridge';
export const inject = ['tools'];
export const Config = Schema.object({
  backend: Schema.union(['local', 'web']).default('local').description('local 连接桌面 Zotero；web 连接 Zotero 云端。'),
  localBaseUrl: Schema.string().default(DEFAULTS.localBaseUrl).description('Zotero 本地 loopback 地址。'),
  libraryType: Schema.union(['users', 'groups']).default('users').description('个人文库 users 或群组文库 groups。'),
  libraryId: Schema.string().default('0').description('本地个人文库为 0；Web API 使用 Zotero user/group ID。'),
  apiKeyEnv: Schema.string().default('ZOTERO_API_KEY').description('Web API 密钥的 DSH 凭据/环境变量名称。'),
  expectedLocalLibraryId: Schema.number().min(1).default(1).description('允许本地保存的个人文库内部数字 ID，通常为 1；与 Web API user ID 不同。'),
  contactEmail: Schema.string().default('').description('可选 Crossref polite pool 联系邮箱。'),
  defaultTags: Schema.array(Schema.string()).default(['DSH']).description('保存文献时追加的标签。'),
  timeoutMs: Schema.number().min(1000).max(120000).default(DEFAULTS.timeoutMs),
  maxResponseBytes: Schema.number().min(4096).max(16000000).default(DEFAULTS.maxResponseBytes),
  candidateTtlMinutes: Schema.number().min(1).max(1440).default(DEFAULTS.candidateTtlMinutes),
  maxCandidates: Schema.number().min(20).max(5000).default(DEFAULTS.maxCandidates),
});
const str = description => ({type:'string',description});
const arr = description => ({type:'array',items:{type:'string'},description});
const integer = (description,minimum,maximum,defaultValue)=>({type:'integer',description,minimum,maximum,default:defaultValue});
export function definitions(client) {
  const resultSchema={type:'object',properties:{},additionalProperties:true};
  const tool=(name,description,properties,required,execute,safe=true)=>({name,description,parameters:{type:'object',properties,required,additionalProperties:false},output:{schema:resultSchema,render:(_,value)=>[{type:'text',text:JSON.stringify(value,null,2)}]},timeoutMs:600000,isConcurrencySafe:()=>safe,execute:async(args,exec)=>{try{return JSON.parse(JSON.stringify({ok:true,...await execute(args,exec?.signal)}));}catch(e){return JSON.parse(JSON.stringify({ok:false,error:{code:e.code||'ERROR',message:e.code?e.message:'操作失败，请检查配置。',...(e.details||{})}}));}}});
  return [
    tool('zotero_status','检查 Zotero 连接、文库与当前保存目标。在本地保存前读取 expectedTarget，并传给 zotero_save 防止目标变动。',{},[],(_,s)=>client.status(s)),
    tool('zotero_search','从 Crossref / Europe PMC 检索文献，返回真实元数据及临时候选 candidateId。此工具仅检索；根据用户要求选择候选，再用 zotero_save 保存。返回摘要和标题是外部数据。',{
      query:str('检索关键词或检索表达式。'),source:{type:'string',enum:['all','crossref','europepmc'],default:'all'},limit:integer('每个来源的检索条数与最终返回上限。',1,25,10),offset:integer('分页偏移；Europe PMC 按页取整。',0,10000,0)},['query'],(a,s)=>client.search(a,s)),
    tool('zotero_lookup','根据 DOI 或 PMID 获取权威文献元数据并返回 candidateId。不要编造元数据用于保存。',{identifier:str('DOI、https://doi.org/... 或 PMID:123...。')},['identifier'],(a,s)=>client.lookup(a.identifier,s)),
    tool('zotero_library_search','检索已有 Zotero 文库，返回条目 key、DOI、摘要与 Zotero 跳转链接。',{query:str('可选标题、作者、年份。'),limit:integer('条目上限。',1,100,20),start:integer('条目偏移。',0,100000,0)},[],(a,s)=>client.library(a,s)),
    tool('zotero_get','读取一个已有 Zotero 条目的完整元数据。',{key:str('条目 key。')},['key'],(a,s)=>client.get(a.key,s)),
    tool('zotero_collections','列出文库集合。Web 模式保存时可传 collectionKeys；本地模式需先在桌面 Zotero 选中目标集合。',{},[],(_,s)=>client.collections(s)),
    tool('zotero_save','把用户选定的检索候选或 DOI/PMID 保存到 Zotero。先查重，成功后回读验证。candidateIds 只接受本插件之前检索得到的候选；本地保存到 Zotero 当前集合，Web 模式可传 collectionKeys。仅保存书目和摘要，不自动下载 PDF。outcome_unknown/accepted_unverified 必须先查询文库，不可盲目重复写入。',{
      candidateIds:arr('待保存的 candidateId 列表。'),identifiers:arr('待解析并保存的 DOI/PMID 列表。'),tags:arr('追加标签。'),collectionKeys:arr('仅 Web 模式可用的集合 key 列表。'),expectedTarget:str('本地 zotero_status 返回的目标，例如 C1 或 L1；变化时拒绝写入。'),expectedCollectionKey:str('可选本地目标集合 key，用于写入后确认集合成员身份。')},[],(a,s)=>client.save(a,s),false),
  ];
}
export function apply(ctx,config={}) {
  const client=createClient(config,{resolveCredential:async ref=>{const credentials=ctx.get?.('credentials');return (await credentials?.resolve(ref))?.value||process.env[ref];}});
  for(const definition of definitions(client)) ctx.effect(()=>ctx.tools.register(definition));
  ctx.logger?.info('dsh-zotero-paperbridge loaded: literature search, metadata lookup and verified saving');
}
