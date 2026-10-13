import { render,screen,fireEvent,waitFor } from '@testing-library/react';
import { TemplateLibrary,prepareTemplateImage } from '../TemplateLibrary';
import { PublishCenter } from '../PublishCenter';
test('upload is visible to customers without platform admin and saves then selects the uploaded image',async()=>{
  const item={id:'one',name:'历史素材',category:'生活方式',images:['/api/templates/media/one.png']};
  const onUse=vi.fn();
  const request=vi.fn(async(path:string)=>path==='templates/mine'?{items:[]}:{item});
  render(<TemplateLibrary request={request} onUse={onUse}/>);
  expect(screen.getByRole('button',{name:'上传图片'})).toBeVisible();
  fireEvent.change(screen.getByLabelText('本地图片文件'),{target:{files:[new File(['bytes'],'历史素材.png',{type:'image/png'})]}});
  await screen.findByRole('checkbox',{name:'选择 历史素材'});
  expect(request).toHaveBeenCalledWith('templates/upload',expect.objectContaining({fileName:'历史素材.png'}));
  fireEvent.click(screen.getByRole('checkbox',{name:'选择 历史素材'}));
  fireEvent.click(screen.getByRole('button',{name:'使用所选图片'}));
  expect(onUse).toHaveBeenCalledWith([item]);
});
test('failed uploads stay visible and do not prevent subsequent images being saved',async()=>{
  const request=vi.fn(async(path:string)=>path==='templates/mine'?{items:[]}:(()=>{throw Error('空间不足');})());
  render(<TemplateLibrary request={request} onUse={()=>{}}/>);
  fireEvent.change(screen.getByLabelText('本地图片文件'),{target:{files:[new File(['x'],'中文.png',{type:'image/png'})]}});
  await screen.findByText('空间不足');
  expect(screen.getByRole('button',{name:'上传图片'})).toBeEnabled();
});
test('selecting material switches to creation without overriding the written topic',async()=>{
  const item={id:'one',name:'历史素材',category:'生活方式',images:['/api/templates/media/one.png']};
  const request=async(path:string)=>path==='studio'?[]:path==='templates/mine'?{items:[item]}:{imageModel:'gpt-image-1',model:'text'};
  render(<PublishCenter request={request} accounts={[]}/>);
  fireEvent.click(screen.getByRole('tab',{name:'图文创作'}));
  fireEvent.change(screen.getByLabelText('选题'),{target:{value:'我的独立文案选题'}});
  fireEvent.click(screen.getByRole('tab',{name:'模板素材库'}));
  fireEvent.click(await screen.findByRole('checkbox',{name:'选择 历史素材'}));
  fireEvent.click(screen.getByRole('button',{name:'使用所选图片'}));
  await waitFor(()=>expect(screen.getByLabelText('选题')).toHaveValue('我的独立文案选题'));
  expect(screen.getByRole('tab',{name:'素材二创'})).toHaveAttribute('aria-selected','true');
  expect(screen.getByRole('slider',{name:'二创强度'})).toHaveValue('0.6');
});
test('large camera JPEG is compressed before upload and reports the size reduction',async()=>{
  const originalCreateImageBitmap=globalThis.createImageBitmap;
  const originalToBlob=HTMLCanvasElement.prototype.toBlob;
  globalThis.createImageBitmap=vi.fn(async()=>({width:6000,height:3376,close:vi.fn()} as unknown as ImageBitmap));
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:vi.fn()} as unknown as CanvasRenderingContext2D);
  HTMLCanvasElement.prototype.toBlob=function(callback){callback(new Blob([new Uint8Array(400_000)],{type:'image/jpeg'}));};
  const file=new File([new Uint8Array(6_000_000)],'_DSC2146.jpg',{type:'image/jpeg'});
  try{
    const result=await prepareTemplateImage(file);
    expect(result.compressed).toBe(true);expect(result.bytes).toBe(400_000);expect(result.data).toMatch(/^data:image\/jpeg;base64,/);
  }finally{
    globalThis.createImageBitmap=originalCreateImageBitmap;
    HTMLCanvasElement.prototype.toBlob=originalToBlob;
    vi.restoreAllMocks();
  }
});
