import test from 'node:test';import assert from 'node:assert/strict';
import {summarizeNewsReview} from '../src/domain/news-review.ts';import {prioritizeNews} from '../src/domain/news-priority.ts';
const now=new Date('2026-09-27T12:00:00Z'),sources=Array.from({length:3},()=>({state:'current',lastSuccess:now.toISOString()}));
function article(title:string,publishedAt='2026-09-27T10:00:00Z'){return{title,url:'https://example.test/news',publishedAt,evidence:{targets:['SOXL']},priority:prioritizeNews({title,publishedAt,updatedAt:null,source:'alpaca',symbols:['NVDA']},now)};}
test('no coverage never becomes clearance; partial failure and old acquisition remain insufficient',()=>{
 assert.equal(summarizeNewsReview([],sources,now)[0].state,'insufficient');
 const articles=[article('Nvidia raises guidance')];assert.equal(summarizeNewsReview(articles,sources,now)[0].state,'not-detected');assert.equal(summarizeNewsReview(articles,sources,now)[1].state,'insufficient');
 assert.equal(summarizeNewsReview(articles,[...sources.slice(0,2),{state:'failed',lastSuccess:null}],now)[0].state,'insufficient');
 assert.equal(summarizeNewsReview(articles,sources,new Date(+now+3*3600000))[0].state,'insufficient');
});
test('adverse and uncertain concerns are retained, not converted into proof of a price-drop cause',()=>{
 const result=summarizeNewsReview([article('Nvidia may cut guidance')],sources,now)[0];assert.equal(result.state,'concerns');assert.equal(result.count,1);assert.match(result.reasons[0].reason,/予想/);
 const old=summarizeNewsReview([article('Nvidia cuts guidance','2026-09-01T10:00:00Z')],sources,now)[0];assert.equal(old.state,'insufficient');
});
