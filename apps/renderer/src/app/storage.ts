export async function readStored(key: string): Promise<string | null> {
  if (window.opcaiDesktop) return window.opcaiDesktop.storageGet(key);
  return window.localStorage.getItem(key);
}

export async function writeStored(key: string, value: string): Promise<void> {
  if (window.opcaiDesktop) return window.opcaiDesktop.storageSet(key, value);
  window.localStorage.setItem(key, value);
}
