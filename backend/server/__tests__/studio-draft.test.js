import {it,expect} from 'vitest';
import {saveDraft} from '../../../scripts/studio-draft.mjs';
it('clicks only an exact draft action and never publish',()=>{
 document.body.innerHTML='<button>发布</button><button>暂存离开</button>';
 const buttons=[...document.querySelectorAll('button')];let saved=0,published=0;
 buttons.forEach(b=>b.getBoundingClientRect=()=>({width:100,height:40}));
 buttons[0].onclick=()=>published++;
 buttons[1].onclick=()=>saved++;
 expect(saveDraft()).toEqual({ok:true});expect(saved).toBe(1);expect(published).toBe(0);
});
it('refuses when only publish exists',()=>{
 document.body.innerHTML='<button>发布</button>';
 document.querySelector('button').getBoundingClientRect=()=>({width:100,height:40});
 expect(()=>saveDraft()).toThrow('暂存离开');
});
