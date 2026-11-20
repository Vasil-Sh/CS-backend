// Minimal typing for the part of adm-zip we use (unpacking the team-logo packs).
declare module 'adm-zip' {
  export default class AdmZip {
    constructor(path?: string);
    extractAllTo(targetPath: string, overwrite?: boolean): void;
  }
}
