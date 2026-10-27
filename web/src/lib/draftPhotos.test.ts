// The draft photo store (IndexedDB): round trip with fake-indexeddb, and no IndexedDB at all.
describe("IndexedDB store", () => {
  it("put / get / delete / clear round trip (fake-indexeddb)", async () => {
    require("fake-indexeddb/auto");
    const m = require("./draftPhotos");
    expect(await m.putDraftPhoto("c1", blob("one"))).toBe(true);
    const got = await m.getDraftPhoto("c1");
    expect(got?.type).toBe("image/jpeg");
    expect(await got.text()).toBe("one");
    await m.deleteDraftPhotos(["c1"]);
    expect(await m.getDraftPhoto("c1")).toBeNull();
    await m.putDraftPhoto("c2", blob());
    await m.clearDraftPhotos();
    expect(await m.getDraftPhoto("c2")).toBeNull();
  });
  it("no IndexedDB: answers null / false, never throws", async () => {
    const saved = (globalThis as { indexedDB?: unknown }).indexedDB;
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    let m!: typeof import("./draftPhotos");
    jest.isolateModules(() => { m = require("./draftPhotos"); });
    expect(await m.putDraftPhoto("c1", blob())).toBe(false);
    expect(await m.getDraftPhoto("c1")).toBeNull();
    (globalThis as { indexedDB?: unknown }).indexedDB = saved;
  });
});


const blob = (s = "x") => new Blob([s], { type: "image/jpeg" });
