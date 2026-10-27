// 照小样绝对定位排版、又有输入框的页面专用的键盘滚动壳。
//
// 病根:keyboard-controller 的 KeyboardAwareScrollView 靠在内容「末尾」追加一块 paddingBottom = 键盘高 + 1 的
// Reanimated.View 来撑出可滚空间(1.18.5 src/components/KeyboardAwareScrollView/index.tsx ~410 行)。
// 页面若把 contentContainerStyle 的 height 写死、子元素又全是绝对定位,流内没有东西,那块垫子撑不长内容——
// 滚动范围始终是 0,键盘一弹输入框就被盖住。
//
// 做法:先放一个流内占位(高 = height),绝对定位的子元素叠在它上面;键盘垫子自然排在占位后面,
// 内容高 = height + 键盘高,库就能把聚焦的输入框滚到键盘上方。不要再给 contentContainerStyle 写 height
// (守卫测试 keyboardGuard.test 会判红)。
import type React from "react";
import { View, type NativeScrollEvent, type NativeSyntheticEvent, type StyleProp, type ViewStyle } from "react-native";
import { SafeKeyboardAwareScrollView } from "./SafeKeyboardAwareScrollView";

type Props = {
  /** 排版高度(原来写死在 contentContainerStyle 的那个数) */
  height: number;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** 聚焦的输入框底边离键盘顶的距离 */
  bottomOffset?: number;
  keyboardDismissMode?: "none" | "on-drag" | "interactive";
  showsVerticalScrollIndicator?: boolean;
  testID?: string;
  /** 路线页画线要跟着 scrollY 走,原样转发(不接管,库自己的垫子逻辑不受影响) */
  onScroll?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  scrollEventThrottle?: number;
};

export function AbsKeyboardScroll({ height, children, style, bottomOffset = 40, keyboardDismissMode = "on-drag", showsVerticalScrollIndicator = false, testID, onScroll, scrollEventThrottle }: Props) {
  return (
    <SafeKeyboardAwareScrollView probe={testID ?? "AbsKeyboardScroll"} style={[{ flex: 1 }, style]} showsVerticalScrollIndicator={showsVerticalScrollIndicator}
      keyboardShouldPersistTaps="handled" keyboardDismissMode={keyboardDismissMode} bottomOffset={bottomOffset} testID={testID}
      onScroll={onScroll} scrollEventThrottle={scrollEventThrottle}>
      {/* 流内占位:撑出排版高度;键盘垫子排在它后面 */}
      <View style={{ height }} pointerEvents="none" testID="abs-kb-spacer" />
      {/* 绝对定位的子元素:坐标系同原来的内容容器(左上角 = 内容顶) */}
      <View style={{ position: "absolute", left: 0, top: 0, right: 0, height }} pointerEvents="box-none">{children}</View>
    </SafeKeyboardAwareScrollView>
  );
}
