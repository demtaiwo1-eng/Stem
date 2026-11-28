const form=document.querySelector("#upload-form");
const fileInput=document.querySelector("#audio-file");
const selected=document.querySelector("#selected-file");
const button=document.querySelector("#submit-btn");
const jobPanel=document.querySelector("#job");
const drop=document.querySelector("#dropzone");
const transferPanel=document.querySelector("#upload-progress");
const transferBar=document.querySelector("#upload-progress-bar");
const transferPercent=document.querySelector("#upload-percent");
const transferStage=document.querySelector("#upload-stage");
const localBar=document.querySelector("#local-progress-bar");
const localPercent=document.querySelector("#local-percent");
let pollHandle=null;
fileInput.addEventListener("change",()=>showFile(fileInput.files[0]));
function showFile(file){if(!file)return;selected.hidden=false;selected.textContent=file.name+" · "+(file.size/1024/1024).toFixed(2)+" MB";}
["dragenter","dragover"].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.add("drag");}));
["dragleave","drop"].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.remove("drag");}));
drop.addEventListener("drop",ev=>{const f=ev.dataTransfer.files[0];if(f){fileInput.files=ev.dataTransfer.files;showFile(f);}});
form.addEventListener("submit",ev=>{
 ev.preventDefault();const file=fileInput.files[0];if(!file){alert("Choose an audio file first.");return;}
 button.disabled=true;button.textContent="Uploading audio…";jobPanel.hidden=true;transferPanel.hidden=false;
 document.querySelector("#download-link").hidden=true;
 document.querySelector("#job-title").textContent="Preparing your stems";
 document.querySelector("#job-state").textContent="UPLOADING";
 setTransferProgress(0);
 // The browser keeps the selected attachment as a local File object; no second copy is made.
 localBar.style.width="100%";localPercent.textContent="Ready";transferStage.textContent="File ready on this device";
 const body=new FormData();body.append("audio",file);
 const xhr=new XMLHttpRequest();
 xhr.open("POST","/api/jobs");
 xhr.responseType="json";
 xhr.upload.addEventListener("progress",event=>{
   if(event.lengthComputable){
     const percent=Math.round(event.loaded/event.total*100);
     setTransferProgress(percent);
     transferStage.textContent=percent>=100?"Received by STEM — saving securely on the server…":"Uploading to STEM server…";
   } else transferStage.textContent="Uploading to STEM server…";
 });
 xhr.upload.addEventListener("load",()=>{setTransferProgress(100);transferStage.textContent="Upload sent — waiting for secure server storage…";});
 xhr.addEventListener("load",()=>{
   const data=xhr.response||(()=>{try{return JSON.parse(xhr.responseText)}catch{return {}}})();
   if(xhr.status<200||xhr.status>=300){failUpload(data.error||"Upload failed ("+xhr.status+").");return;}
   transferStage.textContent="Saved securely. Starting audio separation…";
   setTimeout(()=>{transferPanel.hidden=true;jobPanel.hidden=false;setProgress(5);setMessage("Upload complete. The separation model is starting…");poll(data.id);},450);
 });
 xhr.addEventListener("error",()=>failUpload("Network connection interrupted during upload. Please try again."));
 xhr.addEventListener("timeout",()=>failUpload("Upload timed out. Please check your connection and retry."));
 xhr.timeout=10*60*1000;
 xhr.send(body);
});
function failUpload(message){transferStage.textContent=message;document.querySelector("#job-state").textContent="ERROR";button.disabled=false;button.textContent="Try again →";}
function setTransferProgress(n){const value=Math.max(0,Math.min(100,n));transferBar.style.width=value+"%";transferPercent.textContent=value+"%";}
function poll(id){if(pollHandle)clearInterval(pollHandle);const check=async()=>{try{const r=await fetch("/api/jobs/"+id);const d=await r.json();if(!r.ok)throw new Error(d.error||"Could not read job status.");setProgress(d.progress||5);setMessage(d.message||d.status);document.querySelector("#job-state").textContent=d.status.toUpperCase();document.querySelector("#job-title").textContent=d.status==="completed"?"Your stem pack is ready":d.status==="failed"?"Processing needs attention":"Separating your audio";if(d.status==="completed"){clearInterval(pollHandle);const link=document.querySelector("#download-link");link.href=d.downloadUrl;link.hidden=false;button.disabled=false;button.innerHTML='Separate another song <span>→</span>';}else if(d.status==="failed"){clearInterval(pollHandle);button.disabled=false;button.innerHTML='Try another upload <span>→</span>';}}catch(err){clearInterval(pollHandle);setMessage(err.message);button.disabled=false;}};check();pollHandle=setInterval(check,2500);}
function setProgress(n){document.querySelector("#progress-bar").style.width=Math.max(2,Math.min(100,n))+"%";}
function setMessage(s){document.querySelector("#job-message").textContent=s;}
