import {render,screen,fireEvent} from '@testing-library/react';
import {ImagePreview} from '../ImagePreview';
test('preview supports navigation, Escape and scroll restoration',()=>{
 const close=vi.fn(),index=vi.fn();document.body.style.overflow='auto';
 const view=render(<ImagePreview images={['/one.png','/two.png']} index={0} onIndex={index} onClose={close}/>);
 expect(screen.getByRole('dialog',{name:'图片预览'})).toBeInTheDocument();expect(screen.getByAltText('放大配图 1')).toHaveAttribute('src','/one.png');
 fireEvent.click(screen.getByRole('button',{name:'下一张'}));expect(index).toHaveBeenCalledWith(1);fireEvent.keyDown(window,{key:'Escape'});expect(close).toHaveBeenCalledOnce();view.unmount();expect(document.body.style.overflow).toBe('auto');
});
