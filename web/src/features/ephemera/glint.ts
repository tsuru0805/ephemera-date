// 烫金反光:手机倾斜角 → 反光位移(纯函数,UI 线程与 jest 共用)
/** 倾斜角(弧度)→ 反光位移(百分比,±30);没有陀螺仪时用慢晃(±18,原型 sin(t)*18) */
export function glintFrom(available: boolean, roll: number, wobble: number): number {
  "worklet";
  if (available && Number.isFinite(roll) && roll !== 0) {
    const deg = (roll * 180) / Math.PI;
    return Math.max(-30, Math.min(30, deg));
  }
  return Math.sin(wobble) * 18;
}
