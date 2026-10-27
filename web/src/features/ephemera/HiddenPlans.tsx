// 首页 Hidden Plans(原型 hiddenRow:一只封好的信封 + 一包绳子捆的纸包;方案 A 换成真内容):
// 左=信封,装没读的电报与信(点开=电报列表;标题旁原来那行 TELEGRAMS 收进这里),有没读的挂一张小吊牌写几封;
// 右=纸包,装下一次约会的准备清单还差几样(点开=清单打勾);勾满=绳结上压一枚火漆,封好。没有要准备的就不摆纸包。
import { Image, Pressable, Text, View } from "react-native";
import type { HerState, Plan } from "../../lib/ephemeraApi";
import { Art, Caps, FitLine, Paper, SEAL_BOW } from "./components";
import { prepLeft, titleLines } from "./format";
import { ClosedEnvelope, ENVELOPE } from "./SealScreen";
import { FF, type Skin } from "./theme";

const BW = 168, BH = 124;
const TWINE = ["#B08A6A", "#D2B08E"];

export function HiddenPlans({ P, top, plan, her, unread, onTelegrams, onPrep }: {
  P: Skin; top: number; plan: Plan | null; her: HerState | null; unread: number; onTelegrams: () => void; onPrep: () => void;
}) {
  const prep = plan ? prepLeft(plan.prep, her) : { total: 0, left: 0 };
  const sc = BH / ENVELOPE.h, ew = ENVELOPE.w * sc;
  const y = top + 42;
  const [t1, t2] = plan ? titleLines(plan) : ["", ""]; // 没有下一次约会:信封上不写名字(不说「You're invited」骗她)
  return (
    <>
      <Text style={{ position: "absolute", left: 22, top, fontFamily: FF.pf7, fontSize: 20, color: P.deep }}>Hidden Plans</Text>
      <View style={{ position: "absolute", left: 158, top: top + 14, width: 40, height: 1, backgroundColor: P.deep }} />

      <Pressable onPress={onTelegrams} style={{ position: "absolute", left: 20, top: y, width: BW, height: BH }} accessibilityLabel={unread ? `电报 ${unread} 封没读` : "电报"}>
        <View style={{ position: "absolute", left: (BW - ew) / 2, top: 0, width: ENVELOPE.w, height: ENVELOPE.h, transform: [{ scale: sc }], transformOrigin: "top left" }}>
          <ClosedEnvelope plan={plan} bare />
        </View>
        <View style={{ position: "absolute", left: 18 * sc, right: 18 * sc, top: ENVELOPE.tip * 0.3 * sc }} pointerEvents="none">
          <FitLine style={{ textAlign: "center", fontFamily: FF.script, paddingRight: 3, fontSize: 42 * sc, lineHeight: 37 * sc, color: P.deep }}>{t1}</FitLine>
          {t2 ? <FitLine style={{ textAlign: "center", fontFamily: FF.script, paddingRight: 3, fontSize: 50 * sc, lineHeight: 37 * sc, color: P.deep }}>{`  ${t2}`}</FitLine> : null}
        </View>
        {unread ? (
          // 小吊牌:同拆信封页挂在信封边上的那张日期牌,这里写几封没读
          <View style={{ position: "absolute", left: (BW + ew) / 2 - 12, top: 46, width: 34, transform: [{ rotate: "6deg" }], transformOrigin: "17px -14px" }} pointerEvents="none">
            <View style={{ position: "absolute", left: 16.5, top: -16, width: 1, height: 17, backgroundColor: P.deep }} />
            <Paper w={34} h={44} d="M6.1 0 L27.9 0 L34 7.9 L34 44 L0 44 L0 7.9 Z" fill={P.tag} sh={P.sh} shadow="paper" texture={0.4} />
            <View style={{ position: "absolute", left: 0, right: 0, top: 9, alignItems: "center" }}>
              <Text style={{ fontFamily: FF.pf9, fontSize: 16, lineHeight: 18, color: P.tagT }}>{String(Math.min(unread, 99)).padStart(2, "0")}</Text>
              <Caps color={P.tagT} size={5.5} ls={0.2}>New</Caps>
            </View>
          </View>
        ) : null}
      </Pressable>

      {prep.total ? (
        <Pressable onPress={onPrep} style={{ position: "absolute", left: 200, top: y, width: BW, height: BH, backgroundColor: P.pack,
          shadowColor: `rgb(${P.sh})`, shadowOpacity: 0.22, shadowRadius: 7, shadowOffset: { width: 0, height: 10 } }}
          accessibilityLabel={prep.left ? `准备清单 还差 ${prep.left} 样` : "准备清单 都准备好了"}>
          <Art name="florals" color={P.ink} style={{ left: 6, top: 6, width: 110, height: 110, opacity: 0.28 }} />
          <View style={{ position: "absolute", left: 0, right: 0, top: 56, height: 2, flexDirection: "row", overflow: "hidden" }} pointerEvents="none">
            {Array.from({ length: Math.ceil(BW / 3) }, (_, k) => <View key={k} style={{ width: 3, height: 2, backgroundColor: TWINE[k % 2] }} />)}
          </View>
          <View style={{ position: "absolute", left: 104, top: 0, bottom: 0, width: 2, overflow: "hidden" }} pointerEvents="none">
            {Array.from({ length: Math.ceil(BH / 3) }, (_, k) => <View key={k} style={{ width: 2, height: 3, backgroundColor: TWINE[(k + 1) % 2] }} />)}
          </View>
          <View style={{ position: "absolute", left: 76, top: 62, width: 80, transform: [{ rotate: "-16deg" }] }} pointerEvents="none">
            <Paper w={80} h={42} d="M11 0 L80 0 L80 42 L11 42 L0 21 Z" fill={P.paper} sh={P.sh} shadow="paper" texture={0.4} />
            <Text numberOfLines={3} style={{ position: "absolute", left: 10, right: 2, top: 7, textAlign: "center", fontFamily: FF.pf7, fontSize: 5.6, lineHeight: 9.4, letterSpacing: 0.6, color: P.deep }}>{"SOME\nBEAUTIFUL THINGS\nTAKE TIME"}</Text>
          </View>
          {prep.left ? (
            <View style={{ position: "absolute", right: 10, top: 8, alignItems: "flex-end" }} pointerEvents="none">
              <Text style={{ fontFamily: FF.pf9, fontSize: 18, lineHeight: 20, color: P.deep }}>{String(prep.left).padStart(2, "0")}</Text>
              <Text style={{ fontFamily: FF.pf7, fontSize: 6.5, lineHeight: 9.75, letterSpacing: 0.9, color: P.deep, textAlign: "right" }}>{"PLANS\nIN PROGRESS"}</Text>
            </View>
          ) : (
            <>
              <Image source={SEAL_BOW} style={{ position: "absolute", left: 105 - 17, top: 57 - 17, width: 34, height: 34 }} resizeMode="contain" />
              <Text style={{ position: "absolute", right: 10, top: 10, fontFamily: FF.pf7, fontSize: 6.5, lineHeight: 9.75, letterSpacing: 0.9, color: P.deep, textAlign: "right" }} pointerEvents="none">{"ALL\nPACKED"}</Text>
            </>
          )}
        </Pressable>
      ) : null}
    </>
  );
}
