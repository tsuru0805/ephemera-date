// The bytes of photos placed in a backfill draft, kept in IndexedDB (key = the photo's clientId), so a draft restored
// after a reload still has its photos. Object URLs die with the page; these bytes do not.
// Without IndexedDB (or when a read fails) the functions answer null / do nothing: the page then asks for the photo again.
const DB = "ephemera", STORE = "draftPhotos";

function idb(): IDBFactory | null {
  try { return typeof indexedDB !== "undefined" && indexedDB ? indexedDB : null; } catch { return null; }
}

let opening: Promise<IDBDatabase | null> | null = null;
function open(): Promise<IDBDatabase | null> {
  const f = idb();
  if (!f) return Promise.resolve(null);
  opening ??= new Promise((resolve) => {
    try {
      const r = f.open(DB, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return opening.then((db) => { if (!db) opening = null; return db; });
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return open().then((db) => new Promise<T | null>((resolve) => {
    if (!db) { resolve(null); return; }
    try {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch { resolve(null); }
  }));
}

// stored as {type, data: ArrayBuffer}: plain bytes clone everywhere (some browsers' IndexedDB had trouble with Blobs)
type Rec = { type: string; data: ArrayBuffer };

/** Keep the bytes of one draft photo. Resolves true when stored. */
export async function putDraftPhoto(clientId: string, blob: Blob): Promise<boolean> {
  let data: ArrayBuffer;
  try { data = await blob.arrayBuffer(); } catch { return false; }
  const rec: Rec = { type: blob.type || "image/jpeg", data };
  return (await run("readwrite", (s) => s.put(rec, clientId))) !== null;
}
/** The bytes of one draft photo, or null (not stored / storage unavailable / read failed). */
export async function getDraftPhoto(clientId: string): Promise<Blob | null> {
  const r = await run<unknown>("readonly", (s) => s.get(clientId));
  const rec = r as Partial<Rec> | null;
  if (!rec || typeof rec.type !== "string" || !rec.data || typeof (rec.data as ArrayBuffer).byteLength !== "number") return null;
  return new Blob([rec.data as ArrayBuffer], { type: rec.type });
}
export async function deleteDraftPhotos(clientIds: string[]): Promise<void> {
  for (const id of clientIds) await run("readwrite", (s) => s.delete(id));
}
/** Drop everything (the draft is used up). */
export async function clearDraftPhotos(): Promise<void> {
  await run("readwrite", (s) => s.clear());
}
