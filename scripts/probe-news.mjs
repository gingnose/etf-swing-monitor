import {readPrivateConfig} from './private-config.mjs';import {fetchNews} from '../src/server/news.ts';
import {mkdirSync,writeFileSync} from 'node:fs';import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');const env=readPrivateConfig(root);mkdirSync(resolve(root,'private'),{recursive:true,mode:0o700});
for(const source of ['alpaca','fed','nvidia']){
 try{const now=new Date(),result=await fetchNews(source,env,now);writeFileSync(resolve(root,`private/news-probe-${source}.json`),JSON.stringify({checkedAt:now.toISOString(),...result},null,2),{mode:0o600});console.log(JSON.stringify({source,accepted:result.articles.length,rejected:result.rejected,limited:result.limited,topics:[...new Set(result.articles.flatMap(a=>a.evidence.topics))]}));}
 catch(e){console.error(source+': '+e.message);process.exitCode=1;}
}
