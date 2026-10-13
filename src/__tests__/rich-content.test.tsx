import { render,screen,fireEvent } from '@testing-library/react';
import { NoteDetail } from '../NoteContent';
import type { Note } from '../../server/domain';

const base:Note={id:'n1',accountId:'a1',title:'Test note',summary:'Complete text',cover:null,url:null,publishedAt:'2026-09-07',metrics:{likes:null,collects:null,comments:null,shares:null}};
test('video detail uses playable media instead of cover and scopes its comments',()=>{
  render(<NoteDetail note={{...base,mediaType:'video',videoUrl:'https://example.com/test.mp4'}} account="Test" onClose={()=>{}} comments={[{id:'c1',accountId:'a1',noteId:'n1',author:'Reader',avatar:'',body:'Visible comment',createdAt:'today',status:'pending',tags:[]},{id:'c2',accountId:'a2',noteId:'n1',author:'Other',avatar:'',body:'Other account secret',createdAt:'today',status:'pending',tags:[]}]}/>);
  expect(screen.getByLabelText('笔记视频')).toHaveAttribute('src','https://example.com/test.mp4');
  expect(screen.getByLabelText('笔记视频')).toHaveAttribute('controls');
  expect(screen.getByText('Visible comment')).toBeInTheDocument();
  expect(screen.queryByText('Other account secret')).not.toBeInTheDocument();
});
test('all captured images are accessible through the gallery',()=>{
  render(<NoteDetail note={{...base,mediaType:'image',images:['https://example.com/1.jpg','https://example.com/2.jpg']}} account="Test" onClose={()=>{}}/>);
  expect(screen.getByRole('img',{name:'笔记图片 1 / 2'})).toHaveAttribute('src','https://example.com/1.jpg');
  fireEvent.click(screen.getByRole('button',{name:'下一张'}));
  expect(screen.getByRole('img',{name:'笔记图片 2 / 2'})).toHaveAttribute('src','https://example.com/2.jpg');
});
