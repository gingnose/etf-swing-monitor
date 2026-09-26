import test from 'node:test';import assert from 'node:assert/strict';
import {prioritizeNews} from '../src/domain/news-priority.ts';
const now=new Date('2026-09-27T12:00:00Z');
const rank=(title:string,source:'alpaca'|'fed'|'nvidia'='alpaca',publishedAt='2026-09-27T10:00:00Z')=>prioritizeNews({title,source,publishedAt,updatedAt:null,symbols:['NVDA']},now);
test('clear new outlook changes identify both directions without estimating returns',()=>{
 const negative=rank('Nvidia cuts quarterly revenue guidance');assert.equal(negative.level,'critical');assert.equal(negative.direction,'negative');assert.equal(negative.concern,true);
 const positive=rank('Nvidia raises quarterly revenue guidance');assert.equal(positive.level,'critical');assert.equal(positive.direction,'positive');assert.equal(positive.concern,false);
 assert.notEqual(negative.eventKey,positive.eventKey);
 assert.equal(rank('Other company cuts guidance after Nvidia announcement').level,'important');
});
test('speculation, negation, reported rumors, recaps, ambiguous clauses never trigger',()=>{
 for(const title of ['Nvidia may cut guidance','Nvidia raises guidance?','Nvidia denies guidance cuts','Nvidia raises guidance, analyst says','Nvidia raises guidance: unconfirmed rumor','Nvidia raises guidance but cuts jobs','Nvidia raises guidance after lowering estimates','Nvidia raises guidance: report is false','Nvidia reportedly raises guidance','Nvidia plans to cut guidance','Weekly roundup: Nvidia cuts guidance','Nvidia cuts prices but raises guidance'])assert.notEqual(rank(title).level,'critical',title);
 assert.equal(rank('Nvidia denies export restrictions').direction,'unknown');
 assert.equal(rank('Nvidia faces bans').level,'important');assert.equal(rank('Nvidia delays chip production').concern,true);assert.equal(rank('Nvidia delays chip production').level,'important');
});
test('official decisions and earnings, reported export changes; no broad keyword triggers',()=>{
 assert.equal(rank('Federal Reserve issues FOMC statement','fed').level,'critical');
 assert.equal(rank('Federal Reserve raises concerns about interest rates','fed').level,'important');
 assert.equal(rank('NVIDIA Announces Financial Results for Second Quarter Fiscal 2027','nvidia').level,'critical');
 assert.equal(rank('NVIDIA Announces New Game','nvidia').level,'normal');
 assert.equal(rank('U.S. imposes new restrictions on chip exports').direction,'negative');
 assert.equal(rank('US lifts restrictions on Nvidia chip exports').direction,'positive');
 assert.equal(rank('US considers new restrictions on Nvidia exports').level,'important');
});
test('publication time controls freshness; update time cannot revive an old story',()=>{
 const old=rank('Nvidia cuts guidance','alpaca','2026-09-20T10:00:00Z');assert.equal(old.level,'important');assert.equal(old.eventKey,null);
 assert.notEqual(rank('Nvidia cuts guidance','alpaca','2026-09-28T10:00:00Z').level,'critical');
});
