'use strict';
// Build identity is checked against the original pinned vendor source. This
// guard does not create a renderer or grant resource/hardware qualification.
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const result=spawnSync(process.execPath,['tools/build-stanza-pixi.mjs','--check'],{cwd:path.resolve(__dirname,'..'),encoding:'utf8'});
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
if(result.error)throw result.error;
process.exitCode=result.status===0?0:1;
