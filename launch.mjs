/** Production entrypoint: initialize only the trusted volume directory, drop privilege, then import HTTP code. */
import { openSync, closeSync, fchmodSync, fchownSync, mkdirSync, constants, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
export function prepareVolume(directory) {
  if (!directory || resolve(directory) !== directory || !directory.startsWith('/data/') || directory.split('/').some(p=>p==='..')) throw new Error('Privilege-drop DATA_DIR must be an absolute directory below /data');
  const pieces = directory.split('/').filter(Boolean); let path = '';
  for (let i=0;i<pieces.length;i++) {
    path += '/' + pieces[i];
    try { mkdirSync(path,{mode:i===0?0o711:0o700}); } catch(e) { if(e.code!=='EEXIST')throw e; }
    if(lstatSync(path).isSymbolicLink())throw new Error('Volume symlinks refused');
    const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try { if(i===0)fchmodSync(fd,0o711); else if(i===pieces.length-1) { fchownSync(fd,1000,1000);fchmodSync(fd,0o700); } } finally {closeSync(fd);}
  }
}
if(process.getuid?.()===0) {
  if(process.env.DROP_PRIVILEGES!=='1')throw new Error('Production HTTP refuses root; configure DROP_PRIVILEGES=1 with DATA_DIR below /data');
  prepareVolume(process.env.DATA_DIR); process.setgroups([]);process.setgid(1000);process.setuid(1000);
  if(process.getuid()!==1000||process.getgid()!==1000||process.getgroups().some(g=>g!==1000))throw new Error('Privilege drop failed');
}
if(process.env.DROP_PRIVILEGES==='1'&&process.getuid()!==1000)throw new Error('Unexpected production UID');
const {main}=await import('./server.mjs');await main();
