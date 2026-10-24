// CryptoKey never leaves memory. Each independently authenticated chunk uses a fresh IV.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const CHUNK_SIZE = 4 * 1024 * 1024;
export function bytesToBase64(buf) {
  const u = new Uint8Array(buf);
  let str = "";
  for (let i = 0; i < u.length; i += 32768) str += String.fromCharCode(...u.subarray(i, i + 32768));
  return btoa(str);
}
export function base64ToBytes(s) {
  const raw = atob(s);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
export function newSalt() { return crypto.getRandomValues(new Uint8Array(16)); }
export async function deriveVaultKey(passphrase, salt) {
  const material=await deriveVaultMaterial(passphrase,salt);
  material.serverKey.fill(0);
  return material.key;
}
export async function deriveVaultMaterial(passphrase, salt) {
  if (!passphrase || passphrase.length < 12) throw Error("Секретная фраза должна содержать не менее 12 символов.");
  const raw = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const serverKey=new Uint8Array(await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations:310000,hash:"SHA-256"},raw,256));
  const key=await crypto.subtle.importKey("raw",serverKey,{name:"AES-GCM"},false,["encrypt","decrypt"]);
  return {key,serverKey};
}
export async function sealChunk(raw, key, id, index) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {name:"AES-GCM",iv,additionalData:encoder.encode(id + ":" + index)},key,raw);
  return {ciphertext,iv:bytesToBase64(iv)};
}
export async function openChunk(ciphertext, key, id, index, iv) {
  return crypto.subtle.decrypt({name:"AES-GCM",iv:base64ToBytes(iv),
    additionalData:encoder.encode(id + ":" + index)},key,ciphertext);
}
export async function sealIndex(catalog, key, salt) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({name:"AES-GCM",iv,
    additionalData:encoder.encode("mediavault-catalog-v1")},key,
    encoder.encode(JSON.stringify(catalog)));
  return {version:1,kdf:"PBKDF2-SHA256-310000",salt:bytesToBase64(salt),iv:bytesToBase64(iv),
    data:bytesToBase64(ciphertext)};
}
export async function openIndex(envelope, key) {
  if (envelope.version !== 1 || envelope.kdf !== "PBKDF2-SHA256-310000")
    throw Error("Неизвестный формат каталога.");
  const plain = await crypto.subtle.decrypt({name:"AES-GCM",iv:base64ToBytes(envelope.iv),
    additionalData:encoder.encode("mediavault-catalog-v1")},key,base64ToBytes(envelope.data));
  const catalog = JSON.parse(decoder.decode(plain));
  if (!Array.isArray(catalog.items) || !catalog.folderId) throw Error("Повреждённый каталог.");
  return catalog;
}
export function guessCategory(file) {
  const x = file.name.toLowerCase();
  const ext = x.split(".").pop();
  if (["mp4","webm","m4v","mov","mkv"].includes(ext)) return "video";
  if (["mp3","m4a","aac","ogg","opus","flac","wav"].includes(ext)) return "audio";
  if (["cbz","zip"].includes(ext)) return "manga";
  if (["pdf","epub","txt"].includes(ext)) return "book";
  if (["jpg","jpeg","png","webp","gif","avif","bmp"].includes(ext)) return "image";
  throw Error("Неподдерживаемый формат: ." + ext);
}
export function mimeFor(file,category) {
  if (file.type) return file.type;
  const ext = file.name.toLowerCase().split(".").pop();
  const map={mp4:"video/mp4",m4v:"video/mp4",webm:"video/webm",mp3:"audio/mpeg",
    m4a:"audio/mp4",ogg:"audio/ogg",opus:"audio/ogg",wav:"audio/wav",
    pdf:"application/pdf",epub:"application/epub+zip",txt:"text/plain",
    jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",webp:"image/webp",gif:"image/gif",
    avif:"image/avif",cbz:"application/vnd.comicbook+zip"};
  return map[ext] || "application/octet-stream";
}
