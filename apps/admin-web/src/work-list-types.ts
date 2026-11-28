export type WorkLayout = 'cards' | 'list';

export type WorkItem = {
    id: string;
    title: string;
    kind: string;
    time?: string;
    cover?: string;
    video?: string;
    authorId?: string;
    authorName?: string;
    sources?: string[];
    images?: string[];
};
