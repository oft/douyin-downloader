export interface LibraryLocation {
    root: string;
    database: string;
    config: string;
}

export interface SharedAuthor {
    id: string;
    uid: string;
    secUid: string;
    name: string;
    aliases: string[];
}

export interface SharedLink {
    url: string;
    authorId: string | null;
    status: 'associated' | 'unresolved';
    enabled: boolean;
}

export type FileRole = 'video' | 'image' | 'music' | 'cover' | 'avatar' | 'metadata';
export interface SharedFile {
    id: string;
    workId: string;
    role: FileRole;
    index: number;
    name: string;
    size: number;
    sha256: string;
    mime: string;
}

export interface SharedWork {
    id: string;
    authorId: string | null;
    type: 'video' | 'gallery';
    title: string;
    createTime: number | null;
    imageCount: number;
    files: string[];
}

export interface ShareManifest {
    version: 1;
    instanceId: string;
    snapshotId: string;
    createdAt: string;
    authors: SharedAuthor[];
    links: SharedLink[];
    works: SharedWork[];
    files: SharedFile[];
    unassignedFiles: number;
    unassigned?: { path: string; size: number }[];
}

export interface IndexedFile extends SharedFile {
    relativePath: string;
    stamp: string;
}

export interface IndexedLibrary {
    manifest: ShareManifest;
    files: IndexedFile[];
}

export interface TransferSelection {
    authorIds?: string[];
    workIds?: string[];
    includeHistory?: boolean;
}

export interface RemoteSource { address: string; code: string }
export interface ImportOptions { includeLinks?: boolean }

export interface ImportAction {
    fileId: string;
    workId: string;
    target: string;
    action: 'add' | 'skip' | 'conflict';
    reason?: string;
}

export interface ImportCounts {
    newAuthors: number;
    existingAuthors: number;
    newLinks: number;
    existingLinks: number;
    pendingLinks: number;
    newWorks: number;
    existingWorks: number;
    filesToAdd: number;
    filesToSkip: number;
    conflicts: number;
    bytesToTransfer: number;
    unassignedFiles: number;
}

export interface ImportPlan {
    id: string;
    address: string;
    snapshotId: string;
    createdAt: string;
    counts: ImportCounts;
    actions: ImportAction[];
    authorMap: Record<string, string>;
    linkRevision: string;
    manifest: ShareManifest;
    unassignedResolutions?: { path: string; size: number; workId: string; sha256: string }[];
}

export interface TransferProgress {
    stage: string;
    completed: number;
    total: number;
    bytes: number;
    bytesTotal: number;
    current?: string;
    skipped?: number;
    conflicts?: number;
}

export interface TransferStatus {
    state: 'idle' | 'starting' | 'running' | 'ready' | 'stopping' | 'stopped' | 'completed' | 'failed';
    startedAt?: string;
    finishedAt?: string;
    error?: string;
    progress?: TransferProgress;
    addresses?: string[];
    code?: string;
    snapshotId?: string;
    expiresAt?: string;
    counts?: { authors: number; links: number; works: number; files: number; bytes: number; unassignedFiles: number };
    unassigned?: { path: string; size: number }[];
    preview?: { id: string; counts: ImportCounts; conflicts: { workId: string; name: string; reason: string }[]; unassigned?: { path: string; size: number }[] };
    result?: { authors: number; links: number; works: number; files: number; skipped: number; conflicts: number; bytes: number };
}

export type ProgressReporter = (progress: TransferProgress) => void;
