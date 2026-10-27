// 弹性输入框。
// 手感照 chat-thread 输入框:multiline + 隐形镜像 Text 量高(Fabric 上 onContentSizeChange 打字断流,
// 原生 auto-grow 长一步即卡,chat-thread 0719 重修的结论),height = min(文本高 + 上下 padding, maxHeight);
// 空文本不下发 height = 原生单行基线。受控 value(表单要回填/重拉),IME 组词中间态照常经 onChangeText。
// 镜像行数按 maxHeight 反推(opus 二审阻断:定死 12 行会在 maxHeight 大于 12 行时永远够不到顶,
// 框既不长也不能滚);滚动交给 RN multiline 默认,不手算 scrollEnabled。
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type TextStyle } from "react-native";

export const PAD_V = 8;
export const PAD_H = 10;
const CARET_SLACK = 2;

/** 高度公式(纯函数,测试钉它):空文本 → undefined(原生单行基线);否则 min(文本高+padding+光标余量, max),再抬到 min。 */
export function growHeight(value: string, textH: number, maxHeight: number, minHeight?: number): number | undefined {
  const grown = value !== "" && textH > 0 ? Math.min(textH + PAD_V * 2 + CARET_SLACK, maxHeight) : undefined;
  if (grown === undefined) return minHeight;
  return minHeight !== undefined ? Math.max(grown, minHeight) : grown;
}

/** 镜像要量到的行数 = 能填满 maxHeight 的行数 + 2(余量),保证量高结果能触顶 → 触顶后原生滚动接管 */
export function mirrorLines(maxHeight: number, fontSize: number, lineHeight?: number): number {
  const lh = lineHeight ?? fontSize * 1.5;
  return Math.ceil(maxHeight / lh) + 2;
}

export function GrowingInput({
  value,
  onChangeText,
  style,
  maxHeight = 160,
  minHeight,
  fontFamily,
  fontSize = 14,
  lineHeight,
  color,
  ...rest
}: Omit<TextInputProps, "style" | "multiline" | "value" | "onChangeText"> & {
  value: string;
  onChangeText: (t: string) => void;
  style?: StyleProp<TextStyle>;
  maxHeight?: number;
  minHeight?: number;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  color?: string;
}) {
  const [textH, setTextH] = useState(0);
  const [boxW, setBoxW] = useState(0);
  const onBoxLayout = useCallback((e: { nativeEvent: { layout: { width: number } } }) => {
    setBoxW(e.nativeEvent.layout.width);
  }, []);
  const onMirrorLayout = useCallback((e: { nativeEvent: { layout: { height: number } } }) => {
    setTextH(e.nativeEvent.layout.height);
  }, []);
  useEffect(() => {
    if (value === "") setTextH(0); // 清空后复位,再打字不先跳旧高度
  }, [value]);
  const Input = TextInput;
  const font: TextStyle = { fontFamily, fontSize, lineHeight, color };
  const h = growHeight(value, textH, maxHeight, minHeight);
  return (
    <View onLayout={onBoxLayout}>
      <Input
        {...rest}
        value={value}
        onChangeText={onChangeText}
        multiline
        textBreakStrategy="simple"
        style={[g.input, font, style, h !== undefined ? { height: h } : null, { maxHeight }]}
      />
      {value !== "" && boxW > 0 ? (
        // 量高镜像:移出可视区不占布局不截触摸;宽=输入框内容宽(去水平 padding,再收 1pt 兜 border 差,
        // 镜像略窄=早折行=只会量高不会量矮);末尾换行 Text 不计空行而 TextInput 计,补零宽占位。
        <View pointerEvents="none" style={{ position: "absolute", left: -9999, top: 0, width: Math.max(boxW - PAD_H * 2 - 4, 1) }}>
          <Text onLayout={onMirrorLayout} numberOfLines={mirrorLines(maxHeight, fontSize, lineHeight)} textBreakStrategy="simple" style={font}>
            {value.endsWith("\n") ? value + "​" : value}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const g = StyleSheet.create({
  input: { paddingHorizontal: PAD_H, paddingVertical: PAD_V, textAlignVertical: "top" },
});
