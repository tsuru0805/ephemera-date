// The bytes behind the object URLs the photo picker hands to the pages (uploads read the Blob, <img> the URL).
const blobs = new Map<string, Blob>();
export function rememberBlob(uri: string, b: Blob) { blobs.set(uri, b); }
export const blobOf = (uri: string): Blob | null => blobs.get(uri) ?? null;
