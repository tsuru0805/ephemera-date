/**
 * 他偶尔把换行写成字面的反斜杠 n(两个字符),引擎早先原样存了。
 *  引擎已在写入口转真换行;这里把读到的所有文字再转一遍,旧数据也正常换行。约会里没有哪一处要字面反斜杠 n。 */
export function realNewlines<T>(v: T): T {
  if (typeof v === "string") return (v.includes("\\n") ? v.replace(/\\r\\n|\\n/g, "\n") : v) as T;
  if (Array.isArray(v)) return v.map(realNewlines) as T;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = realNewlines(x);
    return o as T;
  }
  return v;
}
