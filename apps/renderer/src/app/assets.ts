import { ref } from 'vue';

export interface Asset {
  id: string;
  name: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  conversationId: string | null;
  employeeId: string | null;
  runId: string;
  sha256: string;
  projectId: string | null;
  workspaceRelative: string | null;
}

const assets = ref<Asset[]>([]);
const loading = ref(false);

export function useAssets() {
  const loadAssets = async () => {
    if (!window.opcaiDesktop) return;
    loading.value = true;
    try {
      assets.value = (await window.opcaiDesktop.listAssets()).map((asset) => ({
        ...asset,
        projectId: asset.projectId ?? null,
        workspaceRelative: asset.workspaceRelative ?? asset.name ?? null,
      })) as Asset[];
    } finally {
      loading.value = false;
    }
  };
  const archiveArtifact = async (input: {
    runId: string;
    relativePath: string;
    conversationId?: string;
    employeeId?: string;
    projectId?: string;
  }) => {
    if (!window.opcaiDesktop) throw new Error('资产归档仅在 OPCAI 桌面应用中可用。');
    const asset = (await window.opcaiDesktop.archiveArtifact(input)) as Asset;
    if (!assets.value.some((item) => item.id === asset.id)) assets.value = [asset, ...assets.value];
    return asset;
  };
  const linkAssetsToProject = async (input: { projectId: string; assetIds: string[]; workspacePath?: string }) => {
    if (!window.opcaiDesktop) throw new Error('关联项目仅在 OPCAI 桌面应用中可用。');
    const result = await window.opcaiDesktop.linkAssetsToProject(input);
    await loadAssets();
    return result;
  };
  const unlinkAssetsFromProject = async (assetIds: string[]) => {
    if (!window.opcaiDesktop) throw new Error('取消关联仅在 OPCAI 桌面应用中可用。');
    const result = await window.opcaiDesktop.unlinkAssetsFromProject(assetIds);
    await loadAssets();
    return result;
  };
  return { assets, loading, loadAssets, archiveArtifact, linkAssetsToProject, unlinkAssetsFromProject };
}
