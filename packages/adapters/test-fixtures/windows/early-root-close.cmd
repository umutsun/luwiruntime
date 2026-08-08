@echo off
start "" /b "__NODE_EXE__" -e "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({rootPid:process.ppid,descendantPid:process.pid}));setInterval(()=>{},1000)" "__EVIDENCE_PATH__" >nul 2>nul
"__NODE_EXE__" -e "const fs=require('node:fs');const p=process.argv[1];const s=Date.now();const t=setInterval(()=>{if(fs.existsSync(p)||Date.now()-s>=9000){clearInterval(t)}},10)" "__ROOT_RELEASE_PATH__"
exit /b 0
