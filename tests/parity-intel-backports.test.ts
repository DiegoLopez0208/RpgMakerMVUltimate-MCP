import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { validateProject } from '../src/intel/validate.js';
import { analyzeProject } from '../src/intel/analyze.js';
import { getProjectIndex, clearProjectIndexCache } from '../src/intel/projectIndex.js';
import { buildMapGraph, findUsage, reachableMaps, whatBreaksIfMapRemoved, explainSwitch } from '../src/intel/graph.js';
import { detectDuplicates } from '../src/intel/refactor.js';
import { analyseBalance } from '../src/intel/balance.js';
import { gatherDocuments, rankDocuments } from '../src/intel/search.js';
import type { RawCommand } from '../src/intel/eventAst.js';
const roots: string[]=[];
const c=(code:number, parameters:unknown[]=[],indent=0):RawCommand=>({code,parameters,indent});
const end=c(0);
const block=[c(121,[7,7,0]),c(122,[7,7,0,0,12]),c(230,[20]),c(356,['Reward give'])];
async function project(files:Record<string,unknown>) {const root=await mkdtemp(join(tmpdir(),'mv-intel-parity-'));roots.push(root);await mkdir(join(root,'data'));for(const [name,data] of Object.entries({'System.json':{startMapId:1,switches:['','Gate'],variables:[]},...files}))await writeFile(join(root,'data',name),JSON.stringify(data));return root;}
function map(list:RawCommand[]) { return {width:2,height:2,events:[null,{id:1,name:'Door',x:0,y:0,pages:[{list}]}]}; }
afterEach(async()=>{clearProjectIndexCache();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
describe('analysis MV parity',()=>{
  it('follows nested common-event transfers cycle-safely, retaining dynamic/plugin unknowns',async()=>{
    const root=await project({
      'MapInfos.json':[null,{id:1,name:'Town'},{id:2,name:'Cave'},{id:3,name:'Deep'}],
      'Map001.json':map([c(117,[1]),c(201,[1,1,2,3,0,0]),c(356,['Warp home']),c(117,[99]),end]),
      'Map002.json':map([c(201,[0,3,0,0,0,0]),end]),'Map003.json':map([end]),
      'CommonEvents.json':[null,{id:1,list:[c(117,[2]),end]},{id:2,list:[c(117,[1]),c(201,[0,2,0,0,0,0]),end]}]
    });
    const index=await getProjectIndex(root,true);const graph=buildMapGraph(index);
    expect(reachableMaps(index,1)).toEqual([1,2,3]);
    expect(graph.edges).toContainEqual(expect.objectContaining({from:1,to:2}));
    expect((graph as any).unresolved.map((u:any)=>u.reason).join(' ')).toMatch(/variable.*Script\/plugin.*99/s);
    expect(whatBreaksIfMapRemoved(index,2).newlyUnreachable).toEqual([{id:3,name:'Deep'}]);
    expect(index.maps[0].transfers[0]).toMatchObject({viaCommonEvents:[1,2]});
  });
  it('does not report missing or nonexistent maps as reachable',async()=>{
    const root=await project({'MapInfos.json':[null,{id:1,name:'Missing'},{id:2,name:'Present'}],'Map002.json':map([end])});
    const index=await getProjectIndex(root,true);expect(reachableMaps(index,1)).toEqual([]);expect(reachableMaps(index,999)).toEqual([]);
  });
  it('queries IDs inside enormous ranges without enumerating the range',async()=>{
    const root=await project({'MapInfos.json':[null,{id:1,name:'Town'}],'Map001.json':map([c(121,[5,1_000_000_000,0]),c(122,[5,1_000_000_000,1,0,2]),end])});
    const index=await getProjectIndex(root,true);
    expect(findUsage(index,'switches',900_000_000)).toContainEqual(expect.objectContaining({role:'write'}));
    expect(findUsage(index,'variables',900_000_000)).toContainEqual(expect.objectContaining({role:'both'}));
    expect(index.refSources[0].refs.switches.length).toBeLessThan(10002);
    index.switches.push({id:900_000_000,name:'Range member'}, {id:1_000_000_001,name:'Unknown'});
    index.variables.push({id:900_000_000,name:'Range member'});
    const issues=validateProject(index).issues;
    expect(issues.some(issue=>issue.id===900_000_000 && issue.category.startsWith('unused-'))).toBe(false);
    expect(issues.find(issue=>issue.id===1_000_000_001)?.message).toMatch(/no static use|no static reference/);
  });
  it('describes missing static writers without claiming runtime impossibility',async()=>{
    const root=await project({'MapInfos.json':[null,{id:1,name:'Town'}],'Map001.json':map([c(111,[0,1,0]),end])});
    const diagnosis=explainSwitch(await getProjectIndex(root,true),1).diagnosis;
    expect(diagnosis).toMatch(/static|statically/i);expect(diagnosis).not.toMatch(/can never trigger|NEVER set ON/);
  });
  it('accepts troop page outlines and includes troops when proposing duplicates',async()=>{
    const root=await project({'MapInfos.json':[],'CommonEvents.json':[null,{id:1,name:'Reward',list:[...block,end]}],'Troops.json':[null,{id:1,name:'Bats',pages:[{list:[end]},{list:[...block,end]}]}]});
    const ast=await analyzeProject(root,{view:'ast',troopId:1,page:1}) as any;
    expect(ast.outline).toMatch(/Plugin|Reward/);
    const duplicate=await analyzeProject(root,{view:'refactor',minLen:4}) as any;
    expect(duplicate.duplicateBlocks.flatMap((b:any)=>b.occurrences.map((o:any)=>o.label))).toContain('Troop 1 "Bats" p1');
  });
  it('compares relative indentation and rejects different nesting',()=>{
    const nested=block.map((cmd,i)=>({...cmd,indent:[0,1,1,0][i]}));
    const shifted=nested.map(cmd=>({...cmd,indent:cmd.indent!+2}));
    expect(detectDuplicates([{label:'A',commands:nested},{label:'B',commands:shifted}],4).blockCount).toBe(1);
    const changed=shifted.map((cmd,i)=>({...cmd,indent:[2,2,3,2][i]}));
    expect(detectDuplicates([{label:'A',commands:nested},{label:'B',commands:changed}],4).blockCount).toBe(0);
    expect(()=>detectDuplicates([],0)).toThrow(/minLen/);
  });
  it('reports a different value against identical peers with null deviations',async()=>{
    const root=await project({'Skills.json':[null,...[100,100,100,900].map((n,i)=>({id:i+1,name:`S${i}`,mpCost:10,damage:{type:1,formula:String(n)}}))]});
    const result=await analyseBalance(root,{category:'skills'});
    expect(result.categories[0].outliers).toContainEqual(expect.objectContaining({id:4,direction:'high',deviations:null}));
    expect(JSON.stringify(result)).not.toMatch(/Infinity|NaN/);
  });
  it('searches troop choices and MV plugin text without losing existing ranking',async()=>{
    const root=await project({'Troops.json':[null,{id:1,name:'Bats',pages:[{list:[c(102,[['surrender','retreat'],-1,0,2,0]),c(356,['VictoryBadge bronze']),end]}]}]});
    const docs=await gatherDocuments(root);
    expect(rankDocuments(docs,'surrender')[0]).toMatchObject({type:'troop',id:1});
    expect(rankDocuments(docs,'VictoryBadge')[0]).toMatchObject({type:'troop',id:1});
  });
});
