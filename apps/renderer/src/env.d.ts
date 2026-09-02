/// <reference types="vite/client" />

interface Window {
  opcaiDesktop?: {
    pickSkill(): Promise<{ path: string; content: string } | null>;
    pickProjectDirectory(): Promise<string | null>;
    createProjectWorkspace(value: { name: string; parentDirectory?: string }): Promise<string>;
    listProjectFiles(root: string): Promise<Array<{ relative: string; type: 'directory' | 'file' }>>;
    readProjectFile(root: string, relative: string): Promise<{ relative: string; content: string }>;
    writeProjectFile(root: string, relative: string, content: string): Promise<{ relative: string; content: string }>;
    syncProjectWorkspace(root: string, runId: string): Promise<Array<{ relative: string; type: 'directory' | 'file' }>>;
    materializeProjectAssets(root: string, assetIds: string[]): Promise<Array<{ relative: string; type: 'directory' | 'file' }>>;
    createSkill(skill: { name: string; description: string }): Promise<{ path: string; content: string }>;
    writeSkillDraft(draft: { name: string; content: string }): Promise<{ path: string; content: string }>;
    readSkillDraft(path: string): Promise<{ path: string; content: string }>;
    listSkillFiles(path: string): Promise<Array<{ path: string; relative: string; type: 'directory' | 'file' }>>;
    readSkillFile(path: string): Promise<{ path: string; content: string }>;
    writeSkillFile(path: string, content: string): Promise<{ path: string; content: string }>;
    deleteManagedSkill(path: string): Promise<boolean>;
    installSkill(reference: string): Promise<{ output: string; manifest: { path: string; content: string } | null }>;
    importGitSkill(url: string): Promise<{ manifests: Array<{ path: string; content: string }>; skipped: string[] }>;
    findSkills(query: string, batchCount?: number): Promise<{ items: Array<{ reference: string; source: string; slug: string; name: string; description: string; installs: string; url: string }>; hasMore: boolean }>;
    getModelConfig(): Promise<unknown>;
    saveModelConfig(config: unknown): Promise<unknown>;
    listOllamaModels(baseUrl?: string): Promise<string[]>;
    pullOllamaModel(baseUrl: string | undefined, modelName: string): Promise<string>;
    storageGet(key: string): Promise<string | null>;
    storageSet(key: string, value: string): Promise<void>;
    listAssets(): Promise<Array<{ id: string; name: string; relativePath: string; mimeType: string; sizeBytes: number; createdAt: number; conversationId: string | null; employeeId: string | null; runId: string; sha256: string }>>;
    archiveArtifact(input: { runId: string; relativePath: string; conversationId?: string; employeeId?: string }): Promise<{ id: string; name: string; relativePath: string; mimeType: string; sizeBytes: number; createdAt: number; conversationId: string | null; employeeId: string | null; runId: string; sha256: string }>;
    saveAsset(assetId: string): Promise<boolean>;
    revealAsset(assetId: string): Promise<void>;
  };
}
