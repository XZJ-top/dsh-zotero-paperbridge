import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '../lib/client.js';
const paper={DOI:'10.1234/test',type:'journal-article',title:['Article'],published:{'date-parts':[[null]]},issued:{'date-parts':[[2024,null]]},author:[{given:'Ada',family:'Lee'}]};
function transport({failBody=false,collection='COLLKEY1',search=false}={}){let marker='',saved=false;return async(url,opts)=>{
 if(url.startsWith('https://api.crossref.org/works'))return Response.json({message:url.includes('?')?{items:[paper],'total-results':1}:paper});
 if(url.startsWith('https://www.ebi.ac.uk/'))return Response.json({resultList:{result:[{source:'MED',id:'12345',title:'Europe Article',doi:'10.9999/europe',pubYear:'2023'}]},hitCount:1});
 if(url.includes('getSelectedCollection'))return Response.json({id:1,libraryID:1,editable:true,libraryEditable:true});
 if(url.includes('/items/top?'))return Response.json(saved?[{key:'ABCDEFGH',data:{title:'Article',DOI:paper.DOI,collections:[collection]}}]:[]);
 if(url.includes('saveItems')){saved=true;marker=JSON.parse(opts.body).sessionID;if(failBody)return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));c.error(new Error('private-response-secret'));}}),{status:201});return new Response(null,{status:201});}
 if(url.endsWith('/items/ABCDEFGH'))return Response.json({key:'ABCDEFGH',data:{title:'Article',DOI:paper.DOI,extra:`DSH import ID: ${marker}`,collections:[collection]}});
 throw new Error('Unexpected request');
};}
test('missing Crossref published date falls back and never writes null date',async()=>{const c=createClient({}, {fetch:transport()});const p=await c.lookup(paper.DOI);assert.equal(p.date,'2024');assert.equal(p.itemType,'journalArticle');});
test('all sources are interleaved rather than truncating away Europe PMC',async()=>{const c=createClient({}, {fetch:transport()});const r=await c.search({query:'x',source:'all',limit:2});assert.deepEqual(r.results.map(p=>p.source),['crossref','europepmc']);});
test('POST headers followed by broken body is outcome_unknown with sanitized error',async()=>{const c=createClient({}, {fetch:transport({failBody:true})});const r=await c.save({identifiers:[paper.DOI]});assert.equal(r.results[0].status,'outcome_unknown');assert.ok(!JSON.stringify(r).includes('private-response-secret'));});
test('requested collection mismatch cannot report fully verified saving',async()=>{const c=createClient({}, {fetch:transport({collection:'WRONGKEY'})});const r=await c.save({identifiers:[paper.DOI],expectedCollectionKey:'COLLKEY1'});assert.equal(r.results[0].status,'accepted_unverified');assert.equal(r.allItemsVerified,true);assert.equal(r.allTargetsVerified,false);assert.equal(r.allVerified,false);});
test('without local collection key identity evidence remains separate from target evidence',async()=>{const c=createClient({}, {fetch:transport()});const r=await c.save({identifiers:[paper.DOI]});assert.equal(r.results[0].status,'saved');assert.equal(r.results[0].verified,true);assert.equal(r.allVerified,false);assert.equal(r.allTargetsVerified,false);});
