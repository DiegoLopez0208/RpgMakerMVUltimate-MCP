import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { batchToolDefinitions } from '../src/parity/tools/batchTools.js';
import { actorToolDefinitions, createActor, updateActor } from '../src/parity/tools/actorTools.js';
import { itemToolDefinitions } from '../src/parity/tools/itemTools.js';
import { skillToolDefinitions } from '../src/parity/tools/skillTools.js';
import { battleToolDefinitions } from '../src/parity/tools/battleTools.js';
import { stateToolDefinitions } from '../src/parity/tools/stateTools.js';
import { classToolDefinitions, createClass, updateClass } from '../src/parity/tools/classTools.js';
import { commonEventToolDefinitions } from '../src/parity/tools/commonEventTools.js';
import { commitChange, commitStore } from '../src/parity/utils/commit.js';
import { nextFreeId } from '../src/parity/tools/idTools.js';
const definitions=[...actorToolDefinitions,...itemToolDefinitions,...skillToolDefinitions,...battleToolDefinitions,...stateToolDefinitions,...classToolDefinitions,...commonEventToolDefinitions];
const tableNames: Record<string,string>={actor:'Actors',item:'Items',weapon:'Weapons',armor:'Armors',skill:'Skills',enemy:'Enemies',state:'States',class:'Classes',troop:'Troops',common_event:'CommonEvents'};
let root:string;
async function write(name:string,data:unknown) { await writeFile(join(root,'data',name),JSON.stringify(data)); }
beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),'mv-db-integrity-'));await mkdir(join(root,'data'));
  for(const table of Object.values(tableNames))await write(table+'.json',[null,{id:1,name:'Existing',learnings:[]},null]);
  await write('MapInfos.json',[]);await write('System.json',{switches:['','claimed'],variables:[''],partyMembers:[]});
});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
describe('MV database write integrity',()=>{
  it.each(Object.keys(tableNames))('keeps %s single-created ID equal to its database slot after a deletion',async type=>{
    const tool=definitions.find(d=>d.name===`create_${type}`)!;
    await tool.handler({projectPath:root},{name:'New',...(type==='troop'?{members:[]}:{} )});
    const stored=JSON.parse(await readFile(join(root,'data',tableNames[type]+'.json'),'utf8'));
    expect(stored[2]).toMatchObject({id:2,name:'New'});
    expect(stored).toHaveLength(3);
  });
  it('keeps sequential batch IDs aligned after trailing nulls',async()=>{
    await batchToolDefinitions[0].handler({projectPath:root},{type:'item',records:[{name:'A'},{name:'B'}]});
    const stored=JSON.parse(await readFile(join(root,'data/Items.json'),'utf8'));
    expect(stored.slice(2).map((row:any)=>[row.id,row.name])).toEqual([[2,'A'],[3,'B']]);
  });
  it.each([{name:42},{name:'Bad',equips:'bad'},{name:'Bad',classId:999}])('rejects invalid actor batches with zero commits: %s',async input=>{
    const file=join(root,'data/Actors.json');const before=await readFile(file,'utf8');
    const context={dryRun:false,commits:[]};
    await expect(commitStore.run(context,()=>batchToolDefinitions[0].handler({projectPath:root},{type:'actor',records:[{name:'Good'},input]}))).rejects.toThrow(/records\[1\]/);
    expect(context.commits).toEqual([]);expect(await readFile(file,'utf8')).toBe(before);
  });
  it('rejects missing actor classes and class learnings for direct creates and updates',async()=>{
    const actorBefore=await readFile(join(root,'data/Actors.json'),'utf8');
    const classBefore=await readFile(join(root,'data/Classes.json'),'utf8');
    await expect(createActor(root,{name:'Bad',classId:999})).rejects.toThrow(/classId/);
    await expect(updateActor(root,1,{classId:999})).rejects.toThrow(/classId/);
    await expect(createClass(root,{name:'Bad',learnings:[{skillId:999,level:1,note:''}]})).rejects.toThrow(/skillId/);
    await expect(updateClass(root,1,{learnings:[{skillId:999,level:1,note:''}]})).rejects.toThrow(/skillId/);
    await expect(batchToolDefinitions[0].handler({projectPath:root},{type:'class',records:[{name:'Bad',learnings:[{skillId:999,level:1,note:''}]}]})).rejects.toThrow(/records\[0\].*skillId/);
    expect(await readFile(join(root,'data/Actors.json'),'utf8')).toBe(actorBefore);
    expect(await readFile(join(root,'data/Classes.json'),'utf8')).toBe(classBefore);
  });
  it('reads BOM JSON consistently when diffing and committing',async()=>{
    const file=join(root,'data/System.json');await writeFile(file,'\uFEFF{"value":1}');
    const result=await commitChange(file,{value:2});
    expect(result.diff.changes).toEqual([{path:'value',from:1,to:2}]);
    expect(JSON.parse(await readFile(file,'utf8'))).toEqual({value:2});
  });
  it('requires growing MV name-array capacity before suggested IDs work',async()=>{
    const result=await nextFreeId(root,'switch');
    expect(result.ids).toEqual([2]);
    expect(result.warnings.join(' ')).toMatch(/ignores?d?|not.*work|must|before.*us/i);
    expect(result.warnings.join(' ')).not.toContain('Ids above that work at runtime');
  });
});
