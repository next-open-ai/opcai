import { ref } from 'vue';
import { archiveWorkspaceArtifact, linkArchivedAssets, listArchivedAssets, type AssetPayload, unlinkArchivedAssets } from '../services/api.js';

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
    loading.value = true;
    try {
      const next = window.opcaiDesktop
        ? await window.opcaiDesktop.listAssets()
        : await listArchivedAssets();
      assets.value = next.map((asset) => ({
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
    const asset = (window.opcaiDesktop
      ? await window.opcaiDesktop.archiveArtifact(input)
      : await archiveWorkspaceArtifact(input as Parameters<typeof archiveWorkspaceArtifact>[0])) as AssetPayload;
    if (!assets.value.some((item) => item.id === asset.id)) assets.value = [asset, ...assets.value];
    return asset as Asset;
  };
  const linkAssetsToProject = async (input: { projectId: string; assetIds: string[]; workspacePath?: string }) => {
    const result = window.opcaiDesktop
      ? await window.opcaiDesktop.linkAssetsToProject(input)
      : await linkArchivedAssets(input);
    await loadAssets();
    return result;
  };
  const unlinkAssetsFromProject = async (assetIds: string[]) => {
    const result = window.opcaiDesktop
      ? await window.opcaiDesktop.unlinkAssetsFromProject(assetIds)
      : await unlinkArchivedAssets(assetIds);
    await loadAssets();
    return result;
  };
  return { assets, loading, loadAssets, archiveArtifact, linkAssetsToProject, unlinkAssetsFromProject };
}
