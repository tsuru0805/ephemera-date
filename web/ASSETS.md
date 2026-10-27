# 网页包里的字体与图片：来源与许可

## 字体（全部 SIL Open Font License 1.1，许可全文见 `licenses/OFL-1.1.txt`）

网页包里的字体文件都是从下列字体裁出来的子集（`scripts/subset_fonts.py`）：只留页面能显示的字（中文按 unicode-range 切片，页面上用到的那些字先加载，其余的字在出现时才下载），转成 WOFF2，并改了字体内部名字。按 OFL 第 3 条，改过的版本不能用保留字体名（Reserved Font Name），所以 Playfair Display 的子集改名为 `EphemeraDisplay-*`。

| 页面里的名字 | 来源字体 | 版权（取自字体文件） | 上游 |
|---|---|---|---|
| `NotoSerifSC-Regular-app` `NotoSerifSC-Medium-eph` `NotoSerifSC-Bold-app` `NotoSerifSC-Black-eph` | Noto Serif SC 400 / 500 / 700 / 900 | (c) 2017-2024 Adobe (http://www.adobe.com/)（Source Han Serif 的 Google 发行版；保留字体名 "Source"，本包的名字不含它） | https://github.com/google/fonts/tree/main/ofl/notoserifsc |
| `EphemeraDisplay-Regular` `EphemeraDisplay-Italic` `EphemeraDisplay-Bold` `EphemeraDisplay-BoldItalic` `EphemeraDisplay-Black` | Playfair Display 400 / 400 斜 / 700 / 700 斜 / 900 | Copyright 2017 The Playfair Display Project Authors (https://github.com/clauseggers/Playfair-Display)，保留字体名 "Playfair Display" | https://github.com/google/fonts/tree/main/ofl/playfairdisplay |
| `PinyonScript-Regular` | Pinyon Script 400 | Copyright 2022 The PinyonScript Project Authors (https://github.com/SorkinType/Pinyon) | https://github.com/google/fonts/tree/main/ofl/pinyonscript |
| `CormorantGaramond-Medium-eph` `CormorantGaramond-SemiBold-eph` | Cormorant Garamond 500 / 600 | Copyright 2015 The Cormorant Project Authors (github.com/CatharsisFonts/Cormorant) | https://github.com/google/fonts/tree/main/ofl/cormorantgaramond |
| `CourierPrime-Bold` `CourierPrime-Regular` | Courier Prime 700 / 400 | Copyright 2015 The Courier Prime Project Authors (https://github.com/quoteunquoteapps/CourierPrime) | https://github.com/google/fonts/tree/main/ofl/courierprime |

## 图片（`assets/images/ephemera/`）

| 文件 | 内容 | 来源 |
|---|---|---|
| `sc_*_ink.png` / `sc_*_inv.png`（26 组） | 每种站的固定小画（线条遮罩与反相两份） | 作者用 AI 生图工具生成后处理成遮罩 |
| `extra/<种类>_2|3_ink|inv.png`（16 组） | 每种站多备的两张固定画，引擎按站轮换 | 同上 |
| `florals_ink.png` / `florals_inv.png` | 角花 | 同上 |
| `paper_tex.jpg` | 纸纹 | 同上 |
| `crinkle.jpg` | 小卡袋的皱纹 | 同上 |
| `seal_bow.png` `seal_fill.png` `seal_line.png` | 火漆 | 同上 |

在线试玩里的地图是代码画出来的虚构小镇，不含任何地图数据。用引擎时，地图来自使用者自己建的 OpenStreetMap 底图（© OpenStreetMap contributors，ODbL），不随网页包分发。
