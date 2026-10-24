// Drive is the only persistent backend. Browser OAuth access token is never stored.
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
function httpError(message,status){return Object.assign(Error(message),{status});}
export async function driveRequest(token, path, options={}) {
  const {headers={},...other}=options;
  const res=await fetch(API+path,{...other,headers:{Authorization:"Bearer "+token,...headers}});
  if (!res.ok) {
    let msg;
    try { const body=await res.json();msg=body.error?.message || res.statusText; }
    catch { msg=res.statusText; }
    throw httpError("Google Drive ("+res.status+"): "+msg,res.status);
  }
  if (res.status===204) return {};
  return res.json();
}
export async function driveDownload(token, id, options={}) {
  const res=await fetch(API+"/files/"+encodeURIComponent(id)+"?alt=media",
    {signal:options.signal,headers:{Authorization:"Bearer "+token}});
  if(!res.ok) throw httpError("Ошибка скачивания из Drive: HTTP "+res.status,res.status);
  return res.arrayBuffer();
}
export async function readEnvelope(token,id) {
  const data=await driveDownload(token,id);
  return JSON.parse(new TextDecoder().decode(data));
}
export async function createFolder(token,name,parentId,options={}) {
  return driveRequest(token,"/files?fields=id,name,webViewLink",{
    method:"POST",signal:options.signal,headers:{"Content-Type":"application/json"},
    body:JSON.stringify({name,mimeType:"application/vnd.google-apps.folder",
      parents:parentId?[parentId]:undefined})
  });
}
export async function folderExists(token,id,options={}) {
  if(!id) return false;
  try {
    const folder=await driveRequest(token,"/files/"+encodeURIComponent(id)+"?fields=id,mimeType,capabilities(canAddChildren)",{signal:options.signal});
    return folder.mimeType==="application/vnd.google-apps.folder"&&folder.capabilities?.canAddChildren===true;
  }
  catch(error) { if(error.status===404)return false;throw error; }
}
export async function uploadSmall(token,name,blob,parentId,options={}) {
  // The ciphertext chunk is 4 MiB + 16 bytes: safely below multipart 5 MB guidance.
  const boundary="media_vault_"+crypto.randomUUID().replaceAll("-","");
  const metadata={name,mimeType:"application/octet-stream",parents:[parentId]};
  const body=new Blob(["--"+boundary+"\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n",
    JSON.stringify(metadata),"\r\n--"+boundary+"\r\nContent-Type: application/octet-stream\r\n\r\n",
    blob,"\r\n--"+boundary+"--"]);
  const res=await fetch(UPLOAD+"/files?uploadType=multipart&fields=id,name",{
    method:"POST",signal:options.signal,headers:{Authorization:"Bearer "+token,
      "Content-Type":"multipart/related; boundary="+boundary},body});
  if(!res.ok) throw httpError("Ошибка загрузки в Drive: HTTP "+res.status+" "+(await res.text()).slice(0,200),res.status);
  return res.json();
}
export async function replaceSmall(token,id,blob,options={}) {
  const res=await fetch(UPLOAD+"/files/"+encodeURIComponent(id)+"?uploadType=media",{
    method:"PATCH",signal:options.signal,headers:{Authorization:"Bearer "+token,"Content-Type":"application/octet-stream"},body:blob});
  if(!res.ok) throw httpError("Не удалось сохранить каталог: HTTP "+res.status,res.status);
}
export async function inviteReader(token,folderId,email) {
  return driveRequest(token,"/files/"+encodeURIComponent(folderId)+"/permissions?sendNotificationEmail=true",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({type:"user",role:"reader",emailAddress:email})
  });
}
export async function trashFolder(token,folderId) {
  return driveRequest(token,"/files/"+encodeURIComponent(folderId)+"?fields=id,trashed",{
    method:"PATCH",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({trashed:true})
  });
}
