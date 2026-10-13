import {render,screen,fireEvent,within} from '@testing-library/react';
import {useState} from 'react';
import {ProviderPicker} from '../ProviderPicker';
test('image catalog excludes text-only providers and retains working selections',()=>{
 const onSelect=vi.fn();render(<ProviderPicker kind="image" baseUrl="" onSelect={onSelect}/>);
 expect(screen.queryByRole('button',{name:'DeepSeek'})).toBeNull();
 expect(screen.queryByRole('button',{name:'火山方舟'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Agnes 生图'}));
 expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({images:expect.arrayContaining(['agnes-image-2.1-flash'])}));
});
test('Ark and following cards keep their selected state after clicking',()=>{
 function Harness(){const [url,setUrl]=useState('');return <ProviderPicker kind="text" baseUrl={url} onSelect={p=>setUrl(p.url)}/>;}
 render(<Harness/>);
 for(const name of ['火山方舟']){fireEvent.click(screen.getByRole('button',{name}));expect(screen.getByRole('button',{name})).toHaveAttribute('aria-pressed','true');}
});
