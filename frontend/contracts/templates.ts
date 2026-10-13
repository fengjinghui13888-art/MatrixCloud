export const templateCategories=['美食','穿搭','美妆','家居','旅行','数码','宠物','运动','职场','生活方式'] as const;
export type TemplateContent={name:string;category:typeof templateCategories[number];title:string;body:string;images:string[];sourceUrl:string;usage:'reference'|'owned'|'licensed';rightsNote:string};
export type LibraryTemplate=TemplateContent&{id:string;revision:number;updatedAt:string};
export type ManagedTemplate={id:string;revision:number;draft:TemplateContent;published:LibraryTemplate|null;updatedAt:string};
