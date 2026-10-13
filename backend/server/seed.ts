import type { Database } from './domain';

export const seedDatabase: Database = {
  accounts: [
    { id: 'acc-1', name: '山野研究所', handle: 'mountain_lab', avatar: 'https://images.unsplash.com/photo-1497250681960-ef046c08a56e?auto=format&fit=crop&w=96&q=80', profile: 'xhs-mountain', state: 'connected', followers: 128560, lastSyncedAt: '2026-09-02T16:20:00.000Z' },
    { id: 'acc-2', name: '城市漫游局', handle: 'city_roamer', avatar: 'https://images.unsplash.com/photo-1519501025264-65ba15a82390?auto=format&fit=crop&w=96&q=80', profile: 'xhs-city', state: 'connected', followers: 96320, lastSyncedAt: '2026-09-02T16:18:00.000Z' },
    { id: 'acc-3', name: '生活灵感库', handle: 'life_inspo', avatar: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=96&q=80', profile: 'xhs-life', state: 'attention', followers: 78910, lastSyncedAt: '2026-09-01T15:10:00.000Z' }
  ],
  notes: [
    { id: 'note-1', accountId: 'acc-1', title: '杭州周边一日徒步：从山谷到云海', summary: '把路线、时间与装备都整理成了一页清单。', cover: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=480&q=80', url: 'https://www.xiaohongshu.com', publishedAt: '2026-09-01T08:20:00.000Z', metrics: { likes: 4280, collects: 1960, comments: 146, shares: 228 } },
    { id: 'note-2', accountId: 'acc-1', title: '帐篷怎么选，三种场景的实测答案', summary: '露营新手最容易忽略的四个细节。', cover: 'https://images.unsplash.com/photo-1504851149312-7a075b496cc7?auto=format&fit=crop&w=480&q=80', url: 'https://www.xiaohongshu.com', publishedAt: '2026-08-29T10:00:00.000Z', metrics: { likes: 2840, collects: 880, comments: 72, shares: 96 } },
    { id: 'note-3', accountId: 'acc-2', title: '周末两天一夜，旧城区慢行地图', summary: '从早咖啡到夜晚散步的完整路线。', cover: 'https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?auto=format&fit=crop&w=480&q=80', url: 'https://www.xiaohongshu.com', publishedAt: '2026-08-31T09:10:00.000Z', metrics: { likes: 3180, collects: 1420, comments: 98, shares: 162 } },
    { id: 'note-4', accountId: 'acc-3', title: '租房改造：20㎡也能留住呼吸感', summary: '只改变三处，就让空间显得松弛。', cover: 'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=480&q=80', url: 'https://www.xiaohongshu.com', publishedAt: '2026-08-30T06:45:00.000Z', metrics: { likes: 2210, collects: 1310, comments: 63, shares: 74 } }
  ],
  comments: [
    { id: 'comment-1', accountId: 'acc-1', noteId: 'note-1', author: '西山的风', avatar: 'https://i.pravatar.cc/80?img=47', body: '想看周末路线吗？我们团队正计划一场轻徒步。', createdAt: '2026-09-02T15:52:00.000Z', status: 'pending', tags: ['高意向'] },
    { id: 'comment-2', accountId: 'acc-2', noteId: 'note-3', author: '阿岚', avatar: 'https://i.pravatar.cc/80?img=32', body: '这个路线适合带爸妈吗？有没有更轻松的版本？', createdAt: '2026-09-02T15:32:00.000Z', status: 'pending', tags: ['咨询'] },
    { id: 'comment-3', accountId: 'acc-3', noteId: 'note-4', author: '安静生活家', avatar: 'https://i.pravatar.cc/80?img=45', body: '收纳柜的尺寸可以分享一下吗？', createdAt: '2026-09-02T14:46:00.000Z', status: 'processed', tags: ['已回复'] },
    { id: 'comment-4', accountId: 'acc-1', noteId: 'note-2', author: '步履不停', avatar: 'https://i.pravatar.cc/80?img=12', body: '装备清单能发我一份吗？谢谢！', createdAt: '2026-09-02T13:10:00.000Z', status: 'pending', tags: ['资料需求'] }
  ],
  leads: [], followUps: [],
  members: [
    { id: 'member-1', name: '林澈', role: '运营负责人', avatar: 'https://i.pravatar.cc/80?img=5' },
    { id: 'member-2', name: '许言', role: '销售顾问', avatar: 'https://i.pravatar.cc/80?img=11' },
    { id: 'member-3', name: '周宁', role: '客户顾问', avatar: 'https://i.pravatar.cc/80?img=9' }
  ],
  syncRuns: [],
  templates: ['感谢你的关注，路线和清单已整理好，需要的话我发你。', '这条内容的完整信息已补充在置顶评论，也可以告诉我你的具体需求。']
};
