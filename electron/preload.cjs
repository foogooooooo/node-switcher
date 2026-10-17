const { contextBridge, ipcRenderer } = require('electron');

const invoke = async (name, ...args) => {
  const response = await ipcRenderer.invoke(`routing:${name}`, ...args);
  if (!response.ok) {
    const error = new Error(response.message); error.code = response.code; throw error;
  }
  return response.value;
};

contextBridge.exposeInMainWorld('routing', Object.freeze({
  bootstrap: () => invoke('bootstrap'),
  connect: (id) => invoke('connect', id),
  chooseConfig: () => invoke('choose-config'),
  chooseVerge: () => invoke('choose-verge'),
  chooseBinary: () => invoke('choose-binary'),
  refresh: () => invoke('refresh'),
  preview: (entries) => invoke('preview', entries),
  apply: (id) => invoke('apply', id),
  history: () => invoke('history'),
  restore: (id) => invoke('restore', id),
  showBackups: () => invoke('show-backups'),
}));
