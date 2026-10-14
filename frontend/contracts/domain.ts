export type SyncState = 'connected' | 'attention' | 'offline';
export type CommentStatus = 'pending' | 'processed' | 'ignored' | 'lead_created';
export type LeadStatus = 'new' | 'following' | 'won' | 'closed';
export type LeadLevel = 'high' | 'medium' | 'low';

export interface Account {
  id: string;
  name: string;
  handle: string;
  avatar: string;
  profile: string;
  state: SyncState;
  followers: number;
  lastSyncedAt: string;
  executionDevice?: {id:string;name:string;online:boolean} | null;
}

export interface NoteMetrics { likes: number | null; collects: number | null; comments: number | null; shares: number | null; }
export interface MediaAsset { id:string; kind:'image'|'video'|'cover'; index:number; sourceUrl:string; path:string; bytes:number; sha256:string; }
export interface Note { mediaAssets?: MediaAsset[]; id: string; accountId: string; title: string; summary: string | null; cover: string | null; url: string | null; publishedAt: string; metrics: NoteMetrics; mediaType?: 'image' | 'video'; images?: string[]; videoUrl?: string | null; }
export interface DirectMessage { id: string; accountId: string; conversationId: string; author: string; body: string; createdAt: string; direction: 'incoming' | 'outgoing'; }
export interface Comment { id: string; accountId: string; noteId: string; author: string; avatar: string; body: string; createdAt: string; status: CommentStatus; tags: string[]; direction?: 'incoming'|'outgoing'|null; }
export interface Lead { id: string; accountId: string; sourceKind?: 'comment'|'direct'; sourceNoteId: string|null; sourceCommentId: string; status: LeadStatus; level: LeadLevel; ownerId?: string; createdAt: string; }
export interface FollowUp { id: string; leadId: string; body: string; createdAt: string; author: string; }
export interface Member { id: string; name: string; role: string; avatar: string; }
export interface SyncRun { id: string; accountId: string; status: 'success' | 'failed'; message: string; createdAt: string; count?: number; }
export interface Database { accounts: Account[]; notes: Note[]; comments: Comment[]; messages?: DirectMessage[]; leads: Lead[]; followUps: FollowUp[]; members: Member[]; syncRuns: SyncRun[]; templates: string[]; }
