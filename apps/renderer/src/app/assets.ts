import { ref } from 'vue';

export interface Asset {
  id: string; name: string; relativePath: string; mimeType: string; sizeBytes: number; createdAt: number;
  conversationId: string | null; employeeId: string | null; runId: string; sha256: string;
}

const assets = ref<Asset[]>([]);
const loading = ref(false);

export function useAssets() {
  const loadAssets = async () => {
    if (!window.opcaiDesktop) return;
    loading.value = true;
    try { assets.value = await window.opcaiDesktop.listAssets() as Asset[]; } finally { loading.value = false; }
  };
  const archiveArtifact = async (input: { runId: string; relativePath: string; conversationId?: string; employeeId?: string }) => {
    if (!window.opcaiDesktop) throw new Error('资产归档仅在 OPCAI 桌面应用中可用。');
    const asset = await window.opcaiDesktop.archiveArtifact(input) as Asset;
    if (!assets.value.some((item) => item.id === asset.id)) assets.value = [asset, ...assets.value];
    return asset;
  };
  return { assets, loading, loadAssets, archiveArtifact };
}
