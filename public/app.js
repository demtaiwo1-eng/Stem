const form=document.querySelector("#upload-form");
const fileInput=document.querySelector("#audio-file");
const selected=document.querySelector("#selected-file");
const button=document.querySelector("#submit-btn");
const jobPanel=document.querySelector("#job");
const drop=document.querySelector("#dropzone");
let pollHandle=null;
fileInput.addEventListener("change",()=>showFile(fileInput.files[0]));
function showFile(file){if(!file)return;selected.hidden=false;selected.textContent=file.name+" · "+(file.size/1024/1024).toFixed(1)+" MB";}
["dragenter","dragover"].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.add("drag");}));
["dragleave","drop"].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.remove("drag");}));
drop.addEventListener("drop",ev=>{const f=ev.dataTransfer.files[0];if(f){fileInput.files=ev.dataTransfer.files;showFile(f);}});
form.addEventListener("submit",async ev=>{
 ev.preventDefault();const file=fileInput.files[0];if(!file){alert("Choose an audio file first.");return;}
 button.disabled=true;button.textContent="Uploading audio…";jobPanel.hidden=false;document.querySelector("#download-link").hidden=true;
 document.querySelector("#job-title").textContent="Preparing your stems";document.querySelector("#job-state").textContent="UPLOADING";setProgress(3);setMessage("Uploading "+file.name+"…");
 try{const body=new FormData();body.append("audio",file);const r=await fetch("/api/jobs",{method:"POST",body});const data=await r.json();if(!r.ok)throw new Error(data.error||"Upload failed.");setMessage("Upload complete. The separation model is starting…");poll(data.id);}
 catch(err){setMessage(err.message);document.querySelector("#job-state").textContent="ERROR";button.disabled=false;button.textContent="Try again →";}
});
function poll(id){if(pollHandle)clearInterval(pollHandle);const check=async()=>{try{const r=await fetch("/api/jobs/"+id);const d=await r.json();if(!r.ok)throw new Error(d.error||"Could not read job status.");setProgress(d.progress||5);setMessage(d.message||d.status);document.querySelector("#job-state").textContent=d.status.toUpperCase();document.querySelector("#job-title").textContent=d.status==="completed"?"Your stem pack is ready":d.status==="failed"?"Processing needs attention":"Separating your audio";if(d.status==="completed"){clearInterval(pollHandle);const link=document.querySelector("#download-link");link.href=d.downloadUrl;link.hidden=false;button.disabled=false;button.innerHTML='Separate another song <span>→</span>';}else if(d.status==="failed"){clearInterval(pollHandle);button.disabled=false;button.innerHTML='Try another upload <span>→</span>';}}catch(err){clearInterval(pollHandle);setMessage(err.message);button.disabled=false;}};check();pollHandle=setInterval(check,2500);}
function setProgress(n){document.querySelector("#progress-bar").style.width=Math.max(2,Math.min(100,n))+"%";}
function setMessage(s){document.querySelector("#job-message").textContent=s;}
